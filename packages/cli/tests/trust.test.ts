// P1-5 (96 队列) — the workspace trust gate's decision store + status math.
// the upstream projecttrust-manager lineage: canonical path keys, nearest-ancestor decision
// lookup, trust-requiring project-resource detection (user global tiers NEVER
// count), fail-closed default (no decision = untrusted when resources exist).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeWorkspacePath,
  getTrustDecision,
  hasTrustRequiringProjectResources,
  detectTrustRequiringProjectResources,
  readTrustStore,
  setTrustDecision,
  trustGateStatus,
  trustStorePath,
  formatTrustGateNotice,
} from "../src/trust.js";

let home: string;
let ws: string;
const env = (): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home });

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wudao-trust-ws-"));
  await mkdir(join(dir, ".wudao"), { recursive: true });
  return dir;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wudao-trust-home-"));
  ws = canonicalizeWorkspacePath(await makeWorkspace());
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("decision store (~/.wudao/trust.json)", () => {
  it("reads {} when the store is absent (no decision — fail-closed)", () => {
    expect(readTrustStore(env())).toEqual({});
    expect(getTrustDecision(ws, env())).toBeNull();
  });

  it("write true / flip to false / delete on null round-trips", () => {
    setTrustDecision(ws, true, env());
    expect(readTrustStore(env())).toEqual({ [ws]: true });
    expect(getTrustDecision(ws, env())).toBe(true);
    setTrustDecision(ws, false, env());
    expect(getTrustDecision(ws, env())).toBe(false);
    setTrustDecision(ws, null, env());
    expect(readTrustStore(env())).toEqual({});
    expect(getTrustDecision(ws, env())).toBeNull();
  });

  it("a malformed store reads as {} (fail-closed) with a warning, never throws", async () => {
    const warns: string[] = [];
    await writeFile(trustStorePath(env()), "{not json", "utf8");
    const store = readTrustStore(env(), (m) => warns.push(m));
    expect(store).toEqual({});
    expect(getTrustDecision(ws, env())).toBeNull();
    expect(warningsMentionTrustStore(warns)).toBe(true);
  });

  it("keys are the CANONICAL path: accepting through a symlink records the real dir", async () => {
    const real = canonicalizeWorkspacePath(await makeWorkspace());
    const link = join(tmpdir(), `wudao-trust-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await symlink(real, link);
    try {
      expect(canonicalizeWorkspacePath(link)).toBe(real);
      setTrustDecision(link, true, env());
      // the store key is the realpath, and BOTH spellings resolve the decision
      expect(readTrustStore(env())).toEqual({ [real]: true });
      expect(getTrustDecision(link, env())).toBe(true);
      expect(getTrustDecision(join(real, "sub", "dir"), env())).toBe(true);
    } finally {
      await rm(link, { force: true });
      await rm(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("canonicalizeWorkspacePath falls back to resolve when realpath fails (phantom root)", () => {
    const phantom = join(ws, "does", "not", "exist");
    expect(canonicalizeWorkspacePath(phantom)).toBe(phantom);
  });
});

function warningsMentionTrustStore(warns: readonly string[]): boolean {
  return warns.some((w) => w.includes("trust.json"));
}

describe("nearest-ancestor decision lookup", () => {
  it("a subdirectory inherits the repo root's decision", async () => {
    setTrustDecision(ws, true, env());
    expect(getTrustDecision(join(ws, "a"), env())).toBe(true);
    expect(getTrustDecision(join(ws, "a", "b", "c"), env())).toBe(true);
  });

  it("the NEAREST ancestor wins when nested decisions exist", async () => {
    setTrustDecision(ws, false, env());
    setTrustDecision(join(ws, "trusted-sub"), true, env());
    expect(getTrustDecision(join(ws, "trusted-sub"), env())).toBe(true);
    expect(getTrustDecision(join(ws, "trusted-sub", "deep"), env())).toBe(true);
    expect(getTrustDecision(join(ws, "untrusted-sub", "deep"), env())).toBe(false);
  });

  it("a sibling workspace is NOT covered by another workspace's decision", async () => {
    setTrustDecision(ws, true, env());
    const other = await makeWorkspace();
    try {
      expect(getTrustDecision(other, env())).toBeNull();
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("trust-requiring project resources", () => {
  it("an empty workspace has none", () => {
    expect(hasTrustRequiringProjectResources(ws)).toBe(false);
    expect(detectTrustRequiringProjectResources(ws)).toEqual([]);
  });

  it.each([
    [".wudao/settings.json", "project settings (.wudao/settings.json)"],
    [".wudao/settings.local.json", "project settings (.wudao/settings.local.json)"],
    [".agents/skills", "project skills (.agents/skills)"],
    [".wudao/skills", "project skills (.wudao/skills)"],
    [".claude/skills", "project skills (.claude/skills)"],
    [".wudao/plugins", "project plugins (.wudao/plugins)"],
  ])("%s counts as trust-requiring", async (rel, label) => {
    await mkdir(join(ws, rel), { recursive: true });
    expect(hasTrustRequiringProjectResources(ws)).toBe(true);
    expect(detectTrustRequiringProjectResources(ws)).toContain(label);
  });

  it("the USER global tiers never count (a bare .wudao dir with no settings is clean)", () => {
    // .wudao exists (created in beforeEach) but holds no settings/skills/plugins
    expect(hasTrustRequiringProjectResources(ws)).toBe(false);
  });
});

describe("trustGateStatus", () => {
  it("no resources + no decision → not suppressed (gate inert)", () => {
    const s = trustGateStatus(ws, env());
    expect(s).toMatchObject({ decision: null, hasResources: false, effectiveSuppressed: false });
  });

  it("resources + no decision → suppressed (fail-closed)", async () => {
    await mkdir(join(ws, ".wudao", "skills"), { recursive: true });
    const s = trustGateStatus(ws, env());
    expect(s).toMatchObject({ decision: null, hasResources: true, effectiveSuppressed: true });
  });

  it("resources + decision false → suppressed; decision true → not suppressed", async () => {
    await mkdir(join(ws, ".wudao", "plugins"), { recursive: true });
    setTrustDecision(ws, false, env());
    expect(trustGateStatus(ws, env()).effectiveSuppressed).toBe(true);
    setTrustDecision(ws, true, env());
    expect(trustGateStatus(ws, env()).effectiveSuppressed).toBe(false);
  });

  it("the suppression notice names the surfaces and the review command", async () => {
    await mkdir(join(ws, ".wudao", "skills"), { recursive: true });
    const text = formatTrustGateNotice(trustGateStatus(ws, env()));
    expect(text).toContain("workspace not trusted");
    expect(text).toContain("skills");
    expect(text).toContain("plugins");
    expect(text).toContain("permission-allow");
    expect(text).toContain("hooks");
    expect(text).toContain("/trust");
  });
});
