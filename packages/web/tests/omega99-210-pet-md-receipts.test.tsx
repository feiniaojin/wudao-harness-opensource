// @vitest-environment jsdom
// ω99-210: #R — receipts 小精灵回答 markdown 渲染（用户 0.3.57 验装回执「小精灵
// 的回答是markdown的话，没有进行渲染，导致我看到很多** --这种符号」）：①单一
// 事实源（markdown.js 与 md-lex.js 两路 parseBlocks 同源样本深度相等——词法器
// 抽取的不变式钉）；②bold/inline code；③结构族（heading 无 # 带 data-level /
// list • 行 / quote | 行 / table thead+tbody / pre 纯 mono 无复制钮无高亮）；
// ④纯文本等值（无记号文本 textContent 与源逐字等值——纯文本零钉演进的构造性
// 证明）；⑤Bubble 两回答面（.pet-bubble-a/.pet-bubble-stream）换 PetMarkdown；
// ⑥窗界（pet-md.tsx 的 import 只有 md-lex/react——主窗 markdown.js 不进宠物
// 模块图）。先红后绿：①④改前即红（md-lex/pet-md 不存在→import 失败，如实
// 分类）；②③⑤⑥主红（渲染面缺）。harness 沿 201/208 的 act+createRoot 范式
// （仓库无 @testing-library）；⑥的 fs 锚用 process.cwd()（vitest 每包运行
// cwd=包根；203/178 两证）。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import type { ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Bubble } from "../src/pet/Bubble.js";
import type { BubbleProps } from "../src/pet/Bubble.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/tauri-invoke.js", () => ({
  tauriEmitEvent: vi.fn(async () => false),
  tauriInvokeCommand: vi.fn(async () => null),
}));

/** ⑥ 的 fs 锚（omega99-203 同款）：vitest 每包运行 cwd=包根。 */
const srcOf = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

/** 改前红相分类：Vite 对字面量动态 import 做静态分析——新模块不存在的改前
 *  相位会让整文件在 vite:import-analysis 阶段炸掉（拿不到逐 it 红）。变量
 *  路径把解析推迟到运行时：改前=it 内加载失败红（①④如实分类），改后正常。 */
const MODULES = {
  mdLex: "../src/md-lex.js",
  petMd: "../src/pet/pet-md.js",
} as const;

type PetMdComponent = ComponentType<{ source: string }>;
const loadPetMd = async (): Promise<PetMdComponent> =>
  (await import(MODULES.petMd) as { PetMarkdown: PetMdComponent }).PetMarkdown;

let container: HTMLElement;
let root: Root;
let props: BubbleProps;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    inputOpen: false,
    answerTail: "",
    waitingUser: false,
    onInputClose: vi.fn(),
    delivery: null,
    onDeliveryClose: vi.fn(),
    ask: null,
    selection: null,
    onSelectionClose: vi.fn(),
    busyNarration: null,
    workKind: null,
    transcript: [],
    onPetTurn: vi.fn(),
    livePending: false,
  };
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.innerHTML = "";
});

/** 动态 import + act 渲染（改前 pet-md 不存在 → it 红，如实分类）。 */
async function renderMd(source: string): Promise<void> {
  const PetMarkdown = await loadPetMd();
  act(() => {
    root.render(<PetMarkdown source={source} />);
  });
}

function renderBubble(): void {
  act(() => {
    root.render(<Bubble {...props} />);
  });
}

