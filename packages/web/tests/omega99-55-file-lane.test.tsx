// @vitest-environment jsdom
// ω99-55 — the web file lane (the composer's SECOND attachment lane):
//   §1  pure admission: fileRejectionKind has count/budget kinds only (no
//       type whitelist — any file kind may attach), the batch notice shape,
//       and the admission-error mapping
//   §2  the composer rail: the file chip's picker adds name+size cards
//       (no blob URLs — nothing to preview), × removes, caps surface
//   §3  the submit lease: onSubmit receives (text, images?, files?) with
//       the drafts' base64 + names
//   §4  App wiring: fileSave THEN submit-with-files on the socket, in op
//       order; the model-visible form never carries bytes
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InputBox } from "../src/components/InputBox.js";
import { App } from "../src/components/App.js";
import {
  MAX_COMPOSER_FILES,
  MAX_FILE_BUDGET_BYTES,
  fileRejectionKind,
  admitFileBatch,
  fileSendErrorText,
} from "../src/attachments.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- the mount harness (the m79b shape) --------------------------------------

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
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
});

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

const pdf = (name: string, bytes = new Uint8Array([1, 2, 3]), sizeOverride?: number): File => {
  const f = new File([bytes], name, { type: "application/pdf" });
  if (sizeOverride !== undefined) Object.defineProperty(f, "size", { value: sizeOverride });
  return f;
};

/** Put files on the FILE lane's hidden picker input and fire its change. */
const pickFiles = async (c: HTMLElement, files: readonly File[]): Promise<void> => {
  const input = c.querySelector("input[type=file][data-lane=file]") as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [...files] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const cards = (c: HTMLElement): Element[] => [...c.querySelectorAll(".composer .file-rail .file-card")];
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

// --- §1: pure admission -------------------------------------------------------

describe("ω99-55 §1 — the file lane's pure admission", () => {
  it("any file kind attaches (no type kind — dsh: no whitelist)", () => {
    expect(fileRejectionKind({ type: "application/pdf", size: 10 }, [])).toBeNull();
    expect(fileRejectionKind({ type: "", size: 10 }, [])).toBeNull();
    expect(fileRejectionKind({ type: "application/octet-stream", size: 10 }, [])).toBeNull();
  });

  it("count and budget kinds mirror the image lane's shapes (separate ledger)", () => {
    const rail = Array.from({ length: MAX_COMPOSER_FILES }, () => ({ byteLength: 1 }));
    expect(fileRejectionKind({ type: "", size: 1 }, rail)).toBe("count");
    // base64 of 1 byte = 4; budget counted in base64, like the store.
    expect(fileRejectionKind({ type: "", size: MAX_FILE_BUDGET_BYTES }, [])).toBe("budget");
  });

  it("admitFileBatch: per-kind tally notice; accepted files count toward the rail", () => {
    const ten = Array.from({ length: MAX_COMPOSER_FILES + 1 }, (_, i) => pdf(`f${i}.pdf`));
    const { accepted, notice } = admitFileBatch(ten, []);
    expect(accepted).toHaveLength(MAX_COMPOSER_FILES);
    expect(notice).toContain(`1 个超出数量上限(最多同时附加 ${MAX_COMPOSER_FILES} 个)`);
    expect(admitFileBatch([pdf("ok.pdf")], []).notice).toBeNull();
  });

  it("fileSendErrorText maps the store's typed admission prose; others pass through", () => {
    expect(fileSendErrorText("10 files exceed the per-request cap of 9")).toContain("文件数量超出上限");
    expect(fileSendErrorText("files total 999 base64 bytes, over the 100-byte request budget")).toContain("文件体积超出上限");
    expect(fileSendErrorText("socket died")).toBe("socket died");
  });
});

// --- §2: the composer rail ----------------------------------------------------

describe("ω99-55 §2 — the composer file rail", () => {
  it("the file picker adds name+size cards (no blob URLs minted); × removes", async () => {
    const createObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: createObjectURL });
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={vi.fn()} />);
    await pickFiles(c, [pdf("年报.pdf"), pdf("data.csv")]);
    expect(cards(c).length).toBe(2);
    expect(cards(c)[0]!.getAttribute("data-name")).toBe("年报.pdf");
    expect(cards(c)[0]!.textContent).toContain("年报.pdf");
    expect(createObjectURL).not.toHaveBeenCalled(); // file cards preview nothing
    await act(async () => {
      (cards(c)[0]?.querySelector("button.rm") as HTMLButtonElement).click();
    });
    expect(cards(c).length).toBe(1);
    delete (URL as { createObjectURL?: unknown }).createObjectURL;
  });

  it("the count cap and the budget cap surface the notice, nothing else added", async () => {
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={vi.fn()} />);
    await pickFiles(c, Array.from({ length: MAX_COMPOSER_FILES + 1 }, (_, i) => pdf(`f${i}.pdf`)));
    expect(cards(c).length).toBe(MAX_COMPOSER_FILES);
    expect((c.querySelector(".img-notice") as HTMLElement).textContent).toContain("1 个超出数量上限");
    // The budget cap fires on its own (an empty rail, one over-budget file):
    // base64 of the raw size alone exceeds the 50MiB encoded budget.
    const c2 = mount(<InputBox {...BOX_PROPS} onSubmit={vi.fn()} />);
    const big = Math.ceil((MAX_FILE_BUDGET_BYTES * 3) / 4) + 1024;
    await pickFiles(c2, [pdf("big.bin", new Uint8Array([1]), big)]);
    expect(cards(c2).length).toBe(0);
    expect((c2.querySelector(".img-notice") as HTMLElement).textContent).toContain("1 个超过 50MiB 上限");
  });
});

