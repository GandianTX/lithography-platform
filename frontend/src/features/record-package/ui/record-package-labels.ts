// src/features/record-package/ui/record-package-labels.ts

import type { MessageKey } from '@/shared/i18n';
import { resolveControlledCodeKey } from '@/shared/i18n/controlled-code';

/**
 * 记录包受控码 → 文案键映射。
 *
 * 后端给的是**受控码**（导出结论、检查结论、导入结果、批次状态、资源类型）；
 * 前端只把受控码映射成词条键，未知码回落到中性文案——不把机器码原样透给用户。
 */

const RESOURCE_TYPE_KEYS: Record<string, MessageKey> = {
  MAINTENANCE_REPORT: 'recordPackage.resourceType.MAINTENANCE_REPORT',
  REFERENCE_DOCUMENT: 'recordPackage.resourceType.REFERENCE_DOCUMENT',
  REPAIR_REQUEST: 'recordPackage.resourceType.REPAIR_REQUEST',
};

const OUTCOME_KEYS: Record<string, MessageKey> = {
  EXPORTED: 'recordPackage.outcome.EXPORTED',
  REJECTED: 'recordPackage.outcome.REJECTED',
};

const CHECK_RESULT_KEYS: Record<string, MessageKey> = {
  PASSED: 'recordPackage.checkResult.PASSED',
  REJECTED: 'recordPackage.checkResult.REJECTED',
};

const CHECK_STATUS_KEYS: Record<string, MessageKey> = {
  PASSED: 'recordPackage.checkStatus.PASSED',
  PENDING: 'recordPackage.checkStatus.PENDING',
  REJECTED: 'recordPackage.checkStatus.REJECTED',
};

const ITEM_RESULT_KEYS: Record<string, MessageKey> = {
  CONFLICT: 'recordPackage.itemResult.CONFLICT',
  FAILED: 'recordPackage.itemResult.FAILED',
  NOT_EXECUTED: 'recordPackage.itemResult.NOT_EXECUTED',
  SKIPPED: 'recordPackage.itemResult.SKIPPED',
  SUCCEEDED: 'recordPackage.itemResult.SUCCEEDED',
};

const STATUS_KEYS: Record<string, MessageKey> = {
  FAILED: 'recordPackage.status.FAILED',
  PARTIAL: 'recordPackage.status.PARTIAL',
  PENDING: 'recordPackage.status.PENDING',
  RUNNING: 'recordPackage.status.RUNNING',
  SUCCEEDED: 'recordPackage.status.SUCCEEDED',
};

/** 资源类型文案键 */
export function resolveRecordPackageResourceTypeKey(value: string): MessageKey {
  return resolveControlledCodeKey(
    RESOURCE_TYPE_KEYS,
    value,
    'recordPackage.resourceType.REFERENCE_DOCUMENT',
  );
}

/** 导出结论文案键 */
export function resolveRecordPackageOutcomeKey(value: string): MessageKey {
  return resolveControlledCodeKey(OUTCOME_KEYS, value, 'recordPackage.outcome.REJECTED');
}

/** 检查结论文案键 */
export function resolveRecordPackageCheckResultKey(value: string): MessageKey {
  return resolveControlledCodeKey(CHECK_RESULT_KEYS, value, 'recordPackage.checkResult.REJECTED');
}

/** 批次检查状态文案键 */
export function resolveRecordPackageCheckStatusKey(value: string): MessageKey {
  return resolveControlledCodeKey(CHECK_STATUS_KEYS, value, 'recordPackage.checkStatus.PENDING');
}

/** 逐条导入结果文案键 */
export function resolveRecordPackageItemResultKey(value: string): MessageKey {
  return resolveControlledCodeKey(ITEM_RESULT_KEYS, value, 'recordPackage.itemResult.FAILED');
}

/** 批次导入状态文案键 */
export function resolveRecordPackageStatusKey(value: string): MessageKey {
  return resolveControlledCodeKey(STATUS_KEYS, value, 'recordPackage.status.PENDING');
}
