<!-- backend/docs/api/content-submission-rest-current.md -->

Purpose: Snapshot the current REST contract for content-submission private single-attachment upload / remove / download (A-PR0 §4.2, S3 delivery, S7 documented).
Read when: You change `src/adapters/api/rest/content-submission/`, the attachment usecases / storage contract, shared upload-boundary utilities, or the frontend attachment adapter.
Do not read when: You only change the content-submission GraphQL contract (`docs/api/content-submission-graphql-current.md`) or the reference-document upload/download contract (`docs/api/reference-document-rest-current.md`); the transport-layer utilities are shared but each capability keeps its own error-code boundary.
Source of truth: `src/adapters/api/rest/content-submission/content-submission-rest.controller.ts`、`src/usecases/content-submission/upload|remove|download-content-submission-attachment.usecase.ts`、`src/adapters/api/rest/shared/upload-boundary.util.ts`（与参考资料共用运输层工具）为可执行真源；错误码唯一真源 `src/core/common/errors/domain-error.ts`（`CONTENT_SUBMISSION_ERROR`），HTTP 映射 `src/core/common/errors/rest-error-status.ts`。
Global error contract: REST 边界不走 GraphQL error 契约；错误统一为 HTTP 状态码 + JSON 体 `{ statusCode, code, message }`（经全局 FormatResponseMiddleware 置于信封 `data` 字段）。

# Content Submission REST Contract（投稿私有单附件）

## 定位

- **单附件模型**（A-PR0 §3.1）：每投稿同时最多一份 `CURRENT` 附件；上传即替换（先退役旧 CURRENT 再登记新，同事务行锁串行化，T08 覆盖）；历史冻结引用保留，不删除存储文件。
- 控制器前缀 `api/content-submissions`（项目无全局 prefix），显式 `@UseGuards(JwtAuthGuard, RolesGuard)`，与 GraphQL resolver 同模式。
- **传输层粗筛 + usecase 精确裁决**：`@Roles` 只挡住明显未认证角色；精确权限（`activeRole`、本人/本组织归属）、状态裁决、存储编排与失败补偿全部归 usecase 层（授权先于任何文件 I/O，无权限请求绝不触盘）。
- 传输层工具与参考资料 REST **共用** `src/adapters/api/rest/shared/upload-boundary.util.ts`（latin1 文件名还原、展示用清洗、multipart 结构校验、DomainError→REST 错误体、下载头组装）；各域保留自己的错误码边界。
- 客户端不得传 `storageReference` / 服务器路径：存储引用由服务端随机生成，读取时做目录内断言（双保险防路径穿越）。

## POST /api/content-submissions/:id/attachment（上传 / 替换）

multipart/form-data；守卫 `@Roles(ENGINEER)`（usecase 内再以精确 `activeRole` 与本人归属裁决）。成功 HTTP **201**。

### 表单字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `file` | 是 | 二进制文件；缺失或非 Buffer → `UPLOAD_FILE_MISSING`（协议层与 usecase 层双重防御） |

### 可操作状态

仅本人 `DRAFT` / `RETURNED` 可上传或替换；`PENDING_REVIEW` / `PUBLISHED` → `STATE_NOT_EDITABLE`（HTTP 409）；不存在 / 他人投稿 / 跨组织统一 `NOT_FOUND`（HTTP 404，防探测）。

### 文件校验（不信任客户端）

- **大小**：以服务端实际接收字节数 `buffer.byteLength` 判定（不信任客户端声明值），业务上限与管理员上传**同源配置**（默认 20 MiB）；超限 → `UPLOAD_FILE_TOO_LARGE`（HTTP 413）。multer 硬上限 64 MiB 在传输层先行拦截（极端超大请求）。
- **类型**：以**扩展名**为主判定（不信任客户端 Content-Type）；扩展一一映射为 MIME 白名单（单一真源 `usecases/common/file-upload.contract.ts` 的 `EXTENSION_TO_MIME`），映射结果写入数据库 `mime_type`；白名单外 → `UPLOAD_FILE_TYPE_NOT_ALLOWED`（HTTP 415）。默认白名单与管理员上传一致（pdf / doc / docx / xls / xlsx / ppt / pptx / png / jpg / jpeg / txt / md / csv），env 可收窄。
- **文件名**：仅取 basename 并剔除控制字符与首尾空白后存 `original_filename`（≤255，空值回落「未命名文件」）；multipart filename 经 multer latin1 误码时先做 UTF-8 还原（中文文件名不乱码）。

