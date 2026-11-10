# S5 合并前阻塞审计（F1）与 P1—P5 精确改动方案

| 项         | 值                                                                     |
| ---------- | ---------------------------------------------------------------------- |
| 执行日期   | 2026-11-09（Asia/Shanghai）                                            |
| 分支       | `feat/database-v13-deploy`                                             |
| HEAD       | `72de1096d0a2aa2d62ed55a48ab49ebc3398000a`（未提交）                   |
| 工作区     | 87 项变更保留；暂存区空；3 个 stash 保留，未动                         |
| 数据库     | **未连接**：未建库、未迁移、未 seed、未查询、未写入                    |
| 迁移       | 39 个文件逐文件指纹复核一致；**未修改任何迁移**                        |
| Git 写操作 | 无 commit/push/PR；无 fetch/checkout/stash/reset                       |
| 本轮产出   | 差异清单、JSON 等价性判定、S1 过早结论修正、P1—P5 改动方案、待裁决问题 |

> 审计口径：只把**冻结输入 + 已落到仓库的代码/迁移**作为事实来源。没有实际调用方的表，只能声明“结构已创建”，不能声明“能力已实现”。

---

## 1. 冻结基线核对

### 1.1 四份 Word（只读）

| 文档                                                                  | SHA-256                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 按功能划分-功能需求文档-V5.3-提交幂等与生效修订-基于V13-20261107.docx | `b162a51d37afe7f3e1557dec3836b63bb4ff5b8df78ebb1a2c98a6ee8f6fe890` |
| 按页面划分-页面需求文档-V6.3-提交幂等与生效修订-基于V13-20261107.docx | `3756789546551d5098258914a8c6d542b818593b1b339364730300ecae429f0c` |
| 数据库表设计说明-V1.1-基于V13功能V5.3-配套页面V6.3-20261107.docx      | `c1da2ac26eb9dd33e91a58b3136cf278bdc12caad0dff19c9be0d2c396b6e0d8` |
| 一键部署数据库开发任务书-V1.0-基于功能V5.3与页面V6.3-20261107.docx    | `b335a7ba177026034f4456870d044fb1711ef13801d695db9fad7ba4c2b28fa2` |

四份与 S0 第 1.1 节冻结值一致，本轮未换版本。

### 1.2 39 条迁移逐文件指纹

- 文件数：39（`backend/src/infrastructure/database/migrations/*.migration.ts`）。
- 逐文件比对：39/39 与 [S4-39-migration-sha256.md](./S4-39-migration-sha256.md) 冻结表一致，差异数 **0**。
- 聚合（文档口径 `find ... | sort | xargs sha256sum | sha256sum`）：`8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`，与 S4 记录一致。
- 说明：上一轮交接记录里的 `47ff4128…` 无法用 S4 的任一自然口径复现，**以 S4 的 39 文件逐条 + `8827ded2…` 为准**；本轮不据此改写任何迁移。

---

## 2. F1 差异清单（五项）

判定用五种标记：`已完整实现` / `有明确依据的等价存储` / `字段或约束缺失` / `业务语义冲突` / `需用户裁决`。

### 2.0 汇总

| 编号 | 对象                                          | 判定                               | 一句话结论                                                                 |
| ---- | --------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| F1-1 | `local_company_setting`（公司备份配置）       | 字段缺失 + 需裁决                  | 只有“配置来源/是否当前”，备份计划与云开关字段全部不存在                    |
| F1-2 | `local_account_authorization`（离线账号资格） | 字段缺失 + 需裁决                  | 缺签名凭据、权限版本、最近校验时间；现有状态字段是另一种事实               |
| F1-3 | `sync_receipt`（同步版本/回执）               | 业务语义冲突 + 字段缺失            | 去重键包含 `source_system`，同一版本可被本地/云端记两次                    |
| F1-4 | `backup_asset`（备份资产）                    | 字段缺失 + 约束冲突                | 缺格式/数据版本、本地与云端引用分离、校验/保留/删除/失败原因               |
| F1-5 | `maintenance_report_fault`（报告故障）        | 业务语义冲突 + 字段缺失 + 约束缺失 | 原始八字段未落列，`status/source` 与面板原始字段同名异义，处理生命周期混行 |

关联但不在 F1 五主项：`backup_restore_run`、`record_package_import`、`record_package_item` 见 2.6。

### 2.1 F1-1 公司备份配置 `local_company_setting`

设计（Word 4.10）：`installation_id`、`organization_id`、`initialization_at`、`backup_interval_hours`、`backup_enabled`、`next_backup_at`、`last_auto_success_at`、`last_auto_failure_at`、`failure_reason`、`auto_upload_enabled`，`(installation_id, organization_id)` 唯一。

