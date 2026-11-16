<!-- docs/api/repair-request-current.md -->

Purpose: Snapshot the current repair-request (维修申请) read/write contract for this repository.
Read when: You change repair-request list / detail / accept / response / delete flows, or engineer workbench pages that consume them.
Do not read when: You only change unrelated APIs.
Source of truth: Current resolver/usecase/type code remains executable truth; this file records the stable contract agents must preserve.

# Repair Request Current Contract

## 当前范围

维修申请域覆盖客户提交申请、客户查看/删除自己的申请、工程师四态列表、工程师详情（含他人已接单只读视角）、原子接单、工程师追加处理回复、客户读取回复时间线。

本域不包含附件：维修申请没有附件上传、展示或下载契约；详情页不渲染附件区域，也不提供任何附件占位能力。附件如需建设，另行独立规划完整的上传、申请关联、存储及下载权限，数据库扩展只能新增 Migration，不能修改已接受 baseline。

本域不包含 AI 故障诊断、远程授权、上门维修、维修流程或维护记录。

## GraphQL 入口

当前维修申请相关入口（Resolver：`src/adapters/api/graphql/repair-request/repair-request.resolver.ts`）：

- `createRepairRequest(input: CreateRepairRequestInput): RepairRequestDTO`（仅 CUSTOMER 准入）
- `deleteMyRepairRequest(id: Int!): DeleteMyRepairRequestResultDTO`（仅 CUSTOMER 准入）
- `acceptRepairRequest(id: Int!): RepairRequestDetailDTO`（ENGINEER / SUPER_ADMIN 准入，写权限另行精确裁决）
- `createEngineerResponse(input: CreateEngineerResponseInput): EngineerResponseDTO`（同上）
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

非法 scope 由 usecase 拒绝；scope 以字符串表达，不作为客户端可枚举的数据库状态。

筛选输入 `EngineerRepairRequestFilterInput`：

- `equipmentModelId: Int`（可选，等值筛选）；
- `customerNickname: String`（可选，最长 100；按既有输入归一处理，空白归一为空筛选，LIKE 通配符转义由账号域查询服务完成，不允许通配符逃逸）。

筛选在数据库侧、分页计数（total）之前完成；不支持先分页后过滤。

排序固定为 `createdAt DESC, id DESC`（同创建时间按主键倒序稳定排序）；仅支持 OFFSET 分页（usecase 强制）。所有 scope 固定包含 `deprecated = false`。

列表项 DTO（`RepairRequestEngineerListItemDTO`）返回：`id`、`requestNo`、`createdAt`、设备型号（`equipmentModel`）、`errorCode`、`isAccepted`、`acceptedAt`、`latestResolutionStatus`，以及富集字段：`customerNickname`（非空）、`customerCompanyName`（可空）、`acceptanceViewStatus`、`acceptedEngineerNickname`（可空）。

客户与接单工程师展示资料由 usecase 批量读取账号域安全资料，禁止逐行 N+1；归属类账号 ID（customerAccountId / acceptedByEngineerAccountId）只在内部装配使用，不进入任何对外 DTO。

## 详情与视角状态

工程师详情对任意未删除申请可读（含他人已接单）。`RepairRequestAcceptanceViewStatus` 为当前会话观看单条申请的事实分类，非数据库枚举，客户端不可传入：

- `AVAILABLE`：未接单（不代表可接单能力，能力由写用例裁决）；
- `MINE`：接单工程师为当前会话账号；
- `TAKEN_BY_OTHER`：已被其他账号接单（SUPER_ADMIN 视角下已接单一律归此类）。

详情 DTO 富集字段（客户入口为 null，工程师入口非空）：`customerNickname`、`customerCompanyName`、`acceptanceViewStatus`、`acceptedEngineerNickname`。客户详情不返回上述富集字段值。

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

| 操作 | CUSTOMER | 精确 ENGINEER | SUPER_ADMIN（activeRole=SUPER_ADMIN） |
| --- | --- | --- | --- |
| 创建申请 | 允许（仅本人账号） | 拒绝 | 拒绝（不继承客户写入口） |
| 删除自己的未接单申请 | 允许（软删除，重复删除幂等成功） | 拒绝 | 拒绝 |
| 接单 | 拒绝 | 允许 | 拒绝（读继承不等于写继承） |
| 追加处理回复 | 拒绝 | 仅实际接单工程师 | 拒绝 |

写权限规则：仅 roles 含 ENGINEER 且可信 JWT activeRole 精确为 ENGINEER 可接单/回复（`assertEngineerWritePermission` 单一实现）；守卫层只做入口粗粒度准入；接单工程师取自可信 Session、接单时间由后端生成，客户端不可传入。

## 并发与删除语义

- 接单为事务内原子条件更新（未删除且未接单才可写入），并发竞争仅一方成功；未命中方按事务内最小状态读取裁决：不存在/已删除 → NOT_FOUND，已接单 → CONFLICT（文案中性，不泄漏接单人身份），两者皆否按系统失败上报。
- 已删除（`deprecated = true`）申请拒绝一切写入（接单、回复）；删除为软删除，列表与详情对所有读入口一致排除。
- 回复为追加写入，只允许目标申请的实际接单工程师；回复目标未接单或已删除时拒绝。
- 接单竞争失败方重新读取详情后，可见真实接单工程师昵称与接单时间；前端不进行乐观伪造。

## 回复与客户读取

- 回复按创建时间正序组成时间线；`EngineerResolutionStatus` 为受控枚举（`PENDING` / `RESOLVED`）。
- 回复携带工程师安全展示昵称，不返回工程师账号 ID。
- 客户详情（`myRepairRequest`）可读取自己申请的完整回复时间线与最新处理状态。

## 错误语义

- 读侧：不存在、已删除与越权统一拒绝（PERMISSION 大类），不区分对外表述，防止资源存在性探测。
- 删除：不存在/非本人统一 NOT_FOUND，已接单 CONFLICT。
- 详细的 GraphQL 错误分类见 `docs/api/graphql-error-contract-current.md`。
