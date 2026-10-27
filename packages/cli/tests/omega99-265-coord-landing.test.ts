// ω99-265: #2 — computer_click 坐标路径落点身份信息行 receipts（「点完立刻
// 知道点中了什么」：261 落地、262 ref 消费的 hit 缝第三消费——expect 缺席 =
// 纯信息形，无匹配/不符态）。★测试红线（212/220/241/244/247/250/257/261/
// 262 既立红线沿承）：ExecSeam 全 mock——绝不真键鼠/截屏/真 osascript/真 AX/
// 真模型；夹具全内存（唯一盘写=screen_capture 的假 PNG，走工具自己的 tmpdir
// 落点、工具 finally 自清），零删除原语；读源文件是只读。
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExecSeam, ExecResult } from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";

const HELPER = "/fake/wudao-click";

/** hit 子命令的缝配置：string=命中行 stdout；Partial<ExecResult>=完整形
 *  （exit 4 未命中 / exit 3 旧 helper 拒 / exit 1 出错）。缺省=旧 helper 形
 *  exit 3（262 seam 同构）。 */
type HitScript = string | Partial<ExecResult>;

interface SeamOpts {
  readonly observe?: string;
  readonly hit?: HitScript;
  readonly rawW?: number;
  readonly rawH?: number;
  readonly outW?: number;
  readonly outH?: number;
  readonly screenW?: number;
  readonly screenH?: number;
}

/** 一次缝四角色（262 seam 同构）：helper observe→剧本表（缺省垃圾输出=基线
 *  不可用 → 无 settle 行，坐标回执保持单行原形）/ hit→剧本 / 其余 helper 子
 *  命令（press 等）成功空输出；screencapture+sips 链 + JXA 主屏点可配
 *  （captureScale=2 场景）。 */
