// 拆分运动 C：从 ProviderDetail.tsx 原样外提的 CREATE 半面（iter5/iter6 的
// 新增供应商表单——AddDraft、persona 绑定行、createProvider 落账）。
import { useEffect, useState } from "react";
import type { PersonaSummary, WudaoClient } from "../protocol.js";
import { PERSONA_LAYER_CHOICES, qualifyPersonaSpec, splitPersonaSpec } from "../persona-schema.js";
import {
  PERSONA_FORCED_NONE,
  PERSONA_FOLLOW_GLOBAL,
  REASONING_FORMATS,
  WIRE_OPTIONS,
  errText,
} from "./provider-detail-fields.js";

interface AddDraft {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly reasoningFormat: string;
  /** 0.3.13 (task 215): the protocol — "" keeps the created row wire-less
   *  (openai-chat at dispatch), "anthropic" speaks /v1/messages. */
  readonly wire: string;
}

const EMPTY_ADD: AddDraft = { id: "", label: "", baseUrl: "", reasoningFormat: "none", wire: "" };

export function NewProviderDetail({
  client,
  notify,
  refresh,
  onCreated,
  onCancel,
}: {
  client: WudaoClient;
  notify: (text: string) => void;
  refresh: () => void;
  /** The ok-reply's state lane: select the new id + drop the draft card (the
   *  parent owns both — this panel never touches the master list). */
  onCreated: (id: string) => void;
  /** 取消 — the draft costs nothing, so it drops without confirmation. */
  onCancel: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<AddDraft>(EMPTY_ADD);
  const [pending, setPending] = useState(false);
  // iter6 — the binding row's local state, mirroring the edit panel's shape
  // without its server-reseed machinery (a draft has no wire card to track):
  // personaDraft IS the registry's three states verbatim (undefined = follow
  // the global default → the key stays OFF the create payload, a string = a
  // bound `id[:layers]` spec, null = forced none), personas/layer come from
  // the same mount-time personaList the edit row fetches.
  const [personaDraft, setPersonaDraft] = useState<string | null | undefined>(undefined);
  const [personas, setPersonas] = useState<readonly PersonaSummary[] | null>(null);
  const [personaLayer, setPersonaLayer] = useState("");

  // Fetch once per mount — the edit row's fetch exactly (null = not yet
  // loaded OR failed: the selector degrades to its two sentinels, which never
  // need the list).
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

  /** §6: the create lane — settingsSaveProvider → select the new id → notify
   *  receipt → refresh (the refreshed matrix then carries the new card,
   *  already selected). Moved verbatim from the old inline form (iter5); the
   *  op call and receipts are byte-identical. */
  const createProvider = (): void => {
    const id = draft.id.trim();
    const baseUrl = draft.baseUrl.trim();
    if (id === "" || baseUrl === "") return; // the 创建 button stays disabled until both ride
    setPending(true);
    client
      .settingsSaveProvider(id, {
        ...(draft.label.trim() !== "" ? { label: draft.label.trim() } : {}),
        baseUrl,
        reasoningFormat: draft.reasoningFormat,
        // 0.3.13 (task 215): the protocol column rides the create op — "" keeps
        // the row wire-less (openai-chat at dispatch, never in the file).
        ...(draft.wire !== "" ? { wire: draft.wire } : {}),
        // iter6: the binding rides the SAME create op — the three states
        // exactly as the edit save echoes them (absent = follow-global IS a
        // choice, never a forced null).
        ...(personaDraft !== undefined ? { persona: personaDraft } : {}),
        models: [],
      })
      .then((r) => {
        if (r.ok) {
          onCreated(id);
          notify(`已添加供应商 ${r.provider} —— 保存 Key 后即可使用`);
          refresh();
        } else notify(`⚠️ 添加失败：${r.error}`);
      })
      .catch((e: unknown) => notify(`⚠️ 添加失败：${errText(e)}`))
      .finally(() => setPending(false));
  };

  return (
    <div className="provider-detail new-provider-detail">
      <div className="detail-head">
        <span className="dot draft" title="未保存" />
        <strong>{"新增供应商"}</strong>
        <span className="meta">{"未保存"}</span>
      </div>
      {/* 0.3.13 task 216: the create form joins the grouped-section language —
          基本信息 / 协议与格式 / Persona — same classNames and lanes. */}
      <div className="detail-group">
        <div className="detail-group-title">{"基本信息"}</div>
      <div className="detail-field">
        <span className="detail-field-label">{"id"}</span>
        <input
          type="text"
          className="wudao-input ctl add-id"
          aria-label="新供应商 id"
          placeholder="id(字母开头,如 my-gateway)"
          value={draft.id}
          onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
        />
      </div>
      <div className="detail-field">
        <span className="detail-field-label">{"显示名称"}</span>
        <input
          type="text"
          className="wudao-input ctl add-label"
          aria-label="显示名称"
          placeholder="显示名称(可空 = id)"
          value={draft.label}
          onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
        />
      </div>
      <div className="detail-field">
        <span className="detail-field-label">{"Base URL"}</span>
        <input
          type="text"
          className="wudao-input ctl add-baseurl"
          aria-label="Base URL"
          placeholder="https://…(必填)"
          value={draft.baseUrl}
          onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
        />
      </div>
      </div>
      <div className="detail-group">
        <div className="detail-group-title">{"协议与格式"}</div>
      <div className="detail-field">
        <span className="detail-field-label">{"推理格式"}</span>
        <select
          className="ctl add-format"
          aria-label="推理格式"
          value={draft.reasoningFormat}
          onChange={(e) => setDraft((d) => ({ ...d, reasoningFormat: e.target.value }))}
        >
          {REASONING_FORMATS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      {/* 0.3.13 (task 215): the create form's protocol row — the edit panel's
          selector options exactly ("" = wire-less, the openai default). */}
      <div className="detail-field">
        <span className="detail-field-label">{"协议"}</span>
        <select
          className="ctl add-wire"
          aria-label="协议"
          value={draft.wire}
          onChange={(e) => setDraft((d) => ({ ...d, wire: e.target.value }))}
        >
          {WIRE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      </div>
      <div className="detail-group">
        <div className="detail-group-title">{"Persona"}</div>
      {/* iter6 — the edit panel's binding row, replicated (NOT extracted): the
          edit row is welded to its editDraft/clean reseed machinery, and a
          create draft needs none of it — it starts at 跟随全局 and never
          carries a stale-id option (nothing on the wire can be stale yet).
          The option set, sentinel values, and layer semantics are the edit
          row's exactly. */}
      <div className="detail-field pair">
        <span className="detail-field-label">{"Persona 绑定"}</span>
        <select
          className="ctl detail-persona"
          aria-label="Persona 绑定"
          title="跟随全局 = 用全局默认 persona;强制无 = 显式不挂 persona;其余 = 绑定该 persona"
          value={
            personaDraft === undefined
              ? PERSONA_FOLLOW_GLOBAL
              : personaDraft === null
                ? PERSONA_FORCED_NONE
                : splitPersonaSpec(personaDraft).id
          }
          onChange={(e) => {
            const v = e.target.value;
            setPersonaDraft(
              v === PERSONA_FOLLOW_GLOBAL ? undefined : v === PERSONA_FORCED_NONE ? null : qualifyPersonaSpec(v, personaLayer),
            );
          }}
        >
          <option value={PERSONA_FOLLOW_GLOBAL}>{"跟随全局"}</option>
          {(personas ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName != null ? `${p.displayName} (${p.id})` : p.id}
            </option>
          ))}
          <option value={PERSONA_FORCED_NONE}>{"强制无"}</option>
        </select>
        {/* The layer qualifier — the edit row's rule exactly: it composes onto
            a bound persona as the `id:layers` spec (全部层 = the plain id) and
            applies ONLY to one — with nothing bound it just remembers the
            choice for the next binding pick, never minting a persona key. */}
        <select
          className="ctl detail-persona-layer"
          aria-label="Persona 层"
          title="限定绑定的 persona 只作用于选中的层(全部层 = 完整指纹)"
          value={personaLayer}
          onChange={(e) => {
            const v = e.target.value;
            setPersonaLayer(v);
            setPersonaDraft((d) => (typeof d === "string" ? qualifyPersonaSpec(splitPersonaSpec(d).id, v) : d));
          }}
        >
          {PERSONA_LAYER_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      </div>
      {/* The guard is the old form's exactly: id AND baseUrl trimmed-non-empty,
          and never while the create op is in flight. An id collision rides the
          server's rejection (⚠️ 添加失败) — the front end adds no dup check. */}
      <div className="detail-actions">
        <button
          type="button"
          className="ctl"
          disabled={draft.id.trim() === "" || draft.baseUrl.trim() === "" || pending}
          onClick={createProvider}
        >
          {"创建"}
        </button>
        <button type="button" className="ctl" onClick={onCancel}>
          {"取消"}
        </button>
      </div>
    </div>
  );
}
