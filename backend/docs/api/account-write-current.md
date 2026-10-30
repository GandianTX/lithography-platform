<!-- docs/api/account-write-current.md -->

Purpose: Snapshot the current account / userInfo write and read contract for this repository.
Read when: You change registration, account query, userInfo updates, public password reset, admin user management (list / create / profile / status / password reset), or self-service account settings (my settings / change password) flows.
Do not read when: You only change unrelated APIs.
Source of truth: Current resolver/usecase/type code remains executable truth; this file records the stable contract agents must preserve.

# Account / UserInfo Current Contract

## 当前范围

本项目账号语义已经对齐为项目身份层：

- `SUPER_ADMIN`
- `ENGINEER`
- `CUSTOMER`

`SUPER_ADMIN` 继承 `ENGINEER` 与 `CUSTOMER` 的访问能力，后两者互不继承。当前账号能力负责注册、登录、资料读取、资料更新和角色访问摘要，不扩展岗位或组织管理域。

## GraphQL 入口

当前通用账号相关入口：

- `register(input: RegisterInput): RegisterResult`
- `thirdPartyRegister(input: ThirdPartyRegisterInput): RegisterResult`
- `registrationOrganizations: [RegistrationOrganizationDTO!]!`
- `myEngineerRegistrationStatus(input: EngineerRegistrationCredentialInput!, pagination: PaginationArgs!): EngineerRegistrationStatusDTO`
- `resubmitEngineerRegistration(input: ResubmitEngineerRegistrationInput!): ResubmitEngineerRegistrationResultDTO`
- `login(input: AuthLoginInput): LoginResult`
- `account(args: AccountArgs): UserAccountDTO`
- `userInfo(accountId: Int!): UserInfoDTO`
- `basicUserInfo(accountId: Int!): BasicUserInfoDTO`
- `updateUserInfo(input: UpdateUserInfoInput): UpdateUserInfoResult`
- `resetPassword(input: ResetPasswordInput): ResetPasswordResult`

当前管理员用户管理入口（全部要求可信 SUPER_ADMIN 会话，详见「管理员用户管理」）：

- `adminUsers(pagination: PaginationArgs!, keyword: String, role: IdentityTypeEnum, status: AccountStatus): AdminUserListPageDTO`
- `adminCreateUser(input: AdminCreateUserInput): AdminUserDTO`
- `adminUpdateUserProfile(input: AdminUpdateUserProfileInput): AdminUserDTO`
- `adminSetUserStatus(input: AdminSetUserStatusInput): AdminUserDTO`
- `adminResetUserPassword(input: AdminResetUserPasswordInput): AdminResetUserPasswordResultDTO`

当前组织管理员工程师注册审核入口（全部要求可信 SUPER_ADMIN 会话；组织范围由服务端按可信成员关系解析，不接受客户端自报 organizationId）：

- `adminEngineerRegistrations(pagination: PaginationArgs!, status: EngineerRegistrationApplicationStatus): AdminEngineerRegistrationPageDTO`
- `adminEngineerRegistrationDetail(applicationId: Int!): AdminEngineerRegistrationItemDTO`
- `reviewEngineerRegistration(input: ReviewEngineerRegistrationInput!): AdminEngineerRegistrationItemDTO`

审核条目的 `applicant` 复用 account 域 `AdminUserDTO` 的字段集（账号 ID、登录名/邮箱、昵称、角色与状态等公开资料），不额外定义第二套账号 DTO；字段明细见 `adminUsers` 的返回类型说明。

当前自助账号设置入口（仅要求已登录会话，目标账号只能来自 Session，详见「自助账号设置」）：

- `myAccountSettings: MyAccountSettingsDTO`
- `updateMyAccountSettings(input: UpdateMyAccountSettingsInput): UpdateMyAccountSettingsResultDTO`
- `changeMyPassword(input: ChangeMyPasswordInput): ChangeMyPasswordResultDTO`

