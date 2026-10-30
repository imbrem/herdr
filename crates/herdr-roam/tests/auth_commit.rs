#![cfg(unix)]

use anyhow::{Context, Result};
use herdr_roam::{client_config, read_offer, shell_quote};
use std::{
    path::PathBuf,
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, BufReader},
    process::Command,
    time::timeout,
};
use wtransport::Endpoint;

struct TestDirectory(PathBuf);

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn authenticated_disconnect_before_commit_never_executes_command() -> Result<()> {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let directory = TestDirectory(std::env::temp_dir().join(format!(
        "herdr-roam-auth-commit-{}-{unique}",
        std::process::id()
    )));
    std::fs::create_dir(&directory.0)?;
    let marker = directory.0.join("command-ran");
    let command = format!("printf ran > {}", shell_quote(&marker.to_string_lossy()));
    let mut server = Command::new(env!("CARGO_BIN_EXE_herdr-roam"))
        .args([
            "serve",
            "--protocols",
            "webtransport-stream-v1",
            "--",
            &command,
        ])
        .env("HERDR_ROAM_LISTEN", "127.0.0.1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut greeting = BufReader::new(server.stdout.take().context("server stdout missing")?);
    let negotiation = timeout(Duration::from_secs(3), read_offer(&mut greeting)).await??;
    let offer = negotiation
        .offer
        .context("server did not offer WebTransport")?;
    let (cert, token) = offer.validate()?;
    let endpoint = Endpoint::client(client_config(cert)?)?;
    let connection = timeout(
        Duration::from_secs(3),
        endpoint.connect(format!("https://127.0.0.1:{}/herdr-roam/v1", offer.port)),
    )
    .await??;
    let (mut send, mut recv) = timeout(Duration::from_secs(3), async {
        let streams = connection.open_bi().await?.await?;
        Ok::<_, anyhow::Error>(streams)
    })
    .await??;
    send.write_all(&token).await?;
    assert_eq!(timeout(Duration::from_secs(3), recv.read_u8()).await??, 1);
    assert!(
        !marker.exists(),
        "authentication ACK must not start the command"
    );

    // Drop the authenticated session without sending the final COMMIT byte. This
    // models an ACK lost to the client immediately before a permitted fallback.
    connection.close(0u32.into(), b"disconnect without commitment");
    endpoint.close(0u32.into(), b"test finished");
    let status = timeout(Duration::from_secs(5), server.wait()).await??;
    assert!(!status.success(), "uncommitted attachment must be rejected");
    assert!(!marker.exists(), "uncommitted command was executed");
    Ok(())
}

#[tokio::test]
async fn unauthenticated_idle_session_does_not_block_an_authenticated_client() -> Result<()> {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let directory = TestDirectory(std::env::temp_dir().join(format!(
        "herdr-roam-concurrent-auth-{}-{unique}",
        std::process::id()
    )));
    std::fs::create_dir(&directory.0)?;
    let marker = directory.0.join("command-ran");
    let command = format!("printf ran > {}", shell_quote(&marker.to_string_lossy()));
    let mut server = Command::new(env!("CARGO_BIN_EXE_herdr-roam"))
        .args([
            "serve",
            "--protocols",
            "webtransport-stream-v1",
            "--",
            &command,
        ])
        .env("HERDR_ROAM_LISTEN", "127.0.0.1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut greeting = BufReader::new(server.stdout.take().context("server stdout missing")?);
    let negotiation = timeout(Duration::from_secs(3), read_offer(&mut greeting)).await??;
    let offer = negotiation
        .offer
        .context("server did not offer WebTransport")?;
    let (cert, token) = offer.validate()?;
    let endpoint = Endpoint::client(client_config(cert)?)?;
    let url = format!("https://127.0.0.1:{}/herdr-roam/v1", offer.port);

    // CONNECT has completed, but this peer never opens the capability stream.
    // It holds the old serial implementation's two-second stream timeout.
    let idle = timeout(Duration::from_secs(3), endpoint.connect(url.as_str())).await??;
    let connection = timeout(Duration::from_secs(1), async {
        let connection = endpoint.connect(url.as_str()).await?;
        let (mut send, mut recv) = connection.open_bi().await?.await?;
        send.write_all(&token).await?;
        assert_eq!(recv.read_u8().await?, 1);
        assert!(!marker.exists(), "authentication ACK started the command");
        send.write_all(b"\x01").await?;
        let mut output = Vec::new();
        recv.read_to_end(&mut output).await?;
        Ok::<_, anyhow::Error>(connection)
    })
    .await
    .context("idle unauthenticated peer blocked legitimate attachment")??;
    assert!(marker.exists(), "committed command did not execute");
    let status = timeout(Duration::from_secs(3), server.wait()).await??;
    assert!(status.success());
    idle.close(0u32.into(), b"test finished");
    connection.close(0u32.into(), b"test finished");
    endpoint.close(0u32.into(), b"test finished");
    Ok(())
}
