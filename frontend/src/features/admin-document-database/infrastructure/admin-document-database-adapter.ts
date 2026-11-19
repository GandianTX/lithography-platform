// src/features/admin-document-database/infrastructure/admin-document-database-adapter.ts

import { executeGraphQL, isGraphQLIngressError, readGraphQLErrorDetail } from '@/shared/graphql';
import { fetchRestWithAuthRetry, parseAttachmentFilename } from '@/shared/http';
import { translateNow } from '@/shared/i18n';

import type {
  AdminAiConversationFilter,
  AdminAiConversationListItem,
  AdminAiMessageListItem,
  AdminAiReportDetail,
  AdminAiReportFilter,
  AdminAiReportListItem,
  AdminDocumentDatabaseStats,
  AdminListPage,
  AdminRepairRequestFilter,
  AdminRepairRequestListItem,
  AdminRepairRequestRevisionDetail,
  AdminRepairRequestSummary,
  AdminRepairRevisionInput,
  AdminRepairRevisionResult,
} from './admin-document-database.types';

/**
 * 管理员文档数据库 GraphQL 数据访问层（PR3 S3）。
 *
 * - 只读：仅消费 SUPER_ADMIN 专用聚合 Query（backend/src/schema.graphql
 *   的 admin* Query 组），不触达任何写操作；
 * - 参考资料 tag 按计划表复用既有 features/reference-document 契约，
 *   不在此重复实现；
 * - transport / auth / network 失败由共享层归一为 GraphQLIngressError 上抛，
 *   详情读取的业务拒绝（NOT_FOUND / FORBIDDEN）按既有 adapter 惯例归并
 *   为显式 not-found 结果（详情见 reference-document-adapter 的错误双轨制）。
 */

type PaginationVariables = {
  pagination: {
    mode: 'OFFSET';
    page: number;
    pageSize: number;
    withTotal: true;
  };
};

// ---- 维修申请 ----

const ADMIN_REPAIR_REQUESTS_QUERY = `
  query AdminRepairRequests($pagination: PaginationArgs!, $filter: AdminRepairRequestFilterInput) {
    adminRepairRequests(pagination: $pagination, filter: $filter) {
      items {
        id
        requestNo
        customerNickname
        companyName
        equipmentModelId
        equipmentModelCode
        equipmentModelName
        errorCode
        isAccepted
        acceptedAt
        acceptedByEngineerNickname
        latestResolutionStatus
        closureStatus
        closedAt
        handlingResult
        handlingStatus
        createdAt
      }
      total
      page
      pageSize
    }
  }
`;

const ADMIN_REPAIR_REQUEST_SUMMARY_QUERY = `
  query AdminRepairRequestSummary($id: Int!) {
    adminRepairRequestSummary(id: $id) {
      id
      requestNo
      customerNickname
      companyName
      equipmentModelId
      equipmentModelCode
      equipmentModelName
      errorCode
      faultDescription
      contentMd
      isAccepted
      acceptedAt
      acceptedByEngineerNickname
      latestResolutionStatus
      createdAt
      closureStatus
      closedAt
      closureReason
      handlingResult
      handlingStatus
      currentRevisionNo
      processEntries {
        id
        entryUuid
        requestId
        operationText
        testResult
        occurredAt
        timeSource
        fileId
        versionNo
        createdAt
        file {
          fileId
          originalFilename
          mimeType
          byteSize
          checksumSha256
        }
      }
      responses {
        id
        responseText
        resolutionStatus
        engineerNickname
        createdAt
      }
      revisions {
        revisionNo
        previousVersion
        reason
        actorNickname
        createdAt
        hasComparableSnapshot
        schemaVersion
      }
      maintenanceVersionNo
      maintenance {
        maintenanceDate
        engineerName
        resetResult
        supplementaryNote
        versionNo
        attachment {
          fileId
          originalFilename
          mimeType
          byteSize
          checksumSha256
        }
      }
      maintenanceSteps {
        id
        stepNo
        errorCode
        partName
        actionText
        resultCode
      }
      maintenanceFaultPanels {
        id
        panelType
        stepId
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
      intake {
        intakeId
        faultDescription
        customerFile {
          fileId
          originalFilename
          mimeType
          byteSize
          checksumSha256
        }
        analysis {
          status
          generation
          outputText
          failureReason
          finishedAt
        }
      }
    }
  }
`;

