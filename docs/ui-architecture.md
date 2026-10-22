# Student Agent 信息架构与交互重构

主导航：今日 → 收件箱 → 任务 → 日历与课程 → 学习计划。桌面为侧栏，设置与并行规则位于侧栏底部；移动端为五项固定底部导航。导入不再是顶层入口，统一收进收件箱。

## 信息架构原则

- 一级导航只承载稳定工作区；设置作为二级模块，`/settings/*` 下保持设置入口高亮。
- 详情沿用独立 URL，但必须保留来源：跨模块进入任务、事件、系列、课程或导入校对后，返回按钮显示来源名称并回到原页面。
- 创建动作就地补齐依赖。建事件或系列时可直接新建课程，不要求取消表单重来。
- URL 保存周次、筛选、对象和来源；刷新、直达与浏览器后退行为一致。
- 旧路径只重定向，不保留重复页面。

## 完整路由表

| 路由 | 职责 |
| --- | --- |
| `/` | 今日工作台：固定事件与计划块统一时间线、下一项、临期任务、上下文快速创建 |
| `/inbox` | 收件箱：材料待处理与手动任务草稿 |
| `/inbox/imports` | 新建导入材料、状态筛选与最近 100 批记录 |
| `/inbox/imports/:id` | 来源、解析进度、逐项校对、确认入库 |
| `/tasks` | 正式任务、搜索、状态筛选/分组、排序；垃圾箱切换 |
| `/tasks/new` | 新建任务抽屉；可创建正式任务或保存到收件箱 |
| `/tasks/:id` | 任务详情、编辑、恢复、来源、父子/前置/阻塞关系导航 |
| `/calendar` | 周日历、课程/系列侧栏、选中周事件；周次与视图写入 URL |
| `/calendar/events/new` | 新事件，支持 `date`、`course` 预填及 `from` 返回来源 |
| `/calendar/events/:id` | 单次事件编辑、参加状态、并行单次覆盖、删除与层级导航 |
| `/calendar/courses/:id` | 课程资料、默认并行设置、创建独立事件/重复系列、清理关联后删除 |
| `/calendar/series/new` | 建立重复系列，支持 `course` 预填 |
| `/calendar/series/:id` | 周次实例、批量时间/地点编辑、停用/恢复、删除、来源 |
| `/plans` | 当前/草稿/历史版本列表与生成入口 |
| `/plans/new` | 生成计划草稿参数 |
| `/plans/:id` | 单份计划日历、差异、未排报告、二次确认采用、返回列表与重新生成 |
| `/settings` | 账号与时区、可用时间、休息窗口 |
| `/settings/schedule` | 设置页可用时间锚点，供计划页深链 |
| `/settings/rules` | 任务类型偏好、课程默认设置、组合允许规则、兼容性检查；`?tab=types/courses/rules/check` 直达 |

旧路径重定向：`/imports` → `/inbox/imports`，`/imports/:id` → `/inbox/imports/:id`，`/events` → `/calendar`，`/events/:id` → `/calendar/events/:id`，`/courses/:id` → `/calendar/courses/:id`，`/series/:id` → `/calendar/series/:id`，`/compatibility` → `/settings/rules`。

## 关键交互与业务边界

- 今日不再只从计划块判断“下一项”；固定事件和计划块合并后取最早未结束项。只有没有任何安排且没有计划时才提示生成计划。
- 任务页保存草稿后自动进入收件箱并提示结果，避免草稿在任务列表不可见。
- 日历支持点击或拖选空白时段直接创建事件，日期、开始结束时间和当前周自动带入。事件和系列表单可内联新建课程并保持原表单内容。
- 课程详情可直接建立系列、添加独立事件；有关联系列或事件时删除按钮禁用并展示阻塞数量与清理入口。
- 从系列进入事件后删除该次事件返回系列；从课程进入系列后删除系列返回课程。任务详情、事件详情和导入来源使用 `from` 参数恢复原上下文。
- 计划详情固定提供返回列表和生成新草稿。未排报告中的任务返回时定位到计划报告区域。
- 计划页在未配置可用时间时深链到 `/settings/schedule#availability`。
- 导入校对从任务/事件打开时保留来源返回；未配置模型时禁用“保存并解析”，只允许仅保存材料。
- 收件箱使用“材料待处理”而不是笼统的“导入待确认”，解析中、失败、手动整理和已入库均有明确状态。
- 页面不存在、对象已删除时提供返回入口；设置、收件箱和日历子路由保持对应导航选中态。

