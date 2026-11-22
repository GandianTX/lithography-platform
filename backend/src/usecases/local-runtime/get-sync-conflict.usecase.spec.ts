/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import type { LocalRuntimeViewerScope } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';

import { GetSyncConflictUsecase } from './get-sync-conflict.usecase';
import type { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { SyncConflictAccessResolver } from './sync-conflict-access.resolver';
import type { SyncConflictMetadataRow } from '@src/modules/lithography/queries/sync-conflict.query.service';
import type {
  SyncSourceRecordFact,
  SyncSourceRecordQueryService,
} from '@src/modules/lithography/queries/sync-source-record.query.service';

/**
 * 冲突详情读侧（任务 09 后续S2·S2.2）。
 *
 * 覆盖口径：先查元数据授权再读正文；授权不通过、事实不可得、范围外与不存在
 * 一律同码返回（不区分原因，不通过存在性泄露）。
 */
describe('GetSyncConflictUsecase', () => {
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

  const metadata: SyncConflictMetadataRow = {
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
  };

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
    metadata?: SyncConflictMetadataRow | null;
    facts?: SyncSourceRecordFact[];
  }) {
    const scopeResolver = {
      resolve: jest.fn(() => Promise.resolve(engineerScope)),
    };
    const syncConflictQueryService = {
      readMetadataById: jest.fn(() =>
        Promise.resolve(options.metadata === undefined ? metadata : options.metadata),
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

    const usecase = new GetSyncConflictUsecase(
      scopeResolver as unknown as LocalRuntimeScopeResolver,
      syncConflictQueryService as never,
      accessResolver,
      sourceRecordQueryService as never,
    );

    return { usecase, syncConflictQueryService };
  }

  it('授权通过时返回三方版本与正文快照', async () => {
    const { usecase, syncConflictQueryService } = buildUsecase({});

    const conflict = await usecase.execute({ session, conflictId: 'conflict-1' });

    expect(conflict.conflictId).toBe('conflict-1');
    expect(conflict.localSnapshot).toBe('local:conflict-1');
    expect(conflict.cloudSnapshot).toBe('cloud:conflict-1');
    expect(syncConflictQueryService.readSnapshots).toHaveBeenCalledWith(['conflict-1']);
  });

  it('记录归属跨公司时同码返回，且不读取正文快照', async () => {
    const { usecase, syncConflictQueryService } = buildUsecase({
      facts: [recordFact({ ownerOrganizationId: 5 })],
    });

    await expect(usecase.execute({ session, conflictId: 'conflict-1' })).rejects.toMatchObject({
      code: SYNC_ERROR.CONFLICT_NOT_FOUND,
    });
    expect(syncConflictQueryService.readSnapshots).not.toHaveBeenCalled();
  });

  it('记录归属未知时同码返回', async () => {
    const { usecase } = buildUsecase({ facts: [recordFact({ ownerOrganizationId: null })] });

    await expect(usecase.execute({ session, conflictId: 'conflict-1' })).rejects.toMatchObject({
      code: SYNC_ERROR.CONFLICT_NOT_FOUND,
    });
  });

  it('来源记录事实取不到时同码返回', async () => {
    const { usecase } = buildUsecase({ facts: [] });

    await expect(usecase.execute({ session, conflictId: 'conflict-1' })).rejects.toMatchObject({
      code: SYNC_ERROR.CONFLICT_NOT_FOUND,
    });
  });

  it('冲突不存在时同码返回', async () => {
    const { usecase } = buildUsecase({ metadata: null });

    await expect(usecase.execute({ session, conflictId: 'missing' })).rejects.toMatchObject({
      code: SYNC_ERROR.CONFLICT_NOT_FOUND,
    });
  });
});
