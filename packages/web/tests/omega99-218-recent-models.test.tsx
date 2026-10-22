// @vitest-environment jsdom
// ω99-218: #R — 模型选择器「最近使用」receipts。先红后绿：红=纯层缺位
// （recent-models-store module not found，如实分类）。三层：①store 纯层
// （畸形载荷读作空/逐条 {provider,model} 双非空串守卫/往返恰 {recent} 形状/
// touchRecent 滤同对挪头+封顶裁尾+空表首插/被禁 storage 读空写不崩）；
// ②ModelSelector 组件面（「最近使用」虚拟组行=左列首位+「N 个」徽记/hover
// 与 click 双联动右栏 recent 行/mlabel=model、msub=provider/跨家行
// onPick(model, provider) 对参数正确+缓存全冷 title 在/矩阵滤层死端点行
// 不渲染/全死零虚拟行/零喂=旧行为（左列纯供应商+打开自动跟随当前供应商）/
// 重开回自动焦点/recent pane 也有设为默认 footer）；③全 App harness（215
// unread receipts 式样 mock-ws：boot 首观察播种当前模型（首见=在用）/快照
// 实变才 touch+不变零写（busy 帧同模型零重写）/A→B→A 挪头/封顶 5 经 App
// 丢最旧/provider 缺位的 v1 形状不 touch/透传到高级壳层选择器渲染虚拟组）。
// 夹具全内存（jsdom localStorage）——红线：零盘路径零 rm。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelSelector } from "../src/components/ModelSelector.js";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import {
  MAX_RECENT_MODELS,
  readRecent,
  touchRecent,
  writeRecent,
} from "../src/recent-models-store.js";

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
  window.localStorage.removeItem("wudao.ui.v1");
  window.localStorage.removeItem("wudao.recap.v1");
  window.localStorage.removeItem("wudao.archive.v1");
  window.localStorage.removeItem("wudao.unread.v1");
  window.localStorage.removeItem("wudao.recent-models.v1");
  document.title = "";
});

// ─── ① store 纯层 ────────────────────────────────────────────────────────────

describe("recent-models-store 纯层 (ω99-218)", () => {
  it("畸形载荷读作空（非 JSON/空串/null/错形/recent 非数组），条目守卫逐条（双非空串缺一整条出局，好条目不陪葬），缺 key 读作空", () => {
    expect(readRecent()).toEqual([]); // no key
    const KEY = "wudao.recent-models.v1";
    const bads = [
      "not json{",
      "",
      "[]",
      "null",
      JSON.stringify({}),
      JSON.stringify({ recent: "x" }),
      JSON.stringify({ recent: { a: 1 } }),
      JSON.stringify({ other: [1, 2] }),
    ];
    for (const bad of bads) {
      window.localStorage.setItem(KEY, bad);
      expect(readRecent()).toEqual([]);
    }
    // 逐条守卫：非对象/缺字段/空串/非串值整条出局，好条目保留（214/215 同款
    // 粒度——畸形条目不废整份）。
    window.localStorage.setItem(KEY, JSON.stringify({
      recent: [
        { provider: "glm", model: "glm-5" },
        null,
        "x",
        {},
        { provider: "glm" },
        { model: "glm-5" },
        { provider: "", model: "glm-5" },
        { provider: "glm", model: "" },
        { provider: 3, model: "glm-5" },
        { provider: "zhipu", model: "glm-5-air" },
      ],
    }));
    expect(readRecent()).toEqual([
      { provider: "glm", model: "glm-5" },
      { provider: "zhipu", model: "glm-5-air" },
    ]);
  });

  it("writeRecent→readRecent 往返（载荷恰 {recent} 单版本化形状，数组序=落盘序）", () => {
    const back = writeRecent([{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }]);
    expect(back).toEqual([{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }]);
    expect(readRecent()).toEqual([{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }]);
    expect(window.localStorage.getItem("wudao.recent-models.v1")).toBe(
      JSON.stringify({ recent: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] }),
    );
  });

  it("touchRecent 纯函数：空表首插/滤同对挪头（旧位剔除）/不同家同名模型是两条/封顶裁尾丢最旧/cap 可钉", () => {
    // 空表首插。
    expect(touchRecent([], { provider: "glm", model: "glm-5" })).toEqual([{ provider: "glm", model: "glm-5" }]);
    // 滤同对挪头：已在对重触 → 去旧位插新头，绝不重复。
    const l1 = [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }];
    expect(touchRecent(l1, { provider: "a", model: "m1" })).toEqual([
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
    ]);
    // 不同家同名模型 = 两条不同条目（lane 身份是 (provider, model) 对）。
    const l2 = [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }];
    expect(touchRecent(l2, { provider: "c", model: "m1" })).toEqual([
      { provider: "c", model: "m1" },
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
    ]);
    // 封顶裁尾：默认 5，超限丢最旧（头=最新、尾=最旧——裁尾即丢最旧）。
    const five = [
      { provider: "p1", model: "m1" },
      { provider: "p2", model: "m2" },
      { provider: "p3", model: "m3" },
      { provider: "p4", model: "m4" },
      { provider: "p5", model: "m5" },
    ];
    const next = touchRecent(five, { provider: "p6", model: "m6" });
    expect(next).toHaveLength(MAX_RECENT_MODELS);
    expect(next).toEqual([
      { provider: "p6", model: "m6" },
      { provider: "p1", model: "m1" },
      { provider: "p2", model: "m2" },
      { provider: "p3", model: "m3" },
      { provider: "p4", model: "m4" },
    ]);
    expect(next).not.toContainEqual({ provider: "p5", model: "m5" }); // 尾=最旧出局
    // cap 参数可钉（脱离默认直钉小上限）。
    expect(touchRecent(five, { provider: "p6", model: "m6" }, 2)).toEqual([
      { provider: "p6", model: "m6" },
      { provider: "p1", model: "m1" },
    ]);
  });

  it("被禁 storage 读作空、写不崩（UI_LAYOUT_KEY 律：try/catch 全包）", () => {
    const orig = Object.getOwnPropertyDescriptor(window, "localStorage");
    try {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new Error("denied");
        },
      });
      expect(readRecent()).toEqual([]);
      expect(() => writeRecent([{ provider: "a", model: "m1" }])).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", orig!);
    }
    expect(readRecent()).toEqual([]);
  });
});

