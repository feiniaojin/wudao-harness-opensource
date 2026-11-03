// 132-P1-2（deepagents 60c0228aa 引进）— context_doctor：注入账单。
//
// 问题：长会话里模型（和用户）只看得到水位（ctx meter「还剩多少」），看不
// 到构成——system/工具 schema/历史各占多少。压缩时机判断、「为什么上下文
// 这么满」的归因需要账单，不是水位计。
//
// 超越点：①与 ctx meter 互补不重叠（meter=水位 UI 面；doctor=账单模型面，
// 模型自查后可主动 new_context/压缩决策——与 125 轮转闭环）；②压缩感知
// （历史项带窗口数——SUMMARY_MARKER 计数，与 loop 的 windowSeq 同源）；
// ③同一 canonical serializer（serializePrompt 分段构造三次——system 段/
// 工具段/消息段各一，字节口径与 M47 的前缀钉完全同源）；④只读零协议零
// UI；defer（闲时）轮可用（只读白名单同 schedule_list）。
//
// 接线：goalBox 家族晚绑盒——buildToolSet 收盒，宿主（session-engine）在
// driver 存在后回填；one-shot/REPL 未接线时工具诚实拒答（fail-closed 家族，
// 不静默报零）。
import { buildTool, SUMMARY_MARKER, estimateTokens, type Tool } from "@wudao-org/core";
import { serializePrompt } from "@wudao-org/providers";

/** The late-bound snapshot the doctor reads at execute time (post-resume
 *  rotations included — the goalBox discipline). */
export interface ContextDoctorSnapshot {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly import("@wudao-org/core").AgentMessage[];
  readonly contextWindowTokens: number;
}

/** The box buildToolSet receives; the host late-binds `get` after the driver
 *  exists. Absent get = the tool refuses honestly (fail-closed family). */
export interface ContextDoctorBox {
  get?: () => ContextDoctorSnapshot | undefined;
}

/** One section's bill line. */
interface SectionBill {
  readonly label: string;
  readonly bytes: number;
  readonly tokens: number;
}

/** Pure: the per-section bill. tokens 走 estimateTokens 的原生三段形（逐段
 *  只喂该段——CJK 感知口径与压缩触发完全同源）；bytes 走 serializePrompt
 *  分段构造（M47 canonical 形——与字节前缀钉同源）。 */
export function contextDoctorSections(snap: ContextDoctorSnapshot): readonly SectionBill[] {
  const bytesOf = (input: { systemPrompt: string; tools: readonly Tool[]; messages: readonly import("@wudao-org/core").AgentMessage[] }): number =>
    Buffer.byteLength(serializePrompt(input), "utf8");
  return [
    {
      label: "system",
      tokens: estimateTokens(snap.systemPrompt, [], []),
      bytes: bytesOf({ systemPrompt: snap.systemPrompt, tools: [], messages: [] }),
    },
    {
      label: "工具 schema",
      tokens: estimateTokens("", [...snap.tools], []),
      bytes: bytesOf({ systemPrompt: "", tools: [...snap.tools], messages: [] }),
    },
    {
      label: "会话历史",
      tokens: estimateTokens("", [], [...snap.messages]),
      bytes: bytesOf({ systemPrompt: "", tools: [], messages: [...snap.messages] }),
    },
  ];
}

/** Pure: the human bill text (the tool's output). Compact-aware — the history
 *  line names the window count (SUMMARY_MARKER-prefixed user rows, the loop's
 *  windowSeq source). */
export function contextDoctorText(snap: ContextDoctorSnapshot): string {
  const sections = contextDoctorSections(snap);
  const windows = snap.messages.filter((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER)).length;
  const totalTokens = sections.reduce((n, s) => n + s.tokens, 0);
  const pct = snap.contextWindowTokens > 0 ? Math.round((totalTokens / snap.contextWindowTokens) * 100) : 0;
  const lines = sections.map((s) => `${s.label}: ~${s.tokens.toLocaleString("en-US")} tokens (${s.bytes.toLocaleString("en-US")} B)`);
  if (windows > 0) lines[2] = `${lines[2]!} · 第 ${String(windows + 1)} 窗口`; // 压缩感知：链上已有 N 个边界=当前第 N+1 窗
  lines.push(`合计: ~${totalTokens.toLocaleString("en-US")} tokens ≈ 窗口的 ${String(pct)}%`);
  lines.push("水位看 ctx 徽章；这份是构成账单——历史占比高时考虑 /compact 或 new_context，工具 schema 占比高时是工具面的重量。");
  return lines.join("\n");
}

export function createContextDoctorTool(box: ContextDoctorBox): Tool {
  return buildTool({
    name: "context_doctor",
    description:
      "Report the token bill of the NEXT request by composition: system prompt / tool schemas / conversation history (each in tokens and canonical bytes), the total, and its share of the context window. Compact-aware — after compactions the history line names the current window number. Read-only. Use it when deciding whether to compact (/compact), rotate context (new_context), or when the user asks why the context is so full.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute() {
      const snap = box.get?.();
      if (snap === undefined) {
        return { content: "context_doctor 未接线（本前端没有会话状态盒）——UI/守护宿主可用", isError: true };
      }
      return { content: contextDoctorText(snap) };
    },
  });
}
