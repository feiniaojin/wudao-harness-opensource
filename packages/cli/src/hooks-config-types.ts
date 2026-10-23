// Hooks configuration contracts — module-level segment extracted from
// hooks-config.ts (ω99 file-size discipline arc A). Pure types and the
// canonical event registry: no IO, no imports, no runtime state.
export interface HookCommandConfig {
  /** The command backend (execFile, no shell). Optional only for the
   *  mcp_tool backend (type:"mcp_tool" names server/tool instead). */
  readonly command?: string;
  readonly timeoutMs?: number;
  /** M63-A §2: which firings of this event the command sees. Pure
   *  `字母数字_- 空格,|` = exact match / comma-pipe separated LIST of exact
   *  values (e.g. "startup", "startup,resume"); anything else = JS RegExp,
   *  UNANCHORED (e.g. "^read_" matches read_file). Absent = every firing. */
  readonly matcher?: string;
  /** M63-C §3: fire this entry ONCE per session (the first applicable
   *  firing only; later firings skip it). */
  readonly once?: boolean;
  /** M63-C §3: run this entry only in these PERMISSION MODES (exact value
   *  or comma-pipe list: workspace|ask|auto|plan — e.g. gate an // ω99-191: #2
   *  audit hook to the auto tier). Absent = every mode. */
  readonly if?: string;
  /** M63-C §3: fire in the BACKGROUND — the event never waits on this
   *  entry, and its output cannot contribute a decision. */
  readonly async?: boolean;
  /** M63-C §3: with async — a background exit code 2 WAKES the agent (the
   *  rewake sink receives the hook's first stdout line as a steering note). */
  readonly asyncRewake?: boolean;
  /** M63-C §3: the status receipt shown when an async entry fires. */
  readonly statusMessage?: string;
  /** M63-C §3: the mcp_tool backend — the hook handler is a call to the
   *  named MCP server's tool. `input` string values support ${path.to.field}
   *  injection from the event payload. */
  readonly type?: "mcp_tool";
  readonly server?: string;
  readonly tool?: string;
  readonly input?: Record<string, unknown>;
  /** cc-plugins E4: the install dir of the plugin this entry came from —
   *  CC's ${CLAUDE_PLUGIN_ROOT} convention: the token (braced or bare) is
   *  substituted into the command before tokenization (execFile runs no
   *  shell) and the dir is exported as the child's CLAUDE_PLUGIN_ROOT env
   *  for the command's own children to read at runtime. Absent on every
   *  user-authored entry — no root is ever invented. */
  readonly pluginRoot?: string;
  /** ω99-21 — HARNESS-STAMPED provenance, never authorable: the settings
   *  loaders rebuild entries field-by-field, so this flag only ever lands
   *  in memory (plugins.ts's mergeHooksSettings stamps it on project-scope
   *  plugins' onPermissionRequest entries). A denyOnly entry may DENY or
   *  stay silent; its ALLOW is treated as no opinion (the original pipeline
   *  decides) — .wudao/plugins is agent-writable, and an allow from there is
   *  the injected authorizing itself. */
  readonly denyOnly?: boolean;
}

