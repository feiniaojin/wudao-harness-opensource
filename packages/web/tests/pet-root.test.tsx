// @vitest-environment jsdom
// ω99-98 桌宠窗根 —— the pet entry contract, EVOLVED from ω99-97's
// placeholder pins (why the change: 97 mounted a bare circle placeholder —
// data-pet-shape="circle" + inline borderRadius 50% — because the sprite
// did not exist yet; 98 replaces the placeholder with <PetSprite>, so the
// shape pin evolves into the sprite contract pins: data-skin="default" +
// data-pet-state="idle" from the machine's initial value).
// ω99-99 再演进（why: 98 的机器只挂初值、没有输入源——99 打通主窗中继后
// 事件帧成为机器的 stepping 源，且「点击即会话」给指针层加了点击判定）：
//   a. wudao-pet-state 事件帧 → stepPetMachine → data-pet-state 随真实
//      agent 状态走（pet 活起来了，不再是恒 idle 的本地动画壳）；
//   b. pointerdown+同位 pointerup（位移 <5px、历时 <600ms）判定为点击 →
//      气泡 input 打开 + set_focus（D8：用户主动点击=意图确认）；
//      位移超阈=拖拽，不开气泡（与 98 的 drag 断言并存）。
// ω99-108 再演进（why: 用户「这个形象太丑了，我们的logo图标呢？」——默认皮
// 从 div+CSS 圆身双眼换成 logo 史莱姆图片）：默认皮体内的结构断言从
// .pet-body/.pet-eye 改为 .pet-figure 内单张 img（src=/pet/logo-sprite.png，
// 资产由 scripts/make-logo-sprite.py 抠白底产出）；root 契约、状态机、
// 拖拽/暂停/动画规则断言全部不动。
// UNCHANGED and load-bearing as ever:
//   1. the pet root mounts: a [data-pet-root] element exists;
//   2. the entry reads ?view=pet and stamps <html data-view="pet">;
//   3. the MAIN SHELL NEVER LOADS in the pet window: App.tsx must not be in
//      the pet entry's module graph (vi.mock factory only runs if the graph
//      pulls it — the flag proves it never did), and no WebSocket may be
//      constructed (the server is single-WS-client — second connection is
//      closed with 4000; the pet window must never open one);
//   4. dragging rides the start-dragging capability — now evolved further:
//      pointerdown ALSO flips the UI event state to "drag" (the machine
//      never emits it; pet-state.ts boundary), and a window-level pointerup
//      releases it back to the machine's display;
//   5. ω99-145 wake nudge: a hidden→visible transition REMOUNTS the sprite
//      (motionEpoch as key) to rebuild its CSS animations — the entry never
//      stamps data-paused anymore (macOS WKWebView misreports document.hidden
//      on a non-key floating always-on-top window and the old freeze line
//      parked the pet forever — 用户令 09-07 常活). pet.css keeps the
//      [data-paused] rule + the paused prop as unbroken API, and still
//      declares per-state animation for all seven display states
//      (CSS-only motion).
//   6. ω99-278: #8 — 戳一戳/拖拽回弹（用户令「UI设计更精美」弧）：
//      a. 真拖拽释放（位移 ≥5px）先进 450ms 的 "release" 回弹窗（第四个
//         UI 事件态，机器永不 emit——pet-state.ts 边界注），窗后回机器
//         display（旧断言「release 即回机器态」随行为演进）；
//      b. 按住 650ms（> CLICK_MS 600，天然互斥）→ pokeEpoch++（Q 弹层
//         重挂，data-poked）+ 头顶表情气泡（.pet-expr）；释放不误触单击。
//   7. ω99-282: #4 — 戳一戳两边界收紧（278 闭弧两条边界注记各收一刀）：
//      a. 搬运中不戳：戳计时到点查按下↔到点的窗位差（screenX/Y）——原生
//         拖窗期指针事件不投递页面，窗位是唯一可靠位移事实；差 ≥5px =
//         搬运中，整个回调不触发（不 epoch、不表情）；拖拽释放语义不变；
//      b. data-poked 瞬时态：只在戳后 POKE_SQUASH_MS(600ms) 窗内存在
//         （poked prop，pokeEpoch 只当重挂 key）——wake nudge / StrictMode
//         的任何窗外重挂都不再重放 squash（600ms 后动画已放完，撤属性零
//         视觉差）。
import { describe, it, expect, beforeAll, vi } from "vitest";
import { act } from "react";
// ω99-278（续，标记 #8 见上）— 戳一戳端到端要断言表情出自池（poke.ts 纯层）。
import { POKE_EXPRESSIONS } from "../src/pet/poke.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// If the pet entry (transitively) imports the main shell's App, this factory
// runs and flips appPulled — the tests assert it never does. stateHandlers
// captures what the entry registers through transformCallback (ω99-99's
// wudao-pet-state listener) so tests can drive the wire directly.
const pet = vi.hoisted(() => ({ appPulled: false, wsOpened: 0, stateHandlers: [] as ((p: unknown) => void)[] }));

vi.mock("../src/components/App.js", () => {
  pet.appPulled = true;
  return { App: () => null };
});

const invoke = vi.fn(async () => undefined);

beforeAll(async () => {
  // The pet window's URL shape, as the Rust navigation builds it:
  // /pet.html?shell=desktop&view=pet#<token>
  window.history.pushState({}, "", "/pet.html?shell=desktop&view=pet#tokentokentoken1234");
  // WS recorder: constructing one = opening a second client = protocol violation.
  vi.stubGlobal("WebSocket", class {
    constructor(..._args: unknown[]) {
      pet.wsOpened += 1;
    }
  });
  // The desktop invoke bridge (start-dragging target) + the event-bus
  // callback registrar (listen target — ω99-99).
  (window as typeof window & {
    __TAURI_INTERNALS__?: { invoke?: unknown; transformCallback?: unknown };
  }).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb: (p: unknown) => void): number => {
      pet.stateHandlers.push(cb);
      return pet.stateHandlers.length;
    },
  };
  // act() flushes the entry's module-level createRoot().render() before the
  // assertions run (the repo's standard React-19 test harness).
  await act(async () => {
    await import("../src/pet/main.js");
  });
});

/** The entry's LIVE wudao-pet-state handler (StrictMode double-mounts the
 *  listen effect; the last registration is the surviving one). */
function stateHandler(): (p: unknown) => void {
  const h = pet.stateHandlers[pet.stateHandlers.length - 1];
  if (typeof h !== "function") throw new Error("no state handler registered");
  return h;
}

