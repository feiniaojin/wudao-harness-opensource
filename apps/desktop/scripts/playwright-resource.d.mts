// Type surface for playwright-resource.mjs (ω99-117) — the desktop tsc gate
// (apps/desktop tsconfig includes tests/**, which imports this module).
/** The version pnpm resolved for `packages/browser`'s playwright-core
 *  dependency (pnpm-lock.yaml importers), or null when absent. */
export declare function parsePlaywrightPin(
  lockText: string,
  importer?: string,
  dep?: string,
): string | null;

export type PlaywrightCopyPlan =
  | {
      status: "copy";
      version: string;
      sourceDir: string;
      destDir: "node_modules/playwright-core";
    }
  | {
      status: "error";
      code: "PLAYWRIGHT_CORE_MISSING" | "PLAYWRIGHT_PIN_UNREADABLE" | "PLAYWRIGHT_VERSION_MISMATCH";
      message: string;
      expected?: string;
      actual?: string;
    };

export declare function planPlaywrightCoreCopy(input: {
  packageJsonFound: boolean;
  onDiskVersion?: string;
  pinnedVersion?: string | null;
  sourceDir: string;
}): PlaywrightCopyPlan;

export declare function runtimeResourceManifest(input: {
  webFiles: string[];
  playwright: { status: "copy"; version: string } | null;
}): string[];
