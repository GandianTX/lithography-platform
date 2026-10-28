// src/features/reference-document/infrastructure/reference-document-mock-adapter.ts

import type {
  CreateReferenceDocumentInput,
  CreateReferenceDocumentResult,
  CreateReferenceDocumentWithFileInput,
  CreateReferenceDocumentWithFileResult,
  DeleteReferenceDocumentResult,
  ReferenceDocumentCaseDetail,
  ReferenceDocumentCaseHandlingStatus,
  ReferenceDocumentDetailResult,
  ReferenceDocumentEquipmentModelOption,
  ReferenceDocumentFileDownloadResult,
  ReferenceDocumentListFilter,
  ReferenceDocumentListPage,
  ReferenceDocumentListPagination,
  UpdateReferenceDocumentCasePatch,
  UpdateReferenceDocumentCaseResult,
  UpdateReferenceDocumentPatch,
  UpdateReferenceDocumentResult,
} from './reference-document.types';
import {
  REFERENCE_DOCUMENT_DOCUMENT_TYPE_MAX_LENGTH,
  REFERENCE_DOCUMENT_TITLE_MAX_LENGTH,
  REFERENCE_DOCUMENT_UPLOAD_EXTENSION_MIME,
} from './reference-document.types';
import type { MockReferenceDocumentRecord } from './reference-document-mock-data';
import {
  buildMockReferenceDocumentRecords,
  MOCK_REFERENCE_EQUIPMENT_MODELS,
  MOCK_REFERENCE_ORGANIZATION_NAME,
} from './reference-document-mock-data';

/**
 * 阶段二 Mock 数据访问层：签名与阶段三的真实 adapter 完全一致，
 * 页面经 barrel（@/features/reference-document）消费统一导出名，替换真实实现时页面零改动。
 *
 * 行为对齐后端契约（B-01~B-06 定案；错误大类映射见各函数注释）：
 * - 列表：仅未软删、createdAt DESC + id DESC、OFFSET 分页、标题模糊/类型等值/型号等值筛选；
 * - 详情：不存在 / 已软删统一 not-found（防探测，不区分原因）；
 * - 创建：必填空白 / 超长 → invalid-input；型号不存在 → model-not-found；成功返回新 ID；
 * - 编辑：PATCH 语义（undefined 保持原值）；必填字段显式 null 直接拒绝；
 *   contentText 不允许清空；已软删 / 不存在统一 not-found；
 * - 案例保护：FAULT_CASE 的类型 / 正文与案例明细强耦合，通用编辑拒绝改造
 *   （invalid-input），必须走案例更正接口；普通资料转 FAULT_CASE 同样拒绝；
 * - 案例更正：仅 FAULT_CASE 可走（非案例资料 invalid-input，非 not-found）；
 *   必填 / 机型互斥 / 已解决必填结果与后端校验同口径，正文由明细重新生成；
 * - 软删：不存在 / 已软删统一 not-found（注意：本模块不幂等，区别于维修申请）。
 */

/** Mock 创建人昵称：阶段三由后端按 Session 实时富集，Mock 固定为管理员语义 */
const MOCK_CREATOR_NICKNAME = '系统管理员';

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
let nextId = 970007 + 1000;

/** 测试隔离：重建数据源（种子 + 批量数据），并重置自增主键 */
export function resetReferenceDocumentMockState(): void {
  repository = buildMockReferenceDocumentRecords();
  nextId = 970007 + 1000;
}

function isNormalizedBlank(value: string): boolean {
  return value.trim().length === 0;
}

function requireNormalizedText(value: string, maxLength: number): string | null {
  if (isNormalizedBlank(value)) {
    return null;
  }

  return value.trim().length > maxLength ? null : value.trim();
}

