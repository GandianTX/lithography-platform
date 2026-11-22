/// <reference types="jest" />
import { BUSINESS_SYNC_ERROR } from '@core/common/errors/domain-error';

import { EnqueueSourceRecordSyncUsecase } from './enqueue-source-record-sync.usecase';

const INSTALLATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RECORD_UUID = '11111111-2222-4333-8444-555555555555';
const ORGANIZATION_ID = 9;

type SourceFact = {
  resourceType: string;
  recordUuid: string;
  recordId: number;
  ownerOrganizationId: number | null;
  currentVersion: number | null;
  versionTrusted: boolean;
  materialApplicable: boolean | null;
  relatedAccountIds: number[];
  authorizationSubjectAccountId: number | null;
  withdrawn: boolean;
  identityPersisted: boolean;
};

function makeFact(overrides: Partial<SourceFact> = {}): SourceFact {
  return {
    resourceType: 'MAINTENANCE_REPORT',
    recordUuid: RECORD_UUID,
    recordId: 12,
    ownerOrganizationId: ORGANIZATION_ID,
    currentVersion: 3,
    versionTrusted: true,
    materialApplicable: true,
    relatedAccountIds: [5],
    authorizationSubjectAccountId: 5,
    withdrawn: false,
    identityPersisted: true,
    ...overrides,
  };
}

function buildUsecase(
  overrides: {
    fact?: SourceFact | null;
    authorization?: 'ACTIVE' | 'REVOKED' | 'UNKNOWN';
    installation?: { installationId: string; organizationId: number | null } | null;
    enqueue?: { taskId: number; status: string; created: boolean };
  } = {},
) {
  const enqueueOutcome = overrides.enqueue ?? { taskId: 41, status: 'PENDING', created: true };
  const enqueueUploadTask = jest.fn().mockResolvedValue({
    task: { id: enqueueOutcome.taskId, status: enqueueOutcome.status },
    created: enqueueOutcome.created,
  });
  const localRuntimeQueryService = {
    readInstallation: jest
      .fn()
      .mockResolvedValue(
        overrides.installation === undefined
          ? { installationId: INSTALLATION_ID, organizationId: ORGANIZATION_ID }
          : overrides.installation,
      ),
  };
  const sourceRecordQueryService = {
    listFacts: jest.fn().mockResolvedValue({
      facts:
        overrides.fact === null
          ? new Map()
          : new Map([[RECORD_UUID, overrides.fact ?? makeFact()]]),
      scanComplete: true,
    }),
  };
  const authorizationStatus = overrides.authorization ?? 'ACTIVE';
  const syncStatusQueryService = {
    readAuthorizations: jest
      .fn()
      .mockResolvedValue(
        new Map<number, 'ACTIVE' | 'REVOKED'>(
          authorizationStatus === 'UNKNOWN' ? [] : [[5, authorizationStatus]],
        ),
      ),
  };
  const businessSyncSourceService = {
    readPayload: jest.fn().mockResolvedValue({
      resourceType: 'MAINTENANCE_REPORT',
      recordId: 12,
      recordUuid: RECORD_UUID,
      versionNo: 3,
      body: { schema_version: 2 },
      originals: [],
      manifestChecksum: 'a'.repeat(64),
    }),
  };
  const transactionRunner = {
    run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn({})),
  };

  const usecase = new EnqueueSourceRecordSyncUsecase(
    { enqueueUploadTask } as never,
    { assertCompanyWritable: jest.fn().mockResolvedValue(undefined) } as never,
    localRuntimeQueryService as never,
    sourceRecordQueryService as never,
    syncStatusQueryService as never,
    businessSyncSourceService as never,
    transactionRunner as never,
  );

  return {
    usecase,
    enqueueUploadTask,
    localRuntimeQueryService,
    sourceRecordQueryService,
    syncStatusQueryService,
    businessSyncSourceService,
  };
}

