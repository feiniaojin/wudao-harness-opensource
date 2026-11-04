// ω99-261: #4 — computer_drag 终点语义目标验证 receipts（「拖到 e7 上」回执
// 闭环：helper hit 只读 AX 命中 → exec parseHitLine/runHit → drag 仅 endRef 路
// 径四态验证行）。★测试红线（212/220/241/244/247/250/257 既立红线沿承）：
// ExecSeam 全 mock——绝不真键鼠/截屏/真 osascript/真 AX/真模型；helper 面只做
// 源级 grep 钉 + swiftc -parse 语法自检零产物（绝不编译出二进制绝不真跑）；
// 夹具全内存（唯一盘写=screen_capture 的假 PNG，走工具自己的 tmpdir 落点、
// 工具 finally 自清），零 rm/unlink；读源文件是只读。
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  parseHitLine,
  runHit,
  type ExecSeam,
  type ExecResult,
} from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";

const execFileAsync = promisify(execFile);
const HELPER = "/fake/wudao-click";
const SHA_A = "a".repeat(64);

/** 观察表（257 新形带 @）：e3 图片「封面」@100,200、e5 列表「文件列表」
 *  @371,204、e7 按钮「新建文件夹」@500,600、e11 无标题容器 @10,10（R6 的
 *  空 title 比对钉）、e9 无位置（旧 helper 过渡形）。 */
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

/** 一次缝四角色（257 seam + hit 分支）：helper observe→剧本表 / hit→剧本
 *  （缺省=旧 helper 形 exit 3 bad coordinate）/ 其余 helper 子命令（drag 等）
 *  成功空输出；screencapture+sips 链 + JXA 主屏点可配（captureScale=2 场景）。 */
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
      return { stdout: "", stderr: "", code: 0 }; // drag 等动作面
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
 *  供 R6 的「不入键」钉）。 */
const HIT_E7 = "WUDAO_HIT AXButton|AXStandardButton|新建文件夹|别的标签也照match|true|false";

// ---------------------------------------------------------------------------
// R1 — helper 面（源级 grep 钉 + swiftc -parse 零产物；绝不真跑）
// ---------------------------------------------------------------------------
describe("ω99-261 R1 — helper hit 子命令源钉（只读 AX 命中）", () => {
  const swiftPath = fileURLToPath(new URL("../../../apps/desktop/src-tauri/helper/wudao-click.swift", import.meta.url));
  const read = () => readFile(swiftPath, "utf8");

  it("AXUIElementCopyElementAtPosition 在场 + hit 分发形（argv.count==3）+ usage 同步", async () => {
    const src = await read();
    expect(src).toContain("AXUIElementCopyElementAtPosition");
    expect(src).toContain('argv.first == "hit" && argv.count == 3');
    expect(src).toContain("hit <x> <y>");
  });

  it("六段身份行构造在场（WUDAO_HIT role|subrole|title|label|enabled|focused——hashLine 同族减 index）", async () => {
    const src = await read();
    expect(src).toContain('print("WUDAO_HIT \\(role)|\\(subrole)|\\(hitTitle)|\\(hitLabel)|\\(enabled ? "true" : "false")|\\(focused ? "true" : "false")")');
  });

  it("未命中→exit 4（「落点无元素」）；坐标非法→exit 3 沿 coord() 惯例", async () => {
    const src = await read();
    expect(src).toContain('fail("wudao-click: 落点无元素", 4)');
    expect(src).toContain("coord(argv[1])");
  });

  it("★红线沿承：helper 源零删除面（无 FileManager/removeItem）", async () => {
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
  }, 30_000); // 30s：xcrun+swiftc 冷启动在并行负载下常超默认 5s（CI 揭发）
});

