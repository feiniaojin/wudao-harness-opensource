// det-52 — the cc-plugins compatibility surface pinned END TO END at the real
// seams (fixture level, zero network, zero model). One suite walks the whole
// Batch A-E story a CC plugin author would recognize:
//
//   §1 marketplace lifecycle — a local fixture MARKET (a real git repo cloned
//      over file://, exactly how the cli tests ride the clone path) goes add →
//      list (entries discovered) → install (BOTH scopes) → disable/enable →
//      uninstall → update (upstream commit advances) → remove (CASCADE
//      uninstalls its plugins, clears the market dir, the registry line, and
//      the enabledPlugins keys).
//   §2 frontmatter superset — a plugin skill carrying the CC fields
//      (when_to_use snake form, argument-hint, user-invocable, block-list
//      allowed-tools / arguments) loads with every field surfaced and the
//      whenToUse line merged into the <available_skills> manifest; a
//      paths-gated skill drops out of the manifest for a non-matching file
//      while staying invocable.
//   §3 substitutions + injections — a plugin command's $ARGUMENTS/$0 expand
//      (buildPluginCommandMessage); a skill's $ARGUMENTS/$N/declared-$name/
//      \$-escape matrix expands (buildSubstitutedSkillMessage, injections kept
//      literal); a !`cmd` injection RUNS for a user-scope plugin (trusted
//      tier, no gate consulted) and is REFUSED for a project-scope plugin
//      (denied by the gate / fail-closed without one) yet runs once the gate
//      allows — the marker files prove what actually executed.
//   §4 three slash forms — parseReplCommand resolves /<name> (workspace
//      tier), /<plugin>:<skill> (namespaced plugin tier), and the legacy
//      /skill:<name> alias onto the right skill; listSlashCommands labels each
//      origin (workspace / plugin: <name>); a bare /<plugin-skill-name> is NOT
//      a skill invocation.
//   §5 hooks mapping — a hooks/hooks.json written in CC event names
//      (SessionStart w/ "startup|resume" matcher, UserPromptSubmit, Stop,
//      PreToolUse w/ "Write|Edit", PostToolUse, SubagentStop) compiles onto
//      the canonical on* faces through HOOK_EVENT_MAP; TeammateIdle (no CC
//      spelling — the E1 exclusion) warns and compiles NOTHING.
//   §6 cache invariant — across a rescanExtensions fired right after a REAL
//      pluginInstall, the system prompt minus the trailing <available_skills>
//      manifest is byte-for-byte identical before/after; the new skills only
//      append manifest lines at the tail (A3's law).
//   §7 object-form sources — a fixture .claude-plugin/marketplace.json whose
//      entries use CC's OBJECT sources ({source:"url",url}, {source:"git",
//      url,ref}, {source:"github",owner,repo}) yields installable entries
//      (E1b: normalized into the string grammar; the url/git forms install
//      over file:// for real, the github form normalizes to owner/repo).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  marketplaceAdd,
  marketplaceList,
  marketplaceRemove,
  marketplaceUpdate,
  pluginEnable,
  pluginInstall,
  pluginListInstalled,
  pluginUninstall,
  readMarketplaceFile,
  type PluginEngineDeps,
} from "wudao-harness/marketplace";
import { HOOK_EVENT_MAP, appendPluginSkills, buildPluginCommandMessage, collectPluginCommands, loadPlugins } from "wudao-harness/plugins";
import {
  buildExpandedSkillMessage,
  buildSubstitutedSkillMessage,
  findNonPluginSkill,
  findPluginSkill,
  findSkill,
  gateSkillsForPath,
  loadSkills,
  skillsPromptSection,
  type LoadedSkill,
} from "wudao-harness/skills";
import { buildSystemPrompt } from "wudao-harness/prompt";
import { parseReplCommand } from "wudao-harness/repl";
import { listSlashCommands } from "wudao-harness/slash-commands";
import {
  buildExtensionState,
  getExtensionState,
  initExtensionRuntime,
  registerExtensionSwapSink,
  resetExtensionRuntime,
  rescanExtensions,
} from "wudao-harness/extension-state";
import type { EvalDefinition } from "../runner.js";

const quiet = (): void => {};

/** Deterministic fixture commits (fixed author/committer dates), matching the
 *  cli marketplace tests — branch-name-proof init + a repo-local identity. */
const GIT_DATES = { GIT_AUTHOR_DATE: "2026-01-01T00:00:00.000Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00.000Z" };

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_DATES }, stdio: "pipe" });
}

function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(dir, ["config", "user.name", "wudao-det52"]);
  git(dir, ["config", "user.email", "det52@example.com"]);
  // Byte-faithful checkouts regardless of the operator's global autocrlf
  // (a `true` machine rewrites LF→CRLF on checkout and breaks every
  // newline-sensitive marker assertion).
  git(dir, ["config", "core.autocrlf", "false"]);
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", message]);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

// ---------------------------------------------------------------------------
// Fixture builders — everything lives under tmpdirs, nothing touches $HOME.
// ---------------------------------------------------------------------------

/** plugins/cc-superset — the CC superset plugin: frontmatter-matrix skill,
 *  paths-gated skill, one /deploy command, hooks in CC event names. */
function buildSupersetPlugin(marketRoot: string): void {
  const p = join(marketRoot, "plugins", "cc-superset");
  writeJson(join(p, ".claude-plugin", "plugin.json"), { name: "cc-superset", version: "1.4.2", description: "the det-52 superset fixture" });
  writeText(
    join(p, "skills", "cc-matrix", "SKILL.md"),
    [
      "---",
      "name: cc-matrix",
      "description: The CC frontmatter superset",
      "when_to_use: a superset field matrix is needed",
      "argument-hint: <topic> [details]",
      "user-invocable: false",
      "allowed-tools:",
      "  - Read",
      "  - Grep",
      "arguments:",
      "  - topic",
      "  - details",
      "---",
      "",
      "cc-matrix body.",
      "",
    ].join("\n"),
  );
  writeText(
    join(p, "skills", "path-gated", "SKILL.md"),
    [
      "---",
      "name: path-gated",
      "description: Only while editing TypeScript",
      "paths:",
      '  - "**/*.ts"',
      "---",
      "",
      "gated body.",
      "",
    ].join("\n"),
  );
  writeText(
    join(p, "commands", "deploy.md"),
    ["---", "description: Deploy the fixture", "---", "", "Deploy $ARGUMENTS now (target: $0).", ""].join("\n"),
  );
  writeJson(join(p, "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "echo det52-session-start" }] }],
      UserPromptSubmit: [{ type: "command", command: "echo det52-ups" }],
      Stop: [{ type: "command", command: "echo det52-stop" }],
      PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "echo det52-pre" }] }],
      PostToolUse: [{ type: "command", command: "echo det52-post" }],
      SubagentStop: [{ type: "command", command: "echo det52-substop" }],
      TeammateIdle: [{ type: "command", command: "echo det52-bogus" }],
    },
  });
  writeText(join(p, "marker.txt"), "v1\n");
}

