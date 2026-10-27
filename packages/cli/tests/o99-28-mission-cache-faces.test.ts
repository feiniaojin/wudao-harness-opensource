// ω99-28 — mission lifecycle cache faces (campaign evidence: /tmp/o26-campaign.log).
// T1: every mission-lifecycle header-face change rides the cache-aware swap
//     seam byte-stably — the ω99-26 campaign's turn-3 start rescan dropped the
//     # Peer messaging tail (boot built the prompt with hasPeerTools, the swap
//     sink rebuilt WITHOUT it) and landed an UNDECLARED 18.4k header break.
//     The seam's own byte invariant ("a rescan changes ONLY the trailing
//     <available_skills> manifest") was violated by the sink itself.
// T2: the detector's report carries a cost tier (— miss Xk/Yk (Z%)) on every
//     branch, so a label/cost contradiction (turn 5: "header" + 0.2k paid) is
//     VISIBLE instead of a bare ⚠️.
// T3: the observation channel is one-event-per-line (a warning never sticks
//     to a streaming text tail) and a turn-0 user-message break renders as a
//     cold-start info line, not ⚠️ noise.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, AgentMessage } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { serializePrompt } from "@wudao/providers";
import { detectCacheBreak, createBreakLineGuard } from "../src/cache.js";
import {
  buildExtensionState,
  initExtensionRuntime,
  resetExtensionRuntime,
  rescanExtensionsAt,
  takePendingBundleColdAttribution,
} from "../src/extension-state.js";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";
import { MISSION_STORE_FILE } from "../src/mission.js";

/** Strip the TRAILING <available_skills> manifest (rescan.test.ts's helper). */
function stripSkillsTail(prompt: string): string {
  return prompt.replace(/\n\n<available_skills>[\s\S]*\n<\/available_skills>$/, "");
}
const manifestNames = (prompt: string): string[] =>
  [...prompt.matchAll(/^- name: (.+)$/gm)].map((m) => (m[1] ?? "").split(/\s/)[0] ?? "");

