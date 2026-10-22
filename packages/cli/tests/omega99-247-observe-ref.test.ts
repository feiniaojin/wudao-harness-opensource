// ω99-247: #6 — screen_observe AX 元素面 receipts（browser_snapshot ref 范式
// 桌面移植：观察=带编号元素表、点选/输入按 ref 直达、ref 只属于当次观察、
// 窗口黑名单自适应降级）。★测试红线：child_process 全 mock（注入 ExecSeam
// 假件，helper observe/press/settext 输出全为构造字符串）——绝无真实键鼠/
// 截屏/真 AX 读取/真 osascript；夹具零盘写零删除（读 Swift 源文件是只读）。
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildObserveArgs,
  buildPressArgs,
  buildSettextArgs,
  parseObserveOutput,
  OBSERVE_BLACKLIST_N,
  OBSERVE_BLACKLIST_TTL_MS,
  OBSERVE_MAX_DEPTH,
  OBSERVE_MAX_NODES,
  OBSERVE_MAX_TEXT_BYTES,
  PERM_MARKER_ACCESSIBILITY,
  type ExecSeam,
  type ExecResult,
} from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";
import { DEFAULT_ASK_TOOLS, decidePermission, isDefaultAskCall } from "../src/permission.js";
import { summarizeToolCall } from "../src/log.js";
import { buildToolSet } from "../src/tools.js";

const HELPER = "/fake/wudao-click";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** 观察器 stdout 构造（helper 输出契约的 mock 形——行格式即被测契约）。 */
const obs = (o: {
  app?: string;
  window?: string;
  lines?: readonly string[];
  nodes?: number;
  truncated?: 0 | 1;
  sha?: string;
} = {}): string => [
  `WUDAO_OBSERVE app=${o.app ?? "Safari"}`,
  `WUDAO_WINDOW ${o.window ?? "备忘录"}`,
  ...(o.lines ?? ['[e1] AXWindow "备忘录"', '  [e2] AXButton "添加"', '  [e3] AXTextField "搜索"']),
  `WUDAO_END nodes=${o.nodes ?? 3} truncated=${o.truncated ?? 0} sha256=${o.sha ?? SHA_A}`,
].join("\n");

/** 假 seam：helper observe/press/settext 分流应答；osascript 一律成功空输出
 *  （状态行诚实缺席）。记录全部调用供 argv 钉。 */
function seam(helperResults: Partial<ExecResult> = {}): ExecSeam & { calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  const s: ExecSeam = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === HELPER) return { stdout: "", stderr: "", code: 0, ...helperResults };
    return { stdout: "", stderr: "", code: 0 };
  };
  return Object.assign(s, { calls });
}

/** 一次 observe 成功播种 + 返回工具集（闭包态共享：observe → click/type 链）。 */
function tools(seam: ExecSeam & { calls: unknown }, now?: () => number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = createComputerTools({ exec: seam as any, platform: "darwin", env: { WUDAO_CLICK_HELPER: HELPER }, helperExists: () => true, ...(now ? { now } : {}) });
  return t;
}
const find = (t: ReturnType<typeof createComputerTools>, name: string) => t.find((x) => x.name === name)!;

