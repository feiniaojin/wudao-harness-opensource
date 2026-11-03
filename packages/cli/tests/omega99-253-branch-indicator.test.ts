// ω99-253: #9 — 工作区分支指示（cli 读面 + 状态帧纪律）。全 mock：runner/
// reader 一律注入，测试链零真 git spawn（红线——读缝 spawn 是运行时行为）。
// R1 读面：仓库→分支名；detached→"HEAD"（诚实显示）；非仓库/读失败/空输出→
// null 绝不抛；缓存失效点=run settle 边界刷新钉（脚本化两次不同分支）。
// R2 状态帧：DriverStatus.gitBranch 字段在场形/null 形；emit 路径不逐帧
// spawn——多次状态帧只读一次直到失效点（mock 计数钉）；无 workspaceRoot
// 的 stub 驱动零读零 spawn（pet/schedules 车道同根同面，无隔离特殊处理）。
// 面三 TUI 同源钉：StatuslineSnapshot 携带 gitBranch、单行形式挂段、缺场
// 省略（statusline.ts 是 TUI 底栏的唯一数据源——同一条 DriverStatus 数据）。
import { describe, it, expect } from "vitest";
import { createScriptedModel } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { readGitBranch } from "../src/git-branch.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions, DriverStatus } from "../src/driver/agent-driver.js";
import { buildStatuslineSnapshot, formatStatuslineLine } from "../src/statusline.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** The injectable runner's result shape (git-branch.ts's contract): a stdout
 *  string on exit 0, undefined on a failed call (exit ≠ 0 / timeout), null on
 *  a missing binary. The REJECTING form exercises the never-throws seam. */
type RunnerResult = { stdout: string } | null | undefined;
const runner = (over: (args: readonly string[], cwd: string) => RunnerResult | Promise<RunnerResult>) =>
  async (args: readonly string[], cwd: string): Promise<RunnerResult> => over(args, cwd);

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// R1 — the read face (unit, all-mock).
// ---------------------------------------------------------------------------
describe("ω99-253 R1 — readGitBranch（读面单元，全 mock）", () => {
  it("仓库：rev-parse --abbrev-ref HEAD 的 stdout 即分支名", async () => {
    const seen: string[][] = [];
    const b = await readGitBranch("/w/proj", runner((args, cwd) => {
      seen.push([...args]);
      expect(cwd).toBe("/w/proj");
      return { stdout: "feature/x\n" };
    }));
    expect(b).toBe("feature/x");
    // 单调用纪律：一次读恰一枚 spawn、恰这一个参数形。
    expect(seen).toEqual([["rev-parse", "--abbrev-ref", "HEAD"]]);
  });

  it("detached：stdout 'HEAD' 原样返回——诚实显示，绝不改写成分支名猜测", async () => {
    const b = await readGitBranch("/w/proj", runner(() => ({ stdout: "HEAD\n" })));
    expect(b).toBe("HEAD");
  });

  it("非仓库：命令失败（exit ≠ 0）→ null", async () => {
    const b = await readGitBranch("/w/plain-dir", runner(() => undefined));
    expect(b).toBeNull();
  });

  it("git 二进制缺失（ENOENT）→ null", async () => {
    const b = await readGitBranch("/w/proj", runner(() => null));
    expect(b).toBeNull();
  });

  it("读失败（runner 抛出）→ null 绝不抛——失败 null 不进主链", async () => {
    const b = await readGitBranch(
      "/w/proj",
      runner(() => {
        throw new Error("spawn EAGAIN");
      }),
    );
    expect(b).toBeNull();
  });

  it("空输出/纯空白 → null（绝不把空串当分支名）", async () => {
    expect(await readGitBranch("/w/proj", runner(() => ({ stdout: "" })))).toBeNull();
    expect(await readGitBranch("/w/proj", runner(() => ({ stdout: "  \n" })))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R1/R2 — the driver wiring (boot read + settle-boundary refresh + the
// never-per-frame spawn discipline).
// ---------------------------------------------------------------------------
describe("ω99-253 R1/R2 — DriverStatus.gitBranch（boot 读 + run settle 刷新）", () => {
  it("boot 一次读：字段在场、值=注入 reader 的返回", async () => {
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      workspaceRoot: "/w/proj",
      gitBranchReader: async () => "main",
    });
    await until(() => driver.getStatus().gitBranch === "main", "boot branch read to land");
    const status: DriverStatus = driver.getStatus();
    expect(status.gitBranch).toBe("main");
    driver.dispose();
  });

  it("读失败 → null 在场（null 形），绝不抛进主链", async () => {
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      workspaceRoot: "/w/proj",
      gitBranchReader: async () => {
        throw new Error("nope");
      },
    });
    await wait(30);
    expect(driver.getStatus().gitBranch).toBeNull();
    driver.dispose();
  });

  it("非 git 仓库 → null；无 workspaceRoot 的 stub 驱动 → 零读零字段噪音", async () => {
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      workspaceRoot: "/w/plain",
      gitBranchReader: async () => null,
    });
    await wait(30);
    expect(driver.getStatus().gitBranch).toBeNull();
    driver.dispose();

    let reads = 0;
    const stub = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      gitBranchReader: async () => {
        reads += 1;
        return "main";
      },
    });
    await wait(30);
    expect(reads).toBe(0); // 无根 stub 驱动零读——pet/schedules 之外的读全走根门
    expect(stub.getStatus().gitBranch).toBeNull();
    stub.dispose();
  });

  it("缓存失效点=run settle：脚本化两次不同分支，settle 后刷新钉", async () => {
    const branches = ["branch-a", "branch-b"];
    let reads = 0;
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "done" }]),
      tools: [],
      workspaceRoot: "/w/proj",
      gitBranchReader: async () => branches[Math.min(reads++, branches.length - 1)] ?? null,
    });
    await until(() => driver.getStatus().gitBranch === "branch-a", "boot read (branch-a)");
    expect(reads).toBe(1);

    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    // run settle 边界刷新：第二次读（branch-b）落进状态面。
    await until(() => driver.getStatus().gitBranch === "branch-b", "settle refresh (branch-b)");
    expect(reads).toBe(2);
    driver.dispose();
  });

  it("R2 emit 不逐帧 spawn：多次状态帧（refreshStatus×5）只读一次直到失效点", async () => {
    let reads = 0;
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      workspaceRoot: "/w/proj",
      gitBranchReader: async () => {
        reads += 1;
        return "main";
      },
    });
    await until(() => reads === 1, "boot read fired once");
    // 5 次状态帧重广播 + 反复 getStatus：读计数钉在 1（缓存值，非逐帧 spawn）。
    driver.refreshStatus();
    driver.refreshStatus();
    driver.refreshStatus();
    driver.refreshStatus();
    driver.refreshStatus();
    driver.getStatus();
    driver.getStatus();
    await wait(50);
    expect(reads).toBe(1);
    expect(driver.getStatus().gitBranch).toBe("main");
    driver.dispose();
  });
});

