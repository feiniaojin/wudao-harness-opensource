// M30 post-merge binding: `@wudao-org/core` owns the role roster (§A), the
// background agent registry (§B), and per-child worktree isolation (§D); the
// CLI consumes them directly. The only adaptation left is BUILTIN_ROLES —
// core exports a Record, CLI consumers (role resolution, the known-role
// list) work against the Map spelling.
export {
  createAgentRegistry,
  createChildWorktree,
  loadRoleProfiles,
} from "@wudao-org/core";
export type {
  AgentRegistry,
  AgentRegistryOptions,
  AgentSpawnSpec,
  AgentRunStatus,
  AgentStatusInfo,
  RegistryResult,
  AwaitSpec,
  ReportValidator,
  SubsetSchema,
  AgentRoleProfile,
  LoadedRoster,
  ShadowedProfile,
  RosterPluginAgent,
  ChildWorktree,
} from "@wudao-org/core";

import { BUILTIN_ROLES as CORE_BUILTIN_ROLES } from "@wudao-org/core";
import type { AgentRoleProfile } from "@wudao-org/core";

/** The builtin roster as a Map (core exports a Record). */
export const BUILTIN_ROLES: ReadonlyMap<string, AgentRoleProfile> = new Map(
  Object.entries(CORE_BUILTIN_ROLES),
);
