// M58 §C#10 — cross-session prompt history: every submitted prompt appends
// {text, project, ts} to <WUDAO_GLOBAL_HOME>/history.jsonl; TUI/REPL startup
// preloads the up-arrow history for the CURRENT project (newest last); past
// 10000 lines the file atomically rotates keeping the newest 5000. The
// global-home isolation is the suite's setup-global-home.ts pin.
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import {
  appendPromptHistory,
  loadPromptHistory,
  promptHistoryPath,
  HISTORY_ROTATE_ABOVE_LINES,
  HISTORY_ROTATE_KEEP_LINES,
} from "../src/prompt-history.js";
import { resolveGlobalHome } from "../src/settings-layer.js";
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

/** Point WUDAO_GLOBAL_HOME at a fresh tmpdir (the suite pin is per-process). */
function freshGlobalHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "wudao-hist-home-"));
  process.env.WUDAO_GLOBAL_HOME = dir;
  return dir;
}

describe("appendPromptHistory / loadPromptHistory (M58 §C#10)", () => {
  it("appends {text, project, ts} lines and reloads them for the same project, newest last", async () => {
    const home = freshGlobalHome();
    try {
      const now = 1_700_000_000_000;
      await appendPromptHistory("first prompt", "/proj/a", { now });
      await appendPromptHistory("second prompt", "/proj/a", { now: now + 5 });
      await appendPromptHistory("other project", "/proj/b", { now: now + 9 });
      const path = promptHistoryPath();
      expect(path).toBe(join(home, "history.jsonl"));
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0] ?? "")).toEqual({ text: "first prompt", project: "/proj/a", ts: now });
      await expect(loadPromptHistory("/proj/a")).resolves.toEqual(["first prompt", "second prompt"]);
      await expect(loadPromptHistory("/proj/b")).resolves.toEqual(["other project"]);
      await expect(loadPromptHistory("/proj/c")).resolves.toEqual([]);
    } finally {
      delete process.env.WUDAO_GLOBAL_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("empty/whitespace text is not a prompt — nothing recorded", async () => {
    const home = freshGlobalHome();
    try {
      await appendPromptHistory("", "/p");
      await appendPromptHistory("   ", "/p");
      expect(existsSync(promptHistoryPath())).toBe(false);
    } finally {
      delete process.env.WUDAO_GLOBAL_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("adjacent duplicates collapse and the max cap keeps the NEWEST tail; corrupt lines never break recall", async () => {
    const home = freshGlobalHome();
    try {
      for (let i = 1; i <= 6; i += 1) await appendPromptHistory(`p${i}`, "/p", { now: i });
      await appendPromptHistory("p6", "/p", { now: 7 }); // adjacent duplicate
      await expect(loadPromptHistory("/p", { max: 3 })).resolves.toEqual(["p4", "p5", "p6"]);
      // A corrupt line + a foreign-project line are skipped.
      const path = promptHistoryPath();
      writeFileSync(path, "not json\n" + readFileSync(path, "utf8"), "utf8");
      await expect(loadPromptHistory("/p")).resolves.toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    } finally {
      delete process.env.WUDAO_GLOBAL_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rotates atomically past 10000 lines, keeping the most recent 5000", async () => {
    const home = freshGlobalHome();
    try {
      const path = promptHistoryPath();
      mkdirSync(home, { recursive: true });
      const seed: string[] = [];
      for (let i = 1; i <= HISTORY_ROTATE_ABOVE_LINES + 5; i += 1) {
        seed.push(JSON.stringify({ text: `old${i}`, project: "/p", ts: i }));
      }
      writeFileSync(path, `${seed.join("\n")}\n`, "utf8");
      await appendPromptHistory("newest", "/p", { now: 999_999 });
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(HISTORY_ROTATE_KEEP_LINES); // the newest 5000, the appended line among them
      expect(lines[0]).toContain("old5007"); // the oldest kept after the cut (10006 lines − 5000 kept)
      expect(lines[lines.length - 1]).toContain("newest");
      expect(existsSync(`${path}.tmp`)).toBe(false); // the atomic rewrite left no tmp behind
      await expect(loadPromptHistory("/p", { max: 10_000 })).resolves.toHaveLength(HISTORY_ROTATE_KEEP_LINES);
    } finally {
      delete process.env.WUDAO_GLOBAL_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The TUI wiring: preload on start, append on submit.
// ---------------------------------------------------------------------------

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

describe("WudaoApp prompt-history wiring (M58 §C#10)", () => {
  it("↑ recalls this project's cross-session prompts preloaded at startup", async () => {
    const home = freshGlobalHome();
    const root = mkdtempSync(join(tmpdir(), "wudao-hist-tui-"));
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "history.jsonl"), [
        JSON.stringify({ text: "from another project", project: "/elsewhere", ts: 1 }),
        JSON.stringify({ text: "prior prompt from last session", project: root, ts: 2 }),
      ].join("\n") + "\n", "utf8");
      const model = createScriptedModel([{ role: "assistant", content: "done" }]);
      const inst = render(
        <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
      );
      // M63-A hardening: fixed waits raced the async startup preload under a
      // loaded suite — wait for the RECALL to land instead of guessing ms.
      await until(() => (inst.lastFrame() ?? "").includes("wudao"), "app shell", 5000);
      // M63-B hardening: ↑ recalls from the STARTUP PRELOAD, which lands
      // asynchronously after the shell — a single early keypress races it.
      // Retry the keypress until the recall shows (bounded, condition-driven).
      for (let i = 0; i < 60 && !(inst.lastFrame() ?? "").includes("prior prompt from last session"); i += 1) {
        inst.stdin.write("\x1b[A"); // ↑ at the empty first row → recall
        await wait(200);
      }
      await until(() => (inst.lastFrame() ?? "").includes("prior prompt from last session"), "recalled prompt", 10_000);
      expect(inst.lastFrame() ?? "").not.toContain("from another project");
      inst.unmount();
    } finally {
      delete process.env.WUDAO_GLOBAL_HOME;
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);



  it("a submitted prompt appends to the global history file", async () => {
    const home = freshGlobalHome();
    const root = mkdtempSync(join(tmpdir(), "wudao-hist-tui2-"));
    try {
      const model = createScriptedModel([{ role: "assistant", content: "APPENDED-DONE" }]);
      const inst = render(
        <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
      );
      await wait();
      for (const ch of "hello history\r") {
        inst.stdin.write(ch);
        await wait(10);
      }
      await until(() => (inst.lastFrame() ?? "").includes("APPENDED-DONE"), "run to finish");
      const path = promptHistoryPath();
      expect(path).toBe(join(resolveGlobalHome(), "history.jsonl"));
      const entries = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; project: string; ts: number });
      // M63-B hardening: process.env is shared across vitest workers, so a
      // concurrently-running WudaoApp test can append into THIS test's home —
      // assert on THIS project's entries (exactly one), not the whole file.
      const mine = entries.filter((e) => e.project === root);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.text).toBe("hello history");
      expect(typeof mine[0]?.ts).toBe("number");
      inst.unmount();
    } finally {
      delete process.env.WUDAO_GLOBAL_HOME;
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
