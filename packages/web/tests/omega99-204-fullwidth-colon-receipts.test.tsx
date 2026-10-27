// ω99-204: #R — warn 族半角冒号统一全角 receipts（43 面 / 8 文件；199/200/202
// 词表纪律直承）：仅冒号字形换 + 删半角尾空格；⚠️ 前缀/词面/`${…}` 插值/
// errText 形/r.error 形零触。① 正向源钉：≥10 独一词面全角在场（8 文件代表串）；
// ② 逐文件计数钉（App 含 202 基 10 面 → 21）；③ 反向：web src 半角 warn 族
// 递归归零（199/202 receipts 同款 readFileSync 法）；④ 残留清点：半角「存…」
// 串 src 命中恰 1 = CodeEditor doc 注释（唯一合法残留，多于 1 即红）；⑤ 钉持有
// 人随源吻合（plugin-tab passthrough fixture 半角 2 恒在——其源不在 web src）；
// ⑥ dist 反查：半角族 40+3=43 → 0（构建剥离注释，dist 无豁免面）。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
const testOf = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// ③/④ 的扫描域：web src 全部 .ts/.tsx 递归收齐（census 同域）。
const srcRoot: string = fileURLToPath(new URL("../src", import.meta.url));
const walkSrc = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? walkSrc(`${dir}/${d.name}`)
      : /\.(ts|tsx)$/.test(d.name)
        ? [`${dir}/${d.name}`]
        : [],
  );
const allSrc: string[] = walkSrc(srcRoot);

const HALF_FAIL = "失败:";
const HALF_UNSAVED = "未保存:";
const HALF_SAVE = "保存:";

