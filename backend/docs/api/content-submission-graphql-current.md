<!-- backend/docs/api/content-submission-graphql-current.md -->

Purpose: Snapshot the current GraphQL contract of the content-submission (投稿) capability — 9 submission operations plus the reference-document case-correction mutation consumed by the same frontend delivery (A-PR0 §4.1, S7).
Read when: You change the content-submission resolver, DTOs, filter input, draft/submit/review usecases, the `updateReferenceDocumentCase` mutation, or their frontend consumers under `frontend/src/features/content-submission/` and `frontend/src/features/reference-document/`.
Do not read when: You only change the REST attachment endpoints (`docs/api/content-submission-rest-current.md`), the admin Document Database read-only aggregation, or the reference-document upload/download REST contract (`docs/api/reference-document-rest-current.md`).
Source of truth: `src/adapters/api/graphql/content-submission/`、`src/usecases/content-submission/`、`src/adapters/api/graphql/reference-document/`（仅 `updateReferenceDocumentCase`）为可执行真源；前端逐字镜像见 `frontend/src/features/content-submission/infrastructure/content-submission-adapter.ts`。本文只记录已被 S3-S7 测试与真机样例（`test/11-content-submission/frontend-response-samples.e2e-spec.ts`）覆盖的稳定契约。
Global error contract: 遵循 `docs/api/graphql-error-contract-current.md`；本文相关映射见末尾错误表。

# Content Submission GraphQL Contract（投稿域 + 案例更正）

## 定位

- **协议层只做映射**：结构校验（DTO）→ 调用 usecase → 输出 DTO；业务异常交由全局过滤器映射为 GraphQL 错误契约。
- **服务端裁定铁律**：客户端不传创建人 / 组织 / 审核状态 / 版本号；组织与归属一律由 usecase 从可信事实（组织成员关系 + 精确 `activeRole`）裁定。客户端自报的所有者/状态字段不存在于任何入参。
- **存在性防探测**：不存在 / 他人投稿 / 跨组织统一 `NOT_FOUND`（同组织其他工程师的投稿与私有附件也不是公开数据）；审核链路与本人链路入口分离，不因共用内部服务变成「知道 ID 即可读取」。
- **排序由契约固定**：列表不采纳客户端 `sorts`；排序白名单在服务端写死（见「分页与排序契约」）。

## 权限矩阵

| 操作 | ENGINEER | SUPER_ADMIN | CUSTOMER | 匿名 |
| --- | --- | --- | --- | --- |
| `myContentSubmissions` / `myContentSubmission` / `createContentSubmissionDraft` / `updateContentSubmissionDraft` / `submitContentSubmission` | 允许（本组织本人记录；usecase 精确裁决） | 不自动继承此写入口（守卫放行后 usecase 按 `activeRole` 拒绝） | `FORBIDDEN` | `UNAUTHENTICATED` |
| `contentSubmissionRevision` | 允许（本人） | 允许（本组织） | `FORBIDDEN` | `UNAUTHENTICATED` |
| `reviewContentSubmissions` / `reviewContentSubmission` / `reviewContentSubmissionDecision` | `FORBIDDEN` | 允许（本组织） | `FORBIDDEN` | `UNAUTHENTICATED` |
| `updateReferenceDocumentCase` | `FORBIDDEN` | 允许（本组织；仅 FAULT_CASE 资料） | `FORBIDDEN` | `UNAUTHENTICATED` |

授权双层：守卫层 `@Roles(...)` 按账号 `accessGroup` 交集粗准入；精确授权（`activeRole` 与资源归属，失败关闭）由每个 usecase 在事务内裁决；停用/降级账号的旧 Token 由每请求复核兜底。已认证但组织成员事实缺失/歧义 → `FORBIDDEN`（`ORGANIZATION_NO_ACTIVE_MEMBERSHIP` / `ORGANIZATION_AMBIGUOUS_MEMBERSHIP`，不得误判为会话失效）。

## Operations

