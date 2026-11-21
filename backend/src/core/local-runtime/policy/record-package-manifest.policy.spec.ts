// src/core/local-runtime/policy/record-package-manifest.policy.spec.ts

import { RECORD_PACKAGE_ERROR, SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  assertManifestSnapshotHasNoSecretMaterial,
  assertPackageCompanyAllowed,
  isSafePackageRelativePath,
  parseRecordPackageManifest,
  resolvePackageFilePath,
} from './record-package-manifest.policy';

/** R070/R071：包清单是生成与检查共用契约；结构问题在进入文件系统前拒绝 */
describe('record package manifest policy', () => {
  const validManifest = {
    schema_version: 1,
    package_id: 'b1000000-0000-0000-0000-000000000001',
    organization_id: 4,
    installation_id: 'f5e4007d-e354-11f1-897b-345a604caa06',
    generated_at: '2026-11-19T00:00:00.000Z',
    items: [
      {
        record_uuid: 'c1000000-0000-0000-0000-000000000001',
        resource_type: 'REFERENCE_DOCUMENT',
        version_no: 2,
        content_snapshot: { title: '资料A', schema_version: 1 },
        files: [{ relative_path: 'files/c1/doc.pdf', sha256: 'a'.repeat(64), byte_size: 10 }],
      },
    ],
  };

  const expectCode = (action: () => void, code: string): void => {
    expect(action).toThrow(DomainError);
    try {
      action();
    } catch (error) {
      expect((error as DomainError).code).toBe(code);
    }
  };

  it('合法清单通过解析并归一', () => {
    const manifest = parseRecordPackageManifest(JSON.stringify(validManifest));
    expect(manifest.package_id).toBe(validManifest.package_id);
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]?.files[0]?.relative_path).toBe('files/c1/doc.pdf');
  });

  it('非 JSON／非对象／schema_version 不符拒绝', () => {
    expectCode(() => parseRecordPackageManifest('not-json'), RECORD_PACKAGE_ERROR.INVALID_MANIFEST);
    expectCode(() => parseRecordPackageManifest('[]'), RECORD_PACKAGE_ERROR.INVALID_MANIFEST);
    expectCode(
      () => parseRecordPackageManifest(JSON.stringify({ ...validManifest, schema_version: 2 })),
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
    );
  });

  it('package_id／organization_id／installation_id 非法拒绝', () => {
    expectCode(
      () => parseRecordPackageManifest(JSON.stringify({ ...validManifest, package_id: 'nope' })),
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
    );
    expectCode(
      () => parseRecordPackageManifest(JSON.stringify({ ...validManifest, organization_id: 0 })),
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
    );
    expectCode(
      () => parseRecordPackageManifest(JSON.stringify({ ...validManifest, installation_id: '' })),
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
    );
  });

  it('items 为空或资源类型不在清单内拒绝', () => {
    expectCode(
      () => parseRecordPackageManifest(JSON.stringify({ ...validManifest, items: [] })),
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
    );
    const item = { ...validManifest.items[0], resource_type: 'ANYTHING_ELSE' };
    expectCode(
      () => parseRecordPackageManifest(JSON.stringify({ ...validManifest, items: [item] })),
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
    );
  });

  it('路径穿越／绝对路径／反斜杠／盘符一律拒绝', () => {
    const escape = (relativePath: string) =>
      parseRecordPackageManifest(
        JSON.stringify({
          ...validManifest,
          items: [
            {
              ...validManifest.items[0],
              files: [{ relativePath, sha256: 'a'.repeat(64), byte_size: 1 }],
            },
          ],
        }),
      );
    expectCode(() => escape('../outside.pdf'), RECORD_PACKAGE_ERROR.PATH_ESCAPED);
    expectCode(() => escape('/etc/passwd'), RECORD_PACKAGE_ERROR.PATH_ESCAPED);
    expectCode(() => escape('a\\b.pdf'), RECORD_PACKAGE_ERROR.PATH_ESCAPED);
    expectCode(() => escape('C:/tmp/a.pdf'), RECORD_PACKAGE_ERROR.PATH_ESCAPED);
    expect(isSafePackageRelativePath('files/x/../y')).toBe(false);
    expect(isSafePackageRelativePath('files/x/y.pdf')).toBe(true);
  });

  it('sha256 形态与 byte_size 非法拒绝', () => {
    const item = {
      ...validManifest.items[0],
      files: [{ relative_path: 'f/x', sha256: 'zz', byte_size: -1 }],
    };
    expectCode(
      () => parseRecordPackageManifest(JSON.stringify({ ...validManifest, items: [item] })),
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
    );
  });

  it('resolvePackageFilePath 双保险：逃逸段拒绝、合法段落在包内', () => {
    expectCode(() => resolvePackageFilePath('/tmp/pkg', '../x'), RECORD_PACKAGE_ERROR.PATH_ESCAPED);
    expect(resolvePackageFilePath('/tmp/pkg', 'files/a.pdf')).toBe('/tmp/pkg/files/a.pdf');
  });

  it('错公司拒绝；一级管理员全局放行；同公司放行', () => {
    expectCode(() => assertPackageCompanyAllowed(5, 4), RECORD_PACKAGE_ERROR.FOREIGN_COMPANY);
    expect(() => assertPackageCompanyAllowed(null, 4)).not.toThrow();
    expect(() => assertPackageCompanyAllowed(4, 4)).not.toThrow();
  });

  it('包内容含敏感材料键拒绝（复用 R067 键规则）', () => {
    expectCode(
      () => assertManifestSnapshotHasNoSecretMaterial({ meta: { password: 'x' } }),
      SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
    );
    expect(() => assertManifestSnapshotHasNoSecretMaterial({ title: '资料' })).not.toThrow();
  });
});
