/// <reference types="jest" />
import { composeBusinessSyncEntityLocalId } from '@core/local-runtime/policy/business-sync-source.policy';
import { createHash } from 'node:crypto';
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

/** 原件真实字节与其实测校验值（清单与字节必须逐项一致） */
const ORIGINAL_BYTES = new Uint8Array(Buffer.from('原件真实字节', 'utf8'));
const ORIGINAL_SHA256 = createHash('sha256').update(Buffer.from(ORIGINAL_BYTES)).digest('hex');

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
      originals: [
        {
          relativePath: 'originals/a.pdf',
          sha256: ORIGINAL_SHA256,
          byteSize: ORIGINAL_BYTES.byteLength,
        },
      ],
      // 原件字节：与清单逐项一致（真实链路里由本机实测读取）
      originalPayloads: [{ relativePath: 'originals/a.pdf', bytes: ORIGINAL_BYTES }],
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
    { assertCompanyWritable: jest.fn().mockResolvedValue(undefined) } as never,
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
    // 云端版本必须落库：裁决端在 cloudVersion 不可核验时拒绝「使用云端」
    // （写死 null 会让派发链产生的冲突永远无法用「使用云端」闭环）。
    expect(conflict.cloudVersion).toBe(5);
    expect(conflict.cloudSnapshot).toMatchObject({ version_no: 5 });
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

  it('原件字节与清单对不上：失败关闭，不派发（只报清单不送字节＝只报账不交货）', async () => {
    const { usecase, receiver } = buildUsecase({});
    // 篡改"本机实测读到的字节"，使其与清单登记的校验值不一致
    (
      usecase as unknown as {
        businessSyncSourceService: { readPayload: jest.Mock };
      }
    ).businessSyncSourceService.readPayload.mockResolvedValue({
      resourceType: 'MAINTENANCE_REPORT',
      recordId: 12,
      recordUuid: RECORD_UUID,
      versionNo: 3,
      body: { schema_version: 2 },
      originals: [
        {
          relativePath: 'originals/a.pdf',
          sha256: ORIGINAL_SHA256,
          byteSize: ORIGINAL_BYTES.byteLength,
        },
      ],
      originalPayloads: [
        {
          relativePath: 'originals/a.pdf',
          bytes: new Uint8Array(ORIGINAL_BYTES.byteLength).fill(0x41),
        },
      ],
      manifestChecksum: CHECKSUM,
    });

    const result = await usecase.execute();

    expect(result.rejected).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(receiver?.requests ?? []).toHaveLength(0);
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
