<!-- 文件位置：docs/database/self-registration-engineer-approval-acceptance-20261029.md -->

# 客户自助注册与工程师组织审核：设计、接口与验收记录（2026-10-29）

- 分支：`feat/maintenance-data-increment`，交接基线 HEAD `30c2732230ccf00927963478da430122d86c1cc9`；本轮改动全部在工作区，**未暂存、未 commit、未 push、未创建或合并 PR**。
- 本文承接临时计划 `backend/plans/self-registration-engineer-approval-plan.md` 的稳定内容；计划文件在本轮交接后删除，不作为最终 PR 材料。
- 本文同时记录**修复方实测**。蔡自审、薛一审、负责人二审、独立复审与 CI 均未在本轮执行，不能把本文当作已通过评审。

## 1. 范围与结论

交付范围是客户自助注册、工程师待审申请与组织管理员审批的后端闭环及 GraphQL 契约：

- 客户选择有效组织后直接注册开通，同一事务建立 `CUSTOMER` 成员关系；
- 工程师注册创建 `PENDING / PENDING` 账号与一份待审申请，不建立成员关系、不能登录；
- 本人可凭密码凭据查询申请状态，被拒后可重提并保留原审核历史；
- 所选组织管理员可查询本组织队列、详情并做一次性通过/拒绝决策；
- 通过时账号、资料、成员关系与申请终态在同一事务生效；
- 管理员代建入口、既有组织边界、第三方小程序注册路径保持兼容。

不新增角色、不开放管理员自助注册、不改变「一个账号只有一个有效组织」的库级约束。完整注册/审核页面未实现，本轮只交付可消费契约与人工验收步骤，**不得宣称整套前端注册功能已上线**。

## 2. 正式设计

### 2.1 新增表 `engineer_registration_application`（迁移序号 30）

| 字段                      | 类型                                   | 语义                                              |
| ------------------------- | -------------------------------------- | ------------------------------------------------- |
| `id`                      | int 自增主键                           | 申请记录                                          |
| `account_id`              | int NOT NULL                           | 待审工程师账号，FK → `base_user_account` RESTRICT |
| `organization_id`         | int NOT NULL                           | 本次申请目标组织，FK → `organization` RESTRICT    |
| `status`                  | varchar(16) NOT NULL DEFAULT `PENDING` | `PENDING / APPROVED / REJECTED`                   |
| `application_note`        | varchar(2000) NULL                     | 申请说明                                          |
| `submitted_at`            | timestamp(3) NOT NULL                  | 服务器提交时间                                    |
| `reviewed_by_account_id`  | int NULL                               | 审核管理员，FK RESTRICT                           |
| `reviewed_at`             | timestamp(3) NULL                      | 审核事件时间                                      |
| `review_comment`          | varchar(2000) NULL                     | 拒绝必填非空白；通过可空                          |
| `pending_account_id`      | int STORED 生成列，只读                | `PENDING` 时为 `account_id`，否则 NULL            |
| `created_at / updated_at` | timestamp(3)                           | 系统记录时间                                      |

索引与约束：

- `uk_engineer_registration_application_pending_account (pending_account_id)`：同一账号同时最多一份 `PENDING` 申请；
- 审核队列索引 `(organization_id, status, submitted_at, id)`；申请历史索引 `(account_id, submitted_at, id)`；
- 5 条 CHECK：状态值域；`PENDING` 时审核人/时间/意见必须为空；终态必须有审核人与时间；`REJECTED` 意见去空白后非空；审核时间不得早于提交时间；
- 外键只证明引用存在。管理员属于目标组织、账号确为待审 `ENGINEER`、组织仍启用、无有效成员关系等事实由审核事务在锁内复核。

### 2.2 状态与一致性

| 动作             | account.status / userInfo.userState | 有效成员关系                       | 申请                        |
| ---------------- | ----------------------------------- | ---------------------------------- | --------------------------- |
| 客户注册成功     | ACTIVE / ACTIVE                     | 建立 ACTIVE `CUSTOMER`（所选组织） | 不创建                      |
| 工程师提交申请   | PENDING / PENDING                   | 无                                 | 新增 PENDING                |
| 审核通过         | ACTIVE / ACTIVE                     | 在目标组织建立 ACTIVE `ENGINEER`   | 原申请变 APPROVED           |
| 审核拒绝         | PENDING / PENDING                   | 无                                 | 原申请变 REJECTED，保留意见 |
| 拒绝后重提       | 保持 PENDING / PENDING              | 无                                 | 新增 PENDING，旧记录不覆盖  |
| 管理员代建工程师 | ACTIVE / ACTIVE                     | 绑定管理员所属组织                 | 无需自助申请                |

