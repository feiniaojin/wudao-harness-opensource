// Ink multi-line text input built on the pure key state machine in input.ts.
// The component owns React state + rendering; every key decision goes through
// handleKey so behavior stays unit-testable without Ink.
// M35 §3: the submit/backspace/up/down decisions consult the keybinding
// registry (defaults are byte-identical to the old hard-coded keys). When
// app.submit moves OFF the Enter key, Enter is demoted to a plain newline —
// the only non-confusing meaning for the orphaned default key.
// M42 §2: with `suggestions` wired, a line still inside its slash-command
// word opens the suggestion menu above the input — ↑↓ select, Tab/Enter
// complete WITHOUT submitting (Enter only submits once the typed word IS the
// selected command, i.e. a complete no-argument command), Esc closes without
// losing the typed text.
// M44 §1: the caret renders before `lines[row][col]` — ←/→/Home/End move the
// col, and every edit is cursor-relative (see input-state.ts).
// M44 §2: ↑/↓ recall submitted prompts at the buffer's first/last row (see
// input-state.ts for the pure pointer machine); the menu above keeps them.
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  createInputState,
  createInputHistory,
  handleKey,
  inputStateFromText,
  isSubmit,
  recallNewer,
  recallOlder,
  recalledText,
  submitToHistory,
  type InputHistory,
  type InputState,
  type KeyInfo,
} from "./input-state.js";
import { bindingIsPlainReturn, bindingMatches, DEFAULT_RESOLVED_KEYBINDINGS } from "./keybindings.js";
import type { ResolvedKeybindings } from "./keybindings.js";
import { PROMPT, T } from "./theme.js";
import { SlashSuggest } from "./suggest.js";
import { completeSlashLine, filterSlashCommands, slashToken } from "../slash-commands.js";
import type { SlashCommandInfo } from "../slash-commands.js";

/** The menu's UI state. `token` keys `selected` to the token it was moved
 *  under (typing a new word resets the selection to the top without a state
 *  write); `dismissed` holds the token Esc closed on — the menu stays closed
 *  for that exact token and reopens as soon as the word changes. */
interface SuggestUi {
  readonly token: string | null;
  readonly selected: number;
  readonly dismissed: string | null;
}

const SUGGEST_CLOSED: SuggestUi = { token: null, selected: 0, dismissed: null };

