// Full-render integration tests for WudaoApp: ink-testing-library drives the
// real TextInput (stdin writes) against a scripted model and the rendered
// frame is asserted end-to-end (header, user echo, answer, diff, help).
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { ModelClient, ModelInput, Tool } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { WudaoApp, LiveArea } from "../src/tui/app.js";
import { TEAMMATE_PREAMBLE } from "../src/teams/runtime.js";
import { loadSkills, buildSkillInvocationMessage } from "../src/skills.js";
import { buildExtensionState, initExtensionRuntime, rescanExtensions, resetExtensionRuntime } from "../src/extension-state.js";
import { resetProviderRegistryCacheForTests } from "../src/provider-registry.js";
import { stripProjectedNotes } from "./projected-notes.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// Poll until cond() holds; ALWAYS yields a macrotask before the first check so
// React 19 flushes batched state updates first (mirrors use-agent.test.tsx).
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

// ink-testing-library delivers a multi-char stdin.write as ONE input chunk (no
// per-key parsing), so text must be fed character by character with an await
// between writes (React 19 batching) — "\r" alone parses as the return key.
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

/** 夜移 010: a read tool whose every call targets credential material — the
 *  TUI-parity probe (auto mode must STILL prompt, with the 🔐 context line). */
function stubCredentialReadTool(): Tool {
  return buildTool({
    name: "read_file",
    description: "stub credential read",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async () => ({ content: "SECRET-BYTES" }),
  });
}

