// ω99-104 — the main-window side of drop-to-delegate (P1 首弧). 把文件拖到
// 宠物身上 = 把任务交给 agent：Rust 收到宠物窗的原生 DragDrop，把路径放
// 进 30s TTL 白名单并广播 pet-file-drop；本模块是接收半边——解析载荷、按
// 文件通道的限额预检，然后串行地 read_dropped_file。
// ω99-119 — 终点换 staging seam：drop 不再「立即 fileSave + 自动 submit 一句
// 固定文案」——读回的字节铸成 ComposerFileDraft 草稿（真 File 持有），经
// onStaged 回调交给 App（默认路由给 setPetDropStageSink 注册的 sink →
// fileSeed → 输入框文件卡 + 意图 chips）；fileSave/submit 移交 composer
// 自有附件轨，submit 时才存盘（隐私对齐图片轨 M79b 构造性语义）。
// 任一步失败：console.warn 后静默放弃（chips 行本身就是回执；宠物会在
// agent 转忙时自然亮 busy 帧）。PURE TS — no React, no CSS import: the
// main-shell entry pulls this into its index chunk, so it must stay light
// (type-only imports of protocol).
import { tauriInvokeCommand, tauriListenEvent } from "./tauri-invoke.js";
import { MAX_COMPOSER_FILES, MAX_FILE_BUDGET_BYTES, base64LengthOf, createFileDraft } from "./attachments.js";
import type { ComposerFileDraft } from "./attachments.js";
import type { WudaoClient } from "./protocol.js";

/** 与 Rust 端 PET_FILE_DROP_EVENT 同名（有测试钉住）。 */
export const WUDAO_PET_DROP_EVENT = "pet-file-drop";

/** 单文件门 20MiB——镜像 Rust 端 MAX_DROP_FILE_BYTES（严格大于，恰等不拒）。
 *  在 invoke 前预检，省掉注定失败的 IPC 往返。 */
export const MAX_DROP_FILE_BYTES = 20 * 1024 * 1024;

/** Rust 广播的一条拖入文件（path 绝对路径 + 显示名 + 字节数元数据——JS
 *  自己 stat 不了盘，bytes 由 Rust 端 fs::metadata 填好）。 */
export interface DroppedFileWire {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
}

/** 事件载荷形状守卫：{paths:[{path,name,bytes},…]}。非对象 / 无 paths /
 *  非数组 / 空数组 → null（事件被忽略）；坏条目只跳过自身，好条目照常
 *  通过——一个畸形条目不该毁掉整批拖入。 */
export function parseDropPayload(p: unknown): readonly DroppedFileWire[] | null {
  if (typeof p !== "object" || p === null) return null;
  const raw = (p as { paths?: unknown }).paths;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: DroppedFileWire[] = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const { path, name, bytes } = e as { path?: unknown; name?: unknown; bytes?: unknown };
    if (typeof path !== "string" || typeof name !== "string" || typeof bytes !== "number") continue;
    out.push({ path, name, bytes });
  }
  return out.length > 0 ? out : null;
}

/** 投递准入的拒绝种类：单文件超限 / 数量超限 / 批量 base64 预算超限。 */
export type DroppedRejectionKind = "oversize" | "count" | "budget";

/** 客户端预检（镜像 attachments.ts 文件通道的语义，单文件门另加）。返回
 *  null = 可入列；纯函数，通知面归调用方。 */
export function droppedRejectionKind(
  file: { readonly bytes: number },
  current: readonly { readonly byteLength: number }[],
): DroppedRejectionKind | null {
  if (file.bytes > MAX_DROP_FILE_BYTES) return "oversize";
  if (current.length >= MAX_COMPOSER_FILES) return "count";
  const budget = current.reduce((sum, d) => sum + base64LengthOf(d.byteLength), 0) + base64LengthOf(file.bytes);
  if (budget > MAX_FILE_BUDGET_BYTES) return "budget";
  return null;
}

/** 批量准入——逐个对着 GROWING 轨道预检（同 admitFileBatch：先收的计入
 *  后来者的限额）。返回可入列的文件 + 列出每一种拒绝的 notice（无拒绝则
 *  null）。 */
