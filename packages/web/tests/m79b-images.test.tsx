// @vitest-environment jsdom
// M79b — the web image surface:
//   §1  the composer rail: picker add, ×-remove (blob URL revoked), the 9-cap
//       and cumulative-20MiB pre-flight notices, non-image refusal, drag-drop
//       onto the composer card (depth-counted highlight)
//   §2  the submit lease: success releases drafts (revoked, rail + text
//       cleared); failure (false or a rejection) keeps them; an image-only
//       turn submits with empty text
//   §3  App wiring: attachmentSave THEN submit-with-images on the socket, in
//       op order; a save failure surfaces the notice and keeps the rail
//   §4  the history-image generation cache: same id across a session switch
//       does NOT reuse the old blob URL (and revokes it), different messages
//       in one session share ONE fetch, stale-generation loads drop, the LRU
//       cap evicts-oldest with revocation
//   §5  SimpleMode: the 排 queue lane refuses image turns (notice + rail kept)
// URL.createObjectURL/revokeObjectURL are mocked (jsdom ships neither).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InputBox } from "../src/components/InputBox.js";
import { SimpleMode } from "../src/components/SimpleMode.js";
import { HistoryItem } from "../src/components/HistoryList.js";
import { App } from "../src/components/App.js";
import { AttachmentSource } from "../src/components/AttachmentImages.js";
import type { AttachmentSourceValue } from "../src/components/AttachmentImages.js";
import {
  attachmentImages,
  AttachmentImageCache,
  MAX_COMPOSER_IMAGES,
  base64LengthOf,
} from "../src/attachments.js";
import type { AttachmentRefLike } from "../src/attachments.js";
import type { DriverStatus, HistoryEntry } from "../src/protocol.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- the URL.createObjectURL/revokeObjectURL mock (jsdom ships neither) ---

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

let root: Root | null = null;
const mount = (el: ReactElement): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(el);
  });
  return container;
};
const rerender = (el: ReactElement): void => {
  act(() => {
    root?.render(el);
  });
};
const unmount = (): void => {
  act(() => {
    root?.unmount();
  });
  root = null;
};

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
  attachmentImages.dispose(); // reset the module singleton between tests
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
});

// --- helpers ----------------------------------------------------------------

const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    });
  }
};