describe('来源记录 → 业务同步待传任务（S2.1）', () => {
  it('登记时写入稳定键、当前版本、正文原件摘要、公司与原账号', async () => {
    const { usecase, enqueueUploadTask } = buildUsecase();

    const result = await usecase.execute({
      resourceType: 'MAINTENANCE_REPORT',
      recordUuid: RECORD_UUID,
    });

    expect(result.taskId).toBe(41);
    expect(result.created).toBe(true);
    expect(result.sourceVersion).toBe(3);
    expect(result.manifestChecksum).toBe('a'.repeat(64));

    expect(enqueueUploadTask).toHaveBeenCalledTimes(1);
    const inserted = enqueueUploadTask.mock.calls[0][0];
    expect(inserted.recordUuid).toBe(RECORD_UUID);
    expect(inserted.sourceVersion).toBe(3);
    expect(inserted.manifestChecksum).toBe('a'.repeat(64));
    expect(inserted.taskKind).toBe('BUSINESS_SYNC');
    expect(inserted.organizationId).toBe(ORGANIZATION_ID);
    expect(inserted.accountId).toBe(5);
    expect(inserted.entityType).toBe('REPORT_VERSION');
    expect(inserted.entityVersion).toBe('3');
    expect(inserted.idempotencyKey).toContain(RECORD_UUID);
  });

  it('已下架／删除的来源记录不生成任务', async () => {
    const { usecase, enqueueUploadTask } = buildUsecase({
      fact: makeFact({ withdrawn: true }),
    });

    await expect(
      usecase.execute({ resourceType: 'MAINTENANCE_REPORT', recordUuid: RECORD_UUID }),
    ).rejects.toMatchObject({ code: BUSINESS_SYNC_ERROR.SOURCE_WITHDRAWN });
    expect(enqueueUploadTask).not.toHaveBeenCalled();
  });

  it('当前版本不可核验时不生成任务', async () => {
    const { usecase, enqueueUploadTask } = buildUsecase({
      fact: makeFact({ versionTrusted: false, currentVersion: null }),
    });

    await expect(
      usecase.execute({ resourceType: 'MAINTENANCE_REPORT', recordUuid: RECORD_UUID }),
    ).rejects.toMatchObject({ code: BUSINESS_SYNC_ERROR.SOURCE_VERSION_UNTRUSTED });
    expect(enqueueUploadTask).not.toHaveBeenCalled();
  });

  it('稳定身份未持久化时不生成任务（不回填派生值）', async () => {
    const { usecase, enqueueUploadTask } = buildUsecase({
      fact: makeFact({ identityPersisted: false }),
    });

    await expect(
      usecase.execute({ resourceType: 'MAINTENANCE_REPORT', recordUuid: RECORD_UUID }),
    ).rejects.toMatchObject({ code: BUSINESS_SYNC_ERROR.SOURCE_IDENTITY_UNTRUSTED });
    expect(enqueueUploadTask).not.toHaveBeenCalled();
  });

  it('原账号授权被撤销时不生成任务', async () => {
    const { usecase, enqueueUploadTask } = buildUsecase({ authorization: 'REVOKED' });

    await expect(
      usecase.execute({ resourceType: 'MAINTENANCE_REPORT', recordUuid: RECORD_UUID }),
    ).rejects.toMatchObject({ code: BUSINESS_SYNC_ERROR.AUTHORIZATION_INVALID });
    expect(enqueueUploadTask).not.toHaveBeenCalled();
  });

  it('本机没有原账号授权登记时不生成任务（不按"未取得"放行）', async () => {
    const { usecase, enqueueUploadTask } = buildUsecase({ authorization: 'UNKNOWN' });

    await expect(
      usecase.execute({ resourceType: 'MAINTENANCE_REPORT', recordUuid: RECORD_UUID }),
    ).rejects.toMatchObject({ code: BUSINESS_SYNC_ERROR.AUTHORIZATION_INVALID });
    expect(enqueueUploadTask).not.toHaveBeenCalled();
  });

  it('来源记录不存在时失败关闭', async () => {
    const { usecase, enqueueUploadTask } = buildUsecase({ fact: null });

    await expect(
      usecase.execute({ resourceType: 'MAINTENANCE_REPORT', recordUuid: RECORD_UUID }),
    ).rejects.toMatchObject({ code: BUSINESS_SYNC_ERROR.SOURCE_NOT_FOUND });
    expect(enqueueUploadTask).not.toHaveBeenCalled();
  });

  it('本机未映射云端组织时不生成任务', async () => {
    const { usecase, enqueueUploadTask } = buildUsecase({
      installation: { installationId: INSTALLATION_ID, organizationId: null },
    });

    await expect(
      usecase.execute({ resourceType: 'MAINTENANCE_REPORT', recordUuid: RECORD_UUID }),
    ).rejects.toMatchObject({ code: BUSINESS_SYNC_ERROR.INVALID_PARAMS });
    expect(enqueueUploadTask).not.toHaveBeenCalled();
  });

  it('重复提交命中既有任务（created=false，不重复登记）', async () => {
    const { usecase } = buildUsecase({
      enqueue: { taskId: 41, status: 'PENDING', created: false },
    });

    const result = await usecase.execute({
      resourceType: 'MAINTENANCE_REPORT',
      recordUuid: RECORD_UUID,
    });

    expect(result.created).toBe(false);
    expect(result.taskId).toBe(41);
  });

  it('非法来源类型与非法稳定键均失败关闭', async () => {
    const { usecase } = buildUsecase();

    await expect(
      usecase.execute({ resourceType: 'UNKNOWN', recordUuid: RECORD_UUID }),
    ).rejects.toMatchObject({ code: BUSINESS_SYNC_ERROR.INVALID_PARAMS });
    await expect(
      usecase.execute({ resourceType: 'MAINTENANCE_REPORT', recordUuid: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: BUSINESS_SYNC_ERROR.INVALID_PARAMS });
  });
});
