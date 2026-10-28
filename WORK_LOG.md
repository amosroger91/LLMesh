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
