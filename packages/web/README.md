# @wudao/web — wudao ui

The browser frontend of `wudao ui` (M43-B): **TUI full parity** over the WS
protocol — a pure protocol consumer with zero agent logic. The contract is
[`packages/server/PROTOCOL.md`](../server/PROTOCOL.md); its types are
hand-mirrored into [`src/protocol.ts`](src/protocol.ts), the only file that
knows the server exists.

## Run

```sh
pnpm --filter @wudao/web build   # → dist/ (also part of the root build chain)
wudao ui                         # serves dist/ at the printed loopback URL
```

`wudao ui` prints `http://127.0.0.1:<port>/#<token>`; the token rides the URL
fragment (never a request line) and is sent as the first WS frame. Dev loop:
`pnpm --filter @wudao/web dev` (vite on :5173) against a running server.

## Surface (the TUI parity checklist)

- **Conversation** — streaming markdown (the TUI's block/inline grammar) with
  a zero-dep per-line code highlighter, collapsible reasoning (head-of-thought
  summary), ⏺/↳ tool cards (⏹ + `[error]` on failures), ✏️ red/green inline
  diffs (context runs collapse), 📋 todo board (☑/◐/☐), `── dividers ──`,
  resume history, warn notices, err errors.
- **Input** — multi-line (Enter send · Shift+Enter newline · `\`+Enter
  continuation), ↑/↓ submitted-prompt history at the buffer's first/last line,
  `/` suggestion menu (live `listSlashCommands` data, ≤7-row scrolled window,
  Tab/Enter complete, Esc dismisses per token), `@` mention hint.
- **Controls** — steering (submit while busy → ⏳ queue), interrupt (Esc /
  button), mode cycling (shift+tab / chip: ask → auto → read-only, live in
  the status bar), permission modal (y/a/N + typed deny reason; policy-file
  asks degrade to y/N; git-risk warning + sidecar reason render), plan review
  (ok / 改 …), `/resume` picker, `/rewind` (text-routed, list lands as a
  notice), `/clear` confirm, `/help` from the live command list.
- **Status bar** — `wudao · <session8> │ mode │ ctx N/M ⚠ │ cache % │ ▣ d/t │
  bg n/m │ sidecar N │ 🛡✕` (absent segments omitted). The server-side
  shutdown path terminates sockets and aborts the in-flight run, so Ctrl+C
  exits `wudao ui` promptly even with a connected tab and a live run (the
  browser then shows the reconnect flow instead of a hung 1006).
- **Connection** — reconnect banner with capped backoff (1s → 2s → 4s → 8s →
  16s → 30s, **8 attempts max**); the re-run auth replays the full history
  (`reset:true`) and restores the surface. 4401 stops (bad token); 4000
  retries (the other tab may close). Past the cap the banner turns terminal —
  `连接已断开 — server 可能已退出，重启 wudao ui 后点击重连` — with a manual
  重连 button. While offline the send control disables (the draft is kept)
  and mode clicks queue client-side (latest wins) and flush on reconnect — a
  click on a dead socket never surfaces an error toast.

Terminal-dark theme keyed by the TUI's ink names (`cli/src/tui/theme.ts`),
monospace, responsive (hints/status shrink under 640px).

## Layout

```
src/
  protocol.ts          PROTOCOL.md mirror + WudaoClient (store + reconnect)
  use-ui.ts            useSyncExternalStore adapter
  input-state.ts       the reused M44 input-machine rules (history, Enter, caret)
  slash.ts             slash menu + /help rules (TUI mirror)
  frontend-commands.ts the frontend-owned command router (exit/clear/help/resume)
  markdown.tsx         block/inline grammar + fenced-code render
  highlight.ts         zero-dep per-line tokenizer (why: highlight.js ~1MB vs a
                       fenced-code contract the TUI itself serves per-line)
  diff.ts / board.ts / log.ts   hunk math, ☑◐☐ marks, display helpers
  components/          App, HistoryList, LiveArea, StatusBar, InputBox,
                       PermissionModal, AskUserCards, PlanReview, ResumePicker,
                       ClearConfirm
tests/                 fake-WS protocol round-trips, input-machine/slash rules,
                       jsdom component + App interaction suites
```

## Known v1 gaps (protocol, not UI)

- **No model label** — the state snapshot has no model field, so the status
  head is `wudao · <session8>` (the TUI shows the provider label).
- **`/clear` is view-level** — protocol v1 has no driver-clear op; the saved
  session persists (a reconnect replay or `/resume` restores it).
- **`a` (allow-this-session) answers allow-once** — answerPermission carries
  only `{allow, reason}`; the TUI's client-side session-allowlist rule has no
  op counterpart.
- **ask_user has no trigger** — `wudao ui` leaves the tool fail-closed
  unwired and the protocol has no ask frame; `AskUserCards` is component-
  complete and tested for the v1.1 seam.
- **Plugin/extension commands** — a `"frontend"` submit outcome (their
  execution is caller-owned) shows an honest notice; the templates cannot be
  expanded over v1.
