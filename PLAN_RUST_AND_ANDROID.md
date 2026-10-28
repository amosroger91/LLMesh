# Plan: Rust core rewrite (Linux first) and Android support

This plan is decided; build it as written.

The goal is to replace the Node.js core with one Rust daemon that runs on Linux servers, sits behind the Windows desktop app, and can be embedded in a native Android app.

It ties into:
- [PLAN_MULTI_GPU_AND_RELEASES.md](PLAN_MULTI_GPU_AND_RELEASES.md): placement, the CLI and packaging.
- [PLAN_SECURITY_AND_BRAND.md](PLAN_SECURITY_AND_BRAND.md): crypto, PKI, privacy levels and the Sovereign edition.

**Ground rules:**
- **Don't stop current work.** The Node.js implementation keeps shipping until the Rust daemon passes the parity checklist (§5). Bug fixes from CODE_REVIEW.md still land in JS.
- **Don't build security features twice.** The group PKI, crypto profiles, end-to-end sealing, audit log and Sovereign mode (security plan S2–S5) are built **in Rust only.** JS gets just the P0/P1 fixes.
- **Before adding any crate, check that it's maintained and what its latest version is.** Pin versions in `Cargo.lock`. Every crate named below is a starting choice; a different one is allowed only if it's unmaintained, and the PR must say why.

---

## 1. Target architecture

```
                ┌──────────────────────────── llmeshd (Rust) ───────────────────────────┐
 OpenAI clients │  api (axum: /v1/*, SSE)     admin (unix socket / named pipe)          │
 ───────────────►  router + pricing + privacy levels                                    │
                │  runtime: Engine trait ── OllamaEngine (desktop/Linux, multi-GPU pool) │
                │                         └─ LlamaCppEngine (in-process; Android, opt-in)│
                │  mesh (libp2p: QUIC/TCP, Kademlia, relay + hole punching, mTLS/Noise)  │
                │  crypto (rustls + aws-lc-rs; FIPS build for Sovereign)                 │
                │  store (SQLite, encrypted)   pay (alloy, community only)   audit log   │
                └────────────────────────────────────────────────────────────────────────┘
   Electron desktop ── spawns llmeshd as a sidecar, UI talks to it over the admin socket
   Linux server     ── llmeshd under systemd (same binary as the `llmesh` CLI)
   Android app      ── the same crates linked as a library through UniFFI, Kotlin UI
```

- **One binary, `llmesh`.** `llmesh serve` is the daemon (`llmeshd` is just its name in logs and in systemd). Every other subcommand from the release plan's §2.2 is a client of the admin socket.
- **Electron becomes a UI only.** `main.js` starts the bundled `llmesh serve --desktop`, passes the window's requests through to the admin socket, and handles OS bits like tray, clipboard and `safeStorage` for unlocking keys. All JS under `src/core` gets deleted at cutover (R5).
- **What stays JS:** the Electron renderer and its thin main process, the Solidity contracts and their JS test chain, and build scripts.

## 2. Cargo workspace

`rust/` at the repo root:

| Crate | Purpose | Main dependencies |
| --- | --- | --- |
| `llmesh-proto` | Versioned wire and API types, request validation (the port of `chat-request.js`), quotes (`pricing.js`) | `serde`, `serde_json` |
| `llmesh-hw` | GPU/CPU detection and the placement planner (release plan §1.2–1.3) | `nvml-wrapper` (NVIDIA), `sysinfo`; ROCm through `rocm-smi` JSON or sysfs |
| `llmesh-router` | Routing, privacy-level filtering, latency estimates | — |
| `llmesh-runtime` | `Engine` trait, the Ollama process pool and client, model manager (digest-verified pulls and offline bundles) | `tokio`, `reqwest` |
| `llmesh-engine-llamacpp` | In-process llama.cpp engine (feature-gated) | `llama-cpp-2` |
| `llmesh-crypto` | The crypto interface and the community/FIPS profiles (security plan §3.1) | `rustls`, `aws-lc-rs` (feature `fips` for Sovereign) |
| `llmesh-mesh` | Peer discovery, transport, protocol v3, group certificates and revocation | `libp2p` (quic, tcp, noise, kad, identify, relay, dcutr, request-response) |
| `llmesh-store` | SQLite schema and migrations, encrypted history | `rusqlite` (bundled; SQLCipher feature) |
| `llmesh-pay` | Escrow / payment channels (community edition only, behind the `token` feature) | `alloy` |
| `llmesh-audit` | Hash-chained, signed audit log, plus `audit verify` | — |
| `llmesh-api` | OpenAI-compatible HTTP API and the admin API | `axum`, `hyper`, `tower` |
| `llmesh` (bin) | CLI and daemon | `clap`, `tracing`, `tracing-subscriber` |
| `llmesh-node` | Node bindings for the transition (R1) | `napi-rs` |
| `llmesh-ffi` | Android/Kotlin bindings | `uniffi` |