/** All CSSStyleRules the entry's pet.css mounted (top level AND inside
 *  @media — vitest css:true injects the sheet; the paused/reduced-motion
 *  rules live nested, so descend instead of using tests' decl() helper).
 *  cssText rides along since ω99-111: the state animations moved to the
 *  `animation:` SHORTHAND (two entries — state motion + pet-blink), which
 *  jsdom does not decompose into animation-name longhands. */
function allStyleRules(): { selector: string; media: string; cssText: string }[] {
  const out: { selector: string; media: string; cssText: string }[] = [];
  for (const sheet of [...document.styleSheets] as CSSStyleSheet[]) {
    for (const rule of [...sheet.cssRules]) {
      if (rule instanceof CSSMediaRule) {
        for (const inner of [...rule.cssRules]) {
          if (inner instanceof CSSStyleRule) out.push({ selector: inner.selectorText, media: rule.conditionText, cssText: inner.cssText });
        }
      } else if (rule instanceof CSSStyleRule) {
        out.push({ selector: rule.selectorText, media: "", cssText: rule.cssText });
      }
    }
  }
  return out;
}

/** ω99-111 — the invoke mock's recorded calls, as (cmd, args) tuples. The
 *  mock is vi.fn(async () => undefined) — typed with NO parameters — so
 *  mock.calls is [][]; one cast through unknown keeps the reads honest. */
function invokeCalls(): Array<[unknown, unknown]> {
  return invoke.mock.calls as unknown as Array<[unknown, unknown]>;
}

/** ω99-111 — the entry's LIVE wudao-pet-skin handler (same pattern as
 *  stateHandler(): the LAST listen registration for this event wins —
 *  StrictMode's surviving mount). Found via the invoke mock's listen call
 *  → handler id → the transformCallback slot it registered. */
function skinHandler(): (p: unknown) => void {
  const call = [...invokeCalls()]
    .reverse()
    .find(([cmd, args]) => cmd === "plugin:event|listen" && (args as { event?: string })?.event === "wudao-pet-skin");
  const handlerId = (call?.[1] as { handler?: number } | undefined)?.handler;
  const h = typeof handlerId === "number" ? pet.stateHandlers[handlerId - 1] : undefined;
  if (typeof h !== "function") throw new Error("no skin handler registered");
  return h;
}

