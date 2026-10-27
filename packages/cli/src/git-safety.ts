// M37 §3 — Bash git safety. Before shell executes, a STATIC check of
// the command line (only when the workspace is inside a git repo) recognizes
// high-risk git commands and upgrades the permission ASK text with an
// explicit warning naming the command and the risk. Detection is
// prefix/flag-shaped by design (spec: 误报可接受、漏报靠白名单收敛 — false
// positives acceptable, false negatives收敛 via the rule list); it NEVER
// blocks — the permission pipeline decides, this only informs.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** One recognized high-risk shape. */
export interface GitRisk {
  /** The canonical risky form the command matches (e.g. "git reset --hard"). */
  readonly label: string;
  /** What can go wrong — one human sentence, shown at the ask. */
  readonly risk: string;
}

// ---------------------------------------------------------------------------
// Token-based scan
// ---------------------------------------------------------------------------

const SEPARATOR_TOKENS = new Set(["&&", "||", ";", "|", "&", ">", ">>", "<", "(", ")", ";;", "&>", "2>", "2>&1"]);

/** Global (pre-subcommand) git options that CONSUME the next token. */
const GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);

/** Strip shell punctuation/quotes from a token's ends so `;git`/`(git`/`"git"` match. */
function bareToken(token: string): string {
  return token.replace(/^[;(){}&|<>"']+/u, "").replace(/[;(){}&|<>"']+$/u, "");
}

/** The args window of one git invocation: from after the subcommand to the
 *  next shell separator (so `git branch -d a && rm -rf /` scans only branch's
 *  own args). */
function gitInvocationArgs(tokens: readonly string[], gitAt: number): { subcommand: string; args: string[] } | undefined {
  let i = gitAt + 1;
  // Skip global options (and their values) until the subcommand.
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (t.startsWith("-")) {
      if (GLOBAL_VALUE_OPTIONS.has(t)) i += 2;
      else i += 1;
      continue;
    }
    break;
  }
  const subRaw = tokens[i];
  if (subRaw === undefined) return undefined; // "git" with no subcommand
  const subcommand = bareToken(subRaw).toLowerCase();
  const args: string[] = [];
  for (let j = i + 1; j < tokens.length; j += 1) {
    const t = tokens[j] ?? "";
    if (SEPARATOR_TOKENS.has(t)) break;
    // A separator GLUED to the end of an arg ("a&&") ends the invocation too.
    if (/[;&|]/.test(t.slice(1)) && t !== "-" && !t.startsWith("--")) {
      args.push(t.split(/[;&|]/)[0] ?? t);
      break;
    }
    args.push(t);
  }
  return { subcommand, args };
}

/** Letters of every short-flag token (so -fd, -f -d, -xfd all count). */
function shortFlagLetters(args: readonly string[]): Set<string> {
  const letters = new Set<string>();
  for (const a of args) {
    if (/^-[a-zA-Z]+$/.test(a)) {
      for (const ch of a.slice(1)) letters.add(ch);
    }
  }
  return letters;
}

/** Static detection of the high-risk git shapes in a shell command line. */
export function detectGitRisk(command: string): GitRisk | undefined {
  const tokens = command.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    if (bareToken(tokens[i] ?? "").toLowerCase() !== "git") continue;
    const inv = gitInvocationArgs(tokens, i);
    if (inv === undefined) continue;
    const { subcommand, args } = inv;
    const letters = shortFlagLetters(args);
    if (subcommand === "reset" && args.includes("--hard")) {
      return { label: "git reset --hard", risk: "discards ALL uncommitted changes in the working tree — they cannot be recovered" };
    }
    if (subcommand === "clean" && letters.has("f") && letters.has("d")) {
      return { label: "git clean -fd", risk: "permanently deletes untracked files AND directories — they cannot be recovered" };
    }
    if (subcommand === "push") {
      if (args.includes("--force") || letters.has("f")) {
        return { label: "git push --force", risk: "overwrites remote history — other clones may lose commits" };
      }
      if (args.includes("--force-with-lease")) {
        return { label: "git push --force-with-lease", risk: "overwrites remote history (lease-guarded) — other clones may lose commits" };
      }
    }
    if (subcommand === "checkout") {
      // `checkout .` / `checkout -- .` = discard everything in the worktree.
      const dotAt = args.indexOf(".");
      const ddAt = args.indexOf("--");
      if (dotAt !== -1 && (ddAt === -1 || dotAt > ddAt) && args.slice(0, dotAt).every((a) => a.startsWith("-"))) {
        return { label: "git checkout -- .", risk: "discards uncommitted changes to all modified files in the working tree" };
      }
    }
    if (subcommand === "branch" && letters.has("D")) {
      return { label: "git branch -D", risk: "force-deletes the branch even when unmerged — its commits may be lost" };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Repo detection + ask-site glue
// ---------------------------------------------------------------------------

const repoCache = new Map<string, boolean>();

/** True when root (or any parent, walk-up ≤ 32) contains a .git entry (file or
 *  dir — worktrees carry a .git FILE). Only POSITIVE results are cached — a
 *  negative can change the moment a .git appears (e.g. mid-session init). */
export function isInsideGitRepo(workspaceRoot: string): boolean {
  const hit = repoCache.get(workspaceRoot);
  if (hit === true) return true;
  let dir = workspaceRoot;
  for (let hop = 0; hop < 32; hop += 1) {
    if (existsSync(join(dir, ".git"))) {
      repoCache.set(workspaceRoot, true);
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/** The multi-line warning block an ask site prints above its question. */
export function formatGitRiskWarning(risk: GitRisk, command: string): string {
  return `⚠️ high-risk git command: ${risk.label}\n   risk: ${risk.risk}\n   command: ${command}`;
}

/** The warning for a permission ask, or undefined when the call is not a
 *  risky shell inside a git repo. This is the ONLY ask-site contract:
 *  never blocks, never changes the decision — only the ask text. */
export function gitRiskAskWarning(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
): string | undefined {
  if (toolName !== "shell") return undefined;
  const command = input["command"];
  if (typeof command !== "string" || command.trim() === "") return undefined;
  if (!isInsideGitRepo(workspaceRoot)) return undefined;
  const risk = detectGitRisk(command);
  return risk === undefined ? undefined : formatGitRiskWarning(risk, command);
}
