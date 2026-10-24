// PersonaPanel — the settings page's Persona tab (persona-settings T6): the
// global-default picker (settingsSet persona.id — "" clears), the master
// list (personaList rows with 内置/全局/工作区 source badges + layers), and
// the detail form. Builtin and workspace personas render READ-ONLY in the
// same layout (disabled controls, no save/delete); global personas open the
// structured editor — id (create-only, kebab), displayName, prompt system
// prefix textarea, and the per-wire (openai-chat / anthropic / responses)
// headers + body rows sharing ONE wire tab strip. The client-side mirrors
// in persona-schema.ts give IMMEDIATE feedback (forbidden-key red text,
// per-wire body dropdown, JSON value hints); the server's
// validatePersonaDefinition stays the gate — a refused save's field-path
// errors (`headers.anthropic.user-agent: …`) map back onto the matching
// rows. Delete rides the two-step protocol: the first personaDelete reports
// the reference inventory (bound providers + the global-default flag), the
// confirm card's 「解绑并删除」 re-sends with unbind:true.
// Iteration 2 T2: a loaded definition OPENS on the first wire with content
// (`initialWireFor` — claude-code's anthropic-only headers must not land on
// an empty openai-chat page), each wire tab carries a row-count badge (zero
// dims), and the global-default picker pairs with a layer-qualifier select
// writing the `<id>[:layers]` spec through settingsSet persona.id.
// Iteration 2 T3 (visual pass, ZERO behavior): the tab now speaks the
// settings page's own visual language — the master rows ride the provider
// card idioms (two-line hierarchy + hover/aria-current accent edge), the
// wire strip rides the tab-row language (mono chips, inset accent bar), the
// selects get managed widths, and the classes carry the look from
// styles.css's persona section (persona-row / persona-wire-tabs /
// persona-form / persona-delete-confirm).
import { useEffect, useRef, useState } from "react";
import type {
  PersonaDefinition,
  PersonaProtocolId,
  PersonaSummary,
  SettingsStatus,
  WudaoClient,
} from "../protocol.js";
import {
  BODY_WHITELIST,
  PERSONA_ID_RE,
  PERSONA_LAYER_CHOICES,
  PERSONA_PROTOCOL_IDS,
  TEMPLATE_SLOTS,
  isForbiddenHeaderKey,
  qualifyPersonaSpec,
  splitPersonaSpec,
  unknownTemplateSlots,
} from "../persona-schema.js";
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "./ime-guard.js";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const WIRES = PERSONA_PROTOCOL_IDS;

const SOURCE_BADGE: Readonly<Record<PersonaSummary["source"], string>> = {
  builtin: "内置",
  global: "全局",
  workspace: "工作区",
};

// ---------------------------------------------------------------------------
// Editor view-model + the pure build/validate helpers (shared with the test
// suite — the save gate and savePayload() assert through them).
// ---------------------------------------------------------------------------

export interface HeaderRowState {
  readonly key: string;
  readonly value: string;
}

export interface BodyRowState {
  readonly key: string;
  /** The RAW text the user typed — parsed as JSON on build. */
  readonly value: string;
}

export interface PersonaEditorState {
  readonly id: string;
  readonly displayName: string;
  readonly promptText: string;
  readonly headers: Readonly<Record<PersonaProtocolId, readonly HeaderRowState[]>>;
  readonly body: Readonly<Record<PersonaProtocolId, readonly BodyRowState[]>>;
}

function wireRecord<T>(make: () => T): Record<PersonaProtocolId, T> {
  return { "openai-chat": make(), anthropic: make(), responses: make() };
}

const emptyHeaderRow = (): HeaderRowState => ({ key: "", value: "" });
const emptyBodyRow = (): BodyRowState => ({ key: "", value: "" });

/** The create form's blank state: ONE empty header row + ONE empty body row
 *  per wire (empty rows drop out of the built definition — an untouched
 *  form is a valid, layer-less persona). */
export function blankEditor(): PersonaEditorState {
  return {
    id: "",
    displayName: "",
    promptText: "",
    headers: wireRecord(() => [emptyHeaderRow()]),
    body: wireRecord(() => [emptyBodyRow()]),
  };
}

/** Prime the editor from a fetched definition (an editable global persona).
 *  Body values round-trip through JSON.stringify — the input is JSON text. */
