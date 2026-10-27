// Slow "checker" for the write-verify budget lane. The posix twin is
// fake-slow-sh.sh (`sleep 2`); this .mjs is the win32-executable spelling
// (a bare .sh cannot be spawned there — tests point bins.sh at it via the
// two-word `node <entry>` form).
const nap = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* busy-wait: setTimeout would let the probe exit before the budget hits */
  }
};
nap(2_000);