拒绝不是账号封禁；已开通、被停用/封禁或已有有效成员关系的账号不得借重提重新开通或换组织。不支持客户升级工程师、自助改角色或已开通账号自助换组织。

### 2.3 事务与锁序

- 事务边界由 usecase 通过 `TransactionRunner` 持有；写入口只经模块服务写库，不直接操作 repository。
- 统一锁序：**申请人账号行锁在前，申请行锁在后**；审批与重提共用同一顺序，避免与既有管理员账号写入锁序冲突。
- 审核通过在同事务内完成四写：成员关系、账号 `ACTIVE`、资料 `ACTIVE`、申请 `APPROVED`；任一步失败整体回滚。
- 并发第二次决策以条件更新命中 0 行返回 `CONFLICT`，不覆盖第一次终态。
- 审核前先做纯内存会话判定，再开事务；事务内复用同一权限断言复核可信成员事实，避免 TOCTOU。

### 2.4 权限与身份证明

- 审核入口要求可信 `SUPER_ADMIN` 会话 + 可信成员关系 `memberRole = SUPER_ADMIN`；组织范围由服务端按成员关系解析，不接受客户端自报 `organizationId`。跨组织查询/审核一律 `NOT_FOUND`。
- 申请人本人查询/重提不使用 JWT，不签发令牌、不放行登录；只复用既有密码凭据校验证明「本人」。凭据失败统一 `CREDENTIAL_MISMATCH`（`UNAUTHENTICATED`），不区分账号不存在与密码错误。
- 登录只放行 `account.status = ACTIVE`；受保护请求令牌复核要求账号与资料均为 `ACTIVE`。第三方登录复用既有 `ACTIVE` 校验，第三方注册不提供工程师绕过审批入口。
- 管理员启停矩阵继续拒绝 `PENDING`，不能用「启用账号」替代审批。

### 2.5 评审修正与未采纳项（稳定结论）

已吸收的修正：本人状态入口由 Query 改为 Mutation（密码走请求体，不进入查询串/缓存）；GraphQL DTO/Input 按「一个 I/O 一个文件」拆分；组织选项直接使用模块稳定 View；移除无调用方方法与未引用类型；mapper 对未知状态 fail-closed；分页收窄统一 `isOffsetMode`；第三方入口补齐组织必填守卫；接口文档标注 `organizationId` 必填为破坏性变更。

明确不采纳：`ORGANIZATION_NOT_AVAILABLE` 不迁入新的错误组；`insertApplication` 事务上下文保持可选（与同域写服务一致）；resolver 既有 `clientIp` 解析不重构；不另建申请人 DTO 形状。

已知性能项（followup，不属本轮缺陷）：审核队列逐条读取申请人（N+1），当前无批量读接口，新增属扩大范围，留待后续评估。

## 3. 接口契约

完整字段与错误码见 [account-write-current.md](../../backend/docs/api/account-write-current.md) 与 [auth-session-current.md](../../backend/docs/api/auth-session-current.md)；GraphQL 错误遵循 [graphql-error-contract-current.md](../../backend/docs/api/graphql-error-contract-current.md)。

| 操作                              | 类型     | 权限         | 关键语义                                                                            |
| --------------------------------- | -------- | ------------ | ----------------------------------------------------------------------------------- |
| `registrationOrganizations`       | Query    | 公开         | 只返回 ACTIVE 组织的 `id/name`                                                      |
| `register`（含 `type=ENGINEER`）  | Mutation | 公开         | `organizationId` 必填；客户 `REGISTERED`，工程师 `PENDING_REVIEW` + `applicationId` |
| `thirdPartyRegister`              | Mutation | 公开         | `organizationId` 必填；只创建并绑定 CUSTOMER                                        |
| `myEngineerRegistrationStatus`    | Mutation | 本人密码凭据 | `latest` + OFFSET 分页历史；不使用 JWT                                              |
| `resubmitEngineerRegistration`    | Mutation | 本人密码凭据 | 仅拒绝后重提，新增 PENDING，保留历史                                                |
| `adminEngineerRegistrations`      | Mutation | SUPER_ADMIN  | 仅本组织队列，`status` 可选，页大小 ≤100                                            |
| `adminEngineerRegistrationDetail` | Mutation | SUPER_ADMIN  | 跨组织返回 `NOT_FOUND`                                                              |
| `reviewEngineerRegistration`      | Mutation | SUPER_ADMIN  | `APPROVE` 同事务开通；`REJECT` 意见必填；重复决策 `CONFLICT`                        |

