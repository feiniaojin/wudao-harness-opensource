// ProviderTab — the settings page's 供应商 tab (settings-split): the
// provider-card matrix + the 默认模型/推理档 section, moved byte-equivalent
// from SettingsPage's 常规 panel. The envKey hint moved in from page level
// (spec 2026-08-23-settings-split §2: Key-related info belongs on the
// provider tab, nowhere else). The page-level concerns stay behind: the
// settingsStatus fetch (settings arrives as a prop), the receipts area, and
// the load error (notify/refresh are handed down instead).
//
// provider-management §6 (T4) → iter3 STRICT master-detail → 0.3.38 详情弹窗
// (用户 2026-08-31:供应商太多,拉到最下面点编辑,详情却渲染在页面最上方,要往
// 上翻找内容 —— 点开就该看到): the cards carry ZERO editing surface — no key
// input, no inline 保存/测试连接, no model chips. A card is identity + state
// (dot/status/endpoint/key badge/默认 marker) plus ONE actuator:「应用」
// switches the session to that provider in-place (the same /provider lane
// the model chips rode — receipt and all). Clicking the card body (or its
// name) opens the DETAIL MODAL (pvd — .scrim + .modal-card, centered over
// the page, always in view); ProviderDetail owns ALL configuration: API Key
// + 保存 + 测试连接, the model chips (the /model //provider quick-switch),
// baseUrl, the model table, the /models pull, save, and the custom-only
// delete. The master list is the tab's only column (a 30rem internal scroll
// box — the page itself never grows). The 默认模型/推理档 section stays
// byte-identical below.
//
// iter5 (trial feedback):「＋ 添加供应商」no longer pops an inline form — it
// mints a BLANK draft card at the HEAD of the list (client-side only, zero
// ops) and opens the pvd modal on NewProviderDetail, the completion form.
// Adding a provider is the same interaction as editing one (0.3.38: a modal
// — the create form rides the SAME dialog as the edit detail).
import { useEffect, useRef, useState } from "react";
import type { DriverStatus, ProviderCard, SettingsStatus, WudaoClient } from "../protocol.js";
import { NewProviderDetail, ProviderDetail } from "./ProviderDetail.js";
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "./ime-guard.js";

/** The card's models: the /model matrix rows for this provider + the
 *  profile default (the settingsStatus shape is provider-complete even when
 *  the driver status carries no choices yet). Exported for the M63 §C
 *  wizard's model step (learn-once: the same list both surfaces show). */
export function cardModels(card: ProviderCard, status: DriverStatus | null): readonly string[] {
  const fromChoices = (status?.model?.choices ?? [])
    .filter((c) => c.provider === card.provider)
    .map((c) => c.model);
  return fromChoices.includes(card.defaultModel) ? fromChoices : [...fromChoices, card.defaultModel];
}

export const DOT_TEXT: Readonly<Record<ProviderCard["status"], string>> = {
  ready: "可用",
  "missing-key": "缺 Key",
  "missing-endpoint": "缺端点",
};

const KEY_SOURCE_TEXT: Readonly<Record<string, string>> = {
  env: "key: 环境变量",
  credentials: "key: 凭据文件",
  none: "key: 未配置",
};

/** The card's key-status badge (iter3): 已配/未配 off the wire card's
 *  keySource — the ONLY key fact the master column still shows (the input
 *  itself lives in the detail). The source rides the badge text + title. */
const KEY_BADGE: Readonly<Record<string, { readonly cls: string; readonly text: string }>> = {
  env: { cls: "on", text: "已配 · 环境变量" },
  credentials: { cls: "on", text: "已配 · 凭据文件" },
  none: { cls: "off", text: "未配 Key" },
};
const keyBadge = (c: ProviderCard): { readonly cls: string; readonly text: string } =>
  KEY_BADGE[c.keySource ?? "none"] ?? KEY_BADGE.none!;
