// ω99-279: #3 — 回收站式会话删除纯层（切换会话弹框的清理车道；
// session-search.ts 的同款兄弟）。删除 = 原子 rename 进 sessions 目录的
// .trash/ 子目录——同文件系统、可恢复（文件原样，找得回来）、对
// store.list() 与 searchSessionFiles 双隐身（两车道都吃 readdir 平铺
// `*.jsonl` 的形状，子目录天然不可见——回收站隐身是形状的免费性质，不是
// 两处过滤代码）。绝不 rm、绝不批量、绝不目录级删除；side-*.jsonl 副链
// 留在原地（本就对两车道隐形；父会话删了它们成孤儿但无害）。
// ω99-283: #1 — 恢复纯层（279 承诺的「可恢复」补上通路）：restoreSessionFile
// 把 .trash/<id>.jsonl 用 link+unlink 搬回活区（link 是原子 no-overwrite——
// 目标已在不覆盖，失败方向安全；这正是选 link 而非 rename 的理由：rename
// 会静默覆盖目标=数据丢失）。listTrashedSessions 是 .trash 的唯一读方
// （回收站列表，行构建复用 session-list 的同形状）。
import { mkdir, readFile, rename, link, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SESSION_ID_RE } from "@wudao-org/core";
import { collectSessionRows, type SessionRow } from "../session-list.js";

/** ω99-279（续，标记见上）— 删除结果：deleted=true 唯一成功形；false 三因（invalid-id
 * 形状拒 / not-found 收敛（重放安全——absent 即 goal state，与
 * settingsDeleteProvider 同一收敛裁定）/ active 活跃保护拒）。wire 语义入
 * web/src/protocol.ts 镜像。 */
export type SessionDeleteResult =
  | { readonly deleted: true }
  | { readonly deleted: false; readonly reason: "invalid-id" | "not-found" | "active" };

/** 回收站式删除：id 先过 SESSION_ID_RE 形状门 + side- 前缀拒（fail-closed，
 * 路径拼接前的第一道；防穿越是形状门的副产品——`../x` 过不了 RE）；
 * guardIds 含 id → active 拒（**不碰磁盘**——活跃会话是正在写的文件）；
 * `.trash` 幂等 mkdir 后 rename 进去；ENOENT → not-found。同名旧回收件
 * 覆盖无妨（会话 id 不复发）。 */
export async function deleteSessionFile(
  dir: string,
  id: string,
  opts: { readonly guardIds?: readonly string[] } = {},
): Promise<SessionDeleteResult> {
  // 形状门在最前：空 / 穿越形 / side- 副链形全拒，零磁盘触碰（.trash 都不建）。
  if (!SESSION_ID_RE.test(id) || id.startsWith("side-")) {
    return { deleted: false, reason: "invalid-id" };
  }
  // 活跃保护第二道：guardIds（当前主会话 + 活跃 pet 车道）内的 id 连
  // .trash 都不建——拒答必须不留痕迹。
  if (opts.guardIds !== undefined && opts.guardIds.includes(id)) {
    return { deleted: false, reason: "active" };
  }
  try {
    await mkdir(join(dir, ".trash"), { recursive: true }); // 幂等
    await rename(join(dir, `${id}.jsonl`), join(dir, ".trash", `${id}.jsonl`));
  } catch (e) {
    // 目标不存在 = 收敛拒（mid-flap 重放会走到这——absent 即 goal state）。
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { deleted: false, reason: "not-found" };
    throw e; // 其余（权限等基础设施错）诚实上抛
  }
  return { deleted: true };
}

/** ω99-281: #1 — 删除守卫的跨进程事实源：目标会话自己的 core lease 活性
 * （`<dir>/.leases/<id>.json` = acquireSessionLease 的独占创建锁，boot 与
 * 他进程 resume 都会持）。活 pid 在持 → true（正在写的会话，删了会让对方
 * 下一次 append 在原路径脏复活）；死 pid / 无锁 / 坏锁 → false——死锁本来
 * 就会被 acquire 偷回，不构成保护理由。判据与 core `src/session/lease.ts`
 * 的 isAlive 字面孪生（kill(pid,0) 活 / EPERM=存在但属他人=活 / 其余=死），
 * 不 import core 内部（isAlive 未导出；server PET_LANE 字面量同款先例）。
 * id 先过与 deleteSessionFile 同款形状门（SESSION_ID_RE + side- 前缀拒），
 * 坏 id 直接 false——不拼路径不读盘。 */
