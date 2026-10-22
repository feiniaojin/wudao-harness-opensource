// cc-plugins B1 — the /plugin slash face and the `wudao plugin` CLI over the
// A1/A2 marketplace engine. ONE grammar, two frontends:
//   • pluginMain(argv) — exit codes (0 ok · 1 engine failure · 2 usage) +
//     human text, or a single JSON object with --json;
//   • runPluginSlashCommand(args) — the same engine + Chinese notices for the
//     REPL/driver notice channels, the busy guard, and the post-mutation
//     rescan receipt.
// It lives in commands/ (the command-face pattern), NOT next to the loader in
// plugins.ts: the engine (marketplace.ts) and the hot-rescan seam
// (extension-state.ts) both import plugins.ts, so growing engine subcommands
// inside plugins.ts would close plugins ⇄ marketplace — the repo's import
// graph is acyclic and stays that way.
//
// Busy law (the 「⚠️ 运行中无法 …（任务进行中）」 family): every op here is
// CONFIG-only and busy-safe — install/enable/disable/list touch files and
// settings a run never mutates, and the rescan swap is turn-safe by design —
// EXCEPT the two ops that DELETE plugin directories a run's hooks may be
// executing from: `uninstall` and `marketplace remove` (whose cascade
// uninstalls). Those refuse while a run is in flight; the refusal lands
// before any engine call, so nothing is touched.
//
// A3's deferred copy boundary rides the install notice: a plugin's MCP
// servers apply after RESTART — rescan hot-swaps the merged config, never an
// already-spawned tool set (the tool-list prefix is cache-sensitive). The
// line appears only when the plugin actually declares MCP servers.
import {
  MarketplaceError,
  marketplaceAdd,
  marketplaceList,
  marketplaceRemove,
  marketplaceUpdate,
  marketplacesDir,
  pluginEnable,
  pluginInstall,
  pluginListInstalled,
  pluginUninstall,
  readMarketplaceFile,
  type MarketplaceInfo,
} from "../marketplace.js";
import { rescanExtensions } from "../extension-state.js";
import { countHookCommands, formatPluginList, loadPlugins } from "../plugins.js";
import type { LoadedPlugin } from "../plugins.js";
import { join } from "node:path";

/** The rescan seam's shape (extension-state.rescanExtensions); injectable so
 * tests (and only tests) never read the process's real global home. */
export type PluginRescanFn = () => Promise<{ readonly skills: number; readonly plugins: number; readonly hooks: number }>;

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

export type PluginOp =
  | { readonly t: "list" }
  | { readonly t: "install"; readonly name: string; readonly market: string; readonly scope: "user" | "project" }
  | { readonly t: "uninstall"; readonly id: string }
  | { readonly t: "enable"; readonly id: string }
  | { readonly t: "disable"; readonly id: string }
  | { readonly t: "market-add"; readonly source: string; readonly name?: string }
  | { readonly t: "market-list" }
  | { readonly t: "market-update"; readonly name?: string } // undefined = every registered market
  | { readonly t: "market-remove"; readonly name: string };

/** Parse one command line (CLI argv without the leading `plugin`, or the
 * slash args tokenized on whitespace). Flags may appear anywhere; `--json`
 * is accepted in both faces (the slash face renders prose regardless — the
 * notice channel has no JSON consumer). */
