// PreferencesTab — the settings page's 偏好 tab (settings-split: the 常规
// tab's five sections each became its own tab, the PluginTab seam widened).
// Two picks over the M63 §B settings ops, both persisting to the global
// settings tier:
//
//   记忆     the memoryEnabled checkbox (会话间自动回忆与后台整理 — the
//            receipt says 下会话生效; nothing flips live);
//   默认界面 the ui.defaultMode chips (简洁/Buddy/高级 — M78-buddy §4) — a
//            SUCCESSFUL write reports back through onModeApplied so the App
//            flips the live shell immediately (ui-review-r2 I8);
//   语言     ω99-234: #3 — the SAME LanguageSelector the composer grew
//            (spec 2026-08-28 §5), re-homed here. 频率分层归位（本弧超越
//            点）: the composer row keeps only in-session HIGH-frequency
//            knobs (模型/强度/模式); cross-session low-frequency preferences
//            live on the settings page — new config widgets default HERE,
//            never back onto the composer. In-page rows pin DEFAULTS
//            directly (settingsSet language.* — the write lane the 设为默认
//            footer spoke); the session-level temporary switch keeps the
//            /language command (zero capability lost). 行业设置页多为静态
//            表单；这里迁的是活组件（读写即生效 + toast 回执），零学习成本.
//
// The section body is moved VERBATIM from SettingsPage's 常规 tab — every
// receipt and hint stays byte-identical. settingsStatus stays page-level:
// this tab never fetches, it renders the settings prop and re-reads through
// the page's refresh() once a write lands.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ImprovementWire, LanguageKnob, MemoryEntry, SettingsStatus, WudaoClient } from "../protocol.js";
import { languageDefaultKey, shellFromLocation } from "../protocol.js";
import { LanguageSelector } from "./LanguageSelector.js";
import type { LanguagePair } from "./LanguageSelector.js";
// ω99-260: the 管理记忆 face's shared label/time helpers (same lexicon as the
// boot card — one vocabulary across both memory faces).
// ω99-273: readMemoryEntries joins — the reply's wire guard (bad shape = old
// server = hide the face; a bare-array reply would hand React
// Array.prototype.entries as a state updater and crash the tab).
import { formatMemoryTime, memoryKindLabel, memoryScopeLabel, readMemoryEntries } from "./MemoryReviewCard.js";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** M78-buddy §4 (spec §4): the 默认界面 chips' labels — the pick is tri+1
 *  now, 「Buddy 模式」(the two-panel 会话列表+对话 shell) sitting between
 *  简洁 and 高级. */
const MODE_LABELS = { simple: "简洁模式", buddy: "Buddy 模式", advanced: "高级模式" } as const;

/** 永续 v6 wave2（the upstream project C1）：改进提案卡的状态徽标（收益词表——两道人工门
 *  在词面上可见：待同意/待激活；未知 token 原样透传，不编造）。 */
export function improveStatusLabel(status: string): string {
  switch (status) {
    case "offered":
      return "待同意";
    case "proposing":
      return "生成中";
    case "gated":
      return "待激活";
    case "gate-failed":
      return "门禁未过";
    case "rejected":
      return "已驳回";
    case "ignored":
      return "已忽略";
    case "abandoned":
      return "已放弃";
    case "activated":
      return "已生效";
    case "undone":
      return "已撤销";
    default:
      return status;
  }
}

