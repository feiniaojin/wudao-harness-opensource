// ω99-99 — the wire contract between the two windows, RED-first. The pet
// window must NEVER open a second WS (server is single-client), so the main
// window distills each UiSnapshot into a tiny PetFrame and ships it over the
// Tauri event bus; the pet maps the frame back onto ω99-98's PetInput
// (sentinels only — the 98 machine reads NON-EMPTINESS, never content).
// This file pins: the wire constants verbatim; derivePetFrame's full matrix
// (null status, every signal, the full-text answer tail); petFrameToInput's
// four sentinel mappings; and the composition derive→map→98-machine which
// must reproduce the five steady states without regression.
import { describe, expect, it } from "vitest";
import {
  WUDAO_PET_HISTORY_EVENT,
  WUDAO_PET_HISTORY_REQ_EVENT,
  IDLE_PET_FRAME,
  PET_EMIT_MS,
  WUDAO_PET_ASK_EVENT,
  WUDAO_PET_STATE_EVENT,
  derivePetFrame,
  petFrameToInput,
} from "../src/pet/pet-frame.js";
// ω99-109 — namespace 引用：本弧新增出口（WUDAO_PET_ANSWER_EVENT /
// petFramesEqual）在实现落地前以 undefined 触发精确断言红，而不是让
// 命名导入把整文件炸成模块链接错误（红证据要能指向具体断言）。
import * as petFrameWire from "../src/pet/pet-frame.js";
import { petSteadyState, stepPetMachine, initialPetMachineState } from "../src/pet/pet-state.js";
import type { PetFrame } from "../src/pet/pet-frame.js";
import type { DriverStatus, PendingPermission } from "../src/protocol.js";

/** A full DriverStatus base — derivePetFrame reads only busy /
 *  pendingPermission / live, but the object stays honest to the wire shape. */
function status(p: Partial<DriverStatus>): DriverStatus {
  return {
    live: { reasoning: "", answer: "", busyTools: [] },
    busy: false,
    queued: [],
    boardProgress: null,
    ctxTokens: null,
    mode: "workspace",
    cachePercent: null,
    bg: { active: 0, spawned: 0 },
    pendingPermission: null,
    planBoard: null,
    sessionId: "s0",
    sidecar: null,
    ...p,
  };
}

const ask: PendingPermission = { toolName: "Bash", summary: "rm -rf", input: {} };

describe("ω99-99 wire 契约常量（逐字）", () => {
  it("事件名 / 节流窗口", () => {
    expect(WUDAO_PET_STATE_EVENT).toBe("wudao-pet-state");
    expect(WUDAO_PET_ASK_EVENT).toBe("wudao-pet-ask");
    // ω99-272: #6 — ANSWER_TAIL_CHARS 截断常量退役（2000 字尾窗撤除——用户
    // 令 09-10「流面尾窗不要限制字数」；可读性交折叠 UI，不再用截断换）。
    expect((petFrameWire as unknown as Record<string, unknown>).ANSWER_TAIL_CHARS).toBeUndefined();
    expect(PET_EMIT_MS).toBe(150);
    // ω99-271 — 历史车道的事件名对（请求/回执，与 ask/answer 同总线范式）。
    expect(WUDAO_PET_HISTORY_REQ_EVENT).toBe("wudao-pet-history-req");
    expect(WUDAO_PET_HISTORY_EVENT).toBe("wudao-pet-history");
    // M85-pet §2 — 工具栏动作的事件名（宠物 → 主窗，与 answer 同向同范式）。
    expect(petFrameWire.WUDAO_PET_TOOLBAR_EVENT).toBe("wudao-pet-toolbar-event");
  });
});

