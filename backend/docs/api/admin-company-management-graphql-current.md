<!-- backend/docs/api/admin-company-management-graphql-current.md -->

Purpose: Snapshot the current GraphQL contract of the admin company-archive capability, including the S2「新增公司并开通二级管理员」同事务入口与提交标识幂等语义，以及 S3「绑定查询 / 已绑定列表 / 补发与重置」入口与一次性口令语义。
Read when: You change `organization-admin.resolver.ts`、`admin-organization.dto.ts`、`admin-create-organization.input.ts`、`admin-company-provisioning-result.dto.ts`、`provision-company-with-admin.usecase.ts`、`create-admin-organization.usecase.ts`、`admin-company-admin-binding.dto.ts`、`admin-bound-level-two-admin.dto.ts`、`admin-level-two-credential-result.dto.ts`、`reissue-level-two-credential.usecase.ts`、`reset-level-two-credential.usecase.ts`，或对应的前端消费（`frontend/src/features/admin-company-management/`）。
Do not read when: You only change the database baseline（`docs/database/v13-deployment/`）、管理员用户管理写入口，或二级管理员只读名称名单之外的其他域。
Source of truth: `src/adapters/api/graphql/organization/` 与 `src/usecases/organization/` 为可执行真源；本文只记录当前已落地契约。
Global error contract: 遵循 `docs/api/graphql-error-contract-current.md`；本文相关映射见末尾错误表。

# Admin Company Management GraphQL Contract

## 定位

- **同事务铁律**：`adminCreateOrganization` 与 `adminProvisionCompany` 都在**同一事务**内完成公司档案、二级管理员账号、用户资料、`SUPER_ADMIN` 角色事实、等级 2 与可信成员绑定；任何兼容入口都不得绕过同事务开通。
- **服务端裁定**：编号由服务端生成、强制 `kind=CLIENT` / `isManagedCompany=true`；管理员登录名按稳定公司编号派生（非联系人邮箱），昵称取自公司全称；二者都不接受客户端输入。
- **口令一次性**：新合同 `adminProvisionCompany` 只在**首次成功**时返回 `temporaryPassword`；回放、旧合同入口、日志与异常一律不含口令或哈希。
- **协议层只做映射**：结构校验（DTO）→ 调用 usecase → 输出 DTO；业务异常交由全局过滤器映射。

## 权限矩阵

| 操作 | SUPER_ADMIN（一级） | SUPER_ADMIN（二级） | ENGINEER / CUSTOMER | 匿名 |
| --- | --- | --- | --- | --- |
| `adminOrganizationList` / `adminOrganizationDetail` | 允许 | `FORBIDDEN`（usecase 裁决） | `FORBIDDEN` | `UNAUTHENTICATED` |
| `adminOrganizationNameExists` | 允许 | `FORBIDDEN` | `FORBIDDEN` | `UNAUTHENTICATED` |
| `adminCreateOrganization` | 允许（旧合同，无幂等） | `FORBIDDEN` | `FORBIDDEN` | `UNAUTHENTICATED` |
| `adminProvisionCompany` | 允许（新合同，提交标识幂等） | `FORBIDDEN` | `FORBIDDEN` | `UNAUTHENTICATED` |
| `adminUpdateOrganization` | 允许 | `FORBIDDEN` | `FORBIDDEN` | `UNAUTHENTICATED` |
| `adminOrganizationNameList` | 允许（全范围） | 允许（跨公司只读最小字段） | `FORBIDDEN` | `UNAUTHENTICATED` |
| `adminCompanyAdminBinding` | 允许 | `FORBIDDEN` | `FORBIDDEN` | `UNAUTHENTICATED` |
| `adminBoundLevelTwoAdmins` | 允许 | `FORBIDDEN` | `FORBIDDEN` | `UNAUTHENTICATED` |
| `adminReissueCompanyAdminCredential` | 允许（仅待首次改密目标） | `FORBIDDEN` | `FORBIDDEN` | `UNAUTHENTICATED` |
| `adminResetLevelTwoAdminCredential` | 允许（必填原因） | `FORBIDDEN` | `FORBIDDEN` | `UNAUTHENTICATED` |

