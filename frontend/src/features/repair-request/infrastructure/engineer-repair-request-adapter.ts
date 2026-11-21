// src/features/repair-request/infrastructure/engineer-repair-request-adapter.ts

/**
 * 工程师维修申请读写 GraphQL adapter（防腐层）。
 *
 * - 所有请求复用 shared/graphql.executeGraphQL（protected request 默认语义，
 *   Token 注入与 auth 失效宣告由共享链路负责），不直接 fetch、不新建 Apollo Client；
 * - 原始 DTO 只停留在本文件与 ./engineer-repair-request.types.ts；
 *   对外返回经 mapper 归一后的干净模型（可空字段收拢为 null）；
 * - 业务拒绝（接单冲突/不可访问等）返回显式失败结果，
 *   主映射只依赖契约保证稳定的 extensions.code 大类，不依赖生产可能隐藏的
 *   extensions.errorCode 做运行时分支（见 backend/docs/api/graphql-error-contract-current.md）；
 * - transport / auth 类错误仍按共享错误模型上抛 GraphQLIngressError：
 *   普通失败由 application 转用户提示，auth 错误继续交给全局 Session 失效链路。
 */

import { executeGraphQL } from '@/shared/graphql';
import { readGraphQLErrorDetail } from '@/shared/graphql';
import {
  fetchRestWithAuthRetry,
  parseAttachmentFilename,
  readRestErrorField,
  type RestErrorEnvelope,
  toRestErrorEnvelope,
} from '@/shared/http';
import { type MessageKey, translateNow } from '@/shared/i18n';

import type {
  AcceptRepairRequestFailureReason,
  AcceptRepairRequestResult,
  CloseRepairRequestFailureReason,
  CloseRepairRequestInput,
  CloseRepairRequestResult,
  CreateEngineerResponseFailureReason,
  CreateEngineerResponseInput,
  CreateEngineerResponseResult,
  CreateRepairProcessEntryInput,
  DownloadRepairProcessFileResult,
  EngineerRepairIntake,
  EngineerRepairIntakeAnalysis,
  EngineerRepairListFilter,
  EngineerRepairListQuery,
  EngineerRepairMaintenanceFaultPanel,
  EngineerRepairMaintenanceRecord,
  EngineerRepairMaintenanceStep,
  EngineerRepairProcessEntry,
  EngineerRepairRequestDetail,
  EngineerRepairRequestDetailFailureReason,
  EngineerRepairRequestDetailResult,
  EngineerRepairRequestEquipmentModel,
  EngineerRepairRequestListItem,
  EngineerRepairRequestPage,
  EngineerRepairRequestResponseItem,
  EngineerRepairRevisionCompareUnavailableReason,
  EngineerRepairRevisionDetail,
  EngineerRepairRevisionDetailDTO,
  EngineerRepairRevisionDetailResult,
  EngineerRepairRevisionHistoryItem,
  EngineerRepairRevisionHistoryItemDTO,
  EngineerRepairRevisionHistoryResult,
  EngineerRepairRevisionSnapshot,
  EngineerRepairRevisionSnapshotDTO,
  EngineerResponseDTO,
  EquipmentModelDTO,
  InterruptRepairRequestInput,
  InterruptRepairRequestResult,
  RepairIntakeSourceDTO,
  RepairMaintenanceFaultPanelDTO,
  RepairMaintenanceRecordDTO,
  RepairMaintenanceStepDTO,
  RepairMaintenanceWriteResult,
  RepairProcessEntryDTO,
  RepairProcessWriteFailureReason,
  RepairProcessWriteResult,
  RepairRequestClosure,
  RepairRequestDetailDTO,
  RepairRequestInterruption,
  RepairRequestListItemDTO,
  RepairRequestPaginatedDTO,
  RepairRequestPaginationVariables,
  SaveRepairRequestMaintenanceInput,
  UpdateRepairProcessEntryInput,
  UploadRepairProcessFileFailureReason,
  UploadRepairProcessFileResult,
} from './engineer-repair-request.types';
import { uploadStagedStoredFile } from './stored-file-upload';

const ENGINEER_REPAIR_REQUESTS_QUERY = `
  query EngineerRepairRequests($scope: String!, $pagination: PaginationArgs!, $filter: EngineerRepairRequestFilterInput) {
    engineerRepairRequests(scope: $scope, pagination: $pagination, filter: $filter) {
      items {
        id
        requestNo
        equipmentModel { id modelCode modelName }
        errorCode
        createdAt
        isAccepted
        acceptedAt
        latestResolutionStatus
        customerNickname
        customerCompanyName
        acceptanceViewStatus
        acceptedEngineerNickname
        closureStatus
        closedAt
        handlingResult
        handlingStatus
      }
      total
      page
      pageSize
    }
  }
`;

/**
 * 工程师详情字段片段：详情查询与接单 Mutation 共用同一份字段集合，
 * 保证接单成功后的原子回填包含结构化维修记录/客户原始报修/AI 分析。
 */
const ENGINEER_REPAIR_REQUEST_DETAIL_FIELDS = `
  fragment EngineerRepairRequestDetailFields on RepairRequestDetailDTO {
    id
    requestNo
    equipmentModel { id modelCode modelName }
    errorCode
    faultDescription
    contentMd
    createdAt
    isAccepted
    acceptedAt
    latestResolutionStatus
    customerNickname
    customerCompanyName
    acceptanceViewStatus
    acceptedEngineerNickname
    closureStatus
    closedAt
    closureReason
    handlingResult
    handlingStatus
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
      file { fileId originalFilename mimeType byteSize checksumSha256 }
    }
    maintenance {
      maintenanceDate
      engineerName
      resetResult
      supplementaryNote
      versionNo
      attachment { fileId originalFilename mimeType byteSize checksumSha256 }
    }
    maintenanceSteps { id stepNo errorCode partName actionText resultCode }
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
      customerFile { fileId originalFilename mimeType byteSize checksumSha256 }
      analysis { status generation outputText failureReason finishedAt }
    }
    canEditMaintenance
    responses {
      id
      engineerNickname
      resolutionStatus
      responseText
      createdAt
    }
  }
`;