const skillMd = (name: string): string => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${name} body.\n`;

/** Write a mission bundle: one dir + SKILL.md per skill (ω99-24's helper). */
function makeBundle(root: string, name: string, skills: readonly string[]): void {
  for (const s of skills) {
    const dir = join(root, ".wudao", "mission-bundles", name, "skills", s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillMd(s), "utf8");
  }
}

const ledger = (bundles: readonly string[], status: "active" | "completed" | "abandoned"): string =>
  JSON.stringify({
    version: 1,
    mission: {
      id: "mtest",
      objective: "战役",
      createdAt: "2026-01-01T00:00:00.000Z",
      status,
      tasks: [],
      ratchet: [],
      notes: [],
      ...(bundles.length > 0 ? { bundles } : {}),
    },
  });

describe("ω99-28 T1 — mission lifecycle header faces ride the seam byte-stably", () => {
  const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };
  const sessions: DriverSession[] = [];
  const roots: string[] = [];
  const homes: string[] = [];
  beforeEach(() => {
    resetExtensionRuntime();
  });
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    resetExtensionRuntime();
  });

  const okModel = (): ModelClient => ({
    async generate(input: ModelInput) {
      input.onUsage?.({ promptTokens: 1000, cacheHitTokens: 900, cacheMissTokens: 100 });
      return { role: "assistant", content: "ok" };
    },
  });

  /** A driver session booted like the real ones: the extension runtime box is
   *  initialized from the workspace BEFORE the engine registers its swap sink
   *  (index.ts:605's boot order), and the skills handed to the engine match
   *  the boot assembly's. */
  async function bootSession(ws: string, opts: { readonly seedLedger?: string; readonly withBundleSkills?: boolean } = {}): Promise<DriverSession> {
    const home = mkdtempSync(join(tmpdir(), "o28-home-"));
    homes.push(home);
    const env = { ...process.env, WUDAO_GLOBAL_HOME: home };
    if (opts.seedLedger !== undefined) {
      mkdirSync(join(ws, ".wudao"), { recursive: true });
      writeFileSync(join(ws, ".wudao", MISSION_STORE_FILE), opts.seedLedger, "utf8");
    }
    const boot = await buildExtensionState(ws, [], { env });
    initExtensionRuntime(ws, [], boot, { env });
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: okModel(),
      sessionId: `o28-${sessions.length}`,
      ...(opts.withBundleSkills === true ? { skills: boot.skills } : {}),
    });
    sessions.push(session);
    return session;
  }

  it("① mission_start over a bundle-less ledger moves ZERO header bytes (toBe) and parks nothing", async () => {
    const ws = mkdtempSync(join(tmpdir(), "o28-ws-"));
    roots.push(ws);
    const session = await bootSession(ws); // no ledger at all
    const before = session.driver.state.systemPrompt;
    expect(before).toContain("# Peer messaging"); // the campaign shape: peer tools live
    await session.missionBox.current!.start("三方一致性核查");
    expect(session.driver.state.systemPrompt).toBe(before); // RED today: the sink rebuild dropped the peer tail
    expect(takePendingBundleColdAttribution()).toBeUndefined(); // no bytes moved — nothing to declare
  });

  it("② the mount changes bytes EXACTLY ONCE (manifest tail only) and the break lands named", async () => {
    const ws = mkdtempSync(join(tmpdir(), "o28-ws-"));
    roots.push(ws);
    const session = await bootSession(ws, { withBundleSkills: true });
    await session.missionBox.current!.start("campaign");
    const before = session.driver.state.systemPrompt;
    makeBundle(ws, "demo", ["alpha"]);
    await session.missionBox.current!.bundle("demo");
    const after = session.driver.state.systemPrompt;
    expect(after).not.toBe(before); // the ONE byte change…
    expect(stripSkillsTail(after)).toBe(stripSkillsTail(before)); // …is the manifest tail ONLY (peer tail intact)
    expect(manifestNames(after)).toEqual(["alpha"]);
    expect(takePendingBundleColdAttribution()).toBe("mission-bundle:mount demo"); // the named declaration
    // idempotence: a no-op rescan moves nothing further — exactly one change total
    await rescanExtensionsAt(ws);
    expect(session.driver.state.systemPrompt).toBe(after);
  });

  it("③ start over a STALE-MOUNTED dead ledger (terminal mission left skills live) drops them in ONE named move", async () => {
    const ws = mkdtempSync(join(tmpdir(), "o28-ws-"));
    roots.push(ws);
    makeBundle(ws, "bx", ["sx"]);
    // boot reads an ACTIVE mission carrying the bundle → the skills are live
    const session = await bootSession(ws, { seedLedger: ledger(["bx"], "active"), withBundleSkills: true });
    const before = session.driver.state.systemPrompt;
    expect(manifestNames(before)).toContain("sx");
    const c = session.missionBox.current!;
    // the terminal flip does NOT rescan (ω99-24 A): bytes frozen through it…
    await c.plan([{ title: "a" }]);
    await c.nextReady();
    await c.complete("t1");
    expect(session.driver.state.systemPrompt).toBe(before);
    // …the NEXT start is the single named move: the dead packs' skills die now
    await c.start("next campaign");
    const after = session.driver.state.systemPrompt;
    expect(after).not.toBe(before);
    expect(stripSkillsTail(after)).toBe(stripSkillsTail(before)); // tail-only again
    expect(manifestNames(after)).not.toContain("sx");
    expect(takePendingBundleColdAttribution()).toBe("mission-bundle:unmount bx");
  });

  it("④ mount seam regression: the ω99-24 chain still parks + names exactly as before (zero-change pin)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "o28-ws-"));
    roots.push(ws);
    const session = await bootSession(ws);
    await session.missionBox.current!.start("campaign");
    makeBundle(ws, "kit", ["k1"]);
    await session.missionBox.current!.bundle("kit");
    // the B-chain receipt is unchanged in shape: mission-bundle:<op> <names>, one-shot take
    expect(takePendingBundleColdAttribution()).toBe("mission-bundle:mount kit");
    expect(takePendingBundleColdAttribution()).toBeUndefined();
  });
});

describe("ω99-28 T2 — every detector report carries its cost tier", () => {
  const tools = [{ name: "read_file", description: "d", parameters: { type: "object" as const, properties: {}, additionalProperties: false } }];
  const ser = (messages: readonly AgentMessage[]): string => serializePrompt({ systemPrompt: "sys", tools, messages });
  const base: AgentMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "A".repeat(200) },
  ];

  it("①a the truncation report names the cost: miss Xk of Yk (Z%)", () => {
    // A strict-prefix curr (fewer lines) = a history truncation.
    const warning = detectCacheBreak({
      prevSerialized: serializePrompt({ systemPrompt: "sys", tools, messages: [...base, { role: "user", content: "more" }] }),
      currSerialized: ser(base),
      currMessages: base,
      missTokens: 12000,
      promptTokens: 13000,
      recentMisses: [500, 500],
    });
    expect(warning).toBe("⚠️ cache break: history truncated (turn 1) — miss 12k/13k (92.3%)");
  });

  it("①b the eviction report names the cost", () => {
    const grown = [...base, { role: "user", content: "again" }];
    const s1 = ser(base);
    const s2 = ser(grown);
    expect(s2.startsWith(s1)).toBe(true);
    const warning = detectCacheBreak({
      prevSerialized: s1,
      currSerialized: s2,
      currMessages: grown,
      missTokens: 12000,
      promptTokens: 14000,
      recentMisses: [100, 100],
    });
    expect(warning).toBe("⚠️ cache miss spike beyond appended delta — provider-side eviction? (turn 1) — miss 12k/14k (85.7%)");
  });

  it("①c the header report names the cost", () => {
    const grown = [...base, { role: "user", content: "again" }];
    const warning = detectCacheBreak({
      prevSerialized: ser(base),
      currSerialized: serializePrompt({ systemPrompt: "sys CHANGED", tools, messages: grown }),
      currMessages: grown,
      missTokens: 18400,
      promptTokens: 19500,
      recentMisses: [1200, 1200],
    });
    expect(warning).toBe("⚠️ cache break at system/tools header (turn 1) — miss 18.4k/19.5k (94.4%)");
  });

  it("①d the tool-result report names the cost; the ℹ️ expected variant carries it too", () => {
    const rewritten: AgentMessage[] = [
      base[0]!,
      base[1]!,
      { role: "tool", toolCallId: "c1", name: "read_file", content: "[compacted tool_result c1: AAA…]" },
      { role: "user", content: "again" },
    ];
    const raw = detectCacheBreak({
      prevSerialized: ser(base),
      currSerialized: ser(rewritten),
      currMessages: rewritten,
      missTokens: 12000,
      promptTokens: 20000,
      recentMisses: [500, 400, 600],
    });
    expect(raw).toBe("⚠️ cache break at read_file result (turn 0) — miss 12k/20k (60.0%)");
    const declared = detectCacheBreak({
      prevSerialized: ser(base),
      currSerialized: ser(rewritten),
      currMessages: rewritten,
      missTokens: 12000,
      promptTokens: 20000,
      recentMisses: [500, 400, 600],
      expectedColdAttribution: "meta-note projection revert (tail-only)",
    });
    expect(declared).toBe("ℹ️ expected: meta-note projection revert (tail-only) (turn 0) — miss 12k/20k (60.0%)");
  });

  it("①e a missing promptTokens degrades honestly (miss magnitude, no invented denominator)", () => {
    const grown = [...base, { role: "user", content: "again" }];
    const warning = detectCacheBreak({
      prevSerialized: ser(base),
      currSerialized: serializePrompt({ systemPrompt: "sys CHANGED", tools, messages: grown }),
      currMessages: grown,
      missTokens: 12000,
      recentMisses: [500, 500],
    });
    expect(warning).toBe("⚠️ cache break at system/tools header (turn 1) — miss 12k");
  });

  it("② turn-5 shape: a header-region divergence with a TINY paid miss renders label AND cost — the contradiction is visible", () => {
    // The campaign's turn 5 (:488): label "system/tools header", both bracketing
    // usage rows paid 0.2k. A real early-header change re-misses ~the whole
    // prompt; label + cost together let the reader see that in ONE line.
    const grown = [...base, { role: "user", content: "again" }];
    const warning = detectCacheBreak({
      prevSerialized: ser(base),
      currSerialized: serializePrompt({ systemPrompt: "sys CHANGED", tools, messages: grown }),
      currMessages: grown,
      missTokens: 4200,
      promptTokens: 79400,
      recentMisses: [100, 100],
    });
    expect(warning).toContain("system/tools header");
    expect(warning).toContain("— miss 4.2k/79.4k (5.3%)");
  });
});

describe("ω99-28 T3 — one event per line; a turn-0 user break is a cold start, not an anomaly", () => {
  const tools = [{ name: "read_file", description: "d", parameters: { type: "object" as const, properties: {}, additionalProperties: false } }];
  const ser = (messages: readonly AgentMessage[]): string => serializePrompt({ systemPrompt: "sys", tools, messages });
  const base: AgentMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "A".repeat(200) },
  ];

  it("① a warning after a no-trailing-newline stream occupies its OWN line (the :222/:1933 sticky shape is impossible)", () => {
    const out: string[] = [];
    const write = (s: string): void => { out.push(s); };
    const guard = createBreakLineGuard(write);
    const delta = "五个侦察报告收口，三处主漂移确认："; // a streamed delta tail — NO newline
    write(delta); // the delta channel writes…
    guard.feed(delta); // …and the guard tracks the stream position
    guard.breakLine("⚠️ cache break at system/tools header (turn 16) — miss 4.2k/79.4k (5.3%)");
    const lines = out.join("").split("\n");
    expect(lines[0]).toBe(delta); // the text line survives intact
    expect(lines[1]).toBe("⚠️ cache break at system/tools header (turn 16) — miss 4.2k/79.4k (5.3%)"); // the warning owns a full line
    // and no spurious blank when the stream already ended at a line boundary
    out.length = 0;
    const ended = "already newline-terminated\n";
    write(ended);
    guard.feed(ended);
    guard.breakLine("ℹ️ expected: mission-bundle:mount demo (turn 4) — miss 18.9k/19.9k (95.0%)");
    expect(out.join("")).toBe("already newline-terminated\nℹ️ expected: mission-bundle:mount demo (turn 4) — miss 18.9k/19.9k (95.0%)\n");
  });

  it("② a turn-0 USER-message break renders as the cold-start info line (the campaign's five subagent firsts)", () => {
    // The shared-client child cold start: same system line, the child's tool
    // list is a prefix of the parent's, so the first divergent line maps onto
    // the child's OPENING user message (messageIndex 0, role user).
    const childFirst: AgentMessage[] = [{ role: "user", content: "survey README drift" }];
    const warning = detectCacheBreak({
      prevSerialized: ser(base),
      currSerialized: ser(childFirst),
      currMessages: childFirst,
      missTokens: 8000,
      promptTokens: 8100,
      recentMisses: [200, 200],
    });
    expect(warning).toBe("ℹ️ cold start — first call of a fresh session (tail-only cost) — miss 8k/8.1k (98.8%)");
  });

  it("③ non-turn-0 message breaks keep the ⚠️ shape (regression pin): a REWRITTEN opening user message in a LIVE session is NOT a cold start", () => {
    // The cold-start shape is exactly a fresh session's first call (ONE
    // opening user message). A MID-SESSION rewrite of the opening message
    // keeps the history — that is a real history change and keeps ⚠️.
    const rewritten: AgentMessage[] = [
      { role: "user", content: "go EDITED" },
      base[1]!,
      base[2]!,
    ];
    const warning = detectCacheBreak({
      prevSerialized: ser(base),
      currSerialized: ser(rewritten),
      currMessages: rewritten,
      missTokens: 9000,
      promptTokens: 9500,
      recentMisses: [200, 200],
    });
    expect(warning).toBe("⚠️ cache break at user message (turn 0) — miss 9k/9.5k (94.7%)");
  });

  it("③b a later user-message break (steering shape) keeps the ⚠️ wording unchanged", () => {
    const grown = [...base, { role: "user", content: "again" }];
    const edited = [...base, { role: "user", content: "again EDITED" }];
    const warning = detectCacheBreak({
      prevSerialized: ser(grown),
      currSerialized: ser(edited),
      currMessages: edited,
      missTokens: 7000,
      promptTokens: 7500,
      recentMisses: [100, 100],
    });
    expect(warning).toBe("⚠️ cache break at user message (turn 0) — miss 7k/7.5k (93.3%)");
  });

  it("③c a turn-0 TOOL-result break keeps the ⚠️ wording (cold-start is the USER shape only)", () => {
    const rewritten: AgentMessage[] = [
      base[0]!,
      base[1]!,
      { role: "tool", toolCallId: "c1", name: "edit", content: "EDIT STUB" },
    ];
    const warning = detectCacheBreak({
      prevSerialized: ser(base),
      currSerialized: ser(rewritten),
      currMessages: rewritten,
      missTokens: 6000,
      promptTokens: 6400,
      recentMisses: [100, 100],
    });
    expect(warning).toBe("⚠️ cache break at edit result (turn 0) — miss 6k/6.4k (93.8%)");
  });
});
