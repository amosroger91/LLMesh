<p align="center"><img src="assets/branding/logo.png" width="240" alt="LLMesh cyan network emblem"></p>
<h1 align="center">LLMesh</h1>
<p align="center"><strong>Your hardware. Your intelligence. Your rules.</strong></p>
<p align="center">Local AI. Shared compute. A network people can own.</p>
<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-00aeef"></a>
  <a href="package.json"><img alt="Node.js 24 recommended" src="https://img.shields.io/badge/Node.js-24-00aeef"></a>
  <a href="rust/README.md"><img alt="Rust and WASM preview" src="https://img.shields.io/badge/Rust_%2B_WASM-preview-00aeef"></a>
</p>

LLMesh turns your computer into an AI node. It detects your hardware, chooses a Qwen model, prepares it locally, and gives your applications an OpenAI-compatible endpoint. Connect trusted peers and requests can use a suitable available worker, with streamed responses and a quote based on the model and requested work.

You choose how much computing power to contribute. Use the machine in front of you, share a home GPU with your other devices, or build a trusted group that pools access to larger models.

**Current status:** an Electron/Node implementation with local inference, a trusted peer mesh, prototype Base token contracts and a Rust/WASM foundation. No live LLMESH token or escrow deployment is supplied. Android, web sign-in, QR pairing, the full Rust daemon and the downloadable release matrix are roadmap work.

