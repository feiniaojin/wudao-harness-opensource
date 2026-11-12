// 0.5.10 — 状态帧 pet 字段的 workspace 对的 TTL 缓存（file-size 棘轮拆分：
// 从 index.ts 抽出，纯数据面，发帧路径只读它——零等待的根因修复见
// index.ts 的注释与 packages/server/tests/pet-workspace-cache.test.ts 的钉）。
//
// 改形缘由（Windows 报障「提问后不流式、等很久一次性出现」的 server 侧
// 隐患根因）：旧形每帧 await agentRootStatus（两次 realpath）再沿一条串行
// 链发送——realpath 快的机器无症状，慢路径（Windows 盘符外接/重定向
// profile、网络卷）上 100ms 节流的 delta 流会整链积压，流式视感直接死亡。
// 新形：发送时刻只读本缓存（同步），刷新在旁路 fire-and-forget（TTL 内
// 去重、在飞去重）；读落地后若冷启动（首帧没带 pair）或根变化（工作区
// 切换），由 onChange 自补一帧——pair 的最终一致不依赖「恰好有下一个
// emit」。

/** workspace 对的 TTL（毫秒）——切换后 ≤TTL 内收敛；正常 2s 期内的帧不重读。 */
export const PET_WORKSPACE_TTL_MS = 2_000;

export interface PetWorkspaceSnapshot {
  readonly name: string;
  readonly path: string;
}

interface CachedWorkspace {
  readonly snapshot: PetWorkspaceSnapshot;
  readonly at: number;
}

/** The TTL cache: reads are synchronous (the frame path never awaits); the
 *  refresh is a fire-and-forget side effect. */
export function createPetWorkspaceCache(opts: {
  /** Absent = this driver has no workspace face (the old-driver degrade): the
   *  cache stays cold forever and frames never carry the pair. */
  readonly read?: () => Promise<{ readonly agentRoot?: unknown } | undefined> | undefined;
  /** Cold-start or root-change follow-up push (a second state frame once the
   *  read lands) — the cache is final-consistent without relying on the next
   *  natural emit. Recursive-safe: callers from a follow-up re-enter with a
   *  fresh cache, so this fires at most once per actual change. */
  readonly onChange: (s: PetWorkspaceSnapshot) => void;
  readonly now?: () => number;
}) {
  let cache: CachedWorkspace | null = null;
  let inFlight = false;
  const now = opts.now ?? Date.now;

  const refresh = (): void => {
    if (opts.read === undefined) return; // 无 workspace 面：缓存恒冷（旧形状钉）
    if (inFlight) return;
    if (cache !== null && now() - cache.at < PET_WORKSPACE_TTL_MS) return;
    inFlight = true;
    const prevPath = cache?.snapshot.path;
    void Promise.resolve(opts.read())
      .then(
        (r) => {
          const root = r?.agentRoot;
          if (typeof root !== "string" || root === "") return;
          cache = { snapshot: { name: basenameOf(root), path: root }, at: now() };
          if (prevPath !== root) opts.onChange(cache.snapshot);
        },
        () => { /* 坏读=保旧缓存：一次瞬态失败不清空已知值 */ },
      )
      .finally(() => { inFlight = false; });
  };

  return {
    /** The current pair, or undefined when cold (never a blocking read). */
    snapshot(): PetWorkspaceSnapshot | undefined {
      refresh();
      return cache?.snapshot;
    },
  };
}

// basename 抽局部（node:path 的 basename 在此单点用——index.ts 经拆分后
// 对该导入零依赖）。
function basenameOf(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}
