// ω99 拆分运动 弧 B：computer 的 settle/wait 采样层外提（原 createComputerTools
// 闭包内连续段逐字保留——黑名单探针/内部采样/基线/停稳判定/回执尾缝；可变
// 观察/黑名单态留在工具集闭包内（单绑定），经 getter 只读线程进来）。
import {
  OBSERVE_BLACKLIST_N,
  SETTLE_SAMPLE_INTERVAL_MS,
  SETTLE_WINDOW_MS,
  buildObserveArgs,
  formatSettleLine,
  isEmptyObservation,
  observeContentDigest,
  parseObserveOutput,
  resolveClickHelper,
  type ExecSeam,
  type ObserveTable,
  type SettleOutcome,
} from "./exec.js";

/** settle 基线：ref 动作=lastObservation 的表（零采样——press/settext 的
 *  sha 守卫已保证它是动作时刻的界面）；非 ref 动作=动作前轻量采样一次。 */
export type SettleBase = { readonly digest: string; readonly appParam: string | undefined };
export type SettleBaseResult = SettleBase | "no-tree" | undefined;

/** The settle engine's closure context (verbatim free variables; the two
 *  mutable observe-state bindings ride read-only getters — single binding
 *  stays in the tool-set closure). */
export interface SettleEngineCtx {
  readonly exec: ExecSeam;
  readonly env: NodeJS.ProcessEnv;
  readonly helperExists: (path: string) => boolean;
  readonly execPath: string | undefined;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly getLastObservation: () => { readonly table: ObserveTable; readonly appParam: string | undefined } | undefined;
  readonly getStreak: () => { readonly key: string; readonly count: number; readonly until: number } | undefined;
}

export function createSettleEngine(ctx: SettleEngineCtx): {
  observeBlacklisted: (key: string) => boolean;
  sampleObserve: (appParam: string | undefined) => Promise<ObserveTable | undefined>;
  settleBaseFromObservation: () => SettleBaseResult;
  freshSettleBase: () => Promise<SettleBaseResult>;
  runSettle: (base: SettleBase) => Promise<SettleOutcome | undefined>;
  withSettle: (receipt: string, base: SettleBaseResult) => Promise<string>;
} {
  const { exec, env, helperExists, execPath, now, sleep, getLastObservation, getStreak } = ctx;
  const lastObservation = getLastObservation;
  const observeEmptyStreak = getStreak;
  /** 黑名单读探针（纯读，绝不写 247 的 streak 态）：settle/内部采样在拉黑
   *  期内不硬试（247 自愈闭环的内部面）。 */
  const observeBlacklisted = (key: string): boolean =>
    observeEmptyStreak() !== undefined
    && observeEmptyStreak()!.key === key
    && observeEmptyStreak()!.count >= OBSERVE_BLACKLIST_N
    && now() < observeEmptyStreak()!.until;

  /** 采样一次观察（与 247 observe 完全同 argv——预算三参单源；**绝不落
   *  lastObservation 态**：refs 属于用户自己的 observe，内部采样改写它会作废
   *  用户手里的编号）。helper 缺席/失败/不可解析 → undefined（调用方诚实缺席）。 */
  const sampleObserve = async (appParam: string | undefined): Promise<ObserveTable | undefined> => {
    const helper = resolveClickHelper(env, helperExists, execPath);
    if (helper === undefined) return undefined;
    const r = await exec(helper, buildObserveArgs(appParam));
    if (r.code !== 0) return undefined;
    const read = parseObserveOutput(r.stdout);
    return read.ok ? read.table : undefined;
  };

  const settleBaseFromObservation = (): SettleBaseResult => {
    const obs = lastObservation();
    return obs === undefined
      ? undefined
      : { digest: observeContentDigest(obs.table), appParam: obs.appParam };
  };

  const freshSettleBase = async (): Promise<SettleBaseResult> => {
    if (observeBlacklisted("")) return "no-tree"; // 拉黑期内不硬试
    const table = await sampleObserve(undefined);
    if (table === undefined) return undefined;
    if (isEmptyObservation(table)) return "no-tree";
    return { digest: observeContentDigest(table), appParam: undefined };
  };

  /** 动作后 settle：短窗内采样对比基线，连续两拍相同才算「停」（变化中不下
   *  结论）；窗到仍在变=未稳定。采样失败 → undefined（诚实缺席）。三态行=
   *  确定性事实，无 verified/failed 语义结论（§二诚实边界）。 */
  const runSettle = async (base: SettleBase): Promise<SettleOutcome | undefined> => {
    const start = now();
    let prev: string | undefined;
    for (;;) {
      if (prev !== undefined) await sleep(SETTLE_SAMPLE_INTERVAL_MS);
      const table = await sampleObserve(base.appParam);
      if (table === undefined) return undefined;
      const digest = observeContentDigest(table);
      if (prev !== undefined && digest === prev) {
        return digest === base.digest ? { kind: "unchanged" } : { kind: "changed" };
      }
      prev = digest;
      if (now() - start >= SETTLE_WINDOW_MS) return { kind: "restless", windowMs: SETTLE_WINDOW_MS };
    }
  };

  /** 动作回执尾缝升级（统一缝——六动作一处挂）：241 状态行之后追加 settle 行。
   *  基线缺席/采样失败 → 不附（诚实缺席）；no-tree → 降级行引走 screen_capture。
   *  任何 settle 异常都被吞在这里——动作本身照常成功（fire-and-forget 面）。 */
  const withSettle = async (receipt: string, base: SettleBaseResult): Promise<string> => {
    try {
      if (base === undefined) return receipt;
      if (base === "no-tree") return `${receipt}\n${formatSettleLine({ kind: "no-tree" })}`;
      const outcome = await runSettle(base);
      return outcome === undefined ? receipt : `${receipt}\n${formatSettleLine(outcome)}`;
    } catch {
      return receipt; // 绝不 fail 动作（217 纪律）
    }
  };
  return { observeBlacklisted, sampleObserve, settleBaseFromObservation, freshSettleBase, runSettle, withSettle };
}
