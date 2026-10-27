// SettingsPage — the settings SHELL (settings-split, spec
// 2026-08-23-settings-split): five lazy tabs over the extracted components —
// 供应商 (ProviderTab: the card matrix + 默认模型/推理档), 权限
// (PermissionsTab), 外观 (AppearanceTab), 偏好 (PreferencesTab), 插件
// (PluginTab, unchanged). The page owns ONLY the page-level contract: one
// settingsStatus fetch on open (settings flows down as a prop — a tab switch
// re-renders, never re-fetches), the receipts as auto-dismissing TOASTS
// (iter4: the .settings-toasts floating stack, visible on every tab) + the
// inline load error, notify()/refresh() handed down, and the page chrome (Esc
// close, useFocusReturn, the left nav). Each panel mounts ONLY while active
// (the lazy-mount economy — plugin ops stay off the wire until 插件 opens).
import { useCallback, useEffect, useRef, useState } from "react";
import type { DriverStatus, SettingsStatus, WudaoClient } from "../protocol.js";
import { useFocusReturn } from "../use-focus-return.js";
import { AppearanceTab } from "./AppearanceTab.js";
import { McpTab } from "./McpTab.js";
import { PermissionsTab } from "./PermissionsTab.js";
// cc-plugins C2: the 插件 tab — the C1 op group's surface (markets /
// discover / install / installed management). Mounted ONLY when its tab is
// selected, so plugin ops stay off the wire until the user opens it.
import { PluginTab } from "./PluginTab.js";
// persona-settings T6: the Persona tab — the persona ops' surface (the
// global-default picker + the master-detail CRUD over personaList /
// personaGet / personaSave / personaDelete). Same lazy-mount economy.
import { PersonaPanel } from "./PersonaPanel.js";
import { PreferencesTab } from "./PreferencesTab.js";
import { ProviderTab } from "./ProviderTab.js";
import type { LanguagePair } from "./LanguageSelector.js";
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "./ime-guard.js";
import { Icon } from "./Icon.js";
import { IconCheck } from "./icons.js";
import { classifyNotice } from "../notice-variant.js";

type SettingsTabId = "provider" | "permissions" | "appearance" | "preferences" | "persona" | "mcp" | "plugins";

const SETTINGS_TABS: readonly { readonly id: SettingsTabId; readonly label: string }[] = [
  { id: "provider", label: "供应商" },
  { id: "permissions", label: "权限" },
  { id: "appearance", label: "外观" },
  { id: "preferences", label: "偏好" },
  { id: "persona", label: "Persona" },
  // MCP visibility (2026-08-31): the configured-server list across the three
  // tiers — the 「配置之后看不见自己有什么」 gap.
  { id: "mcp", label: "MCP" },
  { id: "plugins", label: "插件" },
];

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// iter4: one transient notice — {id, text}. A `⚠️`-prefixed text is the
// tabs' failure lane and renders as the error variant.
interface SettingsToast {
  readonly id: number;
  readonly text: string;
}

const TOAST_LIFE_MS = 4000;
const TOAST_MAX = 3;

