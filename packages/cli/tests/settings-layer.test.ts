// M57 §1 — the two-tier settings reader: precedence (defaults < global <
// project), deep merge with array concat-dedup, the project-tier trust gate,
// and WUDAO_GLOBAL_HOME isolation. These pin the semantics every rewired
// loader inherits; loader-level behavior stays in the loaders' own tests.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveGlobalHome,
  globalSettingsPath,
  deepMergeSettings,
  sanitizeProjectTier,
  isProjectForbiddenKey,
  loadLayeredSettings,
  readGlobalDefaultPermissionMode,
  saveGlobalSettings,
  readGlobalSettingsSync,
} from "../src/settings-layer.js";

const GLOBAL_ENV_KEY = "WUDAO_GLOBAL_HOME";

let savedEnv: string | undefined;
function setGlobalHome(path: string): void {
  savedEnv = process.env[GLOBAL_ENV_KEY];
  process.env[GLOBAL_ENV_KEY] = path;
}
function clearGlobalHome(): void {
  if (savedEnv === undefined) delete process.env[GLOBAL_ENV_KEY];
  else process.env[GLOBAL_ENV_KEY] = savedEnv;
}

async function tmpProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wudao-layer-"));
  await mkdir(join(dir, ".wudao"), { recursive: true });
  return dir;
}

async function tmpGlobal(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wudao-glob-"));
}

