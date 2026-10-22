// M58 §C#6 — double-Esc rewind: while IDLE, two Esc presses within 400ms
// run the existing /rewind last path (M37 checkpoints); while BUSY, a single
// Esc keeps its interrupt semantics and the double-press detector never
// arms.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createFileHistory, createReadStateTable, createWriteFileTool, createScriptedModel } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { WudaoApp } from "../src/tui/app.js";
import { DOUBLE_ESC_WINDOW_MS } from "../src/tui/keybindings.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };
const ESC = "\x1b";

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wudao-tui-esc-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("WudaoApp double-Esc rewind (M58 §C#6)", () => {
  it("idle double Esc within the window runs /rewind last; the workspace bytes roll back", async () => {
    const history = createFileHistory(join(root, ".wudao", "history", "s1"));
    const readState = createReadStateTable();
    const write = createWriteFileTool({ workspaceRoot: root, history });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "a.txt", content: "v1\n" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "w2", name: "write_file", arguments: { path: "a.txt", content: "v2\n" } }] },
      { role: "assistant", content: "WROTE-DONE" },
    ]);
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64000}
        modelOverride={model}
        tools={[write]}
        gates={{ verify: false }}
        readState={readState}
        fileHistory={history}
        initialPermissionMode="ask"
      />,
    );
    await wait();

    await type(inst.stdin, "write the file\r");
    await until(() => (inst.lastFrame() ?? "").includes("🔑 允许 write_file"), "first write ask");
    await wait();
    for (let i = 0; i < 20 && !(inst.lastFrame() ?? "").includes("WROTE-DONE"); i += 1) {
      if ((inst.lastFrame() ?? "").includes("🔑")) inst.stdin.write("y");
      await wait(200);
    }
    await until(() => (inst.lastFrame() ?? "").includes("WROTE-DONE"), "write run to finish");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v2\n");

    // Idle now: two Esc presses back-to-back (well inside 400ms) → rewind last.
    inst.stdin.write(ESC);
    await wait(30);
    inst.stdin.write(ESC);
    // ω99-164: 回执钉随源演进（rewind.ts :100 共享 helper）。
    await until(() => (inst.lastFrame() ?? "").includes("已回退到第 2 步之前"), "double-Esc rewind summary");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v1\n");
    inst.unmount();
  }, 20000);

  it("a single idle Esc (window expiring) does NOT rewind", async () => {
    const history = createFileHistory(join(root, ".wudao", "history", "s2"));
    const write = createWriteFileTool({ workspaceRoot: root, history });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "b.txt", content: "v1\n" } }] },
      { role: "assistant", content: "WROTE-DONE" },
    ]);
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64000}
        modelOverride={model}
        tools={[write]}
        gates={{ verify: false }}
        fileHistory={history}
        initialPermissionMode="ask"
      />,
    );
    await wait();
    await type(inst.stdin, "write\r");
    await until(() => (inst.lastFrame() ?? "").includes("🔑 允许 write_file"), "write ask");
    await wait();
    for (let i = 0; i < 20 && !(inst.lastFrame() ?? "").includes("WROTE-DONE"); i += 1) {
      if ((inst.lastFrame() ?? "").includes("🔑")) inst.stdin.write("y");
      await wait(200);
    }
    await until(() => (inst.lastFrame() ?? "").includes("WROTE-DONE"), "run to finish");

    // One press, then let the window lapse; a second press after the window
    // only RE-ARMS — no rewind may ever fire.
    inst.stdin.write(ESC);
    await wait(DOUBLE_ESC_WINDOW_MS + 150);
    inst.stdin.write(ESC);
    await wait(300);
    // ω99-164: 防空洞否定钉随源演进（rewind.ts :100——本文件共 3 处同串钉）。
    expect(inst.lastFrame() ?? "").not.toContain("已回退到第");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("v1\n");
    inst.unmount();
  }, 20000);

  it("review IMPORTANT: an Esc that dismissed the suggestion menu does NOT arm the double-Esc rewind", async () => {
    const history = createFileHistory(join(root, ".wudao", "history", "s4"));
    const model = createScriptedModel([{ role: "assistant", content: "NEVER" }]);
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64000}
        modelOverride={model}
        tools={[]}
        fileHistory={history}
      />,
    );
    await wait();

    // "/mo" opens the slash suggestion menu (/model match).
    await type(inst.stdin, "/mo");
    await until(() => (inst.lastFrame() ?? "").includes("/model"), "suggestion menu open");

    // Esc #1 closes the menu (TextInput consumes it). Ink delivers the press
    // to the App-level detector too — the lifted menu state must make it
    // decline to arm. Esc #2 within the window must therefore NOT rewind.
    inst.stdin.write(ESC);
    await until(() => !(inst.lastFrame() ?? "").includes("/model"), "menu dismissed");
    inst.stdin.write(ESC);
    await wait(450);
    // With an empty file history, ANY rewind attempt would print the
    // empty-rewind notice — its absence proves no rewind fired.
    // ω99-165: 防空洞必演进——双 Esc 空回执出自 agent-driver.ts :3771 孪生串
    // （本弧域），源已中文化，英文钉翻转后永真空。
    expect(inst.lastFrame() ?? "").not.toContain("没有可回退的内容");
    expect(inst.lastFrame() ?? "").not.toContain("已回退到第");
    expect(model.calls).toBe(0);
    inst.unmount();

    // Control (clean empty input, same render semantics): a double-Esc DOES
    // reach the rewind path. (Covered end-to-end with a real checkpoint in
    // the first test; here we pin the empty-input control against the same
    // observable the regression case asserts the absence of.)
    const inst2 = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64000}
        modelOverride={createScriptedModel([{ role: "assistant", content: "NEVER" }])}
        tools={[]}
        fileHistory={createFileHistory(join(root, ".wudao", "history", "s5"))}
      />,
    );
    await wait();
    inst2.stdin.write(ESC);
    await wait(30);
    inst2.stdin.write(ESC);
    // ω99-165: 此钉随源演进——双 Esc 空回执出自 agent-driver.ts :3771 孪生串
    // （本弧域，164 时曾刻意停泊待本弧）。
    await until(() => (inst2.lastFrame() ?? "").includes("没有可回退的内容"), "clean double-Esc rewind fired");
    inst2.unmount();
  }, 20000);

  it("busy Esc stays the single-press interrupt — no rewind fires", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const gatedWrite = buildTool({
      name: "write_file",
      description: "gated write",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      execute: async () => { await gate; return { content: "ok" }; },
    });
    const history = createFileHistory(join(root, ".wudao", "history", "s3"));
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "c.txt" } }] },
      { role: "assistant", content: "NEVER-NEEDED" },
    ]);
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64000}
        modelOverride={model}
        tools={[gatedWrite]}
        gates={{ verify: false }}
        fileHistory={history}
        initialPermissionMode="ask"
      />,
    );
    await wait();
    await type(inst.stdin, "go\r");
    await until(() => (inst.lastFrame() ?? "").includes("🔑 允许 write_file"), "write ask");
    await wait();
    inst.stdin.write("y");
    await until(() => (inst.lastFrame() ?? "").includes("write_file"), "tool phase");
    // Busy: even a double press must interrupt, never rewind.
    inst.stdin.write(ESC);
    await wait(30);
    inst.stdin.write(ESC);
    await until(() => (inst.lastFrame() ?? "").includes("已中断"), "busy Esc interrupt"); // ω99-166c-ii: 帧钉演进 interrupted→已中断。
    release?.();
    await wait(150);
    // ω99-164: 防空洞否定钉随源演进（rewind.ts :100；brief 漏列的同型钉）。
    expect(inst.lastFrame() ?? "").not.toContain("已回退到第");
    inst.unmount();
  }, 20000);
});
