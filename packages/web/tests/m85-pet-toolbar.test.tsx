// @vitest-environment jsdom
// M85-pet §2: #4 — Bubble 工具栏（四控件，全部只作用 pet 车道自己）：新会话 /
// 模型 / 思考深度 / 工作区。RED-first（照 pet-bubble.test.tsx 的 act +
// createRoot + 原生事件范式，无 @testing-library）。
//
// 契约（Task 4 的发射面已落地，本文件钉 Bubble 侧）：
//   1. 四控件恒随气泡渲染（气泡在=窗口在=工具栏在）；三 chip 按帧真值显示
//      （model/effort/workspaceName；null=缺席→占位词）；
//   2. 所有动作走 tauriEmitEvent(WUDAO_PET_TOOLBAR_EVENT, action)——与
//      ask/answer 同一发射面，relay 翻译成 pet 四 op；
//   3. 数据面降级（宠物窗无 WS——主窗 registry/recents 数据面不可达）：
//      思考=EFFORT_LEVELS 常量档位（受限列表）；模型/工作区=帧真值 +
//      手输弹层（朴素选择，不为 v1 新开数据通道）；
//   4. 新会话 = emit + onNewSession 本地清屏回调（PetApp 清 chat/history/
//      awaiting；服务器回执面是下一帧——本地清是「点击」这一本地事实的
//      呈现，op 失败时下次拉史回真值）。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { existsSync, readFileSync } from "node:fs";
import { Bubble } from "../src/pet/Bubble.js";
import { WUDAO_PET_TOOLBAR_EVENT } from "../src/pet/pet-frame.js";
import { tauriEmitEvent, tauriInvokeCommand } from "../src/tauri-invoke.js";
import type { BubbleProps } from "../src/pet/Bubble.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/tauri-invoke.js", () => ({
  tauriEmitEvent: vi.fn(async () => false),
  tauriInvokeCommand: vi.fn(async () => null),
}));

const emitMock = vi.mocked(tauriEmitEvent);
const invokeMock = vi.mocked(tauriInvokeCommand);

let container: HTMLElement;
let root: Root;
let props: BubbleProps;
const closed = vi.fn();
const deliveryClosed = vi.fn();
const selectionClosed = vi.fn();
const petTurn = vi.fn();
// M85-pet：新会话的本地清屏回调（PetApp 清 chat/history/awaiting）。
const newSession = vi.fn();

function render(): void {
  act(() => {
    root.render(<Bubble {...props} />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // 聊天形态（inputOpen）起手——工具栏的常态上下文；三真值 + 清屏回调全接。
  props = {
    inputOpen: true,
    answerTail: "",
    waitingUser: false,
    onInputClose: closed,
    delivery: null,
    onDeliveryClose: deliveryClosed,
    ask: null,
    selection: null,
    onSelectionClose: selectionClosed,
    busyNarration: null,
    workKind: null,
    transcript: [],
    onPetTurn: petTurn,
    livePending: false,
    model: "glm-5.3",
    effort: "high",
    workspaceName: "demo",
    onNewSession: newSession,
  };
  emitMock.mockClear();
  invokeMock.mockClear();
  closed.mockClear();
  deliveryClosed.mockClear();
  selectionClosed.mockClear();
  petTurn.mockClear();
  newSession.mockClear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.innerHTML = "";
});

const toolbar = (): HTMLElement | null => container.querySelector<HTMLElement>("[data-pet-toolbar]");
const btn = (sel: string): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>(sel);
const input = (sel: string): HTMLInputElement | null => container.querySelector<HTMLInputElement>(sel);
const menu = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel);
const click = (el: Element | null): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
function typeIntoInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("M85-pet 工具栏：四控件渲染 + 帧真值 + 新会话", () => {
  it("渲染四控件并按帧显示真值；点击新会话发 toolbar 事件 + 本地清屏回调", () => {
    render();
    expect(toolbar()).not.toBeNull();
    expect(btn("[data-toolbar-new]")?.title).toBe("新会话");
    expect(btn("[data-toolbar-model]")?.textContent).toContain("glm-5.3");
    expect(btn("[data-toolbar-effort]")?.textContent).toContain("high");
    expect(btn("[data-toolbar-workspace]")?.textContent).toContain("demo");
    click(btn("[data-toolbar-new]"));
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_TOOLBAR_EVENT, { kind: "new-session" });
    expect(newSession).toHaveBeenCalledTimes(1); // 本地清屏面（PetApp 清三态）
  });

  it("缺省归一（未接线=缺席）：占位词 模型/思考/工作区；新会话照发不炸", () => {
    // 老构造（新 props 全缺省）——既有测试面零演进的同形证明。
    props = {
      inputOpen: true,
      answerTail: "",
      waitingUser: false,
      onInputClose: closed,
      delivery: null,
      onDeliveryClose: deliveryClosed,
      ask: null,
      selection: null,
      onSelectionClose: selectionClosed,
      busyNarration: null,
      workKind: null,
      transcript: [],
      onPetTurn: petTurn,
      livePending: false,
    };
    render();
    expect(btn("[data-toolbar-model]")?.textContent).toContain("模型");
    expect(btn("[data-toolbar-effort]")?.textContent).toContain("思考");
    expect(btn("[data-toolbar-workspace]")?.textContent).toContain("工作区");
    click(btn("[data-toolbar-new]"));
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_TOOLBAR_EVENT, { kind: "new-session" });
  });

  it("工具栏随气泡恒在（stream 形态也有——窗口在=控制行在）", () => {
    props.inputOpen = false;
    props.answerTail = "流式正文";
    render();
    expect(toolbar()).not.toBeNull();
    expect(btn("[data-toolbar-new]")).not.toBeNull();
  });
});

