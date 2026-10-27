// Fake sidecars for the handshake/terminate suites — real `node` processes
// speaking (or abusing) the stdout protocol. Launched with
// `node tests/fake-sidecar.ts <mode> [args]` so the suites exercise genuine
// pipes, timers, signals and reaping, not mocks.
//
// Modes:
//   url [delayMs] [port]   banner lines, then the protocol line, then stays
//                          alive (keepalive interval) until terminated.
//   url-twice              two valid protocol lines (first must win).
//   silent                 prints junk, stays alive — exercises the timeout.
//   ignore-term [delayMs]  prints the protocol line, installs a noop SIGTERM
//                          handler — only SIGKILL ends it (zombie fallback).
//   exit-early [code]      writes an stderr note and exits before any line.

const TOKEN = "A".repeat(43); // 32B base64url length, realistic shape

function keepalive(): void {
  // Deliberately NOT unref'd: a live sidecar holds its event loop open until
  // it is terminated — that is the process shape these suites exercise.
  setInterval(() => {}, 1 << 30);
}

const mode = process.argv[2] ?? "url";

switch (mode) {
  case "url": {
    const delay = Number(process.argv[3] ?? "0");
    const port = Number(process.argv[4] ?? "39281");
    const emit = (): void => {
      process.stdout.write("wudao ui v0.2.0 · test model · session deadbeef\n");
      process.stdout.write(`open: http://127.0.0.1:${port}/#${TOKEN}\n`);
      process.stdout.write("(loopback only · Ctrl+C to stop)\n");
    };
    if (delay > 0) setTimeout(emit, delay);
    else emit();
    keepalive();
    break;
  }
  case "url-twice": {
    process.stdout.write(`open: http://127.0.0.1:40001/#${TOKEN}\n`);
    process.stdout.write(`open: http://127.0.0.1:40002/#${"B".repeat(43)}\n`);
    keepalive();
    break;
  }
  case "silent": {
    process.stdout.write("starting…\n");
    process.stdout.write("still starting (no protocol line)\n");
    keepalive();
    break;
  }
  case "ignore-term": {
    const delay = Number(process.argv[3] ?? "0");
    process.on("SIGTERM", () => {
      /* the zombie: swallow the graceful signal */
    });
    const emit = (): void => {
      process.stdout.write(`open: http://127.0.0.1:39281/#${TOKEN}\n`);
    };
    if (delay > 0) setTimeout(emit, delay);
    else emit();
    keepalive();
    break;
  }
  case "exit-early": {
    const code = Number(process.argv[3] ?? "1");
    process.stderr.write("wudao: No API key found. Set WUDAO_API_KEY, then rerun.\n");
    process.exit(code);
    break;
  }
  default:
    process.stderr.write(`fake-sidecar: unknown mode "${mode}"\n`);
    process.exit(64);
}
