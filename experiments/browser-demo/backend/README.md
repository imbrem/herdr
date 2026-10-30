# Local browser gateway

The Node process is a separate browser authentication/bootstrap gateway. It is
not part of the core Herdr server or a new account/authentication service. It
uses the invoking user's existing SSH authorization and owns one disposable
attachment to one dedicated `browser-demo-*` session. Closing it preserves the
session's detached Herdr runtime.

## Module boundaries

- `../server.mjs`: loopback HTTP routing, local asset serving, startup/shutdown.
- `config.mjs`: immutable startup configuration and terminal geometry bounds.
- `http.mjs`: exact request authentication, response headers, bounded body parsing.
- `attachments.mjs`: one attachment, cancellation generations, late-offer cleanup.
- `stats.mjs`: on-demand SSH probe coalescing and five-second result cache.
- `../bootstrap.mjs`: fixed SSH commands, helper-offer validation, owned processes.
- `../pty_bridge.py`: framed PTY application protocol; the transport treats it as bytes.

The gateway deliberately binds only `127.0.0.1`. Exact Host, Origin, and a random
launch capability authorize every control request before any body is read or SSH
process is started. The capability arrives in the launch URL's fragment and is
sent in `X-Herdr-Demo-Token`; it must not be logged or shared. There is no wildcard
CORS. HTTP cannot select a target, session, executable, command, or environment.
Startup configuration is validated and copied so later mutation by a caller
cannot change the fixed SSH target.

`/config.json` is a static build artifact, served as literal JSON bytes. Its
`gateway` value selects the browser's bootstrap adapter; null selects this same
origin. It does not change this Node process's authorization, binding, target,
or CORS policy. A separately hosted frontend still needs an authorized gateway
designed for that deployment.
The trusted `startDemo` dependency options may replace the asset-root directory
for tests; HTTP can still request only the explicit public asset allowlist.

## Transport topology

In direct mode, the gateway uses SSH only to authorize and bootstrap the remote
helper. The browser then connects directly to that helper over WebTransport,
pins the certificate obtained through SSH, and proves possession of the
single-use attachment capability before committing the attachment. The gateway
does not carry the terminal's WebTransport data in this mode.

Explicit `--relay` mode has a different data path: browser WebTransport → local
helper → authenticated SSH → remote PTY/Herdr. It first verifies SSH access before
starting the local helper. This is useful when the direct UDP path is unavailable;
it is not evidence that end-to-end remote WebTransport works and is never an
automatic protocol downgrade.

Authentication remains outside the terminal application protocol. A future
separate gateway/proxy can integrate Caddy, OAuth, or application-provided keys
and issue narrow attachment offers. Public binding, reverse-proxy trust, key
issuance/revocation, and cross-origin policy require a separate design. This demo
does not implement them or trust forwarded authentication headers.

## HTTP contract

All responses are `no-store`. Control endpoints require POST, exact Origin and
the launch capability. Host is checked on every route, including static assets.

| Route | Request | Response |
| --- | --- | --- |
| `GET /configuration` | No body | Fixed target/session/relay, default geometry, application protocol |
| `POST /bootstrap` | Empty, or JSON containing only integer `cols` and `rows` | Transport protocol, validated helper offer, selected geometry, application protocol |
| `POST /disconnect` | No body | `{ "ok": true }`; cancels this gateway's attachment |
| `POST /stats` | No body | Parent facts, attachment state, cached/on-demand server sample |

Bootstrap accepts 20–500 columns and 5–300 rows, at most 256 body bytes, and a
five-second body-read deadline. Disconnect invalidates requests still reading
their body as well as pending offers. Cancellation returns HTTP 409 immediately;
an offer that arrives afterward is closed, and its completion cannot overwrite a
newer attachment's state. Shutdown cancels this parent's operations and bounds
HTTP connection draining. Child cleanup signals only processes/groups created by
this gateway and escalates to KILL after a short grace period when necessary.

## Statistics semantics

`attachment.state` is `idle`, `starting`, or `offered`. **Offered does not mean
browser-connected**: the browser owns WebTransport authorization/commit and its
own connection state. `offeredAt` is the gateway's offer-acceptance wall time.

`parentStartedAt` and `parentUptimeSeconds` describe this Node process, not the
remote server. `server.uptimeSeconds` comes from the remote host's `/proc/uptime`
when available. `sampledAt` is the parent wall-clock time when the SSH probe
completed (or failed), retained with the five-second cache. It is not a heartbeat
timestamp. `sshProbeMs` includes SSH connection/authentication and command work;
it is not a network RTT. Browser application PING/PONG measures attachment RTT,
and framed server heartbeats/DATA/PONG identify actual server updates. In relay
mode those browser measurements include the relay/SSH path.

Statistics are sampled only on request. Concurrent requests share a probe;
successes and failures are cached, and shutdown cancels a pending probe. The fixed
remote script is read-only, has bounded output and a five-second SSH deadline,
and does not return arbitrary stderr or credentials.
