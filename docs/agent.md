# 全局 Agent

全局 Agent 通过对话调用受控工具，帮助用户查询和修改任务、日历、课程、清单、标签、规则、设置、导入与计划。模型不能直接写数据库，也不能绕过用户确认。

## 处理流程

```text
浏览器发送消息
  → API 创建 AgentRun 并入队（202）
  → agent-worker 领取
  → 模型多轮调用 tools
       只读工具：立即查询，结果回填模型
       写工具：只生成 AgentAction，不执行
  → 保存助手回复和待确认动作
  → 前端轮询 run 状态
  → 用户逐条确认或忽略动作
  → 执行器复用现有业务服务执行单条动作
  → 审计、幂等和前端缓存刷新
```

写操作必须逐条确认，不提供整批执行。删除事件/课程/系列、永久删除/清空垃圾箱、修改设置与规则、发起导入、采用计划标记为高风险。

## 配置

复用现有 Chat Completions 配置，并在 `backend/.env` 开启工具调用：

```dotenv
SA_LLM_BASE_URL=https://你的服务商/API前缀
SA_LLM_MODEL=支持 tools 的模型名
SA_LLM_API_KEY=本地密钥
SA_LLM_SUPPORTS_TOOLS=true
SA_AGENT_MAX_STEPS=8
SA_AGENT_TIMEOUT_SECONDS=120
SA_AGENT_ACTION_TTL_SECONDS=900
SA_AGENT_MAX_ACTIONS=30
SA_AGENT_HISTORY_MESSAGES=20
```

模型必须支持标准 Chat Completions `tools` / function calling。未配置或未开启时，Agent 界面会显示不可用提示，其他功能不受影响。

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

接口前缀为 `/api/v1/agent`：

```text
GET    /capabilities
POST   /conversations
GET    /conversations
GET    /conversations/{id}
DELETE /conversations/{id}
POST   /conversations/{id}/messages
GET    /runs/{id}
POST   /runs/{id}/cancel
POST   /actions/{id}/confirm
POST   /actions/{id}/reject
```

前端提供任意页面可呼出的全局抽屉，以及 `/agent` 历史页面。

## 工具边界

只读工具覆盖个人设置、任务与汇总、清单、文件夹、标签、保存筛选、事件、课程、系列、事件类型、当前计划、导入记录、草稿和并行兼容性检查。

写工具覆盖任务增删改、完成/恢复、截止、提醒、旗标、垃圾箱与永久删除、工作日志、清单/文件夹/标签/保存筛选、事件/课程/重复系列、出勤、并行规则、任务类型策略、个人设置、事件类型、计划生成与采用、文本导入、草稿创建与发布。

不纳入：账号注册/登录/密码、附件二进制上传下载、外部联网工具、无确认自动执行、跨会话长期记忆。

## 确认与引用

写工具只生成 `proposed` 动作，默认 15 分钟过期。确认接口会重新校验：

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
- 推理阶段只读；所有写入都需要用户逐条确认，提示注入无法绕过确认边界。
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
