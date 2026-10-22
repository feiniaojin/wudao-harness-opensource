// SpoofReveal — ω99-318: the approval surfaces' Unicode visual-spoofing
// reveal. Shared by BOTH shells (SimpleApprovalCard + PermissionModal — the
// ui-parity C "one derivation, both shells" rule): the payload lives on the
// ask frame (computed at the driver's askPermission seam from core's single
// codepoint tables — 源检验、边渲染), this component only RENDERS it. The web
// package never imports the scanner and never copies a table.
//
// Render contract (brief §2): 只显形，不拦截、不变色为 danger 满格 —
//   - text entries: a row per flagged argument (its key), the invisible
//     codepoints as badges (`U+200B 零宽空格` style hook, tallied ×N), the
//     honest `另 N 处` when the payload hit its issue cap;
//   - url entries: 「真实指向」 (the normalized form — what the eye reads
//     vs. what the machine resolves) plus the punycode/fold warnings in warn
//     color underneath.
// Absent payload → null (the card's DOM is byte-identical to pre-ω99-318).
import type { SpoofInspection } from "../protocol.js";
import { Icon } from "./Icon.js";

type IssueLike = { readonly codepoint: string; readonly nameZh: string };

/** Group issues into `U+200B 零宽空格×2` badges (order of first appearance). */
function tallyIssues(issues: readonly IssueLike[]): [label: string, n: number][] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const label = `${issue.codepoint} ${issue.nameZh}`;
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return order.map((label) => [label, counts.get(label) ?? 0] as const);
}

export function SpoofReveal({ spoof }: { spoof?: SpoofInspection }): React.JSX.Element | null {
  if (spoof === undefined) return null;
  if (spoof.text.length === 0 && spoof.urls.length === 0) return null;
  return (
    <div className="spoof">
      <div className="spoof-title"><Icon name="triangle-alert" size={12} /> 视觉欺骗检查（仅显形，不影响按钮与按键）</div>
      {spoof.text.map((entry) => (
        <div className="spoof-row" key={`t:${entry.key}`}>
          <span className="spoof-key">{entry.key}</span>
          {tallyIssues(entry.issues).map(([label, n]) => (
            <span className="spoof-badge" key={label}>{n > 1 ? `${label}×${n}` : label}</span>
          ))}
          {entry.more !== undefined && entry.more > 0 ? <span className="spoof-badge spoof-more">{`另 ${entry.more} 处`}</span> : null}
        </div>
      ))}
      {spoof.urls.map((url) => (
        <div className="spoof-url" key={`u:${url.key}:${url.original}`}>
          <span className="spoof-key">{url.key}</span>
          {" 真实指向："}
          <code className="spoof-target">{url.normalizedUrl}</code>
          {url.warnings.map((warning, i) => (
            <div className="spoof-note" key={i}>{warning}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
