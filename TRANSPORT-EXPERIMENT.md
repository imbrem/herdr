# Experimental named remote transports

This custom fork adds an opt-in transport experiment. It does not change Herdr's
`PROTOCOL_VERSION`, endpoint generation, published codecs, or saved-machine files.
The stock installation and existing servers can keep running.


## Build and try without replacing stable Herdr

On the client, install Rust 1.96.1 and Zig 0.16.0 (the upstream Herdr build
requirements), then:

```sh
git clone https://github.com/imbrem/herdr.git
cd herdr
git switch experiment/named-webtransport
cargo build --locked -p herdr -p herdr-roam
./scripts/try-webtransport --remote telperion  # auto, permits SSH fallback

# Or require WebTransport explicitly:
HERDR_TRANSPORT=webtransport-stream-v1 \
  ./scripts/try-webtransport --remote telperion
```

On the remote machine, only the helper is new. It needs Rust, not Zig:

```sh
cargo install --git https://github.com/imbrem/herdr \
  --branch experiment/named-webtransport --locked herdr-roam
```

Allow UDP **60000–61000** to that machine. SSH on its existing port remains
necessary. Use `auto` instead of the strict transport name to permit fallback.
The server helper advertises the server-side SSH address; this initial direct-UDP
prototype does not handle servers behind unrelated NAT or SSH-only jump hosts.
Neither command replaces stable Herdr. The experiment can attach through the
existing server's endpoint compatibility negotiation.

The development binary uses upstream's debug server identity. The launcher clears
inherited session/socket/caller routing from the surrounding Herdr pane; pass
`--session NAME` explicitly if wanted. Do not stop or update a live stable server to
try this helper. For saved-machine selection, launch the experimental client
with the same environment variables before connecting its saved machines.

## Two independent negotiations

1. **Transport selection** chooses how endpoint bytes travel. Names describe
   immutable transport contracts: `ssh` and initially `webtransport-stream-v1`.
2. **Herdr endpoint negotiation** still chooses Herdr's existing generation and
   application codecs after the transport connects.

An unset transport preference means ordinary `ssh`, preserving upstream behavior.
`auto` is a local selection policy, never a wire protocol name. It expands to
`webtransport-stream-v1,ssh`. An explicit ordered list enables controlled experiments:

```sh
HERDR_TRANSPORT=auto herdr --remote telperion
HERDR_TRANSPORT=webtransport-stream-v1,ssh herdr --remote telperion
HERDR_TRANSPORT=webtransport-stream-v1 herdr --remote telperion  # strict; no fallback
HERDR_TRANSPORT=ssh herdr --remote telperion
```

We use `ssh` rather than `null` as the explicit name: absence can retain the
legacy default, while logs and benchmark records should name what actually ran.
The helper owns the supported-protocol registry and rejects unknown local names;
core Herdr only validates name syntax. Replacing the helper can add experiments
without rebuilding the TUI. A later named protocol is added alongside
old names, not by changing the meaning of an existing name.

The SSH-authenticated bootstrap offers supported names and verifies a common
selection before any application bytes are forwarded. Older remote machines or
blocked UDP fall back to the existing SSH bridge only when the preference list
allows `ssh`. After admission to a selected transport, a failure closes the
attachment; it must not retry or replay uncertain input over SSH. Herdr owns
subsequent reconnects and starts a fresh attachment to its persistent server.

## Initial implementation

`herdr-roam` is a small separate Rust helper built with wtransport, Quinn, and rustls. Herdr
selects it at the existing SSH stdio-bridge boundary, so both saved-machine
connections and standalone remote attachments use the same experiment. It can
also be exercised independently of a patched TUI:

```sh
HERDR_TRANSPORT=auto herdr-roam connect -- -T telperion \
  'herdr remote-client-bridge'
```

This is a binary endpoint pipe, not an interactive shell. Do not run that example
with a real terminal expecting a shell prompt; feed it endpoint data or use a
patched Herdr client.

The helper is an optional executable. `HERDR_ROAM_BIN` selects its local path.
The remote helper must be discoverable as `herdr-roam` in the remote SSH shell's
PATH. The default rejects browser Origin headers. A trusted SSH bootstrap may opt one
attachment into an exact canonical HTTP(S) Origin using
`HERDR_ROAM_ALLOWED_ORIGIN`; wildcards and unscoped browser access are rejected.
The browser demo uses this per-attachment setting with a protected loopback parent
app. A production browser login still needs its own trusted auth/bootstrap service.

No replacement of the long-lived Herdr server is needed: the helper invokes
its existing authenticated stdio bridge after the new transport authenticates.

### Security boundary

- OpenSSH retains host-key checking, user authentication, and the existing SSH
  options. Bootstrap credentials travel only in that authenticated channel.
- Each helper has a fresh certificate and random capability. The client trusts
  only the bootstrap certificate and validates TLS normally. QUIC encrypts all
  endpoint traffic. No permissive certificate verifier or custom encryption.
- The server authenticates the capability before launching the selected user's
  bridge command. The network peer cannot choose a shell command or socket path.
- Bootstrap/authentication sizes, timeouts, streams, and flow-control windows are
  bounded. No 0-RTT input. All unauthenticated awaits share a hard deadline.
  Listeners are per attachment, not a permanent public
  unauthenticated API. Tokens must not appear in argv, logs, or saved profiles.
- An explicitly permitted SSH fallback preserves encryption and SSH identity
  checks. It can hide a failed experiment, so benchmarks must require a specific
  transport instead of using `auto`.

### Later: parent-managed keys, not a second account database

