// ω99-38 — TUI /clear 走 routed 轮换（同病收编）。brief §0 的三层危害全部
// 源于 TUI 的私搭轮换路径：app.tsx performClear 调公共 driver.clear()（仅
// clearConversation——不转 id、不写边界、不通知）+ TUI 本地自转 id。两枚红例
// 钉住改道（performClear → submit("/clear")，M80 routed 轮换面接管）后必须
// 成立的契约：
//   ① wrapper：/clear 后首调报 ONE `ℹ️ expected: session-rotation (cold
//      start)`、零 ⚠️（ω99-34 同病——TUI 自建 cache wrapper 的
//      prevSerialized/prevPromptTokens 残留把新会话首调误判为 turn-0 断裂）；
//   ② 持久化：旧 id 的 JSONL 恰一条 clear_boundary 指向新 id，新 id 的
//      JSONL 只装 post-clear 对话（ω99-32 语义在 TUI 路径缺席——轮换在
//      史里不可见，resume/考古断链）。
// 形状复刻 ω99-34 的 campaign：onSessionStart 钩子回一段 additionalContext，
// 轮换后首个请求 = [user, user-note]（length > 1），ω99-28 T3 的 length===1
// 冷启动档够不着——这正是 campaign :1709 报 ⚠️ turn-0 的形状。
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, ModelUsage, Tool } from "@wudao/core";
import { buildTool } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { WudaoApp } from "../src/tui/app.js";

const wait = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o99-38: timed out waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

const U = (promptTokens: number, hit: number): ModelUsage =>
  ({ promptTokens, cacheHitTokens: hit, cacheMissTokens: promptTokens - hit });

/** ω99-34 fakeModel 的 TUI 形状：modelOverride 会被 App 的 wrapTracked 包上
 * cache wrapper，generate 里回报的 usage 行喂进 wrapper 的观察链。 */
function usageScriptModel(rows: readonly ModelUsage[]): ModelClient {
  let i = 0;
  return {
    async generate(input: ModelInput) {
      const row = rows[i];
      i += 1;
      if (row) input.onUsage?.(row);
      return { role: "assistant", content: `answer-${i}` };
    },
  };
}

/** 一轮完整驱动：round one（settled 基线）→ 确认 /clear → round two（轮换后的
 * 冷启动尖峰）。返回未卸载的 ink 实例（调用方读 frame 后自行 unmount）。 */
async function driveClear(o: { readonly ws: string; readonly sid: string; readonly model: ModelClient }) {
  const inst = render(
    <WudaoApp
      config={config}
      workspaceRoot={o.ws}
      contextWindowTokens={64000}
      modelOverride={o.model}
      tools={[]}
      sessionId={o.sid}
      hooks={{ onSessionStart: async () => "You have superpowers. Below is the full content of your skills." }}
    />,
  );
  await wait();
  await type(inst.stdin, "first round\r");
  await until(() => (inst.lastFrame() ?? "").includes("answer-1"), "round one settles");
  await type(inst.stdin, "/clear\r");
  // ω99-159: 确认框文案中文化——等待串随源演进。
  await until(() => (inst.lastFrame() ?? "").includes("🗑 清空历史——开一个全新会话？"), "confirm prompt");
  await wait();
  inst.stdin.write("y");
  // ω99-161: 清空回执串随源演进（等待语义不变）。
  await until(() => (inst.lastFrame() ?? "").includes("(历史已清空——开启全新会话)"), "cleared notice");
  await type(inst.stdin, "second round\r");
  await until(() => (inst.lastFrame() ?? "").includes("answer-2"), "round two settles");
  await wait(50);
  return inst;
}

const rmWs = (ws: string): void => {
  for (let i = 0; i < 10; i += 1) {
    try { rmSync(ws, { recursive: true, force: true }); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e; }
  }
};

