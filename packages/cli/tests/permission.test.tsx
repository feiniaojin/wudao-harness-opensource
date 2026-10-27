// M33 §1: the TUI permission prompt — the y/a/N menu. y allows once, a allows
// for the session (the App records the allowlist rule), n denies with an
// optional typed reason (Enter confirms; Esc/Ctrl+C deny without one).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { PermissionPrompt } from "../src/tui/permission.js";
import type { AskAnswer } from "../src/permission.js";

const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));

const lastChoice = (spy: ReturnType<typeof vi.fn>): AskAnswer | undefined =>
  spy.mock.calls[spy.mock.calls.length - 1]?.[0] as AskAnswer | undefined;

describe("PermissionPrompt component (y/a/N menu)", () => {
  it("calls onChoose with allow when 'y' is pressed", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "write_file", summary: "src/a.ts", onChoose }),
    );
    await wait();
    stdin.write("y");
    await wait();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ kind: "allow" });
    unmount();
  });

  it("calls onChoose with session when 'a' is pressed", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "write_file", summary: "src/a.ts", onChoose }),
    );
    await wait();
    stdin.write("a");
    await wait();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ kind: "session" });
    unmount();
  });

  it("pressing 'n' opens the reason input; Enter with text denies carrying the reason", async () => {
    const onChoose = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "write_file", summary: "src/a.ts", onChoose }),
    );
    await wait();
    stdin.write("n");
    await wait();
    // ω99-158: 理由帧标题中文化（键道/编辑逻辑零动，只钉文案）。
    const reasonFrame = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(reasonFrame).toContain("🔑 拒绝");
    expect(onChoose).not.toHaveBeenCalled();
    stdin.write("run tests first");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ kind: "deny", reason: "run tests first" });
    unmount();
  });

  it("pressing 'n' then Enter with no text denies without a reason", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "write_file", summary: "src/a.ts", onChoose }),
    );
    await wait();
    stdin.write("n");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onChoose).toHaveBeenCalledWith({ kind: "deny" });
    unmount();
  });

  it("Escape in the reason input denies without the reason; backspace edits it", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "write_file", summary: "src/a.ts", onChoose }),
    );
    await wait();
    stdin.write("n");
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x7f"); // backspace → "ab"
    await wait();
    stdin.write("\x1b"); // Esc → deny, reason discarded
    await wait();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ kind: "deny" });
    unmount();
  });

  it("calls onChoose with deny when Enter is pressed in the main mode", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "write_file", summary: "src/a.ts", onChoose }),
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(onChoose).toHaveBeenCalledWith({ kind: "deny" });
    unmount();
  });

  it("calls onChoose with deny when Escape is pressed in the main mode", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "write_file", summary: "src/a.ts", onChoose }),
    );
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(onChoose).toHaveBeenCalledWith({ kind: "deny" });
    unmount();
  });

  it("Ctrl+C denies (user aborts the ask; the run continues as a denied tool)", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "write_file", summary: "src/a.ts", onChoose }),
    );
    await wait();
    stdin.write("\x03");
    await wait();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ kind: "deny" });
    unmount();
  });

  it("renders the M37 git-risk warning block above the menu when set (keys unchanged)", async () => {
    const onChoose = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(PermissionPrompt, {
        toolName: "shell",
        summary: "git reset --hard",
        warning: "⚠️ high-risk git command: git reset --hard\n   risk: discards ALL uncommitted changes",
        onChoose,
      }),
    );
    await wait();
    expect(lastFrame() ?? "").toContain("high-risk git command");
    expect(lastFrame() ?? "").toContain("[y/a/p/N]");
    stdin.write("y");
    await wait();
    expect(onChoose).toHaveBeenCalledWith({ kind: "allow" });
    unmount();
  });

  it("treats unknown keys (arrows, stray chars) as no-ops: a later 'y' still resolves allow", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "write_file", summary: "src/a.ts", onChoose }),
    );
    await wait();
    stdin.write("\x1b[A"); // up arrow — must NOT burn the single shot
    await wait();
    expect(onChoose).not.toHaveBeenCalled();
    stdin.write("x");
    await wait();
    expect(onChoose).not.toHaveBeenCalled();
    stdin.write("y");
    await wait();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ kind: "allow" });
    unmount();
  });

  it("0.3.14: 'p' resolves {kind:'always'} and uppercase P behaves the same; a settingsFile ask leaves p unbound", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "shell", summary: "pnpm test", onChoose }),
    );
    await wait();
    stdin.write("p");
    await wait();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ kind: "always" });
    unmount();
    const onChoose2 = vi.fn();
    const { stdin: stdin2, unmount: unmount2 } = render(
      React.createElement(PermissionPrompt, { toolName: "shell", summary: "pnpm test", onChoose: onChoose2 }),
    );
    await wait();
    stdin2.write("P");
    await wait();
    expect(onChoose2).toHaveBeenCalledWith({ kind: "always" });
    unmount2();
    // protected ask: `p` is a no-op, y/N only
    const onChoose3 = vi.fn();
    const { stdin: stdin3, unmount: unmount3 } = render(
      React.createElement(PermissionPrompt, {
        toolName: "write_file",
        summary: ".wudao/settings.json",
        settingsFile: ".wudao/settings.json",
        onChoose: onChoose3,
      }),
    );
    await wait();
    stdin3.write("p");
    await wait();
    expect(onChoose3).not.toHaveBeenCalled();
    stdin3.write("y");
    await wait();
    expect(onChoose3).toHaveBeenCalledWith({ kind: "allow" });
    unmount3();
  });

  it("ignores subsequent keys after the first choice (resolved guard)", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "write_file", summary: "src/a.ts", onChoose }),
    );
    await wait();
    stdin.write("y");
    await wait();
    stdin.write("n");
    await wait();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ kind: "allow" });
    unmount();
  });

  it("renders the menu hint [y/a/p/N] with tool name and summary", async () => {
    const onChoose = vi.fn();
    const { lastFrame, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "write_file", summary: "src/a.ts", onChoose }),
    );
    await wait();
    const frame = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("允许 write_file"); // ω99-158: 标题随源中文化
    expect(frame).toContain("src/a.ts");
    expect(frame).toContain("[y/a/p/N]");
    // ω99-158: 提示行中文化（n 拒绝，可输理由）。
    expect(frame).toContain("n 拒绝，可输理由");
    unmount();
  });

  it("renders without summary when summary is empty", async () => {
    const onChoose = vi.fn();
    const { lastFrame, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "read_file", summary: "", onChoose }),
    );
    await wait();
    const frame = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("允许 read_file"); // ω99-158: 标题随源中文化
    expect(frame).toContain("[y/a/p/N]");
    unmount();
  });

  it("uppercase Y and A behave like their lowercase forms; uppercase N opens the reason input", async () => {
    const onChoose1 = vi.fn();
    const r1 = render(React.createElement(PermissionPrompt, { toolName: "write_file", summary: "", onChoose: onChoose1 }));
    await wait();
    r1.stdin.write("Y");
    await wait();
    expect(lastChoice(onChoose1)).toEqual({ kind: "allow" });
    r1.unmount();

    const onChoose2 = vi.fn();
    const r2 = render(React.createElement(PermissionPrompt, { toolName: "write_file", summary: "", onChoose: onChoose2 }));
    await wait();
    r2.stdin.write("A");
    await wait();
    expect(lastChoice(onChoose2)).toEqual({ kind: "session" });
    r2.unmount();

    const onChoose3 = vi.fn();
    const r3 = render(React.createElement(PermissionPrompt, { toolName: "write_file", summary: "", onChoose: onChoose3 }));
    await wait();
    r3.stdin.write("N");
    await wait();
    r3.stdin.write("why");
    await wait();
    r3.stdin.write("\r");
    await wait();
    expect(lastChoice(onChoose3)).toEqual({ kind: "deny", reason: "why" });
    r3.unmount();
  });

  // -------------------------------------------------------------------------
  // Security fix: settings-file writes. A protected ask renders the plain
  // [y/N] menu (no `a`) and names the runtime-policy file.
  // -------------------------------------------------------------------------

  it("a protected settings ask renders [y/N], names the file, and drops the session hint", async () => {
    const onChoose = vi.fn();
    const { lastFrame, unmount } = render(
      React.createElement(PermissionPrompt, {
        toolName: "write_file",
        summary: ".wudao/settings.json",
        settingsFile: ".wudao/settings.json",
        onChoose,
      }),
    );
    await wait();
    const frame = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("[y/N]");
    expect(frame).not.toContain("[y/a/p/N]");
    expect(frame).toContain(".wudao/settings.json");
    expect(frame).toContain("策略文件"); // ω99-158: 变体随源中文化（原 runtime policy）
    unmount();
  });

  it("'a' is unavailable on a protected ask: the keypress is a no-op, a later 'y' still allows once", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, {
        toolName: "write_file",
        summary: ".wudao/settings.json",
        settingsFile: ".wudao/settings.json",
        onChoose,
      }),
    );
    await wait();
    stdin.write("a");
    await wait();
    stdin.write("A");
    await wait();
    expect(onChoose).not.toHaveBeenCalled();
    stdin.write("y");
    await wait();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ kind: "allow" });
    unmount();
  });

  it("'n' still opens the reason input on a protected ask", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PermissionPrompt, {
        toolName: "edit",
        summary: ".wudao/mcp.json",
        settingsFile: ".wudao/mcp.json",
        onChoose,
      }),
    );
    await wait();
    stdin.write("n");
    await wait();
    stdin.write("why");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onChoose).toHaveBeenCalledWith({ kind: "deny", reason: "why" });
    unmount();
  });
});