function type(el: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const png = (name: string, bytes = new Uint8Array([1, 2, 3]), sizeOverride?: number): File => {
  const f = new File([bytes], name, { type: "image/png" });
  if (sizeOverride !== undefined) Object.defineProperty(f, "size", { value: sizeOverride });
  return f;
};

/** Put files on the hidden picker input and fire its change (the browser's
 *  own pick gesture). */
const pick = async (c: HTMLElement, files: readonly File[]): Promise<void> => {
  const input = c.querySelector("input[type=file]") as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [...files] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const dragEvent = (type: string, files?: readonly File[]): Event => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  if (files !== undefined) Object.defineProperty(ev, "dataTransfer", { value: { files: [...files] } });
  return ev;
};

const thumbs = (c: HTMLElement): Element[] => [...c.querySelectorAll(".composer .img-rail .img-thumb")];
const enter = (c: HTMLElement): void => {
  act(() => {
    (c.querySelector("textarea.wudao-input") as HTMLTextAreaElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
};

const BOX_PROPS = {
  busy: false,
  mode: "workspace" as const,
  commands: [],
  connected: true,
  onInterrupt: () => {},
  onCycleMode: () => {},
  onShield: () => {},
};

const ref = (id: string): AttachmentRefLike => ({ kind: "image", attachmentId: id, mediaType: "image/png", byteLength: 3 });

// --- §1: the composer rail --------------------------------------------------

describe("M79b §1 — the composer image rail", () => {
  it("picker adds thumbnails with the live count; × removes one and revokes its blob URL", async () => {
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={vi.fn()} />);
    await pick(c, [png("a.png"), png("b.png")]);
    expect(thumbs(c).length).toBe(2);
    expect((c.querySelector("button.chip.attach .n") as HTMLElement).textContent).toBe("2");
    expect(created.length).toBe(2);

    await act(async () => {
      (thumbs(c)[0]?.querySelector("button.rm") as HTMLButtonElement).click();
    });
    expect(thumbs(c).length).toBe(1);
    expect(created[0]).toBeDefined();
    expect(revoked).toEqual([created[0]]);
  });

  it("the 9-image cap: a 10-file pick keeps 9 and surfaces the refusal, nothing else added", async () => {
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={vi.fn()} />);
    await pick(c, Array.from({ length: MAX_COMPOSER_IMAGES + 1 }, (_, i) => png(`f${i}.png`)));
    expect(thumbs(c).length).toBe(MAX_COMPOSER_IMAGES);
    const notice = c.querySelector(".img-notice") as HTMLElement;
    // r5-P3: the notice counts the rejected files (the per-kind tally).
    expect(notice.textContent).toContain(`1 张超出数量上限(最多同时附加 ${MAX_COMPOSER_IMAGES} 张)`);
  });

  it("the cumulative 20MiB budget: a second 12MiB image is refused (base64 counted, like the store)", async () => {
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={vi.fn()} />);
    // 12MiB decoded → 16MiB base64: one fits (≤ 20MiB), two do not.
    const twelve = 12 * 1024 * 1024;
    expect(base64LengthOf(twelve)).toBeLessThanOrEqual(20 * 1024 * 1024);
    await pick(c, [png("big1.png", new Uint8Array([1]), twelve)]);
    expect(thumbs(c).length).toBe(1);
    await pick(c, [png("big2.png", new Uint8Array([1]), twelve)]);
    expect(thumbs(c).length).toBe(1);
    // r5-P3: the per-kind tally names the size-limit rejections.
    expect((c.querySelector(".img-notice") as HTMLElement).textContent).toContain("1 张超过 20MiB 上限");
  });

  it("a non-image file is refused outright", async () => {
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={vi.fn()} />);
    const txt = new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" });
    await pick(c, [txt]);
    expect(thumbs(c).length).toBe(0);
    expect((c.querySelector(".img-notice") as HTMLElement).textContent).toContain("只能附加图片");
  });

  // r5-P3: the batch notice lists EVERY rejection kind with its count — a
  // mixed pick (a non-image + a second over-budget image) used to surface
  // only whichever refusal came first.
  it("a MIXED batch surfaces every rejection kind with counts, not just the first", async () => {
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={vi.fn()} />);
    const txt = new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" });
    const twelve = 12 * 1024 * 1024;
    // txt → type; big1 fits (16MiB ≤ 20MiB); big2 pushes past → budget.
    await pick(c, [txt, png("big1.png", new Uint8Array([1]), twelve), png("big2.png", new Uint8Array([1]), twelve)]);
    expect(thumbs(c).length).toBe(1); // big1 only — rejects added nothing
    const notice = (c.querySelector(".img-notice") as HTMLElement).textContent ?? "";
    expect(notice).toContain("1 张不是图片(text/plain)—— 只能附加图片");
    expect(notice).toContain("1 张超过 20MiB 上限");
    expect(notice).toContain(" · "); // the kinds join on one line
  });

  it("the count tally counts: a 12-file pick reports 3 over the cap, not 1", async () => {
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={vi.fn()} />);
    await pick(c, Array.from({ length: MAX_COMPOSER_IMAGES + 3 }, (_, i) => png(`f${i}.png`)));
    expect(thumbs(c).length).toBe(MAX_COMPOSER_IMAGES);
    expect((c.querySelector(".img-notice") as HTMLElement).textContent).toContain("3 张超出数量上限");
  });

  it("drag-drop onto the composer adds images; the highlight tracks drag depth and clears", async () => {
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={vi.fn()} />);
    const composer = c.querySelector(".composer") as HTMLDivElement;
    act(() => {
      composer.dispatchEvent(dragEvent("dragenter"));
    });
    expect(composer.className).toContain("dragover");
    // A child-boundary crossing (enter → leave) must NOT clear the card.
    act(() => {
      composer.dispatchEvent(dragEvent("dragenter"));
      composer.dispatchEvent(dragEvent("dragleave"));
    });
    expect(composer.className).toContain("dragover");
    await act(async () => {
      composer.dispatchEvent(dragEvent("drop", [png("dropped.png")]));
    });
    expect(composer.className).not.toContain("dragover");
    expect(thumbs(c).length).toBe(1);
    // A leave with no drop clears the highlight.
    act(() => {
      composer.dispatchEvent(dragEvent("dragenter"));
      composer.dispatchEvent(dragEvent("dragleave"));
    });
    expect(composer.className).not.toContain("dragover");
  });

  it("unmounting the composer releases every draft's blob URL", async () => {
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={vi.fn()} />);
    await pick(c, [png("a.png"), png("b.png")]);
    unmount();
    expect([...revoked].sort()).toEqual([...created].sort());
  });
});