实际（[local-company-setting.entity.ts](file:///home/gandiantx/lithography-platform/backend/src/modules/lithography/entities/local-company-setting.entity.ts#L18-L50)）：

| 列                      | 实际含义                   | 设计是否有对应   |
| ----------------------- | -------------------------- | ---------------- |
| `installation_id`       | 本机标识                   | 有               |
| `organization_id`       | 公司                       | 有               |
| `setting_source`        | `LOCAL`/`CLOUD`?           | **设计无此列**   |
| `is_current`            | 是否当前生效（默认 false） | **设计无此列**   |
| `created_at/updated_at` | 时间戳                     | 有（设计未单列） |

- 缺失：`initialization_at`、`backup_interval_hours`、`backup_enabled`、`next_backup_at`、`last_auto_success_at`、`last_auto_failure_at`、`failure_reason`、`auto_upload_enabled` 全部不存在。
- 约束：迁移只有 `setting_source` 值域 CHECK（[1775501400000:57](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501400000-create-local-sync-and-package-for-v13.migration.ts#L57)）和 `uk_local_company_setting_scope`；**没有**对备份开关/间隔的 CHECK。
- 消费者：全仓库除注册与元数据测试外无调用方；`next_backup_at` 是调度器可查询事实，JSON 存储反而要应用侧过滤。
- 判定：`字段或约束缺失`；`setting_source/is_current` 是否保留属**需用户裁决**（若保留，需说明它们与“每安装每公司一条计划”的关系）。
- 落点：补 8 列 + CHECK（`backup_interval_hours > 0`、`backup_enabled=1` 时 `next_backup_at` 非空）；`setting_source/is_current` 先冻结现状、不擅自删除。

### 2.2 F1-2 离线账号资格 `local_account_authorization`

设计（Word 4.9）：`installation_id`、`account_id`、`organization_id`、`signed_claims`（受保护 JSON）、`permission_version`、`last_verified_at`、`revoked_at`；`(installation_id, account_id, organization_id)` 唯一。

实际（[local-account-authorization.entity.ts](file:///home/gandiantx/lithography-platform/backend/src/modules/lithography/entities/local-account-authorization.entity.ts#L24-L62)）：

| 列                     | 实际               | 设计       |
| ---------------------- | ------------------ | ---------- |
| `installation_id`      | 有                 | 有         |
| `account_id`           | 有                 | 有         |
| `organization_id`      | 有                 | 有         |
| `authorization_status` | `ACTIVE`/`REVOKED` | **无此列** |
| `authorized_at`        | 授权时间           | **无此列** |
| `revoked_at`           | 撤销时间           | 有         |

- 缺失：`signed_claims`（签名凭据，离线判权唯一依据）、`permission_version`（离线权限版本）、`last_verified_at`。
- 约束：`chk_local_account_authorization_status`（[1775501400000:33](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501400000-create-local-sync-and-package-for-v13.migration.ts#L33)）为 `(ACTIVE AND revoked_at IS NULL) OR (REVOKED AND revoked_at IS NOT NULL)`，存在 UNKNOWN 放行问题（见 P3）。
- 判定：`字段缺失`；`authorization_status` + `authorized_at` + `revoked_at` 是否能等价表达“离线资格”属**需用户裁决**——但缺 `signed_claims/permission_version` 时无法离线验证签名，等价性不成立。

### 2.3 F1-3 同步版本 `sync_receipt`

设计（Word 4.11）：`record_uuid`、`organization_id`、`resource_type`、`version_no`、`source_installation_id`、`manifest_checksum`、`status`、`remote_resource_id`、`received_at`；去重键 **`(organization_id, resource_type, record_uuid, version_no)`**；自动同步与 U 盘导入共用该回执。

实际（[sync-receipt.entity.ts](file:///home/gandiantx/lithography-platform/backend/src/modules/lithography/entities/sync-receipt.entity.ts#L4-L55)）：

- 唯一索引 `uk_sync_receipt_scope` = `(record_uuid, organization_id, resource_type, version_no, source_system)`（[1775501400000:76-77](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501400000-create-local-sync-and-package-for-v13.migration.ts#L76-L77)）。
- 列：`receipt_id`(char36 PK)、`source_system`、`receipt_status`、`created_at`、`confirmed_at`。
- 缺失：`source_installation_id`、`remote_resource_id`、`received_at`。
- **语义冲突**：多出的 `source_system` 进入唯一键，使同一记录同一版本可分别以 `LOCAL`、`CLOUD` 各写一行，直接违背“共用去重”；同时设计要求的安装来源列不存在，`source_system` 无法替代“哪台机器上传”。
- 状态值域：实际 `chk_sync_receipt_status` + `chk_sync_receipt_confirmed`（[1775501400000:82-90](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501400000-create-local-sync-and-package-for-v13.migration.ts#L82)）与设计 `PARTIAL/SUCCEEDED/FAILED` 是否同义，需在 P2 一并裁决。
- `receipt_id char(36)` 主键 vs 设计 `id bigint` 属**有明确依据的等价存储**（`record_package_item.receipt_id` 同类型 FK），但需在字段字典中显式写明，不能默认隐式等价。
- 判定：`业务语义冲突`（去重键）+ `字段缺失`。

### 2.4 F1-4 备份资产 `backup_asset`

设计（Word 4.15）：`backup_id`、`run_id`、`installation_id`、`organization_id`、`format_version`、`data_version`、`byte_size`、`manifest_checksum`、`local_reference`、`cloud_reference`、`local_status`、`cloud_status`、`cloud_receipt`、`encryption_key_id`、`verified_at`、`retention_until`、`failure_reason`、`attempt_count`、`deleted_at`、`local_cleanup_run_id`、`local_cleanup_error`。

实际（[backup-asset.entity.ts](file:///home/gandiantx/lithography-platform/backend/src/modules/lithography/entities/backup-asset.entity.ts#L21-L78)）：

| 实际列                          | 设计对应                                   |
| ------------------------------- | ------------------------------------------ |
| `backup_id`                     | `backup_id`                                |
| `run_id`                        | `run_id`                                   |
| `organization_id`               | `organization_id`                          |
| `local_cleanup_run_id`          | 有                                         |
| `storage_reference`             | **只覆盖 cloud_reference**，没有本地引用   |
| `file_sha256`                   | 未命名为 `manifest_checksum`（语义需确认） |
| `byte_size`                     | 有                                         |
| `cloud_status/local_status`     | 有                                         |
| `cloud_receipt`                 | 有                                         |
| `attempt_count/last_attempt_at` | 有（设计只有 attempt_count）               |
| `created_at/updated_at`         | 时间戳                                     |

- 缺失：`installation_id`、`format_version`、`data_version`、`local_reference`、`encryption_key_id`、`verified_at`、`retention_until`、`failure_reason`、`deleted_at`、`local_cleanup_error`。
- 约束：CHECK 只覆盖 sha 长度、size≥0、状态值域、`cloud_status='SUCCEEDED' ⇒ cloud_receipt` 非空、attempts≥0（[1775501500000:31-40](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501500000-create-backup-and-audit-for-v13.migration.ts#L31)）；**没有**格式/数据版本一致性、保留期、删除态约束。
- 关联冲突：`backup_restore_run.protection_backup_id` 为 **NOT NULL**（[1775501500000:69](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501500000-create-backup-and-audit-for-v13.migration.ts#L69) 邻近定义），设计要求“执行前必有保护备份”，即预检阶段该值可以为空；NOT NULL 使“预检通过后才写入保护备份”的阶段无法落库。
- 判定：`字段缺失` + `约束冲突`；`storage_reference` 是否拆分为本地/云端属**需用户裁决**（拆分更接近设计，合并则无法表达“本地已清理、云端仍在”）。

### 2.5 F1-5 报告故障 `maintenance_report_fault`

设计（Word 4.5）：`report_id`、`fault_uuid`、`branch_kind`、`step_code`、`main_error`、`unit_error`、`source`、`error_type`、`gpib_status`、`description`、`action`、`status`、`phase_code`；`report_id + step_code` 唯一；原始面板数据与处理生命周期分开。

实际（[maintenance-report-fault.entity.ts](file:///home/gandiantx/lithography-platform/backend/src/modules/lithography/entities/maintenance-report-fault.entity.ts#L17-L57)）：

- 列：`report_id`、`fault_uuid`、`branch_kind`、`step_code`、`panel_snapshot`(longtext, 可空)、`fault_description`、`fault_cause`、`handling_action`、`status`、`source`、`created_at`。
- 缺失：`main_error`、`unit_error`、`error_type`、`gpib_status`、`phase_code`、`is_active`（若冻结版含该列）。
- **语义冲突**：`status` 在表中是处理生命周期（`OPEN/IN_PROGRESS/RESOLVED`，[实体 L50-55 附近](file:///home/gandiantx/lithography-platform/backend/src/modules/lithography/entities/maintenance-report-fault.entity.ts#L50-L55)），而设计同名 `status` 是面板原始字段；`source` 表中是 `USER/ADMIN/SYSTEM`，设计同名 `source` 是 OEM/操作员来源。**同名异义**导致原始数据与处理生命周期互相替代，正是必须禁止的用法。
- 约束缺失：只有 `uk_maintenance_report_fault_uuid` 与 `idx(report_id, branch_kind)`（[实体 L4-L5](file:///home/gandiantx/lithography-platform/backend/src/modules/lithography/entities/maintenance-report-fault.entity.ts#L4-L5)）；**没有** `UNIQUE(report_id, step_code)`；`panel_snapshot` 是 `longtext`，无 `JSON_VALID`、无 `schema_version`、键名未冻结。
- 判定：`业务语义冲突` + `字段缺失` + `约束缺失`。
- 落点（**需用户裁决**）：A) 原始八字段落列、处理生命周期另表/另列；B) 冻结 `panel_snapshot` JSON schema（`schema_version` + 八个必填键 + 类型），并补 `JSON_VALID`/版本域 CHECK，且把处理生命周期移出同名 `status/source`。B 只有在 A 不可行时才成立，且必须同时提供读写方（当前不存在）。

### 2.5.1 补充：`repair_request_revision.previous_version`（第 43/44 条关闭）

- 设计（Word 4.7）：`previous_version int unsigned`，**非空**，用途“比较的上一版本”。
- 42 态实际：Entity、迁移、结构契约均无该列；字段字典却标记“S2 结构已实现”。按本审计“等价必须显式写明、不能默认隐式等价”的标准，判定为 `字段缺失`。
- 等价性：`revision_no - 1`、`current_revision_no`、快照 JSON、`created_at` 均只能在“修订号从 1 严格连续且每行基于写入前当前版本”的应用不变量下推导；数据库未约束连续性，故不构成完整等价。
- 处理（2026-11-09，第 43 条）：追加 `previous_version int unsigned NULL`，CHECK `previous_version IS NULL OR previous_version < revision_no`；不回填、不设置默认版本。`NULL`=历史未知，`0`=首版，其他值=锁定并核验后的 `current_revision_no`。
- 处理（2026-11-10，第 44 条，已获批准）：最终列收紧为 **NOT NULL、无默认值**；在任何 ALTER 前校验 NULL 与 `previous_version >= revision_no`，违规失败关闭（脱敏计数 + 有限定位 ID），不回填、不删除；`down` 只回退可空性。字段字典 §4.7 与契约 §3.3 已同步为已批准裁决。
- 剩余：R029/R030 写入接口与读取审计仍未实现，属功能缺口；结构缺口由第 43/44 条关闭（待实库验证）。

### 2.6 关联对象（不改变 F1 五主项判定，但影响结构冻结）

| 对象                    | 设计要点                                                               | 实际                                                                        | 判定                |
| ----------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------- |
| `record_package_import` | `format_version`、`manifest(json)`、`check_status`、`import_status`    | 缺 `format_version`；`manifest_json` 无版本列（JSON 内含 `schema_version`） | 字段缺失            |
| `record_package_item`   | 分开 `check_result` / `import_result`                                  | `check_result` 已由第 39 条补；导入结果列名为 `result`                      | 等价存储（需注明）  |
| `sync_conflict`         | `data_version`、`local_snapshot/cloud_snapshot`、`decision`            | 字段齐全；`data_version` 在 JSON 内还是列需核对                             | 待实库结构核对      |
| `backup_restore_run`    | `target_installation_id`、`check_status`、`confirmation`、保护备份可空 | 缺前三者；保护备份 NOT NULL                                                 | 字段缺失 + 约束冲突 |

---

## 3. JSON 等价存储判定

“等价”必须同时满足四项：字段结构冻结、版本可校验、约束可执行、消费者可无损读写。逐项：

| JSON 位置                                           | 结构冻结                 | 版本校验                                                              | 约束                           | 消费者 | 结论                               |
| --------------------------------------------------- | ------------------------ | --------------------------------------------------------------------- | ------------------------------ | ------ | ---------------------------------- |
| `maintenance_report_fault.panel_snapshot`           | 否（longtext 无 schema） | 无                                                                    | 无 `JSON_VALID`/无版本域 CHECK | 无     | **不等价**                         |
| `reference_document_revision.before/after_snapshot` | 部分                     | 第 38 条已加 `JSON_VALID` + `schema_version` 非空，但**无版本取值域** | `schema_version` 存在性        | 无     | **未闭环**：结构可承载，语义未证明 |
| `sync_conflict.local/cloud_snapshot`                | 部分                     | 同上                                                                  | 同上                           | 无     | **未闭环**                         |
| `backup_restore_run.check_snapshot`                 | 部分                     | 同上（`chk_backup_restore_run_schema`）                               | 同上                           | 无     | **未闭环**                         |
| `record_package_import.manifest_json`               | 部分                     | `JSON_VALID` + manifest 内 `schema_version`                           | 缺 `format_version` 列         | 无     | **不等价**（包格式版本不可查询）   |
| `backup_asset.cloud_receipt`                        | 设计本就是 text          | 不适用                                                                | 无                             | 无     | 等价（自由文本）                   |

结论：**当前没有任何一处 JSON 能通过“无损等价”四项**。第 38 条把“有 `schema_version`”补上了，但“未知版本必须被拒绝”需要读写双方校验；在没有消费者的情况下，只能声明“结构可承载”，不能声明“等价实现”。若 P1—P5 选择 JSON 方案，必须同时交付：冻结 schema 文档、DB 侧 `JSON_VALID` + 版本域 CHECK、读写侧版本校验与拒绝路径、以及至少一个真实消费者测试。

---

## 4. 修正 S1 的过早结论

[S1-object-and-field-dictionary.md](./S1-object-and-field-dictionary.md) 中下列表的状态列原写“S2 结构已实现（待实库验证）”，按本审计改判：

| 表                            | 原结论     | 修正后                                                 |
| ----------------------------- | ---------- | ------------------------------------------------------ |
| `local_company_setting`       | 结构已实现 | 结构已创建；备份计划/云开关字段缺失                    |
| `local_account_authorization` | 结构已实现 | 结构已创建；签名凭据/权限版本/最近校验缺失             |
| `sync_receipt`                | 结构已实现 | 结构已创建；去重键语义冲突、三列缺失                   |
| `backup_asset`                | 结构已实现 | 结构已创建；版本/引用/校验/保留/删除字段缺失           |
| `maintenance_report_fault`    | 结构已实现 | 结构已创建；原始八字段未落列、状态语义冲突             |
| `backup_restore_run`          | 结构已实现 | 结构已创建；目标/预检/确认缺失、保护备份 NOT NULL 冲突 |
| `record_package_import`       | 结构已实现 | 结构已创建；`format_version` 缺失                      |

已在上述 7 个小节标题下加 P0 修正注记，并指向本文件；未改表内逐行内容，避免制造“已重新验收”的错觉。

---

## 5. P1—P5 精确改动方案（仅方案，未实施）

### P1 管理员初始化真实可用性（F3）

**现状（证据）**

- [admin-bootstrap.ts:234-259](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/admin-bootstrap.ts#L234-L259) 用裸 SQL 写 `base_user_account`（`identity_hint='SUPER_ADMIN'`、`admin_level`、`must_change_password`）与 `base_user_info`（`access_group='["guest"]'`），**不写 `meta_digest`**。
- 角色收敛要求三源同为一个合法单元素角色（[account-role-convergence.policy.ts:93-136](file:///home/gandiantx/lithography-platform/backend/src/core/account/policy/account-role-convergence.policy.ts#L93-L136)）；`guest` 不在 `IdentityTypeEnum` → 收敛失败（`ACCESS_GROUP_ROLE_INVALID`），缺失摘要 → `META_DIGEST_MISSING`。
- 会话复核用多角色集合校验，`guest` 同样非法 → 受保护请求/管理员列表失败关闭。
- 裸 SQL 还绕过了 `FieldEncryptionSubscriber`：`meta_digest` 是加密列，明文写入后读取侧解密失败（[admin-create-user.usecase.ts:196-201](file:///home/gandiantx/lithography-platform/backend/src/usecases/account/admin-create-user.usecase.ts#L196-L201)）。
- 测试把错误行为固化了：[admin-bootstrap.realdb.spec.ts:953](file:///home/gandiantx/lithography-platform/backend/src/modules/account/base/services/admin-bootstrap.realdb.spec.ts#L953) 断言 `access_group == ['guest']`。
- 组织归属：未写 `organization_membership`；设计规定管理员可信范围由成员关系提供。成员角色 CHECK 已允许 `SUPER_ADMIN`（[1775301100000:23](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775301100000-create-organization-membership-table.migration.ts#L23)），且 `uk_organization_membership_active_account` 限定每人一条 `ACTIVE`。

**最小修复（复用现有分层，不新造角色机制）**

1. 停止裸 SQL 写角色事实。改为复用 `AccountService.insertAccount`（[:181](file:///home/gandiantx/lithography-platform/backend/src/modules/account/base/services/account.service.ts#L181)）与 `insertUserInfo`（[:409](file:///home/gandiantx/lithography-platform/backend/src/modules/account/base/services/account.service.ts#L409)），由订阅器加密 `meta_digest`；`access_group = meta_digest = ["SUPER_ADMIN"]`，与 `identity_hint` 一致。
2. 同事务写 `organization_membership`：`member_role='SUPER_ADMIN'`、`status='ACTIVE'`、`joined_at`、`left_at=NULL`、`active_account_id=accountId`；组织取部署配置给出的甲方公司（1 级）或受管公司（2 级），不自行重定义规则。
3. 首次初始化才设初始密码与 `must_change_password=1`；重跑仅补齐缺失的角色/成员事实，**不重置密码、不覆盖 `login_name/login_email` 冲突**。
4. 已存在账号：先跑 `convergeAccountRole` + 成员关系检查；不通过则返回显式错误（非 0 退出）并给出账号 ID 与失败原因，**不得返回 `UNCHANGED`**；受控修复需独立开关（如 `--repair-role-facts`），默认关闭。
5. 冲突（登录名/邮箱已被他人占用）在事务内抛错并整体回滚，输出可定位信息。

**验收（新增/修改）**

- 改 `admin-bootstrap.realdb.spec.ts:953` 断言为真实角色事实，并增加：初始化后 `convergeAccountRole` 通过；真实登录；首次改密；改密后受限会话；受保护 Query 成功；合法管理操作成功；无权操作拒绝；重跑 0 变更且密码不变；冲突整体回滚。
- 门禁：`npm run typecheck`、文件级 ESLint、Prettier、目标 Jest；实库部分需单独授权后执行。

### P2 旧数据兼容与升级顺序（F2）

**现状（证据）**

- 第 32 条起对既有表加 CHECK，但没有数据预检：
  - `chk_maintenance_report_ai_helpfulness` 收紧为 1—4（[1775501100000:278-281](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L278-L281)）；旧约束为 1—5（同文件 down 段 [:104-105](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L104-L105)）。
  - `chk_repair_request_closure_reason`（[:193-197](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L193-L197)）要求 `INTERRUPTED/UNREPAIRABLE` 有非空原因，而 31 态没有 `closure_reason` 列 → 任何历史此类行都会让 `ADD CONSTRAINT` 失败。
  - `chk_maintenance_report_status_consistency`（[:271-277](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L271-L277)）要求 `RETURNED/APPROVED` 必有 `last_reviewed_at`，历史行可能缺失。
  - `chk_ai_conversation_completion` 收紧为 `ACTIVE ⇒ ai_feedback IS NULL`（[:214-217](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L214-L217)），历史 `ACTIVE` 带反馈的行会被拒。
- 应用侧仍接受 1—5（`AI_RATING_MAX=5`，[maintenance-report.input.normalize.ts:48](file:///home/gandiantx/lithography-platform/backend/src/usecases/maintenance-report/maintenance-report.input.normalize.ts#L48)），单测还以 5 为通过样例（`maintenance-report-usecases.spec.ts:301`）→ 应用写 5、DB 拒 5。
- 第 32 条对历史资料做三处**推断回填**（[1775501100000:322-342](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L322-L342)）：`publication_status`、`ownership_status`、`source_kind='MATERIAL'`。前两者可由 `deprecated/deleted_at`、`owner_organization_id` 证明；`source_kind='MATERIAL'` 是分类推断，需明确认可或改为“旧行留空 + 约束分流”。
- 第 31、38、39 条已有预检；**第 32—37 条没有**。

**方案（须先裁决迁移纪律）**

1. 历史兼容分流（优先）：
   - `closure_reason`：把新要求限定到新流程行，历史行由可证明判别器豁免（候选：`current_revision_no = 0` 或 `intake_id IS NULL`；两者都需业务确认）。
   - `ai_helpfulness`：把 CHECK 放宽为 1—5 保留历史，新写入在应用层收紧为 1—4（或反之，由用户裁决语义）。**不静默改 5→4**。
   - `status_consistency` / `ai_conversation_completion`：先跑预检，列出违规 ID；按可证明字段分流历史行，无法证明的列为待裁决，不猜值。
2. 若必须改第 32 条（已在该验证库执行）：
   - 先申请维护者明确批准；
   - 给出验证库处置方案（重建验证库或记录“该迁移已执行旧版本”的处置）与 39 文件指纹更新方案；
   - 未批准前不改写、不回填、不绕过预检。
3. 旧公开写入：逐入口冻结策略（保留兼容 / 最小适配 / 受控停止新写入）。已知：旧审核发布写 `MATERIAL`（保留，上一轮已最小适配）；`ai_helpfulness` 应用入口需同步收紧；旧 alarm 八槽位不新增双写。
4. 测试：合成 31 态样本（`INTERRUPTED/UNREPAIRABLE` 无原因、`ai_helpfulness=5`、`RETURNED` 无 `last_reviewed_at`、`ACTIVE` 有反馈），走完整 31→39 升级，而不是只测终态 INSERT；同时验证旧公开写入入口。

### P3 结单 NULL 安全约束（F5）

**现状**：`chk_repair_request_closure`（[1775501100000:188-192](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L188-L192)）由三个 `OR` 分支组成。MySQL 的 CHECK 只在结果为 **FALSE** 时拒绝，`UNKNOWN` 放行，因此：

| 输入                          | 三值逻辑结果 | 现状             | 目标           |
| ----------------------------- | ------------ | ---------------- | -------------- |
| `status=NULL, closed_at=NULL` | TRUE         | 放行             | 按历史兼容裁决 |
| `status=NULL, closed_at≠NULL` | UNKNOWN      | **放行（缺陷）** | 拒绝           |
| `status='OPEN', time=NULL`    | TRUE         | 放行             | 放行           |
| `status='OPEN', time≠NULL`    | FALSE        | 拒绝             | 拒绝           |
| `status='CLOSED', time≠NULL`  | TRUE         | 放行             | 放行           |
| `status='CLOSED', time=NULL`  | FALSE        | 拒绝             | 拒绝           |
| 非法状态任意时间              | UNKNOWN      | **可能放行**     | 拒绝           |

同类缺陷：`chk_local_account_authorization_status`（[1775501400000:33](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501400000-create-local-sync-and-package-for-v13.migration.ts#L33)）、`chk_organization_membership_period`（[1775301100000:25-29](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775301100000-create-organization-membership-table.migration.ts#L25-L29)）。

**修复**：改为 `CASE ... ELSE FALSE` 形式，保证任何非法组合都返回 FALSE，不依赖 UNKNOWN：

```sql
CASE
  WHEN closure_status IS NULL THEN closed_at IS NULL
  WHEN closure_status = 'OPEN' THEN closed_at IS NULL
  WHEN closure_status = 'CLOSED' THEN closed_at IS NOT NULL
  ELSE FALSE
END
```

- 双 NULL 是否放行由用户裁决（历史兼容 vs 拒绝）。
- 同步改 Entity 的 CHECK 注释表达式（[repair-request.entity.ts:101 附近](file:///home/gandiantx/lithography-platform/backend/src/modules/lithography/entities/repair-request.entity.ts#L101)）、结构契约与测试（真假值矩阵 + 实库插入）。
- 迁移方式沿用 P2 批准后的纪律；先用真实 MySQL 复现 UNKNOWN 放行，再落修复。

### P4 专用清理引用闭包（F4）

**现状**：`assertNoExternalInboundReferences`（[repair-request-fixture.ts:686-896](file:///home/gandiantx/lithography-platform/backend/test/06-repair-request/repair-request-fixture.ts#L686-L896)）覆盖既有账号/成员/组织/型号/请求引用；删除核心在 [:1234-1254](file:///home/gandiantx/lithography-platform/backend/test/06-repair-request/repair-request-fixture.ts#L1234-L1254) 前完成预检，两个入口（`ByIds`、`Residue`）共用。

**缺口（新增模型未进入闭包）**

| 表                         | 入向列                                                                                                                                | 说明                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `repair_request_intake`    | `customer_account_id`、`customer_organization_id`、`service_organization_id`、`equipment_model_id`、`converted_request_id`、`file_id` | 工单入向                               |
| `intake_analysis_attempt`  | `intake_id`                                                                                                                           | 间接经 intake                          |
| `repair_process_entry`     | `request_id`、`author_account_id`、`file_id`                                                                                          | 过程记录                               |
| `repair_request_revision`  | `request_id`、`actor_account_id`                                                                                                      | 修订                                   |
| `stored_file`（多态）      | `uploaded_by_account_id`、`owner_organization_id`、`business_id`（`business_type` 过滤）                                              | 无 FK，必须显式按多态键检查            |
| `maintenance_report_fault` | `report_id`                                                                                                                           | 经报告间接；报告若被夹具创建需一并检查 |

**改动**

1. 在两个入口同连接同事务、首次 UPDATE/DELETE 前，扩展目标/许可/所有权/引用预检；账本外引用一律拒绝，不接管、不扩大删除范围。
2. `Residue` 删除顺序补：`intake_analysis_attempt` → `repair_request_intake` → `repair_process_entry` → `repair_request_revision` → `maintenance_report_fault`（仅夹具所属报告）→ 既有序列。
3. 两入口分别验证：零 DELETE（无账本时）；目标与外部记录不变；合法清理；重复执行；后序失败整批回滚。
4. 定向跑 read / accept / production-input / ownership 四组消费者规格。

### P5 结构验证与统一交付文档

**现状（证据）**：结构校验只查“名字存在”：

| 检查  | 位置                                                                                                                                                               | 实际能力              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| 索引  | [migration-schema-contract.ts:3115-3136](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migration-schema-contract.ts#L3115-L3136) | 只比索引名            |
| 列    | [:3142-3195](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migration-schema-contract.ts#L3142-L3195)                             | 只比列存在 + 可空性   |
| CHECK | [:3200-3223](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migration-schema-contract.ts#L3200-L3223)                             | 只比约束名            |
| FK    | [:3228-3251](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migration-schema-contract.ts#L3228-L3251)                             | 只比约束名 + 被引用表 |

**改动**

1. 契约结构扩展为可声明：列类型/长度/无符号/NULL/默认值/生成列表达式；索引唯一性与列序；FK 本地列序、目标列序、`ON DELETE/UPDATE`；CHECK 定义。
2. 校验查询用 `information_schema.COLUMNS`（`COLUMN_TYPE`、`IS_NULLABLE`、`COLUMN_DEFAULT`、`EXTRA`、`GENERATION_EXPRESSION`）、`STATISTICS`（`NON_UNIQUE`、`SEQ_IN_INDEX`）、`REFERENTIAL_CONSTRAINTS` + `KEY_COLUMN_USAGE`、`CHECK_CONSTRAINTS`（`CHECK_CLAUSE`）。
3. 表达式规范化：去反引号、折叠空白、统一字面量大小写与括号冗余；规范化器要有独立单测样例（避免把 MySQL 自动重写当成漂移，也避免掩盖真实差异）。
4. SOP 统一（写回 `docs/database/` 稳定入口，不只留 plans）：
   - 自动建库：正式 `init`/`upgrade` 不建库；只有空库验证工具会 `CREATE DATABASE`（[verify-empty-db-migrations.ts:480](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/verify-empty-db-migrations.ts#L480)）。
   - 支持起点：空库；任一**连续历史前缀**（[incremental-migration.ts:406-450](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/incremental-migration.ts#L406-L450)）；不支持“有表无历史、历史缺口/乱序、未知记录”。
   - 部分 DDL 失败：MySQL DDL 隐式提交，失败迁移不会记入历史，库处于半迁移；文档给出诊断步骤、人工恢复边界与“可续跑”的条件。
   - 明确不承诺尚未实现的自动恢复。

---

## 6. 待用户裁决（阻塞结构冻结）

| 编号 | 问题                                                                                                                      | 默认建议                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Q1   | `local_company_setting` 是否按设计补 8 列？`setting_source/is_current` 保留还是冻结后删除？                               | 补列，保留旧列不删                        |
| Q2   | `local_account_authorization` 是否补 `signed_claims/permission_version/last_verified_at`？现有状态列是否定义成离线资格？  | 补三列，状态列只作撤销事实                |
| Q3   | `sync_receipt` 去重键是否去掉 `source_system`（改为设计四列永久唯一）？                                                   | 去掉，`source_system` 降为描述列          |
| Q4   | `backup_asset` 是否补 10 列并把 `storage_reference` 拆为本地/云端？`protection_backup_id` 是否改可空？                    | 补列、拆分、改可空                        |
| Q5   | 报告故障：原始八字段落列，还是冻结 JSON schema？处理生命周期是否另列/另表？                                               | 落列（JSON 方案需同时交付读写与版本拒绝） |
| Q6   | 管理员 1/2 级组织归属是否按冻结设计（甲方公司/各受管公司）？                                                              | 按设计，不新增规则                        |
| Q7   | P2 历史判别器用 `current_revision_no=0` 还是 `intake_id IS NULL`？`ai_helpfulness` 是否放宽到 1—5、新写入应用层收紧 1—4？ | 放宽 CHECK + 应用层收紧                   |
| Q8   | 是否批准调整已在验证库执行的第 32 条（含验证库处置与指纹更新）？                                                          | 暂不批，先用分流方案评估                  |
| Q9   | 结单双 NULL 是否保留为历史兼容？                                                                                          | 保留，其余非法组合一律 FALSE              |
| Q10  | 结构比对允许哪些 MySQL 规范化差异？                                                                                       | 反引号/空白/大小写，其余按漂移报错        |

### 6.1 已裁决（2026-11-09）

| 编号           | 裁决                 | 对方案的直接影响                                                                                                                                                                                                         |
| -------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q3             | 去掉 `source_system` | 唯一键改为设计四列。第 33 条已在验证库执行且未获修改批准，因此落到**新增迁移**：`DROP` 旧唯一键 → `ADD` 四列唯一键；该表是本增量新建表、验证库 0 行，收紧不会撞历史。`source_system` 保留为描述列。                      |
| Q5             | 原始字段落列         | `maintenance_report_fault` 增原始八字段与 `phase_code` 独立列；处理生命周期从同名 `status/source` 拆到独立列/表。因无消费者，允许在新增迁移中给生命周期列改名（最终列名实施前确认）。`panel_snapshot` 不再作为等价替代。 |
| Q7（评分部分） | 放宽 CHECK 到 1—5    | 新增迁移把第 32 条的 1—4 放宽为 1—5；应用层 `AI_RATING_MAX` 收紧为 4 约束新写入，历史 5 保留可读。**不改第 32 条**。                                                                                                     |
| Q8             | 暂不批准修改第 32 条 | P2 先产出“旧态样本违规证据”：若 31 态样本确实存在 `INTERRUPTED/UNREPAIRABLE` 无原因或 `status_consistency` 违规，第 32 条仍是唯一挡点，必须回到本表申请修改；若无违规，用新增迁移与应用层策略处理。                      |

仍待裁决：Q1、Q2、Q4、Q6、Q7 的**历史判别器**、Q9、Q10。结构修复范围在剩余裁决完成前不冻结。

---

## 7. 本轮未执行

- 未连库：P3 的 UNKNOWN 实测、P2 的旧态样本升级、P1 的真实登录链路均未运行。
- 未改任何迁移/Entity/业务代码/测试。
- 未 commit / push / PR；未动 stash；未运行 build/lint/typecheck/单测。
- 下一步：Q3/Q5/Q7（评分）/Q8 已裁决并记录于 6.1；剩余 Q1、Q2、Q4、Q6、Q7（判别器）、Q9、Q10 裁决后再冻结结构范围并按 P1→P5 实施。实库、隔离服务与故障注入需另行授权。

---

## 8. 第三十二轮：S5 剩余裁决落实与第 32 条挡点验证准备（2026-11-09）

> §6 与 §6.1 原样保留为历史裁决记录。本节记录本轮新增裁决与落实结论；如有冲突，以本节为准。
>
> 本轮未改产品代码、Entity 或第 1—39 条迁移；未连库、未建库、未迁移、未造数、未启动服务、未操作 Redis；未暂存、未 commit、未 push。

### 8.1 裁决落实

| 编号 | 本轮裁决（要点）                                                             | 落实结论                                                                                                        | 落点           |
| ---- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------- |
| Q1   | 按冻结设计补齐公司备份配置字段；`setting_source/is_current` 保留兼容         | 补 8 列；两旧列仅作兼容描述，不承担备份计划、自动上传或唯一性语义；不新增配置版本表                             | §8.2.1         |
| Q2   | 补 `signed_claims/permission_version/last_verified_at`；状态列只表示授权事实 | 补三列；**三值同空或同满**，历史行允许三空，不用默认值编造签名；签名算法与执行器不在本轮实现                    | §8.2.2         |
| Q4   | 补齐备份资产信息；本地/云端引用独立；`protection_backup_id` 分阶段           | 补 12 列；保留 `storage_reference` 兼容且不推断为云端；恢复运行按状态枚举表达“预检可空、执行必填”               | §8.2.4、§8.2.5 |
| Q6   | 1 级归甲方、2 级归受管公司；权限=等级+可信归属                               | 无 DDL；判定必须读 `organization_membership` 的 ACTIVE 可信归属，不以资料公司字段单独授权；不新增角色           | §8.5.4         |
| Q7   | 不批准 `current_revision_no=0` / `intake_id IS NULL` 作为历史判据            | 本节只列三种可持久区分方案的取舍，不选型、不实施；升级前必须先冻结真实历史 ID 集合                              | §8.3           |
| Q9   | 结单双 NULL 保留兼容；两种单边 NULL 必须拒绝                                 | 用 `CASE ... ELSE FALSE` 重建约束；旧 `(NULL, 非空)` 行若存在则失败关闭、不自动修正；新流程规则另行说明         | §8.2.7         |
| Q10  | 只允许有证据的无语义规范化                                                   | 白名单仅反引号、空白、经词法证明的关键字大小写；禁改字符串字面量、JSON 路径、括号与优先级；保留原始与规范化结果 | §8.1.1         |

继续保留：Q3（四列唯一键，`source_system` 仅描述）、Q5（原始八字段与 `phase_code` 落列）、Q7 评分（库 1—5、应用层 1—4）、Q8（暂不批准修改第 32 条）。

#### 8.1.1 Q10 结构比对规范化白名单

允许（必须能给出证据）：

1. 去除标识符反引号，但仅当词法分析确认该 token 是标识符而非字符串内容。
2. 折叠字符串字面量之外的空白；保留字面量内部空白。
3. MySQL 自动生成的约束名差异、列/索引顺序差异不记为漂移。
4. 仅当词法分析确认 token 是关键字（如 `and` 与 `AND`）时，才做大小写归一。

禁止：

1. 全局字符串字面量大小写归一（例如把 `'Open'` 改成 `'OPEN'`）。
2. JSON 路径任意改写（`$.a` 与 `$.A` 不等价）。
3. 无语法树依据删除括号。
4. 调整运算优先级或结合性。

输出必须同时保留 `raw_expression` 与 `normalized_expression`；差异诊断展示原始表达式，不以规范化结果替代证据。

### 8.2 逐表结构变更清单

约定：

- 变更全部落在**新增迁移**，候选编号 `1775501800000`（第 40 条，F1 结构与约束）与 `1775501900000`（第 41 条，结单与历史身份）。**本轮不创建迁移文件**。
- 第 1—39 条逐文件指纹必须保持不变；本清单不涉及修改已执行迁移。
- “旧行”指在该表已有行的升级场景。V13 新表在验证库通常为 0 行；无证据时**失败关闭**，不编造默认业务事实。

#### 8.2.1 `local_company_setting`（Q1）

现有（第 36 条，[1775501400000:41-60](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501400000-create-local-sync-and-package-for-v13.migration.ts#L41-L60)）：`id bigint AI PK`、`installation_id char(36) NOT NULL`、`organization_id int NOT NULL`、`setting_source varchar(24) NOT NULL`、`is_current tinyint(1) NOT NULL DEFAULT 0`、`created_at/updated_at timestamp(3) NOT NULL`；`uk_local_company_setting_scope(installation_id, organization_id)`；两个 FK RESTRICT；两个枚举 CHECK。

| 目标列                  | 精确规格                                                        | 旧数据处理                                                                                                         |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `initialized_at`        | `timestamp(3) NOT NULL`（S1 4.10 名称，非 `initialization_at`） | 先加可空列，按 `created_at` 回填（行创建即首次初始化，可证明），再改 NOT NULL                                      |
| `backup_interval_hours` | `smallint unsigned NOT NULL DEFAULT 72`                         | 设计固定默认 72，直接回填                                                                                          |
| `backup_enabled`        | `boolean NOT NULL DEFAULT TRUE`                                 | 设计固定默认 TRUE                                                                                                  |
| `next_backup_at`        | `timestamp(3) NULL DEFAULT NULL`（S5 定稿）                     | 先加可空列；历史行不派生（`backup_enabled=FALSE`、`next_backup_at=NULL`），新行由应用层写入非空值；见 Q11 推荐方案 |
| `last_auto_success_at`  | `timestamp(3) NULL DEFAULT NULL`                                | 保持 NULL（无历史成功事实）                                                                                        |
| `last_auto_failure_at`  | `timestamp(3) NULL DEFAULT NULL`                                | 保持 NULL（无历史失败事实）                                                                                        |
| `failure_reason`        | `text NULL DEFAULT NULL`                                        | 保持 NULL                                                                                                          |
| `auto_upload_enabled`   | `boolean NOT NULL DEFAULT FALSE`                                | 设计默认 FALSE，不上云                                                                                             |

新增约束：`chk_local_company_setting_backup_interval CHECK (backup_interval_hours > 0)`（0 小时周期无业务意义）。保留 `setting_source`、`is_current` 及其枚举 CHECK；不新增“同机唯一 current”约束（设计未要求，且兼容列不承担该语义）。

- 迁移顺序：`ADD COLUMN`（可空）→ 两条 `UPDATE` 回填 → `MODIFY ... NOT NULL` → `ADD CONSTRAINT`；全部置于第 40 条，位于 `local_installation`/`organization` 之后。
- 消费者影响：现有源码无读写方；Entity 需随后续实施补列（本轮不改）。`setting_source/is_current` 读取方保持兼容。
- 验收场景：空表升级后插入完整行成功；`backup_interval_hours=0` 被拒；`next_backup_at` 允许 NULL（数据库不强制，由应用层对新流程保障非空）。

#### 8.2.2 `local_account_authorization`（Q2）

现有（[1775501400000:11-37](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501400000-create-local-sync-and-package-for-v13.migration.ts#L11-L37)）：`id`、`installation_id char(36) NOT NULL`、`account_id int NOT NULL`、`organization_id int NOT NULL`、`authorization_status varchar(16) NOT NULL`、`authorized_at timestamp(3) NOT NULL`、`revoked_at timestamp(3) NULL`、`created_at timestamp(3) NOT NULL`；三 FK RESTRICT；`uk_local_account_authorization_scope`；`chk_local_account_authorization_status`（ACTIVE↔`revoked_at` 为空，REVOKED↔非空）。

| 目标列               | 精确规格                         | 旧数据处理                                     |
| -------------------- | -------------------------------- | ---------------------------------------------- |
| `signed_claims`      | `json NULL DEFAULT NULL`         | 历史行保持 NULL；不编造声明                    |
| `permission_version` | `int unsigned NULL DEFAULT NULL` | 历史行保持 NULL；不编造版本                    |
| `last_verified_at`   | `timestamp(3) NULL DEFAULT NULL` | 历史行保持 NULL；不以 `authorized_at` 冒充核验 |

新增约束：

- `chk_local_account_authorization_claims CHECK ((signed_claims IS NULL AND permission_version IS NULL AND last_verified_at IS NULL) OR (signed_claims IS NOT NULL AND permission_version IS NOT NULL AND last_verified_at IS NOT NULL))`：三值同空或同满，避免半套凭据。
- `chk_local_account_authorization_permission_version CHECK (permission_version IS NULL OR permission_version >= 1)`：版本从 1 起，与既有 `content_version >= 1` 口径一致。

状态 CHECK **保持现状**：列 `NOT NULL`，当前表达式对任何合法枚举都返回 TRUE/FALSE，不存在 UNKNOWN 绕过；仅当未来改可空时再按 `CASE ... ELSE FALSE` 重建。

- 迁移顺序：第 40 条，`ADD COLUMN` 与两条 CHECK；不改旧状态约束。
- 消费者影响：现有源码无读写方；新授权由应用层强制三列同满，数据库不能代证“真实离线鉴权”。若维护者坚持 `NOT NULL`，只能在 0 行库执行，非空时必须拒绝迁移（见 §8.8 Q12）。
- 验收场景：三空合法；三满合法；任一半套组合被拒；`permission_version=0` 被拒。

#### 8.2.3 `sync_receipt`（Q3 已裁决，本轮补精确化）

现有（[1775501400000:64-89](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501400000-create-local-sync-and-package-for-v13.migration.ts#L64-L89)）：`receipt_id char(36) PK`、`record_uuid char(36) NOT NULL`、`organization_id int NOT NULL`、`resource_type varchar(32) NOT NULL`、`version_no int unsigned NOT NULL`、`source_system varchar(16) NOT NULL`、`receipt_status varchar(16) NOT NULL`、`manifest_checksum char(64) NOT NULL`、`created_at`、`confirmed_at`；`uk_sync_receipt_scope(record_uuid, organization_id, resource_type, version_no, source_system)`；FK `organization` RESTRICT；状态/来源/摘要/确认时间 CHECK。

目标：

| 变更                     | 精确规格                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `source_installation_id` | `char(36) NOT NULL`，新增列                                                                                            |
| `remote_resource_id`     | `varchar(64) NULL DEFAULT NULL`                                                                                        |
| `received_at`            | `timestamp(3) NULL DEFAULT NULL`                                                                                       |
| 唯一键                   | `DROP uk_sync_receipt_scope`，`ADD uk_sync_receipt_scope_v13(organization_id, resource_type, record_uuid, version_no)` |
| `source_system`          | 保留为描述列与 `chk_sync_receipt_source`，不进入唯一键                                                                 |

替换前扫描（必须在任何 DDL 之前执行）：

```sql
SELECT `organization_id`, `resource_type`, `record_uuid`, `version_no`, COUNT(*) AS `dup_count`
FROM `sync_receipt`
GROUP BY `organization_id`, `resource_type`, `record_uuid`, `version_no`
HAVING COUNT(*) > 1;
```

- 发现任一组重复：**失败关闭**，输出重复组数量与键值，不删除、不合并、不认领、不自动选择保留行。
- 旧数据处理：`source_installation_id` 无历史证据。迁移先执行 `SELECT COUNT(*)`；若表非空，拒绝迁移并输出行数，要求人工裁决；若为 0 行（本增量新建表，验证库预期 0 行），直接加 `NOT NULL`。
- 迁移顺序：第 40 条，扫描 → 计数预检 → 单条 `ALTER`（加列 + 换键，MySQL 8 原子）。
- 消费者影响：现有源码无写入方；未来同步执行器必须写 `source_installation_id`。`source_system` 读取方保持兼容。
- 验收场景：同四列不同 `source_system` 两行被新唯一键拒绝；同四列同来源仍被拒；重复组存在时迁移在 DDL 前中止。

#### 8.2.4 `backup_asset`（Q4）

现有（[1775501500000:11-41](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501500000-create-backup-and-audit-for-v13.migration.ts#L11-L41)）：`backup_id`、`run_id`、`organization_id`、`local_cleanup_run_id`、`storage_reference varchar(1024) NOT NULL`、`file_sha256 char(64) NOT NULL`、`byte_size bigint unsigned NOT NULL`、`cloud_status`、`local_status`、`cloud_receipt`、`attempt_count`、`last_attempt_at`、`created_at/updated_at`；三个 FK RESTRICT；摘要/大小/状态/回执/次数 CHECK。

目标新增列：

| 目标列                | 精确规格                          | 旧数据处理                                                                                    |
| --------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `installation_id`     | `char(36) NOT NULL`               | 无旧行时直接加；有旧行时仅可按 `run_id → local_backup_run.installation_id` 派生，其余列无证据 |
| `format_version`      | `int unsigned NOT NULL`           | 无证据，非空即失败关闭                                                                        |
| `data_version`        | `varchar(64) NOT NULL`            | 无证据，非空即失败关闭                                                                        |
| `manifest_checksum`   | `char(64) NOT NULL`               | 无证据，非空即失败关闭                                                                        |
| `local_reference`     | `varchar(1024) NULL DEFAULT NULL` | 保持 NULL                                                                                     |
| `cloud_reference`     | `varchar(1024) NULL DEFAULT NULL` | 保持 NULL；**不从 `storage_reference` 推断回填**                                              |
| `encryption_key_id`   | `varchar(128) NOT NULL`           | 无证据，非空即失败关闭                                                                        |
| `verified_at`         | `timestamp(3) NULL DEFAULT NULL`  | 保持 NULL                                                                                     |
| `retention_until`     | `timestamp(3) NULL DEFAULT NULL`  | 保持 NULL                                                                                     |
| `failure_reason`      | `text NULL DEFAULT NULL`          | 保持 NULL                                                                                     |
| `deleted_at`          | `timestamp(3) NULL DEFAULT NULL`  | 保持 NULL（仅本地包清理事实）                                                                 |
| `local_cleanup_error` | `text NULL DEFAULT NULL`          | 保持 NULL                                                                                     |

保留 `storage_reference`（原样，语义不重写）、`file_sha256`、`cloud_receipt`、状态列与既有 CHECK。

新增约束：

- `chk_backup_asset_manifest CHECK (CHAR_LENGTH(manifest_checksum) = 64)`。
- `chk_backup_asset_format_version CHECK (format_version >= 1)`。
- `chk_backup_asset_local_cleanup CHECK ((local_status = 'CLEANED' AND local_reference IS NULL AND deleted_at IS NOT NULL) OR (local_status <> 'CLEANED' AND deleted_at IS NULL))`：清理完成必须无本地引用且有清理时间；未清理不得有清理时间。
- 新增索引 `idx_backup_asset_installation(installation_id, created_at)`；**不新增** `installation_id → local_installation` FK（该表是本地表，云端库不保证存在对应行；设计 4.15 也未要求）。
- 不新增本地/云端引用成对约束（两者独立，允许只有其一）。

旧数据处理：`SELECT COUNT(*)`；>0 时只允许 `installation_id` 派生，其余 4 个 NOT NULL 列无证据 → **拒绝迁移**并列明缺证据列；=0 时直接加列。
迁移顺序：第 40 条，`backup_asset` 先于 `backup_restore_run`。
消费者影响：现有源码无读写方；Entity 随后续实施。
验收场景：`CLEANED` 且 `local_reference` 非空被拒；`CLEANED` 且 `deleted_at` 为空被拒；非 `CLEANED` 且 `deleted_at` 非空被拒；`manifest_checksum` 长度非 64 被拒。

#### 8.2.5 `backup_restore_run`（Q4）

现有（[1775501500000:45-74](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501500000-create-backup-and-audit-for-v13.migration.ts#L45-L74)）：`restore_id`、`backup_id`、`protection_backup_id char(36) NOT NULL`、`organization_id`、`started_by_account_id`、`status varchar(16) NOT NULL (RUNNING/SUCCEEDED/FAILED/INTERRUPTED)`、`check_snapshot longtext NOT NULL (JSON + schema_version)`、`restored_scope`、`result_summary`、`started_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`、`finished_at`；`chk_backup_restore_run_status`、`chk_backup_restore_run_finish`、`chk_backup_restore_run_protection(backup_id <> protection_backup_id)`、`chk_backup_restore_run_schema`。

目标：

| 变更                     | 精确规格                                                         |
| ------------------------ | ---------------------------------------------------------------- |
| `protection_backup_id`   | `char(36) NULL DEFAULT NULL`（预检阶段可空；执行阶段必须非空）   |
| `started_at`             | `timestamp(3) NULL DEFAULT NULL`（预检未开始为空）               |
| `status` 域              | `PENDING/RUNNING/SUCCEEDED/FAILED/INTERRUPTED`（补设计“待执行”） |
| `target_installation_id` | `char(36) NOT NULL`                                              |
| `check_status`           | `varchar(16) NOT NULL`（枚举待 §8.8 Q13 确认）                   |
| `confirmation`           | `json NULL DEFAULT NULL`（执行前必满）                           |

新增/重建约束：

```sql
CONSTRAINT `chk_backup_restore_run_protection`
  CHECK (`protection_backup_id` IS NULL OR `protection_backup_id` <> `backup_id`),
CONSTRAINT `chk_backup_restore_run_finish` CHECK (
  (`status` = 'PENDING' AND `started_at` IS NULL AND `finished_at` IS NULL)
  OR (`status` = 'RUNNING' AND `started_at` IS NOT NULL AND `finished_at` IS NULL)
  OR (`status` IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED') AND `finished_at` IS NOT NULL)
),
CONSTRAINT `chk_backup_restore_run_execution_guard` CHECK (CASE
  WHEN `status` = 'PENDING' THEN `protection_backup_id` IS NULL AND `confirmation` IS NULL
  WHEN `status` IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED') THEN
    `started_at` IS NOT NULL AND `protection_backup_id` IS NOT NULL AND `confirmation` IS NOT NULL
  ELSE FALSE END)
```

保留 `chk_backup_restore_run_schema`。现有 `chk_backup_restore_run_status` 需先 `DROP` 再以新枚举 `ADD`。

- 状态语义（需与业务确认）：`PENDING`=预检阶段，尚未开始执行；`RUNNING`=执行中；`SUCCEEDED/FAILED/INTERRUPTED`=已结束。任何“已开始”的行必须具备有效保护备份与确认。
- 旧数据处理：表为第 37 条新建，验证库预期 0 行。若存在旧行，`target_installation_id` 可由 `backup_id → backup_asset.installation_id` 派生；`check_status` 无证据 → **拒绝迁移**，不猜测。
- 迁移顺序：第 40 条，`backup_asset` 之后。
- 消费者影响：现有源码无写入方。
- 验收场景：`PENDING` 且保护包非空被拒；`RUNNING` 且保护包为空被拒；`RUNNING` 且未开始被拒；`SUCCEEDED` 无结束时间被拒；`protection_backup_id = backup_id` 被拒。

#### 8.2.6 `maintenance_report_fault`（Q5）

现有（[1775501300000:13-44](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501300000-create-report-fault-and-revisions-for-v13.migration.ts#L13-L44)）：`id`、`report_id`、`fault_uuid char(36) NOT NULL`、`branch_kind varchar(32) NOT NULL`、`step_code varchar(64) NULL`、`panel_snapshot longtext NULL`、`fault_description text NOT NULL`、`fault_cause text NULL`、`handling_action longtext NULL`、`status varchar(16) NOT NULL (OPEN/IN_PROGRESS/RESOLVED)`、`source varchar(16) NOT NULL (USER/ADMIN/SYSTEM)`、`created_at`；`uk_maintenance_report_fault_uuid`、`idx(report_id, branch_kind)`、复合 FK `(report_id, step_code) → maintenance_report_step`。

目标：

| 变更           | 精确规格                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 生命周期列改名 | `status` → `lifecycle_status varchar(16) NOT NULL`；`source` → `lifecycle_source varchar(16) NOT NULL`                                                                                                                                                                   |
| 原始八字段     | `main_error varchar(300) NULL`、`unit_error varchar(300) NULL`、`error_type varchar(300) NULL`、`gpib_status varchar(300) NULL`、`status varchar(300) NULL`、`source varchar(300) NULL`；`description` 复用现有 `fault_description`；`action` 复用现有 `handling_action` |
| `phase_code`   | `varchar(32) NULL DEFAULT NULL`；十选一枚举待 §8.8 Q13 确认，确认前不加域 CHECK                                                                                                                                                                                          |
| `is_active`    | `boolean NOT NULL`；升级前 `SELECT COUNT(*)`，非空即失败关闭（无法证明哪一分支“当前有效”）                                                                                                                                                                               |

新增/重建约束：

- `chk_maintenance_report_fault_lifecycle_status CHECK (lifecycle_status IN ('OPEN','IN_PROGRESS','RESOLVED'))`
- `chk_maintenance_report_fault_lifecycle_source CHECK (lifecycle_source IN ('USER','ADMIN','SYSTEM'))`
- `chk_maintenance_report_fault_description_len CHECK (CHAR_LENGTH(fault_description) <= 10000)`
- `chk_maintenance_report_fault_action_len CHECK (handling_action IS NULL OR CHAR_LENGTH(handling_action) <= 10000)`
- 既有 `chk_maintenance_report_fault_branch`、`chk_maintenance_report_fault_step`、`fk_maintenance_report_fault_step` 保持不变。

**不新增** `(report_id, step_code)` 唯一键：设计允许同一报告内初始故障、复位新故障、步骤新故障分别成行，直接加唯一键会误拒；现有复合 FK 已完成步骤归属校验。若未来要求“同一分支唯一”，需另立按 `branch_kind` 区分的生成列方案，另行裁决。

旧数据处理：改名保留原值；新增原始列保持 NULL；`panel_snapshot` 保留为诊断原文，不参与业务读取，不新增 JSON 版本 CHECK。
迁移顺序：第 40 条；改名与加列拆成两条 `ALTER`（先释放 `status/source` 名称，再新增同名原始列），避免同一条语句内名称复用歧义。
消费者影响：现有源码无读写方；Entity 与前端字段映射随后续实施。
验收场景：原始 `status` 文本可保存且不影响生命周期；生命周期枚举越界被拒；描述/动作超 10000 字被拒。

#### 8.2.7 `repair_request`（Q7 兼容 + Q9）

现有第 32 条约束（[1775501100000:188-192](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L188-L192)）：

```sql
CHECK (
  (closure_status IS NULL AND closed_at IS NULL)
  OR (closure_status = 'OPEN' AND closed_at IS NULL)
  OR (closure_status = 'CLOSED' AND closed_at IS NOT NULL)
)
```

三值缺陷：`(closure_status=NULL, closed_at≠NULL)` 求值为 UNKNOWN，被 MySQL 放行。

目标（新增迁移，不改第 32 条）：

```sql
-- 预检：必须先失败关闭
SELECT COUNT(*) AS `offender_count`
FROM `repair_request`
WHERE `closure_status` IS NULL AND `closed_at` IS NOT NULL;

ALTER TABLE `repair_request`
  DROP CONSTRAINT `chk_repair_request_closure`,
  ADD CONSTRAINT `chk_repair_request_closure` CHECK (CASE
    WHEN `closure_status` IS NULL THEN `closed_at` IS NULL
    WHEN `closure_status` = 'OPEN' THEN `closed_at` IS NULL
    WHEN `closure_status` = 'CLOSED' THEN `closed_at` IS NOT NULL
    ELSE FALSE END);
```

- 旧数据处理：`(NULL, NULL)` 合法保留（历史/旧入口兼容）；若预检发现 `(NULL, 非空)`，**中止迁移**并输出行数与 ID 清单，不自动改数据、不删除。
- 新流程规则（应用层）：新写入必须给出 `closure_status`（OPEN/CLOSED）与成对的 `closed_at`；`OPEN` 时 `closed_at=NULL`，`CLOSED` 时非空。双 NULL 仅为兼容行保留，新代码不得产生。
- 验收场景：双 NULL 合法；`(NULL, 非空)` 被拒；`OPEN`+非空被拒；`CLOSED`+空被拒；非法字符串被拒。

Q7 历史身份列/表不在本轮定型，见 §8.3。

### 8.3 Q7 历史身份兼容方案（只列取舍，不选型）

前提：升级前必须在 31 态冻结“真实历史工单 ID 集合”，并保证集合完整；不得用 `current_revision_no=0`、`intake_id IS NULL` 或任何运行期推断替代。

| 方案              | 形态                                                                                                                                      | 优点                                      | 缺点/风险                                          | 需用户决定                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| O1 主表持久标记   | `repair_request.origin_kind varchar(16)`（`LEGACY/NEW_ENTRY`），先可空、按冻结集合写 `LEGACY`、其余写 `NEW_ENTRY`、再改 NOT NULL          | 运行时可直接查询与索引；单表判定；可审计  | 需改主表；集合不完整会把历史行误标为新入口         | 集合来源与完整性；是否接受主表加列     |
| O2 历史映射表     | `repair_request_legacy_identity(request_id PK, frozen_batch_id char(36), frozen_at timestamp(3), evidence_ref varchar(255))`，FK RESTRICT | 不动主表；按批次独立审计；可逐行增补/撤销 | 每次判定需 JOIN；多一张表；仍需冻结集合            | 是否接受新增映射表；批次与证据字段定义 |
| O3 仅外部冻结清单 | 清单存受控文件/工单，迁移只校验不落库                                                                                                     | 零结构变更                                | **不满足“可持久区分”**：服务重启或换环境后无法判定 | 是否放弃持久区分（不推荐）             |

最小待决问题（Q7）：

1. 冻结集合由哪一版 31 态库导出，是否包含软删/撤单行，谁签字确认“完整”？
2. 选择 O1 还是 O2；若选 O1，是否接受“集合外一律 `NEW_ENTRY`”的闭合假设？

本轮不创建列、不创建表、不写迁移。

### 8.4 第 32 条挡点：源码证据

第 32 条 `up()` 顺序（[1775501100000:12-20](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L12-L20)）：`upgradeRepairRequest` → `upgradeAiConversation` → `upgradeAiMessage` → `upgradeMaintenanceReportStep`（2 条语句）→ `upgradeMaintenanceReport` → `upgradeReferenceDocument` → `upgradeLocalTasks`。每条 `queryRunner.query` 独立隐式提交。

| 项                              | 31 态约束/事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 实际旧输入/接口                                                                                                  | 31 态合法样本                                                                                                                            | 第 32 条表达式                                                                                                                                                                                                                    | 预计失败位置                                                                                             | 结论                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A `ai_helpfulness=5`            | `tinyint unsigned NULL`；`chk_maintenance_report_ai_helpfulness CHECK (ai_helpfulness IS NULL OR BETWEEN 1 AND 5)`（[1775401200000:35](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775401200000-create-maintenance-report-and-content.migration.ts#L35)、[:75](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775401200000-create-maintenance-report-and-content.migration.ts#L75)） | `maintenance-report.input.normalize.ts` 的 `AI_RATING_MAX=5`；`maintenance-report.service.ts` 写 `aiHelpfulness` | `status='DRAFT'`、`current_version_no=0`、`ai_usage='USED'`、三个 `ai_source_*` 非空、`ai_helpfulness=5`                                 | `CHECK (ai_helpfulness IS NULL OR BETWEEN 1 AND 4)`（[:279-281](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L279-L281)） | 第 5 条 `upgradeMaintenanceReport`（`maintenance_report` 单条 ALTER 原子回滚）；前 4 表共 5 条语句已提交 | **真实挡点**                                                    |
| B 中断/无法修复无原因           | 31 态无 `closure_reason` 列；`handling_result IN (...INTERRUPTED, UNREPAIRABLE)` 且 `INTERRUPTED→IN_PROGRESS`、`UNREPAIRABLE→UNRESOLVED`（[1775401100000:45-75](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775401100000-alter-repair-request-organization-and-handling.migration.ts#L45-L75)）；第 31 条预检允许该组合                                                                                                           | 旧无 `closure_reason` 写入方；`RecordRepairRequestHandlingResultUsecase` 也不写该列                              | `is_accepted=1`、`handling_result='INTERRUPTED'`、`handling_status='IN_PROGRESS'`、`handling_recorded_at` 非空、`handling_ended_at` 为空 | `chk_repair_request_closure_reason`（[:193-197](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L193-L197)）                 | 第 1 条 `upgradeRepairRequest`；**第 32 条无任何 DDL 提交**                                              | **真实挡点**                                                    |
| C 审核状态与 `last_reviewed_at` | 31 态 `status IN ('DRAFT','PENDING_REVIEW','RETURNED','APPROVED')`；一致性约束要求 DRAFT→版本 0/无提交/无审核，PENDING_REVIEW→版本≥1/已提交/无审核，RETURNED/APPROVED→版本≥1/已提交/有审核（[1775401200000:58-63](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775401200000-create-maintenance-report-and-content.migration.ts#L58-L63)）                                                                                          | `maintenance-report.service.ts` 仅在 RETURNED/APPROVED 写 `lastReviewedAt`                                       | 31 态全部合法行都是第 32 条新约束的子集（新增 `SUBMITTED` 分支与 PENDING_REVIEW 同规则）                                                 | [:267-277](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L267-L277)                                                        | 无合法违规样本                                                                                           | **非挡点**                                                      |
| D 会话状态与反馈                | `chk_ai_conversation_completion`：ACTIVE 只要求 `completed_at IS NULL`，**允许 `ai_feedback` 非空**（[1775201100000:22-26](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775201100000-create-ai-conversation-table.migration.ts#L22-L26)）                                                                                                                                                                                          | 全仓库无 `ai_feedback` 写入者（仅 Entity/迁移）                                                                  | `status='ACTIVE'`、`ai_feedback='历史反馈'`、`completed_at=NULL` 在 31 态合法                                                            | ACTIVE 分支要求 `ai_feedback IS NULL`（[:214-218](file:///home/gandiantx/lithography-platform/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts#L214-L218)）               | 第 2 条 `upgradeAiConversation`；仅第 1 条 `upgradeRepairRequest` 已提交                                 | **DB 合法但无真实历史输入**；只作防御性场景，不作为历史事实证据 |

补充（消费者影响，本轮不改代码）：

- `RecordRepairRequestHandlingResultUsecase` 不写 `closure_reason`，且无 GraphQL/REST 适配器暴露；升级后新写入 `INTERRUPTED/UNREPAIRABLE` 也会被第 32 条 CHECK 拒绝。
- `ai_helpfulness` 应用层 `AI_RATING_MAX=5` 未收紧；即使数据库放宽到 1—5，新输入仍需应用层限制 1—4。

### 8.5 实库规格与安全门

新增受版本控制规格：`backend/src/infrastructure/database/v13-upgrade-from-31-state.realdb.spec.ts`。**默认跳过、本轮不运行、未创建任何数据库。**

#### 8.5.1 专用库（本轮不创建）

| 库名                              | 用途                                                       |
| --------------------------------- | ---------------------------------------------------------- |
| `lithography_v13_upg31_ctrl`      | 控制组：31 态无风险样本 + C 组合合法样本，升级必须成功     |
| `lithography_v13_upg31_a_ai5`     | A：`ai_helpfulness=5`                                      |
| `lithography_v13_upg31_b_closure` | B：`INTERRUPTED`/无 `closure_reason`                       |
| `lithography_v13_upg31_d_conv`    | D：`ACTIVE + ai_feedback`（DB 合法、无真实写入者，防御性） |

C 不单独建库：其合法样本放入控制组，证明第 32 条对旧审核组合放行。

#### 8.5.2 安全门

| 门                             | 规则                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `V13_UPGRADE_SPECS=1`          | 未设置则整文件 `describe.skip`，不读取其他变量、不连接                                      |
| `E2E_ALLOW_PHYSICAL_CLEANUP=1` | 显式允许物理写入；缺失即模块加载抛错                                                        |
| `V13_UPGRADE_SCENARIO`         | 仅 `ctrl/a_ai5/b_closure/d_conv`；非法值抛错                                                |
| `V13_UPGRADE_DB_NAME`          | 必须与场景硬编码库名逐字一致                                                                |
| `V13_UPGRADE_ENV_FILE`         | 绝对路径；必须含 `DB_HOST/DB_USER/DB_PORT/DB_NAME`，且 `DB_NAME` 与目标一致                 |
| `V13_UPGRADE_EVIDENCE_DIR`     | 绝对路径；证据写入 0600 JSON                                                                |
| 目标前置                       | `SELECT DATABASE()` 与参数一致；库内无 `migrations` 表、无任何业务表；否则拒绝，不自动清库  |
| 正式入口                       | 只调用 `runDatabaseDeploy({mode:'upgrade'})`；不直接 `migration.up`、不伪造历史、不关闭约束 |
| 失败现场                       | 不清理、不回退 DDL；证据落盘后结束                                                          |

#### 8.5.3 规格流程

1. 用 `createMigrationDataSource(config)` 初始化，读取仓库迁移清单，取**前 31 条**类实例。
2. 用前 31 条另建 DataSource，`runMigrations({transaction:'none'})` 正向构建 31 态；断言历史恰好 31 条且名称与仓库前缀一致。
3. 插入场景旧样本；**创建成功即登记真实 ID 与字段事实**；断言可回读。
4. 调用正式升级入口；记录成功/失败、错误原文、失败迁移（`repository[history.length]`）、SQL 阶段（预检 vs 迁移）。
5. 失败后新开连接，采集：迁移历史、探针列（`repair_request.intake_id`、`ai_conversation.owner_organization_id`、`ai_message.question_uuid`、`maintenance_report_step.error_code`、`maintenance_report.supplementary_note`）、样例行、`SHOW CREATE TABLE`。
6. 证据 JSON 字段：`scenario/database/legacySampleSaved/legacyIds/outcome/stage/failedMigration/error/committedDdl/migrationHistory/sampleRows/structure/cleanup`。`cleanup` 恒为 `NONE`。

#### 8.5.4 Q6 权限判定（无 DDL）

- 1 级管理员归属甲方（`organization.kind='CLIENT'`）；2 级管理员归属受管公司（`PEER`）。
- 授权判定必须同时读取 `organization_membership` 的 ACTIVE 行作为可信归属，不以资料上的公司字段单独授权。
- 不新增角色、不新增权限模式；既有 `SUPER_ADMIN` 角色与 `actor_admin_level` CHECK(1,2) 保持。
- 该规则进入 P1 管理员初始化与后续实库验收，但本轮不改产品代码。

#### 8.5.5 明确不承诺

- 规格捕获“预期升级失败”不等于“升级路径通过”；控制组通过才是基线可升级证据。
- 规格不自动建库、不自动回滚、不自动修数据。

### 8.6 升级路径选择（本轮不批准、不改迁移）

若 A/B 被实库证实阻断旧合法值，只有以下路径可行：

| 选项            | 做法                                                                                               | 前置授权               | 已执行旧版本迁移的验证库处置                                     | 已升级目标如何到同一终态           | 三态一致性                                           | 指纹/文档                                              |
| --------------- | -------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| P-A（唯一可行） | 维护者授权修改第 32 条：`ai_helpfulness` 保持 1—5、`closure_reason` 约束延后到新迁移或改为可空后补 | 明确授权修改已执行迁移 | 旧行为验证库标记为“结构不可信”，重建后重新验收；不得继续作为证据 | 追加迁移重建约束，或重建目标后重跑 | 全新/31 态由修改后的第 32 条；已升级态由追加迁移     | 重算第 32 条 SHA-256 与聚合指纹，更新 S0/S4 与批准文字 |
| P-B（不可行）   | 保留第 32 条，在其后新增迁移放宽                                                                   | —                      | —                                                                | —                                  | **不可行**：第 32 条先执行即失败，永远到不了后续迁移 | —                                                      |
| P-C（不可行）   | 第 32 条之前插入中间迁移                                                                           | —                      | —                                                                | —                                  | **不可行**：破坏已升级库的完整历史前缀校验           | —                                                      |
| P-D（禁止）     | 升级前把 5 改 4、补写原因                                                                          | —                      | —                                                                | —                                  | 用户明确禁止临时改旧业务数据规避                     | —                                                      |

不采用伪造 `migrations` 历史、手工跳过迁移、关闭约束或临时改旧业务数据。

### 8.7 离线检查

见 §9。

### 8.8 仍需用户决定的最小问题

| 编号 | 问题                                                                                                                   | 影响                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Q11  | `next_backup_at` 旧行是否允许按 `initialized_at + 72h` 派生回填？若不接受派生，只能保持可空并由应用层强制              | 决定 `local_company_setting` 是否可全量 NOT NULL |
| Q12  | `signed_claims/permission_version/last_verified_at` 历史行保持三空（当前方案），还是坚持 NOT NULL 并在非空库拒绝迁移？ | 决定授权表迁移在非空库的可执行性                 |
| Q13  | `backup_restore_run.check_status` 与 `maintenance_report_fault.phase_code` 的精确枚举值                                | 决定两条 CHECK 的最终表达式                      |
| Q14  | 是否批准修改第 32 条（P-A）；若不批准，实库规格只能证明“阻断”，不能给出可升级路径                                      | 决定下一轮是否进入实库验证                       |
| Q15  | Q7 选 O1/O2，以及冻结集合来源与完整性签字                                                                              | 决定第 41 条迁移形态                             |

## 9. 离线检查结果

- `npm run typecheck`（build + tools）：通过。
- `npx tsc -p tsconfig.spec.json --noEmit`：通过。
- 新增规格相关纯函数/替身单测：本轮规格默认跳过、不连库，未新增可执行单测；以 spec 类型检查与文件级 ESLint 保证可编译、默认无副作用。
- 默认关闭行为验证：`jest --runTestsByPath src/infrastructure/database/v13-upgrade-from-31-state.realdb.spec.ts` 结果为 1 suite / 1 test skipped，未连接数据库。
- 文件级 ESLint（不带 `--fix`）：通过（`src/infrastructure/database/v13-upgrade-from-31-state.realdb.spec.ts`）。
- Prettier `--check`：S5、execution-log、新规格通过；`S1-open-issues.md` 仍只有第 1 节表格列宽的历史非合规（行 5—20，非本轮插入），未做全局重排以免产生无关大 diff。
- `git diff --check`：通过（退出码 0）。
- 第 1—39 条迁移逐文件 SHA-256 聚合复核：39 条，聚合 `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`，与 S4 记录一致；未修改任何迁移文件。

## 10. 下一轮实库验证：命令与最小授权文字

### 10.1 前置（本轮不执行）

1. 由获授权人员创建 4 个空库：`lithography_v13_upg31_ctrl`、`lithography_v13_upg31_a_ai5`、`lithography_v13_upg31_b_closure`、`lithography_v13_upg31_d_conv`；不预置任何表、不导入任何历史。
2. 为每个库准备独立 env 文件（不入库），至少包含：
   `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASS`、`DB_NAME`；`DB_NAME` 必须与库名逐字一致。
3. 规格会在任何 DDL 前断言：实际 `DATABASE()` 与声明一致、库内零业务表；不满足即拒绝，不自动清库。

### 10.2 准确命令（在 `backend/` 下逐个执行）

```bash
V13_UPGRADE_SPECS=1 \
E2E_ALLOW_PHYSICAL_CLEANUP=1 \
V13_UPGRADE_SCENARIO=ctrl \
V13_UPGRADE_DB_NAME=lithography_v13_upg31_ctrl \
V13_UPGRADE_ENV_FILE=/absolute/path/env/.env.v13-upg31-ctrl \
V13_UPGRADE_EVIDENCE_DIR=/absolute/path/evidence/v13-upg31 \
npx jest --config jest.config.ts \
  --runTestsByPath src/infrastructure/database/v13-upgrade-from-31-state.realdb.spec.ts \
  --runInBand
```

其余三个场景替换两处值后重复：

| 场景 | `V13_UPGRADE_SCENARIO` | `V13_UPGRADE_DB_NAME`             |
| ---- | ---------------------- | --------------------------------- |
| A    | `a_ai5`                | `lithography_v13_upg31_a_ai5`     |
| B    | `b_closure`            | `lithography_v13_upg31_b_closure` |
| D    | `d_conv`               | `lithography_v13_upg31_d_conv`    |

预期：`ctrl` 通过并执行 8 条 pending；A/B/D 失败且失败迁移为第 32 条。**A/B/D 的失败只证明阻断，不证明升级路径通过。**

实测补充（2026-11-09，见 §11）：基线之后第 1 条增量（总第 32 条）`AlterAccountsAndOrganizationsForV13` 会先完整提交并记入历史，迁移历史停在 32 条；失败的是下一条（总第 33 条、规格所称“第 32 条”）`AlterRepairAiReportForV13`。因此 `失败迁移 = repository[32]`、`历史条数 = 32`，不是 31。

### 10.3 最小授权文字（需用户签字/确认后才可执行）

> 授权在隔离 MySQL 实例上创建并使用 `lithography_v13_upg31_ctrl`、`lithography_v13_upg31_a_ai5`、`lithography_v13_upg31_b_closure`、`lithography_v13_upg31_d_conv` 四个空库；授权以第 1—31 条迁移正向构建 31 态、插入规格声明的 31 态合法样本、并通过正式入口 `runDatabaseDeploy(mode=upgrade)` 执行第 32—39 条；允许物理写入与失败现场保留；不清理、不回退 DDL、不修改业务代码或迁移；执行人：********；有效期：********。

未取得上述授权，或目标身份（库名、env 文件、证据目录）不完整时，规格必须拒绝执行。

## 11. 第一轮实库验证结果（已执行，2026-11-09）

### 11.1 执行环境与授权边界

| 项         | 事实                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 实例       | MySQL `8.0.46-0ubuntu0.24.04.4`，`127.0.0.1:3306`                                                                                |
| 账号       | 本机开发账号（有 CREATE/DROP；口令不记录于文档与证据）                                                                           |
| 目标库     | `lithography_v13_upg31_ctrl`、`lithography_v13_upg31_a_ai5`、`lithography_v13_upg31_b_closure`（`utf8mb4`，执行前均为 0 表空库） |
| env 文件   | `/tmp/v13-upg31-20261109/env/.env.v13-upg31-{ctrl,a_ai5,b_closure}`（0600，不入库）                                              |
| 证据目录   | `/tmp/v13-upg31-20261109/evidence`（0600 JSON；含样本落盘快照与终态各一份）                                                      |
| 授权范围   | 仅 ctrl / A / B 三场景；`d_conv` 未建库、未执行                                                                                  |
| 清理与回滚 | 全程未清库、未回退 DDL、未改业务代码与迁移、未 commit/push                                                                       |

### 11.2 结果汇总

| 场景 | outcome | stage     | 失败迁移                                 | 错误原文                                                                | 迁移历史 | 新列提交（5 探针）                       | 旧样本                                   |
| ---- | ------- | --------- | ---------------------------------------- | ----------------------------------------------------------------------- | -------- | ---------------------------------------- | ---------------------------------------- |
| ctrl | SUCCESS | NONE      | 无                                       | 无                                                                      | 39       | 5/5 true                                 | 报告 RETURNED、普通工单、ACTIVE 会话完整 |
| A    | FAILURE | MIGRATION | `AlterRepairAiReportForV131775501100000` | `Check constraint 'chk_maintenance_report_ai_helpfulness' is violated.` | 32       | 前 4 列 true，`supplementary_note` false | `ai_helpfulness=5` 行仍在库              |
| B    | FAILURE | MIGRATION | `AlterRepairAiReportForV131775501100000` | `Check constraint 'chk_repair_request_closure_reason' is violated.`     | 32       | 0/5 true                                 | `INTERRUPTED/IN_PROGRESS` 工单仍在库     |

- ctrl 实际执行 8 条 pending（第 32—39 条），业务表 51 张；`SHOW CREATE TABLE` 与 5 个探针列一致。
- A 失败前已提交 `repair_request.intake_id`、`ai_conversation.owner_organization_id`、`ai_message.question_uuid`、`maintenance_report_step.error_code`（对应第 32 条第 1—4 条语句，共 5 个 `query`）；`maintenance_report` 单条 ALTER 原子回滚，`supplementary_note` 未出现。
- B 在第 32 条第 1 条 `upgradeRepairRequest` 即失败，第 32 条无任何 DDL 提交。
- 两例失败迁移均为 `repository[32]`；历史最后一条是 `AlterAccountsAndOrganizationsForV131775501000000`（基线后第 1 条增量，已完整提交），故历史条数为 32。

### 11.3 三库现场核对（失败后按原样保留）

| 库                                | 表数 | 迁移历史        | 样本行                                                          | 探针列                              |
| --------------------------------- | ---- | --------------- | --------------------------------------------------------------- | ----------------------------------- |
| `lithography_v13_upg31_ctrl`      | 52   | 39（max id 39） | `repair_request` 1、`maintenance_report` 1、`ai_conversation` 1 | 5/5 存在                            |
| `lithography_v13_upg31_a_ai5`     | 35   | 32（max id 32） | `maintenance_report` 1（`ai_helpfulness=5`）                    | 4 存在，`supplementary_note` 不存在 |
| `lithography_v13_upg31_b_closure` | 35   | 32（max id 32） | `repair_request` 1（`INTERRUPTED/IN_PROGRESS`）                 | 0 存在                              |

### 11.4 规格断言校准（测试自身缺陷，非产品改动）

首次 A 运行已捕获真实产品阻断（错误原文与已提交 DDL 见 §11.2），但规格断言写成 `failedMigration = repository[BASELINE_COUNT]`、`历史 = 31`，与实测（`repository[32]`、历史 32）差一格，导致该次运行以断言不一致结束。随后只修改规格断言：

- `failedMigration = repository[BASELINE_COUNT + 1]` 且名称必须含 `AlterRepairAiReportForV13`；
- `migrationHistoryCount = BASELINE_COUNT + 1`，并断言历史最后一条为 `repository[BASELINE_COUNT]`。

B 运行使用了校正后的断言并通过。之后仅做类型替换（`Function` → `MigrationConstructor`，消除 ESLint `no-unsafe-function-type`），无运行时改动；因禁止清库，最终文件未再对空库执行，其运行时行为由 B 运行 + 纯类型差异共同保证。

### 11.5 本轮离线复核

- `npx tsc -p tsconfig.spec.json --noEmit`：通过。
- 文件级 ESLint（无 `--fix`）：通过。
- Prettier `--check`（规格、S5、execution-log）：通过；`git diff --check`：退出码 0。
- 默认禁用：`jest --runTestsByPath …` 为 1 suite / 1 test skipped，未连库。
- 迁移目录：`git status` 中仅 8 个既有未跟踪 v13 迁移文件，无 `M`（本轮未改任何迁移）。

### 11.6 结论与边界

- **A/B 均实测阻断，属缺陷复现，不构成升级成功**；ctrl 通过只证明 31 态无风险样本可走正式入口。
- 三库保留为失败现场：A 库处于半迁移（4 个探针列已提交），不得作为“已升级证据”复用；B 库无第 32 条 DDL。
- 未获批准前不改第 32 条；后续是否进入第二轮，取决于对“第 32 条修改授权”的明确批准。

## 12. 第二轮代码修复（已执行，2026-11-09）

### 12.1 授权与改动边界

| 项       | 内容                                                                     |
| -------- | ------------------------------------------------------------------------ |
| 获批例外 | 仅 `1775501100000-alter-repair-ai-report-for-v13.migration.ts`           |
| 保持不变 | 前 31 条与 `1775501000000`；其余 7 条增量迁移                            |
| 本轮动作 | 仅代码、测试、文档；不连库写入、不处理 ctrl/A/B 现场、不 commit、不 push |
| 追加迁移 | 新增第 40 条，不修改任何既有迁移历史                                     |
| 未做     | 未执行任何实库升级；未补历史、未自动续跑半迁移库                         |

### 12.2 原迁移精确 diff

修订前 SHA-256=`bb28ca2c1754824bade94b99052d8887c69c77175f065ab8566882b60a1d814f`（与 §S4 第 33 行一致），修订后=`ee5868be919bc4bd9e7342a1f400109d440cd2824be2b18e7482eaeab1edda2c`。旧文件字节由反向还原校验，还原结果哈希恰为 `bb28ca2c…`，故此 diff 精确。

```diff
--- a/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts
+++ b/backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts
@@ -5,11 +5,18 @@
  *
  * 只做前向扩展：旧值保留，新增字段先可空，能从现有字段证明的历史事实才回填；
  * 不猜测旧工单归属，不改写历史业务正文。
+ *
+ * 兼容边界：`ai_helpfulness` 库内保持 1—5（旧合法值 5 不改写），新输入收紧到 1—4
+ * 由应用层执行；其余会拒绝既有合法行的约束（ACTIVE 会话已带反馈、旧中断工单缺少
+ * closure_reason）在任何 ALTER 之前先做兼容预检，失败即中止且不留半迁移。
  */
 export class AlterRepairAiReportForV131775501100000 implements MigrationInterface {
   name = 'AlterRepairAiReportForV131775501100000';

   public async up(queryRunner: QueryRunner): Promise<void> {
+    // 所有收紧既有数据的约束都必须先完成兼容判定，再执行任何 ALTER；
+    // 否则 MySQL 隐式提交会让失败现场停在半迁移。
+    await assertLegacyDataCompatible(queryRunner);
     await this.upgradeRepairRequest(queryRunner);
     await this.upgradeAiConversation(queryRunner);
     await this.upgradeAiMessage(queryRunner);
@@ -277,7 +284,7 @@
         ),
         DROP CONSTRAINT \`chk_maintenance_report_ai_helpfulness\`,
         ADD CONSTRAINT \`chk_maintenance_report_ai_helpfulness\` CHECK (
-          \`ai_helpfulness\` IS NULL OR \`ai_helpfulness\` BETWEEN 1 AND 4
+          \`ai_helpfulness\` IS NULL OR \`ai_helpfulness\` BETWEEN 1 AND 5
         ),
         DROP CONSTRAINT \`chk_maintenance_report_ai_correctness\`,
         ADD CONSTRAINT \`chk_maintenance_report_ai_correctness\` CHECK (
@@ -421,3 +428,117 @@
     `);
   }
 }
+
+interface CountRow {
+  readonly total?: unknown;
+}
+
+const SAMPLE_LIMIT = 20;
+
+const toCount = (rows: ReadonlyArray<CountRow>): number => {
+  const parsed = Number(rows[0]?.total ?? 0);
+  return Number.isFinite(parsed) ? parsed : 0;
+};
+
+async function columnExists(
+  queryRunner: QueryRunner,
+  table: string,
+  column: string,
+): Promise<boolean> {
+  const rows = (await queryRunner.query(
+    `SELECT 1 AS present
+       FROM information_schema.COLUMNS
+      WHERE TABLE_SCHEMA = DATABASE()
+        AND TABLE_NAME = ?
+        AND COLUMN_NAME = ?
+      LIMIT 1`,
+    [table, column],
+  )) as ReadonlyArray<{ present?: unknown }>;
+  return rows.length > 0;
+}
+
+async function collectLocators(
+  queryRunner: QueryRunner,
+  table: string,
+  where: string,
+): Promise<string> {
+  const rows = (await queryRunner.query(
+    `SELECT \`id\` AS locator
+       FROM \`${table}\`
+      WHERE ${where}
+      ORDER BY \`id\`
+      LIMIT ${SAMPLE_LIMIT}`,
+  )) as ReadonlyArray<{ locator?: unknown }>;
+  return rows.map((row) => String(row.locator)).join(', ');
+}
+
+/**
+ * 兼容预检：只覆盖“本次迁移会把既有合法行变为非法”的两处收紧。
+ *
+ * 1. `chk_ai_conversation_completion`：31 态允许 ACTIVE 会话已有反馈，
+ *    本迁移要求 ACTIVE 时 `ai_feedback` 必须为空；
+ * 2. `chk_repair_request_closure_reason`：本迁移要求 INTERRUPTED/UNREPAIRABLE
+ *    必须有 `closure_reason`，而历史行没有该字段。历史身份标记方案确认前不放宽，
+ *    也不编造原因，因此这里如实报告并中止。
+ *
+ * 判定先于任何 ALTER 执行：失败时迁移历史不会前进，库内也不会出现半迁移结构。
+ * 错误信息只含计数与主键 ID，不输出业务正文。
+ */
+async function assertLegacyDataCompatible(queryRunner: QueryRunner): Promise<void> {
+  const details: string[] = [];
+
+  const conversationViolations = toCount(
+    (await queryRunner.query(
+      `SELECT COUNT(*) AS total
+         FROM \`ai_conversation\`
+        WHERE \`status\` = 'ACTIVE'
+          AND \`ai_feedback\` IS NOT NULL`,
+    )) as ReadonlyArray<CountRow>,
+  );
+  if (conversationViolations > 0) {
+    const locators = await collectLocators(
+      queryRunner,
+      'ai_conversation',
+      "`status` = 'ACTIVE' AND `ai_feedback` IS NOT NULL",
+    );
+    details.push(
+      `  - ai_conversation：ACTIVE 且已有 ai_feedback 的历史会话 ${String(
+        conversationViolations,
+      )} 条（ID：${locators}${conversationViolations > SAMPLE_LIMIT ? ' …' : ''}）`,
+    );
+  }
+
+  const hasClosureReason = await columnExists(queryRunner, 'repair_request', 'closure_reason');
+  const missingClosureReason = hasClosureReason
+    ? '(`closure_reason` IS NULL OR CHAR_LENGTH(TRIM(`closure_reason`)) = 0)'
+    : '1 = 1';
+  const closureWhere =
+    "`handling_result` IN ('INTERRUPTED', 'UNREPAIRABLE') AND " + missingClosureReason;
+  const closureViolations = toCount(
+    (await queryRunner.query(
+      `SELECT COUNT(*) AS total
+         FROM \`repair_request\`
+        WHERE ${closureWhere}`,
+    )) as ReadonlyArray<CountRow>,
+  );
+  if (closureViolations > 0) {
+    const locators = await collectLocators(queryRunner, 'repair_request', closureWhere);
+    details.push(
+      `  - repair_request：INTERRUPTED/UNREPAIRABLE 缺少 closure_reason 的历史工单 ${String(
+        closureViolations,
+      )} 条（ID：${locators}${closureViolations > SAMPLE_LIMIT ? ' …' : ''}）`,
+    );
+  }
+
+  if (details.length === 0) {
+    return;
+  }
+
+  throw new Error(
+    '[alter-repair-ai-report] 升级兼容预检失败：既有合法行会被后续约束拒绝，' +
+      '未执行任何 ALTER。\n' +
+      `${details.join('\n')}\n` +
+      '处置约束：不得编造 closure_reason，不得静默改评分，也不得把历史工单当作新工单；' +
+      '历史身份标记（持久标记 + 冻结 ID 集合）方案确认前，本迁移不解除新行原因要求。',
+  );
+}
```

### 12.3 评分与输入限制的分层

| 层                  | 规则                                                       | 位置                                         |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| 数据库              | `ai_helpfulness` 保持 `1—5`；旧值 5 不改写、不迁移、不回填 | 第 27 条既有 CHECK（本轮不再收紧）           |
| 新输入（创建/更新） | `ai_helpfulness` 仅接受 `1—4`                              | `maintenance-report.input.normalize.ts`      |
| 更新历史记录        | 仅当本次未显式改写该字段时，允许库内既有值原样保留（含 5） | `update-maintenance-report-draft.usecase.ts` |
| 读取/投影/提交      | 不做范围校验、不裁剪；5 可正常查询与冻结                   | service / mapper / snapshot 未改             |

- 新增 `MaintenanceReportDraftNormalizeOptions.preservedAiHelpfulness`；显式提交 5 一律拒绝，即使库内也是 5。
- `ai_score` 不受影响，仍为 1—5。

### 12.4 追加修复迁移（第 40 条）

文件：`1775501800000-restore-maintenance-report-helpfulness-range-for-v13.migration.ts`，SHA-256=`2265008f0e708e0644220fee72a8eb42b9a339ec588573bfb913503a3970889b`。

| 项       | 设计                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 目标     | 已执行旧版第 32 条（1—4）的库恢复为 1—5，与新建/31 态升级终态一致             |
| 动作     | 单条 `ALTER`：存在则 `DROP CONSTRAINT` 后 `ADD CONSTRAINT`，不存在则只 `ADD`  |
| 幂等     | 先查 `information_schema.TABLE_CONSTRAINTS`；重复执行无副作用                 |
| 数据     | 不改任何行、不改列、不碰 `ai_score`                                           |
| `down`   | 有意不回退：重新收紧会让旧值 5 不可用                                         |
| 结构预检 | 只 DROP/ADD 同名约束，迁移产物解析不新增对象，31 态与新建路径不会被误判半迁移 |
| 失败语义 | 保留原始错误并说明可重跑；MySQL DDL 隐式提交由单条 ALTER 原子性兜底           |

三条路径终态：新建（第 27 条 1—5 + 第 32 条 DROP/ADD 1—5 + 第 40 条 DROP/ADD 1—5）、31 态升级（同）、已执行旧版（第 40 条恢复 1—5）→ 约束名与表达式一致。

### 12.5 历史身份方案（子项暂停，待确认）

本轮**未**放宽 `chk_repair_request_closure_reason`，也未解除新行原因要求；B 场景仍被拦截（现改为在本次迁移任何 ALTER 之前以预检失败关闭）。原因：持久标记字段与冻结 ID 集合尚未确认。

建议方案（需批准后才实现）：

| 要素     | 建议                                                                                                           | 待确认                                       |
| -------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 字段     | `repair_request.is_historical tinyint(1) NOT NULL DEFAULT 0`（主表持久标记，非生成列）                         | 字段名/类型/是否暴露给应用层                 |
| 集合来源 | 升级前从 31 态 `repair_request` 导出全量 `id` 与行指纹，形成受版本控制的冻结清单；迁移用临时表与清单比对后赋值 | 冻结时间边界、清单格式与存放位置             |
| 赋值规则 | 仅对清单内且升级前已存在的行置 `1`；新行默认 `0`，应用层不可写 `1`                                             | 是否需要 `updated_at`/操作人审计             |
| 约束形式 | `handling_result NOT IN ('INTERRUPTED','UNREPAIRABLE') OR closure_reason IS NOT NULL OR is_historical = 1`     | 是否同时允许 `closure_status/closed_at` 为空 |
| 禁止     | 不用 `intake_id IS NULL`、`current_revision_no = 0`、时间戳猜测作为历史证明                                    | —                                            |
| 兼容     | 已执行旧版第 32 条的库需在新追加迁移中补列并重建约束，三条路径一致                                             | 是否合并进同一条追加迁移                     |

### 12.6 其他旧合法组合的复核

| 组合                                                               | 31 态是否合法        | 第 32 条是否拒绝                                                    | 本轮处置                             |
| ------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| `maintenance_report.ai_helpfulness = 5`                            | 合法                 | 旧版拒绝；修正后通过                                                | 已修复                               |
| `ai_conversation.status='ACTIVE'` 且已有 `ai_feedback`             | 合法（无写入者）     | 拒绝                                                                | 仅前置预检并如实失败；未放宽，待裁决 |
| `repair_request` 的 `INTERRUPTED/UNREPAIRABLE` 无 `closure_reason` | 合法（字段尚不存在） | 拒绝                                                                | 仅前置预检并如实失败；待历史身份方案 |
| 其余新增 CHECK/UNIQUE/FK                                           | —                    | 逐条核对不拒绝 31 态合法行（NULL 允许、集合放宽、唯一键含 NULL 列） | 不改写数据                           |

### 12.7 回归覆盖

| 验收项                | 覆盖方式                                                          | 结果           |
| --------------------- | ----------------------------------------------------------------- | -------------- |
| 旧评分 5 升级后保留   | 实库规格 `a_ai5` 改为期望 SUCCESS + 原值 5 + 约束 1—5（下轮执行） | 待实库         |
| 新输入 5 被应用层拒绝 | `maintenance-report-usecases.spec.ts` 单测                        | 通过           |
| 历史 5 未改写时可保留 | 同上（`preservedAiHelpfulness`）                                  | 通过           |
| 显式写 5 仍拒绝       | 同上                                                              | 通过           |
| 追加迁移幂等与范围    | `maintenance-report-helpfulness-range.migration.spec.ts`          | 通过           |
| 旧中断无原因获兼容    | 方案暂停，未实现                                                  | 未覆盖         |
| 新流程缺原因被拒绝    | 约束未改，行为保持                                                | 由既有约束保障 |
| 三路径终态一致        | 线下结构论证 + 下轮实库三库比对                                   | 待实库         |

离线检查：`tsc`（src/spec）通过；完整单测 141 套件通过 / 9 套件按门跳过（1664 用例通过、182 跳过）；文件级 ESLint 0 error（2 条既有 warning）；Prettier 全部通过；`git diff --check` 干净。

### 12.8 下一轮实库需求与最小授权

| 目标库                            | 用途               | 期望                        |
| --------------------------------- | ------------------ | --------------------------- |
| `lithography_v13_upg32_ctrl`      | 31 态无风险样本    | 成功；40 条历史；约束 1—5   |
| `lithography_v13_upg32_a_ai5`     | 31 态 + 旧评分 5   | 成功；原值 5 保留；约束 1—5 |
| `lithography_v13_upg32_b_closure` | 31 态 + 中断无原因 | 预检失败；0 DDL；历史 32    |
| `lithography_v13_upg32_fresh`     | 空库全新建         | 40 条；约束 1—5             |
| `lithography_v13_upg32_legacy32`  | 已执行旧版第 32 条 | 第 40 条后与 fresh 结构一致 |

`legacy32` 的前置依赖：仓库内已无旧版文件，唯一忠实构造方式是使用哈希为 `bb28ca2c…` 的字节快照重放旧语句并按 TypeORM 语义记录历史。该快照与历史记录方式需单独批准；未批准前不构造、不伪造迁移历史。

最小授权文字（逐项勾选后生效）：

> 授权在 `<host>` 上创建上表 5 个隔离空库，仅运行默认关闭的升级/新建规格；允许为 `legacy32` 使用哈希 `bb28ca2c…` 的旧版第 32 条字节快照重放（含按其类名写入迁移历史），仅用于本次兼容验证；不得手工改写业务数据、不得跳过或删除迁移、不得对 ctrl/A/B 现场执行任何操作；失败保留现场，不 commit、不 push。

## 13. S5 合并阻塞集中修复方案（本轮）

### 13.0 工作区核对结论

| 已完成（本轮不重复实现）                                                      | 证据                                                                                                                         |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 新输入 AI 有用性 1—4；库内 1—5；历史 5 未显式修改时保留                       | `maintenance-report.input.normalize.ts`、`update-maintenance-report-draft.usecase.ts`、`maintenance-report-usecases.spec.ts` |
| 1775501800000 将有用性约束恢复为 1—5                                          | `1775501800000-restore-maintenance-report-helpfulness-range.migration.ts`                                                    |
| 1775501100000 已在任何 ALTER 前对 A/B 做兼容预检并失败关闭                    | `assertLegacyDataCompatible`                                                                                                 |
| 新表实体、`lithography.module.ts` 注册与 `api-entity-metadata.spec.ts` 已存在 | 源码                                                                                                                         |
| 管理员初始化、专用清理、三路径实库规格已有骨架                                | `admin-bootstrap.ts`、`e2e-scoped-cleanup.ts`、`v13-upgrade-from-31-state.realdb.spec.ts`                                    |

本轮只处理尚未覆盖的 F1—F5、历史身份、闭单兼容、管理员真实角色、专用清理闭包、结构校验与 SOP；不回退上述已完成修复。

### 13.1 表 A：目标字段与约束

| 需求依据             | 现状                                                                    | 目标                                                                                                                                                                                                                                                  | 旧数据处理                                                                         | 消费者                                 | 验收                                                      |
| -------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| 4.10 公司备份计划    | `local_company_setting` 无 8 列                                         | 补 `initialized_at`、`backup_interval_hours`、`backup_enabled`、`next_backup_at`、`last_auto_success_at`、`last_auto_failure_at`、`failure_reason`、`auto_upload_enabled`；`chk_backup_interval > 0`                                                  | `initialized_at=created_at`；周期 72；新行默认 TRUE/FALSE；`next_backup_at` 见 Q11 | 无现有读写方                           | 空表可插完整行；周期 0 被拒；旧行回填与 `created_at` 一致 |
| 4.19 离线资格        | 授权表无签名凭据三列                                                    | 补 `signed_claims json NULL`、`permission_version int unsigned NULL`、`last_verified_at timestamp(3) NULL`；三值同空或同满；版本 >=1                                                                                                                  | 历史行保持三 NULL，不伪造签名、不以 `authorized_at` 冒充核验                       | 无现有读写方                           | 三空/三满合法；半套被拒；版本 0 被拒                      |
| 4.7/4.12 同步回执    | 唯一键含 `source_system`，缺安装来源/远端资源/接收时间                  | 补 `source_installation_id char(36) NOT NULL`、`remote_resource_id varchar(64) NULL`、`received_at timestamp(3) NULL`；唯一键改四列 `(organization_id, resource_type, record_uuid, version_no)`                                                       | 表预期 0 行；非空即失败关闭；重复组先扫描，不合并、不删除                          | 无现有读写方                           | 同四列不同来源被拒；重复组在 DDL 前中止                   |
| 4.15 备份资产        | 仅 `storage_reference`/`file_sha256` 等                                 | 补 `installation_id`、`format_version`、`data_version`、`manifest_checksum`、`local_reference`、`cloud_reference`、`encryption_key_id`、`verified_at`、`retention_until`、`failure_reason`、`deleted_at`、`local_cleanup_error`；三条 CHECK；安装索引 | 表预期 0 行；非空即失败关闭；不从 `storage_reference` 猜云端地址                   | 无现有读写方                           | 清理态与本地引用/删除时间互斥；摘要长度 64；版本 >=1      |
| 4.15 恢复运行        | 保护包 NOT NULL、`started_at` NOT NULL、缺目标安装/检查结果/确认        | 保护包与 `started_at` 可空；补 `target_installation_id NOT NULL`、`check_status NOT NULL`、`confirmation json NULL`；状态补 PENDING；CASE 执行门                                                                                                      | 表预期 0 行；非空即失败关闭；`check_status` 见 Q13                                 | 无现有读写方                           | PENDING 无保护包；RUNNING 必须有保护包/确认/开始时间      |
| 4.5 故障原始事实     | `status/source` 与生命周期混用；无原始八字段、`phase_code`、`is_active` | 生命周期列改名；补 `main_error`、`unit_error`、`error_type`、`gpib_status`、`status`、`source`、`phase_code`、`is_active`；`description`/`action` 复用现有列；不新增 `(report_id,step_code)` 唯一键                                                   | 改名保留原值；原始列 NULL；表非空即失败关闭（无法证明当前分支）                    | 无现有读写方                           | 原始文本不影响生命周期；生命周期越界被拒；超长被拒        |
| Q7/Q9 工单闭单与历史 | 原因约束拒历史行；闭单 CHECK 存在 UNKNOWN 漏洞                          | `repair_request.is_historical` 持久标记；冻结 ID 集合外一律新行；闭单 CHECK 改 `CASE ... ELSE FALSE`；原因约束对历史行豁免                                                                                                                            | 冻结清单在库外；迁移只在集合命中时置 1；不编造原因、不改旧评分                     | 工单读取/处置/管理修订                 | 双 NULL 合法；单边 NULL 与非法组合 FALSE；历史行豁免      |
| 4.6 管理员           | 以 `guest` 事实创建 `SUPER_ADMIN`；无组织成员事实；静默 UNCHANGED       | 复用 `convergeAccountRole` + 字段加密；写 `SUPER_ADMIN` 角色事实与 ACTIVE `organization_membership`；无效角色事实明确拒绝                                                                                                                             | 不重置密码；不覆盖冲突身份；既有角色事实无效即拒绝                                 | 登录/权限/管理 Query                   | 真实登录、首改密、受保护 Query、合法管理、越权拒绝        |
| 专用清理             | 仅按父关系/前缀清理，缺引用闭包                                         | ByIds 与 Residue 共用同连接同事务许可+目标+所有权+引用闭包预检；集合外引用拒绝                                                                                                                                                                        | 未登记子行不认领；残留恢复不凭前缀/父关系取得所有权                                | read/accept/production-input/ownership | 零破坏、事实漂移、合法清理、重复执行、后序回滚、异常关闭  |
| 结构校验             | 仅列存在/NOT NULL；索引列序；FK 列序；CHECK 仅存在                      | 校验类型/长度/符号/NULL/默认/生成表达式；索引唯一性与列序；FK 列序与规则；CHECK 规范化定义；负例证明拒绝漂移                                                                                                                                          | 不全局小写、不去括号；字符串与 JSON 路径保持原样                                   | 部署校验入口                           | 结构同名不同定义被拒；规范化不掩盖真实漂移                |

### 13.2 表 B：三路径迁移顺序

| 路径               | 顺序与处置                                                                                                                                                                  | 版本处置                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 全新空库           | 1—31 → 1775501000000 → 1775501100000（新体：先建 `is_historical` 再建原因约束）→ 1775501200…1800 → 1775501900000（F1—F5 与终态补齐）                                        | 1775501100000 改名不变、只改体内；新迁移追加在 1800000 之后                            |
| 31 态旧库          | 先由获授权人导出并签字“完整”的真实工单 ID/行指纹清单（库外，不进 Git）→ 1775501000000 → 1775501100000（部署入口注入清单；先标记历史再建原因约束）→ 追加迁移至 1775501900000 | 清单格式、校验器与合成样例进 Git；真实清单不进 Git                                     |
| 已执行旧版增量的库 | 迁移历史停在旧 1775501100000/1200…1800 → 直接执行 1775501900000：补 `is_historical`、按清单标记、重建闭单/原因约束，再补 F1—F5；终态与上两条逐列/逐约束一致                 | 不手工插入/伪造 migrations；不复用旧行为库作证据；必要时用可验证旧字节与正常执行器重建 |

约束：末尾追加迁移不能修复“前序迁移已经失败”的库；旧版库必须已经成功执行到 1800000，或按可验证旧字节与正常执行器重建后再续跑。

### 13.3 表 C：直接消费者

| 消费者              | 落点                                                                             | 本轮处置                                                     |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| API/Worker 实体装配 | `lithography.module.ts`、`autoLoadEntities`、`api-entity-metadata.spec.ts`       | 补新列后保持实体注册与元数据规格通过                         |
| 旧公开入口          | `RecordRepairRequestHandlingResultUsecase`                                       | 明确新流程原因校验；历史行不编造；不以数据库异常代替业务处理 |
| 报告提交/草稿       | `maintenance-report.service.ts`、`update-maintenance-report-draft.usecase.ts`    | 新输入 1—4、历史 5 保留；原因非空白                          |
| 读取 Query          | `repair-request.query.service` 及其规格                                          | 补 `isHistorical`/闭单字段读取兼容                           |
| Seed/管理员         | `database-deploy` 的 CLIENT 组织、`admin-bootstrap.ts`                           | 真实角色事实、ACTIVE 组织成员、幂等校验                      |
| 测试 fixture        | `repair-request-fixture.ts`                                                      | 历史/新入口样本、原因与闭单组合                              |
| 专用清理            | `e2e-scoped-cleanup.ts`、清理规格                                                | ByIds 与 Residue 双入口、引用闭包、事务内预检                |
| 恢复入口            | `backup_restore_run` 未来写入方                                                  | 预检允许无保护包；执行阶段应用层强制保护包、确认与开始时间   |
| 同步/备份/资料包    | 暂无写入方                                                                       | 只补结构与契约；不新增执行器                                 |
| 结构校验/文档       | `migration-schema-contract.ts`、`incremental-migration.ts`、SOP、`docs/database` | 补定义校验、负例与稳定入口说明                               |

### 13.4 表 D：剩余裁决

| 问题                                                                                    | 推荐方案                                                                                                             | 实际影响                                                                        |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Q11 `local_company_setting.next_backup_at` 旧行是否按 `initialized_at + 72h` 派生？     | 不派生：列保持可空，历史行 `backup_enabled=FALSE`、`next_backup_at=NULL`；新行由应用层写入非空值                     | 旧行不会被自动排程或自动上云；数据库不能对历史行 `NOT NULL`；新流程需应用层保障 |
| Q13 `backup_restore_run.check_status` 与 `maintenance_report_fault.phase_code` 精确枚举 | `phase_code` 采用既有十阶段 `PHASE_01…PHASE_10`；`check_status` 建议 `PENDING/PASSED/FAILED`（或与恢复预检结论同域） | 未定前两条列先落列但不加域 CHECK，避免凭猜测拒绝合法值；确认后再追加域约束      |

已裁决、本轮不重开：Q12 历史签名三空（用户明确“不伪造旧签名”）；Q14 批准原地修改 1775501100000；Q15 采用 O1 主表持久标记 + 库外冻结 ID 集合。

### 13.5 本轮实施落点

| 包   | 文件/动作                                                                                                                                                              | 约束                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A/B  | 修改 `1775501100000-alter-repair-ai-report-for-v13.migration.ts`；新增 `1775501900000-close-s5-structural-gaps-for-v13.migration.ts`；新增库外清单格式/校验器/合成样例 | 1—31 与 1775501000000 不动；其他已执行迁移不改写                     |
| 实体 | 更新 `local-company-setting`、`local-account-authorization`、`sync-receipt`、`backup-asset`、`backup-restore-run`、`maintenance-report-fault`、`repair-request` 实体   | 只加列/改约束映射，不新增业务 service                                |
| C    | `admin-bootstrap.ts` 与管理员规格                                                                                                                                      | 不 import `modules`/`usecases`；只用 core 策略与 infrastructure 加密 |
| D    | `e2e-scoped-cleanup.ts`、fixture 与清理规格                                                                                                                            | 不改迁移、不扩大删除范围                                             |
| E    | `migration-schema-contract.ts`、`incremental-migration.ts`、SOP、`docs/database`                                                                                       | 负例只证明校验能力；不承诺自动恢复                                   |

### 13.6 本轮实现与离线验收结果（2026-11-09）

#### 13.6.1 F1—F5 关闭状态

| 编号  | 目标                                       | 实现落点                                                                                                                                   | 旧数据处置                                                                                                      | 状态                 |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------- |
| F1-1  | 公司备份计划、调度时间、自动上传开关       | 实体 + `1775501900000`：8 列 + `chk_local_company_setting_backup_interval`                                                                 | `initialized_at=created_at`；旧行 `backup_enabled=0`、`next_backup_at=NULL`；不派生                             | 实现完成，待实库验收 |
| F1-2  | 离线资格签名凭据、权限版本、最近校验时间   | 实体 + `1775501900000`：3 列 + 2 CHECK                                                                                                     | 历史行三列保持 NULL；不伪造签名、不以 `authorized_at` 冒充核验                                                  | 实现完成，待实库验收 |
| F1-3  | 同步来源与版本事实、四列唯一键             | 实体 + `1775501900000`：3 列；`uk_sync_receipt_scope_v13(organization_id, resource_type, record_uuid, version_no)`；DDL 前仅扫描真实重复组 | 旧行原地保留；新列保持 NULL；`source_system` 保留为兼容描述且退出唯一键；重复组在首次 DDL 前报告，不合并/不删除 | 实现完成，待实库验收 |
| F1-4  | 备份本地/云端引用、版本、校验、保留与清理  | 实体 + `1775501900000`：12 列 + 3 CHECK + `idx_backup_asset_installation`                                                                  | 旧行原地保留；新增事实列保持 NULL；不从 `storage_reference` 猜云端地址、不由 `file_sha256` 推定清单摘要         | 实现完成，待实库验收 |
| F1-4b | 恢复预检/执行事实                          | 实体 + `1775501900000`：保护包与 `started_at` 改可空；3 列；4 CHECK（含 CASE 执行门）；状态补 `PENDING`；`target_installation_id` FK       | 旧行原地保留；`check_status`/`target_installation_id` 历史未知为 NULL，不自动填 PASSED；执行完整性由应用层保证  | 实现完成，待实库验收 |
| F1-5  | 故障原始八字段、`phase_code`、生命周期分离 | 实体 + `1775501900000`：`status→lifecycle_status`、`source→lifecycle_source`；8 列；4 CHECK；不新增 `(report_id, step_code)` 唯一键        | 旧行原地保留；生命周期原义保留；原始八字段/phase_code/is_active 历史未知为 NULL，不由生命周期转换               | 实现完成，待实库验收 |
| B     | 历史身份与闭单/原因兼容                    | `repair_request.is_historical` + 库外清单；`1775501100000` 先标记后建原因约束；闭单 CASE；原因历史豁免                                     | 只按清单命中置 1；集合外按新行；不编造原因、不改旧评分                                                          | 实现完成，待实库验收 |
| C     | 管理员真实可用性                           | `admin-bootstrap.ts`：真实 SUPER_ADMIN 三源事实、AES-CBC `meta_digest`、ACTIVE 组织成员、幂等与冲突拒绝                                    | 不重置密码、不覆盖冲突身份；既有角色事实无效即拒绝                                                              | 实现完成，待实库验收 |
| D     | 专用清理所有权与引用闭包                   | `repair-request-fixture.ts` + ownership e2e：ByIds 与 Residue 同连接同事务预检                                                             | 未登记子行不认领；集合外引用拒绝；残留恢复不凭前缀/父关系                                                       | 实现完成，待实库验收 |
| E     | 结构校验与交付                             | `migration-schema-contract.ts`、`incremental-migration.ts`、SOP、`docs/database`                                                           | 同名不同定义负例；字符串/JSON 路径保留；不承诺自动恢复                                                          | 实现完成，待实库验收 |

#### 13.6.2 字段与约束落点

新增列中仅 `backup_restore_run.target_installation_id` 建立到 `local_installation` 的外键（见 §13.8 Q16）；其余新增安装标识列不建 FK。

| 表                            | 列                                                                                                                                                                                                                           | 类型/NULL/默认                                                                                                                                                                                                                               | 索引/FK                                                                       | CHECK                                                                                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repair_request`              | `is_historical`                                                                                                                                                                                                              | `tinyint(1) NOT NULL DEFAULT '0'`                                                                                                                                                                                                            | 无                                                                            | 原因约束增加 `is_historical = 1` 豁免；闭单改 `CASE ... ELSE FALSE`                                                                                                                                                            |
| `local_company_setting`       | `initialized_at`、`backup_interval_hours`、`backup_enabled`、`next_backup_at`、`last_auto_success_at`、`last_auto_failure_at`、`failure_reason`、`auto_upload_enabled`                                                       | `timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`；`int unsigned NOT NULL DEFAULT '72'`；`tinyint(1) NOT NULL DEFAULT '0'`；`timestamp(3) NULL`；`timestamp(3) NULL`；`timestamp(3) NULL`；`text NULL`；`tinyint(1) NOT NULL DEFAULT '0'` | 复用既有 `uk_local_company_setting_scope`/FK                                  | `backup_interval_hours > 0`；`backup_enabled = 0 OR next_backup_at IS NOT NULL`；`auto_upload_enabled = 0 OR backup_enabled = 1`                                                                                               |
| `local_account_authorization` | `signed_claims`、`permission_version`、`last_verified_at`                                                                                                                                                                    | `json NULL`；`int unsigned NULL`；`timestamp(3) NULL`                                                                                                                                                                                        | 复用既有 scope/FK                                                             | 三列同空或同满；`permission_version IS NULL OR >= 1`                                                                                                                                                                           |
| `sync_receipt`                | `source_installation_id`、`remote_resource_id`、`received_at`                                                                                                                                                                | `char(36) NULL`（远端来源，不建 FK）；`varchar(64) NULL`；`timestamp(3) NULL`                                                                                                                                                                | 四列唯一键 `uk_sync_receipt_scope_v13`；删除旧 `uk_sync_receipt_scope`        | 保留状态域；`receipt_status IN ('PENDING','CONFLICT') OR received_at IS NOT NULL OR confirmed_at IS NOT NULL`（`chk_sync_receipt_confirm_time` 取代旧 `chk_sync_receipt_confirmed`）                                           |
| `backup_asset`                | `installation_id`、`format_version`、`data_version`、`manifest_checksum`、`local_reference`、`cloud_reference`、`encryption_key_id`、`verified_at`、`retention_until`、`failure_reason`、`deleted_at`、`local_cleanup_error` | 全部 `NULL`（历史未知）；`char(36)/int unsigned/varchar(64)/char(64)` 由新写入者必填                                                                                                                                                         | 新增 `idx_backup_asset_installation(installation_id, created_at)`；不建 FK    | 摘要 `NULL OR 长度 64`；`format_version NULL OR >= 1`；`CLEANED` 时 `local_reference IS NULL`，非 `CLEANED` 时 `deleted_at IS NULL`                                                                                            |
| `backup_restore_run`          | `target_installation_id`、`check_status`、`confirmation`；`protection_backup_id`、`started_at` 改可空                                                                                                                        | `char(36) NULL`；`varchar(16) NULL`；`json NULL`；`char(36) NULL`；`timestamp(3) NULL`                                                                                                                                                       | `fk_backup_restore_run_target → local_installation(installation_id)` RESTRICT | 状态域含 `PENDING`；PENDING 无开始/结束；RUNNING 有开始无结束；CASE 执行门：PENDING 无保护包/确认，执行态须开始时间+保护包；`check_status NULL OR IN ('PENDING','PASSED','FAILED')`；`check_status` 与 `status` 的成败组合约束 |
| `maintenance_report_fault`    | `lifecycle_status`、`lifecycle_source`（重命名）；`main_error`、`unit_error`、`error_type`、`gpib_status`、`status`、`source`、`phase_code`、`is_active`                                                                     | `varchar(16) NOT NULL` ×2；`varchar(300) NULL` ×6；`varchar(32) NULL`；`tinyint(1) NULL`                                                                                                                                                     | 无新增索引/FK                                                                 | 生命周期状态与来源值域；描述/动作长度上限（NULL 安全）；`phase_code NULL OR IN (PHASE_01…PHASE_10)`；`is_active NULL OR IN (0,1)`                                                                                              |

#### 13.6.3 三路径与版本处置

| 路径               | 实际顺序                                                                                                                                                                  | 版本处置                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 全新空库           | 1—31 → `1775501000000` → `1775501100000`（先建 `is_historical`，再建闭单/原因约束）→ `1775501200000`…`1775501800000` → `1775501900000`（F1—F5；检测到列已存在则跳过标记） | 只改 `1775501100000` 体内；新增 `1775501900000` 追加在末尾       |
| 31 态旧库          | 获授权人导出并签字真实清单（库外）→ `1775501000000` → `1775501100000`（部署入口注入清单；先标记历史再建原因约束）→ … → `1775501900000`                                    | 清单格式/校验器/合成样例进 Git；真实清单不进 Git                 |
| 已执行旧版增量的库 | 迁移历史停在旧 `1775501100000`/`1775501200000`…`1775501800000` → 直接执行 `1775501900000`：补 `is_historical`、按清单标记、重建闭单/原因约束，再补 F1—F5                  | 不手工插入/伪造 migrations；旧版重建使用可验证旧字节与正常执行器 |

约束重申：末尾追加迁移不能修复“前序迁移已失败”的库；旧版库必须已成功执行到 `1775501800000`，或按可验证旧字节重建后继续。

#### 13.6.4 直接消费者适配

| 消费者          | 本轮适配                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工单处置写入    | `maintenance-report-command.types.ts`、`maintenance-report.input.normalize.ts`、`record-repair-request-handling-result.usecase.ts`、`maintenance-report.service.ts`：`closureReason` 必填/禁填与去空白校验 |
| 工单读取        | `repair-request.query.service.spec.ts`：补 `isHistorical` 读取兼容                                                                                                                                         |
| 报告草稿/提交   | 既有 1—4 输入与历史 5 保留逻辑不变；新增原因校验不外溢到非中断/无法修复结果                                                                                                                                |
| 部署入口        | `database-deploy.ts`：`--legacy-repair-manifest`；每次运行先重置进程内清单，避免串用                                                                                                                       |
| 测试 fixture    | `repair-request-fixture.ts`、`repair-request-fixture-ownership.e2e-spec.ts`：ByIds/Residue 共用所有权与引用闭包                                                                                            |
| 专用清理        | `e2e-scoped-cleanup.ts`、`e2e-scoped-cleanup.v13*.spec.ts`：按新必需列写入；清理范围不扩大到集合外                                                                                                         |
| 实库规格        | `v13-db-verification.spec.ts`：同步回执四元组唯一、新必需列、lifecycle 字段；`v13-upgrade-from-31-state.realdb.spec.ts`：注入内存清单、`is_historical` 探测、`b_closure` 改为成功                          |
| 管理员          | `admin-bootstrap.ts`：部署编排；`password-hashing.policy.ts`、`field-encryption.cipher.ts` 复用登录/加密算法，不另造平行机制                                                                               |
| API/Worker 装配 | 实体列扩展，注册与元数据规格保持不变；无新增 service/执行器                                                                                                                                                |

#### 13.6.5 精确修改清单

- 迁移：修改 `1775501100000-alter-repair-ai-report-for-v13.migration.ts`（授权范围内）；新增 `1775501900000-close-s5-structural-gaps-for-v13.migration.ts`。
- 库外清单：新增 `legacy-repair-identity-manifest.ts`、`legacy-repair-identity-manifest.sample.json`；真实清单不入库。
- 结构校验：`migration-schema-contract.ts`、`incremental-migration.ts` 及两份规格。
- 实体：`repair-request`、`local-company-setting`、`local-account-authorization`、`sync-receipt`、`backup-asset`、`backup-restore-run`、`maintenance-report-fault`。
- 用例与模块：`maintenance-report-command.types.ts`、`maintenance-report.input.normalize.ts`、`record-repair-request-handling-result.usecase.ts`、`maintenance-report.service.ts` 及规格。
- 管理员：`admin-bootstrap.ts`、`password-hashing.policy.ts`、`field-encryption.cipher.ts`、`field-encryption.service.ts`、`account.service.ts`、`legacy-password-crypto.helper.ts`、`admin-bootstrap.realdb.spec.ts`。
- 清理与 fixture：`repair-request-fixture.ts`、`repair-request-fixture-ownership.e2e-spec.ts`、`e2e-scoped-cleanup.ts`、`e2e-scoped-cleanup.v13*.spec.ts`。
- 实库规格：`v13-db-verification.spec.ts`、`v13-upgrade-from-31-state.realdb.spec.ts`。
- 部署与文档：`database-deploy.ts`、`S3-deployment-sop.md`、`S2-db-verification-specs.md`、`docs/database/README.md`。

#### 13.6.6 离线命令与结果

| 命令                                         | 结果                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run typecheck`                          | 通过（build + tools）                                                             |
| `npx tsc -p tsconfig.spec.json --noEmit`     | 通过                                                                              |
| `npm run capability:docs:check`              | 通过                                                                              |
| `npm run lint:usecase-normalize-guard`       | 通过                                                                              |
| `npm run lint:architecture-fixtures`         | 通过                                                                              |
| `npm run build`                              | 通过                                                                              |
| 全量后端单测                                 | `Test Suites: 9 skipped, 141 passed (141/150)`；`Tests: 188 skipped, 1671 passed` |
| 本批 35 个 TS 文件 `eslint --quiet --no-fix` | 0 error                                                                           |
| 本批 35 个 TS 文件 `prettier --check`        | 全部符合                                                                          |
| `git diff --check`                           | 退出 0                                                                            |
| 31 条基线迁移逐文件 SHA-256                  | 31/31 与 S4 一致，0 变更                                                          |
| S4 冻结 39 条逐文件 SHA-256                  | 38/39 一致；唯一差异为获授权的 `1775501100000`（体内调整）                        |
| `npm run check:entity-scope`                 | 退出 0，但 `HEAD=base=72de109…`，属空提交区间                                     |

`check:entity-scope` 说明：该命令比较 `origin/main...HEAD`，本轮未提交，因此退出 0 **不能证明未提交改动合规**。实际覆盖以 `git diff --stat origin/main -- backend/src/modules/lithography/entities backend/src/infrastructure/database/migrations` 为准：9 个实体文件与迁移文件有改动/新增。

#### 13.6.7 本轮未运行项

- 未连接实库、未建库、未迁移、未造数、未启动 API/Worker、未操作 Redis；未运行完整 core；未创建验证库。
- 未暂存、未 commit、未 push；保留全部修改、未跟踪文件与 3 个 stash。

### 13.7 剩余裁决与下一批实库验收

#### 13.7.1 仍未决定的最少问题

| 编号 | 问题                                                                                                                                                                     | 推荐方案                                                                                                                                       | 实际影响                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Q11  | `local_company_setting.next_backup_at` 旧行是否允许按 `initialized_at + backup_interval_hours` 派生？                                                                    | 不派生：列保持可空，旧行 `backup_enabled=FALSE`；新流程由应用层保证扫描时有值                                                                  | 数据库无法对旧行强约束；旧行不会自动排程/上云                               |
| Q13  | `backup_restore_run.check_status` 与 `maintenance_report_fault.phase_code` 的精确枚举                                                                                    | `phase_code` 采用既有十阶段 `PHASE_01…PHASE_10`；`check_status` 建议 `PENDING/PASSED/FAILED`                                                   | 未定前两列只落列、不加域 CHECK；确认后追加域约束                            |
| Q16  | 新增安装标识列（`sync_receipt.source_installation_id`、`backup_asset.installation_id`、`backup_restore_run.target_installation_id`）是否补 FK 到 `local_installation`？  | 建议补 `ON DELETE RESTRICT ON UPDATE RESTRICT`，与 `local_company_setting` 既有 FK 一致；需先确认写入顺序保证安装行先存在                      | 当前无 FK，数据库不阻止孤儿安装标识；补 FK 会约束导入/恢复写入顺序          |
| Q17  | `sync_receipt.source_system`、`receipt_status`、`confirmed_at` 等兼容列是否长期保留？                                                                                    | 保留为兼容描述列，不参与四列唯一键；在字段字典标注“非设计列”                                                                                   | 同一版本不会再因来源拆行；但列名与设计不同，读取方需按兼容映射理解          |
| Q18  | 旧版增量库若已有 `sync_receipt`/`backup_asset`/`backup_restore_run`/`maintenance_report_fault` 行，是否接受“停写窗口人工归档成空表”作为唯一升级路径，或允许可空/可回填？ | 推荐先接受“空表”作为 S5 合并前提：这些行无法在不猜测的前提下补齐安装来源、原始故障字段；若要保留历史行，需单独授权定义回填来源并把相应列改可空 | 旧库升级需要额外停写与归档步骤；否则迁移在 DDL 前拒绝（数据不丢，但不升级） |

已裁决、不重开：Q12 历史签名三空；Q14 原地修改 `1775501100000`；Q15 历史身份 O1；`setting_source/is_current` 保留为兼容描述。

#### 13.7.2 下一批集中实库验收方案

顺序固定为：三路径升级 → 管理员真实链路 → 约束/专用清理/直接消费者 → 最终 KEEP 完整 core。每阶段通过后才进入下一阶段；失败保留现场，不自动清库、不回退 DDL。

| 阶段 | 内容                                                                 | 通过门槛                                                                     |
| ---- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1    | 全新空库、31 态 ctrl/A/B/D、旧版增量已执行库分别升级                 | 终态逐列/逐索引/逐 CHECK 一致；`is_historical` 只命中清单；无半迁移          |
| 2    | 管理员真实链路：登录、首次改密、受保护 Query、合法管理操作、越权拒绝 | 三源角色事实收敛；成员关系唯一有效；不出现 guest 派生的 SUPER_ADMIN          |
| 3    | 约束矩阵、ByIds/Residue 专用清理、直接消费者读写                     | 非法组合被拒；集合外引用拒绝；零破坏、漂移、重复执行、后序失败回滚、异常关闭 |
| 4    | 最终 KEEP 完整 core                                                  | 仅在阶段 1—3 全部通过后运行一次                                              |

#### 13.7.3 最小授权

> 授权在指定测试主机创建 5 个隔离空库（全新、31 态 ctrl、31 态 A、31 态 B、31 态 D；旧版增量另用可验证旧字节重建的隔离库），仅运行默认关闭的升级/新建/管理员/清理规格；允许注入获授权人签字的真实历史工单清单副本（仅内存/临时目录，不提交 Git）；允许为旧版重建使用仓库记录的旧字节快照并按正常迁移执行器记录历史；不得手工改写业务数据、不得跳过或删除迁移、不得对生产库执行任何操作；失败保留现场，不 commit、不 push。

> 上表 Q11/Q13/Q16/Q17/Q18 已由 §13.8 裁决替换，以 §13.8 为准；Q18 不再采用“先归档清空业务表才能升级”。

### 13.8 S5 剩余裁决落实与最终离线收口（2026-11-09）

#### 13.8.1 Q11/Q13/Q16/Q17/Q18 落实表

| 编号 | 最终裁决                                                                                                                                                                                                                                                                          | 代码/结构落点                                                                                                                                                            | 数据库责任                                                                        | 应用责任                                                                                                                         | 状态                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Q11  | 旧公司配置不派生 `next_backup_at`；旧行 `backup_enabled=0`、`next_backup_at=NULL`；迁移不自动开启备份或上传；新流程启用备份时必须建立下一次执行时间                                                                                                                               | `local_company_setting` 8 列；`chk_local_company_setting_backup_schedule`、`chk_local_company_setting_auto_upload`；默认 `backup_enabled='0'`、`auto_upload_enabled='0'` | 拒绝“启用备份但无下次执行时间”和“自动上传但未启用备份”的组合                      | 新流程写入 `next_backup_at`；调度器只扫描 `backup_enabled=1 AND next_backup_at IS NOT NULL`                                      | 实现完成，待实库验收 |
| Q13  | `phase_code` 使用 `PHASE_01`—`PHASE_10`；`check_status` 使用 `PENDING/PASSED/FAILED`；NULL 表示历史未知；旧行不自动填 PASSED                                                                                                                                                      | `chk_maintenance_report_fault_phase_code`、`chk_maintenance_report_fault_active`；`chk_backup_restore_run_check_status`、`chk_backup_restore_run_check_outcome`          | 拒绝域外值与“失败/中断却 PASSED”“成功却 FAILED”等冲突组合；NULL 合法              | 新流程必须显式写入 `check_status`、`phase_code`、`is_active`；读取层把 NULL 视为未知，不得视为通过                               | 实现完成，待实库验收 |
| Q16  | 不统一添加安装标识 FK，逐字段核对：`sync_receipt.source_installation_id` 为远端来源（不建 FK、可空）；`backup_asset.installation_id` 语义仍可能为资产来源机器（不建 FK、可空）；`backup_restore_run.target_installation_id` 为当前恢复目标本机（建既有实体 FK、可空以容纳历史行） | `fk_backup_restore_run_target → local_installation(installation_id)` RESTRICT；其余两列仅索引/普通列                                                                     | 目标安装非空时必须存在；远端来源不因本机未登记被拒绝                              | 恢复执行前必须写入已登记目标安装；导入远端回执不得伪造本机安装行                                                                 | 实现完成，待实库验收 |
| Q17  | 保留 `source_system` 兼容列但不参与四列唯一键；`receipt_status` 是有效状态；`received_at` 是设计事件时间；`confirmed_at` 是旧版确认事件时间（仅兼容/历史）                                                                                                                        | `uk_sync_receipt_scope_v13(organization_id, resource_type, record_uuid, version_no)`；`chk_sync_receipt_confirm_time` 取代旧 `chk_sync_receipt_confirmed`                | 唯一键只保证四列不重复；确认事件允许 `received_at` 或历史 `confirmed_at` 任一存在 | 新写入只写 `receipt_status` + `received_at`，不无依据双写 `confirmed_at`；读取层以 `receipt_status` 为状态、`received_at` 为时间 | 实现完成，待实库验收 |
| Q18  | 旧行原地保留：不删除、不移出、不猜测新字段；无法证明的事实保留历史未知（NULL）；新流程仍按确认规则保证完整性；不采用“先归档清空才能升级”                                                                                                                                          | `1775501900000` 仅做加列/改名/约束替换；唯一预检为真实冲突（四列重复组）；四表旧列原值不改                                                                               | 只拒绝无法合法保留的真实冲突；不自动修复、不合并、不清表                          | 新写入者按本表“新写入约束”填写；读取层把 NULL 视为未知，不视为成功/授权                                                          | 实现完成，待实库验收 |

#### 13.8.2 非空旧数据兼容（四表逐项）

| 表                         | 旧字段 → 新字段                                                                                                                                                                                            | 可靠回填来源                                                                                       | 未知时表示                                 | 新写入约束（应用层）                                                                                                                                                               | 读取兼容                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `sync_receipt`             | `record_uuid/organization_id/resource_type/version_no/source_system/manifest_checksum/receipt_status/confirmed_at` 原值保留；新增 `source_installation_id`、`remote_resource_id`、`received_at`            | 无（不从 `confirmed_at` 复制到 `received_at`，不猜远端安装/资源 ID）                               | 新列 NULL；`confirmed_at` 可空             | 四列唯一范围 + `source_system` 兼容描述；状态变化写 `receipt_status`，接收时间写 `received_at`；远端来源可写未在本机登记的值                                                       | 以 `receipt_status` 为状态、`received_at` 为时间；`confirmed_at` 仅历史兼容                                |
| `backup_asset`             | `storage_reference/file_sha256/byte_size/cloud_status/local_status/cloud_receipt/attempt_count/last_attempt_at` 原值保留；新增 12 列                                                                       | 无（`manifest_checksum` 不由 `file_sha256` 推定，`cloud_reference` 不由 `storage_reference` 推断） | 新列 NULL                                  | 新备份写 `installation_id/format_version/data_version/manifest_checksum/encryption_key_id`；清理成功写 `local_reference=NULL`、`local_status='CLEANED'`，`deleted_at` 由应用层填写 | `local_status='CLEANED'` 且 `local_reference IS NULL` 即可；`deleted_at` NULL 不表示未清理，只表示时间未知 |
| `backup_restore_run`       | `restore_id/backup_id/organization_id/started_by_account_id/status/check_snapshot/started_at/finished_at` 原值保留；`protection_backup_id` 改可空；新增 `target_installation_id/check_status/confirmation` | 无（不自动填 PASSED，不猜目标安装）                                                                | 新列 NULL；旧行 `confirmation` NULL        | 执行阶段必须写 `target_installation_id`（已登记）、`protection_backup_id`、`started_at`、`confirmation`；预检阶段可只写 `check_status='PENDING'`                                   | NULL 的 `check_status` 表示未知，不能当作检查通过；`status` 仍是唯一有效状态                               |
| `maintenance_report_fault` | `status → lifecycle_status`、`source → lifecycle_source`（原值语义不变）；新增 `main_error/unit_error/error_type/gpib_status/status/source/phase_code/is_active`                                           | 无（原始八字段不能由生命周期字段转换；`is_active` 不能由多分支推断）                               | 原始八字段、`phase_code`、`is_active` NULL | 新故障必须显式写 `phase_code`（PHASE_01—10）、`is_active`、原始字段；生命周期单独写 `lifecycle_status/lifecycle_source`                                                            | `lifecycle_*` 是唯一生命周期来源；新 `status/source` 是原始文本；NULL 表示未知                             |

`panel_snapshot`：仅当 JSON 可解析且键/语义可验证时由读取方解析；迁移不解析、不默认其完整或可信，也不据此回填任何新列。

#### 13.8.3 三路径升级顺序与终态一致

| 路径               | 顺序                                                                                     | 终态保证                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 全新空库           | 1—31 → `1775501000000` → `1775501100000` → … → `1775501800000` → `1775501900000`         | 与另外两条路径使用同一迁移清单与同一 `migration-schema-contract` 校验        |
| 31 态旧库          | 导出并签字真实清单（库外）→ 1—31 已存在 → 注入清单 → `1775501100000` … → `1775501900000` | 旧行保留；`is_historical` 仅命中清单；其余结构与全新库一致                   |
| 已执行旧版增量的库 | 历史停在旧版 `1775501100000`/`1775501200000`…`1775501800000` → 直接执行 `1775501900000`  | 旧行保留；新列 NULL；无重复组时结构与全新库一致；有重复组则在首次 DDL 前失败 |

终态一致性由“唯一迁移目录 + 统一结构契约 + 同一部署入口”保证；三库逐列/逐索引/逐 CHECK 对照在下一批实库执行。

#### 13.8.4 升级测试设计（非空旧数据，本轮仅编写）

新增 `s5-remaining-decisions.migration.spec.ts`（离线 FakeQueryRunner），覆盖：

1. 旧回执/备份/恢复/故障行原字段保留，新增列不回填、不删除；
2. 可证明回填仅 `local_company_setting.initialized_at = created_at`；
3. 故障生命周期改名与原始八字段/`phase_code`/`is_active` 分离，互不覆盖；
4. 新流程非法组合被约束（备份调度、自动上传、`phase_code`、`check_status`）；
5. `sync_receipt` 四列重复组在首次 DDL 前拒绝并给出样本；
6. 四条升级路径共用同一迁移与契约（设计约束，实库对照待授权）；
7. 重复执行已成功的部署不重跑迁移（由增量入口待执行清单保证，M05 回归）；
8. 部分 DDL 失败时报告失败步骤、已完成步骤与“不整体回滚”的诊断边界。

不伪造 migrations 历史、不关闭 FK/CHECK、不以清空表作为测试前置。

#### 13.8.5 直接消费者核对

| 消费者                  | 核对结果                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 管理员初始化/真实会话链 | 本轮无结构变化；维持“实现完成，待实库验收”                                                                                                                   |
| 新/旧写入入口           | 四表本轮无应用层执行器；写入约束记入字段字典，后续执行器必须遵守                                                                                             |
| `QueryService`          | 未新增读取路径；现有读取不把 `is_historical`、`check_status`、`is_active` 的 NULL 当作成功/授权                                                              |
| Seed                    | `seed-mock.ts` 不写四表，无影响                                                                                                                              |
| fixture                 | `repair-request-fixture.ts` 不构造四表行，无影响                                                                                                             |
| 专用/通用清理           | `e2e-scoped-cleanup.ts` 的故障归属事实改用 `lifecycle_source`；恢复行 `protection_backup_id` 改可空比较；同步回执归属说明改为四列唯一键 + 兼容来源描述       |
| 清理规格                | `e2e-scoped-cleanup.v13*.spec.ts` 同步改名与列探测；`v13-db-verification.spec.ts` 的恢复夹具改用已登记目标安装，新增“只写 received_at 的 SUCCEEDED 合法”用例 |

#### 13.8.6 本期结构支持与未交付执行器边界

- 本期交付：表结构、约束、实体、结构契约、离线迁移行为规格、清理与 fixture 适配。
- 未交付：真实模型训练、同步执行器、备份/恢复执行器、自动上传调度器、前端页面。读取层不得把结构允许的 NULL 解释为业务成功。

#### 13.8.7 离线验收结果

| 检查                      | 命令                                                                                                       | 结果                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正式类型检查              | `npm run typecheck`                                                                                        | 通过                                                                                                                                                                                                    |
| 工具/规格类型检查         | `npx tsc -p tsconfig.spec.json --noEmit`                                                                   | 通过                                                                                                                                                                                                    |
| 相关单测                  | `jest s5-remaining-decisions / migration-schema-contract / incremental-migration / e2e-scoped-cleanup.v13` | 4 套件 67 用例全部通过                                                                                                                                                                                  |
| 全量后端单测              | `jest --runInBand`                                                                                         | 142 套件通过、1680 用例通过；9 套件 skipped、189 用例 skipped                                                                                                                                           |
| 本批 ESLint（无 `--fix`） | `eslint --no-fix <12 个 TS 文件>`                                                                          | 0 error；仅 2 条既有/api 层级 `max-lines` warning                                                                                                                                                       |
| Prettier                  | `prettier --check <12 个 TS 文件>`                                                                         | 全部通过（Markdown 文档不在本批代码格式门禁内，未做全库重排）                                                                                                                                           |
| 能力/架构门禁             | `capability:docs:check`、`lint:usecase-normalize-guard`、`lint:architecture-fixtures`                      | 全部通过                                                                                                                                                                                                |
| 后端构建                  | `npm run build`                                                                                            | 通过                                                                                                                                                                                                    |
| 空白字符                  | `git diff --check`                                                                                         | 通过（exit 0）                                                                                                                                                                                          |
| 迁移指纹                  | 41 文件逐文件 + 全量聚合                                                                                   | §13.8/附录 B 记录值复算一致                                                                                                                                                                             |
| 实体/迁移范围门禁         | `npm run check:entity-scope`                                                                               | PASS，但 `HEAD=origin/main=72de1096…`，属空提交区间；本轮 v13 文件均为未跟踪/未提交，该结果**不能**证明本轮 Entity/Migration 变更合规。实际覆盖以 `git status` 中未跟踪的实体与迁移文件逐个人工核对为准 |

跳过的 9 套件与 189 用例（以后端实际 jest 日志为准）：

| 套件                                                    | 跳过用例 | 状态                    | 原因                                                             |
| ------------------------------------------------------- | -------- | ----------------------- | ---------------------------------------------------------------- |
| `v13-db-verification.spec.ts`                           | 86       | 部分 skipped（focused） | 需要 `V13_DB_SPECS=1` 与已升级真实库；未启用时其余用例仍离线执行 |
| `incremental-migration.integration.spec.ts`             | 32       | skipped                 | 需要真实 MySQL 与显式开关                                        |
| `admin-bootstrap.realdb.spec.ts`                        | 18       | 部分 skipped（focused） | 需要 `ADMIN_BOOTSTRAP_REALDB_SPECS=1` 与真实库                   |
| `e2e-scoped-cleanup.v13.realdb.spec.ts`                 | 10       | skipped                 | 需要真实 MySQL 与显式开关                                        |
| `admin-set-user-status.concurrency.integration.spec.ts` | 10       | skipped                 | 需要真实 MySQL 与显式开关                                        |
| `maintenance-report.integration.spec.ts`                | 10       | skipped                 | 需要真实 MySQL 与显式开关                                        |
| `repair-request.organization.integration.spec.ts`       | 9        | skipped                 | 需要真实 MySQL 与显式开关                                        |
| `maintenance-report.concurrency.integration.spec.ts`    | 5        | skipped                 | 需要真实 MySQL 与显式开关                                        |
| `record-package-state.migration.realdb.spec.ts`         | 4        | skipped                 | 需要真实 MySQL 与显式开关                                        |
| `local-runtime.concurrency.integration.spec.ts`         | 4        | skipped                 | 需要真实 MySQL 与显式开关                                        |
| `v13-upgrade-from-31-state.realdb.spec.ts`              | 1        | skipped                 | 需要 31 态基线库、清单与显式开关                                 |

合计 9 个整包 skipped（85 用例）+ 2 个部分 skipped 套件（104 用例）= 189 用例；均因未满足实库环境开关，不存在 todo/disabled 之外的其他状态，也没有真实失败被隐藏。

#### 13.8.8 下一批集中实库验收：库清单与授权

| 序号 | 库名                                   | 用途                            | 初始状态                       | 允许操作                                       | 保留方式              |
| ---- | -------------------------------------- | ------------------------------- | ------------------------------ | ---------------------------------------------- | --------------------- |
| 1    | `lithography_v13_fresh`                | 全新空库路径                    | 空库                           | 全量迁移、结构校验                             | 通过后保留 7 天供对照 |
| 2    | `lithography_v13_upg31_ctrl`           | 31 态控制组                     | 31 条基线迁移                  | 注入 ctrl 清单、升级、结构校验                 | 保留现场              |
| 3    | `lithography_v13_upg31_a_ai5`          | 31 态评分 5 场景                | 31 条基线迁移                  | 注入 A 场景样本、升级                          | 保留现场              |
| 4    | `lithography_v13_upg31_b_closure`      | 31 态闭单历史场景               | 31 条基线迁移                  | 注入 B 场景样本、升级                          | 保留现场              |
| 5    | `lithography_v13_upg31_d_conv`         | 31 态会话归属场景               | 31 条基线迁移                  | 注入 D 场景样本、升级                          | 保留现场              |
| 6    | `lithography_v13_incremental_nonempty` | 已执行旧版增量 + 四表非空旧数据 | 旧版增量迁移至 `1775501800000` | 写入四表旧样本、执行 `1775501900000`、结构校验 | 保留现场              |
| 7    | `lithography_v13_admin_chain`          | 管理员真实链路                  | 全量结构                       | 初始化管理员、登录、受保护 Query、越权拒绝     | 保留现场              |
| 8    | `lithography_v13_cleanup_scope`        | 专用清理/消费者                 | 全量结构 + 最小种子            | ByIds/Residue 清理、直接消费者读写             | 保留现场              |

最小授权文字：

> 授权在指定测试主机创建上述 8 个隔离库，仅用于 V13 三路径升级、管理员真实链路、专用清理与直接消费者验收；允许注入获授权人签字的真实历史工单清单副本（仅内存/临时目录，不提交 Git）；允许为旧版增量库使用仓库记录的旧字节快照并按正常迁移执行器记录历史；允许运行默认关闭的实库规格。不得手工改写业务数据、不得跳过/删除迁移、不得关闭 FK/CHECK、不得对生产库执行任何操作；失败保留现场，不 commit、不 push。

#### 13.8.9 仍需用户决定的最少问题

1. `backup_asset.installation_id` 是否可能记录“远端产生备份的机器”？若是，保持不建 FK；若确认只记录本机，可后续追加本机 FK（需单独授权）。
2. `sync_receipt` 旧库若存在同一四列但不同 `source_system` 的历史行，是否接受“预检失败、人工确认后再升级”？迁移不会自动合并或择一保留。

本轮到此停止。

### 13.9 第三轮实库验收结果（2026-11-09，S5 41 态候选）

| 阶段          | 目标                                                      | 结果                                                                        | 证据                                   |
| ------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| 1A 全新库     | `lithography_v13_admin_chain_r2`（fresh_r2 失败现场保留） | PASS：41 条迁移、verify、重复 init 0 迁移、CHECKSUM 无漂移                  | `evidence/33-*`、`34-*`                |
| 1B 31 态升级  | `_upg31_ctrl_r2` / `_a_ai5_r2` / `_b_closure_r2`          | PASS：三库按预期升级；评分 5 保留/新 5 拒绝；旧中断与软删保留               | `evidence/stage1b/`                    |
| 1B 预期拒绝   | `_upg31_d_conv_r2`                                        | 预期拒绝：1100000 兼容预检拦截，history 32、V13 列 0；不计成功路径          | `evidence/stage1b/d-conv-r2.log`       |
| 1C 旧增量非空 | `_incremental_nonempty_r2`                                | PASS：四列重复组首次 DDL 前拒绝；续跑升级成功；旧字段保留、新事实 NULL      | `evidence/stage1c/`                    |
| 1 终态对照    | 三路径                                                    | PASS：列/索引/FK/CHECK/默认/生成表达式逐项一致，diff 为空；重复执行 0 迁移  | `evidence/stage1-parity/`              |
| 2 管理员链路  | `_admin_chain_r2`                                         | PASS：真实 Nest/GraphQL/JWT、合法管理、越权拒绝、幂等、冲突不改写、事务回滚 | `stage2/evidence/`                     |
| 3 约束/清理   | `_cleanup_scope_r2`                                       | PASS：`v13-db-verification` 88/88、`e2e-scoped-cleanup.v13.realdb` 10/10    | `evidence/stage3-*`                    |
| 4 完整 core   | `lithography_e2e`                                         | **BLOCKED**：正式入口预检拒绝；核心未执行                                   | `stage4/evidence/02-stage4-blocked.md` |

阶段4 阻断事实：

- 基线 39 条迁移、业务表全空、无其他连接；升级后 history 40（新增 `1775501800000`），
  `repair_request` 闭单 CHECK 被删且未重建，1900000 其余结构未出现。
- 根因是契约把 `repair_request.is_historical` 登记为 1900000 所有，而当前 1100000 才补该列；
  本库 1100000 由更早字节执行，实际缺列 → 1900000 重建闭单约束时失败，非事务 DDL 留下半迁移现场。
- 未插入 KEEP、未启动阶段4 Redis、未执行任何 core 规格；按指令保留现场，不回退、不手工修复、不清库。

本轮不判定“可以合并”；`lithography_e2e` 升级与 KEEP core、四个直接消费者的运行时验证、
最终独立审查与提交审计均未完成。

---

## 提交后补记：`check:entity-scope` 实测与既有裁决引用（2026-11-10）

本节为追加补记，不改写上方历史结论，也不删除任何失败或事故记录。

- 提交：`f591254e5fde95a81bb2904554ca19bcf0c3fc5c`（父提交 `6283a3f7cf6cd32fc83c5e778a7a1a94cf611ea8`），分支 `feat/database-v13-deploy`。
- 实测命令：`npm run check:entity-scope`；比较区间 `origin/main...HEAD`，即 `72de1096d0a2aa2d62ed55a48ab49ebc3398000a...f591254e5fde95a81bb2904554ca19bcf0c3fc5c`。
- 实测结果：**退出码 1**，输出 `FAIL：origin/main...HEAD 改动了受保护目录，禁止提审`。
- 失败构成：受保护 Entity 目录 26 个文件（17 个 A、9 个 M）；V13 迁移 12 个文件（12 个 A）。合计 **38 个 Entity/Migration 文件**。
- 脚本路径缺陷：受保护迁移目录写为 `backend/src/database/migrations`，该目录不存在；实际迁移目录为 `backend/src/infrastructure/database/migrations`，因此 12 条迁移未被脚本识别。该缺陷不影响下方人工核对覆盖，本轮未修改门禁。
- 既有裁决（引用）：
  - `backend/plans/database-v13-deployment-plan.md` §231：`check:entity-scope` 若仍为旧 PR3 限制，核对已有明确裁决并记“不适用”，不记通过、不为骗绿改脚本。
  - `docs/database/PR0-最终独立终审-20261026/完整PR独立终审报告-20261026.md` §37：该脚本文件头明确为旧 PR3 “禁止改 Entity” 专用门禁，对任务书已授权的 Entity/Migration 改动应记为“不适用的旧范围门禁”，不伪称通过，也不要求撤销已授权变更。
- 结论：`check:entity-scope` 退出 1 **不记为本期通过**，按既有裁决记“不适用”；未修改、未放宽、未删除门禁，未切换 base、未使用空区间、未忽略文件、未扩大白名单。
- 人工核对范围（`git diff --name-status origin/main -- backend/src/modules/lithography/entities backend/src/infrastructure/database/migrations`，共 38 个文件）：

```text
A backend/src/infrastructure/database/migrations/1775501000000-alter-accounts-and-organizations-for-v13.migration.ts
A backend/src/infrastructure/database/migrations/1775501100000-alter-repair-ai-report-for-v13.migration.ts
A backend/src/infrastructure/database/migrations/1775501200000-create-stored-file-and-repair-intake-for-v13.migration.ts
A backend/src/infrastructure/database/migrations/1775501300000-create-report-fault-and-revisions-for-v13.migration.ts
A backend/src/infrastructure/database/migrations/1775501400000-create-local-sync-and-package-for-v13.migration.ts
A backend/src/infrastructure/database/migrations/1775501500000-create-backup-and-audit-for-v13.migration.ts
A backend/src/infrastructure/database/migrations/1775501600000-fix-json-snapshot-version-checks-for-v13.migration.ts
A backend/src/infrastructure/database/migrations/1775501700000-add-record-package-check-and-import-result-states-for-v13.migration.ts
A backend/src/infrastructure/database/migrations/1775501800000-restore-maintenance-report-helpfulness-range-for-v13.migration.ts
A backend/src/infrastructure/database/migrations/1775501900000-close-s5-structural-gaps-for-v13.migration.ts
A backend/src/infrastructure/database/migrations/1775502000000-close-d3-structural-gaps-for-v13.migration.ts
A backend/src/infrastructure/database/migrations/1775502100000-add-repair-request-revision-previous-version-for-v13.migration.ts
M backend/src/modules/lithography/entities/ai-conversation.entity.ts
A backend/src/modules/lithography/entities/ai-message-analysis.entity.ts
M backend/src/modules/lithography/entities/ai-message.entity.ts
A backend/src/modules/lithography/entities/backup-asset.entity.ts
A backend/src/modules/lithography/entities/backup-restore-run.entity.ts
A backend/src/modules/lithography/entities/intake-analysis-attempt.entity.ts
A backend/src/modules/lithography/entities/local-account-authorization.entity.ts
M backend/src/modules/lithography/entities/local-backup-run.entity.ts
A backend/src/modules/lithography/entities/local-company-setting.entity.ts
M backend/src/modules/lithography/entities/local-upload-task.entity.ts
M backend/src/modules/lithography/entities/maintenance-report.entity.ts
A backend/src/modules/lithography/entities/maintenance-report-fault.entity.ts
M backend/src/modules/lithography/entities/maintenance-report-step.entity.ts
A backend/src/modules/lithography/entities/management-audit-event.entity.ts
M backend/src/modules/lithography/entities/organization.entity.ts
A backend/src/modules/lithography/entities/record-package-import.entity.ts
A backend/src/modules/lithography/entities/record-package-item.entity.ts
M backend/src/modules/lithography/entities/reference-document.entity.ts
A backend/src/modules/lithography/entities/reference-document-revision.entity.ts
A backend/src/modules/lithography/entities/repair-process-entry.entity.ts
M backend/src/modules/lithography/entities/repair-request.entity.ts
A backend/src/modules/lithography/entities/repair-request-intake.entity.ts
A backend/src/modules/lithography/entities/repair-request-revision.entity.ts
A backend/src/modules/lithography/entities/stored-file.entity.ts
A backend/src/modules/lithography/entities/sync-conflict.entity.ts
A backend/src/modules/lithography/entities/sync-receipt.entity.ts
```

- 不变性核对：本补记仅改文档；运行时代码、Entity、43 条迁移相对 `f591254e` 无改动，`ALL43_CONCAT=37ed8126c37015b42ad92bcd523516aef1ff5a67fd2f010fd6fb658c95cc3920` 保持不变。
