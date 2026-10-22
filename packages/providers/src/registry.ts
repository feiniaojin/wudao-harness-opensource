// Runtime provider registry (provider management §3): ~/.wudao/providers.json
// holds user overlays for the builtin profiles and fully custom
// OpenAI-compatible providers. This module owns the file seam (fault-tolerant
// read, atomic 0600 write), per-entry validation (fail-visible — invalid rows
// surface as {id, reason}, they are never silently dropped on the floor), and
// the pure merge into the effective profile view that resolution and the CLI
// consume. Keys NEVER live here — they stay in the credentials file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { headerRepresentabilityError } from "./header-validation.js";
import { FORBIDDEN_HEADER_KEYS } from "./persona/schema.js";
import { PROVIDER_PROFILES, REASONING_EFFORTS, REASONING_FORMATS, isBuiltinProviderName } from "./config.js";
import type { BuiltinProviderName, ProviderProfile, ReasoningEffort, ReasoningFormat, WindowMode } from "./config.js";
import type { ProtocolId } from "./persona/types.js";
import { PROTOCOL_IDS } from "./persona/schema.js";
import { parsePersonaSpec } from "./persona/runtime.js";
import { isModelPrices, type ModelPrices } from "./pricing.js";

/** Same charset as the CLI's credentials ids (credentials.ts ID_RE) —
 *  redeclared here because the dependency direction is cli → providers. */
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Upper bound for any user-supplied context length — everything above is
 *  treated as a typo, not a 10M-token window. */
const MAX_CONTEXT_LENGTH = 10_000_000;

/** One catalog entry: a model name plus its optional context window and
 *  (借鉴弧 B1) its optional doc-verified prices — the catalog face the cache
 *  economics ratio derives from. A pin exists ONLY where the number comes
 *  from the provider's own docs (same policy as contextLength). */
export interface ProviderModelEntry {
  readonly name: string;
  readonly contextLength?: number;
  readonly prices?: ModelPrices;
}

/** The user-facing slice of a profile (registry file shape). Every field is
 *  optional; unknown fields are ignored for forward compatibility. */
export interface UserProviderConfig {
  readonly label?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly reasoningFormat?: ReasoningFormat;
  readonly windowMode?: WindowMode;
  readonly defaultContextLength?: number;
  readonly models?: readonly ProviderModelEntry[];
  readonly thinkingLevelMap?: ProviderProfile["thinkingLevelMap"];
  readonly supportsReasoningEffort?: boolean;
  readonly acceptsReasoningOnlyFinish?: boolean;
  readonly requiresBaseUrl?: boolean;
  /** SDD 2026-08-23 persona Task 4 — the per-provider persona binding, a
   *  THREE-STATE column (spec §2): key absent = follow the global default;
   *  a non-empty string = bound persona id; explicit null = forced none.
   *  Deliberately NOT part of EffectiveProfile — it is binding-chain data
   *  (read by the CLI's readProviderPersonaBinding), never a profile fact,
   *  so the effectiveProfiles merge never touches it. */
  readonly persona?: string | null;
  /** SDD 2026-08-24 reg-headers Task 1 (92 §3.4-1); ω99-64 on the wire —
   *  per-provider extra request headers (the enterprise-gateway baseline).
   *  CONTROLLER RULING (ω99-64): the old "deliberately never an
   *  EffectiveProfile fact" stance is REVERSED. Unlike `persona` (binding-
   *  chain data with its own lifecycle, still profile-external), headers are
   *  a TRANSPORT-LAYER fact of the endpoint — the same class as baseUrl /
   *  wire / balanceUrl (gateway-fronting facts). They fold through the
   *  effectiveProfiles overlay merge (overlay-beats-builtin for free) and
   *  ride to request construction as ProviderConfig.extraHeaders, spread
   *  behind adapter auth and ahead of persona wire.headers. FORBIDDEN keys
   *  (auth/transport-control, single source persona/schema) refuse the row
   *  at save AND load — a registry row can structurally never override the
   *  adapter's credentials or transport headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** 0.3.13 (#215, user trial feedback): the PROTOCOL this row speaks —
   *  "openai-chat" | "anthropic" | "responses". Absent = the dispatch
   *  default (openai-chat), byte-identical to the historical shape. Unlike
   *  persona/headers this IS a profile fact: the effectiveProfiles merge
   *  folds it into EffectiveProfile.wire, where resolveProviderConfigResult
   *  already consults it (selection.wire > env > profile.wire) — so a
   *  custom Anthropic-protocol provider needs NO WUDAO_WIRE once saved. */
  readonly wire?: ProtocolId;
  /** P0-4 (96 队列): the row's wallet-balance endpoint. A profile fact like
   *  wire: an explicit overlay value beats the builtin's compiled-in pin,
   *  and a custom's own value rides through — the /cost all wallet face
   *  resolves it from the effective profile view. */
  readonly balanceUrl?: string;
  /** 2026-08-28 推理档三级配置 S1 — the per-provider reasoning-effort
   *  binding, a THREE-STATE column mirroring `persona`: key absent = follow
   *  the global default (model.defaultEffort); a string = bound level (a
   *  REASONING_EFFORTS member); explicit null = don't send the param at all
   *  (distinct from the literal "none" level, which IS a wire value). Like
   *  persona, deliberately never an EffectiveProfile fact — the CLI's
   *  effort resolution chain reads it (readProviderEffortBinding). */
  readonly effort?: string | null;
  /** ω99-245: #5 — the capability-catalog OVERRIDE column: what THIS
   *  endpoint accepts, wholesale-replacing the compiled-in family set (and
   *  its model pins) in supportedEfforts. The user's escape hatch for a new
   *  model or an outdated catalog pin — fail-closed but never bricked. A
   *  non-empty array of REASONING_EFFORTS members (validated fail-visibly:
   *  junk must never silently widen the gate). Unlike `effort` above this IS
   *  an EffectiveProfile fact (like headers/wire), read through the
   *  effective view. */
  readonly efforts?: readonly ReasoningEffort[];
}

