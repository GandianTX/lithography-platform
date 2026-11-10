# S0—S3 执行记录

| 项         | 值                                                                                   |
| ---------- | ------------------------------------------------------------------------------------ |
| 执行日期   | 2026-11-08（Asia/Shanghai）                                                          |
| 执行范围   | 仅 S0＋S1 文档                                                                       |
| 分支       | `feat/maintenance-data-increment`（未切换）                                          |
| HEAD       | `3821e71ccb7b8caa18e1ad4d695cff21b0e7832c`                                           |
| 工作区     | `M backend/plans/README.md`、`?? backend/plans/database-v13-deployment-plan.md` 保留 |
| 暂存区     | 空，未 add                                                                           |
| 数据库     | 未连接、未建库、未迁移、未 seed、未清理                                              |
| 构建/测试  | 未执行 build/install/lint/typecheck/单测                                             |
| Git 写操作 | 无 commit/push/PR；无 fetch/checkout/merge/stash/reset                               |

## 执行步骤与证据

| #   | 动作                                                                                                                         | 结果                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 读取 `AGENTS.md`、`backend/AGENTS.md`、`CONTRIBUTING.md`、`backend/plans/README.md`、`docs/database/README.md`、SOP/增量说明 | 确认路由、计划目录规范、迁移不可变规则                                                                                            |
| 2   | `git status --porcelain=v1`、`git rev-parse HEAD`、`git branch -vv`、`git stash list`、`git remote -v`                       | 见 S0 第 3 节；未修改工作区                                                                                                       |
| 3   | `git ls-remote origin/upstream`（只读）                                                                                      | fork main `72de1096...`；上游 main `cc4c87e...`；分支 `3821e71...`                                                                |
| 4   | `gh pr list/view/api`（只读）                                                                                                | fork PR #2 MERGED（head=3821e71）；上游 PR #21 CLOSED；无开放 PR                                                                  |
| 5   | CI check-runs（3821e71、24f7565）                                                                                            | 3 个 check-runs 均 success（Frontend unit Windows、Backend、Frontend）                                                            |
| 6   | 四份 Word `sha256sum`                                                                                                        | 与主计划 1.1 指纹一致；未用旧版                                                                                                   |
| 7   | V13 Excel 定位/哈希/解析                                                                                                     | 91 行（R001—R048、R050—R092）；SHA-256 记录；OI-09 已明确（目录不作为阻塞）                                                       |
| 8   | 31 条迁移逐文件 `sha256sum` + 静态摘要                                                                                       | 31/31 覆盖；27 个建表迁移覆盖 34 表 + 4 个 ALTER/收紧迁移                                                                         |
| 9   | 34 Entity / REQUIRED_TABLES / 迁移建表名交叉核对                                                                             | 34/34 一致                                                                                                                        |
| 10  | 设计说明 V1.1 初版解析                                                                                                       | 34 现有 + 17 候选；旧口径 439 现有字段、59 目标行、196 候选、3 逻辑、2 组合（已由第 15 步校准）                                   |
| 11  | 消费者静态检索（entity import / 表名引用 / 清理入口）                                                                        | 34 表消费者与测试文件计数；清理入口定位                                                                                           |
| 12  | 部署工具盘点                                                                                                                 | `migration.ts`、`incremental-migration.ts`、`verify-empty-db-migrations.ts`、`migration-schema-contract.ts`；缺 `database:deploy` |
| 13  | 生成 S0/S1 文档并写目录                                                                                                      | 6 个文档 + 本记录；仅新增 `backend/plans/database-v13-deploy/`                                                                    |
| 14  | 最终 `git status` 复核                                                                                                       | 仅新增配套目录；业务代码/Entity/Migration 未改                                                                                    |
| 15  | S1 校准：按源稿四元组结构重算                                                                                                | 现有字段 442（补 3 个 `binary(32)`）；现有表目标行 71（补 12 行）；合计 267；新增物理列 47；总新增列 243；组合字段 7；规则 5      |
| 16  | S1 校准：逐行映射与差异归档                                                                                                  | 12 行漏计清单、3 字段差异、6.1—6.4 计数口径写入字段字典 §6                                                                        |
| 17  | S1 校准：兼容/未决/接口一致性                                                                                                | 移除“保留双写”；新增旧入口逐项处置；init 四态；管理员受控映射；OI-04/05/07/09/10 重写并分类                                       |
| 18  | 本轮检查                                                                                                                     | 对改动 Markdown 运行 Prettier check 与 `git diff --check`；未跟踪文件单独检查；未执行全局格式化/lint --fix                        |

## 本轮新增文件

- `backend/plans/database-v13-deploy/README.md`
- `backend/plans/database-v13-deploy/S0-baseline-and-input-freeze.md`
- `backend/plans/database-v13-deploy/S1-requirement-mapping.md`
- `backend/plans/database-v13-deploy/S1-object-and-field-dictionary.md`
- `backend/plans/database-v13-deploy/S1-contracts-and-compatibility.md`
- `backend/plans/database-v13-deploy/S1-open-issues.md`
- `backend/plans/database-v13-deploy/execution-log.md`

## 未执行／未取得证据

- 未连接数据库：操作库、授权、保留数据、备份源、开发库 30/测试库 31 现状均未本轮证实。
- 未跑真实 SQL、未做空库演练、未做旧库副本升级、未做标准 core。
- 未检查前端构建/浏览器视觉；S0/S1 不需要。
- 未 fetch 远端，未更新 `origin/main` 引用；fork main 以 API/ls-remote 为准。

## 第二轮：S1 口径校准＋S2 结构＋S3 工具

| 项         | 值                                                               |
| ---------- | ---------------------------------------------------------------- |
| 执行日期   | 2026-11-08（Asia/Shanghai）                                      |
| 执行范围   | S1 六项口径同步、S2 结构与最小兼容、S3 部署工具与 SOP；未进入 S4 |
| 分支       | `feat/database-v13-deploy`（从 fork main `72de1096...` 创建）    |
| HEAD       | `72de1096`（本轮无 commit）                                      |
| 工作区     | 保留上一轮计划材料改动；未 stash/reset；未覆盖用户文件           |
| 暂存区     | 空，未 add                                                       |
| 数据库     | 未连接、未建库、未迁移、未 seed、未实库测试、未物理清理          |
| 服务       | 未启动 API/Worker，未安装系统服务，未修改系统权限                |
| Git 写操作 | 无 commit/push/PR；未 rebase/force push；未向 main 提交          |

### 执行步骤与证据

| #   | 动作/命令                                                                                                                                 | 结果与退出码                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | 将 6 项口径写入 `S1-open-issues.md`、`S1-contracts-and-compatibility.md`、`S1-object-and-field-dictionary.md`、`README.md`                | 已更新                                                                      |
| 2   | 新增 6 条迁移 `1775501000000`—`1775501500000`，前 31 条逐文件内容未改                                                                     | 已创建                                                                      |
| 3   | 新增 17 个 Entity；修改 11 个既有 Entity；注册到 `LITHOGRAPHY_ENTITIES`                                                                   | 已实现                                                                      |
| 4   | 同步 `migration-schema-contract.ts`：表/列/索引/CHECK/FK/所有者/定义；`uk_local_backup_run_active` → `uk_local_backup_run_active_company` | 已实现                                                                      |
| 5   | 最小兼容：AI 会话 `requestId` 可空、文档归属可空、测试夹具与清理类型同步                                                                  | 已实现                                                                      |
| 6   | 新增不连库单测 `migration-schema-contract.spec.ts`、`database-deploy.spec.ts`                                                             | 已通过                                                                      |
| 7   | `npm run typecheck`                                                                                                                       | 退出码 0                                                                    |
| 8   | `npx tsc -p tsconfig.spec.json --noEmit`                                                                                                  | 退出码 0                                                                    |
| 9   | `npx jest migration-schema-contract.spec.ts database-deploy.spec.ts --runInBand`                                                          | 退出码 0                                                                    |
| 10  | 变更文件 `npx eslint`（未加 `--fix`）                                                                                                     | 退出码 0                                                                    |
| 11  | 变更文件 `npx prettier --check`                                                                                                           | 退出码 0                                                                    |
| 12  | `npm run capability:docs:check`、`npm run lint:usecase-normalize-guard`、`npm run lint:architecture-fixtures`                             | 退出码 0                                                                    |
| 13  | `npm run build`                                                                                                                           | 退出码 0                                                                    |
| 14  | `git diff --check`                                                                                                                        | 退出码 0                                                                    |
| 15  | `npm run check:entity-scope`                                                                                                              | 退出码 0；该门禁基于 `origin/main...HEAD`，本轮未提交，结果不覆盖未提交变更 |
| 16  | 新增 S3 工具 `scripts/database-deploy.ts`、`database-deploy.ts`、`admin-bootstrap.ts`；`package.json` 增加 `database:deploy`              | 已实现                                                                      |
| 17  | 新增无秘密模板 `database-deploy.env.example`、`admin-bootstrap.example.json` 与 SOP                                                       | 已创建                                                                      |
| 18  | 新增 `S2-db-verification-specs.md`，列明必须待实库执行的约束/事务/清理规格                                                                | 已创建                                                                      |

### 本轮新增/修改文件

- 新增迁移 6：`1775501000000`、`1775501100000`、`1775501200000`、`1775501300000`、`1775501400000`、`1775501500000`。
- 新增 Entity 17：`stored_file`、`repair_request_intake`、`intake_analysis_attempt`、`repair_process_entry`、`ai_message_analysis`、`maintenance_report_fault`、`repair_request_revision`、`reference_document_revision`、`local_account_authorization`、`local_company_setting`、`sync_receipt`、`sync_conflict`、`record_package_import`、`record_package_item`、`backup_asset`、`backup_restore_run`、`management_audit_event`。
- 修改既有 Entity 11：`account`、`user_info`、`organization`、`ai_conversation`、`ai_message`、`repair_request`、`maintenance_report`、`maintenance_report_step`、`reference_document`、`local_upload_task`、`local_backup_run`。
- 结构契约、模块注册、最小兼容、测试夹具与两轮文档更新见 `git status`。

### 统计

| 项                 | 值                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------- |
| 源设计行           | 267（71 现有表目标行 + 196 候选字段）；本轮未遗漏映射，均落在迁移/Entity/契约或复用说明 |
| 组合字段           | 7；不计为独立物理列                                                                     |
| 既有表新增物理列   | 47（42 单列 + 5 组合列）                                                                |
| 目标新增列（估算） | 243（47+196，仍为估算）                                                                 |
| 本轮新增表         | 17                                                                                      |
| 本轮新增迁移       | 6                                                                                       |
| 既有表调整迁移     | 2 条包含 21 处 MODIFY/CHECK 调整                                                        |
| 实库验证           | 0（本轮禁止连接数据库）                                                                 |

### 未执行／未取得证据

- 未执行任何实库 SQL、约束拒绝、事务回滚、清理顺序、MySQL 版本/字符集/时区验证。
- 未执行 `database:deploy` 的真实 init/upgrade；仅做了参数与映射解析单测。
- `check:entity-scope` 基于已提交提交区间，本轮未提交，不能替代真实变更门禁。
- 未运行完整 e2e；e2e 清理入口只做静态核对与类型兼容。
- 未提交、未推送、未创建/回复 PR。

## 第三轮：S4 只读准备（2026-11-08）

> 分支 `feat/database-v13-deploy`／HEAD `72de1096`（与 fork main 一致）。只读核对＋方案编制；未建库/迁移/Seed/实库测试/破坏性 SQL/备份恢复/文件清理/启停服务/暂存/commit/push/PR。

| #   | 步骤                                                                                          | 结果                                                                                                               |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | 冻结候选：工作区 25 修改 + 30 未跟踪；记录 diff 指纹 `adb33610…` 与未跟踪聚合指纹 `50bf1675…` | 完成；17 个新 Entity 逐文件指纹已记录                                                                              |
| 2   | 前 31 条迁移逐文件 SHA-256（前16）比对 S0 冻结值                                              | **31/31 全部一致**，V13 六条为纯追加                                                                               |
| 3   | OI-01/06/12/13 逐项核对（推荐方案 vs 代码实际）                                               | 四项均保持待确认；OI-01 读取层缺口 G-1；其余实现现状记入 S1-open-issues §6                                         |
| 4   | 267 行映射核对                                                                                | 契约 spec 15/15；抽查 FK/CHECK/Entity 一致；缺口 G-2/G-3 登记                                                      |
| 5   | 实库规格真实性                                                                                | `incremental-migration.integration.spec.ts`（实库、双开关）存在；V13 约束/事务/清理可执行规格缺失（G-2）           |
| 6   | 部署工具只读检查（不运行）                                                                    | 显式配置/目标核验/互斥/空脏库区分/pending/重复执行/DDL 部分失败/锁收尾均满足                                       |
| 7   | `check:entity-scope` 边界                                                                     | 仅覆盖 `origin/main...HEAD` 已提交差异；不覆盖本轮未提交变更（G-7）                                                |
| 8   | MySQL 只读核对                                                                                | 8.0.46-0ubuntu0.24.04.4；127.0.0.1:3306；server_uuid `909f9587-…`；7 个 lithography 库历史与数据量见 precheck §7.2 |
| 9   | 账号权限                                                                                      | `gandiantx`@`127.0.0.1` 近全量（`*.*`，主机限定）                                                                  |
| 10  | 候选新库占用                                                                                  | 6 个候选名均不存在                                                                                                 |
| 11  | Redis 只读                                                                                    | 7.0.15；无认证；keyspace 全空；dev/e2e 共用 DB15（G-5）                                                            |
| 12  | 配置加载/白名单/清理开关                                                                      | dotenv 不覆盖进程环境；迁移工具用 `dotenv.parse` 不注入；白名单默认 `lithography_e2e`                              |
| 13  | 编制 S4 执行方案 A—E 与最小授权文字                                                           | 已写入 `S4-pre-execution-precheck.md` §8—§9                                                                        |
| 14  | 文档更新（本文件、`S1-open-issues.md`、`S4-pre-execution-precheck.md`、主计划状态行）         | 仅文档，无源码改动                                                                                                 |

### 本轮缺口登记

G-1 `LocalBackupTriggerType` 未含 AUTO/RETRY；G-2 V13 实库约束/事务/清理无可执行 spec；G-3 清理闭包未覆盖 17 新表；G-4 现有 30/31 态副本数据极少不构成带数据验收；G-5 Redis 共享 DB15 与 KEEP 收尾冲突；G-6 真实管理员映射未取得且新库无 organization 落点；G-7 entity-scope 不覆盖未提交变更。

### 本轮未执行

- 未运行 `database:deploy`／`migration:run`／Seed／实库测试；未 CREATE/DROP/TRUNCATE/DELETE；未备份恢复；未清理文件；未启停服务；未暂存/commit/push/PR。
- S4 全部实库项仍为「规格/方案已编写，待授权执行」，不记为通过。

## 第四轮：S4 前置缺口补齐（2026-11-08）

> 分支 `feat/database-v13-deploy`／HEAD `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`。本轮为源码与测试补齐 G-1/G-2/G-3 并校正预检材料；未建库/迁移/Seed/实库测试/破坏性 SQL/备份恢复/Redis 操作/启停服务/暂存/commit/push/PR。

### 冻结候选

| 项         | 值                                                           |
| ---------- | ------------------------------------------------------------ |
| 分支       | `feat/database-v13-deploy`                                   |
| HEAD       | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`                   |
| 工作区     | 27 个已跟踪修改 + 33 个未跟踪路径（本轮新增 2 个 spec 文件） |
| 暂存区     | 空，未 add                                                   |
| 数据库     | 未连接写入、未迁移、未 seed、未清理                          |
| Redis      | 未启动、未清空、未写配置                                     |
| Git 写操作 | 无 commit/push/PR；无 fetch/checkout/merge/stash/reset       |

### 执行步骤与结果

| #   | 步骤                                             | 结果                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | G-1 备份触发类型契约                             | `local-runtime.types.ts` `LocalBackupTriggerType` 扩为 5 值；`normalizeBackupTrigger` 仍仅旧三值；纯替身单测 4/4 通过（本轮复跑确认）                                                                                                                                                                                                                         |
| 2   | G-2 可执行实库规格                               | `v13-db-verification.spec.ts` 重写为 49 个真实行为用例（§2.1 15/§2.2 6/§2.3 23/§3 5，对照 S2 §2.1 14 项/§2.2 6 项/§2.3 23 项/§3 5 项全覆盖＋1 个强化用例；§4 清理明确标注由 G-3 替身覆盖、实库验收待授权）；占位验收已删除；默认 `describe.skip` 不连库；**本轮未运行该规格（不沿用重写前 10-skip 旧结果），仅 tsc 编译通过**                                 |
| 3   | G-3 新增 17 表清理闭包                           | `e2e-scoped-cleanup.ts` 扩展 17 类别/台账/事实核验/引用闭包收集/按 FK 顺序删除；修正主键（intake/attempt 等 int 主键为 `id`）与父列（intake=`customer_account_id`、entry=`author_account_id`、revision=`actor_account_id`）；`collectByParent` 父在范围子未登记→拒绝 DELETE=0，不自动扩图；纯替身 `e2e-scoped-cleanup.v13.spec.ts` 28/28 通过（本轮复跑确认） |
| 4   | 预检材料校正                                     | 迁移数 30→37=7 pending、31→37=6 pending；管理员映射改「正式上线前置」；Redis 改独立端口临时实例方案；源库只读；文档修改数量按实际 git status                                                                                                                                                                                                                  |
| 5   | OI-01/06/12/13 逐条核对                          | OI-01 类型层已补齐（G-1），业务映射语义仍待裁决；OI-12 清理闭包已补齐（G-3）；OI-06/13 保持；四项均不记为已批准                                                                                                                                                                                                                                               |
| 6   | 类型检查                                         | `npm run typecheck` 退出码 0；`npx tsc -p tsconfig.spec.json --noEmit` 退出码 0（见下方验证表）                                                                                                                                                                                                                                                               |
| 7   | 纯替身/不连库单测（`--runTestsByPath` 精确运行） | 47/47 通过：normalize 4、cleanup.v13 28（20 `it`＋`it.each`×8）、migration-schema-contract 7、database-deploy 8；G-2 实库规格未运行                                                                                                                                                                                                                           |
| 8   | ESLint/Prettier/架构门禁/build/git diff --check  | 全部退出码 0（见下方验证表；ESLint 初报 1 个冗余断言已修复后通过）                                                                                                                                                                                                                                                                                            |

### 本轮实际验证（2026-11-08 复跑记录）

| #   | 命令                                                                                                                                                                                                                                                                      | 结果                                                                                               | 退出码 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| 1   | `git rev-parse HEAD`／`git status --porcelain`／`git stash list`                                                                                                                                                                                                          | HEAD `72de1096d0a2aa2d62ed55a48ab49ebc3398000a` 未变；27 已跟踪修改＋33 未跟踪路径；stash 3 个原样 | 0      |
| 2   | `npx tsc -p tsconfig.spec.json --noEmit`（backend）                                                                                                                                                                                                                       | 通过（含 G-2 实库规格编译）                                                                        | 0      |
| 3   | `npm run typecheck`（backend）                                                                                                                                                                                                                                            | 通过                                                                                               | 0      |
| 4   | `npx jest --runTestsByPath src/usecases/local-runtime/local-runtime.input.normalize.spec.ts src/infrastructure/database/e2e-scoped-cleanup.v13.spec.ts src/infrastructure/database/migration-schema-contract.spec.ts src/infrastructure/database/database-deploy.spec.ts` | 4 套件通过；Tests 47/47 通过、0 失败、0 跳过                                                       | 0      |
| 5   | `npx eslint test/utils/e2e-scoped-cleanup.ts src/infrastructure/database/e2e-scoped-cleanup.v13.spec.ts src/infrastructure/database/v13-db-verification.spec.ts`（不带 `--fix`）                                                                                          | 通过（修复 1 个 `no-unnecessary-type-assertion` 后）                                               | 0      |
| 6   | `npx prettier --check`（同上 3 文件；本轮编辑后用 `prettier --write` 归一化再校验）                                                                                                                                                                                       | All matched files use Prettier code style                                                          | 0      |
| 7   | `npm run capability:docs:check`／`npm run lint:usecase-normalize-guard`／`npm run lint:architecture-fixtures`／`npm run check:entity-scope`                                                                                                                               | 全部通过；`check:entity-scope` 基于 `origin/main...HEAD`，不覆盖未提交变更（G-7 保持）             | 0      |
| 8   | `npm run build`（backend）                                                                                                                                                                                                                                                | 通过                                                                                               | 0      |
| 9   | 仓库根目录 `git diff --check`                                                                                                                                                                                                                                             | 无空白错误                                                                                         | 0      |

### 本轮明确未执行

- **G-2 实库规格未运行**：`v13-db-verification.spec.ts` 重写后未以任何模式启动（默认 `describe.skip` 运行亦未执行）；不沿用重写前「10/10 skip」旧结果；`E2E_REAL_DB_SPECS` 未启用；仅有 tsc 编译通过证据。
- 未运行 `npm run lint`（含 `--fix` 可能自动写入）；未运行完整 core/worker/smoke e2e；未运行 `migration:drill:empty-db` 与 `incremental-migration.integration.spec.ts`。
- 未连接数据库写入/迁移/造数/备份恢复/清理；未操作 Redis；未启停服务；未暂存/commit/push/PR。

### 本轮缺口状态更新

- **G-1**：已补齐（类型层），读取层业务映射语义仍待 OI-01 裁决。
- **G-2**：已补齐可执行 spec（49 个真实行为用例，S2 §2.1/§2.2/§2.3/§3 全覆盖，§4 实库清理验收待授权）；本轮仅编译，未运行（不沿用重写前 10-skip 旧结果）；实库断言待授权执行。
- **G-3**：已补齐清理闭包（17 表真实主键/父列、事实核验、R01 引用拒绝、intake↔repair_request 解环、按 FK 拓扑删除）；纯替身 28/28 通过；实库清理验收待授权。
- **G-4**：30/31 态源库继续只读，后续授权副本补合成业务数据（非真实历史库证据）。
- **G-5**：Redis 改用独立端口(16379)/独立目录/仅回环临时实例方案（本轮只写方案）。
- **G-6**：真实管理员映射为正式上线前置；S4 用合成管理员/公司/等级映射。
- **G-7**：`check:entity-scope` 不覆盖未提交变更。

### 本轮未执行

- 未运行任何实库 SQL、`database:deploy`、Seed、e2e；未 CREATE/DROP/TRUNCATE/DELETE；未备份恢复；未启动/操作 Redis；未启停服务；未暂存/commit/push/PR。
- G-2 实库断言未运行（重写后未以任何模式启动该规格，详见「本轮明确未执行」）；mock 通过不记为 MySQL 约束或真实 API 验收通过。

## 第五轮：S4 第一批实库验证（2026-11-08，A 阶段受阻）

> 分支 `feat/database-v13-deploy`／HEAD `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（沿用在途工作区，未提交）。本轮开始执行实库验证；A 阶段 init 的终态校验暴露契约期望错误，按停止条件中止 A 及其后续依赖（B/C/D/E 均未执行）。未 DROP、未清库、未回退 DDL、未暂存/commit/push/PR。

### 候选冻结

| 项              | 值                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| HEAD            | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`                                                                                                        |
| 分支            | `feat/database-v13-deploy`                                                                                                                        |
| 工作区          | 27 个已跟踪修改 + 33 个未跟踪路径（与第四轮一致）                                                                                                 |
| 暂存区          | 空                                                                                                                                                |
| stash           | 3 个原样保留                                                                                                                                      |
| 迁移文件        | 37 个；前 31 条逐文件 SHA-256 与 S0 冻结值 **31/31 全部一致**；新增 6 条为 `1775501000000`—`1775501500000`                                        |
| 37 条聚合指纹   | `638ee99d15e0869302e0d7c59b0ef82644e353e18ddce453e5ed610a6e53d72a`（sha256sum 汇总行）                                                            |
| 已跟踪源码 diff | `d93fbb6820b24f075e10458368afe6461f2a97916a5bd3055c545d3737ed38f2`（`git diff -- backend/src backend/scripts backend/test backend/package.json`） |
| 未跟踪 .ts 聚合 | `31ef059441cc27ff91e349bec5dc39e19a76b1280d73d239868cb70731bed8e6`（31 个文件）                                                                   |

### 执行前安全核对（通过）

| 项               | 结果                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实例身份         | `@@server_uuid = 909f9587-9fce-11f1-a353-00e0709ef3a9`，与授权一致；MySQL `8.0.46-0ubuntu0.24.04.4`；127.0.0.1:3306                                      |
| 目标库占用       | 四个验证库执行前均不存在                                                                                                                                 |
| 源库真实历史     | `lithography_upgrade_drill_copy_20261030` = 30 条（max `1775401500000`）；`lithography_drill_30to31_20261030` = 31 条（max `1775401600000`）；均 35 张表 |
| 库外配置         | `/home/gandiantx/secure/lithography-v13/`（0700），配置/证据 0600；未写入仓库、未输出密码                                                                |
| 部署工具配置读取 | `loadExplicitEnvConfig` 校验 `DB_NAME` 与 `--database` 完全一致，`DB_SYNCHRONIZE=true` 直接拒绝                                                          |
| 创建四个验证库   | `CREATE DATABASE` ×4（utf8mb4/utf8mb4_unicode_ci）；退出码 0                                                                                             |

### A：新库初始化（失败，已中止）

| 项       | 结果                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 命令     | `npm run database:deploy -- --mode init --config-file .../lithography_v13_init.env --database lithography_v13_init --confirm-database lithography_v13_init`                                                                                    |
| 退出码   | **1**                                                                                                                                                                                                                                          |
| 迁移执行 | `目标为空库，准备执行 37 条迁移` → `已执行 37 条迁移`                                                                                                                                                                                          |
| 失败点   | `init 终态校验失败`，两条外键期望与实际不符                                                                                                                                                                                                    |
| 库内终态 | migrations 37 条（max `1775501500000`）、52 张 BASE TABLE；`record_package_import` 主键 `package_id`、`sync_receipt` 主键 `receipt_id`；仅 `organization`/`local_installation` 各 1 行既有迁移种子，`base_user_account` 0 行；管理员映射未应用 |

失败原文（两条均为契约期望列名写成 `id`，而父表主键实为 `package_id`/`receipt_id`）：

- `record_package_item.fk_record_package_item_package` 期望 `(package_id) -> record_package_import(id)`，实际 `-> record_package_import(package_id)`
- `record_package_item.fk_record_package_item_receipt` 期望 `(receipt_id) -> sync_receipt(id)`，实际 `-> sync_receipt(receipt_id)`

定位（只读，未修改）：

- 迁移 `1775501400000-create-local-sync-and-package-for-v13.migration.ts` L178—183：外键引用父表 `package_id`/`receipt_id`。
- 实体 `record-package-import.entity.ts`、`sync-receipt.entity.ts`：主键分别为 `package_id`、`receipt_id`（char(36)）。
- 契约 `migration-schema-contract.ts` L2756—2765 的 `referenceColumns` 写成 `['id']`。**迁移、实体、实库三者一致，契约期望错误。**
- `migration-schema-contract.spec.ts` 只校验契约自洽与迁移时间戳，不与迁移 DDL 比对，故 7/7 通过未能发现该错误。

### 本轮未执行（因 A 受阻）

- B/C：未导出、未恢复副本、未补合成夹具、未执行 upgrade（同一终态校验必然同样失败）。
- D：`lithography_v13_spec` 未 init、未运行 49 项规格（未启用 `E2E_REAL_DB_SPECS`）。
- E：未运行 G-3 清理专项。
- 未 DROP/清空任何库；未触碰 `lithography_e2e`、`aigc_friendly`、`lab_manager`、`lithography_e2e_keep`；未操作 Redis；未启动服务；未暂存/commit/push/PR。
- 源库仅做只读查询，前后计数一致（30/31 条迁移，35 张表）。

### 最小修复方案（待授权，未执行）

将 `migration-schema-contract.ts` 两条 `referenceColumns` 改为 `['package_id']` 与 `['receipt_id']`；不改迁移 DDL、实体与库内数据。修复后需重新核对源码指纹再继续 A/B/C/D/E。

> 后续已获授权并在第六轮执行，见下节。

### 证据位置（仓库外）

- `/home/gandiantx/secure/lithography-v13/evidence/A-init-verify-failure.txt`
- `/home/gandiantx/secure/lithography-v13/evidence/defect-contract-fk-reference-columns.md`
- `/home/gandiantx/secure/lithography-v13/evidence/migration-fingerprints-37.txt`

## 第六轮：G-8 最小修复与 A 阶段复验（2026-11-08）

> 只改契约期望与回归，不改迁移/实体/库结构与数据；`lithography_v13_init` 保留原地复验，未 DROP、未清空、未重放 DDL。

### 修复内容（精确 diff）

- `migration-schema-contract.ts`
  - `record_package_item.fk_record_package_item_package.referenceColumns`：`['id']` → `['package_id']`
  - `record_package_item.fk_record_package_item_receipt.referenceColumns`：`['id']` → `['receipt_id']`
- `migration-schema-contract.spec.ts` 新增 3 条回归（离线构建 TypeORM Entity 元数据，不建连接）：
  1. 每条关键外键的引用列都能在目标 Entity 元数据中解析到真实物理列；
  2. 每条关键外键的引用列在目标 Entity 中构成主键或唯一键；
  3. `record_package_item` 两条外键的引用列等于父实体真实主键列（非默认 `id`）。
- 结论：全量关键外键中**无其他“默认引用 id”同类问题**（上述 1/2 对所有登记外键生效并通过）。

### 非实库验证（实际执行）

| #   | 命令                                                                                           | 结果                                 | 退出码 |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------ | ------ |
| 1   | `npx jest --runTestsByPath .../migration-schema-contract.spec.ts .../database-deploy.spec.ts`  | 2 套件通过；18/18（契约 10、部署 8） | 0      |
| 2   | `npm run typecheck`（build + tools）                                                           | 通过                                 | 0      |
| 3   | `npx tsc -p tsconfig.spec.json --noEmit`                                                       | 通过                                 | 0      |
| 4   | `npx eslint src/infrastructure/database/migration-schema-contract.ts ...spec.ts`（无 `--fix`） | 通过（修复 2 个重复 import 后）      | 0      |
| 5   | `npx prettier --check`（同上 2 文件）                                                          | 通过                                 | 0      |
| 6   | 仓库根目录 `git diff --check`                                                                  | 通过                                 | 0      |

### A 阶段复验（原地，无 DDL 重放）

| 项          | 结果                                                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正式 verify | `npm run migration:verify -- --config-file .../lithography_v13_init.env --database lithography_v13_init`，退出码 **0**；`业务表 51 张；历史校验与数据回填校验通过`；实现走 `withReadOnlyDataSource`，无写入 |
| init 重复 1 | `目标已完成迁移（历史 37 条），进入终态复核` → `部署完成：无变化（历史完整、终态校验通过，业务表 51 张）`，退出码 **0**                                                                                     |
| init 重复 2 | 同上，退出码 **0**                                                                                                                                                                                          |
| 迁移执行数  | 两次重复均为 **0** 条                                                                                                                                                                                       |
| 快照一致性  | 复验前后 4 次快照（verify 前/后、重复 1/2 后）SHA-256 均为 `0cf934f8129970986927264e6678bce7f2484a2e7351dc31ac83d8b1c7c358c1`：52 张表、37 条迁移、51 张业务表、种子行与结构完全一致                        |

`runInit` 无变化路径已核对：历史完整且 pending=0 → 不做 `executePendingMigrations`、不清表、不重建账号；管理员初始化仅在显式传参时执行（本轮未执行）。

### 新候选指纹

| 项              | 值                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------- |
| HEAD            | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未变）                                             |
| 工作区          | 27 已跟踪修改 + 33 未跟踪路径（60 行）；stash 3 个原样                                         |
| 已跟踪源码 diff | `f659367cae6a4603410f937b426ca7b7e6bf7553c91fe2a90e9215f13fe44510`                             |
| 未跟踪 .ts 聚合 | `b750b2aee318d95f0c8b5e93fa181bb10fffa2b86ddf82999e6208d9ac03dc66`（31 个文件）                |
| 37 条迁移指纹   | `638ee99d15e0869302e0d7c59b0ef82644e353e18ddce453e5ed610a6e53d72a`（逐文件比对：**保持不变**） |

### 本轮未执行

- 未执行合成管理员映射（另列为有写入的专项）。
- `lithography_v13_up30/up31/spec` 保持新建后的空库现状，未导入、未初始化。
- B/C/D/E 未执行；未升级 `lithography_e2e`；未操作 Redis；未运行完整 core；未 DROP/清库/改迁移/commit/push。

## 第七轮：B/C 旧结构副本＋合成业务数据升级验证（2026-11-08）

> 证据只能称为「**旧结构副本＋合成业务数据升级验证**」，不是真实历史业务库完整验收。
> 仅写入 `lithography_v13_up30`、`lithography_v13_up31`；两个源库只读；未 DROP、未清库、未 commit/push、未操作 Redis、未运行完整 core。

### 候选复核（与 G-8 复验候选一致）

| 项                  | 值                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------- |
| HEAD                | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`                                                    |
| 已跟踪源码 diff     | `f659367cae6a4603410f937b426ca7b7e6bf7553c91fe2a90e9215f13fe44510`                            |
| 37 条迁移逐文件指纹 | `638ee99d15e0869302e0d7c59b0ef82644e353e18ddce453e5ed610a6e53d72a`（与冻结文件逐行一致）      |
| 未跟踪 .ts          | 31 个，逐文件指纹留存 `evidence/untracked-files-31.txt`；最新 mtime 15:21，均早于本轮实库操作 |
| 工作区／stash       | 27 已跟踪修改 + 33 未跟踪路径（60 行）；stash 3 个原样                                        |

### 目标库复用前核验（通过）

`lithography_v13_up30` 与 `lithography_v13_up31` 均为 0 表 / 0 视图 / 0 例程 / 0 触发器 / 0 事件；实例 `server_uuid` 与授权一致。

### B：30 态副本（`lithography_upgrade_drill_copy_20261030` → `lithography_v13_up30`）

| 项           | 结果                                                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源库真实历史 | 30 条（max `1775401500000`；id 1—31 存在一个继承缺口），35 张表                                                                                                                                            |
| 只读导出     | mysqldump（`--single-transaction --quick --skip-lock-tables --no-tablespaces --skip-add-drop-table`）；无 DROP/CREATE DATABASE；SHA-256 `27c2ae41edfd98c0280653cce3aee04262179e6a60d654f991252135dcaf5476` |
| 恢复与一致性 | 恢复后源/副本结构哈希与数据逐行比对一致                                                                                                                                                                    |
| 合成夹具     | `V13_SYNTH_B30`：organization 3、equipment_model 900002、账号 900002/900003、repair_request 1、report 1、step 1、doc 900002/900003、upload 1、backup 1、conv/msg 1，共 13 行                               |
| status       | 退出 0；pending **7**（`AddNullSafeHandlingConstraints1775401600000` + 6 条 V13）                                                                                                                          |
| upgrade      | 退出 0；`已执行 7 条迁移`；业务表 51 张                                                                                                                                                                    |
| verify       | 退出 0；`业务表 51 张；历史校验与数据回填校验通过`                                                                                                                                                         |
| 再次 upgrade | 退出 0；`历史 37 条，仓库 37 条，pending 0 条`；`无变化（历史完整、终态校验通过，业务表 51 张）`                                                                                                           |
| 旧字段保留   | pre-upgrade dump 对升级后库逐行比对 **48 行全匹配**；`migrations` 30→37 为预期增长，其余表行数不变                                                                                                         |
| 回填         | doc 900001/900002 → `ONLINE/CONFIRMED/MATERIAL`；doc 900003 → `OFFLINE/CONFIRMED/MATERIAL`                                                                                                                 |
| 未猜测       | repair_request 新列与 `owner_organization_id` 保持 NULL；ai/local 旧行新列 NULL 或默认值，`trigger_type` 保留                                                                                              |
| 重复执行漂移 | 快照 SHA-256 `5b3e349694cba60789f75276efb367106c4acb9c4f52f58e1a20636a1694c9a2` 两次一致                                                                                                                   |
| 源库不变     | 源库重跑同一比对 **35 行全匹配**、30 条迁移/35 张表                                                                                                                                                        |

### C：31 态副本（`lithography_drill_30to31_20261030` → `lithography_v13_up31`）

| 项           | 结果                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源库真实历史 | 31 条（max `1775401600000`，含第 31 条 null-safe 约束），35 张表                                                                                  |
| 只读导出     | 同 B 参数；无 DROP/CREATE DATABASE；SHA-256 `20e92fce1f76de7f38c2d334a796c5e94ecbfe61e79e2ff1db8793924a522b64`                                    |
| 恢复与一致性 | 逐行比对 **36 行全匹配**；源/副本结构哈希同为 `14d4a96886d35e21c30c9b6cdb74d3b26c9de1f868d5dbb9bc15042097533c18`                                  |
| 合成夹具     | `V13_SYNTH_C31`（910001+）：组织 2、机型 1、账号 3、user_info 2、工单 2、报告 3、版本 2、步骤 2、资料 2、会话 2、消息 2、上传 1、备份 1，共 25 行 |
| status       | 退出 0；pending **6**（`1775501000000`—`1775501500000`）                                                                                          |
| upgrade      | 退出 0；`已执行 6 条迁移`；业务表 51 张                                                                                                           |
| verify       | 退出 0；`业务表 51 张；历史校验与数据回填校验通过`                                                                                                |
| 再次 upgrade | 退出 0；`pending 0 条`；`无变化（历史完整、终态校验通过，业务表 51 张）`                                                                          |
| 旧字段保留   | 逐行比对 **61 行全匹配**（15 张有数据表）；`migrations` 31→37 为预期增长                                                                          |
| 回填         | doc 900001/910001 → `ONLINE/CONFIRMED/MATERIAL`；doc 910002 → `OFFLINE/CONFIRMED/MATERIAL`                                                        |
| 未猜测       | 工单/报告/会话/上传/备份新列保持 NULL 或默认值；组织新布尔列 0；账号 `admin_level` NULL                                                           |
| 重复执行漂移 | 快照 SHA-256 `a8445de7db4a175b0f536d6ec342db070b337ac51e893aa8d400a7cc6dfc43f2` 两次一致                                                          |
| 源库不变     | 31 态源库 **36 行全匹配**、31 条迁移/35 张表；30 态源库仍 30 条/35 张表                                                                           |

