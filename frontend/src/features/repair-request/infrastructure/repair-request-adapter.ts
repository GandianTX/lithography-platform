// src/features/repair-request/infrastructure/repair-request-adapter.ts

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';
import {
  fetchRestWithAuthRetry,
  parseAttachmentFilename,
  readRestErrorField,
  type RestErrorEnvelope,
  toRestErrorEnvelope,
} from '@/shared/http';
import { type MessageKey, translateNow } from '@/shared/i18n';

import type {
  CreateRepairRequestFailureReason,
  CreateRepairRequestInput,
  CreateRepairRequestResult,
  EquipmentModelOption,
  RepairRequestRecord,
  ServiceOrganizationOption,
  UploadRepairRequestFileFailureReason,
  UploadRepairRequestFileResult,
} from './repair-request.types';
import type {
  DeleteMyRepairRequestFailureReason,
  DeleteMyRepairRequestResult,
  DownloadMyRepairRequestFileFailureReason,
  DownloadMyRepairRequestFileResult,
  IntakeAnalysisStatus,
  MyRepairRequestDetailResult,
  RepairRequestDetail,
  RepairRequestListPage,
  RepairRequestListPagination,
  RetryIntakeAnalysisFailureReason,
  RetryIntakeAnalysisResult,
} from './repair-request-read.types';
import { uploadStagedStoredFile } from './stored-file-upload';

const EQUIPMENT_MODELS_QUERY = `
  query EquipmentModels {
    equipmentModels {
      id
      modelCode
      modelName
    }
  }
`;

const CREATE_REPAIR_REQUEST_MUTATION = `
  mutation CreateRepairRequest($input: CreateRepairRequestInput!) {
    createRepairRequest(input: $input) {
      id
      requestNo
      equipmentModelId
      errorCode
      faultDescription
      createdAt
      isAccepted
    }
  }
`;

/** 客户报修可选维修厂家（启用 + 具备维修服务资格；后端按名称、主键升序） */
const REPAIR_SERVICE_ORGANIZATIONS_QUERY = `
  query RepairServiceOrganizationSearch($pagination: PaginationArgs!, $keyword: String) {
    repairServiceOrganizationSearch(pagination: $pagination, keyword: $keyword) {
      items { id name shortName }
      total
      page
      pageSize
    }
  }
`;

/**
 * 拒绝原因主映射：仅依赖契约保证稳定的 GraphQL 大类码 extensions.code
 * （backend/docs/api/graphql-error-contract-current.md），
 * 即使后端按契约在生产隐藏 errorCode 也不会退化失效。
 * transport / auth 类错误不归入业务拒绝，仍抛 GraphQLIngressError（见 graphql-error-model.md）。
 */
const FAILURE_REASON_BY_CATEGORY_CODE: Record<string, CreateRepairRequestFailureReason> = {
  // 任务 03：NOT_FOUND 只可能来自附件不可绑定（原件不存在/无权绑定）
  NOT_FOUND: 'attachment-not-found',
  BAD_USER_INPUT: 'invalid-input',
  // 创建门禁（S4）：本 mutation 内 FORBIDDEN 唯一来源是客户归属缺失 / 不可用；
  // 生产隐藏 errorCode 时统一按「需先补录公司」引导，不新增错误通道。
  FORBIDDEN: 'company-required',
  // 任务 03：CONFLICT 主因是同一提交标识内容不一致（附件被占用是次要分支，
  // 生产隐藏 errorCode 时按主因给文案：重新打开报修页提交）
  CONFLICT: 'submission-conflict',
  INTERNAL_SERVER_ERROR: 'creation-failed',
};

/**
 * 可选细化：后端暴露 extensions.errorCode 时（非生产环境）区分停用型号与普通输入非法、
 * 以及归属门禁的两种情况。
 * 唯一真源：backend/src/core/common/errors/domain-error.ts 的 REPAIR_REQUEST_ERROR 码组。
 * 后端按契约隐藏该字段时自动回退到大类码映射，不会失效。
 */
