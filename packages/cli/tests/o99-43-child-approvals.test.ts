// ω99-43 — durable child approval receipts (brief §1/§2): a session'd child's
// human ask/answer lands on the child's OWN sidechain as an approval-receipt
// generic entry; a later (restarted/resumed) child facing the SAME
// tool+input replays the recorded decision WITHOUT re-asking; the commit is
// fail-closed (append fails → the decision never took effect); the parent /
// top-level / sessionless-child ask paths are byte-identical; headless keeps
// deny-by-default with receipts as the ONLY relaxation. All scripted: fake
// JSONL store in a tmpdir, spied stdout + captured stdin handler (the
// phase2b StdinHarness pattern), stub tools, scripted model. Zero network,
// zero real UI.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createJsonlSessionStore, callFingerprint, buildTool } from "@wudao/core";
import type { AssistantMessage, ModelClient, ModelInput, PermissionDecision, Tool } from "@wudao/core";
import { createPermissionGate } from "../src/permission.js";
import { decorateChildGate, currentAskContext } from "../src/ask-evidence.js";
import { buildChildApprovals, approvalInputKey, APPROVAL_RECEIPT_TYPE } from "../src/agents/child-approvals.js";
import type { ChildApprovalFace } from "../src/agents/child-approvals.js";
import { createAgentsTaskTool } from "../src/agents/task-tool.js";
import { createSessionRegistry } from "../src/agents/index.js";

const wait = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** The phase2b harness: TTY-on, stdout spied, stdin data-handler captured so
 *  the test drives the human's answer synchronously. */
class StdinHarness {
  public writes: string[] = [];
  public capturedDataHandler: ((chunk: Buffer | string) => void) | undefined;
  private hadIsTTY = false;
  private origIsTTY: boolean | undefined;
  install(): void {
    this.hadIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
    this.origIsTTY = (stdin as { isTTY?: boolean }).isTTY;
    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    vi.spyOn(stdout, "write").mockImplementation(((chunk: unknown): boolean => {
      this.writes.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    }) as typeof stdout.write);
    vi.spyOn(process.stdin, "once").mockImplementation(((event: string, listener: (...args: unknown[]) => void): typeof process.stdin => {
      if (event === "data") this.capturedDataHandler = listener as (chunk: Buffer | string) => void;
      return process.stdin;
    }) as typeof process.stdin.once);
    vi.spyOn(process.stdin, "resume").mockImplementation(((): typeof process.stdin => process.stdin) as typeof process.stdin.resume);
  }
  uninstall(): void {
    // Restore isTTY EXACTLY — under vitest it is absent (undefined); a
    // naive "if truthy" restore would leak isTTY=true into later headless
    // tests and hang their fail-closed paths on a nobody-answers stdin.
    delete (stdin as { isTTY?: boolean }).isTTY;
    if (this.hadIsTTY) Object.defineProperty(stdin, "isTTY", { value: this.origIsTTY, configurable: true });
    vi.restoreAllMocks();
  }
  answer(line: string): void {
    if (this.capturedDataHandler === undefined) throw new Error("no captured data handler (gate never reached askApprove?)");
    this.capturedDataHandler(line);
  }
  promptSoFar(): string {
    return this.writes.join("");
  }
  resetWrites(): void {
    this.writes.length = 0;
  }
}

