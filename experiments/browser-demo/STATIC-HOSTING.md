# Static hosting and browser authentication

The terminal UI can be distributed as static files. A browser still needs a
trusted way to authenticate an attachment and identify its server. Static
hosting does not make the current SSH bootstrap disappear.

This document separates the existing prototype from proposed adapters. It is a
design and implementation roadmap, not a claim that browser key login, public
listeners, cross-origin API access, or an internet deployment already exist.

## What works now

The bundled browser client connects to a WebTransport byte stream and speaks
`herdr-browser-pty-v1` to the PTY adapter. The local gateway owns an explicitly
configured SSH target and session. Authenticated SSH obtains a fresh certificate
pin and a random 32-byte attachment capability; the browser sends that capability,
receives an authentication ACK, then sends COMMIT before terminal input.

The current gateway binds to loopback and validates the exact Host, Origin, and
launch capability. It must not be exposed unchanged as a public SSH gateway.
Neither browser request bodies nor URL parameters select an arbitrary SSH host,
shell command, Unix user, path, or environment.

The static build and gateway-client boundary can be reused by another parent
application. Moving JavaScript to a CDN or another origin alone does not authorize
that origin to call the gateway. Check the README and build help for the current
configuration interface; the deployment and key-authentication adapters below
require additional work.

## Deployment shapes

| Shape | Browser control plane | Terminal data plane | Status |
| --- | --- | --- | --- |
| Local prototype | Local launch link and fixed SSH adapter | Direct WebTransport, or explicitly selected localhost relay plus SSH | Implemented |
| Hosted static UI with parent gateway | Employee login and profile-scoped attachment API | WebTransport to the selected server or explicit relay | Design; public authentication/proxy configuration required |
| Private static UI with token gateway | Random scoped token authorizes an HTTPS bootstrap | Direct WebTransport or an explicit gateway proxy | Proposed minimal next deployment; not implemented |
| Static UI with key-auth adapter | Enrolled device/imported key signs an auth-service challenge | Direct WebTransport after bootstrap, or explicit gateway proxy | Design; key enrollment and proof adapter required |

For a first internal deployment, put the static UI and its parent application's
attachment API behind the same HTTPS origin. A reverse proxy can serve static
files at `/` and route a bounded API prefix to the authenticated adapter. They
can remain separate packages and processes without making the browser depend on
cross-origin credentials.

A minimal parent adapter would expose profile IDs, authorize the signed-in
employee for a profile, and issue short-lived scoped attachments. Profiles map
to trusted server/session configuration. The browser must not turn the adapter
into a general SSH proxy. Existing employee login can supply identity; Herdr does
not need an account database to start.

A different API origin requires an explicit CORS/authentication adapter:

- Register exact HTTPS UI origins; do not use wildcard credentialed CORS.
- Authenticate and authorize every attachment and information request. CORS is
  a browser response-sharing policy, not authorization.
- Apply CSRF protection where cookies are used; validate Origin and preflights,
  set `Vary: Origin`, and keep attachment responses out of shared caches.
- Configure the helper's allowed browser Origin to the UI origin, not the API
  origin merely because the API performed the bootstrap.
- Account for browser local-network permissions and mixed-content rules before
  making a public static page call a loopback gateway. This is not a transparent
  substitute for an authenticated hosted adapter.

No public listener, CORS expansion, DNS change, TLS provisioning, or key enrollment
is implied by a static build. Those are explicit deployment/configuration steps.

## Recommended boundary: a separate auth service

Keep authentication in a small service or binary outside Herdr. The current
Node gateway already supplies that process boundary; cleanup does not require a
new Rust auth binary. The service can sit behind Caddy, accept a private token
first, and add employee OAuth or key proofs later through the same authorization
interface. Herdr's transport verifies only its narrow attachment capability.
Do not forward OAuth tokens, browser private keys, or SSH private keys to Herdr.
Separate processes improve ownership and reviewability; they are not a sandbox
when running as the same Unix user. Use per-user credentials and restricted
sockets now, with separate users/containers where stronger isolation is needed.

Prefer a **bootstrap-only gateway**: after authorization it starts/requests a
permitted attachment and returns the endpoint, pin, protocol and one-use
capability. Terminal data then travels directly between browser and Herdr's
WebTransport helper. The gateway does not pay the terminal bandwidth bill or
add another data-plane hop.

