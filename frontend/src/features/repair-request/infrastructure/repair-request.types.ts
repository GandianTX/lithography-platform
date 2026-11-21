// src/features/repair-request/infrastructure/repair-request.types.ts

import type { StagedStoredFile } from './stored-file-upload';

/**
 * 维修申请 feature 的 GraphQL 契约类型（与后端 DTO 对齐）
 */

export type EquipmentModelOption = {
  id: number;
  modelCode: string;
  modelName: string;
};

/** 客户可选维修厂家（`repairServiceOrganizationSearch`，仅启用且具备维修服务资格） */
export type ServiceOrganizationOption = {
  id: number;
  name: string;
  shortName: string | null;
};

/** 客户私有报修原件引用（暂存态；绑定由提交事务完成） */
export type RepairRequestAttachmentRef = {
  fileId: string;
  uploadContextId: string;
};

/**
 * 创建维修申请输入（任务 03「提交即出单」）。
 *
 * - `recordUuid`：稳定提交标识（36 位 UUID）；双击、并发与响应丢失后的重发必须复用同一值，
 *   由 application 层持有一份，提交成功后才换新；
 * - `equipmentModelId` 与 `equipmentModelText` 严格二选一（后端判定，前端只保证形态）；
 * - 客户公司与客户账号不在输入中（服务端从可信身份取得）。
 */
export type CreateRepairRequestInput = {
  recordUuid: string;
  serviceOrganizationId: number;
  equipmentModelId?: number | null;
  equipmentModelText?: string | null;
  errorCode: string;
  faultDescription: string;
  attachment?: RepairRequestAttachmentRef | null;
};

export type RepairRequestRecord = {
  id: number;
  requestNo: string;
  equipmentModelId: number;
  errorCode: string;
  faultDescription: string;
  createdAt: string;
  isAccepted: boolean;
};

/**
 * 业务拒绝原因（domain failure 显式结果），
 * 与后端 REPAIR_REQUEST_ERROR / STORED_FILE_ERROR / INPUT_NORMALIZE_ERROR 码组对应。
 *
 * `company-required` / `company-unavailable`：客户归属门禁（S4）——账号尚未补录公司，
 * 或已归属公司当前不可用；对外均为 FORBIDDEN。前者可用 `company-required` 引导用户
 * 先去账号设置补录，后者只提示联系管理员。
 * `service-org-unavailable`：所选维修厂家已停用/失去维修服务资格，客户端可改选。
 * `submission-conflict`：同一提交标识的内容与已提交记录不一致（含异主附件），
 * 需重新打开报修页提交；不返回原记录任何字段。
 * `submission-deleted`：同标识对应的原申请已被本人删除（PR #27 复审）——重放失败关闭，
 * 不恢复旧工单、不自动重建；用户明确重新发起时由 application 层换新提交标识。
 * `attachment-*`：原件不可绑定（已被占用/用途不符/不存在），需重新上传或移除附件。
 */
export type CreateRepairRequestFailureReason =
  | 'model-not-found'
  | 'model-disabled'
  | 'invalid-input'
  | 'company-required'
  | 'company-unavailable'
  | 'service-org-unavailable'
  | 'submission-conflict'
  | 'submission-deleted'
  | 'attachment-not-found'
  | 'attachment-conflict'
  | 'creation-failed';

export type CreateRepairRequestResult =
  | { ok: true; repairRequest: RepairRequestRecord }
  | {
      ok: false;
      reason: CreateRepairRequestFailureReason;
      message: string;
    };

/** 客户报修原件上传失败原因（REST 入口，用途 REPAIR_REQUEST） */
export type UploadRepairRequestFileFailureReason =
  | 'invalid-input'
  | 'file-too-large'
  | 'file-type-not-allowed'
  | 'company-required'
  | 'insufficient-permission'
  | 'upload-failed';

export type UploadRepairRequestFileResult =
  | { ok: true; file: StagedStoredFile }
  | { ok: false; reason: UploadRepairRequestFileFailureReason; message: string };
