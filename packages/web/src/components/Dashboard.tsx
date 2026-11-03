// Dashboard — 139 探针仪表盘（2026-11-03 用户令：把探针内容采集过来做实时
// 展示的默认仪表盘）。数据面三条：
//   · probeRecent（backfill 200）+ probeStream 订阅 → 实时事件（{t:"probe"}
//     帧经 client.onProbe 直通——高频通道不进 React 快照）；
//   · probeStats → 探针总闸状态（全零 + 无事件 → 「开启探针」横幅）；
//   · status（App 传入）→ 当前会话面（模型/忙闲/缓存%/ctx 水位）。
// 聚合在组件内做：模型调用（次数/均延时/token 三量）、工具表（按名聚合
// 次数/均耗时/错误）、回合（次数/均时长/思考与正文字符）、60s 速率
// sparkline。渲染节流 250ms 一拍（事件高频，不逐条重渲）。
import React from "react";
import type { WudaoClient } from "../protocol.js";
import type { DriverStatus } from "../protocol.js";
import { IconClose, IconRefresh } from "./icons.js";

/** 140 — 会话解剖（SessionAnatomyResult.messages 的行读取面）。 */
interface AnatomyRow {
  readonly role?: string;
  readonly content?: string;
  readonly reasoning?: string;
  readonly toolCalls?: readonly { id?: string; name?: string; arguments?: Record<string, unknown> }[];
  readonly toolCallId?: string;
  readonly name?: string;
  readonly isError?: boolean;
}

/** 140 — 实时 LoopEvent 时间线行（{t:"event"} 帧的合并形：工具 start/finish
 * 按 toolCallId 配对；思考/正文 delta 按轮聚合成一段文本）。 */
interface TimelineTool {
  readonly kind: "tool";
  readonly at: number;
  readonly id: string;
  readonly name: string;
  input?: string;
  output?: string;
  isError?: boolean;
  durMs?: number;
}
interface TimelineTurn {
  readonly kind: "turn";
  readonly at: number;
  readonly turn: number;
  reasoning: string;
  answer: string;
}

/** ProbeEvent 的最小读取面（wire 形状，协议加性字段照过）。 */
interface ProbeRow {
  readonly ts: number;
  readonly cat: "model" | "tool" | "ui" | "system" | "agent";
  readonly name: string;
  readonly data?: Record<string, unknown>;
  readonly dur?: number;
}

const CATS = ["model", "tool", "agent", "ui", "system"] as const;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

interface Agg {
  readonly byCat: Record<string, number>;
  readonly model: { count: number; avgDur: number; tokensIn: number; tokensOut: number; cacheHit: number; errs: number };
  readonly tools: readonly { name: string; count: number; avgDur: number; errs: number; bytes: number }[];
  readonly turns: { count: number; avgDur: number; toolCalls: number; reasoningChars: number; answerChars: number; retries: number };
  readonly buckets: readonly number[];
}

/** 纯聚合（导出给测试钉）：events 全量（升序或乱序均可，按 ts 归桶）。 */
export function aggregate(events: readonly ProbeRow[], now: number): Agg {
  const byCat: Record<string, number> = {};
  let mCount = 0; let mDur = 0; let tIn = 0; let tOut = 0; let cHit = 0; let mErr = 0;
  const tools = new Map<string, { count: number; dur: number; errs: number; bytes: number }>();
  let aCount = 0; let aDur = 0; let aTools = 0; let rChars = 0; let aChars = 0; let retries = 0;
  const bucketMs = 1000;
  const span = 60;
  const buckets = new Array<number>(span).fill(0);
  for (const e of events) {
    byCat[e.cat] = (byCat[e.cat] ?? 0) + 1;
    const age = Math.floor((now - e.ts) / bucketMs);
    if (age >= 0 && age < span) buckets[span - 1 - age] = (buckets[span - 1 - age] ?? 0) + 1;
    if (e.cat === "model" && e.name === "model.call") {
      mCount += 1; mDur += num(e.dur);
      tIn += num(e.data?.tokensIn); tOut += num(e.data?.tokensOut); cHit += num(e.data?.cacheHitTokens);
      if (e.data?.ok === false) mErr += 1;
    } else if (e.cat === "tool" && e.name === "tool.finish") {
      const name = String(e.data?.name ?? "?");
      const row = tools.get(name) ?? { count: 0, dur: 0, errs: 0, bytes: 0 };
      row.count += 1; row.dur += num(e.dur); row.bytes = Math.max(row.bytes, num(e.data?.resultBytes ?? 0));
      if (e.data?.ok === false) row.errs += 1;
      tools.set(name, row);
    } else if (e.cat === "agent" && e.name === "agent.turn") {
      aCount += 1; aDur += num(e.dur);
      aTools += num(e.data?.toolCalls); rChars += num(e.data?.reasoningChars); aChars += num(e.data?.answerChars);
    } else if (e.cat === "agent" && e.name === "agent.retry") {
      retries += 1;
    }
  }
  return {
    byCat,
    model: { count: mCount, avgDur: mCount === 0 ? 0 : mDur / mCount, tokensIn: tIn, tokensOut: tOut, cacheHit: cHit, errs: mErr },
    tools: [...tools.entries()].map(([name, r]) => ({ name, count: r.count, avgDur: r.dur / r.count, errs: r.errs, bytes: r.bytes }))
      .sort((a, b) => b.count - a.count).slice(0, 12),
    turns: { count: aCount, avgDur: aCount === 0 ? 0 : aDur / aCount, toolCalls: aTools, reasoningChars: rChars, answerChars: aChars, retries },
    buckets,
  };
}

