// @vitest-environment jsdom
// ω99-203: #2 — receipts：常用吩咐行整族退役（用户令 09-08：去掉常用
// 吩咐——行占输入框高度、无人用、输入框应干净；整族退役非隐藏）。六钉：
// ①构造性（空 buffer 挂载 .ask-row DOM 不在场）；②源钉（InputBox.tsx
// 串族归零）；③盘钉（A 层模块 + 两旧测试文件不在盘）；④残 lane 不炸
// （预置 wudao.ui.frequentAsks 旧数据挂载 → 无行无异常——无人读即无害，
// 不写清理代码）；⑤邻特征误伤门（intent-row JSX 仍在）；⑥CSS 源钉
// （styles.css 无 ask-row 规则、.file-rail 共享规则仍在）+ bundle 门
// （web dist 无「常用吩咐」无 ask-row——构建后反查，202 receipts 同法）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStyles } from "./styles-source.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { InputBox } from "../src/components/InputBox.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 环境下 import.meta.url 非 file: 协议（178 注释亲证）——fs 锚走
// process.cwd()（components.test.tsx:1002 同款；vitest 每包运行 cwd=包根）。
const PKG = process.cwd();
const srcOf = (rel: string): string => readFileSync(join(PKG, rel), "utf8");
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const inputSrc = srcOf("src/components/InputBox.tsx");
const cssSrc = readStyles();

/** dist bundle 反查：assets 逐 .js 文件字节级计数（web build 后）。 */
const distCount = (needle: string): number => {
  const dir = join(PKG, "dist/assets");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .reduce((n, f) => n + countOf(readFileSync(join(dir, f), "utf8"), needle), 0);
};

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
  localStorage.clear();
});

const BASE = {
  busy: false,
  mode: "workspace" as const,
  commands: [],
  connected: true,
  onSubmit: vi.fn().mockResolvedValue(true),
  onInterrupt: vi.fn(),
  onShield: vi.fn(),
  onCycleMode: vi.fn(),
};

describe("ω99-203 — 常用吩咐行整族退役 receipts", () => {
  it("① 空 buffer 挂载：.ask-row 不在 DOM（常驻行删净——整族退役非隐藏，0 颗也不再有「＋」pill）", () => {
    const c = mount(<InputBox {...BASE} />);
    expect(c.querySelector(".ask-row")).toBeNull();
    expect(c.querySelector(".ask-add")).toBeNull();
    expect(c.querySelector("textarea.wudao-input")).not.toBeNull(); // 主输入面健在
  });

  it("② 源钉：InputBox.tsx 的 frequent-asks / ask-row / ask-add 串=0", () => {
    expect(countOf(inputSrc, "frequent-asks")).toBe(0);
    expect(countOf(inputSrc, "ask-row")).toBe(0);
    expect(countOf(inputSrc, "ask-add")).toBe(0);
  });

  it("③ 盘钉：A 层模块 src/frequent-asks.ts 与两旧测试文件（omega99-120-frequent-asks / omega99-120-ask-row）均不在盘", () => {
    expect(existsSync(join(PKG, "src/frequent-asks.ts"))).toBe(false);
    expect(existsSync(join(PKG, "tests/omega99-120-frequent-asks.test.ts"))).toBe(false);
    expect(existsSync(join(PKG, "tests/omega99-120-ask-row.test.tsx"))).toBe(false);
  });

  it("④ 残 lane 不炸：预置 wudao.ui.frequentAsks 旧数据挂载 → 无 .ask-row、无异常（无人读即无害，不写清理代码）", () => {
    localStorage.setItem(
      "wudao.ui.frequentAsks",
      JSON.stringify([{ label: "整理桌面", text: "整理下载文件夹里的东西" }]),
    );
    const c = mount(<InputBox {...BASE} />);
    expect(c.querySelector(".ask-row")).toBeNull();
    expect(c.querySelector("textarea.wudao-input")).not.toBeNull();
  });

  it("⑤ 邻特征误伤门：intent-row JSX 仍在 InputBox.tsx（.file-rail 行族 119 intent 行在用）", () => {
    expect(inputSrc).toContain('className="file-rail intent-row"');
  });

  it("⑥ CSS 源钉 + bundle 门：styles.css 无 ask-row 规则、.composer .file-rail 共享规则仍在；web dist 无「常用吩咐」无 ask-row", () => {
    expect(countOf(cssSrc, "ask-row")).toBe(0);
    expect(cssSrc).toContain(".composer .file-rail {");
    expect(distCount("常用吩咐")).toBe(0);
    expect(distCount("ask-row")).toBe(0);
  });
});