export function SettingsPage({
  client,
  status,
  onClose,
  onModeApplied,
  onAccentPicked,
  pendingAsk = false,
  language = null,
}: {
  client: WudaoClient;
  status: DriverStatus | null;
  onClose: () => void;
  /** final-review F1: a permission ask pends in the chat column this page
   *  REPLACES (the inline .permission-card unmounts with it). The ask parks
   *  fail-closed until answered — this flag only feeds the in-page banner
   *  naming it, so a parked ask is never invisible behind the settings
   *  surface. Wired from the SAME App-level ask state that mounts the card;
   *  the answer lane itself is untouched. */
  pendingAsk?: boolean;
  /** ui-review-r2 I8: a SUCCESSFUL ui.defaultMode write reports the pick
   *  back so the App flips the live shell immediately (the old chips only
   *  persisted —「下次打开生效」— and the shell sat stale until a reload).
   *  Flows through to the 偏好 tab. */
  onModeApplied?: (mode: "simple" | "buddy" | "advanced") => void;
  /** ui-review-r4 I2: a LOCAL accent pick reports back so the App arms its
   *  accentTouched guard — a stale settingsStatus reply already on the wire
   *  must not stomp the pick (themeTouched's twin; the reply stays the
   *  source of truth until the user clicks first). Flows through to the
   *  外观 tab. */
  onAccentPicked?: () => void;
  /** ω99-234: the 语言 section's value feed (App's gateStatus.language —
   *  the session-effective pair). Flows through to the 偏好 tab, where the
   *  re-homed LanguageSelector lives; null (an old server) hides the
   *  section. */
  language?: LanguagePair | null;
}): React.JSX.Element {
  const [settings, setSettings] = useState<SettingsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // iter4 (trial feedback): the receipts are TOASTS now — a floating
  // .settings-toasts stack instead of the inline strip the panels used to
  // print at their top. Same notify() seam (the six tabs are untouched);
  // each toast auto-dismisses at 4000ms, closes on click, and the stack
  // keeps at most TOAST_MAX entries (the oldest is dropped).
  const [toasts, setToasts] = useState<readonly SettingsToast[]>([]);
  const toastSeq = useRef(0);
  const toastTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // settings-split §2: 供应商 is the default tab (the old 常规 first frame
  // was the provider cards); plugins keeps its tail slot.
  const [tab, setTab] = useState<SettingsTabId>("provider");
  // tokfinish §6 (appaudit §1.1 交互缺口): the tablist's WAI-ARIA tabs
  // keyboard contract — ArrowLeft/ArrowRight (wrapping) and Home/End move
  // focus AND activate (selection follows focus, the standard tabs
  // pattern). Controlled focus via per-tab refs (the buttons are plain
  // focusables; no roving tabindex churn needed since focus is driven).
  // Only the four keys are intercepted — Esc still reaches the page-level
  // handler below unchanged (关页语义照旧), typing/Tab pass through.
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const roamTab = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"] as const;
    if (!(keys as readonly string[]).includes(e.key)) return;
    e.preventDefault();
    const idx = SETTINGS_TABS.findIndex((t) => t.id === tab);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = SETTINGS_TABS.length - 1;
    else next = (idx + (e.key === "ArrowRight" ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    setTab(SETTINGS_TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };
  // ui-review-r3 P7: the page OWNS focus while open (keyboard users land
  // somewhere inside, not stranded on the body) and Esc closes — the r1
  // useFocusReturn idiom returns focus to the ⚙ trigger (or the Cmd+,
  // focused element before that) on close.
  const pageRef = useRef<HTMLDivElement>(null);
  // ω99-309: 页根组合态——各 tab（供应商/偏好/插件…）的输入 composition 冒
  // 泡到页根一处吃全；组合期 Esc 是取消候选词，不是关设置页（关页=丢表
  // 单稿）。卡内自身的 Esc（pvd/MCM）会 stopPropagation，先于页根。
  const imeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });
  useFocusReturn();
  useEffect(() => {
    pageRef.current?.focus();
  }, []);

  // iter4: retire one toast — cancel its timer first (the click beats the
  // 4000ms fuse), then drop the row.
  const dismissToast = useCallback((id: number): void => {
    const timer = toastTimers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    setToasts((rows) => rows.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback((text: string): void => {
    const id = ++toastSeq.current;
    setToasts((rows) => [...rows, { id, text }].slice(-TOAST_MAX));
    toastTimers.current.set(
      id,
      setTimeout(() => {
        toastTimers.current.delete(id);
        setToasts((rows) => rows.filter((t) => t.id !== id));
      }, TOAST_LIFE_MS),
    );
  }, []);

  // iter4: every live timer dies with the page — a pending auto-dismiss must
  // never fire after unmount (the setState-after-unmount leak).
  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const refresh = useCallback((): void => {
    client
      .settingsStatus()
      .then((s) => {
        setSettings(s);
        setLoadError(null);
      })
      .catch((e: unknown) => setLoadError(errText(e)));
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // iter4: only the PERSISTENT load error rides the top of every tab panel —
  // the transient receipts moved to the floating .settings-toasts stack the
  // page renders once, below (visible on every tab by construction, and a
  // failing-to-load page still shows its error inline where it stays put).
  // The envKey hint lives in ProviderTab (settings-split §2: Key-related
  // info belongs on the provider tab).
  // final-review F1: the pending-ask notice joins the PERSISTENT lane — the
  // ask outlives any toast's 4000ms fuse, so it must never ride that stack.
  // Informational only (role=status, no buttons): the ask itself is answered
  // back in the conversation, after the page closes.
  // statecover C5: the 供应商 tab is now the load error's home THERE — it
  // renders the error + the 重试 riding refresh() itself (the 读取中… lie is
  // suppressed), so the page-level banner below skips THAT tab only (one
  // presentation per tab, no duplicate rows); the other five tabs keep the
  // banner (they degrade silently on settings=null, so it is their only
  // error surface).
  const pendingAskNotice = pendingAsk ? (
    <div className="settings-pending-ask" role="status"><Icon name="triangle-alert" size={12} /> 有权限请求待确认 — 关闭设置后处理</div>
  ) : null;
  const loadErrorNotice = loadError !== null ? <div className="entry-error">{`无法读取设置:${loadError}`}</div> : null;
  const pageNotices = (
    <>
      {loadErrorNotice}
      {pendingAskNotice}
    </>
  );

  return (
    <div
      className="settings-page"
      ref={pageRef}
      tabIndex={-1}
      onCompositionStart={() => { imeRef.current = imeStart(imeRef.current); }}
      onCompositionEnd={() => { imeRef.current = imeEnd(imeRef.current, Date.now()); }}
      onKeyDown={(e) => {
        // ui-review-r3 P7: Esc closes — the page swallows the key itself so
        // it never leaks toward whatever sits beneath.
        // ω99-309: 组合期 IME 拥有键盘——Esc 先过组合守卫再谈关页。
        if (imeSwallows(e.nativeEvent, imeRef.current, Date.now())) return;
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {/* T12 墨线: the shell — 左导航 + 右表单列. The tab MECHANISM and the
          ARIA tabs contract are untouched (same roles/ids/aria-attributes,
          settings-tabpanel-a11y is the regression net); only the visual
          container changed: the strip became .set-nav and the tab buttons
          ride the sidebar's .sb-i row language. */}
      <div className="set">
      <div className="set-nav">
      <div className="settings-head">
        <h3>设置</h3>
        <button type="button" className="ctl" onClick={onClose}>
          返回会话
        </button>
      </div>

      {/* cc-plugins C2 → settings-split: the tab bar — five sections, one
          component each (spec §2's order; 插件 keeps its tail slot). E3 (C2
          minor) completes the ARIA tabs contract: each tab carries id +
          aria-controls, and the panel it names is a role="tabpanel" whose
          aria-labelledby points back at the tab. Only the ACTIVE panel
          mounts (the lazy-mount economy). tokfinish §6 adds the tabs
          keyboard half: ←/→/Home/End roam + activate on the container. */}
      <div className="settings-tabs" role="tablist" aria-label="设置分区" onKeyDown={roamTab}>
        {SETTINGS_TABS.map((t, i) => (
          <button key={t.id} type="button" role="tab" id={`settings-tab-${t.id}`} aria-controls={`settings-panel-${t.id}`} aria-selected={tab === t.id} data-settings-tab={t.id} className={`sb-i${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)} ref={(el) => { tabRefs.current[i] = el; }}>
            {t.label}
          </button>
        ))}
      </div>
      </div>

      {tab === "provider" ? (
        <div role="tabpanel" id="settings-panel-provider" aria-labelledby="settings-tab-provider" className="set-body">
          {pendingAskNotice}
          <ProviderTab client={client} settings={settings} status={status} notify={notify} refresh={refresh} loadError={loadError} />
        </div>
      ) : null}
      {tab === "permissions" ? (
        <div role="tabpanel" id="settings-panel-permissions" aria-labelledby="settings-tab-permissions" className="set-body">
          {pageNotices}
          <PermissionsTab client={client} notify={notify} status={status} />
        </div>
      ) : null}
      {tab === "appearance" ? (
        <div role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance" className="set-body">
          {pageNotices}
          <AppearanceTab client={client} notify={notify} onAccentPicked={onAccentPicked} />
        </div>
      ) : null}
      {tab === "preferences" ? (
        <div role="tabpanel" id="settings-panel-preferences" aria-labelledby="settings-tab-preferences" className="set-body">
          {pageNotices}
          {/* ω99-268: #6 — the store-signature change signal rides the page's
              EXISTING status prop down to the memory panel (the App already
              threads status here — zero new page-level wiring). */}
          <PreferencesTab client={client} settings={settings} notify={notify} refresh={refresh} onModeApplied={onModeApplied} language={language} memorySignature={status?.memorySignature} />
        </div>
      ) : null}
      {tab === "persona" ? (
        <div role="tabpanel" id="settings-panel-persona" aria-labelledby="settings-tab-persona" className="set-body">
          {pageNotices}
          <PersonaPanel client={client} settings={settings} notify={notify} refresh={refresh} />
        </div>
      ) : null}
      {tab === "mcp" ? (
        <div role="tabpanel" id="settings-panel-mcp" aria-labelledby="settings-tab-mcp" className="set-body">
          {pageNotices}
          <McpTab client={client} />
        </div>
      ) : null}
      {tab === "plugins" ? (
        <div role="tabpanel" id="settings-panel-plugins" aria-labelledby="settings-tab-plugins" className="set-body">
          {pageNotices}
          {/* ω99-236: #3 — the 内置段 rides the page-level settings/refresh
              seams (the PreferencesTab pattern; only this plugins-tab line
              changes — the tab itself stays lazy). */}
          <PluginTab client={client} settings={settings} notify={notify} refresh={refresh} />
        </div>
      ) : null}
      </div>
      {/* iter4: the floating toast stack — anchored to the page's bottom-right
          (see .settings-toasts in styles.css), OUTSIDE .set so it overlays the
          panel column without touching the left nav. Rendered inside the same
          .settings-page container, so textContent-containment assertions (and
          the six tabs' notify seam) carry over unchanged. */}
      {toasts.length > 0 ? (
        <div className="settings-toasts" role="status" aria-live="polite">
          {toasts.map((t) => {
            // P2 通知变体制（§6.4）：警示/成功/信息前缀渲染面识别剥离，warn/ok
            // 走语义色 + 12px 细线前导字形，info 中性。新代码不写前缀
            // （src/notice-variant.ts）。
            const notice = classifyNotice(t.text);
            return (
              <div key={t.id} className="settings-toast" data-variant={notice.variant}>
                {notice.variant === "warn" ? <Icon name="triangle-alert" size={12} /> : notice.variant === "ok" ? <IconCheck size={12} className="ic" /> : null}
                <span className="settings-toast-text">{notice.text}</span>
                <button type="button" className="settings-toast-close" aria-label="关闭" onClick={() => dismissToast(t.id)}>
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
