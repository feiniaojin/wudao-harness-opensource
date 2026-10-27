// stop-tree — 停止协调器（长程任务的停止树协调，纯逻辑、零 IO）。
//
// 参考：openwork 的 opencode-interruption.ts（每 (baseUrl, sessionID) 一个
// Turn 协调器：generation 计数、在飞 submission、前台委派树递归停、abort
// 前读子会话验证属主、admission-unknown 对账、停后 withdrawRequests 把还
// 挂着的 question/permission 请求全部 reject）。wudao 版拆成两层：本文件
// 是纯状态机（谁注册谁停止、挂起请求归谁、admission 三态判定），IO（真
// 正的 abort / reject / 读会话）全部留在调用方（cli 的 driver 层包裹）——
// core 对 provider 与前端零依赖，loop.ts 不动。
//
// 三块语义（与 openwork 逐条对应）：
//  1. 停止树：registerChild 记录边 + 属主；requestStop 父→子递归收集（深
//     度上限 MAX_STOP_TREE_DEPTH=256），逐层校验属主链——parent/owner 不
//     匹配的子节点跳过并记 warn 事件（openwork 是抛错拒绝确认整个 Stop；
//     wudao 取保守跳过：一棵验证不过的子树留在原地，绝不误停别人名下的
//     会话，也不让一棵坏子树挡住整树其余节点的停止）。
//  2. 挂起请求回收（withdrawPending）：把停止树成员上挂着的 permission/
//     ask 请求全部列出，交调用方去 reject——「停干净」语义：abort 之后不
//     留僵尸确认框（openwork 的 withdrawRequests：被打断的工具已无法消费
//     答案，留着的只是一张没人能答的卡，每个 pane 里都还在问、重载后还
//     在问）。
//  3. admission 对账（admissionUnknown 三态）：只认「该 submission 有终
//     态 assistant 回复」为 accepted；发出后丢了回响（lost）≠ 没受理，绝
//     不重放——丢回响的 POST 仍可能稍后到达，盲目重发就是双发。
//
// 与 openwork 的两处有意偏差（决策记录）：
//  a. 属主校验失败 → openwork 抛「Could not verify the delegated session
//     owner. Stop was not confirmed.」；本协调器跳过 + warn（见上）。
//  b. openwork 的 256 上限是树内「会话总数」；本版按 wudao 设计取「深度
//     上限」（父→子层数），到达即截断该分支 + warn，已收集部分照常停。
//
// 事件流全程类型化（onEvent），监听器异常被隔离（观察者失败绝不影响状态
// 机——Events ≠ Hooks）。

/** 停止树递归收集的深度上限（父→子层数；root 为第 0 层）。 */
export const MAX_STOP_TREE_DEPTH = 256;

/** 挂起请求的种类（openwork 的 question/permission 两族——wudao 的 parked
 * permission ask 先落 "permission"，ask_user 类停泊问题落 "ask"）。 */
export type PendingRequestKind = "permission" | "ask";

/** 类型化事件流（onEvent 回调；五个规范名 + warn）。 */
export type StopTreeEvent =
  | { readonly type: "stop_requested"; readonly rootId: string; readonly generation: number }
  | {
      readonly type: "child_stopping";
      readonly rootId: string;
      readonly childId: string;
      readonly parentId: string;
      readonly generation: number;
      readonly childSessionId?: string;
    }
  | {
      readonly type: "stop_warn";
      readonly rootId: string;
      readonly code: "owner_mismatch" | "missing_record" | "depth_cap";
      readonly childId?: string;
      readonly detail: string;
    }
  | { readonly type: "requests_withdrawn"; readonly rootId: string; readonly requestIds: readonly string[] }
  | { readonly type: "admission_unknown"; readonly submissionId: string }
  | { readonly type: "tree_settled"; readonly rootId: string; readonly generation: number; readonly members: readonly string[] };

/** requestStop 的返回：本次停止计划（root 在首位、父先子后的 BFS 序快照）。 */
export interface StopTreePlan {
  readonly rootId: string;
  readonly generation: number;
  /** root 在首位，父先子后（BFS 序）。 */
  readonly members: readonly string[];
  /** 属主校验不过被跳过的子节点（保守停止——不在 members 里，也从不被等待）。 */
  readonly skipped: readonly { readonly childId: string; readonly code: "owner_mismatch" | "missing_record" }[];
}

