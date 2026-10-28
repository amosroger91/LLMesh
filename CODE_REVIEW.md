# LLMesh code review: brief for the implementing agent

Reviewed on 2026-10-28 against the working tree; nothing was committed yet. The code was being edited while this review was written, so **re-check each `file:line` before changing it**. Some numbers may have shifted, and a few items may already be fixed.

Baseline at review time: `npm test` showed 20/20 passing. `npm run check` only runs `node --check` (syntax).

## How to use this document

- Work through it in order: **P0 → P1 → P2 → roadmap**. P0 and P1 are bugs or design flaws with a concrete failure scenario. The roadmap covers what turns this from a prototype into a product.
- For every fix: write the failing test first, then fix, then run `npm test`. Each item lists the test to add.
- Keep the README honest. The README is unusually accurate about limitations, so keep it that way. When behavior changes, update the README in the same change.
- Don't widen scope. No social features, no new chains, no new token mechanics, unless an item below asks for it.

---

## P0: correctness and money bugs

### P0-1. A failed settle refunds the payer, so the worker loses pay for work it already delivered
`src/service.js:214-219`. `settle()` runs inside the `try`. If it throws (RPC timeout, `tx.wait` 120 s timeout, nonce error), control falls into the `catch`. There, `payment && !settled && ownsPayment` is true, so the code calls `payments.refund()`.
- **Failure:** the worker streams the full answer, the settle tx times out waiting for confirmation, and the coordinator refunds the payer. The worker is never paid. If the settle tx later mines, the refund reverts, and the user still gets an error even though everything succeeded.
- **Fix:** after the stream completes, never refund. Track a `delivered` flag. If settle fails after delivery, record the job as `settle-pending` in `onchain_jobs` and retry it in the background, with backoff and idempotency (check `jobs(id).state` on chain before resending). Only refund when nothing was delivered.
- **Test:** fake `payments.settle` that rejects once. Assert there is no refund call, the job state is `settle-pending`, and a retry settles it.

### P0-2. The final SSE chunk and `[DONE]` wait for the settle confirmation
`src/service.js:214` together with `src/api.js:76-82`. `service.chat()` awaits `payments.settle()`, which includes `tx.wait(1)`, before it returns. The API writes the finish chunk and `[DONE]` only after that.
- **Failure:** every paid streaming request hangs for one or more block confirmations after the last token. Clients with short idle timeouts may treat it as a failure.
- **Fix:** emit the finish chunk and `[DONE]` as soon as generation completes. Settle asynchronously (see P0-1). Put the settlement result in a receipt the client can fetch (`GET /v1/receipts/:id`) instead of in the stream.
- **Test:** with a settle that takes 2 s, assert `[DONE]` arrives in under 200 ms after the last delta.

### P0-3. Every request costs up to three serialized on-chain transactions
`src/payments.js:67-75, 90-93`. `begin()` approves exactly `price`, so the allowance is used up every time and nearly every request sends `approve`, then `lock`, then `settle`. `mutate()` pushes **all** transactions through one promise chain.
- **Failure:** with N concurrent requests, request N waits for every earlier approve/lock/settle to confirm. Startup latency is several seconds per request, and throughput is capped at about one request per few block times, regardless of how many workers exist.
- **Fix, short term:** approve `MaxUint256` once (or support EIP-2612 `permit`). Manage nonces explicitly so `lock` transactions can be sent in a pipeline instead of awaited one by one. Keep `mutate` only for nonce allocation, not for the whole confirmation wait.
- **Fix, real:** see Roadmap R1 (deposit balance with off-chain signed debits). Inference shouldn't wait on a block per request.
- **Test:** 5 concurrent requests against the JS EVM. Assert total wall time is well under 5× a single request, and the number of `approve` transactions is ≤ 1.

