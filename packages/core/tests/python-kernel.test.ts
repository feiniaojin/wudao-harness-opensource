// 114 取证弧 — python_kernel（持久 Python kernel）。验收覆盖：持久性
// （两次调用共享变量/imports）、异常不杀进程、超时清理+重启回执、idle
// 回收、reset 显式重启（状态真丢）、回执文案（cold start/warm/restarted
// after … (state lost)）、输出帽+代理对安全截断（truncateSafe 单一原语，
// 113-A4 纪律）、fail-closed 参数校验与 python3 发现。信任边界（无文件
// 系统沙箱、shell 级）由 run-script-python.test.ts 的 lane 断言钉住，此
// 处不重复。
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPythonKernelTool } from "../src/index.js";
import type { PythonKernelTool } from "../src/tools/python-kernel.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const fastKernel = (extra: Record<string, unknown> = {}): PythonKernelTool =>
  createPythonKernelTool({ idleTimeoutMs: 60_000, cellTimeoutMs: 20_000, ...extra });

// 孤立代理项探针（113-A4 的病）：高位代理后不跟低位，或低位代理前无高位。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("python_kernel persistence — the whole point", () => {
  it("variables and imports survive across calls (cold start → warm)", async () => {
    const t = fastKernel();
    const first = await t.execute({ code: "import math\nx = 41", description: "load once" });
    expect(first.isError).toBeFalsy();
    expect(first.content).toContain("kernel: cold start");
    expect(first.content).toContain("[ok]");
    const second = await t.execute({ code: "x += 1\nprint(x, math.floor(math.pi))" });
    expect(second.isError).toBeFalsy();
    expect(second.content).toContain("kernel: warm");
    expect(second.content).toContain("42 3");
    t.stop();
  }, 20_000);

  it("no stdout → no blank padding (receipt stays tight)", async () => {
    const t = fastKernel();
    const r = await t.execute({ code: "silent = 1" });
    expect(r.content).not.toMatch(/kernel: cold start\n\n/);
    expect(r.content).toContain("kernel: cold start\n[ok]");
    t.stop();
  }, 20_000);
});

