// M46 §2 — shell long-output head/tail shaping: the shaping matrix
// (threshold lanes, head/tail line counts, omission arithmetic, spill
// write-through + read-back, guidance/receipt lines, exit label intact) and
// the fallbacks (absent config → byte-identical pre-M46 behavior; failed
// spill → the byte-cap path).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellTool } from "../src/tools/shell.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import {
  shapeLongOutput,
  needsLongOutputShaping,
  omissionMarker,
  shapedReceipt,
  LONG_OUTPUT_GUIDANCE,
  DEFAULT_LONG_OUTPUT,
  type LongOutputConfig,
} from "../src/tools/long-output.js";

let root: string;
let spillDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lo-"));
  spillDir = join(root, ".wudao", "spill", "test-session");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const LONG: LongOutputConfig = DEFAULT_LONG_OUTPUT;

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
}

describe("long-output: pure shaping", () => {
  it("detects both threshold lanes", () => {
    expect(needsLongOutputShaping(lines(200), LONG)).toBe(false); // 200 lines is AT the threshold
    expect(needsLongOutputShaping(lines(201), LONG)).toBe(true);
    expect(needsLongOutputShaping("x".repeat(10_001), LONG)).toBe(true); // byte lane, single line
    expect(needsLongOutputShaping("x".repeat(10_000), LONG)).toBe(false);
  });
  it("shapes head + marker + tail + guidance + receipt", () => {
    const shaped = shapeLongOutput({ raw: lines(300), config: LONG, spillPath: "/spill/abc.txt" });
    if (shaped === undefined) throw new Error("expected shaping");
    const out = shaped.split("\n");
    expect(out[0]).toBe("line-1");
    expect(out[49]).toBe("line-50");
    expect(out[50]).toBe(omissionMarker(200, "/spill/abc.txt"));
    expect(out[51]).toBe("line-251"); // tail = last 50
    expect(out[100]).toBe("line-300");
    expect(out[101]).toBe(LONG_OUTPUT_GUIDANCE);
    expect(out[102]).toBe(shapedReceipt(LONG, 200));
    expect(out.length).toBe(103);
    expect(omissionMarker(200, "/spill/abc.txt")).toBe("... [省略 200 行,完整输出已保存至 /spill/abc.txt] ...");
    expect(shapedReceipt(LONG, 200)).toBe("[shaped h50/t50, +200 lines spilled]");
  });
  it("returns undefined under threshold and when head+tail covers everything", () => {
    expect(shapeLongOutput({ raw: lines(100), config: LONG, spillPath: "/s.txt" })).toBeUndefined();
    // byte lane fires but a single line has nothing to omit at line granularity
    expect(shapeLongOutput({ raw: "x".repeat(20_000), config: LONG, spillPath: "/s.txt" })).toBeUndefined();
  });
  it("honors custom thresholds", () => {
    const custom: LongOutputConfig = { lineThreshold: 10, byteThreshold: 10_000, headLines: 2, tailLines: 3 };
    const shaped = shapeLongOutput({ raw: lines(12), config: custom, spillPath: "/s.txt" });
    if (shaped === undefined) throw new Error("expected shaping");
    expect(shaped.split("\n")).toEqual([
      "line-1",
      "line-2",
      omissionMarker(7, "/s.txt"),
      "line-10",
      "line-11",
      "line-12",
      LONG_OUTPUT_GUIDANCE,
      shapedReceipt(custom, 7),
    ]);
  });
});

