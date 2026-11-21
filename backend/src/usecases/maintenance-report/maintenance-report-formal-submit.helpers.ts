// src/usecases/maintenance-report/maintenance-report-formal-submit.helpers.ts
//
// R051-01 正式提交的纯函数与机型登记助手。
//
// - 内容摘要：SHA-256(canonical JSON(来源 + 归属工单 + 归一化草稿))，
//   作为 submission_payload_hash 供幂等重试与「同标识异内容拒绝」比对；
// - 提交标识：系统生成（前端 crypto.randomUUID），服务端只校验形态，
//   不信任其内容语义；
// - 机型登记（V5.4 第 3 章）：仅独立历史维修报告 + 手填机型时触发；
//   名称去首尾空白后与 model_code 生成采用同一规则（确定性编码），
//   唯一启用项复用、多项同名拒绝、仅停用匹配拒绝、确无匹配才新增；
//   并发同名登记由 uk_equipment_model_code 兜底，冲突后读回核对同名复用。

import { createHash } from 'node:crypto';

import { MaintenanceReportSourceType } from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { isBlankText } from '@core/common/text/text.helper';
import type { EquipmentModelService } from '@src/modules/lithography/equipment-model.service';
import type { MaintenanceReportDraftWriteData } from '@src/modules/lithography/maintenance-report.types';
import { assertMaintenanceReportId } from '@src/usecases/maintenance-report/maintenance-report-roles';
import { trimRequiredText } from '@src/usecases/maintenance-report/maintenance-report.input.normalize';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';

/** 提交标识形态：系统生成的无语义稳定标识（UUID / 前缀随机串均可） */
const SUBMISSION_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function assertValidSubmissionRequestId(value: string): string {
  const trimmed = trimRequiredText(value);
  if (!SUBMISSION_REQUEST_ID_PATTERN.test(trimmed)) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.SUBMISSION_REQUEST_INVALID,
      '提交标识无效或缺失，请刷新页面后重试',
    );
  }
  return trimmed;
}

/**
 * 规范化提交内容摘要：对归一化后的草稿、来源事实与附带暂存原件做稳定序列化后取 SHA-256。
 * 重试必须携带与首次完全相同的表单输入（含同一 fileId），才能命中同一摘要；
 * 同标识换附件视为异内容拒绝。
 */
export function computeSubmissionPayloadHash(params: {
  sourceType: MaintenanceReportSourceType;
  repairRequestId: number | null;
  draft: MaintenanceReportDraftWriteData;
  /** 直接提交附带暂存原件的 file_id；未附带为 null */
  attachmentFileId?: string | null;
}): string {
  const canonical = JSON.stringify({
    sourceType: params.sourceType,
    repairRequestId: params.repairRequestId,
    draft: params.draft,
    attachmentFileId: params.attachmentFileId ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * R051-01 正式完整性校验（区别于旧送审校验：报告标题不要求，V6.5 表头必填项为准）。
 * 厂家、日期、机型（ID 或手填文字）、维修结果、至少一条排查步骤。
 */
export function assertFormalSubmitCompleteness(draft: MaintenanceReportDraftWriteData): void {
  if (draft.customerFactoryName === null || isBlankText(draft.customerFactoryName)) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '提交前必须填写客户厂家', {
      fieldName: 'customerFactoryName',
    });
  }
  if (draft.maintenanceDate === null || isBlankText(draft.maintenanceDate)) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '提交前必须填写维修日期', {
      fieldName: 'maintenanceDate',
    });
  }
  if (
    draft.equipmentModelId === null &&
    (draft.equipmentModelText === null || isBlankText(draft.equipmentModelText))
  ) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '提交前必须填写设备型号', {
      fieldName: 'equipmentModel',
    });
  }
  if (draft.handlingResult === null) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '提交前必须选择维修结果', {
      fieldName: 'handlingResult',
    });
  }
  if (draft.steps.length === 0) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '正式提交至少需要一条排查步骤', {
      fieldName: 'steps',
    });
  }
  if (draft.faults.length === 0) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '提交前必须填写初始故障信息', {
      fieldName: 'faults',
    });
  }
}

/**
 * 提交/导出共用的来源校验：工单总结必须关联工单；独立报告不得携带工单。
 * 与建稿用例同口径；同一裁决避免正式提交与预览导出各自漂移。
 */
export function normalizeFormalRepairRequestId(
  sourceType: MaintenanceReportSourceType,
  repairRequestId: number | null | undefined,
): number | null {
  if (sourceType === MaintenanceReportSourceType.HISTORICAL_CASE) {
    if (repairRequestId !== null && repairRequestId !== undefined) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
        '历史故障案例不能关联系统工单',
        { repairRequestId },
      );
    }
    return null;
  }
  if (repairRequestId === null || repairRequestId === undefined) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '工单总结必须关联工单');
  }
  assertMaintenanceReportId(repairRequestId);
  return repairRequestId;
}

/**
 * 机型稳定编码：与名称比较采用同一规则（去首尾空白后的名称），
 * 确定性派生，保证同名并发登记命中唯一索引后被读回复用。
 */
export function deriveStableModelCode(modelName: string): string {
  const digest = createHash('sha256').update(modelName, 'utf8').digest('hex');
  // MR + 40 位十六进制 = 42 字符，落在 model_code varchar(50) 之内
  return `MR${digest.slice(0, 40)}`;
}

/**
 * R051-01 机型登记：返回本次正式结果的最终 equipment_model_id。
 *
 * 触发条件（工单总结不登记，沿用原规则）由调用方保证；
 * 多项同名启用项与仅停用匹配均拒绝，不自动启用或重复登记。
 */
export async function resolveOrRegisterEquipmentModel(params: {
  equipmentModelText: string;
  equipmentModelService: EquipmentModelService;
  transactionContext: PersistenceTransactionContext;
}): Promise<number> {
  const modelName = trimRequiredText(params.equipmentModelText);
  if (isBlankText(modelName)) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '手填机型不能为空白', {
      fieldName: 'equipmentModelText',
    });
  }

  const matches = await params.equipmentModelService.findModelsByName(
    modelName,
    params.transactionContext,
  );
  const enabledMatches = matches.filter((model) => model.enabled);
  if (enabledMatches.length === 1) {
    return enabledMatches[0].id;
  }
  if (enabledMatches.length > 1) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.EQUIPMENT_MODEL_AMBIGUOUS,
      '存在多个同名机型，请从型号库中选择',
      { modelName },
    );
  }
  if (matches.length > 0) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.EQUIPMENT_MODEL_DISABLED_MATCH,
      '同名机型已停用，请从型号库选择或联系管理员',
      { modelName },
    );
  }

  const created = await params.equipmentModelService.insertModelOrReuseSameName(
    { modelName, modelCode: deriveStableModelCode(modelName) },
    params.transactionContext,
  );
  return created.id;
}
