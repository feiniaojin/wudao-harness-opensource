// ω99-269: #2 — 落点验证不符/未命中态的引导句 receipts（266 池 #1——hit 四态
// 里不符态的引导原是半句「可 screen_observe 复核」（复核之后干什么没说）、
// miss 态零引导（句号即终点），本弧把两态尾段换成完整出路=回执即处方：不符
// →重新 observe 取新编号（旧 ref 属旧快照，247 编号跨 observe 不稳定纪律的
// 用户语）；miss→ref 族 observe/坐标族 capture 双出路（265 坐标路径同落此
// 态）。匹配/信息两态零动（确认/报态无错可纠，加句是噪音）。★测试红线
// （212/220/241/244/247/250/257/261/262/265/266 既立红线沿承）：ExecSeam 全
// mock——绝不真键鼠/截屏/真 osascript/真 AX/真模型；夹具全内存（唯一盘写=
// screen_capture 的假 PNG，走工具自己的 tmpdir 落点、工具 finally 自清），零
// 删除原语；读源文件是只读。
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExecSeam, ExecResult } from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";

const HELPER = "/fake/wudao-click";
const SHA_A = "a".repeat(64);

/** 观察表（262 同款带 @ 新形）：e3 图片「封面」@100,200、e5 列表「文件列表」
 *  @371,204、e7 按钮「新建文件夹」@500,600、e11 无标题容器 @10,10、e9 无位置
 *  （旧观察形）。四消费面共用一张表（click ref/drag endRef/scroll ref 都有
 *  落点；坐标路径不需要表）。 */
const TABLE_WITH_AT = [
  "WUDAO_OBSERVE app=Finder",
  "WUDAO_WINDOW 文件",
  '[e1] AXWindow "文件"',
  '  [e3] AXImage "封面" @100,200',
  '  [e5] AXList "文件列表" @371,204',
  '  [e7] AXButton "新建文件夹" @500,600',
  "  [e11] AXGroup @10,10",
  "  [e9] AXGroup \"无位置容器\"",
  `WUDAO_END nodes=7 truncated=0 sha256=${SHA_A}`,
].join("\n");

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

/** 一次缝四角色（262 seam 同构）：helper observe→剧本表 / hit→剧本 / 其余
 *  helper 子命令（press 等）成功空输出；screencapture+sips 链 + JXA 主屏点
 *  可配（captureScale=2 场景）。 */
