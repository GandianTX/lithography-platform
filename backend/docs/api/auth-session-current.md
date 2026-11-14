<!-- docs/api/auth-session-current.md -->

Purpose: Snapshot the current GraphQL auth/session contract for this repository.
Read when: You change login, JWT payload, auth guards, role decisions, or frontend-facing session behavior.
Do not read when: You only change unrelated GraphQL DTOs.
Source of truth: Current resolver/usecase/type code remains executable truth; this file records the stable contract agents must preserve.
Global error contract: Every GraphQL interface must also follow docs/api/graphql-error-contract-current.md.

# Auth / Session Current Contract

## 当前范围

当前项目只保留以下账号角色：

- `SUPER_ADMIN`
- `ENGINEER`
- `CUSTOMER`

`SUPER_ADMIN` 继承 `ENGINEER` 与 `CUSTOMER` 的访问能力，`ENGINEER` 与 `CUSTOMER` 互不继承。

公开注册按角色分流：`CUSTOMER` 选择有效组织后直接开通并绑定该组织 `CUSTOMER` 成员；`ENGINEER` 先提交待审申请，账号与资料保持 `PENDING / PENDING`，由所选组织管理员审核通过后才开通。`SUPER_ADMIN` 不开放自助注册，仍由受控管理流程或 Seed 创建。

登录与令牌复核对待审账号的口径：`login`（`LoginWithPasswordUsecase`）默认只放行 `account.status = ACTIVE`，其余状态返回 `ACCOUNT_INACTIVE`；当调用方显式传 `allowRestrictedSession = true` 时，`PENDING` 账号只有在存在明确会话限制（`MUST_CHANGE_PASSWORD` / `ENGINEER_PENDING` / `ENGINEER_REJECTED` / `ENGINEER_INACTIVE`）时才签发受限令牌，停用、封禁、删除、暂停等状态仍一律拒绝。`ExecuteLoginFlowUsecase` 二次复核账号状态；`ValidateAccessTokenSessionUsecase` 在每个受保护请求上复用 `ResolveSessionRestrictionUsecase`（唯一事实读取入口）与同一套 `resolveSessionRestriction` 纯策略，并固定允许受限会话。受限会话只能进入受限入口（改密页 / 待审结果页），业务接口由 `SessionRestrictionGuard` 拦截。第三方登录入口不传 `allowRestrictedSession`，因此仍不提供绕过审核的路径；其 `LoginResult` 与密码登录同源计算 `restriction` 与组织身份字段，`ACTIVE` 账号的「必须改密 / 工程师资格未生效」会如实返回并同样受每请求守卫拦截，`PENDING` 账号仍返回 `ACCOUNT_INACTIVE`。管理员启停矩阵继续拒绝 `PENDING` 账号，不能用「启用账号」替代审批。

工程师资格口径：最新申请为 `APPROVED` 时，只有账号与资料同时 `ACTIVE`，且账号在该申请目标组织内恰有一条有效 `ENGINEER` 成员关系（成员 `ACTIVE` 且组织 `ACTIVE`），才视为资格生效并返回 `NONE`；成员缺失、组织停用、角色不符、目标组织不一致或多组织歧义一律返回 `ENGINEER_INACTIVE`（滚动受限，业务入口由守卫拒绝）。没有任何工程师申请记录的存量工程师账号不追加成员事实要求，继续沿用「双状态 `ACTIVE` 即 `NONE`」的既有口径。

例外（2026-08-29 负责人裁定）：「客户创建维修申请」页拒绝 `SUPER_ADMIN` 继承进入，前端路由与 `ENGINEER` 一致重定向回各自主页；后端 `equipmentModels` 与 `createRepairRequest` 仅接受精确 `CUSTOMER`。

## GraphQL 入口

- `login(input: AuthLoginInput): LoginResult`
  - Resolver：`src/adapters/api/graphql/auth/auth.resolver.ts`
  - Usecase：`LoginWithPasswordUsecase`

失败通过 GraphQL error contract 表达，不通过 `LoginResult.success` 表达。

## Login 输入

`AuthLoginInput` 当前字段：

- `loginName`：登录名或邮箱。
- `loginPassword`：密码。
- `type`：`LoginTypeEnum`，当前密码登录主链路要求传入。
- `ip`：可选客户端 IP。
- `audience`：`AudienceTypeEnum`，用于 token audience 与登录记录。
- `allowRestrictedSession`：可选，默认 `false`；仅允许受限会话登录的入口显式传 `true`。

Adapter 只做协议输入映射，不在 resolver 内实现登录业务规则。

## Login 输出

`LoginResult` 当前字段：

- `accessToken`
- `refreshToken`
- `accountId`
- `role`
- `userInfo`
- `restriction`：`SessionRestriction`，缺省视为 `NONE`
- `adminLevel`：管理员等级（`1` / `2` / `null`）
- `customerOrganizationId`：客户公司归属主键，无归属为 `null`
- `engineerOrganizationId`：唯一有效 `ENGINEER` 成员组织主键，0 条或多条为 `null`
- `adminOrganizationId`：唯一有效 `SUPER_ADMIN` 成员组织主键，0 条或多条为 `null`
- `registrationOrganizationId`：最新工程师申请的目标组织主键，仅用于展示，不授予组织业务权限

`userInfo` 由登录后读取链路装配，并移除敏感字段，例如 `metaDigest`。

## JWT Payload

当前 access token payload 至少包含：