const REFINED_REASON_BY_ERROR_CODE: Partial<Record<string, CreateRepairRequestFailureReason>> = {
  REPAIR_REQUEST_EQUIPMENT_MODEL_DISABLED: 'model-disabled',
  REPAIR_REQUEST_EQUIPMENT_MODEL_NOT_FOUND: 'model-not-found',
  REPAIR_REQUEST_EQUIPMENT_MODEL_INPUT_INVALID: 'invalid-input',
  REPAIR_REQUEST_INVALID_PARAMS: 'invalid-input',
  REPAIR_REQUEST_SUBMISSION_KEY_INVALID: 'invalid-input',
  REPAIR_REQUEST_SUBMISSION_CONFLICT: 'submission-conflict',
  REPAIR_REQUEST_SERVICE_ORGANIZATION_NOT_AVAILABLE: 'service-org-unavailable',
  REPAIR_REQUEST_CUSTOMER_COMPANY_REQUIRED: 'company-required',
  REPAIR_REQUEST_CUSTOMER_COMPANY_UNAVAILABLE: 'company-unavailable',
  INPUT_NORMALIZE_REQUIRED_TEXT_EMPTY: 'invalid-input',
  INPUT_NORMALIZE_INVALID_TEXT: 'invalid-input',
  STORED_FILE_NOT_FOUND: 'attachment-not-found',
  STORED_FILE_NOT_BINDABLE: 'attachment-conflict',
  STORED_FILE_ALREADY_BOUND: 'attachment-conflict',
};

const FALLBACK_MESSAGE_BY_REASON: Record<CreateRepairRequestFailureReason, MessageKey> = {
  'model-not-found': 'repairForm.error.modelNotFound',
  'model-disabled': 'repairForm.error.modelDisabled',
  'invalid-input': 'repairForm.error.invalidInput',
  'company-required': 'repairForm.error.companyRequired',
  'company-unavailable': 'repairForm.error.companyUnavailable',
  'service-org-unavailable': 'repairForm.error.serviceOrgUnavailable',
  'submission-conflict': 'repairForm.error.submissionConflict',
  'attachment-not-found': 'repairForm.error.attachmentNotFound',
  'attachment-conflict': 'repairForm.error.attachmentConflict',
  'creation-failed': 'repairForm.error.creationFailed',
};

type EquipmentModelsData = {
  equipmentModels: EquipmentModelOption[];
};

type CreateRepairRequestData = {
  createRepairRequest: RepairRequestRecord;
};

/** 查询可创建维修申请的设备型号列表（仅启用型号，后端已按排序返回） */
export async function fetchEquipmentModels(): Promise<EquipmentModelOption[]> {
  const data = await executeGraphQL<EquipmentModelsData, Record<string, never>>(
    EQUIPMENT_MODELS_QUERY,
    {},
  );

  return data.equipmentModels;
}

/**
 * 查询可选维修厂家（启用 + 具备维修服务资格）。
 *
 * 只返回 `id` / `name` / `shortName`；提交时后端在写入事务内再复核一次资格，
 * 前端不缓存资格结论，也不允许手工输入厂家。
 */
export async function fetchRepairServiceOrganizations(params: {
  keyword?: string;
  page?: number;
  pageSize?: number;
}): Promise<ServiceOrganizationOption[]> {
  const data = await executeGraphQL<
    { repairServiceOrganizationSearch: { items: ServiceOrganizationOption[] } },
    {
      pagination: { mode: 'OFFSET'; page: number; pageSize: number; withTotal: true };
      keyword: string | null;
    }
  >(REPAIR_SERVICE_ORGANIZATIONS_QUERY, {
    pagination: {
      mode: 'OFFSET',
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 20,
      withTotal: true,
    },
    keyword: params.keyword?.trim() ? params.keyword.trim() : null,
  });

  return data.repairServiceOrganizationSearch.items;
}

/**
 * 客户上传报修原件（REST 暂存，用途 REPAIR_REQUEST）。
 *
 * 上传只表示「已校验 + 暂存」，绑定在提交报修的事务内完成；
 * 因此上传成功的附件在提交失败时仍是暂存态，可继续复用同一 fileId 重试提交。
 */
