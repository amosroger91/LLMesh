# LLMesh implementation log

Last updated: 2026-10-28. This is the working record for the current implementation, not a claim that every planned feature is complete.

## Goal

Make LLMesh open directly into a usable AI Companion, automatically contribute native inference, prefer idle local hardware, and let people earn and spend inference credits without signup or mandatory blockchain fees. Preserve an optional, explicitly approved path to Base settlement and future cash-out.

## Owner decisions

- AI Companion is the desktop startup page; model setup and serving start automatically.
- Companion prefers an idle native model. When occupied or incompatible, use another eligible hardware worker. Never use donated API allowances for Companion.
- Worker graphs show measured average throughput, capability tiers, model inventory, and actual traffic; do not invent activity.
- Normal and explicitly opted-in abliterated models may coexist. Abliterated serving defaults off and requires an exact model ID plus caller opt-in.
- Everyday credits are free and issuer/coordinator scoped. Base settlement is optional. Do not imply that local balances form a globally settled cryptocurrency.
- Latest economic rules supersede the previous 100,000-credit starter amount: **10,000 starter credits per legitimate new user**.
- No LLMesh percentage fee: spending 500 credits on inference pays the provider all 500.
- Earned balances do not expire just because they are held.
- Contributors can opt into Earn Priority scheduling.
- Internal transfers have no network fee. Withdrawals are optional and require a review showing amount, actual/estimated network costs, and net proceeds.
- Starter grants are not automatically cash-backed or withdrawable. Withdrawal eligibility must preserve provenance and prevent self-service or starter-credit recycling from creating cash claims.
- Base gas is paid in ETH. Do not claim that deducting LLMESH automatically funds gas. A user-funded ETH wallet or a funded, priced, supported sponsor is necessary.
- Keep real-money withdrawals disabled until gas funding, backing, and liquidity are solved. No guaranteed cash value or exchange listing.
- Update README and push finished changes. Verify through scripts, local APIs, and hidden test-owned windows; do not control the user's mouse/keyboard.

## Completed and checked

- Startup benchmarks for native/browser workers; time-weighted average output speed and first-token latency; observed measurements inform routing.
- Desktop, web, and phone-awake graphs show throughput/capability ranks and loaded-model counts.
- Separate normal and CPU abliterated runtimes. Real concurrent 4B inference, completed SSE, explicit opt-in rejection, and normal-worker survival after secondary shutdown tested.
- Repository-backed browser weights/WASM verified: 36 complete assets, 908,219,779 bytes. Native vault completed: 31 pinned assets, 35,604,222,287 bytes, with checksummed release chunks.
- Privacy/runtime/abliterated controls moved into Settings.
- Companion-first desktop startup and local-native preference with busy-worker fallback.
- Desktop and headless CLI free-credit mode; optional Base mode; automatic local identity/starter account.
- Coordinator debits/refunds/worker credits; signed earnings receipts over the authenticated encrypted mesh; acknowledgements and durable retries. Receipts do not duplicate money in another issuer's spendable ledger.
- 113 Node tests passed, plus lint, type checks, hidden Electron smoke, builds and a real local 4B HTTP response.
- GitHub Pages deployed successfully for the preceding implementation.

## Current work

1. Apply the finalized economic rules above. Audit grant amounts, provenance, transfers, withdrawal eligibility, and self-service before exposing cash-out controls.
2. Add Earn Priority without bypassing privacy, capability, context, availability, or model opt-in constraints.
3. Add reviewed internal transfer and withdrawal flows, with real-money settlement disabled by default.
4. Test accounting invariants and withdrawal paths; attempt an actual Base Sepolia check only when funded test infrastructure is available.
5. Refresh README, test record, and this log; push the completed changes and verify CI/deployment.

## Verification and constraints

- Rust formatting failure found in CI has been fixed locally with `cargo fmt --all`; `cargo clippy --workspace --all-targets --locked -- -D warnings` passes.
- Windows Application Control blocked execution of one freshly compiled Rust test binary (OS error 4551). Compilation succeeded; use CI runners for complete Rust execution rather than weakening system-wide security.
- A real Base Sepolia withdrawal requires deployed funded test contracts and ETH gas. No live withdrawal or gas purchase has been performed.
- Issuer-scoped balances are not globally transferable or guaranteed redeemable. A coordinator cannot safely promise cash-out of unbacked promotional grants merely because it signs an inference receipt.

## Next milestone

A tested, clearly labeled internal economy with 10,000-credit grants, full provider payouts, safe fee-free transfers, contributor priority, and an opt-in testnet withdrawal path. Real-money withdrawals remain disabled until their funding/backing requirements are met.

## Agent coordination — 2026-10-28

Created `AGENT_COORDINATION.md` at the owner's request. It introduces this agent, explains project/economy understanding, lists the active dirty files and unfinished interfaces, and records the two current stale-balance test failures. The new ledger provenance/transfer/withdrawal-hold draft is not yet release-ready; no live withdrawal has occurred. Other agents can append their identity, ownership, and progress there before overlapping edits.

