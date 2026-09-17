---
name: sales-monthly-report
description: 生成指定月份的《销售月报》HTML 报告。先统计当月业绩总量（总业绩 / 总订单量 / 平均客单价 / 目标达成率）、各产品售卖情况（业绩金额、订单量、业绩占比、单量占比、平均客单价）、各销售人员达成情况（本月业绩 / 目标 / 达成率），再按固定四节格式（销售业绩概述、销售产品销售情况含饼图与表格、销售人员情况、下月工作计划）渲染成一份可直接打开浏览的 HTML 文件。当用户提到「销售月报 / 月报 / 月度报告 / 月度业绩报告 / 生成月报 / 这个月的业绩报告 / 6 月月报 / 上月业绩情况 / 月度经营分析 / 本月销售情况汇总」或要求按月汇总业绩、做月度复盘时，使用本技能。
compatibility: 依赖 CRM 只读工具（crm_list_entities / crm_query / crm_get / crm_stats）核对数据，需要 execute（运行本技能自带脚本）与 write_todos（过程面板）。只读：不写 CRM 业务数据、不改动项目源码。
allowed-tools: write_todos crm_list_entities crm_query crm_get crm_stats execute read_file write_file
---

# 销售月报（Sales Monthly Report）

把 CRM 里的订单、产品、销售目标按月汇总，产出**一份 HTML 报告文件**。

严格只读：不得调用 `crm_create` / `crm_update` / `crm_delete`，不得改动 CRM 数据文件。

## 使用场景

- 用户说「生成 6 月销售月报 / 出个月报 / 上个月的业绩报告 / 月度经营分析」
- 用户要求按月汇总业绩、看产品结构、看销售达成情况

## 第一步必须先做：用 `write_todos` 建过程清单

**本技能是一个多步任务，必须先调 `write_todos` 建立清单，再开始执行。**
用户在对话流里实时看得到这份清单，所以**每完成一步立刻把它标 `completed`**，
不许攒到最后一起改。按下面这个清单建（步骤文字可按月份微调）：

```json
{"todos": [
  {"content": "确认报告月份与当月数据是否齐备", "status": "in_progress"},
  {"content": "统计本月业绩总量、各产品情况、各销售达成情况", "status": "pending"},
  {"content": "渲染《销售月报》HTML 报告", "status": "pending"},
  {"content": "撰写业绩概述、产品总结、人员总结与下月工作计划", "status": "pending"},
  {"content": "重渲染报告并核对结果，回复用户", "status": "pending"}
]}
```

**五步全部要出现在清单里**，不要精简成三步 —— 用户就是靠这份清单看进度的。

## 统计口径（三项统计）

**统计1 · 总量**：本月总业绩（订单金额合计）、总订单量、平均客单价（总业绩 ÷ 订单量）；
另出当月目标合计与整体达成率。

**统计2 · 产品**：每个产品的业绩金额、订单量、**业绩占比**、**单量占比**、平均客单价。

**统计3 · 销售**：每位销售的**本月业绩、目标、达成率**。

⚠️ **销售归属靠数据反查**：`orders` 里**没有销售字段**，脚本用
`orders.customerName == leads.name` 反查 `leads.assignee`（跟进销售）得到归属。
匹配不上的订单计入「未归属」，在报告里单独披露金额 —— 因此「各销售业绩之和」
可能小于「总业绩」，这是**正常口径**，向用户解释时要说清楚，不要试图把它抹平。

## 命令速查

脚本：`chat-ui/skills/sales-monthly-report/scripts/monthly_report.py`

### ⚠️⚠️ 只能用这一种方式调用（否则一定失败）

`execute` 工具的 shell 是**空环境**：**没有 PATH**，`python` / `py` 都找不到；
`python` 的 stdout 在 Windows 下默认 cp936，**中文直出会编码崩**。所以：

1. **必须用仓库内的 venv 解释器 + 相对路径**（`execute` 的工作目录就是
   `deepagents/` 仓库根目录，相对路径天然可用，且不依赖 PATH）：

   ```
   libs\deepagents\.venv\Scripts\python.exe chat-ui\skills\sales-monthly-report\scripts\monthly_report.py <子命令> ...
   ```

2. **不要**写成 `python xxx.py`、`py xxx.py`、`./xxx.py`，也不要用 `&&` 之外的
   shell 特性；脚本自己会输出 ASCII 键值行，不需要设置任何环境变量。

### 子命令

| 目的 | 命令 |
|---|---|
| 看哪些月份有数据 | `<PY> <SCRIPT> months` |
| 看该月全部统计数字（校对用） | `<PY> <SCRIPT> stats --month 2026-06` |
| 渲染 HTML 报告 | `<PY> <SCRIPT> render --month 2026-06` |
| 用自定义小结二次渲染 | `<PY> <SCRIPT> render --month 2026-06 --insights-file chat-ui\static\reports\_insights\2026-06.json` |

`render` 的 stdout 会给出（纯 ASCII，直接照抄即可）：

```
REPORT_HTML=<HTML 的绝对路径>
REPORT_URL=http://127.0.0.1:8765/static/reports/sales-monthly-2026-06.html
INSIGHTS_TEMPLATE=<小结模板的绝对路径>
ORDERS=27
AMOUNT=83360.00
AVG_PRICE=3087.41
TARGET=215000.00
RATE=38.8
...
```

## 工作流程

> **全程不要写过程性文字。** 不要出现「我先读取销售月报技能的说明」「让我先跑一下脚本」
> 「好的，我来生成」这类旁白 —— 需要调工具就直接调，把话留到最后交付时一次说清。

### 第 1 步 · 确认月份

