// ω99-113 — busyTools 态的人话旁白（弧主菜 A），RED-first。112 落了
// browser_* 六工具，宠物面对 busyTools 却只能说工具名（或沉默）——违反
// user-facing copy = benefits。本文件钉：六条映射逐字；browser_click 的
// 摘要位与空摘要降级（今日 summarizeToolCall 无 browser 分支，summary 常
// 为空串——宁降级不出空「」）；未知 browser_* 工具的降级路径（未来加工具
// 不裸露英文名）；以及全部产出不含实现术语。
//
// v7 γ1（a reference harness pet v2「工作种类→表达」）：映射扩到全工具分类——读写/
// 检索/命令/网络/office/电脑操作/等待/编排各钉代表例（含摘要插值与空摘要
// 降级两条臂）；未知工具（无精确名、无已知前缀族）维持 null（诚实沉默，
// 113 的回归风险最小化边界继续成立）；工作种类分类（busyToolWorkKind）
// 逐类钉；对象位 24 码点帽（长命令/长路径不撑爆 184px 气泡）。
import { describe, expect, it } from "vitest";
// namespace 引用：实现落地前逐断言红，而不是命名导入的模块链接错。
import * as narration from "../src/pet/busy-narration.js";

/** 固定字面量（不含摘要位）必须纯中文+省略号——出现 ASCII 字母即裸露实现术语。 */
function expectNoImplementationTerm(s: string): void {
  expect(s).not.toMatch(/[A-Za-z]/);
  expect(s).not.toContain("browser");
}

describe("ω99-113 六条映射逐字（brief §1.A 表，γ1 扩表不动这五条）", () => {
  it("browser_open → 正在打开网页…", () => {
    expect(narration.busyToolNarration("browser_open", "")).toBe("正在打开网页…");
  });
  it("browser_snapshot → 正在读页面…", () => {
    expect(narration.busyToolNarration("browser_snapshot", "")).toBe("正在读页面…");
  });
  it("browser_type → 正在填写输入框", () => {
    expect(narration.busyToolNarration("browser_type", "")).toBe("正在填写输入框");
  });
  it("browser_scroll → 正在往下翻页面", () => {
    expect(narration.busyToolNarration("browser_scroll", "")).toBe("正在往下翻页面");
  });
  it("browser_close → 已合上浏览器窗口", () => {
    expect(narration.busyToolNarration("browser_close", "")).toBe("已合上浏览器窗口");
  });

  it("六条固定字面量均无实现术语（无 ASCII 字母）", () => {
    for (const name of ["browser_open", "browser_snapshot", "browser_type", "browser_scroll", "browser_close"]) {
      expectNoImplementationTerm(narration.busyToolNarration(name, "")!);
    }
  });
});

describe("ω99-113 browser_click：摘要进旁白 + 空摘要降级", () => {
  it("有摘要 → 正在点击页面上的「{summary}」", () => {
    expect(narration.busyToolNarration("browser_click", "登录按钮")).toBe("正在点击页面上的「登录按钮」");
  });
  it("空摘要 → 降级「正在点击页面」（不出空引号）", () => {
    expect(narration.busyToolNarration("browser_click", "")).toBe("正在点击页面");
    expect(narration.busyToolNarration("browser_click", "   ")).toBe("正在点击页面");
  });
  it("带摘要时模板段（「」外）无实现术语", () => {
    const s = narration.busyToolNarration("browser_click", "登录按钮")!;
    expect(s.startsWith("正在点击页面上的「") && s.endsWith("」")).toBe(true);
  });
});

describe("ω99-113 未知 browser_* 工具降级（未来加工具不裸露英文名）", () => {
  it("映射不中 + 有摘要 → 正在处理：{summary}", () => {
    expect(narration.busyToolNarration("browser_navigate_next", "跳到第 2 页")).toBe("正在处理：跳到第 2 页");
  });
  it("映射不中 + 空摘要 → 正在处理网页任务", () => {
    expect(narration.busyToolNarration("browser_download_file", "")).toBe("正在处理网页任务");
  });
  it("降级产出同样不带工具名本体", () => {
    expect(narration.busyToolNarration("browser_new_thing", "")).not.toContain("browser_new_thing");
  });
});