破坏性变更：`register` 与 `thirdPartyRegister` 的 `organizationId` 现为必填非空；旧客户端不传会收到 `BAD_USER_INPUT`，必须与后端同批切换。`src/schema.graphql` 由 Nest code-first 在运行时生成且被 Git 忽略，不作为手写维护源；真实契约由下表 E2E 直接调用验证。

前端状态映射：加载态由前端控制；待审 = `PENDING_REVIEW` 或申请 `PENDING`；拒绝 = 申请 `REJECTED` 且账号不能登录；成功 = `REGISTERED` 或审核 `APPROVED`。

## 4. 部署与开放注册条件

正式操作步骤见 [部署与增量升级 SOP](./部署与增量升级SOP-20261029.md)。与本次注册增量直接相关的条件：

1. 目标库先按 SOP 升级到 **30 条迁移 / 34 张业务表** 终态；`engineer_registration_application` 默认空表，不随 Seed 导入。
2. `registrationOrganizations` 只列出 ACTIVE 组织。开放注册前必须确认组织名称/编码正确、状态为 ACTIVE；不得按厂家、公司名、登录名或邮箱域名自动推断组织。
3. 5 个管理员按部署配置与正确组织初始化，密码不进代码；每个管理员只应属于其管理组织且成员角色为 `SUPER_ADMIN`，否则无法看到/审核该组织申请。
4. 客户注册会立即建立所选组织 `CUSTOMER` 成员关系；工程师通过审批后建立 `ENGINEER` 成员关系。部署后不得再按旧口径宣称「自助注册不建立成员关系」。
5. 待审工程师账号已占用登录名/邮箱唯一键但**不能登录**；不得手工把账号改为 ACTIVE 或直接插入成员关系来「替代审批」，否则破坏审批语义与审计。
6. 第三方小程序入口同样要求 `organizationId`；客户端需与后端同批升级，否则旧客户端注册会因缺少组织而失败。

## 5. 验收证据（修复方实测，2026-10-29）

### 5.1 隔离库、连接目标与写入/清理授权

- 连接目标：`127.0.0.1:3306`，MySQL 8.0.46，账号 `gandiantx`（`CURRENT_USER()` 实测 `gandiantx@127.0.0.1`）。
- 使用库：`lithography_e2e`（E2E，白名单强制）、`lithography_drill`（清库演练）与 `lithography_upgrade_drill_copy_20261030`（保留数据副本，正式增量升级证据）；除这三库外未写入其他库。
- 同实例另有 `lab_manager`、`aigc_friendly` 等非本任务库；本轮未连接、未读写、未清理。
- 库名保护：E2E 全局前置无条件执行 `SELECT DATABASE()` 白名单校验；全库 TRUNCATE 另需 `E2E_ALLOW_DB_CLEANUP=1`；单规格物理清理另需 `E2E_ALLOW_PHYSICAL_CLEANUP=1`。迁移演练入口要求库名含 `test/drill/ci` 或显式 `MIGRATION_DRILL_ALLOW_NON_TEST_DB=true`。

### 5.2 迁移

当前迁移清单实际为 **30 条**（`src/infrastructure/database/migrations/*.ts` 计数 30）；第 30 条为本轮新增申请表。

**清库 drill（构造旧基线）**

| 演练           | 命令要点                                                                       | 结果                                                                                        | 退出码        |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------- |
| 空库全迁移     | `MIGRATION_DRILL_DATABASE=lithography_drill` + `verify-empty-db-migrations.ts` | 清空后执行 **30** 条，表/列/索引/CHECK/外键契约通过                                         | 0             |
| 旧库副本增量   | 同上 + `MIGRATION_DRILL_BASELINE_COUNT=29`                                     | 旧基线 29 条 + 仅执行新增 1 条；旧迁移无重跑                                                | 0             |
| 重复执行零新增 | 升级演练内再次 `runMigrations`                                                 | 再次执行 **0** 条                                                                           | 0（断言内置） |
| 旧数据保留     | 演练内置 fixture                                                               | `equipment_model` / `base_user_account` / `reference_document` 保留，归属与入库方式回填正确 | 0（断言内置） |

说明：清库 drill 的「旧库增量」是在演练入口内先构造 29 条基线再升级，**不能替代**在保留真实数据的旧库副本上执行正式升级入口。

