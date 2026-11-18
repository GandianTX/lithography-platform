<!-- docs/api/admin-document-database-graphql-current.md -->

Purpose: Snapshot the current GraphQL contract for the admin Document Database (PR3 + 任务 04 工单切片), covering four read resources (reference documents / repair requests / AI conversations / AI reports) for SUPER_ADMIN only, plus the single controlled work-order revision mutation.
Read when: You change the admin Document Database resolver, DTOs, filter inputs, list/stats usecases, admin read QueryServices, or the SUPER_ADMIN authorization boundary of this capability.
Do not read when: You only change the customer/engineer-facing repair-request or reference-document read/write contracts (see their own capability docs), or the REST file upload/download contract (`docs/api/reference-document-rest-current.md`).
Source of truth: `src/adapters/api/graphql/admin-document-database/`、`src/usecases/admin-document-database/`、`src/modules/lithography/queries/admin-*.query.service.ts` 为可执行真源；本文只记录已实现并被 S2/S4 测试覆盖的稳定契约。
Global error contract: 遵循 `docs/api/graphql-error-contract-current.md`；本文相关映射见末尾错误表。

# Admin Document Database GraphQL Contract（PR3 只读聚合）

## 定位

- **读为主、单角色**：本解析器默认只提供 `Query`；唯一写入口是任务 04 的 `appendRepairRequestRevision`（管理员工单修订），其余标签保持只读。全部操作精确限定 `SUPER_ADMIN`；工单列表、详情与修订按一级全公司、二级本公司核权；聚合统计与 AI 查询要求一级且具有唯一有效的管理员组织成员关系。不写 AI 数据、不改训练/生成链路、不暴露表结构编辑或数据库管理能力。
- **不复建参考资料链路**：参考资料标签复用既有 `referenceDocuments` / `referenceDocument` 查询（工程师/管理员既有读契约，默认排除软删除），本契约不新增平行查询。
- **排序由契约固定**：列表不采纳客户端 `sorts` 字段，排序白名单在服务端写死（见「分页与排序契约」），杜绝把客户端字段名直传 QueryBuilder。
- **真实总数**：列表显式返回 `total`；统计四类总数取自真实 count/查询，口径与各标签默认列表过滤一致，空库返回 0 与正式空态，不硬编码演示数字。

## 权限矩阵

| 通道 | SUPER_ADMIN | ADMIN | ENGINEER | CUSTOMER | 匿名 |
| --- | --- | --- | --- | --- | --- |
| `adminRepairRequests` / `adminRepairRequestSummary` | 一级全公司、二级本公司，只读 | `FORBIDDEN` | `FORBIDDEN` | `FORBIDDEN` | `UNAUTHENTICATED` |
| 聚合统计与 4 个 AI Query | 一级且具有唯一有效的 SUPER_ADMIN 组织成员关系，只读 | `FORBIDDEN` | `FORBIDDEN` | `FORBIDDEN` | `UNAUTHENTICATED` |
| `appendRepairRequestRevision` | 允许（一级全公司 / 二级本公司） | `FORBIDDEN` | `FORBIDDEN` | `FORBIDDEN` | `UNAUTHENTICATED` |

授权双层：守卫层 `@Roles(SUPER_ADMIN)` 粗准入；精确授权（`roles` 含且 `activeRole === SUPER_ADMIN`，失败关闭）由每个 usecase 首行 `assertAdminDocumentDatabasePermission` 断言；停用/降级账号旧 Token 由每请求复核兜底。异常不泄露数据库信息。

## Operations

