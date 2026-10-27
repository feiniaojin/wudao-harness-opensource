# Agent role examples

Roster profiles for `.wudao/agents/<role>.json` — the harness layers them
over the builtin roles (builtin < plugin < workspace; a workspace file with
a builtin's id shadows it and the shadowing is reported, never silent).

## Install

```bash
mkdir -p .wudao/agents
cp examples/agents/explorer.json .wudao/agents/
```

Then dispatch with the task tool (the model does this on its own when the
role's description matches the work):

```text
task({ description: "map the auth area", prompt: "…", role: "explorer" })
```

## Index

| File | Role | What it pins |
| --- | --- | --- |
| `explorer.json` | `explorer` | Read-only terrain mapper (`read_file`/`glob`/`grep`, 15 turns). The cheap first pass over unfamiliar code. |
| `reviewer.json` | `reviewer` | Adversarial reviewer **frozen** to `deepseek`/`deepseek-chat` @ high effort (25 turns): dispatchable, not reconfigurable — provider/model/effort overrides fail closed. |

## Schema (the fields that matter)

```jsonc
{
  "description": "…",         // required — what the model sees when picking a role
  "systemPrompt": "…",        // the child's identity (body of the brief)
  "toolNames": ["read_file"], // absent → the read-only default set
  "provider": "deepseek",     // optional pin (with frozen: true → overrides refuse)
  "model": "deepseek-chat",
  "reasoningEffort": "high",
  "maxTurns": 25,             // default turn budget (adaptive budgets sample on top)
  "frozen": true,             // refuse caller provider/model/effort overrides
  "worktree": true,           // run children in a dedicated git worktree
  "writeScope": { "roots": ["src/lib/"] }, // fail-closed writable paths
  "allowShell": false         // exempt shell from the write-scope guard
}
```

For CC-format agent files (`agents/*.md` inside a plugin) see
`examples/plugins/demo/agents/` — frontmatter `name/description/tools?/model?`
plus the markdown body as the system prompt, translated read-only into this
same roster's plugin layer.
