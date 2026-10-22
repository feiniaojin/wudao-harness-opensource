// 借鉴弧 C1（the upstream project C3）— evidence-preserving log slimming 的伪造对抗
// 电池：digest 验收口径「一组伪造回执用例（错哈希/编造引用/洗失败为
// 干净）必须全部 fallback」。每个门都要可证地咬人：任何一门不过 = 整张
// 回执作废、fail-open（主模型回看原文，绝不喂未验证摘要）。外加预筛门
// （非诊断命令/阈值外/疑似密钥不发起调用——用 scripted model 的调用计数
// 证明零模型调用）与 shell 缝的回执替换 + 字节不变 fallback。
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { AssistantMessage, ModelClient, ModelInput } from "../src/index.js";
import {
  DEFAULT_LOG_SLIMMING,
  LOG_SLIMMING_SYSTEM_PROMPT,
  isDiagnosticCommand,
  looksLikeSecret,
  hasFailureSignal,
  parseReceipt,
  verifyReceipt,
  renderReceipt,
  slimToolLog,
  type ParsedReceipt,
} from "../src/index.js";
import { createShellTool } from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A big synthetic build log: passing lines, then ONE failure block mid-way,
 *  then more passing lines (the tail alone does NOT name the failure — the
 *  exact band where a head/tail preview under-informs). */
const PASS_LINE = "ok 123 - component renders without warnings";
const FAIL_LINE = "FAILED src/core/loop.test.ts > loop exits on tool_use block";
/** The log's LAST line — unique, and strictly AFTER the failure line. */
const LAST_LINE = "ok 1200 - component renders without warnings";
function buildLog(lines: number, failAt: number): string {
  const out: string[] = [];
  for (let i = 1; i <= lines; i += 1) {
    out.push(i === failAt ? FAIL_LINE : PASS_LINE.replace("123", String(i)));
  }
  return out.join("\n");
}
const BIG_LOG = buildLog(1200, 600); // ~55KB, failure at line 600
const BIG_LOG_SHA = createHash("sha256").update(BIG_LOG, "utf8").digest("hex");

const TINY_CONFIG = { minChars: 100, maxChars: 100_000, timeoutMs: 1_000, maxEvidence: 12, maxQuoteChars: 600, maxSummaryChars: 2_000 };

/** A scripted reducer answering canned reply text; counts calls + inputs. */
function reducer(reply: string, modelId?: string): { model: ModelClient; calls: () => number; inputs: ModelInput[] } {
  let calls = 0;
  const inputs: ModelInput[] = [];
  return {
    inputs,
    calls: () => calls,
    model: {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push(input);
        calls += 1;
        return { role: "assistant", content: reply };
      },
      ...(modelId !== undefined ? { modelId } : {}),
    },
  };
}

/** The honest receipt every forgery mutates. */
function honestReceipt(): ParsedReceipt {
  return {
    source_sha256: BIG_LOG_SHA,
    uncertain: false,
    summary: "第 600 行一处测试失败，其余 1199 行通过。",
    evidence: [{ quote: FAIL_LINE }, { quote: LAST_LINE }],
  };
}

const SLIM_ARGS = {
  raw: BIG_LOG,
  command: "pnpm test",
  observedFailed: true,
  archivePath: "/tmp/.wudao/spill/s1/abc.txt",
};

// ---------------------------------------------------------------------------
// eligibility (pure)
// ---------------------------------------------------------------------------

