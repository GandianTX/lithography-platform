<!-- docs/api/repair-request-current.md -->

Purpose: Snapshot the current repair-request (维修申请) read/write contract for this repository.
Read when: You change repair-request list / detail / accept / response / delete flows, or engineer workbench pages that consume them.
Do not read when: You only change unrelated APIs.
Source of truth: Current resolver/usecase/type code remains executable truth; this file records the stable contract agents must preserve.

# Repair Request Current Contract

## 当前范围

维修申请域覆盖客户提交申请、客户查看/删除自己的申请、客户读取首析状态/正文与本人报修原件（任务 03 第三段）、工程师四态列表、工程师详情（含他人已接单只读视角）、原子接单、工程师追加处理回复、客户读取回复时间线，以及工程师内部维修过程记录/编辑、原件绑定、工单结单（任务 04 第一轮）。

内部维修过程与其原件的可见范围仅限接单工程师本人：详情只有在解析出的视角为 `ENGINEER` 且当前账号是该申请接单人时才装配 `processEntries`；`SUPER_ADMIN` 视角与客户详情不返回 `processEntries` 与任何内部原件字段。客户报修原件（REPAIR_REQUEST）由客户入口单独装配并通过共用下载链路读取（见「客户读侧」）。原件上传/绑定/下载复用任务 11 的共用业务原件能力（`/api/stored-files`），本域不新增临时 HTTP 入口。

本域不包含 AI 故障诊断、远程授权、上门维修。管理员查询与受控修订由 `docs/api/admin-document-database-graphql-current.md` 的工单切片承载；管理员不进入本域工程师写入口（不代接单、不新建过程、不代写总结），修订只订正已提交事实。

数据库扩展只能新增 Migration，不能修改已接受 baseline。

## GraphQL 入口

当前维修申请相关入口（Resolver：`src/adapters/api/graphql/repair-request/repair-request.resolver.ts`）：

- `createRepairRequest(input: CreateRepairRequestInput): RepairRequestDTO`（仅 CUSTOMER 准入）
- `deleteMyRepairRequest(id: Int!): DeleteMyRepairRequestResultDTO`（仅 CUSTOMER 准入）
- `acceptRepairRequest(id: Int!): RepairRequestDetailDTO`（ENGINEER / SUPER_ADMIN 准入，写权限另行精确裁决）
- `createEngineerResponse(input: CreateEngineerResponseInput): EngineerResponseDTO`（同上）
- `createRepairProcessEntry(input: CreateRepairProcessEntryInput): RepairProcessEntryDTO`（ENGINEER / SUPER_ADMIN 准入，写权限另行精确裁决）
- `updateRepairProcessEntry(input: UpdateRepairProcessEntryInput): RepairProcessEntryDTO`（同上）
- `closeRepairRequest(input: CloseRepairRequestInput): RepairRequestClosureDTO`（同上）
- `myRepairRequests(pagination: PaginationArgs!): RepairRequestCustomerPaginatedDTO`（CUSTOMER / SUPER_ADMIN 准入）
- `myRepairRequest(id: Int!): RepairRequestDetailDTO`（CUSTOMER / SUPER_ADMIN 准入）
- `retryIntakeAnalysis(id: Int!): RetryIntakeAnalysisResultDTO`（仅 CUSTOMER 准入；任务 03 第二段）
- `engineerRepairRequests(scope: String = "ALL", pagination: PaginationArgs!, filter: EngineerRepairRequestFilterInput): RepairRequestEngineerPaginatedDTO`（ENGINEER / SUPER_ADMIN 准入）
- `engineerRepairRequest(id: Int!): RepairRequestDetailDTO`（ENGINEER / SUPER_ADMIN 准入）
- `equipmentModels: [EquipmentModelDTO]`（创建申请表单与工程师列表筛选共用）
- `repairServiceOrganizationSearch(pagination: PaginationArgs!, keyword: String): RepairServiceOrganizationPageDTO`（仅 CUSTOMER 准入；客户身份与可信公司归属由 Usecase 精确复核）

`SUPER_ADMIN` 按 roleHierarchy 继承读准入；写权限不随读权限继承，见「写权限矩阵」。

## 工程师四态列表

`engineerRepairRequests` 的 `scope` 缺省为 `ALL`，取值与语义：

- `ALL`：全部未删除申请；
- `AVAILABLE`：未接单（待接单池；仅表示未接单事实，不代表当前会话可接单）；
- `MINE`：当前会话账号已接单；
- `TAKEN_BY_OTHER`：其他账号已接单。

四个视角均以工程师可信服务公司为范围：仅包含「工单服务公司 = 原始报修 intake 服务公司」且等于当前会话可信组织的工单。intake 缺失、服务公司缺失或两处冲突的工单不会进入任何工程师视角，也不按旧 owner、客户公司、客户端组织或历史接单人兜底；客户与管理员的读入口不受影响。

非法 scope 由 usecase 拒绝；scope 以字符串表达，不作为客户端可枚举的数据库状态。

筛选输入 `EngineerRepairRequestFilterInput`：

