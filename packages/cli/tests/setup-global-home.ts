// M57 §1 — test isolation for the global config tier. Loaders read
// WUDAO_GLOBAL_HOME (default ~/.wudao); without this hook every loader test
// would see the DEVELOPER's real global settings and go environment-fragile.
// A per-run empty tmpdir stands in unless the test itself set a home (the
// settings-layer tests do, per-case).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.WUDAO_GLOBAL_HOME === undefined) {
  const dir = mkdtempSync(join(tmpdir(), "wudao-test-global-"));
  process.env.WUDAO_GLOBAL_HOME = dir;
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // best-effort cleanup only
    }
  });
}

// ω-4d: the login-shell snapshot is default-ON in production, but a live
// frontend (WudaoApp / driver sessions / one-shot) would otherwise spawn the
// DEVELOPER's real $SHELL and source the real ~/.zshrc inside these tests —
// machine-dependent latency (and rc content) in every test that reaches a
// host-path shell. Default it OFF for the whole cli test environment
// via the feature's own kill switch (tests that exercise the snapshot inject
// a fake provider or set the env explicitly — shell-snapshot.test.ts).
// Production behavior is unchanged; per-test code may delete this var to opt
// back in.
if (process.env.WUDAO_NO_LOGIN_SHELL === undefined) {
  process.env.WUDAO_NO_LOGIN_SHELL = "1";
}

// 夜移 028: same concern, same switch shape — the sleep guard rides every
// driver run (busy/pendingPermission transitions), so the default singleton
// would otherwise spawn the DEVELOPER's real caffeinate inside hundreds of
// driver tests. Off for the whole cli test environment via the feature's
// own kill switch (prevent-sleep's own tests inject fakes / set the env
// explicitly). Production behavior is unchanged.
if (process.env.WUDAO_NO_PREVENT_SLEEP === undefined) {
  process.env.WUDAO_NO_PREVENT_SLEEP = "1";
}
