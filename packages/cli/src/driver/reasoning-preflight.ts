// ω99-245: #7 — 角色化推理能力预检（boot fail-fast，Reasonix
// internal/boot/reasoning_preflight.go 范式）。对每个已配置角色（主对话 /
// 小精灵 / 子代理继承档 / 角色档案钉）解析「有效 effort + 来源」，查能力目录
// （providers 的 effort-catalog）；不过就启动即报错——错误叙事带角色/模型/
// 无效档位/配置来源/支持列表/怎么改，且在任何会话/租约建立之前（不建会话先
// 报）。通过时产出用户可见的健康摘要行（收益向、零实现术语；未验证/降级
// 诚实标注不编造）。纯函数 + 一个可选的首 token 轻量探测（§三，默认关）。
import { REASONING_EFFORTS, supportedEfforts } from "@wudao-org/providers";
import type { EffectiveProfile } from "@wudao-org/providers";
import type { ModelClient, ModelInput } from "@wudao-org/core";
import { readProviderEffortBinding } from "./provider-registry-ops.js";
import { readStoredModelDefaults } from "./settings-ops.js";
import { readGlobalSettingsSync } from "../settings-layer.js";

/** The boot roles the preflight validates. 小精灵（pet lane）共享主对话的
 *  boot 配置（ω99-235 车道即隔离单位——模型配置不是隔离轴），子代理默认
 *  继承会话档（task 工具 requested = 角色钉 ?? 主档 ?? defaultEffort）。 */
export type PreflightSourceKind =
  | "env"
  | "binding"
  | "global"
  | "boot"
  | "builtin-role"
  | "role-pin"
  | "inherit";

export interface PreflightRosterRole {
  readonly id: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** True when the entry is the compiled-in builtin profile (validated but
   *  never listed in the health line — a harness fact, not user config). */
  readonly builtin?: boolean;
}

export interface PreflightRoleFacts {
  readonly role: string;
  readonly provider: string | undefined;
  readonly model: string;
  readonly effort: string | undefined;
  readonly sourceKind: PreflightSourceKind;
  readonly sourceLabel: string;
  /** The how-to-fix line for a failure of THIS role (source-specific). */
  readonly fixLine: string;
  /** The capability catalog resolved this role's (provider, model): false =
   *  未知，降级「未验证」。 */
  readonly catalogKnown: boolean;
  /** This role's (provider, model, effort) equals 主对话's — the probe's
   *  verdict covers it (same request shape). */
  readonly sharesMainTriple: boolean;
  /** An explicit effort exists (user-configured chain leg or role pin). */
  readonly pinned: boolean;
  /** True for the builtin role pins (validated, excluded from the line). */
  readonly builtin: boolean;
  /** The health line shows a segment for this role. */
  readonly listed: boolean;
  /** The line's short label (主对话/小精灵/子代理 keep their names; a role
   *  pin shows the bare role id — 子代理[researcher] is error-narrative
   *  context, the receipt reads「researcher medium」). */
  readonly lineLabel: string;
}

export interface ReasoningPreflightInput {
  readonly config: { readonly provider?: string; readonly model: string; readonly reasoningEffort?: string };
  readonly env?: NodeJS.ProcessEnv;
  readonly roster?: readonly PreflightRosterRole[];
  readonly profiles?: ReadonlyMap<string, EffectiveProfile>;
  /** Seams for tests; the defaults are the real boot reads (the same legs
   *  run.ts's applyStoredModelDefaults folds — see the source matcher). */
  readonly readBinding?: (provider: string, env: NodeJS.ProcessEnv) => string | null | undefined;
  readonly readGlobalDefault?: (env: NodeJS.ProcessEnv) => string | undefined;
}

export type ReasoningPreflightResult =
  | { readonly ok: true; readonly roles: readonly PreflightRoleFacts[] }
  | { readonly ok: false; readonly error: string };

const SOURCE_LABELS: Readonly<Record<PreflightSourceKind, string>> = {
  env: "环境变量 WUDAO_REASONING_EFFORT",
  binding: "供应商绑定（providers.json 的 effort 列）",
  global: "设置里的默认推理档",
  boot: "启动时的模型配置",
  "builtin-role": "内置角色设定",
  "role-pin": "角色档案",
  inherit: "跟随主对话",
};

const FIX_LINES: Readonly<Record<PreflightSourceKind, string>> = {
  env: "改法：把 WUDAO_REASONING_EFFORT 换成上面的可用档位，或去掉它后重启。",
  binding: "改法：编辑 ~/.wudao/providers.json 中该供应商的 effort 列，或用 WUDAO_REASONING_EFFORT 覆盖后重启。",
  global: "改法：在设置里把默认推理档换成可用档位，或设 WUDAO_REASONING_EFFORT 覆盖后重启。",
  boot: "改法：调整启动参数或环境变量里的推理档后重启。",
  "builtin-role": "改法：用 /model 换一个支持该档位的模型，或让该角色少参与本次会话。",
  "role-pin": "改法：把这个角色档案里的 reasoningEffort 改成可用档位，或删掉该字段让它跟随主对话。",
  inherit: "改法：调整主对话的推理档（/effort 或启动配置）后重启。",
};

