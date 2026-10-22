// M35 §3 — named keybinding registry for the TUI. Every keyboard-sensitive
// branch consults this table (app.tsx's useInput for exit/abort, TextInput
// for submit/backspace/row movement); `.wudao/keybindings.json` overrides any
// action by name. Unknown action names warn and are ignored; two actions
// bound to the same key warn and BOTH stay bound — "first wins" is by check
// order (the registry's canonical order), and full conflict resolution is
// deliberately out of scope (v1: first-wins + warning).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveGlobalHome } from "../settings-layer.js";

/** A single-key binding: a named key or one character, optionally with ctrl
 *  or shift. */
export interface Binding {
  /** Named: return | escape | backspace | delete | left | right | up | down
   *  | tab | space — or a single character (for ctrl combos, e.g. "j"). */
  readonly key: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
}

export type ActionName = "app.submit" | "app.abort" | "app.exit" | "app.cycle-mode" | "input.backspace" | "input.up" | "input.down";

/** Canonical order = first-wins order for conflicts. */
export const KEYBINDING_ACTIONS: readonly ActionName[] = [
  "app.submit",
  "app.abort",
  "app.exit",
  "app.cycle-mode",
  "input.backspace",
  "input.up",
  "input.down",
];

export const DEFAULT_KEYBINDINGS: Readonly<Record<ActionName, string>> = {
  "app.submit": "return",
  "app.abort": "escape",
  "app.exit": "ctrl+c",
  "app.cycle-mode": "shift+tab",
  "input.backspace": "backspace",
  "input.up": "up",
  "input.down": "down",
};

const NAMED_KEYS: ReadonlySet<string> = new Set([
  "return", "enter", "esc", "escape", "backspace", "delete", "del",
  "left", "right", "up", "down", "tab", "space",
]);

export type ParsedBinding = { ok: true; binding: Binding } | { ok: false; error: string };

/** Parse a binding string: "escape", "return", "ctrl+c", "shift+tab", "j", "space". */
export function parseBinding(text: string): ParsedBinding {
  const value = text.trim().toLowerCase();
  if (value === "") return { ok: false, error: `empty binding` };
  const ctrlMatch = /^ctrl\+(.+)$/.exec(value);
  if (ctrlMatch !== null) {
    const key = ctrlMatch[1]!.trim();
    if (key.length !== 1) return { ok: false, error: `"${text}": ctrl bindings take one character (e.g. ctrl+j)` };
    return { ok: true, binding: { key, ctrl: true } };
  }
  const shiftMatch = /^shift\+(.+)$/.exec(value);
  if (shiftMatch !== null) {
    const key = shiftMatch[1]!.trim();
    if (NAMED_KEYS.has(key)) {
      if (key === "enter") return { ok: true, binding: { key: "return", shift: true } };
      if (key === "esc") return { ok: true, binding: { key: "escape", shift: true } };
      if (key === "del") return { ok: true, binding: { key: "delete", shift: true } };
      return { ok: true, binding: { key, shift: true } };
    }
    if (key.length === 1) return { ok: true, binding: { key, shift: true } };
    return { ok: false, error: `"${text}": shift bindings take a named key or one character (e.g. shift+tab)` };
  }
  if (!NAMED_KEYS.has(value)) {
    return { ok: false, error: `"${text}": unknown key (named: ${[...NAMED_KEYS].join(" | ")}, or ctrl/shift+<key>)` };
  }
  // Normalize the two aliases to their canonical spellings.
  const key = value === "enter" ? "return" : value === "esc" ? "escape" : value === "del" ? "delete" : value;
  return { ok: true, binding: { key } };
}

/** ink's key booleans (the subset the TUI consumes). */
export interface InkKeyLike {
  readonly input?: string;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly tab?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
}

/** The reverse-tab (backtab) sequence — what shift+tab sends. */
export const SHIFT_TAB_SEQUENCE = "\x1b[Z";

/** M58 §C#6: the double-Esc window — two presses of the app.abort key within
 *  this many milliseconds while IDLE run the /rewind last path. Busy-state
 *  Esc keeps its single-press interrupt semantics (the detector is never
 *  armed while busy). */
export const DOUBLE_ESC_WINDOW_MS = 400;

export function bindingMatches(binding: Binding, input: string, key: InkKeyLike): boolean {
  if (binding.ctrl === true) {
    return key.ctrl === true && input.toLowerCase() === binding.key;
  }
  // Shift discrimination: a shifted keypress is a DIFFERENT key (shift+tab
  // must not fire a plain "tab" binding). The raw-sequence check catches
  // frontends that deliver \x1b[Z through `input` without ink's booleans.
  const shifted = key.shift === true || input === SHIFT_TAB_SEQUENCE;
  if ((binding.shift === true) !== shifted) return false;
  switch (binding.key) {
    case "return": return key.return === true;
    case "escape": return key.escape === true;
    case "backspace": return key.backspace === true;
    case "delete": return key.delete === true;
    case "left": return key.leftArrow === true;
    case "right": return key.rightArrow === true;
    case "up": return key.upArrow === true;
    case "down": return key.downArrow === true;
    case "tab": return key.tab === true || input === SHIFT_TAB_SEQUENCE;
    case "space": return input === " ";
    default: return key.ctrl !== true && input === binding.key;
  }
}

