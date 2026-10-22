// @vitest-environment jsdom
// ω99-248: #3 — web「等你决定」晨间状态面 R 件（R5）：权限挂起会话的
// recoveryStatus 行携带 permissionAsk 证据 → 当前会话渲染晨间状态行（收益向
// 文案逐字钉）；行落定（settle/证据撤）→ 状态行消失（241 横幅语义家族）；老
// server 拒答（recoveryStatus err）→ 零渲染零报错面。全 App harness（242
// recovery-line 式样，mock-ws 全 mock 零真网络）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient, type RecoveryStatusRowWire } from "../src/protocol.js";
import { morningLineOf, MorningBanner } from "../src/components/RecoveryBanner.js";
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

const ASK = { toolName: "shell", summary: "./nightly.sh", question: "允许 shell：./nightly.sh？" };
const blockedRow = (sessionId: string): RecoveryStatusRowWire =>
  ({ sessionId, state: "blocked", permissionAsk: ASK }) as RecoveryStatusRowWire;

/** Reply to every pending recoveryStatus frame with `rows` (the 5s poll re-asks). */
const replyRecovery = (h: Harness, rows: readonly unknown[] | "err"): void => {
  act(() => {
    for (const f of opFrames(h)) {
      if (f.op.op === "recoveryStatus") {
        if (rows === "err") {
          h.server.socket.serverSend({ t: "result", id: f.id, err: "recovery not supported by this server" });
        } else {
          h.server.socket.serverSend({ t: "result", id: f.id, ok: rows });
        }
      }
    }
  });
};

describe("R5 the morning 等你决定 line", () => {
  it("morningLineOf composes the benefit-voice line verbatim from the row's ask evidence — and nulls without it", () => {
    expect(morningLineOf(blockedRow("night"))).toBe("昨夜停在这里等你授权：允许 shell：./nightly.sh？应答后任务自动继续");
    // 无证据 / 已落定（证据撤）/ 行缺席 → null（零渲染）。
    expect(morningLineOf({ sessionId: "night", state: "blocked" })).toBeNull();
    expect(morningLineOf({ sessionId: "night", state: "recovering", verifiedDone: 2, remaining: 1, permissionAsk: ASK } as RecoveryStatusRowWire)).toBeNull();
    expect(morningLineOf(undefined)).toBeNull();
  });

  it("MorningBanner renders exactly the one line (role=status, the 241 banner family)", () => {
    const container = mount(<MorningBanner line="昨夜停在这里等你授权：允许 shell：./nightly.sh？应答后任务自动继续" />);
    const el = container.querySelector(".recovery-banner");
    expect(el?.getAttribute("role")).toBe("status");
    expect(el?.textContent).toBe("昨夜停在这里等你授权：允许 shell：./nightly.sh？应答后任务自动继续");
  });

  it("the App renders the CURRENT session's morning line, and it disappears when the row settles (the ask evidence is gone)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "night" }, []);
    });
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("night")]);
    await until(
      () => h.container.textContent?.includes("昨夜停在这里等你授权") === true,
      "the morning line renders",
    );
    expect(h.container.textContent).toContain("允许 shell：./nightly.sh");
    // The settled turn: the poll's next frame answers with the recovery
    // moved on (recovering counts, ask evidence withdrawn) — the line goes.
    const seen = opFrames(h).filter((f) => f.op.op === "recoveryStatus").length;
    await until(
      () => opFrames(h).filter((f) => f.op.op === "recoveryStatus").length > seen,
      "the 5s poll re-asks",
      9_000,
    );
    replyRecovery(h, [{ sessionId: "night", state: "recovering", verifiedDone: 2, remaining: 1 }]);
    await until(
      () => h.container.textContent?.includes("昨夜停在这里等你授权") !== true,
      "the morning line disappears after the settle",
    );
    // The reconciliation line takes over (242 face, unchanged semantics).
    expect(h.container.textContent).toContain("已验证完成 2 / 待续 1");
  }, 20_000);

  it("an old server's refusal (err) renders nothing — quiet, never an error surface", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "night" }, []);
    });
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, "err");
    await wait(50);
    expect(h.container.querySelector(".recovery-banner")).toBeNull();
    expect(h.container.textContent).not.toContain("昨夜停在这里等你授权");
  }, 10_000);
});
