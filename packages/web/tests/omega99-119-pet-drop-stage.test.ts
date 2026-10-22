// @vitest-environment jsdom
// ω99-119 — the B layer's NEW seam, RED-first: the drop pipeline's endpoint
// swaps from "fileSave + auto-submit" to "stage the drafts" —
// delegateDroppedFiles reads each file, mints a ComposerFileDraft (a REAL
// File holds the bytes), and hands the batch to onStaged. The production
// default routes drafts to the App-registered sink (setPetDropStageSink —
// App turns them into fileSeed, the composer's own attachment lane owns
// fileSave/submit from there). fileSave therefore NO LONGER fires at drop
// time — the negative asserts below pin that (隐私对齐图片轨: submit 才存盘).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  delegateDroppedFiles,
  mountPetDropFiles,
  setPetDropStageSink,
} from "../src/pet-drop.js";
import { readFileAsBase64 } from "../src/attachments.js";
import type { ComposerFileDraft } from "../src/attachments.js";
import type { SubmitOutcome } from "../src/protocol.js";

const f = (path: string, bytes = 10): { path: string; name: string; bytes: number } => ({
  path,
  name: path.split("/").pop() ?? path,
  bytes,
});
const b64 = (s: string): string => btoa(s);
/** jsdom 的 File 没有 arrayBuffer()/text()——经 FileReader（attachments 的
 *  同一条读径，返回纯 base64）读回内容做字节断言。 */
const fileText = async (file: File): Promise<string> => atob(await readFileAsBase64(file));
const fakeClient = () => ({
  fileSave: vi.fn(async (inputs: readonly { data: string; name: string }[]) =>
    inputs.map((i) => ({ kind: "file" as const, name: i.name, bytes: 10, attachmentId: `id-${i.name}` })),
  ),
  submit: vi.fn(async (): Promise<SubmitOutcome> => "started"),
});

afterEach(() => {
  setPetDropStageSink(null);
});

// ---- staged drafts 的形状 ----------------------------------------------------

describe("ω99-119 delegateDroppedFiles（终点=onStaged：读→File 铸币→草稿）", () => {
  it("staged 草稿 = {id,name,byteLength,file}，file 字节与 base64 解码后逐一相等", async () => {
    const onStaged = vi.fn();
    await delegateDroppedFiles(
      {
        readDroppedFile: async (p) => b64(`bytes-of-${p}`),
        onStaged,
        warn: vi.fn(),
      },
      [f("/tmp/a.pdf", 12), f("/tmp/b.csv", 8)],
    );
    expect(onStaged).toHaveBeenCalledTimes(1);
    const drafts = onStaged.mock.calls[0]![0] as readonly ComposerFileDraft[];
    expect(drafts.map((d) => d.name)).toEqual(["a.pdf", "b.csv"]);
    for (const d of drafts) {
      expect(typeof d.id).toBe("string");
      expect(d.id).not.toBe("");
      expect(d.byteLength).toBe(`bytes-of-/tmp/${d.name}`.length);
      expect(d.file).toBeInstanceOf(File);
      expect(d.file.size).toBe(d.byteLength);
      expect(d.file.name).toBe(d.name);
      expect(await fileText(d.file)).toBe(`bytes-of-/tmp/${d.name}`);
    }
  });

  it("中文文件名原样进草稿（内容与名解耦——btoa 只管 Latin1 内容）", async () => {
    const onStaged = vi.fn();
    await delegateDroppedFiles(
      {
        readDroppedFile: async () => b64("zhongwen-neirong"),
        onStaged,
        warn: vi.fn(),
      },
      [f("/tmp/报告.pdf", 15)],
    );
    const drafts = onStaged.mock.calls[0]![0] as readonly ComposerFileDraft[];
    expect(drafts[0]!.name).toBe("报告.pdf");
    expect(drafts[0]!.file.name).toBe("报告.pdf");
    expect(drafts[0]!.byteLength).toBe("zhongwen-neirong".length);
  });

  it("fileSave/submit 不再在 drop 时调用（终点已移交 composer 自有 lane）", async () => {
    const client = fakeClient();
    let handler: ((p: unknown) => void) | undefined;
    mountPetDropFiles(client, {
      listen: async (_e, h) => {
        handler = h;
        return () => {};
      },
      readDroppedFile: async () => b64("hi"),
      onStaged: vi.fn(),
      warn: vi.fn(),
    });
    handler!({ paths: [f("/a.txt")] });
    await new Promise((r) => setTimeout(r, 0));
    expect(client.fileSave).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("onStaged 抛出 → warn 吞掉，不抛（永不抛 posture 沿）", async () => {
    const warn = vi.fn();
    await expect(
      delegateDroppedFiles(
        {
          readDroppedFile: async () => b64("x"),
          onStaged: () => {
            throw new Error("sink down");
          },
          warn,
        },
        [f("/a")],
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ---- App 桥（sink 注册） ------------------------------------------------------

describe("ω99-119 setPetDropStageSink（mount 默认 onStaged 的路由终点）", () => {
  it("默认 onStaged 把草稿路由给已注册的 sink（App 侧 setFileSeed 的入参）", async () => {
    const client = fakeClient();
    const sink = vi.fn();
    setPetDropStageSink(sink);
    let handler: ((p: unknown) => void) | undefined;
    mountPetDropFiles(client, {
      listen: async (_e, h) => {
        handler = h;
        return () => {};
      },
      readDroppedFile: async () => b64("hi"),
      warn: vi.fn(),
    });
    handler!({ paths: [f("/x.md")] });
    await new Promise((r) => setTimeout(r, 0));
    expect(sink).toHaveBeenCalledTimes(1);
    const drafts = sink.mock.calls[0]![0] as readonly ComposerFileDraft[];
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.name).toBe("x.md");
    expect(client.fileSave).not.toHaveBeenCalled(); // drop 时不存盘
    expect(client.submit).not.toHaveBeenCalled(); // drop 时不自动发
  });

  it("未注册 sink（App 未挂）→ warn 后静默放弃，不炸", async () => {
    const client = fakeClient();
    const warn = vi.fn();
    let handler: ((p: unknown) => void) | undefined;
    mountPetDropFiles(client, {
      listen: async (_e, h) => {
        handler = h;
        return () => {};
      },
      readDroppedFile: async () => b64("hi"),
      warn,
    });
    handler!({ paths: [f("/y.txt")] });
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(client.fileSave).not.toHaveBeenCalled();
  });

  it("后注册者胜（重复 set 覆盖前值）；null 注销", async () => {
    const a = vi.fn();
    const b = vi.fn();
    setPetDropStageSink(a);
    setPetDropStageSink(b);
    const client = fakeClient();
    let handler: ((p: unknown) => void) | undefined;
    mountPetDropFiles(client, {
      listen: async (_e, h) => {
        handler = h;
        return () => {};
      },
      readDroppedFile: async () => b64("hi"),
      warn: vi.fn(),
    });
    handler!({ paths: [f("/z")] });
    await new Promise((r) => setTimeout(r, 0));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