const ENGINEER_REPAIR_REQUEST_DETAIL_QUERY = `
  query EngineerRepairRequest($id: Int!) {
    engineerRepairRequest(id: $id) {
      ...EngineerRepairRequestDetailFields
    }
  }
  ${ENGINEER_REPAIR_REQUEST_DETAIL_FIELDS}
`;

const ENGINEER_REPAIR_REVISION_SNAPSHOT_FIELDS = `
  maintenanceDate
  engineerName
  resetResult
  supplementaryNote
  steps {
    id
    stepNo
    errorCode
    partName
    actionText
    resultCode
  }
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
`;

const ENGINEER_REPAIR_REVISION_HISTORY_QUERY = `
  query EngineerRepairRequestRevisionHistory($requestId: Int!) {
    engineerRepairRequestRevisionHistory(requestId: $requestId) {
      revisionNo
      previousVersion
      reason
      actorNickname
      createdAt
      hasComparableSnapshot
      hasVisibleMaintenanceChange
      compareUnavailableReason
    }
  }
`;

const ENGINEER_REPAIR_REVISION_DETAIL_QUERY = `
  query EngineerRepairRequestRevision($requestId: Int!, $revisionNo: Int!) {
    engineerRepairRequestRevision(requestId: $requestId, revisionNo: $revisionNo) {
      requestId
      revisionNo
      previousVersion
      reason
      actorNickname
      createdAt
      hasComparableSnapshot
      hasVisibleMaintenanceChange
      compareUnavailableReason
      before {
        ...EngineerRepairRevisionSnapshotFields
      }
      after {
        ...EngineerRepairRevisionSnapshotFields
      }
    }
  }
  fragment EngineerRepairRevisionSnapshotFields on EngineerRepairRevisionSnapshotDTO {
    ${ENGINEER_REPAIR_REVISION_SNAPSHOT_FIELDS}
  }
`;

const ACCEPT_REPAIR_REQUEST_MUTATION = `
  mutation AcceptRepairRequest($id: Int!) {
    acceptRepairRequest(id: $id) {
      ...EngineerRepairRequestDetailFields
    }
  }
  ${ENGINEER_REPAIR_REQUEST_DETAIL_FIELDS}
`;

const SAVE_REPAIR_REQUEST_MAINTENANCE_MUTATION = `
  mutation SaveRepairRequestMaintenance($input: SaveRepairRequestMaintenanceInput!) {
    saveRepairRequestMaintenance(input: $input) {
      maintenanceDate
      engineerName
      resetResult
      supplementaryNote
      versionNo
      attachment { fileId originalFilename mimeType byteSize checksumSha256 }
    }
  }
`;

const CREATE_ENGINEER_RESPONSE_MUTATION = `
  mutation CreateEngineerResponse($input: CreateEngineerResponseInput!) {
    createEngineerResponse(input: $input) {
      id
      engineerNickname
      resolutionStatus
      responseText
      createdAt
    }
  }
`;

const CREATE_REPAIR_PROCESS_ENTRY_MUTATION = `
  mutation CreateRepairProcessEntry($input: CreateRepairProcessEntryInput!) {
    createRepairProcessEntry(input: $input) {
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
    }
  }
`;

const UPDATE_REPAIR_PROCESS_ENTRY_MUTATION = `
  mutation UpdateRepairProcessEntry($input: UpdateRepairProcessEntryInput!) {
    updateRepairProcessEntry(input: $input) {
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
    }
  }
`;

const CLOSE_REPAIR_REQUEST_MUTATION = `
  mutation CloseRepairRequest($input: CloseRepairRequestInput!) {
    closeRepairRequest(input: $input) {
      requestId
      closureStatus
      closedAt
      closureReason
      handlingResult
      handlingStatus
      handlingEndedAt
    }
  }
`;

const INTERRUPT_REPAIR_REQUEST_MUTATION = `
  mutation InterruptRepairRequest($input: InterruptRepairRequestInput!) {
    interruptRepairRequest(input: $input) {
      requestId
      closureStatus
      closedAt
      closureReason
      handlingResult
      handlingStatus
      handlingEndedAt
    }
  }
`;

function storedFileDownloadEndpoint(fileId: string): string {
  return `/api/stored-files/${encodeURIComponent(fileId)}/download`;
}

/* -------------------------- 业务拒绝映射 -------------------------- */

/**
 * 接单拒绝主映射：仅依赖 extensions.code 大类（契约保证稳定的生产分支信号）。
 * 唯一真源：后端全局 GraphQL Filter 的 mapDomainErrorToGqlCode 与
 * REPAIR_REQUEST_ERROR / PERMISSION_ERROR 码组。
 */
const ACCEPT_FAILURE_REASON_BY_CATEGORY_CODE: Record<string, AcceptRepairRequestFailureReason> = {
  CONFLICT: 'already-accepted',
  NOT_FOUND: 'not-accessible',
  FORBIDDEN: 'insufficient-permission',
  INTERNAL_SERVER_ERROR: 'accept-failed',
  BAD_USER_INPUT: 'accept-failed',
};

/** 可选细化：后端暴露 extensions.errorCode 时（非生产环境）细化接单冲突提示；隐藏时自动回退大类 */
const ACCEPT_REFINED_REASON_BY_ERROR_CODE: Partial<
  Record<string, AcceptRepairRequestFailureReason>
> = {
  REPAIR_REQUEST_ALREADY_ACCEPTED: 'already-accepted',
};