### B/C 夹具行数校正（第八轮复核）

- 计数范围 = **仅本轮新增夹具行**；不含源库既有行、`migrations` 行与迁移种子。
- B：源库既有 4 行（organization/equipment_model/base_user_account/reference_document 各 1）+ 新增 **13** 行 = 目标 17 行；`migrations` 30→37。
- C：源库既有 4 行 + 新增 **25** 行 = 目标 29 行；`migrations` 31→37。
- 「27」不成立：C 初稿夹具曾含 2 条 `UPDATE maintenance_report`（后并入 INSERT，未落库），若误把语句计为行会得 27。实际逐表计数与源/目标对照见 `evidence/fixture-row-counts.md`。
- 未为校正数量修改任何数据库。

### 观察项（未擅改）

- 30/31 态 `reference_document.owner_organization_id` 原本 NOT NULL，迁移改为 NULL；因此 `ownership_status='PENDING'` 分支在真实旧数据中不可达（回填一律 `CONFIRMED`）。本轮只记录，不作为缺陷裁决。
- 第 31 条迁移仅含约束（`AddNullSafeHandlingConstraints`），故 31 态与 30 态的业务旧表列集合不同但其影响已在 C 夹具覆盖。
- 两库 `migrations` 主键存在继承缺口（源库自带），非本轮引入。

### 本轮未执行

- D（49 项实库规格）、E（G-3 清理专项）、管理员初始化、完整 core、D/E 后清理。
- 未 DROP/清空任何库；未触碰 `lithography_e2e`、`aigc_friendly`、`lab_manager`、`lithography_e2e_keep`；未操作 Redis；未暂存/commit/push/PR。
- `lithography_v13_up30/up31` 保留一切结构与数据，合成夹具保留供复核（B 13 行、C 25 行），非「清理零残留」。

### 证据位置（仓库外，0700/0600）

- `/home/gandiantx/secure/lithography-v13/evidence/b30/`（`summary-b30.md`、dump+sha256、结构哈希、`old-fields-compare.json`、`post-upgrade-1/2.json`、日志、`migrations-applied.txt`、`backfill-checks.txt`）
- `/home/gandiantx/secure/lithography-v13/evidence/c31/`（`summary.md`、`copy-consistency.json`、dump+sha256、结构哈希、`old-fields-compare.json`、`post-upgrade-1/2.json`、日志、`migrations-applied.txt`、`backfill-checks.txt`）
- 夹具：`/home/gandiantx/secure/lithography-v13/backups/b30/fixtures-b30.sql`、`backups/c31/fixtures-c31.sql`

## 第八轮：D/E 实库规格（D 首跑失败即停止，E 未执行）

> 仅写入 `lithography_v13_spec`；未触碰 `lithography_v13_init/up30/up31` 及其保留夹具；未 DROP、未清库、未 commit/push、未操作 Redis、未运行完整 core。

### 候选复核

| 项                  | 值                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| HEAD                | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`                                                     |
| 已跟踪源码 diff     | `f659367cae6a4603410f937b426ca7b7e6bf7553c91fe2a90e9215f13fe44510`                             |
| 37 条迁移逐文件指纹 | `638ee99d15e0869302e0d7c59b0ef82644e353e18ddce453e5ed610a6e53d72a`（逐文件哈希与冻结清单一致） |
| 变更                | 本轮除文档与仓库外证据外，源码零变更                                                           |

### B/C 行数校正

- 依据夹具 SQL 与源/目标只读计数：B 新增 **13** 行（源库既有 4 行、`migrations` 37 行不计），C 新增 **25** 行（非 27；逐表对照见 `evidence/fixture-row-counts.md`）。
- 未为校正数量修改数据库。

### spec 库初始化（通过）

- 执行前：`lithography_v13_spec` 0 表 / 0 视图 / 0 例程 / 0 触发器 / 0 事件；实例 `909f9587-9fce-11f1-a353-00e0709ef3a9`。
- `npm run database:deploy -- --mode init --config-file .../lithography_v13_spec.env --database lithography_v13_spec --confirm-database lithography_v13_spec`，退出 0：`已执行 37 条迁移`、`业务表 51 张`。
- `npm run migration:verify -- … lithography_v13_spec`，退出 0：`业务表 51 张；历史校验与数据回填校验通过`。
- 基线：52 表 / 37 条迁移 / 0 触发器 / 0 例程 / 0 事件；快照哈希 `7ef8fd4877a1ad22fad31132da797ef9cb3c09d27549c414ffd407ae54ebee41`；全量 dump SHA-256 `23d1c7a60964ecba0931237ac04af11aa1a9ad3b564d8fac697316f06435771b`。

### D：约束与事务实库规格（首跑失败，已停止）

- 命令：`E2E_REAL_DB_SPECS=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_REAL_DB_NAME=lithography_v13_spec E2E_ALLOWED_DB_NAMES=lithography_v13_spec` + spec 配置导出的 `DB_*`，`npx jest --runTestsByPath src/infrastructure/database/v13-db-verification.spec.ts --runInBand`。
- 结果：退出 1；`Test Suites: 1 failed`；`Tests: 49 failed, 49 total`（0 passed / 0 skipped）。
- 根因（单点、发生在 `beforeAll`）：套件级组织夹具写 `kind='SERVICE'`，被 V13 `chk_organization_kind` 拒绝（允许 `CLIENT`/`PEER`），错误码 3819；`v13-db-verification.spec.ts:534`（记录事实 `:541` 同值）。49 个用例因 `beforeAll` 失败全部未进入用例体。
- 最小修复方向：把该套件夹具的 `kind` 与台账事实改为 `CLIENT` 或 `PEER`（与迁移 CHECK 及契约一致），随后重跑同一命令；不改数据库约束、不删断言、不加 skip。
- 残留对照：失败后快照哈希仍为 `7ef8fd48…`（与基线一致）；52 表 / 37 条迁移 / 0 触发器 / 0 例程 / 0 事件；`organization` 的 1 行是 init 种子（基线已有），本轮夹具零残留。

### E：G-3 清理实库专项（未执行）

- 触发停止条件：D 首跑失败，按授权「D 失败不继续 E」。
- 现状：`src/infrastructure/database/e2e-scoped-cleanup.v13.spec.ts` 为**纯替身**规格，不含实库执行路径；本轮未新增实库专项，也未运行 E。
- 后续最小方案：新增受版本控制的实库专项（沿用 D 的双开关＋白名单＋实际 `DATABASE()` 核验），覆盖 R01/R02/集合外入向引用、合法清理、后序失败整批回滚、幂等重跑、intake↔工单解环，然后先类型检查与替身验证再实库执行。

### 本轮未执行

- E、管理员初始化、KEEP 完整 core、`lithography_e2e` 升级、任何 DROP/清库。
- 未回收 `lithography_v13_init/up30/up31` 中保留夹具；未暂存/commit/push/PR。

### 证据位置（仓库外，0700/0600）

- `/home/gandiantx/secure/lithography-v13/evidence/d/`：`init.log`、`init-verify.log`、`baseline.json`、`baseline-full.sql` + `.sha256`、`baseline-structure.sha256`、`baseline-residue.txt`、`jest-d.log`、`after-d-failure.json`、`after-d-residue.txt`
- `/home/gandiantx/secure/lithography-v13/evidence/fixture-row-counts.md`（B/C 校正依据）

## 第九轮：spec 库复用授权复核与 D 第二次运行（再次失败，按用户选择停止）

> 用户明确授权：① 复用已初始化的 `lithography_v13_spec`（不重建、不清库）；② 修正 D 套件夹具并重跑同一命令。第二次重跑仍在夹具层失败后，用户选择「停止，仅报告」。

### 候选

| 项                  | 值                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------- |
| HEAD                | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`                                             |
| 已跟踪源码 diff     | `f659367c…`（未变；spec 为未跟踪文件，不计入该指纹）                                   |
| 37 条迁移逐文件指纹 | `638ee99d…`（未变）                                                                    |
| 未跟踪 .ts 变更     | 仅 `v13-db-verification.spec.ts`：`7e6cdd62…` → `50afcdec…`（两处 `'SERVICE'→'PEER'`） |
| 变更留档            | `evidence/untracked-files-31-after-d-fix.txt`                                          |

### 幂等 init 复核（通过）

- 命令与上轮相同；退出 0，输出 `目标已完成迁移（历史 37 条），进入终态复核`、`部署完成：无变化（历史完整、终态校验通过，业务表 51 张）`。
- 生产快照哈希 `7ef8fd48…`，与第八轮基线一致；52 表 / 37 条迁移 / 0 触发器。

### D 第二次运行（失败，已停止）

- 命令：同第八轮（双开关＋白名单＋spec `DB_*`，`--runTestsByPath`）。
- 结果：退出 1；`Tests: 49 failed, 49 total`（0 passed / 0 skipped）。
- 阻断点：`beforeAll` 调用 `createTestAccount` 时报 `EntityMetadataNotFoundError: No metadata for "AccountEntity"`；spec 的 DataSource 为 `entities: []`，而 helper 走 TypeORM Repository。
- 残留对照：快照哈希 `7ef8fd48…` 与基线一致；`organization` 1 行（init 种子）、`base_user_account`/`base_user_info`/`equipment_model` 均 0；触发器 0。夹具零残留。
- 最小修复方向（未实施）：为 spec 的 DataSource 注册 `AccountEntity`/`UserInfoEntity` 等元数据，或改用原始 SQL 造账号并台账登记；不改约束、不删断言、不加 skip、不清库。

### E

- 未执行（D 未通过即停止；用户选择停止并仅报告）。现有 `e2e-scoped-cleanup.v13.spec.ts` 仍为纯替身，实库专项未新增。

### 证据

- `/home/gandiantx/secure/lithography-v13/evidence/d/`：`init-rerun.log`、`baseline-rerun.json`、`jest-d.log`（第二次运行，SHA-256 `ec951253…`）、`after-d2-failure.json`、`after-d2-residue.txt`
- `/home/gandiantx/secure/lithography-v13/evidence/untracked-files-31-after-d-fix.txt`

## 第十轮：D 规格最小装配修复（方案 A）与定向复跑（beforeAll 通过，用例体失败，按约停止）

> 用户授权：仅修正测试 DataSource 装配及必要回归、验收记录；不改业务代码、Entity、Migration、约束；不改用原始 SQL 造账号；不清库、不 DROP、不 commit、不 push；本轮不进入 E。

### 候选（本轮修改前后）

| 项                 | 值                                                                   |
| ------------------ | -------------------------------------------------------------------- |
| HEAD               | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未变）                   |
| 分支               | `feat/database-v13-deploy`（未变）                                   |
| spec（修改前）     | `50afcdec…`（第九轮记录，完整值未留存）                              |
| spec（修改后）     | `6e59c38a63f4908f11369caadbd96ff56c3c90e483b988449061319e1ce5fbf5`   |
| test-accounts.ts   | `7886cff0…`（本轮由“未修改”变为已跟踪修改：新增实体集合导出）        |
| 已跟踪 diff 指纹   | `632a84be…`（含 `test/utils/test-accounts.ts`；`git diff` 全量）     |
| 37 条迁移指纹      | `c4a2e480…`（未变）                                                  |
| 未跟踪文件清单指纹 | `251d5352…`（清单内容未出现非预期新增）                              |
| 留档               | `evidence/d/candidates-d3.txt`、`evidence/untracked-files-31-d3.txt` |

### 修改内容（仅测试装配与回归）

1. `test/utils/test-accounts.ts`：新增 `ACCOUNT_WRITE_FIXTURE_ENTITIES = [AccountEntity, UserInfoEntity, OrganizationEntity]`。依据：`createTestAccount` 只用 Account/UserInfo 仓储；`UserInfoEntity` 的 `@ForeignKey('OrganizationEntity', …)` 以字符串引用，缺 Organization 元数据会直接抛错。
2. `src/infrastructure/database/v13-db-verification.spec.ts`：
   - DataSource `entities: []` → `[...ACCOUNT_WRITE_FIXTURE_ENTITIES]`；显式保留 `synchronize: false`、补充 `migrationsRun: false`；未启用 Seed、未启动 Nest。
   - 保留组织 `kind='PEER'`；静态复核父夹具列：`organization`、`equipment_model` 与真实表结构一致。
   - `beforeAll` 创建顺序保持不变：组织/账号/机型均为“创建成功即登记”，登记使用受控输入而非回读，故后续创建失败时先前已提交资源仍可精确回收。
   - 新增离线装配回归 `describe('G-2 实库规格 DataSource 装配（离线元数据，不连接数据库）')`：`MetadataOnlyDataSource` 子类只调用 `buildMetadatas()`，不 initialize；断言三张表元数据、Account↔UserInfo 关系、`customer_organization_id` 字符串外键解析、无悬挂引用、未开启自动同步/迁移。
   - 避免在 `src/infrastructure` 内直接 import `src/modules`（`no-infrastructure-to-modules-imports` 规则），实体集合经 `test/utils` 中转，断言改用表名解析。

### 不连库的装配回归（全部通过）

| 检查                         | 结果                                          |
| ---------------------------- | --------------------------------------------- |
| 离线元数据规格               | `2 passed, 49 skipped`（真实库组按门控 skip） |
| 相关纯替身规格               | `e2e-scoped-cleanup.v13.spec.ts` 通过         |
| `npm run typecheck`          | 退出 0                                        |
| ESLint（变更文件，无 --fix） | 退出 0                                        |
| Prettier `--check`           | 通过                                          |
| `git diff --check`           | 通过                                          |

### D 第三次运行（失败，已停止）

- 前置核验：`SELECT DATABASE()=lithography_v13_spec`；实例 `127.0.0.1:3306`、`server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`；运行前快照哈希 `7ef8fd48…` 与基线一致。
- 命令（双开关＋白名单＋spec `DB_*`）：
  `E2E_REAL_DB_SPECS=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_REAL_DB_NAME=lithography_v13_spec E2E_ALLOWED_DB_NAMES=lithography_v13_spec npx jest --runTestsByPath src/infrastructure/database/v13-db-verification.spec.ts --runInBand`
- 结果：退出 1；`Test Suites: 1 failed`；`Tests: 47 failed, 4 passed, 51 total`（4 passed = 2 离线装配 + 2 真实库用例；0 skipped）。
- `beforeAll` **成功**：组织、客户/工程师账号、机型均已创建并登记，`EntityMetadataNotFoundError` 不再出现；失败全部发生在用例体。

### 用例体失败分类（均为规格夹具/期望值与真实库不一致，非约束变更）

| 类别                            | 数量 | 具体表现                                                                                                                                                                                                                                                               |
| ------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 必填列缺失（NOT NULL 无默认值） | 17   | `ai_message.message_seq`、`maintenance_report.source_type`、`sync_receipt.receipt_status`、`sync_conflict.local_snapshot`、`record_package_item.manifest_json`、`local_account_authorization.authorization_status`、`local_backup_run.trigger_type` 等未由 helper 提供 |
| 列名错误                        | 2    | 规格写 `reference_document_revision.snapshot`，真实列名为 `before_snapshot`/`after_snapshot`                                                                                                                                                                           |
| 字符串超长                      | 10   | `repair_request.request_no` 为 `varchar(50)`、`repair_request_intake.record_uuid` 为 `char(36)`，规格生成值分别 52/55 字符                                                                                                                                             |
| 错误码名称不匹配                | 多个 | 规格期望 `ER_CHECK_CONSTRAINT`/`ER_NO_REFERENCED_ROW`/`ER_ROW_IS_REFERENCED`；mysql2 实际为 `ER_CHECK_CONSTRAINT_VIOLATED`（3819）、`ER_NO_REFERENCED_ROW_2`（1452）、`ER_ROW_IS_REFERENCED_2`（1451）                                                                 |
| 失败触发值选错                  | 2    | `current_revision_no = -1`（int unsigned）先触发 `ER_WARN_DATA_OUT_OF_RANGE`；`organization_id = -1` 先触发 CHECK 而非 FK                                                                                                                                              |

> 上述均属规格侧夹具与断言期望问题；未修改任何约束、未删断言、未加 skip。

### 残留（非零，已按约停止并保留现场）

- 快照哈希 `b64c7f9fcde7…`（≠ 基线 `7ef8fd48…`）；表数 52、迁移 37、结构哈希与基线一致、触发器/视图/例程/事件均为 0。
- 行数变化：`organization 1→2`、`base_user_account 0→2`、`base_user_info 0→2`、`equipment_model 0→1`、`repair_request 0→1`。
- 残留具体行：组织 `id=3 G2ORG-mw7kb1hu (PEER)`；账号 `id=1 g2_customer_mw7kb1hu`、`id=2 g2_engineer_mw7kb1hu`；机型 `id=1 G2MDL-mw7kb1hu`；报修 `id=2 G2-REQ-mw7kb1hu-tx-revision (customer_account_id=1)`；`repair_request_intake` 0 行。
- 根因：用例“修订追加原子性”把 `repair_request` 作为**事务外已提交父夹具**创建，但只登记到 `testLedger`；清理预检要求其客户账号在同一账本内（R01），该账号属套件账本 → 拒绝删除；`afterAll` 套件清理随后又因该行对账号 `id=1` 的入向 FK（集合外引用）整批拒绝（AggregateError），故 5 张表夹具保留。清理器行为正确（零部分删除），问题在规格的账本归属设计。
- 未做任何手工清理；等待授权后按精确 ID 逆依赖顺序清理并复核回基线。

### 最小修复方向（待授权，未实施）

1. 夹具 SQL 按真实结构补齐：逐表列出所有 `NOT NULL` 且无默认值的列并写入（`ai_message`、`maintenance_report`、`maintenance_report_step`、`reference_document_revision`、`sync_receipt`、`sync_conflict`、`record_package_item`、`local_account_authorization`、`local_backup_run` 等）；`record_uuid`/`request_no` 改为 ≤36/≤50；`snapshot` 改为真实列名。
2. 错误码常量改为 mysql2 实际名称（1451/1452/3819）；`organization_membership` 的“不存在公司”改用正的不存在 ID；`current_revision_no` 用例改用其他可触发 CHECK 的后序失败或显式期望 1264。
3. 账本归属：事务外提交的子行若引用套件父夹具，应登记到套件账本（或为清理器提供“已收养父资源”显式入参），避免 R01 误拒与 afterAll 连锁。
4. 重跑前先精确清理上述 5 行并复核快照回到基线。

### E

- 未执行（本轮明确不进入 E）。`e2e-scoped-cleanup.v13.spec.ts` 仍为纯替身，实库清理专项未新增。

### 证据

- `/home/gandiantx/secure/lithography-v13/evidence/d/`：`pre-d3-state.json`、`pre-d3-run.json`、`jest-d3.log`（SHA-256 `1431edc2…`）、`after-d3-failure.json`、`candidates-d3.txt`
- `/home/gandiantx/secure/lithography-v13/evidence/untracked-files-31-d3.txt`

## 第十一轮：D 第三次失败后的测试修复、精确收尾与复跑（2026-11-08）

### 11.1 迁移指纹逐文件复核与聚合差异解释

- 统一方法：`sha256sum src/infrastructure/database/migrations/*.migration.ts`（按文件名排序、行内含仓库相对路径）再 `sha256sum` → `c4a2e480…`。
- 逐文件比对结果：当前 37 个迁移文件与冻结清单 `migration-fingerprints-37.txt` **37/37 完全一致**（比较项为各文件 SHA-256 前缀 + 文件名）。
- `638ee99d…` 是上述 37 行“前缀 + 文件名”冻结清单**文件自身**的 SHA-256；`c4a2e480…` 是同一批 37 文件的 `sha256sum` 全行再聚合。
- 结论：差异来自**聚合容器/路径与算法**，不是迁移内容变化；不存在需要停止的 Migration diff。

### 11.2 夹具修复映射（依真实 Migration/Entity/结构契约，逐表核对）

结构事实来源：`information_schema`（只读）导出的列/唯一键/外键/CHECK，覆盖 49 项涉及的全部表。

| 表/夹具                       | 真实契约（此前被违反）                                                                     | 修复                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repair_request_intake`       | `record_uuid char(36)`                                                                     | 改用 `randomUUID()`（原拼接 52 字符，D3 超长）                                                                                                                                  |
| `repair_request`              | `request_no varchar(50)`；受理/处理态 CHECK 成组                                           | 编号改 `G2-<tag>-<uuid>`（47 字符）；helper 新增 `is_accepted/accepted_by/accepted_at/handling_status/handling_recorded_at/handling_ended_at`，使“结单原因”负例只违反目标 CHECK |
| `maintenance_report`          | `source_type`、`maintenance_engineer_account_id`、`..._name_snapshot` NOT NULL 无默认      | helper 固定 `source_type='HISTORICAL_CASE'`（`repair_request_id` 为空）并写入工程师快照                                                                                         |
| `maintenance_report_version`  | `submitted_at` NOT NULL 无默认；`schema_version ≥ 2`                                       | 写入 `NOW(3)`，payload 用 `schema_version: 2`                                                                                                                                   |
| `maintenance_report_step`     | `phase_code ∈ PHASE_01..PHASE_10`                                                          | 由非法 `'REPAIR'` 改为 `'PHASE_01'`                                                                                                                                             |
| `maintenance_report_fault`    | `branch_kind` 合法域；`STEP_NEW_FAULT` 才要求 `step_code`；`status` NOT NULL               | 步骤归属负例改用 `STEP_NEW_FAULT` + `step_code`，补 `status='OPEN'`                                                                                                             |
| `reference_document_revision` | 列名为 `before_snapshot`/`after_snapshot`；CHECK 要求两列合法 JSON 且含 `$.schema_version` | 负例改“非合法 JSON”（缺键为 NULL，MySQL 视为通过，不能作负例）                                                                                                                  |
| `repair_request_revision`     | 同上两列 + `schema_version` NOT NULL；CHECK 要求两份快照的 `$.schema_version` 与列值相等   | 全部写入改为 before/after 双快照；负例改为**数值不等**（2 vs 1），保证 CHECK 求值为 FALSE                                                                                       |
| `ai_message`                  | `message_seq` NOT NULL 无默认、uk(conversation,seq)；USER 需 `turn_no`                     | helper 补 `message_seq`/`turn_no`                                                                                                                                               |
| `stored_file`                 | `upload_context_id char(36)` 且唯一                                                        | 改真实 UUID                                                                                                                                                                     |
| `local_backup_run`            | `trigger_type`、`started_at` NOT NULL 无默认                                               | 固定 `MANUAL` + `NOW(3)`                                                                                                                                                        |
| `backup_asset`                | `local_status`、`byte_size` NOT NULL 无默认                                                | 固定 `PENDING` + 100                                                                                                                                                            |
| `backup_restore_run`          | `status`、`check_snapshot` NOT NULL 无默认                                                 | 固定 `RUNNING` + 含 `schema_version` 的 JSON                                                                                                                                    |
| `sync_receipt`                | `receipt_status` NOT NULL 无默认                                                           | 补 `receipt_status`（负例 `SUCCEEDED` 无 `confirmed_at`）                                                                                                                       |
| `sync_conflict`               | `local_snapshot`/`cloud_snapshot`/`conflict_reason`/`status` NOT NULL                      | 全部补齐（快照含 `schema_version`）                                                                                                                                             |
| `record_package_import`       | `manifest_json`、`status` NOT NULL 无默认                                                  | 补 `{"schema_version":1}` 与 `PENDING`                                                                                                                                          |
| `record_package_item`         | `result ∈ SUCCEEDED/FAILED/SKIPPED`                                                        | 由非法 `'PENDING'` 改为 `'SKIPPED'`                                                                                                                                             |
| `local_account_authorization` | `authorization_status` NOT NULL 无默认                                                     | 补 `ACTIVE`                                                                                                                                                                     |
| `organization_membership`     | `member_role ∈ SUPER_ADMIN/ENGINEER/CUSTOMER`；`organization_id int`                       | 负例由 `-1 + 'ADMIN'`（先触发 CHECK）改为正数不存在 ID `2147483000 + 'CUSTOMER'`，稳定命中 FK 1452                                                                              |

错误断言升级（不再把“任意报错”当负例通过）：

- `expectMySqlError` 读取 `driverError`，**先校验 errno + sqlState，再校验 code 名称**；CHECK 违规实际为 `ER_CHECK_CONSTRAINT_VIOLATED / 3819 / HY000`（D4 实测纠正了此前的 `23000` 假设）。
- 标签中声明的 `chk_/fk_/uk_` 约束名会被提取，并要求错误信息命中；同族多约束用 `withConstraint` 显式允许任一命中。
- `current_revision_no=-1`：列 `int unsigned` 的合法域与 `CHECK ≥ 0` 完全重合，负例实际先被类型域拒绝。改为断言 `ER_WARN_DATA_OUT_OF_RANGE / 1264 / 22003`，并注明 CHECK 由类型域覆盖，不冒充 CHECK。
- 复合外键负例：`reference_document(source_report_version_id, source_report_id)` 复用旧版本 ID 会先撞唯一键，改用**不存在的版本号**，唯一键满足后才命中 1452。

账本与收尾（规格内）：

- 事务外提交的 `repair_request` 及其父行（组织/客户账号/机型）登记入**套件台账**，使清理计划同时包含“经独立证明的父行 + 子行”，消除 R01 跨账本拒绝。
- 已提交的 `repair_request_revision` 在事务成功后**立即登记自身归属事实**（`requestId/revisionNo/actorAccountId/schemaVersion`）；D5 实测证明“父行关系不是删除授权”，缺证据会被清理预检拒绝。
- 用例级 `repair_request_intake`/`intake_analysis_attempt` 仍留在用例台账，未统一塞入套件台账。
- 新增纯替身回归：`用例提交子行后断言失败：合并台账仍按依赖顺序精确回收，不残留不误删`（断言工单先于账号/机型/组织删除、commit 恰一次、无 rollback）。

### 11.3 D3 残留 7 行精确收尾（已授权）

- 目标：`127.0.0.1:3306` / `server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9` / `lithography_v13_spec`；收尾前 SQLSTATE 快照哈希 `b64c7f9f…` 与 D3 结束态一致（无漂移）。
- 预期事实（来源＝受控创建输入 + D3 证据，非回读认领）：组织 `G2ORG-mw7kb1hu / G2 组织 mw7kb1hu / PEER / ACTIVE`；账号 `g2_customer_mw7kb1hu`、`g2_engineer_mw7kb1hu`（邮箱同名、ACTIVE、CUSTOMER/ENGINEER、昵称 `<login>_nickname`、`meta_digest` 同角色、`user_state ACTIVE`）；机型 `G2MDL-mw7kb1hu / G2 机型 mw7kb1hu / enabled / sort 0`；报修 `G2-REQ-mw7kb1hu-tx-revision / customer=客户账号 / model=机型 / E001 / G2 故障描述 / content_md '# G2'`。
- 入向闭包核验（只读）：仅 `base_user_info` 2 行（账号子行）与 `repair_request` 1 行（引用客户/服务组织与机型）；无修订、无 intake、无其他引用。
- 执行入口：现有受保护 `runGuardedSpecCleanup`（`E2E_ALLOW_PHYSICAL_CLEANUP=1` + `E2E_ALLOWED_DB_NAMES=lithography_v13_spec`），同一事务内完成许可、`DATABASE()`、锁定、逐字段比对、闭包校验后按依赖顺序删除；未使用任何直接 `DELETE` 补救。
- 结果：删除成功；收尾后快照与 **D3 运行前基线完全一致**（`7ef8fd48…`，业务行/结构/迁移/种子/触发器/视图/例程/事件均相同）。
- `AUTO_INCREMENT` 推进（仅记录，不 ALTER 重置）：`organization=7`、`base_user_account=13`、`base_user_info=13`、`equipment_model=5`、`repair_request=36`。

### 11.4 D 复跑（三阶段，均使用专用配置/白名单/显式许可）

| 阶段       | 命令（均 `--runTestsByPath src/infrastructure/database/v13-db-verification.spec.ts --runInBand`） | 结果                                        | 退出码 | 备注                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| D4         | 双开关 + `E2E_REAL_DB_NAME`/`E2E_ALLOWED_DB_NAMES=lithography_v13_spec`                           | `23 failed, 28 passed, 51 total`            | 1      | 夹具已基本修复；23 项均为 CHECK 的 sqlState 期望（`23000`→实际 `HY000`）；另 1 项复合 FK 先撞唯一键 |
| D5         | 同上                                                                                              | `1 failed, 50 passed, 51 total`             | 1      | 仅“快照 schema_version 不一致”负例：缺键得到 NULL，MySQL CHECK 视为通过                             |
| D6（最终） | 同上                                                                                              | `51 passed, 51 total`（离线 2 + 真实库 49） | **0**  | 真实库 `passed=49 / failed=0 / skipped=0`；离线元数据 `passed=2`                                    |

- D4 运行后同样出现残留（组织/账号/资料/机型/工单/修订 8 行），已用同一受保护入口（补充修订子行归属事实后）精确回收，未直接 DELETE；回收后快照回到基线 `7ef8fd48…`。
- D5 运行后零残留、基线不变（证明“提交即登记 + 子行自带证据”的协同收尾有效）。
- D6 结束后复核：全表行数、结构、37 条迁移、种子、触发器/视图/例程/事件均与基线一致；**非目标数据不变、本轮夹具零残留**；`hash=7ef8fd48…`。
- 日志：`jest-d4.log`（D4）、`jest-d5.log`（D5）、`jest-d6.log`（D6，最终通过）。

### 11.5 离线与静态检查（复跑前全部通过）

| 检查                                  | 结果                                                     |
| ------------------------------------- | -------------------------------------------------------- |
| 类型检查 `tsc -p tsconfig.build.json` | 退出 0                                                   |
| 纯替身规格                            | `e2e-scoped-cleanup.v13.spec.ts` 31 passed（含新增回归） |
| G-2 离线元数据                        | `2 passed, 49 skipped`（未设真实库门控时）               |
| ESLint（变更文件，无 `--fix`）        | 退出 0                                                   |
| Prettier `--check`                    | 通过                                                     |
| `git diff --check`                    | 通过                                                     |

### 11.6 候选指纹（D6 运行前冻结）

- HEAD `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`；分支 `feat/database-v13-deploy`。
- `v13-db-verification.spec.ts` `6aca797a…`（修复前 `b07075d1…`）；`e2e-scoped-cleanup.v13.spec.ts` `116694ca…`；`test-accounts.ts` `7886cff0…`。
- 已跟踪 diff `632a84be…`；37 迁移聚合 `c4a2e480…`（逐文件 37/37）。
- 证据：`evidence/d/candidates-d4.txt`、`candidates-d5.txt`、`before-cleanup-c12.json`、`after-cleanup-c12.json`、`after-d4-cleanup.json`、`after-d5-failure.json`、`after-d6-pass.json`。

### 11.7 边界遵守

- 未改 Entity/Migration/生产业务约束；未降低断言、未加 skip、未清库、未 DROP、未重置自增。
- 未执行 E、管理员初始化、完整 core、任何 Redis 操作；未修改 `init/up30/up31`；未 commit/push。
- 前三次失败历史（kind SERVICE、实体元数据缺失、夹具/错误码不一致）完整保留于第五—十轮记录。

## 第十二轮：JSON 快照版本约束的最小核对与回归（2026-11-08）

> 保留第十一轮 D6 `51 passed` 记录；该记录**未覆盖**“缺 `schema_version` / JSON null 是否被拒绝”这一命题。本轮未进入 E，未改 Entity/Migration/约束，未 commit/push。

### 12.1 契约依据（逐项）

依据：`S1-object-and-field-dictionary.md` §4.2（JSON/快照格式版本）、§4.7/§4.8（两张修订表字段）、`S1-contracts-and-compatibility.md` §3.2 注意条、`S1-open-issues.md` OI-02。实际实现：`1775501300000-create-report-fault-and-revisions-for-v13.migration.ts`、`repair-request-revision.entity.ts`、`reference-document-revision.entity.ts`、`migration-schema-contract.ts`。

| 字段                                                                                                                                                                                                                                                                               | 设计是否要求                                                                                                            | 允许类型/范围                                                                     | 是否须与独立列相等           | 实际 CHECK 强度                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `repair_request_revision.before/after_snapshot`                                                                                                                                                                                                                                    | 是：JSON 内须含 `schema_version`，与原稿独立列同值（S1 §4.2/§4.7）                                                      | 随独立列 `int unsigned` 且 CHECK `>=1`；JSON 侧须数值相等（字符串/小数/布尔不等） | 是，两侧都须相等             | 部分：`JSON_VALID` + 独立列 `>=1` + 两处 `JSON_EXTRACT = 列`；**缺键为 NULL，CHECK 放行** |
| `reference_document_revision.before/after_snapshot`                                                                                                                                                                                                                                | 是：设计只要求“有格式版本”，无独立列；OI-02 要求 JSON 内 `schema_version`、读写侧拒绝未知版本                           | 设计未规定 JSON 内类型/范围（无独立列可对齐）                                     | 不适用                       | 仅存在性：`JSON_VALID` + 两处 `IS NOT NULL`；**JSON null 也满足 IS NOT NULL**             |
| `sync_conflict.local_snapshot/cloud_snapshot`                                                                                                                                                                                                                                      | 是：“需包格式版本”，OI-02 要求 JSON 内 `schema_version`                                                                 | 设计未规定类型/范围                                                               | 不适用                       | 仅存在性（同一 `IS NOT NULL` 模式，未逐表实库写入）                                       |
| `backup_restore_run.check_snapshot`                                                                                                                                                                                                                                                | 是：“需核对/格式版本”，OI-02 要求 JSON 内 `schema_version`                                                              | 设计未规定类型/范围                                                               | 不适用                       | 仅存在性（同一 `IS NOT NULL` 模式，未逐表实库写入）                                       |
| `record_package_import.manifest_json`                                                                                                                                                                                                                                              | 迁移要求 `$.schema_version` 存在；S1 §4.2 未列该字段，字段字典写“schema 明确”且另有 `format_version` 列，实际迁移无该列 | 设计未明确 JSON 内键名/类型/范围                                                  | 不适用                       | 仅存在性；**要求来源不一致，列为待裁决**                                                  |
| `content_submission_revision.payload_snapshot`、`fault_case_submission_detail.extension_json`、`material_submission_detail.extension_json`、`maintenance_report_version.payload_snapshot`、`reference_document_case_detail.case_payload_json`、`reference_document.extension_json` | S1 §4.2 记“有 schema_version”（沿用）                                                                                   | 各表有独立 `schema_version` 列；`maintenance_report_version` 另 CHECK `>=2`       | 设计未明确要求 JSON 与列相等 | 无 JSON 键 CHECK；由独立列/应用层承担，**不作为本轮 DB 负例**                             |

### 12.2 SQL 行为与错误码（实库只读探针 + 定向写入）

- 缺键：`JSON_EXTRACT('{"a":1}','$.schema_version')` = SQL NULL；`IS NOT NULL`=0；与列比较=NULL（CHECK 视为 UNKNOWN → 放行）。
- JSON null：`JSON_EXTRACT(...)` = JSON null；`JSON_TYPE(...)`='NULL'；`IS NOT NULL`=1；与整数列比较=0（FALSE）。
- 类型错误：JSON 字符串 `"1"`、小数 `1.5`、布尔、数组与整数 1 比较均为 0（FALSE）。
- 数值相等：JSON 数字 1 与列 1 为 TRUE。
- 拒绝错误码实测统一为 `ER_CHECK_CONSTRAINT_VIOLATED / errno 3819 / sqlState HY000`（MySQL 8.0.46）。

### 12.3 定向回归（`describe('2.4 JSON 快照版本契约')`，实库事务内执行）

| 表 / 命题                                                         | 结果                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| `repair_request_revision` 合法版本（两侧 1、列 1）                | 通过（写入成功）                                        |
| `repair_request_revision` 缺 `schema_version`                     | **失败：预期 3819 拒绝，实际写入成功**（缺陷）          |
| `repair_request_revision` JSON null                               | 通过（3819/HY000 拒绝）                                 |
| `repair_request_revision` 类型错误（JSON 字符串 "1"）             | 通过（3819/HY000 拒绝）                                 |
| `repair_request_revision` 与独立列不等（before / after 各一次）   | 通过（3819/HY000 拒绝）                                 |
| `reference_document_revision` 合法版本（两侧 `schema_version=1`） | 通过（写入成功）                                        |
| `reference_document_revision` 缺 `schema_version`                 | 通过（3819/HY000 拒绝；恢复被非法 JSON 替代的缺键负例） |
| `reference_document_revision` JSON null                           | **失败：预期 3819 拒绝，实际写入成功**（缺陷）          |

运行命令：`--runTestsByPath src/infrastructure/database/v13-db-verification.spec.ts --runInBand -t '2.4 JSON 快照版本契约'`；`6 passed, 2 failed, 51 skipped, 59 total`，退出码 1（51 skipped 为未匹配的 49 项实库 + 2 项离线）。

### 12.4 残留与结构核验

- 运行前后同一套快照方法（`who`/tables/counts/columns/indexes/fks/checks/migrations/seeds）：哈希均为 `3e7cb710c57cc2ab72f2859f2fb4f575663431140f9286bbf43fdb24e63b9c2f`，完全一致。
- 全库业务行计数合计 39（仅种子 `local_installation=1`、`organization=1`、`migrations=37`），本轮夹具零残留；非目标数据不变。
- 结构、37 条迁移、种子与第十一轮 D6 结束态一致；实例校验 `server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`、`DATABASE()=lithography_v13_spec`。
- 未执行任何 DDL；`AUTO_INCREMENT` 未重置（事务回滚不改变计数语义，未额外 ALTER）。

### 12.5 分流结论与最小修复方向（未实施）

结论：设计**明确要求**版本字段/同值，实库存在两项真实约束缺陷，按用户分流规则停止，不进入 E，不擅自 DDL。

1. `chk_repair_request_revision_schema`：缺键因 `JSON_EXTRACT = schema_version` 得到 NULL 被放行。最小 NULL 安全修复＝在两处等值比较前各加 `JSON_EXTRACT(... ) IS NOT NULL`；JSON null 仍由等值 0 拒绝。不改列类型、不加新业务约束。
2. `chk_reference_document_revision_schema`：JSON null 因 `IS NOT NULL` 成立被放行。最小修复＝保留 `JSON_EXTRACT(...) IS NOT NULL`，再补 `JSON_TYPE(JSON_EXTRACT(...)) <> 'NULL'`（仅排除 JSON null，不擅自增加整数类型/范围）。
3. 同类 `IS NOT NULL` 模式（`sync_conflict`、`backup_restore_run`）按 SQL 语义同样接受 JSON null；`record_package_import` 的 JSON 内版本要求与 S1 字段字典存在来源差异；三项是否同步修复/收紧类型，需用户裁决。
4. `reference_document_revision` 的允许类型/范围、`record_package_import` 的版本来源（JSON 键 vs 独立 `format_version` 列）属于“要求不清楚”，列为最小待裁决问题，不自行选择。

### 12.6 候选与证据

- HEAD 仍 `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`；分支 `feat/database-v13-deploy`；未 commit/push。
- `v13-db-verification.spec.ts` SHA-256 `e18a2144d4bb00bc0344fc4bfb4cb19c929625793f4037ebc546436a6ed7e50e`（第十一轮为 `6aca797a…`）。
- 证据：`evidence/d/jest-json-contract.log`、`pre-json-contract.json`、`post-json-contract.json`；配置 `/home/gandiantx/secure/lithography-v13/configs/lithography_v13_spec.env`（0700/0600，未输出密码）。
- 文档校正：`S2-db-verification-specs.md` §2.3 表下新增实测校正说明；规格头部新增 2.4 映射并注明 D6 未覆盖缺键/JSON null 命题。

## 第十三轮：JSON 版本必填约束最小修复（2026-11-08，未执行 DDL）

> 本轮只做追加迁移、Entity/契约同步与离线验证；**未执行 ALTER、未运行迁移、未连接或修改任何验证库**；第十二轮 2 项失败断言与全部历史证据原样保留。

### 13.1 冻结候选与范围

- 依据：`S1-object-and-field-dictionary.md` §4.2/§4.7/§4.8、`S1-contracts-and-compatibility.md` §3.2、`S1-open-issues.md` OI-02，以及第十二轮 `lithography_v13_spec` 实测（`6 passed / 2 failed`）。
- 冻结四张受影响表：`repair_request_revision`、`reference_document_revision`、`sync_conflict`、`backup_restore_run`。
- 前 37 条已执行迁移（31 条基线 + 6 条 V13）逐文件不改；追加第 38 条 `1775501600000`。不新增独立列、整数类型、版本范围或其他业务限制。

### 13.2 追加迁移准确内容

文件：`backend/src/infrastructure/database/migrations/1775501600000-fix-json-snapshot-version-checks-for-v13.migration.ts`。

| 表                            | 约束名                                   | 修复后表达式要点                                                                                                                                           |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repair_request_revision`     | `chk_repair_request_revision_schema`     | `schema_version >= 1`；两侧 `JSON_VALID`；两侧 `JSON_EXTRACT(...) IS NOT NULL`；两侧 `JSON_TYPE(...) <> 'NULL'`；两侧 `JSON_EXTRACT(...) = schema_version` |
| `reference_document_revision` | `chk_reference_document_revision_schema` | 两侧 `JSON_VALID`；两侧 `IS NOT NULL`；两侧 `JSON_TYPE(...) <> 'NULL'`                                                                                     |
| `sync_conflict`               | `chk_sync_conflict_schema`               | `local_snapshot`/`cloud_snapshot` 两侧同上（键存在且非 JSON null）                                                                                         |
| `backup_restore_run`          | `chk_backup_restore_run_schema`          | `check_snapshot` 同上                                                                                                                                      |

