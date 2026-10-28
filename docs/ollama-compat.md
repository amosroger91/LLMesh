# Ollama compatibility

Pinned runtime/container: **0.40.2**, verified 2026-10-28. The installed Windows binary reports this version. Runtime compatibility is checked before managed startup; external instances report their version in status.

| Control | Verification / use |
| --- | --- |
| `OLLAMA_HOST`, `OLLAMA_MODELS` | Pinned configuration source; separate loopback ports, shared cache |
| `OLLAMA_SCHED_SPREAD` | Pinned scheduler reads it; enabled only for split groups |
| `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_KEEP_ALIVE` | Pinned configuration source; one loaded model per instance |
| `CUDA_VISIBLE_DEVICES` | GPU UUID selection; supported by GPU documentation and pinned runner environment code |
| `ROCR_VISIBLE_DEVICES` | Linux ROCm selection; pinned runner environment code |
| `HIP_VISIBLE_DEVICES` | Numeric ROCm selection on Windows; pinned runner code |
| `GGML_VK_VISIBLE_DEVICES` | Numeric Vulkan selection; pinned runner code |

**Qwen3.5 has one slot per instance.** The pinned scheduler explicitly caps `qwen35` and `qwen35moe` at one. Extra GPUs can still run independent copies. Larger contexts/parallelism require additional memory. Placement is an estimate, not proof of physical distribution; inspect runtime process/device metrics during the manual tests.

Sources: [pinned configuration](https://github.com/ollama/ollama/blob/v0.40.2/envconfig/config.go), [scheduler](https://github.com/ollama/ollama/blob/v0.40.2/server/sched.go), [runner device environment](https://github.com/ollama/ollama/blob/v0.40.2/ml/device.go), [GPU support](https://docs.ollama.com/gpu).

AMD sysfs detection is a fallback inventory; confirm ROCm runtime ordinals with `llmesh doctor` before using explicit selection. Mixed backends never share one split group. Windows auto placement reserves 1.5 GB for GPU 0 plus compute buffers. No two-GPU or AMD physical validation has been performed on the development machine.