export function editorFromDefinition(d: PersonaDefinition): PersonaEditorState {
  const headers = wireRecord<readonly HeaderRowState[]>(() => []);
  const body = wireRecord<readonly BodyRowState[]>(() => []);
  for (const w of WIRES) {
    const h = d.headers[w];
    if (h !== undefined) headers[w] = Object.entries(h).map(([key, value]) => ({ key, value }));
    if (headers[w].length === 0) headers[w] = [emptyHeaderRow()];
    const b = d.body?.[w];
    if (b !== undefined) body[w] = Object.entries(b).map(([key, v]) => ({ key, value: JSON.stringify(v) ?? "" }));
    if (body[w].length === 0) body[w] = [emptyBodyRow()];
  }
  return { id: d.id, displayName: d.displayName, promptText: d.prompt?.system?.text ?? "", headers, body };
}

/** The detail view's OPENING wire (iteration 2 T2): the FIRST wire carrying
 *  content (headers OR body rows) — the claude-code shape (headers ONLY on
 *  anthropic) must not open on an empty openai-chat page (the「header 是空
 *  的」bug). An all-empty persona keeps the first wire. */
export function initialWireFor(def: PersonaDefinition): PersonaProtocolId {
  for (const w of WIRES) {
    if (Object.keys(def.headers[w] ?? {}).length > 0) return w;
    if (Object.keys(def.body?.[w] ?? {}).length > 0) return w;
  }
  return WIRES[0] ?? "openai-chat";
}

function isValidJson(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** The client-side gate — field-path strings in the SAME shape the server's
 *  errors use, so one matcher renders both onto the rows. A persona the
 *  server would refuse (forbidden header key, unknown template slot, bad
 *  body JSON, missing id/displayName) never leaves the browser. */
export function personaClientIssues(editor: PersonaEditorState, creating: boolean): readonly string[] {
  const issues: string[] = [];
  const id = editor.id.trim();
  if (creating && (id === "" || !PERSONA_ID_RE.test(id))) issues.push("id: kebab-case required (/^[a-z0-9]+(-[a-z0-9]+)*$/)");
  if (editor.displayName.trim() === "") issues.push("displayName: 不能为空");
  for (const w of WIRES) {
    for (const row of editor.headers[w]) {
      if (row.key.trim() === "" && row.value !== "") issues.push(`headers.${w}: 键不能为空`);
      else if (row.key.trim() !== "") {
        if (isForbiddenHeaderKey(row.key)) {
          issues.push(`headers.${w}.${row.key.trim()}: "${row.key.trim().toLowerCase()}" 是禁用键(鉴权/传输控制头由适配器持有,persona 不可控)`);
        }
        for (const slot of unknownTemplateSlots(row.value)) {
          issues.push(`headers.${w}.${row.key.trim()}: unknown template slot ${slot} (allowed: ${TEMPLATE_SLOTS.join("|")})`);
        }
      }
    }
    for (const row of editor.body[w]) {
      if (row.key !== "" && !isValidJson(row.value)) issues.push(`body.${w}.${row.key}: 值必须是合法 JSON(如 0.7、"text"、false)`);
    }
  }
  return issues;
}

/** Build the personaSave payload — null iff the client gate trips (the save
 *  handler then never sends the op; the rows already show why). */
export function buildPersonaDefinition(editor: PersonaEditorState, creating: boolean): PersonaDefinition | null {
  if (personaClientIssues(editor, creating).length > 0) return null;
  const headers: Partial<Record<PersonaProtocolId, Record<string, string>>> = {};
  const body: Partial<Record<PersonaProtocolId, Record<string, unknown>>> = {};
  for (const w of WIRES) {
    const hRows = editor.headers[w].filter((r) => r.key.trim() !== "");
    if (hRows.length > 0) {
      headers[w] = Object.fromEntries(hRows.map((r) => [r.key.trim(), r.value]));
    }
    const bRows = editor.body[w].filter((r) => r.key !== "" && r.value.trim() !== "");
    if (bRows.length > 0) {
      body[w] = Object.fromEntries(bRows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
    }
  }
  const promptText = editor.promptText;
  return {
    id: editor.id.trim(),
    displayName: editor.displayName.trim(),
    // A user-defined persona's source row — the schema requires all three
    // fields; the settings tab never edits them.
    source: { kind: "workspace-source", provenance: "user-defined (wudao settings persona tab)", pinnedVersion: "1" },
    headers: headers as PersonaDefinition["headers"],
    ...(Object.keys(body).length > 0 ? { body: body as NonNullable<PersonaDefinition["body"]> } : {}),
    ...(promptText.trim() !== "" ? { prompt: { system: { mode: "prefix", text: promptText } } } : {}),
  };
}

// --- final-review F2 — the editor's SHAPE GATE -----------------------------------
// The builder above emits EXACTLY: id/displayName, the fixed editor source
// row, per-wire headers/body maps, and a prefix-mode prompt. The server
// writes the client's definition VERBATIM (savePersonaDefinition →
// JSON.stringify of the validated persona), so opening the editor on a
// hand-authored global persona carrying ANY other schema field and saving
// silently destroyed those fields. The gate below asks the precise question:
// can the builder reproduce this definition field-for-field? If not, the
// persona opens VIEW-ONLY (see selectPersona + the read-only hint).

/** The source row every editor save writes (buildPersonaDefinition's fixed
 *  triple) — a persona whose source differs is hand-authored, and a save
 *  would overwrite its provenance. */
const EDITOR_SOURCE: Readonly<PersonaDefinition["source"]> = Object.freeze({
  kind: "workspace-source",
  provenance: "user-defined (wudao settings persona tab)",
  pinnedVersion: "1",
});

/** Structural equality over JSON-shaped values: key sets AND leaves must
 *  match. Object.is at the leaves, so exactly the values JSON.stringify
 *  silently corrupts (NaN → null, -0 → 0, dropped undefined) compare
 *  unequal — which is the point. */
function jsonEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEquals(v, b[i] ?? null));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  const rb = b as Record<string, unknown>;
  const ra = a as Record<string, unknown>;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && jsonEquals(ra[k], rb[k]));
}

