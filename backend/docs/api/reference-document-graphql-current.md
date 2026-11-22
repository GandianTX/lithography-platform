<!-- docs/api/reference-document-graphql-current.md -->

Purpose: Snapshot the current GraphQL contract for the reference-document capability after 任务 07 (R052/R053/R058–R061): library read side, revision history, author delete, and the four level-1 admin management mutations, plus the audit events this capability writes for 任务 10.
Read when: You change `src/adapters/api/graphql/reference-document/`, the reference-document usecases, the read-scope resolution, the revision write service, or the reference-document audit events.
Do not read when: You only change the REST download boundary (`docs/api/reference-document-rest-current.md`), the admin Document Database aggregation (`docs/api/admin-document-database-graphql-current.md`), or content-submission publishing (`docs/api/content-submission-graphql-current.md`).
Source of truth: `src/adapters/api/graphql/reference-document/`、`src/usecases/reference-document/`、`src/modules/lithography/queries/reference-document.query.service.ts`、`src/modules/lithography/reference-document-revision.service.ts` 为可执行真源；本文只记录已实现并被定向测试覆盖的稳定契约。
Global error contract: 遵循 `docs/api/graphql-error-contract-current.md`；本文相关映射见末尾错误表。

# Reference Document GraphQL Contract（任务 07 读写口径）

## 定位

- **读侧统一**：列表 / 详情 / 历史版本 / 原件下载共用同一服务端可见谓词（未软删 + `ONLINE` + 归属 `CONFIRMED` + 服务端可信组织范围）；未知归属、下架、软删与跨范围在四个入口统一 `NOT_FOUND`，不泄露存在性。
- **写侧拆分**：原作者删除（R053）与一级管理员的管理修订 / 下架 / 管理删除 / 归属更正（R058–R061）是互不复用的五个入口，各自独立确认、原因必填、版本条件更新。旧普通新增（`createReferenceDocument`）、通用编辑（`updateReferenceDocument`）与 REST multipart 上传已按确认需求下线，历史资料照常授权读取。
- **版本即令牌**：`expected_version` 对接 `reference_document.current_revision_no`，该列默认 `0`（无管理修订，正文仍是原始冻结报告/原始正文），因此**首次管理操作的合法令牌是 0**；协议层与用例层只拒绝负数与非整数，账号 ID/组织 ID 等下界仍为 1。
- **不物理删除**：删除是软件层逻辑删除，来源工单、报告、历史与有效原件保留；下架只写业务历史（不写关键操作记录）。

## 权限矩阵

| 通道                                                                                                                          | SUPER_ADMIN（一级） | SUPER_ADMIN（二级） | ENGINEER           | CUSTOMER    | 匿名              |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------- | ------------------ | ----------- | ----------------- |
| `referenceDocuments` / `referenceDocument` / `referenceDocumentRevisions`                                                     | 全范围读            | 仅本公司读          | 仅本公司读         | `FORBIDDEN` | `UNAUTHENTICATED` |
| `reviseReferenceDocument` / `offlineReferenceDocument` / `adminDeleteReferenceDocument` / `correctReferenceDocumentOwnership` | 允许                | `FORBIDDEN`         | `FORBIDDEN`        | `FORBIDDEN` | `UNAUTHENTICATED` |
| `updateReferenceDocumentCase`（A-PR0 §S6 既有能力）                                                                           | 允许                | `FORBIDDEN`         | `FORBIDDEN`        | `FORBIDDEN` | `UNAUTHENTICATED` |
| `softDeleteReferenceDocument`（R053 原作者删除）                                                                              | 允许（仅本人条目）  | 允许（仅本人条目）  | 允许（仅本人条目） | `FORBIDDEN` | `UNAUTHENTICATED` |

授权双层：守卫层 `@Roles(...)` 粗准入；精确授权由 usecase 首行决定——读侧按账号当前 `admin_level` 事实 + 可信组织成员关系解析范围（缺等级/缺成员按本公司失败收紧，不放大为全范围），管理写侧要求 `activeRole === SUPER_ADMIN` 且账号当前 `admin_level = 1`（失败关闭，不沿用「SUPER_ADMIN 本组织即可写」的旧口径）。

## Operations