const ACCEPT_FALLBACK_MESSAGE_BY_REASON: Record<AcceptRepairRequestFailureReason, MessageKey> = {
  // 中性文案：最小快照不读接单人，无法区分本人重复接单与他人接单，不向前端引入工程师 ID 来区分；
  // 兜底与后端 DomainError message 同一句且同样不带句号（主展示路径为后端 errorMessage，
  // 两条展示路径的用户可见文案保持一致）
  'already-accepted': 'engineerDetail.acceptError.alreadyAccepted',
  'not-accessible': 'engineerDetail.acceptError.notAccessible',
  'insufficient-permission': 'engineerDetail.acceptError.insufficientPermission',
  'accept-failed': 'engineerDetail.acceptFailed',
};

/**
 * 详情读取拒绝主映射：后端对越权统一拒绝且不泄露存在性，
 * NOT_FOUND / FORBIDDEN 合并为统一不可访问反馈，不区分属于哪位工程师。
 */
const DETAIL_FAILURE_REASON_BY_CATEGORY_CODE: Record<
  string,
  EngineerRepairRequestDetailFailureReason
> = {
  NOT_FOUND: 'not-accessible',
  FORBIDDEN: 'not-accessible',
  INTERNAL_SERVER_ERROR: 'load-failed',
  BAD_USER_INPUT: 'load-failed',
};

/**
 * 统一不可访问文案的唯一真源：后端对越权统一拒绝且不泄露存在性，
 * adapter 兜底文案与详情流程对无效/非法 ID 的静态反馈共用同一词条，不复制第二份。
 */
export const ENGINEER_DETAIL_NOT_ACCESSIBLE_MESSAGE_KEY =
  'engineerDetail.notAccessible' as const satisfies MessageKey;

const DETAIL_FALLBACK_MESSAGE_BY_REASON: Record<
  EngineerRepairRequestDetailFailureReason,
  MessageKey
> = {
  'not-accessible': ENGINEER_DETAIL_NOT_ACCESSIBLE_MESSAGE_KEY,
  'load-failed': 'engineerDetail.loadFailed',
};

/**
 * 回复拒绝主映射：仅依赖 extensions.code 大类（契约保证稳定的生产分支信号）。
 * - CONFLICT：后端 REPAIR_REQUEST_NOT_ACCEPTED（未接单，提示先接单后回复）；
 * - NOT_FOUND：不存在/已删除/已由其他工程师接单，统一不可访问，不泄露归属；
 * - INTERNAL_SERVER_ERROR：REPAIR_REQUEST_RESPONSE_FAILED 落库失败 → 结果不确定；
 * - BAD_USER_INPUT：requestId/正文/状态非法；FORBIDDEN：非精确工程师写身份。
 * 唯一真源：后端全局 GraphQL Filter 的 mapDomainErrorToGqlCode 与
 * REPAIR_REQUEST_ERROR / PERMISSION_ERROR 码组（Plan §7.5）。
 */
const CREATE_RESPONSE_FAILURE_REASON_BY_CATEGORY_CODE: Record<
  string,
  CreateEngineerResponseFailureReason
> = {
  CONFLICT: 'not-accepted',
  NOT_FOUND: 'not-accessible',
  FORBIDDEN: 'insufficient-permission',
  BAD_USER_INPUT: 'invalid-input',
  INTERNAL_SERVER_ERROR: 'response-failed',
};

const CREATE_RESPONSE_FALLBACK_MESSAGE_BY_REASON: Record<
  CreateEngineerResponseFailureReason,
  MessageKey
> = {
  // 以下兜底文案与后端 DomainError message 逐字一致（无句号）：主展示路径为后端
  // errorMessage，两条展示路径的用户可见文案保持一致（接单 already-accepted 先例）
  'not-accepted': 'engineerDetail.replyError.notAccepted',
  'not-accessible': 'engineerDetail.replyError.notAccessible',
  'insufficient-permission': 'engineerDetail.replyError.insufficientPermission',
  'response-failed': 'engineerDetail.replyError.responseFailed',
  // 输入非法的后端 message 逐项不同（ID/正文/状态），兜底用一句中性汇总文案
  'invalid-input': 'engineerDetail.replyError.invalidInput',
};

/* ------------------------------ mapper ------------------------------ */

type EngineerRepairRequestsData = {
  engineerRepairRequests: RepairRequestPaginatedDTO;
};

type EngineerRepairRequestDetailData = {
  engineerRepairRequest: RepairRequestDetailDTO;
};

type EngineerRepairRevisionHistoryData = {
  engineerRepairRequestRevisionHistory: EngineerRepairRevisionHistoryItemDTO[];
};

type EngineerRepairRevisionDetailData = {
  engineerRepairRequestRevision: EngineerRepairRevisionDetailDTO;
};

type AcceptRepairRequestData = {
  acceptRepairRequest: RepairRequestDetailDTO;
};

type CreateEngineerResponseData = {
  createEngineerResponse: EngineerResponseDTO;
};

function mapEquipmentModelDTO(dto: EquipmentModelDTO): EngineerRepairRequestEquipmentModel {
  return { id: dto.id, modelCode: dto.modelCode, modelName: dto.modelName };
}

function mapResponseDTO(dto: EngineerResponseDTO): EngineerRepairRequestResponseItem {
  return {
    id: dto.id,
    engineerNickname: dto.engineerNickname,
    resolutionStatus: dto.resolutionStatus,
    responseText: dto.responseText,
    createdAt: dto.createdAt,
  };
}

function mapListItemDTO(dto: RepairRequestListItemDTO): EngineerRepairRequestListItem {
  return {
    id: dto.id,
    requestNo: dto.requestNo,
    equipmentModel: mapEquipmentModelDTO(dto.equipmentModel),
    errorCode: dto.errorCode,
    createdAt: dto.createdAt,
    isAccepted: dto.isAccepted,
    acceptedAt: dto.acceptedAt ?? null,
    latestResolutionStatus: dto.latestResolutionStatus ?? null,
    // 工程师入口富集字段：昵称/公司可空收拢为 null，视角状态由后端保证非空
    customerNickname: dto.customerNickname,
    customerCompanyName: dto.customerCompanyName ?? null,
    acceptanceViewStatus: dto.acceptanceViewStatus,
    acceptedEngineerNickname: dto.acceptedEngineerNickname ?? null,
    // 结单事实保留「字段缺失（undefined）」与「显式 null」的区别，
    // 供 UI 区分合法未结单与读模型未透传；不得用 ?? null 合并。
    closureStatus: 'closureStatus' in dto ? dto.closureStatus : undefined,
    closedAt: 'closedAt' in dto ? dto.closedAt : undefined,
    handlingResult: dto.handlingResult ?? null,
    handlingStatus: dto.handlingStatus ?? null,
  };
}

