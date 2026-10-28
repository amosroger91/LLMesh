# LLMesh public-alpha roadmap

Updated 2026-10-28 from the code and tests, not from the older plans alone. Those plans stay the design record. This file is the shortest path to a working inference economy. A tradeable token is not part of that path.

## What already runs

Verified by the Node tests and the modules they call:

- Windows desktop app and a Node headless CLI. Linux is the same Node entrypoint. Packaged Linux installers are not published.
- Ollama is the default native runtime. llama.cpp is an experimental Windows Vulkan adapter behind the same pool interface.
- Browser workers run Qwen3.5 0.8B with WebGPU or WASM. Pairing is a one-use desktop QR. Guest work does not keep a balance on the phone.
- Trusted peers discover each other on a shared Hyperswarm topic, then speak an authenticated Noise session. Capabilities are sent only after the handshake. There is no public worker directory.
- The OpenAI-compatible API streams chat, tool calls, and receipts. OpenCode is covered by tests. The funnel can publish that same authenticated API. It does not carry mesh jobs.
- Routing ranks idle compatible slots by measured latency, then price. A failed provider can be skipped before the stream starts. Busy slots return a retryable error.
- Accounts are Nostr keypairs created on first launch. Headless keys can be encrypted with a passphrase. There is no recovery file and no cross-device account restore.
- The desktop and CLI settle in internal credits unless the operator selects Base. New accounts receive 100,000 credits. A self-served request nets to zero. Reported tokens are priced at 0.5 credit for 0.8B and browser workers, 1 credit through 9B, and 1.5 above that.
- A coordinator that pays a remote worker in credits signs a receipt. The worker accepts it only when it matches that job, and only if its sequence is newer than the last receipt from that coordinator. The receipt does not add spendable credits on the worker. Spending that balance means calling the coordinator that holds the ledger.
- Base escrow v5 can lock, settle, and refund when an operator deploys the contracts. Nothing in this repository deploys them, and they are not required for local or trusted-mesh credits.

## What is not done

- Two machines on different networks are not part of the automated tests. Shared-topic NAT behavior still needs a real run.
- A 4 GB discrete GPU now serves 0.8B at Medium, or quantized 2B at High, when 4B does not fit. That path is unit-tested with simulated hardware, not on a 4 GB card.
- Identity backup, group invite management, and payment channels are designed and not built.
- Receipts do not prove that the model output was correct. They prove that this coordinator accepted this usage report.
- Rust covers quotes and placement. The desktop and mesh still run on Node. Android is not started.
- Installers are unsigned local packaging commands, not a release.

## Alpha order

1. Keep credits as the default and keep Base opt-in. Do not add an exchange or a public token deployment.
2. Run one Windows node and one Linux node on a shared trusted topic, including a restart during a stream, and record the result.
3. Add an encrypted backup of the Nostr key, API key, and credit ledger. Restoring it must not mint a second starter grant.
4. Publish unsigned Windows and Linux archives with checksums. No paid signing.
5. Only after those work, consider payment channels and a public worker introduction relay.

Request-level routing stays the unit of distribution. Do not split one model across machines.