- `IS NOT NULL` 与 `JSON_TYPE(...) <> 'NULL'` 必须同时保留：缺键时 `JSON_EXTRACT` 为 SQL NULL，单独 `JSON_TYPE` 比较仍为 UNKNOWN；JSON null 时 `IS NOT NULL` 仍为 TRUE。
- `down` 仅恢复修复前的较弱表达式；新约束下既有数据满足旧表达式，无需预检。
- 每表先查 `information_schema.TABLE_CONSTRAINTS`：存在则单表 `DROP CONSTRAINT + ADD CONSTRAINT`（单表 ALTER 原子），不存在则只 ADD，支持部分失败后的幂等续跑。

### 13.3 预检逻辑

- 任何 ALTER 之前先确认四表存在；缺表即失败关闭。
- 逐表统计：总数、非法 JSON、缺键（`JSON_EXTRACT IS NULL`）、JSON null（`JSON_TYPE='NULL'`）、`repair_request_revision` 独立列 `< 1`、与独立列不等。
- 判定使用 `CASE` 顺序短路：先判 `JSON_VALID=0`，避免对非法 JSON 调用 `JSON_EXTRACT` 抛错；再判缺键、JSON null、独立列 `< 1`、等值不符。
- 任一违规行存在即抛错且不执行任何 ALTER；报告仅含脱敏计数与定位 ID（按主键排序、最多 20 个），不输出快照内容，不删除、不自动补版本。
- 多表 ALTER 失败时报告“已完成 / 失败 / 未执行”表，并明确 MySQL DDL 隐式提交、已成功 ALTER 不能随迁移整体回滚；修复原因后可直接重跑。

### 13.4 受影响对象与同步

- 四张 Entity 增加/更新 `@Check`：`repair-request-revision.entity.ts`、`reference-document-revision.entity.ts`、`sync-conflict.entity.ts`、`backup-restore-run.entity.ts`。
- `migration-schema-contract.ts` 在 `REQUIRED_CHECKS` 处注明四条表达式由 `1775501600000` 重建，`CHECK_CREATED_BY` 保留首次创建时间。
- `migration-schema-contract.spec.ts` 的 `V13_TIMESTAMPS` 增加 `1775501600000`；新增断言四表 Entity CHECK 两侧均含键存在与非 JSON null 守卫，repair 另含两处等值。
- `json-version-check-repair.migration.spec.ts`（纯替身）：合法值、缺键、JSON null、独立列 `< 1`、缺表、第二条 ALTER 失败、约束缺失续跑、down 回退；before/after 与 local/cloud 两侧均断言。
- `README.md` 迁移数量更新为 7 条（`1775501000000—1775501600000`），候选总数 38。

### 13.5 `record_package_import` 格式版本来源（待裁决，本轮不改）

| 维度        | 实际实现（`1775501400000` + Entity）                                 | 设计字典 §4.13                                |
| ----------- | -------------------------------------------------------------------- | --------------------------------------------- |
| 主键/包标识 | `package_id char(36)` 作主键                                         | `id bigint` 自增 PK + `package_uuid char(36)` |
| 操作者      | `imported_by_account_id int`                                         | `actor_account_id int`                        |
| 格式版本    | 无独立列；`manifest_json` 的 `$.schema_version` 仅要求 `IS NOT NULL` | 独立 `format_version int unsigned NOT NULL`   |
| 清单        | `manifest_json longtext`                                             | `manifest json`                               |
| 状态        | 单列 `status`（PENDING/RUNNING/SUCCEEDED/PARTIAL/FAILED）            | `check_status` + `import_status` 双列         |
| 其他        | `item_total/item_succeeded/item_failed`、`completed_at`              | 未列这些字段                                  |

- 设计差异核心：字典要求独立 `format_version`，实际以 JSON 内 `schema_version` 承担；两者来源不一致，且实际 CHECK 同样未排除 JSON null。
- 推荐（本轮不实施）：短期沿用 JSON 内 `schema_version` 为唯一来源，并仅在后续授权时把该 CHECK 补成“键存在且非 JSON null”（与四表一致）；若最终以字典为准，则需新增 `format_version` 列并做数据回填与等值约束，属独立迁移，不并入本轮。双源并存不推荐。
- 其他 JSON 字段（`content_submission_revision.payload_snapshot` 等）无明确键必填 CHECK，本轮不无差别收紧。

### 13.6 非实库验证结果

| 检查                 | 命令/范围                                                                                                                                                                     | 结果                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 类型检查             | `npx tsc -p tsconfig.spec.json --noEmit`                                                                                                                                      | 退出 0                          |
| 迁移/契约单测        | `npx jest --runTestsByPath src/infrastructure/database/json-version-check-repair.migration.spec.ts src/infrastructure/database/migration-schema-contract.spec.ts --runInBand` | 2 suites，**20 passed**，退出 0 |
| ESLint（变更 TS）    | 迁移、规格、契约、四 Entity                                                                                                                                                   | 退出 0                          |
| Prettier（变更文件） | 迁移、规格、契约、四 Entity、README                                                                                                                                           | 通过                            |
| `git diff --check`   | 仓库根                                                                                                                                                                        | 通过（无空白错误）              |

候选 SHA-256：

- 迁移 `1775501600000…`：`826647d4ce7e5c8b7dedc1b44a19085abdb442a85a1ecb29d48905e41a6af0f5`
- 迁移规格：`971c1df89a71758816c33bbecc27b807962f07e5a4da8d5098272b05b0155f51`
- 实库 D 规格：`20c61a2135769c0abf36c1e2d23f8cfd74c44260efa9c4de2c0155a88132510b`
- `migration-schema-contract.ts`：`9acc09c1903533a6a5201240ada379795c3fcf4f98f1decab16d8448278239d4`
- `migration-schema-contract.spec.ts`：`c2582f440d0523e04f15e9552c79a05181d765bc6e83eaa9840a6da508c41496`
- `repair-request-revision.entity.ts`：`c1c538c2b2083a75966c7432270d91ef33cca7a1fdef939dd8bac78051b8d811`
- `reference-document-revision.entity.ts`：`ccfa1b6cf4ba336cc2c0385926ca35e50d36bfe8ce1d9420556e8558978af536`
- `sync-conflict.entity.ts`：`199ce1dc641b91f952fa238b5c7341eef3e0632537e9c3a09f8db16a0fd6a8fd`
- `backup-restore-run.entity.ts`：`ebd45a6101d1ffdc3bd1231281ac3b9aefc87104832f27509a1edfc5e2abfbb0`

### 13.7 实库复验计划（已于 2026-11-08 执行，记录见 §13.9）

1. 只读确认目标实例 `server_uuid`、`DATABASE()=lithography_v13_spec`、账号最小权限与保护配置；不触碰其他库。
2. 执行追加迁移：预检应报告四表零违规；若存在违规则按输出的人工修复清单处理，不自动补版本。
3. 核对 `information_schema.CHECK_CONSTRAINTS` 中四条 CHECK 均包含两侧 `IS NOT NULL`、`<> 'NULL'`，repair 另含两处等值。
4. 事务内定向负例：四表合法值通过；before/after、local/cloud、check_snapshot 两侧分别缺键与 JSON null 均被 `3819/HY000` 拒绝；repair 两侧与独立列不等仍被拒绝；类型错误不被新增整数类型限制误伤（仅按既有等值语义判定）。
5. 重复执行迁移验证幂等（约束存在则 DROP/ADD，不存在则 ADD）。
6. 复核结构、38 条迁移记录、种子、业务行与夹具零残留；记录前后快照哈希。
7. 不进入 E、完整 core、管理员初始化或 Redis；不 commit/push。

### 13.8 停止点

实现与离线验证完成后曾在此停止；后续授权执行记录见 §13.9。

### 13.9 实库执行与复验（2026-11-08，已授权）

**目标核验（只读）**

- `127.0.0.1:3306`，`server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`，`DATABASE()=lithography_v13_spec`，MySQL `8.0.46-0ubuntu0.24.04.4`。
- 执行前 status：历史 **37**、仓库 **38**、pending **1**；前 37 条聚合 SHA-256 `c4a2e480e5b4966961dd1992b6aa712b38ffac466f195840f506bed642a6e795` 保持不变；38 条候选聚合 `d14b13bda839f9c45d7bc2a40b550986622d08b7758bd32c03a71bb0f101f46b`；第 38 条指纹 `826647d4…`。

**执行命令与退出码**

| 步骤                   | 命令（配置均为受保护文件）                                                                                                          | 退出码 | 结果                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| status                 | `npm run migration:status -- --config-file …/lithography_v13_spec.env --database lithography_v13_spec`                              | 0      | 37/38/1 pending                                                                          |
| upgrade                | `npm run database:deploy -- --mode upgrade --config-file … --database lithography_v13_spec --confirm-database lithography_v13_spec` | 0      | 仅执行 `1775501600000`，终态 38                                                          |
| verify                 | `npm run migration:verify -- --config-file … --database lithography_v13_spec`                                                       | 0      | 终态校验通过                                                                             |
| 定向 2.4（首次）       | `npx jest … -t '2.4 JSON 快照版本契约'`                                                                                             | 1      | 19 passed / 5 failed / 51 skipped；失败为测试夹具 `record_uuid` 超长（1406），非约束失败 |
| 定向 2.4（修正夹具后） | 同上                                                                                                                                | 0      | **24 passed / 0 failed / 51 skipped**                                                    |
| 全量 D 规格            | `npx jest src/infrastructure/database/v13-db-verification.spec.ts --runInBand`                                                      | 0      | **75 passed / 0 failed / 0 skipped**（真实库 73、离线元数据 2）                          |
| 幂等 upgrade           | 同 upgrade                                                                                                                          | 0      | “pending 0 条 / 无变化”                                                                  |

- 原先两条失败用例（repair 缺键、reference JSON null）现在均按目标 CHECK 的 `ER_CHECK_CONSTRAINT_VIOLATED / 3819 / HY000` 拒绝；其余负例均先保证其他输入合法，错误信息命中目标约束名。
- 新增 2.4 覆盖：repair/reference 的 before/after 单侧缺键与单侧 JSON null、repair 单侧等值不符、sync_conflict 的 local/cloud 单侧缺键与单侧 JSON null、backup_restore_run 的缺键与 JSON null，以及四表合法值。

**前后快照**

- 迁移前快照：`c13-pre-upgrade.json`，哈希 `7ef8fd4877a1ad22fad31132da797ef9cb3c09d27549c414ffd407ae54ebee41`，52 表、37 条迁移、业务行 2。
- 迁移后快照：`c13-post-upgrade.json`，哈希 `2816bf8b807f58646d1d293787d9ba61d1164814923fdb351841f915dd41b3d8`，52 表、38 条迁移、业务行 2。
- 幂等后快照：`c13-post-idempotent.json`，哈希仍为 `2816bf8b807f58646d1d293787d9ba61d1164814923fdb351841f915dd41b3d8`。
- 差异仅：`migrations` 37→38；四条 CHECK 表达式按目标重建。列、索引、外键、外键规则、表选项、种子（organization/local_installation/base_user_account）与业务行数全部不变。

**保留状态与残留**

- 迁移历史 38（最后一条 `FixJsonSnapshotVersionChecksForV131775501600000`），CHECK 总数 177。
- 临时触发器 0、活动事务 0；`information_schema.processlist` 仅本次检查连接，无应用残留连接。
- `g2` 账号/组织残留 0；夹具全部在回滚事务中或由受保护清理器回收。
- AUTO_INCREMENT：迁移前快照仅记录列属性、未采集计数器；迁移后 `reference_document_revision=7`、`repair_request_revision=18`（本轮受保护测试事务插入推进，未重置）；`sync_conflict`/`backup_restore_run` 为字符串主键，AUTO_INCREMENT 为 NULL。
- 未修改 init/up30/up31；未执行 down、未 DROP、未清库；未 commit/push，未进入 E、完整 core、管理员初始化或 Redis。

### 13.10 `record_package_import` 字段对照（未关闭事项）

| 维度        | 字典要求                                      | 实际迁移                                                    | Entity                  | 消费者      | 建议                                                 |
| ----------- | --------------------------------------------- | ----------------------------------------------------------- | ----------------------- | ----------- | ---------------------------------------------------- |
| 主键/包标识 | `id bigint` 自增 PK + `package_uuid char(36)` | `package_id char(36)` 作主键                                | `packageId` 主键        | 仅注册/测试 | 若保留当前实现需显式批准；否则独立迁移对齐字典       |
| 账号字段    | `actor_account_id int`                        | `imported_by_account_id int`（FK 到账号）                   | `importedByAccountId`   | 无读写服务  | 统一命名或补兼容映射，需单独裁决                     |
| 版本来源    | 独立 `format_version int unsigned NOT NULL`   | 无独立列；`manifest_json.$.schema_version` 仅 `IS NOT NULL` | 无 `formatVersion` 字段 | 无读写服务  | 短期沿用 JSON 来源并补非 JSON null；长期按字典新增列 |
| manifest    | `manifest json`                               | `manifest_json longtext`                                    | `manifestJson`          | 无读写服务  | 与版本来源一并裁决                                   |
| 状态拆分    | `check_status` + `import_status` 双列         | 单列 `status`（含 SUCCEEDED/PARTIAL 等）                    | `status`                | 无读写服务  | 若需区分校验与导入阶段，需独立迁移                   |
| 其他字段    | 设计未列                                      | `item_total/item_succeeded/item_failed`、`completed_at`     | 对应列存在              | 无读写服务  | 作为实现补充记录，不据此批准覆盖验收                 |

- 结论：`record_package_import` 的字段与字典存在结构差异，当前实现**未被批准为最终设计**，仍属最终设计覆盖验收的未关闭事项；本轮未修改该表、未新增 `format_version` 列。

### 13.11 口径更新与历史保留

- README：候选迁移 7 条（`1775501000000—1775501600000`），终态 38 条；S2/S3 已在 `lithography_v13_spec` 完成第 38 条升级与 D 规格复验。
- S2/S4：已由“未执行”更新为实库执行结果；第十二轮两项失败与首次定向“19 passed/5 failed”作为历史保留，不覆盖、不改写为全程一次通过。
- 下一步停止，等待 E 阶段指令；不 commit/push。

## 第十四轮：S4-E V13 新增表清理实库专项（2026-11-08）

| 项       | 值                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------- |
| 执行日期 | 2026-11-08（Asia/Shanghai）                                                                       |
| 执行范围 | 仅 S4-E：17 张 V13 新增表的清理闭包实库专项                                                       |
| 分支     | `feat/database-v13-deploy`（未切换、未合并、未 rebase）                                           |
| HEAD     | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未 commit）                                           |
| 数据库   | 仅 `127.0.0.1:3306` / `lithography_v13_spec` / `server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9` |
| 未执行   | 完整 core、管理员初始化、其他验证库升级、Redis、down 迁移、DROP、清库、commit、push               |

### 14.1 执行前核对（只读）

| 检查项             | 结果                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| 实际 `DATABASE()`  | `lithography_v13_spec`（`SELECT DATABASE()` 与 DataSource 双重核对）                                 |
| 实例 `server_uuid` | `909f9587-9fce-11f1-a353-00e0709ef3a9`，与 `E2E_EXPECTED_SERVER_UUID` 一致                           |
| 白名单             | `E2E_ALLOWED_DB_NAMES=lithography_v13_spec`；`assertAllowedE2eDatabase` 通过                         |
| 迁移历史           | **38** 条；最后一条 `FixJsonSnapshotVersionChecksForV131775501600000`                                |
| 正式 `verify`      | 第十三轮已执行通过（`npm run migration:verify -- --config-file …/lithography_v13_spec.env`，退出 0） |
| 触发器 / 活动事务  | `information_schema.triggers=0`、`information_schema.innodb_trx=0`                                   |
| 基线业务行         | `organization=1`、`local_installation=1`；17 表与外部父表均 0，无此前测试夹具                        |
| AUTO_INCREMENT     | 采集后单独记录，**不重置**（见 §14.7）                                                               |

### 14.2 冻结指纹（本轮前后一致）

| 对象                         | 命令                                                                                                                                       | 值                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 完整 HEAD                    | `git rev-parse HEAD`                                                                                                                       | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`                                                                           |
| 分支                         | `git branch --show-current`                                                                                                                | `feat/database-v13-deploy`                                                                                           |
| 工作区（porcelain 排序聚合） | `git status --porcelain \| sort \| sha256sum`                                                                                              | `b6008e34cd817b9c42a94b3fe3582c9e8ff21212903aae42f94234b26c99ad94`，64 项                                            |
| 全量 tracked diff            | `git diff \| sha256sum`                                                                                                                    | `d1723d21c42454891d56ee0dd06b29ea2abe13a1ac3c6eccc29b723165a5fd14`                                                   |
| 未跟踪（排除 ignored）       | `git ls-files -o --exclude-standard \| sort \| sha256sum`                                                                                  | `0e51ab19b4899e29621c3e1014539358cf0ca4e49e990b219afdfcbab51fbc21`，47 项                                            |
| 未跟踪（含 ignored）         | `git ls-files -o \| sort \| sha256sum`                                                                                                     | `644dade86c3b93e9792e19d058cda5abc4dd29df2ce1a4f8ba66f1bc41961853`，92793 项（含 `frontend/node_modules`）           |
| 作用域 diff（后端改动）      | `git diff -- backend/src backend/scripts backend/test backend/package.json \| sha256sum`                                                   | `64188b701e7172ec767324577b1af4b5f5878b76c9eb408689c029c056589886`                                                   |
| 未跟踪 `.ts` 聚合            | `git ls-files -o -- '*.ts' \| sort \| xargs -r sha256sum \| sha256sum`                                                                     | `eb68282170ff00c8b7a90359e9995d0552a5e310cb2c0ba417682af74adf574a`                                                   |
| 38 条迁移聚合                | `find backend/src/infrastructure/database/migrations -maxdepth 1 -name '*.ts' ! -name '*.spec.ts' \| sort \| xargs sha256sum \| sha256sum` | `624c4570ef86873b363370a93b9746355ba0e0b57c46baec430a1f9e5f96f86d`（38 个文件）                                      |
| 新增实库规格                 | `sha256sum …/e2e-scoped-cleanup.v13.realdb.spec.ts`                                                                                        | `c403a81c45fbe237f88ec81fc43f7b9e37998a662e82cfe16a73d47ba2c4290b`                                                   |
| stash                        | `git stash list`                                                                                                                           | 3 条，均未触碰（`pre-merge-pr5-main-sync`、`pr4-wip-before-merge-main-20260923`、`pre-merge-admin-user-management`） |

注：`git ls-files -o` 的含 ignored 聚合随 `node_modules` 扫描顺序不稳定，故以 `--exclude-standard` 版本作为候选指纹。

### 14.3 版本控制覆盖检查

- 结论：**此前无 17 表实库清理规格**。`src/infrastructure/database/e2e-scoped-cleanup.v13.spec.ts` 仅为纯替身（fake manager），不连库。
- 本轮新增 `src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts`，纳入 `src` 的 Jest 采集范围，**默认 `describe.skip`、不创建 DataSource、不建立连接**；显式 `E2E_REAL_DB_SPECS=1` 但许可不全时模块加载即抛错拒绝（不静默跳过）。
- 现有 `test/utils/e2e-scoped-cleanup.e2e-spec.ts`、`-ownership`、`-faults` 面向前旧链资源，默认目标为 `lithography_e2e`，**不在本轮库白名单内，未运行**。

### 14.4 17 表清理覆盖表

清理入口缩写：`G=runGuardedSpecCleanup`（台账精确清理）、`S=runGuardedScopedCleanup`（干扰行/外部父行精确回收）、`D=guardedDirect`（`S` 包裹的单条精确 SQL）。用例编号见 §14.6。

| #   | 表                            | 真实主键                 | 登记事实（不可变归属）                                                                                                                                          | 父引用（发现方向）                                               | 入向引用（闭包方向）                                                               | 清理入口 | 实际执行回归                                                                                                                      | 未覆盖项                                                                                                   |
| --- | ----------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | `stored_file`                 | `file_id` char(36)       | `uploaded_by_account_id`、`owner_organization_id`、`storage_reference`、`original_filename`、`checksum_sha256`、`upload_context_id`                             | organization、account                                            | `repair_request_intake.file_id`、`repair_process_entry.file_id`（无 FK，按列发现） | G/D      | R02 事实漂移拒绝；R04 全量且**最后删除**；R05 注入删除失败回滚；R08 多态外部引用不认领                                            | 其他业务列（如资料/投稿附件）对 `file_id` 的引用未逐一枚举；存储层软删除/多版本语义未覆盖                  |
| 2   | `repair_request_intake`       | `id` int                 | `record_uuid`、`customer_account_id`、`customer_organization_id`、`service_organization_id`、`equipment_model_id`、`error_code`、`fault_description`、`file_id` | organization×2、account、equipment_model、`converted_request_id` | 旧表 `repair_request.intake_id`（FK RESTRICT）                                     | G/D      | R01 子行未登记拒绝；R03 集合外工单拒绝；R04 解环后回收；R05 回滚；R07a 解环恰 1 次；R07b 额外引用零解环；R08 作为外部 intake 保留 | 分析状态机（`analysis_status`/`analysis_generation`）多代次；`uk_repair_request_intake_converted` 冲突路径 |
| 3   | `intake_analysis_attempt`     | `id` int                 | `intake_id`、`generation_no`（uk 即归属）                                                                                                                       | `repair_request_intake`                                          | 无                                                                                 | G/D      | R01 未登记子行拒绝且 DELETE=0；R04 早于 intake、1 行；R05 首个 DELETE 并回滚                                                      | `generation_no>0` 多代次；失败/重试状态流转                                                                |
| 4   | `repair_process_entry`        | `id` int                 | `entry_uuid`、`request_id`、`author_account_id`、`file_id`                                                                                                      | `repair_request`、account、`stored_file`                         | 无                                                                                 | G/D      | R04 早于 request/stored_file；R05 回滚；R07b 集合外行经 `request_id` 触发拒绝                                                     | `time_source=DEVICE` 分支、`version_no` 多版本、正文修订                                                   |
| 5   | `ai_message_analysis`         | `question_uuid` char(36) | `conversation_id`、`question_message_id`、`answer_message_id`                                                                                                   | 无（父 `ai_conversation`/`ai_message` 不在范围，不按父发现）     | 无                                                                                 | G        | R04 按字符串主键删除；纯替身“父行不在范围仅凭事实核验”；R09 零残留                                                                | 状态机 `PENDING→…`、`answer_message_id` 为 NULL 分支、重试                                                 |
| 6   | `maintenance_report_fault`    | `id` int                 | `report_id`、`fault_uuid`、`branch_kind`、`step_code`、`source`                                                                                                 | 无（父 `maintenance_report` 不在范围）                           | 无                                                                                 | G        | R04 只删登记行、父报告保留；纯替身“只按登记 ID”；R09                                                                              | `branch_kind=DEVICE`、`step_code` 非空、`status` 流转                                                      |
| 7   | `repair_request_revision`     | `id` int                 | `request_id`、`revision_no`、`actor_account_id`、`schema_version`                                                                                               | `repair_request`、account                                        | 无                                                                                 | G        | R04 先于 request 删除；R09                                                                                                        | 多 `revision_no`；CHECK 拒绝对照由 D 规格覆盖，本专项不重复                                                |
| 8   | `reference_document_revision` | `id` int                 | `document_id`、`revision_no`、`actor_account_id`                                                                                                                | `reference_document`、account                                    | 无                                                                                 | G        | R04 先于 document 删除；R09                                                                                                       | 多修订号；快照版本 CHECK 由 D 规格覆盖                                                                     |
| 9   | `local_account_authorization` | `id` int                 | `installation_id`、`account_id`、`organization_id`（uk）                                                                                                        | organization、account                                            | 无                                                                                 | G        | R04；R09                                                                                                                          | `authorization_status=REVOKED` 路径；三元组唯一约束冲突                                                    |
| 10  | `local_company_setting`       | `id` int                 | `installation_id`、`organization_id`（uk）、`setting_source`                                                                                                    | organization                                                     | 无                                                                                 | G        | R04；R09                                                                                                                          | `is_current=1` 活跃唯一约束；双来源切换                                                                    |
| 11  | `sync_receipt`                | `receipt_id` char(36)    | `record_uuid`、`organization_id`、`resource_type`、`version_no`、`source_system`（uk）                                                                          | organization                                                     | `record_package_item.receipt_id`（可空）                                           | G        | R04（item 先删）+ R06 重复执行 0 行                                                                                               | `receipt_status` 状态机；五元组唯一冲突；`receipt_id IS NULL` 分支                                         |
| 12  | `sync_conflict`               | `conflict_id` char(36)   | `record_uuid`、`organization_id`、`resource_type`、`version_no`                                                                                                 | organization、`confirmed_by_account_id`                          | 无                                                                                 | G        | R04；R09                                                                                                                          | `confirmed` 路径（确认人/时间非空）与 CHECK 组合                                                           |
| 13  | `record_package_import`       | `package_id` char(36)    | `organization_id`、`imported_by_account_id`、`manifest_checksum`                                                                                                | organization、account                                            | `record_package_item.package_id`                                                   | G        | R04（item 先删）；R09                                                                                                             | 条目统计/部分成功状态；**格式版本来源待裁决**（§14.9）                                                     |
| 14  | `record_package_item`         | `id` int                 | `package_id`、`record_uuid`、`resource_type`、`version_no`、`receipt_id`                                                                                        | `record_package_import`、`sync_receipt`                          | 无                                                                                 | G        | R04 早于 package/receipt、1 行                                                                                                    | `result=FAILED` 分支；`receipt_id IS NULL`                                                                 |
| 15  | `backup_asset`                | `backup_id` char(36)     | `run_id`、`organization_id`、`storage_reference`、`file_sha256`、`local_cleanup_run_id`                                                                         | organization                                                     | `backup_restore_run.backup_id`、`protection_backup_id`（RESTRICT）                 | G        | R04 两条资产、restore 先删；R09                                                                                                   | `local_cleanup_run_id` 非空链路；云/本地状态机；`run_id` 父行（外部）仅保留                                |
| 16  | `backup_restore_run`          | `restore_id` char(36)    | `backup_id`、`protection_backup_id`、`organization_id`、`started_by_account_id`                                                                                 | organization、account、`backup_asset`×2                          | 无                                                                                 | G        | R04 早于 backup_asset；R09                                                                                                        | `SUCCEEDED/FAILED` 状态机；`check_snapshot` 由 D 规格覆盖；同资产多次恢复                                  |
| 17  | `management_audit_event`      | `event_id` char(36)      | `actor_account_id`、`organization_id`、`operation`、`target_type`、`target_id`、`result`                                                                        | organization、account                                            | 无                                                                                 | G        | R04；R09                                                                                                                          | `organization_id IS NULL` 系统事件；追加式不可变仅由“从未 UPDATE”间接证明                                  |

覆盖口径说明：

- **主键形态**：9 张 `int` 主键（2/3/4/6/7/8/9/10/14）由 `deleteByIds` 走 `id`；8 张 char(36) 主键（1/5/11/12/13/15/16/17）由 `deleteByColumnIds` 按真实主键列删除，R04 全部命中并核对 `affectedRows`。
- **事实核验**：17 表全部为事实承载类别；R02 证明“登记 ID + 事实漂移即拒绝”，R04 证明“事实一致才删除”。缺失行按已回收处理（幂等），R06 证明。
- **父引用与入向引用**：`collectByParent`（父在范围、子未登记→拒绝）由 R01 代表；FK RESTRICT 反向引用由 R03（`repair_request.intake_id`）代表；无 FK 的业务列引用由 R08（`intake.file_id`→`stored_file`）与 R07b（`entry.request_id`→`repair_request`）代表。
- **共享入口不代证专用/恢复入口**：`S` 与 `D` 仅用于 afterAll 外部父行及干扰行回收；它们通过不代表**专用恢复路径**已通过。恢复路径由 R02（恢复事实后经台账回收）、R05（回滚后二次 `G` 完整回收）、R06（对已清空台账重复 `G`）单独证明。
- **未机械复制 17 套**：同类 int 主键、无入向引用、单一父引用的表（6/9/10/14 等）共用 R04 的逐表 `affectedRows` 与顺序断言；特殊依赖（解环、char(36) 父键、可空 FK、多态列、外部父行保留）各有独立场景。

### 14.5 新增最小实库规格要点

- 文件：`backend/src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts`（未跟踪新增，未修改任何既有实现）。
- 门禁：`E2E_REAL_DB_SPECS=1` ∧ `E2E_ALLOW_PHYSICAL_CLEANUP=1` ∧ `E2E_REAL_DB_NAME`；`beforeAll` 再核 `assertAllowedE2eDatabase`、`assertManagerOnExpectedE2eDatabase`、`@@server_uuid`。
- 测试自身安全：
  - CREATE/INSERT 成功后**立即**登记真实 ID 与不可变事实；回读只做核验，不重新认领。
  - 外部夹具（organization/account/model/maintenance_report/ai_conversation/ai_message×2/local_backup_run）全部本轮创建，使用**独立 `externalLedger`**；用例台账无法删除它们。
  - 造数与断言从创建前进入 `try/finally`；主错误、干扰行回收错误、台账回收错误、DS 关闭错误分别保留，必要时 `AggregateError` 汇总。
  - 故障注入只用可恢复 Proxy（包装 `transaction` 的 `manager.query`），**不创建任何临时触发器**；`information_schema.triggers` 前后均为 0。
  - 归属不明/额外引用/收尾失败时立即停止，不扩大删除范围，不关闭 FK/CHECK。
- 负例公共断言：`recorder.calls` 为空（零 UPDATE 零 DELETE）、错误信息命中目标规则、`innodb_trx=0` 且连接池可复用。

### 14.6 真实数据库回归结果

执行命令（配置来自受保护文件，未写入任何凭据）：

```bash
cd /home/gandiantx/lithography-platform/backend
set -a && . /home/gandiantx/secure/lithography-v13/configs/lithography_v13_spec.env && set +a
E2E_REAL_DB_SPECS=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
E2E_REAL_DB_NAME=lithography_v13_spec E2E_ALLOWED_DB_NAMES=lithography_v13_spec \
E2E_EXPECTED_SERVER_UUID=909f9587-9fce-11f1-a353-00e0709ef3a9 \
env -u LD_LIBRARY_PATH npx jest --runTestsByPath \
src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts --runInBand
```

| 运行                                                   | passed | failed     | skipped | 退出码 | 证据                                           |
| ------------------------------------------------------ | ------ | ---------- | ------- | ------ | ---------------------------------------------- |
| 实库专项（修复后 + 证据运行，连续两次）                | 10     | 0          | 0       | 0      | `…/evidence/e/s4e-realdb-spec.log`             |
| 纯替身回归 `e2e-scoped-cleanup.v13.spec.ts`            | 29     | 0          | 0       | 0      | `…/evidence/e/s4e-fake-spec.log`               |
| 默认门禁（不设 `E2E_REAL_DB_SPECS`）                   | 0      | 0          | 10      | 0      | 本轮复核：`1 skipped suite / 10 skipped tests` |
| 显式请求但许可不全（仅 `E2E_REAL_DB_SPECS=1`）         | 0      | 1 套件拒绝 | 0       | 1      | 模块加载抛“许可不全…明确拒绝，不静默跳过”      |
| `npm run typecheck`（build + tools）                   | —      | —          | —       | 0      | 本轮前已执行                                   |
| spec 类型检查 `npx tsc -p tsconfig.spec.json --noEmit` | —      | —          | —       | 0      | 本轮前已执行                                   |

八类场景与证据（R01—R09，共 10 个 `it`）：

1. **父行在范围、子行未登记**（R01）：`repair_request_intake` 已登记、`intake_analysis_attempt` 故意未登记 → 首删前拒绝（命中“该子行未登记归属证据”），`calls=[]`，两表逐字段快照不变；干扰 attempt 由 `D` 精确回收。
2. **已登记事实被改写**（R02）：`stored_file.original_filename` 漂移 → 拒绝“本轮登记事实漂移”，`calls=[]`，快照不变；先恢复事实再经台账回收。
3. **集合外记录引用本轮目标**（R03）：外部 `repair_request.intake_id` 指向本轮 intake → 拒绝“工单经 intake_id 引用…未登记归属证据”，零 DELETE 零解环，目标与外部工单逐字段不变。
4. **合法精确清理**（R04）：17 表全量 + `stored_file`/`sync_receipt` 等 8 个字符串主键 + 9 个整数主键；首条调用为 `UPDATE repair_request SET intake_id=NULL`（affected=1）；逐表 `affectedRows` 精确（`backup_asset=2`，其余 1）；顺序断言 attempt<intake、item<package、restore<asset、fault<stored_file、stored_file<request、document<organization；17 表与 `repair_request`/`reference_document` 计数归零。
5. **后序删除失败**（R05）：Proxy 在 `stored_file` DELETE 前抛 `INJECTED_DELETE_FAILURE:stored_file`；实际发生 1 次解环 UPDATE + 3 次 DELETE（attempt→entry→intake），全部回滚，5 表逐字段与回滚前一致、`intake_id` 仍指向原 intake；`innodb_trx=0`；随后二次 `G` 完整回收成功。
6. **清理完成后重复执行**（R06）：第二次执行所有调用均为 DELETE 且 `affectedRows===0`，无 UPDATE；种子、38 迁移、触发器数量与 17 表零残留不变。
7. **intake↔repair_request 循环引用**（R07a/R07b）：合法解环恰 1 次 UPDATE（affected=1）后回收；额外引用（集合外 `repair_process_entry.request_id` 指向本轮 request）→ 零 UPDATE 零 DELETE、`intake_id` 未被置空、三表逐字段不变。
8. **多态 `stored_file` 引用**（R08）：集合外 intake 通过业务列 `file_id` 引用本轮文件（无 FK 可证）→ 按登记事实核验拒绝，不自动认领；文件与外部 intake 不变。

负例四项同时核对：破坏性调用次数（0 或精确 N）、目标与外部记录逐字段不变（`SELECT *` JSON 快照 `toEqual`）、事务已结束（`innodb_trx=0`）、连接未悬挂（池上 `SELECT 1` 通过）。

失败历史保留：首跑 `7 passed / 3 failed`（R06/R09 基线用 `rowsOf` 捕获 `Date` 与 `snapshotRows` 的 ISO 字符串不一致；R07b 误用 `uk_repair_request_intake_converted` 制造额外引用触发重复键）。最小修复为基线统一 `snapshotRows`/`plainRows` 归一化，并把额外引用改为集合外 `repair_process_entry`；未修改断言期望以凑通过。

### 14.7 清理后对照

| 检查项                       | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 快照前后哈希                 | `s4e-pre-snapshot.json` 与 `s4e-post-snapshot.json` 均 `2816bf8b807f58646d1d293787d9ba61d1164814923fdb351841f915dd41b3d8`（`SAME`）                                                                                                                                                                                                                                                                                                                                                                                     |
| 17 表残留                    | 全 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 外部父表                     | `repair_request`、`reference_document`、`maintenance_report`、`ai_conversation`、`ai_message`、`local_backup_run` 全 0                                                                                                                                                                                                                                                                                                                                                                                                  |
| 账号/机型/组织               | `base_user_account`、`base_user_info`、`equipment_model` 全 0；`organization=1`、`local_installation=1`（仅种子）                                                                                                                                                                                                                                                                                                                                                                                                       |
| 残留扫描                     | `S4E%` 组织/工单/机型均为 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 迁移/结构                    | `migrations=38`、`triggers=0`、`active_trx=0`；未 DDL、未 down、未 DROP                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AUTO_INCREMENT（**未重置**） | `ai_conversation=13`、`ai_message=7`、`base_user_account=13`、`base_user_info=13`、`equipment_model=5`、`intake_analysis_attempt=11`、`local_account_authorization=15`、`local_backup_run=28`、`local_company_setting=13`、`maintenance_report=36`、`maintenance_report_fault=7`、`organization=7`、`record_package_item=11`、`reference_document=29`、`reference_document_revision=7`、`repair_process_entry=6`、`repair_request=36`、`repair_request_intake=36`、`repair_request_revision=18`；char(36) 主键表为 NULL |

本轮新增文件（仅 1 个，均未跟踪、未 commit）：

- `backend/src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts`

未修改：`test/utils/e2e-scoped-cleanup.ts`、`test/utils/e2e-db-guard.ts`、任何 Entity/Migration/约束、`package.json`。

### 14.8 尚未覆盖项

- 状态机路径：`analysis_status`/`sync` 状态流转、`authorization_status=REVOKED`、`is_current=1`、`backup` 云/本地状态、`record_package_item.result=FAILED`。
- 多代次/多修订号：`intake_analysis_attempt.generation_no>0`、`revision_no>1`、同资产多次恢复。
- 特殊分支：`repair_process_entry.time_source=DEVICE`、`maintenance_report_fault.branch_kind=DEVICE`/`step_code` 非空、`organization_id IS NULL` 的系统审计事件。
- 多态归属的应用层校验（`business_type`/`business_id` 语义）未被本专项以 SQL 证明；仅覆盖“业务列引用必须已登记”的拒绝面。
- 既有前旧链清理入口（`test/utils/e2e-scoped-cleanup.e2e-spec.ts` 等）目标库为 `lithography_e2e`，本轮未运行，故其与 17 表的组合回归仍缺证据。
- `reference_document`/`reference_document_case_detail` 作为父链只通过 R04 的代表路径覆盖，未单独造多文档/多详情场景。

### 14.9 `record_package_import` 待裁决事项（未关闭）

- 字典要求独立 `format_version int unsigned NOT NULL`；实际迁移无独立列，仅 `manifest_json.$.schema_version` 存在性检查。本轮**未新增列**、未修改该表，继续作为最终设计覆盖验收的未关闭事项，处置方案仍为：独立迁移对齐字典，或显式批准 JSON 来源并补齐非 JSON null 防护。
- 相关字段差异（`package_id` 主键、`imported_by_account_id` 命名、`manifest_json longtext`、单列 `status`）见 §13.10，本轮不变。

### 14.10 停止点

- 已完成 S4-E 全部执行与复验；未进入完整 core、管理员初始化、其他验证库升级、Redis。
- 未 commit、未 push、未 DROP、未清库、未执行 down 迁移；工作区、未跟踪文件与 3 条 stash 保持原样。

## 第十五轮：第 39 条迁移——记录包检查/导入状态（2026-11-08，未写库）

### 15.1 范围与冻结决定

| 项           | 值                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 执行范围     | 仅第 39 条迁移的代码、测试与文档；不写库、不升级目标库、不跑 D/E 实库、不跑完整 core、不 commit、不 push               |
| 分支/HEAD    | `feat/database-v13-deploy` / `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未改变）                                      |
| 前 38 条迁移 | 不修改；逐文件聚合指纹与 §14.2 一致（见 §15.6）                                                                        |
| 本轮解决     | §14.9 的 `record_package_import` 未关闭事项；不新增独立 `format_version`，以 `manifest_json.schema_version` 为单一来源 |
| 本轮不改     | `package_id` 主键、`imported_by_account_id`、`manifest_json` 列名/类型、既有 FK、条目四元组 UK                         |

