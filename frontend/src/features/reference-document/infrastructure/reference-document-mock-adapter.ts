// src/features/reference-document/infrastructure/reference-document-mock-adapter.ts

import type {
  DeleteReferenceDocumentResult,
  ReferenceDocumentCaseDetail,
  ReferenceDocumentCaseHandlingStatus,
  ReferenceDocumentDetailResult,
  ReferenceDocumentEquipmentModelOption,
  ReferenceDocumentFileDownloadResult,
  ReferenceDocumentListFilter,
  ReferenceDocumentListPage,
  ReferenceDocumentListPagination,
  ReferenceDocumentManagedMutationResult,
  ReviseReferenceDocumentPatch,
  UpdateReferenceDocumentCasePatch,
  UpdateReferenceDocumentCaseResult,
} from './reference-document.types';
import { REFERENCE_DOCUMENT_TITLE_MAX_LENGTH } from './reference-document.types';
import type { MockReferenceDocumentRecord } from './reference-document-mock-data';
import {
  buildMockReferenceDocumentRecords,
  MOCK_REFERENCE_EQUIPMENT_MODELS,
} from './reference-document-mock-data';

/**
 * Mock 数据访问层：签名与真实 adapter 完全一致，页面经 barrel 消费统一导出名。
 *
 * 任务 07 确认需求收口：旧普通新增（纯文本 / REST multipart）与通用编辑已随服务端
 * 写入口一并关闭，Mock 同步移除对应模拟；管理动作按新规则拆分并对齐后端口径：
 * - 管理修订（R058）：仅修订标题/说明/正文，FAULT_CASE 正文拒绝（须走案例更正）；
 * - 下架（R059）：OFFLINE 后列表/详情统一不可见（防探测口径），保留修订历史；
 * - 管理删除（R060）：软删 + 版本推进，与下架分别确认；
 * - 归属更正（R061-02）：Mock 无组织事实，仅做输入与版本校验；
 * - 原作者删除（R053）：expected_version 过期归并 version-conflict。
 * 所有管理操作共享 expected_version（Mock 从 1 起计数），过期一律 version-conflict。
 */

/** 案例处理状态中文标签（与后端可读正文格式化真源同口径） */
const FAULT_CASE_HANDLING_STATUS_LABELS: Record<ReferenceDocumentCaseHandlingStatus, string> = {
  UNRESOLVED: '未解决',
  IN_PROGRESS: '处理中',
  RESOLVED: '已解决',
};

/** FAULT_CASE 保留类型判定（大小写不敏感，与后端 utf8mb4_0900_ai_ci 口径一致） */
function isFaultCaseDocumentType(documentType: string): boolean {
  return documentType.trim().toUpperCase() === 'FAULT_CASE';
}

let repository: MockReferenceDocumentRecord[] = buildMockReferenceDocumentRecords();
/** 生效版本计数（对齐后端 current_revision_no：种子资料从 1 起） */
let revisionCounters: Map<number, number> = new Map();
/** Mock 下架集合（OFFLINE 后列表/详情统一不可见，对齐后端防探测口径） */
let offlineIds: Set<number> = new Set();

/** 测试隔离：重建数据源（种子 + 批量数据），并重置自增主键与版本/下架状态 */
export function resetReferenceDocumentMockState(): void {
  repository = buildMockReferenceDocumentRecords();
  revisionCounters = new Map();
  offlineIds = new Set();
}

function currentRevisionNo(id: number): number {
  return revisionCounters.get(id) ?? 1;
}

function isNormalizedBlank(value: string | null | undefined): boolean {
  return value === undefined || value === null || value.trim().length === 0;
}

/**
 * 正式案例可读正文生成（对齐后端 formatFaultCaseReferenceContent 的组装口径）：
 * 现象 / 复现步骤 / 处理状态必出现，可选字段非空时列入，明细为唯一真源。
 */
