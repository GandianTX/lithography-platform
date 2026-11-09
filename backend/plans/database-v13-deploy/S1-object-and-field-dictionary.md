# S1 对象与字段清单（34 现有表 + 17 候选 + 全部目标设计行）

> 来源：`数据库表设计说明-V1.1`。现有字段/约束来自各 Entity 与设计说明；目标字段逐行列出。**组合字段按一行展示但注明包含多列，逻辑/部署约束不计为新增列**。

## 1. 计数口径

| 口径                       | 数量 | 说明                                                                                                                       |
| -------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| 现有表                     | 34   | 与 `migration-schema-contract.ts` 的 REQUIRED_TABLES 一致                                                                  |
| 候选对象                   | 17   | 设计说明第 4 章；**按独立表作为当前实施方案**（OI-04）                                                                     |
| 现有字段行                 | 442  | 34 表合计；按源稿结构化逐行复核（修正 3 个 `binary(32)` 行，见 §5）                                                        |
| 现有约束行                 | 298  | 索引 83、外键 58、唯一 40、CHECK 97、枚举补充 16、生成列 4                                                                 |
| 现有表目标设计行           | 71   | 源稿逐行数；= 新增列行 44 + 既有列调整行 21 + 逻辑/关系/部署规则行 5 + 复用行 1                                            |
| 候选目标字段               | 196  | 17 张候选表合计                                                                                                            |
| 组合字段行                 | 7    | 一行含多列，按物理列拆分计数，不得按 1 行 1 列计                                                                           |
| 逻辑/关系/部署规则行       | 5    | 复合外键、唯一约束、CHECK、部署顺序、新故障关联；不是列                                                                    |
| 现有表新增物理列           | 47   | 42 个单列行 + `manual_upload_status／manual_cleanup_status`（2）+ `actual_cause／repair_actions／verification_result`（3） |
| 现有表既有列调整引用       | 29   | 16 个单列调整行 + 5 个组合调整行（共 13 个既有列引用）                                                                     |
| 目标新增列合计（估算口径） | 243  | 47（现有表物理新列）+ 196（候选表字段）；估算值，候选或技术字段变化时更新逐项清单并重算；组合行未重复计列                  |

结论：91 项需求不是 91 列。源稿共有 **267 条目标设计行**（71 现有表 + 196 候选字段）；本期真正的目标新增物理列按 **243 列估算**（47 现有表 + 196 候选；17 候选按独立表实施，OI-04 已裁决），另有 29 个既有列引用需调整、5 条逻辑/关系/部署规则。243 为估算值：候选归并或技术字段变化时更新逐项清单与统计，不为凑数字修改设计。旧稿的 439/59/255/238 分别修正为 **442/71/267/243**；差异来源见 §5。

> **S2 实施状态（2026-11-08）**：267 条源设计行已落到 6 条前向迁移、17 个新 Entity、11 个既有 Entity 与 `migration-schema-contract.ts`。既有表共新增物理列 47；候选字段按 17 张独立表建列；`engineer_response.resolution_status` 与 `local_installation` 沿用现有结构（无 DDL）。表中状态「S2 结构已实现（待实库验证）」仅表示代码与迁移已写，**不代表 MySQL 约束、事务或清理已通过**；实库项见 [S2-db-verification-specs.md](S2-db-verification-specs.md)。

## 2. 34 张现有表逐表清单

### 3.1 `base_user_account`

- 定位：现有表；Entity [account.entity.ts](../../src/modules/account/base/entities/account.entity.ts)；创建迁移 [1773924900000-create-base-user-account-table.migration.ts](../../src/infrastructure/database/migrations/1773924900000-create-base-user-account-table.migration.ts)
- 说明：保存账号的登录凭据、身份提示和启用状态；目标设计在本表增加管理员等级及首次改密限制。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 9；目标设计行 2；现有约束 3；直接消费者 42；测试 5

| 目标字段/约束          | 目标类型 | 目标约束/用途                                                 | 现状   | 动作     | 迁移方式                          | 消费者                                   | 测试                                                               | 状态                        |
| ---------------------- | -------- | ------------------------------------------------------------- | ------ | -------- | --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| `admin_level`          | tinyint  | 可空；仅管理员取1/2，非法不提权；新增：固定等级，不作为新角色 | 不存在 | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/account/account.module.ts`… | 5 个：`src/modules/account/base/services/account.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `must_change_password` | boolean  | 非空，默认false；新增：默认密码重置后的业务限制               | 不存在 | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/account/account.module.ts`… | 5 个：`src/modules/account/base/services/account.service.spec.ts`… | S2 结构已实现（待实库验证） |

<details><summary>现有约束（Entity 声明，3 条）</summary>

| 类别     | 名称/字段        | 声明                                                          |
| -------- | ---------------- | ------------------------------------------------------------- |
| 唯一约束 | `uk_login_name`  | （login_name）                                                |
| 唯一约束 | `uk_login_email` | （login_email）                                               |
| 枚举补充 | `status`         | enum（ACTIVE／BANNED／DELETED／PENDING／SUSPENDED／INACTIVE） |

</details>

消费者文件（42）：
`src/modules/account/account.module.ts`, `src/modules/account/base/services/account.service.spec.ts`, `src/modules/account/base/services/account-security.service.ts`, `src/modules/account/base/services/account.service.ts`, `src/modules/account/base/entities/user-info.entity.ts`, `src/modules/account/queries/account.query.service.my-account-settings.spec.ts`, `src/modules/account/queries/account.query.service.ts`, `src/modules/account/queries/admin-user.query.service.ts`, `src/modules/account/queries/admin-user.query.service.spec.ts`, `src/modules/lithography/queries/content-submission.query.service.spec.ts`, `src/modules/lithography/queries/repair-request.organization.integration.spec.ts`, `test/03-roles-guard/roles-guard.e2e-spec.ts` …

### 3.2 `base_user_info`

- 定位：现有表；Entity [user-info.entity.ts](../../src/modules/account/base/entities/user-info.entity.ts)；创建迁移 [1773925000000-create-base-user-info-table.migration.ts](../../src/infrastructure/database/migrations/1773925000000-create-base-user-info-table.migration.ts)
- 说明：保存姓名、昵称、联系方式等本人资料；目标设计增加客户自家公司关联，不把客户公司当成工程师成员资格。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 20；目标设计行 2；现有约束 3；直接消费者 37；测试 5

| 目标字段/约束              | 目标类型     | 目标约束/用途                                                                 | 现状   | 动作     | 迁移方式                          | 消费者                                   | 测试                                                               | 状态                        |
| -------------------------- | ------------ | ----------------------------------------------------------------------------- | ------ | -------- | --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| `real_name`                | varchar(200) | 工程师注册必填；客户按实际资料维护；新增：姓名与昵称分开                      | 不存在 | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/account/account.module.ts`… | 5 个：`src/modules/account/base/services/account.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `customer_organization_id` | int          | 可空FK organization；新客户必填；新增：客户公司关系，不自动授予工程师成员资格 | 不存在 | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/account/account.module.ts`… | 5 个：`src/modules/account/base/services/account.service.spec.ts`… | S2 结构已实现（待实库验证） |

<details><summary>现有约束（Entity 声明，3 条）</summary>

| 类别     | 名称/字段       | 声明                                         |
| -------- | --------------- | -------------------------------------------- |
| 唯一约束 | `uk_account_id` | （account_id）                               |
| 枚举补充 | `gender`        | enum（MALE／FEMALE／SECRET）                 |
| 枚举补充 | `user_state`    | enum（ACTIVE／INACTIVE／SUSPENDED／PENDING） |

</details>

消费者文件（37）：
`src/modules/account/account.module.ts`, `src/modules/account/account-field-encryption.registrar.ts`, `src/modules/account/base/services/account.service.spec.ts`, `src/modules/account/base/services/account.service.ts`, `src/modules/account/base/entities/account.entity.ts`, `src/modules/account/queries/account.query.service.my-account-settings.spec.ts`, `src/modules/account/queries/account.query.service.ts`, `src/modules/account/queries/admin-user.query.service.ts`, `src/modules/account/queries/admin-user.query.service.spec.ts`, `src/modules/lithography/queries/content-submission.query.service.spec.ts`, `src/modules/lithography/queries/repair-request.organization.integration.spec.ts`, `test/03-roles-guard/roles-guard.e2e-spec.ts` …

### 3.3 `ai_provider_call_record`

- 定位：现有表；Entity [ai-provider-call-record.entity.ts](../../src/modules/ai-provider-call-record/ai-provider-call-record.entity.ts)；创建迁移 [1773889200000-create-ai-provider-call-record-table.migration.ts](../../src/infrastructure/database/migrations/1773889200000-create-ai-provider-call-record-table.migration.ts)
- 说明：记录真实模型供应方的一次调用、耗时、用量和错误；是技术追溯数据，不是另一份业务报告。
- 本期处理：复用真实模型调用追溯，不要求本团队训练模型。
- 规模：现有字段 28；目标设计行 0；现有约束 14；直接消费者 6；测试 1
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，14 条）</summary>

| 类别     | 名称/字段                                         | 声明                                                                   |
| -------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| 唯一约束 | `uk_ai_provider_call_trace_seq`                   | （trace_id, call_seq）                                                 |
| 索引     | `idx_ai_provider_call_async_task_record_id`       | （async_task_record_id）                                               |
| 索引     | `idx_ai_provider_call_async_task_record_seq`      | （async_task_record_id, call_seq）                                     |
| 索引     | `idx_ai_provider_call_account_created_at`         | （account_id, created_at）                                             |
| 索引     | `idx_ai_provider_call_biz_target`                 | （biz_type, biz_key, biz_sub_key）                                     |
| 索引     | `idx_ai_provider_call_source_created_at`          | （source, created_at）                                                 |
| 索引     | `idx_ai_provider_call_provider_model_created_at`  | （provider, model, created_at）                                        |
| 索引     | `idx_ai_provider_call_task_type_created_at`       | （task_type, created_at）                                              |
| 索引     | `idx_ai_provider_call_provider_status_created_at` | （provider_status, created_at）                                        |
| 索引     | `idx_ai_provider_call_provider_request_id`        | （provider_request_id）                                                |
| 索引     | `idx_ai_provider_call_normalized_error_code`      | （normalized_error_code）                                              |
| 索引     | `idx_ai_provider_call_provider_error_code`        | （provider_error_code）                                                |
| 枚举补充 | `source`                                          | enum（user_action／admin_action／system／cron／domain_event／webhook） |
| 枚举补充 | `provider_status`                                 | enum（succeeded／failed）                                              |

</details>

消费者文件（6）：
`src/modules/ai-provider-call-record/ai-provider-call-record.service.spec.ts`, `src/modules/ai-provider-call-record/ai-provider-call-record.module.ts`, `src/modules/ai-provider-call-record/ai-provider-call-record.service.ts`, `test/08-qm-worker/ai-workflow-generic-handler.e2e-spec.ts`, `test/08-qm-worker/ai-worker-consume-persistence.e2e-spec.ts`, `test/99-third-party-live-smoke/ai-qwen-generate-real.e2e-spec.ts`

### 3.4 `ai_workflow_context`

- 定位：现有表；Entity [ai-workflow-context.entity.ts](../../src/modules/ai-workflow-context/ai-workflow-context.entity.ts)；创建迁移 [1775200800000-create-ai-workflow-context-table.migration.ts](../../src/infrastructure/database/migrations/1775200800000-create-ai-workflow-context-table.migration.ts)
- 说明：保存AI异步流程的输入上下文、业务关联、入队及执行状态，不代替报修、会话等业务主记录。
- 本期处理：复用既有编排上下文，报修、会话来源需明确；不是另一份业务主数据。
- 规模：现有字段 28；目标设计行 0；现有约束 10；直接消费者 5；测试 1
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。
- 校准：源稿另含 `workflow_dedup_hash`、`workflow_dedup_active_hash` 两个 `binary(32)` 字段，旧解析按“类型前缀”漏计，已补入 28。

<details><summary>现有约束（Entity 声明，10 条）</summary>

| 类别     | 名称/字段                                       | 声明                                                                                 |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| 唯一约束 | `uk_ai_workflow_context_type_active_dedup_hash` | （workflow_type, workflow_dedup_active_hash）                                        |
| 唯一约束 | `uk_ai_workflow_context_queue_job`              | （queue_name, job_id）                                                               |
| 索引     | `idx_ai_workflow_context_status_next_enqueue`   | （status, next_enqueue_at）                                                          |
| 索引     | `idx_ai_workflow_context_type_status_created`   | （workflow_type, status, created_at）                                                |
| 索引     | `idx_ai_workflow_context_type_dedup_status`     | （workflow_type, workflow_dedup_hash, status）                                       |
| 索引     | `idx_ai_workflow_context_trace_id`              | （trace_id）                                                                         |
| 索引     | `idx_ai_workflow_context_biz_target`            | （biz_type, biz_key, biz_sub_key）                                                   |
| 索引     | `idx_ai_workflow_context_status_updated`        | （status, updated_at）                                                               |
| 枚举补充 | `source`                                        | enum（user_action／admin_action／system／cron／domain_event／webhook）               |
| 枚举补充 | `status`                                        | enum（CREATED／ADMISSION_WAITING／QUEUED／PROCESSING／SUCCEEDED／FAILED／CANCELLED） |

</details>

消费者文件（5）：
`src/modules/ai-workflow-context/ai-workflow-context.service.spec.ts`, `src/modules/ai-workflow-context/ai-workflow-context.module.ts`, `src/modules/ai-workflow-context/ai-workflow-context.entity.ts`, `src/modules/ai-workflow-context/ai-workflow-context.service.ts`, `test/08-qm-worker/ai-workflow-generic-handler.e2e-spec.ts`

### 3.5 `base_async_task_record`

- 定位：现有表；Entity [async-task-record.entity.ts](../../src/modules/async-task-record/async-task-record.entity.ts)；创建迁移 [1773925700000-create-base-async-task-record-table.migration.ts](../../src/infrastructure/database/migrations/1773925700000-create-base-async-task-record-table.migration.ts)
- 说明：保存后台异步任务的队列身份、尝试次数、状态和失败事实；不因此新增用户任务管理中心。
- 本期处理：复用已有异步处理结果及失败记录，不新增独立任务中心。
- 规模：现有字段 22；目标设计行 0；现有约束 12；直接消费者 10；测试 0
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，12 条）</summary>

| 类别     | 名称/字段                | 声明                                                                   |
| -------- | ------------------------ | ---------------------------------------------------------------------- |
| 唯一约束 | `uk_queue_name_job_id`   | （queue_name, job_id）                                                 |
| 索引     | `idx_trace_id`           | （trace_id）                                                           |
| 索引     | `idx_actor_account_id`   | （actor_account_id）                                                   |
| 索引     | `idx_biz_target`         | （biz_type, biz_key, biz_sub_key）                                     |
| 索引     | `idx_source`             | （source）                                                             |
| 索引     | `idx_reason`             | （reason）                                                             |
| 索引     | `idx_status_enqueued_at` | （status, enqueued_at）                                                |
| 索引     | `idx_dedup_key_status`   | （dedup_key, status）                                                  |
| 索引     | `idx_occurred_at`        | （occurred_at）                                                        |
| 索引     | `idx_finished_at`        | （finished_at）                                                        |
| 枚举补充 | `source`                 | enum（user_action／admin_action／system／cron／domain_event／webhook） |
| 枚举补充 | `status`                 | enum（queued／processing／succeeded／failed／cancelled）               |

</details>

消费者文件（10）：
`src/modules/async-task-record/async-task-record.entity.ts`, `src/modules/async-task-record/async-task-record.module.ts`, `src/modules/async-task-record/async-task-record.service.ts`, `src/modules/async-task-record/queries/async-task-record.query.service.ts`, `test/08-qm-worker/ai-workflow-generic-handler.e2e-spec.ts`, `test/08-qm-worker/ai-graphql-queue.e2e-spec.ts`, `test/08-qm-worker/email-queue-consume.e2e-spec.ts`, `test/08-qm-worker/ai-worker-consume-persistence.e2e-spec.ts`, `test/08-qm-worker/ai-worker-consume-execution.e2e-spec.ts`, `test/99-third-party-live-smoke/ai-qwen-generate-real.e2e-spec.ts`

### 3.6 `ai_conversation`

- 定位：现有表；Entity [ai-conversation.entity.ts](../../src/modules/lithography/entities/ai-conversation.entity.ts)；创建迁移 [1775201100000-create-ai-conversation-table.migration.ts](../../src/infrastructure/database/migrations/1775201100000-create-ai-conversation-table.migration.ts)
- 说明：保存AI会话及其作者、工单和状态；目标设计允许独立会话，并固定可信公司及内容版本。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 7；目标设计行 4；现有约束 7；直接消费者 10；测试 2

