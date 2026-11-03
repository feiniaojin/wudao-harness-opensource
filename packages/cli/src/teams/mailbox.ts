// M64-C §C — team mailboxes: one JSON file per agent under
// `.wudao/teams/<team>/inboxes/<agent>.json`. A successful FILE WRITE is
// the send (写入成功才算发送); reads validate every entry and DROP bad
// rows without blocking delivery (条目校验,坏条目剔除不阻塞投递).
// Intra-team text keeps the §A untrusted semantics — the banner rides
// every delivered note (rendered by the runtime, not stored here).
//
// m64c-fix-1: the read-modify-write in `deliverTeamMail` is guarded by a
// per-inbox mkdir lock at `inboxes/<agent>.json.lock` (atomic on every
// filesystem we target). Without it two writers both read the same baseline
// and the second write CLOBBERS the first; the lock serializes the
// read+append+write cycle. Stale locks age out at 10s (a crashed holder
// cannot wedge an inbox forever).
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { MAIL_CONTENT_MAX_CHARS } from "@wudao-org/core";

/** The entry cap per inbox (a chatty teammate must not balloon the file). */
export const TEAM_INBOX_CAP = 100;
/** One entry's text bound (same shape as §A's peer text cap). Single-sourced
 *  from the mail constitution (ω99-67): the value is MAIL_CONTENT_MAX_CHARS
 *  via @wudao-org/core — the name stays (export ABI), the local 8k literal is
 *  gone. */
export const TEAM_MESSAGE_MAX_CHARS = MAIL_CONTENT_MAX_CHARS;

export interface TeamMailEntry {
  /** 12-char [a-z0-9] id. */
  readonly id: string;
  readonly from: string;
  readonly text: string;
  readonly sentAt: number;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newTeamMailId(): string {
  let out = "";
  for (let i = 0; i < 12; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

function validEntry(v: unknown): TeamMailEntry | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length !== 12) return undefined;
  if (typeof e.from !== "string" || e.from === "") return undefined;
  if (typeof e.text !== "string" || e.text === "") return undefined;
  if (typeof e.sentAt !== "number" || !Number.isFinite(e.sentAt)) return undefined;
  return { id: e.id, from: e.from, text: truncateSafe(e.text, TEAM_MESSAGE_MAX_CHARS), sentAt: e.sentAt };
}

export function isMailboxAgentName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

function inboxPath(teamDir: string, agent: string): string {
  if (!isMailboxAgentName(agent)) throw new Error(`mailbox agent name "${agent}" must be letters/digits/_/-`);
  return join(teamDir, "inboxes", `${agent}.json`);
}

/** The lock sidecar path — mkdir-style atomic acquire. */
function inboxLockPath(teamDir: string, agent: string): string {
  return join(teamDir, "inboxes", `${agent}.json.lock`);
}

/** m64c-fix-1: serialize the read-modify-write cycle on a single inbox.
 *  mkdir is atomic, so exactly one of N concurrent callers gets EEXIST-free
 *  success. Stale locks (a crashed holder) age out at 10s. */
async function withInboxLock<T>(teamDir: string, agent: string, fn: () => Promise<T>): Promise<T> {
  const lock = inboxLockPath(teamDir, agent);
  await mkdir(join(teamDir, "inboxes"), { recursive: true });
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      // Stale from a crashed holder — age it out and retry once.
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

async function readInboxFile(teamDir: string, agent: string): Promise<TeamMailEntry[]> {
  let text: string;
  try {
    text = await readFile(inboxPath(teamDir, agent), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(validEntry).filter((e): e is TeamMailEntry => e !== undefined);
  } catch {
    return [];
  }
}

async function writeInboxFile(teamDir: string, agent: string, entries: readonly TeamMailEntry[]): Promise<void> {
  const path = inboxPath(teamDir, agent);
  await mkdir(join(teamDir, "inboxes"), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomInt(1_000_000)}`;
  await writeFile(tmp, `${JSON.stringify(entries.slice(-TEAM_INBOX_CAP), null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export type DeliverResult =
  | { readonly ok: true; readonly entry: TeamMailEntry }
  | { readonly ok: false; readonly error: string };

/** Append one entry to an agent's inbox. The atomic write's success IS the
 *  send — a failed write is a failed send (never a silent drop). */
export async function deliverTeamMail(input: {
  readonly teamDir: string;
  readonly to: string;
  readonly from: string;
  readonly text: string;
  readonly now?: () => number;
}): Promise<DeliverResult> {
  const to = input.to.trim();
  const from = input.from.trim();
  const text = input.text.trim();
  if (!isMailboxAgentName(to)) return { ok: false, error: `send_message: invalid teammate name "${to}"` };
  if (from === "") return { ok: false, error: "send_message: empty sender" };
  if (text === "") return { ok: false, error: "send_message: text is empty" };
  if (text.length > TEAM_MESSAGE_MAX_CHARS) {
    return { ok: false, error: `send_message: text exceeds ${TEAM_MESSAGE_MAX_CHARS} chars` };
  }
  let entry!: TeamMailEntry;
  // m64c-fix-1: serialize per-inbox to prevent read-modify-write clobbers;
  // the id is generated inside the lock so concurrent senders never share one.
  await withInboxLock(input.teamDir, to, async () => {
    entry = { id: newTeamMailId(), from, text, sentAt: (input.now ?? Date.now)() };
    const current = await readInboxFile(input.teamDir, to);
    await writeInboxFile(input.teamDir, to, [...current, entry]);
  });
  return { ok: true, entry };
}

/** Read an inbox (validated; bad rows dropped). */
export async function readTeamInbox(teamDir: string, agent: string): Promise<readonly TeamMailEntry[]> {
  return readInboxFile(teamDir, agent);
}

/** Read + drain: returns the entries and leaves the inbox empty. */
export async function takeTeamInbox(teamDir: string, agent: string): Promise<readonly TeamMailEntry[]> {
  const entries = await readInboxFile(teamDir, agent);
  if (entries.length > 0) await writeInboxFile(teamDir, agent, []);
  return entries;
}