describe("ω99-98 pet 入口（精灵根，自 97 占位演进）", () => {
  it("pet 根挂载：[data-pet-root] 存在", () => {
    expect(document.querySelector("[data-pet-root]")).not.toBeNull();
  });

  it("占位演进为精灵：data-skin=default，状态机初值 data-pet-state=idle", () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    expect(el?.getAttribute("data-skin")).toBe("default");
    expect(el?.getAttribute("data-pet-state")).toBe("idle");
    // ω99-111 期望变更（依据：见 ω99-108 换 logo 图后，本弧再换 2 帧
    // sheet——steps(1) 换帧需要 background-position，img 做不到）：
    // .pet-figure 内从 <img src=logo-sprite.png> → background-div，指向
    // /pet/skin-default.png（左帧睁眼，右帧闭眼由 pet-blink 切换）。
    const div = el?.querySelector<HTMLElement>(".pet-figure .pet-sprite-img");
    expect(div).not.toBeNull();
    expect(div?.style.backgroundImage).toContain("/pet/skin-default.png");
    expect(el?.querySelector("img")).toBeNull();
  });

  it("读取 ?view=pet：<html data-view=pet>", () => {
    expect(document.documentElement.dataset.view).toBe("pet");
  });

  it("不加载主壳：App.tsx 不进模块图，且不开第二条 WS", async () => {
    await new Promise((resolve) => setTimeout(resolve, 0)); // let lazy connects settle
    expect(pet.appPulled).toBe(false);
    expect(pet.wsOpened).toBe(0);
  });

  it("拖拽走 start-dragging 且入 drag 态：pointerdown 入 drag、位移 ≥4px 才 plugin:window|start_dragging（win32 0.3.81：按下即启会把点击的 pointerup 吞进原生模态循环）", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    expect(el).not.toBeNull();
    // 共享 invoke mock（无逐测重置）——以调用数快照断言增量，不受前测污染。
    const dragCalls = (): number => invoke.mock.calls.filter((c: unknown[]) => c[0] === "plugin:window|start_dragging").length;
    const before = dragCalls();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    });
    // 按下即入 drag 态（视觉/光标），但 start_dragging 还没发——静止按下
    // +松开必须是纯点击（pointerup 正常投递，点击判定才能开输入）。
    expect(el!.getAttribute("data-pet-state")).toBe("drag");
    expect(dragCalls()).toBe(before);
    // 位移超过阈值 → 进入原生拖窗。
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 20, clientY: 12, buttons: 1, bubbles: true }));
    });
    expect(dragCalls()).toBe(before + 1);
  });

  it("pointerup 解除 drag：回到状态机的 display（机器态未被 pointer 改写）", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      el!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(el!.getAttribute("data-pet-state")).toBe("drag");
    // 原生窗口拖拽中 pointerup 通常落在 96px 精灵之外 —— 解除挂在 window 层。
    await act(async () => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(el!.getAttribute("data-pet-state")).toBe("idle");
  });

  it("visibilitychange hidden→visible → 精灵重挂（wake nudge），全程永不出 data-paused", async () => {
    // ω99-145: 用户令常活（09-07「动几下就停下来了」）——旧冻结线（hidden 即
    // stamp data-paused）在 macOS WKWebView 非键浮动小窗（focus:false +
    // alwaysOnTop + visibleOnAllWorkspaces）上 document.hidden 判定不可靠，
    // 误报 hidden 或漏报 visible 一次即 animation-play-state:paused 钉死、
    // 宠物永久静止。演进为 wake nudge：仅 hidden→visible 转变时 motionEpoch++
    // 以 key 重挂 PetSprite（重建 CSS 动画，治愈隐藏期合成时钟丢失/卡死态）；
    // data-paused 从此在本入口永不出现（PetSprite 的 paused prop 与 pet.css
    // 的 [data-paused] 规则原样保留为 API，只是 main.tsx 不再置 true）。
    const before = document.querySelector<HTMLElement>("[data-pet-root]");
    expect(before).not.toBeNull();
    const setHidden = (hidden: boolean): void => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    };
    await act(async () => {
      setHidden(true);
      void document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(document.querySelector("[data-pet-root]")?.hasAttribute("data-paused")).toBe(false);
    await act(async () => {
      setHidden(false);
      void document.dispatchEvent(new Event("visibilitychange"));
    });
    const after = document.querySelector<HTMLElement>("[data-pet-root]");
    expect(after).not.toBe(before); // key 重挂 → DOM 节点 identity 变
    expect(after?.hasAttribute("data-paused")).toBe(false);
    // visible→visible（无转变）不重挂——nudge 只在转变沿上，不过度重建。
    await act(async () => {
      void document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(document.querySelector("[data-pet-root]")).toBe(after);
  });

  it("pet.css（经入口传递性加载）：七态各声明动画，[data-paused] 冻结，reduced-motion 封顶", () => {
    const states = ["idle", "thinking", "working", "answering", "waiting-user", "done", "drag"];
    for (const s of states) {
      const rules = allStyleRules().filter((r) => r.media === "" && r.selector.includes(`[data-pet-state="${s}"]`));
      expect(rules.length, `state=${s} 需有顶层动画规则`).toBeGreaterThan(0);
    }
    // [data-paused] * → animation-play-state paused（写死 §3）。
    const paused = allStyleRules().find((r) => r.selector.includes("data-paused"));
    expect(paused).toBeDefined();
    // prefers-reduced-motion 下有封顶规则（≤2 次迭代）。
    const reduced = allStyleRules().filter((r) => r.media.includes("prefers-reduced-motion"));
    expect(reduced.length).toBeGreaterThan(0);
  });

  // --- ω99-111：眨眼 + 生命感动画（CSS 守卫更新） ------------------------------

  it("pet-blink 关键帧存在（背景位 0%→100% 换帧，steps(1) 硬切）", () => {
    // jsdom 不解析 @keyframes 规则树，但 vitest css:true 注入的 <style>
    // 文本在——在样式文本上钉 @keyframes pet-blink 及其换帧两端点。
    const cssText = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    expect(cssText).toContain("@keyframes pet-blink");
    const blinkBlock = cssText.slice(cssText.indexOf("@keyframes pet-blink"));
    expect(blinkBlock).toContain("background-position: 0% 0");
    expect(blinkBlock).toContain("background-position: 100% 0");
  });

  it("七态每条的 animation 简写都叠第二动画 pet-blink（状态动作与眨眼不互斥）", () => {
    // 依据 brief §2：transform（状态动作）与 background-position（眨眼）
    // 不同属性可叠；简写必须逐动画带自己的 duration/iteration——长手单值
    // 会把 0.7s/1 次错误地套到 blink 上，所以这里钉简写文本。
    const states = ["idle", "thinking", "working", "answering", "waiting-user", "done", "drag"];
    for (const s of states) {
      const rule = allStyleRules().find(
        (r) => r.media === "" && r.selector.includes(`[data-pet-state="${s}"]`) && r.cssText.includes("animation:"),
      );
      expect(rule, `state=${s} 需有 animation 简写`).toBeDefined();
      expect(rule?.cssText, `state=${s} 状态动画仍在`).toContain(`pet-${s === "waiting-user" ? "waiting" : s}`);
      expect(rule?.cssText, `state=${s} 叠加 pet-blink`).toContain("pet-blink");
    }
  });

  it("守卫新形：reduced-motion 下位移 0 次、眨眼常活（done/drag 用 1,infinite 列表）", () => {
    // ω99-145: 用户令常活（09-07「动几下就停下来了」）——位移更严（0 次）
    // + 眨眼常活。旧形把 blink 与状态位移一起封 2 次（idle 2.4s×2≈5s 后彻底
    // 静态，眨眼一并被封——「动几下就停」的头号嫌疑）；新形 `0, infinite`
    // 列表对位简写两动画：状态位移零播放（比旧形更保守）、眨眼无限（换帧
    // 非位移，生命感保留）——运动学更严与生命感更强同升，不是折衷。
    // done/drag 的一次性位移保 1 次（done 是结果宣告、drag 是被抓起的物理
    // 反馈，单次位移即止），其 blink 同样常活 —— `1, infinite` 列表。
    const reduced = allStyleRules().filter((r) => r.media.includes("prefers-reduced-motion"));
    const capInfinite = reduced.find((r) => r.cssText.includes("animation-iteration-count") && r.selector.includes("idle"));
    expect(capInfinite, "六个无限态的封顶规则仍在").toBeDefined();
    expect(capInfinite?.cssText).toContain("0, infinite");
    const capOneShot = reduced.find(
      (r) => r.cssText.includes("animation-iteration-count") && r.selector.includes('"done"') && r.selector.includes('"drag"'),
    );
    expect(capOneShot, "done/drag 的列表封顶在位").toBeDefined();
    expect(capOneShot?.cssText).toContain("1, infinite");
    // [data-paused] 冻结规则原样保留（PetSprite 的 paused prop 是不破的
    // API——pet-skins.test.tsx:89 钉透传；pause 的是 animation-play-state，
    // 作用于元素上的全部动画，按构造覆盖 blink。main.tsx 只是不再置 true）。
    expect(allStyleRules().find((r) => r.selector.includes("data-paused"))?.cssText).toContain("paused");
  });

  // --- ω99-145：常活（idle super-cycle + blink 双眨 + reduce 眨眼常活）-------

  it("ω99-145 pet-idle super-cycle：多相关键帧（≥6 个 transform 停靠 + rotate/translateY 同现）", () => {
    // 依据用户令 09-07「多设计点动作」——单一 2.4s 呼吸循环 repertoire 太薄。
    // super-cycle 拉长到 ~12s：≥3 轮呼吸 + 1 次侧头看（rotate）+ 1 次小跳
    // （squash-hop，translateY）。jsdom 不解析 @keyframes 规则树，在注入
    // 样式文本上钉证据：块内 ≥6 个 transform 停靠，且 rotate 与 translateY
    // 同现（侧头与跳两个非呼吸相的多相证明）。
    const cssText = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    const start = cssText.indexOf("@keyframes pet-idle");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = cssText.indexOf("@keyframes", start + 1);
    const block = cssText.slice(start, next === -1 ? undefined : next);
    const stops = block.match(/transform:/g) ?? [];
    expect(stops.length, "super-cycle 需 ≥6 个 transform 停靠").toBeGreaterThanOrEqual(6);
    expect(block, "侧头看相（rotate 小幅）").toContain("rotate(");
    expect(block, "squash-hop 相（translateY ≤6px）").toContain("translateY(");
  });

  it("ω99-146 pet-blink 密眨：9.6s 周期含 ≥5 个闭眼窗口（3 单眨 + 双眨两窗）", () => {
    // ω99-146 期望演进（依据用户令 09-07「只有眨眼，间隔也比较长」——15.6s
    // 平均 ~4.7s 一眨，用户嫌长）：周期 15.6s→9.6s，内含 3 次单眨 + 1 次
    // 双眨（两个紧邻的 100% 0 窗口、中间短暂睁开），平均 ~2.4s 一眨
    // （人眼自然频段，陪伴感主体）。每闭窗 ~200-220ms（2.1% of 9.6s）。
    // 文本级钉块内闭眼窗口数 ≥5（3 单眨 + 双眨的 2 窗——3 单眨结构给不出
    // 5 窗，即三单眨+双眨布局在位的证明；145 的 2 单眨只给得出 4 窗）。
    const cssText = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    const start = cssText.indexOf("@keyframes pet-blink");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = cssText.indexOf("@keyframes", start + 1);
    const block = cssText.slice(start, next === -1 ? undefined : next);
    const windows = block.match(/background-position: 100% 0/g) ?? [];
    expect(windows.length, "3 单眨 + 双眨两窗 = ≥5 个 100% 0 窗口").toBeGreaterThanOrEqual(5);
  });

  it("ω99-146 七态简写的 pet-blink 全部同步 9.6s（旧 5.2s/15.6s 零残留）", () => {
    // ω99-146 期望演进（依据用户令 09-07「间隔也比较长」——blink 周期
    // 15.6s→9.6s 密眨）：简写第二动画的时长必须七处一致——任何一处漏改
    // 会让该态的眨眼节奏与其余六态不同（且旧时长残留会在 9.6s 关键帧下
    // 每 5.2s/15.6s 截断重放，3 单眨+双眨结构被吃掉）。
    const cssText = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    expect(cssText).not.toContain("pet-blink 5.2s");
    expect(cssText).not.toContain("pet-blink 15.6s");
    const states = ["idle", "thinking", "working", "answering", "waiting-user", "done", "drag"];
    for (const s of states) {
      const rule = allStyleRules().find(
        (r) => r.media === "" && r.selector.includes(`[data-pet-state="${s}"]`) && r.cssText.includes("animation:"),
      );
      expect(rule, `state=${s} 需有 animation 简写`).toBeDefined();
      expect(rule?.cssText, `state=${s} blink 同步 9.6s`).toContain("pet-blink 9.6s");
    }
  });

  // --- ω99-146：陪伴感（idle 常摆 sway + 可见呼吸 + 密眨 9.6s）------------------

  it("ω99-146 idle 常摆：.pet-figure 挂 pet-sway 无限摇摆，关键帧 ±2.5° 双向", () => {
    // 依据用户令 09-07「还会左右摆动之类的效果」——idle 缺连续 sway 层。挂
    // 在原零动画的父层 .pet-figure 上：与子层 .pet-sprite-img 的呼吸/动作
    // 跨元素自然叠乘（两个 transform 动画同元素会互斥，跨元素则叠乘），
    // 零 JS、不碰状态机。仅 idle 挂（thinking/waiting 自有摆，叠加过躁）。
    const sway = allStyleRules().find(
      (r) => r.media === "" && r.selector.includes('[data-pet-state="idle"]') && r.selector.includes(".pet-figure"),
    );
    expect(sway, "idle 的 .pet-figure sway 规则在位").toBeDefined();
    expect(sway?.cssText).toContain("pet-sway 4.8s");
    expect(sway?.cssText).toContain("infinite");
    // jsdom 不解析 @keyframes 规则树，在注入样式文本上钉双向摆幅证据。
    const cssText = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    const start = cssText.indexOf("@keyframes pet-sway");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = cssText.indexOf("@keyframes", start + 1);
    const block = cssText.slice(start, next === -1 ? undefined : next);
    expect(block, "左摆").toContain("rotate(-2.5deg)");
    expect(block, "右摆").toContain("rotate(2.5deg)");
  });

  it("ω99-146 idle 可见呼吸：pet-idle 幅值升到 ±6-7%（1.06/0.92 在块内）", () => {
    // 依据用户令 09-07「要有一种呼吸感」——旧幅值 ±2.5%（1.03/0.955）在
    // ~59px 精灵上只有 ~1.5px 位移，低于一眼可感阈值（145 修了「停」、
    // 没修「可见度」）。呼吸停靠升到 (1.06,0.92)↔(0.95,1.07)——59px 上
    // ±4px，看得见的果冻呼吸。super-cycle 12s 骨架不动，仅呼吸停靠值
    // 随幅值更新；旧压扁值 0.955 零残留（残留=有停靠漏改回旧幅值）。
    const cssText = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    const start = cssText.indexOf("@keyframes pet-idle");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = cssText.indexOf("@keyframes", start + 1);
    const block = cssText.slice(start, next === -1 ? undefined : next);
    expect(block, "呼吸压扁端 1.06").toContain("1.06");
    expect(block, "呼吸压扁端 0.92").toContain("0.92");
    expect(block, "旧 ±2.5% 幅值零残留").not.toContain("0.955");
  });

  it("ω99-146 reduce 陪跑：idle .pet-figure 的 sway 封顶 0 次（位移零播放）", () => {
    // 依据：sway 是 transform 位移——reduce 语义下与六态位移同待遇（0 次
    // 播放），且 sway 是单动画，封顶值单个 0（无列表）。眨眼常活不受影响
    // （pet-blink 仍在 img 上，其 `0, infinite` 列表原样）。
    const reduced = allStyleRules().filter((r) => r.media.includes("prefers-reduced-motion"));
    const cap = reduced.find(
      (r) => r.cssText.includes("animation-iteration-count") && r.selector.includes("idle") && r.selector.includes("pet-figure"),
    );
    expect(cap, "reduce 块的 idle figure sway 封顶规则在位").toBeDefined();
    expect(cap?.cssText).toContain("animation-iteration-count: 0");
  });

  // --- ω99-111：换肤入口（skinId 状态 + get_pet_skin 初值 + 事件切换） --------

  it("挂载即查 get_pet_skin：命令缝取初值（undefined → 归一 default）", () => {
    // pet 窗是 remote origin，get_pet_skin 必须经 capabilities/pet.json
    // 的 allow-get-pet-skin 才可达——这条断言钉入口确实走了命令缝。
    expect(invoke).toHaveBeenCalledWith("get_pet_skin", {});
    expect(document.querySelector<HTMLElement>("[data-pet-root]")?.getAttribute("data-skin")).toBe("default");
  });

  it("wudao-pet-skin 事件已挂载：plugin:event|listen 注册了 wudao-pet-skin", () => {
    expect(invoke).toHaveBeenCalledWith("plugin:event|listen", {
      event: "wudao-pet-skin",
      target: { kind: "Any" },
      handler: expect.any(Number),
    });
  });

  it("换肤事件 {skin:lake} → data-skin=lake 且 sheet 换到 skin-lake.png", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      skinHandler()({ skin: "lake" });
    });
    expect(el?.getAttribute("data-skin")).toBe("lake");
    expect(el?.querySelector<HTMLElement>(".pet-sprite-img")?.style.backgroundImage).toContain("/pet/skin-lake.png");
  });

  it("换肤事件非法载荷不改态：注册表外 id / 坏形状整帧丢弃", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      skinHandler()({ skin: "nope" }); // 注册表外 → 丢弃
    });
    expect(el?.getAttribute("data-skin")).toBe("lake"); // 上一测试之态保持
    await act(async () => {
      skinHandler()("garbage");
    });
    await act(async () => {
      skinHandler()({ skin: 42 });
    });
    await act(async () => {
      skinHandler()(null);
    });
    expect(el?.getAttribute("data-skin")).toBe("lake");
  });

  it("unmount 收回：wudao-pet-skin 的 unlisten 走过命令缝（StrictMode 双挂载）", () => {
    // StrictMode 挂载→卸载→再挂载：第一遍 effect 的 cleanup 必须收回
    // 监听（防泄漏），这里钉 plugin:event|unlisten 确实带 wudao-pet-skin。
    const unlistened = invokeCalls().some(
      ([cmd, args]) => cmd === "plugin:event|unlisten" && (args as { event?: string })?.event === "wudao-pet-skin",
    );
    expect(unlistened).toBe(true);
  });

  // --- ω99-99：跨窗状态帧 + 点击即会话 --------------------------------------

  it("跨窗状态帧驱动状态机：wudao-pet-state → stepPetMachine → data-pet-state（D2）", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    const cb = stateHandler();
    await act(async () => {
      cb({ busy: true, pendingPermission: false, reasoningActive: true, answerTail: "", busyToolCount: 0 });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("thinking");
    await act(async () => {
      cb("garbage"); // 坏帧丢弃：不炸、不改态
    });
    expect(el?.getAttribute("data-pet-state")).toBe("thinking");
    await act(async () => {
      cb({ busy: false, pendingPermission: false, reasoningActive: false, answerTail: "回答的尾巴", busyToolCount: 0 });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("done"); // busy 下降沿
    expect(invoke).toHaveBeenCalledWith("plugin:event|listen", {
      event: "wudao-pet-state",
      target: { kind: "Any" },
      handler: pet.stateHandlers.length,
    });
  });

  it("状态帧的 answerTail 流进气泡：stream 形态显示尾部文本", async () => {
    await act(async () => {
      stateHandler()({ busy: true, pendingPermission: false, reasoningActive: false, answerTail: "气泡里的流式回答", busyToolCount: 1 });
    });
    const bubble = document.querySelector<HTMLElement>("[data-bubble]");
    expect(bubble?.getAttribute("data-bubble-state")).toBe("stream");
    expect(bubble?.textContent).toContain("气泡里的流式回答");
  });

  it("点击即会话：pointerdown+同位 pointerup → 气泡 input 打开 + set_focus（D8 意图确认）", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    expect(el).not.toBeNull();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    });
    // 98 断言（0.3.81 语义）：入 drag 态；静止按下不发 start_dragging
    // （位移阈值后才发——win32 模态循环会吞点击的 pointerup）。共享
    // mock：以快照断言无新增。
    const dragCalls = (): number => invoke.mock.calls.filter((c: unknown[]) => c[0] === "plugin:window|start_dragging").length;
    const before = dragCalls();
    expect(el!.getAttribute("data-pet-state")).toBe("drag");
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 12, clientY: 11 }));
    });
    // 纯点击手势全程不进原生拖窗。
    expect(dragCalls()).toBe(before);
    expect(document.querySelector("[data-bubble]")?.getAttribute("data-bubble-state")).toBe("input");
    expect(invoke).toHaveBeenCalledWith("plugin:window|set_focus");
  });

  // --- ω99-143：输入气泡的三条焦点无关关闭通路（用户实机反馈无法关闭） -------

  /** 收敛手法：先打一帧空尾（清掉前测残留的 answerTail 流——共享挂载下
   * 它会让 Esc 后的气泡回落到 stream 形态），再 Esc 收掉可能开着的
   * input——起点必为「无气泡」（同 362 测试的收敛纪律）。 */
  async function escCloseAnyInput(): Promise<void> {
    await act(async () => {
      stateHandler()({ busy: false, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 0 });
    });
    const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]");
    if (ta !== null) {
      await act(async () => {
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    }
    expect(document.querySelector("[data-bubble]")).toBeNull();
  }

  it("ω99-143 再点一次宠物 → 收起输入（toggle），收起不再 set_focus", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await escCloseAnyInput();
    // 第一次点击：开
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 12, clientY: 11 }));
    });
    expect(document.querySelector("[data-bubble]")?.getAttribute("data-bubble-state")).toBe("input");
    const focusCalls = invokeCalls().filter(([cmd]) => cmd === "plugin:window|set_focus").length;
    // 第二次点击：收（不抢焦点）
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 12, clientY: 11 }));
    });
    expect(document.querySelector("[data-bubble]")).toBeNull();
    expect(invokeCalls().filter(([cmd]) => cmd === "plugin:window|set_focus").length).toBe(focusCalls);
  });

  it("ω99-143 窗口失焦 → 输入自动收起（点别处即放弃，不钉屏）", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await escCloseAnyInput();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 12, clientY: 11 }));
    });
    expect(document.querySelector("[data-bubble]")?.getAttribute("data-bubble-state")).toBe("input");
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(document.querySelector("[data-bubble]")).toBeNull();
  });

  it("位移 >5px 是拖拽不是点击：不开气泡，release 回机器 display", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    // 先驱动到已知态（busy+reasoning → thinking），不依赖前面的测试残留。
    await act(async () => {
      stateHandler()({ busy: true, pendingPermission: false, reasoningActive: true, answerTail: "", busyToolCount: 0 });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("thinking");
    // 上一测试留下的 input 气泡先 Esc 收起（input 收起不 linger）。
    const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]");
    await act(async () => {
      ta?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector("[data-bubble]")).toBeNull();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    });
    expect(el!.getAttribute("data-pet-state")).toBe("drag");
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 40, clientY: 10 }));
    });
    // ω99-278（续，标记 #8 见上）— 位移 30px ≥5px = 真·拖拽释放：先进
    // 450ms 回弹窗（"release"，pet-release 落地晃两下再站稳），窗后回
    // 机器 display；不开气泡照旧。
    expect(el!.getAttribute("data-pet-state")).toBe("release");
    expect(document.querySelector("[data-bubble]")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 460)); // 过 450ms 回弹窗（真表——本文件不用假表）
    });
    expect(el!.getAttribute("data-pet-state")).toBe("thinking"); // 回机器 display
    expect(document.querySelector("[data-bubble]")).toBeNull();
  });

  // ω99-278（续，标记 #8 见上）— 戳一戳端到端（§0 验收口径的行为面）：
  // 按住 ≥650ms → Q 弹层重挂（data-poked）+ 头顶表情气泡（池内句）；原地
  // 释放不开聊天（650>600 与单击天然互斥——不是仲裁延迟换来的）。
  it("按住 650ms → 戳一戳：data-poked + 表情气泡；释放不误触单击（互斥实证）", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      stateHandler()({ busy: true, pendingPermission: false, reasoningActive: true, answerTail: "", busyToolCount: 0 });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("thinking"); // 已知机器态
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    });
    expect(el!.querySelector(".pet-poke-layer")?.hasAttribute("data-poked")).toBe(false); // 戳前不带
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 660)); // 过 POKE_HOLD_MS(650)
    });
    expect(el!.querySelector<HTMLElement>(".pet-poke-layer")?.getAttribute("data-poked")).toBe(""); // Q 弹层已重挂
    const expr = document.querySelector<HTMLElement>(".pet-expr");
    expect(POKE_EXPRESSIONS).toContain(expr?.textContent ?? ""); // 池内萌系短句
    expect(expr?.getAttribute("role")).toBe("status");
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 12, clientY: 11 })); // 原地释放（<5px）
    });
    expect(document.querySelector("[data-bubble]")).toBeNull(); // 不开聊天（单击窗早已过）
    expect(el!.getAttribute("data-pet-state")).toBe("thinking"); // 无位移 → 无回弹窗，即回机器态
  });
});

