// ω99-123 — stored-zip 极小写入器（零依赖纯层）。method 0（不压缩）+
// local file header + central directory + EOCD；CRC32 查表。DOS 日期时间钉
// 常量 1980-01-01 00:00 —— 同一输入永远产出同一字节（确定性验收的根）；
// 124 pptx 复用同一缝。文件名按 UTF-8 编码并置 general purpose bit 0x0800
// （EFS），部件名里的中文/空格/方括号对严格读者合法。
// ω99-222: #1 — zip 域自此读写双向：解压层 unzipEntries（221 为 read_xlsx
// 造在 doc-xlsx-read.ts）移入本模块——zip 是 OOXML 三件套（xlsx/docx/pptx）
// 的共享地基，天然归属是这里（docx/pptx 读面 222 直接复用，不再经 xlsx 转
// 手）。逐字移（行为零漂移，221 R1 继续绿；doc-xlsx-read.ts 顶部 re-export
// 保 221 的 import 连续）。
//
// ω99-230: #1 — 写器纪律演进为**双轨**：make 面（新建文件）照旧只写
// method 0（123 纪程不动）；repack 面（改用户既有包）新增 smartZip 按条目
// 透传原 method。动因：用户用 Excel/Word/PowerPoint 存的 .xlsx/.docx/.pptx
// 是 deflate（method 8）压缩包（XML 压 5-10 倍），五个 repack 写面
// （append_docx / append_pptx / append_xlsx / replace_docx / replace_pptx）
// 此前回装全走 storedZip——改一处全包重装为不压缩，文件胖数倍（223/228/
// 229 三弧报告连续披露的债，本弧收口）。裁定（超越点，行业惯做「自己的
// 压缩器全包重压」——python zipfile / 多数 OOXML 库，丢条目级保真且未改
// 条目也被重压出不同字节）：**条目级三形 + 载荷原字节直过**——① 未改条目
// （内容与解压原内容字节等）→ 原压缩载荷字节直过（原 method/原 CRC/原两
// 尺寸，零重压漂移：回装后未改部件与用户原包逐字节等）；② 已改条目且原
// method 8 → deflateRawSync 固定选项重压（文件尺寸回原量级）；③ 已改条目
// 且原 method 0（或无原）→ 照旧 stored。**改动判定不靠调用方旗帜——
// smartZip 自行 bytesEqual 比对解压原内容**：API 无法谎报「没改」，未改就
// 是直过。诚实边界：已改条目的 deflate 字节不与 Office 自家 zlib 逐字节同
// （同 method 同内容，压缩器实现差）；smartZip 字节稳定性绑定本机 zlib
// （跨版本不承诺逐字节重现——同机确定性足够，M24 断言都在同机跑）。
//
// 纪律（brief 钉；230 起压缩法双轨）：
// - 压缩法：make 面（storedZip，新建文件）只写 method 0——不压缩，压缩/
//   未压缩大小恒等，CRC 直接可复算；repack 面（smartZip，改既有包）按条目
//   透传原 method（未改原载荷直过 / 已改按原 method 重压 / 无原 stored，
//   见上方 ω99-230 注）；
// - 时间两字（time/date）全部钉常量，绝不读时钟 —— 字节确定性是弧的
//   验收面（同输入两次全等），任何「现在时间」进来都会破坏它；
// - 条目名与数据不做任何改写（append-only 精神：写什么就是什么）。
// - 解压侧（221 纪律随移）：加密旗（bit 0）与 Zip64 标记诚实拒；typed 拒
//   优于静默剥；纯函数不碰盘。

import { deflateRawSync, inflateRawSync } from "node:zlib";

/** 查表法 CRC-32（反射式，多项式 0xEDB88320；'123456789' → 0xCBF43926）。 */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 日期 1980-01-01：((1980-1980)<<9) | (1<<5) | 1 —— 钉常量。 */
const DOS_DATE = 0x0021;
/** DOS 时间 00:00:00 —— 钉常量（与日期一起，保字节确定性）。 */
const DOS_TIME = 0x0000;
/** general purpose bit 11：文件名按 UTF-8 编码（EFS）。 */
const UTF8_FLAG = 0x0800;

