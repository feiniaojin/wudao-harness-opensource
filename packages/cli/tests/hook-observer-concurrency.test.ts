// 0.3.91 gate 清偿 rider — observe-only hook 包装器的并发安全旗标传播律。
// 背景：ω99-314/319 两个 observer 常驻 onPreToolUse 但未声明
// toolHooksConcurrencySafe → loop 的 ω-5b R9 谓词把所有多工具并行批降级
// 串行（ω99-63 探针是唯一走全 driver 并行批的钉，0.3.91 gate 首逮——
// 0.3.89/0.3.90 两版聚焦发版未跑 gate，静默回归两版）。
// 传播律：observer 自身面安全可声明 true；内链已证 true 保持；内链未证
// 不替别人声明（undefined → loop 走串行，保守正确）。
import { describe, it, expect } from "vitest";
import { withCommandFootprint } from "../src/cmd-footprint.js";
import { createSnapshotStore, withSnapshotCapture } from "../src/snapshots.js";
import type { AgentHooks } from "@wudao-org/core";

const fpDeps = {
  liveRoot: () => undefined, // hooks 永不被调用——只查旗标形状
  emit: () => { /* no-op */ },
} as const;

describe("0.3.91 — observe-only hook 包装器声明并发安全（传播律三名）", () => {
  it("withCommandFootprint：无基础 hooks → true（纯观察者可声明）", () => {
    expect(withCommandFootprint(undefined, fpDeps)?.toolHooksConcurrencySafe).toBe(true);
  });

  it("withCommandFootprint：未证基础链 → 不替别人声明（≠ true）", () => {
    const base: AgentHooks = { onPreToolUse: async () => { /* 外部 hook 未证 */ } };
    expect(withCommandFootprint(base, fpDeps)?.toolHooksConcurrencySafe).not.toBe(true);
  });

  it("withCommandFootprint：内链已证 true → 保持 true", () => {
    const base: AgentHooks = { toolHooksConcurrencySafe: true };
    expect(withCommandFootprint(base, fpDeps)?.toolHooksConcurrencySafe).toBe(true);
  });

  it("withSnapshotCapture：同律（store 在场才包；构造零落盘）", () => {
    const store = createSnapshotStore("/tmp");
    const root = () => "/tmp";
    expect(withSnapshotCapture(undefined, store, root)?.toolHooksConcurrencySafe).toBe(true);
    const unproven: AgentHooks = { onPreToolUse: async () => { /* 同上 */ } };
    expect(withSnapshotCapture(unproven, store, root)?.toolHooksConcurrencySafe).not.toBe(true);
    const proven: AgentHooks = { toolHooksConcurrencySafe: true };
    expect(withSnapshotCapture(proven, store, root)?.toolHooksConcurrencySafe).toBe(true);
  });

  it("端到端语义由 omega99-63 并行批探针钉（本文件只钉旗标传播形状）", () => {
    // 占位自证：文件存在即纪律——端到端不在此重复（ω99-63 test 2 是唯一
    // 走全 driver 并行批的钉；它红=旗标链断了，不必再来一份）。
    expect(true).toBe(true);
  });
});
