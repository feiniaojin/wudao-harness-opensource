// @wudao/server — ω-3a 变更幂等 vault 的纯函数段外提（多 driver 并发弧 B 的
// 顺带件，file-size 棘轮纪律：index.ts 的白名单帽只收不涨）。逐字节搬家：
// isVaultedMutation / canonicalJson / VaultEntry 三段自 index.ts 原样外提；
// index.ts 的 re-export 门面维持既有公共面（vaulted-mirror.test.ts 把
// isVaultedMutation 钉在 index 导出上）。

/** The op names the vault covers — the MUTATIONS. Dual-form ops
 *  (`switch`, `recentWorkspaces`) vault only their mutating form (n / add
 *  present); the read form must stay uncached. Exported for the full-set
 *  mirror pin (tests/vaulted-mirror.test.ts — the server half of the web
 *  protocol test's classification pin; the wire payload arrives as parsed
 *  JSON, so the mirror is intentionally untyped Record<string, unknown>). */
export function isVaultedMutation(o: Record<string, unknown>): boolean {
  switch (o.op) {
    case "submit":
    case "interrupt":
    case "setMode":
    case "answerPermission":
    // 借鉴弧 α2/α1 — both new lanes are convergent-on-replay (a replayed
    // recall/answer finds nothing parked and answers false), but the family
    // law vaults driver-state mutations so a mid-flap replay re-serves the
    // original reply instead of re-executing against a MOVED queue (a same-
    // text entry at the same index would be the wrong kill).
    case "recallSteer":
    case "answerAskUser":
    // 借鉴弧 δ — convergent on replay (a replayed detach finds the call no
    // longer in flight and answers not_in_flight), but the driver-state
    // mutation family law vaults it: a mid-flap replay re-serves the
    // original verdict instead of detaching a MOVED busy row.
    case "detachToolCall":
    case "resume":
    case "rewind":
    // ω-3a review M1 follow-up: /edit arming IS a mutation (an armed edit
    // branch is driver state) — vaulted like every other mutation, so a
    // mid-flap replay re-serves the armed text instead of re-arming.
    case "edit":
    case "settingsSaveKey":
    case "settingsSet":
    // Provider management §5: a provider write is a side effect that must
    // survive a mid-flap replay exactly once — vaulted like settingsSet
    // (delete converges on replay, the /models probe is a read: not vaulted).
    case "settingsSaveProvider":
    case "switchWorkspace":
    case "panelRootSet":
    case "agentRootSwitch":
    case "attachmentSave":
    // ω99-55: the file lane's save writes content-addressed objects — a
    // side effect, vaulted like the image save (replay joins the original
    // execution; a re-uploaded duplicate is a dedup no-op anyway).
    case "fileSave":
    case "pluginMarketAdd":
    case "pluginMarketUpdate":
    case "pluginMarketRemove":
    case "pluginInstall":
    case "pluginUninstall":
    case "pluginEnable":
    case "pluginDisable":
    // persona-settings T5: persona writes are side effects — vaulted like the
    // other registry mutations (delete converges on replay; the reads
    // personaList/personaGet are NOT vaulted).
    case "personaSave":
    case "personaDelete":
    // ω99-235: #2 — the pet lane's three ops are mutations of the SECOND
    // driver session — vaulted exactly like their main-lane twins, so a
    // mid-flap replay never double-submits into the sprite's lane.
    case "petSubmit":
    case "petInterrupt":
    case "petAnswerPermission":
    // ω99-260: the memory decision is a side effect (confirm flips a line,
    // del removes it) — vaulted so a mid-flap replay never double-decides;
    // ok/del converge (a replayed second ok answers ok:false, never breaks).
    // ω99-264: the memory REWRITE rides the same vault seat — its replay
    // convergence is the driver's content-equal short-circuit (a bare update
    // is v+1 per call; the vault joins or replays the cached verdict, and a
    // genuinely re-sent edit converges in the driver, version 恰 +1).
    case "memoryDecide":
    case "memoryEdit":
    // ω99-314: the file-level time machine's restore is a WORKING-face side
    // effect (it overwrites a workspace file) — vaulted so a mid-flap replay
    // joins the original execution; a second revert after a later edit must
    // be a fresh user decision, never a replayed frame.
    case "fileRevert":
    // ω99-317: the schedules management face's two writes — setEnabled is a
    // state write (settingsSet shape), runNow RE-RUNS a task (a mid-flap
    // replay would double-run) — both vaulted for exactly-once. The delete
    // (schedulesRemove) converges on replay and stays UN-vaulted, the
    // sessionDelete/settingsDeleteProvider precedent.
    case "schedulesSetEnabled":
    case "schedulesRunNow":
      return true;
    // 永续 v6 wave2（reef C1）：改进提案面的五个决策是写副作用（consent 起
    // 子代理+模型调用、activate 写规则文件）——vaulted 恰一次；list 是读，
    // 与 schedulesList 同形不 vault。
    case "improvementFace":
      return o.action !== "list";
    case "switch":
      return o.n !== undefined;
    case "recentWorkspaces":
      return o.add !== undefined;
    default:
      return false;
  }
}

/** Deterministic serialization for the vault digest: object keys sorted at
 *  every depth, compact separators (the same canonical form nanobot's vault
 *  hashes — key order in a JSON frame must never change the digest). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** One vaulted operation: what the client asked (action + payload digest),
 *  whether it settled, its reply, and the joiners awaiting that reply. */
export interface VaultEntry {
  readonly action: string;
  readonly digest: string;
  done: boolean;
  ok: unknown;
  err?: string;
  completedAt: number | null;
  readonly joiners: ((ok: unknown, err?: string) => void)[];
}
