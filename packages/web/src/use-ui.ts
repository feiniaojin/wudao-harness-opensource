// The React adapter over WudaoClient (the store face) — useSyncExternalStore
// on the client's snapshot. The hook is intentionally one line of wiring: all
// logic lives in the framework-agnostic client, the same split the TUI's
// useAgent makes over AgentDriver.
import { useSyncExternalStore } from "react";
import type { UiSnapshot, WudaoClient } from "./protocol.js";

export function useUi(client: WudaoClient): UiSnapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}
