// M55 §C1 — /add-dir tests.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { validateAddDirPath, buildAddedDirEntry, formatAddDirNotice, formatAddedDirsList, ADDED_DIR_TYPE } from "../src/commands/add-dir.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("/add-dir", () => {
  const testDir = join(tmpdir(), `wudao-add-dir-test-${Date.now()}`);
  const existingDir = join(testDir, "existing");

  beforeAll(() => {
    // Setup: create test directory
    mkdirSync(existingDir, { recursive: true });
  });

  afterAll(() => {
    // Cleanup
    try {
      rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  });

  it("validates absolute path that exists", () => {
    const result = validateAddDirPath({
      input: existingDir,
      cwd: "/cwd",
      existingPaths: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absPath).toBe(existingDir);
    }
  });

  it("validates relative path resolved vs cwd", () => {
    const result = validateAddDirPath({
      input: "existing",
      cwd: testDir,
      existingPaths: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absPath).toBe(existingDir);
    }
  });

  it("rejects empty path", () => {
    const result = validateAddDirPath({
      input: "",
      cwd: testDir,
      existingPaths: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("路径不能为空"); // ω99-177: 钉随源演进
    }
  });

  it("rejects non-existent path", () => {
    const result = validateAddDirPath({
      input: "/does/not/exist",
      cwd: testDir,
      existingPaths: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("路径不存在"); // ω99-177: 钉随源演进（截干形漏网，census 披露同弧演进）
    }
  });

  it("rejects duplicate paths", () => {
    const result = validateAddDirPath({
      input: existingDir,
      cwd: testDir,
      existingPaths: [existingDir],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("已添加过"); // ω99-177: 钉随源演进
    }
  });

  it("builds session entry", () => {
    const entry = buildAddedDirEntry("/test/path");
    expect(entry.type).toBe(ADDED_DIR_TYPE);
    expect(entry.data.path).toBe("/test/path");
    expect(entry.data.at).toBeTruthy(); // ISO timestamp
  });

  it("formats success notice", () => {
    const notice = formatAddDirNotice({ absPath: "/test/path", count: 1 });
    expect(notice).toContain("/test/path");
    expect(notice).toContain("共 1 个工作区目录"); // ω99-177: 钉随源演进
  });

  it("formats added dirs list", () => {
    const list = formatAddedDirsList(["/path1", "/path2"]);
    expect(list).toContain("工作区目录（2 个）"); // ω99-177: 钉随源演进
    expect(list).toContain("- /path1");
    expect(list).toContain("- /path2");
  });

  it("formats empty list as empty string", () => {
    const list = formatAddedDirsList([]);
    expect(list).toBe("");
  });
});