### 15.2 P0 状态组合（冻结）

| 层级     | 状态字段       | 合法值                                                      | 数据库职责                                                     | usecase 职责                                     |
| -------- | -------------- | ----------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| 包检查   | `check_status` | `NULL` 历史未判定／`PENDING` 未完成／`PASSED`／`REJECTED`   | 枚举域 + 与导入阶段组合约束                                    | 生成结论并绑定具体包版本/清单摘要                |
| 包导入   | `status`       | `PENDING`／`RUNNING`／`SUCCEEDED`／`PARTIAL`／`FAILED`      | 枚举域 + 组合约束                                              | 推进阶段、统计计数、完成时间                     |
| 条目检查 | `check_result` | `NULL` 未完成或历史未判定／`PASSED`／`REJECTED`             | 枚举域 + 组合约束                                              | 逐条检查结论                                     |
| 条目导入 | `result`       | `NULL` 未执行／`SUCCEEDED`／`FAILED`／`SKIPPED`／`CONFLICT` | 枚举域 + `SUCCEEDED` 要求检查通过；`REJECTED` 禁止任何导入结果 | 写入/重复跳过/冲突/失败判定；`FAILED` 必须写原因 |

- 检查未完成（`PENDING`）或拒绝（`REJECTED`）**不能表示导入成功**：`REJECTED` 只允许 `status=PENDING`，`PENDING` 检查不允许开始导入。
- 包身份：`package_id` 既是稳定包编号也是主键；**同包重试必须复用该 ID**。DB 只能保证主键/唯一键，不能证明“文件内容与编号绑定”，由 usecase 负责。
- 重复导入：条目 `uk_record_package_item_scope(package_id, record_uuid, resource_type, version_no)` 识别同包同条重复。
- 无法解析文件：需求未要求独立留痕，**本轮不新增审计功能**。

### 15.3 迁移内容（第 39 条，`1775501700000`）

1. 校验两张表存在；
2. **任何 ALTER 前**预检：非法 JSON、缺 `schema_version`、`schema_version` 为 JSON null、非法导入状态、checksum 非 64、计数越界；重跑时追加非法检查状态/组合、条目非法结果/失败无原因/非法检查结果/组合；
3. 包表单条 ALTER：`ADD COLUMN check_status` + 重建 `chk_record_package_import_manifest`（`JSON_VALID` + 键存在 + `JSON_TYPE <> 'NULL'` + checksum 64）；
4. 仅按可证明事实回填包 `check_status='PASSED'`（`RUNNING/SUCCEEDED/PARTIAL`）；
5. 包组合约束：`REJECTED`→仅 `PENDING`；`PENDING`→仅 `PENDING`；`RUNNING/SUCCEEDED/PARTIAL`→必须 `PASSED`；历史 `NULL` 只允许 `PENDING/FAILED`；
6. 条目表单条 ALTER：`result` 改可空、`ADD COLUMN check_result`、重建结果域含 `CONFLICT`；
7. 条目检查结果域约束（独立 ALTER，避免新列与引用约束同句）；
8. 仅按可证明事实回填条目 `check_result='PASSED'`（`result='SUCCEEDED'`）；
9. 条目组合约束：`REJECTED`→仅 `result=NULL`；`SUCCEEDED`→必须 `PASSED`。

**旧数据保护**：未把历史完成记录统一回填成“检查待处理”；无法证明的行保持 `NULL`（读取语义为“历史未判定”）。预检违规时零 ALTER、输出表/规则/计数/定位 ID。

**部分失败**：跨表 DDL 隐式提交，错误文本列出“已完成步骤”，并说明不能整体回滚；`DROP CONSTRAINT` 先查存在性，
列/约束存在时跳过，可重跑续跑。`down` 预检同时拒绝 `result IS NULL` 与 `result='CONFLICT'`，避免恢复旧域时的部分降级。

### 15.4 同步的结构与契约

- Entity：`record-package-import.entity.ts` 新增 `check_status`；`record-package-item.entity.ts` 新增 `check_result`、`result` 改为可空。
- 契约：`migration-schema-contract.ts` 登记两列（`since=1775501700000`，允许为空）、4 个新约束，`record_package_item.result` 移除 `notNull`。
- 契约单测：`migration-schema-contract.spec.ts` 增加两条用例。
- 迁移单测：新增 `record-package-state.migration.spec.ts`（7 用例）。
- 实库规格：`v13-db-verification.spec.ts` 新增 `describe('2.5')`（12 用例，默认 skip，待实库授权）。

### 15.5 离线验证结果（2026-11-08）

| 命令                                                                                  | 结果                                                     | 退出码 |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------ |
| `npm run typecheck`（build + tools）                                                  | 通过                                                     | 0      |
| `npx tsc -p tsconfig.spec.json --noEmit`                                              | 通过                                                     | 0      |
| `npx jest … record-package-state.migration.spec.ts migration-schema-contract.spec.ts` | 2 suites / **20 passed**                                 | 0      |
| `npx jest … 五个规格（迁移/契约/实库规格/部署/清理）`                                 | 5 suites / **59 passed / 85 skipped**（skip 为实库门禁） | 0      |
| ESLint（无 `--fix`）变更文件                                                          | 0 error / 1 warning（`up` 函数行数）                     | 0      |
| Prettier 变更文件                                                                     | 已格式化（3 个文件 unchanged）                           | 0      |
| `npm run capability:docs:check`                                                       | passed                                                   | 0      |
| `npm run lint:architecture-fixtures`                                                  | passed                                                   | 0      |
| `npm run check:entity-scope`                                                          | PASS（Entity/Migration 相对 base 无已跟踪 diff）         | 0      |
| `git diff --check`                                                                    | 无空白错误                                               | 0      |

### 15.6 指纹与迁移总数

| 项                                       | 命令                                                                                                                                                                | 值                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 前 38 条迁移聚合（路径前缀 `backend/…`） | `find backend/src/infrastructure/database/migrations -maxdepth 1 -name '*.ts' ! -name '*.spec.ts' \| sort \| grep -v 1775501700000 \| xargs sha256sum \| sha256sum` | `624c4570ef86873b363370a93b9746355ba0e0b57c46baec430a1f9e5f96f86d`（与 §14.2 完全一致，38 文件） |
| 全 39 条迁移聚合                         | 同上，不排除第 39 条                                                                                                                                                | `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`（39 文件）                    |
| 迁移目录文件总数                         | `ls …/*.migration.ts \| wc -l`                                                                                                                                      | `39`                                                                                             |

> 指纹包含 `sha256sum` 输出的路径文本，必须与 §14.2 相同的仓库根目录前缀比较；上表已按该口径复算。

### 15.7 本轮精确 diff（未 commit）

新增（本轮相关）：

- `backend/src/infrastructure/database/migrations/1775501700000-add-record-package-check-and-import-result-states-for-v13.migration.ts`
- `backend/src/infrastructure/database/record-package-state.migration.spec.ts`
- `backend/plans/database-v13-deploy/S1-word-revision-diff-39.md`

修改（相对工作区既有状态；仅列本轮触碰文件）：

- `backend/src/infrastructure/database/migration-schema-contract.ts`：新增两列登记、4 个约束、`result` 去掉 `notNull`、迁移归属。
- `backend/src/infrastructure/database/migration-schema-contract.spec.ts`：时间戳与两条新用例。
- `backend/src/infrastructure/database/v13-db-verification.spec.ts`：头部映射与 `describe('2.5')` 12 用例。
- `backend/src/modules/lithography/entities/record-package-import.entity.ts`：新增 `check_status`、`status` 注释。
- `backend/src/modules/lithography/entities/record-package-item.entity.ts`：新增 `check_result`、`result` 可空。
- `backend/plans/database-v13-deploy/S1-object-and-field-dictionary.md`：§4.13/§4.14 按实际实现校正并注明等价命名。
- `backend/plans/database-v13-deploy/S1-contracts-and-compatibility.md`：新增 §11 状态契约。
- `backend/plans/database-v13-deploy/S1-open-issues.md`：OI-14、§5 分类、§7 第 39 条状态。
- `backend/plans/database-v13-deploy/S3-deployment-sop.md`：升级/失败恢复补充第 39 条。
- `backend/plans/database-v13-deploy/execution-log.md`：本节。

未触碰：前 38 条迁移文件、`1775501400000`/`1775501600000`、既有 FK/UK、`test/utils/e2e-scoped-cleanup.ts` 的归属证明逻辑、目标数据库。

### 15.8 阴影项与停止点

- **未执行**：目标库升级、D/E 实库规格、完整 core、`database:deploy`、`migration:run`。
- **实库复验方案（待授权）**：在 `lithography_v13_spec` 上按 S3 SOP 备份后执行 `database:deploy --mode=upgrade`；
  先只读核对 `migrations=39`、两列/4 约束存在、旧行 `check_status/check_result` 回填统计；再运行
  `E2E_REAL_DB_SPECS=1 … jest v13-db-verification.spec.ts` 的 `describe('2.5')`，最后跑完整 core。
- **未决**：usecase 侧“同文件内容不得换号”的实现、无法解析文件是否留痕、历史 `NULL` 展示文案（见 OI-14）。
- 本轮未写库、未 commit、未 push；工作区与 3 条 stash 保持原样。

## 第十六轮：第 39 条定向实库验收（2026-11-08）

### 16.1 范围与冻结