- `equipmentModelId: Int`（可选，等值筛选）；
- `customerNickname: String`（可选，最长 100；按既有输入归一处理，空白归一为空筛选，LIKE 通配符转义由账号域查询服务完成，不允许通配符逃逸）。

筛选在数据库侧、分页计数（total）之前完成；不支持先分页后过滤。

排序固定为 `createdAt DESC, id DESC`（同创建时间按主键倒序稳定排序）；仅支持 OFFSET 分页（usecase 强制）。所有 scope 固定包含 `deprecated = false`。

列表项 DTO（`RepairRequestEngineerListItemDTO`）返回：`id`、`requestNo`、`createdAt`、设备型号（`equipmentModel`）、`errorCode`、`isAccepted`、`acceptedAt`、`latestResolutionStatus`，以及富集字段：`customerNickname`（非空）、`customerCompanyName`（可空）、`acceptanceViewStatus`、`acceptedEngineerNickname`（可空）。

客户与接单工程师展示资料由 usecase 批量读取账号域安全资料，禁止逐行 N+1；归属类账号 ID（customerAccountId / acceptedByEngineerAccountId）只在内部装配使用，不进入任何对外 DTO。

## 详情与视角状态

工程师详情仅对「工单服务公司 = 原始报修 intake 服务公司」且等于当前会话可信组织的未删除申请可读（含他人已接单）。intake 缺失、服务公司缺失或两处冲突时，工程师入口一律按不可查看拒绝，不按旧 owner、客户公司、客户端组织或历史接单人兜底；客户查看本人申请与管理员既有授权不受影响。`RepairRequestAcceptanceViewStatus` 为当前会话观看单条申请的事实分类，非数据库枚举，客户端不可传入：

- `AVAILABLE`：未接单（不代表可接单能力，能力由写用例裁决）；
- `MINE`：接单工程师为当前会话账号；
- `TAKEN_BY_OTHER`：已被其他账号接单（SUPER_ADMIN 视角下已接单一律归此类）。

详情 DTO 富集字段（客户入口为 null，工程师入口非空）：`customerNickname`、`customerCompanyName`、`acceptanceViewStatus`、`acceptedEngineerNickname`。客户详情不返回上述富集字段值。

详情 DTO 结单事实字段（客户与工程师入口共用，旧行可空）：`closureStatus`（`CLOSED` 或 null）、`closedAt`、`closureReason`、`handlingResult`、`handlingStatus`。

详情 DTO `processEntries: [RepairProcessEntryDTO!]!`：仅当详情视角为 `ENGINEER` 且当前账号是接单人时装配；`SUPER_ADMIN` 视角、客户入口与其他账号一律为空数组。条目字段：`id`、`entryUuid`、`requestId`、`operationText`、`testResult`、`occurredAt`、`timeSource`（`SERVER` / `MANUAL`）、`fileId`、`file`（已保存绑定的原件安全字段：`fileId`、`originalFilename`、`mimeType`、`byteSize`、`checksumSha256`，不返回存储引用）、`versionNo`、`createdAt`。`fileId/file` 仅在任务 11 正式绑定事实有效时返回（用途 `REPAIR_PROCESS`、状态 `VALID`、`verifiedAt` 非空、绑定状态 `BOUND`、`businessId` 指向当前工单且过程行存在真实 `file_id` 关联）；无效、未验证、暂存或归属其他工单的原件同时隐藏 `fileId` 与 `file`，过程文本与版本号仍返回。

三个过程/结单 mutation 的返回值不装配 `file`（恒为 null），也不回读绑定关系；绑定结果以保存成功后详情读接口返回的 `processEntries[].file` 为准。

前端依据 `acceptanceViewStatus` 与会话业务角色控制操作可见性：AVAILABLE + 精确 ENGINEER 展示接单；MINE + 精确 ENGINEER 展示回复；TAKEN_BY_OTHER 与 SUPER_ADMIN 只读。视图状态缺失时前端失败关闭为只读。后端不依赖前端隐藏按钮，写用例独立失败关闭。

## 报修服务公司候选（任务 03 选择器）

`repairServiceOrganizationSearch` 供客户提交报修时选择维修服务方，准入与资格口径如下：

- 会话：必须已登录；Token 缺失 / 失效 / Session 失效返回 `UNAUTHENTICATED`。
- 身份：`roles` 必须含 `CUSTOMER`，且请求期可信 `activeRole` 精确为 `CUSTOMER`；活动角色是管理员、或活动角色缺失的历史多角色账号一律 `FORBIDDEN`（角色集合含 `CUSTOMER` 不等于当前以客户身份使用）。
- 归属：必须已补齐可信公司归属（请求期会话给出的 `customerOrganizationId`），缺失即 `FORBIDDEN`；不按客户端自报公司名猜测，拒绝先于任何公司查询。
- 资格：只返回 `status = ACTIVE` 且 `is_service_provider = true` 的公司；与注册候选的 `ACTIVE + is_managed_company` 口径相互独立，两个资格字段互不参与对方判断。
- 分页：仅支持 `OFFSET`（`mode` 为非 `OFFSET` 返回分页错误）；`page` 下限归一为 1，`pageSize` 截断到 50；排序固定为名称、主键升序。
- 字段：只返回选择所需的 `id` / `name` / `shortName`，不含组织编码、联系信息、受管归类或成员数据。

