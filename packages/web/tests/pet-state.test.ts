// ω99-98 — the pet state machine, RED-first: the FULL matrix of the frozen
// contract in src/pet/pet-state.ts. Pure functions with an injected `now` —
// zero clock, zero DOM, zero React (node env on purpose). ω99-99's
// cross-window relay will map DriverStatus snapshots onto PetInput verbatim;
// these pins are what make that mapping safe without a real window.
import { describe, expect, it } from "vitest";
import {
  initialPetMachineState,
  petSteadyState,
  stepPetMachine,
  PET_DONE_MS,
  type PetInput,
  type PetMachineState,
} from "../src/pet/pet-state.js";

const idleLive = { reasoning: "", answer: "", busyTools: [] };

/** A snapshot with overrides — the ω99-99 relay's exact input shape. */
const input = (o: Partial<PetInput> = {}): PetInput => ({
  busy: false,
  pendingPermission: null,
  live: idleLive,
  ...o,
});

/** A machine state with overrides. */
const m = (o: Partial<PetMachineState> = {}): PetMachineState => ({
  display: "idle",
  busy: false,
  doneAt: null,
  ...o,
});

describe("ω99-98 pet 状态机（纯函数契约）", () => {
  it("PET_DONE_MS = 1500", () => {
    expect(PET_DONE_MS).toBe(1500);
  });

  it("初值：{display:idle, busy:false, doneAt:null}，每次调用返回新对象", () => {
    expect(initialPetMachineState()).toEqual({ display: "idle", busy: false, doneAt: null });
    expect(initialPetMachineState()).not.toBe(initialPetMachineState());
  });

  describe("petSteadyState 优先级（自上而下）", () => {
    it("空快照 → idle", () => {
      expect(petSteadyState(input())).toBe("idle");
    });

    it("pendingPermission ≠ null/undefined → waiting-user，压制一切（工具/推理/回答同非空也算）", () => {
      const full = input({
        pendingPermission: { toolName: "Bash", summary: "rm", input: {} },
        live: { reasoning: "想着…", answer: "答着…", busyTools: [{ name: "Read" }] },
      });
      expect(petSteadyState(full)).toBe("waiting-user");
      // ≠null/≠undefined 即在等：任何非空值都算（含空串/0），null 和 undefined 不算。
      expect(petSteadyState(input({ pendingPermission: undefined }))).toBe("idle");
      expect(petSteadyState(input({ pendingPermission: null, live: { reasoning: "r", answer: "", busyTools: [] } }))).toBe("thinking");
    });

    it("工具 > 推理 > 回答：三者同非空 → working；去掉工具 → thinking；再去掉推理 → answering", () => {
      const all = input({ live: { reasoning: "r", answer: "a", busyTools: [{ name: "Read" }] } });
      expect(petSteadyState(all)).toBe("working");
      expect(petSteadyState(input({ live: { reasoning: "r", answer: "a", busyTools: [] } }))).toBe("thinking");
      expect(petSteadyState(input({ live: { reasoning: "", answer: "a", busyTools: [] } }))).toBe("answering");
    });

    it("只有回答流 → answering", () => {
      expect(petSteadyState(input({ live: { reasoning: "", answer: "部分回答", busyTools: [] } }))).toBe("answering");
    });
  });

  describe("stepPetMachine 决策表", () => {
    it("input.busy → display=steady：done 中新工作立即离开（含 busy 但 live 尚空的 idle 态）", () => {
      // done 保持期内来了新工作（工具在飞）→ 立即 working。
      const fromDone = m({ display: "done", busy: false, doneAt: 1_000 });
      const r1 = stepPetMachine(fromDone, input({ busy: true, live: { reasoning: "", answer: "", busyTools: [{ name: "Read" }] } }), 1_100);
      expect(r1.display).toBe("working");
      // busy=true 但 live 全空 → steady=idle（display 跟 steady，不是 done）。
      const r2 = stepPetMachine(fromDone, input({ busy: true }), 1_100);
      expect(r2.display).toBe("idle");
      expect(r2.busy).toBe(true);
    });

    it("steady=waiting-user → display=waiting-user：压过 done 保持，也压过下降沿的庆祝", () => {
      // 1) done 窗口内，用户被问到 → 立即 waiting-user（不等 done 放完）。
      const holding = m({ display: "done", busy: false, doneAt: 1_000 });
      expect(stepPetMachine(holding, input({ pendingPermission: {} }), 1_200).display).toBe("waiting-user");
      // 2) busy 下降沿恰逢等用户 → waiting-user，绝不进 done。
      const edge = m({ display: "working", busy: true, doneAt: null });
      const r = stepPetMachine(edge, input({ busy: false, pendingPermission: { toolName: "Bash" } }), 9_000);
      expect(r.display).toBe("waiting-user");
      expect(r.doneAt).toBeNull();
    });

    it("busy 下降沿 → done + doneAt=now（时钟注入，非 Date.now）", () => {
      const r = stepPetMachine(m({ display: "working", busy: true, doneAt: null }), input({ busy: false }), 10_000);
      expect(r).toEqual({ display: "done", busy: false, doneAt: 10_000 });
    });

    it("done 窗口内保持：1499ms 处仍 done、doneAt 不变、steady 不透出", () => {
      const holding = m({ display: "done", busy: false, doneAt: 1_000 });
      // live 有推理流（steady=thinking），但保持规则在 steady 之前 → 仍 done。
      const r = stepPetMachine(holding, input({ live: { reasoning: "还在", answer: "", busyTools: [] } }), 1_000 + PET_DONE_MS - 1);
      expect(r.display).toBe("done");
      expect(r.doneAt).toBe(1_000);
    });

    it("满 1500ms → 回 steady（恰好 1500 的边界即离开）", () => {
      const holding = m({ display: "done", busy: false, doneAt: 1_000 });
      expect(stepPetMachine(holding, input(), 1_000 + PET_DONE_MS).display).toBe("idle");
      expect(stepPetMachine(holding, input(), 99_999).display).toBe("idle");
    });

    it("display=done 但 doneAt=null（防御分支）→ 直接 steady", () => {
      const guard = m({ display: "done", busy: false, doneAt: null });
      expect(stepPetMachine(guard, input(), 500).display).toBe("idle");
    });

    it("无下降沿的空闲步：display=steady，busy 恒跟 input.busy", () => {
      const answering = input({ live: { reasoning: "", answer: "a", busyTools: [] } });
      const r = stepPetMachine(m(), answering, 1);
      expect(r).toEqual({ display: "answering", busy: false, doneAt: null });
      const r2 = stepPetMachine(r, input({ busy: true, live: answering.live }), 2);
      expect(r2.busy).toBe(true);
      expect(r2.display).toBe("answering");
    });
  });

  describe("不可变性", () => {
    it("各分支都返回新对象（=== 永不成立）", () => {
      const base = m({ display: "done", busy: false, doneAt: 1_000 });
      const outs = [
        stepPetMachine(base, input({ busy: true }), 1_100),
        stepPetMachine(base, input({ busy: false, pendingPermission: {} }), 1_100),
        stepPetMachine(base, input(), 1_100), // 保持分支
        stepPetMachine(base, input(), 9_999), // 超时分支
        stepPetMachine(m({ busy: true }), input(), 5), // 下降沿分支
      ];
      for (const o of outs) {
        expect(o).not.toBe(base);
        expect(typeof o).toBe("object");
      }
    });

    it("不改写输入状态 m（Object.freeze 下各分支不炸且原值不变）", () => {
      const frozen = Object.freeze(m({ display: "done", busy: false, doneAt: 1_000 }));
      expect(() => stepPetMachine(frozen, input({ busy: true }), 2)).not.toThrow();
      expect(() => stepPetMachine(frozen, input(), 2)).not.toThrow();
      expect(frozen).toEqual({ display: "done", busy: false, doneAt: 1_000 });
    });

    it("petSteadyState 不改写 input", () => {
      const live: PetInput["live"] = { reasoning: "r", answer: "", busyTools: [] };
      const i = Object.freeze(input({ live: Object.freeze(live) }));
      expect(() => petSteadyState(i)).not.toThrow();
      expect(petSteadyState(i)).toBe("thinking");
    });
  });

  describe("ω99-103 doneAt 不变式（display ≠ done ⟹ doneAt === null）", () => {
    /** 统一起点：庆祝中（done 窗口内），doneAt=1_000。 */
    const fromDone = (): PetMachineState => m({ display: "done", busy: false, doneAt: 1_000 });

    it("超时离开 done（≥PET_DONE_MS）→ doneAt 归零（离开 done 的主路径）", () => {
      const r = stepPetMachine(fromDone(), input(), 1_000 + PET_DONE_MS);
      expect(r.display).toBe("idle");
      expect(r.doneAt).toBeNull();
    });

    it("busy 离开 done（保持期内新工作）→ doneAt 归零", () => {
      const r = stepPetMachine(fromDone(), input({ busy: true, live: { reasoning: "", answer: "", busyTools: [{ name: "Read" }] } }), 1_100);
      expect(r.display).toBe("working");
      expect(r.doneAt).toBeNull();
    });

    it("waiting-user 离开 done（保持期内等用户）→ doneAt 归零", () => {
      const r = stepPetMachine(fromDone(), input({ pendingPermission: { toolName: "Bash" } }), 1_200);
      expect(r.display).toBe("waiting-user");
      expect(r.doneAt).toBeNull();
    });

    it("display=done 时 doneAt 保留：进入（下降沿 doneAt=now）与窗口内保持都不被清", () => {
      const entered = stepPetMachine(m({ display: "working", busy: true, doneAt: null }), input({ busy: false }), 10_000);
      expect(entered).toEqual({ display: "done", busy: false, doneAt: 10_000 });
      const held = stepPetMachine(entered, input(), 10_000 + PET_DONE_MS - 1);
      expect(held.display).toBe("done");
      expect(held.doneAt).toBe(10_000);
    });
  });
});
