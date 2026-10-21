# 数据采集 Schema 快照（A-PR0：组织与内容投稿）

- 日期：2026-10-20
- 责任：A（PR0 实施人）
- 真源：`backend/src/infrastructure/database/migrations/1775301000000 ~ 1775301900000` 十个迁移文件（数据库可执行交付记录）；Entity 位于 `backend/src/modules/lithography/entities/`（当前 ORM 映射）。
- 本文用途：对外可追踪的 Schema 快照——B 与后续开发者不读实现即可了解表结构、约束与索引命名；字段级细节以迁移原文为准，禁止手工改表替代 Migration。

## 一、范围与总览

- **新增 9 表**：`organization`、`organization_membership`、`content_submission`、`material_submission_detail`、`fault_case_submission_detail`、`content_submission_attachment`、`content_submission_revision`、`content_submission_review`、`reference_document_case_detail`。
- **扩展 1 表**：`reference_document` 追加 8 列（组织归属、入库方式、来源回链、机型文字、修改人、扩展属性、schema 版本）。
- **基线 14 表零改动**：不触碰任何已接受的基线迁移；空库验证 `verify-empty-db-migrations.ts` 的 `REQUIRED_TABLES` 已由 14 扩为 **23**。
- 字符集统一 `utf8mb4 / utf8mb4_0900_ai_ci`；时间列统一 `timestamp(3)` 毫秒精度。

### 表间关系（摘要）

```
organization ──< organization_membership >── base_user_account
      │
      │ (owner_organization_id)
      ▼
content_submission ──1:1── material_submission_detail        (MATERIAL)
      │              └─1:1── fault_case_submission_detail     (FAULT_CASE)
      │
      ├──< content_submission_attachment   (单附件模型：同时仅一份 CURRENT)
      ├──< content_submission_revision     (每次送审一个冻结版本号 revision_no)
      │        └──1:1── content_submission_review  (每个版本最多一条审核记录)
      │
      └──(发布)──< reference_document      (source_submission_id 唯一：一个投稿最多发布一份)
                        └──1:1── reference_document_case_detail (FAULT_CASE 正式案例明细)
```

## 二、表结构清单（关键列 / 约束 / 索引全名）

### 2.1 organization（组织表）

| 列 | 说明 |
| --- | --- |
| `id` | PK |
| `organization_code` | 业务编码，如 `CLIENT_DEFAULT` / `PEER_ALT` |
| `name` / `kind` / `status` | 名称；类别 CLIENT=甲方 / PEER=同行；状态 ACTIVE / DISABLED |

- 唯一：`uk_organization_code`；索引：`idx_organization_kind_status`
- CHECK：`chk_organization_kind`、`chk_organization_status`

### 2.2 organization_membership（组织成员关系表）

| 列 | 说明 |
| --- | --- |
| `organization_id` / `account_id` | 组织与账号 |
| `member_role` | SUPER_ADMIN=组织管理员 / ENGINEER=工程师 |
| `status` / `joined_at` / `left_at` | ACTIVE=在籍 / LEFT=已退出；退出时间与状态成对 |

- 唯一：`uk_organization_membership_org_account`（组织+账号）；索引：`idx_organization_membership_account_status`
- FK：`fk_organization_membership_organization`、`fk_organization_membership_account`（均 RESTRICT）
- CHECK：`chk_organization_membership_role`、`chk_organization_membership_status`、`chk_organization_membership_period`（ACTIVE 无 left_at / LEFT 必有 left_at）

### 2.3 content_submission（投稿主表）

| 列 | 说明 |
| --- | --- |
| `submission_kind` | MATERIAL=普通资料 / FAULT_CASE=故障案例 |
| `owner_organization_id` | 所属组织（服务端裁定，不接受客户端自报） |
| `submitted_by_account_id` | 投稿人账号 |
| `status` | DRAFT / PENDING_REVIEW / RETURNED / PUBLISHED |
| `current_revision_no` | 当前送审版本号；0=尚未送审 |
| `last_submitted_at` / `published_at` | 最近送审 / 最近发布时间 |

