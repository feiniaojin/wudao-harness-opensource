// ω99-124 — B: make_pptx 工具面（执行/收据/路径围栏）+ tools.ts 钉位注册
// + permission.ts 三处加名 + 两夹具 re-pin（constitution / 112）。RED-first。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@wudao/core";
import { buildPptx, createMakePptxTool, validateDocDeck } from "../src/doc-pptx.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "w124-pptx-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const DECK = {
  slides: [
    { kind: "cover", title: "季度汇报", subtitle: "2026 Q3" },
    { kind: "bullets", title: "要点", bullets: ["第一条", "第二条"] },
    { kind: "table", title: "盘点", columns: [{ header: "名称" }, { header: "数量" }], rows: [["键盘", 12]] },
  ],
};

const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);

describe("ω99-124 B — make_pptx 工具执行（tmp 工作区；校验先于副作用）", () => {
  it("缺省名：落 workspace 根，wudao-演示-时间戳形状，字节=buildPptx 直构", async () => {
    const tool = createMakePptxTool(ws);
    const r = await exec(tool, { slides: DECK.slides });
    expect(r.isError).toBeFalsy();
    const files = await readdir(ws);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^wudao-演示-\d{8}-\d{6}\.pptx$/);
    const onDisk = await readFile(join(ws, files[0]!));
    const d = validateDocDeck(DECK);
    if (!d.ok) throw new Error("fixture must validate");
    expect(onDisk.equals(Buffer.from(buildPptx(d.deck)))).toBe(true);
  });

  it("收据：中文一句含相对路径与页数 + 结构化字段一行", async () => {
    const tool = createMakePptxTool(ws);
    const r = await exec(tool, { slides: DECK.slides, filename: "汇报/季度.pptx" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已生成演示文稿：汇报/季度.pptx");
    expect(r.content).toContain("3 页");
    const jsonLine = r.content.split("\n")[1]!;
    const parsed = JSON.parse(jsonLine) as Record<string, unknown>;
    expect(parsed["relativePath"]).toBe("汇报/季度.pptx");
    expect(parsed["path"]).toBe(await realpath(join(ws, "汇报/季度.pptx")));
    expect(parsed["slides"]).toBe(3);
    expect(typeof parsed["bytes"]).toBe("number");
    expect((await stat(parsed["path"] as string)).size).toBe(parsed["bytes"]);
  });

  it("显式 filename：相对子目录 OK；.pptx 结尾可省自动补", async () => {
    const tool = createMakePptxTool(ws);
    const a = await exec(tool, { slides: DECK.slides, filename: "decks/q3" });
    expect(a.isError).toBeFalsy();
    await stat(join(ws, "decks/q3.pptx"));
    const b = await exec(tool, { slides: DECK.slides, filename: "decks/q4.pptx" });
    expect(b.isError).toBeFalsy();
    await stat(join(ws, "decks/q4.pptx"));
    expect((await readdir(join(ws, "decks"))).sort()).toEqual(["q3.pptx", "q4.pptx"]);
  });

  it("单通道（123 fix1 继承）：slides[0].filename 嵌套名被忽略——缺省时间名兜底，顶层 filename 生效", async () => {
    const tool = createMakePptxTool(ws);
    const r = await exec(tool, { slides: [{ ...(DECK.slides[0] as object), filename: "from-deck.pptx" }] });
    expect(r.isError).toBeFalsy(); // 未知键忽略（policy 面不挖嵌套）
    const files = await readdir(ws);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^wudao-演示-\d{8}-\d{6}\.pptx$/);
    expect(files).not.toContain("from-deck.pptx");
    const r2 = await exec(tool, { slides: DECK.slides, filename: "explicit.pptx" });
    expect(r2.isError).toBeFalsy();
    await stat(join(ws, "explicit.pptx"));
  });

  it("外逃拒：../ 与绝对路径 typed 拒（错误含原因），工作区零残留", async () => {
    const tool = createMakePptxTool(ws);
    const parent = await readdir(tmpdir());
    for (const bad of ["../evil.pptx", "/tmp/w124-evil.pptx"]) {
      const r = await exec(tool, { slides: DECK.slides, filename: bad });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("escapes workspace");
      expect(r.content).not.toContain("已生成");
    }
    expect(await readdir(ws)).toEqual([]); // 拒时零写盘
    expect(parent.includes("evil.pptx")).toBe(false);
  });

  it("validate 拒时零写盘：坏 deck / 坏 filename 类型都不落一个字节", async () => {
    const tool = createMakePptxTool(ws);
    const bads: Record<string, unknown>[] = [
      { slides: [] },
      { slides: [{ kind: "quote", title: "t" }] },
      { slides: [{ kind: "bullets", title: "t", bullets: Array.from({ length: 7 }, () => "x") }] },
      { slides: DECK.slides, filename: 42 },
      { slides: 7 },
    ];
    for (const args of bads) {
      const r = await exec(tool, args);
      expect(r.isError).toBe(true);
    }
    expect(await readdir(ws)).toEqual([]);
  });

  it("描述与收据=用户语：无实现术语（DocDeck/buildTool/buildPptx/storedZip 类）", async () => {
    const tool = createMakePptxTool(ws);
    for (const jargon of ["DocDeck", "buildTool", "buildPptx", "AgentState", "validateDocDeck", "storedZip"]) {
      expect(tool.description).not.toContain(jargon);
    }
    const r = await exec(tool, { slides: DECK.slides, filename: "文案.pptx" });
    expect(r.isError).toBeFalsy();
    for (const jargon of ["DocDeck", "buildTool", "buildPptx", "storedZip"]) {
      expect(r.content).not.toContain(jargon);
    }
  });
});

