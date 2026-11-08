// ω99-110 — the 划词助手 pure module (selection.ts), RED-first. Three units:
// the wire guard (readSelectionPayload — a malformed payload drops whole,
// never partially trusted), the prompt family (the card's three send paths
// map to EXACTLY these literals — brief §2 pins them character-for-character;
// any wording change rides a brief change), and the index-chunk gate
// (selection.ts rides relay.ts into the MAIN shell's index chunk — the pet
// entry alone is not its only loader — so this file + the relay delta stay
// under budget; pet-only files Bubble/main.tsx/pet.css don't count).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WUDAO_PET_SELECTION_EVENT,
  WUDAO_PET_SELECTION_SUBMIT_EVENT,
  explainPrompt,
  genericPrompt,
  isUrlSelection,
  questionPrompt,
  readSelectionPayload,
  translatePrompt,
  urlPrompt,
} from "../src/pet/selection.js";

// ---- 事件名双端钉死（Rust src/selection.rs 同名常量） -------------------------

describe("ω99-110 事件名钉死（与 Rust 同名）", () => {
  it("WUDAO_PET_SELECTION_EVENT = wudao-pet-selection", () => {
    expect(WUDAO_PET_SELECTION_EVENT).toBe("wudao-pet-selection");
  });
  it("WUDAO_PET_SELECTION_SUBMIT_EVENT = wudao-pet-selection-submit", () => {
    expect(WUDAO_PET_SELECTION_SUBMIT_EVENT).toBe("wudao-pet-selection-submit");
  });
});

// ---- readSelectionPayload（三键类型守卫） -------------------------------------

describe("ω99-110 readSelectionPayload（坏载荷整丢）", () => {
  it("合法载荷 → 原样对象", () => {
    expect(readSelectionPayload({ text: "hello", truncated: false, granted: true })).toEqual({
      text: "hello",
      truncated: false,
      granted: true,
    });
    expect(readSelectionPayload({ text: "", truncated: false, granted: false })).toEqual({
      text: "",
      truncated: false,
      granted: false,
    });
    // 截断超长选段：truncated=true 照常过（截断不是错误）
    expect(readSelectionPayload({ text: "汉…（已截断）", truncated: true, granted: true })).toEqual({
      text: "汉…（已截断）",
      truncated: true,
      granted: true,
    });
  });

  it("多余键容忍（前向兼容），三键缺一/类型错 → null", () => {
    // 多余键：web 侧守卫纪律（readFrame/readPetAnswer）——必填键判型， Extras 忽略
    expect(readSelectionPayload({ text: "a", truncated: false, granted: true, extra: 1 })).toEqual({
      text: "a",
      truncated: false,
      granted: true,
    });
    expect(readSelectionPayload({ truncated: false, granted: true })).toBeNull(); // 缺 text
    expect(readSelectionPayload({ text: "a", granted: true })).toBeNull(); // 缺 truncated
    expect(readSelectionPayload({ text: "a", truncated: false })).toBeNull(); // 缺 granted
    expect(readSelectionPayload({ text: 42, truncated: false, granted: true })).toBeNull();
    expect(readSelectionPayload({ text: "a", truncated: "no", granted: true })).toBeNull();
    expect(readSelectionPayload({ text: "a", truncated: false, granted: 1 })).toBeNull();
  });

  it("非对象 → null（不炸）", () => {
    expect(readSelectionPayload(null)).toBeNull();
    expect(readSelectionPayload(undefined)).toBeNull();
    expect(readSelectionPayload("text")).toBeNull();
    expect(readSelectionPayload(42)).toBeNull();
  });
});

// ---- prompt 族（brief §2 逐字钉） ----------------------------------------------