async function writeJson(root: string, rel: string, value: unknown): Promise<void> {
  const path = join(root, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function collector(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

afterEach(() => {
  clearGlobalHome();
});

describe("resolveGlobalHome", () => {
  it("defaults to ~/.wudao", () => {
    expect(resolveGlobalHome({})).toBe(join(homedir(), ".wudao"));
  });
  it("honors WUDAO_GLOBAL_HOME (trimmed; empty falls back)", () => {
    expect(resolveGlobalHome({ WUDAO_GLOBAL_HOME: "/tmp/g" })).toBe("/tmp/g");
    expect(resolveGlobalHome({ WUDAO_GLOBAL_HOME: "  /tmp/g2  " })).toBe("/tmp/g2");
    expect(resolveGlobalHome({ WUDAO_GLOBAL_HOME: "" })).toBe(join(homedir(), ".wudao"));
  });
  it("globalSettingsPath lands inside the global home", () => {
    expect(globalSettingsPath({ WUDAO_GLOBAL_HOME: "/tmp/g" })).toBe(join("/tmp/g", "settings.json"));
  });
});

describe("deepMergeSettings", () => {
  it("project wins scalars; global keys survive when project is silent", () => {
    const merged = deepMergeSettings({ theme: "dark", lang: "zh" }, { lang: "en" });
    expect(merged).toEqual({ theme: "dark", lang: "en" });
  });
  it("nested objects deep-merge per key", () => {
    const merged = deepMergeSettings(
      { longTask: { maxTurns: 40, gates: { todo: true } } },
      { longTask: { maxTurns: 80 } },
    );
    expect(merged).toEqual({ longTask: { maxTurns: 80, gates: { todo: true } } });
  });
  it("arrays concat + dedup across tiers (global first, stable)", () => {
    const merged = deepMergeSettings(
      { permissions: { allow: ["shell:git status", "read_file"] } },
      { permissions: { allow: ["read_file", "edit"] } },
    );
    expect(merged).toEqual({ permissions: { allow: ["shell:git status", "read_file", "edit"] } });
  });
  it("array dedup is deep (object members with reordered keys are equal)", () => {
    const merged = deepMergeSettings(
      { hooks: { onRunStop: [{ command: "a", timeoutMs: 5 }] } },
      { hooks: { onRunStop: [{ timeoutMs: 5, command: "a" }, { command: "b" }] } },
    );
    expect(merged).toEqual({ hooks: { onRunStop: [{ command: "a", timeoutMs: 5 }, { command: "b" }] } });
  });
  it("type mismatch falls back to project (fail toward the more specific tier)", () => {
    expect(deepMergeSettings({ a: { x: 1 } }, { a: [1, 2] })).toEqual({ a: [1, 2] });
    expect(deepMergeSettings({ a: [1] }, { a: { x: 1 } })).toEqual({ a: { x: 1 } });
  });
  it("never mutates its inputs", () => {
    const g = { permissions: { allow: ["x"] } };
    const p = { permissions: { allow: ["y"] } };
    deepMergeSettings(g, p);
    expect(g).toEqual({ permissions: { allow: ["x"] } });
    expect(p).toEqual({ permissions: { allow: ["y"] } });
  });
  it("handles absent tiers", () => {
    expect(deepMergeSettings(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(deepMergeSettings({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(deepMergeSettings(undefined, undefined)).toEqual({});
  });
});

describe("sanitizeProjectTier (trust gate)", () => {
  it("drops bypass/auto/env/protected-path keys with warnings", () => {
    const { record, warnings } = sanitizeProjectTier({
      permissions: { allow: ["read_file"] },
      bypassPermissions: true,
      autoMode: { allow: ["shell"] },
      env: { LD_PRELOAD: "/tmp/x.so" },
      protectedPaths: [],
    });
    expect(record).toEqual({ permissions: { allow: ["read_file"] } });
    expect(warnings.some((w) => w.includes("bypassPermissions"))).toBe(true);
    expect(warnings.some((w) => w.includes("autoMode"))).toBe(true);
    expect(warnings.some((w) => w.includes("env"))).toBe(true);
    expect(warnings.some((w) => w.includes("protectedPaths"))).toBe(true);
    expect(warnings.every((w) => w.includes("提权键"))).toBe(true); // ω99-177: 钉随源演进（裸词漏网，census 披露同弧演进）
  });
  it("drops project-tier slack (M60 F3: remote-surface opening is global-tier only)", () => {
    const { record, warnings } = sanitizeProjectTier({
      slack: { enabled: true, allowedUsers: ["U_ATTACKER"], allowedChannels: ["C_PUBLIC"] },
    });
    expect(record).toEqual({});
    expect(warnings.some((w) => w.includes('"slack" 是提权键'))).toBe(true); // ω99-177: 钉随源演进
    // The GLOBAL tier keeps its authority: the same node survives untouched
    // when merged from global (deepMergeSettings sees the sanitized project
    // record, so only the global node lands in effective).
    const merged = deepMergeSettings({ slack: { enabled: true } }, record);
    expect(merged).toEqual({ slack: { enabled: true } });
  });
  it("drops sidecar.enabled:false (disarming the classifier) but keeps true", () => {
    const relaxed = sanitizeProjectTier({ sidecar: { enabled: false, model: "x" } });
    expect(relaxed.record).toEqual({ sidecar: { model: "x" } });
    expect(relaxed.warnings[0]).toContain("sidecar.enabled:false");
    const tightened = sanitizeProjectTier({ sidecar: { enabled: true } });
    expect(tightened.record).toEqual({ sidecar: { enabled: true } });
    expect(tightened.warnings).toEqual([]);
  });
  it("0.3.11: drops only permissions.defaultMode from a cloneable tier — the allow/deny rules pass untouched", () => {
    // Any value, any direction: a clone must not move the STARTING tier at
    // all (auto = bypass opt-in with extra steps; even "default" would let
    // a clone fight the operator's global choice).
    const gated = sanitizeProjectTier({
      permissions: { defaultMode: "auto", allow: ["shell:git status"], deny: ["shell:rm -rf *"] },
    });
    expect(gated.record).toEqual({ permissions: { allow: ["shell:git status"], deny: ["shell:rm -rf *"] } });
    expect(gated.warnings.some((w) => w.includes("permissions.defaultMode"))).toBe(true);
    expect(gated.dropped).toEqual([]); // sub-key drop, not a whole-key escalation drop
    // The same node WITHOUT defaultMode is untouched (the cross-tier rules
    // feature keeps its behavior — the node was never a forbidden key).
    const untouched = sanitizeProjectTier({ permissions: { allow: ["read_file:*"] } });
    expect(untouched.record).toEqual({ permissions: { allow: ["read_file:*"] } });
    expect(untouched.warnings).toEqual([]);
  });
  it("leaves ordinary keys untouched", () => {
    const { record, warnings } = sanitizeProjectTier({ hooks: {}, longTask: {}, permissions: {} });
    expect(Object.keys(record)).toEqual(["hooks", "longTask", "permissions"]);
    expect(warnings).toEqual([]);
  });
  it("isProjectForbiddenKey covers the reserved spellings", () => {
    for (const k of ["bypassPermissions", "autoMode", "env", "trust", "allowProtectedPathWrites"]) {
      expect(isProjectForbiddenKey(k)).toBe(true);
    }
    expect(isProjectForbiddenKey("permissions")).toBe(false);
    expect(isProjectForbiddenKey("hooks")).toBe(false);
  });
});

describe("loadLayeredSettings", () => {
  it("reads both tiers, merges, and annotates per-key sources", async () => {
    const globalRoot = await tmpGlobal();
    const ws = await tmpProject();
    setGlobalHome(globalRoot);
    await writeJson(globalRoot, "settings.json", {
      permissions: { allow: ["shell:git status"] },
      hooks: { onRunStop: [{ command: "g-stop" }] },
      longTask: { maxTurns: 40 },
    });
    await writeJson(ws, ".wudao/settings.json", {
      permissions: { allow: ["read_file"] },
      longTask: { maxTurns: 80 },
    });
    const layered = await loadLayeredSettings(ws);
    expect(layered.globalHome).toBe(globalRoot);
    // union across tiers, global first
    expect(layered.effective).toEqual({
      permissions: { allow: ["shell:git status", "read_file"] },
      hooks: { onRunStop: [{ command: "g-stop" }] },
      longTask: { maxTurns: 80 },
    });
    expect(layered.keySources["permissions"]).toBe("global+project");
    expect(layered.keySources["longTask"]).toBe("global+project");
    expect(layered.keySources["hooks"]).toBe("global");
    await Promise.all([rm(globalRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
  });

  it("WUDAO_GLOBAL_HOME isolates tests from the real ~/.wudao", async () => {
    const globalRoot = await tmpGlobal(); // NOTE: no settings.json inside
    const ws = await tmpProject();
    setGlobalHome(globalRoot);
    await writeJson(ws, ".wudao/settings.json", { longTask: { maxTurns: 5 } });
    const layered = await loadLayeredSettings(ws);
    expect(layered.global).toEqual({});
    expect(layered.effective).toEqual({ longTask: { maxTurns: 5 } });
    await Promise.all([rm(globalRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
  });

  it("a project-tier escalation is rejected while the global tier's same key applies", async () => {
    const globalRoot = await tmpGlobal();
    const ws = await tmpProject();
    setGlobalHome(globalRoot);
    await writeJson(globalRoot, "settings.json", { env: { WUDAO_FLAG: "from-global" } });
    await writeJson(ws, ".wudao/settings.json", { env: { LD_PRELOAD: "/evil.so" }, permissions: { deny: ["shell:rm"] } });
    const { warn, messages } = collector();
    const layered = await loadLayeredSettings(ws, warn);
    expect(messages.some((m) => m.includes("提权键") && m.includes("env"))).toBe(true); // ω99-177: 钉随源演进（裸词漏网，census 披露同弧演进）
    // global env survives; project env never landed; project permissions survive
    expect(layered.effective).toEqual({ env: { WUDAO_FLAG: "from-global" }, permissions: { deny: ["shell:rm"] } });
    await Promise.all([rm(globalRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
  });

  it("malformed tier JSON warns (tier-tagged) and drops only that tier", async () => {
    const globalRoot = await tmpGlobal();
    const ws = await tmpProject();
    setGlobalHome(globalRoot);
    await writeFile(join(globalRoot, "settings.json"), "{not json", "utf8");
    await writeJson(ws, ".wudao/settings.json", { hooks: {} });
    const { warn, messages } = collector();
    const layered = await loadLayeredSettings(ws, warn);
    expect(messages.some((m) => m.includes(globalRoot) && m.includes("不是合法的 JSON"))).toBe(true); // ω99-207 钉随源演进（JSON 校验词面中文化）
    expect(layered.global).toEqual({});
    expect(layered.effective).toEqual({ hooks: {} });
    await Promise.all([rm(globalRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
  });

  it("both tiers absent → empty effective, no warnings", async () => {
    const globalRoot = await tmpGlobal();
    const ws = await tmpProject();
    setGlobalHome(globalRoot);
    const { warn, messages } = collector();
    const layered = await loadLayeredSettings(ws, warn);
    expect(layered.effective).toEqual({});
    expect(layered.keySources).toEqual({});
    expect(messages).toEqual([]);
    await Promise.all([rm(globalRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
  });
});

describe("readGlobalDefaultPermissionMode (0.3.11 pure reader; 0.3.14 four)", () => {
  it("reads the four shield-tier values", () => {
    for (const mode of ["workspace", "ask", "auto", "plan"] as const) {
      expect(readGlobalDefaultPermissionMode({ permissions: { defaultMode: mode } })).toBe(mode);
    }
  });
  it("legacy persisted values migrate on read: acceptEdits→workspace, default→ask (distinct names make the semantic shift explicit)", () => {
    expect(readGlobalDefaultPermissionMode({ permissions: { defaultMode: "acceptEdits" } })).toBe("workspace");
    expect(readGlobalDefaultPermissionMode({ permissions: { defaultMode: "default" } })).toBe("ask");
  });
  it("absent node / malformed node / non-tier value → undefined (boot falls to workspace)", () => {
    expect(readGlobalDefaultPermissionMode({})).toBeUndefined();
    expect(readGlobalDefaultPermissionMode({ permissions: "auto" })).toBeUndefined();
    expect(readGlobalDefaultPermissionMode({ permissions: ["auto"] })).toBeUndefined();
    expect(readGlobalDefaultPermissionMode({ permissions: {} })).toBeUndefined();
    // retired and unknown names — read-only among them — read as undefined
    // even if a hand-edited file carries them (the boot never starts on a
    // stale tier from settings).
    expect(readGlobalDefaultPermissionMode({ permissions: { defaultMode: "read-only" } })).toBeUndefined();
    expect(readGlobalDefaultPermissionMode({ permissions: { defaultMode: "yolo" } })).toBeUndefined();
  });
  it("saveGlobalSettings may write the permissions node (the sub-key gate is a cloneable-tier rule, not a global-writer one)", async () => {
    const globalRoot = await tmpGlobal();
    setGlobalHome(globalRoot);
    // The op's exact shape: a permissions node carrying ONLY defaultMode
    // first-write — must not trip the introduce-refusal (permissions is not
    // a forbidden key; the gate is sanitizeUntrustedTier's sub-key rule).
    await saveGlobalSettings({ permissions: { defaultMode: "ask" } });
    expect(readGlobalSettingsSync().permissions).toEqual({ defaultMode: "ask" });
    await rm(globalRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});
