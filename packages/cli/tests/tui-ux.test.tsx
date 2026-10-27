// M42 §3 — shift+tab runtime mode cycling in the TUI: the \x1b[Z sequence is
// captured before any Esc-interrupt interpretation, the status bar's mode
// segment updates live, a dim notice fires, and — the load-bearing part — the
// permission gate reads the CURRENT mode (a canUseTool closure over a mutable
// mode ref), so a tool call that would ask at startup runs without asking
// after two shifts to auto.
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { Tool } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { WudaoApp } from "../src/tui/app.js";

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

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

const editParams = {
  type: "object" as const,
  properties: {
    path: { type: "string" as const },
    old_string: { type: "string" as const },
    new_string: { type: "string" as const },
  },
  required: ["path", "old_string", "new_string"],
  additionalProperties: false,
};

function stubEditTool(): Tool {
  return buildTool({
    name: "edit",
    description: "stub edit",
    parameters: editParams,
    execute: async () => ({ content: "ok" }),
  });
}

const SHIFT_TAB = "\x1b[Z";

describe("WudaoApp shift+tab mode cycling (M42 §3)", () => {
  it("cycles workspace → ask → auto → plan → workspace, updating the status bar and printing the dim notice", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "x" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-mode-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();
    expect(inst.lastFrame() ?? "").toContain("模式 accept"); // ω99-190: 钉随源演进（状态栏 mode 段中文化，census 兜出）

    inst.stdin.write(SHIFT_TAB);
    await until(() => (inst.lastFrame() ?? "").includes("模式 ask"), "status bar to show 模式 ask"); // ω99-190: 钉随源演进
    expect(inst.lastFrame() ?? "").toContain("模式 → ask"); // dim notice（ω99-175: #1 钉随源演进；状态栏 mode X 非本弧面）

    inst.stdin.write(SHIFT_TAB);
    await until(() => (inst.lastFrame() ?? "").includes("模式 auto"), "status bar to show 模式 auto"); // ω99-190: 钉随源演进
    expect(inst.lastFrame() ?? "").toContain("模式 → auto"); // dim notice（ω99-175: #1）

    // 0.3.14: plan is the fourth stop — read-only 探查, no interrupt asks.
    inst.stdin.write(SHIFT_TAB);
    await until(() => (inst.lastFrame() ?? "").includes("模式 plan"), "status bar to show 模式 plan"); // ω99-190: 钉随源演进
    expect(inst.lastFrame() ?? "").toContain("模式 → plan"); // dim notice（ω99-175: #1）

    inst.stdin.write(SHIFT_TAB);
    await until(() => {
      const f = inst.lastFrame() ?? "";
      return f.includes("模式 accept") && !f.includes("模式 auto"); // ω99-190: 钉随源演进
    }, "cycle back to 模式 accept");
    inst.unmount();
  });

  it("shift+tab never reaches the Esc-interrupt branch while busy", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const gatedEdit = buildTool({
      name: "edit",
      description: "gated edit",
      parameters: editParams,
      execute: async () => { await gate; return { content: "ok" }; },
    });
    // auto mode from the start (argv snapshot): the run goes straight into
    // the tool and parks there — then shift+tabs must not abort it.
    const origArgv = process.argv;
    process.argv = [...origArgv, "--auto"];
    try {
      const model = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "edit", arguments: { path: "a.ts", old_string: "x", new_string: "y" } }] },
        { role: "assistant", content: "DONE-BUSY" },
      ]);
      const root = mkdtempSync(join(tmpdir(), "wudao-tui-busy-"));
      const inst = render(
        <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[gatedEdit]} gates={{ verify: false }} />,
      );
      await wait();
      await type(inst.stdin, "go\r");
      await until(() => (inst.lastFrame() ?? "").includes("edit"), "tool phase");
      inst.stdin.write(SHIFT_TAB); // auto → plan mid-run — must NOT interrupt
      inst.stdin.write(SHIFT_TAB); // plan → workspace
      await wait(60);
      expect(inst.lastFrame() ?? "").not.toContain("⚠️ 已中断"); // ω99-166c-ii: 负钉同步演进（=driver.test:2832 同裁定）。
      release?.();
      await until(() => (inst.lastFrame() ?? "").includes("DONE-BUSY"), "run to finish un-interrupted");
      inst.unmount();
    } finally {
      process.argv = origArgv;
    }
  });

  it("the permission gate reads the CURRENT mode: shift to ask and the edit asks (workspace would have run it free)", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "edit", arguments: { path: "a.ts", old_string: "hello", new_string: "world" } }] },
      { role: "assistant", content: "EDITED-ACCEPTED" },
    ]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-gate-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[stubEditTool()]} gates={{ verify: false }} />,
    );
    await wait();

    // Startup is workspace (the file-edit class auto-allows) — cycle to ask
    // BEFORE submitting; the gate must consult the live mode, not the argv
    // snapshot (M58 §C#1 inverted: a prompt here proves the live read).
    inst.stdin.write(SHIFT_TAB);
    await until(() => (inst.lastFrame() ?? "").includes("模式 ask"), "模式 ask"); // ω99-190: 钉随源演进
    await type(inst.stdin, "fix\r");
    await until(() => (inst.lastFrame() ?? "").includes("🔑"), "ask-mode permission prompt (the live mode, not the boot snapshot)");
    // M45: yield a tick — the prompt's useInput subscribes after the frame
    // already shows 🔑 (paint beats the passive effect); a key written in
    // that window is seen only by the App's handler, which stands down on a
    // pending ask — dropped, and the parked run waits forever.
    await wait();
    inst.stdin.write("y"); // allow once — the run completes
    await until(() => (inst.lastFrame() ?? "").includes("EDITED-ACCEPTED"), "tool run to finish");
    inst.unmount();
  }, 20000);

  it("mid-run cycling reaches the gate: a denied ask, then shift+tab to auto, and the retry runs unasked", async () => {
    const script = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "edit", arguments: { path: "a.ts", old_string: "h", new_string: "w" } }] },
      { role: "assistant", content: "FIRST-DENIED" },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "edit", arguments: { path: "b.ts", old_string: "h", new_string: "w" } }] },
      { role: "assistant", content: "SECOND-RAN" },
    ];
    const model = createScriptedModel(script);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-mid-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[stubEditTool()]} gates={{ verify: false }} />,
    );
    await wait();

    // Workspace (the boot mode) would auto-allow the edit — cycle to ask so
    // the first run genuinely hits the gate.
    inst.stdin.write(SHIFT_TAB);
    await until(() => (inst.lastFrame() ?? "").includes("模式 ask"), "cycled to ask before the run"); // ω99-190: 钉随源演进
    await type(inst.stdin, "go\r");
    await until(() => (inst.lastFrame() ?? "").includes("🔑"), "ask-mode permission prompt");
    // Deny with an empty reason: `n` opens the reason input, Enter confirms.
    inst.stdin.write("n");
    await wait();
    inst.stdin.write("\r");
    await until(() => (inst.lastFrame() ?? "").includes("FIRST-DENIED"), "first run settles on deny");

    // Between runs, ONE shift+tab flips the live mode ask → auto (the
    // 0.3.12 cycle has no intermediate tier); the next run's gate sees it.
    inst.stdin.write(SHIFT_TAB);
    await until(() => (inst.lastFrame() ?? "").includes("模式 auto"), "cycled to auto between runs"); // ω99-190: 钉随源演进
    await type(inst.stdin, "again\r");
    await until(() => (inst.lastFrame() ?? "").includes("SECOND-RAN"), "second run to finish");
    expect(inst.lastFrame() ?? "").not.toContain("🔑 允许 edit：b.ts"); // ω99-158: 随源中文化
    inst.unmount();
  });
});

