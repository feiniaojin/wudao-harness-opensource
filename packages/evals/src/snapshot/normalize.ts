// M71 §1 — snapshot normalization + diffing.
//
// The snapshot contract (research 36 §8): record once WITH a key, replay
// forever WITHOUT one. A fixture recorded on Tuesday on a mac must replay
// identically on Friday on CI linux — so before any comparison, both sides
// pass through THIS normalizer, which strips everything provably volatile:
//   - volatile KEYS (uuid/parentUuid/sessionId/durationMs/…) are dropped
//     wherever they appear in captured structures;
//   - the run's workspace root becomes <WORKSPACE> (it is a mkdtemp path);
//   - the OS tmpdir prefix outside the root becomes <TMP>;
//   - ISO-8601 timestamps become <TIME>;
//   - the platform line becomes <PLATFORM> (environmentSection embeds
//     os.platform() — darwin-recorded fixtures must replay on linux CI).
// Everything left is deterministic by construction and any divergence is a
// real prompt-assembly regression.
import { tmpdir } from "node:os";

/** M71 §2 — the negative prompt-injection canary. Scenarios mount this text
 *  in a persistence-only surface (a non-message session entry that load()
 *  filters out); every assembled request — recorded OR replayed — is then
 *  asserted to never contain it. Any hit is a prompt-assembly leak. */
export const INJECTION_MARKER = "THIS MARKER MUST NOT REACH THE MODEL";

/** Case-sensitive substring check for the canary (exact bytes — the marker is
 *  mounted verbatim; a case-shifted fragment is NOT a leak of the marker). */
export function containsMarker(text: string): boolean {
  return text.includes(INJECTION_MARKER);
}

/** Keys that never carry diffable meaning: identity/branch metadata the
 *  persistence layer mints per run, wall-clock measurements, and model-state
 *  timestamps. Anything NOT here is treated as deterministic content. */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "uuid",
  "parentUuid",
  "sessionId",
  "session",
  "durationMs",
  "elapsedMs",
  "elapsed",
  "at",
  "timestamp",
  "createdAt",
  "updatedAt",
  "mtimeMs",
  "startedAt",
  "finishedAt",
]);

export interface NormalizeContext {
  /** This run's workspace root (a fresh mkdtemp dir) → <WORKSPACE>. */
  readonly workspaceRoot: string;
  /** This run's os.platform() → the "# Platform: <p>" line converges across
   *  record/replay machines. */
  readonly platform: string;
}

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** Apply every string-level substitution to one raw string (used on prompt
 *  bytes and raw request bodies, where we keep text, not structure). */
export function normalizeText(text: string, ctx: NormalizeContext): string {
  let out = text;
  // macOS symlinks /var and /tmp through /private — a tool that resolves
  // through the symlink reports the workspace root in realpath form. Fold
  // FIRST, BEFORE the workspace substitution: the realpath spelling must land
  // on <WORKSPACE>, not survive the fold only to degrade to
  // <TMP>/wudao-snap-… (M71 review F3). No-ops on linux fixtures.
  out = out.split("/private/var/").join("/var/");
  out = out.split("/private/tmp/").join("/tmp/");
  // win32: a path embedded in TEXT carries backslash separators, and when the
  // text is JSON-serialized (canonicalJson prompt lines, recorded request
  // bodies) every `\` is escaped to `\\`. The OS-native, JSON-escaped, and
  // slash-swapped spellings of the same root must ALL fold.
  const altSep = (p: string): string => (p.includes("\\") ? p.split("\\").join("/") : p.split("/").join("\\"));
  const jsonEsc = (p: string): string => (p.includes("\\") ? p.split("\\").join("\\\\") : p);
  if (ctx.workspaceRoot !== "") {
    for (const form of [ctx.workspaceRoot, altSep(ctx.workspaceRoot), jsonEsc(ctx.workspaceRoot), jsonEsc(altSep(ctx.workspaceRoot))]) {
      out = out.split(form).join("<WORKSPACE>");
    }
  }
  const tmp = tmpdir();
  if (tmp !== "" && tmp !== "/") {
    for (const form of [tmp, altSep(tmp), jsonEsc(tmp), jsonEsc(altSep(tmp))]) {
      out = out.split(form).join("<TMP>");
    }
  }
  if (ctx.platform !== "") out = out.split(`Platform: ${ctx.platform}`).join("Platform: <PLATFORM>");
  out = out.replace(ISO_RE, "<TIME>");
  return out;
}