// --- §3: the submit lease -----------------------------------------------------

describe("ω99-55 §3 — the submit lease carries files", () => {
  it("onSubmit receives (text, images?, files[]) — base64 + name, in pick order", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={onSubmit} />);
    await pickFiles(c, [pdf("a.pdf"), pdf("b.csv")]);
    const ta = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(ta, "review these");
    });
    enter(c);
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [text, images, files] = onSubmit.mock.calls[0] as [string, undefined, { data: string; name: string }[]];
    expect(text).toBe("review these");
    expect(images).toBeUndefined();
    expect(files).toEqual([
      { data: "AQID", name: "a.pdf" },
      { data: "AQID", name: "b.csv" },
    ]);
    expect(cards(c).length).toBe(0); // success cleared the rail
    expect(ta.value).toBe("");
  });

  it("failure keeps the rail and the text (the lease discipline)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    const c = mount(<InputBox {...BOX_PROPS} onSubmit={onSubmit} />);
    await pickFiles(c, [pdf("keep.pdf")]);
    const ta = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(ta, "retry me");
    });
    enter(c);
    await flush();
    expect(cards(c).length).toBe(1);
    expect(ta.value).toBe("retry me");
  });
});

// --- §4: App wiring (fileSave THEN submit-with-files, in op order) -----------

interface OpFrame { op: { op: string; [k: string]: unknown }; id: number }
interface Harness { container: HTMLElement; client: WudaoClient; server: ReturnType<typeof fakeServer>; answered: Set<number> }

function opFrames(h: Harness): OpFrame[] {
  return h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);
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
  await flush(2);
  return h;
}

const answerNext = (h: Harness, name: string, ok: unknown): boolean => {
  const f = opFrames(h).find((o) => !h.answered.has(o.id) && o.op.op === name);
  if (f === undefined) return false;
  h.answered.add(f.id);
  act(() => {
    h.server.socket.serverSend({ t: "result", id: f.id, ok });
  });
  return true;
};

describe("ω99-55 §4 — App: fileSave then submit with files, in op order", () => {
  it("a successful file send: save → blocks ride the submit envelope; the rail clears", async () => {
    const h = await connectedApp();
    await pickFiles(h.container, [pdf("spec.pdf")]);
    const ta = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(ta, "审阅这份文档");
    });
    enter(h.container);

    // 1) fileSave goes out first, with the file's base64 + name.
    await flush();
    const saveFrame = opFrames(h).find((o) => o.op.op === "fileSave");
    expect(saveFrame).toBeDefined();
    expect((saveFrame?.op.inputs as { data: string; name: string }[])).toEqual([{ data: "AQID", name: "spec.pdf" }]);

    // 2) The submit has NOT left yet — the composer waits for the blocks.
    expect(opFrames(h).some((o) => o.op.op === "submit")).toBe(false);
    const blocks = [{ kind: "file", name: "spec.pdf", bytes: 3, attachmentId: `sha256:${"a".repeat(64)}` }];
    expect(answerNext(h, "fileSave", blocks)).toBe(true);
    await flush();

    // 3) submit rides the minted blocks.
    const submitFrame = opFrames(h).find((o) => o.op.op === "submit");
    expect(submitFrame).toBeDefined();
    expect(submitFrame?.op.text).toBe("审阅这份文档");
    expect(submitFrame?.op.files).toEqual(blocks);
    expect(submitFrame?.op.images).toBeUndefined();
    expect(answerNext(h, "submit", "started")).toBe(true);
    await flush();

    expect(cards(h.container).length).toBe(0);
    expect(ta.value).toBe("");
    const names = opFrames(h).map((o) => String(o.op.op));
    expect(names.indexOf("fileSave")).toBeLessThan(names.lastIndexOf("submit"));
  });

  it("a failed save surfaces the notice and keeps the rail + text", async () => {
    const h = await connectedApp();
    await pickFiles(h.container, [pdf("big.pdf")]);
    const ta = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(ta, "超限文件");
    });
    enter(h.container);
    await flush();
    const f = opFrames(h).find((o) => !h.answered.has(o.id) && o.op.op === "fileSave");
    expect(f).toBeDefined();
    h.answered.add(f!.id);
    act(() => {
      h.server.socket.serverSend({ t: "result", id: f!.id, err: "admission failed: FILES_TOO_LARGE" });
    });
    await flush();
    expect(cards(h.container).length).toBe(1);
    expect(ta.value).toBe("超限文件");
    expect(opFrames(h).some((o) => o.op.op === "submit")).toBe(false);
  });
});
