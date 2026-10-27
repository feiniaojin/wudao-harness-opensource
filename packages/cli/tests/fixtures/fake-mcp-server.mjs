#!/usr/bin/env node
// Fake MCP server for tests — newline-delimited JSON-RPC 2.0 over stdio.
//
// Behaviors (beyond the plain echo surface):
// - Emits one malformed stdout line at startup: the client's line parser must
//   skip it and still work.
// - initialize → MCP protocol 2025-06-18 handshake result.
// - tools/list → echo / fail / slow / crash / wide / opaque tools
//   (FAKE_DUPLICATE_TOOLS=1 lists "echo" twice — name-collision tests).
// - tools/call:
//     echo  → content text = args.text ?? JSON.stringify(args)
//     fail  → isError: true ("boom")
//     slow  → responds after FAKE_DELAY_MS (default 500) — timeout tests
//     crash → exits the process (fail-closed tests)
//     wide  → content text = JSON.stringify(args) verbatim (schema carries
//             integer/array/object params that core cannot type-check)
//     opaque→ content text = JSON.stringify(args) verbatim (schema is a bare
//             {type:"object"} with no properties)
// - FAKE_TRAP_SIGTERM=1 → ignore SIGTERM AND stay alive after stdin EOF
//   (close() must still terminate via SIGKILL — bounded-shutdown tests).
// - FAKE_HUGE_LINE=1 → write a 4KB line with no terminating newline (client
//   line-cap overflow tests).
// - Any other method with an id → JSON-RPC error -32601.
import readline from "node:readline";

// Malformed line first: the client must skip unparseable stdout.
process.stdout.write("this is not json\n");

if (process.env.FAKE_TRAP_SIGTERM === "1") {
  // Deliberately hostile: swallow SIGTERM and keep an event-loop handle so
  // neither the signal nor stdin EOF can end this process.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
}

if (process.env.FAKE_HUGE_LINE === "1") {
  process.stdout.write("x".repeat(4096)); // no newline — must trip the line cap
}

const PROTOCOL_VERSION = "2025-06-18";

// P0-2（96 队列 #2）resources 面：FAKE_RESOURCES=1 时 initialize 声明
// capabilities.resources，并应答 resources/list、resources/read。
// 不设该变量 → 能力缺失（客户端不得注册资源工具）。
const RESOURCES = [
  { uri: "memo://notes/todo", name: "todo.md", description: "今天要做什么", mimeType: "text/markdown" },
  { uri: "memo://notes/done", name: "done.md", mimeType: "text/markdown" },
  { uri: "config://app", name: "app-config", description: "运行时配置" },
];

function replyLater(id, fn) {
  const delay = Number(process.env.FAKE_DELAY_MS ?? "500") || 500;
  setTimeout(fn, delay);
}

function resourceReadReply(id, uri) {
  if (uri === "memo://notes/todo") {
    reply(id, { contents: [{ uri, mimeType: "text/markdown", text: "# 待办\n- 写失败测试\n- 最小实现" }] });
  } else if (uri === "memo://notes/dirty") {
    // 夜移 021 同款脏探针：NUL/ESC 控制字符、分解字符、U+FFFD、DEL。
    reply(id, { contents: [{ uri, mimeType: "text/plain", text: "a\x00b\x1bc\td\néf�g\x7f" }] });
  } else if (uri === "binary://logo") {
    reply(id, { contents: [{ uri, mimeType: "image/png", blob: Buffer.from("fakepng").toString("base64") }] });
  } else if (uri === "multi://two") {
    reply(id, {
      contents: [
        { uri: "multi://two#1", mimeType: "text/plain", text: "第一段" },
        { uri: "multi://two#2", text: "第二段" },
      ],
    });
  } else if (uri === "slow://wait") {
    replyLater(id, () => reply(id, { contents: [{ uri, text: "slow" }] }));
  } else if (uri === "huge://big") {
    // ~84KB 多行文本（>50KB 字节帽）——客户端 output-caps 截断测试。
    const text = Array.from({ length: 3000 }, (_, i) => `第 ${i} 行：${"x".repeat(20)}`).join("\n");
    reply(id, { contents: [{ uri, mimeType: "text/plain", text }] });
  } else {
    replyError(id, -32602, `unknown resource uri: ${String(uri)}`);
  }
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo the arguments back as text",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "fail",
    description: "Always fails",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "slow",
    description: "Responds after a delay",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  {
    name: "crash",
    description: "Exits the server process",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wide",
    description: "Echoes the arguments back as JSON (schema has non-primitive params)",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", description: "an integer param" },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object" },
        text: { type: "string" },
      },
      required: ["text", "count"],
      additionalProperties: false,
    },
  },
  {
    name: "opaque",
    description: "Echoes the arguments back as JSON (schema has no properties)",
    inputSchema: { type: "object" },
  },
  {
    // 夜移 021: hostile-text probe — ESC sequence in the description plus a
    // body far past the description cap; the call result carries control
    // chars, a decomposed char, and U+FFFD. The loader must scrub both lanes.
    name: "dirty",
    description: "Dirty\x1b description " + "x".repeat(3000),
    inputSchema: { type: "object", properties: {} },
  },
];

if (process.env.FAKE_DUPLICATE_TOOLS === "1") {
  TOOLS.push({ ...TOOLS[0] }); // a second "echo" — name-collision tests
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // not our problem: ignore unparseable input
  }
  const { method, params, id } = msg ?? {};
  if (typeof method !== "string") return;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: process.env.FAKE_RESOURCES === "1"
          ? { tools: {}, resources: {} }
          : { tools: {} },
        serverInfo: { name: "fake-mcp", version: "0.0.0" },
      });
      return;
    case "notifications/initialized":
      return; // notification — no response
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "resources/list":
      if (process.env.FAKE_SLOW_LIST === "1") {
        replyLater(id, () => reply(id, { resources: RESOURCES }));
      } else {
        reply(id, { resources: RESOURCES });
      }
      return;
    case "resources/read":
      resourceReadReply(id, params?.uri);
      return;
    case "tools/call": {
      const name = params?.name;
      if (name === "echo") {
        const text = typeof params?.arguments?.text === "string" ? params.arguments.text : JSON.stringify(params?.arguments ?? {});
        reply(id, { content: [{ type: "text", text }], isError: false });
      } else if (name === "fail") {
        reply(id, { content: [{ type: "text", text: "boom" }], isError: true });
      } else if (name === "slow") {
        const delay = Number(process.env.FAKE_DELAY_MS ?? "500") || 500;
        setTimeout(() => reply(id, { content: [{ type: "text", text: params?.arguments?.text ?? "slow" }], isError: false }), delay);
      } else if (name === "crash") {
        process.exit(1);
      } else if (name === "dirty") {
        // 夜移 021: NUL + ESC controls, a decomposed "é", U+FFFD, and DEL.
        reply(id, { content: [{ type: "text", text: "a\x00b\x1bc\td\néf�g\x7f" }], isError: false });
      } else if (name === "wide" || name === "opaque") {
        // Echo the arguments VERBATIM as JSON so tests can assert exactly
        // what was forwarded to the server.
        reply(id, { content: [{ type: "text", text: JSON.stringify(params?.arguments ?? {}) }], isError: false });
      } else {
        replyError(id, -32602, `unknown tool: ${String(name)}`);
      }
      return;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
      return;
  }
});