// ---------------------------------------------------------------------------
// R2 — exec 面（parseHitLine 全形 + runHit argv 钉）
// ---------------------------------------------------------------------------
describe("ω99-261 R2 — parseHitLine / runHit", () => {
  it("六段全形 → {role, subrole, title, label, enabled, focused}", () => {
    expect(parseHitLine("WUDAO_HIT AXButton|AXStandardButton|上传|上传|true|false\n")).toEqual({
      role: "AXButton", subrole: "AXStandardButton", title: "上传", label: "上传", enabled: true, focused: false,
    });
  });

  it("可选段缺席（空串）→ undefined（诚实缺席，不是空串占位）", () => {
    expect(parseHitLine("WUDAO_HIT AXGroup||||false|true")).toEqual({
      role: "AXGroup", enabled: false, focused: true,
    });
  });

  it("不符形 → null：缺前缀/段数缺/段数多/布尔脏/空串/杂音", () => {
    expect(parseHitLine("AXButton||上传||true|false")).toBeNull(); // 缺 WUDAO_HIT 前缀
    expect(parseHitLine("WUDAO_HIT AXButton|sub|上传|label|true")).toBeNull(); // 5 段
    expect(parseHitLine("WUDAO_HIT AXButton|sub|上传|label|true|false|extra")).toBeNull(); // 7 段
    expect(parseHitLine("WUDAO_HIT AXButton|sub|上传|label|maybe|false")).toBeNull(); // 布尔脏
    expect(parseHitLine("")).toBeNull();
    expect(parseHitLine("WUDAO_HIT |||x|true|false")).toBeNull(); // role 段空（AXUnknown 兜底后不该出现）
  });

  it("runHit argv 钉：[\"hit\", x, y] 屏幕点原值直通（绝无 captureScale 换算）", async () => {
    const s = seam({ hit: HIT_E7 });
    const read = await runHit(s, HELPER, { x: 1234, y: 567 });
    expect(read).toEqual({ kind: "hit", identity: parseHitLine(HIT_E7) });
    expect(hitCalls(s)).toHaveLength(1);
    expect(hitCalls(s)[0]!.args).toEqual(["hit", "1234", "567"]); // ★原值直通钉
  });

  it("runHit 状态映射：exit 4=miss；exit 3（旧 helper 拒）/exit 0 但格式不符/exit 2=undefined", async () => {
    expect(await runHit(seam({ hit: { code: 4, stderr: "wudao-click: 落点无元素" } }), HELPER, { x: 1, y: 2 }))
      .toEqual({ kind: "miss" });
    expect(await runHit(seam({ hit: { code: 3, stderr: "wudao-click: bad coordinate hit" } }), HELPER, { x: 1, y: 2 }))
      .toBeUndefined(); // 旧 helper：未知词首参被 coord 拒（零事件）
    expect(await runHit(seam({ hit: "" }), HELPER, { x: 1, y: 2 })).toBeUndefined(); // exit 0 无行
    expect(await runHit(seam({ hit: { code: 2, stdout: "WUDAO_AX_UNTRUSTED" } }), HELPER, { x: 1, y: 2 }))
      .toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R3 — drag endRef 命中匹配（settle 之后才 hit + 确认行逐字）
// ---------------------------------------------------------------------------
describe("ω99-261 R3 — drag(endRef) 命中匹配", () => {
  it("e7 上落点=AXButton「新建文件夹」→ 回执追「落点已确认：按钮「新建文件夹」。」；257 基线行字节不变", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已从 [e3] 图片「封面」 拖到 [e7] 按钮「新建文件夹」。"); // 257 基线形逐字
    expect(r.content).toContain("落点已确认：按钮「新建文件夹」。"); // ★验证行逐字
    expect(hitCalls(s)).toHaveLength(1);
    expect(hitCalls(s)[0]!.args).toEqual(["hit", "500", "600"]); // 终点=元素中心原值
  });

  it("时序钉：hit 在 settle 完成之后（hit 是全部 helper 调用的最后一笔，晚于所有 observe 采样）", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
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
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)[0]!.args).toEqual(["hit", "500", "600"]); // ★hit 不碰 captureScale
  });
});

// ---------------------------------------------------------------------------
// R4 — 零演进钉（坐标路径/混搭零 hit；非 endRef 回执形不变）
// ---------------------------------------------------------------------------
describe("ω99-261 R4 — 非 endRef 路径零 hit 零演进", () => {
  it("纯坐标路径：零 hit 调用；回执照旧 (x, y) 形、无验证行", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startX: 10, startY: 20, endX: 30, endY: 40 });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)).toHaveLength(0); // ★坐标终点零 hit（brief R4 钉）
    expect(r.content).toContain("已从 (10, 20) 拖到 (30, 40)。");
    expect(r.content).not.toContain("落点");
  });

  it("startRef+endX/endY 混搭（坐标终点）：零 hit 调用（同样零验证）", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endX: 30, endY: 40 });
    expect(r.isError).toBeFalsy();
    expect(hitCalls(s)).toHaveLength(0);
    expect(r.content).not.toContain("落点");
  });

  it("drag 动作 argv 零演进：startRef+endRef 仍 [100,200,500,600] 原值（257 复钉）", async () => {
    const s = seam({ hit: HIT_E7 });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    const action = helperCalls(s).find((c) => c.args[0] !== "observe" && c.args[0] !== "hit" && c.args.length >= 4)!;
    expect(action.args).toEqual(["100", "200", "500", "600"]);
  });
});

