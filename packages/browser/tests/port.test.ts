// ω99-114 — the default adapter's persistent-profile discipline (RED first):
// launchPersistentContext REQUIRES a resolved userDataDir and the fail-closed
// check runs BEFORE the dynamic playwright-core import — a unit test must
// never pull the real driver (红线 4). The behavioral proof of the ordering:
// if the check sat after the import, the launch would attempt a real browser
// (slow launch attempt or a driver-shaped error), never this instant refusal.
import { describe, it, expect } from "vitest";
import { createPlaywrightPort } from "../src/port.js";

describe("createPlaywrightPort (persistent context, ω99-114)", () => {
  it("fail-closed: launch without userDataDir refuses before any driver work", async () => {
    await expect(createPlaywrightPort().launch({ headless: true })).rejects.toThrow(/userDataDir/);
  });

  it("fail-closed: an empty-string userDataDir is refused too (no ephemeral fallback)", async () => {
    await expect(createPlaywrightPort().launch({ userDataDir: "" })).rejects.toThrow(/userDataDir/);
  });

  it("the refusal names the persistent-profile posture honestly (model-facing shape)", async () => {
    const err = await createPlaywrightPort().launch({}).then(
      () => { throw new Error("expected a refusal"); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("persistent profile");
  });
});
