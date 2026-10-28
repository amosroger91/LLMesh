# Plan: WASM web app and one account across devices

Owner-requested extension to [the Rust/Android plan](PLAN_RUST_AND_ANDROID.md).
This adds targets; it does not delay Node releases or relax the Rust parity gates.
Status: the static WebLLM worker and desktop-signed worker-only QR sessions are
implemented with a GitHub Pages workflow. Full NIP-46 account login, portable
root-account recovery, PWA requester mode and encrypted history sync remain design
work. Current worker pairing is an application-scoped capability, not NIP-46.

## 1. Product behavior

- Desktop, Linux CLI, Android and web show the same Nostr account (`npub`), linked
  Base wallet, token balance and connected-device list.
- A new device offers **Create account**, **Connect existing account** (QR), and
  **Use Nostr signer**. Scanning requires approval on the existing device.
- Browser clients request and stream inference from the same mesh used by the
  companion. No separate browser-only companion model is silently substituted.
- The web app is an installable PWA, with an offline app shell and local history.
  Offline availability does not imply access to online workers or a remote signer.
- No social rooms or feed are reintroduced.

## 2. Account, device and money are different identities

| Identity | Scope | Authority |
| --- | --- | --- |
| Nostr account public key | Person, shared across devices | Account authentication and approved account-level signatures |
| Device key and group certificate | One installation or browser profile | Mesh admission, per-device grants and revocation |
| Base wallet | Explicitly linked to the account | Token ownership and on-chain payment authorization |
| Session/client key | One signer connection | Scoped requests to the signer; never root authority |

Pairing retains the same Nostr public key and existing wallet binding; it is not
new account registration and never grants another starter allocation. Never derive
an Ethereum private key from a Nostr private key. Nostr authentication alone cannot
spend ERC-20 tokens. The current immutable account/wallet binding and grant replay
checks remain authoritative until a separately tested migration replaces them.

Implement an account service and a platform-neutral `Signer` interface:
`getPublicKey`, `signEvent`, supported encryption methods, `disconnect`, and
capability discovery. Callers await signatures; they never require a secret-key
byte array. The daemon, API authorization, UI and CLI use that interface. Introduce
`llmesh-account` for account/session state and Nostr adapters, and `llmesh-web` for
the WASM boundary. Keep Nostr and wallet code out of Sovereign builds.

Do not identify two installations as one mesh peer merely because their account
matches. Device identity stays unique, which prevents connection replacement,
ambiguous worker attribution and revoking every device at once.

## 3. QR connection: NIP-46 remote signing

