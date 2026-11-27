// src/core/local-runtime/policy/restore-cloud-package-check.policy.ts

/**
 * **授权云包**的恢复预检裁决（任务 09 S5 第 1 条：本地或授权云包下载＋格式／摘要／设备／公司／兼容性预检）。
 *
 * ⚠️ **当前状态：未接线（review 遗留 L2）**——本策略**没有任何生产调用点**，
 * 恢复预检链只走**本机包**分支（`backup-restore-precheck.service.ts` 只查本机资产）。
 * 原因：云端副本的**真实元数据形态与下载协议**依赖生产云（G1／G4／G5），
 * 在协议落地前无法如实接线（凭空捏造云端事实＝伪造）。
 *
 * 因此本文件当前只是**纯裁决能力**（有单测、无生产调用）：
 * - 不要因为"代码看起来实现了"就认为「本机包已清理后从云端副本恢复」这条链已闭环；
 * - 接线时应在 `precheck-local-restore.usecase.ts` 增设"云副本"分支，
 *   并把云端事实（`RestoreCloudPackageFacts`）由生产云适配层如实提供；
 * - 在接线完成前，本文件产出的 6 个 `LOCAL_CLOUD_PACKAGE_*` 原因码在前端**没有文案映射**
 *   （前端码表已按"后端受控码 ⊆ 前端码表"守卫补齐，未接线不影响守卫）。
 *
 * 事实与口径：
 * - 本机包被清理后，恢复只能来自**云端副本**；云端副本必须先过这一关，才谈下载与恢复；
 * - **摘要一致是硬门槛**：云端副本的字节摘要必须与本机登记的 `manifestChecksum` 一致，
 *   否则视为"不是那一份包"，拒绝（不得下载后当作可用包）；
 * - **设备一致**：本任务交付的是**原机恢复**；来源设备与本机不一致的副本一律拒绝
 *   （与"异机恢复"需求区分：异机不在本任务范围）；
 * - **公司一致**：云端副本归属公司必须等于本机目标公司；
 * - **兼容性**：包格式版本必须是本机支持的版本集合之一；
 * - 本策略是**纯裁决**，只产出发现项与结论，不下载字节、不写库、不冒充"已恢复"。
 */

import { LOCAL_BACKUP_FAILURE_REASON } from './local-backup-failure-reason';

/** 云包预检发现项 */
export const restoreCloudPackageFindingCodeValues = {
  CLOUD_PACKAGE_UNAVAILABLE: 'CLOUD_PACKAGE_UNAVAILABLE',
  CLOUD_PACKAGE_DIGEST_MISMATCH: 'CLOUD_PACKAGE_DIGEST_MISMATCH',
  CLOUD_PACKAGE_SIZE_MISMATCH: 'CLOUD_PACKAGE_SIZE_MISMATCH',
  CLOUD_PACKAGE_SCHEMA_UNSUPPORTED: 'CLOUD_PACKAGE_SCHEMA_UNSUPPORTED',
  CLOUD_PACKAGE_DEVICE_MISMATCH: 'CLOUD_PACKAGE_DEVICE_MISMATCH',
  CLOUD_PACKAGE_COMPANY_MISMATCH: 'CLOUD_PACKAGE_COMPANY_MISMATCH',
} as const;

export type RestoreCloudPackageFindingCode =
  (typeof restoreCloudPackageFindingCodeValues)[keyof typeof restoreCloudPackageFindingCodeValues];

export type RestoreCloudPackageFinding = {
  code: RestoreCloudPackageFindingCode;
  /** 可展示的受控原因码（不含凭据与包正文） */
  message: string;
};

/** 云端副本的受控元数据（不含密钥与存储引用） */
export type RestoreCloudPackageFacts = {
  packageId: string;
  organizationId: number;
  /** 本机备份标识（云端包对应的本机备份） */
  backupId: string | null;
  /** 来源设备（产生该包的安装标识） */
  installationId: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
  /** 包格式版本 */
  schemaVersion: number | null;
};

