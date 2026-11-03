// icons.tsx — M79-polish §1: clean SVG icon set replacing emoji glyphs.
// Stroke-based (lucide-style), 16px default, currentColor so they inherit
// the surrounding text color token. Zero dependencies.
import React from "react";

// 用户 2026-08-22: 应用内图标整体缩小 10% — one scale point for every glyph
// (default and explicit call-site tiers alike); remove to restore 16px.
const ICON_SCALE = 0.9;

const base = (props: { size?: number; className?: string }): React.SVGProps<SVGSVGElement> => ({
  width: (props.size ?? 16) * ICON_SCALE,
  height: (props.size ?? 16) * ICON_SCALE,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  // ui-review-r1 P5: every glyph is decorative by default — callers put the
  // accessible name on the BUTTON (aria-label) when the icon is its content.
  "aria-hidden": true,
  ...(props.className !== undefined ? { className: props.className } : {}),
});

export function IconFolder(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function IconFolderOpen(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 17l2-6h16l-2 6" opacity="0.5" />
    </svg>
  );
}

export function IconFile(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function IconFileText(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

export function IconChevronRight(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function IconChevronDown(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function IconPlus(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconChart(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 20h18" />
      <path d="M4 16l5-6 4 3 7-9" />
    </svg>
  );
}

export function IconRefresh(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function IconClose(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function IconSettings(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      {/* 品牌弧补丁（用户令「小太阳像亮度，应该用齿轮」）——feather settings
          齿轮：中心圆+齿圈路径，替换原放射线太阳形。 */}
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function IconTheme(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ui-review-r1 P3: the remaining emoji glyphs' counterparts — session list,
// paperclip, hamburger menu (same stroke convention, zero dependencies).
export function IconSessions(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  );
}

export function IconPaperclip(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48" />
    </svg>
  );
}

export function IconMenu(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

// inkline Task 3 (spec §1.5) — the second wave: the sidebar search /
// composer send / permission trio / status glyphs later tasks consume
// (IconSearch, IconArrowUp: Task 8/7; IconSlash, IconShield: Task 7;
// IconCheck, IconSpinner: Tasks 5/11). Same base() convention — lucide
// 24-grid paths hand-written, zero dependencies.
export function IconSearch(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5 21 21" />
    </svg>
  );
}
export function IconArrowUp(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  );
}
export function IconSlash(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M5 19 19 5" />
      <circle cx="12" cy="12" r="9.5" />
    </svg>
  );
}
export function IconShield(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 2.5 4.5 5.5v6c0 4.5 3 7.5 7.5 9 4.5-1.5 7.5-4.5 7.5-9v-6z" />
    </svg>
  );
}
export function IconCheck(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4.5 12.5 9.5 17.5 19.5 7" />
    </svg>
  );
}
export function IconSpinner(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}
/** The 推理强度 chip's glyph (lucide zap) — the composer-chips arc's
 *  effort switcher. */
export function IconBolt(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
    </svg>
  );
}
/** 2026-08-26 §3.3 — 审查专注: a panel-left glyph (the viewer-hogging
 * geometry the toggle enters). Static — the button's aria-pressed carries
 * the on/off state, the glyph never swaps. */
export function IconPanelLeft(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 4.5h16v15H4z" />
      <path d="M9.5 4.5v15" />
    </svg>
  );
}

/** The 语言 chip's glyph (lucide globe) — the language switcher's double
 *  knob: 回答/思考. */
export function IconGlobe(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14.5 14.5 0 0 1 0 18a14.5 14.5 0 0 1 0-18z" />
    </svg>
  );
}
/** ω99-299 (M4): the session-delete row button's glyph — the last emoji
 *  face on an interactive control (🗑 retired; chrome = SVG, content =
 *  text is the family line). */
export function IconTrash(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}
/** ω99-299 (M4): the sidebar row's hover-rename glyph (✎ retired to the
 *  same SVG family). */
export function IconPencil(props: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
