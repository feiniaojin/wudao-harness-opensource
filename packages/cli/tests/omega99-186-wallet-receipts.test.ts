// ω99-186: /cost all 报告（renderWalletReport）中文化 receipts —— 三组 8 it，
// 镜像 wallet.test 的 fixture 形（row() + aggregateCostLedger + renderWalletReport）。
// A 骨架 / B 三态（all-unpriced · balance 成功 · balanceError · 无 balance）/ C 旧形反向。
// token 保留：金额形 $…、模型 id、币种代码、余额 API 原串、` · ` 分隔、≠、kib 形。
import { describe, it, expect } from "vitest";
import {
  aggregateCostLedger,
  renderWalletReport,
  type CostLedgerRow,
} from "../src/commands/wallet.js";
import type { ProviderBalance } from "@wudao/providers";

const row = (over: Partial<CostLedgerRow> = {}): CostLedgerRow => ({
  ts: "2026-09-04T00:00:00.000Z",
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

// 两行同模型：2 行 1 模型，已计价合计 $0.750000（kib(2000)="2.0k"）。
const pair = aggregateCostLedger([row({ costUsd: 0.5 }), row({ costUsd: 0.25 })]);

describe("ω99-186 A — /cost all 报告骨架（中文化）", () => {
  it("首行是「费用（全部会话）：」，台账行报行数与模型数", () => {
    const text = renderWalletReport(pair);
    expect(text.split("\n")[0]).toBe("费用（全部会话）：");
    expect(text).toContain("台账 2 行（1 个模型）");
  });

  it("模型行：N 次调用 · 输入/输出 token 段 · 金额段", () => {
    const text = renderWalletReport(pair);
    expect(text).toContain("deepseek-v4-flash: 2 次调用");
    expect(text).toContain("2.0k 输入");
    expect(text).toContain("18 输出");
    expect(text).toContain("$0.750000");
  });

  it("合计行：「合计（已计价）：$…」", () => {
    expect(renderWalletReport(pair)).toContain("合计（已计价）：$0.750000");
  });
});

describe("ω99-186 B — 三态（all-unpriced / balance 成功 / balanceError / 无 balance）", () => {
  it("all-unpriced → 合计「无」+ 未计价 ≠ 免费，绝无伪 $0", () => {
    const text = renderWalletReport(aggregateCostLedger([row({ costUsd: null })]));
    expect(text).toContain("合计（已计价）：无");
    expect(text).toContain("未计价 ≠ 免费");
    expect(text).not.toContain("合计（已计价）：$");
  });

  it("balance 成功 → 双币种各一行，「可用」态", () => {
    const balance: ProviderBalance = {
      available: true,
      infos: [
        { currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00" },
        { currency: "USD", totalBalance: "3.50", grantedBalance: "0.00", toppedUpBalance: "3.50" },
      ],
    };
    const text = renderWalletReport(pair, { balance });
    expect(text).toContain("余额：CNY 110.00（赠送 10.00 · 充值 100.00）· 可用");
    expect(text).toContain("余额：USD 3.50（赠送 0.00 · 充值 3.50）· 可用");
  });

  it("balanceError → 「余额：不可用（…）」一行，只取消息首行（消息原文保真）", () => {
    const text = renderWalletReport(pair, { balanceError: "balance: status 500: boom\nsecond line never shown" });
    expect(text).toContain("余额：不可用（balance: status 500: boom）");
    expect(text).not.toContain("second line never shown");
  });

  it("无 balance 数据 → 余额节整体省略（台账仍渲染）", () => {
    const text = renderWalletReport(pair);
    expect(text).not.toContain("余额");
    expect(text).toContain("台账 2 行（1 个模型）");
  });
});

describe("ω99-186 C — 旧形反向（英文残面为 0）", () => {
  it("骨架/合计/余额旧英文形全部不再出现", () => {
    const balance: ProviderBalance = {
      available: true,
      infos: [{ currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00" }],
    };
    const text = renderWalletReport(pair, { balance });
    expect(text).not.toContain("cost (all sessions)");
    expect(text).not.toContain("ledger rows:");
    expect(text).not.toContain("total (priced)");
    expect(text).not.toContain("· available");
    expect(text).not.toContain("balance: ");
  });
});
