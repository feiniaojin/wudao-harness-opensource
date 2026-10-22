// M42 §2 — listSlashCommands: the single source of slash-command truth
// (builtin + /skill:* + plugin + extension, deduped in parse priority), the
// prefix filter, the menu-open token rule, and the readline completer.
import { describe, it, expect } from "vitest";
import {
  listSlashCommands,
  filterSlashCommands,
  slashToken,
  completeSlashLine,
  slashCompleter,
  slashDisplay,
  formatSlashHelp,
} from "../src/slash-commands.js";
import type { LoadedSkill } from "../src/skills.js";
import type { PluginCommand } from "../src/plugins.js";

const skill = (name: string, description: string): LoadedSkill => ({
  name,
  description,
  filePath: `/tmp/${name}/SKILL.md`,
  relPath: `.wudao/skills/${name}/SKILL.md`,
  content: "body",
});

const pluginCommand = (name: string, description: string): PluginCommand => ({
  name,
  description,
  filePath: `/tmp/cmd/${name}.md`,
  body: "template",
  plugin: "acme",
});

describe("listSlashCommands", () => {
  it("lists the builtin commands with no extras loaded", () => {
    const names = listSlashCommands({}).map((c) => c.name);
    expect(names).toEqual([
      "exit", "clear", "help", "resume", "plan", "rewind", "memory", "refine", "search", "btw", "compact", "context",
      // PB-2（探针基础设施弧）: /probe（遥测直读查询，/context 后位的即时面）。
      "probe",
      "edit", "tree", "switch",
      // M55 §A: the command-parity pack.
      "init", "status", "cost", "rename", "diff", "config",
      // M55 §B: the medium-command pack. M63 §A: /provider joins after /effort.
      // 2026-08-23 persona 层：/persona joins after /provider.
      // 推理档三级配置 S4: /language joins after /effort (the session lane).
      "model", "effort", "language", "provider", "persona", "permissions", "export", "review", "security-review", "mcp", "agents",
      // M55 §C: the command-parity finale pack.
      "add-dir", "doctor", "tasks",
      // ω99-15: /mission (the task campaign's face, between /goal and
      // /schedule — the 0.3.41 full gate caught this pin lagging).
      "skill:", "loop", "goal", "mission", "schedule",
      // cc-plugins B1: /plugin (the plugin/marketplace command face).
      "plugin",
      // P1-5 (96 队列): /trust (the workspace trust gate's face).
      "trust",
      // P1-7 (96 队列): /worktree (the main session's isolated worktree).
      "worktree",
      // P2-13 (96 队列 #13): /constitution (the user constitution's face).
      "constitution",
    ]);
  });

  it("workspace/personal skills join as /<name> entries with origin annotation", () => {
    // cc-plugins D3: workspace/personal skills render under /<name> with the
    // tier tagged in the description; the legacy /skill:<name> entry shape is
    // gone (the legacy alias lives in the builtin /skill: annotation).
    const cmds = listSlashCommands({ skills: [skill("alpha", "Alpha rules"), skill("beta", "Beta rules")] });
    const alpha = cmds.find((c) => c.name === "alpha");
    expect(alpha?.description).toContain("Alpha rules");
    expect(alpha?.source).toBe("skill");
    expect(cmds.map((c) => c.name)).toContain("beta");
    // ω99-162 NEW#2: 插件技能的描述后缀换中文词表——「（插件：<plugin>）」。
    const withPlugin = listSlashCommands({ skills: [{ ...skill("gamma", "Gamma rules"), plugin: "acme" }] });
    expect(withPlugin.find((c) => c.name === "acme:gamma")?.description).toBe("Gamma rules（插件：acme）");
  });

  it("plugin and extension commands join after skills, with their sources", () => {
    const cmds = listSlashCommands({
      skills: [skill("alpha", "Alpha rules")],
      pluginCommands: [pluginCommand("deploy", "Deploy the app")],
      extensionCommands: [{ name: "sync", extension: "watcher" }],
    });
    expect(cmds.find((c) => c.name === "deploy")?.source).toBe("plugin");
    expect(cmds.find((c) => c.name === "deploy")?.description).toBe("Deploy the app");
    const sync = cmds.find((c) => c.name === "sync");
    expect(sync?.source).toBe("extension");
    expect(sync?.description).toContain("watcher");
    // order: builtin > skill > plugin > extension
    expect(cmds.map((c) => c.name).indexOf("alpha")).toBeLessThan(cmds.map((c) => c.name).indexOf("deploy"));
    expect(cmds.map((c) => c.name).indexOf("deploy")).toBeLessThan(cmds.map((c) => c.name).indexOf("sync"));
  });

  it("dedupes defensively: builtin wins over a same-named plugin, plugin over extension", () => {
    const cmds = listSlashCommands({
      pluginCommands: [pluginCommand("clear", "hijack"), pluginCommand("deploy", "Deploy the app")],
      extensionCommands: [{ name: "deploy", extension: "watcher" }, { name: "help", extension: "watcher" }],
    });
    expect(cmds.filter((c) => c.name === "clear").length).toBe(1);
    expect(cmds.find((c) => c.name === "clear")?.source).toBe("builtin");
    expect(cmds.filter((c) => c.name === "deploy").length).toBe(1);
    expect(cmds.find((c) => c.name === "deploy")?.source).toBe("plugin");
    expect(cmds.filter((c) => c.name === "help").length).toBe(1);
  });

  it("usage args ride along for display (completion still inserts only the name)", () => {
    const cmds = listSlashCommands({});
    expect(cmds.find((c) => c.name === "plan")?.args).toBe("<goal>");
    expect(cmds.find((c) => c.name === "rewind")?.args).toBe("[n|last|turn [n]]");
    // ω99-5a: /schedule grows the pause/unpause/run daemon verbs.
    // ω99-313: snooze joins the verb list (reminder snooze) — the pin evolved
    // here after landing stale-red (caught by ω99-316's walk; m81 precedent).
    expect(cmds.find((c) => c.name === "schedule")?.args).toBe("[list|add|rm|pause|unpause|run|snooze]");
  });
});