// ─── ② ModelSelector 组件面 ──────────────────────────────────────────────────

const CHOICES = [
  { provider: "deepseek", model: "deepseek-v4-flash", source: "profile" },
  { provider: "deepseek", model: "deepseek-v4-think", source: "profile" },
  { provider: "siliconflow", model: "deepseek-v4-flash", source: "profile" },
  { provider: "glm", model: "glm-5", source: "profile" },
  { provider: "openrouter", model: "kimi-k3", source: "env" },
];

const openMenuOf = (c: HTMLElement): HTMLElement => {
  act(() => {
    c.querySelector<HTMLButtonElement>("button.chip")!.click();
  });
  return c;
};

/** 联动到「最近使用」虚拟组（click 路径）。 */
const linkRecent = (c: HTMLElement): void => {
  act(() => {
    c.querySelector<HTMLButtonElement>(".mroot .mi.mrec")!.click();
  });
};

const focusedGroup = (c: HTMLElement): string | null =>
  c.querySelector<HTMLElement>(".mpane .mgroup")?.textContent ?? null;

describe("ModelSelector 最近使用虚拟组 (ω99-218)", () => {
  it("左列首位渲染「最近使用」虚拟组行：「N 个」徽记、点击联动右栏 recent 行（mlabel=model、msub=provider）、打开焦点仍自动跟随当前供应商", () => {
    const c = openMenuOf(
      mount(
        <ModelSelector
          label="deepseek-v4-flash"
          provider="deepseek"
          choices={CHOICES}
          recent={[{ provider: "glm", model: "glm-5" }, { provider: "deepseek", model: "deepseek-v4-think" }]}
          onPick={vi.fn()}
        />,
      ),
    );
    // 打开即自动跟随当前供应商（四轮反馈锁定的行为不动）。
    expect(focusedGroup(c)).toBe("deepseek");
    // 虚拟组行在左列首位（真供应商行之前）。
    const rows = [...c.querySelectorAll<HTMLElement>(".mroot .mi")];
    expect(rows[0]?.classList.contains("mrec")).toBe(true);
    expect(rows[0]?.textContent).toContain("最近使用");
    expect(rows[0]?.textContent).toContain("2 个");
    expect(rows.slice(1).map((r) => r.classList.contains("mrec"))).toEqual([false, false, false, false]);
    // 点击联动：右栏换 recent 行（组头「最近使用」；mlabel=model、msub=provider）。
    linkRecent(c);
    expect(focusedGroup(c)).toBe("最近使用");
    const paneRows = c.querySelectorAll<HTMLElement>(".mpane .mi[data-model]");
    expect(paneRows).toHaveLength(2);
    expect(paneRows[0]?.getAttribute("data-model")).toBe("glm-5");
    expect(paneRows[0]?.getAttribute("data-provider")).toBe("glm");
    expect(paneRows[0]?.querySelector(".mlabel")?.textContent).toBe("glm-5");
    expect(paneRows[0]?.querySelector(".msub")?.textContent).toBe("glm");
    expect(paneRows[1]?.querySelector(".msub")?.textContent).toBe("deepseek");
    // 左列供应商行常驻不消失（ONE surface——虚拟组是增不是改）。
    expect(c.querySelectorAll(".mroot .mi.mprov")).toHaveLength(5); // 4 供应商 + 1 虚拟组
  });

  it("hover 也联动（级联机械的另一半）；recent pane 的设为默认 footer 仍在；重开回自动焦点（联动态不跨开合）", () => {
    const onPersistDefault = vi.fn();
    const c = openMenuOf(
      mount(
        <ModelSelector
          label="deepseek-v4-flash"
          provider="deepseek"
          choices={CHOICES}
          recent={[{ provider: "deepseek", model: "deepseek-v4-think" }]}
          onPick={vi.fn()}
          onPersistDefault={onPersistDefault}
        />,
      ),
    );
    act(() => {
      c
        .querySelector<HTMLElement>(".mroot .mi.mrec")!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(focusedGroup(c)).toBe("最近使用");
    // footer persists 会话当前模型，与浏览到哪个 pane 无关。
    const foot = c.querySelector<HTMLButtonElement>(".mpane .mi.foot");
    expect(foot?.textContent).toContain("设为默认");
    act(() => {
      foot!.click();
    });
    expect(onPersistDefault).toHaveBeenCalledTimes(1);
    expect(c.querySelector(".menu")).toBeNull();
    // 重开回自动焦点（当前供应商），不停在 recent。
    act(() => {
      c.querySelector<HTMLButtonElement>("button.chip")!.click();
    });
    expect(focusedGroup(c)).toBe("deepseek");
  });

  it("跨家 recent 行 onPick(model, provider) 对参数正确（走既有 /provider 路由），点击后关闭；当前模型行 isCurrent 高亮同语义", () => {
    const onPick = vi.fn();
    const c = openMenuOf(
      mount(
        <ModelSelector
          label="deepseek-v4-flash"
          provider="deepseek"
          choices={CHOICES}
          recent={[{ provider: "glm", model: "glm-5" }, { provider: "deepseek", model: "deepseek-v4-flash" }]}
          onPick={onPick}
        />,
      ),
    );
    linkRecent(c);
    // 跨家行（当前 deepseek → glm 行）：title 带缓存全冷警示（超越点①）。
    const crossRow = c.querySelector<HTMLButtonElement>('.mpane .mi[data-model="glm-5"][data-provider="glm"]');
    expect(crossRow?.getAttribute("title")).toContain("/provider glm");
    expect(crossRow?.getAttribute("title")).toContain("缓存全冷");
    act(() => {
      crossRow!.click();
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("glm-5", "glm");
    expect(c.querySelector(".menu")).toBeNull(); // closed after commit
    // 同家当前模型行 isCurrent：.on + aria-checked（重开看）。
    const c2 = openMenuOf(
      mount(
        <ModelSelector
          label="deepseek-v4-flash"
          provider="deepseek"
          choices={CHOICES}
          recent={[{ provider: "deepseek", model: "deepseek-v4-flash" }]}
          onPick={vi.fn()}
        />,
      ),
    );
    linkRecent(c2);
    const cur = c2.querySelector<HTMLElement>(".mpane .mi.on");
    expect(cur?.getAttribute("data-model")).toBe("deepseek-v4-flash");
    expect(cur?.getAttribute("aria-checked")).toBe("true");
  });

  it("矩阵滤层：recent 里矩阵不存在的 (provider, model) 对不渲染（死端点行不出现）；全死 → 虚拟组整行不渲染", () => {
    const c = openMenuOf(
      mount(
        <ModelSelector
          label="deepseek-v4-flash"
          provider="deepseek"
          choices={CHOICES}
          recent={[
            { provider: "zhipu", model: "glm-5" }, // 供应商不在矩阵
            { provider: "deepseek", model: "no-such-model" }, // 模型不在其组
            { provider: "glm", model: "glm-5" }, // 活
          ]}
          onPick={vi.fn()}
        />,
      ),
    );
    // 滤后 1 条：徽记「1 个」，右栏只有活条目。
    expect(c.querySelector(".mroot .mi.mrec")?.textContent).toContain("1 个");
    linkRecent(c);
    expect(c.querySelectorAll(".mpane .mi[data-model]")).toHaveLength(1);
    expect(c.querySelector(".mpane .mi[data-model]")?.getAttribute("data-model")).toBe("glm-5");
    // 全死：虚拟组整行不渲染（零渲染=零死端点）。
    const c2 = openMenuOf(
      mount(
        <ModelSelector
          label="deepseek-v4-flash"
          provider="deepseek"
          choices={CHOICES}
          recent={[{ provider: "zhipu", model: "gone" }]}
          onPick={vi.fn()}
        />,
      ),
    );
    expect(c2.querySelector(".mroot .mi.mrec")).toBeNull();
    expect(c2.querySelectorAll(".mroot .mi.mprov")).toHaveLength(4); // 纯供应商
    expect(focusedGroup(c2)).toBe("deepseek"); // 自动跟随不动
  });

  it("零喂=旧行为（recent 缺省/空数组）：无虚拟组行，左列纯供应商，census 语义零演进", () => {
    for (const recent of [undefined, []]) {
      const c = openMenuOf(
        mount(
          <ModelSelector
            label="deepseek-v4-flash"
            provider="deepseek"
            choices={CHOICES}
            onPick={vi.fn()}
            {...(recent !== undefined ? { recent } : {})}
          />,
        ),
      );
      expect(c.querySelector(".mroot .mi.mrec")).toBeNull();
      expect(c.querySelectorAll(".mroot .mi.mprov")).toHaveLength(4);
      expect(focusedGroup(c)).toBe("deepseek");
    }
  });
});

// ─── ③ 全 App harness（快照写点 + 透传渲染） ────────────────────────────────

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

function mountedApp(): Harness {
  const server = fakeServer();
  const client = new WudaoClient({
    url: "ws://127.0.0.1:1",
    token: "t",
    wsFactory: () => server.spawn(),
    reconnect: false,
  });
  const container = mount(<App client={client} />);
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  return { container, client, server };
}

type OpFrame = { id: number; op: { op: string; [k: string]: unknown } };
const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

/** settingsStatus → 高级壳层（uiDefaultMode 缺省 = advanced）。 */
async function replySettings(h: Harness): Promise<void> {
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true } },
    });
  });
}