describe("M85-pet 思考 chip（受限档位列表）", () => {
  it("点开 → EFFORT_LEVELS 五档（low/medium/high/max/none）；当前档 .on", () => {
    render();
    expect(menu("[data-toolbar-effort-menu]")).toBeNull(); // 起手关
    click(btn("[data-toolbar-effort]"));
    const items = container.querySelectorAll<HTMLButtonElement>("[data-toolbar-effort-item]");
    expect(Array.from(items).map((b) => b.dataset.toolbarEffortItem)).toEqual([
      "low",
      "medium",
      "high",
      "max",
      "none",
    ]);
    expect(items[2]?.className).toContain("on"); // 帧真值 high 高亮
    expect(items[0]?.className).not.toContain("on");
  });

  it("点选档位 → emit set-effort + 菜单收；chip 仍显帧真值（服务器回执才换）", () => {
    render();
    click(btn("[data-toolbar-effort]"));
    click(btn("[data-toolbar-effort-item='max']"));
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_TOOLBAR_EVENT, { kind: "set-effort", effort: "max" });
    expect(menu("[data-toolbar-effort-menu]")).toBeNull(); // 发完即收
    expect(btn("[data-toolbar-effort]")?.textContent).toContain("high"); // 帧真值不动
  });
});

describe("M85-pet 模型 chip（降级手输面：宠物窗无 registry 数据面）", () => {
  it("点开 → 供应商/模型两输入；供应商空=不发（wire 门：provider 必填非空）", () => {
    render();
    click(btn("[data-toolbar-model]"));
    expect(menu("[data-toolbar-model-menu]")).not.toBeNull();
    expect(input("[data-toolbar-provider]")?.placeholder).toContain("供应商");
    expect(input("[data-toolbar-model-input]")?.value).toBe("glm-5.3"); // 帧真值预填
    click(btn("[data-toolbar-model-send]"));
    expect(emitMock).not.toHaveBeenCalled(); // provider 空 no-op
    expect(menu("[data-toolbar-model-menu]")).not.toBeNull(); // 不收（可继续填）
  });

  it("双值 → emit set-model {provider, model}；载荷逐字", () => {
    render();
    click(btn("[data-toolbar-model]"));
    typeIntoInput(input("[data-toolbar-provider]")!, "glm");
    typeIntoInput(input("[data-toolbar-model-input]")!, "glm-5.3");
    click(btn("[data-toolbar-model-send]"));
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_TOOLBAR_EVENT, {
      kind: "set-model",
      provider: "glm",
      model: "glm-5.3",
    });
    expect(menu("[data-toolbar-model-menu]")).toBeNull(); // 发完即收
  });

  it("模型留空 → 载荷不带 model 键（只换供应商档——canonical 形状）", () => {
    render();
    click(btn("[data-toolbar-model]"));
    typeIntoInput(input("[data-toolbar-provider]")!, "deepseek");
    typeIntoInput(input("[data-toolbar-model-input]")!, "");
    click(btn("[data-toolbar-send]") ?? btn("[data-toolbar-model-send]"));
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]![1]).toEqual({ kind: "set-model", provider: "deepseek" });
  });

  it("Enter 即发送（供应商框回车）；IME 组合期 Enter 不误发", () => {
    render();
    click(btn("[data-toolbar-model]"));
    const provider = input("[data-toolbar-provider]")!;
    typeIntoInput(provider, "glm");
    act(() => {
      provider.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_TOOLBAR_EVENT, {
      kind: "set-model",
      provider: "glm",
      model: "glm-5.3", // 模型框留帧真值预填 → 随载荷
    });
    // IME 组合期（isComposing）Enter 归候选确认——不发送
    emitMock.mockClear();
    click(btn("[data-toolbar-model]"));
    const provider2 = input("[data-toolbar-provider]")!;
    typeIntoInput(provider2, "de");
    act(() => {
      provider2.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      provider2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    });
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe("M85-pet 工作区 chip（降级手输面：宠物窗无 recents 数据面）", () => {
  it("点开 → 路径输入；空=不发；回填 → emit set-workspace", () => {
    render();
    click(btn("[data-toolbar-workspace]"));
    expect(menu("[data-toolbar-workspace-menu]")).not.toBeNull();
    click(btn("[data-toolbar-workspace-send]"));
    expect(emitMock).not.toHaveBeenCalled(); // 空路径 no-op
    typeIntoInput(input("[data-toolbar-path]")!, "/Users/x/demo");
    click(btn("[data-toolbar-workspace-send]"));
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_TOOLBAR_EVENT, { kind: "set-workspace", path: "/Users/x/demo" });
    expect(menu("[data-toolbar-workspace-menu]")).toBeNull(); // 发完即收
    expect(btn("[data-toolbar-workspace]")?.textContent).toContain("demo"); // 帧真值不动
  });
});

describe("M85-pet 菜单纪律（一开一关 + 外点收）", () => {
  it("互斥：一次只开一个菜单", () => {
    render();
    click(btn("[data-toolbar-effort]"));
    expect(menu("[data-toolbar-effort-menu]")).not.toBeNull();
    click(btn("[data-toolbar-model]"));
    expect(menu("[data-toolbar-effort-menu]")).toBeNull(); // 旧菜单收
    expect(menu("[data-toolbar-model-menu]")).not.toBeNull();
    click(btn("[data-toolbar-model]")); // 再点同 chip = 收起
    expect(menu("[data-toolbar-model-menu]")).toBeNull();
  });

  it("气泡外 pointerdown → 菜单收（EffortSelector 的 outside-close 同款）", () => {
    render();
    click(btn("[data-toolbar-effort]"));
    expect(menu("[data-toolbar-effort-menu]")).not.toBeNull();
    act(() => {
      // jsdom 无 PointerEvent 构造器——原生监听只认 type，MouseEvent 派发同效。
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(menu("[data-toolbar-effort-menu]")).toBeNull();
  });
});

// --- CSS 收据（pet-bubble.test.tsx 的 274 CSS-receipt 同范式） -------------------
// 0.3.78 零像素回归的教训：插结构层必带 CSS 契约钉——jsdom 只证 DOM 形状不
// 证画得出；样式断言钉 .pet-toolbar 的存在性、紧凑规格、stream 态 ✕ 让位、
// 窄窗图标收缩（brief 的「窄窗 chips 收缩为图标」）。
describe("M85-pet 工具栏 CSS 收据", () => {
  const readPetSrc = (rel: string): string => {
    const hit = ["src/pet", "packages/web/src/pet"]
      .map((d) => `${process.cwd()}/${d}/${rel}`)
      .find((p) => existsSync(p));
    if (hit === undefined) throw new Error(`pet source not found: ${rel}`);
    return readFileSync(hit, "utf8");
  };

  it(".pet-toolbar 基座 + 三 chip 紧凑样式在 pet.css（宠物窗只加载 pet.css——主窗 .pop/.menu 类在本窗无样式，工具栏样式必须自带）", () => {
    const css = readPetSrc("pet.css");
    expect(css).toContain(".pet-toolbar {");
    expect(css).toContain(".pet-chip {");
    expect(css).toContain(".pet-menu {");
    // 窄窗收缩：media query 内 chip 文字让位图标（图标 aria-hidden 不清场）
    expect(css).toMatch(/@media\s*\(max-width:\s*2[0-9]{2}px\)\s*\{[^}]*\.pet-chip/);
    // stream 态右上 ✕ 让位（pet-bubble-close 浮角 top:4 right:4 不压 chip）
    expect(css).toContain('.pet-bubble[data-bubble-state="stream"] .pet-toolbar');
  });

  it("入口接线收据：PetApp 给 Bubble 传 model/effort/workspaceName/onNewSession（帧蒸馏三值 + 清屏回调）", () => {
    const petAppSrc = readPetSrc("PetApp.tsx");
    const bubbleMount = petAppSrc.slice(petAppSrc.indexOf("<Bubble"), petAppSrc.indexOf("<PetSprite"));
    expect(bubbleMount).toContain("model={frame?.model ?? null}");
    expect(bubbleMount).toContain("effort={frame?.effort ?? null}");
    expect(bubbleMount).toContain("workspaceName={frame?.workspaceName ?? null}");
    expect(bubbleMount).toContain("onNewSession={");
  });

  it("清屏面收据：PetApp 的 onNewSession 清三态（chat/awaiting/history）；signals 暴露 clearHistory（mergeChat 不复活旧轮的前提）", () => {
    const petAppSrc = readPetSrc("PetApp.tsx");
    expect(petAppSrc).toContain("clearHistory");
    expect(petAppSrc).toContain("setChat(emptyPetChat)");
    const signalsSrc = readPetSrc("signals.ts");
    expect(signalsSrc).toContain("clearHistory");
  });
});

// --- M85-final I-3（终审修复波）数据面列表升级 ----------------------------------
// spec §2「数据面复用」的字面达成：帧带 modelChoices/recentWorkspaces 时弹层
// 是列表选择（点行即发对应 toolbar 事件）；null（数据缺席——旧主窗/坏数据）
// 才显示手输输入框（保底兼容——上方两个降级面 describe 的行为零演进）。
// 空数组归一 null（零项列表没有任何可选，手输是更诚实的面）。
describe("M85-final I-3 数据面列表（模型/工作区弹层升级）", () => {
  it("modelChoices 在场 → 列表行渲染（provider · model）、无手输框；点行 → emit set-model + 菜单收", () => {
    props.modelChoices = [
      { provider: "glm", model: "glm-5.3" },
      { provider: "deepseek", model: "deepseek-v4" },
    ];
    render();
    click(btn("[data-toolbar-model]"));
    const items = container.querySelectorAll<HTMLButtonElement>("[data-toolbar-model-item]");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("glm · glm-5.3");
    expect(items[1]?.textContent).toContain("deepseek · deepseek-v4");
    // 手输面缺席（列表在=手输退场）
    expect(input("[data-toolbar-provider]")).toBeNull();
    expect(input("[data-toolbar-model-input]")).toBeNull();
    click(items[1] ?? null);
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_TOOLBAR_EVENT, {
      kind: "set-model",
      provider: "deepseek",
      model: "deepseek-v4",
    });
    expect(menu("[data-toolbar-model-menu]")).toBeNull(); // 发完即收
    expect(btn("[data-toolbar-model]")?.textContent).toContain("glm-5.3"); // chip 仍显帧真值
  });

  it("modelChoices null（数据缺席）→ 手输面照旧（保底兼容——帧 null 是旧主窗/降级态）", () => {
    props.modelChoices = null;
    render();
    click(btn("[data-toolbar-model]"));
    expect(container.querySelectorAll("[data-toolbar-model-item]")).toHaveLength(0);
    expect(input("[data-toolbar-provider]")).not.toBeNull();
    expect(input("[data-toolbar-model-input]")).not.toBeNull();
    expect(btn("[data-toolbar-model-send]")).not.toBeNull();
  });

  it("modelChoices 空数组 → 归一手输面（零项列表没有可选，手输更诚实）", () => {
    props.modelChoices = [];
    render();
    click(btn("[data-toolbar-model]"));
    expect(container.querySelectorAll("[data-toolbar-model-item]")).toHaveLength(0);
    expect(input("[data-toolbar-provider]")).not.toBeNull();
  });

  it("recentWorkspaces 在场 → 列表行渲染（label=basename、title=全路径——主窗 WorkspaceChip 同款信息对）、无手输框；点行 → emit set-workspace + 菜单收", () => {
    props.recentWorkspaces = ["/Users/x/work/proj-a", "/Users/x/work/proj-b"];
    render();
    click(btn("[data-toolbar-workspace]"));
    const items = container.querySelectorAll<HTMLButtonElement>("[data-toolbar-workspace-item]");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("proj-a");
    expect(items[0]?.getAttribute("title")).toBe("/Users/x/work/proj-a"); // 全路径进 title
    expect(input("[data-toolbar-path]")).toBeNull(); // 手输面缺席
    click(items[1] ?? null);
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_TOOLBAR_EVENT, {
      kind: "set-workspace",
      path: "/Users/x/work/proj-b",
    });
    expect(menu("[data-toolbar-workspace-menu]")).toBeNull(); // 发完即收
    expect(btn("[data-toolbar-workspace]")?.textContent).toContain("demo"); // chip 仍显帧真值
  });

  it("recentWorkspaces null（数据缺席）→ 手输路径框照旧（保底兼容）", () => {
    props.recentWorkspaces = null;
    render();
    click(btn("[data-toolbar-workspace]"));
    expect(container.querySelectorAll("[data-toolbar-workspace-item]")).toHaveLength(0);
    expect(input("[data-toolbar-path]")).not.toBeNull();
    expect(btn("[data-toolbar-workspace-send]")).not.toBeNull();
  });

  // 试用反馈二（2026-11-09）：浏览动作交主窗开选择器（精灵窗直开=贴底
  // sheet 不可拖）——Bubble 只发 pick-workspace + 收菜单；路径由 relay 侧
  // 选择器回填（relay 测试覆盖选定/取消两态）。
  it("浏览文件夹…：点击 → emit pick-workspace + 菜单收（选择器在主窗侧）", () => {
    props.recentWorkspaces = null;
    render();
    click(btn("[data-toolbar-workspace]"));
    const browse = btn("[data-toolbar-workspace-browse]");
    expect(browse?.textContent).toContain("浏览文件夹…");
    click(browse);
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_TOOLBAR_EVENT, { kind: "pick-workspace" });
    expect(menu("[data-toolbar-workspace-menu]")).toBeNull();
  });

  it("入口接线收据（M85-final）：PetApp 给 Bubble 传 workspacePath/modelChoices/recentWorkspaces（帧四项 + 两数据面）", () => {
    const petAppSrc = ["src/pet", "packages/web/src/pet"]
      .map((d) => `${process.cwd()}/${d}/PetApp.tsx`)
      .reduce<string | undefined>((hit, p) => hit ?? (existsSync(p) ? p : undefined), undefined);
    if (petAppSrc === undefined) throw new Error("PetApp.tsx not found");
    const src = readFileSync(petAppSrc, "utf8");
    const bubbleMount = src.slice(src.indexOf("<Bubble"), src.indexOf("<PetSprite"));
    expect(bubbleMount).toContain("workspacePath={frame?.workspacePath ?? null}");
    expect(bubbleMount).toContain("modelChoices={frame?.modelChoices ?? null}");
    expect(bubbleMount).toContain("recentWorkspaces={frame?.recentWorkspaces ?? null}");
  });
});
