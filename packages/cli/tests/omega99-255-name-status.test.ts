// ω99-255: #6 — R1–R5 — 会话名的状态面（面一 receipts）。夜移 005 的 LLM 自动
// 命名只达 TUI 车道（onSessionRenamed）；本弧把「名字落定」升为 DriverStatus
// 的一等字段（与 249 goal / 253 gitBranch 同族——缓存变量 + 纯变量读进
// buildStatus，emit 路径绝不读盘）：①boot/resume 初始化（搭 ω99-217 既有
// boot 读的同一份 entries——零额外文件 IO）；②autoTitle fork appendEntry 落定
// 后置值+emit；③/rename 落点置值；/clear 与 loadHistory 的 id 轮转跟随
// （名字属于会话 id——换会话不携旧名）。值不变零帧（253 零帧纪律同款）。
// 全 mock：scripted model（title 调 querySource 拦截）、零真 git（gitBranchReader
// 注入 null——253 缝）、夹具只写 mkdtemp(tmpdir) 只写不删（红线）。
import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, createJsonlSessionStore } from "@wudao-org/core";
import type { AgentMessage, ModelClient, ModelInput } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    // 253 的注入缝：读分支返回 null——本弧测试零真 git spawn，且分支面零帧噪。
    gitBranchReader: async () => null,
    ...opts,
  });
}

const allow = vi.fn(async () => ({ kind: "allow" as const }));

const tmpWs = (): Promise<string> => mkdtemp(join(tmpdir(), "o255-ws-"));

describe("ω99-255 R1 — autoTitle 落定 → 状态面带名（值不变零帧）", () => {
  it("首 run 成功后 getStatus().sessionName === 标题；落定后不再发帧", async () => {
    const root = await tmpWs();
    const scripted = createScriptedModel([{ role: "assistant", content: "ANSWER" }]);
    const model: ModelClient = {
      generate: async (input: ModelInput) => {
        if (input.querySource === "title") return { role: "assistant", content: '  "修复登录超时"  ' };
        return scripted.generate(input);
      },
    };
    const driver = makeDriver({ model, tools: [], onPermissionAsk: allow, autoTitle: true, workspaceRoot: root });
    await wait();
    // 落定前：无名（新会话，boot 未读出名）。
    expect(driver.getStatus().sessionName).toBe(null);
    driver.submit("我的登录总是超时");
    await until(() => driver.getStatus().busy === false, "run settles");
    await until(() => driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("修复登录超时")), "title lands");
    expect(driver.getStatus().sessionName).toBe("修复登录超时");
    // 值不变零重复帧：落定后静默窗内零新帧（名字是缓存变量，不是重读源）。
    let frames = 0;
    driver.subscribe(() => { frames += 1; });
    const before = driver.getStatus();
    await wait(150);
    expect(frames).toBe(0);
    expect(driver.getStatus()).toBe(before); // 引用稳定（零帧 ⇒ 零重建）
    driver.dispose();
  }, 15_000);
});

describe("ω99-255 R2 — boot/resume 初始化（既有会话带名，零 run 即上脸）", () => {
  it("resume 有 llm 名的会话：不 submit 任何东西，状态面即带名", async () => {
    const root = await tmpWs();
    const sid = "wudao-o255-resume-1";
    const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    await store.appendEntry(sid, { type: "session_name", name: "夜里的既有名", source: "llm" });
    const initialMessages: AgentMessage[] = [
      { role: "user", content: "先前的问题" },
      { role: "assistant", content: "先前的回答" },
    ];
    const driver = makeDriver({
      model: createScriptedModel([]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: root,
      sessionId: sid,
      initialMessages,
    });
    await until(() => driver.getStatus().sessionName === "夜里的既有名", "boot name lands");
    expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("夜里的既有名"))).toBe(false); // boot 读是纯初始化，不产 notice
    driver.dispose();
  });

  it("resume 无名会话（无 session_name 条目）：null 不崩、零帧", async () => {
    const root = await tmpWs();
    const sid = "wudao-o255-resume-2";
    await createJsonlSessionStore(join(root, ".wudao", "sessions")).appendEntry(sid, {
      type: "clear_boundary",
      data: { nextSessionId: sid, at: new Date().toISOString() },
    });
    const driver = makeDriver({
      model: createScriptedModel([]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: root,
      sessionId: sid,
      initialMessages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }],
    });
    await wait(120); // boot 读落地窗
    expect(driver.getStatus().sessionName).toBe(null);
    driver.dispose();
  });
});

