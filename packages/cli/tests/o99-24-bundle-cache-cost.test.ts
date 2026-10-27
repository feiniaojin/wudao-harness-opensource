// ω99-24 — bundle lifecycle cache cost: M24 declaration + turn-boundary
// compensation. Dogfood (ω99-20B) measured the mission-bundle lifecycle's
// prefix-cache bill: the TERMINAL unmount broke the system header mid-campaign
// (miss 123.2k at "all tasks green, wrap-up still running"), reported as an
// ⚠️ anomaly plus two follow-up `eviction?` suspicion lines. This arc:
//   A — the terminal unmount (complete/abandon) DEFERS to the session
//       boundary: boot's unconditional buildExtensionState reads the terminal
//       ledger and mounts nothing, so the mid-run header break disappears as a
//       CLASS; the visible cost (the <available_skills> manifest stays briefly
//       stale) is compensated with ONE notice line on the mission_complete
//       tool result. start/bundle keep their mid-run rescan (mount is needed
//       immediately and naturally lands early, history still short).
//   B — onBundlesChanged carries a TYPED reason (mount/unmount + names) so the
//       rescan seam can stamp the next usage row cold-and-expected (M24).
//   C — expected breaks render as info lines naming the cause, and the
//       aftershock spike right after one no longer cries "eviction?".
// Zero real shell, zero network; every fs touch lives under mkdtemp sandboxes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, ModelClient, ModelInput, ModelUsage } from "@wudao/core";
import { serializePrompt } from "@wudao/providers";
import {
  createMissionController,
  createMissionTools,
  MISSION_STORE_FILE,
  activeBundleSkillRoots,
  type MissionController,
  type MissionState,
  type MissionStoreHandle,
} from "../src/mission.js";
import {
  buildExtensionState,
  rescanExtensionsAt,
  resetExtensionRuntime,
  takePendingBundleColdAttribution,
} from "../src/extension-state.js";
import { createCacheTrackingModel, detectCacheBreak, formatUsageLine } from "../src/cache.js";

