// @vitest-environment jsdom
// ω99-318 — web 审批面的视觉欺骗显形（DOM 钉）。两壳一面（ui-parity C）：
// SimpleApprovalCard（简洁模式）与 PermissionModal（高级模式）渲染同一个
// SpoofReveal——载荷在 ask 帧上（core 单一事实源算出、server 纯透传），web
// 只镜像形状只渲染，绝不复制码点表。钉三件事：
//   1) 载荷在场：码点徽标（U+200B 零宽空格）/URL 真实指向/punycode 注记
//      进 DOM，位于 cmd 墙之后、按钮区之前（滚动区内）；
//   2) 载荷缺席：DOM 零变化（无 .spoof 节点——加性契约）；
//   3) 显形不拦截：载荷在场时按钮照常可点（答案面零差）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SimpleApprovalCard } from "../src/components/SimpleApprovalCard.js";
import { PermissionModal } from "../src/components/PermissionModal.js";
import type { PendingPermission } from "../src/protocol.js";

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

const SPOOF: NonNullable<PendingPermission["spoof"]> = {
  text: [
    {
      key: "command",
      issues: [{ codepoint: "U+200B", nameZh: "零宽空格", position: 13, category: "zero-width" }],
      more: 0,
    },
  ],
  urls: [
    {
      key: "url",
      original: "https://gοogle.com",
      normalizedUrl: "https://google.com",
      warnings: ["同形/全角字符：ο→o（归一后与所见不一致）", "实际网络名（punycode）：xn--gogle-rce.com"],
    },
  ],
};

describe("ω99-318 SimpleApprovalCard — the spoof reveal", () => {
  it("载荷在场：徽标/真实指向/punycode 注记进 DOM（cmd 墙后、按钮前）", () => {
    const c = mount(<SimpleApprovalCard ask={{ toolName: "shell", summary: "清理临时目录", input: { command: "rm -rf /tmp/​safe" }, spoof: SPOOF }} onChoose={() => {}} />);
    const spoof = c.querySelector(".approval .spoof") as HTMLElement;
    expect(spoof).not.toBeNull();
    expect(spoof.querySelector(".spoof-title")?.textContent).toContain("视觉欺骗检查");
    // 码点徽标样式钩：U+200B 零宽空格
    const badge = spoof.querySelector(".spoof-badge") as HTMLElement;
    expect(badge.textContent).toContain("U+200B 零宽空格");
    expect(spoof.querySelector(".spoof-key")?.textContent).toBe("command");
    // URL 的真实指向（归一形）+ 机器实际去哪（punycode 注记）
    expect(spoof.querySelector(".spoof-target")?.textContent).toBe("https://google.com");
    const notes = [...spoof.querySelectorAll(".spoof-note")].map((n) => n.textContent ?? "");
    expect(notes.join(" ")).toContain("xn--gogle-rce.com");
    // 位置契约：cmd 墙仍在、reveal 在滚动区内、按钮区在滚动区外（可达性不变）
    expect(c.querySelector(".approval .cmd")?.textContent).toContain("rm -rf /tmp/");
    const scroll = c.querySelector(".ap-scroll") as HTMLElement;
    expect(scroll.contains(spoof)).toBe(true);
    const btns = c.querySelector(".approval .btns") as HTMLElement;
    expect(scroll.contains(btns)).toBe(false);
  });

  it("载荷缺席：DOM 零变化（无 .spoof 节点——加性契约的老消费面）", () => {
    const c = mount(<SimpleApprovalCard ask={{ toolName: "shell", summary: "跑测试", input: { command: "npm test" } }} onChoose={() => {}} />);
    expect(c.querySelector(".spoof")).toBeNull();
  });

  it("空载荷（text/urls 皆空）也零渲染（退化帧不惊扰）", () => {
    const c = mount(<SimpleApprovalCard ask={{ toolName: "shell", summary: "x", input: { command: "ls" }, spoof: { text: [], urls: [] } }} onChoose={() => {}} />);
    expect(c.querySelector(".spoof")).toBeNull();
  });

  it("显形不拦截：载荷在场时按钮照常（allow/deny 答案面零差）", async () => {
    const onChoose = vi.fn();
    const c = mount(<SimpleApprovalCard ask={{ toolName: "shell", summary: "x", input: { command: "rm -rf /tmp/​safe" }, spoof: SPOOF }} onChoose={onChoose} />);
    await act(async () => {
      (c.querySelector(".approval .btns button.deny") as HTMLButtonElement).click();
    });
    expect(onChoose).toHaveBeenCalledWith({ allow: false });
    await act(async () => {
      (c.querySelector(".approval .btns button.allow") as HTMLButtonElement).click();
    });
    expect(onChoose).toHaveBeenCalledWith({ allow: true });
  });

  it("超帽披露：more>0 渲染「另 N 处」", () => {
    const c = mount(
      <SimpleApprovalCard
        ask={{
          toolName: "shell",
          summary: "x",
          input: { command: "x" },
          spoof: { text: [{ key: "command", issues: [{ codepoint: "U+200B", nameZh: "零宽空格", position: 0, category: "zero-width" }], more: 12 }], urls: [] },
        }}
        onChoose={() => {}}
      />,
    );
    const more = c.querySelector(".spoof .spoof-more") as HTMLElement;
    expect(more?.textContent).toContain("另 12 处");
  });
});

describe("ω99-318 PermissionModal — the SAME reveal, both shells", () => {
  it("高级模式内联卡渲染同一 SpoofReveal（one derivation, both shells）", () => {
    const c = mount(<PermissionModal ask={{ toolName: "fetch", summary: "拉取文档", input: { url: "https://gοogle.com" }, spoof: SPOOF }} onChoose={() => {}} />);
    const spoof = c.querySelector(".permission-card .spoof") as HTMLElement;
    expect(spoof).not.toBeNull();
    expect(spoof.querySelector(".spoof-badge")?.textContent).toContain("U+200B 零宽空格");
    expect(spoof.querySelector(".spoof-target")?.textContent).toBe("https://google.com");
    // 滚动区内、答案行外（可达性不变）
    const scroll = c.querySelector(".pc-scroll") as HTMLElement;
    expect(scroll.contains(spoof)).toBe(true);
    const btnrow = c.querySelector(".permission-card .btnrow") as HTMLElement;
    expect(scroll.contains(btnrow)).toBe(false);
  });

  it("载荷缺席：高级模式同样零渲染", () => {
    const c = mount(<PermissionModal ask={{ toolName: "fetch", summary: "x", input: { url: "https://a.b/c" } }} onChoose={() => {}} />);
    expect(c.querySelector(".spoof")).toBeNull();
  });
});