| 类型     | 操作                                | 入参                                                         | 返回                                        | 说明                                                                                   |
| -------- | ----------------------------------- | ------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Query    | `referenceDocuments`                | `pagination!`, `filter?`                                     | `ReferenceDocumentPaginatedDTO`             | 普通资料库列表；标题模糊 + 类型/型号/案例处理状态等值筛选，OFFSET 分页返回真实 `total` |
| Query    | `referenceDocument`                 | `id: Int!`                                                   | `ReferenceDocumentDetailDTO`                | 元数据 + 生效正文 + 来源 + 冻结报告（报告来源恒返回，授权追溯）+ 案例明细              |
| Query    | `referenceDocumentRevisions`        | `id: Int!`                                                   | `ReferenceDocumentRevisionsDTO`             | 生效修订摘要 + 各修订版本生效正文（不含完整快照 JSON）+ 原始冻结版本标识               |
| Mutation | `reviseReferenceDocument`           | `id: Int!`, `input: ReviseReferenceDocumentInput!`           | `ReferenceDocumentManagedMutationResultDTO` | R058 管理修订：标题/说明/正文                                                          |
| Mutation | `offlineReferenceDocument`          | `id: Int!`, `input: OfflineReferenceDocumentInput!`          | `ReferenceDocumentManagedMutationResultDTO` | R059 下架（`OFFLINE`）                                                                 |
| Mutation | `adminDeleteReferenceDocument`      | `id: Int!`, `input: AdminDeleteReferenceDocumentInput!`      | `ReferenceDocumentManagedMutationResultDTO` | R060 管理删除（软删 + 关键审计）                                                       |
| Mutation | `correctReferenceDocumentOwnership` | `id: Int!`, `input: CorrectReferenceDocumentOwnershipInput!` | `ReferenceDocumentManagedMutationResultDTO` | R061-02 归属更正（上传者/上传时公司）                                                  |
| Mutation | `updateReferenceDocumentCase`       | `id: Int!`, `input: UpdateReferenceDocumentCaseInput!`       | `ReferenceDocumentCaseMutationResultDTO`    | 既有案例专属更正（不属 R058 范围）                                                     |
| Mutation | `softDeleteReferenceDocument`       | `id: Int!`, `expectedVersion: Int!`                          | `ReferenceDocumentMutationResultDTO`        | R053 原作者删除本人正式资料                                                            |

已下线（保留历史数据读取，写入口不再存在；直达调用按未定义字段失败）：`createReferenceDocument`、`updateReferenceDocument`。

## 读侧语义

- **生效正文来源** `contentSource`：`CURRENT_REVISION`（`effectiveRevisionNo > 0`，读当前修订快照正文）> `FROZEN_REPORT`（报告来源且无管理修订，读原始冻结版本）> `ORIGINAL`（资料自身正文）。
- **授权追溯（V5.6 R055-02/R056-02/R058-01）**：报告来源资料的 `frozenReport` 恒返回原始冻结版本结构化内容，不随管理修订替换或消失；修订后 `contentSource = CURRENT_REVISION` 的生效正文与 `frozenReport` 并存，正文区域展示修订后内容、冻结报告作为追溯视图展示。修订历史 `revisions[].contentText` 返回该修订版本生效正文（after 快照内容键），授权用户可查看旧管理修订版本的具体内容；完整 before/after 快照 JSON 不外发。
- **生效版本** `effectiveRevisionNo` = `current_revision_no`；历史版本以 `revisions`（管理修订）与 `sourceReportVersionId`（原始冻结版本）分别表达，版本与原件对应关系不被下架/归属更正破坏。
- **列表口径**：`deprecated = false AND publication_status = 'ONLINE' AND ownership_status = 'CONFIRMED'`，再叠加 `ownerOrganizationId`（本公司）或无组织条件（一级全范围）；排序固定为创建时间倒序 + 主键倒序，不采纳客户端排序。
- **作者身份**：详情以布尔 `viewerIsOriginalAuthor` 表达，不返回账号 ID；它只决定前端作者删除入口显隐，授权仍由服务端裁决。
- **失败关闭**：报告来源但冻结版本行缺失属数据定式破坏，返回 `NOT_FOUND`，不输出残缺正文。

## 写侧语义（版本 + 状态 + 原子性）

| 操作             | 资源状态前提                      | 版本                                     | 同事务写入                                                                  | 关键审计                                                             |
| ---------------- | --------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| R058 管理修订    | `ONLINE` + `CONFIRMED` + 未软删   | `expected_version = current_revision_no` | 修订行（前后快照）+ 条件推进 `current_revision_no + 1` 并应用标题/说明/正文 | 不写                                                                 |
| R059 下架        | 同上                              | 同上                                     | 修订行（快照继承当时生效正文）+ 置 `OFFLINE`                                | 不写（只留业务历史）                                                 |
| R060 管理删除    | 未软删（下架资料仍可删）          | 同上                                     | 修订行 + `deprecated/deleted_at/OFFLINE` 同语句                             | `ADMIN_DELETE_DOCUMENT`                                              |
| R061-02 归属更正 | 未软删（含下架/待核实）           | 同上                                     | 修订行 + 仅显式提交字段；两项同时更正才置 `CONFIRMED`                       | `CORRECT_DOCUMENT_OWNERSHIP`（含字段级 from/to）                     |
| R053 原作者删除  | `AUTHOR` 范围（本人条目）+ 未软删 | 同上                                     | 修订行 + `deprecated/deleted_at/OFFLINE`                                    | 仅当操作人 `activeRole = SUPER_ADMIN` 时补写 `ADMIN_DELETE_DOCUMENT` |