守卫层 `@Roles(SUPER_ADMIN)` 只做粗准入；一级/二级判定与可信公司归属由 usecase 按请求期会话事实裁决（`adminLevel` + 可信公司）。

## Operations

| # | 操作 | 类型 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | `adminOrganizationList` | Query | `pagination!`, `keyword?`, `status?`, `isManagedCompany?`, `isServiceProvider?` | `AdminOrganizationPageDTO` | 一级列表，仅 OFFSET |
| 2 | `adminOrganizationDetail` | Query | `organizationId: Int!` | `AdminOrganizationDTO` | 一级详情（含停用） |
| 3 | `adminOrganizationNameExists` | Query | `name: String!`, `excludeOrganizationId: Int` | `Boolean` | 全档案精确同名提示（不阻断写入） |
| 4 | `adminOrganizationNameList` | Query | `pagination!`, `keyword?` | `AdminOrganizationNamePageDTO` | 一、二级共用最小名称名单 |
| 5 | `adminCreateOrganization` | Mutation | `input: AdminCreateOrganizationInput!` | `AdminOrganizationDTO` | **旧合同**：不传 `submissionKey` 时无幂等；返回附带 `provisionedAdmin` |
| 6 | `adminProvisionCompany` | Mutation | `input: AdminCreateOrganizationInput!` | `AdminCompanyProvisioningResultDTO` | **新合同**：`submissionKey` 必填（缺失 `SUBMISSION_KEY_INVALID`）；含提交结果与一次性口令 |
| 7 | `adminUpdateOrganization` | Mutation | `input: AdminUpdateOrganizationInput!` | `AdminOrganizationDTO` | 一级白名单编辑（不含编号与受管归类） |
| 8 | `adminCompanyAdminBinding` | Query | `organizationId: Int!` | `AdminCompanyAdminBindingDTO` | 一级按公司查绑定（无凭据字段） |
| 9 | `adminBoundLevelTwoAdmins` | Query | `pagination!`, `keyword?` | `AdminBoundLevelTwoAdminPageDTO` | 一级专用「已绑定二级管理员」选择器；只列 `BOUND` |
| 10 | `adminReissueCompanyAdminCredential` | Mutation | `input: AdminReissueLevelTwoCredentialInput!` | `AdminLevelTwoCredentialResultDTO` | 补发：仅尚待首次改密的目标 |
| 11 | `adminResetLevelTwoAdminCredential` | Mutation | `input: AdminResetLevelTwoCredentialInput!` | `AdminLevelTwoCredentialResultDTO` | 二级专用重置：已改密目标亦可，原因必填 |

## 输入结构

`AdminCreateOrganizationInput`：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `name` | `String!` ≤200 | 公司全称（trim 后非空） |
| `contactPhone` | `String!` ≤100 | 联系电话（trim 后非空） |
| `shortName` | `String` ≤100 | 公司简称 |
| `contactName` | `String` ≤200 | 联系人姓名 |
| `contactEmail` | `String` ≤254 | 公司邮箱（格式校验） |
| `address` | `String` ≤1000 | 地址 |
| `remark` | `String` ≤2000 | 备注 |
| `status` | `OrganizationStatus` | 缺省 `ACTIVE` |
| `isServiceProvider` | `Boolean` | 缺省 `false` |
| `submissionKey` | `String` ≤36 | 提交标识（UUID）。三态语义见下 |

`submissionKey` 三态（不得合并）：

- **缺省**：旧合同调用方无法提供标识 —— 无幂等路径，不写提交行；重复调用会重复建公司与账号（文档明示边界）。
- **`null`**（仅 `adminProvisionCompany` 会显式传）：新入口缺少标识 —— `SUBMISSION_KEY_INVALID`。
- **字符串**：trim + 小写后校验 UUID，合法即走幂等路径。

## 输出结构