`updateAccessGroup` 已下线：不再是公开 GraphQL 入口，也不存在任何 adapter 调用入口。

`adminChangeUserRole` 已下线：不再是公开 GraphQL 入口，也不存在任何 adapter 调用入口。普通用户角色只在管理员创建账号时单选一次写入，创建后角色只读，当前不存在任何公开角色修改 Mutation。

`login` 详细契约见 `docs/api/auth-session-current.md`。

## 注册

`register` 当前使用 `RegisterWithEmailUsecase`。

输入字段包括：

- `loginName`
- `loginEmail`
- `loginPassword`
- `nickname`
- `type`
- `organizationId`（必填：客户与工程师都必须选择有效组织）
- `applicationNote`（可选：仅工程师待审申请使用）
- `inviteToken`

`type` 默认是 `CUSTOMER`，公开注册允许 `CUSTOMER` 和 `ENGINEER`；`SUPER_ADMIN` 仍只由受控管理流程或 Seed 创建，不开放管理员自助注册。

**破坏性变更**：`register` 与 `thirdPartyRegister` 的 `organizationId` 现为必填（非空）。旧客户端若不传该字段会收到 `BAD_USER_INPUT`，前端与第三方客户端必须与本后端同批次切换。

开通结果按类型分流，两类都必须先选择一个有效组织（`organizationId` 在写入事务内复核为 ACTIVE，客户端自报值不作为最终凭证）：

- `CUSTOMER`：账号与资料在同一创建事务内写为 `ACTIVE / ACTIVE`，并绑定所选组织为 `CUSTOMER` 成员；注册返回后账号立即可用，`registrationStatus = REGISTERED`、`applicationId = null`；
- `ENGINEER`：账号与资料保持 `PENDING / PENDING`，不建立有效成员关系、不签发登录令牌，只在同一事务内落一份 `PENDING` 待审申请（`applicationNote` 可选）；返回 `registrationStatus = PENDING_REVIEW` 和非空 `applicationId`。所选组织管理员审核通过后，账号才开通。

`registrationOrganizations` 是公开只读查询，只返回 `ACTIVE` 组织的 `id` / `name`；客户端提交的 `organizationId` 仍由注册/重提事务复核有效性。

`resubmitEngineerRegistration` 用于被拒绝后的重提：输入为本人凭据证明（`accountIdentifier` + `password`）、新的 `organizationId` 与可选 `applicationNote`；只新增一份 `PENDING` 申请，**不覆盖**历史申请行，拒绝记录与审核意见永久保留。重提前置条件为：账号三源角色收敛为 `ENGINEER`、双状态仍为 `PENDING / PENDING`、无有效组织成员关系、最新申请为 `REJECTED`。已有待审申请返回 `PENDING_APPLICATION_EXISTS`。

`myEngineerRegistrationStatus` 供待审申请人查看本人最新申请与历史分页。待审账号没有登录态，因此该入口**不使用 JWT**，只复用密码凭据验证证明「本人」，不签发令牌、不放行登录；凭据不匹配统一返回 `CREDENTIAL_MISMATCH`，不区分账号不存在与密码错误。分页只接受 OFFSET。

该入口是 **Mutation** 而非 Query：凭据必须随 POST 请求体提交，避免密码进入查询串、网关/APM 访问日志与被缓存/重放的 GET 语义。它不产生任何业务状态变更，客户端不应据此推断账号已开通。

`reviewEngineerRegistration` 由所选组织的管理员执行一次性终态决策：

- 权限：准确 SUPER_ADMIN 会话 + 可信成员关系的 `memberRole = SUPER_ADMIN`；申请不属于该组织一律按 NOT_FOUND；
- `APPROVE`：建立 `ENGINEER` 成员关系、账号 `ACTIVE`、资料 `ACTIVE`、申请 `APPROVED` 在同一事务内生效；
- `REJECT`：只写 `REJECTED` 与必填审核意见，账号保持 `PENDING / PENDING`，可凭本人凭据重提；
- 重复/并发决策命中 0 行返回 CONFLICT，不覆盖既有终态。

