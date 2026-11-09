// Permission rule matching core — module-level segment extracted from
// permission.ts (ω99 file-size discipline arc A): the y/a/p/N ask-menu
// answer family, session-rule derivation, the bypass-immune protected/credential
// detections, path normalization, rule matching, and the in-memory session
// allowlist. Pure functions + const rosters; no IO.
import type { PermissionDecision } from "@wudao-org/core";
import { globToRegex } from "@wudao-org/core";
import { commandArityRule, commandHeadTokens, headHasEscalationFlags, isEnvLauncherHead } from "./permission-arity.js";
import { FILE_EDIT_TOOLS, FILENAME_KEY_TOOLS } from "./permission-modes.js";

/** One answer from the y/a/p/N ask menu. `session` = allow AND never ask again
 *  for this tool[:path-prefix] this session; `always` (0.3.14 #1) = the same
 *  rule persisted into the project tier's allow list; `deny` may carry the
 *  user's reason, which flows back to the model as part of the tool result. */
export type AskAnswer =
  | { kind: "allow" }
  | { kind: "session" }
  | { kind: "always" }
  | { kind: "deny"; reason?: string; /** M61 §4: the deny came from a durable scheduled run (no human present). */ scheduledRun?: boolean };

/** Parse one line of ask-menu input (REPL/one-shot read it raw; the TUI sends
 *  synthesized lines). Fail-closed: anything unrecognized is a deny. */
export function parseAskAnswer(line: string): AskAnswer {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "deny" };
  const lower = trimmed.toLowerCase();
  if (lower === "y" || lower === "yes") return { kind: "allow" };
  if (lower === "a" || lower === "all") return { kind: "session" };
  if (lower === "p" || lower === "always") return { kind: "always" };
  if (lower === "n" || lower === "no") return { kind: "deny" };
  // `n <reason>` / `no <reason>` — the reason is fed back to the model.
  const m = /^n(?:o)?\s+(.+)$/i.exec(trimmed);
  if (m?.[1]) return { kind: "deny", reason: m[1].trim() };
  return { kind: "deny" };
}

/** The allowlist rule an `a` answer records: the tool, or "tool:path" (the
 *  path itself is the prefix — an approval covers exactly that path, never a
 *  sibling; broader scopes belong in .wudao/settings.json). M59: web_fetch
 *  scopes to the HOST — an `a` on one domain never blanket-approves every
 *  other domain for the session. A web_fetch call whose URL won't parse, or
 *  parses without an http(s) authority (file:, data:, …), records NO rule
 *  (null): a bare or empty-suffix `web_fetch` rule would blanket-approve
 *  every domain — the exact escalation the host scoping exists to prevent
 *  (the tool refuses those calls at execution anyway, so the approval has
 *  nothing to cover). */
export function askRuleFor(toolName: string, input: Record<string, unknown>): string | null {
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") return `${toolName}:${path.trim()}`;
  if (toolName === "web_fetch") {
    const url = input["url"];
    if (typeof url === "string") {
      try {
        const parsed = new URL(url);
        // R2 fix: URLs that PARSE but carry no usable authority (file:, data:,
        // about:, mailto:, javascript:, blob: … all yield hostname "") would
        // produce the rule "web_fetch:" — and an empty suffix in ruleMatches
        // matches EVERYTHING. Non-http(s) schemes and empty hostnames record
        // no rule (the tool refuses those at execution anyway).
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        if (host === "") return null;
        return `web_fetch:${host}`;
      } catch {
        return null; // unparseable URL → no session rule (never a blanket one)
      }
    }
    return null; // no url at all → same hole, same closure
  }
  // 夜移 006 (opencode permission/arity): shell records an arity-aware
  // command-prefix rule — never the bare tool (one approval = every command
  // was the old behavior). Compounds record nothing (allow-once only).
  if (toolName === "shell") {
    const cmd = input["command"];
    if (typeof cmd === "string") {
      const rule = commandArityRule(cmd);
      return rule === null ? null : `shell:${rule}`;
    }
  }
  return toolName;
}

