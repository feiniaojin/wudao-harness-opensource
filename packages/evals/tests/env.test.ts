import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile, loadEnvFrom } from "../src/env.js";

describe("parseEnvFile", () => {
  it("parses keys, strips quotes, skips comments and blanks", () => {
    expect(parseEnvFile([
      "# comment",
      "",
      "WUDAO_API_KEY=sk-test",
      'QUOTED="double quoted"',
      "SINGLE='single quoted'",
      "SPACED = padded ",
    ].join("\n"))).toEqual({
      WUDAO_API_KEY: "sk-test",
      QUOTED: "double quoted",
      SINGLE: "single quoted",
      SPACED: "padded",
    });
  });

  it("ignores lines without an equals sign", () => {
    expect(parseEnvFile("JUST_A_WORD\nA=1")).toEqual({ A: "1" });
  });
});

describe("loadEnvFrom", () => {
  it("finds .env walking up parents and does not override existing env", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-eval-env-"));
    const child = join(root, "a", "b");
    await mkdir(child, { recursive: true });
    await writeFile(join(root, ".env"), "WUDAO_API_KEY=from-file\nWUDAO_EXISTING=from-file\n", "utf8");
    const merged = loadEnvFrom(child, { WUDAO_EXISTING: "from-env" });
    expect(merged.WUDAO_API_KEY).toBe("from-file");
    expect(merged.WUDAO_EXISTING).toBe("from-env");
  });

  it("returns base unchanged when no .env exists anywhere up the tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-eval-noenv-"));
    const merged = loadEnvFrom(root, { X: "1" });
    expect(merged).toEqual({ X: "1" });
  });
});
