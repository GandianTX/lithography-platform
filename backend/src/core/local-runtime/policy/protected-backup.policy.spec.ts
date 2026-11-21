// src/core/local-runtime/policy/protected-backup.policy.spec.ts

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  BACKUP_PAYLOAD_PATH,
  BACKUP_SCOPE_TABLES,
  backupManifestChecksum,
  buildProtectedBackupManifest,
  decryptBackupPayload,
  encryptBackupPayload,
  generateBackupId,
  isSafeBackupRelativePath,
  parseBackupManifest,
  parseProtectionKey,
} from './protected-backup.policy';

const KEY = parseProtectionKey('ab'.repeat(32));

const scope = () =>
  BACKUP_SCOPE_TABLES.map((table, index) => ({
    table,
    rowCount: index,
    lastUpdatedAt: index === 0 ? null : '2026-11-19T00:00:00.000Z',
  }));

const manifestInput = () => ({
  organizationId: 4,
  installationId: 'inst-uuid-1',
  runId: 5,
  generatedAt: new Date('2026-11-19T08:00:00.000Z'),
  encryption: { keyId: 'primary', iv: 'aa'.repeat(12), authTag: 'bb'.repeat(16) },
  scope: scope(),
  files: [{ relative_path: BACKUP_PAYLOAD_PATH, sha256: 'c'.repeat(64), byte_size: 128 }],
  originals: [{ source: 'reference_document:1', storage_reference: 'refs/a.txt', sha256: null }],
});

describe('protected backup policy', () => {
  it('合法清单通过构建与解析自校验', () => {
    const manifest = buildProtectedBackupManifest(manifestInput());
    expect(manifest.schema_version).toBe(BACKUP_MANIFEST_SCHEMA_VERSION);
    expect(parseBackupManifest(manifest)).toBe(manifest);
  });

  it('保护密钥：64 位十六进制可用，长度/字符不符失败关闭', () => {
    expect(parseProtectionKey('ab'.repeat(32)).byteLength).toBe(32);
    expect(() => parseProtectionKey('ab'.repeat(31))).toThrow('保护密钥必须为 64 位十六进制');
    expect(() => parseProtectionKey('zz'.repeat(32))).toThrow('保护密钥必须为 64 位十六进制');
    expect(() => parseProtectionKey(null)).toThrow('保护密钥必须为 64 位十六进制');
  });

  it('AES-256-GCM 加密后可用同一密钥解密还原，auth tag 篡改失败关闭', () => {
    const plaintext = Buffer.from('COMPANY-DATA-PAYLOAD');
    const { data, iv, authTag } = encryptBackupPayload(KEY, plaintext);
    expect(decryptBackupPayload(KEY, data, iv, authTag).toString()).toBe('COMPANY-DATA-PAYLOAD');
    const wrongKey = parseProtectionKey('cd'.repeat(32));
    expect(() => decryptBackupPayload(wrongKey, data, iv, authTag)).toThrow(
      '备份载荷解密失败（密钥不符或数据被篡改）',
    );
    expect(() => decryptBackupPayload(KEY, data, iv, 'ff'.repeat(16))).toThrow(
      '备份载荷解密失败（密钥不符或数据被篡改）',
    );
  });

  it('包 ID 与清单校验值形态稳定', () => {
    expect(generateBackupId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(backupManifestChecksum('{"x":1}')).toHaveLength(64);
  });

  it('包内相对路径安全：绝对路径/穿越/反斜杠拒绝', () => {
    expect(isSafeBackupRelativePath('payload.enc')).toBe(true);
    expect(isSafeBackupRelativePath('files/abc/x.txt')).toBe(true);
    expect(isSafeBackupRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeBackupRelativePath('files/../x')).toBe(false);
    expect(isSafeBackupRelativePath('files\\x')).toBe(false);
  });

  it('结构版本不符拒绝', () => {
    const manifest = buildProtectedBackupManifest(manifestInput());
    expect(() => parseBackupManifest({ ...manifest, schema_version: 99 })).toThrow(
      '备份清单结构版本不符',
    );
  });

  it('范围快照必须覆盖全部范围表且不重复', () => {
    const manifest = buildProtectedBackupManifest(manifestInput());
    expect(() => parseBackupManifest({ ...manifest, scope: manifest.scope.slice(1) })).toThrow(
      '一致性范围快照必须覆盖全部范围表',
    );
    // 构造 6 项但首表重复的快照（s0, s0, s2..s5）
    const duplicated = {
      ...manifest,
      scope: [manifest.scope[0], manifest.scope[0], ...manifest.scope.slice(2)],
    };
    expect(() => parseBackupManifest(duplicated)).toThrow('范围快照表重复');
  });

  it('保护元数据非法拒绝', () => {
    const manifest = buildProtectedBackupManifest(manifestInput());
    expect(() =>
      parseBackupManifest({
        ...manifest,
        encryption: { ...manifest.encryption, key_id: '' },
      }),
    ).toThrow('备份保护元数据非法');
    expect(() =>
      parseBackupManifest({ ...manifest, encryption: { ...manifest.encryption, iv: 'zz' } }),
    ).toThrow('备份保护元数据非法');
  });

  it('文件清单路径不安全或校验值非法拒绝', () => {
    const manifest = buildProtectedBackupManifest(manifestInput());
    expect(() =>
      parseBackupManifest({
        ...manifest,
        files: [{ ...manifest.files[0], relative_path: '../escape' }],
      }),
    ).toThrow('备份文件路径不安全');
    expect(() =>
      parseBackupManifest({
        ...manifest,
        files: [{ ...manifest.files[0], sha256: 'short' }],
      }),
    ).toThrow('备份文件校验值非法');
    expect(() =>
      parseBackupManifest({ ...manifest, files: [{ ...manifest.files[0], byte_size: -1 }] }),
    ).toThrow('备份文件字节数非法');
  });

  it('生成时间与运行 ID 非法拒绝', () => {
    const manifest = buildProtectedBackupManifest(manifestInput());
    expect(() => parseBackupManifest({ ...manifest, generated_at: '2026/11/19' })).toThrow(
      '生成时间必须为 ISO 8601',
    );
    expect(() => parseBackupManifest({ ...manifest, run_id: 1.5 })).toThrow('备份运行 ID 非法');
  });

  it('公司 ID 与安装标识非法拒绝', () => {
    const manifest = buildProtectedBackupManifest(manifestInput());
    expect(() => parseBackupManifest({ ...manifest, organization_id: 0 })).toThrow(
      '备份公司 ID 非法',
    );
    expect(() => parseBackupManifest({ ...manifest, installation_id: '' })).toThrow('安装标识缺失');
  });

  it('原件引用非法拒绝', () => {
    const manifest = buildProtectedBackupManifest(manifestInput());
    expect(() =>
      parseBackupManifest({
        ...manifest,
        originals: [{ source: '', storage_reference: 'refs/a.txt', sha256: null }],
      }),
    ).toThrow('原件引用非法');
    expect(() =>
      parseBackupManifest({
        ...manifest,
        originals: [{ source: 'x', storage_reference: 'refs/a.txt', sha256: 'nothex' }],
      }),
    ).toThrow('原件登记校验值非法');
  });
});
