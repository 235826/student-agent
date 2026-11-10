# Student Agent 信息架构与交互重构

主导航：任务 → 日历 → 收件箱。桌面为侧栏，设置位于侧栏底部；移动端为三项固定底部导航，宽度随入口数量自动均分。学习计划不再是一级导航，改为从今日按需打开的“安排”动作。

“今日”导航入口暂时隐藏，页面组件与 `/` 路由保留。需要恢复时，将 `frontend/src/App.tsx` 中的 `SHOW_TODAY_NAV` 改为 `true`，即可同时恢复桌面和手机入口。

## 信息架构原则

- 账号系统支持多用户；每个账号拥有独立工作区，任务、事件、课程、计划、导入和规则均按工作区隔离。登录页在已有账号时可继续创建新账号。
- 一级导航只承载稳定工作区；设置作为二级模块，`/settings/*` 下保持设置入口高亮。
- 详情沿用独立 URL，但必须保留来源：跨模块进入任务、事件、系列、课程或导入校对后，返回按钮显示来源名称并回到原页面。
- 创建动作就地补齐依赖。建事件或系列时可直接新建课程，不要求取消表单重来。
- URL 保存周次、筛选、对象和来源；刷新、直达与浏览器后退行为一致。
- 旧路径只重定向，不保留重复页面。

## 完整路由表

| 路由 | 职责 |
| --- | --- |
| `/` | 今日：快速添加任务、今天要做、今天的安排、接下来、按需让 Agent 安排 |
| `/inbox` | 收件箱：材料待处理与手动任务草稿 |
| `/inbox/imports` | 新建导入材料、状态筛选与最近 100 批记录 |
| `/inbox/imports/:id` | 来源、解析进度、逐项校对、确认创建 |
| `/tasks` | 正式任务、搜索、状态筛选/分组、排序；垃圾箱切换 |
| `/tasks/new` | 新建任务抽屉；可创建正式任务或保存到收件箱 |
| `/tasks/:id` | 任务详情、编辑、恢复、来源、父子/前置/阻塞关系导航 |
| `/calendar` | 月/周/列表日历、课程/系列侧栏、所选月份或周的事件；日期与视图写入 URL |
| `/calendar/events/new` | 新事件，支持 `date`、`course` 预填及 `from` 返回来源 |
| `/calendar/events/:id` | 单次事件编辑、参加状态、并行单次调整、删除与层级导航 |
| `/calendar/courses/:id` | 课程资料、默认并行设置、创建独立事件/重复系列、清理关联后删除 |
| `/calendar/series/new` | 建立重复系列，支持 `course` 预填 |
| `/calendar/series/:id` | 周次实例、批量时间/地点编辑、停用/恢复、删除、来源 |
| `/stats` | 完成统计：今天/本周/本月、最近 14 天柱状图、预计与实际用时 |
| `/plans` | 按需安排面板与历史版本；不再出现在主导航 |
| `/plans/new` | 从今日或任务进入的安排参数 |
| `/plans/:id` | 单份安排预览、差异、未排报告、确认采用和历史版本 |
| `/settings` | 账号与时区、可用时间、休息窗口 |
| `/settings/schedule` | 设置页可用时间锚点，供计划页深链 |
| `/settings/event-types` | 非课程事件的自定义类型管理：名称、颜色、归档与使用数量 |
| `/settings/rules` | 任务类型设置、课程默认设置、组合规则、兼容性检查；`?tab=types/courses/rules/check` 直达 |

旧路径重定向：`/imports` → `/inbox/imports`，`/imports/:id` → `/inbox/imports/:id`，`/events` → `/calendar`，`/events/:id` → `/calendar/events/:id`，`/courses/:id` → `/calendar/courses/:id`，`/series/:id` → `/calendar/series/:id`，`/compatibility` → `/settings/rules`。

## 关键交互与业务边界

