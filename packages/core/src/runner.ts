// M30 §E — the Runner/Middleware seam (a reference harness 2). Core exports the
// types and ONE combinator; the CLI does not consume them yet. This is a
// pure library seam: telemetry, budgeting, persistence, and other
// third-party extensions get a place to live WITHOUT forking the loop.

import type { AgentMessage, Terminal } from "./types.js";
import type { ModelInput } from "./model-client.js";
import type { LoopEvent } from "./loop.js";

/** One model-loop execution: consumes the run's history + the model input
 *  for the current call, yields the loop's events, and finishes with its
 *  Terminal. `(history, input, {signal})` — everything a middleware needs
 *  to observe or transform. */
export type Runner = (
  history: readonly AgentMessage[],
  input: ModelInput,
  ctx: { signal?: AbortSignal },
) => AsyncGenerator<LoopEvent, Terminal>;

/** Wraps a Runner into a new Runner — an onion layer. */
export type AgentMiddleware = (runner: Runner) => Runner;

/** Compose middlewares OUTERMOST-FIRST: `pipe(a, b, c)(r) === a(b(c(r)))` —
 *  `a`'s entry logic runs first and its exit logic last. With no
 *  middlewares, `pipe()` is the identity. */
export function pipe(...middlewares: AgentMiddleware[]): (runner: Runner) => Runner {
  return (runner) => middlewares.reduceRight((inner, middleware) => middleware(inner), runner);
}
