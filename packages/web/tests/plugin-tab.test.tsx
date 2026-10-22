// @vitest-environment jsdom
// cc-plugins C2 — the settings page's 插件 tab: tab switching (plugin ops
// only fire when the tab opens), market add (source input → op on the wire →
// list refresh), the Discover list (selected market's entries: name /
// description / version / 将安装 detail counts; git sources render —),
// install with the user/project scope pick, the installed list's
// enable/disable/uninstall op shapes, the busy-refusal error string rendered
// VERBATIM (the 「⚠️ 运行中无法 …」 family already carries its own prefix),
// and the old-server degradation (op missing → 升级 wudao 后可用).
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { SettingsStatus } from "../src/protocol.js";
import { SettingsPage } from "../src/components/SettingsPage.js";
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

function type(el: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

// The settingsStatus fixture the page asks for on open (provider cards etc.
// live on the 常规 tab — the tab bar must keep them there untouched).
const STATUS: SettingsStatus = {
  providers: [
    { provider: "deepseek", label: "deepseek", status: "ready", keySource: "env", endpoint: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", custom: false, models: []},
  ],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
  settings: { memoryEnabled: true, uiDefaultMode: "advanced", wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: ["low", "medium", "high", "max", "none"],
};

const MARKETS = {
  marketplaces: [
    {
      name: "cc-market",
      source: "/tmp/fx/cc-market",
      addedAt: "2026-08-21T00:00:00.000Z",
      description: "fixture market",
      plugins: [
        { name: "alpha", description: "全类目夹具插件", version: "1.2.0", detail: { skills: 1, commands: 1, agents: 0, hooks: 1, mcp: 1 } },
        { name: "beta", description: "裸 manifest 插件", detail: null },
      ],
    },
    {
      name: "git-market",
      source: "https://github.com/o/r",
      addedAt: "2026-08-21T00:00:00.000Z",
      plugins: [{ name: "gamma", version: "0.1.0", detail: null }],
    },
  ],
};

const INSTALLED = {
  installed: [
    { id: "alpha@cc-market", name: "alpha", market: "cc-market", scope: "user", enabled: true, version: "1.2.0" },
    { id: "toolkit@cc-market", name: "toolkit", market: "cc-market", scope: "project", enabled: false },
  ],
};

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

function connectedClient(server: FakeServer): WudaoClient {
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  return client;
}

function opsOf(server: FakeServer): { id: number; op: Record<string, unknown> }[] {
  return server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
    typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
  ) as { id: number; op: Record<string, unknown> }[];
}

/** Answer the LATEST op of a name (replies to an already-answered id are
 *  dropped by the client, so refresh rounds answer their own new op). */
const replyTo = async (server: FakeServer, opName: string, ok: unknown): Promise<void> => {
  await act(async () => {
    const op = [...opsOf(server)].reverse().find((o) => o.op.op === opName);
    server.socket.serverSend({ t: "result", id: op?.id, ok });
  });
};

const replyErr = async (server: FakeServer, opName: string, err: string): Promise<void> => {
  await act(async () => {
    const op = [...opsOf(server)].reverse().find((o) => o.op.op === opName);
    server.socket.serverSend({ t: "result", id: op?.id, err });
  });
};

/** Answer a mutation's refresh round (the newest pluginList + pluginMarketList). */
const replyBoth = async (server: FakeServer, markets: unknown = MARKETS, installed: unknown = INSTALLED): Promise<void> => {
  await replyTo(server, "pluginList", installed);
  await replyTo(server, "pluginMarketList", markets);
};

async function mountedPage(): Promise<Harness> {
  const server = fakeServer();
  const client = connectedClient(server);
  const container = mount(<SettingsPage client={client} status={null} onClose={() => {}} />);
  await act(async () => {
    const statusOp = opsOf(server).find((o) => o.op.op === "settingsStatus");
    server.socket.serverSend({ t: "result", id: statusOp?.id, ok: STATUS });
  });
  return { container, client, server };
}

const tabBtn = (c: HTMLElement, name: string): HTMLButtonElement => {
  const b = c.querySelector(`button[data-settings-tab='${name}']`) as HTMLButtonElement | null;
  if (b === null) throw new Error(`tab ${name} missing`);
  return b;
};

/** Open the 插件 tab and answer its initial pluginList + pluginMarketList. */
async function pluginTab(markets: unknown = MARKETS, installed: unknown = INSTALLED): Promise<Harness> {
  const h = await mountedPage();
  await act(async () => {
    tabBtn(h.container, "plugins").click();
  });
  await replyBoth(h.server, markets, installed);
  return h;
}

const btnByText = (scope: HTMLElement, text: string): HTMLButtonElement => {
  const b = [...scope.querySelectorAll("button")].find((x) => x.textContent === text);
  if (b === undefined) throw new Error(`button "${text}" missing`);
  return b as HTMLButtonElement;
};

describe("tab switching", () => {
  it("默认供应商页签:现有分区原样;插件 ops 不上线(懒加载——开页签才发)", async () => {
    const h = await mountedPage();
    expect(h.container.querySelector(".settings-tabs")).not.toBeNull();
    expect(tabBtn(h.container, "provider").getAttribute("aria-selected")).toBe("true");
    expect(h.container.textContent).toContain("供应商");
    // settings-split: 偏好 is its own tab now — route through it.
    await act(async () => {
      tabBtn(h.container, "preferences").click();
    });
    expect(h.container.textContent).toContain("偏好");
    expect(h.container.querySelector("[data-plugin-tab]")).toBeNull();
    expect(opsOf(h.server).some((o) => String(o.op.op).startsWith("plugin"))).toBe(false);
  });

  it("插件页签挂载即拉两端列表;其余分区隐藏;切回恢复", async () => {
    const h = await pluginTab();
    expect(tabBtn(h.container, "plugins").getAttribute("aria-selected")).toBe("true");
    expect(opsOf(h.server).find((o) => o.op.op === "pluginList")).toBeDefined();
    expect(opsOf(h.server).find((o) => o.op.op === "pluginMarketList")).toBeDefined();
    expect(h.container.querySelector("[data-plugin-tab]")).not.toBeNull();
    // settings-split: the five tab LABELS always ride the nav, so "hidden" is
    // asserted on the panels/cards, not the container text.
    expect(h.container.querySelector("#settings-panel-provider")).toBeNull(); // other tabs' sections hidden
    expect(h.container.querySelector(".provider-card")).toBeNull();
    expect(h.container.querySelector("[data-default-mode]")).toBeNull();
    expect(h.container.textContent).toContain("cc-market"); // the data landed
    await act(async () => {
      tabBtn(h.container, "provider").click();
    });
    expect(h.container.querySelector("#settings-panel-provider")).not.toBeNull();
    expect(h.container.querySelector(".provider-card")).not.toBeNull();
    expect(h.container.querySelector("[data-plugin-tab]")).toBeNull();
  });
});

describe("marketplace management", () => {
  it("添加:源输入 → pluginMarketAdd(source) → 成功回执 + 列表刷新出新市场行", async () => {
    const h = await pluginTab();
    const input = h.container.querySelector("input.market-source-input") as HTMLInputElement;
    await act(async () => {
      type(input, "/tmp/fx/new-market");
    });
    await act(async () => {
      btnByText(h.container, "添加市场").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "pluginMarketAdd");
    expect(op?.op).toMatchObject({ source: "/tmp/fx/new-market" });
    await replyTo(h.server, "pluginMarketAdd", { name: "new-market", source: "/tmp/fx/new-market", addedAt: "2026-08-21T01:00:00.000Z" });
    expect(h.container.textContent).toContain("已添加市场 new-market");
    expect((h.container.querySelector("input.market-source-input") as HTMLInputElement).value).toBe(""); // cleared
    const WITH_NEW = {
      marketplaces: [
        ...MARKETS.marketplaces,
        { name: "new-market", source: "/tmp/fx/new-market", addedAt: "2026-08-21T01:00:00.000Z", plugins: [] },
      ],
    };
    await replyBoth(h.server, WITH_NEW);
    expect(h.container.querySelector(".market-row[data-market='new-market']")).not.toBeNull();
  });

  it("坏源引擎错误 → ⚠️ 前缀 notice;pending 期间按钮禁用 + 处理中标记", async () => {
    const h = await pluginTab();
    const input = h.container.querySelector("input.market-source-input") as HTMLInputElement;
    await act(async () => {
      type(input, "/no/such/dir");
    });
    await act(async () => {
      btnByText(h.container, "添加市场").click();
    });
    // Pending state: the op is unanswered — the button is disabled and the
    // busy marker shows (no silent in-flight).
    expect(btnByText(h.container, "添加市场").disabled).toBe(true);
    expect(h.container.querySelector("[data-plugin-tab]")?.textContent).toContain("处理中");
    await replyErr(h.server, "pluginMarketAdd", "invalid-source: 无法解析市场源: /no/such/dir");
    expect(h.container.textContent).toContain("⚠️ invalid-source: 无法解析市场源");
    expect(h.container.querySelector(".market-row[data-market='new-market']")).toBeNull(); // nothing landed
  });

  it("更新/移除 op 形状;移除回执带连带卸载名单 + 热重扫", async () => {
    const h = await pluginTab();
    const row = h.container.querySelector(".market-row[data-market='cc-market']") as HTMLElement;
    await act(async () => {
      btnByText(row, "更新").click();
    });
    expect(opsOf(h.server).find((o) => o.op.op === "pluginMarketUpdate")?.op).toMatchObject({ name: "cc-market" });
    await replyTo(h.server, "pluginMarketUpdate", { name: "cc-market", source: "/tmp/fx/cc-market", addedAt: "2026-08-21T02:00:00.000Z" });
    expect(h.container.textContent).toContain("cc-market 已更新");
    await replyBoth(h.server); // the update's refresh round (buttons stay frozen until it lands)
    await act(async () => {
      btnByText(row, "移除").click();
    });
    expect(opsOf(h.server).find((o) => o.op.op === "pluginMarketRemove")?.op).toMatchObject({ name: "cc-market" });
    await replyTo(h.server, "pluginMarketRemove", {
      removedPlugins: ["alpha@cc-market"],
      warnings: [],
      rescan: { skills: 2, plugins: 0, hooks: 1 },
    });
    expect(h.container.textContent).toContain("已移除市场 cc-market");
    expect(h.container.textContent).toContain("连带卸载");
    expect(h.container.textContent).toContain("alpha@cc-market");
  });

  it("移除的 busy 拒绝:服务器 err 串原样渲染(不叠 ⚠️ 前缀)", async () => {
    const h = await pluginTab();
    const row = h.container.querySelector(".market-row[data-market='cc-market']") as HTMLElement;
    await act(async () => {
      btnByText(row, "移除").click();
    });
    await replyErr(h.server, "pluginMarketRemove", "⚠️ 运行中无法移除市场(任务进行中)");
    expect(h.container.textContent).toContain("⚠️ 运行中无法移除市场(任务进行中)");
    expect(h.container.textContent).not.toContain("⚠️ ⚠️");
  });
});

describe("discover + install", () => {
  it("选中市场的条目:名称/描述/版本/将安装明细计数;git 源 detail=null 渲「—」", async () => {
    const h = await pluginTab();
    // First market selected by default.
    expect(h.container.querySelectorAll(".plugin-entry").length).toBe(2);
    const alpha = h.container.querySelector(".plugin-entry[data-plugin='alpha']") as HTMLElement;
    expect(alpha.textContent).toContain("全类目夹具插件");
    expect(alpha.textContent).toContain("1.2.0");
    expect(alpha.textContent).toContain("技能 1");
    expect(alpha.textContent).toContain("命令 1");
    expect(alpha.textContent).toContain("钩子 1");
    expect(alpha.textContent).toContain("MCP 1");
    const beta = h.container.querySelector(".plugin-entry[data-plugin='beta']") as HTMLElement;
    expect(beta.textContent).toContain("—");
    // Selecting the other market swaps the list.
    await act(async () => {
      (h.container.querySelector("button[data-market-select='git-market']") as HTMLButtonElement).click();
    });
    expect(h.container.querySelector(".plugin-entry[data-plugin='gamma']")).not.toBeNull();
    expect(h.container.querySelector(".plugin-entry[data-plugin='alpha']")).toBeNull();
  });

  it("安装:默认 user 作用域;切 project 后 op 携带;成功回执带明细+热重扫;已装列表刷新", async () => {
    const h = await pluginTab();
    await act(async () => {
      (h.container.querySelector("button[data-install='alpha@cc-market']") as HTMLButtonElement).click();
    });
    expect(opsOf(h.server).find((o) => o.op.op === "pluginInstall")?.op).toMatchObject({
      name: "alpha",
      market: "cc-market",
      scope: "user",
    });
    const DETAIL = { skills: 1, commands: 1, agents: 0, hooks: 1, mcp: 1 };
    await replyTo(h.server, "pluginInstall", {
      dir: "/home/u/.wudao/plugins/alpha",
      detail: DETAIL,
      warnings: [],
      rescan: { skills: 3, plugins: 1, hooks: 2 },
    });
    expect(h.container.textContent).toContain("已安装 alpha@cc-market");
    expect(h.container.textContent).toContain("技能 3 · 插件 1 · 钩子 2"); // the rescan receipt
    await replyBoth(h.server, MARKETS, { installed: INSTALLED.installed }); // the refresh round
    // Now the project pick rides the op.
    await act(async () => {
      (h.container.querySelector("button[data-scope='project']") as HTMLButtonElement).click();
    });
    await act(async () => {
      (h.container.querySelector("button[data-install='beta@cc-market']") as HTMLButtonElement).click();
    });
    const ops = opsOf(h.server).filter((o) => o.op.op === "pluginInstall");
    expect(ops[ops.length - 1]?.op).toMatchObject({ name: "beta", market: "cc-market", scope: "project" });
  });

  it("安装回包的 warnings 逐条呈现(不吞)", async () => {
    const h = await pluginTab();
    await act(async () => {
      (h.container.querySelector("button[data-install='alpha@cc-market']") as HTMLButtonElement).click();
    });
    await replyTo(h.server, "pluginInstall", {
      dir: "/home/u/.wudao/plugins/alpha",
      detail: { skills: 0, commands: 0, agents: 0, hooks: 0, mcp: 1 },
      warnings: ["⚠️ hooks 载入失败:脚本不可执行"],
      rescan: undefined,
    });
    expect(h.container.textContent).toContain("⚠️ hooks 载入失败:脚本不可执行");
  });
});

describe("installed list", () => {
  it("按作用域分组;启停/卸载 op 形状;回执带热重扫", async () => {
    const h = await pluginTab();
    const userGroup = h.container.querySelector(".installed-group[data-scope='user']") as HTMLElement;
    const projGroup = h.container.querySelector(".installed-group[data-scope='project']") as HTMLElement;
    expect(userGroup.textContent).toContain("用户");
    expect(userGroup.querySelector(".installed-row[data-plugin-id='alpha@cc-market']")).not.toBeNull();
    expect(projGroup.querySelector(".installed-row[data-plugin-id='toolkit@cc-market']")).not.toBeNull();
    // Enabled badge per row.
    const alphaRow = userGroup.querySelector(".installed-row[data-plugin-id='alpha@cc-market']") as HTMLElement;
    expect(alphaRow.textContent).toContain("已启用");
    expect(projGroup.textContent).toContain("已停用");
    // 停用 (enabled row → disable op).
    await act(async () => {
      btnByText(alphaRow, "停用").click();
    });
    expect(opsOf(h.server).find((o) => o.op.op === "pluginDisable")?.op).toMatchObject({ id: "alpha@cc-market" });
    await replyTo(h.server, "pluginDisable", { id: "alpha@cc-market", enabled: false, rescan: { skills: 2, plugins: 1, hooks: 0 } });
    expect(h.container.textContent).toContain("已停用 alpha@cc-market");
    await replyBoth(h.server); // the disable's refresh round
    // 启用 (disabled row → enable op).
    const toolkitRow = projGroup.querySelector(".installed-row[data-plugin-id='toolkit@cc-market']") as HTMLElement;
    await act(async () => {
      btnByText(toolkitRow, "启用").click();
    });
    expect(opsOf(h.server).find((o) => o.op.op === "pluginEnable")?.op).toMatchObject({ id: "toolkit@cc-market" });
    await replyTo(h.server, "pluginEnable", { id: "toolkit@cc-market", enabled: true, rescan: { skills: 3, plugins: 1, hooks: 0 } });
    expect(h.container.textContent).toContain("已启用 toolkit@cc-market");
    await replyBoth(h.server); // the enable's refresh round
    // 卸载.
    await act(async () => {
      btnByText(toolkitRow, "卸载").click();
    });
    expect(opsOf(h.server).find((o) => o.op.op === "pluginUninstall")?.op).toMatchObject({ id: "toolkit@cc-market" });
    await replyTo(h.server, "pluginUninstall", { id: "toolkit@cc-market", warnings: [], rescan: { skills: 2, plugins: 0, hooks: 0 } });
    expect(h.container.textContent).toContain("已卸载 toolkit@cc-market");
  });

  it("卸载的 busy 拒绝:服务器 err 串原样渲染", async () => {
    const h = await pluginTab();
    const row = h.container.querySelector(".installed-row[data-plugin-id='alpha@cc-market']") as HTMLElement;
    await act(async () => {
      btnByText(row, "卸载").click();
    });
    await replyErr(h.server, "pluginUninstall", "⚠️ 运行中无法卸载插件(任务进行中)");
    expect(h.container.textContent).toContain("⚠️ 运行中无法卸载插件(任务进行中)");
    expect(h.container.querySelector(".installed-row[data-plugin-id='alpha@cc-market']")).not.toBeNull(); // list unchanged
  });

  it("空已装列表有空态文案", async () => {
    const h = await pluginTab(MARKETS, { installed: [] });
    expect(h.container.querySelector("[data-plugin-tab]")?.textContent).toContain("尚未安装插件");
  });
});

describe("old-server degradation", () => {
  it("op 未路由(unknown op)→ 升级 wudao 后可用 降级文案,无操作面", async () => {
    const h = await mountedPage();
    await act(async () => {
      tabBtn(h.container, "plugins").click();
    });
    await replyErr(h.server, "pluginList", "unknown op: pluginList");
    await replyErr(h.server, "pluginMarketList", "unknown op: pluginMarketList");
    expect(h.container.textContent).toContain("升级 wudao 后可用");
    expect(h.container.querySelector("input.market-source-input")).toBeNull();
    expect(h.container.querySelector(".market-row")).toBeNull();
    expect(h.container.querySelector(".installed-group")).toBeNull();
  });

  it("驱动缺 handler(plugin ops not supported)同样降级", async () => {
    const h = await mountedPage();
    await act(async () => {
      tabBtn(h.container, "plugins").click();
    });
    await replyErr(h.server, "pluginList", "plugin ops not supported by this driver");
    expect(h.container.textContent).toContain("升级 wudao 后可用");
  });

  it("非降级错误(引擎失败)→ 常规错误文案,不是升级提示", async () => {
    const h = await mountedPage();
    await act(async () => {
      tabBtn(h.container, "plugins").click();
    });
    await replyErr(h.server, "pluginList", "registry: 市场登记文件不可读");
    expect(h.container.textContent).toContain("无法读取插件列表");
    expect(h.container.textContent).not.toContain("升级 wudao 后可用");
  });
});
