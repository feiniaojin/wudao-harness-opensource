// ω99 拆分运动 弧 B：session-engine 的 persona 启动段外提（原 createDriverSession
// 体内连续段，闭包体逐字保留——props/config/liveConfig/workspaceRoot/sessionId0
// 收进 ctx 显式线程）。
import { join } from "node:path";
import { loadPersonaRegistry, createPersonaRuntime } from "@wudao-org/providers";
import type { PersonaRuntime, ProtocolId } from "@wudao-org/providers";
import type { ProviderConfig } from "@wudao-org/providers";
import { resolveBootstrapPersona, resolveActivePersona } from "../commands/persona.js";
import type { PersonaChainSources } from "../commands/persona.js";
import { resolveGlobalHome } from "../settings-layer.js";
import { stdoutGuard } from "../output-guard.js";
import type { MutableProviderConfig } from "../commands/model.js";
import type { DriverPersonaContext } from "./agent-driver.js";
import type { DriverSessionOptions } from "./session-engine-types.js";

/** The persona boot block's closure context (verbatim free variables). */
export interface SessionPersonaCtx {
  readonly props: DriverSessionOptions;
  readonly config: ProviderConfig;
  readonly liveConfig: MutableProviderConfig;
  readonly workspaceRoot: string;
  readonly sessionId0: string;
}

/** SDD 2026-08-23 persona Task 3 — the per-session persona runtime (web
 *  spec: 归 session). Same construction as runRepl (repl.ts:592-623): the
 *  three-tier registry (builtin → ~/.wudao/personas → workspace), the
 *  bootstrap chain (env=config.persona > binding > default), a runtime
 *  whose current starts at the resolved persona, and a context object the
 *  driver's /persona handler switches through. Bad files/bad ids are
 *  startup warnings + the bare client, never a crash. The runtime rides
 *  BOTH the provider options (headers/body layers) and the withPersona
 *  wrap (prompt layer) — INSIDE the cache tracker (repl.ts:609
 *  invariant: the tracker's prefix assertions see the canonical input). */
export async function buildSessionPersonaContext(ctx: SessionPersonaCtx): Promise<{
  personaCtx: DriverPersonaContext;
  personaRuntime: PersonaRuntime;
}> {
  const { props, config, liveConfig, workspaceRoot, sessionId0 } = ctx;
  const readProviderPersonaBinding = props.readProviderPersonaBinding ?? (() => undefined);
  const readGlobalDefaultPersonaId = props.readGlobalDefaultPersonaId ?? (() => undefined);
  const personaStartupNotice = (line: string): void =>
    (props.startupNotice ?? ((l: string) => stdoutGuard.writeRawStdout(`${l}\n`)))(line);
  const personaRegistry = await loadPersonaRegistry({
    globalDir: join(resolveGlobalHome(), "personas"),
    workspaceDir: join(workspaceRoot, ".wudao", "personas"),
  });
  for (const e of personaRegistry.errors) personaStartupNotice(`⚠️ persona file skipped: ${e}`);
  const personaBootstrap = resolveBootstrapPersona(personaRegistry, config);
  if (!personaBootstrap.ok) personaStartupNotice(`⚠️ ${personaBootstrap.error}`);
  // The env layer is the bootstrap resolution's result — it NEVER clears on
  // a provider switch (spec §1: env 恒最优先). Task 4 completes the chain's
  // last leg: the settings-read global default (persona.id).
  const personaEnv = personaBootstrap.ok ? personaBootstrap.resolved : null;
  const personaActive = resolveActivePersona(personaRegistry, {
    envPersona: personaEnv,
    // A provider-less config can carry no binding ("" keys no card).
    bindingId: readProviderPersonaBinding(config.provider ?? ""),
    defaultId: readGlobalDefaultPersonaId(),
  });
  if (personaActive.warning !== undefined) personaStartupNotice(`⚠️ ${personaActive.warning}`);
  const personaRuntime = createPersonaRuntime(personaActive.resolved, { sessionId: sessionId0 });
  const personaCtx: DriverPersonaContext = {
    registry: personaRegistry,
    runtime: personaRuntime,
    chain: (): PersonaChainSources => ({
      envPersona: personaEnv,
      bindingId: readProviderPersonaBinding(liveConfig.provider ?? ""),
      defaultId: readGlobalDefaultPersonaId(),
    }),
    wire: (): ProtocolId => liveConfig.wire ?? "openai-chat",
  };
  return { personaCtx, personaRuntime };
}
