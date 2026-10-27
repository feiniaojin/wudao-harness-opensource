#!/usr/bin/env node
// Fake `docker` for CLI sandbox-wiring tests: records argv to $FAKE_DOCKER_LOG,
// answers the availability probe, and echoes $FAKE_DOCKER_OUT on `docker run`.
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(argv)}\n`);

if (argv.includes("version")) {
  process.stdout.write("27.5.1-fake\n");
  process.exit(0);
}
if (process.env.FAKE_DOCKER_OUT) process.stdout.write(`${process.env.FAKE_DOCKER_OUT}\n`);
process.exit(0);
