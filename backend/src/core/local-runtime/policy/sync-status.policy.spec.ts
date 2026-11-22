/// <reference types="jest" />
import {
  resolveSyncStatus,
  resolveSyncApplicability,
  resolveSyncCompanyApplicability,
  syncStatusEnum,
  SHARED_SYNC_STATUSES,
  type SyncStatusFacts,
  type SyncStatusReceiptFact,
  type SyncStatusTaskFact,
} from './sync-status.policy';

describe('resolveSyncStatus（同步状态聚合纯规则）', () => {
  const baseFacts = (overrides: Partial<SyncStatusFacts> = {}): SyncStatusFacts => ({
    connected: true,
    identityTrusted: true,
    versionTrusted: true,
    applicable: true,
    authorizationValid: true,
    task: null,
    legacyTaskExists: false,
    receipt: null,
    conflict: null,
    ...overrides,
  });

  const successfulTask = (overrides: Partial<SyncStatusTaskFact> = {}): SyncStatusTaskFact => ({
    status: 'SUCCEEDED',
    sourceVersion: 3,
    manifestChecksum: 'a'.repeat(64),
    entityType: 'REPORT_VERSION',
    ...overrides,
  });

  const successfulReceipt = (
    overrides: Partial<SyncStatusReceiptFact> = {},
  ): SyncStatusReceiptFact => ({
    status: 'SUCCEEDED',
    versionNo: 3,
    manifestChecksum: 'a'.repeat(64),
    sourceInstallationConfirmed: true,
    bodyComplete: true,
    originalsComplete: true,
    ...overrides,
  });

  it('与任务 07 草案 v0.1 共享的状态子集保持九个取值', () => {
    expect(SHARED_SYNC_STATUSES).toHaveLength(9);
    for (const status of SHARED_SYNC_STATUSES) {
      expect(Object.values(syncStatusEnum)).toContain(status);
    }
  });

  it('未装配实现时返回 NOT_CONNECTED（未接入不是同步结果）', () => {
    const result = resolveSyncStatus(baseFacts({ connected: false }));

    expect(result.status).toBe('NOT_CONNECTED');
    expect(result.reasonCode).toBe('NOT_CONNECTED');
  });

  it('身份不可信时返回 UNKNOWN，不得用派生键冒充可信键', () => {
    const result = resolveSyncStatus(baseFacts({ identityTrusted: false }));

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('IDENTITY_UNTRUSTED');
  });

  it('版本不可信时返回 UNKNOWN（草稿版本 0 不得冒充变化版本）', () => {
    const result = resolveSyncStatus(baseFacts({ versionTrusted: false }));

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('VERSION_UNTRUSTED');
  });

  it('授权失效时返回 AUTHORIZATION_INVALID 且不暴露冲突入口', () => {
    const result = resolveSyncStatus(
      baseFacts({
        authorizationValid: false,
        conflict: {
          conflictId: 'conflict-1',
          localVersion: 3,
          cloudVersion: 4,
          readable: true,
          resolvable: true,
        },
      }),
    );

    expect(result.status).toBe('AUTHORIZATION_INVALID');
    expect(result.reasonCode).toBe('AUTHORIZATION_INVALID');
    expect(result.conflictId).toBeNull();
    expect(result.canResolveConflict).toBe(false);
  });

  it('适用性无法判定时返回 UNKNOWN，不得由缺任务推断', () => {
    const result = resolveSyncStatus(baseFacts({ applicable: null }));

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('APPLICABILITY_UNKNOWN');
  });

  it('明确不适用时返回 NOT_APPLICABLE', () => {
    const result = resolveSyncStatus(baseFacts({ applicable: false }));

    expect(result.status).toBe('NOT_APPLICABLE');
    expect(result.reasonCode).toBeNull();
  });

  it('适用且已准确查询但当前版本无任务时返回 NO_TASK', () => {
    const result = resolveSyncStatus(baseFacts({ applicable: true, task: null }));

    expect(result.status).toBe('NO_TASK');
  });

  it('存在用途无法确认的历史任务时不得断言"没有任务"', () => {
    const result = resolveSyncStatus(baseFacts({ task: null, legacyTaskExists: true }));

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('TASK_KIND_UNKNOWN');
  });

  it('任务状态取值非法时按未知处理（脏数据不当作成功）', () => {
    const result = resolveSyncStatus(
      baseFacts({ task: successfulTask({ status: 'UNKNOWN' }), receipt: successfulReceipt() }),
    );

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('TASK_STATUS_UNKNOWN');
  });

  it('任务进行中时按真实状态返回 PENDING／UPLOADING', () => {
    expect(
      resolveSyncStatus(baseFacts({ task: successfulTask({ status: 'PENDING' }) })).status,
    ).toBe('PENDING');
    expect(
      resolveSyncStatus(baseFacts({ task: successfulTask({ status: 'UPLOADING' }) })).status,
    ).toBe('UPLOADING');
  });

  it('任务失败时返回 FAILED；仅剩取消任务时返回 FAILED 而不是已同步', () => {
    expect(
      resolveSyncStatus(baseFacts({ task: successfulTask({ status: 'FAILED' }) })).status,
    ).toBe('FAILED');
    const cancelled = resolveSyncStatus(
      baseFacts({ task: successfulTask({ status: 'CANCELLED' }) }),
    );
    expect(cancelled.status).toBe('FAILED');
    expect(cancelled.reasonCode).toBe('TASK_CANCELLED');
  });

  it('仅任务成功但缺少回执时不得判已同步', () => {
    const result = resolveSyncStatus(baseFacts({ task: successfulTask(), receipt: null }));

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('RECEIPT_MISSING');
  });

  it('回执版本与当前版本不一致时不得判已同步（旧回执不对应新正文）', () => {
    const result = resolveSyncStatus(
      baseFacts({
        task: successfulTask({ sourceVersion: 4 }),
        receipt: successfulReceipt({ versionNo: 3 }),
      }),
    );

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('RECEIPT_VERSION_MISMATCH');
  });

  it('回执缺摘要、正文或原件不完整时不得判已同步', () => {
    const cases = [
      successfulReceipt({ manifestChecksum: null }),
      successfulReceipt({ bodyComplete: false }),
      successfulReceipt({ originalsComplete: false }),
    ];
    for (const receipt of cases) {
      const result = resolveSyncStatus(baseFacts({ task: successfulTask(), receipt }));
      expect(result.status).toBe('UNKNOWN');
      expect(result.reasonCode).toBe('RECEIPT_INCOMPLETE');
    }
  });

  it('任务与回执摘要不一致时不得判已同步', () => {
    const result = resolveSyncStatus(
      baseFacts({
        task: successfulTask({ manifestChecksum: 'b'.repeat(64) }),
        receipt: successfulReceipt({ manifestChecksum: 'a'.repeat(64) }),
      }),
    );

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('RECEIPT_INCOMPLETE');
  });

  it('回执来源无法确认是本机时不得判已同步', () => {
    const result = resolveSyncStatus(
      baseFacts({
        task: successfulTask(),
        receipt: successfulReceipt({ sourceInstallationConfirmed: false }),
      }),
    );

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('RECEIPT_SOURCE_UNCONFIRMED');
  });

  it('任务用途不是正文时不得判已同步', () => {
    const result = resolveSyncStatus(
      baseFacts({
        task: successfulTask({ entityType: 'ATTACHMENT' }),
        receipt: successfulReceipt(),
      }),
    );

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('TASK_NOT_BODY');
  });

  it('当前版本有匹配的完整成功回执时才判已同步', () => {
    const result = resolveSyncStatus(
      baseFacts({ task: successfulTask(), receipt: successfulReceipt() }),
    );

    expect(result.status).toBe('SYNCED');
    expect(result.reasonCode).toBeNull();
    expect(result.conflictId).toBeNull();
  });

  // review M10：未知回执状态不得落到 SYNCED 分支
  it('未知回执状态按未知处理，不判已同步', () => {
    const result = resolveSyncStatus(
      baseFacts({
        task: successfulTask(),
        receipt: successfulReceipt({ status: 'UNKNOWN' }),
      }),
    );

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('RECEIPT_STATUS_UNKNOWN');
  });

  it('任务与同版本回执互相矛盾时按未知处理，不显示成功', () => {
    const pendingWithReceipt = resolveSyncStatus(
      baseFacts({
        task: successfulTask({ status: 'PENDING' }),
        receipt: successfulReceipt(),
      }),
    );
    expect(pendingWithReceipt.status).toBe('UNKNOWN');
    expect(pendingWithReceipt.reasonCode).toBe('TASK_RECEIPT_INCONSISTENT');
  });

  it('旧版本成功回执不构成与当前任务的矛盾（按当前任务状态表达）', () => {
    const result = resolveSyncStatus(
      baseFacts({
        task: successfulTask({ status: 'PENDING', sourceVersion: 3 }),
        receipt: successfulReceipt({ versionNo: 2 }),
      }),
    );

    expect(result.status).toBe('PENDING');
    expect(result.reasonCode).toBeNull();
  });

  it('回执仍在进行时按 PENDING 处理', () => {
    const result = resolveSyncStatus(
      baseFacts({ task: successfulTask(), receipt: successfulReceipt({ status: 'PENDING' }) }),
    );

    expect(result.status).toBe('PENDING');
  });

  it('当前版本存在待处理冲突时优先返回 CONFLICT', () => {
    const result = resolveSyncStatus(
      baseFacts({
        task: successfulTask({ status: 'UPLOADING' }),
        conflict: {
          conflictId: 'conflict-1',
          localVersion: 3,
          cloudVersion: 4,
          readable: true,
          resolvable: true,
        },
      }),
    );

    expect(result.status).toBe('CONFLICT');
    expect(result.reasonCode).toBe('CONFLICT_PENDING');
    expect(result.conflictId).toBe('conflict-1');
    expect(result.canResolveConflict).toBe(true);
  });

  it('冲突可读但不可处理时不给出处理入口', () => {
    const result = resolveSyncStatus(
      baseFacts({
        conflict: {
          conflictId: 'conflict-1',
          localVersion: 3,
          cloudVersion: 4,
          readable: true,
          resolvable: false,
        },
      }),
    );

    expect(result.status).toBe('CONFLICT');
    expect(result.conflictId).toBe('conflict-1');
    expect(result.canResolveConflict).toBe(false);
  });

  it('冲突不可读时不给出冲突标识与处理入口', () => {
    const result = resolveSyncStatus(
      baseFacts({
        conflict: {
          conflictId: 'conflict-1',
          localVersion: 3,
          cloudVersion: 4,
          readable: false,
          resolvable: true,
        },
      }),
    );

    expect(result.conflictId).toBeNull();
    expect(result.canResolveConflict).toBe(false);
  });

  it('回执状态为冲突时按 CONFLICT 处理', () => {
    const result = resolveSyncStatus(
      baseFacts({ task: successfulTask(), receipt: successfulReceipt({ status: 'CONFLICT' }) }),
    );

    expect(result.status).toBe('CONFLICT');
  });
});