## API 变更

所有路径以下列 `/api/v1` 为前缀。本次新增迁移 `0005_event_notes_and_details`，为事件、单次覆盖和系列增加备注/详情字段。

| 接口 | 语义 |
| --- | --- |
| `PUT /courses/{id}` | 修改课程名称、学期；同步该课程下事件和单次覆盖的标题，备注/详情不变 |
| `DELETE /courses/{id}` | `confirmed=true`；拒绝删除仍有关联系列/事件的课程 |
| `DELETE /events/{id}` | `confirmed=true`；删除单次及其覆盖，其他周次保留 |
| `PUT /event-series/{id}` | `confirmed=true`、`start_time`、`end_time`、`location`、`note`、`details`；批量更新原始安排，保留单次覆盖 |
| `POST /event-series/{id}/attendance` | `confirmed=true`、`is_skipped`；设置全系列参加状态 |
| `DELETE /event-series/{id}` | `confirmed=true`；删除系列、实例与覆盖，来源关联保留 |
| `POST /imports/text` | 新增 `parse`，默认 true；`parse=false` 无需模型发送同意 |
| `POST /imports/image` | multipart 新增 `parse`，默认 true；`parse=false` 可 `confirmed=false` |

事件和系列接口新增 `note`（最多 120 字）与 `details`（最多 5000 字）字段；事件的 `note_scope`/`details_scope` 分别控制单次或系列写入。读取事件时返回有效 `note`/`details`、系列值和单次值。沿用会话、CSRF、工作区归属、UTC/时区、夏令时拒绝、幂等重放、导入确认、计划 stale 校验；未改动排程算法。

## 分阶段文件清单

### 阶段 1：路由骨架与导航（`3d8b3d2`）

- `frontend/e2e/foundation.spec.ts`
- `frontend/e2e/imports.spec.ts`
- `frontend/e2e/planning-foundation.spec.ts`
- `frontend/e2e/routes.spec.ts`
- `frontend/src/App.tsx`
- `frontend/src/components/SourceButton.tsx`
- `frontend/src/pages/CalendarPage.tsx`
- `frontend/src/pages/EventsPage.tsx`
- `frontend/src/pages/ImportsPage.tsx`
- `frontend/src/pages/Login.tsx`
- `frontend/src/pages/PlansPage.tsx`
- `frontend/src/pages/SettingsPage.tsx`
- `frontend/src/pages/TasksPage.tsx`
- `frontend/src/style.css`

### 阶段 2：首页与计划页去重（`4e0180d`）

- `frontend/e2e/foundation.spec.ts`
- `frontend/e2e/scheduling.spec.ts`
- `frontend/src/App.tsx`
- `frontend/src/pages/PlansPage.tsx`
- `frontend/src/pages/TodayPage.tsx`

### 阶段 3：任务创建与详情（`ba45ab1`）

- `frontend/e2e/foundation.spec.ts`
- `frontend/e2e/planning-foundation.spec.ts`
- `frontend/e2e/routes.spec.ts`
- `frontend/e2e/scheduling.spec.ts`
- `frontend/src/App.tsx`
- `frontend/src/pages/TasksPage.tsx`

### 阶段 4：课程、系列、事件（`cb30a43`）

- `backend/app/api/planning_foundation.py`
- `backend/app/api/schemas.py`
- `backend/app/modules/records.py`
- `backend/tests/test_calendar_management.py`
- `docs/openapi.json`
- `frontend/e2e/planning-foundation.spec.ts`
- `frontend/src/App.tsx`
- `frontend/src/api.ts`
- `frontend/src/generated/api.d.ts`
- `frontend/src/pages/CalendarPage.tsx`
- `frontend/src/pages/EventsPage.tsx`
- `frontend/src/pages/HierarchyPage.tsx`

### 阶段 5：待确认与导入（`e604ea1`）

