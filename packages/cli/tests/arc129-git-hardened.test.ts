// 129 弧（goose 3fbea00d / GHSA-6mg9-3cvh-9939 引进）——git 调用硬化的收据。
// 夹具范式（goose marker-file）：fixture 仓配置恶意 fsmonitor 命令（每次
// `git status` 会执行）→ 硬化后 status 仍正常收集、marker 文件永不出现。
// 红线：夹具只写 mkdtemp(os.tmpdir())，只写不删。
import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { hardenedGitArgs } from "../src/git-hardened.js";
import { collectGitStatus } from "../src/git-status-note.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "arc129-git-"));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });
}

/** A fixture repo whose config points core.fsmonitor at a marker-writing command. */
function hostileRepo(): { repo: string; marker: string } {
  const dir = tmp();
  const marker = join(dir, "pwned-marker");
  // 真 git init + git config 设置 fsmonitor（config 写入本身不执行该命令）。
  execFileSync("git", ["init", "--initial-branch=main", "-q"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "core.fsmonitor", `touch ${marker}`], { cwd: dir, stdio: "pipe" });
  return { repo: dir, marker };
}

describe("129 — hardenedGitArgs 纯层", () => {
  it("前缀在子命令前：-c core.fsmonitor=false + -c diff.external=", () => {
    const args = hardenedGitArgs(["status", "--porcelain"]);
    expect(args.slice(0, 4)).toEqual(["-c", "core.fsmonitor=false", "-c", "diff.external="]);
    expect(args.slice(4)).toEqual(["status", "--porcelain"]);
  });
  it("纯追加不改原参数内容", () => {
    const orig = ["log", "-1", "--format=%H"];
    expect(hardenedGitArgs(orig).slice(-3)).toEqual(orig);
  });
});

describe("129 — 真仓夹具：collectGitStatus 不执行 repo 配置的 fsmonitor 命令", () => {
  it("status 仍正常收集（rev-parse 结构探测过）且 marker 永不出现", async () => {
    const { repo, marker } = hostileRepo();
    const snap = await collectGitStatus(repo);
    // 空仓（unborn main、无提交）也必须收集到形状（null/undefined 才是失败）。
    expect(snap).not.toBeNull();
    expect(existsSync(marker)).toBe(false); // 恶意命令从未执行
  }, 20_000);
});

describe("129 — 五调用点消费面（census：execFileAsync(\"git\", 直裸形归零）", () => {
  it("cli src 的 git 调用全部经 hardenedGitArgs（或带 -c 前缀）", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const roots = ["src"].map((d) => join(process.cwd(), d));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!name.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        // 裸调用 = "git" 后的下一 token 不是 hardenedGitArgs（剥注释后仍命中才真裸）。
        for (const m of text.matchAll(/execFile(?:Async)?\("git"\s*,\s*([A-Za-z_[.]+)/g)) {
          if (m[1] !== "hardenedGitArgs") offenders.push(`${full}: ${m[0]}`);
        }
      }
    };
    for (const r of roots) walk(r);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
