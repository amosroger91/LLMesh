# LLMesh — shared agent introduction and coordination

Updated: 2026-10-28 (America/Chicago).

## Hello from the agent in this chat

Hi! I am Codex, the agent handling this conversation with Roger. My tool role within this conversation is `/root`; that name is local to this conversation, not a claim of authority over your work. We are editing the same checkout at `C:\Users\roger\dev\LLMesh`, currently on `main`.

Roger asked me to introduce myself here, explain my understanding of the project, and describe my work in detail. Please use this file to introduce yourself and record which files/features you are editing. `WORK_LOG.md` is my ongoing decisions, goals, progress, and verification record.

## My understanding of LLMesh

LLMesh is a people-owned inference network. A desktop Node.js/Electron app detects hardware, automatically selects and loads a suitable Qwen model, contributes idle compute, and exposes an OpenAI-compatible streaming endpoint. Web/phone clients contribute a smaller WebGPU model. A native Rust/WASM foundation and additional platforms are also in progress.

Requests should match capability, context, tool support, availability, privacy consent, and measured performance. Companion is a hardware-only interface to the same inference system: prefer an idle local native model, then eligible mesh hardware when it is occupied or incompatible. Donated OpenAI-compatible APIs can serve explicitly consenting API requests, but must never consume donated allowances for Companion.

The mesh visualization should represent actual connected workers and observed activity. It includes native/browser devices, API provider branches, readiness/busy/memory status, measured throughput, capability ranks, profiles, and loaded-model counts. Public discovery is not proof of a trusted, ready inference connection.

The economic purpose is to let someone contribute available compute now and spend earned inference credits later. Everyday use should require neither buying crypto nor paying network gas. Credits currently belong to the issuing coordinator; they are not a globally settled blockchain balance. Optional Base settlement and future cash-out must not be represented as already funded, liquid, or guaranteed.

## Latest owner decisions I am implementing

- Start automatically serving on desktop launch and open AI Companion first.
- Prefer idle local native inference for Companion; use eligible hardware elsewhere if local capacity is occupied. Preserve its no-donated-API policy.
- Automatically create the Nostr identity and local account without signup or wallet funding.
- **10,000 free starter credits for each legitimate new user.** This supersedes the earlier 100,000-credit amount for new grants. Preserve existing earned/spent balances rather than resetting accounts.
- **No LLMesh percentage cut.** If inference costs Alice 500 credits, Bob receives all 500. This refers to credit transfers; it does not by itself replace the existing model-dependent token rates.
- Add optional **Earn Priority** for contributors, without bypassing capability, privacy, context, availability, or explicit model opt-in requirements.
- Earned balances do not expire merely because they are unused.
- Internal credit transfers have no network fee.
- Optional withdrawal review must explain amount, network costs, and net proceeds. Keep real-money withdrawals disabled until backing, gas funding, and liquidity are solved.
- Base gas is paid in ETH. Deducting a token-denominated fee does not automatically fund ETH gas. Do not invent an exchange rate or silently spend a sponsor's ETH.
- Starter grants and self-service must not manufacture withdrawable earnings. Preserve backing/provenance when credits move.
- Update README and push finished changes. Use scripts, APIs, and hidden test-owned windows for E2E checks; do not control the user's mouse/keyboard.

## Completed work I have verified

- Native/browser startup benchmarks, observed average token speed, first-token latency, capability ranking, and graph model inventory.
- Normal and optional abliterated 4B models in separate resident runtimes. Abliterated serving is off by default and requires both an exact model ID and caller opt-in.
- Real simultaneous normal/abliterated inference, completed SSE, opt-in rejection, auto-routing exclusion, and normal-worker survival after secondary shutdown.
- Repository-backed browser assets: 36 verified complete files totaling 908,219,779 bytes, including weights/WASM. Native archive: 31 pinned assets totaling 35,604,222,287 bytes in the completed `model-vault-v1` release.
- Settings placement for privacy/runtime/abliterated controls.
- Companion-first startup, idle-native preference and busy-native fallback, free coordinator-credit mode, and optional Base mode.
- Encrypted-mesh signed issuer receipts, completed-work checks, acknowledgement/retry, and issuer-scoped earnings display without minting a duplicate local balance.
- The last completed full Node run before the current economic edits passed **113 tests**. Lint, type checks, hidden Electron smoke, UI/web builds, and a real local 4B HTTP request also passed at that point.
- Fixed Rust formatting after CI reported it. Clippy passed. Windows Application Control blocked execution of one compiled Rust test binary; do not weaken system-wide security to bypass it. CI runners can execute the full Rust suite.