describe("long-output: shell integration", () => {
  it("shapes a 300-line output, spills the full text, and links read_file", async () => {
    const tool = createShellTool({ workspaceRoot: root, spillDir, longOutput: LONG });
    const res = await tool.execute({ command: "seq 1 300" });
    expect(res.isError).toBeFalsy();
    const marker = /\.\.\. \[省略 (\d+) 行,完整输出已保存至 (.+)\] \.\.\./.exec(res.content)?.[0];
    if (marker === undefined) throw new Error(`no omission marker in:\n${res.content}`);
    expect(marker).toContain("[省略 200 行");
    const spillPath = /完整输出已保存至 (.+?)\] \.\.\./.exec(res.content)?.[1];
    if (spillPath === undefined) throw new Error("no spill path");
    // head 50, tail 50, guidance, receipt, exit label — and nothing between.
    const body = res.content.split("\n");
    expect(body[1]).toBe("1");
    expect(body[2]).toBe("2");
    expect(body[50]).toBe("50");
    expect(body[51]).toBe(marker);
    expect(body[52]).toBe("251");
    expect(body[101]).toBe("300");
    expect(body[102]).toBe(LONG_OUTPUT_GUIDANCE);
    expect(body[103]).toBe("[shaped h50/t50, +200 lines spilled]");
    expect(body[104]).toBe("[exit 0]");
    expect(res.content).not.toContain("\n51\n");
    expect(res.content).not.toContain("\n250\n");
    // Spill holds the FULL output and read_file can page it.
    const spilled = await readFile(spillPath, "utf8");
    expect(spilled.split("\n").length).toBe(301); // 300 lines + trailing newline
    expect(spilled.startsWith("1\n2\n")).toBe(true);
    expect(spilled.endsWith("299\n300\n")).toBe(true);
    const readTool = createReadFileTool({ workspaceRoot: root });
    const rel = spillPath.slice(root.length + 1);
    const back = await readTool.execute({ path: rel });
    expect(back.isError).toBeFalsy();
    expect(back.content.startsWith("1\n")).toBe(true); // the spill pages verbatim through read_file
    expect(back.content).toContain("\n300");
  });
  it("leaves short outputs untouched", async () => {
    const tool = createShellTool({ workspaceRoot: root, spillDir, longOutput: LONG });
    const res = await tool.execute({ command: "seq 1 100" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("\n50\n");
    expect(res.content).not.toContain("省略");
    expect(res.content).not.toContain("shaped");
    expect(await readdir(spillDir).catch(() => [])).toEqual([]); // nothing spilled (dir may not exist)
  });
  it("shapes on the byte lane (many medium lines)", async () => {
    const tool = createShellTool({ workspaceRoot: root, spillDir, longOutput: LONG });
    // 20 lines x ~590B ≈ 12KB: under the line threshold, over the byte one —
    // shaping fires but head+tail covers all 20 lines, so nothing is omitted
    // and the full (sub-cap) output stays inline with no marker.
    const res = await tool.execute({ command: "awk 'BEGIN{for(i=0;i<20;i++)printf \"%590d\\n\", i}'" });
    expect(res.isError).toBeFalsy();
    expect(/省略 \d+ 行/.test(res.content)).toBe(false);
    expect(res.content).toContain("[exit 0]");
  });
  it("shapes on the byte lane when lines exceed head+tail", async () => {
    const tool = createShellTool({
      workspaceRoot: root,
      spillDir,
      longOutput: { lineThreshold: 500, byteThreshold: 10_000, headLines: 50, tailLines: 50 },
    });
    // 120 medium lines: 240 lines' worth of bytes over 10k, under 500 lines.
    const res = await tool.execute({ command: "awk 'BEGIN{for(i=0;i<120;i++)printf \"%120d\\n\", i}'" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("省略 20 行");
    expect(res.content).toContain("[shaped h50/t50, +20 lines spilled]");
    expect(res.content).toContain("[exit 0]");
  });
  it("keeps the pre-M46 behavior when no config is injected", async () => {
    const tool = createShellTool({ workspaceRoot: root, spillDir });
    const res = await tool.execute({ command: "seq 1 300" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("\n150\n"); // everything inline
    expect(res.content).not.toContain("省略");
    expect(res.content.endsWith("[exit 0]")).toBe(true);
  });
  it("falls back to the byte-cap path when the spill write fails", async () => {
    await writeFile(join(root, "blocker"), "not a directory", "utf8");
    const tool = createShellTool({
      workspaceRoot: root,
      spillDir: join(root, "blocker", "spill"), // mkdir fails
      longOutput: LONG,
      maxOutputBytes: 4_096,
    });
    // 100k of output: shaping wants to fire, the spill fails, so the legacy
    // byte-cap returns the head slice with no spill note and no marker.
    const res = await tool.execute({ command: "awk 'BEGIN{for(i=0;i<2000;i++)printf \"%48d\\n\", i}'" });
    expect(res.isError).toBeFalsy();
    expect(res.content).not.toContain("省略");
    expect(res.content).not.toContain("(full output:");
    expect(res.content).toContain("[exit 0]");
  });
  it("marks a failing command as isError while still shaping", async () => {
    const tool = createShellTool({ workspaceRoot: root, spillDir, longOutput: LONG });
    const res = await tool.execute({ command: "seq 1 300; exit 3" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("省略 200 行");
    expect(res.content.endsWith("[exit 3]")).toBe(true);
  });
});
