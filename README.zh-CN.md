<p align="center"><img src="assets/logo-256.png" alt="wudao-harness" width="120"/></p>

# wudao-harness

[English](README.md) | 简体中文

生产级 **agent harness**（TypeScript 实现）——包裹 LLM 的运行时骨架（agent 循环 + 工具 + 上下文 + 控制）。

> Agent = LLM + Context + Tools。harness 就是等式右边的一切。

为**推理模型**（DeepSeek / GLM / Qwen / Kimi / MiniMax）深度适配，核心与供应商无关。

## 安装

### 桌面应用（推荐）

从 [Releases](../../releases) 下载安装包：

- **macOS** — `Harness_<版本>_universal.dmg`（Intel + Apple Silicon 通用）
- **Linux** — `Harness_<版本>_amd64.deb`

### 源码安装

```bash
git clone https://github.com/feiniaojin/wudao-harness-opensource.git
cd wudao-harness-opensource
pnpm install && pnpm build
npm install -g packages/cli
```

### npm

```bash
npm install -g wudao-harness   # 待首次发布——在此之前请用 Release 安装包或源码安装
```

## 配置

设置 API 密钥（一个就够）：

```bash
# DeepSeek（默认）
export WUDAO_API_KEY=sk-your-deepseek-key

# 或使用其他供应商
export WUDAO_API_KEY=sk-your-glm-key
wudao --provider glm "hello"
```

或在项目目录建 `.env` 文件：

```bash
echo "WUDAO_API_KEY=sk-your-key" > .env
```

## 使用

### 单次执行

```bash
wudao "读 package.json 并列出所有依赖"
wudao "找出 src/ 下所有 TODO 注释"
wudao "用三句话解释这个仓库是做什么的"
```

### 交互式 TUI

```bash
wudao
```

流式输出、工具调用卡片、推理折叠、todo 看板、运行中插话（steering）、权限确认。

### Web UI

```bash
wudao ui
# → 在浏览器打开 http://127.0.0.1:<端口>/#<令牌>
```

同一会话，浏览器界面。桌面应用同样支持。

### 切换供应商 / 模型

```bash
wudao --provider glm "hello"               # GLM
wudao --provider kimi "hello"              # Kimi
wudao --provider minimax "hello"           # MiniMax
wudao --model deepseek-v4-pro "hello"      # 指定模型
```

| 供应商 | 参数 | 默认模型 |
|---|---|---|
| DeepSeek | `--provider deepseek` | `deepseek-v4-flash` |
| GLM | `--provider glm-code` | `glm-5.3` |
| Qwen | `--provider qwen` | `qwen3-max` |
| Kimi | `--provider kimi-code` | `k3-256k` |
| MiniMax | `--provider minimax-code` | `MiniMax-M3` |

## 核心特性

**Agent 循环** — 类型化状态迁移、流式 token、运行中插话（agent 工作时直接输入）、失败分类自动重试。

**工具** — 20+ 内置工具（read/write/edit/grep/glob/bash/web_search/computer_use），fail-closed 权限管线（拒绝 → 询问 → 允许 → 安全检查），并发安全批处理。

**上下文管理** — 四层模型（Session → AgentState → AgentContext → ModelInput）、cheapest-first 压缩管线（工具结果预算 → snip → microcompact → autocompact）、供应商前缀缓存字节不变量（缓存 token 绝不会因 harness 缺陷而失效）。

**会话** — append-only JSONL、恢复任意历史会话（`wudao --resume <id>`）、从任意点分叉（`/rewind`）、分支对比。崩溃安全：撕裂写下次加载自愈。

**工作流** — 用确定性 JS 脚本编排多步任务：journal 断点续跑（崩溃 → 恢复 → 零重复模型调用）、纯度检测（非确定性脚本响亮失败）、脚本级命令门（`run()` 仅允许白名单命令）。

**子代理** — 后台 agent 带角色（roster 文件）、写权限与预算、可恢复子会话、跨进程协调。

**电脑操作**（macOS）— 稳定元素 ID 的屏幕观察、点击/输入/滚动/拖拽、settle 校验（动作后等 UI 稳定）。

**扩展性** — skills（markdown 任务模板）、插件、hooks（工具调用前后拦截）、MCP 服务器、extensions（在 harness 内运行 TypeScript 或 Python 代码）。

## 包结构

| 包 | npm 名 | 职责 |
|---|---|---|
| core | `@wudao/core` | Agent 循环、工具、会话、压缩、子代理 |
| providers | `@wudao/providers` | DeepSeek/GLM/Qwen/Kimi/MiniMax 适配器 |
| cli | `wudao-harness` | CLI + TUI（`wudao` 命令） |
| web | `@wudao/web` | Web 前端（React 19） |
| server | `@wudao/server` | Web UI 的 WebSocket 服务 |
| evals | `@wudao/evals` | 确定性评估套件 |
| builtin-tools | `@wudao/builtin-tools` | read/write/edit/grep/glob/bash |

## 文档

- [完整指南](docs/GUIDE.md) — 每个特性、每个参数、每项配置
- [架构](docs/ARCHITECTURE.md) — 设计决策与层边界
- [协议](packages/server/PROTOCOL.md) — WebSocket 通信契约

## 开发

```bash
pnpm install
pnpm build          # 构建全部包
pnpm test           # 运行全部测试套件（约 5000 断言）
pnpm eval           # 确定性评估套件
```

## 许可证

MIT
