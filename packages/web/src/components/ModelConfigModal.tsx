// ModelConfigModal — round 6 (2026-08-30 spec): the ONE edit door for a
// provider's models. Five in-page rearrangement rounds (chips → table →
// read-table + expand) missed the actual problem — the interaction SHAPE —
// so this joins the industry-standard form (Cherry Studio / LobeChat /
// OpenWebUI): the detail page carries read rows + a 「配置模型」 button, and
// ALL model editing happens here, in a modal, with the dual-channel add the
// user dictated — type a name by hand OR pull /models and pick from the
// dropdown. The 0.3.19 "弹窗太丑" standing rule died with this component:
// it rejected a modal for the IN-SESSION model picker, not for settings
// (spec §0).
//
// Protocol layer is untouched (spec §4): the pull rides the SAME
// settingsListModels op the old inline picker did (the key ladder: a pasted
// panel key tests the paste; without one the server resolves env →
// credentials), and the save rides settingsSaveProvider with the same
// two-branch payload discipline — with ONE deliberate difference from the
// panel's save: every echo field sources from the CARD AT OPEN (the server
// truth), never the panel's unsaved drafts. The modal knows models and
// nothing else; a dirty panel's label/baseUrl edits stay in the panel's
// world until its own 保存修改.
//
// Clobber defense (spec §2, review R1): a successful save reports the final
// rows to the parent via onSaved, which mirrors them into the panel draft
// through RAW setDraft — never editDraft, which flips the clean flag and
// would false-alarm 「未保存的修改」 on a clean panel. The mirror write also
// guarantees that a panel edit in flight, when it later saves, carries the
// NEW rows plus its own field drafts — never the pre-modal rows.
import { useEffect, useRef, useState } from "react";
import type { ProviderCard, WudaoClient } from "../protocol.js";
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "./ime-guard.js";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One model row's editable draft (ctx stays a string — the input's shape;
 * the int conversion happens at save time). Shared with the panel's draft —
 * round 6 moved the type's home HERE because the modal is the rows' editor
 * and the panel only mirrors them. */
export interface RowDraft {
  readonly name: string;
  readonly ctx: string;
}

/** The save payload's models array: trimmed, unnamed rows dropped, ctx parsed
 * to a positive int (anything unparsable/empty = inherit → the field is
 * simply absent, exactly the registry's "omit to inherit" rule). */
export function modelsPayload(rows: readonly RowDraft[]): { name: string; contextLength?: number }[] {
  return rows
    .map((r) => ({ name: r.name.trim(), ctx: r.ctx.trim() }))
    .filter((r) => r.name !== "")
    .map((r) => {
      const n = Number.parseInt(r.ctx, 10);
      return r.ctx !== "" && Number.isInteger(n) && n > 0 ? { name: r.name, contextLength: n } : { name: r.name };
    });
}

/** A /models catalog entry — the dropdown's row. */
interface PullCandidate {
  readonly name: string;
  readonly contextLength?: number;
}

