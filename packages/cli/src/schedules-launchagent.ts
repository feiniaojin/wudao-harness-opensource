// 122 项 2 — LaunchAgent 离线唤起（docs/research/122-launchagent-design.md 的
// MVP 落地）。缺口：desktop app 完全关闭后无宿主，火不可能准时触发；正解是
// 用户域 launchd LaunchAgent——到点用 `open -a 悟道Harness --args
// --schedule-wake` 把 app 拉起来（单宿主法则：绝不直接跑 sidecar）。谁该跑
// 由 app 内 daemon 的 applyMissedFire 决定（一 gap 一火），plist 只保真
// 「下一次有任何火」这一格（min-wake 单 plist）：add/rm 的同步成本从「每次
// 表变更」塌缩到「min 变化时」。
//
// 语义细节（测试钉死）：
// - plist 格子是 nearestWakeAt 的下一整分钟（StartCalendarInterval 只有分钟
//   粒度——本仓调度面最细就是分钟，无损）。launchd 的 calendar 触发每日重
//   复：火后 daemon 的 reconcile 会把格子前进到真实下一火；app 一直不开的
//   极端下「每天到点 open 一次」是设计接受的后备（无弹窗、失败进系统日志）。
// - 分钟格子必须严格在未来：已过/正发射中的 wake（nearestWakeAt 会给出
//   ≤ now 的值——在途 run 的覆盖是睡眠守卫的事）不动 plist（写过去=launchd
//   排到明天，删除=丢火后自愈，都不对；持有现值等火后前进）。
// - 幂等：字节相同不重写、不 bootout/bootstrap（同步成本钉在「内容变化时」）。
// - 内容变化 = 原子重写（tmp+rename）+ bootout + bootstrap（launchd 不监视
//   文件变更；bootout 对未装载者报错是常态，容忍）。失败 → failed outcome
//   （daemon 面一次 notify + /doctor ⚠️，下轮 reconcile 自愈重试）。
// - 平台分支：macOS 首发其余 unsupported（设计 §6——systemd user timer /
//   Task Scheduler 是后续弧）；unsupported = 零写零 spawn。
// - 权限边界：只写 <home>/Library/LaunchAgents/ 下自己的一个文件，别处不碰。
// - `--schedule-wake` 旗标：launchd 拉起的是 Tauri 壳（argv 只在壳进程可
//   见），main.rs 译成 SCHEDULE_WAKE_ENV 递给 sidecar（sea-entry 会重写
//   argv，env 原样存活）；sidecar 只用它打唤起回执——补跑语义走 daemon
//   boot 的既有 applyMissedFire + 立即 tick，绝不发明第二条补跑路径。

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  SCHEDULE_LAUNCHAGENT_APP_NAME, SCHEDULE_LAUNCHAGENT_LABEL, SCHEDULE_LAUNCHAGENT_PLIST_FILE,
  SCHEDULE_WAKE_ARG, SCHEDULE_WAKE_ENV,
} from "./schedules-model.js";

// ---------------------------------------------------------------------------
// The wake flag (pure; the CLI-side read of the launchd handoff)
// ---------------------------------------------------------------------------

/** True iff argv carries the launchd wake flag literally. Pure (tests pin
 *  the exact token; anything else — values, prefixes — is not the flag). */
export function parseScheduleWakeArgv(argv: readonly string[]): boolean {
  return argv.includes(SCHEDULE_WAKE_ARG);
}

/** The sidecar-side read: the Tauri shell translated its `--schedule-wake`
 *  argv into SCHEDULE_WAKE_ENV=1 (sea-entry rewrites argv, env survives);
 *  a direct `wudao ui --schedule-wake` run also counts. */
export function scheduleWakeRequested(env: NodeJS.ProcessEnv, argv: readonly string[]): boolean {
  return env[SCHEDULE_WAKE_ENV] === "1" || parseScheduleWakeArgv(argv);
}

// ---------------------------------------------------------------------------
// The plist payload (pure render/parse — the byte format IS the contract)
// ---------------------------------------------------------------------------

/** The next whole-minute boundary at-or-after `at` (epoch ms). launchd's
 *  StartCalendarInterval has minute granularity; the fire a few seconds
 *  early is impossible, a minute late is the accepted floor. Pure. */
export function launchAgentMinuteOf(at: number): number {
  return Math.ceil(at / 60_000) * 60_000;
}

/** StartCalendarInterval parts of a minute boundary, in LOCAL time
 *  (launchd calendar intervals are wall-clock). Pure. */
export function startCalendarIntervalOf(minuteAt: number): { readonly Hour: number; readonly Minute: number } {
  const d = new Date(minuteAt);
  return { Hour: d.getHours(), Minute: d.getMinutes() };
}

/** Render the agent plist for a minute boundary. Deterministic bytes for a
 *  given minute (the reconcile's idempotence compares these bytes); the XML
 *  prolog mirrors what launchd itself accepts for hand-written agents. */
