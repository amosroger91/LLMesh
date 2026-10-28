# Plan proposal: distributed model execution with Petals

Status: **Billing and Privacy accepted. The fake-block planner is in `src/core/distributed/chain.js`. Petals runtime, Qwen, and membership proofs are still open.**
Date: 2026-10-28. This plan is not a claim that distributed inference runs. The planner is mock execution: fake block ranges, no tensors, no Petals process, and no model answer.

## Intended outcome

Let several LLMesh devices jointly execute one model that cannot fit on any single device. Keep whole-model local/browser/API workers as supported choices. Route each request according to capability, privacy, availability, and measured end-to-end latency. Preserve local-first hardware-only Companion behavior and existing abliterated opt-in boundaries.

Whole-request routing and model partitioning are different features: today one selected worker performs a whole request; the proposed backend would pass intermediate tensors through a complete chain of compatible model blocks.

## Evidence and initial constraints

- Petals exposes a distributed causal-LM client and partial-model servers. Its README describes Linux GPU setup and Windows through WSL. This is a Python runtime integration, not an npm-only replacement for Ollama or llama.cpp. [Upstream README](https://github.com/bigscience-workshop/petals)
- Investigated upstream revision: `22afba627a7eb4fcfe9418c49472c6a51334b8ac`. Its model registry includes BLOOM, Falcon, Llama, and Mixtral; Qwen is absent. A different checkpoint name is not enough to add a new architecture. [Pinned model registry](https://github.com/bigscience-workshop/petals/blob/22afba627a7eb4fcfe9418c49472c6a51334b8ac/src/petals/models/__init__.py), [custom-architecture guide](https://github.com/bigscience-workshop/petals/wiki/Run-a-custom-model-with-Petals)
- That revision pins Transformers 4.43.1, bitsandbytes 0.41.1, and a specific Hivemind commit. Establish a reproducible, audited dependency/driver matrix before integrating it into app installation. Do not silently upgrade its dependencies until it happens to install. [Pinned dependencies](https://github.com/bigscience-workshop/petals/blob/22afba627a7eb4fcfe9418c49472c6a51334b8ac/setup.cfg)
- Private swarm discovery can use explicitly configured initial peers; those peers are an availability dependency, not a database or proof of trustworthy computation. Identity binding and membership enforcement need independent validation. [Private swarm guide](https://github.com/bigscience-workshop/petals/wiki/Launch-your-own-swarm)
- Activations are not a privacy guarantee. Participating peers may recover inputs or alter results. Encryption protects links, not data from the compute participants. A private swarm still requires trusted participants. [Security/privacy guide](https://github.com/bigscience-workshop/petals/wiki/Security,-privacy,-and-AI-safety)

Everything below is a proposed LLMesh design, not a claim that upstream already supplies the integration.

## Proposed architecture

1. Add a backend identifier such as `petals` alongside whole-model backends. A local Python sidecar owns distributed sessions; the Electron/Node service owns user policy, bounded requests, API streaming, lifecycle, and accounting.
2. Keep model-block tensor traffic on the supported Petals/Hivemind transport. Do not proxy activations through the existing PeerJS star hub or turn the current mesh frame format into a tensor tunnel by accident.
3. Bind the sidecar control API to loopback with a per-process secret or an authenticated local IPC channel. Use an argument-array process launch, bounded frames, cancellation, owned-process shutdown, pinned artifacts, and health checks. No peer-supplied arbitrary Python/model code.
4. Give the LLMesh execution adapter a stable boundary so a later Rust backend can implement it without rewriting API/economy logic. Do not make a Rust Petals rewrite a prerequisite for the experiment.
5. Start on a private Linux/NVIDIA swarm with explicitly trusted participants. Windows/WSL, AMD, Apple, Android, and browser block hosting need separate evidence and packaging gates. Browsers can remain request clients and whole-model WebLLM workers in the meantime.
6. First prove distributed execution on one small, upstream-supported, non-gated checkpoint with verified redistribution terms. This is an engineering test, not a change to the normal desktop model policy. Qwen support is a separate adapter milestone.

## Required interfaces and metadata

Version these contracts before two agents implement their ends:

- **Model manifest:** exact architecture, source revision, weight/tokenizer/config hashes, quantization and dtype, total block count, embedding/output-head placement, license, and runtime protocol version. Normal and abliterated variants have different identities and may never share an assembly.
- **Shard advertisement:** LLMesh identity bound to runtime peer identity, manifest digest, served half-open block ranges, cache/context capacity, concurrency, measured block throughput, latency/bandwidth observations, availability and expiry. Clearly separate claimed from observed metrics.
- **Assembly:** complete ordered coverage of required blocks and endpoint components, compatible revisions/dtypes, selected replicas, availability, and a pinned session route. Do not advertise a routable full model merely because its first block is online.
- **Session:** request/attempt ID, manifest/route digest, reservation, participant allocations, context/output limits, deadline, cancellation, KV-cache handles, progress and final authoritative usage. No prompt, activation tensor, or secret in public presence metadata.
- **Stream:** text/tool deltas, backpressure, explicit completion, observed usage and bounded errors. Tool support must be self-tested for that exact model/template, not inferred from upstream model size.
- **Execution abstraction:** health, capabilities, load/host, open session, generate/stream, cancel, close, and inspect telemetry. Sidecar liveness is not equivalent to complete-model readiness.

## Latency and routing

- Benchmark prefill, time to first token, decode throughput, link RTT/bandwidth, and cache pressure separately. Shard tokens/s alone does not predict chain performance.
- Prefer contiguous blocks on fewer fast links; compare LAN and WAN measurements, batch sizes, and tensor transfer overhead. Do not sum GPU memory and assume linear speed or that arbitrarily many phones make a fast pipeline.
- Assemble enough memory for weights **and** KV cache, runtime workspace, embedding/head work, and concurrent sessions. Define memory-pressure admission without changing existing local-model policy implicitly.
- Compare measured whole-model and assembled-model completion estimates within the required capability/privacy constraints. Tiny requests should not incur distributed pipeline overhead unnecessarily.
- Hold a session's block placement stable. Replacement replicas need compatible cache reconstruction or documented replay; hot failover is not automatically safe or free.
- Never silently restart a request after emitted user-visible output or bill replay as newly delivered work. Define deadline, partial-delivery, and refund behavior explicitly before enabling paid distributed sessions.

## Economy contract

The Billing section below is the accepted contract. The mock planner calls `Ledger.settleMany` inside its own tests. That does not turn distributed serving on. Product sessions stay unbilled until a real swarm proof exists and the phase-4 checks are the product path.

The requester pays **one** model-level budget for input/output usage, not that budget once per block server. Providers collectively receive the full final charge; LLMesh has no percentage cut.

Before dispatch, reserve the total and pin a deterministic allocation among actual compute contributors. The allocation must include any paid embedding/output-head contribution and use documented manifest/work weights, not self-reported contribution labels or an unbounded host-reported duration. Conserve integer accounting units with deterministic remainder assignment:

`sum(provider payouts) == requester final charge <= reserved budget`

A signed final settlement identifies the request attempt, manifest/route, exact payees, allocation, usage, and issuer. Prevent duplicate payouts for replicas, retries, repeated ranges, and replayed receipts. Propagate backed/unbacked provenance across the split; starter grants or self-dealing must not manufacture cash-out eligibility. Merely advertising a shard or claiming tokens earns nothing.

An activation-step receipt is not cryptographic proof of correct model execution. The first paid milestone remains a trusted-swarm design with explicit verification limits. Initial transport/proof-of-concept runs can be unbilled; do not enable paid split settlements until conservation, idempotency, cancellation, and failure tests pass. Partial-failure compensation remains an open decision rather than an invented guarantee.

## Implementation phases and acceptance gates

Phase 0 and phase 1 are not done. `src/core/distributed/chain.js` and `test/distributed-chain.test.js` pin coverage and settlement behavior with fake blocks. They do not satisfy the phase-1 proof. Copilot's static checker is separate and does not set `runtimeTested`.

| Phase | Deliverable | Gate before proceeding |
| --- | --- | --- |
| 0: feasibility | Pin runtime/dependencies; compare Petals reuse vs a compatible extension; license/checkpoint and hardware matrix; identify client-local memory requirements. | Clean reproducible installation and documented blockers; explicit Qwen compatibility findings. |
| 1: real private-swarm proof | Two workers host distinct required block ranges of the same small model; one client streams a real answer. | Numerical block/logit comparison to a local reference within stated tolerance; actual block placement and model hashes recorded. One full-model server pretending to be distributed does not pass. |
| 2: LLMesh adapter | Authenticated sidecar lifecycle, manifest and assembly health, OpenAI streaming adapter, cancellation/context limits, diagnostics. | Existing whole-model path remains usable; incomplete coverage is excluded; no untrusted remote-code execution. |
| 3: placement and resilience | Capacity planner, replicas, measured chain routing, session/cache policy and real graph assembly view. | LAN/WAN latency and memory tests, node loss, stale/mixed manifests, missing middle blocks, cancellation/backpressure; no hidden replay after streaming. |
| 4: split accounting | One reserve and conserved provider allocations with signed settlement and provenance. | Multi-provider conservation, duplicate/forged reports, crash recovery, insufficient balance, no pay for invented work; no unintended withdrawal eligibility. |
| 5: Qwen | Add and validate the exact intended Qwen architecture, cache semantics, quantization and tool template. | Reference correctness and multi-node inference for the pinned Qwen revision. Investigate hybrid/recurrent/MoE cache differences rather than assuming a Llama adapter works. |
| 6: packaging/platforms | Opt-in automatic provisioning for demonstrated native targets; browser request UX; model/runtime backup strategy. | Repeatable installation, update/rollback, reproducible downloads/licenses and automated no-mouse E2E. Browser/phone block serving is a separate runtime-port project unless demonstrated. |

Performance reports must name hardware, model revision, quantization, token/context counts, link conditions, concurrency, first-token latency and sustained decode speed. No blanket claim that distributed execution is faster than local inference.

## Planning ownership

Accepted file split. Do not edit another owner's files without a handoff.

- **Codex:** economy, API, router, service, desktop UI, contracts, Rust proto, README, and WORK_LOG. `Ledger.settleMany` is the multi-host payment API. Codex does not edit the planner while this split holds.
- **Grok:** `src/core/distributed/chain.js`, `test/distributed-chain.test.js`, and this plan's status. `bfb09f2` first landed the suite as `test/distributed-models.test.js`. That file is gone so there is one suite. Mesh completion checks were released after `377ce17`.
- **VS Code Copilot:** `scripts/check-petals-compatibility.js`, `test/petals-compatibility.test.js`, and `docs/petals-runtime-feasibility.md`. Those files stay out of routing.
- **OpenCode:** economy API security tests and the withdrawal adapter already handed to Codex. Not part of the distributed runtime.

The mock calls the real ledger `reserve`, `settleMany`, and `cancel`. It does not add a second ledger. A recorded split is not a product payout until `settleMany` runs, and the mock's test payouts do not create backing or cash-out eligibility.

## Joint decisions

Accepted:

- An optional pinned Python sidecar on a private Linux/NVIDIA swarm is the first runtime boundary. Whole-model routing stays the default. The distributed option defaults off. Companion and hardware-only requests stay on one machine.
- Tensor traffic stays on Petals/Hivemind. It does not enter the LLMesh mesh frame protocol.
- The phase-1 checkpoint hypothesis is `bigscience/bloom-560m`, with `TinyLlama/TinyLlama-1.1B-Chat-v1.0` as fallback. Record the license before any download. Qwen is a later milestone. The pin is `22afba627a7eb4fcfe9418c49472c6a51334b8ac`. Current GGUF and WASM Qwen weights are not assumed usable.
- Membership is a Nostr-signed binding of the Hivemind peer id plus an allowlist. `initial_peers` is discovery, not membership. The planner drops public, busy, incapable, stale, wrong-model, wrong-revision, and non-allowlisted offers before it ranks speed.
- One model-level charge. `sum(provider payouts) == requester final charge <= reserved budget`. No LLMesh cut. Weights are manifest block counts. Integer division leaves the remainder on the last paid span. Example: 10 atoms across spans of 1, 2, and 1 block pays 2, 5, and 3. Replicas and ranges off the successful route get nothing. Advertising a span pays nothing.
- Launch failover is one rebuild inside the same unpaid reservation before any user-visible output, and only while a full allowlisted cover remains. After any user-visible delta, or if coverage is gone, terminate and cancel. Do not start another paid attempt for that request. No KV-cache migration at launch.
- The Billing and Privacy sections below are the accepted contracts. `earned_total` increases only when a share is paid to a different Nostr account. Self-served shares restore original provenance. Starter grants are not backing.

Still unresolved:

- No Linux/NVIDIA pair is allocated. This Windows checkout is not the phase-1 proof. One full-model server pretending to be distributed does not pass.
- Qwen is absent from the pinned registry. A matching label is not support.
- The supply chain must pin the commit. Do not install floating Petals main.
- Activations are not a privacy guarantee. Receipts accept a usage report. They do not prove correct execution. Transport encryption is not confidential computation.
- Tensor transport, NAT, and real latency are unmeasured.
- A failure after visible output refunds the open reservation. Any later partial pay needs its own policy.
- A public swarm, `health.petals.dev`, a 405B download, and CUDA in CI are out of launch.
- `runtimeTested` stays false until a real two-process run says otherwise.

## Billing

Codex-reviewed contract for the mock and eventual ledger integration:

- New grants are `STARTER_CREDITS` (10,000 credits), stored as `STARTER_CREDITS * CREDIT_SCALE` integer atoms. Existing balances are preserved; tests import the constants.
- There is one model-level charge per completed sequence, not a complete charge per block host. Provider allocations conserve atoms exactly and LLMesh takes no percentage fee.
- Spend promotional/unbacked balance before backed balance. `redeemable` is the backed subset; starter grants have no backing. Promotional provenance must survive reservations/refunds and cannot become withdrawable by changing hosts.
- Settle only after an accepted completed sequence with delivered text/tool output and bounded usage. A mock or signed usage receipt does not prove correct inference.
- Each actual payee receives its assigned share. Backed atoms are divided within those shares with exact conservation; unbacked atoms cannot increase a host's `redeemable` balance.
- `earned_total` increases only for a share paid to a different Nostr account from the payer. Self-served shares restore their original provenance without converting grants to earned/backed funds. Distinct Nostr keys alone do not prove distinct humans or rule out collusion.
- Duplicate settlement must not pay again; cancel/restart refunds only an open reservation. A completed final settlement is not refunded because receipt delivery or a client connection subsequently fails.
- Direct transfers cannot spend the remaining promotional grant. Legitimate work earnings can be transferred without a network fee, while keeping backed/unbacked status separate.
- Codex will provide `Ledger.settleMany(id, allocations, usedAtoms)`, where each allocation is `{worker, atoms}` and the sum equals `usedAtoms`. Use `settle()` for a single host until that method is available; a recorded split alone is not a claim that multiple hosts have actually been paid.
- A failed chain initially refunds the uncompleted attempt and pays no unverified span allocation. Do not replay after visible output. Any future partial-work compensation needs its own agreed policy and bounded reservation.
- Internal funding helpers are not a public mint. Paid distributed sessions and withdrawals remain gated on their respective accounting/funding checks; this mock creates neither backing nor cash-out eligibility.

## Privacy

Codex-reviewed policy:

Distributed execution sends model inputs beyond the caller's machine. A token-input host can reconstruct the prompt, and activation hosts may recover information or alter results. Link encryption is not confidential computing. Do not label later spans as unable to read private data.

All chain participants must be authorized for the request's trust/privacy policy. Mesh-only means trusted LLMesh participants; public Petals servers and donated API relays must not enter that route silently. The initial experiment uses a private membership policy. Merely using a private bootstrap/DHT address is not sufficient authentication or membership enforcement.

The planned distributed request option defaults off. Companion/hardware-only routes remain outside this experimental chain path at launch. A proposed `local_only` option must be implemented and tested before the UI claims such a mode exists; it must exclude every remote hop. Current mesh-only privacy is not equivalent to local-only execution.

Name every selected participant in the route and final receipt. Public discovery/graphs expose only bounded model/span/health/performance metadata, not prompts, activations, caches, account secrets, or private keys. Only approved fixed model operations execute on a span host, with resource/frame limits and no arbitrary peer-supplied code.