## Confirmed agent agreement — 2026-10-28

Grok replied, proposed a distinct slice, and explicitly confirmed the ownership proposal in `AGENT_COORDINATION.md`. Codex accepted it in writing. Codex owns economic accounting/grants/transfers/withdrawals, affected economic tests, API/service/router/UI/CLI integration, README and this work log. Grok owns mesh completion validation in `src/core/mesh.js`, `test/mesh-economy.test.js`, and `docs/inference-verification-limits.md`. Codex will wait for Grok's explicit release of mesh files before implementing Earn Priority metadata there. Both agents agreed to stage only their own completed files/hunks and not reset or commit the other's WIP. This agreement does not mark the incomplete economic implementation or its tests as finished.

## Distributed-model planning started — 2026-10-28

Owner requested joint Codex/Grok planning for Petals. Created `PLAN_DISTRIBUTED_MODELS.md` as a reviewed-source starter proposal and appended the invitation/questions to `AGENT_COORDINATION.md`. Scope: optional distributed-block backend, Python/native compatibility spike, explicit Qwen adapter gate, trusted membership/privacy, complete-model coverage and cache/failure semantics, measured latency, conserved multi-worker payouts, and phased correctness/E2E gates. Awaiting Grok's critique; no Petals installation or inference implementation has occurred. Existing ledger WIP and mesh ownership remain unchanged.

## Economy implementation progress — 2026-10-28

Implemented remaining-grant provenance, the 10,000-credit new grant, fee-free idempotent earned-credit transfers, and atomic `Ledger.settleMany()` payouts. Starter credits cannot transfer/withdraw; paid work retains backed/unbacked status; self-service does not manufacture earnings or backing. Existing balances remain spendable, with conservative transfer eligibility for legacy balances whose provenance is unknown. Added targeted invariant/restart tests; eight ledger/migration tests pass, including tiny remainder conservation. Fixed the two stale starter assertions. Released the multi-host settlement interface to Grok in the coordination log. No funding verifier or public withdrawal broadcaster is exposed yet.

## Delegation — 2026-10-28

At the owner's explicit request, delegated withdrawal safety tests, ledger invariant/migration tests, and independent Petals feasibility research to three agents. Each owns distinct new test/doc files only; no source edits or commits by them. Recorded the exact paths in AGENT_COORDINATION.md for Grok and other existing agents. Codex retains source integration, API/UI and fixes. Early review findings include stricter withdrawal quote/deposit-receipt validation and legacy-grant migration checks; fixes and verification are in progress.

## Owner-corrected named delegation — 2026-10-28

Owner specified Codex and OpenCode explicitly. Stopped the extra internal subtasks; retained their partial test drafts. Codex accepted ledger/economy/API/UI integration and migration/invariant fixes. Explicitly handed `src/core/withdrawals.js`, `test/withdrawals.test.js`, and optional withdrawal review docs to the actual OpenCode agent, with reproduced quote/calldata/deposit-hash defects and test/handoff criteria. Asked OpenCode to acknowledge under its own identity. Grok's distributed-model ownership is unchanged. Exact assignments and exclusions are in AGENT_COORDINATION.md.

## Copilot assignment correction — 2026-10-28

Owner noted Copilot had not received a task. Assigned the actual VS Code Copilot agent a read-only Petals/model compatibility checker (`scripts/check-petals-compatibility.js`), offline-focused tests (`test/petals-compatibility.test.js`), and sourced `docs/petals-runtime-feasibility.md`. It must distinguish supported/unsupported/unknown static metadata from tested runtime support, preserve Qwen architecture boundaries, and avoid any weights/installations. This does not overlap Grok's mock chain, OpenCode's withdrawal files, or Codex's economy integration. Requested explicit acceptance and file-only handoff in AGENT_COORDINATION.md.

## Progress check and next named assignments — 2026-10-28

Independently reran withdrawal and ledger adversarial tests: 25 passed, four ledger tests failed. OpenCode's 20 withdrawal tests pass; its completed module is handed back for integration review. Assigned OpenCode separate HTTP economy security tests/review, confirmed Copilot's actual acceptance and offline checker handoff gates, and clarified Grok's exact distributed planner/test paths and mock session acceptance criteria. Codex retains ledger fixes and product integration. No new internal subagents, live gas transactions, or desktop input control. See AGENT_COORDINATION.md for exclusive files and deliverables.

## Third named-agent round — 2026-10-28

Read all three completed handoffs and independently verified 37 tests across API security, distributed-chain mock, and Petals checker. Assigned OpenCode the four ledger regressions and related accounting headroom/migration fixes (explicit exclusive ledger handoff); Grok bounded dynamic planning and exact payout arithmetic; Copilot a disabled-by-default JSON-lines sidecar health/lifecycle manager with offline Node-child tests. Codex retains product integration and combined checks and will avoid all delegated source paths. These tasks are recorded with exact paths and acceptance criteria in AGENT_COORDINATION.md. No real distributed inference or live withdrawal is claimed.
