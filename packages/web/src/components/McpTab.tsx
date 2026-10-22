// McpTab — the settings page's MCP tab (MCP visibility, 2026-08-31 用户反馈
// 「配置之后，根本不知道自己有什么 mcp」): every CONFIGURED server across
// the three tiers over the single mcpList read, grouped by tier, with the
// live runtime lane (已连接/未连接 + 工具数) and the where-to-add hints
// (the three config file paths). Read-only by design — adding a server is
// editing a file (the hints say exactly which one); env/headers never reach
// this tab (the op's contract: process-list-visible data only).
//
// Degradation: an old server (op unrouted, or a driver without the op) →
// the whole tab shows 「升级 wudao 后可用」 (the PluginTab family's rule).
import { useCallback, useEffect, useState } from "react";
import type { McpListResult, McpServerRowWire, WudaoClient } from "../protocol.js";
import { Icon } from "./Icon.js";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The old-server markers: an unrouted op vs a driver without it. */
const isUnsupported = (e: unknown): boolean => {
  const msg = errText(e);
  return msg.includes("unknown op: mcp") || msg.includes("mcp ops not supported");
};

/** The tier groups, in the replacement chain's order (later replaces
 *  same-name earlier). */
const TIER_GROUPS: readonly {
  readonly tier: McpServerRowWire["tier"];
  readonly title: string;
  readonly file: keyof McpListResult["files"];
  readonly hint: string;
}[] = [
  { tier: "user", title: "用户级 —— 本机所有项目", file: "user", hint: "所有会话可用；the upstream harness / wudao 两种格式都行（mcpServers 或 servers）" },
  { tier: "root", title: "项目根 .mcp.json —— the upstream harness 项目文件", file: "root", hint: "the upstream harness 的项目级配置，wudao 直接读取，零拷贝迁移" },
  { tier: "project", title: "项目级 .wudao/mcp.json —— 本工作区", file: "project", hint: "仅本项目；同名服务器整体替换上面两层（三层中优先级最高）" },
];

/** One server row's status line: the runtime lane, never an alarm — 未连接
 *  includes lazy-load (this session hasn't spawned it yet). */
function statusText(s: McpServerRowWire): string {
  if (s.connected) return `已连接 · ${s.tools} 个工具`;
  if (s.failure !== undefined) return `连接失败 · ${s.failure.split("\n")[0] ?? s.failure}`;
  return "未连接（本次会话尚未启动）";
}

export function McpTab({
  client,
}: {
  client: WudaoClient;
}): React.JSX.Element {
  const [unsupported, setUnsupported] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<McpListResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchList = useCallback(async (): Promise<void> => {
    setData(await client.mcpList());
    setLoadError(null);
  }, [client]);

  // Lazy by design (the settings page mounts tabs only while active): the
  // read stays off the wire until the user opens the MCP tab.
  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    fetchList()
      .catch((e: unknown) => {
        if (cancelled) return;
        if (isUnsupported(e)) setUnsupported(true);
        else setLoadError(errText(e));
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchList]);

  const refresh = (): void => {
    setRefreshing(true);
    fetchList()
      .catch((e: unknown) => setLoadError(errText(e)))
      .finally(() => setRefreshing(false));
  };

  if (unsupported) {
    return (
      <div className="settings-section">
        <div className="section-title">MCP 服务器</div>
        <div className="hint">升级 wudao 后可用</div>
      </div>
    );
  }

  const servers = data?.servers ?? [];
  return (
    <div className="settings-section" data-testid="mcp-tab">
      <div className="section-title">MCP 服务器</div>
      <div className="hint">
        {"已配置的 MCP 服务器分三层生效：用户级 → 项目根 .mcp.json → 项目级（同名后者整体替换前者）。配置文件支持 the upstream harness 的 mcpServers 格式，可直接粘贴。"}
      </div>
      <div className="keyrow">
        <button type="button" className="wudao" disabled={refreshing} onClick={refresh} data-testid="mcp-refresh">
          {refreshing ? "刷新中…" : "刷新"}
        </button>
        <span className="meta">{`${servers.length} 个服务器`}</span>
      </div>
      {loadError !== null ? <div className="entry-error">{`无法读取 MCP 配置:${loadError}`}</div> : null}
      {data !== null && data.warnings.length > 0
        ? data.warnings.map((w) => <div key={w} className="entry-error"><Icon name="triangle-alert" size={12} /> {w}</div>)
        : null}
      {data !== null && servers.length === 0 && loadError === null ? (
        <div className="hint">尚未配置任何 MCP 服务器——把配置写入下面任一文件即可（保存后新会话生效）</div>
      ) : null}

      {TIER_GROUPS.map((g) => {
        const rows = servers.filter((s) => s.tier === g.tier);
        const file = data?.files[g.file];
        return (
          <div key={g.tier} className="installed-group" data-mcp-tier={g.tier}>
            <div className="group-title">
              {g.title}
              <span className="meta">{file !== undefined ? `（${file}）` : ""}</span>
            </div>
            <div className="hint">{g.hint}</div>
            {rows.length === 0 ? (
              <div className="muted">（无）</div>
            ) : (
              rows.map((s) => (
                <div key={s.name} className="installed-row" data-mcp-server={s.name}>
                  <span className="plugin-name">{s.name}</span>
                  <span className="meta">{s.transport === "http" ? "http" : "stdio"}</span>
                  <span className="plugin-desc">{s.command}</span>
                  <span className="meta" data-mcp-status={s.name}>{statusText(s)}</span>
                  {s.replaces.length > 0 ? (
                    <span className="meta">{`替换了${s.replaces.map((t) => (t === "user" ? "用户级" : "项目根")).join("、")}的同名配置`}</span>
                  ) : null}
                </div>
              ))
            )}
          </div>
        );
      })}

      <div className="hint">
        {"提示：MCP 工具每次调用都会先征求确认（权限层设计）；会话里输入 /mcp 可随时查看连接状态。"}
      </div>
    </div>
  );
}
