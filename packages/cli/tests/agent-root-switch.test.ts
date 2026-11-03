// workspace-ux B2 — agentRootSwitch: the agent's SWITCHABLE workspace root
// (idle: immediate; busy: queued to the run-settle seam) and the
// <workspace_changed> MetaNote that tells the model about the new root WITHOUT
// touching the system prompt (M24: the prefix cache must survive the switch).
// The root the builtin file tools resolve against and shell's cwd read
// through the SHARED agentRootBox at execution time; the session store, spill,
// and every .wudao anchor stay at the boot root (the workspace root is not a
// session concept — no id rotation, no boundary entry).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { createScriptedModel } from "@wudao-org/core";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { buildToolSet } from "../src/tools.js";
import { hookCommonFields } from "../src/hooks-config.js";
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

const fileExists = async (p: string): Promise<boolean> =>
  (await stat(p).catch(() => undefined)) !== undefined;

const allow = async () => ({ behavior: "allow" as const });

/** The full switchable wiring: ONE box shared by buildToolSet (the builtin
 *  file tools + shell read it at EXECUTION time) and the driver
 *  (applyAgentRoot writes it). This mirrors what `wudao ui` wires in
 *  production, where index.ts's hookWorkspaceRoot box is the same object. */
function makeSwitchableDriver(
  root: string,
  box: { current: string },
  opts: {
    script: readonly AssistantMessage[];
    onPermissionAsk?: AgentDriverOptions["onPermissionAsk"];
    systemPrompt?: string;
  },
): { driver: AgentDriver; seen: ModelInput[] } {
  const seen: ModelInput[] = [];
  const scripted = createScriptedModel(opts.script);
  const model: ModelClient = {
    generate: (input: ModelInput) => {
      seen.push(input);
      return scripted.generate(input);
    },
  };
  const tools: Tool[] = buildToolSet({
    workspaceRoot: root,
    agentRootBox: box,
    model,
    canUseTool: allow,
    contextWindowTokens: 64_000,
  });
  const driver = createAgentDriver({
    systemPrompt: opts.systemPrompt ?? "s",
    summarize: summarizeToolCall,
    model,
    tools,
    ...(opts.onPermissionAsk ? { onPermissionAsk: opts.onPermissionAsk } : {}),
    // The write-heavy scripts here are turn-exact; the default verify/todo
    // stop gates would inject extra turns after the writes and eat the script.
    gates: { todo: false, verify: false },
    workspaceRoot: root,
    agentRootBox: box,
  });
  return { driver, seen };
}

/** The note text as it rides a ModelInput (inside a message's content —
 *  JSON.stringify would escape the quotes and defeat a substring match). */
const noteIn = (input: ModelInput, needle: string): boolean =>
  input.messages.some((m) => typeof m.content === "string" && m.content.includes(needle));

const writeTurn = (path: string, content = "W"): AssistantMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id: `c-${path}`, name: "write_file", arguments: { path, content } }],
});

const commandTurn = (command: string): AssistantMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id: `c-${command}`, name: "shell", arguments: { command } }],
});

