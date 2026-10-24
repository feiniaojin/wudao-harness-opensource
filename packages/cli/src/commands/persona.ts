// packages/cli/src/commands/persona.ts — /persona 的纯函数层（spec §6）。
// 设计对位：/model 的 commands/model.ts（解析→校验→应用→记录）——REPL 处
// 理器只做薄壳。persona 切换是 PersonaRuntime.current 的字段替换（次轮生
// 效、无 client 重建——/model 先例，非 /provider 先例）。
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao/core";
import type { GenericSessionEntry } from "@wudao/core";
import { lookupPersona, parsePersonaSpec, resolvePersona } from "@wudao/providers";
import type { LayerFlags, PersonaRegistry, PersonaRuntime, ResolvedPersona } from "@wudao/providers";

export type PersonaArgument =
  | { kind: "list" }
  | { kind: "off" }
  | { kind: "switch"; id: string; flag?: "--headers-only" | "--with-prompt" }
  | { ok: false; error: string };

const FLAGS = ["--headers-only", "--with-prompt"] as const;

export function parsePersonaArgument(rest: string): PersonaArgument {
  const tokens = rest.trim().split(/\s+/).filter((t) => t !== "");
  // Indexed-access lookups don't narrow across statements — destructure and
  // guard the head once (noUncheckedIndexedAccess).
  const [first, ...restTokens] = tokens;
  if (first === undefined) return { kind: "list" };
  if (first === "--off" || first === "off") {
    return restTokens.length === 0 ? { kind: "off" } : { ok: false, error: `/persona --off takes no arguments (got: ${restTokens.join(" ")})` };
  }
  if (first.startsWith("--")) {
    return { ok: false, error: `unknown flag ${first} — /persona [<id> ${FLAGS.join("|")}] | --off` };
  }
  const [maybeFlag, ...extra] = restTokens;
  if (maybeFlag !== undefined && !(FLAGS as readonly string[]).includes(maybeFlag)) {
    return { ok: false, error: `unknown flag ${maybeFlag} — /persona [<id> ${FLAGS.join("|")}] | --off` };
  }
  if (extra.length > 0) return { ok: false, error: `/persona takes one id and at most one flag (got: ${rest})` };
  return { kind: "switch", id: first, ...(maybeFlag !== undefined ? { flag: maybeFlag as "--headers-only" | "--with-prompt" } : {}) };
}

export function layerOverrideFor(flag: "--headers-only" | "--with-prompt" | undefined): Partial<LayerFlags> | undefined {
  // Fix round 1（spec §10.1 mask 语义）：effectiveLayers 把显式层集当**完整
  // 启用集**（不再叠加缺省），旗标因此直接携带完整集——--with-prompt = 缺省
  // 三元组 + prompt，对无 defaultLayers 的 persona（含全部内置）与历史 overlay
  // 结果逐字节一致。
  if (flag === "--headers-only") return { headers: true, body: false, prompt: false };
  if (flag === "--with-prompt") return { headers: true, body: true, prompt: true };
  return undefined;
}

export function resolvePersonaSwitch(
  registry: PersonaRegistry, id: string, flag?: "--headers-only" | "--with-prompt",
): { ok: true; resolved: ResolvedPersona } | { ok: false; error: string } {
  const def = lookupPersona(registry, id);
  if (def === undefined) {
    const known = registry.personas.map((e) => e.id).join(", ");
    return { ok: false, error: `unknown persona "${id}" — known: ${known === "" ? "(none)" : known}` };
  }
  return { ok: true, resolved: resolvePersona(def, layerOverrideFor(flag)) };
}

export function resolveBootstrapPersona(
  registry: PersonaRegistry,
  config: { readonly persona?: { readonly id: string; readonly layers?: Partial<LayerFlags> } },
): { ok: true; resolved: ResolvedPersona | null } | { ok: false; error: string } {
  if (config.persona === undefined) return { ok: true, resolved: null };
  const def = lookupPersona(registry, config.persona.id);
  if (def === undefined) {
    return { ok: false, error: `WUDAO_PERSONA/config persona "${config.persona.id}" is not in the registry — starting bare (fix the id or the persona file)` };
  }
  return { ok: true, resolved: resolvePersona(def, config.persona.layers) };
}

/** M24 纪律对齐（spec §4 层3）：任一侧 prompt 层生效，system 前缀就变了。 */
export function personaSwitchBreaksCache(oldP: ResolvedPersona | null, newP: ResolvedPersona | null): boolean {
  return (oldP?.layers.prompt ?? false) || (newP?.layers.prompt ?? false);
}

export const PERSONA_SWITCH_CACHE_NOTE =
  "⚠️ prompt 层改变了 system 前缀——下一个请求完全变冷（persona 缓存断裂，已归因到会话记录）"; // ω99-166f-ii: #22

const layersList = (l: LayerFlags): string[] =>
  (["headers", "body", "prompt"] as const).filter((k) => l[k]);

