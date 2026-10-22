// 121 项 1 — the AIMD gate's pure state machine (the upstream format 498490680 +
// the upstream project 5362cf300 形). Everything here is synchronous and in-memory:
// additive increase on success, multiplicative decrease on overload-class
// observations, clamped into [min, max], floor 1 by default. No persistence
// exists anywhere in the module — provider capacity is transient state.
import { describe, it, expect } from "vitest";
import { AimdGate } from "../src/agents/aimd.js";

describe("AimdGate state machine (121 项 1)", () => {
  it("starts at max by default — the zero-behavior-change default (initial = the static cap it replaces)", () => {
    expect(new AimdGate({ max: 3 }).current()).toBe(3);
    expect(new AimdGate({ max: 16 }).current()).toBe(16);
    expect(new AimdGate({ max: 1 }).current()).toBe(1);
  });

  it("honors a custom initial, clamped into [min, max] rather than refusing", () => {
    expect(new AimdGate({ max: 8, initial: 2 }).current()).toBe(2);
    expect(new AimdGate({ max: 8, initial: 99 }).current()).toBe(8);
    expect(new AimdGate({ max: 8, initial: 0 }).current()).toBe(1);
    expect(new AimdGate({ max: 8, min: 2, initial: 0 }).current()).toBe(2);
  });

  it("onSuccess adds 1 until the ceiling, then holds (additive increase)", () => {
    const gate = new AimdGate({ max: 4, initial: 1 });
    gate.onSuccess();
    expect(gate.current()).toBe(2);
    gate.onSuccess();
    gate.onSuccess();
    expect(gate.current()).toBe(4);
    gate.onSuccess();
    expect(gate.current()).toBe(4); // capped
  });

  it("onThrottle halves toward 1 and never reaches 0 (multiplicative decrease, floor = min)", () => {
    const gate = new AimdGate({ max: 16 });
    gate.onThrottle();
    expect(gate.current()).toBe(8);
    gate.onThrottle();
    expect(gate.current()).toBe(4);
    gate.onThrottle();
    expect(gate.current()).toBe(2);
    gate.onThrottle();
    expect(gate.current()).toBe(1);
    gate.onThrottle();
    expect(gate.current()).toBe(1); // floored — recovery needs one in-flight probe
  });

  it("the classic AIMD sawtooth: collapse under storms, slow regrow in calm", () => {
    const gate = new AimdGate({ max: 8 });
    gate.onThrottle(); // 8 → 4
    gate.onThrottle(); // 4 → 2
    expect(gate.current()).toBe(2);
    gate.onSuccess(); // +1
    gate.onSuccess();
    expect(gate.current()).toBe(4);
    gate.onThrottle(); // back down instantly — decrease is multiplicative
    expect(gate.current()).toBe(2);
  });

  it("an odd ceiling floors rather than truncates oddly (3 → 1, 5 → 2)", () => {
    expect(new AimdGate({ max: 3 }).current()).toBe(3);
    const three = new AimdGate({ max: 3 });
    three.onThrottle();
    expect(three.current()).toBe(1);
    const five = new AimdGate({ max: 5 });
    five.onThrottle();
    expect(five.current()).toBe(2);
  });

  it("a degenerate max=1 gate is a pure static cap of 1 (no AIMD dynamic range left)", () => {
    const gate = new AimdGate({ max: 1 });
    gate.onThrottle();
    expect(gate.current()).toBe(1);
    gate.onSuccess();
    expect(gate.current()).toBe(1);
  });

  it("constructor refuses impossible policy (fail-closed): min < 1, non-integers, max < min", () => {
    expect(() => new AimdGate({ max: 3, min: 0 })).toThrow(/min/);
    expect(() => new AimdGate({ max: 2.5 })).toThrow(/max/);
    expect(() => new AimdGate({ max: 2, min: 4 })).toThrow(/max/);
    expect(() => new AimdGate({ max: 4, initial: 1.5 })).toThrow(/initial/);
  });
});
