// src/core/local-runtime/policy/business-sync-source.policy.ts
/**
 * 业务同步来源准入与清单摘要策略（任务 09 S2.1／S2.2）。
 *
 * 两条纯规则：
 * 1. **准入裁决**：来源记录能否生成待传任务。删除／下架／撤回、版本不可核验、
 *    跨端身份未持久化、原账号授权失效或未登记 → 一律**失败关闭**，
 *    不生成"注定失败"的任务，也不回填派生值冒充可信身份。
 * 2. **清单摘要**：正文 + 原件清单的确定性 SHA-256。本机登记与云端回执两侧
 *    用同一算法重算，摘要一致才允许判"完整同步"（见 `sync-status.policy.ts`）。
 *
 * 摘要只覆盖**跨端稳定事实**（稳定键、版本、正文、原件清单），不覆盖本机自增 ID
 * 等设备内事实，保证同一份内容在任意设备上重算得到同一摘要。
 */

import { createHash } from 'node:crypto';

import { BUSINESS_SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';

/** 业务同步清单结构版本（云端回执与本机登记必须同版本） */
export const BUSINESS_SYNC_MANIFEST_SCHEMA_VERSION = 1;

/** 原件清单条目（与本机存储实现解耦，只承载可核对的摘要事实） */
export type BusinessSyncManifestOriginal = {
  /** 稳定相对路径（不含本机绝对路径） */
  relativePath: string;
  /** 原件 SHA-256（十六进制 64 位） */
  sha256: string;
  /** 原件字节数 */
  byteSize: number;
};

/** 清单摘要输入（全部为跨端稳定事实） */
export type BusinessSyncManifestInput = {
  /** 来源资源类型：REFERENCE_DOCUMENT／REPAIR_REQUEST／MAINTENANCE_REPORT */
  resourceType: string;
  /** 业务稳定编号 */
  recordUuid: string;
  /** 业务版本 */
  versionNo: number;
  /** 正文快照（业务字段；不得含本机自增 ID 等设备内事实） */
  body: Record<string, unknown>;
  /** 原件清单（顺序由摘要算法归一） */
  originals: readonly BusinessSyncManifestOriginal[];
};

/**
 * 计算正文 + 原件清单的 SHA-256 摘要。
 *
 * 归一规则（两侧必须一致）：
 * - 对象的键按字典序递归排序，消除字段顺序差异；
 * - 原件按相对路径升序排列；
 * - 校验值统一小写。
 */
export function computeBusinessSyncManifestChecksum(input: BusinessSyncManifestInput): string {
  const canonical = {
    schema_version: BUSINESS_SYNC_MANIFEST_SCHEMA_VERSION,
    resource_type: input.resourceType,
    record_uuid: input.recordUuid,
    version_no: input.versionNo,
    body: canonicalizeBusinessSyncValue(input.body),
    originals: [...input.originals]
      .map((original) => ({
        relative_path: original.relativePath,
        sha256: original.sha256.toLowerCase(),
        byte_size: original.byteSize,
      }))
      .sort((left, right) =>
        left.relative_path < right.relative_path
          ? -1
          : left.relative_path > right.relative_path
            ? 1
            : 0,
      ),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** 递归排序对象键；数组保持原顺序（数组顺序本身是语义的一部分） */
function canonicalizeBusinessSyncValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeBusinessSyncValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      result[key] = canonicalizeBusinessSyncValue(item);
    }
    return result;
  }
  return value;
}

/** 原账号授权状态：ACTIVE=有效；REVOKED=已撤销；UNKNOWN=本机没有该账号的授权登记 */
export type BusinessSyncAuthorizationStatus = 'ACTIVE' | 'REVOKED' | 'UNKNOWN';

/** 来源准入事实（全部来自服务端事实，不接受调用方自报） */
export type BusinessSyncSourceEligibilityFacts = {
  /** 来源记录是否已删除／下架／撤回 */
  withdrawn: boolean;
  /** 当前版本是否可核验（草稿版本 0 之类不可核验的版本不算） */
  versionTrusted: boolean;
  /** 当前业务版本；不可核验时为 null */
  currentVersion: number | null;
  /** 稳定身份是否已持久化（派生值不算：派生键仅设备内唯一） */
  identityPersisted: boolean;
  /** 原账号授权状态 */
  authorizationStatus: BusinessSyncAuthorizationStatus;
};

/** 拒绝原因码（受控枚举；不携带正文、快照与凭据） */
export const BUSINESS_SYNC_SOURCE_REJECTION = {
  /** 来源记录已删除／下架／撤回 */
  WITHDRAWN: 'WITHDRAWN',
  /** 当前版本不可核验 */
  VERSION_UNTRUSTED: 'VERSION_UNTRUSTED',
  /** 跨端稳定身份未持久化 */
  IDENTITY_UNTRUSTED: 'IDENTITY_UNTRUSTED',
  /** 原账号授权已撤销 */
  AUTHORIZATION_INVALID: 'AUTHORIZATION_INVALID',
  /** 原账号授权未登记（未取得该事实，按失败关闭处理） */
  AUTHORIZATION_UNKNOWN: 'AUTHORIZATION_UNKNOWN',
} as const;

