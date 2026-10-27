// ω99-181 receipts — the /agents command's Chinese output faces: the
// roleSummary pin/scope bits (A 组), the report skeleton (B 组), and the
// shadowing receipts (C 组). Mirrors the m55b runAgentsCommand fixture
// shape (temp ws + .wudao/agents JSON + pluginAgents). The m55b:883
// constraint pin — the ` · N plugin · N global · N workspace` counting
// string — must survive byte-for-byte; B 组 re-asserts it against the
// translated header. Token ruling: tier words (builtin/plugin/global/
// workspace), field names (worktree/allowShell/maxTurns/model), the
// layering chain, ` · ` / ` — ` separators, and the `←` arrow stay ASCII.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_ROLES } from "@wudao/core";
import type { AgentRoleProfile, RosterPluginAgent } from "@wudao/core";
import { roleSummary, runAgentsCommand } from "../src/commands/agents-roster.js";

let ws: string;
beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), "roster181-")); });
afterEach(async () => { await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

async function writeAgent(name: string, body: Record<string, unknown>): Promise<void> {
  await mkdir(join(ws, ".wudao", "agents"), { recursive: true });
  await writeFile(join(ws, ".wudao", "agents", `${name}.json`), JSON.stringify(body), "utf8");
}

const PLUGINNER: RosterPluginAgent = {
  profile: { id: "pluginner", description: "from a plugin" },
  source: "plugin demo: agents/pluginner.md",
};

describe("ω99-181 A 组 roleSummary", () => {
  it("#1/#2 冻结+写入范围复合行", () => {
    const s = roleSummary({
      id: "scoper",
      description: "d",
      frozen: true,
      writeScope: { roots: ["src/lib", "src/app"], exactFiles: ["pkg.json"] },
    } satisfies AgentRoleProfile);
    expect(s).toContain("已冻结（拒绝覆盖）");
    expect(s).toContain("写入：2 个根+1 个精确文件");
    expect(s).not.toContain("pinned");
    expect(s).not.toContain("root(s)");
  });

  it("#3 未限定写入", () => {
    expect(roleSummary({ id: "free", description: "d" } satisfies AgentRoleProfile)).toContain("写入：（未限定）");
  });

  it("#4 toolNames 有/无双态", () => {
    expect(roleSummary({ id: "a", description: "d", toolNames: ["read_file", "glob"] } satisfies AgentRoleProfile))
      .toContain("2 个工具");
    expect(roleSummary({ id: "b", description: "d" } satisfies AgentRoleProfile)).toContain("默认工具集");
  });

  it("字段 token 在场（worktree/allowShell/maxTurns 混合行零触）", () => {
    const s = roleSummary({
      id: "c",
      description: "d",
      frozen: true,
      worktree: true,
      allowShell: true,
      maxTurns: 7,
    } satisfies AgentRoleProfile);
    expect(s).toContain("已冻结（拒绝覆盖）");
    expect(s).toContain("worktree");
    expect(s).toContain("allowShell");
    expect(s).toContain("maxTurns 7");
    expect(s).toContain("写入：（未限定）");
    expect(s).toContain("默认工具集");
  });
});

describe("ω99-181 B 组 报告骨架", () => {
  it("#5/#6 表头整行：前导+counting 串原样+尾注", async () => {
    await writeAgent("scoper", {
      description: "scoped worker",
      frozen: true,
      writeScope: { roots: ["src/lib"], exactFiles: ["pkg.json"] },
      worktree: true,
    });
    const report = await runAgentsCommand({ workspaceRoot: ws, pluginAgents: [PLUGINNER] });
    const header = report.split("\n")[0] ?? "";
    expect(header).toBe(
      `agents 花名册——${Object.keys(BUILTIN_ROLES).length} builtin · 1 plugin · 0 global · 1 workspace（分层 builtin < plugin < global < workspace；经 task 工具派发）`,
    );
    // 约束钉 m55b:883 同款：中段 counting 串逐字节。
    expect(report).toMatch(/builtin · 1 plugin · 0 global · 1 workspace/);
  });

  it("#7 空 section：（无）", async () => {
    const report = await runAgentsCommand({ workspaceRoot: ws });
    expect(report).toContain("plugin：（无）");
    expect(report).toContain("global：（无）");
    expect(report).toContain("workspace：（无）");
  });

  it("#8 section 头全角冒号", async () => {
    await writeAgent("scoper", { description: "scoped worker" });
    const lines = (await runAgentsCommand({ workspaceRoot: ws })).split("\n");
    expect(lines).toContain("builtin：");
    expect(lines).toContain("workspace：");
    expect(lines).not.toContain("builtin:");
  });
});

describe("ω99-181 C 组 遮蔽回执", () => {
  beforeEach(async () => {
    await writeAgent("coder", { description: "workspace coder override", systemPrompt: "W-CODER" });
    await writeAgent("manager", { description: "workspace manager override" });
  });

  it("#9 displaced 行", async () => {
    const report = await runAgentsCommand({ workspaceRoot: ws });
    expect(report).toContain("    (被取代：.wudao/agents/coder.json)");
    expect(report).toContain("    (被取代：.wudao/agents/manager.json)");
  });

  it("#10 遮蔽回执聚合行：← 箭头+全角分号 join", async () => {
    const report = await runAgentsCommand({ workspaceRoot: ws });
    // readdir 顺序不保证 → 两种排列都接受，join 分号必须是全角 `；`。
    expect(report).toMatch(
      /遮蔽回执：(coder ← \.wudao\/agents\/coder\.json；manager ← \.wudao\/agents\/manager\.json|manager ← \.wudao\/agents\/manager\.json；coder ← \.wudao\/agents\/coder\.json)/,
    );
  });

  it("#11 尾行", async () => {
    const report = await runAgentsCommand({ workspaceRoot: ws });
    expect(report).toContain('  ("/agents" 只列清单；派发走 task 工具——冻结角色 fail-closed 拒绝模型覆盖)');
  });
});
