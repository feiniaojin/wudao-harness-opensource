// M64-C §C — the shared task board: `.wudao/teams/<team>/tasks.json`, the
// multi-process extension of the M23 board. Claims ride an atomic mkdir
// LOCK DIRECTORY (`locks/<task>.lock`) — two processes racing one task
// produce exactly one winner (mkdir is atomic on every filesystem we
// target); dependency completion auto-unlocks blocked tasks (a task is
// claimable only when every dependsOn id is done).
import { mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomInt } from "node:crypto";

export type TeamTaskStatus = "todo" | "in_progress" | "done" | "blocked";

export interface TeamTask {
  /** 8-char [a-z0-9] id. */
  readonly id: string;
  readonly title: string;
  readonly status: TeamTaskStatus;
  /** The teammate that claimed it (absent while unclaimed). */
  readonly claimedBy?: string;
  /** Task ids that must be done before this one unlocks. */
  readonly dependsOn: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TeamBoard {
  readonly version: 1;
  readonly tasks: readonly TeamTask[];
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newTeamTaskId(): string {
  let out = "";
  for (let i = 0; i < 8; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function teamDir(workspaceRoot: string, team: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(team)) throw new Error(`team name "${team}" must be letters/digits/_/-`);
  return join(workspaceRoot, ".wudao", "teams", team);
}

function validTask(v: unknown): TeamTask | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const t = v as Record<string, unknown>;
  if (typeof t.id !== "string" || t.id.length !== 8) return undefined;
  if (typeof t.title !== "string" || t.title === "") return undefined;
  if (t.status !== "todo" && t.status !== "in_progress" && t.status !== "done" && t.status !== "blocked") return undefined;
  if (!Array.isArray(t.dependsOn) || t.dependsOn.some((d) => typeof d !== "string")) return undefined;
  if (typeof t.createdAt !== "number" || typeof t.updatedAt !== "number") return undefined;
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    ...(typeof t.claimedBy === "string" && t.claimedBy !== "" ? { claimedBy: t.claimedBy } : {}),
    dependsOn: t.dependsOn as readonly string[],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export interface TeamBoardStore {
  /** The tasks (bad rows dropped — never fatal). */
  list(): Promise<readonly TeamTask[]>;
  /** Add a task; deps may name unknown ids (they read as not-done until added). */
  add(input: { readonly title: string; readonly dependsOn?: readonly string[] }): Promise<TeamTask>;
  remove(id: string): Promise<boolean>;
  /** File-lock claim: exactly one racer wins. False = already claimed/unknown/blocked. */
  claim(id: string, agent: string): Promise<boolean>;
  /** Mark done, then auto-unlock dependents whose deps are now all done. */
  complete(id: string, agent: string): Promise<boolean>;
}

function boardPath(dir: string): string {
  return join(dir, "tasks.json");
}

async function readBoard(dir: string): Promise<TeamBoard> {
  let text: string;
  try {
    text = await readFile(boardPath(dir), "utf8");
  } catch {
    return { version: 1, tasks: [] };
  }
  try {
    const parsed = JSON.parse(text) as Partial<TeamBoard>;
    if (!Array.isArray(parsed.tasks)) return { version: 1, tasks: [] };
    return { version: 1, tasks: parsed.tasks.map(validTask).filter((t): t is TeamTask => t !== undefined) };
  } catch {
    return { version: 1, tasks: [] };
  }
}

async function writeBoard(dir: string, board: TeamBoard): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = `${boardPath(dir)}.tmp-${process.pid}-${randomInt(1_000_000)}`;
  await writeFile(tmp, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  await rename(tmp, boardPath(dir));
}

/** Pure dependency evaluation: a not-done task whose deps are not ALL done
 *  is blocked; a blocked task whose deps are now all done unlocks to todo.
 *  done/in_progress statuses pass through unchanged. */
export function evaluateDependencies(tasks: readonly TeamTask[]): readonly TeamTask[] {
  const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
  return tasks.map((t) => {
    const depsDone = t.dependsOn.every((d) => done.has(d));
    if (t.status === "todo" && !depsDone) return { ...t, status: "blocked" as const };
    if (t.status === "blocked" && depsDone) return { ...t, status: "todo" as const };
    return t;
  });
}

// ---------------------------------------------------------------------------
// The mkdir lock — the cross-process claim primitive
// ---------------------------------------------------------------------------

/** One lock acquisition attempt: mkdir is atomic, so exactly one of N
 *  concurrent callers gets EEXIST-free success. Stale locks (a crashed
 *  holder) age out after 10s. */
async function tryLock(locksDir: string, id: string): Promise<boolean> {
  const lock = join(locksDir, `${id}.lock`);
  try {
    await mkdir(locksDir, { recursive: true });
    await mkdir(lock);
    return true;
  } catch {
    // Taken — or stale from a crashed holder: age it out and retry once.
    try {
      const st = await stat(lock);
      if (Date.now() - st.mtimeMs > 10_000) {
        await rmdir(lock).catch(() => {});
        try {
          await mkdir(lock);
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      /* raced away — treat as taken */
    }
    return false;
  }
}

async function unlock(locksDir: string, id: string): Promise<void> {
  await rmdir(join(locksDir, `${id}.lock`)).catch(() => {});
}

// m64c-fix-1: per-task mkdir locks serialize same-task claimers, but they do
// NOT serialize two writers operating on DIFFERENT tasks (or a claim+complete
// race). The board file is shared, so every read-modify-write cycle must
// serialize through a SINGLE board-wide lock — `locks/.board.lock`. Stale
// holders age out at 10s.
const BOARD_LOCK_NAME = ".board.lock";
async function withBoardLock<T>(locksDir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(locksDir, { recursive: true });
  const lock = join(locksDir, BOARD_LOCK_NAME);
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > 10_000) {
          await rmdir(lock).catch(() => {});
          try {
            await mkdir(lock);
            break;
          } catch {
            /* raced away — fall through to wait */
          }
        }
      } catch {
        /* raced away — treat as taken */
      }
      await new Promise<void>((r) => setTimeout(r, 10));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

export function openTeamBoard(workspaceRoot: string, team: string, now: () => number = Date.now): TeamBoardStore {
  const dir = teamDir(workspaceRoot, team);
  const locksDir = join(dir, "locks");
  return {
    async list() {
      const board = await readBoard(dir);
      // Reading evaluates dependencies too — completion auto-unlocks for
      // every reader, not just the completer's process.
      const evaluated = evaluateDependencies(board.tasks);
      // m64c-fix-1: an evaluation-driven write races claim/complete; guard it.
      if (JSON.stringify(evaluated) !== JSON.stringify(board.tasks)) {
        await withBoardLock(locksDir, async () => {
          await writeBoard(dir, { version: 1, tasks: evaluated });
        });
      }
      return evaluated;
    },
    async add(input) {
      const at = now();
      return withBoardLock(locksDir, async () => {
        for (;;) {
          const board = await readBoard(dir);
          const task: TeamTask = {
            id: newTeamTaskId(),
            title: input.title,
            status: "todo",
            ...(input.dependsOn !== undefined && input.dependsOn.length > 0 ? { dependsOn: input.dependsOn } : { dependsOn: [] }),
            createdAt: at,
            updatedAt: at,
          };
          // The id space is 36^8 — a collision with a live id retries.
          if (board.tasks.some((t) => t.id === task.id)) continue;
          await writeBoard(dir, { version: 1, tasks: [...board.tasks, task] });
          return task;
        }
      });
    },
    async remove(id) {
      return withBoardLock(locksDir, async () => {
        const board = await readBoard(dir);
        const next = board.tasks.filter((t) => t.id !== id);
        if (next.length === board.tasks.length) return false;
        await writeBoard(dir, { version: 1, tasks: next });
        return true;
      });
    },
    async claim(id, agent) {
      if (!(await tryLock(locksDir, id))) return false;
      // m64c-fix-1: the per-task lock is necessary but NOT sufficient — two
      // processes claiming DIFFERENT tasks both pass `tryLock` and then both
      // writeBoard, racing each other on the shared file. The board lock
      // wraps the read+write cycle so claimers always observe the latest
      // snapshot.
      return withBoardLock(locksDir, async () => {
        const board = await readBoard(dir);
        const evaluated = evaluateDependencies(board.tasks);
        const task = evaluated.find((t) => t.id === id);
        if (task === undefined || task.status !== "todo") return false;
        await writeBoard(dir, {
          version: 1,
          tasks: evaluated.map((t) => (t.id === id ? { ...t, status: "in_progress" as const, claimedBy: agent, updatedAt: now() } : t)),
        });
        return true;
      }).finally(async () => {
        await unlock(locksDir, id);
      });
    },
    async complete(id, agent) {
      // m64c-fix-1: complete() had no lock at all — two concurrent completers
      // both read a status=in_progress row, both write done. Guard it.
      return withBoardLock(locksDir, async () => {
        const board = await readBoard(dir);
        const task = board.tasks.find((t) => t.id === id);
        if (task === undefined || task.status === "done") return false;
        // Only the claimer completes an in-progress task; an unclaimed todo
        // (e.g. hand-completed by the lead) may complete too.
        if (task.claimedBy !== undefined && task.claimedBy !== agent) return false;
        const next = evaluateDependencies(board.tasks.map((t) => (t.id === id ? { ...t, status: "done" as const, updatedAt: now() } : t)));
        await writeBoard(dir, { version: 1, tasks: next });
        return true;
      });
    },
  };
}

/** List the team dirs that exist under `.wudao/teams/` (diagnostics/tests). */
export async function listTeams(workspaceRoot: string): Promise<readonly string[]> {
  try {
    return (await readdir(join(workspaceRoot, ".wudao", "teams"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
