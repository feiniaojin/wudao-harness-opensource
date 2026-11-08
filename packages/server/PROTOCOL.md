# wudao ui — WS protocol v1 (M43-A §2)

The contract between `@wudao-org/server` and its frontends (the v1-A placeholder
page, the coming web UI (B), and Tauri (C)). One server process owns one MAIN
driver plus any number of mounted SIDE lanes — multi-driver via lane
addressing, see the Lanes section; transport is a single JSON frame per
WebSocket message.

## Connection

- The server binds **loopback only** (`127.0.0.1`; any other bind is refused).
- The `Host` header must be `127.0.0.1`, `localhost`, or `[::1]` (DNS-rebinding
  guard). Anything else: HTTP 403 / upgrade refused.
- **First-frame auth**: after connect, the client's FIRST message must be
  `{"t":"auth","token":"<token>"}`. Wrong token, malformed frame, or silence
  for **5s** → close `4401`. (Browsers cannot set custom WS headers, so the
  shared secret rides the URL **fragment** — `http://127.0.0.1:<port>/#<token>`
  — which never appears in any request line or the process list; the page JS
  reads `location.hash` and sends it as the auth frame.)
- **Single client**: while one authenticated connection is open, any new
  connection is closed with code `4000` ("another client is already
  connected"). Reconnecting after a drop re-runs auth and gets a full replay.
- Ping/pong every 30s; a socket that misses a sweep is terminated.
- On successful auth the server immediately sends the initial
  `{t:"state"}` + `{t:"history", reset:true}` pair.

## Downstream (server → client)

| frame | shape | when |
| --- | --- | --- |
| state | `{"t":"state","state":{…}}` | after auth and on every status change. A **full, small snapshot** — `live{reasoning,answer,busyTools}`, `busy`, `queued`, `boardProgress`, `ctxTokens`, `mode`, `cachePercent`, `bg{active,spawned}`, `pendingPermission`, `planBoard`, `sessionId`. **Never contains the history** (streaming safety: an assistant delta must not reship O(history)). ω99-235: when the host mounts the pet lane, the frame gains the OPTIONAL `pet` field — the sprite's own driver snapshot (the same DriverStatus mirror over the SECOND session; each lane's subscription pushes one frame with BOTH statuses re-read at push time). Absent on servers without a pet lane — old clients ignore it, the pet relay degrades to the main lane. M85-pet §2: the `pet` snapshot additionally carries the OPTIONAL `workspaceName`/`workspacePath` pair (basename + full path of the sprite's OWN agent root, from the lane driver's `agentRootStatus`; the toolbar's workspace chip renders the same-source truth the StatusBar does). Re-read at frame-build time (a pet-carrying frame builds through a serialized chain so emit order reaches the wire intact and the auth state→history order never flips); a failed/slow read (1.5s cap) degrades to the base snapshot — the status channel is never blocked. Absent when the lane driver lacks the face (old driver) — the chip degrades. ω99-253: #8 — the snapshot additionally carries the OPTIONAL `gitBranch` (`string \| null`) — the agent root's git branch (the status strip's branch chip; `"HEAD"` = detached, verbatim). Cached driver-side (read at boot / run settle / agent-root switch — never per frame); null or absent (old server, non-repo, read failure) renders nothing client-side. ω99-255: #4 — the snapshot additionally carries the OPTIONAL `sessionName` (`string \| null`) — the session's current name (the auto-title / /rename landing); a CHANGE across frames is the web sidebar's refresh signal (it re-reads the store's rows; the field is never the display source). Absent (old server) or null = no signal, quiet. ω99-268: #7 — the snapshot additionally carries the OPTIONAL `memorySignature` (`string`) — the memory store's content signature `count:pending:maxVersion` (its monotonic quantities over one `load()`; the `pending` term is load-bearing: a confirm flips status only, moving neither count nor maxVersion). A CHANGE across frames is the web 管理记忆 panel's and boot 待审卡's refetch signal — the list data itself still rides the `memoryList` op (the field is never the display source). Cached driver-side (read at boot / run settle / after each memory op lands — never per frame; between settles another window's write is an honest snapshot window). Absent (old server / no workspace / boot read not yet landed) = no signal, quiet — fetch-on-open bytes. ω99-318: the parked `pendingPermission` additionally carries the OPTIONAL `spoof` field (`{text:[{key,issues:[{codepoint,nameZh,position,category}],more}],urls:[{key,original,normalizedUrl,warnings}]}`) — the Unicode visual-spoofing inspection (zero-width / BiDi codepoint badges + homoglyph URL true-targets) computed at the driver's ask seam from core's single codepoint tables. 源检验、边渲染: the server relays it verbatim (transport-only, additive field auto-passes `stripSecrets` — no secret-named keys); reveal-not-block — presence changes only what the approval card renders, never the answer ops. Absent on clean input and old drivers: the card renders exactly as before. No new op (census unchanged). 多 driver 弧 B: the frame additionally carries the OPTIONAL `lanes` — `{"<sid>":{…},…}` — every mounted SIDE lane's driver snapshot, keyed by session id, re-read at push time (the ω99-235 dual-read discipline generalized to N lanes; any lane's emit ships all lanes' fresh state). Present ONLY while at least one side lane is mounted — a lane mounting/unmounting pushes a frame so the field's growth/shrinkage is observable on the wire; hosts that mount none ship the byte-identical old shape, old clients ignore the field. See Lanes. |

| history | `{"t":"history","entries":[…]}` | entries appended since the last frame (each `HistoryEntry` lands exactly once — append-only). M79b: `user` entries carry their turn's images as the OPTIONAL `images` field — the same `{kind:"image", ref:{attachmentId, mediaType, byteLength}}` blocks the submit envelope took (durable refs, never bytes; resolve through `attachmentGet`). 0.3.15: `assistant` entries carry the OPTIONAL `durationMs` (the reply's own model call, provider-measured) and each settled run's LAST entry is a `notice` whose text is the run receipt `耗时 … · 模型 … · 工具 … (n 次)` — relay is transport-only, both ride the entries verbatim. 多 driver 弧 B: the OPTIONAL `sid` (`string`) names a SIDE lane's transcript — side-lane frames (this append form and the reset form alike) carry the lane's session id; MAIN-lane frames never do. The pet lane pushes no history frames (its transcript rides the `petHistory` op). See Lanes. |
| history | `{"t":"history","entries":[…],"reset":true}` | whole-history replacement: the initial replay after auth, `/clear`, and a session load. Replace, do not append. 多 driver 弧 B: a side lane's reset replay carries `sid` — after the main lane's initial replay, every mounted side lane follows with one `{t:"history", entries, reset:true, sid}` frame (same on reconnect). |
| event | `{"t":"event","at":<epoch ms>,"event":{…}}` | every raw loop `LoopEvent` (debug/tools), in order, before it is mapped to state. `at` (137, supervisor lane) = the relay tick's epoch ms — the raw `LoopEvent` carries no timestamp of its own, so timeline consumers read `at`. |
| probe | `{"t":"probe","event":{…}}` | PB-2（探针基础设施弧）: one `ProbeEvent` (`{ts, cat:"model"\|"tool"\|"ui"\|"system"\|"agent", name, sessionId?, lane?, data, dur?}`), verbatim, for EVERY event the mounted probe bus emits that matches the client's active `probeStream` filter. Rides the SAME single authenticated connection as every other frame (UI 主车道消费——单连接车道寻址先例，no second WS). Absent unless the client subscribed AND the host mounted a bus (`probeBus` OPTIONAL like `petDriver`) — 缺省零帧，字节形状不变. |
| result | `{"t":"result","id":<id>,"ok":<value>,"err":"…"}` | exactly one per `op` (correlate on `id`; `err` present iff the op failed). |

## Upstream (client → server)

