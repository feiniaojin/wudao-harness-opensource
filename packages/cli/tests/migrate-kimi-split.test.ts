// 0.3.30 两套拆分——kimi-code 重指向订阅网关后的一次性数据迁移。
// 形状规则（非时间戳）：行钉 api.moonshot.cn 或行缺省 = 重指向前的平台
// 配置 → 行/ key 挪到新 kimi 条目；行钉订阅端或代理 = 不动。kimi 侧已有
// 数据优先（不覆盖）；一次性由 .migrated-kimi-split-0.3.30 标记保证；幂
// 等（重跑收敛）；永不抛错。
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProviderRegistryPath, writeProviderRegistrySync } from "@wudao/providers";
import { readCredentialsFileSync, writeCredentialsFileSync } from "../src/credentials.js";
import { migrateKimiCodeSplit } from "../src/driver/provider-registry-ops.js";

function makeHome(): { env: NodeJS.ProcessEnv; regPath: string; markerPath: string } {
  const home = mkdtempSync(join(tmpdir(), "wudao-kimi-split-"));
  const env = { WUDAO_GLOBAL_HOME: home };
  const regPath = defaultProviderRegistryPath(env);
  return { env, regPath, markerPath: join(home, ".migrated-kimi-split-0.3.30") };
}

const PLATFORM_ROW = { baseUrl: "https://api.moonshot.cn/anthropic", defaultModel: "kimi-k3" };

describe("migrateKimiCodeSplit — 0.3.30 两套拆分一次性迁移", () => {
  it("平台形状全迁移：moonshot 钉行改名 kimi、平台 key 挪到 kimi、兄弟数据保真、标记落地、二跑 no-op", () => {
    const { env, regPath, markerPath } = makeHome();
    writeProviderRegistrySync(regPath, {
      version: 1,
      providers: {
        deepseek: { effort: "medium" },
        "kimi-code": PLATFORM_ROW,
      } as Record<string, never>,
    });
    writeCredentialsFileSync({ "kimi-code": "sk-platform", deepseek: "sk-ds" }, env);

    expect(migrateKimiCodeSplit(env)).toBe(true);

    const rows = JSON.parse(readFileSync(regPath, "utf8")).providers;
    expect(rows["kimi"]).toEqual(PLATFORM_ROW);
    expect(rows["kimi-code"]).toBeUndefined();
    expect(rows.deepseek).toEqual({ effort: "medium" }); // 兄弟行保真
    const creds = readCredentialsFileSync(env);
    expect(creds.kimi).toBe("sk-platform"); // key 原值挪动
    expect(creds["kimi-code"]).toBeUndefined();
    expect(creds.deepseek).toBe("sk-ds"); // 兄弟 key 保真
    expect(existsSync(markerPath)).toBe(true);

    // 二跑 no-op：即使磁盘被改回平台形状，标记在就不动。
    writeCredentialsFileSync({ "kimi-code": "sk-again" }, env);
    expect(migrateKimiCodeSplit(env)).toBe(false);
    expect(readCredentialsFileSync(env)["kimi-code"]).toBe("sk-again");
  });

  it("订阅形状不动：行钉 api.kimi.com/coding → 行与 key 原地保留（标记落地防重判）", () => {
    const { env, regPath, markerPath } = makeHome();
    writeProviderRegistrySync(regPath, {
      version: 1,
      providers: { "kimi-code": { baseUrl: "https://api.kimi.com/coding", defaultModel: "k3-256k" } } as Record<string, never>,
    });
    writeCredentialsFileSync({ "kimi-code": "sk-subscription" }, env);

    expect(migrateKimiCodeSplit(env)).toBe(false);

    const rows = JSON.parse(readFileSync(regPath, "utf8")).providers;
    expect(rows["kimi-code"].baseUrl).toBe("https://api.kimi.com/coding");
    expect(rows["kimi"]).toBeUndefined();
    expect(readCredentialsFileSync(env)["kimi-code"]).toBe("sk-subscription");
    expect(readCredentialsFileSync(env).kimi).toBeUndefined();
    expect(existsSync(markerPath)).toBe(true);
  });

  it("行缺省 + key 存（在内置卡上直接存过 key）：key 挪到 kimi，不创建 providers.json", () => {
    const { env, regPath } = makeHome();
    writeCredentialsFileSync({ "kimi-code": "sk-platform-only" }, env);

    expect(migrateKimiCodeSplit(env)).toBe(true);

    expect(existsSync(regPath)).toBe(false); // 无行可挪，不造文件
    const creds = readCredentialsFileSync(env);
    expect(creds.kimi).toBe("sk-platform-only");
    expect(creds["kimi-code"]).toBeUndefined();
  });

  it("kimi 已有 key：不覆盖——旧 kimi-code key 原地保留（fail-visible，不删用户数据）", () => {
    const { env } = makeHome();
    writeCredentialsFileSync({ kimi: "sk-new-entry", "kimi-code": "sk-old" }, env);

    expect(migrateKimiCodeSplit(env)).toBe(false);

    const creds = readCredentialsFileSync(env);
    expect(creds.kimi).toBe("sk-new-entry");
    expect(creds["kimi-code"]).toBe("sk-old");
  });

  it("空 home：只落标记，不创建 providers.json / .credentials.yaml；坏 JSON 也不抛", () => {
    const { env, regPath, markerPath } = makeHome();
    expect(migrateKimiCodeSplit(env)).toBe(false);
    expect(existsSync(regPath)).toBe(false);
    expect(existsSync(join(env.WUDAO_GLOBAL_HOME!, ".credentials.yaml"))).toBe(false);
    expect(existsSync(markerPath)).toBe(true);

    // 坏 JSON → fail-open no-op，不抛错。
    const home2 = mkdtempSync(join(tmpdir(), "wudao-kimi-split2-"));
    writeFileSync(join(home2, "providers.json"), "{not json", "utf8");
    expect(() => migrateKimiCodeSplit({ WUDAO_GLOBAL_HOME: home2 })).not.toThrow();
  });
});
