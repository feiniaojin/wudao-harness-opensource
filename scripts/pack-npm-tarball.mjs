#!/usr/bin/env node
// npm tarball 打包器（115 弧 wudao-as-agent）：把 CLI 打成「零网络自包含」
// tarball，供外部 harness（harbor/Terminal-Bench installed-agent 形态）在
// 任务容器里 `npm install -g <tarball>` 离线装上 wudao。
//
// 配方（2026-09-25 逐步实证，见研究文档 115）：
//   1. `pnpm build`（--no-build 跳过）—— dist 必须新鲜。
//   2. `pnpm --filter ./packages/cli deploy --legacy --prod --config.node-linker=hoisted <stage>`
//      —— hoisted 产出扁平 node_modules（真实文件；ink@7.1.1 的 OOM 补丁
//      已在 pnpm store 内打上，无需重打）。
//   3. 改写 staged package.json：
//      - workspace:* → 各包实版本（node_modules 里就是实文件）；
//      - 剔除 node-pty（原生模块：prebuilds 只有 darwin/win32，宿主打包
//        进容器必坏；wudao 对其缺席有 graceful-degradation 契约——
//        packages/cli/src/terminal/pty.ts，headless one-shot 不加载）；
//      - bundleDependencies: true（node_modules 随 tarball 走，安装侧零网络）；
//      - 删 files 白名单（bundle 目录需要整目录入包）。
//   4. `npm pack` —— tarball 落 wudao-pack/<version>/（发版 ritual 家目录）。
//
// 验收锚点（0.4.2 已全绿）：tarball `npm install -g --offline` 可装、
// `wudao --version` 可跑、one-shot 直连 open.bigmodel.cn 401 快速失败
// exit=1、<cwd>/.wudao/sessions/<uuid>.jsonl 落盘。
//
// 用法: node scripts/pack-npm-tarball.mjs [--out <dir>] [--keep-stage] [--no-build]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const has = (name) => args.includes(name);

const cliPkg = JSON.parse(fs.readFileSync(path.join(REPO, "packages/cli/package.json"), "utf8"));
const VERSION = cliPkg.version;
const NAME = cliPkg.name;
const OUT_DIR = flag("--out") ?? path.join(REPO, "..", "wudao-pack", VERSION, "npm");

function run(cmd, cmdArgs, opts = {}) {
  console.error(`[pack] + ${cmd} ${cmdArgs.join(" ")}`);
  execFileSync(cmd, cmdArgs, { stdio: "inherit", cwd: REPO, ...opts });
}

// 1. build
if (!has("--no-build")) run("pnpm", ["build"]);
const distIndex = path.join(REPO, "packages/cli/dist/index.js");
if (!fs.existsSync(distIndex)) {
  console.error(`[pack] missing ${distIndex} — run without --no-build`);
  process.exit(1);
}

// 2. deploy hoisted
const stage = has("--keep-stage")
  ? path.join(REPO, ".tmp-pack-npm-stage")
  : fs.mkdtempSync(path.join(os.tmpdir(), "wudao-npm-stage-"));
fs.rmSync(stage, { recursive: true, force: true });
run("pnpm", ["--filter", "./packages/cli", "deploy", "--legacy", "--prod", "--config.node-linker=hoisted", stage]);

// 3. staged package.json rewrite
const stagePkgPath = path.join(stage, "package.json");
const stagePkg = JSON.parse(fs.readFileSync(stagePkgPath, "utf8"));
const deps = stagePkg.dependencies ?? {};
for (const [name, range] of Object.entries(deps)) {
  if (name === "node-pty") {
    delete deps[name];
    continue;
  }
  if (range === "workspace:*") {
    deps[name] = JSON.parse(fs.readFileSync(path.join(stage, "node_modules", name, "package.json"), "utf8")).version;
  }
}
stagePkg.dependencies = deps;
delete stagePkg.files;
stagePkg.bundleDependencies = true;
fs.writeFileSync(stagePkgPath, JSON.stringify(stagePkg, null, 2));
// 原生模块剔除（目录级——hoisted 下就是平目录）
fs.rmSync(path.join(stage, "node_modules", "node-pty"), { recursive: true, force: true });

// 4. pack（--ignore-scripts：staged 全是纯 JS + 实文件，无生命周期脚本可跑；
//    不加会触发 prepublishOnly 的全量 build+vitest，打包线被测试线劫持）
fs.mkdirSync(OUT_DIR, { recursive: true });
run("npm", ["pack", "--ignore-scripts", "--pack-destination", OUT_DIR], { cwd: stage });
const tarball = path.join(OUT_DIR, `${NAME}-${VERSION}.tgz`);
const bytes = fs.statSync(tarball).size;
const sha = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
console.error(`[pack] ${tarball}`);
console.error(`[pack] size=${(bytes / 1024 / 1024).toFixed(1)}MiB sha256=${sha}`);
if (!has("--keep-stage")) fs.rmSync(stage, { recursive: true, force: true });
