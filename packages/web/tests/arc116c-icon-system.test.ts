// @vitest-environment jsdom
// 116 弧 C「图标体系统一」的收据套件——去廉价化第三弧（116 报告 §3.d /
// 廉价感来源 #4：emoji 彩色位图与细线 SVG 同屏混排）。家族线承 ω99-299
// （chrome=SVG、content=文字）：299 弧换掉了按钮上的 🗑/✎/▸▾ 并把
// 「⚠️/▣/⏳ 等文字流内字形」显式留给后续弧——本弧接的正是这批遗留位。
// 五面钉：
//   ① UI chrome 零 emoji——全 src（pet 子树除外）comment-stripped 扫描，
//      白名单外零命中。白名单三区（逐条有因）：
//      a. 消息协议串——notify()/warnText/notice 构造器里的「⚠️ /⏳」前缀
//         是 toast/通知的变体路由约定（SettingsPage 的 data-variant 按
//         startsWith("⚠️") 分流）+ ω99 收据协议（85 处逐字断言）冻结；
//         弧红线「信息结构零改动」——消息是数据不是 chrome 图形位；
//      b. OS 通知 / document.title 串（RecoveryBanner ⏸ 标题、app-panels
//         FINISH_TITLE ✅）——系统通知是纯文本面，SVG 无法触达；
//      c. src/pet/** 整域——宠物旁白是 148 弧的产品个性面（弧任务令明示）；
//         md-lex 的 ✅ 是文档注释里的「模型输出样例」例文（naive stripper
//         在该文件 44 行的正则字面量反引号处失同步——人工核verified注释）。
//   ② vendored 图标集（src/assets/icons/，lucide-static v1.48.0 ISC）全部
//      stroke-width 1.5 + currentColor、零 width/height/class、零 script/
//      style/外链——WKWebView 纯内联零新语法（弧红线）；
//   ③ Icon 组件渲染契约——单 <svg>（无嵌套：@license 注释的 ">" 解析坑由
//      omega99-224 字节快照抓过，此处钉死）、.ic 基线类、aria-hidden、
//      1.5 描边、0.9 光学缩放、filled 实心态；
//   ④ 抽样点位渲染——工具行（SimpleActivityCard 文件图标）+ 侧栏
//      （SessionSidebar ⏰ 标记）+ 排队/注入 chip + 权限卡条带；
//   ⑤ CSS 面钉——.ic 基线律 / .ic-warn/.ic-danger 语义着位（全 var() 令牌，
//      禁裸 hex）/.act-file-icon 中性 text-2；白名单区非空钉（防白名单
//      空转——消息协议串与 OS 通知串仍在，是「 exempted」不是「已消亡」）。
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readStyles } from "./styles-source.js";
import { Icon } from "../src/components/Icon.js";
import { SimpleActivityCard, fileIconOf } from "../src/components/SimpleActivityCard.js";
import { SessionSidebar } from "../src/components/SessionSidebar.js";
import { SimpleComposer } from "../src/components/SimpleComposer.js";
import { PermissionModal } from "../src/components/PermissionModal.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
const mount = (el: React.ReactElement): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(el);
  });
  return container;
};

// ---------------------------------------------------------------------------
// ① —— UI chrome 零 emoji（comment-stripped 扫描 + 白名单）
// ---------------------------------------------------------------------------
// 「emoji class」= 彩色位图/emoji-presentation 字形（弧的改造对象）。纯排版
// 字符（→ ↑ ↓ ▸ ◂ ✓ ✕ ◐ …）是文字不是位图图标，不在此门（116 报告把箭头
// 字符列为同类问题，留给后续弧）。
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{FE0F}\u{23F0}\u{23F3}\u{23F8}\u{23F9}\u{23FA}\u{23CE}\u{26A0}\u{2699}\u{26A1}\u{26D4}\u{2630}\u{2605}\u{2606}\u{2705}\u{2753}\u{2757}\u{2714}\u{2716}\u{2764}\u{270E}\u{270F}\u{25A3}]/u;

