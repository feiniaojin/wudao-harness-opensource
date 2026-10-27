// P2-13 (96 队列) — the USER CONSTITUTION surface: the three-file store
// (~/.wudao/constitution.md + constitution-pending/ + constitution.json),
// the model-side suggest tool (pending inbox ONLY — the active file is
// unreachable by construction), the memoized system-prompt section
// (byte-stable per session, restart to change), the /constitution command
// face, the project-tier settings gate, and the append-only tool-list
// registration. a reference harness user_constitution lineage: model SUGGESTS, the
// human APPROVES, sha256 digest detects drift.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput, PermissionDecision, Tool } from "@wudao/core";
import { toModelToolDefinition } from "@wudao/core";
import {
  CONSTITUTION_CLAUSE_MAX_CHARS,
  CONSTITUTION_PENDING_CAP,
  appendPendingSuggestion,
  approvePendingClause,
  constitutionPaths,
  constitutionStatus,
  listPending,
  rejectPendingClause,
  sha256Hex,
} from "../src/constitution/store.js";
import { createConstitutionSuggestTool } from "../src/constitution/tools.js";
import {
  CONSTITUTION_HEADING,
  getConstitutionSection,
  loadConstitutionSection,
  resetConstitutionCacheForTests,
} from "../src/constitution/prompt.js";
import { runConstitutionCommand } from "../src/commands/constitution.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { parseReplCommand } from "../src/repl.js";
import { sanitizeProjectTier } from "../src/settings-layer.js";
import { buildToolSet } from "../src/tools.js";

let home: string;
const env = (): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home });
const paths = (): { active: string; pendingDir: string; manifest: string } => constitutionPaths(env());

let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wudao-constitution-"));
  savedHome = process.env.WUDAO_GLOBAL_HOME;
});