/** The registry file: version-gated from v1, malformed files load as empty. */
export interface ProviderRegistryFile {
  readonly version: 1;
  readonly providers: Record<string, UserProviderConfig>;
}

/** A load outcome: the entries that validated, plus one row per entry that
 *  did not (fail-visible — the UI lists them; boot never blocks on them). */
export interface RegistryLoadResult {
  readonly entries: ReadonlyMap<string, UserProviderConfig>;
  readonly invalid: readonly { id: string; reason: string }[];
}

/** A ProviderProfile extended with the registry-only facts: the per-model
 *  catalog (empty for builtins unless an overlay supplies one — the builtin
 *  defaultModel never joins it), the provider-level context-window default,
 *  whether the id is user-registered (custom) or compiled in, and (ω99-245)
 *  the optional capability-catalog override the effort preflight reads. */
export type EffectiveProfile = ProviderProfile & {
  readonly models: readonly ProviderModelEntry[];
  readonly defaultContextLength?: number;
  readonly custom: boolean;
  /** The supported-efforts override (see UserProviderConfig.efforts).
   *  Absent on every builtin; present exactly when a registry row declares it. */
  readonly efforts?: readonly ReasoningEffort[];
};

/** Where the registry lives. Mirrors the CLI's global-home resolution so
 *  tests/CI isolate the whole ~/.wudao tier with one env var. */
export function defaultProviderRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env["WUDAO_GLOBAL_HOME"] ?? "").trim();
  const home = raw !== "" ? raw : join(homedir(), ".wudao");
  return join(home, "providers.json");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A bounded positive integer ≤ 10M (context lengths). */
function isContextLength(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_CONTEXT_LENGTH;
}

/** Validate one registry entry. Returns the SANITIZED config (unknown fields
 *  dropped) or the reason it was refused. A builtin id may overlay without a
 *  baseUrl; a custom id must carry one — it IS the provider. */