// ⑥ dist bundle 反查（202 receipts 同法，逐 .js 字节级计数）。
const distHalfCount = (needle: string): number => {
  const dir = fileURLToPath(new URL("../dist/assets", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .reduce((n, f) => n + countOf(readFileSync(`${dir}/${f}`, "utf8"), needle), 0);
};

describe("ω99-204 — A 正向：43 面全角在场（源钉法）", () => {
  it("① 8 文件 ≥10 独一词面全角在场（token/插值形同锁：errText 形与 r.error 形各有代表；ω99-234 后 默认语言保存失败 面持有人 App → PreferencesTab）", () => {
    const app = srcOf("components/App.tsx");
    expect(app).toContain("`⚠️ 命名失败：${e instanceof Error");
    expect(app).toContain("`⚠️ 会话列表加载失败：${e instanceof Error");
    expect(app).toContain("`⚠️ 切换 agent 工作目录失败：${e instanceof Error");
    expect(app).toContain("`⚠️ 主题切换未保存：${e instanceof Error");
    // ω99-234 census 演进（同形）：语言 chip 迁设置页，该 catch 面随
    // setLanguageDefault 搬进 偏好 tab——词面与插值形原样，仅持有人文件换。
    const prefs = srcOf("components/PreferencesTab.tsx");
    expect(prefs).toContain("`⚠️ 默认语言保存失败：${e instanceof Error");
    const wiz = srcOf("components/Wizard.tsx");
    expect(wiz).toContain("`Key 保存失败：${errText(e)}`");
    expect(wiz).toContain("`向导标记写入失败：${errText(e)}`");
    const pd = srcOf("components/ProviderDetail.tsx");
    // 拆分运动 C 钉随迁：CREATE 半面（添加失败两面）外提至 NewProviderDetail.tsx。
    const npd = srcOf("components/NewProviderDetail.tsx");
    expect(npd).toContain("`⚠️ 添加失败：${r.error}`");
    expect(pd).toContain("`⚠️ 删除失败：${errText(e)}`");
    const persona = srcOf("components/PersonaPanel.tsx");
    expect(persona).toContain("`⚠️ 删除失败：仍被引用(");
    expect(persona).toContain("`⚠️ 读取失败：${errText(e)}`");
    expect(persona).toContain("`⚠️ 写入失败：${errText(e)}`");
    expect(srcOf("components/PermissionsTab.tsx")).toContain("`⚠️ 设置默认权限档失败：${errText(e)}`");
    expect(srcOf("components/AppearanceTab.tsx")).toContain("`⚠️ 主题未保存：${errText(e)}`");
    expect(srcOf("components/AppearanceTab.tsx")).toContain("`⚠️ 主色未保存：${errText(e)}`");
  });

  // ω99-258: #14 — /edit 门并入 armFromTurn 统一缝（−「/edit 失败：」+「岔开失败：」「解除岔开失败：」），App 19→20。
  // 0.3.79 发版门随源演进：ω99-279 回收站弧 删除/恢复 两面（516daab9）+ ω99-286/289
  // 断点续跑 重试/继续 两面（bd62760c），App 20→24（同 202② 的 +4）。
  // ω99-260: #14 — 管理记忆面的决定失败回执入 PreferencesTab（「记忆操作失败：」，全角同形）1→2。
  // 0.3.91 发版门随源演进：batch 3 弧（ω99-313..323 窗口）App 全角失败面 +1，
  // 24 → 25——0.3.89/0.3.90 聚焦发版未跑 gate，钉债本次首逮补齐。
  // 0.4.1 gate 随源演进：断点续跑/重试横幅退役收口——fireContinue 的
  // 重试失败/继续失败 两全角面随死件清理迁出（−2），26 → 24。
  // P2 巡检补齐（gate 随源演进惯例）：M-Memory 三弧合一（377dfa23）新增
  // 追问失败 / 打开会话列表失败 两全角面未随弧 bump 钉——24 → 26。
  it("② 逐文件计数钉：App=26（202 基 10+11 − ω99-234 迁出两面 + ω99-258 /edit 门并 armFromTurn 缝 −1+2 + ω99-279 删除/恢复 + batch3 面 − 0.4.1 断点续跑退役迁出两面 + 377dfa23 追问/会话列表两面）且未保存=1；PreferencesTab=2（ω99-234 迁入 + ω99-260 管理记忆决定回执）；Wizard=9；ProviderDetail=9；Persona=6；Modal=2；ProviderTab=2；未保存 Appearance=2；PermissionsTab=1", () => {
    expect(countOf(srcOf("components/App.tsx"), "失败：")).toBe(26); // 多driver+断点续跑退役随迁（fireContinue 两面清理）+ 377dfa23 两面
    expect(countOf(srcOf("components/App.tsx"), "未保存：")).toBe(1);
    expect(countOf(srcOf("components/PreferencesTab.tsx"), "失败：")).toBe(4); // wave2 改进提案小节 +2（同意失败/激活失败回执）
    expect(countOf(srcOf("components/Wizard.tsx"), "失败：")).toBe(9);
    expect(countOf(srcOf("components/ProviderDetail.tsx"), "失败：")).toBe(7); // 拆分运动 C：添加失败两面随 CREATE 半面迁 NewProviderDetail
    expect(countOf(srcOf("components/NewProviderDetail.tsx"), "失败：")).toBe(2);
    expect(countOf(srcOf("components/PersonaPanel.tsx"), "失败：")).toBe(6);
    expect(countOf(srcOf("components/ModelConfigModal.tsx"), "失败：")).toBe(2);
    expect(countOf(srcOf("components/ProviderTab.tsx"), "失败：")).toBe(2);
    expect(countOf(srcOf("components/AppearanceTab.tsx"), "未保存：")).toBe(2);
    expect(countOf(srcOf("components/PermissionsTab.tsx"), "失败：")).toBe(1);
  });
});

describe("ω99-204 — B 反向：半角族归零 + 残留清点 + 钉持有人 + dist", () => {
  it("③ web src 递归半角归零：X失败族=0、X未保存族=0", () => {
    const fail = allSrc.reduce((n, f) => n + countOf(readFileSync(f, "utf8"), HALF_FAIL), 0);
    const unsaved = allSrc.reduce((n, f) => n + countOf(readFileSync(f, "utf8"), HALF_UNSAVED), 0);
    expect(fail).toBe(0);
    expect(unsaved).toBe(0);
  });

  it("④ 残留清点：半角「存…」串 src 命中恰 1 = CodeEditor doc 注释（豁免钉）", () => {
    const saves = allSrc.reduce((n, f) => n + countOf(readFileSync(f, "utf8"), HALF_SAVE), 0);
    expect(saves).toBe(1);
    expect(srcOf("components/CodeEditor.tsx")).toContain("/** 覆盖保存: 以 base");
  });

  it("⑤ 钉持有人随源吻合：四件计数（plugin-tab passthrough 半角 2 恒在——§零.3）", () => {
    const pat = testOf("permissions-appearance-tabs.test.tsx");
    expect(countOf(pat, HALF_FAIL)).toBe(0);
    expect(countOf(pat, "失败：")).toBe(2);
    expect(countOf(pat, HALF_UNSAVED)).toBe(0);
    expect(countOf(pat, "未保存：")).toBe(1);
    const pd = testOf("provider-detail.test.tsx");
    expect(countOf(pd, HALF_FAIL)).toBe(0);
    expect(countOf(pd, "失败：")).toBe(1);
    const sp = testOf("settings-page.test.tsx");
    expect(countOf(sp, HALF_UNSAVED)).toBe(0);
    expect(countOf(sp, "未保存：")).toBe(1);
    const plugin = testOf("plugin-tab.test.tsx");
    expect(countOf(plugin, HALF_FAIL)).toBe(2);
    expect(countOf(plugin, "失败：")).toBe(0);
  });

  it("⑥ web dist 反查：半角族 40+3=43 → 0（构建剥离注释，dist 无豁免面）", () => {
    expect(distHalfCount(HALF_FAIL)).toBe(0);
    expect(distHalfCount(HALF_UNSAVED)).toBe(0);
  });
});
