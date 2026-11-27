// src/core/local-runtime/policy/local-backup-upload.policy.spec.ts

import {
  BACKUP_UPLOAD_MAX_BACKOFF_MINUTES,
  computeNextUploadAttemptAt,
  computeUploadBackoffMinutes,
  decideBackupUploadAttempt,
  isBackupUploadAttemptAllowed,
  isSameAssetRetry,
  isUploadAttemptDue,
} from './local-backup-upload.policy';

/**
 * 自动上云重试与退避策略单测（任务 09 S3.2）。
 *
 * 以可控时钟验证退避边界、开关关闭、授权失效、重复调度与"重试原包不生新包"。
 */
describe('local backup upload policy', () => {
  const base = new Date('2026-11-21T00:00:00.000Z');

  it('退避时长逐级拉长并在上限封顶', () => {
    expect(computeUploadBackoffMinutes(1)).toBe(5);
    expect(computeUploadBackoffMinutes(2)).toBe(10);
    expect(computeUploadBackoffMinutes(3)).toBe(20);
    expect(computeUploadBackoffMinutes(4)).toBe(40);
    expect(computeUploadBackoffMinutes(5)).toBe(BACKUP_UPLOAD_MAX_BACKOFF_MINUTES);
    expect(computeUploadBackoffMinutes(50)).toBe(BACKUP_UPLOAD_MAX_BACKOFF_MINUTES);
  });

  it('非法尝试次数不会产出 NaN（否则下次可尝试时间变成 Invalid Date，资产永远卡住）', () => {
    expect(computeUploadBackoffMinutes(Number.NaN)).toBe(5);
    expect(computeUploadBackoffMinutes(Number.POSITIVE_INFINITY)).toBe(5);
    expect(Number.isNaN(computeNextUploadAttemptAt(Number.NaN, base, base).getTime())).toBe(false);
  });

  it('从未尝试过立即可尝试；已失败过按最近尝试时间叠加退避', () => {
    expect(computeNextUploadAttemptAt(0, null, base).getTime()).toBe(base.getTime());
    expect(computeNextUploadAttemptAt(1, base, base).getTime()).toBe(base.getTime() + 5 * 60_000);
    expect(computeNextUploadAttemptAt(3, base, base).getTime()).toBe(base.getTime() + 20 * 60_000);
  });

  it('到期判定以可控时刻为准', () => {
    expect(isUploadAttemptDue(null, base)).toBe(true);
    expect(isUploadAttemptDue(new Date(base.getTime() + 1000), base)).toBe(false);
    expect(isUploadAttemptDue(base, base)).toBe(true);
  });

  it('只有 PENDING 与 FAILED 可再次尝试', () => {
    expect(isBackupUploadAttemptAllowed('PENDING')).toBe(true);
    expect(isBackupUploadAttemptAllowed('FAILED')).toBe(true);
    expect(isBackupUploadAttemptAllowed('UPLOADING')).toBe(false);
    expect(isBackupUploadAttemptAllowed('SUCCEEDED')).toBe(false);
  });

  it('同一资产的再次尝试仍是同一备份包，不生成新包', () => {
    expect(isSameAssetRetry('backup-1', 'backup-1')).toBe(true);
    expect(isSameAssetRetry('backup-1', 'backup-2')).toBe(false);
    expect(isSameAssetRetry('', '')).toBe(false);
  });

  it('云开关关闭时不产生新的上传尝试', () => {
    const decision = decideBackupUploadAttempt({
      cloudStatus: 'FAILED',
      attemptCount: 3,
      lastAttemptAt: base,
      autoUploadEnabled: false,
      authorizationValid: true,
      now: base,
    });

    expect(decision).toEqual({ action: 'SKIP', reason: 'CLOUD_UPLOAD_DISABLED' });
  });

  it('授权失效时本轮不尝试，资产保持待上传事实', () => {
    const decision = decideBackupUploadAttempt({
      cloudStatus: 'PENDING',
      attemptCount: 0,
      lastAttemptAt: null,
      autoUploadEnabled: true,
      authorizationValid: false,
      now: base,
    });

    expect(decision).toEqual({ action: 'SKIP', reason: 'AUTHORIZATION_INVALID' });
  });

  it('已上云的资产不再重复尝试', () => {
    const decision = decideBackupUploadAttempt({
      cloudStatus: 'SUCCEEDED',
      attemptCount: 1,
      lastAttemptAt: base,
      autoUploadEnabled: true,
      authorizationValid: true,
      now: base,
    });

    expect(decision).toEqual({ action: 'SKIP', reason: 'ALREADY_SUCCEEDED' });
  });

  it('退避未到期时等待，到期后重试', () => {
    const waiting = decideBackupUploadAttempt({
      cloudStatus: 'FAILED',
      attemptCount: 2,
      lastAttemptAt: base,
      autoUploadEnabled: true,
      authorizationValid: true,
      now: new Date(base.getTime() + 60_000),
    });
    expect(waiting.action).toBe('WAIT');

    const retry = decideBackupUploadAttempt({
      cloudStatus: 'FAILED',
      attemptCount: 2,
      lastAttemptAt: base,
      autoUploadEnabled: true,
      authorizationValid: true,
      now: new Date(base.getTime() + 11 * 60_000),
    });
    expect(retry).toEqual({ action: 'RETRY', reason: 'BACKOFF_ELAPSED' });
  });

  it('本机包结构性失败（超限）⇒ 终态，不再进入退避重试', () => {
    const decision = decideBackupUploadAttempt({
      cloudStatus: 'FAILED',
      attemptCount: 1,
      lastAttemptAt: base,
      autoUploadEnabled: true,
      authorizationValid: true,
      failureReason: 'CLOUD_PACKAGE_TOO_LARGE',
      // 远晚于任何退避到期时刻：终态资产仍然不被重试
      now: new Date(base.getTime() + 24 * 60 * 60_000),
    });

    expect(decision).toEqual({ action: 'SKIP', reason: 'TERMINAL_PACKAGE_INVALID' });
  });

  it('本机包结构性失败（清单不可读／清单与字节不一致）⇒ 同样是终态', () => {
    for (const failureReason of ['CLOUD_PACKAGE_UNREADABLE', 'CLOUD_PACKAGE_INCOMPLETE']) {
      const decision = decideBackupUploadAttempt({
        cloudStatus: 'FAILED',
        attemptCount: 3,
        lastAttemptAt: base,
        autoUploadEnabled: true,
        authorizationValid: true,
        failureReason,
        now: new Date(base.getTime() + 24 * 60 * 60_000),
      });

      expect(decision).toEqual({ action: 'SKIP', reason: 'TERMINAL_PACKAGE_INVALID' });
    }
  });

  it('远端/网络类失败仍按退避重试（不因本次改动被误判为终态）', () => {
    const decision = decideBackupUploadAttempt({
      cloudStatus: 'FAILED',
      attemptCount: 1,
      lastAttemptAt: base,
      autoUploadEnabled: true,
      authorizationValid: true,
      failureReason: 'CLOUD_UNREACHABLE',
      now: new Date(base.getTime() + 11 * 60_000),
    });

    expect(decision).toEqual({ action: 'RETRY', reason: 'BACKOFF_ELAPSED' });
  });
});