### P0-4. A worker at capacity, or a duplicate job id, kills the whole connection
`src/mesh.js:88`. `throw new Error('Bad job or worker at capacity')` inside `handle()` reaches `.catch(() => socket.destroy())` at `src/mesh.js:52`.
- **Failure:** a legitimate coordinator sends a fifth concurrent job, and the worker drops the socket. That aborts the 4 jobs already in flight (`close` handler at `mesh.js:56-59`), so they all fail and get refunded.
- **Fix:** reply with `{type:'error', id, error:'busy', retryable:true}` and keep the connection open. Reserve `socket.destroy()` for protocol violations (bad JSON, bad signatures, frames that are too large).
- **Test:** open 5 jobs on a worker limited to 4. Assert 4 complete and the fifth gets a retryable error.

### P0-5. An invalid `--level` crashes the headless node
`src/cli.js:28-29` passes `process.argv[...]` unchecked. In `src/service.js:112-113`, `void this.configureContribution(level)` rejects at line 70 *before* the `try`, so the rejection is unhandled and Node exits.
- **Fix:** validate CLI args up front with a helpful message. Make `configureContribution` never produce unhandled rejections: wrap the body and set `setup.state = 'error'`.
- **Test:** `configureContribution('bogus')` called through `startContributionManagement` does not crash the process.

### P0-6. Headless startup dies if the RPC is unreachable
`src/cli.js:20`. `await payments.connect()` with no `catch`. Electron catches the same error (`main.js:30`), but the CLI doesn't.
- **Fix:** do what Electron does: record `payments.state.error`, keep serving local and self-paid requests, and reconnect with backoff.

---

## P1: security, trust and robustness

### P1-1. The coordinator can take free inference by refunding after delivery
`contracts/LLMesh.sol`, `refund()`. The coordinator may refund at any time, including after a worker delivered. `settle` is also coordinator-only. The worker has no recourse.
- **Fix, minimum:** require a payer- or coordinator-signed completion receipt to refund early, or let the *worker* settle with a coordinator signature over `(id, outputHash)`. Add a dispute window: after expiry, a worker holding a coordinator-signed "delivered" attestation can claim the payment.
- Document whichever trust model you pick in the README "Base token and escrow" section.

### P1-2. Job id front-running in `lock()`
`LLMesh.sol`, `_lock`. Whoever calls first with a given `id` claims it. An observer can copy a pending external payer's `id` from the mempool and lock it first, griefing that payer (their tx reverts with "invalid job").
- **Fix:** derive the id on chain: `id = keccak256(abi.encode(msg.sender, nonce))`, or `keccak256(msg.sender, clientId)`. Return it in an event.

### P1-3. The worker advertisement leaks the trusted-coordinator list and wallet to anyone on the DHT topic
`src/service.js:41-44` puts `acceptFrom: trustedCoordinators` into `describe()`. `src/mesh.js:30-32` signs and sends all of it in `hello` to **every** connected peer, including untrusted ones. The default topic is the public string `'llmesh-v1'`.
- **Fix:** keep `acceptFrom` local and never put it on the wire. Send the full advertisement only after the remote peer's signed hello shows a pubkey in `allowedWorkers ∪ trustedCoordinators`. Before that, send a minimal hello (pubkey and protocol version only).

### P1-4. Untrusted peers occupy connection slots indefinitely
`src/mesh.js:17` (`maxPeers: 32`) and `connect()`. Strangers on the topic are never disconnected.
- **Failure:** anyone who knows the default topic can fill all 32 slots and stop trusted peers from connecting.
- **Fix:** give each peer about 10 s to present a valid hello whose pubkey is trusted, otherwise destroy the socket. Default the topic to something derived from a shared group secret (e.g. `hash('llmesh/v2/' + groupSecret)`), and show a "group invite code" in the UI instead of asking users to set `LLMESH_TOPIC` by hand.

### P1-5. Duplicate connections from the same pubkey use whichever socket comes first
`src/mesh.js:138`. `[...this.peers.values()].find(p => p.pubkey === candidate.pubkey)` can pick a stale socket when a peer reconnects.
- **Fix:** index peers by pubkey. When a newer authenticated connection arrives, close the older one (or keep the lower-latency one deterministically).

