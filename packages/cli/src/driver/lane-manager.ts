// 多 driver 并发弧 A（2026-09-16）— the lane manager: N concurrent driver
// sessions in ONE host process (a main lane + a pool of side lanes), each
// pinned to its own session id and its own lease slot.
//
// 设计依据 .superpowers/sdd/2026-09-16-multi-driver/recon.md §B/§E：
//   - B2  一个 driver 轮换会话 = 换血（历史 reset 重放 + 租约转移），
//         "多会话并发"只能多 driver——每车道固定（或各自轮换）自己的会话。
//   - B4  默认盒是根记忆化单 `current` 槽（lease.ts:171-217）：两个 driver
//         共用一个盒会互相释放对方的租约（ping-pong）。副车道全部走
//         core 的多槽盒（createMultiSlotLeaseBox）——每车道一个 laneView，
//         引擎 close 的无参 release() 只释放本车道槽。
//   - B1/E1 进程级单例（terminal sink / lsp / extension 工具面 / hooks 装配 /
//         schedules 守护 / cron.json 活实例 / memory.jsonl 并发写）每进程
//         只能一份——副车道照 pet 车道的降配清单（ui.ts:396-455）不带它们：
//         纯 loop + tools + 会话。
//   - E2  schedules/recovery 路由只看主车道（ui.ts 现状保持）：本管理器不
//         接触 schedules 守护与恢复协调器——副车道的 /schedule 与 cron 工具
//         走 inert refusal（schedule:undefined + cronDisabled）。
//
// 主车道 = ui.ts 的现有装配（本模块不重建、不代管、永不 close）；副车道 =
// 本模块按降配 preset 新建。server/web 的车道化（lane 表、帧 sid 寻址）是
// 后续弧——本模块是它们的生命周期地基。
import { join } from "node:path";
import { createJsonlSessionStore, activeBranchLeafKey, applySummaryMarkers, repairOrphanedToolCalls, resumeChain, createMultiSlotLeaseBox } from "@wudao/core";
import type { AgentMessage, MultiSlotSessionLeaseBox } from "@wudao/core";
import type { AgentDriver } from "./agent-driver.js";
import { createDriverSession } from "./session-engine.js";
import type { DriverSession, DriverSessionOptions } from "./session-engine.js";

/** A side lane's seat: the assembled session plus nothing else — the lease
 *  slot is tracked by the multi-slot box (keyed by the lane's session id),
 *  not duplicated here. */
interface LaneSeat {
  readonly session: DriverSession;
}

/** The lane lifecycle surface. `open`/`close` are async because lane
 *  assembly is (boot lease acquire + history load through the engine); the
 *  task sketch's sync shapes land here as Promises — the honest signature
 *  for "createDriverSession is awaitable". */
export interface LaneManager {
  /** Open (or return the already-open) lane for `sessionId`.
   *  Idempotent: a lane already open returns its existing driver; the MAIN
   *  lane's current id returns the main driver. A live foreign lease holder
   *  refuses the open (the engine's boot acquire throws — the same honest
   *  occupied receipt a double-opened `wudao ui` gets). */
  open(sessionId: string, opts?: Partial<DriverSessionOptions>): Promise<AgentDriver>;
  /** The open lane's driver — main lane's current id included; undefined
   *  when no lane holds that session. */
  get(sessionId: string): AgentDriver | undefined;
  /** Close ONE side lane: interrupt + dispose the session, release ITS
   *  lease slot (siblings untouched). The MAIN lane cannot be closed
   *  (throws). An unknown id is a no-op (idempotent close). */
  close(sessionId: string): Promise<void>;
  /** Every open lane id — the main lane's CURRENT id first, then the side
   *  lanes in open order. */
  activeLanes(): readonly string[];
  /** The main lane's driver — ui.ts's own assembly, never closed here. */
  main(): AgentDriver;
}

export interface LaneManagerOptions {
  /** The main lane: ui.ts's existing assembly. This module never closes,
   *  rebuilds, or routes through it beyond `main()`/`activeLanes()`. */
  readonly main: DriverSession;
  /** The side lanes' derivation base — the SAME DriverSessionOptions the
   *  host assembled the main lane from. The side-lane preset below layers
   *  the downgrade on top; base keys the preset pins are not overridable
   *  per-open (the process-singleton disciplines are not call-site options). */
  readonly base: DriverSessionOptions;
  /** The multi-slot lease box all side lanes share. Absent → one memoized
   *  box per sessions root (the core discipline — one coalescing/refusal
   *  surface per process). */
  readonly sessionLeases?: MultiSlotSessionLeaseBox;
  /** Test seam: the lane assembly factory. Absent → createDriverSession. */
  readonly spawnSession?: (opts: DriverSessionOptions) => Promise<DriverSession>;
}

/** The side-lane downgrade preset (the pet lane's list, ui.ts:396-455, plus
 *  the arc-A additions — memory disabled, own lease view). Every entry is a
 *  process-singleton or lane-isolation discipline; this object spreads LAST
 *  in open() so a caller's opts cannot smuggle any of it back in.
 *
 *  Not exported: the preset is an internal discipline, observed through
 *  LaneManager behavior (tests capture the spawn seam's received opts). */