describe("ω99-99 derivePetFrame 全矩阵", () => {
  it("status null（快照未到达/无会话）→ null", () => {
    expect(derivePetFrame({ status: null })).toBeNull();
  });

  it("全空会话 → 零信号帧（ω99-109 期望变更：帧新增 ask；ω99-113 期望变更：帧新增 busyNarration，空=无旁白；v7 γ1 期望变更：帧新增 workKind，空=无分类；M85-pet §2 期望变更：帧新增 model/effort/workspaceName，空=三 null；M85-final 期望变更：帧新增 workspacePath/modelChoices/recentWorkspaces，空=三 null）", () => {
    expect(derivePetFrame({ status: status({}) })).toEqual({
      busy: false,
      pendingPermission: false,
      reasoningActive: false,
      answerTail: "",
      busyToolCount: 0,
      busyNarration: null,
      workKind: null,
      ask: null,
      model: null,
      effort: null,
      workspaceName: null,
      workspacePath: null,
      modelChoices: null,
      recentWorkspaces: null,
    });
  });

  it("busy 透传", () => {
    expect(derivePetFrame({ status: status({ busy: true }) })?.busy).toBe(true);
    expect(derivePetFrame({ status: status({ busy: false }) })?.busy).toBe(false);
  });

  it("pendingPermission：null→false，挂着问询→true（信号，不带内容）", () => {
    expect(derivePetFrame({ status: status({ pendingPermission: ask }) })?.pendingPermission).toBe(true);
    expect(derivePetFrame({ status: status({ pendingPermission: null }) })?.pendingPermission).toBe(false);
  });

  it("reasoningActive：空串→false，非空→true（内容不传）", () => {
    expect(derivePetFrame({ status: status({ live: { reasoning: "", answer: "", busyTools: [] } }) })?.reasoningActive).toBe(false);
    expect(derivePetFrame({ status: status({ live: { reasoning: "思考中", answer: "", busyTools: [] } }) })?.reasoningActive).toBe(true);
  });

  it("answerTail：短文原样；超长全文透传（ω99-272 无截断——尾窗常量已退役）", () => {
    const short = "答案尾巴";
    expect(derivePetFrame({ status: status({ live: { reasoning: "", answer: short, busyTools: [] } }) })?.answerTail).toBe(short);
    // ω99-272 — 全文直通：5000 字答案一字不少地过帧（可读性交 Bubble 折叠
    // UI；泵去重/节流照常，全文仅在变化时过总线）。
    const long = `${"a".repeat(4997)}END`;
    const tail = derivePetFrame({ status: status({ live: { reasoning: "", answer: long, busyTools: [] } }) })?.answerTail;
    expect(tail).toBe(long);
    expect(tail?.length).toBe(5000);
    expect(tail?.endsWith("END")).toBe(true);
    expect(tail?.startsWith("a")).toBe(true); // 头部也在——不是尾窗切片
  });

  it("busyToolCount：计数不传内容", () => {
    const tools = [{ name: "Read", summary: "" }, { name: "Bash", summary: "" }, { name: "Edit", summary: "" }];
    expect(derivePetFrame({ status: status({ live: { reasoning: "", answer: "", busyTools: tools } }) })?.busyToolCount).toBe(3);
    expect(derivePetFrame({ status: status({ live: { reasoning: "", answer: "", busyTools: [] } }) })?.busyToolCount).toBe(0);
  });
});

describe("ω99-99 petFrameToInput 哨兵映射（98 契约只认非空性）", () => {
  it("pendingPermission：true→true，false→null", () => {
    expect(petFrameToInput({ busy: false, pendingPermission: true, reasoningActive: false, answerTail: "", busyToolCount: 0, busyNarration: null, workKind: null, ask: null, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null }).pendingPermission).toBe(true);
    expect(petFrameToInput({ busy: false, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 0, busyNarration: null, workKind: null, ask: null, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null }).pendingPermission).toBe(null);
  });

  it("reasoning：active→非空哨兵 \".\"，inactive→\"\"", () => {
    expect(petFrameToInput({ busy: false, pendingPermission: false, reasoningActive: true, answerTail: "", busyToolCount: 0, busyNarration: null, workKind: null, ask: null, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null }).live.reasoning).not.toBe("");
    expect(petFrameToInput({ busy: false, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 0, busyNarration: null, workKind: null, ask: null, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null }).live.reasoning).toBe("");
  });

  it("answer 原样、busyTools 按计数重建、busy 透传", () => {
    const input = petFrameToInput({ busy: true, pendingPermission: false, reasoningActive: false, answerTail: "尾部", busyToolCount: 2, busyNarration: null, workKind: null, ask: null, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null });
    expect(input.busy).toBe(true);
    expect(input.live.answer).toBe("尾部");
    expect(input.live.busyTools).toHaveLength(2);
  });
});