Prefer the standard [NIP-46 flow](https://github.com/nostr-protocol/nips/blob/master/46.md),
with [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) as the browser
extension option. Keep Nostr relay access behind the existing raw-WebSocket adapter;
add audited crypto support without a second competing account system.

1. The new device creates a fresh client keypair and a cryptographically random,
   one-use pairing secret (at least 128 bits). It displays a `nostrconnect://` QR
   containing its client public key, selected WSS relays, secret and permissions.
   Offer paste/deep-link fallback when a camera is unavailable.
2. The existing signed-in device scans it, validates scheme/length/relay URLs and
   shows the requesting app, requested permissions and a confirmation code on both
   screens. Client-supplied names/URLs are display hints, never proof of identity.
3. Approval is explicit on the existing device. The pairing attempt expires after
   two minutes, allows one successful connection, and is rate limited. Duplicate,
   expired, cancelled and mismatched-secret responses fail closed.
4. Both sides verify outer event signatures, intended recipient, request IDs and
   time windows. Use NIP-44 encryption as specified by NIP-46, then validate the
   returned secret. Call `get_public_key`: the signer's transport key can differ
   from the user's account key. Fetch signer relay preferences as specified.
5. The new device displays the account `npub` before accepting the session. Use
   minimal event-kind permissions (initially NIP-98 authentication), explicit
   origin/URL/method/payload checks, budgets and expiry enforced by the signer.
   No blanket signing of arbitrary events, transactions or decryption requests.
6. Store the client credential using the platform key-store adapter. Show the
   session under **Account → Devices**, with last use, grants and **Revoke**.
   Logout deletes local session keys even if the remote signer is unreachable.

The QR contains no `nsec`, seed phrase, wallet private key, API bearer key or group
bootstrap secret. Redact QR secrets and connection URIs from logs, analytics and
crash reports. Disable third-party scripts on pairing/account routes. Use bounded
parsers and explicit camera permission; there is no need to upload camera frames.

Remote signing requires the approving signer to remain reachable. A phone can be
the signer where its OS permits operation; do not promise background availability
on mobile. An external bunker or an always-on home daemon can provide continuity.
Show **Signer unavailable** with recovery options rather than creating another
account. A read-only account view is available while signing is unavailable.

Independent sign-in while all existing signers are offline requires a deliberate
encrypted backup/import or a future delegation scheme. Backup is separate from QR
login, requires reauthentication, and explains that root-key copies cannot be
individually revoked. Do not silently copy the root secret to achieve offline login.

NIP-44 does not provide forward secrecy or post-quantum protection. QR account
pairing does not upgrade the inference channel's privacy level or replace group
PKI. Sovereign uses organization enrollment, not Nostr relays or community wallets.

## 4. Shared balance and payment permissions

- Every device reads the same linked Base wallet's on-chain balance. Pending locks,
  settlements and transaction IDs are reconciled across devices; pending spending
  is never represented as a fresh spendable balance on another device.
- Initially use an external wallet or an explicit request to the wallet-owning
  desktop/daemon for each payment. Signing a Nostr event cannot impersonate wallet
  approval. A browser never receives the worker's or coordinator's escrow key.
- Later add separately audited, revocable payment sessions with per-device amount,
  expiry and recipient/contract/chain limits. Check chain ID, escrow version and
  allowance. Wallet submission serializes nonce allocation across clients.
- Worker earnings go to the approved linked wallet. An unattended worker uses a
  device-scoped worker credential and explicit earning address; remote account
  signing must not add a signer round trip to every output chunk.
- Free self-inference retains the existing net-zero debit/credit behavior. It must
  not be mistaken for a paid request to another machine owned by the same account.
  Cross-device owner policy is explicit and cannot bypass another worker's quote.
- Account recovery, wallet rotation and lost-device revocation are separate flows.
  Wallet rotation requires proofs from both wallets plus the account signer and
  rules for pending escrows; until supported, keep the binding immutable.

## 5. WASM boundary and browser runtime

Build `llmesh-web` as `cdylib`/`rlib` for `wasm32-unknown-unknown`, using
`wasm-bindgen` and a Web Worker. Share pure protocol validation, quote calculations,
placement inputs and routing policy from the Rust core. Add browser-specific
adapters for Fetch/streaming, WebSocket, timers, randomness and storage. Keep
native process management, NVML, SQLite/SQLCipher, N-API, UniFFI, raw TCP/UDP,
`aws-lc-rs`/FIPS and Ollama spawning out of the browser dependency graph.
Do not compile the whole native daemon and assume its OS operations work in WASM.

Default web behavior is requester-only. Requester mode does not download model
weights. Browser contribution is a subsequent opt-in feature: a WebGPU engine
(evaluate WebLLM against current catalog compatibility) with a bounded WASM CPU
fallback. Detect actual adapter limits, memory allocation failures and eviction;
the browser cannot reliably report native free VRAM. Offer Low/Medium/High,
auto-select a browser-compatible model, and reduce/retry when allocation fails.
The browser model artifact may differ from the Ollama artifact; pin and verify
both and advertise the exact model, quantization and engine. Never claim parity
until conformance tests and representative inference measurements pass.

Only advertise a browser worker while its tab is active and its engine is ready.
Withdraw slots on device loss, suspension, unload and connectivity loss. Mobile
background tabs are not always-on workers. Label power use as estimated where no
hardware measurement exists; no fictitious wattage/VRAM measurements.

Use IndexedDB for local history/session metadata and Cache Storage/OPFS for model
artifacts as supported. Keep only non-secret preferences in localStorage. Browser
storage may be evicted. Request persistent storage where available and provide an
encrypted export. Non-extractable Web Crypto keys do not stop malicious same-origin
code from using them; prefer a remote signer/extension for root account custody.

## 6. Browser access to the mesh

WASM clients cannot directly join the current native Hyperswarm transport or use
native libp2p UDP QUIC sockets. Do not introduce a hidden Hyperswarm bridge.

After R3, add browser-compatible libp2p transport support: WebRTC where feasible,
with an authenticated WSS relay/gateway fallback on user-owned nodes. Prototype
Rust WASM vs JS libp2p compatibility before choosing the browser transport crate.
Keep the Rust protocol/route logic shared even if a JS transport adapter is needed.
No gateway is an account server or the mandatory custodian of account keys.

Direct streaming is preferred after setup; warm authenticated connections are
reused. Signing, discovery, quotation and payment occur before generation, not on
every token. Bound queues, propagate cancellation and backpressure, enforce frame
limits, and measure RTT, first token and throughput separately for each route.
Fallback relays incur an explicit extra hop in the UI and scheduler.

Alternative initial requester path: HTTPS to a paired node's API, with Fetch SSE.
This needs a new explicit origin allowlist, preflight support, short-lived scoped
authorization, replay prevention and DNS-rebinding protection. Existing desktop
API origin rejection stays the default. Never embed a daemon bearer key in the
PWA, allow wildcard credentialed CORS, or disable TLS to reach a local node.
Browser mixed-content/private-network rules can prevent HTTPS-to-loopback access;
use an approved HTTPS endpoint or authenticated compatible transport and test it.

For trusted/sealed requests the relay forwards sealed payloads and sees only
necessary routing metadata. If the selected access path terminates plaintext,
show its trust implications and reject privacy levels it cannot enforce.

## 7. Synchronization and lifecycle

The account is shared; files/history are not automatically public or synchronized.
Device enrollment and history sync are separately consented features. Start with
local history and shared account/balance; show the distinction in the UI.
Later synchronize encrypted, versioned records over approved peers with conflict
handling, tombstones, replay limits and per-device cursors. Do not put chat text,
wallet seeds or group admission material in public Nostr notes. Relay retention
does not guarantee backup, deletion or delivery.

Revocation blocks future signer requests and group/API admission, invalidates
cached sessions within a bounded interval and rotates affected sync keys.
Offline recipients revalidate before serving. Already copied plaintext or root
keys cannot be remotely erased. Root-key loss requires a recovery design, not an
unverifiable reset endpoint. No mandatory hosted identity database is introduced.

## 8. Delivery phases and acceptance

| Phase | Depends on | Acceptance gate |
| --- | --- | --- |
| W0: portable contracts | R0–R1 | WASM target builds; native/WASM fixtures agree on validation, quotes and routes; dependency graph excludes native engines |
| I1: account/signer abstraction | R1, before R5 | Existing accounts migrate without changing npub/wallet/grants; local, NIP-07 and fake NIP-46 signers pass contract tests |
| I2: QR pairing | I1 | Desktop↔Android and browser↔signer tests; wrong-secret/replay/expiry/wrong-user/denied-permission/relay-failure/revoke tests; no root secrets in QR/logs/storage |
| W1: web requester | W0, I2, HTTPS access or R3 transport | PWA signs in, previews actual price, funds, streams, cancels, reconnects and receives the same account balance; offline shell works |
| W2: direct browser mesh | R3, W1 | Cross-network native↔browser streaming, NAT/relay fallback and privacy enforcement tested in supported browsers |
| W3: optional browser worker | W2 | Catalog-verified engine, device-loss/OOM fallback, suspension withdrawal, bounded queues, token payouts and measured latency |
| I3: encrypted history sync | I2, Rust PKI/store | Consent, conflicts/deletions, revoked/offline devices and recovery tested; no plaintext relay leakage |

CI builds `wasm32-unknown-unknown`, runs `wasm-bindgen-test`/browser tests and the
shared fixtures. Add Chromium, Firefox and WebKit requester tests, mobile camera
and deep-link smoke tests, strict CSP and service-worker upgrade/rollback tests.
Test with camera denied, signer offline, two concurrent spending devices and
expired escrow quotes. WebGPU worker support is feature-detected independently
from requester support; publish the measured browser/device matrix.

Ship a versioned `llmesh-web.tar.gz` static artifact with checksums and free
keyless signing in the existing release workflow. Hosting, custom domains,
TURN bandwidth and public gateways are optional deployment choices; no paid
service or signing certificate is added without owner approval. PWA installs
must not cache authenticated API responses or root credentials in the service worker.

## References checked for this plan

- [NIP-46 remote signing](https://github.com/nostr-protocol/nips/blob/master/46.md)
- [NIP-07 browser signer](https://github.com/nostr-protocol/nips/blob/master/07.md)
- [NIP-44 security limits](https://github.com/nostr-protocol/nips/blob/master/44.md)
- [Rust's browser WASM target and OS limitations](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)
- [WebGPU availability and secure contexts](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
