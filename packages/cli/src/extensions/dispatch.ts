// M39: shared slash-command dispatch for the two interactive frontends
// (readline REPL + Ink TUI). The frontends own notice/submit plumbing; this
// helper owns the CONTRACT: the handler runs in isolation (a throw warns and
// submits nothing), ctx.submit records exactly one user turn, and extra
// submits warn instead of silently overwriting.
import type { ExtensionCommand } from "./api.js";

export interface ExtensionDispatchIo {
  /** Informational line — rendered dim/notice, never enters the history. */
  readonly notice: (text: string) => void;
  /** Failure line (handler throw, duplicate submit). */
  readonly warn: (msg: string) => void;
}

/** Run one extension command. Resolves the text the handler submitted
 *  (undefined when it never called ctx.submit, or when it threw — a failed
 *  command submits nothing). */
export async function runExtensionCommand(
  cmd: ExtensionCommand,
  args: string,
  io: ExtensionDispatchIo,
): Promise<string | undefined> {
  let submitted: string | undefined;
  try {
    await cmd.handler(args, {
      submit: (text: string): void => {
        if (typeof text !== "string" || text === "") {
          io.warn(`extension command /${cmd.name}: submit() needs a non-empty string; ignored`);
          return;
        }
        if (submitted !== undefined) {
          io.warn(`extension command /${cmd.name}: submit() called twice; keeping the first text`);
          return;
        }
        submitted = text;
      },
      notice: (text: string): void => {
        if (typeof text === "string" && text !== "") io.notice(text);
      },
    });
    return submitted;
  } catch (err) {
    io.warn(`extension command /${cmd.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
