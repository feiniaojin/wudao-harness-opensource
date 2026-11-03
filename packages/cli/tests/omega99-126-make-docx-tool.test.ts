// ω99-126 — B: make_docx 工具面（执行/收据/路径围栏）+ tools.ts 钉位注册
// + permission.ts 三处加名（Set 收口：FILENAME_KEY_TOOLS）+ 两夹具 re-pin
// （constitution / 112，另 commit）+ permission.test.ts 补例（另 commit 内联
// 于本弧）。RED-first。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@wudao-org/core";
import { buildDocx, createMakeDocxTool, validateDocDoc } from "../src/doc-docx.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "w126-docx-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const DOC = {
  blocks: [
    { kind: "title", text: "季度盘点报告" },
    { kind: "heading", text: "一、总体情况" },
    { kind: "body", text: "正文一段。" },
    { kind: "bullet", text: "要点" },
    { kind: "table", columns: [{ header: "名称" }, { header: "数量" }], rows: [["键盘", 12]] },
  ],
};

const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);

describe("ω99-126 B — make_docx 工具执行（tmp 工作区；校验先于副作用）", () => {
  it("缺省名：落 workspace 根，wudao-文档-时间戳形状，字节=buildDocx 直构", async () => {
    const tool = createMakeDocxTool(ws);
    const r = await exec(tool, { blocks: DOC.blocks });
    expect(r.isError).toBeFalsy();
    const files = await readdir(ws);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^wudao-文档-\d{8}-\d{6}\.docx$/);
    const onDisk = await readFile(join(ws, files[0]!));
    const d = validateDocDoc(DOC);
    if (!d.ok) throw new Error("fixture must validate");
    expect(Buffer.from(onDisk).equals(Buffer.from(buildDocx(d.doc)))).toBe(true);
  });

  it("收据：中文一句含相对路径与块数 + 结构化字段一行", async () => {
    const tool = createMakeDocxTool(ws);
    const r = await exec(tool, { blocks: DOC.blocks, filename: "报告/季度.docx" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已生成文档：报告/季度.docx");
    expect(r.content).toContain("5 块");
    const jsonLine = r.content.split("\n")[1]!;
    const parsed = JSON.parse(jsonLine) as Record<string, unknown>;
    expect(parsed["relativePath"]).toBe("报告/季度.docx");
    expect(parsed["path"]).toBe(await realpath(join(ws, "报告/季度.docx")));
    expect(parsed["blocks"]).toBe(5);
    expect(typeof parsed["bytes"]).toBe("number");
    expect((await stat(parsed["path"] as string)).size).toBe(parsed["bytes"]);
  });

  it("显式 filename：相对子目录 OK；.docx 结尾可省自动补", async () => {
    const tool = createMakeDocxTool(ws);
    const a = await exec(tool, { blocks: DOC.blocks, filename: "docs/q3" });
    expect(a.isError).toBeFalsy();
    await stat(join(ws, "docs/q3.docx"));
    const b = await exec(tool, { blocks: DOC.blocks, filename: "docs/q4.docx" });
    expect(b.isError).toBeFalsy();
    await stat(join(ws, "docs/q4.docx"));
    expect((await readdir(join(ws, "docs"))).sort()).toEqual(["q3.docx", "q4.docx"]);
  });

  it("单通道（123 fix1 继承）：blocks[0].filename 嵌套名被忽略——缺省时间名兜底，顶层 filename 生效", async () => {
    const tool = createMakeDocxTool(ws);
    const r = await exec(tool, { blocks: [{ ...(DOC.blocks[0] as object), filename: "from-doc.docx" }] });
    expect(r.isError).toBeFalsy(); // 未知键忽略（policy 面不挖嵌套）
    const files = await readdir(ws);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^wudao-文档-\d{8}-\d{6}\.docx$/);
    expect(files).not.toContain("from-doc.docx");
    const r2 = await exec(tool, { blocks: DOC.blocks, filename: "explicit.docx" });
    expect(r2.isError).toBeFalsy();
    await stat(join(ws, "explicit.docx"));
  });

  it("外逃拒：../ 与绝对路径 typed 拒（错误含原因），工作区零残留", async () => {
    const tool = createMakeDocxTool(ws);
    const parent = await readdir(tmpdir());
    for (const bad of ["../evil.docx", "/tmp/w126-evil.docx"]) {
      const r = await exec(tool, { blocks: DOC.blocks, filename: bad });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("escapes workspace");
      expect(r.content).not.toContain("已生成");
    }
    expect(await readdir(ws)).toEqual([]); // 拒时零写盘
    expect(parent.includes("evil.docx")).toBe(false);
  });

  it("validate 拒时零写盘：坏 doc / 坏 filename 类型都不落一个字节", async () => {
    const tool = createMakeDocxTool(ws);
    const bads: Record<string, unknown>[] = [
      { blocks: [] },
      { blocks: [{ kind: "quote", text: "t" }] },
      { blocks: [{ kind: "body", text: "" }] },
      { blocks: DOC.blocks, filename: 42 },
      { blocks: 7 },
    ];
    for (const args of bads) {
      const r = await exec(tool, args);
      expect(r.isError).toBe(true);
    }
    expect(await readdir(ws)).toEqual([]);
  });

  it("描述与收据=用户语：无实现术语（DocDoc/buildTool/buildDocx/storedZip 类）", async () => {
    const tool = createMakeDocxTool(ws);
    for (const jargon of ["DocDoc", "DocBlock", "buildTool", "buildDocx", "AgentState", "validateDocDoc", "storedZip"]) {
      expect(tool.description).not.toContain(jargon);
    }
    const r = await exec(tool, { blocks: DOC.blocks, filename: "文案.docx" });
    expect(r.isError).toBeFalsy();
    for (const jargon of ["DocDoc", "buildTool", "buildDocx", "storedZip"]) {
      expect(r.content).not.toContain(jargon);
    }
  });
});

