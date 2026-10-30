# Browser transport lab

A small browser client for the experimental Herdr WebTransport helper. It uses
**native browser WebTransport and xterm.js**, with all JavaScript/CSS bundled
locally. No browser extension, CDN, WebSocket relay, or terminal service account
is needed.

The local Node process is the parent/auth adapter: it uses your existing SSH
access to obtain a short-lived pinned attachment. In the default direct mode, the browser then talks directly
to the remote UDP endpoint. This demo launches a stock Herdr TUI inside a Linux
PTY, rather than decoding Herdr's native endpoint protocol in JavaScript.

## Try it

Install the fork's `herdr-roam` helper on the remote machine first (see the
repository's `TRANSPORT-EXPERIMENT.md`). Stock Herdr and the Linux `script` utility
must be on the SSH user's PATH. This does not replace or restart stable Herdr.

```sh
cd experiments/browser-demo
npm ci
npm run build
npm start -- --target telperion --port 0
```

Open the local launch link printed in your terminal using a current Chrome or
Edge with WebTransport support. Click **Connect**. The URL fragment is a local
launch capability; do not share it. The page removes the fragment from its
address bar after loading, so reopening/reloading requires the original link.

`--port 0` chooses a free loopback port. You can use a fixed port instead. The
parent listens on **127.0.0.1 only**; use the exact printed IP, not `localhost`,
because Host and Origin checks are deliberately exact.

If the laptop's direct QUIC path is filtered, explicitly select the relay:

```sh
# First build the fork's helper locally with cargo build -p herdr-roam.
npm start -- --target telperion --port 0 --relay
# Optional trusted parent configuration: --helper /absolute/path/to/herdr-roam
```

Relay mode uses **browser WebTransport → localhost helper → authenticated SSH →
remote Herdr**. It first verifies SSH access before minting a local capability,
and the local helper starts the SSH PTY only after token authentication and
COMMIT. This is labeled in the UI. It is a useful terminal/browser demo but does
not measure end-to-end remote QUIC latency or migration. The default never
silently changes into a relay. Only direct mode needs `herdr-roam` installed on
the remote machine; relay mode needs it locally.

Each parent process chooses a fresh `browser-demo-*` Herdr session. You may name
it explicitly with `--session browser-demo-my-test`. Its PTY is fixed at 120 × 36
cells for the first prototype. The terminal scrolls horizontally on small screens.

In direct mode, the remote helper must permit the attachment's exact page Origin. The parent
supplies this in its authenticated SSH command via
`HERDR_ROAM_ALLOWED_ORIGIN=http://127.0.0.1:<port>`. It does not enable a global
browser Origin or relax native certificate checks.

UDP 60000–61000 must be reachable directly from the browser. SSH-only jump hosts,
UDP filtering, and some QUIC-inspecting networks can prevent the direct browser
connection. Direct mode fails clearly; it cannot silently downgrade a
browser WebTransport connection to SSH. The explicit relay can still demonstrate
remote Herdr when the direct path is unavailable.

## What stays running

Disconnect closes the browser attachment and the parent's SSH helper. The
**dedicated named Herdr server persists**, like any stock Herdr session. It never
closes another user's server, the user's default session, or an existing pane.
Ctrl+C stops the local parent process and any pending bootstrap. If you started
work in the dedicated session, you can reattach over SSH:

```sh
ssh telperion 'herdr --session browser-demo-your-name'
```

To remove your own disposable demo session after all its work is finished, use
stock Herdr's session/server management commands explicitly for that name. Do not
stop the default server or another user's session as part of cleanup.

## Security boundary

- SSH authenticates the OS user and verifies the machine's SSH host key. HTTP
  requests cannot choose a different target, shell command, session, or socket.
- Bootstrap requires both the exact page Origin and a random local launch
  capability. Host checks prevent DNS rebinding. There are no wildcard CORS
  responses, externally hosted assets, or cached bootstrap responses.
- The parent returns a seven-day P-256 certificate and an attachment-specific
  random token obtained through SSH (direct mode) or minted locally after an SSH
  authorization check (explicit relay). The browser hashes the exact certificate for
  `serverCertificateHashes`, verifies the encrypted WebTransport connection, and
  sends the token before any terminal input.
- Authentication ACK is followed by irrevocable COMMIT. No fallback or input
  replay occurs after commitment. The server opens only the PTY command chosen by
  the SSH-authenticated parent.
- The parent never prints attachment tokens, certificates, or arbitrary SSH output.
  The launch fragment is printed locally because it is needed to open the app.
- Native terminal input is bounded to 64 KiB of queued browser writes. Terminal
  output respects xterm's parser backpressure rather than buffering indefinitely.
- This is a local research demo, not an internet-facing login application. Browser
  authorization via parent-provided public keys is a later auth adapter. Do not
  expose this parent HTTP server publicly or replace the nonce with an open API.

## Current limitations and architectural next step

The first contract carries a reliable byte stream. xterm renders ANSI output
from a real Herdr TUI, so it gives a useful browser demonstration immediately,
but it adds a second terminal model and does not expose Herdr's panes/workspaces
as native browser UI objects. Resize is fixed; clipboard integration, graphics,
file transfer, and link opening have not been qualified.

For a proper web client, keep Herdr's session/runtime model on the server and add
a browser adapter for its negotiated endpoint/control messages. Alternatively,
a server-rendered screen protocol can send replaceable, versioned screen state.
Do not drop arbitrary ANSI bytes or existing Herdr delta frames: later output may
depend on them. Reliable input/control and unreliable latest-screen presentation
should have separate stream/datagram contracts and input acknowledgments.

## Checks

```sh
npm test
npm run build
```

The Node tests prove that Host/Origin/nonce checks happen before any SSH process
starts, HTTP cannot inject targets or commands, concurrent bootstrap is bounded,
only dedicated sessions are used, malformed offers fail, and shutdown cancels a
pending bootstrap. A real browser/remote smoke test is separate from these tests.

### Recorded browser smoke test

On 2026-10-30, Chrome on the development laptop successfully connected in
**explicit relay mode**, rendered the actual dedicated Telperion Herdr session,
and ran a shell command returning `HERDR_BROWSER_OK`. The parent app and the
browser terminal remained live after the test. No existing Herdr session or
server was restarted.

Direct browser-to-Telperion WebTransport on that laptop path failed during the
opening handshake, matching the native client's current direct-path failure.
This does not establish the cause. The working relay is deliberately identified
as local WebTransport plus remote SSH; it is not evidence of end-to-end remote
WebTransport or mosh-style state synchronization. See the main transport guide
for independent transport and server-to-server results.
