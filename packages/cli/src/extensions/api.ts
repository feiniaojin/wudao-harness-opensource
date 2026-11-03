// M39: ExtensionAPI v1 — the surface handed to `.wudao/extensions/*.mjs`
// factories. Extensions are CODE, not config: loading a file runs it with the
// caller's privileges (same trust class as hook commands / MCP servers — see
// the README trust model). This module owns the runtime shape only; the
// file loading lives in loader.ts.
//
// Isolation contract (mirrors the loop's AgentHooks posture): every handler
// call is wrapped — observer-event failures (run_start/post_tool_use/
// pre_compact/post_compact) warn and continue; interceptor-event failures
// (prompt_submit/run_stop/pre_tool_use) warn and degrade to the original
// prompt / "allow" / no-block, so one broken extension can never wedge or
// crash a run. Extension tool execute() is wrapped the same way (throw →
// error tool result, never a thrown loop).
//
// M40 §1: every handler call also runs under a TIMEOUT (default 10s,
// WUDAO_EXTENSION_TIMEOUT_MS; 0 disables). A timed-out observer warns and is
// skipped; a timed-out interceptor degrades to allow/original — the SAME
// path a throw takes, so a hung extension can no more wedge a run than a
// throwing one (mirrors the config-hooks timeoutMs posture in hooks-config).
import { buildTool } from "@wudao-org/core";
import type { AgentHooks, AgentMessage, AgentState, SessionEntry, SessionStore, Tool, ToolParameterSchema, ToolResult } from "@wudao-org/core";
import { sanitizeWireToolSegment } from "../mcp/tools.js";
import { isBuiltinCommandName } from "../plugins.js";

export type ExtensionWarn = (msg: string) => void;

