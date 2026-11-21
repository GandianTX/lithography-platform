/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';

import type { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import type { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import type {
  SyncSourceRecordFact,
  SyncSourceRecordQueryService,
  SyncSourceResourceType,
} from '@src/modules/lithography/queries/sync-source-record.query.service';
import type {
  SyncStatusConflictRow,
  SyncStatusQueryService,
  SyncStatusReceiptRow,
  SyncStatusTaskRow,
} from '@src/modules/lithography/queries/sync-status.query.service';
import { QuerySyncStatusesUsecase } from './query-sync-statuses.usecase';

/**
 * 同步状态批量查询用例（任务 09 后续S1）。
 *
 * 覆盖口径：只返回授权通过的记录；仅任务成功不得判已同步；旧版本回执不得判已同步；
 * 授权失效不得由他人接管；草稿版本不可信时返回未知。
 */
describe('QuerySyncStatusesUsecase', () => {
  const session = {
    accountId: 900101,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
  } as unknown as UsecaseSession;

  const recordUuid = 'aaaaaaaa-1111-5111-8111-aaaaaaaaaaaa';

  const sourceFact = (overrides: Partial<SyncSourceRecordFact> = {}): SyncSourceRecordFact => ({
    resourceType: 'MAINTENANCE_REPORT',
    recordUuid,
    recordId: 12,
    ownerOrganizationId: 4,
    currentVersion: 3,
    versionTrusted: true,
    applicable: true,
    relatedAccountIds: [900101],
    withdrawn: false,
    ...overrides,
  });

  function buildUsecase(
    options: {
      facts?: SyncSourceRecordFact[];
      tasks?: SyncStatusTaskRow[];
      receipts?: SyncStatusReceiptRow[];
      conflicts?: SyncStatusConflictRow[];
      authorizations?: Map<number, 'ACTIVE' | 'REVOKED'>;
      installationId?: string | null;
    } = {},
  ) {
    const scopeResolver = {
      resolve: jest.fn(() =>
        Promise.resolve({ role: 'ENGINEER', organizationId: 4, adminLevel: null }),
      ),
    };
    const localRuntimeQueryService = {
      readInstallation: jest.fn(() =>
        Promise.resolve(
          options.installationId === null
            ? null
            : { installationId: options.installationId ?? 'inst-1', organizationId: 4 },
        ),
      ),
    };
    const sourceRecordQueryService = {
      listFacts: jest.fn((_organizationId: number, _resourceType: SyncSourceResourceType) =>
        Promise.resolve(options.facts ?? [sourceFact()]),
      ),
    };
    const syncStatusQueryService = {
      readBusinessSyncTasks: jest.fn(() => Promise.resolve(options.tasks ?? [])),
      readReceipts: jest.fn(() => Promise.resolve(options.receipts ?? [])),
      readPendingConflicts: jest.fn(() => Promise.resolve(options.conflicts ?? [])),
      readAuthorizations: jest.fn(() =>
        Promise.resolve(options.authorizations ?? new Map<number, 'ACTIVE' | 'REVOKED'>()),
      ),
    };

    const usecase = new QuerySyncStatusesUsecase(
      scopeResolver as unknown as LocalRuntimeScopeResolver,
      localRuntimeQueryService as unknown as LocalRuntimeQueryService,
      sourceRecordQueryService as unknown as SyncSourceRecordQueryService,
      syncStatusQueryService as unknown as SyncStatusQueryService,
    );

    return { usecase, syncStatusQueryService };
  }

  const request = {
    organizationId: 4,
    resourceType: 'MAINTENANCE_REPORT',
    recordUuid,
    sourceVersion: 3,
  };

  it('当前版本有完整成功回执时返回已同步，并回显服务端认定的版本', async () => {
    const { usecase } = buildUsecase({
      tasks: [{ recordUuid, sourceVersion: 3, status: 'SUCCEEDED' }],
      receipts: [
        {
          recordUuid,
          versionNo: 3,
          receiptStatus: 'SUCCEEDED',
          manifestChecksum: 'a'.repeat(64),
        },
      ],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('SYNCED');
    expect(items[0].sourceVersion).toBe(3);
    expect(items[0].reasonCode).toBeNull();
  });

  it('仅任务成功但没有回执时不得判已同步', async () => {
    const { usecase } = buildUsecase({
      tasks: [{ recordUuid, sourceVersion: 3, status: 'SUCCEEDED' }],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('UNKNOWN');
    expect(items[0].reasonCode).toBe('RECEIPT_MISSING');
  });

  it('回执版本与当前版本不一致时不得判已同步', async () => {
    const { usecase } = buildUsecase({
      // 当前版本（3）的任务已成功，但回执落在旧版本（2）上
      tasks: [{ recordUuid, sourceVersion: 3, status: 'SUCCEEDED' }],
      receipts: [
        {
          recordUuid,
          versionNo: 2,
          receiptStatus: 'SUCCEEDED',
          manifestChecksum: 'a'.repeat(64),
        },
      ],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('UNKNOWN');
    expect(items[0].reasonCode).toBe('RECEIPT_VERSION_MISMATCH');
  });

  it('草稿报告版本不可信时返回未知', async () => {
    const { usecase } = buildUsecase({
      facts: [sourceFact({ currentVersion: null, versionTrusted: false })],
      tasks: [{ recordUuid, sourceVersion: 0, status: 'PENDING' }],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('UNKNOWN');
    expect(items[0].reasonCode).toBe('VERSION_UNTRUSTED');
    expect(items[0].sourceVersion).toBeNull();
  });

  it('跨公司记录不返回条目（不泄露记录是否存在）', async () => {
    const { usecase } = buildUsecase({
      facts: [sourceFact({ ownerOrganizationId: 5 })],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items).toHaveLength(0);
  });

  it('本机找不到来源记录时不返回条目', async () => {
    const { usecase } = buildUsecase({ facts: [] });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items).toHaveLength(0);
  });

  it('本机未安装时返回空条目（没有可信的本机事实来源）', async () => {
    const { usecase } = buildUsecase({ installationId: null });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items).toHaveLength(0);
  });

  it('原记录账号授权失效时返回授权失效，且不给出冲突处理入口', async () => {
    const { usecase } = buildUsecase({
      facts: [sourceFact({ relatedAccountIds: [900102] })],
      authorizations: new Map<number, 'ACTIVE' | 'REVOKED'>([[900102, 'REVOKED']]),
      conflicts: [
        {
          conflictId: 'conflict-1',
          recordUuid,
          status: 'PENDING',
          localVersion: 3,
          cloudVersion: 4,
        },
      ],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('AUTHORIZATION_INVALID');
    expect(items[0].canResolveConflict).toBe(false);
    expect(items[0].conflictId).toBeNull();
  });

  it('当前版本存在待处理冲突时返回冲突', async () => {
    const { usecase } = buildUsecase({
      conflicts: [
        {
          conflictId: 'conflict-1',
          recordUuid,
          status: 'PENDING',
          localVersion: 3,
          cloudVersion: 4,
        },
      ],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('CONFLICT');
    expect(items[0].conflictId).toBe('conflict-1');
    expect(items[0].canResolveConflict).toBe(false);
  });

  it('只读取业务同步任务：备份上云任务由查询层隔离', async () => {
    const { usecase, syncStatusQueryService } = buildUsecase({
      tasks: [{ recordUuid, sourceVersion: 3, status: 'UPLOADING' }],
    });

    await usecase.queryStatuses({ session, requests: [request] });

    expect(syncStatusQueryService.readBusinessSyncTasks).toHaveBeenCalledWith('inst-1', [
      recordUuid,
    ]);
  });

  it('相同完整键重复出现时只返回一条', async () => {
    const { usecase } = buildUsecase({
      tasks: [{ recordUuid, sourceVersion: 3, status: 'SUCCEEDED' }],
      receipts: [
        {
          recordUuid,
          versionNo: 3,
          receiptStatus: 'SUCCEEDED',
          manifestChecksum: 'a'.repeat(64),
        },
      ],
    });

    const items = await usecase.queryStatuses({ session, requests: [request, request] });

    expect(items).toHaveLength(1);
  });

  it('空请求直接返回空结果', async () => {
    const { usecase } = buildUsecase();

    const items = await usecase.queryStatuses({ session, requests: [] });

    expect(items).toHaveLength(0);
  });
});