function mapDetailDTO(dto: RepairRequestDetailDTO): EngineerRepairRequestDetail {
  return {
    id: dto.id,
    requestNo: dto.requestNo,
    equipmentModel: mapEquipmentModelDTO(dto.equipmentModel),
    errorCode: dto.errorCode,
    faultDescription: dto.faultDescription,
    contentMd: dto.contentMd,
    createdAt: dto.createdAt,
    isAccepted: dto.isAccepted,
    acceptedAt: dto.acceptedAt ?? null,
    latestResolutionStatus: dto.latestResolutionStatus ?? null,
    // 防腐兜底：可空/缺省字段归一，不假设后端字段必达（infrastructure-rules.md）
    responses: (dto.responses ?? []).map(mapResponseDTO),
    // 工程师入口富集字段：缺失时收拢为 null，UI 按只读失败关闭处理
    customerNickname: dto.customerNickname ?? null,
    customerCompanyName: dto.customerCompanyName ?? null,
    acceptanceViewStatus: dto.acceptanceViewStatus ?? null,
    acceptedEngineerNickname: dto.acceptedEngineerNickname ?? null,
    // 同列表项：结单字段保留缺失 vs 显式 null 的区别，不在此合并
    closureStatus: 'closureStatus' in dto ? dto.closureStatus : undefined,
    closedAt: 'closedAt' in dto ? dto.closedAt : undefined,
    closureReason: dto.closureReason ?? null,
    handlingResult: dto.handlingResult ?? null,
    handlingStatus: dto.handlingStatus ?? null,
    processEntries: (dto.processEntries ?? []).map(mapProcessEntryDTO),
    maintenance: dto.maintenance ? mapMaintenanceRecordDTO(dto.maintenance) : null,
    maintenanceSteps: (dto.maintenanceSteps ?? []).map(mapMaintenanceStepDTO),
    maintenanceFaultPanels: (dto.maintenanceFaultPanels ?? []).map(mapMaintenanceFaultPanelDTO),
    intake: dto.intake ? mapIntakeDTO(dto.intake) : null,
    canEditMaintenance: dto.canEditMaintenance ?? false,
  };
}

function mapMaintenanceAttachmentDTO(dto: {
  fileId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
}): EngineerRepairMaintenanceRecord['attachment'] {
  return {
    fileId: dto.fileId,
    originalFilename: dto.originalFilename,
    mimeType: dto.mimeType,
    byteSize: dto.byteSize,
    checksumSha256: dto.checksumSha256,
  };
}

function mapMaintenanceRecordDTO(dto: RepairMaintenanceRecordDTO): EngineerRepairMaintenanceRecord {
  return {
    maintenanceDate: dto.maintenanceDate ?? null,
    engineerName: dto.engineerName ?? null,
    resetResult: dto.resetResult ?? null,
    supplementaryNote: dto.supplementaryNote ?? null,
    versionNo: dto.versionNo ?? 0,
    attachment: dto.attachment ? mapMaintenanceAttachmentDTO(dto.attachment) : null,
  };
}

function mapMaintenanceStepDTO(dto: RepairMaintenanceStepDTO): EngineerRepairMaintenanceStep {
  return {
    id: dto.id,
    stepNo: dto.stepNo,
    errorCode: dto.errorCode ?? null,
    partName: dto.partName ?? null,
    actionText: dto.actionText,
    resultCode: dto.resultCode,
  };
}

function mapMaintenanceFaultPanelDTO(
  dto: RepairMaintenanceFaultPanelDTO,
): EngineerRepairMaintenanceFaultPanel {
  return {
    id: dto.id,
    panelType: dto.panelType,
    stepId: dto.stepId ?? null,
    phaseCode: dto.phaseCode ?? null,
    mainError: dto.mainError ?? null,
    unitError: dto.unitError ?? null,
    source: dto.source ?? null,
    errorType: dto.errorType ?? null,
    gpibStatus: dto.gpibStatus ?? null,
    faultStatus: dto.faultStatus ?? null,
    description: dto.description,
    action: dto.action ?? null,
  };
}

function mapRevisionCompareUnavailableReason(
  value: EngineerRepairRevisionCompareUnavailableReason | null | undefined,
): EngineerRepairRevisionCompareUnavailableReason | null {
  return value ?? null;
}

function mapRevisionSnapshotDTO(
  dto: EngineerRepairRevisionSnapshotDTO | null | undefined,
): EngineerRepairRevisionSnapshot | null {
  if (!dto) {
    return null;
  }
  return {
    maintenanceDate: dto.maintenanceDate ?? null,
    engineerName: dto.engineerName ?? null,
    resetResult: dto.resetResult ?? null,
    supplementaryNote: dto.supplementaryNote ?? null,
    steps: (dto.steps ?? []).map(mapMaintenanceStepDTO),
    panels: (dto.panels ?? []).map(mapMaintenanceFaultPanelDTO),
  };
}

function mapRevisionHistoryItemDTO(
  dto: EngineerRepairRevisionHistoryItemDTO,
): EngineerRepairRevisionHistoryItem {
  return {
    revisionNo: dto.revisionNo,
    previousVersion: dto.previousVersion,
    reason: dto.reason,
    actorNickname: dto.actorNickname,
    createdAt: dto.createdAt,
    hasComparableSnapshot: dto.hasComparableSnapshot,
    hasVisibleMaintenanceChange: dto.hasVisibleMaintenanceChange,
    compareUnavailableReason: mapRevisionCompareUnavailableReason(dto.compareUnavailableReason),
  };
}

