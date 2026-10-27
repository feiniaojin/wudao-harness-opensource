// M79 §5 — the CLI image surface end-to-end: --image flag parsing + prompt
// stripping, file→store admission (loadImageFiles), and the full driver →
// provider chain (submit with images → user turn carries refs → the
// OpenAI-compatible wire shows image_url parts with the TRANSIENT data URL
// resolved from the workspace store) against a deterministic fake fetch.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileAttachmentStore } from "@wudao/core";
import type { ImageBlock, ModelClient, ModelInput } from "@wudao/core";
import { createOpenAICompatibleProvider } from "@wudao/providers";
import { parseImageFlags } from "../src/args.js";
import { stripLogFlags } from "../src/log.js";
import { loadImageFiles } from "../src/driver/attachment-ops.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

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
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "img-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

// 8-byte PNG-magic-prefixed stand-in (the store never sniffs magic — the
// mediaType comes from the extension; the bytes just need to be non-empty).
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("parseImageFlags", () => {
  it("collects repeatable --image values in both forms", () => {
    expect(parseImageFlags(["--image", "a.png", "--image=b.png", "-image", "c.png", "-image=d.png"]))
      .toEqual(["a.png", "b.png", "c.png", "d.png"]);
  });
  it("does not consume flag-looking or missing values", () => {
    expect(parseImageFlags(["--image", "--plan"])).toEqual([]);
    expect(parseImageFlags(["--image"])).toEqual([]);
    expect(parseImageFlags(["--image="])).toEqual([]);
  });
  it("stripLogFlags removes the flag and its value from the prompt", () => {
    expect(stripLogFlags(["--image", "a.png", "describe", "this"])).toEqual(["describe", "this"]);
    expect(stripLogFlags(["--image=a.png", "describe"])).toEqual(["describe"]);
  });
});

describe("loadImageFiles (the --image admission path)", () => {
  it("reads files, admits them through the store, returns blocks in order", async () => {
    await writeFile(join(root, "one.png"), PNG_BYTES);
    await writeFile(join(root, "two.jpg"), PNG_BYTES);
    const store = createFileAttachmentStore(root);
    const blocks = await loadImageFiles(store, [join(root, "one.png"), join(root, "two.jpg")]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "image", ref: { mediaType: "image/png", byteLength: PNG_BYTES.length } });
    expect(blocks[1]).toMatchObject({ kind: "image", ref: { mediaType: "image/jpeg" } });
    // The bytes round-trip through the store the provider will read.
    const url = await store.resolveDataUrl((blocks[0]!.ref));
    expect(url).toBe(`data:image/png;base64,${PNG_BYTES.toString("base64")}`);
  });

  it("fails closed on unknown extensions and missing files (before admission)", async () => {
    await writeFile(join(root, "pic.bmp"), PNG_BYTES);
    const store = createFileAttachmentStore(root);
    await expect(loadImageFiles(store, [join(root, "pic.bmp")])).rejects.toThrow(/unsupported image extension/);
    await expect(loadImageFiles(store, [join(root, "missing.png")])).rejects.toThrow(/cannot read image file/);
    // Nothing was admitted on the failures.
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(join(root, ".wudao", "attachments"))).rejects.toThrow();
  });
});