// --- §2: the submit lease ---------------------------------------------------

describe("M79b §2 — the submit lease (drafts released on success only)", () => {
  it("success: onSubmit gets text + base64 inputs, the rail and text clear, drafts revoke", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={onSubmit} />);
    await pick(c, [png("a.png"), png("b.png")]);
    const ta = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(ta, "看这两张图");
    });
    enter(c);
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [text, inputs] = onSubmit.mock.calls[0] as [string, { data: string; mediaType: string }[]];
    expect(text).toBe("看这两张图");
    expect(inputs).toEqual([
      { data: "AQID", mediaType: "image/png" }, // [1,2,3] → AQID
      { data: "AQID", mediaType: "image/png" },
    ]);
    expect(thumbs(c).length).toBe(0);
    expect(ta.value).toBe("");
    expect(revoked).toEqual(created);
  });

  it("failure (resolved false): the rail and the text stay, nothing revokes", async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={onSubmit} />);
    await pick(c, [png("a.png")]);
    const ta = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(ta, "retry me");
    });
    enter(c);
    await flush();
    expect(thumbs(c).length).toBe(1);
    expect(ta.value).toBe("retry me");
    expect(revoked).toEqual([]);
  });

  it("failure (rejection): same lease-back", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("upload failed"));
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={onSubmit} />);
    await pick(c, [png("a.png")]);
    enter(c);
    await flush();
    expect(thumbs(c).length).toBe(1);
    expect(revoked).toEqual([]);
  });

  it("an image-only turn (empty text) submits with an empty string and keeps the send enabled", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={onSubmit} />);
    await pick(c, [png("a.png")]);
    const send = c.querySelector("button.send") as HTMLButtonElement;
    expect(send.disabled).toBe(false); // images alone arm the send
    expect(send.className).not.toContain("dim");
    enter(c);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("", [{ data: "AQID", mediaType: "image/png" }]);
    expect(thumbs(c).length).toBe(0);
  });

  it("the second Enter while the handshake is in flight stands down (no double send)", async () => {
    let release: (v: boolean) => void = () => {};
    const onSubmit = vi.fn().mockImplementation(() => new Promise<boolean>((r) => { release = r; }));
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={onSubmit} />);
    await pick(c, [png("a.png")]);
    enter(c);
    enter(c);
    await act(async () => {
      release(true);
    });
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  // r5-P3: the disabled × explains itself — a bare disabled toggle with no
  // title reads broken; the handshake owns the rail until the send settles.
  it("the thumb × carries 「提交中，暂不能移除」 while the submit handshake holds the rail, then restores the per-thumb title", async () => {
    let release: (v: boolean) => void = () => {};
    const onSubmit = vi.fn().mockImplementation(() => new Promise<boolean>((r) => { release = r; }));
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={onSubmit} />);
    await pick(c, [png("a.png")]);
    const rm = (): HTMLButtonElement => c.querySelector(".img-rail .img-thumb button.rm") as HTMLButtonElement;
    expect(rm().disabled).toBe(false);
    expect(rm().title).toBe("移除 a.png");
    await act(async () => {
      type(c.querySelector("textarea.wudao-input") as HTMLTextAreaElement, "发送中");
    });
    enter(c);
    expect(rm().disabled).toBe(true);
    expect(rm().title).toBe("提交中，暂不能移除");
    expect(rm().getAttribute("aria-label")).toBe("提交中，暂不能移除");
    await flush(); // the base64 read + the onSubmit call land (the lease is live)
    await act(async () => {
      release(true);
    });
    await flush();
    expect(thumbs(c).length).toBe(0); // released — no rail left to title
  });
});

