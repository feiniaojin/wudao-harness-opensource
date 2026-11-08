// @vitest-environment jsdom
// M85-final I-2（终审修复波）— WorkspaceChip 同源改锚的正向断言（spec §5 点
// 名、终审判定缺失）：M85 §4 给 chip 加了 labelName/labelPath 两 props（显示
// 与切换语义分离——pick 走 agent-root 缝，label 说 agent root 的真话），但存
// 量测试只走了 agentRoot 缺席的回落路径（omega99-307 断言面板根 title——绿
// 但不钉新契约）。本文件补正向钉：挂 labelName/labelPath → chip 显示
// labelName、title=labelPath；不传 → 回落 root 派生（兼容面零演进）。另带
// 一条源收据：App 两挂载点的 labelName 表达式与 StatusBar 的 workspaceName
// 同一 pathName(agentRoot)（「同源」的字面钉）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { existsSync, readFileSync } from "node:fs";
import { WorkspaceChip } from "../src/components/WorkspaceChip.js";
import type { FileOpsClient } from "../src/file-ops.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 最小 FileOpsClient（chip 只经 useRecentWorkspaces 读 recentWorkspaces——
 *  菜单不开就不取；fileTree/fileRead 是接口必填面，测试不触）。 */
const fakeClient: FileOpsClient = {
  fileTree: vi.fn(async () => ({ entries: [] })),
  fileRead: vi.fn(async () => ({ content: "", truncated: false, totalBytes: 0, lines: 0, language: "text" })),
  recentWorkspaces: vi.fn(async () => ({ workspaces: [] })),
};
const noop = (): void => {};

let root: Root | null = null;
const mount = (props: Record<string, unknown>): HTMLElement => {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => {
    root?.render(
      <WorkspaceChip
        client={fakeClient}
        root="/panel/root"
        connected={true}
        onPick={noop}
        onOpenOther={noop}
        {...props}
      />,
    );
  });
  return container;
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

const chip = (c: HTMLElement): HTMLButtonElement | null => c.querySelector<HTMLButtonElement>(".chip.work");

describe("M85-final I-2 WorkspaceChip 同源锚（labelName/labelPath 正向 + 回落兼容）", () => {
  it("挂 labelName/labelPath → chip 文本=labelName、title=labelPath（agent root 说真话，与面板根分离）", () => {
    const c = mount({ labelName: "agentDir", labelPath: "/real/root" });
    expect(chip(c)?.textContent).toContain("agentDir");
    expect(chip(c)?.textContent).not.toContain("root\n"); // 面板根 basename 不再顶标签（回落位被锚位接管）
    expect(chip(c)?.getAttribute("title")).toBe("/real/root"); // hover 全路径=agent root
  });

  it("不传（老挂载点/agentRoot 缺席）→ 回落 root 派生：文本=rootBasename(root)、title=root（兼容断言——既有行为零演进）", () => {
    const c = mount({});
    expect(chip(c)?.textContent).toContain("root"); // rootBasename("/panel/root")
    expect(chip(c)?.getAttribute("title")).toBe("/panel/root");
  });

  it("labelName 在场但 labelPath 缺 → title 回落 root（两锚位各自独立缺省，不互相绑架）", () => {
    const c = mount({ labelName: "agentDir" });
    expect(chip(c)?.textContent).toContain("agentDir");
    expect(chip(c)?.getAttribute("title")).toBe("/panel/root");
  });

  it("源收据：App 的 chip 挂载与 StatusBar 工作区段同一表达式（「同源」的字面钉）", () => {
    const findSrc = (rel: string): string => {
      const hit = ["src/components", "packages/web/src/components"]
        .map((d) => `${process.cwd()}/${d}/${rel}`)
        .find((p) => existsSync(p));
      if (hit === undefined) throw new Error(`source not found: ${rel}`);
      return readFileSync(hit, "utf8");
    };
    const appSrc = findSrc("App.tsx");
    // chip 挂载：labelName=pathName(agentRoot)、labelPath=agentRoot 全路径。
    expect(appSrc).toContain("labelName={agentRoot !== \"\" ? pathName(agentRoot) : undefined}");
    expect(appSrc).toContain("labelPath={agentRoot !== \"\" ? agentRoot : undefined}");
    // StatusBar 工作区段（App:挂载点传 workspaceName/workspacePath props）与
    // chip 的 labelName/labelPath 是同一 basename/全路径表达式——两处同源。
    expect(appSrc).toContain("workspaceName={agentRoot !== \"\" ? pathName(agentRoot) : undefined}");
    expect(appSrc).toContain("workspacePath={agentRoot !== \"\" ? agentRoot : undefined}");
  });
});