**Edition features:**
- `--features community` (default) includes `token` and the public DHT.
- `--features sovereign` turns on `fips` and leaves out `llmesh-pay`, the DHT and Nostr **at compile time**, so a Sovereign binary contains none of that code.

**Quality gates (CI fails without them):**
- `#![forbid(unsafe_code)]` in every crate except `llmesh-node`, `llmesh-ffi` and `llmesh-engine-llamacpp`. Those crates keep their `unsafe` blocks small and commented.
- `cargo clippy --all-targets -- -D warnings`, and `cargo fmt --check`.
- `cargo deny check`: advisories, licenses (allowlist), bans, sources.
- `cargo fuzz` targets for the protocol decoder, API request validation, certificate and attestation parsing, and the policy file. Run them in CI briefly and on OSS-Fuzz continuously once accepted.
- `rust-toolchain.toml` pins the toolchain. Make release builds reproducible: `--remap-path-prefix`, `SOURCE_DATE_EPOCH`, `--locked`.

## 3. Engines

- **`OllamaEngine`** is the default on Windows and Linux. It's a port of `ollama.js` plus the multi-GPU `OllamaPool` (release plan §1.4): managed and external modes, one instance per placement.
- **`LlamaCppEngine`** links llama.cpp in-process and loads GGUF files from the model catalog, with digest pinning.
  - It's **required on Android**, where Ollama isn't available as an app.
  - On Linux it's an opt-in alternative (`--engine llamacpp`) for minimal servers. That way there's no separate Ollama to install, and `split` placement uses llama.cpp's own tensor-split setting.
  - GPU backends: CUDA/ROCm/Vulkan on Linux, Vulkan/OpenCL on Android where the device supports it, CPU (NEON) otherwise. Check which backends `llama-cpp-2` builds for each target, and document the result in `docs/engines.md`.
- Both engines are tested by the same conformance tests (§5).

## 4. Mesh protocol v3 on libp2p

- **Transport:**
  - **Community:** QUIC first, TCP + Noise as fallback. Kademlia DHT on a **private, group-derived namespace**. Relay v2 + DCUtR for NAT hole punching.
  - **Sovereign:** TLS 1.3 mTLS over QUIC using the FIPS profile. Peers come from org bootstrap nodes or a static list. No public DHT.
- **Identity:** each peer's ID comes from its device key. Group membership is a signed device certificate (security plan §3.3), checked in the handshake. An unauthenticated peer gets disconnected within 10 s and receives nothing beyond a minimal hello.
- **Messages:** length-prefixed **CBOR** frames (`ciborium`) on request-response and streaming protocols: `/llmesh/advert/3`, `/llmesh/job/3`, `/llmesh/stream/3`.
  - Every frame has a version and size limits.
  - Over-capacity gets a retryable `busy` reply, never a disconnect.
  - Adverts list per-model slots, as in release plan §1.5.
  - Request bodies sent to a worker are HPKE-sealed when the privacy level needs it (security plan §3.2).
- **No interop with Hyperswarm.** There's no maintained Rust Hyperswarm, and building a bridge isn't worth it. **The switch happens at one release (R5):** that release moves desktop and Linux to v3 together. Its release notes and the README say the whole group must upgrade at once. v2 peers can't connect to v3 peers.

## 5. Proving parity before switching

- **Shared fixtures** in `fixtures/`: hardware → placement, request → validation result, request → quote, workers + request → route. JSON files read by **both** `node --test` and `cargo test`, so both implementations have to agree exactly.
- **Black-box conformance suite** in `conformance/`: plain HTTP and admin-socket tests that run against *either* daemon (`LLMESH_TARGET=node|rust`). It covers:
  - every `/v1` route, streaming, tool calls, errors and limits
  - privacy-level enforcement
  - drain on SIGTERM, and `/health` and `/ready`
  - multi-instance routing, using the fake Ollama from the release plan §1.7
- **Parity checklist** in `docs/rust-parity.md`: every feature in the README, marked Node ✓ / Rust ✓. Cutover (R5) needs every row ✓ on Rust and the conformance suite green on Linux and Windows.

## 6. Phases

