// 132-P1-2（deepagents 60c0228aa 引进）— context_doctor 注入账单收据。
// 分段口径（estimateTokens 三段原生形 + serializePrompt 分段字节）/
// 合计=分项和 / 窗口% / 压缩感知窗口号 / 晚绑盒拒答 / 挂载面（defer 轮白名单）。
import { describe, expect, it } from "vitest";
import { buildTool, SUMMARY_MARKER, type Tool } from "@wudao-org/core";
import { contextDoctorSections, contextDoctorText, createContextDoctorTool, type ContextDoctorSnapshot } from "../src/context-doctor.js";
import { buildToolSet } from "../src/tools.js";

const fakeTool = (name: string, description: string): Tool =>
  buildTool({
    name,
    description,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute() {
      return { content: "ok" };
    },
  });

const snap = (over: Partial<ContextDoctorSnapshot> = {}): ContextDoctorSnapshot => ({
  systemPrompt: "You are a harness.".repeat(50),
  tools: [fakeTool("read_file", "Read a file as UTF-8 text. By default returns the first 2000 lines."),
  fakeTool("shell", "Run shell commands (build/test/install/git). This is how you verify work. Capture and report the real output.")],
  messages: [
    { role: "user", content: "第一问：把 utils 重构一下" },
    { role: "assistant", content: "好的，我先看一下结构。" },
    { role: "user", content: "继续" },
    { role: "assistant", content: "完成了。" },
  ],
  contextWindowTokens: 64_000,
  ...over,
});

describe("132 — context_doctor 分段账单", () => {
  it("三段各>0，合计=分项和", () => {
    const s = snap();
    const sections = contextDoctorSections(s);
    expect(sections.map((x) => x.label)).toEqual(["system", "工具 schema", "会话历史"]);
    for (const sec of sections) {
      expect(sec.tokens).toBeGreaterThan(0);
      expect(sec.bytes).toBeGreaterThan(0);
    }
    const total = sections.reduce((n, x) => n + x.tokens, 0);
    expect(contextDoctorText(s)).toContain(`合计: ~${total.toLocaleString("en-US")} tokens`);
  });

  it("窗口%＝合计/窗口取整", () => {
    const text = contextDoctorText(snap({ contextWindowTokens: 1_000 }));
    const sections = contextDoctorSections(snap({ contextWindowTokens: 1_000 }));
    const pct = Math.round((sections.reduce((n, x) => n + x.tokens, 0) / 1_000) * 100);
    expect(text).toContain(`≈ 窗口的 ${String(pct)}%`);
  });

  it("压缩感知：历史行带第 N+1 窗口（SUMMARY_MARKER 计数同 loop windowSeq 源）", () => {
    const compacted = snap({
      messages: [
        { role: "user", content: `${SUMMARY_MARKER} [context window #1] 摘要……` },
        { role: "user", content: "新窗口的第一问" },
      ],
    });
    expect(contextDoctorText(compacted)).toContain("第 2 窗口");
    expect(contextDoctorText(snap())).not.toMatch(/第 \d+ 窗口/); // 无边界不报窗口号（合计行的「窗口的 %」不受影响）
  });

  it("CJK 感知：中文历史的 tokens 显著高于 chars/4（脚本感知口径）", () => {
    const cjkHeavy = snap({ systemPrompt: "", tools: [], messages: [{ role: "user", content: "把工具目录按模块拆分并写测试验证" }] });
    const sec = contextDoctorSections(cjkHeavy).find((x) => x.label === "会话历史")!;
    expect(sec.tokens).toBeGreaterThan(6); // 16 chars CJK → ~16×1.5=24 tokens 量级（远超 16/4=4）
  });
});

describe("132 — context_doctor 工具面", () => {
  it("晚绑盒就位 → 账单即回执；未接线 → 诚实拒答（fail-closed 家族）", async () => {
    const box: { get?: () => ContextDoctorSnapshot } = {};
    const tool = createContextDoctorTool(box);
    const refused = await tool.execute({});
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("未接线");
    box.get = () => snap();
    const ok = await tool.execute({});
    expect(ok.isError).not.toBe(true);
    expect(ok.content).toContain("system:");
    expect(ok.content).toContain("工具 schema:");
    expect(ok.content).toContain("会话历史:");
  });

  it("挂载面：带盒挂载、不带不挂；defer（闲时）轮白名单保留", async () => {
    const mk = async (): Promise<string[]> => {
      const set = buildToolSet({
        workspaceRoot: process.cwd(),
        model: { async generate() { return { role: "assistant" as const, content: "" }; } } as never,
        canUseTool: async () => ({ behavior: "allow" as const }),
        contextWindowTokens: 64_000,
        contextDoctor: {},
      });
      return set.map((t) => t.name);
    };
    expect(await mk()).toContain("context_doctor");
    const noBox = buildToolSet({
      workspaceRoot: process.cwd(),
      model: { async generate() { return { role: "assistant" as const, content: "" }; } } as never,
      canUseTool: async () => ({ behavior: "allow" as const }),
      contextWindowTokens: 64_000,
    });
    expect(noBox.map((t) => t.name)).not.toContain("context_doctor");
  });
});
