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

## 2026-10-31 第六轮：两条 RQ 收口与完整 core 实跑

本轮只关闭两条 RQ：旧账号资料读写旁路（RQ-A）与维修申请共享夹具/消费者适配（RQ-B）。未改迁移、未新增角色、未放宽组织过滤；除下列两处产品代码修复与测试适配外，未扩大修改范围。完整 core 实跑发现一处与本轮两条 RQ 无关的既有回归（见第 3、6 节），本轮未修，保留现场并交由后续处置。

### 1. 基线与未提交范围

- HEAD 为 `e4dca620c25cc994033d4a28f87a81a05c688070`（`fix(database): close cleanup and constraint review gaps`），全部改动位于其上未提交工作区。
- 未提交共 17 项：15 个已修改文件 + 2 个未跟踪文件（`backend/src/usecases/account/visible-user-info-organization.ts` 及其单测）。
- 迁移计数仍为 31；本轮未新增、未改写任何迁移。

### 2. RQ-A：旧账号资料读写旁路封堵

- 实现：`get-visible-user-info.usecase.ts`、`update-visible-user-info.usecase.ts` 统一经 `TrustedOrganizationContextQueryService` 解析操作者与目标的可信组织；本人路径保留自查/自改，非本人目标要求「角色策略允许 + 操作者组织事实唯一有效 + 目标属于同一有效组织」。
- 抽取共享判定到 `visible-user-info-organization.ts`；跨组织与不存在目标同口径 `NOT_FOUND`，缺失/冲突/无组织事实失败关闭；写链路在同一事务内先锁目标、再解析组织与读取资料，未套用 `admin*` 规则。
- 节点 `account.query.service.ts` 仅保留读侧职责，组织判定上移至 usecase；`backend/docs/api/account-write-current.md` 同步契约说明。
- 验证：`visible-user-info-organization.spec.ts` 17/17；`update-visible-user-info.e2e-spec.ts`（真实 GraphQL `userInfo` / `updateUserInfo`）35/35，覆盖本人自改、同组织合法访问、跨组织拒绝、目标不存在同口径、无组织历史账号与字段白名单。

### 3. RQ-B：维修申请共享夹具与消费者适配

- 夹具 `repair-request-fixture.ts`：创建本轮专属组织 `E2E_RR_PRIMARY` / `E2E_RR_PEER`、唯一 ACTIVE 成员关系与工单归属；`RepairRequestFixtureOwnership` 扩展 `organizationIds` / `membershipIds`；解析核验覆盖双向成员闭包（外部账号挂夹具组织、夹具账号挂外部组织均失败关闭）；清理按子表→父表在事务内执行；`RepairRequestFixtureRequestSeed` 增加可选 `ownerOrganizationId`。
- 四个消费者适配（未删断言、未加 skip、未统一空列表）：

| 规格                                           | 结果  | 新增覆盖                                                                                           |
| ---------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| `repair-request-read.e2e-spec.ts`              | 39/39 | 组织播种、存量归属补齐、跨组织/NULL 归属读口径                                                     |
| `repair-request-accept.e2e-spec.ts`            | 18/18 | 跨组织接单与 NULL 归属接单均 `REPAIR_REQUEST_NOT_FOUND` 且数据库零写入；与不存在目标文案逐字段一致 |
| `repair-request-production-input.e2e-spec.ts`  | 13/13 | 组织播种后合法边界查询仍为空                                                                       |
| `repair-request-fixture-ownership.e2e-spec.ts` | 19/19 | 外部账号持有夹具组织成员关系时失败关闭且零删除                                                     |

- 完整 core 暴露的第五个消费者 `repair-request-response.e2e-spec.ts`：接单要求「工单归属组织 == 工程师唯一可信组织」，原夹具工单为 NULL 归属，导致「接单 + 回复」并发用例的接单被正确拒绝。适配为播种专属组织 `E2E_RR_RESPONSE_PRIMARY`、五个账号的成员关系，并让全部工单落入该组织；断言未放宽，结果 26/26。
- 产品代码修复 `repair-request.service.ts`：事务上下文内 `findAcceptanceStatus` 改为锁定读（`lock: { mode: 'pessimistic_read' }`）。组织过滤在事务内引入了更早的一致性读，MySQL 默认 `REPEATABLE-READ` 下并发失败方会命中旧快照，把「已被他人接单/已删除」误判为 `REPAIR_REQUEST_ACCEPTED_FAILED`；锁定读后并发用例恢复 `CONFLICT` / `NOT_FOUND`，断言未改。
- 相关单测：`repair-request.service.spec.ts`、`accept-repair-request.usecase.spec.ts` 等 3 个套件 75/75；`lint:architecture-fixtures` 通过。

### 4. 完整 core 实跑

- 环境：独占隔离库 `lithography_e2e`，`E2E_ALLOW_DB_CLEANUP=1`、`E2E_ALLOW_PHYSICAL_CLEANUP=1`；运行前预置跨库 KEEP 哨兵 `lithography_e2e_keep.keep_sentinel`（marker `E2E-KEEP-SENTINEL-20261031`），并保存其与 `migrations` 31 行的逐字段快照。
- 首次运行按 `test/jest-e2e.js` 顺序执行；`run-e2e-group` 在首个失败规格处中止，实际执行 29 个规格：28 通过、1 失败。其后以同一标准 runner、同一许可环境补跑剩余 21 个规格，21/21 通过。合计 **50 个 core 规格全部实际执行：49 通过、1 失败、0 跳过**；首个运行退出码 1，补跑退出码 0。
- 失败的 `test/09-reference-document/reference-document.e2e-spec.ts`：`beforeAll` 为 `ambiguousEngineer` 在同一组织/另一组织各插入一条 ACTIVE 成员关系时被 `uk_organization_membership_active_account` 拒绝（`Duplicate entry '8'`），37/37 用例连带失败。单独复跑同一结果，与工作区改动无关。
- 根因：该规格（`c29e18d`）早于本分支新增的单有效成员迁移（`ec11508` 的 `1775401000000-alter-organization-membership-customer-single-active`），其「一个账号两条 ACTIVE → 歧义」造数在库级约束下不可能成立；解析器的歧义分支仍由 `trusted-organization-context.query.service.spec.ts` 单测覆盖。该缺陷不属于本轮两条 RQ，本轮未修改该规格，保留失败现场待处置。
- 失败现场与收尾：失败规格的 `afterAll` 受保护清理正常执行；全部运行结束后 `lithography_e2e` 的组织、成员关系、账号、型号、工单、回复残留计数均为 0，未清库重跑冒充修复。

### 5. KEEP 与不变证据

- 运行前后 `lithography_e2e_keep.keep_sentinel`（1 行，含 `payload_json` / `payload_text` / `created_at`）与 `lithography_e2e.migrations`（31 行）按确定性排序逐字段比较，结果 `KEEP_COMPARE OK`。
- 主库残留按本轮标记（`E2E_%` 组织编码、`E2E-%` 工单号、`E2E-%` 型号、成员关系、账号、回复）逐表回读为 0。
- 本轮未执行 Seed、整表清理或一次性清除脚本。

### 6. 提交审计（未提交）

- 候选范围：上述 15 个已修改文件 + 2 个未跟踪文件；HEAD 仍为 `e4dca62`。未 commit、未 push、未发布回复、未合并。
- 已知阻塞：`reference-document.e2e-spec.ts` 的既有回归使标准 core 首次运行退出码为 1；本轮按范围约束未修，完整 core 目前不能表述为全绿。
- 独立复审仍未进行；本轮结果均为修复方实测。

## 2026-10-31 第七轮：本次新增 RQ（三 Entity 唯一索引与设计文档校正）

本轮只处理薛在 PR #2 新增评论中的两项：三个 Entity 缺少唯一索引声明、数据库设计文档不准确。第六轮的两项（账号权限旁路、共享夹具 + 完整 core 失败）结论继续有效，未被本轮替代；两份计划在同一分支收口。

### 1. 基线与范围

- 分支 `feat/maintenance-data-increment`，HEAD 仍为 `e4dca620c25cc994033d4a28f87a81a05c688070`，全部改动位于其上的未提交工作区；本轮保留第六轮未提交修改。
- 未改迁移（仍 31 条）、未新增角色、未拆表、未运行 `synchronize`、未新增报告/工单复合外键、未把本地运行三表扩大为云端多实例管理。
- 数据库契约层（`migration-schema-contract.ts` 的 `REQUIRED_INDEXES` / `REQUIRED_INDEX_DEFINITIONS`）本轮核对为已正确，未改动；缺口仅在 Entity 声明与文档描述。

### 2. P1：三个 Entity 补齐唯一索引声明

| Entity                                    | 新增声明                                                                                                    | 列序                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `organization-membership.entity.ts`       | `@Index('uk_organization_membership_active_account', ['activeAccountId'], { unique: true })`                | `active_account_id`            |
| `maintenance-report-attachment.entity.ts` | `@Index('uk_maintenance_report_attachment_active_slot', ['reportId', 'activeSortOrder'], { unique: true })` | `report_id, active_sort_order` |
| `local-backup-run.entity.ts`              | `@Index('uk_local_backup_run_active', ['activeInstallationId'], { unique: true })`                          | `active_installation_id`       |

- 装饰器一律使用 Entity 属性名，物理列名仅用于数据库核对；生成列表达式、`insert/update: false`、`generatedType: 'STORED'` 与业务语义均未改动。
- 三处声明与对应迁移（`1775401000000`、`1775401300000`、`1775401400000`）中的索引名称、唯一性与列序完全一致。

### 3. P2：只读一致性与 TypeORM 判定证据

临时只读脚本（核验后删除，不随提交）依次输出下列结果，退出码 0：

| 检查项                                 | 结果                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Entity 元数据（名称/唯一/属性列序）    | 三个索引 `ENTITY_INDEX OK unique=true`，属性列序与预期一致                                                                             |
| 隔离库 `information_schema.statistics` | 三个索引 `DB_INDEX OK unique=true`，物理列序与预期一致                                                                                 |
| TypeORM `shouldDropIndices`            | 三个索引均 `false`，不再被判定为应删除项                                                                                               |
| 差异语句来源                           | 组织成员、本地备份两索引零语句；附件槽位索引有 4 条 DROP/CREATE，来源为 `dropColumnCompositeIndices`（列定义变更连带重建），非删除判定 |

- 附件槽位索引的 DROP+CREATE 不是索引语义不一致：TypeORM 在 `updateExistColumns` 中修改 `active_sort_order` 列定义时，会先删除包含该列的复合索引再重建；同表的单列索引（如组织成员、本地备份）不受影响，因此只出现这一处。该判定链与手工核对结论一致：两侧 `isUnique` / `isSpatial` / `isFulltext` / 列数与列名完全相同。
- 全部比较只读执行：未建表、未写结构、未执行 `synchronize`，仅屏蔽了对不存在的 `typeorm_metadata` 的只读查询。

### 4. 真实 MySQL 六场景约束回归

环境：隔离库 `lithography_e2e`，显式 `E2E_ALLOW_PHYSICAL_CLEANUP=1`；逐行登记创建主键，收尾按主键精确删除。

| 场景                         | 预期 | 实测                                                                                          |
| ---------------------------- | ---- | --------------------------------------------------------------------------------------------- |
| 同账号首条 ACTIVE 组织归属   | 允许 | 成功                                                                                          |
| 同账号重复 ACTIVE 组织归属   | 拒绝 | `ER_DUP_ENTRY` / `organization_membership.uk_organization_membership_active_account`          |
| LEFT 历史归属与 ACTIVE 共存  | 允许 | 成功                                                                                          |
| 同报告首条 CURRENT 附件槽位  | 允许 | 成功                                                                                          |
| 同报告重复 CURRENT 附件槽位  | 拒绝 | `ER_DUP_ENTRY` / `maintenance_report_attachment.uk_maintenance_report_attachment_active_slot` |
| RETIRED 附件与同槽位 CURRENT | 允许 | 成功（先退役首条 CURRENT 再插入同槽位 CURRENT）                                               |
| 同安装首条 RUNNING 备份      | 允许 | 成功                                                                                          |
| 同安装实例重复 RUNNING 备份  | 拒绝 | `ER_DUP_ENTRY` / `local_backup_run.uk_local_backup_run_active`                                |
| 备份终态历史与新一轮 RUNNING | 允许 | 成功（先将首条置 `INTERRUPTED` 并写 `finished_at` 再插入）                                    |

- 隔离库原无 `local_installation` 行；脚本仅在缺失时临时插入单行 `id=1` 并登记，收尾精确删除，未改写既有行。
- 收尾核验：7 张相关表行数逐一复原为运行前值，标签残留 `organization=0`、`account=0`，无其他表被触碰。
- 复用已有用例结论：本仓库现有基线中不存在这三条库级唯一键的真实库断言，故以上为新增断言；既有集成套件（`maintenance-report.integration.spec.ts`、`local-runtime.concurrency.integration.spec.ts`）未重复改动。

### 5. P3：设计文档校正

仅依据实际 Entity、Migration 与隔离库 `information_schema` 修正文档，未反向修改正确实现：

