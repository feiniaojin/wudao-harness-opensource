// M60 — test isolation for the global config tier (same pin the cli/evals
// tests use): loaders read WUDAO_GLOBAL_HOME (default ~/.wudao); without this
// hook every settings test would see the DEVELOPER's real global settings and
// go environment-fragile. A per-run empty tmpdir stands in unless the test
// itself set a home.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.WUDAO_GLOBAL_HOME === undefined) {
  const dir = mkdtempSync(join(tmpdir(), "wudao-slack-test-global-"));
  process.env.WUDAO_GLOBAL_HOME = dir;
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  });
}
