import { describe, it, expect } from "vitest";
import { parseSessionFlags, parseSandboxFlags, parseProviderFlags, parsePluginFlags, parsePlanFlag, parseAblationFlags, applyAblationFlagsToEnv, ablationEnvVar, splitEndOfOptions, subcommandArgv, ABLATION_FEATURES } from "../src/args.js";
import { askReviewArmed } from "../src/ask-reviewer.js";
import { promptFromArgv, stripLogFlags } from "../src/log.js";
import { modeFromArgv } from "../src/permission.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

describe("parseSessionFlags", () => {
  it("no flags → fresh session shape", () => {
    expect(parseSessionFlags([])).toEqual({ resumeId: undefined, cont: false, list: false });
    expect(parseSessionFlags(["hi", "there"])).toEqual({ resumeId: undefined, cont: false, list: false });
  });
  it("--resume <v> → resumeId", () => {
    expect(parseSessionFlags(["--resume", "abc"])).toEqual({ resumeId: "abc", cont: false, list: false });
    expect(parseSessionFlags(["hi", "--resume", "abc", "there"])).toEqual({ resumeId: "abc", cont: false, list: false });
  });
  it("--resume=<v> → resumeId", () => {
    expect(parseSessionFlags(["--resume=abc"])).toEqual({ resumeId: "abc", cont: false, list: false });
  });
  it("single-dash -resume <v> tolerated", () => {
    expect(parseSessionFlags(["-resume", "abc"])).toEqual({ resumeId: "abc", cont: false, list: false });
  });
  it("-resume=<v> tolerated", () => {
    expect(parseSessionFlags(["-resume=abc"])).toEqual({ resumeId: "abc", cont: false, list: false });
  });
  it("--resume followed by a flag-looking token → no resumeId", () => {
    expect(parseSessionFlags(["--resume", "--auto"])).toEqual({ resumeId: undefined, cont: false, list: false });
    expect(parseSessionFlags(["--resume", "-v"])).toEqual({ resumeId: undefined, cont: false, list: false });
  });
  it("bare --resume at end of argv → no resumeId", () => {
    expect(parseSessionFlags(["--resume"])).toEqual({ resumeId: undefined, cont: false, list: false });
  });
  it("--continue → cont", () => {
    expect(parseSessionFlags(["--continue"])).toEqual({ resumeId: undefined, cont: true, list: false });
  });
  it("--list-sessions → list", () => {
    expect(parseSessionFlags(["--list-sessions"])).toEqual({ resumeId: undefined, cont: false, list: true });
  });
  it("resume wins over continue when both present", () => {
    expect(parseSessionFlags(["--continue", "--resume", "abc"])).toEqual({ resumeId: "abc", cont: true, list: false });
  });
  it("empty value after --resume → no resumeId", () => {
    expect(parseSessionFlags(["--resume", ""])).toEqual({ resumeId: undefined, cont: false, list: false });
  });
});

describe("parseSandboxFlags", () => {
  it("no flag / no env → disabled", () => {
    expect(parseSandboxFlags([], {})).toEqual({ enabled: false });
    expect(parseSandboxFlags(["hi"], { WUDAO_SANDBOX: "0" })).toEqual({ enabled: false });
    expect(parseSandboxFlags(["hi"], { WUDAO_SANDBOX: "true" })).toEqual({ enabled: false });
  });
  it("--sandbox flag → enabled", () => {
    expect(parseSandboxFlags(["--sandbox", "do", "stuff"], {})).toEqual({ enabled: true });
  });
  it("WUDAO_SANDBOX=1 env → enabled", () => {
    expect(parseSandboxFlags(["hi"], { WUDAO_SANDBOX: "1" })).toEqual({ enabled: true });
  });
  it("flag or env each suffice", () => {
    expect(parseSandboxFlags(["--sandbox"], { WUDAO_SANDBOX: "1" })).toEqual({ enabled: true });
  });
  it("WUDAO_SANDBOX_IMAGE → image (only when enabled)", () => {
    expect(parseSandboxFlags([], { WUDAO_SANDBOX: "1", WUDAO_SANDBOX_IMAGE: "node:20-alpine" })).toEqual({ enabled: true, image: "node:20-alpine" });
    expect(parseSandboxFlags([], { WUDAO_SANDBOX_IMAGE: "node:20-alpine" })).toEqual({ enabled: false });
  });
  it("blank WUDAO_SANDBOX_IMAGE → no image (default applies in core)", () => {
    expect(parseSandboxFlags(["--sandbox"], { WUDAO_SANDBOX_IMAGE: "  " })).toEqual({ enabled: true });
  });
});

