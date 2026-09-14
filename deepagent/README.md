<div align="center">
  <img src=".github/images/logo-icon.svg" width="80" height="80" alt="Deep Agents Logo">

# Deep Agents - 本地部署 Chat UI

基于 <a href="https://github.com/langchain-ai/deepagents">Deep Agents</a> 框架的本地部署版 Web 聊天界面，接入 DeepSeek v4 Flash 模型。
</div>

<br>

## 概述

本项目是 LangChain **Deep Agents** 框架的本地部署版本，附带一个自定义的 Web 聊天界面（类似 DeepSeek Chat 或 ChatGPT）。

### 核心能力

- **Web 聊天界面** — 浏览器端会话管理、流式输出、消息历史，按时间自动分组
- **完整框架能力** — Shell 执行、文件系统访问、子 Agent、技能系统、持久化记忆等
- **任务计划面板 (Todo)** — Agent 用 `write_todos` 规划任务，会话流中实时展示进度与状态切换
- **文件安全审批 (HITL)** — 读取直接放行；修改文件弹出审批卡片等待人工确认；创建/删除文件禁止操作
- **持久化记忆** — SQLite Checkpoint + Store，Agent 图状态与长期记忆跨重启保留
- **Agent Loop 可视化** — 右侧面板实时展示每个节点（model/tools）的执行信息
- **联网搜索** — 输入框左下角可开关的「智能搜索」按钮，基于 DuckDuckGo（无需 API Key）
- **天气查询** — 专用 `get_weather` 工具，返回结构化中文天气摘要
- **CRM 子代理** — 统计与分析由专属子 Agent 处理，主 Agent 统一委派
- **网页抓取** — Agent 可自动读取任意 URL 内容并摘要（JSON API 自动压缩摘要）
- **日期/时间感知** — Agent 知晓当前日期和时间，支持任意时区
- **DeepSeek 集成** — 通过 OpenAI 兼容 API 接入 DeepSeek v4 Flash
- **本地运行** — 完全在本地执行，无云端依赖

## 快速开始

### 环境要求

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) 包管理器

### 安装依赖

```bash
# 安装各包的依赖
cd libs/deepagents && uv sync --all-groups
cd ../code && uv sync --all-groups
cd ../cli && uv sync --all-groups
cd ../../chat-ui
# 持久化记忆所需的 SQLite 组件（Chat UI 默认已安装）
uv pip install --python .venv/Scripts/python.exe langgraph-checkpoint-sqlite
```

### 配置模型

创建 `chat-ui/.env` 文件（不会上传到 GitHub）：

```ini
OPENAI_API_KEY=你的deepseek_api_key
OPENAI_BASE_URL=https://api.deepseek.com/v1
```

参考 `chat-ui/.env.example` 模板。

### 启动

```bash
# 方式一：启动 Web Chat UI（推荐）
cd chat-ui
start.bat                          # 或双击 start.bat
# 浏览器打开 http://localhost:8765

# 方式二：Python SDK 交互模式
python run_agent.py

# 方式三：dcode 终端编码助手
run_dcode.bat                      # CMD
# 或
run_dcode.ps1                      # PowerShell
```

## Chat UI 功能

| 功能 | 说明 |
|------|------|
| **会话管理** | 新建、内联重命名、删除（确认弹窗）。按置顶/今天/7天/30天/月自动分组 |
| **会话置顶** | 右键或 ⋮ 按钮 → 置顶/取消置顶，置顶的会话固定在顶部区域 |
| **联网搜索开关** | 输入框左下角的「智能搜索」胶囊按钮，默认关闭，点击开启 |
| **流式输出** | 实时逐字输出，可点击红色停止按钮中断 |
| **消息操作** | 每条消息支持复制、重新生成、点赞/点踩（记录到数据库） |
| **思考过程** | 可折叠显示模型的推理过程（取决于模型是否支持） |
| **运行状态指示灯** | 顶部实时显示 Agent 状态：生成中/思考中/调用工具/完成/错误 |
| **Context 面板** | 右侧面板，子 Tab 切换：提示词 / 历史 / 工具 / 技能 / 子 Agent |
| **时间线** | 右侧面板展示请求全过程的事件流（工具调用、思考、输出） |
| **Agent Loop** | 右侧面板逐节点展示 model/tools 的执行信息，可展开看消息详情 |
| **Todo 任务面板** | Agent 规划的任务列表实时更新，任务按内容去重、状态原地切换（待办→进行中→已完成） |
| **文件审批卡片** | Agent 修改文件时弹出审批卡片（工具名+参数），确认/拒绝后继续执行 |
| **Markdown 渲染** | 支持标题、列表、表格、代码块、加粗，自然分段与断句 |
| **跨会话记忆** | Agent 通过 AGENTS.md + SQLite Store 实现跨会话持久记忆 |
| **右键菜单** | 右键或点击 ⋮ 按钮可重命名、置顶/取消置顶、删除 |
| **删除确认** | 删除会话时弹出居中确认弹窗（取消/删除该对话） |

## Agent 自定义工具

