// det-66-night-porting-9 — the deterministic behavior pins for 夜移 021
// (MCP text boundary hygiene: control-char/NFC scrub + description cap).
// The feature landed with cli unit tests (the sanitize matrix + the fixture
// server's hostile `dirty` tool end-to-end through loadMcpTools); this suite
// pays the det-44-style debt the same way det-57..det-65 did — the behavior
// pinned inside the release-eval matrix through the PUBLIC export
// (wudao-harness/mcp/tools), so a regression fails the release evals. The
// zero-process seam (mcpToolFromDescriptor + deps) means no JsonRpcClient,
// no spawn, no network — pure boundary functions.
//
//   ① description lane  a dirty descriptor (ESC sequence + past-cap body)
//                       becomes a scrubbed, capped description with a
//                       VISIBLE truncation marker (exact cap math);
//   ② content lane      a dirty tools/call result is scrubbed before it
//                       becomes tool-result text (controls stripped, NFC
//                       composed, U+FFFD dropped; \t\n\r preserved);
//   ③ fail-closed       a server-side isError still maps to an isError
//                       result, with the text scrubbed on that lane too;
//   ④ seam wiring       deps.onCall observes (isError, latency) for both
//                       outcomes — the /mcp runtime snapshot keeps feeding;
//   ⑤ sanitize matrix   the pure function's contract (C0 minus \t\n\r,
//                       DEL + C1, U+FFFD, NFC, idempotence).
import { mcpToolFromDescriptor, sanitizeMcpText, MAX_MCP_DESCRIPTION_CHARS } from "wudao-harness/mcp/tools";
import type { EvalDefinition } from "../runner.js";

export interface NightPorting9Evidence {
  // ① description lane
  readonly descriptionScrubbed: boolean;
  readonly descriptionCapped: boolean;
  // ② content lane
  readonly contentScrubbed: boolean;
  // ③ fail-closed
  readonly isErrorLaneScrubbed: boolean;
  // ④ seam wiring
  readonly onCallWired: boolean;
  // ⑤ sanitize matrix
  readonly sanitizeMatrix: boolean;
}

export const det66Eval: EvalDefinition<Record<string, never>, NightPorting9Evidence> = {
  name: "det-66-night-porting-9",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run(): Promise<NightPorting9Evidence> {
    const CAP = MAX_MCP_DESCRIPTION_CHARS;

    // ① the description lane: ESC inside a past-cap description.
    const rawDescription = "P\x1b[31mrobe " + "x".repeat(CAP + 500);
    const probe = mcpToolFromDescriptor("fake", { name: "probe", description: rawDescription }, {
      call: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
      onCall: () => {},
    });
    const d = probe.description ?? "";
    const scrubbedLen = rawDescription.length - 1; // the one ESC
    const marker = ` …(+${scrubbedLen - CAP} chars truncated)`;
    const descriptionScrubbed = !d.includes("\x1b") && d.startsWith("P[31mrobe ");
    const descriptionCapped = d.length === CAP + marker.length && d.endsWith(marker);

    // ② the content lane: controls + decomposed + FFFD + DEL in call text.
    const tool2 = mcpToolFromDescriptor("fake", { name: "probe2" }, {
      call: async () => ({ content: [{ type: "text", text: "a\x00b\x1bc\td\ne\u0301f\ufffdg\x7f" }], isError: false }),
      onCall: () => {},
    });
    const r2 = await tool2.execute({});
    const contentScrubbed = r2.isError !== true && r2.content === "abc\td\néfg";

    // ③④ the fail-closed lane + onCall wiring over a shared observation list.
    const seen: Array<[boolean, number]> = [];
    const recorder = (isError: boolean, ms: number): void => { seen.push([isError, ms]); };
    const tool3 = mcpToolFromDescriptor("fake", { name: "probe3" }, {
      call: async () => ({ content: [{ type: "text", text: "bad\x00 stuff" }], isError: true }),
      onCall: recorder,
    });
    const tool4 = mcpToolFromDescriptor("fake", { name: "probe4" }, {
      call: async () => ({ content: [{ type: "text", text: "fine" }], isError: false }),
      onCall: recorder,
    });
    const r3 = await tool3.execute({});
    await tool4.execute({});
    const isErrorLaneScrubbed = r3.isError === true && r3.content === "bad stuff";
    const onCallWired = seen.length === 2
      && seen[0]![0] === true && seen[0]![1] >= 0
      && seen[1]![0] === false && seen[1]![1] >= 0;

    // ⑤ the pure-function contract in one sweep.
    const dirty = "a\x00\x01b\x0b\x0cc\x7fd\u0080e\u0301f\ufffd\t\n\r";
    const clean = sanitizeMcpText(dirty);
    const sanitizeMatrix = clean === "abcd\u00e9f\t\n\r" && sanitizeMcpText(clean) === clean;

    return { descriptionScrubbed, descriptionCapped, contentScrubbed, isErrorLaneScrubbed, onCallWired, sanitizeMatrix };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.descriptionScrubbed, "① a dirty tool description must lose its ESC sequence (printable text intact)");
    need(e.descriptionCapped, "① a past-cap description must be capped with exact math and a visible truncation marker");
    need(e.contentScrubbed, "② dirty tools/call text must be scrubbed (controls stripped, NFC composed, U+FFFD dropped; \\t\\n\\r kept)");
    need(e.isErrorLaneScrubbed, "③ a server-side isError must stay fail-closed AND have its text scrubbed");
    need(e.onCallWired, "④ deps.onCall must observe (isError, latency) for both outcomes");
    need(e.sanitizeMatrix, "⑤ sanitizeMcpText must honor the full scrub contract and be idempotent");

    return errs;
  },
};
