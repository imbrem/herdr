use anyhow::{bail, Context, Result};
use herdr_roam::{
    authenticate, bootstrap_command, client_config, read_offer, server, NEGOTIATION_TIMEOUT,
};
use std::{
    env,
    io::{Read, Write},
    net::{IpAddr, SocketAddr},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};
use wtransport::Endpoint;
mod platform;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("serve") => serve(&args[1..]).await,
        Some("connect") if args.get(1).is_some_and(|s| s == "--") => connect(&args[2..]).await,
        _ => {
            eprintln!("Usage: herdr-roam connect -- <ssh arguments>\n       herdr-roam serve [--protocols LIST] -- <remote command>");
            std::process::exit(2);
        }
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("herdr-roam: {error:#}");
            std::process::exit(1);
        }
    }
}

fn parse_serve(args: &[String]) -> Result<(Vec<String>, &str)> {
    let (protocols, rest) = if args.first().is_some_and(|a| a == "--protocols") {
        (
            herdr_roam::parse_offered_protocols(args.get(1).context("missing protocol list")?)?,
            &args[2..],
        )
    } else {
        (herdr_roam::parse_protocols("auto")?, args)
    };
    if rest.len() != 2 || rest[0] != "--" {
        bail!("serve expects -- followed by exactly one shell command");
    }
    Ok((protocols, &rest[1]))
}

async fn serve(args: &[String]) -> Result<i32> {
    let (protocols, command) = parse_serve(args)?;
    let selected = herdr_roam::select_protocol(&protocols)?;
    if selected == "ssh" {
        println!(
            "{}",
            serde_json::to_string(&herdr_roam::Negotiation::ssh())?
        );
        return Ok(0);
    }
    platform::survive_bootstrap_disconnect();
    let server_ip: IpAddr = if let Ok(ip) = env::var("HERDR_ROAM_LISTEN") {
        ip.parse()?
    } else {
        env::var("SSH_CONNECTION")
            .context("SSH_CONNECTION or HERDR_ROAM_LISTEN is required")?
            .split_whitespace()
            .nth(2)
            .context("invalid SSH_CONNECTION")?
            .parse()?
    };
    if server_ip.is_unspecified() || server_ip.is_multicast() {
        bail!("listen address must be a concrete unicast IP");
    }
    let (endpoint, offer, token) = (60000..=61000)
        .find_map(|port| server(SocketAddr::new(server_ip, port), server_ip).ok())
        .context("no available UDP port in 60000..61000")?;
    println!(
        "{}",
        serde_json::to_string(&herdr_roam::Negotiation::webtransport(offer))?
    );
    std::io::stdout().flush()?;
    // A finite global bootstrap lifetime bounds unauthenticated public exposure.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (connection, mut send, mut recv) = loop {
        let incoming = tokio::time::timeout_at(deadline, endpoint.accept()).await?;
        let request = match tokio::time::timeout(Duration::from_secs(2), incoming).await {
            Ok(Ok(request)) => request,
            _ => continue,
        };
        if request.path() != "/herdr-roam/v1" || request.origin().is_some() {
            request.forbidden().await;
            continue;
        }
        let connection = request.accept().await?;
        let streams = tokio::time::timeout(Duration::from_secs(2), connection.accept_bi()).await;
        let (send, mut recv) = match streams {
            Ok(Ok(pair)) => pair,
            _ => {
                connection.close(1u32.into(), b"stream timeout");
                continue;
            }
        };
        if authenticate(&mut recv, &token).await.is_err() {
            connection.close(1u32.into(), b"authentication rejected");
            continue;
        }
        break (connection, send, recv);
    };
    // No further accepts are performed; only this authenticated session is used.
    send.write_all(b"\x01").await?;
    // Authentication ACK is not a commitment: a lost ACK must never run the command.
    if tokio::time::timeout(Duration::from_secs(5), recv.read_u8()).await?? != 1 {
        bail!("invalid transport commitment");
    }
    // Spawn only after the client's irrevocable COMMIT. The command is opaque SSH input.
    let shell = env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let mut child = Command::new(shell)
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child.stdin.take().context("missing child stdin")?;
    let mut output = child.stdout.take().context("missing child stdout")?;
    let to_child = async {
        tokio::io::copy(&mut recv, &mut input).await?;
        input.shutdown().await?;
        drop(input); // ChildStdin::shutdown is a no-op on Unix; close the pipe to deliver EOF.
        Ok::<_, anyhow::Error>(())
    };
    let from_child = async {
        tokio::io::copy(&mut output, &mut send).await?;
        send.finish().await?;
        Ok::<_, anyhow::Error>(())
    };
    tokio::pin!(to_child, from_child);
    let result = tokio::select! {
        result = &mut from_child => result,
        result = &mut to_child => match result { Ok(()) => from_child.await, Err(error) => Err(error) },
        _ = connection.closed() => Ok(()),
    };
    result?;
    // Output has drained before closing the connection, including short-lived commands.
    let code = match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(status) => status?.code().unwrap_or(1),
        Err(_) => 0,
    };
    let _ = child.kill().await;
    endpoint.close(0u32.into(), b"bridge finished");
    Ok(code)
}

