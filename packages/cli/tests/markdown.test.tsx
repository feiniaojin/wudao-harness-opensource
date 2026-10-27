import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Markdown, parseBlocks } from "../src/tui/markdown.js";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("Markdown", () => {
  it("renders a plain paragraph unchanged", () => {
    const { lastFrame } = render(<Markdown source={"hello world"} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("hello world");
  });
  it("renders headings as distinct bold lines", () => {
    const { lastFrame } = render(<Markdown source={"# Title\nbody"} />);
    const f = stripAnsi(lastFrame() ?? "");
    expect(f).toContain("Title");
    expect(f).toContain("body");
  });
  it("renders fenced code with its content intact", () => {
    const src = "```ts\nconst x = 1;\n```";
    const { lastFrame } = render(<Markdown source={src} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("const x = 1;");
  });
  it("renders inline code distinctly", () => {
    const { lastFrame } = render(<Markdown source={"use `read_file` now"} />);
    const f = stripAnsi(lastFrame() ?? "");
    expect(f).toContain("read_file");
    expect(f).toContain("use");
  });
  it("renders list items on their own lines", () => {
    const { lastFrame } = render(<Markdown source={"- one\n- two"} />);
    const f = stripAnsi(lastFrame() ?? "");
    expect(f).toContain("one");
    expect(f).toContain("two");
  });
  it("renders a valid mermaid block as ASCII art, replacing the source", () => {
    const src = "```mermaid\nflowchart TD\nA-->B\n```";
    const { lastFrame } = render(<Markdown source={src} />);
    const f = stripAnsi(lastFrame() ?? "");
    expect(/[─│┌┐└┘]/.test(f)).toBe(true);
    expect(f).not.toContain("flowchart TD");
    // structure: replacement block carries no lang (no highlight, source gone)
    const b = parseBlocks(src)[0]!;
    if (b.kind !== "code") throw new Error("expected code block");
    expect(b.lang).toBeUndefined();
    expect(b.lines.some((ln) => /[─│┌┐└┘]/.test(ln))).toBe(true);
    expect(b.lines.join("\n")).not.toContain("flowchart TD");
  });
  it("falls back to the raw mermaid source on render failure", () => {
    const src = "```mermaid\nflowchart TD\n!!this is [[garbage\n```";
    const { lastFrame } = render(<Markdown source={src} />);
    const f = stripAnsi(lastFrame() ?? "");
    expect(f).toContain("flowchart TD");
    expect(f).toContain("!!this is [[garbage");
    // structure: verbatim source kept; lang dropped — cli-highlight throws
    // "Unknown language: mermaid" (verified on-site) which Ink swallows into
    // a blank frame, so keeping the lang would hide the fallback source.
    const b = parseBlocks(src)[0]!;
    if (b.kind !== "code") throw new Error("expected code block");
    expect(b.lines).toEqual(["flowchart TD", "!!this is [[garbage"]);
    expect(b.lang).toBeUndefined();
  });
  it("leaves non-mermaid fenced code untouched", () => {
    const src = "```ts\nconst x = 1;\n```";
    const { lastFrame } = render(<Markdown source={src} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("const x = 1;");
    const b = parseBlocks(src)[0]!;
    if (b.kind !== "code") throw new Error("expected code block");
    expect(b.lang).toBe("ts");
    expect(b.lines).toEqual(["const x = 1;"]);
  });
});
