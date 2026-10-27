// Inline diff for the edit tool: old_string/new_string → ctx/del/add hunk.
// Common prefix and suffix lines become context; only the changed middle
// is marked — a minimal honest patch view without a full diff library.
import React from "react";
import { Box, Text } from "ink";
import { T } from "./theme.js";

export type DiffLine = { kind: "ctx" | "del" | "add"; text: string };

/** M51 §4 (A7): wall-clock guard for the prefix/suffix scans. A pathological
 *  input on a busy machine must degrade to the honest whole-replace hunk
 *  (everything old deleted, everything new added) rather than hang the
 *  render — never a silently WRONG minimal diff. */
export const DIFF_SCAN_BUDGET_MS = 5_000;

/** M51 §4 (A7): escape diff text destined for a String.replace REPLACEMENT
 *  slot — `$&`, `$1`, `$'` … are template sequences there and would expand.
 *  The views here interpolate via template literals (already safe); this is
 *  the contract helper for any downstream consumer that must use replace():
 *  pair it with a FUNCTION replacer, or escape with this. */
export function escapeForReplace(text: string): string {
  return text.replace(/\$/g, "$$$$");
}

export function computeDiff(oldString: string, newString: string): DiffLine[] {
  const a = oldString.split("\n");
  const b = newString.split("\n");
  const deadline = Date.now() + DIFF_SCAN_BUDGET_MS;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    if ((start & 0xfff) === 0 && Date.now() > deadline) return wholeReplace(a, b);
    start++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    if (((a.length - endA) & 0xfff) === 0 && Date.now() > deadline) return wholeReplace(a, b);
    endA--; endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "ctx", text: a[i] ?? "" });
  for (let i = start; i <= endA; i++) out.push({ kind: "del", text: a[i] ?? "" });
  for (let i = start; i <= endB; i++) out.push({ kind: "add", text: b[i] ?? "" });
  for (let i = endA + 1; i < a.length; i++) out.push({ kind: "ctx", text: a[i] ?? "" });
  return out;
}

/** The degraded hunk: no context claim, one honest whole-file replacement. */
function wholeReplace(a: readonly string[], b: readonly string[]): DiffLine[] {
  return [
    ...a.map((text) => ({ kind: "del" as const, text })),
    ...b.map((text) => ({ kind: "add" as const, text })),
  ];
}

export function DiffView({ path, oldString, newString }: {
  path: string; oldString: string; newString: string;
}): React.JSX.Element {
  const hunk = computeDiff(oldString, newString);
  return (
    <Box flexDirection="column">
      <Text bold color={T.board}>{`✏️  ${path}`}</Text>
      {hunk.map((l, i) =>
        l.kind === "del" ? <Text key={i} color={T.err}>{`- ${l.text}`}</Text>
        : l.kind === "add" ? <Text key={i} color={T.ok}>{`+ ${l.text}`}</Text>
        : <Text key={i} color={T.dim}>{`  ${l.text}`}</Text>,
      )}
    </Box>
  );
}
