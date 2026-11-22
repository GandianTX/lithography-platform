/// <reference types="jest" />
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { SyncConflictService } from '@src/modules/lithography/sync-conflict.service';
import type {
  SyncConflictSnapshot,
  SyncConflictSummary,
} from '@src/modules/lithography/sync.types';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { SyncSourceRecordQueryService } from '@src/modules/lithography/queries/sync-source-record.query.service';
import type { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import type { SyncConflictAccessResolver } from './sync-conflict-access.resolver';
import { ResolveSyncConflictUsecase } from './resolve-sync-conflict.usecase';

/**
 * 冲突裁决用例：范围收敛、"重复请求返回既有事实"与「保留本地」的受控写入编排。
 * 裁决规则本身在 core 策略 spec 中覆盖，这里覆盖范围与写入编排。
 */
describe('ResolveSyncConflictUsecase', () => {
  const session = { accountId: 900101 } as UsecaseSession;
  const transactionContext = Object.freeze({});

  const conflict: SyncConflictSnapshot = {
    conflictId: 'c-1',
    recordUuid: 'record-uuid-1',
    organizationId: 4,
    resourceType: 'REPAIR_REQUEST',
    versionNo: 3,
    localVersion: 4,
    cloudVersion: 5,
    displayedCloudVersion: 5,
    decision: null,
    status: 'PENDING',
    localSnapshot: JSON.stringify({ schema_version: 1, content_md: '# 本地正文' }),
    cloudSnapshot: '{}',
    conflictReason: 'both sides changed',
    confirmedByAccountId: null,
    confirmedAt: null,
    createdAt: new Date('2026-11-19T00:00:00.000Z'),
  };

  const summary: SyncConflictSummary = {
    conflictId: conflict.conflictId,
    recordUuid: conflict.recordUuid,
    organizationId: conflict.organizationId,
    resourceType: conflict.resourceType,
    versionNo: conflict.versionNo,
    localVersion: conflict.localVersion,
    cloudVersion: conflict.cloudVersion,
    displayedCloudVersion: conflict.displayedCloudVersion,
    decision: conflict.decision,
    status: conflict.status,
    conflictReason: conflict.conflictReason,
    confirmedByAccountId: conflict.confirmedByAccountId,
    confirmedAt: conflict.confirmedAt,
    createdAt: conflict.createdAt,
  };

  const makeUsecase = (params: {
    scope: { role: string; organizationId: number | null; adminLevel: number | null };
    locked: SyncConflictSnapshot | null;
    /** 记录级写权是否放行（默认放行） */
    accessAllowed?: boolean;
    /** 来源记录当前版本与可信标记（默认与冲突登记版本一致且可信） */
    recordVersion?: { currentVersion: number | null; versionTrusted: boolean };
  }) => {
    const scopeResolver = {
      resolve: jest.fn(() => Promise.resolve(params.scope)),
    };
    const service = {
      lockConflictView: jest.fn(() =>
        Promise.resolve(
          params.locked
            ? {
                conflictId: params.locked.conflictId,
                recordUuid: params.locked.recordUuid,
                organizationId: params.locked.organizationId,
                resourceType: params.locked.resourceType,
                status: params.locked.status,
                decision: params.locked.decision,
                localVersion: params.locked.localVersion,
                localSnapshot: params.locked.localSnapshot,
              }
            : null,
        ),
      ),
      readConflictSummaryById: jest.fn(() => Promise.resolve(summary)),
      applyCloudResolution: jest.fn(() => Promise.resolve(1)),
    };
    const accessResolver = {
      resolveRowAccess: jest.fn(() =>
        Promise.resolve({
          allowed: params.accessAllowed ?? true,
          reason: params.accessAllowed ?? true ? 'ALLOWED' : 'DENIED_RECORD_UNRESOLVED',
        }),
      ),
    };
    const sourceRecordQueryService = {
      listFacts: jest.fn(() =>
        Promise.resolve({
          facts: new Map([
            [
              params.locked?.recordUuid ?? 'record-uuid-1',
              {
                recordUuid: params.locked?.recordUuid ?? 'record-uuid-1',
                currentVersion:
                  params.recordVersion?.currentVersion ?? params.locked?.localVersion ?? null,
                versionTrusted: params.recordVersion?.versionTrusted ?? true,
              },
            ],
          ]),
          scanComplete: true,
        }),
      ),
    };
    const transactionRunner = {
      run: jest.fn((callback: (ctx: unknown) => unknown) => callback(transactionContext)),
    } as unknown as TransactionRunner;

    return {
      usecase: new ResolveSyncConflictUsecase(
        scopeResolver as unknown as LocalRuntimeScopeResolver,
        service as unknown as SyncConflictService,
        accessResolver as unknown as SyncConflictAccessResolver,
        sourceRecordQueryService as unknown as SyncSourceRecordQueryService,
        transactionRunner,
      ),
      service,
    };
  };

  it('使用云端：写入确认人取自 Session（数据库复核范围），返回 resolved', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 },
      locked: conflict,
    });

    const result = await usecase.execute({
      session,
      conflictId: 'c-1',
      action: 'CLOUD',
    });

    expect(result.outcome).toBe('resolved');
    expect(service.applyCloudResolution).toHaveBeenCalledWith(
      { conflictId: 'c-1', action: 'CLOUD', confirmedByAccountId: 900101 },
      expect.any(Date),
      transactionContext,
    );
  });

  // 写权宽于读权会让"看不见却能改"成立：写侧必须与读侧同一口径（按来源记录归属）。
  it('记录级写权不放行时不得裁决：与不存在同码同文案，不泄露冲突存在性', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      locked: conflict,
      accessAllowed: false,
    });

    await expect(
      usecase.execute({ session, conflictId: 'c-1', action: 'CLOUD' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_NOT_FOUND });
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  // 展示版本复核：冲突登记之后来源记录被别处推进时，用户裁决的是过期内容。
  it('来源记录已被推进（展示版本过期）时拒绝裁决，不写冲突事实', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      locked: conflict,
      recordVersion: { currentVersion: 99, versionTrusted: true },
    });

    await expect(
      usecase.execute({ session, conflictId: 'c-1', action: 'CLOUD' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_VERSION_STALE });
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('稍后处理：不写任何字段，保持待处理', async () => {    const { usecase, service } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      locked: conflict,
    });

    const result = await usecase.execute({ session, conflictId: 'c-1', action: 'LATER' });

    expect(result.outcome).toBe('later');
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('重复相同方向：返回既有事实，不重复写', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 },
      locked: { ...conflict, status: 'RESOLVED', decision: 'CLOUD' },
    });

    const result = await usecase.execute({ session, conflictId: 'c-1', action: 'CLOUD' });

    expect(result.outcome).toBe('existing');
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('跨公司数据区不可裁决：与不存在同码返回，不区分"没有"与"不让你看"', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 5, adminLevel: null },
      locked: conflict,
    });

    await expect(
      usecase.execute({ session, conflictId: 'c-1', action: 'CLOUD' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_NOT_FOUND });
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('冲突不存在：同码失败', async () => {
    const { usecase } = makeUsecase({
      scope: { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 },
      locked: null,
    });

    await expect(
      usecase.execute({ session, conflictId: 'missing', action: 'CLOUD' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_NOT_FOUND });
  });

  it('保留本地：本地运行域不代做管理员动作，明确要求走管理员受控修订入口', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 },
      locked: conflict,
    });

    await expect(
      usecase.execute({ session, conflictId: 'c-1', action: 'LOCAL' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.LOCAL_RESOLUTION_REQUIRES_ADMIN_ENTRY });
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });
});
