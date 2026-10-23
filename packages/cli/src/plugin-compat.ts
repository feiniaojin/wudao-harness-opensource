// 插件兼容扩展层（plugin-compat）：让 wudao 直接装载 CCB 家族
// （Claude-Code-Bridge 系上游 harness）生态的插件包。我们的原生格式是
// `.claude-plugin/plugin.json`（M36）；上游家族的插件是 npm 形态的包目录 —
// `package.json` 携带 `dsh` 声明成员（bundle/profile/client 编排）或
// `engines.dsh` 运行时版本要求。两种格式在这里声明式分流：
//
//   claude-plugin（我们的格式） → plugins.ts 的既有装载路径（不变）
//   ccb-family（上游包格式）    → 本模块：清单归一化 + 目录约定适配 +
//                                 未知字段宽容降级（warn 不 fail）
//
// 适配原则与 M36 同一条法律：插件是配置包，不是程序。上游包的运行时声明
// （dsh.bundle 编排层、dsh.client 客户端模块、locale/ 展示文案、依赖表）
// 在本装载器下**一律不执行、不安装**，逐项 warn 说明；能只读映射的静态资
// 产（技能/命令/agents/hooks/MCP）照常进入既有五装载器。上游技能目录约
// 定的差异在此归一化：`skills/<name>/SKILL.md`（两族相同）+ 扁平
// `skills/<name>.md`（上游 skill-filesystem 允许）+ `assets/<name>/SKILL.md`
// （上游捆绑技能目录）；frontmatter 的 camelCase `whenToUse` 归一化为
// `when-to-use` 后再解析（模型读到的 content 保持原字节）。
//
// 为未来兼容更多融合项目的插件，格式判定集中在 isCcbFamilyManifest 一个
// 纯函数里：新的家族标记 = 一个新的判定分支 + 一段装载适配，五装载器与
// 安装引擎（marketplace.pluginInstallLocal）不动。
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { loadSkillsUnderDir, parseSkillFrontmatter } from "./skills.js";
import type { LoadedSkill } from "./skills.js";
import {
  loadPluginCommands, loadPluginAgents, loadPluginMcp, loadPluginHooks, scanUnsupportedAssets, isDir,
} from "./plugin-loaders.js";
import { isRecord } from "./marketplace-source.js";
import type { LoadedPlugin } from "./plugins.js";

/** 插件清单格式。absent ≡ "claude-plugin"（M36 既有装载路径的缺省）。 */
export type PluginFormat = "claude-plugin" | "ccb-family";

// ---------------------------------------------------------------------------
// 格式判定与名字归一化（纯函数，测试直钉）
// ---------------------------------------------------------------------------

/** package.json 是否携带 CCB 家族插件标记：顶层 `dsh` 声明成员（bundle/
 *  profile/client 编排的伞键），或顶层 `engines.dsh` 运行时版本要求。二者
 *  任一出现即按上游包格式装载；普通 npm 包（无标记）不是插件 — 宁可漏
 *  装不可误装（.wudao/plugins 里躺着一个依赖包不应变成插件）。 */
export function isCcbFamilyManifest(pkg: Record<string, unknown>): boolean {
  const dsh = pkg["dsh"];
  if (typeof dsh === "object" && dsh !== null && !Array.isArray(dsh)) return true;
  const engines = pkg["engines"];
  if (typeof engines === "object" && engines !== null && !Array.isArray(engines)) {
    const dshEngine = (engines as Record<string, unknown>)["dsh"];
    if (typeof dshEngine === "string" && dshEngine !== "") return true;
  }
  return false;
}

/** npm 包名 → 插件名/安装目录名：作用域包 `@scope/name` 去掉 `@`、`/`
 *  折叠为 `-`（`@acme/my-plug` → `acme-my-plug`）；非作用域名原样。安装
 *  侧与装载侧共用本函数，两端对同一包目录永远得出同一个名字。 */
