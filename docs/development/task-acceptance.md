# 开发任务验收标准

本标准用于新人任务、页面纵向切片和 Pull Request 验收。PR 创建人完成自检，项目负责人负责最终 Review 和 Merge。

## 一、所有任务的完成定义

任务只有同时满足以下要求才算完成：

- 从最新 `main` 创建短期功能分支，没有夹带其他任务改动。
- 实现与需求文档和已确认角色权限一致。
- 前后端真实联调通过，不用前端硬编码结果冒充已完成接口。
- 正常、加载、空数据、权限不足和请求失败状态均有明确表现。
- 没有提交 `.env`、Token、密码、数据库 Dump、日志、上传文件、模型权重或生成产物。
- 相关类型检查、Lint、单元测试和构建通过。
- PR 描述包含测试命令、手工验收步骤和必要截图。
- CI 全部通过，Review 讨论全部解决。

## 二、GraphQL 契约验收

后端采用 Code First，禁止手改或提交生成的 `backend/src/schema.graphql`。新增 Query/Mutation 时必须检查：

- GraphQL Input、Args、DTO、枚举和 Resolver 位于 adapter 层。
- ORM Entity 不添加 GraphQL decorator，不直接作为 GraphQL 返回类型。
- Resolver 只做协议映射、Guard 接入和 Usecase 调用，不直接访问 Repository、QueryBuilder 或基础设施。
- 写操作由 Usecase 编排事务和业务规则。
- 读操作由 QueryService 形成稳定视图，再由 Usecase/Resolver 组合输出。
- 受保护入口使用 `JwtAuthGuard`；有角色限制时同时使用 `RolesGuard` 和明确的 `@Roles(...)`。
- 权限必须同时在后端执行，不能只隐藏前端菜单或按钮。
- 前端 GraphQL operation 的变量和响应类型与实际生成 Schema 一致。
- GraphQL error 遵循现有错误契约；会话失效以 `errors[].extensions.code === 'UNAUTHENTICATED'` 为稳定信号。
- 至少包含成功、未登录、无权限、非法输入和目标不存在等适用测试。

一个页面的推荐后端链路：

```text
GraphQL DTO / Input / Resolver
              ↓
           Usecase
              ↓
QueryService / 同域写 Service
              ↓
        TypeORM Entity
```

## 三、数据库基线验收

- 当前首次交付的 14 张表、Entity、Migration、索引、外键和 CHECK 约束是负责人统一维护的数据库基线。
- 普通页面 PR 不得直接修改已确认的基线 Migration。
- 页面实现不得启用 `DB_SYNCHRONIZE=true`。
- 发现字段或约束缺失时先向负责人说明，由负责人决定是否建立独立数据库修正 PR。
- 开发 Mock Data 统一维护在 `backend/scripts/seed-mock.ts`，不得混入 Migration 或前端代码。
- 新增 Mock 数据必须可重复执行，不删除非 Mock 数据，并满足全部外键和 CHECK 约束。

## 四、登录与权限底座专项验收

登录与权限底座是页面并行开发前的前置任务，由单一分支和单一负责人修改，其他页面不得另建一套 Session 或路由权限逻辑。

### 功能要求

- 提供正式 `/login` 页面，支持账号名或邮箱和密码登录。
- 调用已有 `login(input: AuthLoginInput!): LoginResult!` Mutation，登录请求明确使用无需 Token 的 GraphQL 模式。
- 登录成功后保存 `accessToken`、`accountId`、`role` 和必要的安全用户视图。
- 将 `getAccessToken()` 接入前端 `configureGraphQLRuntime()`，后续受保护请求自动携带 `Authorization: Bearer <token>`。
- 提供唯一的 Auth/Session owner，页面不得直接读写散落的 Token key。
- 刷新浏览器后能从 `sessionStorage` 恢复当前标签页会话；不得把访问 Token 写入长期 `localStorage`。
- 网页登录保持（`WEB_SESSION_ENABLED`，可选）启用时：登录改走同源 REST 并以下发 HttpOnly Cookie
  供新标签页恢复同一会话，`restore` 不重签、不续期；关闭（默认）时保持上述 sessionStorage
  行为不变（契约见 `backend/docs/api/auth-session-current.md`「网页登录保持」一节）。
- 退出登录清除前端 Session、Apollo 缓存和角色状态，并跳转 `/login`。
- 当前后端尚无可用 refresh/logout Mutation；第一版不得伪造自动刷新。Token 失效时清理 Session 并重新登录。
- 未登录访问受保护路由时跳转 `/login`，并保留安全的原目标路径以便登录后返回。
- 已登录访问 `/login` 时跳转到该角色的默认入口。
- 路由、导航和页面入口统一识别 `SUPER_ADMIN / ENGINEER / CUSTOMER`。
- `ENGINEER` 和 `CUSTOMER` 不能访问彼此专属页面；`SUPER_ADMIN` 按后端角色层级可访问管理员、工程师和客户端能力。
- GraphQL 返回 `UNAUTHENTICATED` 时只触发一次全局会话失效处理，避免重复跳转或刷新风暴。
- 前端不读取或展示 `metaDigest`、密码、refresh token 等敏感字段。

### 必测场景

- 三种角色的 Mock 账号均能登录，返回角色与 Seed 一致。
- 密码错误时停留登录页并显示可理解的错误，不泄漏账号是否存在等敏感细节。
- 未登录直接打开受保护 URL 会进入登录页。
- 登录后进入正确的角色默认入口。
- `ENGINEER` 与 `CUSTOMER` 互访专属路由得到 403 页面或安全重定向。
- `SUPER_ADMIN` 的继承访问符合后端 `roleHierarchy`；例外：「客户创建维修申请」页 `/customer/repair-requests/new` 拒绝 `SUPER_ADMIN`（与 `ENGINEER` 一致重定向回 `/admin`，2026-08-29 负责人裁定：第一版不代客户创建，后端仅接受精确 `CUSTOMER`，不保留「可进页面、后端全拒」的残缺中间态）。
- 刷新页面后会话仍在；退出后刷新不能恢复会话。
- Token 无效或过期时清除 Session 并返回登录页。
- GraphQL 网络失败时保留用户输入，并提供重试反馈。

### 自动化检查

```powershell
npm --prefix backend run typecheck
npm --prefix backend run test:unit -- --runInBand
npm --prefix backend run build
npm --prefix frontend run format:check
npm --prefix frontend run lint
npm --prefix frontend run test:unit
npm --prefix frontend run build
```

### PR 验收证据

登录 PR 描述至少包含：

- 使用的 GraphQL operation 和角色映射说明。
- 三类账号登录结果截图，截图必须遮挡 Token、密码和其他密钥。
- 未登录路由保护、跨角色访问、退出和 Token 失效的复现步骤。
- 实际执行的自动化检查及结果。
- 当前不实现 refresh/logout 后端契约的明确说明。

## 五、普通页面纵向切片验收

每个页面 PR 应按实际需要同时交付：

- 前端路由、页面、表单、交互和响应式布局。
- GraphQL Query/Mutation 及前端 operation 类型。
- 后端 Resolver、Usecase、QueryService/同域 Service。
- 数据可见性与 `SUPER_ADMIN / ENGINEER / CUSTOMER` 权限。
- 加载、空数据、失败、无权限和重复提交处理。
- 后端单元测试/E2E 与前端组件或行为测试。
- 基于全量 Seed 的手工联调证据。

PR 建议保持一个页面或一个明确业务动作，不把多个无关页面塞进同一 PR。
