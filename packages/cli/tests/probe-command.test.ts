// PB-2（探针基础设施弧）— CLI 域三件的测试，先红后绿：
// ① 本地 bus 桩（PB-1 接口形状）：环形缓冲/类别过滤/stats 按 name 计数/订阅；
// ② /probe 命令面：parseProbeArgs 语法门 + formatProbeReport 表格（recent 表
//    /stats 面/空态/用法回执）；
// ③ JSONL 审计：写入+逐行回放格式、有序写链、零事件零文件、关闭后零写、
//    落盘失败静默吞（审计绝不阻塞执行）、setupProbeAudit 的 boot notice
//    「探针审计已开启 → <path>」与缺省零变化。
// 夹具全在 os.tmpdir()（217 式样；红线：绝不写工作区、绝不删用户文件）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LayeredSettings } from "../src/settings-layer.js";
import {
  createLocalProbeBus,
  getDefaultProbeBus,
  resetDefaultProbeBus,
  parseProbeArgs,
  formatProbeReport,
  fmtAgo,
  openProbeAudit,
  probeAuditPathFromSettings,
  setupProbeAudit,
  PROBE_RING_CAP,
  type ProbeEventWire,
} from "../src/probe.js";

const ev = (cat: ProbeEventWire["cat"], name: string, ts: number, extra?: Partial<ProbeEventWire>): ProbeEventWire =>
  ({ ts, cat, name, data: { k: name }, ...extra });

