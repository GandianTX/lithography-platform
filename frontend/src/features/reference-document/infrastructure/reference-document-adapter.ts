// src/features/reference-document/infrastructure/reference-document-adapter.ts

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';

import type {
  DeleteReferenceDocumentResult,
  ReferenceDocumentDetail,
  ReferenceDocumentDetailResult,
  ReferenceDocumentEditableContent,
  ReferenceDocumentEquipmentModelOption,
  ReferenceDocumentListFilter,
  ReferenceDocumentListPage,
  ReferenceDocumentListPagination,
  ReferenceDocumentManagedMutationResult,
  ReferenceDocumentRevisions,
  ReferenceDocumentStructuredRevisionPayload,
  ReviseReferenceDocumentPatch,
  UpdateReferenceDocumentCasePatch,
  UpdateReferenceDocumentCaseResult,
} from './reference-document.types';

/**
 * AI 参考资料库真实 GraphQL 数据访问层。
 *
 * 错误双轨制（frontend/docs/project-convention/graphql-error-model.md）：
 * - transport / auth / network / malformed 失败由共享层归一为 GraphQLIngressError 原样上抛；
 * - 业务拒绝（domain failure）返回显式结果 { ok: false, reason, message }，
 *   主信号是契约保证稳定的 extensions.code（backend/docs/api/graphql-error-contract-current.md），
 *   extensions.errorCode 仅作可选细化，生产环境隐藏时自动回退大类码映射，不会失效；
 * - 业务消息只读 extensions.errorMessage（生产可能隐藏），为空时用前端兜底文案，
 *   不取顶层通用 message；adapter 不读写 Session（Token 注入由 configureGraphQLRuntime 桥接）。
 *
 * 任务 07 确认需求收口：旧普通新增（createReferenceDocument）与通用编辑
 * （updateReferenceDocument）已随服务端写入口一并关闭——本期普通资料新增与资料
 * 审核取消，本 adapter 不再持有对应调用；历史资料照常授权读取（列表/详情/历史
 * 版本），合法附件下载能力由 reference-document-http-adapter 保留。
 * 管理动作按新规则拆分（R053/R058–R061），均携带 expected_version（取自
 * referenceDocumentRevisions.currentRevisionNo）。
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

/**
 * 列表字段选择（普通列表与归属待核实清单共用同一字段集合，R061-01 清单复用同一 DTO 形状）。
 */
const REFERENCE_DOCUMENT_LIST_ITEM_FIELDS = `
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
        sourceKind
        effectiveRevisionNo
        caseHandlingStatus
        creatorNickname
        createdAt
`;

const REFERENCE_DOCUMENTS_QUERY = `
  query ReferenceDocuments($pagination: PaginationArgs!, $filter: ReferenceDocumentFilterInput) {
    referenceDocuments(pagination: $pagination, filter: $filter) {
      items {
${REFERENCE_DOCUMENT_LIST_ITEM_FIELDS}
      }
      total
      page
      pageSize
    }
  }
`;

/**
 * 详情字段选择（普通详情与归属待核实详情共用同一字段集合，R061-01 详情复用同一 DTO 形状）。
 */
const REFERENCE_DOCUMENT_DETAIL_FIELDS = `
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
      contentSource
      sourceKind
      sourceReportId
      sourceReportVersionId
      effectiveRevisionNo
      frozenReport {
        versionId
        versionNo
        schemaVersion
        submittedAt
        sourceType
        repairRequestId
        title
        customerFactoryName
        equipmentModelId
        equipmentModelText
        maintenanceDate
        maintenanceEngineerName
        alarms {
          alarmIndex
          alarmCode
          alarmDescription
          phaseCode
          resetResult
        }
        steps {
          stepNo
          stepCode
          phaseCode
          partName
          actionText
          resultText
          newAlarmCode
          isValidNewBranch
        }
        faults {
          branchKind
          stepCode
          phaseCode
          mainError
          unitError
          source
          errorType
          gpibStatus
          faultStatus
          description
          action
        }
        handlingResult
        closureReason
        resetResult
        actualCause
        repairActions
        verificationResult
        supplementaryNote
        ai {
          usage
          sourceType
          sourceId
          sourceVersion
          score
          correctness
          helpfulness
          note
        }
      }
      sourceReportAttachment {
        attachmentId
        fileId
        originalFilename
        mimeType
        byteSize
      }
      structuredContent {
        schemaVersion
        maintenanceDate
        maintenanceEngineerName
        customerFactoryName
        equipmentModelText
        resetResult
        faults {
          branchKind
          stepCode
          phaseCode
          mainError
          unitError
          source
          errorType
          gpibStatus
          faultStatus
          description
          action
        }
        steps {
          stepCode
          stepNo
          phaseCode
          errorCode
          partName
          actionText
          resultCode
        }
        handlingResult
        closureReason
        actualCause
        repairActions
        verificationResult
        supplementaryNote
      }
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
      viewerIsOriginalAuthor
      createdAt
      updatedAt
`;