### P1-6. There's no protocol version
Mesh messages carry no version, and `hello` content isn't schema-validated beyond some spot checks. Add `v: 2` to hello and refuse unknown majors with a readable warning. Validate all inbound messages with one schema function per message type, not ad-hoc `if` checks spread through `handle()`.

### P1-7. The API key goes to the renderer every 1.5 s
`src/service.js:136` (`apiKey` in `status()`) and `src/ui/app.js:66,147`. Polling `status` every 1.5 s copies the secret into renderer memory and the DOM (`api-key` input value) all the time.
- **Fix:** remove `apiKey` from `status()`. The `copy` IPC already exists. Add a "reveal" IPC if you need one.

### P1-8. Headless keys are plaintext; `0o600` does nothing on Windows
`src/cli.js:12-17`. The README admits it. Either use the OS keychain (`keytar`-style, or DPAPI via a small native helper), or encrypt with a passphrase taken from env or a prompt. At minimum, warn loudly at startup on win32.

### P1-9. Starter grants need ETH that new wallets don't have
`payments.register()` sends `token.register()` from the user's fresh wallet, which has 0 ETH, so the "Claim starter tokens" button can't succeed for a new user.
- **Fix:** have the coordinator submit `register` as a relayer (the contract already checks the voucher signature, so `msg.sender` should become a `wallet` parameter), or use a paymaster or smart account on Base.

### P1-10. Account rebinding and sybil grants
`src/api.js:39-40`. `INSERT OR REPLACE INTO account_wallets` lets any Nostr key re-point its wallet whenever it likes. Vouchers go to any Nostr key that signs a request. Add rate limiting per IP and per key, and an admission policy hook (allowlist, invite code, proof-of-work). Make the policy explicit in config.

---

## P2: code quality and smaller bugs