| # | 操作 | 类型 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | `myContentSubmissions` | Query | `pagination!`, `filter?` | `ContentSubmissionPaginatedDTO` | 本人投稿列表（仅本人记录）；更新时间倒序；仅 OFFSET |
| 2 | `myContentSubmission` | Query | `id: Int!` | `ContentSubmissionMineDetailDTO` | 本人详情：当前稿、状态、最近审核、版本入口、已发布正式资料关联 |
| 3 | `contentSubmissionRevision` | Query | `submissionId: Int!`, `revisionNo: Int!` | `ContentSubmissionRevisionDTO` | 冻结版本（本人或本组织管理员）；非授权范围统一 NOT_FOUND |
| 4 | `reviewContentSubmissions` | Query | `pagination!`, `filter?` | `ContentSubmissionPaginatedDTO` | 审核队列（本组织管理员）；`status` 缺省待审；送审时间倒序 |
| 5 | `reviewContentSubmission` | Query | `id: Int!` | `ContentSubmissionReviewDetailDTO` | 审核详情：当前版本完整视图 + 全部历史审核 + 投稿人账号 ID |
| 6 | `createContentSubmissionDraft` | Mutation | `input: CreateContentSubmissionDraftInput!` | `ContentSubmissionDraftMutationResultDTO` | 建草稿；创建人/组织服务端确定；真实保存状态回读 |
| 7 | `updateContentSubmissionDraft` | Mutation | `id: Int!`, `input: UpdateContentSubmissionDraftInput!` | `ContentSubmissionDraftMutationResultDTO` | 改草稿（仅本人 DRAFT/RETURNED）；类别不变；PATCH 语义 |
| 8 | `submitContentSubmission` | Mutation | `id: Int!`, `input: SubmitContentSubmissionInput!` | `ContentSubmissionSubmitResultDTO` | 送审/重提：从已保存稿冻结新版本；返回 revisionId/revisionNo/状态 |
| 9 | `reviewContentSubmissionDecision` | Mutation | `input: ReviewContentSubmissionDecisionInput!` | `ContentSubmissionReviewDecisionResultDTO` | 审核决定：RETURN 退回 / APPROVE 通过（协议层单入口，usecase 层分派） |
| 10 | `updateReferenceDocumentCase` | Mutation | `id: Int!`, `input: UpdateReferenceDocumentCaseInput!` | `ReferenceDocumentCaseMutationResultDTO { id, updatedAt }` | 正式案例更正（参考资料域，S6 交付；本 PR 前端适配消费） |

> 实现与计划 §4.1 的命名对照：计划默认名 `reviewContentSubmissionDecision(input)` 已按此名落地（**非**两个独立 mutation）；`returnContentSubmission` / `approveContentSubmission` 是 usecase 层拆分，不对协议层暴露。其余命名与计划一致，无并存别名。

## 输入结构（细节）

`ContentSubmissionFilterInput`（本人列表与审核队列共用，均可选；空白 `title` 视为未提供）：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `title` | String ≤255 | 标题 **LIKE 模糊** |
| `submissionKind` | String ≤32 | `MATERIAL` / `FAULT_CASE` 等值（值域 usecase 校验） |
| `status` | String ≤32 | `DRAFT`/`PENDING_REVIEW`/`RETURNED`/`PUBLISHED` 等值；本人列表缺省全部，审核队列缺省 `PENDING_REVIEW` |

`ContentSubmissionEditablePatchInput`（草稿补丁，14 业务字段 + 1 扩展位）：

