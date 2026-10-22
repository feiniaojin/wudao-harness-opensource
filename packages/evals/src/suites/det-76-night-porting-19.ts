// det-76-night-porting-19 — the deterministic pins for 夜移 031 (torn-tail
// JSONL self-heal + serialized session writes, ported from the upstream project's
// session/jsonl/storage.ts). A crash mid-append leaves a junk tail line that
// pre-031 was silently skipped on every load FOREVER — and the next append
// welded onto it, an unhealable mid-file break. The pure half of the port is
// analyzeTornTail; the fs half (queue, temp+rename heal, append-never-welds)
// lives in core's session-heal.test.ts. Pinned here through the public
// export: torn-only-if-last rule, the missing-newline trigger, the
// whole-file-torn and trailing-blank edges, and the two deliberate
// non-verdicts (mid-file corruption, healthy file).
import type { EvalDefinition } from "../runner.js";
import { analyzeTornTail } from "@wudao/core";

export interface NightPorting19Evidence {
  // ① a torn FINAL line heals to the byte prefix before it
  readonly tornTail: boolean;
  // ② every line parses but the final "\n" is gone: it comes back
  readonly missingNewline: boolean;
  // ③ a single torn line as the whole file heals to empty
  readonly wholeFileTorn: boolean;
  // ④ blank lines after the fragment are still tail damage
  readonly trailingBlanks: boolean;
  // ⑤ mid-file corruption gets NO verdict — history is never rewritten
  readonly midFileUntouched: boolean;
  // ⑥ a healthy file (and an empty one) gets no verdict
  readonly healthyAndEmptyUntouched: boolean;
}

export const det76Eval: EvalDefinition<Record<string, never>, NightPorting19Evidence> = {
  name: "det-76-night-porting-19",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run() {
    // ① torn final fragment.
    const torn = analyzeTornTail(`{"role":"user","content":"one"}\n{"role":"user","cont`);
    const tornTail = torn !== undefined && torn.healTo === `{"role":"user","content":"one"}\n`;

    // ② missing trailing newline on an otherwise-valid file.
    const nl = analyzeTornTail(`{"role":"user","content":"solo"}`);
    const missingNewline = nl !== undefined && nl.healTo === `{"role":"user","content":"solo"}\n`;

    // ③ the whole file is one torn line.
    const whole = analyzeTornTail(`{"role":"user`);
    const wholeFileTorn = whole !== undefined && whole.healTo === "";

    // ④ blank lines AFTER the torn fragment don't rescue it — a crash can
    // leave trailing separators; the fragment is still the last entry.
    const blanks = analyzeTornTail(`{"a":1}\n{"tor\n\n\n`);
    const trailingBlanks = blanks !== undefined && blanks.healTo === `{"a":1}\n`;

    // ⑤ a broken line with a valid line AFTER it is mid-file corruption:
    // no verdict, no rewrite — the load-time skip keeps reading past it.
    const midFileUntouched = analyzeTornTail(`{"a":1}\n{"tor\n{"a":3}\n`) === undefined;

    // ⑥ healthy file and empty file: no verdict.
    const healthyAndEmptyUntouched = analyzeTornTail(`{"a":1}\n{"a":2}\n`) === undefined
      && analyzeTornTail("") === undefined;

    return { tornTail, missingNewline, wholeFileTorn, trailingBlanks, midFileUntouched, healthyAndEmptyUntouched };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => {
      if (!ok) errs.push(msg);
    };

    need(e.tornTail, "① a torn FINAL line must heal to the byte prefix before it");
    need(e.missingNewline, "② a file whose final newline was lost must get it back before the next append welds");
    need(e.wholeFileTorn, "③ a single torn line as the whole file must heal to empty");
    need(e.trailingBlanks, "④ blank lines after the torn fragment must not rescue it");
    need(e.midFileUntouched, "⑤ mid-file corruption must get NO verdict — history is never rewritten (the wudao divergence from the upstream project's fail-closed throw)");
    need(e.healthyAndEmptyUntouched, "⑥ healthy and empty files must get no verdict");

    return errs;
  },
};
