// ω99-277: #1 — 会话全文搜索纯层：切换会话弹框的搜索车道。逐行 readline 扫
// <dir>/*.jsonl，原始行子串预滤（先 toLowerCase().includes(q) 再 JSON.parse
// ——解析成本只花在命中行上，MB 级文件键入即查），仅 user/assistant 消息行
// 的可见正文参与匹配；泛型 entry（收据/notice/goal…）、工具行、坏 JSON 行全
// 跳。与 sessions()（collectSessionRows）同用 store.list() 的会话集与
// workspace_root 过滤语义——搜索不该翻出列表不显示的会话。只读，绝不写
// 会话文件。
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao-org/core";
import { firstUserMessage, recordedWorkspaceRoot, sessionNameSource } from "../session-list.js";
import { truncate } from "../log.js";

/** ω99-277 — 一条全文搜索命中：会话身份 + 消息元数据 + 带上下文的摘要行
 * （wire 三镜像：cli 定义、server 透传、web/src/protocol.ts 镜像）。 */
export interface SessionSearchHit {
  readonly sessionId: string;
  /** 会话命名（session_name entry，last-wins；空 = 未命名，web 侧
   * name→firstUser→id8 三级回退拼题）。 */
  readonly name: string;
  /** 同 SessionRow.firstUser 语义（首条真实 user 消息，折叠截 50）。 */
  readonly firstUser: string;
  /** 会话文件 mtime ISO（排序用；JSON 无 Date）。 */
  readonly mtime: string;
  readonly kind: "user" | "assistant";
  /** 命中前后文：±30 字，越界侧加 "…"（原文大小写保真）。 */
  readonly snippet: string;
}

/** 帽：会话内最多命中数 / 总命中数（缺省 5 / 50；total 满即停扫）。 */
export interface SessionSearchCaps {
  readonly perSession?: number;
  readonly total?: number;
}

const DEFAULT_PER_SESSION = 5;
const DEFAULT_TOTAL = 50;
/** 摘要窗口：命中前后各留的字数（越界侧以 "…" 标记）。 */
const SNIPPET_CONTEXT = 30;

/** content 的可见正文：string 直取；数组拼所有 type === "text" 部分的
 * text（其余 part 类型不猜）。其余形状（意外 null 等）按空处理。 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } =>
        typeof p === "object" && p !== null &&
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

/** 命中前后文：在 lowercase 文本里定位命中，取 [max(0,i-30),
 * i+q.length+30)（切片取原文，大小写保真）；左/右越界侧加 "…"。 */
function snippetAround(text: string, qLower: string): string {
  const lower = text.toLowerCase();
  const i = lower.indexOf(qLower);
  // 预滤后理论上必中；不中（q 只出现在行内 JSON 元数据里）不会走到这。
  if (i < 0) return text;
  const start = Math.max(0, i - SNIPPET_CONTEXT);
  const end = Math.min(text.length, i + qLower.length + SNIPPET_CONTEXT);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** 一条命中行的裸形（会话元数据后补）。 */
interface HitRow {
  readonly kind: "user" | "assistant";
  readonly snippet: string;
}

/** 流式扫一个会话文件：原始行预滤 → 只 parse 命中行 → 提取正文 → 复核
 * 正文确实含 q（q 命中的可能只是行内 uuid/键名——那些不算命中）→ 记
 * {kind, snippet}。坏 JSON 行静默跳过（append-only 文件的半行尾写）。
 * perSession 满即停读。 */
async function scanFile(file: string, qLower: string, perSession: number): Promise<HitRow[]> {
  const rows: HitRow[] = [];
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line.toLowerCase().includes(qLower)) continue; // 预滤：解析前
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // 半行尾写 / 损坏行
      }
      if (typeof e !== "object" || e === null || !("role" in e)) continue;
      const role = (e as { role?: unknown }).role;
      if (role !== "user" && role !== "assistant") continue; // 工具行等
      const text = extractText((e as { content?: unknown }).content);
      if (text.trim() === "") continue; // reasoning-only 的 assistant 等
      if (!text.toLowerCase().includes(qLower)) continue; // 命中只在 JSON 元数据
      rows.push({ kind: role, snippet: snippetAround(text, qLower) });
      if (rows.length >= perSession) break;
    }
  } finally {
    rl.close();
  }
  return rows;
}

/** 全文搜索一个 sessions 目录。q trim 后空 → []；目录不存在 → []（store
 * 的 list() 对缺失根返回 []）。会话按 mtime desc（早退帽偏向用户最可能
 * 找的近期会话）；会话内按文件序；perSession 帽 5、total 帽 50 满即停扫。
 * 有命中的会话才付一次全量 entries 加载（metadata + 过滤判定同源
 * session-list；无命中的会话一个字节都不 parse）。 */
export async function searchSessionFiles(
  dir: string,
  q: string,
  opts: { readonly filterWorkspaceRoot?: string } & SessionSearchCaps = {},
): Promise<readonly SessionSearchHit[]> {
  const query = q.trim();
  if (query === "") return [];
  const qLower = query.toLowerCase();
  const perSession = opts.perSession ?? DEFAULT_PER_SESSION;
  const total = opts.total ?? DEFAULT_TOTAL;
  const store = createJsonlSessionStore(dir);
  const ids = await store.list(); // 与 sessions() 同一可见集（含 pet.jsonl）
  if (ids.length === 0) return [];
  // mtime desc 扫描序（store.list() 是 oldest-first；早退帽要偏向新会话）。
  const timed = await Promise.all(ids.map(async (id) => {
    try {
      return { id, t: (await stat(join(dir, `${id}.jsonl`))).mtime.getTime() };
    } catch {
      return { id, t: 0 }; // list 与 stat 之间竞走丢——排最后
    }
  }));
  timed.sort((a, b) => b.t - a.t);
  const hits: SessionSearchHit[] = [];
  for (const { id, t } of timed) {
    const rows = await scanFile(join(dir, `${id}.jsonl`), qLower, perSession);
    if (rows.length === 0) continue;
    // 有命中 → 一次全量加载补会话元数据 + 过滤判定（同 collectSessionRows
    // 语义：记录了不同 root 的会话隐藏；无记录的老文件保持可见）。
    let entries;
    try {
      entries = await store.loadSessionEntries(id);
    } catch {
      continue; // 与命中行竞走的消失/不可读——诚实跳过
    }
    if (opts.filterWorkspaceRoot !== undefined) {
      const recorded = recordedWorkspaceRoot(entries);
      if (recorded !== undefined && recorded !== opts.filterWorkspaceRoot) continue;
    }
    const mtime = new Date(t).toISOString();
    const name = sessionNameSource(entries)?.name ?? "";
    const firstUser = truncate(firstUserMessage(entries) ?? "", 50);
    for (const r of rows) {
      hits.push({ sessionId: id, name, firstUser, mtime, kind: r.kind, snippet: r.snippet });
    }
    if (hits.length >= total) break; // total 帽满即停扫（早退出）
  }
  return hits.slice(0, total);
}
