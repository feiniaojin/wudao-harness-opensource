// @vitest-environment jsdom
// ω99-276: #6 — 两令收据（用户令 09-11）：
// ① 头像无框化「头像不要有边框，边框很不好看」——.sig-avatar（主窗助手
//    署名）与 .pet-avatar（小精灵聊天窗宠物侧）的框线/底色/圆角 全退役：
//    肤帧自带透明底（sheet RGBA 角 alpha 0），裸帧直出；被退役的底色本是
//    圆角与宽高比空隙处露出的衬底——正是用户看到的「边框」。收据=规则体
//    源级切片不含框线/底色声明（CSSOM 读 absent 声明只得初值，钉不住
//    「没写」，故走源级）+ 单帧裁切三件套（274/275 面）零漂移。
// ② buddy 新对话直通「开新会话直接切到新的空会话，旧的随时历史切回」——
//    onNewChat 不再 setClearPending（清空/保留确认退役），点按即
//    performClear(true)（/clear 轮转 session id=全新空会话；原会话文件
//    不动、侧栏列表随时切回）。行为断言在 buddy-mode.test；此处钉源级缝
//    防回潮（显式 /clear 的确认路径字面不动，components.test 在案）。
// ③ 系统消息的代换清理（用户令同日追补「系统消息只打到当前激活的会话中，
//    切换会话之后就应该清理了，展示会话的历史」）——localNotes 盖视图代戳
//    （historyEpoch），reset:true 整替（resume/clear/重连）一跳即清旧代：
//    旧代回执不再「停在末尾」跨会话堆积。行为断言在 buddy-mode.test 的
//    切换测试；此处钉源级三缝（接口+双清缝+live 盖戳）。
import { afterEach, describe, expect, it } from "vitest";
import { readStyles } from "./styles-source.js";
import { existsSync, readFileSync } from "node:fs";
import { mount, decl, unmount } from "./css-test-utils.js";
import { AssistantReply } from "../src/components/AssistantReply.js";
import "../src/styles.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 的 fs 锚用 process.cwd() 候选位（178/203 两证）。
const readSrc = (rel: string): string => {
  const hit = ["src", "packages/web/src"]
    .map((d) => `${process.cwd()}/${d}/${rel}`)
    .find((p) => existsSync(p));
  if (hit === undefined) throw new Error(`source not found: ${rel}`);
  return readFileSync(hit, "utf8");
};
/** 选择器规则体（`{`…首个 `}`）——单层规则块专用；注释算体内文本。 */
const ruleBody = (css: string, selector: string): string => {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", at);
  return css.slice(open, css.indexOf("}", open));
};

afterEach(unmount);

describe("ω99-276 ① 头像无框化（框线/底色/圆角 退役）", () => {
  it("① .sig-avatar：规则体无框线无底色声明（裸帧直出），16px 单帧裁切三件套零漂移", () => {
    const body = ruleBody(readStyles(), ".sig-avatar {");
    expect(body).not.toContain("border");
    expect(body).not.toContain("background-color");
    expect(body).not.toContain("radius");
    const c = mount(<AssistantReply>正文</AssistantReply>);
    expect(c.querySelector(".msg-a .sig-avatar")).not.toBeNull();
    expect(decl(".sig-avatar", "width")).toBe("16px");
    expect(decl(".sig-avatar", "background-size")).toBe("200% auto");
    expect(decl(".sig-avatar", "background-position")).toBe("0 center");
  });

  it("① .pet-avatar：规则体无框线无底色无圆角无盒模型锁；浅色块不再有 .pet-avatar 覆写行", () => {
    const pet = readSrc("pet/pet.css");
    const body = ruleBody(pet, ".pet-avatar {");
    expect(body).not.toContain("border");
    expect(body).not.toContain("background-color");
    expect(body).not.toContain("radius");
    expect(body).not.toContain("box-sizing");
    expect(body).toContain("background-size: 200% auto"); // 274 单帧裁切面不动
    expect(body).toContain("background-position: 0 center");
    // 无框化后底色/边线覆写没有目标属性——浅色块整行退役（新肤帧两主题通用）
    expect(pet.indexOf('[data-theme="light"] .pet-avatar')).toBe(-1);
  });
});