export function ModelConfigModal({
  client,
  card,
  keyDraft,
  fallbackWindow,
  notify,
  refresh,
  onClose,
  onSaved,
}: {
  client: WudaoClient;
  /** The card AT OPEN — the echo source for every save payload field (the
   * panel's unsaved drafts never ride this modal's save). */
  card: ProviderCard;
  /** The panel's pasted-key draft (edit-mode only) — a non-empty paste rides
   * the /models pull; read mode walks the server's stored-key ladder. */
  keyDraft: string;
  /** The number an empty ctx inherits — the add row's placeholder hint. */
  fallbackWindow: number | null | undefined;
  notify: (text: string) => void;
  refresh: () => void;
  onClose: () => void;
  /** Clobber defense: the saved rows, mirrored into the panel draft via RAW
   * setDraft (the parent's wiring — R1: never editDraft). */
  onSaved: (rows: readonly RowDraft[]) => void;
}): React.JSX.Element {
  const [rows, setRows] = useState<readonly RowDraft[]>(() =>
    card.models.map((m) => ({ name: m.name, ctx: m.contextLength != null ? String(m.contextLength) : "" })),
  );
  const [name, setName] = useState("");
  const [ctx, setCtx] = useState("");
  const [open, setOpen] = useState(false);
  const [pool, setPool] = useState<readonly PullCandidate[] | null>(null);
  const [pullError, setPullError] = useState<{ readonly state: string; readonly message: string } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // ω99-309: 卡内四个输入的组合态（composition 冒泡到卡级一处吃全）——
  // 组合期 Esc 是取消候选词，不是关卡（关卡=丢掉打到一半的配置稿）。
  const imeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });

  // Open focuses the name input — the modal's primary lane is adding.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  /** The /models pull, verbatim from the panel lane it replaced: the op's key
   * ladder, the failure classifier (state+message rendered in place), and
   * the F6 dedupe within the response (first occurrence wins). A failure
   * NEVER blocks the manual channel — the two add channels are peers. */
  const pull = (): void => {
    setPulling(true);
    setPullError(null);
    client
      .settingsListModels(card.provider, keyDraft.trim() !== "" ? { key: keyDraft.trim() } : undefined)
      .then((r) => {
        if (!r.ok) {
          setPullError({ state: r.state, message: r.message });
          return;
        }
        const seen = new Set<string>();
        setPool(
          r.models.filter((m) => {
            if (m.name === "" || seen.has(m.name)) return false;
            seen.add(m.name);
            return true;
          }),
        );
      })
      .catch((e: unknown) => setPullError({ state: "network", message: errText(e) }))
      .finally(() => setPulling(false));
  };

  // Auto-pull on open (spec §2). The mount effect closes over the OPEN-TIME
  // keyDraft — exactly the semantics the spec fixes; 重试 re-reads the
  // current prop through the fresh render's closure.
  useEffect(() => {
    pull();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the mount-time
    // snapshot is the contract; a keyDraft change mid-flight re-pulls on
    // the next 重试, never silently here.
  }, []);

  // The 已配置 set is computed against the LIVE rows — a model added or
  // renamed mid-session goes disabled in the dropdown immediately (not an
  // open-time snapshot).
  const configured = new Set(rows.map((r) => r.name.trim()).filter((n) => n !== ""));
  const trimmed = name.trim();
  const canAdd = trimmed !== "" && !configured.has(trimmed);
  const q = name.trim().toLowerCase();
  const visible = pool === null ? [] : q === "" ? pool : pool.filter((m) => m.name.toLowerCase().includes(q));

  const pick = (m: PullCandidate): void => {
    setName(m.name);
    if (m.contextLength != null) setCtx(String(m.contextLength));
    setOpen(false);
  };

  const add = (): void => {
    if (!canAdd) return;
    setRows((rs) => [...rs, { name: trimmed, ctx: ctx.trim() }]);
    setName("");
    setCtx("");
    setOpen(false);
  };

  const setRow = (i: number, patch: Partial<RowDraft>): void => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  /** models-only semantics + the full-echo discipline (spec §2): the two
   * branches are the panel save's verbatim, with every echo field sourced
   * from the CARD (the builtin overlay's label-only-if-changed clause
   * collapses to never — the modal cannot change the label). */
  const save = (): void => {
    setSaving(true);
    const models = modelsPayload(rows);
    const config: Record<string, unknown> = card.custom
      ? {
          ...(card.label.trim() !== "" ? { label: card.label.trim() } : {}),
          baseUrl: (card.baseUrl ?? "").trim(),
          ...(card.defaultModel !== "" ? { defaultModel: card.defaultModel } : {}),
          ...(card.defaultContextLength != null ? { defaultContextLength: card.defaultContextLength } : {}),
          ...(card.reasoningFormat !== undefined ? { reasoningFormat: card.reasoningFormat } : {}),
          ...((card.wire ?? "") !== "" ? { wire: card.wire } : {}),
          ...(card.persona !== undefined ? { persona: card.persona } : {}),
          ...(card.effort !== undefined ? { effort: card.effort } : {}),
          models,
        }
      : {
          models,
          ...(card.reasoningFormat !== undefined ? { reasoningFormat: card.reasoningFormat } : {}),
          ...(card.wire !== undefined ? { wire: card.wire } : {}),
          ...(card.persona !== undefined ? { persona: card.persona } : {}),
          ...(card.effort !== undefined ? { effort: card.effort } : {}),
        };
    client
      .settingsSaveProvider(card.provider, config)
      .then((r) => {
        if (r.ok) {
          notify(`已保存供应商 ${r.provider} 的模型配置`);
          onSaved(rows);
          refresh();
          onClose();
        } else notify(`⚠️ 保存失败：${r.error}`); // ω99-204: #5
      })
      .catch((e: unknown) => notify(`⚠️ 保存失败：${errText(e)}`))
      .finally(() => setSaving(false));
  };

  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(); // the scrim, not the card
      }}
    >
      <div
        className="modal-card pop-in mcm"
        role="dialog"
        aria-modal="true"
        aria-label={`配置模型 ${card.provider}`}
        ref={dialogRef}
        tabIndex={-1}
        onCompositionStart={() => { imeRef.current = imeStart(imeRef.current); }}
        onCompositionEnd={() => { imeRef.current = imeEnd(imeRef.current, Date.now()); }}
        onKeyDown={(e) => {
          // R2: the FIRST modal nested inside the settings page — the page
          // root's own Esc means 返回会话, and React synthetic events bubble
          // through the React tree, so this handler must swallow the key
          // before it reaches the page (stopPropagation, not just
          // preventDefault).
          // ω99-309: 组合期 IME 拥有键盘——Esc 先过组合守卫再谈关卡。
          if (imeSwallows(e.nativeEvent, imeRef.current, Date.now())) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="mcm-head">
          <h3>{`配置模型 · ${card.provider}`}</h3>
          <button type="button" className="ctl mcm-close" aria-label="关闭" title="关闭(丢弃未保存的修改)" onClick={onClose}>
            {"✕"}
          </button>
        </div>

        {/* The dual-channel add row — ONE form: the name input is both the
            manual channel and the dropdown's live filter word. */}
        <div className="mcm-add">
          <div className="mcm-add-name">
            <input
              ref={nameRef}
              type="text"
              className="wudao-input ctl mcm-name"
              aria-label="模型名称"
              placeholder="模型名称(手输,或从下拉选择)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="button"
              className="ctl mcm-drop-toggle"
              aria-label="选择模型"
              aria-expanded={open}
              title={pulling ? "正在拉取 /models…" : pool === null ? "拉取 /models 目录" : "展开 /models 目录(输入框文字为过滤词)"}
              disabled={pulling}
              onClick={() => {
                // 0.3.28 ④: always actionable. When the mount auto-pull
                // failed (pool === null) the old toggle was disabled — a
                // dead button that read as "dropdown broken". Now the click
                // itself re-pulls and opens: the dropdown appears when the
                // pool lands, or the error lane (with 重试) explains why it
                // can't. With a pool in hand it's the plain toggle.
                if (pool === null) {
                  setOpen(true);
                  pull();
                  return;
                }
                setOpen((o) => !o);
              }}
            >
              {open ? "收起 ▴" : "选择 ▾"}
            </button>
            {/* spec §2: 「刷新」可重拉 — the auto-pull covers the common open;
                this re-pulls on demand (a catalog added server-side, or a key
                pasted into the panel after open). */}
            <button
              type="button"
              className="ctl mcm-refresh"
              aria-label="刷新模型列表"
              title="重新拉取 /models"
              disabled={pulling}
              onClick={pull}
            >
              {"⟳"}
            </button>
            {open && pool !== null ? (
              <div className="mcm-drop" role="listbox" aria-label="可用模型">
                {visible.map((m) => {
                  const have = configured.has(m.name);
                  return (
                    <button
                      key={m.name}
                      type="button"
                      role="option"
                      aria-selected="false"
                      className="mcm-opt"
                      disabled={have}
                      onClick={() => pick(m)}
                    >
                      <span className="mcm-opt-name">{m.name}</span>
                      {m.contextLength != null ? <span className="mcm-opt-ctx">{m.contextLength}</span> : null}
                      {have ? <span className="mcm-opt-tag">{"已配置"}</span> : null}
                    </button>
                  );
                })}
                {visible.length === 0 ? <div className="mcm-drop-empty">{"无匹配模型"}</div> : null}
              </div>
            ) : null}
          </div>
          <input
            type="text"
            className="wudao-input ctl mcm-ctx"
            aria-label="上下文窗口"
            inputMode="numeric"
            placeholder={fallbackWindow != null ? `留空 = 继承 ${fallbackWindow}` : "留空 = 继承供应商默认"}
            title="上下文窗口(token);留空 = 继承供应商默认窗口"
            value={ctx}
            onChange={(e) => setCtx(e.target.value)}
          />
          <button type="button" className="ctl" disabled={!canAdd} onClick={add}>
            {"添加"}
          </button>
        </div>
        {pulling ? <div className="muted mcm-pulling">{"正在拉取 /models…"}</div> : null}
        {pullError !== null ? (
          <div className="mcm-pull-error test-result fail" data-state={pullError.state}>
            <span>{pullError.message}</span>
            <button type="button" className="ctl" onClick={pull}>
              {"重试"}
            </button>
          </div>
        ) : null}

        <div className="mcm-list-head" title="上下文窗口留空 = 继承供应商默认">{`已配置（${rows.length}）`}</div>
        <div className="mcm-rows">
          {rows.length === 0 ? (
            <div className="muted mcm-empty">{"从上方添加模型(手输或 /models 下拉选择)"}</div>
          ) : (
            rows.map((r, i) => {
              // F7 (0.3.24, carried into round 6): every aria-label carries a
              // name unique to the row — a cleared name falls back to its row
              // number, never two inputs sharing one accessible name.
              const tag = r.name.trim() !== "" ? r.name : `第${i + 1}行`;
              return (
              <div key={i} className="mcm-row">
                <input
                  type="text"
                  className="wudao-input ctl mcm-name"
                  aria-label={`模型名 ${tag}`}
                  value={r.name}
                  onChange={(e) => setRow(i, { name: e.target.value })}
                />
                <input
                  type="text"
                  className="wudao-input ctl mcm-ctx"
                  aria-label={`上下文 ${tag}`}
                  inputMode="numeric"
                  placeholder={fallbackWindow != null ? `继承 ${fallbackWindow}` : "继承供应商默认"}
                  value={r.ctx}
                  onChange={(e) => setRow(i, { ctx: e.target.value })}
                />
                <button
                  type="button"
                  className="ctl mcm-del"
                  aria-label={`删除模型 ${tag}`}
                  title="删除该行"
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                >
                  {"✕"}
                </button>
              </div>
              );
            })
          )}
        </div>

        <div className="btnrow mcm-foot">
          <button type="button" className="ctl" onClick={onClose}>
            {"取消"}
          </button>
          <button type="button" className="ctl wudao primary" disabled={saving} onClick={save}>
            {"保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
