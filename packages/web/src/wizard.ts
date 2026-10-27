// wizard.ts — M63 §C's pure halves (the first-run wizard's gate logic, kept
// DOM-free so the gate rule is testable without React):
//
//   matrixReady        the readiness join over the provider cards — ANY ready
//                      provider makes the whole surface ready. Mirrors the
//                      cli-side settingsReadiness (settings-ops.ts); the web
//                      derives it client-side so the gate holds even against
//                      a settingsStatus payload predating the `readiness`
//                      field (spec §C: 任一可用即整页跳过 — DSH pattern #5).
//   wizardShouldShow   not ready AND the stored completedVersion below the
//                      current copy version (DSH welcome-notice versioning:
//                      bump WIZARD_COPY_VERSION when the flow's wording or
//                      meaning changes and completed/skipped users see it
//                      again; anything else never re-shows it).
import type { ProviderCard } from "./protocol.js";

/** The wizard copy's version — bump when the flow changes meaningfully. */
export const WIZARD_COPY_VERSION = 1;

/** Readiness join: any provider card ready (key resolvable AND endpoint
 *  known) = the surface is ready, no wizard. Defensive against a partial
 *  status payload (a stub or older shape without `providers` reads as
 *  not-ready-input → the gate falls through to the version rule, never
 *  throws into the caller's mode resolution). */
export function matrixReady(providers: readonly ProviderCard[] | undefined): boolean {
  return (providers ?? []).some((c) => c.status === "ready");
}

export interface WizardGateInput {
  readonly providers: readonly ProviderCard[];
  /** The stored wizard.completedVersion (0 = never seen). */
  readonly wizardCompletedVersion: number;
  /** Test seam: the copy version to compare against. */
  readonly copyVersion?: number;
}

/** The show/skip rule: readiness beats everything (a ready provider never
 *  sees the wizard); below that, only a stale copy version re-shows it. */
export function wizardShouldShow(input: WizardGateInput): boolean {
  if (matrixReady(input.providers)) return false;
  return input.wizardCompletedVersion < (input.copyVersion ?? WIZARD_COPY_VERSION);
}