- 用户明确给了月份（「6 月」「2026-06」）→ 换算成 `YYYY-MM`。
- 用户说「上个月 / 本月」→ 先用 `get_current_time` 拿当前日期再推算，**不要凭感觉**。
- 用户没说月份 → 先跑 `months` 看有数据的月份，再问用户要哪个月；**只有一个有数据的月份时可以直接用它，但要说明**。
- 用户给的月份**没有数据**（`ORDERS=0`）→ 明确告诉用户该月没有订单记录，并列出可选的月份，**不要编造数据、不要拿别的月份顶替**。

### 第 2 步 · 统计（并发核对，别跳）

1. 跑 `render` 前先用 `crm_stats(entity="orders", sum_field="amount")` 与
   `crm_query(entity="orders", sort_by="createdAt", limit=200)` 大致确认当月订单量级，
   和脚本输出对不上时**以脚本为准**（脚本按 `createdAt` 精确到月过滤）。
2. 跑 `stats --month <月份>` 拿到该月完整数字；需要看中文内容时给 `--out` 落到
   `chat-ui\static\reports\_stats-<月份>.json`，再用 `read_file` 读。
3. 顺手用 `crm_query(entity="sales-targets", filters='{"month":"<月份>"}')` 确认目标
   是否配置；目标为空时达成率不可用，要在结论里点出来。

完成即把清单第 2 项标 `completed`。

### 第 3 步 · 渲染报告

```
<PY> <SCRIPT> render --month <月份>
```

脚本会自动生成各节小结（业绩概述 / 产品总结 / 人员总结 / 下月工作计划）作为**兜底**，
所以这一步先跑通、保证有交付物；第 4 步再用你写的分析覆盖它。
输出 HTML 在 `chat-ui/static/reports/sales-monthly-<月份>.html`，
浏览器可直接访问 `http://127.0.0.1:8765/static/reports/sales-monthly-<月份>.html`。

⚠️ **不要试图用 `write_file` 写这个 HTML**：`write_file` 处于审批档，而
「目标文件不存在」会被内置安全规则**直接禁止**（连审批卡都不弹）。HTML 由脚本自己落盘。

完成即把清单第 3 项标 `completed`。

### 第 4 步 · 撰写小结与下月工作计划（**必做**）

脚本自动生成的小结是数据推导的，偏模板化。**报告里的「分析」必须由你来写**，
这是本技能的价值所在，不要跳过：

1. `render` 已在
   `chat-ui/static/reports/_insights/<月份>.json` 写好模板（4 个字段：
   `overview` / `product` / `sales` / `plan`，`plan` 是字符串数组）。
2. 用 `read_file` 读这个模板（虚拟路径
   `/chat-ui/static/reports/_insights/<月份>.json`）。
3. 改写四个字段的值 —— **只改文字，保留 JSON 结构**：
   - `overview`：业绩概述，说清总量、达成率、缺口，以及一句总体判断；
   - `product`：产品结构要点（头部集中度、高低占比产品、客单价差异）；
   - `sales`：人员达成差异（谁最好、谁最差、零业绩的人）；
   - `plan`：**3-5 条下月工作计划**，每条一句话、可执行、有数据依据。
   写作用中文，数字用 `¥1,234.56` / `43.0%` 这种格式；结论必须能从统计数字推出来，
   **不许编造**（例如没配置目标的月份不要编达成率）。
4. 用 `write_file` 保存回**同一个路径**。文件已存在，所以会弹一张**审批卡**——
   这是刻意设计的：让用户过目 Agent 写进报告的分析。用户批准后继续；
   **被拒绝就跳过本步**，报告里保留自动小结即可，不影响交付。
5. 再跑一次
   `<PY> <SCRIPT> render --month <月份> --insights-file chat-ui\static\reports\_insights\<月份>.json`
   覆盖渲染，让报告带上你写的分析。

完成即把清单第 4 项标 `completed`。

### 第 5 步 · 回复用户

- 给出**报告链接** `http://127.0.0.1:8765/static/reports/sales-monthly-<月份>.html`
  （这是本技能唯一需要露出的路径，其余文件路径不要写进回复）。
- 用**自己的话**概括 4-6 个关键结论：总量与达成率、产品结构要点、销售达成差异、
  最该关注的 1-2 个问题。
- **不要复述整张表格、不要粘贴脚本输出**，也不要把各节小结原文再抄一遍。
- 报告是交付物，用户要的是结论和下一步，不是数据回放。

## 注意事项

- **只读**：不得调用任何写入类 CRM 工具，不得修改 CRM 数据文件。
- **数据说话**：所有结论必须来自脚本输出的数字；某个指标算不出来（缺目标、无订单、
  有未归属订单）就明说，不要含糊过去。
- **不输出过程性文字**：不要写「我将使用 sales-monthly-report 技能」「让我先跑一下脚本」
  「好的，我来生成」之类的开场白；需要调工具直接调。
- **月份口径**：一律按订单 `createdAt` 的 `YYYY-MM` 归属，跨月订单不拆分。
- 报告里的金额一律人民币（¥）。

## 兜底

- `execute` 报 `'python' is not recognized` → 说明用了裸 `python`，改用上面的
  `libs\deepagents\.venv\Scripts\python.exe` 相对路径。
- 脚本报 `找不到 CRM 数据目录` → 用 `--data-dir` 指定，或先跑 `months` 确认探测结果。
- 用户其实只想要几个数字（「这个月做了多少业绩」）→ **不要去建月报**，直接用
  `crm_stats` / `crm_query` 回答。**只有明确要「月报 / 月度报告」时才走本技能。**
