// ω99-314 — 文件级时光机的快照仓（content-addressed 纯层）。
//
// 问题：改动面板（216/288）把「每轮动了哪些文件」看得很清楚，但能看不能回
// ——想只回退一个文件时只能 /rewind 整轮（把别的好改动一起卷走）。本层是
// 「回」的那半边：写前捕获的旧内容进 content-addressed 仓（同内容全工作区
// 一份），settle 时随 217 收据批落 file_snapshot 索引条目，恢复 op（驱动侧
// fileRevert）把指定文件恢复到指定快照。
//
// 设计纪律（CodeWhale PR#6111 安全设计 + 本仓惯用法）：
//   * 快照是尽力而为——捕获/落盘失败 fail-open 记 warn，绝不阻断正常写。
//   * ★红线：LRU 淘汰只删 `.wudao/snapshots/` 内 blob，绝不触碰工作区任何
//     用户文件；被淘汰 blob 的索引条目照留（诚实报「快照已被清理」）。
//   * 仓只增（content-addressed、append 语义）；帽 1GB，超帽按 atime 淘汰。
//   * 触发工具集从 file-receipt 的 FILE_RECEIPT_TOOLS 推导（一处缝两处受益，
//     223 #9 先例）——不手抄第二份名册。
//   * 哈希是全 64 位 sha256（read-state 的 hashContent 是 16 位截断摘要——
//     那是读状态新鲜度的用途；内容寻址要全摘要）。
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWorkspacePath } from "@wudao/core";
import type { SessionEntry } from "@wudao/core";
import { FILE_RECEIPT_TOOLS } from "./driver/file-receipt.js";
import type { AgentHooks } from "@wudao/core";

/** 全 64 位 sha256（内容寻址的摘要面——与 read-state 的 16 位截断哈希不同用途）。 */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 快照仓的目录名（<workspaceRoot>/.wudao/snapshots——boot 根锚定，同 spill/
 *  plan.md 的 .wudao 惯例；agent root 移动不搬家）。 */
export const SNAPSHOT_STORE_DIR = "snapshots";

/** 仓大小帽（默认 1GB；超帽触发 LRU 淘汰）。 */
export const DEFAULT_SNAPSHOT_CAP_BYTES = 1024 * 1024 * 1024;

/** 快照写前捕获的触发工具集——从 file-receipt 的名门推导（write_file/edit 的
 *  旧内容已由 M37 history + turnDiff 在内存收着；本面覆盖的是 doc 三件套写册
 *  这族「此前无快照」的写路径）。一处名册两处受益，不手抄第二份。 */
export const SNAPSHOT_TRIGGER_TOOLS: ReadonlySet<string> = FILE_RECEIPT_TOOLS;

export interface SnapshotStore {
  /** 写前捕获：目标文件存在则读全文落仓（sha256 查重），返回其 sha；文件不
   *  在（新建）或任何失败 → null（fail-open，记 warn——绝不阻断写）。路径按
   *  LIVE root 解析（工具写哪，快照照哪；缺省 = 构造根——.wudao 锚不动）。 */
  capturePreWrite(toolName: string, rawPath: string, liveRoot?: string): Promise<string | null>;
  /** 幂等落一个内容寻址 blob（同内容全工作区一份）。返回 sha；失败 → null
   *  （fail-open 记 warn，绝不抛）。 */
  ensureBlob(content: string): Promise<string | null>;
  /** blob 是否在仓（淘汰/删仓后 false——「快照已被清理」的判据）。 */
  hasBlob(sha: string): Promise<boolean>;
  /** 读回一个 blob；缺席 → null（typed 拒的数据面，绝不抛）。 */
  readBlob(sha: string): Promise<string | null>;
  /** LRU 淘汰：总字节超帽时按 atime 最旧先删，直到回到帽内。★红线：只删
   *  `.wudao/snapshots/` 内的常规文件——工作区用户文件一字节不动（防御性
   *  前缀校验在每一个候选上重跑）。返回淘汰数。 */
  enforceLruCap(capBytes?: number): Promise<{ readonly evicted: number }>;
  /** 仓内 blob 数与总字节（诊断/测试）。 */
  stats(): Promise<{ readonly blobs: number; readonly bytes: number }>;
}

/** 仓内 blob 的（相对）路径形：<sha 前 2 字>/<sha>。纯函数（测试钉形状）。 */
export function blobRelPath(sha: string): string {
  return join(sha.slice(0, 2), sha);
}

