// 129 弧（DeepCode e6124ade 引进）——注入框架的闭合标签中和。
//
// 问题：harness 用 XML 形框架（<monitor_event>…</monitor_event>）包裹不可信
// 数据（被监视进程的输出）注入模型上下文。被监视进程只需在输出里打印
// `</monitor_event>`（或 `</monitor_event >`/`</MONITOR_EVENT>`/自闭合变体）
// 即可提前关闭可信框架，其后的内容脱离「data, not instructions」语境；反向
// 打印开标签则可伪造框架让自己的指令看起来受信。
//
// 修法：载荷嵌入前，把目标标签的开/闭/自闭合一切拼写（大小写与空白容忍）
// 的尖括号替换为形近字符（‹›）——标签失去框架语义，载荷文本保持可读，
// 正常代码输出里的其它尖括号零接触（只替换命中标签自身）。
//
// 一切未来携带不可信载荷的标签框架都应走这里（超越点：通用件，非
// monitor 专属补丁）。

/** 中和 `text` 里 `tag` 的一切开/闭/自闭合拼写（大小写与空白容忍）。
 * 命中片段的 `<`/`>` 替换为 ‹/›；未命中原样返回（同一字符串引用语义
 * 不承诺，调用方按返回值用）。 */
export function neutralizeFrameTag(text: string, tag: string): string {
  // tag 是 harness 自己的标识符（[a-z0-9_-]+），不需转义；\b 防前缀标签
  // （frame vs frame_x）误吞。
  const re = new RegExp(`<\\s*/?\\s*${tag}\\b[^>]*>`, "gi");
  return text.replace(re, (m) => m.replace(/</g, "‹").replace(/>/g, "›"));
}