let ws: string;
let home: string; // isolated WUDAO_GLOBAL_HOME — the global tier never reaches the dev's real home
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "o99-24-"));
  home = await mkdtemp(join(tmpdir(), "o99-24-home-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const skillMd = (name: string): string => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${name} body.\n`;

/** Write a bundle under a workspace: one dir + SKILL.md per skill. */
async function makeBundle(root: string, name: string, skills: readonly string[]): Promise<void> {
  for (const s of skills) {
    const dir = join(root, ".wudao", "mission-bundles", name, "skills", s);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skillMd(s), "utf8");
  }
}

/** In-memory store fixture + a bundles-changed spy (m81-mission-bundle's pattern). */
async function fixture(o: { readonly onBundlesChanged?: () => void | Promise<void> } = {}) {
  const notices: string[] = [];
  let persisted: MissionState | null = null;
  const store: MissionStoreHandle = {
    get mission() {
      return persisted;
    },
    save: async (next) => {
      persisted = next;
    },
  };
  const controller = await createMissionController({
    workspaceRoot: ws,
    notify: (t) => notices.push(t),
    store,
    ...(o.onBundlesChanged !== undefined ? { onBundlesChanged: o.onBundlesChanged } : {}),
  });
  return { controller, notices, persisted: () => persisted };
}

/** A mission ledger snapshot (B6's shape) with bundles and a chosen status. */
const ledger = (bundles: readonly string[], status: "active" | "completed" | "abandoned"): string =>
  JSON.stringify({
    version: 1,
    mission: {
      id: "mtest",
      objective: "迁移到新架构",
      createdAt: "2026-01-01T00:00:00.000Z",
      status,
      tasks: [],
      ratchet: [],
      notes: [],
      ...(bundles.length > 0 ? { bundles } : {}),
    },
  });

describe("ω99-24 A — the terminal unmount defers to the session boundary", () => {
  it("final complete fires ZERO rescans, keeps the bundle declarations, and its tool result names the deferred unload", async () => {
    await makeBundle(ws, "demo", ["alpha"]);
    const fires: string[] = [];
    const f = await fixture({ onBundlesChanged: () => { fires.push("fire"); } });
    await f.controller.start("campaign");
    expect(fires.length).toBe(1); // start keeps its mid-run rescan (A)
    await f.controller.bundle("demo"); // mount keeps it too — needed immediately, lands early
    expect(fires.length).toBe(2);
    await f.controller.plan([{ title: "a" }]);
    await f.controller.nextReady(); // t1 → doing
    // The TERMINAL flip: all tasks done. ω99-24 A — no mid-run rescan here:
    // the 123k-class header break at "all green, wrap-up running" is gone.
    const r = await f.controller.complete("t1", "done");
    expect(r.ok).toBe(true);
    expect(fires.length).toBe(2); // ← RED today: the terminal flip fires a third
    // The visible cost is compensated: one notice line on the tool result.
    expect(r.text).toContain("会话边界");
    // The ledger KEEPS its declarations (append-only history; the mount face
    // dies with status≠active at the boundary, not the declaration).
    expect(f.controller.snapshot()?.status).toBe("completed");
    expect(f.controller.snapshot()?.bundles).toEqual(["demo"]);
  });

  it("abandon fires ZERO rescans and names the deferred unload; a bundle-less mission adds no unload noise", async () => {
    await makeBundle(ws, "demo", ["alpha"]);
    const fires: string[] = [];
    const f = await fixture({ onBundlesChanged: () => { fires.push("fire"); } });
    await f.controller.start("first");
    await f.controller.bundle("demo");
    const before = fires.length;
    expect(before).toBe(2);
    const text = await f.controller.abandon();
    expect(fires.length).toBe(before); // ← RED today: abandon fires
    expect(text).toContain("会话边界"); // the same deferred-unload compensation
    // a bundle-less terminal adds NO unload line (nothing was mounted)
    await f.controller.start("second");
    const bare = await f.controller.abandon();
    expect(fires.length).toBe(before + 1); // only start()'s own fire in between
    expect(bare).not.toContain("会话边界");
  });

  it("the mission_complete TOOL result (not just the controller face) carries the notice line", async () => {
    await makeBundle(ws, "demo", ["alpha"]);
    const box: { current?: MissionController } = {};
    const controller = await createMissionController({ workspaceRoot: ws, notify: () => {} });
    box.current = controller;
    const tools = createMissionTools(() => box.current);
    await controller.start("campaign");
    await controller.bundle("demo");
    await controller.plan([{ title: "a" }]);
    await controller.nextReady();
    const res = await tools.find((t) => t.name === "mission_complete")!.execute({ taskId: "t1" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("会话边界");
  });

  it("the deferral target works: boot's ONE assembly mounts NOTHING for a terminal ledger while the declaration stays", async () => {
    await makeBundle(ws, "demo", ["alpha"]);
    await mkdir(join(ws, ".wudao"), { recursive: true });
    const env = { ...process.env, WUDAO_GLOBAL_HOME: home };
    for (const status of ["completed", "abandoned"] as const) {
      await writeFile(join(ws, ".wudao", MISSION_STORE_FILE), ledger(["demo"], status), "utf8");
      expect(activeBundleSkillRoots(ws)).toEqual([]); // status≠active ⇒ never mounted
      const state = await buildExtensionState(ws, [], { env });
      expect(state.skills.map((s) => s.name)).not.toContain("alpha");
    }
  });
});

/** A model whose generate reports PRESET usage rows in order (cache.test.ts's
 *  fakeModel, trimmed to this file's needs). */
function usageModel(usages: readonly ModelUsage[]): ModelClient {
  let i = 0;
  return {
    async generate(input: ModelInput) {
      const usage = usages[i];
      i += 1;
      if (usage) input.onUsage?.(usage);
      return { role: "assistant", content: `a-${i}` };
    },
  };
}

describe("ω99-24 B — onBundlesChanged carries a typed reason; the seam declares the next usage row", () => {
  it("start/bundle pass their typed reason (unmount of the dead ledger / mount of the new pack)", async () => {
    const reasons: unknown[] = [];
    const f = await fixture({ onBundlesChanged: (...args: unknown[]) => { reasons.push(args[0]); } });
    await f.controller.start("campaign");
    expect(reasons).toEqual([{ op: "unmount", names: [] }]); // the dead ledger carried no packs
    await makeBundle(ws, "demo", ["alpha"]);
    await makeBundle(ws, "kit2", ["beta"]);
    await f.controller.bundle("demo");
    expect(reasons[1]).toEqual({ op: "mount", names: ["demo"] });
    await f.controller.bundle("kit2");
    expect(reasons[2]).toEqual({ op: "mount", names: ["kit2"] });
    // the terminal points (A) never fire; the NEXT start names the dead packs
    await f.controller.abandon();
    expect(reasons).toHaveLength(3);
    await f.controller.start("second");
    expect(reasons[3]).toEqual({ op: "unmount", names: ["demo", "kit2"] });
  });

  it("the rescan seam parks the LAST reasoned attribution (one-shot take); a reason-less rescan parks nothing", async () => {
    resetExtensionRuntime(); // clean module box
    await rescanExtensionsAt(ws); // no reason — plugin/trust rescans share this seam unchanged
    expect(takePendingBundleColdAttribution()).toBeUndefined();
    await rescanExtensionsAt(ws, { op: "mount", names: ["demo"] });
    expect(takePendingBundleColdAttribution()).toBe("mission-bundle:mount demo");
    expect(takePendingBundleColdAttribution()).toBeUndefined(); // one-shot
    await rescanExtensionsAt(ws, { op: "unmount", names: ["demo", "kit2"] });
    await rescanExtensionsAt(ws, { op: "mount", names: ["late"] }); // the LAST reason wins
    expect(takePendingBundleColdAttribution()).toBe("mission-bundle:mount late");
    // empty names (a start over a bundle-less ledger) moved no bytes — parks nothing
    await rescanExtensionsAt(ws, { op: "unmount", names: [] });
    expect(takePendingBundleColdAttribution()).toBeUndefined();
  });

  it("the wrapper stamps the NEXT main-call usage row cold-and-expected; side calls never consume it", async () => {
    resetExtensionRuntime();
    const raw = { promptTokens: 30000, cacheHitTokens: 0, cacheMissTokens: 30000 };
    const rows: ModelUsage[] = [];
    const tracked = createCacheTrackingModel(usageModel([raw, raw, raw, raw, raw]), {
      pendingColdAttribution: takePendingBundleColdAttribution,
      onUsage: (u) => rows.push(u),
    });
    const send = (content: string, querySource?: string): Promise<unknown> =>
      tracked.generate({ systemPrompt: "s", messages: [{ role: "user", content }], tools: [], ...(querySource !== undefined ? { querySource } : {}) });
    await send("one");
    expect(rows[0]).toBe(raw); // nothing parked — the row passes through UNTOUCHED (byte-identical)
    // a mount lands between runs — the next MAIN row declares itself cold, named
    await rescanExtensionsAt(ws, { op: "mount", names: ["demo"] });
    await send("two");
    expect(rows[1]?.coldTurnExpected).toBe(true);
    expect(rows[1]?.cacheBreakAttribution).toBe("mission-bundle:mount demo");
    expect(formatUsageLine(rows[1]!)).toContain("[冷：mission-bundle:mount demo]"); // ω99-188: 钉随源演进（the consumer line）
    // one-shot: the row after is bare again — identity with the raw row, no residue
    await send("three");
    expect(rows[2]).toBe(raw);
    // a tagged side call rides another prefix — it must NOT consume the park
    await rescanExtensionsAt(ws, { op: "unmount", names: ["demo"] });
    await send("side", "title");
    expect(rows[3]?.coldTurnExpected).toBeUndefined();
    await send("four"); // the next MAIN row takes it
    expect(rows[4]?.cacheBreakAttribution).toBe("mission-bundle:unmount demo");
  });

  it("end to end: the mission fire reason reaches the seam and becomes the parked attribution", async () => {
    resetExtensionRuntime();
    await makeBundle(ws, "demo", ["alpha"]);
    const f = await fixture({ onBundlesChanged: (reason) => rescanExtensionsAt(ws, reason) });
    await f.controller.start("campaign");
    await f.controller.bundle("demo");
    expect(takePendingBundleColdAttribution()).toBe("mission-bundle:mount demo");
  });
});

describe("ω99-24 C — an expected break reads as info; its aftershock stops crying eviction", () => {
  const base: AgentMessage[] = [{ role: "user", content: "go" }];
  const grown: AgentMessage[] = [...base, { role: "assistant", content: "a" }, { role: "user", content: "again" }];
  const ser = (systemPrompt: string, messages: readonly AgentMessage[]): string => serializePrompt({ systemPrompt, tools: [], messages });

  it("a header break on a declared row renders ONE info line naming the cause, not ⚠️", () => {
    const warning = detectCacheBreak({
      prevSerialized: ser("sys", base),
      currSerialized: ser("sys +skills-manifest", grown),
      currMessages: grown,
      missTokens: 12000,
      recentMisses: [500, 500],
      expectedColdAttribution: "mission-bundle:unmount demo",
    });
    expect(warning).toBe("ℹ️ expected: mission-bundle:unmount demo (turn 1) — miss 12k");
  });

  it("the row right AFTER an expected break no longer reports the eviction suspicion (one-shot)", () => {
    const input = {
      prevSerialized: ser("sys", grown),
      currSerialized: ser("sys", [...grown, { role: "assistant", content: "b" }, { role: "user", content: "d" }]),
      currMessages: grown,
      missTokens: 63000,
      recentMisses: [100, 200, 15000],
    };
    // without the flag the SAME input is the eviction signature — the true
    // signal this test must not swallow
    expect(detectCacheBreak({ ...input })).toContain("provider-side eviction");
    // with it (the row after a declared break): silent — the residual spike
    // is the declared break's aftershock, not an eviction
    expect(detectCacheBreak({ ...input, afterExpectedBreak: true })).toBeUndefined();
  });

  it("a header break with NO declaration keeps the ⚠️ anomaly wording (降噪不吞真信号)", () => {
    const warning = detectCacheBreak({
      prevSerialized: ser("sys", base),
      currSerialized: ser("sys CHANGED", grown),
      currMessages: grown,
      missTokens: 12000,
      recentMisses: [500, 500],
    });
    expect(warning).toBe("⚠️ cache break at system/tools header (turn 1) — miss 12k");
  });

  it("through the wrapper: mount → ℹ️ expected; the aftershock stays silent; a LATER real eviction still ⚠️", async () => {
    resetExtensionRuntime();
    const usages: ModelUsage[] = [
      { promptTokens: 5000, cacheHitTokens: 4900, cacheMissTokens: 100 },
      { promptTokens: 6000, cacheHitTokens: 5800, cacheMissTokens: 200 },
      { promptTokens: 20000, cacheHitTokens: 5000, cacheMissTokens: 15000 }, // the mount break (declared, dogfood-sized)
      { promptTokens: 70000, cacheHitTokens: 7000, cacheMissTokens: 63000 }, // the aftershock (dogfood's mislabeled 63k)
      { promptTokens: 71000, cacheHitTokens: 70000, cacheMissTokens: 1000 }, // calm — re-seed the baseline
      { promptTokens: 131000, cacheHitTokens: 71000, cacheMissTokens: 60000 }, // a REAL eviction later
    ];
    const breaks: string[] = [];
    const tracked = createCacheTrackingModel(usageModel(usages), {
      pendingColdAttribution: takePendingBundleColdAttribution,
      onBreak: (w) => breaks.push(w),
    });
    const step = (messages: readonly AgentMessage[]): readonly AgentMessage[] => [
      ...messages,
      { role: "assistant", content: "a" },
      { role: "user", content: "n" },
    ];
    const m2 = step(base); // 1 assistant so far
    await tracked.generate({ systemPrompt: "s", tools: [], messages: base });
    await tracked.generate({ systemPrompt: "s", tools: [], messages: m2 });
    // the mount lands between runs: the seam parks the declaration, and the
    // next row's system prompt carries the changed skills manifest
    await rescanExtensionsAt(ws, { op: "mount", names: ["demo"] });
    const m3 = step(m2); // 2 assistants
    await tracked.generate({ systemPrompt: "s +skills", tools: [], messages: m3 });
    // ω99-28 T2: the wrapper passes promptTokens with every row — the tier is
    // full (miss 15k of the row's 20k prompt tokens, 75.0%).
    expect(breaks).toEqual(["ℹ️ expected: mission-bundle:mount demo (turn 2) — miss 15k/20k (75.0%)"]); // no ⚠️ for a by-design break
    // aftershock: pure extension of the new prefix, miss far beyond the delta
    await tracked.generate({ systemPrompt: "s +skills", tools: [], messages: step(m3) });
    expect(breaks).toHaveLength(1); // the eviction suspicion line is GONE
    // calm, then a REAL eviction (same signature, no declared context) still reports
    await tracked.generate({ systemPrompt: "s +skills", tools: [], messages: step(step(m3)) });
    await tracked.generate({ systemPrompt: "s +skills", tools: [], messages: step(step(step(m3))) });
    expect(breaks).toHaveLength(2);
    expect(breaks[1]).toContain("⚠️");
    expect(breaks[1]).toContain("provider-side eviction");
  });
});
