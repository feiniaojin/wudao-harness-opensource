// PermissionsTab — settings-split T2: the settings page's 权限档 tab, the
// M63 §B three-shield section moved byte-equivalent out of SettingsPage
// (spec §3; the 5-tab split's T4 wires it in beside PluginTab).
// 0.3.11（用户反馈：权限档两入口 1:1 联动）——本 tab 不再镜像实时档:
//
//   权限档       the ShieldSelector chip (ask/workspace/auto — research
//   (新会话默认)  35 #4; the risky tier keeps its two-step confirm gate) now
//                binds the PERSISTED default (settings.permissionsDefaultMode,
//                null → "workspace"); onChange writes
//                settingsSet("permissions.defaultMode") — the next session's
//                starting tier. The live tier stays on the input-side chip /
//                shift+tab; this tab only NAMES it (read-only line below).
//
// Receipts ride the page-level notify the shell passes down — success and
// the ⚠️ failure line both surface there (no async op fails silently).
import { useEffect, useState } from "react";
import type { DriverStatus, WudaoClient } from "../protocol.js";
import { modeLabel } from "../protocol.js";
import { ShieldSelector, shieldValueOf } from "./ShieldSelector.js";
import type { ShieldMode } from "./ShieldSelector.js";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function PermissionsTab({
  client,
  notify,
  status,
}: {
  client: WudaoClient;
  /** The settings page's receipts area (the defaultMode receipt and its
   *  failure line both ride it). */
  notify: (text: string) => void;
  status: DriverStatus | null;
}): React.JSX.Element {
  // 0.3.11: the PERSISTED default (never the live status.mode — the two
  // entrances have distinct semantics now). null/absent/failed read →
  // "workspace" (what a never-written key boots at since 0.3.12); the write
  // path updates local state so the chip lands immediately.
  const [defaultMode, setDefaultMode] = useState<ShieldMode>("workspace");
  useEffect(() => {
    let alive = true;
    client
      .settingsStatus()
      .then((s) => {
        if (alive && s.settings.permissionsDefaultMode) setDefaultMode(s.settings.permissionsDefaultMode);
      })
      .catch(() => {/* the chip stays at the safest tier; the write path surfaces errors */});
    return () => {
      alive = false;
    };
  }, [client]);

  const onShield = (mode: ShieldMode): void => {
    client
      .settingsSet("permissions.defaultMode", mode)
      .then(() => {
        setDefaultMode(mode);
        notify(`新会话默认权限档 → ${mode}(已持久化;本会话仍为 ${modeLabel(status?.mode ?? "workspace")})`);
      })
      .catch((e: unknown) => notify(`⚠️ 设置默认权限档失败：${errText(e)}`)); // ω99-204: #8
  };

  return (
    <div className="settings-section set-sec">
      <h3 className="section-title set-title">权限档(新会话默认)</h3>
      <ShieldSelector value={shieldValueOf(defaultMode)} onChange={onShield} direction="down" />
      <div className="hint">新会话以此档起步(CLI 旗标优先);当前会话档 = {modeLabel(status?.mode ?? "workspace")},由输入框旁的档位 chip / shift+tab 实时切换</div>
    </div>
  );
}
