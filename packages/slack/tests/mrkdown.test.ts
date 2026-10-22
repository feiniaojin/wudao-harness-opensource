// M60 — the md → mrkdown rough conversion + truncation markers.
import { describe, expect, it } from "vitest";
import { mdToMrkdown, truncateSummary, truncateThreadContext } from "../src/mrkdown.js";

describe("mdToMrkdown", () => {
  it("converts headers to bold lines", () => {
    expect(mdToMrkdown("# Title\n## Sub\nplain")).toBe("*Title*\n*Sub*\nplain");
  });

  it("converts bold markers (not italic/strike which are mrkdown-native)", () => {
    expect(mdToMrkdown("**bold** and __also bold__")).toBe("*bold* and *also bold*");
  });

  it("converts links and images to <url|text>", () => {
    expect(mdToMrkdown("[docs](https://example.com)")).toBe("<https://example.com|docs>");
    expect(mdToMrkdown("![logo](https://example.com/l.png)")).toBe("<https://example.com/l.png|logo>");
    expect(mdToMrkdown("![](https://example.com/l.png)")).toBe("<https://example.com/l.png|https://example.com/l.png>");
  });

  it("converts bullet markers to • and keeps indentation", () => {
    expect(mdToMrkdown("- one\n+ two\n  * nested")).toBe("• one\n• two\n  • nested");
  });

  it("keeps fenced code blocks verbatim", () => {
    const md = "before\n```js\nconst x = 1; // **not bold**\n```\nafter";
    expect(mdToMrkdown(md)).toContain("const x = 1; // **not bold**");
  });

  it("horizontal rules become em dashes", () => {
    expect(mdToMrkdown("a\n---\nb")).toBe("a\n—\nb");
  });

  it("is deterministic (byte-identical on repeat)", () => {
    const md = "# H\n\n- a **b** [l](https://x.y)\n\n```ts\ncode\n```";
    expect(mdToMrkdown(md)).toBe(mdToMrkdown(md));
  });

  it("F4: escapes & < > so relayed text can never broadcast or mention", () => {
    expect(mdToMrkdown("hi <!channel> and <!here>")).toBe("hi &lt;!channel&gt; and &lt;!here&gt;");
    expect(mdToMrkdown("ping <@U123>")).toBe("ping &lt;@U123&gt;");
    expect(mdToMrkdown("a & b")).toBe("a &amp; b");
    // Already-escaped input is not double-escaped into visibility issues:
    // the entities render back to literals in Slack.
    expect(mdToMrkdown("&lt;ok&gt;")).toBe("&amp;lt;ok&amp;gt;");
  });

  it("F4: the converter's own link output is unaffected (escape happens first)", () => {
    expect(mdToMrkdown("[l](https://x.y)")).toBe("<https://x.y|l>");
    expect(mdToMrkdown("[q](https://x.y/?a=1&b=2)")).toBe("<https://x.y/?a=1&amp;b=2|q>");
  });

  it("F4: fenced code lines pass through unescaped (no entities in code blocks)", () => {
    expect(mdToMrkdown("```\n<!channel>\n```")).toBe("```\n<!channel>\n```");
  });
});

describe("truncation", () => {
  it("summary: silent under the cap, marked over it", () => {
    expect(truncateSummary("abc", 3000)).toBe("abc");
    const long = "x".repeat(4000);
    const cut = truncateSummary(long, 3000);
    expect(cut.length).toBeLessThanOrEqual(3000);
    expect(cut).toContain("截断");
    expect(cut).toContain("4000");
  });

  it("thread context: marked over the cap with the kept size", () => {
    const long = "y".repeat(9000);
    const cut = truncateThreadContext(long, 8000);
    expect(cut.length).toBeLessThanOrEqual(8000);
    expect(cut).toContain("线程上下文截断");
    expect(cut).toContain("9000");
  });
});
