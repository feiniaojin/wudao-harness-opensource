// det-71-night-porting-14 — the deterministic behavior pins for 夜移 026
// (sleep tool, Strands vended_tools/sleep ported with the unref repair).
// The model gets a bounded, permission-free temporal wait instead of paying
// a shell shell permission round. This suite pins the contract
// through the PUBLIC export (`@wudao-org/core`): validation fires BEFORE any
// sleep, the cap is named in the refusal, the risk annotations are the
// explicit safe set (so the permission pipeline auto-allows it), and the
// description steers file-waits to monitor_read. Zero network, zero
// filesystem, wall-clock cost ≤ ~20ms per run.
import type { EvalDefinition } from "../runner.js";
import { createSleepTool, SLEEP_DEFAULT_MAX_SECONDS } from "@wudao-org/core";

export interface NightPorting14Evidence {
  // ① a normal sleep resolves with the measured elapsed time
  readonly normalSleep: boolean;
  // ② an over-cap duration is refused before sleeping, cap named
  readonly overCapRejected: boolean;
  // ③ a negative duration is refused before sleeping
  readonly negativeRejected: boolean;
  // ④ read-only / concurrency-safe / not destructive / not open-world
  readonly riskFlags: boolean;
  // ⑤ description names the cap + steers to monitor_read; no timeoutMs
  readonly descriptionContract: boolean;
}

export const det71Eval: EvalDefinition<{ readonly root: string }, NightPorting14Evidence> = {
  name: "det-71-night-porting-14",
  kind: "deterministic",
  async setup() {
    return { root: "" };
  },
  async run() {
    const tool = createSleepTool();

    // ① normal sleep — tiny wall-clock cost, measured elapsed reported.
    const ok = await tool.execute({ seconds: 0.01 });
    const normalSleep = ok.isError !== true && /^Slept 0\.0\d+s$/.test(ok.content);

    // ② over-cap refused pre-sleep, cap in the message.
    const over = await tool.execute({ seconds: SLEEP_DEFAULT_MAX_SECONDS + 1 });
    const overCapRejected = over.isError === true && over.content.includes(String(SLEEP_DEFAULT_MAX_SECONDS));

    // ③ negative refused pre-sleep.
    const negative = await tool.execute({ seconds: -1 });
    const negativeRejected = negative.isError === true && negative.content.includes("non-negative");

    // ④ the explicit safe annotation set — the permission exemption IS the feature.
    const riskFlags = tool.isReadOnly?.({ seconds: 5 }) === true
      && tool.isConcurrencySafe?.({ seconds: 5 }) === true
      && tool.isDestructive?.({ seconds: 5 }) === false
      && tool.isOpenWorld?.({ seconds: 5 }) === false;

    // ⑤ cap interpolated + monitor steering; no redundant timeoutMs.
    const descriptionContract = tool.description.includes(String(SLEEP_DEFAULT_MAX_SECONDS))
      && tool.description.includes("monitor_read")
      && tool.timeoutMs === undefined;

    return { normalSleep, overCapRejected, negativeRejected, riskFlags, descriptionContract };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.normalSleep, "① a normal sleep must resolve with its measured elapsed time");
    need(e.overCapRejected, "② an over-cap duration must be refused BEFORE sleeping with the cap named");
    need(e.negativeRejected, "③ a negative duration must be refused BEFORE sleeping");
    need(e.riskFlags, "④ sleep must be annotated read-only/concurrency-safe/not-destructive/not-open-world — the permission exemption is the feature");
    need(e.descriptionContract, "⑤ the description must name the cap and steer file-waits to monitor_read, with no redundant timeoutMs");

    return errs;
  },
};
