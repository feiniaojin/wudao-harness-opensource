// ω99-2a —— MCP stdio 服务器 spawn 前 OSV 恶意包检查（测试先行）。
//
// 分层：
//   1. 纯函数单元：commandEcosystem（命令→生态）、parseFirstPackageArg
//      （npm/PyPI token 解析——goose :87-110/:216-248/:250-292 的移植面）。
//   2. denyIfMalicious（经 checkMcpCommand 注入 fetchImpl——确定性、零网络）：
//      MAL-* 命中才 throw；fetch reject / 非 2xx / 非 JSON 一律放行（fail-open
//      红线：离线不能拖死所有 MCP 服务器）；翻页跟随 next_page_token。
//   3. endpoint 优先级（deps.endpoint > WUDAO_OSV_ENDPOINT > 默认）与
//      WUDAO_OSV_CHECK=off kill switch（M46 WUDAO_LONG_OUTPUT=off 同款先例）。
//   4. 集成（node:http fake OSV + 真 fetch，模式照 mcp-http.test.ts）：
//      loadMcpTools 的 stdio 分支命中 MAL → warn+skip、零工具、无进程 spawn。
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type AddressInfo } from "node:http";
import { commandEcosystem, parseFirstPackageArg, checkMcpCommand } from "../src/mcp/osv-check.js";
import { loadMcpTools, closeMcpTools } from "../src/mcp/tools.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = ["WUDAO_OSV_ENDPOINT", "WUDAO_OSV_CHECK"] as const;

/** 临时改 env 并恢复（先例 output-config.test.ts 的 withSettings）：把两个
 *  OSV 相关变量从环境里 scrub 掉再按 overrides 设置，测试体跑完还原——
 *  开发机上的残留 env 不许渗进断言。 */
