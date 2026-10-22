// M55 §C2 — /doctor: environment and configuration health checks. Each check
// is pure (no network I/O) and reports ✅/⚠️ with at most one fix hint. The
// driver aggregates the checks; the command module only validates + formats.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveProviderConfigResult } from "@wudao/providers";
// M63 §B: the credentials-file check — counts only, never values.
import { credentialsFileStatusSync, readCredentialsFileSync } from "../credentials.js";

/** One doctor check result. */
export interface DoctorCheck {
  /** ✅ / ⚠️  (the notice-renderer uses emoji). */
  readonly status: "ok" | "warn";
  readonly label: string;
  readonly hint?: string;
}

/** All doctor check inputs (the driver supplies these). */
export interface DoctorInput {
  readonly cwd: string;
  readonly nodeVersion: string;
  readonly requiredNode: string;
  readonly providerKey?: string;
  /** M63 §B: env the checks resolve against (default process.env). */
  readonly env?: NodeJS.ProcessEnv;
  readonly settingsPath?: string;
  readonly mcpConfigPath?: string;
  readonly sessionDir?: string;
  readonly wudaoDir?: string;
  readonly evalDir?: string;
  /** M59 §3: the resolved web settings (search provider state for the
   *  guidance check; fetch is zero-config always-on). */
  readonly web?: WebDoctorInput;
  /** M61 §4: the durable scheduling daemon's status line (rendered as-is). */
  readonly schedules?: string;
}

/** M59 §3: what the web checks need — the search half of loadWebSettings. */
export interface WebDoctorInput {
  readonly search: {
    readonly configured: boolean;
    readonly provider?: string;
    readonly endpoint?: string;
    readonly apiKeyEnv?: string;
  };
}

/** Check node version against package.json engines. */
export function checkNodeVersion(opts: DoctorInput): DoctorCheck {
  const semver = (s: string): number[] => s.split(".").map((v) => parseInt(v, 10)).filter((n) => !isNaN(n));
  const got = semver(opts.nodeVersion);
  const need = semver(opts.requiredNode.replace(/^>=/, ""));
  // Handle cases where need is just [22] (from ">=22") vs got is [22,0,0]
  // If need has only 1 element, we only compare major versions
  const ok = got.length >= 1 && need.length >= 1 && (
    need.length === 1
      ? (got[0] ?? 0) >= (need[0] ?? 0)  // Only compare major version
      : got.length >= 2 && (
          (got[0] ?? 0) > (need[0] ?? 0) || ((got[0] ?? 0) === (need[0] ?? 0) && (got[1] ?? 0) >= (need[1] ?? 0))
        )
  );
  return ok
    ? { status: "ok", label: `Node.js ${opts.nodeVersion} (>= ${opts.requiredNode.replace(/^>=/, "")})` }
    : { status: "warn", label: `Node.js ${opts.nodeVersion} (requires >= ${opts.requiredNode.replace(/^>=/, "")})`, hint: "upgrade Node.js" };
}

/** Check provider config resolution (no network call). M63 §B: the
 *  credentials file joins as the fallback key source (env wins). */
export function checkProviderConfig(opts: DoctorInput): DoctorCheck {
  try {
    // Review nit: honor the input's env seam (the driver may pass a
    // forwarded env; default the process's).
    const env = opts.env ?? process.env;
    const result = resolveProviderConfigResult(env, {}, readCredentialsFileSync(env));
    if (!result.ok) {
      return { status: "warn", label: `provider config: ${result.reason}`, hint: "check WUDAO_PROVIDER / WUDAO_MODEL" };
    }
    return { status: "ok", label: `provider config: ${result.config.provider} / ${result.config.model}` };
  } catch (err) {
    return { status: "warn", label: `provider config: error`, hint: err instanceof Error ? err.message : "check environment" };
  }
}

/** M63 §B — the credentials file: presence + key COUNT only (values never
 *  render anywhere) + the 0600 posture. A loosened mode warns with the
 *  repair hint (the next settings-page save re-chmods 0600). */