- `backend/app/api/import_schemas.py`
- `backend/app/api/imports.py`
- `backend/tests/test_imports.py`
- `docs/openapi.json`
- `frontend/e2e/imports.spec.ts`
- `frontend/src/components/ImportRecords.tsx`
- `frontend/src/generated/api.d.ts`
- `frontend/src/pages/ImportsPage.tsx`
- `frontend/src/pages/TasksPage.tsx`

### 阶段 6：并行规则与设置（`6fb7b97`）

- `frontend/e2e/planning-foundation.spec.ts`
- `frontend/src/pages/CompatibilityPage.tsx`
- `frontend/src/pages/EventsPage.tsx`
- `frontend/src/pages/HierarchyPage.tsx`

### 阶段 7：移动端与收尾

- `frontend/src/pages/CompatibilityPage.tsx`
- `frontend/src/pages/CalendarPage.tsx`
- `backend/tests/test_calendar_management.py`
- `frontend/e2e/foundation.spec.ts`
- `frontend/e2e/planning-foundation.spec.ts`
- `frontend/playwright.config.ts`
- `frontend/src/App.tsx`
- `frontend/src/pages/EventsPage.tsx`
- `frontend/src/pages/PlansPage.tsx`
- `frontend/src/pages/SettingsPage.tsx`
- `frontend/src/pages/TasksPage.tsx`
- `frontend/src/style.css`
- `frontend/e2e/workflows.spec.ts`
- `docs/ui-architecture.md`
- `README.md`

### 事件备注与详情补充

- `backend/migrations/versions/0005_event_notes_and_details.py`
- `backend/app/db/models.py`
- `backend/app/api/schemas.py`
- `backend/app/api/routes.py`
- `backend/app/api/planning_foundation.py`
- `backend/app/modules/calendar_management.py`
- `backend/tests/test_calendar_management.py`
- `backend/tests/test_foundation.py`
- `docs/openapi.json`
- `frontend/src/generated/api.d.ts`
- `frontend/src/pages/CalendarPage.tsx`
- `frontend/src/pages/EventsPage.tsx`
- `frontend/src/pages/HierarchyPage.tsx`
- `frontend/src/pages/TasksPage.tsx`
- `frontend/src/pages/PlansPage.tsx`
- `frontend/src/pages/ImportsPage.tsx`
- `frontend/src/style.css`
- `frontend/e2e/workflows.spec.ts`

备注/详情支持系列默认值与单次值分别保存并拼接展示；课程重命名同步事件标题；日历周次写入 URL；stale 计划块灰显；详情页移除全局新建入口，待确认页只新建草稿。

## 验证记录

各阶段均运行前端 `npm run check`、`npm test`、`npm run build` 和端到端回归。阶段 1–4 的主流程套件为 14 项，阶段 5–6 扩为 16 项；中途发现的导入组件重新挂载、测试标签定位、375px 标签页挤压问题已逐项修复复测。没有删除测试或放宽断言。

涉及后端的阶段运行 `uv run ruff check .`、`uv run mypy app`、`uv run pytest -q`，导出 OpenAPI 并生成前端类型。后端最终 59 项测试通过，包括系列修改的夏令时原子回滚、删除范围、审计/排程版本、仅保存文本/图片、删除后来源保留、事件备注拼接与课程重命名。

前端最终静态检查、3 项时间单元测试和构建通过。桌面与 375px 移动端共 24 项端到端测试通过；事件备注、周次 URL 与课程重命名已有回归覆盖。

## 保留的限制

- 系列批量编辑限时间、地点、备注和详情；日期范围、星期与时区仍沿用原有系列定义。停用/恢复作用于整个系列（包含历史实例），UI 确认明确说明范围。
- 事件 API 仍返回完整实例，前端限制周视图和层级展示；没有新增服务端分页。导入记录仍按既有 API 显示最近 100 批。
- 相同来源沿用去重行为，返回已有批次，不覆盖已有校对草稿；需要重新解析时在批次详情明确确认。
- 自动化使用本地模型桩，没有验证真实模型服务识别质量。移动端为 Chromium 的 375px 模拟视口，没有新增真机 Safari 验证。
- Vite 仍报告主包超过 500 kB 的构建提示；后端现有 Starlette/httpx 测试依赖有弃用提示，不影响检查通过。
