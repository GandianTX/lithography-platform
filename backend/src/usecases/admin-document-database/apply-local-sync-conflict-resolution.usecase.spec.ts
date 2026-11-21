/// <reference types="jest" />
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { SyncSourceRecordQueryService } from '@src/modules/lithography/queries/sync-source-record.query.service';
import type { SyncConflictService } from '@src/modules/lithography/sync-conflict.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';

import { ApplyLocalSyncConflictResolutionUsecase } from './apply-local-sync-conflict-resolution.usecase';
import { AppendRepairRequestRevisionUsecase } from './append-repair-request-revision.usecase';

/**
 * 「保留本地」裁决用例（任务 09 R-03）。
 *
 * 覆盖口径：管理员权限前置、公司范围、载荷映射失败关闭、受控写入委托与并发写回。
 */
describe('ApplyLocalSyncConflictResolutionUsecase', () => {
  const transactionContext = Object.freeze({});
  const superAdminSession = {
    accountId: 900101,
    roles: ['SUPER_ADMIN'],
    activeRole: 'SUPER_ADMIN',
    adminLevel: 1,
    adminOrganizationId: null,
  } as unknown as UsecaseSession;
  const engineerSession = {
    accountId: 900102,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
    adminLevel: null,
    adminOrganizationId: null,
  } as unknown as UsecaseSession;

  const lockedConflict: {
    conflictId: string;
    recordUuid: string;
    organizationId: number;
    resourceType: string;
    status: string;
    decision: string | null;
    localVersion: number | null;
    localSnapshot: string;
  } = {
    conflictId: 'c-1',
    recordUuid: 'record-uuid-1',
    organizationId: 4,
    resourceType: 'REPAIR_REQUEST',
    status: 'PENDING',
    decision: null,
    localVersion: 4,
    localSnapshot: JSON.stringify({ schema_version: 1, content_md: '# 本地正文' }),
  };

  const makeUsecase = (params: {
    session?: UsecaseSession;
    organizationId?: number | null;
    locked?: typeof lockedConflict | null;
    fact?: { recordId: number; withdrawn?: boolean } | null;
    localAffected?: number;
    adminLevel?: number | null;
    trustedOrganizationId?: number;
  }) => {
    const conflictService = {
      lockConflict: jest.fn(() =>
        Promise.resolve(params.locked === undefined ? lockedConflict : params.locked),
      ),
      readConflictSummaryById: jest.fn(() =>
        Promise.resolve({
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
          conflictReason: 'both sides changed',
          confirmedByAccountId: null,
          confirmedAt: null,
          createdAt: new Date('2026-11-19T00:00:00.000Z'),
        }),
      ),
      applyLocalResolution: jest.fn(() => Promise.resolve(params.localAffected ?? 1)),
    };
    const sourceRecordQueryService = {
      listFacts: jest.fn(() =>
        Promise.resolve({
          facts: new Map(
            params.fact === undefined
              ? [['record-uuid-1', { recordId: 880001, withdrawn: false }]]
              : params.fact === null
                ? []
                : [['record-uuid-1', params.fact]],
          ),
          scanComplete: true,
        }),
      ),
    };
    const accountQueryService = {
      findAdminLevelByAccountId: jest.fn().mockResolvedValue(params.adminLevel ?? 1),
    } as unknown as AccountQueryService;
    const trustedOrganizationContext = {
      resolveForAccount: jest.fn().mockResolvedValue({
        organizationId: params.trustedOrganizationId ?? 4,
        memberRole: 'SUPER_ADMIN',
      }),
    } as unknown as TrustedOrganizationContextQueryService;
    const appendRevisionUsecase = {
      execute: jest.fn(() => Promise.resolve({ revisionNo: 5 })),
    } as unknown as AppendRepairRequestRevisionUsecase;
    const transactionRunner = {
      run: jest.fn((callback: (ctx: unknown) => unknown) => callback(transactionContext)),
    } as unknown as TransactionRunner;

    return {
      usecase: new ApplyLocalSyncConflictResolutionUsecase(
        conflictService as unknown as SyncConflictService,
        sourceRecordQueryService as unknown as SyncSourceRecordQueryService,
        accountQueryService,
        trustedOrganizationContext,
        appendRevisionUsecase,
        transactionRunner,
      ),
      conflictService,
      sourceRecordQueryService,
      appendRevisionUsecase,
    };
  };

  it('保留本地：委托受控修订入口写入本地版本，并写回 LOCAL 裁决事实', async () => {
    const { usecase, conflictService, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
    });

    const result = await usecase.execute({ session: superAdminSession, conflictId: 'c-1' });

    expect(result.outcome).toBe('resolved');
    // 受控写入委托：版本取冲突登记的本地版本，正文取本地快照
    expect(appendRevisionUsecase.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 880001,
        expectedVersion: 4,
        contentMd: '# 本地正文',
      }),
    );
    // 冲突事实写回：条件更新 + 确认人取自 Session
    expect(conflictService.applyLocalResolution).toHaveBeenCalledWith(
      { conflictId: 'c-1', action: 'LOCAL', confirmedByAccountId: 900101 },
      expect.any(Date),
      transactionContext,
    );
  });

  it('保留本地：非管理员会话失败关闭，不写任何事实', async () => {
    const { usecase, conflictService, appendRevisionUsecase } = makeUsecase({
      session: engineerSession,
    });

    await expect(
      usecase.execute({ session: engineerSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
    expect(conflictService.applyLocalResolution).not.toHaveBeenCalled();
  });

  it('保留本地：冲突不存在时与范围外同码失败', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      locked: null,
    });

    await expect(
      usecase.execute({ session: superAdminSession, conflictId: 'missing' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_NOT_FOUND });
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
  });

  it('保留本地：来源记录不可用时不写入', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      fact: null,
    });

    await expect(
      usecase.execute({ session: superAdminSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_NOT_FOUND });
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
  });

  it('保留本地：本地快照不满足受控载荷契约时失败关闭，不写入', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      locked: { ...lockedConflict, localSnapshot: JSON.stringify({ schema_version: 7 }) },
    });

    await expect(
      usecase.execute({ session: superAdminSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID });
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
  });

  it('保留本地：资源类型没有受控写入入口时失败关闭，不写入', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      locked: { ...lockedConflict, resourceType: 'MAINTENANCE_REPORT' },
    });

    await expect(
      usecase.execute({ session: superAdminSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.LOCAL_RESOLUTION_RESOURCE_UNSUPPORTED });
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
  });

  it('保留本地：重复裁决（已是 LOCAL）返回既有事实，不重复写', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      locked: { ...lockedConflict, status: 'RESOLVED', decision: 'LOCAL' },
    });

    const result = await usecase.execute({ session: superAdminSession, conflictId: 'c-1' });

    expect(result.outcome).toBe('existing');
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
  });

  it('保留本地：并发已裁决（写回 0 行）返回既有事实，不覆盖别人的确认', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      localAffected: 0,
    });

    const result = await usecase.execute({ session: superAdminSession, conflictId: 'c-1' });

    expect(result.outcome).toBe('existing');
    expect(appendRevisionUsecase.execute).toHaveBeenCalled();
  });
});
