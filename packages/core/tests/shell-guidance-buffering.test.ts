// 2026-11-06 Terminal-Bench 取证 — 长命令管道缓冲这条纪律。
//
// 实测形态：agent 把一条要跑十几分钟的 `apt-get install` 写成
// `... 2>&1 | tail -3`。管道把输出全缓冲住，整个调用期间零反馈——既看不出
// 进度也看不出卡住，模型只能干等。这不是模型笨，是没人告诉过它。
//
// 提示词里的纪律不是装饰：它改的是模型下一次的行为。这条钉子保证那句话
// 不会被后续编辑悄悄删掉。
import { describe, it, expect } from "vitest";
import { createShellTool } from "../src/tools/shell.js";

describe("shell 工具的长命令纪律", () => {
  const tool = createShellTool({});

  it("明确禁止把长命令管道给 tail/head", () => {
    const g = (tool.promptGuidelines ?? []).join("\n");
    expect(g).toMatch(/tail\/head/i);
    expect(g).toMatch(/zero feedback/i);
  });

  it("给出替代做法（流式输出 / monitor_start）", () => {
    const g = (tool.promptGuidelines ?? []).join("\n");
    expect(g).toMatch(/monitor_start|stream/i);
  });

  it("这条纪律是静态字节（前缀缓存：不得含每次运行的变量）", () => {
    const a = createShellTool({}).promptGuidelines;
    const b = createShellTool({}).promptGuidelines;
    expect(a).toEqual(b);
  });
});
