# Herdr browser terminal

A fullscreen xterm.js terminal connected to a dedicated remote Herdr session.
Connection controls live in the bottom-right corner. There is no page chrome
around the terminal.

## Run

Build the fork's `herdr-roam` helper locally, then:

```sh
cd experiments/browser-demo
npm ci
npm run build
npm start -- --target telperion --session browser-demo-main --port 8765 --relay
```

Open the printed launch link in current Chrome or Edge and press **Connect**.
The gateway uses the configured SSH alias and existing SSH authentication; there
is no separate terminal password. SSH must work noninteractively. The launch
capability stays in this tab's session storage so reloading works; it is removed
from the address bar. Do not share the launch link.

`--relay` explicitly selects browser WebTransport → loopback helper → SSH →
remote Herdr. For direct browser-to-server WebTransport, omit `--relay` and install
`herdr-roam` on the remote server. Direct mode requires reachable UDP 60000–61000.
The direct laptop-to-Telperion path currently fails during setup; its cause is
unresolved. Relay mode works on that path. Neither mode silently changes into
the other.

The remote machine needs Python 3 and stock Herdr. The Python PTY adapter is
supplied through authenticated SSH, with no daemon or file installation. Assets
are bundled locally, without a CDN. `--port 0` chooses a free loopback port;
`--helper /path/to/herdr-roam` overrides the local helper in relay mode.

## Terminal controls

- The grid fits the tab and resizes the remote PTY live.
- Click the small server/latency control, or press **Alt+Shift+I**, for connection
  details. Closing the dialog returns keyboard focus to the terminal.
- **Reconnect** opens a fresh attachment and requests a fresh display. It keeps
  the same named Herdr session and never restarts its server or replays input.
- **Disconnect** closes the attachment; the named session and its work persist.
- A banner appears after six seconds without a remote update. The remote PTY
  adapter sends a heartbeat every two seconds, so a silent shell is not mistaken
  for a stale connection.

The details dialog shows session round-trip time, time since the last remote
update, attachment duration, terminal byte counts and grid size. Its server-info
section shows hostname, SSH user, uptime, load, kernel and Herdr version.

Session RTT is an echoed message through the complete terminal path, including
SSH in relay mode. A heartbeat proves the remote adapter is reachable; it does
not prove that every pane or program inside Herdr is healthy. Server information
comes from a fixed read-only SSH probe: it runs when details open, every ten
seconds while open, or on **Refresh info**. Samples are coalesced and cached for
five seconds. **SSH info check** includes connection/authentication and command
execution; it is not network ping.

The dedicated `browser-demo-*` server stays running after gateway shutdown.
Reattach with:

```sh
ssh telperion 'herdr --session browser-demo-main'
```

## Pointing at servers and hosting

Today one gateway instance points at one explicitly configured SSH target and
one persistent session. Use a stable port and session name for a daily terminal,
or separate gateway instances for different servers. HTTP requests cannot select
a host, command, user, socket or filesystem path. Only validated terminal geometry
is accepted at bootstrap.

The maintainable hosted shape is a static terminal bundle plus a small same-origin
auth/bootstrap adapter behind the existing employee login. Keep these boundaries:

1. A trusted configuration maps server profile IDs to permitted hosts and sessions.
   The UI can eventually choose a profile ID; it must not submit an arbitrary SSH
   target or shell command.
2. The parent application authenticates the employee and authorizes a profile.
   Its adapter returns a short-lived scoped attachment, certificate pin and
   application-protocol name. SSH works as the first adapter; parent-managed key
   proofs can replace it later without adding an account database to Herdr.
3. The static terminal connects directly to the selected WebTransport endpoint.
   An explicitly labeled relay can be a separate deployment option where direct
   UDP is unavailable.

The current Node gateway deliberately binds only to **127.0.0.1** and checks that
exact Host/Origin. It is not yet an internet-facing service: serving it behind a
proxy requires configuring the public HTTPS origin and replacing the local launch
capability with the parent's authenticated bootstrap/session. No public listener,
login service or hiloop deployment is added by this prototype. A public browser
client also needs a configured certificate-pinning/PKI strategy and per-user
server authorization; do not expose the local SSH adapter unchanged.

## Protocol and security

The transport remains `webtransport-stream-v1`. Inside its opaque byte stream,
`herdr-browser-pty-v1` adds bounded DATA, RESIZE, PING/PONG and HEARTBEAT frames.
This changes only the browser PTY adapter, not stock Herdr's endpoint codecs.
It does not yet provide replaceable latest-screen state or predictive echo; see
[the display protocol design](../../DISPLAY-TRANSPORT-DESIGN.md).

SSH authorizes each attachment. The browser pins its fresh P-256 certificate,
authenticates with a random attachment token, then sends irrevocable COMMIT
before terminal input. Host, exact Origin and a local launch capability protect
the loopback bootstrap and stats endpoints. Remote commands/targets come only
from trusted gateway configuration. Queues, frame sizes, geometry, probe output
and authentication waits are bounded. Shutdown cleans up the gateway's own
attachment/probes, while leaving persistent Herdr sessions running.

## Checks

```sh
npm test
python3 -m unittest discover -s test -p 'test_*.py'
npm run build
```

Tests cover authentication boundaries, geometry validation, stats authorization
and caching, fragmented/malformed frames, actual PTY resizing, heartbeat/PONG and
attachment cleanup. The six Python tests passed on macOS and Telperion/Linux.
Chrome QA verified terminal input, live resize, server details and reconnecting
to the same session, including after a page reload. Briefly pausing only the
dedicated demo adapter produced the stale-update banner; resuming it cleared the
banner automatically. Existing Herdr servers remained running. Clipboard,
graphics, links and mobile keyboard behavior have not been fully qualified.