- 索引：`idx_content_submission_org_status_updated`（组织+状态+updated_at）、`idx_content_submission_submitter_status_updated`（投稿人+状态+updated_at）
- FK：`fk_content_submission_owner_organization`、`fk_content_submission_submitted_by_account`（RESTRICT）
- CHECK：
  - `chk_content_submission_kind`、`chk_content_submission_status`
  - `chk_content_submission_revision_consistency`：DRAFT ⇔ revision_no=0 且 last_submitted_at IS NULL；非 DRAFT ⇔ revision_no≥1 且 last_submitted_at 非空
  - `chk_content_submission_publish_consistency`：PUBLISHED ⇔ published_at 非空

### 2.4 material_submission_detail（普通资料明细，PK 即投稿外键）

关键列：`title`、`document_type`（不允许 FAULT_CASE）、`equipment_model_id` 与 `equipment_model_text`（互斥）、`description`、`content_text`、`extension_json`、`schema_version`。

- 索引：`idx_material_submission_detail_equipment_model`；FK：`fk_material_submission_detail_submission`、`fk_material_submission_detail_equipment_model`
- CHECK：`chk_material_submission_detail_model_exclusive`、`chk_material_submission_detail_type`

### 2.5 fault_case_submission_detail（故障案例明细，PK 即投稿外键）

关键列：`title`、`equipment_model_id` / `equipment_model_text`（互斥）、`error_code`（保留大小写与内部符号）、`phenomenon`、`condition_text`、`reproduction_steps`、`diagnosis`、`action_taken`、`handling_status`（UNRESOLVED / IN_PROGRESS / RESOLVED）、`resolution`、`extension_json`、`schema_version`。

- 索引：`idx_fault_case_submission_detail_equipment_model`；FK：`fk_fault_case_submission_detail_submission`、`fk_fault_case_submission_detail_equipment_model`
- CHECK：`chk_fault_case_submission_detail_model_exclusive`、`chk_fault_case_submission_detail_handling_status`、`chk_fault_case_submission_detail_resolution`（RESOLVED 必须有非空 `resolution`）

### 2.6 content_submission_attachment（投稿私有附件，单附件模型）

关键列：`submission_id`、`original_filename`、`mime_type`、`byte_size`（服务端实际字节）、`storage_backend` / `storage_reference`（私有存储，无路径语义）、`uploaded_by_account_id`、`status`（CURRENT / RETIRED）、`uploaded_at` / `retired_at`。

- 复合唯一：`uk_content_submission_attachment_id_submission`（`id, submission_id`，供版本表复合外键引用）
- 索引：`idx_content_submission_attachment_submission_status`、`idx_content_submission_attachment_uploaded_by`
- CHECK：`chk_content_submission_attachment_status`、`chk_content_submission_attachment_retire_consistency`（CURRENT 无 retired_at / RETIRED 必有 retired_at）
- **单附件铁律（应用层）**：同一投稿同时仅一份 CURRENT 附件；变更在事务内行锁串行化，先退役旧 CURRENT 再登记新；历史冻结引用保留。

### 2.7 content_submission_revision（送审冻结版本）

关键列：`submission_id`、`revision_no`（从 1 递增）、`payload_snapshot`（完整快照 JSON）、`schema_version`、`title_snapshot`、`attachment_id`（当次冻结附件，可为空=纯文本）、`notice_version`（入库告知版本，服务端固定）、`confirmed_by_account_id` / `confirmed_at`、`submitted_at`。

- 唯一：`uk_content_submission_revision_submission_no`（submission_id + revision_no）、`uk_content_submission_revision_id_submission`（id + submission_id，供复合外键引用）
- 索引：`idx_content_submission_revision_attachment`、`idx_content_submission_revision_confirmed_by`
- FK：`fk_content_submission_revision_submission`、`fk_content_submission_revision_attachment`（复合：attachment_id + submission_id，防跨投稿附件引用）、`fk_content_submission_revision_confirmed_by_account`
- CHECK：`chk_content_submission_revision_no`、`chk_content_submission_revision_title`、`chk_content_submission_revision_notice`

### 2.8 content_submission_review（审核记录）

关键列：`submission_id`、`revision_id`、`decision`（RETURN / APPROVE）、`reviewed_by_account_id`、`comment`（退回必填）、`publish_attachment`（通过时是否发布附件）、`reviewed_at`。

