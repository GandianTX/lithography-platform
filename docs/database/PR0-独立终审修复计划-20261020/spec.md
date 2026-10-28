<!-- 文件位置：docs/database/PR0-独立终审修复计划-20261020/spec.md -->

# PR0 三项 P1 修复规格（R01/R02/R03）

日期：2026-10-20。依据：[修复与验收实施计划](./修复与验收实施计划.md)、[独立终审报告](../PR0-提交前独立终审-20261020/独立终审报告.md)。

**状态：规格待批准。本文不表示修复已完成。**

## 1. 目标与不可变边界

关闭 R02（测试清理缺行归属/引用闭包）、R03（组织与成员 Seed 碰撞覆盖）、R01（投稿锁后读旧快照），并补齐对应回归与证据。

不变：九张新表、单附件、现有权限/状态机、API 名称、Session 边界、已接受 Migration、全局隔离级别；不新增表、不加乐观版本列、不改 Entity/Migration、不做页面/OCR/共享/AI；不提交/推送/建 PR（F6 另行授权）。

## 2. 基准事实（F0，已只读确认）

| 项 | 事实 |
| --- | --- |
| 分支 | `feat/data-collection-core` |
| HEAD | `cc4c87e57e328eee3893a07f3776880f56e1b226` |
| merge-base(origin/main) | 同 HEAD |
| 工作区 | 67 modified + 66 untracked（133 条），`git diff --stat` 6,419+/677- |
| 保留物 | `.tmp-review/`（3 个 untracked）与既有回执保留，不 reset、不批量删除 |
| 实库 | 127.0.0.1:3306，`DB_NAME=lithography_e2e`，`SELECT DATABASE()` 一致；MySQL 8.0.46；`@@transaction_isolation=REPEATABLE-READ`；24 张表（非空）；白名单 `lithography_e2e` |
| 可丢弃性 | 该库为专用 E2E 隔离库（白名单唯一项），本轮可写删；不使用开发库；不打印密码/Token |
| 物理许可 | 运行时注入 `E2E_ALLOW_PHYSICAL_CLEANUP=1`，不写入代码/scripts/.env |

## 3. R02：测试清理安全

### 3.1 公开接口（`backend/test/utils/e2e-scoped-cleanup.ts`）

```ts
export interface OwnedResourceLedger {
  organizationIds: number[];
  accountIds: number[];
  membershipIds: number[];
  submissionIds: number[];
  revisionIds: number[];
  attachmentIds: number[];
  materialDetailIds: number[];
  faultCaseDetailIds: number[];
  reviewIds: number[];
  documentIds: number[];
  documentCaseDetailIds: number[];
  equipmentModelIds: number[];
}

export const createOwnedResourceLedger = (): OwnedResourceLedger;
export const recordOwnedResource = (ledger, category, id): number; // 仅接受正整数，去重

export const runGuardedSpecCleanup = async (params: {
  dataSource: DataSource;
  helper: string;
  owned?: OwnedResourceLedger;
  residue?: {
    organizations?: readonly TestOrganizationSpec[];
    accounts?: readonly ResidueAccountFingerprint[];
    equipmentModels?: readonly ResidueEquipmentModelFingerprint[];
  };
  /**
   * 仅用于成员归属核验的账号指纹：这些账号由另一守护事务（如 10 组
   * fixture cleanup）管理，本 helper 只核验其归属、不加入删除集合。
   */
  retainedAccounts?: readonly ResidueAccountFingerprint[];
}): Promise<void>;
```

`meta_digest` 为加密存储列：调用方若持有期望密文可显式传入，未提供时按“存在非空密文”校验，角色事实由 `access_group` 全量匹配保证。

删除 `organizationCodes` / `loginNames` / `loginEmails` / `extraCleanup` 入参；全部 15 个调用点同步迁移（04×6、09×2、10×2、11×5、12×2）。`runGuardedScopedCleanup` 保留为唯一门禁入口。

### 3.2 运行语义