// ---------------------------------------------------------------------------
// R1 — observe 面（argv 钉 / 回执=元素表原文+截断叙事 / 预算进 argv / secure 零 value）
// ---------------------------------------------------------------------------
describe("ω99-247 R1 — screen_observe 面", () => {
  it("buildObserveArgs 钉：预算三参进 argv；app 缺席观察前台、给出则尾随（app 参数形）", () => {
    expect(buildObserveArgs()).toEqual(["observe", String(OBSERVE_MAX_NODES), String(OBSERVE_MAX_DEPTH), String(OBSERVE_MAX_TEXT_BYTES)]);
    expect(buildObserveArgs("Safari")).toEqual(["observe", "400", "20", "24000", "Safari"]);
  });

  it("预算数值钉：maxNodes=400 / maxDepth=20 / maxTextBytes=24000（裁定值进报告）", () => {
    expect(OBSERVE_MAX_NODES).toBe(400);
    expect(OBSERVE_MAX_DEPTH).toBe(20);
    expect(OBSERVE_MAX_TEXT_BYTES).toBe(24_000);
  });

  it("成功回执：元素表逐行原文在场 + 用 ref 点选提示在场；未截断时零截断叙事", async () => {
    const s = seam({ stdout: obs() });
    const r = await find(tools(s), "screen_observe").execute({});
    expect(r.isError).toBeFalsy();
    for (const line of ['[e1] AXWindow "备忘录"', '  [e2] AXButton "添加"', '  [e3] AXTextField "搜索"']) {
      expect(r.content).toContain(line); // 元素表原文（含缩进）逐行进回执
    }
    expect(r.content).toContain("ref");
    expect(r.content).toContain("Safari");
    expect(r.content).not.toContain("截断");
    expect(s.calls[0]!.args).toEqual(["observe", "400", "20", "24000"]);
  });

  it("截断叙事：truncated=1 → 回执含预算截断行（未列出元素没有编号不可 ref——诚实截断）", async () => {
    const s = seam({ stdout: obs({ truncated: 1, lines: ['[e1] AXWindow "w"', '  [e2] AXButton "a"', '  [e3] AXButton "b"'], nodes: 3 }) });
    const r = await find(tools(s), "screen_observe").execute({});
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("截断");
    expect(r.content).toContain("不可用 ref");
  });

  it("app 参数：给出 → helper argv 尾随 app 名；非法（控制字符）typed 拒零派生", async () => {
    const s = seam({ stdout: obs({ app: "Notes" }) });
    const r = await find(tools(s), "screen_observe").execute({ app: "Notes" });
    expect(r.isError).toBeFalsy();
    expect(s.calls[0]!.args).toEqual(["observe", "400", "20", "24000", "Notes"]);
    const s2 = seam();
    const bad = await find(tools(s2), "screen_observe").execute({ app: "Bad\nName" });
    expect(bad.isError).toBe(true);
    expect(s2.calls).toHaveLength(0);
  });

  it("helper 缺席 → 结构化降级（WUDAO_CLICK_HELPER 指引），零进程派生", async () => {
    const s = seam();
    const t = createComputerTools({ exec: s, platform: "darwin", env: {}, helperExists: () => false });
    const r = await find(t, "screen_observe").execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("WUDAO_CLICK_HELPER");
    expect(s.calls).toHaveLength(0);
  });

  it("exit 2（AX 未授）→ 辅助功能引导（与 click 同族标记）", async () => {
    const s = seam({ code: 2, stdout: "WUDAO_AX_UNTRUSTED" });
    const r = await find(tools(s), "screen_observe").execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toContain(PERM_MARKER_ACCESSIBILITY);
    expect(r.content).toContain("辅助功能");
  });

  it("exit 5（无窗口/应用未运行）→ 诚实目标不可达错误", async () => {
    const s = seam({ code: 5, stderr: "wudao-click: no observable window" });
    const r = await find(tools(s), "screen_observe").execute({ app: "Ghost" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Ghost");
  });

  it("输出不可解析 → typed 拒 + refs 不落态（后续 ref 点选仍报「先观察」）", async () => {
    const s = seam({ stdout: "random garbage\nnot a table" });
    const t = tools(s);
    const r = await find(t, "screen_observe").execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("screen_observe");
    const click = await find(t, "computer_click").execute({ ref: "e2" });
    expect(click.isError).toBe(true);
    expect(click.content).toContain("No observation yet");
  });

  it("parseObserveOutput 纯层：头/窗/元素行/尾标全形 → 表；缺尾标/异质行 → ok:false", () => {
    const read = parseObserveOutput(obs({ nodes: 3, sha: SHA_B }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.table.app).toBe("Safari");
    expect(read.table.window).toBe("备忘录");
    expect(read.table.elementLines).toHaveLength(3);
    expect(read.table.nodes).toBe(3);
    expect(read.table.truncated).toBe(false);
    expect(read.table.sha256).toBe(SHA_B);
    expect(parseObserveOutput(obs().split("WUDAO_END")[0]!).ok).toBe(false); // 缺尾标
    expect(parseObserveOutput(["WUDAO_OBSERVE app=X", "WUDAO_WINDOW w", "garbage line", `WUDAO_END nodes=0 truncated=0 sha256=${SHA_A}`].join("\n")).ok).toBe(false); // 异质行
  });
});

// ---------------------------------------------------------------------------
// R2 — ref 寻址（AXPress/AXSetText 优先 = helper 路径；无 ref → 244 坐标路径字节不变）
// ---------------------------------------------------------------------------
describe("ω99-247 R2 — click/type 的 ref 寻址", () => {
  it("click 带 ref → press argv 钉（预算三参+当次 sha 随行）；回执点名 role/title，零 value 回显", async () => {
    const s = seam({ stdout: obs({ sha: SHA_A }) });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e2" });
    expect(r.isError).toBeFalsy();
    expect(s.calls[1]!.args).toEqual(["press", "2", "400", "20", "24000", SHA_A]);
    expect(r.content).toContain("[e2]");
    expect(r.content).toContain("按钮");
    expect(r.content).toContain("添加");
    expect(r.content).not.toContain("value="); // 安全纪律：不回显 value
  });

  it("type 带 ref → settext argv 钉（文本原样进 argv）；回执=编号+角色+字符数", async () => {
    const s = seam({ stdout: obs({ sha: SHA_A }) });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_type").execute({ ref: "e3", text: "hello" });
    expect(r.isError).toBeFalsy();
    expect(s.calls[1]!.args).toEqual(["settext", "3", "hello", "400", "20", "24000", SHA_A]);
    expect(r.content).toContain("[e3]");
    expect(r.content).toContain("文本框");
    expect(r.content).toContain("5 个字符");
  });

  it("ref 与坐标同给 → ref 优先（press argv 派生，坐标 argv 零派生）+ 回执声明坐标已忽略", async () => {
    const s = seam({ stdout: obs({ sha: SHA_A }) });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e2", x: 640, y: 400 });
    expect(r.isError).toBeFalsy();
    expect(s.calls[1]!.args[0]).toBe("press"); // 不是坐标路径
    expect(r.content).toContain("已忽略");
  });

  it("无 ref → 244 坐标路径 argv 逐字不变（回归钉：观察态在场也不改坐标路径）", async () => {
    const s = seam({ stdout: obs({ sha: SHA_A }) });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ x: 42, y: 99 });
    expect(r.isError).toBeFalsy();
    // ω99-250: #12 — 同形演进：坐标动作前新增 settle 基线采样（calls[1]=
    // observe argv；ref 路径零基线采样的钉在 omega99-250 R2）——点击 argv
    // 顺移到 calls[2]，字节不变。
    expect(s.calls[1]!.args).toEqual(["observe", "400", "20", "24000"]);
    expect(s.calls[2]!.args).toEqual(["42", "99"]); // 212/244 原 argv 形，逐字
  });

  it("ref 形状非法（非 e 数字）→ typed 拒零派生；ref/x/y 全缺席 → typed 拒零派生", async () => {
    const s = seam({ stdout: obs() });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const bad1 = await find(t, "computer_click").execute({ ref: "xyz" });
    expect(bad1.isError).toBe(true);
    expect(bad1.content).toContain('"ref"');
    const bad2 = await find(t, "computer_click").execute({});
    expect(bad2.isError).toBe(true);
    expect(s.calls).toHaveLength(1); // 只有 observe 一次，零动作派生
  });

  it("buildPressArgs / buildSettextArgs 纯层：ref 校验先行；app 尾随；e 前缀剥离成索引", () => {
    expect(buildPressArgs("e2", SHA_A)).toEqual({ ok: true, args: ["press", "2", "400", "20", "24000", SHA_A] });
    expect(buildPressArgs("e2", SHA_A, "Safari")).toEqual({ ok: true, args: ["press", "2", "400", "20", "24000", SHA_A, "Safari"] });
    expect(buildSettextArgs("e3", "hi", SHA_A)).toEqual({ ok: true, args: ["settext", "3", "hi", "400", "20", "24000", SHA_A] });
    for (const bad of ["e0", "e01", "3", "e", "e123456", 5, null]) {
      expect(buildPressArgs(bad, SHA_A).ok).toBe(false);
    }
  });
});

/** 状态 seam：按调用序/子命令切应答（observe → press/settext → osascript）。 */
function statefulSeam(byCall: ((args: readonly string[], file: string) => Partial<ExecResult>)[]): ExecSeam & { calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  const s: ExecSeam = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === HELPER) {
      const answer = byCall[calls.filter((c) => c.file === HELPER).length - 1];
      return { stdout: "", stderr: "", code: 0, ...(answer ? answer(args, file) : {}) };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return Object.assign(s, { calls });
}

// ---------------------------------------------------------------------------
// R3 — stale-ref（ref 只属于当次观察；过期诚实报错给「重新 observe」出路，绝不静默改坐标）
// ---------------------------------------------------------------------------
describe("ω99-247 R3 — stale-ref 纪律", () => {
  it("未观察先点 → No observation yet（browser 同款形）+ screen_observe 出路；零 helper 派生", async () => {
    const s = seam();
    const r = await find(tools(s), "computer_click").execute({ ref: "e2" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("No observation yet");
    expect(r.content).toContain("screen_observe");
    expect(s.calls).toHaveLength(0);
  });

  it("ref 不在当次表 → Ref not in the current observation（browser 同款形）+ 重新 observe 出路；零派生", async () => {
    const s = seam({ stdout: obs() });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e9" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Ref e9 is not in the current observation");
    expect(r.content).toContain("call screen_observe again");
    expect(s.calls).toHaveLength(1); // 只有 observe，零动作派生
  });

  it("helper 报 stale（exit 6：窗口元素树已变）→ browser 同款 stale 文案；绝不静默落坐标（calls 恰 1 次 press）", async () => {
    const s = statefulSeam([
      () => ({ stdout: obs({ sha: SHA_A }) }), // observe
      () => ({ stdout: "", stderr: "wudao-click: stale observation", code: 6 }), // press → stale
    ]);
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e2" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("The observation is stale");
    expect(r.content).toContain("screen_observe");
    expect(s.calls).toHaveLength(2); // observe + press 恰两次——没有坐标兜底第三跳
    expect(s.calls[1]!.args[0]).toBe("press");
  });

  it("新 observe 作废旧 ref（browser stale-ref 纪律）：第二次表没有的旧编号 → not in current observation", async () => {
    const s = statefulSeam([
      () => ({ stdout: obs({ sha: SHA_A }) }), // 第一次：e2 在表
      () => ({ stdout: obs({ sha: SHA_B, lines: ['[e1] AXWindow "w2"', '  [e7] AXButton "新"]'], nodes: 2 }) }), // 第二次：e2 已不在
    ]);
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    await find(t, "screen_observe").execute({}); // 新 observe 作废旧 ref
    const r = await find(t, "computer_click").execute({ ref: "e2" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Ref e2 is not in the current observation");
    expect(s.calls).toHaveLength(2);
  });

  it("type 的 stale 同族：exit 6 → computer_type 前缀 stale 文案 + 出路", async () => {
    const s: ExecSeam = async (file, args) => {
      if (file === HELPER && args[0] === "observe") return { stdout: obs({ sha: SHA_A }), stderr: "", code: 0 };
      if (file === HELPER) return { stdout: "", stderr: "wudao-click: stale observation", code: 6 };
      return { stdout: "", stderr: "", code: 0 };
    };
    const t = createComputerTools({ exec: s, platform: "darwin", env: { WUDAO_CLICK_HELPER: HELPER }, helperExists: () => true });
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_type").execute({ ref: "e3", text: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("computer_type");
    expect(r.content).toContain("stale");
  });

  it("exit 8（元素不支持点按/写入）→ 诚实不可达错误（不猜坐标）", async () => {
    const s: ExecSeam = async (file, args) => {
      if (file === HELPER && args[0] === "observe") return { stdout: obs({ sha: SHA_A }), stderr: "", code: 0 };
      if (file === HELPER) return { stdout: "", stderr: "wudao-click: element has no press action", code: 8 };
      return { stdout: "", stderr: "", code: 0 };
    };
    const t = createComputerTools({ exec: s, platform: "darwin", env: { WUDAO_CLICK_HELPER: HELPER }, helperExists: () => true });
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e2" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("不支持点按");
  });
});

// ---------------------------------------------------------------------------
// R4 — 窗口黑名单 TTL 自适应降级（连续空观察 N 次短期记住；TTL 内不再硬试）
// ---------------------------------------------------------------------------
describe("ω99-247 R4 — 黑名单自适应降级", () => {
  const emptyObs = (app?: string) => obs({ app: app ?? "Safari", lines: ['[e1] AXWindow "游戏"'], nodes: 1 });

  it("N/TTL 数值钉：N=2 次、TTL=300000ms（裁定值进报告）", () => {
    expect(OBSERVE_BLACKLIST_N).toBe(2);
    expect(OBSERVE_BLACKLIST_TTL_MS).toBe(300_000);
  });

  it("连续 N 次空观察 → 第 N+1 次不再硬试（零 helper 派生）+ 回执主动提示走截图", async () => {
    const s = seam({ stdout: emptyObs("游戏X") });
    const t = tools(s);
    const observe = find(t, "screen_observe");
    await observe.execute({ app: "游戏X" }); // 空 1
    await observe.execute({ app: "游戏X" }); // 空 2 = N → 拉黑
    expect(s.calls).toHaveLength(2);
    const r = await observe.execute({ app: "游戏X" }); // 第 3 次：不硬试
    expect(s.calls).toHaveLength(2); // 零新增派生
    expect(r.isError).toBe(true);
    expect(r.content).toContain("无元素树");
    expect(r.content).toContain("screen_capture");
    // 空观察的回执本身也给出路（第 2 次回执可见降级预警）
  });

  it("空观察回执：无元素树 + 走截图出路在场（第 1 次空就给）", async () => {
    const s = seam({ stdout: emptyObs("游戏X") });
    const t = tools(s);
    const r = await find(t, "screen_observe").execute({ app: "游戏X" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("无元素树");
    expect(r.content).toContain("screen_capture");
  });

  it("TTL 过 → 恢复硬试（helper 再次被调用）", async () => {
    let t0 = 1_000_000;
    const now = () => t0;
    const s = seam({ stdout: emptyObs("游戏X") });
    const t = tools(s, now);
    const observe = find(t, "screen_observe");
    await observe.execute({ app: "游戏X" });
    await observe.execute({ app: "游戏X" });
    await observe.execute({ app: "游戏X" }); // 拉黑中：不派生
    expect(s.calls).toHaveLength(2);
    t0 += OBSERVE_BLACKLIST_TTL_MS + 1; // TTL 过
    await observe.execute({ app: "游戏X" });
    expect(s.calls).toHaveLength(3); // 恢复硬试
  });

  it("换目标（换 key）即刻恢复尝试：别的 app 不吃同一条黑名单", async () => {
    const s = seam({ stdout: emptyObs("游戏X") });
    const t = tools(s);
    const observe = find(t, "screen_observe");
    await observe.execute({ app: "游戏X" });
    await observe.execute({ app: "游戏X" });
    await observe.execute({ app: "游戏X" }); // 游戏X 拉黑
    expect(s.calls).toHaveLength(2);
    await observe.execute({ app: "Safari" }); // 不同 key：即刻可试
    expect(s.calls).toHaveLength(3);
    expect(s.calls[2]!.args[4]).toBe("Safari");
  });

  it("恢复重置：TTL 过后成功观察（非空）→ 计数清零，再次单次空观察不拉黑", async () => {
    let t0 = 1_000_000;
    const now = () => t0;
    // seam：前两次空（游戏X），TTL 后换 Safari 成功表，再对游戏X 空一次
    const s2: ExecSeam = async (file, args) => {
      if (file === HELPER && args[0] === "observe") {
        return args[4] === "游戏X"
          ? { stdout: emptyObs("游戏X"), stderr: "", code: 0 }
          : { stdout: obs({ app: "Safari" }), stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const t = createComputerTools({ exec: s2, platform: "darwin", env: { WUDAO_CLICK_HELPER: HELPER }, helperExists: () => true, now });
    const observe = find(t, "screen_observe");
    await observe.execute({ app: "游戏X" });
    await observe.execute({ app: "游戏X" });
    t0 += OBSERVE_BLACKLIST_TTL_MS + 1;
    await observe.execute({ app: "Safari" }); // 成功 → 计数清零
    const r = await observe.execute({ app: "游戏X" }); // 空一次：count=1 < N
    expect(r.isError).toBeFalsy();
    expect(r.content).not.toContain("不再重复尝试");
  });
});

// ---------------------------------------------------------------------------
// R5 — 名册/回执（九工具名册与挂载序字节钉；summarize observe 例；权限面）
// ---------------------------------------------------------------------------
describe("ω99-247 R5 — 名册与回执面", () => {
  const NINE = ["screen_capture", "computer_type", "computer_key", "computer_click", "app_activate", "app_list", "computer_scroll", "computer_drag", "screen_observe"];

  it("九工具名册：computer 域尾后 append-only（八名序不变，observe 殿后；ω99-250 演进——computer_wait 再殿后，十名=九名+尾）", () => {
    expect(createComputerTools().map((t) => t.name)).toEqual([...NINE, "computer_wait"]);
  });

  it("挂载序字节钉：screen_observe 插在 computer_drag 之后、read_xlsx 之前（212/221/236 邻接钉同形演进；ω99-250 演进——computer_wait 插在 observe 后、read_xlsx 前）", () => {
    const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
    const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
    const names = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 }).map((t) => t.name);
    expect(names.indexOf("screen_capture")).toBe(names.indexOf("make_docx") + 1); // 头侧邻接不变
    expect(names[names.indexOf("computer_drag") + 1]).toBe("screen_observe");
    expect(names[names.indexOf("screen_observe") + 1]).toBe("computer_wait");
    expect(names[names.indexOf("computer_wait") + 1]).toBe("read_xlsx");
  });

  it("读面姿态：isReadOnly=true；不进 DEFAULT_ASK_TOOLS（screen_capture 同档）；四模式与 screen_capture 同判", () => {
    const t = createComputerTools();
    const ob = t.find((x) => x.name === "screen_observe")!;
    expect(ob.isReadOnly?.({})).toBe(true);
    expect(isDefaultAskCall("screen_observe", {})).toBe(false);
    expect(DEFAULT_ASK_TOOLS.has("screen_observe")).toBe(false);
    for (const mode of ["auto", "workspace", "ask", "plan"] as const) {
      expect(decidePermission(mode, "screen_observe")).toEqual(decidePermission(mode, "screen_capture"));
    }
  });

  it("summarize 例：无参 → 前台窗口；带 app → 应用名（log.ts 单源，三前端共用）", () => {
    expect(summarizeToolCall("screen_observe", {})).toBe("前台窗口");
    expect(summarizeToolCall("screen_observe", { app: "Safari" })).toBe("Safari");
  });

  it("click/type 增 ref 参数（schema 在场、无 required 强制坐标）；零删除面（新参数/新工具无 delete/remove 通道）", () => {
    const t = createComputerTools();
    const click = t.find((x) => x.name === "computer_click")!;
    const type = t.find((x) => x.name === "computer_type")!;
    expect(Object.keys(click.parameters.properties)).toContain("ref");
    expect(Object.keys(type.parameters.properties)).toContain("ref");
    expect(click.parameters.required).toBeUndefined(); // ref 或坐标二选一（运行时校验）
    const ob = t.find((x) => x.name === "screen_observe")!;
    for (const key of Object.keys(ob.parameters.properties)) {
      expect(/delete|remove|\brm\b/i.test(key)).toBe(false);
    }
  });

  it("描述口径：observe 描述提 ref 与 screen_capture 出路，零实现术语（无 BFS/AXSearch 词汇）", () => {
    const ob = createComputerTools().find((x) => x.name === "screen_observe")!;
    expect(ob.description).toContain("ref");
    expect(ob.description).toContain("screen_capture");
    expect(ob.description).not.toContain("BFS");
  });
});

// ---------------------------------------------------------------------------
// R6 — Swift helper 源码契约（静态只读；语义钉不可能跑 Swift——以源钉纪律）
// ---------------------------------------------------------------------------
describe("ω99-247 R6 — wudao-click 源码契约（静态）", () => {
  const swiftPath = fileURLToPath(new URL("../../../apps/desktop/src-tauri/helper/wudao-click.swift", import.meta.url));
  const read = () => readFile(swiftPath, "utf8");

  it("observe/press/settext 三子命令在场 + 预算三参解析在场", async () => {
    const src = await read();
    for (const sub of ["observe", "press", "settext"]) {
      expect(src.includes(`"${sub}"`) || src.includes(`== "${sub}"`) || src.includes(`first == "${sub}"`)).toBe(true);
    }
    expect(src).toContain("maxNodes");
    expect(src).toContain("maxDepth");
    expect(src).toContain("maxTextBytes");
  });

  it("secure 纪律（逐字钉）：AXSecureTextField 判定在场且 secure 元素绝不输出 value（if !secure 守卫）", async () => {
    const src = await read();
    expect(src).toContain("AXSecureTextField");
    expect(src).toMatch(/let secure = /);
    expect(src).toMatch(/if !secure \{[\s\S]{0,400}kAXValueAttribute/); // value 读取只在非 secure 分支内
  });

  it("stale 守卫在场：press/settext 前置 sha256 比对（expectedSha）；sha256 随观察输出（WUDAO_END 尾标）", async () => {
    const src = await read();
    expect(src).toContain("expectedSha");
    expect(src).toContain("WUDAO_END");
    expect(src).toContain("WUDAO_OBSERVE");
    expect(src).toContain("WUDAO_WINDOW");
  });

  it("行格式在场：[eN] 编号 + role + 引号标题 + value= 形；★零删除面：helper 源无文件删除 API（无 FileManager/removeItem——Swift 删文件的仅有通路）", async () => {
    const src = await read();
    expect(src).toContain("[e\\(index)]"); // Swift 插值形（e 前缀=与 browser 同一 ref 语法）
    expect(src).toContain("value=");
    expect(src).not.toContain("FileManager");
    expect(src).not.toContain("removeItem");
  });
});
