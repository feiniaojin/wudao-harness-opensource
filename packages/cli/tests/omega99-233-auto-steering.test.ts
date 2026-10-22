// ω99-233: #R1 — R1（auto 档模型侧引导：permission_mode MetaNote——用户四
// 指令 ③）。226 把权限层 auto 真化（静态层放行 + sidecar 审计），但模型侧零
// 引导：buildSystemPrompt 无 mode 参且 session 冻结，setMode 只设变量+emit+
// peer tier——模型不知道托付已发生，仍在回复里反复向用户提问（09-09 用户指
// 令 ③「开了auto模式，还是反复询问用户的问题」）。本弧把模式语义对模型一等
// 公民化（超越点：行业 the upstream format/Codex 的 mode 都不对模型声明语义），走
// <workspace_changed> 同款 MetaNote 信封（随下次首个模型调用冲刷、投影面零
// 持久化，M24 缓存零代价）。本件钉死：
//   纯层   modeSteeringNote 六向矩阵（进 auto 契约逐字 / 出 auto 三形 label 插值 / 档间互切 null）
//   集成   boot 播种 + setMode 注入 + 单次冲刷 + 零 appendHistory notice
//   权限门 auto 出口枚举钉（静态断言不做 I/O；by-design 通道立此存照）
// ★红线（09-09 用户令，逐字）：「注意，开发、测试过程禁止删除用户文件/文件夹。」
// 本件夹具全内存（零文件系统、零临时目录）——纯层矩阵、驱动 mock 模型、权限
// 门静态断言均不落盘。
import { describe, it, expect } from "vitest";
import type { ModelClient, ModelInput } from "@wudao/core";
import { createAgentDriver, modeSteeringNote, type AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import { decideRichPermission, type Mode } from "../src/permission.js";

// §二逐字钉（执行者不造句）：进 auto 的托付契约常量。
const AUTO_MODE_CONTRACT =
  '<permission_mode mode="auto">用户已切换到自动模式——这是显式托付。后续动作无需逐项向用户确认：可逆、工作区内、常规风险的操作请自主决策并直接执行，完成后简要说明做了什么。只在三种情况停下来询问：(a) 可能造成不可恢复的数据丢失；(b) 需要触碰工作区之外的系统或真实凭据；(c) 任务目标存在会导向完全不同结果的歧义。</permission_mode>';

// §二模板插值（label = 目标档中文名）：出 auto 的姿态恢复声明。
const exitNote = (next: Mode, label: string): string =>
  `<permission_mode mode="${next}">已退出自动模式，确认姿态恢复（当前档位：${label}）。请按当前档位的确认规则行事，不要再沿用自动模式的自主决策姿态。</permission_mode>`;

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** 驱动集成夹具（沿 driver.test.ts 的 recordingModel 构建法）：mock 模型记录
 * 每次收到的 ModelInput；tools=[]（无工具轮、无 ask 面）；todo/verify 门关
 * 掉防额外注入轮。全内存，零 fs。 */
function makeSteeringDriver(mode?: Mode): { driver: AgentDriver; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  const model: ModelClient = {
    async generate(input: ModelInput): Promise<{ role: "assistant"; content: string }> {
      inputs.push(input);
      return { role: "assistant", content: "ok" };
    },
  };
  const driver = createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model,
    tools: [],
    gates: { todo: false, verify: false },
    ...(mode !== undefined ? { mode } : {}),
  });
  return { driver, inputs };
}

/** 全文子串断言用（noteIn 同款：JSON.stringify 会转义引号，须在 content 内匹配）。 */
const noteIn = (input: ModelInput, needle: string): boolean =>
  input.messages.some((m) => typeof m.content === "string" && m.content.includes(needle));

const runToSettle = async (driver: AgentDriver, what: string): Promise<void> => {
  await until(() => driver.getStatus().busy === false, what);
};

describe("ω99-233 — modeSteeringNote 六向矩阵（纯层，逐字钉）", () => {
  it("进 auto（workspace/ask/plan → auto）：同一托付契约常量，逐字", () => {
    expect(modeSteeringNote("auto", "workspace")).toBe(AUTO_MODE_CONTRACT);
    expect(modeSteeringNote("auto", "ask")).toBe(AUTO_MODE_CONTRACT);
    // cycle 序里 plan 直邻 auto——同为进 auto 形
    expect(modeSteeringNote("auto", "plan")).toBe(AUTO_MODE_CONTRACT);
  });

  it("出 auto 三形：档位中文 label 插值 + 「不要再沿用」句", () => {
    expect(modeSteeringNote("workspace", "auto")).toBe(exitNote("workspace", "工作区"));
    expect(modeSteeringNote("ask", "auto")).toBe(exitNote("ask", "逐项确认"));
    expect(modeSteeringNote("plan", "auto")).toBe(exitNote("plan", "只读规划"));
  });

  it("非 auto 档间互切与同档重设：null（权限面自明 + PLAN_DENY_REASON 已自解释，v1 不扩）", () => {
    expect(modeSteeringNote("ask", "workspace")).toBe(null);
    expect(modeSteeringNote("plan", "ask")).toBe(null);
    expect(modeSteeringNote("workspace", "plan")).toBe(null);
    expect(modeSteeringNote("auto", "auto")).toBe(null);
  });
});

