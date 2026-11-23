/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { LocalRuntimeViewerScope } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';

import type { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { ListSyncConflictsUsecase } from './list-sync-conflicts.usecase';
import { SyncConflictAccessResolver } from './sync-conflict-access.resolver';
import type { SyncConflictMetadataRow } from '@src/modules/lithography/queries/sync-conflict.query.service';
import type {
  SyncSourceRecordFact,
  SyncSourceRecordQueryService,
} from '@src/modules/lithography/queries/sync-source-record.query.service';

/**
 * 冲突清单读侧（任务 09 后续S2·S2.2）。
 *
 * 覆盖口径：先查元数据授权再读正文；授权不通过与事实不可得的条目整条不返回；
 * 正文快照只对授权通过的条目读取；分页与总数按授权过滤后的集合计算。
 */
describe('ListSyncConflictsUsecase', () => {
  const session = {
    accountId: 900101,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
  } as unknown as UsecaseSession;

  const engineerScope: LocalRuntimeViewerScope = {
    role: 'ENGINEER',
    organizationId: 4,
    adminLevel: null,
  };
  const adminScope: LocalRuntimeViewerScope = {
    role: 'ADMIN_LEVEL_1',
    organizationId: null,
    adminLevel: 1,
  };

  const metadata = (overrides: Partial<SyncConflictMetadataRow> = {}): SyncConflictMetadataRow => ({
    conflictId: 'conflict-1',
    recordUuid: 'aaaaaaaa-1111-5111-8111-aaaaaaaaaaaa',
    organizationId: 4,
    resourceType: 'MAINTENANCE_REPORT',
    versionNo: 3,
    localVersion: 3,
    cloudVersion: 4,
    displayedCloudVersion: 4,
    decision: null,
    status: 'PENDING',
    conflictReason: '版本不一致',
    confirmedByAccountId: null,
    confirmedAt: null,
    createdAt: new Date('2026-11-22T00:00:00.000Z'),
    ...overrides,
  });

  const recordFact = (overrides: Partial<SyncSourceRecordFact> = {}): SyncSourceRecordFact => ({
    resourceType: 'MAINTENANCE_REPORT',
    recordUuid: 'aaaaaaaa-1111-5111-8111-aaaaaaaaaaaa',
    recordId: 12,
    ownerOrganizationId: 4,
    currentVersion: 3,
    versionTrusted: true,
    materialApplicable: true,
    relatedAccountIds: [900101],
    authorizationSubjectAccountId: 900101,
    withdrawn: false,
    identityPersisted: true,
    // 只读事实：默认可写（未删除／未冻结／未结单）
    contentState: { withdrawn: false, frozen: false, closed: false },
    ...overrides,
  });

  function buildUsecase(options: {
    scope?: LocalRuntimeViewerScope;
    rows?: SyncConflictMetadataRow[];
    truncated?: boolean;
    facts?: SyncSourceRecordFact[];
  }) {
    const scopeResolver = {
      resolve: jest.fn(() => Promise.resolve(options.scope ?? engineerScope)),
    };
    const syncConflictQueryService = {
      listMetadataForScope: jest.fn(() =>
        Promise.resolve({
          rows: options.rows ?? [metadata()],
          truncated: options.truncated ?? false,
        }),
      ),
      readSnapshots: jest.fn((conflictIds: readonly string[]) => {
        const payloads = new Map<string, { localSnapshot: string; cloudSnapshot: string }>();
        for (const conflictId of conflictIds) {
          payloads.set(conflictId, {
            localSnapshot: `local:${conflictId}`,
            cloudSnapshot: `cloud:${conflictId}`,
          });
        }
        return Promise.resolve(payloads);
      }),
    };
    const sourceRecordQueryService = {
      listFacts: jest.fn(() => {
        const facts = new Map<string, SyncSourceRecordFact>();
        for (const fact of options.facts ?? [recordFact()]) {
          facts.set(fact.recordUuid, fact);
        }
        return Promise.resolve({ facts, scanComplete: true });
      }),
    };
    const accessResolver = new SyncConflictAccessResolver(
      sourceRecordQueryService as unknown as SyncSourceRecordQueryService,
    );

    const usecase = new ListSyncConflictsUsecase(
      scopeResolver as unknown as LocalRuntimeScopeResolver,
      syncConflictQueryService as never,
      accessResolver,
    );

    return { usecase, syncConflictQueryService, sourceRecordQueryService };
  }

  it('同公司可见记录正常返回，正文快照按授权通过条目读取', async () => {
    const { usecase, syncConflictQueryService } = buildUsecase({});

    const page = await usecase.execute({ session });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].conflictId).toBe('conflict-1');
    expect(page.items[0].localSnapshot).toBe('local:conflict-1');
    expect(page.items[0].cloudSnapshot).toBe('cloud:conflict-1');
    expect(syncConflictQueryService.readSnapshots).toHaveBeenCalledWith(['conflict-1']);
  });

  it('记录归属跨公司时条目整条不返回，且不读取其正文快照', async () => {
    const { usecase, syncConflictQueryService } = buildUsecase({
      facts: [recordFact({ ownerOrganizationId: 5 })],
    });

    const page = await usecase.execute({
      session,
      pagination: { page: 1, pageSize: 20, withTotal: true },
    });

    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(0);
    expect(syncConflictQueryService.readSnapshots).toHaveBeenCalledWith([]);
  });

  it('记录归属未知时条目不返回（不猜归属）', async () => {
    const { usecase } = buildUsecase({
      facts: [recordFact({ ownerOrganizationId: null })],
    });

    const page = await usecase.execute({ session });

    expect(page.items).toHaveLength(0);
  });

  it('来源记录事实取不到时条目不返回（读不到授权依据不等于有权看）', async () => {
    const { usecase, syncConflictQueryService } = buildUsecase({ facts: [] });

    const page = await usecase.execute({ session });

    expect(page.items).toHaveLength(0);
    expect(syncConflictQueryService.readSnapshots).toHaveBeenCalledWith([]);
  });

  it('一级管理员可见跨公司冲突', async () => {
    const { usecase } = buildUsecase({
      scope: adminScope,
      rows: [metadata({ organizationId: 5 })],
      facts: [recordFact({ ownerOrganizationId: 5 })],
    });

    const page = await usecase.execute({ session });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].organizationId).toBe(5);
  });

  it('总数与分页按授权过滤后的集合计算', async () => {
    const { usecase } = buildUsecase({
      rows: [
        metadata({ conflictId: 'conflict-1' }),
        metadata({ conflictId: 'conflict-2', recordUuid: 'bbbbbbbb-1111-5111-8111-bbbbbbbbbbbb' }),
      ],
      facts: [
        recordFact(),
        recordFact({
          recordUuid: 'bbbbbbbb-1111-5111-8111-bbbbbbbbbbbb',
          ownerOrganizationId: 5,
        }),
      ],
    });

    const page = await usecase.execute({
      session,
      pagination: { page: 1, pageSize: 20, withTotal: true },
    });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it('快照缺失（并发删除）时不返回半成品条目，也不伪造"正文为空"', async () => {
    const { usecase, syncConflictQueryService } = buildUsecase({});
    syncConflictQueryService.readSnapshots.mockResolvedValue(new Map());

    const page = await usecase.execute({ session });

    expect(page.items).toHaveLength(0);
  });

  it('候选超过扫描上限时如实标记截断', async () => {
    const { usecase } = buildUsecase({ truncated: true });

    const page = await usecase.execute({ session });

    expect(page.truncated).toBe(true);
  });

  it('不请求总数时不返回 total', async () => {
    const { usecase } = buildUsecase({});

    const page = await usecase.execute({ session });

    expect(page.total).toBeUndefined();
  });

  it('清单条目如实给出来源只读标记与采用准入（与详情页同一口径）', async () => {
    const { usecase } = buildUsecase({
      facts: [recordFact({ contentState: { withdrawn: false, frozen: false, closed: false } })],
    });

    const page = await usecase.execute({ session });

    expect(page.items[0].sourceRecordId).toBe(12);
    expect(page.items[0].sourceReadOnly).toBe(false);
    expect(page.items[0].sourceReadOnlyReason).toBeNull();
    expect(page.items[0].canAdoptCloud).toBe(true);
    expect(page.items[0].adoptionReadOnly).toBe(false);
  });

  it('来源已冻结：清单不得显示"可采用"', async () => {
    const { usecase } = buildUsecase({
      facts: [recordFact({ contentState: { withdrawn: false, frozen: true, closed: false } })],
    });

    const page = await usecase.execute({ session });

    expect(page.items[0].sourceReadOnly).toBe(true);
    expect(page.items[0].sourceReadOnlyReason).toBe('SOURCE_FROZEN');
    expect(page.items[0].canAdoptCloud).toBe(false);
  });

  it('来源已结单：允许只读采用（不获得写入权）', async () => {
    const { usecase } = buildUsecase({
      facts: [recordFact({ contentState: { withdrawn: false, frozen: false, closed: true } })],
    });

    const page = await usecase.execute({ session });

    expect(page.items[0].sourceReadOnly).toBe(true);
    expect(page.items[0].sourceReadOnlyReason).toBe('SOURCE_CLOSED');
    expect(page.items[0].canAdoptCloud).toBe(true);
    expect(page.items[0].adoptionReadOnly).toBe(true);
  });
});