1. 双门禁（`E2E_ALLOW_PHYSICAL_CLEANUP=1` + `SELECT DATABASE()` 白名单）先于任何查询/删除；缺一零 DELETE。
2. 空 `owned` 且无 `residue` → 纯 no-op（不开启事务）。
3. 单事务内完成：残留定位 → 根行加锁 → 归属/引用闭包预检 → 精确 ID 删除。任何冲突在第一条 DELETE 前抛出 `[helper] 阶段=归属预检 拒绝删除：<类别> <id/键> <原因>`。
4. 残留只做“候选定位”，不授予删除权：
   - 组织按 `organization_code` 以 `SELECT ... FOR UPDATE` 读取；必须逐字段匹配 `{ organizationCode, name, kind, status:'ACTIVE' }`，否则冲突。
   - 账号按 `login_name`/`login_email` 读取（`FOR UPDATE`）；必须匹配账号 `{ login_email, status, identity_hint }` 且 `base_user_info` 存在并匹配 `{ nickname: '<loginName>_nickname', email, access_group, meta_digest, user_state:'ACTIVE' }`，否则冲突。
   - 不按组织/账号自然键级联删除；残留验证通过后仅把其精确 ID 并入本轮集合。
5. 本轮图解析（全部读后立即验证父子链）：
   - `organization_membership`：按 owned org/account 命中；行必须同时属于 owned org 且 owned account，否则冲突。
   - `content_submission`：按 owned org/submitter 命中；`owner_organization_id` 与 `submitted_by_account_id` 必须均在 owned 集合，否则冲突。
   - `content_submission_revision/attachment/material_submission_detail/fault_case_submission_detail/review`：按 owned submission 命中；父投稿必须在集合内；附件的 `uploaded_by_account_id`、审核的 `reviewed_by_account_id`、版本的 `confirmed_by_account_id` 必须在 owned account 集合，否则冲突。
   - `reference_document`：按 owned org/creator/`source_submission_id` 命中；`owner_organization_id`、`created_by_account_id`、非空 `updated_by_account_id`、`source_submission_id`、`source_revision_id` 必须分别落在 owned 集合，否则冲突（覆盖“来源投稿属本规格、但资料属外部组织”的越界引用）。
   - `reference_document_case_detail`：仅按 owned document 命中。
   - `equipment_model`：只接受 ledger 精确 ID；不认固定 id=43、不按编码推断。
6. 引用闭包：对每个删除集合检查集合外入向引用，命中即冲突、零删除：
   - 账号：`organization_membership`、`content_submission`、附件上传人、版本确认人、审核人、资料创建/更新人、`repair_request.customer_account_id/accepted_by_engineer_account_id`、`ai_conversation.engineer_account_id`、`ai_report.engineer_account_id`、`engineer_response.engineer_account_id/customer_account_id`。
   - 投稿：`reference_document.source_submission_id`；版本：`reference_document.source_revision_id`；附件：`content_submission_revision.attachment_id`；资料：`reference_document_case_detail.document_id`。
   - 机型（仅 ledger 内）：两类投稿明细、`reference_document.equipment_model_id`、`repair_request.equipment_model_id` 中落在集合外的行。
7. 锁顺序：先 `organization/base_user_account/equipment_model`，再发现并锁 `content_submission/reference_document`，最后闭包校验与删除；同资源路径顺序一致。
8. 删除顺序（精确 ID）：review → case_detail → document → revision → attachment → material_detail → fault_detail → submission → membership → organization → user_info → account → equipment_model。
9. 保留 `runE2eTeardown` 的错误传播/finalize/closeApp 语义；清理失败必红，不吞错。

### 3.3 底层破坏性入口收口

- `test-organizations.ts` 删除 `cleanupTestOrganizationData` 的自然键十连删；改为非导出的精确 ID 删除步骤，仅供 `runGuardedSpecCleanup` 事务调用。
- `test-accounts.ts` 删除公开的 `cleanupTestAccountsByLoginKeys/ByLoginNames/ByIds` 自然键清理；保留 `createTestAccount/seedTestAccounts`，新增可选 `ownership` 记录真实生成 ID。
- `seedTestOrganizations` 复用既有行前核验 `{name, kind, status}`；新增可选 `ownership`，创建/复用成功后登记真实 ID。
- 不再存在可绕过双门禁的公开破坏性 helper。

