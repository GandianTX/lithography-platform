// src/features/reference-document/infrastructure/reference-document-adapter.ts

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';

import type {
  CreateReferenceDocumentInput,
  CreateReferenceDocumentResult,
  DeleteReferenceDocumentResult,
  ReferenceDocumentDetail,
  ReferenceDocumentDetailResult,
  ReferenceDocumentEquipmentModelOption,
  ReferenceDocumentListFilter,
  ReferenceDocumentListPage,
  ReferenceDocumentListPagination,
  UpdateReferenceDocumentCasePatch,
  UpdateReferenceDocumentCaseResult,
  UpdateReferenceDocumentPatch,
  UpdateReferenceDocumentResult,
} from './reference-document.types';

/**
 * AI 参考资料库真实 GraphQL 数据访问层（阶段三；与阶段二 Mock 同名同签名）。
 *
 * 错误双轨制（frontend/docs/project-convention/graphql-error-model.md）：
 * - transport / auth / network / malformed 失败由共享层归一为 GraphQLIngressError 原样上抛；
 * - 业务拒绝（domain failure）返回显式结果 { ok: false, reason, message }，
 *   主信号是契约保证稳定的 extensions.code（backend/docs/api/graphql-error-contract-current.md），
 *   extensions.errorCode 仅作可选细化，生产环境隐藏时自动回退大类码映射，不会失效；
 * - 业务消息只读 extensions.errorMessage（生产可能隐藏），为空时用前端兜底文案，
 *   不取顶层通用 message；adapter 不读写 Session（Token 注入由 configureGraphQLRuntime 桥接）。
 */

const EQUIPMENT_MODELS_QUERY = `
  query EquipmentModels {
    equipmentModels {
      id
      modelCode
      modelName
    }
  }
`;

const REFERENCE_DOCUMENTS_QUERY = `
  query ReferenceDocuments($pagination: PaginationArgs!, $filter: ReferenceDocumentFilterInput) {
    referenceDocuments(pagination: $pagination, filter: $filter) {
      items {
        id
        title
        documentType
        equipmentModelId
        equipmentModelName
        equipmentModelText
        description
        originalFilename
        organizationName
        ingestMethod
        caseHandlingStatus
        creatorNickname
        createdAt
      }
      total
      page
      pageSize
    }
  }
`;

const REFERENCE_DOCUMENT_DETAIL_QUERY = `
  query ReferenceDocument($id: Int!) {
    referenceDocument(id: $id) {
      id
      title
      documentType
      equipmentModelId
      equipmentModelName
      equipmentModelText
      description
      originalFilename
      mimeType
      hasFile
      contentText
      organizationName
      ingestMethod
      caseDetail {
        errorCode
        handlingStatus
        phenomenon
        conditionText
        reproductionSteps
        diagnosis
        actionTaken
        resolution
      }
      creatorNickname
      createdAt
      updatedAt
    }
  }
`;

const CREATE_REFERENCE_DOCUMENT_MUTATION = `
  mutation CreateReferenceDocument($input: CreateReferenceDocumentInput!) {
    createReferenceDocument(input: $input) {
      id
    }
  }
`;

const UPDATE_REFERENCE_DOCUMENT_MUTATION = `
  mutation UpdateReferenceDocument($id: Int!, $input: UpdateReferenceDocumentInput!) {
    updateReferenceDocument(id: $id, input: $input) {
      id
    }
  }
`;

const SOFT_DELETE_REFERENCE_DOCUMENT_MUTATION = `
  mutation SoftDeleteReferenceDocument($id: Int!) {
    softDeleteReferenceDocument(id: $id) {
      id
    }
  }
`;

const UPDATE_REFERENCE_DOCUMENT_CASE_MUTATION = `
  mutation UpdateReferenceDocumentCase($id: Int!, $input: UpdateReferenceDocumentCaseInput!) {
    updateReferenceDocumentCase(id: $id, input: $input) {
      id
      updatedAt
    }
  }
`;

// ---- 错误映射（唯一真源：backend/src/core/common/errors/domain-error.ts 的 REFERENCE_DOCUMENT_ERROR 码组
//      与 backend/src/infrastructure/graphql/filters/graphql-exception.filter.ts 的大类映射） ----

/**
 * 创建拒绝原因主映射。create 的 NOT_FOUND 大类唯一来源是「型号不存在」
 * （资料自身不可能冲突），无需 errorCode 细化分支。
 */