`thirdPartyRegister` 当前走第三方注册 usecase，属于通用第三方账号能力，不代表具体业务域身份；它同样要求 `organizationId`，只创建并绑定 `CUSTOMER` 成员，不提供工程师绕过审核的入口。

公开注册成功语义：客户注册（`RegisterWithEmailUsecase` 的 CUSTOMER 分支）与 `thirdPartyRegister`（`WeappRegisterUsecase`）返回成功时，必须在**同一个创建事务内**显式写入 `account.status = ACTIVE`、`userInfo.userState = ACTIVE` 与所选组织的 `CUSTOMER` 成员关系（同提交同回滚，任一步失败不得返回成功，也不做事务外补救写）。工程师注册只在同一事务内创建 `PENDING / PENDING` 账号与待审申请，不建成员关系；`UserInfoEntity.user_state` 列与数据库默认值 `PENDING` 保留原样，不新增 Migration；所有新建 UserInfo 的生产入口必须显式提供 `userState`，不依赖 Entity 默认值。

管理员代建入口（`adminCreateUser`）不受本改动影响：继续由可信 SUPER_ADMIN 会话按可信组织解析绑定，创建固定 `ACTIVE`，保留既有凭据、角色与密码策略。

## 账号读取

`account` 是受保护 query：

- 通过 `JwtAuthGuard` 鉴权。
- 使用 `mapJwtToUsecaseSession()` 构造 usecase session。
- 调用 `GetAccountByIdUsecase`。
- 返回 `UserAccountDTO`，不返回 ORM Entity。

当前输出包括：

- `id`
- `loginName`
- `loginEmail`
- `status`
- `identityHint`
- `recentLoginHistory`
- `createdAt`
- `updatedAt`

## UserInfo 读取

`userInfo` 和 `basicUserInfo` 都是受保护 query：

- Resolver 只接收 GraphQL 参数与当前用户。
- 读取与可见性规则由 `GetVisibleUserInfoUsecase` 编排。
- 完整视图返回 `UserInfoDTO`。
- 基础视图返回 `BasicUserInfoDTO`。
- DTO 映射在 adapter 内完成，不能把 GraphQL DTO 下沉到 usecase 或 modules(service)。

## UserInfo 更新

`updateUserInfo` 是受保护 mutation：

- 不传 `accountId` 时默认更新当前登录账户。
- 可更新昵称、性别、生日、头像、邮箱、签名、地址、电话、标签、地理信息等资料字段。
- `userState` 不属于本 mutation 的可更新字段：启用/停用由管理员入口 `adminSetUserStatus` 承担，由其同事务同步 `account.status` 与 `userInfo.userState`。
- `identityHint` 不属于本 mutation 输入：普通用户角色只在管理员创建账号时单选一次写入，创建后角色只读，无公开角色修改 Mutation。
- Usecase 负责权限、可见性和写语义。
- Resolver 只做输入 shape 到 usecase 参数的映射。

## 角色修改入口（已下线）

`updateAccessGroup` 与 `adminChangeUserRole` 均不在当前 Schema（Mutation root 不暴露两者），当前已无任何 GraphQL / adapter 调用入口：

- Resolver 未接线，`src/schema.graphql` 不暴露这两个 mutation，并有下线验证 E2E 守护（`update-access-group.e2e-spec.ts`）。
- `UpdateUserInfoInput` 不包含 `identityHint`。
- 普通用户角色只在管理员创建账号时单选一次写入：`adminCreateUser` 在同一创建事务内同步三处角色字段（见「写入语义」）；创建后角色只读，仅作列表展示与筛选。
- `UpdateAccessGroupInput` / `UpdateAccessGroupResult` 与 `UpdateAccessGroupUsecase` 仅作为遗留内部代码保留：无任何 adapter 引用，`UpdateAccessGroupUsecase` 仍是 `account-usecases.module.ts` 的 provider / export，但它是一套独立的既有实现（自持权限判定、输入规范化、事务边界与写入逻辑）。这些残留的清理属独立 cleanup 事项，不在本 current 契约内。

