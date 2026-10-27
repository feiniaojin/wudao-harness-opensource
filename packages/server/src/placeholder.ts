// 借鉴弧 α2/α1 顺带拆分（文件行数棘轮「把压力推向拆分」）：v1-A 的占位
// 页（静态 HTML 字符串，零捕获）外提独立模块——server/index.ts 的行数
// 帽留给出入车道。行为逐字节一致（纯搬家）。
export function placeholderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wudao ui — protocol v1</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem auto; max-width: 46rem; padding: 0 1rem; }
  h1 { font-size: 1.1rem; } dt { font-weight: bold; } dd { margin: 0 0 .6rem; }
  #state { white-space: pre-wrap; border: 1px solid gray; padding: .6rem; min-height: 3rem; }
  .dim { opacity: .6; }
</style>
</head>
<body>
<h1>wudao ui</h1>
<p>Placeholder page — the web frontend is not built yet (v1-A serves the protocol first; see PROTOCOL.md).</p>
<p>This page IS a live reference client: it authenticates with the token from the URL fragment and streams the driver's state + history.</p>
<p id="conn" class="dim">connecting…</p>
<h2>state</h2>
<p id="state"></p>
<h2>history</h2>
<p id="history"></p>
<script>
const token = decodeURIComponent(location.hash.slice(1));
const conn = document.getElementById("conn");
const stateEl = document.getElementById("state");
const historyEl = document.getElementById("history");
let history = [];
const ws = new WebSocket("ws://" + location.host);
ws.onopen = () => ws.send(JSON.stringify({ t: "auth", token }));
ws.onclose = () => { conn.textContent = "disconnected (auth failed or server closed)"; };
ws.onerror = () => { conn.textContent = "connection error"; };
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  if (f.t === "state") { conn.textContent = "connected"; stateEl.textContent = JSON.stringify(f.state, null, 1); }
  else if (f.t === "history") { history = f.reset ? f.entries : history.concat(f.entries); historyEl.textContent = history.map((e) => e.kind + ": " + (e.text ?? e.summary ?? "")).join("\\n"); }
};
</script>
</body>
</html>
`;
}
