// M55 §C2 — /doctor tests.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  checkNodeVersion,
  checkProviderConfig,
  checkApiKey,
  checkSettingsJson,
  checkMcpJson,
  checkSessionDir,
  checkWudaoDiskUsage,
  checkEvalSuites,
  formatDoctorReport,
  type DoctorInput,
} from "../src/commands/doctor.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("/doctor", () => {
  const testDir = join(tmpdir(), `wudao-doctor-test-${Date.now()}`);

  beforeAll(() => {
    // Setup: create test directory structure
    mkdirSync(join(testDir, ".wudao", "sessions"), { recursive: true });
    mkdirSync(join(testDir, ".wudao", "evals"), { recursive: true });
    writeFileSync(join(testDir, ".wudao", "evals", "result-1.json"), "{}");
    writeFileSync(join(testDir, ".wudao", "settings.json"), '{"test": true}');
    writeFileSync(join(testDir, ".wudao", "mcp.json"), '{"test": true}');
  });

  afterAll(() => {
    // Cleanup
    try {
      rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  });

  it("checks node version", () => {
    const input: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
    };
    const result = checkNodeVersion(input);
    expect(result.status).toBe("ok");
    expect(result.label).toContain("Node.js");

    const oldNode: DoctorInput = {
      cwd: testDir,
      nodeVersion: "20.0.0",
      requiredNode: ">=22",
    };
    const result2 = checkNodeVersion(oldNode);
    expect(result2.status).toBe("warn");
    expect(result2.hint).toBe("upgrade Node.js");
  });

  it("checks provider config resolution", () => {
    const input: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
    };
    const result = checkProviderConfig(input);
    // May fail if no env is set, but should not throw
    expect(["ok", "warn"]).toContain(result.status);
  });

  it("checks API key presence", () => {
    const withKey: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
      providerKey: "sk-test1234567890",
    };
    const result = checkApiKey(withKey);
    expect(result.status).toBe("ok");
    expect(result.label).toContain("…");

    const withoutKey: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
    };
    const result2 = checkApiKey(withoutKey);
    expect(result2.status).toBe("warn");
  });

  it("checks settings.json parse", () => {
    const withSettings: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
      settingsPath: join(testDir, ".wudao", "settings.json"),
    };
    const result = checkSettingsJson(withSettings);
    expect(result.status).toBe("ok");

    const noSettings: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
    };
    const result2 = checkSettingsJson(noSettings);
    expect(result2.status).toBe("ok");
    expect(result2.label).toContain("not present");
  });

  it("checks mcp.json parse", () => {
    const withMcp: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
      mcpConfigPath: join(testDir, ".wudao", "mcp.json"),
    };
    const result = checkMcpJson(withMcp);
    expect(result.status).toBe("ok");
  });

  it("checks session dir writability", () => {
    const withDir: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
      sessionDir: join(testDir, ".wudao", "sessions"),
    };
    const result = checkSessionDir(withDir);
    expect(result.status).toBe("ok");
    expect(result.label).toContain("writable");

    const noDir: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
    };
    const result2 = checkSessionDir(noDir);
    expect(result2.status).toBe("ok");
    expect(result2.label).toContain("not present");
  });

  it("checks .wudao disk usage", () => {
    const withDir: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
      wudaoDir: join(testDir, ".wudao"),
    };
    const result = checkWudaoDiskUsage(withDir);
    expect(result.status).toBe("ok");
    expect(result.label).toContain("files");
  });

  it("checks eval suites", () => {
    const withEvals: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
      evalDir: join(testDir, ".wudao", "evals"),
    };
    const result = checkEvalSuites(withEvals);
    expect(result.status).toBe("ok");
    expect(result.label).toContain("result files");
  });

  it("formats full doctor report", () => {
    const input: DoctorInput = {
      cwd: testDir,
      nodeVersion: "22.0.0",
      requiredNode: ">=22",
      providerKey: "sk-test",
      settingsPath: join(testDir, ".wudao", "settings.json"),
      mcpConfigPath: join(testDir, ".wudao", "mcp.json"),
      sessionDir: join(testDir, ".wudao", "sessions"),
      wudaoDir: join(testDir, ".wudao"),
      evalDir: join(testDir, ".wudao", "evals"),
    };
    const report = formatDoctorReport(input);
    expect(report).toMatch(/^doctor:/);
    expect(report).toMatch(/✅|⚠️/);
  });
});