## 管理员用户管理

五个入口全部在 `AdminUserResolver`（adminUsers + 四个写 mutation），按 `docs/api/adapters.rules.md` 只做「协议输入映射 + Usecase 调用 + View → DTO 薄映射」；业务规则、事务、目标保护与白名单全部归 Usecase，DomainError 不在 Resolver 捕获，直接上抛进全局 GraphQL exception filter。

### 权限矩阵

| operation                | 会话准入         | 目标约束                                                          | 可写 / 可筛选值域                                                        |
| ------------------------ | ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `adminUsers`             | 可信 SUPER_ADMIN | 无写目标                                                          | `role` 筛选含 SUPER_ADMIN（只读展示）；`status` 筛选仅 ACTIVE / INACTIVE |
| `adminCreateUser`        | 可信 SUPER_ADMIN | 新建账号                                                          | `role` 仅 ENGINEER / CUSTOMER；创建固定 `ACTIVE`                         |
| `adminUpdateUserProfile` | 可信 SUPER_ADMIN | 现有 SUPER_ADMIN 目标只读                                         | `nickname` / `companyName` / `phone` / `contactEmail`                    |
| `adminSetUserStatus`     | 可信 SUPER_ADMIN | 现有 SUPER_ADMIN 目标只读，含「不能停用自己」                     | `status` 仅 ACTIVE / INACTIVE                                            |
| `adminResetUserPassword` | 可信 SUPER_ADMIN | 现有 SUPER_ADMIN 目标只读，且双字段状态须一致为 ACTIVE / INACTIVE | `newPassword` 明文                                                       |

### 会话准入（两层）

- 粗粒度：`JwtAuthGuard` + `RolesGuard` + `@Roles(SUPER_ADMIN)`，按 accessGroup 做入口准入。
- 精确：每个 Usecase 的**第一步**执行 `assertAdminUserManagementPermission()`（全仓唯一实现），先于任何输入规范化与数据库访问，要求 `session.roles` 含 `SUPER_ADMIN` **且** `session.activeRole` 精确等于 `SUPER_ADMIN`；`activeRole` 缺失、与 `roles` 矛盾或为非管理员角色一律拒绝（失败关闭）。
- 该断言直接精确匹配已大写归一的 `UsecaseSession.roles`，不使用按角色继承展开的 `hasRole`，因此 ENGINEER / CUSTOMER 即使直接调用管理员 operation 也在此被拒。
- Guard 不能替代 Usecase 的业务授权；前端隐藏入口也不是授权依据。
- 拒绝错误的 `details` 刻意留空，不携带 accessGroup / 角色列表等身份事实（全局过滤器会把 `details` 原样写入 `extensions.details`）；动作文案由 `actionLabel` 拼进 `message`，因此拒绝响应与日志已能区分是哪个动作被拒。

### 目标保护与角色值域

