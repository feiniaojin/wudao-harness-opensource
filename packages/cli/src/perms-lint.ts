// M52 §2 — the permission-rule linter (CCB + CC 双源). A PURE function over
// the settings `permissions` node: it detects unreachable rules — rules that
// can never decide a call because something earlier in the layer order always
// matches first. Report-only (no auto-fix; the fix text is advice).
//
// Layer order it models (permission.ts decideRichPermission):
//   1. settings deny   — first match wins, outranks everything
//   4a. settings ask   — checked BEFORE allow, first match wins
//   4b. settings allow — first match wins
// A rule is unreachable when an earlier rule COVERS its scope: same tool, and
// the earlier rule's scope is the whole tool or a prefix (path-prefix at a
// directory boundary, or command-token prefix on the shell lane) of the
// later rule's scope — exactly the scopes ruleMatches accepts.
//
// 波次 7 #32: `tool:glob:<pattern>` rules are conservatively EXEMPT from
// shadow analysis — a glob's coverage of another rule's scope is not decidable
// by prefix comparison, so the linter reports only what it can prove (a bare
// whole-tool rule still shadows a later glob rule of the same tool, which
// parseRule handles with no glob awareness needed).
//
// Team note (shared-vs-personal semantics deliberately left here as a
// comment, per spec): a shadowed rule in a SHARED .wudao/settings.json is a
// team trap — the person who added it believed they granted/denied something,
// but the earlier rule silently wins for everyone. Personal overrides
// (session `a` answers) are ephemeral and never linted.
//
// M58-C carried-over fix (M57 re-review): the lint models the two-tier UNION
// (what the gate consumes), but findings used to label every rule
// ".wudao/settings.json" — a GLOBAL-tier rule was reported under the project
// filename, sending the fixer to the wrong file. Findings now carry per-rule
// tier attribution: `file` names the settings file that actually CONTAINS the
// dead rule, `shadowFile` the file containing the winner. Semantics of the
// lint itself are unchanged (the union is still what decides calls).
import type { PermissionSettings } from "./permission.js";
import { normalizePath } from "./permission.js";

/** Why the rule can never fire. */
export type LintKind = "shadowed-earlier" | "deny-first" | "ask-first";

/** Display path of the project tier's settings file. */
export const PROJECT_SETTINGS_DISPLAY = ".wudao/settings.json";

/** Per-tier attribution input (from loadPermissionTiers). */
export interface LintTiers {
  /** The GLOBAL tier's parsed node (~/.wudao/settings.json). */
  readonly global: PermissionSettings;
  /** The PROJECT tier's parsed node (.wudao/settings.json). */
  readonly project: PermissionSettings;
  /** Display path of the global tier's file (e.g. ~/.wudao/settings.json resolved). */
  readonly globalFile: string;
}

export interface LintFinding {
  /** The dead rule, verbatim. */
  readonly rule: string;
  /** Which list it lives in. */
  readonly layer: "allow" | "ask";
  /** The rule that always wins instead. */
  readonly shadowedBy: string;
  readonly kind: LintKind;
  /** One-line advice (report-only — nothing is rewritten automatically). */
  readonly fix: string;
  /** M58-C — the settings file that actually contains the DEAD rule (absent
   *  for pre-tier callers: the legacy single-file label is used then). */
  readonly file?: string;
  /** M58-C — the file containing the winning rule. Absent alongside `file`. */
  readonly shadowFile?: string;
}

interface RuleScope {
  readonly tool: string;
  /** Undefined = the whole tool. */
  readonly suffix?: string;
}

function parseRule(rule: string): RuleScope {
  const trimmed = rule.trim();
  const colon = trimmed.indexOf(":");
  const tool = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const suffix = colon === -1 || colon === trimmed.length - 1 ? undefined : trimmed.slice(colon + 1);
  return { tool, suffix };
}

/** Does scope A COVER scope B (every call B would match, A matches first)?
 *  Mirrors ruleMatches: same tool; A unscoped covers all; otherwise A's
 *  suffix must be a path-prefix at a directory boundary of B's suffix, or a
 *  command-token prefix of it. */
function scopeCovers(a: RuleScope, b: RuleScope): boolean {
  if (a.tool === "" || a.tool !== b.tool) return false;
  if (a.suffix === undefined) return true;
  if (b.suffix === undefined) return false; // B is tool-wide, A is scoped
  const ap = normalizePath(a.suffix);
  const bp = normalizePath(b.suffix);
  if (ap !== "" && (bp === ap || bp.startsWith(`${ap}/`))) return true;
  // Command lane (shell): token-boundary prefix, mirroring ruleMatches.
  const at = a.suffix.trim().split(/\s+/);
  const bt = b.suffix.trim().split(/\s+/);
  return at.length <= bt.length && at.every((t, i) => t === bt[i]);
}

