// @vitest-environment jsdom
// ω99-104 — the main-window side of drop-to-delegate, RED-first. The pet
// window is a NATIVE drop target (Rust admits the paths into a 30s TTL
// allowlist and broadcasts pet-file-drop); this module is the receiving
// half: parse the payload, pre-flight admission against the file lane's
// numbers, then walk read_dropped_file → stage — serially, silently.
// Every transport is injectable; the default-deps test pins that production
// really goes through tauri-invoke (command invoke + event listen).
//
// ω99-119 翻新（期望语义变更，115 concern-1 先例）：管线终点从「立即
// fileSave + 自动 submit 一句固定文案」换成「铸币 ComposerFileDraft 草稿 →
// onStaged 回调（默认路由给 App 注册的 sink → fileSeed）」；fileSave/submit
// 移交 composer 自有附件轨（submit 时才存盘——隐私对齐图片轨）。dropPromptText
// 块随终点移除，文案职责移交 A 层 drop-intent.ts。旧断言 → 新断言对照表
// 见弧报告 omega99-119-report.md。
import { describe, expect, it, vi } from "vitest";
import {
  WUDAO_PET_DROP_EVENT,
  MAX_DROP_FILE_BYTES,
  parseDropPayload,
  droppedRejectionKind,
  admitDroppedFiles,
  delegateDroppedFiles,
  mountPetDropFiles,
  setPetDropStageSink,
} from "../src/pet-drop.js";
import { MAX_COMPOSER_FILES, MAX_FILE_BUDGET_BYTES, base64LengthOf } from "../src/attachments.js";
import type { ComposerFileDraft } from "../src/attachments.js";
import type { FileBlockWire, SubmitOutcome } from "../src/protocol.js";

const MIB = 1024 * 1024;
const f = (path: string, bytes = 10): { path: string; name: string; bytes: number } => ({
  path,
  name: path.split("/").pop() ?? path,
  bytes,
});
const block = (name: string): FileBlockWire => ({ kind: "file", name, bytes: 10, attachmentId: `id-${name}` });

// ---- parseDropPayload -------------------------------------------------------

describe("ω99-104 parseDropPayload（事件载荷形状守卫）", () => {
  it("合法载荷 → 按序原样返回", () => {
    expect(parseDropPayload({ paths: [f("/tmp/a.txt", 3), f("/tmp/b.md", 4)] })).toEqual([
      { path: "/tmp/a.txt", name: "a.txt", bytes: 3 },
      { path: "/tmp/b.md", name: "b.md", bytes: 4 },
    ]);
  });

  it("非对象 / 无 paths / paths 非数组 / 空数组 → null（事件被忽略）", () => {
    expect(parseDropPayload(null)).toBeNull();
    expect(parseDropPayload(undefined)).toBeNull();
    expect(parseDropPayload("paths")).toBeNull();
    expect(parseDropPayload({})).toBeNull();
    expect(parseDropPayload({ paths: {} })).toBeNull();
    expect(parseDropPayload({ paths: "x" })).toBeNull();
    expect(parseDropPayload({ paths: [] })).toBeNull();
  });

  it("坏条目只跳过自身，好条目照常通过", () => {
    expect(
      parseDropPayload({
        paths: [
          f("/ok.txt", 1),
          { path: 1, name: "x", bytes: 2 }, // path 非字符串
          { path: "/y", name: null, bytes: 2 }, // name 非字符串
          { path: "/z", name: "z", bytes: "2" }, // bytes 非数字
          null, // 非对象条目
        ],
      }),
    ).toEqual([{ path: "/ok.txt", name: "ok.txt", bytes: 1 }]);
  });
});

// ---- admission --------------------------------------------------------------

