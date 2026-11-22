// src/core/local-runtime/policy/business-sync-protocol.policy.ts
/**
 * 业务同步派发协议（任务 09 S2.2）。
 *
 * 定位：**本机不盲信云端回包**。接收端返回公司、身份、版本、摘要与已收原件清单，
 * 本机按同一套规则重新裁决一遍，只有全部对得上才允许落回执、判"已同步"。
 *
 * 受控裁决原因码（大写下划线，不携带正文、快照与凭据）：
 * - `ACCEPTED`：核对通过；
 * - `COMPANY_MISMATCH`：回包声明的公司与本机任务绑定公司不一致；
 * - `IDENTITY_MISMATCH`：回包声明的稳定业务编号与本机任务登记的不一致；
 * - `VERSION_MISMATCH`：回包未给出版本事实，或云端版本落后于本机登记版本；
 * - `MANIFEST_MISMATCH`：同一版本下正文与原件清单摘要不一致；
 * - `ORIGINALS_INCOMPLETE`：已收原件数量少于登记清单；
 * - `ORIGINAL_DIGEST_MISMATCH`：原件逐项校验值或字节数不一致；
 * - `CLOUD_NEWER`：云端版本更新，需人工裁决；
 * - `CLOUD_REJECTED`：接收端明确拒绝。
 */

import type { BusinessSyncManifestOriginal } from './business-sync-source.policy';

/** 受控裁决原因码 */
export const BUSINESS_SYNC_VERDICT_REASON = {
  ACCEPTED: 'ACCEPTED',
  COMPANY_MISMATCH: 'COMPANY_MISMATCH',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  MANIFEST_MISMATCH: 'MANIFEST_MISMATCH',
  ORIGINALS_INCOMPLETE: 'ORIGINALS_INCOMPLETE',
  ORIGINAL_DIGEST_MISMATCH: 'ORIGINAL_DIGEST_MISMATCH',
  CLOUD_NEWER: 'CLOUD_NEWER',
  CLOUD_REJECTED: 'CLOUD_REJECTED',
} as const;

export type BusinessSyncVerdictReason =
  (typeof BUSINESS_SYNC_VERDICT_REASON)[keyof typeof BUSINESS_SYNC_VERDICT_REASON];

/** 派发请求（本机 → 云端）：只含跨端稳定事实与待传正文、原件清单 */
export type BusinessSyncDispatchRequest = {
  /** 公司数据区（必须与任务绑定公司一致） */
  organizationId: number;
  /** 本机安装标识 */
  installationId: string;
  /** 原账号（授权主体）账号ID */
  accountId: number;
  /** 来源资源类型 */
  resourceType: string;
  /** 业务稳定编号 */
  recordUuid: string;
  /** 业务版本 */
  versionNo: number;
  /** 正文与原件清单摘要 */
  manifestChecksum: string;
  /** 正文快照 */
  body: Record<string, unknown>;
  /** 原件清单 */
  originals: readonly BusinessSyncManifestOriginal[];
  /** 幂等键（同一稳定键与版本恒定，重复提交不产生新记录） */
  idempotencyKey: string;
};

/** 接收端回包（云端 → 本机） */
export type BusinessSyncReceiverResponse = {
  /** 接收端自身裁决 */
  status: 'ACCEPTED' | 'CONFLICT' | 'REJECTED';
  /** 接收端给出的受控原因码（本机不直接采信，只在受控集合内透出） */
  reason: string;
  /** 回包声明的公司数据区 */
  organizationId: number | null;
  /** 回包声明的稳定业务编号 */
  recordUuid: string | null;
  /** 云端当前版本；null 表示未给出版本事实 */
  versionNo: number | null;
  /** 云端侧正文与原件清单摘要 */
  manifestChecksum: string | null;
  /** 云端实际收到的原件清单 */
  receivedOriginals: readonly BusinessSyncManifestOriginal[];
  /** 云端资源标识 */
  remoteResourceId: string | null;
  /** 云端当前快照（冲突时用于差异展示） */
  snapshot: Record<string, unknown> | null;
  /** 云端实际接收时间（ISO 文本） */
  receivedAt: string | null;
};