/** Lint the settings permissions node (the two-tier UNION the gate consumes).
 *  Pure — no I/O, no mutation. With `tiers`, each finding is attributed to
 *  the file that actually contains its rule (M58-C fix). */
export function lintPermissionRules(settings: PermissionSettings, tiers?: LintTiers): readonly LintFinding[] {
  const findings: LintFinding[] = [];
  // M58-C: which tier's file contains `rule` in `list` — the union dedups
  // exact strings, so "present in both" is attributed to both files.
  const fileOf = (rule: string, list: "allow" | "deny" | "ask"): string | undefined => {
    if (tiers === undefined) return undefined;
    const inGlobal = tiers.global[list].includes(rule);
    const inProject = tiers.project[list].includes(rule);
    if (inGlobal && inProject) return `${tiers.globalFile} + ${PROJECT_SETTINGS_DISPLAY}`;
    if (inGlobal) return tiers.globalFile;
    return PROJECT_SETTINGS_DISPLAY;
  };
  const rulesOf = (list: readonly string[], layer: "allow" | "ask"): void => {
    for (let i = 0; i < list.length; i += 1) {
      const rule = list[i];
      if (rule === undefined) continue;
      const scope = parseRule(rule);
      // Same-layer earlier rules (first match wins inside the list).
      let shadowed: { by: string; kind: LintKind } | undefined;
      for (let j = 0; j < i; j += 1) {
        const earlier = list[j];
        if (earlier === undefined) continue;
        if (scopeCovers(parseRule(earlier), scope)) {
          shadowed = { by: earlier, kind: "shadowed-earlier" };
          break;
        }
      }
      // Layer 1 deny outranks every allow/ask.
      if (shadowed === undefined) {
        for (const d of settings.deny) {
          if (scopeCovers(parseRule(d), scope)) {
            shadowed = { by: d, kind: "deny-first" };
            break;
          }
        }
      }
      // The ask list is checked BEFORE the allow list: a matching ask
      // neutralizes any allow rule it covers (the human decides, the allow
      // never silently applies).
      if (shadowed === undefined && layer === "allow") {
        for (const ask of settings.ask) {
          if (scopeCovers(parseRule(ask), scope)) {
            shadowed = { by: ask, kind: "ask-first" };
            break;
          }
        }
      }
      if (shadowed !== undefined) {
        // The winner's home list: same layer for same-layer shadowing, the
        // deny list for deny-first, the ask list for ask-first.
        const winnerList: "allow" | "deny" | "ask" =
          shadowed.kind === "deny-first" ? "deny" : shadowed.kind === "ask-first" ? "ask" : layer;
        findings.push({
          rule,
          layer,
          shadowedBy: shadowed.by,
          kind: shadowed.kind,
          ...(tiers !== undefined
            ? { file: fileOf(rule, layer), shadowFile: fileOf(shadowed.by, winnerList) }
            : {}),
          fix:
            shadowed.kind === "deny-first"
              ? `delete "${rule}" or narrow the deny rule "${shadowed.by}" — the deny always wins`
              : shadowed.kind === "ask-first"
                ? `delete "${rule}" or narrow the ask rule "${shadowed.by}" — the ask always runs first`
                : `delete "${rule}" or narrow the earlier rule "${shadowed.by}" that already covers it`,
        });
      }
    }
  };
  rulesOf(settings.allow, "allow");
  rulesOf(settings.ask, "ask");
  return findings;
}

/** Human-facing report (the `wudao perms lint` stdout). `scope` (the global
 *  tier's file path) switches to tier-attributed rendering; without it the
 *  legacy single-file strings are byte-identical to the pre-M58 form. */
export function formatLintReport(findings: readonly LintFinding[], scope?: { readonly globalFile: string }): string {
  if (findings.length === 0) {
    return scope === undefined
      ? "permissions: no unreachable rules (.wudao/settings.json)"
      : `permissions: no unreachable rules (union of ${scope.globalFile} and ${PROJECT_SETTINGS_DISPLAY})`;
  }
  const lines = [
    scope === undefined
      ? `permissions: ${findings.length} unreachable rule(s) in .wudao/settings.json:`
      : `permissions: ${findings.length} unreachable rule(s) in the global+project permission union:`,
  ];
  for (const f of findings) {
    lines.push(scope === undefined || f.file === undefined ? `  ${f.layer}  ${f.rule}` : `  ${f.layer}  ${f.rule}  (${f.file})`);
    lines.push(
      scope !== undefined && f.shadowFile !== undefined
        ? `    shadowed by ${f.shadowedBy} (${f.kind}, in ${f.shadowFile}) — ${f.fix}`
        : `    shadowed by ${f.shadowedBy} (${f.kind}) — ${f.fix}`,
    );
  }
  lines.push("  (report-only — nothing was changed; shared-file changes affect the whole team)");
  return lines.join("\n");
}