let root: string;
let origCwd: string;
let harness: StdinHarness;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "o99-43-"));
  origCwd = process.cwd();
  process.chdir(root); // no settings.json → empty rules → workspace-mode shell asks
});
afterEach(async () => {
  process.chdir(origCwd);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The production gate shape the task tool's children inherit (argv-only,
 *  no sidecar) + the ω-4e child decoration carrying the receipt face. */
function childGate(face?: ChildApprovalFace) {
  const gate = createPermissionGate(["wudao", "x"]);
  return decorateChildGate(gate, { kind: "child", role: "coder", brief: "run the suite" }, () => undefined, face);
}

const CMD = { command: "npm install" };
const MENU = "🔑 允许 shell：npm install？ [y/a/p/N] "; // ω99-158: 随源中文化（行尾空格是 golden 字节）

/** Seed one receipt through the REAL writer (commit), then rebuild the face —
 *  the restart simulation: a fresh load over the persisted sidechain. */
async function seededFace(store: ReturnType<typeof createJsonlSessionStore>, sideId: string, tool: string, input: Record<string, unknown>, decision: PermissionDecision) {
  const writer = await buildChildApprovals(store, sideId);
  await writer.commit(tool, input, decision);
  return buildChildApprovals(store, sideId);
}

// ---------------------------------------------------------------------------
// §2.1 — 收据落链: an answered child ask appends an approval-receipt to the
// child's own sidechain (allow AND deny alike).
// ---------------------------------------------------------------------------

describe("§2.1 receipts land on the sidechain", () => {
  it("allow: `y` → sidechain gains one approval-receipt with tool/inputKey/decision/ts", async () => {
    harness = new StdinHarness();
    harness.install();
    try {
      const store = createJsonlSessionStore(join(root, "sessions"));
      const face = await buildChildApprovals(store, "child-a");
      const gate = childGate(face);
      const p = gate("shell", CMD);
      await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "ask to render");
      harness.answer("y");
      await expect(p).resolves.toEqual({ behavior: "allow" });
      const entries = await store.loadSidechainEntries("child-a");
      const receipts = entries.filter((e) => (e as { type?: string }).type === APPROVAL_RECEIPT_TYPE);
      expect(receipts).toHaveLength(1);
      const data = (receipts[0] as { data: Record<string, unknown> }).data;
      expect(data.tool).toBe("shell");
      expect(data.inputKey).toBe(approvalInputKey("shell", CMD));
      expect(data.inputKey).toBe(callFingerprint({ name: "shell", args: CMD }));
      expect(data.decision).toEqual({ behavior: "allow" });
      expect(typeof data.ts).toBe("string");
      expect(Number.isNaN(Date.parse(data.ts as string))).toBe(false);
    } finally {
      harness.uninstall();
    }
  });

  it("deny 同律: `N` → a deny receipt lands with the recorded decision", async () => {
    harness = new StdinHarness();
    harness.install();
    try {
      const store = createJsonlSessionStore(join(root, "sessions"));
      const face = await buildChildApprovals(store, "child-b");
      const p = childGate(face)("shell", CMD);
      await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "ask to render");
      harness.answer("N");
      const decision = await p;
      expect(decision.behavior).toBe("deny");
      const entries = await store.loadSidechainEntries("child-b");
      const data = (entries.find((e) => (e as { type?: string }).type === APPROVAL_RECEIPT_TYPE) as { data: Record<string, unknown> }).data;
      expect(data.decision).toEqual(decision);
    } finally {
      harness.uninstall();
    }
  });
});

// ---------------------------------------------------------------------------
// §2.2 — 重放: a persisted receipt answers the SAME tool+input with the
// recorded decision and NEVER touches the human; content addressing means a
// different input or a different tool misses and asks as today.
// ---------------------------------------------------------------------------

