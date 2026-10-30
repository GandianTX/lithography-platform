# 组织与维修数据增量验收记录（2026-10-29）

## 版本与范围

- 分支：`feat/maintenance-data-increment`；开发起点：`795eb577f45e5ece4694dec5efa322aba1ef9a3a`。
- 本记录整理自提交前各轮执行记录。实库结果产生于该起点之上的未提交工作区，不能表述为起点提交已经包含或验证了本次实现，也不代表 CI、薛一审或负责人二审通过。
- 交付为数据层增量及既有账号/工单兼容调整：7 条追加迁移、11 张新表，终态 31 条迁移、34 张业务表；`migrations` 等元数据表另计。
- [设计与实现说明](./organization-maintenance-data-increment-design.md)、[部署与升级 SOP](./部署与增量升级SOP-20261029.md)提供正式交接入口。临时阶段计划和旧基线盘点不属于本次提交。
- 本文只保留脱敏结果，不包含配置、备份、真实业务数据或原始测试日志。
- 时点说明（2026-10-30 更新）：第 10–189 行的表格与回执保留 2026-10-29 时点的 29/30 态历史结果，不代表当前终态；当前 31 条迁移、34 张业务表的最新证据见文末「2026-10-30 第四轮修复与终态补证」。旧文中的“自助注册不建立成员关系”等表述已按第 3 节统一修正。

## 已执行的迁移验证

| 验证               | 已记录结果                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 全新隔离库迁移链   | 29 条迁移、33 张业务表及结构契约核验通过                                                                          |
| PR0 旧库副本       | 真实 24 条历史副本上 `status` 为 5 pending，`run` 仅执行 5 条，`verify` 通过，第二次 `run` 执行 0 条              |
| 旧数据保留         | 21 张未变表逐字段序列化结果逐字节一致，受改造表旧列逐行摘要一致                                                   |
| 约束拒绝路径       | 重复 ACTIVE 成员、同账号第二有效组织、非法角色/离职时间组合及第二 RUNNING 备份被唯一键或 CHECK 拒绝，测试事务回滚 |
| 公共迁移器实库回归 | 31/31，通过半迁移拒绝、部分 DDL 失败现场及结构定义漂移反例                                                        |

上述迁移证据生成后的修正未改变 5 条迁移及结构契约，因此后续轮次沿用迁移结果，定向重验发生变化的运行逻辑。当前没有验证“有表但没有迁移历史”的开发库可以直接纳管升级；该情况不属于上述 24→29 证据。

## 业务、并发与权限

| 套件                                                 | 已记录结果                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `maintenance-report.integration.spec.ts`             | 5/5：冻结、冻结后拒绝编辑、退回重提版本、锁后读取、结果映射与终结守卫             |
| `repair-request.organization.integration.spec.ts`    | 9/9：本组织、无组织、跨组织及客户本人读取口径                                     |
| `maintenance-report.concurrency.integration.spec.ts` | 4/4：同工单建稿竞争、提交与编辑竞争、提交与加附件竞争、跨组织写入拒绝且无部分写入 |
| `local-runtime.concurrency.integration.spec.ts`      | 3/3：同幂等键入队、同目标版本不同幂等键入队、设置不同字段并发补丁                 |

并发套件使用独立 MySQL 连接和真实事务，通过 `performance_schema.data_lock_waits` 观察阻塞后继续竞争，不靠固定延迟或 Mock 调用顺序证明并发。测试过程中发现上传冲突回读未真正加锁，修正为 TypeORM 显式 `lock: { mode: 'pessimistic_write' }` 后重跑通过。

无归属存量工单只保留客户本人及原接单工程师的受限访问；未分配可信组织前不可进入公共待接单池或重新接单。报告与工单的组织一致性由用例锁后校验承担，不能把工单唯一键描述为跨组织复合外键；完整取舍见设计说明 §14。

## KEEP 与残留

- 在同一实例登记合成 KEEP：19 行，覆盖组织、账号、成员、机型、工单、报告内容与版本/附件/审核、上传任务及备份记录；另有 2 个文件哨兵。
- KEEP 就位时对 16 张相关表共 56 行及 2 个文件取确定性排序快照，比较逐字段摘要和文件路径/大小/内容摘要。
- 在两套并发与相关实库写入/清理链路执行前后，表摘要和文件清单完全一致，记录结果为 `KEEP_COMPARE_OK`。
- 测试夹具按登记 ID 清理并回读零残留；单独收尾 KEEP 后，差异恰为登记的 19 行及 2 个文件，记录结果为 `KEEP_RESIDUE_OK`。没有用 Seed 或整表清理覆盖差异。
- KEEP 使用的一次性探针与状态目录已删除。以上为当时运行回执，仓库未提供一键重放该 KEEP 探针的命令；不能把本文当作保留了原始快照或已提供自动 KEEP 执行器。
- 后续补跑的组织集成套件以自身残留断言核验，不冒称其执行时间也包含在此前 KEEP 快照区间内。

## 清理保护修复与重新验收（2026-10-29，替代上文清理证据）

上一轮的清理证据基于按固定 ID 预清除、按组织/前缀批量删除与逐条容错删除，不满足“错误目标零删除、归属不符零删除、中途失败整批回滚”。本轮完成以下修复并重新取得证据，**上文的清理与残留回执已被本节结果替代**：

- 共享工具 `backend/test/utils/e2e-owned-fixture.ts`（复用既有 `e2e-db-guard` 门禁，未改动 PR0 的 `e2e-scoped-cleanup`）：
  - 每个删除入口自行校验 `E2E_ALLOW_PHYSICAL_CLEANUP=1`、库名白名单与预期库，并在同一清理连接/事务内执行 `SELECT DATABASE()`，再与预期库逐项比对；不以调用方已检查为由省略入口校验。
  - `prepareFixtureSetup` 全部检查通过后才标记允许创建夹具；`afterAll` 同时检查该状态，前置检查失败且未创建资源时不发出任何 DELETE。
  - 登记账本按创建后回读的实际 ID、完整预期字段与本轮标识登记；固定 ID 创建前先查重，碰撞立即失败并保留原数据；移除启动前按固定 ID 清除旧数据。
  - 清理在单连接单事务中先 `FOR UPDATE` 锁定并逐字段 NULL 安全比较，再核验引用闭包（只放行本轮登记的自有行，额外关联整批零删除），最后按子表→父表精确删除；任一失败立即回滚整批，不继续逐条删除。
  - 主流程/清理/回滚/连接关闭错误分别收集；登记过的资源才允许清理，创建失败且未登记者不推测为本轮所有。
