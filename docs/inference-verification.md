# Inference verification — 2026-10-28

Checks performed without desktop mouse/keyboard automation:

- `npm run check`: syntax, Solidity compilation, and 108 passing Node tests.
- `npx eslint src scripts test` and `npx tsc --noEmit`: passed.
- `npm run build:ui` and `npm run build:web`: passed.
- Browser asset verification: 36 complete files, 908,219,779 verified bytes.
- Hidden Electron smoke: isolated test storage; Settings location and unique runtime controls; navigation, graph rendering, pairing guards, companion response rendering, and secret withholding. Test screenshots are ignored local artifacts, not captured user-desktop screenshots.
- `npm run test:live`: passed against the existing normal Qwen3.5 4B Q4_K_M worker and an additional CPU llama.cpp worker using the pinned Huihui abliterated 4B GGUF. Both remained ready simultaneously, produced concurrent HTTP 200 responses with authoritative token usage, and normal SSE reached `[DONE]`. Missing abliterated opt-in returned HTTP 400. Auto routing chose the normal model. Disabling the secondary left the normal model available.
- Native vault workflow 40757407315: completed successfully; all 31 pinned assets archived and final `vault.json` published in the `model-vault-v1` release. A transient failed transfer was retried; the final archive is complete.

Throughput is workload-dependent. The startup benchmark supplies an initial sample; real generations update a time-weighted average. Public advertisements remain participant-reported, while local/requester-observed completed usage supplies measured rankings. No live donated-provider request or payment-network deployment was performed for these inference checks. Browser loading from repository-backed weights was exercised earlier; this check does not claim that every phone/browser supports WebGPU or tools. Concurrent CPU residency can trigger paging on smaller machines.