/** 一个 zip 条目：名字（任意 UTF-8）+ 原始字节（不压缩存入）。 */
export interface StoredZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** 组装一个 stored（method 0）zip 包。纯函数：不碰时钟、不碰盘。 */
export function storedZip(entries: readonly StoredZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) {
    throw new Error(`storedZip supports at most 65535 entries, got ${entries.length}`);
  }
  const enc = new TextEncoder();
  const names = entries.map((e) => enc.encode(e.name));
  const localLen = entries.reduce((s, e, i) => s + 30 + names[i]!.length + e.data.length, 0);
  const centralLen = names.reduce((s, n) => s + 46 + n.length, 0);
  const out = new Uint8Array(localLen + centralLen + 22);
  const dv = new DataView(out.buffer);
  let o = 0;
  const localOffsets: number[] = [];

  entries.forEach((entry, i) => {
    const name = names[i]!;
    const crc = crc32(entry.data);
    localOffsets.push(o);
    // local file header（30 字节 + 文件名 + 数据）。
    dv.setUint32(o, 0x04034b50, true); // signature
    dv.setUint16(o + 4, 20, true); // version needed (2.0)
    dv.setUint16(o + 6, UTF8_FLAG, true); // flags: UTF-8 names
    dv.setUint16(o + 8, 0, true); // method 0 = stored
    dv.setUint16(o + 10, DOS_TIME, true);
    dv.setUint16(o + 12, DOS_DATE, true);
    dv.setUint32(o + 14, crc, true);
    dv.setUint32(o + 18, entry.data.length, true); // compressed size
    dv.setUint32(o + 22, entry.data.length, true); // uncompressed size
    dv.setUint16(o + 26, name.length, true);
    dv.setUint16(o + 28, 0, true); // extra length
    out.set(name, o + 30);
    out.set(entry.data, o + 30 + name.length);
    o += 30 + name.length + entry.data.length;
  });

  const cdStart = o;
  entries.forEach((entry, i) => {
    const name = names[i]!;
    dv.setUint32(o, 0x02014b50, true); // signature
    dv.setUint16(o + 4, 20, true); // version made by
    dv.setUint16(o + 6, 20, true); // version needed
    dv.setUint16(o + 8, UTF8_FLAG, true);
    dv.setUint16(o + 10, 0, true); // method 0
    dv.setUint16(o + 12, DOS_TIME, true);
    dv.setUint16(o + 14, DOS_DATE, true);
    dv.setUint32(o + 16, crc32(entry.data), true);
    dv.setUint32(o + 20, entry.data.length, true);
    dv.setUint32(o + 24, entry.data.length, true);
    dv.setUint16(o + 28, name.length, true);
    dv.setUint16(o + 30, 0, true); // extra length
    dv.setUint16(o + 32, 0, true); // comment length
    dv.setUint16(o + 34, 0, true); // disk number start
    dv.setUint16(o + 36, 0, true); // internal attrs
    dv.setUint32(o + 38, 0, true); // external attrs
    dv.setUint32(o + 42, localOffsets[i]!, true); // local header offset
    out.set(name, o + 46);
    o += 46 + name.length;
  });

  // EOCD（22 字节，无注释）。
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 4, 0, true);
  dv.setUint16(o + 6, 0, true);
  dv.setUint16(o + 8, entries.length, true);
  dv.setUint16(o + 10, entries.length, true);
  dv.setUint32(o + 12, o - cdStart, true); // central directory size
  dv.setUint32(o + 16, cdStart, true); // central directory offset
  dv.setUint16(o + 20, 0, true); // comment length
  return out;
}

// ---------------------------------------------------------------------------
// 解压纯层（ω99-221 造、222 自 doc-xlsx-read.ts 逐字移入——EOCD 尾扫
// → 中央目录 → local header 跳头）。xlsx/docx/pptx 同为 OOXML zip，三件套
// 读面共用；doc-xlsx-read.ts 顶部 re-export 保 221 的 import 连续。
// ---------------------------------------------------------------------------

