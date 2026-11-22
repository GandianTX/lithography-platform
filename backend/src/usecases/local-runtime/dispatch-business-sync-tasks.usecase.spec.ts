/// <reference types="jest" />
import { composeBusinessSyncEntityLocalId } from '@core/local-runtime/policy/business-sync-source.policy';
import type { BusinessSyncReceiverResponse } from '@core/local-runtime/policy/business-sync-protocol.policy';

import {
  BusinessSyncReceiverStub,
  type BusinessSyncReceiverStubScript,
} from '../../../test/utils/business-sync-receiver.stub';

import { DispatchBusinessSyncTasksUsecase } from './dispatch-business-sync-tasks.usecase';

const INSTALLATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RECORD_UUID = '11111111-2222-4333-8444-555555555555';
const ORGANIZATION_ID = 9;
const ACCOUNT_ID = 5;
const CHECKSUM = 'a'.repeat(64);

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    installationId: INSTALLATION_ID,
    entityType: 'REPORT_VERSION',
    entityLocalId: composeBusinessSyncEntityLocalId('MAINTENANCE_REPORT', 12),
    entityVersion: '3',
    idempotencyKey: `business-sync:${RECORD_UUID}:3`,
    recordUuid: RECORD_UUID,
    sourceVersion: 3,
    manifestChecksum: CHECKSUM,
    taskKind: 'BUSINESS_SYNC',
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    status: 'PENDING',
    attemptCount: 0,
    lastAttemptAt: null,
    remoteId: null,
    remoteReceipt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildUsecase(
  overrides: {
    script?: BusinessSyncReceiverStubScript | null;
    task?: Record<string, unknown>;
    authorization?: 'ACTIVE' | 'REVOKED' | 'UNKNOWN';
    fact?: Record<string, unknown> | null;
    payloadChecksum?: string;
    receiverResponse?: BusinessSyncReceiverResponse;
  } = {},
) {
  const startUploadAttempt = jest.fn().mockResolvedValue(makeTask({ status: 'UPLOADING' }));
  const completeUploadTask = jest.fn().mockResolvedValue(makeTask({ status: 'SUCCEEDED' }));
  const failUploadTask = jest.fn().mockResolvedValue(makeTask({ status: 'FAILED' }));
  const cancelUploadTask = jest.fn().mockResolvedValue(makeTask({ status: 'CANCELLED' }));
  const requeueUploadTask = jest.fn().mockResolvedValue(makeTask({ status: 'PENDING' }));

  const localRuntimeQueryService = {
    readInstallation: jest.fn().mockResolvedValue({
      installationId: INSTALLATION_ID,
      organizationId: ORGANIZATION_ID,
    }),
    listBusinessSyncTasks: jest.fn().mockResolvedValue([overrides.task ?? makeTask()]),
  };
  const sourceRecordQueryService = {
    listFacts: jest.fn().mockResolvedValue({
      facts:
        overrides.fact === null
          ? new Map()
          : new Map([
              [
                RECORD_UUID,
                {
                  resourceType: 'MAINTENANCE_REPORT',
                  recordUuid: RECORD_UUID,
                  recordId: 12,
                  ownerOrganizationId: ORGANIZATION_ID,
                  currentVersion: 3,
                  versionTrusted: true,
                  materialApplicable: true,
                  relatedAccountIds: [ACCOUNT_ID],
                  authorizationSubjectAccountId: ACCOUNT_ID,
                  withdrawn: false,
                  identityPersisted: true,
                  ...(overrides.fact ?? {}),
                },
              ],
            ]),
      scanComplete: true,
    }),
  };
  const authorization = overrides.authorization ?? 'ACTIVE';
  const syncStatusQueryService = {
    readAuthorizations: jest
      .fn()
      .mockResolvedValue(
        new Map<number, 'ACTIVE' | 'REVOKED'>(
          authorization === 'UNKNOWN' ? [] : [[ACCOUNT_ID, authorization]],
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
      originals: [{ relativePath: 'originals/a.pdf', sha256: 'b'.repeat(64), byteSize: 1024 }],
      manifestChecksum: overrides.payloadChecksum ?? CHECKSUM,
    }),
  };
  const businessSyncReceiptService = {
    recordSuccess: jest.fn().mockResolvedValue(undefined),
    recordConflict: jest.fn().mockResolvedValue(undefined),
  };
  const transactionRunner = {
    run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn({})),
  };

  const receiver =
    overrides.script === null
      ? null
      : new BusinessSyncReceiverStub(overrides.script ?? { kind: 'ACCEPT' });
  if (receiver !== null && overrides.receiverResponse !== undefined) {
    (receiver as unknown as { send: unknown }).send = jest
      .fn()
      .mockResolvedValue(overrides.receiverResponse);
  }

  const usecase = new DispatchBusinessSyncTasksUsecase(
    {
      startUploadAttempt,
      completeUploadTask,
      failUploadTask,
      cancelUploadTask,
      requeueUploadTask,
    } as never,
    localRuntimeQueryService as never,
    sourceRecordQueryService as never,
    syncStatusQueryService as never,
    businessSyncSourceService as never,
    businessSyncReceiptService as never,
    transactionRunner as never,
    receiver,
  );

  return {
    usecase,
    receiver,
    startUploadAttempt,
    completeUploadTask,
    failUploadTask,
    cancelUploadTask,
    requeueUploadTask,
    businessSyncReceiptService,
    syncStatusQueryService,
  };
}

