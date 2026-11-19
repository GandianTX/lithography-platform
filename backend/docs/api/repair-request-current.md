<!-- docs/api/repair-request-current.md -->

Purpose: Snapshot the current repair-request (维修申请) read/write contract for this repository.
Read when: You change repair-request list / detail / accept / response / delete flows, or engineer workbench pages that consume them.
Do not read when: You only change unrelated APIs.
Source of truth: Current resolver/usecase/type code remains executable truth; this file records the stable contract agents must preserve.

# Repair Request Current Contract

## 当前范围

维修申请域覆盖客户提交申请、客户查看/删除自己的申请、工程师四态列表、工程师详情（含他人已接单只读视角）、原子接单、工程师追加处理回复、客户读取回复时间线，以及工程师内部维修过程记录/编辑、原件绑定、工单结单（任务 04 第一轮）。

内部维修过程与其原件的可见范围仅限接单工程师本人：详情只有在解析出的视角为 `ENGINEER` 且当前账号是该申请接单人时才装配 `processEntries`；`SUPER_ADMIN` 视角与客户详情不返回 `processEntries` 与任何原件字段，也不提供客户侧附件下载入口。原件上传/绑定/下载复用任务 11 的共用业务原件能力（`/api/stored-files`），本域不新增临时 HTTP 入口。

本域不包含 AI 故障诊断、远程授权、上门维修、客户侧附件展示。管理员查询与受控修订由 `docs/api/admin-document-database-graphql-current.md` 的工单切片承载；管理员不进入本域工程师写入口（不代接单、不新建过程、不代写总结），修订只订正已提交事实。

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
- `myRepairRequests(pagination: PaginationArgs!): RepairRequestPaginatedDTO`（CUSTOMER / SUPER_ADMIN 准入）
- `myRepairRequest(id: Int!): RepairRequestDetailDTO`（CUSTOMER / SUPER_ADMIN 准入）
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

任务 08 提供候选查询，查询本身不建立关联。当前 `createRepairRequest` 不接收维修服务公司 ID。任务 03 接入报修提交时，须在写入事务内按 `status = ACTIVE` 且 `is_service_provider = true` 重新校验所选公司资格。

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

## 内部维修过程与原件

`createRepairProcessEntry(input)`：`requestId`、`operationText`（必填，去首尾空白后非空）、`testResult`（可空，空白归一为 null）、`occurredAt`（可空）、`file`（可空，`{ fileId, uploadContextId }` 必须同时提供且为合法 UUID）。

- 作者只取自 Session；未传 `occurredAt` 时使用服务端时间且 `timeSource = SERVER`，否则 `timeSource = MANUAL`。
- `occurredAt` 只接受完整的日期时间字符串（可带时区偏移）；纯日期（`YYYY-MM-DD`）、epoch 数字、`Date` 实例与非法格式均按输入错误拒绝。持久化字段沿用既有 `datetime` 口径（不带时区后缀的字符串按服务端本地时间解释，带偏移的字符串按其瞬时值写入），本轮不改变 Entity / Migration 的时间语义。
- 目标裁决：不存在/已删除/跨公司 → NOT_FOUND；未接单或非本人 → NOT_ACCEPTED；已结单或处理已终结 → CLOSED_STATE_CONFLICT。
- 携带原件时，在同一调用方事务内先执行任务 11 绑定（锁顺序：原件行锁 → 工单行锁），再插入引用该 `fileId` 的过程行；绑定或过程写入任一失败整体回滚，不产生「已绑定但无过程」或「有过程但未绑定」。未携带原件时只锁工单行。

`updateRepairProcessEntry(input)`：`requestId`、`entryId`、`expectedVersion`、`operationText`、`testResult`、`occurredAt`、`file`（可空，`{ fileId, uploadContextId }`）。