- **条件更新兜底**：调用方先在事务内 `SELECT ... FOR UPDATE` 锁定资料行并核对版本；`ReferenceDocumentRevisionService.advanceCurrentRevision` 再以 `id + current_revision_no = expected + deprecated = false` 为 WHERE 条件原子推进。未命中即 `VERSION_CONFLICT`，修订行随事务回滚，无半写。
- **状态/归属修订不回退正文**：after 快照携带「当时生效正文」，后续 `CURRENT_REVISION` 读取不会退回原始冻结报告。
- **正文保护**：`FAULT_CASE` 正文不得经 R058 修改（必须走案例更正接口）；清空正文仅在资料已有存储引用时放行，双空拒绝。
- **作者删除与管理删除分离**：作者入口按 `createdByAccountId = 会话账号` 收敛（不按组织推断），跨作者/不存在/已软删统一 `NOT_FOUND`。

## 任务 10 交接：本能力写入的关键操作审计

写入表 `management_audit_event`（`ManagementAuditService.appendDocumentEvent`），与业务变更同事务；插入失败整体回滚，不返回成功。`detail` 只含原因与字段级标量摘要，不含正文、快照或存储引用。

| 字段                        | 取值                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `event_id`                  | UUID v4                                                                                                                                         |
| `actor_account_id`          | 实际操作人账号 ID（管理修订等业务字段的 `updated_by_account_id` 同值，不冒充作者）                                                              |
| `actor_admin_level`         | 操作时的管理员等级事实（管理动作恒为 1；R053 取操作人当前事实，缺失则失败关闭）                                                                 |
| `organization_id`           | 目标资料当时归属公司（归属待核实时可为 `NULL`；R061 取更正后公司，未更正取原公司）                                                              |
| `operation`                 | `ADMIN_DELETE_DOCUMENT`（R060、管理员以原作者身份 R053）/ `CORRECT_DOCUMENT_OWNERSHIP`（R061-02）                                               |
| `target_type` / `target_id` | `REFERENCE_DOCUMENT` / 资料 ID 字符串                                                                                                           |
| `result`                    | 恒为 `SUCCEEDED`（失败不落行，失败事实由错误契约表达）                                                                                          |
| `detail`                    | `{ reason, changes? }`；`changes` 形如 `{ createdByAccountId: { from, to }, ownerOrganizationId: { from, to }, ownershipStatus: { from, to } }` |
| `created_at`                | 数据库时间戳（毫秒精度）                                                                                                                        |

不写入本表的情形（不得由任务 10 当作关键操作）：R058 普通修订、R059 下架、R053 普通工程师作者删除（仅保留资料修订业务历史 `reference_document_revision`）。

## 错误映射（对外大类）

| error_code                                | 大类                    | 场景                                                                                                       |
| ----------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `REFERENCE_DOCUMENT_INVALID_PARAMS`       | `BAD_USER_INPUT`        | 入参非法（含 `expected_version` 负数/非整数、原因为空、补丁为空、归属更正未提交字段、目标账号/公司不存在） |
| `REFERENCE_DOCUMENT_NOT_FOUND`            | `NOT_FOUND`             | 不存在 / 下架 / 未确认归属 / 已软删 / 跨范围 / 作者删除非本人条目                                          |
| `REFERENCE_DOCUMENT_VERSION_CONFLICT`     | `CONFLICT`              | `expected_version` 与当前 `current_revision_no` 不一致，或条件推进未命中                                   |
| `REFERENCE_DOCUMENT_CONTENT_SOURCE_EMPTY` | `BAD_USER_INPUT`        | 正文清空但资料无存储引用（双空）                                                                           |
| `REFERENCE_DOCUMENT_FILE_NOT_AVAILABLE`   | `NOT_FOUND`             | 下载：无存储引用或存储对象缺失（不泄露路径）                                                               |
| `REFERENCE_DOCUMENT_UPDATE_FAILED`        | `INTERNAL_SERVER_ERROR` | 修订行写入/推进失败（不返回成功，不泄露数据库细节）                                                        |

## 待联调（不在本契约内虚构）

- 任务 05 新版 AI 会话/报告读侧已于 2026-11-21 合入 fork main（PR #23，`eb5525c`），本工作区已引入；管理员文档数据库 AI 会话标签由其真实读侧承载。仍待真实数据联调的是任务 06 维修报告录入与冻结版本产生（本契约的 `frozenReport`/`sourceReportVersionId` 读取链路依赖其冻结快照）、任务 09 同步回执与记录包入口。
- 任务 06 维修报告录入与冻结版本产生未合入：本契约的 `frozenReport` / 授权追溯读取依赖任务 06 的冻结快照，真实数据联调待其合入后进行。
- 任务 06 数据库字段修正（未合入，等待其最终迁移）：当前已知为 `maintenance_report_attachment` 追加可空 `file_id`（`char(36)`）+ 索引 `idx_maintenance_report_attachment_file` + 指向 `stored_file.file_id` 的 `RESTRICT` 外键。本契约的读侧（列表/详情/生效版本/下载）只读 `reference_document` 与其修订行，不 JOIN 该列，故不因该迁移改变行为；但 R057-01 要求的「版本原件关联 + `stored_file`」下载链路对**报告来源资料**（`sourceKind = INDEPENDENT_REPORT` / `WORK_ORDER_SUMMARY`）需要该列，届时须与任务 06 的附件契约一起同步本契约与前端下载入口。迁移合入前不写临时兼容逻辑、不猜字段、不用旧结构绕过。
