// src/modules/lithography/queries/repair-process-entry.query.service.spec.ts

/// <reference types="jest" />
import type { Repository } from 'typeorm';

import type { RepairProcessEntryEntity } from '../entities/repair-process-entry.entity';
import { StoredFileEntity } from '../entities/stored-file.entity';
import { RepairProcessEntryQueryService } from './repair-process-entry.query.service';

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FILE_ID = '22222222-2222-4222-8222-222222222222';

const baseRow = (overrides: Record<string, unknown> = {}) => ({
  id: '101',
  entryUuid: '4f0c5f6a-1111-4111-8111-111111111111',
  requestId: '21',
  operationText: '更换干涉仪镜片',
  testResult: '精度恢复至 1nm',
  occurredAt: '2026-11-14T02:00:00.000Z',
  timeSource: 'MANUAL',
  fileId: null,
  versionNo: '1',
  createdAt: '2026-11-14T03:00:00.000Z',
  fileFileId: null,
  fileOriginalFilename: null,
  fileMimeType: null,
  fileByteSize: null,
  fileChecksumSha256: null,
  fileStatus: null,
  fileBindingStatus: null,
  fileVerifiedAt: null,
  fileBusinessId: null,
  fileBusinessType: null,
  ...overrides,
});

/**
 * 任务 11「正式绑定 REPAIR_PROCESS」的合法原件事实。
 * requestId=21、businessId='21'：文件业务归属与当前过程行一致。
 */
const validFileRow = (overrides: Record<string, unknown> = {}) =>
  baseRow({
    fileId: FILE_ID,
    fileFileId: FILE_ID,
    fileOriginalFilename: 'report.pdf',
    fileMimeType: 'application/pdf',
    fileByteSize: '2048',
    fileChecksumSha256: 'abc123',
    fileStatus: 'VALID',
    fileBindingStatus: 'BOUND',
    fileVerifiedAt: '2026-11-14T01:00:00.000Z',
    fileBusinessId: '21',
    fileBusinessType: 'REPAIR_PROCESS',
    ...overrides,
  });

const makeService = (rows: Array<Record<string, unknown>>) => {
  const queryBuilder = {
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  const repository = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  } as unknown as Repository<RepairProcessEntryEntity>;

  return { service: new RepairProcessEntryQueryService(repository), queryBuilder };
};

/** 任一无效/归属不符场景都不允许残留 entry.file_id 或原件展示对象 */
const expectFileHidden = (entry: {
  fileId: string | null;
  file: unknown;
  operationText: string;
  versionNo: number;
}) => {
  expect(entry.fileId).toBeNull();
  expect(entry.file).toBeNull();
  // 过程文本、版本号等有权内容必须保持不变
  expect(entry.operationText).toBe('更换干涉仪镜片');
  expect(entry.versionNo).toBe(1);
  // 存储引用永不进入读模型
  expect(entry).not.toHaveProperty('storageReference');
  expect(JSON.stringify(entry)).not.toContain('storage:');
};