const ADMIN_REPAIR_REQUEST_REVISION_DETAIL_QUERY = `
  query AdminRepairRequestRevisionDetail($requestId: Int!, $revisionNo: Int!) {
    adminRepairRequestRevisionDetail(requestId: $requestId, revisionNo: $revisionNo) {
      requestId
      revisionNo
      previousVersion
      reason
      actorNickname
      createdAt
      comparable
      hasMaintenanceData
      incomparableReason
      before { ...AdminRevisionSnapshotFields }
      after { ...AdminRevisionSnapshotFields }
    }
  }
  fragment AdminRevisionSnapshotFields on AdminRevisionSnapshotDTO {
    schemaVersion
    contentMd
    handlingResult
    handlingStatus
    closureReason
    maintenanceDate
    maintenanceEngineerName
    resetResult
    supplementaryNote
    maintenanceVersionNo
    maintenanceAttachmentFileId
    steps { id stepNo errorCode partName actionText resultCode }
    panels {
      id
      panelType
      stepId
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
  }
`;

const APPEND_ADMIN_REPAIR_REQUEST_REVISION_MUTATION = `
  mutation AppendRepairRequestRevision($input: AppendRepairRequestRevisionInput!) {
    appendRepairRequestRevision(input: $input) {
      requestId
      revisionNo
      previousVersion
      reason
      actorNickname
      currentRevisionNo
      createdAt
    }
  }
`;

// ---- AI 会话与消息 ----

const ADMIN_AI_CONVERSATIONS_QUERY = `
  query AdminAiConversations($pagination: PaginationArgs!, $filter: AdminAiConversationFilterInput) {
    adminAiConversations(pagination: $pagination, filter: $filter) {
      items {
        id
        requestNo
        requestId
        status
        engineerNickname
        messageCount
        reportCount
        createdAt
        completedAt
        aiFeedback
      }
      total
      page
      pageSize
    }
  }
`;

const ADMIN_AI_MESSAGES_QUERY = `
  query AdminAiMessages($conversationId: Int!, $pagination: PaginationArgs!) {
    adminAiMessages(conversationId: $conversationId, pagination: $pagination) {
      items {
        id
        conversationId
        messageSeq
        turnNo
        role
        contentText
        createdAt
      }
      total
      page
      pageSize
    }
  }
`;

// ---- AI 报告 ----

const ADMIN_AI_REPORTS_QUERY = `
  query AdminAiReports($pagination: PaginationArgs!, $filter: AdminAiReportFilterInput) {
    adminAiReports(pagination: $pagination, filter: $filter) {
      items {
        id
        conversationId
        requestId
        requestNo
        requestMismatch
        reportType
        reportTitle
        engineerNickname
        createdAt
      }
      total
      page
      pageSize
    }
  }
`;

const ADMIN_AI_REPORT_DETAIL_QUERY = `
  query AdminAiReport($id: Int!) {
    adminAiReport(id: $id) {
      id
      conversationId
      requestId
      requestNo
      requestMismatch
      reportType
      reportTitle
      engineerNickname
      createdAt
      contentMd
    }
  }
`;

// ---- 设备型号下拉选项（公开 equipmentModels 查询；维修申请标签筛选用） ----

const EQUIPMENT_MODELS_QUERY = `
  query AdminDocumentDatabaseEquipmentModels {
    equipmentModels {
      id
      modelCode
      modelName
    }
  }
`;

export type AdminEquipmentModelOption = {
  id: number;
  modelCode: string;
  modelName: string;
};

export async function fetchAdminEquipmentModelOptions(): Promise<AdminEquipmentModelOption[]> {
  const data = await executeGraphQL<
    { equipmentModels: AdminEquipmentModelOption[] },
    Record<string, never>
  >(EQUIPMENT_MODELS_QUERY, {});

  return data.equipmentModels;
}

// ---- 统计 ----

const ADMIN_DOCUMENT_DATABASE_STATS_QUERY = `
  query AdminDocumentDatabaseStats {
    adminDocumentDatabaseStats {
      repairRequestTotal
      referenceDocumentTotal
      aiConversationTotal
      aiReportTotal
    }
  }
`;

// ---- 变量构造：空值字段整体省略（契约 InputType 字段均可选） ----