export function TextInput({ onSubmit, disabled, keybindings, suggestions, history, onHistoryChange, draft, menuOpenRef }: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  /** M35 §3: resolved registry (defaults when absent). */
  keybindings?: ResolvedKeybindings;
  /** M42 §2: the slash-command registry driving the suggestion menu;
   *  absent = no menu (the bare-input use). */
  suggestions?: readonly SlashCommandInfo[];
  /** M44 §2: submitted-prompt history. Controlled pair — when both are given
   *  the history lives in the caller (app.tsx keeps it across this input's
   *  unmounts: the input hides while a permission ask / ask_user / clear
   *  confirm owns the screen); with neither, the component owns it. */
  history?: InputHistory;
  onHistoryChange?: (h: InputHistory) => void;
  /** M53 §1: an external buffer replacement (/edit puts a prior message back
   *  in the input). `nonce` keys the effect — arming the same message twice
   *  still replaces (each arm bumps the nonce); the input's own edits never
   *  touch it. The caret lands at the end. */
  draft?: { readonly text: string; readonly nonce: number };
  /** M58 §C#6 review fix: the caller's mirror of "the suggestion menu is
   *  open", synced after every commit. Ink delivers every keypress to ALL
   *  active useInput hooks, so an Esc that this component's menu consumes
   *  (dismiss) ALSO reaches the App-level double-Esc detector — the App
   *  reads this ref to recognize that the press belonged to the menu and
   *  decline to arm on it. Read-during-keypress sees the LAST committed
   *  value, i.e. the pre-press state, which is exactly the needed answer. */
  menuOpenRef?: { current: boolean };
}): React.JSX.Element {
  const [state, setState] = useState<InputState>(createInputState);
  const [suggest, setSuggest] = useState<SuggestUi>(SUGGEST_CLOSED);
  const [localHistory, setLocalHistory] = useState<InputHistory>(createInputHistory);
  const historyState = history ?? localHistory;
  const setHistoryState = (next: InputHistory): void => {
    if (history !== undefined) onHistoryChange?.(next);
    else setLocalHistory(next);
  };
  const kb = keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;

  // M53 §1: an armed /edit replaces the whole buffer (caret at the end, menu
  // reset). Keyed by nonce so the app can re-arm the same text.
  useEffect(() => {
    if (draft === undefined) return;
    setState(inputStateFromText(draft.text));
    setSuggest(SUGGEST_CLOSED);
  }, [draft?.nonce, draft?.text]);

  // Menu derivation (render + key handler share this shape): the active
  // line's slash token, the prefix-filtered matches, and the selection
  // clamped into those matches (0 once the token changed since the last move).
  const deriveMenu = (lines: readonly string[], row: number): {
    token: string | undefined;
    matches: readonly SlashCommandInfo[];
    selected: number;
  } => {
    if (suggestions === undefined || suggestions.length === 0) return { token: undefined, matches: [], selected: 0 };
    const token = slashToken(lines[row] ?? "");
    if (token === undefined) return { token: undefined, matches: [], selected: 0 };
    const matches = filterSlashCommands(suggestions, token);
    const selected = suggest.token === token ? Math.min(suggest.selected, Math.max(0, matches.length - 1)) : 0;
    return { token, matches, selected };
  };

  const menu = deriveMenu(state.lines, state.row);
  const menuOpen = menu.token !== undefined && menu.matches.length > 0 && suggest.dismissed !== menu.token;

  // M58 §C#6 review fix: mirror the committed menu state for the App's
  // double-Esc detector (see the prop's doc for why this is a ref, not a
  // callback: keypress handlers read the post-commit value).
  useEffect(() => {
    if (menuOpenRef !== undefined) menuOpenRef.current = menuOpen;
  }, [menuOpen, menuOpenRef]);

  useInput(
    (input, key) => {
      if (disabled) return;
      const { token, matches, selected } = deriveMenu(state.lines, state.row);
      const open = token !== undefined && matches.length > 0 && suggest.dismissed !== token;
      const plainTab = key.tab === true && key.shift !== true;

      // --- M42 §2: the suggestion menu owns these keys while open. ---
      if (open) {
        // Tab/Enter complete the selected command WITHOUT submitting; Enter
        // falls through to the normal submit only when the typed word already
        // IS the selected command (complete command, no arguments).
        if (plainTab || bindingMatches(kb["app.submit"], input, key)) {
          const picked = matches[selected] ?? matches[0];
          if (picked !== undefined && (plainTab || token !== picked.name)) {
            const lines = state.lines.slice();
            lines[state.row] = completeSlashLine(lines[state.row] ?? "", picked.name);
            // M44 §3: completion rebuilds the whole line — the cursor sits at
            // its end, never at the pre-completion col.
            setState({ ...state, lines, col: (lines[state.row] ?? "").length });
            setSuggest({ token: picked.name, selected: 0, dismissed: null });
            return;
          }
        }
        // Esc closes the menu for this token; the typed text survives.
        if (key.escape) {
          setSuggest({ token, selected, dismissed: token });
          return;
        }
        // ↑↓ move the selection instead of the cursor row while the menu is
        // open (registry-driven, so remaps keep working).
        if (matches.length > 0 && bindingMatches(kb["input.up"], input, key)) {
          setSuggest({ token, selected: Math.max(0, selected - 1), dismissed: null });
          return;
        }
        if (matches.length > 0 && bindingMatches(kb["input.down"], input, key)) {
          setSuggest({ token, selected: Math.min(matches.length - 1, selected + 1), dismissed: null });
          return;
        }
      }

      // The submit key: full path (keeps the trailing-`\` continuation
      // sequence working against whatever key submits).
      if (bindingMatches(kb["app.submit"], input, key)) {
        const next = handleKey(state, { return: true });
        if (isSubmit(next)) {
          setState(createInputState());
          setSuggest(SUGGEST_CLOSED);
          if (next.submit.trim() !== "") {
            onSubmit(next.submit);
            setHistoryState(submitToHistory(historyState, next.submit));
          }
          return;
        }
        setState(next); // continuation line opened
        return;
      }
      // Demoted Enter: submit moved elsewhere → a bare Enter inserts a
      // newline instead of submitting (handleKey's return branch would
      // submit, so the newline is applied directly). M44 §1: the split is at
      // the cursor; a `\` immediately left of it is dropped (same rule as
      // handleKey's continuation).
      if (key.return && !bindingIsPlainReturn(kb["app.submit"])) {
        const lines = state.lines.slice();
        const line = lines[state.row] ?? "";
        const col = Math.min(Math.max(state.col, 0), line.length);
        const cut = col > 0 && line[col - 1] === "\\" ? col - 1 : col;
        lines[state.row] = line.slice(0, cut);
        lines.splice(state.row + 1, 0, line.slice(col));
        setState({ lines, row: state.row + 1, col: 0 });
        return;
      }
      // M44 §2: history recall. ↑ at the FIRST row / ↓ at the LAST row swap
      // the whole buffer for a recalled prompt (a single-line input sits at
      // both ends, so plain ↑/↓ there is pure history); mid rows of a
      // multi-line buffer keep the row navigation the fall-through below
      // applies. The menu block above has already returned, so an open
      // suggestion menu keeps ↑/↓ for selection (§3). An empty history and
      // the ends of the recall chain fall through as no-ops.
      if (bindingMatches(kb["input.up"], input, key) && state.row === 0) {
        const recalled = recallOlder(historyState, state.lines.join("\n"));
        if (recalled !== null) {
          setState(inputStateFromText(recalledText(recalled)));
          setHistoryState(recalled);
        }
        return;
      }
      if (bindingMatches(kb["input.down"], input, key) && state.row === state.lines.length - 1) {
        const recalled = recallNewer(historyState);
        if (recalled !== null) {
          setState(inputStateFromText(recalledText(recalled)));
          setHistoryState(recalled);
        }
        return;
      }
      // Registry-driven editing keys. REPLACE semantics: the three managed
      // actions take their flag ONLY from the registry (defaults equal the
      // raw ink booleans, so default behavior is byte-identical); an override
      // moves the action off its default key, and the orphaned default key
      // becomes a no-op here. Everything unmanaged passes through untouched.
      const eff: KeyInfo = {
        input,
        leftArrow: key.leftArrow,
        rightArrow: key.rightArrow,
        return: key.return,
        delete: key.delete,
        home: key.home,
        end: key.end,
        esc: key.escape,
        backspace: bindingMatches(kb["input.backspace"], input, key) || undefined,
        upArrow: bindingMatches(kb["input.up"], input, key) || undefined,
        downArrow: bindingMatches(kb["input.down"], input, key) || undefined,
      };
      // A consumed registry key must not ALSO type its character (ctrl+p
      // moving the cursor up should not insert "p").
      if (eff.backspace || eff.upArrow || eff.downArrow) eff.input = undefined;
      const next = handleKey(state, eff);
      if (isSubmit(next)) {
        setState(createInputState());
        setSuggest(SUGGEST_CLOSED);
        if (next.submit.trim() !== "") {
          onSubmit(next.submit);
          setHistoryState(submitToHistory(historyState, next.submit));
        }
        return;
      }
      setState(next);
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      {menuOpen ? <SlashSuggest commands={menu.matches} selected={menu.selected} /> : null}
      <Text>
        {state.lines.map((ln, i) => {
          const active = i === state.row && !disabled;
          const col = i === state.row ? Math.min(Math.max(state.col, 0), ln.length) : 0;
          return (
            <Text key={i}>
              {/* Accent prompt on the first line; continuation lines indent two
                  cells (the width of "› ") in dim so multi-line input stays
                  visually aligned under the text, not the prompt. */}
              {i === 0 ? (
                <Text color={T.accent}>{`${PROMPT} `}</Text>
              ) : (
                <Text color={T.dim}>{"  "}</Text>
              )}
              {/* M44 §1: the solid caret block renders BEFORE lines[row][col]
                  (visible even on empty lines / slow terms); non-active rows
                  render plain text. */}
              {active ? (
                <Text>
                  {ln.slice(0, col)}
                  <Text color={T.accent}>█</Text>
                  {ln.slice(col)}
                </Text>
              ) : (
                <Text>{ln}</Text>
              )}
              {/* Newline BETWEEN lines only — a trailing one would render an
                  extra blank line between the input and what follows (e.g. the
                  hint), doubling the gap after a flushed history notice. */}
              {i < state.lines.length - 1 ? "\n" : null}
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}
