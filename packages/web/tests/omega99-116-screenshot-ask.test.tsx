// @vitest-environment jsdom
// ω99-116 — 截图快问 web half, RED-first. Rust broadcasts the png bytes as
// {data,mediaType} on WUDAO_SCREENSHOT_EVENT (apps/desktop/src-tauri/src/
// screenshot.rs — the 110 selection-event lane); the receiving half is a
// PURE parse/mint layer (src/screenshot-ask.ts) + the App listener that
// arms the composer's imageSeed (the M79b parked-rail seam) — the capture
// lands as a DELETABLE DRAFT in the input rail, focus never stolen, and
// 截了不发=不存盘: the mint path never touches attachmentSave (submit-only,
// spy-pinned at the App level over the mock-ws op frames).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { readFileAsBase64 } from "../src/attachments.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import {
  WUDAO_SCREENSHOT_EVENT,
  SCREENSHOT_DRAFT_NAME,
  parseScreenshotPayload,
  screenshotFileFromPayload,
} from "../src/screenshot-ask.js";
import { tauriListenEvent } from "../src/tauri-invoke.js";

// App's effect consumes tauriListenEvent; the mock keeps the seam's other
// exports real and captures the handler registrations on the spy so the
// test can FIRE the Rust event verbatim (the pet-drop test discipline —
// jsdom has no bridge, the real seam would read null).
vi.mock("../src/tauri-invoke.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tauri-invoke.js")>();
  return {
    ...actual,
    tauriListenEvent: vi.fn(async (): Promise<(() => void) | null> => null),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- URL.createObjectURL/revokeObjectURL mock (jsdom ships neither; m79b) ---

let urlSeq = 0;
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  urlSeq = 0;
  created.length = 0;
  revoked.length = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: (o: unknown) => {
      const u = `blob:mock-${(urlSeq += 1)}`;
      created.push(u);
      return u;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: (u: string) => {
      revoked.push(u);
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- the mount helpers (m79b shape) -----------------------------------------

let root: Root | null = null;

const mount = (el: ReactElement): HTMLElement => {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => {
    root?.render(el);
  });
  return container;
};

const unmount = (): void => {
  if (root !== null) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  document.body.innerHTML = "";
};

afterEach(() => unmount());

/** base64 helper (the test-side mirror of Rust's codec). */
const enc = (bytes: readonly number[]): string => btoa(String.fromCharCode(...bytes));

// ---- the pure layer ---------------------------------------------------------

describe("ω99-116 纯层：parseScreenshotPayload（载荷形状守卫）", () => {
  it("合法载荷 → {data, mediaType} 原样返回", () => {
    expect(parseScreenshotPayload({ data: "iVBORw0KG", mediaType: "image/png" })).toEqual({
      data: "iVBORw0KG",
      mediaType: "image/png",
    });
  });

  it("非对象 / 缺键 / 空 data / 非 image/* → null（事件整 drop）", () => {
    expect(parseScreenshotPayload(null)).toBeNull();
    expect(parseScreenshotPayload("png")).toBeNull();
    expect(parseScreenshotPayload({ mediaType: "image/png" })).toBeNull();
    expect(parseScreenshotPayload({ data: "", mediaType: "image/png" })).toBeNull();
    expect(parseScreenshotPayload({ data: "AAAA", mediaType: "text/plain" })).toBeNull();
    expect(parseScreenshotPayload({ data: 42, mediaType: "image/png" })).toBeNull();
  });

  it("Esc 取消形态（Rust 从不发；守卫兜底）→ null——零草稿零报错", () => {
    expect(parseScreenshotPayload({ cancelled: true })).toBeNull();
    expect(parseScreenshotPayload({ status: "cancelled" })).toBeNull();
    expect(parseScreenshotPayload({ data: "AAAA", mediaType: "image/png", cancelled: true })).not.toBeNull();
  });

  it("事件名与 Rust 端 screenshot.rs 的 WUDAO_SCREENSHOT_EVENT 同名钉死", () => {
    expect(WUDAO_SCREENSHOT_EVENT).toBe("wudao-screenshot");
  });
});

describe("ω99-116 纯层：screenshotFileFromPayload（字节→File 铸币）", () => {
  it("字节 roundtrip（readFileAsBase64 回读同串）+ type + size + 用户文案名", async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 1, 2, 250];
    const f = screenshotFileFromPayload({ data: enc(bytes), mediaType: "image/png" });
    expect(f).not.toBeNull();
    expect(f?.type).toBe("image/png");
    expect(f?.size).toBe(bytes.length);
    expect(f?.name).toBe(SCREENSHOT_DRAFT_NAME);
    expect(await readFileAsBase64(f as File)).toBe(enc(bytes));
    // 用户文案=收益：名字里不得出现实现术语
    expect(SCREENSHOT_DRAFT_NAME).not.toMatch(/screenshot|draft|composer|image|tauri/i);
  });

  it("坏载荷 / 非法 base64 → null（不抛）", () => {
    expect(screenshotFileFromPayload({ status: "cancelled" })).toBeNull();
    expect(screenshotFileFromPayload(null)).toBeNull();
  });
});

