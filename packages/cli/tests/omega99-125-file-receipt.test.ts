// ω99-125 — 交付物文件卡, RED-first, arc A. The pure extractor that pulls
// the structured receipt line out of a tool result (NAME-GATED on
// make_xlsx/make_pptx — never a generic JSON sniff, so no other tool's
// JSON-tailed output can ever grow a card), plus the driver wiring that
// lands it on the tool history entry as `file` (errors never carry it;
// absent fields keep old history byte-identical on the wire).
import { describe, expect, it, vi } from "vitest";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { Tool } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";
import { extractFileReceipt } from "../src/driver/file-receipt.js";

// Real receipt bytes (doc-xlsx.ts / doc-pptx.ts execute tails): 中文一句 +
// "\n" + JSON.stringify({path, relativePath, rows|slides, bytes}) — the JSON
// is ALWAYS the last line; extra keys (rows/columns/slides) ride along and
// the extractor ignores them.
const XLSX_RECEIPT =
  `已生成 Excel：报表.xlsx（3 行 × 2 列，1.5 KB）\n` +
  JSON.stringify({ path: "/tmp/ws/报表.xlsx", relativePath: "报表.xlsx", rows: 3, columns: 2, bytes: 1536 });
const PPTX_RECEIPT =
  `已生成演示文稿：汇报.pptx（4 页，9.9 KB）\n` +
  JSON.stringify({ path: "/tmp/ws/汇报.pptx", relativePath: "汇报.pptx", slides: 4, bytes: 10137 });
// ω99-126 控制器补充指令：make_docx joins the gate (docx 交付物同权成卡)。
const DOCX_RECEIPT =
  `已生成文档：报告.docx（5 块，3.2 KB）\n` +
  JSON.stringify({ path: "/tmp/ws/报告.docx", relativePath: "报告.docx", blocks: 5, bytes: 3241 });

describe("ω99-125 A — extractFileReceipt (name-gated, fail-closed, never throws)", () => {
  it("extracts the xlsx receipt's structured last line (extra keys ignored)", () => {
    expect(extractFileReceipt("make_xlsx", XLSX_RECEIPT)).toEqual({
      path: "/tmp/ws/报表.xlsx",
      name: "报表.xlsx",
      bytes: 1536,
    });
  });
  it("extracts the pptx receipt (slides shape)", () => {
    expect(extractFileReceipt("make_pptx", PPTX_RECEIPT)).toEqual({
      path: "/tmp/ws/汇报.pptx",
      name: "汇报.pptx",
      bytes: 10137,
    });
  });
  it("ω99-126: extracts the docx receipt (blocks shape — third name in the gate)", () => {
    expect(extractFileReceipt("make_docx", DOCX_RECEIPT)).toEqual({
      path: "/tmp/ws/报告.docx",
      name: "报告.docx",
      bytes: 3241,
    });
  });
  it("name gate: any other tool with the SAME json tail yields undefined", () => {
    expect(extractFileReceipt("read_file", XLSX_RECEIPT)).toBeUndefined();
    expect(extractFileReceipt("write_file", PPTX_RECEIPT)).toBeUndefined();
    expect(extractFileReceipt("make_xlsx ", XLSX_RECEIPT)).toBeUndefined();
  });
  it("error result (no JSON tail) → undefined", () => {
    expect(extractFileReceipt("make_xlsx", "make_xlsx: 写入失败（boom）")).toBeUndefined();
    expect(extractFileReceipt("make_pptx", 'make_pptx: "filename" must be a non-empty path relative to the workspace')).toBeUndefined();
  });
  it("non-JSON last line → undefined", () => {
    expect(extractFileReceipt("make_xlsx", "已生成 Excel：报表.xlsx\nnot json at all")).toBeUndefined();
  });
  it("shape gate: missing path / relativePath / bytes → undefined", () => {
    const line = (o: Record<string, unknown>) => `一句\n${JSON.stringify(o)}`;
    expect(extractFileReceipt("make_xlsx", line({ relativePath: "a.xlsx", bytes: 1 }))).toBeUndefined();
    expect(extractFileReceipt("make_pptx", line({ path: "/a.pptx", bytes: 1 }))).toBeUndefined();
    expect(extractFileReceipt("make_xlsx", line({ path: "/a.xlsx", relativePath: "a.xlsx" }))).toBeUndefined();
  });
  it("bytes must be a positive finite number", () => {
    const line = (bytes: unknown) => `一句\n${JSON.stringify({ path: "/a.xlsx", relativePath: "a.xlsx", bytes })}`;
    expect(extractFileReceipt("make_xlsx", line(0))).toBeUndefined();
    expect(extractFileReceipt("make_xlsx", line(-5))).toBeUndefined();
    expect(extractFileReceipt("make_xlsx", line(Number.NaN))).toBeUndefined();
    expect(extractFileReceipt("make_xlsx", line(Number.POSITIVE_INFINITY))).toBeUndefined();
    expect(extractFileReceipt("make_xlsx", line("1536"))).toBeUndefined();
  });
  it("empty / whitespace-only results → undefined; trailing blank lines are skipped (末个非空行)", () => {
    expect(extractFileReceipt("make_xlsx", "")).toBeUndefined();
    expect(extractFileReceipt("make_xlsx", "   \n  \n")).toBeUndefined();
    expect(extractFileReceipt("make_xlsx", `${XLSX_RECEIPT}\n\n`)).toEqual({
      path: "/tmp/ws/报表.xlsx",
      name: "报表.xlsx",
      bytes: 1536,
    });
  });
  it("non-object JSON (number/string/null/bool/array) → undefined", () => {
    for (const tail of ["42", '"str"', "null", "true", "[1,2]"]) {
      expect(extractFileReceipt("make_xlsx", `一句\n${tail}`)).toBeUndefined();
    }
  });
  it("empty strings and trailing-separator relativePath fail closed", () => {
    const line = (o: Record<string, unknown>) => `一句\n${JSON.stringify(o)}`;
    expect(extractFileReceipt("make_xlsx", line({ path: "", relativePath: "a.xlsx", bytes: 1 }))).toBeUndefined();
    expect(extractFileReceipt("make_xlsx", line({ path: "/a.xlsx", relativePath: "", bytes: 1 }))).toBeUndefined();
    expect(extractFileReceipt("make_xlsx", line({ path: "/a.xlsx", relativePath: "dir/", bytes: 1 }))).toBeUndefined();
  });
  it("name = basename(relativePath) — nested dirs split on both separators", () => {
    const line = (rel: string) => `一句\n${JSON.stringify({ path: "/w/" + rel, relativePath: rel, bytes: 9 })}`;
    expect(extractFileReceipt("make_xlsx", line("sub/q4.xlsx"))).toMatchObject({ name: "q4.xlsx" });
    expect(extractFileReceipt("make_pptx", line("季度\\deck.pptx"))).toMatchObject({ name: "deck.pptx" });
  });
  it("never throws on pathological input", () => {
    expect(() => extractFileReceipt("make_xlsx", "{oops")).not.toThrow();
    expect(() => extractFileReceipt("make_xlsx", "中文".repeat(10_000))).not.toThrow();
  });
});