/** 六 block 全覆盖的同源样本（①深度相等样本）。 */
const MIXED = [
  "# 标题",
  "",
  "正文**加粗**与 `code` 与 [链接](https://example.com)",
  "",
  "- 甲",
  "- 乙",
  "",
  "> 引用行",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

describe("ω99-210 词法器单一事实源", () => {
  it("① markdown.js 与 md-lex.js 两路 parseBlocks 同源样本深度相等（抽取不变式）", async () => {
    const md = await import("../src/markdown.js");
    const lex = (await import(MODULES.mdLex)) as { parseBlocks: typeof md.parseBlocks };
    expect(md.parseBlocks(MIXED)).toEqual(lex.parseBlocks(MIXED));
    expect(md.parseBlocks("第一段\n\n第二段\n第 2 行")).toEqual(lex.parseBlocks("第一段\n\n第二段\n第 2 行"));
  });
});

describe("ω99-210 PetMarkdown 轻渲染器", () => {
  it("② bold/inline code：**粗体**与 `code` 渲染成 span，textContent 无 ** 无反引号", async () => {
    await renderMd("**粗体**和 `code`");
    const bold = container.querySelector<HTMLElement>(".pet-md-bold");
    const code = container.querySelector<HTMLElement>(".pet-md-code");
    expect(bold).not.toBeNull();
    expect(bold?.textContent).toBe("粗体");
    expect(code?.textContent).toBe("code");
    expect(container.querySelector<HTMLElement>(".pet-md")?.textContent).toBe("粗体和 code");
  });

  it("③ 结构族：heading 无 # 带 data-level；list • 行；quote | 行；table thead/tbody；pre 无钮无高亮", async () => {
    await renderMd("## 小节标题");
    const h = container.querySelector<HTMLElement>(".pet-md-heading");
    expect(h?.getAttribute("data-level")).toBe("2");
    expect(h?.textContent).toBe("小节标题");
    await renderMd("- 甲\n- 乙");
    const list = container.querySelector<HTMLElement>(".pet-md-list");
    expect(list?.textContent).toContain("• 甲");
    expect(list?.textContent).toContain("• 乙");
    await renderMd("> 引用行");
    expect(container.querySelector<HTMLElement>(".pet-md-quote")?.textContent).toBe("| 引用行");
    await renderMd("| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |");
    const table = container.querySelector<HTMLElement>("table.pet-md-table");
    expect(table?.querySelector("thead th")?.textContent).toBe("甲");
    expect(table?.querySelector("tbody td")?.textContent).toBe("1");
    await renderMd("```js\nconst x = 1;\n```");
    const pre = container.querySelector<HTMLElement>(".pet-md-pre");
    expect(pre?.querySelector("code")?.textContent).toBe("const x = 1;");
    expect(pre?.querySelector("button")).toBeNull();
    expect(pre?.querySelector("span")).toBeNull();
  });

  it("④ 纯文本等值：无记号文本（含多行 \\n）textContent 与源逐字等值", async () => {
    const plain = "第一行文字\n第二行文字\n第三行还有字";
    await renderMd(plain);
    expect(container.querySelector<HTMLElement>(".pet-md")?.textContent).toBe(plain);
    await renderMd("只有一行");
    expect(container.querySelector<HTMLElement>(".pet-md")?.textContent).toBe("只有一行");
  });
});

describe("ω99-210 Bubble 集成（两回答面）", () => {
  it("⑤ chat 回答格与 stream 形态都渲染 markdown（.pet-md 在场、** 不再裸露）", () => {
    props.inputOpen = true;
    props.transcript = [{ q: "问个问题", a: "回答里的**重点**如下", live: false }];
    renderBubble();
    const a = container.querySelector<HTMLElement>(".pet-bubble-a");
    expect(a?.querySelector(".pet-md")).not.toBeNull();
    expect(a?.textContent).toContain("重点");
    expect(a?.textContent).not.toContain("**");
    props.inputOpen = false;
    props.answerTail = "尾部也有**加粗**";
    renderBubble();
    const s = container.querySelector<HTMLElement>(".pet-bubble-stream");
    expect(s?.querySelector(".pet-md")).not.toBeNull();
    expect(s?.textContent).toContain("加粗");
    expect(s?.textContent).not.toContain("**");
  });
});

describe("ω99-210 窗界（宠物模块图）", () => {
  it("⑥ pet-md.tsx 的 import 行只有 md-lex/react——主窗 markdown.js 不进宠物图", () => {
    const src = srcOf("src/pet/pet-md.tsx");
    // win32 autocrlf 工作区行尾带 \r —— 逐行剥掉再匹配（$ 锚不被打穿）。
    const imports = src.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.startsWith("import"));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line, `unexpected import: ${line}`).toMatch(/^import\s.+from\s"(react|\.\.\/md-lex\.js)";$/);
    }
    expect(src.includes('from "../markdown')).toBe(false); // grep 门（-F）的测试镜像
  });
});