- 四份实库测试已移除按组织删成员、按前缀/固定 ID 批量删任务与启动前预清除，改为登记后精确删除：
  - `maintenance-report.integration.spec.ts` 5/5
  - `repair-request.organization.integration.spec.ts` 9/9
  - `maintenance-report.concurrency.integration.spec.ts` 4/4
  - `local-runtime.concurrency.integration.spec.ts` 3/3
- 新增失败路径回归 `backend/test/utils/e2e-owned-fixture.e2e-spec.ts`，13/13 通过：
  - SQL 替身（8 项）：缺少许可、非白名单库、声明库≠实际库均零 DELETE；`DATABASE()` 校验早于任何 DELETE；setup 中途失败仅删除已登记行；固定 ID 碰撞拒绝；字段变化与 NULL 双向不匹配整批零删除；额外外部引用整批零删除。
  - 真实 MySQL（5 项）：正常清理与重复清理零残留且保活行逐字段不变；字段被改写时整批零删除并在恢复预期后清理；真实外部引用拒绝后解除引用可清理；第二条删除注入失败时此前删除全部回滚；真实固定 ID 碰撞保留原数据。
- 重新验收：在隔离库 `lithography_e2e` 顺序复跑四份套件，退出码均为 0；运行前后的全库逐字段摘要（33 张业务表、92 行、确定性排序）完全一致，24 个固定/生成夹具 ID 回读残留均为 0。未执行 Seed 或整表清理。
- 本轮不改迁移与结构契约，上文“29 条迁移 / 24→29 增量 / 二次 0 条”结果确认仍适用，未重跑。
- 修复过程中自测发现替身测试恢复环境变量时把未定义值写成字符串，导致后续白名单变成 `undefined`；已改为未定义时删除变量，并只清理上一轮自身登记的精确 ID 残留，未触碰其他数据。

## 登记—核验—删除约束补齐与再次重新验收（2026-10-29，替代上一节清理证据）

上一节仍保留调用方自选删除步骤、清理前整行重新读取（`refresh`）重新认领、并发分支断言后登记等缺口。本轮仅修改共享夹具工具与四份实库测试及其回归套件，**上一节的四份计数、KEEP 摘要与残留结论已被本节结果替代**；既有库名守卫、状态门与事务回滚保持不变。

- P1 账本成为唯一删除依据：删除目标只能由已登记、已核验的表名与主键生成；受控表定义与主键结构集中在 `FIXTURE_TABLE_PRIMARY_KEYS` 与 `FIXTURE_TABLE_DELETE_ORDER`，调用方不再能传入 `deleteSteps`。空账本零 DELETE；删除语句逐行执行且 `affectedRows` 必须为 1、总数必须与核验目标一致；复合主键 `maintenance_report_version_attachment` 逐行登记与删除；引用闭包中出现账本外记录整批拒绝。
- P2 移除全量 `refresh`：删除该入口及全部调用点。账号、组织、机型等未被业务修改的记录保持创建时的完整预期；合法业务变化只通过 `applyExpectedChange` 显式更新受影响字段，主键与所有权列（创建人、组织归属、客户/安装归属等）禁止改写，`updated_at` 作为数据库维护列不参与严格比较，数据库生成时间可在核验身份后受限读取登记。
- P3 登记早于断言：并发分支在确认创建成功后立即登记实际资源再返回，统一用 `Promise.allSettled` 汇合后再断言；报告建稿产生的根记录、报警、步骤、版本与审核均在业务断言前登记；新增“并发一方成功、一方失败”真实用例，成功资源仍由受保护清理收尾。
- P4 统一收尾：`runTeardownSteps` / `describeTeardownFailure` / `finalizeFixtureTeardown` 分别执行清理、残留查询与各资源关闭，关闭步骤全部尝试（前一步失败不阻断后续），最终同时报告主流程错误与全部清理错误。
- 回归与重新验收：
  - `backend/test/utils/e2e-owned-fixture.e2e-spec.ts` 19/19 通过：SQL 替身 12 项覆盖缺许可、非白名单、声明≠实际、`DATABASE()` 早于 DELETE、空账本零 DELETE、账本外目标不可登记且未登记同行不删、未登记复合主键闭包拒绝、固定 ID 碰撞、字段/NULL 不匹配、额外外部引用、合法变更与所有权拒绝、收尾错误全部保留；真实 MySQL 7 项覆盖并发部分成功+后续断言失败、正常清理与空账本+保活行不变、外部改写拒绝后恢复可清理、合法字段变更、外部引用零删除后解除引用可清理、第二条删除失败整批回滚、真实固定 ID 碰撞。
  - 隔离库 `lithography_e2e` 顺序复跑四份实库套件：`maintenance-report.integration` 5/5、`repair-request.organization.integration` 9/9、`maintenance-report.concurrency` 4/4、`local-runtime.concurrency` 4/4（新增“并发一方失败”用例），均在受保护清理下退出码 0。
  - KEEP：运行前后对 34 张表、121 行做确定性排序逐字段摘要，整体 sha256 完全一致（`65ec9f61…a386a`）；全库 `>= 9900000` 夹具区间回读为 0。未执行 Seed 或整表清理。
  - 首跑失败遗留的精确夹具行（账号 `9904991`、机型 `9904993/9905002/9905003/9905014`、申请 `9905004`）已用一次性受保护脚本逐字段核验后删除，未触碰其他数据。
- 本轮不改迁移与结构契约，上文“29 条迁移 / 24→29 增量 / 二次 0 条”结果确认仍适用，未重跑。

## 报告子树登记与并发分支生命周期修复轮（2026-10-29，替代上一节相关登记结论）

