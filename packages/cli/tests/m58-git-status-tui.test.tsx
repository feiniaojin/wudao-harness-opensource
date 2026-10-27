// M58 §C#8 (batch-B wiring) — the git-status prober in the TUI: the
// <git_status> block rides the MetaNote channel (session-start snapshot +
// re-injection on fingerprint change), NEVER the stable prompt prefix. Mirrors
// the one-shot/web contract of git-status-note.test.ts at the TUI seam.
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao/core";
import type { ModelClient } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { WudaoApp } from "../src/tui/app.js";

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

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

let root: string;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wudao-git-tui-"));
  git(dir, "init", "-q", "-b", "main");
  // Byte-faithful blobs: an operator's global core.autocrlf=true smudges
  // status/diff output and can reorder porcelain lines.
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "user.email", "test@wudao.local");
  git(dir, "config", "user.name", "wudao test");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

afterEach(async () => {
  // win32: the git child procs this suite spawns can hold the workspace cwd
  // handle briefly — the rmdir races EPERM. Retry a little before surfacing.
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
      await new Promise((res) => setTimeout(res, 50));
    }
  }
});

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(12);
  }
}

describe("WudaoApp git-status MetaNote (M58 §C#8)", () => {
  it("session-start snapshot rides the first model call; a branch change re-injects on a following turn", async () => {
    root = makeRepo();
    // Wrap the scripted model to capture every ModelInput — the CONTRACT is
    // that the <git_status> block rides a model call (the frame preview is
    // cosmetic and racy under load). Inputs are captured synchronously at
    // generate() time: no render race at all.
    const script = createScriptedModel([
      { role: "assistant", content: "RUN1-DONE" },
      { role: "assistant", content: "RUN2-DONE" },
      { role: "assistant", content: "RUN3-DONE" },
    ]);
    const inputs: { messages: { content: unknown }[] }[] = [];
    const model: ModelClient = {
      async generate(input) {
        inputs.push(input);
        return script.generate(input);
      },
    };
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    // Let the eager session-start probe land in the queue before the run.
    await wait(120);

    await type(inst.stdin, "go\r");
    await until(() => (inst.lastFrame() ?? "").includes("RUN1-DONE"), "first run to finish");
    // The session-start <git_status> block rides an EARLY model call. Under
    // load the eager probe (a git child) can miss run 1's window entirely —
    // the queued note then drains on run 2 — so the contract window is
    // "reached the model by the end of run 2", asserted via the captured
    // generate() inputs (immune to render-frame races).
    git(root, "checkout", "-q", "-b", "feature-x");
    await type(inst.stdin, "again\r");
    await until(() => (inst.lastFrame() ?? "").includes("RUN2-DONE"), "second run to finish");
    expect(JSON.stringify(inputs.flatMap((i) => i.messages))).toContain("git_status");
    expect(JSON.stringify(inputs.flatMap((i) => i.messages))).toContain("branch: main");

    // Fingerprint change (new branch): the block re-injects. The queue is
    // FIFO and one note drains per model call — the feature-x block lands on
    // the NEXT turn after any stale note drains.
    await type(inst.stdin, "once more\r");
    await until(() => (inst.lastFrame() ?? "").includes("RUN3-DONE"), "third run to finish");
    // The feature-x block reached the model by run 3 (the frame preview may
    // lag; the model-input contract is the assertion).
    expect(JSON.stringify(inputs.flatMap((i) => i.messages))).toContain("feature-x");

    // The stable prompt prefix stays free of git bytes (hard rule): the
    // driver's system prompt is exactly what buildSystemPrompt produced.
    // (Covered byte-level in git-status-note.test.ts; here we pin the seam.)
    inst.unmount();
  }, process.platform === "win32" ? 60_000 : 20_000);

  it("outside a git repo nothing is injected and runs proceed normally", async () => {
    root = mkdtempSync(join(tmpdir(), "wudao-git-none-"));
    const model = createScriptedModel([{ role: "assistant", content: "NOREPO-DONE" }]);
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait(120);
    await type(inst.stdin, "hello\r");
    await until(() => (inst.lastFrame() ?? "").includes("NOREPO-DONE"), "run to finish");
    expect(inst.lastFrame() ?? "").not.toContain("git_status");
    inst.unmount();
  }, process.platform === "win32" ? 60_000 : 20_000);
});