| 目标字段/约束                       | 目标类型                        | 目标约束/用途                                                                         | 现状                                           | 动作                               | 迁移方式                          | 消费者                                           | 测试                                                                           | 状态                        |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------- | --------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------- |
| `request_id`                        | int                             | 改为可空FK，独立会话为空；调整：支持独立AI                                            | int 非空                                       | **调整**                           | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/admin-ai-report.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `owner_organization_id`             | int                             | 新会话非空FK公司；新增：可信公司                                                      | 不存在                                         | **新增**                           | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/admin-ai-report.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `content_version`                   | int unsigned                    | 非空递增；新增：固定导出读取版本                                                      | 不存在                                         | **新增**                           | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/admin-ai-report.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `status／ai_feedback／completed_at` | varchar(16)／text／timestamp(3) | COMPLETED 时反馈非空、完成时间非空；ACTIVE 时二者为空；调整：兼容已有字段及历史 CHECK | varchar(16) 非空；text 可空；timestamp(3) 可空 | **调整（3 个既有列，收紧 CHECK）** | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/admin-ai-report.query.service.spec.ts`… | S2 结构已实现（待实库验证） |

<details><summary>现有约束（Entity 声明，7 条）</summary>

| 类别     | 名称/字段                              | 声明                                                                                                                                                                                 |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 索引     | `idx_ai_conversation_request_created`  | （request_id, created_at）                                                                                                                                                           |
| 索引     | `idx_ai_conversation_engineer_created` | （engineer_account_id, created_at）                                                                                                                                                  |
| 索引     | `idx_ai_conversation_status_created`   | （status, created_at）                                                                                                                                                               |
| 外键     | `fk_ai_conversation_request`           | （request_id）→ repair_request（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                         |
| 外键     | `fk_ai_conversation_engineer_account`  | （engineer_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                             |
| CHECK    | `chk_ai_conversation_completion`       | ((`status` = 'ACTIVE' AND `completed_at` IS NULL) OR (`status` = 'COMPLETED' AND `ai_feedback` IS NOT NULL AND CHAR_LENGTH(TRIM(`ai_feedback`)) > 0 AND `completed_at` IS NOT NULL)) |
| 枚举补充 | `status`                               | enum（AiConversationStatus）                                                                                                                                                         |

</details>

消费者文件（10）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/admin-ai-report.query.service.spec.ts`, `src/modules/lithography/queries/admin-ai-conversation.query.service.ts`, `src/modules/lithography/queries/admin-ai-conversation.query.service.spec.ts`, `src/modules/lithography/queries/admin-ai-report.query.service.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-fixture-ownership.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture-ownership.e2e-spec.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.7 `ai_message`

- 定位：现有表；Entity [ai-message.entity.ts](../../src/modules/lithography/entities/ai-message.entity.ts)；创建迁移 [1775201200000-create-ai-message-table.migration.ts](../../src/infrastructure/database/migrations/1775201200000-create-ai-message-table.migration.ts)
- 说明：保存会话内逐条问题和回答及顺序；目标设计补充原问题标识和固定导出版本。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 7；目标设计行 2；现有约束 9；直接消费者 5；测试 0

| 目标字段/约束     | 目标类型     | 目标约束/用途                                            | 现状   | 动作     | 迁移方式                          | 消费者                                           | 测试              | 状态                        |
| ----------------- | ------------ | -------------------------------------------------------- | ------ | -------- | --------------------------------- | ------------------------------------------------ | ----------------- | --------------------------- |
| `question_uuid`   | char(36)     | 与分析请求关联；旧消息可空；新增：迟到回答只归原问题     | 不存在 | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `content_version` | int unsigned | 新消息必有，已存原文不可无痕覆盖；新增：导出截定消息范围 | 不存在 | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |

<details><summary>现有约束（Entity 声明，9 条）</summary>

| 类别     | 名称/字段                             | 声明                                                                               |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| 唯一约束 | `uk_ai_message_conversation_seq`      | （conversation_id, message_seq）                                                   |
| 索引     | `idx_ai_message_conversation_turn`    | （conversation_id, turn_no）                                                       |
| 索引     | `idx_ai_message_conversation_created` | （conversation_id, created_at）                                                    |
| 外键     | `fk_ai_message_conversation`          | （conversation_id）→ ai_conversation（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |
| CHECK    | `chk_ai_message_seq`                  | `message_seq` >= 1                                                                 |
| CHECK    | `chk_ai_message_turn`                 | (`turn_no` IS NULL OR `turn_no` BETWEEN 1 AND 100)                                 |
| CHECK    | `chk_ai_message_role_turn`            | (`role` IN ('SYSTEM', 'TOOL') OR `turn_no` IS NOT NULL)                            |
| CHECK    | `chk_ai_message_content`              | CHAR_LENGTH(TRIM(`content_text`)) > 0                                              |
| 枚举补充 | `role`                                | enum（AiMessageRole）                                                              |

</details>

消费者文件（5）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/admin-ai-conversation.query.service.ts`, `src/modules/lithography/queries/admin-ai-message.query.service.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-fixture-ownership.e2e-spec.ts`

### 3.8 `ai_report`

- 定位：现有表；Entity [ai-report.entity.ts](../../src/modules/lithography/entities/ai-report.entity.ts)；创建迁移 [1775201300000-create-ai-report-table.migration.ts](../../src/infrastructure/database/migrations/1775201300000-create-ai-report-table.migration.ts)
- 说明：保留已有AI报告记录；新问答PDF读取有权保存内容，不因这张历史表增加手动保存报告流程。
- 本期处理：保留旧诊断报告数据；V13问答PDF读取固定消息版本，不强制新增手动保存步骤。
- 规模：现有字段 8；目标设计行 0；现有约束 7；直接消费者 8；测试 1
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，7 条）</summary>

| 类别     | 名称/字段                        | 声明                                                                                     |
| -------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| 唯一约束 | `uk_ai_report_conversation_type` | （conversation_id, report_type）                                                         |
| 索引     | `idx_ai_report_request_created`  | （request_id, created_at）                                                               |
| 索引     | `idx_ai_report_conversation`     | （conversation_id）                                                                      |
| 索引     | `idx_ai_report_engineer_created` | （engineer_account_id, created_at）                                                      |
| 外键     | `fk_ai_report_request`           | （request_id）→ repair_request（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT             |
| 外键     | `fk_ai_report_conversation`      | （conversation_id）→ ai_conversation（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT       |
| 外键     | `fk_ai_report_engineer_account`  | （engineer_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |

</details>

消费者文件（8）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/admin-ai-report.query.service.spec.ts`, `src/modules/lithography/queries/admin-ai-conversation.query.service.ts`, `src/modules/lithography/queries/admin-ai-report.query.service.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-fixture-ownership.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.9 `content_submission_attachment`

- 定位：现有表；Entity [content-submission-attachment.entity.ts](../../src/modules/lithography/entities/content-submission-attachment.entity.ts)；创建迁移 [1775301500000-create-content-submission-attachment-table.migration.ts](../../src/infrastructure/database/migrations/1775301500000-create-content-submission-attachment-table.migration.ts)
- 说明：保留旧投稿与附件的关联及历史；不作为两类新报告的必需写入链。
- 本期处理：仅保留既有普通资料及历史关联；取消新建入口，不作为两类新报告的必需写入链
- 规模：现有字段 11；目标设计行 0；现有约束 7；直接消费者 10；测试 1
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，7 条）</summary>

| 类别     | 名称/字段                                              | 声明                                                                                                     |
| -------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 唯一约束 | `uk_content_submission_attachment_id_submission`       | （id, submission_id）                                                                                    |
| 索引     | `idx_content_submission_attachment_submission_status`  | （submission_id, status）                                                                                |
| 索引     | `idx_content_submission_attachment_uploaded_by`        | （uploaded_by_account_id）                                                                               |
| 外键     | `fk_content_submission_attachment_submission`          | （submission_id）→ content_submission（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                      |
| 外键     | `fk_content_submission_attachment_uploaded_by_account` | （uploaded_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT              |
| CHECK    | `chk_content_submission_attachment_status`             | `status` IN ('CURRENT', 'RETIRED')                                                                       |
| CHECK    | `chk_content_submission_attachment_retire_consistency` | ((`status` = 'CURRENT' AND `retired_at` IS NULL) OR (`status` = 'RETIRED' AND `retired_at` IS NOT NULL)) |

</details>

消费者文件（10）：
`src/modules/lithography/content-submission.service.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/content-submission.query.service.spec.ts`, `src/modules/lithography/queries/content-submission.query.service.ts`, `test/11-content-submission/content-submission-integration.e2e-spec.ts`, `test/11-content-submission/content-submission-graphql.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture.ts`, `test/12-reference-document-case/reference-document-case.e2e-spec.ts`

### 3.10 `content_submission_review`

- 定位：现有表；Entity [content-submission-review.entity.ts](../../src/modules/lithography/entities/content-submission-review.entity.ts)；创建迁移 [1775301700000-create-content-submission-review-table.migration.ts](../../src/infrastructure/database/migrations/1775301700000-create-content-submission-review-table.migration.ts)
- 说明：保留旧资料审核决定；已有历史可追溯，但不为新资料创建待审批状态。
- 本期处理：保留旧资料审核历史，不作为新资料发布前置。
- 规模：现有字段 8；目标设计行 0；现有约束 9；直接消费者 9；测试 1
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，9 条）</summary>

| 类别     | 名称/字段                                           | 声明                                                                                                                     |
| -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 唯一约束 | `uk_content_submission_review_revision`             | （revision_id）                                                                                                          |
| 索引     | `idx_content_submission_review_revision_submission` | （revision_id, submission_id）                                                                                           |
| 索引     | `idx_content_submission_review_submission_reviewed` | （submission_id, reviewed_at）                                                                                           |
| 索引     | `idx_content_submission_review_reviewed_by`         | （reviewed_by_account_id）                                                                                               |
| 外键     | `fk_content_submission_review_revision`             | （revision_id, submission_id）→ content_submission_revision（id, submission_id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |
| 外键     | `fk_content_submission_review_reviewed_by_account`  | （reviewed_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                              |
| CHECK    | `chk_content_submission_review_decision`            | `decision` IN ('RETURN', 'APPROVE')                                                                                      |
| CHECK    | `chk_content_submission_review_comment`             | (`decision` <> 'RETURN' OR (`comment` IS NOT NULL AND CHAR_LENGTH(TRIM(`comment`)) > 0))                                 |
| CHECK    | `chk_content_submission_review_publish_flag`        | (`decision` <> 'RETURN' OR `publish_attachment` = 0)                                                                     |

</details>

消费者文件（9）：
`src/modules/lithography/content-submission.service.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/content-submission.query.service.spec.ts`, `src/modules/lithography/queries/content-submission.query.service.ts`, `test/11-content-submission/content-submission-integration.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture.ts`, `test/12-reference-document-case/reference-document-case.e2e-spec.ts`

### 3.11 `content_submission_revision`

- 定位：现有表；Entity [content-submission-revision.entity.ts](../../src/modules/lithography/entities/content-submission-revision.entity.ts)；创建迁移 [1775301600000-create-content-submission-revision-table.migration.ts](../../src/infrastructure/database/migrations/1775301600000-create-content-submission-revision-table.migration.ts)
- 说明：保留旧投稿送审或冻结版本；V13不据此恢复普通资料投稿与审核流程。
- 本期处理：仅保留既有普通资料及历史关联；取消新建入口，不作为两类新报告的必需写入链
- 规模：现有字段 11；目标设计行 0；现有约束 10；直接消费者 8；测试 1
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，10 条）</summary>

| 类别     | 名称/字段                                             | 声明                                                                                                                         |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 唯一约束 | `uk_content_submission_revision_submission_no`        | （submission_id, revision_no）                                                                                               |
| 唯一约束 | `uk_content_submission_revision_id_submission`        | （id, submission_id）                                                                                                        |
| 索引     | `idx_content_submission_revision_attachment`          | （attachment_id, submission_id）                                                                                             |
| 索引     | `idx_content_submission_revision_confirmed_by`        | （confirmed_by_account_id）                                                                                                  |
| 外键     | `fk_content_submission_revision_submission`           | （submission_id）→ content_submission（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                          |
| 外键     | `fk_content_submission_revision_attachment`           | （attachment_id, submission_id）→ content_submission_attachment（id, submission_id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |
| 外键     | `fk_content_submission_revision_confirmed_by_account` | （confirmed_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                 |
| CHECK    | `chk_content_submission_revision_no`                  | `revision_no` >= 1                                                                                                           |
| CHECK    | `chk_content_submission_revision_title`               | CHAR_LENGTH(TRIM(`title_snapshot`)) > 0                                                                                      |
| CHECK    | `chk_content_submission_revision_notice`              | CHAR_LENGTH(TRIM(`notice_version`)) > 0                                                                                      |

</details>

消费者文件（8）：
`src/modules/lithography/content-submission.service.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/content-submission.query.service.spec.ts`, `src/modules/lithography/queries/content-submission.query.service.ts`, `test/11-content-submission/content-submission-integration.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.12 `content_submission`

- 定位：现有表；Entity [content-submission.entity.ts](../../src/modules/lithography/entities/content-submission.entity.ts)；创建迁移 [1775301200000-create-content-submission-table.migration.ts](../../src/infrastructure/database/migrations/1775301200000-create-content-submission-table.migration.ts)
- 说明：保留旧普通资料或案例投稿的来源及状态；V13取消普通资料新建，不将其重新接入新报告提交链。
- 本期处理：仅保留既有普通资料及历史关联；取消新建入口，不作为两类新报告的必需写入链
- 规模：现有字段 10；目标设计行 0；现有约束 8；直接消费者 10；测试 1
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，8 条）</summary>

| 类别  | 名称/字段                                         | 声明                                                                                                                                                                             |
| ----- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 索引  | `idx_content_submission_org_status_updated`       | （owner_organization_id, status, updated_at）                                                                                                                                    |
| 索引  | `idx_content_submission_submitter_status_updated` | （submitted_by_account_id, status, updated_at）                                                                                                                                  |
| 外键  | `fk_content_submission_owner_organization`        | （owner_organization_id）→ organization（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                            |
| 外键  | `fk_content_submission_submitted_by_account`      | （submitted_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                     |
| CHECK | `chk_content_submission_kind`                     | `submission_kind` IN ('MATERIAL', 'FAULT_CASE')                                                                                                                                  |
| CHECK | `chk_content_submission_status`                   | `status` IN ('DRAFT', 'PENDING_REVIEW', 'RETURNED', 'PUBLISHED')                                                                                                                 |
| CHECK | `chk_content_submission_revision_consistency`     | ((`status` = 'DRAFT' AND `current_revision_no` = 0 AND `last_submitted_at` IS NULL) OR (`status` <> 'DRAFT' AND `current_revision_no` >= 1 AND `last_submitted_at` IS NOT NULL)) |
| CHECK | `chk_content_submission_publish_consistency`      | ((`status` = 'PUBLISHED' AND `published_at` IS NOT NULL) OR (`status` <> 'PUBLISHED' AND `published_at` IS NULL))                                                                |

</details>

消费者文件（10）：
`src/modules/lithography/content-submission.service.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/content-submission.query.service.spec.ts`, `src/modules/lithography/queries/content-submission.query.service.ts`, `test/11-content-submission/content-submission-integration.e2e-spec.ts`, `test/11-content-submission/content-submission-graphql.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture.ts`, `test/12-reference-document-case/reference-document-case.e2e-spec.ts`

### 3.13 `engineer_registration_application`

- 定位：现有表；Entity [engineer-registration-application.entity.ts](../../src/modules/lithography/entities/engineer-registration-application.entity.ts)；创建迁移 [1775401500000-create-engineer-registration-application.migration.ts](../../src/infrastructure/database/migrations/1775401500000-create-engineer-registration-application.migration.ts)
- 说明：保存工程师注册申请、申请公司、审核状态和决定；批准时与账号资格及有效成员关系一起变更。
- 本期处理：复用现有数据与关联，按V13授权和状态规则使用
- 规模：现有字段 12；目标设计行 0；现有约束 12；直接消费者 7；测试 0
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，12 条）</summary>

| 类别       | 名称/字段                                                    | 声明                                                                                                                                            |
| ---------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 唯一约束   | `uk_engineer_registration_application_pending_account`       | （pending_account_id）                                                                                                                          |
| 索引       | `idx_engineer_registration_application_org_status_submitted` | （organization_id, status, submitted_at, id）                                                                                                   |
| 索引       | `idx_engineer_registration_application_account_submitted`    | （account_id, submitted_at, id）                                                                                                                |
| 外键       | `fk_engineer_registration_application_account`               | （account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                 |
| 外键       | `fk_engineer_registration_application_organization`          | （organization_id）→ organization（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                 |
| 外键       | `fk_engineer_registration_application_reviewer`              | （reviewed_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                     |
| CHECK      | `chk_engineer_registration_application_status`               | `status` IN ('PENDING', 'APPROVED', 'REJECTED')                                                                                                 |
| CHECK      | `chk_engineer_registration_application_pending_review`       | ((`status` = 'PENDING' AND `reviewed_by_account_id` IS NULL AND `reviewed_at` IS NULL AND `review_comment` IS NULL) OR (`status` <> 'PENDING')) |
| CHECK      | `chk_engineer_registration_application_reviewed`             | ((`status` = 'PENDING') OR (`reviewed_by_account_id` IS NOT NULL AND `reviewed_at` IS NOT NULL))                                                |
| CHECK      | `chk_engineer_registration_application_reject_comment`       | (`status` <> 'REJECTED' OR (`review_comment` IS NOT NULL AND CHAR_LENGTH(TRIM(`review_comment`)) > 0))                                          |
| CHECK      | `chk_engineer_registration_application_review_time`          | (`reviewed_at` IS NULL OR `reviewed_at` >= `submitted_at`)                                                                                      |
| 生成列补充 | `pending_account_id`                                         | 可空；生成列 STORED：IF(`status` = 'PENDING', `account_id`, NULL)；禁止INSERT写入；禁止UPDATE写入                                               |

</details>

消费者文件（7）：
`src/modules/lithography/engineer-registration.mapper.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/engineer-registration.service.ts`, `src/modules/lithography/queries/engineer-registration.query.service.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.14 `engineer_response`

- 定位：现有表；Entity [engineer-response.entity.ts](../../src/modules/lithography/entities/engineer-response.entity.ts)；创建迁移 [1775201400000-create-engineer-response-table.migration.ts](../../src/infrastructure/database/migrations/1775201400000-create-engineer-response-table.migration.ts)
- 说明：保存接单工程师发给客户的回复；回复与内部维修过程、结束工单分别处理。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 7；目标设计行 1；现有约束 8；直接消费者 12；测试 2

| 目标字段/约束       | 目标类型  | 目标约束/用途                                                                                            | 现状                      | 动作                           | 迁移方式                 | 消费者                                                  | 测试                             | 状态                   |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------ | ------------------------ | ------------------------------------------------------- | -------------------------------- | ---------------------- |
| `resolution_status` | 现有 enum | 兼容旧数据，不作为结单来源；新 R025 不要求用户输入，迁移后允许无新处理状态并保留旧值，不把回复提交当结单 | enum（PENDING／RESOLVED） | **调整（旧值保留，不新增列）** | 沿用现有 CHECK（无 DDL） | `src/modules/lithography/engineer-response.service.ts`… | 2 个：`test/06-repair-request/…` | 沿用现有结构（无 DDL） |

<details><summary>现有约束（Entity 声明，8 条）</summary>

| 类别     | 名称/字段                                | 声明                                                                                     |
| -------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| 索引     | `idx_engineer_response_request_created`  | （request_id, created_at）                                                               |
| 索引     | `idx_engineer_response_engineer_created` | （engineer_account_id, created_at）                                                      |
| 索引     | `idx_engineer_response_customer_created` | （customer_account_id, created_at）                                                      |
| 外键     | `fk_engineer_response_request`           | （request_id）→ repair_request（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT             |
| 外键     | `fk_engineer_response_engineer_account`  | （engineer_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |
| 外键     | `fk_engineer_response_customer_account`  | （customer_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |
| CHECK    | `chk_engineer_response_text`             | CHAR_LENGTH(TRIM(`response_text`)) > 0                                                   |
| 枚举补充 | `resolution_status`                      | enum（PENDING／RESOLVED）                                                                |

</details>

消费者文件（12）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/engineer-response.service.ts`, `src/modules/lithography/queries/admin-repair-request.query.service.ts`, `src/modules/lithography/queries/repair-request.query.service.ts`, `src/modules/lithography/queries/repair-request.query.service.spec.ts`, `src/modules/lithography/queries/repair-request.organization.integration.spec.ts`, `test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-response.e2e-spec.ts`, `test/06-repair-request/repair-request-fixture-ownership.e2e-spec.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.15 `equipment_model`

- 定位：现有表；Entity [equipment-model.entity.ts](../../src/modules/lithography/entities/equipment-model.entity.ts)；创建迁移 [1775200900000-create-equipment-model-table.migration.ts](../../src/infrastructure/database/migrations/1775200900000-create-equipment-model-table.migration.ts)
- 说明：保存平台预置设备机型及启用、排序信息，供报修和报告表单查询。
- 本期处理：复用现有数据与关联，按V13授权和状态规则使用
- 规模：现有字段 7；目标设计行 0；现有约束 3；直接消费者 25；测试 6
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，3 条）</summary>