上一轮的报告清理仍存在两处缺口：报告套件按 `report_id` 扫描把账本外子记录当成“本轮资源”；上传并发 helper 的 A/B 连接与分支生命周期分散在多个 `try` 块，B 初始化失败时无法保证 A 被取消并回滚，异常路径上还会无条件允许提交。本轮只改两套报告测试的子树登记、上传并发 helper 与其回归，不动业务代码、Entity、Migration、既有清理入口与库名/许可门禁；本节实测结果替代上一节关于报告套件计数、并发套件计数与 KEEP 的结论。

- P1 报告子树登记：`maintenance-report.integration.spec.ts` 与 `maintenance-report.concurrency.integration.spec.ts` 删除按 `report_id` 全量扫描的登记函数；附件只登记本轮上传结果（回读实际 ID、上传人、存储引用并在账本中校验），版本与审核只登记具体提交/退回操作返回的 ID（校验版本号、操作人、版本关联），版本附件按 `(version_id, attachment_id)` 复合主键逐行登记；`report_id` 查询只用于引用闭包核验，发现账本外记录则拒绝整批清理并保留现场，不再“登记后再继续删除”。预期字段全部来自创建输入与显式业务状态变化（含 MySQL 布尔列按 0/1 比较），不从查询结果反写所有权预期。
- P2 并发分支生命周期：新增共享 helper `backend/test/utils/upload-race-runner.ts`，A/B 的创建、连接、开事务、执行、等待与释放全部在同一 `try/finally` 内；B 初始化失败时向 A 发出取消信号、释放等待并等待 A 回滚与释放；只有正常竞争完成才放行提交，异常路径不再无条件 `allowCommit()`；按实际初始化状态逐个连接清理，分支错误、回滚错误与释放错误分别收集，全部分支结束才退出 helper。`local-runtime.concurrency.integration.spec.ts` 改用该 helper，保留原有真实锁竞争同步点。
- P3 回归：报告并发套件新增“引用闭包”用例（外部上传人附件、外部版本、外部审核、外部版本附件的账本外记录不被认领，清理以“账本外记录”拒绝且零删除，随后清理外部账本与本轮账本各自成功、回读均为 0；正常本轮子树仍可清理）；新增单测 `backend/src/usecases/local-runtime/upload-race-runner.spec.ts` 4 例，分别注入 B 连接失败、B 开事务失败、收尾失败保留原始分支错误、正常竞争提交顺序。
- 实测（修复方自测，非独立复审）：
  - `upload-race-runner.spec.ts` 4/4；`maintenance-report.integration` 5/5；`maintenance-report.concurrency` 5/5（含新增引用闭包）；`local-runtime.concurrency` 4/4；均退出码 0，且报告并发套件的 `afterAll` 未出现残留断言失败。
  - 隔离库 `lithography_e2e`：本轮开工前与全部套件复跑后，34 张表确定性逐字段摘要均为 `95f3490c8dc6346d513f569562b44c2f267d5bd2dea488afa8e905b41d1a52a1`，`>= 9900000` 区间残留为 0；未执行 Seed 或整表清理。
  - 首跑新增引用闭包用例曾因布尔列回读为 0/1 而整批零删除失败，遗留 39 行本轮夹具（组织 2、账号 5、成员 5、机型 1、工单申请 5、报告 5、报警 5、步骤 5、附件 2、版本 3、版本附件 1）；核对全部为 `S5C_*` 本轮夹具后，用一次性受保护脚本在单事务内按子表→父表精确删除，随后摘要恢复为上述基线，未触碰其他数据。
- 本轮不改迁移与结构契约，上文“29 条迁移 / 24→29 增量 / 二次 0 条”确认仍适用，未重跑。
- 独立复审：本轮尚未进行；以上均为修复方实测，复审需在通过后单独执行。

## 版本附件登记与事务收尾补强（2026-10-29，替代上一节两项结论）

上一节仍有两处缺口：普通报告集成测试仍按 `version_id` 查询全部关联后登记版本附件；并发执行器仍以 `startTransaction()` 成功返回作为回滚前提，驱动“已标记活动后才抛错”时不会回滚。本轮只改这两处及其回归，不动业务代码、Entity、Migration 与既有清理入口。

- P1 版本附件登记：`maintenance-report.integration.spec.ts` 的 `registerSubmittedVersion` 改为接收提交时已知的附件集合，按 `(version_id, attachment_id)` 构造复合主键并逐条登记，`sort_order`、`description_snapshot` 来自上传输入，`publish_flag` 取提交前恒为 0 的业务常量；无附件版本登记零条关联。全量关联查询只由既有引用闭包守卫（`maintenance_report_version_attachment.version_id`）在清理前执行，仅用于发现账本外记录；出现未知关联即整批拒绝、零删除并保留现场，不把查询结果登记为本轮资源。
- P2 事务收尾：`upload-race-runner.ts` 的 `settleRunner` 不再依赖 `transactionStarted` 标记，只要 `isTransactionActive` 为真就尝试回滚；回滚失败仍继续释放连接，初始化、分支、回滚与释放错误分别汇总，取消等待与等待全部分支结束的机制保持不变。
- P3 回归：集成套件新增“版本附件登记”用例，覆盖无附件零关联、已知附件按复合主键与业务列登记、同版本账本外附件与版本关联不被认领且整批清理拒绝零删除，之后用独立账本精确清理外部记录；单测新增“B 启动事务已标记活动后抛错”与“抛错后回滚失败仍释放且不覆盖原始初始化错误”两例。
- 实测（修复方自测，非独立复审）：
  - `upload-race-runner.spec.ts` 6/6；`maintenance-report.integration` 6/6；`maintenance-report.concurrency` 5/5；`local-runtime.concurrency` 4/4；均退出码 0，报告并发套件 `afterAll` 无残留断言失败。
  - 隔离库 `lithography_e2e`：运行前后 34 张表确定性摘要均为 `95f3490c8dc6346d513f569562b44c2f267d5bd2dea488afa8e905b41d1a52a1`，`>= 9900000` 区间残留为 0；未执行 Seed 或整表清理，也未使用一次性清除脚本。
  - `tsc -p tsconfig.build.json`、`tsc -p tsconfig.tools.json` 与含 spec 的 `tsconfig.spec.json` 通过；无 `--fix`、无 `--cache` 的 ESLint 在 3 个改动文件上 0 error；`prettier --check` 通过；`git diff --check` 无空白问题。
