// ω-long-2 follow-up — 「无限跑下去」必须真的接到产品路径上。
//
// 这条钉子的由来是一个真缺陷：上一轮只在 REPL 里装备了 continuation，
// TUI 和 web/pet 两条主路径压根没传 maxSlices，于是「撞上限不再退出」对
// 绝大多数用户根本不存在——core 的机制测再绿也白搭。缺省值必须收在一处
// （version.ts 的 defaultMaxSlices），三条产品路径都从这里取，才能不再各
// 自漂移。
import { describe, it, expect, afterEach } from "vitest";
import { defaultMaxSlices } from "../src/version.js";

const prev = process.env.WUDAO_MAX_SLICES;
afterEach(() => {
  if (prev === undefined) delete process.env.WUDAO_MAX_SLICES;
  else process.env.WUDAO_MAX_SLICES = prev;
});

describe("defaultMaxSlices — 切片名额的缺省与覆盖", () => {
  it("未设置 → 无限（产品意图：无限重置不退出）", () => {
    delete process.env.WUDAO_MAX_SLICES;
    expect(defaultMaxSlices()).toBe(Number.POSITIVE_INFINITY);
  });

  it("WUDAO_MAX_SLICES=0 → 关掉切片，maxTurns 退回硬停", () => {
    process.env.WUDAO_MAX_SLICES = "0";
    expect(defaultMaxSlices()).toBe(0);
  });

  it("正整数 → 该数值（向下取整）", () => {
    process.env.WUDAO_MAX_SLICES = "7";
    expect(defaultMaxSlices()).toBe(7);
    process.env.WUDAO_MAX_SLICES = "3.9";
    expect(defaultMaxSlices()).toBe(3);
  });

  it("非法/负数 → 落回缺省（不因环境变量写错就放开或锁死）", () => {
    for (const bad of ["abc", "", "-1", "Infinity"]) {
      process.env.WUDAO_MAX_SLICES = bad;
      expect(defaultMaxSlices()).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it("调用方可指定不同 fallback（库面向调用时保守）", () => {
    delete process.env.WUDAO_MAX_SLICES;
    expect(defaultMaxSlices(12)).toBe(12);
  });
});
