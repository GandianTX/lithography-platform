/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { BUSINESS_SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';

import { ReconcileBusinessSyncTasksUsecase } from './reconcile-business-sync-tasks.usecase';

const RECORD_UUID = '11111111-2222-4333-8444-555555555555';
const INSTALLATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

type Candidate = {
  resourceType: string;
  recordId: number;
  recordUuid: string | null;
  ownerOrganizationId: number | null;
  currentVersion: number | null;
  versionTrusted: boolean;
  withdrawn: boolean;
  identityPersisted: boolean;
  authorizationSubjectAccountId: number | null;
};

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    resourceType: 'MAINTENANCE_REPORT',
    recordId: 12,
    recordUuid: RECORD_UUID,
    ownerOrganizationId: 9,
    currentVersion: 3,
    versionTrusted: true,
    withdrawn: false,
    identityPersisted: true,
    authorizationSubjectAccountId: 5,
    ...overrides,
  };
}

function buildUsecase(
  overrides: {
    candidates?: Record<string, Candidate[]>;
    installation?: { installationId: string; organizationId: number | null } | null;
    enqueueResult?: (command: { resourceType: string; recordUuid: string }) => unknown;
    tasks?: { id: number; status: string }[];
  } = {},
) {
  const enqueue = jest.fn((command: { resourceType: string; recordUuid: string }) => {
    if (overrides.enqueueResult) {
      return overrides.enqueueResult(command);
    }
    return {
      taskId: 41,
      status: 'PENDING',
      created: true,
      recordUuid: command.recordUuid,
      resourceType: command.resourceType,
      sourceVersion: 3,
      manifestChecksum: 'a'.repeat(64),
    };
  });
  const cancelUploadTask = jest.fn().mockResolvedValue({ id: 7, status: 'CANCELLED' });
  const listCandidates = jest.fn((_organizationId: number, resourceType: string) => {
    return Promise.resolve(overrides.candidates?.[resourceType] ?? []);
  });
  const localRuntimeQueryService = {
    readInstallation: jest
      .fn()
      .mockResolvedValue(
        overrides.installation === undefined
          ? { installationId: INSTALLATION_ID, organizationId: 9 }
          : overrides.installation,
      ),
    listBusinessSyncTasksByRecordUuid: jest
      .fn()
      .mockResolvedValue(overrides.tasks ?? [{ id: 7, status: 'PENDING' }]),
  };
  const transactionRunner = {
    run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn({})),
  };

  const usecase = new ReconcileBusinessSyncTasksUsecase(
    { execute: enqueue } as never,
    { listSupportedResourceTypes: () => ['MAINTENANCE_REPORT'], listCandidates } as never,
    { cancelUploadTask } as never,
    localRuntimeQueryService as never,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    transactionRunner as never,
  );

  return { usecase, enqueue, cancelUploadTask, listCandidates };
}

describe('业务同步待办对账（S2.1）', () => {
  it('当前版本的来源记录登记为待传任务', async () => {
    const { usecase, enqueue } = buildUsecase({
      candidates: { MAINTENANCE_REPORT: [makeCandidate()] },
    });

    const result = await usecase.execute();

    expect(result.scanned).toBe(1);
    expect(result.created).toBe(1);
    expect(result.rejected).toBe(0);
    expect(enqueue).toHaveBeenCalledWith({
      resourceType: 'MAINTENANCE_REPORT',
      recordUuid: RECORD_UUID,
    });
  });

  it('命中既有任务时计为 existing，不重复登记', async () => {
    const { usecase } = buildUsecase({
      candidates: { MAINTENANCE_REPORT: [makeCandidate()] },
      enqueueResult: () => ({
        taskId: 41,
        status: 'PENDING',
        created: false,
        recordUuid: RECORD_UUID,
        resourceType: 'MAINTENANCE_REPORT',
        sourceVersion: 3,
        manifestChecksum: 'a'.repeat(64),
      }),
    });

    const result = await usecase.execute();

    expect(result.created).toBe(0);
    expect(result.existing).toBe(1);
  });

  it('已下架记录取消待办且不再登记新任务', async () => {
    const { usecase, enqueue, cancelUploadTask } = buildUsecase({
      candidates: { MAINTENANCE_REPORT: [makeCandidate({ withdrawn: true })] },
    });

    const result = await usecase.execute();

    expect(result.cancelled).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(cancelUploadTask).toHaveBeenCalledTimes(1);
  });

  it('已成功的历史任务不回滚（下架只取消仍待派发的部分）', async () => {
    const { usecase, cancelUploadTask } = buildUsecase({
      candidates: { MAINTENANCE_REPORT: [makeCandidate({ withdrawn: true })] },
      tasks: [{ id: 7, status: 'SUCCEEDED' }],
    });

    const result = await usecase.execute();

    expect(result.cancelled).toBe(0);
    expect(cancelUploadTask).not.toHaveBeenCalled();
  });

  it('稳定身份未持久化的历史行不生成任务，也不回填派生值', async () => {
    const { usecase, enqueue } = buildUsecase({
      candidates: { MAINTENANCE_REPORT: [makeCandidate({ recordUuid: null })] },
    });

    const result = await usecase.execute();

    expect(result.rejected).toBe(1);
    expect(result.rejections[BUSINESS_SYNC_ERROR.SOURCE_IDENTITY_UNTRUSTED]).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('单条准入失败不拖垮整轮（其余记录继续登记）', async () => {
    const secondUuid = '22222222-3333-4444-8555-666666666666';
    const { usecase } = buildUsecase({
      candidates: {
        MAINTENANCE_REPORT: [
          makeCandidate(),
          makeCandidate({ recordUuid: secondUuid, recordId: 13 }),
        ],
      },
      enqueueResult: (command) => {
        if (command.recordUuid === RECORD_UUID) {
          throw new DomainError(
            BUSINESS_SYNC_ERROR.AUTHORIZATION_INVALID,
            '原账号授权已失效，不得生成待传任务',
          );
        }
        return {
          taskId: 42,
          status: 'PENDING',
          created: true,
          recordUuid: command.recordUuid,
          resourceType: command.resourceType,
          sourceVersion: 3,
          manifestChecksum: 'a'.repeat(64),
        };
      },
    });

    const result = await usecase.execute();

    expect(result.rejected).toBe(1);
    expect(result.created).toBe(1);
    expect(result.rejections[BUSINESS_SYNC_ERROR.AUTHORIZATION_INVALID]).toBe(1);
  });

  it('本机未映射云端组织时失败关闭，不扫描任何来源记录', async () => {
    const { usecase, listCandidates } = buildUsecase({
      installation: { installationId: INSTALLATION_ID, organizationId: null },
    });

    await expect(usecase.execute()).rejects.toMatchObject({
      code: BUSINESS_SYNC_ERROR.INVALID_PARAMS,
    });
    expect(listCandidates).not.toHaveBeenCalled();
  });
});
