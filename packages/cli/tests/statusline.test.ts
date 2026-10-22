// M53 §3/§4 — the statusline JSON contract + the /commands metadata matrix.
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, utimes, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, createJsonlSessionStore } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { DriverStatus } from "../src/driver/agent-driver.js";
import { buildStatuslineSnapshot, formatStatuslineLine, statuslineFromWorkspace } from "../src/statusline.js";
import { listSlashCommands, slashDisplay, formatSlashHelp, filterSlashCommands } from "../src/slash-commands.js";
import { parseSkillFrontmatter } from "../src/skills.js";

const baseStatus = (over: Partial<DriverStatus> = {}): DriverStatus => ({
  live: { reasoning: "th", answer: "an answer text", busyTools: [{ name: "read_file", summary: "a" }] },
  busy: true,
  queued: ["next"],
  boardProgress: { done: 1, total: 4 },
  ctxTokens: { used: 12_000, window: 64_000, nearLimit: false },
  mode: "workspace",
  cachePercent: 87.4,
  bg: { active: 1, spawned: 2 },
  pendingPermission: null,
  planBoard: null,
  sessionId: "wudao-abcdefgh",
  sidecar: { checks: 3, breakerOpen: false },
  ...over,
});

describe("statusline snapshot (M53 §3)", () => {
  it("folds a driver status into the contract shape", () => {
    const snap = buildStatuslineSnapshot(baseStatus(), { version: "9.9.9", model: "deepseek-chat", provider: "deepseek", sessionName: "fix-parser" });
    expect(snap).toEqual({
      version: "9.9.9",
      model: "deepseek-chat",
      provider: "deepseek",
      mode: "workspace",
      session: { id: "wudao-abcdefgh", id8: "wudao-ab", name: "fix-parser" },
      busy: true,
      queued: 1,
      ctx: { used: 12_000, window: 64_000, nearLimit: false },
      cache: { percent: 87 },
      board: { done: 1, total: 4 },
      sidecar: { checks: 3, breakerOpen: false },
      bg: { active: 1, spawned: 2 },
      live: { answerChars: 14, reasoningChars: 2, busyTools: 1 },
    });
  });

  it("null optionals stay null and absent meta stays absent (JSON-stable)", () => {
    const snap = buildStatuslineSnapshot(baseStatus({
      boardProgress: null,
      ctxTokens: null,
      cachePercent: null,
      sidecar: null,
      live: { reasoning: "", answer: "", busyTools: [] },
      busy: false,
      queued: [],
    }), { version: "1", model: "m" });
    expect(snap.board).toBeNull();
    expect(snap.ctx).toBeNull();
    expect(snap.cache).toBeNull();
    expect(snap.sidecar).toBeNull();
    expect(snap.provider).toBeUndefined();
    expect(snap.session.name).toBeUndefined();
    expect(() => JSON.stringify(snap)).not.toThrow();
  });

  it("the one-line form composes the present segments", () => {
    const line = formatStatuslineLine(buildStatuslineSnapshot(baseStatus(), { version: "1", model: "deepseek-chat" }));
    expect(line).toBe("wudao · deepseek-chat · wudao-ab │ 模式 accept │ ctx 12k/64k │ cache 87% │ ▣ 1/4 │ bg 1/2 │ sidecar 3 │ busy │ queued 1"); // ω99-190: 钉随源演进
    const empty = formatStatuslineLine(buildStatuslineSnapshot(baseStatus({
      boardProgress: null, ctxTokens: null, cachePercent: null, sidecar: null, busy: false, queued: [],
      bg: { active: 0, spawned: 0 },
      live: { reasoning: "", answer: "", busyTools: [] },
    }), { version: "1", model: "m" }));
    expect(empty).toBe("wudao · m · wudao-ab │ 模式 accept"); // ω99-190: 钉随源演进
  });

  // M56 §1: the key pool surfaces as `keys n/m` (available/total), computed
  // from the meta's live snapshot (cooldowns move it).
  it("keys n/m rides the snapshot + the one-line form when a pool is supplied", () => {
    let snap = { total: 3, available: 3, cooling: 0 };
    const meta = { version: "1", model: "m", keys: { snapshot: () => snap } };
    const withKeys = buildStatuslineSnapshot(baseStatus(), meta);
    expect(withKeys.keys).toEqual({ available: 3, total: 3 });
    expect(formatStatuslineLine(withKeys)).toContain("keys 3/3");
    snap = { total: 3, available: 2, cooling: 1 };
    const cooled = buildStatuslineSnapshot(baseStatus(), meta);
    expect(cooled.keys).toEqual({ available: 2, total: 3 });
    expect(formatStatuslineLine(cooled)).toContain("keys 2/3");
    // No pool meta → no keys segment (single-key historical view).
    expect(buildStatuslineSnapshot(baseStatus(), { version: "1", model: "m" }).keys).toBeUndefined();
  });
});