// ---------------------------------------------------------------------------
// 注册钉位 + 权限三处 + 风险标注
// ---------------------------------------------------------------------------
import { buildToolSet } from "../src/tools.js";
import { FILE_EDIT_TOOLS, PLAN_DENY_REASON, decidePermission, protectedSettingsFile, credentialMaterialPath } from "../src/permission.js";

const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
const BASE = { workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 } as const;

describe("ω99-124 B — 注册门：顶级工具列表含 make_pptx 且钉在 make_xlsx 之后", () => {
  it("零配置 always-on：最小 BASE 集即注册，位置=make_xlsx+1", () => {
    const names = buildToolSet({ ...BASE }).map((t) => t.name);
    expect(names).toContain("make_xlsx");
    expect(names).toContain("make_pptx");
    expect(names.indexOf("make_pptx")).toBe(names.indexOf("make_xlsx") + 1);
  });

  it("风险标注：写盘（非只读）、非并发安全、destructive 诚实标注（显式名可覆盖既有文件）、本地文件系统（非开放世界）", () => {
    const tool = createMakePptxTool("/tmp/ws");
    expect(tool.isReadOnly?.({})).toBe(false);
    expect(tool.isConcurrencySafe?.({})).toBe(false);
    expect(tool.isDestructive?.({})).toBe(true);
    expect(tool.isOpenWorld?.({})).toBe(false);
  });
});

describe("ω99-124 B — 权限三处加名", () => {
  it("FILE_EDIT_TOOLS 含 make_pptx：workspace 档自动放行（同 write_file posture）", () => {
    expect(FILE_EDIT_TOOLS.has("make_pptx")).toBe(true);
    expect(decidePermission("workspace", "make_pptx")).toEqual({ behavior: "allow" });
    expect(decidePermission("ask", "make_pptx")).toBe("ask");
    expect(decidePermission("plan", "make_pptx")).toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
    expect(decidePermission("auto", "make_pptx")).toEqual({ behavior: "allow" });
  });

  it("写类硬安全门（bypass 免疫）纳入 make_pptx——目标参数是 filename 不是 path", () => {
    expect(protectedSettingsFile("make_pptx", { filename: ".wudao/settings.json" })).toBe(".wudao/settings.json");
    expect(protectedSettingsFile("make_pptx", { filename: ".wudao/extensions/evil.pptx" })).toBe(".wudao/extensions");
    expect(protectedSettingsFile("make_pptx", { filename: "docs/.wudao/plugins/hook.pptx" })).toBe(".wudao/plugins");
    expect(protectedSettingsFile("make_pptx", { filename: "汇报/季度.pptx" })).toBeUndefined();
    expect(protectedSettingsFile("make_pptx", { path: ".wudao/settings.json" })).toBeUndefined(); // path 键不是本工具目标
    expect(protectedSettingsFile("make_xlsx", { filename: ".wudao/settings.json" })).toBe(".wudao/settings.json"); // 123 语义不变（硬门读原始参数，后缀追加在后）
  });

  it("credentialMaterialPath 同款取 filename 键（夜移 010 ASK 警告收口）", () => {
    expect(credentialMaterialPath("make_pptx", { filename: "deploy/.ssh/staging.pptx" })).toBeDefined();
    expect(credentialMaterialPath("make_pptx", { filename: "汇报/清单.pptx" })).toBeUndefined();
    expect(credentialMaterialPath("make_pptx", { path: "deploy/.ssh/staging.pptx" })).toBeUndefined();
  });
});
