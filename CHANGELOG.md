# Changelog

All notable changes to wudao-harness are documented here. Format follows [Keep a Changelog](https://keepachangelog.com), versions follow [SemVer](https://semver.org).


## [0.4.21] — 2026-11-04

npm 首发面的补齐（代码与 0.4.20 相同，仅包面完善）：

- **五个库包各带 README**：core / providers / server / browser / web 的 npm 页面不再是空白（收益语言，讲清楚每个包给你什么）
- CLI 的 `wudao ui` 资源定位补上 scope 迁移漏改的拆段路径（`@wudao-org/web`）

## [0.4.20] — 2026-11-03

### Fixed — 流式思考与工作区（连续三轮用户报障的根治）
- **工具轮的分段思考不再丢失**：纯工具调用的模型调用（工具重回合的常态）此前思考整段丢弃——既不进历史也不进直播，只在回合末尾与正文一起出现；现在逐段落进转录，直播思考块整轮保持展开，TUI 历史也有思考行
- **选工作区 = 真切换**：一次点击面板根与 agent 工作目录一起动（此前只切面板、agent 留在旧目录，两步确认卡退役）
- **根切换的会话继承**：`agent_root` 条目落盘（append-only，压缩不改写），恢复/岔轮/新车道继承工作目录；桌面端启动即站上次工作区；工作区菜单新增「默认空间」一键回会话锚

### Added — 可观测体系（探针仪表盘 + 会话解剖）
- **探针仪表盘**（顶栏 📈）：模型调用/Token 流量/工具聚合/回合 KPI、60s 事件速率、实时事件流（类别过滤+暂停）；`probeStream` 支持退订，`probeEnable` 运行时翻总闸；桌面端探针默认开启
- **会话解剖页签**：系统提示词全文、消息链逐条（用户提示词/思考全文/工具调用入参/出参/异常），实时时间线配对工具入参出参与思考流——「LLM 返回的任何内容都看得见」
- **监督者车道**：`{t:"event"}` 帧带 `at` 时间戳，探针事件带 sessionId（多会话归并），OTLP trace 导出（`WUDAO_OTEL_ENDPOINT`，缺省关，观测开/关发给模型的字节逐一相等）
- **开源卫生**：SECURITY.md、issue 模板；`/memory` 测试随两库收敛改写（修复 HEAD 上的红测试）

### Fixed — 发版门禁里的根因（npm 首发前清账）
- **只读入口不再污染工作区**：长期记忆库此前一打开就 mkdir（`.wudao/memory/`）——文件树、根目录列举这类只读动作会在用户工作区里凭空造出目录。现在目录只在第一次写入时落地（读取、检索、渲染注入零文件系统副作用）
- **「关记忆」恢复为真的关**：遗留设置 `memoryEnabled:false` 在两库收敛后一度成了死键——模型仍拿到记忆读写工具。现在任一记忆开关显式关闭即整个记忆面归零（无工具、无注入、无沉淀）
- **网页标题恢复品牌名**：设计系统批把网页标题写成了「悟道 Harness」，与产品名「悟道Harness」不一致，已改回

### Added — npm 首发包面（0.4.20 首发版）
- **可发布包补齐**：`@wudao-org/server`、`@wudao-org/browser`、`@wudao-org/web` 与 CLI 同版本号 0.4.20 一并发布（此前 server/web 是 private，browser 版本号脱线——CLI 运行时依赖它们，缺一个就装不上）
- **`wudao ui` 在 npm 安装形态下可用**：前端资源定位同时认仓内目录与 `node_modules/@wudao-org/web/dist`
- **每包自带 LICENSE / README**：发版前自动搬入（npm 页面许可证栏不再是空的）

## [0.4.15] — 2026-10-29

### Added — Self-evolving assistant（小精灵自进化）
- **长期记忆系统**（M-Memory）：跨会话记忆三闭环——模型自主存取（memory_save/search/forget 工具）、新会话自动召回（字节稳定尾部注入，前缀缓存不受伤）、会话终了保守沉淀（祈使/纠错标记教训，宁缺勿滥）
- **管理记忆面板**：长期记忆条目可视管理（kind·使用次数·忘掉=tombstone）；模型记下的内容用户看得见、删得掉
- **会话恢复/追问**：`wudao --resume <id> --ask "问题"`；侧栏每条会话「追问」（fork 副本提问，原对话不动）；空状态「继续上次会话」「从历史会话提问」
- **CCB 家族插件兼容层**：直接安装上游生态插件包（`wudao plugin install <path|owner/repo|git URL>`，双格式识别+三源技能归一化+纯代码包装前拒绝）；插件面板「从来源安装」（预览→安装）
- **持久 shell**（长程任务基建）：shell_start/read/stop 三工具——长构建/watch 进程跨任务续读输出（8KB 封顶窗口、identity 不赌 pid、crash 后如实判定）
- **stopTree 停止协调器**：停止从 abort 一切升级为递归树裁决（属主校验、挂起请求全回收、admission 三态留痕）

### Added — Harness core（调研引入三弧，7 仓 60 天共性收敛）
- **压缩质量守卫**：空/截断摘要拒绝+单次短重试、reasoning 不进摘要输入、Outstanding Work 节（字节稳定）、通知累积泄漏防御
- **缓存感知压缩调度**：provider 报告用量指纹采信、缓存将死即压缩（边际成本最低）、未读大结果降级
- **预算切片续跑**：迭代上限切片化（内部续跑消息+steering 优先+上限 12）

### Changed — UI 设计规范落地（DESIGN-SYSTEM.md P1-P4）
- 字号升档（caption 12/ui 13）、字重三令牌、焦点环单线化、lang=zh-CN
- ⚠️ 位图 emoji 渲染清零（~96 处→语义色变体+细线字形）、七浮层玻璃
- 加载呼吸语言：shimmer 文字渐变（思考/工作标签）、reasoning 扫光
- **思考过程历史回放默认展开**（LLM 返回的任何内容都展示）
- 死 CSS 基线为零 + 孤儿门测试防回潮

### Infrastructure
- npm 发布管线：验证过的单文件 bundle 配方（workspace 依赖内联+createRequire）
- workflow_dispatch 跑完整发布管线（dmg/deb/exe/npm/Release）
- Windows NSIS 安装包 job；sync 脚本 node_modules 安全闸

## [Unreleased]

## [0.3.43] — 2026-09-03

### Fixed — 自动长跑与长程战役全面加固

- **管道喂入的多行指令完整送达**：以管道或 FIFO 常驻驱动时，多行输入不再被逐行切碎成多轮——空行或片刻停顿即为一条完整消息，模型一次拿到任务全貌，不再把首行当全部任务自作主张拆战役、逐条补执行（战役实测曾因此多出 12 次误开局）。
- **清屏（/clear）三端同语义**：命令行、桌面、管道三处 /clear 行为归一——旧会话立即封口、新会话干净冷启动、缓存报告如实标注「新会话冷启动」不再误报断裂；桌面端此前清屏不落盘的缺口一并补上。命令行回看中每步结果附单行预览，长会话翻阅更快。
- **每场战役永久留档**：战役台账一场一档存入 `.wudao/missions/`，不再被下一场覆盖——打过什么仗、验过什么收货，随时可考古；断电、强杀等异常退出留下的空壳战役在下次会话边界自动落定终态，不再悬空。
- **缓存观测去假警报**：推理模型的思考段计费口径、子任务链路、战役挂载/卸载等结构性冷点，观测面如实归类为「预期冷启动」，不再刷「疑似缓存断裂」；重名技能的重复提醒只说一次，真信号不再被同一行告警 ×8 刷屏淹没。
- **自动模式安全墙校准**：长跑任务的子步骤扇出不再被误拦（编辑被判高危、连只读的清点动作都被熔断拒绝），需要人工判断的场合留有救济通道，不必重启会话救场。
- **战役推进节奏不被安全检查误伤**：任务推进固有的重复动作不再触发循环熔断；隐藏目录（点开头，如 `.git/`）在文件查找中恢复可见。
- **自动化会话完整留痕**：管道驱动的会话全程落盘、可回看续接；多行工具结果在输出中不再丢行。

## [0.3.42] — 2026-09-02

### Added — 任务战役零仪式开局：不用记命令，桌面也能开

- **模型自主开战役**：任务量确实需要战役纪律（远超单上下文、跨多会话、数十上百子步骤）时，模型自己调用 `mission_start` 登记总目标开战役——用户日常丢一个大任务即可，不必先学 `/mission` 命令。工具描述自带规模纪律，常规任务不会随手开战役。
- **桌面端 / 入口打通**：桌面应用输入框直接输 `/mission <总目标>` 即可开战役/看状态/收兵——与命令行、模型自主入口共用同一本台账，任何一端开的战役三端都认。
- 开局后即引导分解：战役一经建立，下一步就是任务分解与逐个推进（`mission_plan`），进度跨会话、跨前端一致。

## [0.3.41] — 2026-09-02

### Added — 超长任务战役（/mission）：一次开局，跨会话推进到底

- **开战役**：`/mission <总目标>` 把超长任务（远超单次上下文、要跨多个会话的大工程）立为战役——自动分解任务、逐个认领推进、每个任务先过验收才算完成；中途关掉重来或掉线重启，战役从台账原样恢复，进行中的任务诚实重做。
- **验收棘轮**：某个任务验收通过后，其验收命令自动纳入战役回归套件；此后每个任务完成前全量复检已验成果——改后面的代码把前面的成果弄坏时会被当场拦下并指出是哪次完成引入的回退。
- **任务知识**：战役中的决策、约定、陷阱可以记成类型化笔记；认领新任务时未失效的约定自动回放——跨会话不再「前面定过的规矩后面忘了」。
- **战役技能包**：把领域工作法（盘点、定位、验收先行等）做成 `.wudao/mission-bundles/<名字>/skills/` 技能包，挂载进战役即随战役生效，战役结束自动卸载。

### Added — /goal 终局门与 token 预算

- `--gate "<命令>"`：用确定性命令（测试、构建、脚本）判定终局——门没绿不算完成，不浪费评估；`--budget N`：给主调用设 token 上限，预算用尽时恰做一轮收尾并如实报告用量。
- 门与预算跨重启存续：重开会话自动重新武装，约束不断档。

### Fixed — 掉线与压缩中断的恢复

- 模型流式输出中途断网/传输错误：已流出的内容不再整段丢弃（先落史、再续传重发），主调用与压缩、紧急压缩各层路径统一具备该恢复能力，单轮重试有界防抖。
- 压缩路径上的断流重发现在锚定实际溢出的那次请求（而非回合起点快照）——模型不再丢失已产出的部分输出、从头重写。

## [0.3.40] — 2026-09-01

### Fixed — 桌面端 stdio MCP 服务器连接失败（GUI PATH / 冷启动超时 / 孤儿进程）

- **启动 stdio 服务器时自动补 PATH**（2026-08-31 用户报告「MiniMax / stdio / uvx minimax-coding-plan-mcp -y / 连接失败 · spawn uvx ENOENT」）：从 Finder/Dock 启动的 app 继承 launchd 的裸 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），装在用户目录的 `uvx`/`npx` 及其依赖（homebrew 的 `realpath` 等）都找不到。stdio 子进程现在自动追加常用目录（`~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/bin`，只追加不遮蔽已有项；服务器配置里显式写的 PATH 仍然优先）。
- **MCP initialize 超时 10s → 30s**：uvx/npx 冷缓存首次安装实测 12s+，10s 把每次冷启动都判成假「连接失败」；`mcpTimeouts.connectMs` 覆盖仍生效。
- **关闭连接按进程组击杀**：`uvx` 这类 wrapper 命令底下的真正 server 进程（python 等），此前关闭时只杀 wrapper、真 server 成孤儿进程泄漏；现在 spawn 于独立进程组，优雅退出与强杀路径都整组收走。

## [0.3.39] — 2026-08-31

### Added — MCP 配置直接兼容 a reference harness 格式（2026-08-31：「我们不要自己搞一套，最好是 claude code 的直接拿来用」）

- **`mcpServers` 顶层键别名**：所有配置档（`~/.wudao/mcp.json` / `.wudao/mcp.json` / 项目根 `.mcp.json`）同时接受原生 `{"servers": {...}}` 与 a reference harness / Cursor 的 `{"mcpServers": {...}}`——CC 配置原样粘贴即可用。两键并存取 `servers` 并 warn（fail-visible）。
- **项目根 `.mcp.json` 参与分层**：a reference harness 自己的项目级 MCP 文件直接读取，CC 项目零拷贝迁移。完整层级（同名整体替换）：`~/.wudao/mcp.json` → `<root>/.mcp.json` → `<root>/.wudao/mcp.json`。
- **条目字段容忍**：CC 条目携带的 `type: "stdio"` / `cwd` 等字段由白名单校验静默容忍（stdio `command/args/env` 与 http `url/headers` 结构本就同形）。
- **防自我提权扩面**：项目根 `.mcp.json` 纳入 `PROTECTED_SETTINGS_FILES`——write_file/edit 改写它与改 `.wudao/mcp.json` 同级，bypass 免疫、任何模式必问。
- 测试：`packages/cli/tests/mcp-config.test.ts` 新增 CC 兼容组（别名、双键并存、非法形状、三层替换语义、type/cwd 容忍）。

### Added — MCP 可见性：配置了什么，一眼可见（2026-08-31：「配置之后，根本不知道自己有什么 mcp」）

- **设置页新增 MCP Tab**：三层分组列出全部已配置服务器（用户级 / 项目根 `.mcp.json` / 项目级），每组标注配置文件路径；每行显示传输方式（stdio/http）、进程可见的命令行、运行时状态（已连接 · N 个工具 / 连接失败 · 原因 / 未连接〔懒加载，非错误〕）；同名替换给回执（「替换了用户级的同名配置」）；空配置给出写入指引；刷新按钮重读。
- **`mcpList` 读 op**：driver → server → web 全链路。返回 `{servers, warnings, files}`；tier 语义 = 替换链胜者（project → root → user，最具体者胜）；配置读取警告原样上浮。旧 server 未路由 → Tab 降级「升级 wudao 后可用」。
- **密钥永不上线**：env map / http headers 绝不出现在 `mcpList` 响应；stdio 只回 `command + args`（进程列表可见内容）；http 回 `redactUrl(url)`（userinfo + query 剥离）——测试断言 `sk-secret` 不在 wire 上。
- **`/mcp` 命令分层报告**：每行标注 `source:`（三层文件归属）+ `replaces`（替换回执），空配置消息点名三个文件路径。
- 测试：`packages/cli/tests/mcp-list-op.test.ts`（op 层三层/tier 胜者/密钥红线/警告）、`packages/web/tests/mcp-tab.test.tsx`（Tab 分组/状态道/降级）、`m55b-commands.test.ts` 分层列举组。

## [0.3.26] — 2026-08-30

### Changed — 模型配置第六轮：配置模型弹框（用户反馈第五轮 2026-08-30：「配置url和key之后，点击“配置模型”按钮，弹框，可以自己输入模型名称、上下文等信息，也可以通过/models获得全部模型渲染下拉列表，选择下拉列表中的模型作为模型名称。你的设计，应该是行业通用的」）

- **详情页恒定只读行**：模型区读写两态同形——模型名 / 上下文（暗字，显示覆写值或继承来源）/ ★默认 / 当前 / 使用；页面零输入框，「配置模型」是唯一编辑入口。
- **ModelConfigModal 弹框**：打开即自动拉 `/models` 渲染下拉；名称输入即过滤；点选自动回填名称+上下文（也可纯手输双通道）；已配置模型列表行内改名/改窗口/删除；「⟳ 刷新」可重拉（key 梯子同旧：面板粘贴 key 优先，读态走服务器已存梯）。
- **保存语义**：`settingsSaveProvider` 全量回显（custom 含 label，源=打开时卡片快照）；成功后镜像面板行——RAW setDraft 直写不经 editDraft（不误标面板「未保存」）；Esc 只关弹框（stopPropagation 防设置页根 Esc 连坐退回会话）。
- **可达性保持**：每行 aria-label 唯一（空名回退「第N行」）；保存中禁用防双击；/models 响应内按名去重（首个胜出）。
- 协议层零改动；迁移 27 个旧断言 + 清理六层历史死 CSS。

## [0.3.25] — 2026-08-30

### Changed — 供应商/模型详情第五轮：读态优先 + 模型两级详情（用户反馈第四轮：「表单感太重 / 模型没有自己的详情 / 布局密度 / 视觉风格」）

- **读态默认（A）**：详情页打开是档案页——零输入框、零下拉；「编辑」是唯一入口，「取消编辑」回滚草稿退出，保存成功自动回读态。
- **模型两级详情（B）**：读态点模型行展开内嵌详情卡（生效窗口〔覆写值 + 继承来源〕、「使用」、☆ 设为默认），全程无弹窗。
- **固定列宽（C）**：编辑态模型名 22ch、上下文 10ch 固定；读态名称超长省略号、窗口列定宽右对齐。
- **状态符号化（D）**：「设为默认」文本钮 → ★/☆ 图标钮（aria-label 保留完整语义）；「当前」→ 行选中态（左脊 + 淡底 + 小 chip）。
- **全局默认条上移（E）**：「默认模型 / 推理档」从页面底部上移到工具栏正下方一条紧凑横条，打开即见；说明收进悬停 title。
- **主列对齐（F）**：供应商列表与详情列等高网格；每张卡加「N 个模型」摘要行。

## [0.3.24] — 2026-08-29

### Fixed — 供应商详情视觉重排（用户反馈第三轮 2026-08-29：「还是很难看，特别凌乱」）

- **详情头一行**：状态点 + 名称居左，provider id（mono 小字）+ 内置/自定义标签居右，不再参差两行。
- **分组 4→2**：接入（名称/baseUrl/协议 + 密钥 + 测试结果）、行为（Persona + 推理档）——砍掉只装一个字段的发丝线分组，视线不再被空标题切碎。
- **模型表改对齐单行表格**：列头（模型/窗口/状态）全表只标一次，替代每行重复的「窗口」前缀；窗口输入走固定 9.5rem 轨道，不再挤压模型名；行内状态徽章（默认/当前）靠右聚簇；「设为默认」与删除降为安静小控件。窄面板（<720px）CSS 回退两行堆叠。
- **测试结果条加状态色左脊**（ok 绿 / fail 红 / network 黄），一眼分流。

## [0.3.23] — 2026-08-29

### Added — 夜间移植弧波次 7 收官（池 #32–#40 全清）

- **#37 provider 级 429 暂停窗 + 切片重查**（a reference harness C1 语义）：单键/全键冷却时并发请求（子代理扇出）不再各自烧重试梯捶打刚说 stop 的 provider——`rate-pause.ts` 共享窗（trip/250ms 切片重查/任意 2xx 清窗自愈），Retry-After 即窗期；trip 条件 = 429 且键池无备键（多键健康时轮换更便宜），门在腿入口不在 attempt 入口（发起者自己的梯子重试不受影响）。三协议工厂同构接线，`ProviderOptions.ratePauseWindow` 注入缝。
- **#38 tier-2 零 LLM 摘要前置级**（OH C2）：`digestibleSpan` 薄叙事段（有非空 user 锚且 user ≤800 / assistant ≤1200 字符）直接走确定性 digest 组装进**同一冻结摘要形**，跳过 summarizer 调用——cheapest-first 管线的新前置档，骑件（task focus 行 / file ledger / 板恢复 / skill 重注入）原样骑上。默认开启，`zeroLlmDigest: false` 显式恢复 always-LLM；超限 span 走 LLM 路字节不变。
- **#39 压缩遗留桶**（OH B1）：`<verified-work>` 块——写后验证过的 run_command 事实（`'<cmd>' ok after N writes`）随冻结摘要跨压缩边界存活，链式再解析合并，cap 8 + 省略行协议，防"重做已完成"；plan-mode 复述行——压缩后模型仍知执行锁定。零新增状态：条目从前链摘要标签再解析 + loop 从 verify-gate 轨迹机械推导；LLM / digest / static 三路同缝携带。

### Fixed — 工程侧

- driver `/compact` 转发 `zeroLlmDigest`（此前该逃生口只对 loop 自动压缩生效，手动 /compact 静默忽略）；#38 涟漪补齐 3 处测试逃生（providers B5 调用计数、evals det-44 reactive/driver 指令编织）。

## [0.3.22] — 2026-08-29

### Fixed — 上下文窗口三连修（用户反馈 2026-08-29：「64k 是上个世纪的了」）

- **全局默认窗口 64k → 200k**：未编目模型的解析尾巴（per-model → provider 默认 → env → 编译默认）从 64000 提到 200000，全部 8 处构建点 + 4 处 options 兜底同步。
- **内建目录钉真实窗口**（只钉三家官方文档可查证的数）：deepseek v4 全线 **1M**（pricing 页单一 CONTEXT LENGTH 行）、glm-4.6 **204,800**（docs.z.ai）、qwen3-max **262,144**（阿里云 model studio）。`/model` 选择器与设置卡自动显示真窗；覆盖模型的 models 列表仍整体替换（成员资格归你）。
- **预钉保存的卡不再遮蔽真窗**：旧时代保存过的内建卡会以裸名 models 列表挤掉编译钉（真机实测 deepseek 实跑 200k）。精化语义：行内**空 contextLength = 继承**同名编译钉（显式值仍胜）——真机验证 deepseek 已回 1M。

### Fixed — 模型配置卡（用户反馈 2026-08-29 四条）

- **继承窗口提示有数**：卡片显示空窗口输入实际继承的数字（provider 默认，否则全局 200k），不再误导。
- **多模型管理**：逐行「设为默认」；徽标准确化（默认=启动默认，当前=会话现行）。
- **每行一个输入元素**：模型名与窗口分两线，不再挤压截断。
- **/models 拉取先选后加**：进内联 chips 选择器，取消即弃，零勾选禁用（弹窗太丑律）。
- **保存后模型矩阵即刷**：供应商设置保存/删除后驱动器状态快照即时重建，模型下拉不再等下一次无关 run 才见新模型。

### Fixed — 桌面端（macOS）

- **模型卡片无法复制粘贴**（「baseUrl 粘不进」）：自建菜单替换 tauri 默认菜单后缺 Edit 子菜单，macOS 的 Cmd+C/V/A 键盘等效靠主菜单 Edit 项路由到 WKWebView——逐项补齐标准 Edit 菜单（undo/redo/cut/copy/paste/select_all），零 JS 改动。

### Fixed — 工程侧

- tokens 一致性两处（pull-chip padding 越网格、pull-panel 裸 px radius）；m63 测试封闭（空 env 不再读真机 ~/.wudao）；agents-task 清理竞态（teardown rm 带重试）。

## [0.3.21] — 2026-08-29

## [0.3.21] — 2026-08-29

### Fixed — 模型下拉观感（用户反馈 2026-08-29）

- **供应商组头与模型行的视觉区分**：组头走 `.lang-head` 标签家族并大写（`deepseek` → **DEEPSEEK**，11px + 字距 + 更暗 text-3），非首组上沿发丝线作结构边界——组头读作"标签"，模型行读作"选项"，一眼可辨。
- **移除行内「端点」徽记**：组头已按供应商定位，行内再标"端点"信息冗余；跨供应商行的 lane 说明保留在悬浮提示（点击仍自动走 `/provider`，行为不变）。`env` 徽记保留（位置推不出的信息才配占位）。

## [0.3.20] — 2026-08-29

### Added — 夜间移植弧第二夜：参考项目 24 项特性移植（夜移 013-036，pi / codex / a reference harness / CCB / Strands / Reasonix / opencode，每项设计加强）+ 0.3.19 跟进

**可靠性 / 正确性**：

- **stdout 背压守卫**（夜移 034，pi output-guard 加强）：逐块回调验证 + EAGAIN/ENOBUFS/EWOULDBLOCK 10ms 退避重试 + promise-tail 串行（峰 1 在飞，帧永不交错）+ 出口空探针 flush；有界命令（perms/sessions/purge/statusline/slack）全部换道 + 直落 exit 前一律 flush；REPL SIGINT 空闲退出改走 /exit 同缝自然返回（readline pending question 在 close 后永不 settle——旧代码被迫 process.exit 的根因；现恢复 stdio 排干/session-end hook/close 清场）。
- **JSONL 残尾自愈 + 串行写**（夜移 031，pi）：崩溃残留的半行 JSONL 启动自愈 + 会话写串行化。
- **输出上限恢复梯**（夜移 013）：文本截断的 nudge-only 阶梯恢复 + `output_limit_recovery` 事件进前端史。
- **零输出 length-stop 伪装溢出分流**（夜移 033，pi overflow Case 3）：服务端截窗不报 413 只回 `length`+0 输出——诊断后换轮压缩，一次性旗防死亡螺旋。
- **会话树 token 预算**（夜移 036，codex rollout_budget）：树级硬顶记账（缓存命中免费）+ 阈值提醒 + 工具批前死；子代理共享账本按线程去重。配置面默认关（待接线）。
- **首调前持久 user**（夜移 017）：用户回合在首次模型调用前落 JSONL——提示词的崩溃安全。
- **empty-final guard**（夜移 024）+ **GLM 合法 reasoning 缺省旗**（夜移 022）+ **missing-reasoning 会话级熔断**（夜移 023）。

**可观测 / 效率**：

- **回合净变更账本**（夜移 032，codex turn_diff_tracker）：write/edit 记账 → 每回合「回合净变更 N 文件：path(新建/×N)」收据，TUI/REPL/one-shot 三面。
- **回合相位计时**（夜移 035，codex turn_timing）：六桶相位（首投影/排队/采样等待/工具/压缩/收尾）+ 请求/重试分离——「这回合为何 90s」可答。
- **/btw 缓存共享侧问**（夜移 014）：不截断主对话的侧问，历史只追加。
- **压缩摘要文件账本**（夜移 030，pi）：tier-2 压缩摘要携带文件操作账本。

**交互 / 工具面**：

- **Ctrl+P 文件匹配器换装**（夜移 019，web；真 CC file-index 范式全套）+ **模型下拉按供应商分组**（0.3.19 跟进）。
- **discover_skills 阈值搜索**（夜移 029，CCB TF-IDF）：可见技能 ≥12 才注册（字节零变化门控）；idf 饱和律=原则性停用词过滤。
- **monitor_read 按需增量读**（夜移 020，BashOutput 范式）+ **MCP 文本边界卫生**（夜移 021）+ **addTools seam/延迟 MCP 装载**（夜移 018，启动不再阻塞）。
- **memdir 读侧召回适配**（夜移 015）：memoryAge 陈旧注记 + 读侧池 200 帽 + hits 每会话一次 + **recall note 结构转义**（夜移 025）。
- **sleep 工具**（夜移 026）+ **notebook 会话草稿板**（夜移 027，压缩安全）+ **preventSleep 电源断言**（夜移 028，caffeinate 引用计数）。

**评估**：det-60~det-81 逐特性行为 pin 进发布评估矩阵（61→82 套件）。

## [0.3.19] — 2026-08-28

### Added — 反馈弧两连：模型下拉 chip（ModelSelector 替代弹窗）+ 推理档三级/语言 chip（/language session lane + web 面绑定）；det-59 行为 pin + A/B 层评估方法论收口（候选 #9）。（本条为补记，发版时遗漏）

## [0.3.18] — 2026-08-28

### Added — 夜间移植弧：参考项目 12 项特性移植（pi / codex / a reference harness / Reasonix / opencode / OpenHarness-Py / hermes / a reference harness，每项设计加强）

**可靠性 / 正确性**：

- **中断流终局化**（dsh）：用户中止已流出 delta 的回答 → 已送达文本前缀落为 `interrupted` 助手消息（持久化 flag 不上 wire，前缀缓存字节不变）+ `assistant_interrupted` 事件供 delta-blind 前端；零 delta 中止维持不追加的旧行为。
- **通用工具超时**（dsh timeout-policy，加强）：Tool 可选 `timeoutMs`，执行层竞速兜底 → 超时返回 `[timeout after Nms]` 结构化错误结果（模型下一轮可恢复）；底层 promise 不取消（弃结果不断进程）；`interruptBehavior:"block"` 工具豁免（"必须等它 settle" 是更强契约）；fail-open 缺省。
- **key-pool 状态分级冷却**（hermes credential-pool，加强）：401/403 → auth 冷却 15min（死钥停止再入选）/ 429 → rate 60s（M56 契约字节不变）/ 5xx → 不冷却（提供方全局故障惩罚单钥无意义）；跨类 max-wins；401/403 刻意不入重试阶梯（错钥是配置问题非瞬态，fail-fast——有意偏离 hermes 的 rotate-on-auth）。
- **缓存断裂取证强化**（a reference harness，加强）：detectCacheBreak 归因细分——system 行变更归因 / delta 可解释静默 / 逐出提示 / CJK 保守估计 / 截断归因，1 个旧钉测试随语义升级重写。

**模型体验（国产推理模型适配）**：

- **时间提醒注入**（codex time_reminder）：run 首轮 + 墙钟漂移 ≥30min 再注入当前时间；走 MetaNote 通道纯投影（不落盘、前缀缓存安全）；人类侧过滤时间通知（用户不需要被告知时间）。
- **in-band `<think>` 切分器**（Reasonix think.go）：vLLM chat-template 航道（`qwen-chat-template` format）把 CoT 内联进 content 流的 `<think>…</think>` 块——三律流式状态机剥离（仅 turn 起始武装，正文提及标签绝不劫持 / 跨 delta 边界 marker holdback / 未闭合块全量归 reasoning，流死不丢不倒灌）；剥出字节进 `AssistantMessage.reasoning` → 复用既有 reasoning-replay / effort 全套机制；非流式 generate 同样剥（字段存在则不动 content）。比原版好：开关零 UI 成本（format 推导，非编译期硬编码）。
- **reasoning 语言强制瞬态块**（Reasonix reasoning_language，两旋钮分离）：`WUDAO_REASONING_LANGUAGE` = auto(默认)/zh/en/off，与回答语言块独立旋钮；auto 复用 M47 detectChinese（一个检测权威，不引入第二套计数）；祈使措辞照抄实测教训（软措辞会丢第一段推理）；变体感知子代理继承（英文思考父不把子代理翻成中文思考）；`WUDAO_NO_LANGUAGE=1` 消融杀两个块。
- **LLM 会话自动命名**（dsh session-title）：source 三态（derived/manual/llm）——手动 rename 永不被覆盖；独立 system prompt 零 KV 前缀共享；querySource "title" 走后台退让阶梯（容量故障立即放弃不重试）；码点安全截断；每 driver 一次 latch；fail-closed 静默。

**权限 / 安全**：

- **凭证物 ask 门**（OpenHarness-Py credential denylist 移植，ask 分叉）：`.ssh/`、`.gnupg/`、`.aws/credentials`、`.kube/config` 等凭证段落匹配 → 新 4.65 权限层：**对 mode 免疫**（auto/plan 都 ask）**对显式授权不免疫**（settings allow 可预授权合法密钥工作流）——对 OH-Py 硬 deny 的有意分叉（capability≠policy）；REPL/TUI ask 行 🔐 警示；workflow 无人值守门同管线（`--auto` 不再可静读凭证物）。
- **run_command arity 权限规则**（opencode permission/arity，加强）：批准 `git checkout main` 记录 `run_command:git checkout` 头前缀规则而非裸 `run_command`；破坏性/未知头精确匹配（opencode arity-1 缺省会把 `python a.py` 放大成 `python *`，不学）；复合命令不记规则——**修复真实提权洞：此前批准任意一条命令 = 记裸 run_command 规则 = 全命令放行**；规则生成与匹配共享 commandHeadTokens。
- **session 规则回执**（006 收尾）：arity 规则有了真实作用域后，6 个记录点仍静默落 allowlist——`recordAskRules` 统一 seam：session-only 规则获得命名作用域回执（「no more asks this session」）、`always` 答案单次通知不双报、settings 写降级保持静默。

**输入框模型/推理强度 chips**（用户需求「推理强度、模型切换，也需要在消息输入框下方提供」）：双模式输入框下方模型 chip（打开既有 ModelPicker 弹窗）+ 强度 chip（ShieldSelector 式上拉小菜单）；busy 可切、下一轮生效，强度提交后 chip 标签即时更新。

### Fixed — 会话切换弹框 (0.3.18)

- 切换会话弹框看不到最近的会话：picker 轻信假注释「已按 mtime 倒序」直接 `slice(0,20)`，而 sessions op 实际 mtime-ASC（store.list 为 --continue 刻意升序）——超过 20 个会话时展示的是最旧 20 条。修在呈现缝：picker 自己按时间倒序再 cap。

### 测试

- **det-57 / det-58**：夜移 001-012 全部行为 pin 进发布评估矩阵（det 套件 57→59）——特性不再只有包单测；det-58 的反扫探针与 det-44 的必-ask 钉在权限边界上互相咬合。
验证：发版链逐包串行全绿——core 994 / providers 593 / server 65 / slack 71 / web 937 / evals 109（59 det）/ cli 2919（两次连续完整全绿）；cli dist 验证 0.3.18。

## [0.3.17] — 2026-08-27

### Added — 高级模式：代码高亮扩展 + 预览窗可编辑 (0.3.17)

**轨 1 —— 高亮扩展**（零依赖词法器延伸，无协议改动）：

- **三族新词法**：SQL（关键词大小写不敏感 / `--` 行注释 / `''` 转义字符串 / 数字 / 函数形态）、HTML/XML（标签名 / 属性名 / 属性值 / 注释 / 实体的独立 tokenize 分支）、CSS/SCSS（选择器段 / 属性名 / 值内字符串数字 / `$var` / `@media`）；clike 映射增补 php / objc(m,mm) / hpp / cc / hh。全部复用既有五个 token 类，零新增 CSS。
- **新着色落点**：DiffView 的 diff 行接 Tokens（语言由条目路径推导）；run_command 工具卡参数行 shell 着色（write_file 等路径型参数刻意保持单色——裸路径着色是噪音）；会话围栏代码块补钉住测试防回归。
- **路径 chip 点击打开**：edit 条目头与 write_file / read_file 卡的路径渲染为可点 chip → 打开/激活 FileViewer tab（spec 新增需求「tool 编辑的文件，点击之后要自动打开」）；简洁模式无 IDE 面板，回调缺席时退化纯文本。
- **`languageFromPath(path)`**：客户端统一的 ext→lang 纯函数，一处派生两处用（FileViewer 以它为准，server 的 `r.language` 留作兼容不删）。

**轨 2 —— 预览窗可编辑**（fileWrite op 链 + 编辑器）：

- **`fileWrite` op**（additive，driver 可选方法——老 server 未实现时编辑按钮降级隐藏，先例同 `recentWorkspaces?`）：`{path, content, base}` CAS 乐观锁——写前重读，磁盘 ≠ base 回 `conflict` + `current`（100KB 前缀）不落盘；相等才落。新建文件 = ENOENT 视作 `""`。守卫链全量镜像 fileRead：路径逃逸拒绝 → 敏感路径门（`.git/.ssh/.env/credentials`，拒绝在存在性检查之前）→ 1MB 帽 → CAS → 同目录 tmp+rename 原子写。用户手编不走模型权限门（server 路径守卫已覆盖安全面）。
- **`CodeEditor`（新组件，零依赖 overlay）**：透明 textarea 盖 token 高亮层，行号 gutter 与代码层共享字体度量同步滚动，Tab 光标处插两格（默认动作拦截），Esc 干净态退出 / 脏态忽略（退出脏文件必须走「放弃」这一明确动作）。不引 CodeMirror/Monaco（零依赖是裁定）。
- **FileViewer 编辑模式**：「编辑」按钮门控 = 文本 ∧ 非截断 ∧ 非二进制 ∧ 服务端支持 fileWrite；保存回执「已保存 path · N 行」+ 重读刷新 + 退出编辑；冲突条两出口——「用磁盘内容重开」以冲突回执的 `current` 为新底稿放弃本地，「覆盖保存」以 base=current 重试一次；守卫/IO 错走既有 `.viewer-err` 通道。`.md` 编辑强制源码态（预览 toggle 暂停，退出恢复）。

验证：发版链逐包串行全绿——core 982（`--no-file-parallelism`）/ providers 566 / web 927 / server 65 / evals 109 / slack 71 / cli 2858；五包构建 strict 过（cli `dist/version.js` 验证 0.3.17）；本弧 styles.css 新增 0 hex 字面量。

## [0.3.16] — 2026-08-27

### Fixed — 简洁模式终端式布局 (0.3.16)

用户反馈：简洁模式整个页面出现滚动条，把输入框滚出屏幕。根因：权限批准卡（`.approval`，出现时接管输入框位置）没有视口帽——一张长权限卡（长理由 + 警告 + 命令墙）把整页顶出滚动条（真 WebKit 复现：卡高 605px、`pageScrolls:true`）；进阶模式的 `.permission-card` 早已是"视口帽 + 内部滚动"范式，简洁卡没继承。三处修复：

- **页面永不滚动**：`html, body { overflow: hidden }` —— 页面级铁律。滚动只发生在各自的滚动容器里（会话流 `.chat`、设置 `.set-body`、卡片内部滚动区），任何状态都不可能再把输入框顶出屏幕。
- **会话流终端式滚动**：简洁模式会话流可上下滚但滚动条不可见（`scrollbar-width: none` + WKWebView 需要的 `::-webkit-scrollbar` 覆盖）——像终端一样；滚轮/触控板/键盘照常滚动，jump-bottom 按钮承担位置提示。
- **权限卡视口帽 + 内部滚动区**：`.approval` 上 `max-height: calc(100% - 3.5rem)` + 卡内 `.ap-scroll` 滚动区——长 ask 的文字墙在卡内滚，琥珀标题/拒绝/允许按钮/接管回执固定在滚动区外，墙再长按钮也够得着（与 `.permission-card .pc-scroll` 同一契约）。

验证：真 WebKit + Chromium ×（长会话 / 长权限卡）×（700/520px 窗口）`pageScrolls` 全 false（含 stash 回滚复现修复前 `true` 的对照）；新增确定性验收 `tests/no-page-scroll.test.tsx`（CSS 契约 + DOM 契约）；聚焦回归 10 套件 241 用例绿。

## [0.3.15] — 2026-08-27

### Added — 执行耗时可见 (0.3.15)
- **run 级耗时收据**：每个 run 落定时，history 的最后一条是 `耗时 X · 模型 Y · 工具 Z (n 次)` notice（ok/中断/出错路径都落）。模型段来自 provider 的 usage 行 durationMs（reflection/evaluator 分叉计入），工具段来自 I21 的 per-call 墙钟；脚本模型/未知网关不上报时模型段整体省略（omit-never-null，不拿 0 冒充）。slack 摘要 footer 搬运同一段文本（per-tool 仍不 relay——噪音规则）；一次性 CLI 在答案后打印同一格式。
- **LLM 回复耗时**：落定的 assistant 条目新增可选 `durationMs`（本回合最后一次 answering 调用的实测墙钟，reasoning+正文全程）。TUI 回复下方 dim 一行 `· 2.1s`；web 回复卡尾 `.reply-meta`。协议 additive-only——老 server/老前端不受影响，PROTOCOL.md 补 history 行。
- **TUI 工具行耗时**：`⏺ name(params) · 1.2s` dim 尾（I21 数据此前只在 web 活动卡渲染，TUI 一直没显示；出错调用照显——失败也花时间）。
- **TUI busy 活秒表**：状态栏 mode 段旁 `▌Ns`（客户端 1s 起表/1s 一跳，idle 退休；与 web 的 useTurnClock 同律——快照不推时钟，快回合零渲染成本）。

### Changed — 桌面应用更名 (0.3.15)
- **wudao-desktop → wudao-harness-desktop**：应用名、dmg 安装包名（`wudao-harness-desktop_<v>_<arch>.dmg`）、bundle identifier（`com.feiniaojin.wudao-harness-desktop`）与 Cargo 包名统一更名（用户需求）。**数据目录刻意保留 `~/.wudao-desktop`**——更名会静默孤儿化既有 workspace，不迁移不丢失；老版本应用需手动从 Applications 移除。

## [0.3.14] — 2026-08-27

Permission arc from the CC-vs-wudao comparison: three closes in one version — ask answers can persist as rules, accept stops asking for read-only commands, and plan becomes a fourth read-only tier.

### Added — ask 应答持久规则 p=always (0.3.14 #1)
- ask 菜单从 y/a/N 扩成 **y/a/p/N**：`p`（always）在 `a`（本会话）之上再写一条 project 档 `permissions.allow` 规则——走 `wudao permissions add allow` 同一条带免疫守卫与热重载的路径，落盘回执如实相告，写失败降级为本会话规则 + 提示（不影响本次放行）。受保护路径（settings.json/mcp.json）下的 a/p 降级为仅本次（自升级不变量）。
- Web 权限弹窗同步：`answerPermission` op 新增可选 `scope`（session/always），server 校验；a/p 两键分别映射两条规则通道，session-engine 落 allowlist + 持久化 + 回执。v1 的「web 上 a 实为仅本次」差异闭合。PROTOCOL.md 补该行。

### Changed — accept 档只读命令分级 (0.3.14 #2)
- workspace（accept）档下，`run_command` 的**安全只读命令类免问**：纯函数 `safeWorkspaceCommand`（动词白名单 ls/pwd/cat/head/tail/wc + git status/diff/log/show/blame；段切分 `;`/`&&`/`||`/换行，元字符即拒，路径不可逃出工作区，git 重定位旗标拒收，解析不出一律 false → 照旧询问）。落位第 4.7 层——操作员 deny/ask 规则仍在其上，类永不放大策略。四层文案（ShieldSelector/向导/回执/权限页）如实写明。

### Added — plan 档：只读探查 (0.3.14 #3)
- 第四权限档 **plan**（≈ CC plan mode）：READ_TOOLS 与安全只读命令放行，其余一律 deny 带 reason（写明出路——完成方案后切回 accept/auto 执行），**从不询问**（探查态不打断）。围栏落位 1.5 层（settings deny 之下、protected writes/session a、p 规则/allow 之上）：早前的 a/p 放行不得在 plan 下放大权限。
- 全表面接入：cli `--plan` 旗标 + 4 停循环（workspace→ask→auto→plan）；settings 白名单（cli 双层 + slack 远程面，垃圾值仍落 ask）；web ShieldSelector 第四档 + 回执话术 + 向导⑤；server 默认档集；PROTOCOL.md setMode 行同步（顺带把仍写着 0.3.11 档名的陈旧文档改齐）。

### Fixed
- web tokens/inkline 一致性门回到绿：0.3.13 供应商页重设计的两处字面量（.provider-card 时长 120ms→var(--dur-fast)；card-apply padding 2px→1px）与形似裸十六进制色的任务号注释（#215/#216 → task NNN）。

## [0.3.13] — 2026-08-27

Trial feedback, four fixes in one arc: the permission switcher collapses to ONE entrance (the modechip retires), the tier copy adopts the directional model (默认 workspace / 降级 ask / 升级 auto), custom providers can declare their protocol (Anthropic 协议 no longer builtin-only), and the provider maintenance page gets the persona-pass redesign.

### Changed — ONE mode switcher (0.3.13 trial feedback: "两个切换的操作区域，做的事情是一样的")
- modechip 整体退役删除：权限档唯一入口 = 输入框内的 ShieldSelector（附件旁下拉三档），`shift+tab` 键盘循环保留（对齐 a reference harness 形态）。InputBox 新增必填 `onShield` prop，SimpleComposer 转发；离线时档位切换仅走 shift+tab（盾 chip 禁用）。两处切换 UI 做同一件事的歧义消除。

### Changed — tier copy: the directional model (默认/降级/升级)
- 档位文案统一成一套方向话术：**工作区读写 = 默认**（区内自由读写，命令/网络/MCP 仍确认）、**每次询问 = 降级**（每个工具执行前确认）、**完全权限 = 升级**（全部放行）。ShieldSelector 三档 hint 与切换回执（onShield / shift+tab 两条路）走同一 `modeReceipt` 话术。行为不变——workspace 档下 run_command/web/mcp\_\*\/未知工具本就 ask（fail-closed），写入有工作区根目录符号链接加固围栏。

### Added — custom providers declare their wire (0.3.13 trial feedback: "如果我需要增加Anthropic 协议的provider怎么办")
- 注册表新增 `wire` 列：自定义供应商可选 **OpenAI 兼容（默认）/ Anthropic 协议 / OpenAI Responses**，校验成员资格。解析链 `selection.wire > WUDAO_WIRE > profile.wire`——保存过的自定义 Anthropic 网关无需环境变量兜底（EffectiveProfile 折入 wire）。未填 wire 的存量行字节不变。
- Web 端新增/编辑表单加「协议」字段（空值 = 注册表无该键的缺位语义）；内建供应商协议固定展示。整体保存回显规则：UI 不编辑的字段（wire/reasoningFormat/persona）必须原样回写。

### Changed — provider page redesign (the persona-pass house language)
- 卡片改两行层级：身份行（状态点 + 名称 + 默认标记 + 右推 Key 徽章）+ 一行安静小字（状态 · mono id · 自定义），mono 端点独占一行（省略号 + 悬停全文）；选中 = accent 边框 + 左侧内嵌竖条。
- 详情列按「接入｜凭据｜Persona」分组（每组带标题行）；间距/圆角/字号全走设计 token（tokens + shell-visual 两道 CSS 门通过）。

## [0.3.12] — 2026-08-27

Trial feedback, three fixes in one arc: the permission tiers collapse to a Claude-Code-inspired trio (workspace writable by default / ask / auto), the provider edit page gets ONE save and a de-crammed layout, and Anthropic's messages protocol becomes a first-class builtin provider.

### Changed — Permission modes: the workspace/ask/auto trio (0.3.12 trial feedback: "太复杂了")
- 模式词汇表收敛为三档：**workspace**（默认——工作区可读写，WORKSPACE_TOOLS 自动放行，工作区边界外仍走检查）、**ask**（每个工具执行前确认，META_TOOLS 除外）、**auto**（全放行）。旧值读时迁移：acceptEdits→workspace、default→ask、read-only 及垃圾值→安全侧（cli 置空回默认档，slack 落 ask）。
- 0.3.11 的「持久默认权限档」承接新词汇表：`permissions.defaultMode` 现取 workspace/ask/auto；可克隆层（project/local）仍被信任门丢弃。两入口两语义不变（设置/向导 = 新会话默认档，输入框旁 chip / shift+tab = 本会话实时档）。
- 远程面（slack）默认 **ask**：远程表面开箱不得 workspace 可写——设置档非 workspace 时 main.ts 在引擎 workspace 引导后 setMode 覆写。argv 旗标 `--auto`/`--ask`（`--read-only` 退役）；旗标 > 持久默认 > default 链不变。
- 直接构造 session 的调用方（eval det-47）镜像 main.ts 的 setMode——引擎 boot 默认 workspace 是本地交互面语义，钉住 ask 流程的面必须自己覆写。

### Changed — Web: provider detail, ONE save + de-crammed (0.3.12 trial feedback: "两个保存按钮很怪，输入框全挤在一起")
- keyrow 只留「测试连接」；唯一的「保存修改」并行触发 settingsSaveKey（keyDraft 非空时）+ settingsSaveProvider 两条独立通道——key 失败不阻塞配置保存，两笔回执各自如实相告；key 成功即清空输入。占位文案写明「随下方保存修改一并保存，仅写入本机凭据文件 0600」。
- 布局弃挤：label 列改 `6.5rem minmax(0,1fr)` 网格（persona 双列行 +9.5rem 第三轨），间距全走 4px 倍数 token（tokens 一致性门禁）。保存钮描边高亮同 persona-save 习语；≤720px 单列堆叠。

### Added — Anthropic messages wire as a builtin provider (0.3.12 trial feedback: "必须支持 Anthropic 接口协议")
- `PROVIDER_PROFILES.anthropic`：api.anthropic.com / claude-sonnet-5 / reasoningFormat "none"（thinking 走原生 effort→budget_tokens，非信封）/ windowMode "independent"（max_tokens 仅计完成侧）/ `wire: "anthropic"`（原生协议）。
- wire 解析链补第三腿：`selection.wire > 环境变量 WUDAO_WIRE > profile.wire`——选 anthropic 不再需要手动 WUDAO_WIRE；其余内建保持 wire 缺席（历史配置字节不变）。registry/卡片/切换/枚举全部从 PROVIDER_PROFILES 派生，自动出现第五行。
- 适配器本身早就在（providers/anthropic.ts 的 messages 线格式翻译）；0.3.12 补的是**可选性**：`/provider anthropic` 即用，`claude-*` 模型名走 plugins.ts 映射直达。

## [0.3.11] — 2026-08-27

The settings page's 权限档 no longer mirrors the live mode: it owns the PERSISTED default for new sessions (设置/向导 = 新会话默认档，输入框旁 chip / shift+tab = 本会话实时档). Root confusion also named: the safest shield tier was labeled 只读 while a DIFFERENT mode is read-only — renamed 每次询问.

### Added — Persisted default permission mode (0.3.11 user report: two entrances 1:1-synced)
- `permissions.defaultMode`（全局 settings.json；default/acceptEdits/auto；read-only 刻意不可持久——会话内 shift+tab 专属，起步即只读会让「设置页改不动东西」自锁）。settingsSet 白名单第 9 键，整节点合并（跨层 allow/deny 规则列表是同节点兄弟键，永不丢）。
- 信任门子键规则（sidecar.enabled 先例）：可克隆层（project/local）的 `permissions.defaultMode` 任意值一律丢弃并警告——克隆不得移动起步档（auto = 多绕一步的 bypass opt-in，even default 会与操作者全局选择打架）；规则列表照旧跨层合并。
- 起步链一条规则贯穿所有入口：**CLI 旗标 > 持久默认 > default**。`resolveInitialMode`（permission.ts，env 参数化保测试密封）；session-engine `defaultPermissionMode` prop（ui.ts 供真实全局读，直接构造测试保持密封）；TUI `initialPermissionMode` prop（index.ts runTui 传入）；`createPermissionGate` 增 `bootMode` 参数（one-shot + REPL 两处生产传解析值，缺省回退 argv——gate 永不自读 settings，测试密封）；hookCommon.mode / 启动横幅 / peer tier 同链。重启不再无声回 ask。

### Changed — Web
- 权限档设置页重绑：盾 chip 绑 `settingsStatus.settings.permissionsDefaultMode`（全局层直读，与 boot 同读），选择走 `settingsSet`，回执「新会话默认权限档 → X(已持久化;本会话仍为 Y)」；当前会话实时档只在 hint 里点名（read-only 由 shift+tab）。向导⑤ 双写（持久 + 本会话 setMode），兑现其「之后也能随时在设置里调整」承诺；⑤ 文案改「默认每次写入都会询问」。盾一档标签 只读 → **每次询问**（与真 read-only 模式的撞名是困惑根源）；SimpleComposer chip 回执同步。

## [0.3.10] — 2026-08-27

Two 0.3.9 feedback fixes: the injected-context card names its actual source (which hook/mechanism produced it), and the thinking block's double triangle collapses to one.

### Changed — Injection source labels (0.3.9 feedback)
- 注入卡署名标注来源：`HistoryEntry.notice` 增可选 `source`（append-only 第五先例）——driver 的 metaNotes 队列升级为 `{text, source}`，`take()` 时记录来源、meta_note 事件到达时整批收割（loop 把一批注记并成一个 payload、每个模型调用只 yield 一个事件，故按批配对；单线程下 take 与 yield 间无交错，splice 清空杜绝跨批泄漏）。八个 push 点全标注：SessionStart 钩子（含触发面 startup/clear/compact/resume）/ 记忆召回 / 文件变更探测 / 技能 fork / 压缩摘要 / 工作区变更 / 回滚 / 系统通道；同批多来源去重后以「 + 」连接。loop 内部注入（safety notes / 工具钩子上下文）不经驱动队列、无来源——前端回退「系统注入」。回滚清队列时已 take 未发火的来源一并清空。REPL 路径（index.ts 独立队列）本弧不动。信封与投影字节零变化（标签只进 UI 历史）。

### Fixed — Web UI
- 思考块双三角（WebKit）：`list-style: none` 在 WKWebView 管不到 `<summary>` 的原生披露三角（`::-webkit-details-marker` 是 WebKit 专属机制），原生 ▶ 与自绘 ▸ 同屏。显式 `display: none` 关掉原生标记，自绘 ▸/▾ 成为唯一三角。

## [0.3.9] — 2026-08-27

The capsule is now exclusively the harness's own state surface; model-visible injected context joins the conversation as a reply card (user-ruled boundary).

### Changed — Injected context rides a reply card (0.3.8 feedback follow-up)
- 形态边界裁定（用户）：**胶囊专属 wudao harness 内部状态展示（与 LLM/工具这些会话上下文无关）**；模型可见的注入上下文是对话内容，走回复卡。此前 meta_note 通知（superpowers 引导、记忆召回等 SessionStart/上下文注入）用居中胶囊，语义错位。
- `HistoryEntry.notice` 增可选 `card`（append-only，meta_note 置 true；↳ 前缀随胶囊形态退役）。web `InjectedCard`：署名「注 · 系统注入」（中性 glyph，不抢悟徽标 accent）+ `.reply-card` 容器 + 单行省略预览 + 展开箭头，全文块复用 detail 机制（卡内撑满、220px 内滚）；无 detail 的短注入为静态行。`card:true` 退出 noticegroup 折叠（各自独立成行）；切模式/压缩/回执等 harness 状态通知的胶囊与折叠行为不变。

### Fixed
- m72 `# found it` 旧 pin（0.3.3 标题去 # 前缀漏扫，main 红了一个版本周期——0.3.5 ui-review-r7 `# done` 同款）。

## [0.3.8] — 2026-08-27

The model's thinking process becomes visible: while it streams, the thought auto-expands and follows itself; once the body starts, it collapses to a labeled line; when the turn commits, the thought rides the reply card for later reading.

### Added — Thinking visible (0.3.7 feedback follow-up)
- 思考流式可见：driver `LiveState` 增 `thinking` 标志（`reasoning_delta` 置 true、`assistant_delta` 置 false，随既有节流广播走）——web 端思考块在思考中**自动展开**、正文第一个字落下时**自动收起**；用户手动开合后以用户为准，程序不再插手。块内 tail-follow（近底 40px 才粘底，上滚回看即松手，与 use-jump-bottom 同语义）；220px 限高内滚（与 notice-detail 同族）。此前思考块默认收起、摘要只显折叠末行，观感即"think 过程没有展示"。
- 思考留存：`HistoryEntry.assistant` 增可选 `reasoning`（append-only，durationMs/detail 之后第三个先例）——turn 落定时本轮思考流全文随最终回复进历史卡（收起态块在正文上方，点开回看；刷新/resume 后仍在）。只进 UI 历史，`state.messages` 与请求字节零变化（LLM 上下文红线）。
- summary 标签化：思考中 `▌思考中` / 落定 `思考过程 · N 字`，替代折叠末行摘要（`collapseReasoning` 随该语义退役）。

## [0.3.7] — 2026-08-26

Follow-up to 0.3.6's notice work: the truncated meta_note preview is no longer a dead-end half sentence — it carries the full text and expands in place.

### Added — Expandable notice detail (0.3.6 feedback follow-up)
- meta_note 通知可展开：`HistoryEntry.notice` 增可选 `detail`（append-only，durationMs 先例）——预览行截断/折叠丢信息时携带全文（剥信封、保留换行、信封剥除残留的 3+ 连续换行收敛为一个空行）。web 端胶囊尾部出现展开箭头（ToolCard CapToggle 同款契约），展开在胶囊下方渲染全文块（viewport-bounded 220px 内滚）；无信息丢失的短通知不带箭头、形态与 0.3.6 完全一致。0.3.6 用户截图的 `↳ <EXTREMELY_IMPORTANT> …using-s…` 半句硬切不再像错误。
- `notePreview` 增 `collapse` 参数（true=预览单行，false=detail 保留换行）。

## [0.3.6] — 2026-08-26

System notices join the conversation design language: the raw gray line becomes a centered system bubble, and the meta_note preview stops leaking the model-side projection envelope.

### Changed — Web UI notice presentation (0.3.5 feedback)
- 系统通知气泡化：`notice` 条目（切模式提示、hooks/cron/回执、压缩/转向通知等）从裸灰线升为**居中系统胶囊**（`.notice-bub`：surface-2 底 + `--radius-pill` + caption 号）——对话设计语言的第四种形态（用户右侧重音气泡 / 助手左侧回复卡 / 工具 .act 卡 / 系统 muted 胶囊居中）。"游离在会话之外"的机器文本以系统消息形态呈现；语气由通知自带前缀 emoji（⚠️ ⛔ 🪝 ⏰ …）携带，容器保持中性。noticegroup 折叠头（重复通知 ×N）同族化。三 shell 共用 `HistoryItem`，一处生效。

### Fixed — Driver notice hygiene (0.3.5 feedback)
- meta_note 人类预览不再泄漏投影信封：`notePreview` 剥掉 `<system_note>` 标签并折叠单行后截断 100 字符（0.3.5 用户截图的 `↳ <system_note> <EXTREMELY_IMPORTANT> …`）。投影信封是模型侧排版；持久化会话与请求字节不受影响（预览本就与上下文无关）。

## [0.3.5] — 2026-08-26

Two 0.3.4 user-testing fixes: the simple-mode workspace menu opens upward (it fell off the bottom of the screen), and the conversation column stops wobbling during streaming.

### Fixed — Web UI (0.3.4 feedback)
- 极简 chip 菜单方向：`.composer-tools .ws-menu` 翻转为 `bottom:100%` 向上开 —— composer 位于视口底部，原先继承的 `top:100%` 向下展开导致整张菜单出屏。树顶工作区菜单的向下不变；`max-height:220px` 内滚保留。
- 会话上下晃（tail-follow）：SimpleMode 与 App 两处相同的 render-time `atBottom` 读数在流式快速 tick 中与阈值竞速（render 在内容增长后、滚到底前 → 距离>80 翻断跟随 → 下一 tick 又翻回 = 晃动）。跟随语义整体迁入 `use-jump-bottom` 共享缝：stickRef 仅由真实 scroll 事件更新（`FOLLOW_BOTTOM_PX=80`，严格小于），hook 自带无依赖 effect 在 stuck 时每轮滚到底 —— 内容增长不触发 scroll 事件，stuck 列跨 tick 稳定粘底；三 shell（advanced/buddy/简洁）同修。上滚 ≥80px 脱离跟随，骑回阈值内（或点 ↓）重新粘底。
- 通知钉底（切模式反馈）：视图本地通知（已切换到XX模式/权限档/面板根回执等）原先永远拼接在服务端历史之后，之后所有新消息都排在其前面，通知永久钉在会话流最底。现每条通知携带 cursor（追加时的历史长度），`mergeLocalNotes` 按发生位置插进消息流 —— 通知像消息一样留在发生时刻；reset 重放收缩历史时溢出按序停靠流尾。
- ui-review-r7 的 `# done` 旧 pin（0.3.3 标题去 # 前缀遗留，红了一个版本周期）。
- Cargo.lock 的 wudao-desktop 版本漂移（0.3.0）随发版对齐。

## [0.3.4] — 2026-08-26

Simple-mode workspace switching: the 极简 composer gains a workspace chip left of 📎; the whole workspace machinery (panel re-root + agent-root confirm) becomes reachable outside the advanced file tree.

### Added — Web UI simple-mode workspace switch (2026-08-26 spec)
- `WorkspaceChip`（`📁 basename ▾`）in the simple composer's tool row, first slot LEFT of 📎 via InputBox's new optional `controlsLead` slot (absent = byte-identical surface; advanced mode untouched).
- Chip menu = 最近 5 个工作区（`recentWorkspaces`，打开时拉取）+ 打开其他目录…（Tauri 目录对话框；浏览器模式降级 CLI 提示）；断连 chip 禁用（📎 同规则）。
- A pick rides App's existing `switchPanelRoot` seam: panel root re-roots instantly (busy-safe, session preserved) and arms the `AgentRootCard` confirm — the card mounts ABOVE the simple composer, non-blocking, outside the ask-takeover conditional (advanced chatColumn idiom). 切换 agent 目录 → `agentRootSwitch`（busy 时服务端排队）；保持现状 → 本地通知。
- `useRecentWorkspaces` hook extracted from FileTree (one data path, tree-top + chip); `.ws-menu/.ws-backdrop/.ws-item/.ws-open-other/.ws-loading` promoted from `.filetree` scope to global (tree hit unchanged), chip menu anchors `.composer-tools` left edge (`min-width:220px`).

### Fixed
- workspace-switcher 旧 pin：0.3.3 审查专注按钮让 topbar icobtn 4→5（焦点测试策略漏扫的文件，本弧补上）。

## [0.3.3] — 2026-08-26

Three-mode conversation refinement: assistant replies gain a card container, streaming renders live markdown, tables parse, and the advanced IDE rebalances around the viewer.

### Added — Web UI conversation refinement (2026-08-26 spec)
- `AssistantReply` (sig row 悟/悟道 above + `.reply-card` body): one container for history replies AND the live streaming answer — buddy/advanced/simple share it.
- Live answer now renders markdown mid-stream (`StreamingMarkdown` inside the card, byte-identical to the final render); the answer moved out of the tool timeline to below the panel as the turn's conclusion.
- GFM table grammar in the markdown lexer (pipe probe marker, table-after-prose/heading opens, `<table>` render with in-card horizontal scroll, no cell wrap).
- Headings drop the literal `#` prefix; the level rides `data-level` + tier sizing.
- 审查专注 (review focus, advanced-only): `Ctrl+Shift+\` or the topbar toggle — tree collapses, chat narrows to a 320px rail, viewer takes the rest; exit restores the snapshot. Chord matches `e.code` so US layouts (Shift+\ = `|`) work.

### Changed — Advanced IDE geometry (2026-08-26 §3.3)
- Default widths rebalanced around the viewer: tree 240→220, chat 400→360.

## [0.3.2] — 2026-08-25

Interaction-quality patch: motion polish, runtime-honesty fixes for tool cards, and edit-failure visibility.

### Changed — Web UI motion & semantics (UI-4)
- Fold card / popup-menu enter animations activated (mount keyframes reusing existing fade/pop, reduced-motion covered); theme-switch body color transition.
- Slash menu `aria-activedescendant` wiring (highlighted option announced to screen readers).
- Statusline busy timer now whole-turn accumulated (paused display during permission asks resumes instead of resetting).
- Tool cards show a duration tail (`· 1.2s`) sourced from driver-emitted `durationMs` (optional protocol field, append-only).
- Sweep driver script (`scripts/pending-shoot.mjs`) landed in-repo with caret assertions (was /tmp-only).

### Fixed — Runtime honesty (UI-5)
- In-flight edits render as ◐ running cards instead of premature green ✓; busy-tool rows deduped against already-created cards (edit always; write_file when an edit card exists for the path).
- Simple-mode tool status derivation aligned with advanced mode (`isError`-based) — empty-result success cards no longer spin forever.
- Focus-return sweep: PermissionModal / ModelPicker / ClearConfirm / ResumePicker / NewChatConfirm overlays return focus to their trigger on close; AskUserCards / PlanReview inline inputs return focus on unmount.
- FileSearch / SessionPicker lists gain `aria-activedescendant` (same pattern as slash menu).
- Motion family completed: context menu, slash menu, workspace menu enter animations; advanced ToolCard result fade-in; permission-card takeover note.

### Fixed — Driver (C7-B)
- Failed or denied edits now surface a `kind:"error"` history entry (mirrors the write_file precedent) instead of silently showing success; success-path history output byte-identical.

## [0.3.1] — 2026-08-25

UI-focused patch release: session-interface visual overhaul to the mockup-v2 design baseline, subagent attachment correctness fix, and eval de-flake residue.

### Changed — Web UI overhaul (mockup-v2 parity, UI-1/UI-2/UI-3)
- Session screen: tool calls render as bordered `.act` cards (status glyph ✓/◐/✕, mono summary, collapsible result body, error variant) instead of plain mono lines; user bubbles 16px accent; pill composer (`--radius-pill` + `--shadow-2` tokens, circular send); single ◐ theme toggle in topbar.
- Viewport-bounded overlays: the whole scrim/modal/ctx-menu/permission-card family gets max-height + internal scroll (buttons always reachable); ctx menu dual-axis anchor clamp (`--ctx-x/--ctx-y`, shared `--ctx-w`/`--ctx-cap`).
- Permission asks: inline card restyled to mockup `.approval` tokens; zero global-scrim across all three ask paths (advanced/simple/buddy).
- Simple mode: busy tool cards rendered (BusyToolRow reuse); approval card gains focus-on-open + keyboard contract (y/a/n, Enter/Esc=deny fail-closed) aligned with the advanced PermissionModal.
- Streaming polish: statusline thinking segment (`▌思考中 · Ns`, hidden while an ask is pending); live-answer typing caret with prefers-reduced-motion fallback.
- Token sweep across settings/wizard/hero surfaces; visual pins re-based to the mockup baseline (no assertions weakened).

### Fixed — Subagent attachments (M80)
- Model-resolver attachment seam completed across all four construction points (agents/index, driver, REPL, TUI) — subagent/teammate histories containing images no longer throw no-attachment-store.
- `task` tool gains an `images` parameter for explicit first-message image passing to isolated subagents; unattached-image meta line (one-shot tool-schema cold-prefix, all other request bytes unchanged).
- Fail-closed guards for junk/fork/teammate/resume attachment shapes.

### Fixed — Core/evals
- `VERSION` constant release drift (0.2.7 vs 0.3.0) — version-test gate green again.
- det-49 mcp-segment fixed 80ms sleep converted to a conditional `until` wait (dead-wait residue cleared).
- conflict-origin comment precision pass + compound-corner policy-pinning test (comment-only, zero behavior change).

## [0.3.0] — 2026-08-24

Major incremental release: production-grade REPL concurrency, providers hardening, settings/persona/provider-management UI surfaces, reasoning-model adaptations, loop budget and conflict routing, and eval suite de-flaking.

### Added — REPL concurrency (report 95, R1+R2+R3)
- 3-layer turn ownership architecture: main-loop await serialization (R1 submitTurn chain) / programmatic submit gate / driver submitCore.
- R3 mid-turn stdin FIFO park (question-pending → question-only); cron/peer/monitor park discipline; SIGINT clears with diagnostic.
- M90 settle-seam hardening: try/finally around park/apply awaits so busy=false moves into finally; `!busy` else-branch guard against takeinj re-entry.
- Subagent child ToolUseContext isolation (no-op mutable setters, cloned read caches, independent abort, sidechain JSONL).

### Added — Reasoning-model adaptations (a reference harness parity)
- Anthropic thinking budget: budget_tokens low/medium/high/max (1024/2048/8192/32768), must be < max_tokens; implicit default cap raised to budget+1024.
- Explicit maxTokens vs budget conflict = fail-closed typed error (MaxTokensThinkingBudgetConflictError).
- `reasoning_content` stream separation; reasoning only re-played on tool-call turns; thinking blocks preserved across turns.
- Provider `configCapAlsoConflicts` stamp (core-owned field constant, providers import to stamp): lets core skip futile compact when config cap also conflicts.

### Added — Loop budget & conflict routing
- Cooperative per-run wall-clock budget: `maxRunMs` + injectable `now` clock; typed `run_budget_exhausted` TerminalReason.
- 413 reactive compact ladder routes clip-conflict (computed-cap) through to compact; `conflictOnComputedCap` discriminator; clip-retry catch routes to compact.

### Added — Settings / persona / provider-management UI
- 5-tab settings shell (供应商 / 权限 / 外观 / 偏好 / 插件).
- Provider management master-detail with search (100+ scale); custom provider entries; `/models` fetch + manual entry; context-length chain (per-model > provider default > env > 64k).
- Persona layer + per-provider persona binding (3-state card + parsing chain + provider-switch re-resolve); independent PersonaPanel tab; structured form.

### Added — Provider ops / hardening
- Idle watchdog for responses stream; OOM caps on three adapters; `withModelFallback` decorator; 429 Retry-After parsing with cap.
- `UnsupportedContentError("wire-no-images")` fail-closed gate on image attachments (generate + stream).
- `StreamOverflowError` (fail-loud SSE buffer cap); `MaxTokensThinkingBudgetConflictError`.
- UserProviderConfig.headers passthrough with validation; effective-profile cherry-pick isolates unvalidated fields.

### Added — CLI dispatch & wiring
- `--` end-of-options handling: splitEndOfOptions + promptFromArgv + main()-top argv pre-`--` normalization.
- `subcommandArgv(rawArgv, from)` pure helper for data-consuming subcommands (workflow/plugin/meta/sessions search).
- Spawn-face dispatch wiring tests (`perms lint` / `--` passthrough / non-subcommand prompt) — pure test, no product changes.

### Added — Sessions / events / hooks
- 4-back-end event bus (command/prompt/http/agent) + workspace trust gate.
- Session append-only JSONL with UUID+parentUuid chain; resume to last compact boundary; child sessions isolated sidechains.
- Permission hooks: 5-layer pipeline + bypass-immune safety checks (deny rule → ask rule → tool.checkPermissions → .git/.claude/shell-rc) surviving `bypassPermissions`.
- headless deny-by-default.

### Changed
- Cache-byte stability (M24): system prompt sections memoized; explicit cache-breaking requires reason; tool list prefix stable; child agent freezes parent prompt bytes.
- Compact ladder cheapest-first: tool-result-budget → snip → microcompact → context-collapse → autocompact → reactive (on real 413).
- Tool result budget (`maxResultSizeChars`): oversized results spill to disk with "path + preview"; Read not limited.

### Fixed — Eval determinism (this release closes the load-sensitive flake family)
- `det-51-workspace-dual-root` 4s `until()` cap → 15s (precedent: det-55-persona).
- `det-49-m63-hooks2` SessionEnd budget window [1200, 2100] → [1200, 3000]; `wait(300)` asyncRewake → conditional until. 4 residual `wait(120)` (once/if + skill-scope) → conditional waits with discriminability pins.
- `det-21` / `det-39` fixed 50ms waits on fire-and-forget file writes → conditional polling until real write lands.
- `suites.test.ts` 120s file cap → scaled `60_000 + 1_000 * suiteCount` (117s @ 57 suites, 3.6× measured margin).
- `phase2b` conditional waits to det-51 hooks path.

### Fixed — Other
- REPL settle-seam product bug: busy=false must emit AFTER parked agentRootSwitch lands.
- agentRootSwitch (M58-C workspace-ux) idle/busy/settle ordering.
- Various CLI tsc strictness gaps from session merge drift.
- settings layer path / name resolution; remote capability URL mode port wildcard (`http://127.0.0.1:*`).

### Security
- Image attachments fail-closed when no resolver (no silent drop).
- Bypass-immune safety checks survive `bypassPermissions` mode.
- Settings.json `protectedPaths` tier separation (cloneable tier may tighten, never relax).

### Notes
- Authoritative ledger: `docs/research/40-import-queue-2026-08-22.md`.
- Design DNA: `CLAUDE.md` §3 + `docs/research/03-design-dna-and-recommendations.md`.
- Architecture reference: a reference harness-sourcemap / open-harness / a reference harness / pi (learning); NOT mini-pi (demo-grade).

[0.3.0]: https://github.com/feiniaojin/wudao-harness/releases/tag/v0.3.0