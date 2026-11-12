// 0.5.11 报障修（Buddy 模式切模型不生效）——车道快照 model 块的两枚钉：
// ① mergeLaneStatuses 值稳定携带（server 每帧重建状态对象，身份比对会让
//    快照逐帧 churn；签名只随真实切换移动）；
// ② applyLaneHistory 重建不丢 model（带 sid 的 history 帧曾把状态帧刚带
//    来的模型面静默抹掉——副车道 chip 因此永远空）。
import { describe, it, expect } from "vitest";
import { applyLaneHistory, mergeLaneStatuses } from "../src/protocol-wire.js";

const model = {
  label: "glm-5.3",
  provider: "glm-code",
  choices: [
    { provider: "glm-code", model: "glm-5.3", source: "registry" },
    { provider: "deepseek", model: "deepseek-v3.2", source: "registry" },
  ],
};

describe("0.5.11 — 车道快照的 model 面", () => {
  it("merge 携带 model；同值新对象（server 每帧重建）身份稳定；label/provider/矩阵任一变化才换身份", () => {
    const a = mergeLaneStatuses(undefined, { L1: { busy: false, sessionId: "s", model } });
    expect(a?.L1?.model?.provider).toBe("glm-code");
    expect(a?.L1?.model?.choices).toHaveLength(2);
    // 等值深拷贝 → 同一快照对象（无 churn）。
    const b = mergeLaneStatuses(a, { L1: { busy: false, sessionId: "s", model: structuredClone(model) } });
    expect(b).toBe(a);
    // provider 换（真实切换）→ 新身份。
    const c = mergeLaneStatuses(b, { L1: { busy: false, sessionId: "s", model: { ...model, label: "deepseek-v3.2", provider: "deepseek" } } });
    expect(c).not.toBe(b);
    expect(c?.L1?.model?.provider).toBe("deepseek");
  });

  it("applyLaneHistory 的 append 与 reset 都保留既有 model 块", () => {
    const a = mergeLaneStatuses(undefined, { L1: { busy: false, sessionId: "s", model } });
    const appended = applyLaneHistory(a, "L1", [{ kind: "user", text: "x" } as never], false);
    expect(appended.L1?.model?.provider).toBe("glm-code");
    expect(appended.L1?.history).toHaveLength(1);
    const reset = applyLaneHistory(appended, "L1", [], true);
    expect(reset.L1?.model?.provider).toBe("glm-code");
    expect(reset.L1?.historyEpoch).toBe(1);
  });
});
