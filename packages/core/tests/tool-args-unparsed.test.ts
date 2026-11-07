import { describe, expect, it } from "vitest";
import { validateToolArguments } from "../src/tool.js";

// 2026-11-06 Terminal-Bench 取证（headless-terminal 一轮）：
// provider 的三条线上游（anthropic / responses / openai）在**工具参数 JSON
// 无法解析**时统一落到 `{ _unparsed: "<原始字符串>" }` 兜底——这是有意的
// 可见约定，不是空对象。但核心的校验器不认识它，于是报
//   missing required argument "command" for ext_container_exec (expected: string …)
// 模型读到「缺参数」，去补一个本来就在的字段，白烧轮次。真实原因是那段
// JSON 没解析出来。校验器必须把这个区别说出来。

const schema = {
  type: "object" as const,
  properties: { command: { type: "string" as const, description: "要执行的 shell 命令" } },
  required: ["command"],
  additionalProperties: false,
};

describe("tool args: _unparsed 兜底必须被识别", () => {
  it("报告解析失败，而不是「缺参数」", () => {
    const r = validateToolArguments(schema, { _unparsed: '{"command": "ls -la /app"' }, "ext_container_exec");
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.error).not.toContain("missing required argument");
    expect(r.error).toContain("ext_container_exec");
    // 原始片段要露出来一段，模型才知道自己发的是什么
    expect(r.error).toContain("ls -la /app");
  });

  it("单独出现的 _unparsed 与真实未知参数仍要区分", () => {
    const r = validateToolArguments(schema, { command: "ls", bogusKey: 1 }, "ext_container_exec");
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.error).toContain("unknown argument");
  });

  it("参数恰好叫 _unparsed 的合法工具不受影响（只有兜底形态才改口径）", () => {
    const s2 = {
      type: "object" as const,
      properties: { _unparsed: { type: "string" as const } },
      required: ["_unparsed"],
    };
    const r = validateToolArguments(s2, { _unparsed: "hello" }, "weird_tool");
    expect(r.valid).toBe(true);
  });
});
