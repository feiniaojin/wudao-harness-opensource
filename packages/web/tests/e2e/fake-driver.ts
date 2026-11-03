// PB-3 E2E — the scripted fake driver (test double)。不挂真模型：每个会话
// 挂一份「剧本」（FakeTurn[]），第 N 次 submit 回放第 N 条预设回合；状态
// （busy / 会话表 / 设置 / 回收站 / 虚拟文件树）全部可编程。结构化满足
// @wudao-org/server 的 UiDriverPort + LaneDriverPort（本包不 import server ——
// pnpm 隔离下 web 解析不到它，这里用纯结构形状对接，server 侧结构收货）。
//
// 回放纪律（对齐真 driver 的帧面）：
//   - 状态：任何变化 → emitStatus()（server 会重读全表车道推一帧 state）
//   - 历史：append 走 onHistory(entries, false)；轮转/采纳走 (entries, true)
//   - busy：submit 起翻 true，回放完翻 false；hold 回合停在中途直到 finishTurn()
import type { HistoryEntry } from "../../src/protocol.js";

/** 一条改动收据（ChangesPanel 聚合的数据源，notice.changes 的行形状）。 */
export interface FakeChange {
  readonly path: string;
  readonly op: "created" | "modified";
  readonly writes: number;
  readonly plus?: number;
  readonly minus?: number;
}

/** 一个回合的剧本：第 N 次 submit 回放第 N 条（越界回退到最后一条）。 */
export interface FakeTurn {
  /** assistant 条目文本；缺省「已收到：<原文>」。 */
  readonly reply?: string;
  /** 落定 assistant 条目携带的 reasoning 切片（流式 reasoning 由 live 帧回放）。 */
  readonly reasoning?: string;
  /** 回合收尾的 notice 条目（可带 changes —— 改动面板/chip 的数据源）。 */
  readonly notice?: { readonly text: string; readonly changes?: readonly FakeChange[] };
  /** 停在 busy 直到 finishTurn(sessionId)——多车道/断连用。 */
  readonly hold?: boolean;
  /** 以 error 条目代替回复（error 注入）。 */
  readonly error?: string;
  /** 回放延迟（默认 30ms）；live 流间隔取其 1/3。 */
  readonly delayMs?: number;
  /** busy 期间推几帧 live（reasoning → answer 增量）——0 = 不推。默认 2。 */
  readonly liveChunks?: number;
}

/** 种子会话：历史/首句/剧本全部可预制。 */
export interface FakeSeed {
  readonly id: string;
  readonly name?: string;
  readonly firstUser?: string;
  readonly entries?: readonly HistoryEntry[];
  /** 本会话的回合剧本；缺省 [{reply:"已收到：…"}]。 */
  readonly script?: readonly FakeTurn[];
}

/** 虚拟文件树的一行（fileTree 的行形状，dirs first 由 fake 自己排）。 */
export interface FakeFile {
  readonly path: string;
  readonly type: "file" | "dir";
  readonly content?: string;
}

interface SessionRec {
  id: string;
  name: string | null;
  firstUser: string;
  history: HistoryEntry[];
  mtime: string;
  messages: number;
  script: readonly FakeTurn[];
  turnIdx: number;
  busy: boolean;
  holdRelease: (() => void) | null;
  /** finishTurn 先于 hold 点到达时的落点（防丢：否则回合停死在 hold 上）。 */
  finishRequested: boolean;
  inTrash: boolean;
  /** live 帧的在飞内容（reasoning 流可见面）。 */
  liveReasoning: string;
  liveAnswer: string;
}

const MODEL = "fake-reasoner-v1";
const nowIso = (): string => new Date().toISOString();
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 剧本越界回退：空剧本给一条默认回合，末条之后重复末条。 */
function turnAt(script: readonly FakeTurn[], idx: number): FakeTurn {
  if (script.length === 0) return {};
  return script[Math.min(idx, script.length - 1)] ?? {};
}