[Start](#start-running) · [Features](#what-works-today) · [API](#one-endpoint-for-your-tools) · [Vision](#what-happens-when-the-network-grows) · [Roadmap](#where-were-going)

## Why LLMesh exists

Useful AI should not require surrendering every conversation to a remote platform. It should not disappear because a provider changes its prices, closes an account, or decides a community is no longer worth serving.

LLMesh starts with a practical alternative: run an open-weight model on hardware you control. Then extend that control to a network you choose. Keep familiar tools, connect through a standard API, and make the underlying compute replaceable.

The ambition is to put more of AI's infrastructure in the hands of the people who use it: individuals, classrooms, cooperatives, research groups and small businesses. Ownership should include the ability to inspect the software, choose the machines, set participation rules, and leave with your identity and data.

## What works today

| Feature | What it does |
| --- | --- |
| Hardware-aware setup | Detects CPU, RAM and GPUs; selects from the checked-in Qwen catalog and prepares a model with Ollama |
| Contribution levels | Low, Medium or High; Medium is the default, and the app chooses the model |
| Multi-GPU planner and pool | Plans independent instances or same-backend GPU splits, manages isolated runtimes and advertises slots |
| Streaming mesh inference | Authenticated, Noise-encrypted Hyperswarm connections between trusted nodes |
| Complexity-aware routing | Recommends a tier, then weighs availability, latency, throughput and price |
| OpenAI-compatible API | Model discovery, streamed chat, function tool calls, route previews and receipts |
| AI companion | A chat interface to that same mesh pipeline, with cancellation and local history |
| Dashboard | Hardware, model/setup state, online nodes including yourself, activity, endpoint details, wallet and energy estimates |
| One-click endpoint test | Sends a built-in message and shows success when a response arrives |
| Local self-service | Reserves and returns credits to the same account; no Base transaction required |
| Base integration | ERC-20 grants, funded request escrow, worker payouts and durable settlement retries when configured |
| Electricity tracking | Editable tariff/currency, NVIDIA board-power readings or fallback watts, session history and cost estimates |
| Rust/WASM foundation | Portable quote and placement code, shared Node/Rust fixtures, pinned workspace and browser WASM exports |

The multi-GPU pool is tested using simulated hardware and fake Ollama processes. Physical multi-GPU, cross-network NAT and the full platform/release matrix still need deployment testing. See [implementation status](REVIEW_STATUS.md) and [Rust parity](docs/rust-parity.md).

## Start running

Install **Node.js 24** and [Ollama](https://ollama.com/download), then:

```powershell
git clone https://github.com/amosroger91/LLMesh.git
cd LLMesh
npm ci
npm start
```

Managed runtime instances target **Ollama 0.40.2**. An existing Ollama service on port 11434 is reused in external mode by default; LLMesh does not take ownership of that process. See [runtime compatibility](docs/ollama-compat.md).

Start with **Medium**, wait for setup to show ready, then use the companion or press the endpoint test button. You can be the only online node. Local requests work without a cryptocurrency deployment.

| Level | Selection policy | CPU thread budget |
| --- | --- | --- |
| Low | Lightweight model; 35% of available model-memory budget | 25% of physical cores |
| Medium | Balanced model; 75% of available model-memory budget | 50% of physical cores |
| High | Largest estimated fit within the placement budget | All physical cores |

These are selection budgets, not electrical-power or GPU-utilization caps. Display-memory and runtime reserves reduce GPU budgets. Actual model loading can still fail; setup tries smaller candidates. CPU Low/Medium models are capped at 2B/4B. Labels never determine the price of a request.

### Models and multiple GPUs

The [catalog](models/catalog.json) supplies these choices:

| Model | Approximate download | Catalog memory estimate |
| --- | ---: | ---: |
| Qwen3.5 0.8B | 1.3 GB | 2 GB |
| Qwen3.5 2B | 3.1 GB | 5 GB |
| Qwen3.5 4B | 4 GB | 6 GB |
| Qwen3.5 9B | 7.6 GB | 10 GB |
| Qwen3.8 27B | 18 GB | 22 GB |

These are estimates, not measured guarantees. The planner permits attempts at 80% of the catalog estimate before additional runtime and contribution reserves. Longer contexts need more memory. Tags remain upstream-controlled; fully digest-pinned network catalogs are roadmap work.

In `auto` placement, **the largest model comes first**. Compatible GPUs are grouped when that enables a larger model, using the smallest sufficient set; remaining GPUs receive individual instances. Replication is preferred when it preserves the largest model, or when explicitly selected. CUDA, ROCm and Vulkan groups do not mix. Splitting is within one computer, not across peers. The pinned Ollama architecture implementation limits Qwen3.5 instances to one concurrent slot.

### Offline weights

Installed models are reused before contacting a registry. An available offline bundle is SHA-256 checked and imported before attempting a network pull.

```powershell
npm run models:bundle
npm run pack
```

Current packaging copies `models/ollama/` into the app's resource directory. The development bundle is approximately 1.23 GiB of cached Qwen3.5 0.8B assets. **A Git clone does not include the weights.** They exceed normal GitHub file limits and are ignored by Git. Create a bundle from your Ollama cache or supply it alongside the checkout. Ollama must still be installed, and both processes must agree on `OLLAMA_MODELS`. Larger selected models may need a network download.

## One endpoint for your tools

Copy these values from the dashboard into an OpenAI-compatible client:

| Client field | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:7337/v1` |
| API key | Your local key, using **Copy key** |
| Model ID | `llmesh-auto` |
| Display name | `LLMesh Auto` |

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:7337/v1",
    api_key="<copy your local key>",
)
response = client.chat.completions.create(
    model="llmesh-auto",
    messages=[{"role": "user", "content": "Explain how a mesh network works."}],
    stream=True,
)
for chunk in response:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
```

| Route | Purpose |
| --- | --- |
| `GET /health` | Process health |
| `GET /ready` | Ready to accept inference, or 503 while unavailable/draining |
| `GET /openapi.json` | OpenAPI document |
| `GET /v1/models` | Automatic route and available model IDs |
| `POST /v1/routes/preview` | Complexity, candidate model, worker and price without dispatch |
| `POST /v1/chat/completions` | JSON or streamed SSE completion, including function tool calls |
| `GET /v1/receipts/:id` | Authenticated payer's receipt and settlement state |
| `POST /v1/accounts` | Registration / configured relayed starter grant |
| `GET /v1/account` | Local account or linked wallet state |

Supports text and text-part arrays, developer messages, assistant tool calls and tool results. Tools execute in the requesting application. Limits: 256 messages, 128 function definitions, 90,000 serialized input characters and a 512 KiB HTTP body. Positive output limits above 2048 are accepted and clamped; receipts show requested and effective limits. Context scales from 4096 to 32768 tokens. Images, audio, embeddings and complete OpenAI API parity are not implemented.

The default API is loopback-only and rejects browser-origin calls. Protect its bearer key: configured remote requests can spend the node's tokens and gas. NIP-98 authentication also supports exact URL/method/payload binding and replay protection. A future web app needs the explicit browser access design in the [web plan](PLAN_WEB_AND_ACCOUNTS.md), not wildcard CORS.

## How requests find a worker

`llmesh-auto` estimates complexity locally, avoiding an extra classifier-model call. Short tasks target a small model; programming and analysis target 4B+; multi-step system design and formal reasoning can recommend 27B.

This is a keyword/context heuristic, not proof of task difficulty. By default, a mesh without the recommended tier uses its best eligible model and marks the result `degraded`. Set `allow_degraded: false` for a strict tier. No available eligible worker still produces an error.

Routing considers trusted, fresh, idle model slots and compatible payment configuration. Its score combines RTT, time to first token, 15% of estimated generation time and a 250 ms penalty for each quoted token above one. A small speed difference therefore need not select a more expensive worker. Routes stay pinned through funding and dispatch. Advertisements and model claims remain self-reported within the trusted group.

Streams reuse connections and forward incremental output with bounded buffers, backpressure and cancellation. Funding confirmation still adds startup latency; settlement retries happen after delivery. No lowest-latency benchmark is claimed.

## Build a trusted mesh

Exchange Nostr public keys with the operators of the other nodes. Configure a shared random group secret and trust the appropriate identities:

```powershell
$env:LLMESH_TOPIC = '<shared-random-group-secret>'
$env:LLMESH_WORKERS = '<trusted-worker-nostr-public-key>'
$env:LLMESH_COORDINATORS = '<trusted-coordinator-nostr-public-key>'
npm start
```

Hyperswarm provides discovery and direct Noise-encrypted streams. A minimal signed hello precedes capability exchange; unauthenticated handshakes expire after ten seconds. Without a shared topic, identities use isolated discovery topics. Busy/duplicate work receives retryable errors. Slot-aware Node advertisements negotiate with legacy Node peers; this is separate from the future Rust libp2p cutover, which requires a coordinated group upgrade.

A remote paid worker needs a receiving wallet and matching chain/escrow settings. The issuer/coordinator dispatches and settles paid jobs. Today's network distributes complete requests, not model layers across machines.

## Compute, credits and electricity

**Using your own node:** the local ledger reserves a quote and credits it back to the same account on completion, or refunds failure. The net change is zero. No blockchain or gas is needed. Electricity and hardware still have real costs.

**Using another node:** configured Base contracts escrow **1–3 LLMESH** per bounded request. Models up to 2B start at one, up to 9B at two, and larger models at three. Output reservations above 1024 tokens and inputs above 6000 characters each add one, capped at three. This is a fixed quote, not metered billing for actual generated tokens. Contribution labels do not set prices.

The [contracts](contracts/LLMesh.sol) implement an 18-decimal ERC-20 and escrow v3. Issuer-approved registration grants 100 LLMESH once per wallet and Nostr key, with allowlist admission, rate limits and persistent wallet binding. The coordinator can sponsor registration gas. Durable settlement retries and worker-claimable signed delivery receipts separate generation from confirmation. Early refunds require signed worker failure; ordinary refunds wait for expiry plus a 24-hour dispute window.

Local credits cannot pay other nodes or become ERC-20 balances. Base gas is additional. No live deployment, independent contract audit, token market value or permissionless proof of correct inference is supplied. The coordinator remains trusted for admission and delivery attestations. Payment channels, stronger distributed settlement and recovery are planned.

In **Energy & costs**, enter your electricity price per kWh and currency. NVIDIA board-power readings can be combined with estimated host overhead; other systems use editable fallback watts. A wall-meter reading can override the estimate. Local sessions and per-currency totals persist. Measurements can include other applications; CPU/PSU overhead and unsupported hardware are estimates. Concurrent-instance attribution and idle-baseline subtraction still need work. There is no automatic token-to-fiat conversion.

For contract testing without real funds:

```powershell
npm run chain
# In another terminal, use only a public development key printed by that chain:
$env:LLMESH_RPC = 'http://127.0.0.1:8545'
$env:LLMESH_DEPLOYER_KEY = '<development private key>'
$env:LLMESH_ISSUER = '<app wallet address>'
npm run contracts:deploy
```

The temporary JavaScript test chain uses chain ID 31337. Never fund its public keys with real assets. Configure peers with the same token/escrow addresses. Base Sepolia is 84532; Base mainnet is 8453. Live deployment requires explicit confirmation and a funded deployer; starting LLMesh does not deploy contracts.

## Your data, your boundaries

Companion history stays in IndexedDB. Preferences stay in localStorage; accounting and energy records use local SQLite. Desktop secrets use Electron safeStorage and stay out of renderer status responses. Headless keys support passphrase encryption with scrypt and AES-256-GCM. Without a passphrase, protect the data directory with OS access controls; Windows file mode 0600 is insufficient.

Local inference can keep prompts on your machine. Remote inference sends them to the selected worker, which must see plaintext to run today's models. Transport encryption does not hide prompts from that worker. Choose peers accordingly. This is not confidential-computing attestation or a guarantee of deletion by a remote operator.

The app contains no social rooms, public feed or RSS bots. Nostr provides identity and authentication. Shared accounts across installations, device revocation and QR sign-in are planned, not available yet. Back up irreplaceable keys before funding a wallet; a complete cross-platform recovery flow remains work.

## What happens when the network grows

One local model gives one person more control. A widely adopted mesh could make that control useful at a different scale: a classroom sharing a GPU after hours, a neighborhood cooperative pooling hardware, an independent researcher accessing a larger model, or a small organization running its own private inference network.

Instead of every useful interaction increasing dependence on a few centralized providers, more of the capacity could belong to the people using it. Contributions could help earn access to other machines. Open interfaces would let communities change models and clients without asking a platform for permission.

That is one route toward **democratizing access to LLMs**: lower the barrier to participation, make useful capability available on ordinary hardware, and let people combine resources when one machine is not enough. It could enable community services that are free to use when someone donates the compute. It does not make electricity, equipment or bandwidth free, or guarantee that every request costs nothing.

**Data sovereignty means having a meaningful choice about where your data goes and who can act on it.** Keeping a sensitive request local, choosing a trusted worker, inspecting the software and retaining your records are concrete parts of that choice. The planned privacy levels and organization-controlled edition aim to make those boundaries enforceable and visible across more deployments.

Wider adoption would not automatically remove corporate power or create an equal network. Large hardware owners could still dominate supply; relays, wallets and software distribution can become new choke points. Open code, portable identities, transparent pricing, alternatives to mandatory hosted services and community governance all matter. The goal is to give people more ways to build and use AI on their own terms—and make centralized services an option they can leave.

## Where we're going

| Track | Current state | Next destination |
| --- | --- | --- |
| Desktop | Electron/Node app and local API | Instance controls, recovery and release delivery |
| Multi-GPU | Planner/pool and simulated tests | Physical validation, complete UI and energy attribution |
| Linux | Node headless entrypoint; expanded CLI under development | x64/arm64 tarballs, deb/rpm, systemd and containers |
| Rust | Quote/placement crates, shared fixtures, CLI preview, WASM exports | Validation/routing bindings, daemon, libp2p and parity-gated desktop sidecar |
| Android | Architecture defined | Termux requester first, then Kotlin/UniFFI native app |
| Web | Portable WASM foundation and design | PWA requester, browser-compatible transport, optional WebGPU worker |
| Shared accounts | Nostr identity per installation | NIP-46 QR signing, scoped devices and shared linked-wallet balance |
| Security | Trusted peers, replay checks, encrypted transport/local key options | Rust-only group PKI, privacy sealing, audit and Sovereign edition |
| Payments | Prototype fixed-price escrow | Audited channels, recovery and stronger spending controls |

The planned QR flow approves a new device through an existing signer; it does not put a private key or wallet seed in the QR. Account identity, device membership and spending permission remain separate. Signing into the same account must not mint another starter grant. History synchronization is separately consented, not an automatic upload of conversations.

Node keeps shipping until Rust passes parity. WASM shares portable logic, not the entire native daemon: browsers need different transport/storage adapters and cannot spawn Ollama or inspect free VRAM like a native app. The companion continues to use the same mesh inference pipeline.

Plans and acceptance criteria:

- [Multi-GPU, Linux CLI and releases](PLAN_MULTI_GPU_AND_RELEASES.md)
- [Rust core and Android](PLAN_RUST_AND_ANDROID.md)
- [WASM web and shared accounts](PLAN_WEB_AND_ACCOUNTS.md)
- [Security, privacy and branding](PLAN_SECURITY_AND_BRAND.md)
- [Review fixes and remaining work](REVIEW_STATUS.md)
- [Rust parity checklist](docs/rust-parity.md)

Release targets include both standard and offline Windows installers, Linux x64/arm64 packages and containers, then Android and web artifacts. These are **targets, not downloads promised today**. Windows builds are currently unsigned; SmartScreen may require **More info → Run anyway** for a build you have verified. No paid signing service is configured. Free keyless checksum/container signing and application to the free SignPath Foundation program are planned.

## Build, test and contribute

```powershell
npm run check             # Syntax, contracts and Node tests
npm run build:ui          # Bundle desktop UI
npm run smoke             # Hidden Electron dashboard smoke test
npm run headless          # Current Node headless entrypoint
npm run pack              # Unsigned unpacked Electron app
npm run dist              # Installer using current local packaging config
```

The expanded CLI is under development at `src/cli/index.js`:

```powershell
node src/cli/index.js --help
node src/cli/index.js gpus --json
node src/cli/index.js doctor --offline --json
```

Check the Rust preview independently:

```powershell
cd rust
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all --check
cargo build -p llmesh-web --release --target wasm32-unknown-unknown --locked
cargo run -p llmesh -- --version
```

Node and Rust consume shared placement and pricing fixtures. Tests also cover authentication/replays, stream cancellation, model fallback, process isolation, escrow accounting, durable settlement and API tool calls. CI definitions cover Node on Windows/macOS/Linux and Rust native/WASM checks. Hosted CI results and real hardware deployment are distinct from passing local tests.

Contributions that improve compatibility, reproducible benchmarks, accessibility, recovery and clear privacy boundaries are welcome. Keep behavior documented and add evidence for the capability you change. Software is [MIT licensed](LICENSE); model weights and dependencies retain their respective licenses.

<p align="center"><img src="assets/branding/icon.png" width="64" alt="LLMesh emblem"></p>
<p align="center"><strong>Build intelligence people can own.</strong></p>
