// det-72-night-porting-15 — the deterministic behavior pins for 夜移 027
// (notebook, Strands strands-ts notebook ported disk-backed). The
// scratchpad's whole value is survival: notes live under .wudao/notebooks/
// as plain files, so they outlive resume AND context compaction while
// staying outside the user's tree. This suite pins the contract through
// the PUBLIC export (`@wudao/core`): the disk round trip, the fail-closed
// name charset (names become paths — the threat model Strands' in-memory
// map never had), the per-notebook cap, literal replace semantics, the
// risk annotations, and the deliberate surface (no insertLine — recorded
// divergence). Zero network, zero real home, one tmpdir.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalDefinition } from "../runner.js";
import { createNotebookTool, NOTEBOOK_MAX_CHARS } from "@wudao/core";

// (No teardown hook on EvalDefinition — cleanup runs at the end of run();
// an assertion-path throw leaks one tmpdir, which the OS reaps.)

export interface NightPorting15Evidence {
  // ① create → append → read returns the exact accumulated content on disk
  readonly roundTrip: boolean;
  // ② path-shaped names are refused before any filesystem touch
  readonly pathEscapeRefused: boolean;
  // ③ the cap is enforced on append, named in the refusal, content intact
  readonly capEnforced: boolean;
  // ④ replace swaps the first occurrence; $ patterns stay literal
  readonly replaceLiteral: boolean;
  // ⑤ writable / not concurrency-safe / destructive on create+clear only
  readonly riskAnnotations: boolean;
  // ⑥ the surface is create/append/replace/read/list/clear — NO insertLine
  readonly surfaceContract: boolean;
}

export const det72Eval: EvalDefinition<{ readonly root: string }, NightPorting15Evidence> = {
  name: "det-72-night-porting-15",
  kind: "deterministic",
  async setup() {
    return { root: await mkdtemp(join(tmpdir(), "wudao-det72-")) };
  },
  async run({ root }) {
    const tool = createNotebookTool({ workspaceRoot: root });

    // ① disk round trip: create + append + read, exact bytes on disk.
    await tool.execute({ mode: "create", name: "draft", newStr: "finding A" });
    await tool.execute({ mode: "append", name: "draft", newStr: "finding B" });
    const read = await tool.execute({ mode: "read", name: "draft" });
    const onDisk = await readFile(join(root, ".wudao", "notebooks", "draft.md"), "utf8");
    const roundTrip = read.isError !== true && read.content === "finding A\nfinding B" && onDisk === read.content;

    // ② path-shaped names refused; nothing written for them.
    const escape = await tool.execute({ mode: "create", name: "../escape" });
    const slashed = await tool.execute({ mode: "append", name: "a/b", newStr: "x" });
    const pathEscapeRefused = escape.isError === true && slashed.isError === true;

    // ③ cap enforced on append, cap named, content unchanged.
    await tool.execute({ mode: "create", name: "cap", newStr: "x".repeat(NOTEBOOK_MAX_CHARS - 2) });
    const over = await tool.execute({ mode: "append", name: "cap", newStr: "yyyyy" });
    const after = await tool.execute({ mode: "read", name: "cap" });
    const capEnforced = over.isError === true
      && over.content.includes(String(NOTEBOOK_MAX_CHARS))
      && after.content.length === NOTEBOOK_MAX_CHARS - 2;

    // ④ replace: first occurrence only, $ patterns literal.
    await tool.execute({ mode: "create", name: "rep", newStr: "alpha beta alpha" });
    await tool.execute({ mode: "replace", name: "rep", oldStr: "alpha", newStr: "$&X" });
    const rep = await tool.execute({ mode: "read", name: "rep" });
    const replaceLiteral = rep.content === "$&X beta alpha";

    // ⑤ risk annotations.
    const riskAnnotations = tool.isReadOnly?.({ mode: "read" }) === false
      && tool.isConcurrencySafe?.({ mode: "append" }) === false
      && tool.isOpenWorld?.({ mode: "append" }) === false
      && tool.isDestructive?.({ mode: "clear" }) === true
      && tool.isDestructive?.({ mode: "create" }) === true
      && tool.isDestructive?.({ mode: "append" }) === false;

    // ⑥ the deliberate surface — six modes, insertLine deliberately absent.
    const surfaceContract = ["create", "append", "replace", "read", "list", "clear"]
      .every((m) => tool.description.includes(m))
      && !tool.description.includes("insertLine");

    const evidence = { roundTrip, pathEscapeRefused, capEnforced, replaceLiteral, riskAnnotations, surfaceContract };
    await rm(root, { recursive: true, force: true });
    return evidence;
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.roundTrip, "① create→append→read must round-trip exact bytes on disk under .wudao/notebooks/");
    need(e.pathEscapeRefused, "② path-shaped names must be refused before any filesystem touch");
    need(e.capEnforced, "③ the notebook cap must be enforced on append, named in the refusal, content intact");
    need(e.replaceLiteral, "④ replace must swap the first occurrence with $ patterns staying literal");
    need(e.riskAnnotations, "⑤ notebook must be writable/not-concurrency-safe/destructive on create+clear only");
    need(e.surfaceContract, "⑥ the surface must be the six modes with insertLine deliberately absent");

    return errs;
  },
};
