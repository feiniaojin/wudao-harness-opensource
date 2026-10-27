// ω99-319 — Bash/命令级改动归因（改动面板最大暗洞收口）。
//
// 问题：agent 用 shell（sed/脚本/build 产物）改的文件绕过改动面板——
// write_file/edit 的改动看得见、可恢复（314），shell 偷改的看不见、更回不了。
// 本层是「看见」的那半边（纯观察者）：shell 调用前后各做一次指纹扫描
// （readdir+stat，绝不读内容），窗口内 mtimeMs/size 变化的文件即该命令的
// 足迹；modified/created 的 after 内容读入落 314 的快照仓（≤8MB/文件）——
// 「下一次任何改动都有前快照」的播种（超越点②）。落账（settle 的
// changes[].cmd merge + command_footprint 泛型条目）在 agent-driver 侧。
//
// 设计纪律（withSnapshotCapture 同族 + brief §2 诚实注记）：
//   * observe-only：永不 block、永不改写——基础 hooks 的决定原样透传。
//   * fail-open 三层：扫描失败/读帽超限/落仓失败都绝不阻断 shell 执行与
//     settle（异常吞掉，扫描失败 → null）。
//   * ★忽略集必须含 `.wudao`（否则快照仓自身写入污染下一次 diff——正确性
//     关键）；node_modules/.git/dist/build/target/.DS_Store 同列。
//   * 按 call 配对（Map 键=命令原文）：绝不共享跨命令状态，防串扰归因。
//     loop 的 onPostToolUse 在调用序上串行（即使批内并行执行，post 也按
//     原始调用序 await），单缝配对无竞态。
//   * 归因语义=「该命令执行窗口内变更」非「因果」——长命令期间用户在编辑器
//     改的文件会被归到命令头上（无法区分，brief §2 缺点 3 的诚实边界）。
//   * mtimeMs+size 指纹理论盲区：同 ms 同 size 不同内容 → 漏报（实践罕见）。
//   * M24：本层全程旁路——不进 state.messages、不进 system prompt、不进
//     模型请求投影；产出只走 emit 队列（settle 的 appendEntries 之外零写）。
import { truncateSafe } from "@wudao/core"; // 113-A4
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHooks } from "@wudao/core";
import type { SnapshotStore } from "./snapshots.js";

/** 指纹扫描的固定忽略集（目录名或文件名，每一层都判）。★`.wudao` 在场是
 *  正确性关键：快照仓自身的 blob 写入不得污染下一次 diff。 */
export const CMD_FOOTPRINT_IGNORED_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".wudao",
  "dist",
  "build",
  "target",
  ".DS_Store",
]);

/** 足迹 after 内容的每文件读帽（超帽跳过内容只留路径行——诚实边界：该文件
 *  本次不播种，回退面待下一次改动）。 */
export const CMD_FOOTPRINT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 命令文本帽（JSONL 行预算纪律；超长截断加 …）。 */
export const CMD_FOOTPRINT_COMMAND_CAP_CHARS = 200;

/** 一个文件的指纹（stat 面，绝不读内容）。 */
export interface FileFingerprint {
  readonly mtimeMs: number;
  readonly size: number;
}

/** 一次扫描的产物：相对路径（posix 分隔）→ 指纹。 */
export type FingerprintTable = Map<string, FileFingerprint>;

/** 一个足迹文件的三态。afterSha = after 内容成功落仓时的指针（缺席=超帽/
 *  读失败/deleted——不假装可回退）。 */
export interface FootprintFile {
  readonly path: string;
  readonly kind: "modified" | "created" | "deleted";
  readonly afterSha?: string;
}

/** 一条命令的足迹（command 已过 200 字符帽）。 */
export interface CommandFootprint {
  readonly command: string;
  readonly files: readonly FootprintFile[];
}

/** 命令文本帽：超长截断加 …（恰 200 不动）。纯函数（测试钉形状）。 */
export function capCommandText(command: string): string {
  return command.length > CMD_FOOTPRINT_COMMAND_CAP_CHARS
    ? truncateSafe(command, CMD_FOOTPRINT_COMMAND_CAP_CHARS) + "…"
    : command;
}