describe("ω99-276 ② buddy 新对话直通（源级缝收据）", () => {
  it("② App：onNewChat 直呼 performClear(true)（无 setClearPending）；fresh 叙事档在案", () => {
    const app = readSrc("components/App.tsx");
    const at = app.indexOf("const onNewChat");
    expect(at).toBeGreaterThan(-1);
    // 0.4.1 随源演进：多driver弧C后 deps 数组扩为 view.capable/client/setViewLane
    // （busy 时开新车道路）；块尾标记随迁。
    const block = app.slice(at, app.indexOf("}, [busy, notify, performClear, view.capable, client, setViewLane]);", at));
    expect(block).not.toContain("setClearPending");
    expect(block).toContain("performClear(true)"); // 多driver弧C随迁：busy 时走车道开门路
    expect(block).toContain("稍后再开新对话");
    // performClear 的 fresh 叙事头/尾（fresh=false 显式 /clear 字面零漂移）
    expect(app).toContain('const head = fresh ? "已开启新会话" : "历史已清空";');
    expect(app).toContain('const tail = fresh ? "原会话已保留在列表，随时点开切回" : "已保存的历史仍在磁盘，可 /resume 恢复";');
  });

  it("② SessionSidebar 侧栏入口仍走 onNewChat（数据流不动——退役的只是确认环节）", () => {
    const sb = readSrc("components/SessionSidebar.tsx");
    expect(sb).toContain('className="sb-new" onClick={onNewChat}');
  });
});

describe("ω99-276 ③ 系统消息的代换清理（源级缝收据）", () => {
  it("③ LocalNote 盖视图代戳：接口有 epoch?；appendNotice 带参且折叠行继承出生代", () => {
    const app = readSrc("components/app-consts.tsx"); // ω99-327a：LocalNote/appendNotice 随常量族外提（App 门面 re-export）
    expect(app).toContain("readonly epoch?: number;");
    expect(app).toContain("export function appendNotice(notes: readonly LocalNote[], text: string, after: number, epoch?: number): readonly LocalNote[] {");
    expect(app).toContain("epoch: last.epoch"); // 折叠行（×N）继承第一次落地的代，不是最近一次重复
  });

  it("③ 代换双缝：合并时刻滤旧代（reset 帧与效应之间那一帧也不渲染旧代）+ epoch 效应修状态", () => {
    const app = readSrc("components/App.tsx"); // 组件闭包面留 App 本体
    // 多 driver 弧 C 随源演进：单数组/主车道 epoch → 按会话分键（useSessionViews）
    // +「正在看的车道」的 view.historyEpoch——语义钉不变（渲染永不含旧代），
    // 取代源从 snap.historyEpoch 换为被看车道的 epoch。
    expect(app).toContain("localNotes.filter((n) => n.epoch === view.historyEpoch)"); // 渲染永不含旧代（被看车道）
    expect(app).toContain("views.filterNotes(view.key, (n) => n.epoch === view.historyEpoch)"); // 状态修剪（≤50 上界不积旧代；同键同代才清）
  });

  it("③ notify 盖 LIVE 快照的戳（与 clearView 同批落地的新代回执不被代清误杀）", () => {
    const app = readSrc("components/App.tsx"); // 组件闭包面留 App 本体
    expect(app).toContain("const live = client.getSnapshot();");
    // 多 driver 弧 C 随源演进：戳的 (length, epoch) 现取「正在看的车道」在 LIVE
    // 快照里的现值（主车道=主位；副车道=lanes[sid]），appendNotice 本体随
    // stampNote 外提 use-lane-view.ts（分键版持同一纪律）。
    expect(app).toContain("viewsRef.current.stampNote(");
    expect(app).toContain("lane !== undefined ? lane.history.length : live.history.length");
    const laneView = readSrc("use-lane-view.ts");
    expect(laneView).toContain("appendNotice(s.notes, text, after, epoch)");
  });
});