describe("ω99-99 组合不回归：帧→PetInput→98 状态机五态", () => {
  const frame = (p: Partial<PetFrame>): PetFrame => ({
    busy: false, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 0, busyNarration: null, workKind: null, ask: null, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null, ...p,
  });

  it("五态优先级经 wire 往返后原样成立", () => {
    expect(petSteadyState(petFrameToInput(frame({ pendingPermission: true, busyToolCount: 1, reasoningActive: true, answerTail: "x" })))).toBe("waiting-user");
    expect(petSteadyState(petFrameToInput(frame({ busyToolCount: 2, reasoningActive: true, answerTail: "x" })))).toBe("working");
    expect(petSteadyState(petFrameToInput(frame({ reasoningActive: true, answerTail: "x" })))).toBe("thinking");
    expect(petSteadyState(petFrameToInput(frame({ answerTail: "x" })))).toBe("answering");
    expect(petSteadyState(petFrameToInput(frame({})))).toBe("idle");
  });

  it("busy 下降沿经帧往返仍触发 done 瞬态", () => {
    let m = initialPetMachineState();
    m = stepPetMachine(m, petFrameToInput(frame({ busy: true, reasoningActive: true })), 100);
    expect(m.display).toBe("thinking");
    m = stepPetMachine(m, petFrameToInput(frame({})), 200);
    expect(m.display).toBe("done");
  });
});

// --- ω99-109 帧扩展：ask 卡（权限确认直达宠物气泡） ---------------------------
// PetFrame 增可空 ask：pendingPermission 的「决策所需最小集」（toolName+
// summary+canAlways）随帧跨窗；input/warning/sidecar 等重语义不出主窗——
// 宠物面只承载决策，深度语义仍留主窗。断线帧（IDLE）不带卡：断线=没有
// 活的权限门可答（103 契约）。应答走反向事件 wudao-pet-answer（relay 层）。
describe("ω99-109 ask 帧（derive 最小集 / IDLE 无卡 / 等值比较）", () => {
  /** 全字段 PendingPermission——derive 只许取走两字段+一布尔。 */
  const full: PendingPermission = {
    toolName: "Bash",
    summary: "rm -rf build",
    input: { cmd: "rm -rf build" },
    warning: "git 风险块",
    sidecar: "M45 分类理由",
  };

  it("pendingPermission 全字段 → 只取 toolName+summary+canAlways（input/warning/sidecar 不出主窗）", () => {
    expect(derivePetFrame({ status: status({ pendingPermission: full }) })?.ask).toEqual({
      toolName: "Bash",
      summary: "rm -rf build",
      canAlways: true,
    });
  });

  it("settingsFile 在 → canAlways=false（与主窗同款降级：y/N，无「总是」）", () => {
    const withFile: PendingPermission = { ...full, settingsFile: "/wudao/policy.runtime.json" };
    expect(derivePetFrame({ status: status({ pendingPermission: withFile }) })?.ask).toEqual({
      toolName: "Bash",
      summary: "rm -rf build",
      canAlways: false,
    });
  });

  it("pendingPermission null → ask=null", () => {
    expect(derivePetFrame({ status: status({}) })?.ask).toBeNull();
  });

  it("IDLE_PET_FRAME.ask=null：断线=卡消失（断线帧是主动推送的全 idle，不保留卡）", () => {
    expect(IDLE_PET_FRAME.ask).toBeNull();
  });

  it("ask 不参与 PetInput（98 机器仍只读布尔；卡是 Bubble 的事，不动机器）", () => {
    const base = { busy: false, pendingPermission: true, reasoningActive: false, answerTail: "", busyToolCount: 0, busyNarration: null, workKind: null, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null };
    expect(petFrameToInput({ ...base, ask: { toolName: "Bash", summary: "s", canAlways: true } })).toEqual(
      petFrameToInput({ ...base, ask: null }),
    );
  });

  it("WUDAO_PET_ANSWER_EVENT 逐字 = \"wudao-pet-answer\"", () => {
    expect(petFrameWire.WUDAO_PET_ANSWER_EVENT).toBe("wudao-pet-answer");
  });

  it("petFramesEqual：ask 逐字段比较——同值等；任一字段变 / 卡消失 → 不等（pump 据此发新帧）", () => {
    const base: PetFrame = {
      busy: false, pendingPermission: true, reasoningActive: false, answerTail: "", busyToolCount: 0, busyNarration: null, workKind: null,
      ask: { toolName: "Bash", summary: "s1", canAlways: true }, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null,
    };
    expect(petFrameWire.petFramesEqual(base, { ...base, ask: { toolName: "Bash", summary: "s1", canAlways: true } })).toBe(true);
    expect(petFrameWire.petFramesEqual(base, { ...base, ask: { toolName: "Edit", summary: "s1", canAlways: true } })).toBe(false);
    expect(petFrameWire.petFramesEqual(base, { ...base, ask: { toolName: "Bash", summary: "s2", canAlways: true } })).toBe(false);
    expect(petFrameWire.petFramesEqual(base, { ...base, ask: { toolName: "Bash", summary: "s1", canAlways: false } })).toBe(false);
    expect(petFrameWire.petFramesEqual(base, { ...base, ask: null })).toBe(false);
  });
});