function formatFaultCaseContentText(detail: ReferenceDocumentCaseDetail): string {
  const blocks: string[] = [];

  if (detail.errorCode !== null) {
    blocks.push(`错误码：${detail.errorCode}`);
  }

  blocks.push(`故障现象：\n${detail.phenomenon}`);

  if (detail.conditionText !== null) {
    blocks.push(`触发条件：\n${detail.conditionText}`);
  }

  blocks.push(`复现步骤：\n${detail.reproductionSteps}`);

  if (detail.diagnosis !== null) {
    blocks.push(`排查过程：\n${detail.diagnosis}`);
  }

  if (detail.actionTaken !== null) {
    blocks.push(`处理措施：\n${detail.actionTaken}`);
  }

  blocks.push(`处理状态：${FAULT_CASE_HANDLING_STATUS_LABELS[detail.handlingStatus]}`);

  if (detail.resolution !== null) {
    blocks.push(`处理结果：\n${detail.resolution}`);
  }

  return blocks.join('\n\n');
}

function findRecordById(id: number): MockReferenceDocumentRecord | undefined {
  return repository.find((item) => item.id === id);
}

function isAccessible(record: MockReferenceDocumentRecord): boolean {
  return !record.deprecated && !offlineIds.has(record.id);
}

/** 列表项视图：剔除文本内容与数据源内部标志，保持与后端 ListItem DTO 同形 */
function toListItem(record: MockReferenceDocumentRecord) {
  return {
    id: record.id,
    title: record.title,
    documentType: record.documentType,
    equipmentModelId: record.equipmentModelId,
    equipmentModelName: record.equipmentModelName,
    equipmentModelText: record.equipmentModelText,
    description: record.description,
    originalFilename: record.originalFilename,
    organizationName: record.organizationName,
    ingestMethod: record.ingestMethod,
    // Mock 数据源只承载普通资料（任务 07 的报告来源数据来自后端真实快照）
    sourceKind: 'MATERIAL' as const,
    effectiveRevisionNo: currentRevisionNo(record.id),
    caseHandlingStatus: record.caseHandlingStatus,
    creatorNickname: record.creatorNickname,
    createdAt: record.createdAt,
  };
}

/** 详情视图：显式映射剔除数据源内部标志，保持与后端 Detail DTO 同形（不含 caseHandlingStatus） */
function toDetail(record: MockReferenceDocumentRecord) {
  return {
    id: record.id,
    title: record.title,
    documentType: record.documentType,
    equipmentModelId: record.equipmentModelId,
    equipmentModelName: record.equipmentModelName,
    equipmentModelText: record.equipmentModelText,
    description: record.description,
    originalFilename: record.originalFilename,
    mimeType: record.mimeType,
    hasFile: record.hasFile,
    contentText: record.contentText,
    contentSource: 'ORIGINAL' as const,
    sourceKind: 'MATERIAL' as const,
    effectiveRevisionNo: currentRevisionNo(record.id),
    sourceReportId: null,
    sourceReportVersionId: null,
    frozenReport: null,
    structuredContent: record.structuredContent,
    // Mock 种子均为普通资料：无来源报告冻结原件（与后端装配语义一致）
    sourceReportAttachment: record.sourceReportAttachment,
    organizationName: record.organizationName,
    ingestMethod: record.ingestMethod,
    caseDetail: record.caseDetail,
    creatorNickname: record.creatorNickname,
    // Mock 视角固定为创建人本人（单管理员语义），供作者删除入口联调
    viewerIsOriginalAuthor: true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function fetchReferenceEquipmentModels(): Promise<
  ReferenceDocumentEquipmentModelOption[]
> {
  return [...MOCK_REFERENCE_EQUIPMENT_MODELS];
}

export async function fetchReferenceDocuments(
  pagination: ReferenceDocumentListPagination,
  filter?: ReferenceDocumentListFilter,
): Promise<ReferenceDocumentListPage> {
  const titleKeyword = filter?.titleKeyword?.trim();
  const documentType = filter?.documentType?.trim();
  const equipmentModelId = filter?.equipmentModelId;
  const caseHandlingStatus = filter?.caseHandlingStatus;

  const visible = repository
    .filter((record) => isAccessible(record))
    .filter((record) => (titleKeyword ? record.title.includes(titleKeyword) : true))
    .filter((record) => (documentType ? record.documentType === documentType : true))
    .filter((record) =>
      equipmentModelId !== undefined ? record.equipmentModelId === equipmentModelId : true,
    )
    .filter((record) =>
      caseHandlingStatus !== undefined ? record.caseHandlingStatus === caseHandlingStatus : true,
    )
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }

      return b.id - a.id;
    });

  const page = Math.max(1, pagination.page);
  const pageSize = Math.max(1, pagination.pageSize);
  const start = (page - 1) * pageSize;

  return {
    items: visible.slice(start, start + pageSize).map(toListItem),
    total: visible.length,
    page,
    pageSize,
  };
}

