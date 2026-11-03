// 138 — 根切换的会话继承（2026-11-03 用户报障：切了工作目录后「从这里岔开」，
// 新会话的 agent 仍跑在 ~/.wudao-desktop/workspace）。
// 病灶：applyAgentRoot 只投了一条 <workspace_changed> MetaNote——投影通道
// 永不落盘（M24），resume 扫消息链找它必然零命中 → 岔轮/恢复回落 boot 根。
// 修法：切换落 agent_root 会话条目（append-only JSONL，压缩不碰），resume
// 重放最后一条；两变量一起齐（agentRootBox 喂工具，agentWorkspaceRoot 是
// driver 自读面——旧代码只齐 box）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao-org/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

const wait = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

describe("138 — agent 根切换的会话继承", () => {
  it("agentRootSwitch 落 agent_root 条目；新 driver resume 同一会话继承新根", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-root-persist-"));
    mkdirSync(join(root, ".wudao", "sessions"), { recursive: true });
    const newRoot = await mkdtemp(join(tmpdir(), "wudao-root-target-"));

    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const a = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools: [], workspaceRoot: root });
    a.submit("go");
    await until(() => a.getHistory().some((e) => e.kind === "assistant" && (e as { text?: string }).text === "ok"), "run settled");
    const sid = a.getSessionId();

    const r = await a.agentRootSwitch(newRoot);
    expect(r).toEqual({ applied: true, queued: false });
    await until(() => existsSync(join(root, ".wudao", "sessions", `${sid}.jsonl`)), "session file");
    await wait(50); // 条目写入是 fire-and-forget
    const jsonl = readFileSync(join(root, ".wudao", "sessions", `${sid}.jsonl`), "utf8");
    expect(jsonl).toContain(`"type":"agent_root"`);
    expect(jsonl).toContain(newRoot);
    a.dispose();

    // 新 driver（同工作区）恢复该会话 → 根随行。
    const b = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model: createScriptedModel([{ role: "assistant", content: "again" }]), tools: [], workspaceRoot: root });
    expect(await b.resume(sid)).toEqual({ ok: true });
    await wait();
    const st = await b.agentRootStatus();
    expect(st.agentRoot).toBe(newRoot);
    b.dispose();
  });

  it("无 agent_root 条目的老会话 resume 保持默认根（零行为变化）", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-root-legacy-"));
    mkdirSync(join(root, ".wudao", "sessions"), { recursive: true });
    writeFileSync(
      join(root, ".wudao", "sessions", "legacy1.jsonl"),
      [JSON.stringify({ role: "user", content: "hi" }), JSON.stringify({ role: "assistant", content: "yo" })].join("\n") + "\n",
      "utf8",
    );
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const d = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools: [], workspaceRoot: root });
    expect(await d.resume("legacy1")).toEqual({ ok: true });
    await wait();
    expect((await d.agentRootStatus()).agentRoot).toBe(root);
    d.dispose();
  });
});

async function mkdtemp(p: string): Promise<string> {
  return new Promise((res) => res(mkdtempSync(p)));
}
