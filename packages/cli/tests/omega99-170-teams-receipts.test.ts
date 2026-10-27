// ω99-170 — teams 面板与回执中文化：源接线钉（readFileSync 直读源，
// 166/169 系范式）。三组：teams-panel.tsx（4 面 TUI 面）/ teams/runtime.ts
// （6 面 notify 回执）/ teams/panel.ts（1 面 plan-pending 状态徽记）。
// 插值/${} 结构逐字保留；负钉落笔前已 grep 注释层+活码层复核：裸
// `teammate ${` 命中域外活码（runtime :227 模型向 subagent description、
// :342 spawn 回执 line、:366 run-failed line——均非本弧面），按 brief §三
// 预案收窄为 `teammate ${t.name} idle` / `teammate ${t.name} continuing`
// 两条窄负钉，此处披露。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const panelSrc = readFileSync(new URL("../src/tui/teams-panel.tsx", import.meta.url), "utf8") as string;
const runtimeSrc = readFileSync(new URL("../src/teams/runtime.ts", import.meta.url), "utf8") as string;
const viewSrc = readFileSync(new URL("../src/teams/panel.ts", import.meta.url), "utf8") as string;

describe("ω99-170 A — teams-panel.tsx 面板四面中文化", () => {
  it("骨架行/折叠行/待批行/草稿行为中文（正钉）", () => {
    expect(panelSrc).toContain("团队 {props.team.team} ——");
    expect(panelSrc).toContain("… 还有 {r.hidden} 项");
    expect(panelSrc).toContain("📋 待批方案：");
    expect(panelSrc).toContain("发给 {draftFor}：");
  });

  it("旧英文面归零（负钉）", () => {
    expect(panelSrc).not.toContain("↑↓ select");
    expect(panelSrc).not.toContain("pending plans: ");
    expect(panelSrc).not.toContain("more…");
  });
});

describe("ω99-170 B — teams/runtime.ts notify 回执六面中文化", () => {
  it("空闲/续跑/提交方案/评审拦截/批准/拒绝回执为中文（正钉）", () => {
    expect(runtimeSrc).toContain("队友 ${t.name} 空闲");
    expect(runtimeSrc).toContain("队友 ${t.name} 继续");
    expect(runtimeSrc).toContain("提交了方案");
    expect(runtimeSrc).toContain("被评审拦截");
    expect(runtimeSrc).toContain("方案已批准");
    expect(runtimeSrc).toContain("方案已拒绝");
  });

  it("旧英文回执归零（负钉；裸 teammate ${ 命中域外活码 :227/:342/:366，故收窄披露）", () => {
    expect(runtimeSrc).not.toContain("teammate ${t.name} idle");
    expect(runtimeSrc).not.toContain("teammate ${t.name} continuing");
    expect(runtimeSrc).not.toContain("submitted a plan");
    expect(runtimeSrc).not.toContain("plan approved for");
    expect(runtimeSrc).not.toContain("plan rejected for");
  });
});

describe("ω99-170 C — teams/panel.ts plan-pending 徽记中文化", () => {
  it("徽记为中文（码元形正钉；⚙/· 符号原样）", () => {
    expect(viewSrc).toContain('"📋 方案"');
  });

  it("旧徽记归零（负钉）", () => {
    expect(viewSrc).not.toContain('"📋 plan"');
  });
});