/** Map an ask-menu answer to the loop's PermissionDecision. The deny reason
 *  is prefixed "by user:" so the model-visible tool result reads
 *  `permission denied: by user: <reason>` (M33 §1: No 反馈回填). */
export function askAnswerToDecision(answer: AskAnswer): PermissionDecision {
  if (answer.kind !== "deny") return { behavior: "allow" };
  const reason = answer.reason?.trim();
  return reason ? { behavior: "deny", reason: `by user: ${reason}` } : { behavior: "deny", reason: "user denied" };
}

// Security fix — self-escalation via settings write. .wudao/settings.json IS
// the runtime permission policy and .wudao/mcp.json (plus the CC-compat
// project-root .mcp.json, same class of file) configures servers that
// spawn arbitrary local commands: a model able to edit them silently widens
// its own authority (hot reload makes the widening immediate). Writes via
// write_file/edit are therefore bypass-immune: EVERY mode (auto included)
// asks (plain y/N), and NO layer can silence that ask — not the session
// allowlist, not settings allow, and not the M63-A PermissionRequest hook
// either (ω99-21: withPermissionRequestHook's immuneAsk ceiling downgrades a
// hook allow on these calls back to "ask"; see immuneAskCeiling).
// ω99-21: the same immunity covers the HOOK SOURCE trees (.wudao/extensions,
// .wudao/plugins) — planting a hook there is planting future permission
// policy, so it costs a human decision in every mode.
// ω99-22: exported — the /permissions lane (commands/permissions.ts) consumes
// the SAME lists for its immunity guard instead of a hand-copied mirror that
// drifted (.mcp.json / the hook trees were missing there after ω99-21
// widened this side). Export only; the matching logic below is unchanged.
// 安全审计 2026-11 C2（HIGH）：.wudao/settings.local.json 是最高优先级的
// 可克隆层（M62 §3），同样满足本注释的威胁模型——能静默写入它的模型即可
// 塞入 hooks/权限规则并经热加载立即生效；列表此前漏掉了它。
export const PROTECTED_SETTINGS_FILES = [
  ".wudao/settings.json",
  ".wudao/settings.local.json",
  ".wudao/mcp.json",
  ".mcp.json",
] as const;
// ω99-21 — agent-writable hook sources (boot .mjs extensions + plugin roots,
// both the project tree and the user tier: a planted ~/.wudao/plugins hook is
// the worse case — user-scope hooks are not deny-only wrapped). PREFIX
// (segment) matches, unlike the exact-file list above.
export const PROTECTED_HOOK_SOURCE_DIRS = [".wudao/extensions", ".wudao/plugins"] as const;

/** The runtime-policy file this write targets (normalized), or undefined for
 *  non-protected calls. Read tools and shell are not covered: reading
 *  policy is harmless and command redirection is confined elsewhere.
 *  ω99-21: also returns the hook-source TREE (canonical dir string) for
 *  writes anywhere under .wudao/extensions|plugins — segment semantics,
 *  same as the exact-file matches (any depth, absolute or relative). */
export function protectedSettingsFile(toolName: string, input: Record<string, unknown>): string | undefined {
  // ω99-126: the four-name chain consolidated to the class Set (identical
  // membership for the prior names; make_docx joins through the Set).
  if (!FILE_EDIT_TOOLS.has(toolName)) return undefined;
  // ω99-123: make_xlsx carries its write target as `filename`, not `path` —
  // the same hard gate, reading the right key.
  // ω99-124: make_pptx carries it the same way; ω99-126: make_docx too, and
  // the ternary chain is now the FILENAME_KEY_TOOLS lookup below.
  const raw = FILENAME_KEY_TOOLS.has(toolName) ? input["filename"] : input["path"];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const p = normalizePath(raw).toLowerCase();
  for (const f of PROTECTED_SETTINGS_FILES) {
    if (p === f || p.endsWith(`/${f}`)) return f;
  }
  for (const d of PROTECTED_HOOK_SOURCE_DIRS) {
    if (p === d || p.startsWith(`${d}/`) || p.includes(`/${d}/`)) return d;
  }
  return undefined;
}

