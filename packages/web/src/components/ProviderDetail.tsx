// ProviderDetail — provider-management §6 (T4) → iter3 STRICT master-detail:
// the SELECTED card's COMPLETE configuration surface. The master cards went
// read-only (identity + 应用), so the lanes they used to pin move here — the
// API Key keyrow (input + 保存 + 测试连接, the keyDraft owning the unsaved
// paste that also rides the /models probe) and the quick /model //provider
// switch — alongside what only the registry owns: baseUrl (custom editable /
// builtin read-only), the model rows with per-model contextLength, save
// (overlay payload for builtins, full payload for customs), the custom-only
// delete, and (persona-settings T7) the 「Persona 绑定」three-state row.
//
// round 6 (2026-08-30 spec, 用户第六轮反馈「你的设计应该是行业通用的」): the
// model section is a CONSTANT read list (both render modes — 本节不再有编辑
// 变体) whose ONE edit door is the 「配置模型」 button; ALL model editing
// happens in the ModelConfigModal (manual input + the /models dropdown, the
// industry-standard shape). Rounds 4-5 rearranged IN-PAGE surfaces (chips →
// table → read-table + expand cards); the fix was the interaction FORM, not
// the layout. Deleted with this round: the edit-mode model table (inline
// inputs + per-row 设为默认/✕), the 手工添加模型 section, the inline chips
// picker (pullPool/pullPicked), and the round-5 expand card (openModel) —
// the ☆/使用 actuators moved ONTO the read rows (they write other stores,
// take effect immediately, and never belonged to a draft world). The
// panel's 保存修改 still ECHOES draft.rows (the registry replaces the row
// wholesale) — the rows just never change in-panel anymore; the modal's
// onSaved mirrors its saved rows into the draft through RAW setDraft (the
// R1 rule — a mirror write never flips the clean flag).
//
// 0.3.24 round 4 lineage (still visible in the shape): 模型 sits above 行为
// (the daily surface first); the commit edge is panel-level and surfaces
// 未保存的修改 while the drafts are ahead of the server. Round 5 lineage:
// READ mode is the default render and 「编辑」 is the form's only door;
// 取消编辑 rolls the drafts back to the last server snapshot.
//
// iter5 (trial feedback) adds the CREATE half below (NewProviderDetail): the
// blank lead card ProviderTab mints is completed HERE — the same
// .provider-detail shell and detail-field rows the edit panel wears, so
// adding a provider IS editing a (not-yet-real) provider. iter6 rides the
// create form with the「Persona 绑定」row too — the binding saves in the SAME
// create op, no create-then-edit round-trip.
//
// Remounted per selection (the parent keys it by provider id, so every draft
// resets when the selection moves). A post-save refresh produces a NEW card
// object; the effect below re-seeds the drafts from the server's truth only
// while they are clean — dirty drafts survive the refresh (the F4 guard).
import { useEffect, useState } from "react";
import type { PersonaSummary, ProviderCard, TestConnectionResult, WudaoClient } from "../protocol.js";
// ui-review-r5 I2: the chips ride the SAME lane the StatusBar picker does —
// modelPickCommand picks /model vs /provider per row.
import { isSwitchableModel, modelPickCommand } from "../protocol.js";
import { PERSONA_LAYER_CHOICES, qualifyPersonaSpec, splitPersonaSpec } from "../persona-schema.js";
// round 6: the model rows' editor — RowDraft/modelsPayload moved to the
// modal's module (one direction: this file imports, the modal imports
// nothing from here).
import { ModelConfigModal, modelsPayload, type RowDraft } from "./ModelConfigModal.js";
// round 5: the read-mode key row reuses the master column's badge mapping
// (keySource → 已配/未配 text) — one mapping, both surfaces.
import { DOT_TEXT, KEY_SOURCE_TEXT, keyBadge } from "./ProviderTab.js";// 拆分运动 C：模块级共享段外提至 provider-detail-fields.ts；CREATE 半面外提
// 至 NewProviderDetail.tsx（下方逐名 re-export 保公共面——ProviderTab/测试零演进）。
import {
  EFFORT_FOLLOW_GLOBAL,
  EFFORT_FORCED_NONE,
  EFFORT_LEVELS,
  PERSONA_FOLLOW_GLOBAL,
  PERSONA_FORCED_NONE,
  WIRE_OPTIONS,
  type DetailDraft,
  draftOf,
  errText,
  wireLabel,
} from "./provider-detail-fields.js";
import { Icon } from "./Icon.js";
export { NewProviderDetail } from "./NewProviderDetail.js";

