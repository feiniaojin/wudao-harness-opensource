// M55 §A6 — /config: the effective-settings view, read-only v1. Layers in
// resolution order: the GLOBAL tier (`~/.wudao/settings.json`, M57), the
// PROJECT tier (`.wudao/settings.json`), and the LOCAL tier
// (`.wudao/settings.local.json`, M62 §3 — highest user-editable) — each
// pretty-printed — then the per-key SOURCE annotation of the effective
// merge (global / project / local and their combinations; permissions/hooks
// arrays union across tiers), the `WUDAO_*` env overrides actually set in
// this process (values redacted when the name looks secret-bearing), and
// the argv flags the frontends parse. No secrets in clear text, no network.
//
// M62 §3 fix (review M3): /config gains the one writer the local tier needs
// — `/config set local <key> <value>` persists into settings.local.json
// through saveLocalSettings (whose FIRST write auto-gitignores the file;
// until now that path had no product trigger). The view stays read-only;
// the local tier follows PROJECT TRUST, so escalation keys are refused at
// the writer exactly as the loader's gate refuses them on read.
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { readFile } from "node:fs/promises";
import { loadLayeredSettings, globalSettingsPath, projectSettingsPath, localSettingsPath, saveLocalSettings, isProjectForbiddenKey } from "../settings-layer.js";
import { parseSessionFlags, parseSandboxFlags, parsePlanFlag, parseProviderFlags } from "../args.js";

const SETTINGS_MAX_CHARS = 4_000;

/** Env var names whose VALUE must never print (presence is enough). */
function isSecretishName(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name);
}

export interface ConfigReportInput {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
}

function prettySection(record: Readonly<Record<string, unknown>>, missingLabel: string): string {
  if (Object.keys(record).length === 0) return `  （${missingLabel}）`; // ω99-182: 外层括号全角（钉 m55:247/§四B 整体形锁步——面表派生，报告披露）
  const pretty = JSON.stringify(record, null, 2);
  const body = pretty.length > SETTINGS_MAX_CHARS ? `${truncateSafe(pretty, SETTINGS_MAX_CHARS)}\n  （… 还有 ${pretty.length - SETTINGS_MAX_CHARS} 字符）` : pretty; // ω99-182: #1
  return body
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/** Sorted `WUDAO_*` env vars actually set (secret-shaped values redacted). */
export function formatEnvOverrides(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith("WUDAO_") && (env[k] ?? "") !== "")
    .sort()
    .map((k) => `  ${k}=${isSecretishName(k) ? "（已设置）" : String(env[k])}`); // ω99-182: #2
}

/** The argv flags this CLI parses, as label lines (absent flags stay off).
 *  ω99-182: env 接线（可选参，默认 {}——存量一参调用不变）：镜像标注要能看到
 *  WUDAO_SANDBOX_IMAGE，reports A2 依赖形（原先硬编码 {} 使 :63 分支不可达）。 */
export function formatFlagOverrides(argv: readonly string[], env: NodeJS.ProcessEnv = {}): string[] {
  const out: string[] = [];
  const session = parseSessionFlags(argv);
  if (session.resumeId !== undefined) out.push(`  --resume ${session.resumeId}`);
  if (session.cont) out.push("  --continue");
  if (session.list) out.push("  --list-sessions");
  const provider = parseProviderFlags(argv);
  if (provider.provider !== undefined) out.push(`  --provider ${provider.provider}`);
  if (provider.reasoningEffort !== undefined) out.push(`  --reasoning-effort ${provider.reasoningEffort}`);
  const sandbox = parseSandboxFlags(argv, env); // ω99-182: env 接线（镜像标注可达）
  if (sandbox.enabled) out.push(`  --sandbox${sandbox.image !== undefined ? `（镜像 ${sandbox.image}）` : ""}`); // ω99-182: #3
  if (parsePlanFlag(argv)) out.push("  --plan");
  if (argv.includes("--no-tui")) out.push("  --no-tui");
  if (argv.includes("--quiet")) out.push("  --quiet");
  return out;
}

