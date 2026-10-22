// @vitest-environment jsdom
// ω99-278: #7 — 戳一戳/拖拽回弹/表情气泡的源级钉 + jsdom 行为面（沿
// omega99-276 readSrc/ruleBody 范式 + css-test-utils 的 CSSOM decl）：
// ① pet.css：pet-squash/pet-release 两 keyframes 与 [data-poked] /
//    [data-pet-state="release"] 规则（release 简写含 pet-blink 恒伴）；
//    .pet-expr 规则 + 浅色覆写行在场；reduce 块不含对两新动画的封顶
//    （豁免钉）且六态/done/drag 既有封顶行逐字未动（回归钉）。
// ② main.tsx 源级：pokeTimer 启动/清理缝、pokeEpoch 下传、releaseFlash
//    三态 display、pet-expr 渲染行、三定时器卸载卫生。
// ③ PetSprite：pokeEpoch 层包裹（figure 在 .pet-poke-layer 内）+ 挂载
//    行为面（release 态可渲染）。ω99-282（续，标记 #6 见下）：pokeEpoch 只
//    当重挂 key，任何值不挂 data-poked；瞬时门=新 prop poked。
// ④ pet-state.ts：`"release"` 进 PetDisplayState 联合 + 机器函数体永不
//    emit（UI 事件态边界，drag 边界注的续写）。
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mount, decl, unmount } from "./css-test-utils.js";
import { PetSprite } from "../src/pet/PetSprite.js";
import "../src/pet/pet.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 的 fs 锚用 process.cwd() 候选位（178/203 两证）。
const readSrc = (rel: string): string => {
  const hit = ["src", "packages/web/src"]
    .map((d) => `${process.cwd()}/${d}/${rel}`)
    .find((p) => existsSync(p));
  if (hit === undefined) throw new Error(`source not found: ${rel}`);
  return readFileSync(hit, "utf8");
};
/** 选择器规则体（`{`…首个 `}`）——单层规则块专用；注释算体内文本。 */
const ruleBody = (css: string, selector: string): string => {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", at);
  return css.slice(open, css.indexOf("}", open));
};
/** 括号配平的整块提取（@keyframes/@media 等嵌套体用——ruleBody 会停在
 *  首个内层 `}`，取不到整段）。 */