export async function sessionLeaseAlive(dir: string, id: string): Promise<boolean> {
  if (!SESSION_ID_RE.test(id) || id.startsWith("side-")) return false;
  let pid: unknown;
  try {
    pid = (JSON.parse(await readFile(join(dir, ".leases", `${id}.json`), "utf8")) as { pid?: unknown }).pid;
  } catch {
    return false; // ENOENT（无锁）/ 坏 JSON / 任何读异常 → 不活（fail-safe 不守）
  }
  if (typeof pid !== "number") return false; // 坏载荷（与 core readLock 同判）
  try {
    process.kill(pid, 0);
    return true; // 活（本进程或他进程在持）
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // 存在但属他人 = 活
  }
}

/** ω99-283（续，标记见上）— 恢复结果：restored=true 唯一成功形；false 三因
 * （invalid-id 形状拒 / not-found 收敛——回收件已不在（恢复过/手清），
 * 重放安全 / target-exists 目标已在不覆盖拒——活区同 id 会话在场，link
 * EEXIST 拒且其字节零变）。wire 语义入 web/src/protocol.ts 镜像。 */
export type SessionRestoreResult =
  | { readonly restored: true }
  | { readonly restored: false; readonly reason: "invalid-id" | "not-found" | "target-exists" };

/** 回收站恢复：id 先过与 deleteSessionFile 同款形状门（SESSION_ID_RE +
 * side- 前缀拒，坏 id 零盘触碰），然后 `link(<dir>/.trash/<id>.jsonl,
 * <dir>/<id>.jsonl)`——link 是原子 no-overwrite 原语：目标已在 → EEXIST →
 * target-exists（活区文件字节不变——rename 在这会静默覆盖=数据丢失，这是
 * 选 link+unlink 的全部理由）；源不在 → ENOENT → not-found。链接成功后
 * `unlink` 拆 .trash 副本（本产品唯一的 unlink——搬家收尾，非删数据；若
 * unlink 失败不影响结果：崩溃窗里的双份是安全冗余，不是丢失——下次恢复
 * 同 id 会落 target-exists，仍无覆盖）。无 guardIds：恢复永不破坏（占用
 * 由 target-exists 拒）。 */
export async function restoreSessionFile(dir: string, id: string): Promise<SessionRestoreResult> {
  // 形状门在最前：空 / 穿越形 / side- 副链形全拒，零磁盘触碰。
  if (!SESSION_ID_RE.test(id) || id.startsWith("side-")) {
    return { restored: false, reason: "invalid-id" };
  }
  try {
    await link(join(dir, ".trash", `${id}.jsonl`), join(dir, `${id}.jsonl`));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // 源不在 = 收敛拒（恢复过的重放会走到这——回收件已拆）。
    if (code === "ENOENT") return { restored: false, reason: "not-found" };
    // 目标已在 = no-overwrite 拒（活区字节零变——绝不覆盖）。
    if (code === "EEXIST") return { restored: false, reason: "target-exists" };
    throw e; // 其余（权限等基础设施错）诚实上抛
  }
  // 搬家收尾：拆 .trash 副本（产品代码唯一的 unlink）。失败吞掉——恢复
  // 已成功，双份是安全冗余非丢失（下次恢复同 id 落 target-exists）。
  try {
    await unlink(join(dir, ".trash", `${id}.jsonl`));
  } catch {
    // 崩溃窗冗余：留着不害（.trash 对两列表车道天然隐形）。
  }
  return { restored: true };
}

/** 回收站列表：readdir `.trash` 平铺 `*.jsonl`，按 mtime 降序取前 20，行
 * 构建复用 collectSessionRows（firstUser 折叠 / name / model 同款——前端
 * 行渲染零适配）。与 sessions()/searchSessions() 的双隐身对称：.trash 本
 * 就不在两车道的扫描面，本函数是唯一读它的人。`.trash` 不存在 → 空数组
 * （绝不建目录——拒答不留痕迹）。 */
export async function listTrashedSessions(dir: string): Promise<readonly SessionRow[]> {
  let names: readonly string[];
  try {
    names = await readdir(join(dir, ".trash"));
  } catch {
    return []; // 无 .trash（从未删过）→ 空回收站，不建目录
  }
  if (!names.some((n) => n.endsWith(".jsonl"))) return [];
  // collectSessionRows 的行构建原样复用（store 落在 .trash 上——loadSession
  // Entries/stat 都以它为根）；返回序是 store 的 oldest-first，这里翻成
  // mtime 降序（最近删/改的在前）再帽 20。
  const rows = await collectSessionRows(join(dir, ".trash"));
  rows.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return rows.slice(0, 20);
}
