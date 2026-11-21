/// <reference types="jest" />
import {
  resolveSyncStatus,
  syncStatusEnum,
  SHARED_SYNC_STATUSES,
  type SyncStatusFacts,
} from './sync-status.policy';

describe('resolveSyncStatus（同步状态聚合纯规则）', () => {
  const baseFacts = (overrides: Partial<SyncStatusFacts> = {}): SyncStatusFacts => ({
    connected: true,
    identityTrusted: true,
    versionTrusted: true,
    applicable: true,
    authorizationValid: true,
    task: null,
    receipt: null,
    conflict: null,
    ...overrides,
  });

  const successfulReceipt = (overrides: Partial<SyncStatusFacts['receipt']> = {}) => ({
    status: 'SUCCEEDED' as const,
    versionNo: 3,
    manifestChecksum: 'a'.repeat(64),
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

  it('任务进行中时按真实状态返回 PENDING／UPLOADING', () => {
    expect(
      resolveSyncStatus(baseFacts({ task: { status: 'PENDING', sourceVersion: 3 } })).status,
    ).toBe('PENDING');
    expect(
      resolveSyncStatus(baseFacts({ task: { status: 'UPLOADING', sourceVersion: 3 } })).status,
    ).toBe('UPLOADING');
  });

  it('任务失败时返回 FAILED；仅剩取消任务时返回 FAILED 而不是已同步', () => {
    expect(
      resolveSyncStatus(baseFacts({ task: { status: 'FAILED', sourceVersion: 3 } })).status,
    ).toBe('FAILED');
    const cancelled = resolveSyncStatus(
      baseFacts({ task: { status: 'CANCELLED', sourceVersion: 3 } }),
    );
    expect(cancelled.status).toBe('FAILED');
    expect(cancelled.reasonCode).toBe('TASK_CANCELLED');
  });

  it('仅任务成功但缺少回执时不得判已同步', () => {
    const result = resolveSyncStatus(
      baseFacts({ task: { status: 'SUCCEEDED', sourceVersion: 3 }, receipt: null }),
    );

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('RECEIPT_MISSING');
  });

  it('回执版本与当前版本不一致时不得判已同步（旧回执不对应新正文）', () => {
    const result = resolveSyncStatus(
      baseFacts({
        task: { status: 'SUCCEEDED', sourceVersion: 4 },
        receipt: successfulReceipt({ versionNo: 3 }),
      }),
    );

    expect(result.status).toBe('UNKNOWN');
    expect(result.reasonCode).toBe('RECEIPT_VERSION_MISMATCH');
  });

  it('回执缺少摘要或正文／原件不完整时不得判已同步', () => {
    const cases = [
      successfulReceipt({ manifestChecksum: null }),
      successfulReceipt({ bodyComplete: false }),
      successfulReceipt({ originalsComplete: false }),
    ];
    for (const receipt of cases) {
      const result = resolveSyncStatus(
        baseFacts({ task: { status: 'SUCCEEDED', sourceVersion: 3 }, receipt }),
      );
      expect(result.status).toBe('UNKNOWN');
      expect(result.reasonCode).toBe('RECEIPT_INCOMPLETE');
    }
  });

  it('当前版本有匹配的完整成功回执时才判已同步', () => {
    const result = resolveSyncStatus(
      baseFacts({
        task: { status: 'SUCCEEDED', sourceVersion: 3 },
        receipt: successfulReceipt(),
      }),
    );

    expect(result.status).toBe('SYNCED');
    expect(result.reasonCode).toBeNull();
    expect(result.conflictId).toBeNull();
  });

  it('任务与回执互相矛盾时按未知处理，不显示成功', () => {
    const pendingWithReceipt = resolveSyncStatus(
      baseFacts({
        task: { status: 'PENDING', sourceVersion: 3 },
        receipt: successfulReceipt(),
      }),
    );
    expect(pendingWithReceipt.status).toBe('UNKNOWN');
    expect(pendingWithReceipt.reasonCode).toBe('TASK_RECEIPT_INCONSISTENT');

    const succeededWithFailedReceipt = resolveSyncStatus(
      baseFacts({
        task: { status: 'SUCCEEDED', sourceVersion: 3 },
        receipt: successfulReceipt({ status: 'FAILED' }),
      }),
    );
    expect(succeededWithFailedReceipt.status).toBe('FAILED');
  });

  it('回执仍在进行时按 PENDING 处理', () => {
    const result = resolveSyncStatus(
      baseFacts({
        task: { status: 'SUCCEEDED', sourceVersion: 3 },
        receipt: successfulReceipt({ status: 'PENDING' }),
      }),
    );

    expect(result.status).toBe('PENDING');
  });

  it('当前版本存在待处理冲突时优先返回 CONFLICT', () => {
    const result = resolveSyncStatus(
      baseFacts({
        task: { status: 'UPLOADING', sourceVersion: 3 },
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
      baseFacts({
        task: { status: 'SUCCEEDED', sourceVersion: 3 },
        receipt: successfulReceipt({ status: 'CONFLICT' }),
      }),
    );

    expect(result.status).toBe('CONFLICT');
  });
});
