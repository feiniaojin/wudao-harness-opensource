// @vitest-environment jsdom
// M64-visual §2 → inkline Task 7 (spec §2) — the rebuilt input card: the
// 14px-radius composer shell (`.composer`) with the tools row IN-CARD
// (`.composer-tools`: chips left, `.composer-right` holding the `.ctx`
// readout + the 28px square-round send), the chip language (radius-sm,
// hairline --line border, 24px), and ContextMeter re-shelled as the inline
// `.ctx` (12px ring + mono ▲N.Nk). The permission chip + popup menu keep
// riding controlsPrefix, and the token-styled approval card is unchanged.
import { afterEach, describe, expect, it, vi } from "vitest";
// flow-visual's seam: the sheet as raw text (jsdom never sees a file:// URL).
import { stylesCss } from "./styles-source.js";
import { act } from "react";
import { InputBox } from "../src/components/InputBox.js";
import { SimpleComposer } from "../src/components/SimpleComposer.js";
import { SimpleApprovalCard } from "../src/components/SimpleApprovalCard.js";
// F9: the shared visual-suite seams (mount/unmount).
import { mount, unmount } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  unmount();
});

const INPUT_PROPS = {
  busy: false,
  mode: "workspace" as const,
  commands: [],
  connected: true,
  onSubmit: vi.fn(),
  onInterrupt: vi.fn(),
  onShield: vi.fn(),
  onCycleMode: vi.fn(),
};

describe("inkline Task 7 — the composer card shell (spec §2)", () => {
  it("composer card: the 119 input-card radius (md 8) + tools row inside (no external rows)", () => {
    const css = stylesCss;
    // 116 弧 A: the card is an ELEVATION surface — --elev-2 (hairline stroke
    // INTO the shadow), border retired (the old 1px-edge + heavy-shadow double
    // outline was 116's cheapness source #2). 119 用户反馈修正（圆角统一）：
    // 输入条从 22px 胶囊归卡片族 8px（一套 6/8/12 scale）。
    expect(css).toMatch(/\.composer\s*\{[^}]*var\(--radius-md\)/s);
    expect(css).toMatch(/\.composer\s*\{[^}]*var\(--elev-2\)/s);
    expect(css).toMatch(/\.composer\s*\{[^}]*border:\s*0;/s);
    expect(css).toMatch(/\.composer-tools/);
    // The DOM contract: textarea + tools row are the card's direct children;
    // the old `.row`/`.left`/`.right` toolbar chrome is gone.
    const c = mount(<InputBox {...INPUT_PROPS} />);
    expect(c.querySelector(".composer > .composer-ta")).not.toBeNull();
    expect(c.querySelector(".composer > .composer-tools")).not.toBeNull();
    expect(c.querySelector(".composer .row")).toBeNull();
    expect(c.querySelector(".composer .left")).toBeNull();
    expect(c.querySelector(".composer .right")).toBeNull();
  });

  it("send button 28px square-round, disabled `.off` (.4) when empty — gone on input, back after submit", async () => {
    const c = mount(<InputBox {...INPUT_PROPS} />);
    const send = c.querySelector("button.send") as HTMLButtonElement;
    expect(send).not.toBeNull();
    expect(send.classList.contains("off")).toBe(true); // empty draft
    expect(send.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true"); // IconArrowUp, decorative
    const input = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "hello");
    });
    expect(send.classList.contains("off")).toBe(false);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(INPUT_PROPS.onSubmit).toHaveBeenCalledWith("hello");
    expect(send.classList.contains("off")).toBe(true); // the cleared draft stands it down again
  });

  // 墨线 T15 终门 — the send's whole state vocabulary is the `.off` suffix:
  // stood-down is exactly `send off`, armed is exactly bare `send` (no third
  // class ever rides the button — the disabled attribute is separate).
  it("T15 gate — send class names: exactly `send off` stood down vs bare `send` armed", async () => {
    const c = mount(<InputBox {...INPUT_PROPS} />);
    const send = c.querySelector("button.send") as HTMLButtonElement;
    expect(send.className).toBe("send off"); // empty draft
    const input = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "armed");
    });
    expect(send.className).toBe("send");
  });
});