export async function fetchReferenceDocument(id: number): Promise<ReferenceDocumentDetailResult> {
  const record = findRecordById(id);

  if (!record || !isAccessible(record)) {
    // 后端统一 NOT_FOUND（防探测）：不存在 / 已下架 / 已软删同文案，不区分原因
    return {
      ok: false,
      reason: 'not-found',
      message: '历史维修记录不存在或不可查看。',
    };
  }

  return { ok: true, detail: toDetail(record) };
}

/** 管理操作公共前置：版本核对（expected_version 过期拒绝，对齐后端 CONFLICT） */
function checkExpectedVersion(id: number, expectedVersion: number): boolean {
  return currentRevisionNo(id) === expectedVersion;
}

/** 管理操作公共收尾：推进生效版本 */
function bumpRevision(id: number, record: MockReferenceDocumentRecord): number {
  const next = currentRevisionNo(id) + 1;
  revisionCounters.set(id, next);
  record.updatedAt = new Date().toISOString();
  return next;
}

/** 管理修订正式资料（任务 07 R058，Mock 对齐后端口径） */
export async function reviseReferenceDocument(
  id: number,
  expectedVersion: number,
  patch: ReviseReferenceDocumentPatch,
  reason: string,
): Promise<ReferenceDocumentManagedMutationResult> {
  if (reason.trim().length === 0 || reason.trim().length > 500) {
    return { ok: false, reason: 'invalid-input', message: '操作原因必填且不超过 500 字。' };
  }

  const hasPatchField =
    patch.title !== undefined || patch.description !== undefined || patch.contentText !== undefined;

  if (!hasPatchField) {
    return { ok: false, reason: 'invalid-input', message: '管理修订至少需要一个可编辑字段。' };
  }

  const record = findRecordById(id);

  if (!record || !isAccessible(record)) {
    return { ok: false, reason: 'not-found', message: '历史维修记录不存在或不可访问。' };
  }

  if (!checkExpectedVersion(id, expectedVersion)) {
    return {
      ok: false,
      reason: 'version-conflict',
      message: '资料版本已更新，请重新读取当前版本后重试。',
    };
  }

  // 案例保护（对齐后端）：FAULT_CASE 正文与案例明细强耦合，必须走案例更正接口
  if (isFaultCaseDocumentType(record.documentType) && patch.contentText !== undefined) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '案例资料正文不可通过管理修订修改，请使用案例更正接口。',
    };
  }

  // 双空防御：正文清空仅允许已有文件（hasFile）的资料
  if (patch.contentText !== undefined && isNormalizedBlank(patch.contentText) && !record.hasFile) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '文本内容与文件至少需要一个。',
    };
  }

  if (patch.title !== undefined) {
    const title = patch.title.trim();

    if (title.length === 0 || title.length > REFERENCE_DOCUMENT_TITLE_MAX_LENGTH) {
      return { ok: false, reason: 'invalid-input', message: '标题不允许置空或超长。' };
    }

    record.title = title;
  }

  if (patch.description !== undefined) {
    record.description = isNormalizedBlank(patch.description)
      ? null
      : (patch.description as string).trim();
  }

  if (patch.contentText !== undefined) {
    record.contentText = isNormalizedBlank(patch.contentText)
      ? null
      : (patch.contentText as string).trim();
  }

  const revisionNo = bumpRevision(id, record);

  return { ok: true, id, revisionNo };
}

