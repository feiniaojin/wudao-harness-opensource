// 138 续 — 桌面端 boot 工作区采纳（2026-11-03 用户拍板）。adoptBootWorkspace
// 是主车道 boot 与全新副车道共用的落点；有史会话不走（resume 的 agent_root
// 重放自带会话根，后到覆盖）。钉三面：env 在场且路径合法 → agentRootSwitch
// 出线；env 缺席/等于会话根 → 零动作；switch 拒绝（路径失效）→ 静默吞掉。
import { describe, it, expect, afterEach } from "vitest";
import { adoptBootWorkspace } from "../src/driver/lane-manager.js";

const KEY = "WUDAO_BOOT_WORKSPACE";
const ORIGINAL = process.env[KEY];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[KEY];
  else process.env[KEY] = ORIGINAL;
});

function recorder(result: Promise<unknown> = Promise.resolve({ applied: true, queued: false })) {
  const calls: string[] = [];
  return {
    calls,
    driver: { agentRootSwitch(path: string) { calls.push(path); return result; } },
  };
}

describe("138 续 — adoptBootWorkspace", () => {
  it("env 在场且非会话根 → agentRootSwitch 带该路径出线", async () => {
    process.env[KEY] = "/w/last-used";
    const r = recorder();
    await adoptBootWorkspace(r.driver as never, process.env[KEY], "/w/desktop-workspace");
    expect(r.calls).toEqual(["/w/last-used"]);
  });

  it("env 缺席 / 空串 / 等于会话根 → 零动作（CLI/TUI cwd 约定零变化）", async () => {
    const root = "/w/desktop-workspace";
    delete process.env[KEY];
    const a = recorder();
    await adoptBootWorkspace(a.driver as never, undefined, root);
    process.env[KEY] = "";
    const b = recorder();
    await adoptBootWorkspace(b.driver as never, "", root);
    process.env[KEY] = root;
    const c = recorder();
    await adoptBootWorkspace(c.driver as never, root, root);
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
    expect(c.calls).toEqual([]);
  });

  it("switch 类型化拒绝（路径失效）→ 静默回落 boot 根，绝不抛", async () => {
    process.env[KEY] = "/w/deleted-dir";
    const r = recorder(Promise.reject(new Error("no such directory: /w/deleted-dir")));
    await expect(adoptBootWorkspace(r.driver as never, process.env[KEY], "/w/desktop-workspace")).resolves.toBeUndefined();
    expect(r.calls).toEqual(["/w/deleted-dir"]);
  });
});