describe("parseProviderFlags", () => {
  it("no flags → empty selection", () => {
    expect(parseProviderFlags([])).toEqual({});
    expect(parseProviderFlags(["hi", "there"])).toEqual({});
  });
  it("--provider <v> → provider", () => {
    expect(parseProviderFlags(["--provider", "glm"])).toEqual({ provider: "glm" });
    expect(parseProviderFlags(["hi", "--provider", "qwen", "there"])).toEqual({ provider: "qwen" });
  });
  it("--provider=<v> and single-dash forms tolerated", () => {
    expect(parseProviderFlags(["--provider=glm"])).toEqual({ provider: "glm" });
    expect(parseProviderFlags(["-provider", "glm"])).toEqual({ provider: "glm" });
    expect(parseProviderFlags(["-provider=glm"])).toEqual({ provider: "glm" });
  });
  it("--reasoning-effort <v> → reasoningEffort (all forms)", () => {
    expect(parseProviderFlags(["--reasoning-effort", "high"])).toEqual({ reasoningEffort: "high" });
    expect(parseProviderFlags(["--reasoning-effort=max"])).toEqual({ reasoningEffort: "max" });
    expect(parseProviderFlags(["-reasoning-effort", "low"])).toEqual({ reasoningEffort: "low" });
    expect(parseProviderFlags(["-reasoning-effort=none"])).toEqual({ reasoningEffort: "none" });
  });
  it("both flags together", () => {
    expect(parseProviderFlags(["--provider", "glm", "--reasoning-effort", "high", "do it"]))
      .toEqual({ provider: "glm", reasoningEffort: "high" });
  });
  it("flag-looking token after --provider is not eaten", () => {
    expect(parseProviderFlags(["--provider", "--auto"])).toEqual({});
    expect(parseProviderFlags(["--reasoning-effort", "-v"])).toEqual({});
  });
  it("bare flags at end of argv → no value", () => {
    expect(parseProviderFlags(["--provider"])).toEqual({});
    expect(parseProviderFlags(["--reasoning-effort"])).toEqual({});
  });
  // R3-T002 深测弧：--model 旗标（显式模型 > env 钉 > profile 缺省链的
  // 最高档）。同形双拼：空格/等号、单双横线；旗标样值不吞；缺席=键缺席。
  it("--model <v> → model（all forms）；与 --provider 组合", () => {
    expect(parseProviderFlags(["--model", "glm-5.3"])).toEqual({ model: "glm-5.3" });
    expect(parseProviderFlags(["--model=glm-5.3"])).toEqual({ model: "glm-5.3" });
    expect(parseProviderFlags(["-model", "glm-5.3"])).toEqual({ model: "glm-5.3" });
    expect(parseProviderFlags(["-model=glm-5.3"])).toEqual({ model: "glm-5.3" });
    expect(parseProviderFlags(["--provider", "glm-code", "--model", "glm-5.3-flash", "干活"]))
      .toEqual({ provider: "glm-code", model: "glm-5.3-flash" });
    expect(parseProviderFlags(["--model", "--auto"])).toEqual({});
    expect(parseProviderFlags(["--model"])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// M36: --plugin <path> (repeatable one-shot plugin mounts)
// ---------------------------------------------------------------------------

describe("parsePluginFlags", () => {
  it("no flags → empty list", () => {
    expect(parsePluginFlags([])).toEqual([]);
    expect(parsePluginFlags(["just", "a", "prompt"])).toEqual([]);
  });
  it("--plugin <path> → [path]", () => {
    expect(parsePluginFlags(["--plugin", "./vendor/p"])).toEqual(["./vendor/p"]);
    expect(parsePluginFlags(["do", "it", "--plugin", "/abs/plugin"])).toEqual(["/abs/plugin"]);
  });
  it("repeatable, in argv order", () => {
    expect(parsePluginFlags(["--plugin", "a", "--plugin", "b"])).toEqual(["a", "b"]);
  });
  it("--plugin=<v> and single-dash forms tolerated", () => {
    expect(parsePluginFlags(["--plugin=a"])).toEqual(["a"]);
    expect(parsePluginFlags(["-plugin", "b"])).toEqual(["b"]);
    expect(parsePluginFlags(["-plugin=c"])).toEqual(["c"]);
  });
  it("flag-looking token after --plugin is not eaten", () => {
    expect(parsePluginFlags(["--plugin", "--auto"])).toEqual([]);
    expect(parsePluginFlags(["--plugin"])).toEqual([]);
    expect(parsePluginFlags(["--plugin="])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M37 §1: --plan — one-shot plan mode (boolean flag, --sandbox parsing style)
// ---------------------------------------------------------------------------

describe("parsePlanFlag", () => {
  it("absent → false", () => {
    expect(parsePlanFlag([])).toBe(false);
    expect(parsePlanFlag(["do", "the", "thing"])).toBe(false);
    expect(parsePlanFlag(["--auto"])).toBe(false);
  });
  it("--plan (or -plan) → true", () => {
    expect(parsePlanFlag(["--plan", "add", "the", "feature"])).toBe(true);
    expect(parsePlanFlag(["-plan"])).toBe(true);
  });
  it("a literal 'plan' word is not the flag", () => {
    expect(parsePlanFlag(["plan", "the", "migration"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// design 70 Phase 2 — the ask-reviewer ablation flag: `--no-ask-reviewer`
// bridges into WUDAO_NO_ASK_REVIEWER, which the module's own env read
// already honors (armed = env-armed AND NOT ablated — they never fight).
// ---------------------------------------------------------------------------

describe("ask-reviewer ablation", () => {
  it("--no-ask-reviewer parses into the flag record (dash/underscore forms, prompt-scoped)", () => {
    expect(parseAblationFlags(["--no-ask-reviewer"])["ask-reviewer"]).toBe(true);
    expect(parseAblationFlags(["--no-ask-reviewer", "fix", "it"])["ask-reviewer"]).toBe(true);
    expect(parseAblationFlags(["-no_ask_reviewer"])["ask-reviewer"]).toBe(true);
    expect(parseAblationFlags(["fix", "--no-ask-reviewer"])["ask-reviewer"]).toBe(false); // after the prompt word → a word, never a flag
    // `=`-forms are not part of the ablation contract for ANY feature (the
    // captured name would be "ask-reviewer=1"); unknown --no- flags are
    // ignored, never errors — pinned here so the row is not mistaken for a
    // supported form later.
    expect(parseAblationFlags(["--no-ask-reviewer=1"])["ask-reviewer"]).toBe(false);
  });

  it("ablationEnvVar spells the module's own kill-switch name", () => {
    expect(ablationEnvVar("ask-reviewer")).toBe("WUDAO_NO_ASK_REVIEWER");
  });

  it("the bridge disarms even when the opt-in env is set (armed = env-armed AND NOT ablated)", () => {
    const env: NodeJS.ProcessEnv = { WUDAO_ASK_REVIEWER: "1" };
    applyAblationFlagsToEnv(parseAblationFlags(["--no-ask-reviewer"]), env);
    expect(env.WUDAO_NO_ASK_REVIEWER).toBe("1");
    expect(askReviewArmed(env)).toBe(false);
  });

  it("without the flag the opt-in still arms — the bridge never fights the module's own env read", () => {
    const env: NodeJS.ProcessEnv = { WUDAO_ASK_REVIEWER: "1" };
    applyAblationFlagsToEnv(parseAblationFlags(["--no-gates"]), env);
    expect(env.WUDAO_NO_ASK_REVIEWER).toBeUndefined();
    expect(askReviewArmed(env)).toBe(true);
  });

  it("the raw env kill switch alone (no flag) still disarms", () => {
    const env: NodeJS.ProcessEnv = { WUDAO_ASK_REVIEWER: "1", WUDAO_NO_ASK_REVIEWER: "1" };
    applyAblationFlagsToEnv(parseAblationFlags([]), env);
    expect(askReviewArmed(env)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-of-options `--` (pi precedent): the FIRST bare `--` ends flag parsing —
// every token after it is a positional (prompt word), even flag-looking ones;
// the `--` itself joins neither the flags nor the prompt. Later `--` tokens
// are ordinary positionals. Without a bare `--` the split is the identity, so
// the no-`--` parse is byte-identical to before (zero drift).
// ---------------------------------------------------------------------------

describe("end-of-options --: splitEndOfOptions", () => {
  it("no bare -- → identity split (flag parse unchanged, positionals empty)", () => {
    expect(splitEndOfOptions(["fix", "--auto", "it"])).toEqual({ flagWindow: ["fix", "--auto", "it"], positionals: [] });
    expect(splitEndOfOptions([])).toEqual({ flagWindow: [], positionals: [] });
  });
  it("first bare -- splits: later tokens are positionals, flag-looking or not", () => {
    expect(splitEndOfOptions(["--", "--help"])).toEqual({ flagWindow: [], positionals: ["--help"] });
    expect(splitEndOfOptions(["--resume", "abc", "--", "-x"])).toEqual({ flagWindow: ["--resume", "abc"], positionals: ["-x"] });
  });
  it("only the FIRST -- separates — a second/later -- is an ordinary positional (pi convention)", () => {
    expect(splitEndOfOptions(["--", "a", "--", "b"])).toEqual({ flagWindow: [], positionals: ["a", "--", "b"] });
  });
  it("a `--` look-alike (`--=x`) is not the separator", () => {
    expect(splitEndOfOptions(["a", "--=x", "b"])).toEqual({ flagWindow: ["a", "--=x", "b"], positionals: [] });
  });
});

describe("end-of-options --: promptFromArgv", () => {
  it("brief ①: `-- --help` → prompt is exactly \"--help\" — after `--` it is a prompt word, never a flag/short-circuit", () => {
    expect(promptFromArgv(["--", "--help"])).toBe("--help");
  });
  it("brief ②: `--foo -- -x -y` → \"--foo -x -y\" — this parser has NO unknown-flag error; unknown flags are prompt words before AND after `--`", () => {
    expect(promptFromArgv(["--foo", "--", "-x", "-y"])).toBe("--foo -x -y");
  });
  it("brief ③ (pin, no `--`): a `-`-leading prompt stays verbatim prompt words — current behavior", () => {
    expect(promptFromArgv(["-x", "-y"])).toBe("-x -y");
  });
  it("the separator itself never joins the prompt; a bare `wudao --` has NO prompt", () => {
    expect(promptFromArgv(["--"])).toBe("");
  });
  it("known flags still strip BEFORE the `--`; positionals append after the window's words", () => {
    expect(promptFromArgv(["--auto", "fix", "--", "--resume", "id"])).toBe("fix --resume id");
  });
  it("no `--` → exactly the pre-change composition (zero-drift pin)", () => {
    expect(promptFromArgv(["hi", "--resume", "abc", "there", "--provider", "glm"])).toBe("hi there");
  });
  it("a later `--` joins the prompt as an ordinary word", () => {
    expect(promptFromArgv(["--", "a", "--", "b"])).toBe("a -- b");
  });
});

describe("end-of-options --: flags after the separator are inert", () => {
  it("session flags parse on the flag window only (production threads the window)", () => {
    const { flagWindow } = splitEndOfOptions(["--", "--continue", "--resume", "abc"]);
    expect(parseSessionFlags(flagWindow)).toEqual({ resumeId: undefined, cont: false, list: false });
  });
  it("permission mode flags after the separator never arm (modeFromArgv on the window)", () => {
    const { flagWindow } = splitEndOfOptions(["--provider", "glm", "--", "--auto"]);
    expect(modeFromArgv(["node", "wudao", ...flagWindow])).toBe("workspace");
    const none = splitEndOfOptions(["fix", "it", "--", "--ask"]);
    expect(modeFromArgv(["node", "wudao", ...none.flagWindow])).toBe("workspace");
  });
});

// ---------------------------------------------------------------------------
// End-of-options follow-up: subcommands must not silently lose the post-`--`
// window. The top-level splice normalizes process.argv to the flag window, so
// a subcommand dispatch that consumes argv positionally (its subcommand word,
// file paths, the search query) only saw the window — `wudao sessions search
// foo -- --bar` searched "foo" with `--bar` silently gone. subcommandArgv is
// the dispatch-side composition: window slice + positionals appended verbatim
// (the SAME composition promptFromArgv builds for the one-shot prompt).
// Flag-only dispatches (perms/statusline/ui/slack/purge) keep reading the
// window — post-`--` tokens are never flags, and those branches take no
// positional data, so inertness there IS the contract, not a truncation.
// ---------------------------------------------------------------------------

describe("end-of-options --: subcommandArgv (subcommand passthrough)", () => {
  it("the reported silent truncation: `sessions search foo -- --bar` → query \"foo --bar\" (index.ts joins slice(4) with spaces)", () => {
    const raw = ["node", "wudao", "sessions", "search", "foo", "--", "--bar"];
    expect(subcommandArgv(raw, 4).join(" ").trim()).toBe("foo --bar");
  });
  it("all query after the separator: `sessions search -- foo bar` → query \"foo bar\" (was a loud empty-query usage)", () => {
    const raw = ["node", "wudao", "sessions", "search", "--", "foo", "bar"];
    expect(subcommandArgv(raw, 4).join(" ").trim()).toBe("foo bar");
  });
  it("data-consuming subcommands see carved-off tokens: `workflow -- run x.wf` dispatches run x.wf; `plugin -- list` lists", () => {
    expect(subcommandArgv(["node", "wudao", "workflow", "--", "run", "x.wf"], 3)).toEqual(["run", "x.wf"]);
    expect(subcommandArgv(["node", "wudao", "plugin", "--", "list"], 3)).toEqual(["list"]);
  });
  it("no bare `--` → exactly rawArgv.slice(from) — zero drift for every dispatch (pin)", () => {
    expect(subcommandArgv(["node", "wudao", "workflow", "run", "x.wf", "--args", `{"a":1}`], 3))
      .toEqual(["run", "x.wf", "--args", `{"a":1}`]);
    expect(subcommandArgv(["node", "wudao", "sessions", "search", "fix", "it"], 4)).toEqual(["fix", "it"]);
    expect(subcommandArgv(["node", "wudao", "meta", "report"], 3)).toEqual(["report"]);
  });
});

// ---------------------------------------------------------------------------
// ω99-22 T1 — the dogfood flag-leak fix (P1). Four flags the CLI parses
// (--ask in permission.ts, --no-sidecar in the ablation matrix,
// --trust-workspace / --name in args.ts) were missing from stripLogFlags, so
// they leaked into the one-shot prompt as literal words — worst case
// `wudao --trust-workspace` armed a one-shot run with the PROMPT
// "--trust-workspace" instead of falling into the REPL (index.ts's
// `if (!prompt)` branch), and `--ask "修 bug"` put "--ask" in the model's
// first user message.
// ---------------------------------------------------------------------------

describe("ω99-22: promptFromArgv strips the four leaked flags", () => {
  it("brief table: --ask / --no-sidecar / --name <v> / --trust-workspace never join the prompt", () => {
    expect(promptFromArgv(["--ask", "hello"])).toBe("hello");
    expect(promptFromArgv(["--no-sidecar", "hello"])).toBe("hello");
    expect(promptFromArgv(["--name", "foo", "hello"])).toBe("hello");
    expect(promptFromArgv(["--trust-workspace"])).toBe("");
  });

  it("single-dash variants and =-forms strip too (existing entry style)", () => {
    expect(promptFromArgv(["-ask", "hi"])).toBe("hi");
    expect(promptFromArgv(["-no-sidecar", "hi"])).toBe("hi");
    expect(promptFromArgv(["-trust-workspace", "hi"])).toBe("hi");
    expect(promptFromArgv(["-name", "foo", "hi"])).toBe("hi");
    expect(promptFromArgv(["--name=foo", "hi"])).toBe("hi");
    expect(promptFromArgv(["-name=foo", "hi"])).toBe("hi");
  });

  it("regression trio pins the pre-ω99-22 stripping semantics (zero drift)", () => {
    expect(promptFromArgv(["--no-tui", "--auto"])).toBe("");
    expect(promptFromArgv(["--plan", "fix", "it"])).toBe("fix it");
    expect(promptFromArgv(["--image", "a.png", "hi"])).toBe("hi");
  });
});

// ω99-22 超越点 — the flag-universe pin: mechanically extract every `--flag`
// literal from args.ts's source text and assert stripLogFlags consumes each
// one, so a future flag added to the parser without a strip branch fails
// HERE first instead of leaking into dogfood prompts. Comments are stripped
// before extraction: docs legitimately mention flags stripLogFlags must NOT
// strip as literals (--no-gates &co are ablation-matrix members, not argv
// literals), and the bare `--` separator can never match the extraction
// regex (exempt by construction).
describe("ω99-22: flag universe — every --flag parsed in args.ts is stripped from the prompt", () => {
  it("stripLogFlags consumes every --flag literal in args.ts (code, comments exempt)", async () => {
    const src = await readFile(fileURLToPath(new URL("../src/args.ts", import.meta.url)), "utf8");
    const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, "");
    const noLines = noBlocks.replace(/\/\/[^\n]*/g, "");
    const universe = [...new Set(noLines.match(/--[a-z][a-z-]*/g) ?? [])].sort();
    // sanity: extraction found the long-standing flags and never the separator
    expect(universe).toContain("--resume");
    expect(universe).toContain("--log-level");
    expect(universe).not.toContain("--");
    // ω99-130: print-and-exit flags are exempt — when parseHelpVersionFlags
    // recognizes them (leading position) the process exits before any prompt
    // exists; when it does not (mid-prompt / post-`--`), they are prompt
    // words BY DESIGN, so a stripLogFlags branch would eat prompt words.
    const SHORT_CIRCUIT = new Set(["--help", "--version"]);
    const leaking = universe.filter((f) => !SHORT_CIRCUIT.has(f) && stripLogFlags([f]).length > 0);
    expect(leaking, `flags parsed by args.ts but leaking into the prompt: ${leaking.join(" ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 修复环 R1（控制器走查判定 Important）——the ablation family is BOUNDED
// (ABLATION_FEATURES, args.ts) and parseAblationFlags accepts hyphen +
// underscore spellings, single/double dash (`-{1,2}no[-_]name`). ω99-22 T1
// only special-cased --no-sidecar: the other 13 features' hyphen forms and
// ALL 14 underscore forms leaked into the prompt (`wudao --no-gates "修bug"`
// → prompt "--no-gates 修bug"; a lone --no-gates armed a ONE-SHOT instead of
// the REPL — same root cause as the ω99-20B launch failures). stripLogFlags
// now consumes the family from the SAME imported list (single source): a
// future feature is auto-covered, no bookkeeping.
// ---------------------------------------------------------------------------

describe("ω99-22 R1: the whole ablation family strips (single source: ABLATION_FEATURES)", () => {
  it("every feature, in all three documented spellings, never joins the prompt", () => {
    for (const f of ABLATION_FEATURES) {
      expect(stripLogFlags([`--no-${f}`]), `--no-${f}`).toEqual([]);
      expect(stripLogFlags([`-no-${f}`]), `-no-${f}`).toEqual([]);
      expect(stripLogFlags([`--no_${f.replace(/-/g, "_")}`]), `--no_${f}`).toEqual([]);
    }
  });

  it("behavioral: `--no-gates 修 bug` prompts \"修 bug\"; a lone --no-gates is NO prompt (REPL, not one-shot)", () => {
    expect(promptFromArgv(["--no-gates", "修", "bug"])).toBe("修 bug");
    expect(promptFromArgv(["--no-gates"])).toBe("");
  });

  it("unknown --no-* tokens stay prompt words (args.ts contract: they may belong to other tooling)", () => {
    expect(stripLogFlags(["--no-typo-flag", "hi"])).toEqual(["--no-typo-flag", "hi"]);
    expect(stripLogFlags(["--no_side_car"])).toEqual(["--no_side_car"]);
    expect(stripLogFlags(["--no-gates=1", "hi"])).toEqual(["--no-gates=1", "hi"]); // =-suffix is not the flag form
  });
});
