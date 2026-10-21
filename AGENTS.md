# 项目协作约定

- 始终使用简体中文回应。

## Git 提交与推送

- 每完成一个可独立理解的功能或修复，并通过相关检查后，创建一次提交；不要按固定时间凑提交。
- 提交前检查 `git status` 和差异，只暂存本次改动，不覆盖或误提交用户的其他修改。
- 提交信息遵循 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/)：

  ```text
  <type>[(scope)][!]: <description>

  [body]

  [footer(s)]
  ```

- `type` 使用小写：`feat` 新功能、`fix` 修复、`docs` 文档、`refactor` 重构、`test` 测试、`perf` 性能、`build` 构建或依赖、`ci` 流水线、`style` 纯格式、`chore` 其他维护。根据实际改动选择，不把功能提交写成 `chore`。
- `scope` 可选，使用简短模块名，例如 `api`、`db`、`frontend`、`planning`。冒号后必须有空格和具体描述；主题行尽量不超过 72 个字符，不以句号结尾。
- 需要解释原因、取舍或验证时，空一行后写正文。破坏兼容性时在类型或范围后加 `!`，并在脚注中写明 `BREAKING CHANGE: <影响和迁移方法>`。
- 示例：`feat(planning): add recurring courses and task dependencies`；`fix(scheduler): reject stale plan adoption`；`docs(repo): define Git commit rules`。
- 不自动推送。只有用户明确要求推送时，才执行 `git push`。
- 用户要求“先不执行”时，只说明操作方案，不修改文件或运行 Git 写操作。