- 独立复审：本轮尚未进行；以上均为修复方实测，复审需在通过后单独执行。

## 账本外模拟记录独立账本与失败路径验证（2026-10-29，替代上一节账本外记录收尾结论）

上一节的账本外模拟记录在主流程末尾才创建，清理也放在用例尾部顺序执行：第二条 INSERT 或业务断言失败时，已创建的外部附件既未登记也没有 finally 收尾，会阻断主账本清理。本轮只改该回归用例及其失败路径验证，不改注册、业务代码、Entity、Migration 与既有清理入口。

- 独立账本：版本附件回归用例开始时即创建 tag 为 `ROUND_TAG-EXT` 的独立 `OwnedFixtureLedger`，与主账本分开维护；插入与断言全部在 try 内执行。
- 写入即登记：外部附件 INSERT 成功后立即按固定主键登记预期字段（`byte_size` 为 bigint unsigned，按驱动回读的字符串形态登记）；版本附件 INSERT 成功后立即登记 `(version_id, attachment_id)` 复合主键及 `report_id/sort_order/description_snapshot/publish_flag`；本轮已知附件也在业务断言之前登记到主账本。
- finally 收尾：无论插入、登记还是断言失败，finally 都通过 `runTeardownSteps` 对独立账本执行受保护清理；删除顺序沿用 `FIXTURE_TABLE_DELETE_ORDER`（版本附件先于附件）。主流程错误与清理错误经 `describeTeardownFailure` 汇总，互不覆盖。
- 失败路径验证：新增四例覆盖正常完成、第二条 INSERT 失败（CHECK 约束）、业务断言失败（注入异常）、独立清理失败（由临时独立账本经受保护入口移除登记行），分别断言已成功创建资源均已登记、仅本轮资源被清理、原始错误完整可见。
- 实测（修复方自测，非独立复审）：
  - `maintenance-report.integration` 10/10 通过（含 4 例失败路径），退出码 0，`afterAll` 无残留断言失败。
  - 隔离库 `lithography_e2e`：运行前后 34 张表确定性摘要均为 `95f3490c8dc6346d513f569562b44c2f267d5bd2dea488afa8e905b41d1a52a1`，`>= 9900000` 区间残留为 0；未执行 Seed 或整表清理。
  - 首跑曾把 bigint unsigned 的 `byte_size` 按数值预期登记，导致独立账本清理核验失败并遗留 30 行本轮夹具；核对全部为本轮 `S5C_*` 夹具后，用一次性受保护脚本在单事务内按子表→父表精确删除，摘要恢复基线后改为字符串形态登记并复跑通过。
  - 含 spec 的 `tsc -p tsconfig.spec.json`、无 `--fix`/`--cache` 的 ESLint（1 个改动文件 0 error）、`prettier --check`、`git diff --check` 通过。
- 独立复审：本轮尚未进行；以上均为修复方实测，复审需在通过后单独执行。

## 独立清理失败负例的受保护入口收口（2026-10-29）

上一轮“独立清理失败”负例用直连 `DELETE FROM maintenance_report_attachment` 移除登记行，绕过了受保护清理入口的显式许可、同连接库名检查与所有权核验，不符合夹具反例清单对测试夹具的要求。本轮只改该负例：先由临时独立账本 `registerById` 回读登记，再调用 `runOwnedFixtureCleanup` 删除该行；原账本随后在 finally 中因“登记资源已不存在”清理失败，负例目的保持不变。

- 实测（修复方自测，非独立复审）：该用例单独 1/1；`maintenance-report.integration` 全套 10/10；隔离库运行前后 34 张表确定性摘要均为 `95f3490c8dc6346d513f569562b44c2f267d5bd2dea488afa8e905b41d1a52a1`，`>= 9900000` 残留为 0；含 spec 的 `tsc`、无 `--fix`/`--cache` 的 ESLint（1 个改动文件 0 error）、`prettier --check`、`git diff --check` 通过。
- 独立复审：本轮尚未进行；以上为修复方实测，复审需在通过后单独执行。

## 静态门禁与单测

已记录通过：`typecheck`、`build`、无自动修复的 ESLint（0 error，10 warning）、`prettier --check`、normalize guard、architecture fixtures、`check:entity-scope`、`capability:docs:check`。

修正轮全量后端单测记录为 114 个套件通过、3 个套件跳过，1394 passed、45 skipped、0 failed。随后仅修改上传锁选项及对应测试，并定向运行本地运行与报告目录及上述真实并发套件；该全量数字不是后续新增用例后的重新统计。默认关闭的实库套件在普通单测中跳过，不等于真实链路已执行。

清理保护修复轮（2026-10-29）定向记录：受影响模块单测 13 个套件通过、4 个跳过（143 passed、21 skipped、0 failed）；`tsc -p tsconfig.build.json`、`tsc -p tsconfig.tools.json` 与含 spec 的 `tsconfig.spec.json` 类型检查均通过；无 `--fix` 的 ESLint 在 6 个改动文件上 0 error；`prettier --check` 全部通过。本轮未新增业务代码、Entity 或 Migration。

登记—核验—删除约束补齐轮（2026-10-29）记录：受影响模块定向单测 13 个套件通过、4 个跳过（143 passed、22 skipped、0 failed）；全量后端单测 114 个套件通过、5 个跳过（1395 passed、53 skipped、0 failed）；三套 `tsc` 类型检查通过；无 `--fix`、无 `--cache` 的全量 ESLint 为 0 error、10 warning（均为既有文件的历史告警）；`prettier --check` 通过；`lint:usecase-normalize-guard` 与 `lint:architecture-fixtures` 通过（过程中曾因移除调用方手工收敛过滤而命中 guard，已按规范删除该过滤后重跑通过）。本轮未新增业务代码、Entity 或 Migration。

报告子树登记与并发分支生命周期修复轮（2026-10-29）记录：定向单测 `upload-race-runner.spec.ts` 4/4；`tsc -p tsconfig.build.json`、`tsc -p tsconfig.tools.json` 与含 spec 的 `tsconfig.spec.json` 类型检查通过；无 `--fix`、无 `--cache` 的 ESLint 在 8 个改动/新增 TS 文件上 0 error；`prettier --check` 在 9 个改动/新增文件上全部通过。本轮未新增业务代码、Entity 或 Migration。

