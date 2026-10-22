#!/usr/bin/env node
// Fake `docker` for shell sandbox tests. Every invocation's argv is
// appended (one JSON array per line) to $FAKE_DOCKER_LOG, then a behavior is
// emulated based on $FAKE_DOCKER_MODE:
//   probe-ok   (default) probe succeeds; a run echoes $FAKE_DOCKER_OUT to
//               stdout, $FAKE_DOCKER_ERR to stderr, and exits $FAKE_DOCKER_EXIT
//   probe-fail the availability probe fails (stderr + exit 1)
//   stall      a run never finishes (killed externally by the tool timeout)
//   selfkill   a run SIGKILLs itself (non-SIGTERM signal-label path)
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
if (log) appendFileSync(log, `${JSON.stringify(argv)}\n`);

const mode = process.env.FAKE_DOCKER_MODE ?? "probe-ok";

// Availability probe: `<docker> version --format {{.Server.Version}}`.
if (argv.includes("version")) {
  if (mode === "probe-fail") {
    process.stderr.write("fake-docker: cannot connect to the Docker daemon\n");
    process.exit(1);
  }
  process.stdout.write("27.5.1-fake\n");
  process.exit(0);
}

// `docker run` emulation.
if (mode === "stall") {
  // Park the event loop; the parent's timeout is what terminates us.
  setInterval(() => {}, 60_000);
} else if (mode === "selfkill") {
  process.kill(process.pid, "SIGKILL");
} else {
  if (process.env.FAKE_DOCKER_OUT) process.stdout.write(`${process.env.FAKE_DOCKER_OUT}\n`);
  if (process.env.FAKE_DOCKER_ERR) process.stderr.write(`${process.env.FAKE_DOCKER_ERR}\n`);
  process.exit(Number(process.env.FAKE_DOCKER_EXIT ?? "0"));
}
