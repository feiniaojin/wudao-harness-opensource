// M39 wiring: extensions ride the TUI's existing seams end to end — the
// runtime is loaded from a real .wudao/extensions fixture, its tool joins the
// toolset via extraTools (the model calls it), its session binding lets
// appendEntry land in THIS App's store, and its /ext command dispatches
// through the input path (notice → notify, ctx.submit → a user turn).
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { WudaoApp } from "../src/tui/app.js";
import { loadExtensions } from "../src/extensions/loader.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
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

const FIXTURE = `
export default function (api) {
  api.on("prompt_submit", (p) => { globalThis.__extSawPrompt = p.prompt; });
  api.registerTool({
    name: "ext_echo",
    description: "echo a value",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    execute: async (args) => ({ content: "EXT-ECHO:" + args.value }),
  });
  api.registerCommand("ext-hello", async (args, ctx) => {
    ctx.notice("EXT-NOTICE running extension command");
    ctx.submit("Please echo the value EXT-CMD-SENTINEL via ext_echo.");
    await api.appendEntry("ext_cmd_run", { args });
  });
}
`;

describe("WudaoApp extensions (M39)", () => {
  it("a loaded extension's tool joins the set, its command dispatches (notice + submit), and its entries land in the session JSONL", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-tui-ext-"));
    mkdirSync(join(root, ".wudao", "extensions"), { recursive: true });
    writeFileSync(join(root, ".wudao", "extensions", "fixture.mjs"), FIXTURE, "utf8");
    const extensions = await loadExtensions(root, { warn: () => {} });
    expect(extensions.names).toEqual(["fixture"]);
    expect(extensions.commands.map((c) => c.name)).toEqual(["ext-hello"]);

    const model = createScriptedModel([
      // The submitted turn from /ext-hello: the model calls the ext tool…
      { role: "assistant", content: "", toolCalls: [{ id: "e1", name: "ext_echo", arguments: { value: "EXT-CMD-SENTINEL" } }] },
      // …then answers.
      { role: "assistant", content: "EXT-ANSWER-SENTINEL" },
    ]);
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64000}
        modelOverride={model}
        tools={[]}
        extraTools={extensions.tools}
        extensions={extensions}
        hooks={extensions.hooks}
      />,
    );
    await wait();

    await type(inst.stdin, "/ext-hello world\r");
    // The notice line rendered…
    await until(() => (inst.lastFrame() ?? "").includes("EXT-NOTICE"), "extension notice");
    // …the ctx.submit-ed turn reached the model, which called the ext tool —
    // an ext_* tool is NOT read-only, so the permission pipeline asks (this
    // is the ext_-prefix + pipeline contract in action). Approve once.
    await until(() => (inst.lastFrame() ?? "").includes("🔑 允许 ext_echo"), "ext_echo permission ask");
    // Approve. The paint-vs-input-handler race means an instant "y" can land
    // before the key listener attaches (reliably so under full-suite load):
    // give the handler a beat, and re-send while the ask is still on screen.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await wait(80);
      if (!(inst.lastFrame() ?? "").includes("🔑 允许 ext_echo")) break;
      // M45: yield a tick — the prompt mounts after the started-event hop.
      await wait();
      inst.stdin.write("y");
      await wait(500);
    }
    await until(() => (inst.lastFrame() ?? "").includes("EXT-ECHO:EXT-CMD-SENTINEL"), "ext_echo tool result");
    // …and the model's final answer landed.
    await until(() => (inst.lastFrame() ?? "").includes("EXT-ANSWER-SENTINEL"), "final answer");
    expect((globalThis as Record<string, unknown>).__extSawPrompt).toBe("Please echo the value EXT-CMD-SENTINEL via ext_echo.");

    // The extension's appendEntry landed in THIS App's session JSONL (the
    // bindSession effect wired store + id before the command ran).
    const sessionsDir = join(root, ".wudao", "sessions");
    const files = readdirSync(sessionsDir);
    const wrote = files.some((f) => {
      try {
        return readFileSync(join(sessionsDir, f), "utf8").includes("ext_cmd_run");
      } catch {
        return false;
      }
    });
    expect(wrote).toBe(true);
    inst.unmount();
  }, 45000);
});
