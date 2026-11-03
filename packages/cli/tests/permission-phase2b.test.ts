// design 70 §4 Phase 2b — funnel-1 wiring in packages/cli/src/permission.ts.
// The dormant Phase 1 deviation #2 seam (the optional 7th `askReview` param of
// `createPermissionGate`) is woken: armed child-originated asks route through
// the new param, the resolved intro lands in `askApprove`'s pre block just
// above the digest. Every failure path returns undefined → byte-identical
// fail-closed (today's prompt). The two index.ts child-serving sites are
// pinned via a static source scan (do NOT spawn real CLIs — the brief
// forbids it).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import {
  createPermissionGate,
  type PermissionDecision,
} from "../src/permission.js";

const wait = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Conditional wait — poll observable state until the assertion precondition
 *  holds, with a timeout ceiling so a broken gate fails loudly instead of
 *  hanging. Shape mirrors tests/agent-root-switch.test.ts. */
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** All funnel-1 asks need a TTY + a stdin data event to land an answer. The
 *  production `askApprove` (permission.ts:823-848) reads:
 *    1. `stdin.isTTY` to gate the prompt vs non-interactive fail-closed
 *    2. `process.stdin.once("data", onData)` to capture the user's reply
 *    3. `process.stdin.resume()` to start the stream
 *  We mock all three in beforeEach; reset after. */
class StdinHarness {
  public writes: string[] = [];
  public capturedDataHandler: ((chunk: Buffer | string) => void) | undefined;
  private origIsTTY: boolean | undefined;
  private origWrite: typeof stdout.write;
  private origOnce: typeof process.stdin.once;
  private origResume: typeof process.stdin.resume;

  constructor() {
    this.origWrite = stdout.write.bind(stdout);
    this.origOnce = process.stdin.once.bind(process.stdin);
    this.origResume = process.stdin.resume.bind(process.stdin);
  }

  install(): void {
    this.origIsTTY = (stdin as { isTTY?: boolean }).isTTY;
    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    vi.spyOn(stdout, "write").mockImplementation(((chunk: unknown): boolean => {
      const s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      this.writes.push(s);
      return true;
    }) as typeof stdout.write);
    vi.spyOn(process.stdin, "once").mockImplementation(((event: string, listener: (...args: unknown[]) => void): typeof process.stdin => {
      if (event === "data") {
        this.capturedDataHandler = listener as (chunk: Buffer | string) => void;
      }
      return process.stdin;
    }) as typeof process.stdin.once);
    vi.spyOn(process.stdin, "resume").mockImplementation(((): typeof process.stdin => {
      // no-op — the harness drives capturedDataHandler directly
      return process.stdin;
    }) as typeof process.stdin.resume);
  }

  uninstall(): void {
    if (this.origIsTTY !== undefined) {
      Object.defineProperty(stdin, "isTTY", { value: this.origIsTTY, configurable: true });
    }
    vi.restoreAllMocks();
  }

  /** Feed the captured data handler with one line (the production parser
   *  reads `chunk.split("\n")[0]`). */
  answer(line: string): void {
    if (this.capturedDataHandler === undefined) throw new Error("no captured data handler (gate never reached askApprove?)");
    this.capturedDataHandler(line);
  }

  /** Concatenate every captured chunk — what the user "saw" on stdout. */
  promptSoFar(): string {
    return this.writes.join("");
  }

  resetWrites(): void {
    this.writes.length = 0;
  }
}

