// M57 fix-round — test isolation for the global config tier. The det suites
// call the rewired loaders directly (loadSkills, createPermissionSettingsWatcher,
// …); without this hook a real ~/.wudao/settings.json would silently merge
// into deterministic evals (a global deny could flip det-23/det-30; a global
// skill breaks the skills eval's expected list). Mirrors
// packages/cli/tests/setup-global-home.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.WUDAO_GLOBAL_HOME === undefined) {
  const dir = mkdtempSync(join(tmpdir(), "wudao-evals-global-"));
  process.env.WUDAO_GLOBAL_HOME = dir;
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  });
}