export function admitDroppedFiles(
  files: readonly DroppedFileWire[],
  current: readonly { readonly byteLength: number }[],
): { readonly accepted: readonly DroppedFileWire[]; readonly notice: string | null } {
  const accepted: DroppedFileWire[] = [];
  const rail: { byteLength: number }[] = [...current];
  const counts = new Map<DroppedRejectionKind, number>();
  for (const f of files) {
    const kind = droppedRejectionKind(f, rail);
    if (kind === null) {
      accepted.push(f);
      rail.push({ byteLength: f.bytes });
    } else {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return { accepted, notice: null };
  const parts: string[] = [];
  for (const kind of ["oversize", "count", "budget"] as const) {
    const n = counts.get(kind);
    if (n === undefined) continue;
    if (kind === "oversize") parts.push(`${n} 个超出单文件 20MiB 上限`);
    else if (kind === "count") parts.push(`${n} 个超出数量上限(最多同时附加 ${MAX_COMPOSER_FILES} 个)`);
    else parts.push(`${n} 个超出批量 50MiB 上限`);
  }
  return { accepted, notice: `⚠️ ${parts.join(" · ")}` };
}

/** 默认指令文案随 ω99-119 终点改造移除：drop 不再自动发模糊默认句，
 *  明确意图由 A 层 drop-intent.ts 的建议 chips 承担（点击=填文本+发送）。 */

/** base64 → bytes（atob——jsdom/浏览器皆有；screenshot-ask.ts 同款本地镜像，
 *  不为它动 attachments.ts 的私有面）。 */
function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 管线依赖——全部可注入，测试用假件跑通全链。 */
export interface DropPipelineDeps {
  readonly readDroppedFile: (path: string) => Promise<string>;
  /** 终点 seam（ω99-119）：staged 草稿一批回调。生产默认路由给
   *  setPetDropStageSink 注册的 App sink；测试注入假件断言形状。 */
  readonly onStaged: (drafts: readonly ComposerFileDraft[]) => void;
  readonly warn: (...args: unknown[]) => void;
}

/** 串行逐文件：读（一个落定下一个才开始）→ base64 铸真 File →
 *  ComposerFileDraft 草稿 → 幸存者一次批量 onStaged。单文件读失败 warn
 *  后跳过（其余继续）；全灭 / onStaged 抛 → warn 后静默放弃，永不抛。 */
export async function delegateDroppedFiles(deps: DropPipelineDeps, files: readonly DroppedFileWire[]): Promise<void> {
  const drafts: ComposerFileDraft[] = [];
  for (const f of files) {
    try {
      const data = await deps.readDroppedFile(f.path);
      drafts.push(createFileDraft(new File([decodeBase64(data)], f.name)));
    } catch (e) {
      deps.warn(`pet drop: skipping ${f.name} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (drafts.length === 0) return;
  try {
    deps.onStaged(drafts);
  } catch (e) {
    deps.warn(`pet drop: onStaged failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** 默认 readDroppedFile：走 tauri-invoke 的 command 缝。null（无桥/拒绝）
 *  或非字符串 → 抛（管线按单文件失败跳过——白名单过期/超限都走这里）。 */
async function readViaCommand(path: string): Promise<string> {
  const r = await tauriInvokeCommand("read_dropped_file", { path });
  if (typeof r !== "string") throw new Error(`read_dropped_file refused ${path}`);
  return r;
}

/** mount 依赖（管线依赖 + listen）。 */
export interface DropMountDeps extends DropPipelineDeps {
  readonly listen: (e: string, h: (p: unknown) => void) => Promise<(() => void) | null> | null;
}

/** ω99-119 App 桥：mount 在 React 外（main.tsx），App 在 effect 里注册
 *  sink（staged 草稿 → parkedFilesRef 合并 + setFileSeed），unmount 注销。
 *  后注册者胜；未注册（App 未挂/已卸）→ 默认 onStaged 走 warn 静默放弃。 */
export type PetDropStageSink = (drafts: readonly ComposerFileDraft[]) => void;
let stageSink: PetDropStageSink | null = null;
export function setPetDropStageSink(sink: PetDropStageSink | null): void {
  stageSink = sink;
}

/** 挂上主窗：listen pet-file-drop → 解析 → 预检（notice 走 warn，幸存者
 *  继续）→ 入队执行管线（终点 onStaged → App sink → fileSeed → 输入框
 *  文件卡 + 意图 chips）。跨事件同样串行（一个 drop 的管线落定前，下一
 *  个的 read 不开始——连击拖放不并发轰 IPC）。浏览器（listen → null）静
 *  默无跨窗。返回 unmount（unlisten；晚到的 listen 落定也被收回）。
 *  `client` 参数保留（ω99-104 调用面不变——main.tsx 原样传递）；管线终
 *  点改 staging 后它不再被默认路径使用。 */
export function mountPetDropFiles(client: Pick<WudaoClient, "fileSave" | "submit">, deps?: Partial<DropMountDeps>): () => void {
  const warn = deps?.warn ?? ((...args: unknown[]) => console.warn(...args));
  const d: DropMountDeps = {
    readDroppedFile: deps?.readDroppedFile ?? readViaCommand,
    onStaged:
      deps?.onStaged ??
      ((drafts) => {
        if (stageSink === null) {
          warn("pet drop: no stage sink (App not mounted)");
          return;
        }
        stageSink(drafts);
      }),
    warn,
    listen: deps?.listen ?? ((e, h) => tauriListenEvent(e, h)),
  };
  let unlisten: (() => void) | null = null;
  let dead = false;
  let queue: Promise<void> = Promise.resolve(); // 跨事件串行锁
  void Promise.resolve(
    d.listen(WUDAO_PET_DROP_EVENT, (p) => {
      const files = parseDropPayload(p);
      if (files === null) return;
      const { accepted, notice } = admitDroppedFiles(files, []);
      if (notice !== null) d.warn(`pet drop: ${notice}`);
      if (accepted.length === 0) return;
      const batch = accepted; // 闭包快照——后续事件不会再动这份
      queue = queue
        .then(() => delegateDroppedFiles(d, batch))
        .catch(() => {}); // 管线内部已吞一切；这里兜底防御
    }),
  ).then((off) => {
    if (dead) off?.();
    else unlisten = off;
  });
  return () => {
    dead = true;
    unlisten?.();
  };
}
