// @vitest-environment jsdom
// cc-plugins E3 (C2 minor) — the settings tab bar's a11y wiring: every
// role="tab" carries id + aria-controls naming its role="tabpanel", and each
// panel's aria-labelledby points back at its tab. Only the ACTIVE panel is
// mounted (the lazy-mount economy — plugin ops must not hit the wire until
// the 插件 tab opens), so the wiring is pinned across the settings-split's
// five tabs + persona-settings T6's Persona tab (SIX total): 供应商 on load,
// then each of 权限/外观/偏好/Persona/插件 after its switch.
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

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

interface Harness {
  container: HTMLElement;
  server: FakeServer;
  replyTo: (opName: string, ok: unknown) => Promise<void>;
}

async function mountedPage(onClose: () => void = () => {}): Promise<Harness> {
  const server = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  const container = mount(<SettingsPage client={client} status={null} onClose={onClose} />);
  const ops = () =>
    server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
    ) as { id: number; op: Record<string, unknown> }[];
  await act(async () => {
    const statusOp = ops().find((o) => o.op.op === "settingsStatus");
    server.socket.serverSend({ t: "result", id: statusOp?.id, ok: STATUS });
  });
  const replyTo = async (opName: string, ok: unknown): Promise<void> => {
    await act(async () => {
      const op = [...ops()].reverse().find((o) => o.op.op === opName);
      server.socket.serverSend({ t: "result", id: op?.id, ok });
    });
  };
  return { container, server, replyTo };
}

const tabBtn = (c: HTMLElement, name: string): HTMLButtonElement => {
  const b = c.querySelector(`button[data-settings-tab='${name}']`) as HTMLButtonElement | null;
  if (b === null) throw new Error(`tab ${name} missing`);
  return b;
};

/** The six tabs the settings page pins (供应商/权限/外观/偏好/Persona/插件 —
 *  spec §2's tab order + persona-settings T6's persona tab; plugins keeps
 *  its tail slot). */
const TAB_IDS = ["provider", "permissions", "appearance", "preferences", "persona", "mcp", "plugins"] as const;

/** The full wiring contract, checked against the panels currently mounted:
 * the SIX tabs each carry an id whose `settings-tab-{id}` pairs with an
 * `aria-controls="settings-panel-{id}"`; EXACTLY ONE panel is live (lazy
 * mount), it belongs to the aria-selected tab, and its aria-labelledby points
 * back at that tab with the pairing agreeing both ways. */
function expectWiring(c: HTMLElement): void {
  const tabs = [...c.querySelectorAll('[role="tab"]')] as HTMLElement[];
  expect(tabs.length).toBe(7);
  const panels = [...c.querySelectorAll('[role="tabpanel"]')] as HTMLElement[];
  expect(panels.length).toBe(1); // lazy: only the active panel mounts
  const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
  expect(selected.length).toBe(1);
  for (const tab of tabs) {
    expect(tab.id).toMatch(/^settings-tab-/);
    const controls = tab.getAttribute("aria-controls");
    expect(controls).toBe(tab.id.replace("settings-tab-", "settings-panel-"));
    // The SELECTED tab's panel must be mounted right now; every OTHER tab's
    // target must not be (the lazy-mount economy across all six).
    const panel = c.querySelector(`[role="tabpanel"][id="${controls}"]`);
    if (tab === selected[0]) {
      expect(panel).not.toBeNull();
    } else {
      expect(panel).toBeNull();
    }
  }
  const panel = panels[0] as HTMLElement;
  expect(panel.id).toMatch(/^settings-panel-/);
  const labelledBy = panel.getAttribute("aria-labelledby");
  expect(labelledBy).toMatch(/^settings-tab-/);
  const tab = c.querySelector(`[role="tab"][id="${labelledBy}"]`);
  expect(tab).not.toBeNull();
  expect(tab?.getAttribute("aria-controls")).toBe(panel.id); // the pair agrees both ways
}

