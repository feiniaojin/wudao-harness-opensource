// M49 §3 — CJK-capable full-text session search, zero deps (NO sqlite — the
// zero-dependency red line). An inverted-index JSON file
// (.wudao/search-index.json) is maintained INCREMENTALLY as sessions append:
// each indexed message (user/assistant only — tool results are bulk file
// content, index noise) costs one in-memory postings update; the file is
// rewritten per flush, not per entry. Tokenization is shared with the memory
// subsystem (tokenize.ts): latin word-runs + CJK bigrams. Ranking is
// BM25-lite. A corrupt/foreign-version index file rebuilds itself from the
// session JSONLs (auto-heal).
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createJsonlSessionStore } from "@wudao-org/core";
import type { AgentMessage } from "@wudao-org/core";
import { tokenizeText } from "./tokenize.js";

const INDEX_VERSION = 1;
const K1 = 1.2;
const B = 0.75;

export interface SearchHit {
  readonly sessionId: string;
  /** The 0-based ordinal of the message among the session's user/assistant
   *  messages (the same count incremental indexing assigns). */
  readonly ordinal: number;
  readonly role: "user" | "assistant";
  readonly excerpt: string;
  readonly score: number;
}

interface DocInfo {
  readonly s: string;
  readonly o: number;
  readonly role: "user" | "assistant";
  readonly len: number;
}

interface IndexFile {
  readonly version: number;
  /** Per-session count of indexed (user/assistant) messages. */
  readonly sessions: Record<string, number>;
  /** docKey "session#ordinal" → shape. */
  readonly docs: Record<string, DocInfo>;
  /** term → docKey → tf. */
  readonly postings: Record<string, Record<string, number>>;
}

function emptyIndex(): IndexFile {
  return { version: INDEX_VERSION, sessions: {}, docs: {}, postings: {} };
}

function isIndexFile(raw: unknown): raw is IndexFile {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return r.version === INDEX_VERSION
    && typeof r.sessions === "object" && r.sessions !== null
    && typeof r.docs === "object" && r.docs !== null
    && typeof r.postings === "object" && r.postings !== null;
}

export function searchIndexPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", "search-index.json");
}

function isIndexable(message: AgentMessage): message is Extract<AgentMessage, { role: "user" | "assistant" }> {
  return message.role === "user" || message.role === "assistant";
}

export interface SessionSearchIndex {
  /** Incrementally index one appended session message (user/assistant; tool
   *  results are skipped). In-memory; lands on disk at flush(). Re-indexing
   *  the same (session, ordinal) is a no-op. */
  indexMessage(sessionId: string, message: AgentMessage): void;
  /** Persist the index file (loads the base first when nothing loaded yet). */
  flush(): Promise<void>;
  /** Drop everything and rescan the sessions directory (corruption heal). */
  rebuild(): Promise<number>;
  /** BM25-lite search across every indexed doc; hits carry excerpts read
   *  from the session JSONLs. */
  search(query: string, opts?: { readonly limit?: number }): Promise<readonly SearchHit[]>;
  /** The index file path (tests / diagnostics). */
  readonly path: string;
}

