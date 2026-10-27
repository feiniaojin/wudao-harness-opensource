// Zero-dependency syntax highlighting for fenced code blocks. Why custom:
// highlight.js is ~1MB for the languages we never see, and the TUI itself
// highlights per-line (cli-highlight) with the same tradeoffs — our contract
// is "fenced blocks look like code", not editor-grade parsing. One
// regex-driven tokenizer, one keyword table per language family, per-line
// (so multi-line strings/comments are imperfect, exactly like the TUI).
// Unknown languages and plain fences fall through to the ok-colored mono
// text the TUI uses.
// SQL/HTML/CSS 三族为专用单行 tokenizer（形状不合通用 LangSpec——HTML 无关键词、
// CSS 行位置敏感、SQL 大小写不敏感 + '' 转义 + 行内块注释）。

export interface Token {
  text: string;
  cls?: "tok-key" | "tok-str" | "tok-com" | "tok-num" | "tok-fn";
}

interface LangSpec {
  lineComment: string[];
  keywords: readonly string[];
}

const CLIKE = [
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "switch", "case", "break", "continue", "new", "class", "extends", "implements",
  "interface", "type", "enum", "import", "from", "export", "default", "as", "async",
  "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of",
  "this", "super", "static", "public", "private", "protected", "readonly", "get",
  "set", "yield", "void", "null", "undefined", "true", "false", "struct", "impl",
  "fn", "pub", "mut", "match", "package", "defer", "go", "chan", "select", "map",
  "nil", "string", "number", "boolean", "any", "unknown", "never",
];

const SHELL = [
  "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until",
  "case", "esac", "function", "return", "export", "local", "source", "alias",
  "echo", "cd", "ls", "cat", "grep", "sed", "awk", "mkdir", "rm", "cp", "mv",
  "chmod", "sudo", "apt", "brew", "npm", "pnpm", "yarn", "git", "curl", "wget",
  "set", "unset", "shift", "test", "exit",
];

const PYTHON = [
  "def", "class", "return", "if", "elif", "else", "for", "while", "break",
  "continue", "import", "from", "as", "with", "try", "except", "finally",
  "raise", "yield", "lambda", "pass", "global", "nonlocal", "assert", "del",
  "in", "is", "not", "and", "or", "None", "True", "False", "self", "async",
  "await", "print", "len", "range", "str", "int", "float", "list", "dict",
];

const LANGS: Record<string, LangSpec> = {
  clike: { lineComment: ["//"], keywords: CLIKE },
  shell: { lineComment: ["#"], keywords: SHELL },
  python: { lineComment: ["#"], keywords: PYTHON },
};

type Family = keyof typeof LANGS | "sql" | "html" | "css";

const LANG_FAMILY: Record<string, Family | undefined> = {
  ts: "clike", tsx: "clike", typescript: "clike", js: "clike", jsx: "clike",
  javascript: "clike", mjs: "clike", cjs: "clike", json: undefined, jsonc: "clike",
  go: "clike", rust: "clike", rs: "clike", java: "clike", c: "clike", h: "clike",
  cpp: "clike", "c++": "clike", cs: "clike", csharp: "clike", kotlin: "clike",
  swift: "clike", dart: "clike", scala: "clike",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell",
  fish: "shell", dockerfile: "shell", makefile: "shell", make: "shell",
  py: "python", python: "python", python3: "python",
  yaml: "shell", yml: "shell", toml: "shell", ini: "shell", conf: "shell",
  rb: "python", ruby: "python", lua: "python", r: "python", perl: "python",
  // 高亮 spec §2 —— 三族新映射 + clike 增补：
  sql: "sql", psql: "sql", mysql: "sql",
  htm: "html", html: "html", xml: "html", svg: "html", vue: "html",
  css: "css", scss: "css", less: "css",
  php: "clike", m: "clike", mm: "clike", hpp: "clike", cc: "clike", hh: "clike",
};

/** Tokenize one code line. Known language → classified spans; otherwise a
 *  single plain token (the caller styles it as code). JSON gets a light
 *  treatment (strings + numbers) — keys-as-strings is close enough. */
export function highlightLine(line: string, lang: string | undefined): Token[] {
  const family = lang !== undefined ? LANG_FAMILY[lang.toLowerCase()] : undefined;
  // 高亮 spec §2: 三族专用 tokenizer（形状不合通用 LangSpec——HTML 无关键词、
  // CSS 行位置敏感、SQL 大小写不敏感 + '' 转义 + 行内块注释）。
  if (family === "html") return tokenizeHtml(line);
  if (family === "css") return tokenizeCss(line);
  if (family === "sql") return tokenizeSql(line);
  const spec = family === undefined ? undefined : LANGS[family as keyof typeof LANGS];
  if (spec === undefined) {
    // JSON and unknown languages: strings + numbers only (# lines in yaml
    // already route to the shell family above).
    return classify(line, { lineComment: [], keywords: [] });
  }
  return classify(line, spec);
}

/** 路径派生语言：小写末段扩展名（无/点开头/尾点 → undefined）。
 *  LANG_FAMILY 同一张表既吃围栏语言名也吃扩展名——一处派生两处用。 */