/** authOk 式整帧 state（model 段换 (label, provider)；busy 可覆写）。 */
const MATRIX = [
  { provider: "deepseek", model: "deepseek-v4-flash", source: "profile" },
  { provider: "deepseek", model: "deepseek-v4-think", source: "profile" },
  { provider: "glm", model: "glm-5", source: "profile" },
];
const modelState = (label: string, provider: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  live: { reasoning: "", answer: "", busyTools: [] },
  busy: false,
  queued: [],
  boardProgress: null,
  ctxTokens: null,
  mode: "workspace",
  cachePercent: null,
  bg: { active: 0, spawned: 0 },
  pendingPermission: null,
  planBoard: null,
  sessionId: "wudao-test-0001",
  sidecar: null,
  model: { label, provider, choices: MATRIX },
  ...over,
});

describe("App 快照写点 + 透传 (ω99-218)", () => {
  it("boot 首观察播种当前模型（首见=在用），真实切换才 touch：快照实变 → 新对在头；A→B→A 挪头", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, modelState("glm-5", "glm"));
    });
    await replySettings(h);
    // boot 播种：从未主动切过也有 1 条（诚实边界④）。
    expect(readRecent()).toEqual([{ provider: "glm", model: "glm-5" }]);
    // 实变 → touch 新对在头。
    await act(async () => {
      h.server.socket.serverSend({ t: "state", state: modelState("deepseek-v4-flash", "deepseek") });
    });
    expect(readRecent()).toEqual([
      { provider: "deepseek", model: "deepseek-v4-flash" },
      { provider: "glm", model: "glm-5" },
    ]);
    // 同上家换型号也是实变。
    await act(async () => {
      h.server.socket.serverSend({ t: "state", state: modelState("deepseek-v4-think", "deepseek") });
    });
    expect(readRecent()[0]).toEqual({ provider: "deepseek", model: "deepseek-v4-think" });
    expect(readRecent()).toHaveLength(3);
    // A→B→A：切回 glm-5 → 挪头（不是追加第三条 glm）。
    await act(async () => {
      h.server.socket.serverSend({ t: "state", state: modelState("glm-5", "glm") });
    });
    expect(readRecent()).toEqual([
      { provider: "glm", model: "glm-5" },
      { provider: "deepseek", model: "deepseek-v4-think" },
      { provider: "deepseek", model: "deepseek-v4-flash" },
    ]);
  });

  it("快照不变零写：同模型的新 state 帧（busy 翻转——status 对象换了、{provider,model} 对没变）零落盘扰动；provider 缺位的 v1 形状不 touch", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, modelState("glm-5", "glm"));
    });
    await replySettings(h);
    const before = window.localStorage.getItem("wudao.recent-models.v1");
    // 同模型 busy 帧：status 身份变了、primitive deps 没变 → effect 不跑。
    await act(async () => {
      h.server.socket.serverSend({ t: "state", state: modelState("glm-5", "glm", { busy: true }) });
    });
    expect(readRecent()).toEqual([{ provider: "glm", model: "glm-5" }]);
    expect(window.localStorage.getItem("wudao.recent-models.v1")).toBe(before);
    // provider 缺位（protocol v1 形状）：无 lane 身份，不 touch。
    await act(async () => {
      h.server.socket.serverSend({ t: "state", state: { ...modelState("glm-5", "glm"), model: { label: "x", choices: MATRIX } } });
    });
    expect(readRecent()).toEqual([{ provider: "glm", model: "glm-5" }]);
  });

  it("封顶 5 经 App：预置 5 条后 boot 播种第 6 条 → 丢最旧（尾）、新对在头", async () => {
    writeRecent([
      { provider: "p2", model: "m2" },
      { provider: "p3", model: "m3" },
      { provider: "p4", model: "m4" },
      { provider: "glm", model: "glm-5" },
      { provider: "zhipu", model: "oldest-model" }, // 尾 = 最旧，注定出局
    ]);
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, modelState("deepseek-v4-flash", "deepseek"));
    });
    await replySettings(h);
    const after = readRecent();
    expect(after).toHaveLength(MAX_RECENT_MODELS);
    expect(after).toEqual([
      { provider: "deepseek", model: "deepseek-v4-flash" },
      { provider: "p2", model: "m2" },
      { provider: "p3", model: "m3" },
      { provider: "p4", model: "m4" },
      { provider: "glm", model: "glm-5" },
    ]);
    expect(after).not.toContainEqual({ provider: "zhipu", model: "oldest-model" }); // 最旧出局
  });

  it("透传渲染：App 喂 recent → 高级壳层选择器左列首位出虚拟组行，矩阵滤层在（死端点行不渲染）", async () => {
    window.localStorage.setItem("wudao.recent-models.v1", JSON.stringify({
      recent: [
        { provider: "zhipu", model: "gone" }, // 死端点
        { provider: "glm", model: "glm-5" }, // 活
      ],
    }));
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, modelState("deepseek-v4-flash", "deepseek"));
    });
    await replySettings(h);
    // boot 播种当前模型在头（首见=在用），滤层后活条目 = 当前 + glm-5。
    const chip = h.container.querySelector<HTMLButtonElement>(".chip.model");
    expect(chip).not.toBeNull();
    act(() => {
      chip!.click();
    });
    const rec = h.container.querySelector<HTMLElement>(".mroot .mi.mrec");
    expect(rec?.textContent).toContain("最近使用");
    expect(rec?.textContent).toContain("2 个");
    act(() => {
      rec!.click();
    });
    const paneRows = h.container.querySelectorAll<HTMLElement>(".mpane .mi[data-model]");
    expect(paneRows).toHaveLength(2);
    expect([...paneRows].map((r) => r.getAttribute("data-model"))).toEqual(["deepseek-v4-flash", "glm-5"]);
    expect(h.container.querySelector('.mpane .mi[data-model="gone"]')).toBeNull(); // 死端点不在
  });
});
