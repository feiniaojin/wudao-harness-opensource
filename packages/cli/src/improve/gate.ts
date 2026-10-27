// 永续 v6 wave2（reef C1）——门禁子进程运行器（cli 侧）。evals 包的
// gate-cli bin 以独立 node 进程拉起：依赖图方向是 evals→cli（evals 要用
// wudao-harness 的真实车道），cli 反向 import evals 会成环（server/ports.ts
// 的无环律），所以「用其 dist/API 跑」的唯一合法通道=子进程。解析不到
// dist（npm 安装形态/桌面 SEA 未随附 evals）=门不可用：同意动作在花任何
// 模型调用**之前**拒绝——fail-open 且零浪费。门全程零主会话字节（M24）。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImprovementGateResult } from "./store.js";

const execFileAsync = promisify(execFile);

/** Where this module's dist lives (packages/cli/dist/improve/). */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolve the gate bin. The env override is AUTHORITATIVE (an explicit
 *  WUDAO_IMPROVE_GATE_BIN that does not exist is a config error, never a
 *  silent fallback — the operator asked for THAT bin); absent → the
 *  workspace-sibling dist, then the cwd-relative dist (repo-root runs).
 *  Nothing found → undefined (gate unavailable). */
export function resolveGateBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.WUDAO_IMPROVE_GATE_BIN;
  if (override !== undefined && override !== "") return existsSync(override) ? override : undefined;
  const candidates: string[] = [
    // dist/improve/gate.js → ../../../ = packages/ → evals/dist/gate-cli.js
    resolve(HERE, "../../../evals/dist/gate-cli.js"),
    resolve(process.cwd(), "packages/evals/dist/gate-cli.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

export interface ImprovementGateInput {
  readonly proposalId: string;
  readonly ruleFileName: string;
  readonly ruleText: string;
  readonly paths?: readonly string[];
}

export type GateRun =
  | { readonly ok: true; readonly verdict: ImprovementGateResult }
  | { readonly ok: false; readonly reason: string };

/** Run the paired-replay gate as a subprocess. NEVER throws — every failure
 *  shape (missing bin, spawn error, timeout, unparsable output) is an
 *  {ok:false} result the caller archives; nothing anywhere changes on a
 *  failed gate except the record's own status. Exit 0/1/2 are all "the gate
 *  ran" outcomes judged from the verdict file; a spawn-level failure (the bin
 *  could not even start) is the only reject path. */
export async function runImprovementGateSubprocess(
  input: ImprovementGateInput,
  opts: { readonly timeoutMs?: number; readonly bin?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<GateRun> {
  const bin = opts.bin ?? resolveGateBin(opts.env);
  if (bin === undefined) return { ok: false, reason: "门禁环境不可用（找不到 evals 门禁入口）——按安全红线未激活" };
  const dir = mkdtempSync(join(tmpdir(), "wudao-improve-gate-"));
  const proposalPath = join(dir, "proposal.json");
  const outPath = join(dir, "verdict.json");
  try {
    writeFileSync(proposalPath, `${JSON.stringify(input)}\n`, "utf8");
    try {
      await execFileAsync(process.execPath, [bin, "--proposal", proposalPath, "--out", outPath], {
        timeout: opts.timeoutMs ?? 180_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (err) {
      const e = err as { code?: unknown; killed?: boolean; message?: string };
      // A non-zero exit still wrote the verdict (the bin's contract); only a
      // bin that never produced output is a run failure.
      if (!existsSync(outPath)) {
        if (e.killed === true) return { ok: false, reason: "门禁超时（按安全红线未激活）" };
        return { ok: false, reason: `门禁运行失败：${e.message ?? String(err)}` };
      }
    }
    let verdict: ImprovementGateResult;
    try {
      verdict = JSON.parse(await readFile(outPath, "utf8")) as ImprovementGateResult;
    } catch {
      return { ok: false, reason: "门禁结果不可解析（按安全红线未激活）" };
    }
    if (typeof verdict !== "object" || verdict === null || typeof verdict.ok !== "boolean" || typeof verdict.paired !== "object" || verdict.paired === null || !Array.isArray(verdict.suites)) {
      return { ok: false, reason: "门禁结果形状不对（按安全红线未激活）" };
    }
    return { ok: true, verdict };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