const block = (css: string, head: string): string => {
  const at = css.indexOf(head);
  if (at === -1) throw new Error(`block not found: ${head}`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced block: ${head}`);
};

afterEach(unmount);

describe("ω99-278 ① pet.css 动画与浮层", () => {
  const css = readSrc("pet/pet.css");

  it("pet-squash keyframes：捏扁(1.22,0.78)→过冲(0.92,1.08)→落定；挂 [data-poked] 内层，0.6s 与 POKE_SQUASH_MS 对表", () => {
    const kf = block(css, "@keyframes pet-squash");
    expect(kf).toContain("scale(1.22, 0.78)");
    expect(kf).toContain("scale(0.92, 1.08)");
    expect(kf).toContain("scale(1, 1)");
    const rule = ruleBody(css, ".pet-poke-layer[data-poked]");
    expect(rule).toContain("pet-squash 0.6s cubic-bezier(.3, 1.2, .4, 1) 1");
    expect(rule).toContain("transform-origin: 50% 100%"); // 落地轴（sway 同源语义）
  });

  it("pet-release keyframes：0% 承接 drag 的 1.05 零突跳→落地压扁→微回弹→落定", () => {
    const kf = block(css, "@keyframes pet-release");
    expect(kf).toContain("transform: scale(1.05);");
    expect(kf).toContain("scale(0.94, 1.06)");
    expect(kf).toContain("scale(1.02, 0.98)");
    expect(kf).toContain("scale(1, 1)");
  });

  it("[data-pet-state=\"release\"] 规则：pet-release 0.45s 一次性 + pet-blink 恒伴律第二位照旧", () => {
    const rule = ruleBody(css, '[data-pet-state="release"] .pet-sprite-img');
    expect(rule).toContain("pet-release 0.45s");
    expect(rule).toContain("pet-blink 9.6s steps(1, end) infinite");
  });

  it(".pet-expr 表情气泡：fixed 头顶锚 + 尾巴 + 令牌面（toast 同族）；119b 浅色覆写行退役", () => {
    const body = ruleBody(css, ".pet-expr {");
    expect(body).toContain("position: fixed");
    expect(body).toContain("bottom: 83px"); // 12 底距 + 59 精灵（96×238/390）+ 12 头顶间隙
    expect(body).toContain("background: var(--surface)"); // 119b：旧 #0A1F17 钉死字面量退役
    expect(body).toContain("color: var(--text-1)");
    expect(body).toContain("box-shadow: var(--elev-2)"); // 旧 0 4px 18px 重投影退役
    expect(css).toContain(".pet-expr::after"); // 小尾巴
    expect(ruleBody(css, ".pet-expr::after")).toContain("border-top-color: var(--surface)");
    // 119b：浅色覆写行退役——明暗由 tokens.css 随 html[data-theme] 翻转
    expect(css.includes('[data-theme="light"] .pet-expr')).toBe(false);
    // CSSOM 读数（import 的 pet.css 已挂载）：几何锚在样式表里成立
    expect(decl(".pet-expr", "position")).toBe("fixed");
    expect(decl(".pet-expr", "bottom")).toBe("83px");
  });

  it("reduce 块豁免钉：无 pet-squash/pet-release/.pet-poke-layer 封顶；六态/done/drag/sway 既有封顶行逐字在场", () => {
    const reduce = block(css, "@media (prefers-reduced-motion: reduce)");
    // 豁免：戳/回弹是用户亲手触发的即时反馈，不加 iteration-count 封顶行
    expect(reduce).not.toContain("pet-squash");
    expect(reduce).not.toContain("pet-release");
    expect(reduce).not.toContain(".pet-poke-layer");
    // 回归：既有封顶逐字未动（六态 0,infinite / done+drag 1,infinite / sway 0）
    expect(reduce).toContain("animation-iteration-count: 0, infinite !important;");
    expect(reduce).toContain("animation-iteration-count: 1, infinite !important;");
    expect(reduce).toContain("animation-iteration-count: 0 !important;");
    expect(reduce).toContain('[data-pet-state="done"] .pet-sprite-img,');
    expect(reduce).toContain('[data-pet-state="drag"] .pet-sprite-img {');
    expect(reduce).toContain('[data-pet-state="idle"] .pet-figure {');
  });
});

describe("ω99-278 ② 指针/渲染接线（ω99-291 拆分挪家：定时器族→interaction.ts，渲染面→PetApp.tsx；钉同形）", () => {
  const interaction = readSrc("pet/interaction.ts");
  const petApp = readSrc("pet/PetApp.tsx");

  it("戳计时缝：pointerdown 起 POKE_HOLD_MS 定时（pokeEpoch++ + 轮选表情），表情 POKE_EXPR_MS 自消", () => {
    expect(interaction).toContain('from "./poke.js"');
    expect(interaction).toContain("pokeTimer.current = setTimeout(() => {");
    expect(interaction).toContain("}, POKE_HOLD_MS);");
    expect(interaction).toContain("setPokeEpoch((n) => n + 1);");
    expect(interaction).toContain("pickExpression(lastExpr.current, Math.random)");
    expect(interaction).toContain("}, POKE_EXPR_MS);");
  });

  it("释放清理缝：release 开头先撤戳定时（先于 setDragging），随后 isDragRelease → releaseFlash 450ms", () => {
    const at = interaction.indexOf("const release = (e: PointerEvent): void => {");
    expect(at).toBeGreaterThan(-1);
    const head = interaction.slice(at, interaction.indexOf("setInputOpen", at));
    const clear = head.indexOf("clearTimeout(pokeTimer.current)");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(head.indexOf("setDragging(false)")); // 「开头」：取消的手势不戳
    expect(interaction).toContain("if (isDragRelease(p, e)) {");
    expect(interaction).toContain("setReleaseFlash(true)");
    expect(interaction).toContain("}, 450);"); // = pet-release 0.45s 同值
  });

  it("三态 display + pokeEpoch 下传 + pet-expr 渲染行 + 定时器卸载卫生", () => {
    expect(petApp).toContain('display={dragging ? "drag" : releaseFlash ? "release" : machine.display}');
    expect(petApp).toContain("pokeEpoch={pokeEpoch}");
    expect(petApp).toContain('<div className="pet-expr" data-pet-expr="" role="status">{pokeExpr}</div>');
    expect(interaction).toContain("clearTimeout(exprTimer.current)");
    expect(interaction).toContain("clearTimeout(releaseTimer.current)");
    // ω99-282（续，标记 #6 见下）— 第四个定时器（squash 瞬时窗）+ poked 下传
    expect(interaction).toContain("clearTimeout(squashTimer.current)");
    expect(petApp).toContain("poked={pokeFlash}");
  });
});

describe("ω99-278 ③ PetSprite pokeEpoch 层（包裹 + 行为面）", () => {
  const ps = readSrc("pet/PetSprite.tsx");

  it("源级：pokeEpoch prop + .pet-poke-layer 包 figure（key 重挂 + data-poked 门）", () => {
    expect(ps).toContain("pokeEpoch?: number;");
    expect(ps).toContain('className="pet-poke-layer"');
    expect(ps).toContain("key={pokeEpoch ?? 0}");
    // ω99-282（续，标记 #6 见下）— 契约拆开：epoch 只当 key，瞬时门是 poked
    expect(ps).toContain("poked?: boolean;");
    expect(ps).toContain('data-poked={poked ? "" : undefined}');
  });

  it("挂载：figure 在 .pet-poke-layer 内（垫层零演进——后代形选择器不动）", () => {
    const c = mount(<PetSprite display="idle" />);
    const layer = c.querySelector<HTMLElement>(".pet-poke-layer");
    expect(layer).not.toBeNull();
    expect(layer?.querySelector(".pet-figure")).not.toBeNull();
    expect(layer?.querySelector(".pet-sprite-img")).not.toBeNull();
    expect(c.querySelector('[data-pet-root] .pet-poke-layer .pet-figure')).not.toBeNull();
  });

  // ω99-282: #6 — 契约拆开演进（278 的「pokeEpoch>0 → data-poked」推断退役）：
  // pokeEpoch 只当重挂 key（任何值都不挂 data-poked——wake nudge 重挂不再
  // 重放 squash）；瞬时门是新 prop poked（main.tsx 的 pokeFlash：戳后
  // POKE_SQUASH_MS 600ms 窗内 true，窗外任何重挂都挂不上）。
  it("行为面：pokeEpoch 任何值不挂 data-poked（只当 key）；瞬时门=poked prop", () => {
    const c0 = mount(<PetSprite display="idle" pokeEpoch={0} />);
    expect(c0.querySelector<HTMLElement>(".pet-poke-layer")?.hasAttribute("data-poked")).toBe(false);
    unmount();
    const cUndef = mount(<PetSprite display="idle" />);
    expect(cUndef.querySelector<HTMLElement>(".pet-poke-layer")?.hasAttribute("data-poked")).toBe(false);
    unmount();
    const c2 = mount(<PetSprite display="idle" pokeEpoch={2} />);
    expect(c2.querySelector<HTMLElement>(".pet-poke-layer")?.hasAttribute("data-poked")).toBe(false); // 282：epoch≠门
    unmount();
    const cPoked = mount(<PetSprite display="idle" pokeEpoch={3} poked={true} />);
    expect(cPoked.querySelector<HTMLElement>(".pet-poke-layer")?.getAttribute("data-poked")).toBe(""); // 门在 poked
    unmount();
    const cPokedOff = mount(<PetSprite display="idle" poked={false} />);
    expect(cPokedOff.querySelector<HTMLElement>(".pet-poke-layer")?.hasAttribute("data-poked")).toBe(false);
  });

  it("release 态可渲染（UI 事件态字面量进联合后的显示壳零分支）", () => {
    const c = mount(<PetSprite display="release" />);
    expect(c.querySelector<HTMLElement>("[data-pet-root]")?.getAttribute("data-pet-state")).toBe("release");
  });
});

describe("ω99-278 ④ pet-state.ts 边界（机器零污染）", () => {
  const st = readSrc("pet/pet-state.ts");

  it("`release` 进 PetDisplayState 联合（UI 事件态家族），stepPetMachine 函数体永不 emit", () => {
    expect(st).toContain('| "done" | "drag" | "release";');
    const fn = st.slice(st.indexOf("export function stepPetMachine"));
    expect(fn).not.toContain('"release"'); // 机器输出面零改动
  });
});
