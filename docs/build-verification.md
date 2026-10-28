# Local build verification

2026-10-28, Windows x64, Rust 1.96.0.

Cargo itself was runnable. The initial Windows Code Integrity log (event 3077)
identified generated dependency build scripts as blocked, with Cargo as their
parent process. On retry those executables ran. No Windows security-policy,
registry, Defender exclusion or certificate-store changes were made by this task.
The exact pinned toolchain was installed with rustup.

Verified locally:

- Rust workspace unit/shared-fixture tests.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`.
- `cargo fmt --all --check`.
- Release WASM compilation for `wasm32-unknown-unknown`.
- Shared Node/Rust quote fixtures, including UTF-16 character accounting.
- 98 shared placement cases: contribution levels, placement modes, mixed GPUs,
  explicit selection, Windows display reserve and invalid options.

The Rust implementation is a foundation, not a replacement daemon. Cross-target
release binaries, browser-executed WASM conformance, Android device tests and
physical multi-GPU runs are not established by these checks. CI definitions must
be observed running successfully before counting their acceptance gates complete.

Subsequent checks cover metered input/output credits, escrow v4 unused-budget
refunds, local starter-balance migration, donated API consent/usage/quota handling,
browser-worker routing, QR-session encryption/replay rejection and concurrent
local/remote scheduling. Electron smoke covers the graph, donation panel and
one-use worker-pair approval without issuing wallet credentials.

The prior Rust native quality jobs passed on Windows, Ubuntu x64 and Ubuntu arm64.
Its dependency-policy job exposed missing explicit workspace versions and the
permissive Zlib license used by foldhash; those are corrected in the next revision.
WebLLM model downloads on physical browsers, public PeerJS/NAT pairing and live
Groq/OpenRouter account billing have not been established by synthetic tests.
