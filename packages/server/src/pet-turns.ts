// 拆分运动（借鉴弧 δ 顺带件，file-size 棘轮）：server/index.ts 的 pet 历史
// 纯函数外提（ω99-271/272 的全保真折叠——逐字节搬家，行为零变化；index.ts
// re-export 维持既有公共面，tests 的导入路径不动）。
import type { PetHistoryTurnWire } from "./ports.js";

export function petTurnsFromHistory(
  entries: readonly { kind: string; text?: string }[],
): PetHistoryTurnWire[] {
  const rounds: { q: string; parts: string[]; error?: string }[] = [];
  for (const e of entries) {
    if (e.kind === "user") {
      rounds.push({ q: typeof e.text === "string" ? e.text : "", parts: [] });
      continue;
    }
    const last = rounds[rounds.length - 1];
    if (last === undefined) continue; // dangling — no leading user turn
    if (e.kind === "assistant" && typeof e.text === "string" && e.text !== "") {
      last.parts.push(e.text);
    } else if (
      e.kind === "error" && last.parts.length === 0
      && typeof e.text === "string" && e.text !== "" && last.error === undefined
    ) {
      last.error = e.text;
    }
  }
  return rounds.map((r) => ({
    q: r.q,
    a: r.parts.length > 0 ? r.parts.join("\n\n") : (r.error ?? ""),
  }));
}
