// ω99-30 (C) — the cli pin: ONLY mission_next carries loopExempt among the
// nine mission tools. It is the one poll-shaped member (the state machine's
// designed advance cadence — every task ends with the same mission_next({})
// shape, each call claiming a DIFFERENT task); every action-shaped member
// stays counted, because repeated actions SHOULD alarm. The judgment table
// lives in the arc report.
import { describe, it, expect } from "vitest";
import { createMissionTools } from "../src/mission.js";

describe("ω99-30 T1 — mission tools × loopExempt annotation", () => {
  const tools = createMissionTools(() => undefined);
  const byName = new Map(tools.map((t) => [t.name, t]));

  it("the nine-tool roster is unchanged (order pins the tool-list prefix)", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "mission_plan",
      "mission_next",
      "mission_complete",
      "mission_fail",
      "mission_ratchet",
      "mission_know_add",
      "mission_know",
      "mission_bundle",
      "mission_start",
    ]);
  });

  it("mission_next is loopExempt — the designed polling cadence (ω99-26 :2080)", () => {
    expect(byName.get("mission_next")?.loopExempt?.({})).toBe(true);
  });

  it("every other mission tool stays counted (fail-closed: not exempt)", () => {
    for (const t of tools.filter((t) => t.name !== "mission_next")) {
      expect(t.loopExempt?.({}), `${t.name} must not be loopExempt`).not.toBe(true);
    }
  });
});