The op envelope carries an OPTIONAL client-instance qualifier:
`{"t":"op","id":<id>,"cid":"<per-client-instance string>","op":{…}}`. ω-3a: a
MUTATION op that carries a valid `cid` (1–128 chars) is served through the
**idempotency vault**, keyed by `cid` + the envelope `id` (the numeric ids
restart at 1 on every page load, so the qualifier keeps a reloaded page from
joining the previous page's ops):

- a retry with the same id and the same canonical-payload digest (sha256 over
  sorted-keys compact JSON of the op object) **joins** the in-flight
  execution — one execution, every requester gets its outcome;
- after completion the outcome is replayed from a TTL result cache
  (5 min, max 256 completed entries, oldest pruned) — a reconnect+retry gets
  the finished result instead of a second execution;
- the same id with a DIFFERENT payload digest → result `err`
  `"conflict: op id <id> was already used for a different mutation"` (the
  wudao analog of nanobot's HTTP 409 — same result frame, `err` present);
- vaulted ops: `submit`, `interrupt`, `setMode`, `answerPermission`,
  `resume`, `rewind`, `edit`, `switch` (with `n`), `settingsSaveKey`, `settingsSet`,
  `settingsSaveProvider` (provider management §5 — a registry write is a side
  effect that must replay exactly once), `recentWorkspaces` (with `add`),
  `switchWorkspace`, `panelRootSet`,
  `agentRootSwitch`, `attachmentSave`, `fileSave` (ω99-55 — the file lane's
  save writes content-addressed objects, replayed exactly once; a re-uploaded
  duplicate is a dedup no-op anyway), the plugin mutations
  (`pluginMarketAdd/Update/Remove`, `pluginInstall/Uninstall/Enable/Disable`),
  and the persona mutations (`personaSave`, `personaDelete` — persona-settings
  T5; delete converges on replay), and the pet lane's seven mutation ops
  (`petSubmit`, `petInterrupt`, `petAnswerPermission` — ω99-235; mutations of
  the SECOND driver session, vaulted like their main-lane twins so a mid-flap
  replay never double-submits into the sprite's lane; the lane's read
  `petHistory` stays out — ω99-271, a vaulted read would serve
  the pet window a stale transcript; M85-pet §2 adds the toolbar's four —
  `petNewSession` (the archive rename is a disk side effect a mid-flap
  replay must not double-run), `petSetModel`/`petSetEffort` (the lane's own
  driver-state writes, the setMode family), and `petSetWorkspace` (the
  already-vaulted `agentRootSwitch`'s mirror)), and the memory
  decision (`memoryDecide` — ω99-260; ok/del converge on replay, a replayed
  second ok answers `ok:false`), and the memory rewrite (`memoryEdit` —
  ω99-264; the driver short-circuits a content-equal replay, so a mid-flap
  replay converges with version exactly +1), and the file-level time
  machine's restore (`fileRevert` — ω99-314; a working-face side effect that
  overwrites a workspace file, so a mid-flap replay joins the original
  execution instead of double-reverting), and the schedules management
  writes (`schedulesSetEnabled`, `schedulesRunNow` — ω99-317; the former is
  a state write (the settingsSet shape), the latter re-runs a task so a
  mid-flap replay would double-run — both vaulted for exactly-once. The lane's
  delete `schedulesRemove` converges on replay (an absent task is the goal
  state) and stays UN-vaulted, the sessionDelete precedent), and the
  mid-flight tool detach (`detachToolCall` — 借鉴弧 δ, penguin-harness
  367ab084 思想; a driver-state mutation whose refusals converge on replay
  (the call is no longer in flight → `not_in_flight`), vaulted so a
  mid-flap replay re-serves the original verdict instead of detaching a
  MOVED busy row).
  Reads are NEVER vaulted (a TTL-cached read would serve stale data), and
  ops without a `cid` (old clients) keep the pre-ω-3a execute-every-frame
  behavior. The vault is in-memory: a server restart forgets it, and the
  client's replay simply re-executes.

The web client (`packages/web/src/protocol.ts`) mints one `cid` per
`WudaoClient` instance, rides it on every op frame, and on reconnect re-sends
its in-flight MUTATIONS under their original ids (reads still fail on the
drop — the panels re-fetch).

| op | shape | result `ok` |
| --- | --- | --- |
| submit | `{"t":"op","id":1,"op":{"op":"submit","text":"…","plan":false,"expand":true,"images":[…]?}}` | the outcome word: `"started" \| "steered" \| "notice" \| "noop" \| "cleared" \| "frontend"` — M79 §4: the OPTIONAL `images` field (protocol v1 increment; omitting it is the pre-M79 behavior) is an array of `{kind:"image", ref:{attachmentId, mediaType, byteLength}}` blocks whose refs `attachmentSave` minted; they ride the user turn as durable refs (never image bytes). M80: `"cleared"` = the driver executed `/clear` itself (state wiped, session id rotated to a fresh segment, the empty `reset:true` history frame already sent) — the client renders nothing, the reset frame owns the view. ω99-242: a VALID submit also fires the mounted recovery coordinator's manual-input seam (`noteUserInput`, BEFORE the engine sees it) — the user's takeover cancels that session's pending recovery; permission replies ride `answerPermission` and deliberately never cancel anything (a reply may unlock a tracked blocked turn). No coordinator mounted → no call, byte-identical legacy behavior. |
| interrupt | `{"op":"interrupt"}` | `true` |
| setMode | `{"op":"setMode","mode":"auto"}` | `true` (mode must be in the host's configured set — under `wudao ui`: `workspace, ask, auto, plan`; 0.3.12 renamed the trio and 0.3.14 added plan) |
| answerPermission | `{"op":"answerPermission","allow":true,"reason":"…","scope":"session"\|"always"?}` | `boolean` — `false` when nothing is parked. 0.3.14: the OPTIONAL `scope` upgrades the yes beyond this-once: `"session"` = the a/all lane (the rule joins the session allowlist), `"always"` = the p lane (additionally persisted as a project-tier `permissions.allow` rule via the same guarded path the permissions command rides). Absent = allow-once (y). |
| recallSteer | `{"op":"recallSteer","index":0,"text":"…"}` | `boolean` — 借鉴弧 α2（CC 2.1.269 思想）: recall ONE still-queued steering message before the loop drains it. CAS semantics: the pair must come from the SAME state frame's `queued` array (`queued[index] === text` at click time); an entry already consumed (mid-run drain, or started as the settle follow-up run) → `false`. User lane only — the system/cron/peer lanes are never recallable. Vaulted (a mid-flap replay re-serves the original reply instead of re-executing against a moved queue). |
| answerAskUser | `{"op":"answerAskUser","answer":"用方案 B"}` | `boolean` — 借鉴弧 α1（Codex 0.154 思想）: answer the parked ask_user clarification card (the state frame's `pendingAskUser`: question + option chips + free text). `answer` = the user's pick/input verbatim (the tool result, the ask_user contract); absent/empty = dismiss → the tool's error result tells the model to decide itself and continue (the run never broke). `false` when nothing is parked. Vaulted like recallSteer. |
| detachToolCall | `{"op":"detachToolCall","callId":"c1"}` （`callId` 可缺省=第一个可转的在飞行） | `{kind:"ok",callId,toolName}` \| `{kind:"refused",reason:"not_detachable"\|"not_in_flight",toolName?}` — 借鉴弧 δ（penguin-harness 367ab084 思想）: move ONE in-flight tool call to the background. The call's result stops blocking the turn; the run closes at the turn boundary (`Terminal.backgrounded` — the conversation comes back); the landed result merges later through the background lane (a steering-lane user message, the monitor seam's sibling). `callId` comes from the status frame's `busyTools` rows. Typed refusals: `not_detachable` (the `interruptBehavior:"block"` family — cancellation itself is the hazard), `not_in_flight` (no busy row matches / nothing detachable). The verdict is optimistic by necessity (the call may finish naturally between frame and click — the next frame is the truth). An explicit user stop (Esc/`interrupt`) stops background tasks with the run (用户意图优先). Vaulted like recallSteer. |
| petSubmit | `{"op":"petSubmit","text":"…"}` | the pet lane's submit: the outcome word of the SPRITE's own driver session (text-only v1 — no images/files/plan on this lane). Err `pet ops not supported by this driver` when the host mounted no pet lane (the lane lock was held or `petLane` off) — the web relay then degrades to the main `submit` lane. ω99-235. |
| petInterrupt | `{"op":"petInterrupt"}` | `true` — interrupts the pet lane's run (never the main run). ω99-235. |
| petAnswerPermission | `{"op":"petAnswerPermission","allow":true,"reason":"…","scope":"session"\|"always"?}` | `boolean` — answers the PET lane's parked permission card (the sprite window's own ask; the main modal keeps `answerPermission`). Same shape contract as the main twin. ω99-235. |
| petHistory | `{"op":"petHistory"}` | `[{q,a},…]` — the PET lane's paired session history (pet.jsonl, paired server-side: `q` = the user line, `a` = the round's joined non-empty assistant texts, the run's error text when it never answered; capped 50 turns / 8000 chars per turn with an explicit mid-omit marker — truncation is never silent). A READ (never vaulted — ω99-271). Err `pet ops not supported by this driver` when no pet lane is mounted; the pet window then keeps its local transcript. |
| petNewSession | `{"op":"petNewSession"}` | `string \| null` — M85-pet §2: 归档活 pet 会话（rename 原子迁史为 `pet-<YYYYMMDD-HHMMSS>.jsonl` + session_name 条目）并空史重开（车道 id 恒回钉 `"pet"`）；`null` = 零轮次空会话跳过归档。服务端稳定化（Task 2 遗留收口）: 运行中 → 先 interrupt 等其状态离开 busy 再轮换（10s 上限，超时仍执行——新会话点击是明确意图）。Vaulted（归档落盘副作用，mid-flap 重放恰好一次）。缺面老驱动/无 petDriver → err `pet ops not supported by this driver`（宠物窗新会话按钮降级）。 |
| petSetModel | `{"op":"petSetModel","provider":"glm","model":"…"?,"effort":"high"?}` | `true` — M85-pet §2: 精灵工具栏的模型 chip（provider 必给=选择器主键；model/effort 可选叠加），落 pet 车道自己的 liveConfig——与主窗互不牵动（车道隔离）。回执恒 `true`：坏档/坏 provider 落会话内 notice 不抛错（诚实面在史里）。Vaulted（pet 车道 driver 状态写，setMode 同族）。Shape gates: provider 非空 string、model/effort 在场时必须 string。缺面 → `pet ops not supported by this driver`。 |
| petSetEffort | `{"op":"petSetEffort","effort":"high"}` | `true` — M85-pet §2: 思考深度 chip（configureModel 的 effort 单档窄缝，`/effort` 同源落点），仅作用 pet 车道。Vaulted 同 petSetModel。Shape gates: effort 非空 string。缺面 → `pet ops not supported by this driver`。 |
| petSetWorkspace | `{"op":"petSetWorkspace","path":"/w/空间"}` | `{applied,queued}`（主车道 `agentRootSwitch` 同形）— M85-pet §2: 工作区 chip 的切换，主车道 agentRootSwitch 的镜像（idle 即切 / busy 停泊到运行收束，v1 不发明新语义；存在性/目录校验在 driver 侧）。切的是精灵自己的 agent root（pet 车道私有 agentRootBox，锚 boot 工作区）；recent 列表与主窗共享。Vaulted（agentRootSwitch 已 vault 的主车道孪生）。Shape gates: path 非空 string。缺面 → `pet ops not supported by this driver`。 |
| listSlashCommands | `{"op":"listSlashCommands"}` | the command list (name/description/args/source) |
| sessions | `{"op":"sessions"}` | recent session rows (the `/resume` picker's data). ω99-235: the row whose `id` is the fixed `"pet"` carries `lane:"pet"` (the main window's 小精灵 badge; its click must NOT resume — the lane is live in the sprite window) |
| sessionSearch | `{"op":"sessionSearch","q":"关键词"}` | ω99-277: #10 — `[{sessionId, name, firstUser, mtime, kind:"user"\|"assistant", snippet}, …]` — full-text search over every session's visible user/assistant text (the 切换会话 picker's search box). A READ, never vaulted (a replay re-scans; the same session set and worktree filter as `sessions`, newest sessions first, per-session cap 5 / total cap 50). `snippet` is the ±30-char context around the match ("…" marks a clipped side). Empty/blank `q` → `[]`; a non-string `q` refuses before the driver. Optional on the driver — absent → err `"sessionSearch not supported by this driver"` |
| sessionDelete | `{"op":"sessionDelete","id":"<sessionId>"}` | ω99-279: #10 — `{deleted:true}` \| `{deleted:false, reason:"invalid-id"\|"not-found"\|"active"}` — 回收站式删除: the session file moves (atomic rename) into the sessions dir's `.trash/` subdirectory — recoverable by hand, never rm'd; `sessions`/`sessionSearch` both hide it (the flat `*.jsonl` readdir shape ignores subdirectories). `active` = the live session (this window's current session or a live pet lane) — refused before any disk touch; `side-*.jsonl` child transcripts stay in place. NOT vaulted: delete converges (an absent file is the goal state — the `settingsDeleteProvider` precedent; a mid-flap replay re-executes harmlessly to `not-found`). Shape gates: a non-string `id` refuses before the driver; an invalid id shape (empty / traversal / `side-` prefix) refuses with `invalid-id` before any disk touch. Optional on the driver — absent → err `"sessionDelete not supported by this driver"` |
| sessionTrashList | `{"op":"sessionTrashList"}` | ω99-283: #6 — the trashed sessions' rows (`[{id, mtime, messages, firstUser, model, name?}, …]` — the SAME `SessionRow` shape `sessions` answers, so the picker's row rendering is reused verbatim) — the 切换会话弹框's 回收站 face. Reads the sessions dir's `.trash/` subdirectory (the only reader: `sessions`/`sessionSearch` both flat-readdir the parent and never see it), mtime-desc capped 20. No `.trash` → `[]` (the directory is never created). A READ, never vaulted (a replay re-scans). Optional on the driver — absent → err `"sessionTrashList not supported by this driver"` and the web trash entry hides (old-server degradation) |
| sessionRestore | `{"op":"sessionRestore","id":"<sessionId>"}` | ω99-283（续，标记见上）— `{restored:true}` \| `{restored:false, reason:"invalid-id"\|"not-found"\|"target-exists"}` — 恢复一个已删会话: the file is hardlinked from `.trash/<id>.jsonl` back to `<id>.jsonl`, then the `.trash` copy unlinked (the move's tail — the ONLY unlink; a failure there leaves a safe double copy, never a loss). `link` is the atomic NO-OVERWRITE primitive — `target-exists` (EEXIST) means a live session already owns the id and the restore refuses with the target's bytes untouched (`rename` would silently clobber it — the data-loss red line; `not-found` = the trash copy is gone (already restored). Shape gates: a non-string `id` refuses before the driver; an invalid id shape (empty / traversal / `side-` prefix) refuses with `invalid-id` before any disk touch. NOT vaulted: restore converges like its delete twin (a mid-flap replay lands `target-exists` or `not-found` and touches nothing). Optional on the driver — absent → err `"sessionRestore not supported by this driver"` |
| sessionContinue | `{"op":"sessionContinue","id":"<sessionId>"}` | ω99-286: #7 — `{started:true}` \| `{started:false}` — 断点续跑 (durable runs L1): continue the session's unfinished turn as-is. The driver loads the session through the SAME adoption chain `resume` uses (lease + branch-chain projection + `repairOrphanedToolCalls` — an orphaned tool_use is answered with the UNKNOWN-outcome text, the side effect never vanishes untraceably), refuses `started:false` when the loaded tail is NOT an unfinished shape (settled assistant tail — zero model calls, no idle spin), and otherwise starts the run wrapper WITHOUT appending a user message and WITHOUT the onUserTurn persistence barrier (the historical tail `user`/`tool_result` IS the model input tail — no guiding prompt is injected, so the prefix bytes stay stable; progress honestly rewinds to the turn boundary: that turn's model calls and tools re-run). `false` also covers: unknown id / invalid id shape (SESSION_ID_RE + `side-` prefix refused before any path join) / a run or manual compaction in flight (no double run). Shape gate: a non-string `id` refuses before the driver. NOT vaulted (write-family semantics like `submit`, but the driver's busy/tail gates converge a mid-flap replay to `started:false` — zero double runs; vaulting would only serve a stale receipt). Optional on the driver — absent → err `"sessionContinue not supported by this driver"` and the web continue button stays hidden (old-server degradation; the row's `unfinished` field is equally optional on the wire — readers default it to `false`). ω99-289: #7 — the SAME op also answers the 失败尾一键重试 (286 C①): a session whose tail is the run-error synthetic `"(error: …)"` assistant continues from the failure point — the driver first gates the predecessor shape (must be an interrupted form: `user` after a first-leg failure, `tool_result` after a tool round; a settled predecessor is a defensive refuse with zero state mutation), then pops the synthetic error IN MEMORY (the JSONL is append-only and untouched — the error entry stays on its old branch; the retry turn's first new message chains `parentUuid` at the failure-point predecessor, so a later resume walks the newest chain) and starts the same `continueRun` wrapper. The sessions row's `errored` field (the failure-tail derivation, `isErrorTail` — mutually exclusive with `unfinished`) is equally optional on the wire — readers default it to `false` |
| schedulesList | `{"op":"schedulesList"}` | ω99-313 — `[{id, kind:"task"\|"reminder", prompt, trigger, nextRunAt, enabled, paused, sessionId?}, …]` — 定时任务与提醒的读面 (durable schedules): a pure read of the workspace's `.wudao/schedules.json` store (the same source the daemon and `/schedule list` read). `trigger` is the human calendar text (「每周一、周三 09:00」 — never a cron string); `nextRunAt` is epoch ms or `null`; the sidebar joins `sessionId` to mark rows carrying a bound schedule (⏰). A refused store (kill switch / symlink) answers `[]` — the face hides, never breaks. A READ, never vaulted. Optional on the driver — absent → err `"schedulesList not supported by this driver"`. ω99-317 — the row gained three ADDITIVE health fields: `lastFiredAt` (epoch ms or `null` — a busy-skip counts, health visibility), `consecutiveFailures` (the breaker count; the spawn lane only), and `lastRun` (`{ok, at}` joined from the `schedules` session log's last `schedule_run` entry, or `null` — the reminder lane never logs); readers default all three (`null`/`0`/`null`). ω99-321 — `lastRun` gained an ADDITIVE `mode?` field (`"continue"` \| `"skipped"`; the spawn lane logs none — legacy rows stay keyless): a busy-skip now lands a `schedule_run` entry (`ok:true` = the「不失败」placeholder, NOT 跑成了) so「昨晚为什么没跑」is answerable across restarts; readers must judge `mode` BEFORE `ok` (the web renders 会话忙，跳过了) |
| schedulesSetEnabled | `{"op":"schedulesSetEnabled","id":"<taskId>","enabled":false}` | ω99-317 — `{ok, message}` — 暂停/恢复一条定时任务: routes the host daemon's pause/unpause (`enabled:false` = pause — 错过的触发不补跑; `true` = resume, which also re-opens a breaker-disabled task, the 313 semantics untouched). `message` is the daemon's Chinese receipt relayed verbatim; `ok` is `false` iff it starts with `⚠️`. Shape gates: a non-empty `id` string + a boolean `enabled`, refused before the driver. VAULTED (a state write — the settingsSet shape). Optional on the driver — absent → err `"schedulesSetEnabled not supported by this driver"` and the web action surfaces the error receipt (old-server degradation — buttons stay, the op result notifies) |
| schedulesRemove | `{"op":"schedulesRemove","id":"<taskId>"}` | ω99-317 — `{ok, message}` — 删除一条定时任务: removes the `.wudao/schedules.json` entry ONLY (internal scheduling state — a user file is NEVER touched). Converging delete: a mid-flap replay lands the not-found receipt and touches nothing. Shape gate: a non-empty `id` string. NOT vaulted (the sessionDelete/settingsDeleteProvider precedent). Optional on the driver — absent → err `"schedulesRemove not supported by this driver"` |
| schedulesRunNow | `{"op":"schedulesRunNow","id":"<taskId>","resetBreaker":true?}` | ω99-317 — `{ok, message}` — 立即试跑一条定时任务 (手动运行——计划不变): the daemon refuses a bound task whose session is busy (the 313 cron-fire skip semantics brought to the manual lane — `ok:false`, message says 会话正在跑) and refuses an in-flight run. The OPTIONAL `resetBreaker:true` is the breaker's manual re-open: on a breaker-disabled task it clears the consecutive-failure count, re-enables, THEN fires (「连败 N 次已熔断，仍要试跑？」的复位口); on a healthy task the flag mutates nothing. Shape gates: a non-empty `id` string, and `resetBreaker` (when present) a boolean. VAULTED (a mid-flap replay would double-run). Optional on the driver — absent → err `"schedulesRunNow not supported by this driver"` |
| resume | `{"op":"resume","id":"<sessionId>"}` | ω99-225: `{ok:true}` \| `{ok:false,reason:"not_found"}` \| `{ok:false,reason:"occupied",holderPid:<number>}` — the refusal says WHICH it is (a live lease holder vs an unknown id; the old bare `false` conflated them and the UI had to guess) |
| rewind | `{"op":"rewind","target":2}` (`number \| "last" \| "list"`) | the notice/summary text |
| edit | `{"op":"edit","n":3}` | the original text (`null` when out of range/busy). ω99-258: #6 — `n:0` is the DISARM form (the web armed-banner's cancel) — replies `true`, idempotent, next plain submit stays on the mainline |
| tree | `{"op":"tree"}` | the ASCII branch topology |
| switch | `{"op":"switch","n":2}` (`n` absent = list) | the notice text |
| branchLeaves | `{"op":"branchLeaves"}` | ω99-258: the structured branch leaf table — `[{n, leafKey, forkPreview, messageCount, isCurrent}, …]` (tree()'s data twin for the web branch panel; read, never vaulted; a `/rewind turn` window reports every leaf `isCurrent:false`). Optional on the driver — absent → err `"branchLeaves not supported by this driver"` and the web chip hides (old-server degradation) |
| memoryList | `{"op":"memoryList"}` | ω99-260: #13 — the full memory ledger — `{entries:[{id, kind, content, scope, tags, created, hits, status, surfaced?, seq?, version?}, …]}` (the physical store's load() in file order, active + pending; the web 待审卡/管理面's data). Read, never vaulted. Optional on the driver — absent → err `"memoryList not supported by this driver"` and both web faces hide (old-server degradation) |
| memoryDecide | `{"op":"memoryDecide","id":"m-…","action":"ok"\|"del"}` | ω99-260: decide one pending memory — `ok` confirms (pending→active), `del` removes the line; reply `{ok, message}` (`已确认一条记忆` / `已删除一条记忆` / `没有这条待审记忆（可能已处理过）`). store.confirm/remove are the single source (/memory ok\|del twins). VAULTED (ok/del converge on replay — a second ok answers `ok:false`). Shape gates: non-empty `id` string + the `ok`\|`del` enum, refused before the driver is reached. Optional on the driver — absent → err `"memoryDecide not supported by this driver"` |
| memoryEdit | `{"op":"memoryEdit","id":"m-…","content":"改后的内容"}` | ω99-264: #3 — rewrite one memory entry's content — status-preserving (`store.update` version+1, then a CONDITIONAL `store.confirm`: an ACTIVE entry returns to active — the user's own 改写 press is the authorization chain's end, never re-walks the LLM review door; a PENDING entry stays pending — the edit never decides for the user). tags/hits ride verbatim. Reply `{ok, message}` (`已改写一条记忆` / `已改写一条记忆（仍待你确认）` / `没有这条记忆（可能已处理过）`). VAULTED — and the replay convergence is the DRIVER's content-equal short-circuit (a bare update is NOT idempotent, v+1 per call; the driver answers ok with ZERO writes when the stored content already byte-equals the request, so a mid-flap replay lands with version 恰 +1). Shape gates: non-empty `id` string + non-empty `content` string (改写不得成空记忆 — empty and whitespace-only both refuse), refused before the driver is reached. Optional on the driver — absent → err `"memoryEdit not supported by this driver"` |
| improvementFace | `{"op":"improvementFace","action":"list"}` / `{"op":"improvementFace","action":"consent"\|"ignore"\|"activate"\|"reject"\|"undo","id":"p1-a1b2c3d4"}` | 永续 v6 wave2 (reef C1): the gated self-improvement face. `list` replies `{ok, message:"", records:[{id, fingerprint, subject, stage, count, streak, status, attempts, problemSummary?, ruleText?, scope?, paths?, gate?, ruleFile?, lastError?, preview?, createdAt, decidedAt?}, …]}` (`.wudao/proposals/` records — the 设置→偏好→改进提案 cards' data). The five decisions are the TWO human gates + their bookkeeping: `consent` = 第一道 (spawns the detached proposer child, then the paired-replay gate — notices ride history), `ignore` = dismiss the trigger, `activate` = 第二道 (writes `.wudao/rules/auto-<id>.md`, next session), `reject` = archive (same failure mode never re-proposes), `undo` = delete the activated rule file (byte-matched — hand-edited files are never deleted). Reply `{ok, message}`; decisions converge on replay (a replayed second decide answers `ok:false` MISS). VAULTED except `list` (consent spawns a child + model call; activate writes a file — exactly-once). Shape gates: the action enum + non-empty `id` on decisions, refused before the driver is reached. Optional on the driver — absent → err `"improvementFace not supported by this driver"` and the web section hides |
| settingsStatus | `{"op":"settingsStatus"}` | M63 §B: provider matrix + credentials COUNT + settings values — never key material. Provider management §5: each card adds `baseUrl?` (the registered/compiled URL — `endpoint` stays the resolved one), `custom` (user-registered vs compiled-in), `models:[{name, contextLength?}]`, `defaultContextLength?`, and `invalidReason?` (a registry row that refused to load rides as a grayed minimal id+reason card). persona-settings T5/T7: each card also carries `persona?` (the registry row's THREE-STATE binding column: a string = bound id, `null` = forced none, ABSENT = follow the global default — the edit form's echo source; the row's save REPLACES the card wholesale, so the form must send the binding back). M63 §C: also `readiness` (any provider ready = ready — the first-run wizard's gate) and `settings.wizardCompletedVersion` (the versioned welcome notice). persona-settings T5: `settings.personaId` (the global default persona id — the persona tab picker's current value; `null` = never written / cleared) |
| settingsSaveKey | `{"op":"settingsSaveKey","provider":"deepseek","key":"…"}` | M63 §B: `{provider, saved, keyCount}` — the key is written server-side and NEVER returned; the server strips any stray secret field from the reply |
| settingsTestConnection | `{"op":"settingsTestConnection","provider":"glm","key":"…?","model":"…?"}` | M63 §B: `{ok, state, message}` — one minimal request; `state`: `ok \| auth \| network \| model \| no-key \| no-endpoint \| http` |
| settingsSet | `{"op":"settingsSet","key":"ui.defaultMode","value":"simple"}` | M63 §B: `{key, saved}` — allowlisted keys only (the 8 writable personal preferences: `ui.defaultMode`, `ui.theme`, `ui.accent`, `memoryEnabled`, `model.defaultModel` `{provider, model}`, `model.defaultEffort`, `wizard.completedVersion` — non-negative integer, and `persona.id` — persona-settings T5: a registry-EXISTING persona id, or `""` to clear; cli's settings-ops `settingsSet` owns the list) |
| settingsSaveProvider | `{"op":"settingsSaveProvider","id":"my-gw","config":{"baseUrl":"https://gw.example.com/v1", …}}` | provider management §5: `{ok:true, provider}` \| `{ok:false, error}` — register/update one provider in the machine registry (`~/.wudao/providers.json`): a custom (id must match the credentials `ID_RE` charset; a custom NEEDS a baseUrl) or a builtin overlay (field-by-field, the compiled profile stays the base). `config` is REGISTRY config only (`label`/`baseUrl`/`defaultModel`/`reasoningFormat`/`windowMode`/`defaultContextLength`/`models`/… — server shape-gates `id` string + `config` object, the cli handler re-validates via the registry validator and refuses with its reason). persona-settings T5: `config.persona` is the card's THREE-STATE binding (`string` = bound to that persona id; `null` = forced none — the global default never applies; ABSENT = follow the global default) — the save REPLACES the row wholesale, so an edit form that drops the key clears the binding (the web form's full-payload discipline). API keys NEVER ride `config` (a key-bearing config refuses; `settingsSaveKey` owns keys) and the atomic write never touches sibling rows — including invalid ones. A successful write invalidates the cli process's registry memo, so the SAME session's next `settingsStatus` sees it (no restart). |
| settingsDeleteProvider | `{"op":"settingsDeleteProvider","id":"my-gw"}` | provider management §5: `{ok:true}` \| `{ok:false, error}` — remove one registry entry. BUILTIN ids refuse with `内置 provider 不可删除`; deleting a custom also drops a stored `model.defaultModel` that pointed at the id (the boot's default resolution owns the default again — unrelated picks untouched). NOT vaulted: delete converges (an already-absent row is the goal state), so a mid-flap replay re-executes harmlessly. |
| settingsListModels | `{"op":"settingsListModels","provider":"glm","key":"…?"}` | provider management §5: `{ok:true, models:[{name, contextLength?}]}` \| `{ok:false, state, message}` — a PROBE (`GET ${endpoint}/models`, `Authorization: Bearer`, 10s abort, via the settings-ops fetch seam — the providers ModelClient gains no GET capability). `key` optional (a pasted key wins; absent → the testConnection ladder: env pool for the SELECTED provider, else the credentials file); `state` reuses the testConnection machine (`ok`/`auth`/`network`/`model`/`no-key`/`no-endpoint`/`http` — a non-array `data` reads as `http`). Parses the OpenAI shape (`data:[{id}]`) and prefills `contextLength` from each row's `context_length` when it is a positive integer (the OpenRouter/models.dev shape). The request key NEVER echoes back. |
| recentWorkspaces | `{"op":"recentWorkspaces","add":"/abs/path"?}` | M75-ux1 §2: `{workspaces:[{path, lastUsed}]}` — the workspace switcher's recents, max 5, most-recent-first (`lastUsed` ISO). Read when `add` is absent; with `add` the path is unshifted (deduped by path, trimmed to 5) into `<WUDAO_GLOBAL_HOME>/recent-workspaces.json` first. No separate write op — the switch click adds through this same handler. |
| fileTree | `{"op":"fileTree","path":""}` | M74-ide §1: `{entries:[{name, type:"file"\|"dir", size?, hidden?}]}` — ONE directory level (`path` = workspace-relative dir, `""` = root), sorted dirs-first alphabetically then files alphabetically (code-unit order). `size` (bytes) is files-only. `hidden:true` marks dotfiles and the hidden list (`.git`, `node_modules`, `.DS_Store`, `__pycache__`, `.env*`, `dist`, `target`) — the SERVER only marks, the CLIENT filters. Errors: `"path escapes workspace: …"`, `"no such directory: …"`, `"not a directory: …"`; a sensitive directory itself (`.git`, `.ssh`, `.env*`, `credentials*`) answers `{entries:[]}` |
| fileRead | `{"op":"fileRead","path":"src/index.ts"}` | M74-ide §1: `{content, truncated, totalBytes, lines, language, binary?}` — UTF-8 text; `lines` counts the WHOLE file (pre-truncation); `language` from the extension (`typescript`/`tsx`/`javascript`/`jsx`/`python`/`markdown`/`json`/`yaml`/`css`/`html`/`shell`/`rust`/`go`/`java`/`c`/`cpp`/`ruby`/`php`/`sql`/`toml`/`xml`, else `"text"`). Over 1MB → `truncated:true` + only the first 100KB in `content`. Binary (a NUL in the first 100 bytes OR extension `.png .jpg .gif .pdf .woff .ico .exe .bin .zip .tar .gz`) → `binary:true`, `content:""`, `lines:0`. Errors: `"sensitive path"` (anything inside `.git`/`.ssh`, or a `.env*`/`credentials*` basename at any depth — checked BEFORE existence, so probes leak nothing), `"path escapes workspace: …"`, `"no such file: …"`, `"not a file: …"` |
| fileWrite | `{"op":"fileWrite","path":"src/index.ts","content":"…","base":"…"}` | 高亮/编辑 spec §3: the viewer's save — user-hand edit, no permission pipeline. `base` is the optimistic lock (CAS): the driver re-reads immediately before writing; disk ≠ base → `{conflict:true, current}` (current = first 100KB byte-prefix, nothing written); equal — or ENOENT with base `""` (create) — → atomic same-dir tmp+rename, `{written:true}`. Read-side guards run BEFORE the compare: escape, sensitive (`.git`/`.ssh` segments, `.env*`/`credentials*` basename prefix, checked before existence), content over 1MB rejected. Optional on the driver (absent → err `"file ops not supported by this driver"`); non-string params → `"fileWrite needs path, content and base strings"` |
| ctxInfo | `{"op":"ctxInfo"}` | M76-ux2 §8: `{systemTokens, toolsTokens, messagesTokens, imagesTokens?, availableTokens} — imagesTokens is present only when image refs ride the history (R5-I1; old servers omit it)` — the StatusBar ctx hover's breakdown. The driver computes the per-section estimates (~chars/4, same accounting as the ctx watermark) over LIVE state (system prompt / serialized tool schemas / message content), `availableTokens = contextWindow − combined estimate` (clamped at 0). An estimate of what the NEXT model call would serialize — read-only, never rides the permission pipeline. |
| sessionAnatomy | `{"op":"sessionAnatomy"}` | 140（监控要看全）: `{systemPrompt, messages[]}` — the session's FULL persisted anatomy: the system prompt text + the message chain verbatim (user prompts, assistant content AND reasoning, tool calls with arguments, tool results with isError). Read-only, optional driver method (absent → err "session anatomy not supported by this driver"); the payload can be large — loopback single-user, the panel truncates render-side. |
| fileRevert | `{"op":"fileRevert","path":"src/a.ts","sha":"<64-hex>"}` | ω99-314: `{ok:true, stale:boolean, message}` \| `{ok:false, reason:"busy"\|"evicted"\|"bad-path"\|"no-store", message}` — 文件级时光机（改动面板「恢复到这里」的引擎）：把指定文件恢复到指定快照的内容。守卫序：活跃回合 busy 拒（「任务正在跑，等它停下来再恢复」）；形状/containment 拒（bad-path）；快照 blob 缺席（LRU 淘汰/删仓）typed 拒（「快照已被清理，无法恢复」，文件一字节未动）；当前内容 ≠ 索引最新 afterSha（用户手改过/被删）→ 不拒、`stale:true` 回执明示；恢复前先把当前内容再存一份快照（恢复本身可撤销）。写入 tmp+rename 原子写；readState 随恢复刷新。VAULTED（写面 side effect，mid-flap 重放 join 原执行）。Shape gates：非空 path string + 64 位小写 hex sha，拒在 driver 之前。Optional on the driver — absent → err `"fileRevert not supported by this driver"`（老 server 降级=面板恢复钮隐藏） |
| recap | `{"op":"recap","sessionId":"…","sinceMark":12,"sinceTs":1690000000000?}` | ω99-213: `{stats:{turns, toolCalls, filesTouched, sinceTs}, narrative?}` — the away recap: what landed in the session since the viewer's mark. `sinceMark` is an index into the history channel (the client mirrors the driver's history 1:1 — count wire entries, never merged local notes); `sinceTs` echoes back verbatim in `stats.sinceTs` (null when absent) so the card can render the away span. `stats` is COUNTED from structured history (never model-made); `narrative` (three labeled sections 完成了/还在进行/等你决定, ≤400 code points) comes from one tiny background model call through the title seam (`querySource:"recap"`, zero shared prefix bytes) and is ABSENT on any failure — the degraded stats-only card is the honest fallback. `ok:undefined` is a legitimate "no recap" (session mismatch / below the ≥3-new-messages gate / nothing assistant-shaped), distinct from an err string. Read-only bypass: no history/session writes, runnable mid-run; the client gates its own calls (≥10min away AND ≥3 new messages, per-viewer lastSeen in localStorage, (sessionId, mark) memoization). |
| sideQuestion | `{"op":"sideQuestion","sessionId":"…","text":"…"}` | ω99-316: `{answer:"…", rounds:n}` — the /btw 侧问: ask the session's side lane a question WITHOUT interrupting the main run. The driver clones the request-time projection into a detached loop (frozen tool table declared byte-identical to the main run's — prefix cache shared; execute returns a structured frozen error), `maxTurns=3`, `<side_question>` envelope, the session's reasoning effort rides through. Mid-run snapshots are sanitized (half-messages never ride). The answer is the side lane's ONLY observable effect: never a state message, never session JSONL/store (M24 — a replay just re-asks, never vaulted). `rounds` is the model-call count actually spent; a cap-exhausted answer carries the honest footnote 「（旁路回答轮数用尽，可能不完整）」. Session mismatch / empty text → err. |
| recoveryStatus | `{"op":"recoveryStatus"}` | ω99-242: #4 `[{sessionId, state:"blocked"\|"active"\|"recovering"\|"unfinished"\|"terminal"\|"tracked", verifiedDone?, remaining?}]` — the crash-recovery coordinator's per-session rows (the web renders 「已验证完成 X / 待续 Y」 off the CURRENT session's row; X is the receipt-verified completed count, Y the remaining mission-task count — counted server-side from the journal's settle records, never fabricated client-side). ω99-248: #11 — a permission-blocked row additionally carries `permissionAsk:{toolName, summary, question}` (the session's persisted permission_ask record — the waiting-for-human evidence that survives restarts; the web's morning line 「昨夜停在这里等你授权」 renders off it and it withdraws once the record settles). A READ (not vaulted); the FIRST server-answered op (the coordinator is host-mounted server state like the pet lane — no driver round-trip). Err `"recovery not supported by this server"` when the host mounted no coordinator (old servers: `unknown op`) — callers treat any refusal as "no banner", quiet. |
| attachmentSave | `{"op":"attachmentSave","inputs":[{"data":"<base64>","mediaType":"image/png"}]}` | M79 §4: an array of `ImageAttachmentRef` (`{kind:"image", attachmentId, mediaType, byteLength}`), input order preserved. Admission is fail-closed in the driver's AttachmentStore BEFORE any write: over `maxImages` (default 9) → err `…TOO_MANY_IMAGES`; cumulative base64 over `maxRequestImageBytes` (default 20MiB) → err `…IMAGES_TOO_LARGE`; unsupported mediaType / malformed base64 → err naming the cause. |
| attachmentGet | `{"op":"attachmentGet","ref":{"kind":"image","attachmentId":"…","mediaType":"image/png","byteLength":3}}` | M79 §4: `{data:"<base64>", mediaType}` — one stored image for rendering (history images). Unknown id / non-image mediaType / traversal-shaped id → op error from the store's path guard. |
| fileSave | `{"op":"fileSave","inputs":[{"data":"<base64>","name":"report.pdf"}]}` | ω99-55: an array of `FileBlock` (`{kind:"file", name, bytes, attachmentId:"sha256:<64hex>"}`), input order preserved — the file lane of the SAME attachment domain (a separate count/byte ledger from the images). Bytes are stored verbatim, content-addressed: equal bytes dedup to one object under `.wudao/attachments/file-objects/<dd>/<sha256>`, and every display name gets a read-only hardlink at `.wudao/attachments/files/<dd>/<sha256>/<name>` — the model-visible path request build projects to handle text (no wire ever carries file bytes). Admission fail-closed BEFORE any write: over `maxFiles` (default 9) → err `…TOO_MANY_FILES`; cumulative base64 over `maxRequestFileBytes` (default 50MiB) → err `…FILES_TOO_LARGE`; malformed base64 → err naming the cause. No type whitelist (the store keeps bytes; the model reads lazily with the ordinary file tools). |
| pluginList | `{"op":"pluginList"}` | cc-plugins C1: `{installed:[{id:"<name>@<market>", name, market, scope:"user"\|"project"\|"adhoc", enabled, version?}]}` — the install registry + enable state (the settings page's 已装 list). Registry-only: the session's `--plugin` adhoc mounts are process-local and not surfaced. |
| mcpList | `{"op":"mcpList"}` | MCP visibility (the settings page's MCP tab): `{servers:[{name, tier:"user"\|"root"\|"project", transport:"stdio"\|"http", command, replaces:("user"\|"root")[], connected, tools, failure?}], warnings, files:{user, root, project}}` — every CONFIGURED server across the three tiers (user `~/.wudao/mcp.json` · root `.mcp.json` · project `.wudao/mcp.json`; Claude-Code-style `mcpServers` accepted everywhere), effective-entry rows with the replacement receipts. `command` is process-list-visible data only (stdio: command+args; http: the redacted URL) — env maps and http headers NEVER ride the reply (secrets). The runtime lane (`connected`/`tools`/`failure`) reflects this session's bridge snapshot: `connected:false` = not connected yet (lazy load included), not an error. |
| pluginMarketList | `{"op":"pluginMarketList"}` | cc-plugins C1: `{marketplaces:[{name, source, addedAt, description?, plugins:[{name, description?, version?, detail}]}]}` — every registered market plus its discover entries; `detail` = the `{skills,commands,agents,hooks,mcp}` install-preview counts (the loader dry-run) when the entry's source resolves to a local directory, `null` for git-location sources (inspectable only by cloning). A registered market whose materialization cannot be read lists with `plugins: []` (`pluginMarketUpdate` is the repair path). |
| pluginMarketAdd | `{"op":"pluginMarketAdd","source":"owner/repo · git URL#ref · 本地目录 · marketplace.json 路径","name":"…"?}` | cc-plugins C1: `{name, source, addedAt, description?}` — the engine's registry row (`name` overrides the manifest's own). Engine failures reject with the engine's message verbatim (invalid-source / invalid-name / already-exists / git / registry). |
| pluginMarketUpdate | `{"op":"pluginMarketUpdate","name":"m"}` | cc-plugins C1: `{name, source, addedAt, description?}` — re-pull / re-copy one registered market (a hand-deleted git materialization is re-cloned). |
| pluginMarketRemove | `{"op":"pluginMarketRemove","name":"m"}` | cc-plugins C1: `{removedPlugins:["alpha"], warnings:[…], rescan?}` — unregisters, deletes the materialization, and CASCADE-uninstalls the plugins the market installed (both scopes); engine warnings ride `warnings`. While a run is in flight the op REFUSES with `⚠️ 运行中无法移除市场（任务进行中）` (the cascade deletes plugin dirs a run's hooks may be executing from) — before any engine call, nothing touched. |
| pluginInstall | `{"op":"pluginInstall","name":"alpha","market":"m","scope":"user"?}` | cc-plugins C1: `{dir, detail:{skills,commands,agents,hooks,mcp}, warnings:[…], rescan?}` — copies/clones into the scope root and registers; `detail` = the loader dry-run's install preview (InstallDetail); `scope` defaults to `user` (`project` lands under `<workspace>/.wudao/plugins/`, the record storing the workspace's realpath). Engine failures (not-found / already-exists / invalid-plugin) reject with the engine's message. |
| pluginUninstall | `{"op":"pluginUninstall","id":"alpha@m"}` | cc-plugins C1: `{id, warnings:[…], rescan?}` — deletes the install dir + registry record + enable key. Busy → REFUSES with `⚠️ 运行中无法卸载插件（任务进行中）` before any engine call. A rootless project record warns and uninstalls nothing (the engine refuses to guess deletions) — the warning rides `warnings`. |
| pluginEnable | `{"op":"pluginEnable","id":"alpha@m"}` | cc-plugins C1: `{id, enabled:true, rescan?}` — default installed = enabled; re-enabling DELETES the enabledPlugins key (absent = default). |
| pluginDisable | `{"op":"pluginDisable","id":"alpha@m"}` | cc-plugins C1: `{id, enabled:false, rescan?}` — hides the plugin from discovery's mapping (the registry record is kept). |
| panelRootSet | `{"op":"panelRootSet","path":"/abs/dir"}` | workspace-ux B1: `{root:"/abs/dir"}` — switch the file panel's VIEW root. The server shape-gates the frame (`path` non-string/empty → err `"panelRootSet path must be a non-empty string"`); the driver stats the path: missing → err `"no such directory: …"`, not a directory → err `"not a directory: …"` (nothing moves on failure). On success `fileTree`/`fileRead` resolve against the new root from the next call, the pick is recorded into the recents file (the same store `recentWorkspaces` reads), and the status channel is poked. Busy-safe by design — the view root is NOT the agent root: the session, the tool boundary, and the run are untouched. |
| agentRootStatus | `{"op":"agentRootStatus"}` | workspace-ux B1: `{panelRoot, agentRoot, bootRoot?, aligned}` — 138 adds the OPTIONAL `bootRoot` (the session anchor: CLI cwd / the desktop data dir — the workspace menu's 默认空间 pinned entry). Legacy servers omit it → the pin hides. The dual-root snapshot. `panelRoot` = the file panel's view root (`fileTree`/`fileRead` resolve here); `agentRoot` = the agent's workspace root (the tools' boundary; starts at the session root, cwd when none was given, moves only via `agentRootSwitch`); `aligned` compares REALPATHS (stored/reported raw — a symlinked pick does not false-negative). |
| agentRootSwitch | `{"op":"agentRootSwitch","path":"/abs/dir"}` | workspace-ux B2: `{applied, queued}` — switch the AGENT's workspace root (the confirm-card action after a `panelRootSet`). Idle → `{applied:true}` lands NOW; busy → `{queued:true}` parks until the run's settle seam (the in-flight run keeps the OLD root throughout). Server shape-gate: non-string/empty `path` → err `"agentRootSwitch path must be a non-empty string"`; driver validation: missing → `"no such directory: …"`, not a directory → `"not a directory: …"` (nothing moves on failure). Landing = ONE wholesale migration: the builtin file tools' boundary (read/write/edit/glob/grep), `shell`'s cwd, the FileChanged watchers, and the hook payload root — plus a history notice and a `<workspace_changed path="…">` system note on the next first model call. NEVER touched: the system prompt (byte-identical — M24 prefix cache survives), the session id/JSONL (stays anchored at the boot root), spill/memory/settings writes. The pick is recorded into the recents file (best-effort). |
| personaList | `{"op":"personaList"}` | persona-settings T5: `{personas:[{id, displayName, source:"builtin"\|"global"\|"workspace", layers, editable}]}` — every registered persona over the three-tier merged registry (builtins ⊕ `~/.wudao/personas/` ⊕ `<workspace>/.wudao/personas/`, same-id later tier wins). `layers` is a content-based display label of the layers the definition carries (`"headers"`, `"headers+body+prompt"`, …); `editable` is `source==="global"` — builtin fingerprints are pinned data and workspace files belong to the repo, so only the global tier is writable through the ops below. |
| personaGet | `{"op":"personaGet","id":"claude-code"}` | persona-settings T5: `{definition}` — one persona's full definition (the detail form's data). An unknown id is an op ERROR (`unknown persona "…"`) — the 404 semantics. |
| personaSave | `{"op":"personaSave","definition":{…}}` | persona-settings T5: `{ok:true}` \| `{ok:false, errors:[…]}` — create/update ONE GLOBAL persona (`~/.wudao/personas/<id>.json`, atomic tmp+rename 0600). The definition re-validates server-side (`validatePersonaDefinition`: kebab-case id, forbidden auth/transport headers, per-protocol body whitelists, template-slot grammar) and the refusal is the validator's PER-FIELD error list — field-path prefixed (`headers.anthropic.x: …`), which the form matches back to its rows. ids colliding with a builtin or workspace persona refuse the same way; a GLOBAL persona with the same id is the UPDATE path. VAULTED (a registry write). |
| personaDelete | `{"op":"personaDelete","id":"alpha","unbind":true?}` | persona-settings T5: `{ok:true}` \| `{ok:false, references:{providers:[…], isGlobalDefault}}` — delete one GLOBAL persona. Builtin ids, workspace ids, and unknown ids are op ERRORS (they never reach the confirm card). When the persona is still REFERENCED (provider cards bound to it and/or it is the global default) and `unbind` is absent, the op returns `{ok:false, references}` — the confirm card's inventory; nothing is touched. With `unbind:true` (or nothing to unbind): every bound card's `persona` key is REMOVED (back to key-absent = follow the global default — not `null`, which is the different "forced none" choice), the global default `persona.id` is cleared, then the file is deleted. VAULTED (delete converges on replay). |
| probeStream | `{"op":"probeStream","cat":"model"?}` | PB-2（探针基础设施弧）: `true` — subscribe the probe telemetry lane: from the ack on, every matching bus event relays as a `{t:"probe", event}` frame. `cat` OPTIONAL: absent or `"*"` = ALL categories; one of `model\|tool\|ui\|system\|agent` = that category only, `"off"` = UNSUBSCRIBE (139: the dashboard closes → the stream stops) (anything else → err `"probeStream cat must be one of model\|tool\|ui\|system\|agent\|* when present"`). One filter slot per client (v1-A single connection): a re-`probeStream` REPLACES the filter (idempotent, last wins; no separate unsubscribe op). A READ for census/vaulting — never vaulted, never replayed (a replay just re-subscribes). Server-answered (the host-mounted bus, `recoveryStatus` precedent — no driver round-trip). Absent bus → err `"probe not supported by this server"`; mounted-but-unsubscribed → ZERO probe frames. |
| probeRecent | `{"op":"probeRecent","cat":"model"?,"limit":50?}` | PB-2: the ring buffer's tail as `[ProbeEvent, …]` — `cat` filters like `probeStream` (absent/`"*"` = all), `limit` = integer `1..1000` (else err `"probeRecent limit must be an integer 1..1000 when present"`; absent = the bus's own default). A pure read, never vaulted. Same absent-bus refusal as its siblings. |
| probeEnable | `{"op":"probeEnable","on":<boolean>}` | 139（探针仪表盘）: `{enabled, modelCallNeedsRestart:true}` — flip the probe master gate at RUNTIME (`WUDAO_PROBE`): the gate is read per call, so loop-mounted probes (agent.* / tool.*) pick it up from the next run; the model client wrapper is formed at provider-construction time, so model.call metering needs a restart with `WUDAO_PROBE=on` (the reply says so). Never vaulted (same-value flips are idempotent). Absent bus → the sibling refusal. |
| probeStats | `{"op":"probeStats"}` | PB-2: the stats face — `{"<name>":{count, lastTs}, …}` verbatim from the bus (per-probe-name counts). A pure read, never vaulted. Same absent-bus refusal. |

The settings ops are OPTIONAL on the driver port (absent → the op errors with
"settings ops not supported"); the `wudao ui` host always provides them
(`packages/cli/src/driver/settings-ops.ts`). They ride the SAME first-frame
auth as every other op. `setMode` accepts the host's configured mode set
(`workspace, ask, auto, plan` under `wudao ui`).

M74-ide §1: the file ops (`fileTree`/`fileRead`) are OPTIONAL on the driver
port the same way (absent → `"file ops not supported by this driver"`); the
`wudao ui` host provides them (`AgentDriver.fileTree`/`fileRead`). They are
DATA ops for the IDE's file panels and deliberately do NOT ride the
permission pipeline (that is the agent tools' path): containment is the SAME
`resolveWorkspacePath` gate `read_file` uses (escape → op error, never a
close), and the sensitive-path list above is STRICTER than the agent's
`read_file` — the data panel must not read key material.

workspace-ux B1: that containment gate is anchored at the driver's
`panelRoot` — the file panel's VIEW root (initially the workspace root, cwd
when none was given), moved only by `panelRootSet` above. The agent's own
tools keep reading the workspace root: the two roots decouple the moment a
panel switch lands. The panel-root ops are OPTIONAL the same way (absent →
`"panel root ops not supported by this driver"`); the `wudao ui` host
provides them (`AgentDriver.panelRootSet`/`agentRootStatus`).

M76-ux2 §8: `ctxInfo` is OPTIONAL the same way (absent → `"ctx info not
supported by this driver"` — the client falls back to the plain ctx
segment); the `wudao ui` host provides it (`AgentDriver.ctxInfo`).

ω99-213: `recap` is OPTIONAL the same way (absent → `"recap not supported
by this driver"` — the client shows no card); the `wudao ui` host provides
it (`AgentDriver.recap`).

ω99-316: `sideQuestion` is OPTIONAL the same way (absent → `"sideQuestion
not supported by this driver"`); the `wudao ui` host provides it
(`AgentDriver.sideQuestion`).

M79 §4: the attachment ops are OPTIONAL the same way (absent →
`"attachment ops not supported by this driver"`); the `wudao ui` host
provides them over the workspace's `.wudao/attachments` store
(`packages/cli/src/driver/attachment-ops.ts`). They ride the SAME
first-frame auth as every op, and the store's admission limits are the ONLY
image-count/size gate (no server-side second policy).

cc-plugins C1: the plugin ops are OPTIONAL the same way (absent → `"plugin
ops not supported by this driver"`); the `wudao ui` host provides them
(`packages/cli/src/driver/settings-ops.ts`) over the SAME A1/A2 marketplace
engine `/plugin` and `wudao plugin` drive — one engine, three faces, one
failure vocabulary (engine rejections ride the err string verbatim). The
mutating ops that change what discovery would map (install / uninstall /
enable / disable / marketplace remove) hot-rescan the session's extension
state (A3) and carry the `rescan` receipt; `pluginMarketAdd` /
`pluginMarketUpdate` never do. The busy law for the two directory-deleting
ops is enforced in the OP layer (the 「⚠️ 运行中无法 …（任务进行中）」
family): the web client can call ops anytime, so the driver's slash-path
guard is not the only gate.

persona-settings T5: the persona ops are OPTIONAL the same way (absent →
`"persona ops not supported by this driver"`); the `wudao ui` host provides
them (`packages/cli/src/driver/settings-ops.ts`) over the providers
package's persona seam (`loadPersonaRegistry` + the Task-5 file helpers).
They ride the SAME first-frame auth as every other op, the two writes are
VAULTED mutations (see the vaulted-ops list above), and the `layers` label /
edit gate / reference-inventory semantics live in the op rows above. The
chain these ops feed (env > provider binding > global default > none) is
resolved at BOOT and at provider switches — a settings-tab change takes
effect on the next resolution point, never mid-request.

attachmentGet's auth is CONNECTION-LEVEL, not a per-session ACL: any
authenticated client may read any attachment id the store holds. That is
the v1 contract because the mitigations bracket the surface — the server
binds loopback only (anything else is refused), admits exactly ONE client
(a second is closed), the token is a 32-byte base64url secret that only the
printed URL fragment carries, ids are unguessable uuid v4s from
`randomUUID`, and the read side re-validates the strict id shape plus the
mediaType allowlist before the workspace path guard resolves the file. A
per-session/per-attachment ACL would only matter once multiple sessions
share one server — revisit then (M79b, with the web writer).

M63 §C (first-run wizard): the client gates on the settingsStatus reply —
`readiness: true` (any provider ready) skips the wizard whole; `readiness:
false` plus `settings.wizardCompletedVersion` below the client's wizard copy
version shows it. Completion writes `wizard.completedVersion` and
`ui.defaultMode` through settingsSet, saves the key through settingsSaveKey,
and switches the live provider by submitting `/provider <name>`.

Semantics live in the driver (`packages/cli/src/driver/agent-driver.ts`); this
server only relays. `submit` routes driver-executable commands (`/plan`,
`/skill:name`, `/rewind`, `/clear` (M80: the driver-owned reset — outcome
`"cleared"`), plan-review `ok` / `改 …`) and @-mentions; a
`"frontend"` outcome means the line was a UI-presentational command
(`/help`, `/resume`, `/exit`, plugin/extension commands) the CLIENT
renders itself. A parked `pendingPermission` in `state` is answered with
`answerPermission`.

## Lanes（多 driver 车道寻址，弧 B）

一台 server = 一张车道表。主车道（key `"main"`）就是 `driver` 具名槽——一切
op 的缺省目标；副车道（key = 其会话 id `<sessionId>`）由宿主在构造期
（`laneDrivers`）或运行时（`mountLane`/`closeLane`）挂载/卸下，每车道一个独立
driver（独立会话、独立租约、独立在飞 run——切走 = 视角切换，不是对话换血）。
pet 车道仍是具名槽（`petDriver`）：它的面是 `petSubmit`/`petInterrupt`/
`petAnswerPermission`/`petHistory`（ω99-235/271）与 M85-pet §2 的工具栏四 op
（`petNewSession`/`petSetModel`/`petSetEffort`/`petSetWorkspace`）及状态帧的
`pet` 字段（含 workspace 对），不参与 sid 寻址
（`"pet"` 是保留字，sid 寻址它答 `unknown lane sid: pet`）。

### 帧面

- **state 帧的 OPTIONAL `lanes`**：`{"t":"state","state":{…},"lanes":{"<sid>":{…},…}}`
  ——所有已挂副车道的状态快照（key=会话 id，推送时逐车道重读）。无副车道时
  字段整体缺席（旧形状字节不变）；车道挂载/卸下各推一帧（`lanes` 的增减即
  车道面变化信号）。
- **history 帧的 OPTIONAL `sid`**：副车道的追加帧与 reset 帧都带
  `"sid":"<sessionId>"`；主车道帧永不带。auth/reconnect 后的初始重放：主车道
  reset 帧之后，每条已挂副车道各跟一帧 `{t:"history", entries, reset:true, sid}`。

### op 寻址

交互写 op `submit` / `interrupt` / `setMode` / `answerPermission` /
`recallSteer` / `answerAskUser` / `detachToolCall` 的 **op 对象**接受 OPTIONAL
`sid` 字段（与 `images`/`scope` 等既有可选字段同位）：

- 缺省（无 `sid`）= 主车道——v1 行为字节不变（老客户端从不发 sid）。
- `"sid":"main"` 显式寻址主车道，与缺省等价。
- `"sid":"<sessionId>"` 路由到对应副车道的 driver；形状/语义校验与主车道
  逐字镜像（bad shape / bad mode 在到 driver 之前拒，文案同款）。
- 未知 sid → err `"unknown lane sid: <sid>"`；非字符串 → err
  `"sid must be a string when present"`。
- 幂等 vault 的 digest 覆盖整个 op 对象（`sid` 在内）：同一 `cid`+`id` 打
  不同车道 = conflict；每 `(cid, id, sid)` 恰好执行一次（mid-flap 重放
  join/重放原回执）。
- 主车道 submit 触发挂载 recovery 的 `noteUserInput`（用户接管的是主会话）；
  副车道 submit 不触发——那是另一个会话的接管，不作废主会话的待恢复。

会话寻址 op（`resume`/`sessionContinue`/`sessionDelete`/…）与全部设置/文件/
插件/persona 面保持主车道：v1 车道弧只车道化「七个交互写面 + 两个中继道」。
`sessions` 的行标记随表泛化：行 id 命中已挂副车道的 sid → `lane:"<sid>"`
（`"pet"` 先例的推广——占用中的会话不 resume、UI 走车道切换；卸载后标记随
表消失，pet 标记不受影响）。

### 兼容性声明（v1 客户端零影响）

沿用协议一贯的「加性可选字段」纪律：**不挂副车道的主机，每一帧、每一个 op
行为字节不变**（无 `lanes`、无 `sid`、无路由分歧）——v1 客户端零影响，这也
是缺省装配形态。挂了副车道的主机：state 帧的 `lanes` 是 v1 客户端忽略的
未知字段；history 帧的 `sid` 则需要 lane-aware 客户端配合（v1 客户端会把它
收到的每帧史无差别并入主转录）——所以副车道只与随路发布的 lane-aware 前端
（弧 C）同开，主机侧不单方面给旧客户端喂 sid 帧。

## Errors

Close codes: `4401` auth failed/timeout, `4000` second client, `4403` bad Host
(HTTP-level 403 for plain requests). Op errors return
`{"t":"result","id":…,"ok":undefined,"err":"…"}` — never a close.

## v1-A non-goals

Incremental state protocol, multiple simultaneous WS clients (the ONE
authenticated connection stays the law — concurrent drivers ride lane
addressing over that one connection, see Lanes), multi-tab UX, remote
binding, TLS, and any real UI. Static serving: `--static <dir>`/`packages/web/dist` when it
exists, otherwise the protocol placeholder page (which is itself a reference
client for this protocol).
| switchWorkspace | `{"op":"switchWorkspace","path":"/abs/dir"}` | **DEPRECATED (workspace-ux B)** — M77 §1: `{url:"http://127.0.0.1:<port>/#<token>"}` — starts a NEW UI session for the target directory (same process, new port) and returns its URL; the client navigates there (same-window switch). This is the old "switch directory = switch session" model: the conversation resets. The web no longer calls it — use `panelRootSet` (immediate view re-root) + `agentRootSwitch` (confirmed agent re-root, session preserved) instead. The op stays on the wire for older clients only. |