/** 一个解出的 zip 条目：部件名（UTF-8）+ 原始字节（已解压）。 */
export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

export type UnzipCheck =
  | { readonly ok: true; readonly entries: readonly ZipEntry[] }
  | { readonly ok: false; readonly error: string };

const EOCD_SIG = 0x06054b50; // PK\x05\x06
const CD_SIG = 0x02014b50; // PK\x01\x02
const LOCAL_SIG = 0x04034b50; // PK\x03\x04
const ZIP64_MARKER = 0xffffffff;
const ENCRYPTED_FLAG = 0x0001;
const MAX_ZIP_COMMENT = 0xffff;

/** EOCD 尾扫：从尾部向前找 PK\x05\x06（注释区最长 64 KiB）。找到返回偏移，
 *  找不到 undefined（坏 zip / 非 zip）。纯。 */
function findEocd(bytes: Uint8Array): number | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const floor = Math.max(0, bytes.length - 22 - MAX_ZIP_COMMENT);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) return i;
  }
  return undefined;
}

/** 解压一个 zip 包（xlsx/docx/pptx 都是 zip）。method 0 直取、method 8
 *  inflateRawSync；加密条目与 Zip64 标记诚实拒（typed 拒，错误文案用户语）。
 *  纯函数。（错误文案是 221 的 xlsx 口径原样——docx/pptx 读面各自把可行动
 *  的类映射成自家词汇，不在此处分叉。） */
export function unzipEntries(bytes: Uint8Array): UnzipCheck {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes);
  if (eocd === undefined) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
  }
  const entryCount = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  // Zip64：EOCD 的条目数/目录偏移/大小任一踩 0xFFFF/0xFFFFFFFF 标记即拒。
  if (entryCount === 0xffff || cdSize === ZIP64_MARKER || cdOffset === ZIP64_MARKER) {
    return { ok: false, error: "这个文件超出了当前读取能力的范围（超大包），暂不支持读取" };
  }
  if (cdOffset + cdSize > eocd) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
  }

  const dec = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== CD_SIG) {
      return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    if (flags & ENCRYPTED_FLAG) {
      return { ok: false, error: "这个文件有密码保护，读取不了——请在 Excel 里打开并另存为无密码的 .xlsx 副本后再试" };
    }
    if (compSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      return { ok: false, error: "这个文件超出了当前读取能力的范围（超大包），暂不支持读取" };
    }
    if (method !== 0 && method !== 8) {
      return { ok: false, error: "这个文件用了暂不支持的压缩方式，读取不了" };
    }
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // local header：偏移与名长/extra 长必须读 local 自己的（中央目录与本地
    // 头的 extra 长度可以不同——经典陷阱）。
    if (localOffset + 30 > bytes.length || dv.getUint32(localOffset, true) !== LOCAL_SIG) {
      return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
    }
    const localNameLen = dv.getUint16(localOffset + 26, true);
    const localExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) {
      return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
    }
    const raw = bytes.subarray(dataStart, dataEnd);
    try {
      entries.push({ name, data: method === 0 ? raw.slice() : inflateRawSync(raw) });
    } catch {
      return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件内容已损坏" };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// ω99-230 — repack 面透传增量（文件头 ω99-230 注）：unzipEntriesWithMeta
// （解出原 method / 原压缩载荷 / 原 CRC / 原压缩尺寸）+ smartZip（按条目
// 三形裁定回装）。make 面三写器（doc-xlsx / doc-pptx / doc-docx）继续
// storedZip——新建文件全 stored 是写器纪律，不掺透传。
// ---------------------------------------------------------------------------

/** 朴素逐字节比（无计时安全诉求——比对双方是解压产物自比，无时序面）。 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 一个解出的 zip 条目（meta 形）：部件名 + 解压内容 + 原压缩形——method
 *  0|8、raw=原压缩载荷字节、crc=原中央目录 CRC32、compSize=原压缩尺寸。 */
export interface RawZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method: 0 | 8;
  readonly raw: Uint8Array;
  readonly crc: number;
  readonly compSize: number;
}

