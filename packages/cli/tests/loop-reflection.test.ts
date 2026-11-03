// ω-4b CLI wiring — the driver/REPL/one-shot surfaces of the loop-safety
// reflection fork: the loop_reflection session entry (built + persisted +
// resume-filtered), the --no-loop-reflection kill switch, and the usage-row
// guard (a side verdict never moves the ctx watermark; /cost still counts
// the real spend). Deterministic: scripted models, no network.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore, buildTool, isFormatMarker } from "@wudao-org/core";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput, ModelUsage, Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { buildLoopReflectionEntry, LOOP_REFLECTION_TYPE } from "../src/session-entry.js";
import { appendSessionEntry } from "../src/session-entry.js";
import { isFeatureAblated, ablationEnvVar } from "../src/args.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

afterEach(() => {
  delete process.env[ablationEnvVar("loop-reflection")];
});

const CHALLENGER_PREFIX = "[loop-safety challenger]";

const isChallengerInput = (input: ModelInput): boolean => {
  const last = input.messages.at(-1);
  return last !== undefined && last.role === "user" && last.content.startsWith(CHALLENGER_PREFIX);
};

/** Scripted model that records inputs, loops on one call to a 2nd verdict,
 *  and routes the challenger deterministically. */
function loopingModel(opts: {
  turns?: number;
  challenger: AssistantMessage | ((input: ModelInput) => Promise<AssistantMessage>);
  challengerUsage?: ModelUsage;
  regularUsage?: ModelUsage;
}): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  const turns = opts.turns ?? 6;
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      if (isChallengerInput(input)) {
        if (opts.challengerUsage !== undefined) input.onUsage?.(opts.challengerUsage);
        return typeof opts.challenger === "function" ? opts.challenger(input) : opts.challenger;
      }
      if (opts.regularUsage !== undefined) input.onUsage?.(opts.regularUsage);
      const r: AssistantMessage = i < turns
        ? { role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "echo", arguments: { text: "same" } }] }
        : { role: "assistant", content: "done" };
      i += 1;
      return r;
    },
  };
}

function echoTool(): Tool {
  return buildTool({
    name: "echo",
    description: "echoes its arg",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    execute: async (args) => ({ content: `echo: ${String((args as { text?: string }).text ?? "")}` }),
  });
}

const allow = async () => ({ behavior: "allow" as const });
const RECOVERABLE = "VERDICT: recoverable\nDIRECTIVE: read the file before editing — the old_string no longer matches.";

// ---------------------------------------------------------------------------
// (10) the loop_reflection session entry
// ---------------------------------------------------------------------------