async function withEnv(overrides: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
    await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** 一次 OSV 查询响应（vulns + 可选 next_page_token）。 */
function osvResponse(vulns: unknown[], nextPageToken?: string): Response {
  return new Response(
    JSON.stringify({ vulns, ...(nextPageToken !== undefined ? { next_page_token: nextPageToken } : {}) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface RecordedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** 剧本 fetch：按序吐出 Response 或抛出 Error；记录每次调用的 url + body。 */
function scriptedFetch(outcomes: (Response | Error)[], calls: RecordedCall[] = []): { f: typeof fetch; calls: RecordedCall[] } {
  let n = 0;
  const f = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    const next = outcomes[n++];
    if (next === undefined) throw new Error(`unexpected fetch call #${n}`);
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { f, calls };
}

// ---------------------------------------------------------------------------
// 1. commandEcosystem
// ---------------------------------------------------------------------------

describe("commandEcosystem — 最后路径段（/ 与 \\ 都切）、小写", () => {
  it("npx 家族 → npm", () => {
    for (const c of ["npx", "NPX", "npx.cmd", "npx.exe", "/usr/local/bin/npx", "C:\\tools\\npx.cmd", "C:/tools/npx.exe"]) {
      expect(commandEcosystem(c), c).toBe("npm");
    }
  });

  it("uvx 家族 → PyPI", () => {
    for (const c of ["uvx", "UVX", "uvx.exe", "/opt/venv/bin/uvx", "C:\\Users\\u\\.local\\bin\\uvx.exe"]) {
      expect(commandEcosystem(c), c).toBe("PyPI");
    }
  });

  it("其他命令与空串 → undefined（不查，fail-open）", () => {
    for (const c of ["node", "python", "", "my-npx", "npx.cmd.bak", "docker", "uvx.cmd"]) {
      expect(commandEcosystem(c), c).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. parseFirstPackageArg
// ---------------------------------------------------------------------------

describe("parseFirstPackageArg — npm", () => {
  it("第一个非 - 开头参数为包名；@scope 在最后一个 @ 切；@latest/@空 → 无版本", () => {
    expect(parseFirstPackageArg("npm", ["-y", "pkg"])).toEqual({ name: "pkg" });
    expect(parseFirstPackageArg("npm", ["@scope/pkg@1.2.3"])).toEqual({ name: "@scope/pkg", version: "1.2.3" });
    expect(parseFirstPackageArg("npm", ["pkg@latest"])).toEqual({ name: "pkg" });
    expect(parseFirstPackageArg("npm", ["pkg@"])).toEqual({ name: "pkg" });
    expect(parseFirstPackageArg("npm", ["--dry-run", "-y"])).toBeUndefined();
    expect(parseFirstPackageArg("npm", [])).toBeUndefined();
  });
});

describe("parseFirstPackageArg — PyPI", () => {
  it("--from 两种形态优先；positional 兜底；extras 跳过；== 精确版本", () => {
    expect(parseFirstPackageArg("PyPI", ["--from", "pkg2", "x"])).toEqual({ name: "pkg2" });
    expect(parseFirstPackageArg("PyPI", ["--from=pkg3"])).toEqual({ name: "pkg3" });
    expect(parseFirstPackageArg("PyPI", ["name[extra]==1.0"])).toEqual({ name: "name", version: "1.0" });
    expect(parseFirstPackageArg("PyPI", ["-q", "pkg4"])).toEqual({ name: "pkg4" });
  });

  it("包名提取照 PEP 503 规范化（连续 -_. 折叠为 -、小写）——OSV 按规范名索引", () => {
    expect(parseFirstPackageArg("PyPI", ["Evil_Pkg[cli]>=0"])).toEqual({ name: "evil-pkg" });
    expect(parseFirstPackageArg("PyPI", ["zope.interface"])).toEqual({ name: "zope-interface" });
  });

  it("--from 出现在包名之后不抢（那是工具自身的透传参数）；解析不出合法包名 → undefined", () => {
    expect(parseFirstPackageArg("PyPI", ["malicious-package", "--from", "benign-package"])).toEqual({ name: "malicious-package" });
    expect(parseFirstPackageArg("PyPI", ["==1.0"])).toBeUndefined();
    expect(parseFirstPackageArg("PyPI", [])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. denyIfMalicious（checkMcpCommand + 注入 fetchImpl）
// ---------------------------------------------------------------------------

describe("denyIfMalicious — MAL-* 才拒绝，其余一律放行（fail-open 红线）", () => {
  it("MAL-* 命中 → throw，消息含包名、全部 MAL id 与 summary", async () => {
    const { f } = scriptedFetch([osvResponse([
      { id: "GHSA-1111-2222", summary: "a normal vuln, not malware" },
      { id: "MAL-2025-0001", summary: "steals tokens" },
      { id: "MAL-2025-0002", summary: "runs install hooks" },
    ])]);
    await withEnv({}, async () => {
      const err = await checkMcpCommand("npx", ["-y", "evil-pkg"], { fetchImpl: f, endpoint: "https://osv.test/query" })
        .then(() => undefined, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain("MAL-2025-");
      expect(err?.message).toContain("evil-pkg");
      expect(err?.message).toContain("MAL-2025-0001");
      expect(err?.message).toContain("MAL-2025-0002");
    });
  });

  it("仅 GHSA-*（非 MAL）→ 放行；请求体只含 package（无版本时不带 version 字段）", async () => {
    const { f, calls } = scriptedFetch([osvResponse([{ id: "GHSA-1111-2222", summary: "just a vuln" }])]);
    await withEnv({}, async () => {
      await expect(checkMcpCommand("npx", ["-y", "clean-pkg"], { fetchImpl: f, endpoint: "https://osv.test/query" })).resolves.toBeUndefined();
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.body).toEqual({ package: { name: "clean-pkg", ecosystem: "npm" } });
  });

  it("带精确版本 → 请求体含 version", async () => {
    const { f, calls } = scriptedFetch([osvResponse([])]);
    await withEnv({}, async () => {
      await expect(checkMcpCommand("uvx", ["ruff==0.3.0"], { fetchImpl: f, endpoint: "https://osv.test/query" })).resolves.toBeUndefined();
    });
    expect(calls[0]?.body).toEqual({ package: { name: "ruff", ecosystem: "PyPI" }, version: "0.3.0" });
  });

  it("fetch reject（网络不通）→ 放行", async () => {
    const { f } = scriptedFetch([new Error("ECONNREFUSED")]);
    await withEnv({}, async () => {
      await expect(checkMcpCommand("npx", ["pkg"], { fetchImpl: f, endpoint: "https://osv.test/query" })).resolves.toBeUndefined();
    });
  });

  it("HTTP 500 / 404 → 放行（404 = 查无此包；其余非 2xx 同为 fail-open）", async () => {
    for (const status of [500, 404]) {
      const { f } = scriptedFetch([new Response("boom", { status })]);
      await withEnv({}, async () => {
        await expect(checkMcpCommand("npx", ["pkg"], { fetchImpl: f, endpoint: "https://osv.test/query" })).resolves.toBeUndefined();
      });
    }
  });

  it("响应体非 JSON → 放行", async () => {
    const { f } = scriptedFetch([new Response("<html>not json</html>", { status: 200, headers: { "content-type": "application/json" } })]);
    await withEnv({}, async () => {
      await expect(checkMcpCommand("npx", ["pkg"], { fetchImpl: f, endpoint: "https://osv.test/query" })).resolves.toBeUndefined();
    });
  });

  it("翻页：第一页 next_page_token 无 MAL，第二页 MAL → throw；第二页请求体带 page_token", async () => {
    const { f, calls } = scriptedFetch([
      osvResponse([], "page-2"),
      osvResponse([{ id: "MAL-2025-4242", summary: "second page hit" }]),
    ]);
    await withEnv({}, async () => {
      await expect(checkMcpCommand("npx", ["pkg"], { fetchImpl: f, endpoint: "https://osv.test/query" }))
        .rejects.toThrow(/MAL-2025-4242/);
    });
    expect(calls.length).toBe(2);
    expect(calls[0]?.body["page_token"]).toBeUndefined();
    expect(calls[1]?.body["page_token"]).toBe("page-2");
  });

  it("非 npx/uvx 命令与无可解析包名 → fetch 不被调用（跳过检查，不是放行查询）", async () => {
    for (const [command, args] of [["node", ["server.js"]], ["npx", ["--dry-run", "-y"]]] as const) {
      const { f, calls } = scriptedFetch([osvResponse([{ id: "MAL-2025-1" }])]);
      await withEnv({}, async () => {
        await expect(checkMcpCommand(command, args, { fetchImpl: f, endpoint: "https://osv.test/query" })).resolves.toBeUndefined();
      });
      expect(calls.length, `${command} ${args.join(" ")}`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. endpoint 优先级 + kill switch
// ---------------------------------------------------------------------------

describe("endpoint 优先级：deps.endpoint > WUDAO_OSV_ENDPOINT > 默认", () => {
  it("deps.endpoint 覆盖 env", async () => {
    const { f, calls } = scriptedFetch([osvResponse([])]);
    await withEnv({ WUDAO_OSV_ENDPOINT: "https://env.test/query" }, async () => {
      await checkMcpCommand("npx", ["pkg"], { fetchImpl: f, endpoint: "https://deps.test/query" });
    });
    expect(calls[0]?.url).toBe("https://deps.test/query");
  });

  it("env WUDAO_OSV_ENDPOINT 覆盖默认（无 deps.endpoint）", async () => {
    const { f, calls } = scriptedFetch([osvResponse([])]);
    await withEnv({ WUDAO_OSV_ENDPOINT: "https://env.test/query" }, async () => {
      await checkMcpCommand("npx", ["pkg"], { fetchImpl: f });
    });
    expect(calls[0]?.url).toBe("https://env.test/query");
  });

  it("两者皆无 → 默认 api.osv.dev", async () => {
    const { f, calls } = scriptedFetch([osvResponse([])]);
    await withEnv({}, async () => {
      await checkMcpCommand("npx", ["pkg"], { fetchImpl: f });
    });
    expect(calls[0]?.url).toBe("https://api.osv.dev/v1/query");
  });
});

describe("kill switch — WUDAO_OSV_CHECK=off", () => {
  it("off → fetch 不被调用（即便剧本里躺着 MAL 命中）", async () => {
    const { f, calls } = scriptedFetch([osvResponse([{ id: "MAL-2025-1", summary: "evil" }])]);
    await withEnv({ WUDAO_OSV_CHECK: "off" }, async () => {
      await expect(checkMcpCommand("npx", ["-y", "evil-pkg"], { fetchImpl: f, endpoint: "https://osv.test/query" })).resolves.toBeUndefined();
    });
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. 集成 — node:http fake OSV + loadMcpTools（模式照 mcp-http.test.ts）
// ---------------------------------------------------------------------------

interface CapturedOsvRequest {
  readonly url: string | undefined;
  readonly body: Record<string, unknown>;
}

afterEach(async () => {
  await closeMcpTools(); // drain the registry between tests
});

describe("集成 — fake OSV server + loadMcpTools stdio 分支拒启", () => {
  it("npx evil-pkg 命中 MAL → 零工具、warn 含 MAL id、fake server 只收到 OSV 查询（无进程 spawn）", async () => {
    const requests: CapturedOsvRequest[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
        } catch {
          requests.push({ url: req.url, body: {} });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ vulns: [{ id: "MAL-2025-1", summary: "evil" }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as AddressInfo;
    try {
      const warnings: string[] = [];
      await withEnv({ WUDAO_OSV_ENDPOINT: `http://127.0.0.1:${addr.port}/v1/query` }, async () => {
        // 命中 → connectServer 在构造 JsonRpcClient 之前 throw → 走既有
        // loadMcpTools catch 变 warn+skip。npx 从未被拉起（检查先于一切
        // spawn），fake server 只应收到这一次 OSV 查询。
        const tools = await loadMcpTools(
          { servers: { bad: { command: "npx", args: ["-y", "evil-pkg"] } } },
          (m) => warnings.push(m),
        );
        expect(tools).toEqual([]);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("bad");
        expect(warnings[0]).toContain("MAL-2025-1");
      });
      expect(requests.length).toBe(1); // 只有 OSV 查询，没有任何服务器进程流量
      expect(requests[0]?.url).toBe("/v1/query");
      expect(requests[0]?.body).toEqual({ package: { name: "evil-pkg", ecosystem: "npm" } });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
