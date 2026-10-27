// 通知变体制（DESIGN-SYSTEM §6.4 / Phase 2 ①）——语义（警示/成功/陈述）由
// 通知**变体**承担（语义色 + 前导 SVG 细线字形），不由文案位图 emoji 承担。
//
// 为什么在**渲染面**识别而不是改 ~100 个调用点：notify 的单一 string 形态是
// 贯穿 views/notes/回执管线的线格式（omega99-202/204 等源钉测试锁死了
// `` notify(`⚠️ X 失败：${…}`) `` 的前缀+插值形），前缀本身就是变体信号——
// 它在运行时随文本流到渲染面，在这里被剥离并翻译成变体，用户永远看不到
// 位图 emoji。attachments.ts / pet-drop.ts 等运行时拼 `⚠️ …` 的来源同走此径。
//
// **新代码不要再写 ⚠️/✅/ℹ️ 前缀**：语气走渲染面的变体（本模块）；确需
// 显式声明的位点，扩展 notify 的 variant 参数（届时本模块的识别退为兜底）。

/** 三态变体：warn=警示（琥珀）、ok=成功回执（绿）、info=陈述（中性，缺省）。 */
export type NoticeVariant = "info" | "ok" | "warn";

/** 识别结果：变体 + 剥离前缀后的正文。 */
export interface ClassifiedNotice {
  readonly variant: NoticeVariant;
  readonly text: string;
}

// 前缀字形 → 变体。⚠(U+26A0)/ℹ(U+2139) 可带可不带变体选择符 U+FE0F（源码
// 里两种写法都出现过）；前缀后的分隔空白一并剥掉（居中胶囊不留半空格）。
// ⚠→warn、✅(U+2705)→ok、ℹ→info（=缺省态，仅剥字形）。
const PREFIX_TO_VARIANT: ReadonlyArray<readonly [NoticeVariant, RegExp]> = [
  ["warn", /^⚠️?\s*/u],
  ["ok", /^✅\s*/u],
  ["info", /^ℹ️?\s*/u],
];

/**
 * 纯函数：识别并剥离通知文本的前导 emoji 前缀。
 * 纯文本（无前缀）原样返回、变体 info；⚠️ 出现在句中（非前导）不动。
 */
export function classifyNotice(text: string): ClassifiedNotice {
  for (const [variant, prefix] of PREFIX_TO_VARIANT) {
    if (prefix.test(text)) return { variant, text: text.replace(prefix, "") };
  }
  return { variant: "info", text };
}