/** 更正补丁业务文本合并：undefined 保持现值；null / 空白清空；非空 trim */
function mergePatchedText(
  value: string | null | undefined,
  currentValue: string | null,
): string | null {
  if (value === undefined) {
    return currentValue;
  }

  return value !== null && !isNormalizedBlank(value) ? value.trim() : null;
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

function findVisibleById(id: number): MockReferenceDocumentRecord | undefined {
  const record = repository.find((item) => item.id === id);

  return record && !record.deprecated ? record : undefined;
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
    organizationName: record.organizationName,
    ingestMethod: record.ingestMethod,
    caseDetail: record.caseDetail,
    creatorNickname: record.creatorNickname,
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
    .filter((record) => !record.deprecated)
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
  const record = findVisibleById(id);

  if (!record) {
    // 后端统一 NOT_FOUND（防探测）：不存在与已软删同文案，不区分原因
    return {
      ok: false,
      reason: 'not-found',
      message: '参考资料不存在或不可查看。',
    };
  }

  return { ok: true, detail: toDetail(record) };
}

export async function createReferenceDocument(
  input: CreateReferenceDocumentInput,
): Promise<CreateReferenceDocumentResult> {
  const title = requireNormalizedText(input.title, REFERENCE_DOCUMENT_TITLE_MAX_LENGTH);
  const documentType = requireNormalizedText(
    input.documentType,
    REFERENCE_DOCUMENT_DOCUMENT_TYPE_MAX_LENGTH,
  );

  if (title === null || documentType === null) {
    return {
      ok: false,
      reason: 'invalid-input',
      message:
        title === null
          ? `标题为必填项，且不能超过 ${REFERENCE_DOCUMENT_TITLE_MAX_LENGTH} 个字符。`
          : `文档类型为必填项，且不能超过 ${REFERENCE_DOCUMENT_DOCUMENT_TYPE_MAX_LENGTH} 个字符。`,
    };
  }

  if (isNormalizedBlank(input.contentText)) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '文本内容为必填项（本周仅支持文本来源）。',
    };
  }

  if (input.equipmentModelId !== null) {
    const modelExists = MOCK_REFERENCE_EQUIPMENT_MODELS.some(
      (model) => model.id === input.equipmentModelId,
    );

    if (!modelExists) {
      return {
        ok: false,
        reason: 'model-not-found',
        message: '所选设备型号不存在，请重新选择。',
      };
    }
  }

  const model = MOCK_REFERENCE_EQUIPMENT_MODELS.find(
    (option) => option.id === input.equipmentModelId,
  );
  const now = new Date().toISOString();

  const record: MockReferenceDocumentRecord = {
    id: nextId,
    title,
    documentType,
    equipmentModelId: model?.id ?? null,
    equipmentModelName: model?.modelName ?? null,
    equipmentModelText: null,
    description: input.description?.trim() ? input.description.trim() : null,
    originalFilename: null,
    mimeType: null,
    hasFile: false,
    contentText: input.contentText.trim(),
    organizationName: MOCK_REFERENCE_ORGANIZATION_NAME,
    ingestMethod: 'ADMIN_DIRECT',
    caseHandlingStatus: null,
    caseDetail: null,
    creatorNickname: MOCK_CREATOR_NICKNAME,
    createdAt: now,
    updatedAt: now,
    deprecated: false,
  };

  repository = [record, ...repository];
  nextId += 1;

  return { ok: true, id: record.id };
}