export function ccbPluginName(packageName: string): string {
  if (packageName.startsWith("@") && packageName.includes("/")) {
    return packageName.slice(1).replace(/\//g, "-");
  }
  return packageName;
}

/** 上游技能 frontmatter 的 camelCase 键归一化（仅解析层）：首段
 *  frontmatter 内行首的 `whenToUse:` 改写为 `when-to-use:`。body 与非
 *  frontmatter 区不动；LoadedSkill.content 落的是磁盘原字节，模型所见
 *  不变。 */
export function normalizeCcbSkillFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return text;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") break;
    lines[i] = /^whenToUse([ \t]*):/.test(line) ? line.replace(/^whenToUse([ \t]*):/, "when-to-use$1:") : line;
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 装载：上游包格式 → LoadedPlugin
// ---------------------------------------------------------------------------

/** `dsh` 声明成员里认识的子键；其余子键 warn 后忽略（宽容降级）。 */
const CCB_DSH_KEYS: ReadonlySet<string> = new Set(["manifestVersion", "bundle", "profile", "client"]);

/** 依赖表类 package.json 字段（存在即提示「不安装」）。 */
const DEP_SECTIONS: readonly string[] = ["dependencies", "peerDependencies", "optionalDependencies"];

/** 装载一个 CCB 家族插件包目录。返回 undefined = 不是上游包格式（无
 *  package.json、JSON 坏、或无家族标记 — 无标记时静默，让调用方报「不是
 *  插件」）；是标记包但身份不合法（无 name/名字不可作目录名）→ 直接 warn
 *  并跳过。致命问题 warn、资产级问题进 plugin.warnings，与 plugins.ts 的
 *  loadOnePlugin 同一对齐。 */
export function loadCcbFamilyPlugin(
  dir: string,
  workspaceRoot: string,
  source: "plugins-dir" | "flag",
  warn: (msg: string) => void,
  scope: "project" | "user" | "flag",
): LoadedPlugin | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, "package.json"), "utf8");
  } catch {
    return undefined; // 无 package.json → 交给调用方报「不是插件」
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(`plugin ${dir}: package.json is not valid JSON (${err instanceof Error ? err.message : String(err)}); skipping plugin`);
    return undefined;
  }
  if (!isRecord(parsed) || !isCcbFamilyManifest(parsed)) return undefined; // 普通 npm 包，不是插件

  const rawName = parsed["name"];
  if (typeof rawName !== "string" || rawName === "") {
    warn(`plugin ${dir}: package.json must carry a string "name"; skipping plugin`);
    return undefined;
  }
  const name = ccbPluginName(rawName);
  if (name !== rawName) {
    warn(`plugin ${dir}: scoped package name "${rawName}" normalized to "${name}" (目录与插件名)`);
  }
  // 名字要当安装目录名用（marketplace.isSafeName 同一约束）；不合法即整包跳过
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    warn(`plugin ${dir}: package name "${rawName}" is not a safe plugin directory name (letter/digit first, then [A-Za-z0-9._-], ≤64 chars); skipping plugin`);
    return undefined;
  }

  const warnings: string[] = [];
  warnIgnoredDeclarations(dir, parsed, name, warnings);
  const skills = loadCcbFamilySkills(dir, workspaceRoot, name, scope, warnings);
  const commands = loadPluginCommands(dir, name, warnings);
  const agents = loadPluginAgents(dir, name, warnings);
  const mcpServers = loadPluginMcp(dir, name, warnings);
  const hooks = loadPluginHooks(dir, name, warnings);
  scanUnsupportedAssets(dir, name, warnings);

  const version = parsed["version"];
  const description = parsed["description"];
  return {
    name,
    ...(typeof version === "string" && version !== "" ? { version } : {}),
    ...(typeof description === "string" ? { description } : {}),
    dir,
    source,
    scope,
    format: "ccb-family",
    skills,
    commands,
    agents,
    mcpServers,
    hooks,
    warnings,
  };
}

