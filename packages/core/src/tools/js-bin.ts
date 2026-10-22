// exec-file-of-a-JS-script helper. pnpm .bin shims on win32 are .CMD files
// execFile cannot spawn, and bare .js/.mjs/.cjs entries have no interpreter
// association — a JS-addressable bin is then named by its two-word form
// `node <entry>`. Consumers (write-verify's checkers, shell's docker
// CLI) accept that form in their bin/path options; this module owns the one
// split. Posix bins never carry the form (their paths contain no spaces by
// construction), so the helper is a no-op there.

/** Split a possibly-two-word bin into [exe, prefixArgs]. */
export function splitJsBin(bin: string): { exe: string; prefix: string[] } {
  if (process.platform !== "win32" || !/\.[cm]?js$/i.test(bin) || !bin.includes(" ")) {
    return { exe: bin, prefix: [] };
  }
  // The exe may itself contain spaces (C:\Program Files\…): anchor the split
  // on the .js/.cjs/.mjs entry — everything before the LAST token is the exe.
  const m = /^(.*?) ([^\s]+\.[cm]?js)$/i.exec(bin);
  if (m === null) return { exe: bin, prefix: [] };
  return { exe: m[1]!, prefix: [m[2]!] };
}
