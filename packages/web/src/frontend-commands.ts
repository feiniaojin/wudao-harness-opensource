// The frontend-owned half of the command router — the web mirror of
// parseReplCommand's (cli/src/repl.ts) frontend commands. The four builtin
// UI-presentational commands (exit/clear/help/resume) are intercepted HERE
// before any submit, exactly like the TUI; everything else passes through
// to the driver verbatim (which routes /plan, /skill:…, /rewind, plan
// review, @-mentions server-side and answers with the outcome word — a
// "frontend" outcome for a plugin/extension command means the CALLER owns
// its execution).
export type FrontendCommand =
  | { kind: "noop" }
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "resume" }
  /** M53 §1: /edit <n> — arm the branch server-side and put the returned
   *  text in the input (the resubmit branches). Bare /edit stays a pass
   *  (the driver lists the messages as a notice). */
  | { kind: "edit"; n: number }
  | { kind: "pass"; text: string };

export function parseFrontendCommand(line: string): FrontendCommand {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "noop" };
  if (trimmed === "/exit" || trimmed === "/quit") return { kind: "exit" };
  if (trimmed === "/clear") return { kind: "clear" };
  if (trimmed === "/help" || trimmed === "/?") return { kind: "help" };
  if (trimmed === "/resume" || trimmed.startsWith("/resume ")) return { kind: "resume" };
  if (/^\/edit\s+\d+$/.test(trimmed)) return { kind: "edit", n: Number(trimmed.split(/\s+/)[1]) };
  return { kind: "pass", text: line };
}