- `assertWritableAdminUserTargetRole()` 依**锁内**数据库事实拒绝任意 SUPER_ADMIN 目标：不允许通过本功能创建、删除、降级、编辑资料、修改状态或重置 SUPER_ADMIN 密码。由于所有 SUPER_ADMIN 均只读，「管理员操作自己」也一并被拒（管理员自己的账号必然是 SUPER_ADMIN）；`adminSetUserStatus` 对「停用自己」另在任何数据库访问之前显式先行拒绝。
- 第一版禁止创建 SUPER_ADMIN：`normalizeAdminUserWritableRole()` 只接受 `ADMIN_USER_WRITABLE_ROLES = [ENGINEER, CUSTOMER]`；`ADMIN_USER_LIST_ROLE_FILTERS` 额外允许 SUPER_ADMIN，但只用于列表只读展示。读筛选值域与写入值域刻意各自持有两份数组，任何一侧演进不得静默改变另一侧。
- 普通账号是**单一**业务角色：前端只提交一个业务角色，不分别提交或拼装 `identity_hint` / `access_group` / `meta_digest`。
- 目标不存在收敛为 `ADMIN_USER_ERROR.TARGET_NOT_FOUND`（对外 `NOT_FOUND`），**不得**沿用 `lockByIdForUpdate()` 原有的 `ACCOUNT_ERROR.ACCOUNT_NOT_FOUND`——该码值与 `AUTH_ERROR.ACCOUNT_NOT_FOUND` 相同，会被映射为 `UNAUTHENTICATED`，违反「not-found 不得塌缩为 UNAUTHENTICATED」的错误契约。
- 三源角色收敛不出唯一角色（`ROLE_DATA_INCONSISTENT`）或资料行缺失（`READ_FAILED`）时，读与写（含密码重置）一律失败关闭：整次查询失败，不返回部分列表、不排除异常行、不兜底、不静默修复历史数据。密码重置同样受此约束是刻意的：收敛不出单一角色就无法安全确认目标「不是 SUPER_ADMIN」，放行等于允许对身份不明的账号覆盖登录凭据。

### 写入语义

- `adminCreateUser`：登录名 / 登录邮箱至少提供一个；同一事务内写 `base_user_account.identity_hint = role`、`base_user_info.access_group = [role]`、`base_user_info.meta_digest = [role]` 与 `user_state = ACTIVE`，账号 `status` 固定 `ACTIVE`；凭据唯一索引冲突对外 `CONFLICT`，不泄露驱动错误与索引名。
- `adminUpdateUserProfile`：昵称不传 = 不修改、传 string = 修改，`null` / 空字符串 / 纯空白一律拒绝；`companyName` / `phone` / `contactEmail` 三态——不传 = 不修改，`null` = 清空。不得经由资料编辑改写角色事实（`identityHint`）；角色在创建后只读，不存在公开角色修改入口。本用例已复用 `loadWritableAdminUserTarget()` 先锁 account 行并按锁内三源角色事实保护目标，随后才读写 userInfo。
- `adminSetUserStatus`：同一事务内双字段同步——`base_user_account.status`（`updateAccount()`）与 `base_user_info.user_state`（`updateUserInfoFields()`）写为同值，启用即两处同为 `ACTIVE`、停用即两处同为 `INACTIVE`。`AccountStatus` 与 `UserState` 是两个不同枚举类型（成员字符串当前逐字相同），映射刻意显式书写而非断言复用。转换矩阵只允许两行：当前双字段同为 `ACTIVE` → 改 `INACTIVE`；当前双字段同为 `INACTIVE` → 改 `ACTIVE`。同状态请求幂等成功，不执行任何 UPDATE、不 bump 任何时间列。其余全部失败关闭（当前值为 `PENDING` / `SUSPENDED` / `BANNED` / `DELETED` 或任何无法识别的值、双字段不一致、当前状态缺失），不自动修复、不选任一字段为真源、不继续执行双字段 UPDATE；不做硬删除。
- `adminResetUserPassword`：独立的管理员链路，不接触任何 verification token / 验证记录 / token 预读能力，不复用其 usecase、错误码或 GraphQL 流程；两条链路只在密码**哈希与策略原语**上汇合（`PasswordPolicyService` / `hashPasswordWithTimestamp()` / `updateAccountPasswordHash()`，全仓单一实现），流程编排零共享。目标双字段状态裁决在哈希生成与任何写入之前执行，只允许双字段一致的 `ACTIVE` / `INACTIVE`；本用例不写状态字段，`INACTIVE` 账号重置后仍是 `INACTIVE`（不存在顺带启用），拒绝路径不操作 Token / Session。结果只返回 `accountId` / `isUpdated`（恒为 `true`）/ 固定 `notice`，不含新密码、旧密码、哈希或任何密码派生物。
- 密码策略：管理员创建的初始密码、管理员重置的新密码与自助修改密码的新密码共用 `assertAdminUserPasswordPolicy()`（内部复用全仓单一 `PasswordPolicyService`），失败抛 `INPUT_NORMALIZE_ERROR.INVALID_TEXT`（对外 `BAD_USER_INPUT`），**不使用** `AUTH_ERROR.INVALID_PASSWORD`——后者映射为 `UNAUTHENTICATED`，会让「管理员填了弱密码」被前端误判为会话失效并清理 Session 跳转登录页。