describe("driver submit with images → provider wire (deterministic fake model)", () => {
  function imageDriver(visionModel: boolean): { driver: AgentDriver; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "described" } }] }),
      };
    }) as unknown as typeof fetch;
    const store = createFileAttachmentStore(root);
    const provider = createOpenAICompatibleProvider(
      {
        apiKey: "k",
        baseURL: "https://x/v1",
        model: visionModel ? "glm-4v-plus" : "deepseek-v4-flash",
      },
      { fetch, attachments: store },
    );
    // generate-only wrapper (the scripted-model shape every driver test
    // uses): the loop prefers `stream` when present, and this fake fetch has
    // no SSE body — streaming parity is pinned in the providers tests.
    const model: ModelClient = {
      modelId: provider.modelId,
      generate: (input: ModelInput) => provider.generate(input),
    };
    const driver: AgentDriver = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools: [] });
    return { driver, bodies };
  }

  const blockFor = async (store: ReturnType<typeof createFileAttachmentStore>, name = "shot.png"): Promise<ImageBlock> => {
    await writeFile(join(root, name), PNG_BYTES);
    const blocks = await loadImageFiles(store, [join(root, name)]);
    return blocks[0]!;
  };

  it("the full chain: submit images → wire image_url parts with the transient data URL", async () => {
    const { driver, bodies } = imageDriver(true);
    const block = await blockFor(createFileAttachmentStore(root));
    const outcome = driver.submit("what is in this picture?", { images: [block] });
    expect(outcome).toBe("started");
    await until(() => driver.getStatus().busy === false, "run to finish");
    expect(bodies).toHaveLength(1);
    const msgs = bodies[0]!.messages as Record<string, unknown>[];
    expect(msgs[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is in this picture?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BYTES.toString("base64")}` } },
      ],
    });
    driver.dispose();
  });

  // ui-review-r5 C1: an IMAGE-ONLY send (empty text) is a prompt, not a
  // command-mismatch — the web composer arms exactly this ("look at this
  // screenshot" with no caption). The refusal must never fire for it.
  it("an image-only submit (empty text) runs as a prompt — no command refusal", async () => {
    const { driver, bodies } = imageDriver(true);
    const block = await blockFor(createFileAttachmentStore(root), "only.png");
    expect(driver.submit("", { images: [block] })).toBe("started");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const body = bodies[0] as { messages: { role: string; content: unknown }[] };
    const user = body.messages.find((m) => m.role === "user");
    expect(user.content).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BYTES.toString("base64")}` } }]);
    driver.dispose();
  });

  // M79b: the user HISTORY entry carries the turn's refs (the web's history
  // bubbles re-render images from this pointer); text-only turns omit it.
  it("the user history entry carries the refs; a text-only turn omits the field", async () => {
    const { driver } = imageDriver(true);
    const block = await blockFor(createFileAttachmentStore(root), "hist.png");
    driver.submit("with a picture", { images: [block] });
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.submit("plain text");
    await until(() => driver.getStatus().busy === false, "second run to finish");
    const users = driver.getHistory().filter((e) => e.kind === "user");
    expect(users[0]).toMatchObject({ kind: "user", text: "with a picture", images: [block] });
    expect(users[1]).toEqual({ kind: "user", text: "plain text" }); // no images key at all
    driver.dispose();
  });

  it("a text-only model refuses the image run pre-IO (UNSUPPORTED_CONTENT surfaces as the run error)", async () => {
    const { driver, bodies } = imageDriver(false);
    const block = await blockFor(createFileAttachmentStore(root), "nope.png");
    driver.submit("look", { images: [block] });
    await until(() => driver.getStatus().busy === false, "run to fail closed");
    expect(bodies).toHaveLength(0); // zero network calls — the gate fired pre-IO
    driver.dispose();
  });

  it("refusals: junk block / a command line / a busy run — notices, nothing submitted", async () => {
    const { driver } = imageDriver(true);
    const junk = [{ kind: "video", ref: { attachmentId: "x" } }] as unknown as ImageBlock[];
    expect(driver.submit("hi", { images: junk })).toBe("notice");

    const store = createFileAttachmentStore(root);
    const block = await blockFor(store, "cmd.png");
    // A valid image cannot ride a routed command (no command declares image input).
    expect(driver.submit("/help", { images: [block] })).toBe("notice");

    // A busy run parks TEXT steers only — images refuse rather than strand.
    // (The hung model settles only on the run's AbortSignal — interrupt()
    // unwinds it.)
    const hungModel: ModelClient = {
      generate: (input: ModelInput) => new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    };
    const busyDriver: AgentDriver = createAgentDriver({
      systemPrompt: "s",
      summarize: summarizeToolCall,
      model: hungModel,
      tools: [],
    });
    busyDriver.submit("start something");
    await until(() => busyDriver.getStatus().busy === true, "run to be busy");
    // A mid-run image submit refuses (a text steer would park; images must
    // not strand) — nothing is queued, so the run below stays interruptible.
    expect(busyDriver.submit("and this", { images: [block] })).toBe("notice");
    busyDriver.interrupt();
    await until(() => busyDriver.getStatus().busy === false, "hung run to unwind");
    busyDriver.dispose();
    driver.dispose();
  });
});

describe("--image without a one-shot prompt (review round 1, finding 2)", () => {
  // The flag rides one-shot prompts only; with no prompt the interactive
  // TUI/REPL would launch and stripLogFlags would silently drop it. The entry
  // refuses loudly instead: clear stderr message, exit code 1, and the
  // interactive surface never starts (the process exits before any TTY work).
  function runCli(args: readonly string[], cwd: string, envHome: string): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
        cwd,
        env: {
          ...process.env,
          WUDAO_GLOBAL_HOME: envHome,
          WUDAO_API_KEY: "test-key",
          WUDAO_BASE_URL: "http://127.0.0.1:1/v1",
          WUDAO_MODEL: "fake-e2e-model",
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
      const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      killer.unref?.();
      child.on("close", () => clearTimeout(killer));
    });
  }

  it("refuses with a clear error and exits non-zero (no silent drop into interactive)", async () => {
    await writeFile(join(root, "never-read.png"), PNG_BYTES);
    const home = join(root, "home");
    const r = await runCli(["--image", join(root, "never-read.png")], root, home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--image needs a one-shot prompt");
    // The image file was never even admitted (refusal precedes all loading).
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(join(root, ".wudao", "attachments"))).rejects.toThrow();
  }, 20000);
});
