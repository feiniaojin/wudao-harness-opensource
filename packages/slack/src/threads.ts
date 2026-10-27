// M60 §1 — the thread↔session map, persisted at .wudao/slack-threads.json:
// `{channel}:{thread_ts} → sessionId`. A Slack thread IS a harness session:
// the first (allowed) mention in a new thread creates the session, every
// later follow-up in the thread resumes the same one. The file is a plain
// JSON object (human-readable, hand-editable); a corrupt file logs one line
// and starts fresh rather than taking the daemon down.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** The map key: `{channel}:{thread_ts}` (Slack ids are url-safe). */
export function threadKey(channel: string, threadTs: string | undefined, fallbackTs?: string): string {
  const ts = threadTs ?? fallbackTs ?? "";
  return `${channel}:${ts}`;
}

export function threadMapPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", "slack-threads.json");
}

export interface SlackThreadMap {
  /** The session id mapped to this thread, if any. */
  get(key: string): string | undefined;
  /** Bind a thread to a session and persist. Serialized: concurrent sets
   *  queue behind one write chain, so the file never interleaves. */
  set(key: string, sessionId: string): Promise<void>;
  /** Drop a binding (a dead session's thread can start over). */
  delete(key: string): Promise<void>;
  /** Live size (diagnostics / doctor / status). */
  size(): number;
  /** Snapshot of all bindings (doctor, tests). */
  entries(): Readonly<Record<string, string>>;
}

/** Parse the persisted file body (pure; corrupt input → undefined). */
export function parseThreadMapBody(text: string): Record<string, string> | undefined {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    // Tolerant per-entry check: a non-string value drops that entry only.
    if (typeof v === "string" && v.trim() !== "" && k.includes(":")) out[k] = v;
  }
  return out;
}

/** Load (or start) the map for a workspace. */
export async function loadThreadMap(workspaceRoot: string, warn: (m: string) => void = () => {}): Promise<SlackThreadMap> {
  const path = threadMapPath(workspaceRoot);
  let data: Record<string, string> = {};
  try {
    const text = await readFile(path, "utf8");
    const parsed = parseThreadMapBody(text);
    if (parsed === undefined) {
      warn(`⚠️ ${path} is not a valid thread map — starting fresh (the corrupt file is left in place)`);
    } else {
      data = parsed;
    }
  } catch {
    // absent → fresh map (written on first binding)
  }
  let current: Record<string, string> = { ...data };
  // Serialize writes: each set/delete replaces the chain so concurrent calls
  // never interleave two write()s onto the same temp file.
  let chain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const body = `${JSON.stringify(current, null, 2)}\n`;
    chain = chain.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename: a crash mid-write never leaves a half file behind.
      const tmp = `${path}.tmp-${randomUUID().split("-")[0]}`;
      await writeFile(tmp, body, "utf8");
      await rename(tmp, path);
    });
    return chain;
  };
  return {
    get: (key) => current[key],
    set: async (key, sessionId) => {
      current = { ...current, [key]: sessionId };
      await persist();
    },
    delete: async (key) => {
      if (!(key in current)) return;
      const next = { ...current };
      delete next[key];
      current = next;
      await persist();
    },
    size: () => Object.keys(current).length,
    entries: () => ({ ...current }),
  };
}