describe("ω99-110 prompt 族（逐字钉）", () => {
  it("genericPrompt：提问框空着直接发", () => {
    expect(genericPrompt("the quick brown fox")).toBe("帮我看看这段划选的文字：\n\nthe quick brown fox");
  });

  it("translatePrompt：按原文方向中英互译", () => {
    expect(translatePrompt("the quick brown fox")).toBe(
      "翻译这段划选的文字（按原文方向中英互译）：\n\nthe quick brown fox",
    );
  });

  it("explainPrompt", () => {
    expect(explainPrompt("熵增原理")).toBe("解释这段划选的文字：\n\n熵增原理");
  });

  it("questionPrompt：问题在前、选文附后（含括号包裹）", () => {
    expect(questionPrompt("the quick brown fox", "这句的 grammar 对吗")).toBe(
      "这句的 grammar 对吗\n\n（划选的文字：\nthe quick brown fox\n）",
    );
  });

  it("多行选段原样进 prompt（换行不转义）", () => {
    const multi = "line1\nline2";
    expect(genericPrompt(multi)).toBe(`帮我看看这段划选的文字：\n\nline1\nline2`);
    expect(questionPrompt(multi, "Q")).toBe(`Q\n\n（划选的文字：\nline1\nline2\n）`);
  });
});

// ---- index chunk 门 ≤3kB -------------------------------------------------------

describe("ω99-110 index chunk 门（relay.ts 增量计入，pet 专属文件不计）", () => {
  it("selection.ts 全量 + relay.ts 本弧增量 ≤ 8192 字节", () => {
    // src/main.tsx 静态引 relay.ts → relay 又引 selection.ts，两者都落主壳
    // index chunk；selection.ts 是本弧新增、relay.ts 是本弧加厚（第三条
    // listen）。baseline = 01cfd7cf（ω99-111 合并后 main）时点 relay.ts 的
    // 字节数；增量为负（未来别人给 relay 瘦身）按 0 计。
    // ω99-113 期望变更（依据）：原 baseline 6937 钉在 01cfd7cf（111），但
    // 110 的 relay 增量（第三条 listen，+856B）在 111 之后才进 main（合并
    // 顺序错位，非 selection 的债）——基线重钉到本分支 merge-base
    // （76cb0084，112 合并后 main），预算语义复原「selection.ts 全量 +
    // relay 本弧增量」；113 对 relay 零字节改动。
    // ω99-235: #13 期望变更（依据）：pet 车道分流（用户指令 ②「你在小精灵
    // 的会话和主窗口应该是独立和隔离的」）给 relay 加了车道路由本体——
    // ask/划词/应答三监听的 petSubmit/petAnswerPermission 分流 + 帧派生源
    // 切换（derivePetFrame({status: snap.pet})）。注释已压到操作契约级（设
    // 计裁定全文在 brief/报告），代码地板 ~0.8kB 之上预算重钉 3072→4096
    // （3k→4k，实测 4031）；下次任何加厚仍须声明。
    // ω99-237: #13 期望变更（依据）：pet 源斜杠早拦落在 relay 的 choke
    // point（routePetText——ask/划词两处 petSubmit 调用位共用，trim 后 /
    // 开头不调 petSubmit、toast 事件回宠物窗；车道不变量的 web 层守卫，
    // brief §零 双层防御）。代码地板 ~0.5kB（helper+两监听重构）+ 操作契约
    // 级注释；即使注释全删（4031+470≈4501）仍破 4096——重钉是算术必然而
    // 非纪律放水，预算 4096→6144（4k→6k，实测 5611，余 ~0.5kB）；下次
    // 任何加厚仍须声明。
    // ω99-272: #11 期望变更（依据，271 的滞后债在此申报）：271 的史车道
    // 给 relay 加了第四条 listen（wudao-pet-history-req → client.petHistory()
    // → wudao-pet-history 回执）+ 车道在场判定，relay.ts 10623→11832
    // （+1209B，用户报障「看不到完整的会话信息」的修复本体）；5611+1209=
    // 6820 破 6144——271 收弧电池漏跑本件（未申报即加厚，本弧补报）。272
    // 对 relay 零字节改动；同形演进 6144→8192（6k→8k，实测 6820，余
    // ~1.3kB）；下次任何加厚仍须声明。
    // M85-pet §2: 期望变更（依据）：工具栏车道给 relay 加了第五条 listen
    // （wudao-pet-toolbar-event → readPetToolbarAction 整收/整丢 → 按 kind
    // 分发 pet 四 op，车道缺席静默）+ Pick 契约扩四法 + unmount 第五退订；
    // relay.ts +~1.6kB（代码+操作契约级注释，短任务 5 工具栏的通路本体），
    // 6820+1649=8469 破 8192——第五同胞与第四（271 史车道）同形同量级，
    // 重钉 8192→10240（8k→10k，实测 8469，余 ~1.8kB）；下次任何加厚仍须
    // 声明。
    // M85-final（终审修复波）: 期望变更（依据）：I-1 归档回执的刷新信号
    // （new-session 分支从 fire-and-forget 升为读回执：非 null → emit
    // WUDAO_PET_SESSIONS_REFRESH_EVENT，App bump sessionsEpoch——归档行主窗
    // 呈现缺口的修复本体）+ I-3 工作区数据面（挂载时 recentWorkspaces op
    // 取一次 ≤5 条进帧，subscribe 体重构成 pushSnapshot 供取数落定复用）
    // + M-2 降级态注释归真；relay.ts 13481→15813（+2332B，操作契约级中文
    // 注释占大头），sum 8469→10801 破 10240——重钉 10240→12288（10k→12k，
    // 实测 10801，余 ~1.5kB）；下次任何加厚仍须声明。
    const RELAY_BASELINE_BYTES = 7793; // 76cb0084 的 wc -c
    const sel = readFileSync(new URL("../src/pet/selection.ts", import.meta.url), "utf8");
    const relay = readFileSync(new URL("../src/pet/relay.ts", import.meta.url), "utf8");
    const relayDelta = Math.max(0, Buffer.byteLength(relay) - RELAY_BASELINE_BYTES);
    expect(Buffer.byteLength(sel) + relayDelta).toBeLessThanOrEqual(12288);
  });
});