// ω99-282（续，标记 #4 见上）— 两边界收紧的端到端行为面（brief §2 用例
// 1/3/4；用例 2「原地戳仍灵」= 既有 :592-614 零改动跑绿即证）。真表沿
// 660ms 既有范式；window.screenX 是 jsdom 只读 accessor——Object.defineProperty
// 覆盖（configurable），用后 delete 还原（零跨用例污染）。
describe("ω99-282 戳一戳两边界收紧（搬运中不戳 / data-poked 瞬时态）", () => {
  /** 覆写 window.screenX（jsdom 该属性是只读 accessor，直接赋值静默失败）。 */
  const setScreenX = (v: number): void => {
    Object.defineProperty(window, "screenX", { configurable: true, value: v });
  };
  /** 中性收尾 pointerup（原地 <5px、历时 >600ms：不回弹不开气泡）；dragging
   *  已 false 时释放监听不在场=无操作。断言中途失败也不把 drag 态漏给后续
   *  用例——三用例共用（try/finally 收尾）。 */
  const neutralRelease = async (): Promise<void> => {
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 12, clientY: 11 }));
    });
  };

  it("搬运中不戳：按住期间窗被搬 ≥5px → 650ms 到点不触发（无 data-poked/无 .pet-expr），真拖拽释放仍回弹", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      stateHandler()({ busy: true, pendingPermission: false, reasoningActive: true, answerTail: "", busyToolCount: 0 });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("thinking"); // 已知机器态
    // 前一用例（278 原地戳）的 pokeExpr 窗（POKE_EXPR_MS 2200）可能尚未走
    // 完——先等它自消再起手势，「无 .pet-expr」断言才指向本用例（零残留）。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300));
    });
    expect(document.querySelector(".pet-expr")).toBeNull(); // 前窗已清（前置）
    setScreenX(100); // 按下时刻的窗位
    try {
      await act(async () => {
        el!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
      });
      setScreenX(160); // 原生拖窗期页面收不到 pointermove——窗位差是唯一位移事实（60px ≥5px）
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 660)); // 过 POKE_HOLD_MS(650)
      });
      // 语义收尾先行（释放不触发/清除已触发的戳——pokeTimer 已燃尽为 null）：
      // 后两条断言只读 UI 态，顺序无关 → 断言失败也不漏 drag 态给后续用例。
      await act(async () => {
        window.dispatchEvent(new MouseEvent("pointerup", { clientX: 40, clientY: 10 })); // 位移 30px ≥5px
      });
      expect(el!.getAttribute("data-pet-state")).toBe("release"); // 搬运语义未误伤：照走回弹窗
      expect(el!.querySelector(".pet-poke-layer")?.hasAttribute("data-poked")).toBe(false); // 搬运中 → 不戳
      expect(document.querySelector(".pet-expr")).toBeNull(); // 也不冒表情（整个回调没跑）
    } finally {
      await neutralRelease();
      delete (window as { screenX?: number }).screenX; // 还原 jsdom 原值
    }
  });

  it("data-poked 瞬时态：戳后 600ms 窗内在场，过 POKE_SQUASH_MS 属性撤（动画单次无 fill，零视觉差）", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    try {
      await act(async () => {
        el!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 660)); // 戳触发（真表范式）
      });
      expect(el!.querySelector<HTMLElement>(".pet-poke-layer")?.getAttribute("data-poked")).toBe(""); // 窗内
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 620)); // 过 POKE_SQUASH_MS(600)
      });
      expect(el!.querySelector(".pet-poke-layer")?.hasAttribute("data-poked")).toBe(false); // 窗外已撤
    } finally {
      await neutralRelease(); // 原地释放收尾
    }
  });

  it("wake nudge 不重放 squash：戳后瞬时窗已过 → hidden→visible 重挂的新层不带 data-poked", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 660)); // 戳触发
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 620)); // 瞬时窗已过（属性已撤）
    });
    await neutralRelease(); // 收尾先行：后续断言只读重挂节点，与释放无关
    try {
      const before = document.querySelector<HTMLElement>("[data-pet-root]");
      const setHidden = (hidden: boolean): void => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      };
      await act(async () => {
        setHidden(true);
        void document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {
        setHidden(false);
        void document.dispatchEvent(new Event("visibilitychange"));
      });
      const after = document.querySelector<HTMLElement>("[data-pet-root]");
      expect(after).not.toBe(before); // key 重挂 → 节点 identity 变（沿 wake nudge 缝）
      expect(after?.querySelector(".pet-poke-layer")?.hasAttribute("data-poked")).toBe(false); // 不重放 squash
    } finally {
      await neutralRelease();
    }
  });
});

  // --- ω99-109：接线——帧里的 ask 落进气泡确认卡 --------------------------------

  it("帧带合法 ask → 气泡出确认卡（state=ask，徽标+按钮组），机器仍入 waiting-user", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      stateHandler()({
        busy: false, pendingPermission: true, reasoningActive: false, answerTail: "", busyToolCount: 0,
        ask: { toolName: "Bash", summary: "rm -rf build", canAlways: true },
      });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("waiting-user");
    const card = document.querySelector<HTMLElement>("[data-bubble]");
    expect(card?.getAttribute("data-bubble-state")).toBe("ask");
    expect(card?.textContent).toContain("Bash");
    expect(card?.textContent).toContain("rm -rf build");
    expect(card?.querySelector("[data-ask-allow]")).not.toBeNull();
    expect(card?.querySelector("[data-ask-always]")).not.toBeNull();
    expect(card?.querySelector("[data-ask-deny]")).not.toBeNull();
  });

  it("老帧兼容：无 ask 字段照常解析（无卡，机器照走）", async () => {
    await act(async () => {
      stateHandler()({ busy: true, pendingPermission: false, reasoningActive: true, answerTail: "", busyToolCount: 0 });
    });
    expect(document.querySelector<HTMLElement>("[data-pet-root]")?.getAttribute("data-pet-state")).toBe("thinking");
    expect(document.querySelector("[data-ask-card]")).toBeNull();
  });

  it("坏 ask（字段类型不齐）→ 整帧丢弃：不炸、不改态、不出卡", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      stateHandler()({
        busy: true, pendingPermission: false, reasoningActive: true, answerTail: "", busyToolCount: 0,
        ask: { toolName: 42, summary: "x", canAlways: true }, // toolName 非字符串
      });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("thinking"); // 上帧之态保持
    expect(document.querySelector("[data-ask-card]")).toBeNull();
    await act(async () => {
      stateHandler()({
        busy: true, pendingPermission: false, reasoningActive: true, answerTail: "", busyToolCount: 0,
        ask: "junk", // 非对象
      });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("thinking");
  });

  it("端到端：点「允许」→ emit wudao-pet-answer {allow:true}（经 invoke 桥）", async () => {
    await act(async () => {
      stateHandler()({
        busy: false, pendingPermission: true, reasoningActive: false, answerTail: "", busyToolCount: 0,
        ask: { toolName: "Bash", summary: "再次确认", canAlways: false },
      });
    });
    const btn = document.querySelector<HTMLButtonElement>("[data-ask-allow]");
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(invoke).toHaveBeenCalledWith("plugin:event|emit", {
      event: "wudao-pet-answer",
      payload: { allow: true },
    });
    // 本地不乐观清卡：服务器帧未回流前卡仍在（按钮已禁用）
    expect(document.querySelector("[data-ask-card]")).not.toBeNull();
    expect(btn?.disabled).toBe(true);
  });

// --- ω99-113：接线——帧里的 busyNarration 落进气泡旁白 --------------------------

describe("ω99-113 busyNarration 接线（pet 入口 wiring）", () => {
  it("帧带旁白 → 气泡 narration 形态说人话；机器照入 working（busyToolCount 驱动不变）", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      stateHandler()({
        busy: true, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 1,
        busyNarration: "正在读页面…",
      });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("working");
    const bubbleEl = document.querySelector<HTMLElement>("[data-bubble]");
    expect(bubbleEl?.getAttribute("data-bubble-state")).toBe("narration");
    expect(bubbleEl?.textContent).toContain("正在读页面…");
  });

  it("老帧无 busyNarration 字段 → 兼容无旁白（stream 照显，机器照走）", async () => {
    await act(async () => {
      stateHandler()({
        busy: true, pendingPermission: false, reasoningActive: false, answerTail: "老主窗的尾巴", busyToolCount: 2,
      });
    });
    const bubbleEl = document.querySelector<HTMLElement>("[data-bubble]");
    expect(bubbleEl?.getAttribute("data-bubble-state")).toBe("stream");
    expect(bubbleEl?.textContent).toContain("老主窗的尾巴");
  });

  it("坏 busyNarration（数字）→ 整帧丢弃：不炸、不改态、不出旁白", async () => {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      stateHandler()({
        busy: true, pendingPermission: false, reasoningActive: true, answerTail: "", busyToolCount: 0,
      });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("thinking");
    await act(async () => {
      stateHandler()({
        busy: true, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 1,
        busyNarration: 42,
      });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("thinking"); // 坏帧丢弃，上帧之态保持
    // 不出旁白（上一测试可能留下 linger 中的 stream 气泡——只断言不是 narration）
    expect(document.querySelector("[data-bubble]")?.getAttribute("data-bubble-state")).not.toBe("narration");
    expect(document.querySelector("[data-bubble-narration]")).toBeNull();
  });
});

// --- ω99-110：划词接单卡接线（Rust wudao-pet-selection → 宠物 selection 卡）---

/** ω99-110 — the entry's LIVE wudao-pet-selection handler (the same
 *  lookup pattern as skinHandler(): the LAST listen registration for this
 *  event wins across StrictMode's double-mount). */
function selectionHandler(): (p: unknown) => void {
  const call = [...invokeCalls()]
    .reverse()
    .find(([cmd, args]) => cmd === "plugin:event|listen" && (args as { event?: string })?.event === "wudao-pet-selection");
  const handlerId = (call?.[1] as { handler?: number } | undefined)?.handler;
  const h = typeof handlerId === "number" ? pet.stateHandlers[handlerId - 1] : undefined;
  if (typeof h !== "function") throw new Error("no selection handler registered");
  return h;
}

describe("ω99-110 划词接单卡（pet 入口 wiring）", () => {
  /** 清掉上一测试残留的 ask 帧（109 端到端留下了 pendingPermission）——
   *  ask > selection，不清则接单卡被压住。 */
  async function clearAskFrame(): Promise<void> {
    await act(async () => {
      stateHandler()({ busy: false, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 0 });
    });
  }

  it("wudao-pet-selection 事件已挂载（plugin:event|listen）", () => {
    expect(invoke).toHaveBeenCalledWith("plugin:event|listen", {
      event: "wudao-pet-selection",
      target: { kind: "Any" },
      handler: expect.any(Number),
    });
  });

  it("好载荷 → 接单卡出现（选文摘录 + chips）；帧驱动照常（state 监听仍是最后一个）", async () => {
    await clearAskFrame();
    await act(async () => {
      selectionHandler()({ text: "the quick brown fox", truncated: false, granted: true });
    });
    const card = document.querySelector<HTMLElement>("[data-selection-card]");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("the quick brown fox");
    expect(card?.querySelector("[data-selection-translate]")).not.toBeNull();
    // 状态帧 handler 仍可驱动（selection 监听没有抢走最后的注册位）
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      stateHandler()({ busy: true, pendingPermission: false, reasoningActive: true, answerTail: "", busyToolCount: 0 });
    });
    expect(el?.getAttribute("data-pet-state")).toBe("thinking");
  });

  it("新选段整只替换旧卡；坏载荷整丢（卡保持、不炸）", async () => {
    await clearAskFrame();
    await act(async () => {
      selectionHandler()({ text: "first selection", truncated: false, granted: true });
    });
    expect(document.querySelector<HTMLElement>("[data-selection-card]")?.textContent).toContain("first selection");
    await act(async () => {
      selectionHandler()({ text: "second selection", truncated: false, granted: true });
    });
    const card = document.querySelector<HTMLElement>("[data-selection-card]");
    expect(card?.textContent).toContain("second selection");
    expect(card?.textContent).not.toContain("first selection");
    // 坏载荷：非对象 / 缺键 / 类型错 → 整丢
    await act(async () => {
      selectionHandler()("garbage");
    });
    await act(async () => {
      selectionHandler()({ text: 42, truncated: false, granted: true });
    });
    await act(async () => {
      selectionHandler()({ truncated: false, granted: true });
    });
    expect(document.querySelector<HTMLElement>("[data-selection-card]")?.textContent).toContain("second selection");
  });

  it("unmount 收回：wudao-pet-selection 的 unlisten 走过命令缝（StrictMode 双挂载）", () => {
    const unlistened = invokeCalls().some(
      ([cmd, args]) => cmd === "plugin:event|unlisten" && (args as { event?: string })?.event === "wudao-pet-selection",
    );
    expect(unlistened).toBe(true);
  });

  it("端到端：点「翻译」chip → emit wudao-pet-selection-submit（成品 prompt 经 invoke 桥）", async () => {
    await clearAskFrame();
    await act(async () => {
      selectionHandler()({ text: "the quick brown fox", truncated: false, granted: true });
    });
    const chip = document.querySelector<HTMLButtonElement>("[data-selection-translate]");
    expect(chip).not.toBeNull();
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(invoke).toHaveBeenCalledWith("plugin:event|emit", {
      event: "wudao-pet-selection-submit",
      payload: { text: "翻译这段划选的文字（按原文方向中英互译）：\n\nthe quick brown fox" },
    });
  });
});

