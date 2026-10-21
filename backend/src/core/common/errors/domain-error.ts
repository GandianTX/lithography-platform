// src/core/common/errors/domain-error.ts
// 领域错误与错误码：跨层共享的核心错误定义

/**
 * 领域错误类
 * 用于表示业务逻辑层的错误，可在 Service、Usecase 和 Adapter 层之间传递
 */
export class DomainError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly cause?: unknown;

  constructor(code: string, message: string, details?: unknown, cause?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
    this.cause = cause;

    // 兼容某些编译目标/测试环境的原型链问题，确保 instanceof 正常
    Object.setPrototypeOf(this, new.target.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DomainError);
    }
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

// 认证相关错误码（登录/刷新/鉴权）
export const AUTH_ERROR = {
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  ACCOUNT_BANNED: 'ACCOUNT_BANNED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  INVALID_PASSWORD: 'INVALID_PASSWORD',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  INVALID_AUDIENCE: 'INVALID_AUDIENCE',
  PERMISSION_MISMATCH: 'AUTH_PERMISSION_MISMATCH',
} as const;
Object.freeze(AUTH_ERROR);

// 账户领域错误码（账户资料/唯一性约束等）
export const ACCOUNT_ERROR = {
  ACCOUNT_ALREADY_EXISTS: 'ACCOUNT_ALREADY_EXISTS',
  NICKNAME_ALREADY_EXISTS: 'NICKNAME_ALREADY_EXISTS',
  REGISTRATION_FAILED: 'REGISTRATION_FAILED',
  OPERATION_NOT_SUPPORTED: 'OPERATION_NOT_SUPPORTED',
  ACCOUNT_NOT_FOUND: AUTH_ERROR.ACCOUNT_NOT_FOUND, // 复用同一码值，避免前端分裂
  NICKNAME_TAKEN: 'NICKNAME_TAKEN',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  USER_INFO_NOT_FOUND: 'USER_INFO_NOT_FOUND',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  /** 创建入口：account.status 与 userInfo.userState 不一致，或 status 无对应 UserState（BANNED / DELETED） */
  ACCOUNT_STATUS_STATE_MISMATCH: 'ACCOUNT_STATUS_STATE_MISMATCH',
} as const;
Object.freeze(ACCOUNT_ERROR);

// 第三方认证相关错误码
// 在 THIRDPARTY_ERROR 中添加新的错误码
export const THIRDPARTY_ERROR = {
  CREDENTIAL_INVALID: 'THIRDPARTY_CREDENTIAL_INVALID',
  ACCOUNT_NOT_BOUND: 'THIRDPARTY_ACCOUNT_NOT_BOUND',
  LOGIN_FAILED: 'THIRDPARTY_LOGIN_FAILED',
  BIND_FAILED: 'THIRDPARTY_BIND_FAILED',
  UNBIND_FAILED: 'THIRDPARTY_UNBIND_FAILED',
  PROVIDER_NOT_SUPPORTED: 'THIRDPARTY_PROVIDER_NOT_SUPPORTED',
  ACCOUNT_ALREADY_BOUND: 'THIRDPARTY_ACCOUNT_ALREADY_BOUND',
  REGISTRATION_FAILED: 'THIRDPARTY_REGISTRATION_FAILED', // 第三方注册失败
  INVALID_AUDIENCE: 'THIRDPARTY_INVALID_AUDIENCE',
  INVALID_USER_INFO: 'THIRDPARTY_INVALID_USER_INFO',
  NICKNAME_INVALID: 'THIRDPARTY_NICKNAME_INVALID',
  INVALID_PARAMS: 'THIRDPARTY_INVALID_PARAMS',
  // 新增的错误码
  USER_NOT_FOUND: 'THIRDPARTY_USER_NOT_FOUND',
  PROVIDER_API_ERROR: 'THIRDPARTY_PROVIDER_API_ERROR',
  UNKNOWN_ERROR: 'THIRDPARTY_UNKNOWN_ERROR',
  INVALID_CREDENTIAL: 'THIRDPARTY_CREDENTIAL_INVALID', // 映射到现有的 CREDENTIAL_INVALID
  PROVIDER_CONFIG_MISSING: 'THIRDPARTY_PROVIDER_CONFIG_MISSING',
} as const;
Object.freeze(THIRDPARTY_ERROR);