describe("settings tab a11y — tab ↔ tabpanel wiring", () => {
  it("供应商 on load: the provider tab controls + labels the live tabpanel; the other five panels stay unmounted", async () => {
    const h = await mountedPage();
    expectWiring(h.container);
    expect(h.container.querySelector('#settings-panel-provider[role="tabpanel"]')).not.toBeNull();
    for (const id of TAB_IDS) {
      if (id === "provider") continue;
      expect(h.container.querySelector(`#settings-panel-${id}`)).toBeNull(); // lazy: not mounted yet
    }
    expect(tabBtn(h.container, "provider").getAttribute("aria-selected")).toBe("true");
    expect(tabBtn(h.container, "plugins").getAttribute("aria-controls")).toBe("settings-panel-plugins");
  });

  it("权限/外观/偏好/Persona after the switch: each becomes the live tabpanel, same two-way wiring", async () => {
    const h = await mountedPage();
    for (const id of ["permissions", "appearance", "preferences", "persona", "mcp"] as const) {
      await act(async () => {
        tabBtn(h.container, id).click();
      });
      // The persona tab fires personaList on mount — reply so its fetch
      // settles inside the act window (the panel renders either way).
      if (id === "persona") await h.replyTo("personaList", { personas: [] });
      // The MCP tab fires mcpList on mount — same settle-inside-act rule.
      if (id === "mcp") await h.replyTo("mcpList", { servers: [], warnings: [], files: { user: "/u", root: "/r", project: "/p" } });
      expectWiring(h.container);
      expect(h.container.querySelector(`#settings-panel-${id}[role="tabpanel"]`)).not.toBeNull();
      for (const other of TAB_IDS) {
        if (other === id) continue;
        expect(h.container.querySelector(`#settings-panel-${other}`)).toBeNull(); // swapped out
      }
      expect(tabBtn(h.container, id).id).toBe(`settings-tab-${id}`);
      expect(h.container.querySelector(`#settings-panel-${id}`)?.getAttribute("aria-labelledby")).toBe(`settings-tab-${id}`);
    }
  });

  it("插件 after the switch: the plugins panel is the live tabpanel, same two-way wiring", async () => {
    const h = await mountedPage();
    await act(async () => {
      tabBtn(h.container, "plugins").click();
    });
    await h.replyTo("pluginList", { installed: [] });
    await h.replyTo("pluginMarketList", { marketplaces: [] });
    expectWiring(h.container);
    expect(h.container.querySelector('#settings-panel-plugins[role="tabpanel"]')).not.toBeNull();
    for (const id of TAB_IDS) {
      if (id === "plugins") continue;
      expect(h.container.querySelector(`#settings-panel-${id}`)).toBeNull(); // swapped out
    }
    expect(tabBtn(h.container, "plugins").id).toBe("settings-tab-plugins");
    expect(h.container.querySelector('#settings-panel-plugins')?.getAttribute("aria-labelledby")).toBe("settings-tab-plugins");
  });
});

// —— tokfinish §6 (appaudit §1.1 交互缺口): the tablist's WAI-ARIA tabs
// keyboard contract — ArrowLeft/ArrowRight move focus AND activate
// (selection follows focus; the panel swaps through the same lazy mount),
// Home/End jump to the ends, and the page-level Esc contract is untouched
// (the arrows never close the page; Esc still does).
describe("settings tab a11y — ←/→ 方向键漫游", () => {
  const key = (el: Element, k: string): void => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  };
  /** One hop: dispatch the key on the CURRENT tab button, then assert the
   * selection moved to `to`, DOM focus followed it, and the two-way panel
   * wiring rode along (the lazy mount swapped). */
  const hop = (h: { container: HTMLElement }, from: string, k: string, to: string): void => {
    act(() => {
      key(tabBtn(h.container, from), k);
    });
    expect(tabBtn(h.container, to).getAttribute("aria-selected"), `${k} ${from}→${to}`).toBe("true");
    expect(document.activeElement).toBe(tabBtn(h.container, to)); // focus follows activation
    expectWiring(h.container); // the live tabpanel swapped to `to`
    expect(h.container.querySelector(`#settings-panel-${to}[role="tabpanel"]`)).not.toBeNull();
  };

  it("ArrowRight roams + activates: two hops 供应商→权限→外观, focus and the live panel following", async () => {
    const h = await mountedPage();
    hop(h, "provider", "ArrowRight", "permissions");
    hop(h, "permissions", "ArrowRight", "appearance");
  });

  it("ArrowLeft roams back: two hops 外观→权限→供应商, and wraps 供应商→插件 at the left edge", async () => {
    const h = await mountedPage();
    // park on 外观 first (the ArrowRight leg above proved forward motion)
    await act(async () => {
      tabBtn(h.container, "appearance").click();
    });
    hop(h, "appearance", "ArrowLeft", "permissions");
    hop(h, "permissions", "ArrowLeft", "provider");
    // the left edge wraps to the tail slot (插件) — the WAI-ARIA optional
    // wrap behavior this implementation chose.
    hop(h, "provider", "ArrowLeft", "plugins");
    // the 插件 panel mounted through the roam — settle its fetches inside
    // the act window (the panel renders either way, same as the click test).
    await h.replyTo("pluginList", { installed: [] });
    await h.replyTo("pluginMarketList", { marketplaces: [] });
  });

  it("Home/End jump to the strip's ends (the optional contract halves)", async () => {
    const h = await mountedPage();
    hop(h, "provider", "End", "plugins");
    await h.replyTo("pluginList", { installed: [] });
    await h.replyTo("pluginMarketList", { marketplaces: [] });
    hop(h, "plugins", "Home", "provider");
  });

  it("the roam keys never close the page; Esc still does (the page-level contract is untouched)", async () => {
    const onClose = vi.fn();
    const h = await mountedPage(onClose);
    for (const k of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      act(() => {
        key(tabBtn(h.container, "provider"), k);
      });
    }
    expect(onClose).not.toHaveBeenCalled(); // roaming is not dismissal
    expect(h.container.querySelector(".settings-page")).not.toBeNull();
    act(() => {
      key(h.container.querySelector(".settings-page") as HTMLElement, "Escape");
    });
    expect(onClose).toHaveBeenCalledTimes(1); // Esc 关页照旧
  });
});
