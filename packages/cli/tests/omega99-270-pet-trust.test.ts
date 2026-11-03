// ω99-270: #2 — 小精灵托付车道（用户报障 09-10：「我使用小精灵的时候，反复的
// 弹出提示授权……我都用小精灵了，还找我要权限，非常不应该」）。根因三件套：
// ① ui.ts 精灵车道 mode 钳制（全局 auto→workspace，235「精灵车道未获托付」）；
// ② workspace 档下 computer/browser 八件套在 4.68 与第 5 层（不在
// WORKSPACE_TOOLS）双重问——精灵每个动作一张权限卡；③ 托付面（小精灵）比主窗
// 更烦，与产品承诺倒挂。修复=精灵车道恒 auto（用小精灵=托付行为本身）+ sidecar
// 共享实例跟车（226「托付但有审计」契约同构）。本件先红后绿。
// ★红线（09-09 用户令）：夹具只写 mkdtemp(os.tmpdir())，全程不删任何文件；
// 测试全 mock（scripted 模型 + 假工具 + stub sidecar——零真键鼠/截屏/模型/网络）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool } from "@wudao-org/core";
import type { ModelClient, ModelInput, Tool } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import type { Sidecar } from "../src/sidecar.js";
import { startUiSession, type UiSession } from "../src/ui.js";
import { TITLE_QUERY_SOURCE } from "../src/session-title.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

const sessions: UiSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
});

/** 233 托付契约的判定锚（全文钉在 233 测试；此处只判「教到了」）。 */
const CONTRACT_ANCHOR = "用户已切换到自动模式";

type ScriptedReply = { readonly content: string; readonly toolCalls?: readonly { id: string; name: string; arguments: Record<string, unknown> }[] };

/** scripted 模型：支持 toolCalls 回复形；可选捕获每次会话调用的 ModelInput。 */
function scriptedModel(replies: readonly ScriptedReply[], inputs?: ModelInput[]): ModelClient {
  let i = 0;
  return {
    async generate(input: ModelInput) {
      if (input.querySource === TITLE_QUERY_SOURCE) return { role: "assistant", content: "标题" };
      inputs?.push(input);
      const r = replies[i];
      i += 1;
      if (r === undefined) throw new Error("scripted replies exhausted");
      if (r.toolCalls !== undefined && r.toolCalls.length > 0) {
        return { role: "assistant", content: r.content, toolCalls: [...r.toolCalls] };
      }
      return { role: "assistant", content: r.content };
    },
  };
}

/** 假 computer_click：权限层按名匹配（DEFAULT_ASK_TOOLS 纯名匹配）——名字即
 * 报障类工具，execute 只记录绝不触真键鼠。 */
function fakeComputerClick(executed: { name: string; input: Record<string, unknown> }[]): Tool {
  return buildTool({
    name: "computer_click",
    description: "stub landing tool for the pet-trust lane test",
    parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: [], additionalProperties: false },
    execute: async (input) => {
      executed.push({ name: "computer_click", input: input as Record<string, unknown> });
      return { content: "clicked (stub)" };
    },
  });
}

/** stub sidecar：全接口桩；check 记录（托付审计的观察面），恒 low 放行。 */
function stubSidecar(checks: { tool: string; args: Record<string, unknown> }[]): Sidecar {
  return {
    async check(tool, args) {
      checks.push({ tool, args: args as Record<string, unknown> });
      return { kind: "low", reason: "stub low" };
    },
    breakerOpen: () => false,
    consecutiveHighs: () => 0,
    checks: () => checks.length,
    breakerAllows: () => 0, // 0.3.82: the breaker never opens in this stub
    noteBreakerAllow: () => {},
    cacheSize: () => 0,
    resetRun: () => {},
    resetBreaker: () => {},
  };
}

const base = {
  config,
  contextWindowTokens: 64000,
  gates: { verify: false },
  announce: false,
  openBrowser: false,
  staticDir: undefined,
} as const;