- `sub`：账户 ID。
- `username`：用户昵称。
- `email`：账户邮箱。
- `accessGroup`：角色访问组。
- `activeRole`：当 accessGroup 非空时写入最终角色。

Usecase 层会话统一通过 `mapJwtToUsecaseSession()` 转换为：

- `accountId`
- `roles`

Resolver、Guard、Usecase 不应各自手写不同的 session shape。

## 角色决策

- 登录先执行账号凭据校验。
- 登录流程读取 account / userInfo，并校验 accessGroup 与安全摘要一致性。
- `DecideLoginRoleUsecase` 根据 `identityHint` 与 `accessGroup` 决定最终角色。
- 当 accessGroup 为空、identityHint 不可用或提示角色不属于 accessGroup 时，当前安全回退角色是 `CUSTOMER`。
- 若最终角色不在非空 accessGroup 内，登录必须失败。

## Session Failure Signal

受保护接口必须遵守 `docs/api/graphql-error-contract-current.md`：

- 前端运行时稳定依赖 `errors[].extensions.code === 'UNAUTHENTICATED'` 判断会话不可用。
- `extensions.errorCode` 只作为调试、测试、观测、兼容或可选展示字段。
- HTTP `401` 只作为 transport 层兜底，GraphQL 可以 HTTP `200` 携带 `errors`。
- GraphQL adapter 层的 `JwtStrategy` 只负责协议认证接入；账号存在性等 session 读校验通过
  `ValidateAccessTokenSessionUsecase` 上提到 usecase 层。

## Session Identity 查询

- `mySessionIdentity: SessionIdentityDTO`
  - Resolver：`src/adapters/api/graphql/auth/auth.resolver.ts`
  - 会话事实由 `JwtStrategy` → `ValidateAccessTokenSessionUsecase` 每请求计算并挂在
    `request.user` 上，adapter 只做薄映射，不再查库。
  - 输出 `accountId` / `role` / `adminLevel` / `customerOrganizationId` /
    `engineerOrganizationId` / `adminOrganizationId` / `registrationOrganizationId` /
    `restriction`，前端据此判断是否需要进入受限入口。
  - 组织字段与 `restriction` 同源：都由 `ResolveSessionRestrictionUsecase` 在每次请求时
    按数据库事实重算，不信任 Token 声明中的组织信息。
  - 未识别到的 `restriction` 按 `null` 处理，由前端保持现状而不是回落 `NONE`。

## 公开注册

- `registrationOrganizations: [RegistrationOrganizationDTO!]!`：兼容入口，无参数，返回全部
  `ACTIVE` 组织的 `id` / `name` 数组，供小程序注册与拒绝后凭据重提等既有调用方继续使用。
- `registrationOrganizationSearch(pagination, keyword)`：Web 注册（客户与工程师）专用公开
  关键字分页检索，只返回 `id` / `name`；仅返回 `status = ACTIVE AND is_managed_company = true`
  的组织，单页上限 50，关键字长度上限 100。
- `register(input: RegisterInput!)`：旧注册入口（LEGACY，兼容既有客户端），`type` 区分角色
  （默认 `CUSTOMER`）。`organizationId` Schema 必填（客户与工程师），事务内只复核
  `status = ACTIVE`；不支持手填公司名；工程师 `realName` / `phone` 可省略；客户不写
  `customer_organization_id`。资格失效返回 `ACCOUNT_ORGANIZATION_NOT_AVAILABLE`
  （映射 `BAD_USER_INPUT`），成功后客户账号直接 `ACTIVE`。
- `registerWeb(input: RegisterWebInput!)`：V44 Web 注册页入口（WEB），与 `register` 共用同一
  注册事务。
  - `CUSTOMER`：选择名单内公司（`organizationId`）或手填公司名（`organizationName`）二者互斥；
    名单内公司需满足 `ACTIVE AND is_managed_company = true`，创建事务内用同一
    `transactionContext` 复核，资格失效返回 `ACCOUNT_ORGANIZATION_NOT_AVAILABLE`
    （映射 `BAD_USER_INPUT`），成功后账号直接 `ACTIVE` 并写可信公司归属。
  - `ENGINEER`：仅可选择名单内公司，必填 `realName` / `phone`；写入账号与资料
    （`PENDING / PENDING`）与待审申请，待组织管理员审核通过后才可正常登录。
- 并发注册命中账号唯一索引冲突时，错误类别按入口区分：旧 `register` 维持
  `ACCOUNT_ALREADY_EXISTS` → `BAD_USER_INPUT`（兼容基线契约），`registerWeb` 使用
  `REGISTRATION_ACCOUNT_EXISTS` → `CONFLICT`；预检查与唯一索引兜底共用同一决定点。
  前端按 `extensions.code` 大类识别，不依赖生产环境隐藏的 `extensions.errorCode`。
- `registerWeb` 的 `loginEmail` 可写上限为 50（联系邮箱列宽），`loginName` 为 4–30
  （登录名列宽）；两者均在归一化后、任何公司/账号写入前拒绝越界输入。
- 工程师待审补充入口：`myEngineerRegistrationStatus`（凭据证明，不使用 JWT）、
  `resubmitEngineerRegistration`（拒绝后重提）。

## 禁止项

- 不在 auth resolver 中直接依赖 modules(service) 或 infrastructure。
- 不在 GraphQL DTO 中下沉业务规则。
- 不把 ORM Entity 作为登录输出。
- 不把其他业务域的特定 current contract 复制到本项目。
