# Student Agent 信息架构与交互重构

主导航：今日 → 待确认 → 任务 → 日历与课程 → 学习计划。桌面为侧栏，设置、导入整理、并行规则及账号位于侧栏底部；移动端为五项固定底部导航，账号操作在设置页。

## 完整路由表

| 路由 | 职责 |
| --- | --- |
| `/` | 今日工作台：当天固定事件、计划块、下一项任务、逾期/三天内到期任务、快速创建、stale 操作 |
| `/inbox` | 导入待确认与手动任务草稿；不混入正式任务列表 |
| `/tasks` | 正式任务、搜索、状态筛选/分组、排序；独立垃圾箱切换 |
| `/tasks/:id` | 单个任务及编辑、恢复、来源、父子/前置/阻塞关系导航 |
| `/calendar` | 周日历、课程/系列侧栏、选中周的事件 |
| `/courses/:id` | 课程资料、默认并行设置、系列与独立事件、空课程删除 |
| `/series/:id` | 周次实例、批量时间/地点编辑、停用/恢复、删除、来源 |
| `/events/:id` | 单次事件编辑、参加状态、并行单次覆盖、删除与层级导航 |
| `/plans` | 当前/草稿/历史版本列表与生成草稿入口 |
| `/plans/:id` | 单份计划日历、差异、未排报告、二次确认采用 |
| `/imports` | 仅保存/保存并解析、按日期和状态分组的最近 100 批记录 |
| `/imports/:id` | 来源、解析进度、逐项校对、校对进度/阻断原因定位、确认入库 |
| `/settings` | 账号、时区、可用时间、休息窗口 |
| `/settings/rules` | 任务类型偏好、课程默认设置、组合允许规则、兼容性检查；`?tab=types/courses/rules/check` 可直达标签页 |
| `/compatibility` | 重定向 `/settings/rules` |
| `/events` | 重定向 `/calendar` |
| `/imports?job=:id` | 重定向 `/imports/:id` |
| 其他路径 | 明确的 404 页面 |

`/tasks?new=1`、`/calendar?new=1` 供今日工作台快速打开创建表单。对象详情由 URL 选择，刷新后继续加载同一对象；不存在的对象显示错误或空态，不回退为另一个对象。

## 关键交互与业务边界

- 首页不再渲染完整周历。重新生成跳转计划列表的生成表单；计划详情是版本预览与采用的唯一位置。
- 生成仍使用稳定幂等键，产生草稿。采用必须二次确认，说明替换整个当前计划、保留历史版本，以及是否存在未排工时；stale 草稿禁用采用。
- 一个任务新建入口，表单内区分保存草稿与创建任务。空标题正式任务在表单中阻止提交；草稿允许留空，显示“未命名草稿”。编辑正式任务不再提供另存草稿。
- 任务的保存、草稿保存/发布/删除、移入垃圾箱、恢复分别维护 mutation 状态。任务关系使用内部路由链接，删除不级联删除关联任务。
- 日历默认按当前/选中周展示，不平铺整个学期。课程与系列侧栏承接层级管理；事件并行下拉仅在详情显示。
- 批量修改系列仅修改原始上课时间、地点，保持日期范围、星期、时区和所有已有单次覆盖。夏令时不存在或歧义时间整批拒绝并回滚。
- 停用系列将全部实例设为不参加；恢复系列将全部设为参加，确认文案说明会覆盖单次参加状态。
- 删除单次事件会同时删除该次覆盖；删除系列会删除其事件和单次覆盖；课程只有没有系列和事件时才允许删除。操作均需明确确认。导入来源关联、已发布记录与历史计划快照保留，审计和 scheduling revision 与删除同事务提交。
- 仅保存材料直接产生可手动整理的空草稿，不进入 worker 队列，不要求模型发送同意。保存并解析必须同意；图片可显式移除并切回文本输入。
- 导入校对显示已校对 X/Y，缺少标题/未校对可定位条目，未保存/未选中/解析中分别提示原因；确认入库保留二次确认与后端原子校验。
- 内部跳转使用 React Router；原始图片的链接仍是经认证的文件查看链接。
- 兼容性检查默认只列未完成、未取消任务和未来未跳过事件；过去事件由显式勾选加入。规则配置保留完整对象选择范围。

## API 变更

所有路径以下列 `/api/v1` 为前缀，无数据库迁移。

| 接口 | 语义 |
| --- | --- |
| `PUT /courses/{id}` | 修改课程名称、学期，不改写已有事件标题 |
| `DELETE /courses/{id}` | `confirmed=true`；拒绝删除仍有关联系列/事件的课程 |
| `DELETE /events/{id}` | `confirmed=true`；删除单次及其覆盖，其他周次保留 |
| `PUT /event-series/{id}` | `confirmed=true`、`start_time`、`end_time`、`location`；批量更新原始安排，保留单次覆盖 |
| `POST /event-series/{id}/attendance` | `confirmed=true`、`is_skipped`；设置全系列参加状态 |
| `DELETE /event-series/{id}` | `confirmed=true`；删除系列、实例与覆盖，来源关联保留 |
| `POST /imports/text` | 新增 `parse`，默认 true；`parse=false` 无需模型发送同意 |
| `POST /imports/image` | multipart 新增 `parse`，默认 true；`parse=false` 可 `confirmed=false` |

沿用会话、CSRF、工作区归属、UTC/时区、夏令时拒绝、幂等重放、导入确认、计划 stale 校验；未改动排程算法。

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

## 验证记录

各阶段均运行前端 `npm run check`、`npm test`、`npm run build` 和端到端回归。阶段 1–4 的主流程套件为 14 项，阶段 5–6 扩为 16 项；中途发现的导入组件重新挂载、测试标签定位、375px 标签页挤压问题已逐项修复复测。没有删除测试或放宽断言。

涉及后端的阶段运行 `uv run ruff check .`、`uv run mypy app`、`uv run pytest -q`，导出 OpenAPI 并生成前端类型。后端最终 56 项测试通过，包括系列修改的夏令时原子回滚、删除范围、审计/排程版本、仅保存文本/图片、删除后来源保留。

前端最终静态检查、3 项时间单元测试和构建通过。桌面与 375px 移动端共 22 项端到端测试通过；最终错误态和标签页样式收尾后，课程、并行规则及计划相关的 4 项桌面/移动端复测通过。

## 保留的限制

- 系列批量编辑限时间和地点；日期范围、星期与时区仍沿用原有系列定义。停用/恢复作用于整个系列（包含历史实例），UI 确认明确说明范围。
- 事件 API 仍返回完整实例，前端限制周视图和层级展示；没有新增服务端分页。导入记录仍按既有 API 显示最近 100 批。
- 相同来源沿用去重行为，返回已有批次，不覆盖已有校对草稿；需要重新解析时在批次详情明确确认。
- 自动化使用本地模型桩，没有验证真实模型服务识别质量。移动端为 Chromium 的 375px 模拟视口，没有新增真机 Safari 验证。
- Vite 仍报告主包超过 500 kB 的构建提示；后端现有 Starlette/httpx 测试依赖有弃用提示，不影响检查通过。