function mapRevisionDetailDTO(dto: EngineerRepairRevisionDetailDTO): EngineerRepairRevisionDetail {
  return {
    requestId: dto.requestId,
    revisionNo: dto.revisionNo,
    previousVersion: dto.previousVersion,
    reason: dto.reason,
    actorNickname: dto.actorNickname,
    createdAt: dto.createdAt,
    hasComparableSnapshot: dto.hasComparableSnapshot,
    hasVisibleMaintenanceChange: dto.hasVisibleMaintenanceChange,
    compareUnavailableReason: mapRevisionCompareUnavailableReason(dto.compareUnavailableReason),
    before: mapRevisionSnapshotDTO(dto.before),
    after: mapRevisionSnapshotDTO(dto.after),
  };
}

function mapIntakeAnalysisDTO(
  dto: NonNullable<RepairIntakeSourceDTO['analysis']>,
): EngineerRepairIntakeAnalysis {
  return {
    status: dto.status,
    generation: dto.generation ?? 0,
    outputText: dto.outputText ?? null,
    failureReason: dto.failureReason ?? null,
    finishedAt: dto.finishedAt ?? null,
  };
}

function mapIntakeDTO(dto: RepairIntakeSourceDTO): EngineerRepairIntake {
  return {
    intakeId: dto.intakeId,
    faultDescription: dto.faultDescription ?? null,
    customerFile: dto.customerFile ? mapMaintenanceAttachmentDTO(dto.customerFile) : null,
    analysis: dto.analysis ? mapIntakeAnalysisDTO(dto.analysis) : null,
  };
}

function mapProcessEntryDTO(dto: RepairProcessEntryDTO): EngineerRepairProcessEntry {
  return {
    id: dto.id,
    entryUuid: dto.entryUuid,
    requestId: dto.requestId,
    operationText: dto.operationText,
    testResult: dto.testResult ?? null,
    occurredAt: dto.occurredAt ?? null,
    timeSource: dto.timeSource,
    fileId: dto.fileId ?? null,
    file: dto.file
      ? {
          fileId: dto.file.fileId,
          originalFilename: dto.file.originalFilename,
          mimeType: dto.file.mimeType,
          byteSize: dto.file.byteSize,
          checksumSha256: dto.file.checksumSha256,
        }
      : null,
    versionNo: dto.versionNo,
    createdAt: dto.createdAt,
  };
}

/* ------------------------------ 查询 ------------------------------ */

/**
 * 构造 GraphQL filter 变量：两项都未筛选时整体缺省，
 * 部分筛选时只携带非空键（不向下游传显式 null 键位）
 */
function toFilterVariables(filter: EngineerRepairListFilter): {
  equipmentModelId?: number;
  customerNickname?: string;
} {
  const variables: { equipmentModelId?: number; customerNickname?: string } = {};

  if (filter.equipmentModelId !== null) {
    variables.equipmentModelId = filter.equipmentModelId;
  }
  if (filter.customerNickname !== null) {
    variables.customerNickname = filter.customerNickname;
  }

  return variables;
}

/**
 * 查询工程师维修申请列表（scope 四态 + 可选设备型号/客户昵称筛选，后端分页前过滤）。
 * transport / auth 失败上抛 GraphQLIngressError，由 application 转用户提示或交全局链路。
 */
export async function fetchEngineerRepairRequests(
  query: EngineerRepairListQuery,
): Promise<EngineerRepairRequestPage> {
  const pagination: RepairRequestPaginationVariables = {
    mode: 'OFFSET',
    page: query.page,
    pageSize: query.pageSize,
    withTotal: true,
  };
  const filterVariables = toFilterVariables(query.filter);
  const data = await executeGraphQL<
    EngineerRepairRequestsData,
    {
      scope: string;
      pagination: RepairRequestPaginationVariables;
      filter?: { equipmentModelId?: number; customerNickname?: string };
    }
  >(ENGINEER_REPAIR_REQUESTS_QUERY, {
    scope: query.scope,
    pagination,
    filter: Object.keys(filterVariables).length > 0 ? filterVariables : undefined,
  });
  const page = data.engineerRepairRequests;

  // 防腐兜底：分页字段缺省时回落查询参数，不向 application 泄出 undefined
  return {
    items: (page.items ?? []).map(mapListItemDTO),
    total: page.total ?? 0,
    page: page.page ?? query.page,
    pageSize: page.pageSize ?? query.pageSize,
  };
}

/**
 * 查询工程师维修申请详情。
 *
 * - 业务拒绝（不存在/已删除/越权/系统失败）返回显式失败结果，供详情页统一展示；
 * - transport / auth 类失败按共享错误模型上抛，由调用方决定展示与跳转。
 */
export async function fetchEngineerRepairRequestDetail(
  id: number,
): Promise<EngineerRepairRequestDetailResult> {
  try {
    const data = await executeGraphQL<EngineerRepairRequestDetailData, { id: number }>(
      ENGINEER_REPAIR_REQUEST_DETAIL_QUERY,
      { id },
    );

    return { ok: true, detail: mapDetailDTO(data.engineerRepairRequest) };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const categoryReason = detail?.code
      ? DETAIL_FAILURE_REASON_BY_CATEGORY_CODE[detail.code]
      : undefined;

    if (!detail || !categoryReason) {
      throw error;
    }

    return {
      ok: false,
      reason: categoryReason,
      message:
        detail.errorMessage ?? translateNow(DETAIL_FALLBACK_MESSAGE_BY_REASON[categoryReason]),
    };
  }
}

/**
 * 工程师侧修订历史（只读）。
 *
 * 历史查询失败单独返回显式失败结果，不影响工单详情与当前维修记录展示；
 * transport / auth 类失败仍按共享错误模型上抛。
 */