describe("python_kernel exceptions never kill the kernel", () => {
  it("a raised exception is caught, surfaced, and the kernel keeps running", async () => {
    const t = fastKernel();
    await t.execute({ code: "keep = 'state'" });
    const boom = await t.execute({ code: "raise RuntimeError('boom-marker')" });
    expect(boom.isError).toBe(true);
    expect(boom.content).toContain("Traceback");
    expect(boom.content).toContain("boom-marker");
    expect(boom.content).toContain("[error]");
    const after = await t.execute({ code: "print('alive', keep)" });
    expect(after.isError).toBeFalsy();
    expect(after.content).toContain("kernel: warm");
    expect(after.content).toContain("alive state");
    t.stop();
  }, 20_000);

  it("stderr is surfaced only on failed cells (a succeeding cell's stderr stays out)", async () => {
    const t = fastKernel();
    const r = await t.execute({ code: "import sys\nsys.stderr.write('noise')\nprint('done')" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("done");
    expect(r.content).not.toContain("[stderr]");
    t.stop();
  }, 20_000);
});

describe("python_kernel timeout and idle cleanup", () => {
  it("a hung cell is killed at the wall clock; the next call cold-starts with the restart note", async () => {
    const t = fastKernel({ cellTimeoutMs: 400 });
    const hung = await t.execute({ code: "import time\ntime.sleep(30)" });
    expect(hung.isError).toBe(true);
    expect(hung.content).toContain("[timeout after 0.4s — kernel killed, state lost]");
    const next = await t.execute({ code: "print('fresh')" });
    expect(next.isError).toBeFalsy();
    expect(next.content).toContain("kernel: restarted after cell timeout (state lost)");
    t.stop();
  }, 20_000);

  it("an idle kernel is reaped; the next call discloses the lost state", async () => {
    const t = fastKernel({ idleTimeoutMs: 200 });
    await t.execute({ code: "a = 1" });
    await sleep(900);
    const next = await t.execute({ code: "print('back')" });
    expect(next.isError).toBeFalsy();
    expect(next.content).toContain("kernel: restarted after idle cleanup (state lost)");
    t.stop();
  }, 20_000);

  it("a crashed kernel (os._exit in a cell) restarts with the crash note", async () => {
    const t = fastKernel({ cellTimeoutMs: 5_000 });
    await t.execute({ code: "b = 1" });
    const dead = await t.execute({ code: "import os\nos._exit(3)" });
    expect(dead.isError).toBe(true);
    expect(dead.content).toContain("kernel died mid-cell, state lost");
    const next = await t.execute({ code: "print('post-crash')" });
    expect(next.isError).toBeFalsy();
    expect(next.content).toContain("kernel: restarted after crash (state lost)");
    t.stop();
  }, 20_000);
});

describe("python_kernel reset", () => {
  it("reset:true drops ALL state; a reset-only call is not an error and spawns nothing", async () => {
    const t = fastKernel();
    await t.execute({ code: "y = 7" });
    const reset = await t.execute({ reset: true, description: "fresh start" });
    expect(reset.isError).toBeFalsy();
    expect(reset.content).toContain("[python_kernel] fresh start");
    expect(reset.content).toContain("kernel: reset (state lost)");
    expect(reset.content).toContain("[ok]");
    // State really is gone: y is a NameError on the fresh kernel.
    const gone = await t.execute({ code: "print(y)" });
    expect(gone.isError).toBe(true);
    expect(gone.content).toContain("NameError");
    t.stop();
  }, 20_000);

  it("reset with code: the fresh kernel runs the cell in one receipt", async () => {
    const t = fastKernel();
    await t.execute({ code: "z = 'old'" });
    const r = await t.execute({ code: "z = 'new'\nprint(z)", reset: true });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("kernel: reset (state lost)");
    expect(r.content).toContain("new");
    t.stop();
  }, 20_000);
});

describe("python_kernel output cap — surrogate-safe truncation", () => {
  it("caps emoji/Astral stdout at the char budget without ever splitting a surrogate pair", async () => {
    const t = fastKernel({ maxStdoutChars: 1_000 });
    const r = await t.execute({ code: "print('😀' * 4000)" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("[stdout truncated at 1000 chars — print distilled facts; keep intermediates in kernel variables]");
    // 113-A4: the cut must never leave a lone surrogate anywhere in the receipt.
    expect(LONE_SURROGATE.test(r.content)).toBe(false);
    t.stop();
  }, 20_000);

  it("caps plain ASCII overflow, keeping the head and the guidance note", async () => {
    const t = fastKernel({ maxStdoutChars: 64 });
    const r = await t.execute({ code: "print('A' * 200)" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("[stdout truncated at 64 chars");
    expect(r.content.match(/A{20}/)).not.toBeNull();
    expect(r.content.match(/^A{100}/m)).toBeNull();
    t.stop();
  }, 20_000);
});

describe("python_kernel fail-closed edges", () => {
  it("neither code nor reset → typed rejection before any spawn", async () => {
    const t = fastKernel();
    const r = await t.execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toContain('provide "code" (a Python cell) or "reset": true');
    t.stop();
  }, 20_000);

  it("python3 missing from PATH → typed rejection, no silent fallback", async () => {
    const savedPath = process.env.PATH;
    const emptyDir = await mkdtemp(join(tmpdir(), "wudao-no-python3-kernel-"));
    process.env.PATH = emptyDir;
    try {
      const t = fastKernel();
      const r = await t.execute({ code: "print('should-never-run')" });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("python3 not found on PATH");
      expect(r.content).toContain("no silent fallback");
      expect(r.content).not.toContain("should-never-run");
      t.stop();
    } finally {
      process.env.PATH = savedPath;
    }
  }, 20_000);

  it("cells are strictly sequential — a second in-flight call is a typed rejection", async () => {
    const t = fastKernel();
    const first = t.execute({ code: "import time\ntime.sleep(0.4)\nprint('first-done')" });
    const second = await t.execute({ code: "print('second')" });
    expect(second.isError).toBe(true);
    expect(second.content).toContain("a cell is already running");
    const settled = await first;
    expect(settled.isError).toBeFalsy();
    expect(settled.content).toContain("first-done");
    t.stop();
  }, 20_000);

  it("stop() is the eager teardown: a later call cold-starts CLEAN (no restart note)", async () => {
    const t = fastKernel();
    await t.execute({ code: "q = 1" });
    t.stop();
    await sleep(300);
    const r = await t.execute({ code: "print('after-stop')" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("kernel: cold start");
    expect(r.content).not.toContain("restarted after");
    t.stop();
  }, 20_000);

  it("schema: code/reset/description optional keys, additionalProperties closed", () => {
    const t = fastKernel();
    const params = t.parameters as unknown as {
      properties: Record<string, { type?: string }>;
      required?: readonly string[];
      additionalProperties?: boolean;
    };
    expect(Object.keys(params.properties).sort()).toEqual(["code", "description", "reset"]);
    expect(params.required).toBeUndefined();
    expect(params.additionalProperties).toBe(false);
    t.stop();
  });
});