- 今日不再只从计划块判断“下一项”；事件和计划块合并后取最早未结束项。只有没有任何安排且没有计划时才提示生成计划。
- 任务页保存草稿后自动进入收件箱并提示结果，避免草稿在任务列表不可见。
- 今日页和任务卡勾选即完成，提示中可撤销；记录实际用时仍可从任务行进入。无关联任务的删除直接从提示撤销，有子任务或依赖时仍要求确认。
- 任务可快速改期到今天、明天、本周末、下周一或清除截止；全天任务只展示日期。
- 任务页提供全部、今天、已计划、无日期、已标记、已完成、已归档和垃圾箱视图；“全部”默认排除已完成，只显示待开始和进行中；已完成按完成日期分组。清单筛选可点任务卡上的清单标签切换，也可从筛选框选择；删除清单不会删除任务，任务回到收件箱。视图、搜索、状态、清单和标签筛选均传给服务端，搜索输入有 300ms 防抖。列表每次加载 50 条，底部“加载更多”继续分页；手动排序在还有未加载任务时禁用并提示先加载全部。
- 任务卡关联标题按需批量解析，避免列表加载全部任务；任务编辑器打开时才加载全部任务作为父任务/前置任务选项。
- 清单支持文件夹分组；任务页可保存当前视图、搜索、状态、清单、标签和排序为自定义筛选。
- 搜索覆盖标题、描述、标签、链接和附件名。
- 垃圾箱任务可永久删除或清空；每次移入垃圾箱时自动清理超过 30 天的任务。
- “管理清单”支持上下移动调整顺序，顺序持久化并同步到筛选下拉和任务编辑器。
- 任务编辑器可输入多个标签，保存时按名称自动创建；任务卡标签可点击切换筛选，也可从“筛选标签”下拉选择。“管理标签”支持重命名、删除和查看未删除任务的使用次数。
- 编辑器可选择每天/每周/每月/每年/工作日重复，并设置间隔、结束日期、剩余次数和是否按完成日计算。重复任务必须有截止时间。完成时按规则推进并跳过已过期周期，生成的新任务继承标题、描述、相关链接、优先级、旗标、标签、清单、估时和父任务，不复制子任务和前置依赖。撤销完成时，若生成的下一次任务未被修改且无关联，则删除；有关联时移入垃圾箱。
- 今日页快速添加支持自然语言：今天/明天/后天、周几/下周几、M月D日、HH:mm 或“下午3点半”、`#标签`、`!1`–`!4` 或 `!高`、`预计30分钟`、`@清单名`。输入时显示解析预览；仅日期按全天处理，只有时间且已过时顺延到明天，周几时间已过时顺延到下一周。
- 任务详情提供内联子任务 checklist：输入标题回车即创建，子任务继承父任务清单；支持多级嵌套、同级上下移动、全部完成和清除已完成，标题显示完成/取消状态和 `已完成数/总数`。
- 任务编辑器支持“相关链接”，每行一个 http/https 地址，最多 20 个；任务卡按原顺序展示可点击链接，服务端会去重并拒绝非 http/https 地址。
- 任务详情提供附件能力：无附件时不渲染附件模块，只在任务操作行显示“添加附件”；有附件时使用紧凑列表展示文件名和大小，支持预览、下载和删除。文件按工作区存放到 `attachment_dir`，下载默认强制 `Content-Disposition: attachment` 并设置 `nosniff`，仅安全图片/PDF 允许内联预览，不使用原始文件名作为磁盘路径。垃圾箱任务不能上传附件。
- 桌面端任务卡提供“快速查看”抽屉（`/tasks/{id}?drawer=1`），列表保持可见；抽屉内可查看详情、子任务和附件，并可编辑或打开完整详情。移动端忽略抽屉参数，使用完整详情页。
- 任务页支持批量选择：批量完成、恢复待办、改期、移动清单、添加/移除标签、移入垃圾箱，并提供一次撤销。批量操作逐项执行并汇总失败数；批量删除会带影响确认。
- 侧栏底部提供“统计”入口。统计按用户时区计算今天/本周/本月完成数、最近 14 天每日完成数和预计/实际分钟；已恢复为待办的任务不计入。
- 排序选择“手动排序”后，桌面可拖动卡片、移动端可用上移/下移按钮调整顺序；为保持范围明确，存在搜索、状态或标签筛选时禁用拖动并提示清除筛选。排序不影响排程版本。
- 任务卡和今日页提供星标按钮，可一键标记或取消；“已标记”视图显示未取消的旗标任务，完成或取消任务后仍保留旗标状态。
- 日历支持点击或拖选空白时段直接创建事件，日期、开始结束时间和当前周自动带入。事件和系列表单可内联新建课程并保持原表单内容。
- 课程详情可直接建立系列、添加独立事件；有关联系列或事件时删除按钮禁用并展示阻塞数量与清理入口。
- 从系列进入事件后删除该次事件返回系列；从课程进入系列后删除系列返回课程。任务详情、事件详情和导入来源使用 `from` 参数恢复原上下文。
- 计划详情固定提供返回列表和生成新草稿。未排报告中的任务返回时定位到计划报告区域。
- 计划页在未配置可用时间时深链到 `/settings/schedule#availability`。
- 导入校对从任务/事件打开时保留来源返回；未配置模型时禁用“保存并解析”，只允许仅保存材料。
- 收件箱使用“材料待处理”而不是笼统的“导入待确认”，解析中、失败、已取消解析和已创建均有明确状态。
- 课程身份只由 `series_id` 或 `kind=course` 表示；每周课程、单次课程不接受自定义事件类型。其他事件使用内置考试/会议/其他或自定义类型，行为仍按普通事件处理。
- 事件展示统一按“每周课程 → 课程 → 自定义类型名称 → 其他”解析；颜色来自课程固定色或事件类型颜色，并用于事件卡片、今日议程和周历。
- 事件类型可新建、改名、改色和归档。归档类型不能用于新事件，但历史事件继续显示原名称和颜色。
- 页面不存在、对象已删除时提供返回入口；设置、收件箱和日历子路由保持对应导航选中态。
- 任务详情展开后显示执行记录时间线，可补写、修改和删除实际用时、原因、备注、reflection，并关联同时进行的课程/事件/任务。
- 事件详情提供活动反馈：整体感受 1–5、可选标签和自由文本，可修改和删除。
- 任务视图新增“已归档”；归档任务不进入默认列表和排程，可在归档视图搜索并恢复。
- 计划详情可展开“查看每个计划块的安排依据”，显示安排理由、优先级、截止时间、预计用时、可用窗口和并行规则来源。
- 设置页新增“数据与隐私”：JSON 导出、导入校验和账号注销。注销采用 7 天冷静期，期间只读并可取消；到期删除业务数据和附件，匿名审计保留 30 天。
- 首次进入提供可跳过的三步引导：创建任务、导入课表/作业、设置可用时间；设置页可重新打开。
- 收件箱支持 PDF、DOCX、TXT、Markdown 文件；扫描版 PDF 不自动 OCR，提示改用图片导入。

