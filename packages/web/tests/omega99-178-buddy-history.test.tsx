// ω99-277: #15 — SessionPicker 增 onSearch prop（全文搜索车道）；本件的单元挂载以空命中 stub（这些套件钉的是列表车道）。
// ω99-178 — buddy 历史会话展示优化 receipts。A 弹框可读性（可读标题三梯/
// 日期分组头/悬停 title 兜完整首行/分组头不带行类/时间列在 row1）；
// B CSS receipts（行去 mono、行距、高度自适应、窄窗藏预览、侧栏行密度、
// 基础 .search-results 320px 回归钉）；C 窄窗行为（440px 媒体块只辖
// picker 预览行，不漏进 FileSearch 的行/命中面——jsdom 不级联媒体查询，
// 文本钉代偿，brief §五C 授权）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionPicker } from "../src/components/App.js";
import type { SessionRow } from "../src/protocol.js";
import { stylesCss } from "./styles-source.js";

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
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

const MIN = 60_000;
const row = (over: Partial<SessionRow>): SessionRow => ({
  id: "deadbeef-0000-0000-0000-000000000000",
  mtime: new Date().toISOString(),
  messages: 1,
  firstUser: "",
  model: "",
  ...over,
});

describe("ω99-178 A — 弹框可读性", () => {
  it("命名会话行显 name（主行不再是 id8 hex）；悬停 title 同 name", () => {
    const c = mount(<SessionPicker rows={[row({ name: "季度汇报整理" })]} onPick={vi.fn()} onClose={vi.fn()} onSearch={vi.fn(async () => [])} />);
    const item = c.querySelector<HTMLElement>(".session-item");
    expect(item?.querySelector(".session-title")?.textContent).toBe("季度汇报整理");
    expect(item?.getAttribute("title")).toBe("季度汇报整理");
  });

  it("未命名显 firstUser 首行 16 字梯；悬停 title = 完整首行（截 16 之外可读回）", () => {
    const line = "把这份散落的会议纪要整理成一页可以执行的行动清单吧";
    const c = mount(<SessionPicker rows={[row({ firstUser: `${line}\n第二行不该进标题` })]} onPick={vi.fn()} onClose={vi.fn()} onSearch={vi.fn(async () => [])} />);
    const item = c.querySelector<HTMLElement>(".session-item");
    expect(item?.querySelector(".session-title")?.textContent).toBe(`${line.slice(0, 16)}…`);
    expect(item?.getAttribute("title")).toBe(line);
  });

  it("空会话兜底 id8（name/firstUser 双空——id8 唯一残留位）", () => {
    const c = mount(<SessionPicker rows={[row({ id: "cafe1234-0000-0000-0000-000000000000" })]} onPick={vi.fn()} onClose={vi.fn()} onSearch={vi.fn(async () => [])} />);
    const item = c.querySelector<HTMLElement>(".session-item");
    expect(item?.querySelector(".session-title")?.textContent).toBe("cafe1234");
    expect(item?.getAttribute("title")).toBe("cafe1234");
  });

  it("日期分组头按序 今天/昨天/7 天内/更早（线序 ASC，picker 自排倒序）；分组头不带行类", () => {
    const mk = (id: string, agoMs: number): SessionRow =>
      row({ id, firstUser: id, mtime: new Date(Date.now() - agoMs).toISOString() });
    const wire = [ // oldest-first, exactly the op's order
      mk("old01-0000", 30 * 24 * 60 * MIN),
      mk("week01-0000", 4 * 24 * 60 * MIN),
      mk("yday01-0000", 30 * 60 * MIN),
      mk("today01-0000", 5 * MIN),
    ];
    const c = mount(<SessionPicker rows={wire} onPick={vi.fn()} onClose={vi.fn()} onSearch={vi.fn(async () => [])} />);
    expect([...c.querySelectorAll(".session-pg")].map((h) => h.textContent)).toEqual(["今天", "昨天", "7 天内", "更早"]);
    // order 测试的 .session-item 计数不受扰：分组头既非 session-item 也非 search-item。
    for (const h of c.querySelectorAll(".session-pg")) {
      expect(h.classList.contains("session-item")).toBe(false);
      expect(h.classList.contains("search-item")).toBe(false);
      expect(h.getAttribute("role")).toBe("presentation");
    }
    expect(c.querySelectorAll(".session-item")).toHaveLength(4);
  });

  it("同桶相邻行只出一颗头；时间列在 row1（与标题同列），预览在 row1 外", () => {
    const mk = (id: string, agoMs: number): SessionRow =>
      row({ id, firstUser: id, mtime: new Date(Date.now() - agoMs).toISOString() });
    const c = mount(
      <SessionPicker
        rows={[mk("today02-0000", 40 * 24 * 60 * MIN), mk("today01-0000", 5 * MIN), mk("today03-0000", 9 * 60 * MIN)]}
        onPick={vi.fn()}
        onClose={vi.fn()}
        onSearch={vi.fn(async () => [])}
      />,
    );
    const heads = [...c.querySelectorAll(".session-pg")].map((h) => h.textContent);
    expect(heads).toEqual(["今天", "更早"]); // 两颗 今天 行折叠为一颗头
    const item = c.querySelector<HTMLElement>(".session-item");
    expect(item?.querySelector(".session-row1 .session-title")).not.toBeNull();
    expect(item?.querySelector(".session-row1 .session-time")).not.toBeNull();
    expect(item?.querySelector(".session-row1 .session-preview")).toBeNull();
    expect(item?.querySelector(".session-preview")).not.toBeNull();
  });
});

