// 121 #4 — 幸存现场对模型可见：恢复 admission 成功后注入一次性 system note
// （a reference harness eefdcb42f「Prior Session」形，超越点=MetaNote 瞬态投影）。钉四
// 件事：恢复路径注入 / 干净路径零注入 / 注入一次不复注 / 恢复后新消息不带残
// 留。★红线（242 同款）：全 mock/脚本化（scripted model、stub driver/port），
// 夹具只写 tmpdir，无真模型调用、无真进程重启。
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool } from "@wudao/core";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao/core";
import { createRecoveryPort, RECOVERY_SESSION_NOTE } from "../src/recovery-admission.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "o121-note-"));

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// ---------------------------------------------------------------------------
// Port-level: the injection seam (fake driver — only the surface admit() uses)
// ---------------------------------------------------------------------------

/** A minimal driver double recording the calls the recovery port makes. The
 * returned control object IS the double — mutate its outcome fields directly. */
function fakeDriver(current: string | undefined) {
  const resumes: string[] = [];
  const notes: string[] = [];
  const submits: string[] = [];
  const d = {
    resumes, notes, submits,
    resumeOutcome: { ok: true as const } as { ok: true } | { ok: false; reason: "occupied"; holderPid: number },
    submitOutcome: "started",
    getSessionId: (): string | undefined => current,
    resume: async (id: string) => {
      resumes.push(id);
      return d.resumeOutcome;
    },
    submit: (text: string) => {
      submits.push(text);
      return d.submitOutcome;
    },
    isIdle: (): boolean => true,
    pushMetaNote: (text: string) => { notes.push(text); },
  };
  return { driver: d as unknown as AgentDriver, ctl: d, resumes, notes, submits };
}

/** The store double: one half-open turn session file (the unfinished shape),
 * parsed to entry objects (the chain projection reads them structurally). */
const halfTurnEntries = [
  { role: "user", content: "夜里把迁移做完" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "pnpm test" } }] },
];

function fakeStore(): { loadSessionEntries: (id: string) => Promise<typeof halfTurnEntries>; list: () => Promise<string[]> } {
  return {
    loadSessionEntries: async () => halfTurnEntries,
    list: async () => [],
  };
}