export { keyBadge, KEY_SOURCE_TEXT };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function ProviderTab({
  client,
  settings,
  status,
  notify,
  refresh,
  loadError,
}: {
  client: WudaoClient;
  settings: SettingsStatus | null;
  status: DriverStatus | null;
  notify: (text: string) => void;
  refresh: () => void;
  /** statecover C5 — the page-level settingsStatus fetch's error. While it
   *  is set, the 读取中… stand-in would be a LIE (the load already failed);
   *  the tab renders the error plus a 重试 riding the page's existing
   *  refresh() seam (no new channel — closing/reopening the page was the
   *  old retry). */
  loadError?: string | null;
}): React.JSX.Element {
  const [pending, setPending] = useState<string | null>(null);
  // §6 T4: the search box, the selected card. iter5: the add flow's draft
  // flag — true while the blank lead card + the create form are up (the draft
  // itself is client-side only; NewProviderDetail owns its fields). 0.3.38:
  // detailOpen gates the pvd MODAL — selection alone no longer paints a
  // detail column (there is none); a card click SELECTS and OPENS.
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftNew, setDraftNew] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  // ω99-305: the family focus-pull — the pvd card's Esc rides an element-level
  // onKeyDown, which only fires while focus is INSIDE the dialog. Opening from
  // a card click leaves focus under the scrim, so the card takes focus on
  // open, exactly like the rest of the .scrim > .modal-card family. Deps are
  // [detailOpen] only: `dialog` is an inline object rebuilt every render —
  // keying on it would re-pull focus on every keystroke inside the form.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (detailOpen) dialogRef.current?.focus();
  }, [detailOpen]);
  // ω99-309: pvd 详情卡内输入的组合态（composition 冒泡到卡级一处吃全）——
  // 组合期 Esc 是取消候选词，不是关卡（关卡=丢掉打到一半的表单稿）。
  const imeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });

  // The key lanes (settingsSaveKey / settingsTestConnection) moved to the
  // DETAIL with iter3's strict master-detail — the cards no longer carry a
  // keyrow. The 应用 button below is the cards' one actuator, riding the
  // same submitCommand switch lane the model chips always used.

  const submitCommand = (line: string, receipt: string): void => {
    client
      .submit(line)
      .then(() => notify(receipt))
      .catch((e: unknown) => notify(`⚠️ ${errText(e)}`));
  };

  /** §6: an invalid row deletes from the ROW itself (it never becomes
   *  selectable, so the detail's delete button is unreachable for it — but
   *  invalid rows ARE custom rows). */
  const deleteInvalid = (id: string): void => {
    setPending(`del:${id}`);
    client
      .settingsDeleteProvider(id)
      .then((r) => {
        if (r.ok) {
          notify(`已删除供应商 ${id}`);
          refresh();
        } else notify(`⚠️ 删除失败：${r.error}`); // ω99-204: #6
      })
      .catch((e: unknown) => notify(`⚠️ 删除失败：${errText(e)}`))
      .finally(() => setPending(null));
  };

  // Review L5: the LIVE driver identity wins — settingsStatus.current is
  // env-derived, so under `wudao ui --provider glm` it would badge deepseek
  // while the session actually runs glm. The env-derived values only stand
  // in when the driver carries no identity meta (null status.model).
  const currentProvider = status?.model?.provider ?? settings?.current.provider;
  const currentModel = status?.model?.label ?? settings?.current.model ?? "";

  // --- §6 master-detail plumbing ---------------------------------------------
  const cards = settings?.providers ?? [];
  const validCards = cards.filter((c) => c.invalidReason === undefined);
  // Cross-field search — label/id/baseUrl/endpoint/model names; a model-name
  // hit surfaces its provider (the a reference harness picker rule). Front-end filter
  // only; no virtualization at registry scale (spec §6's own call).
  const q = query.trim().toLowerCase();
  const visibleCards =
    q === ""
      ? cards
      : cards.filter((c) => {
          const names = [...c.models.map((m) => m.name), ...cardModels(c, status)];
          return [c.label, c.provider, c.baseUrl ?? "", c.endpoint ?? "", ...names].join("\n").toLowerCase().includes(q);
        });
  // The selection rides the FULL valid matrix (not the filtered view): hiding
  // the selected card does not deselect it — reopening still finds it. 0.3.38:
  // NO load-time fallback — the tab opens on the LIST (a modal popping over
  // the picker on load would be the old problem, inverted); a vanished id
  // (deleted provider) renders no modal. While the blank-card draft leads
  // (iter5) the draft IS the detail: the modal shows the create form. The
  // draft NEVER rides selectedId-type flows (nothing about it hits the
  // wire); selectedId survives underneath, so a cancel restores it.
  const selected = draftNew ? null : (validCards.find((c) => c.provider === selectedId) ?? null);

  /** Closes the pvd modal. Closing the CREATE form is its cancel — the draft
   *  drops with the dialog (a draft costs nothing). selectedId survives (the
   *  card keeps its aria-current「上次打开」mark). */
  const closeDetail = (): void => {
    setDetailOpen(false);
    setDraftNew(false);
  };

  // 0.3.38: the pvd dialog's target, computed here so TS narrows `selected`
  // through the ternary chain (the JSX-level `draftNew || selected !== null`
  // guard alone can't carry it in). null = nothing to show.
  const dialog: { readonly aria: string; readonly head: string; readonly body: React.JSX.Element } | null =
    settings === null
      ? null
      : draftNew
    ? {
        aria: "新增供应商",
        head: "新增供应商",
        body: (
          <NewProviderDetail
            client={client}
            notify={notify}
            refresh={refresh}
            onCreated={(id) => {
              // The ok reply's lane: the new id becomes the selection and the
              // draft card drops; the modal STAYS OPEN on the created card's
              // detail (the natural next step is saving its Key). The
              // refreshed matrix then carries the real card, already selected.
              setSelectedId(id);
              setDraftNew(false);
            }}
            onCancel={closeDetail}
          />
        ),
      }
    : selected !== null
      ? {
          aria: `供应商 ${selected.label}`,
          head: `供应商 · ${selected.provider === "wudao" ? "兼容端点(wudao)" : selected.label}`,
          body: (
            <ProviderDetail
              key={selected.provider}
              client={client}
              card={selected}
              models={cardModels(selected, status)}
              currentProvider={currentProvider}
              currentModel={currentModel}
              defaultModel={settings.defaultModel}
              notify={notify}
              refresh={refresh}
            />
          ),
        }
      : null;

  return (
    <>
      {settings?.envKey === true ? (
        <div className="hint">{"检测到环境变量 Key(WUDAO_API_KEY)——环境变量优先于凭据文件;保存到文件的 Key 只在没有环境变量时生效"}</div>
      ) : null}
      <div className="settings-section set-sec">
        <h3 className="section-title set-title">供应商</h3>
        {settings === null && loadError != null ? (
          // C5: the load failed — say THAT (not 读取中…), and offer the page's
          // refresh seam as the in-place retry.
          <div className="provider-load-error" role="alert">
            <span className="entry-error">{`无法读取设置:${loadError}`}</span>
            <button type="button" className="ctl" onClick={refresh}>
              重试
            </button>
          </div>
        ) : null}
        {settings === null && loadError == null ? <div className="muted">读取中…</div> : null}
        {settings !== null ? (
          <>
            <div className="provider-toolbar">
              <input
                type="text"
                className="wudao-input ctl provider-search"
                aria-label="搜索供应商"
                placeholder="搜索:名称 / id / baseUrl / 模型名"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button type="button" className="ctl" onClick={() => { setDraftNew(true); setDetailOpen(true); }}>
                {"＋ 添加供应商"}
              </button>
            </div>
            {/* round 5 E once carried a global-defaults strip here (默认模型/
                推理档太靠下 → 上移). 0.3.26 ① (用户:默认推理强度可以去掉)
                deleted its effort row; 0.3.31 ② (用户:默认 deepseek/… 也
                去掉) deleted the 默认模型 row — with nothing left the strip
                is GONE. The setting itself lives on in the detail pane:
                ☆ 设为默认 on the model row, the 默认 badge marking the hit;
                the strip's 当前-identity hint folded into that badge pair. */}
            <div className="provider-master">
              <div className="provider-cards">
                {draftNew ? (
                  // iter5: the blank lead card — client-side only (ZERO ops
                  // ride it; nothing about it ever hits the wire). It stays at
                  // index 0 regardless of the search query. The ONE exception
                  // to the cards-carry-no-editing-surface rule: the ✕ that
                  // drops the draft (a draft costs nothing — no confirmation).
                  <div
                    className="provider-card provider-draft"
                    data-draft="true"
                    data-provider="__draft__"
                    aria-current="true"
                  >
                    <div className="card-head">
                      <span className="dot draft" title="未保存" />
                      <span className="card-name">{"新增供应商"}</span>
                      <span className="meta">{"未保存"}</span>
                      <button type="button" className="ctl draft-cancel" onClick={() => setDraftNew(false)}>
                        {"✕ 取消草稿"}
                      </button>
                    </div>
                    <div className="card-status">{"在右侧补全信息后创建"}</div>
                  </div>
                ) : null}
                {visibleCards.map((c) => {
                  if (c.invalidReason !== undefined) {
                    // §3 fail-visible: a grayed minimal row — the registry
                    // entry refused to load. Never selectable (there is
                    // nothing to edit — the wire card is an id+reason stub);
                    // deletable from the row (invalid rows ARE custom rows).
                    return (
                      <div key={c.provider} className="provider-card invalid-card" data-status={c.status} data-invalid="true" data-provider={c.provider}>
                        <div className="card-head">
                          <span className={`dot ${c.status}`} title="注册表条目无效" />
                          <button type="button" className="card-name" disabled>
                            {c.label}
                          </button>
                          <span className="meta">{"注册表条目无效"}</span>
                        </div>
                        <div className="invalid-reason">{c.invalidReason}</div>
                        <div className="keyrow">
                          <button
                            type="button"
                            className="ctl"
                            disabled={pending === `del:${c.provider}`}
                            onClick={() => deleteInvalid(c.provider)}
                          >
                            {"删除"}
                          </button>
                        </div>
                      </div>
                    );
                  }
                  const isDefault = currentProvider === c.provider;
                  const isSelected = selected?.provider === c.provider;
                  const badge = keyBadge(c);
                  // Selecting a REAL card drops the draft (iter5): the draft
                  // and the selection are one detail surface — picking
                  // something real abandons the blank card. 0.3.38: picking
                  // also OPENS the pvd modal (点开就该看到).
                  const pick = (): void => {
                    setDraftNew(false);
                    setSelectedId(c.provider);
                    setDetailOpen(true);
                  };
                  return (
                    <div
                      key={c.provider}
                      className="provider-card"
                      data-status={c.status}
                      data-provider={c.provider}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={pick}
                    >
                      {/* 0.3.13 task 216 redesign — the persona-row two-line
                          hierarchy: identity row (dot + name + 默认, the key
                          badge pushed right), then ONE quiet caption line
                          (status · mono id · 自定义) instead of a bare status
                          word, then the mono endpoint. Same classNames, same
                          click lanes (the whole card still selects). */}
                      <div className="card-head">
                        <span className={`dot ${c.status}`} title={DOT_TEXT[c.status]} />
                        <button type="button" className="card-name" title="选中查看详情" onClick={pick}>
                          {c.provider === "wudao" ? "兼容端点(wudao)" : c.label}
                        </button>
                        {isDefault ? <span className="meta tag-default">{"默认"}</span> : null}
                        <span className={`key-badge ${badge.cls}`} title={KEY_SOURCE_TEXT[c.keySource ?? "none"]}>
                          {badge.text}
                        </span>
                      </div>
                      <div className="card-status">
                        <span className="status-word">{DOT_TEXT[c.status]}</span>
                        <span className="meta card-id">{c.provider}</span>
                        {c.custom ? <span className="meta">{"自定义"}</span> : null}
                      </div>
                      <div className="card-endpoint" title={c.endpoint ?? undefined}>{c.endpoint ?? "(未设置端点 —— 需要 WUDAO_BASE_URL)"}</div>
                      {/* round 5 F (用户:列表高度太小,没跟模型详情对齐): the
                          card carries its model COUNT — one more quiet line of
                          truth, and the master column's cards breathe at the
                          detail column's rhythm (the grid now stretches). */}
                      <div className="card-model-count">{`${cardModels(c, status).length} 个模型`}</div>
                      <div className="card-actions">
                        {/* The card's ONE actuator (iter3): the in-session
                            endpoint switch — the same /provider lane the
                            cross-provider model chips rode (ui-review-r5 I2),
                            receipt and all. The CURRENT provider's card is a
                            disabled no-op (it IS applied). stopPropagation:
                            this click is an apply, not a selection. */}
                        <button
                          type="button"
                          className="ctl card-apply"
                          disabled={isDefault}
                          title={
                            isDefault
                              ? "已是当前供应商"
                              : `submit /provider ${c.provider} (switches the endpoint)`
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            submitCommand(
                              `/provider ${c.provider}`,
                              `供应商 → ${c.provider} — 下一轮起切换端点,历史将全部重新处理(缓存全冷)`, // ω99-200: #1；ω99-310: 称谓随设置面统一
                            );
                          }}
                        >
                          应用
                        </button>
                      </div>
                    </div>
                  );
                })}
                {visibleCards.length === 0 ? <div className="provider-empty">{"无匹配供应商"}</div> : null}
              </div>
            </div>
            {/* 0.3.38 详情弹窗 (用户:点开就该看到,不要让内容躲在页面顶上): the
                detail column is gone — a card click (or the draft's create
                flow) opens the pvd dialog, .modal-card family mechanics
                verbatim from ModelConfigModal: scrim click / ✕ / Esc close
                (the page root's own Esc means 返回会话, so the key is swallowed
                HERE before it bubbles). The render guard's vanishing-target
                leg doubles as the delete flow's exit: the card disappears from
                the refreshed matrix → the dialog follows it out. */}
            {detailOpen && dialog !== null ? (
              <div
                className="scrim pvd-overlay"
                onClick={(e) => {
                  if (e.target === e.currentTarget) closeDetail(); // the scrim, not the card
                }}
              >
                <div
                  className="modal-card pop-in pvd"
                  role="dialog"
                  aria-modal="true"
                  aria-label={dialog.aria}
                  ref={dialogRef}
                  tabIndex={-1}
                  onCompositionStart={() => { imeRef.current = imeStart(imeRef.current); }}
                  onCompositionEnd={() => { imeRef.current = imeEnd(imeRef.current, Date.now()); }}
                  onKeyDown={(e) => {
                    /* ω99-309: 组合期 IME 拥有键盘——Esc 是取消候选词，不是关详情卡。 */
                    if (imeSwallows(e.nativeEvent, imeRef.current, Date.now())) return;
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      closeDetail();
                    }
                  }}
                >
                  <div className="pvd-head">
                    <h3>{dialog.head}</h3>
                    <button
                      type="button"
                      className="ctl pvd-close"
                      aria-label="关闭"
                      title="关闭(丢弃未保存的修改)"
                      onClick={closeDetail}
                    >
                      {"✕"}
                    </button>
                  </div>
                  <div className="pvd-body">{dialog.body}</div>
                </div>
              </div>
            ) : null}
            <div className="hint">{`凭据文件:${settings.credentials.path}(现有 ${settings.credentials.keyCount} 个 Key,仅本机)`}</div>
          </>
        ) : null}
      </div>
    </>
  );
}