describe("ω99-233 — 驱动集成（boot 播种 + setMode 注入 + 单次冲刷）", () => {
  it("(a) boot 缺省 workspace + setMode('auto') → 下一次模型调用的输入含契约标签", async () => {
    const { driver, inputs } = makeSteeringDriver(); // 缺省 workspace
    driver.submit("go");
    await runToSettle(driver, "run 1 settles");
    expect(inputs[0] !== undefined && noteIn(inputs[0], "permission_mode")).toBe(false); // 进 auto 前零注入

    driver.setMode("auto");
    driver.submit("more");
    await runToSettle(driver, "run 2 settles");
    // 下一次模型调用的输入含契约（全文逐字——信封与文案都不许漂）
    expect(inputs[1] !== undefined && noteIn(inputs[1], AUTO_MODE_CONTRACT)).toBe(true);
    driver.dispose();
  });

  it("(b) auto → setMode('workspace') → 下次调用含退出句（label=工作区），无契约残留", async () => {
    const { driver, inputs } = makeSteeringDriver("auto");
    driver.submit("go");
    await runToSettle(driver, "boot-auto run settles"); // 首调冲刷 boot 契约
    driver.setMode("workspace");
    driver.submit("more");
    await runToSettle(driver, "run 2 settles");
    expect(inputs[1] !== undefined && noteIn(inputs[1], exitNote("workspace", "工作区"))).toBe(true);
    expect(inputs[1] !== undefined && noteIn(inputs[1], AUTO_MODE_CONTRACT)).toBe(false);
    driver.dispose();
  });

  it("(c) boot 即 auto（opts.mode='auto'）→ 首次调用即含契约（无 setMode）", async () => {
    const { driver, inputs } = makeSteeringDriver("auto");
    driver.submit("go");
    await runToSettle(driver, "first run settles");
    expect(inputs[0] !== undefined && noteIn(inputs[0], AUTO_MODE_CONTRACT)).toBe(true);
    driver.dispose();
  });

  it("(d) boot 非 auto + workspace→ask 切换 → 零注入", async () => {
    const { driver, inputs } = makeSteeringDriver(); // workspace
    driver.submit("go");
    await runToSettle(driver, "run 1 settles");
    driver.setMode("ask");
    driver.submit("more");
    await runToSettle(driver, "run 2 settles");
    expect(inputs[1] !== undefined && noteIn(inputs[1], "permission_mode")).toBe(false);
    driver.dispose();
  });

  it("(e) 标签单次冲刷：第一次调用后队列清空，第二次调用不再含（metaNotes shift 语义）", async () => {
    const { driver, inputs } = makeSteeringDriver(); // workspace
    driver.setMode("auto");
    driver.submit("go");
    await runToSettle(driver, "run 1 settles");
    expect(inputs[0] !== undefined && noteIn(inputs[0], AUTO_MODE_CONTRACT)).toBe(true);
    driver.submit("again");
    await runToSettle(driver, "run 2 settles");
    expect(inputs[1] !== undefined && noteIn(inputs[1], "permission_mode")).toBe(false);
    driver.dispose();
  });

  it("(f) setMode 后 appendHistory 零新增 notice（UI 已有 modechip 示档，人不需重复提醒）", async () => {
    const { driver } = makeSteeringDriver(); // workspace
    await runToSettle(driver, "driver idle");
    const h0 = driver.getHistory().length;
    driver.setMode("auto");
    expect(driver.getHistory().length).toBe(h0); // 进 auto：零 notice
    driver.setMode("workspace");
    expect(driver.getHistory().length).toBe(h0); // 出 auto：零 notice
    driver.dispose();
  });
});

describe("ω99-233 — 权限门 auto 出口枚举钉（静态断言不做 I/O，by-design 立此存照）", () => {
  it("auto 四出口：普通工具 allow / DEFAULT_ASK 类 allow / 凭据物料 ask / 显式 operator ask 规则 ask", () => {
    // 普通工具（内建层 5：auto 全放行——226 域）
    expect(decideRichPermission({ mode: "auto", toolName: "write_file", input: { path: "a.txt", content: "x" } }))
      .toEqual({ behavior: "allow" });
    // DEFAULT_ASK 八件套取一（4.68 层 mode!=="auto" 守卫——226 域复引）
    expect(decideRichPermission({ mode: "auto", toolName: "browser_click", input: {} }))
      .toEqual({ behavior: "allow" });
    // 凭据物料路径（4.65 by-design：auto 不静默读密钥——托付但有审计的姊妹边界）
    expect(decideRichPermission({ mode: "auto", toolName: "read_file", input: { path: "/home/u/.ssh/id_rsa" } }))
      .toBe("ask");
    // 显式 operator ask 规则（层 4 在内建模式之前——by-design）
    expect(decideRichPermission({
      mode: "auto", toolName: "computer_key", input: {},
      settings: { ask: ["computer_key"], allow: [], deny: [], sidecarExempt: [] },
    })).toBe("ask");
  });
});
