// WorkspaceChip — the simple-mode composer's workspace switcher（极简模式
// 工作空间切换 spec §3.2）: the FileTree tree-top switcher's chip form.
// [📁 basename ▾] opens the recents menu (max 5, recentWorkspaces via the
// shared useRecentWorkspaces hook) + 打开其他目录…; a pick rides App's
// switchPanelRoot seam (B1 panel re-root + the AgentRootCard confirm — the
// agent-root semantics live THERE, the chip's label is the panel root).
// Degradations: absent/failed recents keep the menu at 打开其他目录…;
// disconnected disables the chip (the 📎 rule — ops cannot leave).
import { useState } from "react";
import type { FileOpsClient } from "../file-ops.js";
import { useRecentWorkspaces } from "../use-recent-workspaces.js";
import { rootBasename } from "./AgentRootCard.js";
import { IconChevronDown, IconFolder } from "./icons.js";

export function WorkspaceChip({ client, root, connected, onPick, onOpenOther }: {
  readonly client: FileOpsClient;
  /** 当前面板根（App 的 panelRoot；连接前即「工作区」占位）。 */
  readonly root: string;
  /** 断连 → disabled（📎 同规则）。 */
  readonly connected: boolean;
  /** 任一 recents 目录选定 → App 的 switchPanelRoot（B1+B3）。 */
  readonly onPick: (path: string) => void;
  /** 打开其他目录…（tauri 对话框与浏览器降级在 App 层 onOpenOtherWorkspace）。 */
  readonly onOpenOther: () => void;
}): React.JSX.Element {
  const [menu, setMenu] = useState(false);
  const recents = useRecentWorkspaces(client, menu);
  return (
    <div className="ws-chip-wrap">
      <button
        type="button"
        className="chip work"
        title={root}
        aria-haspopup="menu"
        aria-expanded={menu}
        disabled={!connected}
        onClick={() => setMenu((v) => !v)}
      >
        <IconFolder size={14} /> {rootBasename(root)} <IconChevronDown size={12} />
      </button>
      {menu ? (
        <>
          {/* 树顶同款 click-away idiom：透明 fixed 层 */}
          <div className="ws-backdrop" onClick={() => setMenu(false)} />
          <div className="ws-menu" role="menu">
            {(recents ?? []).map((w) => (
              <button
                key={w.path}
                type="button"
                className="ws-item"
                role="menuitem"
                title={w.path}
                onClick={() => {
                  setMenu(false);
                  onPick(w.path);
                }}
              >
                {rootBasename(w.path)}
              </button>
            ))}
            {recents === null ? <div className="ws-loading">加载中…</div> : null}
            <button
              type="button"
              className="ws-item ws-open-other"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                onOpenOther();
              }}
            >
              打开其他目录…
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