describe("§2.2 replay-before-decision (content-addressed)", () => {
  it("same tool+input after a restart-simulation → recorded decision, ZERO ask prompts", async () => {
    harness = new StdinHarness();
    harness.install();
    try {
      const store = createJsonlSessionStore(join(root, "sessions"));
      const face = await seededFace(store, "child-c", "shell", CMD, { behavior: "allow" });
      const decision = await childGate(face)("shell", CMD);
      expect(decision).toEqual({ behavior: "allow" });
      expect(harness.promptSoFar()).not.toContain("🔑 允许"); // the observer (askApprove) was never reached
    } finally {
      harness.uninstall();
    }
  });

  it("a recorded DENY replays as the deny (receipts never relax, they restate)", async () => {
    harness = new StdinHarness();
    harness.install();
    try {
      const store = createJsonlSessionStore(join(root, "sessions"));
      const face = await seededFace(store, "child-d", "shell", CMD, { behavior: "deny", reason: "user denied" });
      const decision = await childGate(face)("shell", CMD);
      expect(decision).toEqual({ behavior: "deny", reason: "user denied" });
      expect(harness.promptSoFar()).not.toContain("🔑 允许");
    } finally {
      harness.uninstall();
    }
  });

  it("different input → miss → the human is asked as today", async () => {
    harness = new StdinHarness();
    harness.install();
    try {
      const store = createJsonlSessionStore(join(root, "sessions"));
      const face = await seededFace(store, "child-e", "shell", CMD, { behavior: "allow" });
      const p = childGate(face)("shell", { command: "rm -rf /tmp/other" });
      await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "miss to ask");
      harness.answer("N");
      const decision = await p;
      expect(decision.behavior).toBe("deny"); // fresh answer, not the receipt
    } finally {
      harness.uninstall();
    }
  });

  it("same input, different tool → miss (face lookup undefined) and the gate asks", async () => {
    harness = new StdinHarness();
    harness.install();
    try {
      const store = createJsonlSessionStore(join(root, "sessions"));
      const face = await seededFace(store, "child-f", "shell", CMD, { behavior: "allow" });
      expect(face.lookup("mcp__x__run", CMD)).toBeUndefined(); // content-addressing includes the tool name
      const p = childGate(face)("mcp__x__run", CMD);
      await until(() => harness.promptSoFar().includes("🔑 允许 mcp__x__run"), "different-tool miss to ask");
      harness.answer("y");
      await expect(p).resolves.toEqual({ behavior: "allow" });
    } finally {
      harness.uninstall();
    }
  });
});

// ---------------------------------------------------------------------------
// §2.3 — 提交先行: the receipt is appended BEFORE the decision takes effect;
// a failed append means the decision never happened — execution blocked with
// an evidence-bearing reason.
// ---------------------------------------------------------------------------

describe("§2.3 fail-closed commit", () => {
  it("commit throws → the tool execution is blocked, the reason names the evidence", async () => {
    harness = new StdinHarness();
    harness.install();
    try {
      const face: ChildApprovalFace = {
        lookup: () => undefined,
        commit: async () => {
          throw new Error("disk full");
        },
      };
      const p = childGate(face)("shell", CMD);
      await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "ask to render");
      harness.answer("y");
      const decision = await p;
      expect(decision.behavior).toBe("deny"); // the human said allow — the uncommittable decision does not take effect
      expect(decision.reason ?? "").toContain("evidence");
    } finally {
      harness.uninstall();
    }
  });

  it("commit succeeds → the answered decision passes through verbatim", async () => {
    harness = new StdinHarness();
    harness.install();
    try {
      const committed: string[] = [];
      const face: ChildApprovalFace = {
        lookup: () => undefined,
        commit: async (tool) => {
          committed.push(tool);
        },
      };
      const p = childGate(face)("shell", CMD);
      await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "ask to render");
      harness.answer("y");
      await expect(p).resolves.toEqual({ behavior: "allow" });
      expect(committed).toEqual(["shell"]);
    } finally {
      harness.uninstall();
    }
  });
});

// ---------------------------------------------------------------------------
// §2.4 — 父路径零变化: no AskContext (every top-level ask) and a sessionless
// child (AskContext without the approvals face) render byte-identical asks —
// the receipt layer adds ZERO bytes and ZERO prompts when it is not armed.
// ---------------------------------------------------------------------------

