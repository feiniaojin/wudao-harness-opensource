// ω99-59 — the TUI's in-transcript find: /find <query> opens a result
// overlay (same ownership pattern as ask/permission), searching the
// STRUCTURED history entries (never the rendered text) with two pinned
// match semantics — case-insensitive substring, and tokenize.ts word hits
// for CJK (no-space segmentation). This file pins the pure core, the panel
// component's navigation state machine, and the app-level wiring.
import { describe, it, expect } from "vitest";
import React, { useState } from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { findInHistory, parseFindCommand, FIND_MAX_SHOWN } from "../src/tui/find-core.js";
import { FindPanel } from "../src/tui/find.js";
import { WudaoApp } from "../src/tui/app.js";
import type { HistoryEntry } from "../src/tui/use-agent.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

// ── the pure core: command grammar ──────────────────────────────────────

describe("parseFindCommand", () => {
  it("parses bare /find and /find <query> with surrounding whitespace trimmed", () => {
    expect(parseFindCommand("/find")).toEqual({ query: "" });
    expect(parseFindCommand("/find   error  ")).toEqual({ query: "error" });
    expect(parseFindCommand("  /find Error Handling ")).toEqual({ query: "Error Handling" });
  });

  it("keeps prefix-neighbors and non-find lines out (they stay prompts)", () => {
    expect(parseFindCommand("/findx")).toBeUndefined();
    expect(parseFindCommand("/finder error")).toBeUndefined();
    expect(parseFindCommand("find error")).toBeUndefined();
    expect(parseFindCommand("/search error")).toBeUndefined();
    expect(parseFindCommand("")).toBeUndefined();
  });
});

// ── the pure core: match semantics ──────────────────────────────────────

const HISTORY: readonly HistoryEntry[] = [
  { kind: "user", text: "deploy the service" },
  { kind: "assistant", text: "Retry with backoff — see Error: connection refused" },
  { kind: "tool", name: "read_file", summary: "path=src/x.ts", resultPreview: "120 lines read" },
  { kind: "error", text: "Error: boom" },
];

