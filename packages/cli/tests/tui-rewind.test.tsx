// M37 §2 — /rewind in the TUI: real write_file snapshots land in the session
// history, /rewind lists them, /rewind last restores the previous bytes, and
// the queued <files_rewound> MetaNote rides the next model call.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileHistory, createReadStateTable, createWriteFileTool, createScriptedModel } from "@wudao-org/core";
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
  root = mkdtempSync(join(tmpdir(), "wudao-tui-rewind-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("WudaoApp /rewind (M37 §2)", () => {
  it("lists recorded changes, /rewind last restores the previous bytes, and the model is informed via MetaNote", async () => {
    const history = createFileHistory(join(root, ".wudao", "history", "s1"));
    const readState = createReadStateTable();
    const write = createWriteFileTool({ workspaceRoot: root, history });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "a.txt", content: "v1\n" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "w2", name: "write_file", arguments: { path: "a.txt", content: "v2\n" } }] },
      { role: "assistant", content: "WROTE-DONE" },
      { role: "assistant", content: "AFTER-REWIND" },
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

    // Two writes (each asks in default mode — allow both).
    await type(inst.stdin, "write the file\r");
    await until(() => (inst.lastFrame() ?? "").includes("🔑 允许 write_file"), "first write ask");
    // M45: yield a tick — the prompt mounts after the started-event hop.
    await wait();
    inst.stdin.write("y");
    // Answer remaining ask(s) until the run finishes.
    for (let i = 0; i < 20 && !(inst.lastFrame() ?? "").includes("WROTE-DONE"); i += 1) {
      if ((inst.lastFrame() ?? "").includes("🔑")) inst.stdin.write("y");
      await wait(200);
    }
    await until(() => (inst.lastFrame() ?? "").includes("WROTE-DONE"), "write run to finish");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v2\n");

    // /rewind lists both steps.
    // ω99-164: 清单头钉随源演进（rewind.ts :48 共享 helper）。
    await type(inst.stdin, "/rewind\r");
    await until(() => (inst.lastFrame() ?? "").includes("本会话文件改动"), "rewind list");
    const list = inst.lastFrame() ?? "";
    expect(list).toContain("a.txt");
    expect(list).toContain("write_file");
    expect(list).toContain("/rewind last");

    // /rewind last → a.txt back to v1, summary notice.
    // ω99-164: 回执钉随源演进（rewind.ts :100）。
    await type(inst.stdin, "/rewind last\r");
    await until(() => (inst.lastFrame() ?? "").includes("已回退到第 2 步之前"), "rewind summary");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v1\n");

    // The next model call carries the queued <files_rewound> MetaNote.
    await type(inst.stdin, "what happened\r");
    await until(() => (inst.lastFrame() ?? "").includes("AFTER-REWIND"), "post-rewind run");
    expect(inst.lastFrame() ?? "").toContain("files_rewound");
    inst.unmount();
  }, 20000);

  it("/rewind with nothing recorded answers gracefully", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "NEVER" }]);
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64000}
        modelOverride={model}
        tools={[]}
        fileHistory={createFileHistory(join(root, ".wudao", "history", "s2"))}
      />,
    );
    await wait();
    await type(inst.stdin, "/rewind\r");
    // ω99-164: 空清单钉随源演进（B15）。
    await until(() => (inst.lastFrame() ?? "").includes("没有可回退的内容"), "empty history notice");
    expect(model.calls).toBe(0);
    inst.unmount();
  });

  it("writes outside a shared history stay invisible to /rewind (stub tools path)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "DONE" }]);
    const appHistory = createFileHistory(join(root, ".wudao", "history", "app"));
    // A tool-only history (what props.tools stubs produce) records nothing.
    writeFileSync(join(root, "x.txt"), "x\n", "utf8");
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64000}
        modelOverride={model}
        tools={[]}
        fileHistory={appHistory}
      />,
    );
    await wait();
    await type(inst.stdin, "/rewind\r");
    // ω99-164: 空清单钉随源演进（B15）。
    await until(() => (inst.lastFrame() ?? "").includes("没有可回退的内容"), "empty app history");
    inst.unmount();
  });
});
