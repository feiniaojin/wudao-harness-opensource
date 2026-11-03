// ω99-4c — lint/test reflection RUNTIME behavior (fake execFile injected):
// lint rides onPostToolUse (M62 additionalContext note), test rides
// onRunStop (block-once + reason), everything fails open.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHooks, AgentState } from "@wudao-org/core";
import {
  buildReflectRuntime,
  composeReflectHooks,
  capReflectOutput,
  type ReflectExec,
  type ReflectRun,
  type ReflectSettings,
} from "../src/reflect-config.js";

interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

/** Scripted fake exec: results[i] answers call i (last result repeats);
 * an Error THROWS (isolation path), undefined resolves undefined (the
 * timeout/spawn-failure resolution of the real seam). */
function fakeExec(results: readonly (ReflectRun | Error | undefined)[]): { exec: ReflectExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  let i = 0;
  const exec: ReflectExec = async (file, args, opts) => {
    calls.push({ file, args: [...args], cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  };
  return { exec, calls };
}

interface RtSpec {
  readonly lint?: string;
  readonly lintTimeoutMs?: number;
  readonly test?: string;
  readonly testTimeoutMs?: number;
  readonly maxRounds?: number;
}

function makeRuntime(spec: RtSpec, exec: ReflectExec) {
  const settings: ReflectSettings = {
    ...(spec.lint !== undefined
      ? { lint: { command: spec.lint, ...(spec.lintTimeoutMs !== undefined ? { timeoutMs: spec.lintTimeoutMs } : {}) } }
      : {}),
    ...(spec.test !== undefined
      ? { test: { command: spec.test, ...(spec.testTimeoutMs !== undefined ? { timeoutMs: spec.testTimeoutMs } : {}) } }
      : {}),
    maxRounds: spec.maxRounds ?? 2,
  };
  const rt = buildReflectRuntime(settings, { workspaceRoot: root(), warn: () => {}, exec });
  expect(rt).toBeDefined();
  return rt!;
}

// The workspace root must be a REAL directory (resolveWorkspacePath
// realpaths the root); beforeEach-suite mkdtemp provides it.
let theRoot = "";
function root(): string {
  return theRoot;
}

const stopState = { messages: [] } as unknown as AgentState;

beforeAll(async () => {
  theRoot = await mkdtemp(join(tmpdir(), "reflect-rt-"));
});
afterAll(async () => {
  if (theRoot !== "") await rm(theRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("lint reflection (onPostToolUse)", () => {
  it("edit + exit 1 with output → note with command, rel path, merged output", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "src/a.ts:1:1 semi error", stderr: "config warning" }]);
    const rt = makeRuntime({ lint: "eslint --fix ${file}" }, exec);
    const note = await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    expect(typeof note).toBe("string");
    expect(note).toContain("[reflect:lint] harness 已对 src/a.ts 运行 `eslint --fix src/a.ts`（不要自己再跑），发现以下问题，请在继续前修复：");
    expect(note).toContain("src/a.ts:1:1 semi error");
    expect(note).toContain("config warning");
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ file: "eslint", args: ["--fix", "src/a.ts"], cwd: root(), timeoutMs: 30_000 });
  });

  it("exit 0 → undefined (clean lint injects nothing)", async () => {
    const { exec, calls } = fakeExec([{ code: 0, stdout: "all good", stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}" }, exec);
    expect(await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited")).toBeUndefined();
    expect(calls.length).toBe(1);
  });

  it("write_file also triggers (the other landing face)", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "boom", stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}" }, exec);
    expect(typeof await rt.hooks.onPostToolUse!("write_file", { path: "src/b.ts" }, "wrote src/b.ts")).toBe("string");
    expect(calls.length).toBe(1);
  });

  it("non-edit tools and path-less inputs never run lint", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "boom", stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}" }, exec);
    expect(await rt.hooks.onPostToolUse!("read_file", { path: "src/a.ts" }, "…")).toBeUndefined();
    expect(await rt.hooks.onPostToolUse!("edit", { old_string: "x" }, "edited")).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  it("path escaping the workspace → no lint (containment guard)", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "boom", stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}" }, exec);
    expect(await rt.hooks.onPostToolUse!("edit", { path: "../../outside.ts" }, "edited")).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  it("same file twice in one batch → deduped to one run", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "err", stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}" }, exec);
    await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    expect(await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited")).toBeUndefined();
    expect(calls.length).toBe(1);
  });

  it("different files in one batch each lint (with ${file})", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "e1", stderr: "" }, { code: 1, stdout: "e2", stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}" }, exec);
    expect(typeof await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited")).toBe("string");
    expect(typeof await rt.hooks.onPostToolUse!("edit", { path: "src/b.ts" }, "edited")).toBe("string");
    expect(calls.map((c) => c.args)).toEqual([["src/a.ts"], ["src/b.ts"]]);
  });

  it("no ${file} → whole batch lints ONCE (first trigger), batch boundary re-arms", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "e", stderr: "" }, { code: 1, stdout: "e", stderr: "" }]);
    const rt = makeRuntime({ lint: "pnpm lint" }, exec);
    expect(typeof await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited")).toBe("string");
    expect(await rt.hooks.onPostToolUse!("edit", { path: "src/b.ts" }, "edited")).toBeUndefined();
    expect(calls.length).toBe(1);
    expect(calls[0]!.file).toBe("pnpm");
    // batch landed → dedup state cleared → next batch's first file runs again
    await rt.hooks.onPostToolBatch!([]);
    expect(typeof await rt.hooks.onPostToolUse!("edit", { path: "src/c.ts" }, "edited")).toBe("string");
    expect(calls.length).toBe(2);
  });

  it("output capped at 6000 chars (head 4000 + …(truncated)… + tail 2000)", async () => {
    const big = "x".repeat(20_000) + "TAILMARKER" + "y".repeat(500);
    const { exec } = fakeExec([{ code: 1, stdout: big, stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}" }, exec);
    const note = (await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited")) as string;
    // body = everything after the header line (the merged, capped output)
    const body = note.slice(note.indexOf("\n") + 1);
    expect(body.startsWith("x".repeat(100))).toBe(true);
    expect(body).toContain("…(truncated)…");
    expect(body.endsWith("TAILMARKER" + "y".repeat(500))).toBe(true);
    expect(body.length).toBe(4000 + "…(truncated)…".length + 2000);
  });

  it("capReflectOutput unit: short text passes through unchanged", () => {
    expect(capReflectOutput("short")).toBe("short");
    expect(capReflectOutput("a".repeat(6000))).toBe("a".repeat(6000));
    const capped = capReflectOutput("a".repeat(6001));
    expect(capped.length).toBe(4000 + "…(truncated)…".length + 2000);
    expect(capped).toContain("…(truncated)…");
  });
});

describe("round caps (per-run counters, onRunStart resets)", () => {
  it("maxRounds=1: second failing edit in a NEW batch → lint not run again", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "err", stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}", maxRounds: 1 }, exec);
    expect(typeof await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited")).toBe("string");
    await rt.hooks.onPostToolBatch!([]);
    expect(await rt.hooks.onPostToolUse!("edit", { path: "src/b.ts" }, "edited")).toBeUndefined();
    expect(calls.length).toBe(1); // the cap stopped the second run
  });

  it("onRunStart resets the per-run lint counter (a new run reflects again)", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "err", stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}", maxRounds: 1 }, exec);
    expect(typeof await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited")).toBe("string");
    await rt.hooks.onPostToolBatch!([]);
    expect(await rt.hooks.onPostToolUse!("edit", { path: "src/b.ts" }, "edited")).toBeUndefined();
    await rt.hooks.onRunStart!(stopState);
    expect(typeof await rt.hooks.onPostToolUse!("edit", { path: "src/c.ts" }, "edited")).toBe("string");
    expect(calls.length).toBe(2);
  });

  it("clean (exit 0) lint runs do NOT consume rounds", async () => {
    const { exec, calls } = fakeExec([{ code: 0, stdout: "", stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}", maxRounds: 1 }, exec);
    await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    await rt.hooks.onPostToolBatch!([]);
    await rt.hooks.onPostToolUse!("edit", { path: "src/b.ts" }, "edited");
    expect(calls.length).toBe(2); // cap counts INJECTIONS, not runs
  });
});

describe("test reflection (onRunStop)", () => {
  it("run with a landed edit + test exit 1 → block with reason note", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "FAIL src/a.test.ts", stderr: "" }]);
    const rt = makeRuntime({ test: "vitest run" }, exec);
    await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    const d = await rt.hooks.onRunStop!(stopState);
    expect(d).toEqual({
      block: true,
      reason: expect.stringContaining("[reflect:test] harness 已运行 `vitest run`（不要自己再跑），发现以下问题，请在继续前修复："),
    } as unknown as { block: true; reason: string });
    expect((d as { reason: string }).reason).toContain("FAIL src/a.test.ts");
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ file: "vitest", args: ["run"], cwd: root(), timeoutMs: 180_000 });
  });

  it("test exit 0 → allow", async () => {
    const { exec } = fakeExec([{ code: 0, stdout: "3 passed", stderr: "" }]);
    const rt = makeRuntime({ test: "vitest run" }, exec);
    await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    expect(await rt.hooks.onRunStop!(stopState)).toBe("allow");
  });

  it("run WITHOUT edits → test never runs, allow", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "FAIL", stderr: "" }]);
    const rt = makeRuntime({ test: "vitest run" }, exec);
    await rt.hooks.onPostToolUse!("read_file", { path: "src/a.ts" }, "…");
    expect(await rt.hooks.onRunStop!(stopState)).toBe("allow");
    expect(calls.length).toBe(0);
  });

  it("block count reaches maxRounds → allow (with one warning), no further test run", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "FAIL", stderr: "" }]);
    const warnings: string[] = [];
    const settings: ReflectSettings = { test: { command: "vitest run" }, maxRounds: 1 };
    const rt = buildReflectRuntime(settings, { workspaceRoot: root(), warn: (m) => warnings.push(m), exec })!;
    await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    expect(typeof await rt.hooks.onRunStop!(stopState)).toBe("object");
    expect(await rt.hooks.onRunStop!(stopState)).toBe("allow");
    expect(await rt.hooks.onRunStop!(stopState)).toBe("allow");
    expect(calls.length).toBe(1); // cap checked before running
    expect(warnings.filter((w) => w.includes("round cap")).length).toBe(1);
  });

  it("onRunStart re-arms test reflection for the next run (fresh counters)", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "FAIL", stderr: "" }, { code: 1, stdout: "FAIL", stderr: "" }]);
    const rt = makeRuntime({ test: "vitest run", maxRounds: 1 }, exec);
    await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    expect(typeof await rt.hooks.onRunStop!(stopState)).toBe("object");
    await rt.hooks.onRunStart!(stopState);
    await rt.hooks.onPostToolUse!("edit", { path: "src/b.ts" }, "edited");
    expect(typeof await rt.hooks.onRunStop!(stopState)).toBe("object");
    expect(calls.length).toBe(2);
  });

  it("test output rides the same 6000-char truncation", async () => {
    const big = "z".repeat(9000) + "ENDMARK";
    const { exec } = fakeExec([{ code: 1, stdout: big, stderr: "" }]);
    const rt = makeRuntime({ test: "vitest run" }, exec);
    await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    const d = (await rt.hooks.onRunStop!(stopState)) as { block: true; reason: string };
    const body = d.reason.slice(d.reason.indexOf("\n") + 1);
    expect(body).toContain("…(truncated)…");
    expect(body.endsWith("ENDMARK")).toBe(true);
    expect(body.length).toBe(4000 + "…(truncated)…".length + 2000);
  });
});