任务 03 可直接使用的用例（`keyword` 缺省表示不过滤，长度上限 100）：

```graphql
query RepairServiceOrganizationSearch($pagination: PaginationArgs!, $keyword: String) {
  repairServiceOrganizationSearch(pagination: $pagination, keyword: $keyword) {
    items {
      id
      name
      shortName
    }
    total
    page
    pageSize
  }
}
```

```json
{
  "pagination": { "mode": "OFFSET", "page": 1, "pageSize": 20 },
  "keyword": "上海"
}
```

任务 08 提供候选查询，查询本身不建立关联。任务 03 起 `createRepairRequest` 接收维修服务公司 ID，并在写入事务内按 `status = ACTIVE` 且 `is_service_provider = true` 重新校验所选公司资格。

## 客户提交（任务 03 提交即出单）

`createRepairRequest(input: CreateRepairRequestInput!): RepairRequestDTO`

```graphql
input CreateRepairRequestInput {
  recordUuid: String! # 36 位 UUID，同一份报修重发必须复用
  serviceOrganizationId: Int! # 所选维修厂家（事务内复核资格）
  equipmentModelId: Int # 与 equipmentModelText 严格二选一
  equipmentModelText: String # 手填新机型，≤50 字符，按编码查重后登记
  errorCode: String!
  faultDescription: String!
  attachment: CreateRepairRequestAttachmentInput # 可选：{ fileId, uploadContextId }
}
```

- 身份与归属：客户账号取自可信会话；客户公司取自 `base_user_info.customer_organization_id`，缺失 `REPAIR_REQUEST_CUSTOMER_COMPANY_REQUIRED`（FORBIDDEN），组织不可用 `CUSTOMER_COMPANY_UNAVAILABLE`（FORBIDDEN）。两者都不接受客户端传入。
- 厂家：不存在/停用/无维修服务资格统一 `SERVICE_ORGANIZATION_NOT_AVAILABLE`（BAD_USER_INPUT，客户端可改选）。
- 机型：`equipmentModelId` 与 `equipmentModelText` 同时给或都不给 → `EQUIPMENT_MODEL_INPUT_INVALID`（BAD_USER_INPUT）；手填文本按空白折叠后以机型编码查重（含停用行），命中启用行复用，命中停用行 `EQUIPMENT_MODEL_DISABLED`，未命中则在同一事务内登记（启用、排序值 0、名称与编码同源）。搜索与输入阶段不写库；事务回滚即不留下新机型。
- 原件：`attachment` 为上传后返回的暂存引用；绑定在同一事务内完成，核对上传者=当前账号、归属公司=当前可信客户公司、用途 `REPAIR_REQUEST`、`uploadContextId` 精确匹配、`VALID + TEMPORARY`、未被占用、存储字节数与 SHA-256 一致。异主/已占用按 `NOT_FOUND`/`CONFLICT` 拒绝，原件不会被挪用到本次报修。
- 原子性（同一事务）：客户公司与厂家资格复核 → 机型复核/登记 → `repair_request_intake` 落库（分析意图固定 `WAITING` + 代次 0）→ 原件绑定（`stored_file.business_type=REPAIR_REQUEST`，`business_id=原稿主键`）→ 唯一工单落库（`repair_request.intake_id` 唯一）→ 原稿回写 `converted_request_id`。任一步失败整体回滚，不出现「有工单无原稿」「有原稿无工单」「原件悬挂」。
- 提交即出单：成功即返回工单 `id` / `requestNo`，不等任何模型调用；首析执行意图是原稿上的 `analysis_status=WAITING` + `analysis_generation=0`，由任务 03 第二段编排消费。

### 首次 AI 分析执行、恢复与重试（任务 03 第二段）

首析执行是「原稿上的执行意图」的消费编排，能力开关为 `intake.analysis`（见 `docs/capabilities/intake-analysis.md`）；模型调用一律经公共 `RAG_DIAGNOSIS_CLIENT` 契约，本域不实现第二套客户端。

**投递与恢复（持久任务标识）**

