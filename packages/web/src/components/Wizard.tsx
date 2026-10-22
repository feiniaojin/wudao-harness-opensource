// Wizard — M63 §C's first-run wizard: a full-viewport overlay that takes over
// when NO provider is ready (the App-level gate in wizard.ts decides; a ready
// matrix never mounts this component at all). Six steps (spec §C):
//
//   ① 欢迎        brand + three sentences of what it can do
//   ② 供应商选择   the settingsStatus card matrix, click to choose
//   ③ Key 粘贴    the SAME save+test flow as the settings page (learn-once):
//                 「测试连接」 tests the unsaved paste; a PASS auto-saves the
//                 key to the credentials file; 下一步 stays disabled until it
//                 passes (test-before-continue — HD2 research 35 #10); the
//                 three human failure states render verbatim. A missing-
//                 ENDPOINT provider (wudao — no WUDAO_BASE_URL) can never
//                 pass a test, so its paste saves DIRECTLY (「连接测试跳过」)
//                 and the step proceeds on the saved key with the endpoint
//                 warning — r3 I1: the only exit is never an accidental dead
//                 end, just the deliberate 跳过 below.
//   ④ 推荐模型     the provider default, changeable (cardModels — the same
//                 list the settings page shows)
//   ⑤ 权限默认     the tier selector, default = the workspace tier (shown
//                 as accept,0.3.13 起对齐 the upstream format词汇); 可改为 ask / auto /
//                 plan(0.3.14 只读探查档)。0.3.11: 双写 — setMode 管本会
//                 话, settingsSet("permissions.defaultMode") 持久化新会话
//                 起步档
//   ⑥ 完成         writes land: ui.defaultMode=simple, wizard.completedVersion
//                 (versioned — a copy bump re-shows), and /provider + /model
//                 submissions make the just-saved key serve THIS session (the
//                 credentials-file leg of the switch seam). A failing write
//                 lands in the error LIST (r3 P8) — concurrent failures all
//                 show, up to 3 + "+N more".
//
// Skippable at every step after ①: skipping marks the copy version seen (no
// re-nag; a bump re-shows) and lands in browse-only mode — App shows the
// persistent 去配置 banner while the matrix stays not-ready.
//
// r3 I2: steps ③-⑤ carry 上一步 (the step state survives — a wrong provider
// pick is correctable in place). r3 P7: the dialog OWNS focus on open, Esc
// asks a confirm before the skip (first-run — an accidental key must not
// lose progress), and focus returns to whatever opened it (去配置's banner
// button; body on the cold first mount).
import { useEffect, useRef, useState } from "react";
import type { DriverStatus, ProviderCard, SettingsStatus, WudaoClient } from "../protocol.js";
import { WIZARD_COPY_VERSION } from "../wizard.js";
import { useFocusReturn } from "../use-focus-return.js";
import { cardModels } from "./ProviderTab.js";
import { Icon } from "./Icon.js";
import { ShieldSelector } from "./ShieldSelector.js";
import type { ShieldMode } from "./ShieldSelector.js";
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "./ime-guard.js";

const DOT_TEXT: Readonly<Record<ProviderCard["status"], string>> = {
  ready: "可用",
  "missing-key": "缺 Key",
  "missing-endpoint": "缺端点",
};

const WELCOME_POINTS: readonly string[] = [
  "读懂你的代码库 —— 直接读文件、检索、解释这段代码在做什么",
  "动手干活 —— 修 bug、写页面、跑命令和测试,任何写入先征求你的同意",
  "从一句话开始 —— 用大白话描述你想构建什么,它自己规划步骤并完成",
];