export type BusinessSyncSourceRejection =
  (typeof BUSINESS_SYNC_SOURCE_REJECTION)[keyof typeof BUSINESS_SYNC_SOURCE_REJECTION];

/** 准入裁决结果 */
export type BusinessSyncSourceEligibility = {
  /** 是否允许生成待传任务 */
  eligible: boolean;
  /** 拒绝原因码；准入通过时为 null */
  rejection: BusinessSyncSourceRejection | null;
  /** 通过时给出准入版本（与当前业务版本一致） */
  version: number | null;
};

/**
 * 准入裁决（纯函数）。
 *
 * 顺序固定：先排除"根本不该产生任务"的材料级事实，再排除身份与授权事实。
 * 任何一项不成立都**不生成任务**——生成"注定失败"的任务会污染待办与统计口径。
 */
export function resolveBusinessSyncSourceEligibility(
  facts: BusinessSyncSourceEligibilityFacts,
): BusinessSyncSourceEligibility {
  if (facts.withdrawn) {
    return reject(BUSINESS_SYNC_SOURCE_REJECTION.WITHDRAWN);
  }
  if (!facts.versionTrusted || facts.currentVersion === null || facts.currentVersion < 1) {
    return reject(BUSINESS_SYNC_SOURCE_REJECTION.VERSION_UNTRUSTED);
  }
  if (!facts.identityPersisted) {
    return reject(BUSINESS_SYNC_SOURCE_REJECTION.IDENTITY_UNTRUSTED);
  }
  if (facts.authorizationStatus === 'REVOKED') {
    return reject(BUSINESS_SYNC_SOURCE_REJECTION.AUTHORIZATION_INVALID);
  }
  if (facts.authorizationStatus !== 'ACTIVE') {
    return reject(BUSINESS_SYNC_SOURCE_REJECTION.AUTHORIZATION_UNKNOWN);
  }
  return { eligible: true, rejection: null, version: facts.currentVersion };
}

function reject(rejection: BusinessSyncSourceRejection): BusinessSyncSourceEligibility {
  return { eligible: false, rejection, version: null };
}

/**
 * 来源类型的本地命名空间。
 *
 * `local_upload_task` 的实体唯一键是（安装, 实体类型, 本地实体 ID, 实体版本），
 * 而三种来源记录分属三张表——各自的本地自增 ID 会重复（资料的 5 号与工单的 5 号）。
 * 直接用来源行号会让不同来源撞进同一条任务，因此把（来源类型, 行号）压成一个
 * 唯一的本地实体 ID：命名空间 × 步长 + 行号（步长 10 亿，int unsigned 上限内）。
 */
export const BUSINESS_SYNC_RESOURCE_TYPE_NAMESPACE: Readonly<Record<string, number>> = {
  REFERENCE_DOCUMENT: 1,
  REPAIR_REQUEST: 2,
  MAINTENANCE_REPORT: 3,
};

/** 命名空间步长：必须大于任何单表的自增 ID 上限 */
const RESOURCE_TYPE_NAMESPACE_STRIDE = 1_000_000_000;

/** 把（来源类型, 本地行号）组合成唯一的本地实体 ID */
export function composeBusinessSyncEntityLocalId(resourceType: string, recordId: number): number {
  const namespace = BUSINESS_SYNC_RESOURCE_TYPE_NAMESPACE[resourceType];
  if (namespace === undefined) {
    throw new DomainError(
      BUSINESS_SYNC_ERROR.INVALID_PARAMS,
      '来源资源类型不在业务同步支持清单内',
      { resourceType },
    );
  }
  if (!Number.isInteger(recordId) || recordId <= 0) {
    throw new DomainError(BUSINESS_SYNC_ERROR.INVALID_PARAMS, '来源记录 ID 必须为正整数', {
      recordId,
    });
  }
  return namespace * RESOURCE_TYPE_NAMESPACE_STRIDE + recordId;
}

/** 还原本地实体 ID 对应的（来源类型, 本地行号）；无法还原时返回 null */
export function parseBusinessSyncEntityLocalId(entityLocalId: number): {
  resourceType: string;
  recordId: number;
} | null {
  if (!Number.isInteger(entityLocalId) || entityLocalId <= 0) {
    return null;
  }
  const namespace = Math.floor(entityLocalId / RESOURCE_TYPE_NAMESPACE_STRIDE);
  const recordId = entityLocalId % RESOURCE_TYPE_NAMESPACE_STRIDE;
  for (const [resourceType, value] of Object.entries(BUSINESS_SYNC_RESOURCE_TYPE_NAMESPACE)) {
    if (value === namespace && recordId > 0) {
      return { resourceType, recordId };
    }
  }
  return null;
}

/** 幂等键：同一（稳定键, 版本）在任意设备上得到同一键，重复提交只登记一次 */
export function buildBusinessSyncIdempotencyKey(recordUuid: string, versionNo: number): string {
  return `business-sync:${recordUuid}:${versionNo}`;
}
