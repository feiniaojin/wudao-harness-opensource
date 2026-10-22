// M81 det-51 — workspace-ux dual-root boundary matrix, the cross-batch
// acceptance gate at the REAL driver seams (zero reimplementation):
//
//   panel.idle            panelRootSet re-roots fileTree/fileRead under the
//                         new root; containment is judged from the NEW root;
//                         the agent's workspace root and tool boundary never
//                         move.
//   panel.escape          "../escape" fails against the NEW panel root (the
//                         boundary follows the view, not the session).
//   panel.busy            panelRootSet applies mid-run without disrupting the
//                         in-flight run (the view root rides nothing the run
//                         touches).
//   panel.recents         a successful pick lands in the recents file the
//                         recentWorkspaces op reads.
//   agent.unSwitched      write_file to a NEW-root-relative path is REFUSED
//                         (the agent's boundary does NOT follow panelRoot).
//   agent.idle            after agentRootSwitch the new-root-relative path is
//                         allowed, the previous-root-relative path is rejected,
//                         and the shared hook workspace-root box followed.
//   agent.busy            agentRootSwitch returns {queued:true} and the
//                         in-flight run keeps the OLD root; the queued switch
//                         lands at the run settle (notice + new box).
//   metaNote              the next first model call's ModelInput carries the
//                         `<workspace_changed path="...">` note; the system
//                         prompt is byte-identical before/after the switch and
//                         the note never persists in state.messages.
//   cwd                   shell's child cwd reads the new root after
//                         the switch (the shared box drives it).
//   status                agentRootStatus returns the consistent dual-root
//                         snapshot (aligned flips on panelRootSet, flips
//                         back on agentRootSwitch).
//
// NOT here (lives in the cross-package tests, cited for the report):
//   package/cli/tests/panel-root.test.ts   (B1 unit tests)
//   package/cli/tests/agent-root-switch.test.ts (B2 unit tests, incl.
//                                                 FileChanged watcher,
//                                                 transcript_path anchoring,
//                                                 symlink normalization,
//                                                 no-op supersedes-queue,
//                                                 typed validation errors)
//
// All fixtures are local tmpdirs — zero network, zero cost.
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFileCb);
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao/core";
import { createScriptedModel } from "@wudao/core";
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import type { AgentDriver, AgentDriverOptions } from "wudao-harness/driver/agent-driver";
import { buildToolSet } from "wudao-harness/tools";
import { summarizeToolCall } from "wudao-harness/log";
import type { EvalDefinition } from "../runner.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// De-flake: a first-run cold vite transform plus sibling build processes can
// stall the event loop well past 4s — the old default produced load-sensitive
// `det-51 timeout waiting for …` reds that re-ran green. 15s matches the
// det-55 precedent (still far below a whole-file failure).
async function until(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`det-51 timeout waiting for ${what}`);
    await wait();
  }
}

const fileExists = async (p: string): Promise<boolean> =>
  (await stat(p).catch(() => undefined)) !== undefined;

const allow = async () => ({ behavior: "allow" as const });

/** Mirrors the production wiring: ONE box shared by buildToolSet (the builtin
 *  file tools + shell read it at execution time) and the driver
 *  (applyAgentRoot writes it). */