export async function fetchEngineerRepairRequestRevisionHistory(
  requestId: number,
): Promise<EngineerRepairRevisionHistoryResult> {
  try {
    const data = await executeGraphQL<EngineerRepairRevisionHistoryData, { requestId: number }>(
      ENGINEER_REPAIR_REVISION_HISTORY_QUERY,
      { requestId },
    );
    return {
      ok: true,
      items: (data.engineerRepairRequestRevisionHistory ?? []).map(mapRevisionHistoryItemDTO),
    };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    if (!detail) {
      throw error;
    }
    return {
      ok: false,
      message: detail.errorMessage ?? translateNow('engineerRepairHistory.loadFailed'),
    };
  }
}

/**
 * 工程师侧单个修订详情（查看版本 / 对比上一版）。
 */
export async function fetchEngineerRepairRequestRevisionDetail(
  requestId: number,
  revisionNo: number,
): Promise<EngineerRepairRevisionDetailResult> {
  try {
    const data = await executeGraphQL<
      EngineerRepairRevisionDetailData,
      { requestId: number; revisionNo: number }
    >(ENGINEER_REPAIR_REVISION_DETAIL_QUERY, { requestId, revisionNo });
    return { ok: true, detail: mapRevisionDetailDTO(data.engineerRepairRequestRevision) };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    if (!detail) {
      throw error;
    }
    return {
      ok: false,
      message: detail.errorMessage ?? translateNow('engineerRepairHistory.detailFailed'),
    };
  }
}

/* ------------------------------ 接单 ------------------------------ */

/**
 * 工程师接单（后端原子条件更新，竞争时仅一方成功）。
 *
 * - 入参只有维修申请 ID；接单工程师与接单时间取自后端 Session/系统时间，前端不可传入；
 * - 业务拒绝返回显式失败结果：大类 CONFLICT 是稳定运行时分支（申请已被接单），
 *   REPAIR_REQUEST_ALREADY_ACCEPTED 细节码仅用于可选细化，生产隐藏时自动回退；
 * - transport / auth 类失败按共享错误模型上抛。
 */
export async function acceptRepairRequest(id: number): Promise<AcceptRepairRequestResult> {
  try {
    const data = await executeGraphQL<AcceptRepairRequestData, { id: number }>(
      ACCEPT_REPAIR_REQUEST_MUTATION,
      { id },
    );

    return { ok: true, detail: mapDetailDTO(data.acceptRepairRequest) };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const categoryReason = detail?.code
      ? ACCEPT_FAILURE_REASON_BY_CATEGORY_CODE[detail.code]
      : undefined;

    if (!detail || !categoryReason) {
      throw error;
    }

    const reason =
      (detail.errorCode ? ACCEPT_REFINED_REASON_BY_ERROR_CODE[detail.errorCode] : undefined) ??
      categoryReason;

    return {
      ok: false,
      reason,
      message: detail.errorMessage ?? translateNow(ACCEPT_FALLBACK_MESSAGE_BY_REASON[reason]),
    };
  }
}

/* ------------------------------ 回复 ------------------------------ */

/**
 * 工程师追加处理回复（后端只追加写入，事务内裁决回复资格）。
 *
 * - 入参只有 requestId/responseText/resolutionStatus；接单工程师与客户归属
 *   由后端 Session 派生，前端不可传入（Plan §7.1/§7.2）；
 * - 成功复用既有 mapResponseDTO 单一映射口径，不建第二套回复 mapper；
 * - 业务拒绝返回显式失败结果：生产分支只依赖 extensions.code 大类，
 *   extensions.errorCode 不参与运行时分支（Plan §7.5；本链路 CONFLICT 大类
 *   在回复上下文唯一对应未接单，无需细节码细化）；
 * - response-failed（落库失败）与 transport/auth 类失败都意味着结果不确定：
 *   前者由编排层重查确认，后者按共享错误模型上抛后同样只重查，均不自动重发。
 */
export async function createEngineerResponse(
  input: CreateEngineerResponseInput,
): Promise<CreateEngineerResponseResult> {
  try {
    const data = await executeGraphQL<
      CreateEngineerResponseData,
      { input: CreateEngineerResponseInput }
    >(CREATE_ENGINEER_RESPONSE_MUTATION, { input });

    return { ok: true, response: mapResponseDTO(data.createEngineerResponse) };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const reason = detail?.code
      ? CREATE_RESPONSE_FAILURE_REASON_BY_CATEGORY_CODE[detail.code]
      : undefined;

    if (!detail || !reason) {
      throw error;
    }

    return {
      ok: false,
      reason,
      message:
        detail.errorMessage ?? translateNow(CREATE_RESPONSE_FALLBACK_MESSAGE_BY_REASON[reason]),
    };
  }
}

/* ------------------------ 内部维修过程 / 结单 ------------------------ */

/**
 * 过程写入业务拒绝主映射：CONFLICT 同时覆盖「版本冲突」与「已结单只读」，
 * 生产分支不依赖可能隐藏的 errorCode，统一提示刷新；
 * errorCode 可见时仅用于细化文案，不改变 reason 大类。
 */
const PROCESS_WRITE_FAILURE_REASON_BY_CATEGORY_CODE: Record<
  string,
  RepairProcessWriteFailureReason
> = {
  CONFLICT: 'conflict',
  NOT_FOUND: 'not-accessible',
  FORBIDDEN: 'insufficient-permission',
  BAD_USER_INPUT: 'invalid-input',
  INTERNAL_SERVER_ERROR: 'write-failed',
};

const PROCESS_WRITE_FALLBACK_MESSAGE_BY_REASON: Record<RepairProcessWriteFailureReason, string> = {
  'not-accessible': '维修申请不存在或无权操作',
  conflict: '维修过程已被修改或工单已结单，请刷新后重试',
  'insufficient-permission': '当前账号无权记录维修过程',
  'invalid-input': '维修过程内容无效，请检查后重试',
  'write-failed': '维修过程保存失败，请稍后重试',
};