- 唯一：`uk_content_submission_review_revision`（`revision_id` 唯一——**每个送审版本最多一条审核记录**；退回后重提产生新版本与新记录，历史不覆盖）
- 索引：`idx_content_submission_review_revision_submission`、`idx_content_submission_review_submission_reviewed`、`idx_content_submission_review_reviewed_by`
- FK：`fk_content_submission_review_revision`（复合：revision_id + submission_id）、`fk_content_submission_review_reviewed_by_account`
- CHECK：`chk_content_submission_review_decision`、`chk_content_submission_review_comment`（RETURN 必须有非空意见）、`chk_content_submission_review_publish_flag`（RETURN 时 publish_attachment=0）

### 2.9 reference_document_case_detail（正式案例明细，PK 即资料外键）

关键列：`document_id`、`error_code`、`handling_status`（NOT NULL）、`phenomenon`（NOT NULL）、`condition_text`、`reproduction_steps`（NOT NULL）、`diagnosis`、`action_taken`、`resolution`（已解决必填）、`case_payload_json`、`schema_version`。

- FK：`fk_reference_document_case_detail_document`
- CHECK：`chk_reference_document_case_detail_status`、`chk_reference_document_case_detail_resolution`

## 三、reference_document 扩展（8 列，三段式迁移）

| 列 | 语义 |
| --- | --- |
| `owner_organization_id` | 所属组织（NOT NULL，回填后收紧） |
| `ingest_method` | ADMIN_DIRECT=管理员直建 / REVIEWED_SUBMISSION=审核发布 / SYSTEM_IMPORT=预留（NOT NULL DEFAULT 'ADMIN_DIRECT'） |
| `source_submission_id` | 来源投稿 ID；管理员直建为空 |
| `source_revision_id` | 来源送审版本 ID；必须属于来源投稿（复合外键） |
| `equipment_model_text` | 机型文字（用户手填）；与机型 ID 互斥 |
| `updated_by_account_id` | 最后修改人；正式更正时必写 |
| `extension_json` | 按 schema_version 校验的补充属性 |
| `schema_version` | 内容 schema 版本（DEFAULT 1） |

**三段式迁移顺序（`1775301900000`）**：

1. 追加可空新列，不打断既有写入路径；
2. 幂等建 `CLIENT_DEFAULT` 组织（`INSERT IGNORE`, 甲方默认组织），回填全部旧资料 `owner_organization_id`，`ingest_method` 回填 `ADMIN_DIRECT`；
3. 收紧为 NOT NULL，补索引/外键/CHECK。

**新增约束/索引全名**：

- 唯一：`uk_reference_document_source_submission`（`source_submission_id` 全局唯一——**一个投稿最多发布一份正式资料**，并发发布最多一次成功）
- 索引：`idx_reference_document_source_revision`、`idx_reference_document_org_deleted_created`（组织+deleted_at+created_at）
- FK：`fk_reference_document_owner_organization`、`fk_reference_document_source_submission`、`fk_reference_document_source_revision`（复合）、`fk_reference_document_updated_by_account`
- CHECK：`chk_reference_document_ingest_method`、`chk_reference_document_source_pair`（source 两列同 NULL 或同非 NULL）、`chk_reference_document_model_exclusive`

## 四、跨表一致性铁律（实现归属）

| 铁律 | Schema 锚点 | 应用层保障 |
| --- | --- | --- |
| 一个投稿最多发布一份正式资料 | `uk_reference_document_source_submission` | 发布用例锁定重核状态+版本，唯一来源约束兜底并发 |
| 来源成对（投稿↔版本） | `chk_reference_document_source_pair` + 复合 FK | 发布链写入前校验版本属于投稿 |
| 每个送审版本最多一条审核记录 | `uk_content_submission_review_revision` | 审核用例行锁+状态前置校验，重复审核拒绝 |
| 同时仅一份 CURRENT 附件 | 应用层（表内 `status`） | 事务内行锁串行化：先退役旧 CURRENT 再登记新 |
| 状态-时间一致性 | `chk_content_submission_revision_consistency` / `chk_content_submission_publish_consistency` | 各用例只经状态机迁移写状态 |
| RESOLVED 必须有处理结果 | 两处案例 CHECK | normalize/合并后最终态断言同一口径 |
| 机型 ID 与机型文字互斥 | 三处 `model_exclusive` CHECK | 各写入链 normalize 断言同一口径 |
| DRAFT 不可伪造版本 | `chk_content_submission_revision_consistency` | 送审用例唯一写版本入口 |

