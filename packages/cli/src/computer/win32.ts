// win32.ts — the Windows execution layer for the computer octet (0.3.81).
// The SAME seam discipline as exec.ts (the macOS layer): pure script
// builders + output parsers here; production rides the shared ExecSeam as
// `powershell -NoProfile -Command <script>` (one argv element — execFile
// never touches a shell). The heavy lifting is one embedded C# helper
// (Add-Type, machine-compiled per powershell process):
//
//   - a static ctor calls SetProcessDPIAware() FIRST — both the capture and
//     the input side run in DPI-aware processes, so screen pixels are TRUE
//     physical pixels and capture-coordinates == SendInput-coordinates at
//     any display scale (a DPI-unaware pair would be self-consistent but
//     blurry; a MIXED pair would mis-click at 125%/150%);
//   - keybd_event/mouse_event wrappers (legacy-simple, reliable) for
//     tap/hold/move/click/wheel;
//   - GetForegroundWindow + GetWindowText + SetForegroundWindow for the
//     status line and app activation.
//
// Windows has no accessibility-tree equivalent wired here (UIAutomation is
// a deliberate v2) — the ref/observe/settle/landing layers stay macOS-only;
// every win32 action receipt therefore carries the honest two-tuple status
// line (frontmost app · window title) instead of the AX triple.
import type { ExecSeam, ExecResult } from "./exec.js";
import { sanitizeTypingText, chunkTypingText, TYPE_CHUNK_DELAY } from "./exec.js";

export interface ExecResultLike {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/** PowerShell invocation argv for the shared ExecSeam (file + args). */
export const PS_BIN = "powershell";
export const psArgs = (script: string): readonly string[] => [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
];

/** PS single-quoted literal escaping: ' → ''（here-string/引号内均按此律）。 */
export function psQuote(s: string): string {
  return s.split("'").join("''");
}

// ---------------------------------------------------------------------------
// The C# input helper — one blob, no single quotes (single-quoted here-string).
// ---------------------------------------------------------------------------

export const WIN_INPUT_CS = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WInput {
  static WInput() { SetProcessDPIAware(); }
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void LDown() { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); }
  public static void LUp() { mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
  public static void RDown() { mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero); }
  public static void RUp() { mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero); }
  public static void Wheel(int d) { mouse_event(0x0800, 0, 0, (uint)d, UIntPtr.Zero); }
  public static void Tap(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
  public static void Hold(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void Release(byte vk) { keybd_event(vk, 0, 2, UIntPtr.Zero); }
  public static uint FrontPid() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
  public static string FrontTitle() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "";
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString();
  }
  public static bool Foreground(IntPtr h) { return SetForegroundWindow(h); }
}
`;

/** The standard preamble every action script starts with (UTF-8 stdout so
 *  the status line survives the console codepage). Exported for tests —
 *  production wiring (tools.ts runWinPs) prepends it to every body. */
export const PS_PREAMBLE = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${WIN_INPUT_CS}
'@
`;

/** Run one PowerShell script through the seam. */
const runPs = async (exec: ExecSeam, script: string): Promise<ExecResult> =>
  exec(PS_BIN, psArgs(`${PS_PREAMBLE}${script}`));

// ---------------------------------------------------------------------------
// SendKeys escaping (typing path) — pure.
// ---------------------------------------------------------------------------

/** SendKeys special characters must be braced; braces themselves double.
 *  \n/\r/\t use their named keys（换行/Tab 本就该走 computer_key，这里兜底）。 */