describe("v7 γ1 browser 面后增动词（xy 变体 + see/downloads）", () => {
  it("browser_click_xy 同 click 语义（含摘要插值）", () => {
    expect(narration.busyToolNarration("browser_click_xy", "提交按钮")).toBe("正在点击页面上的「提交按钮」");
    expect(narration.busyToolNarration("browser_click_xy", "")).toBe("正在点击页面");
  });
  it("browser_type_xy / browser_scroll_xy 沿 type/scroll 文案", () => {
    expect(narration.busyToolNarration("browser_type_xy", "")).toBe("正在填写输入框");
    expect(narration.busyToolNarration("browser_scroll_xy", "")).toBe("正在往下翻页面");
  });
  it("browser_see → 正在看页面…；browser_downloads → 正在查看下载的文件", () => {
    expect(narration.busyToolNarration("browser_see", "")).toBe("正在看页面…");
    expect(narration.busyToolNarration("browser_downloads", "")).toBe("正在查看下载的文件");
  });
});

describe("v7 γ1 全工具分类映射（读写/检索/命令/网络/office/电脑/等待/编排）", () => {
  it("读写：摘要（路径）进旁白 + 空摘要降级", () => {
    expect(narration.busyToolNarration("read_file", "src/app.ts")).toBe("正在读文件「src/app.ts」");
    expect(narration.busyToolNarration("write_file", "")).toBe("正在写文件");
    expect(narration.busyToolNarration("edit", "a.ts")).toBe("正在改文件「a.ts」");
    expect(narration.busyToolNarration("edit", "")).toBe("正在改文件");
  });
  it("检索：glob/grep 有摘要/空摘要两臂", () => {
    expect(narration.busyToolNarration("grep", "TODO")).toBe("正在搜代码「TODO」");
    expect(narration.busyToolNarration("glob", "")).toBe("正在找文件");
  });
  it("命令：shell/run_script", () => {
    expect(narration.busyToolNarration("shell", "npm test")).toBe("正在跑命令「npm test」");
    expect(narration.busyToolNarration("shell", "")).toBe("正在跑命令");
    expect(narration.busyToolNarration("run_script", "")).toBe("正在跑脚本");
  });
  it("网络：web_fetch/web_search", () => {
    expect(narration.busyToolNarration("web_search", "agent harness")).toBe("正在查资料「agent harness」");
    expect(narration.busyToolNarration("web_fetch", "")).toBe("正在读网页");
  });
  it("office：三面代表例（make/read/append/replace + 版式）", () => {
    expect(narration.busyToolNarration("make_xlsx", "")).toBe("正在做表格");
    expect(narration.busyToolNarration("make_pptx", "")).toBe("正在做演示文稿");
    expect(narration.busyToolNarration("read_docx", "")).toBe("正在读文档");
    expect(narration.busyToolNarration("append_xlsx", "")).toBe("正在往表格里补内容");
    expect(narration.busyToolNarration("replace_pptx", "")).toBe("正在改演示文稿内容");
    expect(narration.busyToolNarration("set_pptx_notes", "")).toBe("正在写演示备注");
    expect(narration.busyToolNarration("set_docx_header", "")).toBe("正在设置文档页眉");
  });
  it("电脑操作：摘要（坐标/应用名）进旁白 + 无参固定", () => {
    expect(narration.busyToolNarration("computer_click", "(12, 34)")).toBe("正在点击屏幕（(12, 34)）");
    expect(narration.busyToolNarration("computer_click", "")).toBe("正在点击屏幕");
    expect(narration.busyToolNarration("app_activate", "Safari")).toBe("正在切换到「Safari」");
    expect(narration.busyToolNarration("app_activate", "")).toBe("正在切换应用");
    expect(narration.busyToolNarration("screen_capture", "")).toBe("正在截取屏幕");
    expect(narration.busyToolNarration("computer_scroll", "")).toBe("正在滚动窗口");
  });
  it("等待：computer_wait/sleep 固定（ref 形不进用户面）", () => {
    expect(narration.busyToolNarration("computer_wait", "[e3] 值「确定」")).toBe("正在等界面就绪");
    expect(narration.busyToolNarration("sleep", "")).toBe("正在等待");
  });
  it("编排：task/subagent/mission_*（subagent 的英文工具名摘要不插值）", () => {
    expect(narration.busyToolNarration("task", "")).toBe("正在派子任务");
    expect(narration.busyToolNarration("subagent", "shell")).toBe("正在跑子任务");
    expect(narration.busyToolNarration("mission_plan", "")).toBe("正在编排任务计划");
    expect(narration.busyToolNarration("mission_complete", "")).toBe("正在结算任务成果");
  });
  it("全部固定字面量无实现术语（逐表扫描）", () => {
    for (const name of [
      "make_xlsx", "make_docx", "make_pptx", "read_xlsx", "read_docx", "read_pptx",
      "append_xlsx", "append_docx", "append_pptx", "replace_xlsx", "replace_docx", "replace_pptx",
      "set_docx_header", "clear_docx_header", "set_docx_first_page", "set_docx_even_pages", "set_pptx_notes",
      "computer_scroll", "computer_drag", "app_list", "screen_capture",
      "computer_wait", "sleep", "notebook", "todo_write",
      "task", "subagent", "mission_plan", "mission_start", "mission_next", "mission_complete",
      "mission_fail", "mission_know_add", "mission_know", "mission_bundle", "mission_ratchet",
      "ask_user", "watch_create", "watch_list", "watch_delete",
      "monitor_start", "monitor_stop", "monitor_list", "monitor_read",
      "browser_see", "browser_downloads",
    ]) {
      expectNoImplementationTerm(narration.busyToolNarration(name, "")!);
    }
  });
});

