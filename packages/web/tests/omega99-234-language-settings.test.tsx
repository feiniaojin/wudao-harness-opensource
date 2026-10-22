// ω99-234: #5 — R1：语言选择迁设置页——输入框下方退役（用户四指令 ④）。
// 频率分层归位（本弧超越点）：composer 行只留会话内高频旋钮（模型/强度/
// 模式），跨会话低频偏好进设置页——偏好 tab 新「语言」段挂同一
// LanguageSelector 组件（本体零改动）；段内选档直钉默认值（settingsSet
// language.reply / language.reasoning），会话级临时切换保留 /language 命令。
// ★红线（09-09 用户令，逐字）：「注意，开发、测试过程禁止删除用户文件/文件夹。」
// 纯 jsdom 内存渲染无文件面；本弧新/改文件 grep rm|unlink|rmdir 零命中。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { SettingsStatus } from "../src/protocol.js";
import { InputBox } from "../src/components/InputBox.js";
import { SettingsPage } from "../src/components/SettingsPage.js";
import type { LanguagePair } from "../src/components/LanguageSelector.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";

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

// ---------------------------------------------------------------------------
// (a) composer 退役：InputBox 零 LanguageSelector（不回归钉）；模型/强度
//     chip 仍在（不误伤钉）。
// ---------------------------------------------------------------------------
describe("ω99-234 (a) — composer 行退役", () => {
  const BASE = {
    busy: false,
    mode: "workspace" as const,
    commands: [],
    connected: true,
    onSubmit: vi.fn(),
    onInterrupt: vi.fn(),
    onShield: vi.fn(),
    onCycleMode: vi.fn(),
  };

  it("InputBox 渲染零语言 chip；模型/强度 chip 原样在场", () => {
    const c = mount(
      <InputBox
        {...BASE}
        modelLabel="deepseek-v4-flash"
        modelProvider="deepseek"
        modelChoices={[{ provider: "deepseek", model: "deepseek-v4-flash", source: "registry" }]}
        onPickModel={vi.fn()}
        efforts={["low", "high"]}
        effort="high"
        onPickEffort={vi.fn()}
      />,
    );
    // 不回归钉：语言 chip 从输入框下方退役（迁设置页·偏好 tab）。
    expect(c.querySelector(".composer-tools .chip.lang")).toBeNull();
    // 不误伤钉：模型 chip（.chip.model）与强度 chip（title 锚）原样在场。
    expect(c.querySelector(".composer-tools .chip.model")).not.toBeNull();
    expect(c.querySelector(".composer-tools button.chip[title='推理强度(会话内,下一轮生效)']")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 设置页 harness（settings-page.test.tsx 同款：直挂 SettingsPage + 内存
// fake WS，settingsStatus 应答一次；language 走 App 的 gateStatus 喂入面）。
// ---------------------------------------------------------------------------
const STATUS: SettingsStatus = {
  providers: [],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
  settings: { memoryEnabled: true, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: [],
};

interface Harness {
  readonly container: HTMLElement;
  readonly server: FakeServer;
}

const opsOf = (server: FakeServer): { id: number; op: Record<string, unknown> }[] =>
  server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
    typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
  ) as { id: number; op: Record<string, unknown> }[];

async function pageWithLanguage(language: LanguagePair | null): Promise<Harness> {
  const server = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  const container = mount(<SettingsPage client={client} status={null} onClose={() => {}} language={language} />);
  await act(async () => {
    const statusOp = opsOf(server).find((o) => o.op.op === "settingsStatus");
    server.socket.serverSend({ t: "result", id: statusOp?.id, ok: STATUS });
  });
  return { container, server };
}

const openTab = async (c: HTMLElement, id: string): Promise<void> => {
  await act(async () => {
    (c.querySelector(`button[data-settings-tab='${id}']`) as HTMLButtonElement).click();
  });
};

const replyTo = async (server: FakeServer, opName: string, ok: unknown): Promise<void> => {
  await act(async () => {
    const op = [...opsOf(server)].reverse().find((o) => o.op.op === opName);
    server.socket.serverSend({ t: "result", id: op?.id, ok });
  });
};

const sectionTitles = (c: HTMLElement): string[] =>
  [...c.querySelectorAll(".set-sec > h3.set-title")].map((n): string => n.textContent ?? "");

// ---------------------------------------------------------------------------
// (b/d) 偏好 tab「语言」段：标题「语言」逐字 + 说明句逐字 + 同一
//       LanguageSelector 双旋钮在场；language null（旧服务端）→ 段隐藏。
// ---------------------------------------------------------------------------
describe("ω99-234 (b/d) — 偏好 tab「语言」段", () => {
  it("语言段在场：标题逐字 + 说明句逐字 + 双旋钮（回答/思考两分组、行集原样）", async () => {
    const h = await pageWithLanguage({ reply: "on", reasoning: "zh" });
    await openTab(h.container, "preferences");
    expect(sectionTitles(h.container)).toEqual(["偏好", "语言"]);
    expect(h.container.textContent).toContain("回答与思考的语言偏好（新会话默认生效；当前会话临时切换可用 /language 命令）。");
    const chip = h.container.querySelector<HTMLButtonElement>(".settings-page button.chip.lang");
    expect(chip).not.toBeNull();
    await act(async () => {
      chip!.click();
    });
    const heads = [...h.container.querySelectorAll<HTMLElement>(".menu .lang-head")].map((n): string => n.textContent ?? "");
    expect(heads).toEqual(["回答", "思考"]);
    const replyRows = [...h.container.querySelectorAll<HTMLElement>('.menu .mi[data-knob="reply"]')].map((n): string => n.dataset.mode ?? "");
    expect(replyRows).toEqual(["auto", "on", "off"]);
    const reasonRows = [...h.container.querySelectorAll<HTMLElement>('.menu .mi[data-knob="reasoning"]')].map((n): string => n.dataset.mode ?? "");
    expect(reasonRows).toEqual(["auto", "zh", "en", "off"]);
    // 段内 footer 原样（零新交互面）：双「设为默认」在场。
    expect(h.container.querySelectorAll(".menu .mf")).toHaveLength(2);
  });

  it("language null（旧服务端无 gateStatus.language）→ 语言段整段隐藏（沿 chip 的 null 门语义）", async () => {
    const h = await pageWithLanguage(null);
    await openTab(h.container, "preferences");
    expect(sectionTitles(h.container)).toEqual(["偏好"]);
    expect(h.container.querySelector(".settings-page .chip.lang")).toBeNull();
    expect(h.container.textContent).not.toContain("回答与思考的语言偏好");
  });
});

// ---------------------------------------------------------------------------
// (c) 选档直钉默认值：行点选/设为默认 footer → settingsSet(language.*)
//     + toast 回执 + refresh 重读。
// ---------------------------------------------------------------------------
describe("ω99-234 (c) — 选档写默认值 + toast 回执", () => {
  it("行点选 → settingsSet(language.reply, off) + toast「已设为默认:回答 off —— 新会话生效」+ refresh 重读 settingsStatus", async () => {
    const h = await pageWithLanguage({ reply: "on", reasoning: "zh" });
    await openTab(h.container, "preferences");
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".settings-page button.chip.lang"))!.click();
    });
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>('.mi[data-knob="reply"][data-mode="off"]'))!.click();
    });
    expect([...opsOf(h.server)].reverse().find((o) => o.op.op === "settingsSet")?.op).toMatchObject({
      op: "settingsSet",
      key: "language.reply",
      value: "off",
    });
    await replyTo(h.server, "settingsSet", { key: "language.reply", saved: true });
    expect(h.container.querySelector(".settings-toasts")?.textContent).toContain("已设为默认:回答 off —— 新会话生效");
    // refresh：写落后再读一次 settingsStatus（页级快照跟真值）。
    expect(opsOf(h.server).filter((o) => o.op.op === "settingsStatus")).toHaveLength(2);
  });

  it("设为默认 footer → settingsSet(language.reasoning, 当前会话值 zh) + toast「已设为默认:思考 zh —— 新会话生效」", async () => {
    const h = await pageWithLanguage({ reply: "on", reasoning: "zh" });
    await openTab(h.container, "preferences");
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".settings-page button.chip.lang"))!.click();
    });
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".menu .mf[data-persist='reasoning']"))!.click();
    });
    expect([...opsOf(h.server)].reverse().find((o) => o.op.op === "settingsSet")?.op).toMatchObject({
      op: "settingsSet",
      key: "language.reasoning",
      value: "zh",
    });
    await replyTo(h.server, "settingsSet", { key: "language.reasoning", saved: true });
    expect(h.container.querySelector(".settings-toasts")?.textContent).toContain("已设为默认:思考 zh —— 新会话生效");
  });
});

// ---------------------------------------------------------------------------
// (e) 其他六 tab 零动（结构钉）：七 tab 序不变；语言段只在 preferences。
// ---------------------------------------------------------------------------
describe("ω99-234 (e) — 其他六 tab 零动", () => {
  it("七 tab 序不变；其余六 tab 无语言段（chip 与段标题皆不在），语言段只在 preferences", async () => {
    const h = await pageWithLanguage({ reply: "on", reasoning: "zh" });
    expect(
      [...h.container.querySelectorAll(".set-nav [data-settings-tab]")].map((n): string => n.getAttribute("data-settings-tab") ?? ""),
    ).toEqual(["provider", "permissions", "appearance", "preferences", "persona", "mcp", "plugins"]);
    for (const id of ["provider", "permissions", "appearance", "persona", "mcp", "plugins"] as const) {
      await openTab(h.container, id);
      expect(h.container.querySelector(".settings-page .chip.lang")).toBeNull();
      expect(sectionTitles(h.container)).not.toContain("语言");
    }
    await openTab(h.container, "preferences");
    expect(h.container.querySelector(".settings-page .chip.lang")).not.toBeNull();
    expect(sectionTitles(h.container)).toContain("语言");
  });
});
