// @wudao-org/browser — the controlled-browser foundation (ω99-112).
// Zero core runtime dependency: core appears as a TYPE import only (Tool,
// ToolResult), playwright-core loads only inside the default port's launch()
// as a dynamic import. Construction of the runtime is zero-IO.
export type { BrowserPort, BrowserHandle, PageHandle, BrowserLaunchOptions } from "./port.js";
export { createPlaywrightPort, PORT_TIMEOUTS } from "./port.js";
export type { BrowserRuntime, BrowserRuntimeOptions, BrowserState, PageSnapshotRefs, SnapshotRefEntry, ExecutableResolution } from "./runtime.js";
export { createBrowserRuntime, resolveExecutablePath, browserLaunchError, DEFAULT_IDLE_MS } from "./runtime.js";
export { COLLECT_SCRIPT, formatSnapshot, refSelector, validRef, elementLine, MAX_SNAPSHOT_CHARS } from "./snapshot.js";
export type { CollectedPage, CollectedElement } from "./snapshot.js";
export { browserToolsFor } from "./tools.js";
// ω99-138: the screenshot-sink seam (the persistence stays at the caller).
export type { BrowserImageSink, BrowserImageSinkMeta } from "./tools.js";
export {
  ensureChromiumDownloaded,
  installedExecutablePath,
  chromiumBuildFromBrowsersJson,
  chromiumDownloadUrl,
  installLayout,
  safeSegment,
  validateStaging,
  browserRoot,
  kernelUnavailableError,
} from "./download.js";