// 剥注释的状态机（字符串/模板字面量外的 // 与 /* */ 视为注释并丢内容、保
// 换行）。已知局限：正则字面量不识别——含反引号的正则会让模式失同步
// （md-lex.ts:44 一例，其失同步产物按注释白名单豁免，人工核过）。
function stripComments(src: string): string {
  const out: string[] = [];
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? "";
    const c2 = src[i + 1] ?? "";
    if (mode === "code") {
      if (c === "/" && c2 === "/") { mode = "line"; i++; continue; }
      if (c === "/" && c2 === "*") { mode = "block"; i++; continue; }
      if (c === "'") mode = "sq";
      else if (c === '"') mode = "dq";
      else if (c === "`") mode = "tpl";
      out.push(c);
    } else if (mode === "line") {
      if (c === "\n") { mode = "code"; out.push(c); }
    } else if (mode === "block") {
      if (c === "*" && c2 === "/") { mode = "code"; i++; continue; }
      if (c === "\n") out.push(c); // 保行号对齐
    } else if (mode === "sq" || mode === "dq") {
      const q = mode === "sq" ? "'" : '"';
      if (c === "\\") { out.push(c); if (i + 1 < src.length) out.push(src[i + 1] ?? ""); i++; continue; }
      if (c === q || c === "\n") mode = "code";
      out.push(c);
    } else if (mode === "tpl") {
      if (c === "\\") { out.push(c); if (i + 1 < src.length) out.push(src[i + 1] ?? ""); i++; continue; }
      if (c === "`") mode = "code";
      out.push(c);
    }
  }
  return out.join("");
}

/** 白名单：file（相对 src/，POSIX 分隔）→ 允许的字形集合 + 因由。 */
const WHITELIST: Readonly<Record<string, { readonly glyphs: readonly string[]; readonly why: string }>> = {
  "components/App.tsx": { glyphs: ["\u26a0"], why: "notify() 消息协议串（toast 变体路由 + ω99 逐字收据冻结）" },
  "components/ProviderDetail.tsx": { glyphs: ["\u26a0"], why: "notify() 消息串" },
  "components/PersonaPanel.tsx": { glyphs: ["\u26a0"], why: "notify() 消息串" },
  "components/PreferencesTab.tsx": { glyphs: ["\u26a0"], why: "notify() 消息串" },
  "components/SimpleMode.tsx": { glyphs: ["\u26a0"], why: "notify() 消息串" },
  "components/PluginTab.tsx": { glyphs: ["\u26a0"], why: "notify() + warnText 消息构造器" },
  "components/ProviderTab.tsx": { glyphs: ["\u26a0"], why: "notify() 消息串" },
  "components/AppearanceTab.tsx": { glyphs: ["\u26a0"], why: "notify() 消息串" },
  "components/ModelConfigModal.tsx": { glyphs: ["\u26a0"], why: "notify() 消息串" },
  "components/NewProviderDetail.tsx": { glyphs: ["\u26a0"], why: "notify() 消息串" },
  "components/Wizard.tsx": { glyphs: ["\u26a0"], why: "notify() 消息串" },
  "components/BranchPanel.tsx": { glyphs: ["\u26a0"], why: "switchNote 消息数据（渲染为面板 note 文本）" },
  "components/MemoryReviewCard.tsx": { glyphs: ["\u26a0"], why: "setNote 消息数据" },
  "components/PermissionsTab.tsx": { glyphs: ["\u26a0"], why: "notify() 消息串" },
  "notice-variant.ts": { glyphs: ["\u26a0", "\u2705"], why: "P2 §6.4 变体识别器——正则匹配线格式前缀（渲染面剥离，永不上屏）；SettingsPage 的 startsWith 侦测随 P2 收编至此" },
  "attachments.ts": { glyphs: ["\u26a0"], why: "附件 notice 消息构造器" },
  "pet-drop.ts": { glyphs: ["\u26a0"], why: "宠物投递 notice 消息构造器" },
  "detach-op.ts": { glyphs: ["\u23f3"], why: "notify() 消息串（不可转后台回执）" },
  "components/RecoveryBanner.tsx": { glyphs: ["\u23f8"], why: "OS 系统通知标题（纯文本面，SVG 不可达；R2 逐字单测冻结）" },
  "components/app-panels.tsx": { glyphs: ["\u2705"], why: "FINISH_TITLE——OS 通知 + document.title（纯文本面）" },
  "md-lex.ts": { glyphs: ["\u2705"], why: "文档注释里的模型输出例文（stripper 在 :44 正则反引号失同步；人工核=注释）" },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "pet" || e === "assets") continue; // pet=个性面整域；assets=SVG 无 TS
      walk(p, out);
    } else if (/\.(ts|tsx|css)$/.test(e)) out.push(p);
  }
  return out;
}

