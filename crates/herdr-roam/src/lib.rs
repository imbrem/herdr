//! Experimental encrypted byte stream, not terminal prediction or state synchronization.
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use quinn::{TransportConfig, VarInt};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use wtransport::endpoint::endpoint_side;
use wtransport::tls::Certificate;
use wtransport::{ClientConfig, Endpoint, Identity, ServerConfig};

// WebTransport negotiates standard HTTP/3 ALPN; the application protocol is named separately.
pub const UNSUPPORTED: &str = "HERDR_ROAM_UNSUPPORTED_V1";
pub const BOOTSTRAP_LIMIT: usize = 16 * 1024;
pub const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(5);
pub const TOKEN_LEN: usize = 32;
pub const PROTOCOLS: &[&str] = &["webtransport-stream-v1", "ssh"];

pub fn parse_offered_protocols(value: &str) -> Result<Vec<String>> {
    let protocols: Vec<_> = value.split(',').map(|v| v.trim().to_owned()).collect();
    if protocols.len() > 16
        || protocols.iter().any(|v| {
            v.is_empty()
                || v.len() > 64
                || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        bail!("invalid transport protocol list");
    }
    Ok(protocols)
}

pub fn parse_protocols(value: &str) -> Result<Vec<String>> {
    let value = match value.trim() {
        "auto" | "webtransport" => "webtransport-stream-v1,ssh",
        value => value,
    };
    let protocols = parse_offered_protocols(value)?;
    if protocols.iter().any(|v| !PROTOCOLS.contains(&v.as_str())) {
        bail!("unknown or empty transport protocol");
    }
    Ok(protocols)
}

pub fn select_protocol(protocols: &[String]) -> Result<&str> {
    protocols
        .iter()
        .map(String::as_str)
        .find(|v| PROTOCOLS.contains(v))
        .context("no mutually supported transport protocol")
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Negotiation {
    pub supported_protocols: Vec<String>,
    pub selected_protocol: String,
    pub offer: Option<Offer>,
}

impl Negotiation {
    pub fn ssh() -> Self {
        Self {
            supported_protocols: PROTOCOLS.iter().map(|v| (*v).into()).collect(),
            selected_protocol: "ssh".into(),
            offer: None,
        }
    }
    pub fn webtransport(offer: Offer) -> Self {
        Self {
            selected_protocol: "webtransport-stream-v1".into(),
            offer: Some(offer),
            ..Self::ssh()
        }
    }
    pub fn verify(&self, offered: &[String]) -> Result<()> {
        let expected = offered
            .iter()
            .find(|p| self.supported_protocols.contains(p))
            .context("no mutually supported protocol")?;
        if expected != &self.selected_protocol
            || !PROTOCOLS.contains(&self.selected_protocol.as_str())
            || (self.selected_protocol == "webtransport-stream-v1") != self.offer.is_some()
        {
            bail!("invalid transport protocol selection");
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Offer {
    pub version: u32,
    pub address: IpAddr,
    pub port: u16,
    pub cert: String,
    pub token: String,
}

impl Offer {
    pub fn validate(&self) -> Result<(Certificate, [u8; TOKEN_LEN])> {
        if self.version != 1
            || self.port == 0
            || self.address.is_unspecified()
            || self.address.is_multicast()
        {
            bail!("unsupported or invalid transport offer");
        }
        let cert = Certificate::from_der(
            STANDARD
                .decode(&self.cert)
                .context("invalid certificate encoding")?,
        )?;
        let token: [u8; TOKEN_LEN] = STANDARD
            .decode(&self.token)
            .context("invalid capability encoding")?
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid capability length"))?;
        Ok((cert, token))
    }
}

fn transport() -> TransportConfig {
    let mut config = TransportConfig::default();
    config.max_idle_timeout(Some(Duration::from_secs(120).try_into().unwrap()));
    config.keep_alive_interval(Some(Duration::from_secs(5)));
    config.max_concurrent_bidi_streams(4u32.into());
    config.max_concurrent_uni_streams(4u32.into());
    config.stream_receive_window(VarInt::from_u32(1024 * 1024));
    config.receive_window(VarInt::from_u32(4 * 1024 * 1024));
    config.send_window(1024 * 1024);
    config.datagram_receive_buffer_size(Some(64 * 1024));
    config
}

pub fn server(
    bind: SocketAddr,
    advertised: IpAddr,
) -> Result<(Endpoint<endpoint_side::Server>, Offer, [u8; TOKEN_LEN])> {
    let identity = Identity::self_signed_builder()
        .subject_alt_names(["herdr-roam", &advertised.to_string()])
        .from_now_utc()
        .validity_days(7)
        .build()?;
    let cert = identity.certificate_chain().as_slice()[0].der().to_vec();
    // wtransport's TLS13 builder keeps rustls max_early_data_size=0. The
    // client awaits a full handshake (never into_0rtt), so mutations cannot
    // enter replayable TLS early data.
    let mut config = ServerConfig::builder()
        .with_bind_address(bind)
        .with_identity(identity)
        .max_idle_timeout(Some(Duration::from_secs(120)))?
        .keep_alive_interval(Some(Duration::from_secs(5)))
        .allow_migration(true)
        .build();
    config
        .quic_config_mut()
        .max_incoming(8)
        .incoming_buffer_size(64 * 1024)
        .incoming_buffer_size_total(512 * 1024)
        .transport_config(std::sync::Arc::new(transport()));
    let endpoint = Endpoint::server(config)?;
    let mut token = [0; TOKEN_LEN];
    SystemRandom::new()
        .fill(&mut token)
        .map_err(|_| anyhow::anyhow!("OS random source failed"))?;
    let offer = Offer {
        version: 1,
        address: advertised,
        port: endpoint.local_addr()?.port(),
        cert: STANDARD.encode(cert),
        token: STANDARD.encode(token),
    };
    Ok((endpoint, offer, token))
}

pub fn client_config(cert: Certificate) -> Result<ClientConfig> {
    // rustls enable_early_data defaults to false; wtransport::connect awaits
    // the complete handshake. Do not introduce into_0rtt for this protocol.
    let mut config = ClientConfig::builder()
        .with_bind_default()
        .with_server_certificate_hashes([cert.hash()])
        .max_idle_timeout(Some(Duration::from_secs(120)))?
        .keep_alive_interval(Some(Duration::from_secs(5)))
        .build();
    config
        .quic_config_mut()
        .transport_config(std::sync::Arc::new(transport()));
    Ok(config)
}

pub async fn authenticate(
    recv: &mut wtransport::RecvStream,
    expected: &[u8; TOKEN_LEN],
) -> Result<()> {
    let mut actual = [0; TOKEN_LEN];
    tokio::time::timeout(Duration::from_secs(2), recv.read_exact(&mut actual)).await??;
    #[allow(deprecated)]
    ring::constant_time::verify_slices_are_equal(&actual, expected)
        .map_err(|_| anyhow::anyhow!("transport authentication rejected"))
}

pub async fn read_offer(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Negotiation> {
    let mut line = Vec::new();
    loop {
        let bytes = reader.fill_buf().await?;
        if bytes.is_empty() {
            bail!("SSH bootstrap ended without transport offer");
        }
        let n = bytes
            .iter()
            .position(|&b| b == b'\n')
            .map_or(bytes.len(), |i| i + 1);
        if line.len() + n > BOOTSTRAP_LIMIT {
            bail!("SSH bootstrap offer exceeds limit");
        }
        line.extend_from_slice(&bytes[..n]);
        reader.consume(n);
        if line.last() == Some(&b'\n') {
            break;
        }
    }
    if line.strip_suffix(b"\n").unwrap_or(&line) == UNSUPPORTED.as_bytes() {
        bail!("remote transport unavailable");
    }
    let greeting: Negotiation =
        serde_json::from_slice(&line).context("invalid SSH transport offer")?;
    if let Some(offer) = &greeting.offer {
        offer.validate()?;
    }
    Ok(greeting)
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn bootstrap_command(remote: &str, protocols: &[String]) -> String {
    format!("if command -v herdr-roam >/dev/null 2>&1; then exec herdr-roam serve --protocols {} -- {}; else printf '%s\\n' {}; fi",
        shell_quote(&protocols.join(",")), shell_quote(remote), shell_quote(UNSUPPORTED))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, BufReader};

    #[test]
    fn named_protocol_selection_is_ordered_and_verified() -> Result<()> {
        assert_eq!(parse_protocols("auto")?, ["webtransport-stream-v1", "ssh"]);
        assert_eq!(
            select_protocol(&parse_protocols("ssh,webtransport-stream-v1")?)?,
            "ssh"
        );
        assert!(parse_protocols("quic").is_err());
        assert_eq!(
            select_protocol(&parse_offered_protocols(
                "future-v2,webtransport-stream-v1,ssh"
            )?)?,
            "webtransport-stream-v1"
        );
        assert!(parse_protocols("ssh,").is_err());
        assert!(Negotiation::ssh()
            .verify(&parse_protocols("webtransport-stream-v1")?)
            .is_err());
        Ok(())
    }

    #[tokio::test]
    async fn negotiation_rejects_unsupported_oversized_and_timeout() {
        let unsupported = format!("{UNSUPPORTED}\n");
        assert!(read_offer(&mut BufReader::new(unsupported.as_bytes()))
            .await
            .is_err());
        let oversized = vec![b'x'; BOOTSTRAP_LIMIT + 1];
        assert!(read_offer(&mut BufReader::new(oversized.as_slice()))
            .await
            .is_err());
        let (_send, receive) = tokio::io::duplex(16);
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            read_offer(&mut BufReader::new(receive))
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn loopback_roundtrip_and_rejected_token() -> Result<()> {
        let ip: IpAddr = "127.0.0.1".parse()?;
        let (server, offer, token) = server(SocketAddr::new(ip, 0), ip)?;
        let (cert, _) = offer.validate()?;
        let client = Endpoint::client(client_config(cert)?)?;
        let url = format!("https://127.0.0.1:{}/herdr-roam/v1", offer.port);
        let server_task = tokio::spawn(async move {
            for reject in [true, false] {
                let request = server.accept().await.await.unwrap();
                let connection = request.accept().await.unwrap();
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                let auth = authenticate(&mut recv, &token).await;
                if reject {
                    assert!(auth.is_err());
                    connection.close(1u32.into(), b"auth rejected");
                    continue;
                }
                auth.unwrap();
                send.write_all(b"\x01").await.unwrap();
                let mut input = [0; 4];
                recv.read_exact(&mut input).await.unwrap();
                assert_eq!(&input, b"ping");
                send.write_all(b"pong").await.unwrap();
                send.finish().await.unwrap();
            }
        });
        let connection = client.connect(url.as_str()).await?;
        let (mut send, _recv) = connection.open_bi().await?.await?;
        send.write_all(&[0; TOKEN_LEN]).await?;
        assert!(
            tokio::time::timeout(Duration::from_secs(2), connection.closed())
                .await
                .is_ok()
        );
        let connection = client.connect(url.as_str()).await?;
        let (mut send, mut recv) = connection.open_bi().await?.await?;
        send.write_all(&token).await?;
        assert_eq!(recv.read_u8().await?, 1);
        send.write_all(b"ping").await?;
        let mut output = Vec::new();
        recv.read_to_end(&mut output).await?;
        assert_eq!(output, b"pong");
        server_task.await?;
        Ok(())
    }

    #[tokio::test]
    async fn wrong_certificate_is_rejected() -> Result<()> {
        let ip: IpAddr = "127.0.0.1".parse()?;
        let (server, offer, _) = server(SocketAddr::new(ip, 0), ip)?;
        let (_, wrong_offer, _) = super::server(SocketAddr::new(ip, 0), ip)?;
        let (wrong_cert, _) = wrong_offer.validate()?;
        let client = Endpoint::client(client_config(wrong_cert)?)?;
        let task = tokio::spawn(async move {
            let _ = server.accept().await.await;
        });
        let url = format!("https://127.0.0.1:{}/herdr-roam/v1", offer.port);
        assert!(client.connect(url.as_str()).await.is_err());
        task.abort();
        Ok(())
    }
}
