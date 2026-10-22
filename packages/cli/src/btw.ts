// 夜移 014 — /btw 缓存共享旁问（真 the upstream formatsideQuestion.ts + forkedAgent.ts 的
// wudao 适配）。共享常量与信封：driver（TUI/web/desktop）与 REPL 两条 lane
// 用同一份，保证两个前端的 fork 请求字节一致。
//
// 契约：旁问 fork 与主会话共享前缀字节——systemPrompt、消息前缀、工具列表
// 全同，唯一差异是尾部追加的旁问 user 消息——因此命中主会话的前缀缓存，
// 旁问近乎免费。答案只回给调用方（driver notice / REPL stdout），永不进入
// 主历史。运行中可用：旁问的全部意义就是不打断。

/** The side lane's query-source marker. The title lane's TITLE_QUERY_SOURCE
 *  is the inverse cousin — title shares ZERO prefix with the session, btw
 *  shares ALL of it; both must stay distinguishable in logs/telemetry so
 *  cache-hit accounting attributes them correctly. */
export const BTW_QUERY_SOURCE = "btw";

/** The side answer's output budget — a side answer is short by design; the
 *  cap keeps a runaway generation from eating the lane. */
export const BTW_MAX_TOKENS = 1024;

/** The pure-suffix user message the btw fork appends. The envelope tells the
 *  model this is a side lane: answer directly and briefly from the existing
 *  context, never start main-session work here, and do not call tools (tools
 *  ARE sent for prefix-cache byte-stability — ω99-316's same-table freeze —
 *  but their execute returns a structured frozen error). */
export function buildBtwEnvelope(question: string): string {
  return `<side_question>\n[旁问] ${question}\n\n（旁路提问：不打断主任务、不进入主对话。这是旁路问答——只依据已有上下文回答，不要从这里启动主会话工作；旁路中工具冻结，请直接、简短地回答——通常几句话即可。）\n</side_question>`;
}