const seam = (o: SeamOpts = {}): ExecSeam & { calls: { file: string; args: string[] }[] } => {
  const calls: { file: string; args: string[] }[] = [];
  let resized = false;
  const s: ExecSeam = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === HELPER) {
      if (args[0] === "observe") return { stdout: o.observe ?? TABLE_WITH_AT, stderr: "", code: 0 };
      if (args[0] === "hit") {
        return typeof o.hit === "string"
          ? { stdout: `${o.hit}\n`, stderr: "", code: 0 }
          : { stdout: "", stderr: "", code: 0, ...o.hit };
      }
      return { stdout: "", stderr: "", code: 0 }; // press/drag/scroll 等动作面
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
/** 抽回执里的「落点」行（每态恰一行；数组 toEqual=字节级精确钉，settle/状态
 *  行天然不入列——状态行「当前状态：」起、settle 行「界面…」起）。 */
const landingLines = (content: string): string[] => content.split("\n").filter((l) => l.startsWith("落点"));

/** 不符态新词面（需求书「关键裁定」逐字；X/Y=hitNamed 插值两槽）。 */
const MISMATCH_LINE = "落点是按钮「下载」——与预期的按钮「新建文件夹」不符（元素表是 screen_observe 那一刻的快照，界面此后可能已变动）——如需继续：重新 screen_observe 取新编号后再试，不要用旧 ref 重试。";
/** miss 态新词面（两类成因都给出路：ref 族 observe、坐标族 capture）。 */
const MISS_LINE = "落点处未命中元素（可能已消失或界面已变动）——如需继续：重新 screen_observe 或 screen_capture 看清现状后再试。";

// ---------------------------------------------------------------------------
// R1 — 不符态新句逐字（click ref 路径；旧半句「可 screen_observe 复核」退场）
// ---------------------------------------------------------------------------
describe("ω99-269 R1 — 不符态引导句（处方=重新 observe 取新编号）", () => {
  it("落点≠预期 → 新词面全文逐字（两处 hitNamed 插值：实际=按钮「下载」、预期=按钮「新建文件夹」）；旧句段不再出现；不 isError", async () => {
    const s = seam({ hit: "WUDAO_HIT AXButton|AXStandardButton|下载|下载|true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(r.isError).toBeFalsy(); // ★点按事实与验证结论分列（251/261 纪律沿承）
    expect(landingLines(r.content)).toEqual([MISMATCH_LINE]); // ★新词面全文（含两处插值）
    expect(r.content).not.toContain("可 screen_observe 复核"); // 旧半句（复核之后干什么没说）退场
    expect(r.content).toContain("已点按 [e7] 按钮「新建文件夹」。"); // 点按事实照报
  });

  it("同 title 异 role 形 → 新词面两插值槽各自渲染（实际=列表「新建文件夹」、预期=按钮「新建文件夹」）", async () => {
    const s = seam({ hit: "WUDAO_HIT AXList||新建文件夹|新建文件夹|true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(r.isError).toBeFalsy();
    expect(landingLines(r.content)).toEqual([
      "落点是列表「新建文件夹」——与预期的按钮「新建文件夹」不符（元素表是 screen_observe 那一刻的快照，界面此后可能已变动）——如需继续：重新 screen_observe 取新编号后再试，不要用旧 ref 重试。",
    ]);
  });
});

// ---------------------------------------------------------------------------
// R2 — miss 态新句逐字（drag endRef 路径；旧裸句「落点处未命中元素。」退场）
// ---------------------------------------------------------------------------
describe("ω99-269 R2 — miss 态引导句（双出路=observe 或 capture）", () => {
  it("drag endRef exit 4 → 新词面全文逐字；旧裸句（句号即终点形）不再出现；不 isError", async () => {
    const s = seam({ hit: { code: 4, stderr: "wudao-click: 落点无元素" } });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    expect(r.isError).toBeFalsy();
    expect(landingLines(r.content)).toEqual([MISS_LINE]); // ★miss 新词面全文
    expect(r.content).not.toContain("落点处未命中元素。"); // 旧裸句退场
    expect(r.content).toContain("已从 [e3] 图片「封面」 拖到 [e7] 按钮「新建文件夹」。"); // 拖拽事实照报
  });
});

// ---------------------------------------------------------------------------
// R3 — 零漂钉（匹配/信息两态 toBe 字节不变；降级态零行不变）
// ---------------------------------------------------------------------------
describe("ω99-269 R3 — 匹配/信息/降级零漂", () => {
  it("匹配态字节不变：click ref 落点=预期 → 「落点已确认：X。」现行串逐字（named 形+空 title 形两钉，各起独立缝——hit 剧本与位置无关）", async () => {
    const s7 = seam({ hit: "WUDAO_HIT AXButton|AXStandardButton|新建文件夹|别的标签也照match|true|false" });
    const t7 = toolset(s7);
    await find(t7, "screen_observe").execute({});
    const r7 = await find(t7, "computer_click").execute({ ref: "e7" });
    expect(landingLines(r7.content)).toEqual(["落点已确认：按钮「新建文件夹」。"]); // 现行串逐字（防手滑）
    const s11 = seam({ hit: "WUDAO_HIT AXGroup||||true|false" }); // e11 无标题（空对空=匹配）
    const t11 = toolset(s11);
    await find(t11, "screen_observe").execute({});
    const r11 = await find(t11, "computer_click").execute({ ref: "e11" });
    expect(landingLines(r11.content)).toEqual(["落点已确认：容器。"]); // 无「」段（缺席语义）
  });

  it("信息态字节不变：坐标路径与 scroll ref 的「落点是X。」现行串逐字（:770 零动行——共享 try 块不受本弧影响）", async () => {
    const s = seam({ observe: "garbage not a table", hit: "WUDAO_HIT AXButton|AXStandardButton|登录|登录|true|false" });
    const r = await find(toolset(s), "computer_click").execute({ x: 7, y: 8 });
    expect(r.content).toBe("已在 (7, 8) 左键点击。\n落点是按钮「登录」。"); // 坐标路径全回执逐字（observe 垃圾=零 settle 行）
    const s2 = seam({ hit: "WUDAO_HIT AXList||文件列表|文件列表|true|false" });
    const t2 = toolset(s2);
    await find(t2, "screen_observe").execute({});
    const rs = await find(t2, "computer_scroll").execute({ ref: "e5", dy: 300 });
    expect(landingLines(rs.content)).toEqual(["落点是列表「文件列表」。"]); // scroll 信息形现行串逐字
  });

  it("降级态零行不变：旧 helper（exit 3 拒）→ 零落点行，回执保持既有形", async () => {
    const s = seam({ hit: { code: 3, stderr: "wudao-click: bad coordinate hit" } });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(r.isError).toBeFalsy();
    expect(landingLines(r.content)).toEqual([]); // ★静默降级零验证行（257 形零断崖）
    expect(r.content).toContain("已点按 [e7] 按钮「新建文件夹」。");
  });
});

// ---------------------------------------------------------------------------
// R4 — 四消费面行为直证（一处改全员受益——261 drag/262 click ref/265 坐标/
// 266 scroll；既有件全绿=solo 记档）
// ---------------------------------------------------------------------------
describe("ω99-269 R4 — 四消费面共享缝直证", () => {
  it("drag（261 面）：endRef 不符 → 同一新句流到 drag 回执", async () => {
    const s = seam({ hit: "WUDAO_HIT AXButton|AXStandardButton|下载|下载|true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    expect(r.isError).toBeFalsy();
    expect(landingLines(r.content)).toEqual([MISMATCH_LINE]); // 与 R1 click ref 同句（共享缝零分叉）
  });

  it("click ref（262 面）：miss → 新 miss 句流到 click ref 路径", async () => {
    const s = seam({ hit: { code: 4, stderr: "wudao-click: 落点无元素" } });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(landingLines(r.content)).toEqual([MISS_LINE]);
  });

  it("click 坐标（265 面）：miss → 新 miss 句流到坐标路径（坐标族成因的出路=capture 在句内）", async () => {
    const s = seam({ observe: "garbage not a table", hit: { code: 4, stderr: "wudao-click: 落点无元素" } });
    const r = await find(toolset(s), "computer_click").execute({ x: 7, y: 8 });
    expect(landingLines(r.content)).toEqual([MISS_LINE]); // 265 坐标路径同落 miss 态（R 钉行为面）
  });

  it("scroll ref（266 面）：miss → 新 miss 句流到 scroll 回执（miss/降级共用态）；信息形现行串逐字零动", async () => {
    const s = seam({ hit: { code: 4, stderr: "wudao-click: 落点无元素" } });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_scroll").execute({ ref: "e5", dy: 300 });
    expect(landingLines(r.content)).toEqual([MISS_LINE]); // scroll miss 共用态（R5 钉行为面）
    const s2 = seam({ hit: "WUDAO_HIT AXList||文件列表|文件列表|true|false" });
    const t2 = toolset(s2);
    await find(t2, "screen_observe").execute({});
    const r2 = await find(t2, "computer_scroll").execute({ ref: "e5", dy: 300 });
    expect(landingLines(r2.content)).toEqual(["落点是列表「文件列表」。"]); // 信息形（:770 零动行）
  });
});

// ---------------------------------------------------------------------------
// R5 — census 源级钉（withLandingHit 结构零动=只两模板串变；描述句族零混入）
// ---------------------------------------------------------------------------
describe("ω99-269 R5 — 源级结构与词域门", () => {
  const toolsSrc = () => readFileUtf8("../src/computer/tools.ts");

  it("withLandingHit 结构零动：签名/runHit/静默降级/三消费点原形在场；新两串在场、旧两串退场（只两模板串变）", async () => {
    const src = await toolsSrc();
    expect(src).toContain('const withLandingHit = async (receipt: string, at: ScreenPoint, expect?: ObserveRefEntry): Promise<string> => {');
    expect(src).toContain("const read = await runHit(exec, helper, at);");
    expect(src).toContain("if (read === undefined) return receipt;");
    expect(src).toContain("await withLandingHit(receipt, at, entry)"); // click ref 消费点（262 原形）
    expect(src).toContain("await withLandingHit(receipt, { x: px, y: py })"); // click 坐标消费点（265 原形）
    expect(src).toContain("await withLandingHit(receipt, endAt, endEntry)"); // drag 消费点（261 原形）
    // 新两串（源级逐字——与回执行为面 R1/R2 同句）：
    expect(src).toContain("落点处未命中元素（可能已消失或界面已变动）——如需继续：重新 screen_observe 或 screen_capture 看清现状后再试。");
    expect(src).toContain("——与预期的${hitNamed(expect.role, expect.title)}不符（元素表是 screen_observe 那一刻的快照，界面此后可能已变动）——如需继续：重新 screen_observe 取新编号后再试，不要用旧 ref 重试。");
    // 零动两串（匹配/信息——R3 行为半边的源级钉）：
    expect(src).toContain('落点已确认：${hitNamed(a.role, a.title ?? "")}。');
    expect(src).toContain('落点是${hitNamed(a.role, a.title ?? "")}。');
    // 旧两串退场（模板形定向——:590 注释里的引文不受此钉约束）：
    expect(src).not.toContain("可 screen_observe 复核");
    expect(src).not.toContain("\\n落点处未命中元素。"); // 反斜杠 n=模板串原始形
  });

  it("描述句族零混入：十工具描述句零命中「如需继续」（处方词域只属回执，不进工具列——M24 零模型侧字节）", async () => {
    for (const tool of toolset(seam())) {
      expect(tool.description).not.toContain("如需继续");
    }
  });
});

/** 读源文件（只读——绝不写绝不改）。 */
function readFileUtf8(rel: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return import("node:fs/promises").then((fs) => fs.readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
}