`AdminCompanyProvisioningResultDTO`：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `organization` | `AdminOrganizationDTO!` | 新公司档案（含 `provisionedAdmin`） |
| `provisionedAdmin` | `ProvisionedAdminDTO!` | `{ accountId, loginName, nickname, mustChangePassword }` |
| `submission` | `ProvisioningSubmissionDTO!` | `{ submissionId: Int, replayed: Boolean }` |
| `temporaryPassword` | `String` | **仅首次成功**返回一次；回放恒为 `null` |

`AdminOrganizationDTO.provisionedAdmin`（可空）：仅「新增公司并开通管理员」的写后返回填充，其余读取路径为 `null`；旧合同调用方据此登记新账号归属。

## 提交标识与回放语义

1. 服务端以「用途（`ADMIN_CREATE_ORGANIZATION`）＋ 可信操作者账号 ＋ 提交标识」唯一确定一次提交，并保存**规范化输入指纹**（SHA-256）。
2. 事务内先插入 `PENDING` 提交行（构成唯一键串行点），开通完成后更新为 `COMPLETED` 并写入公司与管理员的安全引用。
3. 同标识同指纹：返回相同公司与账号，`replayed=true`，`temporaryPassword=null`；回放仍复核角色与归属（角色三源收敛 + 等级 2 + 成员关系），失败关闭。
4. 同标识不同指纹：`SUBMISSION_CONFLICT`（前端提示「内容已变更」，不得重试复用）。
5. 不同标识同名：视为新提交，正常新建（不按名称判重）。
6. 提交行**不保存**临时密码或任何哈希；日志与异常只带错误名，不带原始口令。

## S3：绑定查询、已绑定列表与凭据补发/重置

### 边界与权限

- 四个入口均只对**一级管理员**开放；守卫层 `@Roles(SUPER_ADMIN)` 后，usecase 再按请求期查库得到的 `adminLevel` 与可信公司归属裁决，二级管理员一律 `FORBIDDEN`。
- 主线 `adminUsers` 列表的过滤规则不变（只列客户与工程师）；「已绑定二级管理员」走本组窄查询，不扩大用户列表口径。
- 绑定事实的唯一口径是 `evaluateAdminBinding`（与部署盘点共用）；本组查询只读、不写库、不含任何口令/哈希/完整凭据。

### `AdminCompanyAdminBindingDTO`

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `organizationId` / `organizationCode` / `companyName` | `Int!` / `String!` / `String!` | 目标公司 |
| `isManagedCompany` | `Boolean!` | 是否属于一级维护名单；非受管公司直接返回 `UNCONFIGURED`，不进入绑定判定 |
| `companyStatus` | `OrganizationStatus!` | `ACTIVE` / `DISABLED` |
| `status` | `String!` | `BOUND` / `UNCONFIGURED` / `CONFLICT` / `COMPANY_DISABLED` |
| `reason` | `String` | 冲突原因：`MULTIPLE_BINDINGS` / `LEVEL_MISMATCH` / `ROLE_NOT_CONVERGED` / `ROLE_NOT_SUPER_ADMIN` / `MEMBERSHIP_ROLE_MISMATCH` / `MEMBERSHIP_INACTIVE` / `ORGANIZATION_MISMATCH` |
| `boundAccountId` | `Int` | 唯一合法绑定账号；未绑定/冲突为空 |
| `boundLoginNameMasked` | `String` | **唯一**对外登录名形态（首尾各留 1 字符，中间 `***`） |
| `candidateCount` | `Int!` | 候选账号数量（0 表示未配置） |
| `accountDisabled` | `Boolean!` | 绑定账号是否停用（账号或资料任一非 ACTIVE） |

### `AdminBoundLevelTwoAdminPageDTO`

`items: [AdminBoundLevelTwoAdminDTO!]!`、`total`、`page`、`pageSize`。列表项含 `organizationId`、`organizationCode`、`companyName`、`companyStatus`、`accountId`、`loginName`、`nickname`、`accountDisabled`。