| Query | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `adminRepairRequests` | `pagination!`, `filter?` | `AdminRepairRequestPaginatedDTO` | 按管理员组织范围分页查询工单（默认不含软删除） |
| `adminRepairRequestSummary` | `id: Int!` | `AdminRepairRequestSummaryDTO` | 单条工单只读详情（含已提交过程、客户回复、结单事实、修订历史） |
| `appendRepairRequestRevision` | `input: AppendRepairRequestRevisionInput!` | `AdminRepairRevisionResultDTO` | 管理员工单修订（版本条件 + 字段白名单 + 必填原因） |
| `adminAiConversations` | `pagination!`, `filter?` | `AdminAiConversationPaginatedDTO` | 全局 AI 会话分页列表（含真实消息数/报告数） |
| `adminAiMessages` | `conversationId: Int!`, `pagination!` | `AdminAiMessagePaginatedDTO` | 按会话读取消息（稳定顺序，支持 100 轮） |
| `adminAiReports` | `pagination!`, `filter?` | `AdminAiReportPaginatedDTO` | 全局 AI 报告分页列表（不投影正文） |
| `adminAiReport` | `id: Int!` | `AdminAiReportDetailDTO` | 报告只读详情（含正文）；无生成/修改/删除 |
| `adminDocumentDatabaseStats` | — | `AdminDocumentDatabaseStatsDTO` | 四类总数统计 |

## 筛选入参（全部可选；空白字符串视为未提供该筛选）

`AdminRepairRequestFilterInput`