// ω99-237: #11 — 宠物窗 toast 面（斜杠早拦的回执渲染）：主窗 relay 的 pet 源
// 早拦（relay 域钉在 omega99-235-pet-isolation.test.tsx #10）经事件总线回
// wudao-pet-toast——入口监听后渲染 [data-pet-toast]（文案逐字，brief §二），
// 并回滚「被拒轮」的乐观占位（onPetTurn 在发送时 push 的 q 行 + awaiting
// 旗——轮被拒永无来帧，不回滚就是一行永久的假「思考中…」）。
describe("ω99-237 宠物窗 toast（早拦回执 + 被拒轮回滚）", () => {
  const TOAST_TEXT = "精灵窗口不支持斜杠命令——直接提问，或到主窗口输入命令";

  /** ω99-237 — the entry's LIVE wudao-pet-toast handler（selectionHandler
   *  同款：listen 调用的 handler id → transformCallback 槽位；StrictMode
   *  幸存挂载的注册取 last）。 */
  function toastHandler(): (p: unknown) => void {
    const call = [...invokeCalls()]
      .reverse()
      .find(([cmd, args]) => cmd === "plugin:event|listen" && (args as { event?: string })?.event === "wudao-pet-toast");
    const handlerId = (call?.[1] as { handler?: number } | undefined)?.handler;
    const h = typeof handlerId === "number" ? pet.stateHandlers[handlerId - 1] : undefined;
    if (typeof h !== "function") throw new Error("no toast handler registered");
    return h;
  }

  /** 收敛：清帧 + Esc 收掉可能开着的 input（omega99-143 的 Esc 通路）。held
   *  stream 是 ω99-196 的合法停留态，不强行清——toast 是独立浮层，渲染断言
   *  与气泡形态无关（端到端件只要求 input 确定开/关）。 */
  async function convergeIdle(): Promise<void> {
    await act(async () => {
      stateHandler()({ busy: false, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 0 });
    });
    const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]");
    if (ta !== null) {
      await act(async () => {
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    }
  }

  /** 点开输入气泡（ω99-143 toggle 形：pointerdown+同位 pointerup）。 */
  async function clickOpenInput(): Promise<void> {
    const el = document.querySelector<HTMLElement>("[data-pet-root]");
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 12, clientY: 11 }));
    });
    expect(document.querySelector("[data-bubble]")?.getAttribute("data-bubble-state")).toBe("input");
  }

  /** 受控 textarea 的 React 写法（native setter + input 事件——本仓无
   *  testing-library，pet-bubble.test.tsx 的 typeInto 同款）。 */
  function typeInto(ta: HTMLTextAreaElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(ta, value);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("wudao-pet-toast 事件已挂载（plugin:event|listen，state 监听仍为最末注册）", () => {
    expect(invoke).toHaveBeenCalledWith("plugin:event|listen", {
      event: "wudao-pet-toast",
      target: { kind: "Any" },
      handler: expect.any(Number),
    });
  });

  it("toast 事件 → [data-pet-toast] role=status 逐字渲染；坏载荷整丢（不炸不覆盖）", async () => {
    await convergeIdle();
    await act(async () => {
      toastHandler()({ text: TOAST_TEXT });
    });
    const el = document.querySelector<HTMLElement>("[data-pet-toast]");
    expect(el?.getAttribute("role")).toBe("status");
    expect(el?.textContent).toBe(TOAST_TEXT);
    await act(async () => {
      toastHandler()({ text: 42 }); // 坏载荷：整丢
    });
    expect(document.querySelector("[data-pet-toast]")?.textContent).toBe(TOAST_TEXT); // 在场 toast 原样
  });

  it("端到端：发送 /clear → ask 事件照发；toast 到达 → 被拒轮的 q 行/思考中格消失", async () => {
    await convergeIdle();
    await clickOpenInput();
    const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]")!;
    typeInto(ta, "/clear");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-bubble-send]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 发送侧（哑面照发——早拦在主窗 relay，宠物窗无车道知识）：ask 事件已上桥，
    // transcript 记了乐观 q 行（+「思考中…」活格——onPetTurn 的即时通路）。
    expect(invoke).toHaveBeenCalledWith("plugin:event|emit", { event: "wudao-pet-ask", payload: { text: "/clear" } });
    const transcript = document.querySelector<HTMLElement>("[data-bubble-transcript]")!;
    expect(transcript.textContent).toContain("/clear");
    expect(transcript.textContent).toContain("思考中…");
    // 主窗 relay 拒令 → toast 回执到达：toast 逐字在场 + 死轮回滚。
    await act(async () => {
      toastHandler()({ text: TOAST_TEXT });
    });
    expect(document.querySelector<HTMLElement>("[data-pet-toast]")?.textContent).toBe(TOAST_TEXT);
    const after = document.querySelector<HTMLElement>("[data-bubble-transcript]")!;
    expect(after.textContent).not.toContain("/clear"); // 被拒轮的乐观占位弹掉
    expect(after.textContent).not.toContain("思考中…");
  });
});
