// M50 §2 — the meta evolution journal (HarnessX's journal, the portable
// part): an append-only `.wudao/experiments.jsonl` of every experiment on a
// harness lever, plus an aggregation that ranks lever VALUES by the Wilson
// 95% lower bound on their ok-rate and attributes task-level flips.
//
// Deliberate non-goals (spec §2): NO LLM meta-agent ever changes config from
// this data — the journal records, `wudao meta report` aggregates, the HUMAN
// decides. No Beta posterior (Wilson is enough for v1). No auto-rollback.
//
// Settings hook: any `.wudao/settings.json` node carrying `experimental:
// true` auto-records its changed fields on write — `wudao meta apply` is the
// harness's own settings-write surface and routes through that hook; any
// future writer should call `recordSettingsExperiments` the same way.
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type ExperimentOutcome = "ok" | "fail" | "worse";

/** One experiment on one lever: from → to, judged against one task. */
export interface ExperimentEntry {
  readonly id: string;
  /** The lever, dotted-path style: `sidecar.breakerThreshold`. */
  readonly lever: string;
  /** Previous value (null = newly introduced). */
  readonly from: unknown;
  readonly to: unknown;
  /** The task the change was made for ("" = unattributed). */
  readonly task: string;
  readonly outcome: ExperimentOutcome;
  /** ISO timestamp. */
  readonly at: string;
}

export function experimentsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", "experiments.jsonl");
}

/** exp-<compact UTC timestamp>-<rand8>: sortable by time, unique per entry. */
export function newExperimentId(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const rand = randomUUID().replace(/-/g, "").slice(0, 8);
  return `exp-${ts}-${rand}`;
}

/** Deterministic JSON: keys sorted, so {a:1,b:2} === {b:2,a:1} for diffs. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v === "object" && v !== null) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = sort((v as Record<string, unknown>)[k]);
      }
      return sorted;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export async function appendExperiment(
  workspaceRoot: string,
  input: { lever: string; from?: unknown; to?: unknown; task?: string; outcome?: ExperimentOutcome; at?: string },
): Promise<ExperimentEntry> {
  if (typeof input.lever !== "string" || input.lever.trim() === "") {
    throw new Error("lever must be a non-empty string (e.g. sidecar.breakerThreshold)");
  }
  const outcome: ExperimentOutcome = input.outcome ?? "ok";
  if (outcome !== "ok" && outcome !== "fail" && outcome !== "worse") {
    throw new Error(`outcome must be ok|fail|worse (got ${String(outcome)})`);
  }
  const entry: ExperimentEntry = {
    id: newExperimentId(),
    lever: input.lever,
    from: input.from ?? null,
    to: input.to ?? null,
    task: input.task ?? "",
    outcome,
    at: input.at ?? new Date().toISOString(),
  };
  const path = experimentsPath(workspaceRoot);
  await mkdir(join(workspaceRoot, ".wudao"), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/** Tolerant load: a missing file or corrupt line never breaks a report. */