| 工具 | 始终可用 | 说明 |
|------|---------|------|
| `get_current_time` | ✅ | 获取当前日期时间，支持指定时区（默认 Asia/Shanghai） |
| `web_fetch` | ✅ | 抓取任意 URL 并提取正文；JSON API 响应自动压缩为摘要 |
| `get_weather` | ✅ | 查询任意城市天气，返回中文摘要（当前天气 + 未来几天气温/天气） |
| `store_memory` / `recall_memory` | ✅ | 长期记忆读写（SQLite Store 持久化，跨重启保留） |
| `get_project_info` | ✅ | 查看项目结构信息和版本 |
| `web_search` | ⏹ 需开启搜索 | DuckDuckGo 搜索，返回5条标题+URL+摘要，无需 API Key |
| `crm_leads_read` | 仅子代理 | CRM 线索读取（已移交 crm-stats / crm-analyst 子代理，主 Agent 不直接调用） |

## 文件安全与审批

工具调用按以下规则执行，保护文件系统安全：

| 操作 | 规则 |
|------|------|
| 读取文件（ls / read_file / glob / grep） | ✅ 直接放行 |
| 修改文件（write_file / edit_file，目标已存在） | 🟡 弹出审批卡片，人工确认后执行，拒绝则不修改 |
| 创建文件（write_file，目标不存在） | ❌ 禁止，提示"禁止创建文件" |
| 删除文件（delete） | ❌ 禁止，提示"禁止删除文件" |

## CRM 子代理

CRM 数据能力已拆分为两个专属子 Agent，主 Agent 通过 `task` 工具统一委派：

| 子代理 | 用途 | 说明 |
|--------|------|------|
| **crm-stats**（CRM 数据统计 Agent） | 统计 CRM 数据 | 调 `crm_leads_read` 取数，输出总数、按来源/销售/优先级分组统计 |
| **crm-analyst**（CRM 数据分析 Agent） | 分析 CRM 数据 | 调 `crm_leads_read` 取数，分析线索质量、优先级分布、来源效果并给出建议 |

## 已启用的框架能力

| 能力 | 状态 |
|------|------|
| Shell 执行 (`execute`) | ✅ 已启用 |
| 文件系统工具 (ls, read, write, edit, glob, grep) | ✅ 已启用 |
| 框架记忆 (AGENTS.md) | ✅ 已启用 |
| 技能系统 (Skills) | ✅ 已启用 |
| 子 Agent (code-reviewer, researcher, crm-stats, crm-analyst) | ✅ 已启用 |
| 状态检查点 (Checkpointer, SQLite 持久化) | ✅ 已启用 |
| 语义记忆库 (Store, SQLite 持久化) | ✅ 已启用 |
| 自动摘要 (Auto-summarization) | ✅ 已启用 |
| 工具调用修复 (Tool call repair) | ✅ 已启用 |
| 任务清单 (Todo List) | ✅ 已启用 |
| 人工介入 (Human-in-the-loop, 文件修改审批) | ✅ 已启用 |
| 异步子 Agent | ⏳ 需要远程服务器 |
| 评分系统 (Rubric) | ⏳ 可选配置 |

## 项目结构

```
├── chat-ui/                          # Web 聊天界面
│   ├── server.py                     # FastAPI 后端（Agent 逻辑 + API）
│   ├── start.bat                     # 启动脚本
│   ├── .env                          # 模型配置（本地，不上传）
│   ├── .env.example                  # 配置模板
│   ├── AGENTS.md                     # Agent 记忆文件
│   ├── chat.db                       # 会话/消息数据库（自动创建，不上传）
│   ├── agent_state.db                # Agent 图状态 + 长期记忆（SQLite，不上传）
│   ├── skills/                       # Agent 技能
│   │   └── project-analyzer/         # 项目分析技能
│   └── static/
│       └── index.html                # 前端页面（单页应用）
├── libs/                             # Deep Agents SDK（LangChain 官方，未修改）
│   ├── deepagents/                   # 核心 SDK
│   ├── code/                         # dcode 终端 Agent
│   └── cli/                          # CLI 工具
├── launch_dcode.py                   # dcode Python 封装（含 DeepSeek 配置）
├── run_agent.py                      # Python SDK 交互模式
├── run_dcode.bat                     # dcode 启动脚本 (CMD)
├── run_dcode.ps1                     # dcode 启动脚本 (PowerShell)
├── .gitignore                        # 排除 .env / chat.db / agent_state.db / .venv
└── README.md                         # 本文件
```

## 常见问题

### API Key 如何配置？
创建 `chat-ui/.env` 文件写入 `OPENAI_API_KEY=你的key`，server.py 启动时自动读取。不要修改 `.env.example`。

### 如何关闭联网搜索？
默认关闭。输入框左下角的「智能搜索」按钮，点击可切换开启/关闭。

### 数据存在哪里？
- `chat-ui/chat.db` — 会话与消息记录。删除此文件即清空所有会话。
- `chat-ui/agent_state.db` — Agent 图状态（Checkpoint）与长期记忆（Store）。重启服务后对话上下文与记忆仍然保留。

### 如何更改模型？
修改 `chat-ui/server.py` 中的 `MODEL_NAME = "你的模型名"`，及 `.env` 中的 `OPENAI_BASE_URL`。

### 文件修改需要审批？
是的。Agent 修改已存在的文件时会弹出审批卡片，需要你点击「确认修改」或「拒绝」；创建/删除文件被默认禁止。

## 许可证

本项目基于 **Deep Agents** by LangChain，遵循 [MIT 许可协议](LICENSE)。

- 原始 Deep Agents 代码版权归 LangChain, Inc. 所有
- Chat UI 及附加脚本同样遵循 MIT 许可协议
