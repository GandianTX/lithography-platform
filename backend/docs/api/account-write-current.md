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

- `register(input: RegisterInput): RegisterResult`（LEGACY，兼容既有客户端）
- `registerWeb(input: RegisterWebInput): RegisterResult`（WEB，V44 注册页规则）
- `thirdPartyRegister(input: ThirdPartyRegisterInput): RegisterResult`
- `registrationOrganizations: [RegistrationOrganizationDTO!]!`
- `registrationOrganizationSearch(pagination: PaginationArgs!, keyword: String): RegistrationOrganizationPageDTO`
- `myEngineerRegistration: MyEngineerRegistrationDTO`
- `myEngineerRegistrationStatus(input: EngineerRegistrationCredentialInput!, pagination: PaginationArgs!): EngineerRegistrationStatusDTO`
- `resubmitEngineerRegistration(input: ResubmitEngineerRegistrationInput!): ResubmitEngineerRegistrationResultDTO`
- `login(input: AuthLoginInput): LoginResult`
- `account(args: AccountArgs): UserAccountDTO`
- `userInfo(accountId: Int!): UserInfoDTO`
- `basicUserInfo(accountId: Int!): BasicUserInfoDTO`
- `updateUserInfo(input: UpdateUserInfoInput): UpdateUserInfoResult`
- `resetPassword(input: ResetPasswordInput): ResetPasswordResult`

当前管理员用户管理入口（全部要求可信 SUPER_ADMIN 会话 + 请求期管理员等级：一级全范围、二级仅可信公司范围，详见「管理员用户管理」）：

- `adminUsers(pagination: PaginationArgs!, keyword: String, role: IdentityTypeEnum, status: AccountStatus): AdminUserListPageDTO`（一级全范围；二级仅可信公司；只返回普通账号）
- `adminCreateUser(input: AdminCreateUserInput): AdminUserDTO`（遗留入口：签名保留，仅一级管理员）
- `adminUpdateUserProfile(input: AdminUpdateUserProfileInput): AdminUserDTO`（遗留入口：签名保留，仅一级管理员）
- `adminSetUserStatus(input: AdminSetUserStatusInput): AdminUserDTO`（一级 / 二级）
- `adminResetUserPassword(input: AdminResetUserPasswordInput): AdminResetUserPasswordResultDTO`（遗留入口：签名保留，仅一级管理员）
- `adminResetUserPasswordToDefault(input: AdminResetUserPasswordToDefaultInput): AdminResetUserPasswordResultDTO`（默认密码来自服务端配置，一级 / 二级）

当前组织管理员工程师注册审核入口（全部要求可信 SUPER_ADMIN 会话 + 请求期管理员等级：一级可审核任意公司、二级仅本公司；组织范围由服务端按请求期可信公司裁决，不接受客户端自报 organizationId）：

- `adminEngineerRegistrations(pagination: PaginationArgs!, status: EngineerRegistrationApplicationStatus): AdminEngineerRegistrationPageDTO`
- `adminEngineerRegistrationDetail(applicationId: Int!): AdminEngineerRegistrationItemDTO`
- `adminEngineerRegistrationApprovalDetail(applicationId: Int!): AdminEngineerRegistrationDetailDTO`
- `reviewEngineerRegistration(input: ReviewEngineerRegistrationInput!): AdminEngineerRegistrationItemDTO`

审核条目的 `applicant` 复用 account 域 `AdminUserDTO` 的字段集（账号 ID、登录名/邮箱、昵称、角色与状态等公开资料），不额外定义第二套账号 DTO；字段明细见 `adminUsers` 的返回类型说明。

`adminEngineerRegistrationDetail` 保持既有契约：返回 `AdminEngineerRegistrationItemDTO`，`applicant` 仍是 `AdminUserDTO`，不包含真实姓名。审批决策所需的真实姓名由独立入口 `adminEngineerRegistrationApprovalDetail` 提供，其 `applicant` 为窄字段面 `AdminEngineerRegistrationApplicantDTO`（`id`、`loginName`、`nickname`、`realName`、`phone`、`contactEmail`），不含角色、账号状态与登录邮箱；`realName` 可为空，前端必须按空展示，不得用昵称冒充。