/** 逐项说明「看不懂/不执行」的上游声明（warn 不 fail）。语义性声明各一条；
 *  `dsh` 下未识别子键合并一条；npm 展示类字段（keywords/homepage/
 *  repository/author）静默 — 对它们 warn 只会淹没真信号。 */
function warnIgnoredDeclarations(dir: string, pkg: Record<string, unknown>, plugin: string, warnings: string[]): void {
  const dsh = pkg["dsh"];
  if (isRecord(dsh)) {
    if (isRecord(dsh["bundle"])) {
      warnings.push(`plugin ${plugin}: runtime bundle declaration (dsh.bundle) is not executed here — 插件按配置包映射，静态资产照常装载`);
    }
    if (isRecord(dsh["client"])) {
      warnings.push(`plugin ${plugin}: client module declaration (dsh.client) is not executed; ignored`);
    }
    if (isRecord(dsh["profile"])) {
      warnings.push(`plugin ${plugin}: profile composition declaration (dsh.profile) has no wudao counterpart; ignored`);
    }
    const unknown = Object.keys(dsh).filter((key) => !CCB_DSH_KEYS.has(key) && dsh[key] !== undefined);
    if (unknown.length > 0) {
      warnings.push(`plugin ${plugin}: unknown declaration field(s) ${unknown.join(", ")} under "dsh" (宽容降级：warn 后忽略)`);
    }
    const manifestVersion = dsh["manifestVersion"];
    if (manifestVersion !== undefined && manifestVersion !== 1) {
      warnings.push(`plugin ${plugin}: dsh.manifestVersion ${JSON.stringify(manifestVersion)} is not 1; 按已知字段尽力装载`);
    }
  }
  const engines = isRecord(pkg["engines"]) ? (pkg["engines"] as Record<string, unknown>)["dsh"] : undefined;
  if (typeof engines === "string" && engines !== "") {
    warnings.push(`plugin ${plugin}: engines.dsh "${engines}" 表达的是上游运行时的版本语义，本装载器不校验；ignored`);
  }
  if (typeof pkg["icon"] === "string" && pkg["icon"] !== "") {
    warnings.push(`plugin ${plugin}: icon "${pkg["icon"]}" 为展示元数据; ignored`);
  }
  if (isDir(join(dir, "locale"))) {
    warnings.push(`plugin ${plugin}: locale/ 展示文案在本装载器下不使用; ignored`);
  }
  const depSections = DEP_SECTIONS.filter((key) => {
    const value = pkg[key];
    return isRecord(value) && Object.keys(value).length > 0;
  });
  if (depSections.length > 0) {
    warnings.push(`plugin ${plugin}: ${depSections.join(", ")} 不安装（插件代码永不执行）；技能脚本若依赖它们，需工作区自行满足`);
  }
}

// ---------------------------------------------------------------------------
// 技能目录约定适配：skills/<name>/SKILL.md + skills/<name>.md + assets/<name>/SKILL.md
// ---------------------------------------------------------------------------

/** 与 skills.ts 的 M57 规则同一条契约（该处的 skillRelPath 未导出；此处
 *  按同一语义内联，避免为兼容层扩改 skills 模块的公共面）：工作区内取
 *  工作区相对 posix 路径，工作区外保留绝对路径。 */
function pluginSkillRelPath(workspaceRoot: string, filePath: string): string {
  const toPosix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"));
  const rel = toPosix(relative(workspaceRoot, filePath));
  return rel.startsWith("../") || rel === ".." || /^[A-Za-z]:\//.test(rel) ? toPosix(filePath) : rel;
}

/** 扁平 `skills/<name>.md` → LoadedSkill（上游 skill-filesystem 允许扁平
 *  文件；我们的原生约定只有目录包）。frontmatter 要求与上游一致：`name`
 *  必填（缺名 warn + 跳过）；camelCase whenToUse 先归一化。 */
