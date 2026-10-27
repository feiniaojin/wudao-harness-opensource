// AgentRootCard — workspace-ux B3 (spec B·Web 交互流): the TRANSIENT confirm
// card a successful directory pick arms in the composition area — the
// permission-ask slot's position and form (the .approval card's structure,
// accent-tinted instead of amber: an informational confirm, not a permission
// risk). NOT history-embedded buttons: the append-only history only ever
// receives the outcome texts (the switch's notice is the DRIVER's — the web
// adds none; 保持现状's is the parent's notify).
//
// States: armed (the two-root copy + the two answers) and queued (a busy
// 切换 parked server-side until the run's settle seam — buttons hidden: there
// is no un-park op, so the decision is locked; the busy→idle settle refresh
// via agentRootStatus dismisses the card once the roots align). The 切换
// button is ALWAYS clickable — run-busy is the op's business (idle applies
// now, busy queues), never a disabled state.

/** The card's display name for a root — the last non-empty path segment
 *  (the root itself stands in when the path has none). */
export function rootBasename(path: string): string {
  return path.split("/").filter((p) => p !== "").slice(-1)[0] ?? path;
}

export function AgentRootCard({ panelRoot, agentRoot, queued, onSwitch, onKeep }: {
  /** The picked root (the file panel's new view root = the switch target). */
  readonly panelRoot: string;
  /** The agent's root at arm time — the "still at" half of the copy ("" =
   *  unknown: the card says 原目录 instead of guessing). */
  readonly agentRoot: string;
  /** A busy 切换 parked until the run's settle seam. */
  readonly queued: boolean;
  /** 切换 agent 目录 — fire agentRootSwitch(panelRoot). */
  readonly onSwitch: () => void;
  /** 保持现状 — dismiss with the web notice. */
  readonly onKeep: () => void;
}): React.JSX.Element {
  const panelName = rootBasename(panelRoot);
  const agentName = agentRoot !== "" ? rootBasename(agentRoot) : null;
  return (
    <div className="approval agent-root" role="alertdialog" aria-label="agent 工作目录确认">
      <div className="strip">{queued ? "已排队 — 将在当前任务结束后切换" : "文件面板已切换 · agent 工作目录待确认"}</div>
      <div className="why">
        {queued
          ? `当前任务保持原工作目录；任务结束后 agent 工作目录将切换 → ${panelName} (${panelRoot})`
          : `文件面板已切换到 ${panelName}。agent 的工作目录仍为 ${agentName ?? "原目录"}。`}
      </div>
      {!queued ? (
        <div className="btns">
          <button type="button" className="deny" onClick={onKeep}>
            保持现状
          </button>
          <button type="button" className="allow" onClick={onSwitch}>
            切换 agent 目录
          </button>
        </div>
      ) : null}
    </div>
  );
}
