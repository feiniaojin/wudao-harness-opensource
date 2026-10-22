// ω99-98 — the pet's soul: a deterministic pure function from a DriverStatus
// snapshot to what the pet SHOWS. Zero DOM, zero React, zero cross-window
// wiring — ω99-99's relay maps DriverStatus → PetInput verbatim (same field
// names, same meanings) and feeds it here on every snapshot.
//
// BOUNDARY — "drag" is NOT a machine state: the machine never emits it. Drag
// is a UI EVENT state owned by the pointer layer (pet/interaction.ts overrides the
// rendered data-pet-state with "drag" on pointerdown and restores the
// machine's display on pointerup); the machine state underneath is untouched,
// so the pet returns to exactly the state it had the moment the grab began.
/** The snapshot's steady read of the session (no transients). */
export type PetSteadyState = "idle" | "thinking" | "working" | "answering" | "waiting-user";
/** What the pet renders: a steady state, the done transient, or a UI-only
 *  event state (see the boundary note above — neither ever comes from
 *  stepPetMachine). ω99-278: #3 — "release" joins "drag" in that family: the
 *  drag-release bounce (the 450ms window after a real drag release); the
 *  machine never emits it, the pointer layer flashes it exactly like drag. */
export type PetDisplayState = PetSteadyState | "done" | "drag" | "release";

/** The snapshot input — field names and meanings match DriverStatus
 *  (protocol.ts) one-to-one, so the ω99-99 relay maps them verbatim:
 *  busy = the session's busy flag; pendingPermission ≠ null/undefined = the
 *  y/a/N ask is parked (the USER, not the model, is the blocker);
 *  live = the streaming slice (tools in flight, reasoning/answer text). */
export interface PetInput {
  busy: boolean;
  pendingPermission: unknown;
  live: { reasoning: string; answer: string; busyTools: unknown[] };
}

/** How long the "done" celebration outlives its busy falling edge (ms). */
export const PET_DONE_MS = 1500;

/** The machine's whole memory: what it shows + the falling-edge trace. */
export interface PetMachineState {
  display: PetDisplayState;
  busy: boolean;
  doneAt: number | null;
}

/** {display:"idle", busy:false, doneAt:null} — a fresh object every call. */
export function initialPetMachineState(): PetMachineState {
  return { display: "idle", busy: false, doneAt: null };
}

/** The steady state = what the snapshot says, priority top-down:
 *  1. waiting-user — a parked permission outranks EVERYTHING: the pet asks,
 *     it never celebrates/thinks/works while the user holds the floor;
 *  2. working — tools in flight beat streaming text;
 *  3. thinking — reasoning beats answer (reasoning precedes the answer);
 *  4. answering; 5. idle. */
export function petSteadyState(input: PetInput): PetSteadyState {
  if (input.pendingPermission != null) return "waiting-user";
  if (input.live.busyTools.length > 0) return "working";
  if (input.live.reasoning !== "") return "thinking";
  if (input.live.answer !== "") return "answering";
  return "idle";
}

/** One pure transition — `now` is injected, never Date.now() (clock-free
 *  tests; ω99-99 passes the snapshot's own clock). Decision table, first
 *  match wins:
 *   1. input.busy || steady === waiting-user → display = steady — work
 *      starting or a waiting user leaves "done" IMMEDIATELY;
 *   2. m.busy && !input.busy (the falling edge) → display = "done",
 *      doneAt = now — the celebration;
 *   3. display === "done" && now - doneAt < PET_DONE_MS → hold "done"
 *      (doneAt unchanged; steady does not leak through the window);
 *   4. else → display = steady.
 *  Invariant (ω99-103): display !== "done" ⟹ doneAt === null — no path
 *  that leaves "done" carries a stale timestamp (before, the timeout/new-
 *  work/waiting-user exits kept the old doneAt; harmless, but the contract
 *  was not closed).
 *  Returns a NEW object every call; `busy` always tracks input.busy. */
export function stepPetMachine(m: PetMachineState, input: PetInput, now: number): PetMachineState {
  const steady = petSteadyState(input);
  let display: PetDisplayState;
  let doneAt: number | null = m.doneAt;
  if (input.busy || steady === "waiting-user") {
    display = steady; // work / a waiting user outrank the celebration
  } else if (m.busy && !input.busy) {
    display = "done";
    doneAt = now;
  } else if (m.display === "done" && m.doneAt !== null && now - m.doneAt < PET_DONE_MS) {
    display = "done"; // inside the celebration window
  } else {
    display = steady;
  }
  if (display !== "done") doneAt = null; // ω99-103 不变式：离开 done 就不带过期时间戳
  return { display, busy: input.busy, doneAt };
}
