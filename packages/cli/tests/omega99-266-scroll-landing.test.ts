// ω99-266: #2 — computer_scroll ref 路径落点身份信息行 receipts（「滚完立刻
// 知道滚轮作用在什么上」：hit 缝第四消费——261 drag→262 click ref→265 坐标→
// 266 scroll ref；expect 缺席=纯信息形——滚动必使内容位移，验证形对 scroll
// 结构性不成立）。★测试红线（212/220/241/244/247/250/257/261/262/265 既立
// 红线沿承）：ExecSeam 全 mock——绝不真键鼠/截屏/真 osascript/真 AX/真模型；
// 夹具全内存（唯一盘写=screen_capture 的假 PNG，走工具自己的 tmpdir 落点、
// 工具 finally 自清），零删除原语；读源文件是只读。
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExecSeam, ExecResult } from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";

const HELPER = "/fake/wudao-click";
const SHA_A = "a".repeat(64);

/** 观察表（257 同款带 @ 新形）：e5 列表「文件列表」中心 (371,204)。 */
const TABLE = [
  "WUDAO_OBSERVE app=Finder",
  "WUDAO_WINDOW 文件",
  '[e1] AXWindow "文件"',
  '  [e5] AXList "文件列表" @371,204',
  `WUDAO_END nodes=2 truncated=0 sha256=${SHA_A}`,
].join("\n");

/** hit 子命令的缝配置：string=命中行 stdout；Partial<ExecResult>=完整形
 *  （exit 4 未命中 / exit 3 旧 helper 拒 / exit 1 出错）。缺省=旧 helper 形
 *  exit 3（262/265 seam 同构）。 */
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

/** 一次缝四角色（265 seam 同构）：helper observe→剧本表（缺省垃圾输出=基线
 *  不可用 → 无 settle 行，回执保持现行形）/ hit→剧本 / 其余 helper 子命令
 *  （scroll 等）成功空输出；screencapture+sips 链 + JXA 主屏点可配
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
      return { stdout: "", stderr: "", code: 0 }; // scroll 等动作面
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
/** 命中行（identity=AXList「会话」——滚完落点通常是列表/滚动容器；滚入视野
 *  的新行也照报：信息形读到什么报什么，不承诺「还是原元素」）。 */
const HIT_SESSIONS = "WUDAO_HIT AXList||会话||true|false";
/** captureScale=2 的既定基准（screenW 2560 / outW 1280）——R1/R3 的「换算在
 *  场而 hit 点/at 原值不被换算」主钉前提（257 口径分轨复钉）。 */
const scaleTwo = (o: SeamOpts = {}) =>
  seam({ observe: TABLE, rawW: 2560, rawH: 1600, outW: 1280, outH: 800, screenW: 2560, screenH: 1600, ...o });

