// M55 §B10 — /review + /security-review: template prompt commands. Both
// inject a review request over the CURRENT UNCOMMITTED git diff as a user
// message (model-driven — the harness runs the normal loop, the model reads
// what it needs); the security variant carries a checklist template so the
// audit surface is pinned, not vibes. No diff → a notice, never an empty
// review run. The patch is capped (a pathological diff must not eat the
// context window before the model even starts).
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { createGitFn, insideWorkTree } from "./diff.js";
import type { GitFn } from "./diff.js";

export type GitRunner = GitFn;

export interface UncommittedDiff {
  readonly repo: boolean;
  /** `git diff HEAD --stat` (the shape overview). */
  readonly stat: string;
  /** The full uncommitted patch (unstaged + staged vs HEAD), capped. */
  readonly patch: string;
  /** Untracked files (`git ls-files --others --exclude-standard`). */
  readonly untracked: readonly string[];
  /** True when the patch was truncated at the cap. */
  readonly truncated: boolean;
}

export const REVIEW_PATCH_CAP_CHARS = 60_000;

const NOT_A_REPO = /not a git repository/i;

export { createGitFn };

// M58-D review fix: the locale-independent repo probe moved to diff.ts (the
// module both commands' git seams come from); re-exported here so existing
// importers keep working. One canonical probe, no stderr-locale matching.
export { insideWorkTree };

/** Collect the uncommitted surface: stat + patch (staged and unstaged vs
 *  HEAD) + untracked files. A not-a-repo workspace reports repo:false (the
 *  caller answers with a notice); other git failures degrade per lane (an
 *  empty repo has no HEAD — the patch stays empty, untracked still lists). */
export async function collectUncommittedDiff(git: GitRunner): Promise<UncommittedDiff> {
  const soft = async (args: readonly string[]): Promise<string> => {
    try {
      return await git(args);
    } catch {
      return "";
    }
  };
  if (!(await insideWorkTree(git))) {
    return { repo: false, stat: "", patch: "", untracked: [], truncated: false };
  }
  const [stat, patchRaw, untrackedRaw] = await Promise.all([
    soft(["diff", "HEAD", "--stat"]),
    soft(["diff", "HEAD"]),
    soft(["ls-files", "--others", "--exclude-standard"]),
  ]);
  const truncated = patchRaw.length > REVIEW_PATCH_CAP_CHARS;
  return {
    repo: true,
    stat: stat.trim(),
    patch: truncated ? `${truncateSafe(patchRaw, REVIEW_PATCH_CAP_CHARS)}\n` : patchRaw,
    untracked: untrackedRaw.split("\n").map((l) => l.trim()).filter((l) => l !== ""),
    truncated,
  };
}

/** Is there anything to review at all? */
export function hasReviewableContent(diff: UncommittedDiff): boolean {
  return diff.stat !== "" || diff.patch.trim() !== "" || diff.untracked.length > 0;
}

/** The security checklist (the audit surface the security variant pins). */
export const SECURITY_CHECKLIST: readonly string[] = [
  "authn/authz — missing checks, privilege confusion, session/token handling",
  "injection — command, path traversal, prompt-injection into tool args, template injection",
  "secrets — hardcoded keys/tokens, secrets logged or spilled into results",
  "untrusted data — MCP/file-borne content reaching exec/write paths without taint awareness",
  "permission/policy bypass — writes to runtime-policy files (settings.json/mcp.json), allow-rule widening",
  "ssrf / network — unvalidated URLs, internal endpoints, redirect following",
  "unsafe primitives — eval/dynamic require, deserialization, temp-file races",
  "resource exhaustion — unbounded reads/recursion, missing timeouts/caps",
  "error handling — failures that leak internals or fail open",
];

/** The review-request user message. Normal variant: correctness/edge/spec
 *  focus with a verdict contract; security variant: the checklist. An empty
 *  focus rides as "no particular focus". */
export function buildReviewPrompt(args: {
  readonly diff: UncommittedDiff;
  readonly security: boolean;
  readonly focus?: string;
}): string {
  const focus = (args.focus ?? "").trim();
  const focusLine = focus === "" ? "" : `Focus requested by the user: ${focus}\n\n`;
  const header = args.security
    ? "Review the CURRENT UNCOMMITTED changes below for SECURITY problems. Assume the change is guilty — hunt for what an attacker could do with it, not for what it does when everything goes right."
    : "Review the CURRENT UNCOMMITTED changes below. Find what is WRONG, not what works: correctness bugs, edge cases, error paths, concurrency hazards, spec violations.";
  const contract = args.security
    ? [
        "Work through the checklist (add anything else you find):",
        ...SECURITY_CHECKLIST.map((c) => `- ${c}`),
        "",
        "For every finding: severity (P0..P3), file:line, the concrete attack/failure, and the minimal fix. Mark what you could NOT check honestly.",
        "End with a verdict: approve / approve-with-changes / reject.",
      ].join("\n")
    : [
        "For every finding: severity (P0..P3), file:line, what breaks, and the minimal fix.",
        "Do not restate the diff or praise the code; findings only, plus an explicit list of what you could NOT verify.",
        "End with a verdict: approve / approve-with-changes / reject.",
      ].join("\n");
  const parts: string[] = [
    args.security ? "<security-review-request>" : "<review-request>",
    "",
    header,
    "",
    focusLine + contract,
    "",
    "Uncommitted stat:",
    args.diff.stat === "" ? "(empty)" : args.diff.stat,
    args.diff.untracked.length > 0 ? `\nUntracked files (review their FULL content with your read tools — no diff exists yet):\n${args.diff.untracked.map((f) => `- ${f}`).join("\n")}` : "",
    args.diff.truncated ? `\n(PATCH TRUNCATED at ${REVIEW_PATCH_CAP_CHARS} chars — read the rest from the workspace with your read tools)` : "",
    "",
    "```diff",
    args.diff.patch.trim() === "" ? "(no tracked-file diff — untracked files only)" : args.diff.patch.trim(),
    "```",
    "",
    args.security ? "</security-review-request>" : "</review-request>",
    "",
    args.security
      ? "Produce the security review now (checklist → findings → verdict)."
      : "Produce the review now (findings → verdict).",
  ];
  return parts.filter((p) => p !== "").join("\n");
}

/** The nothing-to-review notice (the command never runs an empty review). */
export function formatNoDiffNotice(workspaceRoot: string): string {
  return `nothing to review — no uncommitted changes in ${workspaceRoot} (make a change, or stage one, then /review again)`;
}
