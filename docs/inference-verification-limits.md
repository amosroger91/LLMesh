# Inference verification limits

Updated 2026-10-28. This describes the checks that exist. It is not a claim that a worker's answer is correct.

Payment is computed by the ledger from reported token counts and the model rate. An LLM does not calculate or authorize a payment.

## What is checked

A mesh worker that claims output tokens must already have sent non-whitespace text or a tool call on that request. A prompt-token count above the reserved context is rejected. Counts must be integers inside the reserved output cap and the global context cap. The request fails and the peer stays connected. The coordinator cancels an unpaid reservation when the attempt does not complete.

A completion is settled once. A second settle of the same reservation does not pay again. Cancel, disconnect before completion, and process restart refund an open reservation. A later request may choose another worker. That is a new reservation, not a replay of the failed one.

Signed credit receipts are accepted only for work the worker already expected, from the signing coordinator, with a newer sequence. An identical replay is ignored. A forged or conflicting receipt is rejected. The receipt does not add spendable credits on the worker's own ledger.

## What is not proven

The coordinator does not re-tokenize the prompt with the worker's tokenizer. A short delivered string can still accompany a token count up to the reserved cap. The host that runs the model can read the plaintext prompt. Encryption on the peer channel protects the bytes in transit. It does not make that host unable to see the prompt or the activations it computes.

A receipt means this coordinator accepted this usage report. It does not prove the answer was correct, and a trusted coordinator can still overstate the balance it reports. Promotional or otherwise unbacked credits are not a withdrawal balance. No production funding proof or cash-out is implemented here.

`src/core/distributed/chain.js` is a fake block planner. It can split one test charge across span hosts. It does not run a model, move tensors, or prove an answer. A real chain would have the same limit: the span that sees token inputs can read the prompt, and later spans see activations. That runtime is still only a plan in `PLAN_DISTRIBUTED_MODELS.md`.