export async function uploadRepairRequestFile(file: File): Promise<UploadRepairRequestFileResult> {
  const outcome = await uploadStagedStoredFile(file, 'REPAIR_REQUEST');

  if (outcome.status === 'uploaded') {
    return { ok: true, file: outcome.file };
  }

  if (outcome.status === 'network') {
    return {
      ok: false,
      reason: 'upload-failed',
      message: translateNow('repairForm.error.uploadFailed'),
    };
  }

  if (outcome.status === 'malformed') {
    return {
      ok: false,
      reason: 'upload-failed',
      message: translateNow('repairForm.error.uploadFailed'),
    };
  }

  const reason = outcome.code ? UPLOAD_FAILURE_REASON_BY_CODE[outcome.code] : undefined;
  if (reason) {
    return {
      ok: false,
      reason,
      message: outcome.message ?? translateNow(UPLOAD_FALLBACK_MESSAGE_BY_REASON[reason]),
    };
  }

  return {
    ok: false,
    reason: 'upload-failed',
    message: outcome.message ?? translateNow('repairForm.error.uploadFailed'),
  };
}

/** 上传失败码 → 客户可理解原因（与后端 stored-file REST 固定错误体对齐） */
const UPLOAD_FAILURE_REASON_BY_CODE: Record<string, UploadRepairRequestFileFailureReason> = {
  STORED_FILE_UPLOAD_FILE_TOO_LARGE: 'file-too-large',
  STORED_FILE_UPLOAD_FILE_TYPE_NOT_ALLOWED: 'file-type-not-allowed',
  STORED_FILE_INVALID_PARAMS: 'invalid-input',
  STORED_FILE_PURPOSE_NOT_SUPPORTED: 'invalid-input',
  STORED_FILE_UPLOAD_FILE_MISSING: 'invalid-input',
  REPAIR_REQUEST_CUSTOMER_COMPANY_REQUIRED: 'company-required',
  FORBIDDEN: 'insufficient-permission',
};

const UPLOAD_FALLBACK_MESSAGE_BY_REASON: Record<UploadRepairRequestFileFailureReason, MessageKey> =
  {
    'invalid-input': 'repairForm.error.uploadInvalidInput',
    'file-too-large': 'repairForm.error.uploadTooLarge',
    'file-type-not-allowed': 'repairForm.error.uploadTypeNotAllowed',
    'company-required': 'repairForm.error.companyRequired',
    'insufficient-permission': 'repairForm.error.uploadForbidden',
    'upload-failed': 'repairForm.error.uploadFailed',
  };

/**
 * 创建维修申请。
 *
 * - 业务拒绝（型号不存在/停用、输入非法、落库失败）返回显式失败结果，供表单直接展示；
 * - 拒绝原因以稳定的 extensions.code 为主，extensions.errorCode 仅作可选细化，
 *   不依赖 errorCode 做生产运行时分支（见 graphql-error-contract-current.md）；
 * - transport / auth 类失败按共享错误模型上抛 GraphQLIngressError，由调用方决定展示与跳转。
 */
export async function createRepairRequest(
  input: CreateRepairRequestInput,
): Promise<CreateRepairRequestResult> {
  try {
    const data = await executeGraphQL<CreateRepairRequestData, { input: CreateRepairRequestInput }>(
      CREATE_REPAIR_REQUEST_MUTATION,
      { input },
    );

    return { ok: true, repairRequest: data.createRepairRequest };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const categoryReason = detail?.code ? FAILURE_REASON_BY_CATEGORY_CODE[detail.code] : undefined;

    if (!detail || !categoryReason) {
      throw error;
    }

    const reason =
      (detail.errorCode ? REFINED_REASON_BY_ERROR_CODE[detail.errorCode] : undefined) ??
      categoryReason;

    return {
      ok: false,
      reason,
      message: detail.errorMessage ?? translateNow(FALLBACK_MESSAGE_BY_REASON[reason]),
    };
  }
}

// ---- 客户侧读模型与删除（PR #C；类型复用 repair-request-read.types，与 Mock adapter 同名同签名） ----

