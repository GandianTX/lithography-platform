# S4 只读准备：交付核对、环境事实与实库执行方案（2026-11-08）

> 本轮只做只读核对与方案编制：未建库、未迁移、未 Seed、未写入夹具、未执行实库测试、未做 CREATE/DROP/TRUNCATE/DELETE、未备份恢复、未清理文件、未启停服务、未暂存/commit/push/PR。所有写库命令仅为方案，**未执行**。

## 1. 冻结候选

| 项                                                                     | 值                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 分支／HEAD                                                             | `feat/database-v13-deploy` / `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`    |
| HEAD 与 fork main                                                      | 一致（`72de1096`，S0 已核远端）                                            |
| 暂存区                                                                 | 空                                                                         |
| 工作区                                                                 | 27 个已跟踪修改 + 33 个未跟踪路径（见执行记录）                            |
| 既有 stash                                                             | 3 个，原样保留未触碰                                                       |
| 源码候选指纹（已跟踪修改 diff，限 src/scripts/test/package.json）      | SHA-256 `664ad89da69dd223beeec917f824f7c7ce4e7f74e91f39818a95acc03a5b094c` |
| 源码候选指纹（未跟踪 .ts 聚合：6 迁移＋部署工具＋spec＋entities 目录） | SHA-256 `f42b240f1b4d1bc47986a903dbf2aed6c43d7afbc81fe77e4da8416375d7b36c` |

> 文档（plans/）不参与源码候选指纹；指纹于 2026-11-08 本文档定稿时采集。

17 个新 Entity 逐文件指纹（SHA-256 前 12）：stored-file `b71d26dbc454`、repair-request-intake `0fb00f53a383`、intake-analysis-attempt `fa32fb97b2bd`、repair-process-entry `41e4ed591f85`、ai-message-analysis `232f7e82949e`、maintenance-report-fault `7d7e0c8d664a`、repair-request-revision `a47f8e790274`、reference-document-revision `4fad4ef469b5`、local-account-authorization `cf4bf62d2272`、local-company-setting `d17f26ef341f`、sync-receipt `cc22b0595839`、sync-conflict `245b1a087fc3`、record-package-import `634e4727ee38`、record-package-item `54821e90085b`、backup-asset `1dfdda9451a3`、backup-restore-run `5376f55ef0dd`、management-audit-event `fe397ea57860`。

**规则：S4 实库验证期间任何源码变化，须重新核对上述指纹并重新确认候选，不混用不同候选的结果。**

## 2. 前 31 条迁移内容核对

用 S0 §5 冻结的逐文件 SHA-256（前 16 位）逐一比对现文件：**31/31 全部一致，无一差异**。时间戳、文件名、数量与内容均未变。本轮 6 条新迁移（`1775501000000`—`1775501500000`）为纯追加。

## 3. OI-01/06/12/13 逐项核对

| 编号  | 计划推荐方案                                                | 代码实际（证据）                                                                                                                                                                                                                                                                                                                                                                                     | 结论                                                        |
| ----- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| OI-01 | 扩 CHECK 保留旧值＋AUTO/RETRY；不重写历史；读取层映射       | DB 层已实现：迁移 `1775501100000` 将 `chk_local_backup_run_trigger` 扩为 `SCHEDULED/MANUAL/AUTO/RETRY/USB_EXPORT`，无 UPDATE 历史行；Entity 同步。**读取层类型层已补齐**：`local-runtime.types.ts:7` 的 `LocalBackupTriggerType` 已扩为 5 值；`normalizeBackupTrigger` 用户输入白名单仍仅旧三值，AUTO/RETRY 为系统触发不接受客户端输入（G-1 已完成，纯替身单测通过）。**读取层业务映射语义仍待裁决** | 保持待确认；类型层缺口 G-1 已补齐，业务映射语义未自行决定   |
| OI-06 | 扩 CHECK 保留旧值；新写入只允许 DRAFT/SUBMITTED；不批量改写 | DB 层已实现：`chk_maintenance_report_status` 加 `SUBMITTED`、一致性 CHECK 同步扩展；现有写入 `submit-maintenance-report.usecase.ts:150` 仍写 `PENDING_REVIEW`（旧行为原样保留，未批量改写）。新写入路径属后续业务流，未实现                                                                                                                                                                          | 保持待确认；新写入路径为后续业务实现范围，不属结构缺口      |
| OI-12 | 业务绑定多态无 FK；应用层校验；按登记清理                   | 结构一致：`stored_file` 的 `business_type/business_id` 无 FK，仅 uploader/owner FK。**应用层校验无消费者、未实现**（属后续执行器）；**清理闭包已扩展覆盖 17 新表**（G-3 已完成，纯替身单测通过，含删除顺序/外部引用拒绝/回滚/幂等）                                                                                                                                                                  | 保持待确认；清理闭包 G-3 已补齐，应用层校验属后续执行器范围 |
| OI-13 | 默认 RESTRICT；record_package_item 经批准才可 CASCADE       | 17 张新表全部 FK 均为 `ON DELETE RESTRICT ON UPDATE RESTRICT`（含 `record_package_item`，CASCADE 未获批故保持 RESTRICT）；多态目标无 FK                                                                                                                                                                                                                                                              | 实现与推荐默认一致；保持待确认，不自行收口                  |

## 4. 267 行源设计到代码映射

- 机器校验：`migration-schema-contract.spec.ts` 15/15 通过——`REQUIRED_TABLES` 51（34+17），17 新表全部登记且绑定所属迁移；索引/FK/CHECK 定义完整自洽；前 31 条时间戳不变、V13 仅追加。
- 抽查：FK 删除策略（§3）、关键 CHECK（`chk_reference_document_content_source_v13`、提交幂等对、结单成对）、Entity 字段与迁移一致。
- 「沿用现有结构（无 DDL）」行（`engineer_response.resolution_status`、`local_installation`）有实际位置，非仅留说明。
- **不以「已列入清单」代替实现**：以下缺口单独登记（§6）。

## 5. 实库规格与部署工具核对

### 5.1 实库规格真实性

