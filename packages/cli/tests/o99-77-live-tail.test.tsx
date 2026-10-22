// ω99-77 — TUI busy-tool tail line（63-C4 停泊债）。ω99-63 给 driver 的
// busyTools 加了 tail（agent-driver.ts onToolUpdate 按行折叠的有界活动尾），
// web 的 BusyToolRow 已渲染（LiveArea.tsx `act-tail-line`），TUI 的 LiveArea
// 却只渲染 `Spinner name (summary)` + 🛡 徽章——终端用户看不见长工具/子
// agent 的进行时进度。这些用例把 web 钉的同一条契约钉到第三面：
//   · 尾 = tail 的最后一个非空行（空行按 trim 过滤）；
//   · 截断到 120 字符（web 同一条界——一契约三面，靠测试钉不靠共享代码）；
//   · 无 tail / 尾里没有非空行 ⇒ 零输出行，busyTool 行渲染字节不变；
//   · 🛡 gating 徽章与尾行共存（徽章行为零动）。
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { LiveArea } from "../src/tui/app.js";
import type { LiveState } from "../src/tui/use-agent.js";

const live = (busyTools: LiveState["busyTools"]): LiveState => ({ reasoning: "", answer: "", busyTools });

// ink-testing-library strips ANSI, so all assertions are content-level (the
// dim styling is an implementation idiom, pinned by review not by frame).
describe("ω99-77 — LiveArea busy-tool tail line (63-C4)", () => {
  it("renders a single-line tail as its own line under the busy row", () => {
    const r = render(
      <LiveArea live={live([{ name: "shell", summary: "make test", tail: "BUILD-STEP-42 passed" }])} queued={[]} />,
    );
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("shell");
    expect(frame).toContain("make test");
    expect(frame).toContain("BUILD-STEP-42 passed");
    r.unmount();
  });

  it("a multi-line tail shows only the LAST non-empty line", () => {
    const r = render(
      <LiveArea
        live={live([
          { name: "shell", summary: "build", tail: "first-line\nmiddle-line\n\nlast-line\n" },
        ])}
        queued={[]}
      />,
    );
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("last-line");
    expect(frame).not.toContain("first-line");
    expect(frame).not.toContain("middle-line");
    r.unmount();
  });

  it("no tail ⇒ no extra line: the busy row renders byte-identical", () => {
    // Two mounts read back-to-back (both at spinner tick 0) — identical bytes
    // prove the absent tail adds zero output, the ω99-63 pre-change contract.
    const plain = render(
      <LiveArea live={live([{ name: "shell", summary: "make test" }])} queued={[]} />,
    );
    const noTail = render(
      <LiveArea live={live([{ name: "shell", summary: "make test", tail: undefined }])} queued={[]} />,
    );
    expect(noTail.lastFrame()).toBe(plain.lastFrame());
    plain.unmount();
    noTail.unmount();
  });

  it("a tail with no non-empty line renders no line either (same bytes as no tail)", () => {
    const plain = render(
      <LiveArea live={live([{ name: "shell", summary: "make test" }])} queued={[]} />,
    );
    const blankTail = render(
      <LiveArea live={live([{ name: "shell", summary: "make test", tail: "\n   \n" }])} queued={[]} />,
    );
    expect(blankTail.lastFrame()).toBe(plain.lastFrame());
    plain.unmount();
    blankTail.unmount();
  });

  it("a tail line longer than 120 chars truncates to 120 + … (the web-aligned bound)", () => {
    const r = render(
      <LiveArea live={live([{ name: "shell", summary: "x", tail: "X".repeat(200) }])} queued={[]} />,
    );
    // ink wraps at terminal width — assert on the newline-stripped frame
    // (the OOM-suite idiom).
    const flat = (r.lastFrame() ?? "").replace(/\n/g, "");
    expect(flat).toContain("X".repeat(120) + "…");
    expect(flat).not.toContain("X".repeat(121));
    r.unmount();
  });

  it("the 🛡 gating badge coexists with the tail line", () => {
    const r = render(
      <LiveArea
        live={live([
          { name: "shell", summary: "rm -rf /tmp/x", gating: true, tail: "dry-run ok" },
        ])}
        queued={[]}
      />,
    );
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("🛡 检查中"); // ω99-161: 徽章串随源演进。
    expect(frame).toContain("dry-run ok");
    r.unmount();
  });
});