### 事务边界

- 事务边界由 Usecase 经 `TransactionRunner` 持有，同一个 `transactionContext` 显式传给全部下游；Resolver 与 modules(service) 不持有事务。
- 写用例执行顺序固定：精确权限断言 → 场景输入规范化（含密码策略，先于任何数据库访问，输入错误不应在占用行锁之后才暴露）→ 事务内 `lockByIdForUpdate()` 悲观行锁 → 锁内读取收敛 View → 目标角色保护 → 业务裁决 → 写入 → 回读 View 并校验后置条件。
- 先取 `base_user_account` 的行锁，各用例随后才写 `base_user_info`；新增管理员写用例必须沿用本顺序，不得再次分叉。锁串行化针对同一目标账号的并发管理写，目标保护基于锁内事实而非锁前过期快照。
- 事务内阶段标记（如 `LOCK_TARGET` / `WRITE_PROFILE` / `WRITE_PASSWORD_HASH`）只用于服务端日志定位，不出现在任何对外响应中。
- 失败日志脱敏：非领域异常只记错误类型名与驱动错误码；绑定参数嵌密码派生哈希的阶段（`WRITE_PASSWORD_HASH` / `UPDATE_PASSWORD_HASH`）必须抑制 `message`，抑制清单以阶段联合类型约束，避免阶段重命名时抑制静默失效。预期业务结果（目标不存在、权限拒绝、状态转换不允许、重置目标状态不允许、凭据冲突）记 warn 而非 error。

### 主要 GraphQL 错误类别

| 场景                                | DomainError 码                                              | `extensions.code`       |
| ----------------------------------- | ----------------------------------------------------------- | ----------------------- |
| 未登录 / Token 失效 / Session 失效  | 既有 JWT 认证链路（`JWT_ERROR.*`）                          | `UNAUTHENTICATED`       |
| 非可信 SUPER_ADMIN 会话             | `PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS`                 | `FORBIDDEN`             |
| 目标为 SUPER_ADMIN（含停用自己）    | `PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS`                 | `FORBIDDEN`             |
| 目标账号不存在                      | `ADMIN_USER_ERROR.TARGET_NOT_FOUND`                         | `NOT_FOUND`             |
| 创建凭据唯一冲突                    | `ADMIN_USER_ERROR.CREDENTIAL_CONFLICT`                      | `CONFLICT`              |
| 启停转换不允许                      | `ADMIN_USER_ERROR.STATUS_TRANSITION_NOT_ALLOWED`            | `CONFLICT`              |
| 密码重置目标状态不允许              | `ADMIN_USER_ERROR.PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED` | `CONFLICT`              |
| 三源角色不收敛 / 锁内或回读读取失败 | `ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT` / `READ_FAILED`   | `INTERNAL_SERVER_ERROR` |
| 系统侧写入失败 / 后置校验不通过     | `ADMIN_USER_ERROR.WRITE_FAILED`                             | `INTERNAL_SERVER_ERROR` |
| 输入规范化 / 密码策略不达标         | `INPUT_NORMALIZE_ERROR.*`                                   | `BAD_USER_INPUT`        |

