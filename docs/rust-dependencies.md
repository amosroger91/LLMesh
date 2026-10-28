# Rust dependency review

Checked the official crates.io API on 2026-10-28 before adding dependencies.
All three selected direct dependencies have recent releases and active upstream
repositories. Exact direct versions and the full transitive graph are locked.

| Crate | Latest stable checked | Last registry update | Upstream |
| --- | --- | --- | --- |
| serde | 1.0.229 | 2026-07-18 | https://github.com/serde-rs/serde |
| serde_json | 1.0.154 | 2026-10-11 | https://github.com/serde-rs/json |
| wasm-bindgen | 0.2.129 | 2026-09-25 | https://github.com/wasm-bindgen/wasm-bindgen |

`serde_json` preserves object insertion order for JS fixture compatibility. Add
explicit fixtures for numeric object keys and floating-point serialization before
using serialized lengths at arbitrary tool-schema pricing boundaries. No other
planned crate has been added or implicitly declared maintained. Repeat registry,
advisory and license review when introducing each runtime/security dependency.
