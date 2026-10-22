// ω99-35 — the headless (non-TTY) input batcher.
//
// §0: a non-TTY stdin (FIFO/pipe — `--no-tui` headless ops) fed a multi-line
// prompt had EVERY line submitted as its own user turn: readline's line
// semantics are correct for a TTY (a human submits line by line) but wrong
// for a pipe (a writer pastes a whole prompt). The model then read line 1 as
// the complete task and self-created a mission while the remaining lines
// dribbled in as later turns (campaign evidence: 12 mission_starts across
// 6+ ledgers from one injected task list).
//
// This module gives the non-TTY wiring a bracketed-paste equivalent through
// TWO explicit triggers (deliberately NOT a heuristic paste detector):
//
// 1. blank line = message terminator (SMTP-style): an empty line flushes the
//    accumulated batch immediately as exactly ONE user turn — a deterministic
//    "send" lever for automation ("multi-line task + blank line" protocol).
// 2. idle window: `windowMs` (default 150ms, a hard constant; the runRepl
//    opts seam injects smaller values for tests) after the LAST line with no
//    new line flushes the batch — a one-line injection pays only the window,
//    a burst aggregates. Slow line-by-line writing (> window apart) still
//    fragments: a documented degradation, not a guess to beat.
//
// Command semantics: a line that routes as a command when it is the FIRST
// line of a batch (empty buffer + command-table hit, or a `!` shell line)
// submits immediately, single-line — commands are naturally single-line. A
// command-shaped line that arrives AFTER content is an interior line of the
// in-flight message and rides with the batch as content — the TUI's
// whole-text routing semantics (parseReplCommand sees the submitted buffer,
// not each line), kept byte-compatible here.
//
// Delivery mirrors readline's own discipline exactly, so the REPL's handlers
// never learn the batcher exists: a flush resolves a pending take() (the
// idle-prompt acquire) or parks through onPark (the mid-turn FIFO) — the
// same two consumers rl.question / onParkedLine serve today.

/** The production idle-window default (ms). A constant by design — the only
 *  injection seam is the runRepl opts (tests); no env/settings surface. */
export const HEADLESS_BATCH_WINDOW_MS = 150;

export interface HeadlessLineBatcher {
  /** One raw stdin line (readline already stripped the newline). */
  push(line: string): void;
  /** The idle-prompt acquire: prints the prompt, resolves with the next
   *  flushed batch (string), or `null` once EOF has drained the batcher —
   *  the caller's exit sentinel. */
  take(prompt: string): Promise<string | null>;
  /** EOF/close: flush the in-flight batch through the normal delivery, then
   *  resolve pending/future takes with `null`. Idempotent. */
  notifyClose(): void;
}

export function createHeadlessLineBatcher(opts: {
  /** Idle window in ms (tests inject small values; default 150). */
  readonly windowMs?: number;
  /** Standalone-line routing: does this line act as a command/shell line
   *  when it starts a batch? (Checked only on an EMPTY buffer — interior
   *  command-shaped lines are message content.) */
  readonly isImmediate: (line: string) => boolean;
  /** Mid-turn delivery (no take pending) — the park FIFO feed. */
  readonly onPark: (text: string) => void;
  /** Prompt rendering (stdout), byte-identical to rl.question's query. */
  readonly write: (text: string) => void;
}): HeadlessLineBatcher {
  const windowMs = opts.windowMs ?? HEADLESS_BATCH_WINDOW_MS;
  const buffer: string[] = [];
  const takers: ((value: string | null) => void)[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const deliver = (text: string): void => {
    const take = takers.shift();
    if (take !== undefined) take(text);
    else opts.onPark(text);
  };
  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (buffer.length === 0) return; // nothing in flight — a lone blank line is a no-op
    const batch = buffer.join("\n");
    buffer.length = 0;
    deliver(batch);
  };

  return {
    push(line) {
      if (closed) return; // EOF drained — late bytes (readline guarantees none) die here
      // Trigger 1: the blank-line terminator (whitespace-only counts — a
      // lone such line was a no-op pre-batching, so no turn is lost).
      if (line.trim() === "") {
        flush();
        return;
      }
      // Standalone command/shell line: immediate, single-line, never batched.
      if (buffer.length === 0 && opts.isImmediate(line)) {
        deliver(line);
        return;
      }
      buffer.push(line);
      if (timer !== undefined) clearTimeout(timer);
      // Trigger 2: the idle window — flush `windowMs` after the LAST line.
      timer = setTimeout(() => {
        timer = undefined;
        flush();
      }, windowMs);
      timer.unref?.();
    },
    take(prompt) {
      if (closed) return Promise.resolve(null); // drained — no trailing prompt print
      opts.write(prompt);
      return new Promise<string | null>((resolve) => {
        takers.push(resolve);
      });
    },
    notifyClose() {
      if (closed) return;
      flush(); // the in-flight batch still becomes its turn…
      closed = true;
      for (const take of takers.splice(0)) take(null); // …then the drained exit sentinel
    },
  };
}
