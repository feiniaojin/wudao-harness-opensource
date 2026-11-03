// ω99 拆分运动 弧 B：mission 工具面外提（createMissionTools + /mission 命令
// 解析——原 mission.ts 模块级段逐字保留；mission.ts re-export 门面保公共面。
// MissionController 走 type-only 互引——类型级循环安全）。
import { buildTool, type Tool } from "@wudao-org/core";
import { GOAL_GATE_MAX_CHARS } from "./goal.js";
import { MISSION_NOTE_KINDS, NOTE_KIND_SET, MISSION_NOTE_TITLE_MAX_CHARS, MISSION_NOTE_CONTENT_MAX_CHARS, MISSION_BUNDLE_NAME_PATTERN } from "./mission-model.js";
import type { PlanTaskInput } from "./mission-model.js";
import type { MissionController } from "./mission.js";

// The model tool face (shared tool set — schedule_wakeup's late-bound box
// pattern: the tools join the set BEFORE any controller exists; the box is
// filled by the frontend once the ledger is loaded)
// ---------------------------------------------------------------------------

/** The mission tools, late-bound over the controller box. Registered at
 *  session start like every builtin (fixed position → tool-list prefix
 *  stays byte-stable); subagents never see them (top-level only, v1). */
export function createMissionTools(getController: () => MissionController | undefined): Tool[] {
  const refused = { content: "mission 工具拒绝：当前会话没有 mission 面（controller 尚未就绪或该前端未接线）", isError: true };
  return [
    buildTool({
      name: "mission_plan",
      description:
        "长任务分解推进用：为当前 mission 追加一批子任务（只增不改，id 由系统分配 t1,t2…）。dependsOn 只能引用已存在的任务 id（依赖全 done 才能认领——跳步在状态机层不可能）；gate 是该任务的完成验收命令（mission_complete 时必须退出 0，门红拒绝完成，3 次失败任务置 failed）。分解前先 mission_know 查既有约定，用 notes 字段引用（认领时逐字回放）。组合建议：mission 管分片调度，/goal <条件> --gate --budget 管终局判定与预算（正交，不自动联动）。",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: "要追加的任务；每项 {title 必填, detail?, dependsOn?: [任务id], gate?: 验收命令, notes?: [约定id]}",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "任务标题（一句话，≤400 字符）" },
                detail: { type: "string", description: "补充细节（可选）" },
                dependsOn: { type: "array", items: { type: "string" }, description: "依赖的任务 id 列表（可选）" },
                gate: { type: "string", description: "完成验收命令（可选；退出 0 才算完成，≤500 字符）。命令将进入本 mission 的回归棘轮，后续每次带门完成都会重跑" },
                budgetTokens: { type: "integer", description: "该任务的 token 预算（可选，正整数）。声明后认领该任务时会建立带预算的目标：每轮可见目标与余量、用尽时给出可安全暂停的任务节点。预算以任务台账为准" },
                notes: { type: "array", items: { type: "string" }, description: "引用的约定/决策 note id 列表（可选；这些约定在该任务认领时逐字回放）" },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isDestructive: () => false,
      isOpenWorld: () => false,
      async execute(args) {
        const controller = getController();
        if (controller === undefined) return refused;
        // Argument validation BEFORE any side effect (fail-closed).
        const tasks = args.tasks;
        if (!Array.isArray(tasks) || tasks.length === 0) {
          return { content: "mission_plan 拒绝：tasks 必须是非空数组", isError: true };
        }
        for (const t of tasks) {
          if (typeof t !== "object" || t === null) return { content: "mission_plan 拒绝：每个任务必须是对象", isError: true };
          if (typeof t.title !== "string" || t.title.trim() === "") {
            return { content: "mission_plan 拒绝：每个任务需要非空 title", isError: true };
          }
          if (t.detail !== undefined && typeof t.detail !== "string") return { content: "mission_plan 拒绝：detail 必须是字符串", isError: true };
          if (t.dependsOn !== undefined && (!Array.isArray(t.dependsOn) || t.dependsOn.some((d: unknown) => typeof d !== "string" || d === ""))) {
            return { content: "mission_plan 拒绝：dependsOn 必须是任务 id 字符串数组", isError: true };
          }
          if (t.gate !== undefined && (typeof t.gate !== "string" || t.gate === "" || t.gate.length > GOAL_GATE_MAX_CHARS)) {
            return { content: `mission_plan 拒绝：gate 须为 1-${GOAL_GATE_MAX_CHARS} 字符的命令`, isError: true };
          }
          if (t.budgetTokens !== undefined && (typeof t.budgetTokens !== "number" || !Number.isInteger(t.budgetTokens) || t.budgetTokens <= 0)) {
            return { content: "mission_plan 拒绝：budgetTokens 须为正整数", isError: true };
          }
          if (t.notes !== undefined && (!Array.isArray(t.notes) || t.notes.some((d: unknown) => typeof d !== "string" || d === ""))) {
            return { content: "mission_plan 拒绝：notes 必须是约定 id 字符串数组", isError: true };
          }
        }
        const r = await controller.plan(tasks as readonly PlanTaskInput[]);
        return { content: r.text, ...(r.ok ? {} : { isError: true }) };
      },
    }),
    buildTool({
      name: "mission_next",
      description: "认领当前 mission 的下一个就绪任务（依赖全 done 的最早 todo，原子置为 doing）。无可就绪时返回等待摘要（多少 todo 在等谁）。推进节奏：mission_next → 做事 → mission_complete / mission_fail。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isDestructive: () => false,
      isOpenWorld: () => false,
      // ω99-30 (C): the state machine's designed advance cadence — every task
      // ends with the SAME mission_next({}) shape while each call claims a
      // DIFFERENT task (t1→t5 walked one by one), so identical repeats are
      // polling, not a stuck loop (the ω99-26 :2080 false positive). The
      // only poll-shaped mission tool; action-shaped members stay counted.
      loopExempt: () => true,
      async execute() {
        const controller = getController();
        if (controller === undefined) return refused;
        const r = await controller.nextReady();
        return { content: r.text };
      },
    }),
    buildTool({
      name: "mission_complete",
      description: "完成任务（doing→done，可附成果摘要 result）。带验收门的任务先跑门：门红则拒绝完成并返回有界输出（3 次失败后任务置 failed）。只有 doing 状态的任务可完成。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "要完成的任务 id（mission_next 返回的那个）" },
          result: { type: "string", description: "成果摘要（可选，记入台账）" },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isDestructive: () => false,
      isOpenWorld: () => false,
      async execute(args) {
        const controller = getController();
        if (controller === undefined) return refused;
        if (typeof args.taskId !== "string" || args.taskId === "") {
          return { content: "mission_complete 拒绝：taskId 必须是非空字符串", isError: true };
        }
        if (args.result !== undefined && typeof args.result !== "string") {
          return { content: "mission_complete 拒绝：result 必须是字符串", isError: true };
        }
        const r = await controller.complete(args.taskId, args.result);
        return { content: r.text, ...(r.ok ? {} : { isError: true }) };
      },
    }),
    buildTool({
      name: "mission_fail",
      description: "把当前 doing 的任务标记失败：回到 todo（attempts+1，原因记入台账），依赖它的任务继续等待；3 次失败后任务置 failed（不再被认领）。用于无法完成/前置条件变化时诚实上报。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "要标记失败的任务 id" },
          reason: { type: "string", description: "失败原因（一句话）" },
        },
        required: ["taskId", "reason"],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isDestructive: () => false,
      isOpenWorld: () => false,
      async execute(args) {
        const controller = getController();
        if (controller === undefined) return refused;
        if (typeof args.taskId !== "string" || args.taskId === "") {
          return { content: "mission_fail 拒绝：taskId 必须是非空字符串", isError: true };
        }
        if (typeof args.reason !== "string" || args.reason.trim() === "") {
          return { content: "mission_fail 拒绝：reason 必须是非空字符串", isError: true };
        }
        const r = await controller.fail(args.taskId, args.reason);
        return { content: r.text, ...(r.ok ? {} : { isError: true }) };
      },
    }),
    buildTool({
      name: "mission_ratchet",
      description:
        "重跑当前 mission 的回归棘轮：按入轮序全量重跑历史带门任务验收过的命令，逐条报告（绿✓/红✗+归因+有界输出），不改任何状态。带门任务的门一绿其命令即自动入轮（同命令去重），此后每次带门完成都会在自身门之前全量重跑、mission 全部完成前再终检一遍——已验成果永不回退。命令须可重复执行（幂等）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isDestructive: () => false,
      isOpenWorld: () => false,
      async execute() {
        const controller = getController();
        if (controller === undefined) return refused;
        const r = await controller.ratchetCheck();
        return { content: r.text, ...(r.ok ? {} : { isError: true }) };
      },
    }),
    // ω99-17 — the knowledge face: strike mission-scoped conventions where
    // the tasks live (one ledger, one recovery); supersedes keeps evolution
    // linear and auditable (old notes stay, marked, never replayed).
    buildTool({
      name: "mission_know_add",
      description:
        "登记当前 mission 的知识条目：decision 决策 / convention 约定 / pitfall 坑 / checklist 清单（随 mission.json 持久，跨会话恢复）。supersedes 可取代旧条目（旧条保留 supersededBy 留痕、不再回放；不可链式取代）。登记后用 mission_plan 的 notes 字段把约定钉进任务——认领时逐字回放，不靠模型记忆。",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...MISSION_NOTE_KINDS], description: "条目类型：decision=已拍板的决策；convention=须遵守的约定；pitfall=已踩过的坑；checklist=执行清单" },
          title: { type: "string", description: "一句话标题（≤80 字符）" },
          content: { type: "string", description: "正文（≤500 字符；认领回放时逐字呈现）" },
          taskRef: { type: "string", description: "立约时所在任务 id（可选溯源）" },
          supersedes: { type: "string", description: "被取代的 note id（可选；须存在且未被取代过）" },
        },
        required: ["kind", "title", "content"],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isDestructive: () => false,
      isOpenWorld: () => false,
      async execute(args) {
        const controller = getController();
        if (controller === undefined) return refused;
        // Argument validation BEFORE any side effect (fail-closed).
        if (typeof args.kind !== "string" || !NOTE_KIND_SET.has(args.kind)) {
          return { content: `mission_know_add 拒绝：kind 必须是 ${MISSION_NOTE_KINDS.join("/")} 之一`, isError: true };
        }
        if (typeof args.title !== "string" || args.title.trim() === "" || args.title.trim().length > MISSION_NOTE_TITLE_MAX_CHARS) {
          return { content: `mission_know_add 拒绝：title 须为 1-${MISSION_NOTE_TITLE_MAX_CHARS} 字符`, isError: true };
        }
        if (typeof args.content !== "string" || args.content.length > MISSION_NOTE_CONTENT_MAX_CHARS) {
          return { content: `mission_know_add 拒绝：content 须为字符串且 ≤${MISSION_NOTE_CONTENT_MAX_CHARS} 字符`, isError: true };
        }
        if (args.taskRef !== undefined && (typeof args.taskRef !== "string" || args.taskRef === "")) {
          return { content: "mission_know_add 拒绝：taskRef 须为非空任务 id 字符串", isError: true };
        }
        if (args.supersedes !== undefined && (typeof args.supersedes !== "string" || args.supersedes === "")) {
          return { content: "mission_know_add 拒绝：supersedes 须为非空约定 id 字符串", isError: true };
        }
        const r = await controller.knowAdd(args as { kind: string; title: string; content: string; taskRef?: string; supersedes?: string });
        return { content: r.text, ...(r.ok ? {} : { isError: true }) };
      },
    }),
    buildTool({
      name: "mission_know",
      description:
        "查当前 mission 的既有知识条目（decision/convention/pitfall/checklist，未取代、倒序、最多 40 条）。mission_plan 分解任务前先查：把该任务要守的约定用其 notes 字段钉进去，认领时逐字回放——长战役里第 300 个任务也不会忘掉第 5 个任务立的约定。",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...MISSION_NOTE_KINDS], description: "只列该类型（可选）" },
        },
        additionalProperties: false,
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isDestructive: () => false,
      isOpenWorld: () => false,
      async execute(args) {
        const controller = getController();
        if (controller === undefined) return refused;
        if (args.kind !== undefined && (typeof args.kind !== "string" || !NOTE_KIND_SET.has(args.kind))) {
          return { content: `mission_know 拒绝：kind 过滤必须是 ${MISSION_NOTE_KINDS.join("/")} 之一`, isError: true };
        }
        const r = await controller.know(args.kind);
        return { content: r.text, ...(r.ok ? {} : { isError: true }) };
      },
    }),
    // ω99-18 — the tool-bundle face (the fourth long-horizon element): a
    // campaign-scoped domain skill pack. The mount itself adds ZERO tool
    // entries (skills ride the PROMPT face, the <available_skills> manifest);
    // this is the eighth mission tool — a tail append, so the tool-list
    // prefix bytes stay stable (mission_start appends after it).
    buildTool({
      name: "mission_bundle",
      description:
        "声明本战役需要的领域技能包：把 <workspaceRoot>/.wudao/mission-bundles/<name>/skills/ 下的技能挂入 <available_skills> 清单（缓存感知——忙时停泊，run 落地后生效，只动尾部 manifest 不破前缀）。技能包随 mission 终态自动卸载（会话边界生效）、随台账跨会话恢复。v1 仅支持 skills（bundle.json 声明 mcp 会被拒绝——MCP 是 session-static，无中途挂载缝）。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "工具包名（.wudao/mission-bundles/ 下的目录名；字母/数字开头，仅含 [A-Za-z0-9._-]，≤120 字符）" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isDestructive: () => false,
      isOpenWorld: () => false,
      async execute(args) {
        const controller = getController();
        if (controller === undefined) return refused;
        // Name whitelist BEFORE the controller (the path-safety red line:
        // validation precedes any side effect / rescan).
        if (typeof args.name !== "string" || !MISSION_BUNDLE_NAME_PATTERN.test(args.name)) {
          return { content: "mission_bundle 拒绝：name 须以字母/数字开头、仅含 [A-Za-z0-9._-]、≤120 字符（拒绝路径穿越与隐藏目录）", isError: true };
        }
        const r = await controller.bundle(args.name);
        return { content: r.text, ...(r.ok ? {} : { isError: true }) };
      },
    }),
    // ω99-19 — the START face (the ninth mission tool, a tail append — the
    // tool-list prefix bytes stay stable): before this the campaign could
    // only be opened by the readline /mission slash; the model now judges
    // scale itself and opens zero-ceremony. The description IS the first
    // gate — zero ceremony ≠ open casually.
    buildTool({
      name: "mission_start",
      description:
        "开一场任务战役（每工作区至多一个 active）：登记总目标，建立跨会话推进台账（任务 DAG + 棘轮 + 约定，随 .wudao/mission.json 持久恢复）。规模纪律：只在任务确实需要战役纪律时使用（任务量远超单上下文窗口、跨多会话、数十上百子步骤）；常规任务直接执行，勿开战役。开战役后用 mission_plan 分解。",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string", description: "战役总目标（一句话定调，≤4000 字符；由任务本身决定，不写过程细节）" },
        },
        required: ["objective"],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isDestructive: () => false,
      isOpenWorld: () => false,
      async execute(args) {
        const controller = getController();
        if (controller === undefined) return refused;
        // Argument validation BEFORE any side effect (fail-closed).
        if (typeof args.objective !== "string" || args.objective.trim() === "") {
          return { content: "mission_start 拒绝：objective 必须是非空字符串", isError: true };
        }
        return { content: await controller.start(args.objective) };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// /mission — the human command face (REPL v1; driver slash wiring is a
// later arc — the shared tool face already covers driver sessions)
// ---------------------------------------------------------------------------

export type MissionCommand =
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "start"; objective: string };

const MISSION_CLEAR_WORDS = new Set(["clear", "stop", "off", "reset", "none", "cancel", "abandon"]);

/** The /mission parse: bare status, clear aliases, else start. */
export function parseMissionCommand(args: string): MissionCommand {
  const trimmed = args.trim();
  if (trimmed === "") return { kind: "status" };
  const first = trimmed.split(/\s+/)[0]!.toLowerCase();
  if (MISSION_CLEAR_WORDS.has(first)) return { kind: "clear" };
  return { kind: "start", objective: trimmed };
}