/** WUDAO_GLOBAL_HOME 桩（235-d 同款）：settings.json 可选写入。 */
function withGlobalHome(settings: Record<string, unknown> | undefined, run: () => Promise<void>): Promise<void> {
  return (async () => {
    const home = mkdtempSync(join(tmpdir(), "o270-home-"));
    mkdirSync(join(home), { recursive: true });
    if (settings !== undefined) writeFileSync(join(home, "settings.json"), JSON.stringify(settings), "utf8");
    const prev = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    try {
      await run();
    } finally {
      if (prev === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = prev;
    }
  })();
}

describe("ω99-270 小精灵托付车道（恒 auto + 审计跟车）", () => {
  it("(a) 恒托付·报障配置直证：全局默认档 auto → main=auto 不变、pet=auto（今日钳 workspace 是报障根源）", async () => {
    const root = mkdtempSync(join(tmpdir(), "o270-a-"));
    await withGlobalHome({ permissions: { defaultMode: "auto" } }, async () => {
      const session = await startUiSession({
        ...base,
        workspaceRoot: root,
        modelOverride: scriptedModel([{ content: "MAIN-OK" }]),
        petModelOverride: scriptedModel([{ content: "PET-OK" }]),
        tools: [],
        petLane: true,
      });
      sessions.push(session);
      expect(session.driver.getStatus().mode).toBe("auto"); // 主车道照常起步于持久默认档
      expect(session.petDriver!.getStatus().mode).toBe("auto"); // 精灵车道：用小精灵=托付，恒 auto
    });
  });

  it("(b) 恒托付·不随主窗档位：全局未设→main=workspace/pet=auto；全局 ask→main=ask/pet=auto", async () => {
    await withGlobalHome(undefined, async () => {
      const s1 = await startUiSession({
        ...base, workspaceRoot: mkdtempSync(join(tmpdir(), "o270-b1-")),
        modelOverride: scriptedModel([{ content: "M" }]), petModelOverride: scriptedModel([{ content: "P" }]),
        tools: [], petLane: true,
      });
      sessions.push(s1);
      expect(s1.driver.getStatus().mode).toBe("workspace"); // 引擎缺省（未设回退）
      expect(s1.petDriver!.getStatus().mode).toBe("auto"); // 托付不随主窗的谨慎姿态
    });
    // 第二 boot 用独立 root：pet 车道租约按工作区持有（235 设计），同 root 双活
    // 会因车道被占而拿不到 petDriver——分 root 才是在测档位而非测租约。
    await withGlobalHome({ permissions: { defaultMode: "ask" } }, async () => {
      const s2 = await startUiSession({
        ...base, workspaceRoot: mkdtempSync(join(tmpdir(), "o270-b2-")),
        modelOverride: scriptedModel([{ content: "M" }]), petModelOverride: scriptedModel([{ content: "P" }]),
        tools: [], petLane: true,
      });
      sessions.push(s2);
      expect(s2.driver.getStatus().mode).toBe("ask"); // 主车道尊重显式谨慎档
      expect(s2.petDriver!.getStatus().mode).toBe("auto"); // 精灵车道恒托付
    });
  });

  it("(c) 托付闭环三件套：computer_click 直行不打扰 + sidecar.check 跟车审计 + 托付契约 boot 播种进首个模型调用", async () => {
    const root = mkdtempSync(join(tmpdir(), "o270-c-"));
    const executed: { name: string; input: Record<string, unknown> }[] = [];
    const sidecarChecks: { tool: string; args: Record<string, unknown> }[] = [];
    const petInputs: ModelInput[] = [];
    const session = await startUiSession({
      ...base,
      workspaceRoot: root,
      modelOverride: scriptedModel([{ content: "MAIN-OK" }]),
      petModelOverride: scriptedModel([
        { content: "", toolCalls: [{ id: "c1", name: "computer_click", arguments: { x: 7, y: 8 } }] },
        { content: "PET-DONE" },
      ], petInputs),
      tools: [fakeComputerClick(executed)],
      sidecar: stubSidecar(sidecarChecks),
      petLane: true,
    });
    sessions.push(session);

    session.petDriver!.submit("精灵帮我点一下");
    await until(
      () => session.petDriver!.getStatus().busy === false && executed.length === 1,
      "pet run settles with the landing tool executed (no ask parked)",
    );

    // ① 不打扰：工具已执行（workspace 档会停挂成 pendingPermission 而非执行），
    //    落定后 pendingPermission 归零、状态帧 sidecar 段在场（共享实例）。
    expect(executed[0]!.name).toBe("computer_click");
    expect(session.petDriver!.getStatus().pendingPermission).toBe(null);
    // ② 审计跟车：auto 放行后 withSidecarLayer 逐动作分类——check 恰一次、
    //    工具名与实参直证（226「托付但有审计」在精灵车道同构成立）。
    expect(sidecarChecks.length).toBe(1);
    expect(sidecarChecks[0]!.tool).toBe("computer_click");
    expect(sidecarChecks[0]!.args).toEqual({ x: 7, y: 8 });
    // ③ 契约播种：session 以 auto 起步 → 233 托付契约（三例外）进首个模型调用。
    expect(
      petInputs[0] !== undefined && petInputs[0].messages.some((m) => typeof m.content === "string" && m.content.includes(CONTRACT_ANCHOR)),
    ).toBe(true);
  });

  it("(d) 对照·报障根源：同工具在主车道 workspace 档 → pendingPermission 停挂（今日行为；修复只动精灵车道）", async () => {
    await withGlobalHome(undefined, async () => {
      const root = mkdtempSync(join(tmpdir(), "o270-d-"));
      const executed: { name: string; input: Record<string, unknown> }[] = [];
      const session = await startUiSession({
        ...base,
        workspaceRoot: root,
        modelOverride: scriptedModel([
          { content: "", toolCalls: [{ id: "c1", name: "computer_click", arguments: { x: 1, y: 2 } }] },
          { content: "MAIN-DONE" },
        ]),
        petModelOverride: scriptedModel([{ content: "PET-OK" }]),
        tools: [fakeComputerClick(executed)],
        petLane: true,
      });
      sessions.push(session);

      session.driver.submit("主窗同样点一下");
      await until(
        () => session.driver.getStatus().pendingPermission !== null,
        "main lane (workspace mode) parks the landing tool as a pending ask",
      );
      expect(executed.length).toBe(0); // 问而未行——对照面：workspace 档就是逐动作弹授权的根源
    });
  });

  it("(e) sidecar 缺席优雅：未传 sidecar → pet 状态帧 sidecar=null、run 照常落定", async () => {
    await withGlobalHome(undefined, async () => {
      const session = await startUiSession({
        ...base,
        workspaceRoot: mkdtempSync(join(tmpdir(), "o270-e-")),
        modelOverride: scriptedModel([{ content: "MAIN-OK" }]),
        petModelOverride: scriptedModel([{ content: "PET-OK" }]),
        tools: [],
        petLane: true,
      });
      sessions.push(session);
      expect((session.petDriver!.getStatus() as { sidecar: unknown }).sidecar).toBe(null); // 缺席诚实（无实例→无审计段）
      session.petDriver!.submit("精灵问题");
      await until(() => session.petDriver!.getStatus().busy === false, "pet run settles without a sidecar");
    });
  });
});

// （标记注释收尾——本文件头部恰 1 枚，此处不再重复标记串）