export function languageFromPath(path: string): string | undefined {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

function classify(line: string, spec: LangSpec): Token[] {
  if (line === "") return [];
  const commentIdx = firstComment(line, spec.lineComment);
  const codePart = commentIdx === -1 ? line : line.slice(0, commentIdx);
  const tokens = tokenizeCode(codePart, spec);
  if (commentIdx !== -1) tokens.push({ text: line.slice(commentIdx), cls: "tok-com" });
  return tokens;
}

// A comment marker only counts OUTSIDE strings — scan left to right tracking
// quote state, then report the first marker position (or -1).
function firstComment(line: string, markers: string[]): number {
  if (markers.length === 0) return -1;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    for (const m of markers) {
      if (line.startsWith(m, i)) return i;
    }
  }
  return -1;
}

const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/;
const NUMBER = /\d[\d._xXa-fA-F]*/;
const CALL = /([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=\()/;

function tokenizeCode(code: string, spec: LangSpec): Token[] {
  const out: Token[] = [];
  let i = 0;
  let plain = "";
  const flush = (): void => {
    if (plain !== "") {
      out.push({ text: plain });
      plain = "";
    }
  };
  while (i < code.length) {
    const ch = code[i] ?? "";
    // Strings (no escapes across lines — per-line contract).
    if (ch === "\"" || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < code.length && (code[j] ?? "") !== ch) {
        if ((code[j] ?? "") === "\\") j++;
        j++;
      }
      flush();
      out.push({ text: code.slice(i, Math.min(j + 1, code.length)), cls: "tok-str" });
      i = j + 1;
      continue;
    }
    // Numbers.
    if (/[0-9]/.test(ch)) {
      const m = NUMBER.exec(code.slice(i));
      if (m !== null) {
        flush();
        out.push({ text: m[0], cls: "tok-num" });
        i += m[0].length;
        continue;
      }
    }
    // Words: keyword, or a call position → function color.
    if (/[A-Za-z_$]/.test(ch)) {
      const rest = code.slice(i);
      const w = WORD.exec(rest)?.[0];
      if (w !== undefined) {
        if (spec.keywords.includes(w)) {
          flush();
          out.push({ text: w, cls: "tok-key" });
        } else if (CALL.test(rest) && CALL.exec(rest)?.[1] === w) {
          flush();
          out.push({ text: w, cls: "tok-fn" });
        } else {
          plain += w;
        }
        i += w.length;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

// ---- 高亮 spec §2: 三族专用单行 tokenizer（同 per-line 合同：跨行结构近似）----

const SQL_KEYWORDS = [
  "select", "from", "where", "join", "left", "right", "inner", "outer", "full",
  "cross", "on", "group", "order", "by", "having", "limit", "offset", "insert",
  "into", "values", "update", "set", "delete", "create", "table", "index",
  "view", "drop", "alter", "add", "column", "primary", "foreign", "key",
  "references", "unique", "null", "not", "default", "as", "and", "or", "in",
  "between", "like", "is", "exists", "case", "when", "then", "else", "end",
  "union", "all", "distinct", "asc", "desc", "with", "returning", "conflict",
  "do", "nothing",
];

function tokenizeSql(line: string): Token[] {
  if (line === "") return [];
  const out: Token[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") { out.push({ text: plain }); plain = ""; }
  };
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith("--")) { flush(); out.push({ text: rest, cls: "tok-com" }); break; }
    if (rest.startsWith("/*")) {
      const close = rest.indexOf("*/", 2);
      const end = close === -1 ? rest.length : close + 2;
      flush(); out.push({ text: rest.slice(0, end), cls: "tok-com" }); i += end; continue;
    }
    const ch = rest[0] ?? "";
    if (ch === "'") {
      let j = 1;
      while (j < rest.length) {
        if (rest[j] === "'") {
          if (rest[j + 1] === "'") { j += 2; continue; } // '' 转义
          j += 1; break;
        }
        j += 1;
      }
      const end = Math.min(j, rest.length);
      flush(); out.push({ text: rest.slice(0, end), cls: "tok-str" }); i += end; continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = NUMBER.exec(rest);
      if (m !== null) { flush(); out.push({ text: m[0], cls: "tok-num" }); i += m[0].length; continue; }
    }
    if (/[A-Za-z_]/.test(ch)) {
      const w = WORD.exec(rest)?.[0];
      if (w !== undefined) {
        if (SQL_KEYWORDS.includes(w.toLowerCase())) { flush(); out.push({ text: w, cls: "tok-key" }); }
        else if (CALL.test(rest) && CALL.exec(rest)?.[1] === w) { flush(); out.push({ text: w, cls: "tok-fn" }); }
        else plain += w;
        i += w.length; continue;
      }
    }
    plain += ch; i += 1;
  }
  flush();
  return out;
}

function tokenizeHtml(line: string): Token[] {
  if (line === "") return [];
  const out: Token[] = [];
  let plain = "";
  let inTag = false;
  const flush = (): void => {
    if (plain !== "") { out.push({ text: plain }); plain = ""; }
  };
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    if (!inTag && rest.startsWith("<!--")) {
      const close = rest.indexOf("-->", 4);
      const end = close === -1 ? rest.length : close + 3;
      flush(); out.push({ text: rest.slice(0, end), cls: "tok-com" }); i += end; continue;
    }
    if (!inTag && (rest[0] ?? "") === "<") {
      inTag = true;
      const m = /^<[A-Za-z][\w:.-]*/.exec(rest) || /^<\/[A-Za-z][\w:.-]*>/.exec(rest);
      if (m !== null) { flush(); out.push({ text: m[0], cls: "tok-key" }); i += m[0].length; continue; }
      flush(); out.push({ text: "<", cls: "tok-key" }); i += 1; continue;
    }
    if (inTag) {
      const ch = rest[0] ?? "";
      if (ch === ">") { inTag = false; flush(); out.push({ text: ">", cls: "tok-key" }); i += 1; continue; }
      if (ch === "\"" || ch === "'") {
        let j = 1;
        while (j < rest.length && rest[j] !== ch) j += 1;
        const end = Math.min(j + 1, rest.length);
        flush(); out.push({ text: rest.slice(0, end), cls: "tok-str" }); i += end; continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        const w = /^[A-Za-z_][\w:.-]*/.exec(rest)?.[0];
        if (w !== undefined) { flush(); out.push({ text: w, cls: "tok-fn" }); i += w.length; continue; }
      }
      plain += ch; i += 1; continue;
    }
    if ((rest[0] ?? "") === "&") {
      const m = /^&[A-Za-z][A-Za-z\d]{0,10};/.exec(rest) ?? /^&#\d{1,7};/.exec(rest);
      if (m !== null) { flush(); out.push({ text: m[0], cls: "tok-num" }); i += m[0].length; continue; }
    }
    plain += rest[0] ?? ""; i += 1;
  }
  if (plain !== "") out.push({ text: plain });
  return out;
}

// CSS 行位置启发（per-line）：第一个 { 之前的整段是选择器/指令（tok-key）；
// 其后及无 brace 行按「属性: 值」扫描——属性 tok-fn，值内字符串/数字/hex/$var
// 着色。跨行选择器近似为纯文本（合同内）。
function tokenizeCss(line: string): Token[] {
  if (line === "") return [];
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith("/*")) {
      const close = rest.indexOf("*/", 2);
      const end = close === -1 ? rest.length : close + 2;
      out.push({ text: rest.slice(0, end), cls: "tok-com" }); i += end; continue;
    }
    const brace = rest.indexOf("{");
    if (brace > -1) {
      let head = rest.slice(0, brace);
      if (head === "") {
        // 行首即 brace（上一行的选择器续接）——无 head 段。
      } else if (head.trim() === "") {
        out.push({ text: head }); // 纯空白 head 不着色
      } else {
        // @directive: split first word from args (e.g. "@media (max-width: ..." → "@media " + " (max-width: ...")
        if (head[0] === "@") {
          const m = /^(@[\w-]+)(\s*)/.exec(head);
          if (m !== null) {
            out.push({ text: m[1] + (m[2] ?? ""), cls: "tok-key" });
            const args = head.slice(m[0].length);
            if (args !== "") out.push({ text: args });
          } else {
            out.push({ text: head, cls: "tok-key" });
          }
        } else {
          out.push({ text: head, cls: "tok-key" }); // 选择器整段
        }
      }
      out.push({ text: "{" }); i += brace + 1; continue;
    }
    out.push(...cssPropValue(rest));
    i = line.length;
  }
  return out;
}