// ---------------------------------------------------------------------------
// M42 §4 — command ergonomics: /clear's single-key y/N confirmation, /help
// rendered from the listSlashCommands source, and the --continue
// investigation (a resumed startup can never print the clear notice).
// ---------------------------------------------------------------------------
describe("WudaoApp /clear confirmation + /help + --continue (M42 §4)", () => {
  const RESUME_HISTORY = [
    { role: "user" as const, content: "remember the codename M42CONT-OK" },
    { role: "assistant" as const, content: "codename noted" },
  ];

  it("/clear parks on a single-key y/N confirm; n keeps the history", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "x" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-clr-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} resumeHistory={RESUME_HISTORY} sessionId="wudao-clear-1" />,
    );
    await wait();
    expect(inst.lastFrame() ?? "").toContain("已恢复 wudao-cl"); // divider = history present // ω99-172: 钉随源演进（漏判钉）

    await type(inst.stdin, "/clear\r");
    // ω99-159: 确认框文案中文化——等待串随源演进。
    await until(() => (inst.lastFrame() ?? "").includes("🗑 清空历史——开一个全新会话？"), "confirm prompt");
    // Still unconfirmed: the history stays visible.
    expect(inst.lastFrame() ?? "").toContain("已恢复 wudao-cl"); // ω99-172: 钉随源演进（漏判钉）

    inst.stdin.write("n");
    // ω99-161: 取消回执串随源演进（等待语义不变）。
    await until(() => (inst.lastFrame() ?? "").includes("(已取消清空)"), "cancel notice");
    expect(inst.lastFrame() ?? "").toContain("已恢复 wudao-cl"); // history intact // ω99-172: 钉随源演进（漏判钉）
    inst.unmount();
  });

  it("/clear + y wipes to a fresh session", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "x" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-clr2-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} resumeHistory={RESUME_HISTORY} sessionId="wudao-clear-2" />,
    );
    await wait();

    await type(inst.stdin, "/clear\r");
    // ω99-159: 确认框文案中文化——等待串随源演进。
    await until(() => (inst.lastFrame() ?? "").includes("🗑 清空历史——开一个全新会话？"), "confirm prompt");
    // M45: yield a tick — the prompt mounts after the started-event hop.
    await wait();
    inst.stdin.write("y");
    // ω99-161: 清空回执串随源演进（等待语义不变）。
    await until(() => (inst.lastFrame() ?? "").includes("(历史已清空——开启全新会话)"), "cleared notice");
    // Static residue: already-flushed entries stay on screen (Ink cannot
    // retract them) — the CONTRACT is the rotated session id: the header and
    // the status bar carry the fresh id, never the seeded one.
    const frame = inst.lastFrame() ?? "";
    const headerAndBar = frame.split("\n").filter((l) => l.includes("wudao · ") || l.includes("session "));
    expect(headerAndBar.some((l) => l.includes("wudao-cl"))).toBe(false); // old id8 gone from the live lines
    inst.unmount();
  });

  it("/help renders from listSlashCommands with the current mode and the key table", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "x" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-hlp-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();

    await type(inst.stdin, "/help\r");
    await until(() => (inst.lastFrame() ?? "").includes("命令："), "help to render"); // ω99-162: 隐藏钉·commands: 头同串机械演进。
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("/exit");
    expect(frame).toContain("/plan <goal>");
    expect(frame).toContain("/rewind [n|last|turn [n]]");
    expect(frame).toContain("\\+Enter");
    // ω99-161: /help 键表默认 keysLine 随源演进（切模式子句在场语义不变）。
    expect(frame).toContain("shift+tab 切换模式");
    expect(frame).toContain("模式：accept"); // ω99-162: 隐藏钉·mode: 行同串机械演进。
    // cycling updates what the next /help says
    inst.stdin.write(SHIFT_TAB);
    await until(() => (inst.lastFrame() ?? "").includes("模式 ask"), "模式 ask"); // ω99-190: 钉随源演进
    await type(inst.stdin, "/help\r");
    await until(() => (inst.lastFrame() ?? "").includes("模式：ask"), "help shows the live mode"); // ω99-162: 隐藏钉·mode: 行同串机械演进。
    inst.unmount();
  });

  it("--continue investigation: a resumed startup shows the resumed divider and NEVER the history-cleared notice", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "x" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-cont-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} resumeHistory={RESUME_HISTORY} sessionId="wudao-cont-1234" />,
    );
    await wait();
    await wait(50); // give any startup side-effect a moment to (wrongly) fire
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("已恢复 wudao-co"); // resumed divider (M25 §A1) // ω99-172: 钉随源演进（漏判钉）
    expect(frame).toContain("2 条消息"); // ω99-172: 钉随源演进（漏判钉）
    // ω99-161: 否定钉随源演进——不演则恒真失验（对象换新串）。
    expect(frame).not.toContain("历史已清空");
    inst.unmount();
  });
});
