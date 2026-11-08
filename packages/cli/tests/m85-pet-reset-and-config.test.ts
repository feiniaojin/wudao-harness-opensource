// M85-pet task 1: driver 的两个地基方法——pet 车道「新会话」轮换与工具栏
// 配置的下沉面。先红后绿：resetSessionKeepId 复用 /clear 的共享 wipe 但
// 不轮换 sessionId（车道不变量：活 id 恒 "pet"，归档换文件不换 id）；
// configureModel 的窄缝先钉 effort 回读（provider/model 重建腿的装配
// 复用 /model 与 /provider 的既有漏斗，见实现处注释）。
// 夹具范式照 omega99-235-pet-lane.test.ts 同款：startUiSession + petLane
// + scripted model（脚本化会话不接 onProviderSwitch 缝——重建腿在那条
// 路径下的降级行为由实现处的回执 notice 承担，本文件不钉）。
// ★红线（09-09 用户令）：夹具只写 mkdtemp(os.tmpdir())，全程不删任何文件。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { startUiSession, PET_SESSION_ID, type UiSession } from "../src/ui.js";
import { TITLE_QUERY_SOURCE } from "../src/session-title.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

const sessions: UiSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
});

/** A scripted model that never trips the auto-title fork (title probes get a
 *  canned reply; conversation calls draw the script). */
function scriptedModel(replies: readonly string[]): ModelClient {
  let i = 0;
  return {
    async generate(input: ModelInput) {
      if (input.querySource === TITLE_QUERY_SOURCE) return { role: "assistant", content: "标题" };
      const r = replies[i];
      i += 1;
      if (r === undefined) throw new Error("scripted replies exhausted");
      return { role: "assistant", content: r };
    },
  };
}

const base = {
  config,
  contextWindowTokens: 64000,
  gates: { verify: false },
  announce: false,
  openBrowser: false,
  staticDir: undefined,
} as const;

describe("M85-pet driver 历史重置面 + 模型配置面", () => {
  it("resetSessionKeepId 清空历史且 sessionId 不变", async () => {
    const root = mkdtempSync(join(tmpdir(), "m85-pet-reset-"));
    const session = await startUiSession({
      ...base,
      workspaceRoot: root,
      modelOverride: scriptedModel(["MAIN-OK"]),
      petModelOverride: scriptedModel(["PET-OK"]),
      tools: [],
      petLane: true,
    });
    sessions.push(session);
    const d = session.petDriver!;
    expect(d.getSessionId()).toBe(PET_SESSION_ID);
    d.submit("你好"); // 一条史
    await until(() => d.isIdle(), "pet run settle");
    expect(d.getHistory().length).toBeGreaterThan(0);
    const idBefore = d.getSessionId();
    d.resetSessionKeepId();
    expect(d.getHistory().length).toBe(0);
    expect(d.getSessionId()).toBe(idBefore); // 不轮换 id——车道不变量
    expect(d.getSessionId()).toBe(PET_SESSION_ID);
  });

  it("configureModel 后 getEffort 回读新档", async () => {
    const root = mkdtempSync(join(tmpdir(), "m85-pet-effort-"));
    const session = await startUiSession({
      ...base,
      workspaceRoot: root,
      modelOverride: scriptedModel(["MAIN-OK"]),
      petModelOverride: scriptedModel(["PET-OK"]),
      tools: [],
      petLane: true,
    });
    sessions.push(session);
    const d = session.petDriver!;
    d.configureModel({ effort: "high" });
    expect(d.getEffort()).toBe("high");
  });

  it("configureModel 空对象 = no-op（effort 不动）", async () => {
    const root = mkdtempSync(join(tmpdir(), "m85-pet-noop-"));
    const session = await startUiSession({
      ...base,
      workspaceRoot: root,
      modelOverride: scriptedModel(["MAIN-OK"]),
      petModelOverride: scriptedModel(["PET-OK"]),
      tools: [],
      petLane: true,
    });
    sessions.push(session);
    const d = session.petDriver!;
    const before = d.getEffort();
    d.configureModel({});
    expect(d.getEffort()).toBe(before);
  });
});