/** 一条前台委派边：谁（parentId）在哪个属主（owner）名下派出了谁（childId）。
 *  owner 是属主链凭据（openwork 读子会话的 parentID/directory 校验；wudao
 *  由派生点在注册时声明，requestStop(rootId, owner) 整树校验一致性）。 */
interface ChildRecord {
  parentId: string;
  owner: string;
  childSessionId?: string;
  settled: boolean;
}

/** 一条挂起请求： memberId 是它停泊在哪个树成员上（回收按树成员圈定）。 */
interface PendingRecord {
  memberId: string;
  kind: PendingRequestKind;
  seq: number;
}

/** submission 的内部四态；对外投影为 admissionUnknown 的三态。 */
type AdmissionState = "unsent" | "sent" | "lost" | "terminal";

/** 活动停止计划（内部可变形态；对外快照是 StopTreePlan）。 */
interface ActivePlan {
  rootId: string;
  generation: number;
  members: string[];
  settledMembers: Set<string>;
  completed: boolean;
}

/**
 * 停止协调器——每会话一个实例（openwork 的 per-(baseUrl, sessionID) Turn
 * 协调器的 wudao 化身；driver 层持有，loop 不感知）。纯同步状态机：所有
 * 异步等待（在飞停止、子树空闲轮询）属于调用方，本类只裁决「停谁、收哪
 * 些挂起请求、admission 信不信」。
 */
export class StopCoordinator {
  private generation = 0;
  private readonly children = new Map<string, ChildRecord>();
  /** parentId → childId 集（收集用的索引；与 children 记录同步维护）。 */
  private readonly edges = new Map<string, Set<string>>();
  private readonly pending = new Map<string, PendingRecord>();
  private readonly submissions = new Map<string, AdmissionState>();
  private plan: ActivePlan | undefined;
  private pendingSeq = 0;
  private readonly onEvent: ((event: StopTreeEvent) => void) | undefined;

  constructor(options: { readonly onEvent?: (event: StopTreeEvent) => void } = {}) {
    this.onEvent = options.onEvent;
  }

  /** 观察者隔离：监听器抛错绝不影响状态机（Events ≠ Hooks）。 */
  private emit(event: StopTreeEvent): void {
    if (this.onEvent === undefined) return;
    try {
      this.onEvent(event);
    } catch {
      /* observer isolation */
    }
  }

