// 夜移 006 (opencode permission/arity port, hardened): the rule an `a`/`p`
// answer records for shell. wudao's askRuleFor previously fell through
// to the BARE tool rule — approving ONE command blanket-approved EVERY
// command. The port derives a command-prefix rule (opencode's BashArity)
// with three tightenings opencode lacks:
//   1. compound commands (unquoted ; | & < > ` $( ) records NO rule — a
//      pipeline's second half is never pre-approved by its first;
//   2. destructive heads (rm, dd, kill…) degrade to EXACT-match, not prefix;
//   3. unknown heads record the EXACT command (opencode's arity-1 default
//      would turn `python a.py` into `python *` — arbitrary-script blanket).
import { describe, it, expect } from "vitest";
import { commandArityRule, commandHeadTokens } from "../src/permission-arity.js";

describe("commandHeadTokens — quote-aware head tokenizer", () => {
  it("splits on whitespace and skips leading VAR=value assignments", () => {
    expect(commandHeadTokens("FOO=1 git status --porcelain")).toEqual(["git", "status", "--porcelain"]);
    expect(commandHeadTokens("A=1 B=2 cargo build")).toEqual(["cargo", "build"]);
  });
  it("keeps tokens verbatim (no flag stripping — the arity table counts subcommands only)", () => {
    expect(commandHeadTokens("git checkout -b feature/x")).toEqual(["git", "checkout", "-b", "feature/x"]);
  });
  it("unquoted shell operators make the whole command compound → null (no rule)", () => {
    expect(commandHeadTokens("git checkout main && rm -rf /")).toBeNull();
    expect(commandHeadTokens("cat a | grep x")).toBeNull();
    expect(commandHeadTokens("echo a; echo b")).toBeNull();
    expect(commandHeadTokens("ls > out.txt")).toBeNull();
    expect(commandHeadTokens("echo $(whoami)")).toBeNull();
    expect(commandHeadTokens("echo `whoami`")).toBeNull();
    expect(commandHeadTokens("line1\nline2")).toBeNull();
  });
  it("the same operators INSIDE quotes are plain text, not compounds", () => {
    expect(commandHeadTokens('git commit -m "fix: a && b"')).toEqual(["git", "commit", "-m", '"fix:', "a", "&&", 'b"']);
    expect(commandHeadTokens("echo 'a; b'")).toEqual(["echo", "'a;", "b'"]); // split is whitespace-naive; compounds are what quotes guard, not token shape
  });
  it("empty/whitespace-only input → null", () => {
    expect(commandHeadTokens("")).toBeNull();
    expect(commandHeadTokens("   ")).toBeNull();
  });
});

describe("commandArityRule — the rule recorded for an approval", () => {
  it("arity table: nested families take their longest known prefix", () => {
    expect(commandArityRule("git checkout main")).toBe("git checkout");
    expect(commandArityRule("npm run dev")).toBe("npm run dev"); // arity 3, only 3 tokens — the whole identity
    expect(commandArityRule("npm install")).toBe("npm install");
    expect(commandArityRule("docker compose up -d")).toBe("docker compose up");
    expect(commandArityRule("aws s3 ls bucket")).toBe("aws s3 ls");
    expect(commandArityRule("cargo run --release")).toBe("cargo run --release"); // arity 3 counts tokens, flags included (opencode parity)
  });
  it("read-only arity-1 heads record the bare head (bounded, harmless)", () => {
    expect(commandArityRule("ls -la /tmp")).toBe("ls");
    expect(commandArityRule("cat package.json")).toBe("cat");
    expect(commandArityRule("git")).toBe("git"); // head alone = arity floor
  });
  it("destructive heads degrade to EXACT match (never a prefix rule)", () => {
    expect(commandArityRule("rm -rf /tmp/x")).toBe("rm -rf /tmp/x");
    expect(commandArityRule("kill 1234")).toBe("kill 1234");
    expect(commandArityRule("dd if=/dev/zero of=/dev/disk2")).toBe("dd if=/dev/zero of=/dev/disk2");
  });
  it("unknown heads record the EXACT command (no python-* blanket)", () => {
    expect(commandArityRule("python scripts/build.py --fast")).toBe("python scripts/build.py --fast");
    expect(commandArityRule("make test")).toBe("make test");
  });
  it("exact rules are whitespace-collapsed", () => {
    expect(commandArityRule("make   test")).toBe("make test");
  });
  it("compounds record NOTHING (null) — approval covers this run only", () => {
    expect(commandArityRule("git push && npm publish")).toBeNull();
    expect(commandArityRule("rm -rf x; rm -rf y")).toBeNull();
  });
  it("leading env assignments never widen or break the rule head", () => {
    expect(commandArityRule("CI=1 pnpm build")).toBe("pnpm build");
    expect(commandArityRule("FORCE=1 rm -rf dist")).toBe("FORCE=1 rm -rf dist"); // exact form keeps the env prefix visible
  });
});