// --- ω99-113 帧扩展：busyNarration（busyTools 的人话旁白随帧跨窗） -------------
// busyToolCount 只告诉宠物「有几个工具在飞」，说不出「在干什么」——旁白由
// 主窗 distill 侧用 busy-narration 纯映射算好（string|null），随帧跨 Tauri
// 总线；宠物面的 Bubble 直接渲染。依据：name+summary 已在 busyTools 载荷
// （§0），映射可全落 web 纯层，零新事件零协议改动（既有帧加一个可空字段，
// 与 109 ask 同款 additive 方式）。
describe("ω99-113 busyNarration 帧（derive 映射 / IDLE 无旁白 / 等值比较 / 不参与机器）", () => {
  const live = (tools: { name: string; summary: string }[]): DriverStatus["live"] => ({
    reasoning: "", answer: "", busyTools: tools,
  });

  it("browser_open 在飞 → 旁白「正在打开网页…」随帧", () => {
    expect(derivePetFrame({ status: status({ live: live([{ name: "browser_open", summary: "" }]) }) })?.busyNarration).toBe("正在打开网页…");
  });

  it("非 browser 工具在飞 → v7 γ1 起可旁白（113 的 null 取舍兑现为全工具分类）", () => {
    expect(derivePetFrame({ status: status({ live: live([{ name: "read_file", summary: "/a" }]) }) })?.busyNarration).toBe("正在读文件「/a」");
  });

  it("并发多行 → 最新可旁白行胜出（与 busyNarrationOf 同一规则）", () => {
    const tools = [{ name: "browser_open", summary: "" }, { name: "browser_snapshot", summary: "" }];
    expect(derivePetFrame({ status: status({ live: live(tools) }) })?.busyNarration).toBe("正在读页面…");
  });

  it("browser_click 带摘要 → 摘要进旁白", () => {
    expect(derivePetFrame({ status: status({ live: live([{ name: "browser_click", summary: "登录按钮" }]) }) })?.busyNarration).toBe("正在点击页面上的「登录按钮」");
  });

  it("IDLE_PET_FRAME.busyNarration=null：断线=无在飞工具可旁白", () => {
    expect(IDLE_PET_FRAME.busyNarration).toBeNull();
  });

  it("petFramesEqual：busyNarration 变 → 不等（计数不变旁白变必须重发帧——open→snapshot 计数同 1）", () => {
    const base: PetFrame = {
      busy: true, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 1, busyNarration: "正在打开网页…", workKind: "browser", ask: null,
      model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null,
    };
    expect(petFrameWire.petFramesEqual(base, { ...base, busyNarration: "正在打开网页…" })).toBe(true);
    expect(petFrameWire.petFramesEqual(base, { ...base, busyNarration: "正在读页面…" })).toBe(false);
    expect(petFrameWire.petFramesEqual(base, { ...base, busyNarration: null })).toBe(false);
  });

  it("busyNarration 不参与 PetInput（98 机器仍只读 busyToolCount 的非空性）", () => {
    const base = { busy: true, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 1, workKind: null, ask: null, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null };
    expect(petFrameToInput({ ...base, busyNarration: "正在读页面…" })).toEqual(petFrameToInput({ ...base, busyNarration: null }));
  });
});

