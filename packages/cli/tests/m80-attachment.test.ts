// M80 — the subagent attachment hand-off (spec directions b + c):
//  · the task tool's `images` param: id resolution against the PARENT
//    conversation view, fail-closed shapes (unknown id / no view / fork /
//    teammate / resume / junk), rider placement on the child's first
//    message (foreground AND background spawns);
//  · direction c: the deterministic unattached-images receipt line;
//  · the model resolver's attachment seam: a resolver built WITH a store
//    resolves image-bearing child requests (the audited no-attachment-store
//    bug), the resolver-less build still fails closed (regression guard).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ForkContext, ImageBlock, ModelClient, ModelInput, Tool, UserMessage } from "@wudao/core";
import { buildTool } from "@wudao/core";
import {
  createAgentsTaskTool,
  createProviderModelResolver,
  createRegistryTools,
  createSessionRegistry,
} from "../src/agents/index.js";
import { writeCredentialsFileSync } from "../src/credentials.js";
import { resetProviderRegistryCacheForTests } from "../src/provider-registry.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "m80-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const img = (attachmentId: string, byteLength = 100): ImageBlock => ({
  kind: "image",
  ref: { kind: "image", attachmentId, mediaType: "image/png", byteLength },
});

function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages] });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

/** A parent view whose history carries `blocks` on one user turn. */
const parentView = (blocks: readonly ImageBlock[]): ForkContext => ({
  systemPrompt: "PARENT-SYS",
  tools: [],
  messages: [{ role: "user", content: "here are images", images: [...blocks] }],
});

const harness = (model: ModelClient, forkContext?: ForkContext) => {
  const registry = createSessionRegistry();
  const task = createAgentsTaskTool({
    model,
    allTools: [],
    registry,
    workspaceRoot: root,
    runId: "m80-run",
    ...(forkContext !== undefined ? { getForkContext: () => forkContext } : {}),
  });
  return { registry, task };
};

const firstUser = (input: ModelInput): UserMessage => {
  const m = input.messages.find((x) => x.role === "user");
  if (m === undefined) throw new Error("no user message in child request");
  return m as UserMessage;
};

describe("M80 — task tool `images` (direction b: selective explicit hand-off)", () => {
  it("a legal id lands its ref on the child's first message, caller's order preserved", async () => {
    const a = img("m80-a", 111);
    const b = img("m80-b", 222);
    const model = recordingModel([{ role: "assistant", content: "described" }]);
    const h = harness(model, parentView([a, b]));
    // Pass NEWEST-first: the rider must equal the CALLER's order, not history order.
    const r = await h.task.execute({ description: "d", prompt: "describe", images: [b.ref.attachmentId, a.ref.attachmentId] });
    expect(r.isError).toBeFalsy();
    expect(model.inputs).toHaveLength(1);
    expect(firstUser(model.inputs[0]!).images).toEqual([b, a]);
    // Text-only parent history is untouched — the child saw exactly one rider set.
    expect(model.inputs[0]!.messages).toHaveLength(1);
  });

  it("an unknown attachment id fails closed (exact vocabulary)", async () => {
    const model = recordingModel([{ role: "assistant", content: "x" }]);
    const h = harness(model, parentView([img("m80-known")]));
    const r = await h.task.execute({ description: "d", prompt: "p", images: ["m80-missing"] });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("task failed: unknown attachment id");
    // Refused before anything spawned.
    expect(model.inputs).toHaveLength(0);
  });

  it("images without a parent conversation view fail closed", async () => {
    const model = recordingModel([{ role: "assistant", content: "x" }]);
    const h = harness(model); // no getForkContext at all
    const r = await h.task.execute({ description: "d", prompt: "p", images: ["m80-a"] });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("task failed: images need the parent conversation");
    expect(model.inputs).toHaveLength(0);
  });

  it("junk shapes fail closed: non-array, non-string items, duplicates, over the cap", async () => {
    const model = recordingModel([]);
    const h = harness(model, parentView([img("m80-a")]));
    for (const bad of [
      "not-an-array",
      ["ok", 5],
      ["m80-a", "m80-a"],
      Array.from({ length: 10 }, (_, i) => `m80-${i}`),
    ]) {
      const r = await h.task.execute({ description: "d", prompt: "p", images: bad });
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/^task failed: (images must be|duplicate attachment id|images accepts at most)/);
    }
  });

  it("fork children reject images (they replay the parent's images verbatim)", async () => {
    const model = recordingModel([{ role: "assistant", content: "x" }]);
    const h = harness(model, parentView([img("m80-a")]));
    const r = await h.task.execute({ description: "d", prompt: "p", shareContext: true, images: ["m80-a"] });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("task failed: images are not needed for fork children");
  });

  it("teammate spawns reject images (no teammate image channel)", async () => {
    const model = recordingModel([{ role: "assistant", content: "x" }]);
    const h = harness(model, parentView([img("m80-a")]));
    const r = await h.task.execute({ description: "d", prompt: "p", teammate: "bob", images: ["m80-a"] });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("task failed: images are not supported for teammate spawns");
  });

  it("resume child sessions reject images (the rider rides a FRESH first message)", async () => {
    const model = recordingModel([{ role: "assistant", content: "x" }]);
    const h = harness(model, parentView([img("m80-a")]));
    const r = await h.task.execute({ description: "d", prompt: "p", session: "resume:child-9", images: ["m80-a"] });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("task failed: images attach to a fresh child's first message");
  });

  it("background spawns thread the rider through the registry", async () => {
    const a = img("m80-a", 111);
    const b = img("m80-b", 222);
    const model = recordingModel([{ role: "assistant", content: "bg done" }]);
    const h = harness(model, parentView([a, b]));
    const r = await h.task.execute({
      description: "d",
      prompt: "describe",
      background: true,
      images: [a.ref.attachmentId],
    });
    expect(r.isError).toBeFalsy();
    const id = /"id":"(bg-\d+)"/.exec(r.content)?.[1];
    expect(id).toBeDefined();
    await h.registry.awaitAgents({ ids: [id!], mode: "allSettled" });
    expect(model.inputs).toHaveLength(1);
    expect(firstUser(model.inputs[0]!).images).toEqual([a]);
  });
});

