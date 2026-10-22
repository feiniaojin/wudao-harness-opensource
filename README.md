# wudao-harness

A from-scratch, production-grade **agent harness** in TypeScript — the runtime scaffolding around an LLM (agent loop + tools + context + control).

> Agent = LLM + Context + Tools. The harness is everything on the right side of that equation.

Built to target **reasoning models** (DeepSeek / GLM / Qwen / Kimi / MiniMax) via OpenAI-compatible and Anthropic-wire providers, with a clean, layered, provider-agnostic core.

## Quick start

```bash
git clone https://github.com/feiniaojin/wudao-harness-opensource.git
cd wudao-harness-opensource
pnpm install && pnpm build

# Drop a .env with your key (gitignored)
echo "WUDAO_API_KEY=sk-your-key" > .env

# Run
pnpm cli "read package.json and tell me the version"
```

## What's inside

| Package | What it does |
|---|---|
| `packages/core` | Agent loop, tools, sessions, context management, subagents, workflows |
| `packages/providers` | Model adapters: DeepSeek, GLM, Qwen, Kimi, MiniMax |
| `packages/cli` | CLI + TUI: streaming, steering, slash commands, permissions |
| `packages/web` | Web frontend (React 19) — same session, browser access |
| `packages/server` | WebSocket server powering the web UI |
| `packages/evals` | Deterministic regression eval suites |
| `packages/slack` | Slack bot frontend |
| `packages/builtin-tools` | read/write/edit/grep/glob/bash built-in tools |
| `apps/desktop` | macOS desktop app (Tauri) |

## Key features

- **Agent loop** — typed transitions, streaming, steering mid-run
- **Tools** — fail-closed defaults, 5-layer permission pipeline, concurrency control
- **Context** — 4-layer model, cheapest-first compaction, prefix-cache byte invariants
- **Sessions** — append-only JSONL, resume, fork, branch, cross-process leases
- **Workflows** — deterministic JS scripts with journaled replay & purity detection
- **Computer use** — macOS screen observation, stable element IDs, settle verification
- **Subagents** — background agents, roles, child sessions, write scopes & budgets
- **Extensibility** — skills, plugins, hooks, MCP servers, TS/Python extensions
- **Security** — permission modes, sandbox, write-verify, workspace confinement

## Documentation

| Doc | Contents |
|---|---|
| [Full Guide](docs/GUIDE.md) | Everything: providers, core concepts, TUI, orchestration, plugins, security, config |
| [Architecture](docs/ARCHITECTURE.md) | Design decisions, layer boundaries |
| [Protocol](packages/server/PROTOCOL.md) | WebSocket wire contract for the web UI |

## Providers

| Provider | Endpoint | Default model |
|---|---|---|
| DeepSeek (default) | `https://api.deepseek.com` | `deepseek-v4-flash` |
| GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-max` |
| Kimi | `https://api.kimi.com/coding` | `k3-256k` |
| MiniMax | `https://api.minimaxi.com/anthropic` | `MiniMax-M3` |

All providers share one OpenAI-compatible engine (SSE parser, reasoning_content surfaced) plus an Anthropic-wire adapter. `--provider <name>` selects; `--model <name>` overrides.

## Frontends

```bash
wudao "prompt"           # CLI one-shot
wudao                    # TUI (interactive)
wudao ui                 # Web UI (localhost WebSocket)
```

## Development

```bash
pnpm install
pnpm build          # build all packages
pnpm test           # run all test suites
pnpm eval           # run deterministic eval suites
```

## License

MIT — see [LICENSE](LICENSE).