const REFERENCE_DOCUMENT_DETAIL_QUERY = `
  query ReferenceDocument($id: Int!) {
    referenceDocument(id: $id) {
${REFERENCE_DOCUMENT_DETAIL_FIELDS}
    }
  }
`;

const PENDING_OWNERSHIP_REFERENCE_DOCUMENTS_QUERY = `
  query PendingOwnershipReferenceDocuments($pagination: PaginationArgs!) {
    pendingOwnershipReferenceDocuments(pagination: $pagination) {
      items {
${REFERENCE_DOCUMENT_LIST_ITEM_FIELDS}
      }
      total
      page
      pageSize
    }
  }
`;

const PENDING_OWNERSHIP_REFERENCE_DOCUMENT_DETAIL_QUERY = `
  query PendingOwnershipReferenceDocument($id: Int!) {
    pendingOwnershipReferenceDocument(id: $id) {
${REFERENCE_DOCUMENT_DETAIL_FIELDS}
    }
  }
`;

const REFERENCE_DOCUMENT_REVISIONS_QUERY = `
  query ReferenceDocumentRevisions($id: Int!) {
    referenceDocumentRevisions(id: $id) {
      documentId
      currentRevisionNo
      sourceKind
      sourceReportVersionId
      revisions {
        revisionNo
        reason
        actorNickname
        createdAt
        contentText
      }
    }
  }
`;

/**
 * 管理动作 mutation（R058/R059/R060/R061-02）：均携带 expected_version；
 * 原作者删除（R053）独立 mutation 且带 expected_version。
 */
const REVISE_REFERENCE_DOCUMENT_MUTATION = `
  mutation ReviseReferenceDocument($id: Int!, $input: ReviseReferenceDocumentInput!) {
    reviseReferenceDocument(id: $id, input: $input) {
      id
      revisionNo
    }
  }
`;

const REFERENCE_DOCUMENT_EDITABLE_CONTENT_QUERY = `
  query ReferenceDocumentEditableContent($id: Int!) {
    referenceDocumentEditableContent(id: $id) {
      documentId
      title
      description
      documentType
      expectedVersion
      sourceKind
      mode
      structured {
        schemaVersion
        maintenanceDate
        maintenanceEngineerName
        customerFactoryName
        equipmentModelText
        resetResult
        faults {
          branchKind
          stepCode
          phaseCode
          mainError
          unitError
          source
          errorType
          gpibStatus
          faultStatus
          description
          action
        }
        steps {
          stepCode
          stepNo
          phaseCode
          errorCode
          partName
          actionText
          resultCode
        }
        handlingResult
        closureReason
        actualCause
        repairActions
        verificationResult
        supplementaryNote
      }
      contentText
      equipmentModelId
      equipmentModelName
      faultCaseProtected
    }
  }
`;

const REVISE_REFERENCE_DOCUMENT_STRUCTURED_MUTATION = `
  mutation ReviseReferenceDocumentStructured($id: Int!, $input: ReviseReferenceDocumentStructuredInput!) {
    reviseReferenceDocumentStructured(id: $id, input: $input) {
      id
      revisionNo
    }
  }
`;

const OFFLINE_REFERENCE_DOCUMENT_MUTATION = `
  mutation OfflineReferenceDocument($id: Int!, $input: OfflineReferenceDocumentInput!) {
    offlineReferenceDocument(id: $id, input: $input) {
      id
      revisionNo
    }
  }
`;

const ADMIN_DELETE_REFERENCE_DOCUMENT_MUTATION = `
  mutation AdminDeleteReferenceDocument($id: Int!, $input: AdminDeleteReferenceDocumentInput!) {
    adminDeleteReferenceDocument(id: $id, input: $input) {
      id
      revisionNo
    }
  }
`;

const CORRECT_REFERENCE_DOCUMENT_OWNERSHIP_MUTATION = `
  mutation CorrectReferenceDocumentOwnership(
    $id: Int!
    $input: CorrectReferenceDocumentOwnershipInput!
  ) {
    correctReferenceDocumentOwnership(id: $id, input: $input) {
      id
      revisionNo
    }
  }
`;