// JWT 相关错误码（Token 生成、验证、解析等）
export const JWT_ERROR = {
  TOKEN_EXPIRED: 'JWT_TOKEN_EXPIRED',
  TOKEN_INVALID: 'JWT_TOKEN_INVALID',
  TOKEN_NOT_BEFORE: 'JWT_TOKEN_NOT_BEFORE',
  TOKEN_GENERATION_FAILED: 'JWT_TOKEN_GENERATION_FAILED',
  TOKEN_VERIFICATION_FAILED: 'JWT_TOKEN_VERIFICATION_FAILED',
  ACCESS_TOKEN_GENERATION_FAILED: 'JWT_ACCESS_TOKEN_GENERATION_FAILED',
  REFRESH_TOKEN_GENERATION_FAILED: 'JWT_REFRESH_TOKEN_GENERATION_FAILED',
  AUTHENTICATION_FAILED: 'JWT_AUTHENTICATION_FAILED',
} as const;
Object.freeze(JWT_ERROR);

// 权限相关错误码（角色权限、访问控制等）
export const PERMISSION_ERROR = {
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  ACCESS_DENIED: 'ACCESS_DENIED',
  ROLE_REQUIRED: 'ROLE_REQUIRED',
} as const;
Object.freeze(PERMISSION_ERROR);

// 验证记录相关错误码
export const VERIFICATION_RECORD_ERROR = {
  CREATION_FAILED: 'VERIFICATION_RECORD_CREATION_FAILED',
  QUERY_FAILED: 'VERIFICATION_RECORD_QUERY_FAILED',
  RECORD_NOT_FOUND: 'VERIFICATION_RECORD_NOT_FOUND',
  RECORD_NOT_ACTIVE: 'VERIFICATION_RECORD_NOT_ACTIVE',
  RECORD_EXPIRED: 'VERIFICATION_RECORD_EXPIRED',
  RECORD_NOT_ACTIVE_YET: 'VERIFICATION_RECORD_NOT_ACTIVE_YET',
  RECORD_ALREADY_CONSUMED: 'VERIFICATION_RECORD_ALREADY_CONSUMED',
  INVALID_TOKEN: 'VERIFICATION_RECORD_INVALID_TOKEN',
  TARGET_ACCOUNT_MISMATCH: 'VERIFICATION_RECORD_TARGET_ACCOUNT_MISMATCH',
  TYPE_MISMATCH: 'VERIFICATION_RECORD_TYPE_MISMATCH',
  UPDATE_FAILED: 'VERIFICATION_RECORD_UPDATE_FAILED',
  STATUS_NOT_ALLOWED: 'VERIFICATION_RECORD_STATUS_NOT_ALLOWED',
  CONSUMPTION_FAILED: 'VERIFICATION_RECORD_CONSUMPTION_FAILED',
  REVOCATION_FAILED: 'VERIFICATION_RECORD_REVOCATION_FAILED',
  VERIFICATION_INVALID: 'VERIFICATION_RECORD_VERIFICATION_INVALID',
  INVALID_PARAMS: 'VERIFICATION_RECORD_INVALID_PARAMS',
  INVALID_TYPE: 'VERIFICATION_RECORD_INVALID_TYPE',
  CONTEXT_MISMATCH: 'VERIFICATION_RECORD_CONTEXT_MISMATCH',
  HANDLER_CONFLICT: 'VERIFICATION_RECORD_HANDLER_CONFLICT',
  OPERATION_NOT_SUPPORTED: 'VERIFICATION_RECORD_OPERATION_NOT_SUPPORTED',
} as const;
Object.freeze(VERIFICATION_RECORD_ERROR);

// 异步任务记录相关错误码
export const ASYNC_TASK_RECORD_ERROR = {
  INVALID_PARAMS: 'ASYNC_TASK_RECORD_INVALID_PARAMS',
} as const;
Object.freeze(ASYNC_TASK_RECORD_ERROR);