/** 下架正式资料（任务 07 R059，Mock 对齐后端口径：OFFLINE 后统一不可见） */
export async function offlineReferenceDocument(
  id: number,
  expectedVersion: number,
  reason: string,
): Promise<ReferenceDocumentManagedMutationResult> {
  if (reason.trim().length === 0 || reason.trim().length > 500) {
    return { ok: false, reason: 'invalid-input', message: '操作原因必填且不超过 500 字。' };
  }

  const record = findRecordById(id);

  if (!record || !isAccessible(record)) {
    return { ok: false, reason: 'not-found', message: '历史维修记录不存在或不可访问。' };
  }

  if (!checkExpectedVersion(id, expectedVersion)) {
    return {
      ok: false,
      reason: 'version-conflict',
      message: '资料版本已更新，请重新读取当前版本后重试。',
    };
  }

  offlineIds.add(id);
  const revisionNo = bumpRevision(id, record);

  return { ok: true, id, revisionNo };
}

/** 管理删除正式资料（任务 07 R060，Mock 对齐后端口径：软删 + 版本推进） */
export async function adminDeleteReferenceDocument(
  id: number,
  expectedVersion: number,
  reason: string,
): Promise<ReferenceDocumentManagedMutationResult> {
  if (reason.trim().length === 0 || reason.trim().length > 500) {
    return { ok: false, reason: 'invalid-input', message: '操作原因必填且不超过 500 字。' };
  }

  const record = findRecordById(id);

  if (!record || !isAccessible(record)) {
    return { ok: false, reason: 'not-found', message: '历史维修记录不存在或不可访问。' };
  }

  if (!checkExpectedVersion(id, expectedVersion)) {
    return {
      ok: false,
      reason: 'version-conflict',
      message: '资料版本已更新，请重新读取当前版本后重试。',
    };
  }

  record.deprecated = true;
  const revisionNo = bumpRevision(id, record);

  return { ok: true, id, revisionNo };
}

/**
 * 保存资料归属更正（任务 07 R061-02，Mock 对齐后端口径）：
 * Mock 无组织/账号事实，仅校验输入形态、目标 ID 为正整数与版本；两项均提交视为核实完成。
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
  if (
    input.verificationReason.trim().length === 0 ||
    input.verificationReason.trim().length > 500
  ) {
    return { ok: false, reason: 'invalid-input', message: '操作原因必填且不超过 500 字。' };
  }

  const hasField =
    input.createdByAccountId !== undefined || input.ownerOrganizationId !== undefined;

  if (!hasField) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '归属更正至少需要更正上传者或上传时公司其中一项。',
    };
  }

  const record = findRecordById(id);

  if (!record || !isAccessible(record)) {
    return { ok: false, reason: 'not-found', message: '历史维修记录不存在或不可访问。' };
  }

  if (!checkExpectedVersion(id, expectedVersion)) {
    return {
      ok: false,
      reason: 'version-conflict',
      message: '资料版本已更新，请重新读取当前版本后重试。',
    };
  }

  const revisionNo = bumpRevision(id, record);

  return { ok: true, id, revisionNo };
}

/**
 * 原作者删除本人正式资料（任务 07 R053，Mock 对齐后端口径）：
 * expected_version 过期归并 version-conflict；重复删除不幂等（统一 not-found）。
 */
export async function deleteReferenceDocument(
  id: number,
  expectedVersion: number,
): Promise<DeleteReferenceDocumentResult> {
  const record = findRecordById(id);

  if (!record || record.deprecated) {
    return {
      ok: false,
      reason: 'not-found',
      message: '历史维修记录不存在或不可删除。',
    };
  }

  if (!checkExpectedVersion(id, expectedVersion)) {
    return {
      ok: false,
      reason: 'version-conflict',
      message: '资料版本已更新，请重新读取当前版本后重试。',
    };
  }

  record.deprecated = true;
  bumpRevision(id, record);

  return { ok: true };
}

