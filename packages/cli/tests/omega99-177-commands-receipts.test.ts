// ω99-177 — commands 域第一刀回执中文化 receipts：
//   A 组 add-dir 全文件 5 面（#1-#5）、B 组 config writer 通道 4 面（#6-#9，
//   拒因 2 直接断 error 串、回执 2 走 runConfigCommand 沙盒临时目录）、
//   C 组 settings-layer loader 拒因孪生 2 面（#10-#11，镜像
//   settings-layer.test 既有 sanitizeProjectTier fixture 形）。
// 每面钉新串的逐字节落地（插值/路径字面原样保留）。
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAddDirPath, formatAddDirNotice, formatAddedDirsList } from "../src/commands/add-dir.js";
import { runConfigCommand } from "../src/commands/config.js";
import { sanitizeProjectTier } from "../src/settings-layer.js";

const scratch: string[] = [];
function makeWs(prefix: string, withGitignore: boolean): string {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(ws, ".wudao"), { recursive: true });
  if (withGitignore) writeFileSync(join(ws, ".gitignore"), "node_modules\n", "utf8");
  scratch.push(ws);
  return ws;
}
afterAll(() => {
  for (const ws of scratch) {
    try {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  }
});

describe("ω99-177 A — /add-dir 全文件回执（5 面）", () => {
  const cwd = tmpdir();

  it("#1 空路径拒因「路径不能为空」（trim 后空串）", () => {
    const r = validateAddDirPath({ input: "   ", cwd, existingPaths: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("路径不能为空");
  });

  it("#2 不存在路径拒因「路径不存在：<原样输入>」", () => {
    const r = validateAddDirPath({ input: "/no/such/dir", cwd, existingPaths: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("路径不存在：/no/such/dir");
  });

  it("#3 重复路径拒因「路径已添加过：<原样输入>」", () => {
    const r = validateAddDirPath({ input: cwd, cwd, existingPaths: [cwd] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(`路径已添加过：${cwd}`);
  });

  it("#4 成功回执「已添加工作区目录：<abs>（共 N 个工作区目录）」——复数三元已随译删除（N=1/N=2 同形）", () => {
    expect(formatAddDirNotice({ absPath: "/w/d1", count: 1 })).toBe("已添加工作区目录：/w/d1（共 1 个工作区目录）");
    expect(formatAddDirNotice({ absPath: "/w/d2", count: 2 })).toBe("已添加工作区目录：/w/d2（共 2 个工作区目录）");
  });

  it("#5 /status 列表头「工作区目录（N 个）：」+ 列表行原样", () => {
    const list = formatAddedDirsList(["/w/d1", "/w/d2"]);
    expect(list).toContain("工作区目录（2 个）：");
    expect(list).toContain("  - /w/d1");
    expect(list).toContain("  - /w/d2");
  });
});

describe("ω99-177 B — /config set local writer 通道（4 面）", () => {
  it("#6 提权键拒因——随项目信任、请改在全局层设置", async () => {
    const ws = makeWs("wudao-o99-177-b6-", true);
    const r = await runConfigCommand({ workspaceRoot: ws, args: "set local bypassPermissions true" });
    expect(r).toContain('⚠️ "bypassPermissions" 是提权键——settings.local.json 随项目信任；请改在全局层 settings.json 设置');
    expect(existsSync(join(ws, ".wudao", "settings.local.json"))).toBe(false); // 未落盘
  });

  it("#7 sidecar.enabled:false 拒因——只能收紧、不能放宽安全门", async () => {
    const ws = makeWs("wudao-o99-177-b7-", true);
    const r = await runConfigCommand({ workspaceRoot: ws, args: 'set local sidecar {"enabled":false}' });
    expect(r).toContain("⚠️ sidecar.enabled:false 会解除 auto 模式分类器——可克隆层只能收紧、不能放宽安全门");
    expect(existsSync(join(ws, ".wudao", "settings.local.json"))).toBe(false);
  });

  it("#8 回执 how 三值——已创建并已 gitignore / 已创建（自管 .gitignore 警告）/ 已更新", async () => {
    // 有 .gitignore 的首写 → auto-gitignore 分支
    const wsA = makeWs("wudao-o99-177-b8a-", true);
    const a1 = await runConfigCommand({ workspaceRoot: wsA, args: "set local theme dark" });
    expect(a1).toContain("已创建并已 gitignore");
    expect(a1).not.toContain("created");
    const a2 = await runConfigCommand({ workspaceRoot: wsA, args: "set local theme light" });
    expect(a2).toContain("已更新");
    expect(a2).not.toContain("created");
    // 无 .gitignore 的首写 → 自行加入 .gitignore 警告分支
    const wsB = makeWs("wudao-o99-177-b8b-", false);
    const b1 = await runConfigCommand({ workspaceRoot: wsB, args: "set local theme dark" });
    expect(b1).toContain("已创建（⚠️ 请自行把 .wudao/settings.local.json 加入 .gitignore）");
  });

  it("#9 保存回执整句「已保存 <key> → <path>（<how>；下一会话生效——prompt/工具字节在会话内冻结）」", async () => {
    const ws = makeWs("wudao-o99-177-b9-", true);
    const r = await runConfigCommand({ workspaceRoot: ws, args: "set local theme dark" });
    expect(r).toBe(`已保存 theme → ${join(ws, ".wudao", "settings.local.json")}（已创建并已 gitignore；下一会话生效——prompt/工具字节在会话内冻结）`);
  });
});

describe("ω99-177 C — settings-layer loader 拒因孪生（2 面）", () => {
  it("#10 提权键 loader 孪生——本层已忽略、全局层指引（镜像 settings-layer.test fixture 形）", () => {
    const { warnings } = sanitizeProjectTier({ slack: { enabled: true, allowedUsers: ["U_X"], allowedChannels: ["C_Y"] } });
    expect(warnings.some((w) => w.includes('"slack" 是提权键') && w.includes("本层已忽略"))).toBe(true);
    expect(warnings.some((w) => w.includes("如确有需要，请在全局层 settings.json 设置"))).toBe(true);
  });

  it("#11 sidecar.enabled:false loader 孪生——本层已忽略、只能收紧不能放宽", () => {
    const { warnings } = sanitizeProjectTier({ sidecar: { enabled: false, model: "x" } });
    expect(warnings.some((w) => w.includes("会解除 auto 模式分类器") && w.includes("本层已忽略"))).toBe(true);
    expect(warnings.some((w) => w.includes("可克隆层只能收紧、不能放宽安全门"))).toBe(true);
  });
});