export const CAPABILITY_ERROR = {
  UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
} as const;
Object.freeze(CAPABILITY_ERROR);

export const AI_WORKFLOW_CONTEXT_ERROR = {
  INVALID_PARAMS: 'AI_WORKFLOW_CONTEXT_INVALID_PARAMS',
  NOT_FOUND: 'AI_WORKFLOW_CONTEXT_NOT_FOUND',
  CREATE_FAILED: 'AI_WORKFLOW_CONTEXT_CREATE_FAILED',
  READ_FAILED: 'AI_WORKFLOW_CONTEXT_READ_FAILED',
  UPDATE_FAILED: 'AI_WORKFLOW_CONTEXT_UPDATE_FAILED',
  PAYLOAD_INVALID: 'AI_WORKFLOW_CONTEXT_PAYLOAD_INVALID',
  PAYLOAD_TOO_LARGE: 'AI_WORKFLOW_CONTEXT_PAYLOAD_TOO_LARGE',
} as const;
Object.freeze(AI_WORKFLOW_CONTEXT_ERROR);

export const TIME_ERROR = {
  INVALID_TIME_INPUT: 'TIME_INVALID_TIME_INPUT',
  INVALID_SYSTEM_EVENT_TIME: 'TIME_INVALID_SYSTEM_EVENT_TIME',
  INVALID_BUSINESS_DATETIME: 'TIME_INVALID_BUSINESS_DATETIME',
  INVALID_TIME_RANGE_ORDER: 'TIME_INVALID_TIME_RANGE_ORDER',
} as const;
Object.freeze(TIME_ERROR);

// 维修申请相关错误码（客户创建/删除、设备型号校验、工程师接单/回复等）
export const REPAIR_REQUEST_ERROR = {
  CREATION_FAILED: 'REPAIR_REQUEST_CREATION_FAILED',
  INVALID_PARAMS: 'REPAIR_REQUEST_INVALID_PARAMS',
  EQUIPMENT_MODEL_NOT_FOUND: 'REPAIR_REQUEST_EQUIPMENT_MODEL_NOT_FOUND',
  EQUIPMENT_MODEL_DISABLED: 'REPAIR_REQUEST_EQUIPMENT_MODEL_DISABLED',
  // 唯一索引冲突（并发写入同一申请编号），由 usecase 内部重试消化，外泄时属系统异常
  REQUEST_NO_CONFLICT: 'REPAIR_REQUEST_REQUEST_NO_CONFLICT',
  // 读取/删除/接单：目标不可访问时统一使用 NOT_FOUND，避免泄露归属和删除状态
  NOT_FOUND: 'REPAIR_REQUEST_NOT_FOUND',
  // 删除/接单：申请已被接单（不泄露接单人身份，对外大类 CONFLICT）
  ALREADY_ACCEPTED: 'REPAIR_REQUEST_ALREADY_ACCEPTED',
  // 接单：系统侧写入失败，不向客户端泄漏数据库细节（对外大类 INTERNAL_SERVER_ERROR）
  ACCEPT_FAILED: 'REPAIR_REQUEST_ACCEPT_FAILED',
  // 软删除落库失败（系统侧故障，非业务拒绝）
  DELETION_FAILED: 'REPAIR_REQUEST_DELETION_FAILED',
  // 回复：目标申请存在但尚未接单（业务状态冲突，提示先接单后回复；对外大类 CONFLICT）
  NOT_ACCEPTED: 'REPAIR_REQUEST_NOT_ACCEPTED',
  // 回复：系统侧写入失败，不向客户端泄漏数据库细节（对外大类 INTERNAL_SERVER_ERROR）
  RESPONSE_FAILED: 'REPAIR_REQUEST_RESPONSE_FAILED',
} as const;
Object.freeze(REPAIR_REQUEST_ERROR);