const MY_REPAIR_REQUESTS_QUERY = `
  query MyRepairRequests($pagination: PaginationArgs!) {
    myRepairRequests(pagination: $pagination) {
      items {
        id
        requestNo
        errorCode
        createdAt
        isAccepted
        acceptedAt
        latestResolutionStatus
        analysisStatus
        analysisGeneration
        equipmentModel {
          id
          modelCode
          modelName
        }
      }
      total
      page
      pageSize
    }
  }
`;

const MY_REPAIR_REQUEST_DETAIL_QUERY = `
  query MyRepairRequest($id: Int!) {
    myRepairRequest(id: $id) {
      id
      requestNo
      errorCode
      faultDescription
      contentMd
      createdAt
      isAccepted
      acceptedAt
      latestResolutionStatus
      equipmentModel {
        id
        modelCode
        modelName
      }
      intakeAnalysis {
        status
        generation
        outputText
        finishedAt
        displayState
        retryEligibility {
          eligible
          reason
        }
      }
      originalFile {
        fileId
        originalFilename
        mimeType
        byteSize
      }
      serviceOrganization {
        id
        name
      }
      handlingStatus
      handlingResult
      closureStatus
      closedAt
      closureReason
      responses {
        id
        engineerNickname
        resolutionStatus
        responseText
        createdAt
      }
    }
  }
`;

const DELETE_MY_REPAIR_REQUEST_MUTATION = `
  mutation DeleteMyRepairRequest($id: Int!) {
    deleteMyRepairRequest(id: $id) {
      id
      requestNo
    }
  }
`;

type MyRepairRequestsData = {
  myRepairRequests: RepairRequestListPage;
};

type MyRepairRequestData = {
  myRepairRequest: RepairRequestDetail;
};

type DeleteMyRepairRequestData = {
  deleteMyRepairRequest: {
    id: number;
    requestNo: string;
  };
};

/** OFFSET 分页变量（调用方只传 page/pageSize，mode 与 withTotal 由 adapter 内部补齐） */
type PaginationVariables = {
  pagination: {
    mode: 'OFFSET';
    page: number;
    pageSize: number;
    withTotal: true;
  };
};

/**
 * 删除拒绝原因主映射：大类码与 reason 一一对应（裁定 5 契约），
 * CONFLICT 在本 mutation 内唯一对应「已接单」，无需 errorCode 细化分支；
 * 未知错误经后端 fallback 归为 BAD_USER_INPUT → invalid-input（生产隐藏 errorCode
 * 时的已知退化行为，见计划表 T-03 注记），不可映射的 transport/auth 类仍上抛。
 */
const DELETE_FAILURE_REASON_BY_CATEGORY_CODE: Record<string, DeleteMyRepairRequestFailureReason> = {
  NOT_FOUND: 'not-found',
  CONFLICT: 'already-accepted',
  FORBIDDEN: 'forbidden',
  BAD_USER_INPUT: 'invalid-input',
  INTERNAL_SERVER_ERROR: 'delete-failed',
};

const DELETE_FALLBACK_MESSAGE_BY_REASON: Record<DeleteMyRepairRequestFailureReason, MessageKey> = {
  'not-found': 'customer.deleteError.notFound',
  'already-accepted': 'customer.deleteError.alreadyAccepted',
  forbidden: 'customer.deleteError.forbidden',
  'invalid-input': 'customer.deleteError.invalidInput',
  'delete-failed': 'customer.deleteError.deleteFailed',
};

/** 查询当前客户的维修申请列表（仅本人且未删除，后端固定 createdAt DESC + id DESC） */
export async function fetchMyRepairRequests(
  pagination: RepairRequestListPagination,
): Promise<RepairRequestListPage> {
  const data = await executeGraphQL<MyRepairRequestsData, PaginationVariables>(
    MY_REPAIR_REQUESTS_QUERY,
    {
      pagination: {
        mode: 'OFFSET',
        page: pagination.page,
        pageSize: pagination.pageSize,
        withTotal: true,
      },
    },
  );

  return data.myRepairRequests;
}