- 提交事务内在 `base_async_task_record` 登记 `queueName=intake-analysis`、确定性 `jobId=intake-analysis:{intakeId}:g{generation}` 的账本行（`bizType=intake_analysis`、`bizKey=traceId`、`source=user_action`），与原稿/工单同回滚；事务提交后再向 BullMQ `intake-analysis` 队列投递（payload 仅 `{intakeId, generationNo, traceId}`，不携带报修正文）。
- 事务后入队失败或进程退出不视为业务失败：账本行保持 `queued`，housekeeping 只按该队列的账本行扫描补投；不扫描 `repair_request_intake` 的 WAITING 行，开发 Seed 的待分析样例不会进入投递，也不影响其他 AI 任务队列。
- 基建补投有两层且都不推进代次：BullMQ `attempts=3`（瞬时故障重试）与 housekeeping（`queued` 超宽限补投；`processing` 超租约+宽限且 BullMQ 无此 job 时补投并置回 `queued`）。用户主动重试与基建补投完全独立。
- 写回已完成但账本未终结（Worker 在写回后、账本完成事件前退出）：housekeeping 只按数据库事实收敛账本，不再调用模型 —— intake `SUCCEEDED` → 账本 `succeeded`（`worker_completed:intake_reconciled`）；intake `FAILED` → 账本 `failed`（`worker_failed:intake_reconciled`，不伪装为成功）；已删除 / 代次切换 / 未关联工单 → 账本 `cancelled`。收敛是单条条件 `UPDATE`（来源状态 = 本轮扫到的状态），并发 `complete`/`fail` 与另一实例收尾不会被改写成另一种终态，`succeeded` 行永不作为收敛来源；收敛不改写原稿与尝试行。
- 永久错误与临时故障分开处理：不可解析的账本 `jobId`、尝试行越过状态机、以及补投不可能产生新结果的不可重试码，落 `worker_permanent:<code>` 受控终结（人工处置）并退出补投扫描；进程退出、Redis/MySQL 瞬时故障、payload 损坏但 `jobId` 可解析（补投重建 payload）、租约占用仍为 `worker_failed:<summary>` 并保持可补投。两者都不推进代次、不消耗客户唯一一次主动重试。

**认领、租约与写回归属**

- Worker 认领在短事务内对 `repair_request_intake` 行加排他锁：仅「未删除 + 已关联工单 + 代次匹配」且状态为 `WAITING`（首次）或 `RUNNING` 且当前尝试行租约过期（默认 15 分钟）可认领；认领写入 RUNNING 尝试行（`intake_analysis_attempt`，状态 RUNNING），尝试行主键即本次执行的唯一凭据。
- 租约过期接管删除旧尝试行并插入新行：旧执行持有的 attemptId 失效。写回（短事务）先核验未删除 / 工单存在 / 代次匹配 / 状态 RUNNING，再条件更新「自己的尝试行」（仍 RUNNING）与意图行；affected≠1 即 OWNERSHIP_LOST，旧执行迟到、代次已切换、报修已删除均被拒绝且不改任何状态 —— 不是「代次相同先写者胜」。
- 结果写回：正文（trim 后非空）才落 `intake_analysis_attempt.output_text`；图形不持久化；失败写受控原因码（`RAG_{CODE}`，如 `RAG_TIMEOUT` / `RAG_INVALID_RESPONSE` / `RAG_EMPTY_RESPONSE`）。每次真实模型请求写一条 `ai_provider_call_record` 并回填 `provider_call_id`。
- 模型请求仅使用提交时保存的可信机型编码、业务错误码（放入 question，不假充设备主报警）与故障现象；故障现象构造 Unicode 安全的传输截断副本（码点安全、`…[已截断]` 显式标记、UTF-16 预算内），数据库原稿不变；不发附件、私有下载链接与无关账号信息。等待模型不持有数据库事务。

**本人重试（唯一一次）**

- `retryIntakeAnalysis(id)`：仅本人（他人统一 NOT_FOUND，不泄露存在性），事务内条件更新「第 0 代已失败且未删除」→ 原子切换 `analysis_generation=1` + `WAITING`，并登记 g1 账本行；命中失败（并发/重复重试/非失败态）按 `REPAIR_REQUEST_ANALYSIS_RETRY_UNAVAILABLE`（CONFLICT）拒绝。不新建工单、不重绑附件、不改原稿。再次失败不可进入第 2 代。
- 服务端复核与详情页展示资格共用同一策略（`src/core/repair-request/policy/intake-analysis-retry.policy.ts`），在本人的基础上逐项核验：未删除、当前代次、该代次的投递意图账本行存在（可信账本）、当前代次尝试行仍为 `FAILED` 且记录了受控失败原因（最新实际结果）、原稿与工单归属一致（执行归属）。任何一项不满足都失败关闭，不依据账本 `failed` 或 `worker_permanent:` 前缀放行。
- 归属冲突、已删除与记录缺失按 `NOT_FOUND` 拒绝（防探测，不泄露数据异常）；其余不满足按 `REPAIR_REQUEST_ANALYSIS_RETRY_UNAVAILABLE`（CONFLICT）拒绝。域错误与日志不包含队列名、jobId、traceId、失败原因或内部异常文本。

**客户自助恢复白名单（本轮）**

