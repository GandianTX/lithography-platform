// src/infrastructure/graphql/filters/graphql-exception.filter.ts
import { ExceptionPayload } from '@app-types/errors/exception-payload.types';
import {
  ACCOUNT_ERROR,
  ADMIN_DOCUMENT_DATABASE_ERROR,
  ADMIN_USER_ERROR,
  AUTH_ERROR,
  CAPABILITY_ERROR,
  CONTENT_SUBMISSION_ERROR,
  DomainError,
  ENGINEER_REGISTRATION_ERROR,
  isDomainError,
  JWT_ERROR,
  LOCAL_RUNTIME_ERROR,
  MAINTENANCE_REPORT_ERROR,
  MY_ACCOUNT_ERROR,
  ORGANIZATION_ERROR,
  PAGINATION_ERROR,
  PERMISSION_ERROR,
  REFERENCE_DOCUMENT_ERROR,
  REPAIR_REQUEST_ERROR,
  THIRDPARTY_ERROR,
} from '@core/common/errors';
import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseExceptionFilter } from '@nestjs/core';
import { GqlArgumentsHost } from '@nestjs/graphql';
import type { Response } from 'express';
import { GraphQLError, GraphQLResolveInfo } from 'graphql';
import { resolveRestStatus } from '@core/common/errors/rest-error-status';

/** 将 HTTP 状态码映射为 GraphQL 标准错误类别代码（extensions.code）
 *  注意：这是 GraphQL/Apollo 通用的大类，不是业务 errorCode（业务码放在 extensions.errorCode）
 */
function mapHttpToGqlCode(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return 'BAD_USER_INPUT';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    default:
      return 'INTERNAL_SERVER_ERROR';
  }
}

/** 从异常响应中提取错误信息 */
function extractPayload(resp: string | ExceptionPayload): {
  code?: string;
  errorCode?: string;
  errorMessage?: string;
  fallbackMsg?: string;
} {
  if (typeof resp === 'string') {
    return { errorMessage: resp };
  }
  const code = typeof resp.code === 'string' ? resp.code : undefined;
  const errorCode = typeof resp.errorCode === 'string' ? resp.errorCode : undefined;
  const explicitMsg = typeof resp.errorMessage === 'string' ? resp.errorMessage : undefined;

  let fallbackMsg: string | undefined;
  const msg = resp.message;
  if (Array.isArray(msg)) fallbackMsg = msg.join(', ');
  else if (typeof msg === 'string') fallbackMsg = msg;

  return { code, errorCode, errorMessage: explicitMsg, fallbackMsg };
}

/** 获取 GraphQL 字段路径 */
function getGqlPath(host: ArgumentsHost): string[] | undefined {
  const gqlHost = GqlArgumentsHost.create(host);
  const info = gqlHost.getInfo<GraphQLResolveInfo>();
  const field = info?.fieldName;
  return field ? [field] : undefined;
}

/** 根据 HttpException 构建 GraphQL 错误对象
 * - extensions.code：GraphQL 错误大类（默认由 HTTP 状态码映射；也可在异常响应体里传 code 覆盖）。
 *   生产环境**同样**保留该分类：校验管道抛出的 400（`BadRequestException`）必须映射
 *   `BAD_USER_INPUT`，不能被折叠为 `INTERNAL_SERVER_ERROR`（`graphql-error-contract-current.md`
 *   要求 input/validation/conflict/not-found/business-state 不因环境改变大类）。
 * - extensions.errorCode：业务细分错误码（来自异常响应体，生产环境不向外暴露）
 * - extensions.errorMessage：业务错误描述（来自异常响应体，生产环境不向外暴露）
 * - 生产环境只隐藏响应体的细节字段与自由文本（message 固定为「请求失败」），
 *   不改变错误大类。
 */