export function createSnapshotStore(workspaceRoot: string, opts?: { readonly warn?: (line: string) => void }): SnapshotStore {
  const storeDir = join(workspaceRoot, ".wudao", SNAPSHOT_STORE_DIR);
  // warn 一次化：同类失败不刷屏（FileChanged watcher 的 warn-once 惯例）。
  let warned = false;
  const warn = (line: string): void => {
    if (warned) return;
    warned = true;
    try {
      const sink = opts?.warn ?? ((l: string) => { /* silent default — a best-effort layer must never spam a TUI */ });
      sink(line);
    } catch {
      /* a warn sink failure is beneath a fail-open layer */
    }
  };

  const blobPath = (sha: string): string => join(storeDir, blobRelPath(sha));

  /** ★红线的一半：候选删除路径必须严格在仓目录内（解析后前缀校验）。 */
  const insideStore = (p: string): boolean => {
    const resolved = resolve(p);
    return resolved.startsWith(resolve(storeDir) + sep);
  };

  /** 写前读当前内容；缺席（新建）→ undefined；不可读 → null-ish 哨兵区分。 */
  const readCurrent = async (absPath: string): Promise<string | undefined | null> => {
    try {
      const st = await stat(absPath);
      if (!st.isFile()) return undefined; // 目录/设备不是文件——按「不在」处理
      return await readFile(absPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return null; // 读失败（权限等）——fail-open 语义由调用方收口
    }
  };

  return {
    async capturePreWrite(toolName, rawPath, liveRoot) {
      if (!SNAPSHOT_TRIGGER_TOOLS.has(toolName)) return null;
      if (typeof rawPath !== "string" || rawPath === "") return null;
      const resolved = await resolveWorkspacePath(liveRoot ?? workspaceRoot, rawPath);
      if (!resolved.ok) return null; // 路径逃逸/形状拒——无文件可快照，静默跳过
      const content = await readCurrent(resolved.absPath);
      if (content === undefined) return null; // 新建——旧内容不存在
      if (content === null) {
        warn(`⚠️ snapshot capture failed to read ${rawPath} — restore coverage skipped for this write`);
        return null;
      }
      return await this.ensureBlob(content);
    },

    async ensureBlob(content) {
      const sha = sha256Hex(content);
      const target = blobPath(sha);
      try {
        const existing = await stat(target).catch(() => undefined);
        if (existing !== undefined && existing.isFile()) return sha; // 去重：同内容一份
        await mkdir(join(storeDir, sha.slice(0, 2)), { recursive: true });
        // 原子写惯用法（fileWriteContent 同款）：同目录 tmp + rename。
        const tmp = join(storeDir, `.${sha}.${randomUUID()}.tmp`);
        await writeFile(tmp, content, "utf8");
        await rename(tmp, target);
        return sha;
      } catch {
        warn(`⚠️ snapshot store write failed — restore is best-effort, the write path is unaffected`);
        return null;
      }
    },

    async hasBlob(sha) {
      if (!/^[0-9a-f]{64}$/.test(sha)) return false;
      const st = await stat(blobPath(sha)).catch(() => undefined);
      return st !== undefined && st.isFile();
    },

    async readBlob(sha) {
      if (!/^[0-9a-f]{64}$/.test(sha)) return null;
      try {
        return await readFile(blobPath(sha), "utf8");
      } catch {
        return null; // 淘汰/删仓/读失败 → 诚实缺席
      }
    },

    async enforceLruCap(capBytes) {
      const cap = capBytes ?? DEFAULT_SNAPSHOT_CAP_BYTES;
      try {
        // 收集仓内 blob（形状 <2 字目录>/<64 字文件>）——只走 SNAPSHOT_STORE_DIR。
        const found: { readonly path: string; readonly bytes: number; readonly atime: number }[] = [];
        let total = 0;
        const shardDirs = await readdir(storeDir, { withFileTypes: true }).catch(() => []);
        for (const shard of shardDirs) {
          if (!shard.isDirectory()) continue;
          const names = await readdir(join(storeDir, shard.name), { withFileTypes: true }).catch(() => []);
          for (const f of names) {
            if (!f.isFile()) continue;
            const p = join(storeDir, shard.name, f.name);
            try {
              const st = await stat(p);
              if (!st.isFile()) continue;
              found.push({ path: p, bytes: st.size, atime: st.atimeMs });
              total += st.size;
            } catch {
              /* 一个 stat 不出的候选跳过——淘汰绝不因它失败 */
            }
          }
        }
        if (total <= cap) return { evicted: 0 };
        // atime 最旧先删。
        found.sort((a, b) => a.atime - b.atime);
        let evicted = 0;
        for (const cand of found) {
          if (total <= cap) break;
          // ★红线：删除前在每个候选上重跑仓内前缀校验——任何越界路径跳过。
          if (!insideStore(cand.path)) continue;
          try {
            await unlink(cand.path);
            total -= cand.bytes;
            evicted += 1;
          } catch {
            /* 单个 unlink 失败隔离——其余照常 */
          }
        }
        return { evicted };
      } catch {
        // 淘汰自身 fail-open：仓读不出来就当零淘汰（下次 settle 再试）。
        return { evicted: 0 };
      }
    },

    async stats() {
      let blobs = 0;
      let bytes = 0;
      const shardDirs = await readdir(storeDir, { withFileTypes: true }).catch(() => []);
      for (const shard of shardDirs) {
        if (!shard.isDirectory()) continue;
        const names = await readdir(join(storeDir, shard.name), { withFileTypes: true }).catch(() => []);
        for (const f of names) {
          if (!f.isFile()) continue;
          try {
            const st = await stat(join(storeDir, shard.name, f.name));
            blobs += 1;
            bytes += st.size;
          } catch {
            /* skip */
          }
        }
      }
      return { blobs, bytes };
    },
  };
}

// ---------------------------------------------------------------------------
// 索引车道（M35 §2 泛型 entry 的读写两侧）
// ---------------------------------------------------------------------------

/** 一条 file_snapshot 索引行的读侧形状（写者是驱动 settle 缝）。
 *  turn = 与改动面板同序的轮号（第 N 轮——绿点对齐的未来缝，v1 逐轮粒度）；
 *  run = 会话 id；beforeSha = 该轮开始前内容的仓内 sha（恢复目标）；
 *  afterSha = 该轮结束内容的 sha（守卫 3 的新鲜度比对基准，可缺省）。 */
export interface FileSnapshotRow {
  readonly turn: number;
  readonly run: string;
  readonly path: string;
  readonly beforeSha: string;
  readonly afterSha?: string;
}

const isHex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** 读侧纯函数：session JSONL 全条目 → file_snapshot 行（文件序保持；畸形条目
 *  弃掉不崩——「data payload is the writer's contract」的读侧诚实，217 同款
 *  纪律；未知附加字段忽略——append-only 前向兼容）。 */
export function snapshotIndexFromEntries(entries: readonly SessionEntry[]): readonly FileSnapshotRow[] {
  const out: FileSnapshotRow[] = [];
  for (const e of entries) {
    if (!("type" in e) || e.type !== "file_snapshot") continue;
    const data: unknown = (e as { readonly data?: unknown }).data;
    if (typeof data !== "object" || data === null) continue;
    const { turn, run, path, beforeSha, afterSha } = data as Record<string, unknown>;
    if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 1) continue;
    if (typeof run !== "string" || run === "") continue;
    if (typeof path !== "string" || path === "") continue;
    if (!isHex64(beforeSha)) continue;
    if (afterSha !== undefined && !isHex64(afterSha)) continue;
    out.push({ turn, run, path, beforeSha, ...(afterSha !== undefined ? { afterSha } : {}) });
  }
  return out;
}