两个详情入口与审批决定（`reviewEngineerRegistration`）的可见范围与错误口径一致：一级管理员可读 / 决策任意公司，二级管理员仅本公司；申请不存在与跨公司统一返回 `NOT_FOUND`（`APPLICATION_NOT_FOUND`，文案「注册申请不存在」），不区分两种情形，也不暴露申请存在于其它公司。真实姓名只在 `adminEngineerRegistrationApprovalDetail` 及其授权范围内可读。

当前自助账号设置入口（仅要求已登录会话，目标账号只能来自 Session，详见「自助账号设置」）：

- `myAccountSettings: MyAccountSettingsDTO`
- `updateMyAccountProfile(input: UpdateMyAccountProfileInput): UpdateMyAccountSettingsResultDTO`（Web 正式资料页窄写入口）
- `updateMyAccountSettings(input: UpdateMyAccountSettingsInput): UpdateMyAccountSettingsResultDTO`（旧兼容广写入口）
- `changeMyPassword(input: ChangeMyPasswordInput): ChangeMyPasswordResultDTO`

`updateAccessGroup` 已下线：不再是公开 GraphQL 入口，也不存在任何 adapter 调用入口。

`adminChangeUserRole` 已下线：不再是公开 GraphQL 入口，也不存在任何 adapter 调用入口。普通用户角色只在管理员创建账号时单选一次写入，创建后角色只读，当前不存在任何公开角色修改 Mutation。

`login` 详细契约见 `docs/api/auth-session-current.md`。

## 注册

公开注册有两条通道，共用 `RegisterWithEmailUsecase` 与同一个创建事务，差异只在入口规则：

- `register`（`RegisterInput`，LEGACY）：保持主线基线 `833437f` 的请求形状与行为，供既有客户端与小程序继续使用；
- `registerWeb`（`RegisterWebInput`，WEB）：V44 Web 注册页使用，承担工程师资料与受管公司资格规则。

`RegisterInput`（`register`）字段：

- `loginName`
- `loginEmail`
- `loginPassword`（最少 6 位）
- `nickname`
- `type`
- `organizationId`（必填：客户与工程师都必须选择组织）
- `applicationNote`（可选：仅工程师待审申请使用）
- `inviteToken`

`RegisterWebInput`（`registerWeb`）字段：

- `loginName`
- `loginEmail`
- `loginPassword`（最少 8 位、最多 128 位）
- `nickname`
- `realName`（工程师必填）
- `phone`（工程师必填）
- `type`
- `organizationId`（选择名单内公司时必填，与 `organizationName` 互斥）
- `organizationName`（手填自家公司时必填，仅客户可用，与 `organizationId` 互斥）
- `applicationNote`（可选：仅工程师待审申请使用）
- `inviteToken`

`type` 默认是 `CUSTOMER`，公开注册允许 `CUSTOMER` 和 `ENGINEER`；`SUPER_ADMIN` 仍只由受控管理流程或 Seed 创建，不开放管理员自助注册。

通道差异（其余写入路径完全一致）：

| 维度 | `register`（LEGACY） | `registerWeb`（WEB） |
| --- | --- | --- |
| `organizationId` | Schema 必填（客户与工程师） | 客户二选一；工程师必填 |
| 手填公司 `organizationName` | 不支持，提交即 `BAD_USER_INPUT` | 仅客户可用，与 `organizationId` 互斥 |
| 公司资格（事务内复核） | 仅 `status = ACTIVE` | `status = ACTIVE AND is_managed_company = true` |
| 工程师 `realName` / `phone` | 可同时省略；只提供其一被拒 | 必填 |
| 客户 `customer_organization_id` | 不写入（保持基线行为） | 选择/新建公司时写可信归属 |
| `loginEmail` 可写上限 | 254（原输入契约） | 50（同时写入 `base_user_info.email`） |
| `loginName` 长度 | 4–30（列宽 30） | 4–30（归一化后、写入前校验） |
| 重复账号错误码 | `ACCOUNT_ALREADY_EXISTS` → `BAD_USER_INPUT` | `REGISTRATION_ACCOUNT_EXISTS` → `CONFLICT` |