function cssPropValue(run: string): Token[] {
  const out: Token[] = [];
  const head = /^(\s*)([-\w]+)(\s*:)/.exec(run);
  let i = 0;
  if (head !== null) {
    out.push({ text: head[1] ?? "" });
    out.push({ text: head[2] ?? "", cls: "tok-fn" });
    out.push({ text: head[3] ?? "" });
    i = head[0]?.length ?? 0;
  }
  const v = run.slice(i);
  let j = 0;
  let plain = "";
  const flush = (): void => {
    if (plain !== "") { out.push({ text: plain }); plain = ""; }
  };
  while (j < v.length) {
    const rest = v.slice(j);
    const ch = rest[0] ?? "";
    if (ch === "\"" || ch === "'") {
      let k = 1;
      while (k < rest.length && rest[k] !== ch) k += 1;
      const end = Math.min(k + 1, rest.length);
      flush(); out.push({ text: rest.slice(0, end), cls: "tok-str" }); j += end; continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = NUMBER.exec(rest);
      if (m !== null) { flush(); out.push({ text: m[0], cls: "tok-num" }); j += m[0].length; continue; }
    }
    if (ch === "#" || ch === "$" || ch === "@") {
      const m = /^[$@]?[-\w]+/.exec(rest.slice(1));
      if (m !== null) { flush(); out.push({ text: ch + m[0], cls: "tok-num" }); j += 1 + m[0].length; continue; }
    }
    plain += ch; j += 1;
  }
  flush();
  return out;
}
