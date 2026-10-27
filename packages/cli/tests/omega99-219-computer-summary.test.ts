// ω99-219: #R1 — 电脑操作六工具的 transcript summary receipts（先红后绿：
// 红=六例缺位，summarizeToolCall 的 default 分支返回空串——控制器实测的
// 现状；后绿=六例落进 log.ts）。纯函数直钉：动作行是 TUI 转录/权限确认/
// live 行共用的单源（agent-driver o.summarize 缝），这里钉的就是用户读到
// 的那一行括号内容。夹具全内存字面量——零文件系统、零键鼠、零截屏（212
// 既立红线：computer-use 相关测试全 mock，本面根本不触执行层）。
import { describe, expect, it } from "vitest";
import { summarizeToolCall } from "../src/log.js";

describe("summarizeToolCall 电脑操作六例 (ω99-219)", () => {
  it("computer_type -> 短文原样（空白折叠成单行）", () => {
    expect(summarizeToolCall("computer_type", { text: "在备忘录记一条" })).toBe("在备忘录记一条");
    expect(summarizeToolCall("computer_type", { text: "a  b   c" })).toBe("a b c");
    expect(summarizeToolCall("computer_type", { text: "  前后空白  " })).toBe("前后空白");
  });

  it("computer_type -> 长文前 20 字 + …N 字（N=被截掉的字数）", () => {
    // 25 个汉字：前 20 原样，尾 5 以「…5 字」告知还有多少没显示
    const text25 = "一二三四五六七八九十一二三四五六七八九零一二三四五";
    expect(summarizeToolCall("computer_type", { text: text25 })).toBe(
      "一二三四五六七八九十一二三四五六七八九零…5 字",
    );
  });

  it("computer_type -> 恰 20 字不加省略号（边界值）", () => {
    const text20 = "一二三四五六七八九十一二三四五六七八九零";
    expect(summarizeToolCall("computer_type", { text: text20 })).toBe(text20);
  });

  it("computer_type -> 按码点计数（emoji 不劈半、不计成 2 字）", () => {
    const emojis = "😀".repeat(21); // UTF-16 length 42，码点 21
    expect(summarizeToolCall("computer_type", { text: emojis })).toBe(`${"😀".repeat(20)}…1 字`);
  });

  it("computer_type -> 空文本/缺席回退空串", () => {
    expect(summarizeToolCall("computer_type", {})).toBe("");
    expect(summarizeToolCall("computer_type", { text: "" })).toBe("");
  });

  it("computer_key -> 组合键串原样", () => {
    expect(summarizeToolCall("computer_key", { key: "cmd+c" })).toBe("cmd+c");
    expect(summarizeToolCall("computer_key", { key: "return" })).toBe("return");
    expect(summarizeToolCall("computer_key", { key: "shift+cmd+t" })).toBe("shift+cmd+t");
  });

  it("computer_click -> (x, y) 坐标（与工具自身回执同格式）", () => {
    expect(summarizeToolCall("computer_click", { x: 512, y: 384 })).toBe("(512, 384)");
    expect(summarizeToolCall("computer_click", { x: 0, y: 0 })).toBe("(0, 0)");
  });

  it("computer_click -> 坐标缺席/非数值回退空串（不编造位置）", () => {
    expect(summarizeToolCall("computer_click", {})).toBe("");
    expect(summarizeToolCall("computer_click", { x: "512", y: 384 })).toBe("");
    expect(summarizeToolCall("computer_click", { x: Number.NaN, y: 1 })).toBe("");
  });

  it("app_activate -> 应用名（名字或 bundle id 原样）", () => {
    expect(summarizeToolCall("app_activate", { app: "备忘录" })).toBe("备忘录");
    expect(summarizeToolCall("app_activate", { app: "com.apple.Calculator" })).toBe("com.apple.Calculator");
  });

  it("screen_capture -> 全屏（无参数工具的固定动作词）", () => {
    expect(summarizeToolCall("screen_capture", {})).toBe("全屏");
  });

  it("app_list -> 列表（无参数工具的固定动作词）", () => {
    expect(summarizeToolCall("app_list", {})).toBe("列表");
  });

  it("老工具零漂移：既有例与未知工具逐字节不变（加法不改旧面）", () => {
    expect(summarizeToolCall("shell", { command: "ls" })).toBe("ls");
    expect(summarizeToolCall("read_file", { path: "a.ts" })).toBe("a.ts");
    expect(summarizeToolCall("write_file", { path: "b.ts" })).toBe("b.ts");
    expect(summarizeToolCall("edit", { path: "c.ts" })).toBe("c.ts");
    expect(summarizeToolCall("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(summarizeToolCall("grep", { pattern: "summarize" })).toBe("summarize");
    expect(summarizeToolCall("web_fetch", { url: "https://example.com" })).toBe("https://example.com");
    expect(summarizeToolCall("web_search", { query: "agent harness" })).toBe("agent harness");
    expect(summarizeToolCall("zzz", { x: 1 })).toBe("");
  });
});
