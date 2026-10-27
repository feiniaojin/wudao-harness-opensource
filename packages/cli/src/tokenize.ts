// M49 §3/§1 — the shared text tokenizer: word-runs for latin, bigrams for
// CJK. One implementation so the session search index (BM25-lite postings)
// and the memory write-assessment (Jaccard novelty) segment text identically.
// Pure, zero deps.

// CJK ideographs + extension A (the 一-鿿 range the rest of the CLI already
// uses, e.g. session-name derivation) + common CJK punctuation strips out as
// separators via the complement class below.
const CJK_CHAR = /[㐀-䶿一-鿿]/;

function isCjk(code: number): boolean {
  return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff);
}

/** Latin/digit word runs (lowercased, length ≥ 2 — single letters are index
 *  noise). CJK runs become their consecutive bigrams (a single-char run stays
 *  that char). Everything else separates. */
export function tokenizeText(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  const n = lower.length;
  let i = 0;
  while (i < n) {
    const code = lower.charCodeAt(i);
    if (isCjk(code)) {
      // Consume the full CJK run, emit its bigrams (unigram for length 1).
      const start = i;
      while (i < n && isCjk(lower.charCodeAt(i))) i += 1;
      const run = lower.slice(start, i);
      if (run.length === 1) out.push(run);
      else for (let j = 0; j + 1 < run.length; j += 1) out.push(run.slice(j, j + 2));
      continue;
    }
    if (/[a-z0-9]/.test(lower[i]!)) {
      const start = i;
      while (i < n && /[a-z0-9_-]/.test(lower[i]!)) i += 1;
      const word = lower.slice(start, i).replace(/[_-]+$/, "");
      if (word.length >= 2) out.push(word);
      continue;
    }
    i += 1;
  }
  return out;
}

/** True when the string contains at least one CJK ideograph. */
export function hasCjk(text: string): boolean {
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) return true;
  }
  return false;
}

/** The token SET (deduped) — the Jaccard/overlap face of tokenizeText. */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenizeText(text));
}

/** |A ∩ B| / |A ∪ B| — 0 when both sets are empty (nothing shared, nothing
 *  to call similar). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}