export function validateUserProviderEntry(
  id: string,
  cfg: unknown,
): { ok: true; value: UserProviderConfig } | { ok: false; reason: string } {
  if (!ID_RE.test(id)) {
    return { ok: false, reason: `invalid provider id "${id}" (expected letter first, then [A-Za-z0-9_-])` };
  }
  if (!isPlainObject(cfg)) {
    return { ok: false, reason: `entry must be an object (got ${Array.isArray(cfg) ? "array" : typeof cfg})` };
  }
  const value: {
    label?: string;
    baseUrl?: string;
    defaultModel?: string;
    reasoningFormat?: ReasoningFormat;
    windowMode?: WindowMode;
    defaultContextLength?: number;
    models?: ProviderModelEntry[];
    thinkingLevelMap?: Readonly<Record<string, string | null>>;
    supportsReasoningEffort?: boolean;
    acceptsReasoningOnlyFinish?: boolean;
    requiresBaseUrl?: boolean;
    persona?: string | null;
    headers?: Record<string, string>;
    wire?: ProtocolId;
    balanceUrl?: string;
    effort?: string | null;
    efforts?: readonly ReasoningEffort[];
  } = {};

  if (cfg.label !== undefined) {
    if (typeof cfg.label !== "string") return { ok: false, reason: "label must be a string" };
    value.label = cfg.label;
  }
  if (cfg.baseUrl !== undefined) {
    if (typeof cfg.baseUrl !== "string") return { ok: false, reason: "baseUrl must be a string" };
    let url: URL;
    try {
      url = new URL(cfg.baseUrl);
    } catch {
      return { ok: false, reason: `baseUrl "${cfg.baseUrl}" is not a valid URL` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reason: `baseUrl "${cfg.baseUrl}" must be an http(s) URL` };
    }
    value.baseUrl = cfg.baseUrl;
  }
  if (cfg.defaultModel !== undefined) {
    if (typeof cfg.defaultModel !== "string" || cfg.defaultModel === "") {
      return { ok: false, reason: "defaultModel must be a non-empty string" };
    }
    value.defaultModel = cfg.defaultModel;
  }
  if (cfg.reasoningFormat !== undefined) {
    if (typeof cfg.reasoningFormat !== "string" || !(REASONING_FORMATS as readonly string[]).includes(cfg.reasoningFormat)) {
      return { ok: false, reason: `reasoningFormat "${String(cfg.reasoningFormat)}" is not one of: ${REASONING_FORMATS.join(", ")}` };
    }
    value.reasoningFormat = cfg.reasoningFormat as ReasoningFormat;
  }
  if (cfg.windowMode !== undefined) {
    if (cfg.windowMode !== "shared" && cfg.windowMode !== "independent" && cfg.windowMode !== "unknown") {
      return { ok: false, reason: `windowMode "${String(cfg.windowMode)}" must be shared | independent | unknown` };
    }
    value.windowMode = cfg.windowMode;
  }
  // 0.3.13 (#215): the protocol field — one of PROTOCOL_IDS, fail-visible
  // like every other column (a typo'd wire would silently fall back to the
  // openai adapter at dispatch, the exact masquerade parseWire exists to
  // prevent for env/selection values).
  if (cfg.wire !== undefined) {
    if (typeof cfg.wire !== "string" || !(PROTOCOL_IDS as readonly string[]).includes(cfg.wire)) {
      return { ok: false, reason: `wire "${String(cfg.wire)}" is not one of: ${PROTOCOL_IDS.join(", ")}` };
    }
    value.wire = cfg.wire as ProtocolId;
  }
  // P0-4 (96 队列): the wallet-balance endpoint — an http(s) URL or the row
  // refuses fail-visibly (same shape rule as baseUrl; a silently-dropped
  // balanceUrl would masquerade as "no balance face", a different behavior).
  if (cfg.balanceUrl !== undefined) {
    if (typeof cfg.balanceUrl !== "string") return { ok: false, reason: "balanceUrl must be a string" };
    let url: URL;
    try {
      url = new URL(cfg.balanceUrl);
    } catch {
      return { ok: false, reason: `balanceUrl "${cfg.balanceUrl}" is not a valid URL` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reason: `balanceUrl "${cfg.balanceUrl}" must be an http(s) URL` };
    }
    value.balanceUrl = cfg.balanceUrl;
  }
  // 2026-08-28 推理档三级配置 S1 — the effort binding, three-state like
  // persona: only a REASONING_EFFORTS member or null passes; a junk value
  // refuses the row fail-visibly (a silently-dropped value would masquerade
  // as "follow global" — a DIFFERENT behavior, the same trap persona guards).
  if (cfg.effort !== undefined) {
    if (cfg.effort !== null && (typeof cfg.effort !== "string" || !(REASONING_EFFORTS as readonly string[]).includes(cfg.effort))) {
      return { ok: false, reason: `effort "${String(cfg.effort)}" must be one of: ${REASONING_EFFORTS.join(", ")} or null (explicit don't-send)` };
    }
    value.effort = cfg.effort;
  }
  // The catalog-escape column: a non-empty array of known
  // levels (junk/empty refuses the row fail-visibly — a silently-dropped
  // override would masquerade as the derived catalog, a DIFFERENT gate).
  if (cfg.efforts !== undefined) {
    if (
      !Array.isArray(cfg.efforts) || cfg.efforts.length === 0
      || !cfg.efforts.every((e) => typeof e === "string" && (REASONING_EFFORTS as readonly string[]).includes(e))
    ) {
      return { ok: false, reason: `efforts must be a non-empty array of: ${REASONING_EFFORTS.join(", ")}` };
    }
    value.efforts = cfg.efforts as ReasoningEffort[];
  }
  if (cfg.defaultContextLength !== undefined) {
    if (!isContextLength(cfg.defaultContextLength)) {
      return { ok: false, reason: `defaultContextLength ${String(cfg.defaultContextLength)} must be a positive integer ≤ ${MAX_CONTEXT_LENGTH}` };
    }
    value.defaultContextLength = cfg.defaultContextLength;
  }
  if (cfg.models !== undefined) {
    if (!Array.isArray(cfg.models)) return { ok: false, reason: "models must be an array" };
    const models: ProviderModelEntry[] = [];
    const seen = new Set<string>();
    for (const m of cfg.models) {
      if (!isPlainObject(m) || typeof m.name !== "string" || m.name === "") {
        return { ok: false, reason: "every model entry needs a non-empty string name" };
      }
      if (seen.has(m.name)) return { ok: false, reason: `duplicate model name "${m.name}"` };
      seen.add(m.name);
      // 借鉴弧 B1：可选价目 pin——形状坏拒行（fail-visible；静默丢掉会把
      // 「配了价」伪装成「价目未知」，不同的决策面）。
      if (m.prices !== undefined && !isModelPrices(m.prices)) {
        return { ok: false, reason: `prices for model "${m.name}" must be {inputPerM, cacheReadPerM, outputPerM?, cacheWritePerM?} (finite ≥ 0, per-M-USD)` };
      }
      if (m.contextLength !== undefined) {
        if (!isContextLength(m.contextLength)) {
          return { ok: false, reason: `contextLength for model "${m.name}" must be a positive integer ≤ ${MAX_CONTEXT_LENGTH}` };
        }
        models.push({
          name: m.name,
          contextLength: m.contextLength,
          ...(m.prices !== undefined ? { prices: m.prices } : {}),
        });
      } else {
        models.push({
          name: m.name,
          ...(m.prices !== undefined ? { prices: m.prices } : {}),
        });
      }
    }
    value.models = models;
  }
  if (cfg.thinkingLevelMap !== undefined) {
    if (!isPlainObject(cfg.thinkingLevelMap)) return { ok: false, reason: "thinkingLevelMap must be an object" };
    for (const k of Object.keys(cfg.thinkingLevelMap)) {
      const v = cfg.thinkingLevelMap[k];
      if (typeof v !== "string" && v !== null) {
        return { ok: false, reason: `thinkingLevelMap.${k} must be a string or null` };
      }
    }
    value.thinkingLevelMap = cfg.thinkingLevelMap as Readonly<Record<string, string | null>>;
  }
  if (cfg.supportsReasoningEffort !== undefined) {
    if (typeof cfg.supportsReasoningEffort !== "boolean") return { ok: false, reason: "supportsReasoningEffort must be a boolean" };
    value.supportsReasoningEffort = cfg.supportsReasoningEffort;
  }
  if (cfg.acceptsReasoningOnlyFinish !== undefined) {
    if (typeof cfg.acceptsReasoningOnlyFinish !== "boolean") return { ok: false, reason: "acceptsReasoningOnlyFinish must be a boolean" };
    value.acceptsReasoningOnlyFinish = cfg.acceptsReasoningOnlyFinish;
  }
  if (cfg.requiresBaseUrl !== undefined) {
    if (typeof cfg.requiresBaseUrl !== "boolean") return { ok: false, reason: "requiresBaseUrl must be a boolean" };
    value.requiresBaseUrl = cfg.requiresBaseUrl;
  }
  // SDD 2026-08-23 persona Task 4 — the three-state binding column. null is a
  // VALUE (forced none), not absence: only a non-empty string or null passes,
  // everything else refuses the row (fail-visible — a silently-dropped junk
  // value would masquerade as "follow global", a different behavior).
  // Layer-selection Task 1: the string may carry the `<id>:layers` qualifier
  // (parsePersonaSpec shape — `+`/`,` joined). Registry EXISTENCE is still not
  // checked here (this validator has no persona-registry access): an unknown
  // id stays savable and fails closed at resolve time.
  if (cfg.persona !== undefined) {
    if (cfg.persona !== null && (typeof cfg.persona !== "string" || cfg.persona.trim() === "")) {
      return { ok: false, reason: `persona "${String(cfg.persona)}" must be a non-empty persona id or null (explicit unbind)` };
    }
    if (cfg.persona !== null) {
      const parsed = parsePersonaSpec(cfg.persona);
      if (!parsed.ok) {
        return { ok: false, reason: `persona "${cfg.persona}" must be <id> or <id>:headers|body|prompt ("+"/","-joined) or null — ${parsed.error}` };
      }
    }
    value.persona = cfg.persona;
  }
  // SDD 2026-08-24 reg-headers Task 1 (92 §3.4-1); ω99-64 wire batch — the
  // extra request headers: a flat string → string map, same shape rules as
  // thinkingLevelMap. CONSUMED on the wire since ω99-64 (folded into
  // EffectiveProfile.headers → ProviderConfig.extraHeaders → the adapters'
  // fetch headers, behind adapter auth, ahead of persona wire.headers). A
  // junk shape refuses the row fail-visible rather than being dropped —
  // a silently-dropped header would masquerade as "none configured".
  if (cfg.headers !== undefined) {
    if (!isPlainObject(cfg.headers)) return { ok: false, reason: "headers must be an object of string → string" };
    for (const k of Object.keys(cfg.headers)) {
      if (typeof cfg.headers[k] !== "string") {
        return { ok: false, reason: `headers.${k} must be a string (got ${typeof cfg.headers[k]})` };
      }
      // ω99-64 双拦前置之二：FORBIDDEN 键拒行（T0 亲证 50 只落了 shape +
      // 可表示性，本检查是本弧新增）。单源 import：persona/schema.ts 的
      // FORBIDDEN_HEADER_KEYS（auth/transport-control 归 adapter 所有），
      // 文案镜像 checkHeaderMap 的形状。case-insensitive（"Authorization"
      // 与 "authorization" 同拒）。坏键 fail-visible 拒行，结构上不可能
      // 发生 registry 行覆盖 adapter 的 Authorization/x-api-key/content-type。
      if (FORBIDDEN_HEADER_KEYS.has(k.toLowerCase())) {
        return {
          ok: false,
          reason: `provider card "${id}": headers.${k}: "${k.toLowerCase()}" is a forbidden provider header (auth/transport-control — the adapter owns it)`,
        };
      }
    }
    // ω99-50：fetch 可表示性（保存期即红）。坏名字/坏值在卡片写盘前拒——
    // registry 行的 headers 列是持久化的用户输入面（wire 接线是后续批次），
    // 坏值落盘只会把失败推迟到将来第一次真实请求。settingsSaveProvider 走
    // 本校验器，盘上文件零变化；探针与适配器缝同一来源（header-validation.ts）。
    for (const [k, v] of Object.entries(cfg.headers)) {
      const rep = headerRepresentabilityError(k, v as string);
      if (rep !== null) {
        return { ok: false, reason: `provider card "${id}": headers.${k} cannot be sent — ${rep}` };
      }
    }
    value.headers = cfg.headers as Record<string, string>;
  }
  // Unknown fields are dropped here (forward compatibility) — `value` carries
  // only the known surface.
  if (value.baseUrl === undefined && !isBuiltinProviderName(id)) {
    return { ok: false, reason: `custom provider "${id}" needs a baseUrl (builtin ids may overlay without one)` };
  }
  return { ok: true, value };
}

