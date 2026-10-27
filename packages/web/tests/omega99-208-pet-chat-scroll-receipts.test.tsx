// @vitest-environment jsdom
// ω99-208: #R — receipts 精灵聊天窗滚动修复（0.3.56 验装回执「无滚动条 +
// 输入框被顶走」，根因 = flex 高度链断裂：父级无 flex 容器语义，chat 复合体
// 百分比高度解析回 auto，transcript 的 flex 塌缩规则全部落空）：①CSS 形钉
// （input 态块 flex 容器化 + chat 类高度旧形换 flex 塌缩）；②③jsdom 行为
// （transcript mock scrollHeight → effect 赋 scrollTop=scrollHeight，流式
// 增长跟随再滚——同 201「最新永远在屏」设计意图）；④长 transcript 下输入
// 行结构保位（jsdom 无布局，视觉保位由 ① CSS 钉承载，如实注记）；⑤201
// 语义回归锚（thinking 格 + q 行右对齐类）。先红：①②③；④⑤改前即绿 =
// 防回归面（brief §四如实分类）。harness 沿 omega99-201 同法 act+createRoot。
// CSS 读取用纯字符串拼接（不用 `new URL(rel, import.meta.url)`）：jsdom 环境
// 下全局 URL 构造器的 base 解析非确定（base 被换 window.location → http 形
// → fileURLToPath 抛 scheme 错；201 ⑦ 同式属侥幸过——探针三次坐实，见
// 报告「事故披露」）。字符串形零依赖全局 URL，探针 4 验证稳定。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Bubble } from "../src/pet/Bubble.js";
import { tauriEmitEvent, tauriInvokeCommand } from "../src/tauri-invoke.js";
import type { BubbleProps } from "../src/pet/Bubble.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/tauri-invoke.js", () => ({
  tauriEmitEvent: vi.fn(async () => false),
  tauriInvokeCommand: vi.fn(async () => null),
}));

let container: HTMLElement;
let root: Root;
let props: BubbleProps;

function render(): void {
  act(() => {
    root.render(<Bubble {...props} />);
  });
}

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

/** scroll-bottom.test.tsx 同族 mock 范式：defineProperty 盖 jsdom 布局盲，
 *  scrollTop 盖成 writable 普通属性——effect 赋值直存可读回。 */
function mockScroll(el: HTMLElement, scrollHeight: number): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: 0 });
}

const transcriptEl = (): HTMLElement => container.querySelector<HTMLElement>("[data-bubble-transcript]")!;

/** CSS 块提取：sel 后紧跟 ` {`…`}`（首个闭合花括号），不吞伪元素邻块。 */
const cssBlock = (css: string, sel: string): string => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(esc + " \\{([^}]*)\\}"))?.[1] ?? "";
};

describe("ω99-208 CSS 形钉（flex 高度链接通）", () => {
  it("① input 态块 flex 容器化；chat 类塌缩旧形死、flex/min-height 在；transcript 滚动规则保", () => {
    // win32：fileURLToPath 出反斜杠路径，`[^/]*$` 会吞掉整条路径（正则
    // 无 `/` 可锚）→ 相对 CWD 解析错位。dirname/join 无平台差。
    const petCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/pet/pet.css"), "utf8");
    const inputBlock = cssBlock(petCss, '.pet-bubble[data-bubble-state="input"]');
    expect(inputBlock).toContain("display: flex");
    expect(inputBlock).toContain("flex-direction: column");
    const chatBlock = cssBlock(petCss, ".pet-bubble-chat");
    expect(chatBlock).toContain("flex: 1 1 auto");
    expect(chatBlock).toContain("min-height: 0");
    expect(chatBlock).not.toContain("height: 100%");
    const tsBlock = cssBlock(petCss, ".pet-bubble-transcript");
    expect(tsBlock).toContain("overflow-y:auto"); // 源真形（无空格，201 ⑦ 同形）
    expect(tsBlock).toContain("min-height: 0");
  });
});

describe("ω99-208 自动滚底（jsdom 行为面）", () => {
  it("② mount chat 复合体 → effect 赋 scrollTop=scrollHeight（mock 480）", () => {
    props.inputOpen = true;
    props.transcript = [
      { q: "第一问", a: "第一答 ".repeat(40), live: false },
      { q: "第二问", a: "第二答 ".repeat(40), live: false },
    ];
    render();
    const ts = transcriptEl();
    expect(ts).not.toBeNull();
    mockScroll(ts, 480);
    props.transcript = [...props.transcript]; // 新引用（内容不变——父帧每态新数组，201 语义）
    render();
    expect(ts.scrollTop).toBe(480);
  });

  it("③ 末轮 a 流式增长 → scrollTop 跟随新 mock 值（760）再滚", () => {
    props.inputOpen = true;
    props.transcript = [{ q: "在答的问题", a: "开头 ", live: true }];
    render();
    const ts = transcriptEl();
    mockScroll(ts, 480);
    props.transcript = [...props.transcript]; // 引用变触发 effect（React 依赖 Object.is）
    render();
    expect(ts.scrollTop).toBe(480);
    mockScroll(ts, 760); // 增长后内容更高
    props.transcript = [{ q: "在答的问题", a: "开头 " + "继续写 ".repeat(60), live: true }];
    render();
    expect(ts.scrollTop).toBe(760);
  });
});

describe("ω99-208 保位与回归面", () => {
  it("④ 长 transcript 下输入行结构在场（textarea + 发送/取消钮）——jsdom 无布局，视觉保位由 ① CSS 钉承载", () => {
    props.inputOpen = true;
    props.transcript = [
      { q: "长问题一", a: "长回答 ".repeat(80), live: false },
      { q: "长问题二", a: "长回答 ".repeat(80), live: false },
    ];
    render();
    expect(container.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]")).not.toBeNull();
    expect(container.querySelector("[data-bubble-send]")).not.toBeNull();
    expect(container.querySelector("[data-bubble-cancel]")).not.toBeNull();
  });

  it("⑤ 201 语义不回归：末位 live 空答 → 「思考中…」格；q 行右对齐类在场", () => {
    props.inputOpen = true;
    props.transcript = [
      { q: "已答的问题", a: "已给的回答", live: false },
      { q: "刚发的问题", a: "", live: true },
    ];
    render();
    expect(container.querySelector<HTMLElement>(".pet-bubble-thinking")?.textContent).toContain("思考中…");
    expect(container.querySelector<HTMLElement>(".pet-bubble-q")).not.toBeNull();
  });
});
