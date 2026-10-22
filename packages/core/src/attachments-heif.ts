// 借鉴弧 β2 — HEIC/HEIF/AVIF 解码准入（the upstream 思想，digest-b C4）。
// 在位者对垒：IMAGE_MEDIA_TYPES 白名单（attachments.ts，fail-closed 拒绝式）对
// iPhone 默认格式 image/heic 硬拒——目标平台 macOS + iPhone 用户把照片拖进
// 附件口即失败。本模块把「拒」变「能用」，准入边界一步扩展且零新依赖：
//
//   嗅探   ISO-BMFF `ftyp` 魔数（major + 兼容 brand，按声明盒长扫描，畸形
//          尺寸 fail-closed 归 null）；**扩展名/声称的 mediaType 永不信任**
//          ——字节说了算（the upstream rule）。png/jpeg/webp/gif 首盒永不是 ftyp，
//          现有白名单路径零漂移。
//   解码   macOS 系统 sips 子进程转 JPEG（目标平台内置；非 darwin 或 sips
//          失败→维持现拒，typed 诚实报因）。
//   红线   解码产物只落 mkdtemp(os.tmpdir()) 自建目录（finally 自清），绝不
//          写用户目录；工作区 store 写入仍只在整批准入全过后发生。
//   准入   按解码后格式：产出以 image/jpeg 入库（ref/扩展名/预算口径全按
//          解码后字节），M79 引用制不变——解码只影响准入，不碰任何前缀字节
//          （字节从不入史，data: URL 只在单次请求构建期存在）。
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The ISO-BMFF image families sips can decode for us. */
export type BmffImageKind = "heic" | "heif" | "avif";

/** One admission-time decoder: bytes in (the sniffed family), JPEG bytes out.
 *  Throws HeifDecodeError on any failure — the caller lets it propagate so
 *  the batch fails closed BEFORE the first workspace write, with the honest
 *  reason attached. */
export type BmffDecoder = (bytes: Uint8Array, kind: BmffImageKind) => Promise<Uint8Array>;

/** Typed decode failure (stable reasons asserted by tests and surfaced to
 *  the user by the admission op). */
export type HeifDecodeReason = "platform-unsupported" | "decode-failed" | "invalid-output";

export class HeifDecodeError extends Error {
  readonly reason: HeifDecodeReason;

