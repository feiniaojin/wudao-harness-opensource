// ω99-212: #R — 电脑操作能力 receipts（6 工具面）。★测试红线：child_process
// 全 mock（注入 ExecSeam 假件）——绝无真实键鼠事件/截屏触发；夹具零盘写。
import { describe, expect, it } from "vitest";
import { access, writeFile } from "node:fs/promises";
import {
  applescriptEscape,
  buildTypeScript,
  buildKeyScript,
  buildActivateScript,
  buildListAppsScript,
  chunkTypingText,
  sanitizeTypingText,
  sanitizeAppName,
  resolveKeyCombo,
  parseProcessList,
  resolveClickHelper,
  classifyOsascriptFailure,
  isBlankScreenshot,
  PERM_MARKER_ACCESSIBILITY,
  PERM_MARKER_SCREEN_RECORDING,
  TYPE_CHUNK_CHARS,
  type ExecSeam,
  type ExecResult,
} from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";

// Platform contract: this suite exercises the macOS execution plane
// (osascript seams) — skip off-darwin CI runners instead of failing
// against the tool's platform guard.
const d: typeof describe = process.platform === "darwin" ? describe : describe.skip;

// ---------------------------------------------------------------------------
// §1 AppleScript 构造（type/key/activate 的脚本文本 + 转义正确性）
// ---------------------------------------------------------------------------
d("ω99-212 §1 — AppleScript 构造", () => {
  it("type：单块文本 → keystroke 脚本；中文原样进字面量", () => {
    const clean = sanitizeTypingText("你好，世界");
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(buildTypeScript(clean.text)).toBe('tell application "System Events" to keystroke "你好，世界"');
  });

  it("type：引号与反斜杠都转义（\\\" 与 \\\\），逃不出字面量", () => {
    const clean = sanitizeTypingText('say "hi" \\ done');
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    const script = buildTypeScript(clean.text);
    expect(script).toBe('tell application "System Events" to keystroke "say \\"hi\\" \\\\ done"');
  });

  it("key：cmd+c → key code 8 {command down}；return → key code 36", () => {
    expect(buildKeyScript("cmd+c")).toEqual({ ok: true, script: 'tell application "System Events" to key code 8 {command down}' });
    expect(buildKeyScript("return")).toEqual({ ok: true, script: 'tell application "System Events" to key code 36' });
  });

  it("key：组合键多修饰按规范序（command/control/option/shift）", () => {
    const r = buildKeyScript("shift+cmd+t");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.script).toBe('tell application "System Events" to key code 17 {command down, shift down}');
  });

  it("activate：名字形 → tell application \"名字\" to activate", () => {
    const r = buildActivateScript("Safari");
    expect(r).toEqual({ ok: true, script: 'tell application "Safari" to activate' });
  });

  it("activate：反 DNS 形 → tell application id \"…\" to activate", () => {
    const r = buildActivateScript("com.apple.Calculator");
    expect(r).toEqual({ ok: true, script: 'tell application id "com.apple.Calculator" to activate' });
  });

  it("list：进程清单脚本钉住（background only is false）", () => {
    expect(buildListAppsScript()).toBe('tell application "System Events" to get name of every process whose background only is false');
  });
});