// ---------------------------------------------------------------------------
// 面三 — the TUI's同源 data face (statusline.ts is the TUI bar's single source).
// ---------------------------------------------------------------------------
describe("ω99-253 面三 — TUI 同源面（StatuslineSnapshot 折叠 + 单行形式）", () => {
  const base = {
    live: { reasoning: "", answer: "", busyTools: [] },
    busy: false,
    queued: [],
    boardProgress: null,
    ctxTokens: null,
    mode: "workspace" as const,
    cachePercent: null,
    bg: { active: 0, spawned: 0 },
    pendingPermission: null,
    planBoard: null,
    sessionId: "wudao-live-0001",
    sidecar: null,
    model: null,
    goal: null,
    language: { reply: "auto" as const, reasoning: "auto" as const },
    gitBranch: "feat/tui-x",
  };

  it("快照折叠：DriverStatus.gitBranch → StatuslineSnapshot.gitBranch（同源直通）", () => {
    const snap = buildStatuslineSnapshot(base as unknown as DriverStatus, { version: "0.0.0", model: "m" });
    expect(snap.gitBranch).toBe("feat/tui-x");
  });

  it("单行形式：分支段挂在 head 之后；detached 'HEAD' 原样", () => {
    const snap = buildStatuslineSnapshot(base as unknown as DriverStatus, { version: "0.0.0", model: "m" });
    const line = formatStatuslineLine(snap);
    expect(line).toContain("feat/tui-x");
    expect(line.indexOf("wudao · m · wudao-li")).toBeLessThan(line.indexOf("feat/tui-x"));
    const detached = formatStatuslineLine(
      buildStatuslineSnapshot({ ...base, gitBranch: "HEAD" } as unknown as DriverStatus, { version: "0.0.0", model: "m" }),
    );
    expect(detached).toContain("HEAD");
  });

  it("缺场（undefined/null）：快照不带字段、单行零分支段（零噪音门）", () => {
    const absent = buildStatuslineSnapshot({ ...base, gitBranch: undefined } as unknown as DriverStatus, { version: "0.0.0", model: "m" });
    expect("gitBranch" in absent).toBe(false);
    expect(formatStatuslineLine(absent)).not.toContain("feat/tui-x");
    const nulled = buildStatuslineSnapshot({ ...base, gitBranch: null } as unknown as DriverStatus, { version: "0.0.0", model: "m" });
    expect("gitBranch" in nulled).toBe(false); // null 同缺场——零渲染语义
  });
});