describe("WudaoApp", () => {
  it("renders header with model, user echo, and the scripted answer; persists the run to the session JSONL", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "TUI-OK-ANSWER" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();
    expect(inst.lastFrame() ?? "").toContain(config.model);
    expect(inst.lastFrame() ?? "").toContain("模式 "); // ω99-190: 钉随源演进（header 暗行+状态条 mode 段中文化，census 兜出）

    await type(inst.stdin, "hi\r");
    await until(() => (inst.lastFrame() ?? "").includes("TUI-OK-ANSWER"), "scripted answer in frame");

    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("hi"); // dim user echo
    expect(frame).toContain("TUI-OK-ANSWER");
    inst.unmount();

    // Session persistence: the completed run landed in <root>/.wudao/sessions/<id>.jsonl
    const sessDir = join(root, ".wudao", "sessions");
    // Poll for BOTH lines, not the file's existence: the user line persists
    // before the first model call (夜移 017) and the assistant line at run
    // settle — a file-existence wait passes on the first append, then a
    // single read races the second under load (gate-red 0.3.20, solo-green;
    // the 532419a bookkeeping-race family). Torn mid-append reads throw in
    // JSON.parse and retry on the next poll.
    await until(() => {
      try {
        const file = readdirSync(sessDir).find((f) => f.endsWith(".jsonl")) ?? "";
        if (file === "") return false;
        const ls = readFileSync(join(sessDir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { role: string; content: string });
        return ls.some((m) => m.role === "user" && m.content === "hi") && ls.some((m) => m.role === "assistant" && m.content === "TUI-OK-ANSWER");
      } catch { return false; }
    }, "the run (user + assistant) to persist to the session JSONL");
    const file = readdirSync(sessDir).find((f) => f.endsWith(".jsonl")) ?? "";
    expect(file).toMatch(/\.jsonl$/);
    const lines = readFileSync(join(sessDir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { role: string; content: string; type?: string });
    // Order-insensitive vs the session_name entry (both land around the same
    // instant; which append completes first is not a contract).
    expect(lines.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
    expect(lines.some((m) => m.role === "assistant" && m.content === "TUI-OK-ANSWER")).toBe(true);
  });

  it("renders an edit tool call as a diff (✏️ plus - / + lines) after the ask-mode approval", async () => {
    const model = createScriptedModel([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "edit", arguments: { path: "a.ts", old_string: "hello", new_string: "world" } }],
      },
      { role: "assistant", content: "EDITED-DONE" },
    ]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[stubEditTool()]} gates={{ verify: false }} initialPermissionMode="ask" />,
    );
    await wait();

    await type(inst.stdin, "fix\r");
    // default mode → the edit call surfaces the PermissionPrompt before running
    await until(() => (inst.lastFrame() ?? "").includes("🔑"), "permission prompt to appear");
    // M45: yield a tick — the prompt mounts after the started-event hop.
    await wait();
    inst.stdin.write("y");
    await until(() => (inst.lastFrame() ?? "").includes("EDITED-DONE"), "edit run to finish");

    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("✏️");
    expect(frame).toContain("- hello");
    expect(frame).toContain("+ world");
    inst.unmount();
  });

  it("夜移 009: answering `a` at the gate records the session rule WITH a receipt naming its scope", async () => {
    const model = createScriptedModel([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "edit", arguments: { path: "a.ts", old_string: "hello", new_string: "world" } }],
      },
      { role: "assistant", content: "EDITED-DONE" },
    ]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-a9-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[stubEditTool()]} gates={{ verify: false }} initialPermissionMode="ask" />,
    );
    await wait();

    await type(inst.stdin, "fix\r");
    await until(() => (inst.lastFrame() ?? "").includes("🔑"), "permission prompt to appear");
    await wait();
    // `a` = allow + record the session rule — 夜移 009 pins that the receipt
    // rides notify (the same channel `p`'s receipt uses), naming the exact
    // scope granted instead of landing silently.
    inst.stdin.write("a");
    await until(() => (inst.lastFrame() ?? "").includes("EDITED-DONE"), "edit run to finish");

    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("permissions: session rule \"");
    inst.unmount();
  });

  it("夜移 010: auto mode still prompts on credential material, with the 🔐 context line", async () => {
    const model = createScriptedModel([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "~/.ssh/id_rsa" } }],
      },
      { role: "assistant", content: "READ-DONE" },
    ]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-a10-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[stubCredentialReadTool()]} gates={{ verify: false }} initialPermissionMode="auto" />,
    );
    await wait();

    await type(inst.stdin, "read the key\r");
    // 4.65: auto cannot silently allow credential material — the prompt MUST
    // appear even though the mode would allow everything else.
    await until(() => (inst.lastFrame() ?? "").includes("🔑"), "credential ask to appear in auto mode");
    await wait();
    const prompted = inst.lastFrame() ?? "";
    // The human sees WHAT is being read before answering (parity with the
    // REPL gate's credentialAskWarning line).
    expect(prompted).toContain("🔐");
    expect(prompted).toContain("~/.ssh/id_rsa");

    inst.stdin.write("y");
    await until(() => (inst.lastFrame() ?? "").includes("READ-DONE"), "read run to finish");
    inst.unmount();
  });

  it("renders dim subagent notices for task-tool events (tool started with summary, finished with preview)", async () => {
    // No `tools` prop: the app builds the real tool set (incl. the task tool)
    // around the scripted model, so the subagent loop consumes the same script.
    const model = createScriptedModel([
      // parent run: delegate to the task tool
      { role: "assistant", content: "", toolCalls: [{ id: "p1", name: "task", arguments: { description: "read a file", prompt: "go read" } }] },
      // subagent run: one read_file call, then a final answer
      { role: "assistant", content: "", toolCalls: [{ id: "s1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "SUBAGENT DONE" },
      // parent run: final answer
      { role: "assistant", content: "ALL DONE" },
    ]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-sub-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} />,
    );
    await wait();

    await type(inst.stdin, "delegate\r");
    // default mode → the task call surfaces the PermissionPrompt; approve it
    await until(() => (inst.lastFrame() ?? "").includes("🔑"), "task permission prompt to appear");
    // M45: yield a tick — the prompt mounts after the started-event hop.
    await wait();
    inst.stdin.write("y");
    await until(() => (inst.lastFrame() ?? "").includes("ALL DONE"), "parent run to finish");

    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("↳ subagent 🔧 read_file: a.txt");
    expect(frame).toContain("↳ subagent ↳");
    inst.unmount();
  });

  it("submitting while busy steers the current run (⏳ steering line → ↳ steering applied)", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const gatedRead = buildTool({
      name: "read_file",
      description: "gated read",
      parameters: { type: "object" as const, properties: { path: { type: "string" as const } }, required: ["path"], additionalProperties: false },
      execute: async () => { await gate; return { content: "ok" }; },
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "slow.txt" } }] },
      { role: "assistant", content: "A-DONE" },
      { role: "assistant", content: "B-DONE" },
    ]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-q-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[gatedRead]} />,
    );
    await wait();

    await type(inst.stdin, "one\r");
    await until(() => (inst.lastFrame() ?? "").includes("slow.txt"), "tool phase");

    // Input stays live while busy: the mid-run submit parks in the steering
    // queue and renders as a dim ⏳ line in the live area.
    await type(inst.stdin, "two\r");
    // ω99-161: 排队注入行随源演进（半角冒号无空格，同 160 #3 字节）。
    await until(() => (inst.lastFrame() ?? "").includes("⏳ 将在下一步前注入:two"), "steering line in frame");

    release?.();
    await until(() => (inst.lastFrame() ?? "").includes("A-DONE"), "steered run to finish");
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("↳ steering applied");
    // The steer was injected into the CURRENT run — no second run happened.
    expect(frame).not.toContain("B-DONE");
    inst.unmount();
  });

  it("a failed session save surfaces a ⚠️ notice instead of an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    // A FILE at <root>/.wudao makes the session-dir mkdir fail (ENOTDIR), so
    // every store.append rejects — the .catch must turn that into a notice.
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-p-"));
    writeFileSync(join(root, ".wudao"), "not a directory");
    const model = createScriptedModel([{ role: "assistant", content: "OK" }]);
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();

    await type(inst.stdin, "hi\r");
    await until(() => (inst.lastFrame() ?? "").includes("会话保存失败"), "save-failure notice");
    expect(inst.lastFrame() ?? "").toContain("⚠️ 会话保存失败");
    await wait(30);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    inst.unmount();
  });

  it("/help shows the command list including the \\+Enter hint", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "x" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();

    await type(inst.stdin, "/help\r");
    await until(() => (inst.lastFrame() ?? "").includes("/exit"), "help text to appear");
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("/clear");
    expect(frame).toContain("\\+Enter");
    inst.unmount();
  });

  it("shows the resident cache N% footer from session-cumulative usage (M24)", async () => {
    // A scripted model that reports per-call prompt usage through the M24
    // onUsage channel; the TUI tracks it on the wrapped model.
    let call = 0;
    const model = {
      async generate(input: import("@wudao/core").ModelInput) {
        call += 1;
        input.onUsage?.(
          call === 1
            ? { promptTokens: 2000, cacheHitTokens: 0, cacheMissTokens: 2000 }
            : { promptTokens: 4000, cacheHitTokens: 3400, cacheMissTokens: 600 },
        );
        return { role: "assistant" as const, content: `CACHE-ANSWER-${call}` };
      },
    };
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-cache-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();
    expect(inst.lastFrame() ?? "").not.toContain("cache ");

    await type(inst.stdin, "one\r");
    await until(() => (inst.lastFrame() ?? "").includes("CACHE-ANSWER-1"), "first answer");
    // First call: nothing was cached yet → 0% (already past the 1KB floor).
    await until(() => (inst.lastFrame() ?? "").includes("cache 0%"), "cache footer after first call");

    await type(inst.stdin, "two\r");
    await until(() => (inst.lastFrame() ?? "").includes("CACHE-ANSWER-2"), "second answer");
    // Cumulative: (0 + 3400) / (2000 + 4000) = 56.7% → 57%.
    await until(() => (inst.lastFrame() ?? "").includes("cache 57%"), "cumulative cache footer");
    inst.unmount();
  });
});