/** True when the binding is the plain (unmodified) key. */
export function bindingIsPlainReturn(binding: Binding): boolean {
  return binding.ctrl !== true && binding.key === "return";
}

export type KeybindingOverrides = Readonly<Record<string, string>>;

/** A fully resolved registry — what the components consult. */
export type ResolvedKeybindings = Readonly<Record<ActionName, Binding>>;

function bindingKey(b: Binding): string {
  return `${b.ctrl === true ? "ctrl+" : ""}${b.shift === true ? "shift+" : ""}${b.key}`;
}

/** Resolve defaults + overrides. Unknown action names and unparsable bindings
 *  warn and fall back to the default. Duplicate bindings (two actions on one
 *  key) warn and REMAIN — first match wins at check time (canonical order). */
export function resolveKeybindings(
  overrides: KeybindingOverrides = {},
  onWarning?: (text: string) => void,
): ResolvedKeybindings {
  const known = new Set<string>(KEYBINDING_ACTIONS);
  const resolved = {} as Record<ActionName, Binding>;
  for (const name of KEYBINDING_ACTIONS) {
    const raw = overrides[name];
    const fallback = parseBinding(DEFAULT_KEYBINDINGS[name]);
    if (fallback.ok) resolved[name] = fallback.binding;
    if (raw === undefined) continue;
    const parsed = parseBinding(raw);
    if (!parsed.ok) {
      onWarning?.(`keybindings: ${name}: ${parsed.error} — keeping the default "${DEFAULT_KEYBINDINGS[name]}"`);
      continue;
    }
    // Safety: an unmodified single character on a destructive/global app
    // action (abort/exit/cycle-mode) would hijack plain TYPING — every
    // keystroke reaches the app-level handler too. Require ctrl, shift, or a
    // named key for these.
    if (
      (name === "app.abort" || name === "app.exit" || name === "app.cycle-mode") &&
      parsed.ok && parsed.binding.ctrl !== true && parsed.binding.shift !== true && parsed.binding.key.length === 1
    ) {
      onWarning?.(`keybindings: ${name}: refusing unmodified single-char "${raw}" — it would fire while typing; use ctrl+<key>`);
      continue;
    }
    resolved[name] = parsed.binding;
  }
  for (const name of Object.keys(overrides)) {
    if (!known.has(name)) onWarning?.(`keybindings: unknown action "${name}" (known: ${KEYBINDING_ACTIONS.join(", ")})`);
  }
  // Conflict detection: first-wins by canonical order (both stay bound; the
  // earlier check consumes the key).
  const byKey = new Map<string, ActionName>();
  for (const name of KEYBINDING_ACTIONS) {
    const bk = bindingKey(resolved[name]);
    const first = byKey.get(bk);
    if (first !== undefined) {
      onWarning?.(`keybindings: "${name}" and "${first}" share the key "${bk}" — first match wins`);
    } else {
      byKey.set(bk, name);
    }
  }
  return resolved;
}

export const KEYBINDINGS_FILE = "keybindings.json";

/** Defaults, pre-resolved — used when no workspace override file exists. */
export const DEFAULT_RESOLVED_KEYBINDINGS: ResolvedKeybindings = resolveKeybindings();

/** Load keybindings from BOTH tiers and resolve: the GLOBAL file
 *  (`~/.wudao/keybindings.json`, M57) applies first, then the PROJECT file
 *  (`.wudao/keybindings.json`) OVERRIDES PER KEY (same action name → the
 *  project key wins). A missing tier = skip it; a malformed file warns and
 *  degrades to defaults (never a broken TUI). */
export async function loadKeybindings(
  workspaceRoot: string,
  onWarning?: (text: string) => void,
): Promise<ResolvedKeybindings> {
  const overrides: Record<string, string> = {};
  // M57 §1: global tier first — per-key override by the project tier below.
  const globalPath = join(resolveGlobalHome(), KEYBINDINGS_FILE);
  const projectPath = join(workspaceRoot, ".wudao", KEYBINDINGS_FILE);
  for (const [path, label] of [
    [globalPath, `global ${KEYBINDINGS_FILE}`],
    [projectPath, KEYBINDINGS_FILE],
  ] as const) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue; // tier absent — skip silently
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      onWarning?.(`keybindings: ${label} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — ignored`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      onWarning?.(`keybindings: ${label} must be an object of { "action": "key" } — ignored`);
      continue;
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") {
        onWarning?.(`keybindings: ${label}: "${k}" must be a string (got ${Array.isArray(v) ? "array" : typeof v}) — ignored`);
        continue;
      }
      overrides[k] = v; // later tier (project) wins per key
    }
  }
  return Object.keys(overrides).length === 0
    ? DEFAULT_RESOLVED_KEYBINDINGS
    : resolveKeybindings(overrides, onWarning);
}