// T2 ④: the busy refusal is the FRONTEND's own guard (app.tsx intercepts
// /clear BEFORE any submit) — the routed re-path must leave it byte-identical.
describe("ω99-38 T2 ④ — the busy /clear refusal is unchanged", () => {
  it("a run in flight refuses /clear with the same receipt and never opens the confirm", async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "o9938-busy-")));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const gatedEdit = buildTool({
      name: "edit",
      description: "gated edit",
      parameters: {
        type: "object" as const,
        properties: { path: { type: "string" as const }, old_string: { type: "string" as const }, new_string: { type: "string" as const } },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false,
      },
      execute: async () => { await gate; return { content: "ok" }; },
    });
    const scriptable: ModelClient = {
      async generate(input: ModelInput) {
        input.onUsage?.(U(600, 550));
        return { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "edit", arguments: { path: "a.ts", old_string: "x", new_string: "y" } }] };
      },
    };
    const inst = render(
      <WudaoApp config={config} workspaceRoot={ws} contextWindowTokens={64000} modelOverride={scriptable} tools={[gatedEdit as Tool]} sessionId="wudao-o9938busy" gates={{ verify: false }} />,
    );
    try {
      await wait();
      await type(inst.stdin, "go\r");
      await until(() => (inst.lastFrame() ?? "").includes("edit"), "tool phase");
      await type(inst.stdin, "/clear\r");
      await until(() => (inst.lastFrame() ?? "").includes("⚠️ 运行中无法 /clear"), "the busy refusal receipt"); // ω99-166c-iv: 帧钉演进=源面逐字（app.tsx :1904 中文化）。
      // ω99-159: 确认框文案中文化——not.toContain 断言串随源演进。
      expect(inst.lastFrame() ?? "").not.toContain("🗑 清空历史——开一个全新会话？");
      release?.();
      await until(() => (inst.lastFrame() ?? "").includes("⚠️ 已中断") || (inst.lastFrame() ?? "").split("edit").length > 2, "run to finish"); // ω99-166c-ii: 帧钉演进=源面逐字。
    } finally {
      release?.();
      inst.unmount();
      rmWs(ws);
    }
  }, 30_000);
});

describe("ω99-38 T1/T2 — TUI /clear rides the routed rotation", () => {
  it("① the post-/clear first call names the rotation: ONE ℹ️ session-rotation line, zero ⚠️", async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "o9938-rot-")));
    const model = usageScriptModel([
      U(13100, 12900), // round one — miss 100（settled 基线）
      U(13100, 6400), // round two — miss 6700（51.1%）：轮换冷启动尖峰
    ]);
    const inst = await driveClear({ ws, sid: "wudao-o9938rot", model });
    try {
      const frame = inst.lastFrame() ?? "";
      // RED pre-fix: `⚠️ cache break at user message (turn 0) — miss 6.7k/13.1k (51.1%)`
      expect(frame).not.toContain("⚠️ cache break");
      expect(frame.match(/ℹ️ expected: session-rotation \(cold start\)/g)).toHaveLength(1);
      expect(frame).toContain("ℹ️ expected: session-rotation (cold start) — miss 6.7k/13.1k (51.1%)");
    } finally {
      inst.unmount();
      rmWs(ws);
    }
  }, 30_000);

  it("② the old id's JSONL is sealed by exactly one clear_boundary naming the fresh segment", async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "o9938-seal-")));
    const model = usageScriptModel([U(13100, 12900), U(600, 550)]);
    const SID = "wudao-o9938seal";
    const inst = await driveClear({ ws, sid: SID, model });
    type Entry = { readonly type?: string; readonly role?: string; readonly content?: string; readonly data?: { readonly nextSessionId?: string } };
    const readJsonl = (sid: string): readonly Entry[] =>
      readFileSync(join(ws, ".wudao", "sessions", `${sid}.jsonl`), "utf8").split("\n")
        .filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Entry);
    try {
      const oldFile = join(ws, ".wudao", "sessions", `${SID}.jsonl`);
      // RED pre-fix: TUI /clear 从不写 clear_boundary（轮换在 JSONL 史里不可见）。
      await until(() => existsSync(oldFile) && readJsonl(SID).some((e) => e.type === "clear_boundary"), "the old id's clear_boundary", 5000);
      const oldEntries = readJsonl(SID);
      const boundaries = oldEntries.filter((e) => e.type === "clear_boundary");
      expect(boundaries).toHaveLength(1);
      const next = boundaries[0]!.data?.nextSessionId;
      expect(next).toBeDefined();
      expect(next).not.toBe(SID);
      // 旧段保留 round one——且只有 round one（post-clear 轮不得回流旧段）。
      const oldMsgs = oldEntries.filter((e): e is { role: string; content: string } => typeof e.role === "string");
      expect(oldMsgs.map((m) => m.content)).toEqual(["first round", "answer-1"]);
      // 新段承载 round two——boundary 指到的正是它。
      const newFile = join(ws, ".wudao", "sessions", `${next}.jsonl`);
      await until(() => existsSync(newFile) && readJsonl(next).some((e) => e.content === "second round"), "round two on the fresh segment", 5000);
      const newMsgs = readJsonl(next).filter((e): e is { role: string; content: string } => typeof e.role === "string");
      expect(newMsgs.map((m) => m.content)).toEqual(["second round", "answer-2"]);
      expect(readJsonl(next).some((e) => e.type === "clear_boundary")).toBe(false);
    } finally {
      inst.unmount();
      rmWs(ws);
    }
  }, 30_000);
});
