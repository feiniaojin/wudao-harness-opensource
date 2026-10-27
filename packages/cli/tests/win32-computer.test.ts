// win32 computer-use layer — pure builders/parsers unit receipts + REAL
// PowerShell spawns (win32-only suite; other platforms skip everything).
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWinCaptureScript,
  buildWinTypeScript,
  buildWinClickScript,
  buildWinKeyScript,
  buildWinScrollScript,
  buildWinDragScript,
  buildWinActivateScript,
  buildWinListAppsScript,
  buildWinStatusScript,
  parseWinCaptureSize,
  parseWinAppList,
  parseWinStatus,
  parseWinKeyCombo,
  sendkeysEscape,
  psArgs,
  PS_BIN,
  PS_PREAMBLE,
} from "../src/computer/win32.js";
import { defaultExecSeam } from "../src/computer/exec.js";
import type { ExecSeam } from "../src/computer/exec.js";

const isWin = process.platform === "win32";

describe("win32 computer — pure builders/parsers", () => {
  it("sendkeysEscape braces the special set; braces double; newlines become keys", () => {
    expect(sendkeysEscape("a+b")).toBe("a{+}b");
    expect(sendkeysEscape("(x) ~ % ^")).toBe("{(}x{)} {~} {%} {^}");
    expect(sendkeysEscape("{ok} [1]")).toBe("{{}ok{}} {[}1{]}");
    expect(sendkeysEscape("a\nb\tc")).toBe("a{ENTER}b{TAB}c");
    expect(sendkeysEscape("中文你好")).toBe("中文你好"); // Unicode rides raw
  });

  it("parseWinKeyCombo: combos split, vocabulary enforced, lone mods refused", () => {
    expect(parseWinKeyCombo("cmd+c")).toEqual({ ok: true, combo: { mods: ["cmd"], key: "c" } });
    expect(parseWinKeyCombo("shift+cmd+t")).toEqual({ ok: true, combo: { mods: ["shift", "cmd"], key: "t" } });
    expect(parseWinKeyCombo("return")).toEqual({ ok: true, combo: { mods: [], key: "return" } });
    expect(parseWinKeyCombo("ctrl+alt+f4")).toEqual({ ok: true, combo: { mods: ["ctrl", "alt"], key: "f4" } });
    expect(parseWinKeyCombo("cmd")).toEqual({ ok: true, combo: { mods: [], key: "cmd" } }); // 单按 Win=开始菜单（打开启动路径）
    expect(parseWinKeyCombo("cmd+pause").ok).toBe(false); // unknown key
    expect(parseWinKeyCombo("a+cmd").ok).toBe(false); // non-mod in modifier slot
    expect(parseWinKeyCombo("").ok).toBe(false);
  });

  it("buildWinKeyScript holds mods, taps, releases in reverse", () => {
    const script = buildWinKeyScript({ mods: ["shift", "cmd"], key: "t" });
    expect(script).toContain("Hold(16)");   // shift
    expect(script).toContain("Hold(91)");   // cmd → LWin
    expect(script).toContain("Tap(84)");    // T
    expect(script.indexOf("Hold(91)")).toBeLessThan(script.indexOf("Tap(84)"));
    expect(script.trim().endsWith("Release(16)")).toBe(true); // reverse order, shift last
  });

  it("parseWinCaptureSize: P/F pair required; garbage/gaps refused", () => {
    expect(parseWinCaptureSize("P 2560 1440\nF 1280 720")).toEqual({ physW: 2560, physH: 1440, outW: 1280, outH: 720 });
    expect(parseWinCaptureSize("P 2560 1440")).toBeUndefined();
    expect(parseWinCaptureSize("F 1280 720")).toBeUndefined();
    expect(parseWinCaptureSize("P 0 1440\nF 1 1")).toBeUndefined(); // zero dims refused
    expect(parseWinCaptureSize("")).toBeUndefined();
  });

  it("parseWinAppList strips blanks and P/F noise lines", () => {
    expect(parseWinAppList("explorer\r\nchrome\n\nP 1 1\r\nF 2 2")).toEqual(["explorer", "chrome"]);
    expect(parseWinAppList("")).toEqual([]);
  });

  it("parseWinStatus requires both APP and WIN lines; title may be empty", () => {
    expect(parseWinStatus("APP explorer\nWIN 桌面")).toEqual({ app: "explorer", title: "桌面" });
    expect(parseWinStatus("APP explorer\nWIN ")).toEqual({ app: "explorer", title: "" });
    expect(parseWinStatus("APP explorer")).toBeUndefined();
  });

  it("psArgs carries the script as ONE argv element (no shell)", () => {
    const args = psArgs("Write-Output 'x'");
    expect(args[0]).toBe("-NoProfile");
    expect(args.at(-1)).toBe("Write-Output 'x'");
  });

  it("buildWinScrollScript inverts dy (win32 wheel: negative = down)", () => {
    expect(buildWinScrollScript(3)).toContain("Wheel(-3)");
    expect(buildWinScrollScript(-2)).toContain("Wheel(2)");
  });
});

