import { truncateSafe } from "@wudao/core"; // 113-A4
import { splitEndOfOptions, ABLATION_FEATURES } from "./args.js";
// ω99-236: #5 — the doc trio's twelve summaries now ride the doc-suite
// ROSTER (docSuiteSummarizers——名册模块 doc-suite.ts 的摘要器映射，纯件复
// 用原 import，一件一条缝迁入名册). summarizeToolCall 首查映射（命中即
// return——make 三面显式空摘要件，与重构前落 default 的空串逐字节等值），
// 缺席落本件基础 switch。最小 import 面裁定：本件九条 doc import 收拢为
// 一条名册缝（原 per-face 注释链随迁 doc-suite.ts）。
import { docSuiteSummarizers } from "./doc-suite.js";

export type LogLevel = "error" | "info" | "debug";
export const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 };

// Precedence: --debug > --quiet > --log-level <l> > WUDAO_LOG_LEVEL > default "info".
export function parseLogLevel(argv: string[], env: NodeJS.ProcessEnv): LogLevel {
  if (argv.includes("--debug")) return "debug";
  if (argv.includes("--quiet")) return "error";
  const eq = argv.find((a) => a?.startsWith("--log-level="));
  if (eq) {
    const v = eq.slice("--log-level=".length).toLowerCase();
    if (v === "error" || v === "info" || v === "debug") return v;
  }
  const i = argv.indexOf("--log-level");
  const next = i !== -1 ? argv[i + 1] : undefined;
  // Only accept a value token that exists, is non-empty, and is not itself a
  // flag — otherwise `--log-level --auto` would eat `--auto` as the level.
  if (next !== undefined && next !== "" && !next.startsWith("-")) {
    const v = next.toLowerCase();
    if (v === "error" || v === "info" || v === "debug") return v;
  }
  const ev = env.WUDAO_LOG_LEVEL?.toLowerCase();
  if (ev === "error" || ev === "info" || ev === "debug") return ev;
  return "info";
}

// One-line summary of a tool call's key argument, for info-level logging.
export function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  // ω99-236: the doc trio's roster map first (hit → return; the make faces'
  // explicit empty summaries are byte-identical to the old default fall-
  // through), then the base switch.
  const docSuite = docSuiteSummarizers[toolName];
  if (docSuite !== undefined) return docSuite(input);
  const get = (k: string): string => (input[k] === undefined ? "" : String(input[k]));
  switch (toolName) {
    case "shell": return get("command");
    case "read_file": case "write_file": case "edit": return get("path");
    case "glob": case "grep": return get("pattern");
    // M59 §2: the web_fetch ask shows the URL — the domain LEADS, so even a
    // truncated summary keeps it visible (the spec's "提示中带域名").
    case "web_fetch": return get("url");
    case "web_search": return get("query");
    // ω99-219: #1 — 电脑操作六例（212 的六工具此前落进 default 空串：转录
    // 单卡、权限确认、live 行全都是空括号）。动作行=用户可读的动作描述（回
    // 望时读的是「干了什么」）：输入文本前 20 字+「…N 字」、组合键串、
    // (x, y) 坐标、应用名；两个无参工具给固定动作词（全屏/列表）。一处
    // 补例，TUI 转录/权限确认/live 行三前端共用源同时受益（agent-driver
    // 的 o.summarize 缝零改动）。
    // ω99-220: #5 — 补 scroll/drag 两例（同缝同益，driver 仍零改动）。
    // 对象形沿 click 先例（summary 是「动作对象」不是整句——面板短语
    // 「滚动了/拖动了」拼在前）：scroll=方向+像素量（dy 主向、dx 并横滚
    // 顿号并列），drag=(x1, y1)→(x2, y2)。
    case "computer_type": return summarizeTypedText(get("text"));
    case "computer_key": return get("key");
    case "computer_click": {
      const x = input["x"];
      const y = input["y"];
      return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
        ? `(${x}, ${y})` // 与 computer_click 自身回执同格式
        : ""; // 坐标缺席/非数值不编造位置
    }
    case "computer_scroll": return summarizeScroll(input["dy"], input["dx"]);
    case "computer_drag": {
      const { startX, startY, endX, endY } = input;
      return typeof startX === "number" && typeof startY === "number" && typeof endX === "number" && typeof endY === "number"
        && Number.isFinite(startX) && Number.isFinite(startY) && Number.isFinite(endX) && Number.isFinite(endY)
        ? `(${startX}, ${startY})→(${endX}, ${endY})` // 与 click 坐标同格式
        : ""; // 坐标缺席/非数值不编造位置
    }
    case "app_activate": return get("app");
    // ω99-247: #3 — observe 例（对象形沿 click 先例）：带 app=应用名、无参=
    // 前台窗口（面板短语「观察了」拼在前）。
    case "screen_observe": return get("app") !== "" ? get("app") : "前台窗口";
    // ω99-250: #3 — wait 例（对象形沿 observe 先例）：ref 形=[eN]+期望短语
    // （值/标题，20 字内诚实截断）；stable 形=固定「界面稳定」；谓词缺席回退
    // 空串（不编造等待目标）。
    case "computer_wait": {
      if (input["stable"] === true) return "界面稳定";
      const ref = input["ref"];
      if (typeof ref !== "string") return "";
      const v = typeof input["value"] === "string" ? truncate(input["value"], 20) : undefined;
      const t = typeof input["title"] === "string" ? truncate(input["title"], 20) : undefined;
      const cond = v !== undefined ? `值「${v}」` : t !== undefined ? `标题「${t}」` : undefined;
      return cond !== undefined ? `[${ref}] ${cond}` : `[${ref}]`;
    }
    case "screen_capture": return "全屏";
    case "app_list": return "列表";
    // ω99-236: the twelve doc cases (read/append/replace × xlsx/docx/pptx +
    // the make trio's empties) moved to the roster map consulted at the
    // function head — docSuiteSummarizers in doc-suite.ts (对象形注释链随
    // 迁：221/222 读窗、223/228 追加量、229/231 找换对).
    default: return "";
  }
}