- 语义：字段缺省=保持原值（创建时视为未提供）；显式 `null`=清空（草稿期全部可空）；不属于目标类别的字段出现非空值即被拒（`null`/缺省视为未提供）。
- 字段与上限：`title`≤255、`documentType`≤100、`equipmentModelId`≥1、`equipmentModelText`≤100、`description`≤2000、`contentText`≤200000、`errorCode`≤100（保留大小写与内部符号）、`phenomenon`≤2000、`conditionText`≤2000、`reproductionSteps`≤10000、`diagnosis`≤10000、`actionTaken`≤10000、`handlingStatus`≤32、`resolution`≤2000；`extension`（JSON）为 schema_version=1 扩展位，**v1 未定义任何键，传任何键即被拒**。
- `CreateContentSubmissionDraftInput { kind!, fields! }`：保存草稿只要求一个非空文字业务字段（只有默认状态或本地选文件不算已填写）；类型跨类别字段拒收。
- `UpdateContentSubmissionDraftInput { patch! }`：空补丁被拒；仅本人 DRAFT/RETURNED 可改（PENDING_REVIEW 只读、PUBLISHED 不可改稿）。
- `SubmitContentSubmissionInput { libraryNoticeConfirmed! }`：未确认（false）拒绝送审；告知版本由服务端固定（当前 `library-internal-v1`），确认人与时间在版本表落库；重复送审不产生新版本（状态前置拒绝）。
- `ReviewContentSubmissionDecisionInput { submissionId!, revisionId!, decision!, comment?, publishAttachment? }`：
  - `revisionId` 必须属于该投稿且等于当前待审版本（行锁内核对，不符拒绝）；
  - `RETURN`：`comment` 必填（缺 → `BAD_USER_INPUT`「退回时必须填写理由」）；
  - `APPROVE`：`publishAttachment` 缺省 `false`=不发布附件；无文件版本传 `true` 拒绝、仅文件版本传 `false` 拒绝（发布一致性）；`comment` 可选。
- `UpdateReferenceDocumentCaseInput`（12 字段白名单）：`title`、`equipmentModelId`、`equipmentModelText`、`description`、`errorCode`、`phenomenon`（必填不可清空）、`conditionText`、`reproductionSteps`（必填不可清空）、`diagnosis`、`actionTaken`、`handlingStatus`（必填不可清空）、`resolution`（已解决时必须非空）；补丁至少一个字段；机型 ID 与文字互斥；完整契约见 `reference-document` 域文档与 S6 回执。

## 枚举与状态机

| 枚举 | 取值 | 说明 |
| --- | --- | --- |
| `submissionKind` | `MATERIAL` / `FAULT_CASE` | 受控字符串（非 GraphQL enum，值域 usecase 校验） |
| `status` | `DRAFT` / `PENDING_REVIEW` / `RETURNED` / `PUBLISHED` | 数据库 CHECK 同口径 |
| `decision` | `RETURN` / `APPROVE` | DTO `@IsIn` 校验 |
| `handlingStatus` | `UNRESOLVED` / `IN_PROGRESS` / `RESOLVED` | RESOLVED 时 `resolution` 必填 |

状态可操作性（计划 §2.2 契约原文）：

| 当前状态 | 投稿人可做 | 管理员可做 | 版本事实 |
| --- | --- | --- | --- |
| `DRAFT` | 保存文字、上传/替换/移除单附件、送审 | 无审核动作 | `current_revision_no=0` |
| `PENDING_REVIEW` | 只读本人当前状态和版本 | 审核当前版本 | 快照和附件不可变 |
| `RETURNED` | 修改当前稿和附件、重提 | 历史只读 | 旧版保留；重提新建版本 |
| `PUBLISHED` | 只读投稿及获准版本 | 通过正式资料接口维护 | 不回写快照、不重复发布 |

不提供：待审撤回、投稿删除、再次发布已发布投稿。

## 分页与排序契约

- **仅 OFFSET 分页**：`pagination { mode: OFFSET, page, pageSize, withTotal: true }`；非 OFFSET 模式拒绝。
- **页大小**：默认 20，可选 20/50/100；服务端上限 100（超限拒绝/收敛，DTO 边界 `@Max(100)`）。
- **排序白名单（服务端固定）**：本人列表 `updated_at DESC, id DESC`；审核队列 `last_submitted_at DESC, id DESC`（默认待审，实际主表列为 `last_submitted_at`）。正式资料库保持既有 `created_at DESC, id DESC` 不变。
- 列表返回真实 `total`；越界页返回空页且 `total` 稳定。