/** Read + validate the registry. Fault-tolerant by contract: a missing file
 *  is an empty registry; a malformed file (bad JSON, wrong version, wrong
 *  shape) demotes to empty entries with ONE file-level invalid row; a bad
 *  ENTRY costs only that entry. Never throws. */
export function readProviderRegistrySync(path: string = defaultProviderRegistryPath()): RegistryLoadResult {
  const empty: RegistryLoadResult = { entries: new Map(), invalid: [] };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    // R-M1 (T1 review): only a MISSING file is the silent empty registry; any
    // other read failure (EACCES, EISDIR, …) is fail-visible — an empty result
    // with one file-level invalid row naming the errno, never a throw.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return empty; // absent — the builtins still cover everything
    return { entries: new Map(), invalid: [{ id: "(file)", reason: `unreadable registry: ${String(code)}` }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { entries: new Map(), invalid: [{ id: "(file)", reason: `invalid JSON: ${(e as Error).message}` }] };
  }
  if (!isPlainObject(parsed)) {
    return { entries: new Map(), invalid: [{ id: "(file)", reason: "registry must be a JSON object" }] };
  }
  if (parsed.version !== 1) {
    return { entries: new Map(), invalid: [{ id: "(file)", reason: `unsupported registry version ${String(parsed.version)} (expected 1)` }] };
  }
  if (!isPlainObject(parsed.providers)) {
    return { entries: new Map(), invalid: [{ id: "(file)", reason: "registry \"providers\" must be an object" }] };
  }
  const entries = new Map<string, UserProviderConfig>();
  const invalid: { id: string; reason: string }[] = [];
  for (const id of Object.keys(parsed.providers)) {
    const r = validateUserProviderEntry(id, parsed.providers[id]);
    if (r.ok) entries.set(id, r.value);
    else invalid.push({ id, reason: r.reason });
  }
  return { entries, invalid };
}

/** Atomically write the registry (tmp + rename, 0600 — same shape as the
 *  global settings writer). Creates the parent directory when missing. */
export function writeProviderRegistrySync(path: string, file: ProviderRegistryFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

/** 反馈① 收口 (2026-08-29 夜): fill an overlay row's empty contextLength
 *  from the compiled pin for the SAME name. The overlay owns catalog
 *  membership; the empty field inherits (never shadows) the doc-verified
 *  window. Rows with an explicit value, and names the compiled catalog
 *  never pinned, pass through untouched. 借鉴弧 B1：prices 同规则继承（builtin
 *  今天不钉价——机制对称，未来文档核实的 pin 免被 replace-with-empty 遮蔽）。Pure. */
function inheritBuiltinPins(
  overlayModels: readonly ProviderModelEntry[],
  baseModels: readonly ProviderModelEntry[] | undefined,
): ProviderModelEntry[] {
  if (baseModels === undefined || baseModels.length === 0) return [...overlayModels];
  const pins = new Map<string, number>();
  const pricePins = new Map<string, ModelPrices>();
  for (const m of baseModels) {
    if (m.contextLength !== undefined) pins.set(m.name, m.contextLength);
    if (m.prices !== undefined) pricePins.set(m.name, m.prices);
  }
  if (pins.size === 0 && pricePins.size === 0) return [...overlayModels];
  return overlayModels.map((m) => {
    if (m.contextLength !== undefined && m.prices !== undefined) return m;
    return {
      ...m,
      ...(m.contextLength === undefined && pins.get(m.name) !== undefined ? { contextLength: pins.get(m.name) } : {}),
      ...(m.prices === undefined && pricePins.get(m.name) !== undefined ? { prices: pricePins.get(m.name) } : {}),
    };
  });
}

/** Merge validated user entries onto the compiled-in profiles:
 *  - builtin ids always present; an entry for one overlays field-by-field
 *    (`overlay ?? base`, the FULL profile surface — reasoning fields included);
 *  - other ids become customs (requiresBaseUrl pinned true; the entry's
 *    baseUrl becomes defaultBaseUrl; reasoningFormat defaults to "none").
 *  `models` on an overlay REPLACES the builtin catalog wholesale (the
 *  builtins' own doc-verified context pins included); the builtin
 *  defaultModel never joins it. A custom entry without a baseUrl
 *  is defensively skipped — read-time validation is what reports it. */
export function effectiveProfiles(
  userEntries: ReadonlyMap<string, UserProviderConfig>,
): ReadonlyMap<string, EffectiveProfile> {
  const out = new Map<string, EffectiveProfile>();
  for (const name of Object.keys(PROVIDER_PROFILES) as readonly BuiltinProviderName[]) {
    const base = PROVIDER_PROFILES[name];
    const overlay = userEntries.get(name);
    if (overlay === undefined) {
      // 反馈① 收口: the builtin's own doc-verified context pins ride along
      // (deepseek v4 line 1M / glm-4.6 204_800 / qwen3-max 262_144 — see
      // PROVIDER_PROFILES); builtins without pins keep the historical [].
      out.set(name, { ...base, models: base.models ?? [], custom: false });
      continue;
    }
    const merged: EffectiveProfile = {
      ...base,
      ...(overlay.label !== undefined ? { label: overlay.label } : {}),
      ...(overlay.baseUrl !== undefined ? { defaultBaseUrl: overlay.baseUrl } : {}),
      ...(overlay.defaultModel !== undefined ? { defaultModel: overlay.defaultModel } : {}),
      ...(overlay.requiresBaseUrl !== undefined ? { requiresBaseUrl: overlay.requiresBaseUrl } : {}),
      ...(overlay.reasoningFormat !== undefined ? { reasoningFormat: overlay.reasoningFormat } : {}),
      ...(overlay.thinkingLevelMap !== undefined ? { thinkingLevelMap: overlay.thinkingLevelMap } : {}),
      ...(overlay.supportsReasoningEffort !== undefined ? { supportsReasoningEffort: overlay.supportsReasoningEffort } : {}),
      ...(overlay.acceptsReasoningOnlyFinish !== undefined ? { acceptsReasoningOnlyFinish: overlay.acceptsReasoningOnlyFinish } : {}),
      ...(overlay.windowMode !== undefined ? { windowMode: overlay.windowMode } : {}),
      // 0.3.13 (#215): the protocol column overlays like any profile fact —
      // an overlay's wire beats the builtin's compiled-in one (the anthropic
      // builtin pins "anthropic"; a hand-set overlay wire on another builtin
      // reroutes its adapter).
      ...(overlay.wire !== undefined ? { wire: overlay.wire } : {}),
      // P0-4 (96 队列): the wallet-balance endpoint overlays the same way —
      // an overlay's explicit balanceUrl beats the builtin pin (a gateway
      // fronting deepseek points the balance face at itself).
      ...(overlay.balanceUrl !== undefined ? { balanceUrl: overlay.balanceUrl } : {}),
      // ω99-64 (controller ruling §2): the endpoint's transport-layer header
      // baseline folds through the same overlay seam as wire/balanceUrl —
      // an overlay's headers land on the EffectiveProfile (builtins carry
      // none today; "仅 overlay 定义时；builtin 不携带") and ride to
      // resolveProviderConfigResult as ProviderConfig.extraHeaders. Zero new
      // plumbing: the existing `providers` map already reaches resolution.
      ...(overlay.headers !== undefined ? { headers: overlay.headers } : {}),
      ...(overlay.defaultContextLength !== undefined ? { defaultContextLength: overlay.defaultContextLength } : {}),
      // The catalog-escape column folds onto the effective view
      // (overlay-beats-derived, wholesale).
      ...(overlay.efforts !== undefined ? { efforts: overlay.efforts } : {}),
      // 反馈① 收口: an overlay models list still REPLACES the builtin
      // catalog wholesale — declaring models on a builtin defines YOUR
      // catalog's MEMBERSHIP; names you drop take their pins with them.
      // But an overlay row with an EMPTY contextLength INHERITS the
      // compiled pin for that name (a card saved pre-pins echoes bare
      // names via the /models pull — replace-with-empty must not shadow
      // the doc-verified window for a model the user never pinned; empty
      // field = inherit, the edit form's own rule).
      models: overlay.models === undefined
        ? (base.models ?? [])
        : inheritBuiltinPins(overlay.models, base.models),
      custom: false,
    };
    out.set(name, merged);
  }
  for (const [id, cfg] of userEntries) {
    if (out.has(id)) continue; // builtin overlay, handled above
    if (cfg.baseUrl === undefined || cfg.baseUrl === "") continue; // defensive; read-time validation reports it
    const profile: EffectiveProfile = {
      label: cfg.label ?? id,
      defaultBaseUrl: cfg.baseUrl,
      defaultModel: cfg.defaultModel ?? "",
      requiresBaseUrl: true,
      reasoningFormat: cfg.reasoningFormat ?? "none",
      ...(cfg.thinkingLevelMap !== undefined ? { thinkingLevelMap: cfg.thinkingLevelMap } : {}),
      ...(cfg.supportsReasoningEffort !== undefined ? { supportsReasoningEffort: cfg.supportsReasoningEffort } : {}),
      ...(cfg.acceptsReasoningOnlyFinish !== undefined ? { acceptsReasoningOnlyFinish: cfg.acceptsReasoningOnlyFinish } : {}),
      ...(cfg.windowMode !== undefined ? { windowMode: cfg.windowMode } : {}),
      // 0.3.13 (#215): the custom's own protocol — absent stays absent (the
      // dispatch default openai-chat materializes at createProvider, keeping
      // wire-less customs byte-identical to the historical shape).
      ...(cfg.wire !== undefined ? { wire: cfg.wire } : {}),
      // P0-4 (96 队列): the custom's own wallet-balance endpoint — absent
      // stays absent (no balance face, the silent-omit state).
      ...(cfg.balanceUrl !== undefined ? { balanceUrl: cfg.balanceUrl } : {}),
      // ω99-64: the custom's own transport-layer header baseline — absent
      // stays absent (nothing extra on the wire, byte-identical).
      ...(cfg.headers !== undefined ? { headers: cfg.headers } : {}),
      ...(cfg.defaultContextLength !== undefined ? { defaultContextLength: cfg.defaultContextLength } : {}),
      // The custom's own catalog override rides the same way.
      ...(cfg.efforts !== undefined ? { efforts: cfg.efforts } : {}),
      models: cfg.models ?? [],
      custom: true,
    };
    out.set(id, profile);
  }
  return out;
}

/** The context-window resolution chain (§7): the model's registered
 *  contextLength, else the provider's default, else the caller-supplied env
 *  value (already resolved: WUDAO_CONTEXT_WINDOW ?? 200_000). Pure — no fs, no
 *  env reads of its own. */
export function resolveContextWindowTokens(
  profiles: ReadonlyMap<string, EffectiveProfile>,
  providerId: string,
  model: string,
  envValue: number,
): number {
  // P0 修复（09-27 集成测试）：WUDAO_CONTEXT_WINDOW 显式设置时覆盖
  // registry 目录——此前 catalog 优先级更高，20K 测试窗口被 DeepSeek 的
  // 1M catalog 吞掉，压缩永远不触发。显式 env > 目录 > env 缺省。
  if (process.env.WUDAO_CONTEXT_WINDOW !== undefined) {
    const v = Number(process.env.WUDAO_CONTEXT_WINDOW);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const profile = profiles.get(providerId);
  return profile?.models.find((m) => m.name === model)?.contextLength
    ?? profile?.defaultContextLength
    ?? envValue;
}