const CREATE_FAILURE_REASON_BY_CATEGORY_CODE: Record<
  string,
  Extract<CreateReferenceDocumentResult, { ok: false }>['reason']
> = {
  NOT_FOUND: 'model-not-found',
  BAD_USER_INPUT: 'invalid-input',
  INTERNAL_SERVER_ERROR: 'creation-failed',
};

const CREATE_FALLBACK_MESSAGE_BY_REASON: Record<
  Extract<CreateReferenceDocumentResult, { ok: false }>['reason'],
  string
> = {
  'model-not-found': '所选设备型号不存在，请重新选择。',
  'invalid-input': '输入不符合要求，请检查后重新提交。',
  'creation-failed': '参考资料创建失败，请稍后重试。',
};

/**
 * 编辑拒绝原因主映射 + 可选细化。update 的 NOT_FOUND 大类有两个来源：
 * 资料不存在/已软删（默认 not-found）与型号不存在（经 errorCode 细化为 model-not-found）。
 */
const UPDATE_FAILURE_REASON_BY_CATEGORY_CODE: Record<
  string,
  Extract<UpdateReferenceDocumentResult, { ok: false }>['reason']
> = {
  NOT_FOUND: 'not-found',
  BAD_USER_INPUT: 'invalid-input',
  INTERNAL_SERVER_ERROR: 'update-failed',
};

const REFINED_UPDATE_REASON_BY_ERROR_CODE: Partial<
  Record<string, Extract<UpdateReferenceDocumentResult, { ok: false }>['reason']>
> = {
  REFERENCE_DOCUMENT_EQUIPMENT_MODEL_NOT_FOUND: 'model-not-found',
};

const UPDATE_FALLBACK_MESSAGE_BY_REASON: Record<
  Extract<UpdateReferenceDocumentResult, { ok: false }>['reason'],
  string
> = {
  'not-found': '参考资料不存在或不可编辑。',
  'model-not-found': '所选设备型号不存在，请重新选择。',
  'invalid-input': '输入不符合要求，请检查后重新提交。',
  'update-failed': '参考资料保存失败，请稍后重试。',
};

/**
 * 软删拒绝原因主映射。注意本模块软删不幂等：不存在与已软删统一 NOT_FOUND
 * （backend e2e 已钉住），前端归并 not-found，不区分原因。
 */
const DELETE_FAILURE_REASON_BY_CATEGORY_CODE: Record<
  string,
  Extract<DeleteReferenceDocumentResult, { ok: false }>['reason']
> = {
  NOT_FOUND: 'not-found',
  INTERNAL_SERVER_ERROR: 'delete-failed',
};

const DELETE_FALLBACK_MESSAGE_BY_REASON: Record<
  Extract<DeleteReferenceDocumentResult, { ok: false }>['reason'],
  string
> = {
  'not-found': '参考资料不存在或不可删除。',
  'delete-failed': '参考资料删除失败，请稍后重试。',
};

/**
 * 案例更正拒绝原因主映射 + 可选细化。NOT_FOUND 大类含两个来源：
 * 不存在/已软删/跨组织（默认 not-found）与型号不存在（经 errorCode 细化为 model-not-found）；
 * 非案例资料走 BAD_USER_INPUT（invalid-input，后端口径，不是 not-found）。
 */
const UPDATE_CASE_FAILURE_REASON_BY_CATEGORY_CODE: Record<
  string,
  Extract<UpdateReferenceDocumentCaseResult, { ok: false }>['reason']
> = {
  NOT_FOUND: 'not-found',
  BAD_USER_INPUT: 'invalid-input',
  INTERNAL_SERVER_ERROR: 'update-failed',
};

const REFINED_UPDATE_CASE_REASON_BY_ERROR_CODE: Partial<
  Record<string, Extract<UpdateReferenceDocumentCaseResult, { ok: false }>['reason']>
> = {
  REFERENCE_DOCUMENT_EQUIPMENT_MODEL_NOT_FOUND: 'model-not-found',
};

const UPDATE_CASE_FALLBACK_MESSAGE_BY_REASON: Record<
  Extract<UpdateReferenceDocumentCaseResult, { ok: false }>['reason'],
  string
> = {
  'not-found': '案例资料不存在或不可更正。',
  'model-not-found': '所选设备型号不存在，请重新选择。',
  'invalid-input': '输入不符合要求，请检查后重新提交。',
  'update-failed': '案例更正失败，请稍后重试。',
};

type EquipmentModelsData = {
  equipmentModels: ReferenceDocumentEquipmentModelOption[];
};

