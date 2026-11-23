// src/modules/lithography/local-restore-record.writer.spec.ts

/**
 * 恢复写入实现的定向测试（任务 09 S2-2／S2-3）。
 *
 * 守住四条：
 * 1. **整体替换**：目标公司数据区被替换为备份载荷内容，清空按逆外键顺序、
 *    写回按正外键顺序；
 * 2. **失败关闭**：载荷缺子表、含不支持的表、事务端口不可得 ⇒ 不写任何业务行；
 * 3. **原件还原**：按包内相对路径读文件并核对字节数与 SHA-256；本机同引用
 *    字节**不一致**时必须重写（不得留下"登记摘要与实际字节不符"的错配）；
 * 4. **范围口径**：根表按公司列，子表按**父表**的公司归属圈定。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LocalRestoreRecordWriterService } from './local-restore-record.writer';

type RepoStub = {
  createQueryBuilder: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  create: jest.Mock;
};

function repoStub(): RepoStub {
  return {
    createQueryBuilder: jest.fn((): Record<string, unknown> => {
      const builder: Record<string, unknown> = {
        where: jest.fn(() => builder),
        orderBy: jest.fn(() => builder),
        limit: jest.fn(() => builder),
        getCount: jest.fn().mockResolvedValue(0),
        getRawOne: jest.fn().mockResolvedValue(null),
        getMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn(() => ({ execute: jest.fn().mockResolvedValue({ affected: 0 }) })),
      };
      return builder;
    }),
    insert: jest.fn().mockResolvedValue({ identifiers: [] }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn((row: Record<string, unknown>) => row),
  };
}

const TABLE_NAMES = [
  'repair_request',
  'repair_request_revision',
  'maintenance_report',
  'maintenance_report_version',
  'maintenance_report_attachment',
  'maintenance_report_version_attachment',
  'maintenance_report_alarm',
  'maintenance_report_step',
  'maintenance_report_fault',
  'reference_document',
  'reference_document_revision',
  'stored_file',
  'local_upload_task',
] as const;

function buildRepositories() {
  const repos = Object.fromEntries(TABLE_NAMES.map((table) => [table, repoStub()])) as Record<
    (typeof TABLE_NAMES)[number],
    RepoStub
  >;
  return repos;
}

function buildWriter(
  options: {
    repositories?: ReturnType<typeof buildRepositories>;
    transactionRunner?: unknown;
    fileStorage?: unknown;
  } = {},
) {
  const repositories = options.repositories ?? buildRepositories();
  // `null` 是"端口缺席"的显式取值（不可用 `??`：null 会被当成未提供）
  const transactionRunner =
    options.transactionRunner === undefined
      ? ({ run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn({})) } as never)
      : options.transactionRunner;
  const fileStorage: unknown = options.fileStorage ?? {
    save: jest.fn().mockResolvedValue('new-ref.bin'),
    open: jest.fn(() => {
      throw new Error('本机没有该引用');
    }),
    delete: jest.fn().mockResolvedValue(undefined),
    verifyIntegrity: jest.fn().mockResolvedValue(false),
  };

  const service = new LocalRestoreRecordWriterService(
    repositories.repair_request as never,
    repositories.repair_request_revision as never,
    repositories.maintenance_report as never,
    repositories.maintenance_report_version as never,
    repositories.maintenance_report_attachment as never,
    repositories.maintenance_report_version_attachment as never,
    repositories.maintenance_report_alarm as never,
    repositories.maintenance_report_step as never,
    repositories.maintenance_report_fault as never,
    repositories.reference_document as never,
    repositories.reference_document_revision as never,
    repositories.stored_file as never,
    repositories.local_upload_task as never,
    fileStorage as never,
    transactionRunner as never,
  );
  return {
    service,
    repositories,
    transactionRunner: transactionRunner as { run: jest.Mock },
    fileStorage,
  };
}

/** 一份"父表齐全、子表齐全"的最小载荷 */
function fullPayloadTables() {
  return [
    { table: 'stored_file' as const, rows: [{ fileId: 'f-1' }] },
    { table: 'repair_request' as const, rows: [{ id: 1 }] },
    { table: 'repair_request_revision' as const, rows: [{ id: 10, requestId: 1 }] },
    { table: 'maintenance_report' as const, rows: [{ id: 2 }] },
    { table: 'maintenance_report_alarm' as const, rows: [{ id: 20, reportId: 2 }] },
    { table: 'maintenance_report_step' as const, rows: [{ id: 21, reportId: 2 }] },
    { table: 'maintenance_report_fault' as const, rows: [{ id: 22, reportId: 2 }] },
    { table: 'maintenance_report_version' as const, rows: [{ id: 23, reportId: 2 }] },
    { table: 'maintenance_report_attachment' as const, rows: [{ id: 24, reportId: 2 }] },
    {
      table: 'maintenance_report_version_attachment' as const,
      rows: [{ versionId: 23, attachmentId: 24, reportId: 2 }],
    },
    { table: 'reference_document' as const, rows: [{ id: 3 }] },
    { table: 'reference_document_revision' as const, rows: [{ id: 30, documentId: 3 }] },
    { table: 'local_upload_task' as const, rows: [{ id: 40 }] },
  ];
}

