// ω99-55 — the CLI file-upload surface end-to-end: the driver → provider
// chain (submit with files → the user turn carries FileBlocks → the wire
// shows ONLY the projected handle text, bytes never cross) against a
// deterministic fake fetch, the history entry's files field, the resume
// projection, and the fail-closed submit refusals.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAttachmentStore } from "@wudao/core";
import type { FileBlock, ModelClient, ModelInput } from "@wudao/core";
import { createOpenAICompatibleProvider } from "@wudao/providers";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import { resumeEntries } from "../src/tui/resume.js";
import { isValidFileBlock } from "@wudao/core";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "wudao-file-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const PDF_BYTES = Buffer.from("%PDF-1.7 wudao-omega99-55 deterministic body\n");

async function admittedBlock(name = "spec.pdf"): Promise<FileBlock> {
  const store = createFileAttachmentStore(root);
  const blocks = await store.saveFiles([{ data: PDF_BYTES.toString("base64"), name }]);
  return blocks[0]!;
}

/** The driver over a REAL OpenAI-compatible provider with a capture fetch —
 *  same shape as the images test's imageDriver(true). */
function fileDriver(): { driver: AgentDriver; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    };
  }) as unknown as typeof fetch;
  const provider = createOpenAICompatibleProvider(
    { apiKey: "k", baseURL: "https://x/v1", model: "glm-4.7-flash" },
    { fetch },
  );
  const model: ModelClient = { modelId: provider.modelId, generate: (input: ModelInput) => provider.generate(input) };
  const driver: AgentDriver = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools: [] });
  return { driver, bodies };
}

describe("submit with files — the full chain", () => {
  it("the user turn carries FileBlocks; the wire shows ONLY the handle text (bytes never cross)", async () => {
    const { driver, bodies } = fileDriver();
    const block = await admittedBlock();
    const outcome = driver.submit("review the attached spec", { files: [block] });
    expect(outcome).toBe("started");
    await until(() => driver.getStatus().busy === false, "run to finish");
    expect(bodies).toHaveLength(1);
    const raw = JSON.stringify(bodies[0]);
    expect(raw).not.toContain(PDF_BYTES.toString("base64"));
    expect(raw).not.toContain("%PDF-1.7 wudao-omega99-55");
    const msgs = bodies[0]!.messages as Record<string, unknown>[];
    const content = String(msgs[1]!.content);
    expect(msgs[1]!.role).toBe("user");
    expect(content.startsWith("review the attached spec\n\n[attached file \"spec.pdf\"")).toBe(true);
    expect(content).toContain(".wudao/attachments/files/");
    driver.dispose();
  });

  it("a file-only submit (empty text) runs as a prompt", async () => {
    const { driver, bodies } = fileDriver();
    const block = await admittedBlock("only.csv");
    expect(driver.submit("", { files: [block] })).toBe("started");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const raw = JSON.stringify(bodies[0]);
    expect(raw).not.toContain(PDF_BYTES.toString("base64"));
    expect(raw).toContain("only.csv");
    driver.dispose();
  });

  it("the user history entry carries the files; a text-only turn omits the field", async () => {
    const { driver } = fileDriver();
    const block = await admittedBlock("hist.pdf");
    driver.submit("with a file", { files: [block] });
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.submit("plain text");
    await until(() => driver.getStatus().busy === false, "second run to finish");
    const users = driver.getHistory().filter((e) => e.kind === "user") as { kind: "user"; text: string; files?: FileBlock[] }[];
    expect(users[0]).toMatchObject({ kind: "user", text: "with a file", files: [block] });
    expect(isValidFileBlock(users[0]?.files?.[0])).toBe(true);
    expect(users[1]).toEqual({ kind: "user", text: "plain text" });
    driver.dispose();
  });

  it("refusals: junk block / a command line / a busy run — notices, nothing submitted", async () => {
    const { driver, bodies } = fileDriver();
    const junk = [{ kind: "video", name: "x", bytes: 1, attachmentId: "nope" }] as unknown as FileBlock[];
    expect(driver.submit("hi", { files: junk })).toBe("notice");

    const block = await admittedBlock("cmd.pdf");
    expect(driver.submit("/help", { files: [block] })).toBe("notice");

    const hungModel: ModelClient = {
      generate: (input: ModelInput) => new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    };
    const busyDriver: AgentDriver = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model: hungModel, tools: [] });
    busyDriver.submit("hold");
    await until(() => busyDriver.getStatus().busy === true, "busy");
    expect(busyDriver.submit("steer", { files: [block] })).toBe("notice");
    busyDriver.interrupt();
    await until(() => busyDriver.getStatus().busy === false, "busy run to unwind");
    busyDriver.dispose();
    expect(bodies).toHaveLength(0);
    driver.dispose();
  });
});

describe("resumeEntries — file refs survive the projection", () => {
  it("a resumed view re-renders a file turn from the durable blocks", async () => {
    const block = await admittedBlock("resume.pdf");
    const entries = resumeEntries([
      { role: "user", content: "check this", files: [block] },
      { role: "assistant", content: "done" },
    ], "s1");
    const user = entries.find((e) => e.kind === "user") as { kind: "user"; text: string; files?: FileBlock[] };
    expect(user.text).toBe("check this");
    expect(user.files).toEqual([block]);
  });
});