### 原子性（编排归 usecase 层）

行锁内裁决归属与状态 → 校验通过后**先写存储**（服务端随机引用；失败 `CREATION_FAILED`）→ 再事务登记附件行（先退役旧 CURRENT 再登记新）。事务失败补偿不做「抛错=已回滚」假设（完成标记区分「COMMIT 未发出」与「COMMIT 结果不明」），以独立读取按本次精确存储引用核查附件占用：确认回滚且未被引用才精确删除，其余情况保留文件并记录精确引用供人工核查；补偿不覆盖原错误，不向客户端泄露存储引用。

### 成功响应

统一信封（全局 FormatResponseMiddleware）：

```json
{ "success": true, "data": { "attachmentId": 55, "originalFilename": "操作手册.pdf", "mimeType": "application/pdf", "byteSize": 10240 }, "requestId": "...", "host": "..." }
```

> 前端映射：`data.attachmentId` → 前端类型 `id`（`ContentSubmissionUploadedAttachment`，无 `uploadedAt`；详情回读以 GraphQL 元数据为准）。

## DELETE /api/content-submissions/:id/attachment（移除当前附件）

守卫 `@Roles(ENGINEER)`（usecase 精确裁决）。成功 HTTP **204**（无响应体）。

- 仅本人 `DRAFT` / `RETURNED` 可移除；其他状态 → `STATE_NOT_EDITABLE`（409）；不存在 / 他人 / 跨组织 → `NOT_FOUND`（404）。
- **只退役数据库记录**（`CURRENT` → `RETIRED`，写 `retired_at`），不删除存储文件；历史冻结版本引用保留（已发布正式引用不受影响）。
- 无当前附件时**幂等成功**（204）。

## GET /api/content-submissions/:id/attachments/:attachmentId/download（下载指定原件）

守卫 `@Roles(ENGINEER, SUPER_ADMIN)`（usecase 内裁决本人或本组织管理员）。成功 HTTP **200**。

- **必须校验附件属于该投稿**（复合外键同源事实）；不是只下载「当前文件」——历史 `RETIRED` 原件经授权同样可下载。
- 不存在 / 非授权范围 → `NOT_FOUND`（404，防探测）；存储对象缺失 / 引用不可用 → `FILE_NOT_AVAILABLE`（404，受控错误，不泄露服务器路径与存储引用）。
- 响应头：`Content-Type` 取 DB `mime_type`（不信任客户端）；`Content-Disposition: attachment; filename*=UTF-8''...`（RFC 5987 编码，`encodeURIComponent` 不转义的 `' * ( )` 补编码，防乱码与头注入）。
- 响应体：`StreamableFile` 流式返回文件字节；服务器绝对路径为实现私有细节，不出现在 usecase 结果、adapter 与响应中。

## 错误响应（REST 统一口径）

错误体为 HTTP 状态码 + `{ statusCode, code, message }`（经 FormatResponseMiddleware 包装为信封 `data` 字段；前端 `toRestErrorEnvelope` 解析）。由全局过滤器 HTTP 分支与 `resolveRestStatus` 统一渲染。

