# 新人本地开发环境初始化

本文档适用于首次 clone 光刻机智能运维平台的开发者。目标是在个人电脑上得到一套可登录、可联调且与团队数据库结构一致的本地环境。

## 1. 环境要求

- Git
- Node.js 22.19.0（仓库根目录 `.nvmrc` 已固定版本）
- npm
- MySQL 8.0
- Redis

MySQL 和 Redis 可以运行在每个人自己的电脑上。三个人不需要共用同一台数据库服务器；V13 正式部署工具应用仓库迁移，并可按显式配置初始化开发联调数据。

## 2. Clone 和安装依赖

```powershell
git clone https://github.com/litho-ai-support/lithography-platform.git
cd lithography-platform
npm run install:all
```

`npm run install:all` 使用前后端各自的 lockfile 执行 `npm ci`，不要在没有依赖变更的情况下重新生成 lockfile。

## 3. 创建个人数据库

在本地 MySQL 中创建专用开发库：

```sql
CREATE DATABASE lithography_drill
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
```

库名可按个人环境配置。首次初始化使用专用空库，将库名同时填入 V13 部署配置与后端运行配置。

## 4. 配置后端环境

```powershell
Copy-Item backend\env\.env.example backend\env\.env.development
```

`backend/env/.env.development` 被 Git 忽略，禁止提交。至少确认以下配置：

```dotenv
NODE_ENV=development
APP_HOST=127.0.0.1
APP_PORT=3000

APP_CORS_ENABLED=true
APP_CORS_ORIGINS=http://localhost:5173
APP_CORS_CREDENTIALS=true

GRAPHQL_SANDBOX_ENABLED=true
GRAPHQL_INTROSPECTION_ENABLED=true

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=<个人 MySQL 账号>
DB_PASS=<个人 MySQL 密码>
DB_NAME=lithography_drill
DB_TIMEZONE=+08:00
DB_POOL_SIZE=10
DB_SYNCHRONIZE=false
DB_LOGGING=false

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=15
REDIS_PASSWORD=
REDIS_TLS=false
BULLMQ_PREFIX=lithography

FIELD_ENCRYPTION_KEY=<团队开发环境字段加密 Key，至少 16 个字符>
FIELD_ENCRYPTION_IV=<团队开发环境字段加密 IV，至少 16 个字符>
JWT_SECRET=<团队开发环境 JWT 密钥>
JWT_EXPIRES_IN=2h
JWT_REFRESH_EXPIRES_IN=7d
JWT_ALGORITHM=HS256
JWT_ENABLE_REFRESH=false
JWT_ISSUER=lithography-local
JWT_AUDIENCE=DESKTOP,SSTSTEST,SSTSWEB,SSTSWEAPP,SJWEB,SJWEAPP
PAGINATION_HMAC_SECRET=<团队开发环境分页签名密钥>

AI_PROVIDER_MODE=mock
AI_QUEUE_DEBUG_ENABLED=false
EMAIL_QUEUE_DEBUG_ENABLED=false
```

负责人通过私密渠道提供以下团队开发值，不得写入 GitHub、Issue、PR 或日志：

- `FIELD_ENCRYPTION_KEY`
- `FIELD_ENCRYPTION_IV`
- `JWT_SECRET`
- `PAGINATION_HMAC_SECRET`

`FIELD_ENCRYPTION_KEY` 和 `FIELD_ENCRYPTION_IV` 必须与本机启动 API 时使用的值相同，否则 API 无法解密初始化账号时写入的 `meta_digest`，登录安全校验会失败。

## 5. 通过 V13 正式部署初始化个人开发库

按 [V13 正式部署 SOP](../database/v13-deployment/deployment-sop.md) 的「开发新库一键初始化」执行 `database:deploy --mode=init --environment=development`。使用已预建的专用空库，按 SOP 核对目标实例、库名和开发确认参数。当前的迁移与业务表终态见 [V13 正式交接说明](../database/v13-deployment/README.md)。已有数据的库按 SOP 的存量库升级流程判断和操作。

`DB_SYNCHRONIZE` 必须保持 `false`。旧版 14 表流程使用 `migration:drill:empty-db` 清库重建。该命令会删除指定库的全部表，仅用于专用可丢弃库的隔离演练。

