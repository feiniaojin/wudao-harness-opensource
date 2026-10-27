// @vitest-environment jsdom
// ω99-119 — the C layer, RED-first: the composer's suggestion chips row.
// When the file rail holds drafts (the drop staged them through fileSeed)
// AND the buffer is empty, three intent chips render (the A layer's copy
// table by the FIRST file's family); clicking one fills the buffer with the
// chip's text and rides the EXISTING submit lease (read File → base64 →
// onSubmit(text, undefined, fileInputs)). Esc/clearing the text does NOT
// retract the drafts — the file cards own their removal.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InputBox } from "../src/components/InputBox.js";
import { createFileDraft } from "../src/attachments.js";

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

const BASE = {
  busy: false,
  mode: "workspace" as const,
  commands: [],
  connected: true,
  onSubmit: vi.fn(),
  onInterrupt: vi.fn(),
  onShield: vi.fn(),
  onCycleMode: vi.fn(),
};

const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    });
  }
};

const type = (el: HTMLTextAreaElement, text: string): void => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

const chipLabels = (c: HTMLElement): readonly string[] =>
  [...c.querySelectorAll<HTMLButtonElement>(".intent-row .chip")].map((b) => b.textContent ?? "");

const seed = (name: string, bytes = new Uint8Array([1, 2, 3])) => ({
  drafts: [createFileDraft(new File([bytes], name))],
  nonce: 1,
});

describe("ω99-119 InputBox 建议 chips row（拖文件→起草→一键发）", () => {
  it("文件 rail 有草稿且文本空 → 渲染三颗（文档族文案逐字）；无草稿不渲染", () => {
    const withFiles = mount(
      <InputBox
        {...BASE}
        fileSeed={seed("报告.pdf")}
        onFileSeedApplied={vi.fn()}
        onFilesChange={vi.fn()}
      />,
    );
    expect(chipLabels(withFiles)).toEqual(["总结要点", "提炼待办", "看看这是啥"]);

    const bare = mount(<InputBox {...BASE} />);
    expect(bare.querySelector(".intent-row")).toBeNull();
  });

  it("表格族按首文件族给（.xlsx → 看看数据/总结要点/提炼待办）", () => {
    const c = mount(
      <InputBox {...BASE} fileSeed={seed("预算.xlsx")} onFileSeedApplied={vi.fn()} onFilesChange={vi.fn()} />,
    );
    expect(chipLabels(c)).toEqual(["看看数据", "总结要点", "提炼待办"]);
  });

  it("双条件：文本一旦非空 chips 隐藏；清空后回来（草稿不撤——文件卡自有移除）", () => {
    const c = mount(
      <InputBox {...BASE} fileSeed={seed("笔记.txt")} onFileSeedApplied={vi.fn()} onFilesChange={vi.fn()} />,
    );
    const ta = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    expect(chipLabels(c)).toHaveLength(3);
    act(() => {
      type(ta, "我自己写一句");
    });
    expect(c.querySelector(".intent-row")).toBeNull(); // 文本非空 → 隐藏
    expect(c.querySelectorAll(".file-card")).toHaveLength(1); // 草稿还在
    act(() => {
      type(ta, "");
    });
    expect(chipLabels(c)).toHaveLength(3); // 清空 → 回来
  });

  it("点 chip=填文本+既有 submit：onSubmit(text, undefined, [{data,name}])，成功后 rail/文本清空", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const c = mount(
      <InputBox
        {...BASE}
        onSubmit={onSubmit}
        fileSeed={seed("报告.pdf", new Uint8Array([104, 105]))}
        onFileSeedApplied={vi.fn()}
        onFilesChange={vi.fn()}
      />,
    );
    const chip = [...c.querySelectorAll<HTMLButtonElement>(".intent-row .chip")].find(
      (b) => b.textContent === "总结要点",
    )!;
    await act(async () => {
      chip.click();
    });
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [text, images, fileInputs] = onSubmit.mock.calls[0] as [
      string,
      unknown,
      readonly { data: string; name: string }[] | undefined,
    ];
    expect(text).toBe("总结这个文件的要点");
    expect(images).toBeUndefined();
    expect(fileInputs).toEqual([{ data: btoa("hi"), name: "报告.pdf" }]);
    expect((c.querySelector("textarea.wudao-input") as HTMLTextAreaElement).value).toBe(""); // 发出即清
    expect(c.querySelectorAll(".file-card")).toHaveLength(0); // rail 释放
    expect(c.querySelector(".intent-row")).toBeNull(); // chips 随 rail 走
  });

  it("发送失败（lease 拒）→ 文本留在框里可改可重试，rail/草稿保留", async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    const c = mount(
      <InputBox
        {...BASE}
        onSubmit={onSubmit}
        fileSeed={seed("数据.csv")}
        onFileSeedApplied={vi.fn()}
        onFilesChange={vi.fn()}
      />,
    );
    const chip = [...c.querySelectorAll<HTMLButtonElement>(".intent-row .chip")].find(
      (b) => b.textContent === "看看数据",
    )!;
    await act(async () => {
      chip.click();
    });
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("看看这份数据有什么值得注意的", undefined, [
      { data: expect.any(String), name: "数据.csv" },
    ]);
    expect((c.querySelector("textarea.wudao-input") as HTMLTextAreaElement).value).toBe(
      "看看这份数据有什么值得注意的",
    );
    expect(c.querySelectorAll(".file-card")).toHaveLength(1); // 失败保留重试
  });
});
