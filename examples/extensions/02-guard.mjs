// Example 02 — an interceptor guard: block destructive shell calls,
// plus a working-hours window for risky commands.
//
// Install:  mkdir -p .wudao/extensions
//           cp examples/extensions/02-guard.mjs .wudao/extensions/
// Try it:   wudao "run this exact command: rm -rf /tmp/guard-demo-target"
//           → the call is blocked BEFORE the permission gate; the model sees
//             "blocked by hook: …" and can choose a safer command.
// Commands matching BOTH a destructive pattern and the overnight window are
// blocked either way; a handler that throws or (with a timeout configured)
// hangs degrades to allow — the run never wedges.
//
// Interceptor events return {block: true, reason}; observer events (like
// post_tool_use below) are fire-and-forget. Handler budget: 10s by default,
// WUDAO_EXTENSION_TIMEOUT_MS to change (0 disables).
const DESTRUCTIVE = [/\brm\s+-rf\b/, /\bgit\s+push\s+--force\b/, /\bgit\s+reset\s+--hard\b/, /\bdrop\s+(table|database)\b/i];
const RISKY = [/\bnpm\s+publish\b/, /\bdocker\s+(system\s+prune|rmi)\b/];

// Demo override: export WUDAO_GUARD_QUIET_HOURS="0-8" (local hour range,
// wrap-around allowed). Default: no quiet hours.
function quietHours(env = process.env) {
  const raw = env.WUDAO_GUARD_QUIET_HOURS;
  const m = raw && /^(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]) };
}

function inQuietHours(now, window) {
  const h = now.getHours();
  return window.from <= window.to ? h >= window.from && h < window.to : h >= window.from || h < window.to;
}

export default function wudaoExtension(api) {
  const quiet = quietHours();

  api.on("pre_tool_use", (p) => {
    if (p.tool !== "shell") return;
    const command = String(p.input.command ?? "");
    if (DESTRUCTIVE.some((re) => re.test(command))) {
      return {
        block: true,
        reason: `02-guard: destructive command refused (${command.slice(0, 60)}). Use a narrower target or git revert instead.`,
      };
    }
    if (quiet && RISKY.some((re) => re.test(command)) && inQuietHours(new Date(), quiet)) {
      return {
        block: true,
        reason: `02-guard: ${quiet.from}:00–${quiet.to}:00 quiet hours — risky command refused (${command.slice(0, 60)}).`,
      };
    }
  });

  // Observer: every executed command lands in the session JSONL as a
  // guard_audit entry (read back with 03-session-notes).
  api.on("post_tool_use", (p) => {
    if (p.tool !== "shell") return;
    void api.appendEntry("guard_audit", { command: p.input.command, ok: !p.result.includes("[exit") || p.result.includes("[exit 0]") });
  });
}
