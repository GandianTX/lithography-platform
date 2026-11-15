// src/features/repair-request/infrastructure/repair-request-adapter.ts

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';
import { type MessageKey, translateNow } from '@/shared/i18n';

import type {
  CreateRepairRequestFailureReason,
  CreateRepairRequestInput,
  CreateRepairRequestResult,
  EquipmentModelOption,
  RepairRequestRecord,
} from './repair-request.types';
import type {
  DeleteMyRepairRequestFailureReason,
  DeleteMyRepairRequestResult,
  MyRepairRequestDetailResult,
  RepairRequestDetail,
  RepairRequestListPage,
  RepairRequestListPagination,
} from './repair-request-read.types';

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

/**
 * 拒绝原因主映射：仅依赖契约保证稳定的 GraphQL 大类码 extensions.code
 * （backend/docs/api/graphql-error-contract-current.md），
 * 即使后端按契约在生产隐藏 errorCode 也不会退化失效。
 * transport / auth 类错误不归入业务拒绝，仍抛 GraphQLIngressError（见 graphql-error-model.md）。
 */
const FAILURE_REASON_BY_CATEGORY_CODE: Record<string, CreateRepairRequestFailureReason> = {
  NOT_FOUND: 'model-not-found',
  BAD_USER_INPUT: 'invalid-input',
  // 创建门禁（S4）：本 mutation 内 FORBIDDEN 唯一来源是客户归属缺失 / 不可用；
  // 生产隐藏 errorCode 时统一按「需先补录公司」引导，不新增错误通道。
  FORBIDDEN: 'company-required',
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
  REPAIR_REQUEST_INVALID_PARAMS: 'invalid-input',
  INPUT_NORMALIZE_REQUIRED_TEXT_EMPTY: 'invalid-input',
  INPUT_NORMALIZE_INVALID_TEXT: 'invalid-input',
  REPAIR_REQUEST_CUSTOMER_COMPANY_REQUIRED: 'company-required',
  REPAIR_REQUEST_CUSTOMER_COMPANY_UNAVAILABLE: 'company-unavailable',
};

const FALLBACK_MESSAGE_BY_REASON: Record<CreateRepairRequestFailureReason, MessageKey> = {
  'model-not-found': 'repairForm.error.modelNotFound',
  'model-disabled': 'repairForm.error.modelDisabled',
  'invalid-input': 'repairForm.error.invalidInput',
  'company-required': 'repairForm.error.companyRequired',
  'company-unavailable': 'repairForm.error.companyUnavailable',
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