export class FakeDriver {
  /** 会话表（id → 记录）。 */
  private readonly recs = new Map<string, SessionRec>();
  private readonly statusCbs = new Set<() => void>();
  private readonly historyCbs = new Set<(entries: readonly unknown[], reset: boolean) => void>();
  private readonly laneHistoryCbs = new Set<(sid: string, entries: readonly unknown[], reset: boolean) => void>();
  /** 可编程设置表（settingsSet 落这里，settingsStatus 回读这里）。 */
  readonly settings: Record<string, unknown> = {
    "ui.defaultMode": "buddy",
    "ui.theme": "dark",
    "ui.accent": "green",
    "language.reply": "auto",
    "language.reasoning": "auto",
  };
  /** 虚拟文件树（fileTree/fileRead 的数据源）。 */
  files: readonly FakeFile[] = [
    { path: "README.md", type: "file", content: "# wudao\n\nE2E fixture file.\n" },
    { path: "src", type: "dir" },
    { path: "src/index.ts", type: "file", content: "export function main(): void {\n  console.log(\"wudao e2e\");\n}\n" },
    { path: "src/util.ts", type: "file", content: "export const answer = 42;\n" },
  ];
  /** 主车道当前会话 id（/clear 与 rotateMain 轮转它）。 */
  mainSessionId: string;
  /** 新建会话（/clear 轮转、车道采纳未知 id）的兜底剧本。 */
  defaultScript: readonly FakeTurn[] = [];

  constructor(mainId = "wudao-e2e-main", seeds: readonly FakeSeed[] = []) {
    this.mainSessionId = mainId;
    this.ensureSession(mainId, "E2E 主会话");
    for (const s of seeds) this.seed(s);
  }

  // ---- 种子与可编程面 ----------------------------------------------------

  seed(s: FakeSeed): void {
    const rec = this.ensureSession(s.id, s.firstUser ?? s.name ?? "");
    if (s.name !== undefined) rec.name = s.name;
    if (s.firstUser !== undefined) rec.firstUser = s.firstUser;
    if (s.entries !== undefined) {
      rec.history = [...s.entries];
      rec.messages = s.entries.filter((e) => e.kind === "user" || e.kind === "assistant").length;
    }
    if (s.script !== undefined) rec.script = s.script;
    rec.mtime = nowIso();
  }

  /** 手动翻 busy（多车道徽标等 UI 态的注入面）。 */
  setBusy(id: string, busy: boolean): void {
    const rec = this.recs.get(id);
    if (rec === undefined || rec.busy === busy) return;
    rec.busy = busy;
    this.emitStatus();
  }

  /** 释放一个 hold 回合：走完回放尾巴（回复 + busy=false）。先于 hold 点
   *  到达也不丢（finishRequested 落点，尾巴到 hold 点时直接放行）。 */
  finishTurn(id: string): void {
    const rec = this.recs.get(id);
    if (rec === undefined) return;
    rec.finishRequested = true;
    const release = rec.holdRelease;
    rec.holdRelease = null;
    if (release !== null) release();
  }

  /** 会话史快照（断言面）。 */
  historyOf(id: string): readonly HistoryEntry[] {
    return [...(this.recs.get(id)?.history ?? [])];
  }

  /** 该会话当前是否在回收站（Node 侧断言面）。 */
  isTrashed(id: string): boolean {
    return this.recs.get(id)?.inTrash ?? false;
  }

  /** 主车道当前史（server auth 重放的数据源）。 */
  mainHistory(): readonly HistoryEntry[] {
    return this.historyOf(this.mainSessionId);
  }

  /** 被 op 看见的会话行（sessions()/trashSessions() 的数据源）。 */
  private rows(trash: boolean): unknown[] {
    const out: unknown[] = [];
    for (const r of this.recs.values()) {
      if (r.inTrash !== trash) continue;
      out.push({
        id: r.id,
        mtime: r.mtime,
        messages: r.messages,
        firstUser: r.firstUser,
        model: MODEL,
        ...(r.name !== null ? { name: r.name } : {}),
      });
    }
    return out;
  }

  private ensureSession(id: string, firstUser: string): SessionRec {
    let rec = this.recs.get(id);
    if (rec === undefined) {
      rec = {
        id,
        name: null,
        firstUser,
        history: [],
        mtime: nowIso(),
        messages: 0,
        script: this.defaultScript,
        turnIdx: 0,
        busy: false,
        holdRelease: null,
        finishRequested: false,
        inTrash: false,
        liveReasoning: "",
        liveAnswer: "",
      };
      this.recs.set(id, rec);
    }
    return rec;
  }

  // ---- 事件面（server 订阅） ----------------------------------------------

  private emitStatus(): void {
    for (const cb of [...this.statusCbs]) cb();
  }