/** (ω99-219 #1 续) computer_type 的输入摘要：空白折叠成单行后取前
 *  TYPE_SUMMARY_CHARS 字，超长尾部「…N 字」告知还有多少字没显示（回望行
 *  的诚实截断——量可见，不是无声的「…」）。按码点计数与切片（与工具
 *  自身回执的 Array.from 计数同规则，emoji 不劈半）。 */
const TYPE_SUMMARY_CHARS = 20;
function summarizeTypedText(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  if (chars.length <= TYPE_SUMMARY_CHARS) return collapsed;
  return `${chars.slice(0, TYPE_SUMMARY_CHARS).join("")}…${chars.length - TYPE_SUMMARY_CHARS} 字`;
}

/** (ω99-220 #5) computer_scroll 的对象摘要：方向词 + 像素量（dy 正=向下、
 *  负=向上；dx 正=向右、负=向左——与工具面口径一致）；两轴都有时顿号
 *  并列。非数值/全零不编造——回退空串。 */
function summarizeScroll(dy: unknown, dx: unknown): string {
  const parts: string[] = [];
  if (typeof dy === "number" && Number.isFinite(dy)) {
    if (dy > 0) parts.push(`向下 ${dy} 像素`);
    else if (dy < 0) parts.push(`向上 ${-dy} 像素`);
  }
  if (typeof dx === "number" && Number.isFinite(dx)) {
    if (dx > 0) parts.push(`向右 ${dx} 像素`);
    else if (dx < 0) parts.push(`向左 ${-dx} 像素`);
  }
  return parts.join("、");
}

export function truncate(s: string, n: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > n ? truncateSafe(collapsed, n) + "…" : collapsed;
}

/** ω99-32 T2 — the tool-result preview width. ONE budget feeds every
 *  frontend's `  ↳ ` preview line: the driver builds the TUI transcript's
 *  entry.resultPreview with it (agent-driver.ts, its original home), and the
 *  headless REPL / one-shot render the same-shaped single line at info
 *  level (tui/app.tsx:365 parity). Single source so the TUI transcript and
 *  the headless screen can never drift apart. */
export const RESULT_PREVIEW_CHARS = 200;