function buildGraphQLErrorFromHttpException(
  exception: HttpException,
  host: ArgumentsHost,
  isProdEnv: boolean,
): GraphQLError {
  const status = exception.getStatus();
  const resp = exception.getResponse() as string | ExceptionPayload; // ← 统一用公共类型
  const { code, errorCode, errorMessage, fallbackMsg } = extractPayload(resp);
  const passthroughMessage =
    errorMessage ??
    fallbackMsg ??
    (typeof exception.message === 'string' ? exception.message : 'Request failed');
  const finalMessage = isProdEnv ? '请求失败' : passthroughMessage;
  // 错误大类不随环境变化：生产环境只隐藏细节（errorCode / errorMessage / 自由文本），
  // 校验 400 必须仍是 BAD_USER_INPUT，否则前端会把输入错误当成系统故障
  const gqlCode = code ?? mapHttpToGqlCode(status);

  return new GraphQLError(finalMessage, {
    path: getGqlPath(host),
    extensions: {
      code: gqlCode,
      httpStatus: status,
      ...(isProdEnv ? {} : errorCode ? { errorCode } : {}),
      ...(isProdEnv ? {} : errorMessage ? { errorMessage } : {}),
    },
  });
}

/** 从未知异常构建 GraphQL 错误 */
function buildGraphQLErrorFromUnknown(
  exception: unknown,
  host: ArgumentsHost,
  isProdEnv: boolean,
): GraphQLError {
  const passthroughMessage =
    typeof (exception as { message?: unknown }).message === 'string'
      ? (exception as { message: string }).message
      : 'Internal server error';
  const msg = isProdEnv ? '系统繁忙，请稍后重试' : passthroughMessage;

  return new GraphQLError(msg, {
    path: getGqlPath(host),
    extensions: {
      code: 'INTERNAL_SERVER_ERROR',
      httpStatus: 500,
      ...(isProdEnv ? {} : { errorCode: 'INTERNAL_ERROR' }),
    },
  });
}

/**
 * 错误码到 GraphQL 错误类别的映射表（DomainError.code → extensions.code，
 * 未登记错误码回退 BAD_USER_INPUT）。提为模块级常量以控制函数长度；
 * 各组类目口径注释随映射保留在原位。
 */
