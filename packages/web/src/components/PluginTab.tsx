// PluginTab — cc-plugins C2: the settings page's 插件 tab (spec §C). Three
// surfaces over the C1 op group (one marketplace engine, three faces — the
// /plugin slash and `wudao plugin` CLI are the other two):
//
//   市场     the source input (owner/repo · git URL · 本地目录 ·
//            marketplace.json 路径) → pluginMarketAdd; the registered list
//            with per-market 更新 (pluginMarketUpdate) and 移除
//            (pluginMarketRemove — cascade-uninstalls what it installed);
//   发现     the SELECTED market's entries (embedded in pluginMarketList's
//            rows — name/description/version/「将安装」明细计数; git-location
//            sources carry detail:null → 「—」), plus the user/project scope
//            pick → pluginInstall. The confirmation IS the shown detail
//            (spec: web-side confirmation, the op just executes);
//   已装     pluginList's registry rows grouped by scope, with 启用/停用
//            (pluginEnable/pluginDisable) and 卸载 (pluginUninstall).
//
// Failure wording: engine failures get a ⚠️ prefix; the busy refusals
// (「⚠️ 运行中无法 …(任务进行中)」) already carry theirs — warnText renders
// the server's string VERBATIM so the family never double-prefixes. An old
// server (op unrouted, or a driver without the handlers) degrades the whole
// tab to 「升级 wudao 后可用」 — nothing else fires.
//
// ω99-236: #2 — the「内置」section (FIRST, before 市场): the doc trio
// (Excel/Word/PPT 十二工具) as a builtin plugin row with a toggle — 内置能
// 力也有开关与身份，不与核心熔死（09-09 用户指令 ①：这些 xlsx 等功能应是
// 插件，不整合进内核）. The row reads the page-level settingsStatus
// (settings prop — this tab never fetches) and writes through the SAME
// settingsSet allowlist (key docSuite.enabled) on the PreferencesTab setPref
// pattern (per-key pending, receipt toast, page refresh re-reads the truth).
// Old server without the key degrades to default-ON (`?? true` — the
// memoryEnabled 缺省门语义; a refused write shows the server's ⚠️ error, never
// silent). Off takes effect on the NEXT session (no mid-session removal, M24).
import { useCallback, useEffect, useState } from "react";
import type {
  InstalledPluginRowWire,
  InstallDetailWire,
  PluginSpecInstallResult,
  MarketplaceRowWire,
  RescanReceiptWire,
  SettingsStatus,
  WudaoClient,
} from "../protocol.js";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A failure line for the receipts area: the busy-refusal family already
 *  carries 「⚠️ …」 — render verbatim; everything else gets the prefix. */
const warnText = (msg: string): string => (msg.startsWith("⚠️") ? msg : `⚠️ ${msg}`);

/** The old-server markers: a server that never routed the op group vs one
 *  whose driver lacks the handlers — both mean 升级 wudao 后可用. */
const isUnsupported = (e: unknown): boolean => {
  const msg = errText(e);
  return msg.includes("unknown op: plugin") || msg.includes("plugin ops not supported");
};

/** The「将安装」明细计数 line (the loader dry-run's category counts shared
 *  by an install reply and a discover entry); git-location sources can only
 *  be inspected after cloning — 「—」. */
const detailText = (d: InstallDetailWire | null): string =>
  d === null ? "—" : `技能 ${d.skills} · 命令 ${d.commands} · Agents ${d.agents} · 钩子 ${d.hooks} · MCP ${d.mcp}`;

const rescanText = (r: RescanReceiptWire | undefined): string =>
  r === undefined ? "" : `;热重扫:技能 ${r.skills} · 插件 ${r.plugins} · 钩子 ${r.hooks}`;

/** The installed list's scope groups, in display order. adhoc rows are the
 *  session's --plugin mounts (always enabled, nothing to toggle). */
