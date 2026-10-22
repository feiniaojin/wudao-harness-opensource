// ω99-51 — session projection seam (the upstream formatcandidate 5, pilot): the framework
// half of "domain state derived from the session". A domain registers a PURE
// unit (key + init + a synchronous fold apply(event, state) → state) and gets
// subscription, change notification, and snapshots for free; every consumer
// stops hand-rolling its own cold-rescan machinery. Design DNA:
//   - whole-value events: apply receives one event and returns the WHOLE next
//     state (never a delta); returning the SAME reference means "no change".
//   - two Object.is gates: gate 1 — a fold that returns the current state
//     reference is skipped entirely (no seq bump, no work); gate 2 — a
//     snapshot whose reference did not change is never published.
//   - no Schema.parse and no stateVersion here: wudao's folds defend in TS
//     (see docs/research/106-session-projection-constitution.md); format
//     generations ride the ω99-47 version gate, not this seam.
// Checkpoint/caching is deliberately deferred (constitution §4): resume
// already loads the full chain, so the O(n) resync costs the same as today's
// backscan; incremental checkpoints wait for measured long-session pain.

/** A registered projection unit — pure, framework-free. `apply` must be
 *  synchronous and total; return the SAME state reference when the event
 *  changes nothing (gate 1 keys on it). */
export interface ProjectionDef<S, E> {
  /** Domain key — unique per session driver (the registry identity). */
  readonly key: string;
  /** The empty state (fresh chain / after reset). */
  readonly init: () => S;
  /** The fold: one event → whole next state. Pure — no side effects. */
  readonly apply: (event: E, state: S) => S;
}

/** Register a projection unit (identity — exists so the vocabulary reads
 *  `defineProjection({key, init, apply})` at every registration site). */
export function defineProjection<S, E>(def: ProjectionDef<S, E>): ProjectionDef<S, E> {
  return def;
}

/** An immutable view of the derived state at a chain position. `asOfSeq`
 *  counts STATE CHANGES since the last reset (monotone within a feed run);
 *  an unchanged feed leaves both the count and the snapshot object alone. */
export interface ProjectionSnapshot<S> {
  readonly asOfSeq: number;
  readonly state: S;
}

/** The framework-owned driver: feeds events, keeps the snapshot, notifies
 *  subscribers. The driver never touches the session store — read-only feed
 *  is the caller's wiring (constitution §3). */
export interface ProjectionDriver<S, E> {
  /** Fold ONE event in. No-ops (gate 1) when apply returns the same state
   *  reference. */
  feed(event: E): void;
  /** Chain restart (rewind, branch switch, reload): state back to init,
   *  asOfSeq to 0. Does not publish — the next change notifies. */
  reset(): void;
  /** The current snapshot. Same object reference until the state changes. */
  snapshot(): ProjectionSnapshot<S>;
  /** Subscribe to state changes. Each notification carries the complete
   *  post-state snapshot (whole-value rule). Returns the unsubscribe.
   *  Listener failures are isolated (events ≠ hooks: an observer can never
   *  break the feed). */
  subscribe(fn: (snapshot: ProjectionSnapshot<S>) => void): () => void;
}

export function createProjectionDriver<S, E>(def: ProjectionDef<S, E>): ProjectionDriver<S, E> {
  let state: S = def.init();
  let snap: ProjectionSnapshot<S> = { asOfSeq: 0, state };
  let published: ProjectionSnapshot<S> | undefined;
  const listeners = new Set<(snapshot: ProjectionSnapshot<S>) => void>();
  const publish = (): void => {
    // gate 2: a snapshot whose reference did not change is never published.
    if (Object.is(snap, published)) return;
    published = snap;
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch {
        // isolated — a broken observer must never break the projection
      }
    }
  };
  return {
    feed(event: E): void {
      const next = def.apply(event, state);
      // gate 1: unchanged state reference — skip everything.
      if (Object.is(next, state)) return;
      state = next;
      snap = { asOfSeq: snap.asOfSeq + 1, state };
      publish();
    },
    reset(): void {
      state = def.init();
      snap = { asOfSeq: 0, state };
      published = undefined;
    },
    snapshot(): ProjectionSnapshot<S> {
      return snap;
    },
    subscribe(fn: (snapshot: ProjectionSnapshot<S>) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