describe("WudaoApp — long-task board (M23)", () => {
  it("renders board lines (☑/◐/☐) and the busy progress indicator ▣ N/M", async () => {
    const board = "[todo board 2/3 done]\n☑ read the spec\n☑ write the code\n◐ verify it";
    const todoStub = buildTool({
      name: "todo_write",
      description: "stub board",
      parameters: { type: "object", properties: { todos: { type: "array" } }, required: ["todos"], additionalProperties: false },
      execute: async () => ({ content: board }),
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const parkedRead = buildTool({
      name: "read_file",
      description: "parked",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      execute: async () => { await gate; return { content: "late" }; },
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { todos: [] } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "read_file", arguments: { path: "x" } }] },
    ]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-board-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[todoStub, parkedRead]} />,
    );
    await wait();

    await type(inst.stdin, "plan\r");
    await until(() => (inst.lastFrame() ?? "").includes("▣ 2/3"), "busy board progress");
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("☑ read the spec");
    expect(frame).toContain("◐ verify it");
    release?.();
    await wait(50);
    inst.unmount();
  });
  // -------------------------------------------------------------------------
  // M27: /skill:name in the TUI routes through parseReplCommand like every
  // other command — found skills submit the full SKILL.md as a <skill> user
  // message; unknown names surface the listing notice.
  // -------------------------------------------------------------------------

  it("/skill:name submits the full SKILL.md as a <skill> user message", async () => {
    const inputs: ModelInput[] = [];
    const model = {
      async generate(input: ModelInput) {
        inputs.push(input);
        return { role: "assistant" as const, content: "SKILL-DONE" };
      },
    };
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-skill-"));
    mkdirSync(join(root, ".wudao", "skills", "alpha"), { recursive: true });
    const fileText = "---\nname: alpha\ndescription: Alpha rules\n---\n\n# Alpha\n\nDo it right.\n";
    writeFileSync(join(root, ".wudao", "skills", "alpha", "SKILL.md"), fileText, "utf8");
    const skills = loadSkills(root);
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} skills={skills} />,
    );
    await wait();

    await type(inst.stdin, "/skill:alpha fix the login bug\r");
    await until(() => (inst.lastFrame() ?? "").includes("SKILL-DONE"), "skill run to finish");
    expect(inputs.length).toBe(1);
    const alpha = skills[0];
    const lastUser = stripProjectedNotes(inputs[0]?.messages ?? []).filter((m) => m.role === "user").at(-1);
    expect(skills.length).toBe(1);
    expect(lastUser?.content).toBe(`<skill name="alpha" args="fix the login bug">\n${fileText}\n</skill>`);
    expect(alpha && lastUser?.content === buildSkillInvocationMessage(alpha, "fix the login bug")).toBe(true);
    inst.unmount();
  });

  // cc-plugins A3 review fix (MEDIUM): after a rescanExtensions() swap, the
  // next render's driver.setOptions must carry the LIVE skills — the old
  // `props.skills ?? []` read clobbered the swapped list straight back to
  // boot, so /skill:<new> failed with a stale listing despite the swap.
  it("a rescanExtensions swap survives the re-render: /skill:<new> resolves through the live overlay", async () => {
    const inputs: ModelInput[] = [];
    const model = {
      async generate(input: ModelInput) {
        inputs.push(input);
        return { role: "assistant" as const, content: "RESCAN-SKILL-OK" };
      },
    };
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-rescan-"));
    const home = mkdtempSync(join(tmpdir(), "wudao-tui-rescan-home-"));
    mkdirSync(join(root, ".wudao", "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, ".wudao", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Alpha rules\n---\nalpha body", "utf8");
    const env = { ...process.env, WUDAO_GLOBAL_HOME: home };
    const boot = await buildExtensionState(root, [], { warn: () => {}, env });
    initExtensionRuntime(root, [], boot, { warn: () => {}, env });
    try {
      const inst = render(
        <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} skills={boot.skills} />,
      );
      await wait();
      // install a NEW skill post-boot, then rescan: the mounted sink lands the
      // live overlay (React state + driver.replaceExtensions), and the next
      // render's setOptions must feed the LIVE list (the regression would
      // clobber o.skills back to the boot props right here)
      mkdirSync(join(root, ".wudao", "skills", "beta"), { recursive: true });
      writeFileSync(join(root, ".wudao", "skills", "beta", "SKILL.md"), "---\nname: beta\ndescription: Beta rules\n---\nbeta body", "utf8");
      const counts = await rescanExtensions();
      expect(counts.skills).toBe(2);
      await wait(50); // React flushes extLive → re-render → setOptions(live)

      await type(inst.stdin, "/skill:beta hi\r");
      await until(() => (inst.lastFrame() ?? "").includes("RESCAN-SKILL-OK"), "swapped-skill run to finish");
      expect(inputs.length).toBe(1);
      const lastUser = stripProjectedNotes(inputs[0]?.messages ?? []).filter((m) => m.role === "user").at(-1);
      expect(lastUser?.content).toContain('<skill name="beta" args="hi">');
      expect(lastUser?.content).toContain("beta body");
      inst.unmount();
    } finally {
      resetExtensionRuntime();
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("an unknown /skill:name surfaces the ⚠️ listing notice and runs nothing", async () => {
    let calls = 0;
    const model = {
      async generate(_input: ModelInput) {
        calls += 1;
        return { role: "assistant" as const, content: "never" };
      },
    };
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-skill2-"));
    mkdirSync(join(root, ".agents", "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Alpha rules\n---\nbody", "utf8");
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} skills={loadSkills(root)} />,
    );
    await wait();

    await type(inst.stdin, "/skill:nope\r");
    await until(() => (inst.lastFrame() ?? "").includes("no skill named"), "skill error notice");
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("no skill named \"nope\"");
    expect(frame).toContain("- alpha — Alpha rules (path: .agents/skills/alpha/SKILL.md)");
    await wait(30);
    expect(calls).toBe(0); // nothing was submitted to the model
    inst.unmount();
  });

  // M33 §3: the /resume picker — /resume lists the 10 most recent sessions,
  // a bare number loads one (divider + rotated session id + name in header).
  it("/resume lists recent sessions and a number loads the picked one", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-resume-"));
    mkdirSync(join(root, ".wudao", "sessions"), { recursive: true });
    const seeded = [
      JSON.stringify({ type: "session_name", name: "fix-the-login-bug" }),
      JSON.stringify({ type: "model_change", model: "deepseek-v4-flash", provider: "deepseek", at: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ role: "user", content: "Fix the login bug" }),
      JSON.stringify({ role: "assistant", content: "fixed it" }),
    ].join("\n") + "\n";
    writeFileSync(join(root, ".wudao", "sessions", "seeded99.jsonl"), seeded, "utf8");

    const model = createScriptedModel([{ role: "assistant", content: "RESUMED-ANSWER" }]);
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();

    await type(inst.stdin, "/resume\r");
    await until(() => (inst.lastFrame() ?? "").includes("1) seeded99"), "picker to list the seeded session");
    const frame1 = inst.lastFrame() ?? "";
    expect(frame1).toContain("fix-the-login-bug");
    expect(frame1).toContain("enter a number");

    // A bad number keeps the picker open with guidance.
    await type(inst.stdin, "7\r");
    await until(() => (inst.lastFrame() ?? "").includes("no session 7"), "bad pick guidance");

    // Pick 1: the session loads (divider + header carries id + name), and a
    // follow-up prompt runs on top of the loaded history.
    await type(inst.stdin, "1\r");
    await until(() => (inst.lastFrame() ?? "").includes("↪ 已恢复 seeded99 · 2 条消息"), "resumed divider"); // ω99-166f-iii: 钉随源演进
    expect(inst.lastFrame() ?? "").toContain("fix-the-login-bug");

    await type(inst.stdin, "thanks\r");
    await until(() => (inst.lastFrame() ?? "").includes("RESUMED-ANSWER"), "post-resume run to finish");
    // The persisted session grew by this run only (loaded base respected).
    // Persistence is fire-and-forget — wait for the write to land.
    const seededPath = join(root, ".wudao", "sessions", "seeded99.jsonl");
    await until(() => {
      try { return readFileSync(seededPath, "utf8").includes("thanks"); } catch { return false; }
    }, "post-resume run to persist");
    inst.unmount();
    const lines = readFileSync(seededPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { role?: string; content?: string; type?: string });
    expect(lines.filter((l) => l.role === "user" && l.content === "thanks").length).toBe(1);
    expect(lines.some((l) => l.role === "assistant" && l.content === "RESUMED-ANSWER")).toBe(true);
    expect(lines.filter((l) => l.type === "session_name").length).toBe(1);
  }, 15000);
});


