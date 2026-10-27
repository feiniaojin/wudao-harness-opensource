// 持久 bash（prime-agent #3640 引进弧）——cli 工具三件：shell_start /
// shell_read / shell_stop。机制与存储全在 core（persistent-shell.ts——
// 记录/封顶窗口/进程注册表/清理）；本文件只做 buildTool 包装（fail-closed
// 参数校验、风险标注、模型教学文案），风格对齐 shell / python_kernel 家族。
//
// 工具教学面（任务书的原话）：长构建/watch 进程用持久 shell，跨任务续读
// 输出——shell 工具是「跑一条命令拿结果」，这里补的是「起一个跨任务边界
// 活着的进程，反复读它的输出、最终停掉它」。压缩摘要的 Outstanding Work
// 会点名存活 shell（driver 接线），模型压缩后凭 id 续读——跨任务恢复指针。
//
// 挂载纪律：top-level only（子代理/工作区子集不带——进程生命周期归父会话
// 管）；APPEND-ONLY TAIL（M24：新槽位=声明过的跨版本一次性冷点）；沙箱会
// 话零注册（沙箱里的 shell 走 docker，host 直起的持久进程是逃逸面——
// browser 家族的 fail-closed 缺席姿态，不是 monitor 的注册+拒绝姿态）。
import {
  buildTool,
  commandLooksDestructive,
  persistentShellRuntime,
  readShellOutput,
  truncateSafe,
  type PersistentShellStatus,
  type Tool,
} from "@wudao/core";

const strArg = (v: unknown): string => (typeof v === "string" ? v : "");

/** 回执里命令行的展示帽（outstanding-work note 60/命令行回执 200 的折中）。 */
const COMMAND_DISPLAY_CHARS = 200;

const commandLine = (command: string): string =>
  command.length > COMMAND_DISPLAY_CHARS ? `${truncateSafe(command, COMMAND_DISPLAY_CHARS)}…` : command;

/** 三态状态行的模型面渲染（vanished 用任务书钦定的中文文案）。 */
function stateLine(s: PersistentShellStatus): string {
  switch (s.state) {
    case "running":
      return s.owned
        ? `state: running (pid ${s.pid ?? "?"})`
        : "state: running (owned by another harness process — output may lag)";
    case "finished":
      return `state: finished (exit ${s.exitCode ?? "?"})`;
    case "vanished":
      return "state: 进程已消失，输出保留 — the harness process that owned this shell is gone; the process cannot be read or stopped, only this output window remains";
  }
}