// ---------------------------------------------------------------------------
// R5 — 四态（不匹配警示逐字/未命中/旧 helper 静默降级/出错降级——全不 isError）
// ---------------------------------------------------------------------------
describe("ω99-261 R5 — 验证四态（拖拽事实与验证结论分离）", () => {
  // ω99-269: #3 — 同形演进：不符/miss 两态引导句收口（回执即处方），全串
  // 钉随词面演进（红取证 /tmp/o269-census.log：本件 2 测试红——不符全串钉+
  // miss 裸句钉；「与预期的…不符」前缀钉幸存零改）。
  it("身份不符 → 诚实警示逐字（实际 vs 预期 + 重新 observe 取新编号出路）；不 isError", async () => {
    const s = seam({ hit: "WUDAO_HIT AXButton|AXStandardButton|下载|下载|true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    expect(r.isError).toBeFalsy(); // ★拖拽已完成，验证只报告——绝不 isError
    expect(r.content).toContain("落点是按钮「下载」——与预期的按钮「新建文件夹」不符（元素表是 screen_observe 那一刻的快照，界面此后可能已变动）——如需继续：重新 screen_observe 取新编号后再试，不要用旧 ref 重试。");
    expect(r.content).toContain("已从 [e3] 图片「封面」 拖到 [e7] 按钮「新建文件夹」。"); // 拖拽事实照报
  });

  it("未命中（exit 4）→ miss 新引导句（observe/capture 双出路）；不 isError、不猜", async () => {
    const s = seam({ hit: { code: 4, stderr: "wudao-click: 落点无元素" } });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("落点处未命中元素（可能已消失或界面已变动）——如需继续：重新 screen_observe 或 screen_capture 看清现状后再试。");
  });

  it("旧 helper（无 hit 子命令→exit 3 拒）→ 静默降级：回执保持 257 形，零验证行；不 isError", async () => {
    const s = seam({ hit: { code: 3, stderr: "wudao-click: bad coordinate hit" } });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    expect(r.isError).toBeFalsy(); // ★绝不因验证不可用而失败拖拽本身
    expect(r.content).toContain("已从 [e3] 图片「封面」 拖到 [e7] 按钮「新建文件夹」。");
    expect(r.content).not.toContain("落点");
  });

  it("hit 出错（exit 1 / exit 0 但格式不符）→ 静默降级零验证行；不 isError", async () => {
    for (const hit of [{ code: 1, stderr: "boom" } as Partial<ExecResult>, "" as string]) {
      const s = seam({ hit });
      const t = toolset(s);
      await find(t, "screen_observe").execute({});
      const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
      expect(r.isError).toBeFalsy();
      expect(r.content).not.toContain("落点");
    }
  });
});

// ---------------------------------------------------------------------------
// R6 — 比对键纪律（role+title；subrole/label 不入键）
// ---------------------------------------------------------------------------
describe("ω99-261 R6 — 比对键=role+title（结构身份不含编号/位置）", () => {
  it("同 role 异 title → 不匹配（警示态）", async () => {
    const s = seam({ hit: "WUDAO_HIT AXButton||下载|下载|true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    expect(r.content).toContain("与预期的按钮「新建文件夹」不符");
  });

  it("同 title 异 role → 不匹配", async () => {
    const s = seam({ hit: "WUDAO_HIT AXList||新建文件夹|新建文件夹|true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    expect(r.content).toContain("落点是列表「新建文件夹」——与预期的按钮「新建文件夹」不符");
  });

  it("subrole/label 不入键：异 subrole/异 label 但 role+title 同 → 命中确认", async () => {
    const s = seam({ hit: HIT_E7 }); // subrole=AXStandardButton、label=「别的标签也照match」
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e7" });
    expect(r.content).toContain("落点已确认：按钮「新建文件夹」。");
  });

  it("两端 title 皆缺席（e11 无标题）→ 空对空=匹配；收据无「」段", async () => {
    const s = seam({ hit: "WUDAO_HIT AXGroup||||true|false" });
    const t = toolset(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_drag").execute({ startRef: "e3", endRef: "e11" });
    expect(r.content).toContain("落点已确认：容器。");
  });
});

// ---------------------------------------------------------------------------
// R7 — census 邻接零演进（源级直证；行为直证=solo 全绿）
// ---------------------------------------------------------------------------
describe("ω99-261 R7 — 邻接零演进（源级直证）", () => {
  const execSrc = () => readFile(fileURLToPath(new URL("../src/computer/exec.ts", import.meta.url)), "utf8");
  const toolsSrc = () => readFile(fileURLToPath(new URL("../src/computer/tools.ts", import.meta.url)), "utf8");

  it("257 行解析零演进：ELEMENT_LINE 严格引号形一字不动", async () => {
    const src = await execSrc();
    expect(src).toContain(
      'const ELEMENT_LINE = /^\\s*\\[(e[1-9][0-9]{0,4})\\] (\\S+)(?: ("(?:[^"\\\\]|\\\\.)*"))?(?: @(-?\\d+),(-?\\d+))?/;',
    );
  });

  it("250 settle 零演进：SETTLE 常量族 + withSettle 吞异常纪律在位", async () => {
    const src = await execSrc();
    expect(src).toContain("export const SETTLE_WINDOW_MS = 1_500;");
    expect(src).toContain("export const SETTLE_SAMPLE_INTERVAL_MS = 150;");
  });

  it("257 drag 基线收据构造零演进（验证=纯追加行，基线模板一字不动）", async () => {
    const src = await toolsSrc();
    expect(src).toContain("`已从 ${startLabel} ${how}到 ${endLabel}。`");
  });

  it("名册与顺序零触碰（十员固定序——212/220/247/250 复钉）", async () => {
    const t = toolset(seam());
    expect(t.map((x) => x.name)).toEqual([
      "screen_capture", "computer_type", "computer_key", "computer_click", "app_activate", "app_list",
      "computer_scroll", "computer_drag", "screen_observe", "computer_wait",
    ]);
  });
});