| 持久化事实                                                                 | 客户自助恢复                     | 说明                                                              |
| -------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `WAITING` / `RUNNING` 且当前代次账本行存在（正常排队或运行，后台仍会补投） | 不开放                           | 后台会继续补投与接管，客户不介入                                  |
| 第 0 代 `FAILED` + 同代次尝试行 `FAILED` 且记录受控失败原因 + 账本行存在   | 开放唯一一次普通重试（0→1）      | 明确的模型分析失败，切换代次后旧执行凭据失效                      |
| 第 0 代 `FAILED` + 同代次尝试行 `FAILED`，但缺少当前代次账本行             | 不开放                           | 缺少可信记录，记录来源无法确认                                    |
| 后台故障（入队失败、进程退出、租约过期、瞬时 Redis/MySQL 故障）            | 不开放同代次恢复                 | 由 BullMQ `attempts` 与 housekeeping 补投恢复，不消耗普通重试机会 |
| 尝试行缺失 / 状态矛盾 / 无受控失败原因、归属冲突、代次越界、未关联工单     | 不开放（暂不可用）               | 数据异常，失败关闭，不自动修复也不入队                            |
| 无账本的开发 Seed `WAITING` 样例                                           | 不开放（中性展示「未发起分析」） | 不是系统故障；`displayState=NOT_STARTED`，不误判排队、不自动入队  |
| 第 1 代再次失败                                                            | 不开放                           | 唯一一次普通重试已用掉，不进入第 2 代                             |

「后台故障且可安全恢复，只恢复当前代次且不扣普通重试机会」本轮**未实现**：现有结构无法原子记录「本代次接受过一次客户恢复」并使其在 Worker 写回与进程重启后仍然有效 —— `repair_request_intake` 只有 `analysis_status` / `analysis_generation`，`intake_analysis_attempt` 唯一键为 `(intake_id, generation_no)`（同代次重跑必须销毁失败证据），账本 `base_async_task_record` 唯一键为 `(queue_name, job_id)` 且同代次 jobId 已被首次投递占用。按产品裁决不新增迁移、不依赖前端防抖/内存计数/可被覆盖的 `reason`，因此该场景全部按上表「不开放」处理。

**删除并发**

- 客户删除（既有「只有本人未接单可删」不变）在同一事务内：软删工单 → 软删原稿（`converted_request_id` 条件更新）→ 条件取消该原稿两个代次仍处 `queued/processing` 的投递账本行。迟到分析被写回侧 `deleted_at` 核验拒绝，已删除报修不会复活；附件生命周期仍归任务 11，不在删除事务内物理清理。

**错误契约（GraphQL 大类）**

- `REPAIR_REQUEST_ANALYSIS_RETRY_UNAVAILABLE` → CONFLICT；`REPAIR_REQUEST_ANALYSIS_RETRY_FAILED` → INTERNAL_SERVER_ERROR；`errorCode` 仅非生产环境暴露，客户端主分支只依赖 GraphQL 大类。
- 首析失败不阻挡接单：工单处理状态与首析状态独立，分析失败不影响厂家接单与既有读路径。

- 幂等：`record_uuid` 唯一索引是最终裁决。
  - 同标识 + 同内容（账号、客户公司、厂家、机型、错误码、故障描述、附件逐项一致）→ 核验原稿与工单状态后返回原报修与原工单，零写入（不登记机型、不重复绑定）；
  - 状态核验（PR #27 复审）：返回成功前在只读事务内按「工单行 → 原稿行」排他锁读核验两侧未删除且双向关联一致（工单 `intake_id` 指向本原稿、原稿 `converted_request_id` 与工单侧一致、归属账号一致）。删除与重放并发时行锁使结论取自单一提交点，不靠非原子一致性读得出虚假成功；
  - 原稿或工单任一侧已删除 → `REPAIR_REQUEST_SUBMISSION_ORIGINAL_DELETED`（CONFLICT，文案「原申请已删除，请重新发起维修申请」）：不返回创建成功、不恢复旧工单、不重新登记机型、不重复投递首析；客户端据此引导用户明确重新发起（换新提交标识），不自动重建工单；
  - 双向关联异常或归属异常 → `REPAIR_REQUEST_CREATION_FAILED` 失败关闭，不返回原记录任何字段；
  - 同标识 + 内容不同 / 异主 / 异公司 → `REPAIR_REQUEST_SUBMISSION_CONFLICT`（CONFLICT），不返回原记录任何字段；
  - 并发同标识：唯一键先提交方胜出，落败事务整体回滚后重读胜出方，按同一套内容与状态核验（含已删除核验）；仍读不到时按 CONFLICT 拒绝，不伪造成功。
- 旧契约兼容：`equipmentModelId` 由必填改为二选一、并新增必填 `recordUuid` / `serviceOrganizationId`。旧客户端载荷（只有 `equipmentModelId` + 文本）会因缺少必填字段在 DTO 结构校验阶段被拒（BAD_USER_INPUT），不存在「不带厂家/标识也能提交」的旁路；无存量调用方需要兼容（本域只有客户表单一个消费者）。

## 写权限矩阵

| 操作                 | CUSTOMER                         | 精确 ENGINEER                            | SUPER_ADMIN（activeRole=SUPER_ADMIN） |
| -------------------- | -------------------------------- | ---------------------------------------- | ------------------------------------- |
| 创建申请             | 允许（仅本人账号）               | 拒绝                                     | 拒绝（不继承客户写入口）              |
| 删除自己的未接单申请 | 允许（软删除，重复删除幂等成功） | 拒绝                                     | 拒绝                                  |
| 接单                 | 拒绝                             | 允许                                     | 拒绝（读继承不等于写继承）            |
| 追加处理回复         | 拒绝                             | 仅实际接单工程师                         | 拒绝                                  |
| 创建内部维修过程     | 拒绝                             | 仅实际接单工程师（可信服务公司一致）     | 拒绝                                  |
| 编辑内部维修过程     | 拒绝                             | 仅过程作者本人、接单人、可信服务公司一致 | 拒绝                                  |
| 结单                 | 拒绝                             | 仅实际接单工程师（可信服务公司一致）     | 拒绝                                  |