## 6. 初始化用于本地登录的开发账号

按同一份 SOP 的「开发样例账号」配置组织与开发账号映射。开发样例默认关闭，需要联调时按 SOP 提供相应映射文件和确认参数。登录时使用本次映射中实际创建的工程师账号及其配置密码。旧版全量 `seed:mock` 及固定 `mock_*` 账号属于旧流程，本文的登录示例使用 V13 开发账号映射。

## 7. 启动后端并验证登录

确保 MySQL 和 Redis 均已启动。回到仓库根目录，执行：

```powershell
npm run dev:backend
```

默认地址：

- 健康检查：`http://127.0.0.1:3000/health`
- GraphQL Sandbox：`http://127.0.0.1:3000/graphql`

本项目后端使用 GraphQL Code First。开发者编写 DTO、Input、Resolver 和装配代码，NestJS 启动时自动生成 `backend/src/schema.graphql`。该生成文件被 Git 忽略，禁止手工维护或提交。

在 GraphQL Sandbox 中先验证登录：

```graphql
mutation Login($input: AuthLoginInput!) {
  login(input: $input) {
    accessToken
    refreshToken
    accountId
    role
    userInfo {
      accountId
      nickname
      accessGroup
    }
  }
}
```

变量：

```json
{
  "input": {
    "loginName": "填写开发账号映射中已初始化的工程师登录名",
    "loginPassword": "填写该开发账号的配置密码",
    "type": "PASSWORD",
    "audience": "SSTSWEB"
  }
}
```

登录成功必须返回 `accessToken`、`accountId`、`ENGINEER` 角色和用户信息。不要把真实 Token 贴进 PR。

## 8. 配置和启动前端

新开终端，在仓库根目录执行：

```powershell
Copy-Item frontend\env\.env.development.example frontend\env\.env.development.local
```

编辑 `frontend/env/.env.development.local`：

```dotenv
VITE_APP_ENV=dev
DEV_SERVER_HOST=localhost
DEV_SERVER_PORT=5173
DEV_SERVER_STRICT_PORT=false
VITE_GRAPHQL_ENDPOINT=http://127.0.0.1:3000/graphql
VITE_API_HEALTH_ENDPOINT=http://127.0.0.1:3000/health
VITE_API_READINESS_ENDPOINT=http://127.0.0.1:3000/health/readiness
```

启动前端：

```powershell
npm run dev:frontend
```

访问 `http://localhost:5173`。本地环境文件同样禁止提交。

## 9. 开始任务

每次从最新 `main` 创建短期分支：

```powershell
git switch main
git pull --ff-only
git switch -c feat/<page-or-scope>
```

只能推送功能分支并向 `main` 创建 PR，不得直接 push 或 force push `main`。页面任务按前端、GraphQL 契约、后端行为、权限和测试组成一个纵向切片，验收标准见 [任务验收标准](./task-acceptance.md)。

## 10. 运行后端 E2E（隔离测试库）

后端 E2E 的 `globalSetup` 会在跑测前清空目标库。为杜绝误毁开发数据，E2E **必须**使用与日常开发库（`lithography_drill`）物理隔离的专用可清空库 `lithography_e2e`，并配一个**只能操作该库**的受限账号（不要用具备全局权限的账号）。

### 10.1 创建隔离库与受限账号

```sql
-- 专用 E2E 库（可反复清空，不承载任何需保留数据）
CREATE DATABASE lithography_e2e
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

-- 专用 E2E 账号：仅授权 lithography_e2e，连不上也删不了 lithography_drill
CREATE USER 'litho_e2e'@'%' IDENTIFIED BY '<E2E 专用密码>';
GRANT ALL PRIVILEGES ON `lithography_e2e`.* TO 'litho_e2e'@'%';
FLUSH PRIVILEGES;
```

### 10.2 为 E2E 库建 schema（一次性）

E2E 只清数据、不建表。以下隔离演练命令会清空目标库的全部表再应用迁移，执行前确认实际连接的是第 10.1 节创建的专用可丢弃库 `lithography_e2e`。

