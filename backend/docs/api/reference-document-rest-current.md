<!-- docs/api/reference-document-rest-current.md -->

Purpose: Snapshot the current REST file contract for the reference-document capability (任务 07: upload closed, authorized download kept).
Read when: You change the reference-document REST controller, file storage infrastructure, or download streaming behavior.
Do not read when: You only change the GraphQL contract of this capability (`docs/api/reference-document-graphql-current.md`) or the content-submission private attachment contract (`docs/api/content-submission-rest-current.md`); the transport-layer utilities are shared but each capability keeps its own error-code boundary.
Source of truth: `src/adapters/api/rest/reference-document/reference-document-rest.controller.ts`、`src/adapters/api/rest/shared/upload-boundary.util.ts`（上传工具与投稿附件共用）与 `src/infrastructure/file-storage/` 为可执行真源；HTTP 状态映射唯一真源 `src/core/common/errors/rest-error-status.ts`；本文记录必须保持稳定的契约。
Global error contract: REST 边界不走 GraphQL error 契约；错误统一为 HTTP 状态码 + JSON 体（见下）。

# Reference Document REST Contract（原件下载）

## 定位

- 控制器前缀 `api/reference-documents`（项目无全局 prefix），显式 `@UseGuards(JwtAuthGuard, RolesGuard)`，与 resolver 同模式。
- 浏览器鉴权使用 Authorization 头（与 GraphQL 同源桥接），前端下载经 fetch blob 触发保存，不用 `window.open` 直链。
- **上传入口已下线（任务 07）**：`POST /api/reference-documents/upload` 与 `CreateReferenceDocumentWithFileUsecase` 随「本期普通资料新增取消」一并移除，服务端不再接受生产侧文件写入，也不为 E2E 造数保留后门。请求该路径按未注册路由返回 HTTP 404；历史资料的原件授权下载能力保留。

## GET /api/reference-documents/:id/download

权限：SUPER_ADMIN / ENGINEER（`hasRole` 层级收窄——CUSTOMER 无页面访问权限，请求返回 HTTP 403 `INSUFFICIENT_PERMISSIONS`，与 GraphQL 读口径一致）。成功 HTTP 200。

可见范围与 GraphQL 列表/详情/历史版本完全同源（`resolveReferenceDocumentReadScope` + `ReferenceDocumentQueryService.findDetail`）：

- 读侧范围决议（2026-11-21 任务 06 权限修复，功能 V5.6 R057-01「工程师及2级限本公司，1级可跨公司」；与 GraphQL 列表/详情同一口径 `resolveReferenceDocumentReadScope`）：一级管理员（账号事实 `admin_level=1`）跨公司可下载全域已确认归属的正式资料，不按组织过滤且不依赖本人组织成员关系；工程师与二级管理员仅经可信组织上下文解析出的本公司资料（无有效成员关系 / 多关系歧义 → `ORGANIZATION_NO_ACTIVE_MEMBERSHIP` / `ORGANIZATION_AMBIGUOUS_MEMBERSHIP`，HTTP 403，与 GraphQL `FORBIDDEN` 同语义）。
- 统一 NOT_FOUND 口径：跨公司、下架（`OFFLINE`）、归属待核实（`PENDING`）、不存在 / 已软删 → `NOT_FOUND`（HTTP 404，防探测，不泄露存在性或状态）。
- 无 `storageReference`（纯文本资料）或存储对象缺失 → `FILE_NOT_AVAILABLE`（HTTP 404，受控错误，不泄露服务器路径）。
- 响应头：`Content-Type` 取 DB `mimeType`；`Content-Disposition: attachment; filename="..."; filename*=UTF-8''...`（RFC 5987 编码 `originalFilename`，中文不乱码）。
- 响应体：`StreamableFile` 流式返回文件字节；存储契约仅向用例层暴露只读内容流能力（`open`），服务器绝对路径为实现私有细节，不出现在 usecase 结果、adapter 与响应中。
- 存储引用由服务端生成（`^[0-9a-f]{32}\.[a-z0-9]{1,8}$` 白名单），读取时 `path.resolve` 后断言仍在存储目录内（双保险防路径穿越）；不接受任何客户端路径输入。

## 错误响应（REST 统一口径）

错误体为 HTTP 状态码 + `{ statusCode, code, message }`（经全局 FormatResponseMiddleware 包装为 `data` 字段）；由全局过滤器 HTTP 分支与 `resolveRestStatus`（`src/core/common/errors/rest-error-status.ts`）统一渲染，Nest `HttpException` 体系之外不走 GraphQL error 契约。

| code                                           | HTTP | 说明                                                     |
| ---------------------------------------------- | ---- | -------------------------------------------------------- |
| `JWT_ERROR` / `AUTH_ERROR` 组                  | 401  | 未登录 / Token 失效                                      |
| `PERMISSION_ERROR` 组                          | 403  | 角色不满足（如客户下载）                                 |
| `ORGANIZATION_ERROR` 组（成员事实缺失 / 歧义） | 403  | 已认证的权限类拒绝（与 GraphQL `FORBIDDEN` 同语义）      |
| `REFERENCE_DOCUMENT_INVALID_PARAMS`            | 400  | 资料 ID 非法                                             |
| `REFERENCE_DOCUMENT_NOT_FOUND`                 | 404  | 不存在 / 下架 / 未知归属 / 已软删 / 跨范围（统一防探测） |
| `REFERENCE_DOCUMENT_FILE_NOT_AVAILABLE`        | 404  | 无文件 / 存储对象缺失（受控）                            |
| 未登记错误                                     | 500  | 兜底                                                     |

## 运行时配置（env，缺省兜底，见 `env/.env.example`）

- `REFERENCE_DOCUMENT_STORAGE_DIR`：存储目录，相对 backend 运行目录，默认 `var/reference-documents`（`var/` 已 gitignore）。
- `REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES`：单文件字节上限，默认 20 MiB。资料库上传入口已下线，本项现由投稿附件上传（`docs/api/content-submission-rest-current.md`）等仍存在的写入链路共用。
- `REFERENCE_DOCUMENT_ALLOWED_MIME_TYPES`：逗号分隔白名单，空取内置默认集合；同上，供仍存在的写入链路共用。

> 投稿私有单附件（工程师上传 / 移除 / 下载）契约见 `docs/api/content-submission-rest-current.md`：共用 `upload-boundary.util.ts` 运输层工具与 `REFERENCE_DOCUMENT_*` 运行时配置，各域保留独立错误码边界。