  constructor(reason: HeifDecodeReason, message: string) {
    super(message);
    this.name = "HeifDecodeError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 嗅探（纯函数，零 I/O——被准入路径对每张图都跑一次，白名单格式首盒非
// ftyp 秒过）
// ---------------------------------------------------------------------------

/** Brand → family table. iPhone photos: major `heic` (or `heix`/`hevc` when
 *  10-bit); generic HEIF containers: `mif1`/`msf1` (major often `mif1` with
 *  `heic` in compatible brands); AVIF: `avif`/`avis`. */
const BRAND_KINDS: Readonly<Record<string, BmffImageKind>> = {
  heic: "heic", heix: "heic", heim: "heic", heis: "heic", hevc: "heic", hevx: "heic",
  heif: "heif", mif1: "heif", msf1: "heif", mif2: "heif",
  avif: "avif", avis: "avif",
};

const ascii = (bytes: Uint8Array, start: number, len: number): string => {
  let out = "";
  for (let i = start; i < start + len; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
};

/** Sniff the ISO-BMFF `ftyp` box and map its brands to the decodable family.
 *  Fail-closed on every malformed shape: shorter than the minimal ftyp box
 *  (16 bytes), non-ftyp type, declared box size < 16 or running past the
 *  buffer — all return null (the caller then falls back to the whitelist
 *  rejection, exactly as before β2). Compatible brands are scanned only up
 *  to the DECLARED box length (the upstream: scan by declared box length) and never past the
 *  buffer. */
export function sniffBmffImageKind(bytes: Uint8Array): BmffImageKind | null {
  if (bytes.length < 16) return null;
  if (ascii(bytes, 4, 4) !== "ftyp") return null;
  const size = (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
  if (size < 16) return null; // a well-formed ftyp box is at least header+major+minor
  if (size > bytes.length) return null; // declared box runs past the buffer → malformed
  const major = ascii(bytes, 8, 4);
  const majorKind = BRAND_KINDS[major];
  if (majorKind !== undefined) return majorKind;
  // Compatible brands start at offset 16, four bytes each, bounded by BOTH
  // the declared box size and the buffer (size ≤ length already proven).
  for (let off = 16; off + 4 <= size; off += 4) {
    const kind = BRAND_KINDS[ascii(bytes, off, 4)];
    if (kind !== undefined) return kind;
  }
  return null;
}

/** The temp-file extension for one family (cosmetic for sips — it decodes by
 *  content; the extension only keeps the staged input recognizable). */
export function bmffInputExtension(kind: BmffImageKind): ".heic" | ".heif" | ".avif" {
  if (kind === "heic") return ".heic";
  if (kind === "heif") return ".heif";
  return ".avif";
}

/** The sips argv that converts `inPath` to JPEG at `outPath` (pure — the
 *  argv shape is literal-pinned by tests; production and fakes share it). */
export function sipsJpegArgs(inPath: string, outPath: string): string[] {
  return ["-s", "format", "jpeg", inPath, "--out", outPath];
}

/** JPEG SOI check (the only output validation — cheap and honest: sips
 *  claiming success but emitting non-JPEG bytes still fails closed). */
export function isJpegSoi(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

// ---------------------------------------------------------------------------
// sips 解码器（生产实现；平台门+注入缝）
// ---------------------------------------------------------------------------

/** Production exec seam (callback → promise; 30s decode bound). */
const defaultExecFile = (file: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFileCb(file, args, { timeout: 30_000 }, (err) => (err === null ? resolve() : reject(err)));
  });

export interface SipsDecoderOptions {
  /** Platform gate override (default process.platform — tests inject). */
  readonly platform?: string;
  /** exec seam override (default: node child_process.execFile with sips). */
  readonly execFile?: (file: string, args: readonly string[]) => Promise<void>;
  /** mkdtemp root override (default os.tmpdir() — tests may isolate). */
  readonly tmpRoot?: string;
}

/** The macOS system decoder: stage the bytes in a mkdtemp(os.tmpdir())
 *  directory, run `sips -s format jpeg`, validate the output, and REMOVE
 *  the directory in a finally (the red line: decode artifacts never touch a
 *  user directory, and never outlive the call). Non-darwin platforms fail
 *  closed with the typed platform reason BEFORE any temp write. */
export function createSipsDecoder(opts: SipsDecoderOptions = {}): BmffDecoder {
  const platform = opts.platform ?? process.platform;
  const exec = opts.execFile ?? defaultExecFile;
  const tmpRoot = opts.tmpRoot ?? tmpdir();
  return async (bytes, kind) => {
    if (platform !== "darwin") {
      throw new HeifDecodeError(
        "platform-unsupported",
        `${kind} bytes need macOS sips to decode (platform: ${platform}) — admitting them undecoded would just move the failure downstream; refusing`,
      );
    }
    const dir = await mkdtemp(join(tmpRoot, "wudao-heif-"));
    try {
      const inPath = join(dir, `input${bmffInputExtension(kind)}`);
      const outPath = join(dir, "output.jpg");
      await writeFile(inPath, bytes);
      let out: Uint8Array;
      try {
        await exec("sips", sipsJpegArgs(inPath, outPath));
        out = new Uint8Array(await readFile(outPath));
      } catch (err) {
        // exec failure and a missing output file are the same honest fact:
        // sips did not produce a decodable artifact.
        throw new HeifDecodeError(
          "decode-failed",
          `sips failed to decode ${kind} bytes: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!isJpegSoi(out)) {
        throw new HeifDecodeError(
          "invalid-output",
          `sips reported success but the output is not a JPEG (${out.length} bytes) — refusing to admit unvalidated bytes`,
        );
      }
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {
        // Best-effort cleanup of OUR OWN mkdtemp directory under os.tmpdir();
        // a failure here must never mask (or replace) the decode outcome.
      });
    }
  };
}
