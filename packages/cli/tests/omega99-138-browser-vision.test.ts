// ω99-138 — the CLI seam: buildToolSet injects the screenshot sink when
// vision materials are present (PNG bytes → the REAL workspace
// AttachmentStore → a durable ImageBlock on the browser_see result — the
// same .wudao/attachments home --image uses), and the modality pre-check is
// read AT EVERY CALL: a text-only main model degrades browser_see to its
// text table (no images, the store never touched) instead of poisoning
// every later request with a typed image refusal — the arc's #1 UX trap,
// pinned here. A live getter means flipping the verdict flips the NEXT call.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@wudao-org/core";
import { createFileAttachmentStore } from "@wudao-org/core";
import { createBrowserRuntime } from "@wudao-org/browser";
import { buildToolSet } from "../src/tools.js";
import { COLLECT_SCRIPT } from "@wudao-org/browser";

const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });

/** Minimal IHDR-shaped PNG (24 bytes; pngSize reads offsets 16/23). */
const png = (() => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, 800);
  dv.setUint32(20, 600);
  return b;
})();

let home: string; // the browser runtime's home (profile etc.)
let ws: string;   // the WORKSPACE whose .wudao/attachments the store owns
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wd-see-cli-home-"));
  ws = await mkdtemp(join(tmpdir(), "wd-see-cli-ws-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const collected = {
  url: "https://example.test/start", title: "Example", text: "hello page",
  elements: [{ ref: "e1", tag: "a", text: "Next", href: "/next", bbox: { x: 1, y: 2, width: 30, height: 10 } }],
};

/** The fake browser (real runtime, fake port — the 112 cli-test posture). */
const makeTools = (accepts: () => boolean): Tool[] => {
  const page = {
    url: async () => "https://example.test/start",
    goto: async (u: string) => ({ finalUrl: u }),
    title: async () => "Example",
    evaluate: async (s: string) => (s === COLLECT_SCRIPT ? collected : null),
    click: async () => {},
    fill: async () => {},
    text: async () => "body",
    press: async () => {},
    screenshot: async () => png,
    close: async () => {},
  };
  const browser = createBrowserRuntime({
    port: { launch: async () => ({ newPage: async () => page, close: async () => {} }) },
    homeDir: home, env: () => ({}),
    resolveInstalled: async () => "/fake/kernel",
    download: async () => { throw new Error("no download in tests"); },
    registerExitHook: () => () => {},
    profileMkdir: async () => {},
  });
  return buildToolSet({
    workspaceRoot: ws,
    model: stubModel,
    canUseTool: gate,
    contextWindowTokens: 64_000,
    browser,
    browserVision: { store: createFileAttachmentStore(ws), modelAcceptsImages: accepts },
  });
};

const see = async (tools: readonly Tool[]): Promise<{ content: string; isError?: boolean; images?: readonly unknown[] }> => {
  const byName = (n: string): Tool => {
    const t = tools.find((x) => x.name === n);
    if (!t) throw new Error(`missing ${n}`);
    return t;
  };
  await byName("browser_open").execute({ url: "https://example.test/start" });
  return byName("browser_see").execute({}) as never;
};

const attachmentFiles = async (): Promise<string[]> => {
  try { return await readdir(join(ws, ".wudao", "attachments")); } catch { return []; }
};

describe("ω99-138 the CLI screenshot sink (buildToolSet wiring)", () => {
  it("vision model → the screenshot lands in the REAL store and rides the result as a durable ImageBlock", async () => {
    const res = await see(makeTools(() => true));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("截图已附");
    // The block: a real admitted ref (uuid id, png media type, exact bytes).
    const block = (res.images as readonly { kind: string; ref: { attachmentId: string; mediaType: string; byteLength: number } }[])[0]!;
    expect(block.kind).toBe("image");
    expect(block.ref.attachmentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(block.ref.mediaType).toBe("image/png");
    expect(block.ref.byteLength).toBe(png.length);
    // Durable on disk under the workspace's .wudao/attachments (--image's home).
    const files = await attachmentFiles();
    expect(files).toEqual([`${block.ref.attachmentId}.png`]);
    expect((await stat(join(ws, ".wudao", "attachments", files[0]!))).size).toBe(png.length);
  });

  it("TEXT main model → the pre-check declines: no images, the degradation note, the store NEVER touched", async () => {
    const res = await see(makeTools(() => false));
    expect(res.isError).toBeFalsy();
    expect(res.images).toBeUndefined();
    expect(res.content).toContain("当前主模型不接受图像输入");
    expect(res.content).toContain("e1"); // the ref/bbox table still works
    expect(await attachmentFiles()).toEqual([]); // zero bytes written
  });

  it("the verdict is LIVE: a flip (the /model switch) flips the NEXT call", async () => {
    let accepts = false;
    const tools = makeTools(() => accepts);
    const first = await see(tools);
    expect(first.images).toBeUndefined();
    accepts = true; // the user switched to a vision model mid-session
    const byName = (n: string): Tool => {
      const t = tools.find((x) => x.name === n);
      if (!t) throw new Error(`missing ${n}`);
      return t;
    };
    const second = await byName("browser_see").execute({}) as { content: string; images?: readonly unknown[] };
    expect(second.content).toContain("截图已附");
    expect(second.images).toHaveLength(1);
    expect(await attachmentFiles()).toHaveLength(1);
  });
});
