// ω99-287: #5 — L2 后台运行 MVP 的 typed 键三形（brief §2 cli 件，tmpdir 夹具）：
// desktop.backgroundOnClose（boolean，默认 false）——
//   ① set true 落盘（全局 tier 的 desktop 节点）+ settingsStatus 回读 true；
//   ② set false 落盘回读 false；
//   ③ 非布尔拒（typed 门——字符串/数字/null/对象全拒，错误串点名该键）；
//   ④ 默认缺席 = false 语义（无 desktop 节点 → payload false）；坏节点（非对象
//      /非布尔值）容错读 false（fail-closed，不抛）；
//   ⑤ 未知键拒绝面不变（枚举串已含新键）；desktop 节点兄弟键在写入后存活
//      （whole-node merge，docSuite.enabled 的形）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsOps } from "../src/driver/settings-ops.js";
import { globalSettingsPath } from "../src/settings-layer.js";

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omega99-287-home-"));
  root = mkdtempSync(join(tmpdir(), "omega99-287-root-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const env = (): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home });

describe("ω99-287 — settingsSet desktop.backgroundOnClose", () => {
  it("set true → 落盘全局 tier 的 desktop 节点 + settingsStatus 回读 true", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect(await ops.settingsSet("desktop.backgroundOnClose", true)).toEqual({ key: "desktop.backgroundOnClose", saved: true });
    const saved = JSON.parse(readFileSync(globalSettingsPath(env()), "utf8")) as Record<string, unknown>;
    expect(saved["desktop"]).toEqual({ backgroundOnClose: true });
    expect((await ops.settingsStatus()).settings.desktopBackgroundOnClose).toBe(true);
  });

  it("set false → 落盘回读 false", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect(await ops.settingsSet("desktop.backgroundOnClose", true)).toEqual({ key: "desktop.backgroundOnClose", saved: true });
    expect(await ops.settingsSet("desktop.backgroundOnClose", false)).toEqual({ key: "desktop.backgroundOnClose", saved: true });
    const saved = JSON.parse(readFileSync(globalSettingsPath(env()), "utf8")) as Record<string, unknown>;
    expect(saved["desktop"]).toEqual({ backgroundOnClose: false });
    expect((await ops.settingsStatus()).settings.desktopBackgroundOnClose).toBe(false);
  });

  it("非布尔拒（字符串/数字/null/对象），错误串点名该键", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    for (const bad of ["true", 1, null, { enabled: true }]) {
      await expect(ops.settingsSet("desktop.backgroundOnClose", bad)).rejects.toThrow(/desktop\.backgroundOnClose must be a boolean/);
    }
    // 拒绝后不落盘（typed 门在写之前——文件可能根本还没被创建）。
    const file = globalSettingsPath(env());
    if (existsSync(file)) {
      expect(JSON.parse(readFileSync(file, "utf8"))["desktop"]).toBeUndefined();
    }
  });

  it("desktop 节点兄弟键在写入后存活（whole-node merge）", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(globalSettingsPath(env()), JSON.stringify({ desktop: { futureKnob: "keep" } }), "utf8");
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    await ops.settingsSet("desktop.backgroundOnClose", true);
    const saved = JSON.parse(readFileSync(globalSettingsPath(env()), "utf8")) as Record<string, unknown>;
    expect(saved["desktop"]).toEqual({ futureKnob: "keep", backgroundOnClose: true });
  });

  it("未知键拒绝面不变：枚举串已含 desktop.backgroundOnClose", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    await expect(ops.settingsSet("desktop.unknown", true)).rejects.toThrow(/unknown settings key "desktop\.unknown".*desktop\.backgroundOnClose/);
  });
});

describe("ω99-287 — settingsStatus 读侧（默认缺席/坏节点 fail-closed）", () => {
  it("默认缺席 = false 语义（无 desktop 节点 → payload false）", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect((await ops.settingsStatus()).settings.desktopBackgroundOnClose).toBe(false);
  });

  it("坏节点容错读 false：非对象节点 / 非布尔值，均不抛", async () => {
    mkdirSync(home, { recursive: true });
    for (const node of [true, "yes", 42, [true]]) {
      writeFileSync(globalSettingsPath(env()), JSON.stringify({ desktop: node }), "utf8");
      const ops = createSettingsOps({ env: env(), workspaceRoot: root });
      expect((await ops.settingsStatus()).settings.desktopBackgroundOnClose).toBe(false);
    }
  });
});