function defaultWarn(msg: string): void {
  process.stderr.write(`⚠️ ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Events + payloads (JSON-serializable shapes only — no live objects)
// ---------------------------------------------------------------------------

export type ExtensionEventName =
  | "run_start"
  | "run_stop"
  | "prompt_submit"
  | "pre_tool_use"
  | "post_tool_use"
  | "pre_compact"
  | "post_compact";

export const EXTENSION_EVENT_NAMES: readonly ExtensionEventName[] = [
  "run_start",
  "run_stop",
  "prompt_submit",
  "pre_tool_use",
  "post_tool_use",
  "pre_compact",
  "post_compact",
];

export interface RunStartPayload {
  readonly event: "run_start";
  readonly sessionId: string | undefined;
  readonly messageCount: number;
  readonly toolCount: number;
}

export interface RunStopPayload {
  readonly event: "run_stop";
  readonly sessionId: string | undefined;
  readonly messageCount: number;
  readonly lastAssistant: string | undefined;
}

export interface PromptSubmitPayload {
  readonly event: "prompt_submit";
  readonly sessionId: string | undefined;
  readonly prompt: string;
}

export interface PreToolUsePayload {
  readonly event: "pre_tool_use";
  readonly sessionId: string | undefined;
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export interface PostToolUsePayload {
  readonly event: "post_tool_use";
  readonly sessionId: string | undefined;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly result: string;
}

export interface PreCompactPayload {
  readonly event: "pre_compact";
  readonly sessionId: string | undefined;
  readonly messageCount: number;
  /** M63-A: "manual" (driver /compact) vs "auto" (every loop-internal tier). */
  readonly trigger: "manual" | "auto";
}

export interface PostCompactPayload {
  readonly event: "post_compact";
  readonly sessionId: string | undefined;
  readonly messageCount: number;
  /** M63-A: same trigger word as pre_compact. */
  readonly trigger: "manual" | "auto";
}

/** An interceptor's block decision — same shape the AgentHooks seams use. */
export interface ExtensionBlock {
  readonly block: true;
  readonly reason: string;
}

export type PromptSubmitResult = string | ExtensionBlock | void;
export type RunStopResult = ExtensionBlock | void;
export type PreToolUseResult = ExtensionBlock | void;

export type RunStartHandler = (p: RunStartPayload) => void | Promise<void>;
export type RunStopHandler = (p: RunStopPayload) => RunStopResult | Promise<RunStopResult>;
export type PromptSubmitHandler = (p: PromptSubmitPayload) => PromptSubmitResult | Promise<PromptSubmitResult>;
export type PreToolUseHandler = (p: PreToolUsePayload) => PreToolUseResult | Promise<PreToolUseResult>;
export type PostToolUseHandler = (p: PostToolUsePayload) => void | Promise<void>;
export type PreCompactHandler = (p: PreCompactPayload) => void | Promise<void>;
export type PostCompactHandler = (p: PostCompactPayload) => void | Promise<void>;

export interface ExtensionOn {
  (event: "run_start", handler: RunStartHandler): void;
  (event: "run_stop", handler: RunStopHandler): void;
  (event: "prompt_submit", handler: PromptSubmitHandler): void;
  (event: "pre_tool_use", handler: PreToolUseHandler): void;
  (event: "post_tool_use", handler: PostToolUseHandler): void;
  (event: "pre_compact", handler: PreCompactHandler): void;
  (event: "post_compact", handler: PostCompactHandler): void;
}

// ---------------------------------------------------------------------------
// Tools / commands / entries
// ---------------------------------------------------------------------------

/** What registerTool accepts from an extension (a ToolDef subset — the risk
 *  annotations are deliberately NOT accepted: buildTool's fail-closed
 *  defaults apply and shouldDefer never engages for extension tools). */
export interface ExtensionToolInput {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterSchema;
  execute(args: Record<string, unknown>): Promise<ToolResult> | ToolResult;
}

/** ctx for a registered slash command: submit queues one user turn through
 *  the normal prompt path (hooks see it like any prompt); notice prints an
 *  informational line that never enters the history. */
export interface ExtensionCommandContext {
  submit(text: string): void;
  notice(text: string): void;
}

export type ExtensionCommandHandler = (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;

export interface ExtensionCommand {
  readonly name: string;
  readonly extension: string;
  readonly handler: ExtensionCommandHandler;
}

export interface ExtensionMeta {
  readonly version: string;
  readonly workspaceRoot: string;
  readonly sessionId: string | undefined;
}

/** The v1 surface handed to an extension's default-export factory. */
export interface ExtensionAPI {
  on: ExtensionOn;
  registerTool(tool: ExtensionToolInput): void;
  registerCommand(name: string, handler: ExtensionCommandHandler): void;
  appendEntry(type: string, data: unknown): Promise<void>;
  readEntries(): Promise<readonly SessionEntry[]>;
  readonly meta: ExtensionMeta;
}

// ---------------------------------------------------------------------------
// Runtime (what the CLI frontends consume)
// ---------------------------------------------------------------------------

export interface ExtensionSessionStore extends Pick<SessionStore, "appendEntry" | "loadSessionEntries"> {}

export interface ExtensionRuntime {
  /** Loaded extension file stems, in load order. */
  readonly names: readonly string[];
  /** AgentHooks view of the registered event handlers (undefined when no
   *  extension registered any). Composed AFTER the config hooks. */
  readonly hooks: AgentHooks | undefined;
  /** Validated ext_-prefixed tools — appended at the END of the tool array
   *  (parent-level only, never a child set, never deferred). */
  readonly tools: readonly Tool[];
  /** Precedence-checked slash commands (builtins/plugins win at registration). */
  readonly commands: readonly ExtensionCommand[];
  /** M35 entry channel: bind the session's store + id once the session is
   *  resolved (appendEntry/readEntries warn as unavailable before that). */
  bindSession(store: ExtensionSessionStore, sessionId: string): void;
}

interface Registration {
  readonly extension: string;
}

// Exported (a9aca8f follow-up): this is the parameter type of the exported
// buildExtensionHooks, so consumers of the `wudao-harness/extensions`
// subpath — and the unit tests importing this module directly — need it
// importable by name, not just declared locally.
export interface EventHandlers {
  readonly run_start: ReadonlyArray<Registration & { handler: RunStartHandler }>;
  readonly run_stop: ReadonlyArray<Registration & { handler: RunStopHandler }>;
  readonly prompt_submit: ReadonlyArray<Registration & { handler: PromptSubmitHandler }>;
  readonly pre_tool_use: ReadonlyArray<Registration & { handler: PreToolUseHandler }>;
  readonly post_tool_use: ReadonlyArray<Registration & { handler: PostToolUseHandler }>;
  readonly pre_compact: ReadonlyArray<Registration & { handler: PreCompactHandler }>;
  readonly post_compact: ReadonlyArray<Registration & { handler: PostCompactHandler }>;
}

interface Collector {
  events: {
    run_start: Array<Registration & { handler: RunStartHandler }>;
    run_stop: Array<Registration & { handler: RunStopHandler }>;
    prompt_submit: Array<Registration & { handler: PromptSubmitHandler }>;
    pre_tool_use: Array<Registration & { handler: PreToolUseHandler }>;
    post_tool_use: Array<Registration & { handler: PostToolUseHandler }>;
    pre_compact: Array<Registration & { handler: PreCompactHandler }>;
    post_compact: Array<Registration & { handler: PostCompactHandler }>;
  };
  tools: Tool[];
  commands: ExtensionCommand[];
}

/** Extension tool names must carry the ext_ prefix (collision-proof against
 *  the builtin + MCP namespaces, and a visible marker in permission asks). */
export const EXTENSION_TOOL_PREFIX = "ext_";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// M40 §1 — handler timeouts
// ---------------------------------------------------------------------------

/** Default per-call budget for one extension event handler (the config-hooks
 *  DEFAULT_TIMEOUT_MS posture: generous for real work, finite so a hung
 *  handler cannot wedge the run). */
export const DEFAULT_EXTENSION_TIMEOUT_MS = 10_000;

/** Env override: a positive finite number of ms; `0` (or anything
 *  non-positive/non-numeric, i.e. an explicit off signal) disables the race. */
export const EXTENSION_TIMEOUT_ENV = "WUDAO_EXTENSION_TIMEOUT_MS";

/** Resolve the extension handler timeout. Unset/empty → the 10s default;
 *  a positive finite number → that many ms; anything else → 0 (off). */
export function resolveExtensionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[EXTENSION_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_EXTENSION_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Marker error the race rejects with — a timeout folds onto the handler
 *  THROW path (same handling at every call site), only the message differs. */
class HandlerTimeout extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
  }
}

type HandlerOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string; readonly timedOut: boolean };

/** Run one handler call under the timeout. `ms <= 0` disables the race (the
 *  handler is simply awaited). The timer stays REFFED (cleared in finally):
 *  an unref'd timer would never fire in a quiet process — with nothing else
 *  keeping the event loop alive the race would hang forever, which is the
 *  exact wedge the timeout exists to prevent. A handler that settles late
 *  (after losing the race) is swallowed — Promise.race has already attached
 *  its handlers, so a late rejection can never surface as unhandled. */
async function callHandler<P, T>(handler: (p: P) => T | Promise<T>, payload: P, ms: number): Promise<HandlerOutcome<Awaited<T>>> {
  if (ms <= 0) {
    try {
      return { ok: true, value: await handler(payload) };
    } catch (err) {
      return { ok: false, error: errorMessage(err), timedOut: false };
    }
  }
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HandlerTimeout(ms)), ms);
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => handler(payload)), expiry]);
    return { ok: true, value: value as Awaited<T> };
  } catch (err) {
    return { ok: false, error: errorMessage(err), timedOut: err instanceof HandlerTimeout };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The warn line for one failed (thrown OR timed-out) handler call. */
function handlerFailure(extension: string, event: string, outcome: { readonly error: string; readonly timedOut: boolean }, degrade: string | undefined): string {
  const what = outcome.timedOut ? `handler ${outcome.error}` : `handler failed: ${outcome.error}`;
  return `extension ${extension}: ${event} ${what}${degrade !== undefined ? ` (${degrade})` : ""}`;
}

/** Build the per-extension API object. Registrations land in the shared
 *  collector tagged with the extension's file stem; bad registrations warn
 *  and are skipped (an extension can never crash the load). */
export function createExtensionApi(
  extension: string,
  collector: Collector,
  state: { version: string; workspaceRoot: string; sessionId: () => string | undefined; store: () => ExtensionSessionStore | undefined },
  opts: { warn?: ExtensionWarn; pluginCommandNames?: readonly string[] } = {},
): ExtensionAPI {
  const warn = opts.warn ?? defaultWarn;
  const nameTaken = (what: string, name: string): boolean => {
    if (what === "tool") return collector.tools.some((t) => t.name === name);
    return collector.commands.some((c) => c.name === name);
  };

  const on = ((event: string, handler: unknown): void => {
    if (!EXTENSION_EVENT_NAMES.includes(event as ExtensionEventName)) {
      warn(`extension ${extension}: on("${event}", …) — unknown event (v1: ${EXTENSION_EVENT_NAMES.join(", ")}); skipped`);
      return;
    }
    if (typeof handler !== "function") {
      warn(`extension ${extension}: on("${event}", …) — handler must be a function; skipped`);
      return;
    }
    (collector.events as Record<string, Array<Registration & { handler: unknown }>>)[event]!.push({
      extension,
      handler: handler as never,
    });
  }) as ExtensionOn;

  const registerTool = (tool: ExtensionToolInput): void => {
    if (!isPlainObject(tool)) {
      warn(`extension ${extension}: registerTool(…) — expected a tool object; skipped`);
      return;
    }
    const name = tool.name;
    if (typeof name !== "string" || name === "") {
      warn(`extension ${extension}: registerTool(…) — "name" must be a non-empty string; skipped`);
      return;
    }
    if (!name.startsWith(EXTENSION_TOOL_PREFIX)) {
      warn(`extension ${extension}: registerTool("${name}") — tool names must start with "${EXTENSION_TOOL_PREFIX}" (collision guard); skipped`);
      return;
    }
    // 0.3.81 win32 实机回执（tools[N].function.name 400）：OpenAI 兼容端
    // 按^[a-zA-Z0-9_-]+$校验函数名——前缀之后的字符不在集合内会把整个
    // 请求打死。净化而非跳过（名字只是本会话的注册表键，execute 闭包
    // 不受影响），重写回执随 warn 可见。
    const wireName = `ext_${sanitizeWireToolSegment(name.slice(EXTENSION_TOOL_PREFIX.length), "tool")}`;
    if (wireName !== name) {
      warn(`extension ${extension}: registerTool("${name}") — characters outside [a-zA-Z0-9_-] in the name; registered as "${wireName}"`);
    }
    if (typeof tool.description !== "string" || tool.description === "") {
      warn(`extension ${extension}: registerTool("${name}") — "description" must be a non-empty string; skipped`);
      return;
    }
    const parameters = tool.parameters;
    if (!isPlainObject(parameters) || parameters["type"] !== "object" || !isPlainObject(parameters["properties"])) {
      warn(`extension ${extension}: registerTool("${name}") — "parameters" must be {type:"object", properties:{…}}; skipped`);
      return;
    }
    if (typeof tool.execute !== "function") {
      warn(`extension ${extension}: registerTool("${name}") — "execute" must be a function; skipped`);
      return;
    }
    if (nameTaken("tool", wireName)) {
      warn(`extension ${extension}: tool "${wireName}" already registered by an earlier extension; skipped`);
      return;
    }
    // buildTool fills the fail-closed defaults; the risk annotations an
    // extension might pass are deliberately IGNORED (an ext tool is never
    // read-only, never concurrency-safe, never deferred — the permission
    // pipeline always gets to speak). execute is wrapped for isolation.
    const raw = tool.execute.bind(tool);
    collector.tools.push(
      buildTool({
        name: wireName,
        description: tool.description,
        parameters: parameters as ToolParameterSchema,
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          try {
            const out = await raw(args);
            if (typeof out === "string") return { content: out };
            if (isPlainObject(out) && typeof out["content"] === "string") {
              return { content: out["content"], ...(out["isError"] === true ? { isError: true } : {}) };
            }
            return { content: `extension tool ${name} returned an invalid result (expected {content, isError?})`, isError: true };
          } catch (err) {
            return { content: `extension tool ${name} failed: ${errorMessage(err)}`, isError: true };
          }
        },
      }),
    );
  };

  const registerCommand = (name: string, handler: ExtensionCommandHandler): void => {
    if (typeof name !== "string" || name === "" || /\s/.test(name)) {
      warn(`extension ${extension}: registerCommand(…) — name must be a non-empty string without whitespace; skipped`);
      return;
    }
    if (typeof handler !== "function") {
      warn(`extension ${extension}: registerCommand("${name}") — handler must be a function; skipped`);
      return;
    }
    if (isBuiltinCommandName(name)) {
      warn(`extension ${extension}: registerCommand("${name}") — builtin command names (and the skill: prefix) are reserved; skipped`);
      return;
    }
    if ((opts.pluginCommandNames ?? []).includes(name)) {
      warn(`extension ${extension}: registerCommand("${name}") — a plugin command already owns "/${name}" (builtin/plugin names win); skipped`);
      return;
    }
    if (nameTaken("command", name)) {
      warn(`extension ${extension}: command "/${name}" already registered; skipped`);
      return;
    }
    collector.commands.push({ name, extension, handler });
  };

  const appendEntry = async (type: string, data: unknown): Promise<void> => {
    const store = state.store();
    const sessionId = state.sessionId();
    if (store === undefined || sessionId === undefined) {
      warn(`extension ${extension}: appendEntry(…) — no session bound yet (entries are available once the run's session starts); dropped`);
      return;
    }
    if (typeof type !== "string" || type === "") {
      warn(`extension ${extension}: appendEntry(…) — "type" must be a non-empty string; dropped`);
      return;
    }
    try {
      await store.appendEntry(sessionId, { type, data });
    } catch (err) {
      warn(`extension ${extension}: appendEntry("${type}") failed: ${errorMessage(err)}`);
    }
  };

  const readEntries = async (): Promise<readonly SessionEntry[]> => {
    const store = state.store();
    const sessionId = state.sessionId();
    if (store === undefined || sessionId === undefined) {
      warn(`extension ${extension}: readEntries() — no session bound yet; returning []`);
      return [];
    }
    try {
      return await store.loadSessionEntries(sessionId);
    } catch (err) {
      warn(`extension ${extension}: readEntries() failed: ${errorMessage(err)}`);
      return [];
    }
  };

  const meta: ExtensionMeta = {
    get version(): string {
      return state.version;
    },
    get workspaceRoot(): string {
      return state.workspaceRoot;
    },
    get sessionId(): string | undefined {
      return state.sessionId();
    },
  };

  return { on, registerTool, registerCommand, appendEntry, readEntries, meta };
}