export async function updateReferenceDocument(
  id: number,
  patch: UpdateReferenceDocumentPatch,
): Promise<UpdateReferenceDocumentResult> {
  const record = findVisibleById(id);

  if (!record) {
    return {
      ok: false,
      reason: 'not-found',
      message: '参考资料不存在或不可编辑。',
    };
  }

  // 案例保护（对齐后端 usecase）：FAULT_CASE 的类型 / 正文与案例明细强耦合，
  // 通用编辑不得单独改造，必须走案例更正接口
  if (isFaultCaseDocumentType(record.documentType)) {
    if (patch.documentType !== undefined) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: '案例资料类型不可通过通用编辑修改，请使用案例更正接口。',
      };
    }

    if (patch.contentText !== undefined) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: '案例资料正文不可通过通用编辑修改，请使用案例更正接口。',
      };
    }
  }

  // PATCH 语义：undefined 保持原值；必填字段显式 null 后端直接拒绝（INVALID_PARAMS），
  // 前端在 adapter 层同口径归并 invalid-input，表单不产生 null，仅测试钉住契约。
  if (patch.title === null || patch.documentType === null) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '标题与文档类型为必填字段，不允许置空。',
    };
  }

  // 内容来源双空防御与后端同口径：仅已有存储引用的资料（hasFile）允许清空正文，
  // 不从 originalFilename 推断——有文件名但无存储引用的行（如 seed/legacy）不放行
  if (patch.contentText !== undefined && isNormalizedBlank(patch.contentText) && !record.hasFile) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '文本内容与文件至少需要一个。',
    };
  }

  if (patch.title !== undefined) {
    const title = requireNormalizedText(patch.title, REFERENCE_DOCUMENT_TITLE_MAX_LENGTH);

    if (title === null) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `标题为必填项，且不能超过 ${REFERENCE_DOCUMENT_TITLE_MAX_LENGTH} 个字符。`,
      };
    }

    record.title = title;
  }

  if (patch.documentType !== undefined) {
    const documentType = requireNormalizedText(
      patch.documentType,
      REFERENCE_DOCUMENT_DOCUMENT_TYPE_MAX_LENGTH,
    );

    if (documentType === null) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `文档类型为必填项，且不能超过 ${REFERENCE_DOCUMENT_DOCUMENT_TYPE_MAX_LENGTH} 个字符。`,
      };
    }

    // 普通资料不能借此转为 FAULT_CASE（类型保留值只能来自投稿发布，对齐后端 §4.3）
    if (isFaultCaseDocumentType(documentType) && !isFaultCaseDocumentType(record.documentType)) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: '不能通过通用编辑把普通资料改为案例资料，请通过投稿审核流程发布。',
      };
    }

    record.documentType = documentType;
  }

  if (patch.equipmentModelId !== undefined && patch.equipmentModelId !== null) {
    const model = MOCK_REFERENCE_EQUIPMENT_MODELS.find(
      (option) => option.id === patch.equipmentModelId,
    );

    if (!model) {
      return {
        ok: false,
        reason: 'model-not-found',
        message: '所选设备型号不存在，请重新选择。',
      };
    }

    record.equipmentModelId = model.id;
    record.equipmentModelName = model.modelName;
  } else if (patch.equipmentModelId === null) {
    record.equipmentModelId = null;
    record.equipmentModelName = null;
  }

  if (patch.description !== undefined) {
    record.description = patch.description?.trim() ? patch.description.trim() : null;
  }

  if (patch.contentText !== undefined) {
    record.contentText = isNormalizedBlank(patch.contentText) ? null : patch.contentText.trim();
  }

  record.updatedAt = new Date().toISOString();

  return { ok: true, id: record.id };
}

