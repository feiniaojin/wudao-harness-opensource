// ω99-123 — B: make_xlsx 工具面（执行/收据/路径围栏）+ tools.ts 钉位注册
// + permission.ts 两处加名。RED-first。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@wudao/core";
import { buildXlsx, createMakeXlsxTool, validateDocTable } from "../src/doc-xlsx.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "w123-xlsx-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const TABLE = {
  columns: [
    { header: "名称", width: 20 },
    { header: "数量" },
    { header: "备注" },
  ],
  rows: [
    ["键盘", 12, true],
    ["鼠标", null, "备 <货>"],
  ],
};

const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);

describe("ω99-123 B — make_xlsx 工具执行（tmp 工作区；校验先于副作用）", () => {
  it("缺省名：落 workspace 根，wudao-表格-时间戳形状，字节=buildXlsx 直构", async () => {
    const tool = createMakeXlsxTool(ws);
    const r = await exec(tool, { table: TABLE });
    expect(r.isError).toBeFalsy();
    const files = await readdir(ws);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^wudao-表格-\d{8}-\d{6}\.xlsx$/);
    const onDisk = await readFile(join(ws, files[0]!));
    const t = validateDocTable(TABLE);
    if (!t.ok) throw new Error("fixture must validate");
    expect(onDisk.equals(Buffer.from(buildXlsx(t.table)))).toBe(true);
  });

  it("收据：中文一句含相对路径与行列数 + 结构化字段一行", async () => {
    const tool = createMakeXlsxTool(ws);
    const r = await exec(tool, { table: TABLE, filename: "盘点/清点结果.xlsx" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已生成 Excel：盘点/清点结果.xlsx");
    expect(r.content).toContain("2 行 × 3 列");
    const jsonLine = r.content.split("\n")[1]!;
    const parsed = JSON.parse(jsonLine) as Record<string, unknown>;
    expect(parsed["relativePath"]).toBe("盘点/清点结果.xlsx");
    expect(parsed["path"]).toBe(await realpath(join(ws, "盘点/清点结果.xlsx"))); // resolveWorkspacePath 走 realpath
    expect(parsed["rows"]).toBe(2);
    expect(parsed["columns"]).toBe(3);
    expect(typeof parsed["bytes"]).toBe("number");
    expect((await stat(parsed["path"] as string)).size).toBe(parsed["bytes"]);
  });

  it("显式 filename：相对子目录 OK；.xlsx 结尾可省自动补", async () => {
    const tool = createMakeXlsxTool(ws);
    const a = await exec(tool, { table: TABLE, filename: "reports/q3" });
    expect(a.isError).toBeFalsy();
    await stat(join(ws, "reports/q3.xlsx"));
    const b = await exec(tool, { table: TABLE, filename: "reports/q4.xlsx" });
    expect(b.isError).toBeFalsy();
    await stat(join(ws, "reports/q4.xlsx"));
    const files = (await readdir(ws)).sort();
    expect(files).toEqual(["reports"]);
    expect((await readdir(join(ws, "reports"))).sort()).toEqual(["q3.xlsx", "q4.xlsx"]);
  });

  it("单通道（fix1 裁决）：table.filename 字段已砍——嵌套名被忽略，缺省时间名兜底；顶层 filename 生效", async () => {
    const tool = createMakeXlsxTool(ws);
    // 表内携带 filename（哪怕形状合法）不再是写盘通道：忽略 → 缺省时间名落根。
    const r = await exec(tool, { table: { ...TABLE, filename: "from-table.xlsx" } });
    expect(r.isError).toBeFalsy();
    const files = await readdir(ws);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^wudao-表格-\d{8}-\d{6}\.xlsx$/);
    expect(files).not.toContain("from-table.xlsx");
    // 顶层参数照旧生效。
    const r2 = await exec(tool, { table: { ...TABLE, filename: "ignored.xlsx" }, filename: "explicit.xlsx" });
    expect(r2.isError).toBeFalsy();
    await stat(join(ws, "explicit.xlsx"));
  });

  it("安全面（fix1 裁决）：table.filename 塞受保护路径不落盘、不越硬门——唯一通道是顶层参数", async () => {
    const tool = createMakeXlsxTool(ws);
    const r = await exec(tool, { table: { ...TABLE, filename: ".wudao/settings.json" } });
    expect(r.isError).toBeFalsy(); // 嵌套通道已死：不算错，只是被忽略
    const files = await readdir(ws);
    expect(files.length).toBe(1); // 缺省时间名落根
    expect(files[0]).toMatch(/^wudao-表格-/);
    expect(files).not.toContain(".wudao");
  });

  it("外逃拒：../ 与绝对路径 typed 拒（错误含原因），工作区零残留", async () => {
    const tool = createMakeXlsxTool(ws);
    const parent = await readdir(tmpdir());
    for (const bad of ["../evil.xlsx", "/tmp/w123-evil.xlsx"]) {
      const r = await exec(tool, { table: TABLE, filename: bad });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("escapes workspace");
      expect(r.content).not.toContain("已生成");
    }
    expect(await readdir(ws)).toEqual([]); // 拒时零写盘
    expect(parent.includes("evil.xlsx")).toBe(false);
  });

  it("validate 拒时零写盘：坏表/坏 filename 类型都不落一个字节", async () => {
    const tool = createMakeXlsxTool(ws);
    const bads: Record<string, unknown>[] = [
      { table: { columns: [], rows: [] } },
      { table: { columns: [{ header: "a" }], rows: [["x"]] }, filename: 42 },
      { table: { columns: [{ header: "a" }], rows: [["a\x07b"]] } },
      { table: 7 },
    ];
    for (const args of bads) {
      const r = await exec(tool, args);
      expect(r.isError).toBe(true);
    }
    expect(await readdir(ws)).toEqual([]);
  });

  it("描述与收据=用户语：无实现术语（DocTable/buildTool/AgentState 类）", async () => {
    const tool = createMakeXlsxTool(ws);
    for (const jargon of ["DocTable", "buildTool", "buildXlsx", "AgentState", "validateDocTable", "storedZip"]) {
      expect(tool.description).not.toContain(jargon);
    }
    const r = await exec(tool, { table: TABLE, filename: "文案.xlsx" });
    expect(r.isError).toBeFalsy();
    for (const jargon of ["DocTable", "buildTool", "buildXlsx", "storedZip"]) {
      expect(r.content).not.toContain(jargon);
    }
  });
});

