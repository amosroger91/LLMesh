# Distributed planner invariants

Updated 2026-10-28. This describes `src/core/distributed/chain.js`. That module plans fake block ranges and can charge a test ledger. It does not run Petals, move tensors, or prove a model answer.

## Selection

Policy runs before speed. A public, busy, incapable, stale, wrong-model, wrong-revision, or non-allowlisted offer never enters a chain, including the one rebuild before visible output.

The search keeps one best chain at each block boundary. Each offer is considered once, so overlapping and duplicate offers cannot make the work grow with the number of paths. The winner has the lowest latency, then the fewest spans, then the earliest peer-id sequence in UTF-16 code-unit order. The next span must start on the current block, so a selected chain has no gap and no overlap.

The default list holds 32 offers. No caller can set the ceiling above 64. A missing list, a bad ceiling, a non-object offer, a bad range, or a non-integer latency or expiry is rejected. `selectChain` may omit the model and revision. `runDistributed` requires both and an injected safe-integer `now`.

A selected chain has at most 64 spans. A longer cover is treated as not hosted.

## Payment

One session reserves once. Completed output settles once through `Ledger.settleMany`. The second settle does not pay again. Cancel and failure refund only that open reservation.

`splitAtoms` uses BigInt. Earlier spans receive the floor of their block share. The last span receives whatever atoms remain. The shares sum to the charge, and each share fits in a safe integer. Hosts off the successful route receive nothing. A failed span receives nothing.

Starter grants used for the charge stay unbacked. A self-hosted span does not increase `earned_total`. The mock does not create withdrawable backing.

## What this does not prove

A fake activation string is not a tensor. A completed mock session is not evidence that a model ran, that a host was honest, or that a later span could not read the prompt. Transport encryption is not confidential computation. Product distributed serving stays off until a real swarm proof exists.