/** The /config report (notice-rendered; read-only). */
export async function buildConfigReport(input: ConfigReportInput): Promise<string> {
  const env = input.env ?? process.env;
  const argv = input.argv ?? process.argv;
  const layered = await loadLayeredSettings(input.workspaceRoot, undefined, env);
  const lines: string[] = ["配置（生效值，只读）："]; // ω99-182: #4
  lines.push(`全局层 settings（${globalSettingsPath(env)}）：`); // ω99-184: #1
  lines.push(prettySection(layered.global, "无全局设置——用默认值")); // ω99-182: #5
  lines.push(`项目层 settings（${projectSettingsPath(input.workspaceRoot)}）：`); // ω99-184: #2
  lines.push(prettySection(layered.project, "无 .wudao/settings.json")); // ω99-182: #6
  // M62 §3: the local tier — highest user-editable, same trust gate.
  lines.push(`本地层 settings（${localSettingsPath(input.workspaceRoot)}）：`); // ω99-184: #3
  lines.push(prettySection(layered.local, "无 .wudao/settings.local.json")); // ω99-182: #7
  // M57 §1 + M62 §3: per-key source annotation of the effective merge.
  // Array-merged keys (permissions/hooks) show every tier that set them.
  const keys = Object.keys(layered.keySources).sort();
  lines.push("生效键来源："); // ω99-182: #8
  lines.push(
    ...(keys.length > 0
      ? keys.map((k) => `  ${k}: ${layered.keySources[k]}`)
      : ["  （无设置键——用默认值）"]), // ω99-182: #9
  );
  lines.push("环境变量覆盖（WUDAO_*）："); // ω99-182: #10
  const envLines = formatEnvOverrides(env);
  lines.push(...(envLines.length > 0 ? envLines : ["  （未设置）"])); // ω99-182: #11
  lines.push("命令行覆盖："); // ω99-182: #12
  const flagLines = formatFlagOverrides(argv, env); // ω99-182: env 接线（镜像标注可达）
  lines.push(...(flagLines.length > 0 ? flagLines : ["  （无）"])); // ω99-182: #13
  lines.push("（视图只读——/config set local <key> <value> 写 local 层（首次写入自动 gitignore）；permissions/hooks 热加载；prompt 级改动需重启会话）"); // ω99-182: #14
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// M62 §3 — the local-tier writer: `/config set local <key> <value>`.
// ---------------------------------------------------------------------------

/** Parse a set value: JSON when it parses (arrays/objects/numbers/bools —
 *  e.g. fallbackModel ["m-a","m-b"]), else the raw string. */
function parseSetValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function readLocalRecord(workspaceRoot: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(localSettingsPath(workspaceRoot), "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    /* absent or malformed — a fresh record starts the file over */
  }
  return {};
}

async function runConfigSetLocal(workspaceRoot: string, rest: string): Promise<string> {
  const parts = rest.split(/\s+/);
  const key = parts[0] ?? "";
  const valueRaw = parts.slice(1).join(" ");
  if (key === "" || valueRaw === "") {
    return "用法：/config set local <key> <value>（value=能解析为 JSON 就用 JSON，否则按字符串）"; // ω99-166d-i: #30
  }
  // LOCAL FOLLOWS PROJECT TRUST (§3 ruling): the file lives in the project
  // directory, so a clone can carry it — the writer refuses the same
  // escalation keys the loader's gate drops, plus the sidecar.enabled:false
  // relaxation. Writing them by hand would just warn on every load.
  if (isProjectForbiddenKey(key)) {
    return `⚠️ "${key}" 是提权键——settings.local.json 随项目信任；请改在全局层 settings.json 设置`; // ω99-177: #6
  }
  const value = parseSetValue(valueRaw);
  if (key === "sidecar" && typeof value === "object" && value !== null && (value as Record<string, unknown>)["enabled"] === false) {
    return '⚠️ sidecar.enabled:false 会解除 auto 模式分类器——可克隆层只能收紧、不能放宽安全门'; // ω99-177: #7
  }
  const record = await readLocalRecord(workspaceRoot);
  record[key] = value;
  const saved = await saveLocalSettings(workspaceRoot, record);
  const how = saved.created // ω99-177: #8
    ? (saved.gitignored ? "已创建并已 gitignore" : "已创建（⚠️ 请自行把 .wudao/settings.local.json 加入 .gitignore）")
    : "已更新";
  return `已保存 ${key} → ${saved.path}（${how}；下一会话生效——prompt/工具字节在会话内冻结）`; // ω99-177: #9
}

/** The /config command: bare = the read-only report; `set local <k> <v>` =
 *  the M62 §3 local-tier writer. Returns the notice/render text. */
export async function runConfigCommand(input: ConfigReportInput & { readonly args?: string }): Promise<string> {
  const args = (input.args ?? "").trim();
  if (args === "") return buildConfigReport(input);
  if (args === "set" || args.startsWith("set ")) {
    const rest = args === "set" ? "" : args.slice("set".length).trim();
    if (!rest.startsWith("local")) {
      return "用法：/config set local <key> <value>（只有 local 层可写；视图保持只读）"; // ω99-166d-i: #31
    }
    return runConfigSetLocal(input.workspaceRoot, rest.slice("local".length).trim());
  }
  return "用法：/config [set local <key> <value>]（裸 /config=只读生效配置视图）"; // ω99-166d-i: #32
}