**兼容性说明**：`register` 与 `thirdPartyRegister` 的 `organizationId` 为必填（非空），旧客户端不传会收到 `BAD_USER_INPUT`。V44 Web 注册页已切换到 `registerWeb`，客户不再被强制传 `organizationId`（可手填自家公司）。

开通结果按类型分流，两条通道都必须在写入事务内复核所选组织，客户端自报值不作为最终凭证：

- `CUSTOMER`：账号与资料在同一创建事务内写为 `ACTIVE / ACTIVE`，并绑定所选组织为 `CUSTOMER` 成员；注册返回后账号立即可用，`registrationStatus = REGISTERED`、`applicationId = null`；
- `ENGINEER`：账号与资料保持 `PENDING / PENDING`，不建立有效成员关系、不签发登录令牌，只在同一事务内落一份 `PENDING` 待审申请（`applicationNote` 可选）；返回 `registrationStatus = PENDING_REVIEW` 和非空 `applicationId`。所选组织管理员审核通过后，账号才开通。

公司资格复核失败统一返回 `ACCOUNT_ORGANIZATION_NOT_AVAILABLE`（映射 `BAD_USER_INPUT`），事务整体回滚、不留下任何写入；旧入口文案为「所选组织不存在或已停用」，Web 入口为「所选公司不存在、已停用或不具备注册资格」。旧入口提交 `organizationName`、或只在姓名/电话中提供其一时，按输入校验失败返回 `BAD_USER_INPUT`（不进入写入事务）。

`registrationOrganizations` 是公开只读的**兼容入口**：无参数，只返回 `ACTIVE` 组织的 `id` / `name` 数组，供小程序注册与拒绝后凭据重提等既有调用方继续使用。

`registrationOrganizationSearch` 是 Web 注册（客户与工程师注册页）专用的公开只读检索：资格固定为 `status = ACTIVE AND is_managed_company = true`，支持公司名称关键字与 OFFSET 分页（单页上限 50、关键字长度上限 100），只返回 `items { id name }` 与分页信息。两个入口返回的 `organizationId` 都只是申请参数，仍由注册/重提事务复核有效性。

`resubmitEngineerRegistration` 用于被拒绝后的重提：输入为本人凭据证明（`accountIdentifier` + `password`）、新的 `organizationId` 与可选 `applicationNote`；只新增一份 `PENDING` 申请，**不覆盖**历史申请行，拒绝记录与审核意见永久保留。重提前置条件为：账号三源角色收敛为 `ENGINEER`、双状态仍为 `PENDING / PENDING`、无有效组织成员关系、最新申请为 `REJECTED`。已有待审申请返回 `PENDING_APPLICATION_EXISTS`。

`myEngineerRegistrationStatus` 供待审申请人查看本人最新申请与历史分页。待审账号没有登录态，因此该入口**不使用 JWT**，只复用密码凭据验证证明「本人」，不签发令牌、不放行登录；凭据不匹配统一返回 `CREDENTIAL_MISMATCH`，不区分账号不存在与密码错误。分页只接受 OFFSET。

该入口是 **Mutation** 而非 Query：凭据必须随 POST 请求体提交，避免密码进入查询串、网关/APM 访问日志与被缓存/重放的 GET 语义。它不产生任何业务状态变更，客户端不应据此推断账号已开通。

`myEngineerRegistration` 供已登录的工程师受限期账号读取本人最新一份申请（`Query`，要求可信会话且未处于强制改密状态）：输出 `applicationId` / `organizationId` / `organizationName` / `status` / `applicationNote` / `submittedAt` / `reviewedAt` / `reviewComment`，不含 `accountId`、审核人等内部字段；无申请返回 `NOT_FOUND`。目标公司名称按既成事实读取，即使公司后来被停用也照常显示；申请目标**不授予任何组织权限**，也不参与会话 `restriction` 的组织归属判定（该判定只认有效 `ENGINEER` 成员关系）。

`reviewEngineerRegistration` 由所选组织的管理员执行一次性终态决策：