1. §3.1 `member_role` 由 `varchar(20)` 改为实际的 `varchar(32)`。
2. 逐字段核对 signed/unsigned（未全局替换）：修正 3.3—3.12 中误写的 `int unsigned` 主键/外键为 `int`；保留确实为无符号的 19 列（`phase_flow_version`、`current_version_no`、`ai_score`、`ai_helpfulness`、`alarm_index`、`step_no`、两处 `byte_size`、两处 `sort_order`、`active_sort_order`、`version_no`、三处 `schema_version`、`backup_interval_days`、`entity_local_id`、`attempt_count`、`attachment_count`、`local_installation.id`），并逐一与隔离库核对一致。
3. 删除不存在的 `RESUBMIT`：明确当前提交与退回后重提均写 `SUBMIT`，通过递增 `version_no` 区分轮次；`chk_..._change_kind` 允许 `SUBMIT / FORMAL_CORRECTION`，但允许值不等于正式更正流程已实现。
4. §14 复合外键取舍理由修正：`repair_request_id` 可空仅影响该行为 NULL 的记录，对非 NULL 工单总结建立复合外键不构成技术障碍；当前数据库分别保证两列引用存在，**不保证报告组织与工单组织相同**，同组织一致性由受控用例锁后校验承担，本轮保留该取舍。
5. 保持「报告审核通过不等于发布为参考资料」的边界，未改该表述。

### 6. P4：验证

| 检查            | 命令/范围                                                             | 结果                     |
| --------------- | --------------------------------------------------------------------- | ------------------------ |
| 类型检查        | `npm run typecheck`                                                   | 通过，退出码 0           |
| 变更文件 ESLint | 三个 Entity 文件                                                      | 0 error，退出码 0        |
| Prettier        | 三个 Entity + 两份 database 文档                                      | 全部符合                 |
| 相关单测        | `maintenance-report.service.spec.ts`、`local-runtime.service.spec.ts` | 2 suites / 17 passed     |
| 索引只读核验    | 临时脚本（已删除）                                                    | `RESULT PASS failures=0` |
| 六场景回归      | 临时脚本（已删除）                                                    | `RESULT PASS failures=0` |

### 7. 证据边界与交接

- 本轮未 commit、未 push、未发布回复、未合并；HEAD 未变。
- 附件槽位索引在 schema diff 中的 DROP+CREATE 属 TypeORM 列变更连带行为，需在复审时按第 3 节的来源分类阅读，不能直接当作「索引被删除」。
- 与第六轮收口：完整 core 仍需在「权限旁路 + 共享夹具 + 本次三索引」统一稳定候选上重跑一次；本轮未重跑完整 core，`reference-document.e2e-spec.ts` 仍为已知阻塞。
- 独立复审仍未进行；本轮结果均为修复方实测。

## 2026-10-31 第八轮：参考资料夹具适配、索引回归固化与完整 core 终验

第六轮的失败历史（完整 core 49/50、`reference-document.e2e-spec.ts` 37/37 失败）保持原样，本节只新增最终运行记录，不覆盖、不重写原始失败。

### 1. 本轮的代码改动

