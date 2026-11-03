// ω99-244: #4 — computer 弧 C 坐标系闭环 receipts（capture 规范分辨率 +
// 动作坐标换算 + 截图史投影桩）。★测试红线（212/220/241 既立红线沿承）：
// ExecSeam 全 mock——绝不真键鼠/截屏/真 sips/真 osascript 执行；夹具只经
// 工具自己的 tmpdir 落点（自落自清）；绝不删用户文件。
// 六面：R1 缩放链（sips argv/尺寸行/实测回喂）、R2 换算（click/scroll/drag
// 的 helper argv 含换算后屏幕点）、R3 无基准直通、R4 口径（描述零「折半」+
// M24 声明）、R5 投影桩（providers keep-K=3，JSONL 不动）、R6 红线账本。
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CAPTURE_MAX_EDGE,
  buildScreenPointsScript,
  parseScreenPoints,
  parseSipsSize,
  type ExecSeam,
} from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";
import { createOpenAICompatibleProvider } from "@wudao-org/providers";

// Platform contract: this suite exercises the macOS execution plane
// (osascript / caffeinate seams) — skip off-darwin CI runners instead of
// failing against the tool's platform guard.
const d: typeof describe = process.platform === "darwin" ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 缝 mock：一次缝四角色（screencapture / sips -g / sips -Z / osascript JXA），
// 全程零真派生。sips -g 的「原始尺寸→缩后输出尺寸」按 -Z 是否已发生分流；
// helper 与状态 osascript 走默认成功（stdout 空 → 状态行诚实缺席）。
// ---------------------------------------------------------------------------
interface SeamOpts {
  /** sips -g 首测（原始）尺寸。 */
  readonly rawW?: number;
  readonly rawH?: number;
  /** -Z 之后 sips -g 回喂的输出尺寸（实测回喂——喂什么记什么，绝不心算）。 */
  readonly outW?: number;
  readonly outH?: number;
  /** JXA 主屏点宽；null = 查询失败（降级路）。 */
  readonly screenW?: number | null;
  readonly screenH?: number;
  /** 从第几次 JXA 调用起失败（1 基；缺省永不）。 */
  readonly jxaFailFrom?: number;
  /** screencapture 假 PNG 字节数（缺省 50_000 过空图门）。 */
  readonly bytes?: number;
}

const coordinateSeam = (o: SeamOpts = {}): ExecSeam & { calls: { file: string; args: string[] }[] } => {
  const calls: { file: string; args: string[] }[] = [];
  let resized = false;
  let jxaN = 0;
  const seam: ExecSeam = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === "screencapture") {
      await writeFile(args[1]!, Buffer.alloc(o.bytes ?? 50_000, 7)); // 假 PNG（tmpdir 内，工具自清）
      return { stdout: "", stderr: "", code: 0 };
    }
    if (file === "sips") {
      if (args[0] === "-Z") {
        resized = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      const w = resized ? (o.outW ?? o.rawW ?? 1280) : (o.rawW ?? 1280);
      const h = resized ? (o.outH ?? o.rawH ?? 800) : (o.rawH ?? 800);
      // 实况形状：首行路径 + 缩进属性行
      return { stdout: `${args[args.length - 1]}\n  pixelWidth: ${w}\n  pixelHeight: ${h}\n`, stderr: "", code: 0 };
    }
    if (file === "osascript" && args[0] === "-l") {
      jxaN += 1;
      if (o.screenW === null || (o.jxaFailFrom !== undefined && jxaN >= o.jxaFailFrom)) {
        return { stdout: "", stderr: "execution error", code: 1 };
      }
      return { stdout: `${o.screenW ?? 1440}x${o.screenH ?? 900}`, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 }; // helper 动作 / 状态 osascript
  };
  return Object.assign(seam, { calls });
};

const fakeVision = () => ({
  store: {
    saveImages: async (inputs: readonly { data: string; mediaType: string }[]) =>
      inputs.map((_, i) => ({ kind: "image" as const, attachmentId: `att-${i + 1}`, mediaType: "image/png", byteLength: 50_000 })),
  },
  modelAcceptsImages: () => true,
});

