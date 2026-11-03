// @vitest-environment jsdom
// 139 修订 — 顶栏监控钮用细线折线 IconChart（lucide 同律：stroke 无填充），
// 不是 emoji 彩色位图（116 弧 chrome 零 emoji 门的回归）。
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IconChart } from "../src/components/icons.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("139 修订 — IconChart", () => {
  it("细线折线：svg + path、无 fill 属性（继承 stroke 系）", () => {
    const c = document.createElement("div");
    document.body.appendChild(c);
    let root = createRoot(c);
    act(() => { root.render(<IconChart />); });
    const svg = c.querySelector("svg") as SVGSVGElement | null;
    expect(svg).not.toBeNull();
    expect(c.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
    // fill="none"（折线不填充，只描边——lucide 同律；基底统一注入）
    expect(svg?.getAttribute("fill")).toBe("none");
    act(() => { root.unmount(); });
    document.body.innerHTML = "";
  });
});
