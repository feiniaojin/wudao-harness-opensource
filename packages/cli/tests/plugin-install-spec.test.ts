// plugin install <spec> — 引导安装的三形态分类与流（guided-install 弧）：
// GitHub 简写 / git URL → 浅克隆（runGit 缝注入，零真网络）→ inspect →
// 零资产门 → 拷装；--preview 只看不装；克隆失败/坏 spec 的人话分类。
// 夹具只写 tmpdir；全局家经 WUDAO_GLOBAL_HOME 隔离。
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginSpec, pluginInstallSpec } from "../src/marketplace.js";
import { parsePluginArgs } from "../src/commands/plugins-command.js";
import type { PluginEngineDeps } from "../src/marketplace.js";

const HOME = mkdtempSync(join(tmpdir(), "plugin-spec-home-"));
afterAll(() => { rmSync(HOME, { recursive: true, force: true }); });

const ISOLATED: PluginEngineDeps = { env: { ...process.env, WUDAO_GLOBAL_HOME: HOME } };

function wsFixture(): { ws: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "plugin-spec-ws-"));
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

/** 一个带技能的上游包夹具（CCB 家族 + 静态资产 → 可装）。 */
function ccbPkg(dir: string): string {
  mkdirSync(join(dir, "skills", "s1"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/git-pkg", version: "1.2.3", dsh: { manifestVersion: 1 } }), "utf8");
  writeFileSync(join(dir, "skills", "s1", "SKILL.md"), "---\nname: s1\ndescription: Skill one\n---\n\nBody.\n", "utf8");
  return dir;
}

/** fake runGit：clone 时把夹具写进目标目录（零真网络）。 */
function fakeCloneGit(pkgFactory: (dest: string) => string, calls: string[] = []): NonNullable<PluginEngineDeps["run"]> {
  return async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "clone") {
      const dest = args[args.length - 1]!;
      pkgFactory(dest);
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

describe("parsePluginSpec: 三形态分类", () => {
  const exists = (p: string) => existsSync(p);
  it("本地路径三拼法 → dir", () => {
    expect(parsePluginSpec("./vendor/p", "/ws", exists)).toEqual({ kind: "dir", path: "/ws/vendor/p" });
    expect(parsePluginSpec("/abs/pkg", "/ws", exists)).toEqual({ kind: "dir", path: "/abs/pkg" });
    expect(parsePluginSpec("~/pkg", "/ws", exists)).toEqual({ kind: "dir", path: join(process.env.HOME ?? "/", "pkg") });
  });
  it("GitHub 简写与 git URL → git（#ref 保留）", () => {
    expect(parsePluginSpec("acme/plugin", "/ws", exists)).toEqual({ kind: "git", url: "https://github.com/acme/plugin.git" });
    expect(parsePluginSpec("acme/plugin#v2", "/ws", exists)).toEqual({ kind: "git", url: "https://github.com/acme/plugin.git", ref: "v2" });
    expect(parsePluginSpec("https://g.example/x/y.git", "/ws", exists)).toEqual({ kind: "git", url: "https://g.example/x/y.git" });
  });
  it("裸名与歧义名 → undefined（fail-closed）", () => {
    expect(parsePluginSpec("single-token", "/ws", exists)).toBeUndefined();
  });
});

describe("pluginInstallSpec: git 引导安装", () => {
  it("克隆 → inspect → 拷装登记；tmp 克隆清理", async () => {
    const { ws, cleanup } = wsFixture();
    try {
      const calls: string[] = [];
      const res = await pluginInstallSpec("acme/plugin", {}, { ...ISOLATED, workspaceRoot: ws, run: fakeCloneGit(ccbPkg, calls) });
      expect(res.previewOnly).toBe(false);
      expect(res.name).toBe("acme-git-pkg");
      expect(res.format).toBe("ccb-family");
      expect(res.detail.skills).toBe(1);
      expect(calls[0]).toContain("clone");
      expect(calls[0]).toContain("--depth");
      expect(existsSync(join(ws, ".wudao", "plugins", "acme-git-pkg", "package.json"))).toBe(true);
    } finally { cleanup(); }
  });
  it("--preview：只 inspect 不装（零登记零目录）", async () => {
    const { ws, cleanup } = wsFixture();
    try {
      const res = await pluginInstallSpec("acme/plugin", { preview: true }, { ...ISOLATED, workspaceRoot: ws, run: fakeCloneGit(ccbPkg) });
      expect(res.previewOnly).toBe(true);
      expect(res.detail.skills).toBe(1);
      expect(existsSync(join(ws, ".wudao", "plugins"))).toBe(false);
    } finally { cleanup(); }
  });
  it("克隆失败 → 人话分类（网络/不存在/权限），零残留", async () => {
    const { ws, cleanup } = wsFixture();
    try {
      const badGit: NonNullable<PluginEngineDeps["run"]> = async () => { throw new Error("fatal: repository not found\nmore lines"); };
      await expect(
        pluginInstallSpec("acme/nope", {}, { ...ISOLATED, workspaceRoot: ws, run: badGit }),
      ).rejects.toThrow(/git clone failed.*repository not found/);
      expect(existsSync(join(ws, ".wudao", "plugins"))).toBe(false);
    } finally { cleanup(); }
  });
  it("克隆出的纯代码包（零资产）→ 装前拒绝", async () => {
    const { ws, cleanup } = wsFixture();
    try {
      const codeOnly = (dest: string) => {
        mkdirSync(join(dest, "src"), { recursive: true });
        writeFileSync(join(dest, "package.json"), JSON.stringify({ name: "@acme/code", version: "1.0.0", dsh: { bundle: "cordis.patch.yml" } }), "utf8");
        return dest;
      };
      await expect(
        pluginInstallSpec("acme/code", {}, { ...ISOLATED, workspaceRoot: ws, run: fakeCloneGit(codeOnly) }),
      ).rejects.toThrow(/no static assets/);
      expect(existsSync(join(ws, ".wudao", "plugins"))).toBe(false);
    } finally { cleanup(); }
  });
  it("坏 spec（无法识别）→ invalid-source 人话", async () => {
    const { ws, cleanup } = wsFixture();
    try {
      await expect(pluginInstallSpec("just-a-name", {}, { ...ISOLATED, workspaceRoot: ws })).rejects.toThrow(/not a recognized plugin source/);
    } finally { cleanup(); }
  });
});

describe("command routing: install 的三形态分流", () => {
  it("./path → install-local；owner/repo → install-spec；owner/repo --preview → preview;true", () => {
    expect(parsePluginArgs(["install", "./vendor/p"])).toMatchObject({ op: { t: "install-local", path: "./vendor/p" } });
    expect(parsePluginArgs(["install", "acme/plugin"])).toMatchObject({ op: { t: "install-spec", spec: "acme/plugin" } });
    expect(parsePluginArgs(["install", "acme/plugin#v2", "--preview"])).toMatchObject({ op: { t: "install-spec", spec: "acme/plugin#v2", preview: true } });
    expect(parsePluginArgs(["install", "https://g.example/x/y.git"])).toMatchObject({ op: { t: "install-spec", spec: "https://g.example/x/y.git" } });
  });
  it("@market 形不被简写规则劫持；--preview 与 @market 同用报 usage", () => {
    expect(parsePluginArgs(["install", "name@market"])).toMatchObject({ op: { t: "install" } });
    expect(parsePluginArgs(["install", "name@market", "--preview"]).kind).toBe("usage");
  });
});
