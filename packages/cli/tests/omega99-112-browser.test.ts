// ω99-112 — the CLI seam (RED first): the tool-list prefix stays
// byte-identical when the browser opt is absent; the six browser tools sit
// at ONE fixed position (after the web face, before the scheduler trio) when
// present; and the permission pre-layer routes submission-class browser
// actions to the human ask unless a rule pre-approves them.
import { describe, it, expect } from "vitest";
import type { Tool } from "@wudao-org/core";
import { createBrowserRuntime } from "@wudao-org/browser";
import { buildToolSet } from "../src/tools.js";
import { DEFAULT_ASK_TOOLS, isDefaultAskCall, decideRichPermission, PLAN_DENY_REASON } from "../src/permission.js";

const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
const BASE = { workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 } as const;

// The byte-stable pre-112 baseline (captured on the unmodified build; the
// browser seam must never disturb a single byte of it).
// ω99-123: make_xlsx joined the always-on tail (fixed position right after
// constitution_suggest — brief-pinned) — baseline re-captured to current
// reality; the browser-absent/present comparison below is unchanged.
// ω99-124: make_pptx joined right after make_xlsx (brief-pinned) — baseline
// re-captured to current reality; the comparison semantics below are unchanged.
// ω99-126: make_docx joined right after make_pptx (brief-pinned) — baseline
// re-captured to current reality; the comparison semantics below are unchanged.
// ω99-212: the computer sextet (screen_capture / computer_type / computer_key /
// computer_click / app_activate / app_list) joined right after make_docx
// (brief-pinned append-only tail) — baseline re-captured to current reality;
// the browser-absent/present comparison below is unchanged.
// ω99-220 演进：computer_scroll / computer_drag 追加在 sextet 尾后（app_list
// 之后、task 之前，append-only 尾）——baseline 再度 re-capture，比较语义不变。
// ω99-221 演进：read_xlsx 插在 computer_drag 之后、task 之前（Excel 读半边，
// append-only 尾——grep 亲验发现的 brief 未名枚举位，沿本件 re-capture 先例）
// ——baseline 再度 re-capture，比较语义不变。
// ω99-222 演进：read_docx / read_pptx 插在 read_xlsx 之后、task 之前（Word/
// PPT 读半边，append-only 尾——三件套读面收口）——baseline 再度 re-capture，
// 比较语义不变。
// ω99-223 演进：append_docx / append_pptx 插在 read_pptx 之后、task 之前
// （Word/PPT 追加面=编辑半边第一刀，append-only 尾）——baseline 再度
// re-capture，比较语义不变。
// ω99-228 演进：append_xlsx 插在 append_pptx 之后、task 之前（Excel 追加
// 面=三件套追加半边收口，append-only 尾）——baseline 再度 re-capture，
// 比较语义不变。
// ω99-229 演进：replace_docx/replace_pptx 插在 append_xlsx 之后、task 之前
// （Word/PPT 就地改写面=「改」半边第一刀，append-only 尾）——baseline 再
// 度 re-capture，比较语义不变。
// ω99-231 演进：replace_xlsx 插在 replace_pptx 之后、task 之前（Excel 就
// 地改写面=三件套「改」半边 xlsx 侧收口，append-only 尾）——baseline 再度
// re-capture，比较语义不变。
// ω99-238: #10 演进：set_docx_header / set_pptx_notes 插在 replace_xlsx 之
// 后、task 之前（文档部件面=页眉页脚+演讲备注，doc 名册尾 append-only 尾）
// ——baseline 再度 re-capture，比较语义不变。
// ω99-247: #12 演进：screen_observe（读面观察员）插在 computer_drag 之后、
// read_xlsx 之前（computer 域尾后 append-only 尾）——baseline 再度
// re-capture，比较语义不变。
// ω99-250: #6 演进：computer_wait（等待员）插在 screen_observe 之后、
// read_xlsx 之前（computer 域尾后 append-only 尾）——baseline 再度
// re-capture，比较语义不变。
// ω99-256: #5 演进：clear_docx_header / set_docx_first_page 插在
// set_pptx_notes 之后、task 之前（doc 部件面 v2=页眉删除+首页不同，doc
// 名册尾 append-only 尾）——baseline 再度 re-capture，比较语义不变。
// ω99-263: #13 演进：set_docx_even_pages 插在 set_docx_first_page 之后、
// task 之前（doc 部件面 v3=奇偶页不同，doc 名册尾 append-only 尾）——
// baseline 再度 re-capture，比较语义不变。
// 114 取证弧演进：python_kernel（持久 Python kernel，纯计算车道）插在
// run_script 之后、web_fetch 之前（run_script 邻近缝，append-only——新
// 槽位=跨版本一次性冷点）——baseline 再度 re-capture，比较语义不变。
const BASELINE_NAMES = [
  "read_file", "glob", "grep", "write_file", "edit", "shell", "todo_write", "sleep",
  "notebook", "message_parent", "message_child", "run_script", "python_kernel", "web_fetch", "constitution_suggest",
  "make_xlsx", "make_pptx", "make_docx",
  "screen_capture", "computer_type", "computer_key", "computer_click", "app_activate", "app_list",
  "computer_scroll", "computer_drag",
  "screen_observe",
  "computer_wait",
  "read_xlsx",
  "read_docx", "read_pptx",
  "append_docx", "append_pptx", "append_xlsx",
  "replace_docx", "replace_pptx", "replace_xlsx",
  "set_docx_header", "set_pptx_notes",
  "clear_docx_header", "set_docx_first_page",
  "set_docx_even_pages",
  "task", "agent_await", "agent_status", "agent_cancel",
  // 持久 bash（prime #3640 引进弧）：三件套挂在 defer 尾之后、MCP 段之前
  // （builtin 段内 append-only——expected-list evolution，位置不变量不动）。
  "shell_start", "shell_read", "shell_stop",
] as const;

