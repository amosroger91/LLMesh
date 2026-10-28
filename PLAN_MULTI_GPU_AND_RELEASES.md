# Plan: multi-GPU, Linux headless CLI, and downloadable releases

This plan has three goals:

1. **Use every GPU in a machine at once.**
2. **Run as a production Linux CLI/daemon** on servers with no GUI.
3. **Keep the Windows desktop app**, and publish downloads for both from GitHub Releases.

It builds on [CODE_REVIEW.md](CODE_REVIEW.md). The items it depends on are named inline (e.g. *needs P0-4*).

> **Verify before relying on it.** Ollama's multi-GPU behavior and environment variables (`CUDA_VISIBLE_DEVICES`, `HIP_VISIBLE_DEVICES` / `ROCR_VISIBLE_DEVICES`, `OLLAMA_HOST`, `OLLAMA_MODELS`, `OLLAMA_SCHED_SPREAD`, `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`) are described here from general knowledge. Pin an Ollama version, check each variable against that version's docs, and record the result in `docs/ollama-compat.md` before building on it.

---

## Where things stand today

- `src/hardware.js` already detects every GPU (`nvidia-smi` plus `systeminformation`). But every decision takes `Math.max` over GPUs (`hardware.js:29,34`, `contribution.js:11`, `service.js:125`), so **only the single largest GPU counts**. A 2×12 GB machine is treated as 12 GB.
- There is exactly one Ollama endpoint (`http://127.0.0.1:11434`, `src/ollama.js:26`). A node can run **one request at a time** (`service.busy` is 0/1, `service.js:148-149`), and it advertises a boolean `busy`.
- A headless entry point already exists (`src/cli.js`, `npm run headless`). It has no subcommands, no config file and no service integration, and it crashes if the RPC is down (*CODE_REVIEW P0-6*).
- `package.json` builds Windows NSIS, mac DMG and Linux AppImage with electron-builder. The 1.3 GB `models/ollama` bundle goes into every installer through `extraResources`. There is no CI and no release workflow. The repo remote is `github.com/amosroger91/LLMesh`.
- The native dependencies (`sodium-native`, `udx-native`, which come in via Hyperswarm) ship prebuilds for `linux-x64`, `linux-arm64` and `win32-x64`. `node:sqlite` needs Node ≥ 22.5; the dev machine runs 24.13.

---

## Part 1: multi-GPU

### 1.1 Two ways to use several GPUs

| Mode | What runs | Good for | How |
| --- | --- | --- | --- |
| **Split** | One model spread across several GPUs | Running a model too large for any single card (e.g. 27B on 2×12 GB) | One Ollama instance that sees all GPUs in the group. llama.cpp splits layers across them. `OLLAMA_SCHED_SPREAD=1` forces spreading even when the model fits one card. |
| **Replicate** | One Ollama instance per GPU, each with its own model copy | Throughput: N GPUs serve N requests at once | N `ollama serve` processes. Each gets `CUDA_VISIBLE_DEVICES=<uuid>` (or the HIP/ROCR equivalent for AMD), its own `OLLAMA_HOST=127.0.0.1:<port>`, and a shared `OLLAMA_MODELS` cache so weights download once. |

Mixed setups combine the two. For example, 2×24 GB + 1×8 GB becomes one split instance on the two 24 GB cards running 27B, plus one single-GPU instance on the 8 GB card running 4B.

### 1.2 Placement planner: one pure function

Add `src/placement.js`:

```js
/** @returns {Placement} */
export function planPlacement(hardware, { level, gpuSelection = 'auto', mode = 'auto', catalog })
// Placement = { instances: [{ id, gpus: [uuid], backend, model, port, parallel, mode: 'split'|'single'|'cpu' }], reason }
```

Rules, in order:

1. **Eligible GPUs.**
   - Drop integrated GPUs (Intel UHD/Iris, AMD APUs, anything with shared memory or under 2 GB VRAM) unless the user selects them explicitly.
   - Honor `gpuSelection` (`'auto' | 'all' | [uuid|index]`).
   - On Windows desktop with `auto`, keep 1.5 GB of headroom on the GPU driving the display. There's no reliable way to detect which one that is, so treat GPU 0 as the display GPU unless the user says otherwise.