- 权限：可信 SUPER_ADMIN 会话 + 请求期管理员等级（`resolveAdminScope()` 精确 `activeRole`，一级全范围、二级仅请求期可信 `adminOrganizationId`）；二级在事务内再复核成员关系仍为本公司 `SUPER_ADMIN`（`assertEngineerRegistrationReviewPermission()`）。一级可决策任意公司申请，二级仅本公司；跨公司与不存在申请统一 `NOT_FOUND`（`APPLICATION_NOT_FOUND`，文案「注册申请不存在」），两种情形对外不可区分；
- `APPROVE`：在同一事务内按「账号 → 申请 → 公司」锁序先行锁定申请目标公司并复核仍为 `ACTIVE`（停用或不存在返回 CONFLICT / `REVIEW_NOT_ALLOWED`，申请保持待审且零写入），再建立 `ENGINEER` 成员关系、账号 `ACTIVE`、资料 `ACTIVE`、申请 `APPROVED` 一并生效；
- `REJECT`：只写 `REJECTED` 与必填审核意见，账号保持 `PENDING / PENDING`，可凭本人凭据重提；
- 重复/并发决策命中 0 行返回 CONFLICT，不覆盖既有终态。

`thirdPartyRegister` 当前走第三方注册 usecase，属于通用第三方账号能力，不代表具体业务域身份；它同样要求 `organizationId`，只创建并绑定 `CUSTOMER` 成员，不提供工程师绕过审核的入口。

公开注册成功语义：客户注册（`RegisterWithEmailUsecase` 的 CUSTOMER 分支）与 `thirdPartyRegister`（`WeappRegisterUsecase`）返回成功时，必须在**同一个创建事务内**显式写入 `account.status = ACTIVE`、`userInfo.userState = ACTIVE` 与所选组织的 `CUSTOMER` 成员关系（同提交同回滚，任一步失败不得返回成功，也不做事务外补救写）；客户可信公司归属 `customer_organization_id` 仅 `registerWeb` 写入，旧 `register` 保持基线不写。工程师注册只在同一事务内创建 `PENDING / PENDING` 账号与待审申请，不建成员关系；`UserInfoEntity.user_state` 列与数据库默认值 `PENDING` 保留原样，不新增 Migration；所有新建 UserInfo 的生产入口必须显式提供 `userState`，不依赖 Entity 默认值。

管理员代建入口（`adminCreateUser`，遗留签名）不受本改动影响：仅一级管理员可调用，仍按发起人的可信公司解析绑定，创建固定 `ACTIVE`，保留既有凭据、角色与密码策略；二级管理员调用一律 `FORBIDDEN`。

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
- 组织范围（非本人目标）：角色策略允许后仍需同一有效组织——操作者的唯一有效组织由 `TrustedOrganizationContextQueryService.resolveForAccount()` 解析（既不接受客户端自报组织，也不按公司名推断），目标必须在该组织内有有效成员关系。
- 本人路径不进入组织解析：历史无组织账号仍可自查，不强制先加入组织。
- 拒绝口径：跨组织、目标无有效成员关系（含已 LEFT）与目标不存在统一为 `USER_INFO_NOT_FOUND`（对外 `NOT_FOUND`），文案固定为「目标用户不存在」，不泄露目标存在性；操作者自身缺少唯一有效组织为 `ORGANIZATION_NO_ACTIVE_MEMBERSHIP`（对外 `FORBIDDEN`），存在歧义成员关系为 `ORGANIZATION_AMBIGUOUS_MEMBERSHIP`（对外 `FORBIDDEN`）。

## UserInfo 更新

`updateUserInfo` 是受保护 mutation：

- 不传 `accountId` 时默认更新当前登录账户。
- 可更新昵称、性别、生日、头像、邮箱、签名、地址、电话、标签、地理信息等资料字段。
- `userState` 不属于本 mutation 的可更新字段：启用/停用由管理员入口 `adminSetUserStatus` 承担，由其同事务同步 `account.status` 与 `userInfo.userState`。
- `identityHint` 不属于本 mutation 输入：普通用户角色只在管理员创建账号时单选一次写入，创建后角色只读，无公开角色修改 Mutation。
- Usecase 负责权限、可见性和写语义。
- Resolver 只做输入 shape 到 usecase 参数的映射。
- 组织范围与读取一致（本人豁免，非本人目标必须同属一个有效组织），但执行顺序固定为：事务内先 `SELECT ... FOR UPDATE` 锁定目标账号行，再解析操作者组织、核验目标成员关系、读取资料并写入。锁必须在组织解析与资料读取之前取得，避免锁前快照读到并发提交前的旧组织事实。
- 非本人目标的失败口径与读取相同（跨组织 / 无有效成员关系 / 不存在统一 `USER_INFO_NOT_FOUND`，对外 `NOT_FOUND`）；写路径把锁定阶段的目标缺失（`ACCOUNT_NOT_FOUND`，会映射为 `UNAUTHENTICATED`）转换为同一错误码，避免与「会话失效」混淆。
- 字段白名单不因组织范围放宽：非本人目标的 staff 写入仍仅允许 `nickname` / `avatarUrl` / `phone`，`email`、`signature` 等其余字段被忽略且不落库。