describe("ω99-255 R3 — null 语义（stub 驱动 / pet 车道全程 null）", () => {
  it("无 workspaceRoot（stub 驱动）：boot 与 run 全程 null", async () => {
    const scripted = createScriptedModel([{ role: "assistant", content: "OK" }]);
    const driver = makeDriver({ model: scripted, tools: [], onPermissionAsk: allow });
    await wait();
    expect(driver.getStatus().sessionName).toBe(null);
    driver.submit("hi");
    await until(() => driver.getStatus().busy === false, "run settles");
    await wait(50);
    expect(driver.getStatus().sessionName).toBe(null);
    driver.dispose();
  });

  it("pet 形状（autoTitle:false）：run 落定后仍 null——精灵车道不自动命名（235 隔离零演进）", async () => {
    const root = await tmpWs();
    const querySources: string[] = [];
    const scripted = createScriptedModel([{ role: "assistant", content: "OK" }]);
    const model: ModelClient = {
      generate: async (input: ModelInput) => {
        querySources.push(input.querySource ?? "main");
        return scripted.generate(input);
      },
    };
    const driver = makeDriver({ model, tools: [], onPermissionAsk: allow, autoTitle: false, workspaceRoot: root });
    await wait();
    driver.submit("hi");
    await until(() => driver.getStatus().busy === false, "run settles");
    await wait(120); // 即便有迟到的后台 fork 也该保持 null
    expect(driver.getStatus().sessionName).toBe(null);
    expect(querySources).toEqual(["main"]); // 零 title 调用（autoTitle:false 语义零演进）
    driver.dispose();
  });
});

describe("ω99-255 R4 — /rename 缝（M55 §A4 落点 → 状态面跟随）", () => {
  it("submit(\"/rename …\") 落定后 getStatus().sessionName === 新名", async () => {
    const root = await tmpWs();
    const driver = makeDriver({
      model: createScriptedModel([]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: root,
      sessionId: "wudao-o255-rename-1",
    });
    await wait();
    expect(driver.getStatus().sessionName).toBe(null);
    driver.submit("/rename   手改的名 ");
    await until(() => driver.getStatus().sessionName === "手改的名", "rename lands on the status face");
    driver.dispose();
  });
});

describe("ω99-255 R5 — TUI 车道零演进（onSessionRenamed 复钉，夜移 005/235 语义）", () => {
  it("autoTitle 落定 → onSessionRenamed(title) 恰一次；二次 run 不再触发（tried-once）", async () => {
    const root = await tmpWs();
    const scripted = createScriptedModel([
      { role: "assistant", content: "A1" },
      { role: "assistant", content: "A2" },
    ]);
    const renamed: string[] = [];
    const model: ModelClient = {
      generate: async (input: ModelInput) => {
        if (input.querySource === "title") return { role: "assistant", content: "自动标题" };
        return scripted.generate(input);
      },
    };
    const driver = makeDriver({
      model,
      tools: [],
      onPermissionAsk: allow,
      autoTitle: true,
      workspaceRoot: root,
      onSessionRenamed: (n) => { renamed.push(n); },
    });
    await wait();
    driver.submit("first");
    await until(() => renamed.length === 1, "onSessionRenamed fires with the title");
    expect(renamed[0]).toBe("自动标题");
    driver.submit("second");
    await until(() => driver.getStatus().busy === false, "second run settles");
    await wait(80);
    expect(renamed).toEqual(["自动标题"]); // TUI 车道零演进：不重复、不改语义
    driver.dispose();
  }, 15_000);
});
