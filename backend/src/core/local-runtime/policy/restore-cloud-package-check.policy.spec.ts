// src/core/local-runtime/policy/restore-cloud-package-check.policy.spec.ts
/// <reference types="jest" />

/**
 * 授权云包恢复预检的定向测试（任务 09 S5 第 1 条）。
 *
 * 守住：云端副本必须"是那一份包"（摘要一致）、来自本机设备、属于目标公司、
 * 格式版本受支持；任一不满足即 FAILED，**不产出"看起来可用"的结论**。
 */

import {
  evaluateRestoreCloudPackage,
  type RestoreCloudPackageFacts,
} from './restore-cloud-package-check.policy';

const EXPECTED = {
  backupId: 'backup-1',
  organizationId: 9,
  installationId: 'inst-1',
  manifestChecksum: 'a'.repeat(64),
  supportedSchemaVersions: [1],
};

function facts(overrides: Partial<RestoreCloudPackageFacts> = {}): RestoreCloudPackageFacts {
  return {
    packageId: 'cloud-pkg-1',
    organizationId: 9,
    backupId: 'backup-1',
    installationId: 'inst-1',
    byteSize: 1024,
    checksumSha256: 'a'.repeat(64),
    schemaVersion: 1,
    ...overrides,
  };
}

describe('授权云包恢复预检裁决（S5-1）', () => {
  it('完全一致 → 通过', () => {
    const result = evaluateRestoreCloudPackage({ facts: facts(), expected: EXPECTED });
    expect(result.outcome).toBe('PASSED');
    expect(result.findings).toHaveLength(0);
  });

  it('云端副本不可得 → 失败并给出受控原因', () => {
    const result = evaluateRestoreCloudPackage({ facts: null, expected: EXPECTED });
    expect(result.outcome).toBe('FAILED');
    expect(result.findings[0].code).toBe('CLOUD_PACKAGE_UNAVAILABLE');
    expect(result.findings[0].message).toBe('LOCAL_CLOUD_PACKAGE_UNAVAILABLE');
  });

  it('摘要不一致 → 拒绝（不是那一份包）', () => {
    const result = evaluateRestoreCloudPackage({
      facts: facts({ checksumSha256: 'b'.repeat(64) }),
      expected: EXPECTED,
    });
    expect(result.outcome).toBe('FAILED');
    expect(result.findings.map((f) => f.code)).toContain('CLOUD_PACKAGE_DIGEST_MISMATCH');
  });

  it('对应不上本机登记的备份标识 → 拒绝', () => {
    const result = evaluateRestoreCloudPackage({
      facts: facts({ backupId: 'backup-other' }),
      expected: EXPECTED,
    });
    expect(result.outcome).toBe('FAILED');
  });

  it('来源设备不是本机 → 拒绝（本任务是原机恢复）', () => {
    const result = evaluateRestoreCloudPackage({
      facts: facts({ installationId: 'inst-other' }),
      expected: EXPECTED,
    });
    expect(result.outcome).toBe('FAILED');
    expect(result.findings.map((f) => f.code)).toContain('CLOUD_PACKAGE_DEVICE_MISMATCH');
  });

  it('归属公司不是目标公司 → 拒绝', () => {
    const result = evaluateRestoreCloudPackage({
      facts: facts({ organizationId: 10 }),
      expected: EXPECTED,
    });
    expect(result.outcome).toBe('FAILED');
    expect(result.findings.map((f) => f.code)).toContain('CLOUD_PACKAGE_COMPANY_MISMATCH');
  });

  it('包格式版本不受支持 → 拒绝（兼容性）', () => {
    const result = evaluateRestoreCloudPackage({
      facts: facts({ schemaVersion: 99 }),
      expected: EXPECTED,
    });
    expect(result.outcome).toBe('FAILED');
    expect(result.findings.map((f) => f.code)).toContain('CLOUD_PACKAGE_SCHEMA_UNSUPPORTED');
  });

  it('云端未提供摘要／版本等事实 → 不臆断，按缺失放行由上层决定（不产生假失败项）', () => {
    const result = evaluateRestoreCloudPackage({
      facts: facts({ checksumSha256: null, schemaVersion: null, installationId: null }),
      expected: EXPECTED,
    });
    expect(result.outcome).toBe('PASSED');
    expect(result.findings).toHaveLength(0);
  });
});