describe('业务同步派发链（S2.2）', () => {
  it('核对通过：落成功回执并把任务标记成功', async () => {
    const { usecase, businessSyncReceiptService, completeUploadTask } = buildUsecase({
      script: { kind: 'ACCEPT' },
    });

    const result = await usecase.execute();

    expect(result.scanned).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(businessSyncReceiptService.recordSuccess).toHaveBeenCalledTimes(1);
    const receipt = businessSyncReceiptService.recordSuccess.mock.calls[0][0];
    expect(receipt.organizationId).toBe(ORGANIZATION_ID);
    expect(receipt.recordUuid).toBe(RECORD_UUID);
    expect(receipt.versionNo).toBe(3);
    expect(receipt.manifestChecksum).toBe(CHECKSUM);
    expect(receipt.installationId).toBe(INSTALLATION_ID);
    expect(completeUploadTask).toHaveBeenCalledTimes(1);
  });

  it('生产接收端缺失：任务留在待传，不伪造成功', async () => {
    const { usecase, completeUploadTask, businessSyncReceiptService } = buildUsecase({
      script: null,
    });

    const result = await usecase.execute();

    expect(result.receiverMissing).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(completeUploadTask).not.toHaveBeenCalled();
    expect(businessSyncReceiptService.recordSuccess).not.toHaveBeenCalled();
  });

  it('响应丢失（调用抛错）：退回待传，下一轮可凭同一幂等键续传', async () => {
    const { usecase, requeueUploadTask, completeUploadTask } = buildUsecase({
      script: { kind: 'ERROR' },
    });

    const result = await usecase.execute();

    expect(result.retryable).toBe(1);
    expect(requeueUploadTask).toHaveBeenCalledTimes(1);
    expect(completeUploadTask).not.toHaveBeenCalled();
  });

  it('部分成功（云端少收原件）：拒绝，不落成功回执', async () => {
    const { usecase, failUploadTask, businessSyncReceiptService } = buildUsecase({
      script: { kind: 'DROP_ORIGINALS' },
    });

    const result = await usecase.execute();

    expect(result.rejected).toBe(1);
    expect(failUploadTask).toHaveBeenCalledTimes(1);
    expect(businessSyncReceiptService.recordSuccess).not.toHaveBeenCalled();
  });

  it('云端存在更新版本：落冲突事实并把任务置为失败（等人工裁决）', async () => {
    const { usecase, businessSyncReceiptService, failUploadTask } = buildUsecase({
      script: { kind: 'CONFLICT', cloudVersionNo: 5 },
    });

    const result = await usecase.execute();

    expect(result.conflicted).toBe(1);
    expect(businessSyncReceiptService.recordConflict).toHaveBeenCalledTimes(1);
    const conflict = businessSyncReceiptService.recordConflict.mock.calls[0][0];
    expect(conflict.localVersion).toBe(3);
    expect(conflict.localSnapshot).toMatchObject({ schema_version: 1 });
    expect(conflict.cloudSnapshot).toMatchObject({ schema_version: 1 });
    expect(failUploadTask).toHaveBeenCalledTimes(1);
  });

  it('云端明确拒绝：任务失败，不落成功回执', async () => {
    const { usecase, failUploadTask } = buildUsecase({
      script: { kind: 'REJECT', reason: 'AUTHORIZATION_INVALID' },
    });

    const result = await usecase.execute();

    expect(result.rejected).toBe(1);
    expect(failUploadTask).toHaveBeenCalledTimes(1);
  });

  it('原账号授权被撤销：取消任务，不派发（换账号不得接管原任务）', async () => {
    const { usecase, cancelUploadTask, startUploadAttempt } = buildUsecase({
      authorization: 'REVOKED',
    });

    const result = await usecase.execute();

    expect(result.skipped).toBe(1);
    expect(cancelUploadTask).toHaveBeenCalledTimes(1);
    expect(startUploadAttempt).not.toHaveBeenCalled();
  });

  it('本机没有该原账号的授权登记：取消任务，不按"未取得"放行', async () => {
    const { usecase, cancelUploadTask } = buildUsecase({ authorization: 'UNKNOWN' });

    const result = await usecase.execute();

    expect(result.skipped).toBe(1);
    expect(cancelUploadTask).toHaveBeenCalledTimes(1);
  });

  it('来源已下架：取消任务，不派发', async () => {
    const { usecase, cancelUploadTask } = buildUsecase({ fact: { withdrawn: true } });

    const result = await usecase.execute();

    expect(result.skipped).toBe(1);
    expect(cancelUploadTask).toHaveBeenCalledTimes(1);
  });

  it('来源版本已被更新取代：取消旧任务（由对账按新版本重新登记）', async () => {
    const { usecase, cancelUploadTask } = buildUsecase({ fact: { currentVersion: 4 } });

    const result = await usecase.execute();

    expect(result.skipped).toBe(1);
    expect(cancelUploadTask).toHaveBeenCalledTimes(1);
  });

  it('登记后内容被改动（摘要不一致）：失败关闭，不派发', async () => {
    const { usecase, failUploadTask, startUploadAttempt } = buildUsecase({
      payloadChecksum: 'd'.repeat(64),
    });

    const result = await usecase.execute();

    expect(result.rejected).toBe(1);
    expect(failUploadTask).toHaveBeenCalledTimes(1);
    expect(startUploadAttempt).not.toHaveBeenCalled();
  });

  it('绑定缺失的历史任务：跳过，不据空值放行', async () => {
    const { usecase, cancelUploadTask, startUploadAttempt } = buildUsecase({
      task: makeTask({ organizationId: null, accountId: null }),
    });

    const result = await usecase.execute();

    expect(result.skipped).toBe(1);
    expect(cancelUploadTask).toHaveBeenCalledTimes(1);
    expect(startUploadAttempt).not.toHaveBeenCalled();
  });

  it('来源记录已不存在：取消任务，不派发', async () => {
    const { usecase, cancelUploadTask } = buildUsecase({ fact: null });

    const result = await usecase.execute();

    expect(result.skipped).toBe(1);
    expect(cancelUploadTask).toHaveBeenCalledTimes(1);
  });
});