/** 文件序 last-wins 的「每文件最新 afterSha」目录（守卫 3 的比对基准）。 */
export function latestAfterShaByPath(rows: readonly FileSnapshotRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.afterSha !== undefined) out.set(r.path, r.afterSha);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 写前捕获的 hook observer（跑在 onPreToolUse 最外层：先捕获、后委托）
// ---------------------------------------------------------------------------

/** 把写前捕获叠进 hooks 链的最外层（observe-only：永不 block、永不改写——
 *  捕获失败 fail-open，基础 hooks 的决定原样透传）。onPreToolUse 在
 *  canUseTool 之前跑（loop 契约），所以 bypass/auto 模式下捕获同样在场。 */
export function withSnapshotCapture(
  hooks: AgentHooks | undefined,
  store: SnapshotStore | undefined,
  liveRoot: () => string | undefined,
): AgentHooks | undefined {
  if (store === undefined) return hooks;
  const capture = async (toolName: string, input: Record<string, unknown>): Promise<void> => {
    try {
      const root = liveRoot();
      if (root === undefined) return;
      // doc 写册的路径参数双名：append/replace/set-chrome 用 path，make 面用
      // filename（缺省自动命名→目标未知→跳过：自动名是时间戳新文件，无旧可快）。
      const raw = typeof input["path"] === "string" ? input["path"]
        : typeof input["filename"] === "string" ? input["filename"]
        : undefined;
      if (raw === undefined || raw === "") return;
      await store.capturePreWrite(toolName, raw, root);
    } catch {
      /* fail-open 双保险——store 内部已 fail-open，此处兜底绝不抛 */
    }
  };
  if (hooks === undefined) {
    return {
      onPreToolUse: async (toolName, input) => { await capture(toolName, input); },
      // 0.3.91 修复（gate 首逮）：纯观察者（fail-open、决定透传、写工具集过滤
      // ——并行读批零触碰）按 loop ω-5b R9 契约声明并发安全。不声明则本层常
      // 驻 onPreToolUse 起，多工具并行批全被降级串行（ω99-63 探针首逮）。
      toolHooksConcurrencySafe: true,
    };
  }
  const base = hooks.onPreToolUse;
  return {
    ...hooks,
    onPreToolUse: async (toolName: string, input: Record<string, unknown>) => {
      await capture(toolName, input);
      return base?.(toolName, input);
    },
    // 传播律：内链已证 true → 保持；内链未证 → 不替别人做安全声明。
    toolHooksConcurrencySafe: hooks.toolHooksConcurrencySafe === true ? true : undefined,
  };
}