const SCOPE_GROUPS: readonly { readonly scope: InstalledPluginRowWire["scope"]; readonly title: string }[] = [
  { scope: "user", title: "用户(user)——本机所有会话" },
  { scope: "project", title: "项目(project)——当前工作区" },
  { scope: "adhoc", title: "本会话挂载(adhoc)——随启动参数" },
];

export function PluginTab({
  client,
  settings,
  notify,
  refresh,
}: {
  client: WudaoClient;
  /** ω99-236: the page-level settingsStatus (the「内置」段's toggle initial
   *  value rides it — this tab never fetches for it; null (still loading)
   *  degrades the checkbox to default-ON). */
  settings: SettingsStatus | null;
  /** The settings page's receipts area (success and failure lines both ride
   *  it — no async op fails silently). */
  notify: (text: string) => void;
  /** ω99-236: the page-level re-fetch — a landed docSuite write re-reads
   *  settingsStatus so the toggle re-derives from the persisted truth (the
   *  PreferencesTab refresh seam). */
  refresh: () => void;
}): React.JSX.Element {
  const [unsupported, setUnsupported] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [markets, setMarkets] = useState<readonly MarketplaceRowWire[] | null>(null);
  const [installed, setInstalled] = useState<readonly InstalledPluginRowWire[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  /** The one in-flight op's key (add / update:<m> / remove:<m> / install:<id>
   *  / toggle:<id> / uninstall:<id> / load / refresh) — buttons disable and
   *  the 处理中 marker shows while set. Plugin ops mutate shared state, so
   *  ANY in-flight op freezes the actions (racing installs against a refresh
   *  reads worse than waiting). */
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  /** ω99-236: the 内置段's one in-flight write key (set:docSuite.enabled —
   *  the PreferencesTab per-key pattern; NEVER freezes the plugin-ops
   *  buttons: a settings write is not a plugin mutation). */
  const [docSuitePending, setDocSuitePending] = useState(false);

  /** ω99-236: the doc trio's toggle write — settingsSet(docSuite.enabled)
   *  through the allowlist, receipt on the toast lane (the 记忆已开启/关闭 ——
   *  下会话生效 receipt family, no new sentence shapes), then the page-level
   *  refresh re-reads the persisted truth. */
  const setDocSuite = (on: boolean): void => {
    setDocSuitePending(true);
    client
      .settingsSet("docSuite.enabled", on)
      .then(() => {
        notify(`文档三件套已${on ? "开启" : "关闭"} —— 下会话生效`);
        refresh();
      })
      .catch((e: unknown) => notify(`⚠️ ${errText(e)}`))
      .finally(() => setDocSuitePending(false));
  };

  const fetchBoth = useCallback(async (): Promise<void> => {
    const [list, marketList] = await Promise.all([client.pluginList(), client.pluginMarketList()]);
    setInstalled(list.installed);
    setMarkets(marketList.marketplaces);
    // Keep the discover selection on a market that still exists; an empty
    // registry selects null (the empty-state hint owns the section).
    setSelected((prev) => {
      const names = marketList.marketplaces.map((m) => m.name);
      if (prev !== null && names.includes(prev)) return prev;
      return names[0] ?? null;
    });
    setLoadError(null);
  }, [client]);

  // Lazy by design: the tab only mounts when selected, so plugin ops never
  // hit the wire until the user opens 插件 (the pre-open wire stays clean).
  useEffect(() => {
    let cancelled = false;
    setPending("load");
    fetchBoth()
      .catch((e: unknown) => {
        if (cancelled) return;
        if (isUnsupported(e)) setUnsupported(true);
        else setLoadError(errText(e));
      })
      .finally(() => {
        if (!cancelled) setPending(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchBoth]);

  /** One mutation's shape: pending key on, the op, its receipt lines, then
   *  the refresh round under the SAME key (no gap where buttons re-enable
   *  mid-refresh). Failures land in the receipts area — never silent. */
  const run = (key: string, body: () => Promise<void>): void => {
    setPending(key);
    body()
      .catch((e: unknown) => notify(warnText(errText(e))))
      .finally(() => setPending(null));
  };

  const addMarket = (): void => {
    const source = sourceDraft.trim();
    if (source === "") return;
    run("add", async () => {
      const info = await client.pluginMarketAdd(source);
      setSourceDraft(""); // the source never lingers after a successful add
      notify(`已添加市场 ${info.name}(${info.source})`);
      await fetchBoth();
    });
  };

  /** guided-install：spec 直装流（本地路径 / GitHub 简写 / git URL）。
   *  三态：输入 → 预览卡（inspect 面）→ 安装。preview/install 共用 run()
   *  的 pending 键；零资产/克隆失败的人话错误走 notify 警告形。 */
  const [specDraft, setSpecDraft] = useState("");
  const [specPreview, setSpecPreview] = useState<PluginSpecInstallResult | null>(null);

  const previewSpec = (): void => {
    const spec = specDraft.trim();
    if (spec === "") return;
    run(`spec-preview`, async () => {
      const r = await client.pluginInstallSpec(spec, true);
      setSpecPreview(r);
      notify(r.preview ? `预览 ${spec}:${r.name ?? "未知名称"}(${detailText(r.detail)})` : "服务器未走预览路径——未安装");
    });
  };

  const installSpec = (): void => {
    const spec = specDraft.trim();
    if (spec === "") return;
    run(`spec-install`, async () => {
      const r = await client.pluginInstallSpec(spec, false);
      setSpecPreview(null);
      setSpecDraft("");
      notify(`已安装 ${r.name ?? spec} → ${r.dir ?? ""}(${detailText(r.detail)})${rescanText(r.rescan)}`);
      for (const w of r.warnings) notify(warnText(w));
      await fetchBoth();
    });
  };

  const updateMarket = (name: string): void => {
    run(`update:${name}`, async () => {
      const info = await client.pluginMarketUpdate(name);
      notify(`市场 ${info.name} 已更新(${info.source})`);
      await fetchBoth();
    });
  };

  const removeMarket = (name: string): void => {
    run(`remove:${name}`, async () => {
      const r = await client.pluginMarketRemove(name);
      notify(`已移除市场 ${name}${r.removedPlugins.length > 0 ? `——连带卸载:${r.removedPlugins.join("、")}` : ""}${rescanText(r.rescan)}`);
      for (const w of r.warnings) notify(warnText(w));
      await fetchBoth();
    });
  };

  const install = (name: string, market: string): void => {
    run(`install:${name}@${market}`, async () => {
      const r = await client.pluginInstall(name, market, scope);
      notify(`已安装 ${name}@${market} → ${r.dir}(${detailText(r.detail)})${rescanText(r.rescan)}`);
      for (const w of r.warnings) notify(warnText(w));
      await fetchBoth();
    });
  };

  const toggle = (row: InstalledPluginRowWire): void => {
    const id = row.id;
    run(`toggle:${id}`, async () => {
      const r = row.enabled ? await client.pluginDisable(id) : await client.pluginEnable(id);
      notify(`${r.enabled ? "已启用" : "已停用"} ${r.id}${rescanText(r.rescan)}`);
      await fetchBoth();
    });
  };

  const uninstall = (id: string): void => {
    run(`uninstall:${id}`, async () => {
      const r = await client.pluginUninstall(id);
      notify(`已卸载 ${r.id}${rescanText(r.rescan)}`);
      for (const w of r.warnings) notify(warnText(w));
      await fetchBoth();
    });
  };

  if (unsupported) {
    return (
      <div className="settings-section" data-plugin-unsupported>
        <div className="section-title">插件</div>
        <div className="hint">此 wudao 服务器不支持插件管理——升级 wudao 后可用</div>
      </div>
    );
  }

  const marketRows = markets ?? [];
  const discover = marketRows.find((m) => m.name === selected) ?? null;

  return (
    <div className="plugin-tab" data-plugin-tab>
      {/* ω99-236: the「内置」section — FIRST (builtins before marketplace
          stuff, the CC plugins-panel reading order): the doc trio row with
          its opt-out toggle. Absent key = default ON (`?? true` — old
          server degrade, the memoryEnabled 缺省门语义). */}
      <div className="settings-section" data-doc-suite-section>
        <div className="section-title">内置</div>
        {/* 120 弧「选择语言」：偏好行 .setrow + .wudao-switch（与偏好页同族）。 */}
        <label className="setrow">
          <span className="setrow-main">
            <span className="setrow-title">文档三件套</span>
            <span className="setrow-note">用自然语言创建和编辑 Excel、Word、PPT 文件（关闭后新会话生效）</span>
          </span>
          <input
            type="checkbox"
            className="wudao-switch"
            data-doc-suite-toggle
            checked={settings?.settings.docSuiteEnabled ?? true}
            disabled={docSuitePending}
            onChange={(e) => setDocSuite(e.target.checked)}
          />
        </label>
      </div>
      {/* guided-install 弧：spec 直装——本地路径 / GitHub 简写 / git URL。
          先预览（名称·格式·将映射计数）再安装；零资产纯代码包装前被引擎
          拒（人话错误直达这里）。 */}
      <div className="settings-section" data-plugin-spec-install>
        <div className="section-title">从来源安装</div>
        <div className="hint">{"直接安装一个插件包:本地目录(./dir)、GitHub 简写(owner/repo)、git URL(#ref 可选)——纯代码包(无可映射的技能/命令)会被拒绝"}</div>
        <div className="keyrow">
          <input
            type="text"
            className="wudao-input plugin-spec-input"
            placeholder="插件来源(./本地目录、owner/repo 或 git URL)"
            aria-label="插件来源"
            value={specDraft}
            onChange={(e) => { setSpecDraft(e.target.value); setSpecPreview(null); }}
          />
          <button type="button" className="wudao" disabled={specDraft.trim() === "" || busy} onClick={previewSpec}>
            预览
          </button>
        </div>
        {specPreview !== null ? (
          <div className="market-row" data-plugin-spec-preview>
            <span className="market-name">
              {specPreview.name ?? "未知名称"}
              {specPreview.format !== undefined ? ` · ${specPreview.format === "ccb-family" ? "上游包格式" : "claude-plugin"}` : ""}
            </span>
            <span className="hint">{`将映射:${detailText(specPreview.detail)}`}</span>
            <span className="keyrow">
              <button type="button" className="wudao" disabled={busy} onClick={installSpec}>
                安装
              </button>
              <button type="button" className="wudao" disabled={busy} onClick={() => setSpecPreview(null)}>
                取消
              </button>
            </span>
          </div>
        ) : null}
      </div>
      <div className="settings-section">
        <div className="section-title">市场</div>
        <div className="hint">
          {"添加 CC 生态市场源:owner/repo · git URL(#ref)· 本地目录 · marketplace.json 路径——添加即克隆/复制到本机,不执行任何代码"}
        </div>
        <div className="keyrow">
          <input
            type="text"
            className="wudao-input market-source-input"
            placeholder="市场源(owner/repo、git URL、本地目录或 marketplace.json 路径)"
            aria-label="市场源"
            value={sourceDraft}
            onChange={(e) => setSourceDraft(e.target.value)}
          />
          <button type="button" className="wudao" disabled={sourceDraft.trim() === "" || busy} onClick={addMarket}>
            添加市场
          </button>
        </div>
        {pending !== null ? <div className="plugin-pending">处理中…</div> : null}
        {markets === null && loadError === null ? <div className="muted">读取中…</div> : null}
        {loadError !== null ? <div className="entry-error">{`无法读取插件列表:${loadError}`}</div> : null}
        {markets !== null && marketRows.length === 0 ? (
          <div className="hint">尚未添加市场——在上方粘贴源添加(如 superpowers-market 或本地目录)</div>
        ) : null}
        <div className="market-list">
          {marketRows.map((m) => (
            <div key={m.name} className="market-row" data-market={m.name}>
              <button
                type="button"
                className="wudao market-name"
                data-market-select={m.name}
                aria-pressed={selected === m.name}
                disabled={busy}
                title="在下方发现列表查看该市场的插件"
                onClick={() => setSelected(m.name)}
              >
                {m.name}
                {selected === m.name ? " ←" : ""}
              </button>
              <span className="meta">{`${m.plugins.length} 个插件`}</span>
              {m.description !== undefined ? <span className="meta">{m.description}</span> : null}
              <span className="market-source">{m.source}</span>
              <button type="button" className="wudao" disabled={busy} onClick={() => updateMarket(m.name)}>
                更新
              </button>
              <button type="button" className="wudao danger" disabled={busy} onClick={() => removeMarket(m.name)}>
                移除
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <div className="section-title">{`发现${discover !== null ? ` —— ${discover.name}` : ""}`}</div>
        <div className="prefrow">
          <span className="pref-label">安装作用域:</span>
          <button
            type="button"
            data-scope="user"
            className={`wudao${scope === "user" ? " primary" : ""}`}
            disabled={busy}
            onClick={() => setScope("user")}
          >
            用户(本机)
          </button>
          <button
            type="button"
            data-scope="project"
            className={`wudao${scope === "project" ? " primary" : ""}`}
            disabled={busy}
            onClick={() => setScope("project")}
          >
            项目(本工作区)
          </button>
        </div>
        <div className="hint">{"user = ~/.wudao/plugins(所有会话可用)· project = <工作区>/.wudao/plugins(仅本项目)"}</div>
        {discover === null ? (
          <div className="hint">选择一个市场后,这里列出它的插件(名称/描述/版本/「将安装」明细)</div>
        ) : discover.plugins.length === 0 ? (
          <div className="hint">{"该市场没有可列出的插件——若目录被手动改动,试一次「更新」"}</div>
        ) : (
          <div className="plugin-list">
            {discover.plugins.map((p) => (
              <div key={p.name} className="plugin-entry" data-plugin={p.name}>
                <div className="plugin-head">
                  <span className="plugin-name">{p.name}</span>
                  {p.version !== undefined ? <span className="meta">{p.version}</span> : null}
                </div>
                {p.description !== undefined ? <div className="plugin-desc">{p.description}</div> : null}
                <div className="plugin-detail">{`将安装:${detailText(p.detail)}`}</div>
                <div className="plugin-actions">
                  <button
                    type="button"
                    className="wudao"
                    data-install={`${p.name}@${discover.name}`}
                    disabled={busy}
                    onClick={() => install(p.name, discover.name)}
                  >
                    安装
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="section-title">已装插件</div>
        {installed === null ? (
          <div className="muted">读取中…</div>
        ) : installed.length === 0 ? (
          <div className="hint">尚未安装插件——在上方发现列表选择插件安装</div>
        ) : (
          SCOPE_GROUPS.filter((g) => installed.some((row) => row.scope === g.scope)).map((g) => (
            <div key={g.scope} className="installed-group" data-scope={g.scope}>
              <div className="group-title">{g.title}</div>
              {installed
                .filter((row) => row.scope === g.scope)
                .map((row) => (
                  <div key={row.id} className="installed-row" data-plugin-id={row.id}>
                    <span className="plugin-name">{row.name}</span>
                    <span className="meta">{row.market}</span>
                    {row.version !== undefined ? <span className="meta">{row.version}</span> : null}
                    <span className={`meta state ${row.enabled ? "on" : "off"}`}>{row.enabled ? "已启用" : "已停用"}</span>
                    {row.scope === "adhoc" ? null : (
                      <>
                        <button type="button" className="wudao" disabled={busy} onClick={() => toggle(row)}>
                          {row.enabled ? "停用" : "启用"}
                        </button>
                        <button type="button" className="wudao danger" disabled={busy} onClick={() => uninstall(row.id)}>
                          卸载
                        </button>
                      </>
                    )}
                  </div>
                ))}
            </div>
          ))
        )}
        <div className="hint">{"安装/启停/卸载后热重扫立即生效;停用保留安装记录(随时再启用),卸载删除目录"}</div>
      </div>
    </div>
  );
}
