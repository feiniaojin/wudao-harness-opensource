// M55 §B12 — /agents: the roster listing. Builtins, the plugin layer, the
// GLOBAL tier (`~/.wudao/agents/*.json`, M57), and the workspace files
// (`.wudao/agents/*.json`), each with the pin/write-scope summary the
// dispatch path enforces (frozen roles refuse overrides; writeScope confines
// child writes; worktree/allowShell are spawn-time facts). Shadowing
// receipts render inline — the layering is builtin < plugin < global <
// workspace and every displacement is REPORTED, never silent.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadRoleProfiles, BUILTIN_ROLES } from "@wudao-org/core";
import type { AgentRoleProfile, LoadedRoster, RosterPluginAgent } from "@wudao-org/core";
import { resolveGlobalHome } from "../settings-layer.js";

export type RosterSource = "builtin" | "plugin" | "global" | "workspace";

/** Where one profile came from (derived: builtin ids minus displacements,
 *  the plugin agent ids, the GLOBAL tier's dir listing, and the workspace
 *  dir listing — M57: global-only roles are attributed "global", never
 *  silently relabeled "builtin"). */
export function rosterSources(args: {
  readonly roster: LoadedRoster;
  readonly pluginAgents: readonly RosterPluginAgent[];
  readonly globalIds: readonly string[];
  readonly workspaceIds: readonly string[];
}): Map<string, RosterSource> {
  const out = new Map<string, RosterSource>();
  for (const id of Object.keys(BUILTIN_ROLES)) out.set(id, "builtin");
  for (const { profile } of args.pluginAgents) {
    if (!out.has(profile.id)) out.set(profile.id, "plugin");
  }
  for (const id of args.globalIds) out.set(id, "global");
  for (const id of args.workspaceIds) out.set(id, "workspace");
  // anything still unattributed in the loaded roster keeps its builtin mark
  for (const id of args.roster.profiles.keys()) {
    if (!out.has(id)) out.set(id, "builtin");
  }
  return out;
}

/** The pin/write-scope summary line for one profile. */
export function roleSummary(profile: AgentRoleProfile): string {
  const bits: string[] = [];
  if (profile.frozen === true) bits.push("已冻结（拒绝覆盖）"); // ω99-181: #1
  if (profile.model !== undefined || profile.provider !== undefined || profile.reasoningEffort !== undefined) {
    bits.push(`模型 ${[profile.provider, profile.model, profile.reasoningEffort].filter((x) => x !== undefined).join("/")}`); // ω99-195: #4（181 弧 #1-#3 中文同胞行，本行系漏网）
  }
  if (profile.writeScope !== undefined) {
    const roots = profile.writeScope.roots ?? [];
    const exact = profile.writeScope.exactFiles ?? [];
    bits.push(`写入：${roots.length} 个根+${exact.length} 个精确文件`); // ω99-181: #2
  } else {
    bits.push("写入：（未限定）"); // ω99-181: #3
  }
  if (profile.worktree === true) bits.push("worktree");
  if (profile.allowShell === true) bits.push("allowShell");
  if (profile.maxTurns !== undefined) bits.push(`maxTurns ${profile.maxTurns}`);
  const tools = profile.toolNames !== undefined ? `${profile.toolNames.length} 个工具` : "默认工具集"; // ω99-181: #4
  bits.push(tools);
  return bits.join(" · ");
}

/** The /agents report (notice-rendered). Pure over the loaded roster. */
export function formatRosterReport(args: {
  readonly roster: LoadedRoster;
  readonly pluginAgents: readonly RosterPluginAgent[];
  readonly globalIds: readonly string[];
  readonly workspaceIds: readonly string[];
}): string {
  const sources = rosterSources(args);
  const bySource: Record<RosterSource, AgentRoleProfile[]> = { builtin: [], plugin: [], global: [], workspace: [] };
  for (const profile of args.roster.profiles.values()) {
    const source = sources.get(profile.id) ?? "builtin";
    bySource[source].push(profile);
  }
  const receipts = args.roster.shadowed;
  const lines = [
    // ω99-181: #5 前导 `agents 花名册——`。
    // ω99-181: #6 尾注 `（分层 builtin < plugin < global < workspace；经 task 工具派发）`——中段 ` · N plugin · N global · N workspace` counting 串逐字节保留（m55b:883 约束钉）。
    `agents 花名册——${bySource.builtin.length} builtin · ${bySource.plugin.length} plugin · ${bySource.global.length} global · ${bySource.workspace.length} workspace（分层 builtin < plugin < global < workspace；经 task 工具派发）`,
  ];
  const section = (label: string, profiles: readonly AgentRoleProfile[]): void => {
    if (profiles.length === 0) {
      lines.push(`${label}：（无）`); // ω99-181: #7
      return;
    }
    lines.push(`${label}：`); // ω99-181: #8 全角冒号
    for (const p of profiles) {
      lines.push(`  ${p.id} — ${p.description}`);
      lines.push(`    ${roleSummary(p)}`);
      const displacedBy = receipts.find((r) => r.id === p.id)?.by;
      if (displacedBy !== undefined) lines.push(`    (被取代：${displacedBy})`); // ω99-181: #9
    }
  };
  section("builtin", bySource.builtin);
  section("plugin", bySource.plugin);
  section("global", bySource.global);
  section("workspace", bySource.workspace);
  if (receipts.length > 0) {
    lines.push(`遮蔽回执：${receipts.map((r) => `${r.id} ← ${r.by}`).join("；")}`); // ω99-181: #10
  }
  lines.push('  ("/agents" 只列清单；派发走 task 工具——冻结角色 fail-closed 拒绝模型覆盖)'); // ω99-181: #11
  return lines.join("\n");
}

/** End-to-end /agents: load the roster (builtin + plugin layer + workspace
 *  files) and derive the workspace provenance from the dir listing. */
export async function runAgentsCommand(args: {
  readonly workspaceRoot: string;
  readonly pluginAgents?: readonly RosterPluginAgent[];
}): Promise<string> {
  const roster = await loadRoleProfiles(args.workspaceRoot, {
    pluginAgents: args.pluginAgents ?? [],
    // M57 §1: the global tier's AGENTS dir (~/.wudao/agents).
    globalAgentsDir: join(resolveGlobalHome(), "agents"),
  });
  let workspaceIds: string[] = [];
  try {
    workspaceIds = (await readdir(join(args.workspaceRoot, ".wudao", "agents")))
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -5));
  } catch {
    workspaceIds = [];
  }
  const globalHome = resolveGlobalHome();
  let globalIds: string[] = [];
  try {
    globalIds = (await readdir(join(globalHome, "agents")))
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -5));
  } catch {
    globalIds = [];
  }
  return formatRosterReport({ roster, pluginAgents: args.pluginAgents ?? [], globalIds, workspaceIds });
}
