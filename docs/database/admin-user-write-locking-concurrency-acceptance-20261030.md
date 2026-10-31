<!-- 文件位置：docs/database/admin-user-write-locking-concurrency-acceptance-20261030.md -->

# 管理员写入链路锁后读取修复与并发验收（2026-10-30）

- 分支：`feat/maintenance-data-increment`，基线 HEAD `30c2732`；改动全部在工作区，**未暂存、未 commit、未 push**。
- 本轮只调整管理员写入链路的锁定读取顺序与并发测试；未修改 Entity、Migration、GraphQL 接口、组织权限规则或全局隔离级别。
- 本文是修复方实测记录，不代表独立复审或 CI 已通过。

## 1. 范围

`admin-user-write-support.ts` 的 `loadWritableAdminUserTarget()` 被启停、资料编辑、密码重置三个管理员写入口共用。三者的目标状态判定、权限裁决均依赖该 helper 的读取结果。

## 2. P0：受影响读取确认（只读核对）

修复前顺序为「解析管理员组织 → 锁定目标 → 读取 View → 成员关系 → 角色断言」：

- `TrustedOrganizationContextQueryService.resolveForAccount()` 在锁前执行，是该事务内的**第一条普通读取**，即在此建立一致性读快照；
- 其后的 `findAdminUserViewById()`、`findActiveMembership()`、`findAdminUserStatusFacts()` 虽在锁后执行，但复用同一旧快照，无法看到并发方在锁等待期间提交的状态；
- 启停 usecase 的幂等判断源自 `findAdminUserStatusFacts()`，因此「A 持锁停用 → B 排队启用」时 B 仍读到 `ACTIVE`，会误判为幂等而跳过更新。

结论：仅交换两行代码不够；必须让**组织解析与目标资料读取都发生在取得行锁之后**。本轮未采用修改隔离级别的方式。

## 3. P1：修复内容

文件：[backend/src/usecases/account/admin-user-write-support.ts](../../backend/src/usecases/account/admin-user-write-support.ts)

1. 事务内先执行 `AccountService.lockByIdForUpdate()`（`SELECT ... FOR UPDATE`），成功后再解析管理员组织；
2. 组织解析、`findAdminUserViewById()`、`findActiveMembership()`、`assertWritableAdminUserTargetRole()` 全部落在锁后；
3. 保留既有组织归属核验：跨组织与不存在目标仍统一收敛为 `TARGET_NOT_FOUND`，`ACCOUNT_NOT_FOUND` 的映射不变；
4. 启停 usecase 未改动：其幂等判断仍调用 `findAdminUserStatusFacts()`，该方法在 helper 返回后执行，随锁后读取获得最新状态；已是目标状态时不执行 `updateAccount` / `updateUserInfoFields`，`updatedAt` 不变。

锁序与业务不变式：仍为「目标账号行锁 → 成员关系读取 → 状态/资料写入」，未引入新锁，未改变事务边界。

## 4. P2：回归覆盖

单测（`admin-set-user-status.usecase.spec.ts` 新增「锁后读取最新状态（旧快照回归）」）：

- 以替身区分锁前/锁后读取：锁后读到 `INACTIVE` 时，重复停用走幂等、零写入、`updatedAt` 不 bump；
- 锁后读到 `INACTIVE` 时，请求启用必须真正写入，而非沿用旧快照幂等；
- 用 `invocationCallOrder` 断言锁定早于组织解析、View 读取与状态事实读取。

三份既有组织隔离单测同步校正断言：组织解析后移后，锁定已发生，但组织裁决失败时仍零读取目标资料、零写入。

真实双连接并发（新增 `admin-set-user-status.concurrency.integration.spec.ts`，默认跳过）：

| 场景                                 | 断言                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| A 持锁停用；B 请求启用并等待；A 提交 | B 返回 `ACTIVE`，与数据库实际状态一致                                |
| A 持锁停用；B 同样请求停用；A 提交   | B 幂等成功、不重复更新；两个返回的 `updatedAt` 均等于 A 提交后的库值 |
| 跨组织管理员操作目标                 | 返回 `TARGET_NOT_FOUND`，账号/资料/成员关系与操作前逐字段一致        |

- 竞争同步点使用 `performance_schema.data_lock_waits` 轮询等待者数量，不使用固定延时；
- 两支连接由竞争执行器创建，未完成事务在 `finally` 中回滚并释放，分支错误与收尾错误分别保留；
- 夹具创建前做固定 ID 与自然键查重；账号、用户资料、成员关系在同一事务连接内原子创建，资料写入注入同一事务上下文，不在事务内另开连接；
- 各步成功后先保存真实 ID 与显式创建事实，提交成功后才转入清理账本；任一步失败整体回滚，无直接 DELETE 补偿分支；
- 连接、事务启动、创建、提交、回滚、销毁与释放分阶段处理，按 `runner.isTransactionActive` 实际状态回滚；
- 回滚失败（真实异常与替身异常同一路径）一律调用驱动 `PoolConnection.destroy()` 销毁本轮独占连接，绝不以普通 `release()` 把活动事务归还连接池；共享池与其它测试连接不销毁；
- 创建、回滚、销毁、释放错误按阶段分别保留，销毁失败不覆盖原始错误；
- 提交明确成功后**先登记全部资源与事实，再释放连接**；释放失败使 helper 拒绝成功并报告，已登记资源交由受保护清理处理，不新增直接删除补偿；
- 提交结果不明确时保留已知 ID 与事实并报告，不删除也不宣称零残留；
- 故障注入用例的执行与断言包在 `try/catch/finally` 内：断言中途失败仍会恢复替身并销毁/释放本轮连接；主错误与收尾错误分别保留，互不覆盖；
- 结束后按登记账本精确清理，并断言 KEEP 四表计数与基线一致、夹具零残留。