describe("createPermissionGate — Phase 2b funnel-1 wiring (7th askReview param)", () => {
  let root: string;
  let origCwd: string;
  let harness: StdinHarness;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "phase2b-perm-"));
    origCwd = process.cwd();
    process.chdir(root);
    // Make sure NO settings.json exists → empty allow/deny → default-mode
    // shell = "ask" → reaches askHuman. (0.3.14: the asks ride
    // `npm install` — a command OUTSIDE accept's safe read-only class, which
    // would auto-allow at layer 4.7 and never reach the funnel under test.)
    harness = new StdinHarness();
    harness.install();
  });

  afterEach(async () => {
    process.chdir(origCwd);
    harness.uninstall();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // -----------------------------------------------------------------------
  // (a) The 7th-param wiring: an armed ask with a non-empty intro threads
  //     into askApprove and the callable is invoked. (Mirror of funnel-3/4.)
  // -----------------------------------------------------------------------
  it("(a) 7th-param wiring: callable is invoked and the intro lands in the prompt", async () => {
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const gate = createPermissionGate(
      ["wudao", "x"], // default mode → shell asks
      undefined, undefined, undefined, undefined, undefined,
      async (toolName, input) => {
        calls.push({ toolName, input });
        return "🛡 ask-review (advisory): covered — smoke test";
      },
    );
    const promise = gate("shell", { command: "npm install" });
    // Precondition: the ask prompt has rendered. askApprove emits the review
    // line + digest + `🔑 允许 <tool>` menu in ONE stdout.write and registers
    // the stdin handler in the same synchronous block — so once the menu line
    // is observable, the callable was invoked, the whole prompt is in
    // `writes`, and answer() below is safe.
    await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "ask prompt (review intro + menu) to render");
    expect(calls).toEqual([{ toolName: "shell", input: { command: "npm install" } }]);
    // The review line MUST land in askApprove's `pre` block above the digest.
    const prompt = harness.promptSoFar();
    expect(prompt).toContain("🛡 ask-review (advisory): covered — smoke test");
    expect(prompt).toContain("🔑 允许 shell");
    // Respond "y" → allow.
    harness.answer("y");
    const result = await promise;
    expect(result).toEqual({ behavior: "allow" } satisfies PermissionDecision);
  });

  // -----------------------------------------------------------------------
  // (b) The absent/undefined 7th param: byte-equivalent fail-closed (no
  //     Phase 2b leak). Two prompts must be byte-equal to today.
  // -----------------------------------------------------------------------
  it("(b) undefined 7th param: prompt is byte-identical to today's gate", async () => {
    const baseline = createPermissionGate(
      ["wudao", "x"],
      undefined, undefined, undefined, undefined, undefined,
    );
    const promiseBaseline = baseline("shell", { command: "npm install" });
    await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "baseline ask prompt to render");
    const baselinePrompt = harness.promptSoFar();
    harness.answer("y");
    await promiseBaseline;
    // Sanity: the baseline (today's behavior) has no review line.
    expect(baselinePrompt).not.toContain("ask-review");
    expect(baselinePrompt).toContain("🔑 允许 shell");

    harness.resetWrites();

    // Same call site but with askReview === undefined.
    const withCallable = createPermissionGate(
      ["wudao", "x"],
      undefined, undefined, undefined, undefined, undefined,
      async () => undefined, // callable provided, but it returns undefined → fail-closed
    );
    const promiseWithCallable = withCallable("shell", { command: "npm install" });
    await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "askReview-undefined ask prompt to render");
    const withCallablePrompt = harness.promptSoFar();
    harness.answer("y");
    await promiseWithCallable;
    expect(withCallablePrompt).toBe(baselinePrompt);
    expect(withCallablePrompt).not.toContain("ask-review");
  });

  // -----------------------------------------------------------------------
  // (d) Reviewer failure paths: sync throw / non-string result → upstream
  //     sees undefined intro. The byte-equivalent prompt pin still holds.
  // -----------------------------------------------------------------------
  it("(d.1) sync-throwing 7th-param callable: prompt is byte-identical", async () => {
    const gate = createPermissionGate(
      ["wudao", "x"],
      undefined, undefined, undefined, undefined, undefined,
      () => {
        throw new Error("reviewer boom");
      },
    );
    const promise = gate("shell", { command: "npm install" });
    await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "ask prompt (sync-throw reviewer) to render");
    const prompt = harness.promptSoFar();
    expect(prompt).not.toContain("ask-review");
    expect(prompt).toContain("🔑 允许 shell");
    harness.answer("y");
    const result = await promise;
    expect(result).toEqual({ behavior: "allow" });
  });

  it("(d.2) cyclic / no-evidence-style failure (callable returns undefined): prompt is byte-identical", async () => {
    // Same shape as funnel-3/4's no-evidence / cyclic-ask — the askReview
    // helper upstream returns undefined and we get the byte-identical prompt.
    const calls = vi.fn(() => undefined as string | undefined);
    const gate = createPermissionGate(
      ["wudao", "x"],
      undefined, undefined, undefined, undefined, undefined,
      async () => calls(),
    );
    const promise = gate("shell", { command: "npm install" });
    await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "ask prompt (undefined-returning reviewer) to render");
    const prompt = harness.promptSoFar();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(prompt).not.toContain("ask-review");
    expect(prompt).toContain("🔑 允许 shell");
    harness.answer("y");
    const result = await promise;
    expect(result).toEqual({ behavior: "allow" });
  });

  it("(d.3) callable resolves to a string with a trailing \\n: pre block renders ONE line + newline", async () => {
    // The renderAskReviewLine output is single-line, but a test that pins the
    // joining discipline (`\\n` separator between blocks) guards against a
    // regression where a reviewer line lacks a terminator.
    const gate = createPermissionGate(
      ["wudao", "x"],
      undefined, undefined, undefined, undefined, undefined,
      async () => "🛡 single line intro",
    );
    const promise = gate("shell", { command: "npm install" });
    await until(() => harness.promptSoFar().includes("🔑 允许 shell"), "ask prompt (single-line intro) to render");
    const prompt = harness.promptSoFar();
    expect(prompt).toContain("🛡 single line intro\n");
    // And the ask menu still follows immediately after (no double blank line).
    expect(prompt.indexOf("🛡 single line intro\n🔑 允许 shell")).toBeGreaterThanOrEqual(0);
    harness.answer("y");
    await promise;
  });
});