export function parsePluginArgs(argv: readonly string[]): { kind: "op"; op: PluginOp; json: boolean } | { kind: "help" } | { kind: "usage"; reason?: string } {
  let json = false;
  let scope: string | undefined;
  let nameFlag: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--help" || a === "-h") return { kind: "help" };
    if (a === "--scope" || a.startsWith("--scope=")) {
      const v = a === "--scope" ? argv[++i] : a.slice("--scope=".length);
      if (v === undefined || v === "") return { kind: "usage", reason: "--scope expects user|project" };
      scope = v;
      continue;
    }
    if (a === "--name" || a.startsWith("--name=")) {
      const v = a === "--name" ? argv[++i] : a.slice("--name=".length);
      if (v === undefined || v === "") return { kind: "usage", reason: "--name expects a marketplace name" };
      nameFlag = v;
      continue;
    }
    if (a.startsWith("--")) return { kind: "usage", reason: `unknown flag "${a}"` };
    positionals.push(a);
  }

  const [head, second, ...rest] = positionals;
  if (head === undefined) return { kind: "usage" }; // bare /plugin — usage, no reason line
  if (head === "list") {
    if (second !== undefined) return { kind: "usage", reason: `list takes no arguments (got "${second}")` };
    if (scope !== undefined) return { kind: "usage", reason: "--scope is only valid with install" };
    if (nameFlag !== undefined) return { kind: "usage", reason: "--name is only valid with marketplace add" };
    return { kind: "op", op: { t: "list" }, json };
  }
  if (head === "install") {
    if (second === undefined) return { kind: "usage", reason: "install expects <name>@<market>" };
    if (rest.length > 0) return { kind: "usage", reason: `install takes one <name>@<market> (unexpected "${rest[0]}")` };
    const at = second.indexOf("@");
    if (at <= 0 || at === second.length - 1) {
      return { kind: "usage", reason: `install expects <name>@<market> — got "${second}"` };
    }
    if (scope !== undefined && scope !== "user" && scope !== "project") {
      return { kind: "usage", reason: `--scope expects user|project — got "${scope}"` };
    }
    if (nameFlag !== undefined) return { kind: "usage", reason: "--name is only valid with marketplace add" };
    return {
      kind: "op",
      op: { t: "install", name: second.slice(0, at), market: second.slice(at + 1), scope: (scope as "user" | "project") ?? "user" },
      json,
    };
  }
  if (head === "uninstall" || head === "enable" || head === "disable") {
    if (second === undefined) return { kind: "usage", reason: `${head} expects <name>[@<market>]` };
    if (rest.length > 0) return { kind: "usage", reason: `${head} takes one <name>[@<market>] (unexpected "${rest[0]}")` };
    if (scope !== undefined) return { kind: "usage", reason: "--scope is only valid with install" };
    if (nameFlag !== undefined) return { kind: "usage", reason: "--name is only valid with marketplace add" };
    const op: PluginOp =
      head === "uninstall" ? { t: "uninstall", id: second } : head === "enable" ? { t: "enable", id: second } : { t: "disable", id: second };
    return { kind: "op", op, json };
  }
  if (head === "marketplace") {
    if (second === undefined) return { kind: "usage", reason: "marketplace expects add|list|update|remove" };
    if (scope !== undefined) return { kind: "usage", reason: "--scope is only valid with install" };
    if (second === "add") {
      if (rest.length === 0) return { kind: "usage", reason: "marketplace add expects a <source> (owner/repo · git URL#ref · 本地目录 · marketplace.json 路径)" };
      // rest-of-line join: a local path with spaces survives both faces
      return { kind: "op", op: { t: "market-add", source: rest.join(" "), ...(nameFlag !== undefined ? { name: nameFlag } : {}) }, json };
    }
    if (nameFlag !== undefined) return { kind: "usage", reason: "--name is only valid with marketplace add" };
    if (second === "list") {
      if (rest.length > 0) return { kind: "usage", reason: `marketplace list takes no arguments (got "${rest[0]}")` };
      return { kind: "op", op: { t: "market-list" }, json };
    }
    if (second === "update") {
      if (rest.length > 1) return { kind: "usage", reason: `marketplace update takes at most one <name> (unexpected "${rest[1]}")` };
      return { kind: "op", op: { t: "market-update", ...(rest[0] !== undefined ? { name: rest[0] } : {}) }, json };
    }
    if (second === "remove") {
      if (rest.length === 0) return { kind: "usage", reason: "marketplace remove expects a <name>" };
      if (rest.length > 1) return { kind: "usage", reason: `marketplace remove takes one <name> (unexpected "${rest[1]}")` };
      return { kind: "op", op: { t: "market-remove", name: rest[0] as string }, json };
    }
    return { kind: "usage", reason: `unknown marketplace subcommand "${second}"` };
  }
  return { kind: "usage", reason: `unknown subcommand "${head}"` };
}

const USAGE_BODY = `插件管理（插件是配置包：技能/命令/MCP/hooks 只读映射到 wudao 机制，插件代码永不执行）

  list                                              已装登记 + 已加载映射清单
  install <name>@<market> [--scope user|project]    安装（默认 user 作用域）
  uninstall <name>[@<market>]                       卸载（删目录 + 注销登记）
  enable|disable <name>[@<market>]                  启用 / 停用（停用即从映射隐藏）
  marketplace add <source> [--name <name>]          添加市场（owner/repo · git URL#ref · 本地目录 · marketplace.json 路径）
  marketplace list                                  市场清单
  marketplace update [<name>]                       更新市场（缺省 = 全部）
  marketplace remove <name>                         移除市场（连带卸载它安装的插件）`;