const clock = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const tmpdirs: string[] = [];
afterEach(async () => {
  resetDefaultProbeBus();
  for (const d of tmpdirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const tmp = async (prefix = "probe-pb2-"): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpdirs.push(d);
  return d;
};

describe("PB-2 本地 bus（PB-1 接口形状）", () => {
  it("环形缓冲有界：超帽丢最旧；recent 支持类别过滤与尾窗 limit", () => {
    const bus = createLocalProbeBus(3);
    bus.emit(ev("model", "m1", 1));
    bus.emit(ev("tool", "t1", 2));
    bus.emit(ev("model", "m2", 3));
    bus.emit(ev("ui", "u1", 4)); // 帽 3 → m1 被挤出
    expect(bus.recent().map((e) => e.name)).toEqual(["t1", "m2", "u1"]);
    expect(bus.recent("model").map((e) => e.name)).toEqual(["m2"]);
    expect(bus.recent(undefined, 1).map((e) => e.name)).toEqual(["u1"]);
    expect(bus.recent("model", 10).map((e) => e.name)).toEqual(["m2"]);
  });

  it("缺省帽 = PROBE_RING_CAP；stats 按 name 计数（count/lastTs 跟随最新）", () => {
    const bus = createLocalProbeBus();
    bus.emit(ev("model", "model.call", 10));
    bus.emit(ev("model", "model.call", 12));
    bus.emit(ev("tool", "tool.run", 15));
    expect(bus.stats()).toEqual({
      "model.call": { count: 2, lastTs: 12 },
      "tool.run": { count: 1, lastTs: 15 },
    });
    // 订阅面：类别订阅只收本类别；退订后零收。
    const gotModel: string[] = [];
    const gotAll: string[] = [];
    const offM = bus.subscribe("model", (e) => gotModel.push(e.name));
    const offA = bus.subscribe("*", (e) => gotAll.push(e.name));
    bus.emit(ev("ui", "ui.render", 20));
    bus.emit(ev("model", "model.call", 21));
    offM();
    bus.emit(ev("model", "model.call", 22));
    expect(gotModel).toEqual(["model.call"]);
    expect(gotAll).toEqual(["ui.render", "model.call", "model.call"]);
    expect(PROBE_RING_CAP).toBeGreaterThan(0);
  });
});

describe("PB-2 /probe 解析", () => {
  it("裸 /probe=全部 20 条；[cat]=类别；[cat] [N]=尾窗；stats=统计面", () => {
    expect(parseProbeArgs("")).toEqual({ kind: "recent", limit: 20 });
    expect(parseProbeArgs("  ")).toEqual({ kind: "recent", limit: 20 });
    expect(parseProbeArgs("model")).toEqual({ kind: "recent", cat: "model", limit: 20 });
    expect(parseProbeArgs("tool 5")).toEqual({ kind: "recent", cat: "tool", limit: 5 });
    expect(parseProbeArgs("* 3")).toEqual({ kind: "recent", limit: 3 });
    expect(parseProbeArgs("stats")).toEqual({ kind: "stats" });
  });

  it("坏语法 → 用法回执（bad 不猜：裸数字/未知类别/坏条数/多余参数）", () => {
    expect(parseProbeArgs("5").kind).toBe("bad");
    expect(parseProbeArgs("bogus").kind).toBe("bad");
    expect(parseProbeArgs("model x").kind).toBe("bad");
    expect(parseProbeArgs("model 0").kind).toBe("bad");
    expect(parseProbeArgs("model 2 extra").kind).toBe("bad");
    expect(parseProbeArgs("stats 5").kind).toBe("bad");
    expect(parseProbeArgs("model").kind).toBe("recent");
  });
});

describe("PB-2 /probe 渲染", () => {
  it("recent 表：时间/类别/名称/耗时/关键字段（lane/sid 缀前）；头行带类别", () => {
    const bus = createLocalProbeBus();
    bus.emit(ev("model", "model.call", 1726550000000, { dur: 812, lane: "main", sessionId: "wudao-12345678", data: { model: "glm-4.7", tokens: 1234 } }));
    const out = formatProbeReport(bus, { kind: "recent", limit: 20 });
    expect(out.split("\n")[0]).toBe("最近 1 条探针事件：");
    const row = out.split("\n")[1]!;
    expect(row).toContain(clock(1726550000000));
    expect(row).toContain("model");
    expect(row).toContain("model.call");
    expect(row).toContain("812ms");
    expect(row).toContain("lane=main");
    expect(row).toContain("sid=wudao-12");
    expect(row).toContain("model=glm-4.7");
    expect(row).toContain("tokens=1234");
  });

  it("cat 过滤的头行；无 dur 渲染 -；空态两种文案", () => {
    const bus = createLocalProbeBus();
    bus.emit(ev("tool", "tool.run", 5));
    const out = formatProbeReport(bus, { kind: "recent", cat: "tool", limit: 5 });
    expect(out.split("\n")[0]).toBe("最近 1 条探针事件（类别 tool）：");
    expect(out.split("\n")[1]).not.toContain("ms");
    expect(formatProbeReport(createLocalProbeBus(), { kind: "recent", limit: 5 })).toBe("探针缓冲为空（还没有事件）");
    expect(formatProbeReport(createLocalProbeBus(), { kind: "recent", cat: "ui", limit: 5 })).toBe("探针缓冲为空（类别 ui 还没有事件）");
  });

  it("stats 面：按计数降序 + 最后 X 前（now 注入确定性）；空态", () => {
    const bus = createLocalProbeBus();
    bus.emit(ev("model", "model.call", 1000));
    bus.emit(ev("model", "model.call", 3000));
    bus.emit(ev("tool", "tool.run", 12000));
    const out = formatProbeReport(bus, { kind: "stats" }, () => 15250);
    expect(out.split("\n")[0]).toBe("探针统计面：");
    expect(out).toContain("model.call");
    expect(out).toContain("×    2");
    expect(out).toContain("最后 12.3s 前"); // (15250-3000)/1000=12.25 → toFixed(1) 12.3
    expect(out).toContain("tool.run");
    expect(out).toContain("×    1");
    expect(formatProbeReport(createLocalProbeBus(), { kind: "stats" })).toBe("探针统计面：空（还没有事件）");
    expect(fmtAgo(500)).toBe("500ms");
    expect(fmtAgo(65_000)).toBe("1m5s");
  });

  it("bad 语法 → ⚠️ 用法回执（不抛、不碰 bus）", () => {
    expect(formatProbeReport(createLocalProbeBus(), parseProbeArgs("nope"))).toContain("⚠️");
    expect(formatProbeReport(createLocalProbeBus(), parseProbeArgs("nope"))).toContain("/probe [model|tool|ui|system|agent|*] [N]");
  });
});

describe("PB-2 JSONL 审计", () => {
  it("每条事件一行 JSON，逐行回放=原事件；写链有序", async () => {
    const dir = await tmp();
    const path = join(dir, "audit", "probe.jsonl");
    const bus = createLocalProbeBus();
    const sink = openProbeAudit(bus, path);
    const e1 = ev("model", "model.call", 1, { dur: 9 });
    const e2 = ev("tool", "tool.run", 2, { lane: "L1" });
    bus.emit(e1);
    bus.emit(e2);
    await sink.flush();
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(e1);
    expect(JSON.parse(lines[1]!)).toEqual(e2);
    sink.close();
  });

  it("零事件零文件（懒创建）；关闭后零写", async () => {
    const dir = await tmp();
    const path = join(dir, "probe.jsonl");
    const bus = createLocalProbeBus();
    const sink = openProbeAudit(bus, path);
    await sink.flush();
    await expect(stat(path)).rejects.toThrow(); // 未创建
    sink.close();
    bus.emit(ev("ui", "ui.render", 3));
    await new Promise((r) => setTimeout(r, 30));
    await expect(stat(path)).rejects.toThrow(); // 退订后仍零文件
  });

  it("落盘失败静默吞（审计不阻塞执行：emit 不抛、进程不炸）", async () => {
    const dir = await tmp();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not-a-dir"); // 父路径是文件 → mkdir/append 必败
    const bus = createLocalProbeBus();
    const sink = openProbeAudit(bus, join(blocker, "probe.jsonl"));
    expect(() => bus.emit(ev("system", "sys.tick", 4))).not.toThrow();
    await sink.flush();
    await sink.flush();
    sink.close();
  });
});

describe("PB-2 setupProbeAudit（boot 装配）", () => {
  const layeredWith = (record: Record<string, unknown>): typeof loadLayeredSettings =>
    (async () => ({ effective: record }) as unknown as LayeredSettings) as unknown as typeof loadLayeredSettings;

  it("设置 probe.auditFile → 默认 bus 开审计 + notice 逐字「探针审计已开启 → <path>」", async () => {
    const dir = await tmp();
    const path = join(dir, "probe-audit.jsonl");
    const notices: string[] = [];
    const got = await setupProbeAudit({
      workspaceRoot: dir,
      out: (line) => notices.push(line),
      loadSettings: layeredWith({ probe: { auditFile: path } }),
    });
    expect(got).toBe(path);
    expect(notices).toEqual([`探针审计已开启 → ${path}`]);
    // 装配在默认 bus 上：之后 emit 进单例的事件落盘。
    getDefaultProbeBus().emit(ev("agent", "agent.spawn", 7));
    await new Promise((r) => setTimeout(r, 50));
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(JSON.parse(lines[0]!)).toEqual(ev("agent", "agent.spawn", 7));
  });

  it("缺省零变化：无设置/坏形状 → 零 notice 零 IO", async () => {
    const notices: string[] = [];
    for (const record of [{}, { probe: {} }, { probe: { auditFile: "  " } }, { probe: { auditFile: 42 } }, { probe: "x" }]) {
      const got = await setupProbeAudit({
        workspaceRoot: await tmp(),
        out: (line) => notices.push(line),
        loadSettings: layeredWith(record),
      });
      expect(got).toBeUndefined();
    }
    expect(notices).toEqual([]);
  });

  it("probeAuditPathFromSettings 形状门：非空字符串才开", () => {
    expect(probeAuditPathFromSettings({ probe: { auditFile: "/tmp/a.jsonl" } })).toBe("/tmp/a.jsonl");
    expect(probeAuditPathFromSettings({})).toBeUndefined();
    expect(probeAuditPathFromSettings({ probe: null })).toBeUndefined();
    expect(probeAuditPathFromSettings({ probe: [1] })).toBeUndefined();
    expect(probeAuditPathFromSettings({ probe: { auditFile: "" } })).toBeUndefined();
  });
});
