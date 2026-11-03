// @vitest-environment jsdom
// 139 — 探针仪表盘。钉三面：
//  · aggregate（纯聚合）：model.call/token 三量、工具表按名聚合、turn 统计、
//    60s 速率归桶（窗外事件不计）；
//  · sparklinePoints（纯）：桶 → polyline 视窗坐标；
//  · Dashboard 组件：挂载即 probeRecent+probeStream+probeStats 出线、
//    {t:"probe"} 帧驱动 KPI、关页发 probeStream("off") 停流。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { aggregate, sparklinePoints, Dashboard } from "../src/components/Dashboard.js";
import { WudaoClient } from "../src/protocol.js";
// ProbeEventWire 由 server 导出；web 侧测试用本地最小形状（加性字段照过）。
type ProbeEventWire = { ts: number; cat: "model" | "tool" | "ui" | "system" | "agent"; name: string; data?: Record<string, unknown>; dur?: number; };
import { authOk, fakeServer } from "./mock-ws.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const mount = (el: React.ReactElement): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root?.render(el); });
  return container;
};
afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  document.body.innerHTML = "";
});

const NOW = 1_700_000_000_000;
const row = (over: Partial<ProbeEventWire>): ProbeEventWire =>
  ({ ts: NOW - 1000, cat: "model", name: "model.call", data: {}, ...over }) as ProbeEventWire;

describe("139 — aggregate（纯聚合）", () => {
  it("model.call 计次/均延时/token 三量/失败计数", () => {
    const a = aggregate([
      row({ data: { tokensIn: 1000, tokensOut: 100, cacheHitTokens: 800 }, dur: 900 }),
      row({ data: { tokensIn: 500, tokensOut: 50, cacheHitTokens: 0 }, dur: 100 }),
      row({ name: "model.call", data: { ok: false, tokensIn: 1, tokensOut: 0, cacheHitTokens: 0 }, dur: 10 }),
    ], NOW + 2000);
    expect(a.model.count).toBe(3);
    expect(a.model.avgDur).toBeCloseTo((900 + 100 + 10) / 3, 5);
    expect(a.model.tokensIn).toBe(1501);
    expect(a.model.tokensOut).toBe(150);
    expect(a.model.cacheHit).toBe(800);
    expect(a.model.errs).toBe(1);
  });

  it("tool.finish 按名聚合（次数/均耗时/错误/结果字节）；agent.turn/retry 计面", () => {
    const a = aggregate([
      row({ cat: "tool", name: "tool.finish", data: { name: "read_file", ok: true, resultBytes: 120 }, dur: 20 }),
      row({ cat: "tool", name: "tool.finish", data: { name: "read_file", ok: false, resultBytes: 10 }, dur: 40 }),
      row({ cat: "tool", name: "tool.start", data: { name: "read_file" } }),
      row({ cat: "agent", name: "agent.turn", data: { toolCalls: 2, reasoningChars: 50, answerChars: 80 }, dur: 1200 }),
      row({ cat: "agent", name: "agent.retry", data: { reason: "idle" } }),
    ], NOW);
    expect(a.tools.length).toBe(1);
    expect(a.tools[0]).toMatchObject({ name: "read_file", count: 2, errs: 1, bytes: 120 });
    expect(a.tools[0]!.avgDur).toBe(30);
    expect(a.turns).toMatchObject({ count: 1, toolCalls: 2, reasoningChars: 50, answerChars: 80, retries: 1 });
  });

  it("速率归桶：窗外（>60s）不计，窗内按秒落格", () => {
    const a = aggregate([
      row({ ts: NOW - 500 }),
      row({ ts: NOW - 1500 }),
      row({ ts: NOW - 61_000 }),
    ], NOW);
    expect(a.buckets.reduce((x, y) => x + y, 0)).toBe(2);
    expect(a.buckets[59]).toBe(1); // 0.5s 前 → 最后一格
    expect(a.buckets[58]).toBe(1); // 1.5s 前 → 倒数第二格
  });
});

describe("139 — sparklinePoints（纯）", () => {
  it("空桶与满幅桶都落在视窗内（0..100 × 0..40）", () => {
    const pts = sparklinePoints(new Array(60).fill(0).map((_, i) => (i === 30 ? 9 : 0))).split(" ");
    expect(pts.length).toBe(60);
    for (const p of pts) {
      const [x, y] = p.split(",").map(Number);
      expect(x!).toBeGreaterThanOrEqual(0);
      expect(x!).toBeLessThanOrEqual(100);
      expect(y!).toBeGreaterThanOrEqual(0);
      expect(y!).toBeLessThanOrEqual(40);
    }
  });
});

describe("139 — Dashboard 组件（mock-ws）", () => {
  it("挂载即 probeRecent/probeStats/probeStream 出线；probe 帧驱动 KPI；卸载发 probeStream off 停流", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    // sendOp 断线即拒不排队——先连接鉴权，再挂载（App 面上 connected 同门）。
    act(() => { client.connect(); server.socket.serverOpen(); });
    await act(async () => { authOk(server.socket); });
    const container = mount(<Dashboard client={client} status={null} connected onClose={() => {}} />);
    // 应答三读一订（仪表盘挂载即发）。
    const frames: Array<{ id: number; op: Record<string, unknown> }> = [];
    const answered = new Set<number>();
    // 挂载期排队的 op 在 auth 后分批出线——逐轮排空。
    for (let round = 0; round < 5; round += 1) {
      await act(async () => {
        for (const f of server.clientFrames()) {
          if (typeof f !== "object" || f === null || !("op" in f)) continue;
          const { id, op } = f as { id: number; op: Record<string, unknown> };
          if (answered.has(id)) continue;
          answered.add(id);
          frames.push({ id, op });
          let ok: unknown = true;
          if (op.op === "probeRecent") ok = [row({ data: { tokensIn: 100, tokensOut: 10, cacheHitTokens: 90 }, dur: 300 })];
          else if (op.op === "probeStats") ok = { model: { count: 1 } };
          server.socket.serverSend({ t: "result", id, ok });
        }
      });
    }
    const ops = frames.map((f) => f.op.op);
    expect(ops).toContain("probeRecent");
    expect(ops).toContain("probeStats");
    expect(ops).toContain("probeStream");
    // stats 非零 → 无「开启探针」横幅。
    expect(container.querySelector(".dash-banner")).toBeNull();
    // 实时帧：一条 model.call 推入 → 250ms 节拍后 KPI 更新。
    act(() => { server.socket.serverSend({ t: "probe", event: row({ data: { tokensIn: 1000, tokensOut: 100, cacheHitTokens: 800 }, dur: 900 }) }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    expect(container.textContent).toContain("模型调用");
    // 卸载 → 停流。
    await act(async () => { root?.unmount(); root = null; });
    await act(async () => {});
    const off = server.clientFrames().filter((f) => typeof f === "object" && f !== null && "op" in f && (f as { op?: { op?: string; cat?: string } }).op?.op === "probeStream" && (f as { op?: { cat?: string } }).op?.cat === "off");
    expect(off.length).toBe(1);
  });
});