## 执行反馈

- 任务完成时可记录实际耗时、原因、备注和 reflection。
- 执行记录可关联并行情境，活动本身可单独记录反馈，不混同为任务实际耗时。
- 排程使用“预计用时 − 已记录实际耗时”计算剩余工时。
- 计划报告显示已记录分钟数；重新生成计划后仍需用户确认采用。

## API 变更

所有路径以下列 `/api/v1` 为前缀。事件类型改造新增迁移 `0006_event_types`；此前的 `0005_event_notes_and_details` 增加备注/详情字段。

| 接口 | 语义 |
| --- | --- |
| `GET /tasks` | 任务列表；支持 `view`、`q`、`status`、`list_id`、`tag`、`flagged`、`due_from`、`due_to`、`limit`、`offset` |
| `GET /tasks/summary` | 今日、逾期、旗标和垃圾箱等轻量计数 |
| `GET /stats/completion` | 完成统计；`days` 1–90，按用户时区聚合 |
| `GET /tasks/{id}` | 单个任务详情，包含垃圾箱任务 |
| `GET /tasks/{id}/attachments` | 列出任务附件元数据 |
| `POST /tasks/{id}/attachments` | multipart 上传附件；单文件 ≤ 20 MiB，每任务 ≤ 20 个 |
| `GET /attachments/{id}` | 下载附件；`inline=true` 时对图片/PDF 内联预览，其他类型仍强制下载 |
| `DELETE /attachments/{id}` | 删除附件记录和磁盘文件 |
| `POST /tasks/titles` | 按 ID 批量解析关联任务标题，含垃圾箱任务 |
| `GET /task-list-groups` | 列出清单文件夹 |
| `POST /task-list-groups` | 新建文件夹；同名拒绝 |
| `PUT /task-list-groups/{id}` | 重命名文件夹 |
| `DELETE /task-list-groups/{id}` | 删除文件夹，清单移出文件夹 |
| `GET /saved-filters` | 列出保存的自定义筛选 |
| `POST /saved-filters` | 保存筛选名称和过滤条件 |
| `PUT /saved-filters/{id}` | 更新筛选名称和条件 |
| `DELETE /saved-filters/{id}` | 删除筛选 |
| `POST /tasks/{id}/subtasks/reorder` | 设置同级子任务顺序 |
| `DELETE /tasks/{id}/permanent` | 永久删除垃圾箱任务及附件 |
| `POST /tasks/trash/purge` | 永久清空垃圾箱 |
| `GET /task-lists` | 列出当前工作区任务清单 |
| `POST /task-lists` | 新建清单：名称、颜色；同名拒绝 |
| `PUT /task-lists/{id}` | 修改清单名称与颜色 |
| `DELETE /task-lists/{id}` | 删除清单，关联任务移入收件箱（`list_id` 置空） |
| `POST /task-lists/reorder` | 按给定 ID 顺序写入清单 `sort_order`；重复 ID 拒绝 |
| `POST /tasks/reorder` | 按给定 ID 顺序写入 `sort_order`；重复 ID 拒绝，垃圾箱任务拒绝 |
| `PATCH /tasks/{id}/flag` | 设置旗标；不影响排程版本，垃圾箱任务拒绝 |
| `GET /tags` | 列出当前工作区标签及未删除任务的使用次数 |
| `PUT /tags/{id}` | 重命名标签；同名拒绝，任务关联保留 |
| `DELETE /tags/{id}` | 删除标签并移除所有任务关联 |
| `POST /tasks/{id}/complete` | 标记完成并写入 `completed_at`；前置任务未完成时拒绝 |
| `POST /tasks/{id}/reopen` | 恢复为待办并清空 `completed_at` |
| `PATCH /tasks/{id}/deadline` | 只更新截止时间与 `deadline_all_day`；传 null 清除截止 |
| `GET /event-types` | 列出当前工作区事件类型；默认排除已归档，`include_archived=true` 包含归档 |
| `POST /event-types` | 新建自定义类型：名称、颜色；内置名称不可占用 |
| `PUT /event-types/{id}` | 修改自定义类型；内置类型不可修改 |
| `DELETE /event-types/{id}` | 归档自定义类型；历史事件保留显示 |
| `PUT /courses/{id}` | 修改课程名称、学期；同步该课程下事件和单次调整的标题，备注/详情不变 |
| `DELETE /courses/{id}` | `confirmed=true`；拒绝删除仍有关联系列/事件的课程 |
| `DELETE /events/{id}` | `confirmed=true`；删除单次及其覆盖，其他周次保留 |
| `PUT /event-series/{id}` | `confirmed=true`、`start_time`、`end_time`、`location`、`note`、`details`；批量更新原始安排，保留单次调整 |
| `POST /event-series/{id}/attendance` | `confirmed=true`、`is_skipped`；设置全系列参加状态 |
| `DELETE /event-series/{id}` | `confirmed=true`；删除系列、实例与覆盖，来源关联保留 |
| `POST /imports/text` | 新增 `parse`，默认 true；`parse=false` 无需模型发送同意 |
| `POST /imports/image` | multipart 新增 `parse`，默认 true；`parse=false` 可 `confirmed=false` |
| `POST /imports/file` | 上传 PDF/DOCX/TXT/Markdown，提取文本后进入同一草稿流程；扫描版 PDF 返回 422 并提示改用图片 |
| `GET /tasks/{id}/worklogs` | 列出执行记录及并行情境 |
| `POST /tasks/{id}/worklogs` | 新增实际用时、原因、备注、reflection 和 `parallel_contexts` |
| `PUT /worklogs/{id}` | 修改原因、备注、reflection 和并行情境 |
| `DELETE /worklogs/{id}` | 删除执行记录并触发剩余工时重算 |
| `GET/POST/PUT/DELETE /events/{id}/feedback` | 活动反馈；与事件关联，不伪造任务耗时 |
| `POST /tasks/{id}/archive` / `unarchive` | 归档/恢复任务；归档任务不参与排程 |
| `GET /data/export` | 导出 JSON v1，不含附件 |
| `POST /data/import/validate` | 校验导入文件版本、引用和 ID 冲突；完整恢复为 P1 |
| `GET/POST /account/deletion` | 查询注销状态、提交注销申请 |
| `POST /account/deletion/cancel` | 冷静期内取消注销 |

