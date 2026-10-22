#!/usr/bin/env node
// vendor-icons.mjs — 116 去廉价化第三弧（图标体系统一）的取材脚本。
//
// 从 node_modules/lucide-static/icons 拷贝清单内的 SVG 到
// src/assets/icons/，并做三步归一（收据测试 arc116c-icon-system 钉 (b)）：
//   ① stroke-width 2 → 1.5（与 components/icons.tsx 既有自绘集同宽——细线
//      图标是 116 报告 §3.d「高级感」的关键一笔，the upstream format全集 1px，我们全库
//      统一 1.5px：两套 SVG（自绘 + lucide vendor）在同一屏必须同宽）；
//   ② stroke="currentColor" 原样保留（四主题由 CSS 令牌着色，零裸 hex）；
//   ③ 剥 width/height/class（Icon.tsx 控制尺寸与类名，防止 24px 缺省渗入）。
//
// 为什么 vendor 而不依赖包：打包确定性 + 离线 + WKWebView 零运行时依赖
// （弧任务裁定）。文件提交进库；本脚本可重复执行（幂等重拷）。
// lucide-static v1.48.0 — ISC License（与 MIT 同等宽松；@license 行保留在
// 每个 vendored 文件头部）。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = join(pkgRoot, "node_modules", "lucide-static", "icons");
const OUT_DIR = join(pkgRoot, "src", "assets", "icons");

// 语义清单：键 = Icon.tsx 的 name 值（= lucide 文件名，映射一目了然）。
// 每条注明替换的 emoji 点位（收据映射表的单源）。
const MANIFEST = [
  // ⏳ 排队/驻留/等待批准（SimpleComposer 双 chip + parked-chip、
  // LiveArea/SimpleTurnStatus 注入行、PermissionModal/SimpleApprovalCard 条）
  "hourglass",
  // ⚡ 注入当前轮 chip（SimpleComposer）
  "zap",
  // ⏰ 侧栏定时任务标记（SessionSidebar .sb-sched）
  "clock",
  // 📋 plan review 标签（PlanReview .label）
  "clipboard-list",
  // 🔑 权限卡三处标题 + sidecar 行（PermissionModal）
  "key",
  // ⏎ Enter 键注记（PermissionModal 拒绝钮 + 键道说明行）
  "corner-down-left",
  // ❓ AskUser 问题标题（AskUserCards h3）
  "circle-help",
  // 🖼? 图片加载失败泡（AttachmentImages .img-bub.err）
  "image",
  // 🧠 记忆确认标题（MemoryReviewCard .memory-review-title）
  "brain",
  // 🎉 向导完成标题（Wizard h3）
  "party-popper",
  // ★/☆ 启动默认模型星（ProviderDetail .model-star；实心态由 Icon 的
  // filled 属性画 fill="currentColor"）
  "star",
  // 📊 xlsx 文件图标（SimpleActivityCard fileIconOf）
  "chart-column",
  // 📽 pptx 文件图标（同上）
  "film",
  // 📄 文件 chip 字形（InputBox .file-card / AttachmentFiles .hist-file-chip）
  "file-text",
  // 🗑 清空历史确认标题（ClearConfirm h3）
  "trash-2",
  // 🛡 工具卡 gating 尾（LiveArea .act-tail.gating）
  "shield",
  // 🛡✕ sidecar 熔断位（StatusBar .warn）
  "shield-x",
  // ▣ 看板进度位（StatusBar .board）
  "list-checks",
  // ⚠️ JSX 面位警告字形（ContextMeter/StatusBar/SpoofReveal/
  // SimpleErrorCard/FileViewer/CodeEditor/McpTab/SettingsPage 待确认行）
  "triangle-alert",
];

if (!existsSync(SRC_DIR)) {
  console.error(`lucide-static icons not found at ${SRC_DIR} — run pnpm install first.`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

let n = 0;
for (const name of MANIFEST) {
  const src = join(SRC_DIR, `${name}.svg`);
  const out = join(OUT_DIR, `${name}.svg`);
  if (!existsSync(src)) {
    console.error(`missing icon in lucide-static: ${name}.svg`);
    process.exit(1);
  }
  let svg = readFileSync(src, "utf8");
  // ① 描边宽归一 1.5（lucide 缺省 2）
  svg = svg.replace('stroke-width="2"', 'stroke-width="1.5"');
  // ③ 剥 width/height/class（Icon.tsx 的领地）
  svg = svg
    .replace(/\s*width="24"/, "")
    .replace(/\s*height="24"/, "")
    .replace(/^\s*class="lucide lucide-[^"]*"\s*\n/m, "");
  // ② currentColor 必须在（防上游变更静默破坏主题继承）
  if (!svg.includes('stroke="currentColor"') || !svg.includes('stroke-width="1.5"')) {
    console.error(`transform failed for ${name}.svg — currentColor/1.5 missing after rewrite`);
    process.exit(1);
  }
  writeFileSync(out, svg);
  n++;
}
console.log(`vendored ${n} icons → src/assets/icons/ (stroke 1.5, currentColor, size-class stripped)`);
