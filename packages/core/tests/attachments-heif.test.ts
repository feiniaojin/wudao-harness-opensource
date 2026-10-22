// 借鉴弧 β2 — HEIC/HEIF/AVIF 解码准入（the upstream 思想，digest-b C4）：
// ftyp 魔数嗅探（字节说了算，声称的 mediaType 永不信任；畸形盒 fail-closed
// 归 null 走原白名单拒绝）→ macOS sips 转 JPEG → 按解码后格式（image/jpeg）
// 准入。★测试红线：解码器全注入假件（零真 sips 子进程）；嗅探夹具为合成
// 小 buffer（16~24 字节，零真图解码）；sips 生命周期用例的假 exec 只写
// mkdtemp 隔离的 tmpdir（自清），绝不写用户目录。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createFileAttachmentStore } from "../src/index.js";
import {
  sniffBmffImageKind,
  sipsJpegArgs,
  bmffInputExtension,
  isJpegSoi,
  createSipsDecoder,
  HeifDecodeError,
  type BmffDecoder,
} from "../src/attachments-heif.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "att-heif-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** A synthetic ISO-BMFF ftyp box: size(4) + "ftyp" + major(4) + minor(4) +
 *  compat brands(4×N). `declaredSize` overrides the size field to build the
 *  malformed shapes the sniffer must refuse. */
const ftyp = (major: string, compat: string[] = [], declaredSize?: number): Uint8Array => {
  const size = declaredSize ?? 16 + compat.length * 4;
  const buf = Buffer.alloc(Math.max(size, 16), 0);
  buf.writeUInt32BE(size, 0);
  buf.write("ftyp", 4, "ascii");
  buf.write(major, 8, "ascii");
  compat.forEach((b, i) => buf.write(b, 16 + i * 4, "ascii"));
  return new Uint8Array(buf);
};

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe("借鉴弧 β2 — ftyp 嗅探（纯函数；畸形一律 fail-closed 归 null）", () => {
  it("major brand：heic/heif 家族与 avif 各归其类", () => {
    expect(sniffBmffImageKind(ftyp("heic"))).toBe("heic");
    expect(sniffBmffImageKind(ftyp("heix"))).toBe("heic");
    expect(sniffBmffImageKind(ftyp("hevc"))).toBe("heic");
    expect(sniffBmffImageKind(ftyp("mif1"))).toBe("heif");
    expect(sniffBmffImageKind(ftyp("msf1"))).toBe("heif");
    expect(sniffBmffImageKind(ftyp("avif"))).toBe("avif");
    expect(sniffBmffImageKind(ftyp("avis"))).toBe("avif");
  });

  it("compatible brands 按声明盒长扫描：major 未知时 compat 命中即归类", () => {
    expect(sniffBmffImageKind(ftyp("uuid", ["abcd", "avif"]))).toBe("avif");
    expect(sniffBmffImageKind(ftyp("mp42", ["mif1"]))).toBe("heif");
  });

  it("白名单格式零误伤：png/jpeg 魔数、非 ftyp 类型、短 buffer 全 null", () => {
    expect(sniffBmffImageKind(PNG_MAGIC)).toBeNull();
    expect(sniffBmffImageKind(JPEG)).toBeNull();
    const notFtyp = ftyp("heic");
    notFtyp[4] = 0x78; // 破坏 "ftyp" 类型字
    expect(sniffBmffImageKind(notFtyp)).toBeNull();
    expect(sniffBmffImageKind(new Uint8Array(15))).toBeNull();
  });

  it("畸形尺寸 fail-closed：声明盒 <16 或越过 buffer → null", () => {
    expect(sniffBmffImageKind(ftyp("heic", [], 12))).toBeNull();
    // 声明 64 实际 16 字节：手工覆写 size 字段（helper 会按声明 alloc，此处要 buffer 短于声明）
    const short = Buffer.from(ftyp("heic"));
    short.writeUInt32BE(64, 0);
    expect(sniffBmffImageKind(new Uint8Array(short))).toBeNull();
  });

  it("声明盒长是扫描边界：brand 在 buffer 内但盒长外 → 不参与判定", () => {
    // buffer 20 字节含 compat avif（偏移 16），声明盒只有 16——brand 在 buffer
    // 内但不在声明盒内，扫描止于盒长 → null。
    const bytes = Buffer.from(ftyp("uuid", ["avif"]));
    bytes.writeUInt32BE(16, 0);
    expect(sniffBmffImageKind(new Uint8Array(bytes))).toBeNull();
  });
});

