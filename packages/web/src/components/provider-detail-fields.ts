// 拆分运动 C：从 ProviderDetail.tsx 原样外提的编辑/新增两面板共享域
//（errText、格式/档位/协议选项表、sentinel 值、DetailDraft + draftOf）。
import type { ProviderCard } from "../protocol.js";
import type { RowDraft } from "./ModelConfigModal.js";

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The add-form's reasoningFormat options — the mirror of providers/src
 *  config.ts REASONING_FORMATS (the web package never imports the providers
 *  package; protocol.ts is its only server knowledge). Pinned by the
 *  provider-tab suite's create-flow test. (Lived in ProviderTab until iter5
 *  moved the add form into the detail column.) */
export const REASONING_FORMATS: readonly string[] = [
  "none",
  "deepseek",
  "zai",
  "qwen",
  "qwen-chat-template",
  "openrouter",
  "together",
  "baseten",
];

/** 推理档三级配置 S5: the effort binding selector's levels + two sentinel
 *  option values — never a legal level (levels are lowercase words, the
 *  sentinels are ""/"::none"). */
export const EFFORT_LEVELS = ["low", "medium", "high", "max", "none"] as const;
export const EFFORT_FOLLOW_GLOBAL = "";
export const EFFORT_FORCED_NONE = "::none";

/** The binding selector's two sentinel option values — never a legal persona
 *  id (PERSONA_ID_RE is lowercase kebab), so the registry's three states live
 *  in ONE <select> value space: "" = follow the global default (the payload
 *  omits the key entirely — absence is a CHOICE), "::none" = forced none
 *  (explicit null; the global default never applies), anything else = that
 *  persona id (bound). */
export const PERSONA_FOLLOW_GLOBAL = "";
export const PERSONA_FORCED_NONE = "::none";

/** 0.3.13 (task 215): the protocol (wire) selector's option table. "" is the
 *  ABSENCE sentinel — a wire-less registry row stays wire-less after a save
 *  (the openai-chat default materializes at dispatch, never in the file);
 *  every other value is a ProtocolId the registry validator accepts. */
export const WIRE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "", label: "OpenAI 兼容(默认)" },
  { value: "anthropic", label: "Anthropic 协议" },
  { value: "responses", label: "OpenAI Responses" },
];

/** The wire selector's display label (the builtin rows' fixed text reuses it). */
export const wireLabel = (wire: string | undefined): string =>
  WIRE_OPTIONS.find((o) => o.value === (wire ?? ""))?.label ?? `OpenAI 兼容(默认)`;

export interface DetailDraft {
  readonly label: string;
  readonly baseUrl: string;
  readonly rows: readonly RowDraft[];
  /** 0.3.13 (task 215): the protocol draft (customs only) — "" is the absence
   *  sentinel (a wire-less row stays wire-less); seeded from the card's
   *  wire column. Builtins never read it (their 协议 row is fixed by the
   *  profile and echoed verbatim at save). */
  readonly wire: string;
  /** The binding row's draft — the registry's three states verbatim:
   *  undefined = follow the global default (the key is absent), a string =
   *  bound persona id, null = forced none. Seeded from the wire card; the
   *  selector maps it to/from its sentinel value space. */
  readonly persona: string | null | undefined;
  // Iteration 2 T2: a bound string may carry the `id:layers` qualifier — it
  // round-trips through the draft UNTOUCHED (the F1 echo), the binding select
  // shows only the id part, and the layer select composes/decomposes the
  // qualifier.
  /** 推理档三级配置 S5: the effort binding's draft — the registry's three
   *  states verbatim (undefined = follow the global model.defaultEffort,
   *  a string = bound level, null = explicit don't-send). Seeded from the
   *  wire card; echoed in BOTH save payloads (wholesale replace). */
  readonly effort: string | null | undefined;
}

export const draftOf = (card: ProviderCard): DetailDraft => ({
  label: card.label,
  // 0.3.28 ②: customs seed the registered base (the row IS the provider —
  // card.baseUrl is its defaultBaseUrl). Builtins seed the RAW overlay only
  // (registeredBaseUrl): empty = no overlay = the compiled default stays in
  // force. Seeding an un-overlaid builtin with the compiled URL would pin
  // it into the registry as an overlay on the next save.
  baseUrl: card.custom ? (card.baseUrl ?? "") : (card.registeredBaseUrl ?? ""),
  rows: card.models.map((m) => ({ name: m.name, ctx: m.contextLength != null ? String(m.contextLength) : "" })),
  wire: card.wire ?? "",
  persona: card.persona,
  effort: card.effort,
});
