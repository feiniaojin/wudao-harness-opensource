// ω99-235: #4 — 小精灵会话隔离（用户四指令 ②「你在小精灵的会话和主窗口应该
// 是独立和隔离的」）：pet 独立车道的 cli 域行为面，先红后绿。车道即隔离单位——
// pet 不是主 driver 的一个输入源，而是同进程第二 driver session：固定
// sessionId "pet"、独立 pet.jsonl、独立 run 状态机、独立权限卡；主窗
// resume("pet") 撞 pet 车道租约 → occupied（225 三态真话）。
// ★红线（09-09 用户令）：夹具只写 mkdtemp(os.tmpdir())，全程不删任何文件。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool } from "@wudao-org/core";
import type { ModelClient, ModelInput, Tool } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { startUiSession, PET_SESSION_ID, type UiSession } from "../src/ui.js";
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

/** A scripted model that never trips the auto-title fork (title probes get a
 *  canned reply; conversation calls draw the script). Optionally captures the
 *  tool names of each conversation call (R1-f 的枚举对照观察面). */
function scriptedModel(replies: readonly string[], capturedTools?: string[][]): ModelClient {
  let i = 0;
  return {
    async generate(input: ModelInput) {
      if (input.querySource === TITLE_QUERY_SOURCE) return { role: "assistant", content: "标题" };
      capturedTools?.push((input.tools ?? []).map((t) => t.name));
      const r = replies[i];
      i += 1;
      if (r === undefined) throw new Error("scripted replies exhausted");
      return { role: "assistant", content: r };
    },
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

const petJsonl = (root: string): string => join(root, ".wudao", "sessions", "pet.jsonl");

describe("ω99-235 小精灵独立车道（startUiSession petLane）", () => {
  it("(a) petLane:true → 第二 driver 在场：sessionId==='pet'、与主 driver 不同实例、车道锁 pid=本进程", async () => {
    const root = mkdtempSync(join(tmpdir(), "o235-pet-a-"));
    const session = await startUiSession({
      ...base,
      workspaceRoot: root,
      modelOverride: scriptedModel(["MAIN-OK"]),
      petModelOverride: scriptedModel(["PET-OK"]),
      tools: [],
      petLane: true,
    });
    sessions.push(session);
    expect(session.petDriver).toBeDefined();
    expect(session.petDriver!.getSessionId()).toBe(PET_SESSION_ID);
    expect(session.petDriver!).not.toBe(session.driver);
    // 车道锁：.leases/pet.json 落盘，payload 形状与 core 租约同构（pid 活体）。
    const lockPath = join(root, ".wudao", "sessions", ".leases", "pet.json");
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    expect(lock.pid).toBe(process.pid);
  });

  it("(b) petLane 缺省 false → 零第二 driver（既有行为钉），也不落车道锁", async () => {
    const root = mkdtempSync(join(tmpdir(), "o235-pet-b-"));
    const session = await startUiSession({
      ...base,
      workspaceRoot: root,
      modelOverride: scriptedModel(["MAIN-OK"]),
      tools: [],
    });
    sessions.push(session);
    expect((session as { petDriver?: unknown }).petDriver).toBeUndefined();
    expect(existsSync(join(root, ".wudao", "sessions", ".leases", "pet.json"))).toBe(false);
  });

  it("(c) pet 提交落 pet.jsonl 不碰主 jsonl；pet 车道不写 session_name（显示层固定「小精灵」）", async () => {
    const root = mkdtempSync(join(tmpdir(), "o235-pet-c-"));
    const session = await startUiSession({
      ...base,
      workspaceRoot: root,
      modelOverride: scriptedModel(["MAIN-OK"]),
      petModelOverride: scriptedModel(["PET-ANSWER"]),
      tools: [],
      petLane: true,
    });
    sessions.push(session);

    session.petDriver!.submit("精灵第一问");
    await until(
      () => {
        try {
          const text = readFileSync(petJsonl(root), "utf8");
          return text.includes("精灵第一问") && text.includes("PET-ANSWER");
        } catch {
          return false;
        }
      },
      "pet run settles + the exchange lands in pet.jsonl",
    );
    const petText = readFileSync(petJsonl(root), "utf8");
    expect(petText).toContain("精灵第一问");
    expect(petText).toContain("PET-ANSWER");
    // 车道隔离：autoTitle 关闭——固定 id 车道不写 session_name 条目。
    expect(petText).not.toContain("session_name");

    // 主 jsonl：fresh 主会话从未提交 → ω99-211 落盘延迟，文件不存在，更无精灵转写。
    const mainFile = join(root, ".wudao", "sessions", `${session.driver.getSessionId()}.jsonl`);
    expect(existsSync(mainFile)).toBe(false);
  });

  // ω99-270: #3 — 235 时代的「精灵车道未获托付」钳制已被 09-10 用户令推翻：
  // 「我都用小精灵了，还找我要权限」——唤起小精灵=托付行为本身，精灵车道恒
  // auto（本测试随弧演进：pet 断言 workspace→auto，标题同步）。
  it("(d) mode 钳制退役：全局默认档 auto → 主 driver=auto、pet driver=auto（用小精灵=托付本身，ω99-270）", async () => {
    const root = mkdtempSync(join(tmpdir(), "o235-pet-d-"));
    const home = mkdtempSync(join(tmpdir(), "o235-pet-d-home-"));
    mkdirSync(join(home), { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: "auto" } }), "utf8");
    const prev = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    try {
      const session = await startUiSession({
        ...base,
        workspaceRoot: root,
        modelOverride: scriptedModel(["MAIN-OK"]),
        petModelOverride: scriptedModel(["PET-OK"]),
        tools: [],
        petLane: true,
      });
      sessions.push(session);
      expect(session.driver.getStatus().mode).toBe("auto"); // 主车道照常起步于持久默认档
      expect(session.petDriver!.getStatus().mode).toBe("auto"); // 精灵车道恒托付（ω99-270 钳制退役）
    } finally {
      if (prev === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = prev;
    }
  });

  it("(e) 主 run 进行中 pet 提交不入主 run steering：两 driver 各自 run/落盘互不渗漏", async () => {
    const root = mkdtempSync(join(tmpdir(), "o235-pet-e-"));
    let releaseMain!: () => void;
    const mainGate = new Promise<void>((r) => {
      releaseMain = r;
    });
    const mainModel: ModelClient = {
      async generate(input: ModelInput) {
        if (input.querySource === TITLE_QUERY_SOURCE) return { role: "assistant", content: "标题" };
        await mainGate;
        return { role: "assistant", content: "MAIN-DONE" };
      },
    };
    const session = await startUiSession({
      ...base,
      workspaceRoot: root,
      modelOverride: mainModel,
      petModelOverride: scriptedModel(["PET-DONE"]),
      tools: [],
      petLane: true,
    });
    sessions.push(session);

    session.driver.submit("主窗长任务");
    await until(() => session.driver.getStatus().busy === true, "main run busy");

    // 主 run 挂起期间精灵独立提问——同进程第二 driver，自己的队列自己的落盘。
    session.petDriver!.submit("精灵独立问题");
    await until(
      () => {
        try {
          return session.petDriver!.getStatus().busy === false && readFileSync(petJsonl(root), "utf8").includes("PET-DONE");
        } catch {
          return false;
        }
      },
      "pet run settles (exchange in pet.jsonl) while main is held",
    );
    const petText = readFileSync(petJsonl(root), "utf8");
    expect(petText).toContain("精灵独立问题");
    expect(petText).toContain("PET-DONE");
    // 精灵提问既没 steer 主 run（主仍在忙），也没进主转写。
    expect(session.driver.getStatus().busy).toBe(true);
    expect(session.driver.getHistory().some((e) => e.kind === "user" && e.text === "精灵独立问题")).toBe(false);

    releaseMain();
    // ω99-270 弧内加固（同弧第二处，标记只在 (d)）——until 条件必须与断言同强：
    // settle 翻 busy 与建文件之后，
    // 尾部 assistant 消息是异步刷盘（217 引擎特性）——只等 busy=false 会撞上
    // 「文件在、MAIN-DONE 未落」的读窗（高载电池下两次复现）。等文内含
    // MAIN-DONE 才读，竞态从根上关闭。
    await until(
      () => {
        try {
          return session.driver.getStatus().busy === false
            && readFileSync(join(root, ".wudao", "sessions", `${session.driver.getSessionId()}.jsonl`), "utf8").includes("MAIN-DONE");
        } catch {
          return false;
        }
      },
      "main run settles (trailing assistant message flushed)",
    );
    const mainText = readFileSync(join(root, ".wudao", "sessions", `${session.driver.getSessionId()}.jsonl`), "utf8");
    expect(mainText).toContain("MAIN-DONE");
    expect(mainText).not.toContain("精灵独立问题");
    expect(petText).not.toContain("主窗长任务");
  });

  it("(f) 降配钉：extraTools（terminal/lsp/MCP/extensions 形）只进主车道，pet 工具集带 builtin 全集且无它们", async () => {
    const root = mkdtempSync(join(tmpdir(), "o235-pet-f-"));
    const stubTool = (name: string): Tool =>
      buildTool({
        name,
        description: "poisoned stub",
        parameters: { type: "object", properties: { x: { type: "string" } }, required: [], additionalProperties: false },
        execute: async () => ({ content: "stub" }),
      });
    const poisoned = [stubTool("mcp__evil_tools_run"), stubTool("terminal_history_stub"), stubTool("lsp_hover_stub")];
    const mainTools: string[][] = [];
    const petTools: string[][] = [];
    const session = await startUiSession({
      ...base,
      workspaceRoot: root,
      // 不传 tools → 两车道都跑真 buildToolSet（pet 带 builtin 全集的钉）。
      modelOverride: scriptedModel(["MAIN-OK"], mainTools),
      petModelOverride: scriptedModel(["PET-OK"], petTools),
      extraTools: poisoned,
      petLane: true,
    });
    sessions.push(session);

    session.driver.submit("主窗问题");
    await until(() => session.driver.getStatus().busy === false && mainTools.length > 0, "main run + capture");
    session.petDriver!.submit("精灵问题");
    await until(() => session.petDriver!.getStatus().busy === false && petTools.length > 0, "pet run + capture");

    const petNames = petTools[0] ?? [];
    const mainNames = mainTools[0] ?? [];
    // 主车道收下进程级纠葛工具（对照组）……
    expect(mainNames).toContain("mcp__evil_tools_run");
    expect(mainNames).toContain("terminal_history_stub");
    expect(mainNames).toContain("lsp_hover_stub");
    // ……pet 车道一个都没有，且 builtin 全集在场。
    expect(petNames).not.toContain("mcp__evil_tools_run");
    expect(petNames).not.toContain("terminal_history_stub");
    expect(petNames).not.toContain("lsp_hover_stub");
    expect(petNames.some((n) => n.startsWith("mcp__"))).toBe(false);
    expect(petNames).toContain("shell");
    expect(petNames).toContain("read_file");
  });

  it("(g) 主 driver resume(\"pet\") → occupied（租约互斥继承：车道锁对主车道是活的外部持有者）", async () => {
    const root = mkdtempSync(join(tmpdir(), "o235-pet-g-"));
    const session = await startUiSession({
      ...base,
      workspaceRoot: root,
      modelOverride: scriptedModel(["MAIN-OK"]),
      petModelOverride: scriptedModel(["PET-OK"]),
      tools: [],
      petLane: true,
    });
    sessions.push(session);
    // pet.jsonl 先物化（resume 对零条目 id 报 not_found——先有一轮精灵问答）。
    session.petDriver!.submit("精灵的问题");
    await until(
      () => {
        try {
          return readFileSync(petJsonl(root), "utf8").includes("精灵的问题");
        } catch {
          return false;
        }
      },
      "pet.jsonl materializes with the pet exchange",
    );

    const outcome = await session.driver.resume(PET_SESSION_ID);
    expect(outcome).toEqual({ ok: false, reason: "occupied", holderPid: process.pid });
    // 拒绝后主车道原样：会话 id 未被接管、主 jsonl 仍未物化。
    expect(session.driver.getSessionId()).not.toBe(PET_SESSION_ID);
    expect(existsSync(join(root, ".wudao", "sessions", `${session.driver.getSessionId()}.jsonl`))).toBe(false);
  });
});
