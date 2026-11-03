// M63 §B — the credentials file: 0600 enforcement on every write, env-wins
// resolution precedence, count-only status surfaces (values never echoed),
// the YAML-lite parser's edge cases, and the buildRunPlan fallback.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProviderConfigResult } from "@wudao-org/providers";
import {
  credentialsFileStatus,
  credentialsFileStatusSync,
  credentialsFilePath,
  formatCredentialsYaml,
  parseCredentialsYaml,
  readCredentialsFile,
  saveProviderKey,
  writeCredentialsFile,
  writeCredentialsFileSync,
} from "../src/credentials.js";
import { buildRunPlan } from "../src/run.js";
import { checkCredentialsFile } from "../src/commands/doctor.js";
import { formatStatuslineLine, statuslineFromWorkspace } from "../src/statusline.js";

const SECRET = "sk-test-never-echo-me";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wudao-cred-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home, ...extra });

describe("credentials file write path (M63 §B)", () => {
  it("resides under WUDAO_GLOBAL_HOME (default ~/.wudao/.credentials.yaml shape)", () => {
    expect(credentialsFilePath(env())).toBe(join(home, ".credentials.yaml"));
  });

  // 0600 is a POSIX observability contract (win32 reports no enforced mode
  // bits — 0666 regardless); the write/rename/repair CODE PATHS run on every
  // platform, the octal assertions only where they are observable.
  const modeLeg = process.platform !== "win32";

  it("every write lands mode 0600", async () => {
    await writeCredentialsFile({ deepseek: SECRET }, env());
    if (modeLeg) expect((statSync(credentialsFilePath(env())).mode & 0o777).toString(8)).toBe("600");
  });

  it("a pre-loosened file is REPARED to 0600 by the next save (chmod after write)", async () => {
    await writeCredentialsFile({ deepseek: SECRET }, env());
    const path = credentialsFilePath(env());
    await saveProviderKey("glm", "glm-key", env());
    if (modeLeg) {
      chmodSync(path, 0o644);
      expect((statSync(path).mode & 0o777).toString(8)).toBe("644");
      await saveProviderKey("qwen", "qwen-key", env());
      expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    }
  });

  it("saveProviderKey is read-modify-write — other keys survive", async () => {
    await writeCredentialsFile({ deepseek: "ds-key", qwen: "qw-key" }, env());
    const r = await saveProviderKey("glm", "glm-key", env());
    expect(r.keyCount).toBe(3);
    const parsed = parseCredentialsYaml(readFileSync(credentialsFilePath(env()), "utf8"));
    expect(parsed).toEqual({ deepseek: "ds-key", qwen: "qw-key", glm: "glm-key" });
  });

  it("rejects invalid ids and empty keys (error names the id, never a value)", async () => {
    await expect(saveProviderKey("bad id!", "k", env())).rejects.toThrow(/invalid credentials id/);
    await expect(saveProviderKey("deepseek", "   ", env())).rejects.toThrow(/empty key/);
  });

  it("absent file reads as {} (the fallback never hard-fails a startup)", async () => {
    expect(await readCredentialsFile(env())).toEqual({});
  });
});

describe("YAML-lite parser", () => {
  it("parses flat id: key lines, comments, and quoted values", () => {
    expect(parseCredentialsYaml([
      "# header comment",
      "",
      "deepseek: sk-a",
      'glm: "sk-b"',
      "qwen: 'sk-c'",
      "wudao-api_2: sk-d",
      "# trailing comment",
    ].join("\n"))).toEqual({ deepseek: "sk-a", glm: "sk-b", qwen: "sk-c", "wudao-api_2": "sk-d" });
  });

  it("skips malformed lines, nested blocks, and empty values (never throws)", () => {
    const parsed = parseCredentialsYaml([
      "this is not yaml",
      "- list: entry",
      "deepseek:", // nested block head → no scalar
      "  inner: sk-leak", // indented child → skipped, NOT a credential
      "glm: \"\"", // quotes around nothing → no key
      "qwen: sk-c",
      "9bad: x", // must start with a letter
    ].join("\n"));
    expect(parsed).toEqual({ qwen: "sk-c" });
  });

  it("format → parse round-trips (sorted, byte-stable header)", () => {
    const text = formatCredentialsYaml({ glm: "g", deepseek: "d" });
    expect(text).toBe(formatCredentialsYaml({ deepseek: "d", glm: "g" })); // deterministic
    expect(parseCredentialsYaml(text)).toEqual({ deepseek: "d", glm: "g" });
  });
});