describe('恢复写入实现（S2-2／S2-3）', () => {
  it('整体替换：清空与写回都在同一事务内完成', async () => {
    const { service, repositories, transactionRunner } = buildWriter();

    const outcome = await service.write({
      organizationId: 4,
      restoreId: 'restore-1',
      tables: fullPayloadTables(),
    });

    expect(outcome.status).toBe('WRITTEN');
    expect(outcome.written).toBe(13);
    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
    // 写回顺序＝外键顺序（父先于子）：按**实际调用顺序**记录
    const insertOrder: string[] = [];
    for (const [table, repo] of Object.entries(repositories)) {
      repo.insert.mockImplementation(() => {
        insertOrder.push(table);
        return Promise.resolve({ identifiers: [] });
      });
    }
    await service.write({
      organizationId: 4,
      restoreId: 'restore-1',
      tables: fullPayloadTables(),
    });

    expect(insertOrder[0]).toBe('stored_file');
    expect(insertOrder.indexOf('maintenance_report')).toBeLessThan(
      insertOrder.indexOf('maintenance_report_version'),
    );
    expect(insertOrder.indexOf('maintenance_report_version')).toBeLessThan(
      insertOrder.indexOf('maintenance_report_version_attachment'),
    );
    expect(insertOrder.indexOf('repair_request')).toBeLessThan(
      insertOrder.indexOf('repair_request_revision'),
    );
  });

  it('清空按逆外键顺序（先子后父），避免外键悬空', async () => {
    const { service, repositories } = buildWriter();
    const deleteOrder: string[] = [];
    for (const [table, repo] of Object.entries(repositories)) {
      repo.createQueryBuilder.mockImplementation((): Record<string, unknown> => {
        const builder: Record<string, unknown> = {
          where: jest.fn(() => builder),
          delete: jest.fn(() => ({
            execute: jest.fn(() => {
              deleteOrder.push(table);
              return { affected: 0 };
            }),
          })),
        };
        return builder;
      });
    }

    await service.write({
      organizationId: 4,
      restoreId: 'restore-1',
      tables: fullPayloadTables(),
    });

    expect(deleteOrder.indexOf('maintenance_report_version_attachment')).toBeLessThan(
      deleteOrder.indexOf('maintenance_report_version'),
    );
    expect(deleteOrder.indexOf('maintenance_report_version')).toBeLessThan(
      deleteOrder.indexOf('maintenance_report'),
    );
    expect(deleteOrder.indexOf('repair_request_revision')).toBeLessThan(
      deleteOrder.indexOf('repair_request'),
    );
  });

  it('载荷缺少父表的子表 ⇒ 失败关闭（不写出悬空外键的库）', async () => {
    const { service, repositories } = buildWriter();

    const outcome = await service.write({
      organizationId: 4,
      restoreId: 'restore-1',
      tables: [
        { table: 'maintenance_report' as const, rows: [{ id: 2 }] },
        { table: 'maintenance_report_version' as const, rows: [] },
      ],
    });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('缺少子表数据');
    expect(outcome.reason).toContain('重新生成备份');
    for (const repo of Object.values(repositories)) {
      expect(repo.insert).not.toHaveBeenCalled();
    }
  });

  it('载荷含本机不支持的业务表 ⇒ 失败关闭', async () => {
    const { service, repositories } = buildWriter();

    const outcome = await service.write({
      organizationId: 4,
      restoreId: 'restore-1',
      tables: [...fullPayloadTables(), { table: 'base_user_account' as never, rows: [{ id: 1 }] }],
    });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('不支持恢复的业务表');
    for (const repo of Object.values(repositories)) {
      expect(repo.insert).not.toHaveBeenCalled();
    }
  });

  it('事务边界不可得 ⇒ 失败关闭（不在无事务条件下硬写）', async () => {
    const { service, repositories } = buildWriter({ transactionRunner: null });

    const outcome = await service.write({
      organizationId: 4,
      restoreId: 'restore-1',
      tables: fullPayloadTables(),
    });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('事务边界不可用');
    for (const repo of Object.values(repositories)) {
      expect(repo.insert).not.toHaveBeenCalled();
    }
  });

  it('子表按**父表**的公司归属圈定范围（不按自身列误判）', async () => {
    const { service, repositories } = buildWriter();
    const whereCalls: string[] = [];
    repositories.maintenance_report_version.createQueryBuilder.mockImplementation(
      (): Record<string, unknown> => {
        const builder: Record<string, unknown> = {
          where: jest.fn((sql: string) => {
            whereCalls.push(sql);
            return builder;
          }),
          delete: jest.fn(() => ({ execute: jest.fn().mockResolvedValue({ affected: 0 }) })),
          orderBy: jest.fn(() => builder),
          getMany: jest.fn().mockResolvedValue([]),
        };
        return builder;
      },
    );

    await service.write({
      organizationId: 4,
      restoreId: 'restore-1',
      tables: fullPayloadTables(),
    });

    expect(whereCalls.length).toBeGreaterThan(0);
    expect(whereCalls[0]).toContain('report_id');
    expect(whereCalls[0]).toContain('maintenance_report');
  });

  describe('原件字节还原', () => {
    const bytes = Buffer.from('hello-original', 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const packageRoot = '/tmp/task09-restore-writer-spec';

    beforeEach(() => {
      rmSync(packageRoot, { force: true, recursive: true });
      mkdirSync(join(packageRoot, 'files/ref'), { recursive: true });
      writeFileSync(join(packageRoot, 'files/ref/a.bin'), bytes);
    });

    afterEach(() => {
      rmSync(packageRoot, { force: true, recursive: true });
    });

    it('本机同引用字节一致 ⇒ 复用既有引用，不重复写入', async () => {
      const verifyIntegrity = jest.fn().mockResolvedValue(true);
      const save = jest.fn().mockResolvedValue('should-not-be-used');
      const { service, repositories } = buildWriter({
        fileStorage: {
          save,
          open: jest.fn(() => {
            throw new Error('unused');
          }),
          delete: jest.fn().mockResolvedValue(undefined),
          verifyIntegrity,
        },
      });

      const result = await service.restoreOriginals({
        organizationId: 4,
        restoreId: 'restore-1',
        packageRoot,
        originals: [{ source: 'stored_file:f-1', storage_reference: 'ref/a.bin', sha256 }],
        files: [{ relative_path: 'files/ref/a.bin', sha256, byte_size: bytes.byteLength }],
      });

      expect(result.failed).toBe(0);
      expect(result.restored).toBe(1);
      expect(save).not.toHaveBeenCalled();
      expect(repositories.stored_file.update).toHaveBeenCalledWith(
        { fileId: 'f-1' },
        expect.objectContaining({ storageReference: 'ref/a.bin' }),
      );
    });

    it('本机同引用字节**不一致** ⇒ 按包内字节重写（不留摘要与字节错配）', async () => {
      const verifyIntegrity = jest.fn().mockResolvedValue(false);
      const save = jest.fn().mockResolvedValue('fresh-ref.bin');
      const { service, repositories } = buildWriter({
        fileStorage: {
          save,
          open: jest.fn(() => {
            throw new Error('unused');
          }),
          delete: jest.fn().mockResolvedValue(undefined),
          verifyIntegrity,
        },
      });

      const result = await service.restoreOriginals({
        organizationId: 4,
        restoreId: 'restore-1',
        packageRoot,
        originals: [{ source: 'stored_file:f-1', storage_reference: 'ref/a.bin', sha256 }],
        files: [{ relative_path: 'files/ref/a.bin', sha256, byte_size: bytes.byteLength }],
      });

      expect(result.failed).toBe(0);
      expect(save).toHaveBeenCalledTimes(1);
      expect(repositories.stored_file.update).toHaveBeenCalledWith(
        { fileId: 'f-1' },
        expect.objectContaining({
          storageReference: 'fresh-ref.bin',
          checksumSha256: sha256,
          byteSize: String(bytes.byteLength),
        }),
      );
    });

    it('报告附件自带存储引用 ⇒ 附件行一并指向还原后的字节', async () => {
      const { service, repositories } = buildWriter();

      const result = await service.restoreOriginals({
        organizationId: 4,
        restoreId: 'restore-1',
        packageRoot,
        originals: [
          { source: 'maintenance_report_attachment:24', storage_reference: 'ref/a.bin', sha256 },
        ],
        files: [{ relative_path: 'files/ref/a.bin', sha256, byte_size: bytes.byteLength }],
      });

      expect(result.failed).toBe(0);
      expect(repositories.maintenance_report_attachment.update).toHaveBeenCalledWith(
        { id: 24 },
        expect.objectContaining({ checksumSha256: sha256 }),
      );
    });

    it('包内字节与清单摘要不符 ⇒ 该原件失败（不写半截字节）', async () => {
      const { service, repositories } = buildWriter();

      const result = await service.restoreOriginals({
        organizationId: 4,
        restoreId: 'restore-1',
        packageRoot,
        originals: [{ source: 'stored_file:f-1', storage_reference: 'ref/a.bin', sha256 }],
        files: [
          {
            relative_path: 'files/ref/a.bin',
            sha256: 'f'.repeat(64),
            byte_size: bytes.byteLength,
          },
        ],
      });

      expect(result.restored).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.reason).toContain('未能按包内清单还原');
      expect(repositories.stored_file.update).not.toHaveBeenCalled();
    });

    it('清单未登记该原件 ⇒ 该原件失败（不静默跳过）', async () => {
      const { service, repositories } = buildWriter();

      const result = await service.restoreOriginals({
        organizationId: 4,
        restoreId: 'restore-1',
        packageRoot,
        originals: [{ source: 'stored_file:f-1', storage_reference: 'ref/missing.bin', sha256 }],
        files: [{ relative_path: 'files/ref/a.bin', sha256, byte_size: bytes.byteLength }],
      });

      expect(result.restored).toBe(0);
      expect(result.failed).toBe(1);
      expect(repositories.stored_file.update).not.toHaveBeenCalled();
    });
  });
});