// M63-A config scope: the v1 events (onPromptSubmit/onRunStop/onPreToolUse/
// onPostToolUse + the preToolUse/postToolUse aliases) plus the batch-A event
// surface. onRunStart stays internal (not configurable — no external value).
export interface HooksSettings {
  readonly onPromptSubmit?: readonly HookCommandConfig[];
  readonly onRunStop?: readonly HookCommandConfig[];
  readonly onPreToolUse?: readonly HookCommandConfig[];
  readonly onPostToolUse?: readonly HookCommandConfig[];
  /** M63-A: matcher = startup|resume|clear|compact|fork. */
  readonly onSessionStart?: readonly HookCommandConfig[];
  /** M63-A: matcher = manual|auto. Blocking = defer (see AgentHooks). */
  readonly onPreCompact?: readonly HookCommandConfig[];
  /** M63-A: matcher = manual|auto. Observer. */
  readonly onPostCompact?: readonly HookCommandConfig[];
  /** M63-A: matcher = tool name. JSON decision allow/deny+reason. */
  readonly onPermissionRequest?: readonly HookCommandConfig[];
  /** M63-A: matcher = notification kind (permission|idle). Observer. */
  readonly onNotification?: readonly HookCommandConfig[];
  /** M63-A: matcher = tool name. Observer (the failure face). */
  readonly onPostToolUseFailure?: readonly HookCommandConfig[];
  /** M63-A: no matcher. {"continue":false} ends the run at the batch. */
  readonly onPostToolBatch?: readonly HookCommandConfig[];
  /** M63-B: no matcher. Fires when a todo_write ADDS items; {block} refuses
   *  the write. */
  readonly onTaskCreated?: readonly HookCommandConfig[];
  /** M63-B: no matcher. Fires when a todo_write completes items; {block}
   *  refuses the write. */
  readonly onTaskCompleted?: readonly HookCommandConfig[];
  /** M63-B: matcher = agent type (general-purpose/coder/fork/roles). */
  readonly onSubagentStart?: readonly HookCommandConfig[];
  /** M63-B: matcher = agent type. {continue:false}/{"block"} keeps the child
   *  working one more turn (the Stop mechanics + cap). */
  readonly onSubagentStop?: readonly HookCommandConfig[];
  /** M64-C §C: matcher = teammate name. Exit 2 or {"continue":true,
   *  "feedback"} continues the idle teammate with the feedback (反馈续跑);
   *  exit 0 without continuation → stays idle. `error` carries the API
   *  error text when the idle follows a failure. */
  readonly onTeammateIdle?: readonly HookCommandConfig[];
  /** M63-B: matcher = LITERAL FILENAME (plain matcher only — a RegExp
   *  matcher is inert: the watcher enumerates the plain values as its watch
   *  targets). The CLI watcher delivers changes to the model via the
   *  steering channel too. */
  readonly onFileChanged?: readonly HookCommandConfig[];
  /** M63-B: matcher = user|project|local|skills. {block} vetoes the change
   *  (the permission-rules hot reload keeps the previously accepted rules;
   *  skills is advisory-only). */
  readonly onConfigChange?: readonly HookCommandConfig[];
  /** M63-B: matcher = session_start|nested_traversal|path_glob_match|compact
   *  (nested_traversal has no firing seam yet — accepted, inert). */
  readonly onInstructionsLoaded?: readonly HookCommandConfig[];
  /** M63-B: matcher = clear|resume|exit|other. ALL SessionEnd hook commands
   *  share a 1.5s budget (SESSION_END_BUDGET_MS) — over-budget commands are
   *  killed. */
  readonly onSessionEnd?: readonly HookCommandConfig[];
  /** M63-B: matcher = error class (context|error). Observer. */
  readonly onStopFailure?: readonly HookCommandConfig[];
}

export type HookWarn = (message: string) => void;

/** M63-A: THE canonical hook-event key list — the single source of truth.
 *  Every surface that enumerates event keys derives from this constant: the
 *  loader's KNOWN_EVENTS, plugins.ts's mergeHooksSettings, and (the
 *  values of) its CC-name HOOK_EVENT_MAP. A batch-B/C event lands HERE and
 *  in the HooksSettings interface — nowhere else — so no fixed list can
 *  silently strip events again (review fix: the list was triplicated and the
 *  plugin merge's copy had already dropped the batch-A keys once). */
export const CANONICAL_HOOK_EVENTS = [
  "onPromptSubmit", "onRunStop", "onPreToolUse", "onPostToolUse",
  "onSessionStart", "onPreCompact", "onPostCompact", "onPermissionRequest", "onNotification", "onPostToolUseFailure", "onPostToolBatch",
  // M63-B batch B
  "onTaskCreated", "onTaskCompleted", "onSubagentStart", "onSubagentStop", "onTeammateIdle", "onFileChanged", "onConfigChange", "onInstructionsLoaded", "onSessionEnd", "onStopFailure",
] as const;
export type CanonicalHookEvent = (typeof CANONICAL_HOOK_EVENTS)[number];