const USAGE_CLI = `用法：wudao plugin <command> [args] [--json]\n\n${USAGE_BODY}`; // ω99-166e-ii: #4
const USAGE_SLASH = `用法：/plugin <sub> [args]\n\n${USAGE_BODY}`; // ω99-166e-ii: #5

function usageText(reason: string | undefined, face: "cli" | "slash"): string {
  const base = face === "cli" ? USAGE_CLI : USAGE_SLASH;
  return reason === undefined ? base : `${reason}\n${base}`;
}

// ---------------------------------------------------------------------------
// Execution — one op through the engine
// ---------------------------------------------------------------------------

interface RunContext {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly rescan?: PluginRescanFn;
}

interface OpResult {
  readonly code: number; // 0 ok · 1 engine failure
  readonly text: string;
  readonly json: unknown;
}

/** The install-class ops' rescan receipt — one fragment for text + JSON so
 * the two faces can never disagree about whether a rescan ran. */
interface RescanReceipt {
  readonly text: string;
  readonly json: { readonly rescan?: { readonly skills: number; readonly plugins: number; readonly hooks: number } };
}

async function rescanReceipt(ctx: RunContext): Promise<RescanReceipt> {
  try {
    const counts = await (ctx.rescan ?? rescanExtensions)();
    return { text: `   已热重扫：技能 ${counts.skills} · 插件 ${counts.plugins} · hooks ${counts.hooks}`, json: { rescan: counts } };
  } catch (err) {
    // The op already succeeded — an isolated rescan failure must not look
    // like a failed install. Say what stands (config on disk) and what waits.
    return {
      text: `⚠️ 热重扫失败：${err instanceof Error ? err.message : String(err)}（安装已生效；重启后完全一致）`,
      json: {},
    };
  }
}

/** One op through the engine. Every mutating op that changes what discovery
 *  would map — install/uninstall/enable/disable + the remove cascade —
 *  awaits a rescan receipt on success; marketplace add/update never do (no
 *  discovery input moves). Engine warnings ride the receipt as ⚠️ lines;
 *  failures surface as ⚠️ + exit 1 (never a throw). */
