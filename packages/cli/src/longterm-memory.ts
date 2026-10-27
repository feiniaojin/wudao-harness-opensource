// M-Memory 弧第二半 — 长期记忆的 cli 装配层（docs/specs/memory-system.md）。
//
// core 纯库（@wudao/core 的 openMemoryStore）承载存储/检索/注入渲染；本模块
// 承载四条接线：
//   ① 工具面 — memory_save / memory_search / memory_forget 三件套（buildTool
//      fail-closed；模型自进化的机制基础）；
//   ② boot 召回注入 — 每会话一次，search(首条真实用户消息, k=8) →
//      renderInjection() 追加到 systemPrompt 尾部（前缀缓存不变量：只追加、
//      前缀字节不动；冻结后整个会话字节稳定）。装配面延迟到首轮 run 边界
//      （onRunStart / runTurn 首次调用——发生在首个模型调用之前，注入块照样
//      进第一个请求，缓存代价与 boot 时刻注入完全相同）；
//   ③ /memory 动词面 — search/save/forget/list/refresh/on/off；旧 M49 动词
//      （del/ok/edit/dream）原样回落（runLongtermMemoryVerb 返回 undefined =
//      旧动词信号）；
//   ④ 会话终了沉淀 — 确定性提炼（无 key 路径）：用户纠正模式扫描 → 保守
//      lesson 候选 → 静默 save。宁缺勿滥（错误记忆比无记忆更糟）。
//
// 与既有 M49 记忆系统（./memory/，.wudao/memory.jsonl）的关系：
//   * 文件分离 — 新库住 <ws>/.wudao/memory/memory.jsonl（子目录）。不与 M49
//     共享 memory.jsonl：M49 的 rewriteAll 记账（bumpHits/markSurfaced 每会话
//     例行发生）按 M49 schema 重写全文件，会把新库的行静默抹掉——共享物理
//     文件 = 例行数据丢失，不可接受。
//   * 工具互斥 — memory_search 工具名两边同名，装配点只可传其一（tools.ts
//     的 buildToolSet 对 memory:+longtermMemory: 同传 fail-closed 拒绝）。驱
//     动装配统一换轨到本模块三件套；M49 的 dream/refine/pending-review 走
//     store 直连，不受影响。
import {
  buildTool,
  openMemoryStore,
  replaceSystemPrompt,
  truncateSafe,
  MEMORY_KINDS,
} from "@wudao/core";
import type {
  AgentHooks,
  AgentMessage,
  AgentState,
  MemoryEntry,
  MemoryKind,
  MemoryStore,
  Tool,
} from "@wudao/core";
import { join } from "node:path";
import { loadLayeredSettings, readGlobalSettingsSync, saveGlobalSettings } from "./settings-layer.js";
import { runMemoryCommand } from "./memory/index.js";

/** boot 召回预算（spec 管线 ③：top-k 注入，k=8）。 */
export const LTS_MEMORY_BOOT_K = 8;
/** /memory list 与 memory_search 的缺省/上限条数。 */
export const LTS_MEMORY_LIST_MAX = 12;
export const LTS_MEMORY_SEARCH_DEFAULT_K = 5;
export const LTS_MEMORY_SEARCH_MAX_K = 20;
/** 会话终了沉淀的每会话条数帽（保守：错误记忆比无记忆更糟）。 */
export const LTS_MEMORY_CAPTURE_MAX_PER_SESSION = 2;
/** 单条 lesson 候选的长度窗（字符）。 */
export const LESSON_MIN_CHARS = 6;
export const LESSON_MAX_CHARS = 120;

// ---------------------------------------------------------------------------
// 存储路径与设置
// ---------------------------------------------------------------------------

/** 新库目录：<ws>/.wudao/memory（memory.jsonl 在其内——与 M49 的
 *  .wudao/memory.jsonl 物理分离，见模块头注）。 */
export function longtermMemoryDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", "memory");
}

export function openLongtermMemoryStore(workspaceRoot: string): MemoryStore {
  return openMemoryStore(longtermMemoryDir(workspaceRoot));
}

