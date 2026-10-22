// ω99-262: #2 — computer_click 命中验证 receipts（「点 e7」回执闭环：261 落地
// 的 hit 缝——helper hit 只读 AX 命中 + exec parseHitLine/runHit + tools 落点
// 共享缝——本弧把 click ref 路径接上：四态验证行 / 双击右键与坐标路径零
// hit / 观察表无位置静默降级 / drag 同缝零演进）。★测试红线（212/220/241/
// 244/247/250/257/261 既立红线沿承）：ExecSeam 全 mock——绝不真键鼠/截屏/
// 真 osascript/真 AX/真模型；helper 面只做源级 grep 钉（绝不编译绝不真跑）；
// 夹具全内存（唯一盘写=screen_capture 的假 PNG，走工具自己的 tmpdir 落点、
// 工具 finally 自清），零删除原语；读源文件是只读。
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExecSeam, ExecResult } from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";

const HELPER = "/fake/wudao-click";
const SHA_A = "a".repeat(64);

/** 观察表（257 新形带 @，261 同表复用）：e3 图片「封面」@100,200、e5 列表
 *  「文件列表」@371,204、e7 按钮「新建文件夹」@500,600、e11 无标题容器
 *  @10,10（R5 的空 title 比对钉）、e9 无位置（旧观察形→click 静默降级钉）。 */
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
 *  （code/stderr 自定——exit 4 未命中/exit 3 旧 helper 拒/exit 1 出错）。 */
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

/** 一次缝四角色（261 seam 同构）：helper observe→剧本表 / hit→剧本（缺省=
 *  旧 helper 形 exit 3 bad coordinate）/ 其余 helper 子命令（press 等）成功空
 *  输出；screencapture+sips 链 + JXA 主屏点可配（captureScale=2 场景）。 */
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
/** e7 的命中行（identity=AXButton「新建文件夹」——六段形，subrole/label 异值
 *  供 R5 的「不入键」钉）。 */
const HIT_E7 = "WUDAO_HIT AXButton|AXStandardButton|新建文件夹|别的标签也照match|true|false";

// ---------------------------------------------------------------------------
// R1 — click ref 命中匹配（验证行逐字 + settle 后才 hit + hit 点=click 点原值）
// ---------------------------------------------------------------------------
describe("ω99-262 R1 — click(ref) 命中匹配", () => {
  it("e7 点按 → 回执追「落点已确认：按钮「新建文件夹」。」；247 基线行字节在场；hit argv=e7 中心原值", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已点按 [e7] 按钮「新建文件夹」。"); // 247 基线形逐字
    expect(r.content).toContain("落点已确认：按钮「新建文件夹」。"); // ★验证行逐字
    expect(hitCalls(s)).toHaveLength(1);
    expect(hitCalls(s)[0]!.args).toEqual(["hit", "500", "600"]); // 落点=元素中心原值
  });

  it("时序钉：hit 在 settle 完成之后（hit 是全部 helper 调用的最后一笔，晚于所有 observe 采样）", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    await find(t, "computer_click").execute({ ref: "e7" });
    const hc = helperCalls(s);
    expect(hc.at(-1)!.args[0]).toBe("hit"); // settle 采样全部完成后才命中
    const lastObserve = hc.map((c) => c.args[0]).lastIndexOf("observe");
    expect(hc.findIndex((c) => c.args[0] === "hit")).toBeGreaterThan(lastObserve);
  });

  it("captureScale=2 在场：hit 坐标仍屏幕点原值（500,600 未被 ×2——口径分轨）", async () => {
    const s = seam({ hit: HIT_E7, rawW: 2560, rawH: 1600, outW: 1280, outH: 800, screenW: 2560, screenH: 1600 });
    const t = toolset(s);
    await find(t, "screen_capture").execute({}); // 建立换算基准（scale=2）
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)[0]!.args).toEqual(["hit", "500", "600"]); // ★hit 不碰 captureScale
  });

  it("named 收执含 both 插值现行形：ref 与坐标同给 → 坐标已忽略声明在场，默认形验证照发", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7", x: 1, y: 2 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已点按 [e7] 按钮「新建文件夹」（按 ref 点选；同时提供的坐标已忽略）。"); // both 插值现行形
    expect(r.content).toContain("落点已确认：按钮「新建文件夹」。");
  });
});