| 项        | 值                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------ |
| 授权写入  | `127.0.0.1:3306`，`server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`，仅 `lithography_v13_spec`        |
| 分支/HEAD | `feat/database-v13-deploy` / `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未 commit）                   |
| 前 38 条  | 逐文件聚合 `624c4570ef86873b363370a93b9746355ba0e0b57c46baec430a1f9e5f96f86d`（与 §14.2 一致，未修改） |
| 全 39 条  | 聚合 `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`（39 文件）                     |
| 未进入    | 完整 core、管理员初始化、Redis、其他验证库、down/DROP/清库                                             |

### 16.2 执行前核对（全部通过后才升级）

- 实例与库：`DATABASE()=lithography_v13_spec`，`@@server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`，MySQL `8.0.46-0ubuntu0.24.04.4`。
- 迁移：历史 38、仓库 39、pending 1（仅第 39 条）；`migrations` 表查询计数 38。
- 基线：52 张基表；`record_package_import=0`、`record_package_item=0`；`organization=1`、`local_installation=1`、`base_user_account=0`；`triggers=0`、`innodb_trx=0`；与 S4-E 收口一致。
- 回填依据：功能 V5.3 R072 段落 1803“前置条件：所选包及条目检查合格”，1809—1812 导入流程与四类结果，1811“检查合格不等于成功”。包 `RUNNING/SUCCEEDED/PARTIAL` 代表已进入导入阶段、条目 `SUCCEEDED` 代表已写入，二者均以检查合格为前提，故回填 `PASSED` 有文档依据，未仅凭状态名称推断。
- NULL 安全：包侧组合约束全部使用 `COALESCE(check_status,'')`，无 UNKNOWN 放行；条目侧 `SUCCEEDED` 要求 `COALESCE(check_result,'')='PASSED'`，`REJECTED` 显式要求 `result IS NULL`；历史 `NULL` 的允许范围与新写入规则分离。实际 `check_clause` 已从 `information_schema.check_constraints` 核对。
- 约束替换/续跑：包与条目各用单条 ALTER 完成“加列/改列 + 重建同表约束”；`DROP CONSTRAINT` 先查存在性；正式入口 `database:deploy --mode upgrade` 先执行历史/结构预检，未直接调用 `migration.up`。

### 16.3 备份与快照

- 备份：`/home/gandiantx/secure/lithography-v13/backups/lithography_v13_spec-pre39-20261108-192516.sql.gz`，文件 `0600`、目录 `0700`；`mysqldump` 退出码 0；SHA-256 `779298b7261216c288cb5a23cb200dd32e10c5c9adb3b564e5e1baf76419dcad`。
- 升级前快照：`c39-pre-upgrade.json`，SHA-256 `8c436bd64238740f70dbfe901ce7a4f75eeb8abd842d79f7b36e234430ee05c2`。
- 升级后快照：`c39-post-upgrade.json`，SHA-256 `651861bf29ac89e586b7f067d8f63c85450c60a12e0be91965f0877c36f59ab0`。
- 快照含全字段结构（列/索引/外键/FK 规则/CHECK/表选项）、迁移、全表计数、种子完整行。

### 16.4 正式升级命令与退出码

| 步骤         | 命令（均带显式 `--config-file`/`--database`/`--confirm-database`）                            | 结果                          | 退出码 |
| ------------ | --------------------------------------------------------------------------------------------- | ----------------------------- | ------ |
| status       | `npm run migration:status -- --config-file … --database lithography_v13_spec`                 | 历史 38 / 仓库 39 / pending 1 | 0      |
| upgrade      | `npm run database:deploy -- --mode upgrade --config-file … --database … --confirm-database …` | 仅执行第 39 条；业务表 51 张  | 0      |
| verify       | `npm run migration:verify -- --config-file … --database …`                                    | “历史校验与数据回填校验通过”  | 0      |
| 二次 upgrade | 同 upgrade                                                                                    | 历史 39 / pending 0 / 无变化  | 0      |

### 16.5 结构变化（前→后）

- 新增 `record_package_import.check_status`（`varchar(16) NULL`，`AFTER status`）。
- 新增 `record_package_item.check_result`（`varchar(16) NULL`，`AFTER version_no`）；`result` 由 `NOT NULL` 改为可空。
- CHECK：新增 `chk_record_package_import_check_status`、`chk_record_package_import_check_stage`、`chk_record_package_item_check_result`、`chk_record_package_item_check_stage`；重建 `chk_record_package_import_manifest`（加入 `schema_version` 存在且非 JSON null）与 `chk_record_package_item_result`（加入 `CONFLICT`）。
- 除明确列出的新增列及可空性调整外，其余列不变；索引、外键、FK 规则、表选项、种子保持不变；业务行变化仅 `migrations 38 → 39`（`COUNT` 差异比对仅此一项）。

### 16.6 定向与完整 D 复验

| 运行     | 命令要点                                                                                                           | 结果                                                            | 退出码 |
| -------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------ |
| 定向 2.5 | `E2E_REAL_DB_SPECS=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 … jest v13-db-verification.spec.ts -t '2.5 记录包检查/导入状态'` | **12 passed / 0 failed / 75 skipped**（87 total）               | 0      |
| 完整 D   | 同上，去掉 `-t`                                                                                                    | **87 passed / 0 failed / 0 skipped**（真实库 85、离线元数据 2） | 0      |

- 覆盖合法组合与 NULL：检查通过未导入、检查拒绝/未完成/历史 NULL 不得导入、`SUCCEEDED` 必须有检查通过、条目 NULL/成功/跳过/冲突/失败、非法枚举、manifest 合法/缺键/JSON null、同包重试主键唯一。
- 错误码为目标 CHECK 的 `3819/HY000` 且约束名匹配；未把任意报错计为通过。

### 16.7 E 受影响链路

- 首跑（如实保留）：**8 passed / 2 failed，退出码 1**。
  - R04：夹具以 `result='SUCCEEDED'`、`check_result=NULL` 插入，被 `chk_record_package_item_check_stage` 拒绝（`QueryFailedError … Check constraint … is violated`）。
  - R09：仍断言 `migrations` 长度 38，实际 39。
- 修正（不放宽约束断言）：夹具在成功写入时同时写 `check_result='PASSED'`；基线迁移数由 38 更新为 39。
- 重跑：**10 passed / 0 failed / 0 skipped，退出码 0**；纯替身 E：**29 passed / 0 failed，退出码 0**。
- 所有权/引用核验仍在首次破坏性操作前；合法清理、未知子行拒绝、后序失败回滚、重复执行均通过；新增状态未扩大删除范围（17 表及外部表零残留）。

### 16.8 收口与未覆盖

- 最终快照与升级后快照完全一致（`FINAL_VS_POST_IDENTICAL=true`），与二次升级后快照亦一致；`migrations=39`、`triggers=0`、`innodb_trx=0`、17 表与外部父表零残留；种子 `organization=1`、`local_installation=1`、`base_user_account=0` 不变。
- AUTO_INCREMENT：升级前后逐表记录 `diff` 为空（未重置）；`migrations` 计数器查询值为 39。
- 未覆盖（spec 库为空，且不注入历史行/不制造 DDL 故障）：历史非空行回填效果、违规行零 ALTER、跨表部分 DDL 失败后的实库续跑；以上仅由离线纯替身覆盖，不据此声称实库已证。
- 证据目录：`/home/gandiantx/secure/lithography-v13/evidence/e/round39/`（包含备份哈希、前后快照、各命令日志、错误码与约束语句）。
- 指纹（本节写入前）：HEAD `72de1096…`；`git status --porcelain|sort|sha256sum`=`3c3c501ca41e2ebecc8ac2a9a7970982a2bd30525087b31853a8aa2ed8651779`；`git diff`=`225a839b…`；未跟踪聚合=`a237b5e7…`（43 项）；未跟踪 `.ts` 聚合=`7c480d74…`；stash 列表=`1eba6d87…`。
- 边界：未跑完整 core、管理员初始化、Redis、其他验证库；未 down/DROP/清库/commit/push。本轮到此停止。

## 第十七轮：S4 最终收口第一步——E 规格 ESLint、历史回填依据与第 39 条迁移期规格准备（2026-11-08，未写库）

### 17.1 范围与冻结候选

| 项         | 值                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 分支       | `feat/database-v13-deploy`（未切换、未合并、未 rebase）                                                  |
| HEAD       | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未 commit）                                                  |
| 暂存区     | 空（`git diff --cached` 为空）                                                                           |
| stash      | 3 条，原样保留；`git stash list` 聚合 `1eba6d8797fd54396dd0c2c8d7c5189088f6e695d7f0c59f162e4c793d235317` |
| 本轮未执行 | 建库、迁移、造数、备份恢复、清理、服务启动、Redis、实库规格、完整 core、commit/push/PR                   |

**源码候选（本轮改动前，2026-11-08 19:48 +08:00）**

| 对象                                      | 命令                                                                                                                             | 值                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 工作区状态（排序聚合）                    | `git status --porcelain=v1 --untracked-files=all \| sort \| sha256sum`                                                           | `dfe39a8b17aa51c749d312af51b72d57818e12a139ce5535c9ec613beadffa6c`，78 项（28 修改 + 50 未跟踪） |
| 全量 tracked diff                         | `git diff \| sha256sum`                                                                                                          | `225a839b423e09c15164cf6f37feca828a3fc2507ec48695ba4c89e624526a42`                               |
| 作用域 diff（后端源码/脚本/测试/package） | `git diff -- backend/src backend/scripts backend/test backend/package.json \| sha256sum`                                         | `7916190b36c74395602090f96e86856f41ef2a3d2783bdec470de5603cbf9789`                               |
| 未跟踪（排除 ignored）                    | `git ls-files -o --exclude-standard \| sort \| sha256sum`                                                                        | `a237b5e758e9406b880801086f63caaae311899e2529027c1e5da0644b039f2b`，50 项                        |
| 未跟踪 `.ts` 聚合                         | `git ls-files -o --exclude-standard -- '*.ts' \| sort \| xargs -r sha256sum \| sha256sum`                                        | `7c480d741ac15577ee14667a7cfe1ab8145b216212a07b1ad2350bd81382399d`，36 项                        |
| 全 39 条迁移聚合                          | `find backend/src/infrastructure/database/migrations -maxdepth 1 -name '*.migration.ts' \| sort \| xargs sha256sum \| sha256sum` | `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`，39 文件                      |
| 前 38 条迁移聚合                          | 排除 `1775501700000`                                                                                                             | `624c4570ef86873b363370a93b9746355ba0e0b57c46baec430a1f9e5f96f86d`                               |
| 第 39 条文件                              | `sha256sum 1775501700000-…migration.ts`                                                                                          | `2c59866f614ba4b4b783f54bde7a9907f6759250d45aa2d0760f114177a6ecfb`                               |

**源码候选（本轮改动后、本节写入前，2026-11-08 19:57 +08:00）**

| 对象                   | 值                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| 工作区状态（排序聚合） | `ec006ba1b2eb8b4280deec0c2dd7296cd0e810fb733635c79aa6fb534cdf86b4`，80 项（28 修改 + 52 未跟踪） |
| 全量 tracked diff      | `225a839b423e09c15164cf6f37feca828a3fc2507ec48695ba4c89e624526a42`（未变）                       |
| 作用域 diff            | `7916190b36c74395602090f96e86856f41ef2a3d2783bdec470de5603cbf9789`（未变）                       |
| 未跟踪（排除 ignored） | `0a7f9b43f63a009f838fcacb6d2a8a9b7a98b91a814461a645ca5c22fc43ffca`，52 项                        |
| 未跟踪 `.ts` 聚合      | `f197054020d0bbd89d644fa2917963e7e5c3d856f84863630a230081e53664d9`，37 项                        |
| 全 39 条迁移聚合       | `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`（未变）                       |

**逐文件 SHA-256**：39 个文件的完整值、算法、排序和路径形式见 [S4-39-migration-sha256.md](S4-39-migration-sha256.md)。本轮未修改任何迁移文件；前 38 条与第 39 条逐文件值均与第十六轮一致。

**与第十六轮证据的沿用边界**

- HEAD、tracked diff、作用域 diff、全 39 条迁移聚合、stash 聚合一致；迁移未变，故迁移内容/指纹证据可沿用。
- 第十六轮工作区聚合 `3c3c501c…`、未跟踪 43 项的口径**不能沿用**：本轮新增了规格与文档，当前状态为 80 项、`ec006ba1…`。
- 第十六轮 E 实库 **10 passed** 是在 ESLint 修复前的 `e2e-scoped-cleanup.v13.realdb.spec.ts`（`c403a81c…`）上取得；该文件本轮已修改，**不能把旧 E 实库结果当作当前候选的 E 通过**。旧记录保留为历史，不作废。
- 第十六轮空表第 39 条升级（`lithography_v13_spec`）仍是有效历史事实；本轮未重跑，且当前候选整体未重新取得实库证据。
- 第十六轮 D 规格 **87 passed** 的测试文件与迁移未变，可作为历史证据；若严格执行“同一候选”口径，下一轮仍应以当前指纹重跑 D/E，不混用旧候选结果。

### 17.2 E 规格 ESLint 实际诊断与逐项修复

目标文件：`src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts`。

先运行不带 `--fix` 的文件级 ESLint：

```bash
npx eslint src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts
```

实际输出：**8 errors / 0 warnings，退出码 1**，全部为 `@typescript-eslint/no-unnecessary-type-assertion`：

| #   | 位置    | 诊断                                                | 修复                                                                          |
| --- | ------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | 158:29  | `managerProxy as EntityManager` 不改变类型          | 去掉断言，`callback(managerProxy)`；事务回调已由 `EntityManager` 约束         |
| 2   | 166:24  | `wrapped as DataSource` 不改变类型                  | 去掉断言，`dataSource: wrapped`；`new Proxy(source, …)` 已推断为 `DataSource` |
| 3   | 200:5   | `(await dataSource.query(...)) as Row[]` 不改变类型 | 改为 `dataSource.query<Row[]>(...)` 泛型，运行期 SQL 不变                     |
| 4   | 219:18  | `(await dataSource.query(...)) as Row[]` 不改变类型 | 改为 `dataSource.query<Row[]>(...)`，其余参数与 SQL 原样                      |
| 5   | 1571:15 | `(before.repair_request[0] as Row)` 不改变类型      | 去掉断言，`before.repair_request[0].intake_id`                                |
| 6   | 1720:15 | `(before.request[0] as Row)` 不改变类型             | 去掉断言，`before.request[0].intake_id`                                       |
| 7   | 1721:15 | `(before.intake[0] as Row)` 不改变类型              | 去掉断言，`before.intake[0].converted_request_id`                             |
| 8   | 1785:15 | `(before.request[0] as Row)` 不改变类型             | 去掉断言，`before.request[0].intake_id`                                       |

修复边界：

- 未使用 `any`、未加 `eslint-disable`、未删断言、未加 skip。
- 未改变任何 SQL、夹具归属、事务边界、错误汇总或清理语义；`query<Row[]>` 只是编译期泛型，运行期调用完全相同。
- 文件 SHA-256：修复前 `c403a81c45fbe237f88ec81fc43f7b9e37998a662e82cfe16a73d47ba2c4290b`，修复后 `964f166b1ed2413ead5e13cdb211a4f21a7314166c9129ca7626d04c159ea425`。因此第十六轮 E 实库结果不能沿用到当前候选。
- 修复后该文件 ESLint **0 error / 0 warning，退出码 0**；Prettier `--check` 通过；`tsconfig.spec.json` 类型检查通过。
- 受影响纯替身回归：本轮 4 个离线套件共 **57 passed / 0 failed / 0 skipped**（含 E 纯替身 **29 passed**），退出码 0。

### 17.3 第 39 条历史回填依据核实

对照第 39 条迁移、38 态结构（`1775501400000`）、R071—R073 与全仓库消费者，结论如下。

| 命题                                                  | 结论                                           | 依据                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 包 `RUNNING/SUCCEEDED/PARTIAL` 在旧实现中必然经过检查 | **不能证明**                                   | 当前仓库无写这两张表的 usecase/service/resolver/旧接口；38 态没有检查列或“检查通过才能导入”的约束；直接 SQL 可写任意合法 `status`。                |
| 条目 `SUCCEEDED` 必然代表检查通过后写入               | **不能证明**                                   | 38 态 `record_package_item.result` 仅 `NOT NULL` + 三值域，没有 `check_result`；直接 SQL 可写 `SUCCEEDED`。                                        |
| 是否存在直接 SQL、旧接口或其他写入路径绕过检查前提    | **存在理论/直接 SQL 绕过；未发现旧接口消费者** | 全仓库 grep 仅命中迁移、Entity、结构契约、清理工具/回归、V13 实库规格；`backend/dist` 为当前源码编译产物，不是独立旧实现。未发现旧 API/usecase。   |
| R071—R073 的要求                                      | **需求前提**                                   | R071 检查并保存检查结果；R072 前置条件“所选包及条目检查合格”，流程“复核→逐条去重/冲突→保存实际结果”，并明确“检查合格不等于成功”；R073 按阶段查询。 |
| 第 39 条回填映射                                      | **迁移实现假设**                               | 迁移按 `status IN ('RUNNING','SUCCEEDED','PARTIAL')`、`result='SUCCEEDED'` 回填 `PASSED`；这是基于 R072 的选择，不是历史检查记录。                 |

**分类结论**

- **实际保证**：只有 38 态已有的状态域、`result NOT NULL`、FAILED 必须有原因等；没有“历史已检查”的数据库保证。
- **没有消费者但属于已批准迁移假设**：只有在用户明确批准“把 R072 需求前提视为历史事实”时才能这样记；当前尚未取得该批准。
- **依据不足**：把历史 `RUNNING/SUCCEEDED/PARTIAL` 或条目 `SUCCEEDED` 直接认作“已检查”的审计事实。当前回填属于这一类。

**待裁决问题（OI-15）与最小处理选择**

1. **保留迁移 + 明确假设（推荐，最小改动）**：不改第 39 条；升级前导出受影响包/条目清单，记录“回填 PASSED 为 R072 假设”；读取/展示层标注“历史推定”，不作为审计证明。
2. **升级前人工确认**：业务方对冻结清单逐包/逐条确认“确已检查”，形成签字/工单证据后再升级；仍不改迁移。
3. **审计要求可证明时另立迁移**：无法证明的历史行保留 `NULL`，调整历史组合约束或新增显式来源列；需单独批准，不在本轮实施，也不夹带进第 39 条。

### 17.4 状态口径（不得混写）

| 命题                | 当前状态             | 证据边界                                                                                                                                  |
| ------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 空表 38→39 升级     | **已通过（历史）**   | `lithography_v13_spec` 空 `record_package_import/item`，第十六轮正式 upgrade 仅第 39 条、verify/二次 upgrade 通过；未覆盖回填与违规拒绝。 |
| 带数据 38→39 升级   | **待验证**           | 新 A/B 规格已编写、默认跳过；本轮未执行、未连接。                                                                                         |
| 部分 DDL 失败后续跑 | **证据缺口**         | C1 可设计受控失败；正式入口预检会把已存在新列判为“疑似半迁移”并拒绝，C2 只证失败关闭；不能记续跑通过。                                    |
| “导入前必须检查”    | **需求前提**         | V5.3 R071—R073；不等于旧记录已检查。                                                                                                      |
| 旧实现实际保证      | **无检查保证**       | 无旧消费者；38 态结构不记录检查；直接 SQL 可绕过。                                                                                        |
| 其他 37/38 态库     | **未完成 39 态验收** | `lithography_v13_init/up30/up31` 仍为 37 态；`lithography_v13_spec` 的 39 态为空表升级，不等于带数据验收。                                |

### 17.5 第 39 条迁移期实库验收规格（本轮只编写，不执行）

新增：`src/infrastructure/database/record-package-state.migration.realdb.spec.ts`。

- 默认 `describe.skip`，不创建 DataSource、不建立连接。
- 显式 `E2E_REAL_DB_SPECS=1` 但许可不全时模块加载即抛错拒绝。
- 许可：`E2E_ALLOW_MIGRATION_39_UPGRADE=1`、`E2E_ALLOW_PHYSICAL_CLEANUP=1`、`E2E_REAL_DB_NAME`、`E2E_ALLOWED_DB_NAMES`（必须且只能包含目标库）、`E2E_REAL_DB_CONFIG_FILE`（绝对路径）、`E2E_EXPECTED_SERVER_UUID`、`E2E_M39_SCENARIO=A|B|C`。
- 目标库与场景一一绑定：`lithography_v13_m39_a` / `_b` / `_c`；运行前核对 `DATABASE()`、`@@server_uuid`、MySQL 8.0.x、白名单、空库；不建库、不清表、不 DROP、不 down。
- 38 态来源：从空库用冻结的 38 个迁移文件正向 `runMigrations` 构建；运行时校验前 38 条聚合 `624c4570…f86d` 与第 39 条文件 `2c59866f…ecfb`；校验迁移历史 38 条、最后一条 `1775501600000`、52 张基础表。
- 造数：组织/账号/包/条目均按真实 insertId 或生成主键即时登记；只按登记 ID 清理，不按当前查询结果认领未知资源。

| 场景               | 数据                                                                                                        | 断言                                                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 合法历史数据升级 | 包 RUNNING/SUCCEEDED/PARTIAL/PENDING/FAILED；条目 SUCCEEDED/FAILED/SKIPPED；覆盖应回填 PASSED 与应保留 NULL | 正式入口只执行第 39 条；旧字段逐字段不变；包 RUNNING/SUCCEEDED/PARTIAL→PASSED、PENDING/FAILED→NULL；条目 SUCCEEDED→PASSED、FAILED/SKIPPED→NULL；`result` 变可空；二次 upgrade 0 条且全字段不变                                               |
| B 违规历史数据拒绝 | 38 态允许、39 态预检拒绝：`manifest_json='{"schema_version":null}'` 的包 + 合法包/条目                      | 正式入口在首次 ALTER 前失败；错误含“预检失败”与具体规则；无任何 ALTER；迁移历史仍 38；两表 `SHOW CREATE TABLE` 与全部原数据不变                                                                                                              |
| C 部分 DDL 失败    | 合法数据；受控 DataSource 在第 2 条包表 ALTER 执行前抛错一次                                                | C1：正式入口非 0、诊断含步骤与注入错误；第 1 条 ALTER 已提交、第 2 条未执行；历史仍 38；包 `check_status` 已回填；条目 `check_result` 尚不存在；旧字段不变。C2：再次走正式入口被“疑似半迁移”拒绝、零新 ALTER；**只证失败关闭，不证续跑成功** |

**覆盖必要性**：主计划 S3 要求“无库／空库／已完整终态、并发互斥、权限不足、错目标、未知历史、半迁移、DDL 部分失败和收尾失败均有回归”，A13 要求“DDL 部分失败非 0、有诊断、无假成功；结果未知先核对”。现有 `record-package-state.migration.spec.ts` 只是 fake `QueryRunner`，不能替代真实 MySQL 部分 DDL + 正式入口的证据，因此 C 需要实库设计；但续跑受正式入口半迁移预检阻断（见下）。

**C 的证据缺口（不编造通过）**：`inspectMigrationState` 会解析第 39 条 `ADD COLUMN check_status/check_result`，把“列已存在但迁移历史未记录”判为半迁移并在升级前拒绝。因此在不修改正式预检、不绕过入口、不手工回退 DDL 的前提下，无法让正式入口在部分 DDL 失败后继续跑完第 39 条。C2 仅记录该拒绝行为；续跑成功仍属未证。最小后续选项：单独裁决“受控续跑”方案（新增受支持的恢复路径/专用工具/授权手工回退后再走正式入口），本轮不实施。

### 17.6 文档校正

- 第十六轮 §16.5 的“其余列…完全不变”改为“除明确列出的新增列及可空性调整外，其余列不变；索引、外键、FK 规则、表选项、种子保持不变”。
- 保留第十六轮 D **87 passed**、E **10 passed** 原始记录，不删不改；新增 §17.1 说明 ESLint 修复后 E 规格文件已变化，旧 E 实库结果不能作为当前候选结果沿用。
- 新增 OI-15（历史回填依据）与 S4 G-9/G-10（历史依据缺口、部分 DDL 续跑缺口）。
- README 状态更新至第十七轮；S2 文档注明迁移期规格默认跳过、未执行。
- 明确区分：空表升级已通过／带数据升级待验证／需求前提／旧实现实际保证；不把 `lithography_v13_init/up30/up31`（37 态）或空表 `lithography_v13_spec` 写成带数据 39 态验收。
- `check:entity-scope` 只比较 `origin/main...HEAD` 已提交差异，HEAD 与 base 均为 `72de1096…`；退出 0 只表示已提交区间无 Entity/Migration 差异，**不覆盖本轮 17 个未提交 Entity、8 条未提交迁移及工作区修改**。

### 17.7 非实库验证（本轮实际执行）

| 检查                         | 命令                                                                                                                                                   | 结果                                            | 退出码 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------ |
| 项目类型检查                 | `npm run typecheck`                                                                                                                                    | 通过                                            | 0      |
| spec 类型检查                | `npx tsc -p tsconfig.spec.json --noEmit`                                                                                                               | 通过                                            | 0      |
| 迁移/契约/部署/清理纯替身    | `npx jest --runInBand record-package-state.migration.spec.ts migration-schema-contract.spec.ts database-deploy.spec.ts e2e-scoped-cleanup.v13.spec.ts` | **4 suites / 57 passed / 0 failed / 0 skipped** | 0      |
| 变更 TS ESLint（无 `--fix`） | `npx eslint <两个 spec>`                                                                                                                               | **0 error / 0 warning**                         | 0      |
| 变更 TS Prettier             | `npx prettier --check <两个 spec>`                                                                                                                     | 全部符合                                        | 0      |
| 能力文档门禁                 | `npm run capability:docs:check`                                                                                                                        | current                                         | 0      |
| usecase normalize 门禁       | `npm run lint:usecase-normalize-guard`                                                                                                                 | passed                                          | 0      |
| 架构 fixtures                | `npm run lint:architecture-fixtures`                                                                                                                   | passed                                          | 0      |
| Entity/Migration 范围门禁    | `npm run check:entity-scope`                                                                                                                           | PASS（仅已提交区间）                            | 0      |
| 空白检查                     | `git diff --check`                                                                                                                                     | 无输出                                          | 0      |

未运行：任何实库规格、完整 core、迁移命令、`database:deploy`、`migration:*`、Redis、管理员初始化。未使用 `npm run lint`（含 `--fix`）。

### 17.8 下一轮带数据验收的准确步骤与最小授权

**前置裁决**

1. 先裁决 OI-15：是否批准“历史 `RUNNING/SUCCEEDED/PARTIAL`、条目 `SUCCEEDED` 回填 `PASSED` 为迁移假设”。未批准前，A 结果只能证明“回填按迁移规则执行”，不能写成“历史确已检查”。

**授权与建库（由管理员执行，本轮不执行）**

2. 在 `127.0.0.1:3306`（`server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`）预建**空库**：`lithography_v13_m39_a`、`lithography_v13_m39_b`、`lithography_v13_m39_c`；不得复用 `lithography_v13_spec`、`lithography_e2e`、`init/up30/up31` 或其他库。
3. 建专用账号（或临时授权）仅对上述三库授予 `SELECT/INSERT/UPDATE/DELETE/CREATE/DROP/INDEX/ALTER/LOCK TABLES`；不授予其他库；不授予 `SUPER`、`FILE` 等全局权限。配置放库外 `/home/gandiantx/secure/lithography-v13-m39-{a,b,c}.env`，权限 `0600`，含 `DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME/DB_TIMEZONE=+08:00/DB_SYNCHRONIZE=false`，`DB_NAME` 分别对应三库；不输出密码。

**逐场景执行（一次一个库；每个库只构建一次 38 态）**

4. A：

```bash
cd /home/gandiantx/lithography-platform/backend
E2E_REAL_DB_SPECS=1 E2E_ALLOW_MIGRATION_39_UPGRADE=1 \
E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_M39_SCENARIO=A \
E2E_REAL_DB_NAME=lithography_v13_m39_a \
E2E_ALLOWED_DB_NAMES=lithography_v13_m39_a \
E2E_REAL_DB_CONFIG_FILE=/home/gandiantx/secure/lithography-v13-m39-a.env \
E2E_EXPECTED_SERVER_UUID=909f9587-9fce-11f1-a353-00e0709ef3a9 \
npx jest src/infrastructure/database/record-package-state.migration.realdb.spec.ts --runInBand
```

5. B：同 A，替换 `SCENARIO=B`、库名 `_b`、配置文件 `-b.env`；预期正式入口预检拒绝、零 ALTER、历史/结构/数据不变。
6. C：同 A，替换 `SCENARIO=C`、库名 `_c`、配置文件 `-c.env`；预期 C1 失败并保留现场、C2 被半迁移预检拒绝。**C 不计为“续跑通过”**；如需要续跑证据，先单独裁决 G-10 的最小方案。
7. 每次运行后保存：命令、退出码、Jest passed/failed/skipped、关键断言输出、`SHOW CREATE TABLE`、迁移历史、回填统计、清理后残留；A/B 的最小证据是“正式入口执行条数 + 回填/拒绝 + 结构/数据快照”。
8. 三库均为一次性：测试后不重置、不复用；证据确认后由管理员按单独授权 DROP。若任一步出现非预期数据变化、目标/身份/白名单不一致、许可缺失或清理失败，立即停止并保留现场。

**最小授权文字（供用户确认）**

> 授权在 `127.0.0.1:3306`（`server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`）预建空库 `lithography_v13_m39_a`、`lithography_v13_m39_b`、`lithography_v13_m39_c`，并允许使用仅限这三库的专用账号执行：用冻结的 38 条迁移从空库正向构建 38 态、插入本轮合成组织/账号/记录包/条目、通过正式 `database:deploy --mode upgrade` 入口执行第 39 条、按真实 insertId/生成主键登记清理本轮合成行；允许只读查询 `information_schema`、`SHOW CREATE TABLE` 与迁移历史。仅 A 场景允许完整成功升级；B 场景预期在首次 ALTER 前拒绝；C 场景仅允许一次受控的第 2 条包表 ALTER 失败注入，不改迁移、不绕过正式预检。禁止触碰其他库、禁止 Redis、禁止完整 core、禁止备份恢复/清库/建库之外的 DDL、禁止 commit/push/PR。验收存证后由我确认再 DROP 三库。

### 17.9 停止点

- 本轮未连接数据库、未写库、未建库、未迁移、未造数、未备份恢复、未清理、未启动服务、未操作 Redis、未运行实库规格、未运行完整 core、未 commit/push/PR。
- 工作区 28 个已跟踪修改、52 个未跟踪路径、3 条 stash 全部保留；未暂存。
- 下一轮从 OI-15 裁决与三库授权开始；管理员初始化、KEEP 完整 core 留待后续。

## 第十八轮：S4 第39条非空 38 态 A/B 实库验收（2026-11-08，A 失败即停止；B 未执行）

### 18.1 裁决吸收与证据口径

- 按本轮批准：对**明确构造的合成旧数据**，按第39条规则回填 `PASSED`，仅用于验证迁移实现；**不证明**真实历史记录曾经过检查，**不批准**真实旧数据无条件回填 `PASSED`。
- 正式部署遇到受影响历史记录时，必须先输出**冻结清单**并取得确认；合成验收不得代替历史事实确认。该条件已写入 `S3-deployment-sop.md` §4.3、§5。
- 当前工具没有“冻结清单导出/确认”入口，登记为 **G-11**（见 `S4-pre-execution-precheck.md` §6）；本轮不扩大开发范围。

### 18.2 实例、授权与安全预检

| 项        | 结果                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 实例      | `127.0.0.1:3306`，`@@server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`，执行前后一致                                                                                                 |
| 目标库    | 仅新建 `lithography_v13_m39_a`、`lithography_v13_m39_b`；执行前均不存在，执行后 C 仍不存在                                                                                           |
| 专用账号  | `litho_m39@127.0.0.1`：仅 a/b 各 `SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES`；`Super_priv=File_priv=Grant_priv=N`。随机凭据保存在库外 0600 配置，未输出 |
| 目录权限  | 配置与证据目录 `0700`，文件 `0600`（`/home/gandiantx/secure/lithography-v13/…`）                                                                                                     |
| 白名单    | 每次只设一个目标库；`E2E_REAL_DB_NAME`、`E2E_ALLOWED_DB_NAMES`、配置 `DB_NAME`、实际 `DATABASE()` 一致；模块级许可不全即拒绝                                                         |
| 38 态构建 | 冻结前 38 条迁移从空库正向构建，不回退、不使用清表 drill                                                                                                                             |
| 清理入口  | `runGuardedScopedCleanup`：要求 `E2E_ALLOW_PHYSICAL_CLEANUP=1`、目标在白名单内、实际 `DATABASE()` 匹配；按真实 insertId 删除本轮登记夹具                                             |
| 非目标库  | `init/up30/up31/spec` 均 52 表、`e2e` 35 表，数量与执行前一致；未对其实施写操作                                                                                                      |

### 18.3 冻结候选核对（执行时）

- `HEAD=72de1096d0a2aa2d62ed55a48ab49ebc3398000a`；分支、28 个已跟踪修改、52 个未跟踪路径、3 条 stash 均保留。
- tracked diff `225a839b423e09c15164cf6f37feca828a3fc2507ec48695ba4c89e624526a42`；作用域 diff `7916190b36c74395602090f96e86856f41ef2a3d2783bdec470de5603cbf9789`；未跟踪 `.ts` 37 项聚合 `f197054020d0bbd89d644fa2917963e7e5c3d856f84863630a230081e53664d9`；工作区 80 项聚合 `ec006ba1b2eb8b4280deec0c2dd7296cd0e810fb733635c79aa6fb534cdf86b4`。
- 39 条迁移逐文件 SHA-256 与 `S4-39-migration-sha256.md` **全部一致**；前 38 条聚合 `624c4570…f86d`，39 条聚合 `8827ded2…707f`，第 39 条文件 `2c59866f…ecfb`。

### 18.4 A：合法历史升级执行

- 命令：`backend/` 下 `./node_modules/.bin/jest --runTestsByPath src/infrastructure/database/record-package-state.migration.realdb.spec.ts --runInBand --verbose`；`E2E_M39_SCENARIO=A`、目标/白名单均为 `lithography_v13_m39_a`，显式配置与 UUID 如上。
- **Jest 退出码 1**：`Test Suites: 1 failed / 1 total`；`Tests: 1 failed, 3 skipped, 4 total`；耗时 21.974 s。
- 内部正式入口：`runDatabaseDeploy`（`--mode upgrade` 对应实现，非 CLI 子进程、无独立退出码）；**第一次调用返回成功**（只执行第39条，内部 `verifyMigrationState` 通过），第二次“预期 0 条”调用**未到达**。
- 失败前已通过：仅执行第39条、终态 39 条、`check_status/check_result` 列存在、`result` 可空、六条 CHECK 存在、旧 packages/items 全字段不变、**包回填循环通过**。
- 失败点：`expectBackfill` 条目循环（规格 L660）`Received: null / Expected: "PASSED"`（首条为 RUNNING 包的 SUCCEEDED 条目）。

### 18.5 根因与最小修复方案（本轮未改代码）

- 根因是**验收规格断言缺陷，不是迁移数据缺陷**：TypeORM MySQL 驱动默认 `supportBigNumbers=true`、`bigNumberStrings=true`，原始 query 将 BIGINT 返回为 **string**（实测 `CAST(1 AS UNSIGNED)`、`COUNT(*)` 均为 string）；`record_package_item.id` 为 `bigint`，`selectItemChecks` 以 string 建 Map，而 `state.items[].itemId` 是 number（insertId 经 `Number()`），`Map.get(number)` 永不命中，`null` 是“未命中”。
- 迁移回填是否正确：**尚待直接查询和修复后的断言验证**。本轮未取得“回填值与预期一致”的直接断言证据（失败点正是该断言未通过）；不以 ENFORCED CHECK 的存在反证回填正确。修复后需在新目标库重跑 A，由 `expectBackfill` 直接读取并逐键比较。
- 最小修复：`selectItemChecks` 用 `String(row.id)` 作键、`expectBackfill` 用 `String(item.itemId)` 查找（或统一把 `itemId` 存为 string）；不改 SQL、夹具、迁移。修复后需按新一轮授权重新执行 A（本轮 A 库已是 39 态，按规则不重建、不重跑）。

### 18.6 现场、回收与非目标核对

- A 库保留 39 态现场：52 张基础表、39 条迁移历史（末条为 `1775501700000-add-record-package-check-and-import-result-states-for-v13`）。
- `afterAll` 已按规格清理本轮合成夹具：packages/items/company/account 均 **0 行**；未保留夹具，也未执行额外 DROP。
- B 库未执行、未连接写入：0 张基础表、无 `migrations` 表；C 库不存在。
- 验证库 a/b 与测试账号 `litho_m39` 保留；未 DROP、未清库、未回退 DDL、未重建库。

### 18.7 证据路径

根目录 `/home/gandiantx/secure/lithography-v13/evidence/m39/20261108/`（0700/0600）：

- `a/pre-run.txt`、`a/pre-upgrade.json`（升级前 38 态 + 5 包/6 条目/38 条历史/两张表 `SHOW CREATE` 全字段快照）、`a/pre-upgrade-summary.txt`（逐行旧值/预期回填/确认检查列尚不存在）、`a/post-run.txt`（39 态结构/历史/约束/行数/非目标库）、`a/migration39-row.txt`、`a/type-probe.txt`、`a/root-cause.txt`、`a/jest.log`、`a/poller.log`、`a/command.txt`。
- `b/NOT_EXECUTED.txt`（B 未执行与只读状态）、`fingerprints.txt`、`evidence-sha256.txt`（逐文件 SHA-256）。

### 18.8 未验证 / 未执行

- A 的“再次 upgrade 执行 0 条、数据无漂移”未到达；条目回填正确性**尚待直接查询和修复后的断言验证**，本轮未取得直接断言证据（也不以 ENFORCED CHECK 反证）。
- **B 未执行**（按“A 失败即停止”），因此第39条首次 ALTER 前拒绝、ALTER 计数 0、拒绝后结构与数据不变均未在本轮验证。
- 未验证：真实历史检查事实、C 自动续跑、管理员初始化、完整 core。
- 未 commit、未 push、未发布 PR。

### 18.9 停止点

- 现场保留，只读定位完成；未修改生产代码/测试/迁移，未回退 DDL，未重建库，未连续重跑。
- 下一轮需先裁决 18.5 最小修复并重新授权 A/B；B 仍不得在 A 未通过前执行。

## 第十九轮：第39条 A 场景局部超时修复＋A3/B2 实库验收（2026-11-08）

### 19.1 本轮范围与授权

- 仅做 A 场景 Jest 超时的最小修复，并在授权实例上完成 A3、B2 两个隔离场景的实库验收。
- 实例：仅 `127.0.0.1:3306`，`@@server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`，执行前后一致。
- 账号：仅使用现有 `gandiantx`；新建 `lithography_v13_m39_a3`；复用已重建并重新核验为空的 `lithography_v13_m39_b2`。
- 不创建/扩权账号，不读写 mysql 系统权限表；不修改 A/A2/B 旧现场，不 DROP、不清库。
- 凭据仅保存在库外 `0600` 文件，未打印；显式 `DB_NAME`、白名单、实际 `DATABASE()`、server UUID 保持一致。

### 19.2 最小代码修复（仅测试超时）

- `record-package-state.migration.realdb.spec.ts` 的 `itScenario` 增加可选第四参数 `timeout`，仅在 `SCENARIO` 命中时透传给 `it(name, fn, timeout)`；跳过分支仍为 `it.skip`。
- 仅 A 场景调用追加 `120_000`；B/C 调用未改。
- 未修改全局 `testTimeout`（`jest.config.ts` 仍为 `10000`）、未使用 CLI 全局超时覆盖、未加 retry/skip、未改断言、迁移或部署行为。
- 修复后规格 SHA-256：`88557e67711dd0a5cf46437b4cb22b3101dafe0f28ad6a40700c7886b7be3e4b`（修复前 `b3cd5f37…1ec4`）。

### 19.3 生命周期与异步收尾检查

- `runDatabaseDeploy` 在 `finally` 中 `await` 释放迁移锁与 `dataSource.destroy()`，未遗留未 await 的部署任务。
- `beforeAll`（180s）与 `afterAll`（60s）均 `await` 收尾，`afterAll` 调用受保护清理 `runGuardedScopedCleanup`。
- 除 A 场景单测默认超时偏短外，未发现其他需用超时掩盖的生命周期缺陷；未新增超时掩盖任何异常收尾。

### 19.4 A2 超时历史（保留，不重跑）

- A2（`lithography_v13_m39_a2`）首次升级成功，第二次 `runDatabaseDeploy`（规格 L866）触发 Jest 默认 `testTimeout=10000`，用例 `10004 ms` 超时；随后的 `ReferenceError: … torn down` 是环境拆除后异步继续的后果。
- 判定为**测试生命周期/超时缺陷**，不是迁移实现或断言缺陷；A2 中包/条目回填直接断言、NULL 安全负例、旧字段不变均已越过且未报失败。
- A2 现场保留（39 态、52 表、夹具 0；`organization` 仅剩迁移内置 `CLIENT_DEFAULT` 基线行），不重建、不复用。
- 证据：`/home/gandiantx/secure/lithography-v13/evidence/m39/20261108-r2/a2/`（`command.txt`、`jest.log`、`post-failure.txt`、`STOP-A2.txt`）。

### 19.5 复跑前安全检查（通过）

- 上一轮 Jest 及部署任务已结束；`PROCESSLIST` 无 b2 使用连接，`information_schema.innodb_trx=0`，`IS_USED_LOCK('lithography:migration:lithography_v13_m39_b2')=NULL`。
- `lithography_v13_m39_a3` 不存在；`lithography_v13_m39_b2` 为 0 表、0 视图、0 触发器、0 例程、0 事件、无 `migrations` 表，且无其他任务使用。
- 配置文件位于库外、权限 `0600`；未打印任何凭据。
- 未强制杀死任何归属不明的进程或连接。

### 19.6 候选冻结（修复后，A3/B2 共用）

- `HEAD=72de1096d0a2aa2d62ed55a48ab49ebc3398000a`；分支、已跟踪修改、未跟踪路径与 stash 均未变化。
- 39 条迁移逐文件 SHA-256 与 `S4-39-migration-sha256.md` 全部一致；前 38 条聚合 `624c4570…f86d`，第 39 条文件 `2c59866f…ecfb`。
- 实库规格 `88557e67…3e4b`；BIGINT 无损 helper `a1ebc44e…7a77`；helper 单测 `e09a3bcb…0abc`。

### 19.7 A3 执行结果（通过）

- 命令（`backend/` 下，环境变量见证据 `a3/command.txt`）：`E2E_M39_SCENARIO=A`、`E2E_REAL_DB_NAME=E2E_ALLOWED_DB_NAMES=lithography_v13_m39_a3`、显式配置 `lithography-v13-m39-a3.env`、固定 UUID，`npx jest --runTestsByPath src/infrastructure/database/record-package-state.migration.realdb.spec.ts --runInBand --verbose`。
- **退出码 0**；`Test Suites: 1 passed / 1 total`；`Tests: 1 passed, 3 skipped, 4 total`；`Time: 26.332 s`；A 用例 `11375 ms`；外部耗时 28 s。
- 完整完成：空库正向构建 38 态 → 正式入口仅执行第 39 条；包与条目回填按 `Map.has` → `Map.get` 直接查询断言通过；3 个 NULL 安全负例（SUCCEEDED 条目 NULL/REJECTED、SUCCEEDED 包 NULL）通过；旧字段保留；第二次 `upgrade` 返回 `noChanges=true`、`executed=[]`，前后数据与结构无漂移；受保护收尾，夹具零残留。
- A3 现场：39 条历史（末条 `…1775501700000`）、52 表、`check_status/check_result` 两列、`result` 可空 `YES`；`record_package_import=0`、`record_package_item=0`、`base_user_account=0`、非基线 `organization=0`；锁 `NULL/NULL`、无活动事务。
- 证据：`/home/gandiantx/secure/lithography-v13/evidence/m39/20261108-r2/a3/`（`precheck.txt`、`command.txt`、`jest.log`、`post-run.txt`）。

### 19.8 B2 执行结果（通过）

- A3 通过后重新核验 b2 空态（0 表/视图/触发器/例程/事件、无 `migrations`、无使用连接、无迁移锁），再运行 B 场景。
- 命令（`b2/command.txt`）：`E2E_M39_SCENARIO=B`、`E2E_REAL_DB_NAME=E2E_ALLOWED_DB_NAMES=lithography_v13_m39_b2`、显式配置 `lithography-v13-m39-b2.env`、固定 UUID，`--runInBand --verbose`。
- **退出码 0**；`Test Suites: 1 passed / 1 total`；`Tests: 1 passed, 3 skipped, 4 total`；`Time: 16.876 s`；B 用例 `2208 ms`；外部耗时 18 s。
- 内部部署为**预期失败**：`runDatabaseDeploy` 抛 `预检失败：record_package_import: schema_version 为 JSON null 1 行（示例 ID：3bbab009-f38a-4b59-8309-5c968b6c4a51）；未执行任何 ALTER`；Jest 断言该失败为验收成功，二者已区分。
- `ALTER=0`（recorder 无语句）；迁移历史仍为 38 条（末条 `FixJsonSnapshotVersionChecksForV131775501600000`）；第 39 条两列不存在；`SHOW CREATE` 与原数据前后不变（用例断言）。
- B2 现场：52 表、0 视图/触发器/例程/事件、无迁移锁、无活动事务；夹具 `record_package_import=0`、`record_package_item=0`、`base_user_account=0`、非基线 `organization=0`。
- 证据：`/home/gandiantx/secure/lithography-v13/evidence/m39/20261108-r2/b2/`（`command.txt`、`jest.log`、`post-run.txt`）。

### 19.9 现场保留与残留

- `lithography_v13_m39_a3`：保留 39 态现场；`lithography_v13_m39_a2`：保留 39 态现场；`lithography_v13_m39_b2`：保留 38 态（第 39 条被预检拒绝，未落任何 DDL）。
- `lithography_v13_m39_a/_b` 未触碰；未 DROP、未清库、未回退 DDL、未重建任何库。
- 收尾后无相关活动事务、无残留连接、无未释放迁移锁。

### 19.10 未执行

- 未执行 C 场景、管理员初始化、完整 core、Redis、其他验证库升级；未 commit、未 push。
- 本轮完成后停止。

## 第二十轮：S4 合成管理员初始化专项（2026-11-09，首次运行失败并停止）

### 20.1 范围与授权

- 仅做 S4 合成管理员初始化专项：在独立验证库 `lithography_v13_admin_verify` 执行正式 `init` 至 39 态、合成公司/管理员初始化、冲突夹具与受保护收尾。
- 实例：`127.0.0.1:3306`，`@@server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`（执行前后一致）。
- 账号：仅使用现有 `gandiantx`；未创建/扩权 MySQL 账号，未读写 `mysql` 系统权限表。
- 未触碰 `init/up30/up31/spec/e2e` 与 `m39_a/_a2/_a3/_b/_b2`；未 DROP、未清库、未回退迁移、未 commit/push。
- 库外目录 `/home/gandiantx/secure/lithography-v13/admin-verify`（0700）存放合成映射；配置 `configs/lithography-v13-admin-verify.env`（0600）。未打印密码/哈希/连接串。

### 20.2 初始化契约（依据 S1 §5 与工具实际行为）

- 两级各 3 个：1 级 3 个（甲方公司 `CLIENT_DEFAULT`），2 级 3 个（各受管公司）。
- 等级写入 `base_user_account.admin_level`（1/2）；公司归属写入 `base_user_info.customer_organization_id`；不创建成员关系、不授予权限。
- 首次密码仅在创建时写入；`must_change_password=1`；`status=ACTIVE`；`identity_hint=SUPER_ADMIN`；`base_user_info.access_group=["guest"]`、`user_state=ACTIVE`。
- 同一映射重复执行：已存在且等级/归属一致 → `UNCHANGED`，不重置密码、不改其他字段。
- 已存在账号仅补必要等级/归属（`MAPPED`），等级或归属不一致即失败关闭，绝不覆盖。
- 映射在**单事务**内执行；任一失败整体回滚，不产生部分账号/资料。
- 冲突处理：等级不一致、归属不一致、缺资料、缺公司、登录名/邮箱唯一键碰撞均拒绝并以非 0 退出。

### 20.3 候选与验证（运行前）

- `HEAD=72de1096d0a2aa2d62ed55a48ab49ebc3398000a`，分支 `feat/database-v13-deploy`；为**未提交工作区候选**，不代表远端提交已通过。
- 39 条迁移逐文件 SHA-256 与 [S4-39-migration-sha256.md](S4-39-migration-sha256.md) 全部一致：前 38 条聚合 `624c4570…f86d`、全 39 条聚合 `8827ded2…707f`、第 39 条 `2c59866f…ecfb`。
- 相关源文件：`admin-bootstrap.ts` `aeba4722…9d55`、`database-deploy.ts` `b0b776ab…6e30`、`incremental-migration.ts` `bd1d19a2…d102`；新规格 `admin-bootstrap.realdb.spec.ts` `baa27f6c…915f`。
- 工作区状态保持：`admin-bootstrap.ts`、`database-deploy.ts`、`scripts/database-deploy.ts` 为未跟踪新文件，`incremental-migration.ts` 为已跟踪修改；3 条 stash 未动。
- 静态验证全绿：`tsc -p tsconfig.spec.json --noEmit` 0；相关纯单测 `database-deploy.spec.ts` **8 passed / 0 failed**（退出 0）；新规格文件级 ESLint（无 `--fix`）0；Prettier `--check` 通过；`git diff --check` 0。
- 门禁自检：无任何 E2E 变量时 **1 suite skipped / 12 tests skipped**；仅 `E2E_ADMIN_BOOTSTRAP_SPECS=1` 时模块加载即拒绝（退出 1，0 tests），错误文案与设计一致。

### 20.4 新增专项规格

- 新文件：`backend/src/modules/account/base/services/admin-bootstrap.realdb.spec.ts`（先落在 `src/infrastructure/database/`，因架构 ESLint 禁止 infrastructure→modules，移动到账号模块目录，断言与逻辑未变）。
- 默认 `describe.skip`；显式请求但许可不全即模块加载抛错；不启动完整 Nest 服务；不建库、不清库、不 DROP、不回退迁移。
- 目标库与白名单、`DATABASE()`、`@@server_uuid`、MySQL 8.0.x、空库均在 `beforeAll` 复核；映射文件 0600、目录 0700，密码仅存于进程与受限文件。

### 20.5 执行结果（失败，已停止）

- 命令（`admin-verify/command.txt`）：`E2E_ADMIN_BOOTSTRAP_SPECS=1`、`E2E_ALLOW_ADMIN_BOOTSTRAP=1`、`E2E_ALLOW_PHYSICAL_CLEANUP=1`、`E2E_REAL_DB_NAME=E2E_ALLOWED_DB_NAMES=lithography_v13_admin_verify`、显式配置、固定 UUID、`E2E_ADMIN_BOOTSTRAP_DIR`，`npx jest --runTestsByPath src/modules/account/base/services/admin-bootstrap.realdb.spec.ts --runInBand --verbose`。
- **退出码 1**；`Test Suites: 1 failed / 1 total`；`Tests: 7 failed, 5 passed, 12 total`；`Time: 33.908 s`；外部耗时 35 s。

| 用例                       | 结果              | 说明                                                                                                                  |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| 0 普通 init 不创建管理员   | passed（17 ms）   | 39 条迁移、52 表、`base_user_account=0`、无 `admin_level`                                                             |
| 1 合法首次初始化           | passed（7275 ms） | 6 个账号 CREATED；等级/组织/`must_change_password=1`/`SUPER_ADMIN`/`guest` 一致；密码按登录算法可验、错误密码为 false |
| 2 同一映射幂等             | passed（7001 ms） | 6 个 `UNCHANGED`；账号/资料逐字段（含密码哈希）前后一致                                                               |
| 3a 等级冲突                | failed            | 夹具 `login_name` 超 30 字符，未进入断言                                                                              |
| 3b 归属冲突                | failed            | 同上                                                                                                                  |
| 3c 已有账号补映射          | failed            | 同上（密码不重置未取到证据）                                                                                          |
| 3d 映射引用不存在公司      | passed（22 ms）   | 拒绝且无新增                                                                                                          |
| 3e 已有账号缺资料          | failed            | 同上                                                                                                                  |
| 3f 邮箱唯一键碰撞          | failed            | 同上（整批回滚未取到证据）                                                                                            |
| 3g 注入第 2 条资料写入失败 | failed            | 同上（注入点未到）                                                                                                    |
| 4 输入与配置               | passed（28 ms）   | 非法等级/重复账号/缺密码/缺公司/缺确认口令/upgrade 越界/目标不一致均按准确原因拒绝，且未建立连接                      |
| 5 受保护收尾               | failed            | `rowCountsBefore` 在创建 3 个合成公司之后采样（organization=4），收尾后为 1，快照基线错位；清理本身成功               |

### 20.6 失败根因与最小修复方向

- **根因 A（3a/3b/3c/3e/3f/3g）**：合成账号名由 `admverify_` + 描述性后缀 + 14 位 `RUN_TAG` 组成，超过 `base_user_account.login_name varchar(30)`。属**新增规格的夹具缺陷**，不是产品/迁移缺陷。
  - 最小修复：`RUN_TAG` 缩短为 8 位；用例后缀压到 ≤10 字符（如 `cflevel`、`cforg`、`mapexist`、`missorg`、`missinfo`、`emailown`、`colfirst`、`colsecond`），保持总长 ≤30。不改断言、不改业务代码。
- **根因 B（用例 5）**：`rowCountsBefore` 在 `beforeAll` 中于创建 3 个合成公司**之后**采样，收尾只回收本轮夹具，导致 `organization` 期望 4、实际 1。
  - 最小修复：把行数基线与结构基线在“普通 init 完成后、创建合成公司之前”采样；或在收尾断言中按“基线组织 1 行”比对。建议前者，保持“非目标数据不变”的原始语义。
- 上述两处均为测试实现缺陷；**未修改任何断言以迁就结果，未改产品代码、迁移或部署行为**。
- 复跑前置：本轮授权目标库已不是空库，且规则禁止 DROP/清库；在获得**新的空库授权**前不得复跑。现场未被破坏，可直接用于只读取证。

### 20.7 现场与残留（失败后）

- `lithography_v13_admin_verify`：52 表、39 条迁移（末条 `AddRecordPackageCheckAndImportResultStatesForV131775501700000`）、0 视图/触发器/例程/事件。
- 夹具零残留：`base_user_account=0`、`base_user_info=0`、非基线 `organization=0`、`admverify%` 账号 0；仅保留迁移种子 `CLIENT_DEFAULT` 1 行。
- 无迁移锁（`IS_USED_LOCK=NULL`）、无活动事务、无目标库使用中连接。
- AUTO_INCREMENT（仅记录，不重置）：`base_user_account=7`、`base_user_info=7`、`organization=5`。
- 其他验证库未触碰；`init/up30/up31/spec/e2e` 未操作。
- 证据：`/home/gandiantx/secure/lithography-v13/evidence/s4/20261109-r1/admin-verify/`（`precheck.txt`、`create-db.txt`、`candidates.txt`、`migration-fingerprints.txt`、`command.txt`、`jest.log`、`post-run.txt`）。

### 20.8 未覆盖与未执行

- 未取得证据：等级冲突、归属冲突、已有账号补映射（不改密码）、缺资料、邮箱碰撞整批回滚、注入故障整批回滚、收尾零残留断言（清理动作本身已执行）。
- 未执行：C 场景、真实管理员初始化、完整 core、Redis、其他验证库升级、commit、push。
- 本轮失败即停止，未清库重跑、未连续重跑、未改断言、未绕过守卫。

## 第二十一轮：管理员初始化实库规格最小修复（2026-11-09，不写库）

### 21.1 范围与边界

- 仅修改 `backend/src/modules/account/base/services/admin-bootstrap.realdb.spec.ts`、本执行记录与 S4 预检。
- 未改产品代码、Entity、Migration、数据库约束；未建库、未连库写数据、未启用实库规格、未 DROP、未清库、未操作 Redis、未跑完整 core。
- 未 commit、未 push；分支仍为 `feat/database-v13-deploy`，`HEAD=72de1096d0a2aa2d62ed55a48ab49ebc3398000a`，工作区原有改动全部保留。
- 第二十轮的 **5 passed / 7 failed** 历史保持不变；本轮不把任何未进入断言的场景写成已通过。

### 21.2 夹具生成修复

- 运行标识 `RUN_TAG`：由 14 位（时间 36 进制 + UUID 片段）改为固定 **8 位**（3 位时间基 + 5 位随机十六进制），单次运行内稳定、跨运行低碰撞。
- 场景代号改为**简短固定**的联合类型：`l1a..l2c`、`cflevel`、`cforg`、`mapexist`、`missorg`、`missinfo`、`emailown`、`colfirst`、`colsecond`、`rba/rbb/rbc`、`invalidlevel`、`duplicate`、`misspassword`、`missorgcode`。
- 命名结构统一为 `adm_<场景>_<RUN_TAG>`，最长 3+1+12+1+8 = **25**，低于 `login_name varchar(30)`。
- `ensureLength` 对每个字段做**上限校验并在超长时抛错**，不截断最终字符串，避免不同场景被截断成同一值：
  - `base_user_account.login_name varchar(30)`、`login_email varchar(100)`；
  - `base_user_info.nickname varchar(50)`、`real_name varchar(200)`；
  - `organization.organization_code varchar(64)`、`organization.name varchar(200)`。
- 生成器：`fixtureLoginName / fixtureEmail / fixtureNickname / fixtureRealName / fixtureInfoNickname / fixtureOrganizationCode / fixtureOrganizationName / fixtureMissingOrganizationCode`。

### 21.3 基线采样修复

- `structureBefore`、`rowCountsBefore`、`historyBefore`、`tableCountBefore` 前移到**普通 `init` 完成后、任何合成公司/账号创建之前**采集。
- 采样后立即校验“迁移种子 vs 本轮夹具”的边界：`organization=1`（仅 `CLIENT_DEFAULT`）、`base_user_account=0`、`base_user_info=0`；不满足即失败关闭。
- 收尾用例 5 仍与原基线逐项比较（结构摘要、全表行数、迁移历史摘要、表数、锁、活动事务），**未把期望值改成清理后的实际值**。

### 21.4 失败场景夹具复核

- 3a/3b/3c/3e/3f/3g 先构造**长度与唯一键均合法**的基础账号，再只注入目标冲突（等级冲突、归属冲突、补映射、缺资料、邮箱碰撞、第 2 条资料写入失败）。
- `createFixtureAccount` 在 INSERT 前登记登录名、成功后立即登记账号 ID；`insertOrganization` 成功后立即登记公司 ID；`writeMappingFile` 创建后立即登记文件名与登录名。异常收尾不依赖业务断言是否通过。
- 3d 的“缺公司”改用 `fixtureMissingOrganizationCode()`，与 `CLIENT_DEFAULT` 及 3 个合成公司编码均不冲突。

### 21.5 生命周期与超时复核

- 第二十轮成功场景耗时：用例 1 ≈ 7.3 s、用例 2 ≈ 7.0 s；对应局部超时已分别为 `180_000` ms，余量充足。
- 现有局部超时：`beforeAll 300_000`、`afterAll 180_000`、用例 0 `120_000`、用例 1/2 `180_000`、3a–3g `120_000`、用例 5 `180_000`；用例 4 为纯内存/文件解析，未设局部超时，走全局 `testTimeout: 10000`，无需调整。
- 未修改全局超时，未新增 `retry` 或 `skip`，未新增任何延时。

### 21.6 不连库生成器回归（新增）

- 新增独立 `describe('S4 夹具生成器回归（不连库）')`，不依赖 E2E 变量与数据库，始终执行：
  - 运行标识为 8 位小写字母数字；
  - 全部账号场景 `login_name`/`login_email`/`nickname`/`real_name` 长度合规、格式匹配、跨场景不重复；
  - 全部组织场景 `organization_code`/`name` 长度合规、格式匹配、跨场景不重复，“缺公司”编码不与真实场景编码重复；
  - 超长场景代号直接抛错（验证“不截断”）。
- 结果：**4 passed**。

### 21.7 静态验证（本轮，不启用实库）

| 项目                          | 命令                                                                                              | 结果                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 正式类型检查                  | `npx tsc -p tsconfig.build.json --noEmit`                                                         | 退出 0                                                                                                          |
| spec 类型检查                 | `npx tsc -p tsconfig.spec.json --noEmit`                                                          | 退出 0                                                                                                          |
| 相关纯单测                    | `npx jest --runInBand --testPathPatterns '(database-deploy\|admin-bootstrap\.realdb)\.spec\.ts$'` | 2 suites passed；**12 passed / 12 skipped / 0 failed**（8 个 deploy 单测 + 4 个生成器回归；12 个实库用例 skip） |
| 变更文件 ESLint（无 `--fix`） | `npx eslint src/modules/account/base/services/admin-bootstrap.realdb.spec.ts`                     | 退出 0                                                                                                          |
| Prettier                      | `npx prettier --check src/modules/account/base/services/admin-bootstrap.realdb.spec.ts`           | 通过                                                                                                            |
| 空白检查                      | `git diff --check`                                                                                | 退出 0                                                                                                          |

- 规格文件 SHA-256：`d2214741cccea953c800dbf6c4f9fd941816a2a9aaf5687cad2608a0dcf1fe31`（1528 行）。

### 21.8 下一轮：新库申请（本轮未创建）

- 建议新目标库：**`lithography_v13_admin_verify_r2`**。
- 本轮**未创建**该库、未写配置凭据、未复用或清空原验证库 `lithography_v13_admin_verify`。
- 规格可直接接受新目标：库名全部来自 `E2E_REAL_DB_NAME` / `E2E_ALLOWED_DB_NAMES` / 显式 env 文件，无硬编码；只要求目标为空库（无表、无迁移历史）、实际 `DATABASE()`、config `DB_NAME`、`@@server_uuid` 与授权一致，且 MySQL 8.0.x。
- 最小授权建议（仅 `lithography_v13_admin_verify_r2.*`）：`SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES`；不使用 `GRANT OPTION`，不授予全局权限；建库本身由 DBA 或具备全局 `CREATE` 的账号执行。
- 准确命令（授权后执行，本轮不执行）：
  - 建库：`CREATE DATABASE \`lithography_v13_admin_verify_r2\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`
  - 首次 `init`：`npm run database:deploy -- --mode=init --config-file=<r2 env> --database=lithography_v13_admin_verify_r2 --confirm-database=lithography_v13_admin_verify_r2`
  - 专项：`E2E_ADMIN_BOOTSTRAP_SPECS=1 E2E_ALLOW_ADMIN_BOOTSTRAP=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_REAL_DB_NAME=lithography_v13_admin_verify_r2 E2E_ALLOWED_DB_NAMES=lithography_v13_admin_verify_r2 E2E_REAL_DB_CONFIG_FILE=<r2 env> E2E_EXPECTED_SERVER_UUID=909f9587-9fce-11f1-a353-00e0709ef3a9 E2E_ADMIN_BOOTSTRAP_DIR=<0700 目录> npx jest --runTestsByPath src/modules/account/base/services/admin-bootstrap.realdb.spec.ts --runInBand --verbose`
  - 收尾：由规格用例 5 仅按本轮登记的登录名/账号 ID/公司 ID 精确 `DELETE`，不 DROP、不清表；执行后只读核对残留、锁与活动事务。