/** 分层设置节点 memory.enabled（缺省 on；junk 读取=缺省+警告，misc 家族姿势
 *  ——与 M49 的扁平键 memoryEnabled 是两个不同的键，互不影响）。 */
export function longtermMemoryEnabledFromNode(
  node: unknown,
  warn: (m: string) => void = () => {},
): boolean {
  if (node === undefined) return true;
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    warn('⚠️ settings: "memory" must be an object like {"enabled": true}; using the default (on)');
    return true;
  }
  const enabled = (node as Record<string, unknown>)["enabled"];
  if (enabled === undefined) return true;
  if (typeof enabled === "boolean") return enabled;
  warn('⚠️ settings: "memory.enabled" must be a boolean; using the default (on)');
  return true;
}

/** boot 路径一把读：layered settings → memory.enabled。 */
export async function longtermMemoryEnabledFor(workspaceRoot: string): Promise<boolean> {
  const layered = await loadLayeredSettings(workspaceRoot, () => {});
  return longtermMemoryEnabledFromNode(layered.effective["memory"]);
}

// ---------------------------------------------------------------------------
// ① 工具面（buildTool fail-closed）
// ---------------------------------------------------------------------------

function sanitizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim().toLowerCase()))].slice(0, 8);
}

/** memory_save — 模型侧自进化入口。非只读（权限管线全量过）。 */
export function createLongtermMemorySaveTool(store: MemoryStore): Tool {
  return buildTool({
    name: "memory_save",
    description:
      "Save a durable long-term memory (kind: fact | preference | lesson | skill) to the workspace store (.wudao/memory/memory.jsonl). Re-saving identical content strengthens it (useCount+1) instead of duplicating. Keep one self-contained fact/preference/lesson/skill per call; never include secrets.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Entry kind.", enum: [...MEMORY_KINDS] },
        text: { type: "string", description: "The memory itself (one self-contained statement; ≤2000 chars)." },
        tags: { type: "array", description: "Short lowercase tags aiding recall (≤8).", items: { type: "string" } },
      },
      required: ["kind", "text"],
      additionalProperties: false,
    },
    async execute(args) {
      const kind = (MEMORY_KINDS as readonly string[]).includes(args.kind as string) ? (args.kind as MemoryKind) : undefined;
      if (kind === undefined) {
        return { content: `memory_save failed: kind must be one of ${MEMORY_KINDS.join("|")}`, isError: true };
      }
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (text === "") return { content: "memory_save failed: text must be a non-empty string", isError: true };
      try {
        const entry = await store.save({ kind, text, tags: sanitizeTags(args.tags) });
        return entry.isNew
          ? { content: `memory saved: ${entry.id} [${entry.kind}]` }
          : { content: `memory strengthened: ${entry.id} (useCount ${entry.useCount} — identical content already known)` };
      } catch (err) {
        return { content: `memory_save failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

function formatMemoryRows(entries: readonly MemoryEntry[]): string {
  return entries.map((e) => `${e.id} [${e.kind}] ${truncateSafe(e.text, 200)}${e.tags.length > 0 ? ` (tags: ${e.tags.join(", ")})` : ""} [used ${e.useCount}]`).join("\n");
}

/** memory_search — 只读检索（也是子 agent 集里唯一的记忆工具）。 */
export function createLongtermMemorySearchTool(store: MemoryStore): Tool {
  return buildTool({
    name: "memory_search",
    description:
      "Search the workspace long-term memory store (.wudao/memory/memory.jsonl) by lexical overlap. Recall requires lexical contact; recency and useCount only rank hits. Returns id/kind/text/tags rows. Read-only.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query; CJK and latin both supported." },
        k: { type: "number", description: `Max entries to return (1-${LTS_MEMORY_SEARCH_MAX_K}; default ${LTS_MEMORY_SEARCH_DEFAULT_K}).` },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args) {
      const query = typeof args.query === "string" ? args.query : "";
      if (query.trim() === "") return { content: "memory_search failed: query must be a non-empty string", isError: true };
      const rawK = typeof args.k === "number" ? args.k : LTS_MEMORY_SEARCH_DEFAULT_K;
      const k = Number.isFinite(rawK) ? Math.min(Math.max(Math.round(rawK), 1), LTS_MEMORY_SEARCH_MAX_K) : LTS_MEMORY_SEARCH_DEFAULT_K;
      const hits = store.search(query, { k });
      if (hits.length === 0) return { content: `(no long-term memories match "${truncateSafe(query, 80)}")` };
      return { content: formatMemoryRows(hits) };
    },
  });
}

/** memory_forget — 逻辑删除（tombstone 追加，历史字节不动）。 */
export function createLongtermMemoryForgetTool(store: MemoryStore): Tool {
  return buildTool({
    name: "memory_forget",
    description:
      "Forget one long-term memory by id (memory_search /memory list show ids). The store is append-only: this appends a tombstone line, never rewrites history. Outdated-but-harmless memories are fine to keep — forget is for wrong or harmful entries.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The entry id to forget." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(args) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (id === "") return { content: "memory_forget failed: id must be a non-empty string", isError: true };
      try {
        await store.forget(id);
        return { content: `memory forgotten: ${id}` };
      } catch (err) {
        return { content: `memory_forget failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

export interface LongtermMemoryToolsOptions {
  readonly store: MemoryStore;
  /** true → 只读子集（仅 memory_search——子 agent 永不写记忆，M49 同界）。 */
  readonly readOnly?: boolean;
}

/** 工具三件套（readOnly = 子 agent 只读拼法）。 */
export function createLongtermMemoryTools(opts: LongtermMemoryToolsOptions): Tool[] {
  return opts.readOnly === true
    ? [createLongtermMemorySearchTool(opts.store)]
    : [createLongtermMemorySaveTool(opts.store), createLongtermMemorySearchTool(opts.store), createLongtermMemoryForgetTool(opts.store)];
}

// ---------------------------------------------------------------------------
// ② 召回注入 runtime（每会话一个；冻结语义 = 缓存不变量）
// ---------------------------------------------------------------------------

/** state.messages 里第一条「真实」用户消息（跳过 [合成] 标记与 / 命令——
 *  tools.ts getTaskStatement 同款判据）。 */
export function firstGenuineUserText(messages: readonly AgentMessage[]): string | undefined {
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content !== "string") continue;
    const t = m.content.trim();
    if (t === "" || t.startsWith("[") || t.startsWith("/")) continue;
    return t;
  }
  return undefined;
}

export interface LongtermMemoryRuntime {
  readonly store: MemoryStore;
  readonly enabled: boolean;
  /** 已冻结的注入块（未冻结/空 = ""）——rescan 重建 prompt 尾缀的单一真值点。 */
  block(): string;
  /** 尾缀追加（块空 → base 原样；非空 → base + "\n\n" + 块）。两个 buildSystemPrompt
   *  装配点（boot 与 rescan）共用本函数 = 注入块在两个位点字节一致。 */
  appendTo(base: string): string;
  /** 首轮注入缝：冻结 + 尾缀追加（replaceSystemPrompt——唯一合法重写缝，
   *  追加语义满足「前缀字节不变」契约）。幂等；无种子不冻结（下轮重试）。
   *  装配点：driver onRunStart（engine）/ runTurn 首次（REPL）/ state 构造后
   *  （one-shot——prompt 已在 messages 里）。 */
  injectAtFirstRun(state: AgentState): void;
  /** /memory refresh：重算冻结块；state 在场且尾缀匹配 → 轮界换尾（显式
   *  命令 = 已声明的缓存代价；前缀字节不变断言同 inject）。 */
  refresh(state: AgentState | undefined): string;
  /** 会话终了确定性沉淀（管线 ②：保守规则 + 静默 save；失败静默）。 */
  captureAtSessionEnd(input: { readonly sessionId: string; readonly messages: readonly AgentMessage[] }): Promise<void>;
}

export async function createLongtermMemoryRuntime(args: {
  readonly workspaceRoot: string;
  /** 显式覆盖（测试/装配点已持 layered effective 时用；缺席 → 读分层设置）。 */
  readonly enabled?: boolean;
}): Promise<LongtermMemoryRuntime> {
  const enabled = args.enabled ?? (await longtermMemoryEnabledFor(args.workspaceRoot));
  const store = openLongtermMemoryStore(args.workspaceRoot);
  // 冻结三态：undefined = 未冻结（下轮可再试）；"" = 冻结为空（无命中，永不注
  // 入）；非空 = 冻结块（整个会话字节稳定）。
  let frozen: string | undefined;
  let seedText: string | undefined;

  const computeBlock = (seed: string | undefined): string => {
    if (!enabled) return "";
    const query = seed ?? "";
    const hits = store.search(query, { k: LTS_MEMORY_BOOT_K });
    return store.renderInjection(hits);
  };

  return {
    store,
    enabled,
    block: () => frozen ?? "",
    appendTo(base: string): string {
      const b = frozen ?? "";
      return b === "" ? base : `${base}\n\n${b}`;
    },
    injectAtFirstRun(state: AgentState): void {
      if (!enabled || frozen !== undefined) return;
      const seed = firstGenuineUserText(state.messages);
      if (seed === undefined) return; // 无真实用户消息——不冻结，下轮重试
      seedText = seed;
      frozen = computeBlock(seed);
      if (frozen !== "") replaceSystemPrompt(state, `${state.systemPrompt}\n\n${frozen}`);
    },
    refresh(state: AgentState | undefined): string {
      if (!enabled) return "长期记忆已关闭（/memory on 开启后重启会话生效）";
      const previous = frozen ?? "";
      frozen = computeBlock(seedText);
      let applied = frozen === "" ? "（无命中记忆——注入块为空）" : "";
      if (state !== undefined) {
        if (previous !== "" && state.systemPrompt.endsWith(`\n\n${previous}`)) {
          const base = state.systemPrompt.slice(0, state.systemPrompt.length - `\n\n${previous}`.length);
          replaceSystemPrompt(state, frozen === "" ? base : `${base}\n\n${frozen}`);
          applied = "已换尾注入（显式命令——本会话下一次模型调用起前缀缓存重暖一次，即已声明的缓存代价）";
        } else if (previous === "" && frozen !== "") {
          replaceSystemPrompt(state, `${state.systemPrompt}\n\n${frozen}`);
          applied = "已尾缀注入（此前未注入过——下一次模型调用起生效）";
        } else {
          applied = frozen === "" ? "（无命中记忆——注入块为空）" : "已更新冻结块；当前提示词尾缀不匹配（rescan 后）——下次会话生效";
        }
      }
      return `长期记忆注入块已重算${applied === "" ? "" : `：${applied}`}`;
    },
    async captureAtSessionEnd(input) {
      if (!enabled) return;
      const texts: string[] = [];
      for (const m of input.messages) {
        if (m.role !== "user" || typeof m.content !== "string") continue;
        texts.push(m.content);
      }
      for (const lesson of extractLessonCandidates(texts)) {
        try {
          await store.save({ kind: "lesson", text: lesson, tags: ["auto"], sourceSession: input.sessionId });
        } catch {
          /* 静默——沉淀失败绝不影响会话收尾 */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 进程内单例（probe.ts 的 setTerminalHistorySink 同款先例）：命令道（driver
// 的 /memory dispatch 与 REPL 执行器）与 REPL 的注入/重建位点经它取本会话
// runtime，避免往 AgentDriverOptions/types 穿新针。每会话装配时 set（后写
// 覆盖——engine 换会话/one-shot 每 run 各自换装）。
// ---------------------------------------------------------------------------
let sessionRuntime: LongtermMemoryRuntime | undefined;

export function setLongtermMemoryRuntime(rt: LongtermMemoryRuntime | undefined): void {
  sessionRuntime = rt;
}

export function longtermMemoryRuntimeFor(): LongtermMemoryRuntime | undefined {
  return sessionRuntime;
}

/** engine 驱动 hooks 的注入包裹（driver 专属——agents.hooks 保持原样：子
 *  agent 的 loop 不该触发主会话注入，子状态有子 prompt）。fresh.hooks 同款
 *  包裹保证 extension swap 后缝仍在。 */
export function withFirstRunMemoryInjection(hooks: AgentHooks | undefined, rt: LongtermMemoryRuntime): AgentHooks {
  const mine = (state: AgentState): void => {
    rt.injectAtFirstRun(state);
  };
  return hooks === undefined
    ? { onRunStart: mine }
    : { ...hooks, onRunStart: async (state: AgentState) => { mine(state); await hooks.onRunStart?.(state); } };
}

// ---------------------------------------------------------------------------
// ④ 会话终了沉淀 — 确定性提炼（保守规则，精确描述随常量走）
// ---------------------------------------------------------------------------

/**
 * 祈使式纠正（self-contained：去掉引导词后剩下的本身就是一条完整指令）。
 * 最长前缀优先匹配；余文去引导标点后须落在长度窗内。
 */
export const LESSON_IMPERATIVE_MARKERS: readonly string[] = [
  "别再", "不要再", "以后不要", "以后别", "以后记得", "以后要", "记住",
];
/**
 * 纠错式（任务点名的「不对 / 应该是」族）：余文去掉引导词后通常是正确做法
 * 的陈述（「先跑测试再提交」）。门槛比祈使式高（≥8 字），因为裸纠错的余文
 * 更容易缺上下文。
 */
export const LESSON_CORRECTIVE_MARKERS: readonly string[] = [
  "不对，是", "不是，是", "不对", "不是", "应该是", "应该",
];

/**
 * 纯函数：用户消息 → lesson 候选。保守规则（宁缺勿滥——错误记忆比无记忆更糟）：
 *   1. 逐条 trim；空串 / [合成] 开头 / / 命令 → 跳过；
 *   2. 祈使式标记（别再/不要再/以后不要/以后别/以后记得/以后要/记住）最长前缀
 *      优先；余文去首部 ：:，,、与空白后，长度 ∈ [LESSON_MIN_CHARS(6),
 *      LESSON_MAX_CHARS(120)]、单行、不以 ?/？ 结尾 → 接受，lesson 文本=余文
 *      （逐字，不重写——无 key 路径不编造）；
 *   3. 否则纠错式标记（不对，是/不是，是/不对/不是/应该是/应该）同法，但最短
 *      长度 8（裸纠错余文更易缺上下文）；
 *   4. 批内去重（逐字）；
 *   5. 取前 cap 条（会话内最早的纠正——通常是该会话最根本的指示）。
 */
export function extractLessonCandidates(
  texts: readonly string[],
  cap: number = LTS_MEMORY_CAPTURE_MAX_PER_SESSION,
): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    if (out.length >= cap) break;
    const text = raw.trim();
    if (text === "" || text.startsWith("[") || text.startsWith("/")) continue;
    if (text.includes("\n")) continue; // 多段长文不是一条 lesson
    const rest = stripMarker(text, LESSON_IMPERATIVE_MARKERS, LESSON_MIN_CHARS)
      ?? stripMarker(text, LESSON_CORRECTIVE_MARKERS, 8);
    if (rest === undefined || seen.has(rest)) continue;
    seen.add(rest);
    out.push(rest);
  }
  return out;
}

function stripMarker(text: string, markers: readonly string[], minChars: number): string | undefined {
  // 最长前缀优先（「不对，是」先于「不对」；「不要再」先于「别再」防误切）。
  const sorted = [...markers].sort((a, b) => b.length - a.length);
  for (const marker of sorted) {
    if (!text.startsWith(marker)) continue;
    const rest = text.slice(marker.length).replace(/^[：:，,、\s]+/, "");
    if (rest.endsWith("?") || rest.endsWith("？")) return undefined; // 疑问句不是教训（尾判先于尾剥——剥了就再也判不出）
    const lesson = rest.replace(/[。.！!？?\s]+$/, "");
    if (lesson.length < minChars || lesson.length > LESSON_MAX_CHARS) return undefined;
    return lesson;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ③ /memory 动词面（新动词；undefined = 旧动词 → 调用方回落 M49）
// ---------------------------------------------------------------------------

function usageLine(): string {
  return "用法：/memory [list|search <q>|save <kind> <text>|forget <id>|refresh|on|off]（旧面：del <id> / ok <id> / edit / dream）——kind ∈ fact|preference|lesson|skill";
}

/** 新动词执行器。返回 undefined = 不是新动词（调用方回落 M49 的
 *  runMemoryCommand——del/ok/edit/dream 与未来旧动词原样保留）。永不 throw。 */
export async function runLongtermMemoryVerb(args: {
  readonly workspaceRoot: string;
  readonly verbArgs: string;
  readonly runtime?: LongtermMemoryRuntime;
  readonly state?: AgentState;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const trimmed = args.verbArgs.trim();
  const verb = trimmed.split(/\s+/)[0] ?? "";
  const rest = trimmed.slice(verb.length).trim();
  if (verb === "" || verb === "del" || verb === "ok" || verb === "edit" || verb === "dream") return undefined;
  // runtime 在场 → 用它的 store 句柄（会话内单一实例——core store 是 per-handle
  // 索引，两个句柄互相看不见对方的行；命令道与工具道必须共一个索引）。
  const store = args.runtime?.store ?? openLongtermMemoryStore(args.workspaceRoot);
  if (verb === "list") {
    const rows = formatMemoryRows(store.list().slice(0, LTS_MEMORY_LIST_MAX));
    const mine = rows === "" ? "（长期记忆为空——memory_save 或会话终了沉淀会写入 .wudao/memory/memory.jsonl）" : rows;
    const legacy = await runMemoryCommand(args.workspaceRoot, "list").catch(() => "(旧记忆系统读取失败)");
    return [`长期记忆（M-Memory — .wudao/memory/memory.jsonl）：`, mine, "", "—— 旧记忆系统（M49 — .wudao/memory.jsonl）——", legacy].join("\n");
  }
  if (verb === "search") {
    if (rest === "") return "用法：/memory search <query>";
    const hits = store.search(rest, { k: LTS_MEMORY_SEARCH_DEFAULT_K });
    return hits.length === 0 ? `(没有匹配 "${truncateSafe(rest, 80)}" 的长期记忆)` : formatMemoryRows(hits);
  }
  if (verb === "save") {
    const kind = rest.split(/\s+/)[0] ?? "";
    const text = rest.slice(kind.length).trim();
    if (!(MEMORY_KINDS as readonly string[]).includes(kind) || text === "") {
      return `用法：/memory save <kind> <text>——kind ∈ ${MEMORY_KINDS.join("|")}`;
    }
    try {
      const entry = await store.save({ kind: kind as MemoryKind, text });
      return entry.isNew
        ? `已存入长期记忆：${entry.id} [${entry.kind}]`
        : `已强化既有记忆：${entry.id}（useCount ${entry.useCount}——同内容已知）`;
    } catch (err) {
      return `⚠️ 长期记忆写入失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (verb === "forget") {
    if (rest === "") return "用法：/memory forget <id>";
    try {
      await store.forget(rest);
      return `已遗忘：${rest}`;
    } catch (err) {
      return `⚠️ 遗忘失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (verb === "refresh") {
    const rt = args.runtime;
    if (rt === undefined) return "用法：/memory refresh——本会话未装配长期记忆 runtime";
    return rt.refresh(args.state);
  }
  if (verb === "on" || verb === "off") {
    const enabled = verb === "on";
    try {
      const env = args.env ?? process.env;
      const global = readGlobalSettingsSync(env);
      const node = global["memory"];
      const merged = { ...(typeof node === "object" && node !== null && !Array.isArray(node) ? (node as Record<string, unknown>) : {}), enabled };
      await saveGlobalSettings({ ...global, memory: merged }, env);
      return `长期记忆已${enabled ? "开启" : "关闭"}——下次会话生效（boot 读取 memory.enabled；本会话状态不变）`;
    } catch (err) {
      return `⚠️ 设置写入失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return usageLine();
}
