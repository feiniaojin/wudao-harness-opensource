#!/usr/bin/env node
// Fake LSP server for tests — Content-Length framed JSON-RPC 2.0 over stdio
// (P2-9). Deterministic, scriptable, CI-safe (no real tsserver).
//
// Wire shape (both directions):
//   Content-Length: <utf8 bytes>\r\n\r\n<json>
//
// Behavior:
// - On boot: appends {"boot": pid} to $FAKE_LSP_LOG (the lazy-start test
//   reads its ABSENCE as "no process spawned").
// - Every received frame is appended to $FAKE_LSP_LOG as a JSON line
//   ({"recv": <msg>}) — tests assert exact message sequences from it.
// - Before answering anything, emits a server→client NOTIFICATION
//   (window/logMessage, no id) — pending requests must not mispair on it.
// - After the initialize RESPONSE, sends a server→client REQUEST
//   (workspace/configuration, id 9000) — the client must auto-respond or a
//   real server would wedge; the fake logs the client's response frame.
// - initialize → capabilities {hover,definition,references,textDocumentSync:1}.
// - initialized → notification, no reply.
// - textDocument/didOpen → records the doc (count per uri, version 1).
// - textDocument/didChange → updates the recorded text (full sync).
// - textDocument/definition → TWO locations: (a) the SAME uri at
//   {line: pos.line+10, character: pos.character+2}, (b) the uri's last path
//   segment replaced with "sibling.ts" at {0,0}. FAKE_LSP_MANY=1 → 150
//   locations in the same uri (cap tests).
// - textDocument/references → THREE locations (line 1..3, char 1) in the
//   requested uri.
// - textDocument/hover → markdown embedding the doc's didOpen count and the
//   languageId ("didOpens: N · languageId: typescript · ```typescript
//   function foo(a: number): void```"). FAKE_HOVER_NULL=1 → null.
//   FAKE_HUGE_HOVER=1 → a 3000-line hover body (output-cap tests).
// - FAKE_LSP_DELAY_MS=<n> → every response delayed n ms (timeout tests).
// - FAKE_LSP_CRASH_ON=<method> → process.exit(1) when that request arrives
//   (crash/rebuild tests).
// - FAKE_LSP_GARBAGE=1 → writes an unframed garbage line at boot (the client
//   must die fail-closed, never hang).
// - FAKE_TRAP_SIGTERM=1 → swallow SIGTERM + hold the event loop (bounded
//   close / SIGKILL fallback tests).
// - Any other request with an id → JSON-RPC error -32601.
import { appendFileSync } from "node:fs";

const LOG = process.env.FAKE_LSP_LOG;

function log(entry) {
  if (!LOG) return;
  try {
    appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    // a broken log path must never take the server down
  }
}

function frame(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

log({ boot: process.pid });

if (process.env.FAKE_LSP_GARBAGE === "1") {
  process.stdout.write("this is not a frame at all\n");
}

if (process.env.FAKE_TRAP_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
}

// Server→client notification before anything else: notifications (no id)
// must never be paired with a pending request.
frame({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "fake-lsp up" } });

const docs = new Map(); // uri → { text, languageId, version, opens }

function siblingUri(uri) {
  return uri.replace(/[^/]+$/, "sibling.ts");
}

