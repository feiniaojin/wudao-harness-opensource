// Example 01 — the smallest useful extension: one tool + one slash command.
//
// Install:  mkdir -p .wudao/extensions
//           cp examples/extensions/01-echo-tool.mjs .wudao/extensions/
// Try it:   wudao "call ext_echo with value=hello"
//           then in the TUI/REPL: /ext-hello Ada
//
// Everything an extension can do arrives through the single `api` object
// (see README "Extensions"). Tool names MUST start with ext_ (collision
// guard against builtin + MCP namespaces); commands must not shadow a
// builtin or plugin command name.
export default function wudaoExtension(api) {
  const { workspaceRoot } = api.meta;

  api.registerTool({
    name: "ext_echo",
    description: "Echo a value back with the workspace root attached",
    parameters: {
      type: "object",
      properties: {
        value: { type: "string", description: "Text to echo back" },
      },
      required: ["value"],
    },
    execute: async (args) => ({
      content: `echo: ${args.value} (workspace: ${workspaceRoot})`,
    }),
  });

  api.registerCommand("ext-hello", (args, ctx) => {
    // notice() prints a dim line that never enters the history;
    // submit() queues exactly one user turn through the normal prompt path.
    ctx.notice(`ext-hello got: ${args || "(no args)"}`);
    ctx.submit(`Say something nice to ${args || "the operator"}, in one sentence.`);
  });
}