export function sendkeysEscape(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") out += "{ENTER}";
    else if (ch === "\t") out += "{TAB}";
    else if (ch === "{") out += "{{}";
    else if (ch === "}") out += "{}}";
    else if ("+^%~()[]".includes(ch)) out += `{${ch}}`;
    else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Virtual-key mapping (computer_key) — pure.
// ---------------------------------------------------------------------------

/** Named-key → Windows virtual-key code. cmd maps to the left Windows key. */
export const WIN_VK: Readonly<Record<string, number>> = {
  return: 0x0d, enter: 0x0d, tab: 0x09, space: 0x20, escape: 0x1b, esc: 0x1b,
  delete: 0x2e, forwarddelete: 0x2e, backspace: 0x08,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  cmd: 0x5b, win: 0x5b, command: 0x5b,
  ctrl: 0x11, control: 0x11, alt: 0x12, option: 0x12, shift: 0x10, capslock: 0x14,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  f13: 0x7c, f14: 0x7d, f15: 0x7e, f16: 0x7f, f17: 0x80, f18: 0x81,
  f19: 0x82, f20: 0x83,
};
const WIN_MODS = new Set(["cmd", "win", "command", "ctrl", "control", "alt", "option", "shift"]);

/** A parsed key spec: modifier names (held around the tap) + the tapped key. */
export interface WinKeyCombo {
  readonly mods: readonly string[];
  readonly key: string;
}

/** Parse "shift+cmd+t" → {mods:["shift","cmd"], key:"t"}; mac's vocabulary
 *  (letters a-z, digits 0-9, the named set above) — anything else refuses. */
export function parseWinKeyCombo(spec: unknown): { readonly ok: true; readonly combo: WinKeyCombo } | { readonly ok: false; readonly error: string } {
  if (typeof spec !== "string" || spec.trim() === "") {
    return { ok: false, error: `"key" must be a non-empty string like "return" or "cmd+c"` };
  }
  const parts = spec.toLowerCase().split("+").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return { ok: false, error: `"key" 为空` };
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  const known = (p: string): boolean =>
    WIN_MODS.has(p) || /^[a-z0-9]$/.test(p) || (WIN_VK[p] !== undefined && !WIN_MODS.has(p));
  if (!known(key)) {
    return { ok: false, error: `未知键 "${key}"（白名单：字母、数字、return/tab/space/delete/escape/方向键/home/end/pageup/pagedown/f1-f20；修饰键 cmd/win、ctrl、alt、shift——可组合，也可单独按：单独按 cmd/win=打开开始菜单）` };
  }
  for (const m of mods) {
    if (!WIN_MODS.has(m)) return { ok: false, error: `"${m}" 不是修饰键（可用 cmd/win、ctrl、alt、shift）` };
  }
  return { ok: true, combo: { mods, key } };
}

/** VK for one parsed token (letters/digits computed from char codes). */
function vkOf(name: string): number {
  if (WIN_VK[name] !== undefined) return WIN_VK[name]!;
  if (/^[a-z]$/.test(name)) return 0x41 + (name.charCodeAt(0) - 0x61);
  if (/^[0-9]$/.test(name)) return 0x30 + Number(name);
  return 0;
}

/** Build the key-combo script: hold mods (in order), tap key, release mods
 *  (reverse order). Plain single keys tap directly. */
export function buildWinKeyScript(combo: WinKeyCombo): string {
  const lines: string[] = [];
  for (const m of combo.mods) lines.push(`[WInput]::Hold(${vkOf(m)})`);
  lines.push(`[WInput]::Tap(${vkOf(combo.key)})`);
  for (const m of [...combo.mods].reverse()) lines.push(`[WInput]::Release(${vkOf(m)})`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Output parsers — pure.
// ---------------------------------------------------------------------------

/** The capture script emits `P <w> <h>` (physical) and `F <w> <h>` (final,
 *  post-resize) lines; anything else → undefined (fail-closed: no size,
 *  no coordinate basis, no image to the model). */
export function parseWinCaptureSize(stdout: string): { readonly physW: number; readonly physH: number; readonly outW: number; readonly outH: number } | undefined {
  const p = /^P (\d+) (\d+)$/m.exec(stdout);
  const f = /^F (\d+) (\d+)$/m.exec(stdout);
  if (p === null || f === null) return undefined;
  const [pw, ph, fw, fh] = [Number(p[1]), Number(p[2]), Number(f[1]), Number(f[2])];
  if (![pw, ph, fw, fh].every((n) => Number.isInteger(n) && n > 0)) return undefined;
  return { physW: pw, physH: ph, outW: fw, outH: fh };
}

/** app_list output: one process name per line（空行剔除，保序，封顶在脚本侧）。 */
export function parseWinAppList(stdout: string): readonly string[] {
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("P ") && !l.startsWith("F "));
}

/** The status script emits `APP <proc>` + `WIN <title>`; both required. */
export function parseWinStatus(stdout: string): { readonly app: string; readonly title: string } | undefined {
  const a = /^APP (.+)$/m.exec(stdout);
  const w = /^WIN (.*)$/m.exec(stdout);
  if (a === null || w === null) return undefined;
  return { app: a[1]!.trim(), title: w[1]!.trim() };
}

/** The win32 status line（mac 三元组的两元同形：前台 · 窗口）。 */
export function formatWinStatusLine(status: { app: string; title: string }): string {
  const title = status.title === "" ? "（无标题窗口）" : `「${status.title}」`;
  return `当前状态：${status.app} ${title}`;
}

// ---------------------------------------------------------------------------
// Script builders — pure.
// ---------------------------------------------------------------------------

/** Capture: primary screen → PNG at `path`; resize when the long edge
 *  exceeds maxEdge (DrawImage, high quality); emits P (physical) + F (final). */
export function buildWinCaptureScript(path: string, maxEdge: number): string {
  return `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$g.Dispose()
$out = $bmp
if ($b.Width -gt $b.Height -and $b.Width -gt ${maxEdge}) {
  $nw = ${maxEdge}; $nh = [int]($b.Height * ${maxEdge} / $b.Width)
  $out = New-Object System.Drawing.Bitmap $nw, $nh
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $nw, $nh)
  $g2.Dispose(); $bmp.Dispose()
} elseif ($b.Height -ge $b.Width -and $b.Height -gt ${maxEdge}) {
  $nh = ${maxEdge}; $nw = [int]($b.Width * ${maxEdge} / $b.Height)
  $out = New-Object System.Drawing.Bitmap $nw, $nh
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $nw, $nh)
  $g2.Dispose(); $bmp.Dispose()
}
$out.Save('${psQuote(path)}', [System.Drawing.Imaging.ImageFormat]::Png)
"P $($b.Width) $($b.Height)"
"F $($out.Width) $($out.Height)"
$out.Dispose()
`.trim();
}

/** Typing: SendKeys per chunk with the mac chunk rhythm (120ms between). */
export function buildWinTypeScript(chunks: readonly string[], chunkDelaySec = TYPE_CHUNK_DELAY): string {
  const parts = chunks.map((c) => {
    const s = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${psQuote(sendkeysEscape(c))}')`;
    return s;
  });
  return parts.join(`\nStart-Sleep -Seconds ${chunkDelaySec}\n`);
}

/** Click: move, down/up; double taps twice; right uses the right button. */
export function buildWinClickScript(x: number, y: number, button: "left" | "right", double: boolean): string {
  const down = button === "right" ? "[WInput]::RDown()" : "[WInput]::LDown()";
  const up = button === "right" ? "[WInput]::RUp()" : "[WInput]::LUp()";
  const tap = `${down}
Start-Sleep -Milliseconds 30
${up}`;
  return `[WInput]::Move(${x}, ${y})
Start-Sleep -Milliseconds 40
${double ? `${tap}\nStart-Sleep -Milliseconds 60\n${tap}` : tap}`.trim();
}

/** Scroll: vertical wheel only (Windows has no horizontal wheel event via
 *  mouse_event; dx is honestly reported as ignored by the caller). dy > 0
 *  scrolls DOWN (mac parity), which is a NEGATIVE native wheel delta. */
export function buildWinScrollScript(dy: number): string {
  return `[WInput]::Wheel(${-dy})`;
}

/** Drag: move → press → small interpolated steps → release. */
export function buildWinDragScript(x1: number, y1: number, x2: number, y2: number, button: "left" | "right"): string {
  const down = button === "right" ? "[WInput]::RDown()" : "[WInput]::LDown()";
  const up = button === "right" ? "[WInput]::RUp()" : "[WInput]::LUp()";
  const lines: string[] = [`[WInput]::Move(${x1}, ${y1})`, "Start-Sleep -Milliseconds 60", down, "Start-Sleep -Milliseconds 80"];
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    const ix = Math.round(x1 + ((x2 - x1) * i) / steps);
    const iy = Math.round(y1 + ((y2 - y1) * i) / steps);
    lines.push(`[WInput]::Move(${ix}, ${iy})`, "Start-Sleep -Milliseconds 25");
  }
  lines.push(up);
  return lines.join("\n");
}

/** Activate: fuzzy process-name match with a main window → foreground it.
 *  exit 3 = no such app (typed by the caller). */
export function buildWinActivateScript(app: string): string {
  return `$name = '${psQuote(app)}'
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like ('*' + $name + '*') } | Select-Object -First 1
if ($null -eq $p) { exit 3 }
[WInput]::Foreground($p.MainWindowHandle) | Out-Null`;
}

/** List: processes owning a main window, unique + sorted, capped. */
export function buildWinListAppsScript(cap: number): string {
  return `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique | Select-Object -First ${cap}`;
}

/** Status: frontmost process name + window title. */
export function buildWinStatusScript(): string {
  return `$pid2 = [WInput]::FrontPid()
if ($pid2 -eq 0) { exit 4 }
$p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
if ($null -eq $p) { exit 4 }
"APP " + $p.ProcessName
"WIN " + [WInput]::FrontTitle()`;
}