describe("workspace-ux B2 — agentRootSwitch (idle immediate / busy → settle)", () => {
  let rootA: string;
  let rootB: string;
  let home: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    rootA = await mkdtemp(join(tmpdir(), "wudao-sw-a-"));
    rootB = await mkdtemp(join(tmpdir(), "wudao-sw-b-"));
    home = await mkdtemp(join(tmpdir(), "wudao-sw-home-"));
    await mkdir(join(rootA, "sub"));
    await writeFile(join(rootA, "a.txt"), "A");
    await writeFile(join(rootB, "b.md"), "B");
    // Both switch ops record recents through WUDAO_GLOBAL_HOME — pin it to the
    // tmp home so a successful switch never touches the real one.
    savedHome = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
    else process.env.WUDAO_GLOBAL_HOME = savedHome;
    // dispose 的 sessionEnd 迟到落盘会在 rm 走完后重建文件（ENOTEMPTY，
    // 门级负载下两度翻红）——maxRetries 等它落定（turn-diff-faces 先例）。
    for (const d of [rootA, rootB, home]) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("idle switch applies now: write_file allows new-root-relative paths and rejects old-root-relative ones (boundary matrix)", async () => {
    // A path that was INSIDE the old root, expressed relative to the new one —
    // after the switch it must escape (the boundary no longer knows root A).
    const oldRel = join(relative(rootB, rootA), "a.txt");
    const box = { current: rootA };
    const { driver, seen } = makeSwitchableDriver(rootA, box, {
      script: [writeTurn("ok-b.txt"), writeTurn(oldRel), { role: "assistant", content: "DONE" }],
      onPermissionAsk: async () => ({ kind: "allow" }),
    });
    await expect(driver.agentRootSwitch(rootB)).resolves.toEqual({ applied: true, queued: false });
    // The shared box (index.ts's hookWorkspaceRoot in production) followed.
    expect(box.current).toBe(rootB);
    expect((await driver.agentRootStatus()).agentRoot).toBe(rootB);

    driver.submit("write both");
    await until(() => driver.getStatus().busy === false, "run to finish");
    // New-root relative: allowed, and it landed INSIDE root B.
    await expect(fileExists(join(rootB, "ok-b.txt"))).resolves.toBe(true);
    await expect(fileExists(join(rootA, "ok-b.txt"))).resolves.toBe(false);
    // Old-root relative: rejected with the escape error, nothing written.
    const results = driver.state.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results.some((c) => c.includes("path escapes workspace"))).toBe(true);
    await expect(fileExists(join(rootA, "a.txt"))).resolves.toBe(true); // untouched, still the original bytes
    expect(seen.length).toBe(3);
    driver.dispose();
  });

  it("busy switch queues to settle: the in-flight run keeps the OLD root throughout, the next run gets the new one", async () => {
    let askEntered = false;
    let releaseAsk: (() => void) | null = null;
    const askGate = new Promise<void>((r) => {
      releaseAsk = r;
    });
    const box = { current: rootA };
    const { driver, seen } = makeSwitchableDriver(rootA, box, {
      script: [
        writeTurn("a-mid.txt"),
        { role: "assistant", content: "MID DONE" },
        writeTurn("b-after.txt"),
        { role: "assistant", content: "AFTER DONE" },
      ],
      onPermissionAsk: async () => {
        askEntered = true;
        await askGate;
        return { kind: "allow" };
      },
    });
    driver.submit("mid run");
    await until(() => askEntered, "write_file ask to park (run is busy)");
    // Busy → queued, not applied; the reply says so.
    await expect(driver.agentRootSwitch(rootB)).resolves.toEqual({ applied: false, queued: true });
    expect(box.current).toBe(rootA); // nothing moved yet
    // A bad path while busy rejects up front — it never reaches the queue.
    await expect(driver.agentRootSwitch(join(rootA, "nope"))).rejects.toThrow(/no such directory/);

    releaseAsk?.();
    await until(() => driver.getStatus().busy === false, "mid run to settle");
    // The switch landed at the settle seam — AFTER the run that queued it.
    expect(box.current).toBe(rootB);
    expect((await driver.agentRootStatus()).agentRoot).toBe(rootB);
    // The in-flight run wrote under the OLD root (its footing never moved).
    await expect(fileExists(join(rootA, "a-mid.txt"))).resolves.toBe(true);
    await expect(fileExists(join(rootB, "a-mid.txt"))).resolves.toBe(false);
    // The notice landed in the history.
    expect(
      driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("已切换") && e.text.includes(basename(rootB))),
    ).toBe(true);

    driver.submit("after run");
    await until(() => driver.getStatus().busy === false, "after run to settle");
    // The NEXT run writes under the NEW root…
    await expect(fileExists(join(rootB, "b-after.txt"))).resolves.toBe(true);
    await expect(fileExists(join(rootA, "b-after.txt"))).resolves.toBe(false);
    // …and its FIRST model call carries the <workspace_changed> note.
    expect(noteIn(seen[2]!, `<workspace_changed path="${rootB}">`)).toBe(true);
    driver.dispose();
  });

  it("settle seam is externally atomic: at the FIRST status emit where busy===false, the parked root AND its notice have already landed", async () => {
    // The race this pins down (a full-suite-only flake, 2/2 rounds): busy=false
    // is the driver's PUBLIC "idle — you may submit" signal. The parked switch
    // used to land two real-fs awaits AFTER that flip (sameAgentRoot's
    // realpaths, then the recents write inside applyAgentRoot), so a peer
    // reacting to busy===false could read the stale box (round A: box.current
    // still the OLD root) or a missing receipt (round B: notice not yet in
    // history) — and a submit() in the first window started the next run on
    // the OLD root, then had its footing moved mid-run. The seam must flip
    // busy only once everything parked has landed. Observed the way any
    // event-loop peer would: on the first status emit reporting busy===false,
    // snapshot the world — deterministic, no timer races.
    let askEntered = false;
    let releaseAsk: (() => void) | null = null;
    const askGate = new Promise<void>((r) => {
      releaseAsk = r;
    });
    const box = { current: rootA };
    const { driver } = makeSwitchableDriver(rootA, box, {
      script: [
        writeTurn("a-atomic.txt"),
        { role: "assistant", content: "MID DONE" },
        { role: "assistant", content: "AFTER DONE" },
      ],
      onPermissionAsk: async () => {
        askEntered = true;
        await askGate;
        return { kind: "allow" };
      },
    });
    let observed: { root: string; noticeLanded: boolean } | undefined;
    // 观察窗修正（0.4.20 发版排查）：run 起跑前可能有一发 boot 侧的空闲
    // emit（初始化异步面），原观察窗把它当「第一发 busy=false」捕获——读到
    // 的自然是旧根。缝的原子性契约针对的是「停运后的第一发空闲」：先见过
    // busy=true（run 真正起跑），其后的第一发 busy=false 才是判读点。
    let sawBusyRun = false;
    driver.subscribe(() => {
      if (driver.getStatus().busy) sawBusyRun = true;
      if (observed !== undefined || !sawBusyRun || driver.getStatus().busy) return;
      observed = {
        root: box.current,
        noticeLanded: driver.getHistory().some(
          (e) => e.kind === "notice" && e.text.includes("已切换") && e.text.includes(basename(rootB)),
        ),
      };
    });
    driver.submit("mid run");
    await until(() => askEntered, "write_file ask to park (run is busy)");
    await expect(driver.agentRootSwitch(rootB)).resolves.toEqual({ applied: false, queued: true });

    releaseAsk?.();
    await until(() => observed !== undefined, "first idle emit to fire");
    // The switch and its receipt landed BEFORE busy first read false —
    // anything a peer does from that instant on sees the NEW root.
    expect(observed!.root).toBe(rootB);
    expect(observed!.noticeLanded).toBe(true);
    driver.dispose();
  });

  it("M90: a settle-seam throw no longer wedges busy — the error escapes unwrapped and the next submit starts a fresh run", async () => {
    // d33a673's own review follow-up: the busy flip moved AFTER the parked
    // root's landing awaits, so ANY throw inside that segment (here: a
    // history listener failing on the receipt notice inside applyAgentRoot —
    // the segment's unguarded sync surface) skipped the flip entirely.
    // busy stayed true forever: every later submit parked ("steered") and no
    // run ever started again. The flip must land on EVERY exit of the
    // segment; the throw itself keeps escaping the run body unwrapped
    // (observed the way the process observes it — the same discipline as
    // driver.test.ts's setActive(false) test), its identity intact.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    let askEntered = false;
    let releaseAsk: (() => void) | null = null;
    const askGate = new Promise<void>((r) => {
      releaseAsk = r;
    });
    const box = { current: rootA };
    const { driver, seen } = makeSwitchableDriver(rootA, box, {
      script: [
        writeTurn("a-m90.txt"),
        { role: "assistant", content: "MID" },
        { role: "assistant", content: "AFTER" },
      ],
      onPermissionAsk: async () => {
        askEntered = true;
        await askGate;
        return { kind: "allow" };
      },
    });
    const seamThrow = new Error("m90: receipt listener failed inside the settle seam");
    driver.onHistory((entries) => {
      if (entries.some((e) => e.kind === "notice" && e.text.includes("已切换"))) throw seamThrow;
    });
    driver.submit("mid");
    await until(() => askEntered, "write_file ask to park (run is busy)");
    await expect(driver.agentRootSwitch(rootB)).resolves.toEqual({ applied: false, queued: true });

    releaseAsk?.();
    await until(() => unhandled.length === 1, "the seam throw to escape the run body");
    process.off("unhandledRejection", onUnhandled);
    // The throw escaped UNWRAPPED — same instance, diagnostics intact.
    expect(unhandled[0]).toBe(seamThrow);
    // The throw path skipped the drain: nothing auto-started (no double run).
    expect(seen.length).toBe(2);
    // busy survived the throw — a fresh submit STARTS instead of parking
    // (pre-fix it returned "steered" and the driver never ran again).
    expect(driver.submit("after")).toBe("started");
    await until(() => driver.getStatus().busy === false, "after run to settle");
    expect(seen.length).toBe(3);
    driver.dispose();
  });

  it("M90 guard: a rejected recents write inside the seam is absorbed per the current path — the switch still lands and busy still clears", async () => {
    // The seam's two named fs awaits already route failures through internal
    // catches (sameAgentRoot falls back to raw paths on a realpath reject;
    // applyAgentRoot awaits recordRecentWorkspace with .catch(() => undefined)).
    // Pin that arm too: a REAL ENOTDIR reject on the recents write (the
    // global home points at a FILE, so every write under it rejects) never
    // becomes a seam throw — the switch lands receipted, busy flips, the
    // next run starts. If the internal catch is ever removed, the unhandled
    // assertion here turns red and names the semantic change.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    process.env.WUDAO_GLOBAL_HOME = join(rootA, "a.txt"); // a FILE: writes under it ENOTDIR
    let askEntered = false;
    let releaseAsk: (() => void) | null = null;
    const askGate = new Promise<void>((r) => {
      releaseAsk = r;
    });
    const box = { current: rootA };
    const { driver } = makeSwitchableDriver(rootA, box, {
      script: [
        writeTurn("a-m90b.txt"),
        { role: "assistant", content: "MID" },
        { role: "assistant", content: "AFTER" },
      ],
      onPermissionAsk: async () => {
        askEntered = true;
        await askGate;
        return { kind: "allow" };
      },
    });
    driver.submit("mid");
    await until(() => askEntered, "write_file ask to park (run is busy)");
    await expect(driver.agentRootSwitch(rootB)).resolves.toEqual({ applied: false, queued: true });

    releaseAsk?.();
    await until(() => driver.getStatus().busy === false, "mid run to settle");
    // The switch landed despite the failed recents write — receipt and all.
    expect(box.current).toBe(rootB);
    expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("已切换"))).toBe(true);
    expect(driver.submit("after")).toBe("started");
    await until(() => driver.getStatus().busy === false, "after run to settle");
    expect(unhandled).toEqual([]);
    process.off("unhandledRejection", onUnhandled);
    process.env.WUDAO_GLOBAL_HOME = home;
    driver.dispose();
  });

  it("cache invariant: the <workspace_changed> note rides the next ModelInput; the system prompt stays byte-identical and the note never persists", async () => {
    const systemPrompt = `FIXED-PREFIX-${Date.now()}\nyou are an agent.`;
    const box = { current: rootA };
    const { driver, seen } = makeSwitchableDriver(rootA, box, {
      script: [{ role: "assistant", content: "one" }, { role: "assistant", content: "two" }],
      systemPrompt,
    });
    const sessionIdBefore = driver.getSessionId();
    driver.submit("first");
    await until(() => driver.getStatus().busy === false, "first run");
    await driver.agentRootSwitch(rootB);
    driver.submit("second");
    await until(() => driver.getStatus().busy === false, "second run");

    // The note is in the next first call's ModelInput (the user-channel
    // projection — no tool_result exists yet in this conversation).
    expect(noteIn(seen[1]!, "<system_note>")).toBe(true);
    expect(noteIn(seen[1]!, `<workspace_changed path="${rootB}">`)).toBe(true);
    // M24: the system prompt string is byte-identical before/after the switch.
    expect(seen[1]!.systemPrompt).toBe(seen[0]!.systemPrompt);
    expect(seen[1]!.systemPrompt).toBe(systemPrompt);
    // Projection-only: the persisted conversation never gains the note, and
    // the switch never rotated the session id or wrote any boundary entry.
    expect(driver.state.messages.some((m) => m.content.includes("workspace_changed"))).toBe(false);
    expect(driver.getSessionId()).toBe(sessionIdBefore);
    driver.dispose();
  });

  it("shell's cwd follows: pwd prints the NEW root after the switch", async () => {
    const box = { current: rootA };
    const { driver } = makeSwitchableDriver(rootA, box, {
      script: [commandTurn("pwd"), { role: "assistant", content: "DONE" }],
      onPermissionAsk: async () => ({ kind: "allow" }),
    });
    await driver.agentRootSwitch(rootB);
    driver.submit("where are we");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const pwd = driver.state.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    // The child's getcwd resolves symlinks (macOS /var → /private/var) —
    // compare REALPATHS on both sides, and the old root must be absent.
    // win32: Git-sh `pwd` prints POSIX mount aliases (/tmp/… for the user
    // temp root) — cygpath resolves each side to its Windows form first.
    const norm = (p: string): string => p.toLowerCase().split("\\").join("/");
    const bReal = await realpath(rootB);
    const aReal = await realpath(rootA);
    let pwdResolved = pwd;
    if (process.platform === "win32") {
      // Git-sh `pwd` prints a POSIX mount alias (/tmp/…) — resolve to the
      // Windows form before comparing (cygpath is a plain .exe on PATH).
      const line = pwd.trim().split("\n").filter((l) => l.trim() !== "" && !l.startsWith("$ ") && !/^\[exit /.test(l)).at(-1) ?? "";
      const r = await promisify(execFileCb)("cygpath", ["-w", line], { encoding: "utf8" });
      pwdResolved = r.stdout.trim();
    }
    expect(norm(pwdResolved).includes(norm(bReal))).toBe(true);
    expect(norm(pwdResolved).includes(norm(aReal))).toBe(false);
    driver.dispose();
  });

  it("the hookWorkspaceRoot box follows at the apply point (idle and settle)", async () => {
    // The driver takes the box at construction (index.ts hands its
    // hookWorkspaceRoot — the root hook payloads build paths against).
    const idleBox = { current: rootA };
    const idle = createAgentDriver({
      systemPrompt: "s",
      summarize: summarizeToolCall,
      model: createScriptedModel([{ role: "assistant", content: "x" }]),
      tools: [],
      workspaceRoot: rootA,
      agentRootBox: idleBox,
    });
    await idle.agentRootSwitch(rootB);
    expect(idleBox.current).toBe(rootB);
    idle.dispose();

    // The settle path is covered by the busy scenario's box assertion; pin the
    // recents write here (the pick lands in the same store panelRootSet uses).
    const box2 = { current: rootA };
    const d2 = makeSwitchableDriver(rootA, box2, { script: [{ role: "assistant", content: "x" }] });
    await d2.driver.agentRootSwitch(rootB);
    const raw = JSON.parse(await readFile(join(home, "recent-workspaces.json"), "utf8")) as { path: string }[];
    expect(raw.map((r) => r.path)).toEqual([rootB]);
    d2.driver.dispose();
  });

  it("the FileChanged watchers re-compile against the NEW root: the old tree goes deaf, the new tree fires", async () => {
    await writeFile(join(rootA, "watched.txt"), "a1\n");
    await writeFile(join(rootB, "watched.txt"), "b1\n");
    const fired: string[] = [];
    const box = { current: rootA };
    const driver = createAgentDriver({
      systemPrompt: "s",
      summarize: summarizeToolCall,
      model: createScriptedModel([{ role: "assistant", content: "x" }]),
      tools: [],
      workspaceRoot: rootA,
      agentRootBox: box,
      canUseTool: () => ({ behavior: "allow" as const }),
      fileChangeWatch: { targets: ["watched.txt"], fire: (p) => { fired.push(p); } },
    });
    await driver.agentRootSwitch(rootB);
    // The OLD tree lost its watchers; the NEW tree's are live.
    await writeFile(join(rootA, "watched.txt"), "a2\n");
    await wait(300);
    expect(fired).toEqual([]);
    await writeFile(join(rootB, "watched.txt"), "b2\n");
    await until(() => fired.includes("watched.txt"), "new-root watcher fire", 4000);
    expect(fired).toEqual(["watched.txt"]);
    driver.dispose();
  }, 10_000);

  it("a queued switch BACK to the live root is a silent no-op: settle lands no notice and no note (last write wins)", async () => {
    let askEntered = false;
    let releaseAsk: (() => void) | null = null;
    const askGate = new Promise<void>((r) => {
      releaseAsk = r;
    });
    const box = { current: rootA };
    const { driver, seen } = makeSwitchableDriver(rootA, box, {
      script: [
        writeTurn("a-hold.txt"),
        { role: "assistant", content: "MID" },
        { role: "assistant", content: "AFTER" },
      ],
      onPermissionAsk: async () => {
        askEntered = true;
        await askGate;
        return { kind: "allow" };
      },
    });
    driver.submit("mid");
    await until(() => askEntered, "write_file ask to park (run is busy)");
    await expect(driver.agentRootSwitch(rootB)).resolves.toEqual({ applied: false, queued: true });
    // Switching back to the LIVE root supersedes the queued B — the pending
    // slot now matches what is already in effect.
    await expect(driver.agentRootSwitch(rootA)).resolves.toEqual({ applied: false, queued: true });
    releaseAsk?.();
    await until(() => driver.getStatus().busy === false, "mid run to settle");
    // Settle landed it SILENTLY: nothing moved, no notice.
    expect(box.current).toBe(rootA);
    expect((await driver.agentRootStatus()).agentRoot).toBe(rootA);
    expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("已切换"))).toBe(false);
    driver.submit("after");
    await until(() => driver.getStatus().busy === false, "after run to settle");
    // …and the next run's first model call carries NO workspace_changed note.
    expect(seen[2]!.messages.some((m) => typeof m.content === "string" && m.content.includes("workspace_changed"))).toBe(false);
    driver.dispose();
  });

  it("an idle switch to a symlink of the CURRENT root is a no-op (realpath-normalized): no notice, no note, nothing moves", async () => {
    const link = join(rootB, "link-to-a");
    await symlink(rootA, link);
    const box = { current: rootA };
    const { driver } = makeSwitchableDriver(rootA, box, { script: [{ role: "assistant", content: "x" }] });
    await expect(driver.agentRootSwitch(link)).resolves.toEqual({ applied: true, queued: false });
    expect(box.current).toBe(rootA);
    expect((await driver.agentRootStatus()).agentRoot).toBe(rootA);
    expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("已切换"))).toBe(false);
    driver.dispose();
  });

  it("transcript_path stays anchored at the BOOT root: a switch never points hook payloads at a nonexistent session file", async () => {
    // Production wiring: index.ts captures hookTranscriptRoot ONCE at entry
    // (the session store's anchor — rootA here) and BOTH common-field compile
    // sites build through hookCommonFields({ transcriptRoot:
    // hookTranscriptRoot.current }), never the agent-root box that
    // agentRootSwitch moves (the explicit param is what keeps it that way).
    const sessionId = "wudao-boot-1";
    await mkdir(join(rootA, ".wudao", "sessions"), { recursive: true });
    await writeFile(join(rootA, ".wudao", "sessions", `${sessionId}.jsonl`), "{}\n");
    const box = { current: rootA };
    const { driver } = makeSwitchableDriver(rootA, box, { script: [{ role: "assistant", content: "x" }] });
    await driver.agentRootSwitch(rootB);
    expect(box.current).toBe(rootB); // the agent's footing moved…
    const fields = hookCommonFields({
      sessionId,
      promptId: "p1",
      permissionMode: "default",
      effort: "high",
      transcriptRoot: rootA, // index.ts's hookTranscriptRoot (the BOOT root)
    });
    expect(fields).toEqual({
      session_id: sessionId,
      transcript_path: join(rootA, ".wudao", "sessions", `${sessionId}.jsonl`),
      prompt_id: "p1",
      permission_mode: "default",
      effort: "high",
    });
    // The named transcript file is REAL; the moved root has no such file — a
    // payload built against the agent box would name a nonexistent path.
    await expect(fileExists(fields.transcript_path as string)).resolves.toBe(true);
    await expect(fileExists(join(rootB, ".wudao", "sessions", `${sessionId}.jsonl`))).resolves.toBe(false);
    driver.dispose();
  });

  it("validation + normalization: typed errors move nothing; aligned is judged on realpaths so symlinked picks do not false-negative", async () => {
    const box = { current: rootA };
    const { driver } = makeSwitchableDriver(rootA, box, { script: [{ role: "assistant", content: "x" }] });
    await expect(driver.agentRootSwitch(join(rootA, "nope"))).rejects.toThrow(/no such directory/);
    await writeFile(join(rootA, "f.txt"), "x");
    await expect(driver.agentRootSwitch(join(rootA, "f.txt"))).rejects.toThrow(/not a directory/);
    expect(box.current).toBe(rootA);
    expect((await driver.agentRootStatus()).agentRoot).toBe(rootA);

    // A symlinked pick: panelRoot holds the LINK, the agent root the target —
    // raw strings differ, realpaths agree → aligned stays true.
    const link = join(rootA, "link-to-b");
    await symlink(rootB, link);
    await driver.panelRootSet(link);
    await driver.agentRootSwitch(rootB);
    // 138b：bootRoot（会话锚）是加性字段——直读 boot 根（未切换过）。
    expect(await driver.agentRootStatus()).toEqual({ panelRoot: link, agentRoot: rootB, bootRoot: rootA, aligned: true });
    driver.dispose();
  });
});