export type UnzipWithMetaCheck =
  | { readonly ok: true; readonly entries: readonly RawZipEntry[] }
  | { readonly ok: false; readonly error: string };

/** 解压并保留每条目的原压缩形——unzipEntries 的镜像（EOCD/CD/local 步行
 *  逻辑复制不重构，228 scanXlsxSheetPart 先例；拒链逐字同本体：加密/
 *  Zip64/坏结构同文案同拒）。repack 面专用：smartZip 的透传裁定吃这里的
 *  meta。纯函数：不碰盘。（unzipEntries 本体与返回形零动——读面三消费者
 *  零漂移。） */
export function unzipEntriesWithMeta(bytes: Uint8Array): UnzipWithMetaCheck {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes);
  if (eocd === undefined) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
  }
  const entryCount = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  // Zip64：EOCD 的条目数/目录偏移/大小任一踩 0xFFFF/0xFFFFFFFF 标记即拒。
  if (entryCount === 0xffff || cdSize === ZIP64_MARKER || cdOffset === ZIP64_MARKER) {
    return { ok: false, error: "这个文件超出了当前读取能力的范围（超大包），暂不支持读取" };
  }
  if (cdOffset + cdSize > eocd) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
  }

  const dec = new TextDecoder();
  const entries: RawZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== CD_SIG) {
      return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    if (flags & ENCRYPTED_FLAG) {
      return { ok: false, error: "这个文件有密码保护，读取不了——请在 Excel 里打开并另存为无密码的 .xlsx 副本后再试" };
    }
    if (compSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      return { ok: false, error: "这个文件超出了当前读取能力的范围（超大包），暂不支持读取" };
    }
    if (method !== 0 && method !== 8) {
      return { ok: false, error: "这个文件用了暂不支持的压缩方式，读取不了" };
    }
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // local header：偏移与名长/extra 长必须读 local 自己的（中央目录与本地
    // 头的 extra 长度可以不同——经典陷阱）。
    if (localOffset + 30 > bytes.length || dv.getUint32(localOffset, true) !== LOCAL_SIG) {
      return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
    }
    const localNameLen = dv.getUint16(localOffset + 26, true);
    const localExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) {
      return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
    }
    // 原压缩载荷切片拷贝（脱离源缓冲——repack 面要把 raw 留到回装时用）；
    // method 0 时 raw 即内容，data 共享同一拷贝。
    const raw = bytes.subarray(dataStart, dataEnd).slice();
    try {
      entries.push({ name, data: method === 0 ? raw : inflateRawSync(raw), method, raw, crc, compSize });
    } catch {
      return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件内容已损坏" };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries };
}

/** smartZip 的一个条目：名字 + 当前内容 + 可选原条目 meta（repack 面装填：
 *  调用方对每条目统一挂 meta，改动判定交给 smartZip 自行 bytesEqual 重推导
 *  ——无信任旗帜）；缺 meta 视为无原条目（新部件），缺省 stored。 */
export interface SmartZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly meta?: RawZipEntry;
}

/** 三形裁定后的落盘形：local 与 CD 同 method 同 CRC 同两尺寸（228 R1 的
 *  CRC 链同形纪律）。 */
interface ZippedPlan {
  readonly name: Uint8Array;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly comp: number;
  readonly uncomp: number;
  readonly payload: Uint8Array;
}

/** 回装一个 zip 包（repack 面）：按条目三形裁定——未改直过（原载荷/原
 *  method/原 CRC/原两尺寸）、已改原 deflate 重压（method 8）、已改原 stored
 *  或无原 stored（123 写器纪律）——详见文件头 ω99-230 注。local/CD/EOCD
 *  结构照 storedZip 现形（version 2.0 / UTF8 旗 / DOS 常量时戳 / 偏移链），
 *  method 与尺寸字段按裁定填；条目名序=输入序（调用方传原序=原包序）。
 *  纯函数：不碰时钟、不碰盘。 */