// ---------------------------------------------------------------------------
// 注册钉位（同 118 注册测试手法）+ 权限两处（FILE_EDIT_TOOLS / 写类硬安全门）
// ---------------------------------------------------------------------------
import { buildToolSet } from "../src/tools.js";
import { FILE_EDIT_TOOLS, PLAN_DENY_REASON, decidePermission, protectedSettingsFile } from "../src/permission.js";

const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
const BASE = { workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 } as const;

describe("ω99-123 B — 注册门：顶级工具列表含 make_xlsx 且钉在 constitution_suggest 之后", () => {
  it("零配置 always-on：最小 BASE 集即注册，位置=constitution_suggest+1", () => {
    const names = buildToolSet({ ...BASE }).map((t) => t.name);
    expect(names).toContain("constitution_suggest");
    expect(names).toContain("make_xlsx");
    expect(names.indexOf("make_xlsx")).toBe(names.indexOf("constitution_suggest") + 1);
  });

  it("风险标注：写盘（非只读）、本地文件系统（非开放世界）", () => {
    const tool = createMakeXlsxTool("/tmp/ws");
    expect(tool.isReadOnly?.({})).toBe(false);
    expect(tool.isOpenWorld?.({})).toBe(false);
    expect(tool.isDestructive?.({})).toBe(true); // 显式 filename 可覆盖既有文件——write_file 同款诚实标注
  });
});

describe("ω99-123 B — 权限两处加名", () => {
  it("FILE_EDIT_TOOLS 含 make_xlsx：workspace 档自动放行（同 write_file posture）", () => {
    expect(FILE_EDIT_TOOLS.has("make_xlsx")).toBe(true);
    expect(decidePermission("workspace", "make_xlsx")).toEqual({ behavior: "allow" });
    expect(decidePermission("ask", "make_xlsx")).toBe("ask");
    expect(decidePermission("plan", "make_xlsx")).toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
    expect(decidePermission("auto", "make_xlsx")).toEqual({ behavior: "allow" });
  });

  it("写类硬安全门（bypass 免疫）纳入 make_xlsx——目标参数是 filename 不是 path", () => {
    // 钩子源树：任何深度都拦（.wudao/extensions|plugins = 未来的权限策略落点）。
    expect(protectedSettingsFile("make_xlsx", { filename: ".wudao/extensions/evil.xlsx" })).toBe(".wudao/extensions");
    expect(protectedSettingsFile("make_xlsx", { filename: "docs/.wudao/plugins/hook.xlsx" })).toBe(".wudao/plugins");
    // 运行时策略文件（补 .xlsx 后不再等于受保护路径——但同形前缀也拦住）。
    expect(protectedSettingsFile("make_xlsx", { filename: ".wudao/settings.json/foo.xlsx" })).toBeUndefined();
    // 普通路径放行；write_file/edit 语义不变；path 键不是本工具的目标。
    expect(protectedSettingsFile("make_xlsx", { filename: "notes/清单.xlsx" })).toBeUndefined();
    expect(protectedSettingsFile("make_xlsx", { path: ".wudao/settings.json" })).toBeUndefined();
    expect(protectedSettingsFile("write_file", { path: ".wudao/settings.json" })).toBe(".wudao/settings.json");
    expect(protectedSettingsFile("edit", { path: "src/a.ts" })).toBeUndefined();
  });
});

