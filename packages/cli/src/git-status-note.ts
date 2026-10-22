// M58 §C#8 — git status injection. At session start and again whenever the
// repo's cheap fingerprint changes, a block with branch / ahead-behind /
// uncommitted summary is delivered to the model through the MetaNote
// PROJECTION channel — the same seam the M32 <file_changed> notes ride.
//
// HARD RULE (spec §C#8): the block goes through the projection channel ONLY
// — it must NEVER enter the stable system-prompt prefix. the upstream formatputs its git
// snapshot in the system prompt, which couples prefix-cache reuse to snapshot
// identity: two sequential sessions in the same directory share the cached
// prefix only when their snapshots match (docs/research/24, prompt-caching
// parity). We deliberately avoid that coupling — the prefix stays
// byte-identical across repo changes (pinned by tests), and the ephemeral
// block rides the last tool_result tail / a projected user message instead
// (the persisted JSONL never gains an entry).
//
// Cheap fingerprint: HEAD sha + the porcelain -b branch header (branch +
// ahead/behind — free, it is already in the output) + the porcelain entry
// COUNT. Recomputed at TURN BOUNDARIES (beforeModelCall), never per
// keystroke. Content swaps that keep sha + branch + count identical do not
// re-inject — the fingerprint is cheap by design, not exhaustive.
//
// The probe is an OBSERVER like the M32 prober: fail-open (any git failure —
// missing binary, not a repo, timeout — means no note, never a broken run)
// and bounded (two short-lived subprocesses per probe; a confirmed non-repo
// is latched so later probes cost nothing — `git init` mid-session needs a
// restart, the same stance project-context takes).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hardenedGitArgs } from "./git-hardened.js";

const execFileAsync = promisify(execFile);

/** Subprocess budget for one git call (fail-open on overrun). */
const GIT_TIMEOUT_MS = 5000;
/** Max porcelain lines included in the note (then an explicit omission line). */
export const MAX_STATUS_LINES = 20;
/** Belt cap on the whole note (renamed paths can double long names). */
export const NOTE_CAP_BYTES = 4 * 1024;
/** Short sha form in the note (the fingerprint uses the full sha). */
const SHORT_SHA_LEN = 8;

export interface GitStatusSnapshot {
  /** Full HEAD sha ("" on an unborn repo). */
  readonly sha: string;
  /** The `## …` porcelain -b header verbatim (branch + tracking + ahead/behind). */
  readonly branchHeader: string;
  /** Porcelain entry lines, verbatim ("" when the tree is clean). */
  readonly entries: readonly string[];
}

/** The cheap change-detection key (see the header comment). */
export function gitStatusFingerprint(s: GitStatusSnapshot): string {
  return `${s.sha}\n${s.branchHeader}\n${s.entries.length}`;
}

/** One git call.
 *  - result: exit 0, stdout captured (stderr is never read — exit-code and
 *    message LOCALE are deliberately not part of the contract).
 *  - null: the git BINARY is missing (ENOENT) — nothing git-shaped can ever
 *    happen here; callers latch.
 *  - undefined: the command failed (exit ≠ 0 / timeout) — the CALLER decides
 *    what that means. Exit-code and stderr LOCALE are never parsed: a
 *    localized git ("致命错误：不是 git 仓库…") must classify identically to
 *    an English one, so repo presence is decided by a second, structural
 *    probe (rev-parse --git-dir) instead of message text. */
