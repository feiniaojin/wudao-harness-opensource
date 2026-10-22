// ω99-123 — A1: stored-zip 纯层（CRC32 查表 + method 0 不压缩 zip 组装）。
// 弧门：「对宠物说『把这份清单做成 Excel』，它真的交出一个能双击打开的
// .xlsx 文件，并告诉你存在哪。」——doc-zip 是这份字节确定性的地基（DOS
// 日期时间钉常量 1980-01-01 00:00），124 pptx 复用同一缝。RED-first。
import { describe, it, expect } from "vitest";
import { crc32, storedZip } from "../src/doc-zip.js";

const enc = new TextEncoder();
const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

describe("ω99-123 A1 — crc32（查表法，标准反射 CRC-32）", () => {
  it("已知向量：'123456789' → 0xCBF43926（规范检验值）", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });

  it("空输入 → 0；'a' → 0xE8B7BE43；'abc' → 0x352441C2", () => {
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
    expect(crc32(enc.encode("a"))).toBe(0xe8b7be43);
    expect(crc32(enc.encode("abc"))).toBe(0x352441c2);
  });

  it("UTF-8 多字节（中文/方括号部件名）稳定可复算", () => {
    const data = enc.encode("[Content_Types].xml 与 表格.xml");
    expect(crc32(data)).toBe(crc32(enc.encode("[Content_Types].xml 与 表格.xml")));
    expect(crc32(data)).not.toBe(0);
  });
});

describe("ω99-123 A1 — storedZip（method 0，字节确定性）", () => {
  const entries = [
    { name: "[Content_Types].xml", data: enc.encode("<Types/>") },
    { name: "xl/worksheets/sheet 1.xml", data: enc.encode("<worksheet 悟=\"道\"/>") },
    { name: "空.bin", data: new Uint8Array(0) },
  ];
  const zip = (): Uint8Array => storedZip(entries);

  it("同输入两次构建逐字节全等（时间钉常量的存在性证明）", () => {
    const a = zip();
    const b = zip();
    expect(a.length).toBe(b.length);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("EOCD：签名/磁盘号 0/条目计数 3/注释长 0", () => {
    const z = zip();
    const e = z.length - 22;
    expect(u32(z, e)).toBe(0x06054b50);
    expect(u16(z, e + 4)).toBe(0);
    expect(u16(z, e + 6)).toBe(0);
    expect(u16(z, e + 8)).toBe(3);
    expect(u16(z, e + 10)).toBe(3);
    expect(u16(z, e + 20)).toBe(0);
  });

  it("自产自读：极简 central-directory 解析器——部件名/顺序/CRC 复算相等/local 头链", () => {
    const z = zip();
    const e = z.length - 22;
    const count = u16(z, e + 10);
    const cdSize = u32(z, e + 12);
    const cdOff = u32(z, e + 16);
    expect(count).toBe(3);
    let p = cdOff;
    const seen: { name: string; crc: number; size: number; localOff: number }[] = [];
    for (let i = 0; i < count; i++) {
      expect(u32(z, p)).toBe(0x02014b50);
      const crc = u32(z, p + 16);
      const size = u32(z, p + 24);
      const nameLen = u16(z, p + 28);
      const localOff = u32(z, p + 42);
      const name = new TextDecoder().decode(z.subarray(p + 46, p + 46 + nameLen));
      seen.push({ name, crc, size, localOff });
      p += 46 + nameLen;
    }
    expect(p - cdOff).toBe(cdSize);
    expect(seen.map((s) => s.name)).toEqual([
      "[Content_Types].xml",
      "xl/worksheets/sheet 1.xml",
      "空.bin",
    ]);
    for (const [i, s] of seen.entries()) {
      // 声称的 local 偏移上确有 local file header，且 CRC/大小与数据复算相等。
      expect(u32(z, s.localOff)).toBe(0x04034b50);
      const localNameLen = u16(z, s.localOff + 26);
      const dataOff = s.localOff + 30 + localNameLen;
      const data = z.subarray(dataOff, dataOff + s.size);
      expect(data.length).toBe(entries[i]!.data.length);
      expect(crc32(data)).toBe(s.crc);
      // method 0 = stored：local 与 central 的压缩/未压缩大小一致。
      expect(u32(z, s.localOff + 18)).toBe(s.size);
      expect(u32(z, s.localOff + 22)).toBe(s.size);
    }
  });

  it("UTF-8 文件名：local 与 central 的 general purpose bit 0x0800 均置位；method=0", () => {
    const z = zip();
    const e = z.length - 22;
    const cdOff = u32(z, e + 16);
    // 走到第三个条目（非 ASCII 名）：跳过前两条 central 记录。
    let p = cdOff;
    p += 46 + u16(z, p + 28);
    p += 46 + u16(z, p + 28);
    const thirdNameLen = u16(z, p + 28);
    const thirdLocalOff = u32(z, p + 42);
    expect(thirdNameLen).toBe(7); // 「空」3 字节 + ".bin" 4 字节
    expect(u16(z, thirdLocalOff + 6) & 0x0800).toBe(0x0800);
    expect(u16(z, thirdLocalOff + 8)).toBe(0);
    expect(u16(z, p + 8) & 0x0800).toBe(0x0800);
    expect(u16(z, p + 10)).toBe(0);
    // central 第 1 条同断言（flags/method）。
    expect(u16(z, cdOff + 8) & 0x0800).toBe(0x0800);
    expect(u16(z, cdOff + 10)).toBe(0);
  });

  it("DOS 日期时间钉常量：1980-01-01 00:00（date=0x0021，time=0x0000）", () => {
    const z = zip();
    const e = z.length - 22;
    const cdOff = u32(z, e + 16);
    expect(u16(z, cdOff + 12)).toBe(0x0000);
    expect(u16(z, cdOff + 14)).toBe(0x0021);
    const localOff = u32(z, cdOff + 42);
    expect(u16(z, localOff + 10)).toBe(0x0000);
    expect(u16(z, localOff + 12)).toBe(0x0021);
  });

  it("空条目表 → 仅 EOCD 22 字节（fail-loud 边界）", () => {
    const z = storedZip([]);
    expect(z.length).toBe(22);
    expect(u16(z, 10)).toBe(0);
  });
});