版本附件登记与事务收尾补强轮（2026-10-29）记录：定向单测 `upload-race-runner.spec.ts` 6/6；三套 `tsc` 类型检查通过；无 `--fix`、无 `--cache` 的 ESLint 在 3 个改动文件上 0 error；`prettier --check` 通过。本轮未新增业务代码、Entity 或 Migration。

账本外模拟记录独立账本与失败路径验证轮（2026-10-29）记录：定向单测 `upload-race-runner.spec.ts` 6/6；`tsc -p tsconfig.spec.json` 与既有构建类型检查通过；无 `--fix`、无 `--cache` 的 ESLint 在 1 个改动文件上 0 error；`prettier --check` 通过；`git diff --check` 无空白问题。本轮未新增业务代码、Entity 或 Migration。

## 可复现入口

命令均在 `backend` 中执行。数据库配置、隔离目标、测试账号及清理许可必须先按 SOP 核实；这些命令不授权访问共享开发库。

```bash
npm run typecheck
npm run test:unit -- --runInBand
npm run lint:usecase-normalize-guard
npm run lint:architecture-fixtures
npm run check:entity-scope
npm run capability:docs:check
npm run build
```

常规实库套件及破坏性迁移回归命令见 SOP。以下为新增并发套件，读取本地未跟踪的 `env/.env.e2e`，仅允许 `lithography_e2e`；账号须具备所需锁等待观测权限。缺少配置或保护前提时应失败，不得绕过门禁：

```bash
MAINTENANCE_REPORT_CONCURRENCY_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
  npx jest src/usecases/maintenance-report/maintenance-report.concurrency.integration.spec.ts --runInBand

LOCAL_RUNTIME_CONCURRENCY_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
  npx jest src/usecases/local-runtime/local-runtime.concurrency.integration.spec.ts --runInBand
```

清理保护失败路径回归（SQL 替身 + 隔离 MySQL 回滚/引用保护）：

```bash
E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_SKIP_DB_CLEANUP=true \
E2E_SPECS=test/utils/e2e-owned-fixture.e2e-spec.ts \
  npx jest --config test/jest-e2e.js --runInBand
```

另两份实库套件分别使用 `MAINTENANCE_REPORT_INTEGRATION=1`、
`REPAIR_REQUEST_ORG_INTEGRATION=1` 并按上方同样的许可与隔离库前提运行。四份套件可按顺序串行复跑；其清理只删除本轮登记 ID，运行前无需预清除。

## 已知交付边界

- AI 只有最小读取契约和测试注入模拟，生产未接入时明确不可用；真实输出、版本与历史回看尚未联调。
- 附件只有记录、格式/限额校验、冻结清单及审核选择，没有真实上传或服务端存储元数据回读。
- 本地运行只有身份、任务、回执与备份记录状态机，没有真实云接收端、调度器、备份文件生成或恢复编排；数据记录通过不等于真实备份恢复通过。
- 客户自助注册会在注册事务内按所选有效组织建立 `CUSTOMER` 成员关系；工程师自助注册只创建待审账号与申请，审核通过后才建立 `ENGINEER` 成员关系；历史未分配账号不自动猜测组织，组织分配公开入口仍未交付。
- 没有新增业务页面、报告 GraphQL/REST 接口或 PDF 导出，本次没有前端视觉验收证据。

PR 审核重点为组织隔离与旧数据兼容、单有效成员生成列、报告/版本/审核关联、锁序与冲突回读、清理保护及单列外键的实际保证范围。本文不代替审核者独立复核。

## 2026-10-30 第四轮修复与终态补证

### 1. 基线

- 分支：`feat/maintenance-data-increment`；未新开分支。
- 工作区 HEAD、远端分支 head 与审核基线均为 `24f75655eef913b30467ccc05ed9bebbaf846f03`（`feat(registration): add organization-scoped engineer approval`）；本轮改动全部位于未提交工作区，未 commit、未 push、未合并 PR。
- 迁移文件实际计数 **31**（`backend/src/infrastructure/database/migrations/*.ts`）；本轮新增第 31 条，未改写前 30 条。
- 数据库授权、实际库名、所有权与事务守卫沿用既有实现，未修改。

### 2. RQ 对照表

| RQ        | 意见                                                             | 代码位置                                                                                                                         | 测试/证据                                                                                               | 状态                   |
| --------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------- |
| RQ1（P1） | 旧清理器引用闭包只补 `maintenance_report → equipment_model` 不足 | `backend/test/utils/e2e-scoped-cleanup.ts`：`assertReferenceClosure` 的账号段、组织段、工单段、机型段                            | `e2e-scoped-cleanup.e2e-spec.ts` R31-C01～C07；真实隔离库套件 42/42                                     | 完成                   |
| RQ2（P2） | 处理结果/状态 CHECK 在单边 NULL 时退化为 UNKNOWN                 | 新增 `1775401600000-add-null-safe-handling-constraints.migration.ts`；`repair-request.entity.ts`；`migration-schema-contract.ts` | M31 真实 MySQL 回归；C6/R2 前缀预检；实库 `verify`                                                      | 完成                   |
| RQ3（P3） | SOP 承诺空库初始化与正式入口实际拒绝不一致；组织表述混杂         | `docs/database/部署与增量升级SOP-20261029.md`；`organization-maintenance-data-increment-design.md`；`README.md`；注册验收记录    | SOP 第 3/4 节重写；30 态库命令实跑退出码 0                                                              | 完成                   |
| RQ4（P3） | 组织设计：客户注册即建成员、工程师审批后建成员、历史不猜测       | 同上设计说明第 12 条、迁移表 M1～M7                                                                                              | 注册审批真实 E2E 21/21                                                                                  | 完成                   |
| P4        | 24→31 组合升级                                                   | 正式入口 `migration:status/run/verify`                                                                                           | 30→31 已用可证明副本通过；24→31 已由 accepted 代码正向重建的 24 态 + 合成旧数据通过（非真实历史库副本） | 完成（待确认来源口径） |
| P5        | 最终验证与交接                                                   | 本记录与各套件日志                                                                                                               | 见下表                                                                                                  | 完成（不含 CI）        |