const CLOSE_FAILURE_REASON_BY_CATEGORY_CODE: Record<string, CloseRepairRequestFailureReason> = {
  CONFLICT: 'closed',
  NOT_FOUND: 'not-accessible',
  FORBIDDEN: 'insufficient-permission',
  BAD_USER_INPUT: 'invalid-input',
  INTERNAL_SERVER_ERROR: 'close-failed',
};

const CLOSE_FALLBACK_MESSAGE_BY_REASON: Record<CloseRepairRequestFailureReason, string> = {
  'not-accessible': '维修申请不存在或无权操作',
  closed: '工单已结单，请刷新后查看最新状态',
  'insufficient-permission': '当前账号无权结单',
  'invalid-input': '结单信息无效，请检查后重试',
  'close-failed': '结单失败，请稍后重试',
};

type CreateRepairProcessEntryData = { createRepairProcessEntry: RepairProcessEntryDTO };
type UpdateRepairProcessEntryData = { updateRepairProcessEntry: RepairProcessEntryDTO };
type CloseRepairRequestData = { closeRepairRequest: RepairRequestClosure };
type InterruptRepairRequestData = { interruptRepairRequest: RepairRequestInterruption };

function toProcessMutationInput(
  input: CreateRepairProcessEntryInput | UpdateRepairProcessEntryInput,
) {
  return {
    requestId: input.requestId,
    operationText: input.operationText,
    testResult: input.testResult,
    occurredAt: input.occurredAt,
    ...('file' in input && input.file
      ? { file: { fileId: input.file.fileId, uploadContextId: input.file.uploadContextId } }
      : {}),
    ...('entryId' in input
      ? { entryId: input.entryId, expectedVersion: input.expectedVersion }
      : {}),
  };
}

/** 创建内部维修过程；携带暂存原件时后端与过程写入同一事务绑定 */
export async function createRepairProcessEntry(
  input: CreateRepairProcessEntryInput,
): Promise<RepairProcessWriteResult> {
  try {
    const data = await executeGraphQL<
      CreateRepairProcessEntryData,
      { input: ReturnType<typeof toProcessMutationInput> }
    >(CREATE_REPAIR_PROCESS_ENTRY_MUTATION, { input: toProcessMutationInput(input) });

    return { ok: true, entry: mapProcessEntryDTO(data.createRepairProcessEntry) };
  } catch (error) {
    return mapProcessWriteFailure(error);
  }
}

/** 编辑内部维修过程（expectedVersion 不符返回 conflict，不自动重试） */
export async function updateRepairProcessEntry(
  input: UpdateRepairProcessEntryInput,
): Promise<RepairProcessWriteResult> {
  try {
    const data = await executeGraphQL<
      UpdateRepairProcessEntryData,
      { input: ReturnType<typeof toProcessMutationInput> }
    >(UPDATE_REPAIR_PROCESS_ENTRY_MUTATION, { input: toProcessMutationInput(input) });

    return { ok: true, entry: mapProcessEntryDTO(data.updateRepairProcessEntry) };
  } catch (error) {
    return mapProcessWriteFailure(error);
  }
}

function mapProcessWriteFailure(error: unknown): RepairProcessWriteResult {
  const detail = readGraphQLErrorDetail(error);
  const reason = detail?.code
    ? PROCESS_WRITE_FAILURE_REASON_BY_CATEGORY_CODE[detail.code]
    : undefined;

  if (!detail || !reason) {
    throw error;
  }

  return {
    ok: false,
    reason,
    message: detail.errorMessage ?? PROCESS_WRITE_FALLBACK_MESSAGE_BY_REASON[reason],
  };
}

const MAINTENANCE_WRITE_FALLBACK_MESSAGE_BY_REASON: Record<
  RepairProcessWriteFailureReason,
  MessageKey
> = {
  'not-accessible': 'maintenance.error.notAccessible',
  conflict: 'maintenance.error.conflict',
  'insufficient-permission': 'maintenance.error.insufficientPermission',
  'invalid-input': 'maintenance.error.invalidInput',
  'write-failed': 'maintenance.error.writeFailed',
};

type SaveRepairRequestMaintenanceData = {
  saveRepairRequestMaintenance: RepairMaintenanceRecordDTO;
};

/**
 * 保存结构化内部维修记录（任务 04）。
 *
 * - expectedVersion 由调用方取当前详情 maintenance.versionNo ?? 0；
 * - attachment 与记录写入同一事务绑定，仅在尚未绑定原件时提交；
 * - CONFLICT 同时覆盖版本冲突与结单只读，统一提示刷新，不自动重试；
 * - 成功返回最新记录，调用方仍需回读详情以同步步骤/面板。
 */
export async function saveRepairRequestMaintenance(
  input: SaveRepairRequestMaintenanceInput,
): Promise<RepairMaintenanceWriteResult> {
  try {
    const data = await executeGraphQL<
      SaveRepairRequestMaintenanceData,
      { input: SaveRepairRequestMaintenanceInput }
    >(SAVE_REPAIR_REQUEST_MAINTENANCE_MUTATION, { input });

    return { ok: true, record: mapMaintenanceRecordDTO(data.saveRepairRequestMaintenance) };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const reason = detail?.code
      ? PROCESS_WRITE_FAILURE_REASON_BY_CATEGORY_CODE[detail.code]
      : undefined;

    if (!detail || !reason) {
      throw error;
    }

    return {
      ok: false,
      reason,
      message:
        detail.errorMessage ?? translateNow(MAINTENANCE_WRITE_FALLBACK_MESSAGE_BY_REASON[reason]),
    };
  }
}

/** 工程师结单（与回复互相独立；成功后详情中过程与回复转为只读） */
export async function closeRepairRequest(
  input: CloseRepairRequestInput,
): Promise<CloseRepairRequestResult> {
  try {
    const data = await executeGraphQL<CloseRepairRequestData, { input: CloseRepairRequestInput }>(
      CLOSE_REPAIR_REQUEST_MUTATION,
      { input },
    );

    return { ok: true, closure: data.closeRepairRequest };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const reason = detail?.code ? CLOSE_FAILURE_REASON_BY_CATEGORY_CODE[detail.code] : undefined;

    if (!detail || !reason) {
      throw error;
    }

    return {
      ok: false,
      reason,
      message: detail.errorMessage ?? CLOSE_FALLBACK_MESSAGE_BY_REASON[reason],
    };
  }
}

