// src/core/local-runtime/policy/local-backup-cloud-receipt.policy.ts
/**
 * 云回执**完整性**的**唯一裁决**（任务 09 S3.3／S4）。
 *
 * 为什么单独成文件：回执完整性同时被两条链消费——
 * - 上云链：判定"上传是否真的成功"（`decideCloudUploadSuccess`）；
 * - 清理链：判定"是否具备清理授权"（`decideManualCleanupTargets`）。
 *
 * 此前它住在清理策略文件里，上云链要么跨文件引用"清理"模块的口径，
 * 要么**自己再判一遍**（把 `receiptComplete` 当形参由调用方注入）⇒
 * 同一口径两处实现，"成功"的定义一旦漂移就会出现
 * "资产显示已上云，但手动清理恒为零"的分裂。
 *
 * 口径从严：宁可判为不完整（零清理／不算成功），也不把半截回执当作成功授权。
 */

/** 云回执不完整的判定原因 */
export type CloudReceiptIncompleteReason =
  'CLOUD_RECEIPT_MISSING' | 'CLOUD_RECEIPT_UNPARSEABLE' | 'CLOUD_RECEIPT_NOT_SUCCESS';

/** 云回执完整性裁决 */
export type CloudReceiptVerdict =
  | { complete: true }
  | { complete: false; reason: CloudReceiptIncompleteReason };

/** 回执中出现这些状态即视为云端已确认接收 */
const CLOUD_RECEIPT_SUCCESS_STATUSES = ['SUCCEEDED', 'SUCCESS', 'OK', 'RECEIVED', 'ACCEPTED'];

/**
 * 完整云回执判定。
 *
 * 完整回执 = 非空 + 可解析为 JSON 对象 + 无失败语义 + 明确的成功语义
 * （`received === true` 或 `status` 命中成功状态）。
 */
export function isCompleteCloudReceipt(receipt: string | null | undefined): CloudReceiptVerdict {
  const raw = (receipt ?? '').trim();
  if (raw.length === 0) {
    return { complete: false, reason: 'CLOUD_RECEIPT_MISSING' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { complete: false, reason: 'CLOUD_RECEIPT_UNPARSEABLE' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { complete: false, reason: 'CLOUD_RECEIPT_UNPARSEABLE' };
  }

  const record = parsed as Record<string, unknown>;
  const failure = record['error'] ?? record['failure'] ?? record['rejected'];
  if (failure !== undefined && failure !== null && failure !== false) {
    return { complete: false, reason: 'CLOUD_RECEIPT_NOT_SUCCESS' };
  }
  if (record['received'] === true) {
    return { complete: true };
  }
  const status = record['status'];
  if (typeof status === 'string' && CLOUD_RECEIPT_SUCCESS_STATUSES.includes(status.toUpperCase())) {
    return { complete: true };
  }
  return { complete: false, reason: 'CLOUD_RECEIPT_NOT_SUCCESS' };
}