/** 建一套带视觉缝的工具集（八件共享闭包——capture 基准在同一套里流转）。 */
const toolset = (seam: ExecSeam) =>
  createComputerTools({ exec: seam, helperExists: () => true, vision: fakeVision() });

const sipsCalls = (seam: { calls: { file: string; args: string[] }[] }) =>
  seam.calls.filter((c) => c.file === "sips");

const helperCalls = (seam: { calls: { file: string; args: string[] }[] }) =>
  seam.calls.filter((c) => c.file.endsWith("wudao-click"));
// ω99-250: #11 — 同形演进：坐标/滚动/拖拽动作前新增 settle 基线采样（每次
// 动作多一次 helper observe 调用，stdout 空 → 基线不可用 → 无 settle 行、无
// 对比窗采样）——下文各 helperCalls 索引按「基线+动作」成对顺移，argv 字节
// 不变（R2/R3 数例钉照旧成立）。

// ---------------------------------------------------------------------------
// R1 缩放链：统一缩放 + 实测尺寸链（绝不假设 2x）
// ---------------------------------------------------------------------------
d("ω99-244 R1 — capture 规范分辨率链（全 mock）", () => {
  it("长边超限 → sips 三段链 argv 钉：-g 实测 → -Z 1280 原地缩 → -g 实测输出；回执尺寸行逐字（全角括号/乘号）", async () => {
    const seam = coordinateSeam({ rawW: 2880, rawH: 1800, outW: 1280, outH: 800, screenW: 1440, screenH: 900 });
    const cap = toolset(seam).find((t) => t.name === "screen_capture")!;
    const r = await cap.execute({});
    expect(r.isError).toBeFalsy();
    const sips = sipsCalls(seam);
    expect(sips).toHaveLength(3);
    const path = seam.calls[0]!.args[1]!;
    expect(sips[0]!.args).toEqual(["-g", "pixelWidth", "-g", "pixelHeight", path]);
    expect(sips[1]!.args).toEqual(["-Z", "1280", path]);
    expect(sips[2]!.args).toEqual(["-g", "pixelWidth", "-g", "pixelHeight", path]);
    // 旧回执首行不动 + 新尺寸行逐字钉
    expect(r.content).toContain("已截取全屏");
    expect(r.content).toContain("尺寸：1280×800（坐标以此图为准）");
    // 常量钉：长边 1280
    expect(CAPTURE_MAX_EDGE).toBe(1280);
  });

  it("长边未超限（1024×640）→ 零 -Z 调用（sips -Z 会放大小图——绝不放大），基准=原始实测；尺寸行给原始尺寸", async () => {
    const seam = coordinateSeam({ rawW: 1024, rawH: 640, screenW: 1024, screenH: 640 });
    const cap = toolset(seam).find((t) => t.name === "screen_capture")!;
    const r = await cap.execute({});
    expect(r.isError).toBeFalsy();
    const sips = sipsCalls(seam);
    expect(sips).toHaveLength(1); // 只有首测 -g，没有 -Z、没有二次 -g
    expect(sips[0]!.args[0]).toBe("-g");
    expect(r.content).toContain("尺寸：1024×640（坐标以此图为准）");
  });

  it("实测链不是心算：mock 喂奇怪输出 1277×799（≠任何推导值）→ 尺寸行照录 1277×799；换算分母也用实测值（1277 像素 → 1440 点，单一标量比例 x/y 同用）", async () => {
    const seam = coordinateSeam({ rawW: 1400, rawH: 900, outW: 1277, outH: 799, screenW: 1440, screenH: 900 });
    const tools = toolset(seam);
    const cap = tools.find((t) => t.name === "screen_capture")!;
    const rc = await cap.execute({});
    expect(rc.content).toContain("尺寸：1277×799（坐标以此图为准）");
    // 换算用实测 1277（非理论 1280）：x=1277 → 1277×(1440/1277)=1440 点；
    // y=399 → 399×(1440/1277)=449.93 → 450（单一标量比例=屏幕点宽/截图输出宽）
    const click = tools.find((t) => t.name === "computer_click")!;
    const rk = await click.execute({ x: 1277, y: 399 });
    expect(rk.isError).toBeFalsy();
    expect(helperCalls(seam)[1]!.args).toEqual(["1440", "450"]); // [0]=基线采样（ω99-250）
  });

  it("JXA 主屏查询失败 → capture 仍成功（尺寸行照给，实测尺寸是事实）；同一套工具集基准整对覆写为缺席——后续动作直通（不拿过期基准顶）", async () => {
    const seam = coordinateSeam({ rawW: 2880, rawH: 1800, outW: 1280, outH: 800, screenW: 1440, screenH: 900, jxaFailFrom: 2 });
    const tools = toolset(seam);
    const cap = tools.find((t) => t.name === "screen_capture")!;
    const first = await cap.execute({});
    expect(first.isError).toBeFalsy();
    expect(first.content).toContain("尺寸：1280×800"); // 第 1 次 JXA 成功 → 基准在
    const second = await cap.execute({});
    expect(second.isError).toBeFalsy(); // 第 2 次 JXA 失败 → capture 照样成功
    expect(second.content).toContain("尺寸：1280×800（坐标以此图为准）");
    const rk = await tools.find((t) => t.name === "computer_click")!.execute({ x: 640, y: 400 });
    expect(rk.isError).toBeFalsy();
    expect(helperCalls(seam)[1]!.args).toEqual(["640", "400"]); // 基准缺席 → 直通（[0]=基线采样，ω99-250）
  });

  it("纯层：parseSipsSize / parseScreenPoints（实况形状 + 坏输出 undefined）；JXA 脚本钉 NSScreen 主屏", () => {
    expect(parseSipsSize("/tmp/x.png\n  pixelWidth: 1280\n  pixelHeight: 800\n")).toEqual({ w: 1280, h: 800 });
    expect(parseSipsSize("  pixelWidth: 0\n  pixelHeight: 800\n")).toBeUndefined();
    expect(parseSipsSize("garbage")).toBeUndefined();
    expect(parseScreenPoints("1440x900")).toEqual({ w: 1440, h: 900 });
    expect(parseScreenPoints(" 1440x900\n")).toEqual({ w: 1440, h: 900 });
    expect(parseScreenPoints("execution error")).toBeUndefined();
    const s = buildScreenPointsScript();
    expect(s).toContain("NSScreen");
    expect(s).toContain("firstObject"); // 主屏（screens[0] 在 JXA 不可索引——实测钉）
  });
});

