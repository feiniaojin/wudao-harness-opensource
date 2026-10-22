// M79 §1 — the attachment domain: file-backed AttachmentStore (admission
// limits BEFORE any write, path-traversal refusal, round-trips), the pure
// offload planner's determinism, and the persistence invariant (JSONL lines
// carry refs, never image bytes). Spec invariants 1/3/4 live here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileAttachmentStore,
  createJsonlSessionStore,
  offloadRequestImages,
  base64EncodedLength,
  imageOffloadPlaceholder,
  isValidImageBlock,
  AttachmentAdmissionError,
  UnsupportedContentError,
  DEFAULT_MAX_IMAGES,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  type ImageAttachmentRef,
  type ImageBlock,
} from "../src/index.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "att-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// 3 raw bytes → base64 "AAAA" (4 chars). A tiny deterministic image stand-in.
const b64 = (bytes: number): string => Buffer.alloc(bytes, 7).toString("base64");

const ref = (id: string, bytes: number, mediaType = "image/png"): ImageAttachmentRef => ({
  kind: "image",
  attachmentId: id,
  mediaType,
  byteLength: bytes,
});

const block = (r: ImageAttachmentRef): ImageBlock => ({ kind: "image", ref: r });

describe("createFileAttachmentStore — admission (fail-closed, before any write)", () => {
  it("round-trips saveImages → getBytes/getBase64/resolveDataUrl", async () => {
    const store = createFileAttachmentStore(root);
    const refs = await store.saveImages([{ data: b64(3), mediaType: "image/png" }]);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.kind).toBe("image");
    expect(refs[0]?.mediaType).toBe("image/png");
    expect(refs[0]?.byteLength).toBe(3);
    expect(await store.getBytes(refs[0]!)).toEqual(new Uint8Array([7, 7, 7]));
    expect(await store.getBase64(refs[0]!)).toBe(b64(3));
    expect(await store.resolveDataUrl(refs[0]!)).toBe(`data:image/png;base64,${b64(3)}`);
  });

  it("TOO_MANY_IMAGES throws before any file is written", async () => {
    const store = createFileAttachmentStore(root);
    const batch = Array.from({ length: DEFAULT_MAX_IMAGES + 1 }, () => ({ data: b64(3), mediaType: "image/png" }));
    await expect(store.saveImages(batch)).rejects.toMatchObject({
      name: "AttachmentAdmissionError",
      code: "TOO_MANY_IMAGES",
    });
    // Zero side effects: the attachments dir was never even created.
    await expect(readdir(join(root, ".wudao", "attachments"))).rejects.toThrow();
  });

  it("IMAGES_TOO_LARGE throws before any file is written", async () => {
    const store = createFileAttachmentStore(root);
    // One image whose base64 alone exceeds the default 20MiB budget: raw
    // size chosen so 4*ceil(n/3) > 20MiB.
    const raw = 15 * 1024 * 1024;
    const batch = Array.from({ length: 2 }, () => ({ data: b64(raw), mediaType: "image/png" }));
    await expect(store.saveImages(batch)).rejects.toMatchObject({
      name: "AttachmentAdmissionError",
      code: "IMAGES_TOO_LARGE",
    });
    await expect(readdir(join(root, ".wudao", "attachments"))).rejects.toThrow();
  });

  it("honors caller-provided limit overrides", async () => {
    const store = createFileAttachmentStore(root);
    await expect(
      store.saveImages([{ data: b64(3), mediaType: "image/png" }], { maxImages: 0, maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES }),
    ).rejects.toMatchObject({ code: "TOO_MANY_IMAGES" });
    await expect(
      store.saveImages([{ data: b64(300), mediaType: "image/png" }], { maxImages: 9, maxRequestImageBytes: 100 }),
    ).rejects.toMatchObject({ code: "IMAGES_TOO_LARGE" });
  });

  it("rejects unsupported media types and malformed base64 before writing", async () => {
    const store = createFileAttachmentStore(root);
    await expect(store.saveImages([{ data: b64(3), mediaType: "image/bmp" }])).rejects.toThrow(/unsupported image media type/);
    await expect(store.saveImages([{ data: "!!not-base64!!", mediaType: "image/png" }])).rejects.toThrow(/base64/);
    await expect(store.saveImages([{ data: "", mediaType: "image/png" }])).rejects.toThrow(/base64/);
    await expect(readdir(join(root, ".wudao", "attachments"))).rejects.toThrow();
  });

  it("a failing batch member leaves NO partial writes (validation covers the whole batch first)", async () => {
    const store = createFileAttachmentStore(root);
    await expect(store.saveImages([
      { data: b64(3), mediaType: "image/png" },
      { data: b64(3), mediaType: "image/tiff" },
    ])).rejects.toThrow(/unsupported image media type/);
    await expect(readdir(join(root, ".wudao", "attachments"))).rejects.toThrow();
  });
});