// AI 参考资料库相关错误码（资料录入/编辑/软删除，负责人 0907.docx 任务二）
export const REFERENCE_DOCUMENT_ERROR = {
  INVALID_PARAMS: 'REFERENCE_DOCUMENT_INVALID_PARAMS',
  // 指定设备型号不存在（应用层预检给出友好错误，不依赖 RESTRICT 外键裸报错）
  EQUIPMENT_MODEL_NOT_FOUND: 'REFERENCE_DOCUMENT_EQUIPMENT_MODEL_NOT_FOUND',
  // 读取/编辑/软删除：目标不可访问时统一使用 NOT_FOUND，避免泄露删除状态
  // （负责人 docx 验收标准：不存在或已软删除的资料返回统一的 NOT_FOUND）
  NOT_FOUND: 'REFERENCE_DOCUMENT_NOT_FOUND',
  // 系统侧落库失败，不向客户端泄漏数据库细节
  CREATION_FAILED: 'REFERENCE_DOCUMENT_CREATION_FAILED',
  UPDATE_FAILED: 'REFERENCE_DOCUMENT_UPDATE_FAILED',
  DELETION_FAILED: 'REFERENCE_DOCUMENT_DELETION_FAILED',
  // 文件上传（REST multipart，仅 SUPER_ADMIN）：服务端判定，不信任客户端 MIME 头
  UPLOAD_FILE_MISSING: 'REFERENCE_DOCUMENT_UPLOAD_FILE_MISSING',
  UPLOAD_FILE_TOO_LARGE: 'REFERENCE_DOCUMENT_UPLOAD_FILE_TOO_LARGE',
  UPLOAD_FILE_TYPE_NOT_ALLOWED: 'REFERENCE_DOCUMENT_UPLOAD_FILE_TYPE_NOT_ALLOWED',
  // 内容来源双空：正文与文件至少存在一个（落库层 chk_reference_document_content_source 兜底）
  CONTENT_SOURCE_EMPTY: 'REFERENCE_DOCUMENT_CONTENT_SOURCE_EMPTY',
  // 下载：存储对象缺失/不可读等存储侧失败，不泄漏服务器路径与存储引用
  FILE_NOT_AVAILABLE: 'REFERENCE_DOCUMENT_FILE_NOT_AVAILABLE',
} as const;
Object.freeze(REFERENCE_DOCUMENT_ERROR);
// 管理员用户管理相关错误码（管理员列表读取、管理员创建普通用户等）
// 刻意不复用 `AUTH_ERROR.*` / `JWT_ERROR.*`：那些码被全局过滤器映射为 `UNAUTHENTICATED`，
// 会让前端把「管理员输入/目标问题」误判为 Session 失效并清理会话跳转登录页
// （`docs/api/graphql-error-contract-current.md`：input / not-found 不得塌缩为 `UNAUTHENTICATED`）。
// 也不复用 `ACCOUNT_ERROR.ACCOUNT_NOT_FOUND`（与 `AUTH_ERROR.ACCOUNT_NOT_FOUND` 同码值→ `UNAUTHENTICATED`）
// 与 `ACCOUNT_ERROR.ACCOUNT_ALREADY_EXISTS`（未入映射表，会落默认 `BAD_USER_INPUT`）。
export const ADMIN_USER_ERROR = {
  // 创建：登录名/登录邮箱命中数据库唯一索引（`uk_login_name` / `uk_login_email`）的并发竞争，
  // 不向客户端泄露驱动错误与索引名（对外大类 CONFLICT）
  CREDENTIAL_CONFLICT: 'ADMIN_USER_CREDENTIAL_CONFLICT',
  // 读/写：系统侧读取失败或读到的账号资料不变量被破坏（对外大类 INTERNAL_SERVER_ERROR）
  READ_FAILED: 'ADMIN_USER_READ_FAILED',
  // 创建：系统侧写入失败（非唯一冲突），不向客户端泄露数据库细节（对外大类 INTERNAL_SERVER_ERROR）
  WRITE_FAILED: 'ADMIN_USER_WRITE_FAILED',
  // 读取：`identity_hint` / `access_group` / `meta_digest` 不能收敛为同一个唯一角色。
  // 按负责人裁决失败关闭：整次查询失败，不返回部分列表、不排除异常行、不兜底、不静默修复；
  // 对外只表达通用大类 INTERNAL_SERVER_ERROR，且 `details` 必须为空，
  // 不得泄露异常账号 ID、三源角色原值或内部错误细节
  ROLE_DATA_INCONSISTENT: 'ADMIN_USER_ROLE_DATA_INCONSISTENT',
  // 资料编辑 / 状态修改（P0-4 起的写用例共用）：目标账号不存在。
  // 不复用 ACCOUNT_ERROR.ACCOUNT_NOT_FOUND（与 AUTH_ERROR.ACCOUNT_NOT_FOUND 同码值，
  // 会被过滤器映射为 UNAUTHENTICATED，违反错误契约「not-found 不得塌缩为 UNAUTHENTICATED」）；
  // 对外大类 NOT_FOUND，details 留空，目标 ID 由调用方已知，无需回显
  TARGET_NOT_FOUND: 'ADMIN_USER_TARGET_NOT_FOUND',
  // 状态修改（P0-5）：目标账号的当前双字段状态不允许进入请求的目标状态
  // 当前状态为 PENDING / SUSPENDED / BANNED / DELETED 等不可转换值（含无法识别的值）、
  // account.status 与 userInfo.user_state 不一致。对外大类 CONFLICT：
  // 请求的目标状态本身合法（非 BAD_USER_INPUT）、管理员权限无问题（非 FORBIDDEN）、
  // 这是明确的当前状态冲突（非系统侧 5xx）。details 留空，
  // 当前状态事实只进 cause.diagnostic 供服务端排查，不进对外响应
  STATUS_TRANSITION_NOT_ALLOWED: 'ADMIN_USER_STATUS_TRANSITION_NOT_ALLOWED',
  // 密码重置（P0-6 / R11-2）：目标账号的当前双字段状态不允许重置密码。只允许双字段
  // SUSPENDED / BANNED / DELETED 等不可重置值（含无法识别的值）与双字段不一致。
  // 刻意不复用 STATUS_TRANSITION_NOT_ALLOWED：该码专指启停状态转换矩阵，不是密码重置。
  // 对外大类 CONFLICT（口径与 STATUS_TRANSITION_NOT_ALLOWED 同源：请求动作本身合法、
  // 管理员权限无问题、这是明确的当前状态冲突）；details 留空，
  // 当前状态事实只进 cause.diagnostic 供服务端排查，不进对外响应
  PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED: 'ADMIN_USER_PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED',
} as const;
Object.freeze(ADMIN_USER_ERROR);