// ---------------------------------------------------------------------------
// R2 — 四态 + 观察表无位置降级（点按事实与验证结论分离——全不 isError）
// ---------------------------------------------------------------------------
describe("ω99-262 R2 — 验证四态（点按事实与验证结论分离）", () => {
  // ω99-269: #4 — 同形演进：不符/miss 两态引导句收口（回执即处方），全串
  // 钉随词面演进（红取证 /tmp/o269-census.log：本件 2 测试红——不符全串钉+
  // miss 裸句钉；「与预期的…不符」前缀钉幸存零改）。
  it("身份不符 → 诚实警示逐字（实际 vs 预期 + 重新 observe 取新编号出路）；不 isError", async () => {
    const s = seam({ hit: "WUDAO_HIT AXButton|AXStandardButton|下载|下载|true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(r.isError).toBeFalsy(); // ★点按已完成，验证只报告——绝不 isError
    expect(r.content).toContain("落点是按钮「下载」——与预期的按钮「新建文件夹」不符（元素表是 screen_observe 那一刻的快照，界面此后可能已变动）——如需继续：重新 screen_observe 取新编号后再试，不要用旧 ref 重试。");
    expect(r.content).toContain("已点按 [e7] 按钮「新建文件夹」。"); // 点按事实照报
  });

  it("未命中（exit 4）→ miss 新引导句（observe/capture 双出路）；不 isError、不猜", async () => {
    const s = seam({ hit: { code: 4, stderr: "wudao-click: 落点无元素" } });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("落点处未命中元素（可能已消失或界面已变动）——如需继续：重新 screen_observe 或 screen_capture 看清现状后再试。");
  });

  it("旧 helper（无 hit 子命令→exit 3 拒）→ 静默降级：回执保持现行形，零验证行；不 isError", async () => {
    const s = seam({ hit: { code: 3, stderr: "wudao-click: bad coordinate hit" } });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(r.isError).toBeFalsy(); // ★绝不因验证不可用而失败点按本身
    expect(r.content).toContain("已点按 [e7] 按钮「新建文件夹」。");
    expect(r.content).not.toContain("落点");
  });

  it("hit 出错（exit 1 / exit 0 但格式不符）→ 静默降级零验证行；不 isError", async () => {
    for (const hit of [{ code: 1, stderr: "boom" } as Partial<ExecResult>, "" as string]) {
      const s = seam({ hit });
      const t = toolset(s);
      await find(t, "screen_observe").execute({});
      const r = await find(t, "computer_click").execute({ ref: "e7" });
      expect(r.isError).toBeFalsy();
      expect(r.content).not.toContain("落点");
    }
  });

  it("观察表无位置（旧观察形 e9）→ 静默降级：零 hit 调用、零验证行；回执保持现行形（AXPress 不需要位置，只有验证需要）", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e9" });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)).toHaveLength(0); // 位置缺席连 hit 都不派生
    expect(r.content).toContain("已点按 [e9] 容器「无位置容器」。");
    expect(r.content).not.toContain("落点");
  });
});

// ---------------------------------------------------------------------------
// R3 — 变体钉（双击/右键零 hit——裁定直证）
// ---------------------------------------------------------------------------
describe("ω99-262 R3 — 双击/右键变体零验证", () => {
  it("ref+double:true → 零 hit 调用（右键菜单恒遮蔽落点/双击常激活落点元素=系统性假警报，裁定排除）；回执保持现行形", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7", double: true });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)).toHaveLength(0); // ★变体零 hit（裁定直证）
    expect(r.content).toContain("已点按 [e7] 按钮「新建文件夹」。");
    expect(r.content).not.toContain("落点");
  });

  it("ref+button:\"right\" → 零 hit 调用（同裁定）；回执保持现行形", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7", button: "right" });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)).toHaveLength(0);
    expect(r.content).not.toContain("落点");
  });

  it("坐标路径变体（double/right）→ 零 hit 调用；回执 how 插值现行形（双击/右键）", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const rd = await find(t, "computer_click").execute({ x: 42, y: 99, double: true });
    expect(rd.isError).toBeFalsy();
    expect(rd.content).toContain("已在 (42, 99) 双击点击。");
    const rr = await find(t, "computer_click").execute({ x: 42, y: 99, button: "right" });
    expect(rr.isError).toBeFalsy();
    expect(rr.content).toContain("已在 (42, 99) 右键点击。");
    expect(hitCalls(s)).toHaveLength(0); // 坐标路径整体零 hit（R4 同钉，变体首证）
  });
});