- 前置约束：r2 env 文件须 0600 且 `DB_NAME=lithography_v13_admin_verify_r2`；映射目录须 0700；执行前再次确认 `@@server_uuid` 未变化。

### 21.9 本轮状态

- 仅完成代码修复与静态验证；**未启用实库规格**，第二十轮的 7 个失败场景仍未取得实库通过证据。
- 等待新库 `lithography_v13_admin_verify_r2` 的实库授权后再复跑。

## 第二十二轮：管理员初始化专项第二轮实库验收（2026-11-09，新库 r2）

### 22.1 授权与执行边界

- 实例：`127.0.0.1:3306`，`@@server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`（执行前核对一致）。
- 目标库：`lithography_v13_admin_verify_r2`（执行前不存在，现场核对 `information_schema.schemata` = 0）。
- 使用现有 `gandiantx` 账号；未创建/扩权 MySQL 账号，未改系统权限表。
- 保留 `lithography_v13_admin_verify` 及所有其他现场（复核实库 52 表、账号 0）。
- 未操作 Redis、未跑完整 core、未初始化真实管理员、未 DROP、未清库、未 commit、未 push。
- HEAD 仍为 `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`，分支 `feat/database-v13-deploy`，工作区原有改动全部保留。

### 22.2 候选指纹（执行前冻结）

| 候选                                                                       | SHA-256                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `backend/src/infrastructure/database/admin-bootstrap.ts`                   | `aeba47227e9a6a25cbb7bd3042b1abd4d310b574d967e19030c022ec40269d55` |
| `backend/src/infrastructure/database/database-deploy.ts`                   | `b0b776ab0d54eaab17316f0d7a66ea68fc0afbb4a71ab1ecea42555ac9de6e30` |
| `backend/src/infrastructure/database/incremental-migration.ts`             | `bd1d19a2aab1b852652471e494ad870418f3b3619d801b12c21cd414d9dda102` |
| `backend/src/modules/account/base/services/admin-bootstrap.realdb.spec.ts` | `d2214741cccea953c800dbf6c4f9fd941816a2a9aaf5687cad2608a0dcf1fe31` |
| `backend/src/modules/account/base/services/account.service.ts`             | `034baec9c1cb6b86d54d87a1b8a73c6e8dc8fcc22c595c058b9c37ba1fcf2d71` |
| `backend/scripts/database-deploy.ts`                                       | `6db2bdbaf5fa3f7dbbdabe441ccef03db6eec02314fbd9c5976cdc4d68512d8e` |

- 39 条迁移逐文件 SHA-256 与 `S4-39-migration-sha256.md` 完全一致：
  - 前 38 条聚合 `624c4570ef86873b363370a93b9746355ba0e0b57c46baec430a1f9e5f96f86d`；
  - 全 39 条聚合 `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`；
  - 第 39 条文件 `2c59866f614ba4b4b783f54bde7a9907f6759250d45aa2d0760f114177a6ecfb`。
- 证据目录：`/home/gandiantx/secure/lithography-v13/evidence/s4/20261109-r2/admin-verify-r2/`（`precheck.txt`、`candidates.txt`、`migration-fingerprints.txt`、`create-db.txt`、`command.txt`、`jest.log`、`post-run.txt`、`residue.txt`，全部 0600）。

### 22.3 执行前判断与建库

- 规格 `beforeAll` 会自行在**空库**上执行普通 `init`（`runInitWithoutAdmin`），因此**只预建空数据库**，未额外运行正式 `init`，避免重复初始化。
- 建库实际采用值：`CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`（按冻结部署契约；与 r1 使用的 `utf8mb4_unicode_ci` 不同，已如实记录）。
- 配置：`/home/gandiantx/secure/lithography-v13/configs/lithography-v13-admin-verify-r2.env`（0600，`DB_NAME=lithography_v13_admin_verify_r2`，`DB_SYNCHRONIZE=false`）。
- 映射目录：`/home/gandiantx/secure/lithography-v13/admin-verify-r2`（0700）。
- 随机管理员密码仅写入上述 0700 目录内的 0600 映射文件，未打印密码或完整哈希。

### 22.4 准确命令与结果

```bash
cd /home/gandiantx/lithography-platform/backend
E2E_ADMIN_BOOTSTRAP_SPECS=1 E2E_ALLOW_ADMIN_BOOTSTRAP=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
E2E_REAL_DB_NAME=lithography_v13_admin_verify_r2 E2E_ALLOWED_DB_NAMES=lithography_v13_admin_verify_r2 \
E2E_REAL_DB_CONFIG_FILE=/home/gandiantx/secure/lithography-v13/configs/lithography-v13-admin-verify-r2.env \
E2E_EXPECTED_SERVER_UUID=909f9587-9fce-11f1-a353-00e0709ef3a9 \
E2E_ADMIN_BOOTSTRAP_DIR=/home/gandiantx/secure/lithography-v13/admin-verify-r2 \
npx jest --runTestsByPath src/modules/account/base/services/admin-bootstrap.realdb.spec.ts --runInBand --verbose
```

- 退出码 **1**；`Tests: 1 failed, 15 passed, 16 total`；耗时 35.3 s。
- 离线生成器回归：**4 passed / 0 failed / 0 skipped**。
- 实库用例：**11 passed / 1 failed / 0 skipped**。

| 用例                              | 结果       | 证据                                                       |
| --------------------------------- | ---------- | ---------------------------------------------------------- |
| 0. 普通 init 未显式启用不建管理员 | passed     | 20 ms，账号 0                                              |
| 1. 合法首次初始化 3+3             | passed     | 7155 ms，等级/归属/`must_change_password=1` 正确，密码可验 |
| 2. 同映射重跑全部 UNCHANGED       | passed     | 7030 ms，无新增、密码与资料无漂移                          |
| 3a. 等级冲突拒绝                  | passed     | 76 ms                                                      |
| 3b. 归属冲突拒绝                  | passed     | 27 ms                                                      |
| 3c. 已有账号补映射不重置密码      | passed     | 51 ms                                                      |
| 3d. 缺公司拒绝                    | passed     | 8 ms                                                       |
| 3e. 缺资料拒绝                    | passed     | 23 ms                                                      |
| 3f. 邮箱碰撞整批回滚              | passed     | 92 ms                                                      |
| **3g. 注入第 2 条资料写入失败**   | **failed** | 67 ms，见 22.5                                             |
| 4. 输入与配置拒绝                 | passed     | 29 ms                                                      |
| 5. 受保护收尾回到基线             | passed     | 175 ms                                                     |

### 22.5 失败详情与根因（未改断言、未重跑）

- 断言：`expect(applyAdminBootstrap(failing, mapping)).rejects.toThrow(INJECTED_FAILURE)` 实际 **resolved**，返回 3 条 `CREATED`（`adm_rba_pgif4a7b`、`adm_rbb_pgif4a7b`、`adm_rbc_pgif4a7b`）。
- 根因（已核对 TypeORM 实现）：`applyAdminBootstrap` 全程使用 `manager.query(...)`；`EntityManager.transaction` 用 `this.dataSource.createQueryRunner()` 开启事务后，回调拿到的是 `queryRunner.manager`，其 `query` 走 `this.dataSource.query(sql, params, this.queryRunner)`；`FailingDataSource` 只重写了 `createQueryRunner`，没有重写 `DataSource.query`，因此 `INSERT INTO \`base_user_info\`` 的注入分支从未命中。
- 影响：3g 实际提交了 3 个账号与 3 条资料；随后用例 5 受保护收尾按登记登录名精确回收，库回到基线（用例 5 passed），未遗留夹具。
- 最小修复方向（下一轮执行，不改任何断言）：在 `FailingDataSource` 增加 `override query(sql, parameters, queryRunner)`，对第 2 条 `INSERT INTO \`base_user_info\``抛`INJECTED_ADMIN_BOOTSTRAP_FAILURE`后再委托`super.query`；`createQueryRunner`代理可保留或删除，但注入必须落在实际被调用的`DataSource.query` 上。
- 本轮严格遵守“任一失败即停止后续阶段”：未修复后重跑、未清库、未改断言、未绕过守卫。

### 22.6 收尾与数据保留（只读核对）

| 项目                                                           | r2 实测                        | 结论                           |
| -------------------------------------------------------------- | ------------------------------ | ------------------------------ |
| 表数量                                                         | 52                             | 与冻结结构一致                 |
| 迁移历史                                                       | 39                             | 与冻结候选一致                 |
| `organization`                                                 | 1 行，仅 `CLIENT_DEFAULT`      | 迁移种子未变                   |
| `base_user_account` / `base_user_info`                         | 0 / 0                          | 夹具、3g 已提交结果均被回收    |
| 迁移锁 `lithography:migration:lithography_v13_admin_verify_r2` | `NULL`                         | 已释放                         |
| 目标库活动连接                                                 | 0                              | 无残留连接                     |
| `AUTO_INCREMENT`                                               | 账号 17 / 资料 15 / 公司 5     | **单独记录，未重置**           |
| 原 `lithography_v13_admin_verify`                              | 52 表、账号 0                  | 未触碰                         |
| 映射临时文件                                                   | 8 个 0600 文件保留在 0700 目录 | 未删除，含随机密码，仅受限可读 |
| jest 进程                                                      | 无                             | —                              |

- 结构、迁移历史与种子由用例 5 的摘要比较（`structureDigest` / `historyDigest` / 全表行数 / 表数）独立复核为不变，另有上述只读查询佐证。
- 首轮（第二十轮）**5 passed / 7 failed** 历史保留，本轮的 3g 失败不视为通过。

### 22.7 下一轮：新库申请（本轮未创建）

- r2 现已非空（39 迁移 / 52 表）且必须保留，规格只接受空库，**不能**在 r2 上复跑。
- 建议新目标库：**`lithography_v13_admin_verify_r3`**。
- 最小授权同上：现账号 `gandiantx` 已具备全局建库权限，无需扩权；目标库内最小权限 `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES`。
- 命令：`CREATE DATABASE \`lithography_v13_admin_verify_r3\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;` 后，新建 0600 r3 env（`DB_NAME=lithography_v13_admin_verify_r3`）与 0700 映射目录，再以同一 8 个 `E2E_*`变量运行规格；不需要预跑正式`init`。
- 前置：修复 3g 注入点（`FailingDataSource.query`）并通过类型检查/离线回归后，再申请 r3 实库授权。

## 第二十三轮：3g 故障注入最小修复（2026-11-09，不写库）

- 仅改 `admin-bootstrap.realdb.spec.ts`（未跟踪文件）与本记录/预检；未改产品代码、迁移、Entity、约束；未建库、未连库写入、未操作 Redis、未跑完整 core、未建真实管理员、未 DROP、未清库、未 commit、未 push。HEAD 仍 `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`，工作区与 stash 未动。
- 根因确认（与第二十二轮一致）：`applyAdminBootstrap` → `manager.query` → `EntityManager.query` → `this.dataSource.query(sql, parameters, this.queryRunner)`；原替身只重写 `createQueryRunner`，真实路径不经过它。
- 修复：删除 `createQueryRunner` 代理，改为 `override query<T>(sql, parameters, queryRunner)`；未注入调用 `await super.query<T>(sql, parameters, queryRunner)` 原样委托并透传同一 QueryRunner/参数；仅当本次初始化的第 2 条 `base_user_info` INSERT 时抛 `INJECTED_ADMIN_BOOTSTRAP_FAILURE`。
- 表识别：`insertTargetTable` 只解析语句首行“关键字 + 表名”（兼容缩进/反引号/大小写），不做整条 SQL 字面量匹配。
- 探针（`FailingDataSource.probe`）：`infoInsertAttempts`、`successfulInserts`、`injectionCount`、`injectedError`、`insertRunners`。
- 3g 断言顺序：业务失败后、任何清理前依次校验注入命中恰一次（`injectionCount=1`、`infoInsertAttempts=2`）、错误即预设错误、故障前本事务已有 ≥3 条成功写入、委托写入复用同一 QueryRunner、账号与资料均 0 行。未用 afterAll 清理后的零行数证明回滚。
- 新增离线回归 `describe('S4 故障注入调用路径回归（不连库）')` 3 个用例：语句头部解析；注入命中一次且未注入调用按 SQL/参数/QueryRunner 同一对象委托、注入后恢复委托；`EntityManager.query` 经 `DataSource.query` 转发并携带事务 QueryRunner。
- 证据边界：离线只证明调用路径、命中与委托上下文；MySQL 事务真实回滚语义仍只能在 r3 实库验证，本轮**不声称已实测回滚**。
- 静态验证：`tsc -p tsconfig.build.json --noEmit` 0；`tsc -p tsconfig.spec.json --noEmit` 0；`jest database-deploy + 本规格` **15 passed / 12 skipped / 0 failed**（离线 4 生成器 + 3 注入路径）；ESLint（无 `--fix`）0；Prettier 通过；`git diff --check` 0。规格 SHA-256 `0fb23b16…748d`（1678 行）。
- 第二十二轮 r2 **15 passed / 1 failed** 记录保留不变，3g 仍记为未通过。
- 文档证据链接：仓库内已均为 `20261109-r2`（`grep 20260909` 无命中），无需修改；上一轮对话回复中的 `20260909-r2` 属笔误，不影响磁盘证据。
- 下一轮 r3 实库复跑授权范围见 23.1。

### 23.2 覆盖签名与错误身份修正（同轮追加，仍不写库）

- `FailingDataSource.query` 覆盖签名改为 `query<T = unknown>(sql: string, parameters?: unknown[], queryRunner?: QueryRunner)`，与 TypeORM `DataSource.query<T = any>(query: string, parameters?: any[] | ObjectLiteral, queryRunner?: QueryRunner)` 兼容；未使用 `eslint-disable`、未强转、未改委托参数与 QueryRunner。
- 3g 改为手动捕获 `applyAdminBootstrap` 抛出的错误：断言 `thrown === failing.probe.injectedError`（**同一对象实例**）。依据：产品事务回调无 try/catch，TypeORM `EntityManager.transaction` 在 rollback 后原样 `throw err`，不存在包装层，故无需核对 `cause`。
- 探针 1/3/4（注入次数、故障前成功写入、同一事务上下文）与清理前零新增断言保持不变；`injectedError` 的 message 断言仅作补充，不再单独用于声称身份一致。
- 复验：`tsc` build/spec 均 0；`jest` **15 passed / 12 skipped / 0 failed**；ESLint（无 `--fix`）0；Prettier 通过；`git diff --check` 0。规格 SHA-256 `8d5343fd…aab9`（1688 行）。
- r2 的 **15 passed / 1 failed** 记录仍保留；3g 仍未取得实库通过证据，等待 r3 授权。

### 23.1 r3 实库复跑最小授权（本轮未执行）

- 实例/账号不变：`127.0.0.1:3306`、`@@server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`、现有 `gandiantx`；不建/不扩 MySQL 账号、不改系统权限表。
- 新空库 `lithography_v13_admin_verify_r3`（`utf8mb4 / utf8mb4_0900_ai_ci`）；仅该库最小权限 `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES`。
- 只需预建空库（规格 `beforeAll` 自行 init），不预跑正式 init；配置 0600、映射目录新建 0700；不触碰 r1/r2。
- 命令与 r2 相同，仅替换 `E2E_REAL_DB_NAME`、`E2E_ALLOWED_DB_NAMES`、`E2E_REAL_DB_CONFIG_FILE`、`E2E_ADMIN_BOOTSTRAP_DIR`，其余 8 个变量与 `--runTestsByPath ... --runInBand --verbose` 不变。

## 第二十四轮：管理员初始化专项 R3 实库验收（2026-11-09，通过）

### 24.1 前置核验（全部一致）

| 项目            | 实测                                                                                                                                                                                                 | 结论             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| HEAD / 分支     | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a` / `feat/database-v13-deploy`                                                                                                                              | 未变             |
| 规格 SHA-256    | `8d5343fdddeae88e63d34e8b6531df7b60cd53e471d7f49b937f89c9b053aab9`                                                                                                                                   | 与要求一致       |
| 39 条迁移聚合   | `8827ded2…707f`（前 38 条 `624c4570…f86d`）                                                                                                                                                          | 与冻结一致       |
| 源码候选        | `admin-bootstrap.ts aeba4722…9d55`、`database-deploy.ts b0b776ab…6e30`、`incremental-migration.ts bd1d19a2…a102`、`account.service.ts 034baec9…2d71`、`scripts/database-deploy.ts 6db2bdbaf5fa…2d8e` | 与第二十二轮一致 |
| `@@server_uuid` | `909f9587-9fce-11f1-a353-00e0709ef3a9`                                                                                                                                                               | 一致             |
| R3 库存在性     | 0                                                                                                                                                                                                    | 新建前为空       |
| r1 / r2         | 各 52 表、账号 0                                                                                                                                                                                     | 未触碰           |

- 只预建空库 `lithography_v13_admin_verify_r3`（`utf8mb4 / utf8mb4_0900_ai_ci`），未预跑 `database:deploy`（规格 `beforeAll` 自行 init）。
- 配置：`/home/gandiantx/secure/lithography-v13/configs/lithography-v13-admin-verify-r3.env`（0600，`DB_NAME=lithography_v13_admin_verify_r3`）；映射目录 `/home/gandiantx/secure/lithography-v13/admin-verify-r3`（0700）。未打印密码或完整哈希。
- 证据：`/home/gandiantx/secure/lithography-v13/evidence/s4/20261109-r3/admin-verify-r3/`（`precheck.txt`、`candidates.txt`、`migration-fingerprints.txt`、`create-db.txt`、`command.txt`、`jest.log`、`post-run.txt`、`residue.txt`、`3g-probes.txt`，全部 0600）。

### 24.2 准确命令与结果

```bash
cd /home/gandiantx/lithography-platform/backend
E2E_ADMIN_BOOTSTRAP_SPECS=1 E2E_ALLOW_ADMIN_BOOTSTRAP=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
E2E_REAL_DB_NAME=lithography_v13_admin_verify_r3 E2E_ALLOWED_DB_NAMES=lithography_v13_admin_verify_r3 \
E2E_REAL_DB_CONFIG_FILE=/home/gandiantx/secure/lithography-v13/configs/lithography-v13-admin-verify-r3.env \
E2E_EXPECTED_SERVER_UUID=909f9587-9fce-11f1-a353-00e0709ef3a9 \
E2E_ADMIN_BOOTSTRAP_DIR=/home/gandiantx/secure/lithography-v13/admin-verify-r3 \
npx jest --runTestsByPath src/modules/account/base/services/admin-bootstrap.realdb.spec.ts --runInBand --verbose
```

- 退出码 **0**；`Tests: 19 passed, 19 total`；`1 passed` suite；耗时 35.489 s。
- 离线：**7 passed / 0 failed / 0 skipped**（4 夹具生成器 + 3 故障注入调用路径）。
- 实库：**12 passed / 0 failed / 0 skipped**（用例 0、1、2、3a–3g、4、5）。

| 用例                                           | 结果       | 耗时            |
| ---------------------------------------------- | ---------- | --------------- |
| 0. 普通 init 未显式启用不建管理员              | passed     | 17 ms           |
| 1. 合法首次初始化 3+3，密码可验、必须改密      | passed     | 7119 ms         |
| 2. 同映射重跑全部 UNCHANGED、无漂移            | passed     | 7047 ms         |
| 3a 等级冲突 / 3b 归属冲突 / 3c 补映射          | passed     | 75 / 28 / 48 ms |
| 3d 缺公司 / 3e 缺资料 / 3f 邮箱碰撞            | passed     | 8 / 28 / 88 ms  |
| **3g 第 2 条资料写入注入失败，单事务整体回滚** | **passed** | 46 ms           |
| 4. 输入与配置拒绝、目标不一致不建连接          | passed     | 28 ms           |
| 5. 受保护收尾回到基线                          | passed     | 176 ms          |

### 24.3 3g 直接证据

- 注入点：第 2 条 `base_user_info` INSERT 前 `injectionCount === 1`、`infoInsertAttempts === 2`（恰一次）。
- 错误身份：`thrown === failing.probe.injectedError`，同一 `Error` 实例；产品无包装层。
- 故障前写入：`successfulInserts >= 3`（账号 + 资料在本事务内已成功写入）。
- 事务上下文：`insertRunners.length === successfulInserts` 且 `new Set(...).size === 1`，全部委托复用同一 QueryRunner。
- 回滚可见性：业务失败后、`failing.destroy()` 与任何清理前，`base_user_account` / `base_user_info` 均为 **0**；不以 afterAll 清理结果代替。
- 明细见证据目录 `3g-probes.txt`。

### 24.4 收尾与保留状态

| 项目                              | R3 实测                                                  |
| --------------------------------- | -------------------------------------------------------- |
| 表 / 迁移                         | 52 / 39                                                  |
| `organization`                    | 1 行，仅 `CLIENT_DEFAULT`                                |
| 账号 / 资料 / 成员关系            | 0 / 0 / 0                                                |
| `adm_` 前缀账号 / 资料 / 公司残留 | 0 / 0 / 0                                                |
| 迁移锁                            | `NULL`                                                   |
| `innodb_trx` / 目标库连接         | 0 / 0                                                    |
| `AUTO_INCREMENT`                  | 账号 16 / 资料 13 / 公司 5（仅记录，未重置）             |
| r1 / r2                           | 各 52 表、账号 0，未触碰                                 |
| 映射临时文件                      | 8 个 0600 文件，保留在 0700 目录                         |
| jest 进程                         | 无                                                       |
| git                               | 70 项改动原样保留、stash 3 项、HEAD 未变；未 commit/push |

- 运行前后 39 条迁移逐文件清单 `cmp` 一致（`MIGRATION_FILES_UNCHANGED=yes`，聚合仍 `8827ded2…707f`）。
- 清理依据：创建登记事实 + 实际库名守卫 + 逐字段所有权/引用闭包核验；仅按本轮登录名/账号 ID/公司 ID 精确删除，保留迁移种子。

### 24.5 结论

- R3 专项 **19/19 通过**，3g 首次取得实库回滚证据；第二十轮 5 passed/7 failed、第二十二轮 15 passed/1 failed 的历史均保留不变。
- 本轮未 DROP、未清库、未重跑、未改断言、未绕过守卫；完整 core 未运行。

## 第二十五轮：S4 最终稳定候选 KEEP 模式完整 core 验收（2026-11-09，阻断）

| 项       | 值                                                                                     |
| -------- | -------------------------------------------------------------------------------------- |
| 分支     | `feat/database-v13-deploy`（未切换）                                                   |
| HEAD     | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未 commit）                                |
| 工作区   | 70 项改动原样保留；stash 3 项；暂存区空                                                |
| 测试目标 | `127.0.0.1:3306` / `909f9587-9fce-11f1-a353-00e0709ef3a9` / `lithography_e2e`          |
| 结论     | **core 未通过**：第 1/51 个规格 `00-app` 在 TypeORM 初始化阶段失败，按规则停止后续验收 |

### 25.1 冻结与候选

- 初次 ESLint/Prettier 检查发现 1 个未跟踪规格 `record-package-state.migration.realdb.spec.ts` 有 110 个 `prettier/prettier` 错误；仅对该文件执行 `prettier --write` 最小修复，随后**重新冻结并从非写库门禁从头重跑**，未拼接修复前后的结果。
- 重新冻结：`STATUS_SHA=ae29d491…e037`、`DIFF_SHA=225a839b…6a42`、暂存区空（`e3b0c442…b855`）；tracked 1461 文件聚合 `12194702…7a572`，untracked 55 文件聚合 `11f1d0db…c527`（逐文件清单见证据目录）。
- 39 条迁移逐文件 SHA-256：39/39，聚合 `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`；前 38 条 `624c4570…f86d`、第 39 条 `2c59866f…6ecfb`，与冻结清单一致。

### 25.2 非写库门禁（修复后重跑）

| 检查                                | 结果                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `npm run typecheck`（build+tools）  | 退出码 0                                                                        |
| `tsc -p tsconfig.spec.json`         | 退出码 0                                                                        |
| 相关单测（9 个套件）                | 9 passed / 3 skipped；93 passed / 58 skipped                                    |
| 待交付 TS 文件 ESLint（无 `--fix`） | 0 error / 11 warning，退出码 0                                                  |
| Prettier `--check`                  | 全部通过                                                                        |
| 架构门禁 4 项                       | entity-scope / architecture-fixtures / usecase-normalize / capability-docs 均 0 |
| `npm run build`                     | 退出码 0                                                                        |

### 25.3 测试目标与正式升级

- 实例核验：`@@server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`、MySQL `8.0.46-0ubuntu0.24.04.4`；目标库 `lithography_e2e` 无其他连接（0）。
- 升级前受限备份：目录 0700，`lithography_e2e-full.sql` / `lithography_e2e-schema.sql` / `migrations-rows.txt` / 逐表 counts 与 checksums，全部 0600，未输出密码。
- 旧态：31 条迁移、35 表、业务数据 0 行（表行数均为 0，仅 `migrations` 31 行）。
- 第 39 条影响的非本轮历史记录：**无**；`record_package_*` 由第 32—38 条新建，升级前不存在。
- 正式入口：`status` → `database:deploy --mode=upgrade` → `migration:verify` → 再次 `upgrade`，均使用显式 `--config-file` / `--database` / `--confirm-database`。
- 结果：status 报历史 31 / 仓库 39 / pending 8；upgrade 退出码 0，执行 8 条，业务表 51 张；verify 退出码 0；再次 upgrade 报 pending 0、无变化。终态 39 条迁移、52 表、结构校验通过；旧数据（0 行业务数据）保持。

### 25.4 独占 Redis 与专用配置

- 专用配置：`/home/gandiantx/secure/lithography-v13/configs/lithography-e2e-core.env`（0600）；`DB_NAME=lithography_e2e`、`REDIS_HOST=127.0.0.1`、`REDIS_PORT=16379`、`REDIS_DB=0`。
- 配置加载实测：`E2E_DOTENV` 绝对路径生效；`skipDbCleanup=true`、`allowDbCleanup=false`、白名单 `lithography_e2e`、MySQL 连接与 51 实体加载均按预期打印。
- teardown 边界：env 文件名不为 `.env.e2e`，`global-teardown-e2e` 不执行 Redis `FLUSHDB`；未访问共享 6379。
- 独占 Redis：`mktemp` 目录 0700，`bind 127.0.0.1` / `port 16379`，PID `2060004`，配置 SHA-256 `f19f65e5…5d5b`；`CONFIG DIR` 与运行目录一致；结束后以 `SHUTDOWN NOSAVE` 正常关闭，进程消失、16379 关闭、6379 仍由原实例监听。

### 25.5 KEEP 与基线

- 在 `lithography_e2e` 业务表预置 6 行合成 KEEP（ID 900000001）：`organization`、`base_user_account`、`base_user_info`、`organization_membership`、`equipment_model`、`repair_request`，含账号/资料、组织/成员、机型/工单及引用闭包。
- 独立 KEEP 账本 `keep-ledger.json` 登记真实 ID、业务键与创建事实；未进入任何规格清理账本，未使用前缀/全表删除。
- 运行前基线：全库逐表行数与 `CHECKSUM TABLE`、KEEP 全字段、39 条迁移、触发器集合（空）、文件哨兵 SHA-256 `4e59a94d…e409`。

### 25.6 完整 core

- 命令：`npm run test:e2e:core`（backend，显式 `E2E_DOTENV`、`E2E_SKIP_DB_CLEANUP=true`、`E2E_ALLOW_DB_CLEANUP=0`、`E2E_ALLOW_PHYSICAL_CLEANUP=1`、`E2E_ALLOWED_DB_NAMES=lithography_e2e`）。
- 退出码 **1**，`2026-11-09T10:11:01+08:00`—`10:11:53+08:00`；仅启动 **1/51** 个规格即终止。
- 停止位置：`test/00-app/00-app.e2e-spec.ts`（首个规格）；`run-e2e-group.js` 在子进程非 0 时立即退出。
- 结果：`Test Suites: 1 failed, 1 total`；`Tests: 6 failed, 6 total`；本规格 passed/skipped 均为 0。
- 失败：`TypeORMError: Entity metadata for IntakeAnalysisAttemptEntity was not found...`，Nest `ApiModule` 的 `autoLoadEntities` 在 `DataSource.buildMetadatas` 阶段连续重试后失败。
- 只读定位：`intake-analysis-attempt.entity.ts` 以字符串 `@ForeignKey('AiProviderCallRecordEntity', ...)` 引用 `AiProviderCallRecordEntity`；后者仅由 `ai-provider-call-record.module.ts` 注册，而该模块只被 worker usecase 模块导入，未进入 `src/bootstraps/api/api.module.ts` 的 API 依赖图，导致 API 实体集合缺失该元数据。未修改产品代码/迁移/runner。
- 未取得 skip 清单：运行在首个规格即停止，未执行到其余 50 个规格；未将默认跳过的实库规格记为本轮通过。此前 R3 独立实测 19/19 仍作为单独证据，不并入本轮 core 结果。
- 未删断言、未加 skip、未放宽权限/清理保护、未用文件列表替代标准入口、未补跑拼接为成功。

### 25.7 运行后核验与受保护收尾

| 对照项                          | 结果                                |
| ------------------------------- | ----------------------------------- |
| KEEP 6 行全字段/引用            | 与基线一致（diff 空）               |
| 全库逐表行数与 `CHECKSUM TABLE` | 与基线一致（diff 空）               |
| 39 条迁移 / 触发器              | 一致（triggers 0）                  |
| 文件哨兵 SHA-256                | 不变 `4e59a94d…e409`                |
| 表结构                          | 一致（仅 mysqldump 末尾时间戳不同） |
| 目标库活动连接                  | 0                                   |
| 本轮夹具残留                    | 0（测试未进入实库写入阶段）         |

- KEEP 核验通过后，按 `keep-ledger.json` 六条显式 ID＋业务键守卫删除，`PRE=1/1/1/1/1/1`、`POST=0/0/0/0/0/0`；最终全库仅 `migrations` 39 行，业务表全 0；`AUTO_INCREMENT` 与插入前一致（账号 9905032、资料 990352、机型 9905019、组织 9907275、成员 990097、工单 9905015），仅记录未重置。
- 未 DROP 数据库、未清库、未递归删除证据目录；Redis 与运行目录保留。

### 25.8 结论与未覆盖项

- 本轮结论仅针对当前未提交候选：**标准完整 core 未通过**，不得据此认为可合并。
- 未覆盖：第 2—51 个 core 规格全部未执行；本轮未运行实库专项规格；未取得完整 skip 列表与逐规格 passed/failed。
- 失败历史保留：第二十轮 R 专项 5 passed/7 failed、第二十二轮 r2 15 passed/1 failed、第二十四轮 R3 19/19。
- 后续仍需：修复该实体注册缺口后重新冻结候选、重跑非写库门禁与完整 core；最终独立审查、提交审计、提交后 CI、独立部署验收均未完成。

## 第二十六轮：V13 实体元数据注册缺口最小修复（2026-11-09，离线）

| 项   | 值                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| 分支 | `feat/database-v13-deploy`（未切换）                                                                                         |
| HEAD | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未 commit）                                                                      |
| 边界 | 未运行实库、未运行完整 core；未改 Migration/约束/数据；未删外键；未新增或启用 AI 能力；未改 runner/断言/skip；未 commit/push |
| 结论 | **缺口已离线修复并通过不连库装配回归**；完整 core 需独立授权后重跑                                                           |

### 26.1 实际缺失路径与原始错误

- 完整错误：`TypeORMError: Entity metadata for IntakeAnalysisAttemptEntity was not found. Check if you specified a correct entity object and if it's connected in the connection options.`
- 栈路径：`EntityMetadataBuilder.createForeignKeys` → `EntityMetadataBuilder.build` → `ConnectionMetadataBuilder.buildEntityMetadatas` → `DataSource.buildMetadatas`。
- 拥有者实体已注册：`IntakeAnalysisAttemptEntity` 在 `lithography.module.ts` 的 `LITHOGRAPHY_ENTITIES` 内；报错名是拥有者，不是缺失目标。
- 真正缺失的是字符串外键目标：`@ForeignKey('AiProviderCallRecordEntity', ...)` 引用的 `AiProviderCallRecordEntity` 仅由 `ai-provider-call-record.module.ts` 注册，该模块只进入 Worker 依赖图，未进入 `ApiModule`。
- 修复前用新增离线回归复现同一错误，确认结论不依赖报告摘要。

### 26.2 最小修复与运行行为

- 仅改 `backend/src/bootstraps/api/api.module.ts`：引入 `AiProviderCallRecordEntity` 并加入 `TypeOrmModule.forFeature([AiProviderCallRecordEntity])`。
- 未导入 `AiProviderCallRecordModule` / `AiProviderCallRecordService`；不启动额外队列、Worker 或定时任务；不改变 Capability 模式或运行范围；不新增跨域业务调用。
- 该注册只向 API 数据源补充纯 ORM 元数据及根模块内 Repository provider（不导出、无消费者）；除修复 TypeORM 装配外不产生额外运行行为。Worker 图未改动。

### 26.3 同类实体闭包检查

- 本次 17 张新增 Entity 全部在 `LITHOGRAPHY_ENTITIES`；其字符串外键目标（`AccountEntity`、`OrganizationEntity`、`RepairRequestEntity`、`EquipmentModelEntity`、`StoredFileEntity` 等）均在 API 闭包内。
- 唯一缺失目标为 `AiProviderCallRecordEntity`；修复后 API 闭包覆盖 17 张新增实体与该目标。
- Worker 闭包为 `AiProviderCallRecordEntity`、`AsyncTaskRecordEntity`、`AiWorkflowContextEntity`，三者无跨闭包外键；Worker 无同类缺口，未扩大改动范围。

### 26.4 不连库装配回归

- 新增 `src/bootstraps/api/api-entity-metadata.spec.ts` 与 `src/bootstraps/worker/worker-entity-metadata.spec.ts`。
- 实体输入取自真实注册来源 `EntitiesMetadataStorage.getEntitiesByDataSource('default')`（即 Nest TypeORM `autoLoadEntities` 的同一来源），测试内不手动补实体；仅执行 `DataSource.buildMetadatas()`，不连接数据库、不启动 Nest、不启用队列。
- 断言：API 闭包含 17 张新增实体；逐个新增实体的外键目标可在 `entityMetadatas` 中解析；`IntakeAnalysisAttemptEntity` 同时解析 `RepairRequestIntakeEntity` 与 `AiProviderCallRecordEntity`。
- 修复前 API 回归失败于同一 `TypeORMError`，修复后通过；Worker 回归通过。
- 证据边界：离线回归只证明实体闭包与元数据装配，不等价于 Nest DI 或应用启动；完整启动仍以 core 结果为准。

### 26.5 验证与指纹