describe("§2.4 parent / sessionless paths byte-identical", () => {
  it("top-level ask (ALS undefined): the prompt is exactly today's bytes", async () => {
    harness = new StdinHarness();
    harness.install();
    try {
      const gate = createPermissionGate(["wudao", "x"]); // undecorated — the parent/top-level shape
      const p = gate("shell", CMD);
      await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "top-level ask to render");
      expect(harness.promptSoFar()).toBe(MENU); // no digest, no receipt bytes, nothing new
      harness.answer("y");
      await expect(p).resolves.toEqual({ behavior: "allow" });
    } finally {
      harness.uninstall();
    }
  });

  it("a sessionless child (face undefined) renders the SAME prompt as the 3-arg ω-4e decoration", async () => {
    harness = new StdinHarness();
    harness.install();
    try {
      const p1 = childGate(undefined)("shell", CMD); // decorateChildGate without a face
      await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "faceless child ask to render");
      const facelessPrompt = harness.promptSoFar();
      harness.answer("y");
      await p1;
      harness.resetWrites();
      // The SAME decoration with an explicit undefined face — byte-identical.
      const three = decorateChildGate(createPermissionGate(["wudao", "x"]), { kind: "child", role: "coder", brief: "run the suite" }, () => undefined);
      const p2 = three("shell", CMD);
      await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "3-arg ask to render");
      expect(harness.promptSoFar()).toBe(facelessPrompt);
      harness.answer("y");
      await p2;
    } finally {
      harness.uninstall();
    }
  });
});

// ---------------------------------------------------------------------------
// §2.5 — headless: deny-by-default untouched; a receipt hit is the ONLY thing
// that answers without a human (the recorded decision IS the human's).
// ---------------------------------------------------------------------------

