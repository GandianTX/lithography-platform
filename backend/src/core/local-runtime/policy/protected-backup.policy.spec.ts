// src/core/local-runtime/policy/protected-backup.policy.spec.ts

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  BACKUP_PAYLOAD_PATH,
  BACKUP_RESTORE_TABLE_ORDER,
  BACKUP_SCOPE_TABLES,
  BACKUP_TABLE_DESCRIPTORS,
  backupManifestChecksum,
  buildOrganizationScopePredicate,
  buildProtectedBackupManifest,
  decryptBackupPayload,
  encryptBackupPayload,
  generateBackupId,
  isSafeBackupRelativePath,
  parseBackupManifest,
  parseProtectionKey,
  type BackupRestoreTable,
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
  describe('外键闭包与范围口径（2026-11-23 新计划第 02／03 项）', () => {
    it('备份范围覆盖外键闭包：每张能引用范围表父行的子表都在范围内', () => {
      // 缺任何一张，清空父行时都会被范围外的残留子行挡住
      // （真实库：`Cannot delete or update a parent row: a foreign key constraint fails`）。
      const closureChildren = [
        'maintenance_report_review',
        'reference_document_case_detail',
        'repair_request_intake',
        'repair_process_entry',
        'repair_request_diagnostic_step',
        'repair_request_fault_panel',
        'ai_conversation',
        'ai_message',
        'ai_message_analysis',
        'ai_report',
        'engineer_response',
        'intake_analysis_attempt',
      ];
      for (const child of closureChildren) {
        expect(BACKUP_SCOPE_TABLES).toContain(child);
      }
      expect(BACKUP_SCOPE_TABLES).toHaveLength(26);
    });

    it('恢复写回顺序满足外键约束：父先于子（清空时按逆序＝子先于父）', () => {
      const position = new Map(BACKUP_RESTORE_TABLE_ORDER.map((table, index) => [table, index]));
      const parentFirst: [BackupRestoreTable, BackupRestoreTable][] = [
        ['repair_request_intake', 'repair_request'],
        ['repair_request', 'repair_request_revision'],
        ['repair_request_intake', 'intake_analysis_attempt'],
        ['repair_request', 'maintenance_report'],
        ['maintenance_report', 'maintenance_report_version'],
        ['maintenance_report', 'maintenance_report_attachment'],
        ['maintenance_report_version', 'maintenance_report_version_attachment'],
        ['maintenance_report_attachment', 'maintenance_report_version_attachment'],
        ['maintenance_report_step', 'maintenance_report_fault'],
        ['maintenance_report_version', 'maintenance_report_review'],
        ['maintenance_report_version', 'reference_document'],
        ['reference_document', 'reference_document_revision'],
        ['reference_document', 'reference_document_case_detail'],
        ['repair_request', 'ai_conversation'],
        ['ai_conversation', 'ai_message'],
        ['ai_conversation', 'ai_message_analysis'],
        ['ai_conversation', 'ai_report'],
        ['repair_request', 'engineer_response'],
        ['repair_request', 'repair_process_entry'],
        ['repair_request', 'repair_request_diagnostic_step'],
        ['repair_request_diagnostic_step', 'repair_request_fault_panel'],
      ];
      for (const [parent, child] of parentFirst) {
        expect(position.get(parent)).toBeLessThan(position.get(child) ?? Number.MAX_SAFE_INTEGER);
      }
    });

    it('本机运行数据不按设备全量：范围谓词必须同时约束安装与公司（G23）', () => {
      for (const table of ['local_upload_task', 'local_backup_run'] as const) {
        const predicate = buildOrganizationScopePredicate(table, 't');
        expect(predicate).toContain('t.installation_id = :installationId');
        expect(predicate).toContain('t.organization_id = :organizationId');
      }
    });

    it('没有"无 WHERE 的整表"口径：每张表的谓词都带公司约束', () => {
      for (const table of BACKUP_SCOPE_TABLES) {
        const predicate = buildOrganizationScopePredicate(table, null);
        expect(predicate).toContain(':organizationId');
      }
    });

    it('子表按父表归属**递归**解析到根表的公司列', () => {
      // 报告审核 → 报告版本 → 报告 → owner_organization_id
      const predicate = buildOrganizationScopePredicate('maintenance_report_review', null);
      expect(predicate).toContain('version_id IN (SELECT p.id FROM maintenance_report_version p');
      expect(predicate).toContain('report_id IN (SELECT p.id FROM maintenance_report p');
      expect(predicate).toContain('owner_organization_id = :organizationId');
    });

    it('本机运行事实表 local_backup_run 不进恢复写回顺序', () => {
      expect(BACKUP_SCOPE_TABLES).toContain('local_backup_run');
      expect(BACKUP_RESTORE_TABLE_ORDER).not.toContain('local_backup_run');
    });
  });

  it('排序列按真实主键声明：无 id 列的表必须显式声明（复合主键）', () => {
    // 回归锁：写死 `ORDER BY t.id` 会让受保护包生成在真实库上直接失败
    // （`maintenance_report_version_attachment` 是复合主键，`stored_file` 主键是 file_id）。
    expect(BACKUP_TABLE_DESCRIPTORS.maintenance_report_version_attachment.orderColumns).toEqual([
      'version_id',
      'attachment_id',
    ]);
    expect(BACKUP_TABLE_DESCRIPTORS.stored_file.orderColumns).toEqual(['file_id']);
    for (const table of BACKUP_SCOPE_TABLES) {
      const orderColumns = BACKUP_TABLE_DESCRIPTORS[table].orderColumns ?? ['id'];
      expect(orderColumns.length).toBeGreaterThan(0);
      expect(orderColumns.every((column) => /^[a-z_]+$/.test(column))).toBe(true);
    }
  });

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

  it('范围快照不重复；旧包（范围表较少）仍可解析', () => {
    const manifest = buildProtectedBackupManifest(manifestInput());
    // 范围表随任务推进会增加，写死"等长"会让**已落盘的旧包**全部无法解析：
    // 旧包（范围表较少）必须仍能解析，范围与载荷的一致性由恢复执行层复核。
    expect(() =>
      parseBackupManifest({ ...manifest, scope: manifest.scope.slice(1) }),
    ).not.toThrow();
    expect(() => parseBackupManifest({ ...manifest, scope: [] })).toThrow('一致性范围快照缺失');
    // 构造首表重复的快照
    const duplicated = {
      ...manifest,
      scope: [manifest.scope[0], manifest.scope[0], ...manifest.scope.slice(2)],
    };
    expect(() => parseBackupManifest(duplicated)).toThrow('范围快照表重复');
    // 范围表之外的表 ⇒ 拒绝
    expect(() =>
      parseBackupManifest({
        ...manifest,
        scope: [...manifest.scope, { table: 'not_a_table', rowCount: 0, lastUpdatedAt: null }],
      }),
    ).toThrow('范围快照包含未知表');
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