// 夜移 010 (a reference harness-Py permissions/checker.py:18-200) — credential-material
// detection. OH-Py fnmatch-denies `*/.ssh/*`, `*/.aws/credentials`, `*/.gnupg/*`,
// `*/.kube/config` and its own credential store before mode, surviving even
// --dangerously-skip-permissions. Wudao's tools are workspace-confined
// (resolveWorkspacePath rejects escapes + symlink dodges), so the exposure is
// narrower: a workspace rooted at/under $HOME (then `.ssh/id_rsa` is a legal
// relative read) or credential material copied into the tree (`deploy/.ssh/`).
// The gate therefore matches SEGMENTS anywhere in the path — same semantics as
// OH-Py's `*/dir/*` globs. Deliberate divergence: ASK, not deny (wudao's
// capability≠policy line — a human can approve a legitimate key workflow).
// shell is out of scope by design: substring-matching command text is
// both noisy and trivially bypassed ($HOME, base64, env indirection); the
// path tools are the reliable surface.
const CREDENTIAL_DIR_SEGMENTS = [".ssh", ".gnupg"] as const;
const CREDENTIAL_FILE_SEGMENTS = [".aws/credentials", ".kube/config", ".wudao/.credentials.yaml"] as const;

/** The normalized path when this call touches credential material (SSH/GPG
 *  keyrings, cloud/kube credentials, wudao's own credential store), undefined
 *  otherwise. Directory segments need something UNDER the directory — a file
 *  literally named `.ssh` or prose like `my-ssh-notes` is not key material.
 *  Param-driven: any tool whose input carries a `path` is covered, so grep/
 *  glob picking up a directory param tomorrow needs no change here. */
export function credentialMaterialPath(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "shell") return undefined;
  // ω99-123 fix2: make_xlsx carries its write target as `filename`, not
  // `path` — the same detection, reading the right key.
  // ω99-124: make_pptx carries it the same way; ω99-126: make_docx too, and
  // the ternary chain is now the FILENAME_KEY_TOOLS lookup.
  const raw = FILENAME_KEY_TOOLS.has(toolName) ? input["filename"] : input["path"];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const p = normalizePath(raw).toLowerCase();
  for (const seg of CREDENTIAL_DIR_SEGMENTS) {
    if (p.startsWith(`${seg}/`) || p.includes(`/${seg}/`)) return p;
  }
  for (const f of CREDENTIAL_FILE_SEGMENTS) {
    if (p === f || p.includes(`/${f}`)) return p;
  }
  return undefined;
}

/** 夜移 010: the ask-line warning when the prompted call touches credential
 *  material. Sits in the `warning` slot (ahead of the git-risk note — a key
 *  read outranks it), so the human sees WHAT is being read before y/a/p.
 *  Shared by the REPL gate and the TUI onPermissionAsk (same precedence). */
export function credentialAskWarning(toolName: string, input: Record<string, unknown>): string | undefined {
  const p = credentialMaterialPath(toolName, input);
  return p === undefined ? undefined : `🔐 credential material (${p}) — approve only if this run genuinely needs it`;
}

/** Apply an ask-menu answer at a prompt site: the loop decision plus the
 *  rules to record (null = record nothing). Centralizes the security
 *  invariant "`a`/`p` cannot whitelist a settings write": on a protected
 *  path both answers degrade to allow-ONCE and yield no rule, so the very
 *  next settings write asks again.
 *  0.3.14 #1: `p` (always) additionally yields a persistentRule — the same
 *  rule shape, to be written into the PROJECT tier's allow list
 *  (.wudao/settings.json) via the /permissions write lane. An `always`
 *  answer ALSO returns sessionRule: the session layer covers the gap while
 *  the file write + hot reload land (no re-ask seam), and sessions are
 *  disposable anyway. */