const SRC = join(process.cwd(), "src");

describe("116 弧 C ① — UI chrome 零 emoji（白名单外零命中）", () => {
  it("comment-stripped 全 src 扫描：每个 emoji 命中都在白名单（file+字形）内", () => {
    const offenders: string[] = [];
    let whitelisted = 0;
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f).split("\\").join("/");
      const raw = readFileSync(f, "utf8");
      const text = rel.endsWith(".css")
        ? raw.split("\n").filter((l) => /content\s*:/.test(l)).join("\n") // CSS 只看 content:（渲染面）
        : stripComments(raw);
      const hits = new Set((text.replace(/\uFE0F/g, "")).match(new RegExp(EMOJI_RE.source, "gu")) ?? []);
      const allow = WHITELIST[rel];
      if (allow === undefined) {
        for (const h of hits) offenders.push(`${rel}: ${h} (无白名单条目)`);
      } else {
        for (const h of hits) {
          if (!allow.glyphs.includes(h)) offenders.push(`${rel}: ${h} (白名单只允许 ${allow.glyphs.join(" ")})`);
          else whitelisted++;
        }
      }
    }
    expect(offenders, `chrome emoji 残留：\n${offenders.join("\n")}`).toEqual([]);
    // 白名单在役：至少一个文件实际消费它（防白名单空转成僵尸条目）。
    expect(whitelisted).toBeGreaterThan(0);
  });

  it("pet 子树（148 弧个性面）与消息协议串仍在——白名单是豁免不是消亡", () => {
    // pet 域整域豁免的结构钉：门①的扫描集不含 pet 路径，且 pet 域非空
    // （个性面存在——emoji 若回流进 pet 是产品个性决策，不在本门管辖）。
    const scanned = walk(SRC).map((f) => relative(SRC, f));
    // 首段是 pet 的路径零入册（pet-drop.ts 是 src 根的文件，属主窗口域，照扫）。
    expect(scanned.filter((r) => r.split("/")[0] === "pet")).toEqual([]);
    expect(readdirSync(join(SRC, "pet")).length).toBeGreaterThan(0);
    // 消息协议约定仍在役：P2 §6.4 变体识别器读「⚠️/✅」前缀（SettingsPage
    // 的旧 startsWith 侦测收编进 notice-variant.ts 的 classifyNotice）。
    expect(readFileSync(join(SRC, "notice-variant.ts"), "utf8")).toContain('["warn", /^⚠️?\\s*/u]');
    expect(readFileSync(join(SRC, "notice-variant.ts"), "utf8")).toContain('["ok", /^✅\\s*/u]');
    // OS 通知标题串仍在役。
    expect(readFileSync(join(SRC, "components/app-panels.tsx"), "utf8")).toContain('FINISH_TITLE = "\u2705');
  });
});

// ---------------------------------------------------------------------------
// ② —— vendored 图标集（stroke 1.5 + currentColor + WKWebView 纯净性）
// ---------------------------------------------------------------------------
const ICONS_DIR = join(SRC, "assets", "icons");