const SOFT_DELETE_REFERENCE_DOCUMENT_MUTATION = `
  mutation SoftDeleteReferenceDocument($id: Int!, $expectedVersion: Int!) {
    softDeleteReferenceDocument(id: $id, expectedVersion: $expectedVersion) {
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
 * 管理操作拒绝原因映射（R058–R061 共用）：
 * - CONFLICT 大类 → version-conflict（expected_version 过期，R053/R058–R061 均可能）；
 * - NOT_FOUND 大类 → not-found（防探测统一口径）；
 * - BAD_USER_INPUT 大类 → invalid-input；
 * - 其余（内部错误）→ management-failed。
 */
const MANAGED_MUTATION_REASON_BY_CATEGORY_CODE: Record<
  string,
  Extract<ReferenceDocumentManagedMutationResult, { ok: false }>['reason']
> = {
  CONFLICT: 'version-conflict',
  NOT_FOUND: 'not-found',
  BAD_USER_INPUT: 'invalid-input',
  INTERNAL_SERVER_ERROR: 'management-failed',
};

const MANAGED_MUTATION_FALLBACK_MESSAGE_BY_REASON: Record<
  Extract<ReferenceDocumentManagedMutationResult, { ok: false }>['reason'],
  string
> = {
  'version-conflict': '资料版本已更新，请重新读取当前版本后重试。',
  'not-found': '参考资料不存在或不可访问。',
  'invalid-input': '输入不符合要求，请检查后重新提交。',
  'management-failed': '资料管理操作失败，请稍后重试。',
};

/**
 * 原作者删除（R053）拒绝原因映射。本操作不幂等：不存在与已软删统一 NOT_FOUND
 * （防探测口径），前端归并 not-found；expected_version 过期归并 version-conflict。
 */
const DELETE_FAILURE_REASON_BY_CATEGORY_CODE: Record<
  string,
  Extract<DeleteReferenceDocumentResult, { ok: false }>['reason']
> = {
  NOT_FOUND: 'not-found',
  CONFLICT: 'version-conflict',
  INTERNAL_SERVER_ERROR: 'delete-failed',
};

const DELETE_FALLBACK_MESSAGE_BY_REASON: Record<
  Extract<DeleteReferenceDocumentResult, { ok: false }>['reason'],
  string
> = {
  'not-found': '参考资料不存在或不可删除。',
  'version-conflict': '资料版本已更新，请重新读取当前版本后重试。',
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

type PendingOwnershipReferenceDocumentsData = {
  pendingOwnershipReferenceDocuments: ReferenceDocumentsData['referenceDocuments'];
};

type PendingOwnershipReferenceDocumentDetailData = {
  pendingOwnershipReferenceDocument: ReferenceDocumentDetail;
};

type ReferenceDocumentRevisionsData = {
  referenceDocumentRevisions: ReferenceDocumentRevisions;
};

type ReferenceDocumentManagedMutationData = {
  reviseReferenceDocument?: { id: number; revisionNo: number };
  offlineReferenceDocument?: { id: number; revisionNo: number };
  adminDeleteReferenceDocument?: { id: number; revisionNo: number };
  correctReferenceDocumentOwnership?: { id: number; revisionNo: number };
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
 * 查询参考资料详情（元数据 + 生效正文 + 可空案例明细 + 冻结报告）。
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
 * 查询归属待核实清单（任务 07 R061-01，仅一级管理员）：
 * 与普通资料库分开的管理入口查询，服务端按一级身份核验并返回真实 total。
 */
export async function fetchPendingOwnershipReferenceDocuments(
  pagination: ReferenceDocumentListPagination,
): Promise<ReferenceDocumentListPage> {
  const data = await executeGraphQL<PendingOwnershipReferenceDocumentsData, PaginationVariables>(
    PENDING_OWNERSHIP_REFERENCE_DOCUMENTS_QUERY,
    {
      pagination: {
        mode: 'OFFSET',
        page: pagination.page,
        pageSize: pagination.pageSize,
        withTotal: true,
      },
    },
  );

  return {
    items: data.pendingOwnershipReferenceDocuments.items,
    total: data.pendingOwnershipReferenceDocuments.total ?? 0,
    page: data.pendingOwnershipReferenceDocuments.page ?? pagination.page,
    pageSize: data.pendingOwnershipReferenceDocuments.pageSize ?? pagination.pageSize,
  };
}

/**
 * 查询归属待核实资料详情（任务 07 R061-01，仅一级管理员）。
 *
 * - 非 PENDING（已确认/已下架）、已软删与直接 ID 探测由后端统一 NOT_FOUND，
 *   归并为 not-found；FORBIDDEN（守卫拒绝二级/工程师/客户）同样归并 not-found；
 * - 其余失败按共享错误模型上抛 GraphQLIngressError。
 */
export async function fetchPendingOwnershipReferenceDocument(
  id: number,
): Promise<ReferenceDocumentDetailResult> {
  try {
    const data = await executeGraphQL<PendingOwnershipReferenceDocumentDetailData, { id: number }>(
      PENDING_OWNERSHIP_REFERENCE_DOCUMENT_DETAIL_QUERY,
      { id },
    );

    return { ok: true, detail: data.pendingOwnershipReferenceDocument };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);

    if (detail?.code === 'NOT_FOUND' || detail?.code === 'FORBIDDEN') {
      return {
        ok: false,
        reason: 'not-found',
        message: detail.errorMessage ?? '归属待核实资料不存在或不可查看。',
      };
    }

    throw error;
  }
}

/**
 * 查询参考资料历史版本（生效修订摘要 + 原始冻结报告版本标识）。
 * 与列表/详情/下载共用同一服务端可见范围；不可见资料统一 NOT_FOUND。
 * currentRevisionNo 即 expected_version（R053/R058–R061 写前的版本核对依据）。
 */
export async function fetchReferenceDocumentRevisions(
  id: number,
): Promise<ReferenceDocumentRevisions> {
  const data = await executeGraphQL<ReferenceDocumentRevisionsData, { id: number }>(
    REFERENCE_DOCUMENT_REVISIONS_QUERY,
    { id },
  );

  return data.referenceDocumentRevisions;
}

/** 共用错误归并：管理操作 domain failure 显式结果（transport / auth 仍上抛） */
function toManagedMutationResult(error: unknown): ReferenceDocumentManagedMutationResult {
  const detail = readGraphQLErrorDetail(error);
  const reason = detail?.code ? MANAGED_MUTATION_REASON_BY_CATEGORY_CODE[detail.code] : undefined;
  if (!detail || !reason) {
    throw error;
  }
  return {
    ok: false,
    reason,
    message: detail.errorMessage ?? MANAGED_MUTATION_FALLBACK_MESSAGE_BY_REASON[reason],
  };
}

/**
 * 管理修订正式资料（任务 07 R058，仅一级管理员；后端 @Roles(SUPER_ADMIN) + 等级事实复核）。
 */
export async function reviseReferenceDocument(
  id: number,
  expectedVersion: number,
  patch: ReviseReferenceDocumentPatch,
  reason: string,
): Promise<ReferenceDocumentManagedMutationResult> {
  try {
    const data = await executeGraphQL<
      ReferenceDocumentManagedMutationData,
      {
        id: number;
        input: { expectedVersion: number; reason: string } & ReviseReferenceDocumentPatch;
      }
    >(REVISE_REFERENCE_DOCUMENT_MUTATION, { id, input: { expectedVersion, reason, ...patch } });
    const result = data.reviseReferenceDocument;
    if (!result) throw new Error('reviseReferenceDocument missing');
    return { ok: true, id: result.id, revisionNo: result.revisionNo };
  } catch (error) {
    return toManagedMutationResult(error);
  }
}

type ReferenceDocumentEditableContentData = {
  referenceDocumentEditableContent: ReferenceDocumentEditableContent;
};

/**
 * 查询管理修订编辑初值（独立管理修订页专用，仅一级管理员）。
 * FORBIDDEN（守卫拒绝二级/工程师/客户）与 NOT_FOUND 归并 not-found，防探测口径一致。
 */
export async function fetchReferenceDocumentEditableContent(
  id: number,
): Promise<
  | { ok: true; content: ReferenceDocumentEditableContent }
  | { ok: false; reason: 'not-found'; message: string }
> {
  try {
    const data = await executeGraphQL<ReferenceDocumentEditableContentData, { id: number }>(
      REFERENCE_DOCUMENT_EDITABLE_CONTENT_QUERY,
      { id },
    );
    return { ok: true, content: data.referenceDocumentEditableContent };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    if (detail?.code === 'NOT_FOUND' || detail?.code === 'FORBIDDEN') {
      return {
        ok: false,
        reason: 'not-found',
        message: detail.errorMessage ?? '参考资料不存在或不可访问。',
      };
    }
    throw error;
  }
}

type ReferenceDocumentManagedMutationDataWithStructured = ReferenceDocumentManagedMutationData & {
  reviseReferenceDocumentStructured?: { id: number; revisionNo: number };
};

/**
 * 结构化管理修订正式资料（任务 07，报告来源正式资料；仅一级管理员）。
 * 结构化内容全量值语义（厂家文本可修订）；equipmentModelId 未提交＝保持原值，
 * 显式 null＝拒绝清空；改选目标由服务端按 ID 校验并从字典取名称。
 * expected_version 过期归并 version-conflict。
 */
export async function reviseReferenceDocumentStructured(
  id: number,
  input: {
    expectedVersion: number;
    reason: string;
    title?: string;
    description?: string | null;
    structured?: ReferenceDocumentStructuredRevisionPayload;
    /** 机型改选目标（仅在改选时提交；undefined=保持原关联） */
    equipmentModelId?: number | null;
  },
): Promise<ReferenceDocumentManagedMutationResult> {
  try {
    const data = await executeGraphQL<
      ReferenceDocumentManagedMutationDataWithStructured,
      { id: number; input: typeof input }
    >(REVISE_REFERENCE_DOCUMENT_STRUCTURED_MUTATION, { id, input });
    const result = data.reviseReferenceDocumentStructured;
    if (!result) throw new Error('reviseReferenceDocumentStructured missing');
    return { ok: true, id: result.id, revisionNo: result.revisionNo };
  } catch (error) {
    return toManagedMutationResult(error);
  }
}

/**
 * 下架正式资料（任务 07 R059，仅一级管理员）：下架与删除分别确认，不共用入口。
 */
export async function offlineReferenceDocument(
  id: number,
  expectedVersion: number,
  reason: string,
): Promise<ReferenceDocumentManagedMutationResult> {
  try {
    const data = await executeGraphQL<
      ReferenceDocumentManagedMutationData,
      { id: number; input: { expectedVersion: number; reason: string } }
    >(OFFLINE_REFERENCE_DOCUMENT_MUTATION, { id, input: { expectedVersion, reason } });
    const result = data.offlineReferenceDocument;
    if (!result) throw new Error('offlineReferenceDocument missing');
    return { ok: true, id: result.id, revisionNo: result.revisionNo };
  } catch (error) {
    return toManagedMutationResult(error);
  }
}

/**
 * 管理删除正式资料（任务 07 R060，仅一级管理员）：与管理修订/下架分别确认。
 */
export async function adminDeleteReferenceDocument(
  id: number,
  expectedVersion: number,
  reason: string,
): Promise<ReferenceDocumentManagedMutationResult> {
  try {
    const data = await executeGraphQL<
      ReferenceDocumentManagedMutationData,
      { id: number; input: { expectedVersion: number; reason: string } }
    >(ADMIN_DELETE_REFERENCE_DOCUMENT_MUTATION, { id, input: { expectedVersion, reason } });
    const result = data.adminDeleteReferenceDocument;
    if (!result) throw new Error('adminDeleteReferenceDocument missing');
    return { ok: true, id: result.id, revisionNo: result.revisionNo };
  } catch (error) {
    return toManagedMutationResult(error);
  }
}

/**
 * 保存资料归属更正（任务 07 R061-02，仅一级管理员）：仅提交需更正的字段。
 */
export async function correctReferenceDocumentOwnership(
  id: number,
  expectedVersion: number,
  input: {
    verificationReason: string;
    createdByAccountId?: number;
    ownerOrganizationId?: number;
  },
): Promise<ReferenceDocumentManagedMutationResult> {
  try {
    const data = await executeGraphQL<
      ReferenceDocumentManagedMutationData,
      {
        id: number;
        input: { expectedVersion: number } & {
          verificationReason: string;
          createdByAccountId?: number;
          ownerOrganizationId?: number;
        };
      }
    >(CORRECT_REFERENCE_DOCUMENT_OWNERSHIP_MUTATION, {
      id,
      input: { expectedVersion, ...input },
    });
    const result = data.correctReferenceDocumentOwnership;
    if (!result) throw new Error('correctReferenceDocumentOwnership missing');
    return { ok: true, id: result.id, revisionNo: result.revisionNo };
  } catch (error) {
    return toManagedMutationResult(error);
  }
}

/**
 * 原作者删除本人正式资料（任务 07 R053；expected_version 过期归并 version-conflict）。
 * 业务拒绝返回显式失败结果；transport / auth 类失败按共享错误模型上抛。
 */
export async function deleteReferenceDocument(
  id: number,
  expectedVersion: number,
): Promise<DeleteReferenceDocumentResult> {
  try {
    await executeGraphQL<SoftDeleteReferenceDocumentData, { id: number; expectedVersion: number }>(
      SOFT_DELETE_REFERENCE_DOCUMENT_MUTATION,
      { id, expectedVersion },
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