export function smartZip(entries: readonly SmartZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) {
    throw new Error(`smartZip supports at most 65535 entries, got ${entries.length}`);
  }
  const enc = new TextEncoder();
  const plans = entries.map<ZippedPlan>((entry) => {
    const name = enc.encode(entry.name);
    const meta = entry.meta;
    // 形①：未改条目（内容与解压原内容字节等）→ 原压缩载荷字节直过。
    if (meta !== undefined && bytesEqual(entry.data, meta.data)) {
      return { name, method: meta.method, crc: meta.crc, comp: meta.compSize, uncomp: meta.data.length, payload: meta.raw };
    }
    const method: 0 | 8 = meta?.method ?? 0;
    if (method === 8) {
      // 形②：已改条目且原 method 8 → 重压。固定选项 {level: 6} 钉确定性
      // （同输入同机两次全等；字节稳定性绑定本机 zlib，见文件头注）。
      const payload = deflateRawSync(entry.data, { level: 6 });
      return { name, method, crc: crc32(entry.data), comp: payload.length, uncomp: entry.data.length, payload };
    }
    // 形③：已改条目且原 method 0（或无原）→ 照旧 stored。
    return { name, method: 0, crc: crc32(entry.data), comp: entry.data.length, uncomp: entry.data.length, payload: entry.data };
  });
  const localLen = plans.reduce((s, p) => s + 30 + p.name.length + p.comp, 0);
  const centralLen = plans.reduce((s, p) => s + 46 + p.name.length, 0);
  const out = new Uint8Array(localLen + centralLen + 22);
  const dv = new DataView(out.buffer);
  let o = 0;
  const localOffsets: number[] = [];

  plans.forEach((p) => {
    localOffsets.push(o);
    // local file header（30 字节 + 文件名 + 载荷）。
    dv.setUint32(o, 0x04034b50, true); // signature
    dv.setUint16(o + 4, 20, true); // version needed (2.0)
    dv.setUint16(o + 6, UTF8_FLAG, true); // flags: UTF-8 names
    dv.setUint16(o + 8, p.method, true);
    dv.setUint16(o + 10, DOS_TIME, true);
    dv.setUint16(o + 12, DOS_DATE, true);
    dv.setUint32(o + 14, p.crc, true);
    dv.setUint32(o + 18, p.comp, true); // compressed size
    dv.setUint32(o + 22, p.uncomp, true); // uncompressed size
    dv.setUint16(o + 26, p.name.length, true);
    dv.setUint16(o + 28, 0, true); // extra length
    out.set(p.name, o + 30);
    out.set(p.payload, o + 30 + p.name.length);
    o += 30 + p.name.length + p.comp;
  });

  const cdStart = o;
  plans.forEach((p, i) => {
    dv.setUint32(o, 0x02014b50, true); // signature
    dv.setUint16(o + 4, 20, true); // version made by
    dv.setUint16(o + 6, 20, true); // version needed
    dv.setUint16(o + 8, UTF8_FLAG, true);
    dv.setUint16(o + 10, p.method, true);
    dv.setUint16(o + 12, DOS_TIME, true);
    dv.setUint16(o + 14, DOS_DATE, true);
    dv.setUint32(o + 16, p.crc, true);
    dv.setUint32(o + 20, p.comp, true);
    dv.setUint32(o + 24, p.uncomp, true);
    dv.setUint16(o + 28, p.name.length, true);
    dv.setUint16(o + 30, 0, true); // extra length
    dv.setUint16(o + 32, 0, true); // comment length
    dv.setUint16(o + 34, 0, true); // disk number start
    dv.setUint16(o + 36, 0, true); // internal attrs
    dv.setUint32(o + 38, 0, true); // external attrs
    dv.setUint32(o + 42, localOffsets[i]!, true); // local header offset
    out.set(p.name, o + 46);
    o += 46 + p.name.length;
  });

  // EOCD（22 字节，无注释）。
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 4, 0, true);
  dv.setUint16(o + 6, 0, true);
  dv.setUint16(o + 8, plans.length, true);
  dv.setUint16(o + 10, plans.length, true);
  dv.setUint32(o + 12, o - cdStart, true); // central directory size
  dv.setUint32(o + 16, cdStart, true); // central directory offset
  dv.setUint16(o + 20, 0, true); // comment length
  return out;
}
