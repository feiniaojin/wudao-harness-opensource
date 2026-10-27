// M31 §1 — write-scope declarations: pure matching/narrowing/intersection
// semantics (hand-rolled glob-prefix matching; core stays dependency-free).
import { describe, it, expect } from "vitest";
import {
  isWriteScopeDeclaration,
  isWriteScopeEmpty,
  formatWriteScope,
  pathInWriteScope,
  narrowWriteScope,
  intersectWriteScopes,
} from "../src/agents/write-scope.js";

describe("isWriteScopeDeclaration (roster field validator)", () => {
  it("accepts roots / exactFiles / both / neither", () => {
    expect(isWriteScopeDeclaration({})).toBe(true);
    expect(isWriteScopeDeclaration({ roots: ["src/"] })).toBe(true);
    expect(isWriteScopeDeclaration({ exactFiles: ["pkg.json"] })).toBe(true);
    expect(isWriteScopeDeclaration({ roots: ["a/", "b/"], exactFiles: ["x"] })).toBe(true);
  });
  it("rejects non-objects and non-string-array members", () => {
    expect(isWriteScopeDeclaration(null)).toBe(false);
    expect(isWriteScopeDeclaration([])).toBe(false);
    expect(isWriteScopeDeclaration("src/")).toBe(false);
    expect(isWriteScopeDeclaration({ roots: "src/" })).toBe(false);
    expect(isWriteScopeDeclaration({ roots: ["a", 3] })).toBe(false);
    expect(isWriteScopeDeclaration({ exactFiles: [null] })).toBe(false);
  });
  it("ignores unknown members (forward compatible, like the roster itself)", () => {
    expect(isWriteScopeDeclaration({ roots: ["a"], futureField: 1 })).toBe(true);
  });
});

describe("pathInWriteScope (glob-prefix matching)", () => {
  const scope = { roots: ["src/lib/", "docs"], exactFiles: ["pkg.json"] };
  it("matches paths under a declared root (segment boundary respected)", () => {
    expect(pathInWriteScope(scope, "src/lib/util.ts")).toBe(true);
    expect(pathInWriteScope(scope, "src/lib")).toBe(true); // the root itself
    expect(pathInWriteScope(scope, "docs/readme.md")).toBe(true);
    expect(pathInWriteScope(scope, "pkg.json")).toBe(true);
  });
  it("refuses sibling prefixes (src/libX is NOT under src/lib)", () => {
    expect(pathInWriteScope(scope, "src/libX/util.ts")).toBe(false);
    expect(pathInWriteScope(scope, "src/other.ts")).toBe(false);
    expect(pathInWriteScope(scope, "docsx/readme.md")).toBe(false);
    expect(pathInWriteScope(scope, "sub/pkg.json")).toBe(false); // exact ≠ prefix
    expect(pathInWriteScope(scope, "pkg.json.bak")).toBe(false);
  });
  it("normalizes ./, leading /, and trailing / on both sides", () => {
    expect(pathInWriteScope({ roots: ["./a/"] }, "a/b.txt")).toBe(true);
    expect(pathInWriteScope({ roots: ["/a"] }, "a/b.txt")).toBe(true);
    expect(pathInWriteScope({ roots: ["a"] }, "/a/b.txt")).toBe(true);
    expect(pathInWriteScope({ roots: ["a"] }, "./a/b.txt")).toBe(true);
  });
  it("an empty root covers the whole workspace; an empty scope covers nothing", () => {
    expect(pathInWriteScope({ roots: [""] }, "any/where.txt")).toBe(true);
    expect(pathInWriteScope({ roots: ["."] }, "any/where.txt")).toBe(true);
    expect(pathInWriteScope({}, "pkg.json")).toBe(false);
    expect(isWriteScopeEmpty({})).toBe(true);
    expect(isWriteScopeEmpty({ roots: [], exactFiles: [] })).toBe(true);
    expect(isWriteScopeEmpty({ roots: ["a"] })).toBe(false);
  });
});