describe("createFileAttachmentStore — read-side path safety", () => {
  it("rejects a path-traversal attachmentId", async () => {
    const store = createFileAttachmentStore(root);
    await expect(store.getBytes(ref("../../etc/passwd", 3))).rejects.toThrow(/invalid attachment id/);
    await expect(store.getBase64(ref("..%2f..%2f", 3))).rejects.toThrow(/invalid attachment id/);
  });

  it("rejects a non-uuid but innocent-looking id (strict shape)", async () => {
    const store = createFileAttachmentStore(root);
    await expect(store.getBase64(ref("not-a-uuid", 3))).rejects.toThrow(/invalid attachment id/);
  });

  it("rejects a media type the store never writes (defense against a doctored ext)", async () => {
    const store = createFileAttachmentStore(root);
    const real = await store.saveImages([{ data: b64(3), mediaType: "image/png" }]);
    const doctored: ImageAttachmentRef = { ...real[0]!, mediaType: "image/bmp" };
    await expect(store.getBytes(doctored)).rejects.toThrow(/unsupported media type/);
  });
});

describe("offloadRequestImages (deterministic, oldest-first)", () => {
  it("keeps everything under budget", () => {
    const blocks = [block(ref("a", 3)), block(ref("b", 6))];
    const r = offloadRequestImages(blocks, 1000);
    expect(r.kept).toHaveLength(2);
    expect(r.omitted).toHaveLength(0);
  });

  it("offloads from the OLDEST until the remainder fits", () => {
    // base64 sizes: a=4, b=8, c=12 → total 24; budget 20 → oldest (a) out.
    const blocks = [block(ref("a", 3)), block(ref("b", 6)), block(ref("c", 9))];
    const r = offloadRequestImages(blocks, 20);
    expect(r.kept.map((b) => b.ref.attachmentId)).toEqual(["b", "c"]);
    expect(r.omitted.map((x) => x.attachmentId)).toEqual(["a"]);
  });

  it("offloads EVERYTHING when even the newest alone cannot fit", () => {
    const blocks = [block(ref("a", 3)), block(ref("huge", 9_000_000))];
    const r = offloadRequestImages(blocks, 100);
    expect(r.kept).toHaveLength(0);
    expect(r.omitted.map((x) => x.attachmentId)).toEqual(["a", "huge"]);
  });

  it("same input → same output (determinism property, repeated builds)", () => {
    // A deterministic pseudo-random list (LCG), built twice and offloaded
    // twice — the plans must be byte-equal, and stable across shuffling of
    // EQUAL-SIZED inputs is NOT required (age order is semantic).
    const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const rand = lcg(42);
    const blocks = Array.from({ length: 40 }, (_, i) => block(ref(`id-${i}`, 1 + Math.floor(rand() * 5000))));
    const one = offloadRequestImages(blocks, 30_000);
    const two = offloadRequestImages(blocks, 30_000);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    // The kept set is always a NEWEST-anchored suffix.
    expect(one.kept.map((b) => b.ref.attachmentId)).toEqual(
      blocks.slice(blocks.length - one.kept.length).map((b) => b.ref.attachmentId),
    );
    expect(one.omitted.every((r2) => imageOffloadPlaceholder(r2).startsWith("[image omitted: "))).toBe(true);
  });

  it("base64EncodedLength matches the real encoded size", () => {
    for (const n of [1, 2, 3, 4, 5, 6, 300, 1024]) {
      expect(base64EncodedLength(n)).toBe(Buffer.alloc(n).toString("base64").length);
    }
  });
});

describe("M79 invariant 1 — JSONL carries refs, zero image bytes", () => {
  it("a session with an image user turn serializes with no data URL and the ref intact", async () => {
    const store = createFileAttachmentStore(root);
    const refs = await store.saveImages([{ data: b64(3), mediaType: "image/png" }]);
    const sessions = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    await sessions.append("s1", { role: "user", content: "what is this?", images: [block(refs[0]!)] });
    await sessions.append("s1", { role: "assistant", content: "a picture" });
    const raw = await readFile(join(root, ".wudao", "sessions", "s1.jsonl"), "utf8");
    expect(raw).not.toContain("data:image");
    expect(raw).not.toContain(b64(3));
    expect(raw).toContain(refs[0]!.attachmentId);
    // And the load round-trip keeps the images field.
    const loaded = await sessions.load("s1");
    expect(loaded[0]).toMatchObject({
      role: "user",
      content: "what is this?",
      images: [{ kind: "image", ref: { attachmentId: refs[0]!.attachmentId } }],
    });
    expect(isValidImageBlock((loaded[0] as { images: unknown[] }).images?.[0])).toBe(true);
  });

  it("validation: a malformed images field invalidates the line (skipped on load)", async () => {
    const sessions = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    await sessions.append("s2", { role: "user", content: "ok" });
    // Hand-write a corrupt images field (not an array of well-formed blocks).
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      join(root, ".wudao", "sessions", "s2.jsonl"),
      `${JSON.stringify({ role: "user", content: "bad", images: [{ kind: "image", ref: 7 }] })}\n`,
    );
    const loaded = await sessions.load("s2");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.content).toBe("ok");
  });
});

describe("typed errors carry stable codes", () => {
  it("AttachmentAdmissionError and UnsupportedContentError shapes", () => {
    const a = new AttachmentAdmissionError("TOO_MANY_IMAGES", "x");
    expect(a.name).toBe("AttachmentAdmissionError");
    expect(a.code).toBe("TOO_MANY_IMAGES");
    const u = new UnsupportedContentError("model-no-image-modality", "y");
    expect(u.name).toBe("UnsupportedContentError");
    expect(u.code).toBe("UNSUPPORTED_CONTENT");
    expect(u.reason).toBe("model-no-image-modality");
  });
});
