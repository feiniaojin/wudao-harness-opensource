import { describe, it, expect } from "vitest";
import {
  loadContracts,
  validateContracts,
  suitesForChangedFiles,
  domainsForSuite,
  regionMatches,
  isForbiddenRoot,
  type ContractsData,
} from "../src/contracts.js";
import { deterministicSuites } from "../src/suites/deterministic.js";

// ω99-10 — the contract coverage guard. contracts.json maps implementation
// regions to the det suites that are their acceptance face; these tests pin
// the four rules (coverage / no dead refs / not both / no package-wide
// roots) and the bidirectional reporter. Bad fixtures are built IN MEMORY
// from the real data (strip one suite, inject a bogus one, ...) so each rule
// provably bites without bad data ever living in contracts.json.

const suiteNames = deterministicSuites.map((s) => s.name);
const real = loadContracts();

/** Drop every trace of one suite from the contracts (keep the whitelist). */
function withoutSuite(data: ContractsData, name: string): ContractsData {
  return {
    contracts: data.contracts
      .map((c) => ({ ...c, suites: c.suites.filter((s) => s !== name) }))
      .filter((c) => c.suites.length > 0),
    unmapped: data.unmapped.filter((u) => u.suite !== name),
  };
}

describe("contracts guard invariants (shipped contracts.json)", () => {
  it("82/82: every det suite is mapped or whitelisted, no dead refs, no forbidden roots", () => {
    expect(suiteNames.length).toBe(82);
    expect(validateContracts(real, suiteNames)).toEqual([]);
  });

  it("every unmapped entry carries a non-empty reason", () => {
    for (const u of real.unmapped) expect(u.reason.trim().length).toBeGreaterThan(0);
  });
});

describe("each invariant bites (in-memory bad fixtures)", () => {
  it("coverage: a suite claimed by no contract and no whitelist goes red", () => {
    const victim = suiteNames.find((n) => !real.unmapped.some((u) => u.suite === n))!;
    const bad = withoutSuite(real, victim);
    const v = validateContracts(bad, suiteNames);
    expect(v.some((x) => x.includes(victim) && x.includes("not covered"))).toBe(true);
  });

  it("dead reference: a contract naming a suite that does not exist goes red", () => {
    const bad: ContractsData = {
      contracts: [...real.contracts, { region: "packages/core/src/loop.ts", suites: ["det-999-ghost"] }],
      unmapped: real.unmapped,
    };
    expect(validateContracts(bad, suiteNames).some((x) => x.includes("dead reference") && x.includes("det-999-ghost"))).toBe(true);
  });

  it("not both: a mapped suite re-listed in the whitelist goes red", () => {
    const bad: ContractsData = {
      contracts: real.contracts,
      unmapped: [...real.unmapped, { suite: "det-33-m48-loop-safety-net", reason: "should not be here" }],
    };
    expect(validateContracts(bad, suiteNames).some((x) => x.includes("both mapped") && x.includes("det-33"))).toBe(true);
  });

  it("forbidden root: packages/<p>/src/** and bare src/ roots go red", () => {
    for (const region of ["packages/core/src/**", "packages/cli/src/", "packages/core", "packages/**"]) {
      const bad: ContractsData = {
        contracts: [...real.contracts, { region, suites: ["det-01-read-file-answer"] }],
        unmapped: real.unmapped,
      };
      expect(validateContracts(bad, suiteNames).some((x) => x.includes("forbidden root") && x.includes(region)), region).toBe(true);
    }
    expect(isForbiddenRoot("packages/core/src/loop.ts")).toBe(false);
  });
});

describe("bidirectional reporter", () => {
  it("implementation -> tests: loop.ts changes yield the loop contract suites", () => {
    const suites = suitesForChangedFiles(["packages/core/src/loop.ts"], real);
    for (const expected of ["det-01-read-file-answer", "det-33-m48-loop-safety-net", "det-69-night-porting-12", "det-78-night-porting-21"]) {
      expect(suites, expected).toContain(expected);
    }
  });

  it("implementation -> tests: compaction.ts changes yield the compaction suites", () => {
    const suites = suitesForChangedFiles(["packages/core/src/compaction.ts"], real);
    for (const expected of ["det-11-compaction-survival", "det-37-m52-compaction-lint-ctx", "det-75-night-porting-18"]) {
      expect(suites, expected).toContain(expected);
    }
  });

  it("directory regions cover files nested under them", () => {
    const suites = suitesForChangedFiles(["packages/cli/src/agents/task-tool.ts"], real);
    expect(suites).toContain("det-18-background-registry");
    expect(regionMatches("packages/cli/src/agents", "packages/cli/src/agents/registry-tools.ts")).toBe(true);
    expect(regionMatches("packages/cli/src/agents", "packages/cli/src/agents-rogue.ts")).toBe(false);
  });

  it("unknown files and globs behave", () => {
    expect(suitesForChangedFiles(["packages/nowhere/src/x.ts"], real)).toEqual([]);
    expect(regionMatches("packages/core/src/tools/read*.ts", "packages/core/src/tools/read-file.ts")).toBe(true);
    expect(regionMatches("packages/core/src/tools/read*.ts", "packages/core/src/tools/write-file.ts")).toBe(false);
  });

  it("tests -> implementation: det-75 guards the compaction domain", () => {
    const domains = domainsForSuite("det-75-night-porting-18", real);
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.some((d) => d.includes("compaction"))).toBe(true);
  });

  it("tests -> implementation: a whitelisted suite guards no region", () => {
    expect(domainsForSuite("det-52-cc-plugins", real)).toEqual([]);
    expect(domainsForSuite("det-33-m48-loop-safety-net", real)).toContain("packages/core/src/loop.ts");
  });
});
