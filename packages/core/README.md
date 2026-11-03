# @wudao-org/core

The engine inside [wudao-harness](https://github.com/feiniaojin/wudao-harness) — the agent loop, tool interface, session persistence, context compaction, and subagent machinery, with no dependency on any model vendor.

If you're building an agent runtime on top of a battle-tested loop, this is that loop: typed state transitions, streaming, append-only sessions you can resume and fork from any point, and cheapest-first compaction that never breaks your provider's prefix cache.

- Any OpenAI-compatible provider works; reasoning models (DeepSeek / GLM / Qwen / Kimi / MiniMax) are first-class.
- MIT license.

Want the whole thing ready to use? `npm install -g wudao-harness`.
