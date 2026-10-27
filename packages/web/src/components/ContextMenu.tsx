// M76-ux2 §6 — the reusable right-click menu overlay. Self-drawn by design:
// the browser's native menu and Tauri's differ (and neither takes an items
// array), so the surface is a fixed-position div at the pointer's viewport
// coordinates — the ws-menu's scrim pattern generalized: a transparent fixed
// backdrop catches click-outside, a window keydown catches Esc, and an item
// click closes FIRST then dispatches (the owner unmounts the overlay, so the
// action must never depend on the menu still being mounted). Position is
// `fixed`, not `absolute`: the contextmenu event's clientX/Y are viewport
// coordinates, and no panel in this shell carries a transform that would
// re-anchor them.
import React, { useEffect } from "react";
import { useFocusReturn } from "../use-focus-return.js";

/** One menu row. `onSelect` runs AFTER onClose — keep actions self-contained.
 *  `kbd` (墨线 T14) is the optional shortcut hint, right-aligned mono. */
export interface ContextMenuItem {
  readonly label: string;
  readonly kbd?: string;
  onSelect(): void;
}

/** Copy text through the async clipboard API, never surfacing a rejection
 *  (a non-secure context or a denied permission degrades to a no-op — the
 *  menu item's promise stays fire-and-forget by contract, not by accident). */
export function copyToClipboard(text: string): void {
  try {
    const p = navigator.clipboard?.writeText(text);
    if (p !== undefined) void p.catch(() => {});
  } catch {
    /* clipboard unavailable (older jsdom/embedded webviews) — nothing to do */
  }
}

export function ContextMenu({ x, y, items, onClose }: {
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  readonly onClose: () => void;
}): React.JSX.Element {
  // ui-review-r1 I1: a pointer-opened menu manages no focus of its own, but
  // its close must still return focus to the trigger (a row, a message).
  useFocusReturn();
  // Esc closes — on window, so focus sitting anywhere (the tree, the
  // composer) still dismisses the overlay.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Click-away surface: transparent, fixed, UNDER the menu. */}
      <div className="ctx-backdrop" onClick={onClose} />
      {/* 墨线 T14: the surface rides the shared .menu family (.ctx keeps the
          pointer anchoring + the z-ladder slot — see the T14 CSS section).
          fix round 2 (M2): the anchor rides --ctx-x/--ctx-y custom props so
          the sheet can CLAMP each axis into the viewport (a bottom-edge
          click no longer probes past the window bottom). */}
      <div
        className="menu ctx"
        role="menu"
        style={{ "--ctx-x": `${x}px`, "--ctx-y": `${y}px` } as React.CSSProperties}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              onClose(); // first: the owner unmounts the overlay…
              item.onSelect(); // …then the action, never the reverse
            }}
          >
            {item.label}
            {item.kbd !== undefined ? <span className="menu-kbd">{item.kbd}</span> : null}
          </button>
        ))}
      </div>
    </>
  );
}