// ---------------------------------------------------------------------------
// AgentHooks bridge — the extension event bus as one AgentHooks object
// ---------------------------------------------------------------------------

function lastAssistantText(state: AgentState): string | undefined {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const m = state.messages[i];
    if (m?.role === "assistant") return m.content;
  }
  return undefined;
}

/** Collect the extension registrations into the AgentHooks the loop already
 *  calls — config hooks compose BEFORE this (hooks-config.composeAgentHooks).
 *  Undefined when no extension registered any handler (zero behavior
 *  change). `timeoutMs` (0 = off) defaults to resolveExtensionTimeoutMs(). */
export function buildExtensionHooks(
  events: EventHandlers,
  opts: { readonly getSessionId: () => string | undefined; readonly warn?: ExtensionWarn; readonly timeoutMs?: number },
): AgentHooks | undefined {
  const warn = opts.warn ?? defaultWarn;
  const sessionId = opts.getSessionId;
  const timeoutMs = opts.timeoutMs ?? resolveExtensionTimeoutMs();
  const total =
    events.run_start.length + events.run_stop.length + events.prompt_submit.length +
    events.pre_tool_use.length + events.post_tool_use.length + events.pre_compact.length + events.post_compact.length;
  if (total === 0) return undefined;

  const hooks: AgentHooks = {};

  if (events.run_start.length > 0) {
    hooks.onRunStart = async (state: AgentState): Promise<void> => {
      const payload: RunStartPayload = {
        event: "run_start",
        sessionId: sessionId(),
        messageCount: state.messages.length,
        toolCount: state.tools.length,
      };
      for (const { extension, handler } of events.run_start) {
        const out = await callHandler(handler, payload, timeoutMs);
        if (!out.ok) warn(handlerFailure(extension, "run_start", out, undefined));
      }
    };
  }

  if (events.run_stop.length > 0) {
    hooks.onRunStop = async (state: AgentState): Promise<"allow" | { block: true; reason: string }> => {
      const payload: RunStopPayload = {
        event: "run_stop",
        sessionId: sessionId(),
        messageCount: state.messages.length,
        lastAssistant: lastAssistantText(state),
      };
      for (const { extension, handler } of events.run_stop) {
        const out = await callHandler(handler, payload, timeoutMs);
        if (!out.ok) {
          warn(handlerFailure(extension, "run_stop", out, "degrading to allow"));
          continue;
        }
        const value = out.value;
        if (value !== undefined && value !== null && value.block === true) {
          return { block: true, reason: typeof value.reason === "string" && value.reason !== "" ? value.reason : "blocked by extension" };
        }
      }
      return "allow";
    };
  }

  if (events.prompt_submit.length > 0) {
    hooks.onPromptSubmit = async (prompt: string): Promise<string | { block: true; reason: string }> => {
      let current = prompt;
      for (const { extension, handler } of events.prompt_submit) {
        const out = await callHandler(handler, { event: "prompt_submit", sessionId: sessionId(), prompt: current }, timeoutMs);
        if (!out.ok) {
          warn(handlerFailure(extension, "prompt_submit", out, "keeping the current prompt"));
          continue;
        }
        const value = out.value;
        if (value !== undefined && value !== null && typeof value === "object" && value.block === true) {
          return { block: true, reason: typeof value.reason === "string" && value.reason !== "" ? value.reason : "blocked by extension" };
        }
        if (typeof value === "string") current = value; // rewrites chain into the next handler
      }
      return current;
    };
  }

  if (events.pre_tool_use.length > 0) {
    hooks.onPreToolUse = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<void | { block: true; reason: string }> => {
      // Payload carries a SHALLOW COPY of input — extensions must never hold the
      // live arguments object (it is the persisted tool_call and the execute input).
      const payload: PreToolUsePayload = { event: "pre_tool_use", sessionId: sessionId(), tool: toolName, input: { ...input } };
      for (const { extension, handler } of events.pre_tool_use) {
        const out = await callHandler(handler, payload, timeoutMs);
        if (!out.ok) {
          warn(handlerFailure(extension, "pre_tool_use", out, "degrading to allow"));
          continue;
        }
        const value = out.value;
        if (value !== undefined && value !== null && value.block === true) {
          return { block: true, reason: typeof value.reason === "string" && value.reason !== "" ? value.reason : "blocked by extension" };
        }
      }
      return undefined;
    };
  }

  if (events.post_tool_use.length > 0) {
    hooks.onPostToolUse = async (toolName: string, input: Record<string, unknown>, result: string): Promise<void | string> => {
      const payload: PostToolUsePayload = { event: "post_tool_use", sessionId: sessionId(), tool: toolName, input: { ...input }, result };
      // M62 §5: a handler may return a plain string (or the CC envelope
      // {hookSpecificOutput:{additionalContext}}) — it becomes context at
      // the next model call, same as command hooks.
      let context = "";
      for (const { extension, handler } of events.post_tool_use) {
        const out = await callHandler(handler, payload, timeoutMs);
        if (!out.ok) {
          warn(handlerFailure(extension, "post_tool_use", out, undefined));
          continue;
        }
        const value: unknown = out.value;
        const text
          = typeof value === "string" && value !== ""
            ? value
            : typeof value === "object" && value !== null && !Array.isArray(value)
              ? (() => {
                  const env = (value as Record<string, unknown>)["hookSpecificOutput"];
                  if (typeof env !== "object" || env === null || Array.isArray(env)) return undefined;
                  const inner = (env as Record<string, unknown>)["additionalContext"];
                  return typeof inner === "string" && inner !== "" ? inner : undefined;
                })()
              : undefined;
        if (text !== undefined) context = context === "" ? text : `${context}\n\n${text}`;
      }
      return context === "" ? undefined : context;
    };
  }

  if (events.pre_compact.length > 0) {
    hooks.onPreCompact = async (messages: readonly AgentMessage[], trigger: "manual" | "auto"): Promise<void> => {
      const payload: PreCompactPayload = { event: "pre_compact", sessionId: sessionId(), messageCount: messages.length, trigger };
      for (const { extension, handler } of events.pre_compact) {
        const out = await callHandler(handler, payload, timeoutMs);
        if (!out.ok) warn(handlerFailure(extension, "pre_compact", out, undefined));
      }
    };
  }

  if (events.post_compact.length > 0) {
    hooks.onPostCompact = async (messages: readonly AgentMessage[], trigger: "manual" | "auto"): Promise<void> => {
      const payload: PostCompactPayload = { event: "post_compact", sessionId: sessionId(), messageCount: messages.length, trigger };
      for (const { extension, handler } of events.post_compact) {
        const out = await callHandler(handler, payload, timeoutMs);
        if (!out.ok) warn(handlerFailure(extension, "post_compact", out, undefined));
      }
    };
  }

  return hooks;
}

