// ω99-78 — teams send: validation precedes side effects (66-③ parked debt).
// runtime.send must reject overlong text (TEAM_MESSAGE_MAX_CHARS) at the
// ENTRY — BEFORE the receiver review, which is a policy side effect (a
// review pass the sender pays for + a "blocked by review" notify on deny).
// The peer lane already does this at its send entry (peer/runtime.ts checks
// PEER_TEXT_MAX_CHARS with a got count); this pins the SAME law + the SAME
// semantic shape (got count) for teams, both arms (lead / teammate).
// deliverTeamMail keeps its own check as defense-in-depth — untouched here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao-org/core";
import { createReadFileTool, createWriteFileTool } from "@wudao-org/core";
import { createTeamRuntime, LEAD_NAME, type TeamRuntime } from "../src/teams/runtime.js";
import { TEAM_MESSAGE_MAX_CHARS, readTeamInbox } from "../src/teams/mailbox.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until<T>(cond: () => T | undefined | false, what: string, timeoutMs = 6000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait(15);
  }
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "om78-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A queue-fed scripted model: each generate() consumes the next response. */
function queueModel(responses: readonly AssistantMessage[], inputs: ModelInput[] = []): ModelClient & { inputs: ModelInput[] } {
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

/** A team whose review + notify lanes are SPIES (review passes by default). */
function makeTeam(over: Partial<Parameters<typeof createTeamRuntime>[0]> = {}): {
  team: TeamRuntime;
  reviewCalls: () => number;
  notices: string[];
} {
  let calls = 0;
  const notices: string[] = [];
  const team = createTeamRuntime({
    workspaceRoot: root,
    team: "alpha",
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    model: queueModel([{ role: "assistant", content: "ok" }]),
    tools: [createReadFileTool({ workspaceRoot: root }), createWriteFileTool({ workspaceRoot: root })] as readonly Tool[],
    notify: (line) => notices.push(line),
    reviewMessage: async () => {
      calls += 1;
      return true;
    },
    ...over,
  });
  return { team, reviewCalls: () => calls, notices };
}

const overlong = (pad = 1): string => "x".repeat(TEAM_MESSAGE_MAX_CHARS + pad);

describe("ω99-78 teams send — validation precedes side effects", () => {
  it("overlong text is rejected at the send ENTRY: ZERO review passes, no review-blocked notify, got count in the line (teammate arm)", async () => {
    const { team, reviewCalls, notices } = makeTeam();
    try {
      await team.spawnTeammate({ name: "t1", role: "general-purpose", prompt: "brief" });
      await until(() => (team.teammates().find((t) => t.name === "t1")?.status === "idle" ? true : undefined), "idle");
      const over = overlong();
      const r = await team.send(LEAD_NAME, "t1", over);
      expect(r.ok).toBe(false);
      expect(reviewCalls()).toBe(0); // the review pass is NEVER burned on invalid input
      expect(r.line).toContain(`exceeds ${TEAM_MESSAGE_MAX_CHARS} chars (got ${over.length})`); // peer-lane shape: attributable got count
      expect(await readTeamInbox(team.dir, "t1")).toEqual([]); // never delivered
      expect(notices.filter((n) => n.includes("被评审拦截"))).toEqual([]); // no deny noise // ω99-170: 钉随源演进（teams 回执 #8 中文化）
    } finally {
      team.stop();
    }
  }, 15_000);

  it("lead arm — same entry rejection: ZERO review passes, no notify, lead inbox untouched", async () => {
    const { team, reviewCalls, notices } = makeTeam();
    try {
      const over = overlong();
      const r = await team.send("t1", LEAD_NAME, over);
      expect(r.ok).toBe(false);
      expect(reviewCalls()).toBe(0);
      expect(r.line).toContain(`exceeds ${TEAM_MESSAGE_MAX_CHARS} chars (got ${over.length})`);
      expect(await readTeamInbox(team.dir, LEAD_NAME)).toEqual([]);
      expect(notices).toEqual([]); // neither review-blocked noise NOR a rendered mail
    } finally {
      team.stop();
    }
  }, 15_000);

  it("legal messages still review exactly once per send and deliver unchanged (both arms)", async () => {
    const inputs: ModelInput[] = [];
    const model = queueModel([{ role: "assistant", content: "brief done" }, { role: "assistant", content: "awake" }], inputs);
    const { team, reviewCalls, notices } = makeTeam({ model });
    try {
      await team.spawnTeammate({ name: "t1", role: "general-purpose", prompt: "brief" });
      await until(() => (team.teammates().find((t) => t.name === "t1")?.status === "idle" ? true : undefined), "idle");
      // teammate arm: reviewed once, delivered, and the wake carries the mail
      const rt = await team.send(LEAD_NAME, "t1", "status: ok");
      expect(rt.ok).toBe(true);
      expect(reviewCalls()).toBe(1);
      await until(() => (inputs.length >= 2 ? true : undefined), "wake dispatch");
      const wake = inputs[1]!;
      const last = wake.messages[wake.messages.length - 1];
      expect(last && last.role === "user" && last.content).toContain("status: ok");
      // lead arm: reviewed once, delivered, notify renders the banner mail
      const rl = await team.send("t1", LEAD_NAME, "report: done");
      expect(rl.ok).toBe(true);
      expect(reviewCalls()).toBe(2);
      expect((await readTeamInbox(team.dir, LEAD_NAME)).map((e) => e.text)).toContain("report: done");
      expect(notices.some((n) => n.includes("report: done"))).toBe(true);
    } finally {
      team.stop();
    }
  }, 15_000);

  it("boundary: exactly-at-cap text is NOT rejected at the entry (the cap is >, not >=)", async () => {
    const { team, reviewCalls } = makeTeam();
    try {
      const atCap = "y".repeat(TEAM_MESSAGE_MAX_CHARS);
      const r = await team.send("t1", LEAD_NAME, atCap);
      expect(r.ok).toBe(true); // at-cap is legal: reviewed (1) and delivered
      expect(reviewCalls()).toBe(1);
    } finally {
      team.stop();
    }
  }, 15_000);
});