夹具失败路径回归（同一并发规格内，故障注入只存在于测试代码，通过 `onRunnerReady` 对真实驱动方法打替身）：

| 用例                             | 验证方式                                    | 断言                                                                             |
| -------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| 账号插入成功、资料创建失败       | 注入创建异常                                | 整体回滚；三表无本轮记录；清理账本未新增；无补偿删除                             |
| 成员关系创建失败                 | 注入创建异常                                | 前序账号与资料一并回滚；三表无记录                                               |
| 创建成功                         | 真实创建                                    | 提交返回后、后续视图查询前，账号与成员关系的 ID 与显式事实已全部登记，且无重复   |
| `rollbackTransaction()` 真正抛错 | 替身 `rollbackTransaction` + `destroy` 探针 | 调用一次 `destroy()` 销毁本轮连接；helper 失败；三表无记录                       |
| 回滚和销毁均失败                 | 替身 `rollbackTransaction`、`destroy`       | 聚合错误保留创建、回滚、销毁三个错误；`finally` 内恢复替身后销毁连接，三表无记录 |
| commit 成功、release 抛错        | 替身 `release`                              | 资源与事实全部已登记；helper 失败并报告驱动释放错误；`finally` 内释放连接        |
| 中途断言失败仍收尾               | 替身 + 主线故意抛错                         | `finally` 内恢复替身并销毁/释放本轮连接；主错误与收尾错误分别保留；无连接泄漏    |

## 5. 验证结果

运行环境：Node v24.14.1；隔离库由 `backend/env/.env.e2e` 指向的测试库；命令均在 `backend/` 下执行。

| 检查                                 | 命令                                                                                                               | 结果              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------- |
| 正式类型检查                         | `npx tsc -p tsconfig.json --noEmit`                                                                                | 通过              |
| spec 类型检查                        | `npx tsc -p tsconfig.spec.json --noEmit`                                                                           | 通过              |
| ESLint（本轮改动文件）               | `npx eslint <files> --no-cache`                                                                                    | 通过              |
| Prettier                             | `npx prettier --check <files>`                                                                                     | 通过              |
| 空白检查                             | `git diff --check`（仅覆盖已跟踪文件；未跟踪的并发规格由 Prettier 覆盖）                                           | 通过              |
| 管理员写单测                         | `npx jest "admin-(set-user-status\|update-user-profile\|reset-user-password)\.usecase\.spec\.ts" --runInBand`      | 129 通过          |
| 管理视图查询单测                     | `npx jest src/modules/account/queries/admin-user.query.service.spec.ts --runInBand`                                | 62 通过           |
| 隔离库并发与失败路径回归（连续两次） | `ADMIN_USER_STATUS_CONCURRENCY_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 npx jest <concurrency spec> --runInBand` | 两次均 10/10 通过 |

两次回归均在 `afterAll` 内完成夹具清理、零残留与 KEEP 计数比对；任一不满足会使套件失败。10 个用例包含 3 个真实并发场景与 7 个夹具创建/收尾/中途失败路径；两轮结束后另以独立 SQL 复核夹具四表计数为 0。

证据类型区分：

- **实库验证**：10 个用例均连接隔离库真实执行；3 个并发场景与 4 个路径（资料失败、成员失败、创建成功、commit 后释放失败）使用真实事务与真实连接；
- **替身验证（仍实库）**：`rollbackTransaction` 抛错、`destroy` 抛错、`release` 抛错，以及“中途断言失败仍收尾”通过 `jest.spyOn` 对真实驱动方法注入一次性异常并在测试主线故意抛错；异常抛出、`finally` 恢复替身与后续销毁/释放均在真实 MySQL 连接上发生；
- **未覆盖**：连接池自身故障、数据库整体不可用、并发规格之外的业务流程。

证据归属：以上均为**修复方自测**（同一人执行命令与读取结果），不构成独立验证或复审。独立验证需由他人于隔离库重跑同一命令，并额外核对 KEEP 与零残留。

## 6. 未运行项

- 未运行全量后端单测与整套 E2E，仅运行与本链路直接相关的三个 usecase 单测、管理视图查询单测及上述并发规格；
- 未运行前端验收、GraphQL 端到端与 CI；
- 未做独立复审，未推送远端。
