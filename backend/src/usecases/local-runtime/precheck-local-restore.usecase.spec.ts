/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { LocalBackupAssetQueryService } from '@src/modules/lithography/queries/local-backup-asset.query.service';
import type { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import type { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import type { ProtectedBackupService } from '@src/modules/lithography/protected-backup.service';
import type { BackupRestorePrecheckService } from '@src/modules/lithography/backup-restore-precheck.service';
import type { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { PrecheckLocalRestoreUsecase } from './precheck-local-restore.usecase';
import { asPinoLogger, createTestPinoLogger } from '../../../test/utils/test-pino-logger';

/**
 * 恢复预检用例：保护副本必须归属真实的本地备份运行。
 *
 * 缺陷回归（浏览器实测发现）：保护副本此前以 runId=null 生成资产行，
 * 落到 backup_asset.run_id=0，违反外键 fk_backup_asset_run，
 * 预检因此如实报出 PROTECTION_COPY_FAILED，保护副本始终建不出来。
 */
describe('PrecheckLocalRestoreUsecase', () => {
  const session = { accountId: 900101 } as UsecaseSession;

  function buildUsecase(options: { generateError?: Error; assetOrganizationId?: number }) {
    const generatedRuns: number[] = [];
    const finishedRuns: { id: number; status: string }[] = [];
    const generateCalls: { organizationId: number; runId: number | null }[] = [];

    const scopeResolver = {
      resolve: jest.fn(() =>
        Promise.resolve({ role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 }),
      ),
    };
    const queryService = {
      readInstallation: jest.fn(() =>
        Promise.resolve({ installationId: 'inst-1', organizationId: 4 }),
      ),
    };
    const assetQueryService = {
      readAssetSnapshot: jest.fn(() =>
        Promise.resolve({
          backupId: 'backup-1',
          organizationId: options.assetOrganizationId ?? 4,
          installationId: 'inst-1',
          localReference: '/var/local-backups/4/manual-1',
          localStatus: 'PENDING',
          manifestChecksum: 'a'.repeat(64),
        }),
      ),
    };
    const localRuntimeService = {
      insertBackupRun: jest.fn(() => {
        const id = 100 + generatedRuns.length;
        generatedRuns.push(id);
        return Promise.resolve({ id });
      }),
      finishBackupRun: jest.fn((id: number, data: { status: string }) => {
        finishedRuns.push({ id, status: data.status });
        return Promise.resolve();
      }),
    };
    const protectedBackupService = {
      resolvePackageTargetPath: jest.fn(() => '/var/local-backups/4/manual-protect'),
      generateProtectedBackup: jest.fn(
        (input: { organizationId: number; runId: number | null }) => {
          generateCalls.push({ organizationId: input.organizationId, runId: input.runId });
          if (options.generateError) {
            return Promise.reject(options.generateError);
          }
          return Promise.resolve({
            backupId: 'protection-1',
            packagePath: '/var/local-backups/4/manual-protect',
            manifestChecksum: 'b'.repeat(64),
            byteSize: 1024,
          });
        },
      ),
    };
    const precheckService = {
      execute: jest.fn((input: { createProtectionCopy: (org: number) => Promise<unknown> }) =>
        input.createProtectionCopy(4).then((protection) => ({
          restoreId: 'restore-1',
          outcome: 'PASSED',
          snapshot: { protection },
        })),
      ),
    };
    const transactionRunner = {
      run: jest.fn((work: (ctx: unknown) => unknown) => work({})),
    };

    const usecase = new PrecheckLocalRestoreUsecase(
      queryService as unknown as LocalRuntimeQueryService,
      assetQueryService as unknown as LocalBackupAssetQueryService,
      precheckService as unknown as BackupRestorePrecheckService,
      protectedBackupService as unknown as ProtectedBackupService,
      scopeResolver as unknown as LocalRuntimeScopeResolver,
      localRuntimeService as unknown as LocalRuntimeService,
      transactionRunner as never,
      asPinoLogger(createTestPinoLogger()),
    );

    return { usecase, generateCalls, generatedRuns, finishedRuns };
  }

  it('保护副本归属真实的本地备份运行（不再写 run_id=0）', async () => {
    const { usecase, generateCalls, generatedRuns, finishedRuns } = buildUsecase({});

    await usecase.execute({ session, backupId: 'backup-1' });

    expect(generatedRuns).toHaveLength(1);
    expect(generateCalls[0].runId).toBe(generatedRuns[0]);
    expect(generateCalls[0].runId).not.toBeNull();
    expect(finishedRuns).toEqual([{ id: generatedRuns[0], status: 'SUCCEEDED' }]);
  });

  it('保护副本生成失败时运行行落 FAILED 并如实抛出', async () => {
    const { usecase, generatedRuns, finishedRuns } = buildUsecase({
      generateError: new Error('磁盘空间不足'),
    });

    await expect(usecase.execute({ session, backupId: 'backup-1' })).rejects.toThrow(
      '磁盘空间不足',
    );
    expect(finishedRuns).toEqual([{ id: generatedRuns[0], status: 'FAILED' }]);
  });
});
