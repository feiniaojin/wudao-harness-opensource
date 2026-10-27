// ω99-226: #1 — R1（auto 档真化——四档矩阵 + sidecar 路径亲验）。0.3.59 验装
// 回执第三报报障原文：「我发现我虽然切换成了auto模式，但是还是一遍一遍的找我
// 确认，像是开了假的auto模式」。裁定（控制器，product scenario-first）：
// auto 档下电脑/浏览器八件套跟随档位放行——4.68 层守卫加 mode!=="auto"，落
// 内建模式 allow，sidecar 审计照跑；其余档不变。本件钉死新矩阵：
//   auto      + 八件套（九名）+ browser_type submit:true → allow（经 sidecar 路径）
//   workspace + 同面 → ask（用户未点名 workspace 档，保守面保留）
//   ask       + 同面 → ask
//   plan      + 同面 → deny（层 1.5 只读栅栏在 4.68 之前，不受本弧影响）
// sidecar 安全网亲验：真实 decideRichPermission 作静态层 + withSidecarLayer——
// auto 放行的八件套全部过分类器（checks≥1）。#452（0.3.81）裁定：low/high/error
// 判决均自动放行（high/error 响亮回执=审计不打断）——auto=托付+审计，升级人工
// 的只剩旁路免疫静态面（保护设置写/凭据物料/操作员 ask 规则）。
// 212/220 的「every mode included」全档问姿态被 ω99-226 产品裁定推翻；ω99-226
// 的「high 判决升级人工」又被 #452 推翻（非回归，census 演进面见
// omega99-226-report.md + #452 台账）。
import { describe, it, expect } from "vitest";
import type { AssistantMessage, ModelClient, ModelInput, PermissionDecision } from "@wudao/core";
import {
  DEFAULT_ASK_TOOLS,
  PLAN_DENY_REASON,
  decideRichPermission,
  sidecarGatesTool,
  withSidecarLayer,
  type Mode,
  type SidecarEscalation,
  type StaticRuleDecide,
} from "../src/permission.js";
import { createSidecar } from "../src/sidecar.js";

const NINE = [...DEFAULT_ASK_TOOLS]; // 220 后九名：browser_click … computer_drag

describe("ω99-226 — 四档矩阵（八件套动作类）", () => {
  it("auto：九名全部放行——不再逐动作问（落内建模式，sidecar 照审）", () => {
    for (const n of NINE) {
      expect(decideRichPermission({ mode: "auto", toolName: n, input: {} })).toEqual({ behavior: "allow" });
    }
  });

  it("workspace：九名照旧问（保守面保留——用户没抱怨 workspace 档）", () => {
    for (const n of NINE) {
      expect(decideRichPermission({ mode: "workspace", toolName: n, input: {} })).toBe("ask");
    }
  });

  it("ask：九名照旧问", () => {
    for (const n of NINE) {
      expect(decideRichPermission({ mode: "ask", toolName: n, input: {} })).toBe("ask");
    }
  });

  it("plan：九名照旧只读栅栏拒（层 1.5 在 4.68 之前——本弧不碰）", () => {
    for (const n of NINE) {
      expect(decideRichPermission({ mode: "plan", toolName: n, input: {} }))
        .toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
    }
  });

  it("browser_type submit:true 同矩阵（探针参数面）；submit:false 仍走内建档位", () => {
    const submit = { ref: "e2", text: "q", submit: true };
    expect(decideRichPermission({ mode: "auto", toolName: "browser_type", input: submit })).toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "workspace", toolName: "browser_type", input: submit })).toBe("ask");
    expect(decideRichPermission({ mode: "ask", toolName: "browser_type", input: submit })).toBe("ask");
    expect(decideRichPermission({ mode: "plan", toolName: "browser_type", input: submit }))
      .toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
    // submit:false：非 submit 面，auto 走内建 allow（112 既有钉，零变）
    expect(decideRichPermission({ mode: "auto", toolName: "browser_type", input: { ref: "e2", text: "q", submit: false } }))
      .toEqual({ behavior: "allow" });
  });

  it("规则层照旧优先：session `a` / settings deny / settings ask 都在 4.68 之前（auto 亦然）", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "computer_type", input: {}, session: ["computer_type"] }))
      .toEqual({ behavior: "allow" });
    expect(decideRichPermission({
      mode: "auto", toolName: "computer_click", input: {},
      settings: { deny: ["computer_click"], allow: [], ask: [], sidecarExempt: [] },
    })).toEqual({ behavior: "deny", reason: 'settings deny rule "computer_click"' });
    // 操作员显式 ask 规则不被 auto 吞掉（层 4 在 4.68 之前）
    expect(decideRichPermission({
      mode: "auto", toolName: "computer_key", input: {},
      settings: { ask: ["computer_key"], allow: [], deny: [], sidecarExempt: [] },
    })).toBe("ask");
  });
});

describe("ω99-226 — auto 放行的 sidecar 安全网亲验", () => {
  it("九名全部在 sidecar 审计范围（不在 SIDECAR_UNGATED——放行后必过分类器）", () => {
    for (const n of NINE) expect(sidecarGatesTool(n)).toBe(true);
    expect(sidecarGatesTool("browser_type")).toBe(true); // submit 探针面同工具名
  });

  /** 真·静态层（decideRichPermission）+ withSidecarLayer：auto 档八件套的
   *  放行必须穿过分类器（low → allow+回执；high → 升级人工），不是裸放行。 */
  function trustHarness(verdictReply: string) {
    const model: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        return { role: "assistant", content: verdictReply };
      },
    };
    const sidecar = createSidecar({ model });
    const escalations: SidecarEscalation[] = [];
    const receipts: string[] = [];
    const staticDecide: StaticRuleDecide = (toolName, input) =>
      decideRichPermission({ mode: "auto", toolName, input });
    const gate = withSidecarLayer(
      {
        sidecar,
        getMode: (): Mode => "auto",
        escalate: async (_t, _i, ctx) => {
          escalations.push(ctx);
          const d: PermissionDecision = { behavior: "deny", reason: `escalated: ${ctx.reason ?? ""}` };
          return d;
        },
        receipt: (l) => void receipts.push(l),
      },
      staticDecide,
    );
    return { sidecar, escalations, receipts, gate };
  }

  it("low 判决：放行 + checks≥1 + 回执——auto 的放行是「审计后的放行」", async () => {
    const h = trustHarness('{"risk":"low","reason":"routine click"}');
    const d = await h.gate("browser_click", { ref: "e1" });
    expect(d).toEqual({ behavior: "allow" });
    expect(h.sidecar.checks()).toBe(1);
    expect(h.receipts.join("\n")).toContain("sidecar:low");
    expect(h.escalations).toHaveLength(0);
  });

  it("high 判决：auto 托付放行 + 响亮回执（#452）——审计走回执不打断", async () => {
    const h = trustHarness('{"risk":"high","reason":"打字提交会下单"}');
    const d = await h.gate("computer_type", { text: "x" });
    expect(h.sidecar.checks()).toBe(1);
    expect(h.escalations).toHaveLength(0);
    expect(h.receipts.join("\n")).toContain("sidecar:high");
    expect(h.receipts.join("\n")).toContain("打字提交会下单");
    expect(d).toEqual({ behavior: "allow" });
  });

  it("对照（零变）：read_file 仍跳过分类器（READ_TOOLS 在 SIDECAR_UNGATED）", async () => {
    const h = trustHarness('{"risk":"low","reason":"x"}');
    const d = await h.gate("read_file", { path: "a" });
    expect(d).toEqual({ behavior: "allow" });
    expect(h.sidecar.checks()).toBe(0);
  });
});