/** final-review F2 — is this definition fully round-trippable through the
 *  editor (buildPersonaDefinition reproduces it field-for-field)? An
 *  allow-list over the builder's own output shape: any unmapped schema
 *  field (snapshot-mode prompt, prompt.toolNameMap, defaultLayers,
 *  confidence, a foreign source row, an unknown FUTURE field), any per-wire
 *  empty map the builder drops, and any body value JSON cannot reparse
 *  structurally-equal all trip it. */
export function isPersonaDefinitionRoundTrippable(d: PersonaDefinition): boolean {
  const TOP_KEYS = new Set(["id", "displayName", "source", "headers", "body", "prompt"]);
  if (!Object.keys(d).every((k) => TOP_KEYS.has(k))) return false;
  if (!jsonEquals(d.source, EDITOR_SOURCE)) return false;
  if (d.id !== d.id.trim() || d.displayName !== d.displayName.trim()) return false; // the builder trims both
  for (const w of WIRES) {
    const h = d.headers[w];
    if (h !== undefined) {
      if (Object.keys(h).length === 0) return false; // the builder omits the wire key entirely
      for (const [k, v] of Object.entries(h)) {
        if (k.trim() !== k || typeof v !== "string") return false; // keys get trimmed on build
      }
    }
    const b = d.body?.[w];
    if (b !== undefined) {
      if (Object.keys(b).length === 0) return false;
      for (const [k, v] of Object.entries(b)) {
        // Deliberate fail-closed: unlike headers (trimmed on build, above),
        // the builder emits body keys RAW — an untrimmed body key WOULD
        // round-trip. Denying it anyway is intentional overreach in the safe
        // direction (the form's dropdown keys never carry whitespace).
        if (k.trim() !== k) return false;
        // Body values ride JSON text in the form — a value that cannot
        // survive stringify→parse structurally-equal would be corrupted.
        try {
          if (!jsonEquals(JSON.parse(JSON.stringify(v)), v)) return false;
        } catch {
          return false; // JSON.stringify gave undefined (function/undefined) — unrepresentable
        }
      }
    }
  }
  if (d.prompt !== undefined) {
    const pKeys = Object.keys(d.prompt);
    if (pKeys.length !== 1 || pKeys[0] !== "system") return false; // toolNameMap (or anything else) is unmapped
    const s = d.prompt.system;
    if (s === undefined) return false; // a prompt key with no system object cannot be re-emitted
    const sKeys = Object.keys(s);
    if (sKeys.length !== 2 || !sKeys.includes("mode") || !sKeys.includes("text")) return false;
    if (s.mode !== "prefix") return false; // snapshot prompts are unmapped
    // R1: whitespace-only text types as a string, but the builder DROPS the
    // prompt key when trim() === "" — a save would silently lose the prompt
    // object, so the gate must trip.
    if (typeof s.text !== "string" || s.text.trim() === "") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function PersonaPanel({
  client,
  settings,
  notify,
  refresh,
}: {
  client: WudaoClient;
  /** The page-level settingsStatus (the picker's current persona.id rides
   *  settings.personaId — this tab never fetches settings itself). */
  settings: SettingsStatus | null;
  notify: (text: string) => void;
  refresh: () => void;
}): React.JSX.Element {
  const [personas, setPersonas] = useState<readonly PersonaSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEditable, setSelectedEditable] = useState(false);
  const [definition, setDefinition] = useState<PersonaDefinition | null>(null);
  const [editor, setEditor] = useState<PersonaEditorState | null>(null);
  const [creating, setCreating] = useState(false);
  const [wire, setWire] = useState<PersonaProtocolId>("openai-chat");
  const [serverErrors, setServerErrors] = useState<readonly string[]>([]);
  const [deleteRefs, setDeleteRefs] = useState<{ readonly id: string; readonly providers: readonly string[]; readonly isGlobalDefault: boolean } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // 0.3.38 (2026-08-31 用户反馈:点击 persona 条目应弹窗,不要在下面出现具体详情):
  // the detail becomes a MODAL — same .pvd mechanics (.scrim + .modal-card,
  // centered over the page, always in view) the provider detail uses. Click
  // a row → opens; ✕/scrim/Esc close. selectedId survives a close so the row
  // keeps its aria-current; reopening re-opens the modal.
  const [detailOpen, setDetailOpen] = useState(false);
  // ω99-305: the family focus-pull — the pvd card's Esc rides an element-level
  // onKeyDown, which only fires while focus is INSIDE the dialog. Opening from
  // a row click leaves focus under the scrim (a programmatic click moves
  // nothing), so the card takes focus on open, exactly like the rest of the
  // .scrim > .modal-card family. Deps are [detailOpen] only: `dialog` is an
  // inline object rebuilt every render — keying on it would re-pull focus on
  // every keystroke inside the form.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (detailOpen) dialogRef.current?.focus();
  }, [detailOpen]);
  // ω99-309: pvd 详情卡内输入的组合态（composition 冒泡到卡级一处吃全）——
  // 组合期 Esc 是取消候选词，不是关卡（关卡=丢掉打到一半的表单稿）。
  const imeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });
  // Iteration 2 T2 — the global-default picker's layer qualifier. The picker
  // writes persona.id as an `<id>[:layers]` spec (settingsSet positional, ""
  // clears): specOverride is the picker's in-flight truth (the settings prop
  // lags a write by one refresh), layerChoice remembers a layer picked while
  // NO persona is selected — the qualifier only ever applies to an actual
  // persona pick (the "(未设置)" state never carries one).
  const [specOverride, setSpecOverride] = useState<string | null>(null);
  const [layerChoice, setLayerChoice] = useState<string | null>(null);
  const effSpec = specOverride ?? settings?.settings.personaId ?? "";
  const effId = splitPersonaSpec(effSpec).id;
  const effLayer = layerChoice ?? splitPersonaSpec(effSpec).layer;

  const loadList = (): void => {
    client
      .personaList()
      .then((r) => {
        setPersonas(r.personas);
        setListError(null);
      })
      .catch((e: unknown) => {
        const msg = errText(e);
        if (/unknown op|not supported/i.test(msg)) setDegraded(true);
        else setListError(msg);
      });
  };

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once by client identity
  }, [client]);

  const clearSelection = (): void => {
    setSelectedId(null);
    setSelectedEditable(false);
    setDefinition(null);
    setEditor(null);
    setServerErrors([]);
    setDeleteRefs(null);
    setDetailOpen(false);
    setCreating(false);
  };

  const selectPersona = (id: string): void => {
    setCreating(false);
    setEditor(null);
    setDefinition(null);
    setServerErrors([]);
    setDeleteRefs(null);
    setSelectedId(id);
    setDetailOpen(true);
    const row = (personas ?? []).find((p) => p.id === id);
    setSelectedEditable(row?.editable === true);
    client
      .personaGet(id)
      .then((r) => {
        setDefinition(r.definition);
        setWire(initialWireFor(r.definition));
        // final-review F2: editable means source is global — AND the
        // definition is fully round-trippable. A hand-authored global whose
        // definition carries fields the builder cannot emit opens in the
        // same read-only layout as the builtins (an editor save would
        // silently destroy the unmapped fields — the server writes the
        // client definition verbatim).
        if (row?.editable === true && isPersonaDefinitionRoundTrippable(r.definition)) setEditor(editorFromDefinition(r.definition));
      })
      .catch((e: unknown) => {
        setDefinition(null);
        notify(`⚠️ 读取失败：${errText(e)}`); // ω99-204: #4
      });
  };

  const openCreate = (): void => {
    clearSelection();
    setCreating(true);
    setEditor(blankEditor());
    setWire("openai-chat");
    setDetailOpen(true);
  };

  /** Closes the persona MODAL. ✕ / scrim / Esc call this — the row keeps its
   *  aria-current mark (selectedId survives), so a re-click re-opens the
   *  same dialog. Saving / deleting flow through `clearSelection` and
   *  close the dialog as a side-effect. */
  const closeDetail = (): void => {
    setDetailOpen(false);
    setCreating(false);
  };

  // --- writes -----------------------------------------------------------------

  const save = (): void => {
    if (editor === null) return;
    const def = buildPersonaDefinition(editor, creating);
    if (def === null) return; // the client gate — the rows already show why; no op leaves
    setPending("save");
    client
      .personaSave(def)
      .then((r) => {
        if (r.ok) {
          notify(`已保存 persona ${def.id}`);
          setServerErrors([]);
          setCreating(false);
          setSelectedId(def.id);
          setSelectedEditable(true);
          loadList();
          refresh();
        } else {
          setServerErrors(r.errors);
        }
      })
      .catch((e: unknown) => notify(`⚠️ 保存失败：${errText(e)}`))
      .finally(() => setPending(null));
  };

  const requestDelete = (): void => {
    if (selectedId === null) return;
    const id = selectedId;
    setPending(`del:${id}`);
    client
      .personaDelete({ id })
      .then((r) => {
        if (r.ok) {
          setDeleteRefs(null);
          notify(`已删除 persona ${id}`);
          clearSelection();
          loadList();
          refresh();
        } else {
          // The reference inventory — the confirm card's list; 「解绑并删除」
          // re-sends with unbind:true.
          setDeleteRefs({ id, providers: r.references.providers, isGlobalDefault: r.references.isGlobalDefault });
        }
      })
      .catch((e: unknown) => notify(`⚠️ 删除失败：${errText(e)}`))
      .finally(() => setPending(null));
  };

  const confirmUnbindDelete = (): void => {
    if (deleteRefs === null) return;
    const id = deleteRefs.id;
    setPending(`del:${id}`);
    client
      .personaDelete({ id, unbind: true })
      .then((r) => {
        if (r.ok) {
          setDeleteRefs(null);
          notify(`已解绑并删除 persona ${id}`);
          clearSelection();
          loadList();
          refresh();
        } else {
          notify(`⚠️ 删除失败：仍被引用(${r.references.providers.join(", ")})`);
        }
      })
      .catch((e: unknown) => notify(`⚠️ 删除失败：${errText(e)}`))
      .finally(() => setPending(null));
  };

  const setGlobalDefault = (id: string): void => {
    setPending("default");
    client
      .settingsSet("persona.id", id)
      .then(() => {
        notify(id === "" ? "已清除全局默认 persona" : `全局默认 persona → ${id}`);
        refresh();
      })
      .catch((e: unknown) => notify(`⚠️ 写入失败：${errText(e)}`))
      .finally(() => setPending(null));
  };

  // --- row plumbing -------------------------------------------------------------

  const patchEditor = (patch: Partial<PersonaEditorState>): void => {
    setEditor((cur) => (cur === null ? cur : { ...cur, ...patch }));
  };

  const patchHeaderRow = (w: PersonaProtocolId, i: number, patch: Partial<HeaderRowState>): void => {
    setEditor((cur) =>
      cur === null
        ? cur
        : { ...cur, headers: { ...cur.headers, [w]: cur.headers[w].map((r, j) => (j === i ? { ...r, ...patch } : r)) } },
    );
  };

  const patchBodyRow = (w: PersonaProtocolId, i: number, patch: Partial<BodyRowState>): void => {
    setEditor((cur) =>
      cur === null
        ? cur
        : { ...cur, body: { ...cur.body, [w]: cur.body[w].map((r, j) => (j === i ? { ...r, ...patch } : r)) } },
    );
  };

  const addHeaderRow = (w: PersonaProtocolId): void => {
    setEditor((cur) => (cur === null ? cur : { ...cur, headers: { ...cur.headers, [w]: [...cur.headers[w], emptyHeaderRow()] } }));
  };

  const addBodyRow = (w: PersonaProtocolId): void => {
    setEditor((cur) => (cur === null ? cur : { ...cur, body: { ...cur.body, [w]: [...cur.body[w], emptyBodyRow()] } }));
  };

  const removeHeaderRow = (w: PersonaProtocolId, i: number): void => {
    setEditor((cur) => (cur === null ? cur : { ...cur, headers: { ...cur.headers, [w]: cur.headers[w].filter((_, j) => j !== i) } }));
  };

  const removeBodyRow = (w: PersonaProtocolId, i: number): void => {
    setEditor((cur) => (cur === null ? cur : { ...cur, body: { ...cur.body, [w]: cur.body[w].filter((_, j) => j !== i) } }));
  };

  // --- degradation ---------------------------------------------------------------

  if (degraded) {
    return (
      <div className="settings-section set-sec" data-persona-tab>
        <h3 className="section-title set-title">Persona</h3>
        <div className="hint">升级 wudao 后可用</div>
      </div>
    );
  }

  // --- the form (editor for global personas / create; frozen view-model for
  //     the read-only builtin+workspace personas — same layout, disabled) ------

  const viewEditor = editor ?? (definition !== null ? editorFromDefinition(definition) : null);
  const formDisabled = viewEditor !== null && editor === null;
  // final-review F2 (R1): the 手工编写 hint applies ONLY to a persona the
  // user could otherwise edit (a global — selectedEditable). Builtins and
  // workspace personas trip the round-trip check too (foreign source row),
  // but they are read-only regardless; their hint stays the provenance line
  // (内置指纹/社区逆向指纹 · 只读), never the gate's 手工编写 mislabel.
  const advancedReadOnly = selectedEditable && definition !== null && !isPersonaDefinitionRoundTrippable(definition);
  const promptMode = definition?.prompt?.system?.mode ?? "prefix";
  // The selected row's summary (the detail head's source badge).
  const selectedRow = (personas ?? []).find((p) => p.id === selectedId);

  const renderForm = (e: PersonaEditorState): React.JSX.Element => {
    const allIssues = [...personaClientIssues(e, creating), ...serverErrors];
    // Row-scoped issues render INLINE on their row (exactly once); everything
    // else (id/displayName, errors whose row is not in the form) rides the
    // general list above the form.
    const matched = new Set<string>();
    for (const w of WIRES) {
      for (const r of e.headers[w]) {
        if (r.key.trim() === "") continue;
        for (const s of allIssues) if (s.startsWith(`headers.${w}.${r.key.trim()}:`)) matched.add(s);
      }
      for (const r of e.body[w]) {
        if (r.key === "") continue;
        for (const s of allIssues) if (s.startsWith(`body.${w}.${r.key}:`)) matched.add(s);
      }
    }
    const general = allIssues.filter((s) => !matched.has(s));
    const rowErrs = (layer: "headers" | "body", w: PersonaProtocolId, key: string): readonly string[] =>
      key === "" ? [] : allIssues.filter((s) => s.startsWith(`${layer}.${w}.${key}:`));

    return (
      <div className="persona-form">
        {/* The detail's identity strip — the same .detail-head language the
            provider detail column speaks (display name + id + source badge);
            the read-only builtins additionally carry the 只读 tag. */}
        <div className="detail-head">
          {creating ? (
            <strong>新建 persona</strong>
          ) : (
            <>
              <strong>{e.displayName !== "" ? e.displayName : e.id}</strong>
              <span className="meta persona-id">{e.id}</span>
              {selectedRow !== undefined ? <span className="meta">{SOURCE_BADGE[selectedRow.source]}</span> : null}
              {formDisabled ? <span className="meta">只读</span> : null}
            </>
          )}
        </div>
        {general.length > 0 ? <div className="entry-error">{general.join("\n")}</div> : null}
        <div className="prefrow">
          <span className="pref-label">id:</span>
          <input
            type="text"
            className="wudao-input ctl"
            aria-label="id"
            placeholder="kebab-case(仅创建时可改)"
            value={e.id}
            disabled={formDisabled || !creating}
            onChange={(ev) => patchEditor({ id: ev.target.value })}
          />
        </div>
        <div className="prefrow">
          <span className="pref-label">displayName:</span>
          <input
            type="text"
            className="wudao-input ctl"
            aria-label="displayName"
            value={e.displayName}
            disabled={formDisabled}
            onChange={(ev) => patchEditor({ displayName: ev.target.value })}
          />
        </div>
        <div className="prefrow">
          <span className="pref-label">prompt:</span>
          <select className="ctl" aria-label="prompt mode" value={promptMode} disabled={true}>
            <option value="prefix">prefix</option>
            <option value="snapshot">snapshot</option>
          </select>
        </div>
        <textarea
          className="wudao-input persona-prompt"
          aria-label="prompt"
          rows={4}
          placeholder="system 前缀文本(prefix 模式;空 = 不带 prompt 层)"
          value={e.promptText}
          disabled={formDisabled}
          onChange={(ev) => patchEditor({ promptText: ev.target.value })}
        />

        {/* ONE shared wire strip — the active wire's headers and body rows
            render together (the three wires are the persona's only paging
            axis). Each tab carries the wire's row-count badge (headers+body
            rows); a zero count dims so an empty wire reads empty at a
            glance. */}
        <div className="persona-wire-tabs" role="tablist" aria-label="wire 协议分页">
          {WIRES.map((w) => {
            const count =
              e.headers[w].filter((r) => r.key.trim() !== "").length + e.body[w].filter((r) => r.key !== "").length;
            return (
              <button
                key={w}
                type="button"
                role="tab"
                data-wire={w}
                aria-selected={wire === w}
                className={`segctl-opt${wire === w ? " on" : ""}`}
                onClick={() => setWire(w)}
              >
                {w}
                <span className={`wire-count${count === 0 ? " zero" : ""}`}>{count}</span>
              </button>
            );
          })}
        </div>

        <div className="persona-layer">
          <div className="pref-label">{`headers(${wire})`}</div>
          {e.headers[wire].map((r, i) => {
            const errs = rowErrs("headers", wire, r.key.trim());
            return (
              <div key={i} className={`row keyrow${errs.length > 0 ? " error" : ""}`}>
                <input
                  type="text"
                  className="wudao-input ctl"
                  aria-label={i === 0 ? `headers.${wire}.key` : `headers.${wire}.${i}.key`}
                  placeholder="header 名(如 user-agent)"
                  value={r.key}
                  disabled={formDisabled}
                  onChange={(ev) => patchHeaderRow(wire, i, { key: ev.target.value })}
                />
                <input
                  type="text"
                  className="wudao-input ctl"
                  aria-label={i === 0 ? `headers.${wire}.value` : `headers.${wire}.${i}.value`}
                  placeholder="值"
                  value={r.value}
                  disabled={formDisabled}
                  onChange={(ev) => patchHeaderRow(wire, i, { value: ev.target.value })}
                />
                <button type="button" className="ctl" disabled={formDisabled} onClick={() => removeHeaderRow(wire, i)}>
                  移除
                </button>
                {errs.map((s) => (
                  <span key={s} className="entry-error">
                    {s}
                  </span>
                ))}
              </div>
            );
          })}
          <button type="button" className="ctl" disabled={formDisabled} onClick={() => addHeaderRow(wire)}>
            ＋ 添加头
          </button>
        </div>

        <div className="persona-layer">
          <div className="pref-label">{`body(${wire})`}</div>
          {e.body[wire].map((r, i) => {
            const errs = rowErrs("body", wire, r.key);
            return (
              <div key={i} className={`row keyrow${errs.length > 0 ? " error" : ""}`}>
                <select
                  className="ctl"
                  aria-label={i === 0 ? `body.${wire}.key` : `body.${wire}.${i}.key`}
                  value={r.key}
                  disabled={formDisabled}
                  onChange={(ev) => patchBodyRow(wire, i, { key: ev.target.value })}
                >
                  <option value="">(选择键)</option>
                  {BODY_WHITELIST[wire].map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  className="wudao-input ctl"
                  aria-label={i === 0 ? `body.${wire}.value` : `body.${wire}.${i}.value`}
                  placeholder='JSON 值(如 0.7、"text"、false)'
                  value={r.value}
                  disabled={formDisabled}
                  onChange={(ev) => patchBodyRow(wire, i, { value: ev.target.value })}
                />
                <button type="button" className="ctl" disabled={formDisabled} onClick={() => removeBodyRow(wire, i)}>
                  移除
                </button>
                {errs.map((s) => (
                  <span key={s} className="entry-error">
                    {s}
                  </span>
                ))}
              </div>
            );
          })}
          <button type="button" className="ctl" disabled={formDisabled} onClick={() => addBodyRow(wire)}>
            ＋ 添加 body 键
          </button>
        </div>

        {!formDisabled ? (
          <div className="keyrow">
            <button type="button" className="ctl persona-save" disabled={pending === "save"} onClick={save}>
              保存
            </button>
            {creating ? (
              <button type="button" className="ctl" onClick={clearSelection}>
                取消
              </button>
            ) : (
              <button type="button" className="ctl persona-del" disabled={pending !== null} onClick={requestDelete}>
                删除
              </button>
            )}
          </div>
        ) : (
          <div className="hint">
            {advancedReadOnly
              ? "此 persona 含高级字段(快照/工具名映射/默认层/置信度),由手工编写,仅支持查看"
              : `${definition?.source.kind === "external-research" ? "社区逆向指纹(external-research)" : "内置指纹(workspace-source)"} · 只读`}
          </div>
        )}
      </div>
    );
  };

  // 0.3.38 persona modal dialog (TS narrowing via the dialog object, same
  // trick ProviderTab uses — JSX ternaries can't carry `selectedId !== null`
  // through nested branches). null = nothing to show. Lives after renderForm
  // and selectedRow (both hoisted consts above) so the closure can read them.
  const dialog: { readonly aria: string; readonly head: string; readonly body: React.JSX.Element } | null =
    !detailOpen
      ? null
      : creating
        ? {
            aria: "新建 persona",
            head: "新建 persona",
            body: renderForm(viewEditor ?? blankEditor()),
          }
        : selectedId === null
          ? null
          : {
              aria: `persona ${selectedRow?.displayName ?? selectedId}`,
              head: selectedRow?.displayName ?? selectedId,
              body:
                viewEditor !== null
                  ? renderForm(viewEditor)
                  : <div className="muted">读取中…</div>,
            };

  return (
    <div className="settings-section set-sec" data-persona-tab>
      <h3 className="section-title set-title">Persona</h3>
      <div className="hint">
        persona = 三层请求指纹(headers / body / prompt)。内置指纹只读;全局 persona 在此新建与编辑;供应商绑定在各供应商详情处设置。
      </div>
      <div className="prefrow persona-default">
        <span className="pref-label">全局默认:</span>
        <select
          className="ctl persona-pick"
          aria-label="全局默认 persona"
          title="未设置时按供应商绑定回落;供应商绑定可在各供应商详情处设置"
          value={effId}
          disabled={pending === "default"}
          onChange={(e) => {
            const v = e.target.value;
            const next = v === "" ? "" : qualifyPersonaSpec(v, effLayer);
            setSpecOverride(next);
            setGlobalDefault(next);
          }}
        >
          <option value="">(未设置)</option>
          {(personas ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName ?? p.id}
            </option>
          ))}
        </select>
        {/* The layer qualifier — composed onto the picked persona's id as the
            `id:layers` spec. Value only applies to an actual persona pick;
            with none selected it just remembers the choice for the next
            pick. */}
        <select
          className="ctl persona-pick-layer"
          aria-label="全局默认层"
          title="限定该 persona 只作用于选中的层(全部层 = 完整指纹)"
          value={effLayer}
          disabled={pending === "default"}
          onChange={(e) => {
            const v = e.target.value;
            setLayerChoice(v);
            if (effId !== "") {
              const next = qualifyPersonaSpec(effId, v);
              setSpecOverride(next);
              setGlobalDefault(next);
            }
          }}
        >
          {PERSONA_LAYER_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {listError !== null ? <div className="entry-error">{`无法读取 persona 列表:${listError}`}</div> : null}
      <button type="button" className="ctl persona-add" onClick={openCreate}>
        ＋ 新建
      </button>
      <div className="provider-master">
        <div className="provider-cards">
          {personas === null && listError === null ? <div className="provider-empty">读取中…</div> : null}
          {(personas ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              className="persona-row"
              data-persona={p.id}
              aria-current={selectedId === p.id && !creating ? "true" : undefined}
              onClick={() => selectPersona(p.id)}
            >
              <span className="persona-name">{p.displayName ?? p.id}</span>
              <span className="meta persona-id">{p.id}</span>
              <span className="meta persona-layers">{p.layers}</span>
              <span className="meta persona-src">{SOURCE_BADGE[p.source]}</span>
            </button>
          ))}
        </div>
      </div>
      {/* 0.3.38 persona 详情弹窗 (沿用 pvd 的 .modal-card 套路): ✕ / scrim /
          Esc 关闭;Esc 在此吞掉不上冒(settings 页面根 Esc = 返回会话)。
          创建流 + 查看流共用一个 dialog —— selectedId + creating 一起决定
          渲染哪一份表。deleteRefs 的二次确认表单直接挂进 dialog.body,
          不再走独立的右侧详情栏。 */}
      {detailOpen && dialog !== null ? (
        <div
          className="scrim pvd-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDetail();
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
            <div className="pvd-body">
              {deleteRefs !== null && !creating ? (
                <div className="persona-delete-confirm">
                  <div>{`该 persona 正被引用,「解绑并删除」将同时清除:`}</div>
                  <ul>
                    {deleteRefs.providers.map((prov) => (
                      <li key={prov}>{`供应商 ${prov} 的 persona 绑定`}</li>
                    ))}
                    {deleteRefs.isGlobalDefault ? <li>全局默认 persona(persona.id 清空)</li> : null}
                  </ul>
                  <div className="keyrow">
                    <button type="button" className="ctl persona-del" disabled={pending !== null} onClick={confirmUnbindDelete}>
                      解绑并删除
                    </button>
                    <button type="button" className="ctl" onClick={() => setDeleteRefs(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                dialog.body
              )}
            </div>
          </div>
        </div>
      ) : null}
      <div className="hint">{`头值模板槽:${TEMPLATE_SLOTS.join(" ")}(逐请求解析;未知槽位在保存前即被拒)`}</div>
    </div>
  );
}