// --- driver wiring: tool_call_finished lands `file` on the tool entry -------

const wait = () => new Promise<void>((r) => setTimeout(r, 10));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}
const allow = vi.fn(async () => ({ kind: "allow" as const }));

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, ...opts });
}

function deliverableStub(name: string, content: string, isError = false): Tool {
  return buildTool({
    name,
    description: "stub deliverable",
    parameters: {
      type: "object",
      properties: { filename: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    execute: async () => ({ content, isError }),
  });
}

describe("ω99-125 A — driver lands `file` on the tool history entry", () => {
  it("make_xlsx receipt → the tool entry carries {path,name,bytes} verbatim", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "make_xlsx", arguments: { filename: "报表.xlsx" } }] },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({ model, tools: [deliverableStub("make_xlsx", XLSX_RECEIPT)], onPermissionAsk: allow });
    await wait();
    driver.submit("做个表");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const entry = driver.getHistory().find((e) => e.kind === "tool") as { kind: "tool"; file?: unknown } | undefined;
    expect(entry).toBeTruthy();
    expect(entry?.file).toEqual({ path: "/tmp/ws/报表.xlsx", name: "报表.xlsx", bytes: 1536 });
  });

  it("make_pptx receipt → same landing (pptx shape)", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "make_pptx", arguments: { filename: "汇报.pptx" } }] },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({ model, tools: [deliverableStub("make_pptx", PPTX_RECEIPT)], onPermissionAsk: allow });
    await wait();
    driver.submit("做个演示文稿");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const entry = driver.getHistory().find((e) => e.kind === "tool") as { kind: "tool"; file?: unknown } | undefined;
    expect(entry?.file).toEqual({ path: "/tmp/ws/汇报.pptx", name: "汇报.pptx", bytes: 10137 });
  });

  it("isError results never carry file (red line: 错误卡不带文件卡)", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "make_xlsx", arguments: {} }] },
      { role: "assistant", content: "FAILED RUN" },
    ]);
    const driver = makeDriver({
      model,
      tools: [deliverableStub("make_xlsx", "make_xlsx: 写入失败（disk full）", true)],
      onPermissionAsk: allow,
    });
    await wait();
    driver.submit("做个表");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const entry = driver.getHistory().find((e) => e.kind === "tool") as { kind: "tool"; isError?: boolean; file?: unknown } | undefined;
    expect(entry?.isError).toBe(true);
    expect((entry as { file?: unknown } | undefined)?.file).toBeUndefined();
  });

  it("name gate holds at the driver too: read_file with a receipt tail gets no file", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({ model, tools: [deliverableStub("read_file", XLSX_RECEIPT)], onPermissionAsk: allow });
    await wait();
    driver.submit("读一下");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const entry = driver.getHistory().find((e) => e.kind === "tool") as { kind: "tool"; file?: unknown } | undefined;
    expect(entry).toBeTruthy();
    expect(entry?.file).toBeUndefined();
  });
});

