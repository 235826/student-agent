# 全局 Agent

全局 Agent 通过对话调用受控工具，帮助用户查询和修改任务、日历、课程、清单、标签、规则、设置、导入与计划。普通任务按默认值直接创建并提供修改、撤销入口；其他写操作由用户确认。

## 处理流程

```text
浏览器发送消息（附带当前页面 surface、当前任务清单 task_list_id）
  → API 创建 AgentRun 并入队（202）
  → agent-worker 领取
  → 注入可用事件类型、本会话最近已执行对象、工具分组目录
  → 模型多轮调用 tools（文本增量实时写入 run）
       只读工具：立即查询，结果回填模型
       普通任务创建：任务与已执行 AgentAction 在同一事务保存，结果回填模型
       其他写工具：只生成待确认 AgentAction
  → 保存助手回复和待确认动作
  → 前端通过 SSE 接收增量文本与阶段，轮询作为降级
  → 用户逐条确认或忽略动作
  → 执行器复用现有业务服务执行单条动作
  → 审计、幂等和按模块刷新前端缓存
```

除普通任务创建外，写操作必须逐条确认，不提供整批执行。删除事件/课程/系列、永久删除/清空垃圾箱、修改设置与规则、发起导入、采用计划标记为高风险。

## 任务默认值与结果卡片

- 只给标题即可创建。未指定清单时使用发送消息时选中的清单，没有选中清单则放入收件箱；明确指定的清单（包括显式空值表示收件箱）优先。当前清单在排队期间被删除则回退收件箱。
- 未要求提醒时默认不设置提醒，截图中的“提醒”占位文字不构成提醒要求。优先级、标签、预计用时等沿用现有任务默认值，不要求用户补齐。
- “今天加入这几个任务”等表达按用户时区使用今天的全天日期，沿用现有 `deadline_at` + `deadline_all_day` 的按天待办机制，不补具体截止时刻或提醒。
- 只在缺少必要信息时追问，例如明确要求提醒却未提供时间，或明确指定的清单存在同名歧义。图片部分名称不清楚时，先创建可以确认的任务。
- 含动作引用、父任务、前置依赖或重复规则的创建继续等待确认；普通创建返回 `executed` 和真实任务结果，其他操作返回 `proposed`，模型据此陈述实际状态。
- 结果卡片展示实时清单、日期和提醒，可直接更换清单、设置或取消提醒、撤销创建。撤销将任务移入垃圾箱，可恢复；已产生关联任务时拒绝直接撤销，提示核对影响。
- 同一轮相同创建参数去重；创建与执行回执同事务提交，避免 worker 重试留下重复任务。
- 本次清单选择不改写长期偏好。目前没有单独的默认清单或默认提醒偏好设置，未选中清单时使用收件箱。

## 事件类型与确认卡片

Agent 的事件工具不接受内部 `event_type_id`，只接受 `event_type` 名称。可用类型会随系统上下文一起注入，模型在提出动作时必须明确填写「考试」「会议」「其他」或已有的自定义类型；省略或填写未知名称会在提出阶段被拒绝并返回可用类型。事件标题不会被当作类型，用户明确说考试时不能标成其他。时区省略时使用用户设置。

确认卡片直接展示动作的关键字段（标题、起止时间、事件类型、地点、备注等），只有原始 JSON 放在折叠区，用户无需展开即可核对。更新类动作会额外展示目标对象名称和修改后的类型，避免只显示裸 ID。

## 多轮对象引用

每轮开始时会从本会话已执行的动作中提取最近 10 个真实对象，连同标题、ID、起止时间和类型注入系统上下文。模型说“刚才创建的”“那几个”时直接使用这些 ID，不再把动作 ID 当对象 ID。动作 ID 不会出现在模型可见的工具结果中，`action_key` 只用于 `$ref`。

## 流式输出与速度

- `AgentChat` 解析 Chat Completions SSE，文本增量通过 `GET /runs/{id}/stream` 推送给前端。
- `AgentRun` 保存 `phase` 和 `partial_content`；阶段包括理解请求、查询并准备操作等。
- Agent worker 空闲轮询间隔为 0.4 秒。
- 模型回复中的文本会边生成边展示；工具阶段先展示阶段提示，动作生成后立即刷新卡片。

## 工具分组与 Token

工具按 `tasks`、`lists`、`calendar`、`planning`、`imports`、`settings` 分组。每轮只暴露核心工具和当前页面相关分组；缺少工具时模型调用 `load_tool_group` 加载。系统上下文保留紧凑的分组目录。工具 Schema 会去掉冗余标题字段。

`surface` 由前端按当前路由发送，取值为 `agent`、`tasks`、`calendar`、`planning`、`imports` 或 `settings`。

## 配置

复用现有 Chat Completions 配置，并在 `backend/.env` 开启工具调用：

