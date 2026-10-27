// M37 §1 — plan mode in the TUI: /plan starts a read-only run (whitelist
// denials surface as errored tool entries), the produced board renders with a
// review hint, `ok` submits the execution run (normal tools), and `改 <意见>`
// re-runs in plan mode.
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel, createTodoTool } from "@wudao/core";
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

function stubTool(name: string): Tool {
  return buildTool({
    name,
    description: `stub ${name}`,
    parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    async execute() {
      return { content: `${name} executed` };
    },
  });
}

const PLAN_TOOLS: Tool[] = [
  stubTool("read_file"),
  stubTool("glob"),
  stubTool("grep"),
  stubTool("write_file"),
  stubTool("edit"),
  stubTool("shell"),
  createTodoTool({}),
];

describe("WudaoApp plan mode (M37 §1)", () => {
  it("/plan runs read-only: a write attempt is denied naming plan mode, the board renders, ok → execution run", async () => {
    const model = createScriptedModel([
      // Plan run: the model tries to write (denied by the whitelist), then
      // creates the plan board, then answers.
      { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "src/x.ts" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "todo_write", arguments: { todos: [{ content: "read the code", status: "pending" }, { content: "add the feature", status: "pending" }] } }] },
      { role: "assistant", content: "PLAN-READY-SENTINEL" },
      // Execution run (after `ok`): normal tools — the write now executes.
      { role: "assistant", content: "", toolCalls: [{ id: "w2", name: "write_file", arguments: { path: "src/x.ts" } }] },
      { role: "assistant", content: "EXECUTED-PLAN-SENTINEL" },
    ]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-plan-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={PLAN_TOOLS} gates={{ verify: false, todo: false }} initialPermissionMode="ask" />,
    );
    await wait();

    await type(inst.stdin, "/plan add the feature\r");
    await until(() => (inst.lastFrame() ?? "").includes("PLAN-READY-SENTINEL"), "plan run to finish");

    let frame = inst.lastFrame() ?? "";
    // The plan request envelope entered the conversation (user echo).
    expect(frame).toContain("<plan-request>");
    // The out-of-whitelist write was DENIED with a plan-mode reason — no 🔑 ask.
    expect(frame).toContain("write_file");
    expect(frame).toContain("plan mode");
    expect(frame).not.toContain("🔑");
    // The plan board rendered, with the review hint.
    expect(frame).toContain("📋 board 0/2 done");
    expect(frame).toContain("☐ read the code");
    expect(frame.toLowerCase()).toContain("ok");

    // `ok` → execution run with normal tools: the same write_file now goes to
    // the normal ask pipeline (default mode) — answer y — and executes.
    await type(inst.stdin, "ok\r");
    await until(() => (inst.lastFrame() ?? "").includes("🔑 允许 write_file"), "execution write_file ask");
    // M45: yield a tick — the prompt mounts after the started-event hop.
    await wait();
    inst.stdin.write("y");
    await until(() => (inst.lastFrame() ?? "").includes("EXECUTED-PLAN-SENTINEL"), "execution run to finish");
    frame = inst.lastFrame() ?? "";
    expect(frame).toContain("<plan-approved>");
    // The same write_file call now EXECUTED (stub result, no denial).
    expect(frame).toContain("write_file executed");
    inst.unmount();
  }, 20000);

  it("改 <意见> keeps the session in plan mode: the revision runs read-only and updates the board under review", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "todo_write", arguments: { todos: [{ content: "step one", status: "pending" }] } }] },
      { role: "assistant", content: "PLAN-V1" },
      // Revision run: still plan mode — a shell attempt is denied.
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "shell", arguments: { command: "ls" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "t2", name: "todo_write", arguments: { todos: [{ content: "step one", status: "pending" }, { content: "step two (split)", status: "pending" }] } }] },
      { role: "assistant", content: "PLAN-V2" },
    ]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-plan-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={PLAN_TOOLS} />,
    );
    await wait();

    await type(inst.stdin, "/plan ship it\r");
    await until(() => (inst.lastFrame() ?? "").includes("PLAN-V1"), "first plan run");
    await type(inst.stdin, "改 split step one\r");
    await until(() => (inst.lastFrame() ?? "").includes("PLAN-V2"), "revision run");
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("<plan-revision>");
    // The revision's shell was denied (plan mode still on).
    expect(frame).toContain("permission denied");
    // The NEW board is the one under review.
    expect(frame).toContain("step two (split)");
    // The feedback rode the revision user message into the persisted history
    // (the frame only echoes its first line).
    await until(
      () => {
        try {
          const dir = join(root, ".wudao", "sessions");
          // #48: skip the `.leases` dir — only session FILES are readable.
          const names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
          return names.some((n) => readFileSync(join(dir, n), "utf8").includes("split step one"));
        } catch {
          return false;
        }
      },
      "revision feedback persisted",
    );
    inst.unmount();
  }, 20000);

  it("bare /plan answers with usage guidance and runs nothing", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "NEVER-RUN" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-plan-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={PLAN_TOOLS} />,
    );
    await wait();
    await type(inst.stdin, "/plan\r");
    await until(() => (inst.lastFrame() ?? "").includes("/plan <goal>"), "usage notice");
    expect(model.calls).toBe(0);
    expect(inst.lastFrame() ?? "").not.toContain("NEVER-RUN");
    inst.unmount();
  });
});
