// P1-5 (96 队列) — /trust: the workspace trust gate's command face. ONE
// grammar, two frontends (the driver's case routes here, the REPL's branch
// calls the same runner):
//   /trust          → status: the covering decision, the detected
//                     trust-requiring project resources, suppression, usage
//   /trust accept   → write true under the CANONICAL workspace key +
//                     hot-rescan (skills/plugins/hooks swap at the turn
//                     boundary; permission allow/ask re-loads within the
//                     watcher's 1s revalidation window)
//   /trust revoke   → delete the key (back to fail-closed) + rescan
//
// Lives in commands/ (the command-face pattern) next to plugins-command.ts:
// the runner needs rescanExtensions (extension-state) and trust.ts, while
// extension-state imports the loaders — keeping this out of trust.ts avoids
// an extension-state ⇄ trust cycle. Config-only, busy-safe (the /plugin
// precedent): the writes touch ~/.wudao/trust.json, never a run's files.
import {
  formatTrustGateNotice,
  setTrustDecision,
  trustGateStatus,
} from "../trust.js";
import { rescanExtensions } from "../extension-state.js";

/** The rescan seam's shape (extension-state.rescanExtensions); injectable so
 *  tests never touch the process's real extension runtime. */
export type TrustRescanFn = () => Promise<{ readonly skills: number; readonly plugins: number; readonly hooks: number }>;

export interface RunTrustCommandArgs {
  readonly cwd: string;
  /** The raw arg string after "/trust" ("" | "accept" | "revoke" — the parse
   *  layer's exact-match grammar; junk here answers with usage). */
  readonly args: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly rescan?: TrustRescanFn;
}

/** Run /trust. Pure-ish (reads the store, writes only on accept/revoke);
 *  never throws — failures land in the receipt text (both frontends render
 *  notices, not error channels). */
export async function runTrustCommand(args: RunTrustCommandArgs): Promise<string> {
  const env = args.env ?? process.env;
  const verb = args.args.trim();

  if (verb === "") return trustStatusText(args.cwd, env);

  if (verb === "accept" || verb === "revoke") {
    const status = trustGateStatus(args.cwd, env);
    const already = verb === "accept" ? status.decision === true : status.decision === null;
    if (already) {
      return verb === "accept"
        ? `✅ workspace already trusted (${args.cwd}) — nothing to do`
        : `ℹ️ no trust decision recorded for ${args.cwd} — already fail-closed`;
    }
    try {
      setTrustDecision(args.cwd, verb === "accept" ? true : null, env);
    } catch (err) {
      return `⚠️ /trust ${verb} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    let rescanNote = "";
    const rescan = args.rescan ?? rescanExtensions;
    try {
      const counts = await rescan();
      rescanNote = ` — rescan: ${counts.skills} skills · ${counts.plugins} plugins · ${counts.hooks} hooks (permission allow rules follow within ~1s)`;
    } catch (err) {
      rescanNote = ` — rescan failed (${err instanceof Error ? err.message : String(err)}); restart the session to apply the trust change`;
    }
    return verb === "accept"
      ? `✅ workspace trusted — project skills/plugins/allow/hooks load from now on${rescanNote}`
      : `🔒 trust revoked — back to fail-closed: project skills/plugins/permission-allow/hooks suppressed until /trust accept${rescanNote}`;
  }

  return [
    "用法：/trust——工作区信任门", // ω99-166d-i: #23
    "  /trust          status (decision, detected project resources, suppression)",
    "  /trust accept   trust this workspace (loads project skills/plugins/allow/hooks)",
    "  /trust revoke   drop the decision (back to fail-closed)",
    "(headless: start with --trust-workspace for a one-run trust)",
  ].join("\n");
}

function trustStatusText(cwd: string, env: NodeJS.ProcessEnv): string {
  const status = trustGateStatus(cwd, env);
  const lines: string[] = [];
  lines.push(`workspace: ${cwd}`);
  if (status.decision === true) lines.push("decision: trusted (accept recorded)");
  else if (status.decision === false) lines.push("decision: explicitly distrusted (revoked)");
  else lines.push("decision: none recorded (fail-closed)");
  if (status.resources.length > 0) {
    lines.push(`project resources detected (${status.resources.length}):`);
    for (const r of status.resources) lines.push(`  - ${r}`);
  } else {
    lines.push("project resources detected: none (the gate is inert here)");
  }
  if (status.effectiveSuppressed) {
    lines.push(formatTrustGateNotice(status));
    lines.push("user-global tiers (~/.wudao, ~/.claude) are never affected; deny rules always apply");
  } else {
    lines.push("suppression: off (the full project surface loads)");
  }
  lines.push("用法：/trust accept · /trust revoke（headless：--trust-workspace）"); // ω99-166d-i: #24
  return lines.join("\n");
}
