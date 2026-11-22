// src/core/local-runtime/policy/restore-precheck.policy.ts
// 恢复预检契约（任务 09 S4）：目标核对、包完整性校验与保护副本绑定。
//
// 事实口径（R085-01／02、R086）：
// - 预检只读业务数据，不覆盖任何业务表；它只写"恢复预检事实"（backup_restore_run）；
// - 预检结论必须区分「通过」「失败」，失败必须带可展示原因；
// - 保护副本是执行前的当前范围快照，其备份资产 ID 记录在预检快照内；
// - 异设备、异公司、损坏包、无权限一律拒绝，不产出"看起来可用"的预检结论。

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';

import { LOCAL_BACKUP_FAILURE_REASON } from './local-backup-failure-reason';

/** 恢复预检快照结构版本（与数据库 CHECK `chk_backup_restore_run_schema` 的 $.schema_version 同源） */
export const RESTORE_CHECK_SNAPSHOT_SCHEMA_VERSION = 1;

/** 预检发现项的结论 */
export const restoreCheckFindingCodeValues = {
  PACKAGE_UNREADABLE: 'PACKAGE_UNREADABLE',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  FILE_MISSING: 'FILE_MISSING',
  FILE_CHECKSUM_MISMATCH: 'FILE_CHECKSUM_MISMATCH',
  TARGET_INSTALLATION_MISMATCH: 'TARGET_INSTALLATION_MISMATCH',
  TARGET_ORGANIZATION_MISMATCH: 'TARGET_ORGANIZATION_MISMATCH',
  LOCAL_PACKAGE_MISSING: 'LOCAL_PACKAGE_MISSING',
  PROTECTION_COPY_FAILED: 'PROTECTION_COPY_FAILED',
} as const;

export type RestoreCheckFindingCode =
  (typeof restoreCheckFindingCodeValues)[keyof typeof restoreCheckFindingCodeValues];

export type RestoreCheckFinding = {
  code: RestoreCheckFindingCode;
  /** 可展示的原因（不含凭据与包正文） */
  message: string;
};

export type RestoreCheckTarget = {
  backupId: string;
  organizationId: number;
  /** 产生该备份的安装标识 */
  installationId: string | null;
  manifestChecksum: string | null;
};

export type RestoreCheckPackage = {
  readable: boolean;
  fileCount: number | null;
  originalCount: number | null;
  /** 已核对的文件数 */
  verifiedFileCount: number;
};

export type RestoreCheckProtection = {
  /** 保护副本的备份资产 ID；未生成时为 null */
  backupId: string | null;
  created: boolean;
};

export type RestoreCheckSnapshot = {
  schema_version: number;
  checked_at: string;
  target: RestoreCheckTarget;
  package: RestoreCheckPackage;
  protection: RestoreCheckProtection;
  findings: RestoreCheckFinding[];
};

/** 恢复预检结论 */
export type RestoreCheckOutcome = 'PASSED' | 'FAILED';

/**
 * 恢复执行入口当前不可用的原因（如实声明，页面据此呈现状态）。
 *
 * 缺的是写入/同步闸门与失败回滚补偿能力：没有闸门就无法在恢复期间冻结
 * 目标公司数据区的写入与同步，没有补偿就无法保证失败时回到保护副本。
 * 该结构缺口（P2 `local_write_hold`）落地前不开放执行入口。
 */
export const RESTORE_EXECUTION_UNAVAILABLE_REASON =
  '当前环境未落地恢复期的写入/同步闸门与失败回滚补偿，恢复执行入口保持不可用；可先完成预检与保护副本。';

function invalid(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError(LOCAL_RUNTIME_ERROR.INVALID_PARAMS, message, details);
}

