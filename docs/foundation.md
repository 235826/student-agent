# 基础工程阶段

## 本次范围

本阶段执行对话中确定的第一步：基础工程、数据库迁移、最小后端接口、可操作前端、验证与启动方式。它是 spec 第 1 阶段的起点，不等于该阶段全部功能或 P0 已交付。

- 后端使用 FastAPI 工厂函数、独立路由/schema、领域辅助服务和数据库层。
- 首次初始化创建单账号与工作区；数据库 singleton 唯一约束和写锁防止并发创建多个账号。
- Argon2id 哈希密码；数据库仅保存会话令牌摘要，Cookie HttpOnly / SameSite=Strict，可配置 Secure。每个写请求校验允许的 Origin，已登录写请求同时检查 CSRF token。登录/初始化单 IP 每五分钟至多十次尝试，限流为进程内实现，重启后重置。
- 查询和修改校验工作区归属。课程引用同样检查归属，业务错误不回显数据库语句或请求正文。
- SQLite 开启外键、WAL、5 秒锁等待；忙锁耗尽后返回可重试 503，客户端不自动重放写请求。
- SQLite 迁移固定为显式 Alembic 文件；应用启动不调用 create_all。健康检查检查版本号。
- 任务执行状态和 `trashed_at` 正交；重复软删/恢复不会重复变更。尚无计划或依赖，后续引入这些对象时必须扩展恢复校验。
- 任务/事件/设置变更和审计、`scheduling_revision` 增量在同一事务提交。
- 事件允许用户手动修改；`locked` 表示未来排程器不可移动，并非禁止用户编辑。
- 时间点以 UTC epoch 毫秒保存，API 使用带偏移的 RFC 3339；用户与事件独立保存 IANA 时区。前端以用户时区解释表单时间，拒绝不存在或有歧义的夏令时时刻。
- `event_series`、`events`、`event_overrides` 分表，并为系列+本地发生日期设置唯一约束；本阶段只开放单次事件 API，尚未开放重复规则或跳过操作。

## 接口选择

路径统一 `/api/v1`。当前编辑任务和事件使用 PUT 整体替换，表单一次提交所有可编辑字段；这具体化了规格中的示意 API，尚未提供 PATCH。软删除和恢复使用独立 POST。

用户设置使用 PUT；可用窗口与休息窗口以本地星期/时间保存。空列表表示尚未配置，本阶段不据此声称已有可执行计划。新增/修改个人时间窗口不移动已有事件。

OpenAPI 导出为 docs/openapi.json，前端类型由 openapi-typescript 生成。后端错误统一含 code、message、request_id 和可选字段级错误，字段级错误不返回输入值。

## 本阶段未覆盖

草稿、任务依赖/子任务、重复课程展开/单次跳过、活动兼容规则、计划及重排、工作日志、模型接入、导入确认幂等、JSON 导出/导入、个性化记忆、worker、完整备份恢复均留在后续阶段。数据库中的扩展表并不表示相关 UI 已实现。

本机 Compose 仅提供回环 HTTP 演示配置；尚不是直接公开到互联网的生产部署方案。Schema 就绪检查验证 Alembic 版本；文件及数据库损坏恢复另行处理。

## 技术参考

实现时核对了 [FastAPI 安全与依赖工具](https://fastapi.tiangolo.com/tutorial/security/)、[SQLAlchemy SQLite 方言说明](https://docs.sqlalchemy.org/en/20/dialects/sqlite.html) 和 [Vite 官方入门](https://vite.dev/guide/)。框架实际版本由 uv.lock 与 package-lock.json 固定。
