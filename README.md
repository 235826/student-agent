# Student Agent

面向大学生的个人任务与学习安排助手。当前实现为**基础工程、任务与规则管理、确定性排程闭环**，还不是完整 P0 MVP。

已实现：多账号与独立工作区、任务创建/编辑/软删除/恢复、事件创建/编辑、自定义事件类型、周视图、时区及每周可用/休息时间设置。新增任务草稿与幂等发布、父子任务与前置依赖、每周重复课程及单次修改/跳过、并行设置与组合规则检查。支持计划草稿预览、未排工时说明、明确确认采用与历史版本。支持桌面与手机布局。新增文本与课表图片导入、后台解析、草稿校对与批量确认；AI 解析需配置兼容 Chat Completions 的模型，其他功能不依赖模型。

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

当前包含 gateway、api、独立解析 worker 和一次性 migrate；配置见 [导入流程](docs/imports.md)。网关只绑定本机回环。公网/手机局域网部署需另行配置可信 HTTPS、`SA_ALLOWED_ORIGINS`、`SA_COOKIE_SECURE=true`，并先完成账号初始化。

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

- [产品意图](intent.md)
- [功能规格 v0.3](spec-v0.3.md)
- [技术基线 v1.0](architecture-tech-stack-v1.0.md)
- [本阶段边界与实现说明](docs/foundation.md)

第二阶段说明见 [任务与规则基础](docs/planning-foundation.md)，验证结果见 [验证记录](docs/verification.md)。第三阶段说明见 [确定性排程](docs/scheduling.md)。第四阶段说明见 [文本与课表图片导入](docs/imports.md)。任务完成后可记录实际耗时、原因和 reflection；重新生成计划时会扣除已记录工时。当前不运行后台提醒。

前端最新导航、详情路由、课程清理及仅保存材料流程见 [信息架构与交互重构](docs/ui-architecture.md)。
