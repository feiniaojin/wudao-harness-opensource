// ω99-257: #1 — scroll/drag 补 ref 寻址 receipts（computer ref 面收口：
// helper 观察行补元素中心坐标 @cx,cy → TS 解析（旧形兼容）→ computer_scroll
// 增 ref（滚轮发生在元素中心）→ computer_drag 增 startRef/endRef（各自覆盖
// 对应坐标对；ref 坐标=屏幕点绕过 captureScale 换算——口径主钉）。★测试红线
// （212/220/241/244/247/250 既立红线沿承）：ExecSeam 全 mock——绝不真键鼠/
// 截屏/真 osascript/真 AX/真模型；swiftc 仅 -parse 语法自检零产物（绝不编译
// 出二进制绝不真跑）；夹具只经工具自己的 tmpdir 落点（自落自清），零 rm/
// unlink；读 Swift 源文件是只读。
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildDragArgs,
  buildScrollArgs,
  observeElementDetail,
  observeRefEntry,
  observeRefs,
  parseObserveOutput,
  type ExecSeam,
  type ExecResult,
} from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";

const execFileAsync = promisify(execFile);
const HELPER = "/fake/wudao-click";
const SHA_A = "a".repeat(64);

/** 观察表（带 @cx,cy 的新形）：e3 图片「封面」中心 (100,200)、e5 列表
 *  「文件列表」中心 (371,204)、e7 按钮「新建文件夹」中心 (500,600)、e9
 *  无位置容器（旧 helper 过渡形=position/size 缺席→@ 段整段省略）。 */
const TABLE_WITH_AT = [
  "WUDAO_OBSERVE app=Finder",
  "WUDAO_WINDOW 文件",
  '[e1] AXWindow "文件"',
  '  [e3] AXImage "封面" @100,200',
  '  [e5] AXList "文件列表" @371,204',
  '  [e7] AXButton "新建文件夹" @500,600',
  "  [e9] AXGroup \"无位置容器\"",
  `WUDAO_END nodes=5 truncated=0 sha256=${SHA_A}`,
].join("\n");

/** 旧形观察表（无 @）：e2 在表、但 entry 无 x/y（R2 的诚实缺席路径）。 */
const TABLE_OLD_FORM = [
  "WUDAO_OBSERVE app=Safari",
  "WUDAO_WINDOW 备注",
  '[e1] AXWindow "备注"',
  '  [e2] AXButton "添加"',
  `WUDAO_END nodes=2 truncated=0 sha256=${SHA_A}`,
].join("\n");

const obs = (lines: readonly string[], nodes: number): string => [
  "WUDAO_OBSERVE app=Finder",
  "WUDAO_WINDOW 文件",
  ...lines,
  `WUDAO_END nodes=${nodes} truncated=0 sha256=${SHA_A}`,
].join("\n");

/** 一次缝四角色（helper observe→剧本表 / screencapture+sips 链 / JXA 主屏点
 *  / 其余默认成功空输出）。captureScale 由 capture 链建立（screenW/outW）。 */
interface SeamOpts {
  readonly observe?: string;
  readonly rawW?: number;
  readonly rawH?: number;
  readonly outW?: number;
  readonly outH?: number;
  readonly screenW?: number;
  readonly screenH?: number;
}