/**
 * 查询当前客户的维修申请详情（含回复时间线）。
 *
 * - domain failure 归并为 not-found 防探测拒绝（裁定口径）：不存在 / 非本人 / 已删除。
 *   后端详情读取的既有契约（read spec expectAccessDenied 钉住）是
 *   FORBIDDEN / ACCESS_DENIED + 防探测文案「维修申请不存在或不可查看」，
 *   与删除 mutation 的 NOT_FOUND 统一口径不同，两种大类码均按 not-found 归并；
 * - 其余失败（守卫 INSUFFICIENT_PERMISSIONS、transport / auth / network 等）
 *   不归并为 not-found，仍按共享错误模型上抛 GraphQLIngressError，由调用方兜底展示。
 */
export async function fetchMyRepairRequest(id: number): Promise<MyRepairRequestDetailResult> {
  try {
    const data = await executeGraphQL<MyRepairRequestData, { id: number }>(
      MY_REPAIR_REQUEST_DETAIL_QUERY,
      { id },
    );

    return { ok: true, detail: data.myRepairRequest };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);

    // 防探测归并：NOT_FOUND（删除链路口径）与 FORBIDDEN/ACCESS_DENIED（详情读取既有契约）
    // 均表示「不可查看该申请」，呈现统一 not-found 态；
    // FORBIDDEN 仅在此处归并，其余函数的 FORBIDDEN 仍按各自契约处理。
    if (detail?.code === 'NOT_FOUND' || detail?.code === 'FORBIDDEN') {
      return {
        ok: false,
        reason: 'not-found',
        message: detail.errorMessage ?? translateNow('customer.detailNotFound'),
      };
    }

    throw error;
  }
}

/**
 * 删除当前客户的未接单维修申请（软删除；重复删除幂等成功，裁定 5）。
 *
 * - 业务拒绝返回显式失败结果，原因以稳定的 extensions.code 为主；
 * - transport / auth / network 类失败按共享错误模型上抛 GraphQLIngressError。
 */
export async function deleteMyRepairRequest(id: number): Promise<DeleteMyRepairRequestResult> {
  try {
    await executeGraphQL<DeleteMyRepairRequestData, { id: number }>(
      DELETE_MY_REPAIR_REQUEST_MUTATION,
      { id },
    );

    return { ok: true };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const reason = detail?.code ? DELETE_FAILURE_REASON_BY_CATEGORY_CODE[detail.code] : undefined;

    if (!detail || !reason) {
      throw error;
    }

    return {
      ok: false,
      reason,
      message: detail.errorMessage ?? translateNow(DELETE_FALLBACK_MESSAGE_BY_REASON[reason]),
    };
  }
}

// ---- 首析重试与本人报修原件下载（任务 03 第三段；与 Mock adapter 同名同签名） ----

const RETRY_INTAKE_ANALYSIS_MUTATION = `
  mutation RetryIntakeAnalysis($id: Int!) {
    retryIntakeAnalysis(id: $id) {
      id
      intakeId
      analysisGeneration
      analysisStatus
      delivered
    }
  }
`;

type RetryIntakeAnalysisData = {
  retryIntakeAnalysis: {
    id: number;
    intakeId: number;
    analysisGeneration: number;
    analysisStatus: string;
    delivered: boolean;
  };
};

/**
 * 首析重试拒绝原因映射：主映射只依赖契约稳定的 GraphQL 大类码；
 * CONFLICT 在本 mutation 内唯一对应「当前状态不支持重试」（后端原子裁决），
 * NOT_FOUND 统一防探测口径。未知错误经后端 fallback 归为 BAD_USER_INPUT → invalid-input。
 */
const RETRY_FAILURE_REASON_BY_CATEGORY_CODE: Record<string, RetryIntakeAnalysisFailureReason> = {
  NOT_FOUND: 'not-found',
  CONFLICT: 'retry-unavailable',
  FORBIDDEN: 'forbidden',
  BAD_USER_INPUT: 'invalid-input',
  INTERNAL_SERVER_ERROR: 'retry-failed',
};

