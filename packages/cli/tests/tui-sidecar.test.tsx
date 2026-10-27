// M45 — the TUI's sidecar surfaces: the status-bar `sidecar N` + breaker `🛡✕`
// segments, the busyTools 🛡 检查中 badge, the permission prompt's
// `🔑 (sidecar: <reason>)` escalation line, and (review) the task tool's
// child gate carrying the sidecar layer.
// @ts-check
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { StatusBar } from "../src/tui/status-bar.js";
import type { StatuslineSnapshot } from "../src/statusline.js";

const snap = (over: Partial<StatuslineSnapshot>): StatuslineSnapshot => ({
  version: "t",
  model: "m",
  mode: "default",
  session: { id: "s12345678", id8: "s1234567" },
  busy: false,
  queued: 0,
  ctx: null,
  cache: null,
  board: null,
  sidecar: null,
  bg: { active: 0, spawned: 0 },
  live: { answerChars: 0, reasoningChars: 0, busyTools: 0 },
  ...over,
});
import { LiveArea, WudaoApp } from "../src/tui/app.js";
import { PermissionPrompt } from "../src/tui/permission.js";
import { createSidecar } from "../src/sidecar.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// win32 under full-suite load: spawn-heavy children (git, sidecar) can
// outrun a 5s poll budget — 20s there, unchanged elsewhere (same posture
// as the det-51 15s precedent).
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = process.platform === "win32" ? 20_000 : 5_000): Promise<void> {
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

const tuiConfig: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

describe("StatusBar sidecar segments (M45)", () => {
  it("renders `sidecar N` once at least one check ran", () => {
    const r = render(<StatusBar snapshot={snap({ sidecar: { checks: 2, breakerOpen: false } })} />);
    expect(r.lastFrame()).toContain("sidecar 2");
    expect(r.lastFrame()).not.toContain("🛡✕");
  });
  it("an open breaker adds the 🛡✕ segment", () => {
    const r = render(<StatusBar snapshot={snap({ sidecar: { checks: 3, breakerOpen: true } })} />);
    expect(r.lastFrame()).toContain("sidecar 3");
    expect(r.lastFrame()).toContain("🛡✕");
  });
  it("no segment without checks / without a sidecar", () => {
    const zero = render(<StatusBar snapshot={snap({ sidecar: { checks: 0, breakerOpen: false } })} />);
    expect(zero.lastFrame()).not.toContain("sidecar");
    const none = render(<StatusBar snapshot={snap({})} />);
    expect(none.lastFrame()).not.toContain("sidecar");
  });
});

describe("LiveArea gating badge (M45 §1.6)", () => {
  it("a busy tool under sidecar check shows 🛡 检查中; a plain one does not", () => { // ω99-161: 用例名钉随源演进。
    const r = render(
      <LiveArea
        live={{
          reasoning: "",
          answer: "",
          busyTools: [
            { name: "shell", summary: "rm -rf /tmp/x", gating: true },
            { name: "read_file", summary: "a.ts" },
          ],
        }}
        queued={[]}
      />,
    );
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("shell");
    expect(frame).toContain("🛡 检查中"); // ω99-161: 徽章串随源演进。
    expect(frame).toContain("read_file");
    // only the gated line carries the badge — one occurrence
    expect(frame.split("🛡 检查中").length - 1).toBe(1); // ω99-161: 计数器钉随源演进（恰一次）。
  });
  it("the badge clears when the verdict lands", () => {
    const r = render(
      <LiveArea live={{ reasoning: "", answer: "", busyTools: [{ name: "shell", summary: "x" }] }} queued={[]} />,
    );
    // ω99-161: 否定钉随源演进——不演则恒真失验（对象换新串）。
    expect(r.lastFrame()).not.toContain("🛡 检查中");
  });
});

describe("PermissionPrompt sidecar line (M45)", () => {
  it("renders the sidecar escalation reason", () => {
    const r = render(
      <PermissionPrompt toolName="shell" summary="rm -rf /" sidecar="destructive rm -rf" onChoose={() => {}} />,
    );
    expect(r.lastFrame()).toContain("🔑 (sidecar: destructive rm -rf)");
  });
  it("no sidecar line without a reason", () => {
    const r = render(<PermissionPrompt toolName="shell" summary="rm -rf /" onChoose={() => {}} />);
    expect(r.lastFrame()).not.toContain("sidecar");
  });
});

// ---------------------------------------------------------------------------
// M45 review — subagent gate coverage: the task tool's child gate carries the
// sidecar layer, so a child's shell classifies like a top-level call.
// ---------------------------------------------------------------------------

describe("WudaoApp subagent sidecar gate (M45 review)", () => {
  it("a task-tool child's shell goes through the sidecar gate", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "p1", name: "task", arguments: { description: "run echo", prompt: "run the echo command", role: "coder" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "k1", name: "shell", arguments: { command: "echo wudao-sidecar-child" } }] },
      { role: "assistant", content: "CHILD-DONE" },
      { role: "assistant", content: "PARENT-DONE" },
    ]);
    const sidecar = createSidecar({
      model: { async generate() { return { role: "assistant", content: '{"risk":"low","reason":"routine"}' }; } },
    });
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-sub-"));
    const origArgv = process.argv;
    const origDefer = process.env.WUDAO_DEFER_TOOLS;
    process.argv = [...origArgv, "--auto"];
    process.env.WUDAO_DEFER_TOOLS = "off"; // task callable without load_tools
    let inst: ReturnType<typeof render>;
    try {
      // No props.tools → the REAL buildToolSet runs: the task tool's child
      // gate is the App's subagentGate.
      inst = render(
        <WudaoApp config={tuiConfig} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} sidecar={sidecar} gates={{ verify: false }} />,
      );
    } finally {
      process.argv = origArgv;
      if (origDefer === undefined) delete process.env.WUDAO_DEFER_TOOLS;
      else process.env.WUDAO_DEFER_TOOLS = origDefer;
    }
    await wait();
    await type(inst.stdin, "dispatch\r");
    await until(() => (inst.lastFrame() ?? "").includes("PARENT-DONE"), "run to finish", 8000);
    // TWO classifications: the parent's task call (main gate) AND the child's
    // shell (subagent gate) — before the review fix the child call
    // bypassed the classifier entirely.
    expect(sidecar.checks()).toBe(2);
    inst.unmount();
    // The until() polls were widened for win32 load; the it() ceiling must
    // clear them (default 5s < the widened budget would self-timeout first).
  }, process.platform === "win32" ? 30_000 : 10_000);
});