describe("filterSlashCommands", () => {
  const cmds = listSlashCommands({
    skills: [skill("alpha", "Alpha rules")],
    pluginCommands: [pluginCommand("deploy", "Deploy the app")],
  });

  it("empty token matches everything (bare / opens the whole menu)", () => {
    expect(filterSlashCommands(cmds, "").length).toBe(cmds.length);
  });

  it("prefix filter is line-inline and exact-prefix (no fuzzy, no substring)", () => {
    const names = filterSlashCommands(cmds, "he").map((c) => c.name);
    expect(names).toEqual(["help"]);
    expect(filterSlashCommands(cmds, "elp").map((c) => c.name)).toEqual([]);
  });

  it("matches the workspace skill name and plugin names by prefix", () => {
    // cc-plugins D3: skills render as /<name>, so a "al" prefix finds the
    // workspace skill alpha (no skill: namespace prefix anymore).
    expect(filterSlashCommands(cmds, "al").map((c) => c.name)).toEqual(["alpha"]);
    expect(filterSlashCommands(cmds, "de").map((c) => c.name)).toEqual(["deploy"]);
  });
});

describe("slashToken", () => {
  it("extracts the token after / while no whitespace is typed", () => {
    expect(slashToken("/")).toBe("");
    expect(slashToken("/he")).toBe("he");
    expect(slashToken("/skill:al")).toBe("skill:al");
  });

  it("returns undefined once args appear, or when the line is not a command", () => {
    expect(slashToken("/help me")).toBeUndefined();
    expect(slashToken("hello")).toBeUndefined();
    expect(slashToken("")).toBeUndefined();
    expect(slashToken("see /help")).toBeUndefined();
  });
});

describe("completeSlashLine", () => {
  it("replaces the slash token with the selected command name", () => {
    expect(completeSlashLine("/he", "help")).toBe("/help");
    // cc-plugins D3: workspace/personal skills complete under /<name>.
    expect(completeSlashLine("/", "alpha")).toBe("/alpha");
  });
});

describe("slashCompleter (REPL simple version)", () => {
  const cmds = listSlashCommands({
    skills: [skill("alpha", "Alpha rules")],
    pluginCommands: [pluginCommand("deploy", "Deploy the app")],
  });

  it("offers name-only completions for a slash line without args", () => {
    const [hits, line] = slashCompleter("/he", cmds);
    expect(hits).toEqual(["/help"]);
    expect(line).toBe("/he");
  });

  it("bare / offers every command name", () => {
    const [hits] = slashCompleter("/", cmds);
    expect(hits).toEqual(cmds.map((c) => `/${c.name}`));
  });

  it("non-slash lines and arg-carrying slash lines complete nothing", () => {
    expect(slashCompleter("hello", cmds)[0]).toEqual([]);
    expect(slashCompleter("/help me", cmds)[0]).toEqual([]);
  });
});

