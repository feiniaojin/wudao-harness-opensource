// ω99-236: #R1 — 三件套名册化默认态等值钉：doc-suite.ts 是十二面的单一
// 描述清单（构造序 + 读册三名 + 写册九名 + 回执面名册 + 摘要器映射）。
// ω99-238: #9 — 名册增员演进：两枚文档部件面（set_docx_header /
// set_pptx_notes）进名册尾——写册九→十一、回执册九→十一、摘要器键集
// 十二→十四、构造序尾两位（replace_xlsx 之后、task 之前）。先红取证
// （/tmp/o238-red-census.log）再同形演进；零演进预期件 221/222 全绿亲证。
// ω99-256: #11 — 名册再增员演进：两枚 doc 部件面 v2（clear_docx_header/
// set_docx_first_page）进名册尾——写册十一→十三、回执册同、摘要器键集
// 十四→十六、构造序尾两位（set_pptx_notes 之后、task 之前）。先红取证
// （/tmp/o256-census-red.log）再同形演进。
// ω99-263: #6 — 名册再增员演进：一枚 doc 部件面 v3（set_docx_even_pages
// 奇偶页不同）进名册尾——写册十三→十四、回执册同、摘要器键集十六→十七、
// 构造序尾一位（set_docx_first_page 之后、task 之前）。先红取证
// （/tmp/o263-census-red.log）再同形演进。
// 四缝（tools.ts / permission.ts / file-receipt.ts / log.ts）从「逐名硬
// 编码」变「消费名册」。默认态字节零变是本弧的验收锚——本组断言把名册
// 数值、挂载序、双 Set 展开后内容、摘要映射命中、回执名门全部钉成与
// 重构前逐字等值（与 constitution.test.ts 的 slice(0,13)/slice(13,37) 及
// ω99-221..231 六弧邻接钉互证）。
// ω99-236: #R2 — 使能门钉：resolveDocSuiteEnabled（缺省 true——opt-out，
// 与 lsp 的 opt-in 相反：已随产品在跑的能力）；off → createDocSuiteTools
// 返 []（挂载门只在构造首，名册静态消费照旧）；settingsSet("docSuite.
// enabled") 白名单收行（真写 tmp settings 文件后读回——tmpdir 只写不删，
// 09-09 红线：不删任何用户文件/文件夹）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@wudao/core";
import { buildToolSet } from "../src/tools.js";
import {
  createDocSuiteTools,
  setDocSuiteRuntimeEnabled,
  DOC_SUITE_READ_TOOLS,
  DOC_SUITE_EDIT_TOOLS,
  DOC_SUITE_RECEIPT_TOOLS,
  DOC_SUITE_MAKE_COUNT,
  docSuiteSummarizers,
} from "../src/doc-suite.js";
import { READ_TOOLS, FILE_EDIT_TOOLS } from "../src/permission.js";
import { extractFileReceipt } from "../src/driver/file-receipt.js";
import { summarizeToolCall } from "../src/log.js";
import { resolveDocSuiteEnabled } from "../src/misc-config.js";
import { createSettingsOps } from "../src/driver/settings-ops.js";
import { globalSettingsPath } from "../src/settings-layer.js";

// ★红线（09-09 用户令，逐字）：「注意，开发、测试过程禁止删除用户文件/
// 文件夹。」本件夹具全内存 / mkdtemp(os.tmpdir()) 只写不删。

const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
const build = (): Tool[] =>
  buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 });

/** 挂载序（宪法切片内 doc 诸名的相对序）——名册必须逐字复现：make×3 →
 * （computer 八件在外，不属名册）→ read×3 → append×3 → replace×3 →
 * set×2（ω99-238 文档部件面）→ clear/first×2（ω99-256 部件面 v2）→
 * even×1（ω99-263 部件面 v3，尾位）。 */