// --- §3: App wiring (the socket sees attachmentSave → submit, in order) -----

interface Harness {
  readonly container: HTMLElement;
  readonly client: WudaoClient;
  readonly server: FakeServer;
  readonly answered: Set<number>;
}

interface OpFrame {
  id: number;
  op: Record<string, unknown>;
}

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

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
  // Answer the shell's own startup ops (settings gate + the IDE tree) so the
  // chat surface mounts; everything else stays pending for the test to script.
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
  await flush(2);
  return h;
}

/** Script the reply for the FIRST unanswered op matching `name`. */
const answerNext = (h: Harness, name: string, ok: unknown): boolean => {
  const f = opFrames(h).find((o) => !h.answered.has(o.id) && o.op.op === name);
  if (f === undefined) return false;
  h.answered.add(f.id);
  act(() => {
    h.server.socket.serverSend({ t: "result", id: f.id, ok });
  });
  return true;
};

/** Push a full state frame (the surface's only status input). */
const sendState = (h: Harness, overrides: Record<string, unknown>): void => {
  act(() => {
    h.server.socket.serverSend({
      t: "state",
      state: {
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
        ...overrides,
      },
    });
  });
};

describe("M79b §3 — App: attachmentSave then submit with images, in op order", () => {
  it("a successful image send: save → refs ride the submit envelope; drafts release", async () => {
    const h = await connectedApp();
    await pick(h.container, [png("a.png"), png("b.png")]);
    const ta = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(ta, "看这两张图");
    });
    enter(h.container);

    // 1) attachmentSave goes out first, with BOTH images' base64.
    await flush();
    const saveFrame = opFrames(h).find((o) => o.op.op === "attachmentSave");
    expect(saveFrame).toBeDefined();
    expect((saveFrame?.op.inputs as { data: string }[]).map((i) => i.data)).toEqual(["AQID", "AQID"]);

    // 2) The submit has NOT left yet — the composer waits for the refs.
    expect(opFrames(h).some((o) => o.op.op === "submit")).toBe(false);
    const refs = [
      { kind: "image", attachmentId: "att-1", mediaType: "image/png", byteLength: 3 },
      { kind: "image", attachmentId: "att-2", mediaType: "image/png", byteLength: 3 },
    ];
    expect(answerNext(h, "attachmentSave", refs)).toBe(true);
    await flush();

    // 3) submit rides the minted refs, in input order.
    const submitFrame = opFrames(h).find((o) => o.op.op === "submit");
    expect(submitFrame).toBeDefined();
    expect(submitFrame?.op.text).toBe("看这两张图");
    expect(submitFrame?.op.images).toEqual([
      { kind: "image", ref: refs[0] },
      { kind: "image", ref: refs[1] },
    ]);
    expect(answerNext(h, "submit", "started")).toBe(true);
    await flush();

    // Success released the drafts: rail + text cleared, blob URLs revoked.
    expect(thumbs(h.container).length).toBe(0);
    expect(ta.value).toBe("");
    expect(revoked).toEqual(created);

    // Op order on the wire: save strictly before submit.
    const names = opFrames(h).map((o) => String(o.op.op));
    expect(names.indexOf("attachmentSave")).toBeLessThan(names.lastIndexOf("submit"));
  });

  it("a failed save (admission error) surfaces the notice and keeps the rail + text", async () => {
    const h = await connectedApp();
    await pick(h.container, [png("a.png")]);
    const ta = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(ta, "超限图");
    });
    enter(h.container);
    await flush();
    // Reply an ERR (the store's fail-closed admission, e.g. TOO_MANY_IMAGES).
    const f = opFrames(h).find((o) => !h.answered.has(o.id) && o.op.op === "attachmentSave");
    expect(f).toBeDefined();
    h.answered.add(f!.id);
    act(() => {
      h.server.socket.serverSend({ t: "result", id: f!.id, err: "admission failed: IMAGES_TOO_LARGE" });
    });
    await flush();
    expect(thumbs(h.container).length).toBe(1);
    expect(ta.value).toBe("超限图");
    expect(h.container.textContent).toContain("图片发送失败");
    // r5-P4: the admission code maps to Chinese, with the code in parens —
    // the machine token never surfaces verbatim alone.
    expect(h.container.textContent).toContain("图片体积超出上限(IMAGES_TOO_LARGE)");
    expect(opFrames(h).some((o) => o.op.op === "submit")).toBe(false);
  });

  // I1 parity for images: an ask popping mid-draft parks the rail (no revoke,
  // no re-mint); the ask clearing restores it. A session switch while parked
  // releases it instead (r2 MINOR parity).
  const ASK = { toolName: "shell", summary: "ls", input: {} };

  it("an ask takeover parks the staged images; the ask clearing restores them (same blob URL)", async () => {
    const h = await connectedApp();
    await pick(h.container, [png("a.png")]);
    expect(thumbs(h.container).length).toBe(1);

    // The ask takes the input area: the composer unmounts, the rail parks.
    sendState(h, { pendingPermission: ASK });
    expect(thumbs(h.container).length).toBe(0);
    expect(revoked).toEqual([]); // parked, NOT released
    const minted = [...created];

    // The ask clears on the SAME session: the rail re-arms, same draft (no
    // re-mint — created is unchanged).
    sendState(h, { pendingPermission: null });
    await flush(2);
    expect(thumbs(h.container).length).toBe(1);
    expect(created).toEqual(minted);
    expect(revoked).toEqual([]);
  });

  it("a session switch while parked releases the staged images (no cross-session ride)", async () => {
    const h = await connectedApp();
    await pick(h.container, [png("a.png")]);
    const url = [...created].pop();
    sendState(h, { pendingPermission: ASK });
    expect(thumbs(h.container).length).toBe(0);
    // The ask clears onto a DIFFERENT session: the parked drafts release.
    sendState(h, { pendingPermission: null, sessionId: "wudao-other-0002" });
    await flush(2);
    expect(thumbs(h.container).length).toBe(0);
    expect(revoked).toContain(url);
  });
});

