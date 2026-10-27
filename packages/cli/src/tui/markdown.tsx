// Minimal markdown renderer for Ink — headings, fenced code (cli-highlight),
// inline code, bold, lists, blockquotes, paragraphs. Deliberately small:
// renders assistant FINAL messages only (deltas stream as plain text).
import React from "react";
import { Box, Text } from "ink";
import { highlight } from "cli-highlight";
import { render as renderMermaid } from "grok-mermaid";
import { T } from "./theme.js";

type Block =
  | { kind: "code"; lang?: string; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "para"; lines: string[] };

// ```mermaid blocks are rendered as terminal ASCII art via grok-mermaid
// (sync, local, zero deps). On any failure — render() returns null for bad
// syntax / unsupported diagram kinds, and the try/catch guards a throw —
// the block degrades to the verbatim source, never crashing the renderer.
// grok-mermaid 0.2.3 takes no width option (verified: render(src) only);
// it lays out at natural size and reports art.width, which we pass through.
// The replacement and fallback blocks carry no lang: cli-highlight throws
// "Unknown language" on unrecognized langs, which Ink swallows into a
// blank frame — dropping the lang keeps both paths always visible.
function mermaidCodeBlock(lang: string | undefined, body: string[]): Block {
  const isMermaid = lang?.split(/\s+/)[0]?.toLowerCase() === "mermaid";
  if (!isMermaid) return { kind: "code", lang, lines: body };
  try {
    const art = renderMermaid(body.join("\n"));
    if (art && art.plain.length > 0) return { kind: "code", lines: art.plain };
  } catch {
    // 0.2.3 returns null instead of throwing; keep the guard for future majors.
  }
  return { kind: "code", lang: undefined, lines: body };
}

export function parseBlocks(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      blocks.push(mermaidCodeBlock(lang, body));
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)?.[0]?.length ?? 1;
      blocks.push({ kind: "heading", level, text: line.replace(/^#+\s*/, "") });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        q.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", lines: q });
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== ""
      && !(lines[i] ?? "").startsWith("```") && !/^#{1,4}\s/.test(lines[i] ?? "")
      && !/^\s*[-*]\s+/.test(lines[i] ?? "") && !/^>\s?/.test(lines[i] ?? "")) {
      para.push(lines[i] ?? "");
      i++;
    }
    blocks.push({ kind: "para", lines: para });
  }
  return blocks;
}

// Inline: **bold** and `code` → array of {text, bold?, code?} spans.
export function parseInline(s: string): { text: string; bold?: boolean; code?: boolean }[] {
  const spans: { text: string; bold?: boolean; code?: boolean }[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) spans.push({ text: s.slice(last, m.index) });
    const tok = m[0] ?? "";
    if (tok.startsWith("**")) spans.push({ text: tok.slice(2, -2), bold: true });
    else spans.push({ text: tok.slice(1, -1), code: true });
    last = m.index + tok.length;
  }
  if (last < s.length) spans.push({ text: s.slice(last) });
  return spans;
}

function Inline({ s }: { s: string }): React.JSX.Element {
  return (
    <>
      {parseInline(s).map((sp, idx) =>
        sp.code
          ? <Text key={idx} color={T.accent}>{sp.text}</Text>
          : sp.bold
            ? <Text key={idx} bold>{sp.text}</Text>
            : <Text key={idx}>{sp.text}</Text>,
      )}
    </>
  );
}

export function Markdown({ source }: { source: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {parseBlocks(source).map((b, i) => {
        if (b.kind === "code") {
          return (
            <Box key={i} flexDirection="column" paddingLeft={1}>
              {b.lines.map((ln, j) => (
                <Text key={j} color={T.ok}>
                  {b.lang ? highlight(ln, { language: b.lang }) : ln}
                </Text>
              ))}
            </Box>
          );
        }
        if (b.kind === "heading") {
          return <Text key={i} bold>{`${"#".repeat(b.level)} ${b.text}`}</Text>;
        }
        if (b.kind === "list") {
          return (
            <Box key={i} flexDirection="column">
              {b.items.map((it, j) => <Text key={j}>{`• `}<Inline s={it} /></Text>)}
            </Box>
          );
        }
        if (b.kind === "quote") {
          return (
            <Box key={i} flexDirection="column" paddingLeft={1}>
              {b.lines.map((ln, j) => <Text key={j} color={T.dim}>{`| ${ln}`}</Text>)}
            </Box>
          );
        }
        return (
          <Box key={i} flexDirection="column">
            {b.lines.map((ln, j) => <Text key={j}><Inline s={ln} /></Text>)}
          </Box>
        );
      })}
    </Box>
  );
}