async fn stop_ssh(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn fallback(args: &[String]) -> Result<i32> {
    eprintln!("herdr-roam: selected ssh");
    Ok(Command::new("ssh")
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await?
        .code()
        .unwrap_or(1))
}

async fn connect(args: &[String]) -> Result<i32> {
    let remote = args
        .last()
        .context("connect requires SSH arguments ending in a remote command")?;
    let protocols = herdr_roam::parse_protocols(
        &env::var("HERDR_TRANSPORT").unwrap_or_else(|_| "auto".into()),
    )?;
    if herdr_roam::select_protocol(&protocols)? == "ssh" {
        return fallback(args).await;
    }
    let mut bootstrap_args = args[..args.len() - 1].to_vec();
    bootstrap_args.push(bootstrap_command(remote, &protocols));
    let mut ssh = Command::new("ssh")
        .args(bootstrap_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let mut output = BufReader::new(ssh.stdout.take().context("missing SSH output")?);
    // No stdin reader exists until all negotiation, TLS, token and ACK steps succeed.
    let mut stage = "SSH bootstrap";
    let negotiation = tokio::time::timeout(NEGOTIATION_TIMEOUT, async {
        let greeting = read_offer(&mut output).await.context("SSH bootstrap")?;
        stage = "protocol selection";
        greeting.verify(&protocols).context("protocol selection")?;
        let offer = greeting.offer.context("server selected SSH")?;
        stage = "certificate and endpoint configuration";
        let (cert, token) = offer
            .validate()
            .context("transport credential validation")?;
        let endpoint =
            Endpoint::client(client_config(cert).context("certificate pin configuration")?)
                .context("local UDP endpoint")?;
        let url = format!(
            "https://{}/herdr-roam/v1",
            SocketAddr::new(offer.address, offer.port)
        );
        stage = "WebTransport TLS and HTTP/3 session handshake";
        let connection = endpoint
            .connect(url.as_str())
            .await
            .context("WebTransport TLS/session handshake")?;
        stage = "WebTransport application stream";
        let (mut send, mut recv) = connection
            .open_bi()
            .await
            .context("opening application stream")?
            .await
            .context("application stream initialization")?;
        stage = "capability authentication acknowledgment";
        send.write_all(&token)
            .await
            .context("sending transport capability")?;
        if recv
            .read_u8()
            .await
            .context("transport authentication acknowledgment")?
            != 1
        {
            bail!("server rejected authentication");
        }
        Ok::<_, anyhow::Error>((endpoint, connection, send, recv))
    })
    .await;
    let (endpoint, connection, mut send, mut recv) = match negotiation {
        Ok(Ok(ready)) => ready,
        failure => {
            let reason = match failure {
                Ok(Err(error)) => format!("{error:#}"),
                Err(_) => format!("timed out during {stage}"),
                Ok(Ok(_)) => unreachable!(),
            };
            stop_ssh(&mut ssh).await;
            // Do not include the bootstrap JSON, certificate or capability in diagnostics.
            if protocols.iter().any(|p| p == "ssh") {
                eprintln!("herdr-roam: {reason}; falling back before commitment");
                return fallback(args).await;
            }
            bail!("{reason}; SSH fallback is disabled by protocol selection");
        }
    };
    eprintln!("herdr-roam: selected webtransport-stream-v1");
    // This is the commitment point: never fall back after sending COMMIT.
    send.write_all(b"\x01").await?;
    // Stdin is consumed only after authentication and irrevocable transport selection.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(4);
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buffer = [0; 16 * 1024];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.blocking_send(buffer[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let to_server = async {
        while let Some(bytes) = rx.recv().await {
            send.write_all(&bytes).await?;
        }
        send.finish().await?;
        Ok::<_, anyhow::Error>(())
    };
    let from_server = async {
        let mut stdout = tokio::io::stdout();
        tokio::io::copy(&mut recv, &mut stdout).await?;
        stdout.flush().await?;
        Ok::<_, anyhow::Error>(())
    };
    tokio::pin!(to_server, from_server);
    let result = tokio::select! {
        result = &mut from_server => result,
        result = &mut to_server => match result { Ok(()) => from_server.await, Err(error) => Err(error) },
    };
    connection.close(0u32.into(), b"client finished");
    endpoint.close(0u32.into(), b"client finished");
    stop_ssh(&mut ssh).await;
    result?;
    Ok(0)
}