A **data-plane gateway proxy** is an explicit alternative when routing or policy
requires it. It terminates browser WebTransport, authenticates/authorizes the
attachment, then forwards a scoped connection to the configured runtime/helper.
That costs bandwidth and another hop, but can put policy, logging and connection
routing in one place. It must not become a general-purpose SSH or UDP proxy.
A local runtime hop should use a permission-restricted Unix socket or a loopback
endpoint with an attachment capability. Loopback location alone is not user
authorization on a shared host.

Caddy can serve the static bundle and HTTPS control API and integrate an OAuth
login. That HTTP login does not by itself authorize an independent UDP
WebTransport endpoint: the helper still needs its attachment capability.
Ordinary HTTP reverse-proxy support also does not prove WebTransport data-plane
proxy support; verify the chosen proxy and QUIC/UDP deployment explicitly.

Do not trust identity headers supplied directly by public clients. When an edge
supplies identity, it must strip client copies and communicate through a trusted
local socket/authenticated connection, or issue verified short-lived assertions
with the correct audience and per-user/profile scope. The gateway remains
responsible for authorization before issuing a grant.

## Phase 0 private deployment: a token bootstrap adapter

For private use, a random scoped bearer token is a reasonable first auth adapter.
This is simpler than implementing SSH key import or OAuth before the deployment
shape is understood. It is a proposal, not a public server added by this change.

A minimal future endpoint is `POST /bootstrap` over trusted HTTPS, with
`Authorization: Bearer <random-token>` and a bounded body containing a known
profile ID and terminal geometry. The server checks a configured token-to-profile
mapping, authorizes the request, and returns a short-lived one-use attachment
capability plus the trusted endpoint/pin. Request data never supplies arbitrary
SSH targets, commands or paths. The core transport still requires its own
capability, ACK and COMMIT; the long-lived gateway token is never sent to Herdr.

For the smallest self-hosted setup, run one gateway as the Unix user on the devbox
and start its fixed helper/PTY command locally. SSH is then needed for installation
and token enrollment, not for every browser attachment; no SSH private key needs
to be uploaded to the site. Caddy serves the static files and forwards the HTTPS
control API to that loopback gateway, while the browser connects to the helper's
permitted UDP endpoint. A central gateway may instead use the existing SSH
adapter. These are interchangeable ways of opening an authorized attachment.

Use at least 32 bytes of cryptographic randomness for a token. A small config
file can hold token hashes and their allowed profiles, with restrictive file
permissions, explicit rotation/revocation and no account database to start.
Keep tokens out of URLs, logs and static build output. Require exact configured
UI origins, bounded requests and `Cache-Control: no-store` for bootstrap responses.
If the UI and API are on different origins, implement the explicit CORS policy
above rather than relaxing the existing loopback gateway.

The browser may keep the token in memory or tab session storage by default.
Remembering it in browser storage can be an explicit private-use convenience
choice, with a clear **Forget token** action. Persistent browser storage gives
same-origin JavaScript the token's authority. Scope it to a particular user and
profile, use a dedicated controlled UI origin, and provide trusted SSH/admin
rotation if a device or deployment is compromised. A scoped bearer token's blast
radius should be smaller than that of importing a broadly reused SSH private key.

Later OAuth, browser device keys and imported-key proofs can produce the same
principal/allowed-profiles result and reuse the attachment flow. They do not
require replacing the terminal protocol or adding those credentials to Herdr.

## Both credential models

Support both a browser/device key and importing an existing SSH key, through the
same signing interface. Prefer a new device key for initial implementation.

### Browser-generated device key

Generate an Ed25519 key with WebCrypto after checking browser support, or use
ECDSA P-256 where broader compatibility is needed. Make the private `CryptoKey`
nonextractable and store its handle in IndexedDB using structured cloning. Export
only the public key in SSH public-key format. Enroll that public key through the
existing trusted SSH/admin path and give it a recognizable device label.

Nonextractable means JavaScript cannot export the key through WebCrypto. It does
not stop compromised JavaScript at the same origin from asking it to sign.
Use a dedicated, controlled application origin, bundled dependencies, a strict
CSP, and no third-party scripts. Terminal output must remain data, never injected
HTML. Clearing browser storage can lose a device key; trusted SSH enrollment is
the recovery path.

### Imported existing SSH key

WebCrypto does not import OpenSSH private-key files directly. It accepts formats
such as PKCS #8 and JWK; `openssh-key-v1` is a different container. Encrypted
OpenSSH files additionally require their bcrypt KDF and supported cipher, and
must be parsed and decrypted locally with a maintained implementation.