export function ProviderDetail({
  client,
  card,
  models,
  currentProvider,
  currentModel,
  defaultModel,
  notify,
  refresh,
}: {
  client: WudaoClient;
  /** The selected card — never an invalid row (those never become selectable). */
  card: ProviderCard;
  /** The probe model list (cardModels: the driver's /model choices for this
   *  provider + the profile default) — the parent computes it once for the
   *  selected card; testConnection's model pick rides it (round 4: the chip
   *  row it used to feed is gone — the table's 使用 buttons own switching). */
  models: readonly string[];
  /** The L5 live identity (status.model wins over settings.current) — the
   *  model-table 默认 badge rides its hit, same as the card-level badge. */
  currentProvider: string | undefined;
  currentModel: string;
  /** 模型配置反馈 ② (2026-08-29): the configured BOOT default
   *  (settings.defaultModel = the model.defaultModel global tier). The
   *  默认 badge rides it — NOT the live session model (the old badge
   *  mislabeled 当前 as 默认); undefined/null = none written yet. */
  defaultModel?: { readonly provider: string; readonly model: string } | null;
  notify: (text: string) => void;
  refresh: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<DetailDraft>(() => draftOf(card));
  // round 5: READ is the default render — `editing` is the form's gate. The
  // drafts (and every edit-mode machinery below) exist regardless; a clean
  // panel's drafts mirror the card, so entering the form is instant.
  const [editing, setEditing] = useState(false);
  // round 6: the 「配置模型」 modal's mount flag — the model section's ONE
  // edit door (the section itself is constant read rows in both modes).
  const [modelModal, setModelModal] = useState(false);
  // F4 (review-4): whether the drafts still mirror a server snapshot exactly.
  // Any local edit flips this off, and a fresh snapshot then never re-seeds —
  // an unrelated refresh (e.g. a key save on the selected card) must not
  // silently revert unsaved edits. A clean panel keeps tracking the server.
  const [clean, setClean] = useState(true);
  const [pending, setPending] = useState<"save" | "del" | null>(null);
  // iter3: the keyrow moved in from the cards. The draft owns the unsaved
  // paste (it rides BOTH the /models probe and 测试连接 — a pasted key tests
  // the paste, not the stored one); the pending lane is separate from the
  // model-manager's (the old card rows were independent lanes too).
  const [keyDraft, setKeyDraft] = useState("");
  const [keyPending, setKeyPending] = useState<"save" | "test" | null>(null);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  // persona-settings T7 — the binding dropdown's rows (personaList). null =
  // not yet loaded OR the op failed: the selector DEGRADES to its two
  // sentinels, which never need the list (a failure must not break saving).
  const [personas, setPersonas] = useState<readonly PersonaSummary[] | null>(null);
  // Iteration 2 T2 — the layer qualifier select's live value, seeded from the
  // card's binding (a qualified `id:layers` string) and re-seeded with every
  // clean snapshot. It applies ONLY to a bound persona: picked with none
  // bound it just remembers the choice for the next binding pick.
  const [personaLayer, setPersonaLayer] = useState<string>(() =>
    typeof card.persona === "string" ? splitPersonaSpec(card.persona).layer : "",
  );

  // Fetch once per mount (the parent remounts the panel per selection, so
  // this is one personaList per selected card — the lazy-mount economy).
  useEffect(() => {
    let alive = true;
    client
      .personaList()
      .then((r) => {
        if (alive) setPersonas(r.personas);
      })
      .catch(() => {
        /* degraded — the sentinel states still round-trip */
      });
    return () => {
      alive = false;
    };
  }, [client]);

  // A fresh settings snapshot (the post-save refresh) is the server's truth —
  // re-seed the drafts from it, but only while they carry no unsaved edits
  // (F4). The card object identity changes only on a re-fetch. The layer
  // select re-seeds with the binding (a clean panel tracks the server).
  // 0.3.24: `clean` is deliberately NOT a dep — a clean FLIP alone must
  // never re-seed. save()'s success path sets clean=true while the `card`
  // prop is still the PRE-save object (the refresh has not landed yet);
  // reseeding there would visibly revert the just-saved edits until the new
  // snapshot arrives (and forever, if the refresh fails). Only a NEW card
  // object — an actual server snapshot — is a re-seed trigger.
  useEffect(() => {
    if (clean) {
      setDraft(draftOf(card));
      setPersonaLayer(typeof card.persona === "string" ? splitPersonaSpec(card.persona).layer : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the guard reads
    // the CURRENT clean flag per card change; re-running on its flips is
    // exactly the bug this comment exists for.
  }, [card]);

  /** Every draft mutation routes here — it marks the drafts dirty (F4). */
  const editDraft = (f: (d: DetailDraft) => DetailDraft): void => {
    setClean(false);
    setDraft(f);
  };

  /** round 5: 「取消编辑」 — roll every edit-mode surface back to the last
   *  server snapshot (the `card` prop IS that snapshot; the F4 guard kept it
   *  authoritative while the drafts ran ahead) and exit to read mode. The
   *  key paste drops with the form too (a cancel that silently kept a pasted
   *  key would lie about what 保存修改 would commit next time). */
  const cancelEdit = (): void => {
    setDraft(draftOf(card));
    setPersonaLayer(typeof card.persona === "string" ? splitPersonaSpec(card.persona).layer : "");
    setClean(true);
    setKeyDraft("");
    setEditing(false);
  };

  // iter3: the key lanes, moved in from the cards. 0.3.12: the keyrow's own
  // 保存 button is GONE — a pasted key commits through the single 保存修改
  // (save() below fires settingsSaveKey alongside the config); 测试连接 is a
  // probe, not a commit. The receipts and the clear-on-success input are the
  // old card keyrow's exactly.
  const testConnection = (): void => {
    const key = keyDraft.trim();
    const model = models[0];
    // A pasted key tests the UNSAVED paste (the wizard flow); without one the
    // server resolves env → credentials-file for this provider.
    const opts =
      key !== ""
        ? { key, ...(model !== undefined ? { model } : {}) }
        : model !== undefined
          ? { model }
          : undefined;
    setKeyPending("test");
    client
      .settingsTestConnection(card.provider, opts)
      .then((r) => {
        setTestResult(r);
      })
      .catch((e: unknown) => notify(`⚠️ 测试失败：${errText(e)}`)) // ω99-204: #3
      .finally(() => setKeyPending(null));
  };

  /** The chips'/apply switch lane (the same one ProviderTab's 「应用」 rides):
   * submit → receipt on success, ⚠️ on failure. */
  const submitCommand = (line: string, receipt: string): void => {
    client
      .submit(line)
      .then(() => notify(receipt))
      .catch((e: unknown) => notify(`⚠️ ${errText(e)}`));
  };

  /** 模型配置反馈 ② (2026-08-29): the row's 设为默认 — the ModelSelector
   *  footer's exact lane (model.defaultModel → the global settings tier;
   *  `wudao ui` boots into it when no flag/env pins the field). refresh()
   *  re-fetches settings, so the 默认 badge moves onto this row. */
  const setBootDefault = (name: string): void => {
    client
      .settingsSet("model.defaultModel", { provider: card.provider, model: name })
      .then(() => {
        notify(`已设为默认:${card.provider}/${name} —— 下次启动 wudao ui 生效`);
        refresh();
      })
      .catch((e: unknown) => notify(`⚠️ 默认模型保存失败：${errText(e)}`));
  };

  const save = (): void => {
    setPending("save");
    // 0.3.12 single save: a pasted key commits with the SAME click — the
    // keyrow's own 保存 button is gone (two save buttons read as two forms).
    // Key and config are independent stores, so both lanes fire in parallel
    // with their own receipts; a key failure never blocks the config save.
    const key = keyDraft.trim();
    if (key !== "") {
      setKeyPending("save");
      client
        .settingsSaveKey(card.provider, key)
        .then((r) => {
          // The input clears on success: the key lives only in the 0600 file,
          // and nothing in this UI ever reads it back.
          setKeyDraft("");
          notify(`已保存 ${r.provider} 的 Key(凭据文件现有 ${r.keyCount} 个,权限 0600)——下会话可用`);
          refresh();
        })
        .catch((e: unknown) => notify(`⚠️ 保存失败：${errText(e)}`))
        .finally(() => setKeyPending(null));
    }
    const models = modelsPayload(draft.rows);
    const config: Record<string, unknown> = card.custom
      ? // Full registry config — every registry field the wire card carries
        // rides back (F1, review-4: the server's save REPLACES the row
        // wholesale, so an unechoed field is destroyed). defaultModel "" and
        // an absent defaultContextLength mean "nothing stored" — the guards
        // preserve exactly that. reasoningFormat rides the wire card (T4b,
        // the protocol half of F1): the edit form has no format picker, so
        // the card's value echoes verbatim — an absent field stays absent.
        // persona follows the SAME echo rule (T7): the draft seeds from the
        // wire card, so an untouched binding round-trips all three states
        // (absent stays absent — following the global default is a choice,
        // distinct from null).
        {
          ...(draft.label.trim() !== "" ? { label: draft.label.trim() } : {}),
          baseUrl: draft.baseUrl.trim(),
          ...(card.defaultModel !== "" ? { defaultModel: card.defaultModel } : {}),
          ...(card.defaultContextLength != null ? { defaultContextLength: card.defaultContextLength } : {}),
          ...(card.reasoningFormat !== undefined ? { reasoningFormat: card.reasoningFormat } : {}),
          // 0.3.13 (task 215): the protocol column — the draft's value ("" keeps
          // the row wire-less; the dispatch default never enters the file).
          ...(draft.wire !== "" ? { wire: draft.wire } : {}),
          ...(draft.persona !== undefined ? { persona: draft.persona } : {}),
          // S5: the effort binding follows the SAME echo rule — the draft
          // seeds from the wire card, so an untouched binding round-trips
          // all three states (absent stays absent).
          ...(draft.effort !== undefined ? { effort: draft.effort } : {}),
          models,
        }
      : // Builtin → OVERLAY payload: only what this tab changed. The models
        // table IS the overlay's content; an unchanged label never rides.
        // The binding row is the exception that ECHOES (T7): the server
        // replaces the registry row wholesale for builtins too, so a binding
        // save must carry the rest of the overlay — the compiled
        // reasoningFormat rides alongside the chosen persona state, or
        // saving a binding would eat the overlay's other fields. The wire
        // column echoes for the same reason (task 215): the profile's protocol
        // is fixed in the UI, so the card's value round-trips untouched.
        {
          models,
          ...(draft.label.trim() !== "" && draft.label.trim() !== card.label ? { label: draft.label.trim() } : {}),
          // 0.3.28 ②: the baseUrl overlay — a non-empty draft rides as the
          // override; empty omits the field (the no-overlay state = the
          // compiled default back in force). Echo rule intact: the draft
          // seeds from the RAW overlay (registeredBaseUrl), so an untouched
          // overlay round-trips and an untouched no-overlay stays absent.
          ...(draft.baseUrl.trim() !== "" ? { baseUrl: draft.baseUrl.trim() } : {}),
          ...(card.reasoningFormat !== undefined ? { reasoningFormat: card.reasoningFormat } : {}),
          ...(card.wire !== undefined ? { wire: card.wire } : {}),
          ...(draft.persona !== undefined ? { persona: draft.persona } : {}),
          ...(draft.effort !== undefined ? { effort: draft.effort } : {}),
        };
    client
      .settingsSaveProvider(card.provider, config)
      .then((r) => {
        if (r.ok) {
          // 0.3.24 round 4: the server accepted the payload, so the drafts
          // mirror the truth again — the unsaved hint clears and the
          // post-save refresh may re-seed (an edit DURING the refresh wins:
          // editDraft flips clean back off before the effect runs).
          // round 5: a successful save also EXITS the form — back to the
          // read-mode page the panel is by default.
          setClean(true);
          setEditing(false);
          notify(`已保存供应商 ${r.provider} 的注册表配置`);
          refresh();
        } else notify(`⚠️ 保存失败：${r.error}`);
      })
      .catch((e: unknown) => notify(`⚠️ 保存失败：${errText(e)}`))
      .finally(() => setPending(null));
  };

  const del = (): void => {
    setPending("del");
    client
      .settingsDeleteProvider(card.provider)
      .then((r) => {
        if (r.ok) {
          notify(`已删除供应商 ${card.provider}`);
          refresh();
        } else notify(`⚠️ 删除失败：${r.error}`);
      })
      .catch((e: unknown) => notify(`⚠️ 删除失败：${errText(e)}`))
      .finally(() => setPending(null));
  };

  // ② (2026-08-29): TWO distinct marks, honestly labeled. 默认 = the
  // configured BOOT default (settings.defaultModel); 当前 = the live
  // session's model (the L5 live identity — status.model). The old single
  // badge mislabeled the live model as 默认.
  const isLiveModel = (name: string): boolean => card.provider === currentProvider && name === currentModel;
  const isBootDefault = (name: string): boolean =>
    defaultModel != null && defaultModel.provider === card.provider && defaultModel.model === name;
  // ① (2026-08-29): the number an EMPTY ctx input inherits — the provider
  // default when set, else the server's resolved tail (WUDAO_CONTEXT_WINDOW
  // ?? 200000). Absent on old servers → the wordy fallback, never a blank.
  const fallbackWindow = card.defaultContextLength ?? card.windowFallback;
  // 0.3.24 round 4: the chips' successor — every row's 「使用」 button rides
  // the SAME modelPickCommand lane the chips did. Constant per panel (the
  // card's provider vs the live one), not per row.
  const crossProvider = !isSwitchableModel({ provider: card.provider }, currentProvider);

  // The binding draft's ID part (a bound spec `id:layers` → id) — null when
  // not a bound string; the stale-id option below renders off it.
  const boundId = typeof draft.persona === "string" ? splitPersonaSpec(draft.persona).id : null;

  // round 5: the read-mode 行为 rows' texts — derived from the CARD (the
  // server truth), never the drafts. A bound persona shows its display name
  // when the list carries one, else the raw spec (the `:layers` qualifier
  // included — the read row is one fact, not a form).
  const personaReadText =
    card.persona === undefined
      ? "跟随全局"
      : card.persona === null
        ? "强制无"
        : (() => {
            const { id, layer } = splitPersonaSpec(card.persona);
            const full = layer === "" ? id : `${id}:${layer}`;
            const dn = (personas ?? []).find((p) => p.id === id)?.displayName;
            return dn != null ? `${dn} (${full})` : full;
          })();
  const effortReadText =
    card.effort === undefined ? "跟随全局" : card.effort === null ? "强制不发送" : card.effort;

  return (
    <div className="provider-detail">
      {/* 0.3.23 visual pass round 3 (用户反馈「还是很难看,特别凌乱」): the head
          is ONE identity line — dot + name left, the two metas pushed right as
          quiet tags — instead of four inline fragments wrapping raggedly. */}
      <div className="detail-head">
        <div className="detail-head-id">
          <span className={`dot ${card.status}`} title={DOT_TEXT[card.status]} />
          <strong>{card.provider === "wudao" ? "兼容端点(wudao)" : card.label}</strong>
        </div>
        <div className="detail-head-tags">
          <span className="meta mono-id">{card.provider}</span>
          <span className="meta tag">{card.custom ? "自定义" : "内置"}</span>
        </div>
      </div>

      {/* 0.3.23: the four single-field groups (接入/凭据/Persona/推理档 — three
          hairlines for three lone rows) collapse to TWO meaningful sections:
          接入 (everything that reaches the endpoint: name/baseUrl/协议/Key) and
          行为 (the two session-behavior bindings). 0.3.24 round 4 orders them
          接入 → 模型 → 行为 (the model table is the daily surface; the bindings
          are rare config). Field classNames, aria labels, and the save payload
          lanes are untouched. */}
      <div className="detail-group">
        <div className="detail-group-title">{"接入"}</div>
      <div className="detail-field">
        <span className="detail-field-label">{"名称"}</span>
        {editing ? (
          <input
            type="text"
            className="wudao-input ctl detail-label-input"
            aria-label={`${card.label} 显示名称`}
            value={draft.label}
            onChange={(e) => editDraft((d) => ({ ...d, label: e.target.value }))}
          />
        ) : (
          <span className="detail-read-text">{card.label}</span>
        )}
      </div>
      <div className="detail-field">
        <span className="detail-field-label">{"baseUrl"}</span>
        {editing ? (
          <input
            type="text"
            className="wudao-input ctl detail-baseurl"
            aria-label={`${card.label} Base URL`}
            // 0.3.28 ②: builtins edit the OVERLAY — empty = the compiled
            // default stays in force (the payload then omits baseUrl, the
            // no-overlay state). The placeholder says so; customs carry no
            // hint (their base is required, enforced at save).
            placeholder={card.custom ? undefined : "留空 = 使用编译内置端点;填入则覆盖"}
            value={draft.baseUrl}
            onChange={(e) => editDraft((d) => ({ ...d, baseUrl: e.target.value }))}
          />
        ) : (
          // 只读展示:the EFFECTIVE base (the card's `endpoint` is the
          // resolved URL with env overrides — never shown here). An
          // overlaid builtin shows its override here; read mode shows a
          // custom base as text too — the URL is a fact to check,
          // not a box to fill (round 5: 读态零输入框).
          <span className="card-endpoint">{card.baseUrl ?? "(使用编译内置端点)"}</span>
        )}
      </div>
      {/* 0.3.13 (task 215): the protocol row — customs pick the wire (the
          registry `wire` column; "" keeps the row wire-less, openai-chat
          at dispatch), builtins show the profile's FIXED protocol (the
          compiled-in pin owns it — anthropic speaks anthropic, the rest
          speak openai-chat). */}
      <div className="detail-field">
        <span className="detail-field-label">{"协议"}</span>
        {editing && card.custom ? (
          <select
            className="ctl detail-wire"
            aria-label={`${card.label} 协议`}
            title="选 Anthropic 协议后,该供应商走 /v1/messages 适配器(无需再设 WUDAO_WIRE)"
            value={draft.wire}
            onChange={(e) => editDraft((d) => ({ ...d, wire: e.target.value }))}
          >
            {WIRE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="card-endpoint detail-wire-fixed">{wireLabel(card.wire)}</span>
        )}
      </div>
      {/* iter3: the keyrow, moved in from the cards — the ONLY place a key
          is typed. The paste stays local to this panel (it remounts per
          selection, so switching cards never carries a paste across).
          Round 5: read mode shows the keySource STATUS (the master column's
          badge mapping) — the paste box only exists inside the form. The
          probe stays in BOTH modes: 测试连接 without a paste tests the key
          the server already holds, which is exactly what a read-mode visitor
          wants to verify. */}
      <div className="detail-field key-field">
        <span className="detail-field-label">{"API Key"}</span>
        {editing ? (
          <div className="keyrow">
            <input
              type="password"
              className="wudao-input key-input ctl"
              placeholder="粘贴 API Key — 随「保存修改」写入本机凭据文件(0600)"
              aria-label={`${card.label} API Key`}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
            <button
              type="button"
              className="ctl"
              disabled={keyPending !== null}
              onClick={testConnection}
            >
              测试连接
            </button>
          </div>
        ) : (
          <div className="keyrow">
            <span className={`key-badge ${keyBadge(card).cls}`} title={KEY_SOURCE_TEXT[card.keySource ?? "none"]}>
              {keyBadge(card).text}
            </span>
            <button
              type="button"
              className="ctl"
              disabled={keyPending !== null}
              onClick={testConnection}
            >
              测试连接
            </button>
          </div>
        )}
      </div>
      {testResult !== null ? (
        <div
          className={`test-result ${testResult.ok ? "ok" : `fail ${testResult.state}`}`}
          data-state={testResult.state}
        >
          {testResult.message}
        </div>
      ) : null}
      </div>
      <div className="model-manager">
        <div className="model-manager-head">
          {"模型"}
          {/* round 6: the section's ONE edit door — ALL model editing happens
              in the modal (manual input + the /models dropdown, the
              industry-standard shape the user dictated). The head's old
              留空 = 继承 hint moved INTO the modal's 上下文 placeholder — the
              only place a window is typed now. */}
          <button type="button" className="wudao primary model-config" onClick={() => setModelModal(true)}>
            {"配置模型"}
          </button>
        </div>
        {/* round 6: the CONSTANT row list — identical in read and edit modes
            (本节不再有编辑变体; the edit-mode table, the 手工添加模型 section,
            the inline chips picker, and the round-5 expand card are all
            gone). The rows render from draft.rows: a clean panel's draft
            mirrors the card exactly, and the modal's onSaved mirror-write
            keeps them fresh after a modal save even before the refresh
            lands. ☆/★/使用 sit ON the row — they write other stores
            (model.defaultModel / the session switch), take effect
            immediately, and never belonged to a draft world. */}
        {draft.rows.map((row, i) => {
          const live = isLiveModel(row.name);
          return (
            <div key={i} className={`model-row model-read-row${live ? " live" : ""}`}>
              <span className="model-row-name">{row.name}</span>
              <span className="model-row-ctx">
                {row.ctx.trim() !== ""
                  ? row.ctx.trim()
                  : fallbackWindow != null
                    ? `继承 ${fallbackWindow}`
                    : "继承供应商默认"}
              </span>
              <span className="model-row-state">
                {isBootDefault(row.name) ? (
                  <button
                    type="button"
                    className="ctl model-star"
                    disabled
                    aria-label={`已是默认模型 ${row.name}`}
                    title="启动默认模型(model.defaultModel)——下次启动 wudao ui 生效"
                  >
                    {/* 116 弧 C：★/☆ 字符 → star 细线字形；已选态 filled 实心
                        （currentColor 填充，色随 .model-star 既有令牌链）。 */}
                    <Icon name="star" size={13} filled />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ctl model-star"
                    aria-label={`设为默认模型 ${row.name}`}
                    title="设为 wudao ui 的启动默认模型(model.defaultModel)——下次启动生效"
                    disabled={row.name.trim() === ""}
                    onClick={() => setBootDefault(row.name.trim())}
                  >
                    <Icon name="star" size={13} />
                  </button>
                )}
                {live ? (
                  <span className="model-badge live" title="当前会话正在使用的模型">
                    {"当前"}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="ctl model-use"
                  aria-label={`切换到 ${row.name}`}
                  title={crossProvider ? `submit /provider ${card.provider} (switches the endpoint)` : `submit /model ${row.name}`}
                  disabled={!crossProvider && row.name === currentModel}
                  onClick={() => {
                    const line = modelPickCommand({ provider: card.provider, model: row.name }, currentProvider);
                    submitCommand(
                      line,
                      // ω99-195: #10（仅 model 行前缀；provider 行零触）
                      crossProvider
                        // ω99-199: #5
                        ? `供应商 → ${card.provider} — 下一轮起切换端点,历史将全部重新处理(缓存全冷)` // ω99-310: 称谓随设置面统一
                        : `模型 → ${row.name} — 下一轮生效`,
                    );
                  }}
                >
                  {"使用"}
                </button>
              </span>
            </div>
          );
        })}
        {draft.rows.length === 0 ? <div className="model-empty muted">{"尚未配置模型 —— 点击「配置模型」添加"}</div> : null}
      </div>
      {/* 0.3.24 round 4: 行为 moves BELOW the model manager — the model table
          is the surface a visit actually comes for (models first, the two
          session-behavior bindings after), and the commit edge closes the
          panel at its own level (it saves EVERY section, so it no longer
          lives inside the model block). */}
      <div className="detail-group">
        <div className="detail-group-title">{"行为"}</div>
      <div className="detail-field pair">
        <span className="detail-field-label">{"Persona 绑定"}</span>
        {/* Round 5: the read row is the resolved TEXT (跟随全局 / 绑定 /
            强制无) — the two selectors only exist inside the form. */}
        {!editing ? <span className="detail-read-text">{personaReadText}</span> : (
        <>
        {/* The three states in ONE value space (sentinels above). A bound id
            the list does not carry (a stale binding, or the list not yet
            loaded) still gets its own option — the CURRENT state must be
            visible and round-trip, never silently blank. A bound string's
            `:layers` qualifier never shows HERE (the layer select owns it);
            the binding select's value is the spec's id part. */}
        <select
          className="ctl detail-persona"
          aria-label="Persona 绑定"
          title="跟随全局 = 用全局默认 persona;强制无 = 显式不挂 persona;其余 = 绑定该 persona"
          value={
            draft.persona === undefined
              ? PERSONA_FOLLOW_GLOBAL
              : draft.persona === null
                ? PERSONA_FORCED_NONE
                : splitPersonaSpec(draft.persona).id
          }
          onChange={(e) => {
            const v = e.target.value;
            editDraft((d) => ({
              ...d,
              persona:
                v === PERSONA_FOLLOW_GLOBAL ? undefined : v === PERSONA_FORCED_NONE ? null : qualifyPersonaSpec(v, personaLayer),
            }));
          }}
        >
          <option value={PERSONA_FOLLOW_GLOBAL}>{"跟随全局"}</option>
          {(personas ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName != null ? `${p.displayName} (${p.id})` : p.id}
            </option>
          ))}
          {boundId !== null && !(personas ?? []).some((p) => p.id === boundId) ? (
            <option value={boundId}>{`${boundId}（未注册）`}</option>
          ) : null}
          <option value={PERSONA_FORCED_NONE}>{"强制无"}</option>
        </select>
        {/* The layer qualifier — composed onto the bound persona as the
            `id:layers` spec (全部层 = the plain id). It applies ONLY to a
            bound persona: with 跟随全局/强制无 (or nothing yet bound) it just
            remembers the choice for the next binding pick, never minting a
            persona key on its own. */}
        <select
          className="ctl detail-persona-layer"
          aria-label="Persona 层"
          title="限定绑定的 persona 只作用于选中的层(全部层 = 完整指纹)"
          value={personaLayer}
          onChange={(e) => {
            const v = e.target.value;
            setPersonaLayer(v);
            editDraft((d) => ({
              ...d,
              persona: typeof d.persona === "string" ? qualifyPersonaSpec(splitPersonaSpec(d.persona).id, v) : d.persona,
            }));
          }}
        >
          {PERSONA_LAYER_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        </>
        )}
      </div>

      {/* 推理档三级配置 S5: the「推理档绑定」row — the persona binding's exact
          twin over the registry's `effort` column. 跟随全局 = the global
          model.defaultEffort applies; a level = bound (none included — it is
          a wire value); 强制不发送 = explicit null (the global never
          applies). The select maps to/from the draft's three states via the
          sentinels below. */}
      <div className="detail-field">
        <span className="detail-field-label">{"推理档绑定"}</span>
        {!editing ? <span className="detail-read-text">{effortReadText}</span> : (
        <select
          className="ctl detail-effort"
          aria-label="推理档绑定"
          title="跟随全局 = 用全局默认推理档;强制不发送 = 该供应商不发送 reasoning_effort;其余 = 绑定该档位"
          value={draft.effort === undefined ? EFFORT_FOLLOW_GLOBAL : draft.effort === null ? EFFORT_FORCED_NONE : draft.effort}
          onChange={(e) => {
            const v = e.target.value;
            editDraft((d) => ({
              ...d,
              effort: v === EFFORT_FOLLOW_GLOBAL ? undefined : v === EFFORT_FORCED_NONE ? null : v,
            }));
          }}
        >
          <option value={EFFORT_FOLLOW_GLOBAL}>{"跟随全局"}</option>
          {EFFORT_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
          <option value={EFFORT_FORCED_NONE}>{"强制不发送"}</option>
        </select>
        )}
      </div>
      </div>
      {/* 0.3.24 round 4: the commit edge tells the truth about the draft —
          未保存的修改 shows while the drafts are ahead of the server (any
          editDraft), and a successful config save clears it (the server
          accepted the payload; the post-save refresh can re-seed).
          Round 5: the footer is MODE-SWAPPED — read mode offers exactly one
          actuator (「编辑」, the form's only door); the form offers the commit
          edge, the rollback escape (「取消编辑」), and the custom-only delete. */}
      <div className="detail-actions">
        {!editing ? (
          <button type="button" className="ctl detail-edit" onClick={() => setEditing(true)}>
            {"编辑"}
          </button>
        ) : (
          <>
            {!clean ? <span className="detail-unsaved">{"未保存的修改"}</span> : null}
            <button type="button" className="ctl detail-save" disabled={pending !== null} onClick={save}>
              {"保存修改"}
            </button>
            <button type="button" className="ctl detail-cancel" onClick={cancelEdit}>
              {"取消编辑"}
            </button>
            {card.custom ? (
              <button type="button" className="ctl detail-del" disabled={pending !== null} onClick={del}>
                {"删除供应商"}
              </button>
            ) : null}
          </>
        )}
      </div>
      {modelModal ? (
        /* R1 wiring: onSaved mirrors the modal's saved rows into the panel
           draft through RAW setDraft — never editDraft (that lane flips the
           clean flag and would false-alarm 未保存的修改 on a clean panel). A
           dirty panel keeps its own field drafts and gains the new rows; its
           later 保存修改 carries both. */
        <ModelConfigModal
          client={client}
          card={card}
          keyDraft={keyDraft}
          fallbackWindow={fallbackWindow}
          notify={notify}
          refresh={refresh}
          onClose={() => setModelModal(false)}
          onSaved={(rows) => setDraft((d) => ({ ...d, rows }))}
        />
      ) : null}
    </div>
  );
}

// --- iter5 (2026-08-24 trial feedback): 添加供应商 as a blank lead card ------
// The create half of the add flow. ProviderTab mints a client-side draft card
// at the head of the master list (no op fires); THIS panel — rendered in the
// detail column while the draft leads — is the completion form. The op lane
// is the old inline form's createProvider VERBATIM (payload shape, receipts,
// disabled guard); only the shell moved. The add-* classNames survive so the
// flow reads as one surface with the (former) inline form.