### 3.4 消费者迁移

| 消费组 | beforeAll | afterAll |
| --- | --- | --- |
| 04×6 | `residue.accounts = testAccountsConfig 对应项` | `owned`（`seedTestAccounts` 登记） |
| 09 | `residue.organizations = [primary, peer]` + accounts 8 项；机型改为自增创建并 `recordOwnedResource` | `owned`（含机型、固定资料 971–974） |
| 10 | `residue.organizations = [primary]`；fixture 账号继续由既有 `cleanupAdminDocumentFixtureResidue/ByIds` 事务管理 | 同左；组织链与 fixture 分两步保持现状 |
| 11×3 / 12 | `residue.organizations + accounts` | `owned` |

09/12 移除“固定机型 id=43 即归属”的全部逻辑，并用自增 ID 创建/登记。

### 3.5 必补测试

- 更新 `backend/test/utils/e2e-scoped-cleanup.e2e-spec.ts` B 部分：新 API 调用序、门禁先于查询、空集合 no-op。
- 新增 `backend/test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts`（真实隔离库，登记 core）覆盖 C01–C09：
  - C01 缺许可/错库：注入计数代理，DELETE=0；skip 开关不可绕过。
  - C02 同登录名/邮箱异指纹：冲突、总 DELETE=0、原行逐字段不变。
  - C03 同组织编码异名/类别：冲突、零删除。
  - C04 外部 `id=43` 机型：不删；本轮机型为独立自增 ID 且仅删它。
  - C05 外部成员/资料/业务记录引用本轮父资源：预检拒绝、全部目标不变。
  - C06 后阶段冲突（如外部成员）：第一阶段的组织也未被删除。
  - C07 注入第 N 次 delete 失败：真实事务回滚、错误传播、finalize/closeApp 仍执行（用测试侧 Proxy 包装真实 DataSource，不在 src 加钩子）。
  - C08 beforeAll 中途失败：仅回收已登记 ID，未创建/异主资源不变，afterAll 真实执行。
  - C09 完整指纹残留回收；同名但异编码/异指纹行不动。
- C10（非空库连续两次、无全局 TRUNCATE、哨兵不变）在 F4 实跑留证。

## 4. R03：组织与成员 Seed 碰撞保护

### 4.1 结构

新增窄模块 `backend/scripts/seed-mock.organization-write.ts`，`seed-mock.ts` 仅调用它；模块可安全 import（无启动副作用）。

```ts
resolveSeedOrganization(manager, spec): Promise<{ id: number; mode: 'MIGRATION_BASE'|'SEED_KNOWN'|'CREATED' }>
assertSeedMembershipOwnership(manager, spec): Promise<'ABSENT'|'SAME'>
upsertSeedOrganization(manager, spec): Promise<number>
upsertSeedMembership(manager, spec): Promise<number>
```

### 4.2 规则

1. 组织：同时按 `organization_code` 与固定 id 查询并区分：
   - 迁移基础组织（如 `CLIENT_DEFAULT`）按稳定编码解析真实 id，绝不改写其主键、名称、状态；若其状态不满足试用夹具前提（非 ACTIVE），明确拒绝，不静默改权限事实。
   - 编码行与固定 id 行为同一行且编码/类别匹配 → 复用，仅允许更新白名单 Mock 展示字段。
   - 编码已在另一 id、固定 id 被异主占用、类别不匹配 → 冲突抛错、事务整体回滚（S02/S03）。
   - 都不存在 → 以固定 id 插入并校验实际写入行。
2. 成员：同时按固定 id 与 `(organization_id, account_id)` 查询：
   - 固定 id 已存在但组织/账号任一不符 → 冲突，绝不更新 FK/角色（S01）。
   - `(org,account)` 已存在于另一 id → 冲突，不通过 upsert 改另一行（S04）。
   - 匹配 → 仅更新 `member_role/status/left_at` 白名单字段。
   - 都不存在 → 以固定 id 插入并校验。