事件接口新增 `event_type_id`；`kind` 收敛为 `course/other`，课程事件不能设置自定义类型。非课程事件未指定类型时使用内置“其他”。导入候选可携带 `event_type_id`，模型输出的 `event_kind` 仅作为考试/会议/其他提示。事件和系列接口仍支持 `note`（最多 120 字）与 `details`（最多 5000 字）；事件的 `note_scope`/`details_scope` 分别控制单次或系列写入。读取事件时返回有效 `note`/`details`、系列值和单次值。沿用会话、CSRF、工作区归属、UTC/时区、夏令时拒绝、幂等重放、导入确认、计划 stale 校验；未改动排程算法。

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
- 事件 API 仍返回完整实例，前端按所选月份或周筛选并提供层级展示；没有新增服务端分页。导入记录仍按既有 API 显示最近 100 批。
- 相同来源沿用去重行为，返回已有批次，不覆盖已有校对草稿；需要重新解析时在批次详情明确确认。
- 自动化使用本地模型桩，没有验证真实模型服务识别质量。移动端为 Chromium 的 375px 模拟视口，没有新增真机 Safari 验证。
- PWA 使用手写 `manifest.webmanifest` 和 `sw.js`，缓存应用壳和静态资源；`/api` 与 `/health` 不缓存，离线时仅能打开已缓存界面，数据请求仍会失败。
- Vite 构建不再报告主包超过 500 kB；后端现有 Starlette/httpx 测试依赖有弃用提示，不影响检查通过。