async function runPluginOp(op: PluginOp, ctx: RunContext): Promise<OpResult> {
  const warns: string[] = [];
  const engDeps = {
    workspaceRoot: ctx.cwd,
    warn: (m: string) => warns.push(m),
    ...(ctx.env !== undefined ? { env: ctx.env } : {}),
  };
  const env = ctx.env ?? process.env;
  const finish = (code: number, text: string, json: unknown): OpResult => ({
    code,
    text: warns.length > 0 ? `${text}\n${warns.map((w) => `⚠️ ${w}`).join("\n")}` : text,
    json,
  });

  try {
    switch (op.t) {
      case "list": {
        const installed = await pluginListInstalled(engDeps);
        const plugins = loadPlugins(ctx.cwd, [], (m) => warns.push(m), ctx.env !== undefined ? { env: ctx.env } : {});
        const rows =
          installed.length === 0
            ? "  （无已安装插件）"
            : installed
                .map((r) => `  ${r.id.padEnd(34)}${(r.scope === "adhoc" ? "adhoc" : r.scope).padEnd(8)}${r.enabled ? "启用" : "停用"}  ${r.version ?? ""}`)
                .join("\n");
        return finish(
          0,
          `已安装（登记 + 启停状态）：\n${rows}\n已加载（当前映射，含警告）：\n${formatPluginList(plugins)}`,
          { installed, loaded: plugins.map(loadedJson) },
        );
      }
      case "install": {
        const { dir, detail } = await pluginInstall(op.name, op.market, op.scope, engDeps);
        const receipt = await rescanReceipt(ctx);
        const id = `${op.name}@${op.market}`;
        const lines = [
          `✅ 已安装 ${id}（${op.scope} 作用域）→ ${dir}`,
          `   将映射：技能 ${detail.skills} · 命令 ${detail.commands} · agents ${detail.agents} · hooks ${detail.hooks} · MCP ${detail.mcp}`,
          ...(detail.mcp > 0 ? ["   插件的 MCP 服务器在重启后生效（热重扫只换合并配置，不换已生成的工具集）"] : []),
          receipt.text,
        ];
        return finish(0, lines.join("\n"), { id, scope: op.scope, dir, detail, ...receipt.json });
      }
      case "uninstall": {
        await pluginUninstall(op.id, engDeps);
        const receipt = await rescanReceipt(ctx);
        // The engine warns + keeps everything for a rootless project record
        // (it refuses to guess deletions) — claim the deletion only when the
        // engine had nothing to warn about; the ⚠️ lines carry the nuance.
        return finish(0, [`✅ 已卸载 ${op.id}${warns.length === 0 ? "（目录与登记已删除）" : ""}`, receipt.text].join("\n"), { id: op.id, ...receipt.json });
      }
      case "enable":
      case "disable": {
        const on = op.t === "enable";
        await pluginEnable(op.id, on, engDeps);
        const receipt = await rescanReceipt(ctx);
        return finish(0, [`✅ 已${on ? "启用" : "停用"} ${op.id}${on ? "" : "（从当前映射隐藏，登记保留）"}`, receipt.text].join("\n"), { id: op.id, enabled: on, ...receipt.json });
      }
      case "market-add": {
        const info = await marketplaceAdd(op.source, op.name !== undefined ? { name: op.name } : {}, engDeps);
        const counted = marketPluginCount(info.name, env);
        const suffix = counted === undefined ? "" : `— ${counted.plugins} 个插件可安装${counted.skipped > 0 ? `（跳过 ${counted.skipped} 条坏条目）` : ""}`;
        return finish(0, `✅ 市场已添加：${info.name}（源 ${info.source}）${suffix === "" ? "" : ` ${suffix}`}`, {
          market: info,
          ...(counted !== undefined ? { plugins: counted.plugins, skipped: counted.skipped } : {}),
        });
      }
      case "market-list": {
        const markets = await marketplaceList(engDeps);
        if (markets.length === 0) return finish(0, "市场清单：（无已注册市场）", { marketplaces: [] });
        const rows = markets
          .map((m) => `  ${m.name} — ${m.description ?? ""}（源 ${m.source} · 添加于 ${m.addedAt.slice(0, 10)}）`)
          .join("\n");
        return finish(0, `市场清单：\n${rows}`, { marketplaces: markets });
      }
      case "market-update": {
        if (op.name !== undefined) {
          const info = await marketplaceUpdate(op.name, engDeps);
          const counted = marketPluginCount(info.name, env);
          return finish(
            0,
            `✅ 市场已更新：${info.name}${counted !== undefined ? `（${counted.plugins} 个插件）` : ""}`,
            { updated: [info] },
          );
        }
        // bare update = every registered market; one bad market must not
        // hide the others' results (per-line ⚠️, exit 1 if any failed)
        const all = await marketplaceList(engDeps);
        if (all.length === 0) return finish(0, "市场清单：（无已注册市场）", { updated: [] });
        const updated: MarketplaceInfo[] = [];
        const failed: { name: string; error: string }[] = [];
        for (const m of all) {
          try {
            updated.push(await marketplaceUpdate(m.name, engDeps));
          } catch (err) {
            failed.push({ name: m.name, error: err instanceof Error ? err.message : String(err) });
          }
        }
        const lines = [
          `✅ 已更新 ${updated.length}/${all.length} 个市场：`,
          ...updated.map((m) => `  ${m.name} — ${(marketPluginCount(m.name, env)?.plugins ?? "?")} 个插件`),
          ...failed.map((f) => `⚠️ ${f.name} 更新失败：${f.error}`),
        ];
        return finish(failed.length > 0 ? 1 : 0, lines.join("\n"), { updated, ...(failed.length > 0 ? { failed } : {}) });
      }
      case "market-remove": {
        const { removedPlugins } = await marketplaceRemove(op.name, engDeps);
        const receipt = await rescanReceipt(ctx);
        const lines = [
          `✅ 市场已移除：${op.name}`,
          ...(removedPlugins.length > 0 ? [`   连带卸载：${removedPlugins.join("、")}`] : []),
          receipt.text,
        ];
        return finish(0, lines.join("\n"), { market: op.name, removedPlugins, ...receipt.json });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof MarketplaceError ? err.code : "error";
    return finish(1, `⚠️ ${message}`, { error: { code, message } });
  }
}

/** The materialized market's plugin count (for add/update receipts). The
 * engine just materialized/validated the tree, so a read here cannot fail
 * for reasons the caller could act on — undefined just drops the count. */
function marketPluginCount(name: string, env: NodeJS.ProcessEnv): { plugins: number; skipped: number } | undefined {
  try {
    const file = readMarketplaceFile(join(marketplacesDir(env), name));
    return { plugins: file.plugins.length, skipped: file.skipped };
  } catch {
    return undefined;
  }
}

function loadedJson(p: LoadedPlugin): Record<string, unknown> {
  return {
    name: p.name,
    ...(p.version !== undefined ? { version: p.version } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    dir: p.dir,
    source: p.source,
    skills: p.skills.length,
    commands: p.commands.length,
    agents: p.agents.length,
    mcp: Object.keys(p.mcpServers).length,
    hooks: countHookCommands(p.hooks),
    warnings: [...p.warnings],
  };
}

// ---------------------------------------------------------------------------
// The two faces
// ---------------------------------------------------------------------------

/** Shared injection seams (the settings-ops pattern): `env` points the global
 *  home at a test tmpdir; `rescan` replaces the hot-rescan (tests only — the
 *  default reads the real home through the process env). */
export interface PluginCliDeps {
  readonly cwd?: string;
  readonly out?: (s: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly rescan?: PluginRescanFn;
}

/** `wudao plugin <command> [args] [--json]` — exit codes: 0 ok, 1 engine
 *  failure, 2 usage. Mirrors the workflow subcommand dispatch (index.ts). */
export async function pluginMain(argv: readonly string[], deps: PluginCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => {
    process.stdout.write(s);
  });
  const parsed = parsePluginArgs(argv);
  if (parsed.kind === "help") {
    out(`${USAGE_CLI}\n`);
    return 0;
  }
  if (parsed.kind === "usage") {
    out(`${usageText(parsed.reason, "cli")}\n`);
    return 2;
  }
  const r = await runPluginOp(parsed.op, { cwd: deps.cwd ?? process.cwd(), ...(deps.env !== undefined ? { env: deps.env } : {}), ...(deps.rescan !== undefined ? { rescan: deps.rescan } : {}) });
  if (parsed.json) out(`${JSON.stringify(r.json, null, 2)}\n`);
  else out(`${r.text}\n`);
  return r.code;
}

/** Quote-aware tokenization for the slash face (E3 · B1 minor): the REPL
 *  hands us ONE line, and a market source with spaces — `marketplace add
 *  "file:///path with space"` — must arrive at the engine as a single bare
 *  token, not a source still wearing its quotes. Single or double quotes
 *  group; whitespace INSIDE quotes never splits; a fully-quoted empty string
 *  still produces one empty token (`""` → [""]); an unclosed quote runs to
 *  end-of-line (lenient, like an interactive shell); empty/whitespace-only
 *  input → [] (the old `trim().split(/\s+/)` semantics, kept). The CLI face
 *  never uses this — argv arrives pre-tokenized from the process. */
export function tokenizeArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (/\s/.test(ch)) {
      if (cur !== "" || has) out.push(cur);
      cur = ""; has = false;
    } else cur += ch;
  }
  if (cur !== "" || has) out.push(cur);
  return out;
}

/** `/plugin <sub> [args]` — the same engine, prose output for the notice
 *  channels. Busy (a run in flight): the directory-deleting ops — uninstall
 *  and marketplace remove (cascade) — refuse with the /clear family notice
 *  BEFORE any engine call; everything else is config-only and proceeds.
 *  `--json` in the args is accepted and ignored (the notice channel has no
 *  JSON consumer). Never throws: failures return ⚠️ notices. */
export async function runPluginSlashCommand(opts: {
  readonly args: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly rescan?: PluginRescanFn;
  readonly busy?: boolean;
}): Promise<string> {
  const tokens = tokenizeArgs(opts.args);
  const parsed = parsePluginArgs(tokens);
  if (parsed.kind === "help") return USAGE_SLASH;
  if (parsed.kind === "usage") return usageText(parsed.reason, "slash");
  if (opts.busy === true && (parsed.op.t === "uninstall" || parsed.op.t === "market-remove")) {
    return `⚠️ 运行中无法 /plugin ${parsed.op.t === "uninstall" ? "uninstall" : "marketplace remove"}（任务进行中）`;
  }
  const r = await runPluginOp(parsed.op, {
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.rescan !== undefined ? { rescan: opts.rescan } : {}),
  });
  return r.text;
}