describe('公司级「正式运行模式」适用性（任务 09 后续S1.5）', () => {
  const activeCompany = { authorizationCount: 2, activeAuthorizationCount: 1 };

  it('存在 ACTIVE 授权行时公司处于正式运行模式', () => {
    expect(resolveSyncCompanyApplicability(activeCompany)).toBe(true);
  });

  it('有授权行但全部撤销时公司不处于正式运行模式', () => {
    expect(
      resolveSyncCompanyApplicability({ authorizationCount: 2, activeAuthorizationCount: 0 }),
    ).toBe(false);
  });

  it('没有任何授权行时属未取得事实，不得硬编码为真或假', () => {
    expect(
      resolveSyncCompanyApplicability({ authorizationCount: 0, activeAuthorizationCount: 0 }),
    ).toBe(null);
  });

  it('材料级明确不适用时直接判不适用', () => {
    expect(resolveSyncApplicability(false, activeCompany)).toBe(false);
  });

  it('材料级无法判定时判未知（不因公司级事实而断言）', () => {
    expect(resolveSyncApplicability(null, activeCompany)).toBe(null);
  });

  it('材料级适用且公司处于正式运行模式时判适用', () => {
    expect(resolveSyncApplicability(true, activeCompany)).toBe(true);
  });

  it('材料级适用但公司授权全部撤销时判不适用', () => {
    expect(
      resolveSyncApplicability(true, { authorizationCount: 1, activeAuthorizationCount: 0 }),
    ).toBe(false);
  });

  it('材料级适用但未取得公司授权事实时判未知', () => {
    expect(
      resolveSyncApplicability(true, { authorizationCount: 0, activeAuthorizationCount: 0 }),
    ).toBe(null);
  });
});
