# wudao-harness

A from-scratch, production-grade **agent harness** in TypeScript — the runtime scaffolding around an LLM (agent loop + tools + context + control). Built to target **domestic reasoning models** (DeepSeek / Wudao / GLM / Qwen) via an OpenAI-compatible provider, with a clean, layered, provider-agnostic core.

> Agent = LLM + Context + Tools. The harness is everything on the right side of that equation.

**Status:** v0.3.42 — every package ships vitest suites (`pnpm test`) and the deterministic regression evals are green (`pnpm eval`; det-* + deterministic suites, live-verified against DeepSeek `deepseek-v4-flash` with a `.env` key). History: one line per milestone in [CHANGELOG.md](CHANGELOG.md). Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/research/](docs/research/).

## Contents

- [Quick start](#quick-start) — install, the frontends, provider matrix
- [Core concepts](#core-concepts) — loop, tools, sessions, KV-cache invariants, compaction
- [Interactive TUI](#interactive-tui) — steering, board, plan, rewind, ask, mentions, resume
- [Orchestration](#orchestration) — subagents, roles, background registry, write scopes, workflows, PTC
- [Extensibility](#extensibility) — skills, the upstream format plugins, extensions (code!), hooks, MCP, keybindings
- [Examples](#examples) — copy-paste extensions, agent roles, and a full demo plugin
- [Security & trust](#security--trust) — permissions, sandbox, git safety, edit truth, limitations
- [Configuration reference](#configuration-reference) — every flag, every env var, every file
- [CI (GitHub Action)](#ci-github-action) — run the agent headlessly in workflows
- [Development](#development) — build, test, eval, architecture

## Quick start

```bash
cd wudao-harness
pnpm install
pnpm build          # cold tree: `pnpm --filter @wudao/core build && pnpm build` (workspace order)
```

**Deterministic demo (no API key):**

```bash
pnpm demo
# → scripted model reads a fixture file and answers, printing the loop trace
```

**Real model (DeepSeek / GLM / Qwen / Wudao — any OpenAI-compatible):** drop a gitignored `.env`; the CLI auto-loads it (walks up from cwd):

```sh
WUDAO_API_KEY=sk-...
# provider defaults cover baseUrl/model — WUDAO_BASE_URL / WUDAO_MODEL still
# override them (OPENAI_BASE_URL / OPENAI_MODEL work as fallbacks).
```

### Frontends

| Frontend | Command | What |
| --- | --- | --- |
| **One-shot** | `pnpm start "<prompt>"` | Single prompt → tools → answer → exit. Scriptable. |
| **TUI** (default) | `pnpm start` (no args, real terminal) | Full Ink interactive experience — see [Interactive TUI](#interactive-tui). |
| **REPL** | `pnpm start --no-tui` | Plain readline loop — same slash commands, no steering. |
| **Web** | `wudao ui` | Browser frontend with TUI full parity — see the note below. |
| **Slack** | `wudao slack` | Bolt Socket Mode chat frontend — threads are sessions, asks are Block Kit buttons — see the note below. |
| **Desktop** | `pnpm desktop:build` | Tauri v2 shell wrapping the web frontend — see the note below. |

After `npm i -g wudao-harness` the same entry points live under the `wudao` bin (`wudao "<prompt>"`, `wudao --no-tui`, …).

#### Web frontend (`wudao ui`)

`wudao ui` starts the same agent session (same `buildRunPlan`/`--resume`/`--continue` flag chain as the TUI) behind a **localhost-only WebSocket server** and prints a URL like `http://127.0.0.1:<port>/#<token>` (opening it on macOS). The page is the built **web frontend** (`packages/web`, React 19 + Vite — TUI full parity: streaming markdown + code highlight, collapsible reasoning, ⏺/↳ tool cards, red/green diffs, todo board, steering/interrupt, mode cycling, the y/a/N permission modal, plan review, /resume /rewind /clear, /mission, the bottom status bar, and reconnect with history replay); before `pnpm --filter @wudao/web build` has run it falls back to the protocol placeholder reference client. Security posture: loopback bind only, Host-header allowlist, random 32-byte token carried in the URL **fragment** (never in a request line) and required as the first WS frame within 5s, single client, ping/pong keepalive. The wire contract (state/history/event channels, ops) is documented in [`packages/server/PROTOCOL.md`](packages/server/PROTOCOL.md) and mirrored into [`packages/web/src/protocol.ts`](packages/web/src/protocol.ts); `--ui-port <n>` pins the port (ephemeral by default). M63 §B adds the **settings page** (header 设置): provider cards for the full matrix (deepseek / glm / qwen / wudao=兼容端点) with status dots (可用 / 缺 Key / 缺端点), key paste saved to the credentials file (the reply is a status — the key never comes back), **测试连接** with human failure states (401→Key 无效或无余额 · timeout→网络不通 · 模型名不存在), default model/effort pickers (existing `/model` `/effort` semantics), the three-shield permission selector (只读/工作区可写/完全访问 → default/acceptEdits/auto; the risky tier is checkbox-gated), the memory toggle, and the 简洁/高级 default-mode preference (`ui.defaultMode`, global tier).

#### Slack frontend (`wudao slack`)

`wudao slack` runs the same agent sessions behind a **Slack Bolt Socket Mode** connection (local-first: one outbound websocket, **no public ingress**). A Slack thread maps to a **normal JSONL session** through the same session engine `wudao ui` uses — `/resume`, the steering queue, compaction, and the whole permission pipeline apply unchanged; the relay only swaps the ask's presentation surface. Message flow: every inbound line crosses **both allowlists** (sender AND channel — anything else is a silent drop with one log line); a **new thread's first mention** creates the session (recent thread history rides the first model call as a projection-only digest, capped at `threadContextMaxChars`), follow-ups continue it; **idle → prompt, busy → steering** (the ⏳ receipt posts back); at run end the summary posts back (md → Slack mrkdown, ≤3000 chars, with the `wudao --resume <id>` 查看会话 affordance); errors and ♻️ compaction notices relay, per-tool progress never does (noise rule). Permission asks render as **Block Kit buttons** — `[允许一次] [本会话总是] [拒绝]` — with the same sanitized summary the TUI shows; **bypass-immune steps (settings/mcp.json writes) relay without the 本会话总是 option** and "always" degrades to allow-once, so no layer can whitelist a settings write; **timeout (`slack.askTimeoutMs`, default 5min) = deny, fail-closed**; 本会话总是 records the exact session-allowlist rule the TUI's `a` records. Interactive-only tools (`ask_user`) are **disabled** in Slack-driven sessions — a call returns a refusal telling the model to ask in the thread directly. `/slack status|pause|resume` controls the daemon from inside Slack.

Configuration (**global tier only** — the project tier's `slack` node is dropped by the M57 trust gate: a cloned repo must not switch the operator's daemon on nor widen its allowlists; **credentials only ever as env-var names — values never enter settings, never logged**):

```jsonc
// ~/.wudao/settings.json (WUDAO_GLOBAL_HOME-overridable)
{
  "slack": {
    "enabled": true,                                  // false by default
    "appTokenEnv": "WUDAO_SLACK_APP_TOKEN",           // app-level token (xapp-…, Socket Mode)
    "botTokenEnv": "WUDAO_SLACK_BOT_TOKEN",           // bot token (xoxb-…)
    "allowedChannels": ["C0123456789"],               // channel ids; EMPTY = drop everything (fail-closed)
    "allowedUsers": ["U0123456789"],                  // sender ids; EMPTY = drop everything (fail-closed)
    "defaultPermissionMode": "ask",                   // ask(default)|acceptEdits|auto|read-only
    "threadContextMaxChars": 8000,
    "askTimeoutMs": 300000
  }
}
```

Both the **message** allowlist and the **button** allowlist are the same dual gate: an interactive click from a workspace member who can merely *see* an allowlisted (e.g. public) channel is ignored — only `allowedUsers` × `allowedChannels` members can approve (fail-closed when no predicate is wired). Relayed text (summaries, ask prompts) is entity-escaped, so model output containing `<!channel>`/`<!here>`/`<@U…>` posts literally and never triggers a real mention.

`wudao slack --doctor` checks settings, both tokens' env presence and prefix class (xapp-/xoxb-; values never printed), allowlist non-emptiness, and the thread map; with a bot token present it also probes `auth.test`. Thread bindings persist at `.wudao/slack-threads.json` (`{channel}:{thread_ts} → sessionId`) — restart the daemon and a thread continues its session. The inbound side is generalized behind the `InboundChannel` interface (`packages/slack`; onMessage/onCommand/reply/relayAsk/threadContext) — Telegram/Discord/webhook frontends slot in without touching the session manager. **Live checklist (needs a real bot; manual, not in `pnpm eval`):** (1) create a Slack app with Socket Mode + an app-level token (connections:write) and a bot token (chat:write, commands), invite the bot to the allowlisted channel; (2) `wudao slack --doctor` → all checks ✅ (including auth.test); (3) `wudao slack`, then @-mention the bot in a new thread → the thread gets a session and the summary posts back; (4) reply mid-run → ⏳ steering receipt, the follow-up lands in the next model call; (5) trigger a write ask → click 允许一次 / 本会话总是 / 拒绝 and watch the buttons settle; ask again after 本会话总是 → no prompt (session rule); (6) ask for a `.wudao/settings.json` write → the ask shows NO 本会话总是 button; (7) leave an ask unanswered past `askTimeoutMs` → timeout deny receipt; (8) restart the daemon, reply in the old thread → the same session resumes (`/slack status` shows the binding).

#### Desktop app

`pnpm desktop:build` produces installers (`apps/desktop`; darwin universal `.dmg` locally, nsis/AppImage/deb configured for CI): a minimal Tauri v2 shell spawns the standalone-packaged `wudao ui` server as a sidecar (random port + token read from its stdout protocol line), navigates the 1000×700 dark window to the token URL — the whole M43-A/B web stack unchanged — and terminates the sidecar on window close (SIGTERM → grace → SIGKILL fallback). Since 0.3.42 you can type `/mission <总目标>` straight into the desktop app's input box to start / view / end a mission campaign — the same ledger the CLI and web share. The workspace (`~/.wudao-desktop/workspace`, overridable) holds your `.env` and sessions. Not in any root build/test chain (its deps live in `apps/desktop`, lifecycle only via the root `desktop:*` scripts). Install, unsigned-app guidance, packaging-mode details (Node SEA probe + bundled-runtime fallback), and CI next steps: [`docs/desktop.md`](docs/desktop.md).

```bash
pnpm start "Read README.md and summarize it in one sentence."          # read_file, then answer
pnpm start "Create hello.js that prints 'hi', then run it." --auto    # write + run, no prompts
pnpm start "Use glob to list all .ts files, then grep for 'TODO'." --plan        # read-only plan round: explore → board, then ok to execute
pnpm start "Think it through: ..." --provider glm --reasoning-effort high
# → GLM profile (baseUrl + glm-4.6) with effort mapped onto GLM's native thinking field
```

### Providers

All four profiles share the same OpenAI-compatible engine (one SSE parser; reasoning text surfaced for every profile). Selection precedence: `--provider <name>` > `WUDAO_PROVIDER` > `deepseek` (default). `WUDAO_BASE_URL` / `WUDAO_MODEL` override any profile's defaults.

| Provider | `--provider` | default baseUrl | default model | `reasoningFormat` |
| --- | --- | --- | --- | --- |
| DeepSeek (default) | `deepseek` | `https://api.deepseek.com` | `deepseek-v4-flash` | `deepseek` |
| GLM | `glm` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6` | `zai` (+ `thinkingLevelMap`) |
| Qwen | `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-max` | `qwen` |
| Wudao | `wudao` | — requires `WUDAO_BASE_URL` | `wudao-preview` | `deepseek` (passthrough) |

**Reasoning-format matrix (M28).** One enum — `reasoningFormat` — fixes both sides of the wire: the request fields an effort maps onto, and which response field carries the reasoning text:

| `reasoningFormat` | request fields for an effort `<v>` | response reasoning field |
| --- | --- | --- |
| `none` | — (no reasoning parameter) | sniffed |
| `deepseek` | `{reasoning_effort: <v>}` | `reasoning_content` |
| `zai` | `{thinking: {type: enabled\|disabled}}` (+ `reasoning_effort` rider where supported) | `reasoning_content` / `thinking` |
| `qwen` | `{enable_thinking: boolean}` (+ rider where supported) | `reasoning_content` |
| `qwen-chat-template` | `{chat_template_kwargs: {enable_thinking, preserve_thinking: true}}` | `reasoning_content` |
| `openrouter` | `{reasoning: {effort: <v>}}` | `reasoning` |
| `together` | `{reasoning: {enabled: boolean}}` (+ rider where supported) | `reasoning` |
| `baseten` | `{chat_template_args: {enable_thinking: boolean}}` (+ rider where supported) | `reasoning_content` |

- **`thinkingLevelMap`** — a profile may declare an effort → native-level map; `null` marks a level the endpoint doesn't support (its field is simply not sent). GLM's `thinking:{type: enabled|disabled}` is exactly this: the `zai` envelope plus a map folding the five efforts onto enabled/disabled.
- **`WUDAO_REASONING_FORMAT`** overrides the profile's format (validated; junk fails at startup) — point the `wudao` profile at any OpenAI-compatible endpoint (OpenRouter, Together, Baseten, a vLLM box…) and select the right matrix entry without code changes.
- **`supportsReasoningEffort(baseUrl)`** — URL sniff for custom baseUrls: endpoints known to reject a top-level `reasoning_effort` rider (z.ai/bigmodel, together, moonshot, x.ai, nvidia, cloudflare gateway) never get one; the four built-in profiles pin their rider behavior explicitly.
- **Response sniffing** — the engine reads `reasoning_content` / `reasoning` / `thinking` (format-preferred order) in both `generate()` and the SSE parser, so a new endpoint's reasoning text surfaces without touching the parser.

**Reasoning effort:** `--reasoning-effort <v>` > `WUDAO_REASONING_EFFORT`; valid values `low | medium | high | max | none` (junk rejected at startup). With no effort configured the request body carries **no** extra field — the default request stays byte-identical (prefix-cache friendly). Reasoning text is rendered dimmed in every frontend but **never replayed** to the provider (replaying it would poison the prefix; the model regenerates its own reasoning each turn).

## Persona（客户端角色扮演）

`/persona` 让 wudao-harness 在 wire 上"变成"另一种 harness 客户端（the upstream format、the upstream project、cursor、opencode、the upstream format，或你自己的 JSON）。三层独立开关：

- **headers** —— 注入该客户端的请求头指纹（如 the upstream project 的 `originator`/`session_id`、the default client 的 `user-agent`）。
- **body** —— 声明式请求体风格叠加（采样/reasoning 参数等，白名单键）。
- **prompt** —— 系统提示词前缀/快照 + 工具显示名映射（`read_file→Read`）。默认关；开/切/关都会断前缀缓存（会话记录带 cold 收据）。

- 兜底：`WUDAO_PERSONA=<id>` 或 `<id>:headers,body,prompt`（子集，坏值报错不静默）。
- 自定义：`~/.wudao/personas/*.json` 与 `<workspace>/.wudao/personas/*.json`（工作区覆盖同名；schema 严格校验，未知键加载即错）。global 层的建/改/删走设置页 Persona tab（写 `~/.wudao/personas/<id>.json`，只读的内置/工作区同名文件不可覆盖）。
- 全局默认：`~/.wudao/settings.json` 的 `persona.id`（设置页 Persona tab 的「全局默认 persona」下拉；空 = 不设默认）。
- 按供应商绑定：`~/.wudao/providers.json` 卡片的 `persona` 三态 —— 键缺省 = 跟随全局默认；`"<id>"` = 绑定该 persona；显式 `null` = 强制无（全局默认永不套用）。解析链：`WUDAO_PERSONA` > 卡片绑定 > 全局默认 > 无。设置页 ProviderDetail 的「Persona 绑定」行写的就是这三态（绑定后切换 provider 即刻跟随）。
- 指纹出处与钉定版本：`docs/research/90-persona-fingerprints.md`。

> **合法性注记**：发什么头是客户端自由，但对官方端点伪装他家客户端**可能违反其服务条款**。本功能面向你自有 key 的兼容性、测试与研究，风险自担；本项目不做也不做任何规避服务商检测的设计（不伪装来源 IP、不做证书指纹欺骗）。

## Core concepts

### The agent loop

`runAgentLoop(state, model, options)` (in `@wudao/core`) is an **async generator** over a mutable `AgentState`: `while (true)` — build request → call model → yield events → execute tool batch → append results → repeat. Typed `transition` events carry the reason for each continuation; the loop ends when an assistant turn carries **no tool-call block** (`stop_reason==='tool_use'` is not trusted). Everything the outside world sees — `assistant_delta`, `tool_call`, `compacted`, `steered`, `gate`, terminals — arrives as events from this generator.

Control inputs are ordinary options, not wrappers:

- **`signal: AbortSignal`** — one cooperative cancel wired end-to-end: UI Esc/SIGINT → provider fetch → in-flight tool. Aborts surface as `{reason:"aborted"}` terminals, never thrown errors; interrupted sessions stay provider-legal (orphaned tool results are repaired on the next turn).
- **`steering: { take() }`** — a queue the loop drains **before every model call**; each drained text becomes a plain appended user message, so you can redirect the agent mid-run (see [TUI steering](#interactive-tui)).
- **`hooks: AgentHooks`** — lifecycle interceptors (`onRunStop` can force one more turn; `onPromptSubmit` can rewrite/block). Observer hooks never crash the run; gate hooks degrade to allow/original when they throw.
- **`canUseTool`** — the permission gate before every side-effecting call (see [Security](#security--trust)).
- **`gates`** — long-task todo/verify stop gates and plan-mode legitimacy (see [Long tasks](#long-tasks-the-todo-board-m23)).

### Tools

One `Tool` interface + a **fail-closed `buildTool(def)`** factory: unspecified safety annotations default to the dangerous-but-explicit choice (`isReadOnly: false`, `isConcurrencySafe: false`, `checkPermissions → allow`) — but the *default is deny at the permission layer*, not at the tool. Argument validation (`validateToolArguments`) runs **before any side effect**; errors are LLM-friendly (did-you-mean keys, truncated values, numbered closest candidates for edits). Tools marked `isConcurrencySafe` execute as a concurrent batch; the rest run sequentially. `requiresUserInteraction` (ask_user) routes with read tools; `shouldDefer` hides orchestration tools behind `load_tools` (see [KV-cache invariants](#kv-cache-invariants-m24)).

Builtin set: `read_file` `write_file` `edit` `shell` `run_script` `python_kernel` `glob` `grep` `todo_write` `task` `ask_user` (+ the meta-tool `load_tools`, + `agent_await`/`agent_status`/`agent_cancel` behind it), plus MCP tools as `mcp__<server>__<tool>`, plus the settings-gated `lsp` code-intelligence and `terminal` PTY tools (see [LSP](#lsp-code-intelligence-p2-9), [Persistent PTY terminal](#persistent-pty-terminal-p2-12)), plus the M49 memory pair (`memory_write`/`memory_search`), the M64-A peer pair (`list_agents`/`send_message`), and the `mission_*` campaign family behind `/mission` (e.g. `mission_start`/`mission_plan`). The `python_kernel` persistent compute session is documented in its own section ([Persistent Python kernel](#persistent-python-kernel-python_kernel-114)).

### Sessions & the four context layers

```
Session (append-only JSONL)  →  AgentState (mutable runtime)  →  snapshot per model call  →  ModelInput (the request)
```

- **Session** — `.wudao/sessions/<id>.jsonl`, append-only, validated on load (orphaned tool calls repaired). Non-message entries ride the same file: `session_name`, `model_change`, `thinking_level_change`, and generic `{type, data}` entries via `appendEntry` (filtered out of model-visible history). Resume with `--resume <id>` / `--continue` / the TUI `/resume` picker.
- **AgentState** — the live messages + status; **model-visible ≠ runtime-known**: compaction stubs, `<system_note>` MetaNotes, and cleared markers are *projections* onto the request, never rewrites of the persisted history (the JSONL keeps full fidelity; markers are re-derived on resume).
- **Subagent sidechains** — child agents get their own JSONL under the same store; the parent context only ever receives the child's final report.

### KV-cache invariants (M24)

Long sessions are priced by the provider's **prefix cache**: every request whose leading bytes match an earlier request's is served at a fraction of the cost. Hit-rate is a first-class engineering target — measured, pinned by evals, never silently traded away:

1. **Append-only growth.** Steering texts, gate injections, and tool results are appended, never spliced — request N's serialization is a byte prefix of request N+1's (pinned by `det-06` through the canonical serializer).
2. **One canonical serializer.** `serializePrompt(ModelInput)` (fixed key order, recursive key sort, stable header) is the single source of request bytes; every byte-prefix assertion in the repo goes through it.
3. **Stable prompt, stable tools.** The system prompt is computed **once per run** from stable inputs (cwd/platform confined to the last section); project context files (`WUDAO.md`/`AGENTS.md`/`CLAUDE.md`, M54/M54b — user-global `~/.wudao/WUDAO.md` + the `.git`-bounded parent chain) load once at startup right after `# Environment` — **no hot reload by design**; skills and MCP manifests append at the **absolute tail**; the tools array grows **at most once per run** (the `load_tools` meta-tool — deferred orchestration definitions append after it, then freeze).
4. **Compaction is priced.** Compaction fires at 0.8 × `WUDAO_CONTEXT_WINDOW`, measured with `max(estimate, real lastPromptTokens)`; "approaching" occupancy defers the rewrite to the **turn boundary** (the current call keeps its warm suffix; the next request pays one announced cold turn), ≥ threshold+8k compacts immediately. The tier-2 summary call is a **warm replay** (same system prompt + tools + the compacted span plus one trailing instruction).
5. **Fork children share the prefix.** `task({subagent_type:"fork"})` reuses the parent's system prompt, tool array, and message snapshot plus one brief — fan-out research rides the already-paid prefix.
6. **Read economics.** `read_file` pages (`offset`/`limit`, head window 2000 lines / 50KB); a re-read whose exact bytes are already in context returns an `[elided]` stub (`force=true` overrides; compaction naturally re-admits full content). `shell` output past the inline cap spills to `.wudao/spill/…`; `glob`/`grep` cap at 2000 lines / 50KB.
7. **Reasoning is never replayed** (it would poison the prefix); `stream_options:{include_usage:true}` is appended **after** the pinned key sequence so the streaming body is the non-streaming body plus two keys.
8. **Measured, attributed.** Usage flows through one channel (`onUsage`, disjoint hit/miss counts); the CLI shows per-turn `cache 94.2%`, and a miss spike is diffed through the canonical serializer → `⚠️ cache break at <tool> result (turn N)`.

### The compaction ladder

Cheapest tier that fits wins, checked before every model call:

| Tier | Mechanism | Cost |
| --- | --- | --- |
| **0 — clear** | Oldest tool results past `keepRecent` over 30k chars → deterministic `[Old tool result content cleared]` marker (pairing-safe: the message stays, content shrinks) | free |
| **1 — microcompact** | Old large tool results → frozen stubs with head previews | free |
| **2 — summary** | LLM summarizes the old span; the persisted history gains frozen `[compacted summary]` markers; the last todo board is mechanically re-injected after the summary (never left to the summarizer's memory) | one warm-replay call |

`compacted` events carry `tier: 0|1|2`; the CLI renders `clear · micro-compact · summary`. Markers are re-derived from the persisted originals on resume.

## Interactive TUI

`pnpm start` with no arguments (in a real terminal) opens the **Ink TUI** — the full interactive experience:

- **streamed markdown** with syntax-highlighted code blocks; **inline colored diffs** (red `-` / green `+`) for `edit` and `write_file`
- **multi-line input**: end a line with `\` then press Enter to continue
- **y/a/N permission prompts** inline: `y` once · `a` this session (recorded as a session-allowlist rule, path-scoped when the call carries a path) · `n` deny — optionally `n <reason>`, which flows back to the model as `permission denied: by user: <reason>` (`--auto` and the read-only `--plan` tier never prompt, except settings-file writes — see [Security](#security--trust))
- **Esc interrupts instantly** — a single AbortSignal runs from the UI into the provider fetch and tool executions; even a hung call settles in milliseconds. Ctrl+C at the prompt exits.
- **`ask_user` inline** — the model asking you one question renders with numbered options (digit picks; free-text questions take a line input; Esc dismisses → the model is told to decide itself)
- **`@path` mentions** — `@<relpath>` in any prompt (including mid-run steering) expands into `<file path=…>` blocks before the text enters the conversation: workspace-confined, 2000-line/50KB window, duplicates expand once, non-file tokens stay literal
- **sessions persist under short names** (kebab-case, ≤6 words, zh+en, derived from the first user message — shown in the header); `--continue` resumes; **`/resume`** opens a picker of the 10 most recent
- **mid-run steering**: submit while the agent is busy and the text is **injected into the running turn** — `⏳ steering: …` while parked, dim `↳ steering applied` once consumed. Append-only, so the prefix stays byte-stable. A steer landing after the run's final model call (or an Esc) falls back to a fresh run. The `--no-tui` REPL does not support steering.
- **status bar**: live context watermark (`ctx`), `cache N%` footer, `bg <active>/<spawned>` once agents fly, `defer N`, gate notices
- **plan mode** (`/plan <goal>`): a read-only planning round that ends in a todo board — then `ok` executes it, `改 <意见>` revises read-only, any other input stays a normal prompt (details below)
- **`/rewind [n|last]`**: restore the workspace to before any write step (details below)
- **remappable keys** via `.wudao/keybindings.json` — see [Keybindings](#keybindings)

`--no-tui` falls back to the plain readline REPL. When its stdin is a pipe (headless/FIFO runs), multi-line prompts are delivered as one message — end them with a blank line to send.

### Slash commands (TUI and REPL)

| Command | What |
| --- | --- |
| `/help` (`/?`) | list commands |
| `/exit` (`/quit`, Ctrl+D) | quit |
| `/clear` | start a fresh session |
| `/resume` | picker of the 10 most recent sessions (TUI only) |
| `/skill:name [args]` | invoke a loaded skill; bare `/skill:` lists them |
| `/plan <goal>` | read-only plan round → board waiting for `ok` / `改 <意见>` |
| `/rewind [n\|last]` | list / undo this session's file changes |
| `/edit [<n>]` | list recent user messages; `/edit <n>` puts one back in the input — resubmitting (edited or not) **branches** from that message's parent (M53) |
| `/tree` | ASCII branch topology: trunk, forks, the active chain marked `←` (M53) |
| `/switch [<n>]` | list branches / make one the active chain (the others stay on the tree; M53) |

Branching is durable: the active branch is recorded as a session entry, so
resuming after a restart (`--continue`, `--resume`, `/resume`) reloads that
chain — trunk up to the cut + branch — never the flattened file, and the
abandoned turns stay on the tree for `/switch` back.
| `/memory [list\|del <id>\|ok <id>\|edit]` | workspace memory store: list entries, drop one, confirm a pending suggestion (M49); `edit` opens the context files (WUDAO.md/AGENTS.md/CLAUDE.md) in `$EDITOR` — the JSONL store itself is managed via list/del/ok (M55) |
| `/search <query>` | full-text search across past sessions, CJK-aware (M49) |
| `/init` | scan the codebase with read-only tools and bootstrap `AGENTS.md` — the draft lands as a **preview**; `ok` writes it (a fresh file, or a dated **append** when AGENTS.md already exists — never an overwrite); any other input stays a normal prompt (M55) |
| `/status` | session one-pager: version, provider·model, mode, session id, context watermark, loaded surfaces (skills/plugins/extensions/MCP) — offline by default, no network probe (M55) |
| `/cost` | session usage totals from the accumulated provider usage: prompt/completion/cache-hit tokens, cache %, model calls, wall time since session start (M55) |
| `/rename <name>` | rename the current session — appends a `session_name` entry (append-only store, last wins); `/resume` and `/search` pick the name up, the TUI header refreshes (M55) |
| `/diff` | uncommitted git changes (`status --porcelain` + unstaged/staged `diff --stat`) + this session's per-turn file journal from `/rewind`'s data (M55) |
| `/config` | effective-settings view: `.wudao/settings.json` + `WUDAO_*` env overrides (secret-bearing names redacted) + parsed argv flags; `set local <key> <value>` writes the LOCAL tier (first write auto-gitignores it; escalation keys refused at the writer — same trust gate; effective next session) (M55, M62) |
| `/model [name\|number]` | list the switchable models (profile matrix + `WUDAO_MODEL`; entries numbered) / switch mid-session — appends a `model_change` entry and mutates the live provider config so the **next request** carries the new model (idle: now; mid-run: at run settle). In-session switches stay on the current endpoint (baseURL + key are provider-bound — foreign-provider models point at a `--provider` restart); `/status`, the header, and the statusline refresh (M55). M57: a bare number picks the printed ordinal; the **web** StatusBar's `model` segment opens the same list as a clickable picker (cross-provider rows disabled with the restart hint; `/effort [level\|number]` behaves the same) |
| `/effort [level]` | list / switch the reasoning effort (`low\|medium\|high\|max\|none`) — `thinking_level_change` entry, same next-turn semantics (M55) |
| `/permissions` | view / `add\|remove <allow\|deny\|ask> <rule>` the settings permission rules — the write rides the existing hot-reload (live at the next gate). Rules touching the settings-file immunity layer (`.wudao/settings.json` / `.wudao/mcp.json`) can NOT be added or relaxed here — hard rule; tightening always allowed (M55) |
| `/persona` | list personas / switch the client fingerprint (`[<id> [--headers-only\|--with-prompt]\|--off]`, next-call effect) — works in the readline REPL, the TUI, and Web (`wudao ui`) alike |
| `/export [file]` | render the session to markdown (turns, tool summaries, board snapshots); default `.wudao/exports/<session>.md`; an existing target is only overwritten after an `ok` confirmation (M55) |
| `/review [focus]` | inject a review request over the current **uncommitted** git diff as a user message (model-driven; untracked files listed for full reads; patch capped at 60k chars; locale-independent repo probe) (M55) |
| `/security-review [focus]` | the security variant — same diff envelope plus a pinned audit checklist (injection, secrets, policy bypass, SSRF, unsafe primitives, …) and a findings→verdict contract (M55) |
| `/mcp` | MCP server status: configured vs connected, tool counts per server, handshake + last-call latency, call/error counters from the loaded runtime (M55) |
| `/agents` | the agent roster — builtin / plugin / workspace tiers with pin + write-scope summaries (frozen roles refuse overrides; `writeScope` roots/exact files; worktree/allowShell) and shadowing receipts (M55) |
| `/loop` | the dynamic pacing loop — fixed interval, self-paced, or stop (M61 §2) |
| `/goal <goal> [--gate <cmd>]` | condition-driven end state with a verification gate + budget — fire when the goal is met (M61 §3) |
| `/mission <总目标>` | start / status / end a **task campaign** — cross-session mission ledger, each finished task's verification re-run before later tasks complete (slash and ledger since 0.3.41; the desktop app's input box and the model's own `mission_start` entry since 0.3.42) |
| `/schedule [list\|add\|del]` | manage the durable scheduled-task group (cron; M61 §4) |
| `/btw <question>` | a side question answered on the session's cached prefix — off the main line (夜移 014) |
| `/compact [focus <q>]` | compact now, manually; optional `focus <q>` steers the tier-2 summary (M52 §1) |
| `/context` | context occupancy breakdown over the live projection (M52 §3) |
| `/provider [name]` | switch the provider profile mid-session (`--provider` semantics; M63 §A) |
| `/language [code]` | the session language lane (M47) |
| `/add-dir <path>` | add a directory to the session's workspace (M55 §C) |
| `/doctor` | offline diagnostics: settings parse, credentials-file key count, trash residency (M55) |
| `/<plugin-command> args` | the upstream format plugin command templates (if plugins installed) |
| `/<ext-command> args` | extension-registered commands (if extensions installed) |

### Long tasks: the todo board (M23)

Long tasks are driven by a **todo board**, not the turn counter:

- **`todo_write` (dual write)** — the model maintains a full-replacement board (max 50 items, ≤200 chars each, exactly 0 or 1 `in_progress`). The tool *result* is the formatted board, so it lives in the conversation as in-context task state; a human copy lands at `.wudao/plan.md` (disk failures degrade to a warning — the context board is authoritative).
- **Stop gates** — before a no-tool-call stop is accepted: the **todo gate** (incomplete items → one more nudge; let through after `gateMaxInsists`, default 3) and the **verify gate** (writes ran but nothing was executed since → "verify with shell"). Gates fire at a no-tool-call seam as ordinary appended user messages (cache-friendly); both merge into one injection.
- **Turn fuse** — `maxTurns` is a runaway fuse (default 200; `WUDAO_MAX_TURNS=0` = unlimited), not the stop condition.

Config: `.wudao/settings.json` `{"longTask": {"todoGate": true, "verifyGate": true, "gateMaxInsists": 3, "maxTurnsFuse": 200}}`; `WUDAO_LONG_TASK_GATES=off` is the emergency kill switch. In the TUI the board renders as a colored checklist (☑/◐/☐), gate injections appear as yellow notices, and the live area shows `▣ 3/7` progress.

### Plan mode, rewind & git safety (M37)

Three safety flows around writes:

- **Plan mode (`/plan <goal>` + one-shot `--plan "goal"`).** The plan run is **read-only**: the tool whitelist (`read_file`/`glob`/`grep`/`agent_status` + `todo_write` — the plan IS the board — and `ask_user`) layers before the permission gate; out-of-whitelist calls are denied with `plan mode is read-only — …`. The todo gate changes meaning for that run (`LoopGates.plan`): a stop is legitimate as soon as a **board exists**. The user then reviews at the prompt: **`ok`** (or `y`/`yes`/`go`/`好`/`可以`/`执行`) executes the board with normal tools; **`改 <意见>`** runs another read-only revision round; anything else stays a normal prompt while the board keeps waiting. One-shot `--plan` prints the board and (on a TTY) offers `execute this plan? [y/N]`.
- **File-history rewind (`/rewind [n|last]`).** Every **successful** `write_file`/`edit` snapshots the target's pre-write state under `.wudao/history/<session>/` (`<seq>-<basename>` + append-only `index.jsonl`). `/rewind <n>` restores the workspace to **before step n** (undoes steps ≥ n in reverse order; an undone create deletes the file) and truncates the index; `/rewind last` undoes exactly the latest step. Rewind never touches message history: read-state entries for restored files are invalidated (the next edit demands a fresh read) and the model is informed via a `<files_rewound>` MetaNote. Snapshot recording is fail-open for writes; rewind itself is fail-closed. Worktree children keep no history (their changes are git-diffable).
- **Git-safety asks.** Inside a git repo, before `shell` executes, a static token-based check recognizes high-risk shapes (`git reset --hard`, `git clean -f…d…` in any flag spelling, `git push --force`/`-f`/`--force-with-lease`, `git checkout -- .`/`git checkout .`, `git branch -D`; global options like `git -C <path>` and risky flags at any position are caught; shell separators end an invocation). A match **upgrades the permission ask text** with a `⚠️ high-risk git command` block — at all three ask sites; nothing is blocked. Outside a git repo or under `--auto` there is no warning.

### Memory & self-improvement (M49)

Cross-session memory with a human in the loop — the workloop scorer's two weak axes (learning capture, delivery reliability) are this milestone's targets:

- **Store + assessment gate.** `.wudao/memory.jsonl` is append-only; every entry `{id, kind: fact|preference|skill_note, content, scope, tags, created, hits, status}`. A write **auto-allows only when** it is bounded (≤500 chars), non-sensitive (credential-shaped regex — `sk-…`, `ghp_…`, AKIA, private-key headers, api-key/secret/token/password vocabulary), relatively new (token-set Jaccard < 0.7 vs every existing entry; CJK bigrams, so 中文 near-duplicates are caught too), and **project-scope**. Everything else — and ALL `scope: "user"` writes — queues as **pending**: surfaced to you exactly **once** at the next session start, confirmed with `/memory ok <id>` or dropped with `/memory del <id>` (still listed in `/memory list` until decided).
- **Bounded recall.** At every run start up to 4 active memories (≤2400 chars) that tag-match the prompt or recent session ride the **MetaNote channel** into the model's first call — prefixed `Relevant memories (auto-recalled, may be imperfect):` — projection-only: the persisted conversation never gains a message. `hits` counts recalls (shadow-ranking telemetry; ranking stays score-based until the data says otherwise).
- **Tools.** `memory_write` (assessed, never bypasses the gate) and `memory_search` at top level; children get **search only**.
- **Background review fork.** After a successful run with ≥3 tool calls, a shareContext fork (warm prefix; write tools execute-refused with byte-identical definitions; `maxTurns` 2) reviews the transcript and proposes ≤3 memories through the same assessment. Receipt: `🧠 review: N suggestions (M auto, K pending)`. Kill switch: `WUDAO_BG_REVIEW=off`. User-scope suggestions land pending at most — the review never writes the user domain directly.
- **CJK session search.** `.wudao/search-index.json` — a zero-dependency inverted index (latin words + CJK bigrams) updated incrementally as sessions append (≤50ms/entry; a corrupt or stale index rebuilds itself from the JSONLs). BM25-lite ranking; `wudao sessions search <q>` and `/search <q>` share one engine. User/assistant messages are indexed (tool-result bulk content is not).
- **Tool-result taint.** `read_file` results carry provenance `user-file`, MCP results `mcp` — a runtime annotation on the `tool_call_finished` event, never on the message, the wire, or the JSONL. The frontends taint-track via a WeakMap side channel: verbatim re-packaging (a Pass/Forward tool re-shipping file bytes) inherits the taint; model-generated paraphrase does not (honest limit: taint cannot cross model generation). When a gated call's **arguments** embed tracked content — e.g. the model copying file-borne "instructions" into a `shell` — the sidecar classifier's input carries an `[untrusted] content_provenance` note so those instructions read as data (see ADR-009's amendment).

## Orchestration

The `task` tool is the orchestration surface: **roles** from a roster, **background** dispatch through a registry, **resumable child sessions**, per-role **worktree isolation**, **write scopes**, **adaptive budgets**, and **resume lineage**. The model is the orchestrator — the harness supplies primitives. On top of it, **workflow scripts** turn the same engine into a deterministic, replayable pipeline.

### Roles (roster files)

A role is a JSON profile — builtin or workspace-owned (`.wudao/agents/<role>.json`):

```jsonc
{ "description": "...", "systemPrompt": "...", "toolNames": ["read_file", "glob", "grep"],
  "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "high",
  "maxTurns": 25, "sandbox": false, "worktree": false, "frozen": false,
  "writeScope": { "roots": ["packages/cli/"], "exactFiles": ["README.md"] }, "allowShell": false }
```

- **Builtins** — `general-purpose` (read-only, default), `coder` (full tools), `fork` (shares THIS conversation — warm-cache fan-out), `manager` (decompose + dispatch + synthesize; never edits), `adversarial-reviewer` (attack the change; SHIP/FIX-FIRST verdict), `consultant` (reasoning-heavy advisory; effort `high` by default).
- **Discovery** — builtin < workspace (single directory level). A workspace profile shadowing a builtin name is reported in the task result; a malformed file degrades to a warning, never a broken tool set.
- **Frozen** — `"frozen": true` pins provider/model/effort; a call passing overrides against a frozen role fails closed. Frozen pins cannot be escalated by the model at call time.
- **Reasoning receipt** — every task result records `reasoning: {requested, effective}`: what the caller asked for vs. what the child's resolved call actually carries. Example profiles: `examples/agents/reviewer.json`, `examples/agents/explorer.json`.

### Background agents (registry)

```
task({ description, prompt, role: "coder", background: true })   →  bg-1 (returns immediately)
agent_await({ ids: ["bg-1","bg-2"], mode: "all" })                →  both reports
agent_status()                                                    →  id/role/state/seconds snapshot
agent_cancel({ id: "bg-1" })                                      →  stop one (discard)
```

- **Concurrency** — at most `maxConcurrent` agents (default 3, ceiling 16); extras queue. Spawns hand back `bg-N` ids with the spawn's `reportSchema` attached (validated at collection by the M29 subset validator).
- **Await modes** — `all` (error if any failed) · `allSettled` · `any` (first success) · `race` (first to settle). Reports cap at 4000 chars in the parent context; the registry keeps full text.
- **Parent abort kills all** — Esc/^C, leaving the TUI, or process end cancels every in-flight agent. Background children never see orchestration tools (no recursive spawning).
- **TUI** — `bg <active>/<spawned>` in the status bar; every user turn re-lists in-flight agents once; a first background spawn with no first-hand parent work prepends a one-line pilot advisory (a nudge, not a veto).

### Resumable child sessions & worktrees

- `task({ …, session: "new" | "resume:<id>" | "fork:<id>" })` gives a child a durable identity: its transcript lives in its own sidechain file, `resume` rehydrates it through a spawn-byte-identical build path, `fork` continues from a prior child session's edge. The parent only ever receives the **final report** — a 40-turn exploration costs the parent one message. One writer per session id (`single-writer guard`).
- A role with `"worktree": true` gets its child a separate git worktree (`.wudao/wt/<sessionId>/<role>-<n>`, branch `wudao/<run>/<role>-<n>`) so parallel coders never collide; the child's tools re-root at the worktree; the worktree is retired with `git worktree remove` + `branch -d` (never `-D`). Without a git repo the child degrades to the main workspace with an explicit note.

### Write scopes & budgets (M31)

- **Write scopes.** `writeScope {roots, exactFiles}` (workspace-relative; glob-prefix on path segments — `src/lib` covers `src/lib/a.ts`, never `src/libX/a.ts`). Enforcement wraps the child's `write_file`/`edit`/`shell` fail-closed at spawn; reads are never touched; `shell` is exempt only under `--sandbox` or role `allowShell`. Worktree and fork children are exempt. `taskWriteScope` narrows one dispatch (never widens; wider fails closed). Live overlapping scopes warn on the spawn receipt; `agent_await` keeps both candidates with their scopes; a `strictOverlaps` registry refuses outright.
- **Adaptive fan-out budget.** Finished children append `{turns, ok, budgetLimited}` samples to `.wudao/agents-stats.json` (per-role, last 50). Without an explicit `maxTurns`, the budget = **median of successful non-grace samples** clamped to **1.25 × observed success max** (budgets only rise on evidence); `<3` samples → role default (`maxTurns ?? 20`). Explicit `maxTurns` always wins; `suggestBudget: false` skips one dispatch; `WUDAO_AGENT_BUDGETS=off` disables the feature. Receipts carry `budget {suggested, used, budgetLimited}`.
- **resume_from lineage.** Every `task` call gets a stable id (`t-1`, `t-2`, …). `task({ …, resumeFrom: "t-1" })` continues that task's child session instead of starting fresh — explore→implement→verify chains never re-read the repository. `agent_status` rows carry `callId`/`parentCallId`; the TUI relist marks lineage (`bg-2 ← t-1`).

### Workflows (JS is the workflow language)

A workflow is a **plain JavaScript program** whose file body the engine executes (`wudao workflow run <file.js>`). Loops, conditionals, matrices and dynamic work lists come free from the language — there is no DSL. The engine injects seven primitives; everything else is ordinary `async/await`:

> ⚠️ **Trust note:** a workflow file is **code you run** — the same trust class as `.wudao/` config, not a data file. The `Date`/`Math.random` throwing stubs are a **determinism tripwire, not isolation**: the script executes in-process with full JS capability, and its tasks drive real tools under the normal permission gate. Read a workflow before you run it, exactly like a hook script.

```js
// triage.js — loop until the budget runs low, then summarize
const findings = [];
for (let i = 0; i < 3 && budget.remaining > 100000; i++) {
  const r = await task(`audit module ${i}`, {
    label: `audit-${i}`,
    allowTools: ["read_file", "grep"],
    responseSchema: { type: "object", required: ["issues"], properties: { issues: { type: "array", items: { type: "string" } } } },
    verify: [{ fileExists: { path: `module-${i}.ts` } }, { jsonPath: { path: "issues", equals: [] } }],
  });
  if (r.ok) findings.push(...r.data.issues);
}
const summary = await parallel([
  () => task("summarize the findings"),
  () => task("draft follow-ups"),
], { limit: 2 });
log({ findings: findings.length });
return { findings, summaries: summary.results.map(r => r && r.text) };
```

```bash
wudao workflow run triage.js --auto                         # JS script engine
wudao workflow run triage.js --args '{"modules":[1,2,3]}'   # JSON → the script's args global
wudao workflow run triage.js --resume <runId>               # replay matched tasks with ZERO model calls
wudao workflow run triage.js --budget-tokens 200000
wudao workflow list                                         # past runs from their terminal state.json
wudao workflow status <runId>                               # one run's full receipt
```

**The primitives**

- `await task(prompt, opts?)` — one bounded agent run. Opts: `allowTools` (default read-only; the subagent tool is never available), `maxTurns` (default 8), `responseSchema` (JSON-Schema subset: `type`/`required`/`properties`/`items`/`enum` — fenced-JSON extraction, **no syntax repair**), `verify` (deterministic scorers below), `retry` (default 1; **abort is never retried**), `label` (display only — excluded from the journal key). Returns `{ok, text, data?, toolsUsed, cost, verify?, failure?}` — a failed task is a *value*.
- `await parallel([...fns], {limit})` — barrier fan-out, allSettled semantics; never rejects.
- `await pipeline(gen)` — no-barrier streaming: thunks start as slots free; producing work overlaps running it.
- `log(obj)` — narrator line into the journal's display layer.
- `await workflow(name, args?)` — sub-workflow, **one nesting level**, sharing the parent's journal, call counter, budget and concurrency.
- `args` — the run's JSON arguments (`--args '<json>'`; `.js` only). **Time and randomness must enter here**: `Date` and `Math.random` throw (the engine owns determinism — that is what makes replay sound).
- `budget` — `{total, spent, remaining}` (default 500k tokens): shared across sub-workflows. Exhaustion **fails the run** (`budget-exhausted`), never a silent truncation; only a task's final ok attempt is charged.

**Deterministic scorers** — `verify: [{fileExists: {path}}, {regexMatch: {pattern, flags?, text?}}, {jsonPath: {path, equals?}}, {exitCode: {command, expect?, timeoutMs?}}]` evaluated after the run (no model); any fail/timeout fails the task with category `verify-failed`.

**Failure taxonomy** — every failed task/run carries one of `{no-structured-output | invalid-structured-output | task-threw | budget-exhausted | verify-failed | aborted}` in the journal, the terminal `state.json`, and the CLI line.

**Journal (content-addressed, replayable)** — `.wudao/workflows/<runId>.jsonl`. Each completed task is keyed by `sha256(prompt + canonical opts)` (label excluded) and stamped with the engine's `seq`; `--resume` replays hits with zero model calls (re-validating cached output against the *current* schema); a key mismatch means the script was edited — the journal truncates from that edit point and everything after re-runs. A failed task has no cache entry (re-runs on resume while later ok entries still replay — a failure gap, not an edit point). Each run lands an atomic terminal `state.json` (50-run GC).

**M22 JSON compatibility** — `wudao workflow run <file.json>` still works: the JSON compiles into an equivalent plan (steps → sequential `task()`s; `expect.toolUsed`/`outputContains` → scorers) through the same engine, journal and budget; the old runner remains as the equivalence oracle.

Exit codes: `0` run ok (or fully replayed) · `1` run failure, missing key, unknown resume id · `2` usage/validation.

### Programmatic tool calling (`run_script`, M50)

The model-side counterpart to workflows: instead of spending one turn per tool call, the model writes **one program** — **JavaScript** (default) or **Python** (`language: "python"`; stdlib `python3`, same `call()` contract) — that orchestrates the calls itself — loops, aggregation, branching over results — and the harness executes it in a child process. The two are complementary and cross-guide each other: **workflow = a deterministic pipeline a human wrote before the run; `run_script` = ad-hoc orchestration the model composes this turn.**

```js
// the model's run_script code — one tool call, three reads, one distilled line
const files = ["a.ts", "b.ts", "c.ts"];
const sizes = [];
for (const f of files) {
  const r = await call("read_file", { path: f });          // full pipeline, per call
  if (r.ok && !r.isError) sizes.push(f + ":" + r.content.length);
  else sizes.push(f + ":ERR:" + r.error);                    // denied/failed = a value, not a crash
}
console.log("sizes " + sizes.join(" "));                    // ONLY this stdout enters context
```

```python
# the same shape in the python lane — call() is a plain sync function
for f in ["a.ts", "b.ts", "c.ts"]:
    r = call("read_file", {"path": f})                     # full pipeline, per call
    print(f, len(r["content"]) if r["ok"] and not r["isError"] else "ERR:" + r["error"])
```

- **Context purity — the point of the feature.** The individual tool results NEVER enter the conversation; only the program's **stdout** (≤50KB, truncated with a note beyond) returns as the `run_script` result. Context cost is decoupled from call count. Print the distilled facts, never raw dumps.
- **`call(tool, args)` → `{ok, content, isError}` / `{ok:false, error}`.** Never throws (js) / never raises (python — `call` is a plain sync function returning the same dicts): an unknown tool, a permission denial, a per-call timeout (10s), or a tool crash is an ordinary value the script branches on. Deny messages are byte-identical to the loop's, both lanes.
- **Two lanes, one protocol.** `language: "js"` (default) and `language: "python"` run peer shims of the same file-RPC channel: the parent-side routing, per-call gate, timeouts, and stdout cap are shared code, with parity pinned by tests (field-identical request files, same receipts and failure shapes). The python lane needs a stdlib `python3` on PATH; a missing binary is a typed error, never a silent js fallback.
- **Per-call permissions.** EVERY `call(…)` re-enters the same permission gate the loop uses — settings rules, the sidecar layer, interactive asks. Requests are served strictly sequentially, so a gate that prompts a human never runs concurrently. The gate must answer within the per-call budget (the sidecar's 4s bound fits). `run_script` itself cannot be called from a script (no recursion); subagents don't get the tool (v1).
- **Sandbox (honest, per lane).** **js**: the child runs under `node --permission` with the filesystem allow-listed to its private RPC channel dir — reads/writes outside it and `child_process`/worker/addon use fail `ERR_ACCESS_DENIED`; the Node permission model does **not** gate network (same trust class as host `shell`). **python**: **no filesystem sandbox** — python3 has no `--permission` equivalent (`-I` isolates imports/env, not fs), so the lane's trust level is *exactly* `shell`'s: per-call permissions, timeouts, stdout cap, nothing more. The capability difference is asserted by tests (js outside-read denied / python outside-read succeeds), not advertised away. Either lane: use `--sandbox` or a machine boundary for hostile code; credential-shaped env vars (and `NODE_OPTIONS`) are scrubbed from the child.
- **Budgets.** 10s per call, 120s per script (SIGTERM), 50KB stdout. The result carries a deterministic receipt: description, `calls: read_file ×3`, stdout, exit label. On failure a ≤2KB stderr tail is appended so a broken script is debuggable.
- Inner calls are side-channel: they do not fire `onPreToolUse`/`onPostToolUse` hooks or feed the loop-safety window (v1 boundary, see [limitations](#known-limitations-tracked-for-later-milestones)).

### Persistent Python kernel (`python_kernel`, 114)

The state lane beside `run_script`: **one long-lived `python3` process per session** that survives across tool calls — imports, loaded data and variables stay in RAM between calls, so a long computation pays the `import torch` / parse-the-big-file tax ONCE instead of per probe (the 114 forensics measured 10–30% of wall clock lost to re-deriving the same state, and the "print intermediates to the terminal as memory" anti-pattern that floods context with them).

```python
# call 1 — pay the setup tax once
import numpy as np
data = np.loadtxt("grid.txt")          # stays in the kernel

# call 2 (any later turn) — iterate on the resident state
print(np.median(data))                 # ONLY distilled facts enter context
```

- **Cells, not programs.** Each call executes one Python cell and returns its stdout (capped, surrogate-safe truncation), stderr (failure receipts only), and exceptions — **an exception is caught and reported, the kernel keeps running**; only a timeout or `reset: true` kills it.
- **State lives in variables, not the terminal.** The tool description guides the model to keep intermediates in kernel variables and print only distilled facts — printing big intermediates as storage is exactly the anti-pattern this tool replaces.
- **Lifecycle.** Lazy spawn on first cell; idle-reaped after 15 min (settings `pythonKernel.idleTimeoutMs`, `0` = never), with a stdin-EOF watchdog so a killed harness never orphans the kernel, plus a process-exit hook; crashed/timed-out kernels cold-start transparently on the next call and the receipt says so (`kernel: restarted after … (state lost)`). The kernel dies with the driver's dispose.
- **Trust model (honest v1).** No filesystem sandbox — shell-level trust, exactly `run_script`'s python lane: per-call permissions, a per-cell wall clock, the stdout cap. The kernel is a **pure compute lane**: it cannot call harness tools (there is no `call()` channel to gate — if that ever changes, per-cell gating becomes mandatory). Credential-shaped env vars are scrubbed; `python3` must be on PATH (typed error, no fallback).

## Extensibility

### Skills (`.agents/skills` / `.wudao/skills` / `.claude/skills` + plugins)

A **skill** is a knowledge pack the model loads on demand: a directory with a `SKILL.md` (minimal frontmatter + markdown body — zero runtime semantics). **Progressive disclosure**: each skill costs a couple of prompt lines, not its full text.

```
<workspace>/.agents/skills/commit-msg/SKILL.md   ← ecosystem location (the upstream format / the upstream project / Anthropic skills drop in unchanged)
<workspace>/.wudao/skills/verify-first/SKILL.md
<workspace>/.claude/skills/<name>/SKILL.md       ← the upstream's native location, discovered read-only
~/.wudao/skills/<name>/SKILL.md                  ← the global tier (M57): user-wide skills; a same-name project skill wins (warned)
```

```markdown
---
name: commit-msg
description: Conventional commit rules for this repo
---
# Commit messages
…body — the actual instructions…
```

- **Format** — frontmatter is hand-parsed line style (`name:` / `description:`; unknown keys ignored). Missing `name` skips with a warning; missing `description` still loads.
- **Discovery** — `.agents/skills` → `.wudao/skills` → `.claude/skills` (alphabetical within each; first-wins on duplicate names with a diagnostic warning; symlinked skill dirs followed). Plugin `skills/` dirs feed the same list as a fourth source (workspace wins on conflicts).
- **Prompt tail** — when skills exist **and** the agent has a read tool, the system prompt gains a trailing `<available_skills>` manifest at the very end; the model `read_file`s the full instructions when a task matches — zero resident tokens. Changing the skill set shifts those tail bytes → the next run's first request pays **one** cold prefix; an unchanged set costs nothing (pinned by `det-15`).
- **Explicit invocation** — `/skill:name [args]` wraps the full SKILL.md in a `<skill …>` user message through the normal prompt path (hooks see it like any prompt). Unknown names print the listing.
- **Bundled example** — `skills/ultracode-quality` (multi-agent quality playbook). Install into a workspace: `mkdir -p .wudao/skills && cp -R skills/ultracode-quality .wudao/skills/`.

### Context rules (`.wudao/rules/`, M62)

A **rule** is a small markdown instruction file that enters context **only when relevant** — the context-economy counterpart to skills. Two kinds, split by frontmatter:

```
<workspace>/.wudao/rules/python.md      ← project tier (recursive; subdirs allowed)
~/.wudao/rules/python.md                ← global tier: a same-name project rule wins (warned, skills semantics)
```

```markdown
---
paths:
  - "**/*.py"
---
Always run ruff after editing a Python file in this repo.
```

- **No `paths:` → stable rule** — loads at session start into the `# Project context` stable section (same home as WUDAO.md): global tier first, alphabetical within a tier, counted against the section's 128KB budget, body capped at 8k chars (line boundary). Byte-stable for the session.
- **`paths:` → gated rule (lazy)** — the body is appended **into the message history** (a `[context rule …]` user note after the tool batch, *not* a resident projection) the first time a matching file enters context via a successful `read_file`/`edit`. Globs use the harness's own glob matcher (workspace-relative; a pattern without `/` also matches basenames — `CLAUDE.md` matches `pkg/foo/CLAUDE.md`). Once per rule while its note is in history; compaction summarizes the note away and the next matching read re-loads it — append-only, so the prefix cache never breaks. The terminal shows one line: `Loaded .wudao/rules/python.md`.
- **Subdirectory context = implicit rule** — a `WUDAO.md`/`AGENTS.md`/`agents.md` in a workspace subdirectory is treated as a gated rule scoped to its subtree (`pkg/WUDAO.md` → `pkg/**`), same lazy mechanism. The workspace root's own files (and the `.git`-bounded parent chain) keep their M54b startup load.
- **Session-static discovery** — the rule set is read once per process; editing rules mid-session does nothing until restart (prefix-cache law).

### Output styles (`.wudao/output-styles/`, M62)

An **output style** shapes voice/format. `.wudao/output-styles/*.md` (project) + `~/.wudao/output-styles/*.md` (global; same-name project wins, warned); the settings key `outputStyle` selects one by name.

```markdown
---
name: terse
replace-coding-instructions: true   ← optional; default absent
---
Answer in short bullet lists. No preamble.
```

- **Default = APPEND + keep coding instructions** — the style body is appended as an `# Output style (<name>)` section in the stable prompt tail, and the `# Tool usage` coding instructions **stay**. This is deliberately the opposite of the upstream's replace-by-default: a coding harness puts tool discipline first; a style is voice, not a substitute (README-recorded decision).
- **`replace-coding-instructions: true`** — the style body replaces the `# Tool usage` section instead.
- **Chosen at session start, byte-frozen** — the selection is read once before any prompt is built; changing `outputStyle` in settings or `/config` mid-session is a **no-op until the next session** (restart to apply — the KV prefix never shifts mid-session).
- An unknown name warns once and degrades to no section.

### the upstream format plugins (`.wudao/plugins`, M36)

A **plugin** is a the upstream format-format config package: a directory with `.claude-plugin/plugin.json`. Assets map **read-only** onto mechanisms the harness already has — nothing is copied, nothing is executed:

```
<workspace>/.wudao/plugins/<dir>/.claude-plugin/plugin.json   ← installed plugins
wudao --plugin <path> …                                       ← one-shot mount (repeatable)
wudao plugin list                                             ← name/version/asset counts/warnings
```

| Plugin asset | Maps to | Conflict rule |
| --- | --- | --- |
| `skills/<name>/SKILL.md` | the skills system (fourth discovery source) | workspace skills win; plugin copy warns + skips |
| `commands/<name>.md` | a slash command: `/<name> args` expands the template (`$ARGUMENTS`, `$1..$N`) through the same pipeline as `/skill:` | builtin-name collisions warn + skip; across plugins first wins |
| `agents/<name>.md` | the roster's **plugin layer**: frontmatter `name/description/tools?/model?` + markdown body → an `AgentRoleProfile` (body = systemPrompt) | builtin < plugin < workspace — a workspace `.wudao/agents/<id>.json` reclaims the slot; across plugins first wins |
| `.mcp.json` / `mcp.json` | merged into the MCP startup list | the user's `.wudao/mcp.json` wins on a server name |
| `hooks/hooks.json` | merged after the user's hooks per event — the full canonical event surface (all 21 `on*` events); upstream spellings (`SessionStart`/`UserPromptSubmit`/`Stop`/`PreToolUse`/…) map through `HOOK_EVENT_MAP` (the wudao-only `onTeammateIdle` has no the upstream format spelling) | unknown events warn + skip; upstream group-level `matcher` is stamped onto every entry it contributes and applies (the upstream's matcher vocabulary is our native one — comma/pipe exact-match list or RegExp); a flat entry's own `matcher` wins (own-over-group) |
| `themes/`, `*.ts/js/…` | **nothing** — warned and skipped | — |

**Agent translation (M40).** `tools:` is a comma list mapped through the upstream alias table (`Read/Write/Edit/Bash/Glob/Grep/Task/TodoWrite` → our names) plus our native names — unknown names warn and drop (fail-closed: a typo can never widen into an unexpected tool). `model:` pins only when it names a known provider — exactly `deepseek`/`glm`/`qwen`/`wudao` (provider pin) or `<provider>-…` (provider + model) — otherwise it warns and pins nothing. Unsupported frontmatter fields (`whenToUse`, `color`, …) are warned and listed, never guessed. Every displacement is reported: a plugin agent replacing a builtin (or being reclaimed by a workspace file) lands in the `ShadowedProfile` receipts the task tool's dispatch meta surfaces. `wudao plugin list` counts agents per plugin.

**Trust model — plugins are config packages, not sandboxed programs.** No plugin code runs (executable payloads are explicitly skipped). The one thing a plugin can cause to execute is hook commands and MCP servers — the same trust decision as writing `.wudao/settings.json`/`mcp.json` yourself: read a plugin's `hooks/` and `.mcp.json` before installing. The marketplace is a discovery layer only — it lists entries and records their source; installing still materializes by git clone / local-dir copy (no marketplace code executes, no tarball is pulled) — see [Plugins & marketplace](#plugins--marketplace). Zero-plugin behavior is pinned (`det-26`).

### Extensions (`.wudao/extensions`, M39)

> ⚠️ **Extensions are CODE — loading one runs it.** A plugin is a config package whose code never executes; an extension is a JavaScript module imported and run with your full user privileges the moment you start wudao in that workspace. There is no sandbox, no permission review of the file itself, and no kill switch short of deleting it. Treat every file in `.wudao/extensions/` like a shell script in `.wudao/hooks/`: read it before you add it, and never install one from a source you don't trust. For distrusted workspaces, a read-only tier (`--plan`), `--sandbox`, or a machine boundary remain the actual boundaries.

An **extension** is a plain ESM file — no build step, no dependencies, no manifest:

```
<workspace>/.wudao/extensions/<name>.mjs     ← export default function wudaoExtension(api) { … }
```

Loaded once at startup (filename order; a broken file warns and is skipped, never fatal). Everything registers through the one `api` object:

```js
// .wudao/extensions/night-guard.mjs
export default function (api) {
  const { sessionId, workspaceRoot, version } = api.meta;   // read-only

  // Events: run_start · run_stop · prompt_submit · pre_tool_use ·
  //         post_tool_use · pre_compact · post_compact
  api.on("pre_tool_use", (p) => {                           // p: {event, sessionId, tool, input}
    if (p.tool === "shell" && isLateNight() && String(p.input.command).includes("deploy")) {
      return { block: true, reason: "no deploys after midnight" };   // interceptor
    }
  });
  api.on("prompt_submit", (p) => p.prompt.replace("TODO", "TRACKED-INTENTALLY"));  // or rewrite / block
  api.on("run_stop", async (p) => {                         // p: {…, messageCount, lastAssistant}
    await api.appendEntry("night_guard_stop", { at: p.messageCount });
  });

  api.registerTool({                                        // name MUST start with ext_
    name: "ext_timestamp",
    description: "current UTC time",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: new Date().toISOString() }),
  });

  api.registerCommand("ext-hello", (args, ctx) => {
    ctx.notice(`hello ${args}`);                            // dim informational line
    ctx.submit(`Say something nice to ${args}`);            // one user turn through the normal prompt path
  });
}
```

- **Events** run through the SAME pipeline as configured hooks, layered after them (config → plugins → extensions; a rewrite chains, any block short-circuits). Interceptor events (`pre_tool_use` → `{block:true,reason}`, `prompt_submit` → rewrite string or block, `run_stop` → block) share the hooks semantics: the model sees `blocked by hook: <reason>`; observer events (`run_start`, `post_tool_use`, `pre_compact`, `post_compact`) are fire-and-forget. Payloads are JSON-serializable shapes (`{event, sessionId, …}`) — never live objects.
- **Isolation**: every handler call is wrapped — an observer that throws warns and the run continues; an interceptor that throws degrades to allow/original (fail-open convenience layer, not a security boundary — same posture as configured hooks). A throwing `execute()` becomes an error tool result, never a crashed loop.
- **Timeouts (M40)**: every handler call also runs under a per-call budget — default 10s, `WUDAO_EXTENSION_TIMEOUT_MS` to change (`0` = off). A timed-out observer warns and is skipped; a timed-out interceptor degrades to allow/original through the same path a throw takes — a hung extension can no more wedge a run than a throwing one. Mirrors the config-hooks `timeoutMs` posture.
- **Tools**: names are forced into the `ext_` namespace (collision guard + a visible marker in permission asks). They go through `buildTool`'s fail-closed validation, are appended **after** the builtin + MCP tools (stable tool order → KV-cache friendly; one array change at startup, never mid-run), stay **parent-level** (never in a `task` child set, never deferred behind `load_tools`), and pass through the **full permission pipeline** — `default` mode asks for them like any non-read tool.
- **Commands**: `/<name> args`. Builtin names and the `skill:` prefix are reserved; a plugin command with the same name wins (rejected at registration with a warning). The handler's `ctx.notice(text)` prints without entering history; `ctx.submit(text)` queues exactly one user turn (an extra submit warns).
- **Entries**: `appendEntry(type, data)` / `readEntries()` ride the session's JSONL (the M35 generic-entry channel) — bound once the run's session exists; before that they warn and no-op. Pick a distinctive `type` (e.g. prefix it with your extension name) — the namespace is shared with `model_change`/`deferred_loaded`/… .
- **Not in v1** (deliberately): `transformContext` (model-input rewriting — high blast radius, v2), provider registration, UI rendering, hot reload (restart to pick up an edit), and npm distribution (files arrive by clone/commit).

Full-chain behavior is pinned by `det-28` (fixture extension: echo tool + `shell` blocker + `/ext-cmd`, plus a throwing extension that must not take the run down); the timeout lanes are pinned by `det-29` (a parked extension is skipped under a small budget and the run completes).

### Hooks (`.wudao/settings.json`)

Intercept/rewrite prompts, stops, and tool calls **without code** — configured hooks run in the one-shot, REPL, TUI, and workflow paths:

```json
{
  "hooks": {
    "onPromptSubmit": [ { "command": ".wudao/hooks/log-prompt.sh" } ],
    "onRunStop":      [ { "command": ".wudao/hooks/stop-uncommitted.sh", "timeoutMs": 5000 } ],
    "onPreToolUse":   [ { "command": ".wudao/hooks/guard-writes.sh" } ],
    "onPostToolUse":  [ { "command": ".wudao/hooks/log-tools.sh" } ]
  }
}
```

- `onPromptSubmit`: raw prompt on stdin; non-empty stdout **rewrites** (hooks chain); non-zero exit **blocks** (reason = stderr first line).
- `onRunStop`: JSON stop summary on stdin; non-zero exit **forces one more turn**.
- `onPreToolUse` (alias `preToolUse`): `{"event":"preToolUse","tool":…,"input":…}` on stdin; runs **before the permission gate**; blocks via non-zero exit or stdout first line `{"block":true,"reason":…}` — the model receives `blocked by hook: <reason>`; plain stdout is observe-only.
- `onPostToolUse` (alias `postToolUse`): fires after every **executed** call (denied/blocked calls never fire it); observer, exit codes ignored — with ONE context exception (M62 §5, below).
- **`additionalContext` channel (M62 §5).** A postToolUse hook exiting 0 may answer on stdout with the the upstream format-style envelope:

  ```json
  {"hookSpecificOutput": {"additionalContext": "…text the model should see…"}}
  ```

  The inner string is injected at the **next model call** of the run as a `<system_note>` suffix appended after the last tool result — projection-only, cache-safe, capped at 8k chars (line boundary). Multiple post hooks' contexts join with a blank line. The contract is strict: **plain stdout is NOT context** (logged/observed only — anything that is not exactly that JSON envelope is ignored), and **exit ≠ 0 is never parsed**. Extensions get the same channel by returning a string (or the envelope) from `on("post_tool_use")`.
- Commands run `execFile`-style — **one executable + literal args, no shell** — with `cwd` = workspace root and a scrubbed env. Timeouts (default 10s) and spawn failures degrade to allow/original with a `⚠️` warning, never a wedged run.

Full semantics + copy-paste hook scripts: [`docs/hooks-examples.md`](docs/hooks-examples.md).

### MCP servers (`.wudao/mcp.json`)

Tools from MCP servers are first-class tools, named `mcp__<server>__<tool>`. The client is hand-written stdio JSON-RPC 2.0 (newline-delimited JSON, request-id correlation — zero new dependencies):

```jsonc
// .wudao/mcp.json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." },
      "timeoutMs": 120000            // optional per-server tools/call timeout
    }
  }
}
```

- **Startup:** servers connect at launch (initialize `2025-06-18` → `tools/list`); a failing server is skipped with a `⚠️`, never fatal. No file, no MCP.
- **Behavior:** schemas pass through (non-object schemas wrapped as no-args tools); text parts join into the tool result; transport/timeout/server errors surface as fail-closed `isError` results. MCP tools are `isReadOnly: false`.
- **Permissions:** `mcp__*` tools are NOT read tools — the default `workspace`/`accept` tier asks, `--auto` allows, read-only tiers (`--plan`) deny.
- **Shutdown:** stdin EOF, ≤2s grace, then SIGTERM.
- **Subagents:** MCP tools are excluded from `task` child tool sets; MCP tools never defer behind `load_tools`.
- **KV-cache:** the system prompt gains a trailing `# MCP tools` section only when MCP tools exist — appended at the end, prefix stays byte-stable.

> ⚠️ **Security note:** MCP servers run **arbitrary local commands** configured by you. Only list servers you trust; their tools go through the same permission gate as builtins.

### LSP code intelligence (P2-9)

One tool, `lsp`, with three actions — `definitions` / `references` / `hover` — over the workspace's TypeScript files (`.ts/.tsx/.mts/.cts`; v1 is TypeScript-only, the provider table leaves the multi-language seam). It is the symbol-accurate alternative to `grep` navigation: a textual search cannot tell `foo()` from `foo` in a comment; the language server can.

```jsonc
// .wudao/settings.json — DEFAULT OFF (opt-in process surface)
{ "lsp": { "enabled": true } }
```

- **Provider:** `typescript-language-server --stdio`, resolved from the workspace's `node_modules/.bin` first, then `PATH`. Missing → a fail-closed tool error carrying install guidance (`pnpm add -D typescript-language-server typescript`); never a silent fallback. Note the server needs a `tsserver.js`-bearing TypeScript in the workspace (TypeScript 7.x's native port ships none — the language server rejects it).
- **Protocol:** an independent hand-written Content-Length framing client (`packages/cli/src/lsp/` — LSP frames are `Content-Length: N\r\n\r\n{json}`, not MCP's newline-JSONL; `JsonRpcClient`/core untouched). Server→client requests (`workspace/configuration`, `client/registerCapability`, …) are auto-answered — a real tsserver wedges without it.
- **Lifecycle (four layers):** lazy start (zero calls = zero processes) · idle recycle (5min with no request → bounded shutdown; the next call respawns) · crash rebuild (the in-flight request fails closed, state clears, the next call rebuilds) · per-request timeout (10s default → tool error, the loop never hangs). `closeLspTools()` rides every frontend shutdown beside `closeMcpTools()`.
- **Coordinates & output:** `path` workspace-relative, `line`/`column` **1-based** — the same coordinates `read_file`/`grep` print (the 0-based LSP wire form is converted at the manager). definitions/references render as `path:line:col` lines (workspace-relative, capped at 100 like grep); hover returns type/signature text (2000-line/50KB output caps). Documents sync didOpen-once + didChange-on-text-change (full sync), so mid-session edits don't serve stale positions.
- **Permissions:** the `lsp` tool is READ_TOOLS (the `grep` class — free in workspace/auto, asked in ask mode); the server *process* is what's gated, by the settings opt-in.
- **Cache law:** appended at the tool-list tail after the MCP tools (append-only; existing tool definitions byte-identical); registration is session-static — flipping `lsp.enabled` mid-session does nothing until restart.
- **Subagents:** like MCP tools, `lsp` stays parent-facing (never in a `task` child set).

### Persistent PTY terminal (P2-12)

One tool, `terminal`, with five actions — `run` / `send` / `read` / `interrupt` / `exit` — over **named PTY sessions whose shell state survives across tool calls** (cwd, `export`s, activated venvs, a running interactive CLI). That cross-call state is the whole point: `shell` gives you a fresh `/bin/sh` every time; `terminal` gives you the same shell.

```jsonc
// .wudao/settings.json — DEFAULT OFF (opt-in process surface)
{ "terminal": { "enabled": true } }
```

- **Dependency:** `node-pty` **1.1.0 exact** — the project's first native dependency. darwin ships prebuilds in the tarball; note an upstream packaging bug: the `spawn-helper` binary lands **without its exec bit** (mode 0644) and nothing in node-pty's lifecycle restores it — the loader self-heals with a best-effort `chmod 0755` + X_OK probe at startup. A failed load (missing native build, unhealable helper) **warns once and registers nothing** — never fatal, every suite stays green on machines without the toolchain.
- **Sessions:** default name `"main"`, at most **2 live** (a third is refused with the live list); spawn cwd is the operation root; env inherits shell's discipline (`scrubChildEnv` — credential-shaped vars never reach the shell). Idle-recycle after **10 minutes** with no action (bounded kill + notice). A process that exits on its own leaves a tombstone: every later action reports "session has ended" — **sessions are never resumed** (PTY state is not persistable; a harness restart clears them, honestly).
- **`run` settle semantics:** the command is written and output is awaited until **200ms of silence or a 5s cap** (deadline hits report "still running" — poll with `read`). Output is ANSI/control-sequence-stripped at the egress (the per-session 256KB ring keeps raw bytes; overflow drops the head, keeps the tail, marks it).
- **Permissions: every action asks** — the tool is deliberately *not* in the read/workspace auto-allow classes (a `send` is new input to an arbitrary process; no session-level trust inheritance in v1). plan mode denies it.
- **Audit:** every action (post-validation) appends a `terminal` entry to the session JSONL — action, session, the command's first line (≤200 chars, truncation-marked); a `send` records its input raw, so control characters land in their escaped form (``) on serialization.
- **Cache law / subagents:** appended at the tool-list tail after the `lsp` tool (append-only; registration session-static — restart to apply a settings flip); parent-facing like MCP/LSP.

### Keybindings

Every keyboard-sensitive branch of the TUI consults a **named registry** (`packages/cli/src/tui/keybindings.ts`). Defaults:

| Action | Default key | What |
| --- | --- | --- |
| `app.submit` | `return` | submit (trailing `\` = line continuation) |
| `app.abort` | `escape` | interrupt the in-flight run (busy only) |
| `app.exit` | `ctrl+c` | exit when idle / interrupt when busy |
| `input.backspace` | `backspace` | delete one char / join to previous line |
| `input.up` / `input.down` | `up` / `down` | move between input rows |

Override in `.wudao/keybindings.json`: `{ "app.submit": "ctrl+s", "input.up": "ctrl+p" }`. Binding syntax: a named key (`return` `enter` `esc` `escape` `backspace` `delete` `left` `right` `up` `down` `tab` `space`) or `ctrl+<char>`. Unknown names warn and are ignored; a malformed file degrades to defaults. Overrides have **replace** semantics (remapping `app.submit` off Enter demotes Enter to a plain newline — an orphaned submit key would be worse); two actions sharing a key warn and both stay bound (first match by table order wins). Read once at TUI startup; single-character overrides that would hijack typing are refused.

### Deferred tool loading (`load_tools`, M35)

The orchestration tools (`task`, `agent_await`, `agent_status`, `agent_cancel`) have the largest definitions in the builtin set and are needed only when the model delegates. They carry the `shouldDefer` annotation: **they never enter a request's tools array**. Instead every request of a top-level run carries one trailing meta-tool:

```
load_tools({ names: ["task", "agent_await"] })
  description lists every deferred tool as `- name: one-line summary`
```

When the model calls it, the chosen definitions are **appended after `load_tools`** in the tools array of every following request of the run; the loop emits a `defer_loaded` event, and the CLI records a `deferred_loaded` session entry (TUI status `defer N`). The change happens **once** — the tools segment sits between the system prompt and the messages, so growing it invalidates the KV prefix of everything behind it; after one load, requests are byte-stable again (a second `load_tools` returns an informative "toolset frozen" receipt; unknown/eager/empty names fail closed without consuming the window — ask for everything you need in one call). MCP tools never defer; child sets never defer (orchestration tools are already stripped); `load_tools` itself routes with the read tools. Kill switch: `WUDAO_DEFER_TOOLS=off` → full load, byte-identical to pre-M35.

**Defer mode (M62 §6).** Settings key `tools.defer`:

- `"auto"` (**default**) — at startup the harness estimates the defer candidates' schema bytes with the canonical serializer (`bytes / 4 ≈ tokens`); when the total fits within **10% of `contextWindowTokens`**, everything loads **eagerly** (no `load_tools` round trip at all — the meta-tool and its cold-turn risk are simply not worth a few hundred tokens); over the threshold, deferring stays on.
- `"on"` / `"off"` — explicit overrides. The `WUDAO_DEFER_TOOLS=off` env ablation keeps winning over everything.

**`alwaysLoad: true` (M62 §6, per MCP server).** `{command, args, alwaysLoad: true}` guarantees that server's tools ride the prompt prefix eagerly. Today every MCP server is eager by construction (the M35 boundary — MCP tools never defer), so the key pins that guarantee for the future. Its **cache cost** is real: the tool-set prefix is frozen per session, so any change to an alwaysLoad server's tool list (server upgrade, config edit) invalidates the prefix cache for the session's first request.

## Examples

`examples/` ships working, copy-paste starting points — every file is smoke-loaded by the test suite (`packages/cli/tests/examples-smoke.test.ts`), so they cannot rot silently.

### Extensions (`.wudao/extensions`)

```bash
# 01 — the smallest useful extension: one ext_echo tool + one /ext-hello command
mkdir -p .wudao/extensions && cp examples/extensions/01-echo-tool.mjs .wudao/extensions/
wudao "call ext_echo with value=hello"          # one-shot: the tool rides the full permission pipeline

# 02 — an interceptor guard: blocks rm -rf / git push --force / drop table BEFORE
#      the permission gate, plus optional quiet hours for risky commands
cp examples/extensions/02-guard.mjs .wudao/extensions/
WUDAO_GUARD_QUIET_HOURS=0-8 wudao "publish the package"   # npm publish blocked 00:00–08:00

# 03 — the session-entry channel: /note <text> + run_stop summaries + ext_session_notes
cp examples/extensions/03-session-notes.mjs .wudao/extensions/
wudao --no-tui        # then: /note rerun the evals before merging
wudao "use ext_session_notes to summarize my earlier notes"
```

### Agent roles (`.wudao/agents`)

```bash
mkdir -p .wudao/agents
cp examples/agents/explorer.json .wudao/agents/   # read-only terrain mapper
cp examples/agents/reviewer.json .wudao/agents/   # adversarial reviewer FROZEN to deepseek-chat @ high
wudao "dispatch a task-tool review of the diff with role=reviewer"
```

Index + schema walkthrough: [`examples/agents/README.md`](examples/agents/README.md).

### A full the upstream format plugin (skills + commands + agents)

```bash
# mount for one run…
wudao --plugin examples/plugins/demo "dispatch role=ticket-triage on this bug report: <text>"

# …or install it properly
mkdir -p .wudao/plugins && cp -R examples/plugins/demo .wudao/plugins/
wudao plugin list        # demo  1.0.0  skills:1  cmds:1  agents:2
wudao "/verify after your change"   # the command expands through the /skill: path
```

The demo plugin carries one skill (`release-checklist`), one command (`/verify`), and two agents (`ticket-triage` read-only; `doc-writer` with a `deepseek` provider pin) — all three asset kinds a plugin can contribute, mapped read-only onto this harness's seams.

## Plugins & marketplace

A **marketplace** is a discovery layer over the plugin system: a market = a directory with `.claude-plugin/marketplace.json` (the upstream's format verbatim). `marketplace add` materializes it under `~/.wudao/marketplaces/<name>/` (`owner/repo` shorthand or a git URL with optional `#ref` → `git clone --depth 1`; a local directory → recursive copy) and registers it in `~/.wudao/marketplaces.json`; `install` copies the plugin into the user (`~/.wudao/plugins/`) or project (`.wudao/plugins/`) scope. One grammar, three entry points:

| Entry | Command | What |
| --- | --- | --- |
| REPL / TUI slash | `/plugin <sub> [args]` | the same subcommands with Chinese notices; while a run is in flight the two directory-deleting ops — `uninstall` and `marketplace remove` — refuse with the 「⚠️ 运行中无法 …（任务进行中）」 guard (everything else is config-only and proceeds); quoted arguments keep their spaces (`/plugin marketplace add "file:///path with space"`) |
| CLI | `wudao plugin <sub> [args]` | `list` · `install <name>@<market> [--scope user\|project]` · `uninstall <name>[@<market>]` · `enable`/`disable` + `marketplace add\|list\|update\|remove`; `--json` prints one JSON object; exit codes 0 ok / 1 engine failure / 2 usage |
| Desktop web (`wudao ui`) | settings → 插件 tab | 市场 (add/update/remove sources) · 发现 (the selected market's entries) · 已装 (enable/disable/uninstall); a server too old for the ops degrades to 「升级 wudao 后可用」 |

**Installing superpowers (real, copy-paste):**

```bash
wudao plugin marketplace add obra/superpowers-marketplace
wudao plugin install superpowers@superpowers-marketplace
# in-session: /superpowers:<skill> invokes one of its skills; its
# SessionStart hook bootstraps the skill list into the session
```

**Trust.** A market or plugin is a carrier for third-party config, and two seams in that config can execute: `hooks/hooks.json` is a command-execution seam, and a skill's `` !`cmd` `` injections are tiered by origin — personal skills and user-scope/`--plugin` installs inject freely (the install was your own trust decision), while project-carried plugins and workspace skills route every injection through the permission pipeline. The market itself never runs anything: it lists entries and records sources, and installing materializes by clone-or-copy — no marketplace code executes, no tarball is fetched. Before installing, read the market's `.claude-plugin/marketplace.json` and the plugin's `hooks/hooks.json` + `.mcp.json`. The workspace trust gates and the permission pipeline are untouched by plugins — their deny-first layers still run in front of everything a plugin contributes. See [Security & trust](#security--trust).

## Security & trust

### Permission modes & rules (M8/M33)

The four modes: `workspace` (default — 工作区可读写，work-tree/read commands auto-allow) shows as **`accept`**; `--ask` prompts before every tool; `--auto` allows all; `--plan` is a read-only exploration round. Ask answers: `y` once · `a` session-allowlist rule (bare tool name, or `tool:path` when the call carries a path) · `n` deny (optionally with a reason the model receives). On top of the modes sit `.wudao/settings.json` rules:

```json
{
  "permissions": {
    "allow": ["shell", "write_file:src/"],
    "deny":  ["shell:rm -rf"],
    "ask":   ["edit"]
  }
}
```

Each rule is `tool` or `tool:<selector>`: for path-bearing calls a **path prefix** (`write_file:src/` covers `src/a.ts`; `.`/`..` collapsed, so `src/../.env` can't dodge `deny write_file:.env`); for `shell` a **command prefix matched at token boundaries** (`deny shell:rm -rf` blocks `rm -rf x`, not `rmlint`). Layer order, first match wins:

**settings `deny`** → **protected settings writes** → **session allowlist** → **settings `ask`/`allow`** → **builtin mode**

An operator's hot-added deny outranks even an `a` answered earlier in the session, and a settings deny rejects in `--auto` too. Settings hot-reload mid-session (at most once a second; a change prints a `⚙️ permissions reloaded` receipt).

**Settings writes are bypass-immune:** `write_file`/`edit` targeting `.wudao/settings.json` or `.wudao/mcp.json` are runtime-policy changes — a read-only tier denies them outright, and `--auto`/any other mode **always** prompt with a plain `[y/N]` naming the file. No layer can silence that ask: not the session allowlist, not a settings `allow` rule; the `a` option is unavailable for these paths (a typed `a` degrades to allow-once and records nothing).

### Auto-mode sidecar (M45)

`--auto` gained a flash-class safety classifier riding the permission gate: after the static rules (settings deny/ask, protected writes, allowlist) and before the allow, every **write/exec-class** call — `write_file`/`edit`/`shell`, `mcp__*`/`ext_*`, and unknown tools — is classified by a one-shot model call (maxTokens 256, effort none, 4s hard timeout). Read-class tools and the harness meta-tools (`todo_write`/`ask_user`/`load_tools`/`agent_status`/`agent_await`) are never classified; ask mode never triggers it (the human already gates), and the classifier never runs under read-only tiers (plan / non-`--auto` modes). A gated tool that honestly declares `isReadOnly: true` + `isOpenWorld: false` (the `list_agents` shape) is likewise never classified — even while the breaker below is open, so an open breaker never blinds the run's own read-only discovery.

**Operator carve-out — `permissions.sidecarExempt`:** settings rules (`tool` or `tool:<selector>`, the same selector grammar as `allow`) that exempt a matching call from the classifier — the explicit operator takeover lane when an operator knows a specific edit should pass: it needs a trusted workspace (an untrusted clone's project-tier rules drop, like `allow`/`ask`), hot-reloads with the settings file, and leaves a `🛡 sidecar exempt — settings rule «…» (operator)` receipt. Static `deny`/`ask`/protected-write layers still outrank it; a hit produces no verdict, so it neither pressures nor resets the breaker.

- **low** → the call proceeds, with a `🛡 sidecar:low` receipt.
- **high** / classifier error or timeout → **fail-closed**: interactive frontends escalate the permission ask with the reason (`🔑 (sidecar: …)`); non-interactive runs deny with `sidecar: <reason>`.
- The verdict is a **hard gate** — the tool does not run until it lands. The UI shows the tool line immediately (`⏺ shell(…)`) with a `🛡 checking` badge while the classifier runs; display never waits on the gate. Verdicts cache per session (LRU 128, keyed tool + canonical args).

**Injection red line (ADR-0009):** the classifier sees ONLY the structured fields `{tool, arguments}` over a fixed instruction constant — never the conversation, user messages, reasoning, tool results, or the system prompt. There is no channel through which the audited model can talk to its auditor. `det-30` machine-checks this (the classifier's ModelInput contains no conversation messages).

**Rejection circuit breaker:** 3 consecutive high/error verdicts (configurable) opens the breaker — later gated calls skip the classifier entirely: interactive runs go straight to the human (with a `🛡 sidecar 连续拒绝 N 次,已切换人工确认` notice — emitted once per trip, not per call; a fresh trip after a manual-approval reset notices again), non-interactive runs deny with `sidecar circuit-open`. A manual approval while open is treated as ground truth and resets the breaker; any single low zeroes the count; the count resets at each run boundary (every frontend, the readline REPL included). The status bar shows `sidecar N` (checks this run) plus `🛡✕` while the breaker is open.

Configuration (all three channels, flag > env > settings):

```json
// .wudao/settings.json
{
  "sidecar": {
    "enabled": true,
    "model": "deepseek-v4-flash",
    "maxTokens": 256,
    "timeoutMs": 4000,
    "breakerThreshold": 3
  }
}
```

`WUDAO_SIDECAR=off` or `--no-sidecar` disables it for a run. Subagent (task tool) gates carry the same layer on every frontend — one-shot, TUI, REPL, and `wudao ui` — so a child's `shell` classifies exactly like a top-level call, and parent + child pressure one shared breaker (one sidecar instance per session).

### Write-verify + long-output shaping (M46)

Two feedback loops that keep the model grounded in what its tools actually did:

**Write-verify.** A successful `write_file`/`edit` immediately runs one syntax check by extension and folds the outcome into the tool result — feedback, never a veto: the write already landed, so a failed check is **not** `isError`. `.json` parses in-process; `.js/.mjs/.cjs` run `node --check`; `.ts/.tsx` run single-file `tsc --noEmit` (opt-in, default off — it costs seconds); `.py` runs `python3 -m py_compile` (compile cache mirrored to a tmp tree, never a `__pycache__` in your workspace); `.sh/.bash` run `sh -n`. Failures normalize to workspace-relative `file:line: message` lines (≤10) that LEAD the result, so the model sees "line 3 is broken" on its next turn and self-corrects without a human round-trip:

```
cfg.json:3: Expected double-quoted property name in JSON at position 12 (line 3 column 1)
[verified: json 1 error]
wrote cfg.json
```

Passes append `[verified: <checker> ok]`; every checker is budget-capped (500ms default) — an overrun or a missing binary skips with a `[verify skipped: …]` note instead of stalling the write. `det-31` pins the loop end to end (the structured lines ride the next ModelInput).

**Long-output shaping.** `shell` output past the threshold (200 lines OR 10KB) keeps the head 50 and tail 50 around an omission marker, with the FULL text spilled to `.wudao/spill/<session>/` for `read_file` paging:

```
$ make test
... [省略 8523 行,完整输出已保存至 /ws/.wudao/spill/<sid>/<hash>.txt] ...
如需完整输出,用 read_file 读取该文件
[shaped h50/t50, +8523 lines spilled]
[exit 1]
```

The tail matters most — build errors land at the END. read_file itself is unchanged (head + `offset` paging is right for files; for logs, shape a `shell: tail …` call instead).

Config (`.wudao/settings.json`, read at startup): `writeVerify {enabled (default true), tsTsc}` · `longOutput {lineThreshold 200, byteThreshold 10000, headLines 50, tailLines 50}`. Kill switches: `WUDAO_WRITE_VERIFY=off` (or `ts-off` for just the tsc lane) and `WUDAO_LONG_OUTPUT=off` — both fall back to the exact pre-M46 behavior.

### Sandbox (`--sandbox`, M21)

For distrusted tasks, run shell commands inside a container:

```bash
pnpm start --sandbox --auto "Create hello.js that prints 'hi', then run it."   # shell executes in Docker
```

- **Enable:** `--sandbox` or `WUDAO_SANDBOX=1` (exactly `"1"` — no fuzzy truthy). Works in one-shot, REPL, and TUI.
- **Container:** `docker run --rm -i --network none --memory 512m --cpus 1 -v <workspace>:/workspace -w /workspace --entrypoint sh <image> -c "<cmd>"` — **no network**, capped memory/CPU, workspace mounted at `/workspace`. Override the image (default `node:22-alpine`) with `WUDAO_SANDBOX_IMAGE`.
- **Fail-closed, absolutely:** if the Docker probe (`docker version`, 5s, cached per run) fails, every `shell` returns `shell failed: sandbox required but Docker is unavailable (<reason>)` — **never** a host fallback.
- The host environment is *not* passed into the container (no `-e`); the container env is whatever the image ships. Timeouts/output limits/env rules are unchanged.
- **v1 boundary:** only `shell` is sandboxed. File tools stay host-side (workspace-confined, `.env` readable — v1 limitation). Fully sandboxed filesystem is future work.

### Peer messaging (`list_agents` / `send_message`, M64-A)

Independent wudao sessions on the same machine message each other through per-session **unix-domain inboxes** — local-first, zero server:

- **Discovery & delivery are model-driven:** `list_agents` lists the live sessions (name, short id, tier, uptime); `send_message <name|short-id> <text>` delivers over the target's socket. Humans can ask the model to send. Both tools sit in the TOP-LEVEL tool set at a fixed position (the tool-list prefix stays byte-stable).
- **Inboxes:** `<globalHome>/run/u<uid>/<session>.sock` + a `registry.json` entry per live session (name, socket, pid, tier). The `u<uid>` dir is 0700 — **OS-user isolation** (a shared `WUDAO_GLOBAL_HOME` still separates users). Dead entries (dead pid / missing socket / corrupt rows) are skipped and pruned on the next listing — a bad row never blocks delivery.
- **Naming:** `--name <v>` at start or `/rename` mid-session; default = cwd directory name + a 2-char suffix; same-name live sessions pick variant names; when names collide, address by the **short id** (the session id's 8-char tail).
- **Delivery timing:** accepted messages ride the **steering channel** (the same rail as scheduled tasks) — read **between tool calls mid-turn**, never interrupting a running tool; when the receiver is idle, a delivery **starts a new turn**. Delivery is a turn-tail append: the request prefix never moves (pinned by tests).
- **Inbound three-state** — settings `peerInbound`: `accept` | `hold` | `refuse` (two layers; a **project/local-tier `refuse` overrides everything** — a cloneable tier may tighten, and `accept` from those tiers is dropped). Unset = classify by permission tier: **bypass (`--auto`) sender → hold** for approval (dialog shows sender + preview; `peerDialogExpiry` default 5min, `never` allowed; expiry = discard); **bypass receivers accept only bypass senders**; normal↔normal accepts. Hold cap 100; refused messages are silent at the receiver. Hold outcomes (`delivered`/`denied`/`expired`) are **reported back to the sender** as `[peer report]` notes.
- **Untrusted-message semantics:** inbound peer text can **never approve a permission or change configuration**; commands arrive as **plain text** (the banner rides every delivered note, the standing rule sits in the system prompt); the receiver's own permission prompts fire as usual. In auto mode the **sidecar reviews each inbound message before delivery** (a high verdict denies it) — a "relayed approval" inside a message is untrusted input.
- **Throttling:** per-sender rate limit (20/min), same-text duplicates dropped inside a 30s window, unread cap 50.
- **Hooks:** every hook subprocess receives `WUDAO_MSG_SOCKET` + `WUDAO_MSG_TOKEN` — the session's own inbox socket and a token proving "this is my subprocess". A first frame `{"v":1,"type":"auth-self","token":…}` delivers as a trusted-**source** (not classification-exempt content) self note.
- **Switches:** `WUDAO_DISABLE_PEER=1` kills the whole surface (tools answer with the refusal — fail-closed); under `--sandbox` the inbox is **off** unless `WUDAO_PEER_SOCKET=1` opts back in. Cross-machine relay is out of scope (`isolatePeerMachines` interface slot reserved).

### Agent memory (M64-B)

Every roster role carries a persistent `MEMORY.md` its children read at spawn and write back through the **ordinary file tools** (no special tool):

- **Tier routing** (roster field `memory`, default `project` when unset — unset means project-tier memory, not "no memory"): `project` → `.wudao/agent-memory/<role>/MEMORY.md` · `local` → `.wudao/agent-memory-local/<role>/MEMORY.md` · `user` → `~/.wudao/agent-memory/<role>/MEMORY.md`. Plugin `agents/*.md` frontmatter accepts the same `memory:` key.
- **Spawn injection:** the child's system prompt gains the file's **first 200 lines / 25KB, whichever comes first** (deterministic, whole-line truncation). When truncation applies the section says so and points at the exact path (`read_file` it for the rest). A `[MEMORY_PRUNED: …]` marker line that somehow landed in the file is **filtered on re-read** — appended notes never re-inject stale markers. A role with no file yet gets its memory directory pre-created and a bootstrap section (write your first notes).
- **Write-back:** the child reads/writes its own memory file with `read_file`/`write_file`/`edit` on the advertised path. A **scoped role's write-scope guard always admits its memory root**; the **user tier** (outside the workspace) is reached through a routing wrapper that sends memory-file calls to tool instances rooted there — same tool names, same arguments, no widened containment (non-memory out-of-workspace writes stay refused). Fork children share the parent prompt and skip the section.
- **Lifecycle (M62 × M64-B):** project-tier memory **expires with `cleanupPeriodDays`** via the startup sweep; **local and user tiers are never cleaned**; `wudao purge` keeps its never-touches-memory contract — only time expires memory.
- Memory files are **files, not peer messages** — the M64-A untrusted-message machinery does not apply to them.

### Teams (M64-C)

Named subagents become **teammates** (`task` with `teammate: "<name>"`, over any roster `role`): a shared board, per-agent mailboxes, and an in-process panel.

- **Shared board** (`.wudao/teams/<team>/tasks.json`): claims ride an atomic **mkdir file-lock** (`locks/<task>.lock`) — two processes racing one task produce exactly one winner; **dependency completion auto-unlocks** dependents (a task is claimable only when every `dependsOn` id is done). Bad rows drop on read, never fatal.
- **Mailboxes** (`.wudao/teams/<team>/inboxes/<agent>.json`): a successful atomic write IS the send; entries validate on read (bad rows dropped without blocking delivery); 100-entry cap, 8KB per message.
- **Teammate spawn**: the role's tools/model apply; the **definition body appends** to the teammate preamble (and the role's §B memory section rides too); **send_message + task are auto-added** — the teammate's task wrapper REFUSES `background: true` (in-process teammates have no background subagents). Teammates persist per **sidechain session** (each dispatch resumes it). `teammateModel` (settings) replaces the team's base model at start — teammates never follow `/model`; `/effort` DOES apply.
- **Permissions bubble**: the teammate's gate IS the lead's gate (an ask parks at the lead's terminal; a lead deny stops the teammate — denied actions never relay). **Plan flow** reuses the M37 gate: `dispatch(plan)` runs read-only → the plan parks as pending → approve runs the execution prompt / reject re-plans with your feedback.
- **Messages**: `send_message` (the teammate flavor) writes mailboxes; a **waiting teammate wakes immediately** with the message; intra-team text keeps the §A untrusted semantics (banner; the auto-tier sidecar reviews before delivery). API-error idles notify the lead with the error text. **TeammateIdle hook** (`onTeammateIdle`, matcher = teammate name): exit 2 / `{"continue":true,"feedback"}` works the teammate one more round.
- **TUI panel**: `↑↓` select · `Enter` view/direct-send (approve/reject on plan rows, shift = reject) · `x` stop; idle rows hide after 30s; past 3 visible rows it collapses.
- **Constraints** (照抄 the upstream format): one team per session (second team refused), no nesting, no background subagents under teammates, resume does not restore teammates. The task board/mailboxes are plain files — the §A machinery never applies to them.

### Edit truth (M32)

The agent's belief about a file is tracked, guarded, and kept fresh:

- **Read-freshness gate (fail-closed).** Every successful `read_file` records `{content hash, mtime, lineCount}` (+ diff snapshot) in a per-session table shared by `read_file`/`edit`/`write_file`. An `edit`/`write_file` against a file whose mtime differs from the recorded one is refused with `file changed since your last read — re-read it`; `edit` also compares the content hash (mtime can lie). The session's own writes refresh the entry (read→edit→edit needs no re-read).
- **Fuzzy match ladder.** Exact → quote-normalized (`“”‘’` → straight) → whitespace-tolerant; every rung demands a **unique** hit (ambiguity is an error naming the rung); the result notes the matched level; not-found errors attach a ±4-line numbered closest candidate. `replace_all` replaces every occurrence and reports the count; successful edits return a ±4-line numbered snippet.
- **External-change injection.** Before each model call the harness stats the read-state table (≤5 files/round, ~20ms, round-robin). An externally changed file is re-read and delivered as a `<file_changed>` unified-diff note (8KB cap), and the table refreshed — the injected version counts as read, so a follow-up edit is not staleness-refused.
- **MetaNote channel.** System-class notes (`<file_changed>`, `<files_rewound>`) ride `LoopOptions.metaNotes` — a `take()` queue like steering — appended into the **last tool_result tail** as `<system_note>…</system_note>` for the next model call. **Projection-only:** the model sees the note, but `state.messages` and the JSONL keep the original tool_result bytes. Gate/steering injections stay ordinary user messages (they fire at a no-tool-call seam where an append-only push is *more* cache-friendly).

### Workspace confinement & env hygiene

All file tools are workspace-confined in the CLI: absolute paths outside the workspace and symlink escapes (dangling symlinks, symlinked intermediate directories, trailing-separator root tricks) are denied. `shell` scrubs credential-shaped env vars (`*API_KEY`/`*ACCESS_KEY`/`*TOKEN`/`*SECRET`/`*PASSWORD`/`*CREDENTIALS` + `WUDAO_*`/`OPENAI_*`) from the child env. `.env` inside the workspace remains readable (v1 limitation).

### Trust model

`.wudao/` is **code, not data**: hook commands, MCP servers, role rosters, workflow scripts, and — most explicitly — `.wudao/extensions/*.mjs` (imported and run at startup, full privileges) all execute with your user privileges when you run the agent in that workspace. Treat a cloned workspace's `.wudao/` like its shell scripts — read before running. Specifically: `run_script` executes model-written code in a child — the js lane's filesystem is permission-locked to its RPC channel (no fs outside it, no child processes; network still ungated), while the python lane has no fs sandbox at all (`language: "python"` runs stdlib python3 at exactly `shell`'s trust level) — treat both like `shell`, not like a jail; a roster file can point children at a different provider and widen their tools (`frozen` protects a pin *from the model*, not the workspace from you); plugin `hooks/`+`.mcp.json` merge into the same execution surfaces; an extension IS code with the same reach as any hook command, plus tools and slash commands; hook/extension failures degrade to allow (fail-open by design — a broken hook must not wedge a run, which also means hooks and extensions are convenience layers, not security boundaries). For distrusted work: a read-only tier (`--plan`/`--ask`), `--sandbox`, or a machine boundary.

### Known limitations (tracked for later milestones)

- Permissions are approval-based, not sandboxed by default: `--auto` runs everything; sandbox covers `shell` only (above).
- The read-state table is per-process, not persisted: a `--resume` run starts with an empty table; it rebuilds lazily as the model reads.
- Configured hooks are fail-open (a throwing `onPreToolUse` degrades to allow) — convenience, not boundary.
- Write scopes are declared, not inferred: a role without `writeScope` writes anywhere inside the workspace.
- plugin `matcher` patterns are accepted but not applied (our preToolUse hooks see every tool).
- `reasoning_content` is surfaced in the CLI and carried on `AssistantMessage.reasoning`, never sent back to the provider (correct — reasoning is per-response).
- `run_script`'s js lane is Node-permission sandboxed (filesystem and child processes only — network stays reachable); its python lane has no filesystem sandbox (shell-level trust — prefer the js lane for anything untrusted); both: use `--sandbox` for hostile code. Inner `call()`s skip `onPreToolUse`/`onPostToolUse` hooks and the loop-safety window (they are permission-gated, but not hook-observed).
- The meta journal records and ranks; it never decides. Auto-rollback and an LLM meta-agent over `.wudao/experiments.jsonl` are deliberately out of scope.

## Configuration reference

### Global config (`~/.wudao/`, M57)

Every project-level config surface has a **user-global twin** under `~/.wudao/`
(override the location with `WUDAO_GLOBAL_HOME` — tests/CI use this to stay
isolated). Same schema as the project files; precedence **defaults < global
< project < local** — the more specific tier wins conflicts, except where
the trust gate below says otherwise.

| Global file | Merges with the project tier as |
| --- | --- |
| `~/.wudao/settings.json` | **deep merge**; `permissions`/`hooks` arrays **concat + dedup** across tiers (rules accumulate — a global allow and a project allow are both live). Hot-reload watches BOTH files. |
| `~/.wudao/mcp.json` | **per-server-name replacement** — a project server with the same name fully replaces the global one (no field merging); different names union. |
| `~/.wudao/keybindings.json` | **per-key override** — the project file rebinds action names one by one; global keys it doesn't mention survive. |
| `~/.wudao/agents/<role>.json` | roster layer `builtin < plugin < global < workspace` — a same-name project role wins; displacement receipts annotate the tier (`global agents/<f>.json`). |
| `~/.wudao/skills/<name>/SKILL.md` | same-name **project skill wins**, with a load warning naming both paths. Global skills live outside the workspace (`read_file` is workspace-bounded), so the prompt manifest advertises `invoke: /skill:<name>` instead of a path. |
| `~/.wudao/rules/<path>.md` | same-name **project rule wins**, with a load warning naming both paths (M62 §1). |
| `~/.wudao/output-styles/<name>.md` | same-name **project style wins**, with a load warning (M62 §4). |

**Custom providers (`~/.wudao/providers.json`).** Registry-custom providers (and overlays on the four built-ins) live in `~/.wudao/providers.json` (same `WUDAO_GLOBAL_HOME` override) — select one with `--provider <id>` / `WUDAO_PROVIDER=<id>` anywhere a builtin works (boot, `/provider`, workflows); API keys still live only in `.credentials.yaml` / env, never in this file. A builtin overlay cannot be deleted (builtin ids are permanent) — "resetting" one means saving a minimal config so its fields fall back to the compiled-in defaults.

**The LOCAL tier (M62 §3).** `.wudao/settings.local.json` is the **highest
user-editable layer** (global < project < local): scalars local-wins, arrays
concat + dedup across all three tiers in that order. It exists for personal
overrides you don't want to commit — and the first write **auto-gitignores**
the file (an existing `.gitignore` gains the entry; no `.gitignore` → a
warning with manual guidance; the harness never invents one). Write it with
`/config set local <key> <value>` (a JSON-parsable value keeps its type —
`/config set local fallbackModel ["m-a","m-b"]`; effective next session) or
by hand.

**Trust ruling — local follows project trust.** The local file is physically
inside the project directory, so a cloned repo can carry it. It therefore
gets **exactly the project trust posture**: privilege-escalation keys
(`bypassPermissions`, auto-mode opt-ins, settings `env`, protected-path
relaxations, `sidecar.enabled:false`) are **refused from the local tier
too**, with a warning naming the file — deliberately stricter than the upstream format,
which trusts its local file as user-authored; the cloneable-file reality
wins. The same reasoning applies to the root `WUDAO.local.md` personal
context file (below): it loads LAST in the M54b order (the most specific
personal tier) and deserves project-file trust, not user-global trust.

`/config` shows all three tiers plus a **per-key source annotation**
(`global` / `project` / `local` and their combinations), then env and flag
overrides — the effective view, read-only.

**Trust gate (a known RCE precedent).** The project tier is attacker-controllable
content. The gate enforces **escalation-key refusal from the project tier**:
privilege-escalation keys (`bypassPermissions`, `autoMode`/auto-accept
opt-ins, settings-level `env` injection, protected-path relaxations) are
**dropped with a warning** whenever they appear in the project file; the
same keys read from the global tier apply (you wrote those). A project
`sidecar.enabled: false` (disarming the auto-mode classifier) is refused the
same way — a project may tighten the safety gate, never relax it. To
actually disable the sidecar use `WUDAO_SIDECAR=off`, `--no-sidecar`, or set
`sidecar.enabled:false` in the GLOBAL tier's settings.json — the refusal
notice says so. What the gate does **not** cover (pre-M57 array-concat
semantics, unchanged by design): a project-tier `permissions.allow` entry
still auto-allows matching tools in default/auto mode, and project-tier
hooks are code execution — treat a cloned `.wudao/` like its shell scripts.
`writeVerify.enabled:false` and longTask-gate disablement from the project
tier are not gate-covered either (follow-up candidate). Plugins and
extensions are deliberately **not globalized** (code-execution trust
boundary). Credentials never live in settings; they live in
`~/.wudao/.credentials.yaml` (M63 §B: one `PROVIDER_ID: <key>` line per
provider, written by the web settings page; chmod 0600 enforced on every
write). The file is a **fallback key source only** — any env key
(`WUDAO_API_KEY` / `OPENAI_API_KEY` / `WUDAO_API_KEYS`) wins over it, and
the file's entry only applies when the env pool is empty. Surfaces report
it as a count only (`/doctor`: "credentials file: N keys"; statusline:
`credentials N keys`) — key values are never logged, echoed, or returned to
the web client after a save.

`/permissions` shows the UNION the gate enforces, each rule tagged with its
tier (`global` / `project` / `global+project`). Mutations write the PROJECT
file only — the global tier is never copied into the repo, and removing a
global-tier rule refuses the write, naming the global file as the rule's
home.

### Environment variables

| Env var | Default | What |
| --- | --- | --- |
| `WUDAO_API_KEY` (fallback `OPENAI_API_KEY`) | — | provider API key (the pool's primary; M56) |
| `WUDAO_API_KEYS` | — | comma-separated extra keys: the multi-key pool (round-robin; a 429 cools the key 60s; `keys n/m` in /status + statusline; M56) |
| `WUDAO_PRICE_<MODEL>` | — | per-M-USD price `in,out,cacheRead,cacheWrite` for `/cost`'s $ line (e.g. `WUDAO_PRICE_DEEPSEEK_V4_FLASH=0.27,1.10,0.07,0.27`; unpriced ≠ free — the note counts missing spend; M56) |
| `WUDAO_BASE_URL` (fallback `OPENAI_BASE_URL`) | profile | override the provider's baseUrl |
| `WUDAO_MODEL` (fallback `OPENAI_MODEL`) | profile | override the provider's model |
| `WUDAO_PROVIDER` | `deepseek` | `deepseek` \| `glm` \| `qwen` \| `wudao` — also accepts a custom provider id from `~/.wudao/providers.json` (see Custom providers above) |
| `WUDAO_PERSONA` | — | default persona for the run: `<id>` or `<id>:headers,body,prompt` (any subset; a bad value errors, never silent) — see [Persona](#persona客户端角色扮演) |
| `WUDAO_REASONING_EFFORT` | — | `low` \| `medium` \| `high` \| `max` \| `none` |
| `WUDAO_REASONING_FORMAT` | profile | override the reasoning-format matrix entry (validated at startup) |
| `WUDAO_WIRE` | profile | override the wire protocol (`selection.wire` > `WUDAO_WIRE` > `profile.wire` — e.g. `anthropic` for the messages protocol) |
| `WUDAO_LOG_LEVEL` | `info` | `error` \| `info` \| `debug` |
| `WUDAO_CONTEXT_WINDOW` | `200000` | context window (tokens); compaction triggers at 0.8×. Doc-verified builtin pins win over it (deepseek v4 线 1M / glm-4.6 204_800 / qwen3-max 262_144); to force a window use `autoCompactWindow` or a `providers.json` models overlay |
| `WUDAO_SANDBOX` | off | `1` enables the Docker sandbox for `shell` |
| `WUDAO_SIDECAR` | on | `off` = disable the auto-mode sidecar classifier (M45) |
| `WUDAO_SANDBOX_IMAGE` | `node:22-alpine` | sandbox container image |
| `WUDAO_MAX_TURNS` | `200` | runaway turn fuse; `0` = unlimited |
| `WUDAO_LONG_TASK_GATES` | on | `off` = emergency kill switch for both stop gates |
| `WUDAO_WRITE_VERIFY` | on | `off` = no post-write syntax receipts; `ts-off` = force the tsc lane off (M46) |
| `WUDAO_LONG_OUTPUT` | on | `off` = no head/tail shaping for long `shell` output (M46) |
| `WUDAO_AGENT_BUDGETS` | on | `off` = disable adaptive fan-out budgets (suggestions, receipts, recording) |
| `WUDAO_BG_REVIEW` | on | `off` = disable the background memory-review fork after successful runs (M49) |
| `WUDAO_DEFER_TOOLS` | on | `off` = load the full tools array eagerly (no `load_tools`) |
| `WUDAO_EXTENSION_TIMEOUT_MS` | `10000` | per-call budget for extension event handlers; `0` = off |
| `WUDAO_MAX_RETRIES` | `4` | provider retry-ladder attempts after the first |
| `WUDAO_NO_PROJECT_CONTEXT` | — | any non-empty value disables project-context file loading (M54) |
| `WUDAO_GLOBAL_HOME` | `~/.wudao` | the global config tier's directory (settings/mcp/keybindings/agents/skills; M57) |
| `WUDAO_NO_<FEATURE>` | off | the `--no-<feature>` ablation bridge (see the matrix below; M53) |
| `WUDAO_DISABLE_PEER` | off | `1` disables peer messaging entirely (no socket, no registry entry; the tools answer with the refusal; M64-A) |
| `WUDAO_PEER_SOCKET` | on | `1` re-enables the peer UDS inbox under `--sandbox` (off by default there; M64-A) |
| `WUDAO_MSG_SOCKET` · `WUDAO_MSG_TOKEN` | — | exported TO hook subprocesses only: the session's inbox socket + the auth-self loopback token (M64-A) |

Malformed values warn and fall back per-field — never fatal.

#### Ablation matrix (`--no-<feature>`, M53)

Every feature below can be fully disabled for one run with `--no-<feature>`
(both `--no-sidecar` and `-no-sidecar` / `--no_sidecar` spellings parse).
The flags are bridged into `WUDAO_NO_<FEATURE>` env entries once per process,
so deep seams (the driver's steering queue, the read_file elision probe)
check the same state without prop threading. Evals use these for ablation
comparisons; unknown `--no-*` flags are ignored, and a run with none of them
is byte-equivalent to the default. A `--no-<feature>` counts only while it
precedes every non-flag argument — `wudao --no-gates fix the bug` ablates,
`wudao fix --no-gates the bug` is a prompt about the flag (value flags like
`--resume <id>` compose in the leading window).

| Flag | Disables |
| --- | --- |
| `--no-sidecar` | the auto-mode safety classifier entirely (M45) |
| `--no-verify` | post-write syntax receipts on write_file/edit (M46) |
| `--no-diagnostics` | the new-diagnostics baseline-diff layer (M51; verify receipts stay) |
| `--no-language` | the Chinese language transient block (M47) |
| `--no-review-fork` | the background memory-review fork (M49) |
| `--no-steering` | the mid-run steering queue (a busy submit is refused with a notice) |
| `--no-gates` | the long-task stop gates (todo/verify insist loops, M23) |
| `--no-loop-safety` | the loop-safety detectors and forced aborts (M48) |
| `--no-elision` | read_file zero-repeat elision — re-reads always return content (M24) |

### CLI flags

| Flag | What |
| --- | --- |
| `--auto` | allow every tool call (settings denies and settings-write asks still apply) |
| `--ask` | prompt before every tool call (the interactive tier) |
| ~~`--read-only`~~ | **retired in 0.3.12** — use `--plan` for a read-only round; the flag survives only as a `wudao workflow run` mode flag |
| `--sandbox` | run `shell` inside Docker (fail-closed) |
| `--no-sidecar` | disable the auto-mode sidecar classifier for this run (M45) |
| `--provider <name>` | select the provider profile |
| `--reasoning-effort <v>` | `low` \| `medium` \| `high` \| `max` \| `none` |
| `--plan` | one-shot plan mode: read-only round → printed board (+ TTY `execute? [y/N]`) |
| `--image` | attach `<path>` image file(s) to the one-shot prompt (repeatable, newest = flag order) |
| `--name <v>` | name this session for peer messaging (`list_agents`/`send_message`; `/rename` re-names mid-session; M64-A) |
| `--plugin <path>` | mount a the upstream format plugin dir for this run (repeatable) |
| `--trust-workspace` | headless trust-gate escape hatch for ONE run — load project skills/plugins/allow/hooks without an interactive `/trust accept` (never writes `~/.wudao/trust.json`) |
| `--no-tui` | readline REPL instead of the Ink TUI |
| `--continue` | resume the most recent session |
| `--resume <id>` | resume a specific session |
| `--fork-session` | with `--resume <id>`: copy the session JSONL to a fresh id and resume the fork — the original file is never touched (M58 §C#5) |
| `--list-sessions` | print the session table and exit |
| `--debug` / `--quiet` / `--log-level <l>` | log verbosity (`--debug` > `--quiet` > `--log-level` > env) |

Value flags accept `--flag <v>`, `--flag=<v>`, and tolerate the single-dash `-flag` quirk. All flags are stripped from the prompt.

### Subcommands

| Command | What |
| --- | --- |
| `wudao "<prompt>"` | one-shot run |
| `wudao workflow run <file.js\|file.json> [--auto\|--read-only] [--args '<json>'] [--budget-tokens <n>] [--resume <runId>]` | run a workflow script (or M22 JSON) |
| `wudao workflow list` / `wudao workflow status <runId>` | past runs / one run's receipt |
| `wudao plugin list` | installed-plugin inventory (name/version/counts/warnings) |
| `wudao meta report` | per-lever experiment aggregation: win/loss per value, Wilson 95% lower-bound ranking, task-level flip attribution (report only — nothing is auto-changed) |
| `wudao meta record <lever> <from> <to> [--task <t>] [--outcome ok\|fail\|worse]` | append one manual experiment entry |
| `wudao meta apply <settings.json> [--task <t>]` | write `.wudao/settings.json` atomically; fields of nodes marked `experimental: true` auto-record into the journal |
| `wudao purge [--dry-run] [--yes]` | soft-delete ALL runtime data (sessions transcripts, spills, `/rewind` snapshots, debug logs — never memory/config) into `.wudao/trash/`; prints the plan first; `--dry-run` writes nothing (M62 §2) |
| `wudao statusline [--json]` | machine-readable session state for user statusline scripts (M53): `--json` prints the full snapshot (model/provider/mode/session/ctx/cache/board/sidecar/bg/live) rebuilt from the newest session file + env; bare form prints the one-line human summary. Debouncing is the consumer's job; in a live session `snapshotForStatusline()` on the driver serves the same shape (the TUI bar renders from it) |

### Workspace files

| Path | What |
| --- | --- |
| `.env` | provider config (auto-loaded, walked up from cwd; gitignored) |
| `WUDAO.md` · `AGENTS.md`/`agents.md` · `CLAUDE.md` | project context (M54/M54b, reference-aligned) — the **user-global baseline `~/.wudao/WUDAO.md`** (if present) loads **first**, then the **`.git`-bounded ancestor chain** of the workspace root: walk up to the nearest ancestor containing `.git` (inclusive; a worktree's `.git` *file* counts; no `.git` within a 10-level sanity bound → root-only; never walks to the filesystem root) and load it **root → cwd** — parent/broadest first, cwd/most-specific **last** (highest priority, like upstream harnesses). Within a single directory files concatenate in **alphabetical filename order** (`AGENTS.md → CLAUDE.md → WUDAO.md`; `agents.md` is the accepted lowercase spelling, exact-case `AGENTS.md` wins if both are present). Identical content (whitespace-trimmed) loads **once** — the more-specific copy keeps its position (kills the AGENTS.md-symlinked-to-CLAUDE.md double load). Everything lands in the system prompt's `# Project context` tail section, each file under a `## <path>` header (project-root-relative, e.g. `packages/foo/AGENTS.md`; the global shows as `~/.wudao/WUDAO.md`). Budget: a single file >64KB is truncated with a warning, and the whole section is capped at **128KB** — over budget the broadest files drop first with a `[project context: omitted <path> (budget)]` notice; the most specific (cwd) file is always kept. `.claude/CLAUDE.md` is never read. Loaded **once at startup — no hot reload**: editing these files mid-session does nothing until restart (re-reading would shift prompt bytes and break the provider prefix cache). Dead symlinks are skipped with a warning. `/context` shows the section's token cost per file. |
| `.wudao/settings.json` | `hooks` · `permissions {allow,deny,ask}` · `lsp {enabled}` (default off — the LSP tool's opt-in) · `longTask` · `sidecar` · `writeVerify` · `longOutput` · `peerInbound` (`accept`\|`hold`\|`refuse`; project/local tiers may only tighten — `refuse` overrides everything, `accept` there is dropped) · `peerDialogExpiry` (ms or `"never"`, default 5min) (permissions hot-reloaded; the rest read at startup; any node may set `experimental: true` — its changed fields auto-journal via `wudao meta apply`; the `~/.wudao/settings.json` global twin deep-merges under it — see [Global config](#global-config-wudao-m57)) |
| `.wudao/mcp.json` | MCP servers (`{"servers": {"<name>": {command, args, env, timeoutMs?}}}`; the `~/.wudao/mcp.json` global twin merges per-server-name) |
| `.wudao/agents/<role>.json` | role roster profiles (shadow builtins; `frozen` pins; `~/.wudao/agents/` sits between plugins and these; M64-B: `memory`: `project`\|`local`\|`user` selects the role's persistent-memory tier, default `project` — see [Agent memory](#agent-memory-m64-b)) |
| `.wudao/keybindings.json` | TUI keybinding overrides (read once at startup; `~/.wudao/keybindings.json` applies under them per key) |
| `.wudao/plugins/<dir>/` | the upstream format plugin packages |
| `.wudao/extensions/*.mjs` | code extensions (ExtensionAPI v1 — **run at startup**) |
| `.agents/skills` · `.wudao/skills` · `.claude/skills` | skill packs (`SKILL.md`) |
| `.wudao/sessions/` | append-only session JSONL transcripts |
| `.wudao/settings.local.json` | the LOCAL settings tier (M62 §3): highest user-editable, scalars local-wins / arrays concat-dedup `global→project→local`, same trust gate as the project tier (cloneable file — escalation keys refused). First write auto-gitignores it. |
| `WUDAO.local.md` | root personal context file (M62 §3) — loads LAST in the M54b project-context order (global → git-bounded parents → project root → local). Cloneable like settings.local.json; same trust posture as any project file. |
| `.wudao/rules/` | context rules (M62 §1): no-`paths` rules join the project-context stable section; `paths:` rules lazy-load into the message history on the first matching `read_file`/`edit` (`~/.wudao/rules/` is the global twin) |
| `.wudao/output-styles/*.md` | output styles (M62 §4); settings `outputStyle` selects one; body appended in the stable prompt tail (or replaces the coding-instructions section with `replace-coding-instructions: true`) |
| `.wudao/history/<session>/` | pre-write snapshots for `/rewind` (cleanable — see [Data lifecycle](#data-lifecycle--privacy-m62-2)) |
| `.wudao/trash/` | soft-delete staging (M62 §2): expired/purged runtime data lands here mirrored, hard-deleted after `softDeletePeriodDays` (default 7) |
| `.wudao/workflows/` | workflow journals + terminal `state.json` |
| `.wudao/plan.md` · `.wudao/agents-stats.json` · `.wudao/spill/` · `.wudao/evals/` | board copy · budget samples · shell spills · eval results |
| `.wudao/agent-memory/<role>/MEMORY.md` · `.wudao/agent-memory-local/<role>/MEMORY.md` | M64-B agent memory: project tier (expires with `cleanupPeriodDays`; purge never touches it) · local tier (never cleaned). The user tier lives at `~/.wudao/agent-memory/` |
| `.wudao/teams/<team>/` | M64-C teams: `tasks.json` (mkdir-locked claims, dependency auto-unlock), `inboxes/<agent>.json` (mailboxes), `locks/` |
| `.wudao/experiments.jsonl` | append-only meta experiment journal (`wudao meta report/record/apply`, M50) |
| `.wudao/wt/` | per-child git worktrees |

## Data lifecycle & privacy (M62 §2)

Session transcripts are **plaintext on disk** (`.wudao/sessions/*.jsonl`) —
everything you and the model said, plus tool results, spills
(`.wudao/spill/`), and `/rewind` checkpoint snapshots
(`.wudao/history/<session>/`). They are runtime data, not memory, and they
self-expire:

- **`cleanupPeriodDays`** (settings, default **30**): at startup a cheap
  scan moves every expired transcript/spill/snapshot/debug log out of the
  workspace. The current session's file is protected (`--resume`d old
  sessions never race the sweep).
- **Soft delete first**: nothing is hard-deleted on the spot. Expired files
  **move to `.wudao/trash/`** (structure mirrored, recoverable by hand);
  trash entries older than **`softDeletePeriodDays`** (default **7**) are
  then hard-deleted by the same scan. Regret has a window.
- **Never touched**: `memory.jsonl`, `settings*.json`,
  `experiments.jsonl`, the `agents/`/`skills/`/`rules/` dirs, the global
  `history.jsonl` — memory and configuration are not runtime data. The
  cleanable set is structurally exhaustive: only
  `sessions/`, `spill/`, `history/`, `logs/` (+ loose `*.log`) are ever
  walked.
- **`wudao purge [--dry-run] [--yes]`**: clean ALL runtime data now
  (regardless of age) — prints the plan (path + size + age per file),
  asks `y/N` (skipped by `--yes`), then soft-deletes into `.wudao/trash/`.
  `--dry-run` prints the plan and writes zero bytes. `/doctor` reports
  trash residency (files/bytes/oldest age).

A purge'd workspace works normally afterwards — new sessions create their
files as usual; only the dead runtime data is gone.

## CI (GitHub Action)

The repo-root [`action.yml`](action.yml) wraps the headless one-shot CLI (`wudao "<prompt>"`) as a composite action (M58): it sets up pnpm + Node 22, builds the harness from the action's own checkout, and runs the agent against your repo. Inputs: `prompt` (required), `working-directory` (the agent's workspace root — sessions land under `.wudao/sessions/` there), `provider` / `model` / `base-url` / `api-key` / `reasoning-effort` (provider passthrough — `api-key` belongs in a secret), and `extra-flags` for anything else.

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: feiniaojin/wudao-harness@v0.3.0   # or a commit SHA
        with:
          prompt: "Review the diff and list correctness risks"
          provider: deepseek
          api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          extra-flags: "--plan"
```

Notes:

- **Permissions are fail-closed headless** — outside a TTY an "ask" decision denies with `non-interactive` (no hang). Shape the run with `extra-flags`: `--auto` (pre-approved writes) or `--plan` (read-only exploration round — review-style tasks); settings `permissions.deny` rules still apply in both.
- The action builds from source today; once `wudao-harness` is published to npm the build step will switch to `npx wudao-harness@<version>` with no workflow changes.
- A runnable demo lives at [`.github/workflows/wudao-agent.yml`](.github/workflows/wudao-agent.yml) (manual `workflow_dispatch`, key from `secrets.WUDAO_AGENT_KEY`).
- The one-shot exits non-zero on a failed run, so the step can gate a workflow; `wudao perms lint` (exit 1 on findings) composes as a plain step when you want a permissions-hygiene gate.

## Development

```bash
pnpm build                 # build all packages (cold tree: core first — see below)
pnpm test                  # vitest across all packages (core/providers/server/web/cli/slack/evals)
pnpm check                 # tsc --noEmit across all packages
pnpm eval                  # deterministic regression suites (det-* + deterministic) then live suites (.env key)
pnpm eval --workloop <session.jsonl>   # the upstream harness work-loop score for one session
pnpm demo                  # deterministic no-key demo
```

### Work-loop scorer (M48)

`pnpm eval --workloop .wudao/sessions/<id>.jsonl` scores a real session against the the upstream harness **Agent Work Loop** model: 5 dimensions × 15 checks, each check mapped to one of 7 evidence states (`missing/unobserved/not-applicable ≤ 59`, `present ≤ 74`, `wired ≤ 84`, `exercised ≤ 94`, `outcome-supported = 100`); a dimension scores the MIN of its checks, the overall is the mean. The axiom is **"a configured capability is not observed use"** — a clean single-session transcript honestly scores *Unobserved* on the axes only targeted probes or cross-session memory can evidence. Findings fire only on `missing` checks (an inspected gap), never from a score. Observational only — no CI gate.

**Self-baseline (harness-level, overrides lane, 2026-08):**

| Dimension | Evidence | Score |
| --- | --- | --- |
| Task Understanding | Exercised (plan mode + gates + write scopes, eval-covered) | 94 |
| Controlled Execution | Exercised (sandbox + 5-layer permissions + workspace boundary) | 94 |
| Change Validation | Outcome-supported (write-verify loop + det/live suites) | 100 |
| **Reliable Delivery** | **Present–Wired (rewind exists; no revision-bound acceptance boundary)** | **74** |
| **Learning Capture** | **Missing–Unobserved (no cross-session memory, no intervention ledger)** | **59** |

Overall ≈ 84. The two weak axes (delivery reliability, learning capture) are the M49 memory/self-improvement milestone's explicit targets.

Cold-tree build note: the workspace has a benign manifest cycle (`@wudao/core` dev-depends on `@wudao/providers` for test history), so on a tree with no `dist/`, run `pnpm --filter @wudao/core build && pnpm build` once; subsequent builds are fine.

Verify a real endpoint yourself:

```bash
set -a; . ./.env; set +a
node scripts/verify-deepseek.mjs   # text round-trip + tool-call + 2-turn tool-use
```

- **Architecture** — the Trust-Laddered Hybrid Kernel pattern, mechanism/policy inventory, package structure, the six design tensions and where each lives, key data flows: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Onboarding** — new-contributor reading path (constants first, loop first, one motto per mechanism, reference-comparison table): [docs/onboarding/](docs/onboarding/README.md)
- **Decision records** — `docs/adr/0001…0008` (one page each: TS from-scratch loop · zero-dep mechanism/policy core · trust rungs · KV-cache invariant · reasoning matrix · append-only sessions · gates in the loop · evals as contract)
- **Changelog** — one line per milestone M0–M37: [CHANGELOG.md](CHANGELOG.md)
- **Release process** — [docs/RELEASE.md](docs/RELEASE.md)
- **Design research** — `docs/research/01…13` (design space, reference projects, design DNA, KV-cache studies, port-candidate analyses)
- **Milestone specs** — `docs/superpowers/specs/` (one spec per milestone)

**Tech:** TypeScript (strict, ESM, NodeNext) · Node ≥ 22 (ink@7 floor) · pnpm 11 workspaces · vitest · zero runtime deps in core.
