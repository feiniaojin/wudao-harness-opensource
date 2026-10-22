// 113-A4（the upstream format4ef97b92a9 裁决引进）——UTF-16 代理对安全截断原语。
//
// 问题：`String.prototype.slice` 按 UTF-16 code unit 计数，cap 落在代理对
// 的高位上时会把 emoji / CJK 扩展区字符（𠮷 类，U+20000 起的增补平面）
// 劈成两个孤立代理项——序列化后是无效字符串，下游按 U+FFFD 替换，污染
// stub / 摘要 / 工具结果字节。
//
// 本模块是全仓唯一的文本截断原语（“单一原语”裁决）：一切“把自由文本截
// 到 N”的位点都收编到 truncateSafe / truncateTailSafe，不再手写 slice 帽。
//
// ── M24 契约声明（缓存敏感面）────────────────────────────────────────────
// · 纯函数：同一输入永远同一字节（stub 字节仍是历史的纯函数，resume 可
//   重推导——这是收编的验收断言之一）。
// · ASCII / BMP 输入下与旧 `slice(0, max)` 逐字节一致（幂等、保序）；
//   只有当 cap 恰好劈在增补平面字符的代理对中间时，结果才与旧实现不同
//   ——而旧字节本身是乱码 bug（孤立代理项），这是**行为修正**，不是缓存
//   破坏。改造位点的测试注释里逐处声明了这一点。
// · 只改“截断行为”：不增删任何其他字节，工具/消息结构零触碰。
//
// 不属于本原语管辖的 slice（审计口径，见弧报告）：数组 slice；以真实字
// 符边界（indexOf/lastIndexOf 命中的 \n、空格、冒号等）切分；十六进制
// digest / UUID / ISO 时间戳等 ASCII-by-construction 内容；TUI 光标编辑
// 的列位移；code-point 数组 join（本身已代理对安全）。

/**
 * Head cap that never splits a UTF-16 surrogate pair: the cut starts at
 * `max` code units and backs off one unit when that would sever a pair
 * (judged via `codePointAt` — a combined code point > U+FFFF at the cut
 * means the unit there is a high surrogate whose low half straddles the
 * cut). Pure; ASCII/BMP inputs are byte-identical to `s.slice(0, max)`.
 */
export function truncateSafe(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  const end = (s.codePointAt(max - 1) ?? 0) > 0xffff ? max - 1 : max;
  return s.slice(0, end);
}

/**
 * Tail cap that never starts mid-surrogate-pair: keeps the last `max` code
 * units, dropping a leading lone low surrogate (the high half was cut off).
 * The tail analogue of {@link truncateSafe} — same purity and ASCII/BMP
 * byte-parity contract (`s.slice(-max)` equivalence).
 */
export function truncateTailSafe(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  const start = s.length - max;
  const lead = s.charCodeAt(start);
  return lead >= 0xdc00 && lead <= 0xdfff ? s.slice(start + 1) : s.slice(start);
}