写权限规则：仅 roles 含 ENGINEER 且可信 JWT activeRole 精确为 ENGINEER 可接单/回复/记录过程/编辑过程/结单（`assertEngineerWritePermission` 单一实现）；守卫层只做入口粗粒度准入；接单工程师与过程作者取自可信 Session，接单时间、结单时间与过程时间来源由后端生成，客户端不可传入。结单后回复、创建过程与编辑过程均按 `CLOSED_STATE_CONFLICT` 拒绝（处理状态为 `COMPLETED` / `UNRESOLVED` 同样视为已结束）。

写入口在事务锁内核权：目标账号无活跃组织成员或成员关系歧义时按 `FORBIDDEN` 拒绝；工单服务公司必须与原始报修 intake 服务公司一致且等于工程师可信组织，否则按 `NOT_FOUND` 拒绝。intake 缺失、服务公司缺失或两处冲突时失败关闭，不按旧 owner、客户公司、客户端组织或历史接单人兜底。接单仍保留「未删除且未接单」原子条件更新；对象锁顺序统一为「原件 → 工单」，过程保存与原件绑定同一事务，避免反向锁定。

## 并发与删除语义

- 接单为事务内原子条件更新（未删除且未接单才可写入），并发竞争仅一方成功；未命中方按事务内最小状态读取裁决：不存在/已删除 → NOT_FOUND，已接单 → CONFLICT（文案中性，不泄漏接单人身份），两者皆否按系统失败上报。
- 已删除（`deprecated = true`）申请拒绝一切写入（接单、回复、记录/编辑过程、结单）；删除为软删除，列表与详情对所有读入口一致排除。
- 回复为追加写入，只允许目标申请的实际接单工程师；回复目标未接单或已删除时拒绝，已结单后同样拒绝。
- 接单竞争失败方重新读取详情后，可见真实接单工程师昵称与接单时间；前端不进行乐观伪造。

## 回复与客户读取

- 回复按创建时间正序组成时间线；`EngineerResolutionStatus` 为受控枚举（`PENDING` / `RESOLVED`）。
- 回复携带工程师安全展示昵称，不返回工程师账号 ID。
- 客户详情（`myRepairRequest`）可读取自己申请的完整回复时间线与最新处理状态。

## 客户读侧（任务 03 第三段）

**列表（`myRepairRequests`）**：`RepairRequestCustomerPaginatedDTO` 的列表项在公共列表项上追加 `analysisStatus`（`WAITING` / `RUNNING` / `SUCCEEDED` / `FAILED`）与 `analysisGeneration`（0=初次；1=唯一重试）；无原稿关联的旧单两者为 null。首析状态与工单进度（接单/结单/处理事实）是两组独立事实，客户端分开呈现。

**详情（`myRepairRequest`）**：客户入口追加三个仅客户装配的字段（工程师入口恒为 null）：

- `intakeAnalysis`：`{ status, generation, outputText, finishedAt, displayState, retryEligibility { eligible, reason } }`。状态/代次取原稿意图行（认领前 `WAITING` 也可见）；`outputText` 仅当前代次尝试行 `SUCCEEDED` 时返回真实模型输出，失败态不向客户返回正文与受控失败原因细节。
  - `displayState` 由服务端判定：`QUEUED`（已登记投递意图）/ `RUNNING` / `COMPLETED` / `FAILED_RETRYABLE` / `FAILED_NOT_RETRYABLE` / `NOT_STARTED`（从未发起分析，如开发 Seed 样例；中性文案，不是系统故障）/ `UNAVAILABLE`（缺少可信记录或状态矛盾）。客户端只按该字段渲染标签，**不再自行组合 `FAILED` + `generation`**。
  - `retryEligibility.eligible` 为唯一的重试入口判据：只有上表白名单中的「第 0 代明确模型失败」为 `true`；`reason` 为稳定原因码（`OWNER_RETRY_AVAILABLE` / `ANALYSIS_IN_PROGRESS` / `ANALYSIS_SUCCEEDED` / `ANALYSIS_NOT_INITIATED` / `RETRY_ALREADY_USED` / `FAILURE_NOT_CONFIRMED` / `LEDGER_INTENT_MISSING` / `OWNERSHIP_CONFLICT` / `NOT_CONVERTED` / `NO_INTAKE` / `INTAKE_DELETED` / `STATUS_UNKNOWN`），不含内部异常、队列或任务标识。判定需跨模块读取投递账本，故由 usecase 装配（读侧 QueryService 只提供可持久化事实，不下结论）。
