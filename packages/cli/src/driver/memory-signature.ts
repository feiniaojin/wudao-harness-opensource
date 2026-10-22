// 借鉴弧 α2 顺带拆分（文件行数棘轮「把压力推向拆分」）：记忆库内容签名三件
// 套从 agent-driver 闭包外提为自有小状态机——253/255 缓存读纪律逐字保留
//（VALUE 骑 DriverStatus；emit 只经注入的回调）。签名是一次 load() 上的
// 单调量 `count:pending:maxVersion`：每个写动词至少动一项——write（count+1）、
// update（maxVersion+1，内容链）、remove（count-1）、confirm（pending-1——
// 控制器两项速写漏的项：纯状态翻转既不动 count 也不动 maxVersion，没有
// pending 项的话 decide-ok 对发起它的面板不可见）；读侧遥测（bumpHits）与
// 一次性提醒簿记（markSurfaced）设计上什么都不动。知识落点：boot 读、run
// 结算边界（其他窗口的写在彼处可见——中间不轮询）、各记忆 op 闭包的着陆
//（本进程的写即时反映）。单调 seq 保最后知识站立；值不变不重发。
import type { MemoryEntryMirror } from "./types.js";

/** The tracker's live face over one driver closure. */
export interface MemorySignatureTracker {
  /** The current signature (undefined = never read / no store — the status
   *  field stays absent, zero signal). */
  current(): string | undefined;
  /** Direct knowledge — supersedes any in-flight read; unchanged values
   *  never re-emit. */
  setCached(sig: string | undefined): void;
  /** The pure derivation `${count}:${pending}:${maxVersion}`. */
  compute(entries: readonly MemoryEntryMirror[]): string;
  /** Best-effort store read (a failed read keeps the current face; a
   *  superseded read lands nothing). No workspaceRoot → no-op. */
  refresh(): Promise<void>;
}

export function createMemorySignatureTracker(opts: {
  readonly workspaceRoot?: string;
  readonly emit: () => void;
  readonly openStore: (workspaceRoot: string) => { load(): Promise<readonly MemoryEntryMirror[]> };
}): MemorySignatureTracker {
  let signature: string | undefined;
  let seq = 0;
  const compute = (entries: readonly MemoryEntryMirror[]): string => {
    let pending = 0;
    let maxVersion = 0;
    for (const e of entries) {
      if (e.status === "pending") pending += 1;
      const v = e.version ?? 1;
      if (v > maxVersion) maxVersion = v;
    }
    return `${entries.length}:${pending}:${maxVersion}`;
  };
  const self: MemorySignatureTracker = {
    current: () => signature,
    setCached(sig) {
      seq += 1; // direct knowledge — supersedes any in-flight read
      if (sig === signature) return; // unchanged — no frame
      signature = sig;
      opts.emit();
    },
    compute,
    async refresh() {
      if (opts.workspaceRoot === undefined) return; // no store — the field stays absent (zero signal)
      const mine = ++seq;
      try {
        const entries = await opts.openStore(opts.workspaceRoot).load();
        if (mine !== seq) return; // superseded by newer knowledge
        self.setCached(compute(entries));
      } catch {
        /* best-effort — a failed read keeps the current face */
      }
    },
  };
  return self;
}