type ReferenceDocumentsData = {
  referenceDocuments: {
    items: ReferenceDocumentListPage['items'];
    total?: number | null;
    page?: number | null;
    pageSize?: number | null;
  };
};

type ReferenceDocumentDetailData = {
  referenceDocument: ReferenceDocumentDetail;
};

type CreateReferenceDocumentData = {
  createReferenceDocument: { id: number };
};

type UpdateReferenceDocumentData = {
  updateReferenceDocument: { id: number };
};

type SoftDeleteReferenceDocumentData = {
  softDeleteReferenceDocument: { id: number };
};

type UpdateReferenceDocumentCaseData = {
  updateReferenceDocumentCase: { id: number; updatedAt: string };
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

type ReferenceDocumentsVariables = PaginationVariables & {
  /** 筛选变量（可空 InputType；无筛选时整体省略，字段级空值也省略，与 Mock「无筛选」口径一致） */
  filter?: {
    title?: string;
    documentType?: string;
    equipmentModelId?: number;
    caseHandlingStatus?: string;
  };
};

/** 查询设备型号下拉选项（复用后端 equipmentModels 查询，仅启用型号，后端已按排序返回） */
export async function fetchReferenceEquipmentModels(): Promise<
  ReferenceDocumentEquipmentModelOption[]
> {
  const data = await executeGraphQL<EquipmentModelsData, Record<string, never>>(
    EQUIPMENT_MODELS_QUERY,
    {},
  );

  return data.equipmentModels;
}

/**
 * 查询参考资料列表（仅未软删，后端固定 createdAt DESC + id DESC，OFFSET 分页）。
 * 前端筛选名 titleKeyword 映射为契约字段 title；空白搜索词视为无筛选（与 Mock 口径一致）。
 */
export async function fetchReferenceDocuments(
  pagination: ReferenceDocumentListPagination,
  filter?: ReferenceDocumentListFilter,
): Promise<ReferenceDocumentListPage> {
  const titleKeyword = filter?.titleKeyword?.trim();
  const variables: ReferenceDocumentsVariables = {
    pagination: {
      mode: 'OFFSET',
      page: pagination.page,
      pageSize: pagination.pageSize,
      withTotal: true,
    },
    ...(filter &&
    (titleKeyword ||
      filter.documentType ||
      filter.equipmentModelId !== undefined ||
      filter.caseHandlingStatus)
      ? {
          filter: {
            ...(titleKeyword ? { title: titleKeyword } : {}),
            ...(filter.documentType ? { documentType: filter.documentType } : {}),
            ...(filter.equipmentModelId !== undefined
              ? { equipmentModelId: filter.equipmentModelId }
              : {}),
            ...(filter.caseHandlingStatus ? { caseHandlingStatus: filter.caseHandlingStatus } : {}),
          },
        }
      : {}),
  };

  const data = await executeGraphQL<ReferenceDocumentsData, ReferenceDocumentsVariables>(
    REFERENCE_DOCUMENTS_QUERY,
    variables,
  );

  return {
    items: data.referenceDocuments.items,
    // 后端分页工厂 total 为可空字段（withTotal: true 时必返回），类型上兜底为 0
    total: data.referenceDocuments.total ?? 0,
    page: data.referenceDocuments.page ?? pagination.page,
    pageSize: data.referenceDocuments.pageSize ?? pagination.pageSize,
  };
}

/**
 * 查询参考资料详情（元数据 + 文本内容）。
 *
 * - domain failure 归并为 not-found 防探测拒绝：不存在 / 已软删由后端统一 NOT_FOUND；
 *   FORBIDDEN（守卫拒绝）同样归并 not-found，与维修申请详情读取的既有契约处理一致；
 * - 其余失败（transport / auth / network 等）按共享错误模型上抛 GraphQLIngressError。
 */
export async function fetchReferenceDocument(id: number): Promise<ReferenceDocumentDetailResult> {
  try {
    const data = await executeGraphQL<ReferenceDocumentDetailData, { id: number }>(
      REFERENCE_DOCUMENT_DETAIL_QUERY,
      { id },
    );

    return { ok: true, detail: data.referenceDocument };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);

    if (detail?.code === 'NOT_FOUND' || detail?.code === 'FORBIDDEN') {
      return {
        ok: false,
        reason: 'not-found',
        message: detail.errorMessage ?? '参考资料不存在或不可查看。',
      };
    }

    throw error;
  }
}

