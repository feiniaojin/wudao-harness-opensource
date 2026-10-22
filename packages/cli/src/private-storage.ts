// ω99-2b — 私有存储原语（the upstream project core/private_storage.py 的 TS 移植）。
//
// 文件层 0600 早已在 credentials.ts / mcp/tokens.ts 落实（tmp+rename+chmod）；
// 这一层补齐**目录与跨平台**面：
//   - 目录 0700：`mkdir(recursive)` 吃默认 umask（桌面系统常见 0022），
//     `~/.wudao/` 常见 0755 —— 这里逐组件 mkdir(0700)+chmod(0700)，且只收紧
//     **本次新建**的组件（the upstream project was_missing 语义：已存在目录重复 icacls
//     每次白跑两个子进程）。
//   - Windows：chmod 是 no-op（无强制 POSIX 位）—— icacls 先 grant 当前用户
//     再 strip 继承（fail-safe：grant 失败则继承 ACL 原样保留，路径仍可用），
//     最后 best-effort 移除三个宽泛内置 SID。
//   - 目录链接（symlink/junction）：拒绝 —— `~/.wudao` 若被指向攻击者目录，
//     密钥文件会写进攻击者树。
//
// 明确不做（控制器裁决）：the upstream project 的 O_NOFOLLOW + lstat/samestat 私有 fd
// 竞态检查 —— Node 侧 rename-over 语义（落在链接上即替换链接本身）+ 父链
// 目录链接拒绝已覆盖实际威胁面，fd 级 identity dance 在 TS 里成本高收益低。
import { execFile as execFileCb, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/** 父链（或目标自身）是目录链接 / 非常规路径 —— fail-closed 拒绝写入。 */
export class UnsafePrivatePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePrivatePathError";
  }
}

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Windows runner DI 缝（测试注入假 runner 断言 icacls 编排，绝不真跑；
 *  真实默认走 System32 icacls）。boolean = 子进程是否成功。 */
export interface WindowsAclRunner {
  run(cmd: string, args: readonly string[]): Promise<boolean>;
}

export interface PrivateStorageOpts {
  /** true = 连已存在路径也收紧（修复遗留树）。 */
  readonly force?: boolean;
  /** 测试注入 "win32"；默认 process.platform。 */
  readonly platform?: NodeJS.Platform;
  /** 测试注入；缺省用真实 icacls runner。 */
  readonly winRunner?: WindowsAclRunner;
}

/** icacls `/remove` 的三个宽泛内置主体（the upstream project 同款）：Everyone /
 *  Authenticated Users / BUILTIN\Users。`*` 前缀 = 按 SID 指定（locale 无关）。 */
const WINDOWS_BROAD_ACCESS_SIDS = ["*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"] as const;

/** 不查 PATH —— System32 直连（PATH 上的假 icacls 是提权面）。 */
function icaclsExecutable(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
}

interface AclStep {
  readonly args: readonly string[];
  /** true = 该步失败即停（只有 grant —— 失败时继承 ACL 原样保留）。 */
  readonly haltOnFailure: boolean;
}

/** 一次 ACL 收紧的三步命令：grant 当前用户 → strip 继承 → best-effort 移除
 *  宽泛 SID。先 grant 后 strip 是 fail-safe 顺序（strip-first 可能把路径收
 *  到没有任何可用 ACE，打不开）。(OI)(CI) 仅目录 —— 文件上的对象继承标志
 *  是 icacls 错误。inheritance 失败不停：remove 针对显式遗留 ACE，无害。 */
function aclSteps(path: string, isDir: boolean, principal: string): readonly AclStep[] {
  return [
    { args: [path, "/grant:r", `${principal}:${isDir ? "(OI)(CI)" : ""}F`], haltOnFailure: true },
    { args: [path, "/inheritance:r"], haltOnFailure: false },
    { args: [path, "/remove", ...WINDOWS_BROAD_ACCESS_SIDS], haltOnFailure: false },
  ];
}

/** 当前主体（whoami 输出，DOMAIN\user 形态），模块级缓存一次；失败 →
 *  undefined（fail-safe：拿不到主体就不动 ACL，路径仍可用）。 */
let cachedWhoami: Promise<string | undefined> | undefined;
function whoamiPrincipal(): Promise<string | undefined> {
  cachedWhoami ??= execFile("whoami", [], { timeout: 15_000 })
    .then((r) => (r.stdout.trim() !== "" ? r.stdout.trim() : undefined))
    .catch(() => undefined);
  return cachedWhoami;
}

/** 同步孪生（writePrivateFileSync / ensurePrivateDirectory / harden 私有树
 *  的 win32 面不得挂起等 execFile）。 */
let cachedWhoamiSync: string | undefined | null = null; // null = 未解析
function whoamiPrincipalSync(): string | undefined {
  if (cachedWhoamiSync === null) {
    try {
      const r = spawnSync("whoami", [], { timeout: 15_000, encoding: "utf8" });
      cachedWhoamiSync = (r.stdout ?? "").trim() !== "" ? (r.stdout ?? "").trim() : undefined;
    } catch {
      cachedWhoamiSync = undefined;
    }
  }
  return cachedWhoamiSync;
}