export async function recordPersonaChange(args: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly to: {
    readonly id: string | null;
    readonly layers: LayerFlags;
    /** SDD 2026-08-23 layer-selection Task 1（additive，可选）：生效的限定引
     * 用（`<id>:<层集>`，如 `claude-code:headers`）——胜出腿带层限定时由链
     * 解析带上；纯 id/手动切换无此键（历史记录形状不变）。 */
    readonly spec?: string;
  };
  readonly from?: { readonly id: string | null };
  readonly coldTurnExpected: boolean;
  /** 变更动因（additive，可选）：manual=用户 /persona 切换；provider-switch=随供应商绑定生效；off=显式关。 */
  readonly reason?: "manual" | "provider-switch" | "off";
  readonly now?: Date;
}): Promise<void> {
  const store = createJsonlSessionStore(join(args.workspaceRoot, ".wudao", "sessions"));
  const on = layersList(args.to.layers);
  const entry: GenericSessionEntry = {
    type: "persona_change",
    data: {
      id: args.to.id,
      layers: on,
      coldTurnExpected: args.coldTurnExpected,
      attribution: `persona:${args.to.id ?? "off"}:${on.length > 0 ? on.join("+") : "off"}`,
      ...(args.to.spec !== undefined ? { spec: args.to.spec } : {}),
      ...(args.from !== undefined ? { from: args.from.id } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      at: (args.now ?? new Date()).toISOString(),
    },
  };
  await store.appendEntry(args.sessionId, entry);
}

export function formatPersonaList(registry: PersonaRegistry, currentId: string | null, provenance?: string): string {
  const rows = registry.personas.map((e) => {
    const mark = e.id === currentId ? ` ← current${provenance !== undefined ? ` [${provenance}]` : ""}` : "";
    const conf = e.confidence !== undefined ? `, ${e.confidence}` : "";
    return `  ${e.id.padEnd(10)} ${e.displayName.padEnd(22)} ${e.source.kind}${conf} [${e.source.pinnedVersion}]${mark}`;
  });
  const head = `personas (${registry.personas.length}; layers: headers/body/prompt; /persona <id> [--headers-only|--with-prompt] | --off)`;
  return rows.length === 0 ? `${head}\n  (none — add <workspace>/.wudao/personas/*.json or ~/.wudao/personas/*.json)` : `${head}\n${rows.join("\n")}`;
}

// —— 解析链（spec §1）：env > binding > default > none，纯函数、resolve-time fail-closed。
// 坏 binding/default 不带病启动——落穿到下一层并带 warning，由调用方决定如何呈现。
// provenance 供 /persona 列表标记与 JSONL 记录归因："manual" 是本层之外的会话内切换。
export type PersonaProvenance = "manual" | "env" | "binding" | "default" | "none";

export interface PersonaChainSources {
  envPersona: ResolvedPersona | null;
  bindingId: string | null | undefined;
  defaultId: string | undefined;
}

/** SDD 2026-08-23 layer-selection Task 1 — resolveActivePersona 的返回。`spec`
 * 仅当胜出腿带层限定（`<id>:layers`）时存在：规范化 `<id>:<层集>`（`+` 连
 * 接、headers/body/prompt 固定序），供 provider-switch 的 persona_change 记
 * 录与 UI 呈现；纯 id 无 spec（与历史逐字节一致）。 */
export interface PersonaChainResolution {
  resolved: ResolvedPersona | null;
  provenance: PersonaProvenance;
  warning?: string;
  spec?: string;
}

/** 一条持久化引用（binding/default 字符串）的解析结果：ok=false 时 `kind`
 * 区分「坏 spec 形状」与「id 不在注册表」，供两腿拼各自措辞（纯 id 的失败
 * 文案与历史逐字节一致）。 */
type PersonaLegOutcome =
  | { ok: true; resolved: ResolvedPersona; spec?: string }
  | { ok: false; kind: "invalid" | "missing"; detail?: string };

const LAYER_ORDER = ["headers", "body", "prompt"] as const;

/** 限定层集 → 规范 spec（`+` 连接、固定层序）——确定性输出，与用户书写顺序无关。 */
const canonicalSpec = (id: string, layers: Partial<LayerFlags>): string =>
  `${id}:${LAYER_ORDER.filter((k) => layers[k] === true).join("+")}`;

/** 解析一条 `id[:layers]` 引用腿：层限定经 resolvePersona/effectiveLayers 生效
 * （spec §10.1 mask——限定列出**完整启用集**，未列出的层关、defaultLayers 不参
 * 与，与 WUDAO_PERSONA 同一语义）；纯 id 走 resolvePersona(def)（与历史逐字
 * 节一致）。 */
const resolvePersonaLeg = (registry: PersonaRegistry, raw: string): PersonaLegOutcome => {
  const parsed = parsePersonaSpec(raw);
  if (!parsed.ok) return { ok: false, kind: "invalid", detail: parsed.error };
  const def = lookupPersona(registry, parsed.id);
  if (def === undefined) return { ok: false, kind: "missing" };
  return {
    ok: true,
    resolved: resolvePersona(def, parsed.layers),
    ...(parsed.layers !== undefined ? { spec: canonicalSpec(parsed.id, parsed.layers) } : {}),
  };
};

export function resolveActivePersona(registry: PersonaRegistry, sources: PersonaChainSources): PersonaChainResolution {
  if (sources.envPersona !== null) return { resolved: sources.envPersona, provenance: "env" };
  if (sources.bindingId === null) return { resolved: null, provenance: "none" };
  if (typeof sources.bindingId === "string") {
    const leg = resolvePersonaLeg(registry, sources.bindingId);
    if (leg.ok) return { resolved: leg.resolved, provenance: "binding", ...(leg.spec !== undefined ? { spec: leg.spec } : {}) };
    const warn = leg.kind === "missing"
      ? `provider persona binding "${sources.bindingId}" is not in the registry — falling through`
      : `provider persona binding "${sources.bindingId}" is invalid: ${leg.detail} — falling through`;
    if (sources.defaultId !== undefined) {
      const d = resolvePersonaLeg(registry, sources.defaultId);
      if (d.ok) return { resolved: d.resolved, provenance: "default", warning: warn, ...(d.spec !== undefined ? { spec: d.spec } : {}) };
      return {
        resolved: null,
        provenance: "none",
        warning: d.kind === "missing"
          ? `${warn}; global default "${sources.defaultId}" also missing`
          : `${warn}; global default "${sources.defaultId}" also invalid: ${d.detail}`,
      };
    }
    return { resolved: null, provenance: "none", warning: warn };
  }
  if (sources.defaultId !== undefined) {
    const d = resolvePersonaLeg(registry, sources.defaultId);
    if (d.ok) return { resolved: d.resolved, provenance: "default", ...(d.spec !== undefined ? { spec: d.spec } : {}) };
    return {
      resolved: null,
      provenance: "none",
      warning: d.kind === "missing"
        ? `global default persona "${sources.defaultId}" is not in the registry — starting bare`
        : `global default persona "${sources.defaultId}" is invalid: ${d.detail} — starting bare`,
    };
  }
  return { resolved: null, provenance: "none" };
}

// —— SDD 2026-08-23 persona Task 3：provider-switch 的链跟随（两个构造缝
// 共用——TUI app.tsx 的 onProviderSwitch.build 与 session-engine 的 build，
// 在重建 client 之前调用）。手动层由调用方先清（driver 的私有标志，经
// DriverPersonaContext.clearManualLayer）；本函数只做纯链解析 +
// runtime.current 字段替换（次轮生效、无 client 重建——/model 先例）+
// 变更/冷标注判定。changed=false 的 no-op 跟随不记录（避免噪音
// persona_change；判据 = id 变化或生效层集变化，名称相同层不同也算切）。
export interface PersonaChainFollow {
  readonly resolved: ResolvedPersona | null;
  readonly provenance: PersonaProvenance;
  readonly warning?: string;
  /** SDD 2026-08-23 layer-selection Task 1：胜出腿带层限定时的生效限定引用
   * （`<id>:<层集>`）——persona_change 记录的 spec 字段来源；纯 id 无此键。 */
  readonly spec?: string;
  /** 跟随前的 persona（record 的 from 侧）。 */
  readonly previous: ResolvedPersona | null;
  /** M24 纪律：任一侧 prompt 层生效 → 下一请求全冷（spec §4 层3）。 */
  readonly breaksCache: boolean;
  /** id 或生效层集发生了变化 → 调用方才 notice + record。 */
  readonly changed: boolean;
}

const sameLayers = (a: LayerFlags | undefined, b: LayerFlags | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return a.headers === b.headers && a.body === b.body && a.prompt === b.prompt;
};

export function applyPersonaChainAfterProviderSwitch(
  runtime: PersonaRuntime, registry: PersonaRegistry, sources: PersonaChainSources,
): PersonaChainFollow {
  const previous = runtime.current;
  const next = resolveActivePersona(registry, sources);
  runtime.current = next.resolved;
  return {
    resolved: next.resolved,
    provenance: next.provenance,
    ...(next.warning !== undefined ? { warning: next.warning } : {}),
    ...(next.spec !== undefined ? { spec: next.spec } : {}),
    previous,
    breaksCache: personaSwitchBreaksCache(previous, next.resolved),
    changed:
      (previous?.definition.id ?? null) !== (next.resolved?.definition.id ?? null)
      || !sameLayers(previous?.layers, next.resolved?.layers),
  };
}

/** 链跟随的用户可见通知（两缝共用同一文案源）：`persona → X (来源)` +
 * 冷标注 + 链上 warning。 */
export function formatPersonaChainFollow(f: PersonaChainFollow): string {
  const via =
    f.provenance === "binding" ? "供应商绑定"
    : f.provenance === "default" ? "全局默认"
    : f.provenance === "env" ? "env"
    : "off"; // ω99-166f-ii: #21（via 三元前两值中文化；env/off 原样）
  return `persona → ${f.resolved?.definition.id ?? "off (bare client)"}（${via}） —— 下一个请求即生效${f.breaksCache ? `\n${PERSONA_SWITCH_CACHE_NOTE}` : ""}${f.warning !== undefined ? `\n⚠️ ${f.warning}` : ""}`;
}