describe("findInHistory — substring mode (latin query)", () => {
  it("matches case-insensitively: entry 'Error', query 'error' (the pinned case)", () => {
    const r = findInHistory(HISTORY, "error");
    expect(r.mode).toBe("substring");
    expect(r.matches.map((m) => m.index)).toEqual([1, 3]);
    expect(r.matches[0]?.label).toBe("assistant");
    expect(r.matches[0]?.contextLine).toContain("Error");
  });

  it("matches the other direction too: query capital over lowercase text", () => {
    const r = findInHistory(HISTORY, "REFUSED");
    expect(r.matches.map((m) => m.index)).toEqual([1]);
  });

  it("searches tool metadata: a tool-name query hits the tool entry via its name field", () => {
    const r = findInHistory(HISTORY, "read_file");
    expect(r.matches.map((m) => m.index)).toEqual([2]);
    expect(r.matches[0]?.label).toBe("tool:read_file");
    expect(r.matches[0]?.field).toBe("name");
  });

  it("searches edit paths and notice text (the full structured surface)", () => {
    const hist: readonly HistoryEntry[] = [
      { kind: "edit", path: "src/tui/find.tsx", oldString: "a", newString: "b" },
      { kind: "notice", text: "cache may be cold" },
    ];
    expect(findInHistory(hist, "find.tsx").matches[0]?.index).toBe(0);
    expect(findInHistory(hist, "cold").matches[0]?.index).toBe(1);
  });

  it("returns an empty match set for a query that hits nothing", () => {
    expect(findInHistory(HISTORY, "zzz-not-there").matches).toEqual([]);
  });

  it("truncates long context lines deterministically around the hit", () => {
    const longTail = `${"x".repeat(200)}NEEDLE${"y".repeat(200)}`;
    const r = findInHistory([{ kind: "assistant", text: longTail }] as const, "needle");
    const line = r.matches[0]?.contextLine ?? "";
    expect(line).toContain("NEEDLE");
    expect(line.startsWith("…")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(120);
  });
});

describe("findInHistory — token mode (CJK query, tokenize.ts segmentation)", () => {
  it("a space-separated CJK query hits text whose characters are not contiguous (no-space segmentation path)", () => {
    // Substring proof-of-value: the exact needle is NOT in the text.
    const text = "会话的上下文与管理策略";
    expect(text.includes("上下文 管理")).toBe(false);
    const r = findInHistory([{ kind: "assistant", text }] as const, "上下文 管理");
    expect(r.mode).toBe("token");
    expect(r.matches.map((m) => m.index)).toEqual([0]);
    expect(r.matches[0]?.contextLine).toContain("上下文");
  });

  it("a latin query does not hit CJK-only entries (no cross-script false positives)", () => {
    const hist: readonly HistoryEntry[] = [{ kind: "assistant", text: "错误处理已完成" }];
    const r = findInHistory(hist, "error");
    expect(r.mode).toBe("substring");
    expect(r.matches).toEqual([]);
  });

  it("a mixed latin+CJK query tokenizes both scripts and requires every word", () => {
    // tokenize.ts keeps hyphens inside a word run ("glm-4" is ONE token), so
    // the query must ask for the whole word — pinned here on purpose.
    const hist: readonly HistoryEntry[] = [
      { kind: "assistant", text: "GLM-4 的上下文窗口是 128k" },
      { kind: "assistant", text: "GLM-4 的价格说明" },
    ];
    const r = findInHistory(hist, "GLM-4 上下文");
    expect(r.mode).toBe("token");
    expect(r.matches.map((m) => m.index)).toEqual([0]);
  });

  it("a punctuation-only query is robust: no matches, no crash", () => {
    const r = findInHistory(HISTORY, "，。！");
    expect(r.matches).toEqual([]);
  });
});

describe("findInHistory — empty query", () => {
  it("an empty/whitespace query never matches (the caller refuses to open the panel)", () => {
    expect(findInHistory(HISTORY, "").matches).toEqual([]);
    expect(findInHistory(HISTORY, "   ").matches).toEqual([]);
  });
});

// ── the panel component: navigation state machine ──────────────────────

const PANEL_HISTORY: readonly HistoryEntry[] = [
  { kind: "user", text: "what handles retries" },
  { kind: "assistant", text: "Retry with backoff — see Error: connection refused" },
  { kind: "tool", name: "read_file", summary: "path=src/x.ts", resultPreview: "120 lines read" },
  { kind: "error", text: "Error: boom" },
];

function PanelHarness({ query, history }: { query: string; history: readonly HistoryEntry[] }): React.JSX.Element {
  const [closed, setClosed] = useState(false);
  if (closed) return <Text>PANEL-CLOSED</Text>;
  return <FindPanel query={query} history={history} onClose={() => setClosed(true)} />;
}

describe("FindPanel — results list", () => {
  it("renders index/label/context rows with the selector on the first row", async () => {
    const inst = render(<PanelHarness query="error" history={PANEL_HISTORY} />);
    await wait();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("find: error");
    expect(frame).toContain("子串");
    expect(frame).toContain("2 命中");
    expect(frame).toContain("1) #1 assistant");
    expect(frame).toContain("2) #3 error");
    expect(frame).toContain("Error: connection refused");
    expect(frame).toContain("▸ 1)");
    expect(frame).not.toContain("▸ 2)");
    inst.unmount();
  });

  it("caps rendered rows at FIND_MAX_SHOWN and hints the overflow", async () => {
    const big: HistoryEntry[] = Array.from({ length: FIND_MAX_SHOWN + 5 }, (_, i) => ({
      kind: "user" as const,
      text: `error occurrence number ${i}`,
    }));
    const inst = render(<PanelHarness query="error" history={big} />);
    await wait();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain(`1) #0 user`);
    expect(frame).toContain(`${FIND_MAX_SHOWN}) #${FIND_MAX_SHOWN - 1} user`);
    expect(frame).not.toContain(`#${FIND_MAX_SHOWN} user`);
    expect(frame).toContain("另有 5 条");
    inst.unmount();
  });
});

describe("FindPanel — navigation", () => {
  it("↓ moves the selector, ↑ clamps at the top", async () => {
    const inst = render(<PanelHarness query="error" history={PANEL_HISTORY} />);
    await wait();
    inst.stdin.write("\x1b[B");
    await until(() => (inst.lastFrame() ?? "").includes("▸ 2)"), "selector to move down");
    expect(inst.lastFrame() ?? "").not.toContain("▸ 1)");
    inst.stdin.write("\x1b[A");
    await until(() => (inst.lastFrame() ?? "").includes("▸ 1)"), "selector to move up");
    inst.stdin.write("\x1b[A");
    await wait(50);
    expect(inst.lastFrame() ?? "").toContain("▸ 1)"); // clamped — still the first row
    inst.unmount();
  });

  it("Enter expands the selected entry; Esc steps back to the list; a second Esc closes", async () => {
    const inst = render(<PanelHarness query="error" history={PANEL_HISTORY} />);
    await wait();
    inst.stdin.write("\x1b[B"); // select the error entry (#3)
    await until(() => (inst.lastFrame() ?? "").includes("▸ 2)"), "selector on row 2");
    inst.stdin.write("\r");
    await until(() => (inst.lastFrame() ?? "").includes("第 2/2"), "focused view");
    expect(inst.lastFrame() ?? "").toContain("Error: boom");
    expect(inst.lastFrame() ?? "").toContain("Esc 返回");
    inst.stdin.write("\x1b");
    await until(() => (inst.lastFrame() ?? "").includes("▸ 2)"), "back to the list");
    inst.stdin.write("\x1b");
    await until(() => (inst.lastFrame() ?? "").includes("PANEL-CLOSED"), "panel closed");
    inst.unmount();
  });

  it("↓↑ keep working while focused — the view flips between matches live", async () => {
    const inst = render(<PanelHarness query="error" history={PANEL_HISTORY} />);
    await wait();
    inst.stdin.write("\x1b[B");
    await until(() => (inst.lastFrame() ?? "").includes("▸ 2)"), "row 2 selected");
    inst.stdin.write("\r");
    await until(() => (inst.lastFrame() ?? "").includes("第 2/2"), "focused on match 2");
    inst.stdin.write("\x1b[A"); // previous match while focused
    await until(() => (inst.lastFrame() ?? "").includes("第 1/2"), "focused flips to match 1");
    expect(inst.lastFrame() ?? "").toContain("connection refused");
    inst.unmount();
  });

  it("ctrl+c closes the panel from the list", async () => {
    const inst = render(<PanelHarness query="error" history={PANEL_HISTORY} />);
    await wait();
    inst.stdin.write("\x03");
    await until(() => (inst.lastFrame() ?? "").includes("PANEL-CLOSED"), "ctrl+c closed");
    inst.unmount();
  });
});

describe("FindPanel — empty state", () => {
  it("a no-hit query renders an explicit empty state; Enter is a no-op", async () => {
    const inst = render(<PanelHarness query="zzz-not-there" history={PANEL_HISTORY} />);
    await wait();
    expect(inst.lastFrame() ?? "").toContain("无命中");
    inst.stdin.write("\r");
    await wait(50);
    expect(inst.lastFrame() ?? "").toContain("无命中"); // still the empty state, no crash
    inst.unmount();
  });
});

// ── the app wiring: /find through the real WudaoApp ────────────────────

const CONFIG: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

describe("WudaoApp /find wiring", () => {
  it("/find <query> opens the overlay over the live transcript; Esc restores the input; /find works again", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "部署遇到 Error: connection refused，检查重试配置" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-find-"));
    const inst = render(<WudaoApp config={CONFIG} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />);
    await wait();
    await type(inst.stdin, "diag\r");
    await until(() => (inst.lastFrame() ?? "").includes("connection refused"), "answer to land");
    await type(inst.stdin, "/find error\r");
    await until(() => (inst.lastFrame() ?? "").includes("find: error"), "find panel to open");
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("🔍");
    expect(frame).toMatch(/#\d+ assistant/);
    // the intercepted command line never entered the transcript as a user turn
    expect(frame).not.toContain("› /find error");
    // Enter expands the selected entry at the app level too
    inst.stdin.write("\r");
    await until(() => (inst.lastFrame() ?? "").includes("Esc 返回"), "focused view at app level");
    inst.stdin.write("\x1b");
    // "Enter 展开全文" is list-only (the focused header also says 命中, so
    // that marker cannot order these two Esc presses).
    await until(() => (inst.lastFrame() ?? "").includes("Enter 展开全文"), "back to the list");
    // Esc closes → the input row is back (its hint line)
    inst.stdin.write("\x1b");
    await until(() => !(inst.lastFrame() ?? "").includes("find: error"), "panel to close");
    expect(inst.lastFrame() ?? "").toContain("Enter 发送"); // ω99-161: HINT 串随源演进。
    // the state machine is back to idle — a second /find opens again
    await type(inst.stdin, "/find connection\r");
    await until(() => (inst.lastFrame() ?? "").includes("find: connection"), "second find to open");
    inst.stdin.write("\x1b");
    await until(() => !(inst.lastFrame() ?? "").includes("find: connection"), "second close");
    inst.unmount();
  });

  it("bare /find shows usage and does NOT open the panel", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-find-"));
    const inst = render(<WudaoApp config={CONFIG} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />);
    await wait();
    await type(inst.stdin, "/find\r");
    await until(() => (inst.lastFrame() ?? "").includes("用法：/find"), "usage notice"); // ω99-166d-i: 钉头串演进（#37 头换）
    await wait(100);
    expect(inst.lastFrame() ?? "").not.toContain("find:");
    inst.unmount();
  });

  it("a no-hit query shows the explicit empty state in the app", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "some answer" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-find-"));
    const inst = render(<WudaoApp config={CONFIG} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />);
    await wait();
    await type(inst.stdin, "hello\r");
    await until(() => (inst.lastFrame() ?? "").includes("some answer"), "answer to land");
    await type(inst.stdin, "/find nosuchtoken\r");
    await until(() => (inst.lastFrame() ?? "").includes("无命中"), "empty state");
    inst.stdin.write("\x1b");
    await until(() => !(inst.lastFrame() ?? "").includes("无命中"), "panel closed");
    inst.unmount();
  });

  it("typing /fi surfaces the find command in the suggestion menu; Tab completes", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-find-"));
    const inst = render(<WudaoApp config={CONFIG} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />);
    await wait();
    await type(inst.stdin, "/fi");
    await until(() => (inst.lastFrame() ?? "").includes("search the current transcript"), "menu row for find");
    expect(inst.lastFrame() ?? "").toContain("/find");
    inst.stdin.write("\t");
    await until(() => (inst.lastFrame() ?? "").includes("\u203a /find"), "tab-completed buffer");
    inst.unmount();
  });

  it("a CJK query runs token mode over the live transcript", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "会话的上下文与管理策略如下" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-find-"));
    const inst = render(<WudaoApp config={CONFIG} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />);
    await wait();
    await type(inst.stdin, "plan\r");
    await until(() => (inst.lastFrame() ?? "").includes("管理策略"), "answer to land");
    await type(inst.stdin, "/find 上下文 管理\r");
    await until(() => (inst.lastFrame() ?? "").includes("find: 上下文 管理"), "panel open");
    expect(inst.lastFrame() ?? "").toContain("词");
    expect(inst.lastFrame() ?? "").toContain("命中");
    inst.stdin.write("\x1b");
    await until(() => !(inst.lastFrame() ?? "").includes("find:"), "close");
    inst.unmount();
  });
});