describe("narrowWriteScope (task narrowing, never escalation)", () => {
  const role = { roots: ["src/lib/", "src/app/"], exactFiles: ["pkg.json"] };
  it("narrows to a subset of the role roots", () => {
    const r = narrowWriteScope(role, { roots: ["src/lib/deep/"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(pathInWriteScope(r.scope, "src/lib/deep/x.ts")).toBe(true);
  });
  it("narrows to exact files that the role scope already covers", () => {
    const r = narrowWriteScope(role, { roots: ["src/lib/"], exactFiles: ["pkg.json"] });
    expect(r.ok).toBe(true);
  });
  it("refuses a task root outside every role root (escalation)", () => {
    const r = narrowWriteScope(role, { roots: ["tests/"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("tests/");
  });
  it("refuses a task exact file not covered by roots or exacts", () => {
    expect(narrowWriteScope(role, { exactFiles: ["outside.txt"] }).ok).toBe(false);
    expect(narrowWriteScope(role, { exactFiles: ["src/lib/not-exact.ts"] }).ok).toBe(true); // under a root
  });
  it("an empty task scope narrows to no writes; an empty role scope admits nothing", () => {
    expect(narrowWriteScope(role, {}).ok).toBe(true);
    expect(narrowWriteScope({}, { roots: ["a/"] }).ok).toBe(false);
    expect(narrowWriteScope({}, {}).ok).toBe(true);
  });
});

describe("intersectWriteScopes (pairwise, for overlap detection)", () => {
  it("nested roots intersect at the deeper root; disjoint roots do not intersect", () => {
    const shared = intersectWriteScopes({ roots: ["src/"] }, { roots: ["src/lib/"] });
    expect(shared).toEqual([{ kind: "root", path: "src/lib" }]);
    expect(intersectWriteScopes({ roots: ["src/"] }, { roots: ["tests/"] })).toEqual([]);
  });
  it("sibling-prefix roots do NOT intersect (src/lib vs src/libX)", () => {
    expect(intersectWriteScopes({ roots: ["src/lib/"] }, { roots: ["src/libX/"] })).toEqual([]);
  });
  it("identical roots intersect at the root itself", () => {
    expect(intersectWriteScopes({ roots: ["src/"] }, { roots: ["src"] })).toEqual([{ kind: "root", path: "src" }]);
  });
  it("an exact file intersects a covering root as the exact file", () => {
    expect(intersectWriteScopes({ roots: ["src/"] }, { exactFiles: ["src/lib/a.ts"] })).toEqual([
      { kind: "exactFile", path: "src/lib/a.ts" },
    ]);
    expect(intersectWriteScopes({ exactFiles: ["src/lib/a.ts"] }, { roots: ["src/"] })).toEqual([
      { kind: "exactFile", path: "src/lib/a.ts" },
    ]);
  });
  it("equal exact files intersect; unequal ones do not", () => {
    expect(intersectWriteScopes({ exactFiles: ["pkg.json"] }, { exactFiles: ["pkg.json"] })).toEqual([
      { kind: "exactFile", path: "pkg.json" },
    ]);
    expect(intersectWriteScopes({ exactFiles: ["pkg.json"] }, { exactFiles: ["pnpm-lock.yaml"] })).toEqual([]);
  });
  it("empty scopes never intersect", () => {
    expect(intersectWriteScopes({}, { roots: ["a/"] })).toEqual([]);
    expect(intersectWriteScopes({ roots: ["a/"] }, {})).toEqual([]);
  });
});

describe("formatWriteScope (receipt summary)", () => {
  it("summarizes roots and exact files compactly", () => {
    expect(formatWriteScope({ roots: ["src/lib/", "docs/"] })).toBe("roots src/lib, docs");
    expect(formatWriteScope({ exactFiles: ["pkg.json", "README.md"] })).toBe("exact pkg.json, README.md");
    expect(formatWriteScope({ roots: ["a/"], exactFiles: ["pkg.json"] })).toBe("roots a; exact pkg.json");
    expect(formatWriteScope({})).toBe("nowhere");
  });
});
