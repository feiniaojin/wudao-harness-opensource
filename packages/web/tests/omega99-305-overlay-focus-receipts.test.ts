// ω99-305 (弹层 Esc 可达性) — the overlay family's focus-ownership census,
// the source-level gate that lives beside a11y-names' button census. The
// family idiom: a modal-card is a `role="dialog"` whose Esc rides an
// ELEMENT-LEVEL onKeyDown — that handler only fires while focus is INSIDE
// the dialog, so every card pulls focus on open (ref + tabIndex={-1} +
// a focus effect; AskUserCards' variant focuses the input INSIDE the card,
// which is the stronger form — its tabIndex is the fallback). Without the
// pull, opening from a trigger leaves focus under the scrim and Esc is
// dead — the exact gap this arc closed in PersonaPanel's and ProviderTab's
// pvd dialogs (aria-modal="true" was declared but nothing owned focus).
//
// The scanner is the same quote- AND brace-aware shape a11y-names pinned:
// `>` only closes the opening tag at brace depth 0 outside quotes, so an
// arrow-function attr (`onClick={() => go()}`) can't truncate the tag and
// hide the attrs behind it.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface TagSite {
  file: string;
  line: number;
  tag: string;
}

/** Quote- and brace-aware opening-tag scan for one element name. */
function scanDivs(src: string, file: string): TagSite[] {
  const sites: TagSite[] = [];
  const open = "<div";
  let pos = src.indexOf(open);
  while (pos >= 0) {
    const after = src[pos + open.length] as string;
    if (after === " " || after === ">" || after === "\n" || after === "\t") {
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
      const line = src.slice(0, pos).split("\n").length;
      sites.push({ file, line, tag });
      pos = src.indexOf(open, i + 1);
    } else {
      pos = src.indexOf(open, pos + 1);
    }
  }
  return sites;
}

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
const contents = new Map(files.map((f) => [f, readFileSync(f, "utf8")] as const));
// The overlay family: every real modal-card opening tag (comments don't
// parse as tags, so the mentions in prose never land here).
const cards = files
  .flatMap((f) => scanDivs(contents.get(f) as string, f.split("/").pop() as string))
  .filter((s) => /className="[^"]*modal-card/.test(s.tag));

describe("ω99-305 — the overlay family owns focus (source census)", () => {
  it("the corpus is real: the family's modal-cards are all seen", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(cards.length).toBeGreaterThanOrEqual(9);
  });

  it("every modal-card carries tabIndex (the focus-pull mount point)", () => {
    const gaps = cards.filter((c) => !/tabIndex=/.test(c.tag)).map((c) => `${c.file}:${c.line}`);
    expect(gaps, `modal-cards without tabIndex:\n${gaps.join("\n")}`).toEqual([]);
  });

  it("every modal-card's file has a focus mechanism (.focus() on open)", () => {
    const filesWithCards = [...new Set(cards.map((c) => c.file))];
    const silent = filesWithCards.filter((name) => {
      const f = files.find((x) => x.endsWith(`/${name}`)) as string;
      return !/\.focus\(\)/.test(contents.get(f) as string);
    });
    expect(silent, `dialog files with no focus pull:\n${silent.join("\n")}`).toEqual([]);
  });

  // The two arcs this closed keep their adjudication comments — deleting
  // the idiom should fail here, not just in behavior.
  it("the pvd dialogs carry their ω99-305 focus-pull comment", () => {
    const persona = contents.get(files.find((f) => f.endsWith("PersonaPanel.tsx")) as string) as string;
    const provider = contents.get(files.find((f) => f.endsWith("ProviderTab.tsx")) as string) as string;
    expect(persona).toContain("ω99-305: the family focus-pull");
    expect(provider).toContain("ω99-305: the family focus-pull");
  });
});