// --- v7 γ1 帧扩展：workKind（胜出行的工作种类随帧跨窗） -----------------------
// 旁白回答「在干什么」（一句人话），workKind 回答「属于哪类工作」（分类
// 锚）——宠物形态差异的将来缝。与 busyNarration 同源同行（busyWorkKindOf
// 的「最新可分类行」），null 边界同款；不参与 PetInput（98 机器仍布尔）。
describe("v7 γ1 workKind 帧（derive 分类 / IDLE 无分类 / 等值比较 / 不参与机器）", () => {
  const live = (tools: { name: string; summary: string }[]): DriverStatus["live"] => ({
    reasoning: "", answer: "", busyTools: tools,
  });

  it("shell 在飞 → workKind=command 随帧", () => {
    expect(derivePetFrame({ status: status({ live: live([{ name: "shell", summary: "npm test" }]) }) })?.workKind).toBe("command");
  });

  it("make_pptx 在飞 → workKind=office（与旁白同源同行）", () => {
    expect(derivePetFrame({ status: status({ live: live([{ name: "make_pptx", summary: "" }]) }) })?.workKind).toBe("office");
  });

  it("未知工具在飞 → null（诚实沉默边界）", () => {
    expect(derivePetFrame({ status: status({ live: live([{ name: "future_thing", summary: "" }]) }) })?.workKind).toBeNull();
  });

  it("IDLE_PET_FRAME.workKind=null：断线=无在飞工具可分类", () => {
    expect(IDLE_PET_FRAME.workKind).toBeNull();
  });

  it("workKind 不参与 PetInput（98 机器仍只读 busyToolCount 的非空性）", () => {
    const base = { busy: true, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 1, busyNarration: null, ask: null, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null };
    expect(petFrameToInput({ ...base, workKind: "command" })).toEqual(petFrameToInput({ ...base, workKind: null }));
  });
});

// --- M85-pet §2 帧扩展：model/effort/workspaceName（工具栏 chips 的数据面） ---
// 精灵工具栏三个 chip（模型/思考/工作区）的显示值随帧跨窗——蒸馏源是状态
// 帧 pet 字段：model 块（label=model id、effort=会话生效档）与 Task 3 新增
// 的 workspaceName（agentRootStatus 派生 basename；全路径 workspacePath 留
// 主窗 StatusBar 面，不进帧）。与 113 旁白同款 additive 方式（帧加可空字段
// ——旧形状=三 null 零噪音）；不参与 PetInput（98 机器仍布尔）。
describe("M85-pet §2 工具栏帧字段（derive 蒸馏 / IDLE 三 null / 等值比较）", () => {
  it("model 块在场 → label/effort 蒸馏；workspaceName 直通", () => {
    const s = status({
      model: { label: "glm-5.3", provider: "glm", effort: "high", choices: [] },
      workspaceName: "demo",
    });
    const f = derivePetFrame({ status: s });
    expect(f?.model).toBe("glm-5.3");
    expect(f?.effort).toBe("high");
    expect(f?.workspaceName).toBe("demo");
  });

  it("model 块在场但 effort 缺（未设档）→ model 有值、effort=null（逐字段独立）", () => {
    const f = derivePetFrame({ status: status({ model: { label: "deepseek-v4", choices: [] } }) });
    expect(f?.model).toBe("deepseek-v4");
    expect(f?.effort).toBeNull();
  });

  it("旧形状（无 model 块 / 无 workspace 对）→ 三 null（additive 零噪音）", () => {
    const f = derivePetFrame({ status: status({ model: null }) });
    expect(f?.model).toBeNull();
    expect(f?.effort).toBeNull();
    expect(f?.workspaceName).toBeNull();
  });

  it("IDLE_PET_FRAME 三 null（断线=无活配置可显，工具栏 chips 诚实空白）", () => {
    expect(IDLE_PET_FRAME.model).toBeNull();
    expect(IDLE_PET_FRAME.effort).toBeNull();
    expect(IDLE_PET_FRAME.workspaceName).toBeNull();
  });

  it("petFramesEqual：model/effort/workspaceName 任一变 → 不等（换模型/换档/换工作区=新帧，pump 重发——brief Step 1 第二例）", () => {
    const base = derivePetFrame({
      status: status({ model: { label: "glm-5.3", effort: "high", choices: [] }, workspaceName: "demo" }),
    })!;
    expect(petFrameWire.petFramesEqual(base, { ...base })).toBe(true);
    expect(petFrameWire.petFramesEqual(base, { ...base, model: "glm-5.4" })).toBe(false);
    expect(petFrameWire.petFramesEqual(base, { ...base, effort: "max" })).toBe(false);
    expect(petFrameWire.petFramesEqual(base, { ...base, workspaceName: "other" })).toBe(false);
    expect(petFrameWire.petFramesEqual(base, { ...base, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null })).toBe(false);
  });

  it("三新字段不参与 PetInput（98 机器仍只读布尔——同 ask/旁白纪律）", () => {
    const f = derivePetFrame({ status: status({ model: { label: "glm-5.3", effort: "high", choices: [] }, workspaceName: "demo" }) })!;
    expect(petFrameToInput(f)).toEqual(petFrameToInput({ ...f, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null }));
  });
});