/** plugins/dyn-user (installed user-scope → the TRUSTED injection tier) and
 *  plugins/dyn-proj (project-scope → the gated tier). */
function buildDynPlugins(marketRoot: string, ws: string): void {
  const user = join(marketRoot, "plugins", "dyn-user");
  writeJson(join(user, ".claude-plugin", "plugin.json"), { name: "dyn-user", version: "3.0.0" });
  writeText(
    join(user, "skills", "dyn-subst", "SKILL.md"),
    [
      "---",
      "name: dyn-subst",
      "description: substitution matrix",
      "arguments:",
      "  - topic",
      "  - details",
      "---",
      "",
      "ALL=$ARGUMENTS FIRST=$0 SECOND=$1 T1=$topic T2=$details MISS=$9 ESC=\\$ARGUMENTS",
      "",
    ].join("\n"),
  );
  writeText(
    join(user, "skills", "user-inject", "SKILL.md"),
    [
      "---",
      "name: user-inject",
      "description: user-scope dynamic injection",
      "---",
      "",
      "Hello $ARGUMENTS.",
      // The embedded path is a POSIX sh redirect target — single-quote it so
      // win32 backslash separators survive (an unquoted C:\… loses every \).
      `Trusted tier executed: !\`echo det52-user-ran > '${join(ws, "det52-user-ran.txt")}' && echo det52-user-yes\``,
      "",
    ].join("\n"),
  );
  const proj = join(marketRoot, "plugins", "dyn-proj");
  writeJson(join(proj, ".claude-plugin", "plugin.json"), { name: "dyn-proj" });
  writeText(
    join(proj, "skills", "proj-inject", "SKILL.md"),
    [
      "---",
      "name: proj-inject",
      "description: project-scope dynamic injection",
      "---",
      "",
      "Hello $ARGUMENTS.",
      `Untrusted tier executed: !\`echo det52-proj-ran > '${join(ws, "det52-proj-ran.txt")}' && echo det52-proj-yes\``,
      "",
    ].join("\n"),
  );
}

/** The fixture MARKET source repo (cloned over file:// in the eval — the real
 *  `git clone --depth 1` path, minus the network). */
function buildMarketSource(dir: string, ws: string): void {
  gitRepo(dir);
  writeJson(join(dir, ".claude-plugin", "marketplace.json"), {
    name: "det52-market",
    description: "v1",
    strict: true,
    plugins: [
      { name: "cc-superset", source: "./plugins/cc-superset", version: "2.1.0" },
      { name: "dyn-user", source: "./plugins/dyn-user" },
      { name: "dyn-proj", source: "./plugins/dyn-proj" },
    ],
  });
  buildSupersetPlugin(dir);
  buildDynPlugins(dir, ws);
  commitAll(dir, "v1");
}

/** A plugin-only git repo for the E1b object-source entries. `stableRef`
 *  pins an older commit on a `stable` branch so the {source:"git", ref}
 *  normalization is provably the thing that selected the bytes. */