/** 注入 runner 时的主体来源：同步 Node API，不 spawn（DI 测试连 whoami 都
 *  不跑 —— principal 取值不在被测面，测试断言用 `\S+:` 匹配）。 */
function userInfoPrincipal(): string | undefined {
  const name = userInfo().username;
  return name.trim() !== "" ? name : undefined;
}

/** 真实默认 runner：execFile 直连，exit 0 = 成功；任何失败 → false。 */
function defaultWindowsRunner(): WindowsAclRunner {
  return {
    run: (cmd, args) => execFile(cmd, args, { timeout: 15_000 }).then(() => true, () => false),
  };
}

function runIcaclsSync(cmd: string, args: readonly string[]): boolean {
  try {
    return spawnSync(cmd, args, { timeout: 15_000 }).status === 0;
  } catch {
    return false;
  }
}

/** 异步 ACL 编排（writePrivateFile 等异步面）。principal：默认 runner 路径
 *  走 whoami（缓存一次；失败直接 return）；注入 runner 时不 spawn。 */
async function restrictWindowsAcl(
  path: string,
  isDir: boolean,
  runner: WindowsAclRunner,
  opts: PrivateStorageOpts,
): Promise<void> {
  const injected = opts.winRunner !== undefined;
  const principal = injected ? userInfoPrincipal() : await whoamiPrincipal();
  if (principal === undefined) return;
  for (const step of aclSteps(path, isDir, principal)) {
    const ok = await runner.run(icaclsExecutable(), step.args);
    if (!ok && step.haltOnFailure) return; // grant 失败：继承 ACL 原样保留
  }
}

/** 同步 ACL 编排（默认 runner 的 spawnSync 面）。注入的异步 runner 在同步
 *  上下文里拿不到同步布尔 → 跳过（DI 是异步面的测试缝）。 */
function restrictWindowsAclSync(path: string, isDir: boolean, opts: PrivateStorageOpts): void {
  if (opts.winRunner !== undefined) return;
  const principal = whoamiPrincipalSync();
  if (principal === undefined) return;
  for (const step of aclSteps(path, isDir, principal)) {
    if (!runIcaclsSync(icaclsExecutable(), step.args) && step.haltOnFailure) return;
  }
}

function isEExists(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "EEXIST";
}

/** POSIX 收紧核心：向上收集缺失组件直到已存在祖先；lstat 该祖先（不跟最后
 *  一段链接）——symlink → 拒。自上而下逐个 mkdir(0700)+chmod(0700)。返回
 *  本次新建的组件（浅→深）与 dir 是否原本就存在。win32 ACL 由调用方编排
 *  （同步 spawnSync / 异步注入 runner 两条路），这里不碰子进程。 */
function createPrivateComponents(
  dir: string,
  opts: PrivateStorageOpts,
): { readonly created: readonly string[]; readonly dirExisted: boolean } {
  const missing: string[] = [];
  let cursor = dir;
  while (!existsSync(cursor) && cursor !== dirname(cursor)) {
    missing.push(cursor);
    cursor = dirname(cursor);
  }
  // 停在一个已存在的祖先上；lstat 只看它的最后一段（锚点自身是链接 → 拒，
  // 且发生在任何 mkdir 之前 —— 拒绝不能顺手把子目录建进链接目标）。锚点
  // 之上的更浅组件**不**逐段检查：macOS 的 /tmp→/private/tmp、
  // /var→/private/var 是系统级链接，逐段拒绝会废掉一切 tmpdir 用法；锚点
  // 之上的世界本就不是这次要收紧的范围（the upstream project 同款“到 exists 为止”）。
  if (lstatSync(cursor).isSymbolicLink()) {
    throw new UnsafePrivatePathError(
      `private storage path component is a directory link: ${cursor} (refusing to create ${dir})`,
    );
  }
  // 向上收集时最深的缺失组件恒是 dir 自身 → dir 缺失 ⟺ missing 非空。
  const dirExisted = missing.length === 0;
  const created: string[] = [];
  for (const component of missing.reverse()) {
    try {
      mkdirSync(component, { mode: PRIVATE_DIR_MODE });
    } catch (err) {
      if (!isEExists(err)) throw err;
      // 竞态窗口里冒出来的组件：链接 → 拒（fail-closed）。
      if (lstatSync(component).isSymbolicLink()) {
        throw new UnsafePrivatePathError(
          `private storage path component is a directory link: ${component} (refusing to create ${dir})`,
        );
      }
    }
    chmodSync(component, PRIVATE_DIR_MODE); // umask 可能剥位（某些平台 mkdir 不完全尊重 mode）—— 显式兜底
    created.push(component);
  }
  // the upstream project was_missing 语义：已存在且未 force → 不动（chmod 与 icacls 都
  // 不重复）；force → 连已存在的最终目录也收紧（修复遗留树）。
  if (opts.force === true && dirExisted) chmodSync(dir, PRIVATE_DIR_MODE);
  return { created, dirExisted };
}

