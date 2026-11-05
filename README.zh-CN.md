<p align="center"><img src="assets/pet.png" alt="wudao-harness 桌面小精灵" width="120"/> <img src="assets/power-figure.png" alt="小精灵长大之后" width="120"/></p>

# wudao-harness

[English](README.md) | 简体中文

wudao-harness 让大模型真正动手干活：它能读写你的代码、跑命令、查网页、操作电脑，把一个任务从开头做到结尾——而不只是陪聊。

配一个 API 密钥就能跑全程。主流国产推理模型均为原生适配——不是套层兼容皮：思考过程实时可见，长任务不失控、不烧钱。

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

**上下文管理** — 超长对话自动压缩：先清冗余的工具输出、再摘要旧对话，绝不动你的代码事实；缓存 token 绝不白白作废，长会话又快又省。

**会话** — append-only JSONL、恢复任意历史会话（`wudao --resume <id>`）、从任意点分叉（`/rewind`）、分支对比。崩溃安全：撕裂写下次加载自愈。

**工作流** — 用确定性 JS 脚本编排多步任务：journal 断点续跑（崩溃 → 恢复 → 零重复模型调用）、纯度检测（非确定性脚本响亮失败）、脚本级命令门（`run()` 仅允许白名单命令）。

**子代理** — 后台 agent 带角色（roster 文件）、写权限与预算、可恢复子会话、跨进程协调。

**电脑操作**（macOS）— 稳定元素 ID 的屏幕观察、点击/输入/滚动/拖拽、settle 校验（动作后等 UI 稳定）。

**扩展性** — skills（markdown 任务模板）、插件、hooks（工具调用前后拦截）、MCP 服务器、extensions（在 harness 内运行 TypeScript 或 Python 代码）。

## 包结构

| 包 | npm 名 | 职责 |
|---|---|---|
| core | `@wudao-org/core` | Agent 循环、工具、会话、压缩、子代理 |
| providers | `@wudao-org/providers` | DeepSeek/GLM/Qwen/Kimi/MiniMax 适配器 |
| cli | `wudao-harness` | CLI + TUI（`wudao` 命令） |
| web | `@wudao-org/web` | Web 前端（React 19） |
| server | `@wudao-org/server` | Web UI 的 WebSocket 服务 |
| evals | `@wudao-org/evals` | 确定性评估套件 |

## 文档

- [完整指南](docs/GUIDE.md) — 每个特性、每个参数、每项配置
- [架构](docs/ARCHITECTURE.md) — 设计决策与层边界
- [协议](packages/server/PROTOCOL.md) — WebSocket 通信契约
- [上手系列](docs/onboarding/README.md) — 新贡献者阅读路径：先常量后循环、每个机制一句箴言、参考对照表

## 开发

```bash
pnpm install
pnpm build          # 构建全部包
pnpm test           # 运行全部测试套件（约 5000 断言）
pnpm eval           # 确定性评估套件
```

## 许可证

MIT
