// ω99 拆分运动 弧 B：computer 工具面的模块级 helper 族外提（ok/err 回执构造、
// 视觉/选项缝类型、osascript 调用与失败分类、win32 执行层——原 tools.ts 模块级
// 段逐字保留；tools.ts import 回用 + re-export 门面保公共面）。
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import type { ToolResult } from "@wudao-org/core";
import {
  ACCESSIBILITY_GUIDE,
  PERM_MARKER_ACCESSIBILITY,
  classifyOsascriptFailure,
  displayRole,
  fetchStatusLine,
  type ExecSeam,
} from "./exec.js";
import { buildWinStatusScript, formatWinStatusLine, parseWinStatus, psArgs, PS_BIN } from "./win32.js";

export const ok = (content: string): ToolResult => ({ content });
export const err = (content: string): ToolResult => ({ content, isError: true });

/** 截屏的图片附件缝（与 browserVision 同形）：字节只经 AttachmentStore 落
 *  .wudao/attachments；modelAcceptsImages 每次调用时读（文本主模型不截——
 *  省一次屏幕录制授权弹窗，也绝不给后续请求喂图像拒绝）。 */
export interface ComputerVisionSeam {
  readonly store: { saveImages(inputs: readonly { data: string; mediaType: string }[]): Promise<{ kind: "image"; attachmentId: string; mediaType: string; byteLength: number }[]> };
  readonly modelAcceptsImages: () => boolean;
}

export interface ComputerToolOptions {
  /** 子进程缝（生产缺省；测试注入假件）。 */
  readonly exec?: ExecSeam;
  /** 截屏图片附件缝；缺席 → screen_capture typed 拒（其余五工具不受影响）。 */
  readonly vision?: ComputerVisionSeam;
  /** 平台（缺省 process.platform；注入用）。 */
  readonly platform?: string;
  /** helper 在场探针（缺省 existsSync）。 */
  readonly helperExists?: (path: string) => boolean;
  /** helper 解析基准（缺省 process.execPath）。 */
  readonly execPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 时钟缝（缺省 Date.now；测试注入驱动黑名单 TTL）。ω99-247。 */
  readonly now?: () => number;
  /** 停顿缝（缺省 setTimeout；测试注入零等待驱动 settle 窗/wait 轮询）。ω99-250。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const NON_DARWIN = (tool: string, platform: string): string =>
  `${tool}: 仅支持 macOS 与 Windows——电脑操作能力不覆盖当前平台 ${platform}`;

/** osascript 调用 + 失败分类（-1743 → 辅助功能引导标记）。 */
export async function runOsascript(
  exec: ExecSeam, tool: string, script: string,
): Promise<ToolResult> {
  const r = await exec("osascript", ["-e", script]);
  if (r.code === 0) return ok("");
  const kind = classifyOsascriptFailure(r.stderr);
  if (kind === "accessibility") {
    return err(`${tool}: ${PERM_MARKER_ACCESSIBILITY} 操作被系统拒绝（osascript 错误 -1743）。${ACCESSIBILITY_GUIDE}`);
  }
  return err(`${tool}: osascript 执行失败（exit ${r.code}）：${truncateSafe(r.stderr.trim(), 400)}`);
}

/** ω99-241: #2 — 动作回执状态行：六动作面成功回执尾新行附「当前状态」（一次
 *  osascript 取前台应用 · 最前窗口标题 · 焦点元素角色三元组）。降级纪律：状态
 *  osascript 失败/锚缺席 → 原回执原样（诚实缺席，不放半截状态）。安全纪律：
 *  焦点元素只读角色，绝不读 value——AXSecureTextField 显示「密码框」，值永不
 *  入上下文（exec.ts 单源）。screen_capture / app_list 回执不变。 */
export async function withStatus(exec: ExecSeam, receipt: string): Promise<string> {
  const line = await fetchStatusLine(exec);
  return line === undefined ? receipt : `${receipt}\n${line}`;
}

/** 点名形（回执/超时报错共用）：[eN] 角色「标题」——与 247 ref 回执同款
 *  （250 立于 wait 面；scroll/drag 的 ref 端收据同用此形）。 */
export const nameRef = (ref: string, role: string, title: string): string =>
  `[${ref}] ${displayRole(role)}${title !== "" ? `「${title}」` : ""}`;

/** 坐标 fail-closed 校验：有限、非负整数。 */
export function validCoord(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

// ---------------------------------------------------------------------------
// win32（0.3.81）— 十面的 Windows 执行层。全部经同一 ExecSeam 走
// `powershell -NoProfile -Command <script>`（脚本=纯构造器，见 win32.ts）。
// settle/landing(ref)/AX 状态三元组是 macOS 辅助功能树专属——win32 的动作
// 回执附「前台应用 · 窗口标题」两元状态行（诚实降级，不放半截 AX 行）。
// ---------------------------------------------------------------------------

/** PowerShell 失败的统一错面（exit + stderr 首段）。 */
export async function runWinPs(exec: ExecSeam, tool: string, script: string): Promise<{ readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly error: string }> {
  const r = await exec(PS_BIN, psArgs(script));
  if (r.code === 0) return { ok: true, stdout: r.stdout };
  return { ok: false, error: `${tool}: PowerShell 执行失败（exit ${r.code}）：${truncateSafe(r.stderr.trim(), 400)}` };
}

/** win32 状态行（两元）——失败/不可解析 → 不附（mac 降级纪律同律）。 */
export async function winStatusSuffix(exec: ExecSeam, receipt: string): Promise<string> {
  const r = await exec(PS_BIN, psArgs(buildWinStatusScript()));
  if (r.code !== 0) return receipt;
  const parsed = parseWinStatus(r.stdout);
  return parsed === undefined ? receipt : `${receipt}\n${formatWinStatusLine(parsed)}`;
}

/** win32 的 ref 拒面（observe 元素树是 macOS AX 专属）。 */
export const WIN_NO_REF = (tool: string): string =>
  `${tool}: ref 参数基于 macOS 辅助功能元素树，Windows 上不可用——用坐标路径（先 screen_capture 看屏幕，再按图上像素给 x/y）。`;