/** 纯 sparkline（导出给测试钉）：60 桶 → polyline points（0..100,0..40 视窗）。 */
export function sparklinePoints(buckets: readonly number[]): string {
  const max = Math.max(1, ...buckets);
  return buckets.map((v, i) => `${((i / (buckets.length - 1)) * 100).toFixed(2)},${(40 - (v / max) * 38).toFixed(2)}`).join(" ");
}

export function Dashboard({ client, status, connected, onClose }: {
  readonly client: WudaoClient;
  readonly status: DriverStatus | null;
  /** 断线不开订（sendOp 断线即拒不排队——📎 同规则）；重连带回时效果重挂。 */
  readonly connected: boolean;
  readonly onClose: () => void;
}): React.JSX.Element {
  const buffer = React.useRef<ProbeRow[]>([]);
  const [tick, setTick] = React.useState(0);
  const [cat, setCat] = React.useState<string>("*");
  const [paused, setPaused] = React.useState(false);
  const [gate, setGate] = React.useState<"unknown" | "off" | "on">("unknown");
  // 140 — 会话解剖：系统提示词 + 消息链（打开/刷新时拉取）+ 实时 LoopEvent
  // 时间线（{t:"event"} 帧：思考/正文 delta 按轮聚合、工具入参出参配对）。
  const [anatomy, setAnatomy] = React.useState<{ systemPrompt: string; messages: AnatomyRow[] } | null>(null);
  const timeline = React.useRef<Array<TimelineTool | TimelineTurn>>([]);
  const [tab, setTab] = React.useState<"events" | "anatomy">("events");
  const pausedRef = React.useRef(false);
  pausedRef.current = paused;

  React.useEffect(() => {
    if (!connected) return;
    let alive = true;
    // backfill + 订阅 + 统计面（全零且无回填 → 判定总闸关）。
    void client.probeRecent(undefined, 200).then((rows) => {
      if (!alive || !Array.isArray(rows)) return;
      buffer.current = [...rows.slice(-500).map((r) => r as ProbeRow), ...buffer.current].slice(-500);
      setTick((t) => t + 1);
    }).catch(() => { /* 老 server：无回填，横幅照常提示 */ });
    void client.probeStats().then((s) => {
      if (!alive) return;
      const total = Object.values(s ?? {}).reduce((a: number, v) => a + (typeof v === "object" && v !== null && "count" in v ? num((v as { count?: unknown }).count) : 0), 0);
      setGate(total === 0 && buffer.current.length === 0 ? "off" : "on");
    }).catch(() => { /* 老 server：未知态 */ });
    void client.probeStream().catch(() => { /* 老 server：无流 */ });
    const off = client.onProbe((ev) => {
      if (pausedRef.current) return;
      buffer.current.push(ev as ProbeRow);
      if (buffer.current.length > 500) buffer.current.splice(0, buffer.current.length - 500);
    });
    // 140：解剖快照（重开/刷新时重拉）+ 实时时间线（思考/正文/工具全量）。
    void client.sessionAnatomy().then((a) => {
      if (!alive) return;
      setAnatomy({ systemPrompt: a.systemPrompt, messages: (a.messages ?? []) as unknown as AnatomyRow[] });
    }).catch(() => { /* 老 server：面板显示暂无 */ });
    const offLoop = client.onLoopEvent((ev, at) => {
      if (pausedRef.current) return;
      const e = ev as { type?: string; turn?: number; text?: string; toolCallId?: string; toolName?: string; input?: unknown; result?: unknown; isError?: boolean; durationMs?: number };
      const tl = timeline.current;
      if (e.type === "reasoning_delta" || e.type === "assistant_delta") {
        const last = tl[tl.length - 1];
        if (last !== undefined && last.kind === "turn" && last.turn === (e.turn ?? 0)) {
          if (e.type === "reasoning_delta") last.reasoning += e.text ?? "";
          else last.answer += e.text ?? "";
        } else {
          tl.push({ kind: "turn", at, turn: e.turn ?? 0, reasoning: e.type === "reasoning_delta" ? (e.text ?? "") : "", answer: e.type === "assistant_delta" ? (e.text ?? "") : "" });
        }
      } else if (e.type === "tool_call_started") {
        tl.push({ kind: "tool", at, id: e.toolCallId ?? "?", name: e.toolName ?? "?", input: safeJson(e.input) });
      } else if (e.type === "tool_call_finished") {
        const row = [...tl].reverse().find((r) => r.kind === "tool" && r.id === e.toolCallId);
        if (row !== undefined && row.kind === "tool") {
          row.output = typeof e.result === "string" ? e.result : safeJson(e.result);
          row.isError = e.isError === true;
          row.durMs = e.durationMs;
        }
      }
      if (tl.length > 300) tl.splice(0, tl.length - 300);
    });
    // 渲染节流：250ms 一拍（高频事件不逐条重渲）。
    const timer = setInterval(() => setTick((t) => t + 1), 250);
    return () => {
      alive = false;
      off();
      offLoop();
      clearInterval(timer);
      // 关页停流（单过滤槽的退订语义）。
      void client.probeStream("off").catch(() => { /* 断连中：服务端连接级清理 */ });
    };
  }, [client, connected]);

  const agg = React.useMemo(() => aggregate(buffer.current, Date.now()), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const stream = React.useMemo(
    () => buffer.current.filter((e) => cat === "*" || e.cat === cat).slice(-60).reverse(), // eslint-disable-line react-hooks/exhaustive-deps
    [tick, cat],
  );
  const enable = (): void => {
    void client.probeEnable(true).then(() => {
      setGate("on");
      buffer.current = [];
      setTick((t) => t + 1);
    }).catch(() => { /* 老 server 拒答：保持提示 */ });
  };

  return (
    <div className="dash" data-testid="dash">
      <div className="dash-head">
        <h2>监控</h2>
        <span className="k" style={{ color: "var(--text-2)" }}>
          {status?.model?.label ?? "-"} · {status?.busy ? "运行中" : "空闲"}
          {status?.cachePercent != null ? ` · 缓存 ${status.cachePercent}%` : ""}
          {status?.ctxTokens != null && status.ctxTokens.used != null ? ` · ctx ${fmtTok(status.ctxTokens.used)}/${fmtTok(status.ctxTokens.window)}` : ""}
        </span>
        <span className="spacer" />
        {/* 140：两页——探针（计数/聚合/事件流）与会话解剖（全量提示词/消息/实时时间线）。 */}
        <div className="dash-cat-chips" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "events"} className={tab === "events" ? "on" : undefined} onClick={() => setTab("events")}>探针</button>
          <button type="button" role="tab" aria-selected={tab === "anatomy"} className={tab === "anatomy" ? "on" : undefined} onClick={() => setTab("anatomy")}>会话解剖</button>
        </div>
        <button type="button" className="icobtn" aria-label="返回会话" title="返回会话" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      {tab === "events" && gate === "off" ? (
        <div className="dash-banner" role="status">
          探针总闸未开启（WUDAO_PROBE）——开启后 agent/工具事件下一轮起可见；model.call 计量需带 WUDAO_PROBE=on 重启生效。
          <button type="button" onClick={enable}>现在开启</button>
        </div>
      ) : null}

      {tab === "events" ? (
      <>
      <div className="dash-kpis">
        <div className="dash-kpi"><span className="k">模型调用</span><span className="v">{agg.model.count}</span><span className="s">均 {fmtMs(agg.model.avgDur)}{agg.model.errs > 0 ? ` · 败 ${agg.model.errs}` : ""}</span></div>
        <div className="dash-kpi"><span className="k">Token 流量</span><span className="v">{fmtTok(agg.model.tokensIn + agg.model.tokensOut)}</span><span className="s">入 {fmtTok(agg.model.tokensIn)} · 出 {fmtTok(agg.model.tokensOut)} · 缓存命中 {fmtTok(agg.model.cacheHit)}</span></div>
        <div className="dash-kpi"><span className="k">工具调用</span><span className="v">{(agg.byCat.tool ?? 0) / 2 >= 0 ? Math.round((agg.byCat.tool ?? 0) / 2) : 0}</span><span className="s">完成 {(agg.byCat.tool ?? 0) % 2 === 0 ? (agg.byCat.tool ?? 0) / 2 : Math.floor((agg.byCat.tool ?? 0) / 2)}（start+finish 合计 {agg.byCat.tool ?? 0} 帧）</span></div>
        <div className="dash-kpi"><span className="k">回合</span><span className="v">{agg.turns.count}</span><span className="s">均 {fmtMs(agg.turns.avgDur)} · 工具 {agg.turns.toolCalls} · 重试 {agg.turns.retries}</span></div>
        <div className="dash-kpi"><span className="k">思考/正文</span><span className="v">{fmtTok(agg.turns.reasoningChars)}/{fmtTok(agg.turns.answerChars)}</span><span className="s">累计字符</span></div>
      </div>

      <div className="dash-chart">
        <span className="k">事件速率 · 近 60s（每秒一格）</span>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
          <polyline fill="none" stroke="currentColor" strokeWidth="1" points={sparklinePoints(agg.buckets)} />
        </svg>
      </div>

      <div className="dash-cols">
        <div className="dash-panel">
          <div className="dash-panel-head">工具聚合（按完成次数）</div>
          <div className="dash-scroll">
            {agg.tools.length === 0 ? <div className="dash-empty">暂无工具事件</div> : (
              <table className="dash-tools">
                <thead><tr><th>工具</th><th>次数</th><th>均耗时</th><th>错误</th><th>结果B</th></tr></thead>
                <tbody>
                  {agg.tools.map((t) => (
                    <tr key={t.name}><td>{t.name}</td><td>{t.count}</td><td>{fmtMs(t.avgDur)}</td><td>{t.errs > 0 ? t.errs : ""}</td><td>{t.bytes > 0 ? fmtTok(t.bytes) : ""}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="dash-panel">
          <div className="dash-panel-head">
            实时事件
            <span className="spacer" />
            <div className="dash-cat-chips">
              {["*", ...CATS].map((c) => (
                <button key={c} type="button" className={cat === c ? "on" : undefined} onClick={() => setCat(c)}>{c === "*" ? "全部" : c}</button>
              ))}
            </div>
            <button type="button" className="icobtn" aria-label={paused ? "继续" : "暂停"} title={paused ? "继续" : "暂停"} onClick={() => setPaused((v) => !v)}>{paused ? "继续" : "暂停"}</button>
          </div>
          <div className="dash-scroll dash-stream">
            {stream.length === 0 ? <div className="dash-empty">等待事件…（发一条消息试试）</div> : stream.map((e, i) => (
              <div key={`${e.ts}:${e.name}:${i}`} className={`dash-row cat-${e.cat}`}>
                <span className="t">{new Date(e.ts).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                <span className={`c cat-${e.cat}`}>{e.cat}</span>
                <span className="n">{e.name}</span>
                <span className="d">{e.dur !== undefined ? `${fmtMs(e.dur)} ` : ""}{e.data !== undefined ? summarize(e) : ""}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      </>
      ) : null}

      {/* 140 — 会话解剖：系统提示词 + 消息链全量 + 实时时间线（思考/工具入参出参）。 */}
      {tab === "anatomy" ? (
        <div className="dash-cols dash-anatomy">
          <div className="dash-panel">
            <div className="dash-panel-head">
              持久上下文（{anatomy?.messages.length ?? 0} 条）
              <span className="spacer" />
              <button type="button" className="icobtn" aria-label="刷新" title="刷新" onClick={() => {
                void client.sessionAnatomy().then((a) => setAnatomy({ systemPrompt: a.systemPrompt, messages: (a.messages ?? []) as unknown as AnatomyRow[] })).catch(() => { /* 保持 */ });
              }}><IconRefresh /></button>
            </div>
            <div className="dash-scroll">
              <details className="dash-prompt">
                <summary>系统提示词 · {anatomy?.systemPrompt.length ?? 0} 字</summary>
                <pre>{anatomy?.systemPrompt ?? "（暂无——老 server 或无缝）"}</pre>
              </details>
              {anatomy === null ? <div className="dash-empty">读取中…</div> : anatomy.messages.length === 0 ? <div className="dash-empty">（空会话）</div> : anatomy.messages.map((m, i) => (
                <MessageRow key={i} row={m} />
              ))}
            </div>
          </div>
          <div className="dash-panel">
            <div className="dash-panel-head">实时时间线（思考 / 工具入参·出参·异常）</div>
            <div className="dash-scroll dash-stream">
              {timeline.current.length === 0 ? <div className="dash-empty">等待事件…（发一条消息，思考与工具调用会实时出现在这里）</div> : [...timeline.current].reverse().map((r, i) => (
                r.kind === "turn" ? (
                  <div key={`t${i}`} className="dash-row">
                    <span className="t">{new Date(r.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                    <span className="c">turn{r.turn}</span>
                    {r.reasoning !== "" ? <details className="dash-detail"><summary>思考 · {r.reasoning.length} 字</summary><pre>{r.reasoning}</pre></details> : null}
                    {r.answer !== "" ? <details className="dash-detail" open={true}><summary>正文 · {r.answer.length} 字</summary><pre>{r.answer}</pre></details> : null}
                  </div>
                ) : (
                  <div key={`t${i}`} className="dash-row">
                    <span className="t">{new Date(r.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                    <span className="c" style={r.isError === true ? { color: "var(--danger)" } : undefined}>{r.isError === true ? "异常" : "工具"}</span>
                    <details className="dash-detail">
                      <summary>{r.name}{r.durMs !== undefined ? ` · ${fmtMs(r.durMs)}` : ""}{r.isError === true ? " · 异常" : ""}</summary>
                      {r.input !== undefined ? <pre>{`入参
${r.input}`}</pre> : null}
                      {r.output !== undefined ? <pre>{`出参
${r.output}`}</pre> : null}
                    </details>
                  </div>
                )
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 解剖面板的一行消息：角色徽标 + 内容/思考/工具调用（全展开态收在 details）。 */
function MessageRow({ row }: { readonly row: AnatomyRow }): React.JSX.Element {
  const role = row.role ?? "?";
  return (
    <div className={`dash-msg role-${role}`}>
      <div className="dash-msg-head">
        <span className="role">{role === "tool" ? `tool·${row.name ?? row.toolCallId ?? "?"}` : role}</span>
        {row.isError === true ? <span className="err">异常</span> : null}
      </div>
      {typeof row.reasoning === "string" && row.reasoning !== "" ? (
        <details className="dash-detail"><summary>思考 · {row.reasoning.length} 字</summary><pre>{row.reasoning}</pre></details>
      ) : null}
      {row.toolCalls !== undefined && row.toolCalls.length > 0 ? (
        <details className="dash-detail" open={true}><summary>工具调用 · {row.toolCalls.length} 个</summary>
          {row.toolCalls.map((c, i) => <pre key={i}>{`${c.name ?? "?"}(${safeJson(c.arguments)})`}</pre>)}
        </details>
      ) : null}
      {typeof row.content === "string" && row.content !== "" ? (
        <details className="dash-detail" open={role === "user"}><summary>{role === "user" ? "用户提示词" : "内容"} · {row.content.length} 字</summary><pre>{row.content}</pre></details>
      ) : null}
    </div>
  );
}

const safeJson = (v: unknown): string => {
  try { return JSON.stringify(v) ?? ""; } catch { return String(v); }
};

/** 一行摘要：每类事件挑最可读的两三个字段（截 60 字）。 */
function summarize(e: ProbeRow): string {
  const d = e.data ?? {};
  const parts: string[] = [];
  if (typeof d.model === "string") parts.push(d.model);
  if (typeof d.name === "string") parts.push(d.name);
  if (typeof d.toolCalls === "number") parts.push(`工具×${d.toolCalls}`);
  if (typeof d.reasoningChars === "number" && d.reasoningChars > 0) parts.push(`思${d.reasoningChars}字`);
  if (typeof d.answerChars === "number" && d.answerChars > 0) parts.push(`文${d.answerChars}字`);
  if (typeof d.reason === "string") parts.push(d.reason);
  if (d.ok === false) parts.push("失败");
  const s = parts.join(" ");
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}
