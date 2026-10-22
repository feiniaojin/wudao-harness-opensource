// ω99-225: #R3 — resume toast 三分支真话化：outcome 对象过线后 onPickSession
// 不再拿布尔猜。钉三分支渲染：
//   ok        静默——无「不存在」、无「占用」toast；
//   not_found 保留原文案「(会话不存在 —— 可能已被删除)」；
//   occupied  「⚠️ 会话正被另一个 wudao 进程（#<pid>）占用——请关闭旧窗口，
//             或稍候重试」——行动指引文案，含 #pid，不出现 lease 术语。
// 走 📋 picker 的真 Enter→resume 线（侧栏行点击汇入同缝 onPickSession）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
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
const click = (el: Element | null | undefined): void => {
  act(() => {
    el?.dispatchEvent(new Event("click", { bubbles: true }));
  });
};
/** A keydown on the picker overlay（Enter 选中行 → onPickSession → resume op）。 */
const key = (el: Element | null | undefined, k: string): void => {
  act(() => {
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
});

interface Entry {
  name: string;
  type: "file" | "dir";
  size?: number;
  hidden?: boolean;
}

interface SessionRowLike {
  id: string;
  mtime: string;
  messages: number;
  firstUser: string;
  model: string;
  name?: string;
}

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
  answered: Set<number>;
  sessionRows: SessionRowLike[];
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
  return { container, client, server, answered: new Set<number>(), sessionRows: [] };
}

const opFrames = (h: Harness): { id: number; op: Record<string, unknown> }[] =>
  h.server
    .clientFrames()
    .filter((f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in f && "id" in f);

async function drain(h: Harness, listing: Record<string, readonly Entry[]>): Promise<void> {
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      if (f.op.op === "fileTree") {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: { entries: listing[f.op.path as string] ?? [] } });
      } else if (f.op.op === "settingsStatus") {
        h.server.socket.serverSend({
          t: "result",
          id: f.id,
          ok: {
            providers: [],
            credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
            settings: {
              memoryEnabled: false,
              uiDefaultMode: null,
              wizardCompletedVersion: 1,
              uiTheme: null,
              uiAccent: null,
            },
            current: { provider: "deepseek", model: "deepseek-chat" },
            envKey: false,
            readiness: false,
            efforts: [],
          },
        });
      } else if (f.op.op === "sessions") {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: h.sessionRows });
      } else {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: [] });
      }
    }
  });
}

async function connectedApp(listing: Record<string, readonly Entry[]>): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await drain(h, listing);
  await drain(h, {});
  return h;
}

const ROW: SessionRowLike = {
  id: "o225aaaa-1111-2222-3333-444444444444",
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 3,
  firstUser: "fix the login bug",
  model: "deepseek-chat",
};

/** 打开 📋 picker → Enter 首行 → resume op 已上线；用给定的 ok 载荷应答。 */
async function pickAndReply(h: Harness, ok: unknown): Promise<void> {
  h.sessionRows = [ROW];
  click(h.container.querySelector(".topbar .sessions"));
  await drain(h, {});
  const pop = h.container.querySelector(".search-pop");
  expect(pop).not.toBeNull();
  key(pop, "Enter");
  const resume = opFrames(h).find((o) => o.op.op === "resume");
  expect(resume?.op).toMatchObject({ id: ROW.id });
  await act(async () => {
    h.server.socket.serverSend({ t: "result", id: resume?.id, ok });
  });
}

describe("ω99-225 resume toast 三分支（onPickSession 消费 ResumeOutcome）", () => {
  it("ok → 静默：两个 toast 文案都不出现", async () => {
    const h = await connectedApp({});
    await pickAndReply(h, { ok: true });
    expect(h.container.textContent).not.toContain("会话不存在");
    expect(h.container.textContent).not.toContain("占用");
  });

  it("not_found → 保留原文案", async () => {
    const h = await connectedApp({});
    await pickAndReply(h, { ok: false, reason: "not_found" });
    expect(h.container.textContent).toContain("(会话不存在 —— 可能已被删除)");
    expect(h.container.textContent).not.toContain("占用");
  });

  it("occupied → 行动指引文案（#pid 在场，无 lease 术语）", async () => {
    const h = await connectedApp({});
    await pickAndReply(h, { ok: false, reason: "occupied", holderPid: 4242 });
    expect(h.container.textContent).toContain("⚠️ 会话正被另一个 wudao 进程（#4242）占用——请关闭旧窗口，或稍候重试");
    expect(h.container.textContent).not.toContain("会话不存在");
  });
});
