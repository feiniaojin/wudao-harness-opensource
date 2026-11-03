// ω99-207: #R — settings 域英文警告中文化第一刀 receipts（hooks-config.ts
// 18 面 + settings-layer.ts 6 面 = 24 面；术语保留 hook/mcp_tool/sessionEnd/
// RegExp/matcher/settings/tier//trust；全角标点；收益语态「已忽略/已跳过/
// 已停用」；后果告知）。① 正向源钉 ≥8 面；② 反向：两 src 文件 ⚠️ 行剔注释
// 剔 CJK 后=0（同控制器 census 管线）；③ dist 反查：rebuild 后两 dist 产物
// 同管线=0；④ 计数稳定：cli src ⚠️ 行计改前=改后（实测基线 432，brief 预核
// 427 与实测不符已如实披露，以亲核为准）；⑤ 术语保留钉：防过度翻译。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

const distOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../dist/${rel}`, import.meta.url)), "utf8");

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

const walkSrc = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? walkSrc(`${dir}/${d.name}`)
      : /\.(ts|tsx|cjs|js|mjs)$/.test(d.name)
        ? [`${dir}/${d.name}`]
        : [],
  );

const pathOf = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

const CJK = /[一-龥]/;

/** census 管线：⚠️ 行剔注释行、剔含 CJK 行——余下即英文族。 */
const englishWarnLines = (s: string): string[] =>
  s.split(/\r?\n/).filter((l) => l.includes("⚠️"))
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter((l) => !CJK.test(l));

describe("ω99-207 — A 正向：24 面译后串在场抽查（源钉法）", () => {
  it("① ≥8 面：三层 unknown-key/结构校验/事件列举/matcher/mcp_tool 失败/预算/信任门/gitignore", () => {
    const hooks = ["hooks-config.ts", "hooks-config-types.ts", "hooks-config-matcher.ts", "hooks-config-exec.ts", "hooks-config-parse.ts", "hooks-compose.ts"].map(srcOf).join("\n"); // 拆分A：家族拼接读
    const layer = srcOf("settings-layer.ts");
    // #1-3 三层 unknown-key（至少一层；本弧三层全译，取全局层头 + 计数 3）
    expect(countOf(hooks, "未知的顶层键已忽略：${")).toBe(3);
    expect(hooks).toContain("全局 settings（${layered.globalHome}）");
    // #4 :280 结构校验（源码字面为转义形 \"hooks\"）
    expect(hooks).toContain('\\"hooks\\" 应为对象——hooks 已停用');
    // #5 :296 事件列举
    expect(hooks).toContain("未知的 hook 事件已忽略（v1 支持 ${KNOWN_EVENTS.join(\", \")}）");
    // #10 :388 matcher/RegExp + 后果告知
    expect(hooks).toContain('不是合法的 RegExp——该 hook 永不触发');
    // #11 :527 mcp_tool 失败
    expect(hooks).toContain("mcp_tool hook ${mcp.server}/${mcp.tool} 失败：");
    // #12 :1070 sessionEnd 预算
    expect(hooks).toContain("sessionEnd hook 预算（${SESSION_END_BUDGET_MS}ms）已耗尽——'${cmd.command}' 已跳过");
    // #21 :230 信任门
    expect(layer).toContain("hooks 已忽略——工作区未受信任（可用 /trust 审阅）");
    // #24 :468 gitignore
    expect(layer).toContain('未找到 .gitignore——请手动将 "${entry}" 加入其中，以免本地 settings 被提交');
    // #19 :180 defaultMode/tier 面（第 9 面抽查）
    expect(layer).toContain("permissions.defaultMode 设置起始权限 tier——本层已忽略（如确有需要，请在全局层的 settings.json 设置）");
  });
});

describe("ω99-207 — B 反向：英文族归零 + dist 反查 + 计数 + 术语保留", () => {
  it("② 两 src 文件 ⚠️ 行剔注释剔 CJK 后=0（census 管线）", () => {
    expect(englishWarnLines(["hooks-config.ts", "hooks-config-types.ts", "hooks-config-matcher.ts", "hooks-config-exec.ts", "hooks-config-parse.ts", "hooks-compose.ts"].map(srcOf).join("\n"))).toEqual([]); // 拆分A：家族拼接读
    expect(englishWarnLines(srcOf("settings-layer.ts"))).toEqual([]);
  });

  it("③ dist 反查：cli rebuild 后两 dist 产物同管线英文族=0（构建后记数）", () => {
    expect(englishWarnLines(distOf("hooks-config.js"))).toEqual([]);
    expect(englishWarnLines(distOf("settings-layer.js"))).toEqual([]);
  });

  it("④ 计数稳定：cli src ⚠️ 行计 = 436（实测基线，改前=改后；brief 预核 427 披露不符；ω99-236 +2：misc-config resolveDocSuiteEnabled 的 docSuite 节点/junk 两 warn——lsp/terminal 同款英文 warn 族；ω99-235 +1：ui.ts pet 车道占用 stderr 一行；ω99-249 +1：mission plan 的 budgetTokens 非正整数拒绝行）", () => {
    const n = walkSrc(pathOf("../src")).reduce(
      (m, f) => m + countOf(readFileSync(f, "utf8"), "⚠️"),
      0,
    );
    // ω99-235: #5 — 432 → 433（ui.ts 的 pet 车道占用 stderr 一行：车道被另一
    // 进程持有时「⚠️ 小精灵车道不可用…」——207 的中文警语族同形新增）。
    // ω99-236 rebase 合流：433 + 2（misc-config docSuite 两 warn）→ 435。
    // ω99-249: #16 — 435 + 1（mission plan 的 budgetTokens 拒绝行：任务级
    // token 预算声明的 fail-closed 警语，同族同形）→ 436。
    // 0.3.91 gate 随源演进：436 → 463（ω99-313..323 批窗口 +27）。
    // 0.3.93 gate 随源演进：463 → 469（借鉴弧 A +6）。0.3.94 gate：469 → 473（α/γ +4）→ 0.3.95 gate：δ/ε/ζ 波 +16（detach 裁决/事件触发/漏火重跑台账/restack 拒做等中文警示行）。
    // v7 γ2 随源演进：469 → 471（run-end-cause.ts 的 interruptedNotice 两臂
    // 回执行——「⚠️ 已中断」旧形臂 + 「⚠️ 已中断（成因）」括注臂，207 中文
    // 警语族同形新增；词表 5 成因的人话由 describeRunEndCause 供给）。
    // 借鉴弧 ε 随源演进：473 → 485（事件触发源的中文警语族 +12：schedules.ts
    // +9——webhookLine 面 5（禁用域/拒答域/无任务/非 webhook/监听未起）、add
    // 面 2（事件源校验/回执兜底）、注释提及 2；schedules-events.ts +3——file
    // 盯不住 2、监听没起来 1。全部带 CJK，② 的英文族归零不受影响）。
    // 0.4.1 gate 随源演进：489 → 490（探针弧 PB-2 /probe 命令 bad-kind 提示
    // 行 `⚠️ ${cmd.message}` +1——命令面统一警语形）。
    // 0.4.3 gate 随源演进：490 → 523（0.4.2 后长程/定时弧批 +36 −3：schedules.ts
    // +13 与 schedules-launchagent.ts +2（LaunchAgent 定时唤起/事件源校验的
    // 中文警语族）、misc-config.ts +14（settings 校验警示）、agent-driver.ts +3、
    // idle-seam.ts +2（headless 周期自治）、mission.ts +2——全部带 CJK，② 的
    // 英文族归零不受影响）。
    // 131 弧 defer 闲时车道 +2（schedules.ts add 门口两拒行）→ 525。
    // 记忆两库收敛弧（722df55e）随源演进：525 → 531（longterm-memory.ts +6
    // ——settings 节点两行英文警语 + 拦截/写入/遗忘/设置四行中文警语；
    // ② 的英文族归零只扫 hooks-config 家族与 settings-layer.ts，不受影响）。
    expect(n).toBe(531);
  });

  it("⑤ 术语保留钉：mcp_tool/sessionEnd/RegExp//trust 译后仍在场（防过度翻译）", () => {
    const hooks = ["hooks-config.ts", "hooks-config-types.ts", "hooks-config-matcher.ts", "hooks-config-exec.ts", "hooks-config-parse.ts", "hooks-compose.ts"].map(srcOf).join("\n"); // 拆分A：家族拼接读
    const layer = srcOf("settings-layer.ts");
    expect(hooks).toContain("mcp_tool");
    expect(hooks).toContain("sessionEnd");
    expect(hooks).toContain("RegExp");
    expect(layer).toContain("/trust");
  });
});