// --- M85-pet §2 readPetToolbarAction（工具栏动作的 wire 解析） -----------------
// 宠物窗 emit 的载荷跨 Tauri 总线无类型——readPetAnswer/readPetToast 同纪
// 律：形状不合法整丢，绝不半信。字符串门与 server 同句（provider/effort/
// path 非空 string）；多余键被归一化剥掉（canonical 形状出解析器）。
describe("M85-pet §2 readPetToolbarAction（wire 解析）", () => {
  it("四形全收（canonical 归一）", () => {
    expect(petFrameWire.readPetToolbarAction({ kind: "new-session" })).toEqual({ kind: "new-session" });
    expect(petFrameWire.readPetToolbarAction({ kind: "set-model", provider: "glm", model: "glm-5.3", effort: "high" })).toEqual({ kind: "set-model", provider: "glm", model: "glm-5.3", effort: "high" });
    expect(petFrameWire.readPetToolbarAction({ kind: "set-model", provider: "glm" })).toEqual({ kind: "set-model", provider: "glm" });
    expect(petFrameWire.readPetToolbarAction({ kind: "set-model", provider: "glm", extra: 1 })).toEqual({ kind: "set-model", provider: "glm" });
    expect(petFrameWire.readPetToolbarAction({ kind: "set-effort", effort: "max" })).toEqual({ kind: "set-effort", effort: "max" });
    expect(petFrameWire.readPetToolbarAction({ kind: "set-workspace", path: "/w" })).toEqual({ kind: "set-workspace", path: "/w" });
  });

  it("坏载荷整丢（不半信：非对象/坏 kind/字符串门不过）", () => {
    expect(petFrameWire.readPetToolbarAction(null)).toBeNull();
    expect(petFrameWire.readPetToolbarAction("new-session")).toBeNull();
    expect(petFrameWire.readPetToolbarAction({})).toBeNull();
    expect(petFrameWire.readPetToolbarAction({ kind: 1 })).toBeNull();
    expect(petFrameWire.readPetToolbarAction({ kind: "bogus" })).toBeNull();
    expect(petFrameWire.readPetToolbarAction({ kind: "set-model" })).toBeNull(); // provider 缺
    expect(petFrameWire.readPetToolbarAction({ kind: "set-model", provider: "" })).toBeNull(); // 空串=没给
    expect(petFrameWire.readPetToolbarAction({ kind: "set-model", provider: "glm", model: 3 })).toBeNull();
    expect(petFrameWire.readPetToolbarAction({ kind: "set-model", provider: "glm", effort: true })).toBeNull();
    expect(petFrameWire.readPetToolbarAction({ kind: "set-effort" })).toBeNull();
    expect(petFrameWire.readPetToolbarAction({ kind: "set-effort", effort: "" })).toBeNull();
    expect(petFrameWire.readPetToolbarAction({ kind: "set-workspace" })).toBeNull();
    expect(petFrameWire.readPetToolbarAction({ kind: "set-workspace", path: "" })).toBeNull();
  });
});