export interface AskAnswerOutcome {
  readonly decision: PermissionDecision;
  readonly sessionRule: string | null;
  readonly persistentRule: string | null;
}

export function applyAskAnswer(answer: AskAnswer, toolName: string, input: Record<string, unknown>): AskAnswerOutcome {
  if (answer.kind === "session" || answer.kind === "always") {
    if (protectedSettingsFile(toolName, input) !== undefined) {
      return { decision: { behavior: "allow" }, sessionRule: null, persistentRule: null };
    }
    const rule = askRuleFor(toolName, input);
    return { decision: { behavior: "allow" }, sessionRule: rule, persistentRule: answer.kind === "always" ? rule : null };
  }
  return { decision: askAnswerToDecision(answer), sessionRule: null, persistentRule: null };
}

/** 夜移 009: the receipt for a session-only rule. Receipt parity with `p`:
 *  the rule text IS the scope the user granted (post-006 meaningfully so —
 *  `shell:git checkout`, not a blanket `shell`), and silence hid
 *  it. English to match the persistAllowRule receipt family. */
export function sessionRuleReceipt(rule: string): string {
  return `permissions: session rule "${rule}" — no more asks this session`;
}

/** 夜移 009: the ONE recording seam every ask site shares (the REPL gate's
 *  stdout lane, the TUI prompt's notify, the session-engine askRelay and
 *  onAskRule sink). Records the session rule into the allowlist and returns
 *  the receipt the user should SEE — non-null only for a session-only rule:
 *  when a persistentRule will also land, its persistAllowRule receipt names
 *  the same rule (double-notify is noise), and the settings-write
 *  degradation (no rule at all) stays silent. */
export function recordAskRules(
  session: { add(rule: string): void },
  rules: { readonly sessionRule: string | null; readonly persistentRule: string | null },
): string | null {
  if (rules.sessionRule === null) return null;
  session.add(rules.sessionRule);
  return rules.persistentRule === null ? sessionRuleReceipt(rules.sessionRule) : null;
}

/** Normalize a path for prefix matching: unify slashes, drop trailing
 *  slashes, and collapse `.`/`..` segments so `src/../.env` cannot dodge a
 *  `deny write_file:.env` rule. A LEADING `..` survives — escaping the
 *  workspace root is the tool layer's confinement job (the outer bound);
 *  rule matching only guarantees equivalence inside the string.
 *  M52 §2: exported for the perms linter (same prefix semantics). */
export function normalizePath(p: string): string {
  const absolute = p.startsWith("/");
  const segments: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!absolute) segments.push("..");
      continue;
    }
    segments.push(seg);
  }
  return (absolute ? "/" : "") + segments.join("/");
}

/** 波次 7 #32: fnmatch-style command glob for `shell:glob:` rules —
 *  `*` matches anything (spaces, slashes, flags), `?` one char, everything
 *  else literal. Anchored full-string match over the RAW command, so
 *  `git push --force*` catches `--force-with-lease` but `rm -rf *` never
 *  catches `rm -r x`. Literal `*`/`?` inside a command glob is not
 *  expressible — that's what plain exact rules are for. */
