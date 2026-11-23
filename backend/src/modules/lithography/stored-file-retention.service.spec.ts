// src/modules/lithography/stored-file-retention.service.spec.ts
/// <reference types="jest" />

/**
 * 过期暂存原件清理事实层的定向测试（任务 09 P3-3 跨资源失败补偿）。
 *
 * 守住：
 * - **被业务引用的原件不删字节**（含退役但仍持外键的附件行）；
 * - 到期未绑定的暂存行：先释放（标记失效、行保留）再回收字节；
 * - 安装未映射公司 → 不清理（不猜公司、不跨公司清理）；
 * - 逐项结果如实（失败不假装已清理）。
 */

import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { StoredFileRetentionService } from './stored-file-retention.service';

const NOW = new Date('2026-11-23T00:00:00.000Z');
const OLD = new Date('2026-10-01T00:00:00.000Z');

function buildService(
  options: {
    rows?: unknown[];
    referencedFileIds?: string[];
    released?: number;
    installation?: { organizationId: number | null } | null;
    deleteFails?: boolean;
  } = {},
) {
  const rows = options.rows ?? [
    {
      fileId: 'file-1',
      ownerOrganizationId: 4,
      storageReference: 'ref-1',
      status: 'VALID',
      bindingStatus: 'TEMPORARY',
      businessId: null,
      createdAt: OLD,
    },
  ];
  const referenced = new Set(options.referencedFileIds ?? []);

  const storedFileRepository = {
    find: jest.fn().mockResolvedValue(rows),
    findOne: jest.fn().mockResolvedValue(rows[0] ?? null),
  };
  const reportAttachmentRepository = {
    find: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve([...referenced].map((fileId) => ({ fileId, status: 'RETIRED' }))),
      ),
  };
  const intakeRepository = { find: jest.fn().mockResolvedValue([]) };
  const processEntryRepository = { find: jest.fn().mockResolvedValue([]) };
  const repairRequestRepository = { find: jest.fn().mockResolvedValue([]) };
  const installationRepository = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        options.installation === null
          ? null
          : (options.installation ?? { id: 1, organizationId: 4 }),
      ),
  };
  const releaseTemporaryFiles = jest
    .fn()
    .mockResolvedValue(options.released === undefined ? 1 : options.released);
  const remove = jest.fn().mockImplementation(() => {
    if (options.deleteFails === true) {
      return Promise.reject(new Error('存储不可用'));
    }
    return Promise.resolve();
  });

  const service = new StoredFileRetentionService(
    storedFileRepository as never,
    reportAttachmentRepository as never,
    intakeRepository as never,
    processEntryRepository as never,
    repairRequestRepository as never,
    installationRepository as never,
    { releaseTemporaryFiles } as never,
    { delete: remove } as never,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
  );

  return { service, storedFileRepository, releaseTemporaryFiles, remove, installationRepository };
}

describe('过期暂存原件清理事实层（P3-3）', () => {
  it('到期且未被引用：先释放再回收字节，DB 行保留', async () => {
    const { service, releaseTemporaryFiles, remove } = buildService();

    const result = await service.cleanup({ organizationId: 4, now: NOW });

    expect(releaseTemporaryFiles).toHaveBeenCalledWith({ fileIds: ['file-1'] });
    expect(remove).toHaveBeenCalledWith('ref-1');
    expect(result.cleaned).toBe(1);
    expect(result.items[0].outcome).toBe('CLEANED');
  });

  it('被业务引用的行：保留，不释放也不删字节', async () => {
    const { service, releaseTemporaryFiles, remove } = buildService({
      referencedFileIds: ['file-1'],
    });

    const result = await service.cleanup({ organizationId: 4, now: NOW });

    expect(releaseTemporaryFiles).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(result.cleaned).toBe(0);
    expect(result.retained).toBe(1);
    expect(result.items[0].outcome).toBe('RETAINED');
    expect(result.items[0].reason).toBe('BUSINESS_REFERENCED');
  });

  it('未到保留窗口：保留', async () => {
    const { service, remove } = buildService({
      rows: [
        {
          fileId: 'file-1',
          ownerOrganizationId: 4,
          storageReference: 'ref-1',
          status: 'VALID',
          bindingStatus: 'TEMPORARY',
          businessId: null,
          createdAt: new Date('2026-11-20T00:00:00.000Z'),
        },
      ],
    });

    const result = await service.cleanup({ organizationId: 4, now: NOW });

    expect(remove).not.toHaveBeenCalled();
    expect(result.retained).toBe(1);
    expect(result.items[0].reason).toBe('NOT_EXPIRED');
  });

  it('释放未命中（已被绑定或状态已变）：保留，不删字节', async () => {
    const { service, remove } = buildService({ released: 0 });

    const result = await service.cleanup({ organizationId: 4, now: NOW });

    expect(remove).not.toHaveBeenCalled();
    expect(result.retained).toBe(1);
    expect(result.items[0].reason).toBe('ALREADY_BOUND_OR_CHANGED');
  });

  it('字节回收失败：逐项记失败（不假装已清理）', async () => {
    const { service } = buildService({ deleteFails: true });

    const result = await service.cleanup({ organizationId: 4, now: NOW });

    expect(result.cleaned).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.items[0].outcome).toBe('FAILED');
  });

  it('本机安装未映射公司：不清理（不猜公司、不跨公司清理）', async () => {
    const { service, remove } = buildService({ installation: { organizationId: null } });

    const result = await service.cleanupAllExpired({ now: NOW });

    expect(remove).not.toHaveBeenCalled();
    expect(result.available).toBe(false);
    expect(result.targetCount).toBe(0);
    expect(result.reason).toContain('不清理');
  });

  it('本机安装缺失：同样不清理', async () => {
    const { service, remove } = buildService({ installation: null });

    const result = await service.cleanupAllExpired({ now: NOW });

    expect(remove).not.toHaveBeenCalled();
    expect(result.available).toBe(false);
  });
});