/**
 * 创建参考资料（仅 SUPER_ADMIN；创建人由后端取自会话）。
 * 业务拒绝返回显式失败结果；transport / auth 类失败按共享错误模型上抛。
 */
export async function createReferenceDocument(
  input: CreateReferenceDocumentInput,
): Promise<CreateReferenceDocumentResult> {
  try {
    const data = await executeGraphQL<
      CreateReferenceDocumentData,
      { input: CreateReferenceDocumentInput }
    >(CREATE_REFERENCE_DOCUMENT_MUTATION, { input });

    return { ok: true, id: data.createReferenceDocument.id };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const reason = detail?.code ? CREATE_FAILURE_REASON_BY_CATEGORY_CODE[detail.code] : undefined;

    if (!detail || !reason) {
      throw error;
    }

    return {
      ok: false,
      reason,
      message: detail.errorMessage ?? CREATE_FALLBACK_MESSAGE_BY_REASON[reason],
    };
  }
}

/**
 * 编辑参考资料（仅 SUPER_ADMIN；PATCH 语义：未提供字段保持原值）。
 * NOT_FOUND 大类经 errorCode 细化区分「资料不可访问」与「所选型号不存在」。
 */
export async function updateReferenceDocument(
  id: number,
  patch: UpdateReferenceDocumentPatch,
): Promise<UpdateReferenceDocumentResult> {
  try {
    const data = await executeGraphQL<
      UpdateReferenceDocumentData,
      { id: number; input: UpdateReferenceDocumentPatch }
    >(UPDATE_REFERENCE_DOCUMENT_MUTATION, { id, input: patch });

    return { ok: true, id: data.updateReferenceDocument.id };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const categoryReason = detail?.code
      ? UPDATE_FAILURE_REASON_BY_CATEGORY_CODE[detail.code]
      : undefined;

    if (!detail || !categoryReason) {
      throw error;
    }

    const reason =
      (detail.errorCode ? REFINED_UPDATE_REASON_BY_ERROR_CODE[detail.errorCode] : undefined) ??
      categoryReason;

    return {
      ok: false,
      reason,
      message: detail.errorMessage ?? UPDATE_FALLBACK_MESSAGE_BY_REASON[reason],
    };
  }
}

/**
 * 软删除参考资料（仅 SUPER_ADMIN；重复软删不幂等，统一 not-found）。
 * 业务拒绝返回显式失败结果；transport / auth 类失败按共享错误模型上抛。
 */
export async function deleteReferenceDocument(id: number): Promise<DeleteReferenceDocumentResult> {
  try {
    await executeGraphQL<SoftDeleteReferenceDocumentData, { id: number }>(
      SOFT_DELETE_REFERENCE_DOCUMENT_MUTATION,
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
      message: detail.errorMessage ?? DELETE_FALLBACK_MESSAGE_BY_REASON[reason],
    };
  }
}

/**
 * 更正正式案例资料（仅 SUPER_ADMIN；仅 FAULT_CASE 资料）。
 * 不存在 / 已软删 / 跨组织由后端统一 NOT_FOUND（防探测）；非案例资料为 INVALID_PARAMS
 * （invalid-input，后端口径，不是 not-found）；型号不存在经 errorCode 细化为 model-not-found；
 * 返回资料最新更新时间。
 */
export async function updateReferenceDocumentCase(
  id: number,
  patch: UpdateReferenceDocumentCasePatch,
): Promise<UpdateReferenceDocumentCaseResult> {
  try {
    const data = await executeGraphQL<
      UpdateReferenceDocumentCaseData,
      { id: number; input: UpdateReferenceDocumentCasePatch }
    >(UPDATE_REFERENCE_DOCUMENT_CASE_MUTATION, { id, input: patch });

    return {
      ok: true,
      id: data.updateReferenceDocumentCase.id,
      updatedAt: data.updateReferenceDocumentCase.updatedAt,
    };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const categoryReason = detail?.code
      ? UPDATE_CASE_FAILURE_REASON_BY_CATEGORY_CODE[detail.code]
      : undefined;

    if (!detail || !categoryReason) {
      throw error;
    }

    const reason =
      (detail.errorCode ? REFINED_UPDATE_CASE_REASON_BY_ERROR_CODE[detail.errorCode] : undefined) ??
      categoryReason;

    return {
      ok: false,
      reason,
      message: detail.errorMessage ?? UPDATE_CASE_FALLBACK_MESSAGE_BY_REASON[reason],
    };
  }
}
