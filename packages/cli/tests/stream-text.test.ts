// ω99-41 — TextBuffer 单元：流式文本线性累积的纯数据结构。
// 结构性证明 joins ≪ pushes（每观察窗一次 join，非每 push 一次整串拷贝），
// 以及空取不计 join、reset 清内容不清 stats、双 buffer 独立。
import { describe, it, expect } from "vitest";
import { createTextBuffer } from "../src/stream-text.js";

describe("ω99-41 TextBuffer — 线性累积", () => {
  it("push ×5000 → takeJoined 一次：文本逐段拼接，joins===1（joins ≪ pushes 的结构性证明）", () => {
    const buf = createTextBuffer();
    const pieces: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const piece = `块${i};`;
      pieces.push(piece);
      buf.push(piece);
    }
    const joined = buf.takeJoined();
    // 逐段拼接的期望值只用一次 join 之外的路径构造（reduce 语义参照）。
    const expected = pieces.reduce((acc, p) => acc + p, "");
    expect(joined).toBe(expected);
    expect(buf.stats.pushes).toBe(5000);
    expect(buf.stats.joins).toBe(1);
    // 取走后缓冲清空：length 不 join 即为 0。
    expect(buf.length()).toBe(0);
  });

  it("多窗：push→take→push→take 两轮 → joins===2（每窗一次，非每 push）", () => {
    const buf = createTextBuffer();
    buf.push("第一窗");
    expect(buf.takeJoined()).toBe("第一窗");
    buf.push("第二");
    buf.push("窗");
    expect(buf.takeJoined()).toBe("第二窗");
    expect(buf.stats.pushes).toBe(3);
    expect(buf.stats.joins).toBe(2);
  });

  it("空取：takeJoined 空缓冲返回 \"\" 且 joins 不增", () => {
    const buf = createTextBuffer();
    expect(buf.takeJoined()).toBe("");
    expect(buf.stats.joins).toBe(0);
    buf.push("a");
    expect(buf.takeJoined()).toBe("a");
    // 取尽后再取：空取不计数。
    expect(buf.takeJoined()).toBe("");
    expect(buf.stats.joins).toBe(1);
  });

  it("reset：push 后 reset → takeJoined \"\"；stats 跨 reset 存活", () => {
    const buf = createTextBuffer();
    buf.push("旧epoch");
    buf.push("的尾巴");
    buf.reset();
    expect(buf.length()).toBe(0);
    expect(buf.takeJoined()).toBe("");
    // stats 是 per-driver 生命周期观测，不随 epoch 整清。
    expect(buf.stats.pushes).toBe(2);
    expect(buf.stats.joins).toBe(0);
  });

  it("交错：answer/reasoning 两 buffer 完全独立", () => {
    const answerBuf = createTextBuffer();
    const reasoningBuf = createTextBuffer();
    // 交错 push（流式推理与正文的真实到达序）。
    reasoningBuf.push("想一");
    answerBuf.push("答");
    reasoningBuf.push("想二");
    answerBuf.push("案");
    expect(answerBuf.takeJoined()).toBe("答案");
    expect(reasoningBuf.takeJoined()).toBe("想一想二");
    expect(answerBuf.stats.pushes).toBe(2);
    expect(reasoningBuf.stats.pushes).toBe(2);
    // 一侧 reset 不影响另一侧。
    answerBuf.push("下一轮");
    reasoningBuf.reset();
    expect(answerBuf.takeJoined()).toBe("下一轮");
    expect(reasoningBuf.takeJoined()).toBe("");
  });
});