describe("121 #4 recovery session note — port seam", () => {
  it("recovery path injects: after a successful resume the note lands exactly once, before the recovery prompt submit", async () => {
    const f = fakeDriver("other-session");
    const port = createRecoveryPort({ driver: f.driver, workspaceRoot: tmp(), store: fakeStore() as never });
    const settle = await port.admit("nighttask01");
    expect(settle).toEqual({ verifiedDone: 0, remaining: 1 });
    expect(f.resumes).toEqual(["nighttask01"]);
    // Exactly one note, byte-pinned to the exported constant.
    expect(f.notes).toEqual([RECOVERY_SESSION_NOTE]);
    // Ordering: the note is queued BEFORE the verify-first prompt submit, so
    // it rides the recovery run's FIRST model call (在首条用户消息前).
    expect(f.submits.length).toBe(1);
    expect(f.submits[0]?.startsWith("继续之前的任务。上一进程在执行中中断")).toBe(true);
  });

  it("the boot --continue arm (session already current) is a truthful recovery too — note lands, no re-resume", async () => {
    const f = fakeDriver("nighttask01");
    const port = createRecoveryPort({ driver: f.driver, workspaceRoot: tmp(), store: fakeStore() as never });
    await port.admit("nighttask01");
    expect(f.resumes).toEqual([]); // already loaded — resume skipped
    expect(f.notes).toEqual([RECOVERY_SESSION_NOTE]);
  });

  it("注入一次不复注: a second admission of the same session (same boot/port) does not re-note", async () => {
    const f = fakeDriver("other-session");
    const port = createRecoveryPort({ driver: f.driver, workspaceRoot: tmp(), store: fakeStore() as never });
    await port.admit("nighttask01");
    await port.admit("nighttask01"); // the coordinator never does this (claim discipline) — the port holds the line anyway
    expect(f.notes).toEqual([RECOVERY_SESSION_NOTE]);
  });

  it("a refused resume never notes (no recovery, no note)", async () => {
    const f = fakeDriver("other-session");
    f.ctl.resumeOutcome = { ok: false, reason: "occupied", holderPid: 4242 };
    const port = createRecoveryPort({ driver: f.driver, workspaceRoot: tmp(), store: fakeStore() as never });
    await expect(port.admit("nighttask01")).rejects.toThrow("resume refused");
    expect(f.notes).toEqual([]);
    expect(f.submits).toEqual([]);
  });

  it("a refused submit leaves the note queued — the recovery DID happen; the note rides the next model call instead", async () => {
    const f = fakeDriver("other-session");
    f.ctl.submitOutcome = "rejected";
    const port = createRecoveryPort({ driver: f.driver, workspaceRoot: tmp(), store: fakeStore() as never });
    await expect(port.admit("nighttask01")).rejects.toThrow("recovery submit not admitted");
    expect(f.notes).toEqual([RECOVERY_SESSION_NOTE]); // truthful: the session WAS resumed
    expect(f.notes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Driver-level: the projection residency through the REAL driver wiring
// ---------------------------------------------------------------------------

/** Records every ModelInput the loop serializes (meta-notes.test.ts 的同款). */
function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

const constantTool: Tool = buildTool({
  name: "read_file",
  description: "stub read",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  execute: async () => ({ content: "SAME STUB CONTENT" }),
});

const allow = async (): Promise<{ kind: "allow" }> => ({ kind: "allow" });

function makeDriver(model: ModelClient, tools: readonly Tool[]): AgentDriver {
  return createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools, onPermissionAsk: allow });
}

describe("121 #4 recovery session note — driver residency", () => {
  it("干净路径零注入: a clean session's model inputs never carry the note (bytes unchanged)", async () => {
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
      { role: "assistant", content: "clean done" },
    ]);
    const driver = makeDriver(model, [constantTool]);
    await wait();
    driver.submit("正常工作");
    await until(() => driver.getStatus().busy === false, "run to finish");
    expect(model.inputs.length).toBe(2);
    // The time-reminder note legitimately rides call 1 (every run's first
    // boundary); the recovery note must appear NOWHERE (无恢复→字节不变).
    for (const input of model.inputs) {
      expect(JSON.stringify(input.messages)).not.toContain("系统注入·会话恢复");
      expect(JSON.stringify(input.messages)).not.toContain("会话从崩溃/重启中恢复");
    }
    expect(JSON.stringify(driver.getHistory())).not.toContain("系统注入·会话恢复");
    driver.dispose();
  });

  it("恢复后新消息不带残留: the note rides exactly ONE model call (the recovery turn's first) and never the persisted history", async () => {
    // The port pushes the note between resume and submit; this pins the same
    // wiring through the real driver: queue → first model call projection →
    // drained (no residue on the second call).
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
      { role: "assistant", content: "recovered and done" },
    ]);
    const driver = makeDriver(model, [constantTool]);
    await wait();
    driver.pushMetaNote(RECOVERY_SESSION_NOTE); // the exact push the port's admit() makes
    driver.submit("继续之前的任务");
    await until(() => driver.getStatus().busy === false, "run to finish");
    expect(model.inputs.length).toBe(2);
    // Call 1: the note IS model-visible (user-channel degrade — fresh history
    // has no tool_result yet), landing BEFORE the user turn's reply.
    const call1 = model.inputs[0]?.messages ?? [];
    expect(call1.some((m) => String(m.content).includes("[系统注入·会话恢复]"))).toBe(true);
    // Call 2: no residue — the projection is transient (ω99-28 T2: the revert
    // is the declared one-line divergence, not a rewrite).
    const call2 = model.inputs[1]?.messages ?? [];
    expect(call2.some((m) => String(m.content).includes("系统注入·会话恢复"))).toBe(false);
    // 信息结构零改写: no user/assistant/tool HISTORY entry carries the note.
    // The ONLY trace is the designed human-side receipt — a notice entry
    // (source 系统通道) for the meta_note event (0.3.10 审计面)，which is a
    // view row, never part of the model's message chain.
    const entries = driver.getHistory() as ReadonlyArray<{ kind?: string; text?: string; source?: string }>;
    expect(entries.some((e) => e.kind !== "notice" && String(e.text).includes("系统注入·会话恢复"))).toBe(false);
    expect(entries.some((e) => e.kind === "notice" && e.source === "系统通道" && String(e.text).includes("[系统注入·会话恢复]"))).toBe(true);
    driver.dispose();
  });
});