/**
 * 案例专属更正（Mock 同签名模拟，行为对齐后端 UpdateReferenceDocumentCaseUsecase）：
 * - 空补丁先于读取拒绝（与后端字段存在性门禁同序）；
 * - 不存在 / 已软删统一 not-found；非案例资料 invalid-input（后端口径，不是 not-found）；
 * - 案例明细缺失 update-failed（类型与明细一一对应的定式破坏，失败关闭）；
 * - 标题 / 故障现象 / 复现步骤 / 处理状态不可清空；已解决必须给出处理结果；
 * - 机型 ID 与机型文字互斥（合并后最终态判定）；可读正文由明细重新生成。
 */
export async function updateReferenceDocumentCase(
  id: number,
  patch: UpdateReferenceDocumentCasePatch,
): Promise<UpdateReferenceDocumentCaseResult> {
  const hasEditableField = Object.values(patch).some((value) => value !== undefined);

  if (!hasEditableField) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '更正内容不能为空。',
    };
  }

  const record = findRecordById(id);

  if (!record || !isAccessible(record)) {
    return {
      ok: false,
      reason: 'not-found',
      message: '历史维修记录不存在或不可更正。',
    };
  }

  if (!isFaultCaseDocumentType(record.documentType)) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '仅故障案例资料可以使用案例更正接口。',
    };
  }

  const currentDetail = record.caseDetail;

  if (!currentDetail) {
    return {
      ok: false,
      reason: 'update-failed',
      message: '案例明细缺失，无法完成更正。',
    };
  }

  // 标题合并：undefined 保持原值；空白 / 清空 / 超长拒绝（必填语义在合并后判定）
  let title = record.title;

  if (patch.title !== undefined) {
    if (patch.title === null || isNormalizedBlank(patch.title)) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: '更正后的案例标题不能为空。',
      };
    }

    if (patch.title.trim().length > REFERENCE_DOCUMENT_TITLE_MAX_LENGTH) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `标题不能超过 ${REFERENCE_DOCUMENT_TITLE_MAX_LENGTH} 个字符。`,
      };
    }

    title = patch.title.trim();
  }

  const description =
    patch.description === undefined
      ? record.description
      : isNormalizedBlank(patch.description)
        ? null
        : (patch.description as string).trim();

  // 机型 ID 合并：undefined 保持现值；显式 null 清空；仅在变更时校验型号存在
  let equipmentModelId = record.equipmentModelId;
  let equipmentModelName = record.equipmentModelName;

  if (patch.equipmentModelId !== undefined) {
    if (patch.equipmentModelId === null) {
      equipmentModelId = null;
      equipmentModelName = null;
    } else if (patch.equipmentModelId !== record.equipmentModelId) {
      const model = MOCK_REFERENCE_EQUIPMENT_MODELS.find(
        (option) => option.id === patch.equipmentModelId,
      );

      if (!model) {
        return {
          ok: false,
          reason: 'model-not-found',
          message: '设备型号不存在。',
        };
      }

      equipmentModelId = model.id;
      equipmentModelName = model.modelName;
    }
  }

  const equipmentModelText =
    patch.equipmentModelText === undefined
      ? record.equipmentModelText
      : isNormalizedBlank(patch.equipmentModelText)
        ? null
        : (patch.equipmentModelText as string).trim();

  // 机型互斥（chk_reference_document_model_exclusive 同口径，合并后最终态判定）
  if (equipmentModelId !== null && equipmentModelText !== null) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '机型 ID 与机型文字只能设置一个（两者互斥）；替换机型请在同一补丁中清空另一侧。',
    };
  }

  // 案例明细合并（undefined 保持现值；null / 空白清空），必填存在性在合并后判定
  const errorCode =
    patch.errorCode === undefined
      ? currentDetail.errorCode
      : isNormalizedBlank(patch.errorCode)
        ? null
        : (patch.errorCode as string).trim();
  const handlingStatus =
    patch.handlingStatus !== undefined ? patch.handlingStatus : currentDetail.handlingStatus;
  const phenomenon =
    patch.phenomenon === undefined
      ? currentDetail.phenomenon
      : isNormalizedBlank(patch.phenomenon)
        ? null
        : (patch.phenomenon as string).trim();
  const conditionText =
    patch.conditionText === undefined
      ? currentDetail.conditionText
      : isNormalizedBlank(patch.conditionText)
        ? null
        : (patch.conditionText as string).trim();
  const reproductionSteps =
    patch.reproductionSteps === undefined
      ? currentDetail.reproductionSteps
      : isNormalizedBlank(patch.reproductionSteps)
        ? null
        : (patch.reproductionSteps as string).trim();
  const diagnosis =
    patch.diagnosis === undefined
      ? currentDetail.diagnosis
      : isNormalizedBlank(patch.diagnosis)
        ? null
        : (patch.diagnosis as string).trim();
  const actionTaken =
    patch.actionTaken === undefined
      ? currentDetail.actionTaken
      : isNormalizedBlank(patch.actionTaken)
        ? null
        : (patch.actionTaken as string).trim();
  const resolution =
    patch.resolution === undefined
      ? currentDetail.resolution
      : isNormalizedBlank(patch.resolution)
        ? null
        : (patch.resolution as string).trim();

  if (phenomenon === null) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '更正后的案例故障现象不能为空。',
    };
  }

  if (reproductionSteps === null) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '更正后的案例复现步骤不能为空。',
    };
  }

  if (handlingStatus === null) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '更正后的案例处理状态不能为空。',
    };
  }

  // 已解决必填处理结果（chk_reference_document_case_detail_resolution 同口径）
  if (handlingStatus === 'RESOLVED' && resolution === null) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '处理状态为已解决时必须填写处理结果。',
    };
  }

  const caseDetail: ReferenceDocumentCaseDetail = {
    errorCode,
    handlingStatus,
    phenomenon,
    conditionText,
    reproductionSteps,
    diagnosis,
    actionTaken,
    resolution,
  };

  record.title = title;
  record.description = description;
  record.equipmentModelId = equipmentModelId;
  record.equipmentModelName = equipmentModelName;
  record.equipmentModelText = equipmentModelText;
  record.caseDetail = caseDetail;
  record.caseHandlingStatus = caseDetail.handlingStatus;
  // 可读正文由明细重新生成（单一真源，禁止与明细脱节直改）
  record.contentText = formatFaultCaseContentText(caseDetail);
  record.updatedAt = new Date().toISOString();

  return { ok: true, id: record.id, updatedAt: record.updatedAt };
}

/**
 * 下载资料文件（Mock 同签名模拟，行为对齐后端 REST 边界）：
 * - 不存在 / 已软删统一 not-found（防探测口径）；
 * - 无存储引用（含纯文本与仅有文件名的历史行）file-not-available；
 *   文件资料返回合成字节 Blob（内容为 Mock 占位，非真实文件）。
 */
export async function downloadReferenceDocumentFile(
  id: number,
): Promise<ReferenceDocumentFileDownloadResult> {
  const record = findRecordById(id);

  if (!record || !isAccessible(record)) {
    return {
      ok: false,
      reason: 'not-found',
      message: '历史维修记录不存在或不可查看。',
    };
  }

  if (!record.hasFile) {
    return {
      ok: false,
      reason: 'file-not-available',
      message: '该资料没有可下载的文件。',
    };
  }

  const bytes = new TextEncoder().encode(`mock-file-bytes:${record.originalFilename}`);

  return {
    ok: true,
    blob: new Blob([bytes]),
    // 不变式：hasFile=true 蕴含 originalFilename 非空（类型收窄防御，与上方守卫配套）
    filename: record.originalFilename ?? 'file',
  };
}
