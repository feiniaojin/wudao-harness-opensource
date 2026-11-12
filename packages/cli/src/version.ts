// Single source of truth for the CLI version. Lives in its own module so both
// index.ts (banner) and repl.ts (REPL header) can import it without an
// index.ts <-> repl.ts import cycle.
export const VERSION = "0.5.10"; // ω99-166e-i 走查发现：0.3.51 戳漏第 9 处（nokey-interactive-fallback 钉 package.json 一致性）。2026-09-13 全量揭发：0.3.81/0.3.82 两版发版漏戳此位（聚焦测试跑不出），补齐。2026-09-14 0.3.91 gate 再揭发：0.3.88/0.3.89/0.3.90 三版连漏（聚焦发版跑不出 --version 面）——发版仪式第九版本位自此必查。

// Turn budget: a runaway FUSE, not the normal stop condition (M23). Long
// tasks are stopped by the todo/verify gates; the fuse only caps runaway
// loops. Default 200 from the longTask settings; WUDAO_MAX_TURNS overrides
// (0 = unlimited).
export function maxTurns(fuse = 200): number {
  const raw = process.env.WUDAO_MAX_TURNS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? Infinity : Math.floor(n);
  }
  return fuse;
}

// Turn slicing (弧 C) default — how many budget-window resets ONE run may take
// before the fuse finally ends it. Unlimited is the product intent (ユーザー令
// 2026-11-05「希望可以无限跑下去，可以无限重置而不会退出」): hitting maxTurns resets
// the window instead of killing the run, and the run still ends on its own
// terms (model end_turn, user abort/steer, or an exhausted wall/token budget).
// `WUDAO_MAX_SLICES` overrides (0 = no slicing at all, i.e. the pre-ω-long-2
// "maxTurns is a death date" behavior).
//
// Why this lives in the CLI and not in the driver: the driver is a library —
// a caller that says nothing gets the conservative behavior, never an
// unbounded loop. The product decides what the product does, and every
// interactive frontend (REPL, TUI, web/pet) resolves its default HERE so they
// cannot drift apart again.
export function defaultMaxSlices(fallback = Number.POSITIVE_INFINITY): number {
  const raw = process.env.WUDAO_MAX_SLICES;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? 0 : Math.floor(n);
  }
  return fallback;
}