const sourceLabel = (kind: PreflightSourceKind, roleId?: string): string =>
  kind === "role-pin" && roleId !== undefined ? `角色档案 ${roleId}.json` : SOURCE_LABELS[kind];

const fixLine = (kind: PreflightSourceKind, roleId?: string): string => {
  if (kind === "role-pin" && roleId !== undefined) {
    return `改法：把 ${roleId}.json 里的 reasoningEffort 改成可用档位，或删掉该字段让它跟随主对话。`;
  }
  return FIX_LINES[kind];
};

/** The main effort's source: the FIRST chain leg whose value equals the
 *  resolved effort (the fold run.ts applies: flag/env > binding > global).
 *  A value no leg explains (hand-built config / CLI flag — invisible at this
 *  layer) honestly reads as「启动时的模型配置」. Pure. */
function resolveMainSource(
  input: ReasoningPreflightInput,
): PreflightSourceKind {
  const effort = input.config.reasoningEffort;
  if (effort === undefined) return "inherit";
  const env = input.env ?? process.env;
  const readBinding = input.readBinding ?? ((p, e) => readProviderEffortBinding(p, e));
  const readGlobal = input.readGlobalDefault ?? ((e) => readStoredModelDefaults(readGlobalSettingsSync(e)).effort);
  const envPin = env.WUDAO_REASONING_EFFORT;
  if (envPin !== undefined && envPin !== "" && envPin === effort) return "env";
  const provider = input.config.provider ?? "";
  const binding = provider !== "" ? readBinding(provider, env) : undefined;
  if (binding !== undefined && binding !== null && binding === effort) return "binding";
  const globalDefault = readGlobal(env);
  if (globalDefault !== undefined && globalDefault === effort) return "global";
  return "boot";
}

interface RoleSpec {
  readonly role: string;
  readonly provider: string | undefined;
  readonly model: string;
  readonly effort: string | undefined;
  readonly kind: PreflightSourceKind;
  readonly roleId?: string;
  readonly builtin: boolean;
  readonly pinned: boolean;
  readonly listed: boolean;
}

/** Build the full role inventory: 主对话, 小精灵 (shares the boot config),
 *  子代理 (the inherited default), then every roster entry that pins an
 *  effort or a model (its inherited effort must hold on ITS model too). */
function roleSpecs(input: ReasoningPreflightInput): RoleSpec[] {
  const { provider, model } = input.config;
  const mainEffort = input.config.reasoningEffort;
  const mainKind = resolveMainSource(input);
  const specs: RoleSpec[] = [
    { role: "主对话", provider, model, effort: mainEffort, kind: mainKind, builtin: false, pinned: mainEffort !== undefined, listed: true },
    { role: "小精灵", provider, model, effort: mainEffort, kind: mainKind, builtin: false, pinned: mainEffort !== undefined, listed: true },
    { role: "子代理", provider, model, effort: mainEffort, kind: mainEffort !== undefined ? mainKind : "inherit", builtin: false, pinned: mainEffort !== undefined, listed: true },
  ];
  for (const r of input.roster ?? []) {
    if (r.reasoningEffort === undefined && r.model === undefined && r.provider === undefined) continue; // pure prompt role — nothing effort-shaped to check
    const kind: PreflightSourceKind = r.reasoningEffort !== undefined ? (r.builtin === true ? "builtin-role" : "role-pin") : "inherit";
    specs.push({
      role: `子代理[${r.id}]`,
      provider: r.provider ?? provider,
      model: r.model ?? model,
      effort: r.reasoningEffort ?? mainEffort,
      kind,
      roleId: r.id,
      builtin: r.builtin === true && r.reasoningEffort !== undefined,
      pinned: r.reasoningEffort !== undefined,
      listed: r.reasoningEffort !== undefined && r.builtin !== true && r.reasoningEffort !== mainEffort,
    });
  }
  return specs;
}

const sameTriple = (a: RoleSpec, b: RoleSpec): boolean =>
  a.provider === b.provider && a.model === b.model && a.effort === b.effort;

/** The preflight: resolve every configured role's effective effort, validate
 *  against the capability catalog, and either produce the role facts (for the
 *  health line) or the fail-fast error narrative (verbatim, RoleReasoningError
 *  shape: 角色 + 模型 + 无效档位 + 配置来源 + 支持列表 + 怎么改). Pure. */
