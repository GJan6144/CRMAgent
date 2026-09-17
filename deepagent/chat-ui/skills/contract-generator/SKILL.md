---
name: contract-generator
description: 根据 CRM 里的订单生成一份基于标准模板的 Word 合同文件。触发场景：用户说「生成 XXX 订单的合同 / 帮我出 XXX 的合同 / 按订单 XXX 生成合同」，其中 XXX 是订单客户名（如 王小明）或订单编号（如 ORD-20240105001 或 OD-2026-0001）。流程：查 CRM 订单拿客户信息与课程信息 → 读甲方默认信息与模板占位符 → 用 docx_fill_template 填充生成新 .docx（文件名含时间戳）→ 校验无残留 → 回复下载链接。当用户提到「订单合同 / 按订单出合同 / 生成某某订单的合同」等，使用本技能。
compatibility: 依赖 CRM 只读工具（crm_query / crm_get / crm_list_entities）、Word 工具（docx_read_text / docx_list_placeholders / docx_fill_template）、read_file（读甲方默认信息）与 write_todos（过程面板）。只读模板、生成新文件，不改动模板原文与项目源码。
allowed-tools: write_todos crm_query crm_get crm_list_entities docx_read_text docx_list_placeholders docx_fill_template read_file
---

# 合同生成（Contract Generator，订单驱动）

根据 CRM 里的一条订单，把「从零到一科技公司」（甲方）与该订单客户（乙方）的信息填进标准合同模板，生成一份新的 .docx 合同文件。

## 使用场景

- 用户说「生成 XXX 订单的合同 / 帮我出 XXX 的合同 / 按订单 XXX 生成合同 / 给 XXX 做份合同」
- 其中 **XXX 是订单客户名或订单编号**，例如「生成王小明订单的合同」「生成 ORD-20240105001 的合同」

## 第一步必须先做：用 `write_todos` 建过程清单

本技能是多步任务，必须先调 `write_todos` 建立清单，**每完成一步立刻标 `completed`**。
四步缺一不可，不要精简：

```json
{"todos": [
  {"content": "查找订单并获取客户与课程信息", "status": "in_progress"},
  {"content": "读取甲方信息与模板占位符", "status": "pending"},
  {"content": "填充模板生成新合同文件", "status": "pending"},
  {"content": "校验生成结果并回复下载链接", "status": "pending"}
]}
```

## 第一步：查订单，拿 6 项信息

用户给的是**客户名或订单编号**，按下面顺序定位订单：

1. 先 `crm_query(entity="orders", keyword="<客户名或订单号>")` 模糊匹配。
   订单的检索字段含 `orderNo`（订单号，如 ORD-20240105001）、`customerName`（客户名）、`productName` 等。
2. 若查不到，再 `crm_get(entity="orders", record_id="<记录编号>")` 按记录编号（OD-2026-0001）精确读。
3. ⚠️ 若客户名命中**多笔订单**，列出所有匹配订单（订单号 / 产品 / 金额 / 期限）让用户确认是哪一笔，
   **不要擅自替用户选**；用户给了订单编号则直接按编号生成，无需再问。

拿到订单后，必须凑齐这 **6 项**（缺一项就停下来问用户，不要编造）：

| # | 合同字段 | 来源 |
|---|---|---|
| 1 | 客户名 | 订单 `customerName` |
| 2 | 客户身份证 | **订单里没有**，需 `crm_query(entity="leads", keyword="<客户名>")` 反查 `idCard` |
| 3 | 客户手机号 | 订单 `customerPhone`（没有则用 lead 的 `phone`） |
| 4 | 订单产品名 | 订单 `productName` |
| 5 | 服务期限（月） | 订单 `serviceTermMonths` |
| 6 | 订单金额（元） | 订单 `amount` |

⚠️ 若用 `crm_query` 返回的表格里字段不全（表格只展示部分列），用 `crm_get(entity="orders", record_id="<订单 id>")` 读**完整字段**；客户身份证用 `crm_get(entity="leads", record_id="<lead id>")` 读完整 lead。

## 第二步：读甲方信息与模板占位符

1. `read_file` 读 `/chat-ui/skills/contract-generator/templates/defaults.json` 拿甲方信息：
   - `CompanyName1` = 我方公司名、`SocialCreditCode1` = 我方公司编码、`Name1` = 我方法定代表人、`TelNumber1` = 我方联系电话。
2. `docx_list_placeholders` 读模板 `/chat-ui/skills/contract-generator/templates/课程服务合同word模板.docx`，
   确认 10 个占位符都在。

## 第三步：填充模板生成新合同

用 `docx_fill_template` 填充，参数：

- `template_path`: `/chat-ui/skills/contract-generator/templates/课程服务合同word模板.docx`
- `replacements`: JSON 对象字符串，**10 个占位符一一对应**，示例：
  `{"CompanyName1":"从零到一科技公司","SocialCreditCode1":"91440300MA5TEST4X2A","Name1":"张三","TelNumber1":"13912345678","CompanyName2":"王小明","SocialCreditCode2":"440300200001057936","TelNumber2":"13812345678","CourseName":"AI课","ServiceTerm":"12","Amount":"7960"}`
  （甲方的 4 项来自 defaults.json；乙方姓名/身份证/电话、课程名/期限/金额来自第一步查到的订单与 lead）
- `output_path`: `/chat-ui/static/contracts/课程服务合同_{timestamp}.docx`
  （`{timestamp}` 会被工具自动替换成当前时间，无需自己算时间）

`docx_fill_template` 处于人工审批档，调用后会弹审批卡让用户确认；用户批准后才真正生成。这是设计如此，不要绕过去。

## 第四步：校验与回复

1. `docx_list_placeholders` 读输出文件，确认**没有残留占位符**；有残留说明漏填，要补。
2. 回复用户：一句话说清「已为谁、生成什么课程的合同、金额多少」，再给下载链接
   `http://127.0.0.1:8765/static/contracts/<文件名>.docx`（把 `<文件名>` 换成实际名，注意含时间戳）。

## 纪律

- 只读模板、生成新文件；**不得修改模板原文**、不得改动 defaults.json 或项目源码。
- **绝对禁止输出过程性旁白**（如「我先读取技能说明」「让我查一下订单」这类中英文开场白），**回复的第一句就必须是结果**。
- 6 项信息拿不齐就停下来问用户补齐，**绝不编造证件号、电话、金额**。
- 只是问「合同里写了什么」这类问题不算本技能；只有真的要**根据订单生成一份合同文件**才走本技能。
