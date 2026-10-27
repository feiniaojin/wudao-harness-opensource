// Example 03 — the session-entry channel: appendEntry / readEntries + a
// run_stop observer that logs how each run ended.
//
// Install:  mkdir -p .wudao/extensions
//           cp examples/extensions/03-session-notes.mjs .wudao/extensions/
// Try it:   run any wudao session in this workspace, then in the next one:
//           wudao "call ext_session_notes and summarize what I did last time"
//
// Entries ride the session's own JSONL (the M35 generic-entry channel),
// namespaced by `type` — pick a distinctive one, the namespace is shared
// with model_change / deferred_loaded / … . Entries are bound once the
// run's session exists; before that appendEntry warns and drops.
export default function wudaoExtension(api) {
  const NOTE_TYPE = "session_note";

  api.registerTool({
    name: "ext_session_notes",
    description: "Read this session's extension entries (notes + run summaries recorded by 03-session-notes)",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const entries = await api.readEntries();
      const notes = entries.filter((e) => e.type === NOTE_TYPE || e.type === "run_summary");
      if (notes.length === 0) {
        return { content: "No session notes recorded yet in this session's JSONL." };
      }
      const lines = notes.map((e, i) => `${i + 1}. [${e.type}] ${JSON.stringify(e.data)}`);
      return { content: `Session entries (${notes.length}):\n${lines.join("\n")}` };
    },
  });

  // A note command: /note remember to rerun the evals
  api.registerCommand("note", (args, ctx) => {
    if (!args || args.trim() === "") {
      ctx.notice("usage: /note <text> — appends a note entry to this session");
      return;
    }
    void api.appendEntry(NOTE_TYPE, { text: args.trim(), at: new Date().toISOString() });
    ctx.notice(`note recorded (${NOTE_TYPE})`);
  });

  // Every run end is summarized into the same channel.
  api.on("run_stop", (p) => {
    void api.appendEntry("run_summary", {
      messages: p.messageCount,
      lastAssistant: (p.lastAssistant ?? "").slice(0, 200),
    });
  });
}
