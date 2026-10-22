// 0.3.75 现场修复（自动模式反复询问）——档位切换持久化钉。
//
// 根因（现场报障 09-11「自动模式还是反复的询问，问题没有彻底解决」）：
// driver.setMode 此前只写内存——每个新会话 boot 从全局层
// permissions.defaultMode 重读（无该键则回落 workspace），用户在 UI 选的
// auto 一重启就丢，回来继续被问。修复=setMode 即时 read-modify-write 到
// 全局层（与设置页同一条 saveGlobalSettings 通道，保住全局层已有的其他
// 键；失败 best-effort 不回滚）。本件钉四点：
//   (a) setMode('auto') → 全局层 permissions.defaultMode === 'auto'
//   (b) read-modify-write：全局层已有的其他键（含 permissions 内其他键）原样保留
//   (c) permissions 节形状坏（字符串/数组/null）→ 覆写为干净的 {defaultMode}
//   (d) 闭环：切换后新会话的 boot 读取（readGlobalDefaultPermissionMode）
//       拿到的就是用户选的档——持久化正是丢失链条上缺的那一环
// ★红线（09-09 用户令，逐字）：「注意，开发、测试过程禁止删除用户文件/文件夹。」
// 本件零删除；全局层读写全部落在 tests/setup-global-home.ts 预设的
// WUDAO_GLOBAL_HOME tempdir 沙箱（每个 cli 测试进程都过这道 setup），绝不
// 触碰用户真实 ~/.wudao/。
import { describe, it, expect } from "vitest";
import type { ModelClient, ModelInput } from "@wudao/core";
import { createAgentDriver, type AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import {
  readGlobalSettings,
  readGlobalDefaultPermissionMode,
  saveGlobalSettings,
} from "../src/settings-layer.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(
  cond: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** 全内存驱动夹具（沿 omega99-233 同款）：mock 模型、无工具轮。setMode 的
 * 持久化 IIFE 是 fire-and-forget 异步——断言一律 until 轮询沙箱全局层。 */
function makeDriver(): AgentDriver {
  const model: ModelClient = {
    async generate(_input: ModelInput): Promise<{ role: "assistant"; content: string }> {
      return { role: "assistant", content: "ok" };
    },
  };
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model,
    tools: [],
    gates: { todo: false, verify: false },
  });
}

describe("0.3.75 现场修复 — setMode 持久化到全局层", () => {
  it("(a) setMode('auto') → permissions.defaultMode 持久化为 'auto'", async () => {
    const driver = makeDriver();
    driver.setMode("auto");
    await until(async () => readGlobalDefaultPermissionMode(await readGlobalSettings()) === "auto", "defaultMode persisted as auto");
  });

  it("(b) read-modify-write：全局层其他键与 permissions 内其他键原样保留", async () => {
    // 预置：全局层已有无关键 + permissions 节已有别的子键
    await saveGlobalSettings({
      model: { id: "deepseek-chat" },
      permissions: { defaultMode: "workspace", askOnWrite: true },
    });
    const driver = makeDriver();
    driver.setMode("auto");
    await until(async () => readGlobalDefaultPermissionMode(await readGlobalSettings()) === "auto", "mode flip persisted");
    const record = await readGlobalSettings();
    expect(record["model"]).toEqual({ id: "deepseek-chat" }); // 无关键不动
    expect((record["permissions"] as Record<string, unknown>)["askOnWrite"]).toBe(true); // 同节他键不动
    expect((record["permissions"] as Record<string, unknown>)["defaultMode"]).toBe("auto"); // 只动这一键
  });

  it("(c) permissions 节形状坏（字符串）→ 覆写为干净 {defaultMode}，不炸", async () => {
    await saveGlobalSettings({ permissions: "garbage" });
    const driver = makeDriver();
    driver.setMode("plan");
    await until(async () => readGlobalDefaultPermissionMode(await readGlobalSettings()) === "plan", "clean node rewritten");
    const record = await readGlobalSettings();
    expect(record["permissions"]).toEqual({ defaultMode: "plan" });
  });

  it("(d) 闭环：切换后 boot 的读取路径拿到的正是用户选的档", async () => {
    const driver = makeDriver();
    driver.setMode("auto");
    await until(async () => readGlobalDefaultPermissionMode(await readGlobalSettings()) === "auto", "persisted");
    // 新会话 boot 走的就是这个函数（settings-layer:522）——修复前它读到
    // 的是 undefined → 回落 workspace，用户选的 auto 丢失。
    expect(readGlobalDefaultPermissionMode(await readGlobalSettings())).toBe("auto");
  });
});
