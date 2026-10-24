// 插件兼容扩展层（plugin-compat）测试：CCB 家族上游插件包
// 装载 → 归一化（作用域名/扁平技能/assets 技能/camelCase frontmatter）→
// 未知字段宽容降级（warn 不 fail）→ 技能/命令可见；本地路径安装流
// （`wudao plugin install <path>` → .wudao/plugins/ 登记 market=local →
// list/uninstall 走既有登记引擎）。夹具只写 tmpdir（红线：不碰真实用户
// 目录、不碰参考仓）；全局家通过 WUDAO_GLOBAL_HOME 指到隔离 tmpdir。
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPlugins,
  ccbPluginName,
  isCcbFamilyManifest,
  normalizeCcbSkillFrontmatter,
  type PluginLoadDeps,
} from "../src/plugins.js";
import { parsePluginArgs, pluginMain } from "../src/commands/plugins-command.js";

// ---------------------------------------------------------------------------
// Harness（隔离全局家 — 开发者的真实 ~/.wudao 永不进入测试）
// ---------------------------------------------------------------------------

const isolatedHome = mkdtempSync(join(tmpdir(), "plugin-compat-home-"));
const ISOLATED_ENV: NodeJS.ProcessEnv = { ...process.env, WUDAO_GLOBAL_HOME: isolatedHome };
const ISOLATED: PluginLoadDeps = { env: ISOLATED_ENV };
afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function tmpWs(): { ws: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "plugin-compat-ws-"));
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** 纯 CLI 调用收集器（pluginMain 的 out 收集 + 隔离 env + 假 rescan）。 */
function cli(ws: string, argv: readonly string[]): Promise<{ code: number; text: string; json: () => unknown }> {
  const out: string[] = [];
  const rescan = async (): Promise<{ skills: number; plugins: number; hooks: number }> => ({ skills: 0, plugins: 0, hooks: 0 });
  return pluginMain(argv, { cwd: ws, env: ISOLATED_ENV, out: (s) => out.push(s), rescan }).then((code) => ({
    code,
    text: out.join(""),
    json: () => JSON.parse(out.join("")),
  }));
}

// ---------------------------------------------------------------------------
// 夹具：最小 CCB 家族上游插件包（package.json 声明 + 三源技能 + 命令 +
// 运行时声明/展示元数据 = 应被 warn+忽略 的部分）
// ---------------------------------------------------------------------------

const PKG_JSON = {
  name: "@acme/upstream-fixture",
  version: "0.3.1",
  description: "CCB-family upstream fixture",
  icon: "icon.svg",
  keywords: ["office"],
  engines: { dsh: "^0.2" },
  dependencies: { "some-dep": "^1.0.0" },
  dsh: { manifestVersion: 1, bundle: { patch: "./cordis.patch.yml" }, futureThing: true },
};

/** 写一个最小上游包夹具；返回包目录。`dirName` 只影响磁盘目录名（装载名
 *  永远来自 package.json），夹具默认落在 tmpdir 任意处。 */