/** 本机裁决结果 */
export type BusinessSyncVerdict = {
  status: 'ACCEPTED' | 'CONFLICT' | 'REJECTED';
  reason: BusinessSyncVerdictReason;
  remoteResourceId: string | null;
  /** 云端当前版本（冲突与差异展示用） */
  cloudVersionNo: number | null;
  /** 云端快照（冲突与差异展示用） */
  cloudSnapshot: Record<string, unknown> | null;
  /** 云端接收时间 */
  receivedAt: string | null;
};

/**
 * 本机裁决（纯函数）。
 *
 * 顺序固定：先核对公司与身份（错了就是错了），再核对版本事实，然后才看摘要与原件。
 * 任何一步对不上都**不落成功回执**——宁可留在"未同步"，也不把事实矛盾写成已同步。
 */
export function resolveBusinessSyncVerdict(
  request: BusinessSyncDispatchRequest,
  response: BusinessSyncReceiverResponse,
): BusinessSyncVerdict {
  const base = {
    remoteResourceId: response.remoteResourceId,
    cloudVersionNo: response.versionNo,
    cloudSnapshot: response.snapshot,
    receivedAt: response.receivedAt,
  };

  if (response.organizationId !== request.organizationId) {
    return { ...base, status: 'REJECTED', reason: BUSINESS_SYNC_VERDICT_REASON.COMPANY_MISMATCH };
  }
  if (response.recordUuid !== request.recordUuid) {
    return { ...base, status: 'REJECTED', reason: BUSINESS_SYNC_VERDICT_REASON.IDENTITY_MISMATCH };
  }
  if (response.versionNo === null) {
    return { ...base, status: 'REJECTED', reason: BUSINESS_SYNC_VERDICT_REASON.VERSION_MISMATCH };
  }
  // 云端版本更新时，本机内容已落后：无论接收端如何声明，都按冲突处理（需人工裁决）
  if (response.versionNo > request.versionNo) {
    return { ...base, status: 'CONFLICT', reason: BUSINESS_SYNC_VERDICT_REASON.CLOUD_NEWER };
  }
  if (response.status === 'CONFLICT') {
    return { ...base, status: 'CONFLICT', reason: BUSINESS_SYNC_VERDICT_REASON.MANIFEST_MISMATCH };
  }
  if (response.status === 'REJECTED') {
    return { ...base, status: 'REJECTED', reason: BUSINESS_SYNC_VERDICT_REASON.CLOUD_REJECTED };
  }
  if (response.versionNo < request.versionNo) {
    return { ...base, status: 'REJECTED', reason: BUSINESS_SYNC_VERDICT_REASON.VERSION_MISMATCH };
  }
  if (response.manifestChecksum !== request.manifestChecksum) {
    return { ...base, status: 'REJECTED', reason: BUSINESS_SYNC_VERDICT_REASON.MANIFEST_MISMATCH };
  }
  const originalsIssue = compareOriginals(request.originals, response.receivedOriginals);
  if (originalsIssue !== null) {
    return { ...base, status: 'REJECTED', reason: originalsIssue };
  }
  return { ...base, status: 'ACCEPTED', reason: BUSINESS_SYNC_VERDICT_REASON.ACCEPTED };
}

/**
 * 全部原件核对：数量、逐项校验值与字节数都必须与登记清单一致。
 * 少件 → `ORIGINALS_INCOMPLETE`；件在但内容对不上 → `ORIGINAL_DIGEST_MISMATCH`。
 */
export function compareOriginals(
  declared: readonly BusinessSyncManifestOriginal[],
  received: readonly BusinessSyncManifestOriginal[],
): BusinessSyncVerdictReason | null {
  if (received.length !== declared.length) {
    return BUSINESS_SYNC_VERDICT_REASON.ORIGINALS_INCOMPLETE;
  }
  for (const item of declared) {
    const matched = received.find((candidate) => candidate.relativePath === item.relativePath);
    if (matched === undefined) {
      return BUSINESS_SYNC_VERDICT_REASON.ORIGINALS_INCOMPLETE;
    }
    if (matched.sha256.toLowerCase() !== item.sha256.toLowerCase()) {
      return BUSINESS_SYNC_VERDICT_REASON.ORIGINAL_DIGEST_MISMATCH;
    }
    if (matched.byteSize !== item.byteSize) {
      return BUSINESS_SYNC_VERDICT_REASON.ORIGINAL_DIGEST_MISMATCH;
    }
  }
  return null;
}
