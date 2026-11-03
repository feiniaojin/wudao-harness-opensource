// P1-7 (96 队列) — /worktree driver E2E (tmp git repo): the OPERATION root
// switches at the turn boundary (enter → the next run's shell cwd is
// the worktree; exit → back to the original root), while the SESSION root
// stays pinned — the worktree_enter/worktree_exit entries and every .wudao
// write land in the ORIGINAL repo, never inside the worktree. remove is
// refused on uncommitted changes (CC 同款防丢) and while a run is in flight;
// enter in a worktree refuses (no nesting); a busy enter QUEUES to the run's
// settle (the /provider discipline).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore, createScriptedModel } from "@wudao-org/core";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { buildToolSet } from "../src/tools.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";

const execFile = promisify(execFileCb);
const git = (cwd: string, ...args: string[]): Promise<{ stdout: string }> =>
  execFile("git", [...args], { cwd, encoding: "utf8" });

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const exists = async (p: string): Promise<boolean> =>
  (await stat(p).catch(() => undefined)) !== undefined;

/** until() for async conditions (fs checks). */
async function untilA(cond: () => Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const allow = async () => ({ behavior: "allow" as const });

const commandTurn = (command: string): AssistantMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id: `c-${command}`, name: "shell", arguments: { command } }],
});

const noticesOf = (driver: AgentDriver): string =>
  driver.getHistory().map((e) => (e.kind === "notice" ? e.text : "")).join("\n");

/** Wait until the driver's notices contain `needle` (the /worktree ops are
 *  fire-and-forget async — their receipts are the sync point). The timeout
 *  error carries the notices seen so far — the receipt TEXT is the
 *  diagnosis (refused vs failed vs never-issued). */
async function untilNotice(driver: AgentDriver, needle: string, what: string, timeoutMs = 4000): Promise<void> {
  try {
    await until(() => noticesOf(driver).includes(needle), what, timeoutMs);
  } catch (err) {
    throw new Error(`${(err as Error).message}\nnotices so far:\n${noticesOf(driver)}`);
  }
}

/** The production-shaped wiring: ONE shared agentRootBox (buildToolSet's
 *  builtin tools + shell read it at EXECUTION time; applyAgentRoot
 *  writes it), a stubbed worktree rescan seam (tests never touch the real
 *  extension runtime), and a scripted model that records every ModelInput. */
function makeWorktreeDriver(
  root: string,
  box: { current: string },
  opts: {
    script: readonly AssistantMessage[];
    onPermissionAsk?: AgentDriverOptions["onPermissionAsk"];
  },
): { driver: AgentDriver; seen: ModelInput[]; rescans: string[] } {
  const seen: ModelInput[] = [];
  const scripted = createScriptedModel(opts.script);
  const model: ModelClient = {
    generate: (input: ModelInput) => {
      seen.push(input);
      return scripted.generate(input);
    },
  };
  const rescans: string[] = [];
  const tools: Tool[] = buildToolSet({
    workspaceRoot: root,
    agentRootBox: box,
    model,
    canUseTool: allow,
    contextWindowTokens: 64_000,
  });
  const driver = createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model,
    tools,
    ...(opts.onPermissionAsk ? { onPermissionAsk: opts.onPermissionAsk } : {}),
    gates: { todo: false, verify: false },
    workspaceRoot: root,
    agentRootBox: box,
    worktreeRescan: async (at) => {
      rescans.push(at);
      return { skills: 0, plugins: 0, hooks: 0 };
    },
  });
  return { driver, seen, rescans };
}

