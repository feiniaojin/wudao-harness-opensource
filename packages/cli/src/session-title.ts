// 夜移 005（2026-08-28 night porting，the upstream formatsession-title port，设计加强）：
// 会话自动命名的纯函数层。the upstream format的 purpose=session-title 思路：一个独立的
// 小型模型调用给会话起人类可读标题 —— 不进主转录、不改任何前缀字节（独立
// system prompt，与主会话的 KV 前缀毫无共享）、思考开最低档、输出封顶。
// 加强点：source 三态（derived/manual/llm）保证手动 /rename 永不被覆盖；
// 标题净化按码点截断（CJK 安全）；querySource:"title" 走后台调用退让阶梯
//（容量故障立即放弃、不重试 —— 静默回退派生名）。
import { truncateSafe } from "@wudao/core"; // 113-A4
import type { AgentMessage } from "@wudao/core";

/** Rides ModelInput.querySource — must stay in the provider retry ladder's
 *  background allowlist (bail-on-overload, no retries). */
export const TITLE_QUERY_SOURCE = "title";
/** Title length cap, in Unicode code points (CJK-safe — never splits a
 *  surrogate pair). */
export const TITLE_MAX_CODEPOINTS = 24;
/** Per-excerpt cap: the title call must stay tiny. */
const EXCERPT_CHARS = 800;
/** On-wire discriminator: querySource never serializes into the HTTP body,
 *  so fakes/tests identify the background title call by its standalone
 *  system prompt's first line. */
export const TITLE_SYSTEM_FIRST_LINE = "You name chat sessions. Reply with ONLY the title:";

/** Pure: clean a raw model title reply into a storable name — strip wrapping
 *  quotes/backticks/brackets, collapse all whitespace to one line, drop
 *  trailing sentence punctuation, cap in code points. Undefined when nothing
 *  usable remains (caller keeps the previous name). */
export function sanitizeTitle(raw: string): string | undefined {
  let t = raw.trim();
  t = t.replace(/^[`"“”'「『（(\[]+/, "").replace(/[`"“”'」』）)\]]+$/, "").trim();
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/[.。!！?？…]+$/, "").trim();
  if (t.length === 0) return undefined;
  const cps = Array.from(t);
  return (cps.length <= TITLE_MAX_CODEPOINTS ? cps : cps.slice(0, TITLE_MAX_CODEPOINTS)).join("");
}

/** Pure: build the standalone title request from the conversation's first
 *  exchange. Undefined when no assistant answer exists yet (nothing to title
 *  from — an interrupted or failed first run keeps the derived name). */
export function buildTitleRequest(
  messages: readonly AgentMessage[],
): { systemPrompt: string; user: string } | undefined {
  const firstUser = messages.find((m) => m.role === "user");
  const firstAssistant = messages.find((m) => m.role === "assistant");
  if (firstUser === undefined || firstAssistant === undefined) return undefined;
  const clip = (s: unknown): string =>
    typeof s === "string" ? (s.length > EXCERPT_CHARS ? `${truncateSafe(s, EXCERPT_CHARS)}…` : s) : "";
  const systemPrompt = [
    TITLE_SYSTEM_FIRST_LINE,
    `- at most ${TITLE_MAX_CODEPOINTS} characters, no quotes, no trailing punctuation`,
    "- in the primary language of the user's message below",
    "- a specific, human-readable summary of what the conversation is about (not a greeting)",
  ].join("\n");
  const user = `user: ${clip(firstUser.content)}\nassistant: ${clip(firstAssistant.content)}`;
  return { systemPrompt, user };
}
