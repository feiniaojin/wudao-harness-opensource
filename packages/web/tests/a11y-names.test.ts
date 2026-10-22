// a11y-names — ω99-304 (a11y 交互走查): the interactive-name census as a
// permanent gate. The arc's three audit axes: (A) the focus regime — the
// global :focus-visible ring + documented suppressions (the two last
// undocumented ones get adjudication comments in styles.css, pinned below);
// (B) button accessible names — every <button> carries aria-label/title OR
// renders text (an icon-only button with no name is silent to screen
// readers); (C) role="button" divs are keyboard-complete (tabIndex +
// Enter/Space — the ui-review-r1 I3 / M76-ux2 / ω99-297 contract).
//
// The scanner is the hard-won part: a quote-only scanner truncates opening
// tags at the `>` of every arrow function (`onClick={() => go()}`), so an
// aria-label sitting AFTER an arrow attr turns invisible and the attr's
// remainder leaks into the children as fake "text". This one is quote- AND
// brace-aware — `>` only closes the tag at brace depth 0 outside quotes —
// and the fixture block below pins exactly that regression. Children are
// text-bearing when, after stripping Icon components, JSX comments and
// remaining tags, any string literal, letter, or Han character remains
// (dynamic `{expr}` children count: `{c.label}` renders text at runtime —
// a source scan cannot see an empty string, the documented boundary).
import { describe, expect, it } from "vitest";
import { readStyles } from "./styles-source.js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface TagSite {
  file: string;
  line: number;
  tag: string; // the full opening tag, attrs and handler bodies included
  kids: string; // source between the opening tag and </button> (buttons only)
}

/** Quote- and brace-aware opening-tag scan for one element name. */
function scanTags(src: string, file: string, tagName: string): TagSite[] {
  const sites: TagSite[] = [];
  const open = `<${tagName}`;
  let pos = src.indexOf(open);
  while (pos >= 0) {
    const after = src[pos + open.length] as string;
    // `<button` must end the name (whitespace or `>`), not prefix `<buttonx`.
    if (after === " " || after === ">" || after === "\n" || after === "\t" || after === "/") {
      let i = pos + open.length;
      let quote: string | null = null;
      let depth = 0;
      let tag = "";
      while (i < src.length) {
        const ch = src[i] as string;
        if (quote !== null) {
          tag += ch;
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
          tag += ch;
        } else if (ch === "{") {
          depth++;
          tag += ch;
        } else if (ch === "}") {
          depth--;
          tag += ch;
        } else if (ch === ">" && depth === 0) {
          break;
        } else {
          tag += ch;
        }
        i++;
      }
      const close = `</${tagName}>`;
      const end = src.indexOf(close, i);
      const kids = end > 0 ? src.slice(i + 1, end) : "";
      const line = src.slice(0, pos).split("\n").length;
      sites.push({ file, line, tag, kids });
      pos = src.indexOf(open, i + 1);
    } else {
      pos = src.indexOf(open, pos + 1);
    }
  }
  return sites;
}

const NAMED = /(?:^|\s)(?:aria-label|title|aria-hidden)=/;

