# 基础 Agent 服务 (Basic Agent Service)

一个最小可用的 Agent 服务：**DeepSeek 模型 + Deep Agents 框架**。

独立于 `chat-ui/`，不依赖 `libs/code`（deepagents-code），可直接用于二次开发。

**会话持久化**：会话状态落盘到 SQLite（`agent_state.db`），服务/进程重启后
同一 `thread_id` 的历史上下文依然存在，可以接着聊。详见「会话持久化」章节。

## 组成

| 文件 | 说明 |
|------|------|
| `agent_service.py` | 服务主体：模型接入、工具、Agent 构建、会话持久化、HTTP 接口、CLI |
| `test_service.py` | 测试脚本（配置 / 模型 / Agent / 工具 / 多轮 / 持久化 / HTTP） |
| `start.bat` | 一键启动 HTTP 服务（端口 8770） |
| `agent_state.db` | **运行时自动生成**的会话库（SQLite）；删掉它即等于清空全部会话 |

## 模型

| 项 | 值 |
|----|----|
| 模型名 | `deepseek-v4-flash` |
| 接入方式 | `langchain-deepseek` 的 `ChatDeepSeek`（OpenAI 兼容接口） |
| BASE_URL | `https://api.deepseek.com/v1` |

> 该模型是**推理模型**，响应会带 `reasoning_content`。服务已把它单独解析到 `reasoning` 字段，不混入正文。

## 配置

优先读环境变量；未设置时按顺序加载 `.env`：

1. `basic-agent/.env`
2. `chat-ui/.env`  ← 本仓库现有配置位置
3. `<项目根>/.env`

支持的变量：

```ini
OPENAI_API_KEY=sk-xxxxxxxx          # 必填
OPENAI_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-v4-flash    # 可选
AGENT_PORT=8770                     # 可选
AGENT_DB=agent_state.db             # 可选，会话持久化文件路径
AGENT_SYSTEM_PROMPT=...             # 可选，覆盖系统提示词
```

## 使用

```bash
cd basic-agent
PY=../libs/deepagents/.venv/Scripts/python.exe

# 1) 启动 HTTP 服务
$PY agent_service.py --serve            # 或双击 start.bat
#   打开 http://127.0.0.1:8770/docs 查看交互式 API 文档

# 2) 单次提问
$PY agent_service.py "现在几点了？"

# 3) 交互模式（同一会话多轮）
$PY agent_service.py

# 4) 查看推理过程
$PY agent_service.py --show-reasoning "解释一下什么是向量数据库"

# 5) 会话库：列出已持久化的会话 / 回看某个会话的历史
$PY agent_service.py --list-sessions
$PY agent_service.py --history demo-persist
```

## 会话持久化

会话状态通过 `AsyncSqliteSaver` 落盘到 `agent_state.db`（默认位于 `basic-agent/`，
可用 `AGENT_DB` 改路径）。

- **重启不丢**：服务/进程重启后，用同一个 `thread_id` 继续对话，模型仍记得之前的内容
- **跨入口共享**：HTTP 接口与 CLI 读写同一个库
- **可回看**：`--history` / `GET /sessions/{thread_id}/history` 能还原完整消息历史
- **重置方式**：停服务后删除 `agent_state.db*` 即可清空全部会话

```bash
# 演示：两个独立进程共享同一会话上下文
$PY agent_service.py --thread-id demo "请记住我的工号是 A9527"
$PY agent_service.py --thread-id demo "我的工号是多少？"   # -> A9527
```

### 实现要点（踩坑记录）

同步入口（`run_once` / CLI）一律采用「**即开即关**」：每次调用自己打开会话库、
执行、再关闭连接，结束后进程内不留 Agent 与连接。

原因是 aiosqlite 的连接由**非守护线程**支撑，而 CPython 退出时
**先执行 `threading._shutdown()`（等待所有非守护线程），之后才轮到 `atexit`** ——
`atexit` 根本来不及清理；只要连接还开着，进程就会永久卡在退出阶段
（现象：结果已打印，却迟迟不回到 shell）。所以不能依赖 `atexit`，必须显式关闭。

- 服务模式：由 FastAPI `lifespan` 在关闭时收尾（`aclose_agent()`）
- 同步模式：`_sync_once()` 在 `finally` 中关闭
- 兜底：`aclose_agent()` 末尾再调一次 `Connection.stop()`，防止关闭失败

> 二次开发提示：在异步代码里请用 `arun_once()` 并在自己的作用域内调用
> `aclose_agent()`；同步代码请用 `run_once()`（已自带清理）。

## HTTP 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查：模型、配置来源、Agent 是否就绪、会话库路径 |
| GET | `/sessions` | 列出所有已持久化的会话（thread_id / 最近活动时间） |
| GET | `/sessions/{thread_id}/history` | 读取指定会话的消息历史 |
| POST | `/chat` | 单次对话，返回 `reply` / `reasoning` / 耗时 / 工具调用次数 |
| POST | `/chat/stream` | SSE 流式输出，事件：`start` / `reasoning` / `token` / `done` / `error` |

请求体：

```json
{ "message": "现在几点了？", "thread_id": "可选，传入相同值即为同一多轮会话" }
```

示例：

```bash
curl -X POST http://127.0.0.1:8770/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"算一下 (12+8)*3"}'
```

## 内置工具

| 工具 | 说明 |
|------|------|
| `get_current_time` | 获取当前时间，支持任意 IANA 时区（默认 Asia/Shanghai） |
| `calculate` | 四则运算，基于受限 AST 求值（不使用 `eval`） |

## 测试

```bash
cd basic-agent
PY=../libs/deepagents/.venv/Scripts/python.exe

# 本地检查（含持久化：落盘 / 历史还原 / 跨进程可列出）
$PY test_service.py

# 连同 HTTP 接口一起测（需先启动服务）
$PY test_service.py --base-url http://127.0.0.1:8770
```

## 说明

- 会话记忆使用 **SQLite 持久化**（`AsyncSqliteSaver`），重启后不清空；
  如需换成内存模式，把 `agent_service.py` 里的 `AsyncSqliteSaver` 换成
  `langgraph.checkpoint.memory.InMemorySaver` 即可（注意同步入口记得改回直接复用连接）。
- Agent 由 `create_deep_agent` 创建，默认继承框架能力（任务规划、文件系统等）。