export function loadExperiments(workspaceRoot: string): ExperimentEntry[] {
  let text: string;
  try {
    text = readFileSync(experimentsPath(workspaceRoot), "utf8");
  } catch {
    return [];
  }
  const entries: ExperimentEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as ExperimentEntry;
      if (typeof parsed.lever === "string" && parsed.lever !== "") entries.push(parsed);
    } catch {
      // corrupt line: skip, keep aggregating the rest
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Wilson lower bound + aggregation
// ---------------------------------------------------------------------------

/** Wilson score interval LOWER bound for `ok` wins out of `n`, at confidence
 *  z (default 1.96 ≈ 95%). The conservative ranking key: 1/1 → 0.21, not 1.0,
 *  so a lever value needs VOLUME before it outranks a proven one. 0 when n=0. */
export function wilsonLowerBound(ok: number, n: number, z = 1.96): number {
  if (n <= 0 || ok < 0) return 0;
  const wins = Math.min(ok, n);
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return (centre - spread) / denom;
}

/** One lever value's record: wins (ok) vs losses (fail+worse), Wilson-ranked. */
export interface ValueAggregate {
  /** The value itself (raw JSON value — number/string/boolean). */
  readonly value: unknown;
  readonly ok: number;
  readonly fail: number;
  readonly worse: number;
  readonly n: number;
  readonly wilson: number;
}

export interface LeverAggregate {
  readonly lever: string;
  /** Ranked by Wilson lower bound, descending (best first). */
  readonly values: readonly ValueAggregate[];
  /** Task-level outcome flips on this lever (instability/overfit signal). */
  readonly flips: number;
  readonly flippedTasks: readonly string[];
}

const isOk = (e: ExperimentEntry): boolean => e.outcome === "ok";
const sameClass = (a: ExperimentEntry, b: ExperimentEntry): boolean => isOk(a) === isOk(b);

/** Aggregate by lever; rank values by Wilson LB; count task-level flips
 *  (adjacent same-task entries on the same lever whose outcome class
 *  changed — evidence the lever's effect is not stable for that task). */
export function aggregateExperiments(entries: readonly ExperimentEntry[]): LeverAggregate[] {
  const levers = new Map<string, ExperimentEntry[]>();
  for (const e of entries) {
    const list = levers.get(e.lever) ?? [];
    list.push(e);
    levers.set(e.lever, list);
  }
  const out: LeverAggregate[] = [];
  for (const [lever, list] of levers) {
    // Values keyed by canonical JSON so 3 and "3" stay distinct values.
    const byValue = new Map<string, ValueAggregate>();
    for (const e of list) {
      const key = canonicalJson(e.to);
      const prev = byValue.get(key) ?? { value: e.to, ok: 0, fail: 0, worse: 0, n: 0, wilson: 0 };
      const next = { ...prev, n: prev.n + 1 };
      if (e.outcome === "ok") next.ok += 1;
      else if (e.outcome === "fail") next.fail += 1;
      else next.worse += 1;
      byValue.set(key, next);
    }
    const values = [...byValue.values()]
      .map((v) => ({ ...v, wilson: wilsonLowerBound(v.ok, v.n) }))
      .sort((a, b) => b.wilson - a.wilson || a.n - b.n || (canonicalJson(a.value) < canonicalJson(b.value) ? -1 : 1));
    // Flips: within (lever, task), time-ordered adjacent outcome-class changes.
    const byTask = new Map<string, ExperimentEntry[]>();
    for (const e of list) {
      const key = e.task === "" ? "(unattributed)" : e.task;
      const t = byTask.get(key) ?? [];
      t.push(e);
      byTask.set(key, t);
    }
    let flips = 0;
    const flippedTasks: string[] = [];
    for (const [task, t] of byTask) {
      const ordered = [...t].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
      let taskFlipped = false;
      for (let i = 1; i < ordered.length; i += 1) {
        const a = ordered[i - 1]!;
        const b = ordered[i]!;
        if (!sameClass(a, b)) {
          flips += 1;
          taskFlipped = true;
        }
      }
      if (taskFlipped) flippedTasks.push(task);
    }
    out.push({ lever, values, flips, flippedTasks });
  }
  return out;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || value === undefined) return "(none)";
  try {
    return canonicalJson(value);
  } catch {
    return String(value);
  }
}

/** Human report: per lever, values ranked by Wilson LB + flip attribution.
 *  Pure — renders text, changes nothing (the anti-auto-config guarantee). */
