// ω99-209: #R — buddy 会话列表行压缩裁字 receipts（用户 0.3.56 验装回执：
// 「窗口很小，历史会话不同的行展示不完全……历史记录很多行的字体上下都看
// 不见了」）。根因：`.sb-i` 是 flex column 滚动容器 `.sb-list` 的子项，
// overflow≠visible 使 flex 项 automatic minimum size 归零（CSS 规范
// min-height:auto 只给 overflow:visible 项）→ 矮窗下行被压缩到文字线高以
// 下 → 字形上下被裁（行内裁，滚动找不回）。修法两规则加禁缩声明，行恒
// 32px/自然高，超出走 `.sb-list` 既有 overflow-y:auto（201 常显滚动条恰成
// 通路）。① 形钉：两规则体禁缩在场；② 滚动通路钉：sb-list 滚动容器零触
// （overflow-y:auto + min-height:0）+ 201 滚动条面不回归；③ jsdom 结构非
// 回归：容器 + ≥3 行 + 组头在场；④ 计数稳定：32px 行高（178 面）不回归。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStyles } from "./styles-source.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionSidebar } from "../src/components/SessionSidebar.js";
import type { SessionRow } from "../src/protocol.js";

// readFileSync 直读（201 receipts 同款形）：⚠️ URL 首参必须是变量——字面量
// 形的 `new URL("*.css", import.meta.url)`（顶层/函数体皆然）会被 vite 测试
// 管线静态改写成非 file: 资产 URL（fileURLToPath 即抛 "must be of scheme
// file"；本弧探针亲核，201 的 rel 变量形即为此免疫——178 的 ?raw 注释说的
// 是同一现象）。
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = readStyles;
// 首 Match 读规则体（与 178 receipts 的 ruleBody 同锚——文件内首处
// `.sb-i {`/`.sb-g {`/`.sb-list {`，不受后置 .buddy 前缀规则扰动）。
const ruleBody = (sel: string): string => {
  const m = css().match(new RegExp(`\\.${sel.replace(/[-]/g, "\\-")}\\s*\\{([^}]*)\\}`));
  expect(m, `.${sel} rule present in styles.css`).not.toBeNull();
  return m?.[1] ?? "";
};

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
const sessionsClient = (rows: readonly SessionRow[]): { sessions: ReturnType<typeof vi.fn> } => ({
  sessions: vi.fn(() => Promise.resolve(rows)),
});
const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 2,
  firstUser: "",
  model: "deepseek-v4-flash",
  ...over,
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

describe("ω99-209 — A 行禁缩形钉（主面，改前红）", () => {
  it("① .sb-i 与 .sb-g 规则体各含禁缩声明（矮窗行压缩 → 字形上下被裁的修复面）", () => {
    expect(ruleBody("sb-i")).toMatch(/flex-shrink:\s*0/);
    expect(ruleBody("sb-g")).toMatch(/flex-shrink:\s*0/);
  });
});

describe("ω99-209 — B 滚动通路与既有面不回归（改前绿=防回归面）", () => {
  it("② .sb-list 滚动容器零触（overflow-y:auto + min-height:0 仍在）；201 常显滚动条在场", () => {
    const b = ruleBody("sb-list");
    expect(b).toMatch(/overflow-y:\s*auto/);
    expect(b).toMatch(/min-height:\s*0/);
    expect(css()).toContain(".buddy .sb-list::-webkit-scrollbar");
  });

  it("④ .sb-i 规则内 32px 行高仍在（178 密度面不回归）", () => {
    expect(ruleBody("sb-i")).toMatch(/height:\s*32px/);
  });
});

describe("ω99-209 — C jsdom 结构非回归（改前绿=防回归面）", () => {
  it("③ SessionSidebar 渲染：.sb-list 容器 + ≥3 .sb-i 行 + .sb-g 组头在场", async () => {
    const rows = [
      row({ id: "a-id-0000000001", name: "一行", mtime: new Date(Date.now() - 60_000).toISOString() }),
      row({ id: "b-id-0000000002", name: "二行", mtime: new Date(Date.now() - 120_000).toISOString() }),
      row({ id: "c-id-0000000003", name: "三行", mtime: new Date(Date.now() - 180_000).toISOString() }),
      row({ id: "d-id-0000000004", name: "四行", mtime: new Date(Date.now() - 240_000).toISOString() }),
    ];
    const c = mount(
      <SessionSidebar
        client={sessionsClient(rows)}
        activeSessionId={null}
        onResume={() => {}}
        onNewChat={() => {}}
        onOpenSettings={() => {}}
        onOpenSearch={() => {}}
      />,
    );
    await act(async () => {});
    expect(c.querySelector(".sb-list")).not.toBeNull();
    expect(c.querySelectorAll(".sb-i").length).toBeGreaterThanOrEqual(3);
    expect(c.querySelector(".sb-g")).not.toBeNull();
  });
});
