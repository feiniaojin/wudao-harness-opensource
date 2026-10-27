// useRecentWorkspaces — the workspace switchers' shared recents source
// (极简模式工作空间切换 spec §3.3): FileTree's tree-top menu and the
// simple-mode composer's WorkspaceChip both ride this hook — one data
// path, two projections. The semantics are FileTree's verbatim
// (M75-ux1 §2): the fetch fires on every OPEN (fresh list) — never on
// mount, so a closed menu costs no ops; an absent op (older client/mock)
// or a failed fetch keeps the last-known list standing.
// ω99-243: #4 — 失败诚实化：首取失败时 null 落定为 []（「打开其他目录…」
// 行动道常在，菜单不再永远挂着「加载中…」的谎言）；已加载过的列表在刷新
// 失败时照旧保留（last-known 语义零改——刷新失败 ≠ 从未加载）。
import { useEffect, useRef, useState } from "react";
import type { FileOpsClient, RecentWorkspace } from "./file-ops.js";

export function useRecentWorkspaces(
  client: FileOpsClient,
  open: boolean,
): readonly RecentWorkspace[] | null {
  const [recents, setRecents] = useState<readonly RecentWorkspace[] | null>(null);
  const clientRef = useRef(client);
  clientRef.current = client;
  useEffect(() => {
    if (!open) return;
    const recentsOp = clientRef.current.recentWorkspaces;
    if (recentsOp === undefined) return;
    let cancelled = false;
    // .call keeps `this` on the client — WudaoClient's op methods are
    // prototype methods, a detached const would lose the instance.
    recentsOp.call(clientRef.current).then(
      (r) => {
        if (!cancelled) setRecents((r.workspaces ?? []).slice(0, 5));
      },
      () => {
        /* keep the last-known list standing; a NEVER-loaded null settles to
           [] — an honest empty (the action lane), not an eternal spinner. */
        if (!cancelled) setRecents((prev) => prev ?? []);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open]);
  return recents;
}