| Phase | Scope | Done when |
| --- | --- | --- |
| **R0. Setup** | `rust/` workspace, quality gates, a CI job (ubuntu + windows), cross-build of `llmesh --version` for every target in §8 | CI green; binaries for every target come out as artifacts |
| **R1. Rust inside Node** | `llmesh-proto`, `llmesh-hw` (placement) and `llmesh-router` exposed to the JS app through `llmesh-node` (napi-rs). JS calls Rust for validation, quoting, placement and routing. | Shared fixtures pass in both; JS versions of those modules deleted; no behavior change in the desktop app |
| **R2. Linux daemon (local node)** | `llmesh serve` with the API, admin socket, OllamaPool and multi-GPU, store, config, logging, metrics, drain, systemd. No mesh yet. | Conformance suite green against Rust for local-only features; runs under systemd on Ubuntu 24.04 x64 and arm64; replaces the Node CLI for **local** Linux deployments in the next release |
| **R3. Mesh + security core** | `llmesh-mesh` (v3), `llmesh-crypto` (community + PQ hybrid), group PKI and revocation, privacy levels, end-to-end sealing, workers that keep nothing (security plan S1–S4, built here) | Two Rust nodes on different networks (one behind NAT) form a group, revoke a member, and serve `trusted` requests end to end; Tamarin model matches the implemented handshake |
| **R4. Payments, audit, Sovereign** | `llmesh-pay` (payment channels from CODE_REVIEW R1), `llmesh-audit`, the `sovereign` feature with FIPS (`aws-lc-rs` FIPS on glibc), RBAC, policy file | Community build settles payments over a channel; Sovereign build starts in FIPS mode, contains no token code (checked by `cargo tree` in CI), and passes `audit verify` |
| **R5. Desktop cutover** | Electron spawns the bundled `llmesh serve --desktop`; renderer goes through preload → main → admin socket; protocol v3 default; delete `src/core` JS | Parity checklist all ✓; desktop smoke screenshots unchanged except for new features; v3 release notes published |
| **A1. Android via Termux** | Runs *now*, alongside R1–R2, on the Node build | See §7.1 |
| **A2. Native Android app** | After R3 | See §7.2 |

R1 can start right away. It doesn't touch files the agent implementing the release plan is changing, beyond `hardware.js`, `contribution.js` and `router.js`, which get replaced. Do R1 after that agent's placement work lands, so the Rust port starts from the finished JS behavior and shares its fixtures.

## 7. Android

### 7.1 A1: Termux build (no Rust needed yet)
- Termux uses Android's own C library (bionic), so the glibc Linux tarball **won't run there**. Ship `llmesh-android-arm64-termux.tar.gz` without a bundled Node runtime, plus `install-termux.sh`. The script:
  - runs `pkg install nodejs` (check that Termux's Node is ≥ 22.5, which `node:sqlite` needs)
  - installs Ollama if Termux packages it, or points to `--runtime external` against another machine
  - unpacks the app and creates a `llmesh` command
- The native modules already ship Android prebuilds: `sodium-native` and `udx-native` include `android-arm64` in `node_modules/*/prebuilds`. CI must check the tarball contains them.
- Document `termux-wake-lock`, how to turn off battery optimization for Termux, and that phones should use the smallest model tier.
- **Main use:** the phone acts as a **requester** on your trusted group, using your home GPU box privately from anywhere. Serving as a worker is secondary.

### 7.2 A2: Native app (after R3)
- **Kotlin + Jetpack Compose UI.** The Rust core is built for `aarch64-linux-android` (plus `x86_64-linux-android` for emulators) with `cargo-ndk`, and bound to Kotlin with **UniFFI** (`llmesh-ffi`).
- **Inference:** `LlamaCppEngine` in-process. Phone tiers default to 0.8B–2B quantized models, with 4B on devices that have ≥ 12 GB RAM.
- **Serving rules:**
  - A worker runs only as a **foreground service** with a persistent notification, as Android requires.
  - It contributes only when the phone is **charging, on unmetered Wi-Fi, and below a temperature threshold** (`BatteryManager`, `PowerManager` thermal status). Users can override each condition.
  - As a requester it works on any network.
- **Keys:** Android Keystore, with StrongBox when the device has it. History is encrypted with a key stored there.
- **Privacy receipts and the brand UI** match the desktop (security plan §6.4).
- **Distribution (free channels only):** a signed APK on GitHub Releases, and **F-Droid**. Signing uses a release key held in GitHub secrets, generated once and backed up offline. Google Play costs a one-time registration fee, so leave it out until the owner approves the spend.
- **Done when:** the APK installs on an Android 12+ arm64 phone, joins a group as requester and as worker, passes the conformance subset (API over loopback, privacy levels), and stops serving when unplugged.

## 8. Builds and releases

| Target | Use | Notes |
| --- | --- | --- |
| `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` | Community Linux (static binary) | Replaces the Node tarball after R2/R5. `.deb`/`.rpm` via nfpm unchanged; Docker image becomes `FROM gcr.io/distroless/static` |
| `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` | Sovereign Linux (FIPS) | FIPS `aws-lc-rs` builds need glibc, CMake and Go on the build runner |
| `x86_64-pc-windows-msvc` | Desktop sidecar | Bundled into the Electron installers (both standard and offline) |
| `aarch64-linux-android`, `x86_64-linux-android` | Android app | `cargo-ndk`; APK built with Gradle in CI |

- Cross-compile Linux with `cargo-zigbuild`, or build natively on `ubuntu-24.04` and `ubuntu-24.04-arm` runners. Prefer native runners for anything that runs tests.
- `release.yml` (release plan §3.5) gets `rust-linux`, `rust-windows` and `android` jobs. The cosign-signed `SHA256SUMS` covers every artifact.
- Until R5, a release can contain both the Node tarball and the Rust Linux binary. The download section labels the Rust one "local node (preview)" between R2 and R5.