2. **Group by backend.** CUDA, ROCm, Vulkan and Metal never split together. Within a backend, you may split across different card sizes, but the usable budget is limited by the per-GPU overhead.
3. **Budget per group.** Sum each GPU's free VRAM, minus about 0.75 GB per GPU for compute buffers and KV cache at the context size. Apply the contribution level's fraction, as `contribution.js` does today.
4. **Choose for the most value.**
   - If the largest catalog model that fits *one* GPU is also the largest that fits the whole group, **replicate**: one instance per GPU.
   - Otherwise put the biggest model on a **split** instance over the smallest set of GPUs that holds it, then fill the remaining GPUs with single-GPU instances.
   - `mode: 'split' | 'replicate'` overrides this.
5. **Contribution levels.** `low` = one GPU only, at most 35% budget. `medium` = all eligible GPUs at 75%. `high` = all eligible GPUs at 100%.
6. **CPU.** CPU-only stays one instance (today's behavior). Never spread across CPU and GPU unless no GPU is eligible.

This **replaces** the three selection paths that exist today (`recommend()`, `chooseContribution()`, the candidate filter at `service.js:83`), as *CODE_REVIEW P2-3* asks. Keep the existing out-of-memory fallback, but make it per instance: if an instance fails to load, step that instance down one model size and leave the others alone.

Tests are table-driven, using hardware fixtures in `test/fixtures/hardware/*.json`:
- 1×8 GB
- 1×24 GB
- 2×12 GB → split 27B
- 2×24 GB → replicate: 27B needs about 22 GB, so it fits one card and the planner runs two copies
- 24 + 8 GB
- 4×16 GB
- NVIDIA + AMD mixed
- laptop with iGPU + dGPU
- Apple unified memory
- no GPU

### 1.3 Better GPU detection

Extend `detectHardware()` so each GPU has `{ index, uuid, name, vendor, backend, vramGB, freeGB, integrated, pciBus }`:
- **NVIDIA:** `nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.free,pci.bus_id,power.draw --format=csv,noheader,nounits`.
- **AMD on Linux:** `rocm-smi --showmeminfo vram --showuniqueid --json`. Fall back to `/sys/class/drm/card*/device/mem_info_vram_{total,used}`.
- **Everything else:** `systeminformation`, with `backend: 'vulkan'` and free memory unknown.
- Fix the dedupe at `hardware.js:52`: an empty `gpu.model` currently matches every NVIDIA device. Match on PCI bus id instead.

Add `llmesh gpus` (CLI) and a GPU table in the desktop UI, both showing the result and the planned placement.

### 1.4 Runtime: manage several Ollama instances

Replace the single `Ollama` client with an **`OllamaPool`** in `src/runtime/pool.js`.

- **Managed mode** (default in the desktop app, and with `--runtime managed` on Linux):
  - Spawn one `ollama serve` per placement instance. Env per instance: `CUDA_VISIBLE_DEVICES` / `HIP_VISIBLE_DEVICES`, `OLLAMA_HOST=127.0.0.1:<11500+i>`, shared `OLLAMA_MODELS`, `OLLAMA_NUM_PARALLEL=<parallel>`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_KEEP_ALIVE`.
  - Health-check each one, restart it with backoff, and capture its stderr into the LLMesh log with an instance tag.
  - On shutdown, kill each process tree (today's `taskkill /T` logic on Windows; on Linux, a process group plus `SIGTERM`, then `SIGKILL`).
  - Install or pull a model **once** through one instance, then `warm()` it on each instance that needs it.
- **External mode** (`--runtime external --ollama-url http://host:11434`, repeatable):
  - Use Ollama instances someone else runs, such as a distro `ollama.service` or Docker containers. LLMesh never spawns or kills them, and treats each URL as one instance.
  - This is the right mode for many production servers. If an Ollama is already listening on 11434 and the user didn't ask for managed mode, warn and fall back to external with that one instance, rather than fighting it for the port.

Each instance exposes **slots** (`parallel`, default 1, configurable up to 4). Concurrency becomes a count, not a boolean.

### 1.5 Service, router and mesh changes (*needs P0-4*)

- **`Service`:** replace `busy` / `loadedModel` / `assignedModel` with `instances: [{ id, model, slots, inFlight, metrics }]`. `runLocal` picks the instance with a free slot for the routed model. The per-model metrics in `modelMetrics` become per instance.
- **Mesh advertisement:** replace `busy: 0|1` and `models[]` with `slots: [{ model, free, total, firstTokenMs, tokensPerSecond }]`, and bump the protocol version (*P1-6*). Keep accepting the old shape from v1 peers for one release.
- **Worker capacity:** the limit becomes the sum of free slots instead of the hard-coded `active.size >= 4` (`mesh.js:88`). Over capacity → a retryable `busy` error, not a socket destroy (*P0-4*).
- **Router:** `planRoute` scores options as (worker, instance, model) instead of (worker, model). A worker with 2 free slots of 27B counts as two options. Local candidates come from every local instance.
- **Energy:** `scanPower` reads per-GPU `power.draw` by index. Attribute power to the instance(s) whose GPUs are running a request, so concurrent requests on different GPUs each accrue their own GPU's watts, and the host overhead is counted once.

### 1.6 UI and CLI surface

- **Desktop:** a GPU table (name, VRAM free/total, backend, include checkbox), a placement mode selector (Auto / Split / One model per GPU), and one card per instance (model, GPUs, slots busy, tok/s, status, restart button).
- **CLI:** `llmesh gpus [--json]`, `llmesh serve --gpus all|0,1 --placement auto|split|replicate --parallel 2`, `llmesh status` (lists instances).

### 1.7 Testing multi-GPU without multi-GPU CI

GitHub-hosted runners have no GPUs. So:
- The planner gets pure unit tests with fixtures (above).
- Add a **fake Ollama** server for tests (`test/fake-ollama.js`): it speaks `/api/version`, `/api/tags`, `/api/pull`, `/api/chat` (NDJSON), records `CUDA_VISIBLE_DEVICES` from its env, and can simulate out-of-memory. Pool tests spawn 3 fakes and assert routing, slot accounting, restart and shutdown.
- Write a manual hardware checklist, `docs/testing-multi-gpu.md`: 2× NVIDIA split, 2× NVIDIA replicate, NVIDIA + iGPU laptop, AMD ROCm on Linux. Release notes say which of these were actually run.

---

## Part 2: Linux headless CLI for production

### 2.1 Separate the core from Electron

- Move everything with no Electron dependency into `src/core/`: service, mesh, router, payments, runtime, energy, store.
- `src/electron/` and `src/cli/` become thin shells over the core. Enforce it with an ESLint `no-restricted-imports` rule: `src/core` must not import `electron`.
- Pull the secret-loading logic that's duplicated between `main.js` and `cli.js` into a `KeyStore` interface with two implementations: `ElectronSafeStorage` and `FileKeyStore` (0600 files, optional passphrase via scrypt + AES-GCM, and `*_FILE` env vars so systemd credentials and Docker secrets work).

### 2.2 Command line

Use `node:util` `parseArgs`, so there are no new dependencies. Subcommands:

```
llmesh serve      [--config PATH] [--listen 127.0.0.1:7337] [--gpus ...] [--placement ...] [--runtime managed|external] [--ollama-url URL]... [--level low|medium|high]
llmesh status     [--json]                 # talks to the running daemon over the admin socket
llmesh gpus       [--json]
llmesh models     list | install <id> | remove <id>
llmesh group      create | invite | join <code> | members | revoke <pubkey>   # see CODE_REVIEW R2
llmesh wallet     address | balance | claim | refund <jobId>
llmesh keys       export --out FILE | import FILE      # encrypted backup (CODE_REVIEW R6)
llmesh doctor                              # checks Ollama, GPUs, ports, RPC, clock skew, DHT reachability, permissions
llmesh --version
```

### 2.3 Config

- **Precedence:** flags > env (`LLMESH_*`) > config file > defaults. Validate everything at startup and fail with a precise message.
- **Config file:** `/etc/llmesh/config.json` for the system service, otherwise `$XDG_CONFIG_HOME/llmesh/config.json`. Keep JSON with a JSON Schema so there's no parser dependency.
- **Data:** `/var/lib/llmesh` for the system service, otherwise `$XDG_DATA_HOME/llmesh`. Windows keeps `app.getPath('userData')`.
- **Hot reload on `SIGHUP`:** energy settings, group members, log level. Changing GPUs or placement means a drain and re-plan, not a restart.

### 2.4 Production behavior

- **Logging:** structured JSON on stdout by default (journald/Docker friendly). `--log-format pretty` for humans. Keys and tokens are always redacted.
- **Graceful drain on `SIGTERM`:** stop accepting new work, advertise 0 free slots, let in-flight requests finish (up to 30 s, configurable), flush settlements (*P0-1*), stop managed Ollama instances, exit 0.
- **Endpoints:**
  - `GET /health`: process is alive.
  - `GET /ready`: at least one instance has a model loaded, and payments are connected if they're required.
  - Optional `GET /metrics` in Prometheus format on a separate `--metrics-listen` port: requests, TTFT histogram per instance and model, slots busy, settle backlog, GPU memory and power.
- **Admin socket** `/run/llmesh/admin.sock` (mode 0660, group `llmesh`): `status`, `drain`, `reload` and `models install` run over it, never over the public API key.
- **Network binding:** stays on loopback by default. `--listen 0.0.0.0:7337` requires `--tls-cert` / `--tls-key`, or an explicit `--insecure-listen` flag that logs a warning every start.
- **No silent installs on servers.** If Ollama is missing, the CLI prints the exact install command and exits non-zero. `--install-runtime` opts in to running it. The desktop app keeps its winget auto-install.
- **Payments down ≠ node down** (*P0-6*): serve self-paid and local requests, retry the RPC with backoff, and surface the problem in `/ready` and `status`.

### 2.5 systemd unit (shipped in packages)

```ini
[Unit]
Description=LLMesh inference node
After=network-online.target
Wants=network-online.target

[Service]
User=llmesh
Group=llmesh
ExecStart=/opt/llmesh/bin/llmesh serve --config /etc/llmesh/config.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
StateDirectory=llmesh
RuntimeDirectory=llmesh
LoadCredential=wallet.key:/etc/llmesh/credentials/wallet.key
Environment=LLMESH_WALLET_KEY_FILE=%d/wallet.key
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
SupplementaryGroups=video render

[Install]
WantedBy=multi-user.target
```

`SupplementaryGroups=video render` gives access to the GPU device nodes. Check the group names on Ubuntu, Debian, Fedora and RHEL.

---

## Part 3: builds and downloads

### 3.1 Artifacts per release

| Artifact | Platform | Contents |
| --- | --- | --- |
| `LLMesh-Setup-x64.exe` | Windows 10/11 x64 | Electron NSIS installer, small, downloads the model on first run |
| `LLMesh-Setup-x64-offline.exe` | Windows x64 | Same installer plus the verified 0.8B model bundle (about 1.3 GB). Optional. |
| `latest.yml` + `.blockmap` | Windows | Metadata for `electron-updater` auto-updates |
| `llmesh-linux-x64.tar.gz` / `llmesh-linux-arm64.tar.gz` | Linux | Bundled Node runtime + app + native prebuilds + `bin/llmesh` |
| `llmesh_<ver>_amd64.deb`, `llmesh-<ver>.x86_64.rpm` (+ arm64) | Debian/Ubuntu, Fedora/RHEL | The tarball contents in `/opt/llmesh`, systemd unit, `llmesh` user, `/etc/llmesh/config.json` |
| `ghcr.io/amosroger91/llmesh:<ver>` and `:latest` | Docker, linux/amd64 + arm64 | Headless node, multi-arch |
| `install.sh` | Linux | Detects arch, downloads the tarball, checks SHA-256, installs to `/opt/llmesh`, optionally enables systemd |
| `SHA256SUMS` + `SHA256SUMS.sig` | All | Checksums, signed with cosign (keyless) or minisign |

Use **stable asset names without versions** so these links always work:
`https://github.com/amosroger91/LLMesh/releases/latest/download/LLMesh-Setup-x64.exe`
Set electron-builder's `artifactName` to match. The `.deb` and `.rpm` keep versioned names because that's the convention.

### 3.2 Linux build: why a tarball with Node, not a single binary

Node SEA (single executable) and `pkg` can't cleanly embed native addons (`sodium-native`, `udx-native`). A self-contained directory is reliable and simple:

1. `esbuild` bundles `src/cli/index.js` and `src/core/**` into `dist/cli/llmesh.mjs`, with native modules marked external.
2. `npm ci --omit=dev` in a staging dir, then prune `node_modules` to the runtime packages, keeping only the `linux-<arch>` prebuilds.
3. Download the official Node 24 LTS binary for that arch and check it against nodejs.org's `SHASUMS256.txt`.
4. Layout: `bin/llmesh` (a `#!/bin/sh` wrapper that runs `exec "$DIR/../node/bin/node" "$DIR/../lib/llmesh.mjs" "$@"`), `node/`, `lib/`, `node_modules/`, `LICENSE`, `README.md`.
5. Package `.deb` / `.rpm` from the same directory with **nfpm** (one YAML file, no distro toolchains), including the systemd unit and postinstall script (create user, set permissions, `systemctl daemon-reload`).

Revisit SEA later. Node's SEA can load addons from disk next to the binary, but that buys little over the tarball.

### 3.3 Docker

- Base on `node:24-bookworm-slim`. Copy in the Linux tarball. Run as a non-root `llmesh` user.
- Volume `/var/lib/llmesh`. Expose 7337, but bind loopback inside the container unless `--listen` is set.
- Ship `deploy/docker-compose.yml` with two services: `ollama` (official `ollama/ollama` image at a **pinned** tag, `gpus: all`) and `llmesh` (`--runtime external --ollama-url http://ollama:11434`).
- For multi-GPU replicate inside Docker, the compose file defines one Ollama service per GPU (`device_ids: ['0']`, `['1']`, …) and passes several `--ollama-url` flags. That stays external mode, so LLMesh never needs to spawn processes inside containers.
- Document the NVIDIA Container Toolkit as a prerequisite, and add an AMD ROCm compose variant using the ROCm Ollama image.

### 3.4 Windows build

- Keep electron-builder NSIS. Change three things:
  - Make the model bundle optional through a second config (`electron-builder.offline.yml`), so the default installer isn't 1.3 GB.
  - Fix `asarUnpack` to cover only native modules (*P2-10*).
  - Set stable `artifactName`.
- **Code signing:** unsigned installers trigger SmartScreen warnings. Use Azure Trusted Signing or an OV/EV certificate, with secrets in GitHub Actions. The workflow signs only when the secrets exist, so forks still build.
- **Auto-update:** add `electron-updater` with the GitHub provider. Check on startup and every 6 h, and install on quit. Never update while requests or settlements are in flight.
- Drop the mac DMG and Linux AppImage targets from the default build until someone tests them. Linux users get the CLI. Desktop Linux can come back later.

### 3.5 CI/CD (GitHub Actions)

`.github/workflows/ci.yml` runs on push and PR:
- Matrix: `ubuntu-latest`, `windows-latest`.
- Steps: `npm ci`, `npm run check` (lint + typecheck + contract compile, per *P2-14*), `npm test`.
- On Ubuntu only: build the Linux tarball and run `llmesh --version` and `llmesh doctor --offline` from it as a smoke test.

`.github/workflows/release.yml` runs on tag `v*`:
1. **test:** same as CI.
2. **linux:** matrix of `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64). Build tarball → nfpm `.deb` / `.rpm` → upload as workflow artifacts. Smoke-test by installing the `.deb` in a `debian:bookworm` container and running `llmesh --version`.
3. **docker:** `docker/setup-buildx-action`, then a multi-arch build of `linux/amd64,linux/arm64`, pushed to `ghcr.io` with `GITHUB_TOKEN`.
4. **windows:** `windows-latest`, `npx electron-builder --win nsis --publish never`, then sign if secrets are present. Also build the offline variant if `vars.BUILD_OFFLINE == 'true'`, which needs `models/ollama` fetched from a release asset or cache, since it's gitignored.
5. **publish:** collect all artifacts, generate `SHA256SUMS`, sign it, and create the GitHub Release as a **draft**. A human reviews and publishes it.

Cutting a release from this machine: bump `package.json` version, commit, tag `vX.Y.Z`, push the tag. The `gh` CLI isn't installed here, so use the repo's `push` skill (plain git plus the GitHub REST API). The workflow does the building.

### 3.6 README "Download" section

Add a table at the top of the README: Windows installer, Linux one-liner, `.deb` / `.rpm`, Docker, each with its `releases/latest/download/...` link. Below it:
- how to verify `SHA256SUMS`
- minimum requirements (Windows 10 22H2+; glibc 2.31+ for the tarball; NVIDIA driver / CUDA or ROCm versions matching the pinned Ollama)
- a link to `docs/ollama-compat.md`

Linux one-liner:

```bash
curl -fsSL https://github.com/amosroger91/LLMesh/releases/latest/download/install.sh | sh
```

`install.sh` must check the checksum, print exactly what it will do, and touch systemd only with `--systemd`.

---

## Phases and done criteria

| Phase | Scope | Done when |
| --- | --- | --- |
| **0. Prerequisites** | CODE_REVIEW P0-4, P0-5, P0-6, P1-6, P2-1, P2-3 | Lint + types pass; protocol versioned; busy is a retryable error |
| **1. Core/shell split** | §2.1, `KeyStore`, config loader | `src/core` has no Electron imports (lint rule); desktop app works exactly as before |
| **2. Linux CLI** | §2.2–2.5 | `llmesh serve` runs under systemd on Ubuntu 24.04, drains cleanly on `systemctl stop`, `/ready` reflects state, `llmesh doctor` catches a missing Ollama |
| **3. Placement + detection** | §1.2, §1.3 | Fixture tests cover every case listed; `llmesh gpus` shows correct placement on real 1-GPU and 2-GPU machines |
| **4. Ollama pool + slots** | §1.4, §1.5 | Fake-Ollama pool tests pass; on a 2-GPU box, two concurrent requests run on different GPUs at the same time (check with `nvidia-smi`); split mode loads 27B on 2×12 GB |
| **5. UI** | §1.6 | GPU table, mode selector and instance cards in the desktop app; smoke screenshots updated |
| **6. Packaging** | §3.1–3.4 | Tarball, `.deb`, `.rpm`, Docker image and Windows installer all build locally from scripts in `scripts/release/` |
| **7. CI/CD + downloads** | §3.5, §3.6 | Pushing a `v*` tag produces a draft release with every artifact plus signed checksums; `latest/download` links work after publishing |
| **8. Signing + auto-update** | §3.4 | Signed installer passes SmartScreen without warnings (once the certificate has reputation); app updates itself from one release to the next |

Phases 1–2 and 3–4 can run in parallel once phase 0 is done; they touch different files apart from `service.js`, so put the `Service` split from *CODE_REVIEW P2-4* in phase 1. Phases 6–7 can start as soon as phase 2 lands.

## Open decisions for the owner

1. **Default placement on a mixed-size multi-GPU box:** prefer the biggest model (split), or the most throughput (replicate)? The plan defaults to "biggest model that fits the whole group, then fill the remaining GPUs".
2. **Ship an offline Windows installer** with the 1.3 GB model bundle, or download-only?
3. **Signing:** Azure Trusted Signing (cheaper, needs an identity check) or a purchased OV/EV certificate?
4. **Linux arm64:** support it from day one (DGX Spark, Jetson, Ampere servers), or x64 only at first?
