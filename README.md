<p align="center"><img src="assets/pet.png" alt="The wudao-harness desktop pet" width="120"/> → <img src="assets/power-figure.png" alt="its grown-up form" width="120"/></p>

<p align="center"><em>Vision: from slime to Cthulhu.</em></p>

# wudao-harness

English | [简体中文](README.zh-CN.md)

wudao-harness puts a large language model to work: it reads and writes your code, runs commands, searches the web, and drives your computer to carry a task from start to finish — not just chat about it.

One API key and you're running the whole thing. The major Chinese reasoning models are supported natively — not through a compatibility shim: their reasoning streams in real time, and long tasks stay on budget.

## Install

### Desktop app (recommended)

Download the installer from [Releases](../../releases):

- **macOS** — `Harness_<version>_universal.dmg` (Intel + Apple Silicon)
- **Linux** — `Harness_<version>_amd64.deb`

### From source

```bash
git clone https://github.com/feiniaojin/wudao-harness-opensource.git
cd wudao-harness-opensource
pnpm install && pnpm build
npm install -g packages/cli
```

### npm

```bash
npm install -g wudao-harness   # pending first publish — use a Release or source until it lands
```

## Setup

Set your API key (one is enough):

```bash
# DeepSeek (default)
export WUDAO_API_KEY=sk-your-deepseek-key

# Or use another provider
export WUDAO_API_KEY=sk-your-glm-key
wudao --provider glm "hello"
```

Or create a `.env` file in your project:

```bash
echo "WUDAO_API_KEY=sk-your-key" > .env
```

## Usage

### One-shot

```bash
wudao "read package.json and list all dependencies"
wudao "find all TODO comments in src/"
wudao "explain what this repo does in 3 sentences"
```

### Interactive TUI

```bash
wudao
```

Streamed responses, tool call cards, reasoning collapse, todo board, steering (type mid-run), permission prompts.

### Web UI

```bash
wudao ui
# → opens http://127.0.0.1:<port>/#<token> in your browser
```

Same session, browser interface. Works on the desktop app too.

### Switch provider / model

```bash
wudao --provider glm "hello"               # GLM Coding Plan
wudao --provider kimi "hello"              # Kimi
wudao --provider minimax "hello"           # MiniMax
wudao --model deepseek-v4-pro "hello"      # specific model
```

| Provider | Flag | Default model |
|---|---|---|
| DeepSeek | `--provider deepseek` | `deepseek-v4-flash` |
| GLM | `--provider glm-code` | `glm-5.3` |
| Qwen | `--provider qwen` | `qwen3-max` |
| Kimi | `--provider kimi-code` | `k3-256k` |
| MiniMax | `--provider minimax-code` | `MiniMax-M3` |

## Core features

**Agent loop** — typed transitions, streamed tokens, steering mid-run (type while the agent is working), automatic retry with failure classification.

**Tools** — 20+ built-in (read/write/edit/grep/glob/bash/web_search/computer_use), fail-closed permission pipeline (deny → ask → allow → safety check), concurrency-safe batching.

**Context management** — long conversations compact automatically: redundant tool output goes first, then older dialogue — never your code facts; cached tokens are never wasted, so long sessions stay fast and cheap.

**Sessions** — append-only JSONL, resume any past session (`wudao --resume <id>`), fork from any point (`/rewind`), branch and compare. Crash-safe: torn writes self-heal on next load.

**Workflows** — write deterministic JS scripts that orchestrate multi-step tasks with journaled replay (crash → resume → zero duplicate model calls), purity detection (non-deterministic scripts fail loudly), and script-level command gates (`run()` with allowlisted commands).

**Subagents** — background agents with roles (roster files), write scopes & budgets, resumable child sessions, cross-process coordination.

**Computer use** (macOS) — screen observation with stable element IDs, click/type/scroll/drag actions, settle verification (wait for UI to stabilize after actions).

**Extensibility** — skills (markdown task templates), plugins, hooks (pre/post tool call interception), MCP servers, extensions (write TypeScript or Python code that runs inside the harness).

## Packages

| Package | npm name | What it does |
|---|---|---|
| core | `@wudao-org/core` | Agent loop, tools, sessions, compaction, subagents |
| providers | `@wudao-org/providers` | DeepSeek/GLM/Qwen/Kimi/MiniMax adapters |
| cli | `wudao-harness` | CLI + TUI (the `wudao` command) |
| web | `@wudao-org/web` | Web frontend (React 19) |
| server | `@wudao-org/server` | WebSocket server for web UI |
| evals | `@wudao-org/evals` | Deterministic eval suites |

## Documentation

- [Full Guide](docs/GUIDE.md) — every feature, every flag, every config option
- [Architecture](docs/ARCHITECTURE.md) — design decisions and layer boundaries
- [Protocol](packages/server/PROTOCOL.md) — WebSocket wire contract
- [Onboarding](docs/onboarding/README.md) — new-contributor reading path: constants first, loop first, one motto per mechanism, reference-comparison table

## Development

```bash
pnpm install
pnpm build          # build all packages
pnpm test           # run all test suites (~5000 assertions)
pnpm eval           # deterministic eval suites
```

## License

MIT