afterEach(async () => {
  resetConstitutionCacheForTests();
  if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedHome;
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// 1. Store — the three-piece user-global layer
// ---------------------------------------------------------------------------

describe("constitution store — pending inbox", () => {
  it("paths live in the user-global tier (WUDAO_GLOBAL_HOME-sandboxed)", () => {
    const p = paths();
    expect(p.active).toBe(join(home, "constitution.md"));
    expect(p.pendingDir).toBe(join(home, "constitution-pending"));
    expect(p.manifest).toBe(join(home, "constitution.json"));
  });

  it("appends sequence-named .md files and returns a receipt", () => {
    const r1 = appendPendingSuggestion("Always answer in Chinese.", env());
    expect(r1.file).toBe("0001.md");
    expect(r1.pendingCount).toBe(1);
    const r2 = appendPendingSuggestion("Cite file:line for every claim.", env());
    expect(r2.file).toBe("0002.md");
    expect(r2.pendingCount).toBe(2);
    const items = listPending(env());
    expect(items.map((i) => i.n)).toEqual([1, 2]);
    expect(items[0]?.content).toContain("Always answer in Chinese.");
  });

  it("numbering continues after a gap (max+1, never reusing a slot)", async () => {
    appendPendingSuggestion("one", env());
    appendPendingSuggestion("two", env());
    appendPendingSuggestion("three", env());
    await rm(join(paths().pendingDir, "0002.md"), { force: true });
    const r = appendPendingSuggestion("four", env());
    expect(r.file).toBe("0004.md");
    expect(listPending(env()).map((i) => i.n)).toEqual([1, 3, 4]);
  });

  it("fail-closed validation: empty and whitespace-only clauses refuse", () => {
    expect(() => appendPendingSuggestion("", env())).toThrow(/clause/);
    expect(() => appendPendingSuggestion("   \n\t ", env())).toThrow(/clause/);
    expect(listPending(env())).toEqual([]);
  });

  it(`fail-closed validation: clauses over ${CONSTITUTION_CLAUSE_MAX_CHARS} chars refuse`, () => {
    expect(() => appendPendingSuggestion("x".repeat(CONSTITUTION_CLAUSE_MAX_CHARS + 1), env())).toThrow(/2000/);
    // exactly at the cap is fine
    expect(appendPendingSuggestion("y".repeat(CONSTITUTION_CLAUSE_MAX_CHARS), env()).file).toBe("0001.md");
  });

  it(`pending inbox caps at ${CONSTITUTION_PENDING_CAP} — full refuses, nothing overflows`, () => {
    for (let i = 1; i <= CONSTITUTION_PENDING_CAP; i++) appendPendingSuggestion(`clause ${i}`, env());
    expect(listPending(env())).toHaveLength(CONSTITUTION_PENDING_CAP);
    expect(() => appendPendingSuggestion("one too many", env())).toThrow(/full/);
    expect(listPending(env())).toHaveLength(CONSTITUTION_PENDING_CAP);
  });
});

describe("constitution store — approve / reject / digest", () => {
  it("approve appends into the ACTIVE file atomically and records the manifest digest", async () => {
    appendPendingSuggestion("Clause A", env());
    const ap = approvePendingClause(1, env());
    expect(ap.content.trim()).toBe("Clause A");
    const onDisk = await readFile(paths().active, "utf8");
    expect(onDisk).toBe(ap.content);
    expect(ap.digest).toBe(sha256Hex(onDisk));

    appendPendingSuggestion("Clause B", env());
    const ap2 = approvePendingClause(2, env());
    // Canonical form: clauses separated by ONE blank line, file ends with \n.
    expect(ap2.content).toBe("Clause A\n\nClause B\n");
    expect(ap2.digest).toBe(sha256Hex(ap2.content));

    const status = constitutionStatus(env());
    expect(status.active?.stale).toBe(false);
    expect(status.active?.clauseCount).toBe(2);
    expect(status.active?.digest).toBe(ap2.digest);
  });

  it("approve consumes the pending item (no double-approve)", () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    expect(listPending(env())).toEqual([]);
    expect(() => approvePendingClause(1, env())).toThrow(/no pending/);
  });

  it("reject deletes exactly pending n", () => {
    appendPendingSuggestion("one", env());
    appendPendingSuggestion("two", env());
    const r = rejectPendingClause(1, env());
    expect(r.pendingCount).toBe(1);
    expect(listPending(env()).map((i) => i.content)).toEqual(["two"]);
    expect(() => rejectPendingClause(9, env())).toThrow(/no pending/);
  });

  it("digest mismatch: hand-editing the active file reads STALE on next load (fail-closed)", async () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    // Hand-edit WITHOUT touching the manifest — the drift detector's case.
    await writeFile(paths().active, "Clause A\nhand-edited", "utf8");
    const status = constitutionStatus(env());
    expect(status.active?.stale).toBe(true);
    expect(status.active?.digest).not.toBe(status.active?.manifestDigest);
  });

  it("an active file with NO manifest (never approved) reads stale — never silently adopted", async () => {
    await mkdir(join(home, "constitution-pending"), { recursive: true });
    await writeFile(paths().active, "unapproved content", "utf8");
    const status = constitutionStatus(env());
    expect(status.active?.stale).toBe(true);
  });

  it("a corrupt manifest reads as absent (fail-closed, no throw)", async () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    await writeFile(paths().manifest, "{not json", "utf8");
    const status = constitutionStatus(env());
    expect(status.active?.stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Tool — constitution_suggest (the model can ONLY queue a suggestion)
// ---------------------------------------------------------------------------

describe("constitution_suggest tool", () => {
  it("writes ONLY the pending inbox — the active file's bytes never move", async () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    const before = await readFile(paths().active, "utf8");
    const tool = createConstitutionSuggestTool(env());
    const r = await tool.execute({ clause: "Prefer minimal diffs." });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("0002.md");
    expect(r.content).toContain("2");
    expect(await readFile(paths().active, "utf8")).toBe(before);
    expect(listPending(env())).toHaveLength(1);
  });

  it("no path parameter exists — the schema is clause-only", () => {
    const tool = createConstitutionSuggestTool(env());
    expect(Object.keys(tool.parameters.properties)).toEqual(["clause"]);
    expect(tool.parameters.required).toEqual(["clause"]);
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it("fail-closed receipts: empty / oversize clauses error without writing", async () => {
    const tool = createConstitutionSuggestTool(env());
    const empty = await tool.execute({ clause: "   " });
    expect(empty.isError).toBe(true);
    const big = await tool.execute({ clause: "x".repeat(CONSTITUTION_CLAUSE_MAX_CHARS + 1) });
    expect(big.isError).toBe(true);
    expect(listPending(env())).toEqual([]);
  });

  it("full inbox: error receipt, no overflow", async () => {
    await mkdir(join(home, "constitution-pending"), { recursive: true });
    for (let i = 1; i <= CONSTITUTION_PENDING_CAP; i++) appendPendingSuggestion(`c${i}`, env());
    const tool = createConstitutionSuggestTool(env());
    const r = await tool.execute({ clause: "overflow" });
    expect(r.isError).toBe(true);
    expect((await readdir(paths().pendingDir)).length).toBe(CONSTITUTION_PENDING_CAP);
  });
});

// ---------------------------------------------------------------------------
// 3. Prompt section — memoized, byte-stable, digest-headed
// ---------------------------------------------------------------------------

describe("constitution prompt section", () => {
  it("no constitution → NO section (prompt stays byte-identical to the baseline)", () => {
    resetConstitutionCacheForTests();
    const p = buildSystemPrompt("/tmp/ws");
    expect(p).not.toContain(CONSTITUTION_HEADING);
    expect(getConstitutionSection()).toBe("");
  });

  it("active + fresh → section renders after Environment, adjacent to (before) the MCP tail", () => {
    appendPendingSuggestion("Always cite file:line.", env());
    approvePendingClause(1, env());
    resetConstitutionCacheForTests();
    process.env.WUDAO_GLOBAL_HOME = home;
    const p = buildSystemPrompt("/tmp/ws");
    expect(p).toContain(CONSTITUTION_HEADING);
    expect(p).toContain("Always cite file:line.");
    // Header carries the sha256 digest of the active content.
    expect(p).toContain(sha256Hex("Always cite file:line.\n"));
    // Position: after Environment (stable-tail zone), BEFORE the MCP section.
    expect(p.indexOf(CONSTITUTION_HEADING)).toBeGreaterThan(p.indexOf("# Environment"));
    const withMcp = buildSystemPrompt("/tmp/ws", true);
    expect(withMcp.indexOf(CONSTITUTION_HEADING)).toBeGreaterThan(0);
    expect(withMcp.indexOf(CONSTITUTION_HEADING)).toBeLessThan(withMcp.indexOf("# MCP tools"));
  });

  it("byte-stable within a session: later disk changes do NOT shift loaded bytes (restart semantics)", async () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    resetConstitutionCacheForTests();
    process.env.WUDAO_GLOBAL_HOME = home;
    const loaded = buildSystemPrompt("/tmp/ws");
    await writeFile(paths().active, "Clause A\n\nClause B hand-appended", "utf8");
    expect(buildSystemPrompt("/tmp/ws")).toBe(loaded); // memoized — bytes frozen
    resetConstitutionCacheForTests(); // "restart"
    const after = buildSystemPrompt("/tmp/ws");
    expect(after).not.toBe(loaded);
  });

  it("stale (hand-edited) constitution is NOT adopted: section dropped + notice", async () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    await writeFile(paths().active, "hand-edited", "utf8");
    const fresh = loadConstitutionSection(env());
    expect(fresh.section).toBe("");
    expect(fresh.notices.join("\n")).toMatch(/digest/i);
    expect(fresh.notices.join("\n")).toMatch(/constitution/i);
    resetConstitutionCacheForTests();
    process.env.WUDAO_GLOBAL_HOME = home;
    expect(buildSystemPrompt("/tmp/ws")).not.toContain(CONSTITUTION_HEADING);
  });

  it("repeated loads of the same active constitution are byte-identical", () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    const a = loadConstitutionSection(env());
    const b = loadConstitutionSection(env());
    expect(a.section).toBe(b.section);
    expect(a.digest).toBe(b.digest);
  });
});

// ---------------------------------------------------------------------------
// 4. Command face — /constitution (bare / show / approve n / reject n)
// ---------------------------------------------------------------------------

describe("/constitution parse (exact-match grammar, /trust discipline)", () => {
  it("the four accepted forms", () => {
    expect(parseReplCommand("/constitution")).toEqual({ kind: "constitution", args: "" });
    expect(parseReplCommand("/constitution show")).toEqual({ kind: "constitution", args: "show" });
    expect(parseReplCommand("/constitution approve 3")).toEqual({ kind: "constitution", args: "approve 3" });
    expect(parseReplCommand("/constitution reject 2")).toEqual({ kind: "constitution", args: "reject 2" });
  });

  it("junk suffixes (and the prefix-neighbor /constitutionx) stay plain prompts", () => {
    expect(parseReplCommand("/constitution foo").kind).toBe("prompt");
    expect(parseReplCommand("/constitution approve").kind).toBe("prompt");
    expect(parseReplCommand("/constitution approve abc").kind).toBe("prompt");
    expect(parseReplCommand("/constitutionx").kind).toBe("prompt");
  });
});

describe("runConstitutionCommand", () => {
  it("bare status on an empty store: no clauses, no pending, usage", async () => {
    const text = await runConstitutionCommand({ args: "", env: env() });
    expect(text).toMatch(/暂无生效条款/); // ω99-179: 钉随源演进
    expect(text).toMatch(/待审建议/); // ω99-179: 钉随源演进
    expect(text).toContain("/constitution");
  });

  it("status lists pending items with a truncated first line", async () => {
    appendPendingSuggestion(`L${"o".repeat(300)}ng first line`, env());
    appendPendingSuggestion("short one", env());
    const text = await runConstitutionCommand({ args: "", env: env() });
    expect(text).toContain("1.");
    expect(text).toContain("2.");
    expect(text).toContain("short one");
    // The 300-char first line is truncated in the rendering.
    expect(text).not.toContain("o".repeat(300));
    expect(text).toContain("…");
  });

  it("approve n: active file, manifest digest, and status agree afterwards", async () => {
    appendPendingSuggestion("Clause A", env());
    const text = await runConstitutionCommand({ args: "approve 1", env: env() });
    expect(text).toMatch(/已批准/); // ω99-179: 钉随源演进
    const status = constitutionStatus(env());
    expect(status.active?.stale).toBe(false);
    expect(status.active?.digest).toBe(sha256Hex(await readFile(paths().active, "utf8")));
    expect(listPending(env())).toEqual([]);
  });

  it("reject n: the pending count drops", async () => {
    appendPendingSuggestion("one", env());
    appendPendingSuggestion("two", env());
    const text = await runConstitutionCommand({ args: "reject 1", env: env() });
    expect(text).toMatch(/已丢弃/); // ω99-179: 钉随源演进
    expect(listPending(env()).map((i) => i.content)).toEqual(["two"]);
  });

  it("show renders the active content; stale state is surfaced", async () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    const shown = await runConstitutionCommand({ args: "show", env: env() });
    expect(shown).toContain("Clause A");
    await writeFile(paths().active, "hand-edited", "utf8");
    const stale = await runConstitutionCommand({ args: "", env: env() });
    expect(stale).toMatch(/digest/i);
    expect(stale).toMatch(/已过期/); // ω99-179: 钉随源演进
  });

  it("junk args answer with usage (never a throw)", async () => {
    const text = await runConstitutionCommand({ args: "wat", env: env() });
    expect(text).toContain("用法："); // ω99-166d-i: 泛 usage 钉演进（#25）
  });

  it("approve with no such n: clear error, nothing written", async () => {
    const text = await runConstitutionCommand({ args: "approve 7", env: env() });
    expect(text).toMatch(/no pending/i);
    expect(await readFile(paths().active, "utf8").catch(() => "absent")).toBe("absent");
  });
});

// ---------------------------------------------------------------------------
// 5. Settings gate — the project tier may never configure constitution
// ---------------------------------------------------------------------------

describe("project-tier settings gate", () => {
  it("a project-layer constitution key is ignored with a warning (trust-gate discipline)", () => {
    const res = sanitizeProjectTier({ constitution: { clauses: ["injected"] } });
    expect(res.dropped).toContain("constitution");
    expect(res.warnings.join("\n")).toMatch(/constitution/);
    expect(res.record).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 6. Tool-list registration — append-only, fixed position
// ---------------------------------------------------------------------------

const stubModel: ModelClient = {
  async generate(_input: ModelInput): Promise<AssistantMessage> {
    return { role: "assistant", content: "" };
  },
};
const allowAll = async (): Promise<PermissionDecision> => ({ behavior: "allow" });
const build = (): Tool[] =>
  buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: allowAll, contextWindowTokens: 64_000 });

describe("buildToolSet constitution_suggest registration", () => {
  it("registered zero-config at a FIXED tail position (after web_fetch, before the defer candidates)", () => {
    const names = build().map((t) => t.name);
    expect(names).toContain("constitution_suggest");
    expect(names.indexOf("constitution_suggest")).toBeGreaterThan(names.indexOf("web_fetch"));
    expect(names.indexOf("constitution_suggest")).toBeLessThan(names.indexOf("task"));
  });

  it("append-only: the pre-existing always-present builtin order is untouched", () => {
    const names = build().map((t) => t.name);
    const without = names.filter((n) => n !== "constitution_suggest");
    // The exact pre-P2-13 order (pinned): every prior tool keeps its index.
    // ω99-57/60: message_parent and message_child append INSIDE the pin at
    // the coding-group tail (fixed tail positions) — the order pin was
    // stale-red on main after ω99-57 and is re-pinned to current reality:
    // still append-only, every earlier tool keeps its index.
    expect(without.slice(0, 14)).toEqual([
      "read_file", "glob", "grep", "write_file", "edit", "shell",
      "todo_write", "sleep", "notebook", "message_parent", "message_child",
      "run_script", "python_kernel", "web_fetch",
    ]);
    // ω99-123: make_xlsx inserts INSIDE this pin (brief-pinned fixed position
    // right after constitution_suggest), pushing the defer-candidate tail one
    // slot — re-pinned to current reality, same as the ω99-57 precedent above:
    // still append-only, every earlier tool keeps its index.
    // ω99-124: make_pptx inserts INSIDE the re-pinned tail (brief-pinned fixed
    // position right after make_xlsx), same one-slot push — re-pinned again on
    // the same precedent: still append-only, every earlier tool keeps its index.
    // ω99-126: make_docx inserts INSIDE the re-pinned tail (brief-pinned fixed
    // position right after make_pptx), same one-slot push — re-pinned on the
    // same precedent: still append-only, every earlier tool keeps its index.
    // ω99-212: the computer sextet (screen_capture … app_list) inserts INSIDE
    // the re-pinned tail (brief-pinned fixed position right after make_docx,
    // before the defer candidates) — same six-slot push, re-pinned on the same
    // precedent: still append-only, every earlier tool keeps its index.
    // ω99-220 演进：scroll/drag 追加在 sextet 尾后（app_list 之后、task 之
    // 前）——两 slot 顺移，同 ω99-123/124/126/212 re-pin 先例；append-only，
    // 既有工具索引零变。
    // ω99-221: #5 — 演进：read_xlsx 插在 computer_drag 之后、task 之前（读
    // 半边挂在电脑八件后、defer 尾前——append-only 尾）——defer 尾四员顺移
    // 一位，同 ω99-123/124/126/212/220 re-pin 先例；append-only，既有工具索
    // 引零变。
    // ω99-222: #8 — 演进：read_docx / read_pptx 插在 read_xlsx 之后、task
    // 之前（Word/PPT 读半边，append-only 尾——Excel 读面后、defer 尾前）
    // ——defer 尾四员再顺移两位，同 ω99-123/124/126/212/220/221 re-pin 先
    // 例；append-only，既有工具索引零变（三件套读半边自此收口）。
    // ω99-223: #8 — 演进：append_docx / append_pptx 插在 read_pptx 之后、
    // task 之前（Word/PPT 追加面=编辑半边第一刀，append-only 尾——三件套
    // 读面后、defer 尾前）——defer 尾四员再顺移两位，同 ω99-123/124/126/
    // 212/220/221/222 re-pin 先例；append-only，既有工具索引零变。
    // ω99-228: #6 — 演进：append_xlsx 插在 append_pptx 之后、task 之前
    // （Excel 追加面=三件套追加半边收口，append-only 尾）——defer 尾四员
    // 再顺移一位，同 ω99-123/124/126/212/220/221/222/223 re-pin 先例；
    // append-only，既有工具索引零变。
    // ω99-229: #6 — 演进：replace_docx / replace_pptx 插在 append_xlsx 之后、
    // task 之前（Word/PPT 就地改写面=「改」半边第一刀，append-only 尾——
    // 三件追加面后、defer 尾前）——defer 尾四员再顺移两位，同 ω99-123/124/
    // 126/212/220/221/222/223/228 re-pin 先例；append-only，既有工具索引
    // 零变。
    // ω99-231: #6 — 演进：replace_xlsx 插在 replace_pptx 之后、task 之前
    // （Excel 就地改写面=三件套「改」半边 xlsx 侧收口，读/造/追加/改四环
    // 齐，append-only 尾）——defer 尾四员再顺移一位，同 ω99-123/124/126/
    // 212/220/221/222/223/228/229 re-pin 先例；append-only，既有工具索引
    // 零变。
    // ω99-238: #7 — 演进：set_docx_header / set_pptx_notes 插在 replace_xlsx
    // 之后、task 之前（文档部件面=页眉页脚+演讲备注，doc 名册尾 append-only
    // ——两新面进 DOC_SUITE_EDIT/RECEIPT_TOOLS 尾、双段展开自动随尾段）——
    // defer 尾四员再顺移两位，同 ω99-123/124/126/212/220/221/222/223/228/
    // 229/231 re-pin 先例；append-only，既有工具索引零变（read_pptx 描述的
    // 备注行升级同弧同版落地——一次跨版本冷转，非两次）。
    // ω99-247: #11 — 演进：screen_observe（读面观察员）插在 computer_drag
    // 之后、read_xlsx 之前（computer 域尾后 append-only）——doc 名册与 defer
    // 尾整体顺移一位，同 ω99-123/124/126/212/220/221/…/238 re-pin 先例；
    // append-only，既有工具索引零变。
    // ω99-250: #5 — 演进：computer_wait（等待员，读面）插在 screen_observe
    // 之后、read_xlsx 之前（computer 域尾后 append-only）——doc 名册与 defer
    // 尾整体再顺移一位，同 ω99-123/…/247 re-pin 先例；append-only，既有工具
    // 索引零变。
    // ω99-256: #4 — 演进：clear_docx_header / set_docx_first_page 插在
    // set_pptx_notes 之后、task 之前（doc 部件面 v2=页眉删除+首页不同，doc
    // 名册尾 append-only 尾——两新面进 DOC_SUITE_EDIT/RECEIPT_TOOLS 尾、双段
    // 展开自动随尾段）——defer 尾四员再顺移两位，同 ω99-123/…/250 re-pin
    // 先例；append-only，既有工具索引零变。
    // ω99-263: #7 — 演进：set_docx_even_pages 插在 set_docx_first_page 之
    // 后、task 之前（doc 部件面 v3=奇偶页不同，doc 名册尾 append-only 尾
    // ——新面进 DOC_SUITE_EDIT/RECEIPT_TOOLS 尾、双段展开自动随尾段）——
    // defer 尾四员再顺移一位，同 ω99-123/…/256 re-pin 先例；append-only，
    // 既有工具索引零变（clear_docx_header 的 refType 值域 +even 是参数面
    // 变更，不进名单）。
    // 114 取证弧：演进：python_kernel（持久 Python kernel，纯计算车道）插
    // 在 run_script 之后、web_fetch 之前（run_script 邻近缝，append-only
    // ——新槽位=跨版本一次性冷点，M24 声明见 core/tools/python-kernel.ts）
    // ——本段与 defer 尾整体顺移一位，同 ω99-123/…/263 re-pin 先例；
    // append-only，既有工具索引零变。
    expect(without.slice(14, 45)).toEqual([
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
    ]);
  });

  it("two builds serialize byte-identically (deterministic, prefix-stable)", () => {
    const a = JSON.stringify(build().map(toModelToolDefinition));
    const b = JSON.stringify(build().map(toModelToolDefinition));
    expect(a).toBe(b);
  });
});
