// det-63-night-porting-6 — the deterministic behavior pins for 夜移 017
// (候选 #31: 首调前持久 user — crash-safety for the prompt). The feature
// landed with cli unit tests (tests/user-turn-persist.test.tsx, 4 contracts
// incl. the full ink TUI render); this suite pays the det-44-style debt the
// same way det-57..det-62 did — the behavior pinned inside the release-eval
// matrix, so a regression fails the release evals, not just a package test
// someone might not run. Zero network, zero real-home reads.
//
//   ① seam timing    onUserTurn fires synchronously at run start, before
//                    the hanging model's first call resolves;
//   ② seam identity  the fired object is the SAME reference onRunComplete
//                    walks (the loadedRef dedup key — no duplicate line);
//   ③ transients     forced language + reasoning tails never fire it;
//   ④ mid-run disk   through createDriverSession with the model hanging,
//                    the user line is ALREADY on the session JSONL;
//   ⑤ exactly once   after settle, the user prompt appears exactly once.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import { createDriverSession } from "wudao-harness/driver/session-engine";
import { summarizeToolCall } from "wudao-harness/log";
import type { ProviderConfig } from "@wudao/providers";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import type { EvalDefinition } from "../runner.js";

export interface NightPorting6Evidence {
  // ① seam timing
  readonly firedBeforeSettle: boolean;
  // ② seam identity
  readonly identityInCompleted: boolean;
  // ③ transients
  readonly transientFireCount: number;
  // ④ mid-run disk
  readonly onDiskMidRun: boolean;
  readonly modelStillHanging: boolean;
  // ⑤ exactly once
  readonly userLineCount: number;
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

/** A model whose every generate() hangs until release() — the mid-run crash
 *  window stand-in. */
function gatedModel(): ModelClient & { calls: number; release: () => void } {
  let calls = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  return {
    get calls() { return calls; },
    release: () => open(),
    async generate(_input: ModelInput): Promise<AssistantMessage> {
      calls += 1;
      await gate;
      return { role: "assistant", content: "late answer", stopReason: "end_turn" };
    },
  };
}

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  await wait();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await wait();
  }
  return true;
}

const userLineCountIn = (path: string, content: string): number => {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => {
      if (l.trim() === "") return false;
      try {
        const m = JSON.parse(l) as AgentMessage;
        return m.role === "user" && m.content === content;
      } catch { return false; }
    }).length;
  } catch { return 0; }
};

export const det63Eval: EvalDefinition<Record<string, never>, NightPorting6Evidence> = {
  name: "det-63-night-porting-6",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run() {
    // ①+②+③ the driver seam.
    const model = gatedModel();
    const seen: AgentMessage[] = [];
    const completed: AgentMessage[][] = [];
    const driver = createAgentDriver({
      systemPrompt: "s",
      summarize: summarizeToolCall,
      model,
      tools: [],
      languageBlock: "on",
      reasoningLanguage: "zh",
      onUserTurn: (m) => seen.push(m),
      onRunComplete: (ms) => completed.push([...ms]),
    });
    driver.submit("precious prompt");
    const firedBeforeSettle = await until(() => model.calls === 1) && seen.length === 1
      && seen[0]!.content === "precious prompt";
    model.release();
    await until(() => completed.length === 1);
    const identityInCompleted = completed[0]?.includes(seen[0]!) === true;
    // Language mode "on" + reasoning "zh" pushed THREE user messages into
    // state (turn + both tails) — the seam fired exactly once regardless.
    const transientFireCount = seen.length;
    driver.dispose();

    // ④+⑤ the engine wiring: mid-run visibility + exactly-once on disk.
    const ws = mkdtempSync(join(tmpdir(), "det63-night6-"));
    const sessionId = "wudao-det63-night6";
    const engineModel = gatedModel();
    let onDiskMidRun = false;
    let modelStillHanging = false;
    let count = -1;
    try {
      const session = await createDriverSession({
        config,
        workspaceRoot: ws,
        contextWindowTokens: 64_000,
        modelOverride: engineModel,
        tools: [],
        sessionId,
      });
      session.driver.submit("mid-run crash window");
      const file = join(ws, ".wudao", "sessions", `${sessionId}.jsonl`);
      onDiskMidRun = await until(() => {
        try { return readFileSync(file, "utf8").includes("mid-run crash window"); } catch { return false; }
      });
      modelStillHanging = onDiskMidRun && engineModel.calls >= 1;
      engineModel.release();
      await until(() => session.driver.getStatus().busy === false);
      await until(() => {
        try { return readFileSync(file, "utf8").includes("late answer"); } catch { return false; }
      });
      count = userLineCountIn(file, "mid-run crash window");
      await session.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }

    return {
      firedBeforeSettle,
      identityInCompleted,
      transientFireCount,
      onDiskMidRun,
      modelStillHanging,
      userLineCount: count,
    };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.firedBeforeSettle, `① onUserTurn must fire before the first model call settles (got ${String(e.firedBeforeSettle)})`);
    need(e.identityInCompleted, "② the fired object must be identity-present in onRunComplete's messages (the dedup key)");
    need(e.transientFireCount === 1, `③ language/reasoning transient tails must never fire the seam (fired ${String(e.transientFireCount)}×)`);
    need(e.onDiskMidRun, "④ the user line must be on the session JSONL while the model is still hanging");
    need(e.modelStillHanging, "④ the mid-run read must happen inside the crash window (model still gated)");
    need(e.userLineCount === 1, `⑤ the user prompt appears exactly once after settle (got ${String(e.userLineCount)})`);

    return errs;
  },
};