## 角色修改入口（已下线）

`updateAccessGroup` 与 `adminChangeUserRole` 均不在当前 Schema（Mutation root 不暴露两者），当前已无任何 GraphQL / adapter 调用入口：

- Resolver 未接线，`src/schema.graphql` 不暴露这两个 mutation，并有下线验证 E2E 守护（`update-access-group.e2e-spec.ts`）。
- `UpdateUserInfoInput` 不包含 `identityHint`。
- 普通用户角色只在管理员创建账号时单选一次写入：`adminCreateUser` 在同一创建事务内同步三处角色字段（见「写入语义」）；创建后角色只读，仅作列表展示与筛选。
- `UpdateAccessGroupInput` / `UpdateAccessGroupResult` 与 `UpdateAccessGroupUsecase` 仅作为遗留内部代码保留：无任何 adapter 引用，`UpdateAccessGroupUsecase` 仍是 `account-usecases.module.ts` 的 provider / export，但它是一套独立的既有实现（自持权限判定、输入规范化、事务边界与写入逻辑）。这些残留的清理属独立 cleanup 事项，不在本 current 契约内。

## 管理员用户管理

六个入口全部在 `AdminUserResolver`（`adminUsers` + 五个写 mutation），按 `docs/api/adapters.rules.md` 只做「协议输入映射 + Usecase 调用 + View → DTO 薄映射」；业务规则、事务、目标保护与白名单全部归 Usecase，DomainError 不在 Resolver 捕获，直接上抛进全局 GraphQL exception filter。

### 权限矩阵

| operation                        | 会话准入                             | 目标约束                                                                     | 可写 / 可筛选值域                                         |
| -------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| `adminUsers`                     | 可信 SUPER_ADMIN + 一级或二级        | 无写目标；二级仅本可信公司                                                   | `role` 筛选仅 ENGINEER / CUSTOMER；`status` 仅 ACTIVE / INACTIVE |
| `adminCreateUser`（遗留签名）    | 可信 SUPER_ADMIN + **仅一级**        | 新建账号，创建固定 `ACTIVE`                                               | `role` 仅 ENGINEER / CUSTOMER                             |
| `adminUpdateUserProfile`（遗留签名） | 可信 SUPER_ADMIN + **仅一级**     | 现有 SUPER_ADMIN 目标只读                                                    | `nickname` / `companyName` / `phone` / `contactEmail`     |
| `adminSetUserStatus`             | 可信 SUPER_ADMIN + 一级或二级        | 现有 SUPER_ADMIN 目标只读（含「不能停用自己」）；二级目标须在本可信公司       | `status` 仅 ACTIVE / INACTIVE                             |
| `adminResetUserPassword`（遗留签名） | 可信 SUPER_ADMIN + **仅一级**     | 现有 SUPER_ADMIN 目标只读，且目标双字段状态须一致为 ACTIVE / INACTIVE         | `newPassword` 明文                                        |
| `adminResetUserPasswordToDefault` | 可信 SUPER_ADMIN + 一级或二级       | 现有 SUPER_ADMIN 目标只读；二级目标须在本可信公司；目标双字段状态须一致为 ACTIVE / INACTIVE | 无密码输入（默认密码来自服务端配置）                      |

### 会话准入（两层）

