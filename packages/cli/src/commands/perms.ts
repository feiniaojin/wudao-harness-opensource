// `wudao perms lint` — the perms subcommand's own module（commands/ 家族形，
// plugin/workflow 同款）。M52 §2 原语义逐字迁入：对 settings 的 permissions
// 节点做纯 lint——不可达规则（被同层更早的规则遮蔽、被 deny-first 分层杀
// 死、或被匹配的 ask 中和）。只报告、不自动修；有发现 exit 1 让 CI 可门控。
// M58-C: lint 跑两层 UNION 并按层归因——一条发现点名真正含有该规则的文件
// （全局 ~/.wudao vs 项目 .wudao）。行为与迁出前逐字节一致（纯搬家）。
import { join } from "node:path";
import { loadPermissionTiers } from "../permission.js";
import { lintPermissionRules, formatLintReport } from "../perms-lint.js";
import { stdoutGuard } from "../output-guard.js";

/** Run the subcommand. Exits the process on the lint-verdict paths (the
 *  caller's dispatch just awaits this and returns). */
export async function permsCommandMain(args: readonly string[]): Promise<void> {
  if (args[0] !== "lint") {
    stdoutGuard.writeRawStdout("用法：wudao perms lint\n"); // ω99-166d-i: #9
    await stdoutGuard.flushRawStdout();
    process.exit(args[0] === undefined ? 0 : 1);
    return;
  }
  const tiers = await loadPermissionTiers(process.cwd(), (m) => stdoutGuard.writeRawStdout(`${m}\n`));
  const globalFile = join(tiers.globalHome, "settings.json");
  const findings = lintPermissionRules(tiers.effective, { global: tiers.global, project: tiers.project, globalFile });
  stdoutGuard.writeRawStdout(`${formatLintReport(findings, { globalFile })}\n`);
  if (findings.length > 0) {
    await stdoutGuard.flushRawStdout();
    process.exit(1);
  }
}