| 类别     | 名称/字段                          | 声明                    |
| -------- | ---------------------------------- | ----------------------- |
| 唯一约束 | `uk_equipment_model_code`          | （model_code）          |
| 索引     | `idx_equipment_model_enabled_sort` | （enabled, sort_order） |
| CHECK    | `chk_equipment_model_enabled`      | `enabled` IN (0, 1)     |

</details>

消费者文件（25）：
`src/modules/lithography/equipment-model.query.service.spec.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/content-submission.query.service.spec.ts`, `src/modules/lithography/queries/admin-repair-request.query.service.ts`, `src/modules/lithography/queries/repair-request.query.service.ts`, `src/modules/lithography/queries/content-submission.query.service.ts`, `src/modules/lithography/queries/reference-document.query.service.ts`, `src/modules/lithography/queries/repair-request.query.service.spec.ts`, `src/modules/lithography/queries/equipment-model.query.service.ts`, `src/modules/lithography/queries/repair-request.organization.integration.spec.ts`, `src/modules/lithography/queries/reference-document.query.service.spec.ts`, `src/modules/lithography/queries/admin-repair-request.query.service.spec.ts` …

### 3.16 `fault_case_submission_detail`

- 定位：现有表；Entity [fault-case-submission-detail.entity.ts](../../src/modules/lithography/entities/fault-case-submission-detail.entity.ts)；创建迁移 [1775301400000-create-fault-case-submission-detail-table.migration.ts](../../src/infrastructure/database/migrations/1775301400000-create-fault-case-submission-detail-table.migration.ts)
- 说明：保留旧投稿案例的故障、排查及处理内容；新的独立故障报告统一使用maintenance_report。
- 本期处理：保留旧投稿案例详情；新独立历史／现场报告统一进入maintenance_report。
- 规模：现有字段 15；目标设计行 0；现有约束 6；直接消费者 7；测试 1
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，6 条）</summary>

| 类别  | 名称/字段                                          | 声明                                                                                                                                 |
| ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 索引  | `idx_fault_case_submission_detail_equipment_model` | （equipment_model_id）                                                                                                               |
| 外键  | `fk_fault_case_submission_detail_submission`       | （submission_id）→ content_submission（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                  |
| 外键  | `fk_fault_case_submission_detail_equipment_model`  | （equipment_model_id）→ equipment_model（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                |
| CHECK | `chk_fault_case_submission_detail_model_exclusive` | (`equipment_model_id` IS NULL OR `equipment_model_text` IS NULL)                                                                     |
| CHECK | `chk_fault_case_submission_detail_handling_status` | (`handling_status` IS NULL OR `handling_status` IN ('UNRESOLVED', 'IN_PROGRESS', 'RESOLVED'))                                        |
| CHECK | `chk_fault_case_submission_detail_resolution`      | (`handling_status` IS NULL OR `handling_status` <> 'RESOLVED' OR (`resolution` IS NOT NULL AND CHAR_LENGTH(TRIM(`resolution`)) > 0)) |

</details>

消费者文件（7）：
`src/modules/lithography/content-submission.service.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/content-submission.query.service.spec.ts`, `src/modules/lithography/queries/content-submission.query.service.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.17 `local_backup_run`

- 定位：现有表；Entity [local-backup-run.entity.ts](../../src/modules/lithography/entities/local-backup-run.entity.ts)；创建迁移 [1775401400000-create-local-installation-upload-backup.migration.ts](../../src/infrastructure/database/migrations/1775401400000-create-local-installation-upload-backup.migration.ts)
- 说明：保存一次本地备份生成的执行事实；目标设计区分设备公司，并分别记录手动流程的上传和清理结果。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 16；目标设计行 4；现有约束 7；直接消费者 5；测试 0

| 目标字段/约束                                 | 目标类型                   | 目标约束/用途                                                                                                            | 现状                                                        | 动作                             | 迁移方式                          | 消费者                                              | 测试              | 状态                        |
| --------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------- | --------------------------------- | --------------------------------------------------- | ----------------- | --------------------------- |
| `organization_id`                             | int                        | 非空FK公司；新增：同设备不同公司独立运行                                                                                 | 不存在                                                      | **新增**                         | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/local-runtime.service.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `trigger_type`                                | varchar(16)                | MANUAL/AUTO/RETRY；新增：手动不推进自动计划                                                                              | varchar(16) 非空                                            | **调整（枚举冲突，见 OI-01）**   | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/local-runtime.service.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `manual_upload_status／manual_cleanup_status` | varchar(16)／varchar(16)   | 手动流程适用；待执行／执行中／成功／失败／未执行；生成状态不替代上传或清理；复用 backup_asset 稳定编号及回执，不另建包表 | 不存在                                                      | **新增（2 列，技术候选待确认）** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/local-runtime.service.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `运行唯一约束（非新增字段）`                  | 设备+公司+RUNNING 条件唯一 | 不同公司可独立计划，避免原设备全局唯一挡住合法任务；前向调整生成列/索引，不改已接受迁移                                  | 现有 `uk_local_backup_run_active`（active_installation_id） | **调整（约束，非列）**           | 前向生成列/索引调整               | `src/modules/lithography/local-runtime.service.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |

<details><summary>现有约束（Entity 声明，7 条）</summary>

| 类别       | 名称/字段                          | 声明                                                                                                        |
| ---------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 唯一约束   | `uk_local_backup_run_active`       | （active_installation_id）                                                                                  |
| 索引       | `idx_local_backup_run_started`     | （started_at）                                                                                              |
| 外键       | `fk_local_backup_run_installation` | （installation_id）→ local_installation（installation_id）；ON DELETE RESTRICT；ON UPDATE RESTRICT          |
| CHECK      | `chk_local_backup_run_trigger`     | `trigger_type` IN ('SCHEDULED', 'MANUAL', 'USB_EXPORT')                                                     |
| CHECK      | `chk_local_backup_run_status`      | `status` IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')                                               |
| CHECK      | `chk_local_backup_run_finish`      | ((`status` = 'RUNNING' AND `finished_at` IS NULL) OR (`status` <> 'RUNNING' AND `finished_at` IS NOT NULL)) |
| 生成列补充 | `active_installation_id`           | 可空；生成列 STORED：IF(`status` = 'RUNNING', `installation_id`, NULL)；禁止INSERT写入；禁止UPDATE写入      |

</details>

消费者文件（5）：
`src/modules/lithography/local-runtime.service.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/local-runtime.mapper.ts`, `src/modules/lithography/queries/local-runtime.query.service.ts`, `test/utils/unique-index-constraints.e2e-spec.ts`

### 3.18 `local_installation`

- 定位：现有表；Entity [local-installation.entity.ts](../../src/modules/lithography/entities/local-installation.entity.ts)；创建迁移 [1775401400000-create-local-installation-upload-backup.migration.ts](../../src/infrastructure/database/migrations/1775401400000-create-local-installation-upload-backup.migration.ts)
- 说明：保存本机安装的稳定身份和旧配置；目标设计将多公司的设置分离，不用单行公司配置覆盖整台设备。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 10；目标设计行 1；现有约束 5；直接消费者 5；测试 0

| 目标字段/约束                                                | 目标类型          | 目标约束/用途                                                                                                                                                | 现状                                | 动作                           | 迁移方式             | 消费者                                              | 测试              | 状态                   |
| ------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------ | -------------------- | --------------------------------------------------- | ----------------- | ---------------------- |
| `organization_id／auto_upload_enabled／backup_interval_days` | int／boolean／int | 旧单行配置保留历史兼容；不能继续作为同机所有公司的唯一设置。设备保持独立身份，各公司配置迁往 `local_company_setting`（installation_id+organization_id 唯一） | int 可空 FK；boolean 非空；int 非空 | **保留（历史兼容，0 新增列）** | 无 DDL；新配置写新表 | `src/modules/lithography/local-runtime.service.ts`… | 0（随消费者 e2e） | 沿用现有结构（无 DDL） |

<details><summary>现有约束（Entity 声明，5 条）</summary>

| 类别     | 名称/字段                               | 声明                                                                            |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| 唯一约束 | `uk_local_installation_installation_id` | （installation_id）                                                             |
| 索引     | `idx_local_installation_organization`   | （organization_id）                                                             |
| 外键     | `fk_local_installation_organization`    | （organization_id）→ organization（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |
| CHECK    | `chk_local_installation_singleton`      | `id` = 1                                                                        |
| CHECK    | `chk_local_installation_interval`       | `backup_interval_days` >= 1                                                     |

</details>

消费者文件（5）：
`src/modules/lithography/local-runtime.service.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/local-runtime.mapper.ts`, `src/modules/lithography/queries/local-runtime.query.service.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.19 `local_upload_task`

- 定位：现有表；Entity [local-upload-task.entity.ts](../../src/modules/lithography/entities/local-upload-task.entity.ts)；创建迁移 [1775401400000-create-local-installation-upload-backup.migration.ts](../../src/infrastructure/database/migrations/1775401400000-create-local-installation-upload-backup.migration.ts)
- 说明：保存业务同步或备份上传任务、重试和实际结果；目标设计明确区分BUSINESS_SYNC与BACKUP_UPLOAD。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 15；目标设计行 4；现有约束 10；直接消费者 4；测试 0

| 目标字段/约束       | 目标类型     | 目标约束/用途                                                           | 现状   | 动作     | 迁移方式                          | 消费者                                              | 测试              | 状态                        |
| ------------------- | ------------ | ----------------------------------------------------------------------- | ------ | -------- | --------------------------------- | --------------------------------------------------- | ----------------- | --------------------------- |
| `record_uuid`       | char(36)     | 新任务非空；新增：跨端去重标识                                          | 不存在 | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/local-runtime.service.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `source_version`    | int unsigned | 非空；新增：业务版本                                                    | 不存在 | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/local-runtime.service.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `task_kind`         | varchar(32)  | 区分BUSINESS_SYNC/BACKUP_UPLOAD；新增或映射现有类型，不能混用云备份开关 | 不存在 | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/local-runtime.service.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `manifest_checksum` | char(64)     | 成功前校验完整正文原件；新增：回执一致性                                | 不存在 | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/local-runtime.service.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |

<details><summary>现有约束（Entity 声明，10 条）</summary>

| 类别     | 名称/字段                              | 声明                                                                                               |
| -------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 唯一约束 | `uk_local_upload_task_idempotency`     | （idempotency_key）                                                                                |
| 唯一约束 | `uk_local_upload_task_entity`          | （installation_id, entity_type, entity_local_id, entity_version）                                  |
| 索引     | `idx_local_upload_task_status_created` | （status, created_at）                                                                             |
| 外键     | `fk_local_upload_task_installation`    | （installation_id）→ local_installation（installation_id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |
| CHECK    | `chk_local_upload_task_entity_type`    | `entity_type` IN ('REPORT_VERSION', 'ATTACHMENT', 'BACKUP_MANIFEST')                               |
| CHECK    | `chk_local_upload_task_status`         | `status` IN ('PENDING', 'UPLOADING', 'SUCCEEDED', 'FAILED', 'CANCELLED')                           |
| CHECK    | `chk_local_upload_task_attempt`        | `attempt_count` >= 0                                                                               |
| CHECK    | `chk_local_upload_task_version`        | CHAR_LENGTH(TRIM(`entity_version`)) > 0                                                            |
| CHECK    | `chk_local_upload_task_idempotency`    | CHAR_LENGTH(TRIM(`idempotency_key`)) > 0                                                           |
| CHECK    | `chk_local_upload_task_error`          | `status` <> 'FAILED' OR (`error_code` IS NOT NULL AND `error_message` IS NOT NULL)                 |

</details>

消费者文件（4）：
`src/modules/lithography/local-runtime.service.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/local-runtime.mapper.ts`, `src/modules/lithography/queries/local-runtime.query.service.ts`

### 3.20 `maintenance_report_alarm`

- 定位：现有表；Entity [maintenance-report-alarm.entity.ts](../../src/modules/lithography/entities/maintenance-report-alarm.entity.ts)；创建迁移 [1775401200000-create-maintenance-report-and-content.migration.ts](../../src/infrastructure/database/migrations/1775401200000-create-maintenance-report-and-content.migration.ts)
- 说明：仅保留旧报告固定1—8报警槽位；新八字段故障结构使用maintenance_report_fault，不再按八槽位录入。
- 本期处理：旧1—8报警槽位仅兼容历史；V13八字段使用maintenance_report_fault，不把八字段复制成八条报警。
- 规模：现有字段 7；目标设计行 0；现有约束 7；直接消费者 4；测试 0
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，7 条）</summary>

| 类别     | 名称/字段                            | 声明                                                                                                                            |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 唯一约束 | `uk_maintenance_report_alarm_slot`   | （report_id, alarm_index）                                                                                                      |
| 索引     | `idx_maintenance_report_alarm_code`  | （alarm_code）                                                                                                                  |
| 外键     | `fk_maintenance_report_alarm_report` | （report_id）→ maintenance_report（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                 |
| CHECK    | `chk_maintenance_report_alarm_index` | `alarm_index` BETWEEN 1 AND 8                                                                                                   |
| CHECK    | `chk_maintenance_report_alarm_code`  | CHAR_LENGTH(TRIM(`alarm_code`)) > 0                                                                                             |
| CHECK    | `chk_maintenance_report_alarm_phase` | `phase_code` IN ('PHASE_01','PHASE_02','PHASE_03','PHASE_04','PHASE_05','PHASE_06','PHASE_07','PHASE_08','PHASE_09','PHASE_10') |
| CHECK    | `chk_maintenance_report_alarm_reset` | `reset_result` IN ('RESET_OK', 'RESET_FAILED', 'NOT_ATTEMPTED')                                                                 |

</details>

消费者文件（4）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/maintenance-report.service.ts`, `src/modules/lithography/maintenance-report.mapper.ts`, `src/modules/lithography/queries/maintenance-report.query.service.ts`

### 3.21 `maintenance_report_attachment`

- 定位：现有表；Entity [maintenance-report-attachment.entity.ts](../../src/modules/lithography/entities/maintenance-report-attachment.entity.ts)；创建迁移 [1775401300000-create-maintenance-report-attachment-version-review.migration.ts](../../src/infrastructure/database/migrations/1775401300000-create-maintenance-report-attachment-version-review.migration.ts)
- 说明：保存报告当前及历史附件关联；正式提交和读取均核验本报告的有效原件。
- 本期处理：复用现有数据与关联，按V13授权和状态规则使用
- 规模：现有字段 16；目标设计行 0；现有约束 12；直接消费者 8；测试 0
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，12 条）</summary>

| 类别       | 名称/字段                                         | 声明                                                                                                     |
| ---------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 唯一约束   | `uk_maintenance_report_attachment_active_slot`    | （report_id, active_sort_order）                                                                         |
| 唯一约束   | `uk_maintenance_report_attachment_id_report`      | （id, report_id）                                                                                        |
| 索引       | `idx_maintenance_report_attachment_report_status` | （report_id, status, sort_order）                                                                        |
| 外键       | `fk_maintenance_report_attachment_report`         | （report_id）→ maintenance_report（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                          |
| 外键       | `fk_maintenance_report_attachment_uploaded_by`    | （uploaded_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT              |
| CHECK      | `chk_maintenance_report_attachment_byte_size`     | `byte_size` > 0 AND `byte_size` <= 20971520                                                              |
| CHECK      | `chk_maintenance_report_attachment_sort`          | `sort_order` BETWEEN 1 AND 10                                                                            |
| CHECK      | `chk_maintenance_report_attachment_status`        | `status` IN ('CURRENT', 'RETIRED')                                                                       |
| CHECK      | `chk_maintenance_report_attachment_retired`       | ((`status` = 'CURRENT' AND `retired_at` IS NULL) OR (`status` = 'RETIRED' AND `retired_at` IS NOT NULL)) |
| CHECK      | `chk_maintenance_report_attachment_storage`       | `storage_backend` IN ('LOCAL', 'OBJECT')                                                                 |
| CHECK      | `chk_maintenance_report_attachment_filename`      | CHAR_LENGTH(TRIM(`original_filename`)) > 0                                                               |
| 生成列补充 | `active_sort_order`                               | 可空；生成列 STORED：IF(`status` = 'CURRENT', `sort_order`, NULL)；禁止INSERT写入；禁止UPDATE写入        |

</details>

消费者文件（8）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/maintenance-report.service.ts`, `src/modules/lithography/maintenance-report.mapper.ts`, `src/modules/lithography/queries/maintenance-report.query.service.ts`, `test/utils/unique-index-constraints.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.22 `maintenance_report_review`

- 定位：现有表；Entity [maintenance-report-review.entity.ts](../../src/modules/lithography/entities/maintenance-report-review.entity.ts)；创建迁移 [1775401300000-create-maintenance-report-attachment-version-review.migration.ts](../../src/infrastructure/database/migrations/1775401300000-create-maintenance-report-attachment-version-review.migration.ts)
- 说明：保留旧报告审核决定和意见；V13新报告直接提交，不以本表作为发布前置。
- 本期处理：保留旧报告审核历史，不为新报告创建待审流程。
- 规模：现有字段 7；目标设计行 0；现有约束 7；直接消费者 7；测试 0
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，7 条）</summary>

| 类别     | 名称/字段                                   | 声明                                                                                                           |
| -------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 唯一约束 | `uk_maintenance_report_review_version`      | （version_id）                                                                                                 |
| 唯一约束 | `uk_maintenance_report_review_id_report`    | （id, report_id）                                                                                              |
| 索引     | `idx_maintenance_report_review_report_time` | （report_id, reviewed_at）                                                                                     |
| 外键     | `fk_maintenance_report_review_version`      | （version_id, report_id）→ maintenance_report_version（id, report_id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |
| 外键     | `fk_maintenance_report_review_reviewer`     | （reviewed_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                    |
| CHECK    | `chk_maintenance_report_review_decision`    | `decision` IN ('APPROVE', 'RETURN')                                                                            |
| CHECK    | `chk_maintenance_report_review_comment`     | `decision` = 'APPROVE' OR `comment` IS NOT NULL                                                                |

</details>

消费者文件（7）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/maintenance-report.service.ts`, `src/modules/lithography/maintenance-report.mapper.ts`, `src/modules/lithography/queries/maintenance-report.query.service.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.23 `maintenance_report_step`

- 定位：现有表；Entity [maintenance-report-step.entity.ts](../../src/modules/lithography/entities/maintenance-report-step.entity.ts)；创建迁移 [1775401200000-create-maintenance-report-and-content.migration.ts](../../src/infrastructure/database/migrations/1775401200000-create-maintenance-report-and-content.migration.ts)
- 说明：保存报告排查步骤及稳定步骤标识；新增故障仍属于原报告，排序不改变步骤身份。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 12；目标设计行 6；现有约束 9；直接消费者 4；测试 0