const MOUNT_ORDER = [
  "make_xlsx", "make_pptx", "make_docx",
  "read_xlsx", "read_docx", "read_pptx",
  "append_docx", "append_pptx", "append_xlsx",
  "replace_docx", "replace_pptx", "replace_xlsx",
  "set_docx_header", "set_pptx_notes",
  "clear_docx_header", "set_docx_first_page",
  "set_docx_even_pages",
] as const;

// 挂载门默认 true（opt-out）：-suite 其他件不感知本件的 off 翻转——本件
// 结束一律复位（lsp-gate.test.ts 的 afterEach 纪律同款）。
afterEach(() => {
  setDocSuiteRuntimeEnabled(true);
});

// ---------------------------------------------------------------------------
// R1 — 名册等值（默认态字节零变）
// ---------------------------------------------------------------------------

describe("ω99-236 R1(a) — 名册数值逐字", () => {
  it("读册三名（READ_ROSTER = 重构前 READ_TOOLS 内 doc 三名，序=挂载序）", () => {
    expect([...DOC_SUITE_READ_TOOLS]).toEqual(["read_xlsx", "read_docx", "read_pptx"]);
  });

  it("写册十四名（EDIT_ROSTER = ω99-238 十一名 + ω99-256 两枚 + ω99-263 一枚，序=挂载序）", () => {
    expect([...DOC_SUITE_EDIT_TOOLS]).toEqual([
      "make_xlsx", "make_pptx", "make_docx",
      "append_docx", "append_pptx", "append_xlsx",
      "replace_docx", "replace_pptx", "replace_xlsx",
      "set_docx_header", "set_pptx_notes",
      "clear_docx_header", "set_docx_first_page",
      "set_docx_even_pages",
    ]);
  });

  it("回执面名册 = 名门九名 + ω99-238 两枚 + ω99-256 两枚 + ω99-263 一枚（make×3+append×3+replace×3+set×2+chrome-v2×2+even×1，无读面）", () => {
    expect([...DOC_SUITE_RECEIPT_TOOLS]).toEqual([
      "make_xlsx", "make_pptx", "make_docx",
      "append_docx", "append_pptx", "append_xlsx",
      "replace_docx", "replace_pptx", "replace_xlsx",
      "set_docx_header", "set_pptx_notes",
      "clear_docx_header", "set_docx_first_page",
      "set_docx_even_pages",
    ]);
  });

  it("摘要器键集 = 工具名集（十七名全键——make 三面显式空摘要件，不落 base switch）", () => {
    expect(Object.keys(docSuiteSummarizers).sort()).toEqual([...MOUNT_ORDER].sort());
    expect(DOC_SUITE_MAKE_COUNT).toBe(3);
  });
});

describe("ω99-236 R1(b) — createDocSuiteTools 序 = 现挂载序", () => {
  it("名册构造序与 buildToolSet 内 doc 诸名相对序逐字互证（与宪法切片互证）", () => {
    const roster = createDocSuiteTools("/tmp/ws").map((t) => t.name);
    expect(roster).toEqual([...MOUNT_ORDER]);
    const mounted = build()
      .map((t) => t.name)
      .filter((n): n is (typeof MOUNT_ORDER)[number] => (MOUNT_ORDER as readonly string[]).includes(n));
    expect(mounted).toEqual([...MOUNT_ORDER]);
  });

  it("默认态（未写 settings）：十六面全数在列——构造面直证", () => {
    const names = build().map((t) => t.name);
    for (const n of MOUNT_ORDER) expect(names).toContain(n);
    // 名册尾位两侧邻接：make_docx 之后是 computer 八件之首 screen_capture；
    // ω99-238 演进——set_docx_header/set_pptx_notes 插在 replace_xlsx 之后、
    // task 之前（文档部件面，append-only 尾）：replace_xlsx 的下一位改钉
    // set_docx_header，set_pptx_notes 的下一位才是 task（221/231 邻接钉同款
    // 互证）；ω99-256 演进——clear_docx_header/set_docx_first_page 插在
    // set_pptx_notes 之后、task 之前（doc 部件面 v2，append-only 尾）：
    // set_pptx_notes 的下一位改钉 clear_docx_header，set_docx_first_page
    // 的下一位才是 task。
    expect(names[names.indexOf("make_docx") + 1]).toBe("screen_capture");
    expect(names[names.indexOf("replace_xlsx") + 1]).toBe("set_docx_header");
    expect(names[names.indexOf("set_pptx_notes") + 1]).toBe("clear_docx_header");
    expect(names[names.indexOf("set_docx_first_page") + 1]).toBe("set_docx_even_pages");
    expect(names[names.indexOf("set_docx_even_pages") + 1]).toBe("task");
  });
});

