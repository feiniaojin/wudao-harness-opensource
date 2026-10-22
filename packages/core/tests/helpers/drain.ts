// Shared test helper (M58): drain an async generator to its settling point.
// Collects every yielded LoopEvent; when the generator THROWS, the thrown
// error is returned in `error` (a thrown error carries no `done`); a normal
// terminal return leaves `error` undefined.
import type { LoopEvent } from "../../src/index.js";

export interface SettledResult {
  readonly error?: Error;
  readonly events: LoopEvent[];
}

export async function drainSettled(gen: AsyncGenerator<LoopEvent, unknown>): Promise<SettledResult> {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next().then(
      (v) => v,
      (e) => e as unknown as IteratorResult<LoopEvent>,
    );
    if ("done" in r && r.done === false) {
      events.push(r.value);
      continue;
    }
    return { error: r instanceof Error ? r : undefined, events };
  }
}
