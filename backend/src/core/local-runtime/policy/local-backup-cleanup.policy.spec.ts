// src/core/local-runtime/policy/local-backup-cleanup.policy.spec.ts
// 本地备份包清理裁决单测（任务 09 S3.3）。
//
// 只证明本任务能证明的边界：完整回执判定、零清理、清单固定、过期裁决、
// 路径安全与中断可辨认。真实云接收端与真实文件删除属执行层，不在本文件范围。
//
// 口径依据任务书 R074-03（手动清理不额外要求每个旧包有云副本）与
// R083-01（过期清理只清过期成功本地包，云副本不是清理门槛）。

import * as nodePath from 'node:path';

import {
  decideManualCleanupTargets,
  decideRetentionCleanupTargets,
  hasLocalPackage,
  isBackupPackagePathInside,
  isCleanupInterrupted,
  isCompleteCloudReceipt,
  type BackupCleanupCandidate,
} from './local-backup-cleanup.policy';
import { BACKUP_RETENTION_DAYS } from './local-backup-plan.policy';

describe('local backup cleanup policy', () => {
  const base = new Date('2026-11-21T00:00:00.000Z');

  function candidate(overrides: Partial<BackupCleanupCandidate> = {}): BackupCleanupCandidate {
    return {
      backupId: 'backup-1',
      localStatus: 'PENDING',
      localReference: '/var/local-backups/4/manual-1',
      retentionUntil: null,
      createdAt: base,
      updatedAt: base,
      ...overrides,
    };
  }

  describe('完整云回执判定', () => {
    it('回执缺失判定为不完整（零清理的前置）', () => {
      expect(isCompleteCloudReceipt(null)).toEqual({
        complete: false,
        reason: 'CLOUD_RECEIPT_MISSING',
      });
      expect(isCompleteCloudReceipt('   ')).toEqual({
        complete: false,
        reason: 'CLOUD_RECEIPT_MISSING',
      });
    });

    it('回执不可解析判定为不完整', () => {
      expect(isCompleteCloudReceipt('not-json')).toEqual({
        complete: false,
        reason: 'CLOUD_RECEIPT_UNPARSEABLE',
      });
      expect(isCompleteCloudReceipt('["received"]')).toEqual({
        complete: false,
        reason: 'CLOUD_RECEIPT_UNPARSEABLE',
      });
    });

    it('回执无成功语义判定为不完整', () => {
      expect(isCompleteCloudReceipt('{"received":false}')).toEqual({
        complete: false,
        reason: 'CLOUD_RECEIPT_NOT_SUCCESS',
      });
      expect(isCompleteCloudReceipt('{"status":"FAILED"}')).toEqual({
        complete: false,
        reason: 'CLOUD_RECEIPT_NOT_SUCCESS',
      });
      expect(isCompleteCloudReceipt('{"error":"rejected"}')).toEqual({
        complete: false,
        reason: 'CLOUD_RECEIPT_NOT_SUCCESS',
      });
    });

    it('回执含明确成功语义判定为完整', () => {
      expect(isCompleteCloudReceipt('{"received":true}')).toEqual({ complete: true });
      expect(isCompleteCloudReceipt('{"status":"SUCCEEDED"}')).toEqual({ complete: true });
      expect(isCompleteCloudReceipt('{"status":"succeeded"}')).toEqual({ complete: true });
    });
  });

  describe('手动清理裁决', () => {
    it('回执不完整即零清理：清单为空且标记不可用', () => {
      const decision = decideManualCleanupTargets([candidate()], null);

      expect(decision.available).toBe(false);
      expect(decision.reason).toBe('CLOUD_RECEIPT_MISSING');
      expect(decision.targets).toHaveLength(0);
    });

    it('回执完整时固定本机公司包清单：只含仍有本地包的资产', () => {
      const decision = decideManualCleanupTargets(
        [
          candidate({ backupId: 'backup-1' }),
          candidate({ backupId: 'backup-2', localStatus: 'CLEANED', localReference: null }),
          candidate({ backupId: 'backup-3', localReference: null }),
          candidate({ backupId: 'backup-4', localStatus: 'CLEANING' }),
        ],
        '{"received":true}',
      );

      expect(decision.available).toBe(true);
      expect(decision.targets.map((target) => target.backupId)).toEqual(['backup-1', 'backup-4']);
    });

    it('已清理或无本地引用的资产不进入清单', () => {
      expect(hasLocalPackage(candidate({ localStatus: 'CLEANED' }))).toBe(false);
      expect(hasLocalPackage(candidate({ localReference: null }))).toBe(false);
      expect(hasLocalPackage(candidate())).toBe(true);
    });

    it('未进入清理清单的资产逐项给出原因（与过期清理同口径）', () => {
      const decision = decideManualCleanupTargets(
        [
          candidate({ backupId: 'backup-1' }),
          candidate({ backupId: 'backup-2', localStatus: 'CLEANED', localReference: null }),
          candidate({ backupId: 'backup-3', localReference: null }),
        ],
        '{"received":true}',
      );

      expect(decision.targets.map((target) => target.backupId)).toEqual(['backup-1']);
      expect(decision.skipped).toEqual([
        { backupId: 'backup-2', reason: 'PACKAGE_ALREADY_CLEANED' },
        { backupId: 'backup-3', reason: 'PACKAGE_REFERENCE_MISSING' },
      ]);
    });

    // 任务书 R074-03：「不是逐个旧包均须有云副本的新前提」
    it('授权成立后固定范围内的全部本地包都进入清单，不逐项复核云副本', () => {
      const decision = decideManualCleanupTargets(
        [
          candidate({ backupId: 'backup-1' }),
          candidate({ backupId: 'backup-2' }),
          candidate({ backupId: 'backup-3' }),
        ],
        '{"received":true}',
      );

      expect(decision.available).toBe(true);
      expect(decision.targets.map((target) => target.backupId)).toEqual([
        'backup-1',
        'backup-2',
        'backup-3',
      ]);
      expect(decision.skipped).toHaveLength(0);
    });
  });

  describe('过期清理裁决', () => {
    it('保留窗口未到不进入清理', () => {
      const decision = decideRetentionCleanupTargets(
        [candidate({ retentionUntil: new Date(base.getTime() + 86_400_000) })],
        base,
      );

      expect(decision.targets).toHaveLength(0);
      expect(decision.skipped[0]).toEqual({
        backupId: 'backup-1',
        reason: 'RETENTION_NOT_EXPIRED',
      });
    });

    it('到期即进入清理清单：云副本不是清理门槛，不强制留最近一份', () => {
      const decision = decideRetentionCleanupTargets(
        [
          candidate({ backupId: 'backup-1', retentionUntil: base }),
          candidate({ backupId: 'backup-2', retentionUntil: base }),
        ],
        base,
      );

      expect(decision.targets.map((target) => target.candidate.backupId)).toEqual([
        'backup-1',
        'backup-2',
      ]);
      expect(decision.skipped).toHaveLength(0);
    });

    it('已清理与无本地引用的资产记为跳过，不重复清理', () => {
      const decision = decideRetentionCleanupTargets(
        [
          candidate({ backupId: 'backup-1', localStatus: 'CLEANED', localReference: null }),
          candidate({ backupId: 'backup-2', localReference: null }),
        ],
        base,
      );

      expect(decision.targets).toHaveLength(0);
      expect(decision.skipped.map((entry) => entry.reason)).toEqual([
        'PACKAGE_ALREADY_CLEANED',
        'PACKAGE_REFERENCE_MISSING',
      ]);
    });

    it('保留截止时间缺失时按创建时间加保留窗口推算', () => {
      const decision = decideRetentionCleanupTargets(
        [candidate({ retentionUntil: null, createdAt: base })],
        new Date(base.getTime() + (BACKUP_RETENTION_DAYS - 1) * 86_400_000),
      );

      expect(decision.targets).toHaveLength(0);

      const expired = decideRetentionCleanupTargets(
        [candidate({ retentionUntil: null, createdAt: base })],
        new Date(base.getTime() + BACKUP_RETENTION_DAYS * 86_400_000),
      );
      expect(expired.targets).toHaveLength(1);
    });
  });

  describe('路径安全', () => {
    const root = '/var/local-backups';

    it('只接受备份根目录的严格子路径', () => {
      expect(isBackupPackagePathInside(root, '/var/local-backups/4/manual-1')).toBe(true);
      expect(isBackupPackagePathInside(root, '/var/local-backups')).toBe(false);
      expect(isBackupPackagePathInside(root, '/var/local-backups/../business')).toBe(false);
      expect(isBackupPackagePathInside(root, '/var/business-originals')).toBe(false);
      expect(isBackupPackagePathInside(root, '')).toBe(false);
    });

    it('以 ".." 开头的合法子目录名不算越界（此前被误判为越界）', () => {
      expect(isBackupPackagePathInside(root, '/var/local-backups/..data/manual-1')).toBe(true);
      expect(isBackupPackagePathInside(root, '/var/local-backups/..')).toBe(false);
      expect(isBackupPackagePathInside(root, '/var/local-backups/../business')).toBe(false);
    });

    it('相对路径按当前工作目录解析后仍须落在根目录内', () => {
      const resolved = nodePath.resolve('manual-1');
      expect(isBackupPackagePathInside(process.cwd(), resolved)).toBe(true);
      expect(isBackupPackagePathInside(process.cwd(), process.cwd())).toBe(false);
    });
  });

  describe('中断可辨认', () => {
    it('CLEANING 超过时限视为进程中断残留', () => {
      expect(
        isCleanupInterrupted(
          { localStatus: 'CLEANING', updatedAt: new Date(base.getTime() - 60 * 60_000) },
          base,
        ),
      ).toBe(true);
    });

    it('正在进行的清理与其它状态不判为中断', () => {
      expect(isCleanupInterrupted({ localStatus: 'CLEANING', updatedAt: base }, base)).toBe(false);
      expect(isCleanupInterrupted({ localStatus: 'PENDING', updatedAt: base }, base)).toBe(false);
      expect(isCleanupInterrupted({ localStatus: 'FAILED', updatedAt: base }, base)).toBe(false);
    });
  });
});