## 五、迁移文件清单（执行顺序）

| 时间戳 | 文件 | 内容 |
| --- | --- | --- |
| 1775301000000 | create-organization-table | organization |
| 1775301100000 | create-organization-membership-table | organization_membership |
| 1775301200000 | create-content-submission-table | content_submission |
| 1775301300000 | create-material-submission-detail-table | material_submission_detail |
| 1775301400000 | create-fault-case-submission-detail-table | fault_case_submission_detail |
| 1775301500000 | create-content-submission-attachment-table | content_submission_attachment |
| 1775301600000 | create-content-submission-revision-table | content_submission_revision |
| 1775301700000 | create-content-submission-review-table | content_submission_review |
| 1775301800000 | create-reference-document-case-detail-table | reference_document_case_detail |
| 1775301900000 | alter-reference-document-organization-fields | reference_document +8 列（三段式） |

全部 `down()` 可逆（DROP 表 / 逆序删列删约束）；不修改任何既有基线迁移。空库演练：`MIGRATION_DRILL_CREATE_TEMP_DB=true npm --prefix backend run migration:drill:empty-db`（禁止默认 DB_NAME 清库模式）；结构断言由 `verify-empty-db-migrations.ts`（REQUIRED_TABLES=23）覆盖。

## 六、Seed 与 Mock 数据（`npm run seed:mock`，幂等）

- 环境：默认读 `backend/env/.env.e2e`，其次 `.env.development`；须配置 `MOCK_SEED_PASSWORD`（供 Mock 账号登录）与 `FIELD_ENCRYPTION_KEY` / `FIELD_ENCRYPTION_IV`。数据库名须含 `test`/`drill`/`dev`/`local`；其他非生产库需显式设置 `SEED_ALLOW_NON_TEST_DB=true`。详见 `docs/database/README.md`。
- **组织**：`910001` CLIENT_DEFAULT「甲方默认组织」（CLIENT）、`910002` PEER_ALT「同行隔离测试组织」（PEER）。
- **成员映射**：CLIENT_DEFAULT：`900001` SUPER_ADMIN（mock_super_admin）、`900101` / `900102` ENGINEER（陈工/李工）；PEER_ALT：`900301` SUPER_ADMIN（同行管理员）、`900302` ENGINEER（同行工程师）。
- **账号**（登录名，昵称）：`mock_super_admin`（系统管理员）、`mock_engineer_chen`（陈工）、`mock_engineer_li`（李工）、`mock_customer_alpha`（华芯设备主管）、`mock_customer_beta`（晶圆科技值班员）、`mock_admin_peer`（同行组织管理员）、`mock_engineer_peer`（同行工程师）。
- **投稿种子**（全部归属 CLIENT_DEFAULT，投稿人 900101/900102，审核人 900001）：`984001` DRAFT（MATERIAL，仅明细）、`984002` RETURNED（MATERIAL，冻结版本+附件+退回审核）、`984003` PENDING_REVIEW（FAULT_CASE，冻结版本+附件）、`984004` PUBLISHED（FAULT_CASE，版本+附件+通过审核+正式资料 `970006`（REVIEWED_SUBMISSION 回链）+案例明细）。附件 `987001~987003`、版本 `988001~988003`、审核 `989001~989002`。
- Mock 自增主键保留在 `900000-999999` 区间（设备型号除外）；脚本在同一事务内校验账号密码、角色密文、各表数据量与业务外键链路，重跑两次不产生重复。

## 七、边界与差异声明

- 不在本范围：OCR、多附件、共享授权、组织切换 UI、第二套 Session；`SYSTEM_IMPORT` 入库方式为预留枚举，无写入链。
- 计划 §3.1 九表与 §3.2 扩展列命名全部按计划落地，无重命名；迁移时间戳 `1775301000000~1775301900000` 满足「> 1775201500000」约束。
- `organization_membership.member_role` 仅 SUPER_ADMIN / ENGINEER 两值（CUSTOMER 不参与组织成员关系，按计划口径）。