function definitionLocations(params, many) {
  const uri = params.textDocument.uri;
  const p = params.position;
  if (many) {
    return Array.from({ length: 150 }, (_, i) => ({
      uri,
      range: { start: { line: p.line + i, character: p.character }, end: { line: p.line + i, character: p.character + 1 } },
    }));
  }
  return [
    { uri, range: { start: { line: p.line + 10, character: p.character + 2 }, end: { line: p.line + 10, character: p.character + 2 } } },
    { uri: siblingUri(uri), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
  ];
}

function reply(id, result, method) {
  const delay = Number(process.env.FAKE_LSP_DELAY_MS ?? "0") || 0;
  const once = process.env.FAKE_LSP_DELAY_ONCE === "1";
  // The once-mode delays the FIRST content request only (initialize/shutdown
  // are lifecycle roundtrips — delaying them would turn a request-timeout test
  // into a handshake-timeout test).
  const delayThis = delay > 0 && (!once || (!delayedContent && method !== "initialize" && method !== "shutdown"));
  const send = () => frame({ jsonrpc: "2.0", id, result });
  if (delayThis) {
    delayedContent = true;
    setTimeout(send, delay);
  } else {
    send();
  }
}
let delayedContent = false;

function replyError(id, code, message) {
  frame({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleMessage(msg) {
  log({ recv: msg });
  const { id, method, params } = msg;

  // A RESPONSE from the client (id, no method): the auto-reply lane — nothing
  // further to do; the log line above is the observable.
  if (method === undefined) return;

  if (method === "initialize") {
    reply(id, {
      capabilities: {
        textDocumentSync: 1, // full
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
      },
      serverInfo: { name: "fake-lsp" },
    }, method);
    // Real servers (typescript-language-server included) issue server→client
    // requests right after initialize; a client that never answers wedges them.
    frame({
      jsonrpc: "2.0",
      id: 9000,
      method: "workspace/configuration",
      params: { items: [{ scopeUri: params?.rootUri, section: "typescript" }] },
    });
    return;
  }
  if (method === "initialized") return; // notification
  if (method === "shutdown") {
    reply(id, null, method);
    return;
  }
  if (method === "exit") return; // notification — the process exit follows from the parent

  if (process.env.FAKE_LSP_CRASH_ON === method) {
    log({ crash: method });
    process.exit(1);
  }

  if (method === "textDocument/didOpen") {
    const td = params.textDocument;
    const prev = docs.get(td.uri);
    docs.set(td.uri, { text: td.text, languageId: td.languageId, version: td.version, opens: (prev?.opens ?? 0) + 1 });
    return;
  }
  if (method === "textDocument/didChange") {
    const td = params.textDocument;
    const prev = docs.get(td.uri) ?? { opens: 0, languageId: "typescript" };
    const text = params.contentChanges?.[params.contentChanges.length - 1]?.text ?? "";
    docs.set(td.uri, { ...prev, text, version: td.version });
    return;
  }
  if (method === "textDocument/definition") {
    reply(id, definitionLocations(params, process.env.FAKE_LSP_MANY === "1"), method);
    return;
  }
  if (method === "textDocument/references") {
    const uri = params.textDocument.uri;
    reply(id, [
      { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
      { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
      { uri, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } },
    ], method);
    return;
  }
  if (method === "textDocument/hover") {
    if (process.env.FAKE_HOVER_NULL === "1") {
      reply(id, null, method);
      return;
    }
    if (process.env.FAKE_HUGE_HOVER === "1") {
      const value = Array.from({ length: 3000 }, (_, i) => `hover line ${i}: ${"x".repeat(20)}`).join("\n");
      reply(id, { contents: { kind: "markdown", value } }, method);
      return;
    }
    const doc = docs.get(params.textDocument.uri);
    const opens = doc?.opens ?? 0;
    const lang = doc?.languageId ?? "?";
    reply(id, {
      contents: { kind: "markdown", value: `didOpens: ${opens} · languageId: ${lang}\n\n\`\`\`typescript\nfunction foo(a: number): void\n\`\`\`` },
    }, method);
    return;
  }

  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
}

// stdin framing: accumulate bytes, split on Content-Length.
let buf = Buffer.alloc(0);
const TERM = Buffer.from("\r\n\r\n", "ascii");
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const term = buf.indexOf(TERM);
    if (term === -1) return;
    const header = buf.subarray(0, term).toString("ascii");
    let len = -1;
    for (const line of header.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon !== -1 && line.slice(0, colon).trim().toLowerCase() === "content-length") {
        len = Number(line.slice(colon + 1).trim());
      }
    }
    if (!Number.isInteger(len) || len < 0) {
      // Unrecoverable — behave like a broken server and die loudly.
      process.exit(2);
    }
    const bodyStart = term + TERM.length;
    if (buf.length < bodyStart + len) return; // partial body
    const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");
    buf = buf.subarray(bodyStart + len);
    try {
      handleMessage(JSON.parse(body));
    } catch {
      // a malformed message must not kill the loop
    }
  }
});
process.stdin.on("end", () => {
  // Parent closed stdin without shutdown — exit promptly (the parent's close()
  // ladder treats EOF as the graceful signal). The SIGTERM-trap variant stays
  // alive on purpose: the close ladder must still bound it (SIGKILL fallback).
  if (process.env.FAKE_TRAP_SIGTERM === "1") return;
  process.exit(0);
});