| 目标字段/约束              | 目标类型                                                    | 目标约束/用途                                                  | 现状                               | 动作                       | 迁移方式                          | 消费者                                           | 测试              | 状态                        |
| -------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------- | -------------------------- | --------------------------------- | ------------------------------------------------ | ----------------- | --------------------------- |
| `error_code`               | varchar(300)                                                | 选填，保留前导零；新增：步骤报错代码                           | 不存在                             | **新增**                   | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `part_name`                | varchar(300)                                                | 选填；调整：现100→300                                          | varchar(100) 可空                  | **调整**                   | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `action_text`              | longtext                                                    | 正式必填，≤10000字；调整：确保字符上限不受TEXT字节容量截断     | text 非空                          | **调整**                   | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `result_code`              | varchar(16)                                                 | 正式RESOLVED/UNRESOLVED/NEW_FAULT必选；新增：与自由文字分开    | 不存在                             | **新增**                   | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `step_no`                  | int unsigned                                                | 报告内唯一且≥1，排序使用安全变更；调整：不限制十步             | smallint unsigned 非空             | **调整**                   | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `新故障关联（非新增字段）` | 由 `maintenance_report_fault` 引用 `report_id`、`step_code` | 稳定步骤标识不随排序变化；旧 `new_alarm_code` 不能代完整八字段 | 现有 `new_alarm_code` 与分支 CHECK | **调整（关联规则，非列）** | 前向调整 CHECK/引用（不改 31 条） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |

<details><summary>现有约束（Entity 声明，9 条）</summary>

| 类别     | 名称/字段                            | 声明                                                                                                                            |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 唯一约束 | `uk_maintenance_report_step_no`      | （report_id, step_no）                                                                                                          |
| 唯一约束 | `uk_maintenance_report_step_code`    | （report_id, step_code）                                                                                                        |
| 索引     | `idx_maintenance_report_step_phase`  | （report_id, phase_code）                                                                                                       |
| 外键     | `fk_maintenance_report_step_report`  | （report_id）→ maintenance_report（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                 |
| CHECK    | `chk_maintenance_report_step_no`     | `step_no` >= 1                                                                                                                  |
| CHECK    | `chk_maintenance_report_step_code`   | CHAR_LENGTH(TRIM(`step_code`)) > 0                                                                                              |
| CHECK    | `chk_maintenance_report_step_action` | CHAR_LENGTH(TRIM(`action_text`)) > 0                                                                                            |
| CHECK    | `chk_maintenance_report_step_phase`  | `phase_code` IN ('PHASE_01','PHASE_02','PHASE_03','PHASE_04','PHASE_05','PHASE_06','PHASE_07','PHASE_08','PHASE_09','PHASE_10') |
| CHECK    | `chk_maintenance_report_step_branch` | `is_valid_new_branch` IN (0, 1) AND (`is_valid_new_branch` = 0 OR `new_alarm_code` IS NOT NULL)                                 |

</details>

消费者文件（4）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/maintenance-report.service.ts`, `src/modules/lithography/maintenance-report.mapper.ts`, `src/modules/lithography/queries/maintenance-report.query.service.ts`

### 3.24 `maintenance_report_version_attachment`

- 定位：现有表；Entity [maintenance-report-version-attachment.entity.ts](../../src/modules/lithography/entities/maintenance-report-version-attachment.entity.ts)；创建迁移 [1775401300000-create-maintenance-report-attachment-version-review.migration.ts](../../src/infrastructure/database/migrations/1775401300000-create-maintenance-report-attachment-version-review.migration.ts)
- 说明：记录某一冻结报告版本实际关联的附件，保证历史版本与原件能对应读回。
- 本期处理：复用现有数据与关联，按V13授权和状态规则使用
- 规模：现有字段 6；目标设计行 0；现有约束 6；直接消费者 4；测试 0
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，6 条）</summary>

| 类别     | 名称/字段                                              | 声明                                                                                                                 |
| -------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 唯一约束 | `uk_maintenance_report_version_attachment_sort`        | （version_id, sort_order）                                                                                           |
| 索引     | `idx_maintenance_report_version_attachment_attachment` | （attachment_id）                                                                                                    |
| 外键     | `fk_maintenance_report_version_attachment_version`     | （version_id, report_id）→ maintenance_report_version（id, report_id）；ON DELETE RESTRICT；ON UPDATE RESTRICT       |
| 外键     | `fk_maintenance_report_version_attachment_attachment`  | （attachment_id, report_id）→ maintenance_report_attachment（id, report_id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |
| CHECK    | `chk_maintenance_report_version_attachment_sort`       | `sort_order` BETWEEN 1 AND 10                                                                                        |
| CHECK    | `chk_maintenance_report_version_attachment_publish`    | `publish_flag` IN (0, 1)                                                                                             |

</details>

消费者文件（4）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/maintenance-report.service.ts`, `src/modules/lithography/maintenance-report.mapper.ts`, `src/modules/lithography/queries/maintenance-report.query.service.ts`

### 3.25 `maintenance_report_version`

- 定位：现有表；Entity [maintenance-report-version.entity.ts](../../src/modules/lithography/entities/maintenance-report-version.entity.ts)；创建迁移 [1775401300000-create-maintenance-report-attachment-version-review.migration.ts](../../src/infrastructure/database/migrations/1775401300000-create-maintenance-report-attachment-version-review.migration.ts)
- 说明：保存报告正式提交的冻结版本，保留原始提交内容，不被后续管理修订无痕覆盖。
- 本期处理：复用现有数据与关联，按V13授权和状态规则使用
- 规模：现有字段 10；目标设计行 0；现有约束 10；直接消费者 7；测试 0
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，10 条）</summary>

| 类别     | 名称/字段                                          | 声明                                                                                         |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 唯一约束 | `uk_maintenance_report_version_no`                 | （report_id, version_no）                                                                    |
| 唯一约束 | `uk_maintenance_report_version_id_report`          | （id, report_id）                                                                            |
| 索引     | `idx_maintenance_report_version_submitted`         | （report_id, submitted_at）                                                                  |
| 外键     | `fk_maintenance_report_version_report`             | （report_id）→ maintenance_report（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT              |
| 外键     | `fk_maintenance_report_version_submitted_by`       | （submitted_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |
| CHECK    | `chk_maintenance_report_version_no`                | `version_no` >= 1                                                                            |
| CHECK    | `chk_maintenance_report_version_change_kind`       | `change_kind` IN ('SUBMIT', 'FORMAL_CORRECTION')                                             |
| CHECK    | `chk_maintenance_report_version_correction_reason` | `change_kind` = 'SUBMIT' OR `change_reason` IS NOT NULL                                      |
| CHECK    | `chk_maintenance_report_version_payload`           | JSON_VALID(`payload_snapshot`)                                                               |
| CHECK    | `chk_maintenance_report_version_schema`            | `schema_version` >= 2                                                                        |

</details>

消费者文件（7）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/maintenance-report.service.ts`, `src/modules/lithography/maintenance-report.mapper.ts`, `src/modules/lithography/queries/maintenance-report.query.service.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.26 `maintenance_report`

- 定位：现有表；Entity [maintenance-report.entity.ts](../../src/modules/lithography/entities/maintenance-report.entity.ts)；创建迁移 [1775401200000-create-maintenance-report-and-content.migration.ts](../../src/infrastructure/database/migrations/1775401200000-create-maintenance-report-and-content.migration.ts)
- 说明：保存独立故障报告或工单总结的根记录、表头、维修事实和模型评价；目标设计补齐一次正式提交的状态、持久请求标识和内容摘要，覆盖首次无报告ID的重试。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 28；目标设计行 15；现有约束 21；直接消费者 10；测试 0

| 目标字段/约束                                       | 目标类型             | 目标约束/用途                                                                                                                                                                                                                            | 现状                                      | 动作                 | 迁移方式                          | 消费者                                           | 测试              | 状态                        |
| --------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------- | --------------------------------- | ------------------------------------------------ | ----------------- | --------------------------- |
| `title`                                             | varchar(200)         | 历史保留；新统一报告不新增标题必填；取消新普通资料标题输入，不由历史字段反推新建入口                                                                                                                                                     | varchar(200) 可空                         | **保留（历史兼容）** | 无 DDL 或仅补 CHECK/索引          | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `customer_factory_name`                             | varchar(200)         | 草稿可空，正式必填；调整：现100→200，厂家为客户厂家                                                                                                                                                                                      | varchar(100) 可空                         | **调整**             | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `equipment_model_text`                              | varchar(200)         | 正式报告保留当次文字快照；调整：不以字典后改影响历史                                                                                                                                                                                     | varchar(100) 可空                         | **调整**             | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `maintenance_engineer_name_snapshot`                | varchar(200)         | 正式必填；调整：现50→200，和实际账号ID分别保存                                                                                                                                                                                           | varchar(50) 非空                          | **调整**             | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `supplementary_note`                                | longtext             | 可空，≤10000字；新增：补充说明                                                                                                                                                                                                           | 不存在                                    | **新增**             | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `handling_result`                                   | varchar(32)          | 正式五选一；新增：独立报告和工单总结共用                                                                                                                                                                                                 | 不存在                                    | **新增**             | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `closure_reason`                                    | text                 | 中断或无法修复必填；新增：报告结果原因                                                                                                                                                                                                   | 不存在                                    | **新增**             | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `reset_result`                                      | varchar(24)          | 正式必选NORMAL/SAME_FAULT/NEW_FAULT；新增：统一复位结果                                                                                                                                                                                  | 不存在                                    | **新增**             | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `actual_cause／repair_actions／verification_result` | text／longtext／text | 正式≤2000／10000／2000 字且必填；新增：工单总结三类实际事实                                                                                                                                                                              | 不存在                                    | **新增（3 列）**     | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `ai_helpfulness`                                    | tinyint              | 实际模型参与时正式1—4必填；调整：帮助四档                                                                                                                                                                                                | tinyint unsigned 可空                     | **调整**             | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `ai_correctness`                                    | varchar(24)          | CORRECT/PARTIAL/INCORRECT/UNKNOWN；调整：补无法判断                                                                                                                                                                                      | varchar(16) 可空                          | **调整**             | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `ai_score／ai_note`                                 | tinyint／text        | 评分1—5；说明≤2000字选填；沿用字段，按V13收紧校验                                                                                                                                                                                        | tinyint unsigned 可空；varchar(2000) 可空 | **保留（收紧校验）** | 无 DDL 或仅补 CHECK/索引          | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `status`                                            | varchar(16)          | 新流程DRAFT／SUBMITTED；只允许一次DRAFT→SUBMITTED，旧审核值仅历史；状态变更与冻结版本、资料条目及有效附件关联同事务；已提交不能换请求标识重新发布；后续管理修订走资料修订，不解冻原报告                                                  | varchar(16) 非空；默认 'DRAFT'            | **调整（状态机）**   | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `submission_request_id`                             | varchar(64)          | 新正式提交非空；历史／尚未提交草稿可空；UK(created_by_account_id,owner_organization_id,submission_request_id)；首次请求发送前生成并在结果未确认期间持久保留，同次重试不变；已有草稿也使用。无report_id时仍可定位同次提交，不新增业务表。 | 不存在                                    | **新增**             | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |
| `submission_payload_hash`                           | char(64)             | 与提交标识配对；新提交由服务端计算规范化内容SHA-256；覆盖提交内容、来源及有效附件身份等；同标识不同内容拒绝。身份与权限另行核验；不保存密码或Token，不以客户端自报摘要代替核验。                                                         | 不存在                                    | **新增**             | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 0（随消费者 e2e） | S2 结构已实现（待实库验证） |

<details><summary>现有约束（Entity 声明，21 条）</summary>

| 类别     | 名称/字段                                     | 声明                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 唯一约束 | `uk_maintenance_report_request`               | （repair_request_id）                                                                                                                                                                                                                                                                                                                                                                               |
| 唯一约束 | `uk_maintenance_report_id_owner`              | （id, owner_organization_id）                                                                                                                                                                                                                                                                                                                                                                       |
| 索引     | `idx_maintenance_report_owner_status_created` | （owner_organization_id, status, created_at）                                                                                                                                                                                                                                                                                                                                                       |
| 索引     | `idx_maintenance_report_engineer_created`     | （maintenance_engineer_account_id, created_at）                                                                                                                                                                                                                                                                                                                                                     |
| 索引     | `idx_maintenance_report_source_created`       | （source_type, created_at）                                                                                                                                                                                                                                                                                                                                                                         |
| 外键     | `fk_maintenance_report_owner_organization`    | （owner_organization_id）→ organization（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                                                                                                                                                                                                                               |
| 外键     | `fk_maintenance_report_repair_request`        | （repair_request_id）→ repair_request（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                                                                                                                                                                                                                                 |
| 外键     | `fk_maintenance_report_equipment_model`       | （equipment_model_id）→ equipment_model（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                                                                                                                                                                                                                               |
| 外键     | `fk_maintenance_report_engineer_account`      | （maintenance_engineer_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                                                                                                                                                                                                                |
| 外键     | `fk_maintenance_report_created_by`            | （created_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                                                                                                                                                                                                                          |
| 外键     | `fk_maintenance_report_updated_by`            | （updated_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                                                                                                                                                                                                                          |
| CHECK    | `chk_maintenance_report_source`               | `source_type` IN ('HISTORICAL_CASE', 'WORK_ORDER_SUMMARY')                                                                                                                                                                                                                                                                                                                                          |
| CHECK    | `chk_maintenance_report_request_source`       | ((`source_type` = 'WORK_ORDER_SUMMARY' AND `repair_request_id` IS NOT NULL) OR (`source_type` = 'HISTORICAL_CASE' AND `repair_request_id` IS NULL))                                                                                                                                                                                                                                                 |
| CHECK    | `chk_maintenance_report_status`               | `status` IN ('DRAFT', 'PENDING_REVIEW', 'RETURNED', 'APPROVED')                                                                                                                                                                                                                                                                                                                                     |
| CHECK    | `chk_maintenance_report_status_consistency`   | ((`status` = 'DRAFT' AND `current_version_no` = 0 AND `last_submitted_at` IS NULL AND `last_reviewed_at` IS NULL) OR (`status` = 'PENDING_REVIEW' AND `current_version_no` >= 1 AND `last_submitted_at` IS NOT NULL AND `last_reviewed_at` IS NULL) OR (`status` IN ('RETURNED', 'APPROVED') AND `current_version_no` >= 1 AND `last_submitted_at` IS NOT NULL AND `last_reviewed_at` IS NOT NULL)) |
| CHECK    | `chk_maintenance_report_model_exclusive`      | `equipment_model_id` IS NULL OR `equipment_model_text` IS NULL                                                                                                                                                                                                                                                                                                                                      |
| CHECK    | `chk_maintenance_report_phase_flow`           | `phase_flow_version` >= 1                                                                                                                                                                                                                                                                                                                                                                           |
| CHECK    | `chk_maintenance_report_ai_usage`             | ((`ai_usage` = 'NOT_USED' AND `ai_source_type` IS NULL AND `ai_source_id` IS NULL AND `ai_source_version` IS NULL AND `ai_score` IS NULL AND `ai_correctness` IS NULL AND `ai_helpfulness` IS NULL AND `ai_note` IS NULL) OR (`ai_usage` = 'USED' AND `ai_source_type` IS NOT NULL AND CHAR_LENGTH(TRIM(`ai_source_type`)) > 0 AND `ai_source_id` IS NOT NULL AND `ai_source_version` IS NOT NULL)) |
| CHECK    | `chk_maintenance_report_ai_score`             | `ai_score` IS NULL OR `ai_score` BETWEEN 1 AND 5                                                                                                                                                                                                                                                                                                                                                    |
| CHECK    | `chk_maintenance_report_ai_helpfulness`       | `ai_helpfulness` IS NULL OR `ai_helpfulness` BETWEEN 1 AND 5                                                                                                                                                                                                                                                                                                                                        |
| CHECK    | `chk_maintenance_report_ai_correctness`       | `ai_correctness` IS NULL OR `ai_correctness` IN ('CORRECT', 'PARTIAL', 'INCORRECT')                                                                                                                                                                                                                                                                                                                 |

</details>

消费者文件（10）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/maintenance-report.service.ts`, `src/modules/lithography/maintenance-report.mapper.ts`, `src/modules/lithography/queries/maintenance-report.query.service.ts`, `test/10-admin-document-database/admin-document-database-production-ownership.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-fixture-ownership.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture-ownership.e2e-spec.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.27 `material_submission_detail`

- 定位：现有表；Entity [material-submission-detail.entity.ts](../../src/modules/lithography/entities/material-submission-detail.entity.ts)；创建迁移 [1775301300000-create-material-submission-detail-table.migration.ts](../../src/infrastructure/database/migrations/1775301300000-create-material-submission-detail-table.migration.ts)
- 说明：保留旧普通资料的标题、正文、类型和机型等明细；不新增普通文档填写或提交功能。
- 本期处理：仅保留既有普通资料及历史关联；取消新建入口，不作为两类新报告的必需写入链
- 规模：现有字段 10；目标设计行 0；现有约束 5；直接消费者 7；测试 1
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，5 条）</summary>

| 类别  | 名称/字段                                        | 声明                                                                                  |
| ----- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 索引  | `idx_material_submission_detail_equipment_model` | （equipment_model_id）                                                                |
| 外键  | `fk_material_submission_detail_submission`       | （submission_id）→ content_submission（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT   |
| 外键  | `fk_material_submission_detail_equipment_model`  | （equipment_model_id）→ equipment_model（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT |
| CHECK | `chk_material_submission_detail_model_exclusive` | (`equipment_model_id` IS NULL OR `equipment_model_text` IS NULL)                      |
| CHECK | `chk_material_submission_detail_type`            | (`document_type` IS NULL OR `document_type` <> 'FAULT_CASE')                          |

</details>

消费者文件（7）：
`src/modules/lithography/content-submission.service.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/content-submission.query.service.spec.ts`, `src/modules/lithography/queries/content-submission.query.service.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts`, `test/10-admin-document-database/admin-document-database-production-fixture.ts`, `test/06-repair-request/repair-request-fixture.ts`

### 3.28 `organization_membership`

- 定位：现有表；Entity [organization-membership.entity.ts](../../src/modules/lithography/entities/organization-membership.entity.ts)；创建迁移 [1775301100000-create-organization-membership-table.migration.ts](../../src/infrastructure/database/migrations/1775301100000-create-organization-membership-table.migration.ts)
- 说明：保存工程师及管理员与公司的有效成员关系，用于确定公司范围；同一账号只允许一条ACTIVE归属。
- 本期处理：复用现有数据与关联，按V13授权和状态规则使用
- 规模：现有字段 10；目标设计行 0；现有约束 10；直接消费者 17；测试 1
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，10 条）</summary>