`STATUS_TRANSITION_NOT_ALLOWED` 与 `PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED` 是两个独立码，不得互相复用：前者专指启停状态转换矩阵，后者专指密码重置的目标状态边界；两者对外同为 `CONFLICT`（请求动作本身合法非 `BAD_USER_INPUT`、权限无问题非 `FORBIDDEN`、是明确的当前状态冲突非系统侧 5xx）。错误细节契约见 `docs/api/graphql-error-contract-current.md`：上述 `CONFLICT` 与 `INTERNAL_SERVER_ERROR` 的 `details` 一律留空，当前状态事实、三源角色原值、异常账号 ID 只进 `cause.diagnostic` 供服务端排查，不进对外响应。

### 旧 Token 复核语义

- 启用 / 停用**不**直接操作 Session 或 JWT：不写 Token 黑名单、不改 `tokenVersion`、不引入 Refresh Token 或服务端 Session。Access Token 在 `JWT_EXPIRES_IN` 内是静态的。
- 精确权限断言与目标保护断言只裁决可信 JWT 声明（`roles` / `activeRole`）与锁内数据库事实，**不含数据库复核**。因此仅靠它们，一个已被停用或已降级的账号仍可在旧 Token 到期前继续执行创建、改状态、重置密码，这与「停用即时失效」直接冲突。
- 即时失效由 `ValidateAccessTokenSessionUsecase`（P0-7，`JwtStrategy` 的唯一数据库 Session 复核入口）在每个受保护请求上承担。二者必须**同时生效**，不得以管理员断言代替 P0-7。
- 密码重置后：旧密码立即失效（下一次登录验证必然不匹配）；已签发的 Access Token **不**立即失效，按 `JWT_EXPIRES_IN` 自然过期。固定 `notice` 逐字为「密码已重置，旧密码立即失效；已签发的登录态不会立即失效，将在 Access Token 过期后自然退出」，由后端单一持有、不是调用方可控的自由文本，不含目标账号的任何身份信息、密码策略细节或验证状态。
- MySQL REPEATABLE READ 下，在本事务提交前已建立一致性快照、仍在进行的登录读取，可能读到旧 `login_password` 并以旧密码通过验证（极短窗口，快照隔离固有语义）；消除它需要给登录链路加锁，不可取。

## 自助账号设置

三个入口全部在 `MyAccountSettingsResolver`，按 `docs/api/adapters.rules.md` 只做「协议输入映射 + Usecase 调用 + View → DTO 薄映射」；DomainError 不在 Resolver 捕获，直接上抛进全局 GraphQL exception filter。

### 会话准入与目标边界

- 仅 `JwtAuthGuard`，不设角色门槛：任意已登录账号（含 `SUPER_ADMIN`）只能操作**自己**的账号；Command 在结构上不含目标账号 ID / 角色 / 状态 / 密码字段（`updateMyAccountSettings` 与 `changeMyPassword` 的密码字段除外），目标只能来自已认证 Session。
- 稳定公开视图 `MyAccountSettingsDTO` 不含 `accountId`、密码、Token、`identityHint` / `metaDigest` / `accessGroup` / `userState` 等敏感或内部字段；角色与状态为只读展示字段。

### 写入语义

- `updateMyAccountSettings`：六字段白名单（`loginName` / `loginEmail` / `nickname` / `companyName` / `phone` / `contactEmail`），严格三态——不传 = 不修改、`null` = 清空、字符串 = 设置（`nickname` 无 `null` 成员，空值一律拒绝）；「合并当前值后至少保留一个登录凭据」由 Usecase 在锁内裁决，历史遗留的「两列均为 NULL」异常账号即使本次提交不改凭据也拒绝（失败关闭，不自动修复、不代填）；发生变化的凭据先做排除自身的唯一性预检查（友好提示），并发竞争由数据库唯一索引最终裁决并收敛为通用 `CREDENTIAL_CONFLICT`，不泄露驱动错误与索引名；全部字段同值或未提供时不落库，返回 `isUpdated: false` 与当前视图（与 admin 资料更新的「空 patch 拒绝」口径刻意不同）；`contactEmail` 映射 `base_user_info.email`（联系邮箱），与登录凭据 `loginEmail` 严格区分，patch 不含 `userState`。
- `changeMyPassword`：当前密码 + 新密码，两个密码**不做 trim**（不丢字符）；当前密码刻意不做策略校验（存量密码可能先于现行策略设立），新密码共用 `assertAdminUserPasswordPolicy()`；当前密码验证失败收敛为 `MY_ACCOUNT_ERROR.CURRENT_PASSWORD_MISMATCH`（对外 `BAD_USER_INPUT`，不得塌缩为 `UNAUTHENTICATED`）；锁内以数据库权威 `createdAt` 为盐重新哈希覆盖写（与登录校验 / 管理员重置同源实现）；成功只返回 `isUpdated: true` 与固定 `notice`，不声称服务端撤销已签发 Token——旧 Access Token 按 `JWT_EXPIRES_IN` 自然过期，前端收到成功后清除本地会话。