/**
 * 当前用户账号设置（自助场景，P2/P3）写链路专用错误码。
 *
 * 与 `ADMIN_USER_ERROR` 的关系：自助设置不复用
 * admin 命名的 DTO / Command / View 作为公开契约，可复用其「底层事实与设计经验」；
 * 系统侧读写失败没有自助语义，继续复用 `ADMIN_USER_ERROR.READ_FAILED` / `WRITE_FAILED`
 * （P1 已确立的先例，见 `AccountQueryService.toMyAccountSettingsSnapshot()` 注释），
 * 本目录只收管理员场景**没有**的三类自助语义：
 *
 * - `LOGIN_CREDENTIAL_BOTH_EMPTY`：合并当前值后登录名与登录邮箱双空（「至少保留一个登录
 *   方式」被违反）。判定发生在锁内合并之后（输入层无法裁决——用户清空一个凭据时另一个
 *   可能早已为空），因此不是纯输入收敛错误，但对外仍按客户端输入类表达，
 *   映射 `BAD_USER_INPUT`，不得使用 `AUTH_ERROR.*` / `JWT_ERROR.*`（UNAUTHENTICATED）；
 * - `CREDENTIAL_CONFLICT`：登录名 / 登录邮箱被其他账号占用。语义与
 *   `ADMIN_USER_ERROR.CREDENTIAL_CONFLICT` 同构但场景不同（自助改自己的 vs 管理员改他人的），
 *   独立收码、独立映射 CONFLICT，错误文案可定位到字段；不携带被占用者的任何身份信息；
 * - `CURRENT_PASSWORD_MISMATCH`：当前密码验证未通过（含 `verifyPassword()` 的
 *   `preprocessPassword` 对首尾空白 / 纯空白抛 `AUTH_ERROR.INVALID_PASSWORD` 的收敛——
 *   该码映射 `UNAUTHENTICATED`，会让前端误判会话失效并清理 Session 跳转登录页，
 *   而此类输入形态不可能是正确密码，收敛为「当前密码不正确」语义等价且安全）。
 *   映射 `BAD_USER_INPUT`（当前密码不正确不得触发全局 Session 失效跳转）。
 *
 * `details` 一律留空：字段级提示走 `message`，账号主键与诊断分类只进 `DomainError.cause`
 * （全局过滤器不序列化 `cause`）。
 */
