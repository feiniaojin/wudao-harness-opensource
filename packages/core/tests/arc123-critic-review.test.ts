// 123-3（zcode runFinalCriticLoop 引进，变体）— critic 终态评审收据。
// 纯层：verdict 解析（pass/reopen+缺口/reopen 必点名/畸形降级）；
// 工具面：无板诚实拒、pass/reopen 回执形、querySource 溯源、失败视为未通过。
import { describe, expect, it } from "vitest";
import { buildTool, type ModelClient, type ModelInput } from "../src/index.js";
import { createCriticReviewTool, parseCriticVerdict, CRITIC_QUERY_SOURCE, type CriticBoardSnapshot } from "../src/tools/critic-review.js";

const snap = (done: string[], incomplete: string[] = []): CriticBoardSnapshot => ({
  doneItems: done,
  incompleteItems: incomplete,
  boardText: `[todo board ${done.length}/${done.length + incomplete.length} done]\n` +
    done.map((d) => `☑ ${d}`).join("\n") + (incomplete.length > 0 ? "\n" + incomplete.map((d) => `☐ ${d}`).join("\n") : ""),
});

describe("123-3 — parseCriticVerdict 纯层", () => {
  it("pass / reopen+gaps / reopen 缺点名=畸形（防全打回轰炸）", () => {
    expect(parseCriticVerdict('{"verdict":"pass"}')).toEqual({ verdict: "pass", gaps: [] });
    expect(parseCriticVerdict('前置噪声 {"verdict":"reopen","gaps":[{"item":"写测试","why":"没有跑过任何测试"}]} 后缀')).toEqual({
      verdict: "reopen",
      gaps: [{ item: "写测试", why: "没有跑过任何测试" }],
    });
    expect(parseCriticVerdict('{"verdict":"reopen","gaps":[]}')).toBeUndefined();
    expect(parseCriticVerdict("不是 JSON")).toBeUndefined();
    expect(parseCriticVerdict('{"verdict":"maybe"}')).toBeUndefined();
  });
});

describe("123-3 — critic_review 工具面", () => {
  const fakeModel = (reply: string): ModelClient & { inputs: ModelInput[] } => {
    const inputs: ModelInput[] = [];
    return {
      inputs,
      async generate(input) {
        inputs.push(input);
        return { role: "assistant", content: reply };
      },
    };
  };

  it("无 done 项（无板/全未完）→ 零调用的诚实回执", async () => {
    const model = fakeModel("never called");
    const tool = createCriticReviewTool({ model, getBoard: () => undefined, getTaskStatement: () => "任务" });
    const res = await tool.execute({});
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain("没有可评审");
    expect(model.inputs.length).toBe(0);
  });

  it("pass：✅ 回执 + 独立调用（querySource=critic）+ 低推理档", async () => {
    const model = fakeModel('{"verdict":"pass"}');
    const tool = createCriticReviewTool({
      model,
      getBoard: () => snap(["写单元测试", "修 bug"]),
      getTaskStatement: () => "修复登录 bug 并写测试",
    });
    const res = await tool.execute({ task_statement: "修复登录 bug 并写测试，测试须全绿" });
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain("✅ 评审通过");
    expect(res.content).toContain("2 个完成项");
    expect(model.inputs.length).toBe(1);
    expect(model.inputs[0]!.querySource).toBe(CRITIC_QUERY_SOURCE);
    expect(model.inputs[0]!.reasoningEffort).toBe("low");
    // 评审提示词携带任务原话与板。
    expect(String(model.inputs[0]!.messages[0]!.content)).toContain("修复登录 bug 并写测试，测试须全绿");
    expect(String(model.inputs[0]!.messages[0]!.content)).toContain("写单元测试");
  });

  it("reopen：逐项缺口 + 打回指引（模型手里——不自动续跑）", async () => {
    const model = fakeModel('{"verdict":"reopen","gaps":[{"item":"写单元测试","why":"板上声明完成但工作证据里没有任何测试运行"},{"item":"修 bug","why":"修复未验证——没有复现步骤通过的证据"}]}');
    const tool = createCriticReviewTool({
      model,
      getBoard: () => snap(["写单元测试", "修 bug"]),
      getTaskStatement: () => "修 bug",
    });
    const res = await tool.execute({});
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain("评审打回 2 项");
    expect(res.content).toContain("写单元测试");
    expect(res.content).toContain("todo_write");
  });

  it("评审回复畸形/调用失败 → isError（视为未通过——绝不伪造 pass）", async () => {
    const bad = createCriticReviewTool({ model: fakeModel("garbage"), getBoard: () => snap(["x"]), getTaskStatement: () => "t" });
    expect((await bad.execute({})).isError).toBe(true);
    const throwing: ModelClient = { async generate() { throw new Error("provider down"); } };
    const dead = createCriticReviewTool({ model: throwing, getBoard: () => snap(["x"]), getTaskStatement: () => "t" });
    const res = await dead.execute({});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("provider down");
  });
});