describe("M64-visual §2 → inkline — InputBox: the composer card", () => {
  it("renders the composer card: borderless textarea on top, tools row below", () => {
    const c = mount(<InputBox {...INPUT_PROPS} />);
    expect(c.querySelector(".composer")).not.toBeNull();
    expect(c.querySelector(".composer-tools")).not.toBeNull();
    // The textarea lives INSIDE the card; the old prompt/inputrow chrome is gone.
    expect(c.querySelector(".inputrow")).toBeNull();
    expect(c.querySelector(".composer textarea.wudao-input")).not.toBeNull();
  });

  it("offline: the send button stands down (disabled) even with a draft", async () => {
    const c = mount(<InputBox {...INPUT_PROPS} connected={false} />);
    const send = c.querySelector("button.send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const input = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "draft kept offline");
    });
    expect(send.disabled).toBe(true);
  });

  it("controlsPrefix rides the tools row's LEFT slot; controlsSuffix + send ride the composer-right cluster", () => {
    const c = mount(
      <InputBox
        {...INPUT_PROPS}
        controlsPrefix={<button type="button" className="chip">左</button>}
        controlsSuffix={<span className="mark-suffix">右</span>}
      />,
    );
    // The 📎 chip leads the left slot now, so the prefix chip is matched by
    // its text, not by position.
    const chips = [...c.querySelectorAll(".composer-tools > .chip")] as HTMLButtonElement[];
    expect(chips.map((b) => b.textContent)).toContain("左");
    expect(c.querySelector(".composer-tools .composer-right .mark-suffix")).not.toBeNull();
    expect(c.querySelector(".composer-tools .composer-right button.send")).not.toBeNull();
  });

  // Final-review F2 → M79b: the paperclip is LIVE now — it opens the image
  // picker (the hidden input's click), disabled only while offline. The
  // mounted-drafts count rides the chip (asserted in m79b-images).
  it("the attach chip opens the image picker (M79b); offline it stands down", () => {
    const c = mount(<InputBox {...INPUT_PROPS} />);
    const clip = c.querySelector(".composer-tools button.chip.attach") as HTMLButtonElement;
    expect(clip).not.toBeNull();
    expect(clip.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true"); // P5: decorative
    expect(clip.disabled).toBe(false);
    expect(clip.title).toContain("添加图片");
    const input = c.querySelector(".composer input[type=file]") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.getAttribute("accept")).toBe("image/*");
    expect(input.hasAttribute("multiple")).toBe(true);
    const offline = mount(<InputBox {...INPUT_PROPS} connected={false} />);
    expect((offline.querySelector("button.chip.attach") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the `/` chip is advanced-only (slashChip); clicking focuses the textarea and starts the draft with /", async () => {
    const bare = mount(<InputBox {...INPUT_PROPS} />);
    expect(bare.querySelector(".composer-tools button.slash")).toBeNull();
    const c = mount(<InputBox {...INPUT_PROPS} slashChip={true} />);
    const chip = c.querySelector(".composer-tools button.slash") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe("/");
    // The mount effect already focuses the textarea — blur so the click's
    // focus is observable on its own.
    const ta = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      ta.blur();
    });
    expect(document.activeElement).not.toBe(ta);
    await act(async () => {
      chip.click();
    });
    expect(document.activeElement).toBe(ta);
    expect(ta.value.startsWith("/")).toBe(true);
    // Idempotent: a second click neither doubles the "/" nor blurs.
    await act(async () => {
      chip.click();
    });
    expect(ta.value).toBe("/");
    // The "/" draft opens the command menu on its token (commands supplied).
    const withCommands = mount(
      <InputBox {...INPUT_PROPS} slashChip={true} commands={[{ name: "help", description: "列出命令", source: "builtin" }]} />,
    );
    await act(async () => {
      (withCommands.querySelector("button.slash") as HTMLButtonElement).click();
    });
    expect(withCommands.querySelector(".slashmenu")).not.toBeNull();
  });
});

// M65-space §2 — the line under the composer is conditional-only: the
// standing keys hint ("Enter to send · / commands · esc interrupt") is
// deleted; just the @-mention and the offline notice ever render.
describe("M65-space §2 — InputBox: no standing hint below the composer", () => {
  it("connected, no mention: NO .hint line below the composer", () => {
    const c = mount(<InputBox {...INPUT_PROPS} />);
    expect(c.querySelector(".inputarea > .hint")).toBeNull();
  });

  it("an @-token shows the mention hint; collapsing the token hides it", async () => {
    const c = mount(<InputBox {...INPUT_PROPS} />);
    const input = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "see @src/app.tsx");
    });
    // ω99-152: mention hint 模板中文化（原 "attached on send (expanded
    // relative to the workspace root)"）——钉的是 @token ⇒ hint 行，文案随源走。
    expect(c.querySelector(".inputarea > .hint")?.textContent).toContain("@src/app.tsx → 发送时会附上");
    // A trailing space ends the @-token: the hint folds again.
    await act(async () => {
      type(input, "see @src/app.tsx ");
    });
    expect(c.querySelector(".inputarea > .hint")).toBeNull();
  });

  it("offline: the offline notice rides the .hint line", () => {
    const c = mount(<InputBox {...INPUT_PROPS} connected={false} />);
    expect(c.querySelector(".inputarea > .hint")?.textContent).toContain("离线——正在等待服务恢复；草稿已保留");
  });
});