describe("116 弧 C ② — vendored 集（lucide-static v1.48.0, ISC）归一律", () => {
  const files = readdirSync(ICONS_DIR).filter((f) => f.endsWith(".svg")).sort();

  it("集非空（19 字形）且 @license 行保留（溯源）", () => {
    expect(files.length).toBe(19);
    for (const f of files) {
      expect(readFileSync(join(ICONS_DIR, f), "utf8")).toContain("@license lucide-static");
    }
  });

  it("每个字形：stroke-width=1.5 + currentColor、零 width/height/class、零 script/style/外链", () => {
    for (const f of files) {
      const svg = readFileSync(join(ICONS_DIR, f), "utf8");
      expect(svg, f).toContain('stroke-width="1.5"');
      expect(svg, f).toContain('stroke="currentColor"');
      // 只查外层 <svg …> 开标签（clipboard-list 等内层 <rect width="8"> 是图形数据）。
      const open = svg.slice(svg.indexOf("<svg"), svg.indexOf(">", svg.indexOf("<svg")));
      expect(open, f).not.toMatch(/\swidth=/); // 尺寸是 Icon.tsx 的领地
      expect(open, f).not.toMatch(/\sheight=/);
      expect(open, f).not.toMatch(/class=/);
      // WKWebView 红线：纯静态标记，零可执行/外链/新语法。
      expect(svg, f).not.toMatch(/<script|<style|<foreignObject|xlink|href=/i);
    }
  });

  it("Icon.tsx 注册表与集内文件一一对应（无孤儿字形、无缺文件）", () => {
    const iconSrc = readFileSync(join(SRC, "components/Icon.tsx"), "utf8");
    for (const f of files) {
      expect(iconSrc, `Icon.tsx 缺 ${f} 的导入`).toContain(`icons/${f}?raw`);
    }
    const importCount = [...iconSrc.matchAll(/from "\.\.\/assets\/icons\/(.*?)\.svg\?raw"/g)].length;
    expect(importCount).toBe(files.length);
  });
});

