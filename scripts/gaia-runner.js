// GAIA benchmark runner (M11 workflow engine)
// Usage: wudao workflow run gaia-runner.js --args '{"tasks": [...]}' --budget-tokens 500000
// Resume: wudao workflow run gaia-runner.js --args '...' --resume <runId>

const results = [];
const total = args.tasks.length;
let passed = 0;

for (let i = 0; i < total; i++) {
  const t = args.tasks[i];
  log({ progress: `${i + 1}/${total}`, id: t.id.slice(0, 8), level: t.level });

  const r = await task(
    `Answer this question. Use available tools to research if needed.\n\n${t.question}\n\nReply with ONLY a JSON object like: {"answer": "your answer here"}`,
    {
      label: `gaia-${t.id.slice(0, 8)}`,
      retry: 0,
      maxTurns: 15,
      allowTools: ["grep", "read_file", "run_command", "web_search", "glob"],
      responseSchema: { type: "object", required: ["answer"], properties: { answer: { type: ["string", "number"] } } },
    }
  );

  // Structured output: responseSchema guarantees {answer: string}
  const got = r.ok
    ? String((r.data ?? {}).answer ?? r.text ?? "").trim().toLowerCase().replace(/[.,!?;:]+$/, "")
    : "";
  const want = String(t.want).trim().toLowerCase().replace(/[.,!?;:]+$/, "");
  const ok = got === want;
  if (ok) passed++;
  results.push({ id: t.id, level: t.level, ok, got: got.slice(0, 200), want, wall_s: 0 });
}

log({ summary: { passed, total, passAt1: (passed / total * 100).toFixed(1) + "%" } });
return { results, passed, total, passAt1: passed / total };