describe("inkline Task 7 — SimpleComposer: the chip toolbar + the inline .ctx", () => {
  const COMPOSER_PROPS = {
    busy: false,
    mode: "workspace" as const,
    commands: [],
    connected: true,
    ctx: { used: 400, window: 1000, nearLimit: false },
    lane: "queue" as const,
    onLane: vi.fn(),
    parked: [],
    onDropParked: vi.fn(),
    onSubmit: vi.fn(),
    onInterrupt: vi.fn(),
    onCycleMode: vi.fn(),
    onShield: vi.fn(),
    onDraftApplied: vi.fn(),
  };

  it("renders NO `.shield-row`; the permission entry is a `.chip` inside the card's tools row", () => {
    const c = mount(<SimpleComposer {...COMPOSER_PROPS} />);
    expect(c.querySelector(".shield-row")).toBeNull();
    expect(c.querySelector(".composer-tools .pop > button.chip")).not.toBeNull();
  });

  it("the chip opens the `.pop .menu` with the three tiers; auto carries the 需确认 badge", async () => {
    const c = mount(<SimpleComposer {...COMPOSER_PROPS} />);
    // The shield trigger (not the 📎 chip that now leads the row).
    const chip = c.querySelector(".composer-tools .pop > button.chip") as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });
    const menu = c.querySelector(".pop .menu") as HTMLElement;
    expect(menu).not.toBeNull();
    const items = [...c.querySelectorAll(".pop .mi")] as HTMLButtonElement[];
    expect(items.map((m) => m.getAttribute("data-mode"))).toEqual(["ask", "workspace", "auto", "plan"]);
    expect(c.querySelector(".pop .mi .warned")?.textContent).toContain("需确认");
  });

  it("the context readout is the inline `.ctx` beside send: 12px ring + mono ▲N.Nk", () => {
    const c = mount(<SimpleComposer {...COMPOSER_PROPS} />);
    const ctx = c.querySelector(".composer-tools .composer-right .ctx") as HTMLElement;
    expect(ctx).not.toBeNull();
    const ring = ctx.querySelector(".ctx-btn svg") as SVGSVGElement;
    expect(ring.getAttribute("width")).toBe("12");
    expect(ring.getAttribute("height")).toBe("12");
    // formatTokensK(400) → "0.4k": the mono label rides the trigger.
    expect(ctx.querySelector(".ctx-num")?.textContent).toBe("▲0.4k");
    // The legend popover keeps the M63 §D aggregate (click to open).
    expect(c.querySelector(".ctxmeter-legend")).toBeNull();
  });

  it("the send button stands `.off` on the empty draft (spec §2: .4)", () => {
    const c = mount(<SimpleComposer {...COMPOSER_PROPS} />);
    expect(c.querySelector(".composer-right .send")?.classList.contains("off")).toBe(true);
  });

  it("while busy the lane chips ride the tools row as chips", () => {
    const c = mount(<SimpleComposer {...COMPOSER_PROPS} busy={true} />);
    expect(c.querySelector(".composer-tools .lane-toggle button[data-lane='steer']")).not.toBeNull();
    expect(c.querySelector(".lane-hint")).toBeNull(); // the hint folded into the chip titles
  });
});

describe("M64-visual §2 — SimpleApprovalCard: the token-styled `.approval` card", () => {
  const ASK = {
    toolName: "shell",
    summary: "运行测试以验证修复(只读命令,不修改文件)",
    input: { command: "pnpm --filter app test -- Login.test.tsx" },
  } as const;

  it("renders strip + one-line reason + mono command block + right-aligned buttons", () => {
    const c = mount(<SimpleApprovalCard ask={ASK} onChoose={() => {}} />);
    expect(c.querySelector(".approval")).not.toBeNull();
    expect(c.querySelector(".approval .strip")?.textContent).toContain("等待");
    expect(c.querySelector(".approval .why")?.textContent).toContain("运行测试以验证修复");
    const cmd = c.querySelector(".approval .cmd") as HTMLElement;
    expect(cmd.textContent).toContain("pnpm --filter app test");
    // 拒绝 / 允许一次 sit OUTSIDE the command's scroll region.
    const btns = c.querySelector(".approval .btns") as HTMLElement;
    expect(btns.querySelector("button.deny")).not.toBeNull();
    expect(btns.querySelector("button.allow")).not.toBeNull();
    expect(btns.querySelector("button.allow")?.textContent).toContain("允许一次");
    expect(cmd.contains(btns)).toBe(false);
  });

  it("the two answer paths fire; busy (op in flight) stands both buttons down", async () => {
    const onChoose = vi.fn();
    const c = mount(<SimpleApprovalCard ask={ASK} onChoose={onChoose} />);
    await act(async () => {
      (c.querySelector(".approval .btns button.deny") as HTMLButtonElement).click();
    });
    expect(onChoose).toHaveBeenCalledWith({ allow: false });
    await act(async () => {
      (c.querySelector(".approval .btns button.allow") as HTMLButtonElement).click();
    });
    expect(onChoose).toHaveBeenCalledWith({ allow: true });
    const busy = mount(<SimpleApprovalCard ask={ASK} busy={true} onChoose={onChoose} />);
    expect((busy.querySelector(".approval .btns button.deny") as HTMLButtonElement).disabled).toBe(true);
    expect((busy.querySelector(".approval .btns button.allow") as HTMLButtonElement).disabled).toBe(true);
  });
});
