#!/usr/bin/env node
// 发布前把仓根的法律与说明文件搬进包里（npm tarball 只带包目录的东西：
// 子包里没有 LICENSE，npmjs 页面上的许可证栏就是空的）。
//
// 配方：仓根 LICENSE → <包>/LICENSE；CLI 包（wudao-harness，带 bin）另加
// 仓根 README.md → <包>/README.md（npmjs 首屏就是它）。
//
// 幂等：重复发布覆盖同一份内容（字节同源）。搬完的文件在 .gitignore 里
// （发布产物，不是源码）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));

const copy = (from, to) => {
  if (!fs.existsSync(from)) {
    console.error(`[publish-assets] skip ${path.basename(from)}（仓根缺该文件）`);
    return;
  }
  fs.copyFileSync(from, to);
  console.error(`[publish-assets] ${path.basename(from)} → ${path.relative(REPO, to)}`);
};

copy(path.join(REPO, "LICENSE"), path.join(pkgDir, "LICENSE"));
if (pkg.bin !== undefined && pkg.name === "wudao-harness") {
  copy(path.join(REPO, "README.md"), path.join(pkgDir, "README.md"));
}
