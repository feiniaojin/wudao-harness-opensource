// ω99-47 (the upstream projectC4 soft version marker + the upstream formatcandidate 3 read/write gate): the
// session JSONL's FORMAT VERSION. The transcript format has evolved purely
// additively so far, which means an older binary reading a newer file
// silently SKIPS what it does not recognize — data loss with no signal. The
// gate fixes that ahead of the first semantic break:
//
//  - FIRST WRITE stamps a soft marker: a generic `wudao_meta` entry as line
//    1 (`{"type":"wudao_meta","data":{"formatVersion":1}}`). Append-only
//    friendly — an old binary skips it as an unknown entry (the same M35 §2
//    channel the ω99-43 receipts ride), a fork byte-copies it, and history
//    is never rewritten to add one retroactively.
//  - WRITE GATE: a file whose marker names a version NEWER than
//    SUPPORTED_FORMAT_VERSION opens read-only — reads return its data
//    unchanged, writes throw UnsupportedSessionFormatException.
//  - Migration chains (a ref's adjacent-frozen vEdge) are deliberately NOT
//    built here: wudao has no breaking migration yet, so only the gate
//    lands (YAGNI, recorded in the arc report).
//
// The current format IS version 1 — the marker changes no entry semantics.
export const SUPPORTED_FORMAT_VERSION = 1;

/** The generic entry type that carries the format marker. */
export const FORMAT_MARKER_TYPE = "wudao_meta";

/** The marker line written at a file's first write. BYTE-PINNED: the exact
 *  serialization (key order `type`,`data` / `formatVersion`) is an
 *  acceptance — old readers must be able to skip it, forks must copy it,
 *  and the gate must parse it back out of raw text. */
export function formatMarkerLine(): string {
  return `{"type":"${FORMAT_MARKER_TYPE}","data":{"formatVersion":${SUPPORTED_FORMAT_VERSION}}}\n`;
}

/** Typed refusal: the write gate's error. Reads of the file are unaffected
 *  (data is never dropped); only mutations refuse. */
export class UnsupportedSessionFormatException extends Error {
  readonly fileVersion: number;
  readonly supportedVersion: number;
  constructor(fileVersion: number) {
    super(
      `session file format version ${fileVersion} is newer than this build supports (${SUPPORTED_FORMAT_VERSION}): `
        + `this file was written by a NEWER version of wudao — upgrade wudao to write to it `
        + `(reads are unaffected)`,
    );
    this.name = "UnsupportedSessionFormatException";
    this.fileVersion = fileVersion;
    this.supportedVersion = SUPPORTED_FORMAT_VERSION;
  }
}

/** Recognize a parsed line as the format marker: a wudao_meta generic entry
 *  whose data carries a finite numeric formatVersion. Shared by the write
 *  gate (extractFormatVersion) and the read-side strip — the marker is
 *  TRANSPORT FRAMING, not data: entry views (loadSessionEntries /
 *  loadSidechainEntries) drop it without counting it as a skip, so a file
 *  written by this build reads identically to the same entries written by
 *  a pre-ω99-47 build on EVERY read path. */
export function isFormatMarker(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const entry = v as Record<string, unknown>;
  if (entry.type !== FORMAT_MARKER_TYPE) return false;
  if (typeof entry.data !== "object" || entry.data === null) return false;
  const data = entry.data as Record<string, unknown>;
  return typeof data.formatVersion === "number" && Number.isFinite(data.formatVersion);
}

/** Extract the format version a file's text declares, if its FIRST line is
 *  a well-formed wudao_meta marker. Anything else — no marker (a legacy
 *  pre-ω99-47 file), a marker with a malformed payload — returns undefined,
 *  which the gate treats as "unversioned, normal read/write". Only line 1
 *  counts: the marker rides a first write, so that is the only place it
 *  can legitimately appear. */
export function extractFormatVersion(text: string): number | undefined {
  const nl = text.indexOf("\n");
  const first = (nl === -1 ? text : text.slice(0, nl)).trim();
  if (!first) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(first);
  } catch {
    return undefined;
  }
  if (!isFormatMarker(parsed)) return undefined;
  return (parsed as { data: { formatVersion: number } }).data.formatVersion;
}