export function preflightRoleReasoning(input: ReasoningPreflightInput): ReasoningPreflightResult {
  const specs = roleSpecs(input);
  const main = specs[0] as RoleSpec;
  const facts: PreflightRoleFacts[] = [];
  for (const s of specs) {
    const supported = s.effort !== undefined ? supportedEfforts(s.provider, s.model, input.profiles) : undefined;
    const catalogKnown = s.effort === undefined ? true : supported !== undefined;
    facts.push({
      role: s.role,
      provider: s.provider,
      model: s.model,
      effort: s.effort,
      sourceKind: s.kind,
      sourceLabel: sourceLabel(s.kind, s.roleId),
      fixLine: fixLine(s.kind, s.roleId),
      catalogKnown,
      sharesMainTriple: sameTriple(s, main),
      pinned: s.pinned,
      builtin: s.builtin,
      listed: s.listed,
      lineLabel: s.roleId ?? s.role,
    });
    if (s.effort === undefined) continue; // 默认 — no param on the wire, nothing to validate
    if (!(REASONING_EFFORTS as readonly string[]).includes(s.effort)) {
      return {
        ok: false,
        error:
          `启动预检未过：${s.role} 的推理档「${s.effort}」不是有效档位`
          + `（配置来源：${sourceLabel(s.kind, s.roleId)}；有效档位：${REASONING_EFFORTS.join("、")}）。`
          + fixLine(s.kind, s.roleId),
      };
    }
    if (supported !== undefined && !(supported as readonly string[]).includes(s.effort)) {
      return {
        ok: false,
        error:
          `启动预检未过：${s.role} 的推理档「${s.effort}」不被 ${s.provider}/${s.model} 支持`
          + `（配置来源：${sourceLabel(s.kind, s.roleId)}；该模型可用档位：${supported.join("、")}）。`
          + fixLine(s.kind, s.roleId),
      };
    }
  }
  return { ok: true, roles: facts };
}

/** The session-establishment receipt's health line. 收益向（零实现术语），
 *  形如「推理配置：主对话 high · 小精灵 同主对话 · 子代理 high」；未知目录
 *  （未验证）与探测结论（已验证/未验证）诚实标注。Undefined = 零配置零
 *  噪音（无显式档位、无角色钉、无探测结论时静默）。Pure. */
export function formatReasoningHealthLine(
  roles: readonly PreflightRoleFacts[],
  probe?: "verified" | "unverified",
): string | undefined {
  const listed = roles.filter((r) => r.listed);
  const anyUserPin = roles.some((r) => r.pinned && !r.builtin);
  if (!anyUserPin) return undefined;
  const segment = (r: PreflightRoleFacts): string => {
    let value: string;
    if (r.role === "小精灵") value = r.effort !== undefined ? "同主对话" : "默认";
    else value = r.effort ?? "默认";
    let note = "";
    if (!r.catalogKnown) note = "（未验证）";
    else if (probe !== undefined && r.sharesMainTriple) note = probe === "verified" ? "（已验证）" : "（未验证）";
    return `${r.lineLabel} ${value}${note}`;
  };
  return `推理配置：${listed.map(segment).join(" · ")}`;
}

// ---------------------------------------------------------------------------
// ω99-245 §三 — 首 token 轻量能力探测（可选增强，默认关）。目录会过时，
// 探测不会骗：对主模型发一次极小请求验证 (模型, 档位) 组合真实被端点接受。
// 失败/超时 = 降级「未验证」标注，绝不阻塞会话（探测是增强不是新单点）。
// ---------------------------------------------------------------------------

/** The probe rides the querySource lane (title/btw/summarizer 同款) — the
 *  cache-tracking wrapper keeps it OUT of the main chain's waste attribution. */
export const EFFORT_PROBE_QUERY_SOURCE = "effort-probe";

/** The env knob: WUDAO_EFFORT_PROBE=1|true (default off — boot time budget). */
export function effortProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.WUDAO_EFFORT_PROBE;
  return v === "1" || v === "true";
}

/** One tiny request through the session's model. Verified = the endpoint
 *  accepted the exact request shape the session will use; any throw or the
 *  4s timeout = unverified (never blocks). */
export async function probeReasoningSupport(
  model: ModelClient,
  effort: string,
): Promise<"verified" | "unverified"> {
  const input: ModelInput = {
    systemPrompt: "",
    tools: [],
    messages: [{ role: "user", content: "ping" }],
    maxTokens: 8,
    querySource: EFFORT_PROBE_QUERY_SOURCE,
    reasoningEffort: effort,
  };
  try {
    await Promise.race([
      model.generate(input),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("effort probe timeout")), 4000).unref?.();
      }),
    ]);
    return "verified";
  } catch {
    return "unverified";
  }
}