describe("statusline --json workspace form (M53 §3)", () => {
  it("rebuilds the snapshot from the newest session file + env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-sl-"));
    await mkdir(join(dir, ".wudao", "sessions"), { recursive: true });
    const store = createJsonlSessionStore(join(dir, ".wudao", "sessions"));
    await store.appendEntry("sess-old", { type: "model_change", model: "old-model", at: "2026-01-01T00:00:00Z" });
    await store.appendEntry("sess-new", { type: "model_change", model: "glm-5", provider: "glm", at: "2026-01-02T00:00:00Z" });
    await store.appendEntry("sess-new", { type: "session_name", name: "fix-the-parser" });
    await store.append("sess-new", { role: "user", content: "hi" });
    await store.append("sess-new", { role: "assistant", content: "yo" });
    // pin the old session's mtime in the past so "newest" is deterministic
    const past = new Date(Date.now() - 60_000);
    await utimes(join(dir, ".wudao", "sessions", "sess-old.jsonl"), past, past);
    const snap = await statuslineFromWorkspace(dir, { WUDAO_MODEL: "env-model" }, "0.2.0");
    expect(snap.model).toBe("glm-5");
    expect(snap.provider).toBe("glm");
    expect(snap.session).toEqual({ id: "sess-new", id8: "sess-new", name: "fix-the-parser" });
    expect(snap.busy).toBe(false);
    expect(snap.mode).toBe("workspace");
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("an empty workspace degrades to env + placeholder id (never throws)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-sl2-"));
    const snap = await statuslineFromWorkspace(dir, { WUDAO_MODEL: "env-model" }, "0.2.0");
    expect(snap.model).toBe("env-model");
    expect(snap.session.id).toBe("—");
    expect(snap.ctx).toBeNull();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe("driver snapshotForStatusline (M53 §3)", () => {
  it("exposes the same contract shape from the live driver", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const driver = createAgentDriver({
      model,
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      sessionId: "wudao-statusl",
      statusline: { model: "deepseek-chat", version: "9.9.9" },
    });
    const snap = driver.snapshotForStatusline();
    expect(snap.model).toBe("deepseek-chat");
    expect(snap.version).toBe("9.9.9");
    expect(snap.session.id8).toBe("wudao-st");
    expect(snap.busy).toBe(false);
    expect(snap.live).toEqual({ answerChars: 0, reasoningChars: 0, busyTools: 0 });
    driver.dispose();
  });
});

// ---------------------------------------------------------------------------
// M53 §4 — the /commands contract: unified metadata across sources.
// ---------------------------------------------------------------------------
describe("slash command metadata (M53 §4)", () => {
  it("every entry carries name/description/sources; memory is sensitive; context+tree are immediate", () => {
    const cmds = listSlashCommands({});
    for (const c of cmds) {
      expect(c.name).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(c.sources.length).toBeGreaterThanOrEqual(1);
      expect(c.sources).toContain(c.source);
    }
    const memory = cmds.find((c) => c.name === "memory");
    expect(memory?.isSensitive).toBe(true);
    for (const name of ["context", "tree"]) {
      expect(cmds.find((c) => c.name === name)?.immediate).toBe(true);
    }
  });

  it("a sensitive command's display/preview form is <redacted>", () => {
    const memory = listSlashCommands({}).find((c) => c.name === "memory");
    expect(memory && slashDisplay(memory)).toBe("/memory <redacted>");
    const plan = listSlashCommands({}).find((c) => c.name === "plan");
    expect(plan && slashDisplay(plan)).toBe("/plan <goal>");
    const help = formatSlashHelp(listSlashCommands({}));
    expect(help).toContain("/memory <redacted>");
    expect(help).toContain("[敏感]"); // ω99-162: 旗标钉随源演进。
    expect(help).toContain("[即时]"); // ω99-162: 旗标钉随源演进。
  });

  it("sources aggregate collisions across loader kinds (parse priority keeps the first)", () => {
    const cmds = listSlashCommands({
      pluginCommands: [{ name: "deploy", description: "plugin desc", template: "run deploy" } as never],
      extensionCommands: [{ name: "deploy", extension: "ext" }],
    });
    const deploy = cmds.find((c) => c.name === "deploy");
    expect(deploy?.source).toBe("plugin");
    expect(deploy?.sources).toEqual(["plugin", "extension"]);
    expect(deploy?.description).toBe("plugin desc");
    // cc-plugins D3: workspace skills render under their raw name (no
    // `skill:` namespace); the collision test becomes "the skill still wins
    // over same-name plugin/extension" via the parse-priority sources tag.
    const skillCmds = listSlashCommands({
      skills: [{ name: "deploy", description: "skill desc", filePath: "/x", relPath: "x", content: "---\nname: deploy\n---\nbody" }],
    });
    expect(skillCmds.find((c) => c.name === "deploy")?.source).toBe("skill");
  });

  it("the prefix filter still narrows the menu", () => {
    const cmds = listSlashCommands({});
    expect(filterSlashCommands(cmds, "sw").map((c) => c.name)).toEqual(["switch"]);
  });
});

describe("skill context: fork (M53 §4)", () => {
  it("parseSkillFrontmatter reads context: fork (unknown values ignored)", () => {
    const fm = parseSkillFrontmatter("---\nname: deploy\ndescription: d\ncontext: fork\n---\nbody");
    expect(fm.name).toBe("deploy");
    expect(fm.context).toBe("fork");
    const inline = parseSkillFrontmatter("---\nname: other\ndescription: d\ncontext: inline\n---\nbody");
    expect(inline.context).toBeUndefined();
    const absent = parseSkillFrontmatter("---\nname: third\ndescription: d\n---\nbody");
    expect(absent.context).toBeUndefined();
  });
});