/** 递归指纹扫描：readdir+stat（绝不读内容），忽略集每一层生效；符号链接
 *  跳过（不是真内容）。fail-open：任何异常 → null（绝不抛——扫描失败绝不
 *  阻断工具执行）。 */
export async function scanFingerprints(root: string): Promise<FingerprintTable | null> {
  try {
    const out: FingerprintTable = new Map();
    const walk = async (relDir: string): Promise<void> => {
      const absDir = relDir === "" ? root : join(root, relDir);
      const entries = await readdir(absDir, { withFileTypes: true });
      for (const e of entries) {
        if (CMD_FOOTPRINT_IGNORED_NAMES.has(e.name)) continue;
        const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
        if (e.isDirectory()) {
          await walk(rel);
        } else if (e.isFile()) {
          try {
            const st = await stat(join(root, rel));
            if (!st.isFile()) continue;
            out.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
          } catch {
            /* 单个 stat 失败跳过——扫描整体照常（fail-open 的细粒度面） */
          }
        }
        // 符号链接/其他类型：跳过（e.isFile() 为 false）。
      }
    };
    await walk("");
    return out;
  } catch {
    return null; // 根不可读/中断——整个扫描诚实缺席
  }
}

/** 纯函数 diff：mtimeMs 或 size 变 = modified；新增 = created；消失 =
 *  deleted；同指纹不报。输出按路径排序（确定性——同输入同输出）。 */
export function diffFingerprints(
  before: FingerprintTable,
  after: FingerprintTable,
): { readonly modified: string[]; readonly created: string[]; readonly deleted: string[] } {
  const modified: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  for (const [path, a] of after) {
    const b = before.get(path);
    if (b === undefined) created.push(path);
    else if (b.mtimeMs !== a.mtimeMs || b.size !== a.size) modified.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) deleted.push(path);
  }
  modified.sort();
  created.sort();
  deleted.sort();
  return { modified, created, deleted };
}

/** observer 的依赖缝（store/liveRoot/emit 由驱动侧注入；scan/maxFileBytes
 *  测试可换——确定性夹具不碰真文件系统）。 */
export interface CommandFootprintDeps {
  /** 314 快照仓：在场才做 after 内容播种（缺席 → 足迹照算、零落仓）。 */
  readonly store?: SnapshotStore;
  /** shell 执行根（LIVE agent root 优先——工具写哪照哪，314 同款锚定）。 */
  readonly liveRoot: () => string | undefined;
  /** 足迹推给驱动侧队列（settle 缝消费）。 */
  readonly emit: (fp: CommandFootprint) => void;
  /** 扫描函数（缺省 scanFingerprints；测试注入按序出牌）。 */
  readonly scan?: (root: string) => Promise<FingerprintTable | null>;
  /** 每文件读帽（缺省 8MB；测试注小帽）。 */
  readonly maxFileBytes?: number;
}

const isShellCommand = (toolName: string, input: Record<string, unknown>): input is { command: string } =>
  toolName === "shell" && typeof input["command"] === "string" && input["command"] !== "";

/** 把命令足迹观察叠进 hooks 链的最外层（observe-only：永不 block、永不改写
 *  ——扫描/读帽/落仓任何失败 fail-open，基础 hooks 的决定原样透传）。非
 *  shell 工具零扫描零成本。onPreToolUse 存本次扫描（按命令原文配对——绝不
 *  共享跨命令状态）；onPostToolUse 再扫 + diff + after 落仓 → emit。空足迹
 *  不 emit（JSONL 噪声纪律：一条不改文件的命令不产生条目）。 */