function makeUpstreamPlugin(dir: string): string {
  mkdirSync(join(dir, "skills", "bundled"), { recursive: true });
  mkdirSync(join(dir, "assets", "packed"), { recursive: true });
  mkdirSync(join(dir, "commands"), { recursive: true });
  mkdirSync(join(dir, "locale"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(PKG_JSON, null, 2), "utf8");
  // 运行时声明引用的编排层与入口模块 — 均不应被执行（配置包法律）
  writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n  - id: fixture\n", "utf8");
  writeFileSync(join(dir, "index.mjs"), "throw new Error('must never run');\n", "utf8");
  writeFileSync(join(dir, "locale", "en.json"), JSON.stringify({ meta: { title: "Fixture", description: "display copy" } }), "utf8");
  // 技能三源：目录包 + 扁平文件 + assets 捆绑目录；bundled 用 camelCase whenToUse
  writeFileSync(join(dir, "skills", "bundled", "SKILL.md"), "---\nname: bundled\ndescription: Bundled directory skill\nwhenToUse: Use when touching docs\n---\n\nBundled body.\n", "utf8");
  writeFileSync(join(dir, "skills", "flat-skill.md"), "---\nname: flat\ndescription: Flat file skill\n---\n\nFlat body.\n", "utf8");
  writeFileSync(join(dir, "assets", "packed", "SKILL.md"), "---\nname: packed\ndescription: Asset-bundled skill\n---\n\nPacked body.\n", "utf8");
  writeFileSync(join(dir, "commands", "hi.md"), "---\ndescription: Say hi\n---\n\nHi $ARGUMENTS.\n", "utf8");
  return dir;
}

/** installed.json 原始行（测试自读 — 引擎外的那只眼）。 */
function installedRows(): unknown[] {
  const path = join(isolatedHome, "plugins", "installed.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as unknown[];
}

/** 每个安装流用例开局清一次登记文件 — 用例间零状态泄漏（一个用例中途
 *  失败也不会把残留记录带进下一个断言）。 */
function resetRegistry(): void {
  rmSync(join(isolatedHome, "plugins", "installed.json"), { force: true });
}

// ---------------------------------------------------------------------------
// 纯函数：格式判定与归一化
// ---------------------------------------------------------------------------

describe("plugin-compat: 格式判定与名字归一化（纯函数）", () => {
  it("isCcbFamilyManifest：dsh 成员或 engines.dsh 是家族标记；普通 npm 包不是", () => {
    expect(isCcbFamilyManifest({ name: "x", dsh: { bundle: { patch: "./p.yml" } } })).toBe(true);
    expect(isCcbFamilyManifest({ name: "x", dsh: {} })).toBe(true);
    expect(isCcbFamilyManifest({ name: "x", engines: { dsh: "^0.2" } })).toBe(true);
    expect(isCcbFamilyManifest({ name: "x", engines: { node: ">=22" } })).toBe(false);
    expect(isCcbFamilyManifest({ name: "x", version: "1.0.0" })).toBe(false);
    expect(isCcbFamilyManifest({ name: "x", dsh: "not-an-object" })).toBe(false);
  });

  it("ccbPluginName：作用域包去 @ 折叠 / 为 -；非作用域原样", () => {
    expect(ccbPluginName("@acme/my-plug")).toBe("acme-my-plug");
    expect(ccbPluginName("plain-plugin")).toBe("plain-plugin");
  });

  it("normalizeCcbSkillFrontmatter：仅 frontmatter 内行首 whenToUse 改写；正文不动", () => {
    const text = "---\nname: a\ndescription: d\nwhenToUse: camel case\n---\n\nBody mentions whenToUse: inline.\n";
    const normalized = normalizeCcbSkillFrontmatter(text);
    expect(normalized).toContain("when-to-use: camel case");
    expect(normalized).toContain("Body mentions whenToUse: inline.");
    expect(normalizeCcbSkillFrontmatter("no frontmatter\nwhenToUse: x\n")).toBe("no frontmatter\nwhenToUse: x\n");
  });
});

// ---------------------------------------------------------------------------
// 装载：发现 → 归一化 → 宽容降级 → 资产可见
// ---------------------------------------------------------------------------

describe("plugin-compat: CCB 家族插件装载", () => {
  it("装载上游包：名字归一化 + 三源技能可见 + camelCase whenToUse 解析 + 未知声明 warn 不 fail", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      makeUpstreamPlugin(join(ws, ".wudao", "plugins", "upstream-fixture"));
      const plugins = loadPlugins(ws, [], (m) => warnings.push(m), ISOLATED);
      expect(plugins.length).toBe(1);
      const p = plugins[0]!;
      // 作用域包名归一化：@acme/upstream-fixture → acme-upstream-fixture
      expect(p.name).toBe("acme-upstream-fixture");
      expect(p.format).toBe("ccb-family");
      expect(p.version).toBe("0.3.1");
      expect(p.description).toBe("CCB-family upstream fixture");
      expect(p.scope).toBe("project");
      // 三源技能全部可见（目录包 + 扁平文件 + assets 捆绑），project 作用域
      expect(p.skills.map((s) => s.name).sort()).toEqual(["bundled", "flat", "packed"]);
      for (const s of p.skills) {
        expect(s.plugin).toBe("acme-upstream-fixture");
        expect(s.pluginScope).toBe("project");
        expect(s.origin).toBe("plugin");
      }
      // camelCase whenToUse 归一化后进入 whenToUse 字段；content 保留原字节
      const bundled = p.skills.find((s) => s.name === "bundled")!;
      expect(bundled.whenToUse).toBe("Use when touching docs");
      expect(bundled.content).toContain("whenToUse: Use when touching docs");
      // 命令可见（与 claude-plugin 同一命令装载器）
      expect(p.commands.map((c) => c.name)).toEqual(["hi"]);
      // 宽容降级：每一类「看不懂/不执行」的声明都有一条 warn，装载不失败
      const all = [...warnings, ...p.warnings].join("\n");
      expect(all).toContain("dsh.bundle");
      expect(all).toContain("futureThing"); // dsh 下未知子键：点名 + 忽略
      expect(all).toContain("engines.dsh");
      expect(all).toContain("locale/");
      expect(all).toContain("dependencies"); // 依赖表不安装
      expect(all).toContain("scoped package name"); // 名字归一化说明
      expect(all).toContain("index.mjs"); // 可执行载荷不运行（配置包法律）
    } finally {
      cleanup();
    }
  });

  it("无家族标记的普通 npm 包不是插件：一条「不是插件」warn，零装载", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const pkgDir = join(ws, ".wudao", "plugins", "some-library");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "some-library", version: "1.0.0" }), "utf8");
      const plugins = loadPlugins(ws, [], (m) => warnings.push(m), ISOLATED);
      expect(plugins).toEqual([]);
      expect(warnings.filter((w) => w.includes("some-library")).length).toBe(1);
      expect(warnings[0]).toContain("not a plugin");
    } finally {
      cleanup();
    }
  });

  it("两种清单并存时 claude-plugin 优先（我们的格式赢，不出家族降级警告）", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = makeUpstreamPlugin(join(ws, ".wudao", "plugins", "both"));
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "native-wins", version: "2.0.0" }), "utf8");
      const plugins = loadPlugins(ws, [], (m) => warnings.push(m), ISOLATED);
      expect(plugins.length).toBe(1);
      expect(plugins[0]!.name).toBe("native-wins");
      expect(plugins[0]!.format).toBe("claude-plugin");
      const all = [...warnings, ...plugins[0]!.warnings].join("\n");
      expect(all).not.toContain("dsh.bundle");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 安装流：`wudao plugin install <path>` → .wudao/plugins/<name>/（market=local）
