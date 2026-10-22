// @vitest-environment jsdom
// ω99-242: #12 — 被恢复会话对账面 R 件（R6）：「已验证完成 X / 待续 Y」从
// recoveryStatus 的结构化数据渲染（X/Y 是数出来的，不是编的）；无记录/老
// server 拒答=零渲染。全 App harness（ω99-213 recap receipts 式样）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { recoveryLineOf, RecoveryBanner } from "../src/components/RecoveryBanner.js";
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

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

afterEach(() => {
  act(() => {
    root?.unmount();
    root = null;
  });
  document.body.innerHTML = "";
});

describe("R6 recovery reconciliation line", () => {
  it("recoveryLineOf counts X/Y from the structured row — never fabricates", () => {
    expect(recoveryLineOf({ sessionId: "s1", state: "recovering", verifiedDone: 3, remaining: 2 })).toBe("已验证完成 3 / 待续 2");
    expect(recoveryLineOf({ sessionId: "s1", state: "recovering", verifiedDone: 0, remaining: 5 })).toBe("已验证完成 0 / 待续 5");
    // No counts yet (no settle) / all-zero / absent row → null (no banner).
    expect(recoveryLineOf({ sessionId: "s1", state: "tracked" })).toBeNull();
    expect(recoveryLineOf({ sessionId: "s1", state: "terminal", verifiedDone: 0, remaining: 0 })).toBeNull();
    expect(recoveryLineOf(undefined)).toBeNull();
  });

  it("RecoveryBanner renders exactly the one line", () => {
    const container = mount(<RecoveryBanner line="已验证完成 3 / 待续 2" />);
    const el = container.querySelector(".recovery-banner");
    expect(el?.getAttribute("role")).toBe("status");
    expect(el?.textContent).toBe("已验证完成 3 / 待续 2");
  });

  it("the App asks recoveryStatus and renders the CURRENT session's row", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "night-task" }, []);
    });
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    await act(async () => {
      for (const f of opFrames(h)) {
        if (f.op.op === "recoveryStatus") {
          h.server.socket.serverSend({
            t: "result",
            id: f.id,
            ok: [
              { sessionId: "other", state: "recovering", verifiedDone: 9, remaining: 9 },
              { sessionId: "night-task", state: "recovering", verifiedDone: 3, remaining: 2 },
            ],
          });
        }
      }
    });
    await until(
      () => h.container.textContent?.includes("已验证完成 3 / 待续 2") === true,
      "the reconciliation line renders",
    );
    // The OTHER session's row never leaks into this window's line.
    expect(h.container.textContent).not.toContain("已验证完成 9");
  }, 10_000);

  it("an old server's refusal (err) renders nothing — quiet, never an error surface", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "night-task" }, []);
    });
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    await act(async () => {
      for (const f of opFrames(h)) {
        if (f.op.op === "recoveryStatus") {
          h.server.socket.serverSend({ t: "result", id: f.id, err: "recovery not supported by this server" });
        }
      }
    });
    await wait(50);
    expect(h.container.querySelector(".recovery-banner")).toBeNull();
  }, 10_000);
});