export function withCommandFootprint(
  hooks: AgentHooks | undefined,
  deps: CommandFootprintDeps,
): AgentHooks | undefined {
  const scan = deps.scan ?? scanFingerprints;
  const maxFileBytes = deps.maxFileBytes ?? CMD_FOOTPRINT_MAX_FILE_BYTES;
  // pre 扫描槽：命令原文 → 指纹（post 消费即删——pre 失败的命令不留槽，
  // post 找不到槽就跳过：绝不拿别条命令的 before 当这条的窗口基线）。
  const preScans = new Map<string, FingerprintTable>();

  const preScan = async (command: string): Promise<void> => {
    try {
      const root = deps.liveRoot();
      if (root === undefined) return;
      const table = await scan(root);
      if (table === null) return; // 扫描失败 → 本条命令无基线（fail-open）
      preScans.set(command, table);
    } catch {
      /* fail-open 双保险——绝不抛 */
    }
  };

  const postScan = async (command: string): Promise<void> => {
    try {
      const before = preScans.get(command);
      preScans.delete(command); // 消费即删——后续同文命令重新配对
      if (before === undefined) return;
      const root = deps.liveRoot();
      if (root === undefined) return;
      const after = await scan(root);
      if (after === null) return; // post 扫描失败 → 放弃本条（fail-open）
      const diff = diffFingerprints(before, after);
      if (diff.modified.length === 0 && diff.created.length === 0 && diff.deleted.length === 0) return;
      const files: FootprintFile[] = [];
      for (const path of diff.modified) files.push({ path, kind: "modified", ...(await afterShaFor(root, path, after)) });
      for (const path of diff.created) files.push({ path, kind: "created", ...(await afterShaFor(root, path, after)) });
      for (const path of diff.deleted) files.push({ path, kind: "deleted" }); // 无 after 可落
      deps.emit({ command: capCommandText(command), files });
    } catch {
      /* fail-open 双保险——绝不抛 */
    }
  };

  /** after 内容落仓（播种「下一次可回退」）：modified/created 且仍在场才读；
   *  指纹 size 超帽/读失败/落仓失败 → 无 afterSha（只留路径行，不假装可回退）。 */
  const afterShaFor = async (
    root: string,
    relPath: string,
    after: FingerprintTable,
  ): Promise<{ readonly afterSha: string } | {}> => {
    if (deps.store === undefined) return {};
    const fp = after.get(relPath);
    if (fp === undefined || fp.size > maxFileBytes) return {}; // 超帽：跳过内容
    try {
      const content = await readFile(join(root, ...relPath.split("/")), "utf8");
      const sha = await deps.store.ensureBlob(content);
      return sha === null ? {} : { afterSha: sha };
    } catch {
      return {}; // 读失败 fail-open——路径行照留
    }
  };

  if (hooks === undefined) {
    return {
      onPreToolUse: async (toolName: string, input: Record<string, unknown>) => {
        if (isShellCommand(toolName, input)) await preScan(input.command);
      },
      onPostToolUse: async (toolName: string, input: Record<string, unknown>, result: string) => {
        if (isShellCommand(toolName, input)) await postScan(input.command);
        return undefined; // 无基础 hooks——结果原样（void 面）
      },
      // 0.3.91 修复（gate 首逮）：本层是纯观察者（fail-open、决定透传、只认
      // shell），按 loop 契约 ω-5b R9 的「embedders with observe-only hooks
      // may assert」声明并发安全——否则本 observer 常驻后，所有多工具并行批
      // 都被降级为串行（ω99-63 探针是唯一走全 driver 并行批的钉，0.3.89 起
      // 静默回归两版未被发现）。
      toolHooksConcurrencySafe: true,
    };
  }
  const base = hooks;
  return {
    ...base,
    onPreToolUse: async (toolName: string, input: Record<string, unknown>) => {
      if (isShellCommand(toolName, input)) await preScan(input.command);
      return base.onPreToolUse?.(toolName, input);
    },
    onPostToolUse: async (toolName: string, input: Record<string, unknown>, result: string) => {
      if (isShellCommand(toolName, input)) await postScan(input.command);
      return base.onPostToolUse?.(toolName, input, result);
    },
    // 传播律：内链已证 true → 保持；内链未证 → 不替别人做安全声明（undefined
    // = loop 见「有面且未证」走串行，保守正确）。
    toolHooksConcurrencySafe: base.toolHooksConcurrencySafe === true ? true : undefined,
  };
}
