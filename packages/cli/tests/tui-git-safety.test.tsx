// M37 §3 — the git-safety warning in the TUI: a high-risk git shell ask
// renders the warning block above the y/a/N menu (the menu itself and the
// pipeline decision are unchanged — answering y still executes the command).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
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

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wudao-tui-git-"));
  mkdirSync(join(root, ".git"), { recursive: true }); // inside a git repo
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runCommandTool(executed: string[]): Tool {
  return buildTool({
    name: "shell",
    description: "stub shell",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    async execute({ command }) {
      executed.push(String(command));
      return { content: `ran ${String(command)}` };
    },
  });
}

describe("WudaoApp git-safety ask (M37 §3)", () => {
  it("git reset --hard ask shows the warning block; y still allows (no blocking)", async () => {
    const executed: string[] = [];
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "shell", arguments: { command: "git reset --hard HEAD~1" } }] },
      { role: "assistant", content: "GIT-DONE" },
    ]);
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64000}
        modelOverride={model}
        tools={[runCommandTool(executed)]}
        gates={{ verify: false }}
      />,
    );
    await wait();
    await type(inst.stdin, "reset it\r");
    await until(() => (inst.lastFrame() ?? "").includes("high-risk git command"), "git risk warning");
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("git reset --hard");
    expect(frame).toContain("discards");
    // The ask menu is still the normal one.
    expect(frame).toContain("🔑 允许 shell");
    expect(frame).toContain("[y/a/p/N]");

    // Informational only: y allows and the command RUNS.
    // M45: yield a tick — the prompt mounts after the started-event hop.
    await wait();
    inst.stdin.write("y");
    await until(() => (inst.lastFrame() ?? "").includes("GIT-DONE"), "run to finish");
    expect(executed).toEqual(["git reset --hard HEAD~1"]);
    inst.unmount();
  }, 15000);

  it("a safe git command (0.3.14: the accept tier's read-only class) runs WITHOUT asking or warning", async () => {
    const executed: string[] = [];
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "shell", arguments: { command: "git status" } }] },
      { role: "assistant", content: "STATUS-DONE" },
    ]);
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64000}
        modelOverride={model}
        tools={[runCommandTool(executed)]}
        gates={{ verify: false }}
      />,
    );
    await wait();
    await type(inst.stdin, "check status\r");
    // The read-only class auto-allows in the default accept tier: no ask
    // mounts, the command just runs (the 4.7 layer's whole point).
    await until(() => (inst.lastFrame() ?? "").includes("STATUS-DONE"), "run to finish");
    expect(executed).toEqual(["git status"]);
    expect(inst.lastFrame() ?? "").not.toContain("🔑 允许 shell");
    expect(inst.lastFrame() ?? "").not.toContain("high-risk git command");
    inst.unmount();
  }, 15000);
});