describe("v7 γ1 未知工具 → null（诚实沉默边界继续成立）", () => {
  it("空名 / 前缀擦边（xbrowser_open / browser）→ null", () => {
    expect(narration.busyToolNarration("", "s")).toBeNull();
    expect(narration.busyToolNarration("xbrowser_open", "s")).toBeNull();
    expect(narration.busyToolNarration("browser", "s")).toBeNull();
  });
  it("未来未知内建（无已知前缀族）→ null", () => {
    expect(narration.busyToolNarration("some_future_tool", "")).toBeNull();
  });
  it("已知前缀族的未来新动词 → 族降级（不裸露英文名）", () => {
    expect(narration.busyToolNarration("computer_hover", "(1, 2)")).toBe("正在操作电脑：(1, 2)");
    expect(narration.busyToolNarration("computer_hover", "")).toBe("正在操作电脑");
    expect(narration.busyToolNarration("mission_archive", "")).toBe("正在推进任务");
    expect(narration.busyToolNarration("mcp__server__tool", "查库存")).toBe("正在调用扩展工具：查库存");
  });
});

describe("v7 γ1 对象位 24 码点帽（长命令/长路径不撑爆气泡）", () => {
  it("超帽命令截断且带「…」告知", () => {
    const long = "pnpm test --filter=@wudao/cli --reporter=verbose";
    const out = narration.busyToolNarration("shell", long)!;
    expect(out.startsWith("正在跑命令「")).toBe(true);
    expect(out.endsWith("…」")).toBe(true);
    expect(Array.from(out).length).toBeLessThan(Array.from(long).length + 10);
  });
  it("多行摘要只取首行", () => {
    expect(narration.busyToolNarration("shell", "echo hi\necho bye")).toBe("正在跑命令「echo hi」");
  });
});