const browserRuntime = () =>
  createBrowserRuntime({
    port: { launch: async () => { throw new Error("never launched in registration tests"); } },
    homeDir: "/tmp/wd-browser-112-home",
    env: () => ({}),
    resolveInstalled: async () => "/fake/kernel",
    download: async () => ({ executablePath: "/fake/kernel" }),
    registerExitHook: () => () => {},
  });

const cronTable = { list: () => [], add: async () => {}, remove: async () => false } as const;

describe("tool-list prefix stability (ω99-112)", () => {
  it("browser opt absent → the tool-name sequence is byte-identical to the pre-112 baseline", () => {
    const tools: Tool[] = buildToolSet({ ...BASE });
    expect(tools.map((t) => t.name)).toEqual([...BASELINE_NAMES]);
  });

  it("browser: undefined (explicit absence) is the same bytes", () => {
    const tools: Tool[] = buildToolSet({ ...BASE, browser: undefined });
    expect(tools.map((t) => t.name)).toEqual([...BASELINE_NAMES]);
  });

  it("present → six tools at the fixed position: after web_fetch, before cron_create; the rest unchanged", () => {
    const without: Tool[] = buildToolSet({ ...BASE, cron: { table: cronTable } });
    const withBrowser: Tool[] = buildToolSet({ ...BASE, cron: { table: cronTable }, browser: browserRuntime() });
    const names = withBrowser.map((t) => t.name);
    // ω99-138: browser_see joins right after browser_snapshot (the read-page
    // pair) — expected-list evolution; the position invariants below
    // (after web_fetch, before cron_create) and every other name are unchanged.
    // ω99-139: browser_click_xy joins right after browser_click (the click
    // pair) — same expected-list evolution; position invariants unchanged.
    // ω99-140: browser_type_xy joins right after browser_type (the type
    // pair) — same expected-list evolution; position invariants unchanged.
    // ω99-141: browser_scroll_xy joins right after browser_scroll (the
    // scroll pair) — same expected-list evolution; position invariants
    // unchanged. Read-only like browser_scroll: it never joins
    // DEFAULT_ASK_TOOLS (permission.ts untouched this arc).
    // ω99-142: browser_downloads joins right after browser_scroll_xy, before
    // browser_close (the page-download manifest) — same expected-list
    // evolution; position invariants unchanged. Read-only closed-world (a
    // local manifest read): auto-allowed, it never joins DEFAULT_ASK_TOOLS
    // (permission.ts untouched this arc either).
    const eleven = ["browser_open", "browser_snapshot", "browser_see", "browser_click", "browser_click_xy", "browser_type", "browser_type_xy", "browser_scroll", "browser_scroll_xy", "browser_downloads", "browser_close"];
    expect(names).toEqual([...without.map((t) => t.name).slice(0, without.findIndex((t) => t.name === "cron_create")), ...eleven, ...without.map((t) => t.name).slice(without.findIndex((t) => t.name === "cron_create"))]);
    expect(names.indexOf("browser_open")).toBe(names.indexOf("web_fetch") + 1);
    expect(names.indexOf("cron_create")).toBe(names.indexOf("browser_close") + 1);
  });
});

