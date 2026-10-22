// ω99-202 receipts — App error 尾 9 面中文化（` failed: ` → ` 失败：`）：
// 200 披露③池矿弧。九面全同形 `notify(`⚠️ X failed: ${…}`)`——仅尾词
// 换全角冒号中文（与 200 #3 `} 失败：${` 同胞词表）；X token 不译
// （/language、/resume、/edit、submit、setMode、resume、/effort 原样），
// ⚠️ 前缀、${…} 插值、catch 结构零触。A 源钉法（199/200 receipts 同法
// readFileSync）九新串在场；B 反向 App.tsx 英文尾归零 + dist bundle 计数
// 改造前基线 10 −9 = 1（唯一存活 = attachments.ts 的 read failed 别域面，
// 200 census 亲证 protocol.ts/ProviderDetail.tsx 命中皆注释、构建剥离）。
// ω99-234 census 演进（同形）：/language 面随语言 chip 迁设置页退役
// （写道搬进 PreferencesTab.setLanguageDefault）——App 九面 → 八面，② 18 → 16。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appSrc: string = readFileSync(
  fileURLToPath(new URL("../src/components/App.tsx", import.meta.url)),
  "utf8",
);

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// dist bundle 反查（B⑤）：主/侧 bundle 逐文件字节级计数。
const distFailedTails = (): number => {
  const dir = fileURLToPath(new URL("../dist/assets", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .reduce(
      (n, f) => n + countOf(readFileSync(`${dir}/${f}`, "utf8"), " failed: "),
      0,
    );
};

describe("ω99-202 — A 正向：App error 尾中文形在场（源钉法；ω99-234 后八面）", () => {
  // ω99-258: #13 — /edit 门并入 armFromTurn 统一缝：①词面随迁（岔开失败/解除岔开失败），②16→17。
  it("① 八新串全在场：六独一词面 + submit×2 / /effort×2 计数 ≥2（token 原样、⚠️ 前缀与 e instanceof Error 插值同锁；/language 面 ω99-234 随迁退役；ω99-258 随源演进：/edit 门并入 armFromTurn 统一缝，词面随迁 岔开失败/解除岔开失败 两面）", () => {
    expect(appSrc).toContain("`⚠️ /resume 失败：${e instanceof Error");
    expect(appSrc).toContain("`⚠️ 岔开失败：${e instanceof Error");
    expect(appSrc).toContain("`⚠️ 解除岔开失败：${e instanceof Error");
    expect(appSrc).toContain("`⚠️ setMode 失败：${e instanceof Error");
    expect(appSrc).toContain("`⚠️ resume 失败：${e instanceof Error");
    expect(countOf(appSrc, "`⚠️ submit 失败：${e instanceof Error")).toBeGreaterThanOrEqual(2);
    expect(countOf(appSrc, "`⚠️ /effort 失败：${e instanceof Error")).toBeGreaterThanOrEqual(2);
  });

  // ω99-204 随源演进：App warn 族 8 面并入同插值形，10 → 18（面零交、计数聚钉必演进）。
  // ω99-234 随源演进：/language 与 默认语言保存 两面随语言 chip 迁设置页离开 App，18 → 16。
  // ω99-258 随源演进：/edit 门并入 armFromTurn（−1）且 解除岔开失败 新面（+2），16 → 17。
  // 0.3.79 发版门随源演进：回收站弧加 删除/恢复 两面（516daab9）+ 断点续跑弧加
  // 重试/继续 两面（bd62760c），17 → 21（四弧合落于 0.3.78 剪版之后，钉在此补齐）。
  // 0.3.91 发版门随源演进：batch 3 弧（ω99-313..323 窗口）App catch 面 +1，
  // 21 → 22——0.3.89/0.3.90 两版聚焦发版未跑 gate，钉债本次首逮补齐。
  // 0.4.1 gate 随源演进：多 driver 并发用户令断点续跑/重试横幅退役收口——
  // fireContinue 的 重试失败/继续失败 两 catch 面随死件清理迁出（−2），
  // 且实测基线校正 −1（d4512c35 计数快修落在多driver/退役窗口中途，24 钉
  // 在未定源上；本收口逐面清点=21）。24 → 21。
  it("② `失败：${e instanceof Error` 全 App 计数=21（202 八面 + 200 #3 旧面 + 204 warn 族八面 − ω99-234 迁出两面 − ω99-258 /edit 门并缝 +2 + ω99-279 删除/恢复 + batch3 面 − 0.4.1 断点续跑退役迁出两面与基线校正）", () => {
    expect(countOf(appSrc, "失败：${e instanceof Error")).toBe(21); // 多driver+断点续跑退役随迁（fireContinue 两面清理+基线校正）
  });
});

describe("ω99-202 — B 反向：App 旧英文尾归零 + dist 反查", () => {
  it("③ App.tsx 插值定形归零：` failed: ${ 反引号形=0（防无词裸尾回归）+ 裸 ` failed: ${ 形=0（九面喂插值的固定尾）", () => {
    expect(countOf(appSrc, "` failed: ${")).toBe(0);
    expect(countOf(appSrc, " failed: ${")).toBe(0);
  });

  it("④ App.tsx plain ` failed: `=0（九面零残留）", () => {
    expect(countOf(appSrc, " failed: ")).toBe(0);
  });

  it("⑤ web dist bundle ` failed: ` 计数=改造前基线 10 − 9 = 1（唯一存活=attachments read failed 别域面）", () => {
    expect(distFailedTails()).toBe(1);
  });
});