const DOMAIN_ERROR_GQL_CODE_MAP: Record<string, string> = {
  // 认证相关错误
  [AUTH_ERROR.ACCOUNT_NOT_FOUND]: 'UNAUTHENTICATED',
  [AUTH_ERROR.INVALID_PASSWORD]: 'UNAUTHENTICATED',
  [AUTH_ERROR.ACCOUNT_INACTIVE]: 'FORBIDDEN',
  [AUTH_ERROR.ACCOUNT_BANNED]: 'FORBIDDEN',
  [AUTH_ERROR.INVALID_AUDIENCE]: 'BAD_USER_INPUT',

  // JWT 相关错误
  [JWT_ERROR.TOKEN_EXPIRED]: 'UNAUTHENTICATED',
  [JWT_ERROR.TOKEN_INVALID]: 'UNAUTHENTICATED',
  [JWT_ERROR.TOKEN_NOT_BEFORE]: 'UNAUTHENTICATED',
  [JWT_ERROR.TOKEN_VERIFICATION_FAILED]: 'UNAUTHENTICATED',
  [JWT_ERROR.AUTHENTICATION_FAILED]: 'UNAUTHENTICATED',
  [JWT_ERROR.TOKEN_GENERATION_FAILED]: 'INTERNAL_SERVER_ERROR',
  [JWT_ERROR.ACCESS_TOKEN_GENERATION_FAILED]: 'INTERNAL_SERVER_ERROR',
  [JWT_ERROR.REFRESH_TOKEN_GENERATION_FAILED]: 'INTERNAL_SERVER_ERROR',

  // 权限相关错误
  [PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS]: 'FORBIDDEN',
  [PERMISSION_ERROR.ACCESS_DENIED]: 'FORBIDDEN',
  [PERMISSION_ERROR.ROLE_REQUIRED]: 'FORBIDDEN',

  // 账户相关错误
  [ACCOUNT_ERROR.NICKNAME_TAKEN]: 'CONFLICT',
  [ACCOUNT_ERROR.EMAIL_TAKEN]: 'CONFLICT',
  [ACCOUNT_ERROR.USER_INFO_NOT_FOUND]: 'NOT_FOUND',
  // 自助注册所选组织不存在/已停用：客户端可修正的输入问题，显式登记避免契约漂移
  [ACCOUNT_ERROR.ORGANIZATION_NOT_AVAILABLE]: 'BAD_USER_INPUT',

  // 第三方认证相关错误（与登录错误类别保持一致）
  [THIRDPARTY_ERROR.CREDENTIAL_INVALID]: 'UNAUTHENTICATED',
  [THIRDPARTY_ERROR.ACCOUNT_NOT_BOUND]: 'UNAUTHENTICATED',
  [THIRDPARTY_ERROR.LOGIN_FAILED]: 'INTERNAL_SERVER_ERROR',
  [THIRDPARTY_ERROR.BIND_FAILED]: 'BAD_USER_INPUT',
  [THIRDPARTY_ERROR.UNBIND_FAILED]: 'BAD_USER_INPUT',
  [THIRDPARTY_ERROR.PROVIDER_NOT_SUPPORTED]: 'BAD_USER_INPUT',
  [THIRDPARTY_ERROR.ACCOUNT_ALREADY_BOUND]: 'CONFLICT',
  [THIRDPARTY_ERROR.REGISTRATION_FAILED]: 'BAD_USER_INPUT',
  [THIRDPARTY_ERROR.INVALID_AUDIENCE]: 'BAD_USER_INPUT',
  [THIRDPARTY_ERROR.INVALID_USER_INFO]: 'BAD_USER_INPUT',
  [THIRDPARTY_ERROR.NICKNAME_INVALID]: 'BAD_USER_INPUT',
  [THIRDPARTY_ERROR.INVALID_PARAMS]: 'BAD_USER_INPUT',
  [THIRDPARTY_ERROR.USER_NOT_FOUND]: 'NOT_FOUND',
  [THIRDPARTY_ERROR.PROVIDER_API_ERROR]: 'INTERNAL_SERVER_ERROR',
  [THIRDPARTY_ERROR.UNKNOWN_ERROR]: 'INTERNAL_SERVER_ERROR',

  // 分页相关错误
  [PAGINATION_ERROR.INVALID_PAGE_SIZE]: 'BAD_USER_INPUT',
  [PAGINATION_ERROR.INVALID_CURSOR]: 'BAD_USER_INPUT',
  [PAGINATION_ERROR.SORT_FIELD_NOT_ALLOWED]: 'BAD_USER_INPUT',
  [PAGINATION_ERROR.DB_QUERY_FAILED]: 'INTERNAL_SERVER_ERROR',

  // 维修申请相关错误（设备型号不存在属于目标不存在；停用与非法输入属于输入非法；
  // 落库失败与编号冲突属系统侧故障，不得误报为输入错误；
  // 软删除：不存在/非本人统一 NOT_FOUND，已接单拒绝 CONFLICT，落库失败属系统侧故障；
  // 回复：未接单属业务状态冲突 CONFLICT，回复落库失败属系统侧故障）
  [REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_NOT_FOUND]: 'NOT_FOUND',
  [REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_DISABLED]: 'BAD_USER_INPUT',
  [REPAIR_REQUEST_ERROR.INVALID_PARAMS]: 'BAD_USER_INPUT',
  [REPAIR_REQUEST_ERROR.CREATION_FAILED]: 'INTERNAL_SERVER_ERROR',
  [REPAIR_REQUEST_ERROR.REQUEST_NO_CONFLICT]: 'INTERNAL_SERVER_ERROR',
  [REPAIR_REQUEST_ERROR.NOT_FOUND]: 'NOT_FOUND',
  [REPAIR_REQUEST_ERROR.ALREADY_ACCEPTED]: 'CONFLICT',
  [REPAIR_REQUEST_ERROR.ACCEPT_FAILED]: 'INTERNAL_SERVER_ERROR',
  [REPAIR_REQUEST_ERROR.DELETION_FAILED]: 'INTERNAL_SERVER_ERROR',
  [REPAIR_REQUEST_ERROR.NOT_ACCEPTED]: 'CONFLICT',
  [REPAIR_REQUEST_ERROR.RESPONSE_FAILED]: 'INTERNAL_SERVER_ERROR',
  [REPAIR_REQUEST_ERROR.HANDLING_NOT_AVAILABLE]: 'CONFLICT',
  // 终结事实不可改写属明确的当前状态冲突，既不泄露数据细节也不是输入错误
  [REPAIR_REQUEST_ERROR.HANDLING_STATE_CONFLICT]: 'CONFLICT',
  [REPAIR_REQUEST_ERROR.HANDLING_UPDATE_FAILED]: 'INTERNAL_SERVER_ERROR',

  // 维修报告与总结：目标不存在 NOT_FOUND；输入与状态前置冲突按业务大类；
  // 分析结果不存在/未成功/跨组织/工单不匹配均为可诊断的业务拒绝；
  // 正式读取服务未接入属系统侧不可用，不得伪造成功
  [MAINTENANCE_REPORT_ERROR.INVALID_PARAMS]: 'BAD_USER_INPUT',
  [MAINTENANCE_REPORT_ERROR.NOT_FOUND]: 'NOT_FOUND',
  [MAINTENANCE_REPORT_ERROR.CREATION_FAILED]: 'INTERNAL_SERVER_ERROR',
  [MAINTENANCE_REPORT_ERROR.UPDATE_FAILED]: 'INTERNAL_SERVER_ERROR',
  [MAINTENANCE_REPORT_ERROR.SUBMIT_FAILED]: 'INTERNAL_SERVER_ERROR',
  [MAINTENANCE_REPORT_ERROR.REVIEW_FAILED]: 'INTERNAL_SERVER_ERROR',
  [MAINTENANCE_REPORT_ERROR.STATE_NOT_EDITABLE]: 'CONFLICT',
  [MAINTENANCE_REPORT_ERROR.STATE_NOT_REVIEWABLE]: 'CONFLICT',
  [MAINTENANCE_REPORT_ERROR.WORK_ORDER_NOT_ACCEPTED]: 'CONFLICT',
  // 他人工单/跨组织统一按目标不存在处理，与读取、接单入口口径一致，不泄露存在性
  [MAINTENANCE_REPORT_ERROR.WORK_ORDER_OWNER_MISMATCH]: 'NOT_FOUND',
  [MAINTENANCE_REPORT_ERROR.WORK_ORDER_ALREADY_SUMMARIZED]: 'CONFLICT',
  [MAINTENANCE_REPORT_ERROR.ATTACHMENT_LIMIT_EXCEEDED]: 'BAD_USER_INPUT',
  [MAINTENANCE_REPORT_ERROR.ATTACHMENT_TOTAL_SIZE_EXCEEDED]: 'BAD_USER_INPUT',
  [MAINTENANCE_REPORT_ERROR.ATTACHMENT_TOO_LARGE]: 'BAD_USER_INPUT',
  [MAINTENANCE_REPORT_ERROR.ATTACHMENT_NOT_FOUND]: 'NOT_FOUND',
  [MAINTENANCE_REPORT_ERROR.AI_EVALUATION_NOT_APPLICABLE]: 'BAD_USER_INPUT',
  [MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID]: 'BAD_USER_INPUT',
  [MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_REFERENCE_REQUIRED]: 'BAD_USER_INPUT',
  [MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_NOT_FOUND]: 'NOT_FOUND',
  [MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_NOT_SUCCESSFUL]: 'CONFLICT',
  // 分析结果跨组织/关联工单不符：按目标不存在处理，避免探测他人分析结果是否存在
  [MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_OWNER_MISMATCH]: 'NOT_FOUND',
  [MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_REQUEST_MISMATCH]: 'NOT_FOUND',
  [MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_UNAVAILABLE]: 'INTERNAL_SERVER_ERROR',
  // 并发改动分析结果引用：请求本身合法，重试即可，不塌缩成输入错误或权限错误
  [MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_REFERENCE_CHANGED]: 'CONFLICT',
  // 读取到违反既有不变量的数据，属系统侧问题
  [MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT]: 'INTERNAL_SERVER_ERROR',
  [LOCAL_RUNTIME_ERROR.INVALID_PARAMS]: 'BAD_USER_INPUT',
  [LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND]: 'NOT_FOUND',
  [LOCAL_RUNTIME_ERROR.UPDATE_FAILED]: 'INTERNAL_SERVER_ERROR',
  [LOCAL_RUNTIME_ERROR.UPLOAD_TASK_CONFLICT]: 'CONFLICT',
  [LOCAL_RUNTIME_ERROR.UPLOAD_TASK_NOT_FOUND]: 'NOT_FOUND',
  [LOCAL_RUNTIME_ERROR.UPLOAD_TASK_FAILED]: 'INTERNAL_SERVER_ERROR',
  [LOCAL_RUNTIME_ERROR.BACKUP_ALREADY_RUNNING]: 'CONFLICT',
  [LOCAL_RUNTIME_ERROR.BACKUP_RUN_NOT_FOUND]: 'NOT_FOUND',
  [LOCAL_RUNTIME_ERROR.BACKUP_STATE_CONFLICT]: 'CONFLICT',
  [LOCAL_RUNTIME_ERROR.BACKUP_FAILED]: 'INTERNAL_SERVER_ERROR',

  // AI 参考资料库（0907.docx 任务二）：型号不存在属目标不存在；非法输入 BAD_USER_INPUT；
  // 不存在/已软删统一 NOT_FOUND；落库失败属系统侧故障
  [REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND]: 'NOT_FOUND',
  [REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS]: 'BAD_USER_INPUT',
  [REFERENCE_DOCUMENT_ERROR.NOT_FOUND]: 'NOT_FOUND',
  [REFERENCE_DOCUMENT_ERROR.CREATION_FAILED]: 'INTERNAL_SERVER_ERROR',
  [REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED]: 'INTERNAL_SERVER_ERROR',
  [REFERENCE_DOCUMENT_ERROR.DELETION_FAILED]: 'INTERNAL_SERVER_ERROR',
  [REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_MISSING]: 'BAD_USER_INPUT',
  [REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_TOO_LARGE]: 'BAD_USER_INPUT',
  [REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED]: 'BAD_USER_INPUT',
  [REFERENCE_DOCUMENT_ERROR.CONTENT_SOURCE_EMPTY]: 'BAD_USER_INPUT',
  // 存储对象缺失/不可读：统一按资源不存在归大类，不泄漏存储侧细节
  [REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE]: 'NOT_FOUND',
  // 管理员用户管理相关错误（独立场景码，不复用会让前端误判 Session 失效的 AUTH/JWT 码）：
  // 登录凭据命中数据库唯一索引属业务冲突；三源角色数据不能收敛、以及系统侧读写失败
  // 均属服务端故障，不得误报为输入错误；
  // 管理员目标不存在的统一场景码由 P0-4 写用例引入，映射 NOT_FOUND：
  // lockByIdForUpdate() 原有的 ACCOUNT_NOT_FOUND 与 AUTH 同码值会塌缩为 UNAUTHENTICATED，
  // 违反错误契约，故写目标不存在的场景不得复用它
  [ADMIN_USER_ERROR.TARGET_NOT_FOUND]: 'NOT_FOUND',
  [ADMIN_USER_ERROR.CREDENTIAL_CONFLICT]: 'CONFLICT',
  // CONFLICT 而非 BAD_USER_INPUT：请求的目标状态本身合法；而非 FORBIDDEN：
  // 管理员权限无问题；而非 INTERNAL_SERVER_ERROR：这是明确的当前状态冲突
  [ADMIN_USER_ERROR.STATUS_TRANSITION_NOT_ALLOWED]: 'CONFLICT',
  // 密码重置（P0-6 / R11-2）：目标账号当前双字段状态不允许重置（仅双字段一致的
  // ACTIVE / INACTIVE 普通账号可重置）。CONFLICT 口径与 STATUS_TRANSITION_NOT_ALLOWED 同源
  [ADMIN_USER_ERROR.PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED]: 'CONFLICT',
  [ADMIN_USER_ERROR.READ_FAILED]: 'INTERNAL_SERVER_ERROR',
  [ADMIN_USER_ERROR.WRITE_FAILED]: 'INTERNAL_SERVER_ERROR',
  [ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT]: 'INTERNAL_SERVER_ERROR',

  // 当前用户账号设置（自助场景 P2/P3）：双空登录凭据与当前密码不正确均为客户端输入类
  // （BAD_USER_INPUT）且不得塌缩为 UNAUTHENTICATED（当前密码不正确若映射
  // UNAUTHENTICATED 会被前端误判为会话失效并清理 Session）；凭据占用是明确的业务冲突
  // （同 ADMIN_USER_ERROR.CREDENTIAL_CONFLICT 的 CONFLICT 口径）
  [MY_ACCOUNT_ERROR.LOGIN_CREDENTIAL_BOTH_EMPTY]: 'BAD_USER_INPUT',
  [MY_ACCOUNT_ERROR.CREDENTIAL_CONFLICT]: 'CONFLICT',
  [MY_ACCOUNT_ERROR.CURRENT_PASSWORD_MISMATCH]: 'BAD_USER_INPUT',

  // 管理员文档数据库聚合读（PR3 只读）：目标不存在/已软删统一 NOT_FOUND；
  // 输入问题（含关键字命中账号超限、非法 ID / 时间范围）显式登记 BAD_USER_INPUT，
  // 避免依赖默认值导致契约漂移。
  [ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND]: 'NOT_FOUND',
  [ADMIN_DOCUMENT_DATABASE_ERROR.INVALID_PARAMS]: 'BAD_USER_INPUT',

  // 可信组织上下文（A-PR0 §2.1）：已认证账号的组织成员事实缺失/歧义均属权限类拒绝——
  // 不是会话问题（不得 UNAUTHENTICATED）、不是输入问题（不得 BAD_USER_INPUT）、
  // 也不是资源状态冲突（不用 CONFLICT），统一 FORBIDDEN；
  // details 为空，不向客户端泄露成员关系数量与组织标识
  [ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP]: 'FORBIDDEN',
  [ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP]: 'FORBIDDEN',

  // 内容投稿（A-PR0 §2.2/§2.3）：输入类保持 BAD_USER_INPUT；他人/跨组织/不存在
  // 统一 NOT_FOUND（不泄露存在性）；状态不允许编辑属当前状态冲突 CONFLICT
  // （请求动作本身合法、权限无问题）；系统侧读写失败 INTERNAL_SERVER_ERROR
  [CONTENT_SUBMISSION_ERROR.INVALID_PARAMS]: 'BAD_USER_INPUT',
  [CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY]: 'BAD_USER_INPUT',
  [CONTENT_SUBMISSION_ERROR.EQUIPMENT_MODEL_NOT_FOUND]: 'NOT_FOUND',
  [CONTENT_SUBMISSION_ERROR.NOT_FOUND]: 'NOT_FOUND',
  [CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE]: 'CONFLICT',
  // 附件链路（A-PR0 §4.2）：上传输入类 BAD_USER_INPUT（与参考资料上传同口径）；
  // 存储对象缺失按资源不存在归大类，不泄露存储侧细节
  [CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_MISSING]: 'BAD_USER_INPUT',
  [CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TOO_LARGE]: 'BAD_USER_INPUT',
  [CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED]: 'BAD_USER_INPUT',
  [CONTENT_SUBMISSION_ERROR.FILE_NOT_AVAILABLE]: 'NOT_FOUND',
  [CONTENT_SUBMISSION_ERROR.CREATION_FAILED]: 'INTERNAL_SERVER_ERROR',
  [CONTENT_SUBMISSION_ERROR.UPDATE_FAILED]: 'INTERNAL_SERVER_ERROR',
  [CONTENT_SUBMISSION_ERROR.READ_FAILED]: 'INTERNAL_SERVER_ERROR',

  // 工程师自助注册与组织审核：凭据证明失败与登录失败同口径（UNAUTHENTICATED，
  // 不区分账号不存在与密码错误）；业务状态冲突（含并发第二次决策）CONFLICT；
  // 不存在/他人/跨组织统一 NOT_FOUND 不泄露存在性；输入与组织失效 BAD_USER_INPUT；
  // 系统侧读写失败 INTERNAL_SERVER_ERROR
  [ENGINEER_REGISTRATION_ERROR.INVALID_PARAMS]: 'BAD_USER_INPUT',
  [ENGINEER_REGISTRATION_ERROR.CREDENTIAL_MISMATCH]: 'UNAUTHENTICATED',
  [ENGINEER_REGISTRATION_ERROR.ACCOUNT_NOT_PENDING]: 'CONFLICT',
  [ENGINEER_REGISTRATION_ERROR.PENDING_APPLICATION_EXISTS]: 'CONFLICT',
  [ENGINEER_REGISTRATION_ERROR.APPLICATION_NOT_FOUND]: 'NOT_FOUND',
  [ENGINEER_REGISTRATION_ERROR.RESUBMIT_NOT_ALLOWED]: 'CONFLICT',
  [ENGINEER_REGISTRATION_ERROR.APPLICATION_STATE_CONFLICT]: 'CONFLICT',
  [ENGINEER_REGISTRATION_ERROR.REVIEW_NOT_ALLOWED]: 'CONFLICT',
  [ENGINEER_REGISTRATION_ERROR.WRITE_FAILED]: 'INTERNAL_SERVER_ERROR',
  [ENGINEER_REGISTRATION_ERROR.READ_FAILED]: 'INTERNAL_SERVER_ERROR',

  [CAPABILITY_ERROR.UNAVAILABLE]: 'INTERNAL_SERVER_ERROR',
};

