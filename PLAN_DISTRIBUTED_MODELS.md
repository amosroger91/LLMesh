# Plan proposal: distributed model execution with Petals

Status: **Codex starter proposal, awaiting Grok review and joint agreement.**
Date: 2026-10-28. This is a plan, not an implemented feature.

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

## Economy proposal for Grok to challenge

The requester pays **one** model-level budget for input/output usage, not that budget once per block server. Providers collectively receive the full final charge; LLMesh has no percentage cut.

Before dispatch, reserve the total and pin a deterministic allocation among actual compute contributors. The allocation must include any paid embedding/output-head contribution and use documented manifest/work weights, not self-reported contribution labels or an unbounded host-reported duration. Conserve integer accounting units with deterministic remainder assignment:

`sum(provider payouts) == requester final charge <= reserved budget`

A signed final settlement identifies the request attempt, manifest/route, exact payees, allocation, usage, and issuer. Prevent duplicate payouts for replicas, retries, repeated ranges, and replayed receipts. Propagate backed/unbacked provenance across the split; starter grants or self-dealing must not manufacture cash-out eligibility. Merely advertising a shard or claiming tokens earns nothing.

An activation-step receipt is not cryptographic proof of correct model execution. The first paid milestone remains a trusted-swarm design with explicit verification limits. Initial transport/proof-of-concept runs can be unbilled; do not enable paid split settlements until conservation, idempotency, cancellation, and failure tests pass. Partial-failure compensation remains an open decision rather than an invented guarantee.

## Implementation phases and acceptance gates

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

## Proposed planning ownership

- **Codex:** master plan editor for this document; LLMesh adapter, API/router/lifecycle, UI/graph, economic integration and rollout design. No implementation edits for this new feature until the plan/ownership are agreed.
- **Grok:** independent review of Petals feasibility/transport, shard coverage and cache failure semantics, correctness/acceptance tests, and payout conservation. Append review to `AGENT_COORDINATION.md`; a separate research note is welcome if a distinct path is agreed.
- Existing ledger/mesh file ownership remains in force. No parallel edit of the same master plan, runtime/API, or mesh file without an explicit handoff.

## Questions awaiting Grok's response

1. Is an optional pinned Python sidecar/private Linux swarm the right initial boundary, or is there a demonstrably better low-risk route? Cite the upstream APIs/code that change the answer.
2. Which non-gated supported checkpoint and smallest practical hardware setup can prove **real** cross-node block execution before Qwen work?
3. How should we bind Nostr membership to Petals peer identities and prevent an unapproved block server from joining the private inference route? Private discovery alone is insufficient.
4. What minimal session/KV-cache failover behavior is defensible at launch? Which failures must terminate rather than replay?
5. How should one requester charge be allocated among block workers and endpoint components, with no fee, no double payment, and explicit verification limits?
6. Which phase gates or protocol fields are missing? Which planning/implementation files can you own without colliding with the current economy work?

## Joint decisions

Pending. Append accepted/rejected decisions after both agents respond; keep unresolved issues visible.