// ---------------------------------------------------------------------------
// R2 换算：有基准时 click/scroll/drag 的 helper argv 含换算后屏幕点
// （数例钉死：屏 1440 点 / capture 输出宽 1280 → scale=1.125；640 → 720）
// ---------------------------------------------------------------------------
d("ω99-244 R2 — 动作坐标换算（模型永不知 DPR）", () => {
  /** 一套已 capture 的工具集（2880×1800 → 1280×800，主屏 1440×900 → scale=1.125）。 */
  const scaled = (): { seam: ReturnType<typeof coordinateSeam>; tools: ReturnType<typeof toolset> } => {
    const seam = coordinateSeam({ rawW: 2880, rawH: 1800, outW: 1280, outH: 800, screenW: 1440, screenH: 900 });
    const tools = toolset(seam);
    return { seam, tools };
  };
  const capture = async (tools: ReturnType<typeof toolset>): Promise<void> => {
    const r = await tools.find((t) => t.name === "screen_capture")!.execute({});
    expect(r.isError).toBeFalsy();
  };

  it("click：x=640,y=400 → argv [720, 450]（brief 数例 640→720 钉）；回执照报模型坐标（换算不进文案）", async () => {
    const { seam, tools } = scaled();
    await capture(tools);
    const r = await tools.find((t) => t.name === "computer_click")!.execute({ x: 640, y: 400 });
    expect(r.isError).toBeFalsy();
    expect(helperCalls(seam)[1]!.args).toEqual(["720", "450"]);
    expect(r.content).toContain("(640, 400)");
  });

  it("四舍五入钉死（Math.round，.5 向 +∞）：click x=12 → 13.5 → 14；scroll dy=28 → 31.5 → 32、dy=-28 → -31.5 → -31（翻转变为 31）", async () => {
    const { seam, tools } = scaled();
    await capture(tools);
    await tools.find((t) => t.name === "computer_click")!.execute({ x: 12, y: 0 });
    expect(helperCalls(seam)[1]!.args).toEqual(["14", "0"]);
    // ω99-265: #4 — 同形演进：坐标单击 settle 后新增落点身份 hit（[2] 殿后，
    // mock 空输出 → 信息行静默缺席）——scroll/drag 的 argv 钉按插位顺移
    // （[3]→[4]、[5]→[6]），argv 字节不变。
    expect(helperCalls(seam)[2]!.args).toEqual(["hit", "14", "0"]);
    await tools.find((t) => t.name === "computer_scroll")!.execute({ dy: 28 });
    expect(helperCalls(seam)[4]!.args).toEqual(["scroll", "0", "0", "0", "-32"]);
    await tools.find((t) => t.name === "computer_scroll")!.execute({ dy: -28 });
    expect(helperCalls(seam)[6]!.args).toEqual(["scroll", "0", "0", "0", "31"]);
  });

  it("scroll：dy=300 → 338、dx=40 → 45（距离同换算，符号翻转语义不变）；回执照报模型量纲", async () => {
    const { seam, tools } = scaled();
    await capture(tools);
    const r = await tools.find((t) => t.name === "computer_scroll")!.execute({ dx: 40, dy: 300 });
    expect(r.isError).toBeFalsy();
    expect(helperCalls(seam)[1]!.args).toEqual(["scroll", "0", "0", "45", "-338"]);
    expect(r.content).toContain("向下滚动 300 像素");
  });

  it("drag：起终点四坐标同换算（100,200 → 400,500 ⇒ 113,225 → 450,563）；回执给模型坐标", async () => {
    const { seam, tools } = scaled();
    await capture(tools);
    const r = await tools.find((t) => t.name === "computer_drag")!.execute({ startX: 100, startY: 200, endX: 400, endY: 500 });
    expect(r.isError).toBeFalsy();
    // 100×1.125=112.5→113（Math.round .5 向上）；200×1.125=225；400×1.125=450；500×1.125=562.5→563
    expect(helperCalls(seam)[1]!.args).toEqual(["113", "225", "450", "563"]);
    expect(r.content).toContain("(100, 200)");
    expect(r.content).toContain("(400, 500)");
  });

  it("基准随最近一次 capture 走且不串门：第二套工具集换新分母（1277 宽 → x=1277 给 1440 点）；第一套的基准不受第二套影响（仍 1.125：x=640 给 720）", async () => {
    const a = scaled();
    await capture(a.tools);
    const seamB = coordinateSeam({ rawW: 1400, rawH: 900, outW: 1277, outH: 799, screenW: 1440, screenH: 900 });
    const toolsB = toolset(seamB);
    const rb = await toolsB.find((t) => t.name === "screen_capture")!.execute({});
    expect(rb.isError).toBeFalsy();
    await toolsB.find((t) => t.name === "computer_click")!.execute({ x: 1277, y: 399 });
    expect(helperCalls(seamB)[1]!.args).toEqual(["1440", "450"]);
    await a.tools.find((t) => t.name === "computer_click")!.execute({ x: 640, y: 400 });
    expect(helperCalls(a.seam)[1]!.args).toEqual(["720", "450"]); // 闭包态各自随套——零串门
  });
});