/** Do the children render text (an accessible name) after decorations? */
function rendersText(kids: string): boolean {
  let text = kids.replace(/\{\/\*[\s\S]*?\*\/\}/g, ""); // JSX comments
  text = text.replace(/<Icon[A-Za-z0-9]*[\s\S]*?\/>/g, ""); // icon components
  text = text.replace(/<\/?[A-Za-z][^>]*>/g, ""); // remaining tags
  return /["'`]|[A-Za-z]|\p{Script=Han}/u.test(text);
}

// The live corpus: every .tsx under src (pet world included — its buttons
// are text-bearing too: 允许/拒绝/查看全文).
function walkTsx(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walkTsx(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
const files = walkTsx(srcRoot);
const buttons = files.flatMap((f) => scanTags(readFileSync(f, "utf8"), f.split("/").pop() as string, "button"));
// role="button" rides divs (rows, retry lanes) AND spans (FileViewer crumbs).
const roleButtons = ["div", "span"].flatMap((el) =>
  files.flatMap((f) => scanTags(readFileSync(f, "utf8"), f.split("/").pop() as string, el)).filter((s) => /\brole="button"/.test(s.tag)),
);

describe("ω99-304 — a11y interactive names (source census)", () => {
  it("the corpus is real: the scanner sees the app's buttons (not silence)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(buttons.length).toBeGreaterThan(100);
    expect(roleButtons.length).toBeGreaterThanOrEqual(6);
  });

  it("every <button> has a name: aria-label, title, or rendered text", () => {
    const silent = buttons
      .filter((b) => !NAMED.test(b.tag) && !rendersText(b.kids))
      .map((b) => `${b.file}:${b.line}`);
    expect(silent, `unnamed icon-only buttons:\n${silent.join("\n")}`).toEqual([]);
  });

  it("every role=\"button\" div is keyboard-complete: tabIndex + onKeyDown Enter/Space", () => {
    const gaps = roleButtons
      .filter((b) => !/tabIndex=/.test(b.tag) || !/onKeyDown=/.test(b.tag) || !(b.tag.includes('"Enter"') || b.tag.includes('" "')))
      .map((b) => `${b.file}:${b.line}`);
    expect(gaps, `mouse-only role=button divs:\n${gaps.join("\n")}`).toEqual([]);
  });

  // ω99-304 axis A: the last two outline suppressions get their adjudication
  // inline — a future deletion of either comment should fail here, the same
  // way ui-sweep pins its regime comments.
  it("the two deliberate outline suppressions carry their adjudication comments", () => {
    const css = readStyles();
    // .editor-ta: full-pane typing surface — the caret is the indicator.
    expect(css).toContain("outline: none; /* ω99-304: deliberate — the code editor is a full-pane typing");
    // .composer-ta: the composer card's focus-within accent border is the
    // single indicator (the ui-review-r2 P2 carve-out keeps the ring off).
    expect(css).toContain("outline: 0; /* ω99-304: the composer card's :focus-within accent border");
  });
});

describe("ω99-304 — the scanner itself (regression fixtures)", () => {
  it("flags an unnamed icon-only button", () => {
    const src = `const a = <button type="button" onClick={() => go()}><IconX size={12} /></button>;`;
    const site = scanTags(src, "f.tsx", "button")[0];
    if (site === undefined) throw new Error("scanner found no button in fixture");
    expect(NAMED.test(site.tag)).toBe(false);
    expect(rendersText(site.kids)).toBe(false);
  });

  it("sees aria-label AFTER an arrow-function attr (the truncation regression)", () => {
    const src = `const a = <button type="button" onClick={() => go()} aria-label="发送"><IconX size={12} /></button>;`;
    const site = scanTags(src, "f.tsx", "button")[0];
    if (site === undefined) throw new Error("scanner found no button in fixture");
    expect(NAMED.test(site.tag)).toBe(true);
  });

  it("string-literal and dynamic children render text; JSX comments do not", () => {
    expect(rendersText(`{"添加"}`)).toBe(true);
    expect(rendersText(`{cond ? "收起 ▴" : \`展开\`}`)).toBe(true);
    expect(rendersText(`{c.label}`)).toBe(true);
    expect(rendersText(`<span>新对话</span>`)).toBe(true);
    expect(rendersText(`<IconPlus size={13} /> {/* ω99-152: just a note */}`)).toBe(false);
  });

  it("flags a role=button div missing keys (and passes a complete one)", () => {
    const bad = scanTags(`const d = <div role="button" onClick={go()}>x</div>;`, "f.tsx", "div").find((s) =>
      /\brole="button"/.test(s.tag),
    );
    expect(bad).toBeDefined();
    expect(bad?.tag).not.toMatch(/tabIndex=/);
    const good = scanTags(
      `const d = <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } }}>x</div>;`,
      "f.tsx",
      "div",
    ).find((s) => /\brole="button"/.test(s.tag));
    expect(good?.tag).toMatch(/tabIndex=/);
    expect(good?.tag).toContain('"Enter"');
  });
});