The current permission rule is the same shape as mosh: only an authenticated SSH
session can mint a short-lived attachment capability, and it authorizes exactly
the bridge command chosen by that SSH user. TLS encryption alone never grants
access. A browser cannot bypass this bootstrap.

A browser/auth adapter should accept parent-provided public keys or a verifier,
not add login/password/user management to this listener. A minimal extension is:

1. The trusted parent authenticates the user, provisions an allowed public key,
   and supplies the server certificate pin and a narrowly scoped attachment grant.
2. The listener sends a fresh, expiring random challenge. The client signs a
   domain-separated transcript binding the challenge, selected protocol, server
   certificate fingerprint, requested session/scope, and both nonces. Do not accept
   a signature that can be replayed onto another server or attachment.
3. A small authorization adapter verifies the allowed key/signature/scope before
   opening the user's local Herdr socket. The parent/auth service manages allowed
   keys, revocation, grant lifetimes, and browser Origin policy.

Browser JavaScript cannot generally present arbitrary client TLS certificates via
WebTransport, so use an application-level proof of possession rather than assume
mTLS is available. Server pinning and client authorization solve opposite sides
of identity. Keep this extension under a new named handshake/auth capability;
never silently reinterpret `webtransport-stream-v1` or weaken its SSH bootstrap.
The current prototype does not implement this future key-verification adapter.
A per-user listener can keep running without root; authorization should map grants
to preconfigured sessions/sockets, never arbitrary client-supplied filesystem paths.

### What this does and does not do

The first WebTransport contract is a reliable ordered byte stream with keepalives and
QUIC path migration. It removes SSH/TCP from the steady-state data path and gives
us a real encrypted UDP connection to experiment with. Herdr's existing endpoint
writer/background reconnection architecture remains responsible for keeping local
navigation independent of a stalled remote.

It is **not full mosh**: it does not predict local input, send only the latest
screen state, or resume an attachment after the QUIC idle timeout. A reliable
stream still waits for missing bytes. Ordinary SSH remains necessary for setup;
targets reachable only through an SSH jump host may need SSH fallback because UDP
must reach the server directly. Firewalls must permit the helper's UDP port range.

Mosh's networking code is a C++ state synchronization engine coupled to its
application state model, not a drop-in Rust stream library. Quinn is a simpler
starting point for this fork; it does not by itself implement mosh's state sync. We use WebTransport from the
start so datagrams and separate streams are available for later named contracts.

For the concrete source boundaries and next display protocol, see
[From a pipe to a mosh-style display](DISPLAY-TRANSPORT-DESIGN.md). For an
experimental xterm.js client, see [the browser demo](experiments/browser-demo/README.md).

## Next experiment: state synchronization

Keep input/control reliable and ordered, then split presentation into separately
versioned replaceable full snapshots. Do not discard arbitrary existing Herdr
frames: some are deltas, graphics, replies, or other stateful messages. A new
named transport can negotiate the capabilities needed to reset presentation,
acknowledge input sequence numbers, and recover from missing bases. Consider
multiple priority classes so image transfer cannot delay keyboard/control data.

Prediction is a separate client terminal-model experiment. Evaluate it against
full-screen agents as well as line-oriented shells; replaying mutations to hide
uncertainty is unacceptable.

## Browser / WebTransport path

The prototype uses real WebTransport over HTTP/3 (`wtransport`, built on Quinn),
including browser-compatible short-lived P-256 certificates. A browser still needs a trusted HTTPS bootstrap, browser-compatible certificate
validation/pinning, Origin checks, and separately scoped authentication. Do not
expose the current SSH-only bootstrap as an unauthenticated HTTP endpoint.

## Research harness

Keep a deterministic traffic workload and compare transports under the same
latency/loss/reordering/blackout conditions. Record the selected transport name,
implementation commit, endpoint codec, geometry, pane count, workload, RTT,
bandwidth, loss, and trial seed. Key metrics:

- local tab-out / workspace-switch latency, even while remote output is blocked;
- key-to-visible-response latency and time to catch up to the latest screen;
- bytes, CPU, resident memory, queue lengths, and fairness under image transfer;
- recovery after loss, address changes, and a sleeping laptop;
- no duplicated or reordered input, including resize/paste/commands;
- fallback only before input admission; all selection/authentication errors clear.

Use isolated test sessions and a userspace UDP impairment proxy or disposable
network namespace. Never apply global packet loss to a live development server.
Protocol candidates should have different names and strict selection for A/B
runs, with security/integrity tests as hard constraints around the optimization
objective.

## Diagnostics

`HERDR_ROAM_DEBUG=1` enables WebTransport setup metadata diagnostics in a helper.
It is off by default; authentication capabilities and application bytes must not
be logged. Strict transport selection is preferable to `auto` when diagnosing a
network path, since automatic SSH fallback can otherwise hide failed UDP setup.

Real Telperion-to-Prodigy testing selected strict `webtransport-stream-v1` and
returned 262,144 binary bytes exactly, on two runs. An automatic native
laptop-to-Telperion attachment stalled in TLS/HTTP3 setup, then successfully
queried the existing Herdr API through SSH fallback before commitment. Direct
Chrome-to-Telperion setup also stalled; the browser demo reports that failure
instead of silently changing transports. The precise cause remains unresolved.
Do not weaken certificate pinning to work around it.

The explicit browser `--relay` mode was verified in Chrome: xterm.js rendered a
real Telperion Herdr session, and typed shell input produced the expected output.
That path is browser WebTransport to the loopback helper, then authenticated SSH
to Telperion. It proves browser rendering and the browser-compatible handshake,
but does not establish direct remote UDP connectivity or mosh-style state sync.
Tests used a dedicated named session; existing Herdr servers were not restarted.