export const MY_ACCOUNT_ERROR = {
  LOGIN_CREDENTIAL_BOTH_EMPTY: 'MY_ACCOUNT_LOGIN_CREDENTIAL_BOTH_EMPTY',
  CREDENTIAL_CONFLICT: 'MY_ACCOUNT_CREDENTIAL_CONFLICT',
  CURRENT_PASSWORD_MISMATCH: 'MY_ACCOUNT_CURRENT_PASSWORD_MISMATCH',
} as const;
Object.freeze(MY_ACCOUNT_ERROR);

// 管理员文档数据库聚合读相关错误码（PR3 只读：维修申请摘要 / AI 会话 / AI 消息 / AI 报告）
// 刻意不复用 REPAIR_REQUEST_ERROR / REFERENCE_DOCUMENT_ERROR：那些码归属既有客户/工程师读链路，
// 管理员聚合读的拒绝口径与既有链路保持独立，避免语义漂移与前端误判。
export const ADMIN_DOCUMENT_DATABASE_ERROR = {
  INVALID_PARAMS: 'ADMIN_DOCUMENT_DATABASE_INVALID_PARAMS',
  // 目标（维修申请摘要 / AI 报告详情）不存在或已软删时统一 NOT_FOUND，不泄露删除状态
  NOT_FOUND: 'ADMIN_DOCUMENT_DATABASE_NOT_FOUND',
} as const;
Object.freeze(ADMIN_DOCUMENT_DATABASE_ERROR);

export const INPUT_NORMALIZE_ERROR = {
  INVALID_TEXT: 'INPUT_NORMALIZE_INVALID_TEXT',
  REQUIRED_TEXT_EMPTY: 'INPUT_NORMALIZE_REQUIRED_TEXT_EMPTY',
  OPTIONAL_TEXT_EMPTY_REJECTED: 'INPUT_NORMALIZE_OPTIONAL_TEXT_EMPTY_REJECTED',
  INVALID_TEXT_LIST: 'INPUT_NORMALIZE_INVALID_TEXT_LIST',
  INVALID_TEXT_LIST_ITEM: 'INPUT_NORMALIZE_INVALID_TEXT_LIST_ITEM',
  EMPTY_LIST_REJECTED: 'INPUT_NORMALIZE_EMPTY_LIST_REJECTED',
  INVALID_LIMIT_RANGE: 'INPUT_NORMALIZE_INVALID_LIMIT_RANGE',
  INVALID_LIMIT_VALUE: 'INPUT_NORMALIZE_INVALID_LIMIT_VALUE',
  INVALID_ENUM_VALUE: 'INPUT_NORMALIZE_INVALID_ENUM_VALUE',
} as const;
Object.freeze(INPUT_NORMALIZE_ERROR);

// 可信组织上下文相关错误码（A-PR0 计划 §2.1：组织成员事实解析）
// 语义：账号已通过认证，但组织成员事实不满足操作要求——属权限类拒绝。
// 刻意不复用 AUTH_ERROR.* / JWT_ERROR.*：那些码会被全局过滤器映射为 UNAUTHENTICATED，
// 使前端把「组织事实缺失」误判为会话失效并清理 Session 跳转登录页
// （docs/api/graphql-error-contract-current.md：已认证用户的权限失败保持 FORBIDDEN）。
export const ORGANIZATION_ERROR = {
  // 无任何有效组织成员关系（成员 ACTIVE 且组织 ACTIVE）：拒绝一切组织范围操作，不回退全库
  NO_ACTIVE_MEMBERSHIP: 'ORGANIZATION_NO_ACTIVE_MEMBERSHIP',
  // 多个有效成员关系且无可信组织上下文：拒绝歧义请求（本期不提供组织选择 UI）
  AMBIGUOUS_MEMBERSHIP: 'ORGANIZATION_AMBIGUOUS_MEMBERSHIP',
} as const;
Object.freeze(ORGANIZATION_ERROR);