/** Recursively normalize a parsed structure: drop volatile keys, rewrite the
 *  volatile substrings inside every string value. Arrays keep their order
 *  (order IS the transcript). Returns a fresh value; never mutates input. */
export function normalizeValue(value: unknown, ctx: NormalizeContext): unknown {
  if (typeof value === "string") return normalizeText(value, ctx);
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v, ctx));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(k)) continue; // dropped: never diffed, never stored
      if (v === undefined) continue; // omit-never-null discipline on both sides
      out[k] = normalizeValue(v, ctx);
    }
    return out;
  }
  return value;
}

/** JSON with recursively sorted object keys (arrays keep their order) — the
 *  fixture's canonical byte form, mirroring the providers' canonicalJson so
 *  stored bytes are stable regardless of the capturing side's key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Max findings reported per diff — enough to diagnose, small enough to read. */
const MAX_FINDINGS = 10;

function excerpt(s: string): string {
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** Structural diff of two NORMALIZED values. Objects compare order-
 *  insensitively (canonical key order), arrays order-sensitively. Returns
 *  human-readable findings with JSON-pointer paths; [] = identical. */
export function diffValues(actual: unknown, expected: unknown, path = "$", out: string[] = []): string[] {
  if (out.length >= MAX_FINDINGS) return out;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      out.push(`${path}: array length ${actual.length} != ${expected.length}`);
    }
    const n = Math.min(actual.length, expected.length);
    for (let i = 0; i < n && out.length < MAX_FINDINGS; i += 1) {
      diffValues(actual[i], expected[i], `${path}/${i}`, out);
    }
    return out;
  }
  if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object") {
    const a = actual as Record<string, unknown>;
    const b = expected as Record<string, unknown>;
    for (const k of Object.keys(a)) {
      if (!(k in b)) out.push(`${path}: missing key ${path === "$" ? "$" : ""}.${k} (present in actual, absent in expected)`.replace("$.$", "$"));
      else diffValues(a[k], b[k], `${path}/${k}`, out);
      if (out.length >= MAX_FINDINGS) return out;
    }
    for (const k of Object.keys(b)) {
      if (!(k in a)) out.push(`${path}: extra key ${path === "$" ? "$" : ""}.${k} (absent in actual, present in expected)`.replace("$.$", "$"));
      if (out.length >= MAX_FINDINGS) return out;
    }
    return out;
  }
  if (actual !== expected) {
    out.push(`${path}: ${excerpt(canonicalJson(actual))} != ${excerpt(canonicalJson(expected))}`);
  }
  return out;
}

/** Byte diff for canonical prompt bytes (serializePrompt output): reports the
 *  first diverging line with ±2 lines of context. [] = identical. */
export function diffPromptBytes(actual: string, expected: string): string[] {
  const a = actual.split("\n");
  const b = expected.split("\n");
  if (a.length !== b.length) {
    if (a.every((line, i) => line === b[i])) return [`line count ${a.length} != ${b.length} (all shared lines equal)`];
    // else fall through: the first content divergence is the real story
  }
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) {
      const lo = Math.max(0, i - 2);
      const hi = Math.min(n, i + 3);
      const ctxA = a.slice(lo, hi).map((l, j) => `${lo + j === i ? "-" : " "} ${excerpt(l)}`).join("\n");
      const ctxB = b.slice(lo, hi).map((l, j) => `${lo + j === i ? "+" : " "} ${excerpt(l)}`).join("\n");
      return [`line ${i}: first divergence\n${ctxA}\n${ctxB}`];
    }
  }
  if (a.length !== b.length) return [`line count ${a.length} != ${b.length} beyond the shared equal prefix`];
  return [];
}
