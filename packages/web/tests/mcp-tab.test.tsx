// @vitest-environment jsdom
// McpTab — the settings page's MCP tab (MCP visibility): the three-tier
// grouped list over mcpList, tier hints with file paths, the runtime status
// lane (已连接 / 连接失败 / 未连接-懒加载), replacement receipts, and the
// degrade paths (old server → 升级 wudao 后可用; load failure → inline
// error). Same fake-ws harness idiom as the tabpanel tests.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import { McpTab } from "../src/components/McpTab.js";
import { authOk, fakeServer } from "./mock-ws.js";

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

const LIST_OK = {
  servers: [
    { name: "MiniMax", tier: "user", transport: "stdio", command: "uvx minimax-coding-plan-mcp", replaces: [], connected: true, tools: 2 },
    { name: "shared", tier: "project", transport: "stdio", command: "node s.mjs", replaces: ["user"], connected: false, tools: 0 },
    { name: "remote", tier: "root", transport: "http", command: "https://x.example.com/mcp", replaces: [], connected: false, tools: 0, failure: "handshake timeout" },
  ],
  warnings: [],
  files: { user: "/home/u/.wudao/mcp.json", root: "/ws/.mcp.json", project: "/ws/.wudao/mcp.json" },
};

/** Mount McpTab on a fake server; `answer` resolves the pending mcpList
 *  (ok payload or an err string — the degrade paths). */
async function mountedTab(answer: { ok: unknown } | { err: string }): Promise<HTMLElement> {
  const server = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  const container = mount(<McpTab client={client} />);
  const ops = () =>
    server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
    ) as { id: number; op: Record<string, unknown> }[];
  await act(async () => {
    const op = [...ops()].reverse().find((o) => o.op.op === "mcpList");
    server.socket.serverSend("ok" in answer ? { t: "result", id: op?.id, ok: answer.ok } : { t: "result", id: op?.id, err: answer.err });
  });
  return container;
}

const text = (c: HTMLElement, selector: string): string =>
  (c.querySelector(selector) as HTMLElement | null)?.textContent ?? "";

describe("McpTab — the settings page's MCP list", () => {
  it("groups every tier with its file path, the status lane, and replacement receipts", async () => {
    const c = await mountedTab({ ok: LIST_OK });
    // The three tier groups, each naming its config file.
    expect(c.querySelectorAll('[data-mcp-tier="user"], [data-mcp-tier="root"], [data-mcp-tier="project"]').length).toBe(3);
    expect(text(c, '[data-mcp-tier="user"] .group-title')).toContain("/home/u/.wudao/mcp.json");
    expect(text(c, '[data-mcp-tier="root"] .group-title')).toContain("/ws/.mcp.json");
    expect(text(c, '[data-mcp-tier="project"] .group-title')).toContain("/ws/.wudao/mcp.json");
    // Rows land in their tier's group.
    expect(c.querySelector('[data-mcp-tier="user"] [data-mcp-server="MiniMax"]')).not.toBeNull();
    expect(c.querySelector('[data-mcp-tier="root"] [data-mcp-server="remote"]')).not.toBeNull();
    expect(c.querySelector('[data-mcp-tier="project"] [data-mcp-server="shared"]')).not.toBeNull();
    // The runtime status lane: connected with tools; lazy-load 未连接 (not an
    // error); a failure row surfaces the reason.
    expect(text(c, '[data-mcp-status="MiniMax"]')).toContain("已连接 · 2 个工具");
    expect(text(c, '[data-mcp-status="shared"]')).toContain("未连接");
    expect(text(c, '[data-mcp-status="remote"]')).toContain("连接失败 · handshake timeout");
    // The command line is the process-visible string (env/headers never ride).
    expect(text(c, '[data-mcp-server="MiniMax"]')).toContain("uvx minimax-coding-plan-mcp");
    // Replacement receipt: the project entry names what it replaced.
    expect(text(c, '[data-mcp-server="shared"]')).toContain("替换了用户级的同名配置");
    // No secrets lane anywhere in the tab.
    expect(c.textContent ?? "").not.toContain("MINIMAX_API_KEY");
  });

  it("empty config → the where-to-add hint (three files named)", async () => {
    const c = await mountedTab({ ok: { servers: [], warnings: [], files: LIST_OK.files } });
    expect(c.textContent ?? "").toContain("尚未配置任何 MCP 服务器");
    expect(c.querySelectorAll('[data-mcp-server]').length).toBe(0);
  });

  it("an unrouted op (old server) → 升级 wudao 后可用, no error noise", async () => {
    const c = await mountedTab({ err: "unknown op: mcpList" });
    expect(c.textContent ?? "").toContain("升级 wudao 后可用");
    expect(c.querySelector(".entry-error")).toBeNull();
  });

  it("a load failure → the inline error row", async () => {
    const c = await mountedTab({ err: "boom" });
    expect(c.textContent ?? "").toContain("无法读取 MCP 配置:boom");
  });
});