// ---------------------------------------------------------------------------
// OOM fix — bounded live render. ink 7's measure-text/wrap-text caches key on
// the FULL rendered string and never evict, so rendering an ever-growing
// streaming accumulation retains every prefix (O(n²) heap → 4GB OOM). The
// LiveArea must therefore only ever render bounded tails.
// ---------------------------------------------------------------------------
describe("LiveArea — bounded streaming render (OOM fix)", () => {
  const quiet = { reasoning: "", answer: "", busyTools: [] };

  it("renders a bounded tail of a huge streaming answer", () => {
    const inst = render(
      <LiveArea live={{ ...quiet, answer: "A".repeat(10_000) }} queued={[]} />,
    );
    const frame = inst.lastFrame() ?? "";
    // The full 10K answer must NOT be rendered; a 4000-char tail + marker does.
    expect(frame.length).toBeLessThan(5_000);
    expect(frame).toContain("…");
    expect(frame).toContain("AAAA");
    inst.unmount();
  });

  it("renders short answers in full (no marker)", () => {
    const inst = render(<LiveArea live={{ ...quiet, answer: "短答案" }} queued={[]} />);
    expect(inst.lastFrame()).toContain("短答案");
    expect(inst.lastFrame() ?? "").not.toContain("…");
    inst.unmount();
  });

  it("collapses multi-line reasoning to its last line", () => {
    const inst = render(
      <LiveArea live={{ ...quiet, reasoning: "第一行\n第二行\n当前思考" }} queued={[]} />,
    );
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("…");
    expect(frame).toContain("当前思考");
    expect(frame).not.toContain("第一行");
    inst.unmount();
  });

  it("collapses a single reasoning line longer than 400 chars, capped to its last 400", () => {
    const head = "头".repeat(500);
    const tail = "尾".repeat(500);
    const inst = render(<LiveArea live={{ ...quiet, reasoning: head + tail }} queued={[]} />);
    // ink wraps at terminal width — assert on the newline-stripped frame.
    const flat = (inst.lastFrame() ?? "").replace(/\n/g, "");
    expect(flat).toContain("…");
    expect(flat).toContain("尾".repeat(400));
    expect(flat).not.toContain("头");
    // The rendered reasoning is bounded by the 400-char cap (+ marker).
    expect(flat.length).toBeLessThan(500);
    inst.unmount();
  });

  it("renders single-line reasoning ≤400 chars verbatim", () => {
    const inst = render(<LiveArea live={{ ...quiet, reasoning: "短思考".repeat(100) }} queued={[]} />);
    const flat = (inst.lastFrame() ?? "").replace(/\n/g, "");
    expect(flat).toContain("短思考".repeat(100));
    expect(flat).not.toContain("…");
    inst.unmount();
  });
});

