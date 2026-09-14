# CRMAgent

AI 应用 —— **CRM 客户管理系统** + **基于 Deep Agents（harness）框架的 Agent 服务**。

本仓库是一个 monorepo，将两部分代码放在一起：

| 目录 | 内容 | 技术栈 |
|------|------|--------|
| [`crm/`](./crm) | CRM 客户管理系统（含 AI 助手前端、Agent 控制面板） | Next.js 16 + React 19 + Tailwind 4 + chart.js |
| [`deepagent/`](./deepagent) | Agent 服务与所依赖的 Deep Agents 框架 | Python 3.13 + LangChain / LangGraph + FastAPI |

---

## 整体架构

```
┌──────────────────────────────┐        ┌───────────────────────────────┐
│  crm/  (Next.js, :3100)      │        │  deepagent/                   │
│  ────────────────────────    │        │  ──────────────────────────   │
│  业务页面：线索/商品/订单/…    │  HTTP  │  chat-ui/  (:8765)            │
│  AI 助手页 (/chat)  ─────────┼───────▶│   /api/agent/*  ← 反向代理      │
│  Agent 控制面板 (/agent) ─────┼───────▶│   Agent 服务（SSE 流式）        │
└──────────────────────────────┘        │  basic-agent/ (:8770)         │
                                        │  libs/        框架源码          │
                                        └───────────────────────────────┘
```

- CRM 前端通过自身的 `/api/agent/*` 路由，把请求代理给 `chat-ui` 的 Agent 服务。
- Agent 服务基于 Deep Agents 框架构建，接入 DeepSeek 模型，具备 CRM 业务读写、本地文件系统、联网搜索等能力。

---

## 快速开始

### 1. 启动 Agent 服务（deepagent/chat-ui）

```bash
cd deepagent/chat-ui
cp .env.example .env          # 填入 DeepSeek API Key
# 依赖：先按 deepagent/README.md 安装 libs/deepagents/.venv
# Windows 可直接双击 start.bat（自动释放 8765 端口）
python server.py              # http://localhost:8765
```

### 2. 启动 CRM 前端（crm/）

```bash
cd crm
npm install
npm run dev                   # http://127.0.0.1:3100
```

默认账号：`13912345678` / 密码 `123123`（见 `crm/data/accounts.json`）。

> CRM 单独使用时（不启动 Agent 服务）除「AI 助手」外的页面均可正常工作 —— 数据层是 JSON 文件 + Next.js API Routes，无独立后端。

---

## crm/ —— CRM 客户管理系统

- **业务功能**：数据仪表盘（chart.js）、线索管理、商品管理、订单管理、账号管理、角色与权限（页面权限 + 功能权限 + 数据范围）、沟通记录、手机号 + 密码登录
- **AI 助手**：对话式操作 CRM，支持工具调用过程展示（每行一个工具、默认收起、状态灯）
- **Agent 控制面板**：Agent 概览（服务健康、模型连通性、调用次数、平均耗时、Token 消耗）、系统提示词配置、可用工具开关、工具权限配置（直接使用 / 人工审批 / 禁止）
- **数据层**：JSON 文件存储（`data/*.json`），Next.js API Routes 读写

细节见 [`crm/README.md`](./crm)。

## deepagent/ —— Agent 服务与框架

| 目录 | 说明 |
|------|------|
| `chat-ui/` | 完整 Agent 服务（端口 8765）：DeepSeek 模型、SSE 流式输出、CRM 业务工具、本地文件系统（LocalShellBackend）、人工审批（HITL）、工具三档权限、SQLite 会话持久化 |
| `basic-agent/` | 最小可用 Agent 服务（端口 8770）：单文件实现，含 HTTP 接口与 CLI、会话持久化 |
| `libs/` | Deep Agents 框架源码（monorepo：`deepagents` / `cli` / `code` / `acp` / `evals` / `partners` / `talon`） |
| `examples/` | 框架自带示例 |

细节见 [`deepagent/basic-agent/README.md`](./deepagent/basic-agent/README.md) 与框架 `deepagent/README.md`。

### Agent 能力与安全边界

- **工具权限三档**：查询类工具直接放行；CRM 新增/修改走人工审批（对话内弹卡片确认）；删除类工具禁止执行（模型可调用，但运行时一律拦截并回传「禁止」原因，前端显示红色警示）
- **文件系统安全**：读放行；写已存在文件需审批；创建不存在的文件与删除文件禁止
- **会话持久化**：`chat.db`（前端会话）+ `agent_state.db`（Agent 状态），服务重启不丢上下文

---

## 说明

- 仓库中的 `.env`、`*.db`、本地备份与运行时配置**均不入库**（见 `.gitignore`）；首次运行请从 `.env.example` 复制并填入自己的 Key。
- `deepagent/libs/` 为 Deep Agents 框架的 fork，用于承载 Agent 服务所需的框架能力。