describe("借鉴弧 β2 — sips 解码器（注入 exec；tmpdir 生命周期红线）", () => {
  it("argv 形状与扩展名纯钉", () => {
    expect(sipsJpegArgs("/tmp/a.heic", "/tmp/a.jpg")).toEqual(["-s", "format", "jpeg", "/tmp/a.heic", "--out", "/tmp/a.jpg"]);
    expect(bmffInputExtension("heic")).toBe(".heic");
    expect(bmffInputExtension("heif")).toBe(".heif");
    expect(bmffInputExtension("avif")).toBe(".avif");
    expect(isJpegSoi(JPEG)).toBe(true);
    expect(isJpegSoi(new Uint8Array([0xff, 0xd9]))).toBe(false);
  });

  it("happy path：字节落 mkdtemp(tmpdir) 输入文件→假 exec 产 JPEG→返回；目录 finally 自清", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "beta2-root-"));
    try {
      const input = ftyp("heic");
      let seenIn = "";
      let seenOut = "";
      const decoder = createSipsDecoder({
        platform: "darwin",
        tmpRoot,
        execFile: async (file, args) => {
          expect(file).toBe("sips");
          expect(args).toEqual(sipsJpegArgs(String(args[3]), String(args[5])));
          seenIn = String(args[3]);
          seenOut = String(args[5]);
          await readFile(seenIn); // 输入文件已写入（存在即读成功）
          await (await import("node:fs/promises")).writeFile(seenOut, JPEG);
        },
      });
      const out = await decoder(input, "heic");
      expect(out).toEqual(JPEG);
      // 红线：解码产物只在 mkdtemp(tmpdir) 隔离目录内，绝不进用户目录。
      expect(seenIn.startsWith(tmpRoot)).toBe(true);
      expect(seenOut.startsWith(tmpRoot)).toBe(true);
      expect(seenIn.endsWith("/input.heic")).toBe(true);
      expect(seenOut.endsWith("/output.jpg")).toBe(true);
      expect(existsSync(dirname(seenIn))).toBe(false); // finally 自清
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("exec 失败 → typed decode-failed（诚实报因）；目录仍自清", async () => {
    let seenIn = "";
    const decoder = createSipsDecoder({
      platform: "darwin",
      execFile: async (_f, args) => { seenIn = String(args[3]); throw new Error("sips: unable to decode"); },
    });
    const err = await decoder(ftyp("avif"), "avif").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeifDecodeError);
    expect((err as HeifDecodeError).reason).toBe("decode-failed");
    expect((err as HeifDecodeError).message).toContain("avif");
    expect(existsSync(dirname(seenIn))).toBe(false);
  });

  it("exec 成功但产出非 JPEG → typed invalid-output（fail-closed 校验输出）", async () => {
    const decoder = createSipsDecoder({
      platform: "darwin",
      execFile: async (_f, args) => {
        await (await import("node:fs/promises")).writeFile(String(args[5]), new Uint8Array([0, 1, 2, 3]));
      },
    });
    const err = await decoder(ftyp("heif"), "heif").catch((e: unknown) => e);
    expect((err as HeifDecodeError).reason).toBe("invalid-output");
  });

  it("非 darwin → typed platform-unsupported，零 exec 零临时目录", async () => {
    let execCalls = 0;
    const decoder = createSipsDecoder({
      platform: "linux",
      execFile: async () => { execCalls += 1; },
    });
    const err = await decoder(ftyp("heic"), "heic").catch((e: unknown) => e);
    expect((err as HeifDecodeError).reason).toBe("platform-unsupported");
    expect(execCalls).toBe(0);
  });
});

