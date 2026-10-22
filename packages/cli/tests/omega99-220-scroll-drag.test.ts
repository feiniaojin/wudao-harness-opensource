// ω99-220: #R1 — computer_scroll / computer_drag receipts。★测试红线（212
// 既立红线的本弧延伸：滚轮与拖拽同属真键鼠禁域）：全部 mock——工具面注入
// fake ExecSeam，绝不真滚真拖，绝不编译 swift；夹具全内存零盘写零 rm。
// 三层：①纯层（buildScrollArgs 符号翻转/整数守卫/界内守卫、buildDragArgs
// 四坐标守卫）；②工具面（沿 click 面范式：argv 序列、helper 缺席降级、
// exit 2→AX 引导、code!==0 透传、平台守卫、成功回执文案）；③ask 门 +
// summarize 两例直钉（log.ts 单源，TUI 三前端共用）。
import { describe, expect, it } from "vitest";
import {
  buildScrollArgs,
  buildDragArgs,
  PERM_MARKER_ACCESSIBILITY,
  type ExecSeam,
  type ExecResult,
} from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";
import { DEFAULT_ASK_TOOLS, isDefaultAskCall } from "../src/permission.js";
import { summarizeToolCall } from "../src/log.js";

// ---------------------------------------------------------------------------
// §1 buildScrollArgs 纯层（符号翻转 + 整数/非零/界内守卫）
// ---------------------------------------------------------------------------
describe("ω99-220 §1 — buildScrollArgs 纯层", () => {
  it("dy 必填：正=向下 → helper 侧取负（wheel1 正=向上，翻转在纯层钉住）；x/y 占位 0 0（helper 解析即弃——滚轮贴系统光标）", () => {
    expect(buildScrollArgs(undefined, 300)).toEqual({ ok: true, args: ["scroll", "0", "0", "0", "-300"] });
    expect(buildScrollArgs(undefined, -200)).toEqual({ ok: true, args: ["scroll", "0", "0", "0", "200"] });
  });

  it("dx 可选：正=向右、负=向左，直传 helper（wheel2=-dx 自带翻转）；纯横滚（dy=0, dx≠0）合法", () => {
    expect(buildScrollArgs(40, 300)).toEqual({ ok: true, args: ["scroll", "0", "0", "40", "-300"] });
    expect(buildScrollArgs(-40, 0)).toEqual({ ok: true, args: ["scroll", "0", "0", "-40", "0"] });
  });

  it("整数守卫：非数值/浮点/NaN/缺席 dy typed 拒", () => {
    for (const dy of [1.5, Number.NaN, "300", null, undefined]) {
      expect(buildScrollArgs(undefined, dy).ok).toBe(false);
    }
    expect(buildScrollArgs(1.5, 300).ok).toBe(false);
  });

  it("零增量拒：dx/dy 全零（含 dy 缺席按 0）没有滚动语义", () => {
    expect(buildScrollArgs(0, 0).ok).toBe(false);
    expect(buildScrollArgs(undefined, 0).ok).toBe(false);
  });

  it("巨增量拒：|值| > 10000 拒（一屏级以上的单次滚动不可控）；恰 10000 边界过", () => {
    expect(buildScrollArgs(undefined, 10001).ok).toBe(false);
    expect(buildScrollArgs(-10001, 0).ok).toBe(false);
    expect(buildScrollArgs(undefined, 10000).ok).toBe(true);
    expect(buildScrollArgs(undefined, -10000).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §2 buildDragArgs 纯层（四坐标 validCoord 同 click 口径）
// ---------------------------------------------------------------------------
describe("ω99-220 §2 — buildDragArgs 纯层", () => {
  it("四坐标 → helper argv [x1 y1 x2 y2]；button right 追加尾旗标（沿 click 尾参口径）", () => {
    expect(buildDragArgs(100, 200, 400, 500)).toEqual({ ok: true, args: ["100", "200", "400", "500"] });
    expect(buildDragArgs(100, 200, 400, 500, "right")).toEqual({ ok: true, args: ["100", "200", "400", "500", "right"] });
    expect(buildDragArgs(0, 0, 0, 0)).toEqual({ ok: true, args: ["0", "0", "0", "0"] });
  });

  it("坐标 fail-closed：负数/浮点/NaN/非数值/缺席 typed 拒（与 click 同口径）", () => {
    for (const bad of [
      [-1, 200, 400, 500], [100, 1.5, 400, 500], [100, 200, Number.NaN, 500],
      ["100", 200, 400, 500], [100, 200, 400],
    ] as unknown[][]) {
      expect(buildDragArgs(bad[0], bad[1], bad[2], bad[3]).ok).toBe(false);
    }
  });

  it("button 只收 left/right：其他值 typed 拒", () => {
    expect(buildDragArgs(1, 2, 3, 4, "middle").ok).toBe(false);
    expect(buildDragArgs(1, 2, 3, 4, "left").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3/§4 工具面（ExecSeam 全 mock——★零真实滚轮/拖拽事件）
// ---------------------------------------------------------------------------
const recordingSeam = (result: Partial<ExecResult> = {}): ExecSeam & { calls: { file: string; args: string[] }[] } => {
  const calls: { file: string; args: string[] }[] = [];
  const seam: ExecSeam = async (file, args) => {
    calls.push({ file, args: [...args] });
    return { stdout: "", stderr: "", code: 0, ...result };
  };
  return Object.assign(seam, { calls });
};

const find = (name: string, opts: Parameters<typeof createComputerTools>[0]) =>
  createComputerTools(opts).find((t) => t.name === name)!;

describe("ω99-220 §3 — computer_scroll 工具面（mock）", () => {
  // ω99-241: #11 — 同形演进（本件两处）：成功回执尾附状态行=第二派生
  // （osascript 状态脚本）。动作仍是 helper 单发；mock stdout 空 → 状态行诚实
  // 缺席，回执单行不变。
  it("成功：helper 动作单发、argv 以 scroll 子命令形开局（坐标占位 + 翻转后的 dx/dy）；回执给方向与像素量", async () => {
    const seam = recordingSeam();
    const scroll = find("computer_scroll", { exec: seam, helperExists: () => true });
    const r = await scroll.execute({ dy: 300 });
    expect(r.isError).toBeFalsy();
    // ω99-250: #9 — 同形演进：动作前新增 settle 基线采样（observe 一次；
    // mock stdout 空 → 基线不可用 → 无 settle 行、无对比窗采样）——scroll
    // argv 顺移到 calls[1]，字节不变。
    expect(seam.calls).toHaveLength(3);
    expect(seam.calls[0]!.args[0]).toBe("observe");
    expect(seam.calls[1]!.args).toEqual(["scroll", "0", "0", "0", "-300"]);
    expect(seam.calls[2]!.file).toBe("osascript");
    expect(seam.calls[2]!.args[1]).toContain("AXFocusedUIElement");
    expect(r.content).toContain("向下");
    expect(r.content).toContain("300 像素");
    expect(r.content).not.toContain("当前状态");
  });

  it("回执方向词随符号：dy 负=向上；dx 并横滚时两个方向都给", async () => {
    const seam = recordingSeam();
    const scroll = find("computer_scroll", { exec: seam, helperExists: () => true });
    const up = await scroll.execute({ dy: -200 });
    expect(up.content).toContain("向上");
    const both = await scroll.execute({ dx: -40, dy: 300 });
    expect(both.content).toContain("向下");
    expect(both.content).toContain("向左");
  });

  it("helper 缺席 → 结构化降级错误（含 WUDAO_CLICK_HELPER 指引），零进程派生", async () => {
    const seam = recordingSeam();
    const scroll = find("computer_scroll", { exec: seam, helperExists: () => false });
    const r = await scroll.execute({ dy: 300 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("WUDAO_CLICK_HELPER");
    expect(seam.calls).toHaveLength(0);
  });

  it("exit 2 / WUDAO_AX_UNTRUSTED → 辅助功能引导标记（与 click 同款降级路径）", async () => {
    const seam = recordingSeam({ code: 2, stdout: "WUDAO_AX_UNTRUSTED" });
    const scroll = find("computer_scroll", { exec: seam, helperExists: () => true });
    const r = await scroll.execute({ dy: 300 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain(PERM_MARKER_ACCESSIBILITY);
    expect(r.content).toContain("辅助功能");
  });

  it("code!==0 → 错误透传（exit 码与 stderr 片段可见）", async () => {
    const seam = recordingSeam({ code: 3, stderr: "wudao-click: bad scroll delta x" });
    const scroll = find("computer_scroll", { exec: seam, helperExists: () => true });
    const r = await scroll.execute({ dy: 300 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exit 3");
    expect(r.content).toContain("bad scroll delta");
  });

  it("参数守卫先于副作用：巨增量/零增量/非整数 typed 拒，零派生", async () => {
    const seam = recordingSeam();
    const scroll = find("computer_scroll", { exec: seam, helperExists: () => true });
    for (const bad of [{ dy: 10001 }, { dy: 0 }, { dy: 1.5 }, {}, { dx: 40 }]) {
      const r = await scroll.execute(bad as Record<string, unknown>);
      expect(r.isError).toBe(true);
    }
    expect(seam.calls).toHaveLength(0);
  });

  it("非 darwin 平台 → typed 拒（零派生）", async () => {
    const seam = recordingSeam();
    const scroll = find("computer_scroll", { exec: seam, helperExists: () => true, platform: "linux" });
    const r = await scroll.execute({ dy: 300 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("macOS");
    expect(seam.calls).toHaveLength(0);
  });
});

describe("ω99-220 §4 — computer_drag 工具面（mock）", () => {
  it("成功：helper argv = [x1 y1 x2 y2]（无插值细节泄进工具面——插值是 helper 内部事）；回执给起点终点", async () => {
    const seam = recordingSeam();
    const drag = find("computer_drag", { exec: seam, helperExists: () => true });
    const r = await drag.execute({ startX: 100, startY: 200, endX: 400, endY: 500 });
    expect(r.isError).toBeFalsy();
    // ω99-250（续）— 同形演进（drag 面）：基线采样在前，argv 顺移 calls[1]。
    expect(seam.calls).toHaveLength(3);
    expect(seam.calls[0]!.args[0]).toBe("observe");
    expect(seam.calls[1]!.args).toEqual(["100", "200", "400", "500"]);
    expect(seam.calls[2]!.file).toBe("osascript");
    expect(seam.calls[2]!.args[1]).toContain("AXFocusedUIElement");
    expect(r.content).toContain("(100, 200)");
    expect(r.content).toContain("(400, 500)");
    expect(r.content).not.toContain("当前状态");
  });

  it("button right：尾旗标追加；回执注明右键拖", async () => {
    const seam = recordingSeam();
    const drag = find("computer_drag", { exec: seam, helperExists: () => true });
    const r = await drag.execute({ startX: 10, startY: 20, endX: 30, endY: 40, button: "right" });
    expect(seam.calls[1]!.args).toEqual(["10", "20", "30", "40", "right"]); // 基线采样后顺移（ω99-250）
    expect(r.content).toContain("右键");
  });

  it("helper 缺席 → 结构化降级（与 click/scroll 同款），零派生", async () => {
    const seam = recordingSeam();
    const drag = find("computer_drag", { exec: seam, helperExists: () => false });
    const r = await drag.execute({ startX: 1, startY: 2, endX: 3, endY: 4 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("WUDAO_CLICK_HELPER");
    expect(seam.calls).toHaveLength(0);
  });

  it("坐标 fail-closed 前置：负数/浮点/缺席 typed 拒，零派生", async () => {
    const seam = recordingSeam();
    const drag = find("computer_drag", { exec: seam, helperExists: () => true });
    for (const bad of [
      { startX: -1, startY: 2, endX: 3, endY: 4 },
      { startX: 1.5, startY: 2, endX: 3, endY: 4 },
      { startY: 2, endX: 3, endY: 4 },
      { startX: 1, startY: 2, endX: 3, endY: 4, button: "middle" },
    ]) {
      const r = await drag.execute(bad as Record<string, unknown>);
      expect(r.isError).toBe(true);
    }
    expect(seam.calls).toHaveLength(0);
  });

  it("exit 2 → 辅助功能引导标记；code!==0 → 透传", async () => {
    const ax = recordingSeam({ code: 2, stdout: "WUDAO_AX_UNTRUSTED" });
    const r1 = await find("computer_drag", { exec: ax, helperExists: () => true }).execute({ startX: 1, startY: 2, endX: 3, endY: 4 });
    expect(r1.isError).toBe(true);
    expect(r1.content).toContain(PERM_MARKER_ACCESSIBILITY);
    const bad = recordingSeam({ code: 4, stderr: "wudao-click: cannot create CGEvent" });
    const r2 = await find("computer_drag", { exec: bad, helperExists: () => true }).execute({ startX: 1, startY: 2, endX: 3, endY: 4 });
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain("exit 4");
  });

  it("非 darwin/win32 平台 → typed 拒（零派生）", async () => {
    // win32 已是合法执行面（0.3.81 执行层）——拒面改用仍未支持的 linux 钉
    // 同一意图：不支持的平台 typed 拒、零派生。
    const seam = recordingSeam();
    const drag = find("computer_drag", { exec: seam, helperExists: () => true, platform: "linux" });
    const r = await drag.execute({ startX: 1, startY: 2, endX: 3, endY: 4 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("macOS");
    expect(seam.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §5 ask 门（ω99-226 裁定后为非 auto 档问——与四动作工具同列；集合/探针钉零变）
// ---------------------------------------------------------------------------
describe("ω99-220 §5 — ask 门", () => {
  it("computer_scroll / computer_drag 进 DEFAULT_ASK_TOOLS（isDefaultAskCall 命中）；读面不进（零回归）", () => {
    expect(DEFAULT_ASK_TOOLS.has("computer_scroll")).toBe(true);
    expect(DEFAULT_ASK_TOOLS.has("computer_drag")).toBe(true);
    expect(isDefaultAskCall("computer_scroll", { dy: 300 })).toBe(true);
    expect(isDefaultAskCall("computer_drag", {})).toBe(true);
    expect(isDefaultAskCall("screen_capture", {})).toBe(false);
    expect(isDefaultAskCall("app_list", {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6 summarize 两例直钉（log.ts 单源；panel 短语=滚动了/拖动了 + 本对象）
// ---------------------------------------------------------------------------
describe("ω99-220 §6 — summarizeToolCall 两例", () => {
  it("computer_scroll -> 方向 + 像素量（dy 主向、dx 并横滚以顿号并列）；缺席/非数值回退空串不编造", () => {
    expect(summarizeToolCall("computer_scroll", { dy: 300 })).toBe("向下 300 像素");
    expect(summarizeToolCall("computer_scroll", { dy: -300 })).toBe("向上 300 像素");
    expect(summarizeToolCall("computer_scroll", { dx: 40, dy: 0 })).toBe("向右 40 像素");
    expect(summarizeToolCall("computer_scroll", { dx: -40, dy: 300 })).toBe("向下 300 像素、向左 40 像素");
    expect(summarizeToolCall("computer_scroll", {})).toBe("");
    expect(summarizeToolCall("computer_scroll", { dy: "300" })).toBe("");
  });

  it("computer_drag -> (x1, y1)→(x2, y2)（与 click 坐标同格式）；缺席/非数值回退空串", () => {
    expect(summarizeToolCall("computer_drag", { startX: 100, startY: 200, endX: 400, endY: 500 })).toBe("(100, 200)→(400, 500)");
    expect(summarizeToolCall("computer_drag", { startX: 0, startY: 0, endX: 10, endY: 10 })).toBe("(0, 0)→(10, 10)");
    expect(summarizeToolCall("computer_drag", { startX: 100, startY: 200 })).toBe("");
    expect(summarizeToolCall("computer_drag", {})).toBe("");
  });

  it("老例零漂移：click/type 既有 summary 逐字节不变（加法不改旧面）", () => {
    expect(summarizeToolCall("computer_click", { x: 512, y: 384 })).toBe("(512, 384)");
    expect(summarizeToolCall("computer_type", { text: "在备忘录记一条" })).toBe("在备忘录记一条");
  });
});
