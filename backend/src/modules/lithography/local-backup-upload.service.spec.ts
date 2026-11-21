// src/modules/lithography/local-backup-upload.service.spec.ts

import { LocalBackupUploadService } from './local-backup-upload.service';
import type { BackupAssetEntity } from './entities/backup-asset.entity';
import type { LocalCompanySettingEntity } from './entities/local-company-setting.entity';
import type {
  LocalBackupUploadRequest,
  LocalBackupUploadResult,
  LocalBackupUploader,
} from '@src/usecases/local-runtime/local-backup-upload.contract';

/**
 * 自动上云重试执行器单测（任务 09 S3.2）。
 *
 * 受控替身只证明本任务能证明的边界：失败分类、退避、重启后定位同一资产、
 * 开关关闭、授权失效与重复调度。真实云端接收端、认证与完整回执另列待联调。
 */
describe('local backup upload service', () => {
  const base = new Date('2026-11-21T00:00:00.000Z');

  function asset(overrides: Partial<BackupAssetEntity> = {}): BackupAssetEntity {
    return {
      backupId: 'backup-1',
      organizationId: 4,
      runId: 10,
      installationId: 'inst-1',
      localReference: '/var/local-backups/4/manual-1',
      cloudStatus: 'PENDING',
      cloudReference: null,
      cloudReceipt: null,
      manifestChecksum: 'a'.repeat(64),
      fileSha256: 'a'.repeat(64),
      byteSize: 100,
      localStatus: 'PENDING',
      deletedAt: null,
      failureReason: null,
      localCleanupError: null,
      verifiedAt: null,
      retentionUntil: null,
      attemptCount: 0,
      lastAttemptAt: null,
      createdAt: base,
      updatedAt: base,
      ...overrides,
    } as BackupAssetEntity;
  }

  function setting(overrides: Partial<LocalCompanySettingEntity> = {}): LocalCompanySettingEntity {
    return {
      organizationId: 4,
      installationId: 'inst-1',
      backupEnabled: true,
      backupIntervalHours: 72,
      nextBackupAt: null,
      lastAutoSuccessAt: null,
      lastAutoFailureAt: null,
      failureReason: null,
      autoUploadEnabled: true,
      isCurrent: true,
      initializedAt: base,
      createdAt: base,
      updatedAt: base,
      ...overrides,
    } as LocalCompanySettingEntity;
  }

  function buildService(options: {
    assets: BackupAssetEntity[];
    settings: LocalCompanySettingEntity[];
    /** 显式传 undefined 模拟 Nest 对未提供的 @Optional() 依赖注入 undefined 的情形 */
    uploader: LocalBackupUploader | null | undefined;
  }) {
    const updates: { backupId: string; patch: Record<string, unknown> }[] = [];
    const backupAssetRepository = {
      find: jest.fn().mockImplementation((input: { where: Record<string, unknown> }) => {
        const where = input.where ?? {};
        return Promise.resolve(
          options.assets.filter((row) =>
            Object.entries(where).every(([key, value]) => {
              const actual = row[key as keyof BackupAssetEntity];
              if (Array.isArray(value)) {
                return value.includes(actual);
              }
              // TypeORM 的 In()/LessThan() 包装为 FindOperator（_type + value）。
              const operator = value as Record<string, unknown>;
              const operatorType = operator['_type'];
              const operatorValue = operator['value'];
              if (operatorType === 'in' && Array.isArray(operatorValue)) {
                return operatorValue.includes(actual);
              }
              if (operatorType === 'lessThan') {
                const bound = operatorValue as number | Date;
                if (typeof actual === 'number' && typeof bound === 'number') {
                  return actual < bound;
                }
                if (actual instanceof Date && bound instanceof Date) {
                  return actual.getTime() < bound.getTime();
                }
                return false;
              }
              return actual === value;
            }),
          ),
        );
      }),
      update: jest
        .fn()
        .mockImplementation((where: { backupId: string }, patch: Record<string, unknown>) => {
          updates.push({ backupId: where.backupId, patch });
          const target = options.assets.find((row) => row.backupId === where.backupId);
          if (target) {
            Object.assign(target, patch);
          }
          return Promise.resolve({ affected: 1 });
        }),
    };
    const settingRepository = {
      find: jest.fn().mockResolvedValue(options.settings),
    };
    const service = new LocalBackupUploadService(
      backupAssetRepository as never,
      settingRepository as never,
      options.uploader,
    );

    return { service, updates };
  }

  it('云接收端未接入时如实跳过：不伪造尝试、不增长尝试次数、不改资产状态', async () => {
    const { service, updates } = buildService({
      assets: [asset()],
      settings: [setting()],
      uploader: null,
    });

    const result = await service.runOnce(base);

    expect(result.receiverMissing).toBe(1);
    expect(result.attempted).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('可选依赖未注册时（Nest 注入 undefined）同样按未接入处理', async () => {
    // 不提供接收端：Nest 会把未注册的 @Optional() 依赖注入为 undefined，
    // 这里必须与显式 null 走同一条"如实跳过"路径，而不是崩溃或伪造尝试。
    const { service, updates } = buildService({
      assets: [asset()],
      settings: [setting()],
      uploader: undefined,
    });

    const result = await service.runOnce(base);

    expect(result.receiverMissing).toBe(1);
    expect(result.attempted).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('上传失败后按退避重试同一备份包，不生成新的资产或包', async () => {
    const calls: LocalBackupUploadRequest[] = [];
    const uploader: LocalBackupUploader = {
      upload: (request: LocalBackupUploadRequest) => {
        calls.push(request);
        return Promise.resolve({
          status: 'FAILED',
          code: 'RECEIVER_REJECTED',
          reason: '云端拒绝接收',
        } satisfies LocalBackupUploadResult);
      },
    };
    const { service, updates } = buildService({
      assets: [asset()],
      settings: [setting()],
      uploader,
    });

    const result = await service.runOnce(base);

    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].backupId).toBe('backup-1');
    expect(updates[0].patch).toMatchObject({
      cloudStatus: 'UPLOADING',
      attemptCount: 1,
      lastAttemptAt: base,
    });
    expect(updates[1].patch).toMatchObject({
      cloudStatus: 'FAILED',
      failureReason: '云端拒绝接收',
    });
  });

  it('上传成功记录完整回执，且不触发本地包清理', async () => {
    const uploader: LocalBackupUploader = {
      upload: () =>
        Promise.resolve({
          status: 'SUCCEEDED',
          cloudReference: 'cloud://backup-1',
          receipt: '{"received":true}',
        } satisfies LocalBackupUploadResult),
    };
    const { service, updates } = buildService({
      assets: [asset()],
      settings: [setting()],
      uploader,
    });

    const result = await service.runOnce(base);

    expect(result.succeeded).toBe(1);
    expect(updates[1].patch).toMatchObject({
      cloudStatus: 'SUCCEEDED',
      cloudReference: 'cloud://backup-1',
      cloudReceipt: '{"received":true}',
    });
    expect(
      updates.every((entry) => !('localStatus' in entry.patch) && !('deletedAt' in entry.patch)),
    ).toBe(true);
  });

  it('退避未到期的失败资产本轮不重试', async () => {
    const uploader: LocalBackupUploader = {
      upload: () => Promise.resolve({ status: 'FAILED', code: 'X', reason: 'r' }),
    };
    const { service } = buildService({
      assets: [asset({ cloudStatus: 'FAILED', attemptCount: 2, lastAttemptAt: base })],
      settings: [setting()],
      uploader,
    });

    const result = await service.runOnce(new Date(base.getTime() + 60_000));

    expect(result.waiting).toBe(1);
    expect(result.attempted).toBe(0);
  });

  it('云开关关闭时不再产生新的上传尝试', async () => {
    const upload = jest.fn();
    const { service } = buildService({
      assets: [asset({ cloudStatus: 'FAILED', attemptCount: 5, lastAttemptAt: base })],
      settings: [setting({ autoUploadEnabled: false })],
      uploader: { upload },
    });

    const result = await service.runOnce(new Date(base.getTime() + 10 * 60_000));

    expect(result.skipped).toBe(1);
    expect(upload).not.toHaveBeenCalled();
  });

  it('授权失效时不尝试上传', async () => {
    const upload = jest.fn();
    const { service } = buildService({
      assets: [asset()],
      settings: [],
      uploader: { upload },
    });

    const result = await service.runOnce(base);

    expect(result.skipped).toBe(1);
    expect(upload).not.toHaveBeenCalled();
  });

  it('进程重启后残留的 UPLOADING 改判失败并按退避重试同一资产', async () => {
    const upload = jest.fn().mockResolvedValue({
      status: 'FAILED',
      code: 'X',
      reason: '重试失败',
    } satisfies LocalBackupUploadResult);
    const { service, updates } = buildService({
      assets: [
        asset({
          cloudStatus: 'UPLOADING',
          attemptCount: 1,
          lastAttemptAt: new Date(base.getTime() - 60 * 60_000),
        }),
      ],
      settings: [setting()],
      uploader: { upload },
    });

    const result = await service.runOnce(base);

    expect(result.compensated).toBe(1);
    expect(result.attempted).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0].backupId).toBe('backup-1');
    expect(updates[0].patch).toMatchObject({ cloudStatus: 'FAILED' });
  });

  it('重复调度时同一轮内每个资产只尝试一次', async () => {
    const upload = jest.fn().mockResolvedValue({
      status: 'FAILED',
      code: 'X',
      reason: 'r',
    } satisfies LocalBackupUploadResult);
    const { service } = buildService({
      assets: [asset({ backupId: 'backup-1' }), asset({ backupId: 'backup-2' })],
      settings: [setting()],
      uploader: { upload },
    });

    const result = await service.runOnce(base);

    expect(result.attempted).toBe(2);
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