| 类别       | 名称/字段                                     | 声明                                                                                             |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 唯一约束   | `uk_organization_membership_active_account`   | （active_account_id）                                                                            |
| 唯一约束   | `uk_organization_membership_org_account`      | （organization_id, account_id）                                                                  |
| 索引       | `idx_organization_membership_account_status`  | （account_id, status）                                                                           |
| 索引       | `idx_organization_membership_org_role_status` | （organization_id, member_role, status）                                                         |
| 外键       | `fk_organization_membership_organization`     | （organization_id）→ organization（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                  |
| 外键       | `fk_organization_membership_account`          | （account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                  |
| CHECK      | `chk_organization_membership_role`            | `member_role` IN ('SUPER_ADMIN', 'ENGINEER', 'CUSTOMER')                                         |
| CHECK      | `chk_organization_membership_status`          | `status` IN ('ACTIVE', 'LEFT')                                                                   |
| CHECK      | `chk_organization_membership_period`          | ((`status` = 'ACTIVE' AND `left_at` IS NULL) OR (`status` = 'LEFT' AND `left_at` IS NOT NULL))   |
| 生成列补充 | `active_account_id`                           | 可空；生成列 STORED：IF(`status` = 'ACTIVE', `account_id`, NULL)；禁止INSERT写入；禁止UPDATE写入 |

</details>

消费者文件（17）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/organization-membership.service.ts`, `src/modules/lithography/queries/organization-membership.query.service.spec.ts`, `src/modules/lithography/queries/organization-membership.query.service.ts`, `test/04-user-info/admin-user-management.e2e-spec.ts`, `test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts`, `test/utils/test-organizations.ts`, `test/utils/e2e-scoped-cleanup.e2e-spec.ts`, `test/utils/unique-index-constraints.e2e-spec.ts`, `test/02-register/engineer-registration-approval.e2e-spec.ts`, `test/02-register/weapp-register-active.e2e-spec.ts`, `test/02-register/register.e2e-spec.ts` …

### 3.29 `organization`

- 定位：现有表；Entity [organization.entity.ts](../../src/modules/lithography/entities/organization.entity.ts)；创建迁移 [1775301000000-create-organization-table.migration.ts](../../src/infrastructure/database/migrations/1775301000000-create-organization-table.migration.ts)
- 说明：保存客户或服务公司的稳定档案；目标字段区分有效管理名单、启用状态和维修服务资格。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 7；目标设计行 9；现有约束 4；直接消费者 15；测试 4

| 目标字段/约束         | 目标类型      | 目标约束/用途                                                                                                                                                                                                         | 现状              | 动作     | 迁移方式                          | 消费者                                           | 测试                                                                              | 状态                        |
| --------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------- | --------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------- |
| `name`                | varchar(200)  | 非空，编号不随改名变化；调整：全称候选长度，避免现有100限制报告表头                                                                                                                                                   | varchar(100) 非空 | **调整** | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `short_name`          | varchar(100)  | 可空；新增：简称                                                                                                                                                                                                      | 不存在            | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `contact_name`        | varchar(200)  | 可空，选填；联系人姓名；1级维护公司同样选填，不要求等于管理员                                                                                                                                                         | 不存在            | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `contact_phone`       | varchar(100)  | 1级维护名单必填；客户自填记录可空；新增：公司联系电话，支持区号分机                                                                                                                                                   | 不存在            | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `contact_email`       | varchar(254)  | 可空，不要求企业域名；新增：公司邮箱                                                                                                                                                                                  | 不存在            | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `address`             | varchar(1000) | 可空；新增：公司地址，不代表维修现场                                                                                                                                                                                  | 不存在            | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `remark`              | text          | 可空；新增：备注                                                                                                                                                                                                      | 不存在            | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `is_service_provider` | boolean       | 非空，默认false；新增：服务资格，不由注册审批自动打开                                                                                                                                                                 | 不存在            | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `is_managed_company`  | boolean       | 非空，默认false；仅服务端依据1级名单维护写入；技术设计候选：客户自由填名为false；1级新增管理名单为true。注册候选及工程师保存同时要求true且status=ACTIVE，不与服务资格混用；旧记录按可核实来源回填，不明不自动入名单。 | 不存在            | **新增** | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |

<details><summary>现有约束（Entity 声明，4 条）</summary>

| 类别     | 名称/字段                      | 声明                               |
| -------- | ------------------------------ | ---------------------------------- |
| 唯一约束 | `uk_organization_code`         | （organization_code）              |
| 索引     | `idx_organization_kind_status` | （kind, status）                   |
| CHECK    | `chk_organization_kind`        | `kind` IN ('CLIENT', 'PEER')       |
| CHECK    | `chk_organization_status`      | `status` IN ('ACTIVE', 'DISABLED') |

</details>

消费者文件（15）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/content-submission.query.service.spec.ts`, `src/modules/lithography/queries/organization-membership.query.service.spec.ts`, `src/modules/lithography/queries/organization-membership.query.service.ts`, `src/modules/lithography/queries/reference-document.query.service.ts`, `src/modules/lithography/queries/repair-request.organization.integration.spec.ts`, `src/modules/lithography/queries/organization.query.service.ts`, `src/modules/lithography/queries/reference-document.query.service.spec.ts`, `test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts`, `test/utils/test-organizations.ts`, `test/utils/e2e-scoped-cleanup.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-production-ownership.e2e-spec.ts` …

### 3.30 `reference_document_case_detail`

- 定位：现有表；Entity [reference-document-case-detail.entity.ts](../../src/modules/lithography/entities/reference-document-case-detail.entity.ts)；创建迁移 [1775301800000-create-reference-document-case-detail-table.migration.ts](../../src/infrastructure/database/migrations/1775301800000-create-reference-document-case-detail-table.migration.ts)
- 说明：保留旧正式故障案例扩展明细；新报告通过来源及冻结版本关联，避免再复制一套完整报告。
- 本期处理：保留旧资料案例扩展；新增报告来源与冻结版本关联时避免复制第三套报告。
- 规模：现有字段 13；目标设计行 0；现有约束 3；直接消费者 6；测试 1
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，3 条）</summary>

| 类别  | 名称/字段                                       | 声明                                                                                                    |
| ----- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 外键  | `fk_reference_document_case_detail_document`    | （document_id）→ reference_document（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                       |
| CHECK | `chk_reference_document_case_detail_status`     | `handling_status` IN ('UNRESOLVED', 'IN_PROGRESS', 'RESOLVED')                                          |
| CHECK | `chk_reference_document_case_detail_resolution` | (`handling_status` <> 'RESOLVED' OR (`resolution` IS NOT NULL AND CHAR_LENGTH(TRIM(`resolution`)) > 0)) |

</details>

消费者文件（6）：
`src/modules/lithography/reference-document-case-detail.service.ts`, `src/modules/lithography/lithography.module.ts`, `src/modules/lithography/queries/reference-document.query.service.ts`, `src/modules/lithography/queries/reference-document.query.service.spec.ts`, `test/11-content-submission/content-submission-integration.e2e-spec.ts`, `test/12-reference-document-case/reference-document-case.e2e-spec.ts`

### 3.31 `reference_document`

- 定位：现有表；Entity [reference-document.entity.ts](../../src/modules/lithography/entities/reference-document.entity.ts)；创建迁移 [1775201500000-create-reference-document-table.migration.ts](../../src/infrastructure/database/migrations/1775201500000-create-reference-document-table.migration.ts)
- 说明：保存正式资料条目、公司及原始来源；目标设计关联本报告冻结版本，区分下架与软删除，并指向当前生效管理版本。无附件完整报告也可入库。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- 规模：现有字段 23；目标设计行 13；现有约束 20；直接消费者 15；测试 2

| 目标字段/约束                            | 目标类型                                                                   | 目标约束/用途                                                                                                                                                                                                                                                                                                                                                                                      | 现状                                        | 动作                       | 迁移方式                          | 消费者                                           | 测试                                                                              | 状态                        |
| ---------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------- | --------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------- |
| `publication_status`                     | varchar(16)                                                                | ONLINE/OFFLINE；删除另记；新增：下架不是删除来源                                                                                                                                                                                                                                                                                                                                                   | 不存在                                      | **新增**                   | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `ownership_status`                       | varchar(16)                                                                | CONFIRMED/PENDING；新增：未知归属仅1级核实                                                                                                                                                                                                                                                                                                                                                         | 不存在                                      | **新增**                   | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `owner_organization_id`                  | int                                                                        | 拟允许未知历史为空；CONFIRMED及新发布必须非空FK公司；调整：不为通过非空约束而猜测甲方归属                                                                                                                                                                                                                                                                                                          | int 非空                                    | **调整**                   | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `current_revision_no`                    | int unsigned                                                               | 非空，≥0；对应本条资料生效版本；下架、软删除、管理修订和归属更正推进生效版本；与reference_document_revision.revision_no同次一致，主表没有本次拟增revision_no同义字段                                                                                                                                                                                                                               | 不存在                                      | **新增**                   | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `deleted_at／deprecated`                 | timestamp(3)／boolean                                                      | 复用现有字段及一致性CHECK；同次更新；正常为deprecated=false且deleted_at为空；软删除同次设true及实际时间。与ONLINE/OFFLINE发布状态分开；普通列表、旧详情与资料下载统一排除                                                                                                                                                                                                                          | timestamp(3) 可空；boolean 非空；默认 false | **保留（复用现有）**       | 无 DDL 或仅补 CHECK/索引          | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `source_kind`                            | varchar(32)                                                                | 新建仅INDEPENDENT_REPORT／WORK_ORDER_SUMMARY；MATERIAL保留历史；两类新来源；不为兼容删除历史枚举或改写已接受迁移                                                                                                                                                                                                                                                                                   | 不存在                                      | **新增**                   | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `source_report_id`                       | int（与实际被引用主键类型一致）                                            | 新报告资料必填；与source_report_version_id共同校验同报告版本关系；历史普通资料可空；报告及公司、作者权限由提交用例核验；source_submission_id仅保留历史来源，不新建普通投稿                                                                                                                                                                                                                         | 不存在                                      | **新增**                   | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `source_report_version_id`               | int（与实际被引用主键类型一致）                                            | 新报告资料必填；同报告复合FK及发布唯一索引；永久保留原始冻结来源，不随管理修订替换；普通详情优先当前生效管理内容。该唯一索引不能单独代替报告提交状态和请求幂等。                                                                                                                                                                                                                                   | 不存在                                      | **新增**                   | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `ingest_method`                          | varchar(32)                                                                | 增加DIRECT_SUBMISSION，保留旧值历史；调整：新发布不使用REVIEWED_SUBMISSION冒充已审批                                                                                                                                                                                                                                                                                                               | varchar(32) 非空；默认 'ADMIN_DIRECT'       | **调整**                   | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `内容来源CHECK（逻辑约束，非新增字段）`  | 新增前向Migration调整既有CHECK                                             | 按source_kind分支校验；报告来源两个ID非空；历史来源保留原正文／文件条件；表达式必须明确真／假，不让NULL变成UNKNOWN放行；已确定方案二。INDEPENDENT_REPORT／WORK_ORDER_SUMMARY允许content_text和storage_reference均为空，但报告及版本关联必须有效；历史文字／文件分支仍要求content_text IS NOT NULL OR storage_reference IS NOT NULL。不新增正文复制要求，不放宽存储字段配对、软删除及其他独立约束。 | 现有约束/部署事实                           | **逻辑约束（非新增列）**   | 调整既有 CHECK/FK（不改 31 条）   | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `同报告版本关系（逻辑约束，非新增字段）` | 复合外键＋匹配列序的被引用键                                               | 采用reference_document(source_report_version_id,source_report_id)引用maintenance_report_version(id,report_id)，复用既有同序复合唯一键；不能把(id,report_id)当成(report_id,id)。若实施改用反序，须通过新增迁移补齐匹配键；新报告来源两列均非空，物理类型一致。在带旧数据库验证升级，不改写旧迁移。                                                                                                  | 现有约束/部署事实                           | **逻辑约束（非新增列）**   | 调整既有 CHECK/FK（不改 31 条）   | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `历史兼容与迁移（部署规则，非新增字段）` | 只新增Migration，不重写历史                                                | 新增关联列先兼容旧行；只回填有明确来源依据的数据；发布前保证新报告来源规则与唯一性成立；不猜测旧报告版本、不删旧资料；遇到非法关联或重复来源先报告并停止。迁移顺序覆盖被引用键、关联字段、唯一索引、外键和CHECK；升级前备份，明确MySQL DDL部分失败的检查及恢复步骤。                                                                                                                               | 现有约束/部署事实                           | **逻辑约束（非新增列）**   | 调整既有 CHECK/FK（不改 31 条）   | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `原始来源与公司（复用现有字段）`         | 复用 `source_submission_id`、`source_revision_id`、`created_by_account_id` | 来源类型对应关系互斥且完整，上传公司固定；工单管理修订不自动改资料快照                                                                                                                                                                                                                                                                                                                             | 现有三列                                    | **保留（复用，0 新增列）** | 无 DDL 或仅补 CHECK/索引          | `src/modules/lithography/lithography.module.ts`… | 2 个：`src/modules/lithography/queries/content-submission.query.service.spec.ts`… | S2 结构已实现（待实库验证） |

<details><summary>现有约束（Entity 声明，20 条）</summary>

| 类别     | 名称/字段                                     | 声明                                                                                                                                             |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 索引     | `idx_reference_document_model_type`           | （equipment_model_id, document_type）                                                                                                            |
| 索引     | `idx_reference_document_creator_created`      | （created_by_account_id, created_at）                                                                                                            |
| 索引     | `idx_reference_document_storage`              | （storage_backend, storage_reference）                                                                                                           |
| 索引     | `idx_reference_document_deprecated_created`   | （deprecated, created_at）                                                                                                                       |
| 唯一约束 | `uk_reference_document_source_submission`     | （source_submission_id）                                                                                                                         |
| 索引     | `idx_reference_document_source_revision`      | （source_revision_id, source_submission_id）                                                                                                     |
| 索引     | `idx_reference_document_org_deleted_created`  | （owner_organization_id, deleted_at, created_at）                                                                                                |
| 外键     | `fk_reference_document_equipment_model`       | （equipment_model_id）→ equipment_model（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                            |
| 外键     | `fk_reference_document_created_by_account`    | （created_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                       |
| 外键     | `fk_reference_document_owner_organization`    | （owner_organization_id）→ organization（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                            |
| 外键     | `fk_reference_document_source_submission`     | （source_submission_id）→ content_submission（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                       |
| 外键     | `fk_reference_document_source_revision`       | （source_revision_id, source_submission_id）→ content_submission_revision（id, submission_id）；ON DELETE RESTRICT；ON UPDATE RESTRICT           |
| 外键     | `fk_reference_document_updated_by_account`    | （updated_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                       |
| CHECK    | `chk_reference_document_deprecated`           | `deprecated` IN (0, 1)                                                                                                                           |
| CHECK    | `chk_reference_document_deletion_consistency` | ((`deprecated` = 0 AND `deleted_at` IS NULL) OR (`deprecated` = 1 AND `deleted_at` IS NOT NULL))                                                 |
| CHECK    | `chk_reference_document_storage_pair`         | ((`storage_backend` IS NULL AND `storage_reference` IS NULL) OR (`storage_backend` IS NOT NULL AND `storage_reference` IS NOT NULL))             |
| CHECK    | `chk_reference_document_content_source`       | (`content_text` IS NOT NULL OR `storage_reference` IS NOT NULL)                                                                                  |
| CHECK    | `chk_reference_document_ingest_method`        | `ingest_method` IN ('ADMIN_DIRECT', 'REVIEWED_SUBMISSION', 'SYSTEM_IMPORT')                                                                      |
| CHECK    | `chk_reference_document_source_pair`          | ((`source_submission_id` IS NULL AND `source_revision_id` IS NULL) OR (`source_submission_id` IS NOT NULL AND `source_revision_id` IS NOT NULL)) |
| CHECK    | `chk_reference_document_model_exclusive`      | (`equipment_model_id` IS NULL OR `equipment_model_text` IS NULL)                                                                                 |

</details>

消费者文件（15）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/reference-document.service.ts`, `src/modules/lithography/queries/content-submission.query.service.spec.ts`, `src/modules/lithography/queries/content-submission.query.service.ts`, `src/modules/lithography/queries/reference-document.query.service.ts`, `src/modules/lithography/queries/reference-document.query.service.spec.ts`, `test/11-content-submission/content-submission-integration.e2e-spec.ts`, `test/11-content-submission/content-submission-graphql.e2e-spec.ts`, `test/09-reference-document/reference-document.e2e-spec.ts`, `test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts`, `test/utils/e2e-scoped-cleanup.e2e-spec.ts`, `test/10-admin-document-database/admin-document-database-fixture.ts` …

### 3.32 `repair_request`

- 定位：现有表；Entity [repair-request.entity.ts](../../src/modules/lithography/entities/repair-request.entity.ts)；创建迁移 [1775201000000-create-repair-request-table.migration.ts](../../src/infrastructure/database/migrations/1775201000000-create-repair-request-table.migration.ts)
- 说明：保存可接单维修工单、接单人及维修处理事实；目标设计区分客户公司、服务公司和工单结束状态。
- 本期处理：调整，见下方目标字段；其余现有字段保留
- **D3 结单对齐（2026-11-09，第 42 条迁移）**：`chk_repair_request_closure` 统一为 CASE 形式：`closure_status` 与 `closed_at` 双 NULL 允许（明确历史未知），`OPEN` 必须 `closed_at IS NULL`，`CLOSED` 必须 `closed_at IS NOT NULL`；单边 NULL 与非法状态在迁移前扫描并失败关闭。Entity 已采用同一 CASE，第 42 条用单条 `ALTER TABLE ... DROP CHECK ... ADD CONSTRAINT` 替换。
- 规模：现有字段 19；目标设计行 8；现有约束 24；直接消费者 23；测试 4

| 目标字段/约束                                         | 目标类型                               | 目标约束/用途                                                                                        | 现状                                                  | 动作                               | 迁移方式                          | 消费者                                           | 测试                                                            | 状态                        |
| ----------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------- | --------------------------------- | ------------------------------------------------ | --------------------------------------------------------------- | --------------------------- |
| `intake_id`                                           | int                                    | 可空兼容旧数据；新工单非空UK、FK请求；新增：唯一报修来源                                             | 不存在                                                | **新增**                           | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/repair-request.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `customer_organization_id`                            | int                                    | 新工单必填FK公司；新增：客户公司                                                                     | 不存在                                                | **新增**                           | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/repair-request.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `service_organization_id`                             | int                                    | 新工单必填FK公司；新增：服务公司；旧owner有证据时映射，不猜测                                        | 不存在                                                | **新增**                           | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/repair-request.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `closure_status`                                      | varchar(16)                            | 新工单非空OPEN/CLOSED；新增：结束状态独立于维修结果                                                  | 不存在                                                | **新增**                           | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/repair-request.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `closed_at`                                           | timestamp(3)                           | OPEN为空，CLOSED必有；新增：结束事实时间                                                             | 不存在                                                | **新增**                           | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/repair-request.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `closure_reason`                                      | text                                   | 中断或无法修复时必填；新增：结束原因                                                                 | 不存在                                                | **新增**                           | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/repair-request.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `current_revision_no`                                 | int unsigned                           | 非空，≥0；新增：管理版本                                                                             | 不存在                                                | **新增**                           | ADD COLUMN（先可空/默认，后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/repair-request.service.spec.ts`… | S2 结构已实现（待实库验证） |
| `handling_result／handling_status／handling_ended_at` | varchar(32)／varchar(16)／timestamp(3) | 旧映射不能继续决定是否结束；调整：中断有原因也可结单，旧数据保留原语义；前向改 CHECK，不批量改写历史 | varchar(32) 可空；varchar(16) 可空；timestamp(3) 可空 | **调整（3 个既有列，扩展 CHECK）** | MODIFY/扩展 CHECK（先扩展后收紧） | `src/modules/lithography/lithography.module.ts`… | 4 个：`src/modules/lithography/repair-request.service.spec.ts`… | S2 结构已实现（待实库验证） |

