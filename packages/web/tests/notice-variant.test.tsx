// @vitest-environment jsdom
// P2 ① 通知变体制（DESIGN-SYSTEM §6.4）——语义（警示/成功/陈述）由变体承担：
// ⚠️/✅/ℹ️ 前缀在**渲染面**识别并剥离，warn/ok 走语义色 + 12px 细线字形
// （Icon triangle-alert / icons IconCheck），位图 emoji 不再上屏。
// 调用点零改动是本设计的构成性约束（notify 的单一 string 形态是贯穿
// views/notes/回执管线的线格式，omega99-202/204 源钉锁死 `` ⚠️ `` 前缀），
// 所以钉的是**渲染结果**：变体 attr、剥离后正文、字形 svg 在位、纯文本不变。
import { afterEach, describe, expect, it } from "vitest";
import { mount, decl, unmount } from "./css-test-utils.js";
import "../src/styles.css";
import { classifyNotice } from "../src/notice-variant.js";
import { HistoryItem, HistoryList } from "../src/components/HistoryList.js";
import type { HistoryEntry } from "../src/protocol.js";

afterEach(unmount);

describe("classifyNotice（纯函数：前缀识别 + 剥离）", () => {
  it("⚠️ 前缀（带/不带变体选择符）→ warn，正文剥掉前缀与分隔空白", () => {
    expect(classifyNotice("⚠️ 命名失败：boom")).toEqual({ variant: "warn", text: "命名失败：boom" });
    expect(classifyNotice("⚠无选择符也认")).toEqual({ variant: "warn", text: "无选择符也认" });
  });

  it("✅ → ok；ℹ️ → info（=缺省态，仅剥字形）；前缀后多个空白一并剥", () => {
    expect(classifyNotice("✅  已保存")).toEqual({ variant: "ok", text: "已保存" });
    expect(classifyNotice("ℹ️ 提示行")).toEqual({ variant: "info", text: "提示行" });
  });

  it("纯文本原样返回 info；句中（非前导）的 ⚠️ 不动", () => {
    expect(classifyNotice("已切换到简洁模式 — 重载后完全生效")).toEqual({
      variant: "info",
      text: "已切换到简洁模式 — 重载后完全生效",
    });
    expect(classifyNotice("句中 ⚠️ 不是前缀")).toEqual({ variant: "info", text: "句中 ⚠️ 不是前缀" });
  });
});

describe("会话流通知气泡（HistoryList NoticeBubble/NoticeGroup）", () => {
  it("⚠️ 前缀通知渲染为 warn 变体：正文不含 ⚠️ 字符、带前导细线字形", () => {
    const c = mount(<HistoryItem entry={{ kind: "notice", text: "⚠️ 会话列表加载失败：boom" }} />);
    const bub = c.querySelector(".entry-notice > .notice-bub");
    expect(bub).not.toBeNull();
    expect(bub?.getAttribute("data-variant")).toBe("warn");
    expect(bub?.textContent).not.toContain("⚠️");
    expect(bub?.textContent).toContain("会话列表加载失败：boom");
    // 前导字形 = SVG 细线（Icon triangle-alert），不是位图 emoji。
    expect(bub?.querySelector("svg.ic")).not.toBeNull();
  });

  it("✅ 前缀通知渲染为 ok 变体（IconCheck 字形）；ℹ️ 前缀剥字形、info 中性无字形", () => {
    const ok = mount(<HistoryItem entry={{ kind: "notice", text: "✅ 已保存" }} />);
    const okBub = ok.querySelector(".notice-bub");
    expect(okBub?.getAttribute("data-variant")).toBe("ok");
    expect(okBub?.textContent).not.toContain("✅");
    expect(okBub?.querySelector("svg.ic")).not.toBeNull();

    const info = mount(<HistoryItem entry={{ kind: "notice", text: "ℹ️ 提示行" }} />);
    const infoBub = info.querySelector(".notice-bub");
    expect(infoBub?.getAttribute("data-variant")).toBe("info");
    expect(infoBub?.textContent).not.toContain("ℹ️");
    expect(infoBub?.querySelector("svg")).toBeNull();
  });

  it("纯文本通知不变：无前缀 → info、无字形、textContent 逐字保留（0.3.6 反馈契约不破）", () => {
    const c = mount(<HistoryItem entry={{ kind: "notice", text: "已切换到简洁模式 — 重载后完全生效" }} />);
    const bub = c.querySelector(".entry-notice > .notice-bub");
    expect(bub?.getAttribute("data-variant")).toBe("info");
    expect(bub?.textContent).toBe("已切换到简洁模式 — 重载后完全生效");
    expect(bub?.querySelector("svg")).toBeNull();
  });

  it("折叠通知组（≥2 条同文）头行同律：warn 变体、正文剥前缀", () => {
    const history: readonly HistoryEntry[] = [
      { kind: "notice", text: "⚠️ 同一条警示" },
      { kind: "notice", text: "⚠️ 同一条警示" },
    ];
    const c = mount(<HistoryList history={history} />);
    const head = c.querySelector(".noticegroup > .grp-head");
    expect(head).not.toBeNull();
    expect(head?.getAttribute("data-variant")).toBe("warn");
    expect(head?.textContent).not.toContain("⚠️");
    expect(head?.textContent).toContain("同一条警示");
    expect(head?.textContent).toContain("×2");
  });
});

describe("变体 CSS 令牌消费（decl 钉 as-declared）", () => {
  it("通知气泡/toast/回执行三面：warn/ok 走语义色令牌", () => {
    expect(decl('.notice-bub[data-variant="warn"]', "color")).toBe("var(--warn)");
    expect(decl('.notice-bub[data-variant="ok"]', "color")).toBe("var(--ok)");
    expect(decl('.settings-toast[data-variant="warn"]', "color")).toBe("var(--warn)");
    expect(decl('.settings-toast[data-variant="ok"]', "color")).toBe("var(--ok)");
    expect(decl('.settings-receipts > div[data-variant="ok"]', "color")).toBe("var(--ok)");
    expect(decl('.settings-receipts > div[data-variant="info"]', "color")).toBe("var(--text-2)");
  });
});