describe("ω-4b loop_reflection session entry", () => {
  it("a reflection_fork event during a driver run fires onLoopReflection once with the full shape", async () => {
    const model = loopingModel({ challenger: { role: "assistant", content: RECOVERABLE } });
    const calls: { kind: string; outcome: string; directive?: string; turn: number }[] = [];
    const driver = createAgentDriver({
      model,
      tools: [echoTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      canUseTool: allow,
      onLoopReflection: (info) => {
        calls.push({ kind: info.kind, outcome: info.outcome, directive: info.directive, turn: info.turn });
      },
    });
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.dispose();

    expect(model.inputs.filter(isChallengerInput)).toHaveLength(1); // the fork ran
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("identical_calls");
    expect(calls[0]?.outcome).toBe("recoverable");
    expect(calls[0]?.directive).toContain("read the file before editing");
    expect(typeof calls[0]?.turn).toBe("number");
  });

  it("the entry round-trips the JSONL: loadSessionEntries returns it, load() filters it from the model-visible history", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-looprefl-"));
    try {
      const store = createJsonlSessionStore(join(root, "sessions"));
      const entry = buildLoopReflectionEntry({
        kind: "edit_repeat",
        evidence: 'edit a.ts old_string="needle" failed ×3',
        outcome: "stuck",
        rationale: "no realistic change of approach remains",
        turn: 7,
        // As delivered by the core fork observer: the row arrives stamped
        // (reflectionTokens = prompt + completion).
        usage: { promptTokens: 100, cacheHitTokens: 90, cacheMissTokens: 10, completionTokens: 20, reflectionTokens: 120 },
      });
      await appendSessionEntry(store, "sess1", entry);
      await store.append("sess1", { role: "user", content: "after" });

      const entries = await store.loadSessionEntries("sess1");
      const loopEntries = entries.filter((e) => !("role" in e) && e.type === LOOP_REFLECTION_TYPE);
      expect(loopEntries).toHaveLength(1);
      const data = (loopEntries[0] as { data: Record<string, unknown> }).data;
      expect(data["kind"]).toBe("edit_repeat");
      expect(data["outcome"]).toBe("stuck");
      expect(data["directive"]).toBeUndefined();
      expect(data["turn"]).toBe(7);
      const usage = data["usage"] as Record<string, unknown> | undefined;
      expect(usage?.["reflectionTokens"]).toBe(120);

      const visible: AgentMessage[] = await store.load("sess1");
      expect(visible).toEqual([{ role: "user", content: "after" }]); // filtered, audit-only

      // The JSONL line is exactly one well-formed generic entry. ω99-47: line 1
      // may be the transport-framing format marker — strip it the same way the
      // store's read views do (isFormatMarker), so this raw-line pin counts
      // DATA lines only.
      const lines = (await readFile(join(root, "sessions", "sess1.jsonl"), "utf8")).trim().split("\n");
      const raw = lines[0] !== undefined && isFormatMarker(JSON.parse(lines[0])) ? lines.slice(1) : lines;
      expect(raw).toHaveLength(2);
      expect(JSON.parse(raw[0]!).type).toBe(LOOP_REFLECTION_TYPE);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("omitted fields stay omitted (no null backfill); recoverable carries the directive", () => {
    const entry = buildLoopReflectionEntry({
      kind: "failure_streak",
      evidence: "probe failed ×4 consecutively (args vary)",
      outcome: "recoverable",
      directive: "inspect the probe fixture before retrying",
      turn: 3,
    });
    const data = entry.data as Record<string, unknown>;
    expect(data["rationale"]).toBeUndefined();
    expect(data["usage"]).toBeUndefined();
    expect(data["directive"]).toBe("inspect the probe fixture before retrying");
  });
});

// ---------------------------------------------------------------------------
// (11) the kill switch
// ---------------------------------------------------------------------------

describe("ω-4b --no-loop-reflection kill switch", () => {
  it("WUDAO_NO_LOOP_REFLECTION=1 → the second verdict aborts with NO challenger call and NO entry seam", async () => {
    expect(isFeatureAblated("loop-reflection")).toBe(false); // the env name wires up
    process.env[ablationEnvVar("loop-reflection")] = "1";
    expect(isFeatureAblated("loop-reflection")).toBe(true);

    const model = loopingModel({ challenger: { role: "assistant", content: RECOVERABLE } });
    let seamFired = false;
    const driver = createAgentDriver({
      model,
      tools: [echoTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      canUseTool: allow,
      onLoopReflection: () => { seamFired = true; },
    });
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.dispose();

    expect(model.inputs.filter(isChallengerInput)).toHaveLength(0);
    expect(seamFired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (12) the usage-row guard: watermark frozen, /cost counts the spend
// ---------------------------------------------------------------------------

describe("ω-4b reflection usage row (watermark guard + /cost fold)", () => {
  it("the ctx watermark reflects the answering rows only; /cost folds the fork's call too", async () => {
    const model = loopingModel({
      challenger: { role: "assistant", content: "VERDICT: stuck — no path remains" },
      regularUsage: { promptTokens: 5_000, cacheHitTokens: 4_000, cacheMissTokens: 1_000 },
      challengerUsage: { promptTokens: 7_000, cacheHitTokens: 6_500, cacheMissTokens: 500, completionTokens: 100 },
    });
    const driver = createAgentDriver({
      model,
      tools: [echoTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      canUseTool: allow,
    });
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");

    // The side verdict's 7000-token prompt never anchors occupancy.
    expect(driver.getStatus().ctxTokens).toEqual({ used: 5_000, window: 64_000, nearLimit: false });

    // /cost still counts the real spend: 6 answering calls + 1 fork row.
    driver.submit("/cost");
    await until(
      () => driver.getHistory().some((h) => h.kind === "notice" && h.text.includes("模型调用：")),
      "cost report",
    ); // ω99-187: 钉随源演进（brief 未列——red 兜出同弧演进）
    const report = driver.getHistory().find((h) => h.kind === "notice" && h.text.includes("模型调用："))?.text ?? "";
    expect(report).toContain("模型调用：7"); // 6 answering rows + the fork's row // ω99-187: 钉随源演进（brief 未列）
    driver.dispose();
  });
});
