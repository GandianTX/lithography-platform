/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
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
 *
 * R066／R067 的关键口径在本文件体现：
 * - **已结单（结单后只读）允许采用云端视图**，但只是**只读采用**：
 *   不写业务记录、不改历史，采用者不因此获得写入权；
 * - 已删除／已下架、冻结一律拒绝采用；
 * - 客户端必须提交**实际看到**的云端版本，服务端逐一对齐后才允许裁决。
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
    localSnapshot: JSON.stringify({
      schema_version: 1,
      resource_type: 'REPAIR_REQUEST',
      record_uuid: 'record-uuid-1',
      version_no: 4,
      manifest_checksum: 'checksum-local',
      body: {
        schema_version: 1,
        request_no: 'RQ-1',
        content_md: '# 本地正文',
        current_revision_no: 4,
        handling_result: null,
        handling_status: null,
      },
    }),
    cloudSnapshot: JSON.stringify({
      schema_version: 1,
      version_no: 5,
      body: {
        schema_version: 1,
        request_no: 'RQ-1',
        content_md: '# 云端正文',
        current_revision_no: 5,
        handling_result: null,
        handling_status: null,
      },
    }),
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
    /** 来源内容只读事实（默认可写） */
    contentState?: { withdrawn: boolean; frozen: boolean; closed: boolean };
    /** 来源记录本机主键（默认 7） */
    recordId?: number;
    /** 本地视图对齐入口（默认可用；传 null 表示"未注册"） */
    localViewWriter?: {
      supportedResourceTypes: readonly string[];
      alignLocalViewToCloud: jest.Mock;
    } | null;
    /** 对齐入口的失败（用于验证"对齐失败不得标 resolved"） */
    alignmentError?: Error;
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
                cloudVersion: params.locked.cloudVersion,
                localSnapshot: params.locked.localSnapshot,
                cloudSnapshot: params.locked.cloudSnapshot,
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
          reason: (params.accessAllowed ?? true) ? 'ALLOWED' : 'DENIED_RECORD_UNRESOLVED',
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
                recordId: params.recordId ?? 7,
                currentVersion:
                  params.recordVersion?.currentVersion ?? params.locked?.localVersion ?? null,
                versionTrusted: params.recordVersion?.versionTrusted ?? true,
                // 只读事实：默认可写（未删除／未冻结／未结单）
                contentState: params.contentState ?? {
                  withdrawn: false,
                  frozen: false,
                  closed: false,
                },
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

    // 本地视图对齐入口（中立端口）：默认可用；传 null 表示"来源域未注册"
    const alignLocalViewToCloud = jest.fn(() =>
      params.alignmentError !== undefined
        ? Promise.reject(params.alignmentError)
        : Promise.resolve({ aligned: true, alignedVersion: 5 }),
    );
    const localViewWriter =
      params.localViewWriter === null
        ? undefined
        : (params.localViewWriter ?? {
            supportedResourceTypes: ['REPAIR_REQUEST'],
            alignLocalViewToCloud,
          });

    return {
      usecase: new ResolveSyncConflictUsecase(
        scopeResolver as unknown as LocalRuntimeScopeResolver,
        service as unknown as SyncConflictService,
        accessResolver as unknown as SyncConflictAccessResolver,
        sourceRecordQueryService as unknown as SyncSourceRecordQueryService,
        {
          assertBusinessWritable: () => Promise.resolve(),
          assertBusinessWritableInTransaction: () => Promise.resolve(),
          assertCompanyWritable: () => Promise.resolve(),
          assertCompanyWritableInTransaction: () => Promise.resolve(),
          assertWritable: () => Promise.resolve(),
        } as unknown as LocalWriteHoldService,
        transactionRunner,
        localViewWriter,
      ),
      service,
      alignLocalViewToCloud,
    };
  };

  it('使用云端：先对齐本地有权视图，再落裁决事实；确认人取自 Session', async () => {
    const { usecase, service, alignLocalViewToCloud } = makeUsecase({
      scope: { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 },
      locked: conflict,
    });

    const result = await usecase.execute({
      session,
      conflictId: 'c-1',
      action: 'CLOUD',
      displayedCloudVersion: 5,
    });

    expect(result.outcome).toBe('resolved');
    // 对齐本地视图：由来源域受控写入入口执行，载荷取自**云端快照**
    expect(alignLocalViewToCloud).toHaveBeenCalledTimes(1);
    expect(alignLocalViewToCloud).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 4,
        recordId: 7,
        actorAccountId: 900101,
        payload: expect.objectContaining({
          resourceType: 'REPAIR_REQUEST',
          expectedVersion: 4,
          contentMd: '# 云端正文',
        }),
      }),
      transactionContext,
    );
    expect(service.applyCloudResolution).toHaveBeenCalledWith(
      {
        conflictId: 'c-1',
        action: 'CLOUD',
        confirmedByAccountId: 900101,
        displayedCloudVersion: 5,
        alignedLocalVersion: 5,
      },
      expect.any(Date),
      transactionContext,
    );
    // 顺序：先对齐，后落裁决事实（对齐失败不得标 resolved）
    expect(alignLocalViewToCloud.mock.invocationCallOrder[0]).toBeLessThan(
      service.applyCloudResolution.mock.invocationCallOrder[0],
    );
  });

  it('对齐失败：整体回滚，不落裁决事实（不标 resolved）', async () => {
    const { usecase, service, alignLocalViewToCloud } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      locked: conflict,
      alignmentError: new Error('对齐失败'),
    });

    await expect(
      usecase.execute({
        session,
        conflictId: 'c-1',
        action: 'CLOUD',
        displayedCloudVersion: 5,
      }),
    ).rejects.toThrow('对齐失败');
    expect(alignLocalViewToCloud).toHaveBeenCalledTimes(1);
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('对齐入口未注册：失败关闭，不静默降级为"只改冲突事实"', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      locked: conflict,
      localViewWriter: null,
    });

    await expect(
      usecase.execute({
        session,
        conflictId: 'c-1',
        action: 'CLOUD',
        displayedCloudVersion: 5,
      }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CLOUD_ALIGNMENT_UNAVAILABLE });
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('来源类型没有受控对齐入口：失败关闭并给出可读原因', async () => {
    const { usecase, service, alignLocalViewToCloud } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      // 报告域没有受控本地视图对齐入口（工单与资料有）⇒ 失败关闭
      locked: { ...conflict, resourceType: 'MAINTENANCE_REPORT' },
      localViewWriter: {
        supportedResourceTypes: ['REPAIR_REQUEST'],
        alignLocalViewToCloud: jest.fn(),
      },
    });

    await expect(
      usecase.execute({
        session,
        conflictId: 'c-1',
        action: 'CLOUD',
        displayedCloudVersion: 5,
      }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CLOUD_ALIGNMENT_RESOURCE_UNSUPPORTED });
    expect(alignLocalViewToCloud).not.toHaveBeenCalled();
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  // R066：已结单（结单后只读）允许**只读采用**云端视图：
  // 允许裁决，但只对齐**视图**（版本推进到云端版本），不写业务记录、不获得写入权。
  it('已结单只读来源：允许采用云端视图（只读采用），不写业务记录', async () => {
    const { usecase, service, alignLocalViewToCloud } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      locked: conflict,
      contentState: { withdrawn: false, frozen: false, closed: true },
    });

    const result = await usecase.execute({
      session,
      conflictId: 'c-1',
      action: 'CLOUD',
      displayedCloudVersion: 5,
    });

    expect(result.outcome).toBe('resolved');
    // 只读采用：不写业务历史 ⇒ 不调用来源域的受控写入入口
    expect(alignLocalViewToCloud).not.toHaveBeenCalled();
    expect(service.applyCloudResolution).toHaveBeenCalledTimes(1);
    expect(service.applyCloudResolution).toHaveBeenCalledWith(
      expect.objectContaining({ alignedLocalVersion: 5 }),
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
      usecase.execute({
        session,
        conflictId: 'c-1',
        action: 'CLOUD',
        displayedCloudVersion: 5,
      }),
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
      usecase.execute({
        session,
        conflictId: 'c-1',
        action: 'CLOUD',
        displayedCloudVersion: 5,
      }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_VERSION_STALE });
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('来源已冻结（正在被别处推进）时拒绝用云端恢复内容', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'engineer', organizationId: 4, adminLevel: null },
      locked: {
        ...conflict,
        conflictId: 'conflict-1',
        localVersion: 2,
        cloudVersion: 3,
        displayedCloudVersion: 3,
        localSnapshot: '{}',
        cloudSnapshot: '{}',
      },
      contentState: { withdrawn: false, frozen: true, closed: false },
    });

    await expect(
      usecase.execute({
        session,
        conflictId: 'conflict-1',
        action: 'CLOUD',
        displayedCloudVersion: 3,
      }),
    ).rejects.toMatchObject({
      code: SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY,
    });
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('来源已删除／已下架时拒绝用云端恢复内容', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'engineer', organizationId: 4, adminLevel: null },
      locked: conflict,
      contentState: { withdrawn: true, frozen: false, closed: false },
    });

    await expect(
      usecase.execute({
        session,
        conflictId: 'c-1',
        action: 'CLOUD',
        displayedCloudVersion: 5,
      }),
    ).rejects.toMatchObject({
      code: SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY,
    });
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  // R067：服务端必须复核客户端**实际看到**的云端版本。
  it('未提交所看到的云端版本时拒绝裁决（不允许盲裁决）', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      locked: conflict,
    });

    await expect(
      usecase.execute({ session, conflictId: 'c-1', action: 'CLOUD' }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_VERSION_STALE });
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('云端版本已变化（客户端看到的版本与登记不一致）时要求刷新重确认', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      locked: conflict,
    });

    await expect(
      usecase.execute({
        session,
        conflictId: 'c-1',
        action: 'CLOUD',
        displayedCloudVersion: 4,
      }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_VERSION_STALE });
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('稍后处理：不写任何字段，保持待处理', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      locked: conflict,
    });

    const result = await usecase.execute({ session, conflictId: 'c-1', action: 'LATER' });

    expect(result.outcome).toBe('later');
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('重复相同方向：返回既有事实，不重复写、不产生新业务版本', async () => {
    const { usecase, service, alignLocalViewToCloud } = makeUsecase({
      scope: { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 },
      locked: { ...conflict, status: 'RESOLVED', decision: 'CLOUD' },
    });

    const result = await usecase.execute({
      session,
      conflictId: 'c-1',
      action: 'CLOUD',
      displayedCloudVersion: 5,
    });

    expect(result.outcome).toBe('existing');
    expect(alignLocalViewToCloud).not.toHaveBeenCalled();
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('跨公司数据区不可裁决：与不存在同码返回，不区分"没有"与"不让你看"', async () => {
    const { usecase, service } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 5, adminLevel: null },
      locked: conflict,
    });

    await expect(
      usecase.execute({
        session,
        conflictId: 'c-1',
        action: 'CLOUD',
        displayedCloudVersion: 5,
      }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_NOT_FOUND });
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });

  it('冲突不存在：同码失败', async () => {
    const { usecase } = makeUsecase({
      scope: { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 },
      locked: null,
    });

    await expect(
      usecase.execute({
        session,
        conflictId: 'missing',
        action: 'CLOUD',
        displayedCloudVersion: 5,
      }),
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

  it('资料：使用云端时按资料的受控字段对齐本地视图（标题／说明／正文）', async () => {
    const documentConflict: SyncConflictSnapshot = {
      ...conflict,
      conflictId: 'c-doc',
      resourceType: 'REFERENCE_DOCUMENT',
      cloudSnapshot: JSON.stringify({
        schema_version: 1,
        version_no: 5,
        body: {
          schema_version: 1,
          title: '云端标题',
          description: '云端说明',
          content_text: '云端正文',
          current_revision_no: 5,
        },
      }),
    };
    const alignLocalViewToCloud = jest.fn(() =>
      Promise.resolve({ aligned: true, alignedVersion: 5 }),
    );
    const { usecase, service } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      locked: documentConflict,
      localViewWriter: {
        supportedResourceTypes: ['REPAIR_REQUEST', 'REFERENCE_DOCUMENT'],
        alignLocalViewToCloud,
      },
    });

    const result = await usecase.execute({
      session,
      conflictId: 'c-doc',
      action: 'CLOUD',
      displayedCloudVersion: 5,
    });

    expect(result.outcome).toBe('resolved');
    expect(alignLocalViewToCloud).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          resourceType: 'REFERENCE_DOCUMENT',
          expectedVersion: 4,
          title: '云端标题',
          description: '云端说明',
          contentText: '云端正文',
        }),
      }),
      transactionContext,
    );
    expect(service.applyCloudResolution).toHaveBeenCalledTimes(1);
  });

  it('资料：来源域未注册资料对齐入口时失败关闭（不静默降级为只改冲突事实）', async () => {
    const documentConflict: SyncConflictSnapshot = {
      ...conflict,
      conflictId: 'c-doc',
      resourceType: 'REFERENCE_DOCUMENT',
      cloudSnapshot: JSON.stringify({
        schema_version: 1,
        version_no: 5,
        body: { schema_version: 1, title: '云端标题' },
      }),
    };
    const alignLocalViewToCloud = jest.fn(() =>
      Promise.resolve({ aligned: true, alignedVersion: 5 }),
    );
    const { usecase, service } = makeUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      locked: documentConflict,
      localViewWriter: {
        supportedResourceTypes: ['REPAIR_REQUEST'],
        alignLocalViewToCloud,
      },
    });

    await expect(
      usecase.execute({
        session,
        conflictId: 'c-doc',
        action: 'CLOUD',
        displayedCloudVersion: 5,
      }),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CLOUD_ALIGNMENT_RESOURCE_UNSUPPORTED });
    expect(alignLocalViewToCloud).not.toHaveBeenCalled();
    expect(service.applyCloudResolution).not.toHaveBeenCalled();
  });
});
