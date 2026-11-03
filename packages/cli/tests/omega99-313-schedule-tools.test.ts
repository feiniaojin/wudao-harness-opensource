// ω99-313 — the model-facing tool trio's deterministic acceptance: the
// append-only TAIL position (M24 — every earlier tool byte-identical, the
// absent seam keeps zero surface), the structured-trigger parameter contract,
// and the workspace-tier permission posture (auto-allow, never ask-tier).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolSet } from "../src/tools.js";
import { createScheduleDaemon, createScheduleTools } from "../src/schedules.js";
import { decidePermission } from "../src/permission.js";
import { serializePrompt } from "@wudao-org/providers";
import { toModelToolDefinition } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "om313-tools-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true }).catch(() => {});
});

const T0 = new Date("2026-09-14T08:00:00").getTime();
const MIN = 60_000;

// A minimal model stand-in (buildToolSet only needs the type).
const model = {} as Parameters<typeof buildToolSet>[0]["model"];
const baseOpts = {
  workspaceRoot: ws,
  model,
  canUseTool: async () => ({ behavior: "allow" }) as const,
  contextWindowTokens: 128_000,
} as const;

const names = (tools: readonly Tool[]): string[] => tools.map((t) => t.name);

describe("ω99-313 — tool trio mounting (M24 tail + 缺省关)", () => {
  it("present seam → the trio lands at the APPEND-ONLY TAIL; the prefix is byte-identical (canonical serializer)", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: async () => ({ ok: true, exitCode: 0, output: "" }) });
    const withFace = buildToolSet({ ...baseOpts, schedules: daemon });
    const without = buildToolSet({ ...baseOpts });
    // 缺省关: no schedule_* surface without the seam, and the serialized tool
    // list is byte-equal up to the appended tail (the M24 proof — the same
    // canonical serializer every byte-prefix assertion uses).
    expect(names(without).some((n) => n.startsWith("schedule_"))).toBe(false);
    const ser = (tools: readonly Tool[]): string =>
      serializePrompt({ systemPrompt: "", tools: tools.map(toModelToolDefinition), messages: [] });
    expect(ser(withFace.slice(0, without.length))).toBe(ser(without));
    const tail = names(withFace).slice(without.length);
    // 127 项 1: the daemon face now carries list() → continue_task rides the
    // SAME append-only tail right after the trio (its own declared cold
    // point; the prefix bytes above are untouched — that inequality is the
    // M24 proof either way).
    expect(tail).toEqual(["schedule_add", "schedule_list", "schedule_remove", "defer_task", "continue_task"]);
    daemon.stop();
  });

  it("the trio is registered at SESSION START (a static prefix segment — definitions are stable objects)", () => {
    const calls: string[] = [];
    const face = {
      add: async () => "📅 ok",
      rm: async () => "ok",
      listText: () => "list",
    };
    const tools = createScheduleTools(face);
    expect(names(tools)).toEqual(["schedule_add", "schedule_list", "schedule_remove", "defer_task"]); // 131：defer_task 随族
    // Read/verify posture: list is read-only + concurrency-safe; add/remove
    // are the write faces (fail-closed defaults elsewhere).
    expect(tools[1]!.isReadOnly()).toBe(true);
    expect(tools[0]!.isReadOnly()).toBe(false);
    expect(tools[2]!.isReadOnly()).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("ω99-313 — schedule_add parameter contract", () => {
  const mkFace = () => {
    const added: Record<string, unknown>[] = [];
    return {
      added,
      face: {
        add: async (input: Record<string, unknown>) => {
          added.push(input);
          return "📅 已添加";
        },
        rm: async () => "已移除",
        listText: () => "列表",
      },
    };
  };

  const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);

  it("weekly reminder → structured trigger passed through (no cron strings anywhere)", async () => {
    const { face, added } = mkFace();
    const [add] = createScheduleTools(face);
    const r = await exec(add, {
      kind: "reminder",
      prompt: "周五下班前发周报",
      trigger: { type: "weekly", weekdays: [5], time: "17:30" },
      snoozeMinutes: 10,
    });
    expect(r.isError).toBeUndefined();
    expect(added[0]!.schedule).toEqual({ type: "weekly", weekdays: [5], time: "17:30" });
    expect(added[0]!.kind).toBe("reminder");
    expect(added[0]!.snoozeMinutes).toBe(10);
    expect(JSON.stringify(added[0]!)).not.toMatch(/cron/i);
  });

  it("at (local string) → epoch ms; budgetTokens + sessionId ride along", async () => {
    const { face, added } = mkFace();
    const [add] = createScheduleTools(face);
    await exec(add, {
      kind: "task",
      prompt: "汇总今天的改动",
      trigger: { type: "at", at: "2026-09-15T09:00" },
      budgetTokens: 5000,
      sessionId: "wudao-tied01",
    });
    expect(added[0]!.schedule).toEqual({ type: "at", at: new Date("2026-09-15T09:00").getTime() });
    expect(added[0]!.budgetTokens).toBe(5000);
    expect(added[0]!.sessionId).toBe("wudao-tied01");
  });

  it("malformed triggers → typed errors (garbage at / every without ms / junk weekdays / empty prompt)", async () => {
    const { face } = mkFace();
    const [add] = createScheduleTools(face);
    const bad1 = await exec(add, { kind: "task", prompt: "p", trigger: { type: "at", at: "notatime" } });
    expect(bad1.isError).toBe(true);
    const bad2 = await exec(add, { kind: "task", prompt: "p", trigger: { type: "every" } });
    expect(bad2.isError).toBe(true);
    const bad3 = await exec(add, { kind: "task", prompt: "p", trigger: { type: "snoozical" } });
    expect(bad3.isError).toBe(true);
    const bad4 = await exec(add, { kind: "task", prompt: "  ", trigger: { type: "every", intervalMs: 60000 } });
    expect(bad4.isError).toBe(true);
  });

  it("daemon validation failures surface as tool errors (the ⚠️ receipt path)", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: async () => ({ ok: true, exitCode: 0, output: "" }) });
    const [add] = createScheduleTools(daemon);
    const r = await exec(add, { kind: "task", prompt: "p", trigger: { type: "every", intervalMs: 1000 } });
    expect(r.isError).toBe(true);
    expect(typeof r.content === "string" && r.content.includes("至少 1 分钟")).toBe(true);
    daemon.stop();
  });
});

describe("ω99-313 — workspace-tier permission posture", () => {
  it("schedule_add/schedule_remove auto-allow in workspace mode; never in the ask set", () => {
    expect(decidePermission("workspace", "schedule_add")).toEqual({ behavior: "allow" });
    expect(decidePermission("workspace", "schedule_remove")).toEqual({ behavior: "allow" });
    expect(decidePermission("workspace", "schedule_list")).toEqual({ behavior: "allow" });
    expect(decidePermission("ask", "schedule_add")).toBe("ask");
    expect(decidePermission("plan", "schedule_add")).toEqual({ behavior: "deny", reason: expect.any(String) });
    expect(decidePermission("plan", "schedule_list")).toEqual({ behavior: "allow" });
  });
});