/** 创建 dir 并让**本次新建**的每个组件 user-private（0700）。已存在且未
 *  force → 不动。返回 dir。任一已存在锚组件是目录链接 → 抛
 *  UnsafePrivatePathError（消息含该路径）。 */
export function ensurePrivateDirectory(dir: string, opts: PrivateStorageOpts = {}): string {
  const { created, dirExisted } = createPrivateComponents(dir, opts);
  if ((opts.platform ?? process.platform) === "win32") {
    for (const component of created) restrictWindowsAclSync(component, true, opts);
    if (opts.force === true && dirExisted) restrictWindowsAclSync(dir, true, opts);
  }
  return dir;
}

/** ensurePrivateDirectory 的异步孪生（writePrivateFile 的目录面）：win32 上
 *  用 execFile / 注入 runner 编排 ACL，不阻塞事件循环。 */
async function ensurePrivateDirectoryAsync(dir: string, opts: PrivateStorageOpts): Promise<string> {
  const { created, dirExisted } = createPrivateComponents(dir, opts);
  if ((opts.platform ?? process.platform) === "win32") {
    const runner = opts.winRunner ?? defaultWindowsRunner();
    for (const component of created) await restrictWindowsAcl(component, true, runner, opts);
    if (opts.force === true && dirExisted) await restrictWindowsAcl(dir, true, runner, opts);
  }
  return dir;
}

/** 同目录 tmp（pid 后缀 —— 与 settings 层原子写同款，credentials 的 M2 复审
 *  测试锚定了这个名字）以 0600 创建 → rename → chmod(0600)：新建即私紧、
 *  rename 前崩溃也只滞留 owner-only 文件、chmod 修复被编辑器/恢复工具放松
 *  过的旧路径。rename 落在 symlink 上会替换链接本身（不跟随）—— 这正是
 *  要的：一次写入就把“路径被链接劫持”的旧状态清掉。 */
export async function writePrivateFile(
  path: string,
  data: string,
  opts: PrivateStorageOpts = {},
): Promise<void> {
  await ensurePrivateDirectoryAsync(dirname(path), opts);
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  await rename(tmp, path);
  chmodSync(path, PRIVATE_FILE_MODE); // writeFile 的 mode 只在新建时生效 —— 显式兜底
  if ((opts.platform ?? process.platform) === "win32") {
    // rename 后这是一个全新 inode（继承自父目录 ACL 之外无显式条目）→ 每次写
    // 都收紧文件自身（the upstream project open-on-create 同款）。
    await restrictWindowsAcl(path, false, opts.winRunner ?? defaultWindowsRunner(), opts);
  }
}

/** 同步孪生（同原子 + 0600 + 链接替换语义）。 */
export function writePrivateFileSync(
  path: string,
  data: string,
  opts: PrivateStorageOpts = {},
): void {
  ensurePrivateDirectory(dirname(path), opts);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  renameSync(tmp, path);
  chmodSync(path, PRIVATE_FILE_MODE); // mode 只在新建时生效 —— 显式兜底
  if ((opts.platform ?? process.platform) === "win32") {
    restrictWindowsAclSync(path, false, opts);
  }
}

/** 修复一棵 wudao 自有的树（force 语义照 opts；root 自身是 symlink → 抛，
 *  由 ensure 的锚点 lstat 拒绝）。readdir 递归**不跟链接**：真目录 chmod
 *  0700（win32 上仅 force 才动 ACL —— 遗留树修复是显式意图）；常规文件
 *  chmod 0600；symlink 条目不递归不 chmod（遍历边界），计入 links；其余
 *  非常规条目（socket/fifo/设备）跳过。返回收紧计数。 */
export function hardenPrivateTree(
  root: string,
  opts: PrivateStorageOpts = {},
): { dirs: number; files: number; links: number } {
  ensurePrivateDirectory(root, opts);
  const winAcl = (opts.platform ?? process.platform) === "win32" && opts.force === true;
  let dirs = 0;
  let files = 0;
  let links = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      // Node 的 lstat/readdir 把 junction 也按 symlink 报 —— 一并拒入遍历。
      if (entry.isSymbolicLink()) {
        links++;
        continue;
      }
      if (entry.isDirectory()) {
        chmodSync(p, PRIVATE_DIR_MODE);
        if (winAcl) restrictWindowsAclSync(p, true, opts);
        dirs++;
        walk(p);
      } else if (entry.isFile()) {
        chmodSync(p, PRIVATE_FILE_MODE);
        if (winAcl) restrictWindowsAclSync(p, false, opts);
        files++;
      }
    }
  };
  chmodSync(root, PRIVATE_DIR_MODE); // root 本身也在收紧面（the upstream project os.walk 含 base）
  if (winAcl) restrictWindowsAclSync(root, true, opts);
  dirs++;
  walk(root);
  return { dirs, files, links };
}