// ω99-29 T2 — the multi-line flavor for TOOL-RESULT bodies. truncate()'s
// whitespace collapse is right for one-line previews (notices, permission
// asks — dozens of callers, semantics pinned in tests/log.test.ts), but a
// tool result can be a LINE-ORIENTED payload: mission_complete's receipt
// carries a second line (`技能包（…）将于会话边界卸载`) whose value IS its own
// screen line — the campaign's deterministic grep acceptance could not see
// it through the fold. Same char budget as the folded form; different
// contract: line structure survives. Per-line whitespace trims, blank lines
// drop (structure stays, blank runs don't), and a cut lands on a line
// boundary so truncation never welds two lines into one.
export function truncateMultiline(s: string, maxChars: number): string {
  const lines = s.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  const sliced = truncateSafe(joined, maxChars);
  const lastNl = sliced.lastIndexOf("\n");
  // No full line inside the cut → the single (huge) line truncates inline,
  // exactly like truncate().
  return lastNl === -1 ? `${sliced}…` : `${sliced.slice(0, lastNl)}\n…`;
}

// Remove log-level flags (and --log-level's value) so they don't become part of the prompt.
// Also drops permission-mode flags (--auto, --read-only), the TUI flag (--no-tui),
// the sandbox flag (--sandbox, a mode not a word), and session flags
// (--continue, --list-sessions, and --resume plus its value).

// session flags (--continue, --list-sessions, and --resume plus its value),
// and provider flags (--provider / --reasoning-effort plus their values).
// ω99-22: also the ask-mode flag (--ask), the ablation family (every
// ABLATION_FEATURES member, hyphen/underscore, single/double dash — via the
// imported list, single source), the trust gate (--trust-workspace), and the
// session name (--name + value). The flag-universe pin in tests/args.test.ts
// mechanically enforces that every --flag args.ts parses gains a branch here.
export function stripLogFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--debug" || a === "--quiet") continue;
    if (a === "--auto" || a === "--read-only") continue;
    if (a === "--ask" || a === "-ask") continue; // ω99-22: ask-mode flag leaked into prompts
    if (a === "--no-tui") continue;
    if (a === "--sandbox") continue;
    if (a === "--plan" || a === "-plan") continue;
    if (a === "--fork-session" || a === "-fork-session") continue;
    // ω99-22 R1 — the ablation family, generically and from the single
    // source: parseAblationFlags accepts `-{1,2}no[-_]name` (hyphen/underscore,
    // single/double dash), so EVERY ABLATION_FEATURES member in EVERY spelling
    // is a parsed flag, never a prompt word. T1's literal --no-sidecar entry
    // is subsumed (removed) — a future feature joins the list and is
    // auto-covered here, no bookkeeping. Membership-gated: an UNKNOWN --no-*
    // stays a prompt word (args.ts contract — it may belong to other tooling),
    // and the anchored regex keeps =-suffixed tokens (--no-gates=1) out.
    const ablation = /^-{1,2}no[-_]([a-z_-]+)$/.exec(a);
    if (ablation !== null && ABLATION_FEATURES.some((f) => f === (ablation[1] ?? "").replace(/_/g, "-"))) continue;
    if (a === "--trust-workspace" || a === "-trust-workspace") continue; // ω99-22: alone it must yield an EMPTY prompt (REPL), not a one-shot
    if (a === "--continue" || a === "--list-sessions" || a === "--all" || a === "-all") continue;
    if (a === "--log-level") { i++; continue; } // skip flag + its value
    if (a === "--resume" || a === "-resume") { i++; continue; } // skip flag + its value (single-dash tolerated)
    if (a === "--provider" || a === "-provider") { i++; continue; } // skip flag + its value
    if (a === "--reasoning-effort" || a === "-reasoning-effort") { i++; continue; } // skip flag + its value
    if (a === "--model" || a === "-model") { i++; continue; } // R3-T002: skip flag + its value（显式模型旗标）
    if (a === "--plugin" || a === "-plugin") { i++; continue; } // skip flag + its value
  if (a === "--image" || a === "-image") { i++; continue; } // skip flag + its value (M79)
    if (a === "--name" || a === "-name") { i++; continue; } // skip flag + its value (ω99-22: session name)
    if (a.startsWith("--log-level=")) continue;
    if (a.startsWith("--resume=") || a.startsWith("-resume=")) continue;
    if (a.startsWith("--provider=") || a.startsWith("-provider=")) continue;
    if (a.startsWith("--reasoning-effort=") || a.startsWith("-reasoning-effort=")) continue;
    if (a.startsWith("--model=") || a.startsWith("-model=")) continue; // R3-T002
    if (a.startsWith("--plugin=") || a.startsWith("-plugin=")) continue;
    if (a.startsWith("--image=") || a.startsWith("-image=")) continue; // M79
    if (a.startsWith("--name=") || a.startsWith("-name=")) continue; // ω99-22
    out.push(a);
  }
  return out;
}