// ---- the App wiring ---------------------------------------------------------

interface OpFrame {
  id: number;
  op: Record<string, unknown>;
}

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

interface Harness {
  readonly container: HTMLElement;
  readonly client: WudaoClient;
  readonly server: FakeServer;
  readonly answered: Set<number>;
}

async function connectedApp(): Promise<Harness> {
  const server = fakeServer();
  const client = new WudaoClient({
    url: "ws://127.0.0.1:1",
    token: "t",
    wsFactory: () => server.spawn(),
    reconnect: false,
  });
  const container = mount(<App client={client} />);
  const answered = new Set<number>();
  const h: Harness = { container, client, server, answered };
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  await act(async () => {
    authOk(server.socket);
  });
  await act(async () => {
    for (const f of opFrames(h)) {
      if (answered.has(f.id)) continue;
      answered.add(f.id);
      const ok =
        f.op.op === "settingsStatus"
          ? {
              providers: [],
              credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
              settings: { memoryEnabled: false, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
              current: { provider: "deepseek", model: "deepseek-chat" },
              envKey: false,
              readiness: true,
              efforts: [],
            }
          : f.op.op === "fileTree"
            ? { entries: [] }
            : [];
      server.socket.serverSend({ t: "result", id: f.id, ok });
    }
  });
  await act(async () => {
    await Promise.resolve();
  });
  return h;
}

/** The App's live listener for the screenshot event (the LAST registration
 *  — one mount, one call; reverse-scan so test isolation holds). */
type ScreenshotHandler = (p: unknown) => void;

const screenshotListener = (): ScreenshotHandler | null => {
  const calls = vi.mocked(tauriListenEvent).mock.calls;
  const hit = [...calls].reverse().find(([e]) => e === WUDAO_SCREENSHOT_EVENT);
  return hit === undefined ? null : hit[1] as ScreenshotHandler;
};

describe("ω99-116 App 接线：事件 → 草稿 mint → 输入框 rail", () => {
  it("收到截图事件 → 图进输入框 rail（看得见）；零 attachmentSave（截了不发=不存盘）", async () => {
    const h = await connectedApp();
    const handler = screenshotListener();
    expect(handler).not.toBeNull(); // App 必须挂上监听
    act(() => {
      handler?.({ data: enc([0x89, 0x50, 0x4e, 0x47, 9]), mediaType: "image/png" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    const thumbs = h.container.querySelectorAll(".composer .img-rail .img-thumb");
    expect(thumbs.length).toBe(1); // 图落在输入框里
    expect(created.length).toBe(1); // 草稿 mint（blob URL 一枚）
    // 隐私红线 spy：未 submit 不得有任何 attachmentSave op
    expect(opFrames(h).some((o) => o.op.op === "attachmentSave")).toBe(false);
  });

  it("Esc 取消形态事件 → 零新草稿零报错（rail 不长）", async () => {
    const h = await connectedApp();
    const handler = screenshotListener();
    act(() => {
      handler?.({ status: "cancelled" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.container.querySelectorAll(".composer .img-rail .img-thumb").length).toBe(0);
    expect(created.length).toBe(0);
    expect(opFrames(h).some((o) => o.op.op === "attachmentSave")).toBe(false);
  });

  it("第二次截图追加不覆盖（rail 两条，M79b 上限内）", async () => {
    const h = await connectedApp();
    const handler = screenshotListener();
    act(() => {
      handler?.({ data: enc([1, 2, 3]), mediaType: "image/png" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      handler?.({ data: enc([4, 5, 6]), mediaType: "image/png" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.container.querySelectorAll(".composer .img-rail .img-thumb").length).toBe(2);
  });
});