| 文件/范围                                                               | 改动                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/test/09-reference-document/reference-document.e2e-spec.ts`     | `ambiguousEngineer` 只在甲方组织保留一条 ACTIVE 成员；删除第二组织 ACTIVE 成员与对应登录；原「多有效成员关系歧义」用例改为「事务内插入第二条 ACTIVE 被 `uk_organization_membership_active_account` 拒绝、回滚、无残留」。 |
| `backend/test/utils/unique-index-constraints.e2e-spec.ts`（新增）       | 固化三个唯一索引回归：Entity 元数据（名称/唯一性/属性列序）、隔离库物理索引（`information_schema.statistics`，名称/唯一性/物理列序）、六场景约束（事务内造数并统一回滚，核对表级行数与标签残留）。                        |
| `backend/test/jest-e2e.js`                                              | 将新增规格登记进 core 分组（core 规格数 50 → 51）。                                                                                                                                                                       |
| `backend/src/modules/lithography/entities/*.entity.ts` 等第六、七轮改动 | 本轮未改业务语义、Migration、角色与前端；仅保留既有未提交修复。                                                                                                                                                           |

夹具边界：正常访问每账号只建一条 ACTIVE；跨组织访问用两个组织各自的独立账号；LEFT 仅在历史关系场景使用；重复 ACTIVE 负例在事务中回滚。未扩大生产权限或清理范围，未删除或跳过任何规格。

### 2. 定向验证（统一候选，运行前未改源码）

| 检查                                                                                 | 结果                 |
| ------------------------------------------------------------------------------------ | -------------------- |
| `tsc -p tsconfig.build.json --noEmit` / `tsconfig.tools.json` / `tsconfig.spec.json` | 全部通过，退出码 0   |
| `lint:architecture-fixtures` / `lint:usecase-normalize-guard`                        | 通过                 |
| 变更文件 ESLint、Prettier                                                            | 0 error，全部符合    |
| `reference-document.e2e-spec.ts`                                                     | 1 suite / 37 passed  |
| `unique-index-constraints.e2e-spec.ts`                                               | 1 suite / 3 passed   |
| `maintenance-report.service.spec.ts`、`local-runtime.service.spec.ts`                | 2 suites / 17 passed |

### 3. 完整 core 终验（退出码 0）

命令（独占隔离环境，从头执行一次，未分段拼接证据）：

```bash
E2E_ALLOW_DB_CLEANUP=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:core
```

| 指标     | 结果                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| 规格     | 51 个，51 个 `Test Suites: 1 passed`，0 个失败                                              |
| 用例     | 697 total / **690 passed / 0 failed / 7 skipped**                                           |
| 跳过归属 | 7 个跳过全部来自既有 `test/utils/e2e-pr0-acceptance.e2e-spec.ts` 的条件跳过，与本轮改动无关 |
| 退出码   | 0                                                                                           |
| 日志     | `/tmp/e2e-core-r3.log`                                                                      |

KEEP 与残留核验（KEEP 为独立 schema 中不属于本轮夹具的合成哨兵，含文件 SHA-256 摘要；快照 `/tmp/e2e-keep-snapshot-before-r3.json`）：

| 检查项                         | 结果                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| KEEP 行逐字段 + 文件摘要       | 不变（`keepRows=2`）                                                                     |
| `migrations` 记录              | 31 条不变                                                                                |
| 本轮标签残留（`UKC_`/`RQVC_`） | organization=0、account=0、report=0、attachment=0                                        |
| 约束残留                       | ACTIVE 成员=0、CURRENT 附件=0、RUNNING 备份=0、其他安装行=0                              |
| 相关业务表行数                 | organization / account / membership / report / attachment / installation / backup 均为 0 |

### 4. 证据归属与边界

- **完整 core 通过**：本次 51/51 规格、690 passed / 0 failed 为统一候选的最终证据，取代第七轮「未重跑完整 core」的边界说明；第六轮失败记录仅作历史保留。
- **专项通过**：`reference-document` 37/37、索引回归 3/3、类型检查、架构门禁、ESLint、Prettier、相关单测。
- **历史沿用**：既有迁移演练与第七轮只读索引比对证据按影响沿用，本轮未无差别重跑。
- **未执行**：`test:e2e:worker`、`test:e2e:smoke`（依赖 Redis/BullMQ/外部服务）与需显式开关的 `*.integration.spec.ts` 不在本轮范围。
- 完整 core 运行于未提交工作区（HEAD `e4dca620c25cc994033d4a28f87a81a05c688070` 之上的统一候选）；本轮仍未 commit、未 push、未发布回复、未合并。

## 2026-10-31 第九轮：目标库 KEEP 保留模式补验

第八轮证明的是「可从干净库从头运行」，本轮补的是「目标库存在合法非夹具数据时仍可完整运行且该数据不被测试波及」。两轮结论互不替代。

### 1. KEEP 构成（目标库业务表，非独立 schema）

显式 ID 990001、标记 `KEEP_R4_*`，与测试夹具的随机后缀标记完全不同：

| 表                        | 行内容                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `base_user_account`       | `keep_r4_engineer` / `KEEP R4 Engineer`，ENGINEER，ACTIVE                                               |
| `base_user_info`          | 同账号资料行，`access_group=["ENGINEER"]`                                                               |
| `organization`            | `KEEP_R4_ORG`，CLIENT，ACTIVE                                                                           |
| `organization_membership` | 上述组织与账号的唯一一条 ACTIVE 归属                                                                    |
| `equipment_model`         | `KEEP_R4_MODEL`，启用                                                                                   |
| `repair_request`          | `KEEP_R4_RR_001`，`owner_organization_id` / `customer_account_id` / `equipment_model_id` 均指向上述记录 |

运行前快照 `/tmp/e2e-keep-r4-before.json` 保存六行完整字段、4 项引用计数与 `/tmp/e2e-keep-file-r4.txt` 的 SHA-256。KEEP 不进入任何规格账本，回收使用独立账本 + `runGuardedSpecCleanup`。

### 2. 运行配置与开关生效证据

```bash
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_DB_CLEANUP=0 E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:core
```

日志确认：`skipDbCleanup=true, allowDbCleanup=false`、目标库白名单 `lithography_e2e`、`⏭️ 已跳过 MySQL 全库清理`，无 TRUNCATE。运行期间未改源码。

### 3. 首次尝试暴露的隔离假设（未绕过）

第一次运行（日志 `/tmp/e2e-core-r4.log`）在 `repair-request-flow.e2e-spec.ts` 失败：`equipmentModels` 断言整表精确等于本规格两行，KEEP 型号使其不成立。查明为**测试隔离假设**而非产品缺陷；未删除 KEEP、未放宽权限、未加 skip、未清库重跑。同类问题在 `admin-document-database.e2e-spec.ts`（未加筛选的 `adminRepairRequests.total=2` 两处、全局统计计数）一并修复。

修复内容（断言强度不降）：

| 文件                                                                  | 修复方式                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/06-repair-request/repair-request-flow.e2e-spec.ts`              | 由「整表精确列表」改为「返回集合 == 库内 `enabled=1` 集合」+ 返回顺序与 `sort_order` 非降序 + 停用型号不出现；定向 9/9。                                                            |
| `test/10-admin-document-database/admin-document-database.e2e-spec.ts` | 两处 total 断言按夹具标记 `E2E-ADM-DOCDB-CORE` 收窄（软删排除断言保留）；全局统计改为与库内真实口径对齐（申请排除 `deprecated`、AI 计全量、参考资料按管理员组织范围）。定向 12/12。 |

### 4. 最终运行（KEEP 保留模式）与核验

| 指标   | 结果                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------- |
| 命令   | 同 §2，日志 `/tmp/e2e-core-r5.log`                                                                    |
| 规格   | 51/51 全部通过，0 失败                                                                                |
| 用例   | 697 total / **690 passed / 0 failed / 7 skipped**（跳过仍全部来自既有 `e2e-pr0-acceptance` 条件跳过） |
| 退出码 | 0（runner 按失败规格数判定）                                                                          |

运行后核验：

| 检查项                 | 结果                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| KEEP 六行全字段        | 不变（六表各 1 行）                                                       |
| KEEP 引用计数          | ACTIVE 归属 / 组织工单 / 客户工单 / 型号工单均为 1                        |
| KEEP 文件哨兵 SHA-256  | 不变                                                                      |
| `migrations`           | 31 条内容不变                                                             |
| 测试标签残留           | `UKC_`/`RQVC_` 组织 0、账号 0、报告 0、附件 0；RUNNING 备份 0；其他安装 0 |
| 运行期间相关业务表行数 | 均为 1（即 KEEP 本身；**不要求为空**）                                    |

### 5. 收尾

通过独立账本与 `runGuardedSpecCleanup` 精确回收 KEEP，回收后 `base_user_account` / `base_user_info` / `organization` / `organization_membership` / `equipment_model` / `repair_request` 均为 0，`migrations` 仍为 31。临时预置与回收脚本已删除。

### 6. 证据边界

- 本轮证明：目标库保留合法非夹具数据时，完整 core 仍全部通过，且该数据零改动、零波及。
- 第八轮证明：干净库从头运行的完整通过。
- 两者都不能替代对方；`test:e2e:worker` / `test:e2e:smoke` 与需显式开关的 `*.integration.spec.ts` 仍未执行。

## 2026-10-31 第十轮：`account(id)` 跨组织旁路与共享清理器事务收尾

本轮仅修两项阻塞：**不改 Entity、Migration、角色或前端**。前述各节的完整 core 结果属于历史证据，不代表本轮新代码已验收；本节为统一稳定候选上的新一轮结果。

### 1. P1｜封堵旧 `account(id)` 跨组织旁路

授权整体上移到 `GetAccountByIdUsecase`，`AccountQueryService` 只保留纯读投影 `findAccountSnapshotById`（account 域不跨域读组织事实），Resolver 不加业务判断。授权顺序固定为：

1. 非法目标 ID → `ACCESS_DENIED`（不触达数据库）；
2. 本人查询（`session.accountId === targetAccountId`）直接放行，不解析组织，保留历史无组织账号自查；
3. 非本人先沿用**原有管理员权限**（`roles` 含 `SUPER_ADMIN`），ENGINEER / CUSTOMER 仍拒绝，未扩大任何角色权限；
4. 管理员通过后再叠加**可信同组织校验**（复用 `visible-user-info-organization` 的 `resolveForAccount` + `findActiveMembership`）；操作者组织缺失/歧义、目标无有效成员关系、组织停用一律失败关闭；
5. 跨组织与目标不存在使用同一拒绝口径 `USER_INFO_NOT_FOUND`（NOT_FOUND，「目标用户不存在」）；只有授权通过后才读取账号行，登录邮箱、角色、登录历史不会在拒绝前返回；
6. 授权后账号行消失（并发删除）非本人同样走不可用口径，本人保留 `ACCOUNT_NOT_FOUND`。

说明：库级约束 `uk_organization_membership_active_account`（生成列 `active_account_id`）保证一个账号至多一条 ACTIVE 成员关系，真实数据无法构造「多组织歧义」，故歧义分支由 usecase 单测（替身）覆盖，真实库侧以「无组织管理员查他人」与「跨组织管理员查他人」为同码证据。

| 回归层次                                                               | 覆盖与结果                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单测 `get-account-by-id.usecase.spec.ts`                               | 15 项通过：本人不解析组织；同组织按契约返回且调用顺序 `resolve → membership → snapshot`；跨组织拒绝且不读账号行、不泄露 email；权限不足先于组织解析；组织缺失/歧义失败关闭；目标不存在同码同文案；授权后行消失两种口径；非法 ID 0 / -1 / 1.5                                                                                                                          |
| 单测 `visible-user-info-organization.spec.ts`                          | 17 项通过（与上一文件合计 32 项）                                                                                                                                                                                                                                                                                                                                     |
| 真实 GraphQL + JWT + 隔离 MySQL `update-visible-user-info.e2e-spec.ts` | **43 项通过**，直接调用公开 `account(id)`：管理员同组织按原字段契约返回；跨组织拒绝且响应 JSON 不含目标 `loginEmail` / `loginName`；目标 LEFT 拒绝；目标不存在与跨组织同码同文案；ENGINEER 非本人 `ACCESS_DENIED` 且不含 email；无组织管理员查他人 `ORGANIZATION_NO_ACTIVE_MEMBERSHIP` 且不含 email；无组织管理员查本人保留原行为；管理员查无组织目标按跨组织口径拒绝 |

### 2. P2｜共享清理器事务收尾

`runOwnedFixtureCleanup` 重构：

- `connect`、`startTransaction`、数据库守卫、所有权核验、引用闭包、精确删除、`commitTransaction`、关闭全部纳入同一保护范围；
- 回滚依据驱动实际 `isTransactionActive`，不依赖「`startTransaction()` 已成功返回」的标志；`AfterTransactionStart` 抛错后事务仍活动时照常回滚；
- 真实回滚失败与注入失败同路径：销毁**本轮独占连接**（`databaseConnection.destroy`），禁止把活动事务连接普通 `release()` 回池；
- 不销毁共享连接池（检测到 `getConnection` 即拒绝）；驱动未暴露可销毁连接或不支持 `destroy` 时明确报告，而不是假装释放成功；
- 主错误、回滚、销毁、释放错误分别保留并汇总到 `OwnedFixtureCleanupError`；提交成功但释放失败也明确失败，不宣称资源释放成功；
- 保留原目标库守卫、所有权核验、引用闭包与单事务精确删除范围。

`e2e-owned-fixture.e2e-spec.ts` 新增 7 项故障注入回归，合计 **26 项通过**，逐项都在 `finally` 恢复替身并断言事务已结束（无泄漏事务）：

| 场景                                      | 结果                             |
| ----------------------------------------- | -------------------------------- |
| 事务已活动后 `AfterTransactionStart` 抛错 | 仍尝试回滚，连接正常收尾         |
| `rollbackTransaction()` 抛错              | 销毁独占连接，不普通归池         |
| 主流程、回滚、销毁同时失败                | 三段错误均出现在最终消息中       |
| 驱动无 `destroy`                          | 明确报告无法安全关闭，不普通归池 |
| 正常失败后回滚                            | 行为不回退                       |
| 正常成功提交                              | 行为不回退                       |
| 提交成功、释放失败                        | 明确失败，不报成功               |

### 3. 静态门禁与完整 core（KEEP 保留模式）

静态与定向验证：`npm run typecheck` 通过；六份变更文件 ESLint 通过；Prettier 检查通过（对 3 个文件执行 `--write` 后复跑 ESLint 通过）；`lint:architecture-fixtures` 与 `lint:usecase-normalize-guard` 均通过。

完整 core 在同一稳定候选上从头运行，目标库 KEEP 保留模式（全局清库关闭，物理清理许可与所有权守卫保留）：

```bash
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_DB_CLEANUP=0 E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:core
```

| 指标     | 结果                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 开关生效 | 日志确认 `skipDbCleanup=true, allowDbCleanup=false`、目标库白名单 `lithography_e2e`、`⏭️ 已跳过 MySQL 全库清理`，无 TRUNCATE |
| 规格     | **51/51 通过，0 失败**                                                                                                       |
| 用例     | **712 total / 705 passed / 0 failed / 7 skipped**（跳过仍全部来自既有 `e2e-pr0-acceptance` 条件跳过）                        |
| 退出码   | **0**                                                                                                                        |
| 日志     | `/tmp/e2e-core-r6.log`                                                                                                       |

KEEP 构成（本轮合成记录，非测试夹具）：显式 ID 990001，标记 `KEEP_R5_*`，覆盖 `base_user_account` / `base_user_info` / `organization` / `organization_membership` / `equipment_model` / `repair_request` 六行，另含文件哨兵 `/tmp/e2e-keep-file-r5.txt`。运行前快照保存在 `/tmp/e2e-keep-r5-before.json` 与 `/tmp/e2e-migrations-r5-before.json`。

运行后核验（`/tmp/e2e-verify-after-core-r5.js` 回执）：

| 检查项                                    | 结果                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| KEEP 六行全字段                           | `KEEP_ROWS OK`（六表各 1 行）                                               |
| KEEP 引用计数                             | `KEEP_REFS OK`（ACTIVE 归属 / 组织工单 / 客户工单 / 型号工单均为 1）        |
| KEEP 文件哨兵 SHA-256                     | `KEEP_FILE OK`（`01dd2628…`）                                               |
| `migrations`                              | `MIGRATIONS OK`，31 条内容不变                                              |
| 测试夹具标签残留                          | `UKC_` / `RQVC_` 组织 0、账号 0、报告 0、附件 0；RUNNING 备份 0；其他安装 0 |
| 夹具 ID 区间残留（`>= 900000` 且非 KEEP） | 组织 0、账号 0                                                              |
| 运行期间相关业务表行数                    | 均为 1（即 KEEP 本身；不要求为空）                                          |

通过独立账本与 `runGuardedSpecCleanup` 精确回收 KEEP；回收后六张表均为 0，`migrations` 仍为 31，临时回收脚本已删除。**未使用 Seed、整表清理或 KEEP 删除后重跑。**

### 4. 证据边界

- 本轮完整 core 与 `account(id)` 真实回归均运行于未提交工作区（HEAD `e4dca620c25cc994033d4a28f87a81a05c688070` 之上的统一候选）；第七、八、九轮结果仅作历史保留，不构成本轮新代码的验收证据。
- 已有迁移演练证据按影响沿用，本轮未重跑无关迁移演练。
- `test:e2e:worker` / `test:e2e:smoke` 与需显式开关的 `*.integration.spec.ts` 不在本轮范围。
- 本轮未暂存、未 commit、未 push、未回复 PR、未合并。

## 2026-10-31 第十一轮：成功后登记窗口与安装设置恢复收尾

本轮只修两处收尾缺口，**不改业务规则、Entity、Migration**：其一，创建/提交成功后首次登记仍依赖回读 `SELECT`；其二，安装设置恢复路径的事务收尾分散、回滚依据标志而非驱动实际状态。前文各节完整 core 结果属于历史证据，不能替代本节在新代码上的结果。

### 1. P1｜先登记创建事实，再回读核验

问题定位：`registerById()` 等首次登记路径在提交成功后通过 `SELECT *` 回读得到 ID 与字段，再写入账本。回读一旦抛错，已提交行既不进入账本，也不会出现在残留核对中，形成“假零残留”。

修复（共享账本 `backend/test/utils/e2e-owned-fixture.ts` 与消费者）：

- 首次登记改为**纯同步** `registerCreated(table, id, expected)`：ID 与字段来自创建输入、驱动 `insertId` 或已提交结果，不读取数据库；`register()` 同样不依赖回读。
- 数据库生成的 ID 在无法同步取得时走 `registerPending` + `resolvePending`（按自然键 `<=> ?` 解析）；解析失败保留为待核验记录，仍参与残留核对。
- `verifyRegistered` 只读比对，不回写账本、不覆盖原始归属；不允许从查询结果自动认领账本外关联记录。
- `applyExpectedChange` 仍拒绝未知字段，但允许 `VOLATILE_COLUMNS`（如 `updated_at`）虽未登记预期也可被显式业务变更接受；主键与所有权列仍不可改写。
- `assertRegisteredRowsAbsent(dataSource, rows, pending)` 同时核对已登记主键与待核验自然键，回读失败的待核验目标按“待核验 …”计入残留，不会消失。

消费者调整：

| 文件                                                 | 调整                                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-runtime.concurrency.integration.spec.ts`      | 提交成功后立即 `registerCreated('local_upload_task', task.id, …)`，A/B 分支各自登记、不等待另一分支；回调返回 `Promise.resolve()` 以满足执行器契约。 |
| `maintenance-report.concurrency.integration.spec.ts` | 建稿成功即按创建结果登记报告根、报警、步骤；提交成功即登记版本与版本附件复合主键；上传附件、外部记录全部改为同步登记，回读只用于比对。               |
| `maintenance-report.integration.spec.ts`             | 版本附件按提交时已知附件集合登记复合主键，不再按 `version_id` 扫描后认领。                                                                           |

回归（`backend/test/utils/e2e-owned-fixture.e2e-spec.ts`，SQL 替身 + 真实 MySQL，**35/35 通过**）新增 4 项：

| 场景                              | 结果                                     |
| --------------------------------- | ---------------------------------------- |
| 创建/提交成功后回读 `SELECT` 抛错 | 已知 ID 与事实仍在账本，残留核对命中该行 |
| 回读发现字段漂移                  | 拒绝清理，原预期不变                     |
| 并发部分成功                      | 成功分支各自登记，全部分支结束后才收尾   |
| 已登记但回读失败                  | 以“待核验 …”参与残留核对，不返回假零残留 |

过程中暴露并修复的问题（保留失败历史）：首次定向运行 7 项失败，清理阶段报 `字段 maintenance_report.updated_at 不在登记预期内` 并连带 teardown 残留；确认是 `applyExpectedChange` 对 `VOLATILE_COLUMNS` 过严，修复后重跑通过。`local-runtime` 并发规格另由 `tsconfig.spec.json` 暴露 TS2322（回调返回 `void` 不满足 `Promise<void>`），改为返回 `Promise.resolve()`。失败运行遗留的精确夹具已按已知 ID/报告谱系单事务核验删除，未使用 Seed 或整表清理。

### 2. P2｜安装设置恢复收尾

`local-runtime.concurrency.integration.spec.ts` 的 `restoreInstallation` 改为复用已验证的统一收尾 helper `runGuardedQueryRunnerTransaction`：

- `connect`、`startTransaction`、数据库守卫、恢复前归属与字段核验、恢复写入、`commitTransaction`、关闭全部在同一保护范围；
- 回滚依据驱动实际 `isTransactionActive`，不依赖“`startTransaction()` 已成功返回”的标志；
- 回滚失败或回滚后仍活动时销毁**本轮独占连接**（`databaseConnection.destroy`），不再普通 `release()` 归池；不销毁共享连接池；
- 主错误、回滚、销毁、释放错误分别保留并汇总返回；提交成功但释放失败同样上报；
- 恢复前的归属/字段白名单核验与“拒绝写回”口径保持不变。

新增 5 项真实驱动方法替身回归：

| 场景                   | 结果                                |
| ---------------------- | ----------------------------------- |
| 恢复写入失败、回滚成功 | 回滚并释放，不销毁                  |
| 恢复写入与回滚均失败   | 销毁独占连接，不普通归池            |
| 回滚与销毁均失败       | 各阶段错误完整保留                  |
| 事务启动后事件抛错     | 依据 `isTransactionActive` 收尾     |
| 提交成功、释放失败     | `committed=true` 且明确报告释放失败 |

每项均在 `finally` 恢复驱动替身并断言 `isTransactionActive=false`，收尾不置于断言之后。

### 3. 定向验证与完整 core（KEEP 保留模式）

定向与静态验证（均为修复方自测，非独立复审）：

| 验证                                                          | 结果                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npm run typecheck`                                           | 通过（退出码 0）                                                               |
| 变更文件 ESLint                                               | 0 error                                                                        |
| Prettier                                                      | 变更文件全部符合（已 `--write`）                                               |
| `lint:architecture-fixtures` / `lint:usecase-normalize-guard` | 通过                                                                           |
| `e2e-owned-fixture.e2e-spec.ts`                               | 35/35 通过                                                                     |
| 四份实库规格（维修报告集成/并发、维修申请组织、本地运行并发） | 28/28 通过                                                                     |
| 全量单测 `npm run test:unit -- --runInBand`                   | 126 suites passed / 1518 passed / 70 skipped（6 个未启用开关的集成规格等跳过） |

完整 core 在统一稳定候选上从头运行，目标库 `lithography_e2e` 为独占隔离库，KEEP 保留模式（全局清库关闭，物理清理许可与所有权守卫保留）：

```bash
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_DB_CLEANUP=0 E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:core
```

| 指标     | 结果                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 开关生效 | 日志确认 `skipDbCleanup=true, allowDbCleanup=false`、白名单 `lithography_e2e`、`⏭️ 已跳过 MySQL 全库清理`，无 TRUNCATE                        |
| 规格     | **51/51 通过，0 失败**                                                                                                                        |
| 用例     | **721 total / 714 passed / 0 failed / 7 skipped**（跳过仍全部来自既有 `e2e-pr0-acceptance` 条件跳过；数量按本轮实际日志重新统计，不沿用 705） |
| 退出码   | **0**                                                                                                                                         |
| 日志     | `/tmp/s5-core.log`                                                                                                                            |

KEEP 构成：显式 ID 990001，标记 `KEEP_R6_*`，覆盖 `base_user_account` / `base_user_info` / `organization` / `organization_membership` / `equipment_model` / `repair_request` 六行，另含文件哨兵 `/tmp/e2e-keep-file-r6.txt`；运行前快照 `/tmp/s5-keep-before.json`，全库基线 `/tmp/s5-snapshot-before.json`。

运行后核验（`/tmp/s5-verify-after.json`）：

| 检查项                                    | 结果                                                      |
| ----------------------------------------- | --------------------------------------------------------- |
| KEEP 六行全字段                           | 六表各 1 行，逐字段不变                                   |
| KEEP 引用计数                             | ACTIVE 归属 / 组织工单 / 客户工单 / 型号工单均为 1        |
| KEEP 文件哨兵 SHA-256                     | 不变（`3ebbeaf4810a…`）                                   |
| `migrations`                              | 31 条内容不变，迁移文件 31 个不变                         |
| 全库逐表摘要                              | 35 张表、37 行，运行前后完全一致（含 KEEP 与 migrations） |
| 业务表除 KEEP 外残留                      | 0                                                         |
| 显式 ID 区间残留（`>= 900000` 且非 KEEP） | 账号/组织/机型/工单/上传任务均为 0                        |

收尾：通过单事务逐行 `FOR UPDATE` 核验六行全字段与回收快照一致、引用闭包无账本外行后，按子表→父表精确删除并删除文件哨兵；回收后六张表均为 0、`migrations` 仍为 31，全库回到 35 张表 31 行（仅 `migrations`）。临时预置/核验/回收脚本已删除，**未使用 Seed、整表清理或 KEEP 删除后重跑**。

### 4. 证据边界

- 本节区分三层证据：驱动方法替身（SQL 替身故障注入）、真实 MySQL 集成规格（需显式开关）、完整 core（KEEP 保留模式）。三者互不替代。
- 完整 core 与定向回归均运行于未提交工作区（HEAD `e4dca620c25cc994033d4a28f87a81a05c688070` 之上的统一候选）；第七至第十轮结果仅作历史保留。
- `test:e2e:worker` / `test:e2e:smoke`、未启用的集成规格、迁移演练不在本轮范围。
- 以上均为修复方实测，本轮未进行独立复审。
- 本轮未暂存、未 commit、未 push、未回复 PR、未合并。

## 2026-10-31 第十二轮：竞争执行器回滚失败与连接创建保护

本轮只修改共用并发执行器 `backend/test/utils/upload-race-runner.ts`、其生命周期单测、`backend/test/utils/e2e-owned-fixture.ts` 的销毁 helper 导出（复用既有安全收尾能力）与验收记录，**不改业务代码、Entity、Migration**。上一轮完整 core 结果属于历史证据，不代表本轮新代码。

### 1. 本轮修复的两项缺陷

| 缺陷                     | 表现                                                                               | 修复                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 回滚失败后仍普通归池     | `settleRunner` 在回滚抛错后继续 `release()`，把可能仍活动事务的连接放回连接池      | 回滚失败或回滚后事务仍活动时销毁本轮独占连接；销毁已尝试/已完成后不再 `release()`                                                          |
| 第二连接创建不在保护范围 | `createRunner()` 在 `try` 之外，同步抛错会跳过取消与收尾，第一分支可能等待或误提交 | 第一、第二连接的 `createRunner()`、`connect`、`startTransaction` 全部纳入保护；第二连接创建失败即取消第一分支，等待其完成回滚/释放后再拒绝 |

### 2. 实现要点

- 复用已验证的安全收尾能力：`destroyExclusiveQueryRunner` 由 `backend/test/utils/e2e-owned-fixture.ts` 导出，竞争执行器不再另造一套销毁逻辑；共享连接池（`getConnection` 特征）一律拒绝销毁，驱动无 `databaseConnection` 时明确报告“无法安全断开”。
- `settleRunner` 与 `runGuardedQueryRunnerTransaction` 保持相同顺序：按驱动实际 `isTransactionActive` 回滚 → 回滚失败或仍活动则销毁 → 仅在未销毁/未尝试销毁且事务不活动时释放。
- 分支主错误、回滚、销毁、释放错误分别追加到 `errors`，互不覆盖；原始分支 `reason` 保持不变。
- 第二连接创建同步失败：先 `resolveDecision('cancel')`，`await firstPromise` 确保第一分支完成回滚/销毁/释放，再抛出包含主错误与收尾错误的异常；进入竞争等待的代码不会执行。
- 第二连接 `connect`/`startTransaction` 失败：取消第一分支、等待其收尾，第二连接按实际状态收尾（未连接不关闭，已连接按活动状态回滚/销毁或释放）。
- 未创建成功的连接不执行关闭；已创建但只部分初始化（已连接或事务已激活）的连接必须收尾。
- 取消只走回滚，不因放行 gate 误提交；顺序由 Promise 屏障控制，不使用固定延时。

### 3. 失败路径回归（驱动方法替身）

`backend/src/usecases/local-runtime/upload-race-runner.spec.ts` 由 6 项扩展到 **11/11 通过**，每项在 `finally` 中断言无活动事务或至少无 `release(active=true)`，不依赖断言成功才收尾：

| 场景                                   | 结果                                                             |
| -------------------------------------- | ---------------------------------------------------------------- |
| 回滚抛错                               | 调用 `databaseConnection.destroy`，不发生 `release(active=true)` |
| 回滚与销毁同时失败                     | 原始错误、回滚错误、销毁错误均保留                               |
| 第二次 `createRunner()` 同步抛错       | 第一分支取消、零提交，全部收尾后才拒绝                           |
| 第二连接 `connect` 失败                | 第一分支取消回滚释放；第二连接不执行关闭                         |
| 第二连接 `startTransaction` 失败       | 第一分支取消；第二连接按已连接状态释放                           |
| 第二连接事务已激活后启动抛错           | 按驱动状态回滚；回滚失败则销毁且不归池                           |
| 驱动无法安全断连                       | 明确报告“驱动未暴露可销毁的独占连接”，不普通归池                 |
| 回滚成功但释放失败                     | 原始错误与释放错误均保留                                         |
| 第一分支等待期间被取消（等待竞争失败） | 不死等、不提交，取消后回滚并释放                                 |
| 正常竞争                               | 原有提交顺序与登记回调行为保持                                   |

### 4. 消费者与定向验证

执行器全部调用方已核对：上传任务并发规格、管理员启停并发规格直接使用；维修报告并发规格不使用该执行器。定向运行：

| 规格                                                                  | 结果                |
| --------------------------------------------------------------------- | ------------------- |
| `upload-race-runner.spec.ts`                                          | 11/11               |
| `local-runtime.concurrency.integration.spec.ts`（上传任务）           | 4/4                 |
| `admin-set-user-status.concurrency.integration.spec.ts`（管理员启停） | 10/10               |
| 合计                                                                  | **25/25，退出码 0** |

集成规格在隔离库 `lithography_e2e` 运行；为满足本地安装身份的既有前置，临时插入 `local_installation id=1` 并登记，运行后按精确 ID 删除，核验 `local_installation`、上传任务、账号、资料、组织、成员、机型、工单、报告均为 0。

静态与配套验证：

| 验证                                                          | 结果                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`（build + tools）                          | 通过                                                                                                    |
| `tsc -p tsconfig.spec.json --noEmit`                          | 通过                                                                                                    |
| 变更文件 ESLint                                               | 0 error（`preserve-caught-error` 已通过附加 `cause` 修复）                                              |
| Prettier                                                      | 变更的 3 个代码文件全部符合（仓库 `format` 脚本仅覆盖 `src`/`test` 下的 `.ts`，验收文档不在其检查范围） |
| `lint:architecture-fixtures` / `lint:usecase-normalize-guard` | 通过                                                                                                    |

### 5. 完整 core（KEEP 保留模式）

```bash
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_DB_CLEANUP=0 E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:core
```

| 指标     | 结果                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| 开关生效 | 日志确认 `skipDbCleanup=true, allowDbCleanup=false`、白名单 `lithography_e2e`、`⏭️ 已跳过 MySQL 全库清理`，无 TRUNCATE    |
| 规格     | **51/51 通过，0 失败**                                                                                                    |
| 用例     | **721 total / 714 passed / 0 failed / 7 skipped**（按本轮日志重新统计；跳过仍全部来自既有 `e2e-pr0-acceptance` 条件跳过） |
| 退出码   | **0**                                                                                                                     |
| 日志     | `/tmp/s5b-core.log`                                                                                                       |

KEEP 构成：显式 ID 990001，标记 `KEEP_R7_*`，覆盖六张表各一行，另含文件哨兵 `/tmp/s5b-keep-file.txt`；运行前全库快照 `/tmp/s5b-snapshot-before.json`（35 张表 31 行），KEEP 快照 `/tmp/s5b-keep-before.json`。

运行后核验（`/tmp/s5b-verify-after.json`）：

| 检查项                                    | 结果                                               |
| ----------------------------------------- | -------------------------------------------------- |
| KEEP 六行全字段                           | 六表各 1 行，逐字段不变                            |
| KEEP 引用计数                             | ACTIVE 归属 / 组织工单 / 客户工单 / 型号工单均为 1 |
| KEEP 文件哨兵 SHA-256                     | 不变（`b1dc5f7e7eb1…`）                            |
| `migrations`                              | 31 条内容不变，迁移文件 31 个不变                  |
| 全库行数                                  | 运行后 35 张表 37 行（= 31 条迁移 + 6 行 KEEP）    |
| 业务表除 KEEP 外残留                      | 0                                                  |
| 显式 ID 区间残留（`>= 900000` 且非 KEEP） | 账号/组织/机型/工单/上传任务均为 0                 |

收尾：单事务逐行 `FOR UPDATE` 核验六行与回收快照一致、引用闭包无账本外行后，按子表→父表精确删除并删除文件哨兵；回收后全库回到 35 张表 31 行（仅 `migrations`），与运行前快照逐表摘要完全一致，`migrations` 与迁移文件均不变。临时预置/核验/回收脚本已删除，**未使用 Seed、整表清理或 KEEP 删除后重跑**。

### 6. 证据边界

- 本节区分三层证据：驱动方法替身生命周期单测、真实 MySQL 并发规格、KEEP 保留模式完整 core。三者互不替代。
- 定向与完整 core 均运行于未提交工作区（HEAD `e4dca620c25cc994033d4a28f87a81a05c688070` 之上的统一候选）；第十一轮及更早结果仅作历史保留。
- `test:e2e:worker` / `test:e2e:smoke` 与未启用的集成规格不在本轮范围。
- 以上均为修复方实测，本轮未进行独立复审。
- 本轮未暂存、未 commit、未 push、未回复 PR、未合并。

## 2026-10-31 第十三轮：专用清理器入向引用预检与管理员写授权顺序

本轮只修两处阻塞：维修申请专用清理器的入向引用预检，与管理员写操作「先授权、再转换目标资料」的顺序。**未改 Entity、Migration、角色或前端**。前文各节完整 core 结果属于历史证据，不能替代本节在新代码上的结果。

### 1. P0｜冻结范围

- 分支 `feat/maintenance-data-increment`，HEAD `eb0619a3bb772424a8b39d00012d8c6e89f6b5f8`（`fix(account): enforce organization boundaries and safe e2e teardown`）；全部改动位于其上未提交工作区。
- 未提交共 8 个已修改文件、0 个未跟踪文件；迁移文件仍 31 条，本轮未新增或改写迁移。
- PR 身份（2026-11-01 重新查询，替代本行旧表述）：本分支的 PR 位于 fork 仓库 `GandianTX/lithography-platform`，即 **PR #2（OPEN）**，URL `https://github.com/GandianTX/lithography-platform/pull/2`，base `main`，head 为 `eb0619a3bb772424a8b39d00012d8c6e89f6b5f8`（与本地 HEAD 一致）；上游仓库 `litho-ai-support/lithography-platform` 当前没有任何本分支对应的 PR（按 fork head 查询为空）。旧文中的「PR #21 / 另一条已 CLOSED 分支」编号不再作为默认事实。
- 两个专用清理入口（`backend/test/06-repair-request/repair-request-fixture.ts`）：`cleanupRepairRequestFixtureResidue()`（按专属标记解析）与 `cleanupRepairRequestFixtureByIds()`（按调用方传入的归属集合）；两者都经 `assertFixtureDeleteTarget` → 单连接单事务 → `resolveAndVerifyFixture()` → `deleteVerifiedFixture()`。
- 三个管理员写操作及其直接消费者：`adminUpdateUserProfile` → `AdminUpdateUserProfileUsecase`；`adminSetUserStatus` → `AdminSetUserStatusUsecase`；`adminResetUserPassword` → `AdminResetUserPasswordUsecase`；三者共用 `loadWritableAdminUserTarget()`。
- `check:entity-scope` 经薛确认不适用于本数据库增量 PR，记录为「经确认不适用」，不记为检查通过。

### 2. P1｜维修申请专用清理器补齐入向引用预检

- 两个入口共用 `resolveAndVerifyFixture()`，`assertNoExternalInboundReferences()` 在同一事务、首次 DELETE 之前执行；核验失败整批拒绝，不认领集合外记录、不扩大删除集合。
- 入向引用覆盖（按当前外键）：账号段（`content_submission*`、`engineer_registration_application`、`ai_conversation.request_id` / `engineer_account_id`、`ai_report`）；组织段（`maintenance_report.owner_organization_id`）；型号段（`maintenance_report.equipment_model_id`）；工单段（`maintenance_report.repair_request_id`、`maintenance_report_version/review/attachment` 闭包）以及 `reference_document`、`local_installation`、`material_submission_detail`、`fault_case_submission_detail`。新增 `maintenance_report` 及 AI 会话/报告等本轮新增表。
- 回归（`repair-request-fixture-ownership.e2e-spec.ts`，**22/22**）：
  - 残留入口：外部 AI 会话 + 维护报告同时引用夹具行 → `/归属校验/` 失败关闭，`DELETE=0`，夹具与两行外部记录逐字段 `toEqual` 不变；
  - 按 ID 入口：外部 AI 会话引用夹具申请 → 同样失败关闭且零删除；
  - 后序删除失败：临时注入 `BEFORE DELETE ON base_user_info` 触发器后，两个入口均整批回滚，夹具逐字段不变；触发器在 `finally` 中删除，随后受保护清理并核验零残留与哨兵不变。
  - 负例外部行只在本轮创建成功后登记，`finally` 中经 `deleteRecordedExternalRow` 按已记录 ID 与指纹核验后删除。
- 四个消费者实跑：`repair-request-read` 39/39、`repair-request-accept` 18/18、`repair-request-production-input` 13/13、`repair-request-fixture-ownership` 22/22，合计 **92/92**，退出码均为 0。

### 3. P2｜管理员写入先授权，再转换目标资料

`loadWritableAdminUserTarget()` 顺序调整为：

```text
锁定目标 → 解析操作者可信组织 → 核验目标同组织成员事实 → 读取并转换 AdminUserView → 原业务断言与更新
```

- 保留先锁后读；组织与成员查询都在取得 `SELECT ... FOR UPDATE` 之后、在事务内执行，未提前建立锁前快照。
- 目标不存在、正常外组织、资料缺失外组织、角色异常外组织统一为 `TARGET_NOT_FOUND`（对外 NOT_FOUND），不再因 `READ_FAILED` / `ROLE_DATA_INCONSISTENT` 先于归属校验而泄露目标状态。
- 同组织目标的资料缺失或角色异常仍保留原有失败关闭语义；未使用 catch-all 改写内部异常；字段白名单、角色保护与幂等规则未变。
- 单测（三个 usecase spec，**3 suites / 148 passed**）使用真实 `AdminUserQueryService` + `toAdminUserView()` 转换与真实角色策略，新增/覆盖：同组织正常写入与回读提交、锁定 → 组织 → 成员 → View 的顺序断言、外组织/不存在一致拒绝、同组织资料缺失与角色异常保留原错误码。

### 4. P3｜组合与真实接口回归

真实 GraphQL E2E（`admin-user-management.e2e-spec.ts`，**35/35**）新增：

| 目标条件                   | 三个写操作预期                                                                                          | 结果 |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ---- |
| 存在但外组织（无成员关系） | 统一 `NOT_FOUND` / `ADMIN_USER_TARGET_NOT_FOUND`，`details` 为空，目标逐字段不变，列表按 keyword 查不到 | 通过 |
| 操作者无有效组织成员关系   | 统一 `FORBIDDEN` / `ORGANIZATION_NO_ACTIVE_MEMBERSHIP`，目标零变化                                      | 通过 |

- 既有「目标不存在」「正常同组织」「异常同组织保留原错误语义」「SUPER_ADMIN 目标只读」与启停幂等/`updatedAt` 用例继续通过，未放宽断言。
- 操作者组织歧义受 `uk_organization_membership_active_account` 库级约束限制，真实库无法构造，保留由 `admin-reset-user-password.usecase.spec.ts` 的 `ORGANIZATION_AMBIGUOUS_MEMBERSHIP` 单测覆盖。

### 5. P4｜统一验证与收口

| 检查                   | 命令/范围                                                | 结果                  | 退出码 |
| ---------------------- | -------------------------------------------------------- | --------------------- | ------ |
| 类型检查               | `npm run typecheck`（build + tools）                     | 通过                  | 0      |
| 相关单测               | 三个管理员 usecase spec                                  | 3 suites / 148 passed | 0      |
| 变更文件 ESLint        | 8 个变更 TS 文件                                         | 0 error               | 0      |
| Prettier               | 同上 8 个文件                                            | 全部符合              | 0      |
| 架构门禁               | `lint:architecture-fixtures`                             | passed                | 0      |
| 构建                   | `npm run build`（含 capability docs check）              | 通过                  | 0      |
| 专用清理负例与四消费者 | ownership 22 + read 39 + accept 18 + production-input 13 | 92/92                 | 0      |
| 管理员真实接口         | `admin-user-management.e2e-spec.ts`                      | 35/35                 | 0      |

完整 core 在同一稳定候选、独占隔离库 `lithography_e2e` 上从头运行，目标库 KEEP 保留模式（全局清库关闭，物理清理许可与所有权守卫保留）：

```bash
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_DB_CLEANUP=0 E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:core
```

| 指标     | 结果                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| 开关生效 | 日志确认 `skipDbCleanup=true, allowDbCleanup=false`、白名单 `lithography_e2e`、`⏭️ 已跳过 MySQL 全库清理`，无 TRUNCATE |
| 规格     | **51/51 通过，0 失败**                                                                                                 |
| 用例     | **726 total / 719 passed / 0 failed / 7 skipped**（跳过仍全部来自既有 `e2e-pr0-acceptance` 条件跳过）                  |
| 退出码   | **0**                                                                                                                  |
| 日志     | `/tmp/e2e-core-r8.log`                                                                                                 |

KEEP 构成：显式 ID 990001、标记 `KEEP_R8_*`，覆盖 `base_user_account` / `base_user_info` / `organization` / `organization_membership` / `equipment_model` / `repair_request` 六行，另含文件哨兵 `/tmp/e2e-keep-file-r8.txt`（SHA-256 `c2e4226fbf2a5643a6d12dc4759b2cc41a764f4a23cff21c31a2c039bb6a7a47`）；运行前快照 `/tmp/e2e-keep-r8-before.json`（全库 35 张表计数、六行全字段、引用计数、31 条迁移）。

运行后核验（`/tmp/e2e-keep-r8-after.json`，`ok=true`）：

| 检查项                                    | 结果                                               |
| ----------------------------------------- | -------------------------------------------------- |
| KEEP 六行全字段                           | 六表各 1 行，逐字段不变                            |
| KEEP 引用计数                             | ACTIVE 归属 / 组织工单 / 客户工单 / 型号工单均为 1 |
| KEEP 文件哨兵 SHA-256                     | 不变                                               |
| `migrations`                              | 31 条内容与顺序不变                                |
| 业务表除 KEEP 外残留                      | 35 张表逐表回读，非 KEEP 表均为 0                  |
| 显式 ID 区间残留（`>= 900000` 且非 KEEP） | 账号/组织/机型/工单/上传任务均为 0                 |

收尾（`/tmp/e2e-keep-r8-reclaim.json`，`ok=true`）：单事务逐行 `FOR UPDATE` 核验六行全字段与回收快照一致、引用计数一致后，按子表→父表精确删除并删除文件哨兵；回收后六表均为 0、`migrations` 仍为 31，全库只剩 `migrations`。**未使用 Seed、整表清理或 KEEP 删除后重跑**；临时预置/核验/回收脚本已删除。

### 6. 提交审计（未提交）

- 候选范围：8 个已修改代码文件（`admin-reset-user-password.usecase.spec.ts`、`admin-set-user-status.usecase.spec.ts`、`admin-update-user-profile.usecase.spec.ts`、`admin-user-write-support.ts`、`admin-user-management.e2e-spec.ts`、`repair-request-fixture-ownership.e2e-spec.ts`、`repair-request-fixture.ts`、`admin-user.fixture.ts`）+ 本记录；HEAD 仍为 `eb0619a3`。
- 本轮未暂存、未 commit、未 push、未回复 PR、未合并；`git diff --check` 无空白问题。
- 既有迁移演练与结构契约证据按影响沿用（迁移未受影响），本轮未重跑。
- 独立复审仍未进行；本节结果均为修复方实测。

## 2026-11-01 第十四轮：文档库专用清理入口事务化、报告详情先授权、触发器对象所有权

本轮按最小修复计划执行 P1–P5。**未改 Entity、Migration、角色与前端**；继续在 `feat/maintenance-data-increment` 上叠加并保留既有未提交修复；本轮未自动暂存、commit、push、回复 PR 或合并。

### 1. 基线与 PR 身份（当前事实重新查询）

- 分支 `feat/maintenance-data-increment`，HEAD `eb0619a3bb772424a8b39d00012d8c6e89f6b5f8`（`fix(account): enforce organization boundaries and safe e2e teardown`）；全部改动位于其上**未提交工作区**。
- 未提交范围：**19 个已修改文件 + 2 个未跟踪文件**（`backend/src/modules/lithography/queries/maintenance-report.query.service.spec.ts`、`backend/test/utils/e2e-trigger-ownership.ts`）。
- 迁移文件仍 **31 条**，与上一轮一致；本轮未新增或改写迁移，历史迁移演练与结构契约证据按影响沿用、未重跑。`check:entity-scope` 仍按薛确认口径记为「经确认不适用」，不记为检查通过。
- PR 身份（2026-11-01 `gh` 重新查询，替代历史编号）：fork 仓库 `GandianTX/lithography-platform` 的 **PR #2（OPEN）**，URL `https://github.com/GandianTX/lithography-platform/pull/2`，base `main`，head `eb0619a3bb772424a8b39d00012d8c6e89f6b5f8`；上游 `litho-ai-support/lithography-platform` 按 fork head 查询无对应 PR。旧文「PR #21 / 另一条已 CLOSED 分支」不再作为默认事实。
- **本节所有测试结果均产生于未提交工作区**，不能表述为 PR head 远端 SHA 已通过 CI，也不等于薛一审 / 负责人二审通过。

### 2. P1｜文档数据库专用清理入口

按入口分别核对，六类入口互不代证：

| 类别       | 入口                                   | 删除依据                                         |
| ---------- | -------------------------------------- | ------------------------------------------------ |
| 普通       | `cleanupAdminDocumentFixtureResidue()` | 专属标记定位 + 逐字段核验                        |
| 普通       | `cleanupAdminDocumentFixtureByIds()`   | 调用方持有的本轮实际 ID                          |
| 普通       | `runAdminDocFixtureTeardown()`         | 收尾包装，先判 `shouldRunAdminDocFixtureCleanup` |
| production | `cleanupProductionFixtureResidue()`    | 专属标记定位 + 完整归属核验                      |
| production | `cleanupProductionFixtureByIds()`      | 本轮记录的动态 ID                                |
| production | `cleanupProductionSentinelChain()`     | 哨兵链本轮记录 ID（先子后父）                    |

- 每个写删 helper 在首条语句前自校验 `E2E_ALLOW_PHYSICAL_CLEANUP=1`、`E2E_ALLOWED_DB_NAMES` 白名单与预期库一致；不因调用方已检查而省略入口校验。
- 入向引用预检在**同一事务、首次 DELETE 之前**逐表统计，覆盖新增表的实际入向引用：
  - 账号：`content_submission*`、`engineer_registration_application`（申请人与审核人）、`organization_membership`、`ai_conversation.engineer_account_id`、`ai_report.engineer_account_id`、`engineer_response`（客户与工程师）、`maintenance_report` 的负责人 / 创建人 / 更新人三列、`maintenance_report_version`、`maintenance_report_attachment`、`maintenance_report_review`、`reference_document` 的创建人与更新人。
  - 型号：`maintenance_report`、`reference_document`、`material_submission_detail`、`fault_case_submission_detail`。
  - 工单：`ai_conversation`、`ai_report`、`engineer_response`、`maintenance_report`。
- production 三个入口的预检与整批删除在同一 `EntityManager` 事务内：`assertManagerOnExpectedE2eDatabase` → 引用预检 → 子表→父表删除（申请 → 型号 → `user_info` → `account`）；前序删除不会独立提交，后序失败整批回滚。
- 外部记录只会导致**拒绝**：既不认领，也不进入待删除集合，更不扩大删除范围；空 ID 集合为 no-op，不开启删除事务。

各入口定向实库验证（隔离库 `lithography_e2e`，独占、开跑前仅含 31 条迁移、业务行 0、触发器 0）：

| 套件                                                       | 覆盖                                                                                                                                        | 结果  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `repair-request-fixture-ownership.e2e-spec.ts`             | 外部引用时残留 / 按 ID 两入口首次 DELETE 前拒绝（`DELETE=0`）；正常清理、重复执行 no-op；后序失败整批回滚；夹具与外部记录逐字段不变；无残留 | 26/26 |
| `admin-document-database-production-ownership.e2e-spec.ts` | 两个入口与哨兵包装的固定主键碰撞、外部维修报告引用、后序失败整批回滚、连续两轮无残留                                                        | 16/16 |
| `admin-document-database-cleanup-failure.e2e-spec.ts`      | 守卫拒绝零 DELETE、预检与删除同事务、中途失败整批回滚、收尾错误不吞                                                                         | 17/17 |
| `admin-document-database-fixture-ownership.e2e-spec.ts`    | 普通入口：固定 ID 碰撞、同名异主、外部申请与维修报告引用、造数中途失败只回收已登记行、连续两轮                                              | 13/13 |

新增的真实库后序失败用例（本轮）：

- 「后序失败：残留与按 ID 两个入口都整批回滚」：在 `base_user_info` 上注入本轮唯一 `BEFORE DELETE` 触发器，两个入口均 reject，夹具与外部快照逐字段不变，收尾后触发器零残留。
- 「哨兵包装入口：后序失败同样整批回滚」：哨兵链四个快照值逐字段不变，触发器零残留。

### 3. P2｜报告详情先授权，再读取完整内容

- QueryService 新增只读入口 `readReportOwnership()`：只 `select` 报告主键、负责人账号、所属组织三个字段，不触发任何报警 / 步骤 / 附件 / 版本 / 审核查询；并新增 `MaintenanceReportReadScope` 作为详情读取的第二道范围谓词（`ownerOrganizationId`，本人入口另加 `maintenanceEngineerAccountId`）。
- `get-my-maintenance-report.usecase.ts`：角色与 ID 断言 → 读最小归属事实 → 不存在、负责人非本人、组织不一致统一返回原有 `NOT_FOUND` → 通过后才调用 `readReportDetail(..., scope)`；详情查询继续携带组织与本人谓词，不只依赖第一次检查。
- `get-maintenance-report-review-detail.usecase.ts`：角色与 ID 断言 → 读最小归属事实 → 组织不一致返回 `NOT_FOUND` → 通过后才按组织范围读取完整详情。
- 合法可见目标缺版本时保留原数据异常语义 `DATA_INCONSISTENT`，未被 catch-all 降级为 `NOT_FOUND`。
- 契约只新增模块层类型与只读方法，未新增 GraphQL 字段、Resolver 或测试专用公开接口。

单测（驱动层替身，真实用例与 QueryService 组合）：

| 套件                                       | 用例                                                                                                                                                                                     | 结果  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `maintenance-report.query.service.spec.ts` | 只读三字段、不存在返回 null、无 / 有 scope 的 where 构造、范围外根查询为空且不触发内容查询                                                                                               | 6/6   |
| `maintenance-report-usecases.spec.ts`      | 本人详情 8 例 + 审核详情 8 例：不存在、正常外组织、异常外组织、同组织他人、正常本人、异常本人、`DATA_INCONSISTENT` 透传、非角色在读取归属前拒绝；断言不可见目标未调用 `readReportDetail` | 8 + 8 |
| 合计                                       | 两个套件                                                                                                                                                                                 | 50/50 |

当前无公开 API，因此未做 GraphQL 层回归；获准后补实库回归。以上为内部真实用例与 QueryService 的替身证据，不能替代真实数据库结果。

### 4. P3｜触发器故障测试的对象所有权

- 新增共享工具 `backend/test/utils/e2e-trigger-ownership.ts`（唯一实现，spec 不再自带重复版本）：`assertTriggerNameFormat`、`readOwnedTriggerFact`、`createOwnedTrigger`、`disposeOwnedTrigger`、`runWithOwnedTrigger`、`assertNoTriggerCaseFailures`。
- 名称：`e2e_<标签>_<pid>_<序号>_<时间戳>`，带格式校验；先查 `information_schema.TRIGGERS` 同名对象，命中即**拒绝创建**；CREATE 明确成功后才登记本轮对象事实（名称 + 定义 + 所属表）。
- 删除：无条件 `DROP TRIGGER IF EXISTS`，且只删除「本轮确认创建且定义匹配」的对象；外部同名触发器定义不变。
- 注入、断言与收尾统一保护：主错误、触发器收尾错误及夹具清理错误分别保留，失败时以 `AggregateError` 汇总、互不吞没。
- 明确 `MySQL 触发器 DDL 隐式提交`：事务回滚不会删除触发器，必须以对象所有权收尾。

回归用例（`repair-request-fixture-ownership.e2e-spec.ts` 真实库）：

- 同名碰撞：创建前失败关闭，外部同名对象定义完全不变。
- 创建失败：失败关闭且该名称零残留。
- 安装后中途断言失败：本轮触发器仍被精确收尾，夹具清理错误独立保留。
- 收尾失败：错误被单独保留，重试后本轮对象零残留。

DDL 用例执行条件：仅在隔离库 `lithography_e2e`（本轮独占；开跑前 35 张表、31 条迁移、业务行 0、`information_schema.TRIGGERS` 为空）执行；运行后 `TRIGGERS` 仍为空。

### 5. P5｜统一验证

静态检查（全部在未提交工作区）：

| 检查            | 命令                                        | 结果           |
| --------------- | ------------------------------------------- | -------------- |
| 类型检查        | `npm run typecheck`（build + tools）        | 通过，退出码 0 |
| 规格类型检查    | `npx tsc -p tsconfig.spec.json --noEmit`    | 通过，退出码 0 |
| 变更文件 ESLint | 17 个变更 TS 文件，无 `--fix`、无 `--cache` | 0 error        |
| Prettier        | 同上 17 个文件 `--check`                    | 全部符合       |
| 架构门禁        | `npm run lint:architecture-fixtures`        | passed         |
| 用例门禁        | `npm run lint:usecase-normalize-guard`      | passed         |
| 构建            | `npm run build`（含 capability docs check） | 通过，退出码 0 |
| 空白检查        | `git diff --check`                          | 无空白问题     |

相关单测：报告详情 2 套件 **50/50**；账号写操作 3 套件 **148/148**。

定向实库回归（含直接消费者，退出码均为 0，合计 **183/183**）：

| 套件                                                           | 结果  |
| -------------------------------------------------------------- | ----- |
| `repair-request-fixture-ownership.e2e-spec.ts`                 | 26/26 |
| `admin-document-database-production-ownership.e2e-spec.ts`     | 16/16 |
| `admin-document-database-cleanup-failure.e2e-spec.ts`          | 17/17 |
| `admin-document-database-fixture-ownership.e2e-spec.ts`        | 13/13 |
| `admin-document-database.e2e-spec.ts`（直接消费者）            | 12/12 |
| `admin-document-database-production.e2e-spec.ts`（直接消费者） | 29/29 |
| `repair-request-read.e2e-spec.ts`（直接消费者）                | 39/39 |
| `repair-request-accept.e2e-spec.ts`（直接消费者）              | 18/18 |
| `repair-request-production-input.e2e-spec.ts`（直接消费者）    | 13/13 |

完整 core 在同一未提交候选、独占隔离库 `lithography_e2e` 上从头运行，目标库 KEEP 保留模式：

```bash
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_DB_CLEANUP=0 E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:core
```

| 指标     | 结果                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------- |
| 开关生效 | 日志确认 `skipDbCleanup=true, allowDbCleanup=false`、白名单 `lithography_e2e`、`⏭️ 已跳过 MySQL 全库清理` |
| 规格     | **51/51 通过，0 失败**                                                                                    |
| 用例     | **734 total / 727 passed / 0 failed / 7 skipped**（跳过仍为既有 `e2e-pr0-acceptance` 条件跳过）           |
| 退出码   | **0**                                                                                                     |
| 日志     | `/tmp/e2e-core-r9.log`                                                                                    |

KEEP 构成：显式 ID 990001–990006，标记 `KEEP_R9_*`，覆盖 `base_user_account` / `base_user_info` / `organization` / `organization_membership` / `equipment_model` / `repair_request` 六行；文件哨兵 `/tmp/e2e-keep-file-r9.txt`（SHA-256 `2299cbda2622d41b1356e1e91cfbb4d763099774577fc1e2f858f9b8f4b94a3c`）。运行前快照 `/tmp/e2e-keep-r9-before.json`：35 张表、31 条迁移、六行全字段、引用计数（ACTIVE 归属 / 组织工单 / 客户工单 / 型号工单各 1）。

运行后核验（`/tmp/e2e-keep-r9-after.json`）：

| 检查项                | 结果                               |
| --------------------- | ---------------------------------- |
| KEEP 六行全字段       | 六表各 1 行，逐字段不变            |
| KEEP 引用计数         | 四项均为 1，不变                   |
| KEEP 文件哨兵 SHA-256 | 不变                               |
| `migrations`          | 31 条，内容与顺序不变              |
| 业务表除 KEEP 外残留  | 35 张表逐表回读，非 KEEP 表均为 0  |
| 触发器                | `information_schema.TRIGGERS` 为空 |

收尾（`/tmp/e2e-keep-r9-reclaim.js`）：单事务逐行 `FOR UPDATE` 核验六行全字段与运行前快照一致、引用计数一致后，按子表→父表精确删除并删除文件哨兵；回收后业务行全部为 0、`migrations` 仍为 31、`TRIGGERS` 为空。最终只读快照 `/tmp/e2e-snapshot-r9-final.json` 指纹 `c43e001e0766c47971cdce64aa1a831ebcc34ae5877b055b8184cea361364b5b`，与定向回归开跑前基线完全一致。**未使用 Seed、整表清理或 KEEP 删除后重跑**；一次性预置 / 快照 / 回收脚本位于 `/tmp` 且已删除，仓库内无新增脚本。

### 6. 证据分层

- 替身单测：报告详情两套件 50/50、账号写操作三套件 148/148（驱动层替身，不代表真实库）。
- 真实数据库：本机隔离库 `lithography_e2e` 上的定向回归 183/183 与完整 core 51/51；开跑前与收尾后的全库快照指纹一致，夹具与触发器零残留。
- 历史沿用：迁移链、24→31 / 30→31 升级演练、结构契约与既有并发套件结果按影响沿用，本轮未重跑；迁移未受影响。
- 未执行：独立复审；报告详情的实库 / 公开 API 回归（当前无公开 API，且未为测试新增接口）；`test:e2e:worker`、`test:e2e:smoke`。

### 7. 待负责人裁定（本轮不改权限）

1. 管理员文档库概览中的**全局工单与 AI 聚合读取口径**：现实现按库内真实全局口径统计（申请排除 `deprecated`、AI 计全量、参考资料按管理员组织范围）。是否应收窄为管理员所属组织范围，需负责人明确；本轮不擅自改权限。
2. **工程师注册申请是否允许跨公司管理员审核**：现尚无明确口径，等待负责人裁定；本轮不混入技术修复，未改动相关用例与权限。

### 8. 提交审计（未提交）

- 候选范围：19 个已修改文件 + 2 个未跟踪文件 + 本记录；HEAD 仍为 `eb0619a3`。
- 本轮未暂存、未 commit、未 push、未回复 PR、未合并。
- 既有迁移演练与结构契约证据按影响沿用；独立复审仍未进行，本节结果均为修复方实测。

## 2026-11-01 第十五轮：触发器创建即登记、生产夹具事实验权与 DELETE=0 独立计数

本轮延续同一分支与既有未提交修复，只关闭附件中的两项 P2 缺陷与一项测试证据缺口（本节记为 P1 / P2 / P3）。**未改业务权限、Entity、Migration 与前端**；未自动暂存、commit、push、回复 PR 或合并。

### 1. 基线与证据边界

- 分支 `feat/maintenance-data-increment`，HEAD 仍为 `eb0619a3`；未提交范围仍为 19 个已修改文件 + 2 个未跟踪文件（`maintenance-report.query.service.spec.ts`、`e2e-trigger-ownership.ts`）+ 本记录。
- 迁移文件仍 31 条，本轮未新增或改写；迁移历史与迁移文件通过完整库快照逐字段比对确认不变。
- 本节所有结果均产生于**未提交工作区**，不代表 PR head 远端 SHA 通过 CI，也不等于任何人工复审通过。

### 2. P1｜触发器 CREATE 成功后立即登记

- `backend/test/utils/e2e-trigger-ownership.ts`：
  - `CREATE TRIGGER` 明确成功的**下一行**同步构造本轮登记记录并写入 tracker（名称 / 目标表 / 注入体），`fact` 先为 `null`；登记发生在任何元数据回读与函数返回之前。
  - 创建后的回读纳入统一 `try` 保护：回读抛错时，传入 tracker 的调用方保留登记记录，交由统一收尾；未传 tracker 的直接调用方按名称精确清理后再抛出**原始错误**。
  - 销毁前重新读取当前对象，核验名称、目标表与可核实定义（优先已回读事实，回读失败时用调用方注入体）；不匹配即抛「阶段=归属校验 拒绝删除」，不因“登记存在”盲删可能被替换的同名对象。
  - 无法完成安全核验的记录保留在 tracker，并显式报告「触发器待收尾残留」，不返回假零残留。
  - `runWithOwnedTrigger` 分阶段保留：夹具造数错误、触发器创建错误、主错误、触发器收尾错误、触发器待收尾残留、夹具清理错误；后一阶段不覆盖前一阶段，`assertNoTriggerCaseFailures` 以 `AggregateError` 汇总。
- DDL 只在 `E2E_ALLOW_PHYSICAL_CLEANUP=1` + 库名白名单双门禁通过后执行；不依赖事务回滚撤销 `CREATE TRIGGER`（MySQL DDL 隐式提交）。

补充回归（`admin-document-database-production-ownership.e2e-spec.ts`，真实库）：

| #   | 场景                                                     | 断言                                                     |
| --- | -------------------------------------------------------- | -------------------------------------------------------- |
| 1   | CREATE 成功、首次 `information_schema.TRIGGERS` 回读抛错 | 登记记录仍可追踪，受保护收尾可执行，对象零残留           |
| 2   | 主流程失败且销毁失败                                     | 主错误与触发器收尾错误同时完整保留                       |
| 3   | 触发器收尾与夹具清理同时失败                             | 两类错误均可见，不互相吞没                               |
| 4   | 同名外部对象已存在 / 登记后对象被外部替换                | 创建前失败关闭；收尾拒绝删除，零误删，外部定义逐字节不变 |
| 5   | 正常完成 / 中途断言失败                                  | 本轮触发器零残留、夹具零残留，残留记录为空               |

实现细节：回读失败由代理 DataSource 注入（先放行同名预检 1 次，再对 `information_schema.TRIGGERS` 查询抛错），避免误伤创建前预检。

### 3. P2｜生产夹具按事实验证所有权

`admin-document-database-production-fixture.ts`：

- 新增创建登记事实：`ProductionAccountFact` / `ProductionModelFact` / `ProductionRepairRequestFact` 与 `ProductionFixtureOwnership.createdFacts`；`seedProductionFixtureAccounts` / `seedProductionFixtureBusiness` 在写入成功后按 ID 登记显式身份字段（登录名、邮箱、状态、身份提示、客户、接单人、接收状态等）与关系。
- `verifyRegisteredOwnership(manager, helper, database, workers, facts)` 在**同一事务**内执行：
  1. 每个待删除 ID 必须存在本轮创建登记事实，缺失即「没有本轮创建登记事实，无法核验归属，拒绝删除」；
  2. 按 ID 读取当前行并与登记事实**逐字段**对照，任一不符即「当前行与创建登记不符，拒绝删除」；
  3. 行已不存在则跳过（支持重复清理幂等）；
  4. 返回**两个独立集合**：`targets`（调用方待删除 ID 经核验保留的部分）与 `verified`（本次实际核验通过的行），不再让同一集合兼任两者。
- `cleanupProductionFixtureByIds` 与 `cleanupProductionSentinelChain` 两个入口均先 `assertDeletableTarget` → 事务内 `assertManagerOnExpectedE2eDatabase` → 按登记事实验权 → 才生成删除计划（申请 → 型号 → `user_info` → 账号）。
- 哨兵入口的登记事实由 `PRODUCTION_SENTINEL` / `SENTINEL_ACCOUNT_CONFIG` / `PRODUCTION_SENTINEL_MODEL_SPEC` / `PRODUCTION_FIXTURE_MARKERS.sentinelRequestNo` 与调用方本轮 ID 构造；申请存在但缺账号/型号 ID 时直接拒绝。
- `cleanupProductionFixtureResidue` 同样走 `resolveOwnedRows → verifyRegisteredOwnership → 独立 targets → deleteOwnedRows`；自然标记、固定 ID 与账号 ID 都不再单独作为归属证明。
- 数据库守卫、外部引用预检与事务保护保持不变。

两个入口的字段漂移回归（真实库，逐字段前后快照）：

| 入口                             | 漂移对象 | 结果                                                     |
| -------------------------------- | -------- | -------------------------------------------------------- |
| `cleanupProductionFixtureByIds`  | 账号     | 首次 DELETE 前拒绝，DELETE=0；原目标与外部记录逐字段不变 |
| `cleanupProductionFixtureByIds`  | 型号     | 同上                                                     |
| `cleanupProductionFixtureByIds`  | 工单     | 同上                                                     |
| `cleanupProductionSentinelChain` | 账号     | 同上                                                     |
| `cleanupProductionSentinelChain` | 型号     | 同上                                                     |
| `cleanupProductionSentinelChain` | 工单     | 同上                                                     |

每例在拒绝后恢复登记一致的字段，再验证正常清理零残留、连续执行幂等；后序失败整批回滚由既有触发器注入用例与 `admin-document-database-production.e2e-spec.ts` 连续两轮回收用例覆盖。

### 4. P3｜DELETE=0 的独立断言

- 所有权负例改用 `jest.spyOn(EntityManager.prototype, 'delete')` 统计**实际删除通道**（`Repository.delete` 内部即 `manager.delete`），而不是监视一个未必被经过的 Repository 方法。
- 每例同时断言：`deleteSpy.mock.calls` 长度 **0**，且漂移前后目标行与外部记录快照**逐字段不变**。
- 明确区分：快照不变只能排除“删除后又恢复”的巧合，不能单独证明零删除（事务回滚同样会恢复数据），因此两项断言必须同时存在。

### 5. 验证与证据

静态检查（未提交工作区）：

| 检查            | 命令                                            | 结果                         |
| --------------- | ----------------------------------------------- | ---------------------------- |
| 类型检查        | `npm run typecheck`（build + tools）            | 通过，退出码 0               |
| 规格类型检查    | `npx tsc -p tsconfig.spec.json --noEmit`        | 通过，退出码 0               |
| 变更文件 ESLint | 本轮 4 个变更测试文件，无 `--fix`、无 `--cache` | 0 error                      |
| Prettier        | 同上 4 个文件 `--check`                         | 全部符合                     |
| 架构门禁        | `npm run lint:architecture-fixtures`            | passed                       |
| 能力文档门禁    | `npm run capability:docs:check`                 | passed                       |
| 构建            | `npm run build`                                 | 通过，退出码 0               |
| 单测            | `npm run test:unit`                             | 127 suites / 1564 tests 通过 |

`npm run check:entity-scope` 仍失败：该脚本比较 `origin/main...HEAD`，而本分支历史提交已包含受保护目录改动，属**历史沿用条件**，与本轮工作树无关，不记为检查通过。

定向实库回归（独占隔离库 `lithography_e2e`，退出码均为 0，合计 **114/114**）：

| 套件                                                       | 结果  | 说明                           |
| ---------------------------------------------------------- | ----- | ------------------------------ |
| `admin-document-database-production-ownership.e2e-spec.ts` | 29/29 | 含本轮新增 13 例 P1/P2/P3 回归 |
| `admin-document-database-cleanup-failure.e2e-spec.ts`      | 17/17 | 替身适配创建登记事实           |
| `repair-request-fixture-ownership.e2e-spec.ts`             | 26/26 | 触发器 helper 直接消费者       |
| `admin-document-database-production.e2e-spec.ts`           | 29/29 | 生产夹具直接消费者             |
| `admin-document-database-fixture-ownership.e2e-spec.ts`    | 13/13 | 普通入口直接消费者             |

完整 core 在统一候选上从头运行，目标库 KEEP 保留模式（全局清库关闭，物理清理许可与所有权守卫保留）：

```bash
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_DB_CLEANUP=0 E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:core
```

| 指标     | 结果                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| 开关生效 | 日志确认 `skipDbCleanup=true, allowDbCleanup=false`、白名单 `lithography_e2e`、已跳过全库清理   |
| 规格     | **51/51 通过，0 失败**                                                                          |
| 用例     | **747 total / 740 passed / 0 failed / 7 skipped**（跳过仍为既有 `e2e-pr0-acceptance` 条件跳过） |
| 退出码   | **0**                                                                                           |
| 日志     | `/tmp/e2e-core-r10.log`                                                                         |

KEEP 与不变证据：

- KEEP 构成：显式 ID 990001–990006，标记 `KEEP_R10_*`，覆盖 `base_user_account` / `base_user_info` / `organization` / `organization_membership` / `equipment_model` / `repair_request` 六行；文件哨兵 `/tmp/e2e-keep-file-r10.txt`（SHA-256 `ce4773d75f79605345dfa6ab450b5e14788c3ab0515129192289a4e4aa9399e8`）。
- 运行前快照 `/tmp/e2e-r10-before.json`：35 张表、37 行（31 条迁移 + 6 行 KEEP），整库摘要 `1dfc8db3…4d4b`。
- 运行后快照 `/tmp/e2e-r10-after.json`：与运行前**整库摘要完全相同**（`1dfc8db3…4d4b`），逐表逐字段一致。

| 检查项                | 结果                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| KEEP 六行全字段       | 六表各 1 行，逐字段不变（`KEEP_ROWS OK`）                            |
| KEEP 引用计数         | ACTIVE 归属 / 组织工单 / 客户工单 / 型号工单均为 1（`KEEP_REFS OK`） |
| KEEP 文件哨兵 SHA-256 | 不变（`ce4773d7…99e8`，`KEEP_FILE OK`）                              |
| `migrations`          | 31 条，内容与顺序不变                                                |
| 业务表除 KEEP 外残留  | 0（整库仅 KEEP 六行 + 迁移 31 行）                                   |
| 触发器                | `information_schema.TRIGGERS` 为空                                   |

收尾（`/tmp/e2e-keep-r10.js`，一次性脚本）：单事务逐行 `FOR UPDATE` 核验六行、四项引用计数与账本外引用均为 0 后，按子表→父表精确删除并删除文件哨兵；回收后快照 `/tmp/e2e-r10-final.json` 摘要 `387cbfea…6249`，与运行前基线 `/tmp/e2e-r10-baseline.json`（35 张表 / 31 行 / 触发器 0）**完全一致**，KEEP 文件已删除。**未使用 Seed、整表清理或 KEEP 删除后重跑**；一次性预置 / 快照 / 回收脚本位于 `/tmp`，使用后已删除，仓库内无新增脚本。

### 6. 证据分层

- 替身复现：`cleanup-failure` 的守卫拒绝、事务中途失败、错误不吞等路径使用 mock DataSource；本轮为其补齐创建登记事实后方可复现“事实验权”路径。
- 真实数据库：`lithography_e2e` 上的定向回归 114/114 与 KEEP 保留模式完整 core 51/51；开跑前后整库摘要一致，夹具与触发器零残留。
- 历史沿用：迁移链、结构契约、既有并发套件结果按影响沿用，本轮未重跑；迁移未受影响。
- 未执行：独立复审；报告详情的实库 / 公开 API 回归（当前无公开 API，且未为测试新增接口）；`test:e2e:worker`、`test:e2e:smoke`。

### 7. 待负责人裁定（本轮不改权限，沿用上一节）

1. 管理员文档库概览中的全局工单与 AI 聚合读取口径是否应收窄为管理员所属组织范围。
2. 工程师注册申请是否允许跨公司管理员审核。

### 8. 提交审计（未提交）

- 候选范围：19 个已修改文件 + 2 个未跟踪文件 + 本记录；HEAD 仍为 `eb0619a3`。
- 本轮未暂存、未 commit、未 push、未回复 PR、未合并；等修复者完成最终审计后再决定提交范围。
- `check:entity-scope` 失败为分支历史沿用条件，提交说明中需如实注明，不得表述为“全部门禁通过”。

## 2026-11-01 第十六轮：可追踪成为强制前提

### 1. 变更范围

- P1：`e2e-trigger-ownership.ts` 的 `tracker` 改为**必需参数**（创建与两个收尾入口一致），在任何 DDL（含同名预检查询）之前做运行时校验；删除“无 tracker 时按名称 DROP、吞异常”的整个回退分支。
- CREATE 明确成功后**下一行同步登记**本轮创建事实，不等回读成功；回读抛错时记录保留，由统一受保护收尾按注入体核验后精确删除。
- 所有销毁只经过既有定义核验路径（名称 / 目标表 / 当前定义匹配）+ `DROP TRIGGER IF EXISTS`；未新增第二套销毁实现。
- 包装入口 `runWithOwnedTrigger` 的 `tracker` 同步改为必需，移除“未传入时自行创建”的可选路径；回读、销毁、待收尾残留、夹具清理各阶段错误继续分别保留。
- P2：调用清单以全仓搜索为准，全部实际入口均已适配，无 `tracker?` 可选参数、无按名称裸 DROP 回退：
  - `repair-request-fixture-ownership.e2e-spec.ts`：2 个包装入口与 4 处直接入口；
  - `admin-document-database-production-ownership.e2e-spec.ts`：7 个包装入口与 6 处直接入口。
  - 必须直接调用的生命周期测试均在 CREATE 之前建立 tracker 并进入 try/finally；同名碰撞负例同样传 tracker。
- 生产夹具所有权修复沿用第十五轮结论，本轮不返工。

### 2. 直接入口异常回归（替身直接执行实际 helper）

| 场景                         | 工单规格 | production 规格 | 验收结果                                       |
| ---------------------------- | -------- | --------------- | ---------------------------------------------- |
| 缺少 tracker                 | 新增     | 新增            | CREATE 前拒绝，`stub.calls` 为空（零 DDL）     |
| CREATE 成功、回读失败        | 新增     | 新增            | 记录保留且 `fact=null`，仍可受保护收尾         |
| 回读失败、DROP 失败          | 新增     | 新增            | 两个原始错误与待收尾记录均保留，恢复后收尾成功 |
| 同名对象被替换、回读失败     | 新增     | 新增            | 定义核验拒绝，调用记录中无 DROP（零误删）      |
| 触发器收尾成功后夹具清理失败 | 既有     | 新增            | 仅报告 `夹具清理错误`，tracker 为空、零残留    |
| 恢复后再次受保护收尾         | 新增     | 新增            | 本轮对象与夹具零残留                           |

故障测试自身的最终收尾均不依赖断言成功；真实 DDL 仅在获准的独占隔离库 `lithography_e2e` 上执行。

### 3. 定向验证（真实隔离库）

| 套件                                                       | 结果  | 说明                    |
| ---------------------------------------------------------- | ----- | ----------------------- |
| `repair-request-fixture-ownership.e2e-spec.ts`             | 29/29 | 含 3 例新增直接入口回归 |
| `admin-document-database-production-ownership.e2e-spec.ts` | 33/33 | 含 4 例新增失败阶段回归 |
| `admin-document-database-cleanup-failure.e2e-spec.ts`      | 17/17 | 替身直接消费者，无回归  |

合计 **79/79**，退出码均为 0。

### 4. 静态门禁与构建

`npm run typecheck`、`npx tsc -p tsconfig.spec.json --noEmit`、改动文件 ESLint 与 Prettier、`lint:architecture-fixtures`、`capability:docs:check`、`npm run build` 全部通过。

### 5. 完整 core（KEEP 保留模式）

统一候选上从头运行，全局清库关闭，物理清理许可与所有权守卫保留：

```bash
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_DB_CLEANUP=0 E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:core
```

| 指标     | 结果                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 开关生效 | 日志确认 `skipDbCleanup=true, allowDbCleanup=false`，白名单 `lithography_e2e` |
| 规格     | **51/51 通过，0 失败**                                                        |
| 用例     | **754 total / 747 passed / 0 failed / 7 skipped**                             |
| 退出码   | **0**                                                                         |
| 日志     | `/tmp/e2e-core-r11.log`                                                       |

KEEP 与不变证据：

- KEEP 构成：显式 ID 990001–990006，标记 `KEEP_R11_*`，覆盖 `base_user_account` / `base_user_info` / `organization` / `organization_membership` / `equipment_model` / `repair_request` 六行；文件哨兵 `/tmp/e2e-keep-file-r11.txt`（SHA-256 `de5d40d4…1d6e17`）。
- 运行前快照 `/tmp/e2e-r11-before.json`、运行后快照 `/tmp/e2e-r11-after.json`：**整库摘要完全相同**（`49f7a5dc…75cf`）。

| 检查项                | 结果                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| KEEP 六行全字段       | 六表各 1 行，逐字段不变（`KEEP_ROWS OK`）                            |
| KEEP 引用计数         | ACTIVE 归属 / 组织工单 / 客户工单 / 型号工单均为 1（`KEEP_REFS OK`） |
| KEEP 文件哨兵 SHA-256 | 不变（`KEEP_FILE OK`）                                               |
| `migrations`          | 31 条，内容与顺序不变（`MIGRATIONS OK`）                             |
| 业务表除 KEEP 外残留  | 0（`RESIDUE OK`）                                                    |
| 触发器                | `information_schema.TRIGGERS` 为空（`TRIGGERS OK`）                  |

收尾（一次性脚本 `/tmp/keep-r11.js`，已删除）：单事务逐行 `FOR UPDATE` 核验六行、四项引用计数与账本外引用均为 0 后，按子表→父表精确删除并删除文件哨兵。回收后快照 `/tmp/e2e-r11-final.json` 摘要 `3418e695…ff0e`，与运行前基线 `/tmp/e2e-r11-baseline.json` **完全一致**（35 张表 / 31 条迁移 / 触发器 0）。未使用 Seed、整表清理或 KEEP 删除后重跑。

### 6. 证据分层与本轮边界

- 替身复现：新增直接入口回归以替身 DataSource 直接执行实际 helper，覆盖 tracker 缺失、回读失败、DROP 失败、同名替换与仅夹具清理失败。
- 真实数据库：`lithography_e2e` 上定向 79/79；KEEP 保留模式完整 core 51/51；开跑前后整库摘要一致，夹具与触发器零残留。
- 历史沿用：迁移链、结构契约、并发套件结果未重跑；生产夹具所有权修复沿用第十五轮已确认结论。
- 未执行：独立复审；`test:e2e:worker`、`test:e2e:smoke`。
- 提交审计：本轮不暂存、不 commit、不 push、不回复 PR、不合并；`check:entity-scope` 失败仍为分支历史沿用条件，不得表述为“全部门禁通过”。

## 2026-11-01 第十七轮：成功回读不得认领替换对象

### 1. 变更范围

- 仅改触发器 helper、两份 ownership 规格及本记录；未改业务代码、Entity 或 Migration。
- `createOwnedTrigger` 的创建核验从“表名匹配”收紧为**名称 / 目标表 / 规范化定义**三项匹配：回读成功但定义不同即视为同名替换，抛 `阶段=创建核验` 错误。
- 登记记录保留 CREATE 时注入的原始定义，`record.fact` 仅在核验通过后补齐；不以当前定义回填预期，后续收尾按原始预期核验，不匹配即拒绝删除。
- 两份规格中的真实资源直接调用全部改为“建立 tracker → CREATE 之前进入 try → 全部断言 → finally 按 `tracker.remaining()` 受保护收尾”；不以创建成功返回值作为收尾依据，主错误与收尾错误分别保留。

### 2. 新增回归

| 场景                                    | 规格               | 验收结果                                            |
| --------------------------------------- | ------------------ | --------------------------------------------------- |
| CREATE 成功 → 同名对象被替换 → 回读成功 | production 回归 4c | 创建核验拒绝；原始预期不变；DROP=0；替换对象保留    |
| 创建成功后前置断言失败                  | production P2 回归 | finally 仍按 tracker 收尾，对象零残留               |
| 同名碰撞首次创建未正常返回              | production 回归 4a | finally 按 tracker 收尾，tracker 清零               |
| 工单创建失败（表不存在）                | 工单创建失败用例   | CREATE 前进入保护，finally 无记录可收尾，名称零残留 |

替换场景的收尾坚持“无法安全核验时保留记录并报告，不盲删”：原记录在替换对象存在期间始终保留，替换对象仅由本用例已知定义走受保护收尾。

### 3. 定向与静态验证

| 验证                                                       | 结果                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| `admin-document-database-production-ownership`             | 35/35                                                |
| `repair-request-fixture-ownership`                         | 29/29                                                |
| `npm run typecheck` / `tsc -p tsconfig.spec.json --noEmit` | 通过                                                 |
| 改动文件 ESLint / Prettier                                 | 通过                                                 |
| 调用清单复核                                               | 真实资源调用均在 CREATE 前进入保护，无保护范围外路径 |

定向合计 **64/64**，退出码 0。

### 4. 完整 core（KEEP 保留模式）

```bash
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_DB_CLEANUP=0 E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:core
```

| 指标     | 结果                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 开关生效 | 日志确认 `skipDbCleanup=true, allowDbCleanup=false`，白名单 `lithography_e2e` |
| 规格     | **51/51 通过，0 失败**                                                        |
| 用例     | **756 total / 749 passed / 0 failed / 7 skipped**                             |
| 退出码   | **0**                                                                         |
| 日志     | `/tmp/e2e-core-r12.log`                                                       |

KEEP 与不变证据：

- KEEP 构成：显式 ID 990001–990006，标记 `KEEP_R12_*`，覆盖六张表各 1 行；文件哨兵 `/tmp/e2e-keep-file-r12.txt`（SHA-256 `bea2969a…8de1`）。
- 运行前后快照 `/tmp/e2e-r12-before.json`、`/tmp/e2e-r12-after.json`：`KEEP_ROWS / KEEP_REFS / KEEP_FILE / MIGRATIONS / TRIGGERS / RESIDUE` 全部通过，整库摘要相同（`7c41a791…4f90`）。
- 回收后快照 `/tmp/e2e-r12-final.json` 摘要 `41e1ddef…e1e0`，与运行前基线 `/tmp/e2e-r12-baseline.json` **完全一致**（35 张表 / 31 条迁移 / 触发器 0）。
- 一次性脚本 `/tmp/keep-r12.js` 已删除；未使用 Seed、整表清理或 KEEP 删除后重跑。

### 5. 证据分层与本轮边界

- 真实数据库：两份 ownership 规格定向 64/64；KEEP 保留模式完整 core 51/51；运行前后整库摘要一致，夹具与触发器零残留。
- 历史沿用：迁移链、结构契约、并发套件结果未重跑；生产夹具所有权修复沿用第十五轮结论。
- 未执行：独立复审；`test:e2e:worker`、`test:e2e:smoke`。
- 提交审计：本轮不暂存、不 commit、不 push、不回复 PR、不合并；`check:entity-scope` 失败仍为分支历史沿用条件。

## 2026-11-01 第十八轮：触发器测试同类入口一次性收口

### 1. 变更范围

- 仅改触发器测试、必要 helper 与本记录；未改业务代码、权限、Entity 或 Migration。
- 工单同名碰撞用例：外部对象不再走裸 `CREATE TRIGGER`，改为在 CREATE 前建立 tracker 后调用统一 helper，回读与断言均在保护范围内，finally 按登记时的原始创建事实收尾。
- production 替换场景：原对象、替换对象分别持有 tracker 与登记事实；替换对象同样经统一 helper 创建；按实际创建阶段分别清理，每项独立 `try/catch`，前一项失败不阻断后续；主错误与各项收尾错误统一收集。
- 4c 的替换代理内部创建路径改为 helper 登记，不再有未登记的真实 DDL 创建。
- 新增回归：工单首次创建后回读失败；production 替换创建失败；production 主错误 + 两项收尾错误同时发生。

### 2. 触发器真实 DDL 入口清单

| 入口                                   | 创建事实 / 登记                           | 保护范围                   | 收尾与错误汇总                     |
| -------------------------------------- | ----------------------------------------- | -------------------------- | ---------------------------------- |
| `createOwnedTrigger`（唯一创建实现）   | CREATE 成功后下一行登记名称 / 表 / 注入体 | 调用方在 CREATE 前进入 try | 回读或核验错误原样抛出，记录保留   |
| `disposeOwnedTriggerRecord` / 包装收尾 | 仅按登记事实核验当前定义                  | 每项独立 `try/catch`       | 阶段错误逐项保留，不吞并           |
| production 4b / 4e 的裸 `DROP TRIGGER` | 模拟外部删除本轮对象，不产生新资源        | 后续替换创建经 helper 登记 | 原记录保留；替换对象按登记事实收尾 |
| production 替换代理                    | 代理内通过 helper 创建替换对象并登记      | 与直接入口一致             | 定义不匹配即拒绝删除，零误删       |
| 替身 DataSource 用例                   | 不产生真实 DDL，仅记录 SQL                | 不触库                     | 断言调用序列，不参与实库清理       |

### 3. 定向与静态验证

| 验证                                                       | 结果  |
| ---------------------------------------------------------- | ----- |
| `admin-document-database-production-ownership`             | 37/37 |
| `repair-request-fixture-ownership`                         | 30/30 |
| `npm run typecheck` / `tsc -p tsconfig.spec.json --noEmit` | 通过  |
| 变更文件 ESLint / Prettier / `git diff --check`            | 通过  |

定向合计 **67/67**，退出码 0。

### 4. 完整 core（KEEP 保留模式）

| 指标     | 结果                                                                 |
| -------- | -------------------------------------------------------------------- |
| 开关生效 | `skipDbCleanup=true, allowDbCleanup=false`，白名单 `lithography_e2e` |
| 规格     | **51/51 通过，0 失败**                                               |
| 用例     | **759 total / 752 passed / 0 failed / 7 skipped**                    |
| 退出码   | **0**                                                                |
| 日志     | `/tmp/e2e-core-r13.log`                                              |

KEEP 与不变证据：

- KEEP 构成：显式 ID 990001–990006，标记 `KEEP_R13_*`，六张表各 1 行；文件哨兵 `/tmp/e2e-keep-file-r13.txt`（SHA-256 `bba912c3…bd22`）。
- 运行前后快照 `/tmp/e2e-r13-before.json`、`/tmp/e2e-r13-after.json`：`KEEP_ROWS / KEEP_REFS / KEEP_FILE / MIGRATIONS / TRIGGERS / RESIDUE` 全部通过，整库摘要相同（`8da4f656…a7c3`）。
- 回收后快照 `/tmp/e2e-r13-final.json` 摘要 `41e1ddef…e1e0`，与运行前基线 `/tmp/e2e-r13-baseline.json` **完全一致**（35 张表 / 31 条迁移 / 触发器 0）。
- 一次性脚本 `/tmp/keep-r13.js` 已删除；未使用 Seed、整表清理或 KEEP 删除后重跑。

### 5. 证据分层与本轮边界

- 本轮结果属于**修复方自测**；独立复核尚未执行，不能表述为“已通过评审”。
- 真实数据库：两份 ownership 规格定向 67/67；KEEP 保留模式完整 core 51/51；运行前后整库摘要一致，夹具与触发器零残留。
- 历史沿用：迁移链、结构契约、并发套件结果未重跑。
- 未执行：独立复审；`test:e2e:worker`、`test:e2e:smoke`。
- 提交审计：本轮不暂存、不 commit、不 push、不回复 PR、不合并；`check:entity-scope` 失败仍为分支历史沿用条件。