export function formatMetaReport(entries: readonly ExperimentEntry[]): string {
  if (entries.length === 0) {
    return "no experiments recorded yet — .wudao/experiments.jsonl is empty (wudao meta record … / meta apply …)";
  }
  const aggregates = aggregateExperiments(entries);
  const lines: string[] = [
    `experiments: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} · ${aggregates.length} lever${aggregates.length === 1 ? "" : "s"} — values ranked by Wilson 95% lower bound on ok-rate (report only; nothing is auto-changed)`,
    "",
  ];
  for (const agg of aggregates) {
    const flipNote =
      agg.flips > 0
        ? `  flips: ${agg.flips} (${agg.flippedTasks.join(", ")}) — outcome changed class within a task; instability/overfit signal`
        : "  flips: 0";
    lines.push(`${agg.lever}`, flipNote);
    for (const v of agg.values) {
      lines.push(
        `  ${formatValue(v.value)}   ok ${v.ok} · fail ${v.fail} · worse ${v.worse}   n ${v.n}   wilson ${v.wilson.toFixed(2)}${v.wilson === Math.max(...agg.values.map((x) => x.wilson)) ? "  ← best" : ""}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Settings hook — experimental:true fields auto-record on write
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Pure diff: every CHANGED field of a settings node marked
 *  `experimental: true` in the AFTER state becomes {lever: "<node>.<field>"}.
 *  The marker field itself is never journaled; non-experimental nodes and
 *  fields removed from an experimental node are ignored (v1 journals writes). */
export function experimentalSettingsDiff(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): Array<{ lever: string; from: unknown; to: unknown }> {
  const diff: Array<{ lever: string; from: unknown; to: unknown }> = [];
  if (!isPlainObject(after)) return diff;
  const beforeRoot = isPlainObject(before) ? before : {};
  for (const [nodeKey, afterNode] of Object.entries(after)) {
    if (!isPlainObject(afterNode) || afterNode["experimental"] !== true) continue;
    const beforeNode = isPlainObject(beforeRoot[nodeKey]) ? (beforeRoot[nodeKey] as Record<string, unknown>) : {};
    for (const [field, to] of Object.entries(afterNode)) {
      if (field === "experimental") continue;
      const from = field in beforeNode ? beforeNode[field] : null;
      if (canonicalJson(from) !== canonicalJson(to)) {
        diff.push({ lever: `${nodeKey}.${field}`, from, to });
      }
    }
  }
  return diff;
}

/** The settings-write hook: journal every experimental-field change between
 *  the previous settings and the next ones. Returns what was recorded. */
export async function recordSettingsExperiments(
  workspaceRoot: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
  task: string,
): Promise<ExperimentEntry[]> {
  const recorded: ExperimentEntry[] = [];
  for (const d of experimentalSettingsDiff(before, after)) {
    recorded.push(await appendExperiment(workspaceRoot, { lever: d.lever, from: d.from, to: d.to, task }));
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// `wudao meta` subcommands
// ---------------------------------------------------------------------------

export interface MetaCliOptions {
  /** Workspace root (default: cwd). */
  readonly root?: string;
  /** stdout sink (default: process.stdout.write) — tests capture here. */
  readonly stdout?: (text: string) => void;
}

const USAGE = [
  "用法：wudao meta report", // ω99-166d-i: #34
  "       wudao meta record <lever> <from> <to> [--task <t>] [--outcome ok|fail|worse]",
  "       wudao meta apply <settings.json> [--task <t>]",
  "",
  "report — per-lever aggregation: value win/loss, Wilson 95% lower-bound",
  "         ranking, task-level flip attribution. Report only: the journal",
  "         never changes configuration by itself.",
  "record — append one manual experiment entry (values JSON-parsed).",
  "apply  — write .wudao/settings.json atomically; fields of nodes marked",
  "         experimental:true auto-record into the journal.",
].join("\n");

/** Parse a CLI value: JSON when it parses (3, true, "a", {…}), else string. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function parseFlag(rest: readonly string[], name: string): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (a === name && rest[i + 1] !== undefined) return rest[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isPlainObject(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

export async function metaMain(argv: readonly string[], options: MetaCliOptions = {}): Promise<number> {
  const root = options.root ?? process.cwd();
  const emit = options.stdout ?? ((text: string) => process.stdout.write(text));
  const [cmd, ...rest] = argv;

  if (cmd === "report") {
    emit(`${formatMetaReport(loadExperiments(root))}\n`);
    return 0;
  }

  if (cmd === "record") {
    const [lever, rawFrom, rawTo] = rest.filter((a) => !a.startsWith("--"));
    if (lever === undefined || rawFrom === undefined || rawTo === undefined) {
      emit(USAGE);
      return 2;
    }
    const outcome = parseFlag(rest, "--outcome");
    try {
      const entry = await appendExperiment(root, {
        lever,
        from: parseValue(rawFrom),
        to: parseValue(rawTo),
        task: parseFlag(rest, "--task") ?? "",
        ...(outcome !== undefined ? { outcome: outcome as ExperimentOutcome } : {}),
      });
      emit(`recorded ${entry.lever}: ${String(entry.from)} → ${String(entry.to)} (${entry.outcome}) as ${entry.id}\n`);
      return 0;
    } catch (err) {
      emit(`meta record failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (cmd === "apply") {
    const file = rest.find((a) => !a.startsWith("--"));
    if (file === undefined) {
      emit(USAGE);
      return 2;
    }
    const task = parseFlag(rest, "--task") ?? "";
    try {
      const next = await readJson(file);
      const settingsPath = join(root, ".wudao", "settings.json");
      let before: Record<string, unknown> | undefined;
      try {
        before = await readJson(settingsPath);
      } catch {
        before = undefined; // first write: every experimental field is "new"
      }
      // Atomic write: tmp + rename, so a crash never leaves half a policy
      // file (settings.json IS the runtime permission policy).
      await mkdir(join(root, ".wudao"), { recursive: true });
      const tmp = `${settingsPath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(tmp, settingsPath);
      const recorded = await recordSettingsExperiments(root, before, next, task);
      emit(
        recorded.length === 0
          ? `applied ${file} (no experimental fields changed)\n`
          : `applied ${file} — journaled ${recorded.length} experiment${recorded.length === 1 ? "" : "s"}: ${recorded.map((e) => e.lever).join(", ")}\n`,
      );
      return 0;
    } catch (err) {
      emit(`meta apply failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  emit(USAGE);
  return 2;
}