function makeSwitchableDriver(
  root: string,
  box: { current: string },
  opts: {
    script: readonly AssistantMessage[];
    onPermissionAsk?: AgentDriverOptions["onPermissionAsk"];
    systemPrompt?: string;
    sessionId?: string;
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
    // write-heavy scripts are turn-exact; the verify/todo gates would inject
    // extra turns and eat the script.
    gates: { todo: false, verify: false },
    workspaceRoot: root,
    agentRootBox: box,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  return { driver, seen };
}

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

/** The literal paths the run() built (the assertion body compares evidence
 *  against these — the values are tmpdir paths and never escape the suite). */
interface Det51Roots {
  readonly rootA: string;
  readonly rootB: string;
  readonly rootAReal: string;
  readonly rootBReal: string;
}

export interface Det51Evidence {
  readonly roots: Det51Roots;
  // panelRoot (B1) — the view root, independent of the agent root.
  readonly panelIdle: {
    readonly treeBeforeNames: readonly string[];
    readonly treeAfterNames: readonly string[];
    readonly readNewBytes: string;
    readonly aRelThrows: boolean;
    readonly escapeThrows: boolean;
    readonly recentsHasNew: boolean;
  };
  readonly panelBusy: { readonly appliedMidRun: boolean; readonly alignedAfter: boolean };
  // agentRoot (B2) — the SWITCHABLE root.
  readonly agentUnSwitched: { readonly escaped: boolean; readonly errored: string };
  readonly agentIdle: {
    readonly applied: boolean;
    readonly boxFollowed: boolean;
    readonly newRelAllowed: boolean;
    readonly oldRelRejected: boolean;
    readonly statusAgentRoot: string;
  };
  readonly agentBusy: {
    readonly queued: boolean;
    readonly boxDuringBusy: string;
    readonly oldRelWrote: boolean;
    readonly newRelDidNotWrite: boolean;
    readonly boxAfterSettle: string;
    readonly noticeLanded: boolean;
  };
  // M24 cache invariant — system prompt survives the switch.
  readonly cacheInvariant: {
    readonly noteArrived: boolean;
    readonly promptBefore: string;
    readonly promptAfter: string;
    readonly promptLive: string;
    readonly persistedNoteFree: boolean;
    readonly sessionIdStable: boolean;
  };
  readonly cwd: { readonly newRootEchoed: boolean; readonly oldRootAbsent: boolean };
  // The dual-root status snapshot.
  readonly status: {
    readonly initialAligned: boolean;
    readonly afterPanelDiverged: boolean;
    readonly afterAgentFollowed: boolean;
  };
}

export const det51Eval: EvalDefinition<string, Det51Evidence> = {
  name: "det-51-m81-dual-root",
  kind: "deterministic",
  setup: async (tmplDir) => {
    await mkdir(tmplDir, { recursive: true });
    return tmplDir;
  },
  async run(): Promise<Det51Evidence> {
    const rootA = await mkdtemp(join(tmpdir(), "wudao-det51-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "wudao-det51-b-"));
    const home = await mkdtemp(join(tmpdir(), "wudao-det51-home-"));
    await mkdir(join(rootA, "sub"));
    await writeFile(join(rootA, "a.txt"), "A");
    await writeFile(join(rootB, "b.md"), "B");
    const [rootAReal, rootBReal] = await Promise.all([realpath(rootA), realpath(rootB)]);
    const savedHome = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;

    try {
      // =====================================================================
      // §A panelRoot (B1) — fileTree re-roots, fileRead re-roots, escape
      //   rejects against the NEW root, recents records the pick.
      // =====================================================================
      const { driver: panelDriver } = makeSwitchableDriver(rootA, { current: rootA }, {
        script: [{ role: "assistant", content: "x" }],
      });
      const treeBefore = await panelDriver.fileTree("");
      await panelDriver.panelRootSet(rootB);
      const treeAfter = await panelDriver.fileTree("");
      const readNew = await panelDriver.fileRead("b.md");
      let aRelThrew = false;
      try { await panelDriver.fileTree("sub"); } catch { aRelThrew = true; }
      let escapeThrew = false;
      try { await panelDriver.fileRead("../escape"); } catch { escapeThrew = true; }
      const recentsRaw = JSON.parse(await readFile(join(home, "recent-workspaces.json"), "utf8")) as { path: string }[];
      const panelIdle = {
        treeBeforeNames: treeBefore.entries.map((e) => e.name).sort(),
        treeAfterNames: treeAfter.entries.map((e) => e.name).sort(),
        readNewBytes: readNew.content,
        aRelThrows: aRelThrew,
        escapeThrows: escapeThrew,
        recentsHasNew: recentsRaw.map((r) => r.path).includes(rootB),
      };
      panelDriver.dispose();

      // =========================================================== §A busy
      // panelRootSet applies mid-run — no busy guard, the view root disrupts
      // nothing the run touches. The synthetic driver holds the model call
      // (no real tools needed — the contract is the run's busy state).
      let releaseGate: () => void = () => undefined;
      const gate = new Promise<void>((r) => { releaseGate = (): void => { r(); }; });
      const gateDriver: AgentDriver = ((): AgentDriver => {
        const model: ModelClient = {
          async generate(_input: ModelInput): ReturnType<ModelClient["generate"]> {
            await gate;
            return { role: "assistant", content: "LATE" };
          },
        };
        return createAgentDriver({
          systemPrompt: "s",
          summarize: summarizeToolCall,
          model,
          tools: [],
          workspaceRoot: rootA,
        });
      })();
      gateDriver.submit("go");
      await until(() => gateDriver.getStatus().busy === true, "panel-busy run to start");
      let panelBusyApplied = false;
      try {
        await gateDriver.panelRootSet(rootB);
        panelBusyApplied = true;
      } catch { /* swallowed */ }
      const panelBusyStatus = await gateDriver.agentRootStatus();
      const alignedAfter = panelBusyStatus.panelRoot === rootB
        && panelBusyStatus.agentRoot === rootA
        && !panelBusyStatus.aligned;
      releaseGate?.();
      await until(() => gateDriver.getStatus().busy === false, "panel-busy run to finish");
      gateDriver.dispose();
      const panelBusy = { appliedMidRun: panelBusyApplied, alignedAfter };

      // =========================================================== §A status
      // Initial state: aligned; panelRootSet diverges them; agentRootSwitch
      // un-aligns them through the file-panel side.
      const { driver: statusDriver } = makeSwitchableDriver(rootA, { current: rootA }, {
        script: [
          { role: "assistant", content: "" },
          { role: "assistant", content: "DONE" },
        ],
      });
      const initialAligned = (await statusDriver.agentRootStatus()).aligned;
      await statusDriver.panelRootSet(rootB);
      const afterPanelDiverged = !(await statusDriver.agentRootStatus()).aligned;
      await statusDriver.agentRootSwitch(rootB);
      const afterAgentFollowed = (await statusDriver.agentRootStatus()).aligned;
      statusDriver.dispose();

      // =====================================================================
      // §B agentRoot (B2) — the boundary matrix.
      // =====================================================================

      // -- §B1 -- un-switched: write_file to a new-root-relative path is
      // REFUSED. The agent's boundary does NOT follow panelRootSet. The path
      // is constructed relative to rootA but escapes it (lies inside rootB) —
      // the inverse of the agent-root-switch.test.ts shape, but with the
      // agent root still at rootA.
      const newRootRel = join(relative(rootA, rootB), "escape-attempt.txt");
      const unsw = makeSwitchableDriver(rootA, { current: rootA }, {
        script: [writeTurn(newRootRel), { role: "assistant", content: "DONE" }],
        onPermissionAsk: async () => ({ kind: "allow" }),
      });
      await unsw.driver.panelRootSet(rootB);
      const statusUnsw = await unsw.driver.agentRootStatus();
      const agentUnSwitchedDiverged = statusUnsw.agentRoot !== statusUnsw.panelRoot;
      unsw.driver.submit("write to b");
      await until(() => unsw.driver.getStatus().busy === false, "unswitched run to finish");
      const toolResults = unsw.driver.state.messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content);
      const escapedFile = !(await fileExists(join(rootB, "escape-attempt.txt")));
      const errored = toolResults.find((c) => c.includes("path escapes workspace"))
        ?? toolResults[toolResults.length - 1]
        ?? "(no tool result)";
      const agentUnSwitched = {
        escaped: escapedFile && agentUnSwitchedDiverged,
        errored,
      };
      unsw.driver.dispose();

      // -- §B2 -- idle: after agentRootSwitch the new-root path is allowed,
      // the old-root-relative path is rejected, the box followed.
      const oldRel = join(relative(rootB, rootA), "a.txt");
      const idleBox = { current: rootA };
      const { driver: idleDriver } = makeSwitchableDriver(rootA, idleBox, {
        script: [writeTurn("ok-b.txt"), writeTurn(oldRel), { role: "assistant", content: "DONE" }],
        onPermissionAsk: async () => ({ kind: "allow" }),
      });
      const idleReply = await idleDriver.agentRootSwitch(rootB);
      idleDriver.submit("write both");
      await until(() => idleDriver.getStatus().busy === false, "idle run to finish");
      const idleNewAllowed = await fileExists(join(rootB, "ok-b.txt"));
      const idleNewNotInA = !(await fileExists(join(rootA, "ok-b.txt")));
      const idleOldInA = await fileExists(join(rootA, "a.txt"));
      const idleStatus = await idleDriver.agentRootStatus();
      const idleResults = idleDriver.state.messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content);
      const agentIdle = {
        applied: idleReply.applied === true && idleReply.queued === false,
        boxFollowed: idleBox.current === rootB,
        newRelAllowed: idleNewAllowed && idleNewNotInA,
        oldRelRejected: idleOldInA && idleResults.some((c) => c.includes("path escapes workspace")),
        statusAgentRoot: idleStatus.agentRoot,
      };
      idleDriver.dispose();

      // -- §B3 -- busy: switch queues to settle, the in-flight run keeps the
      // OLD root, the queued switch lands at settle (notice + new box).
      let askEntered = false;
      let releaseAsk: () => void = () => undefined;
      const askGate = new Promise<void>((r) => { releaseAsk = (): void => { r(); }; });
      const busyBox = { current: rootA };
      const { driver: busyDriver } = makeSwitchableDriver(rootA, busyBox, {
        script: [
          writeTurn("a-mid.txt"),
          { role: "assistant", content: "MID DONE" },
          { role: "assistant", content: "AFTER" },
        ],
        onPermissionAsk: async () => {
          askEntered = true;
          await askGate;
          return { kind: "allow" };
        },
      });
      busyDriver.submit("mid run");
      await until(() => askEntered, "write_file ask to park (run is busy)");
      const busyReply = await busyDriver.agentRootSwitch(rootB);
      const busyDuring = busyBox.current;
      const busyOldAllowed = await fileExists(join(rootA, "a.txt"));
      releaseAsk?.();
      await until(() => busyDriver.getStatus().busy === false, "mid run to settle");
      const busyAfter = busyBox.current;
      const oldRelWrote = await fileExists(join(rootA, "a-mid.txt"));
      const newRelDidNotWrite = !(await fileExists(join(rootB, "a-mid.txt")));
      const noticeLanded = busyDriver.getHistory().some(
        (e) => e.kind === "notice" && e.text.includes("已切换") && e.text.includes(basename(rootB)),
      );
      const agentBusy = {
        queued: busyReply.applied === false && busyReply.queued === true,
        boxDuringBusy: busyDuring,
        oldRelWrote: oldRelWrote && busyOldAllowed,
        newRelDidNotWrite,
        boxAfterSettle: busyAfter,
        noticeLanded,
      };
      busyDriver.dispose();

      // -- §B4 -- M24 cache invariant: <workspace_changed> note in next
      // first call, system prompt byte-identical, no persistence.
      const systemPrompt = `FIXED-PREFIX-${Date.now()}\nyou are an agent.`;
      const { driver: cacheDriver, seen: cacheSeen } = makeSwitchableDriver(rootA, { current: rootA }, {
        script: [{ role: "assistant", content: "one" }, { role: "assistant", content: "two" }],
        systemPrompt,
      });
      const sessionBefore = cacheDriver.getSessionId();
      cacheDriver.submit("first");
      await until(() => cacheDriver.getStatus().busy === false, "cache first run");
      await cacheDriver.agentRootSwitch(rootB);
      cacheDriver.submit("second");
      await until(() => cacheDriver.getStatus().busy === false, "cache second run");
      const callTwo = cacheSeen[1] ?? { messages: [], systemPrompt: "", tools: [] };
      const promptBefore = cacheSeen[0]?.systemPrompt ?? "";
      const promptAfter = callTwo.systemPrompt;
      const persistedNoteFree = !cacheDriver.state.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("workspace_changed"),
      );
      const cacheInvariant = {
        noteArrived: noteIn(callTwo, "<system_note>")
          && noteIn(callTwo, `<workspace_changed path="${rootB}">`),
        promptBefore,
        promptAfter,
        promptLive: systemPrompt,
        persistedNoteFree,
        sessionIdStable: cacheDriver.getSessionId() === sessionBefore,
      };
      cacheDriver.dispose();

      // -- §B5 -- shell's cwd follows the new root after the switch.
      const { driver: cwdDriver } = makeSwitchableDriver(rootA, { current: rootA }, {
        script: [commandTurn("pwd"), { role: "assistant", content: "DONE" }],
        onPermissionAsk: async () => ({ kind: "allow" }),
      });
      await cwdDriver.agentRootSwitch(rootB);
      cwdDriver.submit("pwd");
      await until(() => cwdDriver.getStatus().busy === false, "cwd run to finish");
      const pwdOut = cwdDriver.state.messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content)
        .join("\n");
      cwdDriver.dispose();
      // win32: `pwd` runs under Git sh, which prints POSIX mount aliases
      // (`/tmp/…` for the user temp root) while rootBReal is a `C:\…` path.
      // Resolve BOTH sides to Windows-real forms before comparing (cygpath
      // resolves a POSIX alias to its Windows mount; a plain Windows path
      // round-trips unchanged). posix hosts compare the untouched strings.
      const resolveForCompare = async (p: string): Promise<string> => {
        if (process.platform !== "win32") return p;
        try {
          const r = await execFileP("cygpath", ["-w", p], { encoding: "utf8" });
          return r.stdout.trim().toLowerCase().split("\\").join("/");
        } catch {
          return p.toLowerCase().split("\\").join("/");
        }
      };
      // pwdOut's path line: the last non-empty line that is neither the
      // `$ pwd` command echo nor the tool's `[exit N]` trailer.
      const pwdLine = pwdOut.trim().split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("$ ") && !/^\[exit /.test(l))
        .at(-1) ?? "";
      const [pwdResolved, rootBResolved, rootAResolved] = await Promise.all([
        resolveForCompare(pwdLine),
        resolveForCompare(rootBReal),
        resolveForCompare(rootAReal),
      ]);
      const cwd = {
        newRootEchoed: pwdResolved.includes(rootBResolved),
        oldRootAbsent: !pwdResolved.includes(rootAResolved),
      };

      const status: Det51Evidence["status"] = {
        initialAligned,
        afterPanelDiverged,
        afterAgentFollowed,
      };

      return {
        roots: { rootA, rootB, rootAReal, rootBReal },
        panelIdle,
        panelBusy,
        agentUnSwitched,
        agentIdle,
        agentBusy,
        cacheInvariant,
        cwd,
        status,
      };
    } finally {
      if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = savedHome;
      await rm(rootA, { recursive: true, force: true }).catch(() => {});
      await rm(rootB, { recursive: true, force: true }).catch(() => {});
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  },
  assertions(e: Det51Evidence): string[] {
    const errors: string[] = [];
    const need = (cond: boolean, what: string): void => {
      if (!cond) errors.push(what);
    };

    // ---- §A panelRoot (B1)
    need(
      JSON.stringify(e.panelIdle.treeBeforeNames) === JSON.stringify(["a.txt", "sub"]),
      `§A panelRoot: fileTree must list A's entries before the switch, got ${JSON.stringify(e.panelIdle.treeBeforeNames)}`,
    );
    need(
      JSON.stringify(e.panelIdle.treeAfterNames) === JSON.stringify(["b.md"]),
      `§A panelRoot: fileTree must re-root to B after the switch, got ${JSON.stringify(e.panelIdle.treeAfterNames)}`,
    );
    need(e.panelIdle.readNewBytes === "B", `§A panelRoot: fileRead(b.md) must return B's bytes, got ${JSON.stringify(e.panelIdle.readNewBytes)}`);
    need(e.panelIdle.aRelThrows, "§A panelRoot: A-relative paths must die with the old root");
    need(e.panelIdle.escapeThrows, "§A panelRoot: escape must reject against the NEW panel root");
    need(e.panelIdle.recentsHasNew, "§A panelRoot: a successful pick must land in the recents store");

    need(e.panelBusy.appliedMidRun, "§A panelRoot busy: panelRootSet must apply mid-run (no busy guard)");
    need(e.panelBusy.alignedAfter, "§A panelRoot busy: the agent root must stay anchored mid-run");

    // ---- §A status
    need(e.status.initialAligned, "§A status: aligned at boot");
    need(e.status.afterPanelDiverged, "§A status: panelRootSet must diverge the two roots");
    need(e.status.afterAgentFollowed, "§A status: agentRootSwitch must re-align the two roots");

    // ---- §B agentRoot (B2)
    need(e.agentUnSwitched.escaped, `§B un-switched: write_file to a new-root-relative path must be REFUSED (the agent boundary does not follow panelRootSet), got ${JSON.stringify(e.agentUnSwitched)}`);
    need(e.agentUnSwitched.errored.includes("path escapes workspace"), `§B un-switched: the refusal must be the escape error, got ${JSON.stringify(e.agentUnSwitched.errored)}`);

    need(e.agentIdle.applied, `§B idle: agentRootSwitch must return {applied:true,queued:false}, got ${JSON.stringify(e.agentIdle)}`);
    need(e.agentIdle.boxFollowed, "§B idle: the shared agent-root box must follow");
    need(e.agentIdle.newRelAllowed, "§B idle: write_file to a new-root-relative path must be allowed");
    need(e.agentIdle.oldRelRejected, "§B idle: write_file to an old-root-relative path must be rejected");
    need(e.agentIdle.statusAgentRoot === e.roots.rootB, `§B idle: agentRootStatus must reflect the new root, got ${e.agentIdle.statusAgentRoot} vs ${e.roots.rootB}`);

    need(e.agentBusy.queued, "§B busy: agentRootSwitch must return {queued:true} while busy");
    need(e.agentBusy.boxDuringBusy === e.roots.rootA, "§B busy: the box must stay at the OLD root through the in-flight run");
    need(e.agentBusy.oldRelWrote, "§B busy: the in-flight run's write_file must land under the OLD root");
    need(e.agentBusy.newRelDidNotWrite, "§B busy: the in-flight run must NOT write under the NEW root");
    need(e.agentBusy.boxAfterSettle === e.roots.rootB, "§B busy: the box must move to the NEW root at the run settle");
    need(e.agentBusy.noticeLanded, "§B busy: the settle must land the notice");

    need(e.cacheInvariant.noteArrived, "§B cache: the <workspace_changed> note must arrive on the next first model call");
    need(e.cacheInvariant.promptBefore === e.cacheInvariant.promptLive, "§B cache: the system prompt is the literal input at call 1");
    need(e.cacheInvariant.promptAfter === e.cacheInvariant.promptLive, "§B cache: the system prompt must be byte-identical at call 2 (M24 cache invariant)");
    need(e.cacheInvariant.promptBefore === e.cacheInvariant.promptAfter, "§B cache: the before/after system prompts must compare equal");
    need(e.cacheInvariant.persistedNoteFree, "§B cache: the note must NOT persist in state.messages");
    need(e.cacheInvariant.sessionIdStable, "§B cache: the session id must NOT rotate on a switch");

    need(e.cwd.newRootEchoed, "§B cwd: shell must echo the new root after the switch");
    need(e.cwd.oldRootAbsent, "§B cwd: the old root must NOT appear in the cwd output");

    return errors;
  },
  metrics(_e: Det51Evidence) {
    return {
      matrixCells: 6, // panel(before/after/escape) + agent(un-switched/idle/busy)
      cacheInvariantChecks: 4,
      statusTransitions: 2,
    };
  },
};