- 粗粒度：`JwtAuthGuard` + `RolesGuard` + `@Roles(SUPER_ADMIN)`，按 accessGroup 做入口准入。
- 精确（第一层）：每个 Usecase 的**第一步**在输入规范化与数据库访问之前执行管理员作用域断言——`assertAdminUserManagementScope()`（列表 / 启停 / 默认密码重置，全仓唯一实现，内部复用 `resolveOrganizationScopedAdminScope()`）或 `resolveLevelOneAdminScope()`（三条遗留写入口）。两者都要求 `session.roles` 含 `SUPER_ADMIN` **且** `session.activeRole` 精确等于 `SUPER_ADMIN`；`activeRole` 缺失或为非管理员角色一律拒绝（失败关闭）。
- 等级：请求期查库得到的 `admin_level` 必须为 1 或 2；**等级缺失或非法一律拒绝**，不退化为 `SUPER_ADMIN` 全权限。一级归一为 `{ level: 1, organizationId: null }`（平台全范围）；二级必须带请求期可信公司 `adminOrganizationId`，缺失即拒绝。
- 第二层（仅二级）：`assertAdminUserManagementScope()` 再按可信组织成员事实复核——唯一有效成员关系的 `memberRole` 仍须为 `SUPER_ADMIN` 且公司等于请求期可信公司；成员关系被撤销、变更或出现多组织歧义时失败关闭。一级是平台级角色，**不要求**自身存在成员关系。
- 二级不开放的入口（`adminCreateUser` / `adminUpdateUserProfile` / `adminResetUserPassword`）由 `resolveLevelOneAdminScope()` 在同样位置直接 `FORBIDDEN`，签名与响应形状对一级保持不变。
- Guard 不能替代 Usecase 的业务授权；前端隐藏入口也不是授权依据。
- 拒绝错误的 `details` 刻意留空，不携带 accessGroup / 角色列表等身份事实（全局过滤器会把 `details` 原样写入 `extensions.details`）；动作文案由 `actionLabel` 拼进 `message`，因此拒绝响应与日志已能区分是哪个动作被拒。

### 目标保护与角色值域

- `assertWritableAdminUserTargetRole()` 依**锁内**数据库事实拒绝任意 SUPER_ADMIN 目标：不允许通过本功能创建、删除、降级、编辑资料、修改状态或重置 SUPER_ADMIN 密码。由于所有 SUPER_ADMIN 均只读，「管理员操作自己」也一并被拒（管理员自己的账号必然是 SUPER_ADMIN）；`adminSetUserStatus` 对「停用自己」另在任何数据库访问之前显式先行拒绝。
- 二级管理员的写入目标必须在本可信公司内，且归属口径按目标真实角色分流：`CUSTOMER` 以 `base_user_info.customer_organization_id` 等于可信公司为准（成员关系表残留的旧公司关系不能作为证据）；`ENGINEER` 以本公司内有效且 `memberRole = ENGINEER` 的成员关系为准。外公司目标、无有效归属、资料缺失与角色三源不收敛统一收敛为 `TARGET_NOT_FOUND`（对外 `NOT_FOUND`），不泄露目标在其它公司或是否存在。
- 创建只允许普通账号：`normalizeAdminUserWritableRole()` 只接受 `ADMIN_USER_WRITABLE_ROLES = [ENGINEER, CUSTOMER]`。列表读面同样只返回普通账号：`ADMIN_USER_LIST_ROLE_FILTERS` 与 `ADMIN_USER_VISIBLE_ROLES` 均只有 `ENGINEER` / `CUSTOMER`，`role` 传入 SUPER_ADMIN 即被拒绝，管理员账号不出现在 `items` 中；`total` 与 `items` 同源（可见角色与二级公司范围都下推到同一 QueryBuilder），不从总数泄漏外公司账号。读筛选值域与写入值域刻意各自持有两份数组，任何一侧演进不得静默改变另一侧。
- 普通账号是**单一**业务角色：前端只提交一个业务角色，不分别提交或拼装 `identity_hint` / `access_group` / `meta_digest`。
- 目标不存在收敛为 `ADMIN_USER_ERROR.TARGET_NOT_FOUND`（对外 `NOT_FOUND`），**不得**沿用 `lockByIdForUpdate()` 原有的 `ACCOUNT_ERROR.ACCOUNT_NOT_FOUND`——该码值与 `AUTH_ERROR.ACCOUNT_NOT_FOUND` 相同，会被映射为 `UNAUTHENTICATED`，违反「not-found 不得塌缩为 UNAUTHENTICATED」的错误契约。
- 三源角色收敛不出唯一角色（`ROLE_DATA_INCONSISTENT`）或资料行缺失（`READ_FAILED`）时，读与写（含密码重置）一律失败关闭：整次查询失败，不返回部分列表、不排除异常行、不兜底、不静默修复历史数据。密码重置同样受此约束是刻意的：收敛不出单一角色就无法安全确认目标「不是 SUPER_ADMIN」，放行等于允许对身份不明的账号覆盖登录凭据。

