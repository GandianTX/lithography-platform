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

登录与令牌复核对待审账号的口径：`login`（`LoginWithPasswordUsecase`）只放行 `account.status = ACTIVE`，其余状态返回 `ACCOUNT_INACTIVE`；`ExecuteLoginFlowUsecase` 二次复核账号状态；`ValidateAccessTokenSessionUsecase` 在每个受保护请求上要求账号 `ACTIVE` 且 `userInfo.userState = ACTIVE`。因此工程师在审核通过前无法登录、也没有可用令牌，第三方入口不提供绕过审核的路径。管理员启停矩阵继续拒绝 `PENDING` 账号，不能用「启用账号」替代审批。

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

Adapter 只做协议输入映射，不在 resolver 内实现登录业务规则。

## Login 输出

`LoginResult` 当前字段：

- `accessToken`
- `refreshToken`
- `accountId`
- `role`
- `userInfo`

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

## 禁止项

- 不在 auth resolver 中直接依赖 modules(service) 或 infrastructure。
- 不在 GraphQL DTO 中下沉业务规则。
- 不把 ORM Entity 作为登录输出。
- 不把其他业务域的特定 current contract 复制到本项目。