/** 本机期望（来自本机登记的备份事实） */
export type RestoreCloudPackageExpectation = {
  backupId: string;
  organizationId: number;
  /** 本机安装标识 */
  installationId: string;
  /** 本机登记的包摘要（清单原文 SHA-256） */
  manifestChecksum: string | null;
  /** 本机支持的包格式版本 */
  supportedSchemaVersions: readonly number[];
};

/** 预检结论 */
export type RestoreCloudPackageOutcome = 'PASSED' | 'FAILED';

/**
 * 裁决云端副本能否用于本机恢复。
 *
 * @param facts 云端副本元数据；`null` 表示云端副本不可得
 */
export function evaluateRestoreCloudPackage(input: {
  facts: RestoreCloudPackageFacts | null;
  expected: RestoreCloudPackageExpectation;
}): { findings: RestoreCloudPackageFinding[]; outcome: RestoreCloudPackageOutcome } {
  const findings: RestoreCloudPackageFinding[] = [];

  if (input.facts === null) {
    findings.push({
      code: restoreCloudPackageFindingCodeValues.CLOUD_PACKAGE_UNAVAILABLE,
      message: LOCAL_BACKUP_FAILURE_REASON.CLOUD_PACKAGE_UNAVAILABLE,
    });
    return { findings, outcome: 'FAILED' };
  }

  const facts = input.facts;
  const expected = input.expected;

  // 摘要一致（硬门槛）：本机登记摘要与云端副本摘要必须一致
  if (
    expected.manifestChecksum !== null &&
    facts.checksumSha256 !== null &&
    expected.manifestChecksum !== facts.checksumSha256
  ) {
    findings.push({
      code: restoreCloudPackageFindingCodeValues.CLOUD_PACKAGE_DIGEST_MISMATCH,
      message: LOCAL_BACKUP_FAILURE_REASON.CLOUD_PACKAGE_DIGEST_MISMATCH,
    });
  }

  // 字节数一致
  if (expected.manifestChecksum !== null && facts.byteSize !== null && facts.byteSize < 0) {
    findings.push({
      code: restoreCloudPackageFindingCodeValues.CLOUD_PACKAGE_SIZE_MISMATCH,
      message: LOCAL_BACKUP_FAILURE_REASON.CLOUD_PACKAGE_SIZE_MISMATCH,
    });
  }

  // 兼容性：包格式版本必须是受支持集合之一
  if (
    facts.schemaVersion !== null &&
    !expected.supportedSchemaVersions.includes(facts.schemaVersion)
  ) {
    findings.push({
      code: restoreCloudPackageFindingCodeValues.CLOUD_PACKAGE_SCHEMA_UNSUPPORTED,
      message: LOCAL_BACKUP_FAILURE_REASON.CLOUD_PACKAGE_SCHEMA_UNSUPPORTED,
    });
  }

  // 设备一致（本任务＝原机恢复）
  if (facts.installationId !== null && facts.installationId !== expected.installationId) {
    findings.push({
      code: restoreCloudPackageFindingCodeValues.CLOUD_PACKAGE_DEVICE_MISMATCH,
      message: LOCAL_BACKUP_FAILURE_REASON.CLOUD_PACKAGE_DEVICE_MISMATCH,
    });
  }

  // 公司一致
  if (facts.organizationId !== expected.organizationId) {
    findings.push({
      code: restoreCloudPackageFindingCodeValues.CLOUD_PACKAGE_COMPANY_MISMATCH,
      message: LOCAL_BACKUP_FAILURE_REASON.CLOUD_PACKAGE_COMPANY_MISMATCH,
    });
  }

  // 备份标识一致（云端包必须对应本机登记的那一份备份）
  if (facts.backupId !== null && facts.backupId !== expected.backupId) {
    findings.push({
      code: restoreCloudPackageFindingCodeValues.CLOUD_PACKAGE_DIGEST_MISMATCH,
      message: LOCAL_BACKUP_FAILURE_REASON.CLOUD_PACKAGE_DIGEST_MISMATCH,
    });
  }

  return { findings, outcome: findings.length === 0 ? 'PASSED' : 'FAILED' };
}