### 写入语义

- `adminCreateUser`（遗留签名，仅一级）：登录名 / 登录邮箱至少提供一个；同一事务内写 `base_user_account.identity_hint = role`、`base_user_info.access_group = [role]`、`base_user_info.meta_digest = [role]` 与 `user_state = ACTIVE`，账号 `status` 固定 `ACTIVE`；凭据唯一索引冲突对外 `CONFLICT`，不泄露驱动错误与索引名。
- `adminUpdateUserProfile`（遗留签名，仅一级）：昵称不传 = 不修改、传 string = 修改，`null` / 空字符串 / 纯空白一律拒绝；`companyName` / `phone` / `contactEmail` 三态——不传 = 不修改，`null` = 清空。不得经由资料编辑改写角色事实（`identityHint`）；角色在创建后只读，不存在公开角色修改入口。本用例已复用 `loadWritableAdminUserTarget()` 先锁 account 行并按锁内三源角色事实保护目标，随后才读写 userInfo。
- `adminSetUserStatus`（一级 / 二级）：同一事务内双字段同步——`base_user_account.status`（`updateAccount()`）与 `base_user_info.user_state`（`updateUserInfoFields()`）写为同值，启用即两处同为 `ACTIVE`、停用即两处同为 `INACTIVE`。`AccountStatus` 与 `UserState` 是两个不同枚举类型（成员字符串当前逐字相同），映射刻意显式书写而非断言复用。转换矩阵只允许两行：当前双字段同为 `ACTIVE` → 改 `INACTIVE`；当前双字段同为 `INACTIVE` → 改 `ACTIVE`。同状态请求幂等成功，不执行任何 UPDATE、不 bump 任何时间列。其余全部失败关闭（当前值为 `PENDING` / `SUSPENDED` / `BANNED` / `DELETED` 或任何无法识别的值、双字段不一致、当前状态缺失），不自动修复、不选任一字段为真源、不继续执行双字段 UPDATE；不做硬删除。
- `adminResetUserPassword`（遗留签名，仅一级）：独立的管理员链路，不接触任何 verification token / 验证记录 / token 预读能力，不复用其 usecase、错误码或 GraphQL 流程；两条链路只在密码**哈希与策略原语**上汇合（`PasswordPolicyService` / `hashPasswordWithTimestamp()` / `updateAccountPasswordHash()`，全仓单一实现），流程编排零共享。目标双字段状态裁决在哈希生成与任何写入之前执行，只允许双字段一致的 `ACTIVE` / `INACTIVE`；本用例不写状态字段，`INACTIVE` 账号重置后仍是 `INACTIVE`（不存在顺带启用），拒绝路径不操作 Token / Session。结果只返回 `accountId` / `isUpdated`（恒为 `true`）/ 固定 `notice`，不含新密码、旧密码、哈希或任何密码派生物。
- `adminResetUserPasswordToDefault`（一级 / 二级）：输入**只有**目标 `accountId`，默认密码只来自服务端配置 `ADMIN_DEFAULT_RESET_PASSWORD`（经 `ADMIN_ACCOUNT_RESET_OPTIONS` 注入），协议层不接受任何密码字段，从结构上禁止把客户端自报密码写入目标账号。配置缺失或默认密码不符合 `PasswordPolicyService` 策略时，在**任何数据库访问之前**失败关闭为 `ADMIN_USER_ERROR.DEFAULT_PASSWORD_NOT_CONFIGURED`（对外 `INTERNAL_SERVER_ERROR`），不回退硬编码口令，也不把策略原因或配置键名暴露给调用方。事务内复用 `loadWritableAdminUserTarget()`（锁定、二级归属校验、SUPER_ADMIN 只读保护）与 `assertPasswordResetTargetStatusAllowed()`（仅双字段一致的 ACTIVE / INACTIVE）；写哈希的**同一条 UPDATE** 置 `must_change_password = true`，目标用户下次登录必须先改密。结果只返回 `accountId` / `isUpdated`（恒为 `true`）/ 固定 `notice`（「密码已重置为默认密码，目标用户下次登录必须修改密码；已签发的登录态不会立即失效，将在 Access Token 过期后自然退出」），不含密码、哈希或配置值。
- 密码策略：管理员创建的初始密码、管理员重置的新密码与自助修改密码的新密码共用 `assertAdminUserPasswordPolicy()`（内部复用全仓单一 `PasswordPolicyService`），失败抛 `INPUT_NORMALIZE_ERROR.INVALID_TEXT`（对外 `BAD_USER_INPUT`），**不使用** `AUTH_ERROR.INVALID_PASSWORD`——后者映射为 `UNAUTHENTICATED`，会让「管理员填了弱密码」被前端误判为会话失效并清理 Session 跳转登录页。默认密码重置刻意**不用**该断言：默认密码由部署侧配置，弱口令属服务端配置问题，统一收敛为 `DEFAULT_PASSWORD_NOT_CONFIGURED`（见上一条）。

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
| 默认密码未配置或不符合策略          | `ADMIN_USER_ERROR.DEFAULT_PASSWORD_NOT_CONFIGURED`          | `INTERNAL_SERVER_ERROR` |
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