**升级证据口径**：下述结果为「由 30 态副本回退构造 29 态后，正式 CLI 四步验证通过」。**不是**真实历史 29 态库的完整兼容性验证：副本由当前 30 态库整体复制后单向回退第 30 条，迁移记录与数据行数均受构造过程约束。

**正式增量升级入口（回退构造的 29 态副本，`status → run → verify → run`）**

副本库 `lithography_upgrade_drill_copy_20261030` 由 `lithography_drill` 一致复制（30 条迁移记录 + `equipment_model` 1 行 + `base_user_account` 1 行 + `reference_document` 1 行），随后**只回退第 30 条**（`DROP TABLE engineer_registration_application` + 删除对应 `migrations` 记录）得到 29 态副本；旧数据既未清空也未重建。正式 CLI 使用临时显式 env（`DB_NAME` 与 `--database` 一致），四条命令如下：

| 命令                                                                                  | 结果摘要                                                                                                                        | 退出码 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `migration:status --config-file=… --database=lithography_upgrade_drill_copy_20261030` | 目标 `127.0.0.1:3306/…copy_20261030`（MySQL 8.0.46）；历史 **29** 条、仓库 **30** 条、pending **1** 条                          | 0      |
| `migration:run … --confirm-database=lithography_upgrade_drill_copy_20261030`          | 仅执行 `CreateEngineerRegistrationApplication1775401500000` **1** 条；升级后历史 **30** 条、业务表 **34** 张、再次执行 **0** 条 | 0      |
| `migration:verify …`                                                                  | 业务表 **34** 张；历史校验与数据回填校验通过                                                                                    | 0      |
| 再次 `migration:run …`                                                                | 历史 30 条、pending **0** 条；待执行 0 条，结构校验通过，再次执行 **0** 条                                                      | 0      |

升级后回读：`migrations` 30 条；`equipment_model` / `base_user_account` / `reference_document` 各保留 1 行（合计 3 行，即本轮数据范围），`reference_document` 的 `owner_organization_id=1`、`ingest_method=ADMIN_DIRECT` 回填正确；基础表 35 张（含 `migrations`，业务表 34 张）；新表 `engineer_registration_application` 存在且为 **0** 行。SOP 中的 24→30 组合仍未演练；本轮正式入口覆盖 29→30 与重复执行零新增，其 29 态来源见上述「回退构造」口径。

### 5.3 注册与审批真实链路、越权、回滚、并发

新增 `backend/test/02-register/engineer-registration-approval.e2e-spec.ts`（初版 16 项，退出码 0；补部分成功与回读失败回归后为 19 项，结果见 5.8），覆盖：

- 客户选择组织后即时 `ACTIVE / ACTIVE`、建立 CUSTOMER 成员并可登录；
- 伪造组织主键被拒绝且零落库；公开组织选项只返回有效组织；
- 工程师注册 `PENDING / PENDING`、无成员关系、登录被阻断；本人凭据查询成功，错误密码与客户账号被拒；
- 非管理员不能查看队列；对侧管理员跨组织详情/审核返回 `NOT_FOUND`；
- 拒绝必须填写意见（`BAD_USER_INPUT` 且申请仍待审）；拒绝后账号保持待审，可重提且拒绝历史保留；已开通客户不能借重提绕过成员边界；
- 审核通过同事务生效且登录可用；
- 注册写申请失败整体回滚；审核写成员失败时申请仍待审、账号仍待审、零部分写入；恢复后再次通过成功；
- 真实并发：同凭据注册只成功一次、同账号重复重提只产生一份新待审申请、两管理员相反决策只有一个生效且终态一致；
- `afterAll` 用受保护清理按账本 ID 精确回收，并断言本轮夹具零残留。

回归套件（各自独立执行，退出码均为 0）：

| 套件                                         | 结果                            |
| -------------------------------------------- | ------------------------------- |
| `register.e2e-spec.ts`                       | 20 passed                       |
| `register-email-active.e2e-spec.ts`          | 3 passed                        |
| `weapp-register-active.e2e-spec.ts`          | 1 passed                        |
| `engineer-registration-approval.e2e-spec.ts` | 16 passed（初版 16 项时点结果） |
| `admin-user-management.e2e-spec.ts`          | 33 passed                       |
| 四份合计（无全局 TRUNCATE 的同轮执行）       | **40 passed**, exit 0           |

本轮修复后单独重跑 `engineer-registration-approval.e2e-spec.ts`（16 passed / exit 0）与 `admin-user-management.e2e-spec.ts`（33 passed / exit 0），均带 `E2E_ALLOW_DB_CLEANUP=1` + `E2E_ALLOW_PHYSICAL_CLEANUP=1` 在 `lithography_e2e` 上执行。

