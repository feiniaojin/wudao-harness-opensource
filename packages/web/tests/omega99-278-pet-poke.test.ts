// ω99-278: #2 — 戳一戳纯层（poke.ts）收据：三常量对表（含 650>600 与
// CLICK_MS 的天然互斥钉——不 import main.tsx（入口顶层挂载，不可进测试），
// 阈值以字面 600 对表）、pickExpression 轮选不连击（rand 注入 0/0.99 边界、
// 池外 last 全池可选、越界 rand 防御）、isDragRelease 四象（超阈真拖/阈内
// 单击/cancel 永假/无坐标假）。node env on purpose：零 DOM、零 React、
// clock/random-free（busy-narration/pet-chat 同款纯模块先例）。
import { describe, expect, it } from "vitest";
import {
  isDragRelease,
  isWindowCarried,
  pickExpression,
  POKE_EXPRESSIONS,
  POKE_EXPR_MS,
  POKE_HOLD_MS,
  POKE_SQUASH_MS,
} from "../src/pet/poke.js";

const pool = [...POKE_EXPRESSIONS];
/** noUncheckedIndexedAccess 下的池取值（缺位=池被改坏，测试自身先炸）。 */
const at = (i: number): string => {
  const v = POKE_EXPRESSIONS[i];
  if (v === undefined) throw new Error(`pool[${i}] missing`);
  return v;
};

describe("ω99-278 常量对表（戳/表情/squash）", () => {
  it("POKE_HOLD_MS = 650，且 > 600（CLICK_MS 字面）——戳与单击天然互斥，无需仲裁延迟", () => {
    expect(POKE_HOLD_MS).toBe(650);
    expect(POKE_HOLD_MS).toBeGreaterThan(600); // main.tsx CLICK_MS：单击窗上限
  });

  it("POKE_EXPR_MS = 2200（表情两秒后消失）；POKE_SQUASH_MS = 600（CSS pet-squash 0.6s 同值）", () => {
    expect(POKE_EXPR_MS).toBe(2200);
    expect(POKE_SQUASH_MS).toBe(600);
  });

  it("表情池恰六句萌系短句且互不重复（轮选的前提）", () => {
    expect(pool).toHaveLength(6);
    expect(new Set(pool).size).toBe(6);
    expect(pool).toContain("呀！");
    expect(pool).toContain("在呢在呢～");
    expect(pool).toContain("有什么吩咐？");
  });
});

describe("ω99-278 pickExpression（轮选不连击）", () => {
  it("last=null：rand 0 → 池首；rand 0.99 → 池尾（全池可选）", () => {
    expect(pickExpression(null, () => 0)).toBe(at(0));
    expect(pickExpression(null, () => 0.99)).toBe(at(5));
  });

  it("last 在池内：rand 0 → 池首之后首个非 last；rand 0.99 → 池尾（若池尾=last 则退池次尾）", () => {
    expect(pickExpression(at(0), () => 0)).toBe(at(1));
    expect(pickExpression(at(0), () => 0.99)).toBe(at(5));
    expect(pickExpression(at(5), () => 0.99)).toBe(at(4));
  });

  it("不连击不变式：last 在池内时，任意 rand 扫描永不返回 last", () => {
    for (const last of pool) {
      for (let i = 0; i <= 20; i++) {
        const r = i / 20 * 0.9999;
        const got = pickExpression(last, () => r);
        expect(got, `last=${last} r=${r}`).not.toBe(last);
        expect(pool).toContain(got);
      }
    }
  });

  it("last 池外（含 null）：全池可选——池外值不剔除任何位", () => {
    expect(pickExpression("不在池内", () => 0)).toBe(at(0));
    expect(pickExpression("不在池内", () => 0.99)).toBe(at(5));
  });

  it("rand 越界防御：负数/≥1/NaN 一律收敛到池首区间（生产注入 Math.random 不触发）", () => {
    expect(pool).toContain(pickExpression(null, () => 1));
    expect(pool).toContain(pickExpression(null, () => -0.5));
    expect(pool).toContain(pickExpression(null, () => NaN));
  });
});

describe("ω99-278 isDragRelease（松手分类四象）", () => {
  const press = (x: number, y: number) => ({ x, y, t: 0 });
  const up = (x: number, y: number, type = "pointerup") => ({ clientX: x, clientY: y, type });

  it("位移超阈（≥5px）→ true（真·拖拽释放，回弹）", () => {
    expect(isDragRelease(press(100, 100), up(130, 100))).toBe(true); // 纯水平 30px
    expect(isDragRelease(press(100, 100), up(100, 130))).toBe(true); // 纯垂直 30px
    expect(isDragRelease(press(100, 100), up(103, 104))).toBe(true); // 5px 整（≥阈）
  });

  it("位移阈内（<5px）→ false（单击走旧路，不回弹）", () => {
    expect(isDragRelease(press(100, 100), up(101, 101))).toBe(false); // √2 < 5
    expect(isDragRelease(press(100, 100), up(100, 100))).toBe(false); // 原地
  });

  it("pointercancel 永假（取消的手势不算任何动作——与既有点击判定同规）", () => {
    expect(isDragRelease(press(100, 100), up(300, 300, "pointercancel"))).toBe(false);
  });

  it("无坐标永假（press 无 x/y 或 up 无 clientX/Y——合成事件只当放手，不回弹）", () => {
    expect(isDragRelease({ x: undefined, y: undefined, t: 0 }, up(300, 300))).toBe(false);
    expect(isDragRelease(press(100, 100), { type: "pointerup" })).toBe(false);
    expect(isDragRelease(null, up(300, 300))).toBe(false); // press 缺席（已消费/异常）
  });
});

// ω99-282: #5 — isWindowCarried（搬运中判据）纯规则五象：无按下记录不判
// （保 278 行为）、阈内不是搬、恰 5px 是搬（25≥25 含阈）、大位移是搬、
// 坐标非有限数防御假。判据来源：原生拖窗期（tauriStartDrag）指针事件不再
// 投递页面——pointermove 不可靠，按下时刻↔计时到点时刻的窗位差
// （window.screenX/screenY）是唯一可靠的位移事实。
describe("ω99-282 isWindowCarried（按下↔到点窗位差五象）", () => {
  const win = (x: number, y: number): { x: number; y: number } => ({ x, y });

  it("pressScreen=null → false（无按下记录不判搬运——保 278 行为）", () => {
    expect(isWindowCarried(null, win(500, 500))).toBe(false);
  });

  it("窗位差 <5px → false（原地按住=戳，窗没被搬走）", () => {
    expect(isWindowCarried(win(100, 100), win(101, 101))).toBe(false); // √2 < 5
    expect(isWindowCarried(win(100, 100), win(100, 100))).toBe(false); // 纹丝未动
  });

  it("窗位差恰 5px → true（25≥25 含阈，与 isDragRelease 同族同值）", () => {
    expect(isWindowCarried(win(100, 100), win(103, 104))).toBe(true); // 3-4-5 整
  });

  it("窗位差大位移 → true（纯水平/纯垂直各证——拖窗期位移落在窗坐标上）", () => {
    expect(isWindowCarried(win(100, 100), win(160, 100))).toBe(true); // 水平 60px
    expect(isWindowCarried(win(100, 100), win(100, 160))).toBe(true); // 垂直 60px
  });

  it("任一坐标非有限数（NaN/Infinity）→ false（防御，生产不触发）", () => {
    expect(isWindowCarried(win(NaN, 100), win(160, 100))).toBe(false);
    expect(isWindowCarried(win(100, 100), win(Infinity, 100))).toBe(false);
  });
});