function sideLanePreset(base: DriverSessionOptions): Partial<DriverSessionOptions> {
  return {
    // —— 进程单例工具面：不带 extraTools（terminal 的 setTerminalHistorySink
    // 是进程全局单例——第二会话挂载会偷走主会话的终端审计流；lsp/extension
    // 工具同理）。MCP 的 deferredTools 本就不进 DriverSessionOptions。
    extraTools: undefined,
    // —— hooks 装配面：会话级装配，副车道不挂（hook 盒全数隔离）。
    hooks: undefined,
    fileChangeTargets: undefined,
    configSkillsPath: undefined,
    hookRuntime: undefined,
    rewakeSink: undefined,
    promptIdBox: undefined,
    sessionIdBox: undefined,
    hookWarnSink: undefined,
    // —— schedules 守护：durable 面（.wudao/schedules.json 单 store）是主窗
    // 独占；副车道的 /schedule 走 absent-seam 零表面，cron 工具走 inert
    // refusal（cronDisabled）——一个 .wudao/cron.json 只许一个活实例。
    schedule: undefined,
    cronDisabled: true,
    // —— memory runtime：workspace 全局文件（recon E1——pet 先例 N=1 容忍了
    // 它），N 副车道各自 refresh/pending 写会放大并发写面 → inert。
    memoryDisabled: true,
    // —— 插件面随主车道；read-state 表车道隔离；agentRootBox 车道私有（缺省
    // 即引擎的私有盒钉 workspaceRoot——主车道 agentRootSwitch 不牵动副车道）。
    pluginCommands: undefined,
    pluginAgents: undefined,
    extensions: undefined,
    readState: undefined,
    agentRootBox: undefined,
    // —— 主窗 boot 面不重复进副车道。
    bootNotices: undefined,
    trustSuppressed: undefined,
    webDoctor: undefined,
    // —— 启动提示走 stderr（操作员道，不混主窗 banner）。
    startupNotice: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
    // —— sidecar 进程级共享（pet 同款）：check 无会话态（纯函数分类器），
    // breaker 进程级共享是诚实语义（高危连击熔断对所有车道一起生效）。
    sidecar: base.sidecar,
    // —— mode 恒 auto：车道=托付（pet ω99-270 同判——副车道没有自己的权限卡
    // UI，workspace/ask 档的 pendingPermission 会无人应答挂死 run）。安全边界
    // 不变：layers 1-4 运营 deny 规则照管、bypass 免疫安全检查照跑。
    defaultPermissionMode: "auto",
  };
}

/** Load a session's resumable history (the pet lane's exact recipe, ui.ts
 *  380-387: branch-walk → chain-aware summary projection → orphan repair).
 *  Zero messages / no file → undefined (the lane opens FRESH — the ω99-211
 *  deferred materialization then keeps an never-used lane off disk). */
async function loadLaneHistory(sessionsDir: string, sessionId: string): Promise<AgentMessage[] | undefined> {
  const store = createJsonlSessionStore(sessionsDir);
  const entries = await store.loadSessionEntries(sessionId);
  const messages = entries.filter((e): e is AgentMessage => "role" in e);
  if (messages.length === 0) return undefined;
  return repairOrphanedToolCalls(applySummaryMarkers(resumeChain(messages, activeBranchLeafKey(entries)), { chain: true }));
}

export function createLaneManager(props: LaneManagerOptions): LaneManager {
  const { main, base } = props;
  const sessionsDir = join(base.workspaceRoot, ".wudao", "sessions");
  const multiBox = props.sessionLeases ?? createMultiSlotLeaseBox(sessionsDir);
  const spawnSession = props.spawnSession ?? createDriverSession;
  const preset = sideLanePreset(base);
  const lanes = new Map<string, LaneSeat>();

  const mainId = (): string => main.driver.getSessionId();

  return {
    async open(sessionId, opts) {
      // Idempotent by id, main lane included: opening the main lane's
      // CURRENT id hands back the main driver (the lane already exists).
      if (sessionId === mainId()) return main.driver;
      const existing = lanes.get(sessionId);
      if (existing !== undefined) return existing.session.driver;

      const history = await loadLaneHistory(sessionsDir, sessionId);
      const session = await spawnSession({
        ...base,
        ...(opts ?? {}),
        // The preset spreads LAST: the downgrade disciplines are not
        // call-site options, and the lane's own identity keys pin after it.
        ...preset,
        sessionId,
        resumeHistory: history,
        sessionFresh: history === undefined,
        // One view per lane: the engine close()'s no-arg release() then
        // frees ONLY this lane's slot (the multi-slot box contract).
        sessionLeases: multiBox.laneView(),
      });
      lanes.set(sessionId, { session });
      return session.driver;
    },

    get(sessionId) {
      if (sessionId === mainId()) return main.driver;
      return lanes.get(sessionId)?.session.driver;
    },

    async close(sessionId) {
      if (sessionId === mainId()) {
        throw new Error(`主车道不可关闭（${sessionId} 是主车道当前会话）——主车道随宿主进程存亡，LaneManager 只关副车道`);
      }
      const lane = lanes.get(sessionId);
      if (lane === undefined) return; // idempotent close of an unknown lane
      // Delete BEFORE awaiting close: a concurrent open() of the same id
      // must not observe the dying seat as "already open".
      lanes.delete(sessionId);
      try {
        // interrupt + dispose + the laneView's release() (this lane's slot).
        await lane.session.close();
      } finally {
        // Belt-and-suspenders: an explicit per-id release covers any future
        // in-lane id rotation (releaseId is idempotent, generation-scoped).
        await multiBox.releaseId(sessionId);
      }
    },

    activeLanes() {
      return [mainId(), ...lanes.keys()];
    },

    main() {
      return main.driver;
    },
  };
}