// ---------------------------------------------------------------------------
// ③ —— Icon 组件渲染契约
// ---------------------------------------------------------------------------
describe("116 弧 C ③ — Icon 组件契约", () => {
  it("单 <svg> 无嵌套（@license 注释解析坑的回归钉）、.ic 类、aria-hidden、1.5 描边、currentColor", () => {
    const c = mount(createElement(Icon, { name: "hourglass", size: 13 }));
    const svgs = c.querySelectorAll("svg");
    expect(svgs.length).toBe(1); // 曾渲染出嵌套双 svg（注释 ">" 误当开标签尾）
    const svg = svgs[0] as SVGSVGElement;
    expect(svg.getAttribute("class")).toBe("ic");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("stroke-width")).toBe("1.5");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    // 0.9 光学缩放与 icons.tsx 自绘集同律（13 × 0.9 = 11.7；二进制浮点尾
    // 数不强求字符串形）。
    expect(Number.parseFloat(svg.getAttribute("width") ?? "")).toBeCloseTo(11.7, 6);
    expect(Number.parseFloat(svg.getAttribute("height") ?? "")).toBeCloseTo(11.7, 6);
    expect(svg.querySelector("path")).not.toBeNull();
  });

  it("className 合并保留 .ic 前缀（语义着位如 ic-danger 叠加）；filled 实心态", () => {
    const c = mount(createElement(Icon, { name: "trash-2", size: 14, className: "ic-danger" }));
    expect((c.querySelector("svg") as SVGSVGElement).getAttribute("class")).toBe("ic ic-danger");
    const f = mount(createElement(Icon, { name: "star", size: 13, filled: true }));
    expect((f.querySelector("svg") as SVGSVGElement).getAttribute("fill")).toBe("currentColor");
    const h = mount(createElement(Icon, { name: "star", size: 13 }));
    expect((h.querySelector("svg") as SVGSVGElement).getAttribute("fill")).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// ④ —— 抽样点位渲染（工具行 / 侧栏 / chip / 权限卡）
// ---------------------------------------------------------------------------
describe("116 弧 C ④ — 抽样点位", () => {
  it("工具行：SimpleActivityCard 交付物文件图标 = 细线 svg（xlsx→chart-column 派生）", () => {
    expect(fileIconOf("报表.xlsx")).toBe("chart-column");
    const c = mount(
      createElement(SimpleActivityCard, {
        entry: { kind: "tool", name: "make_xlsx", summary: "", resultPreview: "x", file: { path: "/w/报表.xlsx", name: "报表.xlsx", bytes: 1536 } },
      }),
    );
    const icon = c.querySelector(".act .act-file-card .act-file-icon") as HTMLElement;
    expect(icon.querySelector("svg")).not.toBeNull();
    expect(icon.textContent).not.toMatch(EMOJI_RE); // 📊 位图退役
  });

  it("侧栏：SessionSidebar 定时标记 = clock svg（tooltip 语义保留）", async () => {
    const rows = [{ id: "s1", mtime: new Date().toISOString(), messages: 1, firstUser: "", model: "m", name: "绑定行" }];
    const c = mount(
      createElement(SessionSidebar, {
        client: { sessions: () => Promise.resolve(rows), schedulesList: () => Promise.resolve([{ kind: "task" as const, id: "a8", prompt: "p", trigger: "每周一 09:00", nextRunAt: Date.now(), enabled: true, paused: false, sessionId: "s1" }]) },
        activeSessionId: null,
        onResume: () => {},
        onNewChat: () => {},
        onOpenSearch: () => {},
      }),
    );
    await act(async () => { await Promise.resolve(); });
    const marker = c.querySelector(".sb-sched") as HTMLElement;
    expect(marker).not.toBeNull();
    expect(marker.getAttribute("title")).toBe("这个会话有定时任务或提醒");
    expect(marker.querySelector("svg")).not.toBeNull();
  });

  it("composer：排队/注入 chip 的 hourglass/zap 字形（busy 态）", () => {
    const c = mount(
      createElement(SimpleComposer, {
        busy: true,
        mode: "workspace",
        commands: [],
        connected: true,
        ctx: { used: 400, window: 1000, nearLimit: false },
        lane: "queue",
        onLane: () => {},
        parked: ["排队的消息"],
        onDropParked: () => {},
        onSubmit: () => {},
        onInterrupt: () => {},
        onCycleMode: () => {},
        onShield: () => {},
        onDraftApplied: () => {},
      }),
    );
    const chips = c.querySelectorAll(".lane-toggle .chip");
    expect(chips.length).toBe(2);
    expect((chips[0] as HTMLElement).querySelector("svg")).not.toBeNull(); // ⏳ → hourglass
    expect((chips[1] as HTMLElement).querySelector("svg")).not.toBeNull(); // ⚡ → zap
    expect((c.querySelector(".parked-chip") as HTMLElement).querySelector("svg")).not.toBeNull();
    expect(c.textContent).not.toMatch(EMOJI_RE);
  });

  it("权限卡：条带 hourglass + 标题 key 字形（warn 色随容器类继承）", () => {
    const c = mount(
      createElement(PermissionModal, {
        ask: { toolName: "write_file", summary: "s", input: {} },
        onChoose: () => {},
      }),
    );
    const strip = c.querySelector(".permission-card .strip") as HTMLElement;
    expect(strip.querySelector("svg")).not.toBeNull();
    expect(strip.textContent).toContain("等待你的批准");
    expect((c.querySelector(".permission-card h3") as HTMLElement).querySelector("svg")).not.toBeNull();
    expect(c.textContent).not.toMatch(EMOJI_RE);
  });
});

// ---------------------------------------------------------------------------
// ⑤ —— CSS 面钉（令牌着色红线 + 基线律）
// ---------------------------------------------------------------------------
describe("116 弧 C ⑤ — CSS 面钉", () => {
  it(".ic 基线律在册（inline-block + 光学居中 + flex:none）", () => {
    const css = readStyles();
    const m = css.match(/\.ic\s*\{([^}]*)\}/);
    expect(m, ".ic rule present").not.toBeNull();
    expect(m?.[1]).toMatch(/display:\s*inline-block/);
    expect(m?.[1]).toMatch(/vertical-align:\s*-0\.14em/);
    expect(m?.[1]).toMatch(/flex:\s*none/);
  });

  it("语义着位全走令牌（.ic-warn/.ic-danger = var(--warn)/var(--danger)，零裸 hex）", () => {
    const css = readStyles();
    expect(css).toMatch(/\.ic-warn\s*\{[^}]*color:\s*var\(--warn\)/);
    expect(css).toMatch(/\.ic-danger\s*\{[^}]*color:\s*var\(--danger\)/);
    const arcBlock = css.slice(css.indexOf(".ic {"));
    expect(arcBlock.slice(0, 400)).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("中性图标 text-2（.act-file-icon 换字形后的色令）", () => {
    const css = readStyles();
    expect(css).toMatch(/\.act-file-icon\s*\{[^}]*color:\s*var\(--text-2\)/);
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});