/** 工程师记录维修中断（不结单；成功后仍可继续保存与回复） */
export async function interruptRepairRequest(
  input: InterruptRepairRequestInput,
): Promise<InterruptRepairRequestResult> {
  try {
    const data = await executeGraphQL<
      InterruptRepairRequestData,
      { input: InterruptRepairRequestInput }
    >(INTERRUPT_REPAIR_REQUEST_MUTATION, { input });

    return { ok: true, interruption: data.interruptRepairRequest };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);
    const reason = detail?.code ? CLOSE_FAILURE_REASON_BY_CATEGORY_CODE[detail.code] : undefined;

    if (!detail || !reason) {
      throw error;
    }

    return {
      ok: false,
      reason,
      message: detail.errorMessage ?? CLOSE_FALLBACK_MESSAGE_BY_REASON[reason],
    };
  }
}

/* ---------------------------- 原件 REST ---------------------------- */

const UPLOAD_FAILURE_REASON_BY_CODE: Record<string, UploadRepairProcessFileFailureReason> = {
  STORED_FILE_UPLOAD_FILE_TOO_LARGE: 'file-too-large',
  STORED_FILE_UPLOAD_FILE_TYPE_NOT_ALLOWED: 'file-type-not-allowed',
  STORED_FILE_INVALID_PARAMS: 'invalid-input',
  STORED_FILE_PURPOSE_NOT_SUPPORTED: 'invalid-input',
  STORED_FILE_UPLOAD_FILE_MISSING: 'invalid-input',
  FORBIDDEN: 'insufficient-permission',
};

const UPLOAD_FALLBACK_MESSAGE_BY_REASON: Record<UploadRepairProcessFileFailureReason, string> = {
  'invalid-input': '上传内容不符合要求，请检查后重试',
  'file-too-large': '原件超过大小限制',
  'file-type-not-allowed': '不允许上传该类型的原件',
  'insufficient-permission': '当前账号无权上传维修过程原件',
  'upload-failed': '原件上传失败，请检查网络后重试',
};

const DOWNLOAD_FAILURE_REASON_BY_CODE: Record<
  string,
  Extract<DownloadRepairProcessFileResult, { ok: false }>['reason']
> = {
  STORED_FILE_NOT_FOUND: 'not-found',
  STORED_FILE_FILE_NOT_AVAILABLE: 'file-not-available',
  FORBIDDEN: 'insufficient-permission',
};

const DOWNLOAD_FALLBACK_MESSAGE_BY_REASON: Record<
  Extract<DownloadRepairProcessFileResult, { ok: false }>['reason'],
  string
> = {
  'not-found': '原件不存在或无权下载',
  'file-not-available': '原件暂不可下载',
  'insufficient-permission': '当前账号无原件下载权限',
  'download-failed': '原件下载失败，请稍后重试',
};

/**
 * 上传维修过程原件（REST，暂存态）。
 * 只允许 REPAIR_PROCESS 用途；成功返回正式 uploadContextId 与校验元数据。
 * REST 装配与响应解析复用 feature 内共用的 stored-file-upload，避免与客户报修原件重复实现。
 */
export async function uploadRepairProcessFile(file: File): Promise<UploadRepairProcessFileResult> {
  const outcome = await uploadStagedStoredFile(file, 'REPAIR_PROCESS');

  if (outcome.status === 'uploaded') {
    return { ok: true, file: outcome.file };
  }

  if (outcome.status === 'network') {
    return { ok: false, reason: 'upload-failed', message: '原件上传失败，请检查网络后重试' };
  }

  if (outcome.status === 'malformed') {
    return { ok: false, reason: 'upload-failed', message: '原件上传失败，请稍后重试' };
  }

  const reason = outcome.code ? UPLOAD_FAILURE_REASON_BY_CODE[outcome.code] : undefined;

  if (reason) {
    return {
      ok: false,
      reason,
      message: outcome.message ?? UPLOAD_FALLBACK_MESSAGE_BY_REASON[reason],
    };
  }

  return {
    ok: false,
    reason: 'upload-failed',
    message: outcome.message ?? '原件上传失败，请稍后重试',
  };
}

/** 下载已绑定原件（REST 授权下载；客户与无权账号不可借 ID 读取） */
export async function downloadRepairProcessFile(
  fileId: string,
): Promise<DownloadRepairProcessFileResult> {
  let response: Response;
  try {
    response = await fetchRestWithAuthRetry(storedFileDownloadEndpoint(fileId), {});
  } catch {
    return { ok: false, reason: 'download-failed', message: '原件下载失败，请检查网络后重试' };
  }

  if (response.ok) {
    let blob: Blob;
    try {
      blob = await response.blob();
    } catch {
      return { ok: false, reason: 'download-failed', message: '原件下载失败，请稍后重试' };
    }

    const filename =
      parseAttachmentFilename(response.headers.get('Content-Disposition')) ??
      `repair-process-${fileId}`;

    return { ok: true, blob, filename };
  }

  let envelope: RestErrorEnvelope = {};
  try {
    envelope = toRestErrorEnvelope(await response.json());
  } catch {
    // 非 JSON 错误体，走兜底
  }

  const code = readRestErrorField(envelope, 'code');
  const message = readRestErrorField(envelope, 'message');
  const reason = code ? DOWNLOAD_FAILURE_REASON_BY_CODE[code] : undefined;

  if (reason) {
    return { ok: false, reason, message: message ?? DOWNLOAD_FALLBACK_MESSAGE_BY_REASON[reason] };
  }

  return { ok: false, reason: 'download-failed', message: message ?? '原件下载失败，请稍后重试' };
}