// ---------------------------------------------------------------------------
// (c) The two index.ts call sites: a STATIC source scan (do NOT spawn real
//     CLIs). Pins that the spread is present at both sites AND that the
//     callable's body is the late-bound reviewerBox / oneShotReviewerBox
//     pattern (the exact shape design 70 §4 Phase 2 prescribes).
// ---------------------------------------------------------------------------

describe("index.ts — Phase 2b funnel-1 wiring call sites (static source scan)", () => {
  const indexSource = readFileSync(
    join(import.meta.dirname, "..", "src", "index.ts"),
    "utf8",
  );

  it("(c.1) REPL buildTools site (was index.ts:982) spreads askReview into createPermissionGate", () => {
    // The spread site lives inside `buildTools: (model, stateHandle) => { ... }`.
    // Pin: the createPermissionGate call inside that arrow body has the new
    // 7th arg, and `replReviewerBox.current` is written from the closure
    // before the gate is built.
    expect(indexSource).toMatch(/replReviewerBox:\s*\{\s*current\?:\s*ModelClient\s*\}\s*=\s*\{\s*\}/);
    expect(indexSource).toMatch(/replReviewerBox\.current\s*=\s*model\s*;/);
    // The closure inside the gate's 7th arg reads `replReviewerBox.current`
    // at ASK time and forwards to askReviewIntro.
    const replBlock = indexSource.match(/buildTools:\s*\(model,\s*stateHandle\)\s*=>\s*\{[\s\S]*?createPermissionGate\(argv,\s*replSidecar[\s\S]*?\}/);
    expect(replBlock).not.toBeNull();
    if (replBlock !== null) {
      expect(replBlock[0]).toMatch(/hooks\?\.onPermissionRequest,\s*async\s*\(\s*t,\s*i\s*\)\s*=>/);
      expect(replBlock[0]).toMatch(/replReviewerBox\.current/);
      expect(replBlock[0]).toMatch(/askReviewIntro\(\s*m,\s*t,\s*i\s*\)/);
    }
  });

  it("(c.2) one-shot buildToolSet site (was index.ts:1154) spreads askReview into createPermissionGate", () => {
    expect(indexSource).toMatch(/oneShotReviewerBox:\s*\{\s*current\?:\s*ModelClient\s*\}\s*=\s*\{\s*current:\s*model\s*\}/);
    // The closure inside the gate's 7th arg reads `oneShotReviewerBox.current`
    // at ASK time and forwards to askReviewIntro.
    expect(indexSource).toMatch(/createPermissionGate\(argv,\s*sidecar,[\s\S]*?hooks\?\.onPermissionRequest,\s*async\s*\(\s*t,\s*i\s*\)\s*=>/);
    expect(indexSource).toMatch(/oneShotReviewerBox\.current/);
    expect(indexSource).toMatch(/askReviewIntro\(\s*m,\s*t,\s*i\s*\)/);
  });

  it("(c.3) the `askReviewIntro` symbol is imported from ./ask-reviewer.js exactly once", () => {
    const importMatches = indexSource.match(/from\s+["']\.\/ask-reviewer\.js["']/g);
    expect(importMatches).not.toBeNull();
    expect(importMatches).toHaveLength(1);
    expect(indexSource).toContain('import { askReviewIntro } from "./ask-reviewer.js"');
  });

  it("(c.4) `ModelClient` is imported from @wudao-org/core (the box type)", () => {
    expect(indexSource).toMatch(/import\s*\{[^}]*\bModelClient\b[^}]*\}\s*from\s+["']@wudao-org\/core["']/);
  });
});

// ---------------------------------------------------------------------------
// Static regression guard for the byte-equivalent claim: when askReview is
// absent, the permission.ts source has NO new branch on a reviewer-related
// identifier inside askHuman. The post-Phase-2b wiring is purely additive.
// ---------------------------------------------------------------------------

describe("permission.ts — Phase 2b byte-equivalent regression guard", () => {
  const permSource = readFileSync(
    join(import.meta.dirname, "..", "src", "permission.ts"),
    "utf8",
  );

  it("askHuman contains exactly ONE askReview invocation (the late-bound call)", () => {
    // The `askReview` identifier in askHuman should appear in two places:
    //   1. the truthiness check (`if (askReview !== undefined)`)
    //   2. the call itself (`askReview(toolName, input)`)
    const askHumanMatch = permSource.match(/const\s+askHuman\s*=\s*async[\s\S]*?return\s+final;\s*\};/);
    expect(askHumanMatch).not.toBeNull();
    if (askHumanMatch !== null) {
      const body = askHumanMatch[0];
      const truthyCount = (body.match(/askReview\s*!==\s*undefined/g) ?? []).length;
      const callCount = (body.match(/askReview\(\s*toolName,\s*input\s*\)/g) ?? []).length;
      expect(truthyCount).toBe(1);
      expect(callCount).toBe(1);
    }
  });

  it("askApprove renders an UNDEFINED reviewLine as no extra bytes (byte-equivalent)", () => {
    const askApproveFn = permSource.match(/function\s+askApprove\([\s\S]*?resolve\(parseAskAnswer\(line\)\);\s*\};/);
    expect(askApproveFn).not.toBeNull();
    if (askApproveFn !== null) {
      // The `pre` block must NOT include any review-only branch when
      // reviewLine is undefined — identical to the pre-Phase-2b concatenation
      // discipline (just an extra optional segment at the head of the template).
      // The pre line is one long template literal; we look for the conditional
      // spread shape + the surviving digest/warning/sidecarNote checks.
      const body = askApproveFn[0];
      expect(body).toMatch(/reviewLine\s*!==\s*undefined/);
      expect(body).toMatch(/digest\s*!==\s*undefined/);
      expect(body).toMatch(/warning\s*!==\s*undefined/);
      expect(body).toMatch(/sidecarNote\s*!==\s*undefined/);
    }
  });
});

// Silence the unused-writeFile linter; writeFile is imported so callers can
// legitimately seed settings.json if they extend this suite.
void writeFile;