export function checkCredentialsFile(env: NodeJS.ProcessEnv = process.env): DoctorCheck {
  const s = credentialsFileStatusSync(env);
  if (s.keyCount === 0) {
    return { status: "ok", label: `credentials file: 0 keys (${s.path})` };
  }
  const label = `credentials file: ${s.keyCount} keys (${s.path}${s.mode !== undefined ? `, ${s.mode}` : ""})`;
  if (!s.modeOk) {
    return { status: "warn", label, hint: `chmod 0600 ${s.path} — the next settings-page save re-enforces it` };
  }
  return { status: "ok", label };
}

/** Check API key presence (redacted). */
export function checkApiKey(opts: DoctorInput): DoctorCheck {
  if (!opts.providerKey) {
    return { status: "warn", label: "API key: not set", hint: "set WUDAO_API_KEY or provider-specific key" };
  }
  const redacted = opts.providerKey.slice(0, 4) + "…";
  return { status: "ok", label: `API key: ${redacted}` };
}

/** Check settings.json parse. */
export function checkSettingsJson(opts: DoctorInput): DoctorCheck {
  if (!opts.settingsPath || !existsSync(opts.settingsPath)) {
    return { status: "ok", label: "settings.json: not present (using defaults)" };
  }
  try {
    readFileSync(opts.settingsPath, "utf8");
    return { status: "ok", label: "settings.json: valid" };
  } catch (err) {
    return { status: "warn", label: "settings.json: parse error", hint: err instanceof Error ? err.message : "fix JSON syntax" };
  }
}

/** Check mcp.json parse. */
export function checkMcpJson(opts: DoctorInput): DoctorCheck {
  if (!opts.mcpConfigPath || !existsSync(opts.mcpConfigPath)) {
    return { status: "ok", label: "mcp.json: not present" };
  }
  try {
    readFileSync(opts.mcpConfigPath, "utf8");
    return { status: "ok", label: "mcp.json: valid" };
  } catch (err) {
    return { status: "warn", label: "mcp.json: parse error", hint: err instanceof Error ? err.message : "fix JSON syntax" };
  }
}

/** Check session directory writability. */
export function checkSessionDir(opts: DoctorInput): DoctorCheck {
  if (!opts.sessionDir || !existsSync(opts.sessionDir)) {
    return { status: "ok", label: "session dir: not present (will be created)" };
  }
  try {
    const testFile = join(opts.sessionDir, `.doctor-test-${Date.now()}`);
    writeFileSync(testFile, "", { flag: "wx" });
    // Immediately clean up
    try {
      const fs = require("node:fs");
      fs.unlinkSync(testFile);
    } catch {}
    return { status: "ok", label: `session dir: writable (${opts.sessionDir})` };
  } catch (err) {
    return { status: "warn", label: "session dir: not writable", hint: "check permissions" };
  }
}

/** Check .wudao disk usage (spill/history/memory). */
export function checkWudaoDiskUsage(opts: DoctorInput): DoctorCheck {
  if (!opts.wudaoDir || !existsSync(opts.wudaoDir)) {
    return { status: "ok", label: ".wudao: not present" };
  }
  try {
    let totalBytes = 0;
    let fileCount = 0;
    function walk(dir: string): void {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            totalBytes += statSync(full).size;
            fileCount += 1;
          } catch {}
        }
      }
    }
    walk(opts.wudaoDir);
    const mb = (totalBytes / 1024 / 1024).toFixed(2);
    return { status: "ok", label: `.wudao: ${fileCount} files, ${mb} MB` };
  } catch (err) {
    return { status: "warn", label: ".wudao: error scanning", hint: err instanceof Error ? err.message : "check directory permissions" };
  }
}

/** Check eval suite count and last result freshness. */
export function checkEvalSuites(opts: DoctorInput): DoctorCheck {
  if (!opts.evalDir || !existsSync(opts.evalDir)) {
    return { status: "ok", label: "evals: directory not present" };
  }
  try {
    const entries = readdirSync(opts.evalDir, { withFileTypes: true });
    const jsonFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".json"));
    if (jsonFiles.length === 0) {
      return { status: "ok", label: "evals: no result files" };
    }
    let newest = 0;
    for (const f of jsonFiles) {
      try {
        const mtime = statSync(join(opts.evalDir, f.name)).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {}
    }
    const daysSince = ((Date.now() - newest) / 86400000).toFixed(1);
    return { status: "ok", label: `evals: ${jsonFiles.length} result files, last ${daysSince} days ago` };
  } catch (err) {
    return { status: "warn", label: "evals: error scanning", hint: err instanceof Error ? err.message : "check directory permissions" };
  }
}