- `originalFile`：`{ fileId, originalFilename, mimeType, byteSize }`。仅当原件为「真实绑定到本原稿」的 `BOUND + REPAIR_REQUEST + VALID` 登记行时返回；绑定无效、暂存或归属其他原稿一律为空（不伪造）。
- `serviceOrganization`：`{ id, name }`（选定维修厂家；旧行无服务公司为空）。

客户详情不返回：`processEntries`、结构化维修记录、工程师 `intake` 原始报修视图（含 AI 失败原因细节）与归属类账号 ID。

**越权口径**：客户只能读取本人（`customerAccountId` 来自会话）且未删除的申请；不存在 / 非本人 / 已删除统一防探测拒绝。猜测 ID 的直查、重试（`retryIntakeAnalysis`）、原件下载与删除都按同一口径失败关闭；同公司其他客户与外公司账号无任何读取面。

**客户报修原件下载（任务 11 共用链路）**：`GET /api/stored-files/:fileId` 与 `GET /api/stored-files/:fileId/download` 自本段起对 `CUSTOMER` 准入；用途级授权仍由用例与 `StoredFileQueryService` 裁决——客户仅可读取「真实绑定到本人原稿」（`repair_request_intake.file_id` 实际引用、原稿未删除、本人所有）的 `BOUND + REPAIR_REQUEST + VALID` 原件；暂存原件与内部维修过程原件（`REPAIR_PROCESS`）对客户关闭；授权失败统一 `NOT_FOUND`，不泄露原件存在性。

## 内部维修过程与原件

`createRepairProcessEntry(input)`、`updateRepairProcessEntry(input)` 为历史入口，当前写入合同已冻结：

- 两者仍保留在 schema 中，但任何新增、更新或改绑请求一律返回 `PROCESS_READONLY`（对外 `BAD_USER_INPUT`），不开启事务，不写 `repair_process_entries`，不绑定或替换原件。
- 校验顺序：Session / 角色与写权限仍先裁决；通过后立即按 `PROCESS_READONLY` 拒绝，不再读取或规范化旧入参。
- 旧过程历史继续可读，已授权原件继续按任务 11 的下载入口读取；读取不因写入冻结而失效。
- 新增或修订维修事实统一走 `saveRepairRequestMaintenance`（工程师）或管理员新版明细修订；不得再用旧入口承载新内容。

`saveRepairRequestMaintenance(input)`：`requestId`、`expectedVersion`（必填，`>= 0`）、维修日期/工程师/复位结果/补充说明、可选 `attachment { fileId, uploadContextId }`、`steps[]`、`panels[]`。

- 工程师姓名不接受客户端覆盖：后端始终以接单人可信资料（`real_name`）落库；旧客户端传 `null` 或任意姓名均被忽略；接单人可信资料缺失时返回 `ENGINEER_PROFILE_INCOMPLETE`，不写任何维修字段。
- `expectedVersion` 必须等于当前 `maintenance_version_no`；不一致返回 `PROCESS_VERSION_CONFLICT`，不出保存回执。
- 保存回执在写事务内生成并读回最新维修记录，事务提交成功后才返回给客户端；事务失败时不返回「已保存」，由调用方按失败处理。
- 前端保存成功后如详情刷新失败，应提示「已保存，刷新失败」并仅重试详情读取，不得重发保存 mutation。

原件上传与下载复用任务 11 共用入口，不新增临时 HTTP：

- `POST /api/stored-files`（multipart：`businessType=REPAIR_PROCESS` + `file`；仅 ENGINEER）：返回 VALID + TEMPORARY、`businessId` 为空及服务端 `uploadContextId`，仅表示校验通过，不表示已绑定。
- 过程保存携带的 `fileId` + `uploadContextId` 必须对应同一暂存原件；绑定校验上传者、可信公司、用途、`uploadContextId`、VALID + TEMPORARY、未被其他过程引用，并核对存储对象字节数与 SHA-256；不符合按原件错误拒绝并整体回滚。
- `GET /api/stored-files/:fileId/download`（ENGINEER / SUPER_ADMIN / CUSTOMER，任务 03 第三段起加 CUSTOMER）：暂存读取需 `uploadContextId`，正式绑定读取按业务关联与工单访问权校验（客户仅限本人报修原件，见「客户读侧」）；只返回授权后的文件流，不暴露存储引用。

前端区分「已上传暂存（TEMPORARY）」与「已保存绑定（BOUND）」：只有保存过程成功后，暂存才转为绑定；保存成功与刷新均以正式详情读接口为准，换工单或换账号不复用旧暂存上下文。编辑场景仅对「无原件过程」提供补传入口；已有原件的过程只读展示原件，不提供替换/移除，暂存原件在进入编辑前显式交接或拦截，不会静默丢弃。

## 工程师侧修订历史（只读）

本轮新增两个工程师侧只读查询，供工单详情底部「版本与修订历史」使用；不新增 Mutation、不提供回滚，也不替代管理员修订接口。

`engineerRepairRequestRevisionHistory(requestId: Int!)`：返回最新在前的修订历史列表。

