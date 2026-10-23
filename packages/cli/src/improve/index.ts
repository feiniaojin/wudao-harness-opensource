// 永续 v6 wave2（reef C1）——门控自改进闭环的门面。分层：store=版本化
// 发布面+状态机；trigger=第一道人工门的触发器；propose=fresh-child 提案器
// （screen+门禁编排）；gate=门禁子进程运行器。与 Dream/refine 的分工：
// 它们精化「记忆」（陈述性知识），本弧发布「行为变更」（.wudao/rules/
// 车道的规则文本）——两道人工门（offered 同意、gated 激活）+ 配对回放门
// 是它区别于记忆面的构成性护栏。
export * from "./store.js";
export * from "./trigger.js";
export * from "./propose.js";
export * from "./gate.js";