/** 将 DomainError 错误码映射为 GraphQL 错误类别 */
function mapDomainErrorToGqlCode(errorCode: string): string {
  return DOMAIN_ERROR_GQL_CODE_MAP[errorCode] || 'BAD_USER_INPUT';
}

/** 从 DomainError 构建 GraphQL 错误对象 */
function buildGraphQLErrorFromDomainError(
  exception: DomainError,
  host: ArgumentsHost,
): GraphQLError {
  return new GraphQLError(exception.message, {
    path: getGqlPath(host),
    extensions: {
      code: mapDomainErrorToGqlCode(exception.code),
      errorCode: exception.code,
      errorMessage: exception.message,
      ...(exception.details ? { details: exception.details } : {}),
    },
  });
}

@Catch()
export class GqlAllExceptionsFilter extends BaseExceptionFilter {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  override catch(exception: unknown, host: ArgumentsHost) {
    const isProdEnv = this.configService.get<string>('NODE_ENV') === 'production';

    // HTTP（REST）请求：DomainError 按统一 REST 错误体渲染（状态码 + code + message），
    // 其余保持默认处理；防止守卫/REST 端点抛出的业务错误兜底成 500 丢失语义
    if (host.getType() === 'http') {
      if (isDomainError(exception)) {
        const response = host.switchToHttp().getResponse<Response>();
        const status = resolveRestStatus(exception.code);
        response.status(status).json({
          statusCode: status,
          code: exception.code,
          message: exception.message,
        });
        return;
      }

      return super.catch(exception, host);
    }

    // 专门处理 DomainError
    if (isDomainError(exception)) {
      return buildGraphQLErrorFromDomainError(exception, host);
    }

    if (exception instanceof HttpException) {
      return buildGraphQLErrorFromHttpException(exception, host, isProdEnv);
    }

    return buildGraphQLErrorFromUnknown(exception, host, isProdEnv);
  }
}