```powershell
cd backend
$env:MIGRATION_DRILL_DOTENV='env/.env.e2e'
$env:MIGRATION_DRILL_DATABASE='lithography_e2e'
npm run migration:drill:empty-db
```

### 10.3 配置 `backend/env/.env.e2e`（被 Git 忽略，禁止提交）

```dotenv
NODE_ENV=e2e
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=litho_e2e
DB_PASS=<E2E 专用密码>
DB_NAME=lithography_e2e
DB_SYNCHRONIZE=false

# 全库清理的安全开关（见 10.4）
E2E_ALLOWED_DB_NAMES=lithography_e2e
E2E_ALLOW_DB_CLEANUP=1
```

其余密钥类变量（`FIELD_ENCRYPTION_*`、`JWT_SECRET`、`PAGINATION_HMAC_SECRET`、`MOCK_SEED_PASSWORD` 等）由负责人经私密渠道提供，与开发环境同值。

### 10.4 破坏性清理的守卫（必须理解）

`test/global-setup-e2e.ts` 在执行全库 `TRUNCATE` 前做两道**删数据之前**的硬校验：

1. **库名白名单**：实际连接的库必须属于 `E2E_ALLOWED_DB_NAMES`（默认 `lithography_e2e`）。不在白名单内即抛错退出，**任何开关都无法绕过此校验**——即使误设 `E2E_ALLOW_DB_CLEANUP=1`，只要 `DB_NAME` 指向非白名单库（例如 `lithography_drill`），也会在任何删除前拒绝。
2. **显式同意**：全库清理还需 `E2E_ALLOW_DB_CLEANUP=1`。

此外，全局清理**永不清空 Migration 执行记录表**（`migrations`），保证 schema 版本可追溯；`DB_SYNCHRONIZE` 必须保持 `false`。用例内部清理只按本用例创建的主键精确回收，不整表删除业务数据。

**用例级物理删除的第二道独立门禁**（`test/utils/e2e-db-guard.ts` 的 `assertPhysicalCleanupConsent`）：维修申请等会调用夹具物理清理入口的 spec，除了库名白名单外，还必须在启动前**由执行者显式**设置 `E2E_ALLOW_PHYSICAL_CLEANUP=1`。该开关：

- 只接受字面量 `1`，缺失或取其它值（`true`/`0`/`yes`/…）一律在任何删除语句之前失败关闭；
- 与库名白名单是两道**互相独立、互不替代**的门禁——许可函数不读取库名，库名函数也不读取许可，任一缺失都不能放行，任何开关也不能绕过另一道；
- 不写入任何 npm script，也**不放进 `env/.env.e2e` 模板**，必须由执行者在每次运行前显式导出（例如 `$env:E2E_ALLOW_PHYSICAL_CLEANUP=1` / `E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run …`），以免被环境文件自动带上而失去“显式同意”的含义。

### 10.5 执行

```powershell
# 全量 core 组（core 组内的维修申请 spec 会做夹具物理清理，须显式携带清理许可）
$env:E2E_ALLOW_PHYSICAL_CLEANUP=1; npm run test:e2e:core
# 或单个文件
$env:E2E_ALLOW_PHYSICAL_CLEANUP=1; npm run test:e2e:file -- test/10-admin-document-database/admin-document-database.e2e-spec.ts
```

## 11. 常见问题

- API 启动时报 Redis 连接失败：确认本机 Redis 已启动且端口、DB 与 `.env.development` 一致。
- API 启动时报字段加密配置缺失：补齐 `FIELD_ENCRYPTION_KEY` 和 `FIELD_ENCRYPTION_IV`。
- 开发账号登录失败时，确认账号已按 V13 SOP 初始化，核对实际连接库、登录配置以及部署与 API 使用的字段加密 Key/IV。
- 浏览器出现 CORS 错误：确认 `APP_CORS_ORIGINS` 与前端实际地址完全一致。
- GraphQL 返回 `UNAUTHENTICATED`：Token 缺失、过期或无效，清理本地 Session 后重新登录。
- 隔离演练拒绝数据库名时，先核对目标是否为专用可丢弃库。个人开发库初始化按第 5 节执行。