| 检查                               | 结果                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run typecheck`（build+tools） | 退出码 0                                                                                      |
| `tsc -p tsconfig.spec.json`        | 退出码 0                                                                                      |
| 新增装配回归                       | API 1 passed；Worker 1 passed（修复前 API 为 1 failed）                                       |
| 变更文件 ESLint（无 `--fix`）      | 退出码 0                                                                                      |
| 变更文件 Prettier `--check`        | 退出码 0                                                                                      |
| 架构/能力门禁 4 项                 | usecase-normalize / architecture-fixtures / capability-docs / entity-scope 均 0               |
| `npm run build`                    | 退出码 0                                                                                      |
| `git diff --check`                 | 退出码 0                                                                                      |
| 39 条迁移逐文件 SHA-256            | 39/39 与冻结清单一致；聚合 `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f` |

- 相对上一轮冻结清单：tracked 文件仅 `backend/src/bootstraps/api/api.module.ts` 变化；untracked 新增上述 2 个 spec；Migration 逐文件指纹与聚合均不变。
- 完整 core 重跑条件：以当前工作区重新冻结候选（tracked/untracked 清单与聚合、39 迁移指纹、stash 3 项、暂存区空），重新执行非写库门禁，并在独立授权下使用独占 Redis 与 `lithography_e2e` KEEP 模式重跑 `npm run test:e2e:core`；第 2—51 个规格仍未执行。
- 历史保留：本轮 core `1/51`、`6 failed` 与第二十/二十二/二十四轮失败记录均不变。

## 第二十七轮：修复后 KEEP 模式标准完整 core 复验（2026-11-09，失败，26/51）

| 项   | 值                                                                                     |
| ---- | -------------------------------------------------------------------------------------- |
| 分支 | `feat/database-v13-deploy`（未切换）                                                   |
| HEAD | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未 commit）                                |
| 候选 | tracked 1461 文件 `fb441989…0c3`；untracked 57 文件 `40c83d1e…b6e3`；stash 3；暂存区空 |
| 结论 | **首个失败规格为 test/07 pagination；停止后续验收；不视为允许合并**                    |

### 27.1 冻结与前置

- 运行前重新冻结：tracked/untracked 清单与聚合、`git status` 73 项、stash 3 项、暂存区 0；运行后逐文件 diff 均为 0，源码全程冻结。
- 39 条迁移逐文件 SHA-256 与冻结清单一致，聚合 `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`。
- 门禁实测（本轮工作区）：API/Worker 装配回归 2 suites passed；`npm run typecheck`、spec typecheck、变更文件 ESLint（无 `--fix`）/Prettier、usecase-normalize / architecture-fixtures / capability-docs / entity-scope、`npm run build`、`git diff --check` 均退出码 0。
- `migration:status` 显示 39 applied / 0 pending；`migration:verify` 通过；库 `lithography_e2e`（server_uuid 匹配）业务表全 0、仅 migrations 39 行，与上轮收尾一致。

### 27.2 独占配置与 Redis

- `E2E_DOTENV=/home/gandiantx/secure/lithography-v13/configs/lithography-e2e-core.env`（basename 非 `.env.e2e`）；全局 setup 日志确认 `needs=mysql`、目标库白名单 `lithography_e2e` 校验通过、`skipDbCleanup=true`、`allowDbCleanup=false`。
- 显式保持 `E2E_SKIP_DB_CLEANUP=true`、`E2E_ALLOW_DB_CLEANUP=0`、`E2E_ALLOW_PHYSICAL_CLEANUP=1`、`E2E_ALLOWED_DB_NAMES=lithography_e2e`；teardown 日志确认跳过 Redis FLUSHDB。
- 本轮 Redis：`run_id=redis16379-20261109T110021-ospUJcLZ`、`pid=2069710`、`port=16379`、目录 `.../redis-16379-ospUJcLZ`（0700/0600，bind 127.0.0.1）；运行前 16379 空闲。
- 收尾：关闭前在线核对 `dir/port/bind` 与 PID 命令行全部匹配后执行 `SHUTDOWN NOSAVE`；16379 已释放、PID 消失；共享 6379（PID 42262）全程未操作。

### 27.3 KEEP 与运行前快照

- 在 `lithography_e2e` 预置合成 KEEP（独立账本 `keep-ledger-r2.json`，未加入任何规格清理账本）：`organization`、`base_user_account`、`base_user_info`、`organization_membership`、`equipment_model`、`repair_request`，ID 均为 900000001，业务键后缀 `_R2`。
- 保存运行前快照：全表行数/`CHECKSUM TABLE`、全量结构与数据 dump、KEEP 全字段与引用、文件哨兵 SHA-256、39 迁移行与逐文件 SHA-256、触发器集合、AUTO_INCREMENT、连接/事务计数。

### 27.4 运行结果

- 标准入口 `npm run test:e2e:core` 从头运行，原始日志与退出码保存：**exit code 1**。
- 按实际收集：**启动 26 个规格（计划 51），25 suites passed / 1 failed；391 passed / 9 failed / 0 skipped**；首规格 `test/00-app/00-app.e2e-spec.ts` 通过（6 passed），修复后的 API 应用启动已恢复。
- 第 26 个规格 `test/07-pagination-sort-search/pagination.e2e-spec.ts` 失败：
  - 错误：`TypeORMError: Entity metadata for UserInfoEntity was not found...`，栈 `EntityMetadataBuilder.createForeignKeys → DataSource.buildMetadatas → DataSource.initialize`。
  - 真实缺失目标：`UserInfoEntity` 为拥有者，V13 新增 `@ForeignKey('OrganizationEntity', ['customerOrganizationId'], ['id'], { name: 'fk_base_user_info_customer_organization' })`；该 spec 自建 `TestingModule` 仅 `forFeature([AccountEntity, UserInfoEntity, VerificationRecordEntity])`，未加载 `OrganizationEntity`。
  - 归属：测试本地装配缺口（非产品 API/Worker 闭包缺失）；按本轮“失败即停止、不顺带扩大修复”边界，未修改该 spec、runner、断言或 skip。

### 27.5 运行后只读对照与收尾

- KEEP 六行全字段与引用不变；文件哨兵 SHA-256 不变。
- 逐表行数、`CHECKSUM TABLE`、39 迁移行、触发器集合、全量数据 dump 与运行前完全一致；结构 dump 仅 `AUTO_INCREMENT` 数值被归一化，归一化后一致。
- 正常测试夹具零残留（失败规格在 `app.init()` 阶段即中止，未进入 seed；`afterAll` 的 `getRepository` 报错为下游结果）；活动连接 0、活动事务 0。
- 按账本六条显式 ID＋业务键回收 KEEP：删除后六表 0 行，全库恢复为仅 `migrations` 39 行；`AUTO_INCREMENT` 仅记录未重置（与 KEEP 前一致）。
- 证据保留：`/home/gandiantx/secure/lithography-v13/evidence/s4/20261109-core-r2`（0700/0600，原始日志、退出码、冻结/门禁/KEEP/收尾/Redis 记录）。

### 27.6 未覆盖与下一步

- 未执行第 27—51 共 25 个规格；未重跑失败规格；未清库、未 DROP、未扩大修复。
- 文档收尾：两份计划文档 Prettier check 0、`git diff --check` 0；文档更新后 untracked 清单逐文件对比仅本轮两份 plans 文档变化，tracked 逐文件差异 0（源码候选未变）。
- 下一步需独立授权：先以最小方式补齐该测试本地 `DataSource` 实体闭包（加载 `OrganizationEntity` 或等价受保护入口），再另起一轮从头冻结并重跑完整 core。
- 通过完整 core 仍不等于允许合并：后续仍需最终独立审查、提交审计、提交后 CI 与独立部署验收。

## 第二十八轮：旧测试本地实体闭包最小适配（2026-11-09，离线，不写库）

| 项   | 值                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分支 | `feat/database-v13-deploy`（未切换）                                                                                                                                                                     |
| HEAD | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未 commit）                                                                                                                                                  |
| 候选 | tracked 1461 文件 `dffa5d7423c17c3e4fff0f966eddcfc0922b39ca6aa811747385ff3d2c334af8`；untracked 59 文件 `f5e28f4c0b169b63c1a614ed1e826cd748b659c869f911c8a8c35a5ece7391f1`；stash 3；暂存区空；status 79 |
| 结论 | **仅适配受 V13 新增外键影响的测试本地装配；未运行实库/core/Redis，未 commit、未 push**                                                                                                                   |

### 28.1 失败链确认

- 第 27 轮失败日志：`EntityMetadataBuilder.createForeignKeys → DataSource.buildMetadatas → DataSource.initialize`，报 `Entity metadata for UserInfoEntity was not found`。
- 拥有者为 `UserInfoEntity`（V13 新增 `@ForeignKey('OrganizationEntity', ['customerOrganizationId'], ['id'], { name: 'fk_base_user_info_customer_organization' })`），真正缺失目标为 `OrganizationEntity`。
- 分页规格自建 `TestingModule`，实际 `forFeature([AccountEntity, UserInfoEntity, VerificationRecordEntity])`，未登记 `OrganizationEntity`。`OrganizationEntity` 自身无外键，闭包到此终止。

### 28.2 直接消费者扫描（backend/src、backend/test）

| 文件                                                                                                                                                | 本地实体集合                                                                     | 缺失目标                        | 是否需修改 | 排除依据                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------- | ---------- | ---------------------------------------------------------------------- |
| `test/07-pagination-sort-search/pagination.e2e-spec.ts`                                                                                             | Account、UserInfo、VerificationRecord                                            | Organization                    | 是         | 第 27 轮实际失败规格                                                   |
| `test/07-pagination-sort-search/search.e2e-spec.ts`                                                                                                 | 同上                                                                             | Organization                    | 是         | 同一装配模式，未运行即会被同一外键阻断                                 |
| `test/07-pagination-sort-search/sort.e2e-spec.ts`                                                                                                   | Account、UserInfo                                                                | Organization                    | 是         | 同一装配模式，仅缺组织实体                                             |
| `src/modules/lithography/queries/repair-request.organization.integration.spec.ts`                                                                   | RepairRequest、EngineerResponse、EquipmentModel、Organization、Account、UserInfo | RepairRequestIntake、StoredFile | 是         | V13 新增 `repair_request → repair_request_intake → stored_file` 外键链 |
| `src/modules/lithography/queries/content-submission.query.service.spec.ts`                                                                          | ContentSubmission、Organization、Account、UserInfo                               | 无                              | 否         | 闭包完整（文件内注释已说明），元数据只构建不连库                       |
| `v13-db-verification.spec.ts`、`e2e-scoped-cleanup.v13.realdb.spec.ts`                                                                              | `ACCOUNT_WRITE_FIXTURE_ENTITIES`（Account、UserInfo、Organization）              | 无                              | 否         | 共享集合已含 Organization                                              |
| `maintenance-report*.integration.spec.ts`、`local-runtime.concurrency.integration.spec.ts`、`admin-set-user-status.concurrency.integration.spec.ts` | `../../modules/**/*.entity.ts` 全量                                              | 无                              | 否         | 全量实体 glob                                                          |
| `test/utils/unique-index-constraints.e2e-spec.ts`、`global-setup-e2e.ts`、`migration-schema-contract.spec.ts`                                       | `src/**` 或 `modules/**` 实体 glob                                               | 无                              | 否         | 全量实体 glob                                                          |
| `test/utils/e2e-db-target-consistency.e2e-spec.ts`                                                                                                  | 继承主 DataSource options                                                        | 无                              | 否         | 无独立实体清单                                                         |
| `test/utils/e2e-owned-fixture.e2e-spec.ts`                                                                                                          | 无 `entities`                                                                    | 不适用                          | 否         | 纯 SQL，不构建实体元数据                                               |
| `incremental-migration.integration.spec.ts`、`record-package-state.migration.realdb.spec.ts`、`verify-empty-db-migrations.ts`                       | 仅 migrations                                                                    | 不适用                          | 否         | 不涉及实体元数据                                                       |
| `scripts/seed-mock.ts`                                                                                                                              | `entities: []`                                                                   | 不适用                          | 否         | 不在 src/test 扫描范围；脚本走原生 SQL                                 |
| `src/bootstraps/api/api.module.ts`、`src/modules/**/*.module.ts`                                                                                    | 产品模块闭包                                                                     | 无                              | 否         | 已由 API/Worker 装配回归覆盖，本轮不改产品模块                         |

### 28.3 最小修改

- 新增 `test/utils/local-entity-sets.ts`：集中登记两份规格实际使用的实体集合，避免多套修补列表。
  - `ACCOUNT_QUERY_FIXTURE_ENTITIES = [...ACCOUNT_WRITE_FIXTURE_ENTITIES, VerificationRecordEntity]`（复用既有账号写入闭包，含 Organization）。
  - `REPAIR_REQUEST_ORG_READ_FIXTURE_ENTITIES` 在原 6 实体上补 `RepairRequestIntakeEntity`、`StoredFileEntity`。
- `pagination.e2e-spec.ts`、`search.e2e-spec.ts`：`forFeature([...ACCOUNT_QUERY_FIXTURE_ENTITIES])`；`sort.e2e-spec.ts`：`forFeature([...ACCOUNT_WRITE_FIXTURE_ENTITIES])`；移除不再使用的 `UserInfoEntity` 直接导入。
- `repair-request.organization.integration.spec.ts`：`entities: [...REPAIR_REQUEST_ORG_READ_FIXTURE_ENTITIES]`，移除仅用于清单的 Account/UserInfo/Organization 导入。
- 未改产品 API/Worker 模块、Entity、Migration、权限、业务断言、runner 或 skip。
- 精确 diff：4 个已跟踪文件 `+60/−25`；2 个新增文件（实体集合与离线回归）。

### 28.4 afterAll 生命周期保护

- 分页与搜索规格新增 `appInitialized` 标志：只有 `app.init()` 成功后才执行清理，避免初始化失败后继续 `getRepository` 掩盖原始错误。
- 清理与应用关闭分别捕获错误：单个错误原样抛出，两个错误以 `AggregateError` 同时保留；未吞错、未把失败伪装成通过。
- 排序规格原有 `isInitialized` 保护保持不变。

### 28.5 离线回归

- 新增 `src/infrastructure/database/local-entity-sets-metadata.spec.ts`：输入直接 import 规格使用的同一常量，不在回归内手动补实体。
- 仅调用 `buildMetadatas()`，不 `initialize()`、不连接数据库、不启动 Nest；断言所有外键目标在集合内可解析，并显式验证 `base_user_info → organization`、`repair_request → repair_request_intake → stored_file`。
- 该回归不代替真实 Nest 启动与业务测试。

### 28.6 验证结果

- `npm run typecheck` 0；`npx tsc -p tsconfig.spec.json --noEmit` 0。
- 定向单测：`local-entity-sets-metadata`、`api-entity-metadata`、`worker-entity-metadata`、`content-submission.query.service` 共 4 suites / 14 tests passed。
- 变更文件 ESLint（无 `--fix`）0、Prettier check 0、`git diff --check` 0。
- 架构门禁：usecase-normalize-guard、architecture-fixtures、capability-docs、entity-scope 均 0。
- 39 条迁移逐文件 SHA-256 与冻结清单逐行一致，聚合仍为 `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`。
- 本轮未连接数据库、未操作 Redis、未运行实库规格或完整 core；保留第 27 轮 `26/51`、`391 passed / 9 failed` 历史。

### 28.7 未覆盖与下一步

- 未定向复跑分页/搜索/排序规格，未运行完整 core；离线回归通过不等于实库通过。
- 下一步需独立授权：先定向复验受影响的 `07` 规格，再从头运行 KEEP 模式完整 core；分段结果不得拼接为“完整通过”。
- 完整 core 通过后仍需最终独立审查、提交审计、提交后 CI 与独立部署验收；不 commit、不 push。

## 第二十九轮：实体闭包修复后的定向实库与 KEEP 完整 core 复验（2026-11-09，core 失败，29/51）

| 项   | 值                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分支 | `feat/database-v13-deploy`（未切换）                                                                                                                                                                     |
| HEAD | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未 commit）                                                                                                                                                  |
| 候选 | tracked 1461 文件 `dffa5d7423c17c3e4fff0f966eddcfc0922b39ca6aa811747385ff3d2c334af8`；untracked 59 文件 `77a41aabb97aa8d49c6c5374a50a82c71edf05ddcfe8fbb18a584adf4db22725`；stash 3；暂存区空；status 79 |
| 结论 | **4 个定向规格全部通过；完整 core 在第 29 个规格失败后停止；未 commit、未 push**                                                                                                                         |

### 29.1 冻结与安全核对

- MySQL 目标实测 `server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`，`lithography_e2e` 52 张业务表（含 `migrations`）。
- `migrations` 39 applied / 0 pending；`migration:verify` 通过；业务表除 `migrations` 39 行外全为 0。
- 39 条迁移逐文件 SHA-256 与冻结清单一致；运行前无其他任务连接、无活动事务、无未登记残留。
- 预检链接核对：仓库中不存在 `S4-pre-execution-preecheck.md`，现有链接均指向 `S4-pre-execution-precheck.md`，无笔误需修，未创建重复文件。

### 29.2 独占环境与配置生效

- 16379 空闲后启动本轮独占 Redis：`pid=2078630`、`server_run_id=515797253a810c9aa42f9c056e678e241cd30bca`、`port=16379`、目录 `/tmp/s4-core-20261109-r3/redis/redis-16379-114136-2078616`（0700/0600，bind 127.0.0.1）。
- 库外 0600 配置 `lithography-e2e-core-r3.env`：MySQL 指向 `lithography_e2e`、Redis 指向 16379，显式 `E2E_SKIP_DB_CLEANUP=true`、`E2E_ALLOW_DB_CLEANUP=0`、`E2E_ALLOW_PHYSICAL_CLEANUP=1`、`E2E_ALLOWED_DB_NAMES=lithography_e2e`。
- 每个 e2e 运行日志均显示 `已跳过 MySQL 清理` 与目标库白名单校验；配置 basename 非 `.env.e2e`，teardown 不执行 FLUSHDB；全程未 TRUNCATE、未全库删除、未操作共享 6379（PID 42262 全程不变）。

### 29.3 KEEP 与定向复验

- KEEP R3：`organization`、`base_user_account`、`base_user_info`、`organization_membership`、`equipment_model`、`repair_request` 六行，ID 均 900000002、业务键后缀 `_R3`，登记于独立账本 `keep-ledger-r3.json`，未加入任何规格清理账本。
- 定向结果（均真实初始化并执行用例体，非全 skip）：

| 规格                                                                              | 命令                                                                                        | passed | failed | skipped | 退出码 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ | ------ | ------- | ------ |
| `test/07-pagination-sort-search/pagination.e2e-spec.ts`                           | `npm run test:e2e:file -- <spec>`                                                           | 9      | 0      | 0       | 0      |
| `test/07-pagination-sort-search/search.e2e-spec.ts`                               | `npm run test:e2e:file -- <spec>`                                                           | 16     | 0      | 0       | 0      |
| `test/07-pagination-sort-search/sort.e2e-spec.ts`                                 | `npm run test:e2e:file -- <spec>`                                                           | 3      | 0      | 0       | 0      |
| `src/modules/lithography/queries/repair-request.organization.integration.spec.ts` | `REPAIR_REQUEST_ORG_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 npx jest <spec> --runInBand` | 9      | 0      | 0       | 0      |

- 每项运行后逐表 `COUNT(*)`、`CHECKSUM TABLE` 与 KEEP 前后快照完全一致；`PAG_`/`SE_`/`LS_CASE_`/`SORT_CASE_`/`S5IT_` 夹具残留均为 0；活动事务 0。

### 29.4 完整 core

- 命令：`npm run test:e2e:core`（标准入口，从头运行，无 skip/retry/拼接），真实退出码 **1**。
- 实际启动 29/51 个规格：28 suites passed / 1 failed；**419 passed / 37 failed / 0 skipped**。
- 首个失败规格：`test/09-reference-document/reference-document.e2e-spec.ts`，37 个用例全部失败，报 `QueryFailedError: Field 'publication_status' doesn't have a default value`。
- 只读定位：迁移 `1775501100000` 新增 `publication_status varchar(16) DEFAULT NULL`，回填后 `MODIFY ... NOT NULL` 且未保留默认值；实体列无默认值；该规格夹具插入时未提供该字段。属 V13 结构收紧与旧测试夹具的适配缺口。
- 失败后立即停止，未运行第 30—51 个规格，未清库重跑、未修改代码、未扩大修复。
- 未覆盖：第 30—51 共 22 个规格；历史 `26/51`、`391 passed / 9 failed` 保留不变。

### 29.5 运行后对照与收尾

- KEEP 六行字段与引用不变；非目标数据逐表行数/`CHECKSUM TABLE` 与运行前一致；全量结构/数据 dump 归一化 `AUTO_INCREMENT` 后差异 0。
- 39 条迁移行、触发器集合、文件哨兵 SHA-256 不变；测试夹具零残留；活动事务 0、`lithography_e2e` 连接 0。
- 按独立账本精确回收六行 KEEP：六表恢复 0，全库仅 `migrations` 39 行；逐表计数/校验和与 KEEP 前基线一致；`AUTO_INCREMENT` 仅记录未重置（与 core 前一致）。
- Redis 身份（PID/目录/端口/bind/真实 run_id/命令行）全部匹配后 `SHUTDOWN NOSAVE`，端口释放、PID 消失；共享 6379 未操作。
- 运行前后 tracked/untracked 逐文件 diff 0，源码运行期间未修改。
- 证据归档：`/home/gandiantx/secure/lithography-v13/evidence/s4/20261109-core-r3`（0700/0600）；工作现场 `/tmp/s4-core-20261109-r3` 保留。

### 29.6 下一步

- 需独立授权：以最小方式适配 `09-reference-document` 夹具对 `publication_status` 的必填约束（或经批准的等价结构/实体处理），再从头冻结并复跑完整 core；不得拼接定向结果。
- 完整 core 通过后仍需最终独立审查、提交审计、提交后 CI 与独立部署验收；本轮结论仅针对未提交工作区，不等于允许合并。

## 第三十轮：三字段最小适配与 KEEP 完整 core 复验（2026-11-09，core 通过 51/51）

| 项   | 值                                                                                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分支 | `feat/database-v13-deploy`（未切换）                                                                                                                                                                                                                                                               |
| HEAD | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未 commit）                                                                                                                                                                                                                                            |
| 候选 | tracked 1461 文件聚合 `47a024b3acd280ebe02559be2be3fd99428120801e054349a71cab881f37f864`；untracked 61 文件聚合 `a1a67b2c78253a1450e032b75b5e2e377bdccb250f7d3b57ac5e153ffec05cce`；39 条迁移聚合 `47ff4128a723a412134ca3832bcc005288540767c737da8d1895cb36eefcba5b`；stash 3；暂存区空；status 87 |
| 结论 | **定向规格全部通过；完整 core 51/51 规格、765 passed / 0 failed / 7 skipped，真实退出码 0；KEEP 精确回收；未 commit、未 push**                                                                                                                                                                     |

### 30.1 P0 旧入口取舍（已确认）

- 采纳“保留旧管理员直建/审核发布入口的最小数据库兼容”：不改发布流程，不伪造 `INDEPENDENT_REPORT`/`WORK_ORDER_SUMMARY`。
- 无报告来源的新建资料如实写 `source_kind='MATERIAL'`；该差异列为后续业务改造项，**不是最终设计已实现**。
- 未删除、未停用旧入口；本轮无生产入口流程改动。

### 30.2 P1 三字段核对与最小修复

- 生产写入入口 `reference-document.service.ts`：新建落 `publication_status='ONLINE'`、`ownership_status='CONFIRMED'`、`source_kind='MATERIAL'`，与“新行必为在用且归属为必填组织、来自管理员直建/审核发布”一致。
- 软删路径补最小修复：`softDeleteDocument` 同一条件更新内落 `publication_status='OFFLINE'`，与迁移回填口径（`deleted_at` 非空即非 ONLINE）一致；未改 Entity、未加迁移、未改默认值。
- 共用夹具生成器 `test/utils/reference-document-fixture-state.ts`：`deprecated=1` 或 `deleted_at` 非空 → OFFLINE；`owner_organization_id` 为空 → PENDING；09 规格与两份清理规格全部经该生成器写入。
- Seed：业务基础 6 行显式声明三字段（软删行 970_004 为 OFFLINE），沿用既有“Mock 行确定性重置”契约；`content_submissions` 发布行仍为 `['id']` no-op upsert，不会重新上架或覆盖归属/来源。
- 权限、字段白名单、来源关联、精确清理规则未变；`ownerOrganizationId` 可空仅导致读取侧展示“未知组织”，跨组织校验仍失败关闭。
- 门禁：`npm run typecheck` 通过；文件级 ESLint、Prettier、`git diff --check` 通过；相关单测（service/fixture-state/usecases/seed 契约）通过。

### 30.3 P2 环境与 KEEP

- MySQL `server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`；`lithography_e2e` 52 表、`migrations` 39 applied、其余表 0 行；无其他任务连接、无活动事务、无触发器、无 probe 残留。
- 本轮独占 Redis：`port=16380`、`pid=2090484`（Redis 7.0.15，启动与就绪日志见 `redis/redis.log`），目录 `/tmp/s4-core-20261109-r4/redis`（0700/0600，bind 127.0.0.1，无持久化）；共享 6379 全程未操作。
- 库外 0600 配置 `lithography-e2e-core-r4.env`（由 r3 复制，仅改 Redis 端口）。
- **执行方式修正**：完整 core 与每个定向进程均以 `set -a; . <r4.env>` 注入专用配置并显式导出四个 `E2E_*` 变量，**不传 `E2E_DOTENV`**。原因见 30.4 第 2 条；四项约束值本身逐进程显式生效。
- KEEP R4：`organization`/`base_user_account`/`base_user_info`/`organization_membership`/`equipment_model`/`repair_request`/`reference_document` 七行，ID 均 900000003、业务键后缀 `_R4`，登记于独立账本 `keep-ledger-r4.json`，未加入任何规格清理账本。
- 基线：数据/结构 dump、逐表 `COUNT(*)` 与 `CHECKSUM TABLE`、迁移行与逐文件 SHA-256、触发器集合、存储目录文件哈希、文件哨兵。

### 30.4 P3 定向复验

| 规格                                                                    | passed | failed | skipped | 退出码 |
| ----------------------------------------------------------------------- | ------ | ------ | ------- | ------ |
| `test/09-reference-document/reference-document.e2e-spec.ts`             | 37     | 0      | 0       | 0      |
| `test/utils/e2e-scoped-cleanup.e2e-spec.ts`                             | 42     | 0      | 0       | 0      |
| `test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts`                   | 22     | 0      | 0       | 0      |
| `test/10-admin-document-database/*`（5 个规格）                         | 114    | 0      | 0       | 0      |
| `test/11-content-submission/content-submission-integration.e2e-spec.ts` | 21     | 0      | 0       | 0      |
| `test/11-content-submission/content-submission-graphql.e2e-spec.ts`     | 5      | 0      | 0       | 0      |
| `test/12-reference-document-case/reference-document-case.e2e-spec.ts`   | 5      | 0      | 0       | 0      |

- 每项通过后逐表 `COUNT(*)` 与 `CHECKSUM TABLE` 与 KEEP 基线完全一致、夹具残留 0、存储目录 0 文件。
- 失败历史（原始日志保留）：
  1. C09 机型闭包期望 5/实际 6：实现新增 `repair_request_intake` 闭包查询、断言未同步（同提交 72de109）。经用户确认后修正为 6 并补表名。
  2. 完整 core 第 1 次：`e2e-probe-lifecycle` H02 期望子进程失败却成功。根因是 `E2E_DOTENV` 在子进程 global-setup 中重新注入被删除的 `E2E_ALLOW_PHYSICAL_CLEANUP=1`。改为 source 配置注入后定向 9/9 通过。
  3. 完整 core 第 2 次：`unique-index-constraints` 仍断言 V13 前索引 `uk_local_backup_run_active`。V13 已改为 `uk_local_backup_run_active_company(active_installation_id, organization_id)`，Entity/迁移契约一致；更新期望并在场景 C 补 `organization_id`（同安装同公司重复 RUNNING 拒绝）。定向 3/3 通过。

### 30.5 完整 core（冻结候选后从头运行）

- 命令：`npm run test:e2e:core`（标准入口，从头运行，无 skip/retry/拼接），真实退出码 **0**。
- 结果：**51/51 规格通过；765 passed / 0 failed / 7 skipped**。
- 7 个 skipped 均来自 `test/utils/e2e-pr0-acceptance.e2e-spec.ts`：需 `E2E_PR0_ACCEPTANCE_CONFIG` 的受控真实例验收用例，非 core 范围。
- 运行期间无源码修改；候选逐文件哈希与冻结时一致。

### 30.6 运行后对照

- KEEP 七行字段、引用、`CHECKSUM TABLE` 全部不变；非目标数据逐表计数/校验和与运行前一致；数据 dump 无差异。
- 结构 dump 归一化 `AUTO_INCREMENT` 后差异 0（仅自增计数因回滚用例推进，属预期）；39 条迁移行、迁移文件 SHA-256、触发器集合、存储目录文件哈希与哨兵均不变。
- 无 probe 库残留；`lithography_e2e` 连接 0、活动事务 0。

### 30.7 收尾

- 按独立账本以精确 ID + 业务键、FK 逆序回收七行 KEEP；回收后全库仅 `migrations` 39 行，KEEP 计数 0。
- 独占用 Redis 校验身份后 `SHUTDOWN NOSAVE`，16380 端口释放、进程消失；共享 6379 未操作。
- 证据归档：`/home/gandiantx/secure/lithography-v13/evidence/s4/20261109-core-r4`（0700/0600，3.5MB）；工作现场 `/tmp/s4-core-20261109-r4` 保留。
- **本轮不 commit、不 push、不合并。**

### 30.8 遗留与下一步

- “旧 `MATERIAL` 入口兼容”仍是业务设计差异：后续需独立业务改造（独立报告/工单总结发布流）后再收敛来源语义。
- 2 个测试文件修正（C09 闭包期望、unique-index 期望与场景 C 造数）与 core 验证的注入方式调整随工作区保留，需在最终独立审查中复核是否应独立成提交。
- 下一步：最终独立审查、提交审计、提交后 CI 与独立部署验收；本轮结论仅针对未提交工作区，不等于允许合并。

## 第三十一轮：合并前阻塞审计（P0/F1）与 P1—P5 方案

| 项         | 值                                                                 |
| ---------- | ------------------------------------------------------------------ |
| 执行日期   | 2026-11-09（Asia/Shanghai）                                        |
| 执行范围   | 仅 P0：只读审计 F1，并形成 P1—P5 精确改动方案；**未实施 P1—P5**    |
| 分支/HEAD  | `feat/database-v13-deploy` / `72de1096`（未提交）                  |
| 工作区     | 87 项变更保留；暂存区空；3 个 stash 保留                           |
| 数据库     | 未连接：无查询、无写入、无迁移                                     |
| Git 写操作 | 无 commit/push/PR；未动 stash                                      |
| 本轮产出   | `S5-pre-merge-blocker-audit-20261109.md`；S1 字典 7 处 P0 修正注记 |

### 31.1 执行步骤与证据

| #   | 动作                                                                          | 结果                                       |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | 复算四份冻结 Word 的 SHA-256                                                  | 与 S0 第 1.1 节一致，未换版本              |
| 2   | 复算 39 个迁移文件逐条 SHA-256 并与 S4 冻结表比对                             | 39/39 一致，差异 0；聚合 `8827ded2…67707f` |
| 3   | 逐项对照冻结 Word、S1 字段字典、Entity、迁移与实际消费者                      | F1 五项全部存在缺口，详见 S5 第 2 节       |
| 4   | 检查 JSON 等价存储四项条件（结构/版本/约束/消费者）                           | 无一处通过；`panel_snapshot` 明确不等价    |
| 5   | 定位 P1—P5 落点（管理员初始化、第 32 条约束、结单 CHECK、清理闭包、结构校验） | 方案与行号见 S5 第 5 节                    |
| 6   | 在 S1 字典 4.5/4.9/4.10/4.11/4.12/4.15/4.16 标题下加 P0 修正注记              | 已写入，未改表内逐行内容                   |

### 31.2 F1 判定摘要

| 编号 | 对象                          | 判定                                                       |
| ---- | ----------------------------- | ---------------------------------------------------------- |
| F1-1 | `local_company_setting`       | 字段缺失（8 列）+ 需裁决（设计外 2 列是否保留）            |
| F1-2 | `local_account_authorization` | 字段缺失（3 列）+ 需裁决（现有状态列语义）                 |
| F1-3 | `sync_receipt`                | 业务语义冲突（唯一键含 `source_system`）+ 字段缺失（3 列） |
| F1-4 | `backup_asset`                | 字段缺失（10 列）+ 约束冲突（保护备份 NOT NULL）           |
| F1-5 | `maintenance_report_fault`    | 语义冲突（`status/source` 同名异义）+ 字段缺失 + 约束缺失  |

### 31.3 本轮检查

- 对新增/修改 Markdown 运行 Prettier check 与 `git diff --check`（未执行全局格式化、未运行 build/lint/单测）。
- 未修改任何迁移、Entity、业务代码或测试。

### 31.4 遗留与下一步

- 第 6 节 Q1—Q10 未裁决前，不冻结结构修复范围、不进入 P1—P5 实施。
- 实库复验（P3 UNKNOWN、P2 旧态样本升级、P1 真实登录链路）需另行授权。
- **本轮回合不 commit、不 push、不合并。**

## 32. 第三十二轮：S5 剩余裁决落实与第 32 条升级挡点验证准备（2026-11-09）

### 32.1 本轮目标与边界

- 落实 Q1、Q2、Q4、Q6、Q7、Q9、Q10 裁决；形成逐表精确结构变更清单；核对第 32 条 A—D 挡点源码证据；编写默认关闭的 31 态升级实库规格。
- 未改产品代码、Entity 或第 1—39 条迁移；未连库、未建库、未迁移、未造数、未启动服务、未操作 Redis；未暂存、未 commit、未 push；工作区修改与 stash 保持。

### 32.2 只读取证

- 第 32 条 `up()` 的 7 个方法共 8 条独立 `queryRunner.query`（`maintenance_report_step` 两条）；MySQL 8 单条 ALTER 原子，跨语句不回滚。
- A：31 态 `ai_helpfulness` 允许 1—5（第 27 条旧 CHECK + 应用层 `AI_RATING_MAX=5`）；第 32 条收紧 1—4，失败在第 5 条 `upgradeMaintenanceReport`，此前 4 表 5 条语句已提交。
- B：31 态无 `closure_reason` 列；`INTERRUPTED/UNREPAIRABLE` 映射与第 31 条预检均合法；第 32 条首条 `upgradeRepairRequest` 即失败，**无第 32 条 DDL 提交**。
- C：31 态审核状态一致性约束是第 32 条新约束的子集（新增 `SUBMITTED` 分支同 PENDING_REVIEW 规则），无合法违规样本，**非挡点**。
- D：31 态旧 CHECK 允许 `ACTIVE + ai_feedback` 非空；但全仓库无 `ai_feedback` 写入者，**DB 合法但无真实历史输入**，只作防御性场景。
- 消费者：`RecordRepairRequestHandlingResultUsecase` 与 `maintenance-report.service.ts` 均不写 `closure_reason`，且无 GraphQL/REST 适配器暴露；`ai_helpfulness` 应用层上限仍为 5。

### 32.3 文档与规格

- `S5-pre-merge-blocker-audit-20261109.md` 新增 §8（裁决落实、逐表结构变更、Q7 取舍、第 32 条证据、实库规格、升级路径、待决问题）。
- `S1-open-issues.md` 新增 §9（Q11—Q15 与已记录偏差）。
- 新增 `backend/src/infrastructure/database/v13-upgrade-from-31-state.realdb.spec.ts`：默认 `describe.skip`；六道安全门；31 态由前 31 条迁移正向构建；只走正式 `runDatabaseDeploy(mode=upgrade)`；失败现场不清理、不回退；证据 JSON 记录真实 ID、失败迁移、已提交 DDL、历史与结构。

### 32.4 本轮检查

- `npx tsc -p tsconfig.spec.json --noEmit`：通过。
- `npm run typecheck`（build + tools）：通过。
- 文件级 ESLint（不带 `--fix`）：通过。
- Prettier `--check`：S5、execution-log、新规格通过；`S1-open-issues.md` 剩余非合规仅为第 1 节历史表格列宽（行 5—20），未全局重排。
- `git diff --check`：通过。
- 第 1—39 条迁移：39 条，聚合 SHA-256 `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`，与 S4 一致；未改任何迁移。
- 未运行实库规格，未运行完整 core 测试。
- 默认关闭行为验证：新规格单独运行结果为 1 suite / 1 test skipped，未连库。

### 32.5 遗留

- Q14（是否批准修改第 32 条）、Q15（Q7 选型与冻结集合）、Q11、Q12、Q13 未决。
- 本轮不运行实库规格；下轮需四个专用库与显式授权文字。
- **本轮回合不 commit、不 push、不合并。**

## 33. 第三十三轮：第 31→32 态升级挡点实库复现（第一轮，2026-11-09）

### 33.1 本轮目标与边界

- 只执行“第一轮”：在隔离空库中运行既有规格，验证 ctrl / A / B 三场景；验证第 32 条挡点是否真实存在。
- 未改产品代码、Entity 或第 1—39 条迁移；未 commit、未 push；工作区修改、未跟踪文件与 3 个 stash 保持。
- 失败现场不清库、不回退 DDL；三库按原样保留。

### 33.2 前置准备

- MySQL `8.0.46-0ubuntu0.24.04.4`，`127.0.0.1:3306`；本机开发账号具备 CREATE/DROP。
- 创建三个空库：`lithography_v13_upg31_ctrl`、`lithography_v13_upg31_a_ai5`、`lithography_v13_upg31_b_closure`（`utf8mb4`，执行前 0 表）。`d_conv` 未创建。
- 生成 `/tmp/v13-upg31-20261109/env/.env.v13-upg31-{ctrl,a_ai5,b_closure}`（0600）与证据目录 `/tmp/v13-upg31-20261109/evidence`。
- 多次 `mysql` 客户端受注入的 `LD_LIBRARY_PATH`（旧 `libstdc++`）影响，统一改用 `env -u LD_LIBRARY_PATH mysql …`。

### 33.3 规格缺陷与修复（仅测试自身）

- 首跑 ctrl 失败于 `TypeError: migrationClass is not a constructor`：`buildBaseline31` 把 `dataSource.migrations`（实例）直接传入新 DataSource。改为取 `instance.constructor`，并给新 DataSource 单独传前 31 条类。
- A 首跑捕获真实阻断后，断言 `failedMigration = repository[31]`、`历史 = 31` 与实测（`repository[32]`、历史 32）差一格；校正为 `BASELINE_COUNT + 1`，并断言历史最后一条为 `repository[31]`。
- 随后将 `Function` 替换为显式 `MigrationConstructor`，消除 `@typescript-eslint/no-unsafe-function-type` 两条错误；纯类型改动，无运行时差异。

### 33.4 执行与结果

| 场景 | 命令要点                                                      | outcome | 失败迁移                                 | 错误原文                                                                | 历史 | 新列 |
| ---- | ------------------------------------------------------------- | ------- | ---------------------------------------- | ----------------------------------------------------------------------- | ---- | ---- |
| ctrl | `--runTestsByPath … --runInBand`，`V13_UPGRADE_SCENARIO=ctrl` | SUCCESS | 无                                       | 无                                                                      | 39   | 5/5  |
| A    | `V13_UPGRADE_SCENARIO=a_ai5`                                  | FAILURE | `AlterRepairAiReportForV131775501100000` | `Check constraint 'chk_maintenance_report_ai_helpfulness' is violated.` | 32   | 4/5  |
| B    | `V13_UPGRADE_SCENARIO=b_closure`                              | FAILURE | `AlterRepairAiReportForV131775501100000` | `Check constraint 'chk_repair_request_closure_reason' is violated.`     | 32   | 0/5  |

- ctrl：执行 8 条 pending，业务表 51 张，5 个探针列全部存在。
- A：第 32 条第 1—4 条语句（5 个 `query`）已提交；`maintenance_report` 单条 ALTER 原子回滚，`supplementary_note` 不存在；`ai_helpfulness=5` 旧行保留。
- B：第 32 条第 1 条语句即失败，第 32 条无 DDL 提交；`INTERRUPTED/IN_PROGRESS` 旧工单保留。
- 两例失败迁移均为 `repository[32]`；历史最后一条为基线后第 1 条增量 `AlterAccountsAndOrganizationsForV131775501000000`，历史共 32 条。
- 证据：`/tmp/v13-upg31-20261109/evidence/{ctrl,a_ai5,b_closure}-*.json`（每个场景含样本落盘快照与终态各一份）。

### 33.5 现场保留

| 库                                | 表数 | 历史 | 样本                                | 探针                           |
| --------------------------------- | ---- | ---- | ----------------------------------- | ------------------------------ |
| `lithography_v13_upg31_ctrl`      | 52   | 39   | 报告/工单/会话各 1                  | 5/5                            |
| `lithography_v13_upg31_a_ai5`     | 35   | 32   | 报告 1（`ai_helpfulness=5`）        | 4/5（缺 `supplementary_note`） |
| `lithography_v13_upg31_b_closure` | 35   | 32   | 工单 1（`INTERRUPTED/IN_PROGRESS`） | 0/5                            |

### 33.6 本轮检查

- `npx tsc -p tsconfig.spec.json --noEmit`：通过。
- 文件级 ESLint（无 `--fix`）：通过。
- Prettier `--check`（规格、S5、execution-log）：通过；`git diff --check`：退出码 0。
- 默认禁用：1 suite / 1 test skipped，未连库。
- 迁移目录无 `M`（仅 8 个既有未跟踪 v13 迁移文件）。

### 33.7 结论与遗留

- A/B 均为真实阻断，属缺陷复现，**不是升级成功**；ctrl 通过只证明无风险样本可走正式入口。
- A 库已处于半迁移，不得作为“已升级证据”；三库均保留，未清理、未回退。
- 未获明确批准前不改第 32 条；第二至第四轮均未执行。
- **本轮回合不 commit、不 push、不合并。**