四个入口全部在 `MyAccountSettingsResolver`，按 `docs/api/adapters.rules.md` 只做「协议输入映射 + Usecase 调用 + View → DTO 薄映射」；DomainError 不在 Resolver 捕获，直接上抛进全局 GraphQL exception filter。

### 会话准入与目标边界

- 仅 `JwtAuthGuard`，不设角色门槛：任意已登录账号（含 `SUPER_ADMIN`）只能操作**自己**的账号；Command 在结构上不含目标账号 ID / 角色 / 状态 / 密码字段（`updateMyAccountSettings` 与 `changeMyPassword` 的密码字段除外），目标只能来自已认证 Session。
- 稳定公开视图 `MyAccountSettingsDTO` 不含 `accountId`、密码、Token、`identityHint` / `metaDigest` / `accessGroup` / `userState` 等敏感或内部字段；角色与状态为只读展示字段。

### 写入语义

- `updateMyAccountProfile`：Web 正式资料页的**窄写入口**，输入只有 `nickname` / `realName` / `phone` / `contactEmail` 四个字段；`loginName` / `loginEmail` / `companyName` / `accountId` / 角色 / 状态 / 等级 / `customerOrganizationId` 在 Schema 层面不存在，客户端硬塞会被 GraphQL 变量校验拒绝。复用 `UpdateMyAccountSettingsUsecase` 的同一事务、三态合并、受限白名单与失败分类；公司归属继续走独立的 `supplementMyCustomerCompany`。
- `updateMyAccountSettings`：**旧兼容广写入口**（既有客户端 / 小程序），六字段白名单（`loginName` / `loginEmail` / `nickname` / `companyName` / `phone` / `contactEmail`），严格三态——不传 = 不修改、`null` = 清空、字符串 = 设置（`nickname` 无 `null` 成员，空值一律拒绝）；「合并当前值后至少保留一个登录凭据」由 Usecase 在锁内裁决，历史遗留的「两列均为 NULL」异常账号即使本次提交不改凭据也拒绝（失败关闭，不自动修复、不代填）；发生变化的凭据先做排除自身的唯一性预检查（友好提示），并发竞争由数据库唯一索引最终裁决并收敛为通用 `CREDENTIAL_CONFLICT`，不泄露驱动错误与索引名；全部字段同值或未提供时不落库，返回 `isUpdated: false` 与当前视图（与 admin 资料更新的「空 patch 拒绝」口径刻意不同）；`contactEmail` 映射 `base_user_info.email`（联系邮箱），与登录凭据 `loginEmail` 严格区分，patch 不含 `userState`。
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