  /** 一轮提交周期开始（driver 的 run 起点）：generation 递增，后续的停止
   *  计划都盖这个代号（openwork：后续发送凭 generation 识别「我等的那次
   *  打断已经结束了吗」）。 */
  beginTurn(): number {
    this.generation += 1;
    return this.generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  /** 注册一条前台委派边（派生点声明属主）。重注册（同一 childId 换父）会
   *  原子地搬边 + 重置 settled——callId 一次性，正常流程不触发。 */
  registerChild(parentId: string, childId: string, owner: string, childSessionId?: string): void {
    const prior = this.children.get(childId);
    if (prior !== undefined && prior.parentId !== parentId) {
      this.edges.get(prior.parentId)?.delete(childId);
    }
    this.children.set(childId, { parentId, owner, settled: false, ...(childSessionId !== undefined ? { childSessionId } : {}) });
    let edge = this.edges.get(parentId);
    if (edge === undefined) {
      edge = new Set();
      this.edges.set(parentId, edge);
    }
    edge.add(childId);
  }

  /** 成员停止落定（子节点或 root——root 的落定由调用方在 run 收束时上报）。
   *  全员落定（含 root）恰发一次 tree_settled。 */
  childSettled(childId: string): void {
    const record = this.children.get(childId);
    if (record !== undefined) record.settled = true;
    const plan = this.plan;
    if (plan === undefined || plan.completed) return;
    if (plan.members.includes(childId)) plan.settledMembers.add(childId);
    if (plan.members.every((m) => plan.settledMembers.has(m))) {
      plan.completed = true;
      this.emit({ type: "tree_settled", rootId: plan.rootId, generation: plan.generation, members: [...plan.members] });
    }
  }

  /** 活动计划（rootId 匹配时）是否全员落定。 */
  isTreeSettled(rootId: string): boolean {
    const plan = this.plan;
    return plan !== undefined && plan.rootId === rootId && plan.completed;
  }

  /**
   * 请求停止：父→子递归收集停止树（BFS，深度上限 MAX_STOP_TREE_DEPTH），
   * 逐层校验属主链（openwork「abort 前读子会话验证属主」——这里的凭据
   * 是注册时声明的 parent/owner，不匹配即跳过 + warn）。纯裁决：真正的
   * abort 动作由调用方按 members 执行。同一 root 的重复 requestStop 刷新
   * 活动计划（成员重新快照；settled 保留）。
   */
  requestStop(rootId: string, owner?: string): StopTreePlan {
    const generation = this.generation;
    this.emit({ type: "stop_requested", rootId, generation });
    const members: string[] = [rootId];
    const skipped: { childId: string; code: "owner_mismatch" | "missing_record" }[] = [];
    const settledMembers = new Set<string>();
    const visited = new Set([rootId]);
    const queue: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const edge = this.edges.get(node.id);
      if (edge === undefined) continue;
      for (const childId of edge) {
        if (visited.has(childId)) continue; // 环防御：每节点至多入树一次
        visited.add(childId);
        const record = this.children.get(childId);
        if (record === undefined) {
          // 边存在但记录缺失（注册面被绕过/畸形）——保守跳过。
          skipped.push({ childId, code: "missing_record" });
          this.emit({
            type: "stop_warn",
            rootId,
            code: "missing_record",
            childId,
            detail: `stop-tree 边 ${node.id}→${childId} 无属主记录，已跳过`,
          });
          continue;
        }
        if (record.parentId !== node.id || (owner !== undefined && record.owner !== owner)) {
          skipped.push({ childId, code: "owner_mismatch" });
          this.emit({
            type: "stop_warn",
            rootId,
            code: "owner_mismatch",
            childId,
            detail: `子节点 ${childId} 属主校验不过（记录 parent=${record.parentId} owner=${record.owner}，期望 parent=${node.id} owner=${owner ?? "（未声明）"}），已跳过`,
          });
          continue;
        }
        members.push(childId);
        this.emit({
          type: "child_stopping",
          rootId,
          childId,
          parentId: node.id,
          generation,
          ...(record.childSessionId !== undefined ? { childSessionId: record.childSessionId } : {}),
        });
        if (record.settled) settledMembers.add(childId);
        if (node.depth + 1 > MAX_STOP_TREE_DEPTH) {
          // 深度上限：该子入树（会被停）但其后代不再展开。
          this.emit({
            type: "stop_warn",
            rootId,
            code: "depth_cap",
            childId,
            detail: `停止树深度达上限 ${MAX_STOP_TREE_DEPTH}，${childId} 的后代未收集`,
          });
          continue;
        }
        queue.push({ id: childId, depth: node.depth + 1 });
      }
    }
    this.plan = { rootId, generation, members, settledMembers, completed: false };
    return { rootId, generation, members, skipped };
  }

  /** 在树成员上挂一条待确认请求（parked permission ask / ask_user 停泊问题）。 */
  registerPendingRequest(memberId: string, requestId: string, kind: PendingRequestKind): void {
    this.pending.set(requestId, { memberId, kind, seq: (this.pendingSeq += 1) });
  }

  /** 请求正常了结（人已答/正常 resolve）——从回收簿移除，停止时不再列出。 */
  resolvePendingRequest(requestId: string): void {
    this.pending.delete(requestId);
  }

