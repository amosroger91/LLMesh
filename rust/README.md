# Rust foundation (preview)

The Node app remains the shipping implementation. This workspace starts R0 and
the portable quote and placement contracts from R1/W0. It does **not** serve inference, enroll
devices, sign into Nostr, implement FIPS, or replace the desktop daemon.

```sh
cd rust
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all --check
cargo build -p llmesh-web --release --target wasm32-unknown-unknown --locked
cargo run -p llmesh -- --version
```

`llmesh quote` reads a JSON quote input from stdin. Both Node and Rust tests read
`fixtures/quotes.json`. Placement tests read `fixtures/placement.json`, with 98
cases covering levels, modes, mixed hardware and invalid selections. WASM exports
`quoteWork` and `planPlacement` using the same native implementations;
JS bindings are generated with the matching wasm-bindgen CLI when packaging the
future web app. A compiled WASM module is not yet a web application.

Only implemented crates are added; remaining architecture crates are introduced
with their implementation, dependency review and tests. Adding empty crates would
not establish daemon parity. See `docs/rust-parity.md` and the phase acceptance
gates in the plans. Sovereign is only a reserved mutually exclusive build feature
at present: it does not certify or enable FIPS until R4.