## 日历月视图

日历工具栏提供「月 / 周 / 列表」，默认仍为桌面周视图、手机列表视图。月视图展示事件、课程和已采用的计划块，每天最多显示 3 项，其余通过“还有 N 项”展开；展开后可查看完整标题和备注。点击日期默认新建当天 09:00–10:00 的事件，时间可编辑。

URL 使用 `view=dayGridMonth`，沿用 `week` 参数保存当月首日；月份与视图一次更新，日期锚点取日历的实际月份起点，不取网格补齐的上月日期。下方事件列表按整月相交范围筛选，刷新及详情返回保留月份与视图。

日历时间统一使用 24 小时制 `HH:mm`，包括整点、周视图时间轴、列表与当天展开层。工具栏「显示内容」提供全部（默认）、仅课程、隐藏课程；课程包含独立课程事件和每周重复课程。「仅课程」隐藏其他事件与计划块，「隐藏课程」保留其他事件和计划块，下方事件列表同步筛选。筛选分别以 `content=courses`、`content=hide-courses` 写入 URL，切换视图、月份、刷新及详情返回时保留；无结果提示“当前筛选下暂无安排”。

## 任务列表直接操作

- 日期分组提供原地新增行，默认继承分组日期、当前清单和标签筛选；仅日期存为用户时区当天结束，未要求提醒时不设置提醒。回车保存后继续录入，Esc 取消，空标题不创建；失焦保存有内容的输入，失败保留内容并允许重试。输入法组词期间不触发回车保存。
- 点击任务行选中，点击标题原地编辑；详情通过独立展开按钮打开。标题回车或失焦保存，Esc 取消；保存失败显示错误并保留输入。日期分组不重复常驻显示全天日期，悬停或键盘聚焦可改期；有具体时刻时直接显示 `HH:mm`。
- ⌘/Ctrl 点选、Shift 连选与既有批量模式共存；方向键移动焦点和选择，Shift + 上下键连续选择，空格完成/恢复，Enter 编辑，Delete/Backspace 删除，Esc 清除选择。文本输入框保留原生编辑与撤销行为，不接管浏览器新窗口等快捷键。
- 右键或“更多操作”菜单提供完成、改期、提醒、标记、优先级、移动清单、添加子任务、取消缩进和详细设置。多选时适用的菜单项处理选中的多项任务；提醒和详细设置针对当前行。
- 子任务在主列表中缩进展开并可直接添加，父任务已显示时不重复平铺子任务。完整详情页继续保留原有子任务排序和批量操作。
- 整行可拖动；拖动已选任务会带上其他选中项，可移到日期分组或桌面侧栏清单。按住 Alt 拖到另一任务上建立父子关系，后端仍校验循环与关联约束；拖动把手继续支持跨日期移动。目标日期会保留具体时刻，拖到无日期清除日期。
- 桌面侧栏直接提供今天、已计划、全部、已标记、已完成及清单/文件夹；手机保留顶部视图和筛选入口。空日期压缩为新增行，空的远期月份不占位。
- 工具栏撤销及列表聚焦时的 ⌘/Ctrl+Z 共用最近 50 步撤销记录，覆盖新增、编辑、完成、日期、提醒、优先级、标记、清单、排序、父子关系、删除和批量操作。记录仅在当前任务页面会话中保留，刷新或离开任务页面后不保留；输入框内使用原生撤销。永久删除不在撤销范围内。
- 修改按字段记录逆操作，检测到该字段在之后被修改时拒绝覆盖；多项修改部分失败时，已成功部分仍有撤销入口。网络写入按顺序执行；日期、提醒、标记和完成沿用各自业务接口，不额外改变排程规则。普通编辑与清单移动保留原有提醒字段。