- 只收录 `evaluateAdminBinding` 判定为 `BOUND` 的公司；`total` 为关键字过滤后的命中总数，分页在内存完成（受管公司在线盘点上限 500）。
- 关键字大小写不敏感，匹配公司全称/编号/登录名/昵称；缺省表示不过滤。
- 受管公司数量超过盘点上限时显式失败（`WRITE_FAILED` + diagnostic），不静默截断。

### `AdminReissueLevelTwoCredentialInput` / `AdminResetLevelTwoCredentialInput`

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `organizationId` | `Int!` | 目标公司（服务端据此定位唯一绑定） |
| `adminAccountId` | `Int!`（仅重置） | 必须与该公司唯一绑定一致，否则 `ADMIN_BINDING_REQUIRED` |
| `reason` | `String!` ≤200（仅重置） | trim 后非空；写入审计 detail |

### `AdminLevelTwoCredentialResultDTO`

`organizationId`、`adminAccountId`、`loginName`、`nickname`、`mustChangePassword`、`temporaryPassword`。

### 凭据变更语义

1. 事务内锁序固定为 organization → account → membership，锁内重新判定绑定并复核目标 `must_change_password`：补发只允许 `true`，重置两者皆可。
2. 同一事务内写新随机临时密码哈希、置 `must_change_password=true`、递增 `credential_version`，并追加 `REISSUE_LEVEL2_CREDENTIAL` / `RESET_LEVEL2_CREDENTIAL` 审计；审计失败整事务回滚，不返回成功。
3. `temporaryPassword` 只在成功响应中返回一次；审计 detail 只含 `{ reason?, loginNameMasked }`，日志只含 `organizationId` 与 `adminAccountId`，均不含口令、哈希或派生值。
4. 前端不得把 `temporaryPassword` 写入持久化存储或日志；缓存/埋点/错误上报同样禁止采集。
5. 凭据代次递增使旧 access token 立即永久失效（令牌复核门禁 7）；旧 refresh token 当前无消费者，详见遗留事项记录。
6. 临时登录只能走受限会话白名单：`must_change_password=true` 时 GraphQL 与 REST 业务入口统一由 `RolesGuard` / `SessionRestrictionGuard` / `MustChangePasswordGuard` 拒绝，仅放行本人核验、本人改密与登出。

## 错误表（本文相关）

| 错误码 | `extensions.code` | 触发条件 |
| --- | --- | --- |
| `ORGANIZATION_MANAGEMENT_SUBMISSION_KEY_INVALID` | `BAD_USER_INPUT` | 新入口缺标识、非字符串或非 UUID |
| `ORGANIZATION_MANAGEMENT_SUBMISSION_CONFLICT` | `CONFLICT` | 同标识已提交但规范化输入指纹不同 |
| `ORGANIZATION_MANAGEMENT_ADMIN_BINDING_CONFLICT` | `CONFLICT` | 派生登录名与既有账号凭据冲突 |
| `ORGANIZATION_MANAGEMENT_CODE_CONFLICT` | `CONFLICT` | 公司编号或事务内唯一键冲突 |
| `ORGANIZATION_MANAGEMENT_WRITE_FAILED` | `INTERNAL_SERVER_ERROR` | 系统侧读写失败、回读缺失、临时密码策略不可满足 |
| `ORGANIZATION_MANAGEMENT_TARGET_NOT_FOUND` | `NOT_FOUND` | 目标公司不存在（读取/编辑/补发/重置） |
| `ORGANIZATION_MANAGEMENT_ADMIN_BINDING_REQUIRED` | `CONFLICT` | 目标公司非受管、未绑定，或重置的目标账号与唯一绑定不一致 |
| `ORGANIZATION_MANAGEMENT_CREDENTIAL_REISSUE_NOT_ALLOWED` | `CONFLICT` | 绑定冲突、公司停用、账号停用，或对已首次改密的目标补发 |
| `PERMISSION_INSUFFICIENT_PERMISSIONS` | `FORBIDDEN` | 非一级管理员、等级缺失或二级缺少可信公司 |