describe("借鉴弧 β2 — 准入集成（saveImages 缝；解码器全注入）", () => {
  /** Fake decoder logging its calls, returning `jpeg`. */
  const fakeDecoder = (jpeg: Uint8Array, calls: { bytes: Uint8Array; kind: string }[] = []): BmffDecoder =>
    async (bytes, kind) => { calls.push({ bytes, kind }); return jpeg; };

  it("heic 输入 → 解码后按 image/jpeg 准入：ref/ext/byteLength/getBytes 全按解码后口径", async () => {
    const calls: { bytes: Uint8Array; kind: string }[] = [];
    const heicBytes = ftyp("heic", ["mif1"]);
    const store = createFileAttachmentStore(root, { decodeBmff: fakeDecoder(JPEG, calls) });
    const refs = await store.saveImages([{
      data: Buffer.from(heicBytes).toString("base64"),
      mediaType: "image/heic",
    }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("heic");
    expect(Buffer.from(calls[0]!.bytes).equals(Buffer.from(heicBytes))).toBe(true); // 解码器收到的是原始字节
    expect(refs[0]!.mediaType).toBe("image/jpeg");
    expect(refs[0]!.byteLength).toBe(JPEG.length);
    expect(await store.getBytes(refs[0]!)).toEqual(JPEG);
    const files = await readdir(join(root, ".wudao", "attachments"));
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith(".jpg")).toBe(true); // 扩展名按解码后格式
  });

  it("解码失败 → 整批 fail-closed 拒绝（typed 原因），store 零文件落盘", async () => {
    const failing: BmffDecoder = async (_b, kind) => {
      throw new HeifDecodeError("decode-failed", `sips failed to decode ${kind} bytes: boom`);
    };
    const store = createFileAttachmentStore(root, { decodeBmff: failing });
    await expect(store.saveImages([{ data: Buffer.from(ftyp("heic")).toString("base64"), mediaType: "image/heic" }]))
      .rejects.toMatchObject({ name: "HeifDecodeError", reason: "decode-failed" });
    expect(await readdir(join(root, ".wudao", "attachments")).catch(() => [])).toEqual([]);
  });

  it("字节说了算：heic 字节谎报 image/png 也照样解码准入（声称的 mediaType 永不信任）", async () => {
    const calls: { bytes: Uint8Array; kind: string }[] = [];
    const store = createFileAttachmentStore(root, { decodeBmff: fakeDecoder(JPEG, calls) });
    const refs = await store.saveImages([{
      data: Buffer.from(ftyp("heic")).toString("base64"),
      mediaType: "image/png", // 客户端谎报
    }]);
    expect(calls).toHaveLength(1);
    expect(refs[0]!.mediaType).toBe("image/jpeg");
  });

  it("白名单路径零漂移：png 字节走原路，解码器零调用", async () => {
    const calls: { bytes: Uint8Array; kind: string }[] = [];
    const store = createFileAttachmentStore(root, { decodeBmff: fakeDecoder(JPEG, calls) });
    const refs = await store.saveImages([{ data: Buffer.from(PNG_MAGIC).toString("base64"), mediaType: "image/png" }]);
    expect(calls).toHaveLength(0);
    expect(refs[0]!.mediaType).toBe("image/png");
    expect(refs[0]!.byteLength).toBe(PNG_MAGIC.length);
  });

  it("预算按解码后字节计：解码产物超预算 → IMAGES_TOO_LARGE（typed 链原样）", async () => {
    const store = createFileAttachmentStore(root, { decodeBmff: fakeDecoder(JPEG) });
    await expect(store.saveImages(
      [{ data: Buffer.from(ftyp("avif")).toString("base64"), mediaType: "image/avif" }],
      { maxImages: 9, maxRequestImageBytes: 4 }, // JPEG(6B)→b64(8B) 必超
    )).rejects.toMatchObject({ name: "AttachmentAdmissionError", code: "IMAGES_TOO_LARGE" });
  });

  it("嗅探归 null 的非白名单类型 → 原拒绝语义逐字不变", async () => {
    const store = createFileAttachmentStore(root, { decodeBmff: fakeDecoder(JPEG) });
    await expect(store.saveImages([{ data: Buffer.alloc(8, 1).toString("base64"), mediaType: "image/bmp" }]))
      .rejects.toThrow(/unsupported image media type/);
  });
});