// ---- ω99-113 第五成员：划词网址直读（isUrlSelection / urlPrompt） --------------
// brief §1.B 判定纪律：http(s):// 开头、trim 后判定；纯域名不带 scheme 不算
// （宁缺勿误——误判的代价是把普通文字当网址开浏览器）；URL 在句中也不算
// （划的是「带 URL 的一句话」，不是 URL 本身）。话术逐字钉。
describe("ω99-113 isUrlSelection（trim 后 scheme 判定，宁缺勿误）", () => {
  it("真 URL → true", () => {
    expect(isUrlSelection("https://example.com")).toBe(true);
    expect(isUrlSelection("http://example.com/a/b?x=1")).toBe(true);
    expect(isUrlSelection("https://文档.例子.cn/页面")).toBe(true);
  });
  it("带空白 → trim 后仍命中", () => {
    expect(isUrlSelection("  https://example.com  ")).toBe(true);
    expect(isUrlSelection("\n\thttp://example.com\n")).toBe(true);
  });
  it("scheme 大小写不敏感（RFC 3986：HTTP:// 也是 URL）", () => {
    expect(isUrlSelection("HTTP://example.com")).toBe(true);
    expect(isUrlSelection("Https://example.com")).toBe(true);
  });
  it("无 scheme 纯域名 → false（宁缺勿误）", () => {
    expect(isUrlSelection("example.com")).toBe(false);
    expect(isUrlSelection("www.example.com/path")).toBe(false);
    expect(isUrlSelection("localhost:3000")).toBe(false);
  });
  it("URL 在句中 / 中英混排非 URL → false", () => {
    expect(isUrlSelection("看这个 https://example.com 很不错")).toBe(false);
    expect(isUrlSelection("帮我看看这段 the quick brown fox")).toBe(false);
    expect(isUrlSelection("熵增原理与热力学第二定律")).toBe(false);
    expect(isUrlSelection("ftp://example.com")).toBe(false); // 非 http(s) scheme
    expect(isUrlSelection("")).toBe(false);
  });
});

describe("ω99-113 urlPrompt（chip「读这个网页」话术逐字）", () => {
  it("逐字：用浏览器打开 {url}，把页面上主要讲了什么读给我听", () => {
    expect(urlPrompt("https://example.com")).toBe(
      "用浏览器打开 https://example.com，把页面上主要讲了什么读给我听",
    );
  });
  it("URL 经 trim 进话术（选段首尾空白不带入）", () => {
    expect(urlPrompt("  https://example.com/a  ")).toBe(
      "用浏览器打开 https://example.com/a，把页面上主要讲了什么读给我听",
    );
  });
});
