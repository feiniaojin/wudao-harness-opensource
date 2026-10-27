// ω99-117 — pure decision layer for shipping playwright-core alongside the
// bundled-runtime sidecar resources (browser tools must work on a fresh Mac
// with no Node/npm). The fs side (copy, dereference, filter) lives in
// build-sea.mjs; these tests pin the DECISIONS: version asserted against the
// pnpm-lock pin, missing package = typed error (never a silent skip), and the
// assembled resource manifest carries playwright-core + its version.
import { describe, expect, it } from "vitest";
import {
  parsePlaywrightPin,
  planPlaywrightCoreCopy,
  runtimeResourceManifest,
} from "../scripts/playwright-resource.mjs";

// The real pnpm-lock.yaml shape (importers → packages/browser), verbatim in
// structure: 2-space importer, 4-space dependency group, 6-space dep name,
// 8-space fields. Followed by a synthetic second importer so the block
// boundary is exercised, and the packages: section whose 2-space keys must
// terminate the importer scan.
const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      esbuild:
        specifier: ^0.19.3
        version: 0.19.12

  packages/browser:
    dependencies:
      playwright-core:
        specifier: 1.63.0
        version: 1.63.0
    devDependencies:
      '@wudao/core':
        specifier: workspace:*
        version: link:../core

  packages/cli:
    dependencies:
      '@wudao/core':
        specifier: workspace:*
        version: link:../core

packages:

  playwright-core@1.63.0:
    resolution: {integrity: sha512-deadbeef}
`;

describe("parsePlaywrightPin", () => {
  it("reads the packages/browser importer's playwright-core version from the real lock shape", () => {
    expect(parsePlaywrightPin(LOCK)).toBe("1.63.0");
  });

  it("returns null when the lock has no such dependency", () => {
    expect(parsePlaywrightPin("lockfileVersion: '9.0'\n\nimporters:\n\n  packages/browser:\n    dependencies: {}\n")).toBeNull();
  });

  it("returns null when the importer itself is absent (scan must not leak into packages:)", () => {
    const noImporter = LOCK.replace("  packages/browser:\n", "  packages/other:\n");
    expect(parsePlaywrightPin(noImporter)).toBeNull();
  });
});

describe("planPlaywrightCoreCopy", () => {
  const base = { sourceDir: "/repo/packages/browser/node_modules/playwright-core" };

  it("plans the copy when the on-disk version equals the lock pin", () => {
    const plan = planPlaywrightCoreCopy({ ...base, packageJsonFound: true, onDiskVersion: "1.63.0", pinnedVersion: "1.63.0" });
    expect(plan.status).toBe("copy");
    if (plan.status !== "copy") return;
    expect(plan.version).toBe("1.63.0");
    expect(plan.destDir).toBe("node_modules/playwright-core");
    expect(plan.sourceDir).toBe(base.sourceDir);
  });

  it("refuses with a typed error when the package is missing (honest, never silent)", () => {
    const plan = planPlaywrightCoreCopy({ ...base, packageJsonFound: false, pinnedVersion: "1.63.0" });
    expect(plan.status).toBe("error");
    if (plan.status !== "error") return;
    expect(plan.code).toBe("PLAYWRIGHT_CORE_MISSING");
    expect(plan.message).toContain("playwright-core");
  });

  it("refuses with a typed error when on-disk version disagrees with the lock pin", () => {
    const plan = planPlaywrightCoreCopy({ ...base, packageJsonFound: true, onDiskVersion: "1.64.0", pinnedVersion: "1.63.0" });
    expect(plan.status).toBe("error");
    if (plan.status !== "error") return;
    expect(plan.code).toBe("PLAYWRIGHT_VERSION_MISMATCH");
    expect(plan.expected).toBe("1.63.0");
    expect(plan.actual).toBe("1.64.0");
  });

  it("refuses with a typed error when the lock pin itself is unreadable", () => {
    const plan = planPlaywrightCoreCopy({ ...base, packageJsonFound: true, onDiskVersion: "1.63.0", pinnedVersion: null });
    expect(plan.status).toBe("error");
    if (plan.status !== "error") return;
    expect(plan.code).toBe("PLAYWRIGHT_PIN_UNREADABLE");
  });
});

describe("runtimeResourceManifest", () => {
  it("lists exactly wudao-server.cjs, the web files, and playwright-core with its version", () => {
    const manifest = runtimeResourceManifest({
      webFiles: ["index.html", "pet.html", "assets/app.js"],
      playwright: { status: "copy", version: "1.63.0" },
    });
    expect(manifest).toEqual(["wudao-server.cjs", "web (3 files)", "node_modules/playwright-core@1.63.0"]);
  });

  it("omits the playwright entry when no copy was planned (SEA-clean layouts)", () => {
    const manifest = runtimeResourceManifest({ webFiles: ["index.html"], playwright: null });
    expect(manifest).toEqual(["wudao-server.cjs", "web (1 files)"]);
    expect(manifest.join(" ")).not.toContain("playwright-core");
  });
});