  /**
   * 挂起请求回收：列出该树成员上仍挂着的请求 id（注册序），交调用方去
   * reject——「停干净」语义：abort 后不留僵尸确认框。有活动计划（同一
   * root）按计划的成员圈定；否则现场按父子链重收集（不校验 owner——没人
   * 声明过属主，parent 链就是全部凭据）。回收即出簿：重复 withdraw 不重
   * 复返回（幂等）。
   */
  withdrawPending(rootId: string): string[] {
    const plan = this.plan;
    const members = new Set<string>(
      plan !== undefined && plan.rootId === rootId
        ? plan.members
        : this.collectMembers(rootId),
    );
    const hits: { id: string; seq: number }[] = [];
    for (const [requestId, record] of this.pending) {
      if (members.has(record.memberId)) hits.push({ id: requestId, seq: record.seq });
    }
    hits.sort((a, b) => a.seq - b.seq);
    for (const hit of hits) this.pending.delete(hit.id);
    const requestIds = hits.map((h) => h.id);
    if (requestIds.length > 0) {
      this.emit({ type: "requests_withdrawn", rootId, requestIds });
    }
    return requestIds;
  }

  /** 无事件版收集（withdrawPending 的无计划回退路径共用同一走法）。 */
  private collectMembers(rootId: string): string[] {
    const members: string[] = [rootId];
    const visited = new Set([rootId]);
    const queue: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const childId of this.edges.get(node.id) ?? []) {
        if (visited.has(childId)) continue;
        visited.add(childId);
        const record = this.children.get(childId);
        if (record === undefined || record.parentId !== node.id) continue;
        members.push(childId);
        if (node.depth + 1 > MAX_STOP_TREE_DEPTH) continue;
        queue.push({ id: childId, depth: node.depth + 1 });
      }
    }
    return members;
  }

  // ── admission 对账（三态） ────────────────────────────────────────────
  // 只认「该 submission 有终态 assistant 回复」为 accepted（调用方用 openwork
  // 的 hasTerminalReply 同款判据核过再 markTerminalReply——completed 时间在、
  // finish 非 tool-calls、无 pending/running 工具件）。lost（发出丢回响）≠
  // 没受理：绝不重放，交人对账。unsent/sent 都投影 'pending'——在飞的请求
  // 结果仍由自己的连接持有，无需对账。

  /** 登记一个 submission（初始 unsent；幂等——已存在则保留原状态）。 */
  trackSubmission(submissionId: string): void {
    if (!this.submissions.has(submissionId)) this.submissions.set(submissionId, "unsent");
  }

  /** 发出（unsent→sent；lost/terminal 不回退）。 */
  markSubmitted(submissionId: string): void {
    const cur = this.submissions.get(submissionId);
    if (cur === undefined || cur === "unsent") this.submissions.set(submissionId, "sent");
  }

  /** 发出后丢了回响（响应丢失/无判读的错误终局）→ unknown。终态证据已到则
   *  不改判（迟到 lost 不覆盖 accepted）。进入 unknown 恰发一次事件。 */
  markAdmissionLost(submissionId: string): void {
    const cur = this.submissions.get(submissionId) ?? "unsent";
    if (cur === "terminal" || cur === "lost") return;
    this.submissions.set(submissionId, "lost");
    this.emit({ type: "admission_unknown", submissionId });
  }

  /** 终态 assistant 回复落地 → accepted（openwork：exact terminal evidence
   *  对账一个丢了的响应——丢回响后等到了真回复也算受理成立）。 */
  markTerminalReply(submissionId: string): void {
    this.submissions.set(submissionId, "terminal");
  }

  /** 三态投影：terminal→'accepted'；lost→'unknown'；其余（未发出/在飞）→
   *  'pending'。 */
  admissionUnknown(submissionId: string): "pending" | "accepted" | "unknown" {
    const cur = this.submissions.get(submissionId) ?? "unsent";
    if (cur === "terminal") return "accepted";
    if (cur === "lost") return "unknown";
    return "pending";
  }
}

/**
 * 前台派生登记口（晚绑盒）：driver 的协调器在构造时武装 register/settle，
 * 任务工具的前台派生点（fork/孤立/工作树孩子；后台 registry spawn 不进停
 * 止树——它们立即返回，生命周期归 agent_cancel）在派生时读。盒缺省/槽位
 * 空 ⇒ 完全不登记——不接线宿主的派生路径逐字节不变。
 */
export interface StopTreeDispatchPort {
  register?: (childId: string, childSessionId: string | undefined) => void;
  settle?: (childId: string) => void;
}