// 内容投稿相关错误码（A-PR0 计划 §2.2/§2.3：两类草稿、本人查询；S3 起）
// 语义边界：
// - 输入类（INVALID_PARAMS / DRAFT_EMPTY）：对外 BAD_USER_INPUT，不得使用
//   AUTH/JWT 码（会被映射为 UNAUTHENTICATED，前端误判会话失效）；
// - 目标不可访问（NOT_FOUND）：不存在、他人投稿、跨组织统一同码，
//   不泄露他人投稿的存在性（同组织其他工程师的投稿也不是公开数据）；
// - 状态冲突（STATE_NOT_EDITABLE）：目标本身存在且可识别，但当前状态
//   （PENDING_REVIEW / PUBLISHED）不允许编辑操作，对外 CONFLICT；
// - 系统侧（CREATION_FAILED / UPDATE_FAILED / READ_FAILED）：落库、锁读与不定式读取
//   失败，不泄露数据库细节。
export const CONTENT_SUBMISSION_ERROR = {
  // 字段超长、机型与机型文字并存、扩展 JSON 含 v1 未定义键等输入非法
  INVALID_PARAMS: 'CONTENT_SUBMISSION_INVALID_PARAMS',
  // 草稿无任何已填写文字业务字段（只有默认状态或本地选文件不算已填写）
  DRAFT_EMPTY: 'CONTENT_SUBMISSION_DRAFT_EMPTY',
  // 指定设备型号不存在（应用层预检，不依赖 RESTRICT 外键裸报错）
  EQUIPMENT_MODEL_NOT_FOUND: 'CONTENT_SUBMISSION_EQUIPMENT_MODEL_NOT_FOUND',
  // 不存在/他人投稿/跨组织统一 NOT_FOUND，不泄露存在性
  NOT_FOUND: 'CONTENT_SUBMISSION_NOT_FOUND',
  // 当前状态不允许该操作（PENDING_REVIEW 只读、PUBLISHED 不可改稿）
  STATE_NOT_EDITABLE: 'CONTENT_SUBMISSION_STATE_NOT_EDITABLE',
  // 附件上传：multipart 文件缺失/为空（协议层与用例层双重防御）
  UPLOAD_FILE_MISSING: 'CONTENT_SUBMISSION_UPLOAD_FILE_MISSING',
  // 附件上传：实际字节数超过配置上限（不信任客户端声明值；与管理员上传同源配置）
  UPLOAD_FILE_TOO_LARGE: 'CONTENT_SUBMISSION_UPLOAD_FILE_TOO_LARGE',
  // 附件上传：扩展名不在白名单（以扩展名为主判定，不信任客户端 MIME 头）
  UPLOAD_FILE_TYPE_NOT_ALLOWED: 'CONTENT_SUBMISSION_UPLOAD_FILE_TYPE_NOT_ALLOWED',
  // 附件下载：存储对象缺失/引用不可用（不泄露服务器路径与存储引用）
  FILE_NOT_AVAILABLE: 'CONTENT_SUBMISSION_FILE_NOT_AVAILABLE',
  // 系统侧：创建/更新/锁读失败，不向客户端泄漏数据库细节
  CREATION_FAILED: 'CONTENT_SUBMISSION_CREATION_FAILED',
  UPDATE_FAILED: 'CONTENT_SUBMISSION_UPDATE_FAILED',
  // 系统侧：读取到不定式被破坏的数据（如 1:1 明细行缺失），失败关闭而非静默容忍
  READ_FAILED: 'CONTENT_SUBMISSION_READ_FAILED',
} as const;
Object.freeze(CONTENT_SUBMISSION_ERROR);