### 事务边界与错误类别

- 事务边界由 Usecase 经 `TransactionRunner` 持有；写用例先锁 `base_user_account` 行再写 `base_user_info`，与管理员写用例同一锁顺序；失败日志复用共享 helper（自助链路传入各自的 warn 码与 Session 账号 ID），写密码哈希阶段抑制 `message`（与管理员链路同款纵深防御）。
- 写后读复用 `findMyAccountSettingsSnapshot()`：三源角色不收敛（`ROLE_DATA_INCONSISTENT`）或账号侧 `status` 与资料侧 `user_state` 双字段不一致（`READ_FAILED`）一律失败关闭，对外 `INTERNAL_SERVER_ERROR`。

| 场景                                 | DomainError 码                                                             | `extensions.code`       |
| ------------------------------------ | -------------------------------------------------------------------------- | ----------------------- |
| 登录名与登录邮箱合并后双空           | `MY_ACCOUNT_ERROR.LOGIN_CREDENTIAL_BOTH_EMPTY`                             | `BAD_USER_INPUT`        |
| 凭据占用（预检查或唯一索引竞争）     | `MY_ACCOUNT_ERROR.CREDENTIAL_CONFLICT`                                     | `CONFLICT`              |
| 当前密码不正确                       | `MY_ACCOUNT_ERROR.CURRENT_PASSWORD_MISMATCH`                               | `BAD_USER_INPUT`        |
| 新密码策略不达标                     | `INPUT_NORMALIZE_ERROR.INVALID_TEXT`                                       | `BAD_USER_INPUT`        |
| 三源角色不收敛 / 读取失败 / 写入失败 | `ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT` / `READ_FAILED` / `WRITE_FAILED` | `INTERNAL_SERVER_ERROR` |

密码策略失败口径与管理员链路一致（见「管理员用户管理 → 写入语义」密码策略条目）。

## 公开密码重置（verification token 流程）

`resetPassword` 使用通用 verification consume flow：

- 前端应先通过验证记录读取能力预读 token 状态。
- mutation 调用 `ConsumeVerificationFlowUsecase`。
- 成功返回 `success: true` 与 `accountId`。
- 失败返回 `success: false` 与失败消息。

后续若收敛为统一 GraphQL error contract，应单独更新本 current 文档。

## 禁止项

- 不擅自新增角色、组织、岗位或其他业务域 current contract。
- 不把 adapter DTO 传入 usecase/modules/core。
- 不从 resolver 直接依赖 modules(service) 或 infrastructure。
- 不返回 ORM Entity 或 QueryBuilder。
- 不新增当前通用身份层之外的业务身份或背景字段。
- 不把角色 / 状态白名单复制进 GraphQL DTO、Resolver、modules(service) 或前端策略：白名单是 Usecase 层的业务授权决策，前端只控制展示，后端是权限真源。
- 不在管理员写用例之外新增第二套角色 / 状态 / 密码哈希写入逻辑。
- 不让管理员入口复用 verification token 链路的 usecase、错误码或 GraphQL 流程。
- 不以管理员权限断言或目标保护断言代替 `ValidateAccessTokenSessionUsecase`（P0-7）的数据库 Session 复核。
