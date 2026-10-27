// 夜移 034 stage-2 — wiring pins for the bounded-command lane swap. Node
// drains stdio on NATURAL exit (a pending pipe write keeps the loop alive),
// so the tail-loss window is exactly the paths that process.exit DIRECTLY —
// the bounded commands (perms lint / sessions search / purge / statusline /
// slack fallback) and the sub-main exit-code relays. Stage-1 landed the
// guard + the one-shot streaming/settle seams (d35b52e); stage-2 routes the
// dispatch region's writes through the lane and flushes before every direct
// exit. Behavioral output equality is pinned by dispatch-wiring's spawn
// cases (perms usage + exit 1 runs the swapped path through the real
// binary); these pins keep the wiring itself from silently regressing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const indexSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8")
    + "\n" + readFileSync(fileURLToPath(new URL("../src/commands/perms.ts", import.meta.url)), "utf8"); // v7 弧α：perms 命令面拆出，守卫泳道钉随迁双读
const engineSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/driver/session-engine.ts", import.meta.url)), "utf8");

describe("夜移 034 stage-2 — bounded commands ride the guard lane", () => {
  it("every bounded write in the dispatch region went through the lane", () => {
    const src = indexSrc();
    // usage hints + reports that feed a direct exit (or a piped consumer)
    expect(src).toContain('stdoutGuard.writeRawStdout("用法：wudao perms lint'); // ω99-166d-i: 钉头串演进（#9）
    expect(src).toContain("stdoutGuard.writeRawStdout(`${formatLintReport(findings");
    expect(src).toContain('stdoutGuard.writeRawStdout("用法：wudao sessions search'); // ω99-166d-i: 钉头串演进（#10）
    expect(src).toContain("stdoutGuard.writeRawStdout(`${await runSessionSearch");
    expect(src).toContain("stdoutGuard.writeRawStdout(`用法：wudao purge"); // ω99-166d-i: 钉头串演进（#11）
    expect(src).toContain("stdoutGuard.writeRawStdout(`${formatPurgePlan(plan)}");
    expect(src).toContain("stdoutGuard.writeRawStdout(`${formatStatuslineLine(snapshot)}");
    expect(src).toContain("stdoutGuard.writeRawStdout(`${JSON.stringify(snapshot, null, 2)}");
    // the slack load-fail fallback (its exit(1) is a direct exit)
    expect(src).toMatch(/stdoutGuard\.writeRawStdout\([\s\S]{0,80}@wudao\/slack could not be loaded/);
    // and the bare `process.stdout.write` exits are gone from those sites
    expect(src).not.toContain('process.stdout.write("用法：wudao perms lint'); // ω99-166d-i: 双负钉同步演进（直写禁止仍以新串为靶，#9）
    expect(src).not.toContain('process.stdout.write("用法：wudao purge'); // ω99-166d-i: 双负钉同步演进（直写禁止仍以新串为靶，#11）
  });

  it("every direct process.exit in the dispatch region flushes the lane first", () => {
    const src = indexSrc();
    // stage-1's single choke point (main's finally) + the stage-2 dispatch
    // sites: perms usage / perms findings / workflow / plugin / meta relays /
    // purge usage / slack load-fail / slack doctor / slack code relay.
    const flushes = src.split("await stdoutGuard.flushRawStdout();").length - 1;
    expect(flushes).toBeGreaterThanOrEqual(10);
    // the bounded region: from the workflow dispatch to the end of the slack
    // block's exit-code relay. Every process.exit inside it must have the
    // flush within the preceding window (the exact `await …;` line pattern).
    const from = src.indexOf('if (argv[2] === "workflow")');
    const to = src.indexOf("process.exit(code);", src.indexOf("await mod.slackMain({"));
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    const region = src.slice(from, to);
    const exits = [...region.matchAll(/process\.exit\(/g)];
    expect(exits.length).toBeGreaterThanOrEqual(7); // v7 弧α：perms 的 exit 随命令拆出（commands/perms.ts 同款 flush 纪律由上钉 toContain 盯）
    for (const m of exits) {
      const at = m.index ?? 0;
      const before = region.slice(Math.max(0, at - 160), at);
      expect(before).toContain("flushRawStdout();");
    }
  });

  it("session-engine's warn/notify fallbacks ride the lane (not bare process.stdout)", () => {
    const src = engineSrc();
    expect(src).toContain('from "../output-guard.js"');
    // every props.startupNotice fallback lambda swaps to the guard lane
    expect(src).not.toContain("?? ((l) => process.stdout.write");
    expect(src).not.toContain("?? ((l: string) => process.stdout.write");
    expect(src).not.toContain("?? ((line) => process.stdout.write");
    expect(src.split("stdoutGuard.writeRawStdout").length - 1).toBeGreaterThanOrEqual(5);
  });
});
