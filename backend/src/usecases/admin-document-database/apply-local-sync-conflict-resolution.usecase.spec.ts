/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { SyncSourceRecordQueryService } from '@src/modules/lithography/queries/sync-source-record.query.service';
import type { SyncConflictService } from '@src/modules/lithography/sync-conflict.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { SyncConflictLocalResolutionWriter } from '@src/usecases/common/ports/sync-conflict-local-resolution-writer.contract';

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
    /** 保留本地裁决幂等状态（review M7）：null=从未走过本地裁决 */
    localResolutionState: string | null;
    localSnapshot: string;
  } = {
    conflictId: 'c-1',
    recordUuid: 'record-uuid-1',
    organizationId: 4,
    resourceType: 'REPAIR_REQUEST',
    status: 'PENDING',
    decision: null,
    localVersion: 4,
    localResolutionState: null,
    localSnapshot: JSON.stringify({ schema_version: 1, content_md: '# 本地正文' }),
  };

  const makeUsecase = (params: {
    session?: UsecaseSession;
    organizationId?: number | null;
    locked?: typeof lockedConflict | null;
    fact?: {
      recordId: number;
      withdrawn?: boolean;
      currentVersion?: number | null;
      ownerOrganizationId?: number | null;
      contentState?: { withdrawn: boolean; frozen: boolean; closed: boolean };
    } | null;
    localAffected?: number;
    markedAffected?: number;
    adminLevel?: number | null;
    trustedOrganizationId?: number;
  }) => {
    const conflictService = {
      lockConflictView: jest.fn(() =>
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
      markLocalResolutionWriting: jest.fn(() => Promise.resolve(params.markedAffected ?? 1)),
    };
    const sourceRecordQueryService = {
      listFacts: jest.fn(() =>
        Promise.resolve({
          facts: new Map<string, Record<string, unknown>>(
            params.fact === undefined
              ? [
                  [
                    'record-uuid-1',
                    {
                      recordId: 880001,
                      withdrawn: false,
                      currentVersion: 4,
                      // 只读事实：默认可写（未删除／未冻结／未结单）
                      contentState: { withdrawn: false, frozen: false, closed: false },
                    },
                  ],
                ]
              : params.fact === null
                ? []
                : [[params.locked?.recordUuid ?? 'record-uuid-1', params.fact]],
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
    // 资料分支的来源域受控写入（中立契约实现，任务 09 第 05 项）
    const localResolutionWriter = {
      supportedResourceTypes: ['REFERENCE_DOCUMENT'],
      writeLocalVersion: jest.fn(() => Promise.resolve({ written: true, writtenVersion: 4 })),
    } as unknown as SyncConflictLocalResolutionWriter;
    const transactionRunner = {
      run: jest.fn((callback: (ctx: unknown) => unknown) => callback(transactionContext)),
    } as unknown as TransactionRunner;

    return {
      usecase: new ApplyLocalSyncConflictResolutionUsecase(
        conflictService as unknown as SyncConflictService,
        sourceRecordQueryService as unknown as SyncSourceRecordQueryService,
        accountQueryService,
        trustedOrganizationContext,
        {
          assertBusinessWritable: () => Promise.resolve(),
          assertCompanyWritable: () => Promise.resolve(),
          assertWritable: () => Promise.resolve(),
        } as unknown as LocalWriteHoldService,
        appendRevisionUsecase,
        localResolutionWriter,
        transactionRunner,
      ),
      conflictService,
      sourceRecordQueryService,
      appendRevisionUsecase,
      localResolutionWriter,
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

  it('保留本地：并发已裁决（写回 0 行）时显式报出，不伪装成"既有事实"', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      localAffected: 0,
    });

    // 受控修订已经写入，冲突事实未被改写：必须让调用方知道真实发生了什么
    await expect(
      usecase.execute({ session: superAdminSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.LOCAL_RESOLUTION_CONCURRENTLY_RESOLVED });
    expect(appendRevisionUsecase.execute).toHaveBeenCalled();
  });

  it('保留本地：tx3 写回失败后的幂等重放不重复写正文（review M7）', async () => {
    // 第一次：正文写入成功，冲突事实写回失败（0 行）——状态是"正文已写、事实未改写"
    const first = makeUsecase({ session: superAdminSession, localAffected: 0 });
    await expect(
      first.usecase.execute({ session: superAdminSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.LOCAL_RESOLUTION_CONCURRENTLY_RESOLVED });
    expect(first.appendRevisionUsecase.execute).toHaveBeenCalledTimes(1);
    // 幂等标记在正文写入前已落（业务键＝conflict_id）
    expect(first.conflictService.markLocalResolutionWriting).toHaveBeenCalledWith(
      'c-1',
      transactionContext,
    );

    // 第二次（重放）：冲突行仍是 PENDING 且标记为 WRITING，来源版本已被正文写入推进
    const second = makeUsecase({
      session: superAdminSession,
      locked: { ...lockedConflict, localResolutionState: 'WRITING' },
      fact: {
        recordId: 880001,
        withdrawn: false,
        currentVersion: 5,
        // 只读事实：默认可写（未删除／未冻结／未结单）
        contentState: { withdrawn: false, frozen: false, closed: false },
      },
    });
    const result = await second.usecase.execute({ session: superAdminSession, conflictId: 'c-1' });

    expect(result.outcome).toBe('resolved');
    // 幂等重放：不重复写正文
    expect(second.appendRevisionUsecase.execute).not.toHaveBeenCalled();
    // 但仍要补写冲突事实
    expect(second.conflictService.applyLocalResolution).toHaveBeenCalled();
  });

  it('保留本地：幂等标记写不进（并发已裁决）时不写正文', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      markedAffected: 0,
    });

    await expect(
      usecase.execute({ session: superAdminSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.LOCAL_RESOLUTION_CONCURRENTLY_RESOLVED });
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
  });

  it('保留本地：冲突登记的本地版本已不是来源记录当前版本时不写入', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      fact: {
        recordId: 880001,
        withdrawn: false,
        currentVersion: 9,
        // 只读事实：默认可写（未删除／未冻结／未结单）
        contentState: { withdrawn: false, frozen: false, closed: false },
      },
    });

    await expect(
      usecase.execute({ session: superAdminSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.LOCAL_RESOLUTION_VERSION_UNAVAILABLE });
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
  });

  it('保留本地：换方向（已裁决为云端）显式拒绝，不覆盖既有确认', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      locked: { ...lockedConflict, status: 'RESOLVED', decision: 'CLOUD' },
    });

    await expect(
      usecase.execute({ session: superAdminSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_ALREADY_RESOLVED });
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
  });

  it('保留本地：待处理行上已登记方向（decision 已定）时不静默覆盖', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      locked: { ...lockedConflict, status: 'PENDING', decision: 'CLOUD' },
    });

    await expect(
      usecase.execute({ session: superAdminSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_ALREADY_RESOLVED });
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
  });

  it('保留本地：二级管理员只在本company数据区裁决，跨公司同码失败', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      adminLevel: 2,
      trustedOrganizationId: 9,
    });

    await expect(
      usecase.execute({ session: superAdminSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_NOT_FOUND });
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
  });

  it('保留本地：快照里的处理结果不是真实枚举时不写入', async () => {
    const { usecase, appendRevisionUsecase } = makeUsecase({
      session: superAdminSession,
      locked: {
        ...lockedConflict,
        localSnapshot: JSON.stringify({ schema_version: 1, handling_result: 'NOT_A_REAL_RESULT' }),
      },
    });

    await expect(
      usecase.execute({ session: superAdminSession, conflictId: 'c-1' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID });
    expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
  });
  /**
   * 资料分支（第 05 项 · P1-5／G10）：「保留本地」对资料的真实写权与受控边界。
   *
   * 守住：
   * - 资料可写成功 → 经中立契约写入受控修订 ＋ 落 LOCAL 裁决事实（正文不反写）；
   * - 写权按**来源资源真实可写角色**：二级管理员与工程师受控拒绝（不按管理员身份替代）；
   * - 同公司记录、只读来源（已下架／归属待确认）、版本推进后一律受控拒绝；
   * - 幂等重放不重复写修订，只补裁决事实。
   */
  describe('资料分支（REFERENCE_DOCUMENT）', () => {
    const documentFirstLevelAdminSession = {
      accountId: 900101,
      roles: ['SUPER_ADMIN'],
      activeRole: 'SUPER_ADMIN',
      adminLevel: 1,
      adminOrganizationId: null,
    } as unknown as UsecaseSession;
    const documentEngineerSession = {
      accountId: 900102,
      roles: ['ENGINEER'],
      activeRole: 'ENGINEER',
      adminLevel: null,
      adminOrganizationId: null,
    } as unknown as UsecaseSession;

    const documentConflict = {
      conflictId: 'c-doc-1',
      recordUuid: 'record-uuid-doc-1',
      organizationId: 4,
      resourceType: 'REFERENCE_DOCUMENT',
      status: 'PENDING',
      decision: null,
      localVersion: 3,
      localResolutionState: null,
      localSnapshot: JSON.stringify({
        schema_version: 1,
        title: '本地资料标题',
        description: '本地说明',
        content_text: '本地正文',
      }),
    };

    const documentFact = {
      recordId: 990001,
      withdrawn: false,
      currentVersion: 3,
      ownerOrganizationId: 4,
      contentState: { withdrawn: false, frozen: false, closed: false },
    };

    it('资料可写成功：经中立契约写入受控修订并落 LOCAL 裁决事实', async () => {
      const { usecase, conflictService, localResolutionWriter, appendRevisionUsecase } =
        makeUsecase({
          session: documentFirstLevelAdminSession,
          locked: documentConflict,
          fact: documentFact,
        });

      const result = await usecase.execute({
        session: documentFirstLevelAdminSession,
        conflictId: 'c-doc-1',
      });

      expect(result.outcome).toBe('resolved');
      expect(localResolutionWriter.writeLocalVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          recordId: 990001,
          expectedVersion: 3,
          payload: expect.objectContaining({
            resourceType: 'REFERENCE_DOCUMENT',
            title: '本地资料标题',
            description: '本地说明',
          }),
          actorAccountId: 900101,
        }),
        transactionContext,
      );
      // 资料分支不走工单受控修订入口
      expect(appendRevisionUsecase.execute).not.toHaveBeenCalled();
      expect(conflictService.applyLocalResolution).toHaveBeenCalledWith(
        { conflictId: 'c-doc-1', action: 'LOCAL', confirmedByAccountId: 900101 },
        expect.any(Date),
        transactionContext,
      );
    });

    it('资料分支：正文不进入受控载荷（保留本地不改写正文）', async () => {
      const { usecase, localResolutionWriter } = makeUsecase({
        session: documentFirstLevelAdminSession,
        locked: documentConflict,
        fact: documentFact,
      });

      await usecase.execute({ session: documentFirstLevelAdminSession, conflictId: 'c-doc-1' });

      const command = (localResolutionWriter.writeLocalVersion as jest.Mock).mock.calls[0]?.[0];
      expect(command.payload).not.toHaveProperty('contentText');
    });

    it('资料分支：二级管理员受控拒绝（资料正文修订只对一级管理员开放）', async () => {
      const { usecase, localResolutionWriter, conflictService } = makeUsecase({
        session: documentFirstLevelAdminSession,
        locked: documentConflict,
        fact: documentFact,
        adminLevel: 2,
        trustedOrganizationId: 4,
      });

      await expect(
        usecase.execute({ session: documentFirstLevelAdminSession, conflictId: 'c-doc-1' }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
      expect(localResolutionWriter.writeLocalVersion).not.toHaveBeenCalled();
      expect(conflictService.applyLocalResolution).not.toHaveBeenCalled();
    });

    it('资料分支：工程师会话在前置门被拒（记录人／工程师无资料正文修订权）', async () => {
      const { usecase, localResolutionWriter } = makeUsecase({
        session: documentEngineerSession,
        locked: documentConflict,
        fact: documentFact,
      });

      await expect(
        usecase.execute({ session: documentEngineerSession, conflictId: 'c-doc-1' }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
      expect(localResolutionWriter.writeLocalVersion).not.toHaveBeenCalled();
    });

    it('资料分支：来源记录归属别家公司时受控拒绝（同公司记录）', async () => {
      const { usecase, localResolutionWriter } = makeUsecase({
        session: documentFirstLevelAdminSession,
        locked: documentConflict,
        fact: { ...documentFact, ownerOrganizationId: 9 },
      });

      await expect(
        usecase.execute({ session: documentFirstLevelAdminSession, conflictId: 'c-doc-1' }),
      ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_NOT_FOUND });
      expect(localResolutionWriter.writeLocalVersion).not.toHaveBeenCalled();
    });

    it('资料分支：只读来源（下架／归属待确认）受控拒绝，不写回内容', async () => {
      for (const contentState of [
        { withdrawn: true, frozen: false, closed: false },
        { withdrawn: false, frozen: true, closed: false },
      ]) {
        const { usecase, localResolutionWriter } = makeUsecase({
          session: documentFirstLevelAdminSession,
          locked: documentConflict,
          fact: { ...documentFact, contentState },
        });

        await expect(
          usecase.execute({ session: documentFirstLevelAdminSession, conflictId: 'c-doc-1' }),
        ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY });
        expect(localResolutionWriter.writeLocalVersion).not.toHaveBeenCalled();
      }
    });

    it('资料分支：来源版本已被推进时受控拒绝（按用户看到的本地版本检查并发）', async () => {
      const { usecase, localResolutionWriter } = makeUsecase({
        session: documentFirstLevelAdminSession,
        locked: documentConflict,
        fact: { ...documentFact, currentVersion: 9 },
      });

      await expect(
        usecase.execute({ session: documentFirstLevelAdminSession, conflictId: 'c-doc-1' }),
      ).rejects.toMatchObject({ code: SYNC_ERROR.LOCAL_RESOLUTION_VERSION_UNAVAILABLE });
      expect(localResolutionWriter.writeLocalVersion).not.toHaveBeenCalled();
    });

    it('资料分支：幂等重放不重复写修订，只补写冲突事实', async () => {
      const { usecase, conflictService, localResolutionWriter } = makeUsecase({
        session: documentFirstLevelAdminSession,
        locked: { ...documentConflict, localResolutionState: 'WRITING' },
        fact: { ...documentFact, currentVersion: 4 },
      });

      const result = await usecase.execute({
        session: documentFirstLevelAdminSession,
        conflictId: 'c-doc-1',
      });

      expect(result.outcome).toBe('resolved');
      expect(localResolutionWriter.writeLocalVersion).not.toHaveBeenCalled();
      expect(conflictService.applyLocalResolution).toHaveBeenCalled();
    });

    it('资料分支：并发已裁决（写回 0 行）显式报出，不伪装成既有事实', async () => {
      const { usecase, conflictService, localResolutionWriter } = makeUsecase({
        session: documentFirstLevelAdminSession,
        locked: documentConflict,
        fact: documentFact,
        localAffected: 0,
      });

      await expect(
        usecase.execute({ session: documentFirstLevelAdminSession, conflictId: 'c-doc-1' }),
      ).rejects.toMatchObject({ code: SYNC_ERROR.LOCAL_RESOLUTION_CONCURRENTLY_RESOLVED });
      expect(localResolutionWriter.writeLocalVersion).toHaveBeenCalled();
      expect(conflictService.applyLocalResolution).toHaveBeenCalled();
    });
  });
});