describe("§2.5 headless resume", () => {
  it("receipt hit → the recorded allow stands (no TTY needed, no prompt written)", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(stdout, "write").mockImplementation(((chunk: unknown): boolean => {
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof stdout.write);
    try {
      const store = createJsonlSessionStore(join(root, "sessions"));
      const face = await seededFace(store, "child-g", "shell", CMD, { behavior: "allow" });
      // NOTE: no StdinHarness — stdin.isTTY is falsy under vitest (headless).
      const decision = await childGate(face)("shell", CMD);
      expect(decision).toEqual({ behavior: "allow" });
      expect(writes.join("")).not.toContain("🔑"); // no ask, no non-interactive deny line
    } finally {
      spy.mockRestore();
    }
  });

  it("receipt miss → today's deny-by-default, reason non-interactive", async () => {
    const store = createJsonlSessionStore(join(root, "sessions"));
    const face = await buildChildApprovals(store, "child-h"); // empty chain — nothing recorded
    const decision = await childGate(face)("shell", CMD);
    expect(decision).toEqual({ behavior: "deny", reason: "non-interactive" });
  });
});

// ---------------------------------------------------------------------------
// §2.6 — 格式纪律: receipts ride the generic-entry channel; the message
// stream (loadSidechain) never sees them; the file only ever grows.
// (Store-level twins live in core/tests/sidechain-entries.test.ts; these pin
// the CLI-side facts through the real face.)
// ---------------------------------------------------------------------------

describe("§2.6 format discipline (CLI side)", () => {
  it("commit leaves the message stream untouched and the file append-only", async () => {
    const store = createJsonlSessionStore(join(root, "sessions"));
    await store.appendSidechain("child-i", { role: "user", content: "brief" });
    const face = await buildChildApprovals(store, "child-i");
    await face.commit("shell", CMD, { behavior: "allow" });
    expect(await store.loadSidechain("child-i")).toEqual([{ role: "user", content: "brief" }]); // old reader: zero pollution
    const entries = await store.loadSidechainEntries("child-i");
    expect(entries).toHaveLength(2); // message + receipt, file order
  });

  it("a malformed receipt line is skipped at face-build (tolerant load, same posture as the store)", async () => {
    const store = createJsonlSessionStore(join(root, "sessions"));
    const face = await buildChildApprovals(store, "child-j");
    await face.commit("shell", CMD, { behavior: "allow" });
    // Corrupt the receipt's decision shape on disk — the fresh load must skip
    // it, not crash, not answer from it.
    const { readFile, writeFile } = await import("node:fs/promises");
    const file = join(root, "sessions", "side-child-j.jsonl");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace('"behavior":"allow"', '"behavior":"sometimes"'), "utf8");
    const reloaded = await buildChildApprovals(store, "child-j");
    expect(reloaded.lookup("shell", CMD)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Spawn-site wiring — the task tool builds the face for a session'd child and
// carries it inside the decorated gate's AskContext (both spawn paths share
// the foreground runner; the background registry spawn is pinned the same way
// in ask-evidence T13's pattern — here the FACE's presence is the fact).
// ---------------------------------------------------------------------------

function scriptedModel(responses: readonly AssistantMessage[]): ModelClient {
  let i = 0;
  return {
    async generate(_input: ModelInput): Promise<AssistantMessage> {
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

function stubRunCommand(): Tool {
  return buildTool({
    name: "shell",
    description: "stub shell (never spawns — execute is inert)",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "command line" } },
      required: ["command"],
    },
    async execute() {
      return { content: "stubbed (no shell)" };
    },
  });
}

describe("spawn-site wiring", () => {
  it("a session:'new' child's gate carries the approvals face; a sessionless child's does not", async () => {
    const observed: (ChildApprovalFace | undefined)[] = [];
    const canUseTool = async (_t: string, _i: Record<string, unknown>): Promise<PermissionDecision> => {
      observed.push(currentAskContext()?.approvals);
      return { behavior: "allow" };
    };
    const call = { description: "d", prompt: "run the suite", role: "coder" };
    await createAgentsTaskTool({
      model: scriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "pnpm test" } }] },
        { role: "assistant", content: "done" },
      ]),
      allTools: [stubRunCommand()],
      registry: createSessionRegistry(),
      workspaceRoot: root,
      runId: "w1",
      canUseTool,
    }).execute({ ...call, session: "new" });
    expect(observed.length).toBe(1);
    expect(observed[0]).toBeDefined();
    expect(typeof observed[0]?.lookup).toBe("function");
    expect(typeof observed[0]?.commit).toBe("function");

    observed.length = 0;
    await createAgentsTaskTool({
      model: scriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "pnpm test" } }] },
        { role: "assistant", content: "done" },
      ]),
      allTools: [stubRunCommand()],
      registry: createSessionRegistry(),
      workspaceRoot: root,
      runId: "w2",
      canUseTool,
    }).execute(call);
    expect(observed.length).toBe(1);
    expect(observed[0]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end — the arc's headline: a child asked once, its parent process
// "died" (fresh face over the persisted chain), the RESUMED child hits the
// same ask and replays instead of re-asking.
// ---------------------------------------------------------------------------

describe("end-to-end: resume replays the recorded approval", () => {
  it("run 1 asks once and receipts; resumeFrom run 2 replays with ZERO second prompt", async () => {
    harness = new StdinHarness();
    harness.install();
    try {
      const call = { role: "coder" } as const;
      const toolCall: AssistantMessage = { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "pnpm test" } }] };
      const task = createAgentsTaskTool({
        model: scriptedModel([toolCall, { role: "assistant", content: "worker report: done" }, toolCall, { role: "assistant", content: "worker report: resumed" }]),
        allTools: [stubRunCommand()],
        registry: createSessionRegistry(),
        workspaceRoot: root,
        runId: "e2e",
        canUseTool: createPermissionGate(["wudao", "x"]), // the production shape — undecorated; the task tool decorates per dispatch
      });
      const p1 = task.execute({ ...call, description: "first", prompt: "run the suite", session: "new" });
      await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "run-1 ask to render");
      harness.answer("y");
      const r1 = await p1;
      expect(r1.isError).not.toBe(true);
      const promptsAfterRun1 = harness.promptSoFar();

      const p2 = task.execute({ ...call, description: "resume", prompt: "continue", resumeFrom: "t-1" });
      const r2 = await p2;
      expect(r2.isError).not.toBe(true);
      expect(harness.promptSoFar()).toBe(promptsAfterRun1); // NO second ask — the receipt answered
      expect(r2.content).toContain("worker report: resumed");
    } finally {
      harness.uninstall();
    }
  });
});