- 仅过程作者本人、接单人、同组织可编辑；非作者按 PROCESS_NOT_FOUND 处理，不泄露他人过程。
- `expectedVersion` 必须等于当前 `versionNo`，条件更新 `(id, request_id, author_account_id, version_no)` 命中 0 行即 PROCESS_VERSION_CONFLICT；客户端应刷新详情后重试，后端不做自动合并。
- 仅支持「当前过程尚无原件时补传一份原件」：传入 `file` 时，在同一调用方事务内先执行任务 11 绑定（锁顺序：原件行锁 → 工单行锁），再锁过程行并按 `(version_no, file_id IS NULL)` 条件更新，成功后过程关联该 `fileId` 且 `versionNo + 1`；绑定或过程更新任一失败整体回滚，落败方的暂存原件不会被消耗。
- 当前过程已有原件时传入 `file` 返回 PROCESS_ORIGINAL_IMMUTABLE（对外 CONFLICT），明确拒绝且不覆盖原文件；替换、移除原件以及追加第二份原件均不在本期范围，追加请新建过程记录。
- 省略 `file` 表示保持原绑定不变，条件更新不触碰 `file_id`；明确传 `file: null` 不被解释为移除原件，按输入错误（STORED_FILE_INVALID_PARAMS）拒绝。
- 编辑时省略 `occurredAt`（或传空白）等价于重置为服务端当前时间并写 `timeSource = SERVER`，不会保留旧事件时间；`occurredAt` 校验规则与创建一致。
- 已结单或处理已终结时只读（CLOSED_STATE_CONFLICT）。

原件上传与下载复用任务 11 共用入口，不新增临时 HTTP：

- `POST /api/stored-files`（multipart：`businessType=REPAIR_PROCESS` + `file`；仅 ENGINEER）：返回 VALID + TEMPORARY、`businessId` 为空及服务端 `uploadContextId`，仅表示校验通过，不表示已绑定。
- 过程保存携带的 `fileId` + `uploadContextId` 必须对应同一暂存原件；绑定校验上传者、可信公司、用途、`uploadContextId`、VALID + TEMPORARY、未被其他过程引用，并核对存储对象字节数与 SHA-256；不符合按原件错误拒绝并整体回滚。
- `GET /api/stored-files/:fileId/download`（ENGINEER / SUPER_ADMIN）：暂存读取需 `uploadContextId`，正式绑定读取按业务关联与工单访问权校验；只返回授权后的文件流，不暴露存储引用。

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

`closeRepairRequest(input)`：`requestId`、`handlingResult`、`closureReason`（可空）。

- `RepairRequestHandlingResult` 五值：`FIXED`、`PART_PURCHASED`、`PROVIDE_PLAN_SELF_EXECUTE`、`INTERRUPTED`、`UNREPAIRABLE`；经固定策略映射为三态 `RepairRequestHandlingStatus`：前三者 → `COMPLETED`，`INTERRUPTED` → `IN_PROGRESS`，`UNREPAIRABLE` → `UNRESOLVED`。客户端不能自报状态。
- `INTERRUPTED` / `UNREPAIRABLE` 必须填写 `closureReason`，其他结果可选。
- 结单写入 `handling_result`、`handling_status`、`handling_recorded_at/by`、`closure_status='CLOSED'`、`closed_at`、`closure_reason`；`INTERRUPTED` 不写 `handling_ended_at`，结单事实由 `closure_status` / `closed_at` 表达。
- 结单与回复互相独立：结单不删除、不改写任何回复，也不依赖回复存在；结单后回复、创建过程与编辑过程统一只读。重复结单或状态已变化返回 CLOSED_STATE_CONFLICT。

## 错误语义

- 读侧：不存在、已删除与越权统一拒绝（PERMISSION 大类），不区分对外表述，防止资源存在性探测。
- 删除：不存在/非本人统一 NOT_FOUND，已接单 CONFLICT。
- 内部过程：非作者编辑 → NOT_FOUND；版本不一致 → CONFLICT；已结单写入 → CONFLICT；写失败兜底 → INTERNAL_SERVER_ERROR。
- 原件绑定失败（不存在/无权、已绑定、用途或上下文不匹配、完整性核对失败、工单不可绑定）按任务 11 的领域错误返回，并回滚同事务内的过程写入。经 GraphQL 写入口暴露时的分类：`NOT_FOUND` → NOT_FOUND；`NOT_BINDABLE` / `ALREADY_BOUND` / `WORK_ORDER_NOT_BINDABLE` → CONFLICT（状态冲突不得落为输入错误）；`INVALID_PARAMS` / `PURPOSE_NOT_SUPPORTED` / `UPLOAD_FILE_MISSING` / `UPLOAD_FILE_TOO_LARGE` / `UPLOAD_FILE_TYPE_NOT_ALLOWED` → BAD_USER_INPUT；`UPLOAD_FAILED` / `FILE_NOT_AVAILABLE` / `INTEGRITY_FAILED` / `BIND_FAILED` → INTERNAL_SERVER_ERROR。`errorCode` 仅在非生产环境暴露，客户端主分支只依赖 GraphQL 大类。
- 详细的 GraphQL 错误分类见 `docs/api/graphql-error-contract-current.md`。
