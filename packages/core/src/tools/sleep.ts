// 夜移 026 — sleep 工具 (Strands vended_tools/sleep, ported with an unref fix).
// A bounded, permission-free temporal wait: the model lets a background
// process make progress or backs off before a retry WITHOUT paying a shell
// shell permission round. Strands contract kept: the factory validates
// the cap (developer error → throw), execute validates the duration BEFORE
// sleeping (model error → isError result), and cancellation wins — wudao's
// loop already races every tool batch against the abort signal (loop.ts
// tool-batch abort), so an interrupted run discards the result immediately.
// The JS-specific repair Strands does not need: an abandoned sleep's timer
// is still a live libuv handle (Python task cancellation clears it; a JS
// promise is not cancellable). unref() means the discarded timer never
// holds a headless process open past the abort.
import { buildTool } from "../tool.js";

export const SLEEP_DEFAULT_MAX_SECONDS = 60;

/** Model-facing description with the configured cap interpolated. Static
 *  per factory config — byte-stable for prefix caching (Strands
 *  sleep_description, plus the monitor_read steering wudao adds). */
function sleepDescription(maxSeconds: number): string {
  return (
    `Pause for the given number of seconds (max ${maxSeconds}), then continue. `
    + "Use for bounded waits: letting a background process make progress, backing off before a retry. "
    + "An interrupted run ends the pause immediately. "
    + "Prefer monitor_read when waiting for a file or background output to change — it returns as soon as there is news instead of after a fixed delay. "
    + `Rejects negative or non-finite durations and durations above ${maxSeconds}.`
  );
}

export function createSleepTool(options: { readonly maxSeconds?: number } = {}) {
  const maxRaw = options.maxSeconds ?? SLEEP_DEFAULT_MAX_SECONDS;
  if (typeof maxRaw !== "number" || !Number.isFinite(maxRaw) || maxRaw <= 0) {
    throw new Error(`maxSeconds must be a positive finite number (got ${String(maxRaw)})`);
  }
  const maxSeconds = maxRaw;

  return buildTool({
    name: "sleep",
    promptSnippet: "sleep for a fixed time",
    promptGuidelines: [
      "Rarely the right tool: prefer a background watch (monitor_start) that wakes you on real progress.",
    ],
    description: sleepDescription(maxSeconds),
    parameters: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description: `Seconds to pause. Non-negative, finite, at most ${maxSeconds}.`,
        },
      },
      required: ["seconds"],
      additionalProperties: false,
    },
    // A pure temporal wait touches nothing — the fail-closed defaults are
    // correctly overridden here so the permission pipeline auto-allows it
    // (that exemption from an ask round is the point of the tool).
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute({ seconds }) {
      // Defensive re-check (the loop's schema validation already rejects
      // these; a direct execute caller gets the same refusal, not a NaN
      // timer). Strands checks the same shapes inside the tool.
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
        return {
          content: `sleep invalid arguments: seconds must be a number (got ${typeof seconds})`,
          isError: true,
        };
      }
      if (seconds < 0) {
        return { content: `sleep invalid arguments: seconds must be non-negative (got ${seconds})`, isError: true };
      }
      if (seconds > maxSeconds) {
        return {
          content: `sleep invalid arguments: seconds ${seconds} exceeds the configured maximum of ${maxSeconds}`,
          isError: true,
        };
      }

      const startedAt = Date.now();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.round(seconds * 1000));
        timer.unref(); // a discarded sleep never holds the event loop open
      });
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      return { content: `Slept ${elapsedSeconds.toFixed(2)}s` };
    },
  });
}
