// M60 §2 — the md → Slack mrkdown conversion for summary post-backs. Slack's
// mrkdown is NOT markdown: no headers, `*bold*` (not `**`), `_italic_`, links
// are `<url|text>` (not `[text](url)`), no tables. This is deliberately a
// ROUGH, line-oriented conversion (spec: "md 转 Slack mrkdown 粗转换") —
// deterministic, no dependencies, tuned for the model's final-answer style
// (headers, bold, lists, fenced code, links).

/** Escape Slack's mrkdwn control characters on a RAW line (F4, review):
 *  `&` `<` `>` pass through raw would let relayed model output post as REAL
 *  Slack syntax — `<!channel>`/`<!here>` broadcasts, `<@U…>` user mentions.
 *  Slack decodes `&amp;` `&lt;` `&gt;` back to literals, so escaped text
 *  renders verbatim. Applied BEFORE conversion so the converter's OWN
 *  `<url|text>` output is never double-escaped. Exported: the ask blocks
 *  escape their model-controlled summary through the same rule. */
import { truncateSafe } from "@wudao-org/core";

export function escapeMrkdownEntities(line: string): string {
  return line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert a markdown document to Slack mrkdown (pure, deterministic). */
export function mdToMrkdown(md: string): string {
  const lines = md.split("\n");
  let inFence = false;
  const out = lines.map((line) => {
    // Fence state: a line of 3+ backticks toggles; fenced lines pass through
    // VERBATIM (their ** and _ are code, not markup — and mentions inside
    // code blocks never trigger, so no escaping needed there).
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return convertLine(escapeMrkdownEntities(line));
  });
  return out.join("\n");
}

function convertLine(line: string): string {
  // Fenced code blocks pass through untouched (mrkdown supports ``` blocks);
  // the fence STATE is tracked by the caller-level pass below.
  return convertInline(convertStructure(line));
}

/** Structural, line-level rewrites. */
function convertStructure(line: string): string {
  // ATX headers → bold (mrkdown has no headers).
  const header = /^(#{1,6})\s+(.*)$/.exec(line);
  if (header?.[2] !== undefined) return `*${header[2].trim()}*`;
  // Horizontal rules → an em dash spacer.
  if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) return "—";
  // Bullet markers: `- `/`+ `/`* ` → `• ` (keep indentation).
  const bullet = /^(\s*)[-+*]\s+(.*)$/.exec(line);
  if (bullet?.[2] !== undefined) return `${bullet[1]}• ${bullet[2]}`;
  return line;
}

/** Inline rewrites. Order matters: links first (so their parens/brackets are
 *  consumed before emphasis touches them), then bold, then italic. */
function convertInline(text: string): string {
  let s = text;
  // Images ![alt](url) → <url|alt>
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => `<${url}|${alt !== "" ? alt : url}>`);
  // Links [text](url) → <url|text>
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<${url}|${label}>`);
  // Bold **x** / __x__ → *x*
  s = s.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  s = s.replace(/__([^_]+)__/g, "*$1*");
  // Italic _x_ (single, word-bounded) → _x_ is already mrkdown; leave as-is.
  // Strikethrough ~~x~~ is mrkdown-native; leave as-is.
  return s;
}

/** Truncate a summary for Slack post-back: hard cap + an explicit marker so
 *  a cut answer is visible, never silent (spec §2: ≤3000 chars).
 *  113-A4：截断帽代理对安全（emoji/CJK 扩展字符不劈半）。 */
export function truncateSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${truncateSafe(text, Math.max(0, maxChars - 20))}\n…(截断,全文 ${text.length} 字符)`;
}

/** Truncate the thread-context digest the same way (spec §2: ≤
 *  threadContextMaxChars, 超出截断标注). 113-A4：同上代理对安全。 */
export function truncateThreadContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${truncateSafe(text, Math.max(0, maxChars - 40))}\n…[线程上下文截断:原始 ${text.length} 字符,仅保留最近 ${Math.max(0, maxChars - 40)} 字符]`;
}