// --- §4: the generation-counter cache ---------------------------------------

describe("M79b §4 — the history-image cache (generation counter, dsh pattern)", () => {
  it("same id, same session: one fetch, two bubbles share the URL", async () => {
    const get = vi.fn().mockResolvedValue({ data: btoa("hello"), mediaType: "image/png" });
    const source: AttachmentSourceValue = { client: { attachmentGet: get }, sessionId: "s1" };
    const entry = (text: string): HistoryEntry => ({ kind: "user", text, images: [{ kind: "image", ref: ref("att-1") }] });
    mount(
      <AttachmentSource.Provider value={source}>
        <HistoryItem entry={entry("first")} />
        <HistoryItem entry={entry("second")} />
      </AttachmentSource.Provider>,
    );
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    const imgs = [...document.querySelectorAll("img.img-bub")] as HTMLImageElement[];
    expect(imgs.length).toBe(2);
    expect(imgs[0]?.src).toBe(imgs[1]?.src);
  });

  it("a session switch does NOT reuse the old URL: the old one revokes, the ref refetches", async () => {
    const get = vi.fn().mockResolvedValue({ data: btoa("hello"), mediaType: "image/png" });
    const entry: HistoryEntry = { kind: "user", text: "x", images: [{ kind: "image", ref: ref("att-9") }] };
    const shell = (sessionId: string): ReactElement => (
      <AttachmentSource.Provider value={{ client: { attachmentGet: get }, sessionId }}>
        <HistoryItem entry={entry} />
      </AttachmentSource.Provider>
    );
    mount(shell("s1"));
    await flush();
    const first = (document.querySelector("img.img-bub") as HTMLImageElement).src;
    expect(get).toHaveBeenCalledTimes(1);

    rerender(shell("s2"));
    await flush();
    const second = (document.querySelector("img.img-bub") as HTMLImageElement).src;
    expect(get).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(revoked).toContain(first);
  });

  it("a load landing after a generation bump is dropped (null) and its minted URL revoked", async () => {
    const cache = new AttachmentImageCache();
    const get = vi.fn().mockResolvedValue({ data: btoa("x"), mediaType: "image/png" });
    const g1 = cache.ensureSession("a");
    const stale = await cache.resolve(g1, ref("att-late"), get);
    // Still the same generation here — but resolve with an OLD gen after a
    // bump must self-drop. Simulate the race directly:
    const g0 = g1 - 1;
    const dropped = await cache.resolve(g0, ref("att-raced"), get);
    expect(dropped).toBeNull();
    expect(stale).not.toBeNull();
    // The raced load minted a URL (createObjectURL fired) then revoked it.
    expect(revoked).toContain(created[created.length - 1]);
  });

  it("the LRU cap (50) evicts the oldest entry and revokes its URL", async () => {
    const cache = new AttachmentImageCache();
    const get = vi.fn().mockResolvedValue({ data: btoa("x"), mediaType: "image/png" });
    const g = cache.ensureSession("lru");
    const first = await cache.resolve(g, ref("id-0"), get);
    for (let i = 1; i <= 50; i += 1) await cache.resolve(g, ref(`id-${i}`), get);
    expect(revoked).toContain(first);
    // The evicted id is gone: resolving it again refetches.
    await cache.resolve(g, ref("id-0"), get);
    expect(get).toHaveBeenCalledTimes(52);
  });
});