describe("eligibility — 诊断命令识别与密钥预筛", () => {
  it("recognizes the common build/test drivers at command or sequence positions", () => {
    for (const cmd of ["pnpm test", "pnpm run build", "npm run ci", "cargo build", "cargo test", "go test ./...", "make", "cmake ..", "ninja", "pytest -x", "vitest run", "tsc --noEmit", "echo hi && pnpm build", "cd app && yarn test"]) {
      expect(isDiagnosticCommand(cmd), cmd).toBe(true);
    }
  });

  it("rejects non-diagnostic commands (fail-open direction)", () => {
    for (const cmd of ["cat README.md", "echo 'pnpm test'", "git status", "ls -la", "rm -rf tmp"]) {
      expect(isDiagnosticCommand(cmd), cmd).toBe(false);
    }
  });

  it("flags known credential shapes but not base64 build hashes", () => {
    expect(looksLikeSecret("sk-abcdefghij0123456789AB")).toBe(true);
    expect(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(looksLikeSecret("ghp_" + "a".repeat(36))).toBe(true);
    expect(looksLikeSecret(BIG_LOG)).toBe(false);
    expect(looksLikeSecret("sha256:abc123DEF456ghi789JKL012mno345PQR678stu901")).toBe(false);
  });

  it("failure signals match real failure spellings, not success lines", () => {
    expect(hasFailureSignal("FAILED src/a.test.ts")).toBe(true);
    expect(hasFailureSignal("error TS2322: bad assign")).toBe(true);
    expect(hasFailureSignal("Traceback (most recent call last):")).toBe(true);
    expect(hasFailureSignal("0 errors, 0 warnings")).toBe(false);
    expect(hasFailureSignal(PASS_LINE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// strict schema (no status field — 超越①)
// ---------------------------------------------------------------------------

describe("parseReceipt — 严格 schema，无 status 面", () => {
  it("parses the exact shape", () => {
    const r = parseReceipt(JSON.stringify(honestReceipt()));
    expect(r).toBeDefined();
    expect(r!.evidence).toHaveLength(2);
  });

  it("rejects extra keys, wrapped JSON, missing keys, wrong types", () => {
    const withStatus = { ...honestReceipt(), status: "fail" } as unknown as Record<string, unknown>;
    expect(parseReceipt(JSON.stringify(withStatus))).toBeUndefined(); // 伪造面直接不存在
    expect(parseReceipt(`here is my receipt:\n${JSON.stringify(honestReceipt())}`)).toBeUndefined();
    expect(parseReceipt(JSON.stringify({ source_sha256: BIG_LOG_SHA, uncertain: false, summary: "s" }))).toBeUndefined();
    expect(parseReceipt(JSON.stringify({ ...honestReceipt(), uncertain: "maybe" }))).toBeUndefined();
    expect(parseReceipt(JSON.stringify({ ...honestReceipt(), evidence: [{ quote: 1 }] }))).toBeUndefined();
    expect(parseReceipt(JSON.stringify({ ...honestReceipt(), evidence: [{ quote: "x", line: 3 }] }))).toBeUndefined();
    expect(parseReceipt("null")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// the gates — every forgery must void the whole receipt
// ---------------------------------------------------------------------------

describe("verifyReceipt — 逐门咬人", () => {
  const V = (receipt: ParsedReceipt, raw = BIG_LOG, observedFailed = true) =>
    verifyReceipt({ receipt, raw, observedFailed });

  it("the honest receipt passes with in-order evidence and harness line numbers", () => {
    const { evidence, violations } = V(honestReceipt());
    expect(violations).toEqual([]);
    expect(evidence).toHaveLength(2);
    expect(evidence[0]!.line).toBe(600); // harness-computed, not model-claimed
    expect(evidence[1]!.line).toBe(1200); // LAST_LINE — strictly after the failure
  });

  it("gate 2: wrong source hash voids", () => {
    const bad = { ...honestReceipt(), source_sha256: "0".repeat(64) };
    expect(V(bad).violations.some((x) => x.includes("sha256 mismatch"))).toBe(true);
  });

  it("gate 3a: fabricated quote (not byte-exact) voids", () => {
    const bad = { ...honestReceipt(), evidence: [{ quote: "FAILED src/core/loop.test.ts (paraphrased summary)" }] };
    expect(V(bad).violations.some((x) => x.includes("not found"))).toBe(true);
  });

  it("gate 3b: out-of-order quotes void (超越②)", () => {
    // PASS_LINE first occurs at line 1; FAIL_LINE at 600 — reversed order
    // means the second search starts after the first PASS hit and FAIL is
    // still findable… so use a quote whose ONLY occurrence precedes another.
    const earlyOnly = "ok 1 - component renders without warnings";
    const bad = { ...honestReceipt(), evidence: [{ quote: FAIL_LINE }, { quote: earlyOnly }] };
    const { violations } = V(bad);
    expect(violations.some((x) => x.includes("not found in-order"))).toBe(true);
  });

  it("gate 3c: overlapping quotes void (超越②)", () => {
    // FAIL_LINE plus a superstring quote containing it → the second search
    // starts inside/after the first hit and cannot re-find the overlap.
    const superstring = `before ${FAIL_LINE} after`;
    // FAIL_LINE occurs ONLY inside the span — quoting both = overlap.
    const raw2 = `x\n${superstring}\n` + "filler\n".repeat(30);
    const bad: ParsedReceipt = {
      source_sha256: createHash("sha256").update(raw2, "utf8").digest("hex"),
      uncertain: false,
      summary: "s",
      evidence: [{ quote: superstring }, { quote: FAIL_LINE }],
    };
    // First quote consumes the only superstring occurrence; FAIL_LINE's
    // remaining occurrence is BEFORE that hit → out-of-order → void.
    const { violations } = V(bad, raw2);
    expect(violations.some((x) => x.includes("not found in-order"))).toBe(true);
  });

  it("gate 4: duplicate quotes, count cap, quote length cap void", () => {
    const dup = { ...honestReceipt(), evidence: [{ quote: FAIL_LINE }, { quote: FAIL_LINE }] };
    expect(V(dup).violations.some((x) => x.includes("duplicate"))).toBe(true);
    const many = { ...honestReceipt(), evidence: Array.from({ length: 13 }, () => ({ quote: PASS_LINE })) };
    expect(V(many).violations.some((x) => x.includes("> cap"))).toBe(true);
    const long = "x".repeat(601);
    const raw3 = long + "\n" + FAIL_LINE;
    const badLong: ParsedReceipt = {
      source_sha256: createHash("sha256").update(raw3, "utf8").digest("hex"),
      uncertain: false,
      summary: "s",
      evidence: [{ quote: long }],
    };
    expect(V(badLong, raw3).violations.some((x) => x.includes("outside 1.."))).toBe(true);
  });

  it("gate 5: washing a failure clean voids (missing-failure-evidence)", () => {
    const washed = { ...honestReceipt(), evidence: [{ quote: PASS_LINE }] };
    const { violations } = V(washed);
    expect(violations.some((x) => x.includes("missing failure evidence"))).toBe(true);
    // The raw log's own failure markers alone (exit 0 observed) also bite:
    expect(V(washed, BIG_LOG, false).violations.some((x) => x.includes("missing failure evidence"))).toBe(true);
  });

  it("gate 5 negative: a genuinely clean passing log needs no failure quote", () => {
    const clean = buildLog(1200, -1); // no failure line at all
    const ok: ParsedReceipt = {
      source_sha256: createHash("sha256").update(clean, "utf8").digest("hex"),
      uncertain: false,
      summary: "全部通过。",
      evidence: [{ quote: "ok 1 - component renders without warnings" }],
    };
    expect(verifyReceipt({ receipt: ok, raw: clean, observedFailed: false }).violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the orchestrator — fail-open shapes + zero-call pre-screens
// ---------------------------------------------------------------------------

describe("slimToolLog — fail-open 编排", () => {
  it("an honest receipt passes end-to-end and saves context", async () => {
    const r = reducer(JSON.stringify(honestReceipt()), "deepseek-v4-flash");
    const out = await slimToolLog({ ...SLIM_ARGS, model: r.model, config: TINY_CONFIG });
    expect(out.kind).toBe("receipt");
    if (out.kind === "receipt") {
      expect(out.savedChars).toBeGreaterThan(10_000);
      expect(out.body).toContain("[epr:1]");
      expect(out.body).toContain("pnpm test");
      expect(out.body).toContain("/tmp/.wudao/spill/s1/abc.txt");
      expect(out.body).toContain("deepseek-v4-flash");
      expect(out.body).toContain("L600");
      expect(out.body).not.toContain("[exit"); // exit label is the shell seam's ground truth, not the receipt's
    }
  });

  it("every forged receipt falls back — the main model never sees it", async () => {
    const forgeries = [
      JSON.stringify({ ...honestReceipt(), source_sha256: "0".repeat(64) }),
      JSON.stringify({ ...honestReceipt(), evidence: [{ quote: "made up line that never ran" }] }),
      JSON.stringify({ ...honestReceipt(), evidence: [{ quote: PASS_LINE }] }),
      "not json at all",
      JSON.stringify({ ...honestReceipt(), status: "pass" }),
    ];
    for (const reply of forgeries) {
      const r = reducer(reply);
      const out = await slimToolLog({ ...SLIM_ARGS, model: r.model, config: TINY_CONFIG });
      expect(out.kind, reply.slice(0, 60)).toBe("fallback");
    }
  });

  it("pre-screens make NO model call: non-diagnostic / under / over / secret", async () => {
    const secret = `sk-${"a".repeat(30)} appeared in the log\n` + BIG_LOG;
    const cases: Array<Parameters<typeof slimToolLog>[0] & { why: string }> = [
      { ...SLIM_ARGS, command: "cat notes.txt", why: "non-diagnostic" },
      { ...SLIM_ARGS, raw: "tiny", why: "under threshold" },
      { ...SLIM_ARGS, raw: "x".repeat(100_001), why: "over max" },
      { ...SLIM_ARGS, raw: secret, why: "secret-shaped" },
    ];
    for (const c of cases) {
      const r = reducer(JSON.stringify(honestReceipt()));
      const out = await slimToolLog({ ...c, model: r.model, config: TINY_CONFIG });
      expect(out.kind, c.why).toBe("fallback");
      expect(r.calls(), c.why).toBe(0); // 零模型调用——预筛先于任何网络
    }
  });

  it("model errors and timeouts fall back (never throw)", async () => {
    const failing: ModelClient = { async generate(): Promise<AssistantMessage> { throw new Error("boom"); } };
    const out1 = await slimToolLog({ ...SLIM_ARGS, model: failing, config: TINY_CONFIG });
    expect(out1.kind).toBe("fallback");
    const slow: ModelClient = { async generate(): Promise<AssistantMessage> { await new Promise((r) => setTimeout(r, 50)); return { role: "assistant", content: JSON.stringify(honestReceipt()) }; } };
    const out2 = await slimToolLog({ ...SLIM_ARGS, model: slow, config: { ...TINY_CONFIG, timeoutMs: 5 } });
    expect(out2.kind).toBe("fallback");
  });

  it("receipt-not-smaller: a receipt as big as the log falls back", async () => {
    // A summary near the cap + 12 distinct quotes can exceed a raw just over
    // the min threshold — the rendered size gate must bite. Failure line at
    // 20 so quotes ok-1..ok-11 precede it in order.
    const raw = buildLog(24, 20);
    const receipt: ParsedReceipt = {
      source_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      uncertain: false,
      summary: "很".repeat(2_000),
      evidence: [
        ...Array.from({ length: 11 }, (_, i) => ({ quote: `ok ${i + 1} - component renders without warnings` })),
        { quote: FAIL_LINE },
      ],
    };
    const r = reducer(JSON.stringify(receipt));
    const out = await slimToolLog({ ...SLIM_ARGS, raw, model: r.model, config: TINY_CONFIG });
    expect(out.kind).toBe("fallback");
    if (out.kind === "fallback") expect(out.reason).toContain("receipt-not-smaller");
  });

  it("the reducer request rides its own prefix + completion cap + usage capture", async () => {
    const r = reducer(JSON.stringify(honestReceipt()));
    await slimToolLog({ ...SLIM_ARGS, model: r.model, config: TINY_CONFIG });
    expect(r.inputs).toHaveLength(1);
    const input = r.inputs[0]!;
    expect(input.systemPrompt).toBe(LOG_SLIMMING_SYSTEM_PROMPT); // 字节稳定的前缀
    expect(input.tools).toEqual([]);
    expect(input.maxTokens).toBe(2048);
    expect(input.messages[0]!.content).toContain(BIG_LOG_SHA);
    expect(input.messages[0]!.content).toContain(BIG_LOG);
  });
});

// ---------------------------------------------------------------------------
// the shell seam — receipt replaces the preview; fallback bytes unchanged
// ---------------------------------------------------------------------------

describe("shell seam — 回执替换与字节不变 fallback", () => {
  /** The seam's command: `make` is the diagnostic keyword (bare make matches
   *  the classifier; `-n -f /dev/null` is inert), then a node one-liner
   *  emits the big log on stdout. Output is deterministic on one machine,
   *  which is all the byte-identity comparison needs (both runs back-to-back
   *  in this same test). */
  const SEAM_COMMAND = `make -n -f /dev/null; node -e 'const l=${JSON.stringify(BIG_LOG)}; process.stdout.write(l)'`;
  const LONG_OUTPUT = { lineThreshold: 200, byteThreshold: 10_000, headLines: 50, tailLines: 50 };

  /** A DYNAMIC honest reducer: computes the receipt from the prompt it is
   *  actually given (the raw rides the user prompt), so the test never has
   *  to predict the seam's combined stdout+stderr bytes. */
  function honestDynamicReducer(modelId: string): ModelClient {
    return {
      modelId,
      async generate(input: ModelInput): Promise<AssistantMessage> {
        const prompt = input.messages[0]!.content as string;
        const marker = "\n\n";
        const raw = prompt.slice(prompt.indexOf(marker) + marker.length);
        const sha = createHash("sha256").update(raw, "utf8").digest("hex");
        return {
          role: "assistant",
          content: JSON.stringify({
            source_sha256: sha,
            uncertain: false,
            summary: "第 600 行一处测试失败，其余行通过。",
            evidence: [{ quote: FAIL_LINE }, { quote: LAST_LINE }],
          }),
        };
      },
    };
  }

  it("fallback flows through the EXACT M46 shaping (same bytes as slimming-off)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(tmpdir() + "/wudao-slim2-");
    try {
      // ONE dir for both runs: the spill PATH rides the shaped result, and
      // the spill file name is the content hash — same output, same name.
      const runOnce = async (slimming: undefined | { model: ModelClient }): Promise<string> => {
        const tool = createShellTool({
          workspaceRoot: dir,
          spillDir: dir,
          longOutput: LONG_OUTPUT,
          ...(slimming !== undefined ? { logSlimming: slimming } : {}),
        });
        const res = await tool.execute({ command: SEAM_COMMAND });
        return res.content;
      };
      const broken: ModelClient = { async generate(): Promise<AssistantMessage> { throw new Error("down"); } };
      const off = await runOnce(undefined);
      const fb = await runOnce({ model: broken });
      expect(fb).toBe(off); // fail-open = 字节相同
      expect(off).toContain("[shaped h50/t50"); // it really is the M46 path
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("a passing receipt replaces the shaped preview in the tool result", async () => {
    const { mkdtemp, rm, readdir, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(tmpdir() + "/wudao-slim3-");
    try {
      const decisions: Array<{ outcome: string; reason?: string; savedChars?: number }> = [];
      const tool = createShellTool({
        workspaceRoot: dir,
        spillDir: dir,
        longOutput: LONG_OUTPUT,
        logSlimming: {
          model: honestDynamicReducer("glm-flash-test"),
          config: TINY_CONFIG,
          onDecision: (d) => decisions.push(d),
        },
      });
      const res = await tool.execute({ command: SEAM_COMMAND });
      expect(res.content).toContain("[epr:1]");
      expect(res.content).toContain("[exit 0]"); // harness-owned exit ground truth (node exits 0)
      expect(res.content).not.toContain("[shaped h50/t50");
      expect(res.content).toContain("L600"); // harness-computed line number for FAIL_LINE
      expect(res.content).toContain(dir); // the archive path is inside the spill dir
      // The archive really holds the FULL raw bytes (evidence preservation).
      const spilled = (await readdir(dir)).filter((f) => f.endsWith(".txt"));
      expect(spilled.length).toBeGreaterThanOrEqual(1);
      const archived = await readFile(`${dir}/${spilled[0]}`, "utf8");
      expect(archived).toContain(FAIL_LINE);
      expect(archived.length).toBeGreaterThan(50_000);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.outcome).toBe("receipt");
      expect(decisions[0]!.savedChars).toBeGreaterThan(10_000);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