// —— B/C：CSS receipts（文本钉，镜像 inkline-global 的 css.match 形；
// jsdom 环境下 import.meta.url 非 file: 协议，走本包 jsdom 测试既有的 ?raw 形） ——
const css = stylesCss;
const ruleBody = (re: RegExp): string => {
  const m = css.match(re);
  // not.toBeNull 而非 toBeDefined：String.match 缺席返回 null（defined！）。
  expect(m, `rule /${re.source}/ present in styles.css`).not.toBeNull();
  return m?.[1] ?? "";
};

describe("ω99-178 B — CSS receipts", () => {
  it("picker 行去 mono（UI 字体）+ 行距（token 合成 2px）+ 四向同距 padding", () => {
    const b = ruleBody(/\.search-pop \.session-item\s*\{([^}]*)\}/);
    expect(b).toMatch(/font-family:\s*var\(--font\)/);
    // 行距 2px 走 calc(var(--sp-1) / 2)：tokens-conformance 间距门只放行
    // 4 倍数与 ≤1 的 px 字面量，裸 2px 字面量会被执法（brief 值的守门变形，
    // 渲染值同 2px——报告披露）。
    expect(b).toMatch(/margin:\s*0 var\(--sp-1\) calc\(var\(--sp-1\) \/ 2\)/);
    expect(b).toMatch(/padding:\s*var\(--sp-2\);/);
  });

  it("标题列单行省略（session-title 接替 session-id 位）；预览行同去 mono", () => {
    expect(ruleBody(/\.search-pop \.session-item \.session-title\s*\{([^}]*)\}/)).toMatch(
      /flex:\s*1;\s*min-width:\s*0;[^}]*text-overflow:\s*ellipsis/s,
    );
    const pv = ruleBody(/\.search-pop \.session-item \.session-preview\s*\{([^}]*)\}/);
    expect(pv).toMatch(/font-family:\s*var\(--font\)/);
    expect(pv).toMatch(/line-height:\s*1\.45/);
  });

  it("弹框高度自适应 min(420px, 60vh)；基础 .search-results 320px 零触（FileSearch 回归钉）", () => {
    expect(ruleBody(/\.search-pop \.session-results\s*\{([^}]*)\}/)).toMatch(/max-height:\s*min\(420px,\s*60vh\)/);
    expect(ruleBody(/\.search-pop \.search-results\s*\{([^}]*)\}/)).toMatch(/max-height:\s*320px/);
  });

  it("440px 窄窗藏预览行；分组头 .session-pg 在场", () => {
    const m = css.match(/@media \(max-width: 440px\)\s*\{([\s\S]*?)\n\}/);
    expect(m).toBeDefined();
    expect(m?.[1]).toMatch(/\.search-pop \.session-item \.session-preview\s*\{\s*display:\s*none/);
    expect(ruleBody(/\.search-pop \.session-pg\s*\{([^}]*)\}/)).toMatch(/font-size:\s*var\(--fs-caption\)/);
  });

  it("侧栏行密度松绑：32px 行高 + 2px 行距（token 合成）+ 组头强分隔", () => {
    expect(ruleBody(/\.sb-i\s*\{([^}]*)\}/)).toMatch(/height:\s*32px/);
    expect(ruleBody(/\.sb-list\s*\{([^}]*)\}/)).toMatch(/gap:\s*calc\(var\(--sp-1\) \/ 2\)/);
    expect(ruleBody(/\.sb-g\s*\{([^}]*)\}/)).toMatch(/padding:\s*var\(--sp-3\) var\(--sp-2\) var\(--sp-1\)/);
  });
});

describe("ω99-178 C — 窄窗行为（440px 媒体块的作用域）", () => {
  it("媒体块在场且只辖 picker 的预览行——FileSearch 的 .search-item/.hit 不进窄窗隐藏面", () => {
    const m = css.match(/@media \(max-width: 440px\)\s*\{([\s\S]*?)\n\}/);
    const body = m?.[1] ?? "";
    expect(body).toMatch(/\.search-pop \.session-item \.session-preview\s*\{\s*display:\s*none/);
    expect(body).not.toMatch(/\.hit/);
    // 裸 .search-item（FileSearch 行）不在媒体块里；picker 行走的是
    // .search-pop .session-item 作用域链。
    expect(body).not.toMatch(/\.search-item\s/);
  });

  it("宽窗（jsdom 缺省）渲染不藏预览——预览行总在 DOM，窄窗是纯 CSS 收敛", () => {
    const c = mount(<SessionPicker rows={[row({ firstUser: "窄窗也先渲染，收不收敛交给 CSS" })]} onPick={vi.fn()} onClose={vi.fn()} onSearch={vi.fn(async () => [])} />);
    const pv = c.querySelector<HTMLElement>(".session-item .session-preview");
    expect(pv?.textContent).toContain("窄窗也先渲染");
    expect(pv?.style.display).not.toBe("none"); // 无内联藏——隐藏只可能来自媒体查询
  });
});
