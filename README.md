# Student Agent

面向大学生的个人任务与学习安排助手。当前实现为**基础工程、任务与规则管理、确定性排程闭环**，还不是完整 P0 MVP。

已实现：多账号与独立工作区、任务创建/编辑/软删除/恢复、事件创建/编辑、自定义事件类型、周视图、时区及每周可用/休息时间设置。新增任务草稿与幂等发布、父子任务与前置依赖、每周重复课程及单次修改/跳过、并行设置与组合规则检查。任务支持一键完成与撤销、快速改期、全天截止、逾期分组和完成时间记录；新增任务清单、标签、今天/已计划/已完成智能视图，以及按清单或标签筛选。今日页支持自然语言快速添加，可识别日期、时间、优先级、标签、预计用时和清单；任务详情可直接添加并勾选子任务；任务支持手动排序，桌面可拖动、移动端可用上下移动；支持旗标标记和“已标记”视图；标签可改名/删除，清单可排序，并提供“无日期”视图；任务搜索、视图和清单/标签筛选由服务端处理，任务列表按 50 条分页并支持“加载更多”，侧栏角标使用轻量汇总接口。任务支持每天/每周/每月重复，完成后生成下一次，撤销完成会移除未修改的下一次；任务可保存多个相关链接，并可上传附件；单文件不超过 20 MiB，每个任务最多 20 个，文件存放在 `data/attachments/`。桌面端支持任务快速查看抽屉；任务页支持批量完成、恢复、移动清单和删除；新增完成统计页；提供可安装 PWA、静态资源离线缓存和离线提示。任务清单支持文件夹和保存筛选；重复规则支持间隔、工作日、每年、结束日期/次数和按完成日；附件支持图片/PDF 预览；子任务支持嵌套、排序和批量完成；批量操作支持改期、标签与撤销；垃圾箱支持永久删除和 30 天自动清理；搜索扩展到标签、链接和附件名。支持计划草稿预览、未排工时说明、明确确认采用与历史版本。支持桌面与手机布局。新增文本与课表图片导入、后台解析、草稿校对与批量确认；AI 解析需配置兼容 Chat Completions 的模型，其他功能不依赖模型。新增全局 Agent：任意页面可呼出对话抽屉，通过受控工具查询和修改任务、日历、课程、清单、标签、规则、设置、导入与计划；写操作只生成待确认动作，用户逐条确认后才执行。Agent 需要支持 Chat Completions `tools` 的模型。

## 本地开发

需要 Python 3.13、uv、Node.js 24 LTS 与 npm。前端 Node 版本见 `.nvmrc`。

在第一个终端启动后端：

```bash
cd backend
uv sync --frozen
cp .env.example .env
uv run alembic upgrade head
uv run uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
```

`uv sync` 自动创建 `backend/.venv`，无需激活环境。默认数据库为项目根目录的 `data/student_agent.db`，必须从 `backend/` 启动命令。服务启动不会自动修改数据库 schema，迁移需单独执行。

在第二个终端启动前端：

```bash
cd frontend
npm ci
npm run dev
```

访问 http://127.0.0.1:5173，首次进入创建账号（密码至少 10 个字符）。登录页可继续创建新账号；每个账号拥有独立的任务、日历、计划和导入数据。今日页可以直接快速添加任务；计划入口改为按需打开。可以直接创建任务和事件，非必要设置均可跳过。Vite 代理 `/api` 到后端，浏览器保持同源。

需要全局 Agent 时，再开一个终端启动 Agent worker：

```bash
cd backend
uv run python -m app.workers.agent
```

Agent 配置见 [全局 Agent](docs/agent.md)，需要在 `backend/.env` 设置 `SA_LLM_SUPPORTS_TOOLS=true` 并选择支持工具调用的模型。

测试会使用独立临时数据库；端到端测试专用 `data/e2e.db` 会在每次启动时重建，不触碰正常数据库。

## 演示数据（独立 demo 库）

演示数据写入独立的 `data/demo.db`，不会修改正常数据库或端到端测试数据库：

```bash
cd backend
uv run python -m scripts.seed_demo --reset
SA_DATABASE_URL=sqlite:///$(pwd)/../data/demo.db \
  uv run uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
```

登录账号为 `demo`，密码为 `demo-password-123`。演示库包含课程、每周课程、考试/会议/自定义类型事件、任务草稿、当前计划、并行规则和待校对导入。删除 `data/demo.db` 即可清理演示数据。

Docker 正式库也可以在不影响现有账号的情况下追加独立 demo 账号：

```bash
docker compose up --build -d
docker compose exec api .venv/bin/python -m scripts.seed_demo_account
```

访问 `http://127.0.0.1:8080`，使用 `demo` / `demo-password-123` 登录。真实账号与 demo 账号的数据通过工作区完全隔离。

## Docker Compose（本机演示）

```bash
docker compose up --build -d
```

访问 http://127.0.0.1:8080。`migrate` 是一次性迁移服务，成功后才启动 API；API 就绪后启动 Caddy。数据库存储于命名卷 `student_data`。`docker compose down` 保留数据；不要使用 `down -v`，除非明确要删除个人数据。

当前包含 gateway、api、独立解析 worker、独立 Agent worker 和一次性 migrate；配置见 [导入流程](docs/imports.md) 与 [全局 Agent](docs/agent.md)。网关只绑定本机回环。公网/手机局域网部署需另行配置可信 HTTPS、`SA_ALLOWED_ORIGINS`、`SA_COOKIE_SECURE=true`，并先完成账号初始化。

## 验证

```bash
cd backend
uv run ruff check .
uv run ruff format --check .
uv run mypy app
uv run pytest -q
uv run alembic check
uv run python -m scripts.export_openapi
```

```bash
cd frontend
npm run generate:api
npm run check
npm test
npm run build
npx playwright install --no-shell chromium
npm run test:e2e
```

端到端测试启动自己的服务，需要 8000 和 5173 端口空闲。它验证桌面和手机视口的账号、任务、事件、设置与退出/重新登录流程。

接口契约：[docs/openapi.json](docs/openapi.json)。后端变更后重新导出 OpenAPI 并运行 `npm run generate:api`；生成的类型提交到 Git。任务、事件使用 `PUT` 整体更新，省略的可选字段恢复默认值；详情见 [阶段说明](docs/foundation.md)。

## 需求与架构

- [产品主线](docs/product-mvp.md)
- [产品意图](intent.md)
- [功能规格 v0.3](spec-v0.3.md)
- [技术基线 v1.0](architecture-tech-stack-v1.0.md)
- [全局 Agent](docs/agent.md)
- [本阶段边界与实现说明](docs/foundation.md)

第二阶段说明见 [任务与规则基础](docs/planning-foundation.md)，验证结果见 [验证记录](docs/verification.md)。第三阶段说明见 [确定性排程](docs/scheduling.md)。第四阶段说明见 [文本与课表图片导入](docs/imports.md)。任务完成后可记录实际耗时、原因和 reflection；重新生成计划时会扣除已记录工时。任务卡勾选即完成，可从提示撤销，系统记录完成时间；截止时间可设为全天。当前不运行后台提醒。

前端最新导航、详情路由、课程清理及仅保存材料流程见 [信息架构与交互重构](docs/ui-architecture.md)。产品主线以 [产品主线](docs/product-mvp.md) 为准，`spec-v0.3.md` 作为能力与约束参考。