3. 归属核验发生在对应 INSERT/UPDATE 前；整个 Seed 仍在原事务内，冲突回滚本次全部 Seed 写入。
4. 不新增表、不重构其他 Seed、不把整库变成可重置区。

### 4.3 必补测试

`backend/scripts/seed-mock.organization-write.spec.ts`（无启动副作用、无实库，fake manager）覆盖 S01–S06；F04 快照契约 `seed-mock.contract.spec.ts` 保持通过。S07（非空库双跑 + 异主哨兵 + 冲突回滚）在 F4 实库留证。

## 5. R01：投稿事务当前读

### 5.1 修改

`backend/src/modules/lithography/queries/content-submission.query.service.ts`：

- `readMaterialDetailForWrite(manager: EntityManager, submissionId)`、`readFaultCaseDetailForWrite(manager, submissionId)`：事务必填，`findOne({ lock: { mode: 'pessimistic_write' } })`。
- 新增送审专用 `readCurrentAttachmentsForSubmit(manager, submissionId)`（或等价命名）：同样锁定读，禁止无事务调用。
- 普通详情/列表读取保持无锁；不得给共享 loader 全局加锁。
- 锁顺序：投稿主表（现有 guard）→ 明细/附件；锁持有到提交/回滚。
- 补丁合并语义不变：`undefined=保留`、`null=按规则清空`；草稿宽松、送审完整、历史快照不可改、仅一份 CURRENT。

`update-content-submission-draft.usecase.ts`、`submit-content-submission.usecase.ts` 及相邻草稿用例传入事务 manager，改用上述写前方法；扫描同族“主表锁后普通读”路径，仅修影响合并/附件选择/冻结事实者。

### 5.2 必补测试

- QueryService spec：断言写前方法使用传入 manager、锁模式 `pessimistic_write`；普通读取无锁（W08）。
- 确定性交错（两事务、真实组织 SELECT 建立 RR 快照、A 持主行锁、B 建快照后等待、A 提交、B 继续；记录 `@@transaction_isolation`）：
  - W01 资料标题/说明并发保存均保留；
  - W02 案例错误码/触发条件并发保存均保留；
  - W03 保存→送审冻结最新标题/正文；
  - W04 案例保存→送审冻结最新结构化字段；
  - W05 附件替换→送审冻结新 CURRENT 的真实 id；
  - W06 附件移除→送审不得复用旧附件（仅文件资料按最新双空拒绝）；
  - W07 送审成功后晚到修改/替换：状态冲突、零业务/文件写入。
- 后续真实双连接验收在 F4。

## 6. 验收与证据

- F4 实库矩阵：C01–C10、W01–W08、S01–S07、迁移空库/旧库升级、04/09/10/11/12 与 production 契约、N03-A/B/C、默认 core；`E2E_SKIP_DB_CLEANUP=true`、不设全局 TRUNCATE、碰撞哨兵库不跑 global cleanup。
- F5 门禁：后端 typecheck / capability docs / 两个 lint 脚本 / 完整 unit / build；前端 format/lint/unit/build；含 untracked 的无 fix ESLint；`git diff --check`。
- 新建 `执行回执-20261020.md`（不覆写历史），逐项记录命令、退出码、suite/test 数、skip/排除原因、未验证项；未运行项不得勾选。

## 7. 风险与回滚

- 清理 helper 语义变更会波及 15 个调用点；逐组迁移并以单文件 e2e 验证。
- 残留指纹过严会让旧残留变成显式失败；按计划“安全拒绝优先”，不自动接管。
- Seed 固定 id 冲突改为失败关闭；若正常 Seed 因历史数据失败，保留错误证据，不降级为覆盖。
- R01 仅写前路径加锁；若发现普通读被误加锁，回退该处并补 W08 断言。

## 8. 批准点

批准本规格后按 [tasks.md](./tasks.md) 执行；未获批准前不修改业务代码、不执行数据库写删。
