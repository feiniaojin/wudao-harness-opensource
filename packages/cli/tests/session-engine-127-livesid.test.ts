// 127 项 4（F5，审计缺口 E）— 引擎 live-sid 盒：session-engine 的
// notes / historySearch / sessionResult 三个会话锚定工具缝从 const 绑定
// boot id 改为晚绑盒（effortLiveBox/replSidLive 同款纪律）。行为钉：
// 主线进程内 continueSession 采纳另一个会话后（resume→setSessionId 轮换），
// 续跑 run 里的 note_write 落在被采纳会话的 notes 目录、search_history 搜
// 被采纳会话的账本（修复前两者都还读 boot 会话——续跑的模型看不到刚恢复
// 会话的 notes/历史）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao-org/core";
import type { AgentMessage, ModelClient, ModelInput } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-f5" };

const BOOT_SID = "wudao-f5boot01";
const OTHER_SID = "wudao-f5other1";
const ANCHOR = "the-other-ledger-anchor-7731";

const sessions: DriverSession[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** Records every ModelInput (the observer for the search_history result). */
function recordingModel(responses: readonly AgentMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inner = createScriptedModel([...responses]);
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async generate(input: ModelInput): Promise<AgentMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      return inner.generate(input);
    },
  };
}

const noteFiles = (ws: string, sid: string): string[] => {
  const dir = join(ws, ".wudao", "notes", sid);
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe("F5 — the engine's live-sid box (notes / historySearch / sessionResult)", () => {
  it("after continueSession adopts another session, note_write lands in ITS notes dir and search_history searches ITS ledger", async () => {
    const ws = mkdtempSync(join(tmpdir(), "f5-livesid-"));
    roots.push(ws);
    // The OTHER session: one user line = an unfinished tail (continueSession's
    // adoption gate), carrying the search anchor only ITS ledger contains.
    mkdirSync(join(ws, ".wudao", "sessions"), { recursive: true });
    writeFileSync(
      join(ws, ".wudao", "sessions", `${OTHER_SID}.jsonl`),
      `${JSON.stringify({ role: "user", content: `please continue the work on ${ANCHOR}` })}\n`,
      "utf8",
    );

    const model = recordingModel([
      // Phase 1 (the boot run): one note write in the BOOT session.
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "note_write", arguments: { content: "f5 boot note" } }] },
      { role: "assistant", content: "boot done" },
      // Phase 2 (the CONTINUED run on the adopted session): a note write AND a
      // ledger search — both session-anchored seams in ONE turn.
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c2", name: "note_write", arguments: { content: "f5 other note" } },
          { id: "c3", name: "search_history", arguments: { query: ANCHOR } },
        ],
      },
      { role: "assistant", content: "other done" },
    ]);
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: model,
      sessionId: BOOT_SID,
      autoTitle: false, // no side-calls eating the scripted responses
      defaultPermissionMode: "auto", // note_write is ask-tier in workspace mode — bypass it
    });
    sessions.push(session);

    // Phase 1: the boot run writes a note under the BOOT session's dir.
    session.driver.submit("boot question");
    await until(() => session.driver.getStatus().busy === false, "boot run settles");
    expect(noteFiles(ws, BOOT_SID)).toHaveLength(1);
    expect(noteFiles(ws, OTHER_SID)).toHaveLength(0);

    // Phase 2: adopt OTHER in-process (resume → setSessionId → the live-sid
    // box rotates) and continue ITS unfinished tail.
    const outcome = await session.driver.continueSession(OTHER_SID);
    expect(outcome.started).toBe(true);
    await until(() => session.driver.getStatus().busy === false, "continued run settles");

    // THE F5 PIN — the note of the continued run landed in the ADOPTED
    // session's directory (pre-fix: boot's dir got a second file instead).
    expect(noteFiles(ws, OTHER_SID)).toHaveLength(1);
    expect(readFileSync(join(ws, ".wudao", "notes", OTHER_SID, noteFiles(ws, OTHER_SID)[0]!), "utf8")).toContain("f5 other note");
    expect(noteFiles(ws, BOOT_SID)).toHaveLength(1); // the boot note untouched

    // THE F5 PIN #2 — search_history scanned the ADOPTED session's ledger: the
    // tool result feeding the final model call carries the anchor snippet.
    const lastInput = model.inputs[model.inputs.length - 1]!;
    const toolResults = lastInput.messages
      .filter((m): m is Extract<typeof m, { role: "tool" }> => m.role === "tool")
      .map((m) => JSON.stringify(m));
    expect(toolResults.some((t) => t.includes(ANCHOR))).toBe(true);
    // And the continued run really rode the ADOPTED conversation (the model
    // saw OTHER's tail, not the boot chat).
    expect(
      model.inputs.some((i) => i.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(ANCHOR))),
    ).toBe(true);
  });
});