An import adapter should:

1. Parse a user-selected file with strict size, KDF-cost, cipher and algorithm
   limits. Prefer a shared, reviewed SSH-format library over handwritten crypto.
2. Request its passphrase only when unlocking. Neither the private key nor its
   passphrase is sent to the gateway or terminal server.
3. Keep the unlocked key in memory for the explicit unlock period. Offer a
   nonextractable IndexedDB key or an encrypted key blob for persistence; explain
   the different recovery and locking behavior.
4. Clear temporary byte arrays where practical and discard the passphrase after
   use. JavaScript garbage collection prevents a guarantee of complete zeroization.
5. Never log key contents or include them in URLs, profiles, crash reports,
   telemetry, or terminal input.

Do not persist a plaintext private key or passphrase in `localStorage`.
`localStorage` is appropriate for non-secret profile IDs, endpoint URLs, public
keys, fingerprints and preferences. Encrypting a saved key blob protects it at
rest only to the strength of its passphrase and KDF; same-origin malicious code
can still capture an unlock operation. A dedicated browser key avoids placing a
widely reused SSH credential in that trust domain.

An encrypted import that is explicitly unlocked and a device key that can sign
without a passphrase are distinct user choices. Do not silently convert one into
the other. A hardware SSH-agent key is not available through a normal static web
page; it needs an explicit local bridge or a separately designed WebAuthn flow.

### Algorithm adapters

| Key type | Browser signing | SSH representation work |
| --- | --- | --- |
| Ed25519 | WebCrypto Ed25519, feature-tested | SSH public-key blob and 64-byte signature encoding |
| ECDSA P-256 | WebCrypto ECDSA with SHA-256 | Convert P1363 `r || s` signatures into SSH `mpint` pairs |
| RSA | WebCrypto RSASSA-PKCS1-v1_5 with SHA-256 or SHA-512 | SSH RSA key blob and `rsa-sha2-256`/`rsa-sha2-512` signature |
| OpenSSH `sk-*` / hardware agent keys | Not a general WebCrypto import | Separate device-specific/WebAuthn or local-agent adapter |

Do not enable legacy RSA/SHA-1 `ssh-rsa` signatures. The `ssh-rsa` public-key
encoding name and an RSA signature's hash algorithm are separate concepts.
WebAuthn is a useful later device-login option, but is not a drop-in way to use an
arbitrary existing SSH key: it has relying-party, origin, user-presence and
assertion-verification rules of its own.

## Proposed key-auth adapter protocol

Keep `/herdr-roam/v1` and its capability authentication unchanged. Key proofs
belong in the separate auth service, for example as a versioned HTTPS
`/auth/key-v1` challenge/proof API behind Caddy. A WebTransport-terminating auth
gateway could offer the same proof protocol on its own versioned endpoint; that
is optional and is not a requirement to modify Herdr's capability handshake.
Transport, authentication and terminal application versions remain separate.

The auth service has configured identity, allowed UI origins, a dedicated
public-key allowlist, and a fixed profile/session policy. It runs without root
and does not accept an arbitrary shell command from browser JSON. Its resulting
terminal authority is explicit: an attachment as a Unix user can perform that
user's work. Avoid agent forwarding and administrative credentials unless
separately intended.

A minimal handshake is:

1. The browser selects a trusted profile and reaches its auth service over
   trusted HTTPS, or opens the auth gateway's versioned WebTransport endpoint.
   The selected profile identifies the server rather than trusting arbitrary
   identity assertions from an unknown endpoint.
2. It sends a bounded auth hello containing the public key and a permitted
   profile/session ID. The auth service checks its key allowlist and policy.
3. The service creates a random 32-byte, one-use challenge with a short expiry,
   bound in server memory to this authentication transaction, requested resource
   and exact Origin. For a WebTransport proof, also bind the connection. The
   signed payload identifies the auth service/server profile and protocol version.
4. The browser constructs an SSHSIG envelope with a fixed namespace such as
   `herdr.browser.attach.v1`, hashes the challenge with a supported hash, and signs
   the defined SSHSIG signed-data encoding. It does not blindly sign arbitrary
   raw bytes supplied by a remote page or server.
5. The service verifies the exact namespace, expected challenge bytes, expiry,
   allowed algorithm, signature, and equality of the signature's public key with
   the enrolled authorized key. It consumes the challenge once, authorizes the
   profile and issues a scoped attachment through the same bootstrap interface
   as token/OAuth authentication.
