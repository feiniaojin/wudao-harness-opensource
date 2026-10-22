#!/usr/bin/env node
// 永续 v6 wave2（the upstream project C1）——改进提案门禁的子进程入口（CLI 侧 gate.ts 以
// `node …/dist/gate-cli.js --proposal <json> --out <json>` 拉起）。为什么是
// 子进程而不是 cli 直接 import：工作区依赖图必须无环（server/ports.ts 的
// 既律——@wudao/evals 依赖 wudao-harness（要用真套件），cli 不能反向依赖
// evals）。dist 解析失败=门不可用=上游 fail-open（提案永不激活，什么都不
// 改）——桌面打包未随附 evals dist 时诚实降级，绝不跳过门。
//
// 协议：stdin/--proposal 读 ImprovementGateInput JSON；verdict 写 --out
// （缺省 stdout 末行）；exit 0 = 过门，1 = 未过，2 = 输入不可读。全局层
// 隔离沿用 evals index.ts 的 WUDAO_GLOBAL_HOME 纪律（真 ~/.wudao 的规则
// 绝不渗进门的基线）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImprovementGate, type ImprovementGateInput, type ImprovementGateVerdict } from "./improvement-gate.js";

function usage(code: number): never {
  process.stderr.write("usage: node gate-cli.js --proposal <input.json> [--out <verdict.json>]\n");
  process.exit(code);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const proposalIdx = args.indexOf("--proposal");
  const outIdx = args.indexOf("--out");
  if (proposalIdx === -1 || args[proposalIdx + 1] === undefined) usage(2);
  const outPath = outIdx !== -1 ? args[outIdx + 1] : undefined;

  // Global-tier isolation (evals index.ts's own discipline): the gate's
  // baseline must be THIS harness's empty-workspace face, never the host's.
  if (process.env.WUDAO_GLOBAL_HOME === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "wudao-gate-global-"));
    process.env.WUDAO_GLOBAL_HOME = dir;
    process.on("exit", () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
    });
  }

  let input: ImprovementGateInput;
  try {
    input = JSON.parse(readFileSync(args[proposalIdx + 1]!, "utf8")) as ImprovementGateInput;
  } catch (err) {
    process.stderr.write(`gate: proposal input unreadable: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (typeof input !== "object" || input === null || typeof input.ruleFileName !== "string" || typeof input.ruleText !== "string") {
    process.stderr.write("gate: proposal input must carry ruleFileName + ruleText\n");
    return 2;
  }

  const verdict = await runImprovementGate(input);
  const line = JSON.stringify(verdict);
  if (outPath !== undefined) {
    writeFileSync(outPath, `${line}\n`, "utf8");
  } else {
    process.stdout.write(`${line}\n`);
  }
  if (!verdict.ok && verdict.reason !== undefined) process.stderr.write(`gate: ${verdict.reason}\n`);
  return verdict.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`gate crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