## 返回 DTO 关键字段

- `ContentSubmissionPaginatedDTO`：`items / total / page / pageSize`；列表项 8 字段：`id, title, submissionKind, status, currentRevisionNo, lastSubmittedAt, updatedAt, createdAt`（草稿标题可为 `null`）。
- `ContentSubmissionMineDetailDTO`（13 顶层键）：`id, submissionKind, status, currentRevisionNo, lastSubmittedAt, publishedAt, material, faultCase, currentAttachment, latestReview, publishedDocument, createdAt, updatedAt`。
  - 按类别恰好一类明细非空：`material`（7 字段）/ `faultCase`（12 字段，含 `equipmentModelName` 富集名）；
  - `currentAttachment`：`{ id, originalFilename, mimeType, byteSize, uploadedAt }`（无存储引用与服务器路径）；
  - `latestReview`：`{ decision, comment, publishAttachment, reviewedAt }`（未审核为 `null`）；`publishedDocument`：`{ documentId, available }`（`available=false`=已下架，保留 ID 不可用）。
- `ContentSubmissionRevisionDTO`（12 顶层键）：`revisionId, submissionId, submissionKind, revisionNo, schemaVersion, titleSnapshot, payloadSnapshot, attachment, noticeVersion, confirmedAt, submittedAt, review`。
  - `payloadSnapshot` 为业务字段完整快照（**不含** `equipmentModelName`、存储引用与服务器路径）：MATERIAL 含 `title/documentType/equipmentModelId/equipmentModelText/description/contentText`；FAULT_CASE 为 11 键（含 `handlingStatus`/`resolution` 等）；
  - `noticeVersion` 为服务端固定告知版本字符串（真机实测值 `library-internal-v1`，**不是**日期）；`review` 为该版本审核记录（至多一条，未审核为 `null`）。
- `ContentSubmissionReviewDetailDTO`（8 顶层键）：`submissionId, submissionKind, status, currentRevisionNo, lastSubmittedAt, submittedByAccountId, currentRevision, reviewHistory`。
  - `submittedByAccountId` 为审核链路独有（供管理员联系投稿人；本人链路不返回）；
  - `reviewHistory` 条目 6 字段：`revisionId, revisionNo, decision, comment, publishAttachment, reviewedAt`（全部历史版本审核，新在前；不含审核人账号 ID）。
- Mutation 结果：草稿保存 `{ id, submissionKind, status, updatedAt }`；送审 `{ submissionId, revisionId, revisionNo, status }`；审核决定 `{ submissionId, status, documentId }`（`RETURN` 时 `documentId` 恒为 `null`）；案例更正 `{ id, updatedAt }`。
- **不返回**：存储引用 / 服务器路径 / 审核人账号 ID（审核详情仅返回投稿人账号 ID）。

## 错误契约（本文相关）

| 场景 | errorCode（细码） | extensions.code（大类） | HTTP 语义等价 |
| --- | --- | --- | --- |
| DTO 长度/范围校验、机型与机型文字并存、扩展 JSON 含未定义键、退回缺意见、空补丁、未确认入库告知、送审完整性不足 | `CONTENT_SUBMISSION_INVALID_PARAMS` | `BAD_USER_INPUT` | 400 |
| 草稿无任何已填写文字业务字段 | `CONTENT_SUBMISSION_DRAFT_EMPTY` | `BAD_USER_INPUT` | 400 |
| 投稿不存在 / 他人投稿 / 跨组织 / 冻结版本非授权范围（统一防探测） | `CONTENT_SUBMISSION_NOT_FOUND` | `NOT_FOUND` | 404 |
| 指定设备型号不存在 | `CONTENT_SUBMISSION_EQUIPMENT_MODEL_NOT_FOUND` | `NOT_FOUND` | 404 |
| 当前状态不允许该操作（PENDING_REVIEW 只读、PUBLISHED 不可改稿、重复送审、版本不符） | `CONTENT_SUBMISSION_STATE_NOT_EDITABLE` | `CONFLICT` | 409 |
| 系统侧落库/锁读失败、`1:1` 明细缺失的失败关闭 | `CONTENT_SUBMISSION_CREATION_FAILED` / `UPDATE_FAILED` / `READ_FAILED` | `INTERNAL_SERVER_ERROR` | 500 |
| 组织成员事实缺失/歧义 | `ORGANIZATION_NO_ACTIVE_MEMBERSHIP` / `ORGANIZATION_AMBIGUOUS_MEMBERSHIP` | `FORBIDDEN` | 403 |
| 角色/归属不满足（含 SUPER_ADMIN 调本人写入口） | 既有权限契约 | `FORBIDDEN` | 403 |
| 未认证 / Token 失效 | 既有认证契约 | `UNAUTHENTICATED` | 401 |
| 非案例资料误用案例更正接口 | `REFERENCE_DOCUMENT_INVALID_PARAMS`（「仅故障案例资料可以使用案例更正接口」） | `BAD_USER_INPUT` | 400 |

