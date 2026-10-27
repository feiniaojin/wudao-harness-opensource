// Single source of truth for the CLI version. Lives in its own module so both
// index.ts (banner) and repl.ts (REPL header) can import it without an
// index.ts <-> repl.ts import cycle.
export const VERSION = "0.4.14"; // ω99-166e-i 走查发现：0.3.51 戳漏第 9 处（nokey-interactive-fallback 钉 package.json 一致性）。2026-09-13 全量揭发：0.3.81/0.3.82 两版发版漏戳此位（聚焦测试跑不出），补齐。2026-09-14 0.3.91 gate 再揭发：0.3.88/0.3.89/0.3.90 三版连漏（聚焦发版跑不出 --version 面）——发版仪式第九版本位自此必查。

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