describe("fail-open (reflection is a bonus, never a gate)", () => {
  it("exec THROWS → lint returns undefined, test returns allow", async () => {
    const { exec } = fakeExec([new Error("boom")]);
    const rt = makeRuntime({ lint: "eslint ${file}", test: "vitest run" }, exec);
    expect(await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited")).toBeUndefined();
    await rt.hooks.onPostToolUse!("edit", { path: "src/b.ts" }, "edited");
    expect(await rt.hooks.onRunStop!(stopState)).toBe("allow");
  });

  it("exec resolves undefined (timeout/spawn failure shape) → lint undefined, test allow", async () => {
    const { exec } = fakeExec([undefined]);
    const rt = makeRuntime({ lint: "eslint ${file}", test: "vitest run" }, exec);
    expect(await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited")).toBeUndefined();
    await rt.hooks.onPostToolUse!("edit", { path: "src/b.ts" }, "edited");
    expect(await rt.hooks.onRunStop!(stopState)).toBe("allow");
  });

  it("the DEFAULT exec seam kills on timeout and resolves fail-open", async () => {
    const warnings: string[] = [];
    const rt = buildReflectRuntime(
      { lint: { command: `${process.execPath} -e "setTimeout(()=>{},5000)"`, timeoutMs: 80 }, maxRounds: 2 },
      { workspaceRoot: root(), warn: (m) => warnings.push(m) },
    )!;
    const note = await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    expect(note).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/timed out/);
  });
});

describe("composition semantics (reflect is innermost — existing chains win)", () => {
  it("a user onRunStop block wins and reflect is never even consulted", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "FAIL", stderr: "" }]);
    const rt = makeRuntime({ test: "vitest run" }, exec);
    const user: AgentHooks = {
      onRunStop: async () => ({ block: true, reason: "user says stop" }),
    };
    await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    const composed = composeReflectHooks(user, rt)!;
    const d = await composed.onRunStop!(stopState);
    expect(d).toEqual({ block: true, reason: "user says stop" });
    expect(calls.length).toBe(0); // composeAgentHooks short-circuits before reflect
  });

  it("existing chain allows + reflect wants block → reflect's block stands", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "FAIL", stderr: "" }]);
    const rt = makeRuntime({ test: "vitest run" }, exec);
    const user: AgentHooks = { onRunStop: async () => "allow" };
    await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    const composed = composeReflectHooks(user, rt)!;
    expect(typeof await composed.onRunStop!(stopState)).toBe("object");
    expect(calls.length).toBe(1);
  });

  it("base undefined → reflect hooks ride alone (feature works without config hooks)", async () => {
    const { exec } = fakeExec([{ code: 1, stdout: "err", stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}" }, exec);
    const composed = composeReflectHooks(undefined, rt)!;
    expect(typeof await composed.onPostToolUse!("edit", { path: "src/a.ts" }, "edited")).toBe("string");
  });

  it("reflect undefined → base returned UNCHANGED (byte-zero when OFF)", async () => {
    const user: AgentHooks = { onRunStop: async () => "allow" };
    expect(composeReflectHooks(user, undefined)).toBe(user);
    expect(composeReflectHooks(undefined, undefined)).toBeUndefined();
  });

  it("onPostToolUse contexts CHAIN across the composition (existing + lint note)", async () => {
    const { exec } = fakeExec([{ code: 1, stdout: "err", stderr: "" }]);
    const rt = makeRuntime({ lint: "eslint ${file}" }, exec);
    const user: AgentHooks = {
      onPostToolUse: async () => "existing context",
    };
    const composed = composeReflectHooks(user, rt)!;
    const note = await composed.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    expect(note).toBe(`existing context\n\n[reflect:lint] harness 已对 src/a.ts 运行 \`eslint src/a.ts\`（不要自己再跑），发现以下问题，请在继续前修复：\nerr`);
  });

  it("user {continue:false} (the prompt-hook spelling) also outranks reflect's block", async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: "FAIL", stderr: "" }]);
    const rt = makeRuntime({ test: "vitest run" }, exec);
    const user: AgentHooks = { onRunStop: async () => ({ continue: false }) };
    await rt.hooks.onPostToolUse!("edit", { path: "src/a.ts" }, "edited");
    const composed = composeReflectHooks(user, rt)!;
    expect(await composed.onRunStop!(stopState)).toEqual({ continue: false });
    expect(calls.length).toBe(0);
  });
});