### 5.4 清理工具安全边界复核

共享清理器新增 `engineerRegistrationApplication` 归属类别：登记真实申请 ID，并在删除前核对 `account_id / organization_id / application_note`；申请行对账号/组织均为 FK RESTRICT，删除顺序排在成员关系与账号/组织之前。

清理元规格（真实隔离库）本轮全部通过：

| 套件                           | 结果                                         |
| ------------------------------ | -------------------------------------------- |
| `e2e-db-guard`                 | 通过                                         |
| `e2e-db-target-consistency`    | 通过                                         |
| `e2e-scoped-cleanup`           | 通过                                         |
| `e2e-scoped-cleanup-ownership` | 通过（含新表相关闭包与 C05B 外部成员场景）   |
| `e2e-scoped-cleanup-faults`    | 通过                                         |
| `owned-ledger-lifecycle`       | 通过                                         |
| 合计                           | **85 passed / 0 failed / 0 skipped**, exit 0 |

本轮范围内最小修复两处：

- `engineer-registration-approval.e2e-spec.ts` 移除未使用导入（ESLint error），修复后 `lint` 0 error；
- `e2e-scoped-cleanup-ownership.e2e-spec.ts` 的 C05B 夹具：库级唯一键 `uk_organization_membership_active_account` 限制「一个账号只有一个 ACTIVE 组织」，同账号第二条外部成员关系改为 `LEFT`（写 `left_at`），仍保留「账号在账本外组织有成员关系 → 预检拒绝、零 DELETE」的原意。

### 5.5 KEEP 与夹具残留

- 在 `lithography_e2e` 登记 6 行合成非夹具 KEEP（组织、账号、资料、成员、停用机型、第三方绑定，ID 9900001 区间）。
- 运行四份注册/审批套件时**不执行全局 TRUNCATE**（`E2E_SKIP_DB_CLEANUP=true` + `E2E_ALLOW_PHYSICAL_CLEANUP=1`），仅由各规格受保护清理回收本轮资源。
- 运行前后对 **35 张表、36 行**（含 30 条迁移记录 + 6 行 KEEP）做确定性排序逐字段摘要，结果 `KEEP_COMPARE=OK`，逐表摘要完全一致。
- 运行后按本轮夹具指纹回读：账号 0、组织 0、成员关系 0、工程师申请 0（`RESIDUE=0`）。
- 随后精确删除 KEEP，库内只剩 30 条迁移记录，未使用 Seed 或整表清理。

### 5.6 项目规定检查

| 检查     | 命令                               | 结果                                                               | 退出码 |
| -------- | ---------------------------------- | ------------------------------------------------------------------ | ------ |
| 类型检查 | `npm run typecheck`                | 通过                                                               | 0      |
| Lint     | `npm run lint`                     | 0 error；10 条既有复杂度告警（非本轮文件）                         | 0      |
| 单元测试 | `npm run test:unit`                | 124/129 套件通过（5 skipped）；1465 passed / 59 skipped / 0 failed | 0      |
| 格式     | `npx prettier --write`（改动文件） | 无重排差异                                                         | 0      |

实现阶段定向单测（S2—S4 与评审修正轮）：`src/modules/lithography` + `src/usecases/registration` + `src/usecases/auth` 共 28 个套件、232 passed / 9 skipped，已包含在上表全量单测结果内。

### 5.7 复审缺口修复与验证（2026-10-30）

本轮针对复审提出的三项代码问题与一项验收证据缺口做了最小修复，未改变既有分层与依赖方向：