6. The browser verifies the resulting transport identity and supplies the
   attachment capability to the existing Herdr helper. After its ACK, it sends
   irrevocable COMMIT before terminal input. Failed or uncertain commitment must
   never replay a command through a fallback path.

Use an established SSHSIG implementation where possible. SSHSIG supplies domain
separation specifically so signatures cannot be confused with SSH user/host
login signatures or unrelated signing purposes. Encoding raw SSH signature
algorithms alone does not supply that protection.

Browsers do not expose a WebTransport TLS exporter API. Do not claim exporter
channel binding. The one-use nonce is instead attached to server-side
authentication-transaction state (and connection state for WebTransport proofs),
with TLS server
authentication and signed server/origin/resource context.

Use a dedicated exact-public-key allowlist initially. Reusing every line from
`authorized_keys` would bypass restrictions such as `command=`, `from=`,
`restrict`, and certificate-authority/principal policy unless the new service
implements them faithfully. Reject unsupported key/certificate forms explicitly.
Removing a key should deny new attachments; terminating already attached sessions
on revocation is a separate policy that must be implemented and documented.

## Server identity and certificate rotation

Client key authentication does not identify the server. Certificate trust must
be solved independently.

The current prototype receives its fresh certificate through authenticated SSH.
A static page cannot run SSH or open raw TCP to obtain that certificate. Suitable
next steps are:

- A trusted HTTPS parent/bootstrap API returns the fresh endpoint and pin after
  authorization; or
- Public DNS and a normal Web PKI certificate identify a persistent endpoint; or
- Trusted SSH setup exports a public server profile/pin for explicit enrollment.

A profile can contain the endpoint, public certificate hash, expiry, server ID,
application/auth protocol versions, and permitted resource IDs. Never put a
private key, passphrase, or long-lived bearer capability in the profile.
A self-asserted fingerprint fetched from an untrusted server does not establish
trust in that server.

Browser `serverCertificateHashes` requires a short-lived certificate: the
prototype uses seven-day ECDSA P-256 certificates. Restarting an ephemeral helper
changes the pin, and expiry/rotation requires a new trusted bootstrap. A saved
pin is not a complete unattended certificate-rotation design. A future signed
profile could rotate certificates under an enrolled stable identity, but the
initial identity still needs trusted enrollment. Ordinary Web PKI uses its normal
validation path rather than treating a long-lived certificate as a browser pin.

## Implementation sequence

1. **Portable static client:** separate build-time/runtime public configuration,
   gateway/auth adapter and terminal-session transport. Preserve the current
   fixed-target SSH gateway and same-origin security checks. No public exposure
   or new credential storage is required for this step.
2. **Private token adapter, then hosted parent adapter:** implement the minimal
   scoped-token HTTPS bootstrap for private use, or deploy behind existing employee
   authentication. Keep explicit profile authorization and short-lived attachment
   responses. Prefer one HTTPS origin; add cross-origin support only when needed.
3. **Key-auth adapter:** implement the versioned challenge protocol in the auth
   service, dedicated key enrollment/revocation and browser-generated IndexedDB
   keys. Reuse existing attachment capabilities; add a persistent transport
   listener/certificate lifecycle only if the deployment needs one. Test denial,
   replay, wrong Origin, cross-resource signatures, expired challenges and reconnect
   without input replay.
4. **Existing-key imports:** add bounded OpenSSH parsing/decryption and explicit
   unlock behavior, beginning with Ed25519; then add ECDSA/RSA adapters with format
   and algorithm test vectors. Reuse the same signer interface and server verifier.
5. **Additional authenticators and transports:** WebAuthn, parent-issued proofs,
   other gateway implementations, and replaceable display-state protocols can be
   added without changing frozen Herdr endpoint codecs or reinterpreting v1 auth.

The static/config split is a small prototype-sized change. A sound key-auth adapter
and enrollment flow is a separate multi-day feature, and broad encrypted
OpenSSH import adds compatibility and key-management work. Shipping a static page
is not evidence that those authentication/deployment pieces have been completed.

## References

- [WebCrypto key import formats](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey)
- [WebCrypto signature formats](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign)
- [Structured-clone support, including CryptoKey](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)
- [OpenSSH private-key format](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key)
- [OpenSSH SSHSIG domain separation and encoding](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig)
- [RustCrypto ssh-key parser/signature library](https://docs.rs/ssh-key/latest/ssh_key/)
- [WebTransport certificate pinning requirements](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport#servercertificatehashes)