/** 组装预检快照并做结构自校验（落库前保证 $.schema_version 存在且非空） */
export function buildRestoreCheckSnapshot(input: {
  checkedAt: Date;
  target: RestoreCheckTarget;
  package: RestoreCheckPackage;
  protection: RestoreCheckProtection;
  findings: RestoreCheckFinding[];
}): RestoreCheckSnapshot {
  const snapshot: RestoreCheckSnapshot = {
    schema_version: RESTORE_CHECK_SNAPSHOT_SCHEMA_VERSION,
    checked_at: input.checkedAt.toISOString(),
    target: input.target,
    package: input.package,
    protection: input.protection,
    findings: input.findings,
  };
  parseRestoreCheckSnapshot(snapshot);
  return snapshot;
}

/** 预检快照结构校验：结构版本、目标、包事实与发现项必须齐备 */
export function parseRestoreCheckSnapshot(value: unknown): RestoreCheckSnapshot {
  const snapshot = value as RestoreCheckSnapshot | null;
  if (snapshot === null || typeof snapshot !== 'object') {
    throw invalid('恢复预检快照必须是 JSON 对象');
  }
  if (snapshot.schema_version !== RESTORE_CHECK_SNAPSHOT_SCHEMA_VERSION) {
    throw invalid('恢复预检快照结构版本不符', { schema_version: snapshot.schema_version });
  }
  if (typeof snapshot.checked_at !== 'string' || snapshot.checked_at.length === 0) {
    throw invalid('恢复预检快照缺少核对时间');
  }
  if (
    snapshot.target === null ||
    typeof snapshot.target !== 'object' ||
    typeof snapshot.target.backupId !== 'string' ||
    !Number.isInteger(snapshot.target.organizationId)
  ) {
    throw invalid('恢复预检快照缺少目标事实');
  }
  if (snapshot.package === null || typeof snapshot.package !== 'object') {
    throw invalid('恢复预检快照缺少包事实');
  }
  if (snapshot.protection === null || typeof snapshot.protection !== 'object') {
    throw invalid('恢复预检快照缺少保护副本事实');
  }
  if (!Array.isArray(snapshot.findings)) {
    throw invalid('恢复预检快照缺少发现项');
  }
  return snapshot;
}

/** 预检结论：存在任何发现项即失败；无发现项才通过 */
export function resolveRestoreCheckOutcome(findings: RestoreCheckFinding[]): RestoreCheckOutcome {
  return findings.length === 0 ? 'PASSED' : 'FAILED';
}

/**
 * 目标一致性裁决：恢复只允许原设备同公司。
 *
 * - 安装标识不一致 → 异设备拒绝；
 * - 公司不一致 → 异公司拒绝；
 * - 本机包已不存在（如已清理）→ 明确标记，不再假装可恢复。
 */
export function evaluateRestoreTarget(input: {
  targetInstallationId: string | null;
  currentInstallationId: string;
  targetOrganizationId: number;
  allowedOrganizationId: number | null;
  localPackageRetained: boolean;
}): RestoreCheckFinding[] {
  const findings: RestoreCheckFinding[] = [];

  if (
    input.targetInstallationId !== null &&
    input.targetInstallationId !== input.currentInstallationId
  ) {
    findings.push({
      code: restoreCheckFindingCodeValues.TARGET_INSTALLATION_MISMATCH,
      message: LOCAL_BACKUP_FAILURE_REASON.RESTORE_TARGET_INSTALLATION_MISMATCH,
    });
  }

  if (
    input.allowedOrganizationId !== null &&
    input.targetOrganizationId !== input.allowedOrganizationId
  ) {
    findings.push({
      code: restoreCheckFindingCodeValues.TARGET_ORGANIZATION_MISMATCH,
      message: LOCAL_BACKUP_FAILURE_REASON.RESTORE_TARGET_ORGANIZATION_MISMATCH,
    });
  }

  if (!input.localPackageRetained) {
    findings.push({
      code: restoreCheckFindingCodeValues.LOCAL_PACKAGE_MISSING,
      message: LOCAL_BACKUP_FAILURE_REASON.RESTORE_LOCAL_PACKAGE_MISSING,
    });
  }

  return findings;
}