export async function deleteReferenceDocument(id: number): Promise<DeleteReferenceDocumentResult> {
  const record = repository.find((item) => item.id === id);

  // 后端口径：不存在与已软删统一 NOT_FOUND（重复软删不幂等，backend e2e 已钉住）
  if (!record || record.deprecated) {
    return {
      ok: false,
      reason: 'not-found',
      message: '参考资料不存在或不可删除。',
    };
  }

  record.deprecated = true;
  record.updatedAt = new Date().toISOString();

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

  const record = findVisibleById(id);

  if (!record) {
    return {
      ok: false,
      reason: 'not-found',
      message: '参考资料不存在或不可更正。',
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

  const description = mergePatchedText(patch.description, record.description);

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

  const equipmentModelText = mergePatchedText(patch.equipmentModelText, record.equipmentModelText);

  // 机型互斥（chk_reference_document_model_exclusive 同口径，合并后最终态判定）
  if (equipmentModelId !== null && equipmentModelText !== null) {
    return {
      ok: false,
      reason: 'invalid-input',
      message: '机型 ID 与机型文字只能设置一个（两者互斥）；替换机型请在同一补丁中清空另一侧。',
    };
  }

  // 案例明细合并（undefined 保持现值；null / 空白清空），必填存在性在合并后判定
  const errorCode = mergePatchedText(patch.errorCode, currentDetail.errorCode);
  const handlingStatus =
    patch.handlingStatus !== undefined ? patch.handlingStatus : currentDetail.handlingStatus;
  const phenomenon = mergePatchedText(patch.phenomenon, currentDetail.phenomenon);
  const conditionText = mergePatchedText(patch.conditionText, currentDetail.conditionText);
  const reproductionSteps = mergePatchedText(
    patch.reproductionSteps,
    currentDetail.reproductionSteps,
  );
  const diagnosis = mergePatchedText(patch.diagnosis, currentDetail.diagnosis);
  const actionTaken = mergePatchedText(patch.actionTaken, currentDetail.actionTaken);
  const resolution = mergePatchedText(patch.resolution, currentDetail.resolution);

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
  const now = new Date().toISOString();

  record.title = title;
  record.description = description;
  record.equipmentModelId = equipmentModelId;
  record.equipmentModelName = equipmentModelName;
  record.equipmentModelText = equipmentModelText;
  record.caseDetail = caseDetail;
  record.caseHandlingStatus = caseDetail.handlingStatus;
  // 可读正文由明细重新生成（单一真源，禁止与明细脱节直改）
  record.contentText = formatFaultCaseContentText(caseDetail);
  record.updatedAt = now;

  return { ok: true, id: record.id, updatedAt: now };
}

/** 从文件名提取小写扩展名（无扩展名返回空串） */
function extractFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');

  return lastDot === -1 ? '' : fileName.slice(lastDot + 1).toLowerCase();
}

/**
 * REST multipart 上传创建（Mock 同签名模拟，行为对齐后端 REST 边界）：
 * - 必填校验与纯文本创建一致；contentText 可空（仅文件创建），与文件双空才拒绝；
 * - 扩展名白名单外拒绝（file-type-not-allowed，与后端以扩展名为主判定同口径）；
 * - 成功记录 originalFilename / mimeType 存储元数据（无物理文件，下载时合成字节）。
 */
export async function createReferenceDocumentWithFile(
  input: CreateReferenceDocumentWithFileInput,
): Promise<CreateReferenceDocumentWithFileResult> {
  const title = requireNormalizedText(input.title, REFERENCE_DOCUMENT_TITLE_MAX_LENGTH);
  const documentType = requireNormalizedText(
    input.documentType,
    REFERENCE_DOCUMENT_DOCUMENT_TYPE_MAX_LENGTH,
  );

  if (title === null || documentType === null) {
    return {
      ok: false,
      reason: 'invalid-input',
      message:
        title === null
          ? `标题为必填项，且不能超过 ${REFERENCE_DOCUMENT_TITLE_MAX_LENGTH} 个字符。`
          : `文档类型为必填项，且不能超过 ${REFERENCE_DOCUMENT_DOCUMENT_TYPE_MAX_LENGTH} 个字符。`,
    };
  }

  const extension = extractFileExtension(input.file.name);
  const mimeType = REFERENCE_DOCUMENT_UPLOAD_EXTENSION_MIME[extension];

  if (mimeType === undefined) {
    return {
      ok: false,
      reason: 'file-type-not-allowed',
      message: '不允许上传该类型的文件。',
    };
  }

  if (input.equipmentModelId !== null) {
    const modelExists = MOCK_REFERENCE_EQUIPMENT_MODELS.some(
      (model) => model.id === input.equipmentModelId,
    );

    if (!modelExists) {
      return {
        ok: false,
        reason: 'model-not-found',
        message: '所选设备型号不存在，请重新选择。',
      };
    }
  }

  const model = MOCK_REFERENCE_EQUIPMENT_MODELS.find(
    (option) => option.id === input.equipmentModelId,
  );
  const now = new Date().toISOString();

  const record: MockReferenceDocumentRecord = {
    id: nextId,
    title,
    documentType,
    equipmentModelId: model?.id ?? null,
    equipmentModelName: model?.modelName ?? null,
    equipmentModelText: null,
    description: input.description?.trim() ? input.description.trim() : null,
    originalFilename: input.file.name,
    mimeType,
    hasFile: true,
    contentText: input.contentText?.trim() ? input.contentText.trim() : null,
    organizationName: MOCK_REFERENCE_ORGANIZATION_NAME,
    ingestMethod: 'ADMIN_DIRECT',
    caseHandlingStatus: null,
    caseDetail: null,
    creatorNickname: MOCK_CREATOR_NICKNAME,
    createdAt: now,
    updatedAt: now,
    deprecated: false,
  };

  repository = [record, ...repository];
  nextId += 1;

  return { ok: true, id: record.id };
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
  const record = findVisibleById(id);

  if (!record) {
    return {
      ok: false,
      reason: 'not-found',
      message: '参考资料不存在或不可查看。',
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