describe("DEFAULT_ASK_TOOLS (the submission-class browser actions)", () => {
  it("is exactly browser_click + browser_click_xy + browser_type_xy at the tool level", () => {
    // ω99-139: browser_click_xy joins whole-tool-class (the fallback layer's
    // always-ask ruling) — expected-set evolution, nothing removed.
    // ω99-140: browser_type_xy joins whole-tool-class (typing injects content;
    // the miss layer cannot classify the target) — same set evolution.
    // ω99-212: the computer ACTION quartet joins whole-tool-class (physical
    // keystroke/click/app-switch on the user's machine) — same set evolution.
    // ω99-220 演进：computer_scroll / computer_drag 入列（滚轮动的是用户机器
    // 上的活动窗口、拖拽物理挪物——同 whole-tool-class 问姿）——同款集演进，
    // 零删除。
    expect(DEFAULT_ASK_TOOLS).toEqual(new Set([
      "browser_click", "browser_click_xy", "browser_type_xy",
      "computer_type", "computer_key", "computer_click", "app_activate",
      "computer_scroll", "computer_drag",
    ]));
  });

  it("the parameter probe: browser_type with submit:true joins, submit:false/absent does not", () => {
    expect(isDefaultAskCall("browser_click", {})).toBe(true);
    expect(isDefaultAskCall("browser_type", { submit: true })).toBe(true);
    expect(isDefaultAskCall("browser_type", { submit: false })).toBe(false);
    expect(isDefaultAskCall("browser_type", {})).toBe(false);
    expect(isDefaultAskCall("browser_type", { submit: "true" })).toBe(false);
    expect(isDefaultAskCall("browser_open", {})).toBe(false);
    expect(isDefaultAskCall("browser_snapshot", {})).toBe(false);
    expect(isDefaultAskCall("browser_scroll", { direction: "down" })).toBe(false);
    expect(isDefaultAskCall("browser_close", {})).toBe(false);
    expect(isDefaultAskCall("web_fetch", { url: "https://x" })).toBe(false);
  });
});

describe("decideRichPermission pre-layer (ω99-112)", () => {
  it("no rule hit + default-ask action → ask (the 109 pet confirmation card)", () => {
    // ω99-226 产品裁定（非回归）：auto 档八件套跟随档位放行（sidecar 照审；
    // 四档新矩阵钉在 omega99-226-auto-trust.test.ts）——auto 行自 ask 演进。
    expect(decideRichPermission({ mode: "auto", toolName: "browser_click", input: { ref: "e1" } })).toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "workspace", toolName: "browser_click", input: { ref: "e1" } })).toBe("ask");
  });

  it("an always/session rule pre-approves (rules run FIRST — no repeat nagging)", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "browser_click", input: { ref: "e1" }, session: ["browser_click"] })).toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "auto", toolName: "browser_click", input: { ref: "e1" }, settings: { allow: ["browser_click"], deny: [], ask: [], sidecarExempt: [] } })).toEqual({ behavior: "allow" });
  });

  it("a settings deny rule outranks the default-ask layer", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "browser_click", input: { ref: "e1" }, settings: { deny: ["browser_click"], allow: [], ask: [], sidecarExempt: [] } })).toEqual({ behavior: "deny", reason: 'settings deny rule "browser_click"' });
  });

  it("browser_type: submit:true follows the tiers (auto allows — ω99-226 裁定); submit:false keeps the builtin path", () => {
    // ω99-226 产品裁定：submit 探针面同八件套矩阵（auto 放行、非 auto 档问）。
    expect(decideRichPermission({ mode: "auto", toolName: "browser_type", input: { ref: "e2", text: "q", submit: true } })).toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "auto", toolName: "browser_type", input: { ref: "e2", text: "q", submit: false } })).toEqual({ behavior: "allow" });
    // workspace: an unknown-to-the-tier tool keeps its pre-112 ask (unchanged)
    expect(decideRichPermission({ mode: "workspace", toolName: "browser_type", input: { ref: "e2", text: "q", submit: false } })).toBe("ask");
  });

  it("plan mode still denies outright (the read-only fence is untouched)", () => {
    expect(decideRichPermission({ mode: "plan", toolName: "browser_click", input: { ref: "e1" } })).toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
  });
});