// ---------------------------------------------------------------------------
// R3 无基准直通：零 capture 会话坐标按现状直通（屏幕点语义）——回执不动、不报错
// ---------------------------------------------------------------------------
d("ω99-244 R3 — 无基准直通（现状语义零漂移）", () => {
  it("click (42,99) → argv 原值；scroll dy=300 → 现状 argv；drag 四坐标原值；零 sips/JXA 派生", async () => {
    const seam = coordinateSeam();
    const tools = toolset(seam);
    const rc = await tools.find((t) => t.name === "computer_click")!.execute({ x: 42, y: 99 });
    expect(rc.isError).toBeFalsy();
    expect(rc.content).toContain("(42, 99)");
    const rs = await tools.find((t) => t.name === "computer_scroll")!.execute({ dy: 300 });
    expect(rs.isError).toBeFalsy();
    const rd = await tools.find((t) => t.name === "computer_drag")!.execute({ startX: 100, startY: 200, endX: 400, endY: 500 });
    expect(rd.isError).toBeFalsy();
    const calls = helperCalls(seam);
    expect(calls[1]!.args).toEqual(["42", "99"]);
    // 265 同形演进（续前 #4）：坐标单击后新增落点身份 hit（[2] 殿后）——
    // scroll/drag 的 argv 钉按插位顺移（[3]→[4]、[5]→[6]），argv 字节不变。
    expect(calls[2]!.args).toEqual(["hit", "42", "99"]);
    expect(calls[4]!.args).toEqual(["scroll", "0", "0", "0", "-300"]);
    expect(calls[6]!.args).toEqual(["100", "200", "400", "500"]);
    expect(sipsCalls(seam)).toHaveLength(0);
    expect(seam.calls.some((c) => c.file === "osascript" && c.args[0] === "-l")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R4 口径：三工具描述进「最近一次 screen_capture 输出图」契约；零「折半」残留；M24 声明在代码注释
// ---------------------------------------------------------------------------
d("ω99-244 R4 — 坐标口径（描述改写）", () => {
  it("click/scroll/drag 描述含「最近一次 screen_capture 输出图」；八件描述与参数描述全扫零「折半」零「2 倍像素」零 halve", () => {
    const tools = createComputerTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["computer_click", "computer_scroll", "computer_drag"]) {
      expect(byName.get(name)!.description).toContain("最近一次 screen_capture 输出图");
    }
    for (const t of tools) {
      const all = `${t.description}\n${JSON.stringify(t.parameters.properties)}`;
      expect(all).not.toContain("折半");
      expect(all).not.toContain("2 倍像素");
      expect(all).not.toContain("halve");
    }
  });

  it("M24 声明在代码注释（tools.ts 源）：工具描述骑请求前缀，改口径=跨版本一次冷转", async () => {
    const src = await readFile(fileURLToPath(new URL("../src/computer/tools.ts", import.meta.url)), "utf8");
    // ω99-244 标记附近的 M24 声明（缓存代价叙事）
    expect(src).toMatch(/ω99-244[\s\S]{0,400}M24/);
  });
});

// ---------------------------------------------------------------------------
// R5 投影桩：providers keep-K=3（N 张之后旧图换桩）；JSONL（输入史）不动；
// 桩形逐字；M24 补偿声明在
// ---------------------------------------------------------------------------
const pref = (id: string) => ({ kind: "image" as const, attachmentId: id, mediaType: "image/png", byteLength: 3 });

/** 四张 tool 截图史（shot → look ×4——第 4 张落地窗口滑动，最旧一张换桩）。 */
const fourToolShots = [1, 2, 3, 4].flatMap((i) => [
  { role: "assistant" as const, content: "", toolCalls: [{ id: `c${i}`, name: "screen_capture", arguments: {} }] },
  { role: "tool" as const, toolCallId: `c${i}`, name: "screen_capture", content: `shot ${i}`, images: [{ kind: "image" as const, ref: pref(`shot-${i}`) }] },
]);

const captureFetch = (): { fetch: typeof fetch; bodies: Record<string, unknown>[] } => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
  }) as unknown as typeof fetch;
  return { fetch, bodies };
};

const carriersOf = (body: Record<string, unknown>): Record<string, unknown>[][] =>
  (body["messages"] as Record<string, unknown>[])
    .filter((m) => m["role"] === "user" && Array.isArray(m["content"]))
    .map((m) => m["content"] as Record<string, unknown>[])
    .filter((parts) => (parts[0] as { text?: string })?.text === "Attached image(s) from tool result:");

d("ω99-244 R5 — 截图史投影桩（只留最近 N=3，投影不删史）", () => {
  it("4 张 tool 截图 → 最近 3 张 image_url、最旧一张桩逐字「[更早的截图已略：仅保留最近 3 张]」；桩图字节零解析", async () => {
    const cap = captureFetch();
    const resolved: string[] = [];
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "glm-4v-plus" },
      { fetch: cap.fetch, attachments: { resolveDataUrl: async (r) => { resolved.push(r.attachmentId); return `data:${r.mediaType};base64,${r.attachmentId}`; } } },
    );
    await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "watch" }, ...fourToolShots], tools: [] });
    const carriers = carriersOf(cap.bodies[0]!);
    expect(carriers).toHaveLength(4);
    expect(carriers[0]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "text", text: "[更早的截图已略：仅保留最近 3 张]" },
    ]);
    const imageUrls = carriers.flat().filter((p) => p["type"] === "image_url");
    expect(imageUrls).toHaveLength(3);
    expect(resolved.sort()).toEqual(["shot-2", "shot-3", "shot-4"]); // 桩图零字节解析
  });

  it("JSONL 不动（投影层断言）：投影后输入史四张 refs 一条不少——append-only 史零改写", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "glm-4v-plus" },
      { fetch: cap.fetch, attachments: { resolveDataUrl: async (r) => `data:${r.mediaType};base64,${r.attachmentId}` } },
    );
    const history = [{ role: "user" as const, content: "watch" }, ...fourToolShots];
    const before = JSON.parse(JSON.stringify(history));
    await model.generate({ systemPrompt: "s", messages: history, tools: [] });
    expect(history).toEqual(before); // 会话史（JSONL 的内存形）逐字节未动
    expect(JSON.stringify(history).match(/shot-\d/g)).toHaveLength(4); // 四张全在史里
    const ridingIds = JSON.stringify(cap.bodies[0]).match(/base64,shot-\d/g) ?? [];
    expect(ridingIds).toHaveLength(3); // 线上只 3 张（data URL 形 `…;base64,<id>`）
  });

  it("M24 补偿声明在代码注释（openai-images.ts 源〔拆分C 随迁〕：缓存代价+轮界时机+冷转标注）", async () => {
    const src = await readFile(fileURLToPath(new URL("../../../packages/providers/src/openai-images.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/ω99-244[\s\S]{0,600}M24/);
    expect(src).toContain("cold turn");
  });
});

// ---------------------------------------------------------------------------
// R6 红线账本：删除调用面恒等（本弧零新增）+ 本件零删除调用；exec 全 mock（R1-R5 即证）
// ---------------------------------------------------------------------------
d("ω99-244 R6 — 红线账本（开发/测试禁删用户文件）", () => {
  it("computer 两源件删除 API 面：exec.ts 恒 0；tools.ts unlink 恒 6（import + capture 自清 + win32 层 8ca40407 三处 tmpdir 自清）；无 rmSync/rmdir/fs.rm", async () => {
    const execSrc = await readFile(fileURLToPath(new URL("../src/computer/exec.ts", import.meta.url)), "utf8");
    const toolsSrc = await readFile(fileURLToPath(new URL("../src/computer/tools.ts", import.meta.url)), "utf8");
    const count = (s: string, re: RegExp): number => [...s.matchAll(re)].length;
    expect(count(execSrc, /\bunlink\b|\brmSync\b|\brmdir\b|\bfs\.rm\b/g)).toBe(0);
    // 3→6：win32 执行层（8ca40407）合法新增三处 unlink 自落自清
    // （os.tmpdir 内 .catch(()=>{}) 形，2026-09-13 全量揭发升钉；
    // 与 ω99-250 R6 同款账本，两处同步）。
    expect(count(toolsSrc, /\bunlink\b/g)).toBe(6);
    expect(count(toolsSrc, /\brmSync\b|\brmdir\b|\bfs\.rm\b/g)).toBe(0);
  });

  it("本测试件自身零删除调用、零生产缝引用（exec 全 mock——夹具只写 tmpdir 且工具自清）", async () => {
    const self = await readFile(fileURLToPath(import.meta.url), "utf8");
    expect(self).not.toMatch(/\bunlink\(|\brmSync\(|\brmdir\(|\bfs\.rm\(/);
    // 生产缝绝不进测试（字符类写法防自引用假阳/假阴）
    expect(self).not.toMatch(/defaultExec[S]eam/);
  });
});