// ---------------------------------------------------------------------------
// R1 — ref 路径信息行（hit 命中 → 「落点是X。」逐字 + 时序 + at 原值直通）
// ---------------------------------------------------------------------------
describe("ω99-266 R1 — scroll(ref) 信息行", () => {
  it("hit 命中 → 回执追「落点是列表「会话」。」逐字（hitNamed 形：滚入视野的新列表照报，读到什么报什么）", async () => {
    const s = seam({ observe: TABLE, hit: HIT_SESSIONS });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_scroll").execute({ ref: "e5", dy: 300 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已在 [e5] 列表「文件列表」向下滚动 300 像素"); // 基线行字节不变（信息=纯追加）
    expect(r.content).toContain("落点是列表「会话」。"); // ★信息行逐字（hitNamed 形：角色「标题」）
    expect(hitCalls(s)).toHaveLength(1);
  });

  it("时序钉：hit 是全部 helper 调用的最后一笔（settle 采样全部完成后才命中——读的是滚后稳态）", async () => {
    const s = seam({ observe: TABLE, hit: HIT_SESSIONS });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    await find(t, "computer_scroll").execute({ ref: "e5", dy: 300 });
    const hc = helperCalls(s);
    expect(hc.at(-1)!.args[0]).toBe("hit"); // settle 之后才 hit
  });

  it("captureScale=2：hit 点=at 屏幕点原值（371,204 未被 ×2——scroll 本身不换算，观察表坐标天然屏幕点；与 265 坐标路径的换算点成对照）；scroll argv 口径主钉原样", async () => {
    const s = scaleTwo({ hit: HIT_SESSIONS });
    const t = toolset(s);
    await find(t, "screen_capture").execute({}); // 建立换算基准（scale=2）
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_scroll").execute({ ref: "e5", dy: 300 });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)).toHaveLength(1);
    expect(hitCalls(s)[0]!.args).toEqual(["hit", "371", "204"]); // ★原值直通（非 742,408）
    expect(helperCalls(s).find((c) => c.args[0] === "scroll")!.args).toEqual(["scroll", "371", "204", "0", "-600", "at"]); // 257 口径主钉零漂移
  });

  it("无标题命中 → 「落点是容器。」无「」段（缺席语义，不捏造占位）", async () => {
    const s = seam({ observe: TABLE, hit: "WUDAO_HIT AXGroup||||true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_scroll").execute({ ref: "e5", dy: 300 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("落点是容器。");
  });
});

// ---------------------------------------------------------------------------
// R2 — 未命中/降级（诚实缺席；信息行绝不 fail 滚动本身）
// ---------------------------------------------------------------------------
describe("ω99-266 R2 — 未命中与静默降级", () => {
  // ω99-269: #6 — 同形演进：miss 引导句收口（scroll 的 miss 共用态随之演
  // 进——信息形零动）；行为钉与 R4 源级两钉随词面演进（红取证
  // /tmp/o269-census.log：本件 2 测试红）。
  it("未命中（exit 4）→ miss 新引导句（observe/capture 双出路）逐字；不 isError、不猜（长滚后 hit 点脱离原窗口=诚实 miss）", async () => {
    const s = seam({ observe: TABLE, hit: { code: 4, stderr: "wudao-click: 落点无元素" } });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_scroll").execute({ ref: "e5", dy: 300 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("落点处未命中元素（可能已消失或界面已变动）——如需继续：重新 screen_observe 或 screen_capture 看清现状后再试。");
  });

  it("旧 helper（exit 3 拒）/ 出错（exit 1）/ 格式不符（空 stdout·杂物行·五段）→ 静默零行：回执保持现行形", async () => {
    for (const hit of [
      { code: 3, stderr: "wudao-click: bad coordinate hit" } as Partial<ExecResult>,
      { code: 1, stderr: "boom" } as Partial<ExecResult>,
      "" as string,
      "garbage line" as string,
      "WUDAO_HIT AXButton|sub|登录|label|true" as string, // 5 段不符形
    ]) {
      const s = seam({ observe: TABLE, hit });
      const t = toolset(s);
      await find(t, "screen_observe").execute({});
      const r = await find(t, "computer_scroll").execute({ ref: "e5", dy: 300 });
      expect(r.isError).toBeFalsy(); // ★绝不因读不到身份而失败滚动本身
      expect(r.content).toContain("已在 [e5] 列表「文件列表」向下滚动 300 像素"); // 基线行原样
      expect(r.content).not.toContain("落点"); // 静默零信息行
    }
  });
});

// ---------------------------------------------------------------------------
// R3 — 无 ref 钉（指针位置路径零 hit——无点位裁定直证；回执/argv 字节不变）
// ---------------------------------------------------------------------------
describe("ω99-266 R3 — 无 ref 路径零信息行", () => {
  it("无 ref（指针位置语义）→ 零 hit 调用（无点位裁定直证）；回执字节不变", async () => {
    const s = seam(); // observe 垃圾 → 无 settle 行 → 单行回执原形
    const r = await find(toolset(s), "computer_scroll").execute({ dy: 300 });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)).toHaveLength(0); // ★零 hit（无点位零信息行）
    expect(r.content).toBe("已向下滚动 300 像素。"); // 基线字节不变
  });

  it("无 ref + captureScale=2 → argv 字节不变（占位 0 0 + 增量换算），零 hit", async () => {
    const s = scaleTwo({ observe: "garbage not a table" });
    const t = toolset(s);
    await find(t, "screen_capture").execute({}); // 建立换算基准（scale=2）
    const r = await find(t, "computer_scroll").execute({ dy: 300 });
    expect(r.isError).toBeFalsy();
    expect(helperCalls(s).find((c) => c.args[0] === "scroll")!.args).toEqual(["scroll", "0", "0", "0", "-600"]); // 257 R4 钉原样
    expect(hitCalls(s)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R4 — 零回归钉（click ref/坐标与 drag 三调用点零改动源级钉；行为直证=
// 261/262/265 件 solo 全绿）
// ---------------------------------------------------------------------------
describe("ω99-266 R4 — 共享缝既有消费零回归（源级钉）", () => {
  const toolsSrc = () => readFileUtf8("../src/computer/tools.ts");

  it("click ref/坐标与 drag 三调用点零改动（262/265/261 原形）", async () => {
    const src = await toolsSrc();
    expect(src).toContain("await withLandingHit(receipt, at, entry)"); // click ref 消费点（262 原形）
    expect(src).toContain("await withLandingHit(receipt, { x: px, y: py })"); // click 坐标消费点（265 原形）
    expect(src).toContain("await withLandingHit(receipt, endAt, endEntry)"); // drag 消费点（261 原形）
  });

  it("四态行模板钉：不符/miss 两串为本弧演进后形（269 引导句收口——scroll 的 miss 共用态随之演进），信息/匹配两串一字不动（scroll 只消费信息形，不混装）", async () => {
    const src = await toolsSrc();
    expect(src).toContain("落点已确认：${hitNamed(a.role, a.title ?? \"\")}。");
    expect(src).toContain("——与预期的${hitNamed(expect.role, expect.title)}不符（元素表是 screen_observe 那一刻的快照，界面此后可能已变动）——如需继续：重新 screen_observe 取新编号后再试，不要用旧 ref 重试。");
    expect(src).toContain("落点处未命中元素（可能已消失或界面已变动）——如需继续：重新 screen_observe 或 screen_capture 看清现状后再试。");
    expect(src).toContain("落点是${hitNamed(a.role, a.title ?? \"\")}。"); // 信息形主句（265 原样——266 第四消费复用零改词）
  });

  it("scroll typed 出路（位置缺席）与无 ref 回执模板零演进（257 件直证的行为半边）", async () => {
    const src = await toolsSrc();
    expect(src).toContain("旧版桌面助手的观察不带位置"); // 位置缺席 typed 出路文案原样
    expect(src).toContain("已${part}。"); // 无 ref 回执模板原样
    expect(src).toContain("已在 ${named}${part}。"); // ref 回执模板原样（信息行=纯追加）
  });
});

// ---------------------------------------------------------------------------
// R5 — census 邻接零演进（源级直证；行为直证=census 件 solo 全绿——同形演
// 进记档进弧报告 §二）
// ---------------------------------------------------------------------------
describe("ω99-266 R5 — 邻接零演进（源级直证）", () => {
  it("257 argv 形零演进：buildScrollArgs 的 at 形与占位形一字不动（hit 不扰动 argv 单源）", async () => {
    const src = await readFileUtf8("../src/computer/exec.ts");
    expect(src).toContain('return { ok: true, args: ["scroll", String(at.x), String(at.y), String(sx), String(-sy), "at"] };');
    expect(src).toContain('return { ok: true, args: ["scroll", "0", "0", String(sx), String(-sy)] };');
  });

  it("220/241 无 ref 回执模板零演进：`已${part}。` 基线句由 R4 钉；`已从 ${startLabel} ${how}到 ${endLabel}。`（261/257 drag）一字不动", async () => {
    const src = await readFileUtf8("../src/computer/tools.ts");
    expect(src).toContain("`已从 ${startLabel} ${how}到 ${endLabel}。`");
  });

  it("名册与顺序零触碰（十员固定序——212/220/247/250/261/262/265 复钉）", () => {
    expect(createComputerTools().map((t) => t.name)).toEqual([
      "screen_capture", "computer_type", "computer_key", "computer_click", "app_activate", "app_list",
      "computer_scroll", "computer_drag", "screen_observe", "computer_wait",
    ]);
  });
});

// ---------------------------------------------------------------------------
// R6 — 描述句（M24：scroll 描述句首次信息行演进已声明代价——收益语言零实
// 现术语，信息≠验证）
// ---------------------------------------------------------------------------
describe("ω99-266 R6 — 描述句信息行边界声明", () => {
  it("新半句在场（收益语言）；既有句尾原样", async () => {
    const scroll = toolset(seam()).find((x) => x.name === "computer_scroll")!;
    expect(scroll.description).toContain("给 ref 时，滚完回执也会写明滚轮实际作用在什么元素上，滚错地方一眼可辨。"); // ★新半句
    expect(scroll.description).toContain("读长文可连续多次调用。"); // 既有句尾原样（新半句纯追加其后）
  });

  it("零实现术语（无 hit/WUDAO/AX）；零验证词汇（不出现「核对/验证」——信息≠验证钉）", async () => {
    const scroll = toolset(seam()).find((x) => x.name === "computer_scroll")!;
    expect(scroll.description).not.toContain("hit");
    expect(scroll.description).not.toContain("WUDAO");
    expect(scroll.description).not.toContain("AX");
    expect(scroll.description).not.toContain("核对");
    expect(scroll.description).not.toContain("验证");
  });
});

/** 读源文件（只读——绝不写绝不改）。 */
function readFileUtf8(rel: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return import("node:fs/promises").then((fs) => fs.readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
}