// --- M85-final（终审修复波）帧扩展：workspacePath/modelChoices/recentWorkspaces --
// 终审 M-3：spec §2 蒸馏四项的第四项（workspacePath 在 wire 但不进帧）补齐。
// 终审 I-3：模型/工作区数据面（modelChoices=registry 矩阵对；recentWorkspaces
// =relay 注入的最近工作区路径）——Bubble 弹层据此升列表选择，null=缺席回落
// 手输。等值函数同步三字段（数组逐元素——蒸馏每帧新建数组，内容等值即帧
// 等值，泵照常短路）。
describe("M85-final 帧字段（workspacePath 蒸馏 / modelChoices / recentWorkspaces 注入 / 等值）", () => {
  it("workspacePath 直通（wire 已携带——server 帧 pet 字段）；缺席=null", () => {
    expect(derivePetFrame({ status: status({ workspaceName: "demo", workspacePath: "/Users/x/demo" }) })?.workspacePath).toBe("/Users/x/demo");
    expect(derivePetFrame({ status: status({}) })?.workspacePath).toBeNull();
    expect(IDLE_PET_FRAME.workspacePath).toBeNull();
  });

  it("modelChoices：choices 矩阵蒸馏为 {provider,model} 对（source/contextLength 剥掉——宠物面不消费）；块缺席/空矩阵=null", () => {
    const withMatrix = status({
      model: { label: "glm-5.3", choices: [
        { provider: "glm", model: "glm-5.3", source: "builtin", contextLength: 128000 },
        { provider: "deepseek", model: "deepseek-v4", source: "registry" },
      ] },
    });
    expect(derivePetFrame({ status: withMatrix })?.modelChoices).toEqual([
      { provider: "glm", model: "glm-5.3" },
      { provider: "deepseek", model: "deepseek-v4" },
    ]);
    expect(derivePetFrame({ status: status({ model: { label: "glm-5.3", choices: [] } }) })?.modelChoices).toBeNull();
    expect(derivePetFrame({ status: status({}) })?.modelChoices).toBeNull();
    expect(IDLE_PET_FRAME.modelChoices).toBeNull();
  });

  it("recentWorkspaces：extra 参数注入（非状态帧字段——relay 挂载取数）；缺席=null", () => {
    const s = status({});
    expect(derivePetFrame({ status: s }, { recentWorkspaces: ["/w/a", "/w/b"] })?.recentWorkspaces).toEqual(["/w/a", "/w/b"]);
    expect(derivePetFrame({ status: s }, { recentWorkspaces: null })?.recentWorkspaces).toBeNull();
    expect(derivePetFrame({ status: s })?.recentWorkspaces).toBeNull();
    expect(IDLE_PET_FRAME.recentWorkspaces).toBeNull();
  });

  it("petFramesEqual：workspacePath/modelChoices/recentWorkspaces 任一变 → 不等；同内容异身份数组 → 等（泵短路不受蒸馏新建数组干扰）", () => {
    const base = derivePetFrame({
      status: status({ workspaceName: "demo", workspacePath: "/Users/x/demo", model: { label: "glm-5.3", choices: [{ provider: "glm", model: "glm-5.3", source: "builtin" }] } }),
    }, { recentWorkspaces: ["/w/a"] })!;
    expect(petFrameWire.petFramesEqual(base, { ...base })).toBe(true);
    // 同内容新数组（蒸馏每帧重建的身份差）→ 等值
    expect(petFrameWire.petFramesEqual(base, {
      ...base,
      modelChoices: [{ provider: "glm", model: "glm-5.3" }],
      recentWorkspaces: ["/w/a"],
    })).toBe(true);
    expect(petFrameWire.petFramesEqual(base, { ...base, workspacePath: "/other" })).toBe(false);
    expect(petFrameWire.petFramesEqual(base, { ...base, modelChoices: [{ provider: "glm", model: "glm-5.4" }] })).toBe(false);
    expect(petFrameWire.petFramesEqual(base, { ...base, modelChoices: null })).toBe(false);
    expect(petFrameWire.petFramesEqual(base, { ...base, recentWorkspaces: ["/w/b"] })).toBe(false);
    expect(petFrameWire.petFramesEqual(base, { ...base, recentWorkspaces: null })).toBe(false);
  });
});
