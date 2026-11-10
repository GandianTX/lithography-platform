# V13 数据库交付

本 PR 只保留当前交接说明。正式入口统一为 [docs/database/v13-deployment](docs/database/v13-deployment/README.md)；旧 43 态与旧路径仅作为历史证据链接，不再作为执行步骤。

## 当前终态

- 44 条迁移，51 张业务表；预建空库后使用 `database:deploy --mode=init`。
- `previous_version` 最终非空、无默认值；第 44 条迁移在回填前预检未知历史值并拒绝。
- 同一条 init 命令可完成组织、3 个一级与 3 个二级管理员，以及显式启用的客户/工程师开发账号初始化。
- `upgrade` 仅用于已确认来源与起点的库；无法满足新约束时拒绝，不猜测回填、不删数据制造成功。
- 接口、前端、真实登录、Worker、Redis、云端执行器与完整业务 core 不在本 PR 的完成声明内。

## 交接材料

- [正式部署 SOP](docs/database/v13-deployment/deployment-sop.md)
- [字段字典](docs/database/v13-deployment/schema-dictionary.md)
- [数据契约](docs/database/v13-deployment/data-contracts.md)
- [复审回执](docs/database/v13-deployment/review-response.md)
- [无秘密部署模板](docs/database/v13-deployment/database-deploy.env.example)

## 验证边界

- 已完成定向离线回归、类型检查、ESLint/Prettier、完整单测（1889 passed / 2091 total）与 `build`，退出码均为 0。
- 已在专用隔离 MySQL 8.0 实例（`127.0.0.1:3307`，非 3306）完成交付档实库复跑：正常档 72 passed / 3 skipped，
  冲突档 75 passed / 0 skipped，退出码均 0；上游 consumer 与线程停采注入只在该隔离实例执行并逐项恢复。
- 冲突反例按设计保留冲突行及必要父资源（`stored_file=1`、`local_backup_run=1`）；Jest 退出后由独立连接复核
  外部写入值与账号/组织/安装引用仍在。该保留现场不是零残留结果，处置前不得将同库用于 R09 零残留组验收。

## 历史证据

- 42→43 冻结候选、旧计划路径与更早执行日志：[b3b8ae0](https://github.com/GandianTX/lithography-platform/commit/b3b8ae0)。仅用于追溯，不代表当前执行步骤。