describe("formatSlashHelp (M42 §4 — /help from the same data source)", () => {
  const cmds = listSlashCommands({
    skills: [skill("alpha", "Alpha rules")],
    pluginCommands: [pluginCommand("deploy", "Deploy the app")],
    extensionCommands: [{ name: "sync", extension: "watcher" }],
  });

  it("renders every entry (builtin usage args + skill/plugin/extension), then keys and mode", () => {
    const text = formatSlashHelp(cmds, { mode: "auto" });
    expect(text).toContain("命令："); // ω99-162: commands: 头钉随源演进（隐藏钉·同串机械演进）。
    expect(text).toContain("  /exit  退出"); // ω99-162: 描述钉随源演进（exit 新描述）。
    expect(text).toContain("退出"); // ω99-162 NEW#1: /help 正文含 exit 新中文描述「退出」。
    expect(text).toContain("  /plan <goal>  先只读规划，回 ok 才执行 · 改 <意见> 可修订"); // ω99-162: 描述钉随源演进（中英混排整行重算）。
    expect(text).toContain("  /rewind [n|last|turn [n]]  列出/撤销文件改动；turn [n] 回退对话轮"); // ω99-162: 描述钉随源演进。
    expect(text).toContain("  /skill:name [args]  调用已加载的技能（裸 /skill: 列出全部）"); // ω99-162: 描述钉随源演进。
    // cc-plugins D3: workspace/personal skill now renders as /<name> with
    // origin annotation; the legacy /skill: builtin annotation stays for
    // back-compat.
    expect(text).toContain("  /alpha");
    expect(text).toContain("Alpha rules");
    expect(text).toContain("  /deploy  Deploy the app");
    expect(text).toContain("  /sync  extension command (watcher)");
    expect(text).toContain("键位（可在 .wudao/keybindings.json 重映射——见 README）："); // ω99-162: TUI 键位头钉随源演进。
    expect(text).toContain("\\+Enter");
    expect(text).toContain("shift+tab 切换模式"); // ω99-161: 默认 keysLine 随源演进。
    // ω99-161: 默认 keysLine 中文化全串钉（#8——模式名 token 原样）。
    expect(text).toContain("Enter 发送 · \\+Enter 换行 · Esc 中断 · shift+tab 切换模式 (accept → ask → auto → plan)"); // ω99-191: 钉随源演进
    expect(text.endsWith("模式：auto")).toBe(true); // ω99-162: mode: 行钉随源演进（mode 标识符原样；隐藏钉·同串机械演进）。
  });

  it("the keys detail line and header are frontend-parametric (REPL form)", () => {
    // ω99-161: caller 自带 keysLine 的 echo 语义不变，字面量随源演进到新词表。
    const text = formatSlashHelp(cmds, { mode: "ask", frontend: "repl", keysLine: "Tab 补全 /命令 · shift+tab 切换模式" });
    // ω99-162: keys: 头钉随源演进为「键位：」＝新增最小断言 #3（REPL 变体；TUI 形态是「键位（可在…重映射…）：」，不含本串）。
    expect(text).toContain("键位：");
    expect(text).not.toContain("keybindings.json");
    expect(text).toContain("Tab 补全 /命令 · shift+tab 切换模式");
    expect(text).toContain("模式：ask"); // ω99-162: mode: 行钉随源演进。
  });

  it("omits the mode line when no mode is given", () => {
    expect(formatSlashHelp(cmds)).not.toContain("mode:");
  });
});

describe("slashDisplay", () => {
  it("joins usage args with a space, except after a colon-terminated name", () => {
    const cmds = listSlashCommands({});
    expect(slashDisplay(cmds.find((c) => c.name === "plan")!)).toBe("/plan <goal>");
    expect(slashDisplay(cmds.find((c) => c.name === "skill:", "loop", "goal", "schedule")!)).toBe("/skill:name [args]");
    expect(slashDisplay(cmds.find((c) => c.name === "exit")!)).toBe("/exit");
  });
});
