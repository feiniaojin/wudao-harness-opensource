// ω99-201: #1 — 宠物窗本地 transcript（桌面精灵迷你聊天窗，用户令 09-08
// 三需求之「回答与输入同窗」）。transcript 是宠物窗 LOCAL 态：服务器协议
// 零改（answerTail 自 ω99-272 起携带全文），发送/划词/主窗轮统一由 applyFrame
// 纯规则归账——不发明第二事实源，帧仍是唯一输入。PURE TS, no imports
// （busy-narration 同款边界）：pet/PetApp.tsx 独占消费，Bubble 只投影。
//
// 规则序（applyFrame）：
// ① turns 空 && tail≠""  → push {q:"",a:tail,live:true}（主窗轮兜底建格）
// ② 末位 live：tail≠"" → 填 a；tail=="" && !busy → 冻结（live=false，a 保
//    最后非空值）；tail=="" && busy → 不变（推理期空尾不是结束）
// ③ 末位 !live && tail≠"" → push {q:"",a:tail,live:true}（新一轮自他处开始）

/** 一轮问答的本地形状：q=问题 digest（≤24 字，宠物源轮才有；主窗轮兜底
 *  格为空串），a=回答尾窗（活格随帧续写，冻结格保最后非空值），live=活格
 *  旗（只挂最新末位——pushTurn/applyFrame 共同维护的唯一性不变量）。 */
export interface ChatTurn {
  readonly q: string;
  readonly a: string;
  readonly live: boolean;
}

/** 宠物窗聊天记录（ω99-272 起无轮数帽——本地转写无限，滚动区承接）。 */
export interface PetChat {
  readonly turns: readonly ChatTurn[];
}

/** 空 chat（入口 useState 初值）。 */
export const emptyPetChat: PetChat = { turns: [] };

/** 问题 → ≤24 字摘要（Array.from 码点计字——CJK 不按 UTF-16 半个算；
 *  超长截 24 字 + 省略号「…」，短串原样）。宠物源轮的 q 行只做辨认不做
 *  阅读，全文已随事件发给主窗。 */
export function digest(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= 24) return text;
  return `${chars.slice(0, 24).join("")}…`;
}

// ω99-272: #2 — 本地转写无限（用户令 09-10「本地转写无限」）：pushTurn/
// applyFrame ③/mergeChat 尾部三处的 MAX_CHAT_TURNS 逐出全撤——轮数不设帽，
// 长列由 transcript 滚动区 + 逐答折叠（Bubble 的 a 格线钳）承接。digest 配
// 对与 live 唯一性不变量原样保留。
/** 宠物源轮入账：旧末位冻结（live 唯一性），push {q,a:"",live:true}；
 *  q 允许空串（与主窗轮兜底格同形）。 */
export function pushTurn(c: PetChat, q: string): PetChat {
  const frozen = c.turns.map((t) => (t.live ? { ...t, live: false } : t));
  return { turns: [...frozen, { q, a: "", live: true }] as ChatTurn[] };
}

/** 帧归账（纯）：把 {busy,answerTail} 按规则序①②③归进活格/建新格。
 *  无格可归且无新轮可建时原引用返回（React setState 同值短路）。 */
export function applyFrame(c: PetChat, f: { busy: boolean; answerTail: string }): PetChat {
  const last = c.turns.length > 0 ? c.turns[c.turns.length - 1] : undefined;
  if (last === undefined) {
    if (f.answerTail === "") return c; // 无轮可归（规则①的空尾短路）
    return { turns: [{ q: "", a: f.answerTail, live: true }] }; // ①
  }
  if (last.live) {
    if (f.answerTail !== "") {
      if (last.a === f.answerTail) return c; // 同尾帧（节流重放）短路
      const turns = c.turns.slice();
      turns[turns.length - 1] = { ...last, a: f.answerTail }; // ②-a 填 a
      return { turns };
    }
    if (!f.busy) {
      const turns = c.turns.slice();
      turns[turns.length - 1] = { ...last, live: false }; // ②-b 冻结（a 保最后非空值）
      return { turns };
    }
    return c; // ②-c 推理期：不变
  }
  if (f.answerTail !== "") {
    return { turns: [...c.turns, { q: "", a: f.answerTail, live: true }] as ChatTurn[] }; // ③
  }
  return c; // 末位已冻结且无新尾：不变
}

/** ω99-271: #7 — 拉到的完整史与本地转写合并（纯）。史是事实源：本地轮按
 *  digest(q) 从尾向前对上史轮 → 升级为全文（q 全文 + a 完整，live 旗随本地
 *  ——史里已落定而本地还在流式的轮，拿全文冻结只差一帧化妆）。对不上的本地
 *  轮原样保留：主窗兜底格（q=""，pet 车道缺席时代的产物）与「史比本地旧」
 *  的 stale 拉取缺口都真实存在，丢掉就是新的不完整（ω99-272 起合并后不再
 *  截尾）。诚实边界：本地 unmatched 轮一律视为更新（stale 拉取的正
 *  确解）；「主窗兜底格与精灵史交错」这种车道闪断序无法从 digest 推出真实
 *  时序，按本地在后处理——纯呈现层顺序，不损内容。 */
export function mergeChat(history: readonly { q: string; a: string }[], local: PetChat): PetChat {
  const hist: ChatTurn[] = history.map((h) => ({ q: h.q, a: h.a, live: false }));
  const out: ChatTurn[] = []; // 新→旧构建，最后反转
  let i = local.turns.length - 1;
  let j = hist.length - 1;
  while (i >= 0 || j >= 0) {
    const t = i >= 0 ? local.turns[i] : undefined;
    const h = j >= 0 ? hist[j] : undefined;
    if (t !== undefined && h !== undefined && t.q !== "" && t.q === digest(h.q)) {
      out.push({ q: h.q, a: h.a, live: t.live }); // 配对升级：史全文胜出
      i -= 1;
      j -= 1;
    } else if (t !== undefined) {
      out.push(t); // 本地 unmatched（live 最先出=最新；settled unmatched=stale 缺口）
      i -= 1;
    } else {
      out.push(h!); // 史比本地长（重启后 fresh 本地 / 拉到了旧轮）
      j -= 1;
    }
  }
  return { turns: out.reverse() };
}
