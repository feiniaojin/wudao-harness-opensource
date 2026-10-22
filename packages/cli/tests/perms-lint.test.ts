// M52 §2 — the permission-rule linter (pure): unreachable rules in
// .wudao/settings.json permissions — shadowed by an earlier same-layer rule
// of the same tool/prefix, or killed by the deny-first layer.
// M58-C — per-rule tier attribution: findings name the file that actually
// CONTAINS the rule (global ~/.wudao/settings.json vs project
// .wudao/settings.json) instead of labeling everything with the project path.
import { describe, it, expect } from "vitest";
import { lintPermissionRules, formatLintReport, PROJECT_SETTINGS_DISPLAY, type LintTiers } from "../src/perms-lint.js";
import { unionPermissionTiers, type PermissionSettings } from "../src/permission.js";

const settings = (allow: string[], deny: string[] = [], ask: string[] = []): PermissionSettings => ({ allow, deny, ask, sidecarExempt: [] }); // ω99-27: fourth list (empty everywhere here)

describe("lintPermissionRules (M52 §2)", () => {
  it("reports nothing for clean settings", () => {
    expect(lintPermissionRules(settings(["read_file", "write_file:src/a.ts"], ["shell:rm -rf /"]))).toEqual([]);
    expect(lintPermissionSettingsEmpty()).toEqual([]);
  });

  it("same-layer earlier tool-wide rule shadows a later scoped rule", () => {
    const out = lintPermissionRules(settings(["write_file", "write_file:src/a.ts"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.rule).toBe("write_file:src/a.ts");
    expect(out[0]?.shadowedBy).toBe("write_file");
    expect(out[0]?.kind).toBe("shadowed-earlier");
    expect(out[0]?.layer).toBe("allow");
    expect(out[0]?.fix).toContain("delete");
  });

  it("same-layer earlier path-prefix rule shadows a deeper rule (boundary-safe)", () => {
    const out = lintPermissionRules(settings(["write_file:src", "write_file:src/a.ts"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.rule).toBe("write_file:src/a.ts");
    // a SIBLING prefix must NOT count as coverage
    expect(lintPermissionRules(settings(["write_file:src", "write_file:src2/x.ts"]))).toEqual([]);
  });

  it("command-prefix coverage on the shell lane (token-boundary)", () => {
    const out = lintPermissionRules(settings(["shell:rm", "shell:rm -rf x"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.rule).toBe("shell:rm -rf x");
    expect(out[0]?.shadowedBy).toBe("shell:rm");
    // `rmlint` is NOT covered by `rm` (token boundary)
    expect(lintPermissionRules(settings(["shell:rm", "shell:rmlint"]))).toEqual([]);
  });

  it("deny-first: a deny rule kills matching allow AND ask rules", () => {
    const out = lintPermissionRules(settings(["write_file:build/out.js"], ["write_file:build", "edit:prod"], ["edit:prod/deep.ts"]));
    const allowFinding = out.find((f) => f.rule === "write_file:build/out.js");
    const askFinding = out.find((f) => f.rule === "edit:prod/deep.ts");
    expect(allowFinding?.kind).toBe("deny-first");
    expect(allowFinding?.shadowedBy).toBe("write_file:build");
    expect(askFinding?.kind).toBe("deny-first");
    expect(askFinding?.layer).toBe("ask");
    // the fix names the deny, not the dead rule
    expect(allowFinding?.fix).toContain("deny");
  });

  it("a tool-wide deny kills every same-tool allow/ask rule", () => {
    const out = lintPermissionRules(settings(["shell:npm test", "shell:git status"], ["shell"]));
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.kind === "deny-first" && f.shadowedBy === "shell")).toBe(true);
  });

  it("ask-first: a matching ask rule neutralizes a later allow rule", () => {
    const out = lintPermissionRules(settings(["edit"], [], ["edit"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.rule).toBe("edit");
    expect(out[0]?.layer).toBe("allow");
    expect(out[0]?.kind).toBe("ask-first");
    expect(out[0]?.shadowedBy).toBe("edit");
  });

  it("duplicate rules are reported as shadowed", () => {
    const out = lintPermissionRules(settings(["read_file:src", "read_file:src"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.rule).toBe("read_file:src");
    expect(out[0]?.shadowedBy).toBe("read_file:src");
  });

  it("within the ask layer, an earlier ask shadows a later ask", () => {
    const out = lintPermissionRules(settings([], [], ["shell", "shell:git status"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.layer).toBe("ask");
    expect(out[0]?.kind).toBe("shadowed-earlier");
  });

  it("normalizePath-equivalent rules still shadow (no . / .. dodge)", () => {
    const out = lintPermissionRules(settings(["write_file:src", "write_file:./src/deep/file.ts"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.rule).toBe("write_file:./src/deep/file.ts");
  });
});

function lintPermissionSettingsEmpty(): ReturnType<typeof lintPermissionRules> {
  return lintPermissionRules({ allow: [], deny: [], ask: [], sidecarExempt: [] });
}

// ---------------------------------------------------------------------------
// M58-C — tier attribution (the two-tier union with per-rule file naming)
// ---------------------------------------------------------------------------

const GLOBAL_FILE = "/home/tester/.wudao/settings.json";
const tiersOf = (global: PermissionSettings, project: PermissionSettings): LintTiers & { readonly effective: PermissionSettings } => ({
  global,
  project,
  globalFile: GLOBAL_FILE,
  effective: unionPermissionTiers(global, project),
});

describe("lintPermissionRules tier attribution (M58-C)", () => {
  it("a shadowing GLOBAL rule is attributed to the global file — the project filename never takes the blame", () => {
    // Union order (global first): the tool-wide GLOBAL allow shadows the
    // scoped PROJECT allow that follows it — the project admin's narrower
    // rule can never fire, and the fix must point at the GLOBAL file.
    const t = tiersOf(settings(["write_file"]), settings(["write_file:src/a.ts"]));
    const out = lintPermissionRules(t.effective, t);
    expect(out).toHaveLength(1);
    expect(out[0]?.rule).toBe("write_file:src/a.ts");
    expect(out[0]?.kind).toBe("shadowed-earlier");
    // the dead rule lives in the PROJECT file; the WINNER lives in the global
    expect(out[0]?.file).toBe(PROJECT_SETTINGS_DISPLAY);
    expect(out[0]?.shadowFile).toBe(GLOBAL_FILE);
  });

  it("a rule present ONLY in the global tier: a global deny killing a project allow names the global file", () => {
    const t = tiersOf(settings([], ["shell"]), settings(["shell:npm test"]));
    const out = lintPermissionRules(t.effective, t);
    expect(out).toHaveLength(1);
    expect(out[0]?.rule).toBe("shell:npm test");
    expect(out[0]?.kind).toBe("deny-first");
    expect(out[0]?.file).toBe(PROJECT_SETTINGS_DISPLAY);
    expect(out[0]?.shadowFile).toBe(GLOBAL_FILE);
  });

  it("a DEAD rule that lives only in the global tier is reported under the global file", () => {
    // global allow has both entries; the project tier is empty.
    const t = tiersOf(settings(["edit", "edit:src/a.ts"]), settings([]));
    const out = lintPermissionRules(t.effective, t);
    expect(out).toHaveLength(1);
    expect(out[0]?.rule).toBe("edit:src/a.ts");
    expect(out[0]?.file).toBe(GLOBAL_FILE);
    expect(out[0]?.shadowFile).toBe(GLOBAL_FILE);
  });

  it("an identical rule in BOTH tiers attributes to both files (the union dedups it)", () => {
    const t = tiersOf(
      settings(["read_file:src"], ["read_file:src"]),
      settings(["read_file:src"]),
    );
    const out = lintPermissionRules(t.effective, t);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("deny-first");
    expect(out[0]?.file).toBe(`${GLOBAL_FILE} + ${PROJECT_SETTINGS_DISPLAY}`);
  });

  it("without tiers the findings carry no file fields (legacy pure-call shape)", () => {
    const out = lintPermissionRules(settings(["write_file", "write_file:src/a.ts"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.file).toBeUndefined();
    expect(out[0]?.shadowFile).toBeUndefined();
  });
});

describe("formatLintReport tier rendering (M58-C)", () => {
  it("tier scope names the containing file per finding, including cross-tier winners", () => {
    const t = tiersOf(settings([], ["shell"]), settings(["shell:npm test"]));
    const report = formatLintReport(lintPermissionRules(t.effective, t), { globalFile: GLOBAL_FILE });
    expect(report).toContain("unreachable rule(s) in the global+project permission union:");
    expect(report).toContain(`shell:npm test  (${PROJECT_SETTINGS_DISPLAY})`);
    expect(report).toContain(`shadowed by shell (deny-first, in ${GLOBAL_FILE})`);
    expect(report).toContain("shared-file changes affect the whole team");
  });

  it("empty findings under tier scope name the union, not the project file alone", () => {
    const t = tiersOf(settings(["read_file"]), settings(["write_file"]));
    const report = formatLintReport(lintPermissionRules(t.effective, t), { globalFile: GLOBAL_FILE });
    expect(report).toBe(`permissions: no unreachable rules (union of ${GLOBAL_FILE} and ${PROJECT_SETTINGS_DISPLAY})`);
  });

  it("legacy rendering (no scope) stays byte-identical to the pre-M58 form", () => {
    expect(formatLintReport([])).toBe("permissions: no unreachable rules (.wudao/settings.json)");
    const legacy = formatLintReport(lintPermissionRules(settings(["write_file", "write_file:src/a.ts"])));
    expect(legacy).toContain("unreachable rule(s) in .wudao/settings.json:");
    expect(legacy).toContain("  allow  write_file:src/a.ts\n");
    expect(legacy).toContain("shadowed by write_file (shadowed-earlier) — ");
    expect(legacy).not.toContain(GLOBAL_FILE);
  });
});