<details><summary>现有约束（Entity 声明，24 条）</summary>

| 类别     | 名称/字段                                       | 声明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 唯一约束 | `uk_repair_request_no`                          | （request_no）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 索引     | `idx_repair_request_customer_created`           | （customer_account_id, created_at）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 索引     | `idx_repair_request_accepted_created`           | （is_accepted, created_at）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 索引     | `idx_repair_request_engineer`                   | （accepted_by_engineer_account_id）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 索引     | `idx_repair_request_equipment_model`            | （equipment_model_id）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 索引     | `idx_repair_request_created_at`                 | （created_at）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 唯一约束 | `uk_repair_request_id_owner`                    | （id, owner_organization_id）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 索引     | `idx_repair_request_owner_created`              | （owner_organization_id, created_at）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 索引     | `idx_repair_request_owner_status`               | （owner_organization_id, handling_status）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 索引     | `idx_repair_request_handling_recorder`          | （handling_recorded_by_account_id）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 外键     | `fk_repair_request_owner_organization`          | （owner_organization_id）→ organization（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 外键     | `fk_repair_request_handling_recorder`           | （handling_recorded_by_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 外键     | `fk_repair_request_customer_account`            | （customer_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 外键     | `fk_repair_request_equipment_model`             | （equipment_model_id）→ equipment_model（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 外键     | `fk_repair_request_engineer_account`            | （accepted_by_engineer_account_id）→ base_user_account（id）；ON DELETE RESTRICT；ON UPDATE RESTRICT                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CHECK    | `chk_repair_request_is_accepted`                | `is_accepted` IN (0, 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| CHECK    | `chk_repair_request_deprecated`                 | `deprecated` IN (0, 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| CHECK    | `chk_repair_request_acceptance_consistency`     | ((`is_accepted` = 0 AND `accepted_by_engineer_account_id` IS NULL AND `accepted_at` IS NULL) OR (`is_accepted` = 1 AND `accepted_by_engineer_account_id` IS NOT NULL AND `accepted_at` IS NOT NULL))                                                                                                                                                                                                                                                                                                                                      |
| CHECK    | `chk_repair_request_deletion_consistency`       | ((`deprecated` = 0 AND `deleted_at` IS NULL) OR (`deprecated` = 1 AND `deleted_at` IS NOT NULL AND `is_accepted` = 0))                                                                                                                                                                                                                                                                                                                                                                                                                    |
| CHECK    | `chk_repair_request_handling_result`            | `handling_result` IS NULL OR `handling_result` IN ('FIXED', 'PART_PURCHASED', 'PROVIDE_PLAN_SELF_EXECUTE', 'INTERRUPTED', 'UNREPAIRABLE')                                                                                                                                                                                                                                                                                                                                                                                                 |
| CHECK    | `chk_repair_request_handling_status`            | `handling_status` IS NULL OR `handling_status` IN ('COMPLETED', 'IN_PROGRESS', 'UNRESOLVED')                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| CHECK    | `chk_repair_request_handling_mapping`           | ((`handling_result` IS NULL AND `handling_status` IS NULL) OR (`handling_result` IS NOT NULL AND `handling_status` IS NOT NULL AND ((`handling_result` = 'FIXED' AND `handling_status` = 'COMPLETED') OR (`handling_result` = 'PART_PURCHASED' AND `handling_status` = 'COMPLETED') OR (`handling_result` = 'PROVIDE_PLAN_SELF_EXECUTE' AND `handling_status` = 'COMPLETED') OR (`handling_result` = 'INTERRUPTED' AND `handling_status` = 'IN_PROGRESS') OR (`handling_result` = 'UNREPAIRABLE' AND `handling_status` = 'UNRESOLVED')))) |
| CHECK    | `chk_repair_request_handling_requires_accepted` | `handling_result` IS NULL OR `is_accepted` = 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CHECK    | `chk_repair_request_handling_time`              | ((`handling_result` IS NULL AND `handling_status` IS NULL AND `handling_recorded_at` IS NULL AND `handling_ended_at` IS NULL) OR (`handling_result` IS NOT NULL AND `handling_status` IS NOT NULL AND `handling_recorded_at` IS NOT NULL AND ((`handling_status` = 'IN_PROGRESS' AND `handling_ended_at` IS NULL) OR (`handling_status` IN ('COMPLETED', 'UNRESOLVED') AND `handling_ended_at` IS NOT NULL))))                                                                                                                            |

</details>

消费者文件（23）：
`src/modules/lithography/lithography.module.ts`, `src/modules/lithography/repair-request.service.spec.ts`, `src/modules/lithography/repair-request.service.ts`, `src/modules/lithography/maintenance-report.service.ts`, `src/modules/lithography/queries/admin-repair-request.query.service.ts`, `src/modules/lithography/queries/admin-ai-conversation.query.service.ts`, `src/modules/lithography/queries/admin-ai-report.query.service.ts`, `src/modules/lithography/queries/repair-request.query.service.ts`, `src/modules/lithography/queries/repair-request.query.service.spec.ts`, `src/modules/lithography/queries/repair-request.organization.integration.spec.ts`, `src/modules/lithography/queries/admin-repair-request.query.service.spec.ts`, `test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts` …

### 3.33 `base_third_party_auth`

- 定位：现有表；Entity [third-party-auth.entity.ts](../../src/modules/third-party-auth/third-party-auth.entity.ts)；创建迁移 [1773926400000-create-base-third-party-auth-table.migration.ts](../../src/infrastructure/database/migrations/1773926400000-create-base-third-party-auth-table.migration.ts)
- 说明：保留已有账号与第三方平台的绑定；本期不因保留本表新增第三方登录需求。
- 本期处理：原有认证关联保留，本期不新增第三方登录要求。
- 规模：现有字段 8；目标设计行 0；现有约束 3；直接消费者 7；测试 0
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。

<details><summary>现有约束（Entity 声明，3 条）</summary>

| 类别     | 名称/字段                              | 声明                                      |
| -------- | -------------------------------------- | ----------------------------------------- |
| 唯一约束 | `base_third_party_auth_provider_IDX`   | （provider, provider_user_id）            |
| 唯一约束 | `base_third_party_auth_account_id_IDX` | （account_id, provider）                  |
| 枚举补充 | `provider`                             | enum（WEAPP／WECHAT／QQ／GOOGLE／GITHUB） |

</details>

消费者文件（7）：
`src/modules/third-party-auth/third-party-auth.module.ts`, `src/modules/third-party-auth/third-party-auth.entity.ts`, `src/modules/third-party-auth/queries/third-party-auth.query.service.ts`, `src/modules/third-party-auth/third-party-auth.service.ts`, `test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts`, `test/02-register/weapp-register-active.e2e-spec.ts`, `test/01-auth/auth.e2e-spec.ts`

### 3.34 `base_verification_record`

- 定位：现有表；Entity [verification-record.entity.ts](../../src/modules/verification-record/verification-record.entity.ts)；创建迁移 [1773927600000-create-base-verification-record-table.migration.ts](../../src/infrastructure/database/migrations/1773927600000-create-base-verification-record-table.migration.ts)
- 说明：保存既有一次性验证或可撤销动作的令牌指纹及状态；不代替工程师公司审核申请。
- 本期处理：复用必要验证能力，不把验证记录当工程师公司审批。
- 规模：现有字段 15；目标设计行 0；现有约束 7；直接消费者 8；测试 0
- 目标：**无字段/约束增改，按既有复用**；保留全部现有字段、索引、FK、CHECK 与生成列。
- 校准：源稿含 `token_fp`（`binary(32)`），旧解析按类型前缀漏计，已补入 15。

<details><summary>现有约束（Entity 声明，7 条）</summary>

| 类别     | 名称/字段             | 声明                                                                          |
| -------- | --------------------- | ----------------------------------------------------------------------------- |
| 唯一约束 | `uk_token_fp`         | （token_fp）                                                                  |
| 索引     | `idx_type_status_exp` | （type, status, expires_at）                                                  |
| 索引     | `idx_target`          | （target_account_id）                                                         |
| 索引     | `idx_subject`         | （subject_type, subject_id）                                                  |
| 枚举补充 | `type`                | enum（EMAIL_VERIFY_LINK／EMAIL_VERIFY_CODE／PASSWORD_RESET／SMS_VERIFY_CODE） |
| 枚举补充 | `status`              | enum（ACTIVE／CONSUMED／REVOKED／EXPIRED）                                    |
| 枚举补充 | `subject_type`        | enum（ACCOUNT）                                                               |

</details>

消费者文件（8）：
`src/modules/verification-record/repositories/verification-record.read.repo.ts`, `src/modules/verification-record/verification-record.module.ts`, `src/modules/verification-record/verification-record.entity.ts`, `src/modules/verification-record/verification-record.service.ts`, `src/modules/verification-record/queries/verification-record.query.service.ts`, `src/modules/verification-record/queries/verification-read.query.service.ts`, `test/07-pagination-sort-search/pagination.e2e-spec.ts`, `test/07-pagination-sort-search/search.e2e-spec.ts`

## 3. 17 个候选对象逐项落位

统一删除策略建议：**默认 RESTRICT**，仅纯 owned detail 在确认无历史价值后可 CASCADE；本轮不改变任何业务删除语义。所有候选表先建表、后由执行器写入；无旧消费者。

| #   | 候选表                        | 用途                                                                                                                     | 需求                                                                                   | 落位                     | 独立/并入建议          | 键与约束要点                                                                                                 |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | `repair_request_intake`       | 先保存客户原始报修和分析状态；当前有效分析成功后才关联唯一维修工单。                                                     | 新增。对应：R018—R021、R031—R032。                                                     | 云                       | **独立建表（待确认）** | 主键 id；repair_request.intake_id 唯一引用；created_by/deleted_by 账号 FK；组织/公司字段按 V5.3              |
| 2   | `intake_analysis_attempt`     | 逐次保存原报修的分析输出或失败原因，只允许初次0和唯一重试1，防止晚到结果覆盖当前尝试。                                   | 新增。对应：R031—R032。                                                                | 云                       | **独立建表（待确认）** | 主键 id；intake_id FK；失败尝试按次记录；不覆盖成功结果                                                      |
| 3   | `repair_process_entry`        | 保存接单工程师内部执行的排查、测试和原件引用，与面向客户的回复分开。                                                     | 新增。对应：R024、R027—R030。                                                          | 云                       | **独立建表（待确认）** | 主键 id；repair_request_id FK；过程条目 owned detail                                                         |
| 4   | `ai_message_analysis`         | 将一次AI分析与原问题、原会话及实际回答固定关联，并保存真实处理结果。                                                     | 新增。对应：R034—R039。                                                                | 云                       | **独立建表（待确认）** | 主键 id；message_id FK；一消息多分析结果；来源与版本过滤                                                     |
| 5   | `maintenance_report_fault`    | 保存报告内每次独立故障的八字段和阶段；初始、复位新故障及步骤新故障分别成行，可持续新增。                                 | 见 V5.3                                                                                | 云                       | **独立建表（待确认）** | 主键 id；report_id FK；新流程故障面板；旧 alarm 八槽位不迁移                                                 |
| 6   | `stored_file`                 | 统一保存业务原件的私有位置、完整性及上传归属；先暂存，业务保存时核验后绑定真实来源。                                     | 见 V5.3                                                                                | 云表 + 私有文件存储      | **独立建表（待确认）** | PK file_id char(36)；business_type/business_id 绑定前可空；upload_context_id 幂等；状态 STAGING/VALID/FAILED |
| 7   | `repair_request_revision`     | 保存有权工单修订的原因、操作者和前后版本，不覆盖客户原文或工程师原始提交事实。                                           | 见 V5.3                                                                                | 云                       | **独立建表（待确认）** | 主键 id；repair_request_id FK；before/after 快照 + schema_version；按修订号唯一                              |
| 8   | `reference_document_revision` | 保存内容、归属及状态修订的前后完整生效快照、操作者和原因；后续状态事件继承已有修订正文，原始冻结报告始终保留供授权追溯。 | 见 V5.3                                                                                | 云                       | **独立建表（待确认）** | 主键 id；document_id FK；UK(document_id, revision_no)；before/after 快照                                     |
| 9   | `local_account_authorization` | 保存本机已核验的离线账号资格及已知撤销事实，不把离线资格当作永久云端Token。                                              | 见 V5.3                                                                                | 本地                     | **独立建表（待确认）** | 主键 id；本地账号/设备公司；授权与撤销事实；仅本地库                                                         |
| 10  | `local_company_setting`       | 按设备和公司分别保存固定本地备份计划与自动云备份开关，多个公司互不覆盖。                                                 | 见 V5.3                                                                                | 本地                     | **独立建表（待确认）** | 主键 id；本地公司/设备；计划时间/启用；仅本地库                                                              |
| 11  | `sync_receipt`                | 保存统一记录某一版本被完整接收的结果；自动同步与U盘导入共用去重及回执。                                                  | 见 V5.3                                                                                | 云                       | **独立建表（待确认）** | 主键 id；installation/company/entity 稳定身份；幂等键唯一；回执状态                                          |
| 12  | `sync_conflict`               | 保存同一记录本地与云端的冲突快照及明确选择，不新增绕过冻结状态的内容修改权。                                             | 见 V5.3                                                                                | 云                       | **独立建表（待确认）** | 主键 id；receipt/entity 引用；local/cloud 快照；冲突状态                                                     |
| 13  | `record_package_import`       | 保存U盘记录包的检查和实际导入状态，检查合格不等于已写入成功。                                                            | 见 V5.3                                                                                | 云                       | **独立建表（待确认）** | 主键 id；包标识/校验和/导入状态；逐条结果父表                                                                |
| 14  | `record_package_item`         | 保存记录包中每条业务的检查、写入、跳过、冲突或失败结果，并关联统一接收回执。                                             | 见 V5.3                                                                                | 云                       | **独立建表（待确认）** | 主键 id；import_id FK；记录类型/local_id/结果；owned detail                                                  |
| 15  | `backup_asset`                | 记录真实备份包及其本地和云端副本的可用状态、完整回执和清理事实；本地清理后条目及云引用仍保留。                           | 见 V5.3                                                                                | 云登记 + 本地/云副本状态 | **独立建表（待确认）** | 主键 id；backup_run/company；本地与云副本状态分离；资产不伪造上传                                            |
| 16  | `backup_restore_run`          | 保存备份恢复的预检、目标范围、当前业务保护副本、明确确认和实际执行结果。                                                 | 见 V5.3                                                                                | 本地                     | **独立建表（待确认）** | 主键 id；company/run；check_snapshot；本地执行历史                                                           |
| 17  | `management_audit_event`      | 仅记录管理员删除正式资料、更正上传者与公司归属、备份恢复本机业务三类操作；1级全公司、2级仅本公司只读查询。               | 拟新增业务记录；依据R089、R092。仅三类管理操作，复用对应业务实际结果，非独立审计平台。 | 云                       | **独立建表（待确认）** | 主键 id；actor_account_id/actor_level_snapshot；target_type/target_id；仅三类操作                            |

### 3.1 候选字段明细

#### 4.1 `repair_request_intake`

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：新增。对应：R018—R021、R031—R032。

| 字段                       | 类型         | 约束                       | 用途                                                                                  | 迁移方式     | 消费者                | 测试            | 状态                        |
| -------------------------- | ------------ | -------------------------- | ------------------------------------------------------------------------------------- | ------------ | --------------------- | --------------- | --------------------------- |
| `id`                       | int          | 自增PK                     | 报修请求ID                                                                            | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `record_uuid`              | char(36)     | 非空UK                     | 跨端稳定编号                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `customer_account_id`      | int          | 非空FK账号                 | 报修客户                                                                              | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `customer_organization_id` | int          | 非空FK公司；后端取本人资料 | 报修时从当前客户base_user_info.customer_organization_id读取并保存，不以请求自报值为准 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `service_organization_id`  | int          | 非空FK公司                 | 选定维修公司                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `equipment_model_id`       | int          | 非空FK机型                 | 预置机型                                                                              | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `error_code`               | varchar(100) | 非空                       | 保留0和前导零                                                                         | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `fault_description`        | longtext     | 非空，≤5000字              | 客户原始故障                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `file_id`                  | char(36)     | 可空FK原件                 | 报修私有原件                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `analysis_status`          | varchar(16)  | 非空                       | WAITING/RUNNING/SUCCEEDED/FAILED                                                      | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `analysis_generation`      | int unsigned | 非空，默认0；仅0或1        | 初次=0，唯一手动重试=1；锁定后原子推进，不因失败或刷新重置                            | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `converted_request_id`     | int          | 可空UK、FK工单             | 最多转一工单                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `deleted_at`               | timestamp(3) | 可空                       | 逻辑删除事实                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `created_at`               | timestamp(3) | 非空                       | 系统创建时间                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.2 `intake_analysis_attempt`

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：新增。对应：R031—R032。

| 字段               | 类型         | 约束                                    | 用途                                                               | 迁移方式     | 消费者                | 测试            | 状态                        |
| ------------------ | ------------ | --------------------------------------- | ------------------------------------------------------------------ | ------------ | --------------------- | --------------- | --------------------------- |
| `id`               | bigint       | 自增PK                                  | 分析尝试                                                           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `intake_id`        | int          | 非空FK请求                              | 原报修                                                             | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `generation_no`    | int unsigned | 仅0或1；联合UK(intake_id,generation_no) | 0为初次，1为唯一重试；同一报修不生成第三次分析记录                 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `status`           | varchar(16)  | 非空；RUNNING／SUCCEEDED／FAILED        | 本次尝试有效终态；超时按FAILED保留原因，晚到结果不将已结束尝试翻转 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `output_text`      | longtext     | 可空，原始保存                          | 真实模型输出                                                       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `failure_reason`   | text         | 可空，失败必有                          | 实际失败原因                                                       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `provider_call_id` | int          | 可空，按现有调用表映射                  | 模型追溯引用                                                       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `started_at`       | timestamp(3) | 可空                                    | 实际开始                                                           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `finished_at`      | timestamp(3) | 可空                                    | 实际结束                                                           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.3 `repair_process_entry`

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：新增。对应：R024、R027—R030。

| 字段                | 类型         | 约束               | 用途               | 迁移方式     | 消费者                | 测试            | 状态                        |
| ------------------- | ------------ | ------------------ | ------------------ | ------------ | --------------------- | --------------- | --------------------------- |
| `id`                | bigint       | 自增PK             | 过程ID             | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `entry_uuid`        | char(36)     | 非空UK             | 稳定记录编号       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `request_id`        | int          | 非空FK工单         | 所属工单           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `author_account_id` | int          | 非空FK账号         | 实际记录人         | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `operation_text`    | longtext     | 非空               | 人工执行操作       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `test_result`       | longtext     | 可空               | 实际测试事实       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `occurred_at`       | datetime     | 可空，业务现场时间 | 人工记录的事件时间 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `time_source`       | varchar(32)  | 非空               | 人工或系统时间来源 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `file_id`           | char(36)     | 可空FK原件         | 内部私有原件       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `version_no`        | int unsigned | 非空，递增         | 过程修改版本       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `created_at`        | timestamp(3) | 非空               | 系统保存时间       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.4 `ai_message_analysis`

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：新增。对应：R034—R039。

| 字段                  | 类型         | 约束           | 用途                    | 迁移方式     | 消费者                | 测试            | 状态                        |
| --------------------- | ------------ | -------------- | ----------------------- | ------------ | --------------------- | --------------- | --------------------------- |
| `question_uuid`       | char(36)     | PK             | 问题请求稳定标识        | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `conversation_id`     | int          | 非空FK会话     | 固定会话                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `question_message_id` | int          | 非空UK、FK消息 | 原问题                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `answer_message_id`   | int          | 可空FK消息     | 实际回答                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `status`              | varchar(16)  | 非空           | 待处理/执行中/成功/失败 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `failure_reason`      | text         | 可空           | 真实失败原因            | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `content_version`     | int unsigned | 非空           | 已保存内容版本          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `saved_at`            | timestamp(3) | 非空           | 持久保存事件时间        | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `completed_at`        | timestamp(3) | 可空           | 实际完成时间            | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.5 `maintenance_report_fault`

> **P0 修正（2026-11-09）**：本节“结构已实现”只指 DDL/Entity 已创建。经 F1 审计：原始八字段与 `phase_code` 未落列；`status/source` 与面板原始字段同名异义，原始数据与处理生命周期混行；`panel_snapshot` 无 JSON 校验与版本；`(report_id, step_code)` 唯一缺失。判定见 [S5 审计](./S5-pre-merge-blocker-audit-20261109.md)。

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3

| 字段          | 类型         | 约束                         | 用途                       | 迁移方式     | 消费者                | 测试            | 状态                        |
| ------------- | ------------ | ---------------------------- | -------------------------- | ------------ | --------------------- | --------------- | --------------------------- |
| `id`          | bigint       | 自增PK                       | 故障对象                   | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `report_id`   | int          | 非空FK报告                   | 所属报告                   | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `fault_uuid`  | char(36)     | 非空UK                       | 故障稳定编号               | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `branch_kind` | varchar(24)  | 非空                         | INITIAL/RESET_NEW/STEP_NEW | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `step_code`   | varchar(64)  | 可空，与报告内步骤关联       | 步骤新故障来源             | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `is_active`   | boolean      | 非空                         | 当前正式有效分支           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `main_error`  | varchar(300) | 可空                         | Main Error                 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `unit_error`  | varchar(300) | 可空                         | Unit Error                 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `source`      | varchar(300) | 可空                         | Source                     | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `error_type`  | varchar(300) | 可空                         | Error Type                 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `gpib_status` | varchar(300) | 可空                         | GPIB Status                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `description` | longtext     | 草稿可空，正式≤10000字且必填 | Description                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `action`      | longtext     | 可空，≤10000字               | Action                     | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `status`      | varchar(300) | 可空                         | 原始故障Status文字         | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `phase_code`  | varchar(32)  | 草稿可空，正式十选一必填     | 所属流程阶段               | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.6 `stored_file`

- 落位：云表 + 私有文件存储；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3

| 字段                     | 类型            | 约束                                                 | 用途                                                                                   | 迁移方式     | 消费者                | 测试            | 状态                        |
| ------------------------ | --------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------ | --------------------- | --------------- | --------------------------- |
| `file_id`                | char(36)        | PK                                                   | 稳定原件编号                                                                           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `uploaded_by_account_id` | int             | 非空FK账号                                           | 实际上传者                                                                             | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `owner_organization_id`  | int             | 非空FK公司                                           | 可信文件归属                                                                           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `storage_reference`      | varchar(1024)   | 非空，非公开直链                                     | 私有存储引用                                                                           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `original_filename`      | varchar(255)    | 非空                                                 | 原文件名                                                                               | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `mime_type`              | varchar(255)    | 非空，内容校验                                       | 实际类型                                                                               | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `byte_size`              | bigint unsigned | 0<值≤20000000                                        | 精确字节上限                                                                           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `checksum_sha256`        | char(64)        | 非空                                                 | 文件校验摘要                                                                           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `status`                 | varchar(16)     | 非空；STAGING／VALID／FAILED                         | 文件上传及校验状态；VALID只表示完整有效，不等于已绑定业务                              | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `business_type`          | varchar(32)     | 非空                                                 | 业务引用类型                                                                           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `business_id`            | varchar(64)     | 暂存可空；BOUND时非空且须实际资源                    | 首次业务保存时填写真实来源ID；不能把预留标识冒充已存在的业务ID                         | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `upload_context_id`      | char(36)        | 新上传非空，服务端生成；与上传者、公司和用途联合核验 | 本次新建用途的上传上下文；返回给页面供首次提交和未保存表单导出校验，单凭该值不授权     | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `binding_status`         | varchar(16)     | 非空；TEMPORARY／BOUND；与business_id一致            | TEMPORARY时无正式业务关联；BOUND时真实业务ID及有效关联必有，绑定后不能被另一新业务认领 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `created_at`             | timestamp(3)    | 非空                                                 | 保存时间                                                                               | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `verified_at`            | timestamp(3)    | 可空，VALID必有                                      | 完整校验时间                                                                           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.7 `repair_request_revision`

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3

| 字段               | 类型         | 约束                                                   | 用途                    | 迁移方式                       | 消费者                | 测试                               | 状态                                                                 |
| ------------------ | ------------ | ------------------------------------------------------ | ----------------------- | ------------------------------ | --------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `id`               | bigint       | 自增PK                                                 | 管理修订                | CREATE TABLE                   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e                    | S2 结构已实现（待实库验证）                                          |
| `request_id`       | int          | 非空FK工单                                             | 目标工单                | CREATE TABLE                   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e                    | S2 结构已实现（待实库验证）                                          |
| `revision_no`      | int unsigned | 联合UK(request_id,revision_no)                         | 新版本                  | CREATE TABLE                   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e                    | S2 结构已实现（待实库验证）                                          |
| `previous_version` | int unsigned | 可空；`NULL`=历史未知，`0`=首版；CHECK `< revision_no` | 比较/基于的上一生效版本 | 第 43 条追加迁移（ADD COLUMN） | 后续执行器 + 清理入口 | S2 定向 SQL/e2e + 第 43 条实库用例 | 第 43 条结构已实现（待实库验证）；与冻结 Word 的“非空”存在兼容性差异 |
| `actor_account_id` | int          | 非空FK账号                                             | 实际操作者              | CREATE TABLE                   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e                    | S2 结构已实现（待实库验证）                                          |
| `reason`           | text         | 非空                                                   | 修订原因                | CREATE TABLE                   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e                    | S2 结构已实现（待实库验证）                                          |
| `before_snapshot`  | json         | 非空，有schema_version                                 | 修改前事实              | CREATE TABLE                   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e                    | S2 结构已实现（待实库验证）                                          |
| `after_snapshot`   | json         | 非空，有schema_version                                 | 修改后事实              | CREATE TABLE                   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e                    | S2 结构已实现（待实库验证）                                          |
| `schema_version`   | int unsigned | 非空                                                   | 快照格式版本            | CREATE TABLE                   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e                    | S2 结构已实现（待实库验证）                                          |
| `created_at`       | timestamp(3) | 非空                                                   | 修订时间                | CREATE TABLE                   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e                    | S2 结构已实现（待实库验证）                                          |

> **`previous_version` 设计差异（第 43 条，2026-11-09）**：冻结 Word 将该列定义为“非空、比较的上一版本”。由于第 43 条之前的历史行无法证明其比较版本，实际落为 `int unsigned NULL`，不回填、不设置默认版本。语义：`NULL` = 历史未知；`0` = 基于原始版本的首次管理修订；其他值 = 写入时锁定并核验过的 `current_revision_no`。CHECK `previous_version IS NULL OR previous_version < revision_no` 只做 NULL 安全的顺序守卫，不把“修订号连续”写成结构假设。未来 R029/R030 写入方必须填写 `previous_version`；本轮不实现该接口。该差异是兼容旧数据的明确设计调整，不宣称冻结 Word 原样落地。

#### 4.8 `reference_document_revision`

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3

| 字段               | 类型         | 约束                                                             | 用途                                                                                                                                                                  | 迁移方式     | 消费者                | 测试            | 状态                        |
| ------------------ | ------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------- | --------------- | --------------------------- |
| `id`               | bigint       | 自增PK                                                           | 资料管理修订                                                                                                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `document_id`      | int          | 非空FK资料                                                       | 正式条目                                                                                                                                                              | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `revision_no`      | int unsigned | 联合UK(document_id,revision_no)；同次对应根表current_revision_no | 保存管理修订、归属更正、下架及软删除生效版本；不覆盖报告原始冻结版本                                                                                                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `actor_account_id` | int          | 非空FK账号；执行前核验具体动作权限                               | 实际操作者；1级管理动作及原作者合法删除按各自资格，不靠外键自动授权                                                                                                   | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `reason`           | text         | 非空；归属或内容修订填写核实／修改原因                           | 状态变更记录其下架、删除等真实事件原因，不因此给原作者删除新增必填输入项                                                                                              | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `before_snapshot`  | json         | 非空，有格式版本；对应操作前生效快照                             | 保留原始来源引用及当时完整内容、归属和状态，支持有权追溯；不覆盖原始冻结版本                                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `after_snapshot`   | json         | 非空，有格式版本；当前修订完整生效快照，而非仅零散改动           | 内容修订合并允许修改字段；仅归属或状态事件继承上个生效正文，初次从原始来源初始化。普通详情按根表current_revision_no读取，不能因最后一次事件不是内容修订而显示旧内容。 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `created_at`       | timestamp(3) | 非空                                                             | 修改时间                                                                                                                                                              | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.9 `local_account_authorization`

> **P0 修正（2026-11-09）**：经 F1 审计，`signed_claims`、`permission_version`、`last_verified_at` 均不存在；现有 `authorization_status/authorized_at` 是撤销事实，不能单独充当离线资格。判定见 [S5 审计](./S5-pre-merge-blocker-audit-20261109.md)。

- 落位：本地；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3

| 字段                 | 类型         | 约束             | 用途             | 迁移方式     | 消费者                | 测试            | 状态                        |
| -------------------- | ------------ | ---------------- | ---------------- | ------------ | --------------------- | --------------- | --------------------------- |
| `id`                 | bigint       | 自增PK           | 本机离线资格记录 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `installation_id`    | char(36)     | 非空             | 稳定设备编号     | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `account_id`         | int          | 非空FK账号       | 原获批账号       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `organization_id`    | int          | 非空FK公司       | 账号可信公司     | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `signed_claims`      | json         | 非空，受保护存储 | 核验过的身份声明 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `permission_version` | int unsigned | 非空             | 资格版本         | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `last_verified_at`   | timestamp(3) | 非空             | 最近联网核验     | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `revoked_at`         | timestamp(3) | 可空             | 已知撤销事实     | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.10 `local_company_setting`

> **P0 修正（2026-11-09）**：经 F1 审计，`initialization_at`、`backup_interval_hours`、`backup_enabled`、`next_backup_at`、`last_auto_success_at`、`last_auto_failure_at`、`failure_reason`、`auto_upload_enabled` 均不存在；现有 `setting_source/is_current` 为设计外列。判定见 [S5 审计](./S5-pre-merge-blocker-audit-20261109.md)。

- 落位：本地；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3

| 字段                    | 类型              | 约束                                    | 用途               | 迁移方式     | 消费者                | 测试            | 状态                        |
| ----------------------- | ----------------- | --------------------------------------- | ------------------ | ------------ | --------------------- | --------------- | --------------------------- |
| `id`                    | bigint            | 自增PK                                  | 设备公司设置       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `installation_id`       | char(36)          | 联合UK(installation_id,organization_id) | 来源设备           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `organization_id`       | int               | 非空FK公司                              | 独立公司数据区     | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `initialized_at`        | timestamp(3)      | 非空                                    | 首次初始化         | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `backup_interval_hours` | smallint unsigned | 非空，固定默认72                        | 约三天周期         | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `backup_enabled`        | boolean           | 非空，默认true                          | 固定本地自动计划   | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `next_backup_at`        | timestamp(3)      | 非空                                    | 下次到期           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `last_auto_success_at`  | timestamp(3)      | 可空                                    | 最近自动成功       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `last_auto_failure_at`  | timestamp(3)      | 可空                                    | 最近失败           | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `failure_reason`        | text              | 可空                                    | 实际失败原因       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `auto_upload_enabled`   | boolean           | 非空，默认false                         | 仅备份自动上云开关 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.11 `sync_receipt`

> **P0 修正（2026-11-09）**：经 F1 审计，唯一键含 `source_system`，同一版本可被本地/云端各记一行，违背“共用去重”；且缺 `source_installation_id`、`remote_resource_id`、`received_at`。判定见 [S5 审计](./S5-pre-merge-blocker-audit-20261109.md)。

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3

| 字段                     | 类型         | 约束                                    | 用途                     | 迁移方式     | 消费者                | 测试            | 状态                        |
| ------------------------ | ------------ | --------------------------------------- | ------------------------ | ------------ | --------------------- | --------------- | --------------------------- |
| `id`                     | bigint       | 自增PK                                  | 接收回执                 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `record_uuid`            | char(36)     | 与company、resource_type、version联合UK | 稳定业务编号             | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `organization_id`        | int          | 非空FK公司                              | 资源归属                 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `resource_type`          | varchar(32)  | 非空                                    | 业务类型                 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `version_no`             | int unsigned | 非空                                    | 本次业务版本             | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `source_installation_id` | char(36)     | 非空                                    | 来源设备                 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `manifest_checksum`      | char(64)     | 非空                                    | 正文与原件清单摘要       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `status`                 | varchar(16)  | 非空                                    | PARTIAL/SUCCEEDED/FAILED | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `remote_resource_id`     | varchar(64)  | 可空                                    | 云端实际标识             | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `received_at`            | timestamp(3) | 可空                                    | 完整接收时间             | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.12 `sync_conflict`

> **P0 修正（2026-11-09）**：本审计未连库，`data_version` 是独立列还是 JSON 内版本尚未核实；快照的版本域拒绝也无读写方证明。判定见 [S5 审计](./S5-pre-merge-blocker-audit-20261109.md)。
>
> **D3 结构对齐（2026-11-09，第 42 条迁移）**：实现主键为 `conflict_id char(36)`，承担设计 `id` 的稳定身份，不重复新增自增列；既有 `version_no` 是旧冲突版本号，无法证明属于本地或云端，保留但不映射。补齐 `local_version`、`cloud_version`、`displayed_cloud_version`、`decision` 四列；旧行无法证明的版本/选择保持 NULL（明确历史未知），新写入由应用层成对提供 `local_version`/`cloud_version` 并默认 `decision=PENDING`。

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3

| 字段                      | 类型         | 约束                                   | 用途                          | 迁移方式     | 消费者                | 测试            | 状态                        |
| ------------------------- | ------------ | -------------------------------------- | ----------------------------- | ------------ | --------------------- | --------------- | --------------------------- |
| `conflict_id`             | char(36)     | 主键                                   | 冲突编号（等价设计 id）       | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `record_uuid`             | char(36)     | 非空                                   | 统一记录编号                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `organization_id`         | int          | 非空FK公司                             | 归属                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `resource_type`           | varchar(32)  | 非空                                   | 资源类型                      | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `version_no`              | int unsigned | 非空                                   | 旧冲突版本号，不映射本地/云端 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | 第42条保留（历史兼容）      |
| `local_version`           | int unsigned | 可空；旧行NULL历史未知；新写入成对必填 | 本地版本                      | 第42条迁移   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | 第42条已实现（待实库验证）  |
| `cloud_version`           | int unsigned | 可空；旧行NULL历史未知；新写入成对必填 | 检测云版本                    | 第42条迁移   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | 第42条已实现（待实库验证）  |
| `local_snapshot`          | json         | 非空，格式版本明确                     | 保留的本地内容                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `cloud_snapshot`          | json         | 非空，格式版本明确                     | 保留的云端内容                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `displayed_cloud_version` | int unsigned | 可空；旧行NULL历史未知                 | 用户已展示版本                | 第42条迁移   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | 第42条已实现（待实库验证）  |
| `decision`                | varchar(24)  | 可空，默认PENDING；旧行NULL历史未知    | 待处理/本地/云端              | 第42条迁移   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | 第42条已实现（待实库验证）  |
| `confirmed_by_account_id` | int          | 可空FK账号                             | 实际确认人                    | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `confirmed_at`            | timestamp(3) | 可空                                   | 明确选择时间                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.13 `record_package_import`

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3；检查结论（R071）与导入阶段（R072—R073）分别表达。
- 等价命名：设计稿 `package_uuid` → 实现 `package_id`（同为稳定包编号，并作为主键与重试身份）；
  `actor_account_id` → `imported_by_account_id`（检查/导入操作者）；`manifest` → `manifest_json`；
  `import_status` → `status`（仅表示导入阶段）。设计稿 `format_version` 未新增独立列，
  版本以 `manifest_json` 内 `schema_version` 为单一来源。

| 字段                     | 类型         | 约束                                           | 用途                           | 迁移方式                | 消费者                | 测试                     | 状态                        |
| ------------------------ | ------------ | ---------------------------------------------- | ------------------------------ | ----------------------- | --------------------- | ------------------------ | --------------------------- |
| `package_id`             | char(36)     | 主键；稳定包编号                               | 包身份；同包重试必须复用该值   | CREATE TABLE            | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `organization_id`        | int          | 非空FK公司                                     | 包归属                         | CREATE TABLE            | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `imported_by_account_id` | int          | 非空FK账号                                     | 检查/导入操作者                | CREATE TABLE            | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `manifest_json`          | longtext     | 非空；合法 JSON 且 `schema_version` 存在非null | 包清单与格式版本               | 第38/39条迁移重建 CHECK | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | 已完成实库验证（第 39 条）  |
| `manifest_checksum`      | char(64)     | 非空；长度64                                   | 本次包版本身份                 | CREATE TABLE            | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `status`                 | varchar(16)  | 非空；PENDING/RUNNING/SUCCEEDED/PARTIAL/FAILED | 导入阶段（不表示检查结论）     | CREATE TABLE            | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `check_status`           | varchar(16)  | 可空；NULL/PENDING/PASSED/REJECTED             | 检查结论；不得据此表示导入成功 | 第39条迁移 ADD COLUMN   | 后续执行器 + 清理入口 | S2 §2.5 + 纯替身迁移规格 | 已完成实库验证（第 39 条）  |
| `item_total`             | int unsigned | 非空，默认0                                    | 清点总条数                     | CREATE TABLE            | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `item_succeeded`         | int unsigned | 非空，默认0；与失败数之和不超总数              | 成功条数                       | CREATE TABLE            | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `item_failed`            | int unsigned | 非空，默认0                                    | 失败条数                       | CREATE TABLE            | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `created_at`             | timestamp(3) | 非空，默认当前时间                             | 处理创建时间                   | CREATE TABLE            | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `completed_at`           | timestamp(3) | 可空                                           | 完成时间                       | CREATE TABLE            | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |

组合约束（第 39 条，数据库可证部分）：`RUNNING/SUCCEEDED/PARTIAL` 要求 `check_status=PASSED`；
`REJECTED` 只允许 `status=PENDING`；`check_status=PENDING` 只允许 `status=PENDING`；
历史 `check_status=NULL` 只允许 `PENDING/FAILED`。

#### 4.14 `record_package_item`

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3；逐条检查结果（R071）与逐条导入结果（R072）分别表达。
- 等价命名：设计稿 `import_result` → 实现 `result`；`failure_reason` → `error_message`；
  `package_id` 引用父表稳定编号（char(36)），而非父表自增ID。
- 唯一规则：`uk_record_package_item_scope(package_id, record_uuid, resource_type, version_no)`
  负责同包内同条重复识别；同包重试必须命中原 `package_id`，不得生成新编号绕过。

| 字段            | 类型         | 约束                                                | 用途                                              | 迁移方式                      | 消费者                | 测试                     | 状态                        |
| --------------- | ------------ | --------------------------------------------------- | ------------------------------------------------- | ----------------------------- | --------------------- | ------------------------ | --------------------------- |
| `id`            | bigint       | 自增PK                                              | 逐条记录                                          | CREATE TABLE                  | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `package_id`    | char(36)     | 非空FK `record_package_import.package_id`           | 所属包                                            | CREATE TABLE                  | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `record_uuid`   | char(36)     | 非空；与 package_id/resource_type/version_no 联合UK | 业务稳定编号                                      | CREATE TABLE                  | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `resource_type` | varchar(32)  | 非空                                                | 资源类型                                          | CREATE TABLE                  | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `version_no`    | int unsigned | 非空                                                | 业务版本                                          | CREATE TABLE                  | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `check_result`  | varchar(16)  | 可空；NULL/PASSED/REJECTED                          | 逐条检查结论；NULL 表示未完成或历史未判定         | 第39条迁移 ADD COLUMN         | 后续执行器 + 清理入口 | S2 §2.5 + 纯替身迁移规格 | 已完成实库验证（第 39 条）  |
| `result`        | varchar(16)  | 可空；NULL/SUCCEEDED/FAILED/SKIPPED/CONFLICT        | NULL 未执行；四类导入结果；SUCCEEDED 要求检查通过 | 第39条迁移 MODIFY + 重建CHECK | 后续执行器 + 清理入口 | S2 §2.5 + 纯替身迁移规格 | 已完成实库验证（第 39 条）  |
| `receipt_id`    | char(36)     | 可空FK `sync_receipt.receipt_id`                    | 同步回执                                          | CREATE TABLE                  | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `error_message` | text         | 可空；FAILED 时必填非空白                           | 实际失败原因                                      | CREATE TABLE                  | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |
| `created_at`    | timestamp(3) | 非空，默认当前时间                                  | 创建时间                                          | CREATE TABLE                  | 后续执行器 + 清理入口 | S2 定向 SQL/e2e          | S2 结构已实现（待实库验证） |

组合约束（第 39 条，数据库可证部分）：`check_result=REJECTED` 只允许 `result=NULL`；
`result=SUCCEEDED` 要求 `check_result=PASSED`。历史 `check_result=NULL` 且
`result=FAILED/SKIPPED` 保留（无法证明，不猜测回填）。

#### 4.15 `backup_asset`

> **P0 修正（2026-11-09）**：经 F1 审计，缺 `installation_id`、`format_version`、`data_version`、本地引用（现仅 `storage_reference` 覆盖云端）、`encryption_key_id`、`verified_at`、`retention_until`、`failure_reason`、`deleted_at`、`local_cleanup_error`。判定见 [S5 审计](./S5-pre-merge-blocker-audit-20261109.md)。

- 落位：云登记 + 本地/云副本状态；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3

| 字段                   | 类型            | 约束                             | 用途                                                                                        | 迁移方式     | 消费者                | 测试            | 状态                        |
| ---------------------- | --------------- | -------------------------------- | ------------------------------------------------------------------------------------------- | ------------ | --------------------- | --------------- | --------------------------- |
| `backup_id`            | char(36)        | PK                               | 稳定包编号                                                                                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `run_id`               | int             | 非空FK local_backup_run          | 生成任务                                                                                    | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `installation_id`      | char(36)        | 非空                             | 包来源设备                                                                                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `organization_id`      | int             | 非空FK公司                       | 包所属公司                                                                                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `format_version`       | int unsigned    | 非空                             | 包格式版本                                                                                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `data_version`         | varchar(64)     | 非空                             | 数据结构版本                                                                                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `byte_size`            | bigint unsigned | 非空                             | 实际包大小                                                                                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `manifest_checksum`    | char(64)        | 非空                             | 包与原件完整摘要                                                                            | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `local_reference`      | varchar(1024)   | 可空                             | 受保护本地引用                                                                              | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `cloud_reference`      | varchar(1024)   | 可空                             | 受保护云端引用                                                                              | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `local_status`         | varchar(16)     | 非空；与本地引用及清理结果一致   | 本地可用／清理中／已清理／失败；与cloud_status独立，清本地后仍保留条目                      | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `cloud_status`         | varchar(16)     | 非空                             | 备份云副本真实状态                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `cloud_receipt`        | text            | 可空；确认云成功时必有可核对回执 | 技术候选：绑定backup_id、公司、设备、内容摘要及云完整性结果；完整校验后才允许R074清理本地包 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `encryption_key_id`    | varchar(128)    | 非空，只引用不存明文密钥         | 受控恢复密钥                                                                                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `verified_at`          | timestamp(3)    | 可空                             | 可用校验时间                                                                                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `retention_until`      | timestamp(3)    | 可空                             | 成功本地包约30天期限；不用于删除云副本，手动流程可在确认云端成功后提前清本地                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `failure_reason`       | text            | 可空                             | 上传或介质实际失败                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `attempt_count`        | int unsigned    | 非空，≥0                         | 云传尝试次数                                                                                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `deleted_at`           | timestamp(3)    | 可空，仅本地包清理事实           | 不表示删除云副本或整个backup_asset条目                                                      | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `local_cleanup_run_id` | int             | 可空FK local_backup_run          | 技术候选：记录哪次手动流程清理本包，过期清理则保留相应原因，不混入通用审计                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `local_cleanup_error`  | text            | 可空；仅必要错误，不含凭据       | 技术候选：云成功与本地清理失败分开保存，失败保留可追踪目标                                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.16 `backup_restore_run`

> **P0 修正（2026-11-09）**：经 F1 审计，缺 `target_installation_id`、`check_status`、`confirmation`；`protection_backup_id` 为 NOT NULL，与“执行前必有保护备份”的预检阶段冲突。判定见 [S5 审计](./S5-pre-merge-blocker-audit-20261109.md)。

- 落位：本地；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：见 V5.3

| 字段                     | 类型         | 约束                     | 用途                    | 迁移方式     | 消费者                | 测试            | 状态                        |
| ------------------------ | ------------ | ------------------------ | ----------------------- | ------------ | --------------------- | --------------- | --------------------------- |
| `restore_id`             | char(36)     | PK                       | 恢复处理编号            | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `backup_id`              | char(36)     | 非空FK备份               | 选定包                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `target_installation_id` | char(36)     | 非空                     | 恢复目标设备            | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `target_organization_id` | int          | 非空FK公司               | 目标公司                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `actor_account_id`       | int          | 非空FK账号               | 管理员                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `check_status`           | varchar(16)  | 非空                     | 兼容完整性和范围结论    | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `check_snapshot`         | json         | 非空，绑定包摘要目标版本 | 预检依据                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `protection_backup_id`   | char(36)     | 可空FK备份，执行前必有   | 当前业务保护包          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `confirmation`           | json         | 可空，执行前必有         | 影响范围和明确确认      | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `status`                 | varchar(16)  | 非空                     | 待执行/执行中/成功/失败 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `failure_reason`         | text         | 可空                     | 实际失败                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `started_at`             | timestamp(3) | 可空                     | 执行开始                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `finished_at`            | timestamp(3) | 可空                     | 实际结束                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

#### 4.17 `management_audit_event`

- 落位：云；建表建议：独立建表（待用户确认）；删除策略：默认 RESTRICT。
- 需求：拟新增业务记录；依据R089、R092。仅三类管理操作，复用对应业务实际结果，非独立审计平台。
- **D3 结构对齐（2026-11-09，第 42 条迁移）**：实现字段名与设计稿等价映射为 `event_id`←`id`、`actor_admin_level`←`actor_level_snapshot`、`target_type`←`resource_type`、`target_id`←`resource_id`、`detail`←`reason`、`created_at`←`occurred_at`；`before_version`/`after_version` 未实现，不重复加列。第 42 条只收紧 `operation` CHECK 为三类已确认操作；旧审计类型不自动映射，存在时迁移失败关闭。

| 字段                | 类型         | 约束                                                                        | 用途                                                                                  | 迁移方式     | 消费者                | 测试            | 状态                        |
| ------------------- | ------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------ | --------------------- | --------------- | --------------------------- |
| `event_id`          | char(36)     | 主键（等价设计 id）                                                         | 操作记录                                                                              | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `actor_account_id`  | int          | 非空FK账号                                                                  | 实际发起三类管理操作的管理员；平台代写不等于自动任务无操作者                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `actor_admin_level` | tinyint      | 非空，仅1或2                                                                | 实际操作时等级；查询权限仍读取当前可信身份，不信任前端                                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `organization_id`   | int          | 可空FK目标公司；未知归属记录仅1级可查                                       | 有可信公司时保存实际目标公司；2级仅organization_id=本人可信公司，不因NULL获得全局记录 | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `operation`         | varchar(32)  | 仅ADMIN_DELETE_DOCUMENT／CORRECT_DOCUMENT_OWNERSHIP／RESTORE_LOCAL_BUSINESS | 管理员删除正式资料、更正上传者与公司、恢复本机业务                                    | 第42条收紧   | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | 第42条已实现（待实库验证）  |
| `target_type`       | varchar(32)  | 非空                                                                        | 目标类型（等价设计 resource_type）                                                    | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `target_id`         | varchar(64)  | 非空                                                                        | 目标编号（等价设计 resource_id）                                                      | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `result`            | varchar(16)  | 非空                                                                        | 阶段真实结果                                                                          | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `detail`            | text         | 可空，仅必要说明；归属更正采用业务必填原因                                  | 不记录正文、包内容、密码或Token，不扩大通用审计范围（等价设计 reason）                | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |
| `created_at`        | timestamp(3) | 非空                                                                        | 实际操作时间（等价设计 occurred_at）                                                  | CREATE TABLE | 后续执行器 + 清理入口 | S2 定向 SQL/e2e | S2 结构已实现（待实库验证） |

## 4. 生成列、JSON 格式版本与特殊约束

### 4.1 生成列（现有 4 条，不新增）

| 表                                  | 生成列                   | 规则                                                                                                   |
| ----------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `engineer_registration_application` | `pending_account_id`     | 可空；生成列 STORED：IF(`status` = 'PENDING', `account_id`, NULL)；禁止INSERT写入；禁止UPDATE写入      |
| `local_backup_run`                  | `active_installation_id` | 可空；生成列 STORED：IF(`status` = 'RUNNING', `installation_id`, NULL)；禁止INSERT写入；禁止UPDATE写入 |
| `maintenance_report_attachment`     | `active_sort_order`      | 可空；生成列 STORED：IF(`status` = 'CURRENT', `sort_order`, NULL)；禁止INSERT写入；禁止UPDATE写入      |
| `organization_membership`           | `active_account_id`      | 可空；生成列 STORED：IF(`status` = 'ACTIVE', `account_id`, NULL)；禁止INSERT写入；禁止UPDATE写入       |

### 4.2 JSON/快照格式版本

| 表                               | 字段                             | 格式版本事实                                | 本期建议                                              |
| -------------------------------- | -------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| `content_submission_revision`    | `payload_snapshot`               | 有 `schema_version`                         | 沿用                                                  |
| `fault_case_submission_detail`   | `extension_json`                 | 有 `schema_version`                         | 沿用                                                  |
| `material_submission_detail`     | `extension_json`                 | 有 `schema_version`                         | 沿用                                                  |
| `maintenance_report_version`     | `payload_snapshot`               | 有 `schema_version`                         | 沿用                                                  |
| `reference_document_case_detail` | `case_payload_json`              | 有 `schema_version`                         | 沿用                                                  |
| `reference_document`             | `extension_json`                 | 有 `schema_version`                         | 沿用                                                  |
| `repair_request_revision`        | `before_snapshot/after_snapshot` | 原稿含 `schema_version` 列，JSON 内亦须同值 | 新增；读写两侧校验                                    |
| `reference_document_revision`    | `before_snapshot/after_snapshot` | 设计只要求“有格式版本”，**无显式列**        | JSON 内 `schema_version`；不新增独立列（OI-02 裁决）  |
| `sync_conflict`                  | `local_snapshot/cloud_snapshot`  | 需包格式版本                                | JSON 内 `schema_version`；旧无版本按旧格式读（OI-02） |
| `backup_restore_run`             | `check_snapshot`                 | 需核对/格式版本                             | JSON 内 `schema_version`；旧无版本按旧格式读（OI-02） |

## 5. 覆盖结论

- 34/34 现有表已列；17/17 候选对象已列；**71/71 现有表目标设计行**与 **196/196 候选字段**已列，共 **267 行目标设计**。
- 逻辑/关系/部署规则 5 行单独标注，不计列；组合字段 7 行注明含多列，不误算为独立新增列。
- 现有表新增物理列 **47**，候选字段 **196**，目标新增列合计 **243**；既有列调整引用 **29**。
- 未发现“91 项 = 91 列”的机械映射；需求到对象的映射见 [S1-requirement-mapping.md](S1-requirement-mapping.md)。

## 6. 源稿 267 行逐行对照与差异解释

### 6.1 计数口径

| 口径               | 数量    | 来源                                 |
| ------------------ | ------- | ------------------------------------ |
| 源稿现有字段行     | 442     | 34 表结构化逐行（`现有字段` 四元组） |
| 源稿现有表目标行   | 71      | 13 个含目标字段块的现有表            |
| 源稿候选字段       | 196     | 17 个候选表目标字段块                |
| 源稿目标设计行合计 | **267** | 71 + 196                             |
| 旧 S1 现有表目标行 | 59      | 按“类型列首词”解析，漏 12 行         |
| 旧 S1 合计         | 255     | 59 + 196                             |
| 差异               | **12**  | 见 6.2                               |

### 6.2 旧解析漏计的 12 行

| #   | 表                        | 源行                                                         | 类型列特征                          | 行性质           | 物理列   |
| --- | ------------------------- | ------------------------------------------------------------ | ----------------------------------- | ---------------- | -------- |
| 1   | `ai_conversation`         | `status／ai_feedback／completed_at`                          | “兼容已有字段及历史CHECK”           | 组合·既有列调整  | 3 列引用 |
| 2   | `engineer_response`       | `resolution_status`                                          | “现有enum”                          | 单列既有调整     | 1 列引用 |
| 3   | `local_backup_run`        | `manual_upload_status／manual_cleanup_status`                | “分别varchar(16)”                   | 组合·新增        | 2 新列   |
| 4   | `local_backup_run`        | `运行唯一约束`                                               | “设备+公司+RUNNING条件唯一”         | 约束（非列）     | 0        |
| 5   | `local_installation`      | `organization_id／auto_upload_enabled／backup_interval_days` | “旧单行配置保留历史兼容”            | 组合·历史保留    | 0 新列   |
| 6   | `maintenance_report_step` | `新故障关联`                                                 | “由 maintenance_report_fault 引用…” | 关联规则（非列） | 0        |
| 7   | `maintenance_report`      | `actual_cause／repair_actions／verification_result`          | “分别text／longtext／text”          | 组合·新增        | 3 新列   |
| 8   | `reference_document`      | `内容来源CHECK`                                              | “新增前向Migration调整既有CHECK”    | 逻辑约束（非列） | 0        |
| 9   | `reference_document`      | `同报告版本关系`                                             | “复合外键＋匹配列序列”              | 逻辑约束（非列） | 0        |
| 10  | `reference_document`      | `历史兼容与迁移`                                             | “只新增Migration，不重写历史”       | 部署规则（非列） | 0        |
| 11  | `reference_document`      | `原始来源与公司`                                             | “复用 source_submission_id…”        | 复用（非列）     | 0        |
| 12  | `repair_request`          | `handling_result／handling_status／handling_ended_at`        | “保留旧字段并前向改CHECK”           | 组合·既有列调整  | 3 列引用 |

结论：12 行中 **7 行为字段行**（新增 2 行共 5 列、调整/保留 5 行共 12 个既有列引用），**5 行为约束/关系/部署规则**；旧解析因“类型列不是以 SQL 类型开头”而整体漏掉，不是源稿重复。

### 6.3 现有字段 439 → 442 的差异

| 表                         | 漏计字段                                            | 源类型       | 原因                  |
| -------------------------- | --------------------------------------------------- | ------------ | --------------------- |
| `ai_workflow_context`      | `workflow_dedup_hash`、`workflow_dedup_active_hash` | `binary(32)` | 类型正则未含 `binary` |
| `base_verification_record` | `token_fp`                                          | `binary(32)` | 同上                  |

三行均为真实字段，已在 §3.4、§3.34 补记；**不是源稿遗漏，也不是 442 统计虚增**。

### 6.4 修正后的物理列口径

| 口径                 | 数量    | 计算                                                                                                         |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| 现有表单列新增行     | 42      | 每行 1 列                                                                                                    |
| 现有表组合新增行     | 2       | `manual_upload_status／manual_cleanup_status`（2）+ `actual_cause／repair_actions／verification_result`（3） |
| 现有表新增物理列     | **47**  | 42 + 5                                                                                                       |
| 现有表既有列调整引用 | **29**  | 16 单列 + 13 组合引用                                                                                        |
| 候选表字段           | 196     | 17 表目标字段                                                                                                |
| 目标新增列合计       | **243** | 47 + 196                                                                                                     |
| 逻辑/关系/部署规则   | 5       | 不计列                                                                                                       |
| 复用行               | 1       | 不计列                                                                                                       |

**238 为旧口径，已作废**；源稿逐行复核后按 **243 估算**（47 现有表 + 196 候选，17 候选按独立表实施）。候选归并或技术字段变化时更新逐项清单并重算，不为凑数字修改设计。