```dotenv
SA_LLM_BASE_URL=https://你的服务商/API前缀
SA_LLM_MODEL=支持 tools 的模型名
SA_LLM_API_KEY=本地密钥
SA_LLM_SUPPORTS_TOOLS=true
SA_LLM_SUPPORTS_IMAGES=true
SA_AGENT_MAX_STEPS=8
SA_AGENT_TIMEOUT_SECONDS=120
SA_AGENT_ACTION_TTL_SECONDS=900
SA_AGENT_MAX_ACTIONS=30
SA_AGENT_HISTORY_MESSAGES=12
SA_AGENT_IMAGE_DIR=../data/agent-images
```

模型必须支持标准 Chat Completions `tools` / function calling。未配置或未开启时，Agent 界面会显示不可用提示，其他功能不受影响。

`SA_LLM_SUPPORTS_IMAGES=true` 时，用户可以在聊天中上传图片（PNG/JPEG/WebP，最多 4 张，每张不超过 8 MiB），Agent 还可以通过 `read_task_images` 和 `read_import_image` 工具读取任务附件和导入来源中的图片。图片以 base64 data URL 内联在消息中发送给模型，不会存储在转录里。

本地开发需在单独终端启动 Agent worker：

```bash
cd backend
uv run python -m app.workers.agent
```

Docker Compose 已包含 `agent-worker` 服务。修改后端代码后需要重新构建：

```bash
docker compose up -d --build --force-recreate api worker agent-worker
```

## 数据与接口

迁移 `0021` 新增：

- `agent_conversations`：会话与数据外发同意时间
- `agent_messages`：用户与助手消息
- `agent_runs`：推理队列、租约和转录
- `agent_actions`：待确认动作、风险级别、依赖与执行结果

迁移 `0022` 新增：

- `agent_images`：聊天图片元数据，关联会话和消息

迁移 `0023` 新增：

- `agent_actions.preview`：面向确认卡片的结构化展示字段
- `agent_runs.surface`：消息来源页面，用于选择初始工具分组
- `agent_runs.phase`、`partial_content`：流式阶段与增量文本

迁移 `0026` 新增 `agent_runs.task_list_id`，保存请求发送时的当前清单。

接口前缀为 `/api/v1/agent`：

```text
GET    /capabilities
POST   /conversations
GET    /conversations
GET    /conversations/{id}
DELETE /conversations/{id}
POST   /conversations/{id}/images
POST   /conversations/{id}/messages
GET    /images/{id}
GET    /runs/{id}
GET    /runs/{id}/stream
POST   /runs/{id}/cancel
POST   /actions/{id}/confirm
POST   /actions/{id}/reject
POST   /actions/{id}/undo
```

前端提供任意页面可呼出的全局抽屉，以及 `/agent` 历史页面。

## 工具边界

工具按页面与领域分组加载，默认暴露核心只读工具和 `surface` 相关分组；需要其他领域时模型先调用 `load_tool_group`。这样每轮只发送必要的 Schema，减少上下文体积和首字延迟。

只读工具覆盖个人设置、任务与汇总、清单、文件夹、标签、保存筛选、事件、课程、系列、事件类型、当前计划、导入记录、草稿、任务附件元数据和并行兼容性检查。

当 `SA_LLM_SUPPORTS_IMAGES=true` 时，额外暴露 `read_task_images`（读取任务附件中的图片）和 `read_import_image`（读取导入来源图片）两个只读工具。图片通过 base64 data URL 内联在合成用户消息中发送给模型，不存储在转录里。

写工具覆盖任务增删改、完成/恢复、截止、提醒、旗标、垃圾箱与永久删除、工作日志、清单/文件夹/标签/保存筛选、事件/课程/重复系列、出勤、并行规则、任务类型策略、个人设置、事件类型、计划生成与采用、文本导入、草稿创建与发布。

不纳入：账号注册/登录/密码、附件二进制上传下载、外部联网工具、普通任务创建之外的无确认写操作、跨会话长期记忆。

## 确认与引用

普通任务直接生成 `executed` 动作；其余写工具生成 `proposed` 动作，默认 15 分钟过期。确认接口会重新校验：

- 当前用户与工作区
- 动作状态与过期时间
- 依赖动作是否已执行
- 目标对象是否仍然存在
- 参数是否符合现有 Schema

多步骤操作可使用动作引用：

```json
{ "list_id": { "$ref": "k1" } }
```

`k1` 是本轮前一个动作返回的 `action_key`。依赖未执行时，确认接口返回 409，前端禁用该动作。执行成功后会解析为真实对象 ID。

## 安全

- 工具只能访问当前登录用户的工作区，拒绝模型传入的归属字段。
- 参数由 Pydantic 严格校验，未知字段拒绝。
- 推理阶段仅允许普通任务创建自动写入，其他写操作仍需逐条确认；图片、来源材料和工具结果始终作为数据处理。
- 模型轮次、动作数量、总时长和动作有效期均有限制。
- 日志只记录事件名，不记录对话内容、工具参数、模型响应或密钥。
- 会话可删除；首次使用需要明确同意将对话与相关数据发送给模型。
- 文本导入仍会把材料发送给模型解析，用户需在动作卡片中确认。

## 验证

```bash
cd backend
uv run pytest -q tests/test_agent.py
```

端到端测试使用本地模型桩，不调用真实服务商：

```bash
cd frontend
npx playwright test e2e/agent.spec.ts
```