1. **Readability is the biggest long-term problem.** There are about 80 lines over 160 characters in `src/`, many statements per line, and 200-character conditionals (for example `service.js:30-33`, `mesh.js:75-76, 113-116`, `api.js:11-16`). Nobody can review payment code that looks like this. Run Prettier (printWidth 100) plus ESLint (`eslint:recommended`, `no-floating-promises` via typescript-eslint) once, as a separate commit with no behavior changes.
2. **Add types.** Convert to TypeScript, or at least `// @ts-check` with JSDoc typedefs for `Job`, `Route`, `WorkerAdvert`, `Payment` and `Receipt`. Wire `tsc --noEmit` into `npm run check`.
3. **Model selection is implemented three times,** each with slightly different rules: `hardware.js recommend()`, `contribution.js chooseContribution()`, and the candidate filter at `service.js:83`. They differ in reserves (4 GB vs `UNIFIED_RESERVE_GB`), in whether `MODEL_MEMORY_FACTOR` is applied (`contribution.js:16` applies it, line 17 doesn't), and in CPU caps. Merge them into one pure `planModel(hardware, level)` with table-driven tests.
4. **`Service` is a god object** of about 230 lines, mixing setup state machine, routing, payments, metrics and the SQLite schema. Split it into a `ModelManager` (install/load/fallback state machine), a `Coordinator` (route → pay → dispatch → settle), a `Worker` (accept → verify → run), and a `Store` (all SQLite schema and migrations in one place; right now tables are created ad hoc in `service.js:26-36`).
5. **Out-of-memory detection is a regex** over error text (`service.js:97`). Ollama messages change. Match on structured error codes where they exist, and treat *any* load failure on a candidate as "try the next smaller one", capped to N attempts.
6. **The API matches `req.url` exactly** (`api.js:28-57`), so `/v1/models?foo=1` returns 404. Parse with `new URL(req.url, base)` and match on `pathname`. NIP-98 must still bind the full URL.
7. **The `/v1/routes/preview` maxTokens default** is duplicated in 3 places (`api.js:55,67` and `chat-request.js:43`). Move it into `validateJob` only.
8. **The README says the SQLite ledger is "used only by isolated compatibility tests"** (README ~line 106), but `service.js:191-194` uses it in production for self-served requests. Either remove self-service debits (they net to zero anyway) or fix the README.
9. **Dead code from the removed social layer:** `src/browser/storage.js` still creates `records` and `outbox` stores. `creditPrice: 1` in `service.js:136` and the `PRICE` naming in the contract are leftovers. `mesh.js rankWorkers()` duplicates router logic and ignores the chosen model's per-model metrics; have `execute()` dispatch to `route.worker` directly.
10. **`asarUnpack: node_modules/**/*`** turns off asar for all dependencies. Unpack only native modules.
11. **Electron `onDelta`, `onProgress` and `onRoute`** add listeners and never remove them. Return an unsubscribe function.
12. **Cancellation edge case:** `service.js:213`. If the client disconnects after the final token but before settle, `signal.aborted` throws and the worker gets refunded instead of paid. Once the worker reports `done`, treat the job as delivered.
13. **Energy metering** counts the whole GPU board power, including other apps. Show that clearly in the UI and offer "subtract idle baseline", sampled when no inference is running.
14. **`npm run check`** only syntax-checks. Make it lint + typecheck + `solc` compile + `npm test`.

---

## Test gaps to close

Add tests for every P0 and P1 item above, plus:
- Mesh chaos: worker disconnects mid-stream, coordinator disconnects mid-stream, a slow consumer with backpressure, malformed frames, an oversized line, a replayed hello older than 60 s, a hello whose handshake hash doesn't match.
- Payments: RPC down at startup, a reorg or dropped tx (tx never mined), nonce gaps, an expired escrow, worker and coordinator on different chain IDs.
- Contract: Foundry-style fuzz/invariant tests run on the JS EVM. Invariants: total locked = sum of active jobs; a job moves state at most once; only payer, worker or coordinator can receive funds.
- Router property tests: never route to a busy, stale or untrusted worker; price stays within [1, 3]; the quotes computed by coordinator and worker are always identical (one shared function, with a test that checks they match).
- An end-to-end test with 2 real `Service` instances over Hyperswarm with a local DHT bootstrap (`hyperdht` testnet), not mocks.
- Coverage: `node --test --experimental-test-coverage` in CI, with a coverage floor on `payments.js`, `mesh.js` and `service.js`.

Add CI: a GitHub Actions matrix on windows, macos and ubuntu running `npm ci && npm run check && npm test`.

---

## Roadmap: what makes it a real product

Do these after P0/P1 are fixed. In priority order:

### R1. Payments that don't block inference
Replace lock-per-request with **one deposit plus off-chain signed debits**:
- The payer deposits N LLMESH into the escrow once.
- Each request carries a payer-signed EIP-712 voucher with a cumulative amount, `(channelId, cumulativeAmount, nonce)`.
- The worker or coordinator redeems the highest voucher whenever it likes (batched, e.g. hourly or above a threshold).
- The payer can withdraw unspent funds after a timeout. This is a standard unidirectional payment channel.

The result is zero chain transactions on the request path, one tx per channel open/close, and workers can claim their own pay without trusting the coordinator, which fixes P1-1 as well. Keep the old escrow behind a flag only if something depends on it.

Also make the price **per token, metered after the fact,** with a pre-authorized cap, instead of a flat quote of 1–3. Base the quote on the max-token budget and charge actual `eval_count` up to that cap.

### R2. Real mesh membership instead of environment variables
- "Create group" generates a group secret and shows an invite code or QR containing the topic secret plus the coordinator pubkey.
- "Join group" imports it. Members are then managed in the UI (approve, revoke, label, see last seen), stored in SQLite.
- Drop `LLMESH_WORKERS` and `LLMESH_COORDINATORS` env vars as the main interface (keep them as overrides).
- Show per-peer health in the UI: RTT, tokens/s per model, error rate, last error, models served.

### R3. A better scheduler
- Queue instead of failing: when every capable worker is busy, queue up to a deadline rather than throwing `No idle trusted node`. Add per-request `priority` and `deadline`.
- Allow concurrent requests per worker: Ollama can handle several (`OLLAMA_NUM_PARALLEL`). Advertise `slots` instead of a boolean `busy`.
- Retry on another worker: if a worker fails before its first token, retry on the next-best worker without charging.
- Replace the keyword complexity heuristic (`router.js:7-24`) with a pluggable classifier. Options: a tiny local model call on the smallest loaded model, embeddings + kNN, or stick with heuristics but log `(prompt features → model used → user regenerated?)` locally so it can be tuned. Always honor an explicit `model`.
- Use speculative or "race" routing for very short requests: send to the two best workers and cancel the slower one after its first token. Only allowed when payment is metered (R1).

### R4. A wider API surface
Most tools people would point at this need:
- `/v1/embeddings` (Ollama supports it).
- `/v1/completions` (legacy).
- `temperature`, `top_p`, `seed`, `stop`, `presence/frequency_penalty` and `response_format: json_object/json_schema` (Ollama `format`), all passed through. Right now they're silently dropped.
- `n=1` explicitly rejected with a clear error. Correct `usage` in non-stream responses.
- Image inputs for vision-capable Qwen models (currently rejected in `chat-request.js:9`).
- Optional LAN mode: bind to a LAN interface with TLS (self-signed cert plus a pinning instruction) so other devices in the house can use the endpoint. Keep it off by default.
- An Anthropic-compatible `/v1/messages` shim, if coding tools are a target.

### R5. Model management
- Pin models by digest in `models/catalog.json` (the README lists this as release work). Verify after `pull`.
- Let advanced users pick or override the model, and serve more than one model per node if memory allows.
- Benchmark on first install: run a fixed prompt, record first-token time and tokens/s, and advertise *measured* numbers instead of `fallbackFirst` guesses (`router.js:30-34`).
- Keep catalog updates out of the app release cycle: a signed catalog fetched from a URL, verified with a pinned key.

### R6. Product and UI
- First-run wizard: detect hardware, choose a level, install, run a test prompt, then show "here's your endpoint" and "invite a machine".
- The companion chat should render Markdown and code blocks, support conversations, and stream tool calls.
- Wallet page: plain-language status ("You have enough to make ~N requests"), a clear "you need ETH for gas" state (or remove it via P1-9), and a job history with explorer links.
- Notifications for "worker came online/offline" and "settlement failed — retrying".
- Settings page instead of environment variables for port, topic/group, RPC, energy and autostart.
- Auto-update (`electron-updater`) and code signing. The README lists both as release work.
- Backup and restore for identity, wallet and API key as one encrypted export file. Without it, losing app data loses funds; the README already warns about this.

### R7. Observability
- Structured logs (pino) with request ids that flow coordinator → worker → back. Add a "Copy diagnostics" button that redacts keys.
- Local metrics page: requests/min, p50/p95 time to first token per worker and model, failure reasons, settle backlog.

---

## Suggested order of commits

1. Prettier + ESLint + `@ts-check` (formatting and types only, no behavior change).
2. P0-1, P0-2 and P2-12: deliver/settle split and background settlement.
3. P0-4 and P1-5: mesh busy handling and pubkey indexing.
4. P0-5 and P0-6: startup robustness.
5. P1-3, P1-4 and P1-6: mesh handshake gating, group topic, protocol version.
6. P1-7 and P1-8: secret handling.
7. P2-3 and P2-4: unify model planning and split `Service`.
8. CI and the test gaps.
9. R1 (payment channels plus metered pricing), which also resolves P0-3, P1-1, P1-2 and P1-9.
10. R2, then R3, R4, R5, R6 and R7, as separate PRs.