function loadFlatSkillFiles(
  root: string,
  workspaceRoot: string,
  plugin: string,
  scope: "project" | "user" | "flag",
  warnings: string[],
): readonly LoadedSkill[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // 无 skills 目录 → 无扁平技能
  }
  const out: LoadedSkill[] = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(root, entry.name);
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue; // 读不动 → 跳过该文件
    }
    const fm = parseSkillFrontmatter(normalizeCcbSkillFrontmatter(text));
    if (fm.name === undefined) {
      warnings.push(`skill ${filePath} has no "name:" in its frontmatter; skipping it`);
      continue;
    }
    if (fm.unsupported !== undefined) {
      warnings.push(`skill ${filePath}: ignoring unsupported frontmatter field(s): ${fm.unsupported.join(", ")} (no wudao mechanism yet)`);
    }
    out.push({
      name: fm.name,
      description: fm.description,
      filePath,
      relPath: pluginSkillRelPath(workspaceRoot, filePath),
      content: text, // 磁盘原字节 — camelCase 归一化只发生在解析层
      origin: "plugin",
      ...(fm.hooks !== undefined ? { hooks: fm.hooks } : {}),
      ...(fm.context !== undefined ? { context: fm.context } : {}),
      ...(fm.disableModelInvocation !== undefined ? { disableModelInvocation: fm.disableModelInvocation } : {}),
      ...(fm.agent !== undefined ? { agent: fm.agent } : {}),
      ...(fm.approvalGate !== undefined ? { approvalGate: fm.approvalGate } : {}),
      ...(fm.whenToUse !== undefined ? { whenToUse: fm.whenToUse } : {}),
      ...(fm.argumentHint !== undefined ? { argumentHint: fm.argumentHint } : {}),
      ...(fm.userInvocable !== undefined ? { userInvocable: fm.userInvocable } : {}),
      ...(fm.paths !== undefined ? { paths: fm.paths } : {}),
      ...(fm.allowedTools !== undefined ? { allowedTools: fm.allowedTools } : {}),
      ...(fm.disallowedTools !== undefined ? { disallowedTools: fm.disallowedTools } : {}),
      ...(fm.argumentsDecl !== undefined ? { argumentsDecl: fm.argumentsDecl } : {}),
      plugin,
      pluginScope: scope,
    });
  }
  return out;
}

/** 上游技能目录三源合一：目录包（skills/ + assets/，共用 loadSkillsUnderDir
 *  + camelCase 归一化改写）与扁平文件（skills/*.md）。跨源同名：先到先得
 *  + warn（skills/ 优先于 assets/，目录包优先于同名扁平文件）。 */
function loadCcbFamilySkills(
  dir: string,
  workspaceRoot: string,
  plugin: string,
  scope: "project" | "user" | "flag",
  warnings: string[],
): readonly LoadedSkill[] {
  const byName = new Map<string, LoadedSkill>();
  const add = (loaded: readonly LoadedSkill[], from: string): void => {
    for (const raw of loaded) {
      const skill = { ...raw, pluginScope: scope };
      const existing = byName.get(skill.name);
      if (existing) {
        warnings.push(`plugin ${plugin}: skill name "${skill.name}" already loaded from ${existing.filePath}; skipping ${skill.filePath} (${from})`);
        continue;
      }
      byName.set(skill.name, skill);
    }
  };
  const rewrite = { frontmatterRewrite: normalizeCcbSkillFrontmatter };
  add(loadSkillsUnderDir(join(dir, "skills"), workspaceRoot, (m) => warnings.push(m), plugin, undefined, rewrite), "skills/");
  add(loadFlatSkillFiles(join(dir, "skills"), workspaceRoot, plugin, scope, warnings), "skills/*.md");
  add(loadSkillsUnderDir(join(dir, "assets"), workspaceRoot, (m) => warnings.push(m), plugin, undefined, rewrite), "assets/");
  return [...byName.values()];
}
