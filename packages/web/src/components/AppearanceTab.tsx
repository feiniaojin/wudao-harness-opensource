// AppearanceTab — settings-split T2: the settings page's 外观 tab, the
// M64-visual §4 appearance section moved byte-equivalent out of SettingsPage
// (spec §3; the 5-tab split's T4 wires it in beside PluginTab):
//
//   外观     theme (浅色/暗色) + accent (墨黑/蓝/绿, spec §1: 绿为出厂默认)
//           pickers that apply to the OPEN interface immediately (the same
//           channel the ◐ topbar toggle rides) and persist through the
//           ui.theme/ui.accent settingsSet lane; a failed write reverts the
//           applied value. A local accent pick reports back through
//           onAccentPicked (ui-review-r4 I2) so the App arms its
//           accentTouched guard.
//
// The chip highlight stays DERIVED AT RENDER from the live documentElement
// (M64-visual §5) — never a useState captured at mount. Receipts ride the
// page-level notify the shell passes down.
import { useState } from "react";
import type { WudaoClient } from "../protocol.js";
import { applyAccent, applyTheme, readAccent, readTheme, type AccentName, type ThemeName } from "../theme.js";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function AppearanceTab({
  client,
  notify,
  onAccentPicked,
}: {
  client: WudaoClient;
  /** The settings page's receipts area (the pick receipts and the ⚠️
   *  revert lines both ride it). */
  notify: (text: string) => void;
  /** ui-review-r4 I2: a LOCAL accent pick reports back so the App arms its
   *  accentTouched guard — a stale settingsStatus reply already on the wire
   *  must not stomp the pick (themeTouched's twin; the reply stays the
   *  source of truth until the user clicks first). */
  onAccentPicked?: () => void;
}): React.JSX.Element {
  const [pending, setPending] = useState<string | null>(null);
  // M64-visual §5: the 外观 pickers' selection — DERIVED AT RENDER from the
  // live documentElement state, not useState captured at mount (the Task-4
  // review ledger): a ◐ flip while this page is open re-renders through
  // App's notify and the chip highlight tracks the DOM, never going stale.
  // Writes keep working — pickTheme/pickAccent applyTheme first, then the
  // setPending state change re-renders and re-derives.
  const themePick = readTheme();
  const accentPick = readAccent();

  // M64-visual §4: the 外观 pickers — apply live, persist through the
  // ui.theme/ui.accent allowlist; a failed write reverts the applied value
  // (the ◐ toggle's pattern). Unlike the 偏好 tab's next-session writes,
  // these take effect NOW.
  const pickTheme = (t: ThemeName): void => {
    const prev = readTheme();
    applyTheme(t);
    setPending("set:ui.theme");
    client
      .settingsSet("ui.theme", t)
      .then(() => notify(`主题 → ${t === "dark" ? "暗色" : "浅色"} —— 已保存`))
      .catch((e: unknown) => {
        applyTheme(prev);
        notify(`⚠️ 主题未保存：${errText(e)}`); // ω99-204: #7
      })
      .finally(() => setPending(null));
  };

  const pickAccent = (a: AccentName): void => {
    const prev = readAccent();
    applyAccent(a);
    onAccentPicked?.(); // ui-review-r4 I2: the click owns the session from here
    setPending("set:ui.accent");
    client
      .settingsSet("ui.accent", a)
      .then(() => notify(`主色 → ${a === "black" ? "墨黑" : a === "blue" ? "蓝" : "绿"} —— 已保存`))
      .catch((e: unknown) => {
        applyAccent(prev);
        notify(`⚠️ 主色未保存：${errText(e)}`);
      })
      .finally(() => setPending(null));
  };

  return (
    <>
      {/* M64-visual §4: the appearance pickers — theme (浅色/暗色) + accent
          (墨黑/蓝/绿, spec §1: 绿为出厂默认). These apply to the OPEN
          interface immediately (the same channel the ◐ topbar toggle rides),
          unlike the 偏好 tab's next-session writes.
          120 弧「选择语言」：三选芯片（两态区分度太低被用户否）换成 .seg
          分段选择器——凹槽轨道+浮起药丸；主色选项带身份色 swatch 点。 */}
      <div className="settings-section set-sec">
        <h3 className="section-title set-title">外观</h3>
        <div className="setrow">
          <span className="setrow-main">
            <span className="setrow-title">主题</span>
            <span className="setrow-note">立即生效,并写入全局设置 (~/.wudao/settings.json)</span>
          </span>
          <div className="segctl" role="radiogroup" aria-label="主题">
            {(["dark", "light"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={themePick === t}
                data-appearance-theme={t}
                className={`segctl-opt${themePick === t ? " on" : ""}`}
                disabled={pending === "set:ui.theme"}
                onClick={() => pickTheme(t)}
              >
                {t === "dark" ? "暗色" : "浅色"}
              </button>
            ))}
          </div>
        </div>
        <div className="setrow">
          <span className="setrow-main">
            <span className="setrow-title">主色</span>
            <span className="setrow-note">按钮与选中态的强调色</span>
          </span>
          <div className="segctl" role="radiogroup" aria-label="主色">
            {(["black", "blue", "green"] as const).map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={accentPick === a}
                data-appearance-accent={a}
                data-swatch={a}
                className={`segctl-opt${accentPick === a ? " on" : ""}`}
                disabled={pending === "set:ui.accent"}
                onClick={() => pickAccent(a)}
              >
                <span className="segctl-dot" aria-hidden={true} />
                {a === "black" ? "墨黑" : a === "blue" ? "蓝" : "绿"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