function omitEmpty<T extends object>(filter: T | undefined): T | undefined {
  if (!filter) {
    return undefined;
  }

  const entries = Object.entries(filter).filter(([, value]) => {
    if (value === null || value === undefined) {
      return false;
    }

    if (typeof value === 'string' && value.trim() === '') {
      return false;
    }

    return true;
  });

  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

type PaginatedData<TItem> = {
  total?: number | null;
  page?: number | null;
  pageSize?: number | null;
  items: TItem[];
};

function toListPage<TItem>(
  data: PaginatedData<TItem>,
  fallback: { page: number; pageSize: number },
): AdminListPage<TItem> {
  return {
    items: data.items,
    total: data.total ?? 0,
    page: data.page ?? fallback.page,
    pageSize: data.pageSize ?? fallback.pageSize,
  };
}

export async function fetchAdminRepairRequests(
  page: number,
  pageSize: number,
  filter?: AdminRepairRequestFilter,
): Promise<AdminListPage<AdminRepairRequestListItem>> {
  const data = await executeGraphQL<
    { adminRepairRequests: PaginatedData<AdminRepairRequestListItem> },
    PaginationVariables & { filter?: AdminRepairRequestFilter }
  >(ADMIN_REPAIR_REQUESTS_QUERY, {
    pagination: { mode: 'OFFSET', page, pageSize, withTotal: true },
    filter: omitEmpty(filter),
  });

  return toListPage(data.adminRepairRequests, { page, pageSize });
}

export async function fetchAdminAiConversations(
  page: number,
  pageSize: number,
  filter?: AdminAiConversationFilter,
): Promise<AdminListPage<AdminAiConversationListItem>> {
  const data = await executeGraphQL<
    { adminAiConversations: PaginatedData<AdminAiConversationListItem> },
    PaginationVariables & { filter?: AdminAiConversationFilter }
  >(ADMIN_AI_CONVERSATIONS_QUERY, {
    pagination: { mode: 'OFFSET', page, pageSize, withTotal: true },
    filter: omitEmpty(filter),
  });

  return toListPage(data.adminAiConversations, { page, pageSize });
}

export async function fetchAdminAiMessages(
  conversationId: number,
  page: number,
  pageSize: number,
): Promise<AdminListPage<AdminAiMessageListItem>> {
  const data = await executeGraphQL<
    { adminAiMessages: PaginatedData<AdminAiMessageListItem> },
    PaginationVariables & { conversationId: number }
  >(ADMIN_AI_MESSAGES_QUERY, {
    conversationId,
    pagination: { mode: 'OFFSET', page, pageSize, withTotal: true },
  });

  return toListPage(data.adminAiMessages, { page, pageSize });
}

export async function fetchAdminAiReports(
  page: number,
  pageSize: number,
  filter?: AdminAiReportFilter,
): Promise<AdminListPage<AdminAiReportListItem>> {
  const data = await executeGraphQL<
    { adminAiReports: PaginatedData<AdminAiReportListItem> },
    PaginationVariables & { filter?: AdminAiReportFilter }
  >(ADMIN_AI_REPORTS_QUERY, {
    pagination: { mode: 'OFFSET', page, pageSize, withTotal: true },
    filter: omitEmpty(filter),
  });

  return toListPage(data.adminAiReports, { page, pageSize });
}

export async function fetchAdminDocumentDatabaseStats(): Promise<AdminDocumentDatabaseStats> {
  const data = await executeGraphQL<
    { adminDocumentDatabaseStats: AdminDocumentDatabaseStats },
    Record<string, never>
  >(ADMIN_DOCUMENT_DATABASE_STATS_QUERY, {});

  return data.adminDocumentDatabaseStats;
}

// ---- 详情：业务拒绝显式归并（不区分 not-found 与 forbidden，防探测口径与既有模块一致） ----

export type AdminDetailResult<TDetail> =
  | { ok: true; detail: TDetail }
  | { ok: false; message: string };

/** 详情读取的业务拒绝归并：NOT_FOUND / FORBIDDEN 统一为显式 not-found 结果（防探测） */
function toNotFoundResult<TDetail>(
  error: unknown,
  fallbackMessage: string,
): AdminDetailResult<TDetail> {
  if (isGraphQLIngressError(error)) {
    const detail = readGraphQLErrorDetail(error);

    if (detail?.code === 'NOT_FOUND' || detail?.code === 'FORBIDDEN') {
      return { ok: false, message: detail.errorMessage ?? fallbackMessage };
    }
  }

  throw error;
}

export async function fetchAdminRepairRequestSummary(
  id: number,
): Promise<AdminDetailResult<AdminRepairRequestSummary>> {
  try {
    const data = await executeGraphQL<
      { adminRepairRequestSummary: AdminRepairRequestSummary },
      { id: number }
    >(ADMIN_REPAIR_REQUEST_SUMMARY_QUERY, { id });

    return { ok: true, detail: data.adminRepairRequestSummary };
  } catch (error) {
    return toNotFoundResult(error, '维修申请不存在或不可查看。');
  }
}

/**
 * 读取单个修订版本的详情与前后快照（只读查看 / 对比上一版）。
 * 不可比原因由服务端明确返回，不在前端拼接当前工单补全快照。
 */
export async function fetchAdminRepairRequestRevisionDetail(
  requestId: number,
  revisionNo: number,
): Promise<AdminDetailResult<AdminRepairRequestRevisionDetail>> {
  try {
    const data = await executeGraphQL<
      { adminRepairRequestRevisionDetail: AdminRepairRequestRevisionDetail },
      { requestId: number; revisionNo: number }
    >(ADMIN_REPAIR_REQUEST_REVISION_DETAIL_QUERY, { requestId, revisionNo });

    return { ok: true, detail: data.adminRepairRequestRevisionDetail };
  } catch (error) {
    return toNotFoundResult(
      error,
      translateNow('adminRepairRequest.versionHistory.notAccessible'),
    );
  }
}

export type AdminRevisionMutationResult =
  | { ok: true; result: AdminRepairRevisionResult }
  | { ok: false; message: string };

/**
 * 管理员按版本条件修订工单已提交事实。
 *
 * 业务拒绝（BAD_USER_INPUT / CONFLICT / FORBIDDEN / NOT_FOUND）归并为可展示消息；
 * transport 失败继续上抛由调用方统一处理。服务端失败整体回滚，前端成功后必须
 * 重新读取详情，不本地拼接「已修订」事实。
 */
export async function appendAdminRepairRequestRevision(
  input: AdminRepairRevisionInput,
): Promise<AdminRevisionMutationResult> {
  try {
    const data = await executeGraphQL<
      { appendRepairRequestRevision: AdminRepairRevisionResult },
      { input: AdminRepairRevisionInput }
    >(APPEND_ADMIN_REPAIR_REQUEST_REVISION_MUTATION, { input });
    return { ok: true, result: data.appendRepairRequestRevision };
  } catch (error) {
    if (isGraphQLIngressError(error)) {
      const detail = readGraphQLErrorDetail(error);
      return { ok: false, message: detail?.errorMessage ?? error.userMessage };
    }
    throw error;
  }
}

export async function fetchAdminAiReportDetail(
  id: number,
): Promise<AdminDetailResult<AdminAiReportDetail>> {
  try {
    const data = await executeGraphQL<{ adminAiReport: AdminAiReportDetail }, { id: number }>(
      ADMIN_AI_REPORT_DETAIL_QUERY,
      { id },
    );

    return { ok: true, detail: data.adminAiReport };
  } catch (error) {
    return toNotFoundResult(error, 'AI 报告不存在或不可查看。');
  }
}

export type AdminRepairProcessFileDownloadResult =
  | { ok: true; blob: Blob; filename: string }
  | { ok: false; message: string };

/**
 * 下载已绑定维修过程原件（复用既有 REST 授权下载接口）。
 *
 * 后端该接口仅授权 SUPER_ADMIN / ENGINEER；管理员侧只提供下载入口，
 * 不新增上传、替换或移除能力。
 */
export async function downloadAdminRepairProcessFile(
  fileId: string,
): Promise<AdminRepairProcessFileDownloadResult> {
  let response: Response;
  try {
    response = await fetchRestWithAuthRetry(
      `/api/stored-files/${encodeURIComponent(fileId)}/download`,
      {},
    );
  } catch {
    return { ok: false, message: '原件下载失败，请检查网络后重试。' };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: response.status === 403 ? '当前账号无权下载该原件。' : '原件下载失败，请稍后重试。',
    };
  }

  try {
    const blob = await response.blob();
    const filename =
      parseAttachmentFilename(response.headers.get('Content-Disposition')) ??
      `repair-process-${fileId}`;
    return { ok: true, blob, filename };
  } catch {
    return { ok: false, message: '原件下载失败，请稍后重试。' };
  }
}