describe("ω99-104 admitDroppedFiles（投递准入：数量/单文件/批量预算）", () => {
  it("限额内全收，无 notice", () => {
    const { accepted, notice } = admitDroppedFiles([f("/a"), f("/b"), f("/c")], []);
    expect(accepted).toEqual([f("/a"), f("/b"), f("/c")]);
    expect(notice).toBeNull();
  });

  it("单文件超 20MiB → oversize（恰 20MiB 不拒——与 Rust 门同为严格大于）", () => {
    expect(droppedRejectionKind(f("/big", MAX_DROP_FILE_BYTES), [])).toBeNull();
    expect(droppedRejectionKind(f("/big", MAX_DROP_FILE_BYTES + 1), [])).toBe("oversize");
    const { accepted, notice } = admitDroppedFiles([f("/big", MAX_DROP_FILE_BYTES + 1)], []);
    expect(accepted).toEqual([]);
    expect(notice).toContain("20MiB");
  });

  it("数量超 9 → 前 9 收、余者 count（沿轨道累积，同 admitFileBatch 语义）", () => {
    const files = Array.from({ length: MAX_COMPOSER_FILES + 2 }, (_, i) => f(`/f${i}`));
    const { accepted, notice } = admitDroppedFiles(files, []);
    expect(accepted).toHaveLength(MAX_COMPOSER_FILES);
    expect(notice).toContain("数量上限");
  });

  it("批量 base64 预算超 50MiB → budget（前文件计入后来者的预算）", () => {
    // 20MiB 的 base64 ≈ 27.96MiB：第 1 个过，第 2 个把累计推过 50MiB
    const a = f("/a", 20 * MIB);
    const b = f("/b", 20 * MIB);
    expect(droppedRejectionKind(a, [])).toBeNull();
    expect(droppedRejectionKind(b, [{ byteLength: a.bytes }])).toBe("budget");
    expect(base64LengthOf(a.bytes) * 2).toBeGreaterThan(MAX_FILE_BUDGET_BYTES); // 前提成立
    const { accepted, notice } = admitDroppedFiles([a, b], []);
    expect(accepted).toEqual([a]);
    expect(notice).toContain("50MiB");
  });

  it("notice 列出每一种拒绝（混批）", () => {
    const files = [...Array.from({ length: MAX_COMPOSER_FILES }, (_, i) => f(`/ok${i}`)), f("/huge", MAX_DROP_FILE_BYTES + 1), f("/over")];
    const { notice } = admitDroppedFiles(files, []);
    expect(notice).toContain("20MiB");
    expect(notice).toContain("数量上限");
  });
});

// ---- delegateDroppedFiles ---------------------------------------------------
// ω99-119 翻新：终点=onStaged（读 → File 铸币 → 草稿一批回调）；fileSave/
// submit 移交 composer 自有 lane。旧断言 → 新断言对照见弧报告。