// M59 §3 — web tool checks. Both stay PURE (the M55 §C2 no-network
// contract): "configured?" is the settings state, "endpoint reachable?" is
// its syntactic reachability (an http(s) URL we can form a request against —
// the loader already unconfigured anything else), and the env-var presence
// for brave keys. A live probe belongs to a future opt-in flag, not /doctor.
export function checkWebFetch(_opts: DoctorInput): DoctorCheck {
  return { status: "ok", label: "web tools: web_fetch on (zero-config; SSRF-guarded, 2MB cap, 16k output)" };
}

/** M62 §2 — the soft-delete trash: file count, bytes, oldest age (the
 *  recoverable window's inventory; hard-deleted once past
 *  softDeletePeriodDays). */
export function checkTrash(opts: DoctorInput): DoctorCheck {
  const trashDir = opts.wudaoDir !== undefined ? join(opts.wudaoDir, "trash") : undefined;
  if (trashDir === undefined || !existsSync(trashDir)) {
    return { status: "ok", label: "trash: empty (no soft-deleted files)" };
  }
  try {
    let files = 0;
    let bytes = 0;
    let oldestMs = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          try {
            const s = statSync(full);
            files += 1;
            bytes += s.size;
            oldestMs = Math.max(oldestMs, Date.now() - s.mtimeMs);
          } catch {}
        }
      }
    };
    walk(trashDir);
    if (files === 0) return { status: "ok", label: "trash: empty" };
    const mb = (bytes / 1024 / 1024).toFixed(2);
    const days = Math.floor(oldestMs / 86_400_000);
    return {
      status: "ok",
      label: `trash: ${files} file(s), ${mb} MB, oldest ${days}d (purged past the soft-delete window)`,
    };
  } catch (err) {
    return { status: "warn", label: "trash: error scanning", hint: err instanceof Error ? err.message : "check permissions" };
  }
}

export function checkWebSearch(opts: DoctorInput): DoctorCheck {
  const web = opts.web;
  const search = web?.search;
  if (search === undefined || !search.configured) {
    return {
      status: "warn",
      label: "web tools: web_search not configured",
      hint: 'add "web": {"search": {"provider": "searxng", "endpoint": "http://localhost:8888"}} (self-hosted, zero key) — or {"provider": "brave", "apiKeyEnv": "BRAVE_API_KEY"} — to .wudao/settings.json',
    };
  }
  const provider = search.provider ?? "";
  if (provider === "brave") {
    const envName = search.apiKeyEnv ?? "";
    // Review nit: honor the input's env seam like every env-reading check.
    const env = opts.env ?? process.env;
    const key = envName !== "" ? env[envName] : undefined;
    if (key === undefined || key.trim() === "") {
      return { status: "warn", label: `web_search: brave (key env ${envName} not set)`, hint: `export ${envName}=<subscription token>` };
    }
    return { status: "ok", label: `web tools: web_search brave (key env ${envName} set)` };
  }
  return { status: "ok", label: `web tools: web_search searxng → ${search.endpoint ?? ""}` };
}

/** Run all doctor checks and format the report. */
export function formatDoctorReport(input: DoctorInput): string {
  const checks: DoctorCheck[] = [
    checkNodeVersion(input),
    checkProviderConfig(input),
    checkApiKey(input),
    // M63 §B: the credentials file (count only, never values).
    checkCredentialsFile(input.env),
    checkSettingsJson(input),
    checkMcpJson(input),
    checkSessionDir(input),
    checkWudaoDiskUsage(input),
    checkEvalSuites(input),
    // M62 §2: soft-delete residency (the recoverable window's contents).
    checkTrash(input),
    // M59 §3: the web pair — fetch always-on, search with guidance.
    checkWebFetch(input),
    checkWebSearch(input),
  ];
  const lines = ["doctor:"];
  for (const c of checks) {
    const icon = c.status === "ok" ? "✅" : "⚠️ ";
    lines.push(`  ${icon}${c.label}`);
    if (c.hint) {
      lines.push(`     → ${c.hint}`);
    }
  }
  // M61 §4: the durable daemon's line (informational — hosted by wudao ui).
  if (input.schedules !== undefined) {
    lines.push(`  📅${input.schedules}`);
  }
  return lines.join("\n");
}