const seam = (o: SeamOpts = {}): ExecSeam & { calls: { file: string; args: string[] }[] } => {
  const calls: { file: string; args: string[] }[] = [];
  let resized = false;
  const s: ExecSeam = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === HELPER) {
      if (args[0] === "observe") return { stdout: o.observe ?? "garbage not a table", stderr: "", code: 0 };
      if (args[0] === "hit") {
        return typeof o.hit === "string"
          ? { stdout: `${o.hit}\n`, stderr: "", code: 0 }
          : { stdout: "", stderr: "", code: 0, ...o.hit };
      }
      return { stdout: "", stderr: "", code: 0 }; // press 等动作面
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
    return { stdout: "", stderr: "", code: 0 }; // 状态行 osascript：锚缺席=诚实缺席
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
  createComputerTools({
    exec: s, platform: "darwin", env: { WUDAO_CLICK_HELPER: HELPER }, helperExists: () => true,
    vision: fakeVision(), sleep: async () => {},
  });
const find = (t: ReturnType<typeof createComputerTools>, name: string) => t.find((x) => x.name === name)!;
const helperCalls = (s: { calls: { file: string; args: string[] }[] }) => s.calls.filter((c) => c.file === HELPER);
const hitCalls = (s: { calls: { file: string; args: string[] }[] }) => helperCalls(s).filter((c) => c.args[0] === "hit");
/** 命中行（identity=AXButton「登录」——坐标路径的模型没有预期身份，读到什
 *  么就报什么）。 */
const HIT_LOGIN = "WUDAO_HIT AXButton|AXStandardButton|登录|登录|true|false";

// ---------------------------------------------------------------------------
// R1 — 坐标单击信息行（hit 命中 → 「落点是X。」逐字 + 时序 + 换算点）
// ---------------------------------------------------------------------------
describe("ω99-265 R1 — 坐标单击信息行", () => {
  it("hit 命中 → 回执追「落点是按钮「登录」。」逐字；无基准 hit argv=坐标原值直通", async () => {
    const s = seam({ hit: HIT_LOGIN });
    const r = await find(toolset(s), "computer_click").execute({ x: 42, y: 99 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已在 (42, 99) 左键点击。"); // 基线行字节不变（信息=纯追加）
    expect(r.content).toContain("落点是按钮「登录」。"); // ★信息行逐字（hitNamed 形：角色「标题」）
    expect(hitCalls(s)).toHaveLength(1);
    expect(hitCalls(s)[0]!.args).toEqual(["hit", "42", "99"]); // 无基准=直通
  });

  it("时序钉：hit 是全部 helper 调用的最后一笔（settle 采样全部完成后才命中）", async () => {
    const s = seam({ hit: HIT_LOGIN });
    await find(toolset(s), "computer_click").execute({ x: 42, y: 99 });
    const hc = helperCalls(s);
    expect(hc.at(-1)!.args[0]).toBe("hit"); // settle 之后才 hit（读的是稳态）
  });

  it("captureScale=2：hit 点=换算点（与 click argv 同值——click 发生在哪 hit 就问哪；模型 640,400 → 屏幕 1280,800）", async () => {
    const s = seam({ hit: HIT_LOGIN, rawW: 2560, rawH: 1600, outW: 1280, outH: 800, screenW: 2560, screenH: 1600 });
    const t = toolset(s);
    await find(t, "screen_capture").execute({}); // 建立换算基准（scale=2）
    const r = await find(t, "computer_click").execute({ x: 640, y: 400 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已在 (640, 400) 左键点击。"); // 回执照报模型坐标
    expect(hitCalls(s)).toHaveLength(1);
    expect(hitCalls(s)[0]!.args).toEqual(["hit", "1280", "800"]); // ★换算点（与 ref 路径原值直通不同：click 本身就在换算点发生）
  });

  it("无标题命中 → 「落点是容器。」无「」段（缺席语义，不捏造占位）", async () => {
    const s = seam({ hit: "WUDAO_HIT AXGroup||||true|false" });
    const r = await find(toolset(s), "computer_click").execute({ x: 10, y: 10 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("落点是容器。");
  });
});

// ---------------------------------------------------------------------------
// R2 — 未命中/降级（诚实缺席；信息行绝不 fail 点击本身）
// ---------------------------------------------------------------------------
describe("ω99-265 R2 — 未命中与静默降级", () => {
  // ω99-269: #5 — 同形演进：miss 引导句收口（坐标路径同落此态——句内
  // capture 即坐标族出路）；行为钉与 R4 源级两钉随词面演进（红取证
  // /tmp/o269-census.log：本件 2 测试红）。
  it("未命中（exit 4）→ miss 新引导句（observe/capture 双出路）逐字；不 isError、不猜", async () => {
    const s = seam({ hit: { code: 4, stderr: "wudao-click: 落点无元素" } });
    const r = await find(toolset(s), "computer_click").execute({ x: 42, y: 99 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("落点处未命中元素（可能已消失或界面已变动）——如需继续：重新 screen_observe 或 screen_capture 看清现状后再试。");
  });

  it("旧 helper（exit 3 拒）/ 出错（exit 1）/ 格式不符（空 stdout·杂物行）→ 静默零行：回执保持现行单行形", async () => {
    for (const hit of [
      { code: 3, stderr: "wudao-click: bad coordinate hit" } as Partial<ExecResult>,
      { code: 1, stderr: "boom" } as Partial<ExecResult>,
      "" as string,
      "WUDAO_HIT AXButton|sub|登录|label|true" as string, // 5 段不符形
    ]) {
      const s = seam({ hit });
      const r = await find(toolset(s), "computer_click").execute({ x: 7, y: 8 });
      expect(r.isError).toBeFalsy(); // ★绝不因读不到身份而失败点击本身
      expect(r.content).toBe("已在 (7, 8) 左键点击。"); // 基线单行原样（observe 垃圾 → 无 settle 行）
    }
  });
});

// ---------------------------------------------------------------------------
// R3 — 变体钉（右键/双击零 hit——裁定直证：落点常被遮蔽/激活改变，读遮罩
// 物=噪音非信息）
// ---------------------------------------------------------------------------
describe("ω99-265 R3 — 双击/右键变体零信息行", () => {
  it("坐标+button:\"right\" → 零 hit 调用；回执 how 插值现行形", async () => {
    const s = seam({ hit: HIT_LOGIN });
    const r = await find(toolset(s), "computer_click").execute({ x: 42, y: 99, button: "right" });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)).toHaveLength(0); // ★变体零 hit（裁定直证）
    expect(r.content).toContain("已在 (42, 99) 右键点击。");
    expect(r.content).not.toContain("落点");
  });

  it("坐标+double:true → 零 hit 调用；回执 how 插值现行形", async () => {
    const s = seam({ hit: HIT_LOGIN });
    const r = await find(toolset(s), "computer_click").execute({ x: 42, y: 99, double: true });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)).toHaveLength(0);
    expect(r.content).toContain("已在 (42, 99) 双击点击。");
    expect(r.content).not.toContain("落点");
  });
});

// ---------------------------------------------------------------------------
// R4 — 零回归钉（ref/drag 两调用点零改动源级钉；行为直证=261/262 件 solo 全绿）
// ---------------------------------------------------------------------------
describe("ω99-265 R4 — 共享缝扩展零回归（源级钉）", () => {
  const toolsSrc = () => readFileUtf8("../src/computer/tools.ts");

  it("withLandingHit 两调用点零改动：ref 路径与 drag 终点仍位置参数原形（expect 可选化不影响既有消费）", async () => {
    const src = await toolsSrc();
    expect(src).toContain("await withLandingHit(receipt, at, entry)"); // click ref 消费点（262 原形）
    expect(src).toContain("await withLandingHit(receipt, endAt, endEntry)"); // drag 消费点（261 原形）
  });

  it("四态行模板钉：不符/miss 两串为本弧演进后形（269 引导句收口），匹配/信息两串一字不动（ref=验证、坐标=信息——同缝两种诚实形态不混装）", async () => {
    const src = await toolsSrc();
    expect(src).toContain("落点已确认：${hitNamed(a.role, a.title ?? \"\")}。");
    expect(src).toContain("——与预期的${hitNamed(expect.role, expect.title)}不符（元素表是 screen_observe 那一刻的快照，界面此后可能已变动）——如需继续：重新 screen_observe 取新编号后再试，不要用旧 ref 重试。");
    expect(src).toContain("落点处未命中元素（可能已消失或界面已变动）——如需继续：重新 screen_observe 或 screen_capture 看清现状后再试。");
  });
});

// ---------------------------------------------------------------------------
// R5 — census 邻接零演进（源级直证；行为直证=census 件 solo 全绿——同形演
// 进记档进弧报告 §二）
// ---------------------------------------------------------------------------
describe("ω99-265 R5 — 邻接零演进（源级直证）", () => {
  const toolsSrc = () => readFileUtf8("../src/computer/tools.ts");

  it("241/212/244 坐标回执模板零演进：`已在 (${x}, ${y}) ${how}点击。` 一字不动（信息行=纯追加）", async () => {
    const src = await toolsSrc();
    expect(src).toContain("已在 (${x}, ${y}) ${how}点击。");
  });

  it("247 ref 回执模板零演进：`已点按 ${named}${both}。` 一字不动", async () => {
    const src = await toolsSrc();
    expect(src).toContain("已点按 ${named}${both}。");
  });

  it("261/257 drag 回执模板零演进：`已从 ${startLabel} ${how}到 ${endLabel}。` 一字不动", async () => {
    const src = await toolsSrc();
    expect(src).toContain("`已从 ${startLabel} ${how}到 ${endLabel}。`");
  });

  it("名册与顺序零触碰（十员固定序——212/220/247/250/261/262 复钉）", () => {
    expect(createComputerTools().map((t) => t.name)).toEqual([
      "screen_capture", "computer_type", "computer_key", "computer_click", "app_activate", "app_list",
      "computer_scroll", "computer_drag", "screen_observe", "computer_wait",
    ]);
  });
});

// ---------------------------------------------------------------------------
// R6 — 描述句（M24：第二次演进已声明代价——统一边界声明，收益语言零实现术语）
// ---------------------------------------------------------------------------
describe("ω99-265 R6 — 描述句统一边界声明", () => {
  it("新句在场：坐标单击回报句 + 双击/右键不回报；262 的 ref 句两处钉原样在场", async () => {
    const click = toolset(seam()).find((x) => x.name === "computer_click")!;
    expect(click.description).toContain("按坐标单击时，回执同样会写明落点处是什么元素"); // ★新句（收益语言）
    expect(click.description).toContain("双击/右键不回报"); // 统一边界声明（替「双击/右键不核对」）
    expect(click.description).toContain("自动核对"); // 262 钉原样
    expect(click.description).toContain("不必再截一张图确认有没有点中"); // 262 钉原样
  });

  it("零实现术语：无 hit/WUDAO/AX 词汇（收益语言钉）", async () => {
    const click = toolset(seam()).find((x) => x.name === "computer_click")!;
    expect(click.description).not.toContain("hit");
    expect(click.description).not.toContain("WUDAO");
    expect(click.description).not.toContain("AX");
  });
});

/** 读源文件（只读——绝不写绝不改）。 */
function readFileUtf8(rel: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return import("node:fs/promises").then((fs) => fs.readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
}