describe("M80 — the unattached-images receipt line (direction c)", () => {
  it("two unattached images → one deterministic line, sorted ids (snapshot)", async () => {
    const z = img("m80-z", 1);
    const a = img("m80-a", 2);
    const model = recordingModel([{ role: "assistant", content: "done" }]);
    const h = harness(model, parentView([z, a])); // history order z,a — line must sort
    const r = await h.task.execute({ description: "d", prompt: "p" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(
      "parent history has 2 unattached images: m80-a, m80-z (pass images:[...] to share)",
    );
  });

  it("attaching one of two → the line names only the remainder; attaching all → no line", async () => {
    const a = img("m80-a", 1);
    const b = img("m80-b", 2);
    const model1 = recordingModel([{ role: "assistant", content: "done" }]);
    const h1 = harness(model1, parentView([a, b]));
    const r1 = await h1.task.execute({ description: "d", prompt: "p", images: [a.ref.attachmentId] });
    expect(r1.content).toContain("parent history has 1 unattached image: m80-b (pass images:[...] to share)");

    const model2 = recordingModel([{ role: "assistant", content: "done" }]);
    const h2 = harness(model2, parentView([a, b]));
    const r2 = await h2.task.execute({ description: "d", prompt: "p", images: [a.ref.attachmentId, b.ref.attachmentId] });
    expect(r2.content).not.toContain("unattached image");
  });

  it("image-free parent history and fork children never emit the line", async () => {
    const model1 = recordingModel([{ role: "assistant", content: "done" }]);
    const h1 = harness(model1, parentView([]));
    const r1 = await h1.task.execute({ description: "d", prompt: "p" });
    expect(r1.content).not.toContain("unattached image");

    const model2 = recordingModel([{ role: "assistant", content: "done" }]);
    const h2 = harness(model2, parentView([img("m80-a")]));
    const r2 = await h2.task.execute({ description: "d", prompt: "p", shareContext: true });
    expect(r2.isError).toBeFalsy();
    expect(r2.content).not.toContain("unattached image");
  });
});

describe("M80 — the model resolver's attachment seam (the no-attachment-store fix)", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "m80-res-"));
    writeCredentialsFileSync({ glm: "test-key" }, { WUDAO_GLOBAL_HOME: home });
    // loadEffectiveProfiles() reads the process default — pin it to the tmp
    // home so the machine's real ~/.wudao cannot leak a profile into this test.
    prevHome = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
    else process.env.WUDAO_GLOBAL_HOME = prevHome;
    resetProviderRegistryCacheForTests();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const imageInput = (): ModelInput => ({
    systemPrompt: "s",
    messages: [{ role: "user", content: "what is this?", images: [img("m80-res-1", 3)] }],
    tools: [],
  });

  const okFetch = (): { fetch: typeof fetch; calls: () => number } => {
    let n = 0;
    return {
      calls: () => n,
      fetch: (async () => {
        n += 1;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
      }) as unknown as typeof fetch,
    };
  };

  it("a resolver built WITH a store resolves image-bearing child requests", async () => {
    const resolved: string[] = [];
    // The provider captures globalThis.fetch at CONSTRUCTION — stub BEFORE
    // resolve() builds the client, or a real request escapes the test.
    const cap = okFetch();
    const orig = globalThis.fetch;
    globalThis.fetch = cap.fetch;
    try {
      const resolve = createProviderModelResolver({
        env: { WUDAO_GLOBAL_HOME: home },
        attachments: {
          resolveDataUrl: async (r) => {
            resolved.push(r.attachmentId);
            return `data:${r.mediaType};base64,TEST`;
          },
        },
      });
      const r = resolve({ provider: "glm", model: "glm-4v-plus" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const msg = await r.model.generate(imageInput());
      expect(msg.content).toBe("ok");
      expect(resolved).toEqual(["m80-res-1"]); // the seam actually resolved
      expect(cap.calls()).toBe(1); // exactly one request, after resolution
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("a resolver-less build still fails closed no-attachment-store (regression guard)", async () => {
    const cap = okFetch();
    const orig = globalThis.fetch;
    globalThis.fetch = cap.fetch;
    try {
      const resolve = createProviderModelResolver({ env: { WUDAO_GLOBAL_HOME: home } });
      const r = resolve({ provider: "glm", model: "glm-4v-plus" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      await expect(r.model.generate(imageInput())).rejects.toMatchObject({
        name: "UnsupportedContentError",
        code: "UNSUPPORTED_CONTENT",
        reason: "no-attachment-store",
      });
      expect(cap.calls()).toBe(0); // refused BEFORE any network I/O
    } finally {
      globalThis.fetch = orig;
    }
  });
});