  private append(rec: SessionRec, entries: readonly HistoryEntry[]): void {
    rec.history = [...rec.history, ...entries];
    rec.messages = rec.history.filter((e) => e.kind === "user" || e.kind === "assistant").length;
    rec.mtime = nowIso();
    if (rec.id === this.mainSessionId) {
      for (const cb of [...this.historyCbs]) cb(entries, false);
    } else {
      for (const cb of [...this.laneHistoryCbs]) cb(rec.id, entries, false);
    }
  }

  private resetFrame(rec: SessionRec, entries: readonly HistoryEntry[]): void {
    rec.history = [...entries];
    rec.messages = rec.history.filter((e) => e.kind === "user" || e.kind === "assistant").length;
    rec.mtime = nowIso();
    if (rec.id === this.mainSessionId) {
      for (const cb of [...this.historyCbs]) cb(entries, true);
    } else {
      for (const cb of [...this.laneHistoryCbs]) cb(rec.id, entries, true);
    }
  }

  // ---- 回合回放 ------------------------------------------------------------

  private statusOf(rec: SessionRec): Record<string, unknown> {
    return {
      live: { reasoning: rec.liveReasoning, answer: rec.liveAnswer, busyTools: [] },
      busy: rec.busy,
      queued: [],
      boardProgress: null,
      ctxTokens: null,
      mode: "workspace",
      cachePercent: null,
      bg: { active: 0, spawned: 0 },
      pendingPermission: null,
      planBoard: null,
      sessionId: rec.id,
      sidecar: null,
      sessionName: rec.name,
      model: { label: "Fake Reasoner", provider: "fake" },
    };
  }

  /** submit 的公共回放体（主车道与副车道共用；hold 支持只对非 /clear 回合）。 */
  private runTurn(rec: SessionRec, text: string, turn: FakeTurn): "started" {
    const delay = turn.delayMs ?? 30;
    const liveChunks = turn.liveChunks ?? 2;
    rec.finishRequested = false; // 新回合清落点（上回合的 finish 不跨回合）
    rec.busy = true;
    this.emitStatus();
    this.append(rec, [{ kind: "user", text }]);
    // 自动起题（真 driver 的 auto-title 面）：全新会话的首个用户消息起题
    //（带史的种子会话不重题——题从它的 firstUser 来）；status 帧的
    // sessionName 变化是侧栏的重取信号（ω99-255 的刷新缝）。
    if (rec.name === null && rec.history.length <= 1) rec.name = text.slice(0, 24);
    const finish = (): void => {
      void (async () => {
        // reasoning 流：busy 期间 live.reasoning 先行可见（推帧），落定归零。
        if (liveChunks > 0 && turn.reasoning !== undefined && turn.reasoning !== "") {
          await wait(Math.max(10, delay / 3));
          rec.liveReasoning = turn.reasoning;
          this.emitStatus();
          await wait(Math.max(10, delay / 3));
          rec.liveReasoning = "";
          rec.liveAnswer = (turn.reply ?? `已收到：${text}`).slice(0, 12);
          this.emitStatus();
        } else {
          await wait(Math.max(10, delay));
        }
        if (turn.error !== undefined) {
          this.append(rec, [{ kind: "error", text: turn.error }]);
        } else {
          const reply = turn.reply ?? `已收到：${text}`;
          this.append(rec, [{ kind: "assistant", text: reply, ...(turn.reasoning !== undefined ? { reasoning: turn.reasoning } : {}) }]);
          if (turn.notice !== undefined) {
            this.append(rec, [{ kind: "notice", text: turn.notice.text, ...(turn.notice.changes !== undefined ? { changes: turn.notice.changes } : {}) }]);
          }
        }
        if (turn.hold === true && !rec.finishRequested) {
          await new Promise<void>((resolve) => {
            const r = this.recs.get(rec.id);
            if (r !== undefined) r.holdRelease = resolve;
            else resolve();
          });
        }
        rec.finishRequested = false;
        rec.liveAnswer = "";
        rec.busy = false;
        this.emitStatus();
      })();
    };
    finish();
    return "started";
  }

  // ---- UiDriverPort（主车道） ----------------------------------------------

