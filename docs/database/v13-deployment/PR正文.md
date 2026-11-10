# V13 数据库交付

本 PR 只保留当前交接说明。正式入口统一为 [本目录说明](README.md)；旧 43 态与旧路径仅作为历史证据链接，不再作为执行步骤。

> 链接口径：仓库内使用同目录相对链接。粘贴到 GitHub PR 正文时，将前缀替换为
> `https://github.com/GandianTX/lithography-platform/blob/<候选提交>/docs/database/v13-deployment/`，
> 再逐个核对文件存在。

## 关联任务

- Issue：未关联（数据库交付专项）
- 页面/模块：`docs/database/v13-deployment` 部署、验收与复审材料
- 使用角色：DBA / 部署维护者 / 复审人

## 改动内容

- 前端：不适用（无前端变更）
- GraphQL 契约：不适用（未改 schema 与 resolver）
- 后端：数据库部署 CLI、迁移、账号初始化，以及 V13 专项验收规格与交付文档。
- 权限：不涉及运行期授权改动；专项观测所需的 `performance_schema` 权限另行授权，见 SOP 2.1 / 2.2。

## 当前终态

- 44 条迁移，51 张业务表；预建空库后使用 `database:deploy --mode=init`。
- `previous_version` 最终非空、无默认值；第 44 条迁移在回填前预检未知历史值并拒绝。
- 同一条 init 命令可完成组织、3 个一级与 3 个二级管理员，以及显式启用的客户/工程师开发账号初始化。
- `upgrade` 仅用于已确认来源与起点的库；无法满足新约束时拒绝，不猜测回填、不删数据制造成功。
- 接口、前端、真实登录、Worker、Redis、云端执行器与完整业务 core 不在本 PR 的完成声明内。

## 数据库影响

- [x] 涉及数据库结构，已单独说明并获得负责人确认：44 条迁移、51 张业务表（含 `migrations` 共 52 张）。
      本批次（P1/P2 修复）只改验收规格与文档，不新增或修改迁移、Entity。
- [x] Seed 可重复执行且不会制造重复数据：同一配置重跑 0 条迁移，管理员账号 `UNCHANGED`，不重置密码、不改等级与归属。
- [ ] 不涉及 Entity/Migration：不适用（本 PR 整体含迁移与结构）。

## 交接材料

- [正式部署 SOP](deployment-sop.md)
- [字段字典](schema-dictionary.md)
- [数据契约](data-contracts.md)
- [复审回执](review-response.md)
- [无秘密部署模板](database-deploy.env.example)

## 验证

- [x] 后端构建和类型检查通过。
- [x] 相关测试通过：离线定向回归（竞争用例恢复归属 3 条、线程停采结果分类与 CAS 诊断）通过；
      完整单测 `205 skipped / 1895 passed / 2100 total`、`0 failed / 0 todo`、`npm run build` 退出码 0。
- [x] 专用隔离实例实库通过：normal、fault（显式关闭 `E2E_V13_SECOND_CONNECTION`）、
      fault-UNKNOWN、fault-ASSERT-AFTER、conflict 五档均为 3 suites passed，退出码 0；
      进程退出后由独立 mysql 连接复核保留资源与零残留边界。
- [ ] 前端构建通过：不适用（无前端变更）。
- [ ] 正确角色可以访问 / 错误角色无法访问：不适用（无接口与授权变更）。
- [ ] 前后端使用真实接口跑通 / 刷新后数据仍然正确：不适用（无页面与接口变更）。
- [x] 没有提交密钥、真实数据、构建产物或模型文件。

## 验收说明

- 实库正例与反例只在专用隔离实例执行，且需单独授权：`database:deploy --mode=init`（空库）、重跑幂等、
  `--mode=upgrade`（仅已确认起点）、V13 专项规格的正常档、fault 档、conflict 档与 R09 零残留组。
- 竞争用例：另一连接先成功停采后，本轮条件 UPDATE 必须 0 行且保持 `NO`；只有明确命中 1 行的执行方才登记恢复责任。
  结果未知时报告定位信息并保留现场；成功写入后即使断言失败，仍按已登记事实恢复。
- 冲突用例：受控外部连接改写 `local_backup_run.finished_at` 后，恢复必须拒绝覆盖，并在恢复阶段实际冲突处立即登记
  套件级保留；`stored_file=1`、`local_backup_run=4`（含前序受控反例）为设计保留现场，
  处置前不得将同库用于零残留验收。
- 测试账号使用配置中的专用测试账号；预期结果以 SOP 的断言与退出码为准。不要填写真实密码或密钥。

## 历史证据

- 第 48 轮交付档实库复跑（修复前源码）：正常档 72 passed / 3 skipped，冲突档 75 passed / 0 skipped，退出码均 0。
  该计数对应旧源码，第 50 轮已在隔离实例按最终源码重跑，不能直接引用为当前结果。
- 第 50 轮最终源码实库：normal `72/6`、fault `75/3`、fault-UNKNOWN `76/2`、fault-ASSERT-AFTER `76/2`、
  conflict `76/2`（passed/skipped），退出码均 0；保留 `stored_file=1`、`local_backup_run=4`（5/9/13/17）。
- 42→43 冻结候选、旧计划路径与更早执行日志：[b3b8ae0](https://github.com/GandianTX/lithography-platform/commit/b3b8ae0)。仅用于追溯，不代表当前执行步骤。