describe("env-wins precedence (M63 §B)", () => {
  it("an env key beats the credentials file", async () => {
    await writeCredentialsFile({ deepseek: "file-key" }, env());
    const r = resolveProviderConfigResult(env({ WUDAO_API_KEY: "env-key" }), {}, await readCredentialsFile(env()));
    expect(r.ok && r.config.apiKey).toBe("env-key");
  });

  it("no env key → the SELECTED provider's file key fills in", async () => {
    await writeCredentialsFile({ deepseek: "ds-file", glm: "glm-file" }, env());
    const creds = await readCredentialsFile(env());
    const r = resolveProviderConfigResult(env(), { provider: "glm" }, creds);
    expect(r.ok && r.config.apiKey).toBe("glm-file");
  });

  it("buildRunPlan: the file rescues a no-env-key startup (home via process env)", async () => {
    const saved = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    try {
      await writeCredentialsFile({ deepseek: "file-key" }, env());
      const plan = buildRunPlan({ prompt: "hi", env: {} });
      expect(plan.kind).toBe("real");
      if (plan.kind === "real") {
        expect(plan.config.apiKey).toBe("file-key");
        expect(plan.config.provider).toBe("deepseek");
      }
      // ...and env still wins over the file.
      const envPlan = buildRunPlan({ prompt: "hi", env: { WUDAO_API_KEY: "env-key" } });
      expect(envPlan.kind === "real" && envPlan.config.apiKey).toBe("env-key");
    } finally {
      if (saved === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = saved;
    }
  });

  it("buildRunPlan: no file + no env stays no-key", () => {
    expect(buildRunPlan({ prompt: "hi", env: {}, credentials: {} }).kind).toBe("no-key");
  });
});

describe("count-only status surfaces (values never echoed)", () => {
  it("credentialsFileStatus carries counts/mode — no key material", async () => {
    const GLM_KEY = "sk-glm-never-echo-either";
    await writeCredentialsFile({ deepseek: SECRET, glm: GLM_KEY }, env());
    const s = await credentialsFileStatus(env());
    expect(s.keyCount).toBe(2);
    // win32: no enforced mode bits — mode reads "666" and modeOk is judged
    // platform-aware (see modeOkOnThisPlatform).
    if (process.platform !== "win32") expect(s.mode).toBe("600");
    expect(s.modeOk).toBe(true);
    // Long distinctive secrets — a short marker could collide with the random
    // tmpdir suffix inside `path`, so assert on the real key material only.
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(JSON.stringify(s)).not.toContain(GLM_KEY);
  });

  // The loose-mode warn lane is posix-only: win32 chmod cannot loosen the
  // owner's access (no enforced mode bits), so the warn never fires there.
  it.skipIf(process.platform === "win32")("doctor's check line says 'credentials file: N keys' and warns on a loose mode", async () => {
    await writeCredentialsFile({ deepseek: SECRET }, env());
    const ok = checkCredentialsFile(env());
    expect(ok.status).toBe("ok");
    expect(ok.label).toContain("credentials file: 1 keys");
    expect(ok.label).not.toContain(SECRET);

    chmodSync(credentialsFilePath(env()), 0o644);
    const warn = checkCredentialsFile(env());
    expect(warn.status).toBe("warn");
    expect(warn.hint).toContain("chmod 0600");
    expect(`${warn.label}${warn.hint ?? ""}`).not.toContain(SECRET);
  });
  it("doctor's check line counts keys on win32 (mode legs are posix)", async () => {
    if (process.platform !== "win32") return;
    await writeCredentialsFile({ deepseek: SECRET }, env());
    const ok = checkCredentialsFile(env());
    expect(ok.status).toBe("ok");
    expect(ok.label).toContain("credentials file: 1 keys");
    expect(ok.label).not.toContain(SECRET);
  });

  it("the statusline segment renders the count, never a value", async () => {
    await writeCredentialsFile({ deepseek: SECRET }, env());
    const snap = await statuslineFromWorkspace(home, env(), "test");
    expect(snap.credentials).toEqual({ count: 1 });
    const line = formatStatuslineLine(snap);
    expect(line).toContain("credentials 1 keys");
    expect(line).not.toContain(SECRET);
    // No file → the segment is omitted entirely.
    const bare = await statuslineFromWorkspace(home, env({ WUDAO_GLOBAL_HOME: `${home}-absent` }), "test");
    expect(bare.credentials).toBeUndefined();
    expect(formatStatuslineLine(bare)).not.toContain("credentials");
  });

  it("the sync status twin matches the async one", async () => {
    await writeCredentialsFile({ deepseek: SECRET }, env());
    expect(credentialsFileStatusSync(env())).toEqual(await credentialsFileStatus(env()));
  });
});

// ---------------------------------------------------------------------------
// Review round (whole-branch): M2 tmp-file mode + R1 file-key children.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync } from "node:fs";
import { createProviderModelResolver } from "../src/agents/index.js";
import { cheapestMatrixModel } from "../src/goal.js";
import { routePreflight } from "../src/workflow/preflight.js";

describe("review M2 — the tmp is CREATED at 0600 (no 0644 window)", () => {
  it("a crash between write and rename strands a 0600 tmp, never a group-readable one", () => {
    const path = credentialsFilePath(env());
    // Make the rename FAIL naturally: the target path is a non-empty
    // directory, so renameSync(tmp, path) throws AFTER the tmp was written —
    // exactly the crash window the finding describes.
    mkdirSync(join(path, "occupied"), { recursive: true });
    expect(() => writeCredentialsFileSync({ deepseek: SECRET }, env())).toThrow();
    const tmp = `${path}.tmp-${process.pid}`;
    expect(existsSync(tmp)).toBe(true);
    // The 0600 octal is posix-only (win32 reports no enforced mode bits).
    if (process.platform !== "win32") {
      expect((statSync(tmp).mode & 0o777).toString(8)).toBe("600");
    }
  });
});

describe("review R1 — file-only-key users' children resolve", () => {
  beforeEach(async () => {
    await writeCredentialsFile({ deepseek: "file-only-key" }, env());
  });

  it("the sub-agent model resolver resolves with NO env key", () => {
    const resolve = createProviderModelResolver({ env: env() });
    const r = resolve({});
    expect(r.ok).toBe(true);
  });

  it("the /goal evaluator's matrix pick resolves with NO env key", () => {
    // deepseek flash is the matrix's implicit cheap tier — with a file-only
    // deepseek key the pick exists (env-only resolution returned undefined).
    expect(cheapestMatrixModel(env())).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
    expect(cheapestMatrixModel(env({ WUDAO_GLOBAL_HOME: `${home}-none` }))).toBeUndefined();
  });

  it("workflow route preflight admits the route with NO env key", () => {
    const r = routePreflight({ env: env(), budgetRemaining: 1_000 });
    expect(r.ok).toBe(true);
    expect(r.refusals).toEqual([]);
    const keyCheck = r.checks.find((c) => c.id === "key");
    expect(keyCheck?.detail).toContain("credentials file");
    // ...and the env-key path still shows the pool wording.
    const envRoute = routePreflight({ env: env({ WUDAO_API_KEY: "k" }), budgetRemaining: 1_000 });
    expect(envRoute.checks.find((c) => c.id === "key")?.detail).toContain("1 key(s) in the pool");
  });
});