| 问题                                                             | 修复位置                                                                                                                                                                                                                                                                                                                         | 口径                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [P1] 原有用户管理未落实组织隔离（列表 / 编辑 / 启停 / 重置密码） | `usecases/account/list-admin-users.usecase.ts`、`admin-user-write-support.ts`、`admin-set-user-status.usecase.ts`、`admin-reset-user-password.usecase.ts`、`admin-update-user-profile.usecase.ts`，`modules/account/queries/admin-user.query.service.ts`、`modules/lithography/queries/organization-membership.query.service.ts` | 列表经 `resolveForAccount()` 解析管理员单一有效组织，再以组织内 ACTIVE 账号 ID 清单下推 `IN`（空清单返回空页，不退化为全库）；写路径在 `loadWritableAdminUserTarget()` 内统一「解析组织 → 行锁 → 读 View → `findActiveMembership()` → 角色断言」，跨组织目标统一 `TARGET_NOT_FOUND` |
| [P2] 新接口非法输入在生产环境被误报为系统错误                    | `infrastructure/graphql/filters/graphql-exception.filter.ts`                                                                                                                                                                                                                                                                     | 生产分支不再把 HTTP 异常大类固定为 `INTERNAL_SERVER_ERROR`，改为 `code ?? mapHttpToGqlCode(status)`；生产环境只隐藏 `errorCode` / `errorMessage` / 自由文本，`applicationId: 0` 仍为 `BAD_USER_INPUT`                                                                               |
| [P2] 新注册 E2E 成功后漏登记窗口                                 | `test/02-register/engineer-registration-approval.e2e-spec.ts`                                                                                                                                                                                                                                                                    | `registerEngineerAndRecord()` 先登记已知申请 ID 再做可失败的资料查询；并发分支改为「成功响应返回即登记」+ `Promise.allSettled`（详见 5.8）                                                                                                                                          |

本轮定向验证（均在本地实际执行）：

| 检查                              | 命令 / 范围                                                                    | 结果                                           | 退出码 |
| --------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- | ------ |
| 定向单测（P1 组织隔离 + P2 分类） | `jest --runTestsByPath`：admin-user 列表/写用例 5 份 + GraphQL filter 1 份     | 6 套件 / **257 passed**                        | 0      |
| 注册审批 E2E                      | `test:e2e:file -- test/02-register/engineer-registration-approval.e2e-spec.ts` | **16 passed**                                  | 0      |
| 用户管理 E2E                      | `test:e2e:file -- test/04-user-info/admin-user-management.e2e-spec.ts`         | **33 passed**                                  | 0      |
| 类型检查                          | `npm run typecheck`                                                            | 通过                                           | 0      |
| Lint                              | `npm run lint`                                                                 | **0 error**；10 条既有复杂度告警（非本轮文件） | 0      |
| 格式                              | `npx prettier --check`（本轮改动文件）                                         | 全部符合                                       | 0      |
| 空白/冲突标记                     | `git diff --check`                                                             | 通过                                           | 0      |

说明：`admin-user-management.e2e-spec.ts` 中「管理员代建 CUSTOMER」的旧断言「不建立成员关系」与 `AdminCreateUserUsecase` 的实际绑定行为冲突，已按 S2c 口径改为断言存在 ACTIVE `CUSTOMER` 成员关系；`test/utils/test-organizations.ts` 的 `memberRole` 联合类型同步加入 `CUSTOMER`，与实体 `chk_organization_membership_role` 值域一致。

### 5.8 并发登记与部分成功回归（2026-10-30）

本轮只修测试台账与验收记录，不改业务逻辑、Entity 或 Migration。

**登记顺序**

- `registerAndRecord()` / `registerEngineerAndRecord()`：成功响应返回账号 ID 后，先按响应 ID 与本轮显式输入（登录名、邮箱、昵称、角色、注册结果）登记创建事实，再做账号/资料回读；回读只用于校准预期事实，失败不回滚登记。
- `resubmitAndRecord()`：收到成功响应后，立即按响应申请 ID 与本轮显式输入登记，然后才返回；登记不依赖后续断言或外层结果收集。
- 同文件所有真实并发场景（同凭据并发注册、同账号并发重提）统一改为 `Promise.allSettled`：先等待全部分支结束，再检查成功数量与失败原因；一方抛错不会跳过另一方的登记，也不会在其他分支结束前进入 teardown。
- 顺序重提场景直接复用 `resubmitAndRecord()`，删除原先「请求返回后再补登记」的重复记录点。
- 「两个管理员相反决策」不产生新资源 ID：申请 ID 已在创建时登记，审批可能新增的成员关系按账本账号 ID 由引用闭包回收，复核后不存在同类窗口。

**新增 3 项回归**

| 场景                   | 断言要点                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 一方成功、另一方抛错   | 成功分支的申请 ID 已在台账中；被拒绝分支的原始 `Error` 按引用保留；库内该账号只有 1 条 `PENDING` 申请（正常竞争仍只产生一份有效新申请）    |
| 双方返回后业务断言失败 | 两个成功分支的申请 ID 均已在登记后才做断言；断言异常被保留并断言为 `Error`；成功申请仍可由 `afterAll` 受保护清理回收                       |
| 注册成功、随后回读失败 | 账号在回读之前已按响应 ID 与显式输入登记；回读异常按引用保留；登记事实与库内真实行逐字段一致，清理仍走严格所有权核验，不通过放宽比对来回收 |