// ---------------------------------------------------------------------------
// 注册钉位 + 权限三处（Set 收口）+ 风险标注
// ---------------------------------------------------------------------------
import { buildToolSet } from "../src/tools.js";
import {
  FILE_EDIT_TOOLS,
  FILENAME_KEY_TOOLS,
  PLAN_DENY_REASON,
  decidePermission,
  protectedSettingsFile,
  credentialMaterialPath,
} from "../src/permission.js";

const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
const BASE = { workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 } as const;

describe("ω99-126 B — 注册门：顶级工具列表含 make_docx 且钉在 make_pptx 之后", () => {
  it("零配置 always-on：最小 BASE 集即注册，位置=make_pptx+1", () => {
    const names = buildToolSet({ ...BASE }).map((t) => t.name);
    expect(names).toContain("make_pptx");
    expect(names).toContain("make_docx");
    expect(names.indexOf("make_docx")).toBe(names.indexOf("make_pptx") + 1);
  });

  it("风险标注：写盘（非只读）、非并发安全、destructive 诚实标注（显式名可覆盖既有文件）、本地文件系统（非开放世界）", () => {
    const tool = createMakeDocxTool("/tmp/ws");
    expect(tool.isReadOnly?.({})).toBe(false);
    expect(tool.isConcurrencySafe?.({})).toBe(false);
    expect(tool.isDestructive?.({})).toBe(true);
    expect(tool.isOpenWorld?.({})).toBe(false);
  });
});

describe("ω99-126 B — 权限三处加名（Set 收口）", () => {
  it("FILE_EDIT_TOOLS 含 make_docx：workspace 档自动放行（同 write_file posture）", () => {
    expect(FILE_EDIT_TOOLS.has("make_docx")).toBe(true);
    expect(decidePermission("workspace", "make_docx")).toEqual({ behavior: "allow" });
    expect(decidePermission("ask", "make_docx")).toBe("ask");
    expect(decidePermission("plan", "make_docx")).toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
    expect(decidePermission("auto", "make_docx")).toEqual({ behavior: "allow" });
  });

  it("FILENAME_KEY_TOOLS 收口：三名齐；xlsx/pptx 既有语义零变（行为零变的机器证）", () => {
    expect(FILENAME_KEY_TOOLS.has("make_xlsx")).toBe(true);
    expect(FILENAME_KEY_TOOLS.has("make_pptx")).toBe(true);
    expect(FILENAME_KEY_TOOLS.has("make_docx")).toBe(true);
    expect(FILENAME_KEY_TOOLS.has("write_file")).toBe(false); // path 键工具不进
    expect(FILENAME_KEY_TOOLS.has("edit")).toBe(false);
  });

  it("写类硬安全门（bypass 免疫）纳入 make_docx——目标参数是 filename 不是 path", () => {
    expect(protectedSettingsFile("make_docx", { filename: ".wudao/settings.json" })).toBe(".wudao/settings.json");
    expect(protectedSettingsFile("make_docx", { filename: ".wudao/extensions/evil.docx" })).toBe(".wudao/extensions");
    expect(protectedSettingsFile("make_docx", { filename: "docs/.wudao/plugins/hook.docx" })).toBe(".wudao/plugins");
    expect(protectedSettingsFile("make_docx", { filename: "报告/季度.docx" })).toBeUndefined();
    expect(protectedSettingsFile("make_docx", { path: ".wudao/settings.json" })).toBeUndefined(); // path 键不是本工具目标
    expect(protectedSettingsFile("make_xlsx", { filename: ".wudao/settings.json" })).toBe(".wudao/settings.json"); // 123 语义不变
    expect(protectedSettingsFile("make_pptx", { filename: ".wudao/settings.json" })).toBe(".wudao/settings.json"); // 124 语义不变
    expect(protectedSettingsFile("write_file", { path: ".wudao/settings.json" })).toBe(".wudao/settings.json"); // path 键工具不变
    expect(protectedSettingsFile("read_file", { path: ".wudao/settings.json" })).toBeUndefined(); // 非写类零变
  });

  it("credentialMaterialPath 同款取 filename 键（夜移 010 ASK 警告收口）", () => {
    expect(credentialMaterialPath("make_docx", { filename: "deploy/.ssh/staging.docx" })).toBeDefined();
    expect(credentialMaterialPath("make_docx", { filename: "报告/清单.docx" })).toBeUndefined();
    expect(credentialMaterialPath("make_docx", { path: "deploy/.ssh/staging.docx" })).toBeUndefined();
    expect(credentialMaterialPath("make_xlsx", { filename: "deploy/.ssh/staging.xlsx" })).toBeDefined(); // 123 fix2 语义不变
    expect(credentialMaterialPath("write_file", { path: "deploy/.ssh/id_rsa" })).toBeDefined(); // path 键工具不变
  });
});