// m64c-fix-2 regression: a run snapshots its tool set (and the getTeam seam it
// captured) at start, so getTeam must read the runtime's identity from a ref
// AT CALL TIME — not from the `team` state captured in the closure. Within ONE
// run, a second teammate spawn must resolve the SAME runtime the first spawn
// created; with the closure bug it saw `team === null` forever, created a
// second runtime, and orphaned the first (the panel, reading state, followed
// the newest runtime and the earlier teammate vanished).
describe("m64c-fix-2: team runtime identity across spawns in one run", () => {
  it("two teammates spawned in one run share one runtime; the panel lists both", async () => {
    // Routing model: teammate briefs (TEAMMATE_PREAMBLE system prompt) get a
    // one-shot answer; the main loop scripts alice → bob → final text by
    // counting the task tool results already in its input.
    const model: ModelClient = {
      async generate(input) {
        if (typeof input.systemPrompt === "string" && input.systemPrompt.startsWith(TEAMMATE_PREAMBLE)) {
          return { role: "assistant", content: "teammate done" };
        }
        const spawns = input.messages.filter((m) => m.role === "tool").length;
        if (spawns === 0) {
          return {
            role: "assistant", content: "",
            toolCalls: [{ id: "c1", name: "task", arguments: { description: "spawn alice", prompt: "brief alice", teammate: "alice" } }],
          };
        }
        if (spawns === 1) {
          return {
            role: "assistant", content: "",
            toolCalls: [{ id: "c2", name: "task", arguments: { description: "spawn bob", prompt: "brief bob", teammate: "bob" } }],
          };
        }
        return { role: "assistant", content: "SPAWNED-BOTH-DONE" };
      },
    };
    const root = mkdtempSync(join(tmpdir(), "wudao-fix2-"));
    const inst = render(
      // No `tools` prop: buildToolSet wires the real tool set, including the
      // task tool with the session's team seam.
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} />,
    );
    try {
      await type(inst.stdin, "go\r");
      // mode ask: the task tool asks permission per call — approve both
      // spawns as their prompts appear. `y` alone allows (NO Enter: a stray
      // return key on a freshly mounted ask resolves it as deny), and we
      // wait for each ask to clear before looking for the next one so a
      // stale frame can't double-fire.
      for (let i = 0; i < 2; i++) {
        await until(() => (inst.lastFrame() ?? "").includes("允许 task？"), `task permission prompt #${i + 1}`, 20000);
        // M45: yield a tick — the prompt's input handler mounts after the
        // started-event hop (a y written on the first frame is swallowed).
        await wait();
        inst.stdin.write("y");
        await until(() => !(inst.lastFrame() ?? "").includes("允许 task？"), `permission #${i + 1} resolves`, 20000);
      }
      await until(() => (inst.lastFrame() ?? "").includes("SPAWNED-BOTH-DONE"), "main run finishes", 20000);
      // The panel reads the `team` state. With the closure bug, bob's spawn ran
      // through the stale run-start snapshot (team still null in its closure) →
      // a second runtime was created, setTeam(R2) repointed the panel, and
      // alice's runtime was orphaned → only bob rendered. With the ref fix both
      // teammates live in the one runtime the panel shows. Anchor on the ROW
      // format (`name (role)`) — a denied/echoed call would also contain the
      // bare name, but only a live teammate renders a row.
      await until(() => {
        const f = inst.lastFrame() ?? "";
        return f.includes("alice (") && f.includes("bob (");
      }, "panel lists both teammates", 20000);
    } finally {
      inst.unmount();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

// Provider management §7 (T2 review I1) — the TUI recomputes the context
// window on a /model switch: the per-model registry chain (contextLength →
// provider default → env) replaces the static boot value, and the driver's
// /context report (which reads o.compaction.contextWindowTokens at command
// time) shows the SWITCHED model's window.
describe("WudaoApp §7 — window recompute on /model switch", () => {
  it("/model <registry model> switches /context's window from the boot env value to the model's contextLength", async () => {
    const home = mkdtempSync(join(tmpdir(), "wudao-tui-win-"));
    const savedHome = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    resetProviderRegistryCacheForTests();
    writeFileSync(
      join(home, "providers.json"),
      JSON.stringify({
        version: 1,
        providers: { deepseek: { models: [{ name: "big-128k", contextLength: 128000 }] } },
      }),
      "utf8",
    );
    const model = createScriptedModel([{ role: "assistant", content: "OK" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-w2-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[stubEditTool()]} gates={{ verify: false }} />,
    );
    try {
      await wait();
      // Boot: the model is uncataloged → the env-side boot value 64,000.
      await type(inst.stdin, "/context\r");
      await until(() => (inst.lastFrame() ?? "").includes("64,000 tokens"), "boot window renders 64,000");
      // Switch to the registry-cataloged model — the window must follow.
      await type(inst.stdin, "/model big-128k\r");
      await until(() => (inst.lastFrame() ?? "").includes("模型 → deepseek/big-128k"), "model switch receipt"); // ω99-195: 钉随源演进
      await type(inst.stdin, "/context\r");
      await until(() => (inst.lastFrame() ?? "").includes("128,000 tokens"), "switched window renders 128,000");
      // The boot /context notice stays in the scrollback; assert the NEWEST
      // context line reports the switched window (128,000), not the boot one.
      const contextLines = (inst.lastFrame() ?? "").split("\n").filter((l) => l.startsWith("context: "));
      expect(contextLines.at(-1)).toContain("128,000 tokens");
    } finally {
      inst.unmount();
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      resetProviderRegistryCacheForTests();
      if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = savedHome;
    }
  }, 30000);
});