// The one-shot/interactive prompt from the exec-relative argv: the pre-`--`
// flag window with every known flag stripped, then every post-`--` positional
// appended verbatim (flag-looking or not). The first bare `--` itself never
// joins the prompt. Without a `--` this is exactly the pre-change composition
// stripLogFlags(args).join(" ").trim() — zero drift.
export function promptFromArgv(args: readonly string[]): string {
  const { flagWindow, positionals } = splitEndOfOptions(args);
  return [...stripLogFlags(flagWindow), ...positionals].join(" ").trim();
}

// Header label for the active model. The default (deepseek) provider keeps the
// bare model name so its output stays byte-stable; other providers are
// disambiguated as "provider · model".
export function modelLabel(config: { provider?: string; model: string }): string {
  return config.provider && config.provider !== "deepseek" ? `${config.provider} · ${config.model}` : config.model;
}

// Token magnitude for the compacted notice, one decimal: 12340 → "12.3k".
export function formatTokensK(n: number): string {
  // 129 弧（OpenHands 8784a5946 同款 bug）：≥999_950 时 k 路径会印出
  // "1000k"/"1050k"（无 M 档——DeepSeek V4 1M 窗下 StatusBar 真可命中）。
  // 阈值 999_950 = k 路径四舍五入到 1000.0k 的确切起点（n/100 进位边界）。
  if (n >= 999_950) return Math.round(n / 100_000) / 10 + "M";
  return Math.round(n / 100) / 10 + "k";
}

// M25 §A4: compacted-notice composition. Tier/trigger are loop-internal
// vocabulary — map them to the words users read; magnitudes ride formatTokensK.
// Shared by the TUI notice entry (use-agent) and the REPL line.
const COMPACTED_TIER_LABEL: Record<number, string> = { 0: "清理", 1: "微压缩", 2: "摘要", 3: "紧急丢弃" }; // ω99-192: #2
const COMPACTED_TRIGGER_LABEL: Record<string, string> = { // ω99-192: #3
  threshold: "调用前",
  boundary: "轮界",
  immediate: "溢出",
  reactive: "溢出", // post-413: headroom was already gone
  "static-fallback": "静态回退", // M47 §5: the LLM summary failed; the deterministic compact answered
  manual: "手动", // M52 §1: the /compact slash command
  "agent-rotation": "模型主动轮转", // 125 项 1: the model asked for a fresh window (new_context)
  emergency: "溢出", // ω-2b (I2-b): the post-compact last-resort head drop
};

/** `♻️ 上下文已压缩 49.8k → 12.1k · 摘要 · 轮界（继续中…）`. */
export function formatCompactedLine(tier: number, trigger: string, beforeTokens: number, afterTokens: number): string {
  const tierWord = COMPACTED_TIER_LABEL[tier] ?? `tier-${tier}`;
  const triggerWord = COMPACTED_TRIGGER_LABEL[trigger] ?? trigger;
  const mag = Number.isFinite(beforeTokens) && Number.isFinite(afterTokens)
    ? `${formatTokensK(beforeTokens)} → ${formatTokensK(afterTokens)}`
    : "";
  return `♻️ 上下文已压缩${mag ? ` ${mag}` : ""} · ${tierWord} · ${triggerWord}（继续中…）`; // ω99-192: #1
}
