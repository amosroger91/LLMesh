# Review implementation status

Updated 2026-10-28. This is a working-tree implementation, not a claim of production readiness or a live deployment.

## P0

- P0-1/P0-2: completed delivery is separated from confirmation. SQLite-backed settlement retries use backoff, recover pending work across restarts and check chain state before resending. Delivered work is never auto-refunded. Payer-authenticated receipt lookup is available.
- P0-3: reusable approval and nonce-serialized transaction submission replace confirmation-serialized requests. A deterministic five-request test proves all locks submit before the first confirmation. Lock confirmation still blocks startup; payment channels are R1.
- P0-4: busy and duplicate IDs return retryable errors; active jobs retain their connection.
- P0-5: invalid CLI contribution levels fail early with usage; background contribution errors become setup errors.
- P0-6: failed RPC connection is visible and retried with backoff; local self-service remains available.

## P1

- P1-1: escrow v3 supports coordinator-signed delivery proofs claimable by workers. Early refunds require worker-signed failure authorization. The ordinary refund path waits for expiry plus 24 hours. Coordinator and worker queues can settle idempotently. This is a minimum trust improvement: the coordinator can still withhold its signature, and attestations do not prove correct inference. There is no decentralized arbitration.
- P1-2: lock IDs are derived from `(payer, clientId)` on chain.
- P1-3: identity-only initial hello; capabilities go only to trusted identities. Trust lists never go on wire.
- P1-4: ten-second handshake deadline; untrusted identities are rejected. Default topics are isolated per identity; explicitly shared secrets derive group topics. Invite/member-management UI is still R2.
- P1-5: authenticated peers are indexed by Nostr identity; replacements close stale connections.
- P1-6: central envelope validators and negotiated Node protocol versions 1–3, with per-instance slots in version 3. This Node wire format is separate from the planned Rust libp2p cutover.
- P1-7: API secret removed from status and polling. Copy-key stays in the main process; no reveal endpoint was added.
- P1-8: optional passphrase-encrypted headless keys (scrypt/AES-GCM), including in-place migration. Unencrypted Windows mode warns about ACL requirements.
- P1-9: registration accepts a destination wallet bound by the signed voucher; the coordinator can relay it and sponsor gas. The coordinator must be funded.
- P1-10: persistent wallet binding, key/IP rate limits, default grant allowlist, explicit open-policy override and an admission hook.

## P2 and verification

Addressed: pathname routing with full-URL NIP-98 binding; output defaults centralized in request validation; self-service ledger documentation; unused social storage code; narrower native-module asar unpacking; unsubscribe callbacks; cancellation after completion; contract compilation/tests in `npm run check`; cross-platform CI configuration.

Added: unified pure placement planner, managed/external runtime pool, per-instance routing slots and restart/fallback tests. ESLint configuration exists; broader typed checks and CI enforcement remain. Rust ports of quotes and pure placement agree with shared fixtures, and browser WASM exports compile.

Remaining: deeper Service decomposition, complete GPU/instance controls, concurrent energy attribution, idle-baseline subtraction, full chaos/property/fuzz coverage, real two-Service/local-DHT integration, coverage thresholds and hosted CI results. Expanded CLI, cross-platform packaging and release automation are still in progress. Production measurements need separate runs.

Added after the initial review: metered billing by model size (0.5 credit per token for 0.8B and browser workers, 1 through 9B, 1.5 above that), refundable reservations, 100,000-credit starter grants, escrow v5 usage-bound delivery receipts, worker-only browser QR enrollment, WebLLM/PeerJS worker transport, a network graph, bounded swarm tasks and opt-in donated API inference. Mesh-only is the default and is enforced independently by API runtimes. Provider usage, quota failures and actual reported models are recorded without exposing keys. A local self-request cannot mint rewards.

Internal credits are the default settlement on the desktop and the headless CLI. Base escrow remains optional and is not deployed. A coordinator signs a Nostr receipt for remote credit work. The worker stores that receipt only after it matches completed work, and a later receipt must use a newer sequence. The receipt does not mint a spendable balance on the worker. A discrete GPU that cannot fit the desktop 4B minimum serves the largest smaller model that fits on that GPU. Machines with no discrete GPU do not silently drop below the desktop minimum.

Remaining roadmap work includes audited payment channels, an encrypted identity backup, group invite management, broader retry/chaos testing, signed model catalogs and observability. See [ROADMAP.md](ROADMAP.md). Automatic native model selection remains in force; donation configuration selects an upstream model, not the native contribution model.

## Internet funnel

LLMesh Funnel v1 publishes the existing authenticated OpenAI-compatible API for a phone, a cloud job, or any other client. Providers are `relay` (the standard outbound tunnel), `tailscale`, `cloudflare` (named tunnel or quick tunnel), and `public`. The default is off. A public URL is advertised to trusted peers only after `/.well-known/llmesh.json` returns this node's key. A relay bound outside loopback requires TLS, or explicit `--insecure-listen`, and a token or node allowlist, or explicit `--funnel-open`. The relay protocol, CLI, desktop controls, Prometheus gauges, deployment examples, and tests are in the tree. Mesh job dispatch stays on the encrypted Hyperswarm connection by design. This project does not operate a hosted relay. Payments, group PKI, the Rust daemon, Android, and the installer matrix remain separate tracks.

## Branding

The supplied cyan network emblem is preserved at `assets/branding/logo.png`. Multi-size ICO and 512-pixel PNG are generated by `npm run icons:build`. Sidebar, overview, favicon, BrowserWindow/taskbar, Windows executable/NSIS installer/uninstaller, macOS/Linux build configuration, README and the local Windows desktop shortcut use it.

No live contract deployment, real cryptocurrency transaction or release publication is claimed. See Git history and GitHub Actions for pushed revisions and hosted verification.