export function PreferencesTab({
  client,
  settings,
  notify,
  refresh,
  onModeApplied,
  language = null,
  memorySignature,
}: {
  client: WudaoClient;
  settings: SettingsStatus | null;
  /** The settings page's receipts area (success and failure lines both ride
   *  it — no async op fails silently). */
  notify: (text: string) => void;
  /** The page-level re-fetch: a landed write re-reads settingsStatus so the
   *  checkbox and chips re-derive from the persisted truth. */
  refresh: () => void;
  /** ui-review-r2 I8: a SUCCESSFUL ui.defaultMode write reports the pick
   *  back so the App flips the live shell immediately (the old chips only
   *  persisted —「下次打开生效」— and the shell sat stale until a reload). */
  onModeApplied?: (mode: "simple" | "buddy" | "advanced") => void;
  /** ω99-234: the session-effective language pair (App's gateStatus.language
   *  feed). The SAME component the composer mounted, re-homed here; a row
   *  pick / footer now pins the GLOBAL default (settingsSet language.*).
   *  null (an old server without gateStatus.language) hides the section —
   *  the composer chip's null gate, carried over. */
  language?: LanguagePair | null;
  /** The memory store's content signature (the status frame's change signal —
   *  see the effect below). A CHANGE while the panel is mounted refetches the
   *  list; absent (old server) / unchanged = today's fetch-on-open bytes. */
  memorySignature?: string;
}): React.JSX.Element {
  /** The one in-flight write's key (`set:memoryEnabled` / `set:ui.defaultMode`)
   *  — the matching control disables while set. Per-key by design (the split
   *  keeps the current semantics: no cross-section freeze). */
  const [pending, setPending] = useState<string | null>(null);

  const setPref = (key: string, value: unknown, receipt: string): void => {
    setPending(`set:${key}`);
    client
      .settingsSet(key, value)
      .then(() => {
        notify(receipt);
        // I8: a mode pick flips the LIVE shell the moment the write lands —
        // the receipt says 已切换, not 下次打开生效.
        if (key === "ui.defaultMode" && (value === "simple" || value === "buddy" || value === "advanced")) {
          onModeApplied?.(value);
        }
        refresh();
      })
      .catch((e: unknown) => notify(`⚠️ ${errText(e)}`))
      .finally(() => setPending(null));
  };

  // ω99-234: the 语言 section's write lane — a row pick / the 设为默认 footer
  // pins the knob's GLOBAL default (the S3 settings tier, a NEW session's
  // boot fold). Same pending freeze idiom as setPref (per-key); the receipt
  // and failure word ride the App lane's old family, byte-shape intact.
  const setLanguageDefault = (knob: LanguageKnob, mode: string): void => {
    setPending(`set:${languageDefaultKey(knob)}`);
    client
      .settingsSet(languageDefaultKey(knob), mode)
      .then(() => {
        notify(`已设为默认:${knob === "reply" ? "回答" : "思考"} ${mode} —— 新会话生效`);
        refresh();
      })
      .catch((e: unknown) => notify(`⚠️ 默认语言保存失败：${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setPending(null));
  };

  // ω99-260: #11 — 面五 — the 管理记忆 face. 段内懒取: this fetch fires when the
  // TAB mounts (SettingsPage mounts only the active panel), never at boot —
  // the boot wire's head stays the App's own ops. Snapshot semantics (v1):
  // one fetch on mount + one refetch after each decision; other windows'
  // writes are not live (the 258 leaf-table semantics). The face keys on the
  // PHYSICAL store (memoryList), NOT the memoryEnabled switch — 召回开关与
  // 管理分离（关召回≠锁面板，the brief's design point). Old server (op
  // refused) → the whole section hides (the 零噪音门), the rest of the tab
  // renders byte-as-before.
  const [mem, setMem] = useState<readonly MemoryEntry[] | null | undefined>(undefined);
  // 永续 v6 弧 A（the upstream project C3）：被拦学习输入计数——「已拦 N 条可疑学习输入」
  // 提示行（凭据值/指令注入形状，未入库；老 server 不回该字段=0 零渲染）。
  const [memBlocked, setMemBlocked] = useState(0);
  const [memBusyId, setMemBusyId] = useState<string | null>(null);
  // ω99-264: #5 — the inline editor's row + draft (one editor open at a time; the
  // draft is prefilled with the row's current content — byte equality with
  // the store decides the driver's short-circuit, so the draft travels raw).
  const [memEditId, setMemEditId] = useState<string | null>(null);
  const [memDraft, setMemDraft] = useState("");
  const loadMem = useCallback((): void => {
    // ω99-273: #2 — absent-method guard: 260's「old server → hide」契约只覆盖了
    // 拒答（rejection），没覆盖方法本身缺场（更老的字节 / 精简 mock）。同步
    // throw 会逃出 .catch 链直接炸挂载——这里前置判型，缺场=老 server 同语义。
    if (typeof client.memoryList !== "function") {
      setMem(null);
      return;
    }
    void client.memoryList()
      .then((r) => { setMem(readMemoryEntries(r)); setMemBlocked(typeof r.blocked === "number" && r.blocked > 0 ? r.blocked : 0); }) // 坏形 = 老 server 同语义；blocked 缺场=0
      .catch(() => { setMem(null); }); // old server — hide the face, never crash
  }, [client]);
  useEffect(() => { loadMem(); }, [loadMem]);
  // ω99-268: #3 — the live refetch trigger (the App 层 sessionName watcher's
  // discipline, re-homed at the consuming face): the signature CHANGING
  // across renders refetches the list. The first observation only ARMS (the
  // mount fetch above already ran — never a double fetch); unchanged or
  // absent (old server) stays quiet — the fetch-on-open bytes are the
  // zero-signal baseline. A refetch failure rides loadMem's own catch (the
  // face hides, never crashes).
  const memSigSeen = useRef<{ sig: string | undefined; armed: boolean }>({ sig: undefined, armed: false });
  useEffect(() => {
    const seen = memSigSeen.current;
    if (!seen.armed) {
      memSigSeen.current = { sig: memorySignature, armed: true }; // 首观察只布防
      return;
    }
    if (memorySignature === seen.sig) return; // 值不变/缺场——静默
    memSigSeen.current = { sig: memorySignature, armed: true };
    loadMem();
  }, [memorySignature, loadMem]);
  // ω99-264: the memory faces' shared failure receipt (ONE literal — the
  // decide and edit lanes ride the same 「⚠️ 记忆操作失败」 family, the 204
  // census's zero-evolution pin; the full-width colon lives in this string
  // alone).
  const memFail = (e: unknown): void => {
    notify(`⚠️ 记忆操作失败：${e instanceof Error ? e.message : String(e)}`);
  };
  // 永续 v6 wave2（the upstream project C1）：改进提案面——管理记忆旁的独立小节（记忆面板
  // 旁的姊妹面）。段内懒取同管理记忆（挂载时一取+每次决定后重取；老 server
  // 缺 op / 方法缺场 → 整节隐藏，零噪音门）。
  const [improve, setImprove] = useState<readonly ImprovementWire[] | null | undefined>(undefined);
  const [impBusyId, setImpBusyId] = useState<string | null>(null);
  const loadImprove = useCallback((): void => {
    if (typeof client.improvementFace !== "function") {
      setImprove(null);
      return;
    }
    void client.improvementFace("list")
      .then((r) => { setImprove(Array.isArray(r.records) ? r.records : []); })
      .catch(() => { setImprove(null); }); // old server — hide the face, never crash
  }, [client]);
  useEffect(() => { loadImprove(); }, [loadImprove]);
  const impFail = (e: unknown): void => {
    notify(`⚠️ 改进提案操作失败：${e instanceof Error ? e.message : String(e)}`);
  };
  const impDecide = (id: string, action: "consent" | "ignore" | "activate" | "reject" | "undo"): void => {
    setImpBusyId(id);
    void client.improvementFace(action, id)
      .then((r) => {
        notify(r.message);
        loadImprove();
      })
      .catch(impFail)
      .finally(() => setImpBusyId(null));
  };
  const memDecide = (id: string, action: "ok" | "del"): void => {
    setMemBusyId(id);
    void client.memoryDecide(id, action)
      .then((r) => {
        notify(r.message); // the driver's structured verdict (both ok and the honest MISS)
        loadMem();
      })
      .catch(memFail)
      .finally(() => setMemBusyId(null));
  };
  // ω99-264: the row's 改写 — save rides client.memoryEdit (the driver's
  // short-circuit + update + conditional confirm), the receipt is the
  // driver's structured verdict (已改写一条记忆 / …仍待你确认), then the
  // same refetch as a decision. On FAILURE the editor stays open with the
  // draft (a retry is one click away); cancel = zero calls, just collapse.
  const memEditSave = (id: string): void => {
    setMemBusyId(id);
    void client.memoryEdit(id, memDraft)
      .then((r) => {
        notify(r.message);
        setMemEditId(null);
        setMemDraft("");
        loadMem();
      })
      .catch(memFail)
      .finally(() => setMemBusyId(null));
  };

  return (
    <>
    <div className="settings-section set-sec">
      <h3 className="section-title set-title">偏好</h3>
      {/* 120 弧「选择语言」：偏好行改 .setrow（标题+说明左/控件右/hairline
          分隔，claude.ai·a ref 设置行节奏），原生 checkbox 升 .wudao-switch
          定制开关（on=accent 实底——状态才配得上颜色）。 */}
      <label className="setrow">
        <span className="setrow-main">
          <span className="setrow-title">跨会话记忆</span>
          <span className="setrow-note">会话间自动回忆与后台整理</span>
        </span>
        <input
          type="checkbox"
          className="wudao-switch"
          checked={settings?.settings.memoryEnabled ?? true}
          disabled={pending === "set:memoryEnabled"}
          onChange={(e) => setPref("memoryEnabled", e.target.checked, `记忆已${e.target.checked ? "开启" : "关闭"} —— 下会话生效`)}
        />
      </label>
      {/* ω99-287: #4 — 关窗后台开关（仅桌面壳渲染；浏览器关不掉桌面端的
          活，该开关在那里是噪音）。默认关（Q1：用户显式开，信任面透明）；
          文案按 Q3/Q4 裁定：开=无条件转后台（不弹确认，Safari 心智），
          诚实写明合盖休眠例外。 */}
      {shellFromLocation() === "desktop" ? (
        <label className="setrow">
          <span className="setrow-main">
            <span className="setrow-title">关闭窗口时保持后台运行</span>
            <span className="setrow-note">关窗不退出应用，正在跑的活继续推进；点程序坞图标或托盘「打开主窗口」随时回来；合盖休眠时活同样暂停</span>
          </span>
          <input
            type="checkbox"
            className="wudao-switch"
            data-background-on-close
            checked={settings?.settings.desktopBackgroundOnClose ?? false}
            disabled={pending === "set:desktop.backgroundOnClose"}
            onChange={(e) => setPref(
              "desktop.backgroundOnClose",
              e.target.checked,
              e.target.checked
                ? "关窗后台运行已开启 —— 关窗不退出，活继续跑"
                : "关窗后台运行已关闭 —— 关窗即退出应用",
            )}
          />
        </label>
      ) : null}
      {/* 122 项 2 — 定时任务离线唤起开关（桌面壳 + macOS 才渲染：LaunchAgent
          是 macOS 机制，浏览器/其它平台勾了也无处落地）。默认关（fail-closed
          家族：向系统目录写定时器是用户可见足迹，必须显式同意）。文案=收益语
          + 诚实例外：合盖休眠时 launchd 不唤醒硬件，等唤醒后立即补跑（设计
          §6 的边界如实写明）；开关两个方向都在 ≤ 一个 tick 内生效（守护
          live 读设置），回执不说「重启后生效」。 */}
      {shellFromLocation() === "desktop" && (settings?.settings.schedulesLaunchAgentSupported ?? true) ? (
        <label className="setrow">
          <span className="setrow-main">
            <span className="setrow-title">定时任务离线唤起</span>
            <span className="setrow-note">应用没开着，到点也会自动打开应用执行；合盖休眠时等唤醒后立即补跑</span>
          </span>
          <input
            type="checkbox"
            className="wudao-switch"
            data-schedule-launch-agent
            checked={settings?.settings.schedulesLaunchAgent ?? false}
            disabled={pending === "set:schedules.launchAgent"}
            onChange={(e) => setPref(
              "schedules.launchAgent",
              e.target.checked,
              e.target.checked
                ? "定时任务离线唤起已开启 —— 应用没开着，到点也会自动唤起执行"
                : "定时任务离线唤起已关闭 —— 定时任务只在应用开着时执行",
            )}
          />
        </label>
      ) : null}
      <div className="setrow">
        <span className="setrow-main">
          <span className="setrow-title">默认界面</span>
          {/* M63 §D: null (never written) highlights 高级 — the same
              effective default the app opens with. */}
          <span className="setrow-note">下次打开应用进入的界面；立即切换,重载后完全生效</span>
        </span>
        <div className="segctl" role="radiogroup" aria-label="默认界面">
          {(["simple", "buddy", "advanced"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={(settings?.settings.uiDefaultMode ?? "advanced") === mode}
              data-default-mode={mode}
              className={`segctl-opt${(settings?.settings.uiDefaultMode ?? "advanced") === mode ? " on" : ""}`}
              disabled={pending === "set:ui.defaultMode"}
              onClick={() => setPref("ui.defaultMode", mode, `默认界面 → ${MODE_LABELS[mode]} —— 已切换,重载后完全生效`)}
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>
      <div className="setrow">
        <span className="setrow-main">
          <span className="setrow-title">默认推理档</span>
          {/* 推理档三级配置 S5: the GLOBAL default effort tier (settings
              model.defaultEffort — a NEW session's boot fold). The per-session
              pick lives on the composer's 强度 chip (/effort); the per-provider
              binding on the provider detail's 推理档绑定 row. null (never
              written) highlights nothing — 跟随 env/会话内. */}
          <span className="setrow-note">新会话生效;当前会话用输入框下方的强度 chip 切</span>
        </span>
        <div className="segctl" role="radiogroup" aria-label="默认推理档">
          {(settings?.efforts ?? []).map((level) => (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={settings?.defaultEffort === level}
              data-default-effort={level}
              className={`segctl-opt${settings?.defaultEffort === level ? " on" : ""}`}
              disabled={pending === "set:model.defaultEffort"}
              onClick={() => setPref("model.defaultEffort", level, `默认推理档 → ${level} —— 新会话生效`)}
            >
              {level}
            </button>
          ))}
        </div>
      </div>
      <div className="hint">写入全局设置(~/.wudao/settings.json)</div>
    </div>
    {/* ω99-260: 管理记忆 — the memory audit face, under the 记忆 row's own
        section (看得见/批得掉/删得动/被想起次数可视——the review gate's
        desktop handle). Loading / old server → the whole section hides; the
        memoryEnabled toggle above is UNTOUCHED by this face (its semantics
        and receipt stay byte-identical). */}
    {mem !== undefined && mem !== null ? (
      <div className="settings-section set-sec memory-manage">
        <h3 className="section-title set-title">管理记忆</h3>
        <div className="hint">模型替你记下的内容都在这里——确认后参与回忆，丢弃即删除该条</div>
        {/* 永续 v6 弧 A：被拦学习输入可见（不静默丢）——含密钥值或指令注入
            形状的学习输入未入库，计数+去向一行说清；0 条/老 server 零渲染。 */}
        {memBlocked > 0 ? (
          <div className="hint mem-blocked" data-blocked-count={memBlocked}>{`已拦 ${memBlocked} 条可疑学习输入（含密钥或指令注入形状，未入库——明细在 .wudao/memory-blocked.jsonl）`}</div>
        ) : null}
        {mem.length === 0 ? (
          <div className="mem-empty">还没有记忆——用得越久攒得越多</div>
        ) : (
          mem.map((e) => {
            const pendingRow = e.status === "pending";
            const when = formatMemoryTime(e.created);
            // ω99-264: 改写 is an EDIT, not a review — every row carries the
            // key (an active entry's typo is as fixable as a pending one's;
            // 260's 「决定键只 pending 行」 precedent governs 审核, not editing).
            // While THIS row edits, its content display and decide keys give
            // way to the inline textarea + 保存/取消 (no decide-while-editing
            // on the same row).
            if (memEditId === e.id) {
              return (
                <div key={e.id} className="mem-row editing" data-mem-id={e.id}>
                  <span className={`mem-badge${pendingRow ? "" : " ok"}`}>{pendingRow ? "待审" : "生效"}</span>
                  <span className="mem-main mem-edit">
                    <textarea
                      value={memDraft}
                      disabled={memBusyId !== null}
                      onChange={(ev) => setMemDraft(ev.target.value)}
                    />
                    <span className="mem-acts">
                      <button
                        type="button"
                        className="wudao action"
                        disabled={memBusyId !== null || memDraft.trim() === ""}
                        onClick={() => memEditSave(e.id)}
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        className="wudao"
                        disabled={memBusyId !== null}
                        onClick={() => { setMemEditId(null); setMemDraft(""); }}
                      >
                        取消
                      </button>
                    </span>
                  </span>
                </div>
              );
            }
            return (
              <div key={e.id} className="mem-row" data-mem-id={e.id}>
                <span className={`mem-badge${pendingRow ? "" : " ok"}`}>{pendingRow ? "待审" : "生效"}</span>
                <span className="mem-main">
                  <span className="mem-kind">
                    {`${memoryKindLabel(e.kind)} · ${memoryScopeLabel(e.scope)}${when !== "" ? ` · ${when}` : ""} · 被想起 ${e.hits} 次`}
                  </span>
                  <span className="mem-content">{e.content}</span>
                </span>
                <span className="mem-acts">
                  <button
                    type="button"
                    className="wudao"
                    disabled={memBusyId !== null}
                    onClick={() => { setMemEditId(e.id); setMemDraft(e.content); }}
                  >
                    改写
                  </button>
                  {pendingRow ? (
                    <>
                      <button type="button" className="wudao action" disabled={memBusyId !== null} onClick={() => memDecide(e.id, "ok")}>
                        确认
                      </button>
                      <button type="button" className="wudao danger" disabled={memBusyId !== null} onClick={() => memDecide(e.id, "del")}>
                        丢弃
                      </button>
                    </>
                  ) : null}
                </span>
              </div>
            );
          })
        )}
      </div>
    ) : null}
    {/* 永续 v6 wave2（the upstream project C1）：改进提案——管理记忆旁的独立小节。失败反复
        出现时助手提议把它总结成一条工作规则；生成后先过自动门禁，激活由你
        决定（两道确认），激活的规则可一键撤销。老 server → 整节隐藏。 */}
    {improve !== undefined && improve !== null ? (
      <div className="settings-section set-sec memory-manage">
        <h3 className="section-title set-title">改进提案</h3>
        <div className="hint">失败反复出现时，助手会提议把它总结成一条工作规则——规则在激活前经过自动门禁和你的两次确认，随时可撤销</div>
        {improve.length === 0 ? (
          <div className="mem-empty">还没有改进提案——同一个失败出现三次后会在这里提议</div>
        ) : (
          improve.map((p) => {
            const when = formatMemoryTime(p.createdAt);
            const subject = p.subject.length > 60 ? `${p.subject.slice(0, 59)}…` : p.subject;
            return (
              <div key={p.id} className="mem-row" data-improve-id={p.id} data-improve-status={p.status}>
                <span className={`mem-badge${p.status === "gated" || p.status === "activated" ? " ok" : ""}`}>{improveStatusLabel(p.status)}</span>
                <span className="mem-main">
                  <span className="mem-kind">
                    {`${subject} · 已出现 ${p.count} 次${when !== "" ? ` · ${when}` : ""}`}
                  </span>
                  {p.status === "offered" ? (
                    <>
                      {p.preview !== undefined && p.preview !== "" ? <span className="mem-content">{p.preview}</span> : null}
                      {p.attempts > 0 && p.lastError !== undefined ? <span className="hint">{`上次生成失败：${p.lastError}`}</span> : null}
                    </>
                  ) : null}
                  {p.status === "proposing" ? <span className="hint">正在生成提案并自动过门禁——完成或失败后这里更新</span> : null}
                  {(p.status === "gated" || p.status === "activated" || p.status === "undone" || p.status === "gate-failed") && p.ruleText !== undefined ? (
                    <>
                      {p.problemSummary !== undefined ? <span className="mem-content">{p.problemSummary}</span> : null}
                      <span className="mem-content">{p.ruleText}</span>
                      <span className="hint">
                        {`适用范围：${p.scope ?? "全工作区"}${p.paths !== undefined ? `（${p.paths.join("、")}）` : ""}${p.gate !== undefined ? ` · 门禁${p.gate.ok ? "已过" : "未过"}（${p.gate.suites.filter((s) => s.status === "pass").length}/${p.gate.suites.length} 项套件全绿）` : ""}`}
                      </span>
                      {p.status === "activated" && p.ruleFile !== undefined ? <span className="hint">{`已写入 ${p.ruleFile}——下次会话生效`}</span> : null}
                      {p.status === "gate-failed" && p.lastError !== undefined ? <span className="hint">{`未激活（${p.lastError}）——原样留档`}</span> : null}
                    </>
                  ) : null}
                  {(p.status === "rejected" || p.status === "ignored" || p.status === "abandoned") && p.lastError !== undefined ? (
                    <span className="hint">{p.lastError}</span>
                  ) : null}
                </span>
                <span className="mem-acts">
                  {p.status === "offered" ? (
                    <>
                      <button type="button" className="wudao action" disabled={impBusyId !== null} onClick={() => impDecide(p.id, "consent")}>
                        生成提案
                      </button>
                      <button type="button" className="wudao" disabled={impBusyId !== null} onClick={() => impDecide(p.id, "ignore")}>
                        忽略
                      </button>
                    </>
                  ) : null}
                  {p.status === "gated" ? (
                    <>
                      <button type="button" className="wudao action" disabled={impBusyId !== null} onClick={() => impDecide(p.id, "activate")}>
                        激活
                      </button>
                      <button type="button" className="wudao danger" disabled={impBusyId !== null} onClick={() => impDecide(p.id, "reject")}>
                        驳回
                      </button>
                    </>
                  ) : null}
                  {p.status === "activated" ? (
                    <button type="button" className="wudao" disabled={impBusyId !== null} onClick={() => impDecide(p.id, "undo")}>
                      撤销
                    </button>
                  ) : null}
                  {p.status === "undone" ? (
                    <button type="button" className="wudao" disabled={impBusyId !== null} onClick={() => impDecide(p.id, "activate")}>
                      重新激活
                    </button>
                  ) : null}
                </span>
              </div>
            );
          })
        )}
      </div>
    ) : null}
    {language != null ? (
      <div className="settings-section set-sec">
        <h3 className="section-title set-title">语言</h3>
        <div className="prefrow">
          {/* ω99-234: the SAME chip (component body untouched), its rows now
              pin defaults through the tab's write lane; the menu's checkmarks
              still read the SESSION-effective pair (the component's contract). */}
          <LanguageSelector
            value={language}
            disabled={pending !== null && pending.startsWith("set:language.")}
            onPick={(knob, mode) => setLanguageDefault(knob, mode)}
            onPersistDefault={(knob) => setLanguageDefault(knob, language[knob])}
          />
        </div>
        <div className="hint">回答与思考的语言偏好（新会话默认生效；当前会话临时切换可用 /language 命令）。</div>
      </div>
    ) : null}
    </>
  );
}
