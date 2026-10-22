// M31 §1 — write-scope declarations: which workspace paths a role may WRITE.
// Pure string/segment matching, hand-rolled on purpose (core has zero
// dependencies; "glob prefix" here means path-segment prefix matching —
// `src/lib` covers `src/lib/a.ts` but NOT `src/libX/a.ts`).
//
// Semantics (spec 2026-08-17-m31 §1):
//   - `roots` are directory prefixes relative to workspaceRoot; an empty
//     root ("", ".") means the whole workspace.
//   - `exactFiles` are precise file paths; they match by equality only.
//   - An empty declaration ({} / no entries) covers NOTHING — declaring a
//     write scope is fail-closed, so "no entries" means "no writes".
//   - Task-level narrowing may only SHRINK the role's scope; anything that
//     sticks out is an escalation and is refused.
//   - Overlap detection intersects two scopes pairwise (root×root at the
//     deeper root, root×exact at the exact file, exact×exact on equality).

/** The `<role>.json` `writeScope` field. */
export interface WriteScopeDeclaration {
  /** Directory prefixes (workspace-relative, glob-prefix semantics). */
  readonly roots?: readonly string[];
  /** Exact file paths (workspace-relative, equality only). */
  readonly exactFiles?: readonly string[];
}

/** One shared path where two scopes intersect. */
export interface WriteScopeOverlapEntry {
  readonly kind: "root" | "exactFile";
  readonly path: string;
}

/** Structural validator for the roster loader (unknown members ignored —
 *  forward compatible, same doctrine as the profile itself). */
export function isWriteScopeDeclaration(value: unknown): value is WriteScopeDeclaration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((item) => typeof item === "string");
  if (rec.roots !== undefined && !isStringArray(rec.roots)) return false;
  if (rec.exactFiles !== undefined && !isStringArray(rec.exactFiles)) return false;
  return true;
}

/** True when the scope covers no path at all (declared but empty). */
export function isWriteScopeEmpty(scope: WriteScopeDeclaration): boolean {
  return (scope.roots ?? []).length === 0 && (scope.exactFiles ?? []).length === 0;
}

/** Normalize one path entry: strip leading "./" repeatedly, one leading "/",
 *  and any trailing "/" ("." collapses to the whole-workspace root "").
 *  Separators fold to "/" — on win32 the caller may hand us path.relative()
 *  output with "\" segments, and every comparison below is "/"-segmented. */
function normalizeScopePath(p: string): string {
  let out = p.split("\\").join("/");
  while (out.startsWith("./")) out = out.slice(2);
  if (out.startsWith("/")) out = out.slice(1);
  while (out.endsWith("/") && out.length > 1) out = out.slice(0, -1);
  if (out === "." ) out = "";
  return out;
}

/** True iff `child` equals `ancestor` or lies under it on a segment
 *  boundary. `ancestor === ""` (the empty root) covers everything. */
function underOrEqual(child: string, ancestor: string): boolean {
  const a = normalizeScopePath(ancestor);
  const c = normalizeScopePath(child);
  if (a === "") return true;
  return c === a || c.startsWith(`${a}/`);
}

/** Is `relPath` (workspace-relative or workspace-absolute) inside `scope`? */
export function pathInWriteScope(scope: WriteScopeDeclaration, relPath: string): boolean {
  if (isWriteScopeEmpty(scope)) return false;
  const p = normalizeScopePath(relPath);
  for (const root of scope.roots ?? []) {
    if (underOrEqual(p, root)) return true;
  }
  for (const exact of scope.exactFiles ?? []) {
    if (p === normalizeScopePath(exact)) return true;
  }
  return false;
}

export type NarrowWriteScopeResult =
  | { readonly ok: true; readonly scope: WriteScopeDeclaration }
  | { readonly ok: false; readonly error: string };

/** Narrow a role's declared scope with a task-level scope. The task scope
 *  must be a SUBSET of the role scope (every task root under a role root;
 *  every task exact file covered by a role root or equal to a role exact
 *  file) — anything wider is an escalation and fails closed. */
export function narrowWriteScope(roleScope: WriteScopeDeclaration, taskScope: WriteScopeDeclaration): NarrowWriteScopeResult {
  const violations: string[] = [];
  for (const root of taskScope.roots ?? []) {
    const covered = (roleScope.roots ?? []).some((r) => underOrEqual(root, r));
    if (!covered) violations.push(`root "${root}" is outside the role's write scope`);
  }
  for (const exact of taskScope.exactFiles ?? []) {
    const covered =
      (roleScope.roots ?? []).some((r) => underOrEqual(exact, r)) ||
      (roleScope.exactFiles ?? []).some((e) => normalizeScopePath(e) === normalizeScopePath(exact));
    if (!covered) violations.push(`file "${exact}" is outside the role's write scope`);
  }
  if (violations.length > 0) {
    return { ok: false, error: `task write-scope escalation refused: ${violations.join("; ")} (the role allows ${formatWriteScope(roleScope)})` };
  }
  return { ok: true, scope: taskScope };
}

/** Pairwise intersection of two scopes — every shared writable path. Two
 *  scopes intersect iff a path could be written by both. */
export function intersectWriteScopes(a: WriteScopeDeclaration, b: WriteScopeDeclaration): readonly WriteScopeOverlapEntry[] {
  if (isWriteScopeEmpty(a) || isWriteScopeEmpty(b)) return [];
  const out: WriteScopeOverlapEntry[] = [];
  const seen = new Set<string>();
  const push = (kind: WriteScopeOverlapEntry["kind"], raw: string): void => {
    const path = normalizeScopePath(raw);
    const key = `${kind}:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, path });
  };
  for (const ra of a.roots ?? []) {
    for (const rb of b.roots ?? []) {
      if (underOrEqual(ra, rb)) push("root", ra); // ra is the deeper (or equal) shared root
      else if (underOrEqual(rb, ra)) push("root", rb);
    }
    for (const eb of b.exactFiles ?? []) {
      if (underOrEqual(eb, ra)) push("exactFile", eb);
    }
  }
  for (const ea of a.exactFiles ?? []) {
    for (const eb of b.exactFiles ?? []) {
      if (normalizeScopePath(ea) === normalizeScopePath(eb)) push("exactFile", ea);
    }
    for (const rb of b.roots ?? []) {
      if (underOrEqual(ea, rb)) push("exactFile", ea);
    }
  }
  return out;
}

/** Compact one-line summary for receipts and TUI lines. */
export function formatWriteScope(scope: WriteScopeDeclaration): string {
  if (isWriteScopeEmpty(scope)) return "nowhere";
  const parts: string[] = [];
  const roots = (scope.roots ?? []).map(normalizeScopePath).filter((r) => r !== "");
  const wholeWorkspace = (scope.roots ?? []).some((r) => normalizeScopePath(r) === "");
  if (wholeWorkspace) parts.push("roots (whole workspace)");
  else if (roots.length > 0) parts.push(`roots ${roots.join(", ")}`);
  const exacts = (scope.exactFiles ?? []).map(normalizeScopePath);
  if (exacts.length > 0) parts.push(`exact ${exacts.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "nowhere";
}