function commandGlobMatches(pattern: string, command: string): boolean {
  let src = "^";
  for (const ch of pattern) {
    if (ch === "*") src += ".*";
    else if (ch === "?") src += ".";
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${src}$`).test(command);
}

/** Match a `tool` / `tool:path-prefix` rule against a call. A path rule hits
 *  when the call's `path` equals the prefix or lives under it as a directory
 *  prefix. A command-bearing call (shell) matches the rule suffix as a
 *  token-boundary command prefix instead — `shell:rm` catches
 *  `rm -rf x` but never `rmlint`. M59: a url-bearing call (web_fetch) matches
 *  the rule suffix as an exact HOST. 波次 7 #32: a `tool:glob:<pattern>`
 *  suffix is a glob rule — the pattern matches paths in the workspace glob
 *  dialect and the raw command string fnmatch-style. Calls with neither a
 *  usable path, url, nor command never match a scoped rule. */
export function ruleMatches(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  const trimmed = rule.trim();
  const colon = trimmed.indexOf(":");
  const tool = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const suffix = colon === -1 ? undefined : trimmed.slice(colon + 1);
  if (tool === "") return false;
  if (tool !== toolName) return false;
  if (suffix === undefined || suffix === "") return true;
  // 波次 7 #32 (OH A1+A2+A3): explicit `glob:` suffix — opt-in glob rules.
  // Plain suffixes below keep byte-identical semantics; a literal `*` in a
  // 夜移006 exact command rule can never silently widen into a wildcard.
  if (suffix.startsWith("glob:")) {
    const pattern = suffix.slice("glob:".length).trim();
    if (pattern === "") return false;
    const rawPath = input["path"];
    if (typeof rawPath === "string" && rawPath.trim() !== "") {
      // Workspace glob dialect — the SAME matcher as the glob tool and
      // rules.ts (M62: one dialect, no second grammar): `*` stays in one
      // segment, `**` crosses `/`, `?` is one char. Tested in four shapes
      // so one pattern covers absolute AND relative spellings, plus the
      // trailing-slash twin (normalizePath drops it, so a directory-root
      // argument like `/repo/.ssh` would otherwise miss `**/.ssh/**`).
      const p = normalizePath(rawPath);
      const anchored = p.startsWith("/") ? p : `/${p}`;
      const re = globToRegex(pattern);
      if (re.test(p) || re.test(`${p}/`) || re.test(anchored) || re.test(`${anchored}/`)) return true;
    }
    const rawCmd = input["command"];
    if (typeof rawCmd === "string" && rawCmd.trim() !== "") {
      // Command lane: fnmatch-style over the raw string — `*` spans spaces
      // and slashes (the path dialect's `[^/]*` would never match an
      // argument containing a `/`).
      if (commandGlobMatches(pattern, rawCmd)) return true;
    }
    return false;
  }
  const raw = input["path"];
  if (typeof raw === "string" && raw.trim() !== "") {
    const p = normalizePath(raw);
    const prefix = normalizePath(suffix);
    if (p === prefix || p.startsWith(`${prefix}/`)) return true;
  }
  // URL lane (M59, web_fetch): the suffix is the approved HOST — exact match
  // only (an `a` on api.github.com never covers github.com; the wider
  // *.suffix scope is web.allowDomains' job).
  const url = input["url"];
  if (typeof url === "string" && url.trim() !== "") {
    try {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (host !== "" && host === suffix.trim().toLowerCase()) return true;
    } catch {
      // unparseable URL matches nothing
    }
  }
  // Command lane (shell): the suffix is a command prefix — every rule
  // token must equal the command's first tokens. 夜移 006: both sides share
  // commandHeadTokens (quote-aware compound check + leading VAR= stripping)
  // so a rule generated by an approval always round-trips. A COMPOUND
  // command (unquoted ; | & …) matches no prefix rule at all: its second
  // pipeline segment was never approved.
  // 安全审计 2026-11 C6 —— 扩权 flag 降级：命令 token 含 --force/-D/
  // --hard/--privileged… 时族级前缀规则不再放行（批准 `git push origin
  // main` 记下的 shell:git push 不得静默覆盖 `git push --force`）——前缀
  // lane 跳过，只有整条相等（或操作者显式 glob: 规则）可命中。
  const cmd = input["command"];
  if (typeof cmd === "string" && cmd.trim() !== "") {
    const cmdHead = commandHeadTokens(cmd);
    const ruleHead = commandHeadTokens(suffix.trim());
    const escalated = cmdHead !== null && (headHasEscalationFlags(cmdHead) || isEnvLauncherHead(cmdHead));
    if (!escalated && cmdHead !== null && ruleHead !== null) {
      if (ruleHead.length <= cmdHead.length && ruleHead.every((t, i) => t === cmdHead[i])) return true;
    } else if (cmd.trim().split(/\s+/).join(" ") === suffix.trim().split(/\s+/).join(" ")) {
      // Degraded lanes: compound rule text (a hand-written settings rule
      // containing operators) or compound command — exact whitespace-
      // collapsed equality only, never a prefix. C6: escalated commands
      // land here too (only the byte-same command re-allows).
      return true;
    }
    return false;
  }
  return false;
}

/** In-memory session allowlist fed by `a` answers. Ephemeral by design —
 *  cross-session persistence lives in .wudao/settings.json. ω99-73: clear()
 *  is the /clear seam — the session boundary empties the in-memory set (the
 *  `p` persistent tier is untouched; that is the whole distinction). */
export interface SessionAllowlist {
  matches(toolName: string, input: Record<string, unknown>): boolean;
  add(rule: string): void;
  rules(): readonly string[];
  clear(): void;
}

// ω99-112 — the browser submission-class actions. A click (and a
// browser_type with submit:true — submit is a PARAMETER, not a tool name, so
// the probe looks at the input) can submit a form, place an order, or post
// publicly: by default the human rules on the 109 pet confirmation card
// (core's PermissionDecision cannot express "ask", so the posture lives HERE,
// in the rich layer). An `a`/`p` answer (session or settings allow) recorded
// earlier pre-approves — the rules run BEFORE this layer, so approval never
// nags twice. Reads (snapshot/scroll), navigation (open), and close never
// touch this set.
// ω99-139: browser_click_xy joins whole-tool-class — its fallback layer
// (canvas / an unrecognized target) must ALWAYS ask: one extra confirmation
// beats an open lane for clicks we cannot classify. The hit layer asking too
// is an accepted over-strictness (no parameter split — simple first).
// ω99-140: browser_type_xy joins the same whole-tool-class — typing is even
// higher-stakes than clicking (it injects CONTENT), and its miss layer cannot
// classify the target field at all; the 139 ruling carries over verbatim.
// ω99-212: the computer ACTION quartet joins whole-tool-class — physical
// keystroke/key-combo/click/app-switch on the USER's machine is the highest-
// stakes surface wudao has (it types into and clicks OTHER applications, not
// a controlled browser profile): the human confirms each action by default,
// every mode included (an `a`/`p` rule above still pre-approves). The two
// read faces (screen_capture / app_list) stay OUT — they follow the ordinary
// mode tiers like browser_see/browser_snapshot (auto allows, workspace asks,
// plan's read-only fence denies as non-READ_TOOLS).
// ω99-220: #4 — the two new hands join the same whole-tool-class:
// computer_scroll moves the user's viewport inside whatever app holds the
// cursor, and computer_drag physically relocates things (a Finder drop IS a
// file move). Same ask posture as the quartet, every mode included.
// ω99-226 产品裁定（0.3.59 验装回执第三报）：本集的全档问收窄为「非 auto
// 档问」——4.68 层守卫加 mode!=="auto"，auto 档九名 + submit 探针面跟随
// 档位落内建模式放行，sidecar 逐动作照审（裁定全文见 4.68 注记）。212/220
// 段的「every mode included」措辞自此被推翻；集合与探针本身零改动。
export const DEFAULT_ASK_TOOLS: ReadonlySet<string> = new Set([
  "browser_click", "browser_click_xy", "browser_type_xy",
  "computer_type", "computer_key", "computer_click", "app_activate",
  "computer_scroll", "computer_drag",
]);

/** Pure probe: does this call fall in the browser default-ask class? */
export function isDefaultAskCall(toolName: string, input: Record<string, unknown>): boolean {
  if (DEFAULT_ASK_TOOLS.has(toolName)) return true;
  return toolName === "browser_type" && input["submit"] === true;
}

export function createSessionAllowlist(): SessionAllowlist {
  const rules = new Set<string>();
  return {
    matches: (toolName, input) => {
      for (const r of rules) if (ruleMatches(r, toolName, input)) return true;
      return false;
    },
    add: (rule) => {
      rules.add(rule.trim());
    },
    rules: () => [...rules],
    clear: () => {
      rules.clear();
    },
  };
}
