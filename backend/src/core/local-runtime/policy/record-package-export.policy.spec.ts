// src/core/local-runtime/policy/record-package-export.policy.spec.ts

import {
  assertExportOrganizationAllowed,
  assertExportTargetDirectory,
  buildExportManifest,
  deriveRecordUuid,
  newRecordPackageId,
  normalizeExportEntries,
  normalizeExportRecordIds,
  sanitizePackageFileName,
  EXPORT_RECORD_IDS_MAX,
} from './record-package-export.policy';
import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';

describe('record package export policy', () => {
  describe('deriveRecordUuid（确定性身份派生）', () => {
    it('同一 (resourceType, recordId) 派生同一 UUID（幂等）', () => {
      const first = deriveRecordUuid('REFERENCE_DOCUMENT', 42);
      const second = deriveRecordUuid('REFERENCE_DOCUMENT', 42);
      expect(first).toBe(second);
    });

    it('不同资源类型或记录 ID 派生不同 UUID', () => {
      expect(deriveRecordUuid('REFERENCE_DOCUMENT', 1)).not.toBe(
        deriveRecordUuid('REPAIR_REQUEST', 1),
      );
      expect(deriveRecordUuid('REFERENCE_DOCUMENT', 1)).not.toBe(
        deriveRecordUuid('REFERENCE_DOCUMENT', 2),
      );
    });

    it('派生结果为合法 UUID v5 形态', () => {
      const uuid = deriveRecordUuid('MAINTENANCE_REPORT', 7);
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe('normalizeExportRecordIds', () => {
    it('去重并升序归一', () => {
      expect(normalizeExportRecordIds([9, 3, 9, 1])).toEqual([1, 3, 9]);
    });

    it('空清单拒绝', () => {
      expect(() => normalizeExportRecordIds([])).toThrow(
        new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '导出记录 ID 清单不能为空'),
      );
    });

    it('非正整数拒绝', () => {
      expect(() => normalizeExportRecordIds([0])).toThrow();
      expect(() => normalizeExportRecordIds([1.5])).toThrow();
      expect(() => normalizeExportRecordIds([-2])).toThrow();
    });

    it('超过单次上限拒绝', () => {
      const ids = Array.from({ length: EXPORT_RECORD_IDS_MAX + 1 }, (_, i) => i + 1);
      expect(() => normalizeExportRecordIds(ids)).toThrow();
    });
  });

  describe('assertExportOrganizationAllowed', () => {
    it('一级管理员（null 范围）可导出任意公司', () => {
      expect(() => assertExportOrganizationAllowed(null, 4)).not.toThrow();
      expect(() => assertExportOrganizationAllowed(null, 5)).not.toThrow();
    });

    it('非一级只能导出本公司数据区，越权拒绝', () => {
      expect(() => assertExportOrganizationAllowed(4, 4)).not.toThrow();
      expect(() => assertExportOrganizationAllowed(4, 5)).toThrow(
        new DomainError(RECORD_PACKAGE_ERROR.FOREIGN_COMPANY, '只能导出本公司数据区的记录'),
      );
    });
  });

  describe('assertExportTargetDirectory', () => {
    it('本机绝对路径放行', () => {
      expect(() => assertExportTargetDirectory('/mnt/usb/export-001')).not.toThrow();
    });

    it('空串与相对路径拒绝', () => {
      expect(() => assertExportTargetDirectory('')).toThrow();
      expect(() => assertExportTargetDirectory('relative/dir')).toThrow();
    });
  });

  describe('sanitizePackageFileName', () => {
    it('保留合法字符并剔除路径成分', () => {
      expect(sanitizePackageFileName('../../etc/passwd')).toBe('passwd');
      expect(sanitizePackageFileName('设备 文档#1.pdf')).toBe('______1.pdf');
    });

    it('空或纯点文件名收敛为兜底名', () => {
      expect(sanitizePackageFileName('')).toBe('file.bin');
      expect(sanitizePackageFileName('..')).toBe('_');
    });
  });

  describe('buildExportManifest（导出产物自校验）', () => {
    const baseItem = {
      recordUuid: deriveRecordUuid('REFERENCE_DOCUMENT', 1),
      resourceType: 'REFERENCE_DOCUMENT' as const,
      versionNo: 2,
      contentSnapshot: { schema_version: 1, title: '资料A' },
      files: [{ relative_path: 'files/e1000000/doc.txt', sha256: 'a'.repeat(64), byte_size: 3 }],
      // 来源事实（S3 补丁 P0/P4）：原作者、归属公司与业务状态随条目入包
      sourceAccountId: 900101,
      sourceAccountUuid: null,
      sourceAccountLoginName: null,
      sourceAccountName: null,
      ownerOrganizationId: 4,
      relatedRecordUuid: null,
      relatedRecordType: null,
      sourceStatus: 'SUBMITTED',
      sourceEquipmentModelCode: null,
    };

    it('产出通过导入侧同一结构校验的清单', () => {
      const manifest = buildExportManifest({
        organizationId: 4,
        organizationCode: 'ORG-4',
        installationId: 'f5e4007d-e354-11f1-897b-345a604caa06',
        generatedAt: new Date('2026-11-19T00:00:00.000Z'),
        items: [baseItem],
      });
      expect(manifest.schema_version).toBe(1);
      expect(manifest.organization_id).toBe(4);
      expect(manifest.items).toHaveLength(1);
      expect(manifest.package_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('package_id 每次导出独立生成', () => {
      const a = buildExportManifest({
        organizationId: 4,
        organizationCode: 'ORG-4',
        installationId: 'i',
        generatedAt: new Date(),
        items: [baseItem],
      });
      const b = buildExportManifest({
        organizationId: 4,
        organizationCode: 'ORG-4',
        installationId: 'i',
        generatedAt: new Date(),
        items: [baseItem],
      });
      expect(a.package_id).not.toBe(b.package_id);
      expect(newRecordPackageId()).not.toBe(newRecordPackageId());
    });

    it('空条目清单拒绝（不产出空包）', () => {
      expect(() =>
        buildExportManifest({
          organizationId: 4,
          organizationCode: 'ORG-4',
          installationId: 'i',
          generatedAt: new Date(),
          items: [],
        }),
      ).toThrow();
    });

    it('条目含不安全文件路径时自校验拦截（落盘前失败）', () => {
      expect(() =>
        buildExportManifest({
          organizationId: 4,
          organizationCode: 'ORG-4',
          installationId: 'i',
          generatedAt: new Date(),
          items: [
            {
              ...baseItem,
              files: [{ relative_path: '../escaped.txt', sha256: 'a'.repeat(64), byte_size: 3 }],
            },
          ],
        }),
      ).toThrow();
    });
  });
});

describe('normalizeExportEntries（混合形态导出条目归一）', () => {
  /** DomainError 的 code 不进 message：统一用 try/catch 断言错误码 */
  function expectPolicyError(action: () => void, code: string): void {
    try {
      action();
      throw new Error('预期抛错但未抛');
    } catch (error) {
      expect((error as DomainError).code).toBe(code);
    }
  }

  it('空条目清单拒绝', () => {
    expectPolicyError(() => normalizeExportEntries([]), RECORD_PACKAGE_ERROR.INVALID_PARAMS);
  });

  it('资源类型不在白名单时拒绝', () => {
    expectPolicyError(
      () => normalizeExportEntries([{ resourceType: 'NOT_A_TYPE', recordId: 1 }]),
      RECORD_PACKAGE_ERROR.INVALID_PARAMS,
    );
  });

  it('记录 ID 非正整数时拒绝', () => {
    for (const recordId of [0, -1, 1.5]) {
      expectPolicyError(
        () => normalizeExportEntries([{ resourceType: 'REPAIR_REQUEST', recordId }]),
        RECORD_PACKAGE_ERROR.INVALID_PARAMS,
      );
    }
  });

  it('按（资源类型＋记录 ID）去重：同类型同记录只保留一条，不同类型可共用同一 ID', () => {
    const result = normalizeExportEntries([
      { resourceType: 'REPAIR_REQUEST', recordId: 7 },
      { resourceType: 'REPAIR_REQUEST', recordId: 7 },
      { resourceType: 'MAINTENANCE_REPORT', recordId: 7 },
    ]);
    expect(result).toEqual([
      { resourceType: 'REPAIR_REQUEST', recordId: 7 },
      { resourceType: 'MAINTENANCE_REPORT', recordId: 7 },
    ]);
  });

  it('超过单次导出条数上限时拒绝（与旧单一类型形态同一闸门）', () => {
    const entries = Array.from({ length: EXPORT_RECORD_IDS_MAX + 1 }, (_item, index) => ({
      resourceType: 'REPAIR_REQUEST' as const,
      recordId: index + 1,
    }));
    expectPolicyError(() => normalizeExportEntries(entries), RECORD_PACKAGE_ERROR.INVALID_PARAMS);
  });
});