function buildPluginRepo(dir: string, name: string, stableRef: boolean): void {
  gitRepo(dir);
  writeJson(join(dir, ".claude-plugin", "plugin.json"), { name, version: "1.1.0" });
  writeText(join(dir, "skills", `${name}-skill`, "SKILL.md"), `---\nname: ${name}-skill\ndescription: the ${name} skill\n---\n\n${name} body.\n`);
  if (stableRef) writeText(join(dir, "marker.txt"), "stable\n");
  commitAll(dir, "c1");
  if (stableRef) {
    git(dir, ["branch", "stable"]);
    writeText(join(dir, "marker.txt"), "main\n");
    commitAll(dir, "c2");
  }
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

interface Det52Evidence {
  // §1 marketplace lifecycle
  readonly lifecycle: {
    readonly added: { readonly name: string; readonly sourceIsFileUrl: boolean; readonly description: string };
    readonly listedNames: readonly string[];
    readonly marketEntries: readonly string[];
    readonly installDetail: string;
    readonly rowsAfterInstalls: readonly string[];
    readonly disabledRows: readonly string[];
    readonly discoveryWhileDisabled: readonly string[];
    readonly disabledKey: string;
    readonly reenabledRows: readonly string[];
    readonly discoveryAfterReenable: readonly string[];
    readonly keyAfterReenable: boolean;
    readonly afterUninstallRows: readonly string[];
    readonly uninstalledDirGone: boolean;
    readonly updated: { readonly description: string; readonly marker: string; readonly addedAtStable: boolean };
    readonly cascade: {
      readonly removedPlugins: readonly string[];
      readonly marketDirGone: boolean;
      readonly projectPluginDirGone: boolean;
      readonly userPluginDirGone: boolean;
      readonly installedRecords: readonly string[];
      readonly enabledPluginsKeys: readonly string[];
      readonly listAfterRemove: readonly string[];
      readonly pluginsAfterRemove: readonly string[];
      readonly skillsAfterRemove: readonly string[];
    };
  };
  // §2 frontmatter superset
  readonly frontmatter: {
    readonly matrix: {
      readonly whenToUse: string | undefined;
      readonly argumentHint: string | undefined;
      readonly userInvocable: boolean | undefined;
      readonly allowedTools: readonly string[] | undefined;
      readonly argumentsDecl: readonly string[] | undefined;
      readonly paths: readonly string[] | undefined;
      readonly plugin: string | undefined;
      readonly pluginScope: string | undefined;
      readonly origin: string | undefined;
    };
    readonly manifestLine: string;
    readonly promptCarriesManifest: boolean;
    readonly gatedExcludedForMd: boolean;
    readonly gatedIncludedForTs: boolean;
    readonly gatedStillInvocable: boolean;
  };
  // §3 substitutions + injections
  readonly substitution: {
    readonly commandEnvelope: string;
    readonly skillEnvelope: string;
    readonly trustedEnvelope: string;
    readonly trustedMarker: string | undefined;
    readonly deniedError: string;
    readonly deniedMarkerAbsent: boolean;
    readonly noGateError: string;
    readonly allowedEnvelope: string;
    readonly allowedMarker: string | undefined;
  };
  // §4 the three slash forms
  readonly slash: {
    readonly bareForm: string;
    readonly bareOrigin: { readonly origin: string | undefined; readonly plugin: string | undefined };
    readonly bareLabel: string | undefined;
    readonly namespaceForm: string;
    readonly namespaceOrigin: { readonly plugin: string | undefined; readonly pluginScope: string | undefined };
    readonly namespaceLabel: string | undefined;
    readonly legacyForm: string;
    readonly pluginCommandForm: string;
    readonly barePluginSkillIsPrompt: boolean;
    readonly namespaceMissIsPrompt: boolean;
  };
  // §5 hooks mapping
  readonly hooks: {
    readonly faces: Readonly<Record<string, string>>;
    readonly mapPins: Readonly<Record<string, string>>;
    readonly pluginDir: string;
    readonly teammateIdleInMap: boolean;
    readonly teammateWarned: boolean;
  };
  // §6 cache invariant (A3)
  readonly cache: {
    readonly countsBefore: Readonly<Record<string, number>>;
    readonly countsAfter: Readonly<Record<string, number>>;
    readonly prefixBefore: string;
    readonly prefixAfter: string;
    readonly tailOnlyAppend: boolean;
    readonly linesBefore: number;
    readonly linesAfter: number;
    readonly newSkillListed: boolean;
    readonly sinkSawFresh: boolean;
  };
  // §7 object-form sources (E1b)
  readonly objectSources: {
    readonly entries: readonly string[];
    readonly expectedEntries: readonly string[];
    readonly skipped: number;
    readonly installedPlugins: readonly string[];
    readonly skillPluginScopes: readonly string[];
    readonly stableMarker: string;
    readonly rows: readonly string[];
    readonly registryAfterRemove: readonly string[];
  };
}

/** Strip the TRAILING <available_skills> manifest — the only prompt bytes a
 *  rescan may touch (the A3 seam's own helper shape). */
function stripSkillsTail(prompt: string): string {
  return prompt.replace(/\n\n<available_skills>[\s\S]*\n<\/available_skills>$/, "");
}

const manifestLines = (prompt: string): number => (prompt.match(/^- name: /gm) ?? []).length;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const rowSummary = (rows: readonly { id: string; scope: string; enabled: boolean; version?: string }[]): readonly string[] =>
  rows.map((r) => `${r.id}|${r.scope}|${r.enabled ? "on" : "off"}|${r.version ?? "-"}`);

export const det52Eval: EvalDefinition<string, Det52Evidence> = {
  name: "det-52-cc-plugins",
  kind: "deterministic",
  setup: async (tmplDir) => {
    mkdirSync(tmplDir, { recursive: true });
    return tmplDir;
  },
  async run(): Promise<Det52Evidence> {
    const home = mkdtempSync(join(tmpdir(), "wudao-det52-home-"));
    const ws = mkdtempSync(join(tmpdir(), "wudao-det52-ws-"));
    const marketSrc = mkdtempSync(join(tmpdir(), "wudao-det52-market-"));
    const objSrc = mkdtempSync(join(tmpdir(), "wudao-det52-objsrc-"));
    const repoA = mkdtempSync(join(tmpdir(), "wudao-det52-repoa-"));
    const repoB = mkdtempSync(join(tmpdir(), "wudao-det52-repob-"));
    const env: NodeJS.ProcessEnv = { ...process.env, WUDAO_GLOBAL_HOME: home };
    const deps: PluginEngineDeps = { env, workspaceRoot: ws, warn: quiet };
    // The workspace tier skill — the /<name> form's target.
    writeText(
      join(ws, ".wudao", "skills", "ws-skill", "SKILL.md"),
      "---\nname: ws-skill\ndescription: The workspace tier skill\n---\n\nws-skill body.\n",
    );

    resetExtensionRuntime();
    try {
      buildMarketSource(marketSrc, ws);
      const marketUrl = pathToFileURL(marketSrc).href;

      // =====================================================================
      // §1 add + list — the file:// clone registers the market and its
      // entries are discoverable in the materialized tree.
      // =====================================================================
      const added = await marketplaceAdd(marketUrl, undefined, { env, warn: quiet });
      const marketDir = join(home, "marketplaces", "det52-market");
      const listed = await marketplaceList({ env });
      const marketEntries = readMarketplaceFile(marketDir).plugins.map((p) => `${p.name}=${p.source}`);

      // =====================================================================
      // §6 the cache invariant FIRST — the live runtime boots with ONLY the
      // workspace skill; a REAL pluginInstall lands the project-scope plugin;
      // rescanExtensions swaps the fresh state; the prompt prefix must survive
      // byte-for-byte with the new manifest appended at the tail.
      // =====================================================================
      const boot = await buildExtensionState(ws, [], { env, warn: quiet });
      initExtensionRuntime(ws, [], boot, { env, warn: quiet });
      const promptBefore = buildSystemPrompt(ws, false, boot.skills);
      const sinkPlugins: number[] = [];
      const unregister = registerExtensionSwapSink((fresh) => sinkPlugins.push(fresh.counts.plugins));
      const countsBefore = boot.counts;
      const installSuperset = await pluginInstall("cc-superset", "det52-market", "project", deps);
      const countsAfter = await rescanExtensions();
      const freshSkills = getExtensionState()?.skills ?? [];
      const promptAfter = buildSystemPrompt(ws, false, freshSkills);
      unregister();
      resetExtensionRuntime();
      const cache = {
        countsBefore,
        countsAfter,
        prefixBefore: stripSkillsTail(promptBefore),
        prefixAfter: stripSkillsTail(promptAfter),
        tailOnlyAppend: promptAfter.startsWith(stripSkillsTail(promptBefore)),
        linesBefore: manifestLines(promptBefore),
        linesAfter: manifestLines(promptAfter),
        newSkillListed: promptAfter.includes("- name: cc-matrix") && promptAfter.includes("- name: path-gated"),
        sinkSawFresh: sinkPlugins.length === 1 && sinkPlugins[0] === 1,
      };
      const installDetail = JSON.stringify(installSuperset.detail);

      // =====================================================================
      // §1 (cont.) BOTH scopes: dyn-user at USER scope, dyn-proj at PROJECT
      // scope next to cc-superset.
      // =====================================================================
      await pluginInstall("dyn-user", "det52-market", "user", deps);
      await pluginInstall("dyn-proj", "det52-market", "project", deps);
      const rowsAfterInstalls = rowSummary(await pluginListInstalled(deps));
      const userPluginDir = join(home, "plugins", "dyn-user");
      const projectPluginDir = join(ws, ".wudao", "plugins", "dyn-proj");

      // =====================================================================
      // §2-§5 the loaded surface — the REAL loaders over both scopes, all
      // three plugins still installed.
      // =====================================================================
      const warnings: string[] = [];
      const plugins = loadPlugins(ws, [], (m) => warnings.push(m), { env });
      const skills = appendPluginSkills(loadSkills(ws, (m) => warnings.push(m), env), plugins, (m) => warnings.push(m));
      const skillByName = (n: string): LoadedSkill | undefined => skills.find((s) => s.name === n);

      // §2 frontmatter superset. The manifest bytes come from the REAL
      // renderer (skillsPromptSection — exactly what buildSystemPrompt
      // appends), never re-joined from LoadedSkill fields here: if the
      // renderer's format drifts, this eval must break instead of silently
      // agreeing with a test-side reconstruction of the same fields.
      const ccMatrix = skillByName("cc-matrix");
      const realManifest = skillsPromptSection(skills);
      const frontmatter = {
        matrix: {
          whenToUse: ccMatrix?.whenToUse,
          argumentHint: ccMatrix?.argumentHint,
          userInvocable: ccMatrix?.userInvocable,
          allowedTools: ccMatrix?.allowedTools,
          argumentsDecl: ccMatrix?.argumentsDecl,
          paths: ccMatrix?.paths,
          plugin: ccMatrix?.plugin,
          pluginScope: ccMatrix?.pluginScope,
          origin: ccMatrix?.origin,
        },
        manifestLine: realManifest.split("\n").find((l) => l.startsWith("- name: cc-matrix")) ?? "(missing)",
        promptCarriesManifest: buildSystemPrompt(ws, false, skills).endsWith(realManifest),
        gatedExcludedForMd: gateSkillsForPath(skills, "docs/readme.md").every((s) => s.name !== "path-gated"),
        gatedIncludedForTs: gateSkillsForPath(skills, "src/main.ts").some((s) => s.name === "path-gated"),
        gatedStillInvocable: findSkill(skills, "path-gated") !== undefined,
      };

      // §3 substitutions + injections. The deny lane runs BEFORE the allow
      // lane so the "refused" evidence observes a marker that never landed.
      const pluginCommands = collectPluginCommands(plugins);
      const deploy = pluginCommands.find((c) => c.name === "deploy");
      const commandEnvelope = deploy === undefined ? "(missing)" : buildPluginCommandMessage(deploy, "alpha beta");
      const dynSubst = skillByName("dyn-subst");
      const skillEnvelope = dynSubst === undefined
        ? "(missing)"
        : buildSubstitutedSkillMessage(dynSubst, "maps routing extra", { workspaceRoot: ws, projectDir: ws, sessionId: "det52-session" });
      const userInject = skillByName("user-inject");
      const projInject = skillByName("proj-inject");
      const trustedEnvelope = userInject === undefined
        ? "(missing)"
        : await buildExpandedSkillMessage(userInject, "Ada", { workspaceRoot: ws }).catch((e: unknown) => `THREW:${errText(e)}`);
      const deniedError = projInject === undefined
        ? "(missing)"
        : await buildExpandedSkillMessage(projInject, "Eve", {
            workspaceRoot: ws,
            decide: async () => ({ behavior: "deny" as const, reason: "det52 policy refusal" }),
          }).then((m) => `UNEXPECTED:${m}`, (e: unknown) => errText(e));
      const deniedMarkerAbsent = !existsSync(join(ws, "det52-proj-ran.txt"));
      const noGateError = projInject === undefined
        ? "(missing)"
        : await buildExpandedSkillMessage(projInject, "Eve", { workspaceRoot: ws }).then((m) => `UNEXPECTED:${m}`, (e: unknown) => errText(e));
      const allowedEnvelope = projInject === undefined
        ? "(missing)"
        : await buildExpandedSkillMessage(projInject, "Eve", {
            workspaceRoot: ws,
            decide: async () => ({ behavior: "allow" as const }),
          }).catch((e: unknown) => `THREW:${errText(e)}`);
      const substitution = {
        commandEnvelope,
        skillEnvelope,
        trustedEnvelope,
        trustedMarker: existsSync(join(ws, "det52-user-ran.txt")) ? readFileSync(join(ws, "det52-user-ran.txt"), "utf8") : undefined,
        deniedError,
        deniedMarkerAbsent,
        noGateError,
        allowedEnvelope,
        allowedMarker: existsSync(join(ws, "det52-proj-ran.txt")) ? readFileSync(join(ws, "det52-proj-ran.txt"), "utf8") : undefined,
      };

      // §4 the three slash forms + origin labels.
      const commandNames = pluginCommands.map((c) => c.name);
      const bareForm = parseReplCommand("/ws-skill hello world", commandNames, [], skills);
      const namespaceForm = parseReplCommand("/cc-superset:cc-matrix with args", commandNames, [], skills);
      const legacyForm = parseReplCommand("/skill:ws-skill legacy tail", commandNames, [], skills);
      const pluginCommandForm = parseReplCommand("/deploy alpha beta", commandNames, [], skills);
      const slashEntries = listSlashCommands({ skills, pluginCommands });
      const bareHit = findNonPluginSkill(skills, "ws-skill");
      const nsHit = findPluginSkill(skills, "cc-superset", "cc-matrix");
      const slash = {
        bareForm: JSON.stringify(bareForm),
        bareOrigin: { origin: bareHit?.origin, plugin: bareHit?.plugin },
        bareLabel: slashEntries.find((c) => c.name === "ws-skill")?.description,
        namespaceForm: JSON.stringify(namespaceForm),
        namespaceOrigin: { plugin: nsHit?.plugin, pluginScope: nsHit?.pluginScope },
        namespaceLabel: slashEntries.find((c) => c.name === "cc-superset:cc-matrix")?.description,
        legacyForm: JSON.stringify(legacyForm),
        pluginCommandForm: JSON.stringify(pluginCommandForm),
        barePluginSkillIsPrompt: parseReplCommand("/cc-matrix", commandNames, [], skills).kind === "prompt",
        namespaceMissIsPrompt: parseReplCommand("/dyn-user:missing", commandNames, [], skills).kind === "prompt",
      };

      // §5 hooks mapping.
      const superset = plugins.find((p) => p.name === "cc-superset");
      const hookFaces: Record<string, string> = {};
      const hooksOf = superset?.hooks as unknown as Record<string, unknown> | undefined;
      for (const event of ["onSessionStart", "onPromptSubmit", "onRunStop", "onPreToolUse", "onPostToolUse", "onSubagentStop", "onTeammateIdle"]) {
        hookFaces[event] = JSON.stringify(hooksOf?.[event] ?? null);
      }
      const hooks = {
        faces: hookFaces,
        // cc-plugins E4: every plugin-sourced entry carries its install dir
        // (pluginRoot) — the ${CLAUDE_PLUGIN_ROOT} convention's fuel. The
        // §5 byte pins assert it exactly (dir first-class, not reconstructed).
        pluginDir: superset?.dir ?? "(absent)",
        mapPins: {
          SessionStart: String(HOOK_EVENT_MAP["SessionStart"]),
          UserPromptSubmit: String(HOOK_EVENT_MAP["UserPromptSubmit"]),
          Stop: String(HOOK_EVENT_MAP["Stop"]),
          PreToolUse: String(HOOK_EVENT_MAP["PreToolUse"]),
          SubagentStop: String(HOOK_EVENT_MAP["SubagentStop"]),
          onTeammateIdle: String(HOOK_EVENT_MAP["onTeammateIdle"]),
        },
        teammateIdleInMap: "TeammateIdle" in HOOK_EVENT_MAP,
        teammateWarned: warnings.some((w) => w.includes("TeammateIdle") && w.includes("unknown hook event")),
      };

      // =====================================================================
      // §1 disable/enable — the row flips, discovery hides the plugin, the
      // settings key appears; re-enable restores all three and DELETES the
      // key (absent = default-enabled).
      // =====================================================================
      await pluginEnable("dyn-user@det52-market", false, deps);
      const disabledRows = rowSummary(await pluginListInstalled(deps));
      const disabledSettings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as Record<string, Record<string, boolean>>;
      const disabledKeyRaw = disabledSettings["enabledPlugins"]?.["dyn-user@det52-market"];
      const discoveryWhileDisabled = loadPlugins(ws, [], quiet, { env }).map((p) => p.name);
      await pluginEnable("dyn-user@det52-market", true, deps);
      const reenabledRows = rowSummary(await pluginListInstalled(deps));
      const reenabledSettings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as Record<string, unknown>;
      const keyAfterReenable = "enabledPlugins" in reenabledSettings;
      const discoveryAfterReenable = loadPlugins(ws, [], quiet, { env }).map((p) => p.name);

      // §1 uninstall the project-scope plugin.
      await pluginUninstall("dyn-proj@det52-market", deps);
      const afterUninstallRows = rowSummary(await pluginListInstalled(deps));
      const uninstalledDirGone = !existsSync(projectPluginDir);

      // §1 update — an upstream v2 commit advances the materialized market.
      writeText(join(marketSrc, "plugins", "cc-superset", "marker.txt"), "v2\n");
      writeJson(join(marketSrc, ".claude-plugin", "marketplace.json"), {
        name: "det52-market",
        description: "v2",
        plugins: [
          { name: "cc-superset", source: "./plugins/cc-superset", version: "2.1.0" },
          { name: "dyn-user", source: "./plugins/dyn-user" },
          { name: "dyn-proj", source: "./plugins/dyn-proj" },
        ],
      });
      commitAll(marketSrc, "v2");
      const updated = await marketplaceUpdate("det52-market", { env, warn: quiet });
      const listedAfterUpdate = await marketplaceList({ env });
      const updatedMarker = readFileSync(join(marketDir, "plugins", "cc-superset", "marker.txt"), "utf8");

      // §1 remove — the cascade. cc-superset is disabled first so the
      // enabledPlugins cleanup is observable.
      await pluginEnable("cc-superset@det52-market", false, deps);
      const removed = await marketplaceRemove("det52-market", { env, warn: quiet });
      const installedRecords = JSON.parse(readFileSync(join(home, "plugins", "installed.json"), "utf8")) as { market: string }[];
      const settingsAfterRemove = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as Record<string, Record<string, boolean>>;
      const pluginsAfterRemove = loadPlugins(ws, [], quiet, { env });
      const lifecycle = {
        added: { name: added.name, sourceIsFileUrl: added.source.startsWith("file://"), description: added.description ?? "" },
        listedNames: listed.map((e) => e.name),
        marketEntries,
        installDetail,
        rowsAfterInstalls,
        disabledRows,
        discoveryWhileDisabled,
        disabledKey: String(disabledKeyRaw),
        reenabledRows,
        discoveryAfterReenable,
        keyAfterReenable,
        afterUninstallRows,
        uninstalledDirGone,
        updated: { description: updated.description ?? "", marker: updatedMarker, addedAtStable: listedAfterUpdate[0]?.addedAt === added.addedAt },
        cascade: {
          removedPlugins: [...removed.removedPlugins].sort(),
          marketDirGone: !existsSync(marketDir),
          projectPluginDirGone: !existsSync(join(ws, ".wudao", "plugins", "cc-superset")),
          userPluginDirGone: !existsSync(userPluginDir),
          installedRecords: installedRecords.map((r) => r.market),
          enabledPluginsKeys: Object.keys(settingsAfterRemove["enabledPlugins"] ?? {}),
          listAfterRemove: (await marketplaceList({ env })).map((e) => e.name),
          pluginsAfterRemove: pluginsAfterRemove.map((p) => p.name),
          skillsAfterRemove: appendPluginSkills(loadSkills(ws, quiet, env), pluginsAfterRemove, quiet).map((s) => s.name),
        },
      };

      // =====================================================================
      // §7 object-form sources (E1b): a localDir market whose entries use
      // CC's OBJECT sources; the url/git forms INSTALL over file://.
      // =====================================================================
      buildPluginRepo(repoA, "obj-url", false);
      buildPluginRepo(repoB, "obj-git", true);
      const urlA = pathToFileURL(repoA).href;
      const urlB = pathToFileURL(repoB).href;
      writeJson(join(objSrc, ".claude-plugin", "marketplace.json"), {
        name: "det52-objmarket",
        strict: true,
        plugins: [
          { name: "obj-url", source: { source: "url", url: urlA }, version: "1.1.0", strict: true },
          { name: "obj-git", source: { source: "git", url: urlB, ref: "stable" } },
          { name: "obj-gh", source: { source: "github", owner: "example", repo: "det52-gh" } },
          { name: "obj-bad", source: { source: "local", path: "/somewhere/on/disk" } },
        ],
      });
      const objAdded = await marketplaceAdd(objSrc, undefined, { env, warn: quiet });
      const objDir = join(home, "marketplaces", objAdded.name);
      const objFile = readMarketplaceFile(objDir);
      await pluginInstall("obj-url", "det52-objmarket", "user", deps);
      await pluginInstall("obj-git", "det52-objmarket", "user", deps);
      const objPlugins = loadPlugins(ws, [], quiet, { env });
      const objRows = rowSummary(await pluginListInstalled(deps));
      // captured BEFORE the remove — the cascade deletes the plugin dirs.
      const stableMarker = readFileSync(join(home, "plugins", "obj-git", "marker.txt"), "utf8");
      await marketplaceRemove("det52-objmarket", { env, warn: quiet });
      const objRegistryAfterRemove = (JSON.parse(readFileSync(join(home, "plugins", "installed.json"), "utf8")) as { market: string }[]).map((r) => r.market);
      const objectSources = {
        entries: objFile.plugins.map((p) => `${p.name}=${p.source}`),
        expectedEntries: [`obj-url=${urlA}`, `obj-git=${urlB}#stable`, "obj-gh=example/det52-gh"],
        skipped: objFile.skipped,
        installedPlugins: objPlugins.map((p) => p.name),
        // Strict: the SKILL-level pluginScope stamp, exactly as loaded — no
        // fallback to the plugin row's scope (that value is already pinned by
        // `rows` below). A lost stamp surfaces as "(absent)" and FAILS the
        // assertion instead of silently passing off the plugin's scope.
        skillPluginScopes: objPlugins.flatMap((p) => p.skills.map((s) => `${p.name}/${s.name}=${s.pluginScope ?? "(absent)"}`)),
        stableMarker,
        rows: objRows,
        registryAfterRemove: objRegistryAfterRemove,
      };

      return { lifecycle, frontmatter, substitution, slash, hooks, cache, objectSources };
    } finally {
      resetExtensionRuntime();
      for (const dir of [home, ws, marketSrc, objSrc, repoA, repoB]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
  assertions(e: Det52Evidence): string[] {
    const errors: string[] = [];
    const need = (cond: boolean, what: string): void => {
      if (!cond) errors.push(what);
    };

    // ---- §1 marketplace lifecycle
    need(e.lifecycle.added.name === "det52-market", `§1 add: the market must register under its manifest name, got ${JSON.stringify(e.lifecycle.added)}`);
    need(e.lifecycle.added.sourceIsFileUrl, `§1 add: the file:// source must be stored verbatim for update/remove, got ${JSON.stringify(e.lifecycle.added)}`);
    need(e.lifecycle.added.description === "v1", `§1 add: the manifest description must ride, got ${JSON.stringify(e.lifecycle.added.description)}`);
    need(JSON.stringify(e.lifecycle.listedNames) === JSON.stringify(["det52-market"]), `§1 list: exactly one registry line, got ${JSON.stringify(e.lifecycle.listedNames)}`);
    need(
      JSON.stringify(e.lifecycle.marketEntries) === JSON.stringify([
        "cc-superset=./plugins/cc-superset",
        "dyn-user=./plugins/dyn-user",
        "dyn-proj=./plugins/dyn-proj",
      ]),
      `§1 list: the market's plugin entries must be discovered, got ${JSON.stringify(e.lifecycle.marketEntries)}`,
    );
    need(
      e.lifecycle.installDetail === JSON.stringify({ skills: 2, commands: 1, agents: 0, hooks: 6, mcp: 0 }),
      `§1 install: the dry-run preview must count the plugin's assets, got ${e.lifecycle.installDetail}`,
    );
    need(
      JSON.stringify(e.lifecycle.rowsAfterInstalls) === JSON.stringify([
        "cc-superset@det52-market|project|on|2.1.0",
        "dyn-user@det52-market|user|on|3.0.0",
        "dyn-proj@det52-market|project|on|-",
      ]),
      `§1 install: BOTH scopes must register with version + enable state, got ${JSON.stringify(e.lifecycle.rowsAfterInstalls)}`,
    );
    need(
      e.lifecycle.disabledRows.includes("dyn-user@det52-market|user|off|3.0.0"),
      `§1 disable: the row must flip off, got ${JSON.stringify(e.lifecycle.disabledRows)}`,
    );
    need(e.lifecycle.disabledKey === "false", `§1 disable: enabledPlugins must carry <name>@<market>=false, got ${JSON.stringify(e.lifecycle.disabledKey)}`);
    need(
      JSON.stringify(e.lifecycle.discoveryWhileDisabled) === JSON.stringify(["cc-superset", "dyn-proj"]),
      `§1 disable: discovery must hide the disabled plugin, got ${JSON.stringify(e.lifecycle.discoveryWhileDisabled)}`,
    );
    need(
      JSON.stringify(e.lifecycle.reenabledRows) === JSON.stringify(e.lifecycle.rowsAfterInstalls),
      `§1 enable: re-enabling must restore the exact rows, got ${JSON.stringify(e.lifecycle.reenabledRows)}`,
    );
    need(
      JSON.stringify(e.lifecycle.discoveryAfterReenable) === JSON.stringify(["cc-superset", "dyn-proj", "dyn-user"]),
      `§1 enable: discovery must see it again (project root first), got ${JSON.stringify(e.lifecycle.discoveryAfterReenable)}`,
    );
    need(!e.lifecycle.keyAfterReenable, "§1 enable: re-enabling must DELETE the settings key (absent = default)");
    need(
      JSON.stringify(e.lifecycle.afterUninstallRows) === JSON.stringify(["cc-superset@det52-market|project|on|2.1.0", "dyn-user@det52-market|user|on|3.0.0"]),
      `§1 uninstall: only dyn-proj must leave the registry, got ${JSON.stringify(e.lifecycle.afterUninstallRows)}`,
    );
    need(e.lifecycle.uninstalledDirGone, "§1 uninstall: the project-scope plugin dir must be removed");
    need(e.lifecycle.updated.description === "v2", `§1 update: the upstream description must advance, got ${JSON.stringify(e.lifecycle.updated.description)}`);
    need(e.lifecycle.updated.marker === "v2\n", `§1 update: the materialized market must pull the v2 bytes, got ${JSON.stringify(e.lifecycle.updated.marker)}`);
    need(e.lifecycle.updated.addedAtStable, "§1 update: addedAt must never re-date");
    need(
      JSON.stringify(e.lifecycle.cascade.removedPlugins) === JSON.stringify(["cc-superset", "dyn-user"]),
      `§1 remove: the cascade must uninstall BOTH remaining scopes, got ${JSON.stringify(e.lifecycle.cascade.removedPlugins)}`,
    );
    need(e.lifecycle.cascade.marketDirGone, "§1 remove: the materialized market must be gone");
    need(e.lifecycle.cascade.projectPluginDirGone, "§1 remove: the project-scope plugin dir must be gone");
    need(e.lifecycle.cascade.userPluginDirGone, "§1 remove: the user-scope plugin dir must be gone");
    need(e.lifecycle.cascade.installedRecords.length === 0, `§1 remove: no det52-market install records may survive, got ${JSON.stringify(e.lifecycle.cascade.installedRecords)}`);
    need(e.lifecycle.cascade.enabledPluginsKeys.length === 0, `§1 remove: no stale enabledPlugins keys may survive, got ${JSON.stringify(e.lifecycle.cascade.enabledPluginsKeys)}`);
    need(e.lifecycle.cascade.listAfterRemove.length === 0, `§1 remove: the market registry must be empty, got ${JSON.stringify(e.lifecycle.cascade.listAfterRemove)}`);
    need(e.lifecycle.cascade.pluginsAfterRemove.length === 0, `§1 remove: discovery must see zero plugins, got ${JSON.stringify(e.lifecycle.cascade.pluginsAfterRemove)}`);
    need(
      JSON.stringify(e.lifecycle.cascade.skillsAfterRemove) === JSON.stringify(["ws-skill"]),
      `§1 remove: only the workspace skill may remain, got ${JSON.stringify(e.lifecycle.cascade.skillsAfterRemove)}`,
    );

    // ---- §2 frontmatter superset
    const m = e.frontmatter.matrix;
    need(m.whenToUse === "a superset field matrix is needed", `§2 when_to_use (snake form) must surface, got ${JSON.stringify(m.whenToUse)}`);
    need(m.argumentHint === "<topic> [details]", `§2 argument-hint must surface, got ${JSON.stringify(m.argumentHint)}`);
    need(m.userInvocable === false, `§2 user-invocable: false must surface, got ${JSON.stringify(m.userInvocable)}`);
    need(JSON.stringify(m.allowedTools) === JSON.stringify(["Read", "Grep"]), `§2 allowed-tools block list must parse, got ${JSON.stringify(m.allowedTools)}`);
    need(JSON.stringify(m.argumentsDecl) === JSON.stringify(["topic", "details"]), `§2 arguments block list must parse, got ${JSON.stringify(m.argumentsDecl)}`);
    need(m.paths === undefined, `§2 the matrix skill must be ungated (paths absent), got ${JSON.stringify(m.paths)}`);
    need(m.plugin === "cc-superset", `§2 the skill must carry its plugin tag, got ${JSON.stringify(m.plugin)}`);
    need(m.pluginScope === "project", `§2 the install scope must stamp the skill, got ${JSON.stringify(m.pluginScope)}`);
    need(m.origin === "plugin", `§2 the origin tier must be plugin, got ${JSON.stringify(m.origin)}`);
    need(
      e.frontmatter.manifestLine === "- name: cc-matrix — The CC frontmatter superset — use when: a superset field matrix is needed (path: .wudao/plugins/cc-superset/skills/cc-matrix/SKILL.md)",
      `§2 the REAL skillsPromptSection manifest line must merge whenToUse into the description dash-line, got ${JSON.stringify(e.frontmatter.manifestLine)}`,
    );
    need(
      e.frontmatter.promptCarriesManifest,
      "§2 the projected system prompt must END with the real skillsPromptSection bytes for this skill set (renderer ↔ prompt seam)",
    );
    need(e.frontmatter.gatedExcludedForMd, "§2 paths gate: a non-matching current file must drop the skill from the manifest");
    need(e.frontmatter.gatedIncludedForTs, "§2 paths gate: a matching .ts file must keep it listed");
    need(e.frontmatter.gatedStillInvocable, "§2 paths gate: /skill: invocation must survive the gate");

    // ---- §3 substitutions + injections
    need(
      e.substitution.commandEnvelope === '<plugin-command name="deploy" args="alpha beta">\nDeploy alpha beta now (target: alpha).\n\n</plugin-command>',
      `§3 plugin command $ARGUMENTS/$0 expansion shape wrong, got ${JSON.stringify(e.substitution.commandEnvelope)}`,
    );
    const expectedSkillContent = [
      "---",
      "name: dyn-subst",
      "description: substitution matrix",
      "arguments:",
      "  - topic",
      "  - details",
      "---",
      "",
      "ALL=maps routing extra FIRST=maps SECOND=routing T1=maps T2=routing MISS= ESC=$ARGUMENTS",
      "",
    ].join("\n");
    const expectedSkillEnvelope = `<skill name="dyn-subst" args="maps routing extra">\n${expectedSkillContent}\n</skill>`;
    need(e.substitution.skillEnvelope === expectedSkillEnvelope, `§3 skill substitution matrix wrong, got ${JSON.stringify(e.substitution.skillEnvelope)}`);
    need(
      e.substitution.trustedEnvelope.includes("Hello Ada.") && e.substitution.trustedEnvelope.includes("Trusted tier executed: det52-user-yes"),
      `§3 trusted (user-scope) injection must run and inline its output, got ${JSON.stringify(e.substitution.trustedEnvelope)}`,
    );
    need(!e.substitution.trustedEnvelope.includes("!`"), "§3 trusted injection: the !`cmd` span must be consumed, not left literal");
    // win32: `echo x > file` under cmd.exe writes "x \r\n" (trailing space +
    // CRLF); the marker's PROOF is the text, not its line ending.
    need(e.substitution.trustedMarker?.split("\r")[0]?.trim() === "det52-user-ran", `§3 trusted injection: the marker file must prove real execution, got ${JSON.stringify(e.substitution.trustedMarker)}`);
    need(
      e.substitution.deniedError.includes("skill injection denied:") && e.substitution.deniedError.includes("det52 policy refusal"),
      `§3 untrusted deny: the gate's refusal must fail the invocation loudly, got ${JSON.stringify(e.substitution.deniedError)}`,
    );
    need(e.substitution.deniedMarkerAbsent, "§3 untrusted deny: the injection command must NOT have run");
    need(e.substitution.noGateError.includes("no permission gate available"), `§3 untrusted no-gate: must fail closed, got ${JSON.stringify(e.substitution.noGateError)}`);
    need(
      e.substitution.allowedEnvelope.includes("Untrusted tier executed: det52-proj-yes"),
      `§3 untrusted allow: an allowed decision must run the injection, got ${JSON.stringify(e.substitution.allowedEnvelope)}`,
    );
    need(e.substitution.allowedMarker?.split("\r")[0]?.trim() === "det52-proj-ran", `§3 untrusted allow: the marker must exist AFTER the allow, got ${JSON.stringify(e.substitution.allowedMarker)}`);

    // ---- §4 the three slash forms
    need(e.slash.bareForm === JSON.stringify({ kind: "skill", name: "ws-skill", args: "hello world" }), `§4 /<name> must resolve the workspace skill, got ${e.slash.bareForm}`);
    need(e.slash.bareOrigin.origin === "project" && e.slash.bareOrigin.plugin === undefined, `§4 /<name> origin must be the non-plugin tier, got ${JSON.stringify(e.slash.bareOrigin)}`);
    need((e.slash.bareLabel ?? "").includes("（工作区）"), `§4 /<name> help label must carry the workspace origin, got ${JSON.stringify(e.slash.bareLabel)}`); // ω99-171: 钉随源演进（ω99-162 译源未随钉；源 slash-commands.ts:131-133 词表）
    need(
      e.slash.namespaceForm === JSON.stringify({ kind: "skill", name: "cc-matrix", args: "with args" }),
      `§4 /<plugin>:<skill> must resolve the namespaced plugin skill, got ${e.slash.namespaceForm}`,
    );
    need(
      e.slash.namespaceOrigin.plugin === "cc-superset" && e.slash.namespaceOrigin.pluginScope === "project",
      `§4 /<plugin>:<skill> origin must carry the plugin + scope, got ${JSON.stringify(e.slash.namespaceOrigin)}`,
    );
    need((e.slash.namespaceLabel ?? "").includes("（插件：cc-superset）"), `§4 /<plugin>:<skill> help label must carry the plugin annotation, got ${JSON.stringify(e.slash.namespaceLabel)}`); // ω99-171: 钉随源演进（ω99-162 译源未随钉；源 slash-commands.ts:132）
    need(
      e.slash.legacyForm === JSON.stringify({ kind: "skill", name: "ws-skill", args: "legacy tail" }),
      `§4 legacy /skill:<name> alias must resolve, got ${e.slash.legacyForm}`,
    );
    need(
      e.slash.pluginCommandForm === JSON.stringify({ kind: "pluginCommand", name: "deploy", args: "alpha beta" }),
      `§4 /<plugin-command> routing must survive the skill forms, got ${e.slash.pluginCommandForm}`,
    );
    need(e.slash.barePluginSkillIsPrompt, "§4 a bare /<plugin-skill-name> must NOT invoke the plugin skill");
    need(e.slash.namespaceMissIsPrompt, "§4 a namespaced miss must fall through to a plain prompt");

    // ---- §5 hooks mapping
    need(
      e.hooks.faces.onSessionStart === JSON.stringify([{ command: "echo det52-session-start", matcher: "startup|resume", pluginRoot: e.hooks.pluginDir }]),
      `§5 SessionStart must compile onto onSessionStart with the CC matcher preserved, got ${e.hooks.faces.onSessionStart}`,
    );
    need(e.hooks.faces.onPromptSubmit === JSON.stringify([{ command: "echo det52-ups", pluginRoot: e.hooks.pluginDir }]), `§5 UserPromptSubmit → onPromptSubmit, got ${e.hooks.faces.onPromptSubmit}`);
    need(e.hooks.faces.onRunStop === JSON.stringify([{ command: "echo det52-stop", pluginRoot: e.hooks.pluginDir }]), `§5 Stop → onRunStop, got ${e.hooks.faces.onRunStop}`);
    need(
      e.hooks.faces.onPreToolUse === JSON.stringify([{ command: "echo det52-pre", matcher: "Write|Edit", pluginRoot: e.hooks.pluginDir }]),
      `§5 PreToolUse → onPreToolUse with the group matcher, got ${e.hooks.faces.onPreToolUse}`,
    );
    need(e.hooks.faces.onPostToolUse === JSON.stringify([{ command: "echo det52-post", pluginRoot: e.hooks.pluginDir }]), `§5 PostToolUse → onPostToolUse, got ${e.hooks.faces.onPostToolUse}`);
    need(e.hooks.faces.onSubagentStop === JSON.stringify([{ command: "echo det52-substop", pluginRoot: e.hooks.pluginDir }]), `§5 SubagentStop → onSubagentStop (minus-on rule), got ${e.hooks.faces.onSubagentStop}`);
    need(e.hooks.faces.onTeammateIdle === "null", `§5 TeammateIdle must compile NOTHING, got ${e.hooks.faces.onTeammateIdle}`);
    need(e.hooks.mapPins.SessionStart === "onSessionStart", `§5 HOOK_EVENT_MAP SessionStart pin, got ${e.hooks.mapPins.SessionStart}`);
    need(e.hooks.mapPins.UserPromptSubmit === "onPromptSubmit", `§5 HOOK_EVENT_MAP UserPromptSubmit pin (the CC rename), got ${e.hooks.mapPins.UserPromptSubmit}`);
    need(e.hooks.mapPins.Stop === "onRunStop", `§5 HOOK_EVENT_MAP Stop pin (the CC rename), got ${e.hooks.mapPins.Stop}`);
    need(e.hooks.mapPins.PreToolUse === "onPreToolUse", `§5 HOOK_EVENT_MAP PreToolUse pin, got ${e.hooks.mapPins.PreToolUse}`);
    need(e.hooks.mapPins.SubagentStop === "onSubagentStop", `§5 HOOK_EVENT_MAP SubagentStop pin, got ${e.hooks.mapPins.SubagentStop}`);
    need(e.hooks.mapPins.onTeammateIdle === "onTeammateIdle", `§5 the canonical onTeammateIdle key must self-map, got ${e.hooks.mapPins.onTeammateIdle}`);
    need(!e.hooks.teammateIdleInMap, "§5 HOOK_EVENT_MAP must NOT mint a TeammateIdle CC alias (the E1 exclusion)");
    need(e.hooks.teammateWarned, "§5 the loader must warn that TeammateIdle is not a known event");

    // ---- §6 cache invariant (A3)
    need(
      JSON.stringify(e.cache.countsBefore) === JSON.stringify({ skills: 1, plugins: 0, hooks: 0 }),
      `§6 the boot state must carry only the workspace skill, got ${JSON.stringify(e.cache.countsBefore)}`,
    );
    need(
      JSON.stringify(e.cache.countsAfter) === JSON.stringify({ skills: 3, plugins: 1, hooks: 6 }),
      `§6 the rescan must count the installed plugin's assets, got ${JSON.stringify(e.cache.countsAfter)}`,
    );
    need(e.cache.prefixBefore === e.cache.prefixAfter, "§6 the prompt BEFORE the <available_skills> tail must be byte-identical across the rescan");
    need(e.cache.tailOnlyAppend, "§6 the post-rescan prompt must be the old prompt plus ONLY tail bytes");
    need(
      e.cache.linesAfter === e.cache.linesBefore + 2,
      `§6 the manifest must grow by exactly the two new skills, got ${e.cache.linesBefore} → ${e.cache.linesAfter}`,
    );
    need(e.cache.newSkillListed, "§6 the new plugin skills must appear in the tail manifest");
    need(e.cache.sinkSawFresh, "§6 the swap sink must receive the fresh state with the plugin counted");

    // ---- §7 object-form sources (E1b)
    need(
      JSON.stringify(e.objectSources.entries) === JSON.stringify(e.objectSources.expectedEntries),
      `§7 the object entries must normalize into the string grammar, got ${JSON.stringify(e.objectSources.entries)} vs ${JSON.stringify(e.objectSources.expectedEntries)}`,
    );
    need(e.objectSources.entries.includes("obj-gh=example/det52-gh"), "§7 the github object form must normalize to owner/repo");
    need(e.objectSources.skipped === 1, `§7 exactly the local-object entry is dropped + counted, got ${e.objectSources.skipped}`);
    need(
      JSON.stringify(e.objectSources.installedPlugins) === JSON.stringify(["obj-git", "obj-url"]),
      `§7 the normalized url/git entries must INSTALL over file://, got ${JSON.stringify(e.objectSources.installedPlugins)}`,
    );
    need(
      JSON.stringify(e.objectSources.skillPluginScopes) === JSON.stringify(["obj-git/obj-git-skill=user", "obj-url/obj-url-skill=user"]),
      `§7 every E1b-installed skill must carry its OWN exact pluginScope stamp (no fallback; "(absent)" fails), got ${JSON.stringify(e.objectSources.skillPluginScopes)}`,
    );
    need(e.objectSources.stableMarker === "stable\n", `§7 the {source:"git", ref:"stable"} entry must clone THAT branch, got ${JSON.stringify(e.objectSources.stableMarker)}`);
    need(
      JSON.stringify(e.objectSources.rows) === JSON.stringify(["obj-url@det52-objmarket|user|on|1.1.0", "obj-git@det52-objmarket|user|on|1.1.0"]),
      `§7 the installed rows must carry the market + scope, got ${JSON.stringify(e.objectSources.rows)}`,
    );
    need(e.objectSources.registryAfterRemove.length === 0, `§7 removing the object market must cascade its installs too, got ${JSON.stringify(e.objectSources.registryAfterRemove)}`);

    return errors;
  },
  metrics(e: Det52Evidence) {
    return {
      marketLifecycleOps: 8, // add, install, disable, enable, uninstall, update, remove, re-list
      installedScopes: 2,
      ccHookFacesPinned: 6,
      slashForms: 3,
      manifestLinesGrown: e.cache.linesAfter - e.cache.linesBefore,
      objectSourceKinds: 3,
    };
  },
};