// --- §5: SimpleMode's queue lane refuses image turns ------------------------

describe("M79b §5 — SimpleMode: the 排 queue lane cannot park images", () => {
  const status = (busy: boolean): DriverStatus => ({
    live: { reasoning: "", answer: "", busyTools: [] },
    busy,
    queued: [],
    boardProgress: null,
    ctxTokens: null,
    mode: "workspace",
    cachePercent: null,
    bg: { active: 0, spawned: 0 },
    pendingPermission: null,
    planBoard: null,
    sessionId: "s-simple",
    sidecar: null,
  });

  it("busy + queue lane: notice, rail kept, no submit", async () => {
    const notify = vi.fn();
    const onSubmit = vi.fn();
    const c = mount(
      <SimpleMode
        status={status(true)}
        history={[]}
        connected={true}
        commands={[]}
        onSubmit={onSubmit}
        onInterrupt={() => {}}
        onCycleMode={() => {}}
        onAnswerPermission={() => Promise.resolve(true)}
        onShield={() => {}}
        notify={notify}
        parked={[]}
        onPark={() => {}}
        onDropParked={() => {}}
        onDraftApplied={() => {}}
        workspaceRoot="/w/cur"
        onSwitchWorkspace={() => {}}
        onOpenOtherWorkspace={() => {}}
        rootCard={null}
        onAgentRootSwitch={() => {}}
        onAgentRootKeep={() => {}}
        fileOpsClient={{ fileTree: vi.fn(), fileRead: vi.fn() }}
      />,
    );
    await pick(c, [png("a.png")]);
    const ta = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(ta, "排队带图");
    });
    enter(c);
    await flush();
    expect(notify).toHaveBeenCalledWith("⚠️ 排队消息暂不支持图片 —— 请等当前任务结束后再发");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(thumbs(c).length).toBe(1);
    expect(ta.value).toBe("排队带图");
  });
});