| 字段 | 类型 | 匹配语义 |
| --- | --- | --- |
| `requestNo` | String(≤64) | 申请编号 **LIKE 模糊**（转义 `%_\`） |
| `customerKeyword` | String(≤100) | 客户昵称/公司名模糊 → 服务端解析为账号 ID 集合（见规整规则） |
| `equipmentModelId` | Int(≥1) | 设备型号 **等值** |
| `errorCode` | String(≤100) | 故障码 **等值精确匹配**（非模糊） |
| `isAccepted` | Boolean | 接单状态 **等值** |
| `createdAtFrom` / `createdAtTo` | Date | 创建时间区间（含端点） |

`AdminAiConversationFilterInput`：`requestNo`(模糊)、`engineerKeyword`(模糊→账号集)、`status`(`AiConversationStatus` 枚举等值)、`createdAtFrom/To`。
`AdminAiReportFilterInput`：`requestNo`(模糊)、`engineerKeyword`(模糊→账号集)、`reportType`(等值≤100)、`createdAtFrom/To`。

> 注：`errorCode` 为等值精确匹配（稳定契约）。前端占位符已对齐为「输入完整故障码」，与本契约一致，不再暗示模糊搜索。是否将来新增 LIKE 模糊筛选属产品层的待决策项，不影响当前实现口径。

## 分页与排序契约

- **仅 OFFSET 分页**：非 OFFSET 模式 → `ADMIN_DOCUMENT_DATABASE_INVALID_PARAMS`（`BAD_USER_INPUT`）。
- **页大小上限 100**：`PaginationArgs.pageSize` 边界 `@Max(100)`（超限如 501 由 DTO 校验显式拒绝；R2 起 production 返回 `BAD_USER_INPUT` + `ADMIN_DOCUMENT_DATABASE_INVALID_PARAMS`）；usecase 侧再以 `enforceMaxPageSize(..., 100)` 收敛，`pageSize>100` 压回 100。
- **排序白名单（服务端固定，不可由客户端覆盖）**：
  - 维修申请 / AI 会话 / AI 报告列表：`createdAt DESC, id DESC`。
  - AI 消息：`messageSeq ASC, id ASC`（轮次 `turnNo` 1–100，读取顺序稳定不随插入/并发变化）。
- **深分页压力边界**：`page * pageSize` 上限 100000 范围内分页正确、不超时；越界页返回空页且 `total` 稳定。

## 入参规整与失败关闭（M-02 / M-03）

- **展示关键字账号上限（M-02）**：`customerKeyword`/`engineerKeyword` 经账户域批量解析为账号 ID 集合；命中数 `totalMatched > 1000` **显式拒绝**（`ADMIN_DOCUMENT_DATABASE_INVALID_PARAMS`），不静默取前 1000（截断会漏数、违反真实总数）；无命中短路返回空页，不再查本域。
- **关键字长度**：规整去空白后 > 100 → 拒绝，不截断。
- **时间范围（M-03）**：起/止须为有效 `Date`（Invalid Date 拒绝）且 `from ≤ to`，否则 `INVALID_PARAMS`。
- **详情 ID（M-03）**：`assertPositiveId`——必须安全正整数（0/负数/非整数拒绝），防非法值直达 ORM。

## 返回 DTO 关键字段与约束

- **不返回任何归属类账号 ID**；昵称/公司名（`customerNickname`/`companyName`/`engineerNickname`/`acceptedByEngineerNickname`）为服务端一次性批量富集的展示字段，缺失回落占位（如「未知用户」/「工程师」），不逐行查询（防 N+1）。
- 维修申请列表项：`id, requestNo, customerNickname, companyName, equipmentModelId, equipmentModelCode, equipmentModelName, errorCode, createdAt, isAccepted, acceptedAt, acceptedByEngineerNickname, latestResolutionStatus`；详情额外含 `faultDescription, contentMd, closureStatus, closedAt, closureReason, handlingResult, handlingStatus, currentRevisionNo, processEntries, responses, revisions`。
- 详情中的 `processEntries` 只返回已提交内部过程的安全字段（含 `file` 的 `fileId/originalFilename/mimeType/byteSize/checksumSha256`，不含存储引用）；仅当任务 11 正式绑定事实有效（用途 `REPAIR_PROCESS`、状态 `VALID`、`verifiedAt` 非空、绑定状态 `BOUND`、`businessId` 指向当前工单且过程行存在真实 `file_id` 关联）时才返回 `fileId/file`，否则两者同时为 null，过程文本与版本号保持不变；`responses` 为客户可见回复时间线；`revisions` 为新到旧修订历史。不返回未提交草稿、私有 AI 会话/消息、报告正文或其他来源原件。
- AI 会话项：`id, requestId, requestNo, engineerNickname, status, aiFeedback, createdAt, completedAt, messageCount, reportCount`。
- AI 消息项：`id, conversationId, messageSeq, turnNo, role, contentText, createdAt`。
- AI 报告项：`id, requestId, requestNo, requestMismatch, conversationId, engineerNickname, reportTitle, reportType, createdAt`；详情额外含 `contentMd`。
  - **报告↔申请关联口径（M-04）**：以**会话归属申请为权威**，报告自身 `requestId` 降级为审计字段；两者不一致属异常历史数据，输出 `requestMismatch=true` 审计标记并记结构化警告日志，不静默改写、不改 Entity/Migration/唯一约束。
- 统计 `AdminDocumentDatabaseStatsDTO`：`repairRequestTotal`（不含软删）、`aiConversationTotal`、`aiReportTotal`、`referenceDocumentTotal`（不含软删，取真实 total）。

## 枚举归属（M-01）

`AiConversationStatus` / `AiMessageRole` 定义在共享类型层 `src/types/models/ai-conversation.types.ts`；adapter 仅依赖该 `@app-types` 共享类型，不在运行时 import `modules/**`。对应实体文件仅改 import 路径，无列/装饰器/schema 变更。

聚合统计与 AI 查询在读取业务数据前调用 `assertAdminDocumentDatabaseGlobalAccess`，复核当前一级等级、唯一有效组织及成员角色。缺等级、非法等级、二级、成员失效或角色不符均拒绝。该全域门槛用于文档聚合页，工单管理页复用的列表和详情按下节组织范围执行。

## 管理员工单组织范围（R027–R030 / 页面 §6.3–6.4）

- **一级管理员（`admin_level = 1`）**：工单列表、分页 `total` 与详情均为全公司。
- **管理员等级失败关闭**：`admin_level` 为 `NULL` 或非法值时不按一级放行，统一按 `FORBIDDEN` 拒绝，见 `docs/database/v13-deployment/data-contracts.md` §5/§6.1。
- **二级管理员（`admin_level = 2`）**：组织 ID 只取服务端可信组织成员事实（`TrustedOrganizationContextQueryService`），无唯一有效组织时失败关闭为 `FORBIDDEN`，不回退全库。
- **组织范围统一口径（有 intake / 历史无 intake）**：列表、分页 `total`、详情与修订共用 `isRepairRequestVisibleToAdminOrganization` 语义：
  - **有 intake（`intake_id` 非空）**：必须同时满足 intake 存在、工单 `service_organization_id` 与 intake `service_organization_id` 均存在、相等并等于本公司；归属冲突、服务公司缺失或关联记录不存在时**失败关闭**，不回退 `owner_organization_id`。intake 的逻辑删除（`deleted_at` 非空）**不单独**使已关联工单不可见：仍按上述「双方服务公司一致且等于本公司」判定；一级管理员与无 intake 历史工单的规则不变。
  - **无 intake 的历史工单**：维持既有 `service_organization_id ?? owner_organization_id` 口径。
  - 无 intake 且两列都为空时仅一级管理员可见。
- **同口径强制**：列表 SQL where、分页 `total` 与详情可见性复用上述语义。二级管理员列表生成三类分支：有 intake 的一致性 EXISTS 分支、无 intake 的 `service = 本公司` 分支、无 intake 且 service 为空时的 `owner = 本公司` 分支；全部条件在分页前执行，`total` 复用同一 where。详情对跨公司、归属冲突、已删除、不存在统一返回 `ADMIN_DOCUMENT_DATABASE_NOT_FOUND`，不区分对外表述。
- **修订**：`appendRepairRequestRevision` 在同一事务内按上述同一口径核对（含 intake 服务公司）；不满足时按 `REPAIR_REQUEST_NOT_FOUND` 失败关闭，不读取内部过程/原件且不产生任何写入。
- **原件**：仍按任务 11 独立契约（工单 service 与 intake service 一致）控制；本节的「组织范围统一」不改变任务 11 的下载/绑定授权，也不宣称全平台权限统一。无 intake 的历史工单，二级管理员仅可见过程文本，不展示原件元数据。

## 管理员工单修订（`appendRepairRequestRevision`）

入参：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `requestId` | `Int!` | 安全正整数 |
| `expectedVersion` | `Int!` | 必须等于工单当前 `current_revision_no` |
| `reason` | `String!` | 去空白后必填，≤1000 字符，写入修订历史 |
| `contentMd` | `String` | 可选，订正后的申请正文 |
| `handlingResult` | `RepairRequestHandlingResult` | 可选，订正后的处理结果 |
| `closureReason` | `String` | 可选，订正后的结单原因；无处理结果时不能单独修订 |
| `processEntries` | `[RepairProcessEntryRevisionInput!]` | 可选，只订正已存在过程文本；每项需 `entryId + expectedVersion + operationText + testResult?` |

字段白名单（唯一允许修订）：`contentMd`、`handlingResult`、`closureReason`、已有 `processEntries` 的文本。至少一个字段发生实际变化，否则 `BAD_USER_INPUT`。

禁止改写（原始事实，服务端不接收也不更新）：`requestNo`、`customerAccountId`、`equipmentModelId`、`errorCode`、`faultDescription`、`createdAt`、`isAccepted`、`acceptedByEngineerAccountId`、`acceptedAt`、`ownerOrganizationId`、`serviceOrganizationId`、`closureStatus`、`closedAt`、`currentRevisionNo`（仅服务端递增）、`deprecated`、`isHistorical`。客户原始提交、AI 模型输出、维修报告与模型评价不在本接口开放；管理员不代接单、不新建过程、不代写总结。

并发与事务：

- 事务内先 `SELECT repair_request ... FOR UPDATE`，有 `intake_id` 时再以共享锁读取 intake 服务公司核对归属，最后锁过程行；锁顺序固定「工单 → intake → 过程」，不持有原件锁，与「原件 → 工单 → 过程」写路径无反向锁序。窄窗口内 intake 归属被并发改写时由共享锁阻塞，授权结论基于同一事务快照。
- 条件更新 `WHERE id AND deprecated = false AND current_revision_no = expectedVersion`；命中 0 行按 `REPAIR_REQUEST_PROCESS_VERSION_CONFLICT`（`CONFLICT`）拒绝。过程行按 `(id, request_id, version_no)` 条件更新，命中 0 行同样冲突。
- 修订行写入 `repair_request_revision`：`revision_no = expectedVersion + 1`、`previous_version`、`before_snapshot` / `after_snapshot`（`schema_version = 1`）、`actor_account_id`、`reason`。快照保留原始提交、组织归属、接单人、处理/结单事实与客户回复，供审计对比。
- 任一写入失败整体回滚，不产生部分更新；成功后详情按当前生效值返回。
- 事务明确提交成功后才查询操作者昵称用于展示；昵称查询失败仅回退为占位昵称，不改变已提交结果、不重试 mutation；事务自身失败仍返回失败，不误报成功。
- 审计：修订历史行即审计证据；按 R030 不写 `management_audit_event`。
- 二级管理员跨公司修订、目标不存在/已删除统一 `REPAIR_REQUEST_NOT_FOUND`；未接单工单修订处理结果按 `REPAIR_REQUEST_HANDLING_NOT_AVAILABLE`（`CONFLICT`）拒绝。

## 错误契约（本文相关）

| 场景 | code | GraphQL extension code | HTTP |
| --- | --- | --- | --- |
| DTO 长度/范围校验（`requestNo`≤64、关键字≤100、`errorCode`/`reportType`≤100、设备 ID≥1、`page`/`pageSize` 范围）/ 非法分页模式 / 关键字超限 / 账号命中超 1000 / 非法 ID / 非法时间范围 | `ADMIN_DOCUMENT_DATABASE_INVALID_PARAMS` | `BAD_USER_INPUT` | 400 |
| 目标（申请摘要 / 报告详情 / 二级管理员跨公司工单）不存在、已软删或越权（统一，防探测不泄露删除状态） | `ADMIN_DOCUMENT_DATABASE_NOT_FOUND` / `REPAIR_REQUEST_NOT_FOUND` | `NOT_FOUND` | 404 |
| 工单修订字段为空、原因缺失或超长、无处理结果却单独改结单原因、中断/无法修复未填原因 | `REPAIR_REQUEST_INVALID_PARAMS` | `BAD_USER_INPUT` | 400 |
| 工单修订版本过期、过程版本过期、未接单却改处理结果 | `REPAIR_REQUEST_PROCESS_VERSION_CONFLICT` / `REPAIR_REQUEST_HANDLING_NOT_AVAILABLE` | `CONFLICT` | 409 |
| 非 SUPER_ADMIN 直调 / 二级管理员无可信公司 | 既有权限契约 | `FORBIDDEN` | 403 |
| 未认证 | 既有认证契约 | `UNAUTHENTICATED` | 401 |

> 注：表中 HTTP 列为「语义上的 REST 等价状态」，**不可作为 GraphQL 断言依据**：GraphQL over HTTP 通常对业务/认证/授权失败仍返回 **HTTP 200** 并在 body 携带 `errors`。调用方判定成功/失败必须以 `errors[0].extensions.code`（如 `BAD_USER_INPUT` / `NOT_FOUND` / `FORBIDDEN` / `UNAUTHENTICATED`）为准，不能仅凭 HTTP 状态码。

> **R2（负责人 review #2；生产错误分类）**：本模块全部接收 `PaginationArgs` 的列表 Query（含 R2 前缺失 DTO 校验的 `adminAiMessages`）统一使用模块局部 `ValidateAdminDocumentDatabaseInput`；DTO 校验失败抛 `DomainError(ADMIN_DOCUMENT_DATABASE_INVALID_PARAMS)`，**在 production 同样返回 `BAD_USER_INPUT` + 可读文案**（不以通用 `ValidateInput` 的 `BadRequestException` 形式经过生产全局过滤器——那会被降级为 `INTERNAL_SERVER_ERROR` 并隐藏文案）。usecase 层规整（关键字超限、时间范围倒置、详情 ID 非正整数）走同一错误码；非输入类错误（`NOT_FOUND`）与认证/授权分类不变，真实内部异常仍为 `INTERNAL_SERVER_ERROR` 且不泄漏细节。生产链路回归见 `test/10-admin-document-database/admin-document-database-production.e2e-spec.ts`。