  subscribe = (cb: () => void): (() => void) => {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  };
  getStatus = (): unknown => this.statusOf(this.ensureSession(this.mainSessionId, ""));
  getHistory = (): readonly unknown[] => this.mainHistory();
  onHistory = (cb: (entries: readonly unknown[], reset: boolean) => void): (() => void) => {
    this.historyCbs.add(cb);
    return () => this.historyCbs.delete(cb);
  };
  onLoopEvent = (): (() => void) => (): void => {};
  /** 副车道史推送缝（LaneDriverPort.onHistory 由 server 侧带 sid 标注——
   *  fake 在全局缝上按会话 id 分流，server 的 laneTable 订阅这里）。 */
  onSideHistory = (cb: (sid: string, entries: readonly unknown[], reset: boolean) => void): (() => void) => {
    this.laneHistoryCbs.add(cb);
    return () => this.laneHistoryCbs.delete(cb);
  };

  submit = (text: string): unknown => {
    const rec = this.ensureSession(this.mainSessionId, text.slice(0, 24));
    if (text !== "/clear" && rec.firstUser === "") rec.firstUser = text.slice(0, 24);
    if (text === "/clear") {
      if (rec.busy) return "notice";
      // 轮转：旧会话留在表里（侧栏可切回），主车道换新 id + 空 history reset 帧。
      const nextId = `wudao-e2e-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
      this.mainSessionId = nextId;
      const fresh = this.ensureSession(nextId, "");
      this.resetFrame(fresh, []);
      this.emitStatus();
      return "cleared";
    }
    const turn = turnAt(rec.script, rec.turnIdx);
    rec.turnIdx += 1;
    return this.runTurn(rec, text, turn);
  };

  interrupt = (): void => {
    this.finishTurn(this.mainSessionId);
  };
  resume = async (id: string): Promise<{ ok: boolean }> => {
    const rec = this.recs.get(id);
    if (rec === undefined) return { ok: false };
    rec.inTrash = false;
    // 采纳到主车道：reset 重放该会话史（真 driver 的 resume 语义面）。
    this.mainSessionId = id;
    this.resetFrame(rec, rec.history);
    this.emitStatus();
    return { ok: true };
  };
  setMode = (): void => {};
  answerPermission = (): boolean => false;
  recallSteer = (): boolean => false;
  answerAskUser = (): boolean => false;
  detachToolCall = (): unknown => ({ kind: "refused", reason: "not_detachable" });
  listSlashCommands = (): readonly unknown[] => [];
  sessions = async (): Promise<readonly unknown[]> => this.rows(false);

  // ---- 可选 op 面（web 的设置/文件/回收站/搜索） ---------------------------

  searchSessions = async (q: string): Promise<readonly unknown[]> => {
    const needle = q.trim();
    const out: unknown[] = [];
    for (const r of this.recs.values()) {
      if (r.inTrash) continue;
      for (const e of r.history) {
        if (e.kind !== "user" && e.kind !== "assistant") continue;
        const idx = e.text.indexOf(needle);
        if (needle !== "" && idx >= 0) {
          const from = Math.max(0, idx - 12);
          out.push({
            sessionId: r.id,
            name: r.name ?? "",
            firstUser: r.firstUser,
            mtime: r.mtime,
            kind: e.kind,
            snippet: `${from > 0 ? "…" : ""}${e.text.slice(from, from + 40)}`,
          });
        }
      }
    }
    return out;
  };
  deleteSession = async (id: string): Promise<unknown> => {
    const rec = this.recs.get(id);
    if (rec === undefined) return { deleted: false, reason: "not-found" };
    rec.inTrash = true;
    rec.busy = false;
    this.emitStatus();
    return { deleted: true };
  };
  trashSessions = async (): Promise<readonly unknown[]> => this.rows(true);
  restoreSession = async (id: string): Promise<unknown> => {
    const rec = this.recs.get(id);
    if (rec === undefined || !rec.inTrash) return { restored: false, reason: "not-found" };
    rec.inTrash = false;
    rec.mtime = nowIso();
    this.emitStatus();
    return { restored: true };
  };
  schedulesList = async (): Promise<readonly unknown[]> => [];
  settingsStatus = async (): Promise<unknown> => {
    const reply = String(this.settings["language.reply"] ?? "auto");
    const reasoning = String(this.settings["language.reasoning"] ?? "auto");
    return {
      providers: [
        {
          provider: "fake",
          label: "Fake Reasoner",
          status: "ready",
          keySource: "env",
          endpoint: "http://127.0.0.1:9/v1",
          defaultModel: MODEL,
          custom: false,
          models: [{ name: MODEL }],
        },
      ],
      credentials: { path: "/tmp/wudao-e2e-credentials.json", keyCount: 1 },
      settings: {
        memoryEnabled: true,
        uiDefaultMode: (this.settings["ui.defaultMode"] ?? null) as string | null,
        wizardCompletedVersion: 999,
        uiTheme: (this.settings["ui.theme"] ?? null) as string | null,
        uiAccent: (this.settings["ui.accent"] ?? null) as string | null,
        languageReply: reply as "auto" | "on" | "off",
        languageReasoning: reasoning as "auto" | "zh" | "en" | "off",
      },
      current: { provider: "fake", model: MODEL, effort: "high" },
      language: { reply, reasoning },
      envKey: true,
      readiness: true,
      efforts: ["low", "medium", "high"],
    };
  };
  settingsSet = async (key: string, value: unknown): Promise<unknown> => {
    this.settings[key] = value;
    return { key, saved: true };
  };
  fileTree = async (path: string): Promise<unknown> => {
    const p = path.replace(/^\//, "").replace(/\/$/, "");
    const names = new Set<string>();
    for (const f of this.files) {
      if (p !== "" && !f.path.startsWith(`${p}/`)) continue;
      const rest = p === "" ? f.path : f.path.slice(p.length + 1);
      const seg = rest.split("/")[0] ?? "";
      if (seg !== "") names.add(seg);
    }
    const entries = [...names]
      .map((name) => {
        const full = p === "" ? name : `${p}/${name}`;
        const hit = this.files.find((f) => f.path === full);
        return { name, type: hit !== undefined && hit.type === "dir" ? "dir" : "file" as const, ...(hit?.type === "file" ? { size: (hit.content ?? "").length } : {}) };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { entries };
  };
  fileRead = async (path: string): Promise<unknown> => {
    const hit = this.files.find((f) => f.path === path.replace(/^\//, ""));
    if (hit === undefined || hit.type !== "file") throw new Error(`no such file: ${path}`);
    const content = hit.content ?? "";
    return { content, truncated: false, totalBytes: content.length, lines: content.split("\n").length };
  };
  recentWorkspaces = async (): Promise<unknown> => ({ workspaces: [] });
  ctxInfo = async (): Promise<unknown> => ({ sections: [], freeTokens: 100000 });

  // ---- 车道工厂（server 的 laneFactory 注入面） -----------------------------

  /** 开一条车道：绑到该会话（未知 id 自动建空会话——server 缝的语义）。 */
  openLane = async (sessionId: string): Promise<unknown> => {
    const rec = this.ensureSession(sessionId, "");
    const driver = this;
    return {
      subscribe: (cb: () => void): (() => void) => driver.subscribe(cb),
      getStatus: (): unknown => driver.statusOf(rec),
      getHistory: (): readonly unknown[] => driver.historyOf(sessionId),
      onHistory: (cb: (entries: readonly unknown[], reset: boolean) => void): (() => void) => {
        // 副车道史由全局 onSideHistory 缝分流；这里给 laneTable 的本地订阅
        // 挂一个过滤器（server 会带 sid 再标注一次，双标注幂等无害）。
        const off = driver.onSideHistory((sid, entries, reset) => {
          if (sid === sessionId) cb(entries, reset);
        });
        // 采纳即 reset 重放（server 在工厂返回后自行调 resume，那里的
        // resetFrame 也会推——双推会被客户端 reset 幂等吸收）。
        driver.resetFrame(rec, rec.history);
        return off;
      },
      submit: (text: string): unknown => {
        const turn = turnAt(rec.script, rec.turnIdx);
        rec.turnIdx += 1;
        return driver.runTurn(rec, text, turn);
      },
      interrupt: (): void => driver.finishTurn(sessionId),
      resume: async (id: string): Promise<{ ok: boolean }> => {
        const r = driver.recs.get(id);
        if (r === undefined) return { ok: false };
        driver.resetFrame(r, r.history);
        driver.emitStatus();
        return { ok: true };
      },
      setMode: (): void => {},
      answerPermission: (): boolean => false,
      recallSteer: (): boolean => false,
      answerAskUser: (): boolean => false,
      detachToolCall: (): unknown => ({ kind: "refused", reason: "not_detachable" }),
    };
  };
}
