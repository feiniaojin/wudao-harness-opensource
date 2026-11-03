// M34 §1 — ask_user in the TUI: the model's question renders inline as a
// numbered option list, a digit picks the label (the tool result carries it
// verbatim), free-text questions take a line input, and Esc dismisses (the
// run continues on the error result).
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
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

const askTurn = {
  role: "assistant" as const,
  content: "",
  toolCalls: [
    {
      id: "a1",
      name: "ask_user",
      arguments: {
        question: "Flag or no flag?",
        options: [{ label: "flag" }, { label: "no flag", description: "direct release" }],
      },
    },
  ],
};

describe("WudaoApp ask_user", () => {
  it("renders the question with numbered options; a digit picks the label and the run continues", async () => {
    const model = createScriptedModel([askTurn, { role: "assistant", content: "USER-PICKED-FLAG" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();

    await type(inst.stdin, "deploy\r");
    await until(() => (inst.lastFrame() ?? "").includes("❓ Flag or no flag?"), "ask_user prompt to appear");
    let frame = inst.lastFrame() ?? "";
    expect(frame).toContain("1) flag");
    expect(frame).toContain("2) no flag — direct release");
    // ω99-161: 选项版提示行中文化（#5——159 已改自由输入版，两版同尾）。
    expect(frame).toContain("(按 1-2 选择 · Esc 取消、交回 agent 决定)");
    // ask_user needs no permission ask (it IS the ask).
    expect(frame).not.toContain("🔑");

    // M45: yield a tick — the prompt mounts after the started-event hop.
    await wait();
    inst.stdin.write("1");
    await until(() => (inst.lastFrame() ?? "").includes("USER-PICKED-FLAG"), "run to finish after the pick");
    frame = inst.lastFrame() ?? "";
    // The chosen label rode the tool result into the transcript preview.
    expect(frame).toContain("flag");
    inst.unmount();
  });

  it("free-text questions take a typed line answer", async () => {
    const model = createScriptedModel([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "a1", name: "ask_user", arguments: { question: "Which service?" } }],
      },
      { role: "assistant", content: "GOT-BILLING" },
    ]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();

    await type(inst.stdin, "migrate\r");
    await until(() => (inst.lastFrame() ?? "").includes("❓ Which service?"), "free-text ask prompt");
    await type(inst.stdin, "billing");
    // M45: yield a tick — the prompt mounts after the started-event hop.
    await wait();
    inst.stdin.write("\r");
    await until(() => (inst.lastFrame() ?? "").includes("GOT-BILLING"), "run to finish after the typed answer");
    inst.unmount();
  });

  it("Esc dismisses the question — the run continues on the error result", async () => {
    const model = createScriptedModel([askTurn, { role: "assistant", content: "DECIDED-MYSELF" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();

    await type(inst.stdin, "deploy\r");
    await until(() => (inst.lastFrame() ?? "").includes("❓ Flag or no flag?"), "ask_user prompt");
    // M45: yield a tick — the prompt mounts after the started-event hop.
    await wait();
    inst.stdin.write("\x1b");
    await until(() => (inst.lastFrame() ?? "").includes("DECIDED-MYSELF"), "run to finish after dismissal");
    // The dismissal surfaced as an errored ask_user tool entry.
    expect(inst.lastFrame() ?? "").toContain("[error]");
    inst.unmount();
  });

  it("@-mentions expand before the prompt enters the conversation (M34 §2)", async () => {
    const { writeFileSync, readFileSync, readdirSync } = await import("node:fs");
    const model = createScriptedModel([{ role: "assistant", content: "MENTION-EXPANDED-OK" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-"));
    writeFileSync(join(root, "note.md"), "MENTION-SENTINEL-3402\n", "utf8");
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();

    await type(inst.stdin, "summarize @note.md\r");
    await until(() => (inst.lastFrame() ?? "").includes("MENTION-EXPANDED-OK"), "answer after mention expansion");

    // The persisted user turn carries the <file> envelope, not the bare token.
    const sessDir = join(root, ".wudao", "sessions");
    // #48: the sessions root also carries the `.leases` dir — the glob must
    // pick the session FILE, not whatever readdir lists first.
    const sessionFile = (): string => readdirSync(sessDir).find((n) => n.endsWith(".jsonl")) ?? "";
    // Poll for the USER line itself (the first append can be the session_name
    // entry — the dir being non-empty is not enough).
    await until(() => {
      try {
        const f = sessionFile();
        if (f === "") return false;
        return readFileSync(join(sessDir, f), "utf8").split("\n").some((l) => l.includes('"role":"user"'));
      } catch {
        return false;
      }
    }, "persisted user line to appear");
    const file = sessionFile();
    const userLine = readFileSync(join(sessDir, file), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { role?: string; content?: string })
      .find((e) => e.role === "user");
    expect(userLine?.content).toContain('<file path="note.md">');
    expect(userLine?.content).toContain("MENTION-SENTINEL-3402");
    expect(userLine?.content).toContain("</file>");
    inst.unmount();
  });
});