export function createSessionSearchIndex(workspaceRoot: string): SessionSearchIndex {
  const path = searchIndexPath(workspaceRoot);
  const sessionsDir = join(workspaceRoot, ".wudao", "sessions");
  let index: IndexFile | null = null;
  let loading: Promise<void> | null = null;
  // indexMessage is sync but the base load is async: appends recorded before
  // the base is loaded park here and apply at the next await point (flush /
  // search / rebuild) — otherwise an empty in-memory base would clobber the
  // disk index (exactly the incremental-clobber bug this queue prevents).
  let pending: Array<readonly [string, AgentMessage]> = [];

  const applyMessage = (target: IndexFile, sessionId: string, message: AgentMessage): void => {
    if (!isIndexable(message)) return;
    const ordinal = target.sessions[sessionId] ?? 0;
    const docKey = `${sessionId}#${ordinal}`;
    if (target.docs[docKey] !== undefined) return; // already indexed
    const tokens = tokenizeText(message.content);
    target.docs[docKey] = { s: sessionId, o: ordinal, role: message.role, len: Math.max(1, tokens.length) };
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, n] of tf) {
      const posting = target.postings[term] ?? (target.postings[term] = {});
      posting[docKey] = n;
    }
    target.sessions[sessionId] = ordinal + 1;
  };

  const drainPending = (): void => {
    if (index === null) return;
    const queued = pending;
    pending = [];
    for (const [sid, m] of queued) applyMessage(index, sid, m);
  };

  const ensureLoaded = async (): Promise<void> => {
    if (index !== null) {
      drainPending();
      return;
    }
    if (loading === null) {
      loading = (async () => {
        let raw: unknown;
        try {
          raw = JSON.parse(await readFile(path, "utf8"));
        } catch {
          raw = undefined;
        }
        if (isIndexFile(raw)) {
          index = raw;
        } else {
          // Corrupt / missing / foreign version → auto-rebuild from source.
          const fresh = emptyIndex();
          const scanned = new Map<string, AgentMessage[]>();
          const store = createJsonlSessionStore(sessionsDir);
          for (const id of await store.list()) {
            const entries = await store.loadSessionEntries(id);
            const messages = entries.filter((e): e is AgentMessage => "role" in e && (e.role === "user" || e.role === "assistant"));
            scanned.set(id, messages);
            scanSession(fresh, id, messages);
          }
          index = fresh;
          // Pending appends recorded before the rebuild: the append sites
          // persist BEFORE indexing, so a pending run's messages are the TAIL
          // of its session's file — already covered by the scan above. Drop
          // the aligned tail (matched from the end); a pending message that
          // does NOT align with the file is genuinely new and still applies.
          // (A blind re-apply would double-index them at shifted ordinals.)
          const groups = new Map<string, { m: AgentMessage; keep: boolean }[]>();
          for (const [sid, m] of pending) {
            const g = groups.get(sid) ?? (groups.set(sid, []), groups.get(sid)!);
            g.push({ m, keep: true });
          }
          for (const [sid, g] of groups) {
            const list = scanned.get(sid) ?? [];
            let gi = g.length - 1;
            let fi = list.length - 1;
            while (gi >= 0 && fi >= 0 && g[gi]!.m.role === list[fi]!.role && g[gi]!.m.content === list[fi]!.content) {
              g[gi]!.keep = false;
              gi -= 1;
              fi -= 1;
            }
          }
          pending = pending.filter(([sid, m]) => {
            const g = groups.get(sid);
            const wrapper = g?.find((w) => w.m === m);
            return wrapper === undefined || wrapper.keep;
          });
        }
      })();
    }
    await loading;
    loading = null;
    drainPending();
  };

  const scanSession = (target: IndexFile, sessionId: string, messages: readonly AgentMessage[]): void => {
    for (const m of messages) applyMessage(target, sessionId, m);
  };

  const rebuild = async (): Promise<number> => {
    const fresh = emptyIndex();
    const store = createJsonlSessionStore(sessionsDir);
    for (const id of await store.list()) {
      const entries = await store.loadSessionEntries(id);
      scanSession(fresh, id, entries.filter((e): e is AgentMessage => "role" in e));
    }
    index = fresh;
    await flush();
    return Object.keys(fresh.sessions).length;
  };

  const flush = async (): Promise<void> => {
    await ensureLoaded();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(index!), "utf8");
  };

  const excerptFor = async (sessionId: string, ordinal: number): Promise<{ role: "user" | "assistant"; excerpt: string } | undefined> => {
    try {
      const entries = await createJsonlSessionStore(sessionsDir).loadSessionEntries(sessionId);
      let n = 0;
      for (const e of entries) {
        if (!("role" in e) || (e.role !== "user" && e.role !== "assistant")) continue;
        if (n === ordinal) {
          const flat = e.content.replace(/\s+/g, " ").trim();
          return { role: e.role as "user" | "assistant", excerpt: flat.length > 90 ? `${truncateSafe(flat, 89)}…` : flat };
        }
        n += 1;
      }
    } catch {
      // a raced-away session file: report the doc without the excerpt body
    }
    return undefined;
  };

  return {
    path,
    indexMessage(sessionId: string, message: AgentMessage): void {
      if (index === null) pending.push([sessionId, message]);
      else applyMessage(index, sessionId, message);
    },
    flush,
    rebuild,
    async search(query, opts) {
      await ensureLoaded();
      const limit = opts?.limit ?? 10;
      const terms = [...new Set(tokenizeText(query))];
      const ix = index!;
      const docCount = Object.keys(ix.docs).length;
      if (terms.length === 0 || docCount === 0) return [];
      const avgLen = Object.values(ix.docs).reduce((a, d) => a + d.len, 0) / docCount;
      const scores = new Map<string, number>();
      for (const term of terms) {
        const posting = ix.postings[term];
        if (posting === undefined) continue;
        const df = Object.keys(posting).length;
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
        for (const [docKey, tf] of Object.entries(posting)) {
          const doc = ix.docs[docKey];
          if (doc === undefined) continue;
          const norm = tf + K1 * (1 - B + (B * doc.len) / avgLen);
          scores.set(docKey, (scores.get(docKey) ?? 0) + (idf * (tf * (K1 + 1))) / norm);
        }
      }
      const ranked = [...scores.entries()]
        .filter(([, s]) => s > 0)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, limit);
      const hits: SearchHit[] = [];
      for (const [docKey, score] of ranked) {
        const doc = ix.docs[docKey]!;
        const body = await excerptFor(doc.s, doc.o);
        hits.push({
          sessionId: doc.s,
          ordinal: doc.o,
          role: body?.role ?? doc.role,
          excerpt: body?.excerpt ?? "(session file unavailable)",
          score,
        });
      }
      return hits;
    },
  };
}

/** The CLI/TUI hit rows: `<id8> · msg N · [role] excerpt` (one per line). */
export function formatSearchHits(hits: readonly SearchHit[]): string {
  if (hits.length === 0) return "(no sessions match — the index covers user/assistant messages in .wudao/sessions)";
  return hits
    .map((h) => `${h.sessionId.slice(0, 8)} · msg ${h.ordinal + 1} · [${h.role}] ${h.excerpt}`)
    .join("\n");
}

/** The /search + `wudao sessions search` engine: query → formatted rows. */
export async function runSessionSearch(workspaceRoot: string, query: string, limit = 10): Promise<string> {
  const trimmed = query.trim();
  if (trimmed === "") return "用法：/search <query>——CJK 与拉丁文均支持"; // ω99-166d-i: #8
  const ix = createSessionSearchIndex(workspaceRoot);
  return formatSearchHits(await ix.search(trimmed, { limit }));
}