| 场景 | code | HTTP | 说明 |
| --- | --- | --- | --- |
| 未登录 / Token 失效 | `JWT_ERROR_*` / `AUTH_ERROR_*` 组 | 401 | 与 GraphQL 链路同口径（前端 401 走刷新重试一次，仍失败宣布会话失效） |
| 角色不满足（客户角色、非本人工程师） | `PERMISSION_ERROR` 组（`INSUFFICIENT_PERMISSIONS` 等） | 403 | 守卫与 usecase 双层 |
| 组织成员事实缺失 / 歧义（已认证的权限类拒绝） | `ORGANIZATION_NO_ACTIVE_MEMBERSHIP` / `ORGANIZATION_AMBIGUOUS_MEMBERSHIP` | 403 | 与 GraphQL `FORBIDDEN` 同语义 |
| 附件不可编辑（非本人 / 不存在 / 跨组织） | `CONTENT_SUBMISSION_NOT_FOUND` | 404 | 统一防探测 |
| 当前状态不允许变更附件 | `CONTENT_SUBMISSION_STATE_NOT_EDITABLE` | 409 | PENDING_REVIEW / PUBLISHED |
| multipart 缺文件 / 为空 | `CONTENT_SUBMISSION_UPLOAD_FILE_MISSING` | 400 | 协议层 + usecase 双层 |
| 超大小上限（服务端实际字节） | `CONTENT_SUBMISSION_UPLOAD_FILE_TOO_LARGE` | 413 | multer 硬上限亦为 413 |
| 白名单外类型（扩展名判定） | `CONTENT_SUBMISSION_UPLOAD_FILE_TYPE_NOT_ALLOWED` | 415 | 与管理员上传同白名单 |
| 存储对象缺失 / 引用不可用（仅下载） | `CONTENT_SUBMISSION_FILE_NOT_AVAILABLE` | 404 | 受控错误，不泄露路径 |
| 存储写入失败 / 落库失败 | `CONTENT_SUBMISSION_CREATION_FAILED` / `UPDATE_FAILED` | 500 | 系统侧，不泄露数据库细节 |
| 未登记错误码 | — | 500 | 兜底，不猜测语义 |

## 前端调用位置（S7 交付镜像）

`frontend/src/features/content-submission/infrastructure/content-submission-attachment-adapter.ts`（barrel 经 `features/content-submission/index.ts` 导出）：

| 端点 | 前端函数 | 失败原因（`reason`）映射 |
| --- | --- | --- |
| POST 上传 | `uploadContentSubmissionAttachment(submissionId, file)` | `not-found` / `invalid-input` / `file-too-large` / `file-type-not-allowed` / `state-conflict` / `forbidden` / `upload-failed`（兜底） |
| DELETE 移除 | `removeContentSubmissionAttachment(submissionId)` | `not-found` / `state-conflict` / `forbidden` / `remove-failed`（兜底） |
| GET 下载 | `downloadContentSubmissionAttachment(submissionId, attachmentId)` | `not-found` / `file-not-available` / `forbidden` / `download-failed`（兜底） |

- 带鉴权 REST 与响应信封解析复用 `shared/http`（Token 沿用 `configureGraphQLRuntime` 注入；401 与 GraphQL 链路同口径：刷新后重试一次，无刷新能力 / 刷新失败 / 重试仍 401 时宣布会话失效）。
- 下载经 fetch blob 触发浏览器保存（`parseAttachmentFilename` 解析 `filename*`，缺失回落兜底名）；不使用 `window.open` 直链。
- 上传/移除成功后调用方应以 GraphQL 详情回读附件元数据（REST 成功响应不含 `uploadedAt`）。

## 运行时配置

- 业务大小上限与 MIME 白名单与管理员上传**同源**（`REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES` / `REFERENCE_DOCUMENT_ALLOWED_MIME_TYPES`，见 `docs/api/reference-document-rest-current.md` 与 `env/.env.example`）；投稿域不另设第二套来源。
- multer 硬上限 `UPLOAD_HARD_LIMIT_BYTES = 64 MiB`（传输层防御，属共享边界工具常量）。
- 存储目录与参考资料共用同一本地存储实现（`storage_backend='local'`；`REFERENCE_DOCUMENT_STORAGE_DIR`，默认 `var/reference-documents`）。

## 真实调用样例（T19 附件链证据）

`test/11-content-submission/frontend-response-samples.e2e-spec.ts` 的 A2.2/A2.3（上传替换与移除的成功/失败形状）、A4.5（发布后正式文件下载头）与 `/tmp/s7-samples.json` 中的 REST 样例为准；完整调用序列见 `docs/database/PR0-S7交接材料与真实调用样例-20261020.md`。