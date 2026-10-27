// ω99-225: #R1 — resume 三态真话化：driver.resume 不再是会撒谎的布尔（占用与
// 不存在在返回值上不可区分——用户点历史会话得到的却是「会话不存在」）。钉
// ResumeOutcome 矩阵 + 通知保留：
//   ok        有条目且租约可得 → {ok:true}（↪ 已恢复 notice + id 采纳照旧）；
//   not_found 空 entries / 无 workspaceRoot → {ok:false, reason:"not_found"}
//             （无任何占用通知——真不存在）；
//   occupied  活租约持有（孤儿 sidecar 场景）→ {ok:false, reason:"occupied",
//             holderPid}（⚠️ 占用 notice 保留原文案、不采纳、↪ 已恢复零出现）。
// 夹具全在 os.tmpdir()；占用锁 = 手写活 pid 锁文件（process.pid 活——走真
// steal 检查路径 kill(pid,0) 存活即拒）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, ...opts });
}

/** <root>/.wudao/sessions/<id>.jsonl — 一条用户消息 + 一条助手消息。 */
function seedSession(root: string, id: string): void {
  mkdirSync(join(root, ".wudao", "sessions"), { recursive: true });
  writeFileSync(
    join(root, ".wudao", "sessions", `${id}.jsonl`),
    [
      JSON.stringify({ role: "user", content: "Fix the login bug", uuid: "u1" }),
      JSON.stringify({ role: "assistant", content: "fixed it", uuid: "a1" }),
    ].join("\n") + "\n",
    "utf8",
  );
}

/** 活持有者锁文件：<root>/.wudao/sessions/.leases/<id>.json，pid = 本测试进程
 *  （活）——driver 的 acquire 走 EEXIST → readLock → kill(pid,0) 存活 → 拒。 */
function seedLiveLease(root: string, id: string): void {
  mkdirSync(join(root, ".wudao", "sessions", ".leases"), { recursive: true });
  writeFileSync(
    join(root, ".wudao", "sessions", ".leases", `${id}.json`),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString(), gen: "fixture-omega99-225" }),
    "utf8",
  );
}

describe("ω99-225 resume outcome 三态矩阵", () => {
  it("ok：有条目且无占用 → {ok:true}，↪ 已恢复 notice 与 id 采纳照旧", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o225-ok-"));
    try {
      seedSession(root, "o225ok");
      const driver = makeDriver({ model: createScriptedModel([]), tools: [], workspaceRoot: root });
      await wait();
      expect(await driver.resume("o225ok")).toEqual({ ok: true });
      expect(driver.getSessionId()).toBe("o225ok");
      expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("↪ 已恢复 o225ok · 2 条消息"))).toBe(true);
      driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("not_found：空 entries → {ok:false, reason:\"not_found\"}，零占用通知", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o225-nf-"));
    try {
      mkdirSync(join(root, ".wudao", "sessions"), { recursive: true });
      const driver = makeDriver({ model: createScriptedModel([]), tools: [], workspaceRoot: root });
      await wait();
      expect(await driver.resume("no-such-session")).toEqual({ ok: false, reason: "not_found" });
      expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("占用"))).toBe(false);
      driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("not_found：无 workspaceRoot 的 driver 同形（无会话域即无可恢复者）", async () => {
    const driver = makeDriver({ model: createScriptedModel([]), tools: [] });
    expect(await driver.resume("anything")).toEqual({ ok: false, reason: "not_found" });
    driver.dispose();
  });

  it("occupied：活租约持有 → {ok:false, reason:\"occupied\", holderPid}，⚠️ 占用 notice 保留、不采纳", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o225-occ-"));
    try {
      seedSession(root, "o225busy");
      seedLiveLease(root, "o225busy");
      const driver = makeDriver({ model: createScriptedModel([]), tools: [], workspaceRoot: root, sessionId: "boot-225" });
      await wait();
      expect(await driver.resume("o225busy")).toEqual({ ok: false, reason: "occupied", holderPid: process.pid });
      // 通知保留钉：诚实占用回执在场（持 pid 可行动）。
      expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("正被进程") && e.text.includes(String(process.pid)) && e.text.includes("o225busy"))).toBe(true);
      // 不采纳：id 不变、无恢复 notice。
      expect(driver.getSessionId()).toBe("boot-225");
      expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("↪ 已恢复"))).toBe(false);
      driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
