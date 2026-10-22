// ω99-74 — no-literal-NUL-in-source nails (67① parked debt): the peer
// fingerprint's template string carried a LITERAL U+0000 byte (source-level,
// HEAD blob included). Harmless to JS semantics but blinding to tooling:
// file(1) classifies the whole file "data" and BSD grep treats it as binary
// and SILENTLY SKIPS it — source search went dark on protocol.ts (the 67-arc
// "grep returns nothing" mystery). Fixed by escaping the byte (`\0`), which
// compiles to the identical runtime string, so peerFingerprint output bytes
// are unchanged.
//
// Two nails:
//  1. SOURCE nail — the peer/ and teams/ source trees must contain zero
//     literal NUL bytes (readFileSync + /\x00/). RED on base (protocol.ts
//     named); anyone reintroducing a control byte into source loses grep
//     visibility again and this goes red immediately.
//  2. GOLDEN nail — peerFingerprint over fixed inputs against base-measured
//     32-hex values. The `\0` escape is behavior-preserving by construction;
//     this pins the construction. If anyone later "simplifies" the separator
//     (a space, a newline, dropping it), the digest shifts and this goes red.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { peerFingerprint } from "../src/peer/index.js";

/** Every .ts source under dir (recursive) — same tree scope as the ω99-66
 *  cap-topology nail: a reintroduced NUL anywhere in the peer/teams trees,
 *  not only in protocol.ts, must turn the nail red. */
function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}

const TREES: readonly string[] = [
  join(import.meta.dirname, "../src/peer"),
  join(import.meta.dirname, "../src/teams"),
];

describe("ω99-74 — peer/teams sources carry no literal NUL bytes", () => {
  it("source nail: readFileSync(utf8) of every peer/teams .ts has zero /\\x00/ hits — grep/file(1) must never go blind on these trees again", () => {
    const offenders: string[] = [];
    for (const dir of TREES) {
      for (const f of sourceFiles(dir)) {
        if (/\x00/.test(readFileSync(f, "utf8"))) offenders.push(f);
      }
    }
    expect(offenders, `literal NUL bytes found in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("golden nail: peerFingerprint digests are byte-stable across the \\0 escape — fixed inputs, base-measured 32-hex outputs (a separator change must go red)", () => {
    // Baseline values measured on base @ee8b2b23 by executing the real
    // peerFingerprint (source still carrying the literal NUL); re-verified
    // green in the same run as the RED source nail above.
    const cases: readonly (readonly [string, string, string])[] = [
      ["alpha", "hello", "9452fc66d131841eeba94ec3ab716317"],
      ["session-7f3a", "héllo wörld — ünïcode ✓ plain-text only", "95d0efc531aba487e281c568bd74a470"],
      ["teammate.books", "RE: shelf audit\n>> done (3 rows)", "7706fedad45f636766ac681446e120b4"],
    ];
    for (const [sender, text, expected] of cases) {
      expect(peerFingerprint(sender, text), `fingerprint(${JSON.stringify(sender)}, ${JSON.stringify(text)})`).toBe(expected);
    }
  });
});