### 3. P1 清理器引用闭包

- 账号侧新增：`maintenance_report` 的工程师/创建人/更新人字段，`maintenance_report_attachment` 上传人，`maintenance_report_version` 提交人，`maintenance_report_review` 审核人；`repair_request` 新增 `handling_recorded_by_account_id` 引用。
- 组织侧新增：`maintenance_report.owner_organization_id`、`local_installation.organization_id`、`repair_request.owner_organization_id`（只有登记集合内工单可随组织删除）。
- 工单侧新增：`maintenance_report.repair_request_id`（本轮无报告删除能力，直接拒绝）。
- 机型侧新增：`maintenance_report.equipment_model_id`。
- 所有查询都在 `assertReferenceClosure` 内、首次 DELETE 之前、同一连接同一事务中执行；账本外引用立即抛错，不自动登记、不扩图、不删除。
- 负例均使用独立 `createOwnedResourceLedger()`；本组负例只构造替身数据，不创建真实资源，因此无需 `finally` 收尾；真实隔离库套件的正常/失败路径仍由既有 `runE2eTeardown` 覆盖。

### 4. P2 NULL 安全约束

- 第 31 条仅替换两个同名 CHECK 表达式，不新增表、不改列；单条 `ALTER TABLE` 完成 DROP+ADD，MySQL 8 原子 DDL；DDL 隐式提交导致事务无法回滚结构变更的边界已写入迁移注释。
- 新表达式显式覆盖：双 NULL 且时间全空；五类固定映射且 `handling_recorded_at` 必填；`IN_PROGRESS` 不得有结束时间；`COMPLETED/UNRESOLVED` 必须有结束时间。其余组合均得到 FALSE，不再依赖 NULL 退化为 UNKNOWN。
- 迁移前扫描存量非法组合，失败时报总行数与样例 ID；不删除、不猜测修复。
- 结构契约按约束名登记在 26 号迁移（`1775401100000`），因此 24 态不要求该约束，29/30/31 态按同名预检，不会被新语义提前阻断；C6 已验证 14/20/24 前缀通过。
- 真实 MySQL：M31 在 30 态前缀上先插入两种单边 NULL，证明旧表达式接受非法行；随后迁移预检明确失败、历史仍 30 条；清理非法行后应用 31 号迁移，合法五类映射与双 NULL 接受，单边 NULL、错误映射、三种时间矛盾及双 NULL 带时间全部被数据库拒绝。仅检查约束名不算通过，已用写入行为验证敏感性。

### 5. P3 文档修正

- SOP 改为“既有库增量升级”为正式支持范围；删除“空库直接 `run` 初始化成功”的错误步骤；破坏性 `migration:drill:empty-db` 单列为“可丢弃测试库演练”，明确不是正式初始化。
- 明确正式空库初始化目前**未提供受验证入口**；若交付该能力须另立实现范围，不得放宽历史守卫。
- 组织表述统一为：客户注册即建立所选组织 `CUSTOMER` 成员关系；工程师注册只建待审账号与申请，审核通过后才建 `ENGINEER` 成员关系；历史未分配账号不自动猜测组织。
- 迁移数量、升级路径与待对接说明同步为 31 条 / 34 张业务表。

### 6. P4 30→31 与 24→31

**30→31（真实数据库，已通过）**

- 来源：`lithography_upgrade_drill_copy_20261030` 是 2026-10-29 已验收的 30 态副本；升级前用 `mysqldump` 生成只读基线 `/tmp/lithography_upgrade_copy_20261030_before_m31.sql`。
- 基线核验：dump 中 `migrations` 元组 **30** 条，不含 `AddNullSafeHandlingConstraints1775401600000`；大小为 103,421 字节。
- 执行与退出码：`migration:status` → 0（历史 30、仓库 31、pending 1）；`migration:run --confirm-database` → 0（仅执行第 31 条）；`migration:verify` → 0（业务表 34 张）；再次 `run` → 0（pending 0、执行 0 条）。
- 终态回读：`migrations` **31** 条；基础表 **35** 张（含 `migrations`，业务表 **34** 张）；`base_user_account=1`、`equipment_model=1`、`organization=1`、`repair_request=0`，与升级前一致；31 号迁移无 DML。
- 约束回读（`information_schema.check_constraints`）：`chk_repair_request_handling_mapping` 与 `_time` 均为新表达式，双 NULL 分支与成对非空分支同时存在。

**24→31（本轮停止，已由第五轮补证）**

- 检索现有 `lithography_e2e`、`lithography_drill`、`lithography_upgrade_drill_copy_20261030` 及本地备份，均为 30 态；没有可证明来源的 accepted 24 态旧库副本或 dump。
- 按任务约束，不用“删表/删迁移记录倒造”或回退构造替代；第四轮停止 24→31 实库补证，并在 SOP/README 中如实标注未演练。
- 第五轮已改用 accepted 提交正向重建的 24 态与合成旧数据完成 24→31，见文末“第五轮”小节；该证据不是真实历史业务库副本。
- 历史 24→29 证据仍保留在 2026-10-29 段落，仅作历史沿用，不能当作 24→31 结果。

### 7. P5 验证结果