describe("ω99-236 R1(c) — permission 双 Set 展开后内容等值", () => {
  it("READ_TOOLS = 基础名 ∪ 读册三名（重构前名单逐字）", () => {
    expect([...READ_TOOLS].sort()).toEqual(
      [
        "read_file", "glob", "grep", "todo_write", "ask_user", "load_tools",
        "monitor_list", "monitor_read", "discover_skills", "lsp",
        // ω99-313: schedule_list 加入只读名册（定时任务读面）。0.3.91 gate
        // 首逮钉债——0.3.89/0.3.90 聚焦发版未跑 gate，在此补齐。
        "schedule_list",
        // census 撞车吸收（125 项 2）：search_history/note_read（121 挖掘
        // TOP5 #1 与 121 §1 续章入册但本钉滞后——后到者吸收纪律）+
        // context_remaining（125 项 2 水位线查询面——ctx_inspect 同缝的
        // 纯内存读，读自己的水位线不是要审批的动作）。
        "search_history", "note_read", "context_remaining",
        ...DOC_SUITE_READ_TOOLS,
      ].sort(),
    );
  });

  it("FILE_EDIT_TOOLS = 基础名 ∪ 写册（ω99-263 后十四名）", () => {
    expect([...FILE_EDIT_TOOLS].sort()).toEqual(
      ["write_file", "edit", ...DOC_SUITE_EDIT_TOOLS].sort(),
    );
  });
});

describe("ω99-236 R1(d) — log 摘要映射命中逐面（三代表面各一句形）", () => {
  it("read_xlsx / append_docx / replace_xlsx 三代表面（映射命中即 return，形不变）", () => {
    expect(summarizeToolCall("read_xlsx", { path: "订单.xlsx", sheet: "销售明细" })).toBe("订单.xlsx 「销售明细」 第 1–100 行");
    expect(summarizeToolCall("append_docx", { path: "报告.docx", blocks: [{}, {}, {}] })).toBe("报告.docx 追加 3 块");
    expect(summarizeToolCall("replace_xlsx", { path: "dir/订单.xlsx", find: "旧公司", replace: "新公司" })).toBe(
      "订单.xlsx 替换「旧公司」→「新公司」",
    );
  });

  it("make 三面 = 空串（重构前落 default，名册显式空摘要件逐字节等值）", () => {
    expect(summarizeToolCall("make_xlsx", { filename: "报表.xlsx" })).toBe("");
    expect(summarizeToolCall("make_pptx", { filename: "汇报.pptx" })).toBe("");
    expect(summarizeToolCall("make_docx", { filename: "报告.docx" })).toBe("");
  });
});