| 项                                                                   | 状态              | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incremental-migration.integration.spec.ts`                          | 存在              | 实库规格，双开关门控（`MIGRATION_INTEGRATION=1` + `MIGRATION_INTEGRATION_ALLOW_DESTRUCTIVE=1`），会清空重建 `lithography_e2e`；覆盖迁移工具本身                                                                                                                                                                                                                                                                                                                                             |
| S2-db-verification-specs.md 中 V13 唯一键/FK/CHECK/事务/清理逐条规格 | 已新增可执行 spec | `src/infrastructure/database/v13-db-verification.spec.ts`：49 个真实行为用例（S2 §2.1 14 项/§2.2 6 项/§2.3 23 项/§3 5 项全覆盖＋1 个强化用例；§4 实库清理验收待授权，由 G-3 替身先覆盖结构/顺序）；无占位验收；默认 `describe.skip` 不连库；启用需 `E2E_REAL_DB_SPECS=1` + `E2E_ALLOW_PHYSICAL_CLEANUP=1` + `E2E_REAL_DB_NAME`，启用后核验白名单/配置库名/实际 `DATABASE()`；显式要求但许可不全时模块级拒绝。**重写后本轮未运行（不沿用旧 10-skip 结果），仅 tsc 编译通过；实库断言待授权** |
| 不连库定向单测（契约/参数/映射解析）                                 | 存在              | `migration-schema-contract.spec.ts`、`database-deploy.spec.ts`（15/15 通过）；mock/静态通过不记为 MySQL 约束或真实 API 通过                                                                                                                                                                                                                                                                                                                                                                 |

### 5.2 部署工具只读检查（未运行）

| 要求                      | 证据（`database-deploy.ts` / `incremental-migration.ts`）                                                                             | 结论     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 显式配置/目标确认         | 必须 `--mode/--config-file/--database/--confirm-database`，两者不一致即失败                                                           | 满足     |
| 实际目标核验              | 连接后核对实际 `DATABASE()` 与服务器版本                                                                                              | 满足     |
| 互斥                      | upgrade 拒绝管理员参数；init/upgrade 分离                                                                                             | 满足     |
| 空库与脏库区分            | init 只接受空库或完整迁移库；非空无历史/未知对象/半迁移失败关闭（L191—261）                                                           | 满足     |
| pending 升级              | upgrade 仅运行 pending，不清库、不 drill、不伪造历史                                                                                  | 满足     |
| 重复执行                  | 完整终态校验后无变化返回；重复执行 0 条                                                                                               | 满足     |
| DDL 部分失败              | 复用 `runIncrementalMigration` 现场保存与诊断，不自动 down/DROP                                                                       | 满足     |
| 连接/锁收尾               | 复用迁移锁；收尾错误与主错并列（`getCleanupErrors`）                                                                                  | 满足     |
| `synchronize=false` 强制  | 部署配置强制                                                                                                                          | 满足     |
| `check:entity-scope` 边界 | 仅比较 `origin/main...HEAD` **已提交**差异；本轮 17 个新 Entity 与契约修改均未提交，**退出 0 不覆盖本轮变更**，不得记为该部分验证通过 | 边界确认 |

## 6. 缺口登记

| 编号 | 缺口                                                                                                                                                                | 影响                                                                            | 处置                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-1  | `LocalBackupTriggerType` 未含 AUTO/RETRY，读取层映射未实现                                                                                                          | 新值读取会被 `as` 静默误标                                                      | **已补齐**：类型扩为 5 值，用户输入白名单仍仅旧三值；`local-runtime.input.normalize.spec.ts` 纯替身通过。读取层业务映射语义仍待 OI-01 裁决                                                                                                                                                                                                    |
| G-2  | V13 约束/事务/清理无可执行实库 spec（仅 Markdown）                                                                                                                  | S4-D 无法直接执行                                                               | **已补齐**：`v13-db-verification.spec.ts` 可执行 spec（49 个真实行为用例，S2 §2.1/§2.2/§2.3/§3 全覆盖），默认跳过不连库，启用时核验许可/库名/DATABASE()，显式要求但许可不全即模块级拒绝。本轮重写后未运行（不沿用旧门控跳过结果），实库断言待授权执行                                                                                         |
| G-3  | `test/utils` 清理闭包/台账未覆盖 17 新表（grep 零命中）                                                                                                             | 新表残留无法被 scoped 清理感知                                                  | **已补齐**：`e2e-scoped-cleanup.ts` 扩展 17 表事实核验/引用闭包收集/按 FK 拓扑删除（主键与父列逐表对迁移核对，intake/attempt 等 int 主键为 `id`；父在范围子未登记即拒绝 DELETE=0，不自动扩图）；`e2e-scoped-cleanup.v13.spec.ts` 纯替身 28/28 通过（登记/事实漂移/外部引用拒绝/删除顺序/解环/删除失败回滚/幂等/静态契约）；实库清理验收待授权 |
| G-4  | 现有 30/31 态副本数据量极少（1 账号、1 公司、0 工单、0 报告），不构成「带数据」验收；旧工单回填场景无数据可验（OI-05 冻结集合未取得）                               | B/C 只能验结构与 pending 升级                                                   | 带数据验收需授权合成造数或提供真实快照；30/31 态源库继续只读，后续授权副本中按旧结构补合成业务数据（非真实历史库证据）                                                                                                                                                                                                                        |
| G-5  | Redis 共享实例 DB15 被 dev 与 e2e 共用；teardown 在 `.env.e2e` 下执行 FLUSHDB                                                                                       | core KEEP 的 Redis 收尾风险                                                     | KEEP 运行改用**独立端口、独立目录、仅绑定回环地址的临时实例**（本轮只写方案，不启动、不写配置密钥、不清空任何 Redis），不使用共享 DB14/15                                                                                                                                                                                                     |
| G-6  | OI-07 真实管理员映射清单未提供；新库无 organization 时管理员映射无落点                                                                                              | init 后管理员初始化无法直接执行                                                 | 真实映射为**正式上线前置**；S4 可使用明确标注的合成管理员、合成公司及等级映射，不默认创建真实账号、不输出密码                                                                                                                                                                                                                                 |
| G-7  | `check:entity-scope` 不覆盖未提交变更                                                                                                                               | 范围门禁对本轮为空转                                                            | 提交后重跑才有意义；本轮退出 0 不覆盖未提交 Entity/Migration                                                                                                                                                                                                                                                                                  |
| G-8  | 契约 `migration-schema-contract.ts` 中 `record_package_item` 两条外键 `referenceColumns` 写成 `['id']`，实际父表主键为 `package_id`/`receipt_id`                    | init/upgrade 终态校验必然失败，A—E 全部阻塞                                     | **已修复（第六轮）**：两条改为 `['package_id']`/`['receipt_id']`；新增 3 条 Entity 元数据回归（引用列可解析、构成主键/唯一键、父实体真实主键），全量外键无其他同类问题；`lithography_v13_init` 原地 verify 通过、重复 init 两次 0 迁移且快照一致（详见 `execution-log.md` 第六轮）                                                            |
| G-9  | 第 39 条历史回填把 `RUNNING/SUCCEEDED/PARTIAL`、条目 `SUCCEEDED` 回填 `PASSED`，但无旧消费者代码或 38 态检查事实可证                                                | 可能把“需求前提”误读为“历史已检查”审计事实                                      | 见 OI-15：**不擅改迁移**，登记为迁移假设；升级前导出受影响行并取得明确确认；审计要求可证明时另立最小迁移。                                                                                                                                                                                                                                    |
| G-10 | 部分 DDL 失败后，正式入口的 `inspectMigrationState` 会把已存在的新列识别为“疑似半迁移”并在升级前拒绝；无法在不改预检、不手工回退 DDL 的前提下证明“正式入口续跑成功” | C 场景只能证失败现场与失败关闭，不能证续跑                                      | 列为证据缺口：C2 只验证拒绝行为，不计为续跑通过；后续需单独裁决“受控续跑”最小方案（改预检/专用恢复工具/授权手工回退），本轮不实施。                                                                                                                                                                                                           |
| G-11 | 正式部署前“受影响历史记录冻结清单的导出/确认”无工具入口；第 39 条预检只在违规时输出定位 ID，不导出全部受影响行                                                      | 无法满足“先输出冻结清单并确认”的正式部署前置；合成 A/B 验收不能替代历史事实确认 | 登记为**正式上线前置缺口**：本轮不开发；正式部署前由 DBA/只读 SQL 导出冻结清单并写入变更单，确认后方可执行 `upgrade`；不得把本缺口当作迁移代码通过依据。                                                                                                                                                                                      |

## 7. 环境只读确认（2026-11-08，使用现有 `env/.env.*` 凭据，未输出秘密值）

### 7.1 MySQL 实例

| 项          | 值                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本        | 8.0.46-0ubuntu0.24.04.4                                                                                                                        |
| 地址        | 127.0.0.1:3306（单实例）                                                                                                                       |
| server_uuid | `909f9587-9fce-11f1-a353-00e0709ef3a9`                                                                                                         |
| 库清单      | information_schema/mysql/performance_schema/sys；`aigc_friendly`、`lab_manager`（**非本项目，任何操作不得触碰**）；7 个 lithography 库（下表） |

### 7.2 本项目库现状（只读 `migrations` 表与行数抽查）

| 库                                             | 迁移数 | max timestamp | 表数 | 数据量（抽查）              | 来源判定                               |
| ---------------------------------------------- | ------ | ------------- | ---- | --------------------------- | -------------------------------------- |
| `lithography_drill`                            | 30     | 1775401500000 | 35   | 1 账号/1 公司/0 工单/0 报告 | 开发 drill 库，30 态                   |
| `lithography_upgrade_drill_copy_20261030`      | 30     | 1775401500000 | 35   | 1 账号/1 公司/0 工单/0 报告 | 2026-10-30 演练副本，30 态带极少数据   |
| `lithography_drill_30to31_20261030`            | 31     | 1775401600000 | 35   | 1 账号/1 公司/0 工单/0 报告 | 2026-10-30 演练，30→31 升级产物        |
| `lithography_drill_rebuild24_20261030`         | 31     | 1775401600000 | 35   | —                           | 2026-10-30 演练，24 态正向重建产物     |
| `lithography_drill_rebuild24_restore_20261030` | 24     | 1775301900000 | 24   | —                           | 2026-10-30 演练，24 态恢复副本         |
| `lithography_e2e`                              | 31     | 1775401600000 | 35   | 全空（e2e 自造自清）        | e2e 隔离库，白名单默认库               |
| `lithography_e2e_keep`                         | 无     | 无            | 1    | `keep_sentinel` 2 行        | 仓库代码无引用；视为异主保留库，永不清 |

注意：`lithography_drill_30to31_20261030` 等库名中的 "30to31" 只代表历史演练动作，**不代表其仍是 30 态**；以 `migrations` 表实际历史为准。库名含 test/e2e 不作为安全依据，端口不单独证明实例专属——本轮以 server_uuid 锁定实例。

### 7.3 账号权限

`gandiantx`@`127.0.0.1`：`SELECT/INSERT/UPDATE/DELETE/CREATE/DROP/INDEX/ALTER/LOCK TABLES/TRIGGER/CREATE USER` 等近全量权限（`*.*`，主机限定 127.0.0.1）。部署所需 DDL、DML、`GET_LOCK` 权限充足；**该账号也能写非本项目库**，所有命令必须显式 `--database/--confirm-database` 锁定目标。

### 7.4 候选库占用

`lithography_v13_init`、`lithography_v13_up30`、`lithography_v13_up31`、`lithography_v13_spec`、`lithography_v13_verify`、`lithography_v13_core_keep` **均不存在**，未被占用。

### 7.5 Redis

- 7.0.15，127.0.0.1:6379，无认证；keyspace 全空（含 DB15）。
- dev 与 e2e 的 env 均指向同一实例 `REDIS_DB=15`；teardown 仅在 env 文件为 `.env.e2e` 时执行 FLUSHDB（`global-teardown-e2e.ts` 守卫）。
- 本轮未执行 FLUSHDB/SHUTDOWN，未启动服务。共享 Redis 不得清空。
- **DB14 不再表述为专用实例**：core KEEP 改用**独立端口、独立目录、仅绑定回环地址的临时 Redis 实例**方案（本轮只编写方案，不启动、不写配置密钥、不清空任何 Redis）。临时实例启动命令与目录隔离方案见 §8.E，授权后单独执行。

### 7.6 配置加载与守卫

- 应用：`ConfigModule.forRoot({ envFilePath: [env/.env.<NODE_ENV>, env/.env.development] })`；dotenv 默认**不覆盖**已存在的进程环境变量。
- 迁移/部署工具：`dotenv.parse` 只读文件、不注入进程环境；`--config-file` 显式指定，无隐式回落。
- E2E 库名白名单：`E2E_ALLOWED_DB_NAMES` 默认 `lithography_e2e`；`E2E_SKIP_DB_CLEANUP`/`E2E_ALLOW_DB_CLEANUP` 双开关控制全库清理。**新增部署库名须显式加入白名单或走独立配置，不为通过测试放宽守卫。**

## 8. S4 执行方案 A—E（全部未执行）

通用前置：同一冻结候选（§1 指纹）；执行账号 `gandiantx`@`127.0.0.1`；私密 env 文件放库外（建议 `/home/gandiantx/secure/lithography-v13-<场景>.env`，权限 600，含 `DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME/DB_TIMEZONE=+08:00/DB_SYNCHRONIZE=false`），模板见 `database-deploy.env.example`；任何一步出现非预期数据变化、授权不足、目标不明或半迁移，立即停止并报告。

### A. 正式新库 init ＋ verify ＋重复执行

| 项             | 内容                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实例/库        | 本实例新建 `lithography_v13_init`（当前不存在）                                                                                                                                              |
| 配置文件       | `/home/gandiantx/secure/lithography-v13-init.env`（DB_NAME=lithography_v13_init）                                                                                                            |
| 旧态来源       | 无（空库）                                                                                                                                                                                   |
| 需要授权的操作 | 建库（或由工具在空库校验后自建）、37 条迁移写入                                                                                                                                              |
| 命令           | `cd backend && npm run database:deploy -- --mode init --config-file /home/gandiantx/secure/lithography-v13-init.env --database lithography_v13_init --confirm-database lithography_v13_init` |
| 预期           | 37 条迁移全部执行；verify 0 issue；**立即重复执行同一命令返回「无变化」**                                                                                                                    |
| 保留核验       | 执行前后 `lithography_e2e_keep.keep_sentinel` 2 行、`aigc_friendly`、`lab_manager` 及其余 6 个 lithography 库的 `migrations` 计数不变                                                        |
| 清理           | 验收存证后 `DROP DATABASE lithography_v13_init`（需单独授权）                                                                                                                                |
| 管理员初始化   | 不在本项执行：新库无 organization，映射无落点（G-6）                                                                                                                                         |

### B. 30 态带数据副本升级

| 项             | 内容                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源库           | `lithography_upgrade_drill_copy_20261030`（30 态，1 账号/1 公司/0 业务行，2026-10-30 演练产物；**数据极少，G-4**）                                             |
| 目标           | 新建 `lithography_v13_up30`；`mysqldump` 源库导入副本（源库只读，不回写）                                                                                      |
| 配置文件       | `/home/gandiantx/secure/lithography-v13-up30.env`                                                                                                              |
| 需要授权的操作 | 建副本库、mysqldump 导出/导入、7 条 pending 迁移写入（原第 31 条 + 本次新增 6 条）                                                                             |
| 命令           | `npm run database:deploy -- --mode upgrade --config-file .../lithography-v13-up30.env --database lithography_v13_up30 --confirm-database lithography_v13_up30` |
| 预期           | 执行 `1775401600000`（第 31 条）＋ `1775501000000`—`1775501500000`（6 条 V13）共 7 条；verify 0 issue；重复执行 0 条；原 1 账号/1 公司行 id 与内容不变         |
| 保留核验       | 源库 `migrations` 保持 30 条；其余库不动                                                                                                                       |
| 清理           | 存证后 DROP `lithography_v13_up30`（需单独授权）                                                                                                               |
| 管理员初始化   | 可用合成管理员映射（登记为合成数据）验证工具幂等；真实映射仍为上线前置                                                                                         |

### C. 31 态带数据副本升级

- 同 B，源库改为 `lithography_drill_30to31_20261030`（31 态），目标 `lithography_v13_up31`，预期 pending 仅 6 条（`1775501000000`—`1775501500000`）、重复执行 0 条。源库只读，副本中按旧结构补合成业务数据以验证字段保留/关联/回填/重复升级（非真实历史库证据）。

### D. 定向实库约束／事务／清理规格

| 项       | 内容                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目标库   | 新建 `lithography_v13_spec`（由 init 建立）                                                                                                                                                                     |
| 前置     | G-2 可执行规格已就绪：`src/infrastructure/database/v13-db-verification.spec.ts`；逐条对应 S2 §2—§4；每条记录 SQL、预期错误码、`SHOW CREATE TABLE` 存证                                                          |
| 覆盖     | 14 条唯一键、6 条 FK/删除、24 条 NULL 安全 CHECK、5 条事务、清理入口顺序（G-3 扩展后）                                                                                                                          |
| 命令     | `E2E_REAL_DB_SPECS=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_REAL_DB_NAME=lithography_v13_spec E2E_ALLOWED_DB_NAMES=lithography_v13_spec npx jest src/infrastructure/database/v13-db-verification.spec.ts --runInBand` |
| 安全门   | 默认 `describe.skip` 不连库；启用后核验白名单、配置库名与实际 `DATABASE()` 一致才执行 SQL                                                                                                                       |
| 预期     | 全部拒绝/回滚行为符合规格表；非目标表零变化                                                                                                                                                                     |
| 清理     | 存证后 DROP 整库（需单独授权）；spec 内写入的造数行按登记清理                                                                                                                                                   |
| 停止条件 | 任一约束未被拒绝、出现非预期数据变化或半迁移，立即停止报告                                                                                                                                                      |

### E. KEEP 保留模式标准完整 core

| 项       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目标库   | `lithography_e2e`（白名单默认库；需先 upgrade 至 V13 终态——写操作需授权）                                                                                                                                                                                                                                                                                                                                                 |
| KEEP     | 在实际业务表预置 KEEP 行（异主账号/公司/工单/资料），不进入规格账本；`E2E_SKIP_DB_CLEANUP=true` 禁全库清理；结束后 KEEP 行全字段不变、正常 fixture 零残留、哨兵按独立账本回收                                                                                                                                                                                                                                             |
| Redis    | **独立端口、独立目录、仅绑定回环地址的临时 Redis 实例**（G-5）：不使用共享实例的 DB14/15；启动命令 `redis-server --port 16379 --bind 127.0.0.1 --dir /tmp/litho-v13-keep-redis --dbfilename dump.rdb`，KEEP env 指向 `REDIS_HOST=127.0.0.1 REDIS_PORT=16379 REDIS_DB=0`；teardown 因 env 文件非 `.env.e2e` 不 FLUSHDB；结束后 `redis-cli -p 16379 SHUTDOWN NOSAVE` 并删除临时目录。本轮只写方案，不启动、不清空任何 Redis |
| 命令     | `E2E_SKIP_DB_CLEANUP=true npm run test:e2e:core`（一次完整运行，分段补跑不算通过）                                                                                                                                                                                                                                                                                                                                        |
| 预期     | 全套件 passed/failed/skipped 统计与退出码齐全；前后非目标行/引用/文件及迁移摘要一致                                                                                                                                                                                                                                                                                                                                       |
| 保留核验 | `lithography_e2e_keep.keep_sentinel` 与其余库不变                                                                                                                                                                                                                                                                                                                                                                         |

## 9. 建议的最小授权文字（供用户确认后执行）

> 授权在 127.0.0.1:3306（server_uuid 909f9587-…）上：(1) 新建 `lithography_v13_init`、`lithography_v13_up30`、`lithography_v13_up31`、`lithography_v13_spec` 四个验证库，验证存证完成后由我确认再 DROP；(2) 用 mysqldump 从 `lithography_upgrade_drill_copy_20261030`、`lithography_drill_30to31_20261030` 导出并导入对应副本，源库只读，副本中按旧结构补合成业务数据（非真实历史库证据）；(3) 在 `lithography_e2e` 执行 V13 upgrade 并以 KEEP 模式运行完整 core；(4) 在 `lithography_v13_spec` 内做约束/事务/清理造数与按登记清理，含必要的临时 DDL 仅限该库；(5) 使用**明确标注的合成管理员、合成公司及等级映射**验证管理员工具，不使用真实账号密码、不输出密码；真实管理员映射为正式上线前置；(6) 将上述库名加入 `E2E_ALLOWED_DB_NAMES` 仅限对应测试进程；(7) Redis 使用**独立端口(16379)、独立目录、仅绑定回环地址的临时实例**，不使用共享实例 DB14/15，不清空共享 Redis。禁止触碰 `aigc_friendly`、`lab_manager`、`lithography_e2e_keep` 及任何未列名库。任何非预期变化立即停止并报告。

## 10. 本轮修改与检查

### 10.1 本轮修改文件

源码与测试：

- `src/modules/lithography/local-runtime.types.ts`：`LocalBackupTriggerType` 扩为 5 值（G-1）
- `src/usecases/local-runtime/local-runtime.input.normalize.ts`：`TRIGGER_TYPES` 用户输入白名单仍仅旧三值，注释 AUTO/RETRY 为系统触发（G-1）
- `src/usecases/local-runtime/local-runtime.input.normalize.spec.ts`：G-1 纯替身单测（G-1）
- `test/utils/e2e-scoped-cleanup.ts`：17 新表类别/台账/收集/按 FK 顺序删除（G-3）
- `src/infrastructure/database/e2e-scoped-cleanup.v13.spec.ts`：G-3 纯替身回归（28/28）
- `src/infrastructure/database/v13-db-verification.spec.ts`：G-2 可执行实库规格（默认跳过）

计划材料：

- `S4-pre-execution-precheck.md`（本文档）：迁移数校正、G-1/G-2/G-3 状态、Redis 临时实例方案、管理员映射口径、源库只读
- `S1-open-issues.md`、`execution-log.md`、`database-v13-deployment-plan.md`：状态同步

### 10.2 检查

- 正式/工具/spec 类型检查；G-1/G-3 纯替身单测；变更文件 ESLint、Prettier；架构门禁；后端构建；`git diff --check`。结果见执行记录。
- `check:entity-scope` 仅覆盖 `origin/main...HEAD` 已提交差异，退出 0 不覆盖本轮未提交 Entity/Migration。

## 11. 实库执行状态（2026-11-08 更新）

> 本节覆盖 §7.4「均不存在」与 §8 标题中的「全部未执行」表述；执行细节见 `execution-log.md` 第五—十轮。

| 项                     | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 候选                   | HEAD `72de1096…`；已跟踪 diff `632a84be…`（第十轮含 `test/utils/test-accounts.ts`）；37 条迁移指纹 `c4a2e480…`                                                                                                                                                                                                                                                                                                                                                                                              |
| `lithography_v13_init` | 已创建并完成 37 条迁移；第六轮 G-8 修复后 verify 通过、重复 init ×2 为 0 条；保留                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `lithography_v13_up30` | 已创建；B 完成：源 30 态只读导出/恢复一致、合成夹具 13 行、upgrade 7 条、verify 通过、重复 0 条、源库不变；保留                                                                                                                                                                                                                                                                                                                                                                                             |
| `lithography_v13_up31` | 已创建；C 完成：源 31 态只读导出/恢复一致、合成夹具 25 行、upgrade 6 条、verify 通过、重复 0 条、源库不变；保留                                                                                                                                                                                                                                                                                                                                                                                             |
| `lithography_v13_spec` | 已 init（37 迁移/51 业务表/verify 通过）。D 首跑 `kind='SERVICE'`→3819；二跑 `entities: []`→缺 `AccountEntity` 元数据；第十轮按方案 A 注册 `AccountEntity`/`UserInfoEntity`/`OrganizationEntity`（离线装配回归 2 项通过），三跑 `beforeAll` 成功、`Tests: 47 failed, 4 passed, 51 total`（退出 1），失败均为规格夹具/错误码期望与真实结构不一致。运行后残留 7 行/5 张表（组织 1、账号 2、资料 2、机型 1、报修 1），因跨账本 R01 拒绝与入向 FK 连锁，已保留现场未手工清理；结构/37 迁移/触发器不变；E 未执行 |
| 目标库雷区             | 未触碰 `lithography_e2e`、`aigc_friendly`、`lab_manager`、`lithography_e2e_keep`；未操作 Redis；未运行完整 core                                                                                                                                                                                                                                                                                                                                                                                             |
| 证据性质               | B/C 仅为**旧结构副本＋合成业务数据升级验证**，不是真实历史业务库完整验收                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 观察项                 | `ownership_status='PENDING'` 分支在真实旧数据中不可达（旧列 NOT NULL），未擅改迁移；两库 `migrations` 主键缺口为源库继承                                                                                                                                                                                                                                                                                                                                                                                    |

### 11.1 第十一轮更新（D 修复 / 精确收尾 / 复跑，覆盖上方 `lithography_v13_spec` 行）

> 上方表格中 `lithography_v13_spec` 行描述的是第十轮结束时（D3 失败、7 行残留）的状态，已被本轮结果覆盖；细节见 `execution-log.md` 第十一轮。`init/up30/up31` 行不变。

- 迁移指纹：当前 37 个迁移文件与冻结清单逐文件 **37/37 SHA-256 一致**；`638ee99d…` 是 37 行冻结清单文件自身哈希，`c4a2e480…` 是 `sha256sum` 全行聚合哈希，差异仅来自聚合容器/路径，无 Migration 内容变化。
- D3 残留 7 行：已用现有受保护入口 `runGuardedSpecCleanup`（同一事务内许可 + `DATABASE()` + 锁定 + 逐字段比对 + 入向闭包）精确删除；未直接 `DELETE`，未 ALTER 重置自增（`organization=7`、`base_user_account=13`、`base_user_info=13`、`equipment_model=5`、`repair_request=36`）。删除后快照回到 D3 运行前基线 `7ef8fd48…`。
- D4 残留 8 行：同一受保护入口补登修订子行归属事实后回收，回到基线。
- 复跑结果：D4 `23 failed / 28 passed`（退出 1，CHECK sqlState 期望错误）→ D5 `1 failed / 50 passed`（退出 1，JSON 缺键 CHECK 视为通过）→ **D6 `51 passed / 51 total`（退出 0；离线 2 + 真实库 49，真实库 failed=0 / skipped=0）**。
- D6 后复核：业务行、结构、37 条迁移、种子、触发器/视图/例程/事件均与基线一致；**非目标数据不变、本轮夹具零残留**；`hash=7ef8fd48…`。
- 静态检查：类型检查退出 0；纯替身规格 31 passed（含“提交子行后断言失败仍协同收尾”回归）；离线元数据 `2 passed, 49 skipped`；ESLint/Prettier/`git diff --check` 通过。
- 边界：未改 Entity/Migration/生产约束，未降断言/加 skip，未清库/DROP；未进入 E、管理员初始化、完整 core、Redis；未 commit/push；前三次失败历史保留。

**第十二轮补充（2026-11-08，D6 记录保留）**

- 定向回归 `2.4 JSON 快照版本契约`：实库 `6 passed / 2 failed / 51 skipped`，退出码 1。
- 发现两项真实约束缺陷：`repair_request_revision` 缺 `schema_version` 时 CHECK 以 NULL/UNKNOWN 放行；`reference_document_revision` 的 JSON null 因 `IS NOT NULL` 成立被放行。
- D6 的 `51 passed` 未覆盖“缺键 / JSON null”命题，不能据此声称版本必填已被保证。
- 未修改任何 Entity/Migration/约束；最小 NULL 安全修复方向已记录于 `execution-log.md` 第十二轮 §12.5，待裁决后另行实施。本轮停止，不进入 E。

**第十三轮补充（2026-11-08，第 38 条已在 `lithography_v13_spec` 执行并复验）**

- 追加迁移 `backend/src/infrastructure/database/migrations/1775501600000-fix-json-snapshot-version-checks-for-v13.migration.ts`；前 31 条已接受基线与前 6 条 V13 迁移均未修改，候选迁移总数由 37 变为 38。
- 修复对象：`repair_request_revision`（两侧键存在、非 JSON null、仍与独立列相等）、`reference_document_revision`、`sync_conflict`、`backup_restore_run`。不新增整数类型、版本范围或其他业务限制。
- 预检：任何 ALTER 之前逐表扫描缺键、JSON null、非法 JSON、等值不符及独立列 `< 1`；存在违规即失败关闭，只报告脱敏计数与定位 ID（最多 20 个），不删除、不自动补版本。
- 多表 DDL 可能部分提交；失败信息列出已完成/失败/未执行表，并说明 MySQL DDL 隐式提交、不能随迁移整体回滚，修复后可直接重跑（每表先探测约束是否存在，已重建表幂等 DROP/ADD）。
- Entity 与结构契约已同步：四表新增/更新 `@Check`，`migration-schema-contract.spec.ts` 断言两侧键守卫与原有等值要求；离线单测与契约 **20 passed**；类型检查、ESLint、Prettier、`git diff --check` 均通过。
- 边界：仅写入 `127.0.0.1:3306/lithography_v13_spec`（UUID `909f9587-9fce-11f1-a353-00e0709ef3a9`）；未修改 init/up30/up31，未 down、未清库；未 commit/push，未进入 E、完整 core、管理员初始化或 Redis。
- 实库执行结果：status 37 历史/38 仓库/1 pending → upgrade 仅执行第 38 条 → verify 通过；迁移历史 38，四表 CHECK 按目标表达式重建；前后快照仅迁移 +1 与四条 CHECK 变化，列/索引/外键/表选项/种子/业务行（2 行）不变。
- 实库回归：定向 2.4 共 **24 passed / 0 failed / 51 skipped**；全量 D 规格 **75 passed / 0 failed / 0 skipped**（真实库 73、离线元数据 2）；原先两条失败用例现按目标 CHECK 的 3819/HY000 拒绝。
- 幂等：再次 upgrade 输出“pending 0 条 / 无变化”；快照哈希保持 `2816bf8b807f58646d1d293787d9ba61d1164814923fdb351841f915dd41b3d8`；触发器 0、活动事务 0、g2 夹具残留 0；AUTO_INCREMENT 迁移前未采集计数器，迁移后 `reference_document_revision=7`、`repair_request_revision=18`（测试事务推进，未重置）。
- `record_package_import` 的格式版本来源仍待裁决（当前为 `manifest_json.$.schema_version` 存在性；设计字典另有独立 `format_version int unsigned`），本轮不新增独立列；详见 `execution-log.md` 第十三轮 §13.5、§13.9。

**第十四轮补充（2026-11-08，S4-E 实库清理专项完成；覆盖 §11 `lithography_v13_spec` 行中的“E 未执行”）**

- 覆盖检查结论：此前版本控制内**无** 17 表实库清理规格；`e2e-scoped-cleanup.v13.spec.ts` 仅为纯替身。新增 `src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts`，纳入 Jest 采集，默认 `describe.skip`（不建连）；显式 `E2E_REAL_DB_SPECS=1` 而 `E2E_ALLOW_PHYSICAL_CLEANUP=1`/`E2E_REAL_DB_NAME` 缺失时模块加载即抛错拒绝。
- 目标核验（只读）：`DATABASE()=lithography_v13_spec`、`server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`、白名单精确匹配；迁移历史 38；`triggers=0`、`innodb_trx=0`；种子 `organization=1`、`local_installation=1`，17 表与外部表均 0（无此前夹具）。
- 实库回归：**10 passed / 0 failed / 0 skipped，退出码 0**（连续两次，含证据运行）；纯替身 **29 passed / 0 failed，退出码 0**；默认门禁 **10 skipped，退出码 0**；仅设 `E2E_REAL_DB_SPECS=1` 时**明确拒绝，退出码 1**；`npm run typecheck` 与 spec 类型检查均退出 0。
- 覆盖：R01 未登记子行拒绝、R02 事实漂移拒绝、R03 集合外 `repair_request.intake_id` 引用拒绝、R04 17 表全量（9 个 int + 8 个 char(36) 主键、逐表 `affectedRows`、依赖顺序、合法解环）、R05 后序删除失败全回滚（1 次解环 UPDATE + 3 次 DELETE 均回滚）、R06 幂等（第二次全 DELETE 且 affected=0、无 UPDATE）、R07a/R07b 循环引用（合法解环 1 次；额外引用零解环零删除）、R08 多态 `stored_file` 业务列引用不自动认领、R09 非目标基线/迁移/触发器不变。
- 负例四项核对：破坏性调用次数、目标与外部记录逐字段快照不变、`innodb_trx=0`、连接池 `SELECT 1` 可用。
- 收尾：17 表/外部父表/账号/机型零残留；`S4E%` 扫描 0；`migrations=38`、`triggers=0`；前后快照哈希均 `2816bf8b807f58646d1d293787d9ba61d1164814923fdb351841f915dd41b3d8`；AUTO_INCREMENT 已采集未重置。
- 指纹：HEAD `72de1096…`（未 commit）；`git status --porcelain|sort|sha256sum`=`b6008e34…`（64 项）；作用域 diff `64188b70…`；未跟踪 `--exclude-standard` 聚合 `0e51ab19…`（47 项）；38 条迁移聚合 `624c4570…`；新增规格 `c403a81c…`。
- 尚未覆盖：状态机路径与多代次/多修订号、DEVICE 分支、多态 `business_type/business_id` 应用层语义、前旧链实库入口（目标为 `lithography_e2e`，本轮未运行）。
- `record_package_import` 格式版本来源仍待裁决，本轮未改表、未加列。
- 边界：仅写入 `127.0.0.1:3306/lithography_v13_spec`；未升级 init/up30/up31、未操作 Redis、未跑完整 core/管理员初始化、未 down/DROP/清库、未 commit/push。详见 `execution-log.md` 第十四轮。

**第十五轮补充（2026-11-08，第 39 条已在 `lithography_v13_spec` 定向升级并复验）**

- 前 38 条迁移逐文件指纹不变：聚合 `624c4570…f86d`；候选总数 38 → 39；仅新增 `1775501700000-add-record-package-check-and-import-result-states-for-v13.migration.ts`。
- 执行前核对：`DATABASE()=lithography_v13_spec`、`server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`；历史 38 / 仓库 39 / pending 1（仅第 39 条）；52 表、`package/item=0`、种子 `organization=1`、`local_installation=1`、`base_user_account=0`、`triggers=0`、`innodb_trx=0`，与 S4-E 收口基线一致。
- 历史回填依据（不把状态名称当证明）：功能 V5.3 R072 前置条件明确为“所选包及条目检查合格，确认范围明确”（段落 1803），操作流程为复核包版本→逐条去重/冲突→保存结果（1809—1812），且“检查合格不等于成功”（1811）。因此 `RUNNING/SUCCEEDED/PARTIAL` 隐含已进入导入阶段、条目 `SUCCEEDED` 隐含该条已写入，二者均以检查合格为前提；反向回填 `PASSED` 有文档依据。
- NULL 安全：包组合约束以 `COALESCE(check_status,'')` 消除 UNKNOWN，历史 `NULL` 只允许 `PENDING/FAILED`；条目组合约束 `result <> 'SUCCEEDED'` 在 `result IS NULL` 时为 UNKNOWN 但 `check_result=REJECTED` 分支显式要求 `result IS NULL`；`check_result=NULL` 时 `SUCCEEDED` 因第二支为 false 被拒绝。目标 CHECK 语句已从 `information_schema.check_constraints` 逐条核对。
- 备份：`/home/gandiantx/secure/lithography-v13/backups/lithography_v13_spec-pre39-20261108-192516.sql.gz`，`0600`、目录 `0700`，SHA-256 `779298b7…dcad`，`mysqldump` 退出码 0。
- 正式入口：`migration:status`（退出 0）→ `database:deploy --mode upgrade`（退出 0，仅第 39 条）→ `migration:verify`（退出 0）；终态 39 条、业务表 51 张。再次 upgrade 输出“pending 0 条 / 无变化”，退出 0。
- 结构变化：列 `+check_status`、`+check_result`、`result` NOT NULL→NULL；CHECK 净增 4 条（`check_stage`×2、`check_status`、`check_result`），重建 `manifest`（增加“键存在且非 JSON null”）与 `item_result`（增加 `CONFLICT`）；索引/外键/FK 规则/表选项/种子全部不变，业务行仅 `migrations 38→39`。
- 实库回归：定向 2.5 **12 passed / 0 failed / 75 skipped**；全量 D **87 passed / 0 failed / 0 skipped**；E 实库 **10 passed / 0 failed / 0 skipped**；E 纯替身 **29 passed / 0 failed**；均退出码 0。
- E 首跑曾出现 2 failed（如实保留）：R04 夹具仍以 `result='SUCCEEDED'` 且 `check_result=NULL` 插入，被新组合约束拒绝；R09 仍断言 38 条迁移。修正为夹具写 `check_result='PASSED'`、基线改为 39 后重跑 10/10；未放宽任何约束断言。
- 快照：升级前 `8c436bd6…`，升级后/二次升级后/最终均 `651861bf…`（内容完全一致，`FINAL_VS_POST_IDENTICAL=true`）；`triggers=0`、`innodb_trx=0`、17 表及外部表零残留。
- AUTO_INCREMENT：升级前后逐表记录无差异（`diff` 为空），未重置；`migrations` 计数器维持查询值 39。
- 未覆盖（spec 库为空且不可安全注入历史行）：历史非空行回填效果、违规行零 ALTER、跨表部分 DDL 失败后的实库续跑；仅由离线纯替身覆盖，不外推到其他库。
- 指纹：HEAD `72de1096…`（未 commit）；全 39 条迁移聚合 `8827ded2…707f`；工作区 `git status --porcelain` 聚合 `3c3c501c…`；未跟踪 `.ts` 聚合 `7c480d74…`。

**第十七轮补充（2026-11-08，S4 最终收口第一步；未写库）**

- E 规格 ESLint：`e2e-scoped-cleanup.v13.realdb.spec.ts` 不带 `--fix` 首跑 **8 errors / 0 warnings（退出 1）**，全部为 `@typescript-eslint/no-unnecessary-type-assertion`；逐项去掉冗余断言（2 处 Proxy/回调、2 处 query 结果、4 处 `snapshotRows` 元素），其中 query 结果改为 `query<Row[]>` 泛型。未用 `any`、未加 disable、未删断言/加 skip、未改 SQL/夹具/事务/错误汇总。复查 ESLint 0、Prettier 通过、spec tsc 通过；离线纯替身 57 passed（含 E 29）。
- 候选变化：HEAD `72de1096…` 不变；tracked diff `225a839b…`、作用域 diff `7916190b…`、39 条迁移聚合 `8827ded2…` 不变；未跟踪 `.ts` 由 36 项 `7c480d74…` 变为 37 项 `f1970540…`（新增迁移期规格）；工作区由 78 项 `dfe39a8b…` 变为 80 项 `ec006ba1…`（本节写入前）。第十六轮 E 实库 10 passed 的规格文件已被 ESLint 修复，**不能作为当前候选的 E 通过**；旧记录保留。
- 逐文件指纹：新增 [S4-39-migration-sha256.md](S4-39-migration-sha256.md)，记录 39 个文件完整 SHA-256、算法、排序与路径形式；前 38 条聚合 `624c4570…f86d`，第 39 条文件 `2c59866f…ecfb`。
- 历史回填依据：新增 OI-15。当前仓库无这两张表的旧写入消费者；38 态无检查列/约束；直接 SQL 可写 `SUCCEEDED` 而不写检查事实。R071—R073 只证明“需求要求先检查”，不能单独证明旧记录已检查。结论：历史 `PASSED` 回填目前只能登记为“R072 需求前提驱动的迁移假设”，尚未取得用户批准，不能写成“历史已检查”的审计事实；最小处理选择见 OI-15（推荐保留迁移+明确假设，不改迁移）。
- 状态口径（第十八轮更新）：空表 38→39 升级已通过（`lithography_v13_spec`，第十六轮）；**A 带数据升级已执行但 Jest 失败于规格条目断言的 BIGINT 键类型误报（失败为验收规格断言缺陷；迁移回填正确性尚待直接查询和修复后的断言验证），未完成第二次 upgrade 零变化验证**；**B 未执行**（按“A 失败即停止”）；部分 DDL 续跑仍为证据缺口（G-10）；`init/up30/up31` 仍为 37 态，不构成 39 态验收；真实历史检查事实仍未验证（G-9/G-11）。
- 新规格：`src/infrastructure/database/record-package-state.migration.realdb.spec.ts`。默认 `describe.skip`；显式请求但许可不全即模块加载拒绝；目标库由 `E2E_REAL_DB_NAME` 显式指定（不再硬编码 a/b/c），核对 `DATABASE()`、`@@server_uuid`、MySQL 8.0.x、白名单、空库；从空库用冻结 38 条迁移正向构建，只通过正式 `database:deploy` 执行第 39 条；A 合法回填、B 首次 ALTER 前拒绝、C1 受控部分 DDL 失败/C2 半迁移拒绝（不记续跑通过）。
- C 缺口：正式入口 `inspectMigrationState` 会把“新列已存在但迁移未记录”判为半迁移并在升级前拒绝；在不改预检、不绕过入口、不手工回退 DDL 的前提下无法证明正式入口续跑成功。C2 只验证失败关闭；后续需单独裁决受控续跑最小方案。
- 验证：`npm run typecheck` 0；`npx tsc -p tsconfig.spec.json --noEmit` 0；4 个离线套件 57 passed / 0 failed / 0 skipped（退出 0）；变更 TS ESLint 0；Prettier 通过；能力文档/ normalize guard / 架构 fixtures 均 0；`check:entity-scope` 0 但只覆盖 `origin/main...HEAD` 已提交区间，不覆盖未提交 Entity/Migration；`git diff --check` 0（仅 tracked）。
- 边界：未连接数据库、未写库/建库/迁移/造数/备份恢复/清理、未启动服务、未操作 Redis、未运行实库规格/完整 core、未 commit/push/PR；28 个已跟踪修改、52 个未跟踪路径、3 条 stash 保留。下一轮从 OI-15 裁决与三库授权开始。

### 17.10 第十八轮执行后回填（S4 A/B 实库，2026-11-08）

- 授权收窄：仅新建 `lithography_v13_m39_a`、`lithography_v13_m39_b`（C 未创建）；专用账号 `litho_m39@127.0.0.1` 仅 a/b 各 9 项库级权限，无 SUPER/FILE/GRANT OPTION；配置与证据目录 0700、文件 0600。
- 冻结候选：`HEAD=72de1096…`；tracked `225a839b…`、作用域 `7916190b…`、未跟踪 `.ts` 37 项 `f1970540…`、工作区 80 项 `ec006ba1…`；39 条迁移逐文件 SHA-256 与冻结清单全部一致（38 条聚合 `624c4570…f86d`、39 条 `8827ded2…707f`）。
- A 结果：Jest 退出 1，`1 failed / 3 skipped / 4 total`。正式入口第一次 `runDatabaseDeploy` 成功（只执行第 39 条，内部 verify 通过）；第二次“0 条”未到达。失败前已通过：历史 39 条、列/可空/六条 CHECK、旧字段不变、包回填循环。
- A 失败根因：规格 `selectItemChecks` 以 TypeORM 返回的 BIGINT **string** 建 Map，而 `itemId` 为 **number**，查找必落空（`null` 是未命中，不是数据库值）。属**验收规格断言缺陷**；最小修复为键统一为无损字符串（BIGINT 不转 Number），断言先 `has` 再 `get`。**迁移回填正确性尚待直接查询和修复后的断言验证，不以 ENFORCED CHECK 反证。**
- 现场：A 库 39 态/52 表/39 条历史，`afterAll` 已清理夹具（packages/items/company/account 均 0）；B 库 0 表、无 `migrations`；C 不存在；`init/up30/up31/spec/e2e` 表数未变。
- 未验证：A 第二次 upgrade 零变化、条目回填的测试断言直接证据、B 首次 ALTER 前拒绝/ALTER 计数 0/拒绝后不变、真实历史检查事实、C 自动续跑、管理员初始化、完整 core。
- 证据：`/home/gandiantx/secure/lithography-v13/evidence/m39/20261108/`（含 `a/pre-upgrade.json` 升级前全字段/结构/历史快照、`a/post-run.txt`、`a/type-probe.txt`、`a/root-cause.txt`、`fingerprints.txt`、`evidence-sha256.txt`）。
- 停止：未回退 DDL、未重建库、未连续重跑、未 DROP、未 commit/push/PR。

## S4 管理员初始化专项执行状态（2026-11-09，第二十轮）

- 授权与目标：仅 `127.0.0.1:3306`（`909f9587-9fce-11f1-a353-00e0709ef3a9`），仅新建并写入 `lithography_v13_admin_verify`；使用现有 `gandiantx`，未建/扩权账号、未读写 `mysql` 系统库；未触碰 `init/up30/up31/spec/e2e` 与 m39 各库；未 DROP、未清库、未回退迁移。
- 口径澄清：本文第 146 行“新库无 organization，映射无落点”仍适用于该场景的空库；本专项按任务授权在验证库内先建**明确标记的合成受管公司**作为夹具，再应用合成映射，验证的是工具契约而非真实公司数据。
- 初始化契约（S1 §5）：1 级 3 个（甲方 `CLIENT_DEFAULT`）+ 2 级 3 个（各受管公司）；`admin_level` 1/2；归属写 `base_user_info.customer_organization_id`；首次 `must_change_password=1`、`status=ACTIVE`、`identity_hint=SUPER_ADMIN`；同映射重跑 `UNCHANGED` 且不重置密码；等级/归属不一致、缺资料、缺公司、唯一键碰撞均失败关闭；映射单事务，失败不产生部分账号。
- 新增专项规格：`backend/src/modules/account/base/services/admin-bootstrap.realdb.spec.ts`（默认 skip；显式请求但许可不全即模块加载拒绝；不启动完整 Nest 服务；不建库/不清库/不 DROP）。
- 静态验证：`tsc -p tsconfig.spec.json --noEmit` 0；相关纯单测 `database-deploy.spec.ts` 8 passed；文件级 ESLint（无 `--fix`）0；Prettier 通过；`git diff --check` 0。门禁自检：无 E2E 变量 12 skipped；仅开 `E2E_ADMIN_BOOTSTRAP_SPECS=1` 时模块加载拒绝。
- 首跑结果（已停止）：Jest 退出 1，`7 failed / 5 passed / 12 total`，`Time 33.908 s`。通过：普通 init 不创建管理员；合法首次初始化（6 账号 CREATED、密码按登录算法可验、必须改密）；同映射幂等（6 个 `UNCHANGED`、逐字段无漂移）；缺公司拒绝；输入/配置拒绝（含目标不一致且未建连接）。
- 失败根因（均为新增规格的夹具缺陷，非产品/迁移缺陷）：① 合成 `login_name` 超过 `varchar(30)`，3a/3b/3c/3e/3f/3g 未进入断言；② 收尾行数基线在创建 3 个合成公司之后采样，导致 `organization` 期望 4、实际 1。
- 未取得证据：等级冲突、归属冲突、已有账号补映射（不重置密码）、缺资料、邮箱碰撞整批回滚、注入故障整批回滚、收尾零残留断言（清理动作本身已执行并有效）。
- 现场（失败后）：39 条迁移、52 表、0 视图/触发器/例程/事件；账号/资料/非基线公司均 0，仅 `CLIENT_DEFAULT` 1 行；无迁移锁、无活动事务、无使用中连接；AUTO_INCREMENT 记录 `base_user_account=7`、`base_user_info=7`、`organization=5`，未重置。
- 复跑前置：目标库已非空且禁止 DROP/清库；需新的空库授权（或经批准的空库重置方案）后，按 20.6 的最小修复（缩短合成标识、前移基线采样）复跑；不得改断言或绕过守卫。
- 证据：`/home/gandiantx/secure/lithography-v13/evidence/s4/20261109-r1/admin-verify/`；详见 `execution-log.md` 第二十轮。

## S4 管理员初始化专项最小修复（2026-11-09，第二十一轮，不写库）

- 范围：仅改 `admin-bootstrap.realdb.spec.ts` 与本预检/执行记录；未改产品代码、Entity、Migration、约束；未建库、未连库写数据、未启用实库、未 DROP、未清库、未 commit/push。第二十轮 5 passed / 7 failed 历史保留。
- 夹具生成：`RUN_TAG` 收为固定 8 位（3 位时间基 + 5 位随机）；场景代号短且固定；`login_name` 结构 `adm_<场景>_<RUN_TAG>` 最长 25（上限 30）；`ensureLength` 对 `login_name`/`login_email`/`nickname`/`real_name`/`organization_code`/`organization.name` 校验上限，超长抛错、绝不截断。
- 基线采样：`structureBefore`/`rowCountsBefore`/`historyBefore`/`tableCountBefore` 前移到普通 `init` 完成后、任何合成公司/账号创建前；采样后校验 `organization=1`（仅 `CLIENT_DEFAULT`）、账号/资料为 0；收尾仍与原始基线完整比较。
- 失败场景：先构造合法基础夹具，再只注入目标冲突；资源创建前/后立即登记登录名、账号 ID、公司 ID 与映射文件，异常收尾不依赖业务断言。
- 超时：成功场景约 7 s，用例 1/2 已为 `180_000` ms；3a–3g `120_000`，用例 0 `120_000`，用例 5 `180_000`，`beforeAll 300_000`/`afterAll 180_000`；用例 4 纯内存走全局 10 s。未改全局超时，未加 retry/skip。
- 新增不连库回归 `describe('S4 夹具生成器回归（不连库）')`：运行标识格式、账号/组织字段长度与格式、跨场景唯一、超长不截断，共 4 passed。
- 静态验证：`tsc -p tsconfig.build.json --noEmit` 0；`tsc -p tsconfig.spec.json --noEmit` 0；`database-deploy.spec.ts` + 生成器回归 **12 passed / 12 skipped**；变更文件 ESLint（无 `--fix`）0；Prettier 通过；`git diff --check` 0。规格 SHA-256 `d2214741…fe31`（1528 行）。
- 新库申请（本轮未创建、未写凭据、未复用原库）：`lithography_v13_admin_verify_r2`。规格按环境变量取库名，可直接接受新空库；最小授权 `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES` on `lithography_v13_admin_verify_r2.*`；建库由 DBA 执行。命令：建库 `CREATE DATABASE ... utf8mb4_0900_ai_ci`；首次 init `npm run database:deploy -- --mode=init --config-file=<r2 env> --database=... --confirm-database=...`；专项用 8 个 E2E 变量 + `npx jest --runTestsByPath src/modules/account/base/services/admin-bootstrap.realdb.spec.ts --runInBand`；收尾由用例 5 精确 `DELETE`，不 DROP、不清表。
- 状态：等待 `lithography_v13_admin_verify_r2` 实库授权后复跑；7 个失败场景仍无实库通过证据。

## S4 第二轮实库验收状态（2026-11-09，第二十二轮，r2）

- 授权实例 `127.0.0.1:3306`（UUID `909f9587-9fce-11f1-a353-00e0709ef3a9`）；目标库 `lithography_v13_admin_verify_r2` 执行前不存在，按冻结契约以 `utf8mb4 / utf8mb4_0900_ai_ci` 新建空库；未扩权、未改系统权限表、未 DROP、未清库、未 commit/push。
- 规格 `beforeAll` 自行在空库上跑普通 `init`，本轮**只预建空库**，未重复执行正式 `init`。
- 冻结候选：HEAD `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`；39 条迁移聚合 `8827ded2…707f`、前 38 条 `624c4570…f86d`、第 39 条 `2c59866f…ecfb`；规格 `d2214741…fe31`；`admin-bootstrap.ts` `aeba4722…9d55`。
- 结果：退出码 1；**15 passed / 1 failed / 0 skipped**（离线 4 passed；实库 11 passed / 1 failed）。用例 0/1/2/3a/3b/3c/3d/3e/3f/4/5 通过；**3g 失败**。
- 3g 根因：`FailingDataSource` 只重写 `createQueryRunner`，而 `applyAdminBootstrap` 用 `manager.query` → `EntityManager.query` → `this.dataSource.query(...)`，注入分支从未命中；实际提交 3 条 `CREATED`，随后用例 5 精确回收。
- 收尾实测：52 表、39 迁移、`organization` 仅 `CLIENT_DEFAULT`、账号/资料 0、锁 NULL、活动连接 0；`AUTO_INCREMENT` 账号 17 / 资料 15 / 公司 5（未重置）；原 `lithography_v13_admin_verify` 未触碰。
- 本轮未重跑、未改断言、未绕过守卫；首轮 5 passed / 7 failed 历史保留，3g 不视为通过。
- 下一轮：先在 `FailingDataSource` 增加 `override query(...)` 修复注入点并跑静态验证，再申请新空库 `lithography_v13_admin_verify_r3`（r2 已非空且保留，不能复跑）。

## S4 3g 故障注入最小修复状态（2026-11-09，第二十三轮，不写库）

- 仅改 `admin-bootstrap.realdb.spec.ts` 与本记录/执行记录；未改产品代码、迁移、Entity、约束；未建库、未连库写入、未操作 Redis、未跑完整 core、未 commit/push；HEAD 与工作区/stash 未动。
- 修复：`FailingDataSource` 改为 `override query<T>(sql, parameters, queryRunner)`，删除 `createQueryRunner` 代理；未注入调用 `super.query` 原样委托并透传同一 QueryRunner 与参数；仅第 2 条 `base_user_info` INSERT 抛预设错误；表识别只解析语句首行的关键字+表名。
- 探针：`injectionCount=1`、`infoInsertAttempts=2`、`injectedError` 与产品抛出的错误为**同一对象实例**（`thrown === probe.injectedError`，产品无包装）、故障前成功写入 ≥3、委托写入复用同一 QueryRunner；3g 在业务失败后、任何清理前直接以当前已提交状态校验账号/资料为 0，不依赖 afterAll 清理。
- 覆盖签名：`query<T = unknown>(sql, parameters?: unknown[], queryRunner?: QueryRunner)`，与 TypeORM `DataSource.query` 声明兼容，无 `eslint-disable`、无强转。
- 离线回归新增 3 例（语句解析、注入命中一次且委托原样、`EntityManager.query` → `DataSource.query` 携带事务 QueryRunner）。证据边界：离线不证明 MySQL 回滚，回滚仍待 r3 实库。
- 静态验证：`tsc` build/spec 均 0；`jest` 15 passed / 12 skipped；ESLint（无 `--fix`）0；Prettier 通过；`git diff --check` 0。规格 SHA-256 `8d5343fd…aab9`（1688 行）。
- r2 的 15 passed / 1 failed 记录保留，3g 仍为未通过。仓库内证据链接日期已为 `20261109-r2`，无需修正（`grep 20260909` 无命中）。
- 下一轮：预建空库 `lithography_v13_admin_verify_r3`（`utf8mb4_0900_ai_ci`），仅该库最小权限 `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES`；不预跑正式 init，不触碰 r1/r2。

## S4 R3 实库验收结果（2026-11-09，第二十四轮，通过）

- 前置一致：HEAD `72de1096…`、规格 `8d5343fd…aab9`、39 条迁移聚合 `8827ded2…707f`（前 38 条 `624c4570…f86d`）、`@@server_uuid=909f9587-…`、R3 建库前不存在；r1/r2 各 52 表、账号 0 未触碰。
- 只预建空库 `lithography_v13_admin_verify_r3`（`utf8mb4 / utf8mb4_0900_ai_ci`），未预跑 `database:deploy`；配置 0600、映射目录 0700。
- 命令：`npx jest --runTestsByPath src/modules/account/base/services/admin-bootstrap.realdb.spec.ts --runInBand --verbose`（8 个 E2E 变量）。退出码 **0**，**19 passed / 0 failed / 0 skipped**（离线 7：4 生成器 + 3 注入路径；实库 12：0、1、2、3a–3g、4、5）。
- 3g 直接证据：`injectionCount=1`、`infoInsertAttempts=2`；`thrown === probe.injectedError` 同一实例；故障前 `successfulInserts ≥ 3`；委托写入同一 QueryRunner（Set.size=1）；业务失败后、清理前账号/资料均为 0。
- 收尾：52 表 / 39 迁移 / `organization` 仅 `CLIENT_DEFAULT` / 账号·资料·成员关系 0 / `adm_` 残留 0 / 锁 NULL / `innodb_trx` 0 / 连接 0；`AUTO_INCREMENT` 账号 16、资料 13、公司 5（仅记录未重置）；运行前后迁移文件清单 `cmp` 一致；8 个 0600 映射文件保留在 0700 目录；无 jest 进程；git 70 项改动与 stash 3 项原样保留。
- 结论：专项首次全绿，3g 取得实库回滚证据；第二十轮 5/7 与第二十二轮 15/1 历史保留；未 DROP、未清库、未重跑、未改断言、未 commit/push，完整 core 未运行。

## S4 最终稳定候选 KEEP 模式完整 core 验收结果（2026-11-09，第二十五轮，阻断）

- 候选冻结：分支 `feat/database-v13-deploy`、HEAD `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`、status 70 项、stash 3 项、暂存区空；tracked 1461 文件聚合 `12194702…7a572`、untracked 55 文件聚合 `11f1d0db…c527`；39 条迁移聚合 `8827ded2…707f`（前 38 `624c4570…f86d`、第 39 `2c59866f…6ecfb`）。
- 冻结前发现 1 个未跟踪规格的 110 个 `prettier/prettier` 错误，仅对该文件做 `prettier --write` 最小格式化；随后重新冻结、从头重跑非写库门禁，未拼接修复前后结果。
- 非写库门禁：`typecheck` 0、spec typecheck 0、相关单测 9 套件 93 passed/58 skipped、ESLint 0 error/11 warning、Prettier 通过、架构 4 项 0、`build` 0。
- 正式升级：`lithography_e2e`（`@@server_uuid=909f9587…`）旧态 31 迁移/35 表/业务 0 行；受限备份后 `status`（pending 8）→ `upgrade`（8 条，51 业务表，退出码 0）→ `verify`（通过）→ 再次 `upgrade`（pending 0，无变化）；终态 39 迁移/52 表。第 39 条受影响历史记录：无。
- 独占环境：专用 0600 `lithography-e2e-core.env`（`REDIS_PORT=16379`），`E2E_SKIP_DB_CLEANUP=true` / `E2E_ALLOW_DB_CLEANUP=0` / `E2E_ALLOW_PHYSICAL_CLEANUP=1` / `E2E_ALLOWED_DB_NAMES=lithography_e2e`；16379 独占 Redis（PID 2060004、`bind 127.0.0.1`、配置 SHA `f19f65e5…5d5b`），未访问 6379，结束后 `SHUTDOWN NOSAVE`。
- KEEP：6 行 ID 900000001 覆盖账号/资料、组织/成员、机型/工单；独立 `keep-ledger.json`；运行前记录逐表行数/校验和、触发器 0、文件哨兵 `4e59a94d…e409`。
- **完整 core：退出码 1；仅启动 1/51 个规格**（`test/00-app/00-app.e2e-spec.ts`）；`Test Suites: 1 failed`、`Tests: 6 failed`、passed/skipped 0；失败为 `Entity metadata for IntakeAnalysisAttemptEntity was not found`（Nest API `autoLoadEntities` 缺 `AiProviderCallRecordEntity` 元数据，后者仅由 worker 侧模块注册）。
- 运行后对照：KEEP 全字段、逐表行数/校验和、39 迁移、触发器、文件哨兵均与基线一致；schema 仅 dump 时间戳不同；活动连接 0；测试未进入实库写入，夹具残留 0。
- 收尾：按账本六条显式 ID＋业务键删除 KEEP（删除前 1/1/1/1/1/1，删除后 0/0/0/0/0/0）；最终仅 `migrations` 39 行、业务表全 0；`AUTO_INCREMENT` 不变（仅记录未重置）；未 DROP、未清库、未递归删除证据。
- 未覆盖：core 第 2—51 规格、完整 skip 清单、本轮实库专项规格；R2 15/1 与 R3 19/19 历史保留。结论仅针对当前未提交候选：**标准完整 core 未通过，不得视为允许合并**。

## V13 实体元数据注册缺口最小修复（2026-11-09，第二十六轮，离线）

- 真实缺失路径：拥有者 `IntakeAnalysisAttemptEntity` 已在 `LITHOGRAPHY_ENTITIES`；缺失的是其字符串外键目标 `AiProviderCallRecordEntity`，该实体仅由 `ai-provider-call-record.module.ts` 注册，且该模块只在 Worker 依赖图内。
- 最小修复：`backend/src/bootstraps/api/api.module.ts` 增加 `TypeOrmModule.forFeature([AiProviderCallRecordEntity])`，不导入业务模块/服务，不启动队列/Worker/定时任务，不改变 Capability，不新增跨域业务调用；Worker 图未改动。
- 闭包检查：17 张新增 Entity 及除该目标外的全部字符串外键目标已在 API 闭包内；Worker 闭包含该目标且无跨闭包外键。
- 离线回归：新增 API/Worker 两个不连库 spec，实体来源为 `EntitiesMetadataStorage.getEntitiesByDataSource('default')`，只调 `buildMetadatas()`；修复前 API 复现同一 `TypeORMError`，修复后 API/Worker 均通过。证据边界：不代表 Nest DI 或应用启动，完整启动仍以 core 为准。
- 验证：typecheck（build+tools/spec）0、变更文件 ESLint/Prettier 0、架构/能力门禁 4 项 0、`build` 0、`git diff --check` 0；39 条迁移逐文件与聚合 `8827ded2…707f` 不变。
- 待独立授权：以当前工作区重新冻结候选后，用独占 Redis 与 `lithography_e2e` KEEP 模式重跑完整 core；本轮 core `1/51`、`6 failed` 历史保留，第 2—51 规格仍未执行。

## 修复后 KEEP 模式完整 core 复验（2026-11-09，第二十七轮，失败，26/51）

- 候选冻结：HEAD `72de1096…000a`、tracked 1461 文件 `fb441989…0c3`、untracked 57 文件 `40c83d1e…b6e3`、stash 3、暂存区空；运行前后逐文件 diff 0，源码冻结。
- 前置：39 迁移逐文件与聚合 `8827ded2…707f` 不变；`migration:status` 39/0 pending、`migration:verify` 通过；门禁与 build 本轮实测均 0。
- 配置：专用 env basename 非 `.env.e2e`；setup 日志确认 `needs=mysql`、目标库白名单通过、`skipDbCleanup=true`、`allowDbCleanup=false`；teardown 跳过 Redis FLUSHDB；Redis 16379 独占（run_id `redis16379-20261109T110021-ospUJcLZ`），收尾按 dir/port/bind/PID 匹配后 `SHUTDOWN NOSAVE`，共享 6379 未操作。
- 运行：标准入口 exit code 1；实际启动 26/51 规格，25 suites passed / 1 failed；391 passed / 9 failed / 0 skipped；`00-app` 通过（6 passed），修复后的 API 启动恢复。
- 失败：`test/07-pagination-sort-search/pagination.e2e-spec.ts`；`Entity metadata for UserInfoEntity was not found`。真实缺失目标为 `OrganizationEntity`（`UserInfoEntity` 新增字符串外键 `fk_base_user_info_customer_organization`），该 spec 自建 `TestingModule` 的 `forFeature` 未包含 `OrganizationEntity`；属测试本地装配缺口，按边界未修复。
- 收尾：KEEP 六行、非目标数据、39 迁移、触发器、全量数据 dump、文件哨兵均不变；结构归一化后一致；夹具残留 0；连接/事务 0；按账本精确回收 KEEP 后全库仅 `migrations` 39 行，AUTO_INCREMENT 仅记录未重置。
- 未覆盖：第 27—51 共 25 个规格、失败规格重跑；下一步需独立授权补齐该测试本地实体闭包后另起一轮完整复验；通过 core 仍不等于允许合并。

## 旧测试本地实体闭包最小适配（2026-11-09，第二十八轮，离线，不写库）

- 失败链复核：拥有者 `UserInfoEntity`，缺失目标 `OrganizationEntity`；`OrganizationEntity` 无外键，闭包终止。
- 扫描 backend/src、backend/test 的 `forFeature`、`new DataSource`、测试 `entities` 集合，按真实外键递归核对：需修改 4 处（分页、搜索、排序、维修申请组织范围实库规格）；其余为全量 glob、共享 `ACCOUNT_WRITE_FIXTURE_ENTITIES`、无 entities 或仅 migrations，无需修改。
- 最小修改：新增 `test/utils/local-entity-sets.ts` 集中登记两份规格实际集合（复用账号写入闭包并补 `VerificationRecordEntity`；维修申请集合补 `RepairRequestIntakeEntity`、`StoredFileEntity`）；4 个规格改用共享集合；分页/搜索增加 `appInitialized` 与清理/关闭错误分别保留的 afterAll 保护。未改产品模块、Entity、Migration、权限、断言、runner、skip。
- 离线回归：新增 `local-entity-sets-metadata.spec.ts`，输入与规格同一常量，只 `buildMetadatas()`；断言 `base_user_info → organization`、`repair_request → repair_request_intake → stored_file` 可解析，不连库、不启动 Nest。
- 验证：typecheck（build+tools/spec）0；4 suites / 14 tests passed；变更文件 ESLint/Prettier 0；架构 4 项 0；`git diff --check` 0；39 条迁移逐文件与聚合 `8827ded2…707f` 不变。
- 候选（文档更新前）：tracked 1461 文件 `dffa5d74…4af8`、untracked 59 文件 `f5e28f4c…91f1`、stash 3、暂存区空。
- 未覆盖：未定向复跑 `07` 规格、未运行完整 core；保留第 27 轮 `26/51`、`391 passed / 9 failed` 历史。下一步需独立授权先定向复验受影响规格，再从头上跑 KEEP 完整 core，不拼接为完整通过。

## 实体闭包修复后的定向实库与 KEEP 完整 core 复验（2026-11-09，第二十九轮，core 失败，29/51）

- 目标实测：`server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`、`lithography_e2e` 52 张业务表、39 applied / 0 pending、正式 verify 通过、除 `migrations` 39 行外业务表全 0。
- 独占 Redis 16379：`pid=2078630`、`server_run_id=515797253a810c9aa42f9c056e678e241cd30bca`，0700 目录 / 0600 配置，bind 127.0.0.1；收尾身份匹配后关闭，共享 6379 全程未操作。
- 配置生效：0600 文件指向 `lithography_e2e` 与 16379，`E2E_SKIP_DB_CLEANUP=true`、`E2E_ALLOW_DB_CLEANUP=0`、`E2E_ALLOW_PHYSICAL_CLEANUP=1`、`E2E_ALLOWED_DB_NAMES=lithography_e2e`；跳过 MySQL 清理、teardown 不 FLUSHDB。
- KEEP R3 六行（ID 900000002，独立账本）：定向 4 规格全程及 core 失败后字段/引用不变，非目标数据逐表计数与校验和不变。
- 定向结果：pagination 9 passed、search 16 passed、sort 3 passed、repair-request organization 9 passed；退出码均 0；无 skip、无夹具残留。
- 完整 core：真实退出码 1，启动 29/51，28 suites passed / 1 failed，419 passed / 37 failed / 0 skipped；首失败 `09-reference-document`，`Field 'publication_status' doesn't have a default value`（迁移收紧为 NOT NULL 无默认值，旧夹具未提供该字段）。失败后停止，未清库、未重跑、未修改代码。
- 运行后：KEEP 精确回收至六表 0 行、全库仅 `migrations` 39 行，计数/校验和回到 KEEP 前基线；结构/数据 dump 归一化 `AUTO_INCREMENT` 后差异 0；触发器、39 迁移行、哨兵不变；夹具/事务/连接零残留；AUTO_INCREMENT 仅记录未重置。
- 源码运行期间冻结：tracked/untracked 逐文件 diff 0；候选（文档更新前）tracked `dffa5d74…4af8`、untracked 59 文件 `77a41aab…6f25`、stash 3、暂存区空。
- 证据：`/home/gandiantx/secure/lithography-v13/evidence/s4/20261109-core-r3`（0700/0600）。
- 未覆盖：第 30—51 共 22 个规格；保留 `26/51`、`391 passed / 9 failed` 历史。下一步需独立授权适配 `publication_status` 夹具约束后重新冻结并完整复跑；通过前不允许合并，不 commit、不 push。