| 检查               | 命令/范围                                                                    | 结果                                                                                                                                                                           | 退出码 |
| ------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 类型检查           | `npm run typecheck`                                                          | 通过                                                                                                                                                                           | 0      |
| 后端单测           | `npm run test:unit -- --runInBand`                                           | 124 suites / 1486 passed；6 suites、70 tests skipped；0 failed                                                                                                                 | 0      |
| 变更文件 ESLint    | 6 个变更 TS 文件                                                             | 0 error                                                                                                                                                                        | 0      |
| Prettier           | 同上 6 个文件 `--check`                                                      | 全部符合                                                                                                                                                                       | 0      |
| 架构门禁           | `npm run lint:architecture-fixtures`、`npm run lint:usecase-normalize-guard` | 均 passed                                                                                                                                                                      | 0      |
| 构建               | `npm run build`                                                              | 通过（含 capability docs check）                                                                                                                                               | 0      |
| 清理安全真实库     | `e2e-scoped-cleanup.e2e-spec.ts`                                             | 42/42（含真实隔离库 4 项）                                                                                                                                                     | 0      |
| NULL 约束真实库    | `incremental-migration.integration.spec.ts -t M31`                           | 1 passed / 31 skipped                                                                                                                                                          | 0      |
| 前缀结构契约       | 同文件 `-t "C6\|R2"`                                                         | 3 passed                                                                                                                                                                       | 0      |
| 维修/组织/并发集成 | 3 个 integration spec                                                        | 23/23                                                                                                                                                                          | 0      |
| 注册审批 E2E       | `engineer-registration-approval.e2e-spec.ts`                                 | 21/21                                                                                                                                                                          | 0      |
| 迁移入口实跑       | 30 态副本 `status/run/verify/run`                                            | 见 P4                                                                                                                                                                          | 0      |
| 实体范围门禁       | `npm run check:entity-scope`                                                 | 失败：分支相对 `origin/main` 本身就包含本功能新增 Entity；该门禁按脚本注释服务于 PR3 范围，本分支不适用。第五轮只读核实，未豁免、未改基线、未关闭检查，依据见文末第五轮第 5 节 | 1      |

证据分类：

- **真实数据库**：P1 真实隔离库 4 项、M31 真实 MySQL、C6/R2 前缀、维修/组织/并发集成 23 项、注册审批 21 项、30→31 副本升级、第五轮 24→31（accepted 代码正向重建的 24 态库）。
- **合成旧数据**：第五轮 24 态的旧业务数据由本轮按旧结构合成写入，**不是真实历史业务库副本**；只能证明迁移链与结构兼容，不能证明真实历史数据兼容。
- **替身/单测**：R31-C01～C07（假 DataSource，含独立账本）、清理套件其余 SQL 替身、全量单测。
- **历史沿用**：2026-10-29 的 24→29、29→30 实库结果及 21 表逐字段比对；24→29 未在第五轮重跑。
- **未覆盖**：真实历史 24 态业务库、前端页面、真实 AI 调用、PDF 导出、真实备份执行/恢复编排、CI（未推送）。

夹具与数据：清理套件自身断言正常夹具零残留、异常路径整批回滚；30→31 副本升级前后基础数据行数一致。获准提交后将补充完整候选 SHA、pass/failed/skipped 与 CI 同 SHA 结果；当前未执行 commit/push。

## 2026-10-30 第五轮：补证与复核收口

本轮只补证与复核：未改代码、未改前 30 条迁移、未调整门禁；代码工作区与第四轮一致，本轮新增改动仅为本记录与 SOP/README 的证据文字。

### 1. 基线与未提交范围

- HEAD、远端分支 head 均为 `24f75655eef913b30467ccc05ed9bebbaf846f03`；现有 PR #2，目标为 fork `main`，等待追加修复提交，因此本轮不存在新的 PR head 可核对。
- 未提交共 11 项：10 个已修改文件（`incremental-migration.integration.spec.ts`、`migration-schema-contract.ts`、`repair-request.entity.ts`、`e2e-scoped-cleanup.ts`、`e2e-scoped-cleanup.e2e-spec.ts` 与 5 份数据库文档）+ 1 个未跟踪文件（第 31 条迁移）。
- 迁移文件计数仍为 31；前 30 条未改写。RQ1–RQ4 实施复核未发现新的实际缺陷，因此未扩大修改。

### 2. P1 accepted 24 态来源（合成证据，不是历史业务库副本）

> accepted 代码正向重建的 24 态及合成旧数据，不是真实历史业务库副本。

- 隔离代码环境：`git worktree add --detach /tmp/litho-accepted-795eb57 795eb577f45e5ece4694dec5efa322aba1ef9a3a`；核验该提交 `src/infrastructure/database/migrations` 恰好 **24** 条迁移（清单见证据目录 `migrations_24.txt`）。
- 建库方式：该版本支持的 `migration:drill:empty-db` 配合 `MIGRATION_DRILL_DATABASE=lithography_drill_rebuild24_20261030`，在全新独占可丢弃库中清空后**正向执行原始 24 条**，输出“migration 执行成功，共 24 条”；结构契约校验通过。
- 合成旧数据：按旧结构写入 `organization` 3 行（含旧 drill 生成的 `CLIENT_DEFAULT`）、`base_user_account` 4 行、`organization_membership` 3 行、`equipment_model` 2 行、`reference_document` 1 行、`repair_request` 2 行；覆盖组织、成员、账号、机型、参考资料与工单。
- 基线留存：`structure_24.sql`（SHA-256 `379ee69d…ffdde76`）、升级前 `dump_24_pre_upgrade.sql`（SHA-256 `0d08d034…e11da0`）、`snapshot_24.json`；`migrations=24`、基础表 24。
- 证据目录：本机 `/tmp/litho-evidence-20261030/`（含 SHA、迁移清单、结构 dump、前后快照、命令日志与比较结果），属本地临时证据，不入库、不提交。
- 备份恢复验证：将备份导入同版本新库 `lithography_drill_rebuild24_restore_20261030`，完整字段确定性摘要比对 **24/24 未变**（`restore_verify_24.json`）。
- 边界：合成数据只能证明迁移链与结构兼容，不能证明真实历史业务数据兼容。来源说明已提交薛确认；如要求真实历史副本，该项仍保留为待补证。

### 3. P2 24→31 正式升级（目标 `lithography_drill_rebuild24_20261030`）

| 命令                                 | 实际输出要点                                                         | 退出码 |
| ------------------------------------ | -------------------------------------------------------------------- | ------ |
| `migration:status`                   | 历史 24、仓库 31、pending 7，逐条列出 M1～M7                         | 0      |
| `migration:run --confirm-database …` | 仅执行新增 7 条；`升级完成：历史 31 条，业务表 34 张，再次执行 0 条` | 0      |
| `migration:verify`                   | 业务表 34 张；历史校验与数据回填校验通过                             | 0      |
| 再次 `migration:run`                 | 历史 31、pending 0；执行 0 条                                        | 0      |