> 注：表中 HTTP 列为「语义上的 REST 等价状态」，**不可作为 GraphQL 断言依据**：GraphQL over HTTP 通常对业务/认证/授权失败仍返回 **HTTP 200** 并在 body 携带 `errors`。调用方判定必须以 `errors[0].extensions.code` 为准。
> 生产环境 `extensions.errorCode` / `extensions.errorMessage` 可能被隐藏：前端主信号取 `extensions.code`（契约保证稳定），细码仅作可选细化，隐藏时自动回退大类码映射（T19 覆盖）。

## 前端调用位置（S7 交付镜像）

`frontend/src/features/content-submission/`（barrel：`index.ts`）：

| 操作 | 前端函数（`infrastructure/content-submission-adapter.ts`） |
| --- | --- |
| 1 本人列表 | `fetchMyContentSubmissions(pagination, filter?)` |
| 2 本人详情 | `fetchMyContentSubmission(id)` → `{ ok, detail }` / `{ ok:false, reason:'not-found' }` |
| 3 冻结版本 | `fetchContentSubmissionRevision(submissionId, revisionNo)` |
| 4 审核队列 | `fetchReviewContentSubmissions(pagination, filter?)` |
| 5 审核详情 | `fetchReviewContentSubmission(id)` |
| 6 建草稿 | `createContentSubmissionDraft(input)` → `{ ok, reason?, message? }` |
| 7 改草稿 | `updateContentSubmissionDraft(id, patch)` |
| 8 送审 | `submitContentSubmission(id, input)` |
| 9 审核决定 | `reviewContentSubmissionDecision(input)` |
| 10 案例更正 | `frontend/src/features/reference-document/infrastructure/reference-document-adapter.ts` → `updateReferenceDocumentCase(id, patch)` |

- 错误双轨制：transport/auth/network/malformed 由 `shared/graphql` 归一为 `GraphQLIngressError` 原样上抛；业务拒绝返回显式结果 `{ ok:false, reason, message }`；`reason` 取值见 `ContentSubmissionWriteFailureReason`（`not-found` / `model-not-found` / `invalid-input` / `state-conflict` / `forbidden` / `operation-failed`）。
- 适配器不读写 Session（Token 注入由 `configureGraphQLRuntime` 桥接）；不包装第二套 HTTP 框架。

## 真实调用样例（T19 / T20 证据）

- **捕获规格**：`test/11-content-submission/frontend-response-samples.e2e-spec.ts`（12 个操作文本逐字复制前端 adapter；15 组精确键集合断言；39 条样例落盘）。
- **执行方式**：`S7_SAMPLES_OUT=/tmp/s7-samples.json npm run test:e2e:file -- test/11-content-submission/frontend-response-samples.e2e-spec.ts`（真机 7/7 通过）。
- **交接材料**：`docs/database/PR0-S7交接材料与真实调用样例-20261020.md`（固定 Seed、账号获取方式、从草稿到发布/下载/更正的最小变量序列、接口↔页面映射表、失败响应清单；隐藏凭据与服务器路径）。