## 34. 第三十四轮：第 32 条获批修复、追加迁移与回归（2026-11-09，未写库）

### 34.1 授权与边界

- 用户批准的唯一迁移例外：`1775501100000-alter-repair-ai-report-for-v13.migration.ts`。
- 前 31 条与 `1775501000000` 未改动；其余 7 条增量迁移未改动。
- 本轮只改代码、测试、文档：未连接数据库写入、未处理 ctrl/A/B 现场、未补历史、未续跑半迁移、未 commit、未 push。
- 历史身份字段与冻结 ID 集合未确认，相关子项按指令暂停，未放宽新行原因要求。

### 34.2 第 32 条修复（精确 diff 见 S5 §12.2）

| 变更                                    | 内容                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chk_maintenance_report_ai_helpfulness` | `BETWEEN 1 AND 4` → `BETWEEN 1 AND 5`（旧值 5 合法，新输入 1—4 由应用层执行）                                                                       |
| `up()` 首步                             | 新增 `assertLegacyDataCompatible(queryRunner)`，在任何 ALTER 之前完成兼容判定                                                                       |
| 预检范围                                | ① `ai_conversation` ACTIVE 且已有 `ai_feedback`；② `repair_request` 的 `INTERRUPTED/UNREPAIRABLE` 缺 `closure_reason`（列不存在时按全部此类工单计） |
| 失败语义                                | 抛出含计数与主键 ID 的错误（不输出业务正文），迁移历史不前进、库内无半迁移结构                                                                      |
| 指纹                                    | `bb28ca2c…d814f` → `ee5868be…dda2c`；旧字节由反向还原校验，还原后哈希与冻结值一致                                                                   |

应用层：

| 变更                                                             | 位置                                         |
| ---------------------------------------------------------------- | -------------------------------------------- |
| `ai_helpfulness` 新输入 1—4；`ai_score` 仍 1—5                   | `maintenance-report.input.normalize.ts`      |
| 新增 `preservedAiHelpfulness`：仅未显式改写时允许历史 5 原样保留 | 同上                                         |
| 更新草稿时按是否显式提供该字段决定是否传入保留值                 | `update-maintenance-report-draft.usecase.ts` |
| 读取/投影/提交未加范围校验，5 可正常查询与冻结                   | service / mapper / snapshot 未改             |

### 34.3 第 40 条追加修复迁移

- 文件：`1775501800000-restore-maintenance-report-helpfulness-range-for-v13.migration.ts`，SHA-256=`2265008f…889b`。
- 单条 ALTER；约束存在则 DROP+ADD，不存在则只 ADD；不改行、不改列、不碰 `ai_score`；`down` 有意不回退。
- 迁移产物解析器对同名 DROP+ADD 不计为新对象，31 态/新建路径不会被误判“疑似半迁移”（已核对 `loadMigrationArtifacts`）。
- 三条路径终态：新建、31 态升级、已执行旧版第 32 条 → 约束名与 `1 AND 5` 表达式一致。

### 34.4 历史身份子项（暂停，待确认）

- 未修改 `chk_repair_request_closure_reason`，B 场景仍在第 32 条任何 ALTER 之前被预检拦截；这是如实失败，不是升级成功。
- 建议方案（字段 `is_historical`、冻结 ID 集合来源与赋值规则）见 S5 §12.5，待用户确认字段名与集合边界后实现。
- 明确禁止：用 `intake_id IS NULL`、`current_revision_no = 0` 或时间戳猜测作历史证明。

### 34.5 其他旧合法组合

- `ai_conversation` ACTIVE 且已有 `ai_feedback` 在 31 态合法（无写入者），第 32 条仍会拒绝：本轮只做前置预检并如实失败，未放宽，待裁决。
- 其余新增 CHECK/UNIQUE/FK 逐条核对，不拒绝 31 态合法行；未做任何数据改写。

### 34.6 回归与检查

| 项                                                                                | 结果                                                          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 新增单测：新输入 5 拒绝、4/评分 5 通过、历史 5 保留、库内非 5 时 5 仍拒绝         | 通过                                                          |
| 新增迁移规格：DROP+ADD、仅 ADD、失败诊断、down 不回退                             | 通过                                                          |
| 实库规格调整：`a_ai5` 期望成功并保留 5、`b_closure`/`d_conv` 期望预检失败且 0 DDL | 已改，下轮执行                                                |
| `tsc`（src/spec）                                                                 | 通过                                                          |
| 完整单测                                                                          | 141 套件通过、9 套件按门跳过；1664 用例通过、182 跳过、0 失败 |
| ESLint（改动文件，无 `--fix`）                                                    | 0 error（2 条既有 warning）                                   |
| Prettier / `git diff --check`                                                     | 通过 / 退出码 0                                               |

测试期望同步：`MIGRATION_COUNT` 39→40、结构契约 `V13_TIMESTAMPS` 增加 `1775501800000`（仅测试常量与清单，无产品行为变化）。

### 34.7 指纹与版本处置

- 第 32 条：旧 `bb28ca2c…d814f`（历史冻结，保留于 S4 主表）→ 新 `ee5868be…dda2c`。
- 第 40 条：新增 `2265008f…889b`；文件总数 39→40。
- 全量聚合：旧 `8827ded2…707f`（39 行，修订后不可复算，仅存历史）→ 新 `c7d6eb67…10cd`（40 行）。
- 逐文件对比：仅第 32 条变化，其余 38 条与冻结清单完全一致；前 31 条与 `1775501000000` 未变。

### 34.8 下一轮实库需求

5 个目标库与最小授权文字见 S5 §12.8：`lithography_v13_upg32_{ctrl,a_ai5,b_closure,fresh,legacy32}`。`legacy32` 需单独批准以 `bb28ca2c…` 字节快照重放旧语句并按其类名记录历史；未批准不构造。

### 34.9 结论

- 第 32 条的评分挡点已按批准范围修复；已执行旧版的目标由第 40 条收敛。
- 旧中断/无法修复工单与 ACTIVE 带反馈会话仍是如实失败的挡点，等待历史身份/组合裁决。
- **本轮回合不 commit、不 push、不合并。**

## 第三十五轮：S5 41 态稳定候选集中实库验收（2026-11-09）

### 35.1 候选冻结

| 项          | 记录                                                                                   |
| ----------- | -------------------------------------------------------------------------------------- |
| 分支 / HEAD | `feat/database-v13-deploy` / `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`                |
| 工作区      | 保留全部未提交修改与未跟踪文件；暂存区空；stash 3 条未动                               |
| 源码指纹    | `evidence/12-source-sha256-r10.txt`（tracked 修改、untracked、41 条迁移逐文件 + 聚合） |
| 迁移        | 41 条（31 基线 + `1775501000000`—`1775501900000` 10 条）                               |
| 验收矩阵    | F1 结构覆盖、F2 升级兼容、F3 管理员、F4 专用清理、F5 结单约束，均有对应规格            |

离线门禁：`tsc`（src/spec）、ESLint（无 `--fix`）、Prettier、离线单测、build、`git diff --check` 均通过。
实库运行期间发生的两次修改仅为**测试规格缺陷**（见 35.7），修复后重新冻结为 r10，并重跑受影响专项。

### 35.2 阶段1A：全新库

- `lithography_v13_fresh_r2` 首次 init 失败现场保留（32 条历史 + 部分结构），未清库、未重跑。
- 改用同批 `lithography_v13_admin_chain_r2` 完成正式 init：41 条迁移、51 张业务表（52 含历史表）。
- `verify` 通过；重复 init 0 迁移；前后 `CHECKSUM TABLE` 无漂移（证据 33/34）。

### 35.3 阶段1B：31 态升级

| 库                                   | 构造                                             | 结果                                                                                                                  |
| ------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `lithography_v13_upg31_ctrl_r2`      | 31 条正向构建 + 混合合成旧数据（库外 0600 清单） | 正式入口升级成功；历史 41                                                                                             |
| `lithography_v13_upg31_a_ai5_r2`     | 历史评分 5                                       | 规格通过：历史 5 保留可读、新输入 5 拒绝                                                                              |
| `lithography_v13_upg31_b_closure_r2` | 旧中断/无法修复无原因 + 软删行                   | 升级成功；`is_historical=1`、`closure_reason=NULL`、INTERRUPTED 保留                                                  |
| `lithography_v13_upg31_d_conv_r2`    | 会话归属冲突                                     | 正式入口在 `1775501100000` 兼容预检处**正确拒绝**；history 32、5 个 V13 列 0 存在；按预期拒绝记录，不计入升级成功路径 |

历史清单只包含本轮真实创建并登记的合成 ID 与四列指纹，文件位于库外临时目录（0600），未提交 Git。

### 35.4 阶段1C：旧版增量非空升级

- `lithography_v13_incremental_nonempty_r2`：用旧版迁移类构建 40 态，注入旧回执/备份/恢复/故障等非空行。
- 四列重复组：首次 upgrade 在**首次 DDL 前**拒绝（`四列唯一键存在重复组`），history 仍 40、新列 0、行数不变；
  按“不自动合并/删除/择一保留”停止，仅删除本轮自建的 CLOUD 重复行后继续。
- 再升级成功：history 41、executed 1；旧字段保留、新事实 `NULL`、生命周期与原始故障不互相覆盖、
  旧 `storage_reference` 未被猜测成云端引用、无 DELETE、无擅自归档清空、行数不变。

### 35.5 三路径终态对照

`fresh41` / `upg31` / `nonempty` 三份结构快照逐表、逐列（类型/可空/默认/EXTRA/生成表达式，去掉
`auto_increment`）、逐索引、逐 FK、逐 CHECK 完全一致（三份 diff 为空，证据 `evidence/stage1-parity/`）。
两条升级路径重复执行均 0 迁移，前后 `CHECKSUM` 无漂移。

### 35.6 阶段2：管理员真实链路

`lithography_v13_admin_chain_r2` 上用真实 Nest/GraphQL/JWT 服务（仅 `127.0.0.1:44727`，独占
Redis `127.0.0.1:37275`）验证：初始化三源角色/摘要/身份提示一致、ACTIVE 成员与等级/归属正确、
登录/首次改密/受保护 Query、同组织合法创建-停用-启用、跨组织越权拒绝、重跑 bootstrap 全部
`UNCHANGED` 且哈希不变、冲突身份失败关闭不改写、事务内先成功后故障整体回滚。
密码与加密 key 仅内存生成，不落盘、不输出。证据 `stage2/evidence/admin-chain-1794221937779.json`。

### 35.7 阶段3：约束、专用清理与消费者

- `lithography_v13_cleanup_scope_r2` 正式 init 41 态。
- `v13-db-verification.spec.ts`：**88 passed / 0 failed**（F1/F5/约束/多态引用）。
- `e2e-scoped-cleanup.v13.realdb.spec.ts`：**10 passed / 0 failed**（两个清理入口拒删、合法清理、
  重复执行、后序失败整批回滚、非目标基线不变）。
- 运行中修正两处测试规格缺陷：硬编码 `local_installation.installation_id` 改为读取本库真实种子值；
  非目标基线迁移数 39 → 41。修复后重新冻结（r10）并重跑受影响专项，产品代码未变。
- 消费者四个 e2e 规格不引用任何 V13 新列，只读核验无新列依赖；运行时验证随阶段4 core，本轮未执行。

### 35.8 阶段4：`lithography_e2e` 完整 core — BLOCKED

- 预检核验：UUID 正确、无其他连接、`triggers=0`、基线 39 条迁移（末条 `1775501700000`）、业务表全空；
  已保存受限备份、结构与全字段快照。
- 正式入口升级被预检拒绝：`关键 CHECK 约束缺失：chk_repair_request_closure、chk_repair_request_closure_reason`。
- 实际现场：迁移 39→40（新增 `1775501800000`）；`repair_request` 闭单 CHECK 被删除且未重建；
  `is_historical`、`lifecycle_status`、`local_company_setting.*` 等 1900000 结构均未出现；
  业务数据仍全空、触发器 0、连接 0。
- 根因：契约把 `repair_request.is_historical` 所有者登记为 `1775501900000`，因此 40 态预检不要求该列；
  但当前 `1775501100000` 才负责补该列，本库的 1100000 由更早候选字节执行、实际无此列；
  1900000 先 drop 闭单约束再 ADD 引用 `is_historical` 的约束，因缺列失败 → 非事务 DDL 留下半迁移现场。
- 处置：按指令停止。未插入 KEEP、未启动阶段4 Redis、未执行 core、未改断言、未加 skip；
  不回退已提交 DDL、不手工补 CHECK、不手工改历史、不清库、不 DROP。证据 `stage4/evidence/02-stage4-blocked.md`。

### 35.9 统一收尾与保留资源

- 阶段4 目标只读比较：业务数据 0 行（逐表精确计数），无 KEEP、无夹具、无触发器、无事务/连接残留。
- 8 个 `_r2` 验证库全部保留，不 DROP、不重置 `AUTO_INCREMENT`；各阶段合成数据与账本按证据保留。
- 阶段2 API 进程已退出、独占 Redis 已按端口身份关闭；阶段1/2/3 证据目录与配置（0700/0600）保留。
- 原 `ctrl/A/B`、`admin_verify`、`init/up30/up31/spec` 等既有现场未触碰。

### 35.10 结论

- 阶段1（三路径升级）与阶段2（管理员真实链路）、阶段3（约束/清理/消费者）通过。
- 阶段4 因既有 `lithography_e2e` 的旧字节历史与当前候选不一致、正式入口预检拒绝而阻断，完整 core 未执行。
- 未覆盖项：`lithography_e2e` 的 41 态升级与 KEEP core；四个直接消费者的运行时验证；最终独立审查与提交审计。
- **本轮回合不 commit、不 push、不操作 PR。**

## 第三十六轮：`repair_request_revision.previous_version` 第 43 条最小修复（2026-11-09）

### 36.1 本轮范围

- 仅补第 43 条迁移、Entity、交付清单/精确定义、离线回归与默认关闭的实库用例；不实现 R029/R030 接口。
- 不连接数据库、不建库、不执行实库验收、不 commit/push。

### 36.2 设计裁决

- 冻结 Word 4.7 将 `previous_version` 定义为 `int unsigned`、非空、“比较的上一版本”。
- 42 态实际缺列，字段字典却标记“S2 结构已实现”；按 S5 审计“等价必须显式写明”的标准判定为字段缺失。
- 现有 `revision_no - 1`、`current_revision_no`、快照 JSON、`created_at` 均只能在未受数据库约束的连续性不变量下推导，不构成完整等价；不采用隐式推导。
- 第 43 条落为 `int unsigned NULL` + CHECK `previous_version IS NULL OR previous_version < revision_no`；不回填、不设置默认版本。
- 语义：`NULL`=历史未知；`0`=基于原始版本的首次管理修订；其他值=写入时锁定并核验过的 `current_revision_no`。
- 与冻结 Word 的“非空”差异已在字段字典 §4.7、契约 §3.3、S5 §2.5.1 显式记录，不宣称原设计原样落地。

### 36.3 交付物

- 新迁移：`1775502100000-add-repair-request-revision-previous-version-for-v13.migration.ts`。
- 同步：`repair-request-revision.entity.ts`、`migration-schema-contract.ts`（交付清单/必需列/CHECK/定义/所有权）、契约与规格单测。
- 默认关闭实库用例：`repair-request-revision-previous-version.realdb.spec.ts`（历史 NULL、0→1、1→2、等于/大于拒绝）。
- 前 42 条迁移未改。

### 36.4 验证

- 类型检查、相关单测、变更文件 ESLint/Prettier、构建、`git diff --check` 结果见本轮交付答复。
- 覆盖统计与迁移指纹由离线脚本重算；实库验收另行授权。
- **本轮回合不 commit、不 push、不操作 PR。**

## 第三十七轮：集中实库验收预检阻断（2026-11-09）

### 37.1 本轮范围与边界

- 按授权准备执行 `lithography_v13_delivery_final43` 与 `lithography_v13_revision_upgrade43` 的集中实库验收。
- 预检阶段发现规格与授权目标硬冲突，按“停止报告、不擅自改守卫或新增库”的约定，**未创建任何数据库、未执行 DDL/DML、未创建账号、未运行实库用例**。
- 不 commit、不 push、不操作 PR。

### 37.2 预检事实

- HEAD `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`，分支 `feat/database-v13-deploy`；工作区与 3 个 stash 原样保留。
- 迁移共 43 条；`ALL43=94fc28456ed24db80b10aacd7ee29696d36479f7267244857ea059ad83203643`，与第三十六轮记录一致，前 42 条未被本轮修改。
- 目标实例 `127.0.0.1:3306`，`server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`，MySQL 8.0.46，`utf8mb4/utf8mb4_0900_ai_ci`。
- 两个目标库均不存在：不覆盖、不复用。
- 类型检查、相关离线 Jest（9 passed / 1 skipped，109 passed / 1 skipped）、变更文件 ESLint（无 fix）与 Prettier 全部通过。
- 第 43 条实库规格账本时序复核通过：`seedFixtures` 事务提交返回后立即 `registerSeededFixtures`，中间无查询或断言。

### 37.3 阻断项

1. **开发账号安全门**：`dev-account-bootstrap.ts` 仅允许库名包含 `test/dev/local/drill`；`database-deploy.ts` 在写入前调用该门。`lithography_v13_delivery_final43` 不满足，第五节 V.2 无法经正式入口执行。
2. **D3 约束规格**：`v13-d3-constraint-acceptance.realdb.spec.ts` 硬编码 `lithography_v13_delivery_dev` 并在 `beforeAll` 断言配置库与该名完全相等；该库不在授权范围。
3. **V13 精确清理实库规格**：`e2e-scoped-cleanup.v13.realdb.spec.ts` 无条件断言 `migrations` 恰好 41 条，并依赖 `local_installation` id=1 种子；按 43 条迁移初始化的交付库必然在 R09 失败。
4. **e2e-owned-fixture 清理安全回归**：`test/utils/e2e-owned-fixture.e2e-spec.ts` 固定读取 `env/.env.e2e` 并预期 `lithography_e2e`；该库不在授权范围。

### 37.4 处置与证据

- 停止后续阶段，保留现有现场；未 DROP、未 TRUNCATE、未重置 AUTO_INCREMENT、未修改迁移历史。
- 证据目录：`/home/gandiantx/secure/lithography-v13/evidence/final43/`（0700；文件 0600），含 `git-freeze.txt`、`migration-sha256.txt`、`candidate-files-sha256.txt`、`fingerprints.txt`、`mysql-readonly.txt`、`precheck-conflicts.md`。
- 待授权决策：是否允许将交付库改名带开发标记、或书面授权调整上述规格的数据库/迁移数前置条件；未获授权前不进入第四节至第七节。

## 第三十八轮：`previous_version` 第 44 条落实与 RQ1—RQ6 集中实库复验（2026-11-10）

### 38.1 本轮范围与边界

- 分支 `feat/database-v13-deploy`；起点 HEAD `229a5961a34407cfa369d131e3d73d0b3a8738aa`；工作区已修改/未跟踪文件与 3 个 stash 原样保留。
- 仅追加第 44 条迁移并同步 Entity、结构契约、规格与文档；**前 43 条迁移未改**，不改写已有提交、不 reset、不 stash。
- 未删断言、未加 skip、未用数量替代历史名称/顺序核验；当前 44 条仓库与库外冻结 43 条候选分别承担各自路径。
- 未 DROP DATABASE、未 TRUNCATE、未关闭外键检查、未重置 `AUTO_INCREMENT`、未伪造迁移历史。
- 未授予 `PROCESS`、未修改 `mysql` 系统表、未用高权限绕过反例。
- 不 push、不回复 PR、不合并。

### 38.2 授权实例与专用库

- 实例 `127.0.0.1:3306`，`@@server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`，MySQL 8.0.46。
- 本轮使用：`lithography_rq1_42`、`lithography_rq2_constraint`、`lithography_rq3_account_dev`、`lithography_rq4_org_dev`、`lithography_rq5_43`、`lithography_rq5_42`、`lithography_rq6_cleanup`、`lithography_rq44_previous`。
- 每个库在创建前均经 `scripts/dbtool.js exists` 确认不存在后才创建；`lithography_rq3_account` 与 `lithography_rq4_org` 未创建、未使用，开发账号安全门未改。
- 42/43 态由库外冻结候选（`frozen-42/`、`frozen-43/`）正向构建：空库 + `DataSource.runMigrations()` 仅执行前 N 条，不清库、不伪造历史。

### 38.3 第 44 条实现

- 新迁移 `1775502200000-tighten-repair-request-revision-previous-version-for-v13.migration.ts`：
  - `up` 先读列并校验存在，再在**任何 ALTER 前**统计 `previous_version IS NULL` 与 `previous_version >= revision_no`；
  - 违规则失败关闭，只输出脱敏计数与最多 20 个定位 ID，并明确“未执行任何 ALTER；禁止猜测回填或删除历史行”；
  - 无违规才 `MODIFY COLUMN ... int unsigned NOT NULL`，无默认值；重复执行已是终态则跳过，并复核终态定义；
  - `down` 只回退可空性，不伪造、不删除版本值。
- 同步：`repair-request-revision.entity.ts`（`previousVersion!: number`）、`migration-schema-contract.ts`（`COLUMN_DEFINITIONS` 的 `since=1775502200000`、`nullable=false`、`defaultValue=null`；`COLUMN_CREATED_BY` 仍为第 43 条）、S1 契约/字段字典、S3 SOP、S5 审计、S6 回复草稿。
- 实库规格与离线用例覆盖：空表收紧、合法非空行保留、NULL 旧行零 ALTER 拒绝、等于/大于 `revision_no` 拒绝、合法首次与后续版本通过。

### 38.4 RQ1—RQ6 与 RQ44 实库结果

| 项   | 起点                                                | 实际命令（要点）                                                                                                                          | 结果                                                                                                                                                                                                               |
| ---- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RQ1  | `lithography_rq1_42` 42 态                          | 冻结 43 条候选 runner `upgrade`（错误 UUID / 配置夹带 / 合法路径）；当前仓库 `database:deploy --mode upgrade`；`migration:verify`         | 错误 UUID：`1 failed / 12 passed`，退出码 1；配置夹带：`配置文件包含保留变量 V13_SPEC_SERVER_UUID`，未连库；拒绝前后快照逐字节一致；合法 42→43：13 passed / 0 failed 退出码 0；43→44 后 verify 通过（51 张业务表） |
| RQ2  | `lithography_rq2_constraint` 44 态                  | 分别 `ALTER ... NOT ENFORCED` 指定 CHECK、`DROP INDEX uk_login_name`；verify/init/upgrade；恢复后复跑                                     | 单项漂移时 verify、init、upgrade 均拒绝，原因准确（`enforced=NO` / `关键索引缺失`）；恢复后通过且快照与原始一致；两项未同时制造                                                                                    |
| RQ3  | `lithography_rq3_account_dev`（一条 init 达 44 态） | 既有管理员/工程师映射到他人邮箱；合法新增在前、冲突在后；合法映射复跑；去 dev 选项复跑                                                    | 冲突拒绝并点名占用账号；整批回滚（新增 0 行）；复跑全 `UNCHANGED`；去 dev 不增删；邮箱、密码哈希、角色/等级、资料、公司、成员资格快照一致                                                                          |
| RQ4  | `lithography_rq4_org_dev` 44 态                     | 新建/既有工程师映射到 `ACTIVE + kind=PEER + is_managed_company=0`；合法新增在前、非法在后；`is_managed_company=1 + is_service_provider=0` | 未入管理名单一律拒绝（与 `kind` 无关）；名单内且 `is_service_provider=0` 允许；回滚零残留；快照一致；verify 通过                                                                                                   |
| RQ5  | `lithography_rq5_43` / `lithography_rq5_42`         | 创建带哨兵未知表后执行正式 `database:deploy --mode upgrade`；精确移除未知表后再 upgrade；重复 upgrade                                     | 均在任何 pending/回填前拒绝，执行迁移 0 条；历史、原表、原行、哨兵与快照不变；移除后升级成功且 `previous_version` 原值保留；重复 0 条                                                                              |
| RQ6  | `lithography_rq6_cleanup` 44 态                     | `e2e-scoped-cleanup.v13.realdb.spec.ts` 正常与 `E2E_V13_CONTROLLED_FAULT=1`；先 `--listTests` 机器核对再 `--runTestsByPath`               | 正常 14 passed / 2 skipped；受控故障 16 passed / 0 failed；CREATE 后断言失败精确回收、UPDATE 后按 `status + finished_at` 写入值 CAS 恢复；主错误/收尾错误/残留诊断保留；17 表零残留                                |
| RQ44 | `lithography_rq44_previous` 43 态                   | 插入合法首版行与 NULL 历史行后正式 upgrade                                                                                                | 在第 44 条任何 ALTER 前拒绝（`previous_version IS NULL=1（样本 ID: 2）`）；历史仍 43、列仍可空、两行保留；未回填、未删除、未伪造通过；现场保留                                                                     |

### 38.5 最终交付基线

- `lithography_rq3_account_dev` 一条正式 `database:deploy --mode init` 完成：44 条迁移、1 个合成公司、3 个 1 级管理员、3 个 2 级管理员、2 个客户、2 个工程师（10 个账号、10 条成员关系）。
- 密码/角色/等级/资料/公司/成员资格核验通过；正式 verify 通过，终态 44。
- 同命令重跑 0 条迁移，全部 `UNCHANGED`；不传 dev 选项不增删既有开发账号。
- 初始化公司与 10 个账号为本轮基线数据，不是测试残留。

### 38.6 RQ6 观测边界

- 授权账号在本轮开始前已持有 `PROCESS`；本轮未授予、未回收，也未修改系统表。
- 因此本轮未在该账号上演示“无 `PROCESS`”的真实条件；该分支由离线能力用例覆盖。
- 默认观测只读 `performance_schema`（`events_transactions_current` + `PS_CURRENT_THREAD_ID()`），不读取 `information_schema.innodb_trx`，不把不可观测/空结果当成“无活动事务”。
- 本轮实测：`@@performance_schema=1`、消费器 `events_transactions_current=YES`、当前连接活动事务 0。

### 38.7 离线验证

| 项                 | 命令                                                          | 结果                                                |
| ------------------ | ------------------------------------------------------------- | --------------------------------------------------- |
| 正式类型检查       | `npm run typecheck`                                           | 退出码 0                                            |
| RQ 定向回归        | 12 个 spec                                                    | 140 passed / 13 skipped，退出码 0                   |
| 完整后端单测       | `npm run test:unit -- --runInBand`                            | 159 suites、1841 passed / 197 skipped，退出码 0     |
| 变更文件 ESLint    | 仓库根 `./backend/node_modules/.bin/eslint <files>`（无 fix） | 0 errors / 17 warnings                              |
| Prettier           | `prettier --check <changed files>`                            | 通过                                                |
| 能力文档门禁       | `npm run check:capability-docs`                               | 退出码 0                                            |
| usecase 归一化守卫 | `npm run check:usecase-normalize`                             | 退出码 0                                            |
| 架构夹具           | `npm run check:architecture-fixtures`                         | 退出码 0                                            |
| entity-scope       | `npm run check:entity-scope`                                  | 退出码 1（旧 PR3 按既有裁决记不适用，未改政策骗绿） |
| 构建               | `npm run build`                                               | 退出码 0                                            |
| 空白检查           | `git diff --check`                                            | 退出码 0                                            |

### 38.8 指纹

| 项           | 值                                                                 |
| ------------ | ------------------------------------------------------------------ |
| HEAD         | `229a5961a34407cfa369d131e3d73d0b3a8738aa`                         |
| ALL44        | `72dc3718fba8fd350beda73477a811d4de96c907eb9c3d117eaaff495ce99eb9` |
| 冻结 43 候选 | `42d8c24c27c6c58d373bec0019eef6b35a2294f5c9a37c4832a0c387f5315db5` |
| 冻结 42 候选 | `1d569b4b8fe09ceb3c90c353d89e7e7ddbd08b790bfe371bd0501a5e6faa6ed9` |

（ALL44 为按文件名排序后逐文件 `sha256sum` 再整体取 `sha256`。）

### 38.9 证据与保留资源

- 证据根目录 `/home/gandiantx/.local/share/lithography-v13-rq-evidence/`（目录 0700、文件 0600；不入库）：
  `01-config/`、`02-rq1/`、`03-rq44/`、`04-rq2/`、`05-rq3/`、`06-rq4/`、`07-rq5/`、`08-rq6/`、`09-baseline/`、`10-mappings/`、`11-mappings-rq4/`、`frozen-42/`、`frozen-43/`、`scripts/`。
- 库外工具：`dbtool.js`、`snapshot.js`、`account-facts.js`、`gen-mappings.js`、`gen-rq4-mappings.js`、`build-state.ts`。
- 保留资源：8 个授权专用库及其现场（含 `lithography_rq44_previous` 的 NULL 拒绝现场、`lithography_rq5_43/42` 的 44 态），未 DROP。
- 非目标数据：均未触碰审查方数据库、生产业务库、共享库、150 行事故现场与任何 Redis 实例。

### 38.10 限制与未关闭项

- 本轮验证起点为库外冻结候选与本轮新建空库；**不宣称任意真实旧库已验证**。
- 升级验收仅覆盖 42→43（冻结候选）、43→44 与 42/43→44（本轮合成库）；生产存量库升级仍需另行评审与书面授权。
- R029/R030 写入接口与读取审计仍未实现，属功能缺口，不在本期范围。
- 旧 PR3 entity-scope 门禁退出码 1，按既有裁决记不适用。
- **本轮回合不 push、不回复 PR、不合并。**

## 第三十九轮：RQ5 44 态未知表拒绝与 RQ6 真实无 PROCESS 条件核对（2026-11-10）

### 39.1 范围与候选

- 分支 `feat/database-v13-deploy`；HEAD `00c4118fa25462a68095075c535dd016a3f83659`（与要求一致）。
- 工作区与 3 个 stash 原样保留；未 reset、未 stash、未改写提交。
- 迁移 44 条，`ALL44=72dc3718fba8fd350beda73477a811d4de96c907eb9c3d117eaaff495ce99eb9`；
  未改迁移、Entity、权限政策或测试断言。
- 实例 `127.0.0.1:3306`，`@@server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`，MySQL 8.0.46；
  `CURRENT_USER()=gandiantx@127.0.0.1`。
- 仅使用 `lithography_rq5_43` 与 `lithography_rq6_cleanup`；未新建数据库、未 DROP 数据库、未 TRUNCATE、
  未关闭外键、未重置 `AUTO_INCREMENT`、未修改迁移历史、未操作其他库或 Redis。

### 39.2 RQ5：44 态、pending=0 时拒绝未知表

- 只读核对：迁移历史 44 条，名称/时间戳/顺序与仓库一致；`status` 输出 `历史 44 条；仓库 44 条；pending 0 条`；
  正式 `migration:verify` 退出码 0，业务表 51 张。
- 基线：52 张基础表、44 条历史、0 个触发器、1 个自身会话、0 个本账号活动事务；
  快照 `12-rq5-44/44-before.json`，sha256 `8c7fe156c07b73229996bc5c8203c311bf979fa9f8be19cf1e2ac51d9e3674bb`。
- 合成对象：创建前确认 `rq5_44_unknown_probe_2c9d` 不存在（0）；
  创建 `id int NOT NULL` / `payload varchar(64) NOT NULL` / `PRIMARY KEY (id)` 的未知表；
  插入哨兵 `(1, 'RQ5-44-SENTINEL-20261110')`；登记 `SHOW CREATE TABLE`、哨兵与引用数（0）。
- 正式 CLI：`npm run database:deploy -- --mode=upgrade --config-file=<受限配置>
--database=lithography_rq5_43 --confirm-database=lithography_rq5_43`。
  - 退出码 1；原因 `存在预期之外的业务表: rq5_44_unknown_probe_2c9d`；
  - 无“已执行 N 条迁移”；无收尾错误；历史仍 44；哨兵仍在。
- 拒绝前后快照逐字节一致：sha256 `49301f2bbc884ae0054a5d298fd23e07891624ea9cce0b3023e63dc63f219cc1`。
- finally 复核表定义、哨兵与引用关系（0）后，精确 `DROP TABLE`（不使用 `IF EXISTS`），退出码 0，残留 0；
  删除后快照与基线逐字节一致（sha256 `8c7fe156...`）。
- 恢复后正式 verify 退出码 0；upgrade 退出码 0，`pending 0`、`无变化`；
  最终 52 张基础表、44 条历史、0 个触发器、0 个驻留会话、0 个残留合成对象。

### 39.3 RQ6：真实无 PROCESS 条件核对

- 既有正常/受控故障运行（`08-rq6/`）使用 `gandiantx@127.0.0.1`；该账号 `SHOW GRANTS` 明确含全局 `PROCESS`，
  本轮未授予、未回收、未改系统表。因此该运行只能作为功能证据，**不能**充当条件 A/B。
- 只读核对（`13-rq6-accounts/`）：
  - `gandiantx@127.0.0.1`：全局 `PROCESS`；`mysql.role_edges` 0 行。
  - `litho_m39@127.0.0.1`：无全局 `PROCESS`、无角色；仅 `USAGE` 与 `lithography_v13_m39_a/b` 的 9 项库级权限；
    `lithography_rq6_cleanup` 的库/表/列级授权均为 0；
    实测 `CURRENT_USER()=litho_m39@127.0.0.1`；读取 `performance_schema.events_transactions_current`
    返回 `ER_TABLEACCESS_DENIED_ERROR`。
  - 条件 A 缺失：不存在“无 `PROCESS` + 具备 `lithography_rq6_cleanup` 专项权限 + 可读事务观测视图”的既有账号。
  - 条件 B 缺失：`litho_m39` 虽无 `PROCESS` 且不可观测，但缺少目标库专项权限，无法抵达观测前置；
    未用它冒充条件 B，也未用它运行专项。
- 条件 A/B 均记为 **NOT_EXECUTED**；未创建账号、未 `GRANT`/`REVOKE`、未修改 `mysql` 系统权限表。
- DBA 最小模板见 `13-rq6-accounts/dba-authorization-template.sql`：条件 A 为目标库 9 项库级权限 +
  两个观测对象 `SELECT`；条件 B 仅目标库 9 项库级权限，不含全局 `PROCESS`、不含 `GRANT OPTION`。

### 39.4 结论与限制

- RQ5 已取得 44 态、pending=0 的正式 CLI 拒绝证据，且清理与恢复前后快照一致。
- RQ6 的“真实无 `PROCESS`”条件 A/B 因既有账号权限不满足而保留未验证；不以离线用例或高权限账号替代。
  **该缺口已由第四十轮用户提供的低权限账号补齐，见下。**
- 未 push、未回复 PR、未合并；本轮因 RQ6 两项未取得有效实库证据而未追加验收提交。

## 第四十轮：RQ6 真实无 PROCESS 条件 A/B 补验（2026-11-10）

### 40.1 范围与账号

- 候选仍为 `00c4118fa25462a68095075c535dd016a3f83659`；未改代码、迁移、Entity、权限政策或测试断言。
- 实例/库：`127.0.0.1:3306` / `lithography_rq6_cleanup`；`@@server_uuid` 与授权值一致。
- 用户本轮创建的两个低权限账号，配置位于库外
  `/home/gandiantx/secure/lithography-v13/rq6-lowpriv/`（文件 0600、目录 0700）：
  - `litho_rq6_a@127.0.0.1`：无全局 `PROCESS`、无角色；目标库 9 项库级权限 +
    `performance_schema.events_transactions_current`、`performance_schema.threads` 的 `SELECT`。
  - `litho_rq6_b@127.0.0.1`：无全局 `PROCESS`、无角色；仅目标库 9 项库级权限，无任何 `performance_schema` 授权。
- 本轮未创建账号、未 `GRANT`/`REVOKE`、未修改 `mysql` 系统权限表；测试进程以 A/B 运行，未使用 root。
- 配置输入异常：`account-b.env` 的 `DB_PASS` 多一个前导 `=`，且缺少 host/port/db/timezone；
  运行封装在内存中纠正/补齐，未改原文件、未落盘新密码。

### 40.2 前置与快照

- `CURRENT_USER` 均实测为对应低权限账号；`SHOW GRANTS` 仅含上述直接授权，`mysql.role_edges` 对两账号均为 0。
- `migration:status`：历史 44 条、仓库 44 条、pending 0 条，退出码 0。
- 基线快照 `14-rq6-lowpriv/rq6-before.json`：52 张基础表、44 条历史、0 触发器、`s4e_` 夹具 0；
  sha256 `d7479fdb82f02576ab0d4b2fc5d64b7ad6f206ebaa5dcafc3f30be4513ce2776`。

### 40.3 条件 A（可观测、无 PROCESS）

- 入口：`test/jest-v13-authoritative.config.js` + 单一 `--runTestsByPath`；
  封装先用同一配置/环境运行 `--listTests`，实际集合精确为 1 个
  `src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts`，退出码 0。
- 实际执行：退出码 0；**14 passed / 0 failed / 2 skipped**（受控故障开关关闭，2 个 FAULT 用例按设计跳过）。
- 收尾：快照前后逐字节一致（同一 sha256）；`s4e_` 夹具 0、驻留会话 0、A 账号活动事务 0、
  用户级锁 0、触发器 0；未读取 `INNODB_TRX`。
- 账号语句计数（前后差）：SELECT +810、INSERT +68、UPDATE +18、DELETE +75；
  CREATE/ALTER/DROP/TRUNCATE 均 0，说明确有造数并完成精确回收。

### 40.4 条件 B（不可观测、无 PROCESS）

- 同一入口、同一 `--listTests` 校验（精确 1 个文件），再实际执行；退出码 1。
- 结果：**4 passed / 10 failed / 2 skipped**；10 个实库用例全部在 `beforeAll` 失败，错误为
  `当前账号无法读取 performance_schema.events_transactions_current，拒绝创建夹具（零造数）`，
  cause 为 `SELECT command denied ... for table 'events_transactions_current'`。
- 零造数：账号语句计数（前后差）仅 SELECT +4；
  INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE 均 0。
- 运行前后快照逐字节一致（sha256 `d7479fdb...`）；`s4e_` 夹具 0、驻留会话 0、
  B 账号活动事务 0、用户级锁 0、触发器 0。

### 40.5 结论

- RQ6 条件 A/B 均已取得真实无 `PROCESS` 实库证据；条件 B 在任何造数前按观测能力不足失败关闭。
- 未 push、未回复 PR、未合并；本轮仅补充证据与文档。