**定向验证（本地实际执行）**

| 检查                   | 命令 / 范围                                                                                                                                   | 结果                    | 退出码 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------ |
| 失败路径定向单测       | `jest --runTestsByPath`：admin-user 列表/写用例 5 份 + GraphQL filter 1 份                                                                    | 6 套件 / **259 passed** | 0      |
| 类型检查               | `npm run typecheck`                                                                                                                           | 通过                    | 0      |
| 变更文件 Lint          | `eslint test/02-register/engineer-registration-approval.e2e-spec.ts`                                                                          | 0 error                 | 0      |
| 格式                   | `prettier --check`（本轮改动文件）                                                                                                            | 全部符合                | 0      |
| 空白/冲突标记          | `git diff --check`                                                                                                                            | 通过                    | 0      |
| 注册审批 E2E（隔离库） | `test:e2e:file -- test/02-register/engineer-registration-approval.e2e-spec.ts`（`E2E_SKIP_DB_CLEANUP=true` + `E2E_ALLOW_PHYSICAL_CLEANUP=1`） | **19 passed**           | 0      |

**KEEP 与夹具残留（同轮 E2E）**

- 在 `lithography_e2e` 预置 6 行合成非夹具 KEEP（组织、账号、资料、成员、停用机型、第三方绑定，ID 9900001–9900006）。
- 运行前后对 **35 张表、36 行**（30 条迁移记录 + 6 行 KEEP）做确定性排序逐字段摘要，前后整体摘要一致（`0eda9cd9…`），`KEEP_COMPARE=OK`。
- 运行后按夹具指纹回读：账号 0、资料 0、组织 0、成员关系 0、工程师申请 0，`RESIDUE=0`。
- 随后精确删除 KEEP，库内只剩 30 条迁移记录、35 张表，未使用 Seed 或整表清理。

未因文档修正重跑未受影响的迁移；本轮不暂存、不 commit、不 push。

## 6. 整条分支的审计基线（fork PR 与上游阶段）

本轮审计区分两个评审阶段的两条比较基线，**分别记录基点与差异，不混用统计结果**：

- **fork PR（薛一审）**：基线 `origin/main`（`GandianTX/lithography-platform`），merge-base `795eb577f45e5ece4694dec5efa322aba1ef9a3a`。
- **原仓库阶段 PR（负责人二审）**：基线 `upstream/main`（`litho-ai-support/lithography-platform`），merge-base `cc4c87e57e328eee3893a07f3776880f56e1b226`。

本轮**未执行 `git fetch`**，上述 `origin/main` 与 `upstream/main` 均为本地引用（本地记录时间分别为 2026-10-28 16:01 与 2026-10-04 13:46）；若远端已前进，应以刷新后的 merge-base 重新计算。

### 6.1 两条基线的差异规模

**fork PR（薛一审，`origin/main`）**

- 已提交差异：**112 个文件，+17391 / −79**，**2 个提交**。
- 提交：`ec11508` 组织与维修数据增量、`30c2732` 维护夹具清理与并发收尾修复。
- 范围不含 PR #1（已包含在 `origin/main` 内），因此该统计**不包含**内容投稿/参考资料/前端适配等 PR #1 变更。

**原仓库阶段 PR（负责人二审，`upstream/main`）**

- 已提交差异：**373 个文件，+78693 / −1744**，**17 个提交（含 1 个 PR #1 合并提交 `795eb57`）**。
- 组成：PR #1 合入的 `feat/data-collection-core`（内容投稿、参考资料、前端适配、PR0 清理安全）+ `ec11508` + `30c2732`。

**工作区未提交（两条基线共同叠加，不计入上述已提交统计）**

- 51 个已跟踪修改 + 38 个新增文件（临时计划已按约定删除）；主要是本轮注册/审批实现、迁移、E2E 与文档，另有此前数据增量与测试修复的未提交部分。

仓库内 `docs/database/` 保留了 PR0 各轮过程文档（历史证据），其中部分文档数量与结论只代表各自执行时点，不能替代本轮结果。

### 6.2 fork PR 需薛一审重点审核的内容