// ---------------------------------------------------------------------------
// REAL spawns — this machine's actual PowerShell + user32. win32-only.
// ---------------------------------------------------------------------------
describe.skipIf(!isWin)("win32 computer — real PowerShell lanes", () => {
  const exec: ExecSeam = defaultExecSeam();

  it("status: returns the frontmost app + window title", async () => {
    const r = await exec(PS_BIN, psArgs(PS_PREAMBLE + buildWinStatusScript()));
    expect(r.code).toBe(0);
    const parsed = parseWinStatus(r.stdout);
    expect(parsed).toBeDefined();
    expect(parsed!.app.length).toBeGreaterThan(0);
  }, 30_000);

  it("app_list: names arrive one per line, non-empty", async () => {
    const r = await exec(PS_BIN, psArgs(PS_PREAMBLE + buildWinListAppsScript(80)));
    expect(r.code).toBe(0);
    const names = parseWinAppList(r.stdout);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length); // unique
  }, 30_000);

  it("capture: writes a real PNG with P/F size lines (and resizes when over-edge)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "win32-capture-"));
    try {
      const path = join(dir, "shot.png");
      const maxEdge = 640; // force the resize lane on any modern display
      const r = await exec(PS_BIN, psArgs(PS_PREAMBLE + buildWinCaptureScript(path, maxEdge)));
      expect(r.code).toBe(0);
      const size = parseWinCaptureSize(r.stdout);
      expect(size).toBeDefined();
      expect(size!.physW).toBeGreaterThanOrEqual(size!.outW); // resize only shrinks
      expect(Math.max(size!.outW, size!.outH)).toBeLessThanOrEqual(maxEdge);
      const info = statSync(path);
      expect(info.isFile()).toBe(true);
      expect(info.size).toBeGreaterThan(1000);
      const magic = readFileSync(path).subarray(0, 4);
      expect(Array.from(magic)).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG signature
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);

  it("activate: an unknown app exits 3 (typed not-found lane)", async () => {
    const r = await exec(PS_BIN, psArgs(PS_PREAMBLE + buildWinActivateScript("definitely-not-a-real-app-xyz")));
    expect(r.code).toBe(3);
  }, 30_000);

  it("key: a harmless tap (F24-key absent — use ScrollLock-free: tap 'p' into nothing) runs exit 0", async () => {
    // Pressing a plain letter key with no target is harmless; verify exit only.
    const parsed = parseWinKeyCombo("p");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = await exec(PS_BIN, psArgs(PS_PREAMBLE + buildWinKeyScript(parsed.combo)));
    expect(r.code).toBe(0);
  }, 30_000);

  it("type: SendKeys round-trips through the escape lane (exit 0)", async () => {
    const r = await exec(PS_BIN, psArgs(PS_PREAMBLE + buildWinTypeScript(["(x+y)*2 = {ok}"])));
    expect(r.code).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Face wiring — platform:"win32" dispatch through createComputerTools with
// a recording fake seam (no real spawns; the real lanes above covered those).
// ---------------------------------------------------------------------------
describe("win32 computer — face wiring (fake seam, all platforms)", () => {
  it("computer_type routes to powershell and reports the typed count; ref is refused", async () => {
    const { createComputerTools } = await import("../src/computer/tools.js");
    const calls: { file: string; args: readonly string[] }[] = [];
    const exec = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { stdout: "APP probe\nWIN probe", stderr: "", code: 0 };
    };
    const tools = createComputerTools({ exec, platform: "win32" });
    const type = tools.find((t) => t.name === "computer_type")!;
    const r = await type.execute({ text: "hello" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已在焦点处输入 5 个字符");
    expect(r.content).toContain("当前状态：probe 「probe」");
    expect(calls[0]!.file).toBe("powershell");
    expect(calls[0]!.args[0]).toBe("-NoProfile");
    const refR = await type.execute({ text: "x", ref: "e1" });
    expect(refR.isError).toBe(true);
    expect(refR.content).toContain("Windows 上不可用");
  });

  it("screen_observe / computer_wait refuse with the screen_capture pointer on win32", async () => {
    const { createComputerTools } = await import("../src/computer/tools.js");
    const tools = createComputerTools({ exec: async () => ({ stdout: "", stderr: "", code: 0 }), platform: "win32" });
    const observe = tools.find((t) => t.name === "screen_observe")!;
    const wait = tools.find((t) => t.name === "computer_wait")!;
    const o = await observe.execute({});
    expect(o.isError).toBe(true);
    expect(o.content).toContain("screen_capture");
    const w = await wait.execute({ stable: true });
    expect(w.isError).toBe(true);
    expect(w.content).toContain("screen_capture");
  });

  it("computer_click validates coords and applies the capture-scale basis", async () => {
    const { createComputerTools } = await import("../src/computer/tools.js");
    const calls: { file: string; args: readonly string[] }[] = [];
    const exec = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { stdout: "APP p\nWIN w", stderr: "", code: 0 };
    };
    const tools = createComputerTools({ exec, platform: "win32" });
    const click = tools.find((t) => t.name === "computer_click")!;
    const bad = await click.execute({ x: -1, y: 0 });
    expect(bad.isError).toBe(true);
    // 无基准 → 直通坐标
    const r = await click.execute({ x: 100, y: 50, double: true });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已在 (100, 50) 双击点击。");
    const script = calls[0]!.args.at(-1)!; // 点击脚本先于状态行后缀
    expect(script).toContain("Move(100, 50)");
    expect(script).toContain("LDown()");
  });
});
