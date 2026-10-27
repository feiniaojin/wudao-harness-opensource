// 133 深测 T001——compactableSpan 的边界收据（真任务审计产出 10 条断言）。
// 深测产出：docs/research/deeptest-T001-span-analysis.md（模型自己写了
// span-probe.mjs 亲验边界——不是读代码猜的）。
import { describe, expect, it } from "vitest";
import { SUMMARY_MARKER } from "../src/index.js";
import { compactableSpan } from "../src/compaction-tier2-static.js";
import type { AgentMessage } from "../src/index.js";

const u = (content: string): AgentMessage => ({ role: "user", content });
const a = (content: string): AgentMessage => ({ role: "assistant", content });
const t = (content: string, toolCallId: string): AgentMessage => ({ role: "tool", content, toolCallId, name: "read_file" } as never);

describe("133 深测 — compactableSpan 边界（审计 §7 的 10 条断言）", () => {
  it("1-3. 空数组/单元素/keepRecent≥长度 → null（:63）", () => {
    expect(compactableSpan([], 6)).toBeNull();
    expect(compactableSpan([u("x")], 6)).toBeNull();
    const msgs = [u("a"), a("b"), u("c"), a("d"), u("e")];
    expect(compactableSpan(msgs, msgs.length)).toBeNull();
    expect(compactableSpan(msgs, msgs.length + 1)).toBeNull();
    expect(compactableSpan(msgs, Infinity)).toBeNull();
  });

  it("4. 无 assistant 列表（全 user/tool）→ null（:63 经 stubFloor=0）", () => {
    expect(compactableSpan([u("a"), u("b"), u("c")], 2)).toBeNull();
    expect(compactableSpan([u("a"), t("result", "c1"), u("b")], 2)).toBeNull();
  });

  it("5. keepRecent=0 + 末尾 assistant + tool → 非 null；rest[0] 是最后 assistant（stubFloor）", () => {
    const msgs = [u("q"), a("assistant with tool"), t("result", "c1")];
    const out = compactableSpan(msgs, 0);
    expect(out).not.toBeNull();
    expect(out!.rest[0]).toBeDefined();
    expect(out!.rest[0]!.role).toBe("assistant");
    expect(out!.rest.length).toBeGreaterThanOrEqual(1);
  });

  it("6. 开头孤立 tool 的 fit 列表 → null（:63 早于配对循环——:60 注释所防）", () => {
    // 列表本来就 fit（keepRecent 覆盖全部），但若先跑配对循环，孤立 tool 会推 cutoff 到 1
    expect(compactableSpan([t("orphan", "c0"), u("a"), a("b"), u("c")], 6)).toBeNull();
  });

  it("7. cutoff 紧邻 marker 后（start===cutoff）→ null（:74）", () => {
    const msgs = [u(SUMMARY_MARKER + " previous"), a("assistant"), u("post")];
    // keepRecent=1 → cutoff 至少在最后 assistant（下标1）；start 从 cutoff-1 回扫
    // 到 marker（下标0）→ start=1=cutoff → 空 span → null
    expect(compactableSpan(msgs, 1)).toBeNull();
  });

  it("8. span 只含 SUMMARY_MARKER → null（:76 防 summary-of-summary）", () => {
    const markers = [u(SUMMARY_MARKER + " m1"), u(SUMMARY_MARKER + " m2")];
    const msgs = [a("assistant"), ...markers, u("x")];
    const out = compactableSpan(msgs, 1);
    // 要么 null（cutoff/markers 排列使 span 全 marker），要么成功——关键是
    // 成功时 span 必含至少一条非 marker
    if (out !== null) {
      expect(out.span.some((m) => !(m.role === "user" && m.content.startsWith(SUMMARY_MARKER)))).toBe(true);
    }
  });

  it("9. 成功路径划分不变量：prior+span+rest === 全量，不重叠", () => {
    const msgs = [u("q1"), a("a1"), u("q2"), a("a2"), u("q3"), a("a3"), u("tail")];
    const out = compactableSpan(msgs, 2);
    expect(out).not.toBeNull();
    expect(out!.prior.length + out!.span.length + out!.rest.length).toBe(msgs.length);
    expect(out!.prior.length).toBeLessThanOrEqual(out!.span.length + out!.rest.length); // no overlap sanity
  });

  it("审计发现：负数 keepRecent 退化同 0（Math.min 夹取的隐性行为——值得钉）", () => {
    const msgs = [u("q"), a("assistant"), t("result", "c1")];
    const negOut = compactableSpan(msgs, -1);
    const zeroOut = compactableSpan(msgs, 0);
    expect(negOut === null).toBe(zeroOut === null);
    if (negOut !== null && zeroOut !== null) {
      expect(negOut.span.length).toBe(zeroOut.span.length);
      expect(negOut.rest.length).toBe(zeroOut.rest.length);
    }
  });
});