// ---------------------------------------------------------------------------

describe("plugin-compat: 本地路径安装", () => {
  it("install <path>：零静态资产的纯代码 CCB 包 → 装前拒绝（配置包法律：装上即僵尸登记），无目录无登记", async () => {
    resetRegistry();
    const { ws, cleanup } = tmpWs();
    const srcRoot = mkdtempSync(join(tmpdir(), "plugin-compat-codeonly-"));
    try {
      // 纯代码插件：package.json + dsh.bundle/client 声明 + src/ 模块，零静态资产
      mkdirSync(join(srcRoot, "pkg", "src"), { recursive: true });
      writeFileSync(join(srcRoot, "pkg", "package.json"), JSON.stringify({
        name: "@acme/code-only", version: "0.1.0",
        dsh: { manifestVersion: 1, bundle: "cordis.patch.yml", client: "./src/index.js" },
      }), "utf8");
      writeFileSync(join(srcRoot, "pkg", "src", "index.js"), "throw new Error('must never run');\n", "utf8");
      const res = await cli(ws, ["install", join(srcRoot, "pkg")]);
      expect(res.code).toBe(1);
      expect(res.text).toContain("no static assets");
      expect(res.text).toContain("Nothing was installed");
      // 门是装前的：目录与登记都不存在
      expect(existsSync(join(ws, ".wudao", "plugins", "acme-code-only"))).toBe(false);
      expect(installedRows()).toEqual([]);
    } finally {
      rmSync(srcRoot, { recursive: true, force: true });
      cleanup();
    }
  });

  it("install <path>：拷入 .wudao/plugins/、登记 market=local、装载即可见；重复装被拒；卸载走既有引擎", async () => {
    resetRegistry();
    const { ws, cleanup } = tmpWs();
    const srcRoot = mkdtempSync(join(tmpdir(), "plugin-compat-src-"));
    try {
      const src = makeUpstreamPlugin(join(srcRoot, "pkg"));
      // 1) 安装（绝对路径·文本面）：exit 0 + 回执 + 目录 + 登记
      const install = await cli(ws, ["install", src]);
      expect(install.code).toBe(0);
      expect(install.text).toContain("已安装 acme-upstream-fixture@local");
      expect(install.text).toContain("上游 CCB 家族包");
      expect(install.text).toContain("技能 3");
      const dest = join(ws, ".wudao", "plugins", "acme-upstream-fixture");
      expect(existsSync(join(dest, "package.json"))).toBe(true);
      expect(existsSync(join(dest, "skills", "flat-skill.md"))).toBe(true);
      const rows = installedRows() as { name: string; market: string; scope: string; version?: string }[];
      expect(rows).toEqual([{ name: "acme-upstream-fixture", market: "local", scope: "project", version: "0.3.1", root: expect.any(String) }]);

      // 2) 安装后装载即可见（project 作用域发现）
      const plugins = loadPlugins(ws, [], () => {}, ISOLATED);
      expect(plugins.map((p) => p.name)).toEqual(["acme-upstream-fixture"]);
      expect(plugins[0]!.skills.length).toBe(3);

      // 3) list：登记行 + 已加载映射（JSON 面 format=ccb-family）
      const list = await cli(ws, ["list", "--json"]);
      expect(list.code).toBe(0);
      const lp = list.json() as { installed: { id: string; scope: string; enabled: boolean }[]; loaded: { name: string; format: string }[] };
      expect(lp.installed.map((r) => r.id)).toEqual(["acme-upstream-fixture@local"]);
      expect(lp.installed[0]!.scope).toBe("project");
      expect(lp.installed[0]!.enabled).toBe(true);
      expect(lp.loaded[0]!.format).toBe("ccb-family");

      // 4) 重复安装：already-exists，exit 1，登记不重复
      const dup = await cli(ws, ["install", src]);
      expect(dup.code).toBe(1);
      expect(dup.text).toContain("already installed");
      expect(installedRows().length).toBe(1);

      // 5) 卸载走既有引擎（<name>@local）：删目录 + 清登记
      const uninstall = await cli(ws, ["uninstall", "acme-upstream-fixture@local"]);
      expect(uninstall.code).toBe(0);
      expect(existsSync(dest)).toBe(false);
      expect(installedRows()).toEqual([]);
      expect(loadPlugins(ws, [], () => {}, ISOLATED)).toEqual([]);
    } finally {
      cleanup();
      rmSync(srcRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("本地直装也认 claude-plugin 目录（同一 dry-run 双格式识别）", async () => {
    resetRegistry();
    const { ws, cleanup } = tmpWs();
    const srcRoot = mkdtempSync(join(tmpdir(), "plugin-compat-src-"));
    try {
      const src = join(srcRoot, "native");
      mkdirSync(join(src, ".claude-plugin"), { recursive: true });
      writeFileSync(join(src, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "native-local", version: "1.0.0" }), "utf8");
      const r = await cli(ws, ["install", src]);
      expect(r.code).toBe(0);
      expect(r.text).toContain("已安装 native-local@local");
      expect(r.text).toContain("claude-plugin");
      expect(existsSync(join(ws, ".wudao", "plugins", "native-local", ".claude-plugin", "plugin.json"))).toBe(true);
    } finally {
      cleanup();
      rmSync(srcRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("install <path> --json：回执 JSON 带 id/format/detail（CCB 家族）", async () => {
    resetRegistry();
    const { ws, cleanup } = tmpWs();
    const srcRoot = mkdtempSync(join(tmpdir(), "plugin-compat-src-"));
    try {
      const src = makeUpstreamPlugin(join(srcRoot, "pkg"));
      const r = await cli(ws, ["install", src, "--json"]);
      expect(r.code).toBe(0);
      const payload = r.json() as { id: string; scope: string; format: string; detail: { skills: number; commands: number; agents: number; hooks: number; mcp: number } };
      expect(payload.id).toBe("acme-upstream-fixture@local");
      expect(payload.scope).toBe("project");
      expect(payload.format).toBe("ccb-family");
      expect(payload.detail).toEqual({ skills: 3, commands: 1, agents: 0, hooks: 0, mcp: 0 });
    } finally {
      cleanup();
      rmSync(srcRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("不存在的路径与无清单目录：typed 错误 exit 1，不落任何目录", async () => {
    resetRegistry();
    const { ws, cleanup } = tmpWs();
    try {
      const missing = await cli(ws, ["install", join(ws, "no-such-dir")]);
      expect(missing.code).toBe(1);
      expect(missing.text).toContain("does not exist");
      const bare = mkdtempSync(join(tmpdir(), "plugin-compat-bare-"));
      try {
        const notPlugin = await cli(ws, ["install", bare]);
        expect(notPlugin.code).toBe(1);
        expect(notPlugin.text).toContain("not a loadable plugin");
      } finally {
        rmSync(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
      expect(existsSync(join(ws, ".wudao", "plugins"))).toBe(false);
      expect(installedRows()).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 语法：install 的双形态路由
// ---------------------------------------------------------------------------

describe("plugin-compat: parsePluginArgs install 双形态", () => {
  it("路径形 token → install-local；<name>@<market> 形不变；裸名报 usage", () => {
    expect(parsePluginArgs(["install", "./vendor/plugin"])).toMatchObject({ kind: "op", op: { t: "install-local", path: "./vendor/plugin" } });
    expect(parsePluginArgs(["install", "/abs/path with space/kept"])).toMatchObject({ kind: "op", op: { t: "install-local", path: "/abs/path with space/kept" } });
    expect(parsePluginArgs(["install", "~/pkg"])).toMatchObject({ kind: "op", op: { t: "install-local", path: "~/pkg" } });
    expect(parsePluginArgs(["install", "alpha@m"])).toMatchObject({ kind: "op", op: { t: "install", name: "alpha", market: "m" } });
    expect(parsePluginArgs(["install", "alpha"])).toMatchObject({ kind: "usage" });
    expect(parsePluginArgs(["install"])).toMatchObject({ kind: "usage" });
    expect(parsePluginArgs(["install", "./p", "--scope", "user"])).toMatchObject({ kind: "usage" });
  });
});