export function renderLaunchAgentPlist(minuteAt: number): string {
  const { Hour, Minute } = startCalendarIntervalOf(minuteAt);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${SCHEDULE_LAUNCHAGENT_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/open</string>
		<string>-a</string>
		<string>${SCHEDULE_LAUNCHAGENT_APP_NAME}</string>
		<string>--args</string>
		<string>${SCHEDULE_WAKE_ARG}</string>
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>${Hour}</integer>
		<key>Minute</key>
		<integer>${Minute}</integer>
	</dict>
	<key>RunAtLoad</key>
	<false/>
</dict>
</plist>
`;
}

/** Parse OUR plist's calendar interval back out (reconcile comparisons and
 *  the /doctor current-value line read the file, not memory). Tolerant of
 *  whitespace; anything unrecognized (a foreign/corrupt file) → undefined —
 *  the writer's answer to drift is overwrite, never crash. */
export function parseLaunchAgentPlist(text: string): { readonly hour: number; readonly minute: number } | undefined {
  const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(text);
  const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(text);
  if (hour === null || minute === null) return undefined;
  const h = Number(hour[1]);
  const m = Number(minute[1]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return undefined;
  return { hour: h, minute: m };
}

// ---------------------------------------------------------------------------
// The sync handle (file + launchctl; every effect injectable for tests)
// ---------------------------------------------------------------------------

/** The launchctl seam: resolves exit status + collected stderr (the honest
 *  face for the ⚠️ receipt; tests record calls). */
export type LaunchctlRunner = (args: readonly string[]) => Promise<{ readonly ok: boolean; readonly stderr: string }>;

const defaultLaunchctl: LaunchctlRunner = (args) =>
  new Promise((resolve) => {
    const child = spawn("/bin/launchctl", [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err: Error) => resolve({ ok: false, stderr: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0, stderr }));
  });

/** `gui/<uid>` — launchd's per-user session target. @types/node makes
 *  getuid presence-dependent; the -1 fallback never runs where this module
 *  arms (darwin always has it) — it only keeps the type honest. */
const guiSessionTarget = (): string => {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  return `gui/${uid}`;
};

export type LaunchAgentOutcome =
  | { readonly kind: "unsupported" } // non-macOS: zero footprint
  | { readonly kind: "held" } // the nearest wake is at/past now — in flight, plist untouched
  | { readonly kind: "current"; readonly at: number } // bytes already match — no write, no launchctl
  | { readonly kind: "written"; readonly at: number } // rewrote + reloaded
  | { readonly kind: "removed" } // bootout + unlink
  | { readonly kind: "noop" } // nothing owed, nothing on disk
  | { readonly kind: "failed"; readonly error: string };

export interface LaunchAgentSyncOptions {
  readonly platform?: string;
  /** Tests point this at a tmpdir; production ALWAYS the real home — launchd
   *  reads the real ~/Library/LaunchAgents, an override would arm a file the
   *  system never loads. */
  readonly homeDir?: string;
  readonly now?: () => number;
  readonly launchctl?: LaunchctlRunner;
}

export interface LaunchAgentSync {
  /** Idempotent reconcile for one desired wake moment (undefined = nothing
   *  owed → remove). Serialized callers not required (no cross-call state). */
  sync(desiredWakeAt: number | undefined): Promise<LaunchAgentOutcome>;
  /** The plist's current text, if the file exists (doctor + tests). */
  readback(): Promise<string | undefined>;
  /** The plist path under this handle's home (doctor's 现值行 names it). */
  plistPath(): string;
}

export function createLaunchAgentSync(options: LaunchAgentSyncOptions = {}): LaunchAgentSync {
  const darwin = (options.platform ?? process.platform) === "darwin";
  const home = options.homeDir ?? homedir();
  const now = options.now ?? Date.now;
  const runLaunchctl = options.launchctl ?? defaultLaunchctl;
  const path = join(home, "Library", "LaunchAgents", SCHEDULE_LAUNCHAGENT_PLIST_FILE);

  const bootout = (): Promise<void> =>
    runLaunchctl(["bootout", guiSessionTarget(), SCHEDULE_LAUNCHAGENT_LABEL]).then(
      // A not-loaded job is the common case (first write, crash leftovers) —
      // bootout's error there is noise, not failure.
      () => undefined,
      () => undefined,
    );

  return {
    async sync(desiredWakeAt) {
      if (!darwin) return { kind: "unsupported" };
      const at = now();
      const existing = await readFile(path, "utf8").catch(() => undefined);
      if (desiredWakeAt === undefined) {
        if (existing === undefined) return { kind: "noop" };
        await bootout();
        try {
          await unlink(path);
        } catch (err) {
          return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
        }
        return { kind: "removed" };
      }
      // An at/past wake is being fired by the live daemon right now — the
      // plist must neither move (a past minute reads as TOMORROW to launchd)
      // nor disappear (the post-fire advance reconciles it in a moment).
      if (desiredWakeAt <= at) return { kind: "held" };
      const minuteAt = launchAgentMinuteOf(desiredWakeAt);
      const xml = renderLaunchAgentPlist(minuteAt);
      if (existing === xml) return { kind: "current", at: minuteAt };
      try {
        await mkdir(dirname(path), { recursive: true });
        // Atomic swap (the store's tmp-then-rename idiom): a launchd read
        // never sees a half-written plist.
        const tmp = `${path}.tmp-${process.pid}`;
        await writeFile(tmp, xml, "utf8");
        await rename(tmp, path);
      } catch (err) {
        return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
      }
      await bootout();
      const boot = await runLaunchctl(["bootstrap", guiSessionTarget(), path]);
      if (!boot.ok) {
        return { kind: "failed", error: boot.stderr.trim() !== "" ? boot.stderr.trim() : "launchctl bootstrap 失败" };
      }
      return { kind: "written", at: minuteAt };
    },
    async readback() {
      if (!darwin) return undefined;
      return readFile(path, "utf8").catch(() => undefined);
    },
    plistPath() {
      return path;
    },
  };
}

/** The next wall-clock occurrence of a daily {hour, minute} after `at`
 *  (local time — the plist's calendar semantics). Doctor's 现值行 shows
 *  THIS, not the stale write-time minute. Pure. */
export function nextCalendarOccurrence(hour: number, minute: number, at: number): number {
  const d = new Date(at);
  const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() > at) return candidate.getTime();
  return candidate.getTime() + 24 * 60 * 60_000;
}