describe("v7 γ1 busyToolWorkKind（宠物形态的分类锚）", () => {
  it("逐类：browser/files/search/command/web/office/computer/wait/notes/orchestration/watch/ask/extension", () => {
    expect(narration.busyToolWorkKind("browser_open")).toBe("browser");
    expect(narration.busyToolWorkKind("read_file")).toBe("files");
    expect(narration.busyToolWorkKind("grep")).toBe("search");
    expect(narration.busyToolWorkKind("shell")).toBe("command");
    expect(narration.busyToolWorkKind("web_search")).toBe("web");
    expect(narration.busyToolWorkKind("make_xlsx")).toBe("office");
    expect(narration.busyToolWorkKind("computer_click")).toBe("computer");
    expect(narration.busyToolWorkKind("computer_wait")).toBe("wait");
    expect(narration.busyToolWorkKind("sleep")).toBe("wait");
    expect(narration.busyToolWorkKind("notebook")).toBe("notes");
    expect(narration.busyToolWorkKind("task")).toBe("orchestration");
    expect(narration.busyToolWorkKind("mission_next")).toBe("orchestration");
    expect(narration.busyToolWorkKind("watch_list")).toBe("watch");
    expect(narration.busyToolWorkKind("monitor_read")).toBe("watch");
    expect(narration.busyToolWorkKind("ask_user")).toBe("ask");
    expect(narration.busyToolWorkKind("mcp__x__y")).toBe("extension");
  });
  it("computer_wait 精确名先于 computer_ 前缀（等待是独立形态类）", () => {
    expect(narration.busyToolWorkKind("computer_wait")).not.toBe("computer");
  });
  it("未知 → null（与旁白同边界）", () => {
    expect(narration.busyToolWorkKind("browser")).toBeNull();
    expect(narration.busyToolWorkKind("")).toBeNull();
    expect(narration.busyToolWorkKind("future_thing")).toBeNull();
  });
});

describe("ω99-113 busyNarrationOf：列表取最新可旁白行", () => {
  const row = (name: string, summary = ""): { name: string; summary: string } => ({ name, summary });
  it("空表 → null", () => {
    expect(narration.busyNarrationOf([])).toBeNull();
  });
  it("全不可旁白（未知工具）→ null", () => {
    expect(narration.busyNarrationOf([row("future_a", "/a"), row("future_b", "/b")])).toBeNull();
  });
  it("单 browser 行 → 该行旁白", () => {
    expect(narration.busyNarrationOf([row("browser_snapshot")])).toBe("正在读页面…");
  });
  it("多行并发 → 最新（末位）可旁白行胜出", () => {
    expect(narration.busyNarrationOf([row("browser_open"), row("browser_snapshot")])).toBe("正在读页面…");
  });
  it("末位不可旁白 → 往回找到可旁白行（最新可旁白，不是末位强转）", () => {
    expect(narration.busyNarrationOf([row("browser_open"), row("read_file", "/a")])).toBe("正在读文件「/a」");
    expect(narration.busyNarrationOf([row("read_file", "/a"), row("browser_click", "搜索框")])).toBe("正在点击页面上的「搜索框」");
  });
  it("v7 γ1：非 browser 工具现在可旁白（113 的 null 取舍兑现为终态）", () => {
    expect(narration.busyNarrationOf([row("shell", "vitest run")])).toBe("正在跑命令「vitest run」");
    expect(narration.busyNarrationOf([row("make_pptx", "")])).toBe("正在做演示文稿");
  });
});

describe("v7 γ1 busyWorkKindOf：与旁白同源同行（最新可分类行）", () => {
  const row = (name: string, summary = ""): { name: string; summary: string } => ({ name, summary });
  it("office 行 → office", () => {
    expect(narration.busyWorkKindOf([row("make_docx", "")])).toBe("office");
  });
  it("末位未知 → 往回找（与 busyNarrationOf 同规则）", () => {
    expect(narration.busyWorkKindOf([row("shell", "ls"), row("future_x", "")])).toBe("command");
  });
  it("空表/全未知 → null", () => {
    expect(narration.busyWorkKindOf([])).toBeNull();
    expect(narration.busyWorkKindOf([row("future_x", "")])).toBeNull();
  });
});