- 原有 24 表逐字段摘要：仅 `migrations` 数据变化（新增 7 行）；`organization_membership`、`repair_request` 为预期结构变化（新增列/生成列/索引/CHECK）；其余 21 表数据与结构均未变；新增 11 张表与设计一致。
- 回填规则核对：两条工单 `owner_organization_id=NULL`（合成旧数据无 `CUSTOMER` 成员关系，按规则不猜测）；`handling_*` 全 NULL；成员生成列 `active_account_id` 分别为 3、2、NULL（第三条为 `LEFT`，符合单有效约束）。
- 新约束真实生效：非法 result-only 被 `chk_repair_request_handling_mapping` 拒绝、双 NULL 带时间被 `chk_repair_request_handling_time` 拒绝、合法双 NULL 被接受；测试行已删除，残留 0（`constraint_live_check.log`）。
- 本项为**正式增量升级**证据，未用清库 drill 替代；备份恢复已实际验证。

### 4. P3 30→31 数据保留（目标 `lithography_drill_30to31_20261030`）

- 来源：`/tmp/lithography_upgrade_copy_20261030_before_m31.sql` 导入新库并重命名 `USE`；恢复后 `migrations=30`、第 31 条计数 0、基础表 35（业务 34），可证明为 30 态。
- 升级前 `snapshot_30_pre_upgrade.json` 覆盖 35 张表完整字段；`status` 历史 30/pending 1；`run` 执行 1 条，终态 31/34，再次 0。
- 完整字段确定性摘要比较（`compare_30_to_31.json`）：原 35 表中 **33 表未变**；`migrations` 数据新增 1 行；`repair_request` 仅 CHECK 定义更新；新增表 0。预期变化已逐项单独解释，非“仅比行数”。

### 5. P4 `check:entity-scope` 只读核实

- 实现：[check-entity-migration-scope.mjs](../../backend/scripts/check-entity-migration-scope.mjs)，由 `package.json` 的 `check:entity-scope` 调用；脚本头部注释自述为“PR3 范围门禁（敌对式终审 F2）”。
- 比较基线：`BASE` 环境变量，缺省 `origin/main`（当前 `795eb577…9a3a`），只比较**已提交**的 `BASE...HEAD`，工作区与未跟踪文件不在比较范围。
- 受保护范围：`backend/src/modules/lithography/entities`、`backend/src/database/migrations`。后者在当前仓库**不存在**（实际迁移目录为 `backend/src/infrastructure/database/migrations`），因此迁移变动实际上不受该脚本约束。
- 实际失败项（exit 1）：11 个新增 Entity + `organization-membership.entity.ts`、`repair-request.entity.ts` 两个修改；均属本分支经设计文档授权的组织/维修数据增量。
- CI 调用：`.github/workflows/ci.yml` 无该检查步骤，不构成 CI 阻塞。
- 结论：该门禁面向另一 PR 范围，本分支不适用；本轮未豁免、未改基线、未关闭检查，记录依据并交薛确认。

### 6. P5 最终验证

| 检查            | 命令/范围                                                    | 结果                                                                   | 退出码 |
| --------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- | ------ |
| 类型检查        | `npm run typecheck`                                          | 通过                                                                   | 0      |
| 全量单测        | `npm run test:unit -- --runInBand`                           | 124 suites / 1486 passed；6 suites skipped；70 tests skipped；0 failed | 0      |
| 变更文件 ESLint | 6 个变更 TS 文件                                             | 0 error                                                                | 0      |
| Prettier        | 同上 6 个 TS 文件                                            | 全部符合                                                               | 0      |
| 架构门禁        | `lint:architecture-fixtures`、`lint:usecase-normalize-guard` | 均 passed                                                              | 0      |
| 构建            | `npm run build`（含 capability docs check）                  | 通过                                                                   | 0      |
| 清理安全真实库  | `e2e-scoped-cleanup.e2e-spec.ts`                             | 42/42 passed                                                           | 0      |
| 写库前后不变    | `lithography_e2e` 35 表完整字段摘要                          | `untouched 35 / changed 0 / newTables 0`                               | 0      |
| 实体范围门禁    | `check:entity-scope`                                         | 1（范围不适用，见第 5 节）                                             | 1      |

**本轮 70 skipped 的实际原因**：全部来自 6 个默认跳过的**真实数据库集成套件**，由环境变量显式开关控制，未配置时不执行；不是被忽略的失败用例：

| 套件                                                    | 跳过用例 | 启用条件                                                                |
| ------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `incremental-migration.integration.spec.ts`             | 32       | `MIGRATION_INTEGRATION=1` + `MIGRATION_INTEGRATION_ALLOW_DESTRUCTIVE=1` |
| `admin-set-user-status.concurrency.integration.spec.ts` | 10       | `ADMIN_USER_STATUS_CONCURRENCY_INTEGRATION=1`                           |
| `maintenance-report.integration.spec.ts`                | 10       | `MAINTENANCE_REPORT_INTEGRATION=1`                                      |
| `repair-request.organization.integration.spec.ts`       | 9        | `REPAIR_REQUEST_ORG_INTEGRATION=1`                                      |
| `maintenance-report.concurrency.integration.spec.ts`    | 5        | `MAINTENANCE_REPORT_CONCURRENCY_INTEGRATION=1`                          |
| `local-runtime.concurrency.integration.spec.ts`         | 4        | `LOCAL_RUNTIME_CONCURRENCY_INTEGRATION=1`                               |

合计 70。第四轮记录的“69 项”口径作废，以本表为准；上述套件的相关用例已按本文各节在显式授权下单独实跑或由第四轮实跑覆盖。`lithography_e2e` 快照对比证明 42/42 清理套件执行后非目标数据逐字段不变、夹具零残留。

### 7. 结论与待确认

- 24→31、30→31 两条升级路径均已在隔离库以正式入口完成；24→31 的数据来源是**合成旧数据**，须由薛确认该口径是否可作为交付证据。
- 本轮未 commit、未 push、未创建/合并 PR、未发布回复；CI 未运行，不把本地结果等同 CI。
- 独立复审仍需在提交前后另行执行；`check:entity-scope` 的适用范围结论同样待薛确认。
