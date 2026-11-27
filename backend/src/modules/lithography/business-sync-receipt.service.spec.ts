// src/modules/lithography/business-sync-receipt.service.spec.ts
/// <reference types="jest" />

/**
 * 回执与冲突写入的幂等定向测试（任务 09 S2 自检 · 重复／并发）。
 *
 * 守住"响应丢失后重试不会产生第二条回执""同一冲突不覆盖既有裁决"：
 * - 同键重复写入 → 更新同一行，不新增；
 * - 不同版本 → 各自成行（版本是回执身份的一部分）；
 * - 冲突重复写入 → 事实补齐，但既有裁决字段不被覆盖。
 */

import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';

import { BusinessSyncReceiptService } from './business-sync-receipt.service';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function createFakeRepository(initial: Row[]) {
  const store: Row[] = [...initial];
  const repository = {
    target: 'fake',
    create: jest.fn((entity: Row) => ({ ...entity })),
    findOne: jest.fn(({ where }: { where: Row }) => {
      return Promise.resolve(store.find((row) => matches(row, where)) ?? null);
    }),
    insert: jest.fn((entity: Row) => {
      store.push({ ...entity });

      return Promise.resolve(undefined);
    }),
    update: jest.fn((where: Row, patch: Row) => {
      const row = store.find((item) => matches(item, where));
      if (row !== undefined) {
        Object.assign(row, patch);
      }

      return Promise.resolve(undefined);
    }),
    store,
  };

  return repository;
}

function buildService() {
  const receipts = createFakeRepository([]);
  const conflicts = createFakeRepository([]);
  const service = new BusinessSyncReceiptService(
    { target: 'receipt' } as never,
    { target: 'conflict' } as never,
  );
  const manager = {
    getRepository: (target: string) => (target === 'receipt' ? receipts : conflicts),
  };
  const transactionContext = createTypeOrmPersistenceTransactionContext(manager as never);

  return { service, receipts, conflicts, transactionContext };
}

const SUCCESS_INPUT = {
  organizationId: 9,
  resourceType: 'REPAIR_REQUEST',
  recordUuid: 'uuid-1',
  versionNo: 3,
  manifestChecksum: 'a'.repeat(64),
  installationId: 'installation-1',
  remoteResourceId: 'remote-1',
  receivedAt: new Date('2026-11-22T00:00:00.000Z'),
};

const CONFLICT_INPUT = {
  organizationId: 9,
  resourceType: 'REPAIR_REQUEST',
  recordUuid: 'uuid-1',
  versionNo: 3,
  localVersion: 3,
  cloudVersion: 5,
  localSnapshot: { schema_version: 1, content_md: '本地' },
  cloudSnapshot: { schema_version: 1, content_md: '云端' },
  conflictReason: '云端版本更新',
};

describe('业务同步回执与冲突写入的幂等（S2 自检）', () => {
  it('同键重复写入：只更新同一行，不新增第二条回执', async () => {
    const { service, receipts, transactionContext } = buildService();

    await service.recordSuccess(SUCCESS_INPUT, transactionContext);
    await service.recordSuccess(
      { ...SUCCESS_INPUT, remoteResourceId: 'remote-2' },
      transactionContext,
    );

    expect(receipts.store).toHaveLength(1);
    expect(receipts.insert).toHaveBeenCalledTimes(1);
    expect(receipts.update).toHaveBeenCalledTimes(1);
    expect(receipts.store[0].remoteResourceId).toBe('remote-2');
    expect(receipts.store[0].receiptStatus).toBe('SUCCEEDED');
  });

  it('不同版本：各自成行（版本是回执身份的一部分）', async () => {
    const { service, receipts, transactionContext } = buildService();

    await service.recordSuccess(SUCCESS_INPUT, transactionContext);
    await service.recordSuccess({ ...SUCCESS_INPUT, versionNo: 4 }, transactionContext);

    expect(receipts.store).toHaveLength(2);
  });

  it('不同公司：互不覆盖', async () => {
    const { service, receipts, transactionContext } = buildService();

    await service.recordSuccess(SUCCESS_INPUT, transactionContext);
    await service.recordSuccess({ ...SUCCESS_INPUT, organizationId: 10 }, transactionContext);

    expect(receipts.store).toHaveLength(2);
  });

  it('冲突重复写入：事实补齐，但既有裁决不被覆盖', async () => {
    const { service, conflicts, transactionContext } = buildService();

    await service.recordConflict(CONFLICT_INPUT, transactionContext);
    conflicts.store[0].decision = 'CLOUD';
    conflicts.store[0].confirmedByAccountId = 900101;

    await service.recordConflict(
      { ...CONFLICT_INPUT, conflictReason: '云端再次变化' },
      transactionContext,
    );

    expect(conflicts.store).toHaveLength(1);
    expect(conflicts.store[0].decision).toBe('CLOUD');
    expect(conflicts.store[0].confirmedByAccountId).toBe(900101);
    expect(conflicts.store[0].conflictReason).toBe('云端再次变化');
    expect(conflicts.store[0].status).toBe('PENDING');
  });

  it('导入回执：必须写 received_at（真实库 CHECK 约束要求可证明确认事件）', async () => {
    const { service, receipts, transactionContext } = buildService();

    await service.recordImportedVersion(
      {
        organizationId: 9,
        resourceType: 'MAINTENANCE_REPORT',
        recordUuid: 'uuid-1',
        versionNo: 2,
        manifestChecksum: 'a'.repeat(64),
        sourceInstallationId: 'source-installation-1',
      },
      transactionContext,
    );

    const inserted = receipts.insert.mock.calls[0]?.[0] as unknown as {
      receivedAt: Date | null;
      receiptStatus: string;
      sourceSystem: string;
      confirmedAt?: Date | null;
    };
    expect(inserted.receiptStatus).toBe('SUCCEEDED');
    // `chk_sync_receipt_source`：source_system 只能是 'LOCAL' / 'CLOUD'
    expect(inserted.sourceSystem).toBe('LOCAL');
    // `chk_sync_receipt_confirm_time`：非 PENDING/CONFLICT 必须有 received_at 或 confirmed_at
    expect(inserted.receivedAt).toBeInstanceOf(Date);
    // 旧版确认事件字段不双写
    expect(inserted.confirmedAt ?? null).toBeNull();
  });

  it('并发唯一键竞争：败方幂等复用胜方的回执行（不抛原始 DB 错误）', async () => {
    const { service, receipts, transactionContext } = buildService();
    const key = {
      organizationId: 9,
      resourceType: 'MAINTENANCE_REPORT',
      recordUuid: 'uuid-race',
      versionNo: 2,
    };
    // 模拟并发：第一次插入成功；第二次插入被唯一键拒绝（ER_DUP_ENTRY）
    receipts.insert.mockImplementationOnce((entity: Row) => {
      receipts.store.push({ ...entity });
      return Promise.resolve(undefined);
    });
    receipts.insert.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error('duplicate'), { driverError: { code: 'ER_DUP_ENTRY' } }),
      ),
    );

    const [winner, loser] = await Promise.all([
      service.recordImportedVersion(
        { ...key, manifestChecksum: 'a'.repeat(64), sourceInstallationId: 'inst-x' },
        transactionContext,
      ),
      service.recordImportedVersion(
        { ...key, manifestChecksum: 'a'.repeat(64), sourceInstallationId: 'inst-x' },
        transactionContext,
      ),
    ]);

    // 双方拿到同一个回执 ID（"并发重复只一修订"）
    expect(loser).toBe(winner);
    expect(receipts.store).toHaveLength(1);
  });
});
