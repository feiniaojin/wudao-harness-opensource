// ω99-131 — TUI 交付物文件卡 tests. Full-render integration: a stubbed
// make_xlsx returns the REAL receipt shape, so the real driver's
// extractFileReceipt must land `file` (never a hand-stuffed entry); the
// card renders and the JSON line dies. Plus byte pins that every other
// entry shape renders exactly as before (the zero-drift rule) and direct
// component coverage of the icon/KB derivations.
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { Tool } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { WudaoApp, HistoryItem } from "../src/tui/app.js";
import { FileCard, fileIconOf, formatKb } from "../src/tui/file-card.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// Poll until cond() holds; always yields a macrotask first so React 19
// flushes batched state updates before the first check (mirrors app.test.tsx).
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// ink-testing-library delivers one stdin.write as one input chunk — text
// must be fed character by character with an await between writes.
async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

// The real doc-xlsx receipt shape: 中文句 + "\n" + JSON (the JSON is the
// last line by construction — exactly what extractFileReceipt scans for).
const XLSX_RECEIPT =
  '已生成 Excel：测试.xlsx（2 行 × 2 列，1.0 KB）\n{"path":"/tmp/w/测试.xlsx","relativePath":"测试.xlsx","rows":2,"columns":2,"bytes":1024}';

function stubMakeXlsxTool(result: string, isError = false): Tool {
  return buildTool({
    name: "make_xlsx",
    description: "stub make_xlsx",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async () => ({ content: result, ...(isError ? { isError: true } : {}) }),
  });
}

function stubPlainReadTool(): Tool {
  return buildTool({
    name: "read_file",
    description: "stub plain read",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async () => ({ content: "plain-file-bytes" }),
  });
}

/** Drive one tool call through the REAL app + driver in auto mode (no
 *  permission hop for non-credential material) and return the settled frame. */
async function driveToolCall(tool: Tool, args: Record<string, unknown>): Promise<string> {
  const model = createScriptedModel([
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: tool.name, arguments: args }] },
    { role: "assistant", content: "RUN-DONE" },
  ]);
  const root = mkdtempSync(join(tmpdir(), "wudao-tui-fc-"));
  const inst = render(
    <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[tool]} gates={{ verify: false }} initialPermissionMode="auto" />,
  );
  await wait();
  await type(inst.stdin, "go\r");
  await until(() => (inst.lastFrame() ?? "").includes("RUN-DONE"), "run to finish");
  const frame = inst.lastFrame() ?? "";
  inst.unmount();
  return frame;
}

describe("ω99-131 TUI file card", () => {
  it("renders the make_xlsx receipt as a card (icon+name+KB+path+打开) and swallows the JSON line", async () => {
    const frame = await driveToolCall(stubMakeXlsxTool(XLSX_RECEIPT), { path: "测试.xlsx" });
    expect(frame).toContain("▣ 📊 测试.xlsx（1.0 KB）"); // accent line: mark + name + honest KB
    expect(frame).toContain("已生成 Excel：测试.xlsx（2 行 × 2 列，1.0 KB）"); // note keeps 行×列
    expect(frame).toContain("位置：/tmp/w/测试.xlsx"); // absolute path, copyable as-is
    expect(frame).toContain('打开：open "测试.xlsx"'); // 打开 = the system default application
    expect(frame).not.toContain('{"path"'); // the JSON line died with the card — the arc's point
    expect(frame).not.toContain("↳ 已生成"); // the card REPLACED the old preview line
  });

  it("zero drift: a plain tool entry still renders the dim ↳ preview line, no card", async () => {
    const frame = await driveToolCall(stubPlainReadTool(), { path: "a.txt" });
    expect(frame).toContain("↳ plain-file-bytes");
    expect(frame).not.toContain("▣");
    expect(frame).not.toContain("打开：open");
  });

  it("a failed make_xlsx never lands a card — the ⏹ [error] preview path is untouched", async () => {
    const frame = await driveToolCall(stubMakeXlsxTool("make_xlsx failed: 无法写入", true), { path: "测试.xlsx" });
    expect(frame).toContain("⏹ make_xlsx");
    expect(frame).toContain("↳ [error] make_xlsx failed: 无法写入");
    expect(frame).not.toContain("▣");
  });
});

describe("ω99-131 zero-drift byte pins (direct HistoryItem)", () => {
  it("renders the no-file and error shapes byte-identically to the pre-arc lines", () => {
    const plain = render(<HistoryItem entry={{ kind: "tool", name: "read_file", summary: "a.txt", resultPreview: "plain-file-bytes" }} />);
    expect(plain.lastFrame()).toContain("⏺ read_file(a.txt)");
    expect(plain.lastFrame()).toContain("  ↳ plain-file-bytes");
    plain.unmount();
    const err = render(<HistoryItem entry={{ kind: "tool", name: "make_xlsx", isError: true, resultPreview: "make_xlsx failed: boom" }} />);
    expect(err.lastFrame()).toContain("⏹ make_xlsx");
    expect(err.lastFrame()).toContain("  ↳ [error] make_xlsx failed: boom");
    err.unmount();
    // Defensive: even a hypothetical error entry carrying file stays on the
    // error path (the gate is file && !isError, not file alone).
    const errFile = render(<HistoryItem entry={{ kind: "tool", name: "make_xlsx", isError: true, file: { path: "/tmp/w/x.xlsx", name: "x.xlsx", bytes: 1024 }, resultPreview: "boom" }} />);
    expect(errFile.lastFrame()).toContain("  ↳ [error] boom");
    expect(errFile.lastFrame()).not.toContain("▣");
    errFile.unmount();
  });
});

describe("ω99-131 FileCard component", () => {
  it("maps the three deliverable extensions (case-insensitive) with 📦 fallback", () => {
    expect(fileIconOf("报表.xlsx")).toBe("📊");
    expect(fileIconOf("报告.DOCX")).toBe("📄");
    expect(fileIconOf("演示.pptx")).toBe("📽️");
    expect(fileIconOf("notes.txt")).toBe("📦");
    expect(fileIconOf("noext")).toBe("📦");
  });

  it("formats KB with one decimal — the receipt's own format", () => {
    expect(formatKb(1024)).toBe("1.0 KB");
    expect(formatKb(1536)).toBe("1.5 KB");
    expect(formatKb(5939)).toBe("5.8 KB");
  });

  it("renders the three card lines and drops the note line when the note is absent", () => {
    const withNote = render(
      <FileCard file={{ path: "/tmp/w/年中汇报.pptx", name: "年中汇报.pptx", bytes: 5939 }} note="已生成 PPT：年中汇报.pptx（5 页）" />,
    );
    expect(withNote.lastFrame()).toContain("▣ 📽️ 年中汇报.pptx（5.8 KB）");
    expect(withNote.lastFrame()).toContain("  已生成 PPT：年中汇报.pptx（5 页）");
    expect(withNote.lastFrame()).toContain('  位置：/tmp/w/年中汇报.pptx　打开：open "年中汇报.pptx"');
    withNote.unmount();
    const noNote = render(<FileCard file={{ path: "/tmp/w/a.docx", name: "a.docx", bytes: 2048 }} />);
    expect(noNote.lastFrame()).toContain("▣ 📄 a.docx（2.0 KB）");
    expect(noNote.lastFrame()).toContain('  位置：/tmp/w/a.docx　打开：open "a.docx"');
    expect(noNote.lastFrame() ?? "").not.toContain("已生成");
    noNote.unmount();
  });
});