// ---------------------------------------------------------------------------
// §2 注入防线（app 名/键码白名单）
// ---------------------------------------------------------------------------
d("ω99-212 §2 — 注入防线", () => {
  it("app 名含引号与换行 → 转义后单行安全（字面量不可逃逸）", () => {
    const evil = 'Ev"il\nApp';
    const escaped = applescriptEscape(evil);
    // 单行：换行被映射成 \\n 两字符序列，输出无任何换行符
    expect(escaped.includes("\n")).toBe(false);
    expect(escaped.includes("\r")).toBe(false);
    // 逃逸不可能：转义产物里不存在「前面没有反斜杠的引号」——放进任何
    // AppleScript 字面量都无法提前闭串
    expect(/(?<!\\)"/.test(escaped)).toBe(false);
    // 脚本整体注入面：恶意名进 keystroke 后，脚本里除定界符外无未转义引号
    const script = `tell application "System Events" to keystroke "${escaped}"`;
    expect(script.split("\n").length).toBe(1);
    expect(script.endsWith(`"${escaped}"`)).toBe(true);
  });

  it("sanitizeAppName：控制字符（含换行）typed 拒——真名不含换行", () => {
    expect(sanitizeAppName('Bad\nName').ok).toBe(false);
    expect(sanitizeAppName('Ev"il').ok).toBe(true); // 引号合法，转义层兜底
  });

  it("键码白名单外拒绝：99999 / 未知名 / 未知修饰", () => {
    expect(resolveKeyCombo("99999").ok).toBe(false);
    expect(resolveKeyCombo("cmd+99999").ok).toBe(false);
    expect(resolveKeyCombo("hyper+c").ok).toBe(false);
    expect(resolveKeyCombo("").ok).toBe(false);
    expect(resolveKeyCombo("cmd+c").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3 长文分块（>120 切块、块序正确、CJK 不劈 surrogate）
// ---------------------------------------------------------------------------
d("ω99-212 §3 — 长文分块", () => {
  it("恰 120 字符一块；121 → 两块；块序拼接还原原文", () => {
    const exact = "a".repeat(TYPE_CHUNK_CHARS);
    expect(chunkTypingText(exact)).toHaveLength(1);
    const long = "b".repeat(TYPE_CHUNK_CHARS + 1);
    const chunks = chunkTypingText(long);
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(long);
  });

  it("CJK/emoji 按 code point 切——surrogate 对不劈", () => {
    // 119 个 a + 一个 emoji（2 个 UTF-16 单元）+ 5 个 a：emoji 必须整体落在第 1 块尾或第 2 块头，永不劈开
    const text = "a".repeat(TYPE_CHUNK_CHARS - 1) + "😀" + "b".repeat(5);
    const chunks = chunkTypingText(text);
    for (const c of chunks) {
      // 无孤立高代理项（劈开的 surrogate 会出现 \uD800-\uDBFF 后不跟 \uDC00-\uDFFF）
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c)).toBe(false);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("多块脚本：块间 delay 行 + 块序正确", () => {
    const clean = sanitizeTypingText("x".repeat(TYPE_CHUNK_CHARS + 10));
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    const script = buildTypeScript(clean.text);
    expect(script).toContain("delay 0.12");
    const parts = script.split("\n");
    expect(parts[0]).toBe(`tell application "System Events" to keystroke "${"x".repeat(TYPE_CHUNK_CHARS)}"`);
    expect(parts[1]).toBe("delay 0.12");
    expect(parts[2]).toBe('tell application "System Events" to keystroke "xxxxxxxxxx"');
  });
});

// ---------------------------------------------------------------------------
// §4 权限默认矩阵 + 零删除面
// ---------------------------------------------------------------------------
import { DEFAULT_ASK_TOOLS, isDefaultAskCall, decidePermission, PLAN_DENY_REASON } from "../src/permission.js";

const NAMES = ["screen_capture", "computer_type", "computer_key", "computer_click", "app_activate", "app_list", "computer_scroll", "computer_drag", "screen_observe", "computer_wait"] as const;

d("ω99-212 §4 — 权限默认矩阵", () => {
  const tools = createComputerTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  it("十工具齐：名字恰为面表十名（固定序；ω99-220 演进——scroll/drag 尾后 append-only；ω99-247 演进——screen_observe 尾后 append-only；ω99-250 演进——computer_wait 尾后 append-only）", () => {
    expect(tools.map((t) => t.name)).toEqual([...NAMES]);
  });

  it("isReadOnly：screen_capture / app_list 只读；其余六动作面非只读", () => {
    expect(byName.get("screen_capture")!.isReadOnly?.({})).toBe(true);
    expect(byName.get("app_list")!.isReadOnly?.({})).toBe(true);
    expect(byName.get("computer_type")!.isReadOnly?.({})).toBe(false);
    expect(byName.get("computer_key")!.isReadOnly?.({})).toBe(false);
    expect(byName.get("computer_click")!.isReadOnly?.({})).toBe(false);
    expect(byName.get("app_activate")!.isReadOnly?.({})).toBe(false);
    expect(byName.get("computer_scroll")!.isReadOnly?.({})).toBe(false);
    expect(byName.get("computer_drag")!.isReadOnly?.({})).toBe(false);
  });

  it("默认 ask：六动作面进 DEFAULT_ASK_TOOLS（ω99-226 裁定后 auto 档跟档放行、非 auto 档问）；读面不进（ω99-220 演进——scroll/drag 入列）", () => {
    expect(isDefaultAskCall("computer_type", {})).toBe(true);
    expect(isDefaultAskCall("computer_key", {})).toBe(true);
    expect(isDefaultAskCall("computer_click", {})).toBe(true);
    expect(isDefaultAskCall("app_activate", {})).toBe(true);
    expect(isDefaultAskCall("computer_scroll", {})).toBe(true);
    expect(isDefaultAskCall("computer_drag", {})).toBe(true);
    expect(isDefaultAskCall("screen_capture", {})).toBe(false);
    expect(isDefaultAskCall("app_list", {})).toBe(false);
    for (const n of ["computer_type", "computer_key", "computer_click", "app_activate", "computer_scroll", "computer_drag"]) {
      expect(DEFAULT_ASK_TOOLS.has(n)).toBe(true);
    }
  });

  it("模式矩阵：workspace/ask 档全部问（读面不在 WORKSPACE_TOOLS——fail-closed）；plan 档拒；auto 档读面放行、动作面 ω99-226 裁定后亦放行（rich 层四档矩阵见 omega99-226-auto-trust.test.ts）", () => {
    for (const n of NAMES) {
      expect(decidePermission("workspace", n)).toBe("ask");
      expect(decidePermission("ask", n)).toBe("ask");
      expect(decidePermission("plan", n)).toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
    }
  });

  it("零删除面：六工具名与参数 schema 无 delete/remove/rm 通道", () => {
    for (const t of tools) {
      expect(/delete|remove|\brm\b/i.test(t.name)).toBe(false);
      for (const key of Object.keys(t.parameters.properties)) {
        expect(/delete|remove|\brm\b/i.test(key)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §5 执行面（ExecSeam 全 mock——★零真实键鼠/截屏）+ helper 缺席降级
// ---------------------------------------------------------------------------
const recordingSeam = (result: Partial<ExecResult> = {}): ExecSeam & { calls: { file: string; args: string[] }[] } => {
  const calls: { file: string; args: string[] }[] = [];
  const seam: ExecSeam = async (file, args) => {
    calls.push({ file, args: [...args] });
    return { stdout: "", stderr: "", code: 0, ...result };
  };
  return Object.assign(seam, { calls });
};

/** 假附件库：记录 saveImages 输入、发一号件（零盘写——纯内存）。 */
const fakeStore = (): { saveImages: (inputs: readonly { data: string; mediaType: string }[]) => Promise<{ kind: "image"; attachmentId: string; mediaType: string; byteLength: number }[]>; savedInputs: { data: string; mediaType: string }[] } => {
  const savedInputs: { data: string; mediaType: string }[] = [];
  return {
    savedInputs,
    saveImages: async (inputs) => {
      savedInputs.push(...inputs.map((i) => ({ data: i.data, mediaType: i.mediaType })));
      return inputs.map((_, i) => ({ kind: "image" as const, attachmentId: `att-${i + 1}`, mediaType: "image/png", byteLength: 50_000 }));
    },
  };
};

d("ω99-212 §5 — 执行面（mock）", () => {
  // ω99-241: #10 — 同形演进：成功回执尾附状态行=第二派生（osascript 状态脚
  // 本）。动作仍是单发；mock stdout 空 → 状态行诚实缺席，回执单行不变。
  it("type：osascript 动作单发、-e 载脚本文本；成功收据给字符数", async () => {
    const seam = recordingSeam();
    const type = createComputerTools({ exec: seam }).find((t) => t.name === "computer_type")!;
    const r = await type.execute({ text: "hello world" });
    expect(r.isError).toBeFalsy();
    expect(seam.calls).toHaveLength(2);
    expect(seam.calls[0]!.file).toBe("osascript");
    expect(seam.calls[0]!.args[0]).toBe("-e");
    expect(seam.calls[0]!.args[1]).toBe('tell application "System Events" to keystroke "hello world"');
    expect(seam.calls[1]!.file).toBe("osascript");
    expect(seam.calls[1]!.args[1]).toContain("AXFocusedUIElement");
    expect(r.content).toContain("11");
    expect(r.content).not.toContain("当前状态");
  });

  it("type：-1743 → 辅助功能引导错误（含引导标记 + 系统设置路径）", async () => {
    const seam = recordingSeam({ code: 1, stderr: "execution error: 系统事件出现了错误：不允许辅助访问 (-1743)" });
    const type = createComputerTools({ exec: seam }).find((t) => t.name === "computer_type")!;
    const r = await type.execute({ text: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain(PERM_MARKER_ACCESSIBILITY);
    expect(r.content).toContain("辅助功能");
  });

  it("click：helper 缺席 → 结构化错误（含 WUDAO_CLICK_HELPER 指引），零进程派生", async () => {
    const seam = recordingSeam();
    const click = createComputerTools({ exec: seam, helperExists: () => false }).find((t) => t.name === "computer_click")!;
    const r = await click.execute({ x: 100, y: 200 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("WUDAO_CLICK_HELPER");
    expect(seam.calls).toHaveLength(0);
  });

  it("click：helper 在场 → 派生 helper 参数 (x y)；AX 未授（exit 2）→ 辅助功能引导", async () => {
    const seam = recordingSeam({ code: 2, stdout: "WUDAO_AX_UNTRUSTED" });
    const click = createComputerTools({ exec: seam, helperExists: () => true }).find((t) => t.name === "computer_click")!;
    const r = await click.execute({ x: 42, y: 99 });
    // ω99-250（续）— 同形演进：坐标动作前新增 settle 基线采样（observe argv，
    // 一次 helper 调用；exit 2 → 基线不可用 → 无 settle 行）——点击 argv 顺移
    // 到 calls[1]，字节不变。
    expect(seam.calls[0]!.args[0]).toBe("observe");
    expect(seam.calls[1]!.args).toEqual(["42", "99"]);
    expect(r.isError).toBe(true);
    expect(r.content).toContain(PERM_MARKER_ACCESSIBILITY);
  });

  it("click：坐标 fail-closed 前置——负数/非有限数 typed 拒，零派生", async () => {
    const seam = recordingSeam();
    const click = createComputerTools({ exec: seam, helperExists: () => true }).find((t) => t.name === "computer_click")!;
    for (const bad of [{ x: -1, y: 5 }, { x: 1.5, y: 5 }, { x: Number.NaN, y: 5 }, { y: 5 }]) {
      const r = await click.execute(bad as Record<string, unknown>);
      expect(r.isError).toBe(true);
    }
    expect(seam.calls).toHaveLength(0);
  });

  it("app_list：osascript → 名单净化（去空/去引号/封顶）", async () => {
    const seam = recordingSeam({ stdout: "Finder, Safari, 访达, , \"Notes\",\n" });
    const list = createComputerTools({ exec: seam }).find((t) => t.name === "app_list")!;
    const r = await list.execute({});
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("Finder");
    expect(r.content).toContain("访达");
    expect(r.content).not.toContain(", ,");
  });

  it("app_activate：非 darwin 平台 → typed 拒（零派生）", async () => {
    const seam = recordingSeam();
    const act = createComputerTools({ exec: seam, platform: "linux" }).find((t) => t.name === "app_activate")!;
    const r = await act.execute({ app: "Safari" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("macOS");
    expect(seam.calls).toHaveLength(0);
  });

  it("screen_capture：视觉链缺席 → typed 拒（零截屏派生）", async () => {
    const seam = recordingSeam();
    const cap = createComputerTools({ exec: seam }).find((t) => t.name === "screen_capture")!;
    const r = await cap.execute({});
    expect(r.isError).toBe(true);
    expect(seam.calls).toHaveLength(0);
  });

  it("screen_capture：主模型不吃图 → typed 拒（零截屏派生）", async () => {
    const seam = recordingSeam();
    const cap = createComputerTools({ exec: seam, vision: { store: fakeStore(), modelAcceptsImages: () => false } }).find((t) => t.name === "screen_capture")!;
    const r = await cap.execute({});
    expect(r.isError).toBe(true);
    expect(seam.calls).toHaveLength(0);
  });

  // ω99-244: #5 — 同形演进（两处，screen_capture 面）：capture 落盘后新增规范
  // 分辨率链（sips -g 实测 → -Z 1280 → -g 实测回读）与 JXA 主屏点查询——seam
  // 按新调用形状分流应答（假尺寸喂回，绝不真 sips/osascript）；回执新增尺寸
  // 行（逐字钉在 omega99-244-coordinate-loop.test.ts R1，此处只断在场）。既有
  // 断言（附件/字节/回执首行/自清）全部原样保留。
  it("screen_capture：成功 → 附件已存（base64+png）+ 图片回执（含尺寸行）；tmp 文件自清", async () => {
    const capPaths: string[] = [];
    const calls: { file: string; args: string[] }[] = [];
    let sipsResized = false;
    const seam: ExecSeam = async (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === "screencapture") {
        capPaths.push(args[1]!);
        await writeFile(args[1]!, Buffer.alloc(50_000, 7)); // 假 PNG 字节（够过空图门）
        return { stdout: "", stderr: "", code: 0 };
      }
      if (file === "sips") {
        if (args[0] === "-Z") {
          sipsResized = true;
          return { stdout: "", stderr: "", code: 0 };
        }
        const w = sipsResized ? 1280 : 2880;
        const h = sipsResized ? 800 : 1800;
        return { stdout: `${args[args.length - 1]}\n  pixelWidth: ${w}\n  pixelHeight: ${h}\n`, stderr: "", code: 0 };
      }
      if (file === "osascript" && args[0] === "-l") return { stdout: "1440x900", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };
    const store = fakeStore();
    const cap = createComputerTools({ exec: seam, vision: { store, modelAcceptsImages: () => true } }).find((t) => t.name === "screen_capture")!;
    const r = await cap.execute({});
    expect(r.isError).toBeFalsy();
    expect(calls[0]!.file).toBe("screencapture");
    expect(calls[0]!.args[0]).toBe("-x");
    expect(store.savedInputs.length).toBe(1);
    expect(store.savedInputs[0]!.mediaType).toBe("image/png");
    expect(r.images).toBeDefined();
    expect(r.images!.length).toBe(1);
    expect(r.images![0]!.kind).toBe("image");
    expect(r.images![0]!.ref.attachmentId).toBe("att-1");
    expect(r.content).toContain("截图");
    expect(r.content).toContain("尺寸：1280×800"); // ω99-244 回执尺寸行在场
    // tmp 自清：工具自己落的临时文件自己收走（os.tmpdir 内，非用户文件）
    expect(await Promise.all(capPaths.map((p) => access(p).then(() => true, () => false)))).toEqual([false]);
  });

  it("screen_capture：空图（< 字节门）→ 屏幕录制引导标记（typed 错误）", async () => {
    let sipsResized = false;
    const seam: ExecSeam = async (file, args) => {
      if (file === "screencapture") {
        await writeFile(args[1]!, Buffer.alloc(2_000, 7));
        return { stdout: "", stderr: "", code: 0 };
      }
      if (file === "sips") {
        if (args[0] === "-Z") {
          sipsResized = true;
          return { stdout: "", stderr: "", code: 0 };
        }
        const w = sipsResized ? 1280 : 2880;
        const h = sipsResized ? 800 : 1800;
        return { stdout: `${args[args.length - 1]}\n  pixelWidth: ${w}\n  pixelHeight: ${h}\n`, stderr: "", code: 0 };
      }
      if (file === "osascript" && args[0] === "-l") return { stdout: "1440x900", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };
    const cap = createComputerTools({ exec: seam, vision: { store: fakeStore(), modelAcceptsImages: () => true } }).find((t) => t.name === "screen_capture")!;
    const r = await cap.execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toContain(PERM_MARKER_SCREEN_RECORDING);
    expect(r.content).toContain("屏幕录制");
  });

  it("screen_capture：空图启发（字节门）→ 屏幕录制引导标记", () => {
    expect(isBlankScreenshot(new Uint8Array(2000))).toBe(true);
    expect(isBlankScreenshot(new Uint8Array(40_000))).toBe(false);
  });

  it("classifyOsascriptFailure：-1743/assistive 归辅助功能；其余 undefined", () => {
    expect(classifyOsascriptFailure("…(-1743)")).toBe("accessibility");
    expect(classifyOsascriptFailure("not allowed assistive access")).toBe("accessibility");
    expect(classifyOsascriptFailure("syntax error")).toBeUndefined();
  });

  it("resolveClickHelper：env 优先；无 env 无在场文件 → undefined", () => {
    expect(resolveClickHelper({ WUDAO_CLICK_HELPER: "/opt/wudao-click" }, () => true)).toBe("/opt/wudao-click");
    expect(resolveClickHelper({}, () => false)).toBeUndefined();
  });
});

// 键码表抽样（cmd+c=8 / return=36 / tab=48 / 箭头四向）——防表错位。
d("ω99-212 附录 — 键码表抽样", () => {
  it("常用键码钉住", () => {
    expect(resolveKeyCombo("c").ok && (resolveKeyCombo("c") as { keyCode: number }).keyCode).toBe(8);
    expect(resolveKeyCombo("return").ok && (resolveKeyCombo("return") as { keyCode: number }).keyCode).toBe(36);
    expect(resolveKeyCombo("tab").ok && (resolveKeyCombo("tab") as { keyCode: number }).keyCode).toBe(48);
    expect(resolveKeyCombo("space").ok && (resolveKeyCombo("space") as { keyCode: number }).keyCode).toBe(49);
    expect(resolveKeyCombo("up").ok && (resolveKeyCombo("up") as { keyCode: number }).keyCode).toBe(126);
  });
});

// buildToolSet 挂载钉位（注册表 census 演进披露见报告）。
import { buildToolSet } from "../src/tools.js";

const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });

d("ω99-212 — buildToolSet 挂载", () => {
  it("零配置 always-on：十工具钉在 make_docx 之后、task 之前（ω99-220 演进——尾后两员；ω99-247 演进——screen_observe 插在 computer_drag 后、read_xlsx 前，doc 名册整体顺移一位；ω99-250 演进——computer_wait 插在 screen_observe 后、read_xlsx 前，doc 名册整体再顺移一位；ω99-221 演进——read_xlsx 插在九件后；ω99-222 演进——read_docx/read_pptx 插在 read_xlsx 后；ω99-223 演进——append_docx/append_pptx 插在 read_pptx 后；ω99-228 演进——append_xlsx 插在 append_pptx 后；ω99-229 演进——replace_docx/replace_pptx 插在 append_xlsx 后；ω99-231 演进——replace_xlsx 插在 replace_pptx 后；ω99-238 演进——set_docx_header/set_pptx_notes 插在 replace_xlsx 后，task 再顺移两位）", () => {
    const names = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 }).map((t) => t.name);
    expect(names.indexOf("screen_capture")).toBe(names.indexOf("make_docx") + 1);
    const ten = names.slice(names.indexOf("screen_capture"), names.indexOf("screen_capture") + 10);
    expect(ten).toEqual([...NAMES]);
    expect(names[names.indexOf("app_list") + 1]).toBe("computer_scroll");
    // ω99-247: #8 — 观察员（读面）钉在 computer 域尾后：drag 的下一位由
    // read_xlsx 改钉 screen_observe，screen_observe 的下一位才是 read_xlsx
    // （computer 块成组完整，M24 前缀稳定——既有八面字节与序零变）。
    // ω99-250: #7 — 等待员（读面）钉在观察员尾后：screen_observe 的下一
    // 位由 read_xlsx 改钉 computer_wait，computer_wait 的下一位才是
    // read_xlsx（computer 块成组完整，M24 前缀稳定——既有九面字节与序零变）。
    expect(names[names.indexOf("computer_drag") + 1]).toBe("screen_observe");
    expect(names[names.indexOf("screen_observe") + 1]).toBe("computer_wait");
    expect(names[names.indexOf("computer_wait") + 1]).toBe("read_xlsx");
    // ω99-221: #6 — 挂载钉演进：drag 的下一位由 task 改钉 read_xlsx（Excel
    // 读半边，append-only 尾——computer spread 后、defer spread 前）；ω99-247
    // 演进后 drag 的下一位是 screen_observe，read_xlsx 的下一位才轮到读册。
    // ω99-222 演进——read_docx/read_pptx 插在 read_xlsx 之后（Word/PPT 读
    // 半边，append-only 尾——三件套读面自此相邻成组）。
    // ω99-223 演进——append_docx/append_pptx 插在 read_pptx 之后、task
    // 之前（Word/PPT 追加面，append-only 尾）：read_pptx 的下一位改钉
    // append_docx，append_pptx 的下一位才是 task。
    // ω99-228 演进——append_xlsx 插在 append_pptx 之后、task 之前（Excel
    // 追加面=三件套追加半边收口，append-only 尾）：append_pptx 的下一位
    // 改钉 append_xlsx，append_xlsx 的下一位才是 task。
    // ω99-229 演进——replace_docx/replace_pptx 插在 append_xlsx 之后、task
    // 之前（Word/PPT 就地改写面=「改」半边第一刀，append-only 尾）：
    // append_xlsx 的下一位改钉 replace_docx，replace_pptx 的下一位才是
    // task。
    // ω99-231 演进——replace_xlsx 插在 replace_pptx 之后、task 之前（Excel
    // 就地改写面=三件套「改」半边 xlsx 侧收口，append-only 尾）：
    // replace_pptx 的下一位改钉 replace_xlsx，replace_xlsx 的下一位才是
    // task。
    // ω99-238: #13 演进——set_docx_header/set_pptx_notes 插在 replace_xlsx
    // 之后、task 之前（文档部件面=页眉页脚+演讲备注，doc 名册尾 append-only
    // 尾）：replace_xlsx 的下一位改钉 set_docx_header，set_pptx_notes 的下
    // 一位才是 task。
    // ω99-256: #6 演进——clear_docx_header/set_docx_first_page 插在
    // set_pptx_notes 之后、task 之前（doc 部件面 v2=页眉删除+首页不同，
    // doc 名册尾 append-only 尾）：set_pptx_notes 的下一位改钉
    // clear_docx_header，set_docx_first_page 的下一位才是 task。
    expect(names[names.indexOf("read_xlsx") + 1]).toBe("read_docx");
    expect(names[names.indexOf("read_docx") + 1]).toBe("read_pptx");
    expect(names[names.indexOf("read_pptx") + 1]).toBe("append_docx");
    expect(names[names.indexOf("append_docx") + 1]).toBe("append_pptx");
    expect(names[names.indexOf("append_pptx") + 1]).toBe("append_xlsx");
    expect(names[names.indexOf("append_xlsx") + 1]).toBe("replace_docx");
    expect(names[names.indexOf("replace_docx") + 1]).toBe("replace_pptx");
    expect(names[names.indexOf("replace_pptx") + 1]).toBe("replace_xlsx");
    expect(names[names.indexOf("replace_xlsx") + 1]).toBe("set_docx_header");
    expect(names[names.indexOf("set_docx_header") + 1]).toBe("set_pptx_notes");
    expect(names[names.indexOf("set_pptx_notes") + 1]).toBe("clear_docx_header");
    expect(names[names.indexOf("clear_docx_header") + 1]).toBe("set_docx_first_page");
    // ω99-263: #12 演进——set_docx_even_pages 插在 set_docx_first_page 之后、
    // task 之前（doc 部件面 v3=奇偶页不同，doc 名册尾 append-only 尾）：
    // set_docx_first_page 的下一位改钉 set_docx_even_pages，set_docx_even_
    // pages 的下一位才是 task。
    expect(names[names.indexOf("set_docx_first_page") + 1]).toBe("set_docx_even_pages");
    expect(names[names.indexOf("set_docx_even_pages") + 1]).toBe("task");
  });
});
