// src/modules/lithography/protected-backup.service.spec.ts

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';

import {
  BACKUP_PAYLOAD_PATH,
  parseBackupManifest,
  parseProtectionKey,
  decryptBackupPayload,
} from '@core/local-runtime/policy/protected-backup.policy';

import { ProtectedBackupService } from './protected-backup.service';

describe('protected backup service', () => {
  const storageRoot = nodePath.join(__dirname, '.tmp-backup-storage');
  const targetRoot = nodePath.join(__dirname, '.tmp-backup-target');
  const KEY_HEX = 'ab'.repeat(32);

  const buildService = (
    overrides: {
      documents?: Record<string, unknown>[];
      storedFiles?: Record<string, unknown>[];
      missingOriginal?: boolean;
      /** 落库的备份资产行（用于核对保留窗口写入） */
      assets?: Record<string, unknown>[];
    } = {},
  ) => {
    const repoOf = (rows: Record<string, unknown>[]) => ({
      find: jest.fn().mockResolvedValue(rows),
      findOne: jest.fn().mockResolvedValue(rows[0] ?? null),
      count: jest.fn().mockResolvedValue(rows.length),
    });
    const fileStorage = {
      open: (reference: string) => {
        if (overrides.missingOriginal) {
          return Promise.reject(new Error('file gone'));
        }
        return Promise.resolve(createReadStream(nodePath.join(storageRoot, reference)));
      },
    };

    const service = new ProtectedBackupService(
      { findOne: jest.fn().mockResolvedValue({ installationId: 'inst-uuid-1' }) } as never,
      repoOf([]) as never, // repair_request：空
      repoOf([]) as never, // maintenance_report：空
      repoOf(overrides.documents ?? []) as never, // reference_document
      repoOf(overrides.storedFiles ?? []) as never, // stored_file
      repoOf([]) as never, // local_upload_task
      fileStorage as never,
      { keyHex: KEY_HEX, keyId: 'primary' },
      { baseDir: nodePath.join(__dirname, '.tmp-protected-backup-storage') },
      {
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          (overrides.assets ?? []).push(row);
          return Promise.resolve(row);
        }),
        create: jest.fn().mockImplementation((row: Record<string, unknown>) => ({ ...row })),
      } as never,
    );
    return service;
  };

  beforeAll(() => {
    mkdirSync(storageRoot, { recursive: true });
    writeFileSync(nodePath.join(storageRoot, 'doc-1.txt'), 'ORIGINAL-DOC-1');
    writeFileSync(nodePath.join(storageRoot, 'file-2.bin'), 'ORIGINAL-STORED-2');
  });

  afterAll(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(targetRoot, { recursive: true, force: true });
  });

  it('受保护包生成：载荷加密、原件复制、清单自校验通过、范围快照行数一致', async () => {
    const service = buildService({
      documents: [
        {
          id: 1,
          ownerOrganizationId: 4,
          updatedAt: new Date('2026-11-18T10:00:00.000Z'),
          storageBackend: 'local',
          storageReference: 'doc-1.txt',
          title: '资料1',
        },
      ],
      storedFiles: [
        {
          fileId: 'file-uuid-2',
          ownerOrganizationId: 4,
          storageReference: 'file-2.bin',
          checksumSha256: null,
        },
      ],
    });
    const result = await service.generateProtectedBackup({
      organizationId: 4,
      runId: 3,
      targetPath: nodePath.join(targetRoot, 'pkg-1'),
    });

    expect(result.manifestChecksum).toHaveLength(64);
    expect(result.byteSize).toBeGreaterThan(0);
    expect(existsSync(nodePath.join(result.packagePath, 'manifest.json'))).toBe(true);
    expect(existsSync(nodePath.join(result.packagePath, BACKUP_PAYLOAD_PATH))).toBe(true);

    const manifest = parseBackupManifest(
      JSON.parse(readFileSync(nodePath.join(result.packagePath, 'manifest.json'), 'utf8')),
    );
    expect(manifest.organization_id).toBe(4);
    expect(manifest.encryption.key_id).toBe('primary');
    const docScope = manifest.scope.find((entry) => entry.table === 'reference_document');
    expect(docScope?.rowCount).toBe(1);
    expect(existsSync(nodePath.join(result.packagePath, 'files/doc-1.txt'))).toBe(true);
    const copied = manifest.files.find((file) => file.relative_path === 'files/doc-1.txt');
    expect(copied?.byte_size).toBe('ORIGINAL-DOC-1'.length);

    // 用清单元数据解密载荷，验证 AES-256-GCM 闭环
    const payloadRaw = readFileSync(nodePath.join(result.packagePath, BACKUP_PAYLOAD_PATH));
    const key = parseProtectionKey(KEY_HEX);
    const decrypted = decryptBackupPayload(
      key,
      payloadRaw,
      manifest.encryption.iv,
      manifest.encryption.auth_tag,
    );
    expect(JSON.parse(decrypted.toString('utf8')).reference_document).toHaveLength(1);
  });

  it('保护密钥未配置：生成失败关闭（不产出可用包）', async () => {
    const service = buildService({});
    (service as unknown as { backupProtection: unknown }).backupProtection = null;
    await expect(
      service.generateProtectedBackup({
        organizationId: 4,
        runId: null,
        targetPath: nodePath.join(targetRoot, 'pkg-nokey'),
      }),
    ).rejects.toThrow('保护密钥必须为 64 位十六进制（AES-256 密钥）');
    expect(existsSync(nodePath.join(targetRoot, 'pkg-nokey'))).toBe(false);
  });

  it('原件缺失：保留引用清单但复制跳过，生成不中断', async () => {
    const service = buildService({
      documents: [
        {
          id: 1,
          ownerOrganizationId: 4,
          updatedAt: new Date(),
          storageBackend: 'local',
          storageReference: 'gone.txt',
        },
      ],
      missingOriginal: true,
    });
    const result = await service.generateProtectedBackup({
      organizationId: 4,
      runId: null,
      targetPath: nodePath.join(targetRoot, 'pkg-missing'),
    });
    const manifest = parseBackupManifest(
      JSON.parse(readFileSync(nodePath.join(result.packagePath, 'manifest.json'), 'utf8')),
    );
    expect(manifest.originals).toHaveLength(1); // 引用保留
    expect(manifest.files.every((file) => file.relative_path !== 'files/gone.txt')).toBe(true);
  });

  it('目标目录非空：拒绝覆盖', async () => {
    const occupied = nodePath.join(targetRoot, 'occupied');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(nodePath.join(occupied, 'x.txt'), 'x');
    const service = buildService({});
    await expect(
      service.generateProtectedBackup({
        organizationId: 4,
        runId: null,
        targetPath: occupied,
      }),
    ).rejects.toThrow('备份目标目录已存在且非空，拒绝覆盖');
  });

  it('保留窗口写入：retention_until 恰好是封包时刻 + 30 天（锚点是封包时刻，不是随后的墙上时钟）', async () => {
    const assets: Record<string, unknown>[] = [];
    const service = buildService({ assets });
    const now = new Date('2026-11-19T08:00:00.000Z');

    await service.generateProtectedBackup({
      organizationId: 4,
      runId: 3,
      targetPath: nodePath.join(targetRoot, 'pkg-retention'),
      now,
    });

    expect(assets).toHaveLength(1);
    const retentionUntil = assets[0]?.['retentionUntil'] as Date | undefined;
    expect(retentionUntil?.getTime()).toBe(now.getTime() + 30 * 86_400_000);
  });
});