// ---------------------------------------------------------------------------
// R4 — 零演进钉（坐标路径零 hit；press argv 不变；click 无 startRef 混搭面）
// ---------------------------------------------------------------------------
describe("ω99-262 R4 — 坐标路径与既有形零演进", () => {
  // ω99-265: #5 — 同形演进：坐标路径接上落点身份信息行（withLandingHit 的
  // expect 缺席=信息形——无预期身份，无验证行）——「零 hit」钉演进为「恰一
  // 次 hit + 信息行」；回执基线行与 settle 行字节不变。
  it("坐标路径（无 ref）：hit 恰一次 + 信息行（无预期身份=无验证行）；回执照旧 (x, y) 形（247/212/244 断言零演进）", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ x: 42, y: 99 });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)).toHaveLength(1); // ★坐标路径恰一次 hit（无基准=坐标原值直通）
    expect(hitCalls(s)[0]!.args).toEqual(["hit", "42", "99"]);
    expect(r.content).toContain("已在 (42, 99) 左键点击。");
    expect(r.content).toContain("落点是按钮「新建文件夹」。"); // 信息行（hitNamed 形）
    expect(r.content).not.toContain("已确认"); // 无验证语（信息≠验证，不混装）
    expect(r.content).not.toContain("不符");
  });

  it("press argv 零演进：ref 路径仍 [press,7,预算三参,sha] 原值（247 复钉——验证是纯追加行）", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    await find(t, "computer_click").execute({ ref: "e7" });
    const press = helperCalls(s).find((c) => c.args[0] === "press")!;
    expect(press.args).toEqual(["press", "7", "400", "20", "24000", SHA_A]);
  });

  it("click 是单 ref 工具：schema 无 startRef/endRef（drag 的混搭面不存在于此）；参数集恰 ref/x/y/button/double", async () => {
    const click = toolset(seam()).find((x) => x.name === "computer_click")!;
    expect(Object.keys(click.parameters.properties)).toEqual(["ref", "x", "y", "button", "double"]);
    expect(click.parameters.required).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R5 — 比对键纪律（role+title；subrole/label 不入键；验证行绝不印编号）
// ---------------------------------------------------------------------------
describe("ω99-262 R5 — 比对键=role+title（验证行绝不印 [eN] 编号）", () => {
  it("同 role 异 title → 不匹配（警示态）", async () => {
    const s = seam({ hit: "WUDAO_HIT AXButton||下载|下载|true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(r.content).toContain("与预期的按钮「新建文件夹」不符");
  });

  it("同 title 异 role → 不匹配", async () => {
    const s = seam({ hit: "WUDAO_HIT AXList||新建文件夹|新建文件夹|true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(r.content).toContain("落点是列表「新建文件夹」——与预期的按钮「新建文件夹」不符");
  });

  it("subrole/label 不入键：异 subrole/异 label 但 role+title 同 → 命中确认", async () => {
    const s = seam({ hit: HIT_E7 }); // subrole=AXStandardButton、label=「别的标签也照match」
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e7" });
    expect(r.content).toContain("落点已确认：按钮「新建文件夹」。");
  });

  it("两端 title 皆缺席（e11 无标题）→ 空对空=匹配；验证行无「」段", async () => {
    const s = seam({ hit: "WUDAO_HIT AXGroup||||true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e11" });
    expect(r.content).toContain("落点已确认：容器。");
  });

  it("验证行绝不印 [eN] 编号：匹配/不匹配/未命中三态的全部「落点」行零编号（编号跨 observe 不稳定，绝不入验证面）", async () => {
    for (const hit of [HIT_E7, "WUDAO_HIT AXList||新建文件夹|新建文件夹|true|false", { code: 4, stderr: "miss" } as Partial<ExecResult>]) {
      const s = seam({ hit });
      const t = toolset(s);
      await find(t, "screen_observe").execute({});
      const r = await find(t, "computer_click").execute({ ref: "e7" });
      expect(r.isError).toBeFalsy();
      for (const line of r.content.split("\n")) {
        if (line.includes("落点")) expect(line).not.toMatch(/\[e\d+\]/); // ★验证行零编号
      }
    }
  });
});

// ---------------------------------------------------------------------------
// R6 — 复用钉（hit 缝零改动：exec 纯层 + helper 源 + tools 共享缝）
// ---------------------------------------------------------------------------
describe("ω99-262 R6 — hit 缝复用零改动（源级直证）", () => {
  const execSrc = () => readFile(fileURLToPath(new URL("../src/computer/exec.ts", import.meta.url)), "utf8");
  const toolsSrc = () => readFile(fileURLToPath(new URL("../src/computer/tools.ts", import.meta.url)), "utf8");
  const swiftSrc = () => readFile(fileURLToPath(new URL("../../../apps/desktop/src-tauri/helper/wudao-click.swift", import.meta.url)), "utf8");

  it("exec.ts 纯层零漂移：HIT_LINE 六段严格正则 + runHit argv 形一字不动（261 落地面原样）", async () => {
    const src = await execSrc();
    expect(src).toContain(
      "const HIT_LINE = /^WUDAO_HIT ([^|]+)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|(true|false)\\|(true|false)$/",
    );
    expect(src).toContain('const r = await exec(helper, ["hit", String(at.x), String(at.y)]);');
  });

  it("helper 源零触碰复用：hit 分发形 + 六段身份行构造器在场（本弧零改动消费）", async () => {
    const src = await swiftSrc();
    expect(src).toContain('argv.first == "hit" && argv.count == 3');
    expect(src).toContain("WUDAO_HIT");
  });

  it("tools.ts 共享缝在场：drag 与 click 同一缝消费（四态体零复制零漂移）", async () => {
    const src = await toolsSrc();
    // 265 同形演进（续前 #5）：expect 可选化（坐标路径信息形消费）；ref/drag
    // 两调用点位置参数零改动，行为零演进。
    expect(src).toContain("const withLandingHit = async (receipt: string, at: ScreenPoint, expect?: ObserveRefEntry): Promise<string> => {");
    expect(src).toContain("await withLandingHit(receipt, at, entry)"); // click 消费点
    expect(src).toContain("await withLandingHit(receipt, endAt, endEntry)"); // drag 消费点（零行为演进）
  });
});

// ---------------------------------------------------------------------------
// R7 — census 邻接零演进（源级直证；行为直证=solo 全绿）
// ---------------------------------------------------------------------------
describe("ω99-262 R7 — 邻接零演进（源级直证）", () => {
  const toolsSrc = () => readFile(fileURLToPath(new URL("../src/computer/tools.ts", import.meta.url)), "utf8");

  it("247/212 click 回执模板零演进：两路基线模板一字不动（验证=纯追加行）", async () => {
    const src = await toolsSrc();
    expect(src).toContain("已点按 ${named}${both}。"); // ref 路径基线（247）
    expect(src).toContain("已在 (${x}, ${y}) ${how}点击。"); // 坐标路径基线（212/244）
  });

  it("261/257 drag 基线零演进：drag 回执模板一字不动（同文件共存零扰动）", async () => {
    const src = await toolsSrc();
    expect(src).toContain("`已从 ${startLabel} ${how}到 ${endLabel}。`");
  });

  it("名册与顺序零触碰（十员固定序——212/220/247/250/261 复钉）", async () => {
    const t = toolset(seam());
    expect(t.map((x) => x.name)).toEqual([
      "screen_capture", "computer_type", "computer_key", "computer_click", "app_activate", "app_list",
      "computer_scroll", "computer_drag", "screen_observe", "computer_wait",
    ]);
  });

  it("描述句收益语言（M24 已声明代价）：点完自动核对句在场、零实现术语（无 hit/WUDAO_HIT/AX 词汇）", async () => {
    const click = toolset(seam()).find((x) => x.name === "computer_click")!;
    expect(click.description).toContain("自动核对");
    expect(click.description).toContain("不必再截一张图确认有没有点中");
    expect(click.description).not.toContain("hit");
    expect(click.description).not.toContain("WUDAO");
    expect(click.description).not.toContain("AX");
  });
});