Relevant commits include `23932fb` (worker metrics/direct runtimes), `c7d4397` (credits/startup and other shared-checkout work), and `b75d870` (work log/verification and Rust formatting). Please inspect Git rather than assuming these commits contain exclusively one agent's edits.

## What I am working on now — incomplete edits

### 1. New-user grants: 10,000 credits

Edited `src/core/pricing.js`, `contracts/LLMesh.sol`, and `rust/crates/llmesh-proto/src/lib.rs` to change the new starter amount. Started adjusting affected tests. Existing accounts must retain their balances. The legacy migration behavior needs verification against both old 100-credit and previously upgraded 100,000-credit databases.

### 2. Ledger provenance and fee-free transfers

The current uncommitted draft in `src/core/ledger.js` adds:

- `accounts.redeemable`: backed portion of the spendable balance, initially zero for existing/unbacked credits.
- `accounts.earned_total`: cumulative actual work earnings; self-served work should not increase it.
- `jobs.reserved_backed` / `spent_backed`: backing carried through reservations, actual usage, unused-budget refunds, and restart recovery.
- Promotional-first spending so promotional grants cannot become backed simply by circulating or serving oneself.
- Idempotent transfers scoped to payer plus transfer ID. The recipient gets the full amount and the recorded fee is zero. Receiving a transfer must not implicitly issue a starter grant.
- A funding-proof table to prevent duplicate funding credit. **The draft `fund()` method is internal accounting only; no production deposit-proof verifier or public funding endpoint exists yet. Do not expose it as an unauthenticated mint.**

### 3. Withdrawals — draft accounting only

The ledger draft adds withdrawal holds and cancellation/reverted-release states. Only backed credits may be held. Quoted withdrawals may be cancelled; signed/possibly broadcast withdrawals must not be refunded merely because an RPC request timed out.

**There is no completed withdrawal broadcaster, verified deposit path, confirmation/reconciliation loop, withdrawal API/UI, or actual Sepolia withdrawal yet.** Those must be implemented and tested before describing cash-out as working. Real-money withdrawals stay disabled. A funded Base Sepolia setup is needed for a genuine public-testnet transaction.

### 4. Earn Priority — planned, not implemented

I intend to persist an owner opt-in, advertise it to authenticated peers, and apply only a bounded scheduling preference among otherwise eligible candidates. It must not change provider payout rates or override Companion's local-first behavior. Settings, public metadata validation, router tests, and README still need updates.

## Current dirty files and test status

At this handoff, my in-progress source/test changes are in:

- `src/core/ledger.js`
- `src/core/pricing.js`
- `contracts/LLMesh.sol`
- `rust/crates/llmesh-proto/src/lib.rs`
- `test/browser-workers.test.js`
- `test/contracts.test.js`
- `test/core.test.js`
- `test/payment-flow.test.js`
- `test/self-service.test.js`
- `test/startup-credits.test.js`

The last targeted run was:

`node --test test/core.test.js test/self-service.test.js test/startup-credits.test.js test/usage-billing.test.js`

It had **15 passing and 2 failing tests**. Both reported stale expected balances after the starter reduction:

- `test/core.test.js:90`: actual `19995`, expected `199995`.
- `test/usage-billing.test.js:34`: actual `19986`, expected `199986`.

Those failures have not yet been fixed. This partial run does not validate the new transfer/provenance/withdrawal methods. They need invariant and integration tests. Do not treat the dirty source changes as release-ready or publish them as a completed economy.

## Coordination request

Please append your introduction, current goal, edited files, and any decisions from your conversation below. If you need to change the ledger, pricing, contracts, economic tests, or shared policy, leave a note here first so we can coordinate overlapping edits.

We have already observed overlapping commits in this shared checkout. Preserve each other's changes, inspect fresh diffs before editing/staging, and avoid broad `git add -A` while another agent has unfinished source changes. Stage completed files/hunks explicitly. Never reset or discard the other agent's work just to obtain a clean checkout.

## Other agent's introduction and current work

_Please append your update here._
