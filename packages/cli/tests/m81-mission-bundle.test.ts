// ω99-18 — mission tool bundles (brief: 任务工具包挂载): campaign-scoped
// domain skill packs. A bundle = <ws>/.wudao/mission-bundles/<name>/skills/
// with one skill dir per SKILL.md; declare rides the SAME mission.json
// ledger (one recovery authority), discovery goes through loadSkills' new
// bundleRoots tier via the ONE assembly point (buildExtensionState), and the
// live refresh rides the EXISTING extension-swap seam (rescanExtensionsAt).
// Zero real shell, zero network; every fs touch lives under mkdtemp
// sandboxes (workspace + isolated WUDAO_GLOBAL_HOME).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, PermissionDecision } from "@wudao-org/core";
import {
  createMissionController,
  createMissionTools,
  MISSION_STORE_FILE,
  MISSION_BUNDLE_NAME_PATTERN,
  activeBundleSkillRoots,
  type MissionController,
  type MissionState,
  type MissionStoreHandle,
} from "../src/mission.js";
import { loadSkills } from "../src/skills.js";
import { buildExtensionState } from "../src/extension-state.js";
import { buildToolSet } from "../src/tools.js";

let ws: string;
let home: string; // isolated WUDAO_GLOBAL_HOME — the global tier never reaches the dev's real home
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "m81-bundle-"));
  home = await mkdtemp(join(tmpdir(), "m81-bundle-home-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const skillMd = (name: string, description = `${name} skill`): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} body.\n`;

/** Write a bundle under a workspace: one dir + SKILL.md per skill; an
 *  optional bundle.json lands at <bundle>/bundle.json. */
async function makeBundle(
  root: string,
  name: string,
  skills: readonly string[],
  extra: { readonly bundleJson?: string } = {},
): Promise<void> {
  for (const s of skills) {
    const dir = join(root, ".wudao", "mission-bundles", name, "skills", s);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skillMd(s), "utf8");
  }
  if (extra.bundleJson !== undefined) {
    await mkdir(join(root, ".wudao", "mission-bundles", name), { recursive: true });
    await writeFile(join(root, ".wudao", "mission-bundles", name, "bundle.json"), extra.bundleJson, "utf8");
  }
}

/** In-memory store fixture (m81-mission.test.ts's pattern) + optional
 *  bundles-changed spy. */
async function fixture(o: { readonly store?: MissionStoreHandle; readonly onBundlesChanged?: () => void | Promise<void> } = {}) {
  const notices: string[] = [];
  let persisted: MissionState | null = null;
  const store: MissionStoreHandle = o.store ?? {
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

/** A minimal ACTIVE mission ledger carrying bundles (B6's assembly input). */
const activeLedger = (bundles: readonly string[], status = "active"): string =>
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

describe("ω99-18 B1 — declare + idempotence", () => {
  it("bundle() mounts into the ledger and names the discovered skills; re-declare is a no-op", async () => {
    await makeBundle(ws, "demo", ["alpha", "beta"]);
    const fired: string[] = [];
    const notices: string[] = [];
    const controller = await createMissionController({
      workspaceRoot: ws, // real file ledger — the round-trip IS the assertion
      notify: (t) => notices.push(t),
      onBundlesChanged: () => {
        fired.push("fire");
      },
    });
    await controller.start("migration campaign");
    const r = await controller.bundle("demo");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("alpha");
    expect(r.text).toContain("beta");
    expect(fired.length).toBe(2); // start() + bundle() — the two lifecycle fires so far
    // the ledger carries the bundles (same mission.json, read back cold)
    const c2 = await createMissionController({ workspaceRoot: ws, notify: () => {} });
    expect(c2.snapshot()?.bundles).toEqual(["demo"]);
    // idempotent re-declare: ok, already mounted, nothing appended, no fire
    const again = await controller.bundle("demo");
    expect(again.ok).toBe(true);
    expect(again.text).toContain("已挂载");
    expect(controller.snapshot()?.bundles).toEqual(["demo"]);
    expect(fired.length).toBe(2);
  });
});

describe("ω99-18 B2 — name whitelist (path-safety red line)", () => {
  it("traversal/hidden/overlong/empty names all refuse with ZERO ledger writes and ZERO fires", async () => {
    expect(MISSION_BUNDLE_NAME_PATTERN.test("../evil")).toBe(false);
    expect(MISSION_BUNDLE_NAME_PATTERN.test("a/b")).toBe(false);
    expect(MISSION_BUNDLE_NAME_PATTERN.test("a\\b")).toBe(false);
    expect(MISSION_BUNDLE_NAME_PATTERN.test(".hidden")).toBe(false);
    expect(MISSION_BUNDLE_NAME_PATTERN.test("")).toBe(false);
    expect(MISSION_BUNDLE_NAME_PATTERN.test("..")).toBe(false);
    expect(MISSION_BUNDLE_NAME_PATTERN.test("x".repeat(121))).toBe(false);
    expect(MISSION_BUNDLE_NAME_PATTERN.test("demo")).toBe(true);
    expect(MISSION_BUNDLE_NAME_PATTERN.test("refactor-kit")).toBe(true);
    expect(MISSION_BUNDLE_NAME_PATTERN.test("x".repeat(120))).toBe(true);
    await makeBundle(ws, "demo", ["alpha"]);
    const fired: string[] = [];
    const f = await fixture({ onBundlesChanged: () => { fired.push("fire"); } });
    await f.controller.start("campaign");
    expect(fired.length).toBe(1); // start()'s own fire
    const ledgerAfterStart = JSON.stringify(f.controller.snapshot());
    for (const bad of ["../evil", "a/b", "a\\b", "", ".hidden", "x".repeat(121)]) {
      const r = await f.controller.bundle(bad);
      expect(r.ok).toBe(false);
      expect(r.text.startsWith("⚠️")).toBe(true);
    }
    expect(JSON.stringify(f.controller.snapshot())).toBe(ledgerAfterStart); // nothing moved
    expect(fired.length).toBe(1); // zero fires from the rejects
  });
});

describe("ω99-18 B3 — existence gate names the expected path", () => {
  it("a missing skills root and a skill-less root both refuse naming <…>/skills; zero side effects", async () => {
    const f = await fixture();
    await f.controller.start("campaign");
    const absent = await f.controller.bundle("ghost");
    expect(absent.ok).toBe(false);
    expect(absent.text).toContain(join(ws, ".wudao", "mission-bundles", "ghost", "skills"));
    // the dir exists but carries no */SKILL.md
    await mkdir(join(ws, ".wudao", "mission-bundles", "empty", "skills", "not-a-skill"), { recursive: true });
    const skillless = await f.controller.bundle("empty");
    expect(skillless.ok).toBe(false);
    expect(skillless.text).toContain(join(ws, ".wudao", "mission-bundles", "empty", "skills"));
    expect(f.controller.snapshot()?.bundles ?? []).toEqual([]);
  });
});

describe("ω99-18 B4 — bundle.json mcp declaration refuses honestly", () => {
  it('a bundle.json with an "mcp" key refuses; other bundle.json content mounts fine', async () => {
    await makeBundle(ws, "withmcp", ["alpha"], { bundleJson: JSON.stringify({ mcp: { servers: { x: {} } } }) });
    await makeBundle(ws, "plain", ["beta"], { bundleJson: JSON.stringify({ version: 1, note: "fine" }) });
    const f = await fixture();
    await f.controller.start("campaign");
    const mcp = await f.controller.bundle("withmcp");
    expect(mcp.ok).toBe(false);
    expect(mcp.text).toContain("MCP");
    expect(mcp.text).toContain("session-static");
    expect(f.controller.snapshot()?.bundles ?? []).toEqual([]); // refused BEFORE the ledger write
    const plain = await f.controller.bundle("plain");
    expect(plain.ok).toBe(true);
    expect(f.controller.snapshot()?.bundles).toEqual(["plain"]);
  });
});

describe("ω99-18 B5 — loadSkills tier semantics (project > bundle > global)", () => {
  it("same-name precedence, bundle-only loading, and the trustSuppressed skip with a named warn", async () => {
    // project tier (.wudao/skills) wins over everything
    await mkdir(join(ws, ".wudao", "skills", "shared"), { recursive: true });
    await writeFile(join(ws, ".wudao", "skills", "shared", "SKILL.md"), skillMd("shared", "from project"), "utf8");
    // bundle tier beats global, loses to project
    await makeBundle(ws, "demo", ["shared", "bg", "bonly"]);
    // global tier fills gaps
    for (const [n, d] of [["bg", "from global"], ["gonly", "from global"]] as const) {
      await mkdir(join(home, "skills", n), { recursive: true });
      await writeFile(join(home, "skills", n, "SKILL.md"), skillMd(n, d), "utf8");
    }
    const env = { ...process.env, WUDAO_GLOBAL_HOME: home };
    const warn: string[] = [];
    const bundleRoot = join(ws, ".wudao", "mission-bundles", "demo", "skills");
    const byName = new Map(loadSkills(ws, (m) => warn.push(m), env, { bundleRoots: [bundleRoot] }).map((s) => [s.name, s]));
    expect(byName.get("shared")?.description).toBe("from project"); // project wins
    expect(byName.get("bg")?.description).toBe("bg skill"); // bundle beats global
    expect(byName.get("bonly")?.description).toBe("bonly skill"); // bundle-only loads
    expect(byName.get("gonly")?.description).toBe("from global"); // global still fills gaps
    // first-wins diagnostics carry over (the global-tier dup warn names the
    // winner — the bundle copy kept the name, the global one "shadows"-loses)
    expect(warn.some((m) => m.includes('"bg"') && m.includes("shadows"))).toBe(true);
    // trustSuppressed: bundle roots are workspace content — skipped, one named warn
    warn.length = 0;
    const suppressed = new Map(
      loadSkills(ws, (m) => warn.push(m), env, { bundleRoots: [bundleRoot], trustSuppressed: true }).map((s) => [s.name, s]),
    );
    expect(suppressed.has("bonly")).toBe(false);
    expect(suppressed.get("bg")?.description).toBe("from global"); // bundle gone → global fills
    expect(suppressed.has("shared")).toBe(false); // project root suppressed too
    expect(warn.some((m) => m.includes("mission-bundle"))).toBe(true); // the skip is named
  });
});

describe("ω99-18 B6 — the ONE assembly point (buildExtensionState)", () => {
  it("an active ledger's bundles mount; absent/corrupt/abandoned ledgers mount nothing and never throw", async () => {
    await makeBundle(ws, "demo", ["alpha"]);
    await mkdir(join(ws, ".wudao"), { recursive: true });
    const ledgerPath = join(ws, ".wudao", MISSION_STORE_FILE);
    const env = { ...process.env, WUDAO_GLOBAL_HOME: home };
    await writeFile(ledgerPath, activeLedger(["demo"]), "utf8");
    expect(activeBundleSkillRoots(ws)).toEqual([join(ws, ".wudao", "mission-bundles", "demo", "skills")]);
    let state = await buildExtensionState(ws, [], { env });
    expect(state.skills.map((s) => s.name)).toContain("alpha");
    // abandoned → not mounted
    await writeFile(ledgerPath, activeLedger(["demo"], "abandoned"), "utf8");
    expect(activeBundleSkillRoots(ws)).toEqual([]);
    state = await buildExtensionState(ws, [], { env });
    expect(state.skills.map((s) => s.name)).not.toContain("alpha");
    // corrupt → fail-closed silent (boot must never die on a broken ledger)
    await writeFile(ledgerPath, "{ not json", "utf8");
    expect(activeBundleSkillRoots(ws)).toEqual([]);
    state = await buildExtensionState(ws, [], { env });
    expect(state.skills.map((s) => s.name)).not.toContain("alpha");
    // no ledger at all → clean
    await rm(ledgerPath, { force: true });
    expect(activeBundleSkillRoots(ws)).toEqual([]);
    state = await buildExtensionState(ws, [], { env });
    expect(state.skills.map((s) => s.name)).not.toContain("alpha");
  });
});

describe("ω99-18 B7 — persistence (same mission.json, same recovery authority)", () => {
  it("a fresh controller reloads the declared bundles; pre-ω99-18 ledgers load clean; snapshot deep-copies", async () => {
    await makeBundle(ws, "demo", ["alpha"]);
    const c1 = await createMissionController({ workspaceRoot: ws, notify: () => {} });
    await c1.start("campaign");
    await c1.bundle("demo");
    const c2 = await createMissionController({ workspaceRoot: ws, notify: () => {} });
    expect(c2.snapshot()?.bundles).toEqual(["demo"]); // resume auto-remounts via B6's assembly
    // an old-format ledger (no bundles key) loads without error
    await writeFile(
      join(ws, ".wudao", MISSION_STORE_FILE),
      JSON.stringify({
        version: 1,
        mission: { id: "mlegacy", objective: "old", createdAt: "2026-01-01T00:00:00.000Z", status: "active", tasks: [] },
      }),
      "utf8",
    );
    const c3 = await createMissionController({ workspaceRoot: ws, notify: () => {} });
    expect(c3.snapshot()?.bundles ?? []).toEqual([]);
    // snapshot deep-copies: mutating the returned array never reaches state
    const snap = c2.snapshot();
    expect(snap?.bundles).toEqual(["demo"]);
    (snap!.bundles as string[]).push("evil");
    expect(c2.snapshot()?.bundles).toEqual(["demo"]);
  });
});

describe("ω99-18 B8 — the callback fires at the mid-run lifecycle points", () => {
  it("start/bundle each fire once; the terminal complete/abandon unmounts DEFER to the session boundary (ω99-24 A, zero fires); plan/next/claim/fail/knowAdd fire zero; a throwing callback never fails the op", async () => {
    await makeBundle(ws, "demo", ["alpha"]);
    const fired: string[] = [];
    const f = await fixture({ onBundlesChanged: () => { fired.push("fire"); } });
    await f.controller.start("campaign");
    expect(fired.length).toBe(1); // start: the old bundles died with the old ledger
    await f.controller.plan([{ title: "a" }, { title: "b" }]);
    await f.controller.nextReady(); // t1 doing
    await f.controller.knowAdd({ kind: "decision", title: "t", content: "c" });
    await f.controller.fail("t1", "not ready"); // back to todo
    expect(fired.length).toBe(1);
    await f.controller.nextReady(); // t1 again
    await f.controller.complete("t1", "done"); // NOT final — t2 remains
    expect(fired.length).toBe(1);
    await f.controller.claim("t2");
    await f.controller.complete("t2", "done"); // the terminal flip — ω99-24 A: NO fire (the unmount defers to the session boundary)
    expect(fired.length).toBe(1);
    await f.controller.start("second"); // a new mission drops the old bundles (mid-run, still fires)
    expect(fired.length).toBe(2);
    await f.controller.bundle("demo");
    expect(fired.length).toBe(3);
    await f.controller.abandon(); // terminal — ω99-24 A: NO fire
    expect(fired.length).toBe(3);
    // observer isolation: a throwing callback costs one notice line, never the op
    const f2 = await fixture({ onBundlesChanged: () => { throw new Error("boom"); } });
    const started = await f2.controller.start("campaign");
    expect(started).toContain("🚩");
    expect(f2.controller.snapshot()?.status).toBe("active");
    expect(f2.notices.some((n) => n.includes("工具包面刷新失败"))).toBe(true);
    const mounted = await f2.controller.bundle("demo");
    expect(mounted.ok).toBe(true);
    expect(f2.controller.snapshot()?.bundles).toEqual(["demo"]);
  });
});

describe("ω99-18 B9 — the tool face (eighth tool, fail-closed)", () => {
  const stubModel: ModelClient = {
    async generate() {
      return { role: "assistant", content: "" };
    },
  } as unknown as ModelClient;
  const allowAll = async (): Promise<PermissionDecision> => "allow";

  function stubController(log: string[]): MissionController {
    return {
      bundle: async (name) => {
        log.push(`bundle:${name}`);
        return { ok: true, text: `已挂载工具包 ${name}` };
      },
      start: async (o) => `started ${o}`,
      plan: async () => ({ ok: true, text: "planned" }),
      nextReady: async () => ({ text: "no" }),
      claim: async () => ({ text: "no" }),
      complete: async () => ({ ok: true, text: "done" }),
      fail: async () => ({ ok: true, text: "failed" }),
      ratchetCheck: async () => ({ ok: true, text: "ok" }),
      knowAdd: async () => ({ ok: true, text: "ok" }),
      know: async () => ({ ok: true, text: "ok" }),
      abandon: async () => "abandoned",
      status: () => "status",
      snapshot: () => undefined,
    } as unknown as MissionController;
  }

  it("mission_bundle rides the REAL buildToolSet; an illegal name never reaches the controller; the 8-tool order is pinned", async () => {
    const log: string[] = [];
    const box: { current?: MissionController } = { current: stubController(log) };
    const set = buildToolSet({
      workspaceRoot: "/tmp/m81-bundle-ws",
      model: stubModel,
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
      mission: { getController: () => box.current },
    });
    const bundleTool = set.find((t) => t.name === "mission_bundle")!;
    expect(bundleTool).toBeDefined();
    // fail-closed risk annotations (a state writer, like the other seven)
    expect(bundleTool.isReadOnly?.({})).toBe(false);
    expect(bundleTool.isDestructive?.({})).toBe(false);
    expect(bundleTool.isOpenWorld?.({})).toBe(false);
    expect(bundleTool.isConcurrencySafe?.({})).toBe(false);
    // the name whitelist fires BEFORE the controller (zero side effects, zero rescan)
    const before = log.length;
    for (const bad of ["../evil", "a/b", "", ".hidden", "x".repeat(121)]) {
      const r = await bundleTool.execute({ name: bad });
      expect(r.isError).toBe(true);
    }
    expect(log.length).toBe(before);
    const good = await bundleTool.execute({ name: "demo" });
    expect(good.isError).toBeUndefined();
    expect(good.content).toContain("已挂载工具包 demo");
    expect(log).toContain("bundle:demo");
    // an empty box (controller not yet created / absent) is a loud refusal
    box.current = undefined;
    const none = await bundleTool.execute({ name: "demo" });
    expect(none.isError).toBe(true);
    // the fixed 8-tool registration (a tail append — the prefix bytes stay stable)
    const tools = createMissionTools(() => undefined);
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
});

describe("ω99-18 B10 — status carries the bundle line (names only, no fs probing)", () => {
  it("with bundles: the names right after the knowledge line; without: （无）", async () => {
    const f = await fixture();
    await f.controller.start("campaign");
    expect(f.controller.status()).toContain("工具包：（无）");
    await makeBundle(ws, "demo", ["alpha"]);
    await makeBundle(ws, "refactor-kit", ["beta"]);
    await f.controller.bundle("demo");
    await f.controller.bundle("refactor-kit");
    const s = f.controller.status();
    expect(s).toContain("工具包：demo、refactor-kit");
    expect(s).not.toContain("工具包：（无）");
    const lines = s.split("\n");
    expect(lines.findIndex((l) => l.startsWith("  知识："))).toBeLessThan(lines.findIndex((l) => l.startsWith("  工具包：")));
  });
});