describe("ω99-236 R1(e) — file-receipt 名门含全 doc 写面", () => {
  const RECEIPT =
    `已生成 Excel：报表.xlsx（3 行 × 2 列，1.5 KB）\n` +
    JSON.stringify({ path: "/tmp/ws/报表.xlsx", relativePath: "报表.xlsx", rows: 3, bytes: 1536 });

  it("回执名册九名逐名过门；非 doc 名同款 JSON 尾不过门", () => {
    for (const name of DOC_SUITE_RECEIPT_TOOLS) {
      expect(extractFileReceipt(name, RECEIPT)).toBeDefined();
    }
    expect(extractFileReceipt("read_xlsx", RECEIPT)).toBeUndefined();
    expect(extractFileReceipt("write_file", RECEIPT)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R2 — 使能门（opt-out：缺省 true；off = 构造空；名册静态消费照旧）
// ---------------------------------------------------------------------------

describe("ω99-236 R2(f) — resolveDocSuiteEnabled 读形（lsp.enabled 同款嵌套读，缺省相反）", () => {
  const warns: string[] = [];
  const warn = (m: string): void => {
    warns.push(m);
  };

  it("未写键 = true（opt-out：已随产品在跑的能力）；显式 true/false 如实", () => {
    expect(resolveDocSuiteEnabled(undefined, warn)).toBe(true);
    expect(resolveDocSuiteEnabled({}, warn)).toBe(true);
    expect(resolveDocSuiteEnabled({ docSuite: { enabled: true } }, warn)).toBe(true);
    expect(resolveDocSuiteEnabled({ docSuite: { enabled: false } }, warn)).toBe(false);
  });

  it("junk 读作缺省 true（warn 不致命——mcpEnabled 缺省 true 门的同款宽容）", () => {
    expect(resolveDocSuiteEnabled({ docSuite: "flat" }, warn)).toBe(true);
    expect(resolveDocSuiteEnabled({ docSuite: { enabled: "nope" } }, warn)).toBe(true);
    expect(resolveDocSuiteEnabled({ docSuite: {} }, warn)).toBe(true);
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.every((w) => w.startsWith("⚠️"))).toBe(true);
  });
});

describe("ω99-236 R2(g) — off → 构造空（挂载门在构造函数首）", () => {
  it("off：createDocSuiteTools 返 []、buildToolSet 十六面全缺席、非 doc 面零扰动", () => {
    setDocSuiteRuntimeEnabled(false);
    expect(createDocSuiteTools("/tmp/ws")).toEqual([]);
    const names = build().map((t) => t.name);
    for (const n of MOUNT_ORDER) expect(names).not.toContain(n);
    // 非 doc 面零扰动：写面/读面基础工具照常，computer_drag 的下一位在
    // ω99-247: #10 演进后是 screen_observe（读面观察员同挂 computer 域尾，
    // 不随 doc 名册退场），screen_observe 的下一位才是 task。
    // ω99-250: #14 演进——computer_wait（等待员）同挂 computer 域尾（不随
    // doc 名册退场）：observe 的下一位改钉 computer_wait，再下一位才是 task。
    expect(names).toContain("write_file");
    expect(names).toContain("read_file");
    expect(names[names.indexOf("computer_drag") + 1]).toBe("screen_observe");
    expect(names[names.indexOf("screen_observe") + 1]).toBe("computer_wait");
    expect(names[names.indexOf("computer_wait") + 1]).toBe("task");
  });
});

describe("ω99-236 R2(h) — settingsSet(docSuite.enabled) 白名单收行（tmp 只写）", () => {
  it("真写 tmp settings 文件后读回；settingsStatus 回载同键", async () => {
    const home = mkdtempSync(join(tmpdir(), "o236-docsuite-home-"));
    const root = mkdtempSync(join(tmpdir(), "o236-docsuite-root-"));
    const env = (): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home });
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect(await ops.settingsSet("docSuite.enabled", false)).toEqual({ key: "docSuite.enabled", saved: true });
    const saved = JSON.parse(readFileSync(globalSettingsPath(env()), "utf8")) as Record<string, unknown>;
    expect((saved["docSuite"] as Record<string, unknown>)["enabled"]).toBe(false);
    const s = await ops.settingsStatus();
    expect(s.settings.docSuiteEnabled).toBe(false);
    // 回开一次（whole-node merge 保兄弟键；值域拒绝非布尔）。
    expect(await ops.settingsSet("docSuite.enabled", true)).toEqual({ key: "docSuite.enabled", saved: true });
    await expect(ops.settingsSet("docSuite.enabled", "nope")).rejects.toThrow(/boolean/);
  });
});
