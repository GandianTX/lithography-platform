/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';

import type { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import type { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import type {
  SyncSourceRecordFact,
  SyncSourceRecordQueryService,
} from '@src/modules/lithography/queries/sync-source-record.query.service';
import type {
  SyncStatusConflictRow,
  SyncStatusQueryService,
  SyncStatusReceiptRow,
  SyncStatusTaskRow,
} from '@src/modules/lithography/queries/sync-status.query.service';
import { QuerySyncStatusesUsecase } from './query-sync-statuses.usecase';
import { SYNC_STATUS_QUERY_MAX_BATCH } from './sync-status.contract';

/**
 * 同步状态批量查询用例（任务 09 后续S1）。
 *
 * 覆盖口径：只返回授权通过的记录；仅任务成功不得判已同步；摘要必须一致；
 * 旧版本回执／旧版本冲突不得误报当前版本；授权失效只认授权主体账号；
 * 非法资源类型逐条跳过而不是整批失败。
 */
describe('QuerySyncStatusesUsecase', () => {
  const session = {
    accountId: 900101,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
  } as unknown as UsecaseSession;

  const recordUuid = 'aaaaaaaa-1111-5111-8111-aaaaaaaaaaaa';
  const manifestChecksum = 'a'.repeat(64);

  const sourceFact = (overrides: Partial<SyncSourceRecordFact> = {}): SyncSourceRecordFact => ({
    resourceType: 'MAINTENANCE_REPORT',
    recordUuid,
    recordId: 12,
    ownerOrganizationId: 4,
    currentVersion: 3,
    versionTrusted: true,
    materialApplicable: true,
    relatedAccountIds: [900101],
    authorizationSubjectAccountId: 900101,
    withdrawn: false,
    identityPersisted: true,
    ...overrides,
  });

  function buildUsecase(
    options: {
      facts?: SyncSourceRecordFact[];
      scanComplete?: boolean;
      tasks?: SyncStatusTaskRow[];
      legacyTaskUuids?: string[];
      receipts?: SyncStatusReceiptRow[];
      conflicts?: SyncStatusConflictRow[];
      authorizations?: Map<number, 'ACTIVE' | 'REVOKED'>;
      /** 公司级授权事实（ACTIVE／REVOKED 行数；未列出＝该公司无任何授权行） */
      companyAuthorization?: { activeCount: number; revokedCount: number };
      installationOrganizationId?: number | null;
    } = {},
  ) {
    const scopeResolver = {
      resolve: jest.fn(() =>
        Promise.resolve({ role: 'ENGINEER', organizationId: 4, adminLevel: null }),
      ),
    };
    const localRuntimeQueryService = {
      readInstallation: jest.fn(() =>
        Promise.resolve({
          installationId: 'inst-1',
          organizationId:
            options.installationOrganizationId === undefined
              ? 4
              : options.installationOrganizationId,
        }),
      ),
      // 公司级「正式运行模式」事实：复用既有本地授权汇总读模型
      readAuthorizationSummary: jest.fn(() => {
        const summary = options.companyAuthorization ?? { activeCount: 1, revokedCount: 0 };
        return Promise.resolve([
          {
            organizationId:
              options.installationOrganizationId === undefined
                ? 4
                : options.installationOrganizationId,
            activeCount: summary.activeCount,
            revokedCount: summary.revokedCount,
            lastVerifiedAt: null,
          },
        ]);
      }),
    };
    const sourceRecordQueryService = {
      listFacts: jest.fn(() => {
        const facts = new Map<string, SyncSourceRecordFact>();
        for (const fact of options.facts ?? [sourceFact()]) {
          facts.set(fact.recordUuid, fact);
        }
        return Promise.resolve({ facts, scanComplete: options.scanComplete ?? true });
      }),
    };
    const syncStatusQueryService = {
      readBusinessSyncTasks: jest.fn(() => Promise.resolve(options.tasks ?? [])),
      readLegacyTaskUuids: jest.fn(() => Promise.resolve(options.legacyTaskUuids ?? [])),
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

    return { usecase, syncStatusQueryService, sourceRecordQueryService };
  }

  const request = {
    organizationId: 4,
    resourceType: 'MAINTENANCE_REPORT',
    recordUuid,
    sourceVersion: 3,
  };

  const succeededTask: SyncStatusTaskRow = {
    recordUuid,
    sourceVersion: 3,
    status: 'SUCCEEDED',
    manifestChecksum,
    entityType: 'REPORT_VERSION',
  };

  const succeededReceipt: SyncStatusReceiptRow = {
    recordUuid,
    versionNo: 3,
    receiptStatus: 'SUCCEEDED',
    manifestChecksum,
    sourceInstallationId: 'inst-1',
  };

  it('当前版本有完整成功回执时返回已同步，并回显服务端认定的版本', async () => {
    const { usecase } = buildUsecase({
      tasks: [succeededTask],
      receipts: [succeededReceipt],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('SYNCED');
    expect(items[0].sourceVersion).toBe(3);
    expect(items[0].requestedVersion).toBe(3);
    expect(items[0].versionAligned).toBe(true);
    expect(items[0].reasonCode).toBeNull();
  });

  it('仅任务成功但没有回执时不得判已同步', async () => {
    const { usecase } = buildUsecase({ tasks: [succeededTask] });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('UNKNOWN');
    expect(items[0].reasonCode).toBe('RECEIPT_MISSING');
  });

  it('回执版本与当前版本不一致时不得判已同步', async () => {
    const { usecase } = buildUsecase({
      tasks: [succeededTask],
      receipts: [{ ...succeededReceipt, versionNo: 2 }],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('UNKNOWN');
    expect(items[0].reasonCode).toBe('RECEIPT_VERSION_MISMATCH');
  });

  it('回执摘要与任务登记摘要不一致时不得判已同步', async () => {
    const { usecase } = buildUsecase({
      tasks: [succeededTask],
      receipts: [{ ...succeededReceipt, manifestChecksum: 'b'.repeat(64) }],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('UNKNOWN');
    expect(items[0].reasonCode).toBe('RECEIPT_INCOMPLETE');
  });

  it('回执来源安装不是本机时不得判已同步', async () => {
    const { usecase } = buildUsecase({
      tasks: [succeededTask],
      receipts: [{ ...succeededReceipt, sourceInstallationId: 'inst-other' }],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('UNKNOWN');
    expect(items[0].reasonCode).toBe('RECEIPT_SOURCE_UNCONFIRMED');
  });

  it('草稿报告版本不可信时返回未知', async () => {
    const { usecase } = buildUsecase({
      facts: [sourceFact({ currentVersion: null, versionTrusted: false })],
      tasks: [{ ...succeededTask, sourceVersion: 0, status: 'PENDING' }],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('UNKNOWN');
    expect(items[0].reasonCode).toBe('VERSION_UNTRUSTED');
    expect(items[0].sourceVersion).toBeNull();
    expect(items[0].versionAligned).toBeNull();
  });

  it('跨公司记录不返回条目（不泄露记录是否存在）', async () => {
    const { usecase } = buildUsecase({
      facts: [sourceFact({ ownerOrganizationId: 5 })],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items).toHaveLength(0);
  });

  it('调用方传入的公司与来源事实不一致时不返回条目', async () => {
    const { usecase } = buildUsecase();

    const items = await usecase.queryStatuses({
      session,
      requests: [{ ...request, organizationId: 5 }],
    });

    expect(items).toHaveLength(0);
  });

  it('本机找不到来源记录时不返回条目', async () => {
    const { usecase } = buildUsecase({ facts: [] });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items).toHaveLength(0);
  });

  it('来源扫描不完整时把无法还原的记录判为未知，而不是断言不存在', async () => {
    const { usecase } = buildUsecase({ facts: [], scanComplete: false });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('UNKNOWN');
    expect(items[0].reasonCode).toBe('IDENTITY_UNTRUSTED');
  });

  it('本机未映射云端组织时返回空条目（无法确定本机数据区）', async () => {
    const { usecase } = buildUsecase({ installationOrganizationId: null });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items).toHaveLength(0);
  });

  it('授权主体账号授权失效时返回授权失效', async () => {
    const { usecase } = buildUsecase({
      facts: [sourceFact({ relatedAccountIds: [900102], authorizationSubjectAccountId: 900102 })],
      authorizations: new Map<number, 'ACTIVE' | 'REVOKED'>([[900102, 'REVOKED']]),
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('AUTHORIZATION_INVALID');
    expect(items[0].canResolveConflict).toBe(false);
  });

  it('无关关联账号的授权失效不影响本记录', async () => {
    const { usecase } = buildUsecase({
      facts: [
        sourceFact({
          relatedAccountIds: [900101, 900999],
          authorizationSubjectAccountId: 900101,
        }),
      ],
      authorizations: new Map<number, 'ACTIVE' | 'REVOKED'>([
        [900101, 'ACTIVE'],
        [900999, 'REVOKED'],
      ]),
      tasks: [succeededTask],
      receipts: [succeededReceipt],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('SYNCED');
  });

  it('旧版本的待处理冲突不误报当前版本', async () => {
    const { usecase } = buildUsecase({
      conflicts: [
        {
          conflictId: 'conflict-old',
          recordUuid,
          organizationId: 4,
          status: 'PENDING',
          localVersion: 1,
          cloudVersion: 2,
          versionNo: 1,
          displayedCloudVersion: 2,
        },
      ],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).not.toBe('CONFLICT');
    expect(items[0].conflictId).toBeNull();
  });

  it('当前版本存在待处理冲突时返回冲突，且写权与展示版本一致时给出处理入口', async () => {
    const { usecase } = buildUsecase({
      conflicts: [
        {
          conflictId: 'conflict-1',
          recordUuid,
          organizationId: 4,
          status: 'PENDING',
          localVersion: 3,
          cloudVersion: 4,
          versionNo: 3,
          displayedCloudVersion: 4,
        },
      ],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('CONFLICT');
    expect(items[0].conflictId).toBe('conflict-1');
    expect(items[0].canResolveConflict).toBe(true);
  });

  it('冲突仅以「登记时已展示的云端版本」命中当前版本时，同样识别为当前版本冲突', async () => {
    const { usecase } = buildUsecase({
      conflicts: [
        {
          conflictId: 'conflict-displayed',
          recordUuid,
          organizationId: 4,
          status: 'PENDING',
          localVersion: null,
          cloudVersion: null,
          versionNo: null,
          // 版本位只登记在"已展示的云端版本"上
          displayedCloudVersion: 3,
        },
      ],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('CONFLICT');
    expect(items[0].conflictId).toBe('conflict-displayed');
    expect(items[0].canResolveConflict).toBe(true);
  });

  it('调用方展示版本与服务端当前版本不一致时不给出处理入口', async () => {
    const { usecase } = buildUsecase({
      conflicts: [
        {
          conflictId: 'conflict-1',
          recordUuid,
          organizationId: 4,
          status: 'PENDING',
          localVersion: 3,
          cloudVersion: 4,
          versionNo: 3,
          displayedCloudVersion: 4,
        },
      ],
    });

    const items = await usecase.queryStatuses({
      session,
      requests: [{ ...request, sourceVersion: 2 }],
    });

    expect(items[0].status).toBe('CONFLICT');
    expect(items[0].canResolveConflict).toBe(false);
    expect(items[0].versionAligned).toBe(false);
  });

  it('调用方未提供展示版本时不给出处理入口', async () => {
    const { usecase } = buildUsecase({
      conflicts: [
        {
          conflictId: 'conflict-1',
          recordUuid,
          organizationId: 4,
          status: 'PENDING',
          localVersion: 3,
          cloudVersion: 4,
          versionNo: 3,
          displayedCloudVersion: 4,
        },
      ],
    });

    const items = await usecase.queryStatuses({
      session,
      requests: [{ ...request, sourceVersion: null }],
    });

    expect(items[0].canResolveConflict).toBe(false);
  });

  it('冲突不属于本公司数据区时不给出处理入口', async () => {
    const { usecase } = buildUsecase({
      conflicts: [
        {
          conflictId: 'conflict-1',
          recordUuid,
          organizationId: 9,
          status: 'PENDING',
          localVersion: 3,
          cloudVersion: 4,
          versionNo: 3,
          displayedCloudVersion: 4,
        },
      ],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].canResolveConflict).toBe(false);
  });

  it('公司存在 ACTIVE 授权时材料级适用即判定为适用', async () => {
    const { usecase } = buildUsecase({
      companyAuthorization: { activeCount: 1, revokedCount: 1 },
      tasks: [succeededTask],
      receipts: [succeededReceipt],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('SYNCED');
  });

  it('公司授权全部撤销时判定为不适用', async () => {
    const { usecase } = buildUsecase({
      companyAuthorization: { activeCount: 0, revokedCount: 2 },
      tasks: [succeededTask],
      receipts: [succeededReceipt],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('NOT_APPLICABLE');
    expect(items[0].reasonCode).toBeNull();
  });

  it('未取得公司授权事实时不得把适用性硬编码为真', async () => {
    const { usecase } = buildUsecase({
      companyAuthorization: { activeCount: 0, revokedCount: 0 },
      tasks: [succeededTask],
      receipts: [succeededReceipt],
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('UNKNOWN');
    expect(items[0].reasonCode).toBe('APPLICABILITY_UNKNOWN');
  });

  it('材料级明确不适用时不再受公司级事实影响', async () => {
    const { usecase } = buildUsecase({
      facts: [sourceFact({ materialApplicable: false })],
      companyAuthorization: { activeCount: 1, revokedCount: 0 },
    });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('NOT_APPLICABLE');
  });

  it('存在用途无法确认的历史任务时不得断言没有任务', async () => {
    const { usecase } = buildUsecase({ legacyTaskUuids: [recordUuid] });

    const items = await usecase.queryStatuses({ session, requests: [request] });

    expect(items[0].status).toBe('UNKNOWN');
    expect(items[0].reasonCode).toBe('TASK_KIND_UNKNOWN');
  });

  it('非法资源类型逐条跳过，不让同批合法记录失败', async () => {
    const { usecase } = buildUsecase({
      tasks: [succeededTask],
      receipts: [succeededReceipt],
    });

    const items = await usecase.queryStatuses({
      session,
      requests: [{ ...request, resourceType: 'REPORT' }, request],
    });

    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('SYNCED');
  });

  it('批量超过上限时明确拒绝', async () => {
    const { usecase } = buildUsecase();

    const requests = Array.from({ length: SYNC_STATUS_QUERY_MAX_BATCH + 1 }, (_unused, index) => ({
      ...request,
      recordUuid: `${index}`,
    }));

    await expect(usecase.queryStatuses({ session, requests })).rejects.toThrow('不能超过');
  });

  it('相同完整键重复出现时只返回一条', async () => {
    const { usecase } = buildUsecase({
      tasks: [succeededTask],
      receipts: [succeededReceipt],
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
