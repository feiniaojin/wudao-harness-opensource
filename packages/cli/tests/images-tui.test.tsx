// M79 review round 1, finding 1 — the plain TUI entry (runTui → WudaoApp)
// must wire the workspace attachment store into ITS OWN provider (it does not
// go through session-engine): resuming an image-bearing session in `wudao`
// interactive has to resolve the refs on the wire, not fail
// no-attachment-store. Real provider + stubbed global fetch (SSE body — the
// loop prefers stream), vision model so the inputModalities gate passes.
import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAttachmentStore } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { WudaoApp } from "../src/tui/app.js";
import { loadImageFiles } from "../src/driver/attachment-ops.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
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

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WudaoApp — image-bearing resume through the TUI's own provider", () => {
  it("the resumed turn's images resolve to image_url parts on the wire (attachments wired at both build sites)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-img-tui-"));
    try {
      // Admit one image into the workspace store the TUI must discover.
      writeFileSync(join(root, "shot.png"), PNG_BYTES);
      const store = createFileAttachmentStore(root);
      const [block] = await loadImageFiles(store, [join(root, "shot.png")]);
      expect(block).toBeDefined();

      const bodies: Record<string, unknown>[] = [];
      const sse = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "TUI-IMG-OK" } }] })}\n\n`));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
      const fakeFetch = (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return { ok: true, status: 200, body: sse() } as unknown as Response;
      }) as typeof fetch;
      vi.stubGlobal("fetch", fakeFetch);

      // A vision model so the inputModalities gate passes; no modelOverride —
      // the REAL provider construction path under test.
      const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "glm-4v-plus" };
      const inst = render(
        <WudaoApp
          config={config}
          workspaceRoot={root}
          contextWindowTokens={64000}
          resumeHistory={[{ role: "user", content: "what is this?", images: [block!] }]}
          tools={[]}
        />,
      );
      await wait();

      await type(inst.stdin, "describe it\r");
      await until(() => (inst.lastFrame() ?? "").includes("TUI-IMG-OK"), "TUI answer in frame");
      inst.unmount();

      // The provider resolved the resumed turn's ref through the workspace
      // store — the wire's first user turn carries the transient data URL.
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      const msgs = bodies[0]!.messages as Record<string, unknown>[];
      const firstUser = msgs.find((m) => m.role === "user") as { content: Record<string, unknown>[] } | undefined;
      expect(firstUser?.content[0]).toEqual({ type: "text", text: "what is this?" });
      expect(firstUser?.content[1]).toEqual({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${PNG_BYTES.toString("base64")}` },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