describe(RepairProcessEntryQueryService.name, () => {
  it('按工单过滤、按创建时间与 ID 升序排序，并只左连接 REPAIR_PROCESS 用途原件', async () => {
    const { service, queryBuilder } = makeService([]);

    await service.listByRequest(21);

    expect(queryBuilder.where).toHaveBeenCalledWith('entry.request_id = :requestId', {
      requestId: 21,
    });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('entry.created_at', 'ASC');
    expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('entry.id', 'ASC');
    expect(queryBuilder.leftJoin).toHaveBeenCalledWith(
      StoredFileEntity,
      'file',
      'file.file_id = entry.file_id AND file.business_type = :businessType',
      { businessType: 'REPAIR_PROCESS' },
    );
  });

  it('查询投影读取任务 11 判定所需的原件事实，且不读取存储引用', async () => {
    const { service, queryBuilder } = makeService([]);

    await service.listByRequest(21);

    const selected = queryBuilder.select.mock.calls[0][0] as string[];
    expect(selected).toEqual(
      expect.arrayContaining([
        'file.file_id AS fileFileId',
        'file.status AS fileStatus',
        'file.binding_status AS fileBindingStatus',
        'file.verified_at AS fileVerifiedAt',
        'file.business_id AS fileBusinessId',
        'file.business_type AS fileBusinessType',
      ]),
    );
    expect(selected.join('\n')).not.toContain('storage_reference');
  });

  it('仅过程文本投影：不联接 stored_file、不读取 entry.file_id，fileId/file 恒为 null', async () => {
    const { service, queryBuilder } = makeService([
      baseRow({ fileId: FILE_ID, fileFileId: FILE_ID, fileStatus: 'FAILED' }),
    ]);

    const entries = await service.listByRequestTextOnly(21);

    expect(queryBuilder.leftJoin).not.toHaveBeenCalled();
    const selected = queryBuilder.select.mock.calls[0][0] as string[];
    expect(selected.join('\n')).not.toContain('entry.file_id');
    expect(selected.join('\n')).not.toContain('file.');
    expect(selected.join('\n')).not.toContain('storage_reference');
    expect(entries).toEqual([
      expect.objectContaining({
        id: '101',
        requestId: 21,
        operationText: '更换干涉仪镜片',
        versionNo: 1,
        fileId: null,
        file: null,
      }),
    ]);
    expect(entries[0]).not.toHaveProperty('storageReference');
  });

  it('有效、已验证、BOUND 且绑定当前工单：展示 fileId 与 file', async () => {
    const { service } = makeService([validFileRow()]);

    const entries = await service.listByRequest(21);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: '101',
      requestId: 21,
      versionNo: 1,
      timeSource: 'MANUAL',
      fileId: FILE_ID,
      file: {
        fileId: FILE_ID,
        originalFilename: 'report.pdf',
        mimeType: 'application/pdf',
        byteSize: 2048,
        checksumSha256: 'abc123',
      },
    });
    expect(entries[0].occurredAt).toBeInstanceOf(Date);
    expect(entries[0].createdAt).toBeInstanceOf(Date);
  });

  it('未绑定原件或原件用途不是 REPAIR_PROCESS：映射为 null', async () => {
    const { service } = makeService([
      baseRow(),
      // 异常数据替身：正式绑定只会写 REPAIR_PROCESS，此组合仅用于证明读取侧失败关闭
      validFileRow({ fileBusinessType: 'REFERENCE_DOCUMENT' }),
    ]);

    const entries = await service.listByRequest(21);

    expect(entries[0].fileId).toBeNull();
    expect(entries[0].file).toBeNull();
    expectFileHidden(entries[1]);
  });

  /**
   * 异常数据替身：正式绑定只会在 VALID + TEMPORARY 前提下原子更新为 BOUND，
   * 且 businessId 由服务端写为 String(requestId)。以下组合无法通过正式写入产生，
   * 仅用于证明读取侧对异常存量数据失败关闭。
   */
  it.each([
    ['文件状态 FAILED', { fileStatus: 'FAILED' }],
    ['文件状态 STAGING', { fileStatus: 'STAGING' }],
    ['文件状态未知', { fileStatus: 'UNKNOWN' }],
    ['verifiedAt 缺失', { fileVerifiedAt: null }],
    ['绑定状态 TEMPORARY', { fileBindingStatus: 'TEMPORARY' }],
    ['绑定状态未知', { fileBindingStatus: 'UNKNOWN' }],
    ['businessId 指向其他工单', { fileBusinessId: '22' }],
    ['businessId 为空字符串', { fileBusinessId: '' }],
    ['businessId 非数字', { fileBusinessId: 'not-a-number' }],
    ['stored_file 不存在', { fileFileId: null }],
  ])('%s：同时隐藏 fileId 与 file，保留过程文本', async (_label, overrides) => {
    const { service } = makeService([validFileRow(overrides)]);

    const entries = await service.listByRequest(21);

    expectFileHidden(entries[0]);
  });

  it('businessId 为空：同时隐藏 fileId 与 file，保留过程文本', async () => {
    const { service } = makeService([validFileRow({ fileBusinessId: null })]);

    const entries = await service.listByRequest(21);

    expectFileHidden(entries[0]);
  });

  /**
   * 异常数据替身：repair_process_entry.file_id 受外键约束，正式写入不会出现
   * 过程行与 stored_file.file_id 不一致；仅验证读取侧失败关闭。
   */
  it('过程行与文件缺少真实关联（file_id 不一致）：同时隐藏 fileId 与 file', async () => {
    const { service } = makeService([validFileRow({ fileFileId: OTHER_FILE_ID })]);

    const entries = await service.listByRequest(21);

    expectFileHidden(entries[0]);
  });

  it('一条工单内有效与无效过程行混合：只隐藏无效行的原件字段', async () => {
    const { service } = makeService([
      validFileRow(),
      validFileRow({
        id: '102',
        entryUuid: 'entry-2',
        operationText: '复测',
        fileId: OTHER_FILE_ID,
        fileFileId: OTHER_FILE_ID,
        fileStatus: 'FAILED',
      }),
    ]);

    const entries = await service.listByRequest(21);

    expect(entries[0]).toMatchObject({ fileId: FILE_ID, file: { fileId: FILE_ID } });
    expect(entries[1].fileId).toBeNull();
    expect(entries[1].file).toBeNull();
    expect(entries[1].operationText).toBe('复测');
    expect(entries[1].versionNo).toBe(1);
  });
});