async function runGit(args: readonly string[], cwd: string): Promise<{ stdout: string } | null | undefined> {
  try {
    const { stdout } = await execFileAsync("git", hardenedGitArgs(args), {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stdout ?? "" };
  } catch (err) {
    if (err !== null && typeof err === "object" && (err as { code?: unknown }).code === "ENOENT") return null;
    return undefined;
  }
}

/** Collect the current status of the repo containing `cwd`.
 *  - snapshot: the repo state (an unborn repo included — branch header "No
 *    commits yet on …", sha "").
 *  - null: definitely NO repo here (or no git binary) — the caller may latch.
 *  - undefined: repo-shaped but unavailable right now (transient) — retry at
 *    the next boundary.
 *  Never throws. */
export async function collectGitStatus(cwd: string): Promise<GitStatusSnapshot | null | undefined> {
  // 1. HEAD sha.
  const head = await runGit(["rev-parse", "HEAD"], cwd);
  if (head === null) return null; // no git binary
  let sha = "";
  if (head !== undefined) {
    sha = head.stdout.trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return undefined; // odd repo state — skip
  } else {
    // HEAD unresolvable: unborn repo OR no repo — --git-dir decides (it only
    // fails outside a repo; locale-independent).
    const gitDir = await runGit(["rev-parse", "--git-dir"], cwd);
    if (gitDir === undefined) return null; // no repo here
  }

  // 2. One porcelain -b call: branch header + entry lines together.
  const status = await runGit(
    ["-c", "core.quotepath=false", "status", "--porcelain", "-b", "--untracked-files=normal"],
    cwd,
  );
  if (status === null) return null;
  if (status === undefined) return undefined;
  const lines = status.stdout.split("\n");
  let branchHeader = "## (unknown branch)";
  const entries: string[] = [];
  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith("## ")) branchHeader = line.slice(3);
    else entries.push(line);
  }
  return { sha, branchHeader, entries };
}

/** The injected block: branch line, short HEAD, capped porcelain summary. */
export function buildGitStatusNote(s: GitStatusSnapshot): string {
  const rows: string[] = [];
  let truncated = false;
  for (const line of s.entries) {
    if (
      rows.length >= MAX_STATUS_LINES ||
      Buffer.byteLength(rows.join("\n"), "utf8") + Buffer.byteLength(line, "utf8") > NOTE_CAP_BYTES
    ) {
      truncated = true;
      break;
    }
    rows.push(line);
  }
  const summary =
    s.entries.length === 0
      ? "working tree clean"
      : [
          `uncommitted changes (${s.entries.length}):`,
          ...rows,
          ...(truncated ? [`… +${s.entries.length - rows.length} more (omitted; run \`git status --porcelain\` for all)`] : []),
        ].join("\n");
  const head = s.sha === "" ? "(no commits yet)" : s.sha.slice(0, SHORT_SHA_LEN);
  return `<git_status>\nbranch: ${s.branchHeader}\nHEAD: ${head}\n${summary}\n</git_status>`;
}

export interface GitStatusProber {
  /** One probe round (a turn boundary): recompute the fingerprint, push a
   *  note when it changed (the FIRST probe always injects — session start).
   *  Never throws. */
  probe(): Promise<void>;
}

export function createGitStatusProber(options: {
  readonly workspaceRoot: string;
  /** MetaNote channel: notes land in the loop's metaNotes queue. */
  readonly push: (text: string) => void;
  /** Injectable collector (tests); defaults to real git. */
  readonly collect?: (cwd: string) => Promise<GitStatusSnapshot | null | undefined>;
}): GitStatusProber {
  const collect = options.collect ?? collectGitStatus;
  let lastFingerprint: string | undefined;
  let repoAbsent = false;

  return {
    async probe(): Promise<void> {
      if (repoAbsent) return;
      try {
        const snapshot = await collect(options.workspaceRoot);
        if (snapshot === null) {
          // Confirmed non-repo: latch (a `git init` mid-session needs a
          // restart — same stance project-context takes with its walk).
          repoAbsent = true;
          return;
        }
        if (snapshot === undefined) return; // transient — retry next boundary
        const fp = gitStatusFingerprint(snapshot);
        if (fp === lastFingerprint) return; // unchanged — no re-injection
        lastFingerprint = fp;
        options.push(buildGitStatusNote(snapshot));
      } catch {
        // Fail-open observer: a broken probe must never break the run.
      }
    },
  };
}