describe("ω99-104 delegateDroppedFiles（串行读→staged 草稿回调）", () => {
  const mk = (overrides?: Partial<Parameters<typeof delegateDroppedFiles>[0]>) => {
    const warn = vi.fn();
    const deps = {
      readDroppedFile: vi.fn(async (p: string) => btoa(`data-${p}`)),
      onStaged: vi.fn(),
      warn,
      ...overrides,
    };
    return deps;
  };
  const stagedNames = (onStaged: unknown): readonly string[] =>
    ((onStaged as { mock: { calls: [readonly ComposerFileDraft[]][] } }).mock.calls[0]?.[0] ?? []).map((d) => d.name);

  it("happy path：串行读 → 一次 onStaged，草稿 {name,byteLength,file} 与读回字节一致", async () => {
    const deps = mk();
    await delegateDroppedFiles(deps, [f("/tmp/a.txt"), f("/tmp/b.md")]);
    expect(deps.readDroppedFile).toHaveBeenNthCalledWith(1, "/tmp/a.txt");
    expect(deps.readDroppedFile).toHaveBeenNthCalledWith(2, "/tmp/b.md");
    expect(deps.onStaged).toHaveBeenCalledTimes(1);
    expect(stagedNames(deps.onStaged)).toEqual(["a.txt", "b.md"]);
    const drafts = (deps.onStaged as ReturnType<typeof vi.fn>).mock.calls[0]![0] as readonly ComposerFileDraft[];
    expect(drafts[0]!.byteLength).toBe("data-/tmp/a.txt".length);
    expect(drafts[0]!.file.size).toBe("data-/tmp/a.txt".length);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it("串行：任一时刻至多 1 个 read 在飞（不并发轰）", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const deps = mk({
      readDroppedFile: async (p: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight -= 1;
        order.push(p);
        return btoa(`data-${p}`);
      },
    });
    await delegateDroppedFiles(deps, [f("/a"), f("/b"), f("/c")]);
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(["/a", "/b", "/c"]);
  });

  it("单文件读失败 → warn 后跳过，幸存者照常 staged；全灭 → 零回调", async () => {
    const deps = mk({
      readDroppedFile: async (p: string) => {
        if (p === "/bad") throw new Error("path not admitted");
        return btoa(`data-${p}`);
      },
    });
    await delegateDroppedFiles(deps, [f("/good"), f("/bad"), f("/also-good")]);
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(deps.onStaged).toHaveBeenCalledTimes(1);
    expect(stagedNames(deps.onStaged)).toEqual(["good", "also-good"]);

    const all = mk({
      readDroppedFile: async () => {
        throw new Error("boom");
      },
    });
    await delegateDroppedFiles(all, [f("/x"), f("/y")]);
    expect(all.warn).toHaveBeenCalledTimes(2);
    expect(all.onStaged).not.toHaveBeenCalled();
  });

  it("onStaged 抛出 → warn 后放弃，不抛（永不抛 posture 沿）", async () => {
    const deps = mk({
      onStaged: () => {
        throw new Error("sink down");
      },
    });
    await expect(delegateDroppedFiles(deps, [f("/a")])).resolves.toBeUndefined();
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });
});

// ---- mountPetDropFiles ------------------------------------------------------

describe("ω99-104 mountPetDropFiles（监听接线 + 跨事件排队）", () => {
  const fakeClient = () => ({
    fileSave: vi.fn(async (inputs: readonly { data: string; name: string }[]) => inputs.map((i) => block(i.name))),
    submit: vi.fn(async (): Promise<SubmitOutcome> => "started"),
  });

  it("listen 接 WUDAO_PET_DROP_EVENT；合法载荷驱动管线（staged 回调）；坏载荷静默", async () => {
    const client = fakeClient();
    let handler: ((p: unknown) => void) | undefined;
    const read = vi.fn(async (p: string) => btoa(`data-${p}`));
    const onStaged = vi.fn();
    const warn = vi.fn();
    mountPetDropFiles(client, {
      listen: async (_e, h) => {
        handler = h;
        return () => {};
      },
      readDroppedFile: read,
      onStaged,
      warn,
    });
    handler!({ paths: [f("/a.txt")] });
    await new Promise((r) => setTimeout(r, 0));
    expect(read).toHaveBeenCalledWith("/a.txt");
    expect(onStaged).toHaveBeenCalledTimes(1);
    expect((onStaged.mock.calls[0]![0] as readonly ComposerFileDraft[])[0]!.name).toBe("a.txt");
    expect(client.fileSave).not.toHaveBeenCalled(); // ω99-119: drop 时不再存盘
    expect(client.submit).not.toHaveBeenCalled(); // ω99-119: drop 时不再自动发
    handler!("garbage"); // 非法载荷
    handler!(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("准入全拒 → warn 且零 read；部分拒 → 只读幸存者", async () => {
    const client = fakeClient();
    let handler: ((p: unknown) => void) | undefined;
    const read = vi.fn(async (p: string) => btoa(`data-${p}`));
    const warn = vi.fn();
    mountPetDropFiles(client, {
      listen: async (_e, h) => {
        handler = h;
        return () => {};
      },
      readDroppedFile: read,
      onStaged: vi.fn(),
      warn,
    });
    handler!({ paths: [f("/huge", MAX_DROP_FILE_BYTES + 1)] });
    await new Promise((r) => setTimeout(r, 0));
    expect(read).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    handler!({ paths: [f("/ok"), f("/huge2", MAX_DROP_FILE_BYTES + 1)] });
    await new Promise((r) => setTimeout(r, 0));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("/ok");
  });

  it("跨事件串行：第二次 drop 的 read 等第一次管线落定才开始", async () => {
    const client = fakeClient();
    let handler: ((p: unknown) => void) | undefined;
    let release: ((s: string) => void) | null = null;
    const started: string[] = [];
    const read = (p: string) =>
      new Promise<string>((resolve) => {
        started.push(p);
        release = resolve;
      });
    const onStaged = vi.fn();
    mountPetDropFiles(client, {
      listen: async (_e, h) => {
        handler = h;
        return () => {};
      },
      readDroppedFile: read,
      onStaged,
      warn: vi.fn(),
    });
    handler!({ paths: [f("/first")] });
    handler!({ paths: [f("/second")] });
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["/first"]); // 第二次还在队里
    release!(btoa("data-/first"));
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["/first", "/second"]);
    release!(btoa("data-/second"));
    await new Promise((r) => setTimeout(r, 0));
    expect(onStaged).toHaveBeenCalledTimes(2);
  });

  it("unmount → unlisten；晚到的 listen 落定也被收回", async () => {
    const client = fakeClient();
    const unlisten = vi.fn();
    const unmount = mountPetDropFiles(client, {
      listen: async () => unlisten,
      readDroppedFile: async () => "B64",
      warn: vi.fn(),
    });
    unmount();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("默认 deps 从 tauri-invoke 接线：invoke 收到 read_dropped_file + {path}", async () => {
    const invoke = vi.fn(async () => undefined);
    (window as typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__ = { invoke };
    try {
      const client = fakeClient();
      const warn = vi.fn();
      const unmount = mountPetDropFiles(client, { warn }); // 无 transformCallback → listen null（浏览器降级不炸）
      expect(invoke).not.toHaveBeenCalled(); // 没 listen 到事件，零调用
      unmount();
    } finally {
      delete (window as typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
    }
    // 直接驱动默认 readDroppedFile（经 delegateDroppedFiles 的默认实现路径）：
    // mount 的默认 read 在事件到达时才走 invoke——这里用第二轮 internals 驱动。
    // ω99-119 翻新：默认 onStaged 路由给已注册的 sink（App 侧 setFileSeed 的
    // 入口），fileSave/submit 不再发生（翻新前：client.fileSave 收 [{data:"QUJD",...}]）。
    const invoke2 = vi.fn(async () => "QUJD"); // "AB"
    (window as typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__ = { invoke: invoke2 };
    try {
      let handler: ((p: unknown) => void) | undefined;
      const client = fakeClient();
      const sink = vi.fn();
      setPetDropStageSink(sink);
      const unmount = mountPetDropFiles(client, {
        listen: async (_e, h) => {
          handler = h;
          return () => {};
        },
        warn: vi.fn(),
      });
      handler!({ paths: [f("/x")] });
      await new Promise((r) => setTimeout(r, 0));
      expect(invoke2).toHaveBeenCalledWith("read_dropped_file", { path: "/x" });
      expect(sink).toHaveBeenCalledTimes(1);
      const drafts = sink.mock.calls[0]![0] as readonly ComposerFileDraft[];
      expect(drafts[0]!.name).toBe("x");
      expect(drafts[0]!.byteLength).toBe(3); // QUJD → "ABC"
      expect(client.fileSave).not.toHaveBeenCalled();
      unmount();
    } finally {
      setPetDropStageSink(null);
      delete (window as typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
    }
  });

  it("事件名常量 = Rust 端 PET_FILE_DROP_EVENT", () => {
    expect(WUDAO_PET_DROP_EVENT).toBe("pet-file-drop");
  });
});