1. **迁移与约束**：60 条前的既有迁移未改动；第 30 条申请表 CHECK（尤其 `REJECTED + review_comment NULL` 的三值逻辑修正）、生成列唯一键、3 个 RESTRICT 外键；`migration-schema-contract.ts` 的列/索引/CHECK/外键与 6 张 `*_CREATED_BY` 归属登记是否与迁移一致。
2. **单有效组织语义**：`organization_membership.active_account_id` 唯一键与客户/工程师注册、审批、代建三条路径是否一致；是否存在用 LEFT 成员关系绕过「一账号一有效组织」的路径。
3. **审批事务与并发**：四写同事务、锁序（账号→申请）、条件更新 0 行 → `CONFLICT`、审核与重提竞争；是否仍存在 TOCTOU 或第二次决策覆盖第一次。
4. **待审保护**：`login`、第三方登录、令牌复核、管理员启停、密码重置、资料修改是否有任何入口能让 `PENDING` 账号获得业务能力；`PENDING` 唯一申请是否可被并发注册绕过。
5. **身份证明边界**：本人查询/重提只用密码凭据、不签发 JWT、`CREDENTIAL_MISMATCH` 防枚举；日志是否泄漏哈希/角色摘要/组织内部信息。
6. **权限边界**：`assertEngineerRegistrationReviewPermission` 是否精确 `SUPER_ADMIN` + 可信组织；跨组织是否统一 `NOT_FOUND`；队列/详情/决策是否共用同一断言。
7. **破坏性契约变更**：`organizationId` 必填对旧客户端/第三方入口的影响；是否需要同批发布说明。
8. **第三方入口兼容**：小程序注册是否只创建 CUSTOMER、是否可能被改造为工程师绕过审批；第三方绑定与待审账号的关系。
9. **清理工具扩展**：新增申请类别是否只按账本真实 ID 删除、事实核验是否覆盖归属字段、删除顺序是否满足 RESTRICT 链；新增类别是否改变既有门禁语义。
10. **整条分支范围**：PR 是否按「组织/维修数据增量」「清理保护修复」「注册审核」分节说明，未夹带无关任务、临时配置或计划文件。

### 6.3 建议 PR 分节

1. 组织与维修数据增量（迁移 24→29、组织归属、工单/报告/上传备份）；
2. PR0 清理安全修复（账本、引用闭包、双门禁、错误聚合）；
3. 客户自助注册与工程师组织审核（第 30 条迁移、GraphQL 契约、审批闭环）；
4. 测试与验收证据、文档更新。

PR 必须明确：待审账号技术存在但不能登录；拒绝后重提保留历史；组织选择与权限区别；管理员不能跨组织；第三方入口兼容；前端注册/审核页面未交付。早期「注册接口未调整」说明只代表早期提交，不能作为整条分支结论。

## 7. 能否进入提交阶段与剩余阻塞

**结论：代码与本轮验收证据已达到可提交候选状态，但尚不能宣称可合并。** 进入提交阶段前无代码级阻塞；合并前仍有以下阻塞/待办：

| 项                               | 状态             | 说明                                                                                                                                       |
| -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 蔡自审 → 薛 PR 一审 → 负责人二审 | 未执行           | 本轮只有修复方实测；不得记为已通过                                                                                                         |
| 独立复审与 CI                    | 未执行           | 不把本地结果等同 CI/独立复审                                                                                                               |
| 24→30 增量演练                   | 未执行           | 已覆盖 30 终态与 29→30（由 30 态副本回退构造 29 态后，正式 CLI 四步验证通过，非真实历史 29 态库的完整兼容验证）；24→30 组合仍按 SOP 待演练 |
| 前端注册/审核页面                | 未交付           | 只有契约与人工验收步骤，不宣称前端功能上线                                                                                                 |
| `src/schema.graphql` 预生成      | 未执行（非阻塞） | 文件由运行时生成且被 Git 忽略；契约已由 E2E 实测                                                                                           |
| 人工截图                         | 由用户完成       | 本轮不生成                                                                                                                                 |
| 远端主线/PR 状态核对             | 未查询           | 本轮按要求不访问远端合并状态                                                                                                               |
| PR 创建/合并                     | 未执行           | 按用户要求不暂存、不 commit、不 push、不建/不合并 PR                                                                                       |

## 8. 后续事项（followup）

1. 前端注册选组织、本人申请状态、管理员审核队列/详情页面按本文第 3 节契约另行排期。
2. 24→30 增量演练与备份恢复演练在正式升级窗口前补齐。
3. 独立复审/CI 通过后，再讨论提交与 PR；PR 描述按 6.3 分节。
4. 临时计划 `backend/plans/self-registration-engineer-approval-plan.md` 与 `self-registration-review-remediation-plan.md` 的稳定内容已转入本文与正式接口/SOP 文档，计划文件在交接后删除，不纳入 PR。