// 类型定义
export type AuthErrorCode = (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR];
export type AccountErrorCode = (typeof ACCOUNT_ERROR)[keyof typeof ACCOUNT_ERROR];
export type ThirdPartyErrorCode = (typeof THIRDPARTY_ERROR)[keyof typeof THIRDPARTY_ERROR];
export type JwtErrorCode = (typeof JWT_ERROR)[keyof typeof JWT_ERROR];
export type PermissionErrorCode = (typeof PERMISSION_ERROR)[keyof typeof PERMISSION_ERROR];
export type VerificationRecordErrorCode =
  (typeof VERIFICATION_RECORD_ERROR)[keyof typeof VERIFICATION_RECORD_ERROR];
export type AsyncTaskRecordErrorCode =
  (typeof ASYNC_TASK_RECORD_ERROR)[keyof typeof ASYNC_TASK_RECORD_ERROR];
export type CapabilityErrorCode = (typeof CAPABILITY_ERROR)[keyof typeof CAPABILITY_ERROR];
export type AiWorkflowContextErrorCode =
  (typeof AI_WORKFLOW_CONTEXT_ERROR)[keyof typeof AI_WORKFLOW_CONTEXT_ERROR];
export type TimeErrorCode = (typeof TIME_ERROR)[keyof typeof TIME_ERROR];
export type RepairRequestErrorCode =
  (typeof REPAIR_REQUEST_ERROR)[keyof typeof REPAIR_REQUEST_ERROR];
export type ReferenceDocumentErrorCode =
  (typeof REFERENCE_DOCUMENT_ERROR)[keyof typeof REFERENCE_DOCUMENT_ERROR];
export type AdminUserErrorCode = (typeof ADMIN_USER_ERROR)[keyof typeof ADMIN_USER_ERROR];
export type MyAccountErrorCode = (typeof MY_ACCOUNT_ERROR)[keyof typeof MY_ACCOUNT_ERROR];
export type AdminDocumentDatabaseErrorCode =
  (typeof ADMIN_DOCUMENT_DATABASE_ERROR)[keyof typeof ADMIN_DOCUMENT_DATABASE_ERROR];
export type InputNormalizeErrorCode =
  (typeof INPUT_NORMALIZE_ERROR)[keyof typeof INPUT_NORMALIZE_ERROR];
export type OrganizationErrorCode = (typeof ORGANIZATION_ERROR)[keyof typeof ORGANIZATION_ERROR];
export type ContentSubmissionErrorCode =
  (typeof CONTENT_SUBMISSION_ERROR)[keyof typeof CONTENT_SUBMISSION_ERROR];

// 分页相关错误码
export const PAGINATION_ERROR = {
  INVALID_PAGE_SIZE: 'PAGINATION_INVALID_PAGE_SIZE',
  INVALID_CURSOR: 'PAGINATION_INVALID_CURSOR',
  SORT_FIELD_NOT_ALLOWED: 'PAGINATION_SORT_FIELD_NOT_ALLOWED',
  DB_QUERY_FAILED: 'PAGINATION_DB_QUERY_FAILED',
} as const;
Object.freeze(PAGINATION_ERROR);

export type PaginationErrorCode = (typeof PAGINATION_ERROR)[keyof typeof PAGINATION_ERROR];
export type DomainErrorCode =
  | AuthErrorCode
  | AccountErrorCode
  | ThirdPartyErrorCode
  | JwtErrorCode
  | PermissionErrorCode
  | VerificationRecordErrorCode
  | AsyncTaskRecordErrorCode
  | CapabilityErrorCode
  | AiWorkflowContextErrorCode
  | TimeErrorCode
  | RepairRequestErrorCode
  | ReferenceDocumentErrorCode
  | AdminUserErrorCode
  | MyAccountErrorCode
  | AdminDocumentDatabaseErrorCode
  | InputNormalizeErrorCode
  | OrganizationErrorCode
  | ContentSubmissionErrorCode
  | PaginationErrorCode;

// 类型守卫：统一判断是否为领域错误（兼容多包/反序列化场景）
export const isDomainError = (error: unknown): error is DomainError => {
  if (error instanceof DomainError) return true;
  if (!error || typeof error !== 'object') return false;
  const anyE = error as { name?: unknown; code?: unknown };
  return anyE?.name === 'DomainError' && typeof anyE?.code === 'string';
};