/** The late-bound session channel (M35): unset until the frontend resolves
 *  the run's session, then read-only for the rest of the process. */
export interface ExtensionBinding {
  store?: ExtensionSessionStore;
  sessionId?: string;
}

/** Freeze the collector into the immutable runtime the frontends consume. */
export function finalizeExtensionRuntime(
  names: readonly string[],
  collector: Collector,
  state: { version: string; workspaceRoot: string; sessionId: () => string | undefined; store: () => ExtensionSessionStore | undefined },
  binding: ExtensionBinding,
  opts: { readonly warn?: ExtensionWarn; readonly timeoutMs?: number } = {},
): ExtensionRuntime {
  const events: EventHandlers = {
    run_start: [...collector.events.run_start],
    run_stop: [...collector.events.run_stop],
    prompt_submit: [...collector.events.prompt_submit],
    pre_tool_use: [...collector.events.pre_tool_use],
    post_tool_use: [...collector.events.post_tool_use],
    pre_compact: [...collector.events.pre_compact],
    post_compact: [...collector.events.post_compact],
  };
  return {
    names: [...names],
    hooks: buildExtensionHooks(events, {
      getSessionId: state.sessionId,
      ...(opts.warn ? { warn: opts.warn } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    }),
    tools: [...collector.tools],
    commands: [...collector.commands],
    bindSession: (store: ExtensionSessionStore, sessionId: string): void => {
      binding.store = store;
      binding.sessionId = sessionId;
    },
  };
}

/** Internal: the shared mutable state + collector pair a loader drives. The
 *  closures read the ONE binding box, so bindSession's late write is visible
 *  to every already-handed-out api and hook. */
export function createExtensionState(opts: { readonly version: string; readonly workspaceRoot: string }): {
  state: { version: string; workspaceRoot: string; sessionId: () => string | undefined; store: () => ExtensionSessionStore | undefined };
  binding: ExtensionBinding;
  collector: Collector;
} {
  const binding: ExtensionBinding = {};
  return {
    binding,
    state: {
      version: opts.version,
      workspaceRoot: opts.workspaceRoot,
      sessionId: () => binding.sessionId,
      store: () => binding.store,
    },
    collector: {
      events: {
        run_start: [],
        run_stop: [],
        prompt_submit: [],
        pre_tool_use: [],
        post_tool_use: [],
        pre_compact: [],
        post_compact: [],
      },
      tools: [],
      commands: [],
    },
  };
}