const RETRY_FALLBACK_MESSAGE_BY_REASON: Record<RetryIntakeAnalysisFailureReason, MessageKey> = {
  'not-found': 'customer.analysisRetryError.notFound',
  'retry-unavailable': 'customer.analysisRetryError.retryUnavailable',
  forbidden: 'customer.analysisRetryError.forbidden',
  'invalid-input': 'customer.analysisRetryError.invalidInput',
  'retry-failed': 'customer.analysisRetryError.retryFailed',
};

/**
 * 客户对失败的首次分析发起唯一一次重新分析（服务端原子裁决）。
 *
 * - 前端防重复只是交互辅助；代次 0→1 原子切换与执行资格核验都在后端事务内完成；
 * - transport / auth / network 类失败按共享错误模型上抛 GraphQLIngressError。
 */
export async function retryIntakeAnalysis(id: number): Promise<RetryIntakeAnalysisResult> {
  try {
    const data = await executeGraphQL<RetryIntakeAnalysisData, { id: number }>(
      RETRY_INTAKE_ANALYSIS_MUTATION,
      { id },
    );

    return {
      ok: true,
      analysisStatus: data.retryIntakeAnalysis.analysisStatus as IntakeAnalysisStatus,
      analysisGeneration: data.retryIntakeAnalysis.analysisGeneration,
    };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const reason = detail?.code ? RETRY_FAILURE_REASON_BY_CATEGORY_CODE[detail.code] : undefined;

    if (!detail || !reason) {
      throw error;
    }

    return {
      ok: false,
      reason,
      message: detail.errorMessage ?? translateNow(RETRY_FALLBACK_MESSAGE_BY_REASON[reason]),
    };
  }
}

const DOWNLOAD_FAILURE_REASON_BY_CODE: Record<string, DownloadMyRepairRequestFileFailureReason> = {
  STORED_FILE_NOT_FOUND: 'not-found',
  STORED_FILE_FILE_NOT_AVAILABLE: 'file-not-available',
  FORBIDDEN: 'insufficient-permission',
};

const DOWNLOAD_FALLBACK_MESSAGE_BY_REASON: Record<
  DownloadMyRepairRequestFileFailureReason,
  MessageKey
> = {
  'not-found': 'customer.downloadError.notFound',
  'file-not-available': 'customer.downloadError.fileNotAvailable',
  'insufficient-permission': 'customer.downloadError.insufficientPermission',
  'download-failed': 'customer.downloadError.downloadFailed',
};

/**
 * 下载本人报修原件（REST 授权下载；服务端按「真实绑定到本人原稿」裁决，
 * 猜测 fileId / 他人原件统一 NOT_FOUND）。
 *
 * - 与工程师原件下载共用同一 REST 入口与响应封装，仅用途级授权不同；
 * - transport / auth 类失败按共享错误模型处理为显式失败结果（下载不触发全局失效跳转）。
 */
export async function downloadMyRepairRequestFile(
  fileId: string,
): Promise<DownloadMyRepairRequestFileResult> {
  let response: Response;
  try {
    response = await fetchRestWithAuthRetry(
      `/api/stored-files/${encodeURIComponent(fileId)}/download`,
      {},
    );
  } catch {
    return {
      ok: false,
      reason: 'download-failed',
      message: translateNow('customer.downloadError.downloadFailed'),
    };
  }

  if (response.ok) {
    let blob: Blob;
    try {
      blob = await response.blob();
    } catch {
      return {
        ok: false,
        reason: 'download-failed',
        message: translateNow('customer.downloadError.downloadFailed'),
      };
    }

    const filename =
      parseAttachmentFilename(response.headers.get('Content-Disposition')) ??
      `repair-request-${fileId}`;

    return { ok: true, blob, filename };
  }

  let envelope: RestErrorEnvelope = {};
  try {
    envelope = toRestErrorEnvelope(await response.json());
  } catch {
    // 非 JSON 错误体，走兜底
  }

  const code = readRestErrorField(envelope, 'code');
  const reason = code ? DOWNLOAD_FAILURE_REASON_BY_CODE[code] : undefined;

  return {
    ok: false,
    reason: reason ?? 'download-failed',
    message:
      readRestErrorField(envelope, 'message') ??
      translateNow(DOWNLOAD_FALLBACK_MESSAGE_BY_REASON[reason ?? 'download-failed']),
  };
}
