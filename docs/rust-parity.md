# Rust parity and cutover gate

An unchecked row blocks cutover. Neither documentation nor an empty crate counts
as implemented behavior. Node stays active until all required Rust rows pass.

| Feature | Node | Rust | Evidence / remaining work |
| --- | --- | --- | --- |
| Version command | Yes | Yes | Rust CLI preview |
| Token-usage reservation/charge | Yes | Partial | Uniform input/output-token billing, shared reservation fixtures; arbitrary schema serialization edge cases remain |
| Chat validation/tool calls | Yes | No | Port normalized validation and shared fixtures |
| Hardware discovery/placement | Yes | Partial | Rust pure planner passes 98 shared cases; native probes and N-API integration remain |
| Routing and observations | Yes | No | Share worker/route fixtures |
| Ollama pool/offline bundles | Yes | No | Native process manager and engine conformance |
| OpenAI HTTP/SSE, receipts | Yes | No | Black-box dual-daemon suite required |
| Admin/config/drain/metrics | Partial | No | Node CLI integration and Rust daemon pending |
| Local ledger/history | Yes | No | SQLite migration and recovery tests |
| Mesh authentication/streaming | Yes (Hyperswarm) | No | R3 libp2p; coordinated protocol cutover only at R5 |
| Escrow/grants/settlement | Yes | No | R4; token feature excluded from Sovereign |
| Group PKI/privacy sealing | No | No | Rust only, R3 |
| Audit/FIPS/Sovereign | No | No | R4; no certification claimed |
| Electron sidecar integration | No | No | R5 only after parity |
| Termux requester packaging | No | No | A1 alongside Node releases |
| Native Android | No | No | A2 after R3 |
| WASM portable contracts | No | Partial | Quote and placement exports compile; browser integration and remaining contracts pending |
| Nostr QR / shared accounts | Partial | No | Signed, expiring worker-only browser enrollment; full NIP-46 remains I1–I2 |
| PWA requester / browser worker | Partial | No | WebLLM worker and encrypted PeerJS desktop link; PWA requester remains W1 |
| Donated API capacity | Yes | No | Opt-in third-party source, metered usage and encrypted local keys |

Physical Linux x64/arm64 systemd, Android and cross-network NAT tests must be
recorded separately before marking their gates complete. CI workflow definitions
are not evidence that the hosted jobs have run successfully.