describe("P1-7 — /worktree driver E2E (turn-boundary switch, session root pinned)", () => {
  let repo: string;
  let home: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "wudao-wtd-repo-"));
    home = await mkdtemp(join(tmpdir(), "wudao-wtd-home-"));
    await writeFile(join(repo, "a.txt"), "A\n", "utf8");
    await git(repo, "init", "-q");
    await git(repo, "add", "a.txt");
    await git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
    savedHome = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
    else process.env.WUDAO_GLOBAL_HOME = savedHome;
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("enter (idle): the next run's shell cwd is the worktree; the session root stays pinned", async () => {
    const box = { current: repo };
    const { driver, seen, rescans } = makeWorktreeDriver(repo, box, {
      script: [commandTurn("pwd"), { role: "assistant", content: "DONE" }],
      onPermissionAsk: async () => ({ kind: "allow" }),
    });
    expect(driver.submit("/worktree enter fix-x")).toBe("notice");
    await untilNotice(driver, "已进入 worktree fix-x", "enter receipt"); // ω99-166f-i: 钉随源演进
    const wt = box.current;
    expect(box.current).not.toBe(repo);
    // git's toplevel is the canonical spelling (macOS /var → /private/var).
    expect(wt).toBe(join(await realpath(repo), ".wudao", "wt", "main", "fix-x-1"));
    expect(noticesOf(driver)).toContain("wudao/main/fix-x-1");
    // The extension face was rescanned AT the worktree root (constraint 5).
    expect(rescans).toEqual([wt]);

    driver.submit("where are we");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const pwd = driver.state.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    const norm = (p: string): string => p.toLowerCase().split("\\").join("/");
    // The worktree nests under the repo's .wudao — the honest cwd assertion
    // is the WORKTREE realpath itself (a bare-repo pwd would lack the
    // .wudao/wt/main segment).
    const wtReal = await realpath(wt);
    expect(norm(pwd).includes(norm(wtReal))).toBe(true);

    // Bare /worktree reports the live state.
    driver.submit("/worktree");
    expect(noticesOf(driver)).toContain("fix-x");
    expect(noticesOf(driver)).toContain("进入时间"); // ω99-174: 钉随源演进

    // RED LINE 1 — persistence pinned: the entry + nothing else lands under
    // the ORIGINAL root; the worktree never grows a .wudao.
    const store = createJsonlSessionStore(join(repo, ".wudao", "sessions"));
    const sid = driver.getSessionId();
    const entries = await store.loadSessionEntries(sid);
    expect(entries.some((e) => !("role" in e) && e.type === "worktree_enter")).toBe(true);
    await expect(exists(join(wt, ".wudao"))).resolves.toBe(false);
    driver.dispose();
  });

  it("exit keep (idle): the operation root returns to the original, the tree and branch remain", async () => {
    const box = { current: repo };
    const { driver } = makeWorktreeDriver(repo, box, {
      script: [{ role: "assistant", content: "x" }],
    });
    driver.submit("/worktree enter fix-x");
    await untilNotice(driver, "已进入 worktree fix-x", "enter receipt"); // ω99-166f-i: 钉随源演进
    const wt = box.current;

    driver.submit("/worktree exit keep");
    await untilNotice(driver, "已退出 worktree fix-x（keep）", "keep receipt"); // ω99-166f-i: 钉随源演进
    expect(box.current).toBe(repo);
    expect(await driver.agentRootStatus()).toMatchObject({ agentRoot: repo, panelRoot: repo });
    await expect(exists(wt)).resolves.toBe(true);
    expect((await git(repo, "branch", "--list", "wudao/main/fix-x-1")).stdout).toContain("wudao/main/fix-x-1");
    const entries = await createJsonlSessionStore(join(repo, ".wudao", "sessions")).loadSessionEntries(driver.getSessionId());
    expect(entries.some((e) => !("role" in e) && e.type === "worktree_exit")).toBe(true);
    driver.dispose();
  });

  it("exit remove (idle, clean): root returns AND the tree + branch are deleted", async () => {
    const box = { current: repo };
    const { driver } = makeWorktreeDriver(repo, box, {
      script: [{ role: "assistant", content: "x" }],
    });
    driver.submit("/worktree enter gone");
    await untilNotice(driver, "已进入 worktree gone", "enter receipt"); // ω99-166f-i: 钉随源演进
    const wt = box.current;

    driver.submit("/worktree exit remove");
    // The whole exit is fire-and-forget: root back FIRST, then removal —
    // wait for the RECEIPT (it lands after worktree remove AND branch -d).
    await untilNotice(driver, "已退出 worktree gone（remove）", "remove receipt"); // ω99-166f-i: 钉随源演进
    expect(box.current).toBe(repo);
    await expect(exists(wt)).resolves.toBe(false);
    expect((await git(repo, "branch", "--list", "wudao/main/gone-1")).stdout.trim()).toBe("");
    driver.dispose();
  });

  it("RED LINE 2 — exit remove with uncommitted changes is refused; only keep is offered, nothing moves", async () => {
    const box = { current: repo };
    const { driver } = makeWorktreeDriver(repo, box, {
      script: [{ role: "assistant", content: "x" }],
    });
    driver.submit("/worktree enter dirty");
    await untilNotice(driver, "已进入 worktree dirty", "enter receipt"); // ω99-166f-i: 钉随源演进
    const wt = box.current;
    await writeFile(join(wt, "wip.txt"), "wip\n", "utf8");

    driver.submit("/worktree exit remove");
    await untilNotice(driver, "拒绝 /worktree exit remove：worktree 中有未提交变更", "dirty-remove refusal"); // ω99-166c-iv: 钉随源演进（:4296 模板 + wt:101 reason 中文化）。
    expect(noticesOf(driver)).toContain("keep");
    // Nothing moved: still in the worktree, the file survives.
    expect(box.current).toBe(wt);
    await expect(exists(join(wt, "wip.txt"))).resolves.toBe(true);
    // keep still works after the refusal.
    driver.submit("/worktree exit keep");
    await untilNotice(driver, "已退出 worktree dirty（keep）", "keep exit after refusal"); // ω99-166f-i: 钉随源演进
    expect(box.current).toBe(repo);
    await expect(exists(join(wt, "wip.txt"))).resolves.toBe(true);
    driver.dispose();
  });

  it("hard constraint 4 — enter while a run is in flight QUEUES to the settle (the /provider discipline)", async () => {
    let askEntered = false;
    let releaseAsk: (() => void) | null = null;
    const askGate = new Promise<void>((r) => {
      releaseAsk = r;
    });
    const box = { current: repo };
    const { driver } = makeWorktreeDriver(repo, box, {
      script: [
        commandTurn("echo mid"),
        { role: "assistant", content: "MID" },
        commandTurn("pwd"),
        { role: "assistant", content: "AFTER" },
      ],
      onPermissionAsk: async () => {
        askEntered = true;
        await askGate;
        return { kind: "allow" };
      },
    });
    driver.submit("mid run");
    await until(() => askEntered, "shell ask to park (run is busy)");
    expect(driver.submit("/worktree enter queued")).toBe("notice");
    await untilNotice(driver, "切换在其收束时落地", "queued-enter receipt"); // ω99-166f-i: 钉随源演进（brief 二节漏判的钉——:4243 在飞排队 enter 回执子串）
    expect(box.current).toBe(repo); // nothing moved mid-run

    releaseAsk?.();
    await until(() => box.current !== repo, "parked enter to land at settle");
    await until(() => driver.getStatus().busy === false, "run to settle");
    const wt = box.current;
    // The bookkeeping landed with the switch: bare status is live, the entry
    // is in the ORIGINAL root's JSONL (the append is fire-and-forget — poll).
    expect(noticesOf(driver)).toContain("wudao/main/queued-1");
    const store = createJsonlSessionStore(join(repo, ".wudao", "sessions"));
    await untilA(async () =>
      (await store.loadSessionEntries(driver.getSessionId())).some((e) => !("role" in e) && e.type === "worktree_enter"),
      "worktree_enter entry",
    );

    driver.submit("after run");
    await until(() => driver.getStatus().busy === false, "after run");
    const lastPwd = driver.state.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    const norm = (p: string): string => p.toLowerCase().split("\\").join("/");
    expect(norm(lastPwd)).toContain(norm(await realpath(wt)));
    driver.dispose();
  });

  it("exit remove while a run is in flight is REFUSED (destructive ops never queue)", async () => {
    let askEntered = false;
    let releaseAsk: (() => void) | null = null;
    const askGate = new Promise<void>((r) => {
      releaseAsk = r;
    });
    const box = { current: repo };
    const { driver } = makeWorktreeDriver(repo, box, {
      script: [commandTurn("echo mid"), { role: "assistant", content: "MID" }],
      onPermissionAsk: async () => {
        askEntered = true;
        await askGate;
        return { kind: "allow" };
      },
    });
    driver.submit("/worktree enter busy-exit");
    await untilNotice(driver, "已进入 worktree busy-exit", "enter receipt"); // ω99-166f-i: 钉随源演进
    const wt = box.current;
    driver.submit("mid run");
    await until(() => askEntered, "shell ask to park (run is busy)");
    driver.submit("/worktree exit remove");
    await untilNotice(driver, "拒绝 /worktree exit remove：运行进行中", "busy-remove refusal"); // ω99-166c-iv: 钉随源演进（ad:4268 拒绝面中文化）。
    expect(box.current).toBe(wt); // still in the worktree
    releaseAsk?.();
    await until(() => driver.getStatus().busy === false, "run to settle");
    await expect(exists(wt)).resolves.toBe(true); // nothing was deleted
    driver.dispose();
  });

  it("hard constraint 4 (nesting) — enter while already in a worktree refuses", async () => {
    const box = { current: repo };
    const { driver } = makeWorktreeDriver(repo, box, {
      script: [{ role: "assistant", content: "x" }],
    });
    driver.submit("/worktree enter one");
    await untilNotice(driver, "已进入 worktree one", "first enter receipt"); // ω99-166f-i: 钉随源演进
    const wt = box.current;
    driver.submit("/worktree enter two");
    await untilNotice(driver, "已在 worktree 中", "nesting refusal"); // ω99-166c-iv: 钉随源演进（ad:4205 嵌套拒绝面中文化）。
    expect(box.current).toBe(wt);
    expect(box.current).toBe(wt);
    // No second tree was created.
    const siblings = await readdir(join(repo, ".wudao", "wt", "main")).catch(() => [] as string[]);
    expect(siblings.some((s) => s.includes("two"))).toBe(false);
    driver.dispose();
  });

  it("hard constraint 3 — enter on a non-git root refuses with the fix named", async () => {
    const plain = await mkdtemp(join(tmpdir(), "wudao-wtd-plain-"));
    try {
      const box = { current: plain };
      const { driver } = makeWorktreeDriver(plain, box, { script: [{ role: "assistant", content: "x" }] });
      driver.submit("/worktree enter x");
      await untilNotice(driver, "不是 git 仓库", "non-git refusal"); // ω99-166c-iv: 钉随源演进（wt:71 插值源随 :4296 模板下发）。
      expect(box.current).toBe(plain);
      driver.dispose();
    } finally {
      await rm(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("usage grammar: bare exit and junk verbs answer with usage; status works before any enter", async () => {
    const box = { current: repo };
    const { driver } = makeWorktreeDriver(repo, box, { script: [{ role: "assistant", content: "x" }] });
    driver.submit("/worktree");
    expect(noticesOf(driver)).toContain("不在 worktree 中"); // ω99-166c-iv: 钉随源演进（status 面 formatWorktreeStatus :136 同族强制收口）。
    driver.submit("/worktree exit");
    expect(noticesOf(driver)).toContain("用法"); // ω99-166e-ii: 钉演进（junk verb 回执即 WORKTREE_USAGE 块，头词中文化）
    driver.submit("/worktree dance");
    expect(noticesOf(driver)).toContain("用法"); // ω99-166e-ii: 钉演进（junk verb 回执即 WORKTREE_USAGE 块，头词中文化）
    driver.submit("/worktree exit junk");
    expect(noticesOf(driver)).toContain("用法"); // ω99-166e-ii: 钉演进（junk verb 回执即 WORKTREE_USAGE 块，头词中文化）
    driver.dispose();
  });

  it("a queued enter superseded by an explicit agentRootSwitch cancels cleanly (last write wins)", async () => {
    let askEntered = false;
    let releaseAsk: (() => void) | null = null;
    const askGate = new Promise<void>((r) => {
      releaseAsk = r;
    });
    const other = await mkdtemp(join(tmpdir(), "wudao-wtd-other-"));
    try {
      await writeFile(join(other, "o.txt"), "O\n", "utf8");
      const box = { current: repo };
      const { driver } = makeWorktreeDriver(repo, box, {
        script: [commandTurn("echo mid"), { role: "assistant", content: "MID" }],
        onPermissionAsk: async () => {
          askEntered = true;
          await askGate;
          return { kind: "allow" };
        },
      });
      driver.submit("mid");
      await until(() => askEntered, "ask to park");
      driver.submit("/worktree enter superseded");
      await untilNotice(driver, "切换在其收束时落地", "queued enter to park"); // ω99-166f-i: 钉随源演进（brief 二节漏判的钉——:4243 在飞排队 enter 回执子串）
      // The explicit switch supersedes the queued worktree enter.
      await expect(driver.agentRootSwitch(other)).resolves.toEqual({ applied: false, queued: true });
      expect(noticesOf(driver)).toContain("superseded");
      releaseAsk?.();
      await until(() => box.current === other, "the explicit switch to land");
      // The created worktree directory was LEFT in place (nothing destroyed).
      await expect(exists(join(repo, ".wudao", "wt", "main", "superseded-1"))).resolves.toBe(true);
      driver.dispose();
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
