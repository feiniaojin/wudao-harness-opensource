// M23: long-task execution settings — `.wudao/settings.json` `longTask` node
// + env overrides, resolved into the loop's gates and turn fuse.
//
// Loader contract (hooks-config's pattern): missing/empty settings → defaults
// (silent); malformed JSON or wrong-typed values → warning + per-field
// fallback (never fatal); unknown keys → warning listing them.
//
// Runtime resolution:
//   gates       — todo/verify stop gates + maxInsists (LoopOptions.gates)
//   maxTurns    — turn fuse. WUDAO_MAX_TURNS overrides the configured fuse;
//                 "0" means UNLIMITED (the fuse is off — long tasks are
//                 stopped by the board gates, not the counter).
//   WUDAO_LONG_TASK_GATES=off — emergency kill switch for BOTH gates.
import type { LoopGates } from "@wudao-org/core";
import { isFeatureAblated } from "./args.js";
import { loadLayeredSettings } from "./settings-layer.js";

export interface LongTaskSettings {
  readonly todoGate: boolean;
  readonly verifyGate: boolean;
  readonly gateMaxInsists: number;
  readonly maxTurnsFuse: number;
}

export interface LongTaskRuntime {
  /** Optional since M53 §5: --no-gates strips the stop gates from every
   *  entry path (the runtime shape stays; consumers thread undefined). */
  readonly gates?: LoopGates;
  readonly maxTurns: number;
}

export type LongTaskWarn = (message: string) => void;

export const DEFAULT_LONG_TASK: LongTaskSettings = {
  todoGate: true,
  verifyGate: true,
  gateMaxInsists: 3,
  maxTurnsFuse: 200,
};

const KNOWN_KEYS = ["todoGate", "verifyGate", "gateMaxInsists", "maxTurnsFuse"] as const;

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function loadLongTaskSettings(
  workspaceRoot: string,
  warn: LongTaskWarn = defaultWarn,
): Promise<LongTaskSettings> {
  // M57 §1: the two-tier reader (global + project, deep-merged) owns file IO
  // and JSON validation; this loader parses the effective `longTask` node.
  const root = await loadLayeredSettings(workspaceRoot, warn).then((l) => l.effective);
  const node = root["longTask"];
  if (node === undefined) return DEFAULT_LONG_TASK;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    warn(`⚠️ settings: "longTask" must be an object; defaults applied`);
    return DEFAULT_LONG_TASK;
  }

  const record = node as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !(KNOWN_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown longTask key(s) ignored: ${unknown.join(", ")}`);
  }

  const out: { -readonly [K in keyof LongTaskSettings]: LongTaskSettings[K] } = { ...DEFAULT_LONG_TASK };
  if (record["todoGate"] !== undefined) {
    const v = readBoolean(record["todoGate"]);
    if (v === undefined) warn('⚠️ longTask.todoGate must be a boolean; ignored');
    else out.todoGate = v;
  }
  if (record["verifyGate"] !== undefined) {
    const v = readBoolean(record["verifyGate"]);
    if (v === undefined) warn('⚠️ longTask.verifyGate must be a boolean; ignored');
    else out.verifyGate = v;
  }
  if (record["gateMaxInsists"] !== undefined) {
    const v = readPositiveInt(record["gateMaxInsists"]);
    if (v === undefined) warn("⚠️ longTask.gateMaxInsists must be a positive integer; ignored");
    else out.gateMaxInsists = v;
  }
  if (record["maxTurnsFuse"] !== undefined) {
    const v = readPositiveInt(record["maxTurnsFuse"]);
    if (v === undefined) warn("⚠️ longTask.maxTurnsFuse must be a positive integer; ignored");
    else out.maxTurnsFuse = v;
  }
  return out;
}

/** Parse WUDAO_MAX_TURNS: numeric override where 0 = unlimited (fuse off). */
function envMaxTurns(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env["WUDAO_MAX_TURNS"];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined; // garbage → ignore
  return n === 0 ? Infinity : Math.floor(n);
}

export function resolveLongTaskRuntime(
  settings: LongTaskSettings | undefined,
  env: NodeJS.ProcessEnv,
): LongTaskRuntime {
  const s = settings ?? DEFAULT_LONG_TASK;
  const gatesOff = env["WUDAO_LONG_TASK_GATES"] === "off";
  return {
    gates: {
      todo: gatesOff ? false : s.todoGate,
      verify: gatesOff ? false : s.verifyGate,
      maxInsists: s.gateMaxInsists,
    },
    maxTurns: envMaxTurns(env) ?? s.maxTurnsFuse,
  };
}

/** M53 review fix — the `--no-gates` ablation applied to the runtime. The
 *  flag must DISABLE the gates (todo/verify false, mirroring
 *  WUDAO_LONG_TASK_GATES=off), not drop them from the runtime shape: the
 *  loop defaults `gates: undefined` back to ON (`options.gates?.todo ??
 *  true`), so the pre-fix `gates: undefined` was a no-op. This is the one
 *  seam every entry path threads through (index.ts). */
export function applyGatesAblation(
  rt: LongTaskRuntime,
  env: NodeJS.ProcessEnv = process.env,
): LongTaskRuntime {
  if (!isFeatureAblated("gates", env)) return rt;
  return {
    ...rt,
    gates: {
      todo: false,
      verify: false,
      maxInsists: rt.gates?.maxInsists ?? DEFAULT_LONG_TASK.gateMaxInsists,
    },
  };
}