const STEP_TITLES: readonly string[] = ["欢迎", "选择供应商", "粘贴 Key", "选择模型", "权限", "完成"];

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function Wizard({
  client,
  status,
  settings,
  onDone,
  step: stepProp,
  total: totalProp,
}: {
  client: WudaoClient;
  status: DriverStatus | null;
  settings: SettingsStatus;
  /** completion or skip — App clears the overlay and refreshes the banner. */
  onDone: () => void;
  /** 墨线 T13: display source for the progress line + mono step counter —
   *  the walk's live values when absent (App never passes these; they pin
   *  the shell in the visual suite). Display-only: the state machine below
   *  reads its own `step` state, untouched. */
  step?: number;
  total?: number;
}): React.JSX.Element {
  const [step, setStep] = useState(1);
  const [providerChoice, setProviderChoice] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [testPending, setTestPending] = useState(false);
  const [testResult, setTestResult] = useState<{ readonly ok: boolean; readonly state: string; readonly message: string } | null>(null);
  const [keySaved, setKeySaved] = useState(false);
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [shield, setShield] = useState<ShieldMode>("workspace");
  const [receipts, setReceipts] = useState<readonly string[]>([]);
  // r3 P8: the failing completion writes collect in a LIST — the old single
  // slot overwrote, so two concurrent failures showed only the last.
  const [writeErrors, setWriteErrors] = useState<readonly string[]>([]);
  // r3 P7: Esc's confirm gate (first-run — an accidental Esc must not lose
  // progress; the confirm rides the SAME skip semantics as 跳过,先逛逛).
  const [escConfirm, setEscConfirm] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  // ω99-309: overlay 级组合态——③ 的 Key 粘贴输入（及未来任何卡内输入）的
  // composition 冒泡到 overlay 一处吃全；组合期 Esc 是取消候选词，不是退
  // 出向导（r3 P7 的 confirm 卡本就防误触，组合期误 arm 同样是误触）。
  const imeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });

  const card = settings.providers.find((c) => c.provider === providerChoice) ?? null;
  // statecover C7: a blank default (an endpoint-less registry stub resolving
  // no real model) is not a choice — filtering here makes ④'s empty state
  // reachable exactly when the provider has nothing to pick.
  const models = card !== null ? cardModels(card, status).filter((m) => m !== "") : [];
  // r3 I1: the chosen provider has NO endpoint (wudao without WUDAO_BASE_URL)
  // — a connection test can never pass, so ③'s button saves the paste
  // directly and the step warns instead of dead-ending.
  const endpointMissing = card?.status === "missing-endpoint";

  // 墨线 T13: the shell's progress line + mono step counter. The walk is
  // 1-based over STEP_TITLES (6 steps); the optional props override the
  // DISPLAY only (see the props note above) — zero-padded both sides, the
  // bar's inline width = step/total (the todo-bar seam), rounded to whole
  // percents (① of 6 → 17%).
  const dispStep = stepProp ?? step;
  const dispTotal = Math.max(1, totalProp ?? STEP_TITLES.length);
  const dispTitle = STEP_TITLES[Math.min(Math.max(dispStep, 1), STEP_TITLES.length) - 1] ?? "";
  const dispCounter = `${String(dispStep).padStart(2, "0")}/${String(dispTotal).padStart(2, "0")}`;
  const dispWidth = `${Math.min(100, Math.round((dispStep / dispTotal) * 100))}%`;

  // r3 P7: the dialog owns focus on open (the 去配置 banner click, or body on
  // the cold first mount, gets it back on close — the r1 useFocusReturn
  // idiom). Effect order: BEFORE the focus effect below, same rule as the
  // palette's trigger capture.
  useFocusReturn();
  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  const notify = (text: string): void => {
    setReceipts((rows) => [...rows.slice(-4), text]);
  };

  /** Skip (any step after ①): mark this copy version seen — no re-nag until
   *  the copy bumps — and hand control back to the browse-only surface. */
  const skip = (): void => {
    client
      .settingsSet("wizard.completedVersion", WIZARD_COPY_VERSION)
      .catch((e: unknown) => { /* the version marker is best-effort on skip; a bump still re-shows */ });
    onDone();
  };

  /** r3 P8: a failing completion write APPENDS — every failure stays visible
   *  (up to 3 rendered + "+N more"), none overwrite another. */
  const addWriteError = (text: string): void => {
    setWriteErrors((rows) => [...rows, text]);
  };

  /** ③'s 测试连接: test the UNSAVED paste through the target provider (the
   *  same op the settings page rides); a pass auto-saves the key — the
   *  wizard's completion then only switches the live provider to it.
   *  r3 I1: a missing-ENDPOINT provider skips the test entirely — the paste
   *  saves directly (a test without WUDAO_BASE_URL can only ever fail), and
   *  ③ proceeds on the saved key with the endpoint warning. */
  const testConnection = (): void => {
    if (providerChoice === null) return;
    const key = keyDraft.trim();
    if (key === "") return;
    setTestPending(true);
    setTestResult(null);
    if (endpointMissing) {
      client
        .settingsSaveKey(providerChoice, key)
        .then(() => {
          setKeySaved(true);
          setKeyDraft("");
          notify("Key 已保存到凭据文件(权限 0600)—— 仅保存在本机");
        })
        .catch((e: unknown) => {
          // r3-review MINOR: a notify() receipt renders only at ⑥ — at ③ a
          // silent save failure looks exactly like the dead end I1 removed.
          // Route it into the same inline slot the test path uses.
          setTestResult({ ok: false, state: "http", message: `Key 保存失败：${errText(e)}` }); // ω99-204: #2
        })
        .finally(() => setTestPending(false));
      return;
    }
    client
      .settingsTestConnection(providerChoice, { key, ...(card !== null ? { model: card.defaultModel } : {}) })
      .then((r) => {
        setTestResult(r);
        if (r.ok) {
          // Pass → persist immediately (skip-proof: leaving the wizard at ④/⑤
          // keeps the working key; the matrix flips ready either way).
          return client
            .settingsSaveKey(providerChoice, key)
            .then(() => {
              setKeySaved(true);
              setKeyDraft("");
              notify(`Key 已保存到凭据文件(权限 0600)—— 仅保存在本机`);
            })
            .catch((e: unknown) => notify(`⚠️ Key 保存失败：${errText(e)}`));
        }
        return undefined;
      })
      .catch((e: unknown) => setTestResult({ ok: false, state: "http", message: `测试失败：${errText(e)}` }))
      .finally(() => setTestPending(false));
  };

  /** ⑤ → ⑥: apply the shield and fire the completion writes. The op replies
   *  arrive async; receipts collect as they land (⑥ renders the summary). */
  const complete = (): void => {
    if (providerChoice === null) return;
    const model = modelChoice ?? card?.defaultModel ?? "";
    // 0.3.11（权限档两入口 1:1 联动）: ⑤ 的承诺是「之后也能随时在设置里
    // 调整」——那需要持久化。双写:settingsSet 落 permissions.defaultMode
    // (新会话起步档,重启不丢),setMode 只管本会话实时档。0.3.12: 盾档值
    // = workspace/ask/auto 三档。
    client
      .settingsSet("permissions.defaultMode", shield)
      .then(() => notify(`新会话默认权限档 → ${shield === "workspace" ? "accept(默认档)" : shield}(已持久化)`))
      .catch((e: unknown) => addWriteError(`默认权限档写入失败：${errText(e)}`));
    client
      .setMode(shield)
      .then(() => notify(`本会话权限档 → ${shield === "workspace" ? "accept(默认档)" : shield}`))
      .catch((e: unknown) => addWriteError(`权限档设置失败：${errText(e)}`));
    client
      .settingsSet("ui.defaultMode", "simple")
      .then(() => notify("默认界面 → 简洁模式 —— 下次打开生效"))
      .catch((e: unknown) => addWriteError(`默认界面写入失败：${errText(e)}`));
    client
      .settingsSet("wizard.completedVersion", WIZARD_COPY_VERSION)
      .catch((e: unknown) => addWriteError(`向导标记写入失败：${errText(e)}`));
    // The live switch: the just-saved file key serves THIS session (the
    // switch seam's credentials leg) — no restart after the wizard.
    client
      .submit(`/provider ${providerChoice}`)
      // ω99-199: #4
      .then(() => notify(`供应商 → ${providerChoice} — 本会话即刻生效(历史将在新端点重算,缓存全冷)`)) // ω99-310: 称谓随设置面统一
      // R5-web review MINOR: the old catch promised「重启 wudao ui 后生效」—
      // but nothing persists the provider choice, so a restart alone never
      // lands it. The truth: the Key IS saved (step ③); only the live switch
      // failed. Re-picking the provider re-runs /provider against that saved
      // key and succeeds.
      .catch((e: unknown) => addWriteError(`provider 切换失败：${errText(e)} —— 请重新选择供应商后重试(保存的 Key 已生效)`));
    if (model !== "") {
      client
        .submit(`/model ${model}`)
        // ω99-195: #9（仅切换通知前缀中文化；尾语原样）
        .then(() => notify(`模型 → ${model} — 下一轮生效`))
        .catch((e: unknown) => notify(`⚠️ model 切换失败：${errText(e)}`));
    }
    setStep(6);
  };

  return (
    <div
      className="wizard-overlay"
      role="dialog"
      aria-label="新手向导"
      ref={overlayRef}
      tabIndex={-1}
      onCompositionStart={() => { imeRef.current = imeStart(imeRef.current); }}
      onCompositionEnd={() => { imeRef.current = imeEnd(imeRef.current, Date.now()); }}
      onKeyDown={(e) => {
        // ω99-309: 组合期 IME 拥有键盘——Esc 先过组合守卫再谈退出向导。
        if (imeSwallows(e.nativeEvent, imeRef.current, Date.now())) return;
        if (e.key !== "Escape") return;
        e.preventDefault();
        // r3 P7: ⑥ has nothing left to lose — Esc hands back directly; every
        // earlier step routes through the confirm (an accidental key must not
        // drop a half-done configuration).
        if (step === 6) onDone();
        else setEscConfirm(true);
      }}
    >
      {/* 墨线 T13: the ink-line card — the 2px accent progress line (inline
          width = step/total) + the head (mono "01/06" counter, step title)
          replace the old six-dot row; overflow:hidden clips the bar to the
          12px radius and the per-step .wiz-body owns the card's scroll. */}
      {/* 墨线 T14: the entry animation rides the shared .pop-in companion. */}
      <div className="wiz pop-in">
        <div className="wiz-bar" aria-hidden={true} style={{ width: dispWidth }} />
        <div className="wiz-head">
          <span className="wiz-step">{dispCounter}</span>
          <span className="wiz-title">{dispTitle}</span>
        </div>

        {step === 1 ? (
          <div className="wiz-body" data-step="welcome">
            <h2>wudao · 你的 AI 编程助手</h2>
            <p className="wizard-sub">三次点击完成配置,马上开始。</p>
            <ul className="wizard-points">
              {WELCOME_POINTS.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="wiz-body" data-step="provider">
            <h3>选择模型供应商</h3>
            <p className="wizard-sub">选一个你有 API Key 的供应商 —— 之后随时可以换或再加。</p>
            <div className="wizard-cards">
              {settings.providers.length === 0 ? (
                // statecover C7 — the registry came back empty (every entry
                // refused to load / a wiped registry): the step was a bare
                // box before. The wizard cannot proceed without a provider,
                // so the empty state says that AND where to go instead.
                <div className="wizard-empty" role="status">
                  {"暂无可用供应商 —— 可先跳过，稍后在设置的「供应商」中添加"}
                </div>
              ) : null}
              {settings.providers.map((c) => (
                <button
                  key={c.provider}
                  type="button"
                  className={`wizard-provider-card${providerChoice === c.provider ? " sel" : ""}`}
                  data-status={c.status}
                  data-selected={providerChoice === c.provider}
                  onClick={() => setProviderChoice(c.provider)}
                >
                  <span className={`dot ${c.status}`} title={DOT_TEXT[c.status]} />
                  <span className="card-name">{c.provider === "wudao" ? "兼容端点(wudao)" : c.label}</span>
                  {c.status === "missing-endpoint" ? (
                    // r3 I1: the missing-endpoint mark at the CHOICE step —
                    // the user knows before ③ that this card needs
                    // WUDAO_BASE_URL (and that its key saves untested).
                    <span className="wizard-badge" title="该供应商需要先设置 WUDAO_BASE_URL 端点;向导中粘贴的 Key 将不经连接测试直接保存">
                      需 BASE_URL
                    </span>
                  ) : null}
                  <span className="meta">{DOT_TEXT[c.status]}</span>
                  <span className="meta">{`推荐模型 ${c.defaultModel}`}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="wiz-body" data-step="key">
            <h3>{`粘贴 ${card?.label ?? providerChoice} 的 API Key`}</h3>
            <p className="wizard-sub">Key 只写入本机凭据文件(~/.wudao/.credentials.yaml,权限 0600),不会出现在任何配置或界面上。</p>
            {endpointMissing ? (
              // r3 I1: the honest substitution — without WUDAO_BASE_URL the
              // test op can only ever fail, so this step saves the paste
              // untested and says so (the settings page owns the endpoint).
              <div className="hint" data-endpoint-warning="">
                未配置 BASE_URL,连接测试跳过 —— 可稍后在设置中配置
              </div>
            ) : null}
            <div className="keyrow">
              <input
                type="password"
                className="wudao-input key-input"
                placeholder="粘贴 API Key"
                aria-label="API Key"
                value={keyDraft}
                disabled={keySaved}
                onChange={(e) => {
                  setKeyDraft(e.target.value);
                  setKeySaved(false);
                  setTestResult(null);
                }}
              />
              <button
                type="button"
                className="wudao"
                disabled={keyDraft.trim() === "" || testPending || keySaved}
                onClick={testConnection}
              >
                {testPending ? (endpointMissing ? "保存中…" : "测试中…") : endpointMissing ? "保存 Key" : "测试连接"}
              </button>
            </div>
            {testResult !== null ? (
              <div className={`test-result ${testResult.ok ? "ok" : `fail ${testResult.state}`}`} data-state={testResult.state}>
                {testResult.message}
              </div>
            ) : null}
            {keySaved ? (
              <div className="hint">
                {endpointMissing ? "Key 已保存(未配置 BASE_URL,连接测试已跳过)—— 可以继续。" : "测试通过,Key 已保存 —— 可以继续。"}
                {/* Re-paste affordance: a valid-but-wrong key (wrong account,
                 *  wrong provider) must be correctable in place, not just by
                 *  leaving the wizard for the settings page. */}
                <button
                  type="button"
                  className="wizard-skip"
                  onClick={() => {
                    setKeySaved(false);
                    setTestResult(null);
                  }}
                >
                  重新粘贴另一个 Key
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="wiz-body" data-step="model">
            <h3>选择模型</h3>
            <p className="wizard-sub">{`推荐使用 ${card?.defaultModel ?? ""}(该供应商默认);有其他需要也可以换。`}</p>
            <div className="card-models">
              {models.length === 0 ? (
                // statecover C7 — the chosen provider resolved no models (an
                // empty registry default and no live choices): without this
                // the step was an empty box with a blind 下一步.
                <div className="wizard-empty" role="status">
                  {"该供应商暂无可用模型 —— 可返回上一步重选，或稍后在设置的「供应商」中刷新模型列表"}
                </div>
              ) : null}
              {models.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`model-chip${modelChoice === m ? " primary" : ""}`}
                  onClick={() => setModelChoice(m)}
                >
                  {m}
                  {m === card?.defaultModel ? "(推荐)" : ""}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === 5 ? (
          <div className="wiz-body" data-step="permission">
            <h3>权限默认:accept</h3>
            <p className="wizard-sub">accept(接受编辑):工作区内自由读写,只读命令(git status 等)放行,其他操作会询问 —— 你可以改为 ask(每次询问)、auto(全自动)或 plan(只读探查);这里是新会话的起步档,本会话也即刻生效,之后能随时在设置里调整。</p>
            <ShieldSelector value={shield} onChange={setShield} direction="down" />
          </div>
        ) : null}

        {step === 6 ? (
          <div className="wiz-body" data-step="done">
            {/* 116 弧 C：🎉 → party-popper 细线字形（完成仪式保留，位图退役）。 */}
            <h3>完成 <Icon name="party-popper" size={15} /></h3>
            <p className="wizard-sub">{`已配置 ${card?.label ?? providerChoice}/${modelChoice ?? ""} —— 从一句话开始试试:描述你想构建什么。`}</p>
            {receipts.length > 0 ? (
              <div className="settings-receipts">
                {receipts.map((r, i) => (
                  <div key={`${i}-${r.slice(0, 12)}`}>{r}</div>
                ))}
              </div>
            ) : null}
            {writeErrors.length > 0 ? (
              // r3 P8: every failing write stays listed — the 3 latest plus
              // the overflow count (the old single slot kept only the last).
              <div className="entry-error">
                {writeErrors.slice(-3).map((e, i) => (
                  <div key={`${i}-${e.slice(0, 12)}`}>{e}</div>
                ))}
                {writeErrors.length > 3 ? <div>{`+${writeErrors.length - 3} more`}</div> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="wizard-actions">
          {step > 1 && step < 6 ? (
            <button type="button" className="wizard-skip" onClick={skip}>
              跳过,先逛逛
            </button>
          ) : (
            <span />
          )}
          <span className="wizard-nav">
            {/* r3 I2: steps ③-⑤ carry 上一步 — the step state survives the
                walk, so a wrong provider pick is correctable in place. */}
            {step >= 3 && step <= 5 ? (
              <button type="button" className="wudao" onClick={() => setStep(step - 1)}>
                上一步
              </button>
            ) : null}
            {step === 1 ? (
              <button type="button" className="wudao primary" onClick={() => setStep(2)}>
                开始配置
              </button>
            ) : null}
            {step === 2 ? (
              <button
                type="button"
                className="wudao primary"
                disabled={providerChoice === null}
                onClick={() => {
                  setKeyDraft("");
                  setTestResult(null);
                  setKeySaved(false);
                  setStep(3);
                }}
              >
                下一步
              </button>
            ) : null}
            {step === 3 ? (
              <button type="button" className="wudao primary" disabled={!keySaved} onClick={() => {
                setModelChoice(card?.defaultModel ?? null);
                setStep(4);
              }}>
                下一步
              </button>
            ) : null}
            {step === 4 ? (
              <button type="button" className="wudao primary" onClick={() => setStep(5)}>
                下一步
              </button>
            ) : null}
            {step === 5 ? (
              <button type="button" className="wudao primary" onClick={complete}>
                完成
              </button>
            ) : null}
            {step === 6 ? (
              <button type="button" className="wudao primary" onClick={onDone}>
                开始使用
              </button>
            ) : null}
          </span>
        </div>
      </div>
      {/* r3 P7: the Esc confirm — leaving the wizard early is the SKIP
          semantics (completedVersion written, browse-only until 配置), so it
          must be explicit, never an accidental keypress. */}
      {escConfirm ? (
        <div className="scrim wizard-confirm" onClick={(e) => { if (e.target === e.currentTarget) setEscConfirm(false); }}>
          <div
            className="modal-card pop-in"
            role="dialog"
            aria-label="退出向导"
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation(); // the confirm's Esc CANCELS, not re-arms
                setEscConfirm(false);
              }
            }}
          >
            <h3>退出配置向导？</h3>
            <div className="muted">将标记为已跳过(只读浏览模式),之后可从顶部横幅的「去配置」重新进入。</div>
            <div className="btnrow">
              <button
                type="button"
                className="wudao danger"
                onClick={() => {
                  setEscConfirm(false);
                  skip();
                }}
              >
                跳过并退出
              </button>
              <button type="button" className="wudao" onClick={() => setEscConfirm(false)}>
                继续配置
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