const seam = (o: SeamOpts = {}): ExecSeam & { calls: { file: string; args: string[] }[] } => {
  const calls: { file: string; args: string[] }[] = [];
  let resized = false;
  const s: ExecSeam = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === HELPER && args[0] === "observe") {
      return { stdout: o.observe ?? TABLE_WITH_AT, stderr: "", code: 0 };
    }
    if (file === "screencapture") {
      await writeFile(args[1]!, Buffer.alloc(50_000, 7)); // 假 PNG（工具自己的 tmpdir 落点，工具 finally 自清）
      return { stdout: "", stderr: "", code: 0 };
    }
    if (file === "sips") {
      if (args[0] === "-Z") {
        resized = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      const w = resized ? (o.outW ?? o.rawW ?? 1280) : (o.rawW ?? 1280);
      const h = resized ? (o.outH ?? o.rawH ?? 800) : (o.rawH ?? 800);
      return { stdout: `${args[args.length - 1]}\n  pixelWidth: ${w}\n  pixelHeight: ${h}\n`, stderr: "", code: 0 };
    }
    if (file === "osascript" && args[0] === "-l") {
      return { stdout: `${o.screenW ?? 1440}x${o.screenH ?? 900}`, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return Object.assign(s, { calls });
};

const fakeVision = () => ({
  store: {
    saveImages: async (inputs: readonly { data: string; mediaType: string }[]) =>
      inputs.map((_, i) => ({ kind: "image" as const, attachmentId: `att-${i + 1}`, mediaType: "image/png", byteLength: 50_000 })),
  },
  modelAcceptsImages: () => true,
});

const toolset = (s: ExecSeam) =>
  createComputerTools({ exec: s, platform: "darwin", env: { WUDAO_CLICK_HELPER: HELPER }, helperExists: () => true, vision: fakeVision() });
const find = (t: ReturnType<typeof createComputerTools>, name: string) => t.find((x) => x.name === name)!;
const helperCalls = (s: { calls: { file: string; args: string[] }[] }) =>
  s.calls.filter((c) => c.file === HELPER);
/** captureScale=2 的既定基准（screenW 2560 / outW 1280）——R3/R7 的「换算在
 *  场而 ref 坐标不被换算」主钉前提。 */
const scaleTwo = () => seam({ observe: TABLE_WITH_AT, rawW: 2560, rawH: 1600, outW: 1280, outH: 800, screenW: 2560, screenH: 1600 });

// ---------------------------------------------------------------------------
// R1 — 行形解析（新形 @cx,cy；旧形兼容；负坐标；value 共存）
// ---------------------------------------------------------------------------
describe("ω99-257 R1 — ELEMENT_LINE/细读器吃 @cx,cy（旧形照常）", () => {
  it("新形：title + @ + value 共存——entry 带 x/y；无 title 的 @ 形也解析", () => {
    const e = observeRefEntry('[e5] AXButton "OK" @371,204 value="x"');
    expect(e).toMatchObject({ ref: "e5", role: "AXButton", title: "OK", x: 371, y: 204 });
    const bare = observeRefEntry("  [e7] AXGroup @12,34");
    expect(bare).toMatchObject({ ref: "e7", role: "AXGroup", title: "", x: 12, y: 34 });
  });

  it("旧形（无 @）照常解析：x/y undefined（旧版桌面 helper 二进制无 @ 段）", () => {
    const e = observeRefEntry('  [e2] AXButton "添加"');
    expect(e).toMatchObject({ ref: "e2", role: "AXButton", title: "添加" });
    expect(e!.x).toBeUndefined();
    expect(e!.y).toBeUndefined();
    const v = observeRefEntry('  [e3] AXStaticText "状态" value="加载中"');
    expect(v!.title).toBe("状态"); // 严格引号形：value 不再被贪婪标题吃进
    expect(v!.x).toBeUndefined();
  });

  it("多屏负坐标合法：@-100,50 → x=-100；细读器（observeElementDetail）随行", () => {
    const e = observeRefEntry('[e7] AXWindow "w" @-100,50 value="v"');
    expect(e).toMatchObject({ ref: "e7", x: -100, y: 50 });
    const d = observeElementDetail('  [e5] AXList "文件列表" @371,204 value="加载中" focused');
    expect(d).toMatchObject({ ref: "e5", role: "AXList", title: "文件列表", value: "加载中", focused: true, x: 371, y: 204 });
    const dOld = observeElementDetail('  [e5] AXList "文件列表" value="加载中" focused');
    expect(dOld).toMatchObject({ ref: "e5", value: "加载中", focused: true });
    expect(dOld!.x).toBeUndefined();
  });

  it("parseObserveOutput 收新形表（ELEMENT_LINE 校验随行）；observeRefs 的 entry 带 x/y", () => {
    const read = parseObserveOutput(TABLE_WITH_AT);
    expect(read.ok).toBe(true);
    const refs = observeRefs(read.ok ? read.table : { app: "", window: "", elementLines: [], nodes: 0, truncated: false, sha256: "" });
    expect(refs.get("e5")).toMatchObject({ x: 371, y: 204 });
    expect(refs.get("e9")!.x).toBeUndefined(); // 诚实缺席：无 @ 段的行照进表（ref 点选照常），只是无位置
  });
});

// ---------------------------------------------------------------------------
// R2 — 位置缺席诚实：entry 无 x/y → scroll/drag 用它 → typed 出路
// ---------------------------------------------------------------------------
describe("ω99-257 R2 — 位置缺席的 typed 出路（升级/坐标路径）", () => {
  it("scroll：旧形观察表的 entry（无 x/y）→ typed 错误带「升级桌面版」出路，零 helper 动作", async () => {
    const s = seam({ observe: TABLE_OLD_FORM });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_scroll").execute({ ref: "e2", dy: 300 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("位置信息不在观察表里");
    expect(r.content).toContain("旧版桌面助手的观察不带位置");
    expect(r.content).toContain("升级桌面版");
    expect(helperCalls(s).filter((c) => c.args[0] === "scroll")).toHaveLength(0); // 零派生
  });

  it("drag：同形——startRef 落在无位置 entry → typed 出路，零 helper 动作", async () => {
    const s = seam({ observe: TABLE_WITH_AT }); // e9 无 @ 段
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e9", endX: 10, endY: 20 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("位置信息不在观察表里");
    expect(helperCalls(s).filter((c) => c.args.length >= 4 && c.args[0] !== "observe")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R3 — scroll ref 主路径（口径主钉：ref 坐标=屏幕点原值，绕过 captureScale）
// ---------------------------------------------------------------------------
describe("ω99-257 R3 — scroll(ref)：滚轮发生在元素中心，坐标原值直通", () => {
  it("captureScale=2 在场：argv x,y=元素中心原值（371,204 未被 ×2）；增量照模型量纲换算（300→600）；尾随 at 旗标", async () => {
    const s = scaleTwo();
    const t = toolset(s);
    await find(t, "screen_capture").execute({}); // 建立换算基准（scale=2）
    await find(t, "screen_observe").execute({}); // 播种 refs（带 @）
    const r = await find(t, "computer_scroll").execute({ ref: "e5", dy: 300 });
    expect(r.isError).toBeFalsy();
    const action = helperCalls(s).find((c) => c.args[0] === "scroll")!;
    expect(action.args).toEqual(["scroll", "371", "204", "0", "-600", "at"]); // ★口径主钉：x,y 原值（非 742,408）
    expect(r.content).toContain("[e5] 列表「文件列表」"); // 收据点名（click 范式）
  });

  it("纯层直钉：buildScrollArgs 的 at 形——x/y 原值直通、增量照 scale 换算；scale 换挡 x,y 不动", () => {
    expect(buildScrollArgs(40, 300, 2, { x: 371, y: 204 })).toEqual({ ok: true, args: ["scroll", "371", "204", "80", "-600", "at"] });
    expect(buildScrollArgs(40, 300, 3, { x: 371, y: 204 })).toEqual({ ok: true, args: ["scroll", "371", "204", "120", "-900", "at"] });
    expect(buildScrollArgs(undefined, 300, 2)).toEqual({ ok: true, args: ["scroll", "0", "0", "0", "-600"] }); // 无 at：占位形字节不变
  });
});

// ---------------------------------------------------------------------------
// R4 — scroll 无 ref 零演进（指针语义+换算照旧）
// ---------------------------------------------------------------------------
describe("ω99-257 R4 — scroll 无 ref：argv 字节不变（220/244 语义复钉）", () => {
  it("captureScale=2 在场：dy=300 → argv=[scroll,0,0,0,-600]（占位 0 0+换算），无 at 旗标", async () => {
    const s = scaleTwo();
    const t = toolset(s);
    await find(t, "screen_capture").execute({});
    const r = await find(t, "computer_scroll").execute({ dy: 300 });
    expect(r.isError).toBeFalsy();
    const action = helperCalls(s).find((c) => c.args[0] === "scroll")!;
    expect(action.args).toEqual(["scroll", "0", "0", "0", "-600"]);
    expect(r.content).toContain("向下滚动 300 像素"); // 回执照报模型量纲
  });

  it("ref 形校验仍在前：dy 非法时即便 ref 合法也 typed 拒（校验先于副作用）", async () => {
    const s = seam({ observe: TABLE_WITH_AT });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_scroll").execute({ ref: "e5", dy: 1.5 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('"dy" must be an integer');
    expect(helperCalls(s).filter((c) => c.args[0] === "scroll")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R5 — scroll ref 缺席/stale（click 范式）
// ---------------------------------------------------------------------------
describe("ω99-257 R5 — scroll ref 缺席/stale/形状", () => {
  it("无观察 → 「call screen_observe first」", async () => {
    const t = toolset(seam());
    const r = await find(t, "computer_scroll").execute({ ref: "e5", dy: 100 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("No observation yet");
    expect(r.content).toContain("screen_observe");
  });

  it("ref 不在表（含空观察的空表）→ stale 文案「call screen_observe again」", async () => {
    const s = seam({ observe: TABLE_WITH_AT }); // 无 e42
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_scroll").execute({ ref: "e42", dy: 100 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not in the current observation");
    expect(r.content).toContain("call screen_observe again");

    const empty = seam({ observe: obs(['[e1] AXWindow "游戏"'], 1) }); // 空观察也覆写为空 refs——click 范式
    const te = toolset(empty);
    await find(te, "screen_observe").execute({});
    const re = await find(te, "computer_scroll").execute({ ref: "e5", dy: 100 });
    expect(re.isError).toBe(true);
    expect(re.content).toContain("not in the current observation");
  });

  it("ref 形状非法（e0/xyz/数字）→ 形状文案 typed 拒", async () => {
    const t = toolset(seam());
    for (const bad of ["e0", "xyz", 5]) {
      const r = await find(t, "computer_scroll").execute({ ref: bad, dy: 100 });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('"ref" must look like');
    }
  });
});

// ---------------------------------------------------------------------------
// R6 — drag ref 全覆盖（两端皆元素中心原值）
// ---------------------------------------------------------------------------
describe("ω99-257 R6 — drag(startRef+endRef)：两端 argv 皆元素中心点原值", () => {
  it("captureScale=2 在场：startRef e3 + endRef e7 → argv=[100,200,500,600]（皆未被 ×2）；收据两端点名", async () => {
    const s = scaleTwo();
    const t = toolset(s);
    await find(t, "screen_capture").execute({});
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    expect(r.isError).toBeFalsy();
    const action = helperCalls(s).find((c) => c.args[0] !== "observe" && c.args.length >= 4)!;
    expect(action.args).toEqual(["100", "200", "500", "600"]); // ★两端原值直通
    expect(r.content).toContain("[e3] 图片「封面」");
    expect(r.content).toContain("[e7] 按钮「新建文件夹」");
  });

  it("button=right 照旧追加尾旗标（ref 端不扰动 button 语义）", () => {
    expect(buildDragArgs(1, 2, 3, 4, "right", 2, { x: 100, y: 200 }, { x: 500, y: 600 }))
      .toEqual({ ok: true, args: ["100", "200", "500", "600", "right"] });
  });
});

// ---------------------------------------------------------------------------
// R7 — drag 混搭（起点 ref 原值点、终点像素换算——混合主钉）
// ---------------------------------------------------------------------------
describe("ω99-257 R7 — drag(startRef+endX/endY)：两端口径各自正确", () => {
  it("captureScale=2：startRef e3 → 100,200 原值；endX/endY 400,500 → 800,1000 换算；收据起点点名、终点 (x, y) 形", async () => {
    const s = scaleTwo();
    const t = toolset(s);
    await find(t, "screen_capture").execute({});
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endX: 400, endY: 500 });
    expect(r.isError).toBeFalsy();
    const action = helperCalls(s).find((c) => c.args[0] !== "observe" && c.args.length >= 4)!;
    expect(action.args).toEqual(["100", "200", "800", "1000"]); // ★混合主钉
    expect(r.content).toContain("[e3] 图片「封面」");
    expect(r.content).toContain("(400, 500)"); // 坐标端照旧 (x, y) 形（模型量纲）
  });

  it("反混搭（startX/startY+endRef）对称：起点换算、终点原值", async () => {
    const s = scaleTwo();
    const t = toolset(s);
    await find(t, "screen_capture").execute({});
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startX: 50, startY: 60, endRef: "e7" });
    expect(r.isError).toBeFalsy();
    const action = helperCalls(s).find((c) => c.args[0] !== "observe" && c.args.length >= 4)!;
    expect(action.args).toEqual(["100", "120", "500", "600"]);
    expect(r.content).toContain("(50, 60)");
    expect(r.content).toContain("[e7] 按钮「新建文件夹」");
  });
});

// ---------------------------------------------------------------------------
// R8 — drag 校验（一端 ref 一端坐标全缺 → typed 拒零派生；非法照旧拒）
// ---------------------------------------------------------------------------
describe("ω99-257 R8 — drag 校验面（fail-closed，先于副作用）", () => {
  it("startRef 在场、终点坐标全缺 → typed 拒零派生（两端各自至少一种形式）", async () => {
    const s = seam({ observe: TABLE_WITH_AT });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("computer_drag:");
    expect(helperCalls(s).filter((c) => c.args[0] !== "observe")).toHaveLength(0); // 零派生
  });

  it("两端全缺 / 坐标非法（负数、浮点、缺席半对）照旧 typed 拒；ref 形状非法拒", async () => {
    const t = toolset(seam({ observe: TABLE_WITH_AT }));
    expect((await find(t, "computer_drag").execute({})).isError).toBe(true);
    expect((await find(t, "computer_drag").execute({ startX: -1, startY: 2, endX: 3, endY: 4 })).isError).toBe(true);
    expect((await find(t, "computer_drag").execute({ startX: 1.5, startY: 2, endX: 3, endY: 4 })).isError).toBe(true);
    const halfRef = await find(t, "computer_drag").execute({ startX: 1, endRef: "e7" }); // 坐标端半缺（无 startY）
    expect(halfRef.isError).toBe(true);
    expect((await find(t, "computer_drag").execute({ startRef: "bad", endX: 1, endY: 2 })).isError).toBe(true);
    expect((await find(t, "computer_drag").execute({ startRef: "e3", endRef: "zz", endX: 1, endY: 2 })).isError).toBe(true);
  });

  it("startRef+startX 同给 → ref 覆盖坐标（覆盖裁定）；endRef 同理", () => {
    expect(buildDragArgs(999, 999, 400, 500, undefined, 2, { x: 100, y: 200 }))
      .toEqual({ ok: true, args: ["100", "200", "800", "1000"] }); // startX/startY 被覆盖（999 弃用、未换算）
    expect(buildDragArgs(100, 200, 999, 999, undefined, 2, undefined, { x: 500, y: 600 }))
      .toEqual({ ok: true, args: ["200", "400", "500", "600"] });
  });

  it("无观察时给 ref → 「call screen_observe first」（与坐标路径独立）", async () => {
    const t = toolset(seam());
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endX: 1, endY: 2 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("No observation yet");
  });

  it("ref 不在表 → stale 文案（drag 同 click 范式）", async () => {
    const s = seam({ observe: TABLE_WITH_AT });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startX: 1, startY: 2, endRef: "e42" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not in the current observation");
    expect(r.content).toContain("call screen_observe again");
  });
});

// ---------------------------------------------------------------------------
// R9 — 收据点名（ref 端 [eN] role「title」；坐标端 (x, y) 形）
// ---------------------------------------------------------------------------
describe("ω99-257 R9 — 收据点名形", () => {
  it("scroll ref 收据：已在 [eN] 角色「标题」+方向+像素量；drag 坐标端收据照旧 (x, y) 形", async () => {
    const s = scaleTwo();
    const t = toolset(s);
    await find(t, "screen_capture").execute({});
    await find(t, "screen_observe").execute({});
    const rs = await find(t, "computer_scroll").execute({ ref: "e7", dy: 300 });
    expect(rs.content).toContain("已在 [e7] 按钮「新建文件夹」向下滚动 300 像素");
    const rd = await find(t, "computer_drag").execute({ startX: 10, startY: 20, endX: 30, endY: 40 });
    expect(rd.content).toContain("已从 (10, 20) 拖到 (30, 40)。"); // 坐标回执照报模型量纲（换算不进文案）
    const rr = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7", button: "right" });
    expect(rr.content).toContain("已从 [e3] 图片「封面」 右键拖到 [e7] 按钮「新建文件夹」。");
  });
});

// ---------------------------------------------------------------------------
// R10 — helper 源零事件自检（swiftc -parse 零产物 + hashLine 一字不动）
// ---------------------------------------------------------------------------
describe("ω99-257 R10 — helper 源自检（源级 grep 亲证）", () => {
  const swiftPath = fileURLToPath(new URL("../../../apps/desktop/src-tauri/helper/wudao-click.swift", import.meta.url));
  const read = () => readFile(swiftPath, "utf8");

  it("hashLine 一字不动（身份行逐字节同基线——位置不进身份是有意裁定）", async () => {
    const src = await read();
    expect(src).toContain(
      'let hashLine = [String(index), role, subrole ?? "", titleValue ?? "", labelValue ?? "", String(enabled ?? true), String(focused ?? false)].joined(separator: "|")',
    );
  });

  it("@cx,cy 发射在场：AXPosition/AXSize 读取 + @ 插值 + 缺席省略（诚实缺席）", async () => {
    const src = await read();
    expect(src).toContain("kAXPositionAttribute");
    expect(src).toContain("kAXSizeAttribute");
    expect(src).toContain("@\\(cx),\\(cy)");
  });

  it("scroll at 形在场 + usage/头注释同步（observe 例带 @cx,cy、scroll 带 [at]）", async () => {
    const src = await read();
    expect(src).toContain('argv[5] == "at"');
    expect(src).toContain("scroll <x> <y> <dx> <dy> [at]");
    expect(src).toContain("@cx,cy");
  });

  it("★红线：helper 源零删除面（无 FileManager/removeItem——Swift 删文件的仅有通路）", async () => {
    const src = await read();
    expect(src).not.toContain("FileManager");
    expect(src).not.toContain("removeItem");
  });

  it("swiftc -parse 语法自检 exit 0 且零产物（在场时跑；绝不编译出二进制绝不真跑）", async () => {
    let swiftc: string | undefined;
    try {
      swiftc = (await execFileAsync("xcrun", ["-f", "swiftc"])).stdout.trim();
    } catch {
      swiftc = undefined;
    }
    if (swiftc === undefined || swiftc === "") return; // 工具链缺席：源级断言已覆盖，不硬试
    const dir = swiftPath.slice(0, swiftPath.lastIndexOf("/"));
    const before = (await readdir(dir)).sort().join(",");
    const code = await execFileAsync(swiftc, ["-parse", swiftPath]).then(
      () => 0,
      (e: { code?: number }) => (typeof e.code === "number" ? e.code : -1),
    );
    expect(code).toBe(0); // exit 0（-parse 只做语法检查）
    const after = (await readdir(dir)).sort().join(",");
    expect(after).toBe(before); // 零产物：目录无新增文件
  });
});
