# @wudao-org/providers

Model adapters for [wudao-harness](https://github.com/feiniaojin/wudao-harness) — one `ModelClient` interface over DeepSeek, GLM, Qwen, Kimi, and MiniMax, plus anything OpenAI-compatible.

Handles the parts that differ per vendor so your agent code doesn't have to: streaming reasoning content, prefix-cache-stable serialization, reasoning-effort parameters, retry and rate-limit behavior. Swap providers without touching the agent.

- MIT license.

Want the whole thing ready to use? `npm install -g wudao-harness`.
