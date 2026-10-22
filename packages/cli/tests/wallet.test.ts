// P0-4 (96 队列) — the cross-session spend ledger (.wudao/costs.jsonl) + the
// /cost all wallet report. The ledger is append-only JSONL, fault-tolerant on
// read (a hand-edited/half-written line is skipped, never thrown); the
// aggregate keeps cost.ts's priced/unpriced split (unpriced ≠ free — an
// all-unpriced fold is costUsd null, never a fake $0); the render carries the
// balance section in its three states (success / error / silently omitted).
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  costLedgerPath,
  appendCostLedgerRow,
  readCostLedger,
  aggregateCostLedger,
  renderWalletReport,
  type CostLedgerRow,
} from "../src/commands/wallet.js";
import type { ProviderBalance } from "@wudao/providers";

async function tmpWs(): Promise<string> {
  return mkdtemp(join(tmpdir(), "p04-wallet-"));
}

const row = (over: Partial<CostLedgerRow> = {}): CostLedgerRow => ({
  ts: "2026-08-30T00:00:00.000Z",
  sessionId: "s1",
  model: "deepseek-v4-flash",
  provider: "deepseek",
  calls: 1,
  promptTokens: 1000,
  completionTokens: 9,
  cacheHitTokens: 700,
  cacheMissTokens: 300,
  costUsd: 0.5,
  ...over,
});

describe("cost ledger — .wudao/costs.jsonl", () => {
  it("costLedgerPath joins root/.wudao/costs.jsonl", () => {
    expect(costLedgerPath("/ws")).toBe(join("/ws", ".wudao", "costs.jsonl"));
  });

  it("append → read roundtrip (append-only, one JSON per line)", async () => {
    const ws = await tmpWs();
    try {
      appendCostLedgerRow(ws, row());
      appendCostLedgerRow(ws, row({ model: "glm-4.6", provider: "glm", costUsd: null }));
      expect(readCostLedger(ws)).toEqual([
        row(),
        row({ model: "glm-4.6", provider: "glm", costUsd: null }),
      ]);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("read is fault-tolerant: corrupt/half lines are skipped, never thrown", async () => {
    const ws = await tmpWs();
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      await writeFile(
        costLedgerPath(ws),
        `${JSON.stringify(row({ sessionId: "good-1" }))}\nNOT JSON {{{\n`
        + `${JSON.stringify(row({ sessionId: "good-2", costUsd: null }))}\n\n`,
        "utf8",
      );
      const rows = readCostLedger(ws);
      expect(rows.map((r) => r.sessionId)).toEqual(["good-1", "good-2"]);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("aggregateCostLedger — unpriced ≠ free", () => {
  it("folds by model: sums + the priced/unpriced split", () => {
    const agg = aggregateCostLedger([
      row({ costUsd: 0.5 }),
      row({ costUsd: 0.25, calls: 2, promptTokens: 3000, completionTokens: 18 }),
      row({ model: "glm-4.6", costUsd: null }),
      row({ model: "glm-4.6", costUsd: null, sessionId: "s2" }),
    ]);
    expect(agg.calls).toBe(5);
    expect(agg.unpricedCalls).toBe(2);
    expect(agg.costUsd).toBeCloseTo(0.75, 12);
    expect(agg.models).toEqual([
      { model: "deepseek-v4-flash", calls: 3, promptTokens: 4000, completionTokens: 27, costUsd: 0.75, unpricedCalls: 0 },
      { model: "glm-4.6", calls: 2, promptTokens: 2000, completionTokens: 18, costUsd: 0, unpricedCalls: 2 },
    ]);
  });

  it("an all-unpriced fold is costUsd null — never a fake $0", () => {
    const agg = aggregateCostLedger([row({ costUsd: null }), row({ model: "glm-4.6", costUsd: null })]);
    expect(agg.costUsd).toBeNull();
    expect(agg.calls).toBe(2);
    expect(agg.unpricedCalls).toBe(2);
  });

  it("the empty ledger folds to zeroes with costUsd null", () => {
    const agg = aggregateCostLedger([]);
    expect(agg).toEqual({ models: [], rows: 0, calls: 0, costUsd: null, unpricedCalls: 0 });
  });
});

describe("renderWalletReport — the /cost all face", () => {
  const mixed = aggregateCostLedger([
    row({ costUsd: 0.5 }),
    row({ costUsd: 0.25 }),
    row({ model: "glm-4.6", costUsd: null }),
  ]);

  it("pins the report skeleton (ledger rows / model lines / priced total + unpriced note)", () => {
    const text = renderWalletReport(mixed);
    expect(text).toContain("费用（全部会话）："); // ω99-186: 钉随源演进
    expect(text).toContain("台账 3 行（2 个模型）"); // ω99-186: 钉随源演进
    expect(text).toContain("deepseek-v4-flash: 2 次调用"); // ω99-186: 钉随源演进
    expect(text).toContain("$0.750000");
    expect(text).toContain("glm-4.6: 1 次调用"); // ω99-186: 钉随源演进
    expect(text).toContain("1 次未计价调用"); // ω99-186: 钉随源演进
    expect(text).toContain("合计（已计价）：$0.750000"); // ω99-186: 钉随源演进
    expect(text).toContain("未计价 ≠ 免费"); // ω99-186: 钉随源演进
  });

  it("an all-unpriced ledger never prints a $ total (no fake $0)", () => {
    const text = renderWalletReport(aggregateCostLedger([row({ costUsd: null })]));
    expect(text).not.toContain("合计（已计价）：$"); // ω99-186: 钉随源演进
    expect(text).toContain("合计（已计价）：无"); // ω99-186: 钉随源演进
    expect(text).toContain("未计价 ≠ 免费"); // ω99-186: 钉随源演进
  });

  it("balance success: one line per currency, amounts verbatim", () => {
    const balance: ProviderBalance = {
      available: true,
      infos: [
        { currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00" },
        { currency: "USD", totalBalance: "3.50", grantedBalance: "0.00", toppedUpBalance: "3.50" },
      ],
    };
    const text = renderWalletReport(mixed, { balance });
    expect(text).toContain("余额：CNY 110.00（赠送 10.00 · 充值 100.00）· 可用"); // ω99-186: 钉随源演进
    expect(text).toContain("余额：USD 3.50（赠送 0.00 · 充值 3.50）· 可用"); // ω99-186: 钉随源演进
  });

  it("balance failure: ONE line with the message's first line — never blocks the ledger above it", () => {
    const text = renderWalletReport(mixed, { balanceError: "balance: status 500: boom\nsecond line never shown" });
    expect(text).toContain("费用（全部会话）："); // ω99-186: 钉随源演进（the ledger still rendered first）
    expect(text).toContain("余额：不可用（balance: status 500: boom）"); // ω99-186: 钉随源演进（尾部 fixture 原文保）
    expect(text).not.toContain("second line never shown");
  });

  it("no balance data → the section is omitted entirely", () => {
    const text = renderWalletReport(mixed);
    expect(text).not.toContain("余额"); // ω99-186: 钉随源演进
  });
});
