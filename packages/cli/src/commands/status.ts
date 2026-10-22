// M55 §A2 — /status: the session one-pager. Version, provider/model labels,
// runtime mode, session id, context watermark, and the loaded-surface counts
// (skills / plugins / extensions / MCP tools). Deliberately OFFLINE: no
// connectivity probing by default (the spec's "lazy probe" note) — the
// provider+model line is what a probe would report without spending a
// round-trip. Pure formatting: the driver/REPL assemble the inputs from live
// state, tests pin the shape.
export interface StatusSurfaces {
  readonly skills: number;
  readonly plugins: number;
  readonly extensions: number;
  /** Tools whose name starts with `mcp__` (the MCP lane of the tool set). */
  readonly mcp: number;
  /** Total tools in the session's set (all lanes). */
  readonly tools: number;
}

export interface StatusInput {
  readonly version: string;
  /** Provider label (e.g. "deepseek"); undefined = unknown to this frontend. */
  readonly provider?: string;
  /** Model id (e.g. "deepseek-chat"); undefined = unknown to this frontend. */
  readonly model?: string;
  /** Runtime permission-mode label ("accept" / "ask" / "auto" / "plan" — modeLabel 显示词表). */ // ω99-193: #1
  readonly mode: string;
  readonly sessionId: string;
  /** Context watermark; null before the first model call of the session. */
  readonly ctx: { readonly used: number | null; readonly window: number } | null;
  /** M56 §1: the key pool (`keys n/m`, cooling count). Undefined = this
   *  frontend has no pool to report (single-key historical view). */
  readonly keys?: { readonly total: number; readonly available: number; readonly cooling: number };
  /** ω99-42: the mandatory-reasoning repair armed this session (the endpoint
   *  requires thinking; requests are pre-armed with reasoning enabled —
   *  in-process only). Undefined/absent = never armed, line omitted. */
  readonly reasoningMandatoryPreArmed?: boolean;
  readonly surfaces: StatusSurfaces;
}

function kib(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** The context-watermark line: `12.3k / 64k (19%)`, the unknown form
 *  `… / 64k`, or `（尚未测量）` before the first model call. */ // ω99-193: #2
export function formatCtxLine(ctx: StatusInput["ctx"]): string {
  if (ctx === null) return "（尚未测量）"; // ω99-193: #3
  if (ctx.used === null) return `… / ${kib(ctx.window)}`;
  const pct = ctx.window > 0 ? Math.round((ctx.used / ctx.window) * 100) : 0;
  return `${kib(ctx.used)} / ${kib(ctx.window)} (${pct}%)`;
}

/** The /status one-pager (notice-rendered by every driver frontend). */
export function formatStatusReport(input: StatusInput): string {
  const providerLine = input.provider === undefined && input.model === undefined
    ? "（未知——前端未提供标签）"
    : [input.provider ?? "（未知）", input.model ?? "（未知）"].join(" · "); // ω99-193: #4
  return [
    "状态：", // ω99-193: #5
    `  版本：${input.version}`, // ω99-193: #6
    `  供应商 · 模型：${providerLine}`, // ω99-193: #7；ω99-311: 称谓产品级统一（随 web 310）
    `  模式：${input.mode}`, // ω99-193: #8
    `  会话：${input.sessionId === "" ? "（无）" : input.sessionId}`, // ω99-193: #9
    `  上下文：${formatCtxLine(input.ctx)}`, // ω99-193: #10
    ...(input.keys !== undefined
      ? [`  密钥：${input.keys.available}/${input.keys.total}${input.keys.cooling > 0 ? `（${input.keys.cooling} 个冷却中）` : ""}（WUDAO_API_KEYS 密钥池，轮询 + 60s 429 冷却）`] // ω99-193: #11
      : []),
    // ω99-42: one line, only once the repair actually armed (silent absent).
    ...(input.reasoningMandatoryPreArmed === true
      ? ["  推理：端点要求思考——本会话已预启用（请求自动携带开启）"] // ω99-193: #12
      : []),
    "  连通性：未探测（离线视图——上方为供应商标签，默认不联网）", // ω99-193: #13；ω99-311: 称谓产品级统一（随 web 310）
    `  已加载：${input.surfaces.skills} 个技能 · ${input.surfaces.plugins} 个插件 · ${input.surfaces.extensions} 个扩展 · ${input.surfaces.mcp} 个 MCP 工具 · 共 ${input.surfaces.tools} 个工具`, // ω99-193: #14
  ].join("\n");
}