export function createPersistentShellTools(opts: {
  /** 工作区锚：.wudao/shells 的家 + 子进程 cwd（boot root——todo/notes 家族
   *  的同款纪律，agentRootSwitch 不搬运行时数据目录）。 */
  readonly workspaceRoot: string;
}): readonly Tool[] {
  const root = opts.workspaceRoot;
  const runtime = persistentShellRuntime(root);

  return [
    buildTool({
      name: "shell_start",
      description:
        "Start a PERSISTENT background shell with NO timeout — for long builds, full test suites, dev servers and watch processes that outlive a single tool call. " +
        "Returns a shell id immediately; the shell keeps running while you do other work. " +
        "Read its output across turns with shell_read(id) (recent output is always at the end of a bounded head+tail window), stop it with shell_stop(id). " +
        "Alive shells are listed in compaction summaries, so you can keep polling after context compaction; after a harness restart the record survives but the process is reported gone. " +
        "Use the plain shell tool for quick commands — it returns output directly. " +
        "The shell has NO stdin and NO timeout: commands that wait for interactive input hang forever — pass every flag and answer explicitly (e.g. --yes, -y, CI=1).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run in the background (runs via sh -c in the workspace root)." },
          description: { type: "string", description: "One line saying what this shell is for (shown in the start receipt)." },
        },
        required: ["command"],
        additionalProperties: false,
      },
      // 起进程 = 与 shell 同级信任：永不只读、开放世界、按命令破坏性分类
      // （commandLooksDestructive 的保守首词/形态扫描，shell 同款单一真值点）。
      isReadOnly: () => false,
      isDestructive: (args) => commandLooksDestructive(strArg(args.command)),
      isOpenWorld: () => true,
      isConcurrencySafe: () => false,
      async execute({ command, description }) {
        if (typeof command !== "string" || command.trim() === "") {
          return { content: 'shell_start failed: "command" must be a non-empty string', isError: true };
        }
        const r = runtime.start(command);
        if (!r.ok) {
          return { content: `shell_start failed: ${r.error}`, isError: true };
        }
        const head = typeof description === "string" && description !== "" ? ` — ${truncateSafe(description, 80)}` : "";
        return {
          content:
            `[persistent shell ${r.record.id}] started${head} (pid ${r.pid}, no timeout)\n` +
            `$ ${commandLine(command)}\n` +
            `poll with shell_read(id: "${r.record.id}") — stop with shell_stop(id: "${r.record.id}")`,
          isError: false,
        };
      },
    }),
    buildTool({
      name: "shell_read",
      description:
        "Read the current output window and running state of a persistent shell (started with shell_start). " +
        "The output is a bounded head+tail window — the middle of very long output is a [... N bytes truncated ...] marker; the LATEST output is always at the end. " +
        "Polling the same shell id repeatedly is the designed cadence for watching a long build. " +
        "Call WITHOUT an id to list every persistent shell of this workspace (id, state, command).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The shell id from shell_start. Omit to list all persistent shells." },
        },
        additionalProperties: false,
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      // ω99-30 (C)：读同一 shell 的窗口是设计的轮询节奏（mission_next 同款
      // 豁免理由）——identical shell_read(id) 重复是 watch 语义，不是卡环。
      loopExempt: () => true,
      async execute({ id }) {
        if (id === undefined) {
          const rows = runtime.list();
          if (rows.length === 0) {
            return { content: "[persistent shells] none — start one with shell_start(command)", isError: false };
          }
          const lines = rows.map(
            (s) => `  ${s.record.id}  ${s.state === "finished" ? `finished(${s.exitCode ?? "?"})` : s.state === "running" ? (s.owned ? `running(${s.pid ?? "?"})` : "running(other)") : "vanished"}  $ ${truncateSafe(s.record.command, 80)}`,
          );
          return { content: `[persistent shells] ${rows.length}\n${lines.join("\n")}`, isError: false };
        }
        if (typeof id !== "string" || id.trim() === "") {
          return { content: 'shell_read failed: "id" must be a non-empty string (or omitted to list all shells)', isError: true };
        }
        const s = runtime.status(id);
        if (s === undefined) {
          return { content: `shell_read failed: unknown shell id "${id}" (call shell_read without an id to list them)`, isError: true };
        }
        const output = readShellOutput(root, id);
        const body = output === "" ? "(no output yet)" : output;
        return {
          content: `[persistent shell ${s.record.id}] $ ${commandLine(s.record.command)}\n${stateLine(s)}\n---- output ----\n${body}\n---- end ----`,
          isError: false,
        };
      },
    }),
    buildTool({
      name: "shell_stop",
      description:
        "Stop a persistent shell: TERM to its whole process group, escalating to KILL after 2s; reports the exit code. " +
        "The collected output window stays readable afterwards via shell_read. " +
        "Stopping a shell whose process is already gone (进程已消失) is a no-op refusal — its output is kept.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The shell id from shell_start." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      isDestructive: () => true,
      isOpenWorld: () => false,
      isConcurrencySafe: () => false,
      async execute({ id }) {
        if (typeof id !== "string" || id.trim() === "") {
          return { content: 'shell_stop failed: "id" must be a non-empty string', isError: true };
        }
        const r = await runtime.stop(id);
        switch (r.kind) {
          case "stopped":
            return {
              content:
                `[persistent shell ${id}] stopped — group TERM→KILL delivered\n` +
                `exit code: ${r.exitCode === undefined ? "unavailable (kill raced the close receipt)" : r.exitCode === -1 ? "none (killed by signal)" : String(r.exitCode)}\n` +
                `output window kept — shell_read(id: "${id}") still works`,
              isError: false,
            };
          case "finished":
            return {
              content: `[persistent shell ${id}] already finished (exit ${r.exitCode ?? "?"}) — nothing to stop; shell_read still works`,
              isError: false,
            };
          case "foreign":
            return {
              content: `[persistent shell ${id}] 进程已消失，输出保留 — no live process owned by this harness (it belongs to another session or died with a restart); there is nothing here to stop, and a pid from disk is never signalled`,
              isError: false,
            };
          case "unknown":
            return { content: `shell_stop failed: unknown shell id "${id}" (call shell_read without an id to list them)`, isError: true };
        }
      },
    }),
  ];
}