- 权限：Session 必须是该工单的接单人、具备 ENGINEER 角色、属于该工单可信服务厂家，且工单未删除；客户、非接单人、外厂家与可信厂家缺失/冲突统一按 PERMISSION 大类拒绝。
- 仅返回既有管理员修订记录的必要元数据：`revisionNo`、`previousVersion`、`reason`、修订人昵称、修订时间，以及可对比性标记；不返回管理员完整快照。
- `revisionNo` 是管理员修订号，不是 `maintenance_version_no`，也不作为历史快照版本。
- `hasComparableSnapshot` 表示修订前后快照是否都包含 v2 维修数据；`hasVisibleMaintenanceChange` 表示其中是否存在可展示的维修字段/步骤/面板差异。
- `compareUnavailableReason` 为稳定原因码：`NO_COMPARABLE_SNAPSHOT`（缺少可比快照）或 `NO_VISIBLE_MAINTENANCE_CHANGE`（可比但无可见维修差异）；前端据此禁用「对比上一版」并本地化提示。
- 工程师普通保存维修记录不新增修订行；无修订记录时返回空数组。

`engineerRepairRequestRevision(requestId: Int!, revisionNo: Int!)`：返回单个修订的工程师可见详情。

- 与列表复用同一读取授权；跨工单修订 ID 按修订不存在处理（NOT_FOUND），不泄露其他工单。
- `before` / `after` 仅包含维修日期、维修工程师、复位结果、补充说明、排查步骤与故障面板；不包含附件、处理结果、结单信息、`contentMd` 或其他管理员快照字段。
- 历史附件不进入输出，历史查询不会扩大原件下载权限。
- 缺少可比快照或无可见维修差异时，详情仍可查看已有维修快照，并通过 `compareUnavailableReason` 说明不可对比原因；不会用当前工单拼历史，也不会虚构 Seed 历史。

GraphQL schema 由 Nest 自动生成，本文只描述契约，不手改生成产物。

## 结单

`closeRepairRequest(input)`：`requestId`、`handlingResult`、`closureReason`（可空）、`maintenanceVersionNo`（必填 `Int!`，`>= 0`）。

- `maintenanceVersionNo` 必须是用户在结单确认界面看到的维修记录版本；`0` 是合法版本（v0 未保存记录），缺失或非法值在 GraphQL / 输入校验层拒绝，不得省略或按 `0` 兜底。
- 提交版本与当前 `maintenance_version_no` 不一致时返回 `PROCESS_VERSION_CONFLICT`，且不写 `closure_status`、`closed_at`、`handling_*`；前端提示刷新并重新确认，不自动重试。
- `RepairRequestHandlingResult` 五值：`FIXED`、`PART_PURCHASED`、`PROVIDE_PLAN_SELF_EXECUTE`、`INTERRUPTED`、`UNREPAIRABLE`；经固定策略映射为三态 `RepairRequestHandlingStatus`：前三者 → `COMPLETED`，`INTERRUPTED` → `IN_PROGRESS`，`UNREPAIRABLE` → `UNRESOLVED`。客户端不能自报状态。
- `INTERRUPTED` / `UNREPAIRABLE` 必须填写 `closureReason`，其他结果可选。
- 结单写入 `handling_result`、`handling_status`、`handling_recorded_at/by`、`closure_status='CLOSED'`、`closed_at`、`closure_reason`；`INTERRUPTED` 不写 `handling_ended_at`，结单事实由 `closure_status` / `closed_at` 表达。
- 结单与回复互相独立：结单不删除、不改写任何回复，也不依赖回复存在；结单后回复、创建过程与编辑过程统一只读。重复结单或状态已变化返回 CLOSED_STATE_CONFLICT。

## 错误语义

- 读侧：不存在、已删除与越权统一拒绝（PERMISSION 大类），不区分对外表述，防止资源存在性探测。
- 删除：不存在/非本人统一 NOT_FOUND，已接单 CONFLICT。
- 内部过程：旧新增/更新/改绑一律 `PROCESS_READONLY`（对外 BAD_USER_INPUT），且无过程行或附件写入；旧历史读取与已授权原件下载不受影响。
- 原件绑定失败（不存在/无权、已绑定、用途或上下文不匹配、完整性核对失败、工单不可绑定）按任务 11 的领域错误返回，并回滚同事务内的过程写入。经 GraphQL 写入口暴露时的分类：`NOT_FOUND` → NOT_FOUND；`NOT_BINDABLE` / `ALREADY_BOUND` / `WORK_ORDER_NOT_BINDABLE` → CONFLICT（状态冲突不得落为输入错误）；`INVALID_PARAMS` / `PURPOSE_NOT_SUPPORTED` / `UPLOAD_FILE_MISSING` / `UPLOAD_FILE_TOO_LARGE` / `UPLOAD_FILE_TYPE_NOT_ALLOWED` → BAD_USER_INPUT；`UPLOAD_FAILED` / `FILE_NOT_AVAILABLE` / `INTEGRITY_FAILED` / `BIND_FAILED` → INTERNAL_SERVER_ERROR。`errorCode` 仅在非生产环境暴露，客户端主分支只依赖 GraphQL 大类。
- 详细的 GraphQL 错误分类见 `docs/api/graphql-error-contract-current.md`。
