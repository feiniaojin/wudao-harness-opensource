// 用户反馈 2026-08-29：在供应商设置给 deepseek 加了模型，会话输入框下面的
// 模型下拉不出现新模型——期望保存落定后，下一次点开模型选择就是最新配置。
// 根因链：settingsSaveProvider 落盘 providers.json 并失效进程 memo
// （provider-registry-ops I2 纪律）都没问题，但没有任何东西重建 driver 的
// 状态快照——web 的 status.model.choices 是 push-only（t:"state" 帧只在
// driver emit 时携带新快照），矩阵于是停在保存前的样子，直到下一次无关的
// run/模式事件才被动刷新。修法：驱动器开 refreshStatus()（纯重建+广播，
// setLanguage 的 mutate+emit 减去 mutate），withSettingsOps 在两个注册表写
// op 的成功分支调用它。失败分支不刷新（I2：失败写不打扰缓存好视图）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao-org/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { withSettingsOps } from "../src/driver/settings-ops.js";
import { summarizeToolCall } from "../src/log.js";
import { resetProviderRegistryCacheForTests } from "../src/provider-registry.js";

// The driver's matrix re-derivation reads process.env's registry home — the
// test home must be THE process home, not just the deps env (a deps-only
// split would leave the driver reading ~/.wudao while the ops write tmp).
const SAVED_HOME = process.env.WUDAO_GLOBAL_HOME;
beforeEach(() => {
  resetProviderRegistryCacheForTests();
});
afterEach(() => {
  resetProviderRegistryCacheForTests();
  if (SAVED_HOME === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = SAVED_HOME;
});

/** The user-flow bed: a REAL driver (statusline meta so the model block is
 *  non-null without a run) + the mounted settings port, over a tmp home. */
const bed = (): { driver: ReturnType<typeof createAgentDriver>; port: ReturnType<typeof withSettingsOps>; home: string; ws: string } => {
  const home = mkdtempSync(join(tmpdir(), "mm-refresh-home-"));
  const ws = mkdtempSync(join(tmpdir(), "mm-refresh-ws-"));
  process.env.WUDAO_GLOBAL_HOME = home;
  const driver = createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model: createScriptedModel([{ role: "assistant", content: "ok" }]),
    tools: [],
    statusline: { model: "deepseek-v4-flash", provider: "deepseek", version: "t" },
  });
  const port = withSettingsOps(driver, { env: { WUDAO_GLOBAL_HOME: home }, workspaceRoot: ws });
  return { driver, port, home, ws };
};

const cleanup = (home: string, ws: string): void => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

describe("provider-save refreshes the status model matrix (push-on-save)", () => {
  it("settingsSaveProvider lands → the next status snapshot carries the new model (the user's exact flow)", async () => {
    const b = bed();
    try {
      const save = b.port.settingsSaveProvider;
      if (save === undefined) throw new Error("settingsSaveProvider not mounted on the port");
      // Baseline: the builtin matrix, no test model anywhere.
      const before = b.driver.getStatus().model?.choices ?? [];
      expect(before.some((c) => c.model === "deepseek-v9-test")).toBe(false);

      let pushes = 0;
      b.driver.subscribe(() => {
        pushes += 1;
      });

      const out = await save("deepseek", { models: [{ name: "deepseek-v9-test" }] });
      expect(out.ok).toBe(true);

      // The save LANDED and this process's memo is invalidated — the next
      // snapshot (what the web's t:"state" frame would carry) must show it,
      // and a subscriber push must have fired to broadcast it.
      expect(pushes).toBeGreaterThan(0);
      const added = (b.driver.getStatus().model?.choices ?? []).find((c) => c.model === "deepseek-v9-test");
      expect(added?.provider).toBe("deepseek");
      expect(added?.source).toBe("registry");
      b.driver.dispose();
    } finally {
      cleanup(b.home, b.ws);
    }
  });

  it("a FAILED save refreshes nothing (I2: a failed write never disturbs a cached-good view)", async () => {
    const b = bed();
    try {
      const save = b.port.settingsSaveProvider;
      if (save === undefined) throw new Error("settingsSaveProvider not mounted on the port");
      let pushes = 0;
      b.driver.subscribe(() => {
        pushes += 1;
      });
      // A key field in config is refused loudly (settingsSaveKey owns keys).
      const out = await save("deepseek", { apiKey: "sk-x", models: [{ name: "deepseek-v9-test" }] });
      expect(out.ok).toBe(false);
      expect(pushes).toBe(0);
      expect((b.driver.getStatus().model?.choices ?? []).some((c) => c.model === "deepseek-v9-test")).toBe(false);
      b.driver.dispose();
    } finally {
      cleanup(b.home, b.ws);
    }
  });

  it("settingsDeleteProvider lands → the row's models leave the matrix", async () => {
    const b = bed();
    try {
      const save = b.port.settingsSaveProvider;
      const del = b.port.settingsDeleteProvider;
      if (save === undefined || del === undefined) throw new Error("registry ops not mounted on the port");
      const reg = await save("acme", { baseUrl: "https://acme.test/v1", defaultModel: "acme-one", models: [{ name: "acme-one" }, { name: "acme-two" }] });
      expect(reg.ok).toBe(true);
      expect((b.driver.getStatus().model?.choices ?? []).filter((c) => c.provider === "acme").map((c) => c.model).sort()).toEqual(["acme-one", "acme-two"]);

      const gone = await del("acme");
      expect(gone.ok).toBe(true);
      expect((b.driver.getStatus().model?.choices ?? []).some((c) => c.provider === "acme")).toBe(false);
      b.driver.dispose();
    } finally {
      cleanup(b.home, b.ws);
    }
  });
});
