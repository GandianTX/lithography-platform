// src/usecases/local-runtime/dispatch-business-sync-tasks.selfcheck.spec.ts
/// <reference types="jest" />

/**
 * S2 自检：业务同步派发链的场景化验证（任务 09 总计划 S2.4）。
 *
 * 覆盖计划列出的场景：两来源正常、重复、并发、云端再次变化、越权直调、旧响应、
 * 断网撤权、原件不完整、下架后重放。
 *
 * 接收端说明：生产云接收端尚不可用（R-02 缺口），本文件用**受控替身**
 * （backend/test/utils/business-sync-receiver.stub.ts，仅测试目录、不注册生产装配）
 * 产出可编排的回包；真实联调缺口单列在执行记录中，不以替身结果冒充真实验证。
 */

import { composeBusinessSyncEntityLocalId } from '@core/local-runtime/policy/business-sync-source.policy';

import {
  BusinessSyncReceiverStub,
  type BusinessSyncReceiverStubScript,
} from '../../../test/utils/business-sync-receiver.stub';

import { DispatchBusinessSyncTasksUsecase } from './dispatch-business-sync-tasks.usecase';

const INSTALLATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ORGANIZATION_ID = 9;
const CHECKSUM = 'a'.repeat(64);

type SourceSpec = {
  resourceType: 'REPAIR_REQUEST' | 'REFERENCE_DOCUMENT';
  recordUuid: string;
  recordId: number;
  version: number;
  accountId: number;
  withdrawn?: boolean;
  currentVersion?: number;
  authorization?: 'ACTIVE' | 'REVOKED';
  taskOrganizationId?: number | null;
  taskAccountId?: number | null;
};

function makeTask(source: SourceSpec, id: number) {
  return {
    id,
    installationId: INSTALLATION_ID,
    entityType: 'REPORT_VERSION',
    entityLocalId: composeBusinessSyncEntityLocalId(source.resourceType, source.recordId),
    entityVersion: String(source.version),
    idempotencyKey: `business-sync:${source.recordUuid}:${source.version}`,
    recordUuid: source.recordUuid,
    sourceVersion: source.version,
    manifestChecksum: CHECKSUM,
    taskKind: 'BUSINESS_SYNC',
    organizationId:
      source.taskOrganizationId === undefined ? ORGANIZATION_ID : source.taskOrganizationId,
    accountId: source.taskAccountId === undefined ? source.accountId : source.taskAccountId,
    status: 'PENDING',
    attemptCount: 0,
    lastAttemptAt: null,
    remoteId: null,
    remoteReceipt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildSelfCheck(sources: SourceSpec[], script: BusinessSyncReceiverStubScript | null) {
  const startUploadAttempt = jest.fn().mockResolvedValue(undefined);
  const completeUploadTask = jest.fn().mockResolvedValue(undefined);
  const failUploadTask = jest.fn().mockResolvedValue(undefined);
  const cancelUploadTask = jest.fn().mockResolvedValue(undefined);
  const requeueUploadTask = jest.fn().mockResolvedValue(undefined);

  const tasks = sources.map((source, index) => makeTask(source, index + 1));
  const localRuntimeQueryService = {
    readInstallation: jest.fn().mockResolvedValue({
      installationId: INSTALLATION_ID,
      organizationId: ORGANIZATION_ID,
    }),
    listBusinessSyncTasks: jest.fn().mockResolvedValue(tasks),
  };
  const facts = new Map<string, Record<string, unknown>>();
  const authorizations = new Map<number, 'ACTIVE' | 'REVOKED'>();
  const payloads = new Map<string, Record<string, unknown>>();
  for (const source of sources) {
    facts.set(source.recordUuid, {
      resourceType: source.resourceType,
      recordUuid: source.recordUuid,
      recordId: source.recordId,
      ownerOrganizationId: ORGANIZATION_ID,
      currentVersion: source.currentVersion ?? source.version,
      versionTrusted: true,
      materialApplicable: source.withdrawn === true ? false : true,
      relatedAccountIds: [source.accountId],
      authorizationSubjectAccountId: source.accountId,
      withdrawn: source.withdrawn === true,
      identityPersisted: true,
      contentState: { withdrawn: source.withdrawn === true, frozen: false, closed: false },
    });
    authorizations.set(
      source.accountId,
      source.authorization === undefined ? 'ACTIVE' : source.authorization,
    );
    payloads.set(source.recordUuid, {
      resourceType: source.resourceType,
      recordId: source.recordId,
      recordUuid: source.recordUuid,
      versionNo: source.version,
      body: { schema_version: 1, content_md: `内容-${source.recordUuid}` },
      originals: [{ relativePath: 'originals/a.pdf', sha256: 'b'.repeat(64), byteSize: 1024 }],
      manifestChecksum: CHECKSUM,
    });
  }

  const sourceRecordQueryService = {
    listFacts: jest.fn().mockResolvedValue({ facts, scanComplete: true }),
  };
  const syncStatusQueryService = {
    readAuthorizations: jest.fn().mockResolvedValue(authorizations),
  };
  const businessSyncSourceService = {
    readPayload: jest.fn(({ recordUuid }: { recordUuid: string }) =>
      Promise.resolve(payloads.get(recordUuid)),
    ),
  };
  const businessSyncReceiptService = {
    recordSuccess: jest.fn().mockResolvedValue(undefined),
    recordConflict: jest.fn().mockResolvedValue(undefined),
  };
  const transactionRunner = {
    run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn({})),
  };
  const receiver = script === null ? null : new BusinessSyncReceiverStub(script);

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
  };
}

const ORDER: SourceSpec = {
  resourceType: 'REPAIR_REQUEST',
  recordUuid: '11111111-2222-4333-8444-555555555555',
  recordId: 12,
  version: 3,
  accountId: 5,
};

const DOCUMENT: SourceSpec = {
  resourceType: 'REFERENCE_DOCUMENT',
  recordUuid: '99999999-8888-4777-8666-555555555555',
  recordId: 34,
  version: 2,
  accountId: 6,
};

describe('S2 自检 · 业务同步派发链场景', () => {
  it('场景1｜两来源正常：工单与资料各成功一次，回执按来源分别落', async () => {
    const { usecase, businessSyncReceiptService, completeUploadTask } = buildSelfCheck(
      [ORDER, DOCUMENT],
      { kind: 'ACCEPT' },
    );

    const result = await usecase.execute();

    expect(result.succeeded).toBe(2);
    expect(completeUploadTask).toHaveBeenCalledTimes(2);
    const receipts = businessSyncReceiptService.recordSuccess.mock.calls.map((call) => call[0]);
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.resourceType).sort()).toEqual([
      'REFERENCE_DOCUMENT',
      'REPAIR_REQUEST',
    ]);
    expect(new Set(receipts.map((receipt) => receipt.recordUuid)).size).toBe(2);
  });

  it('场景2｜重复：响应丢失后重试，回执键不变（幂等落点唯一）', async () => {
    const { usecase, businessSyncReceiptService } = buildSelfCheck([ORDER], { kind: 'ACCEPT' });

    await usecase.execute();
    await usecase.execute();

    const receipts = businessSyncReceiptService.recordSuccess.mock.calls.map((call) => call[0]);
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        organizationId: ORGANIZATION_ID,
        recordUuid: ORDER.recordUuid,
        versionNo: ORDER.version,
      });
    }
  });

  it('场景3｜并发：任务已被他人领走时不发、不回退他人在途状态', async () => {
    const { usecase, startUploadAttempt, requeueUploadTask, completeUploadTask } = buildSelfCheck(
      [ORDER],
      { kind: 'ACCEPT' },
    );
    startUploadAttempt.mockRejectedValueOnce(new Error('UPLOAD_TASK_CONFLICT'));

    const result = await usecase.execute();

    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(requeueUploadTask).not.toHaveBeenCalled();
    expect(completeUploadTask).not.toHaveBeenCalled();
  });

  it('场景4｜云端再次变化：再次冲突，冲突事实按同键幂等落库', async () => {
    const { usecase, businessSyncReceiptService } = buildSelfCheck([ORDER], {
      kind: 'CONFLICT',
      cloudVersionNo: 6,
    });

    await usecase.execute();
    await usecase.execute();

    const conflicts = businessSyncReceiptService.recordConflict.mock.calls.map((call) => call[0]);
    expect(conflicts).toHaveLength(2);
    for (const conflict of conflicts) {
      expect(conflict).toMatchObject({
        organizationId: ORGANIZATION_ID,
        recordUuid: ORDER.recordUuid,
        versionNo: ORDER.version,
      });
    }
  });

  it('场景5｜越权直调：任务绑定的公司不是本机公司时不派发', async () => {
    const { usecase, cancelUploadTask, startUploadAttempt } = buildSelfCheck(
      [{ ...ORDER, taskOrganizationId: 10 }],
      { kind: 'ACCEPT' },
    );

    const result = await usecase.execute();

    expect(result.skipped).toBe(1);
    expect(startUploadAttempt).not.toHaveBeenCalled();
    expect(cancelUploadTask).toHaveBeenCalledTimes(1);
  });

  it('场景5b｜越权直调：任务绑定的账号没有本机授权时不派发', async () => {
    const { usecase, cancelUploadTask, startUploadAttempt } = buildSelfCheck(
      [{ ...ORDER, taskAccountId: 777, authorization: 'REVOKED' }],
      { kind: 'ACCEPT' },
    );

    const result = await usecase.execute();

    expect(result.skipped).toBe(1);
    expect(startUploadAttempt).not.toHaveBeenCalled();
    expect(cancelUploadTask).toHaveBeenCalledTimes(1);
  });

  it('场景6｜旧响应：云端回的是更旧版本，不判成功', async () => {
    const scenario = buildSelfCheck([ORDER], { kind: 'ACCEPT' });
    (scenario.receiver as unknown as { send: unknown }).send = jest.fn().mockResolvedValue({
      status: 'ACCEPTED',
      reason: 'ACCEPTED',
      organizationId: ORGANIZATION_ID,
      recordUuid: ORDER.recordUuid,
      versionNo: ORDER.version - 1,
      manifestChecksum: CHECKSUM,
      receivedOriginals: [
        { relativePath: 'originals/a.pdf', sha256: 'b'.repeat(64), byteSize: 1024 },
      ],
      remoteResourceId: 'remote-old',
      snapshot: null,
      receivedAt: '2026-11-22T00:00:00.000Z',
    });

    const result = await scenario.usecase.execute();

    expect(result.succeeded).toBe(0);
    expect(result.rejected).toBe(1);
    expect(scenario.businessSyncReceiptService.recordSuccess).not.toHaveBeenCalled();
    expect(scenario.failUploadTask).toHaveBeenCalledTimes(1);
  });

  it('场景7｜断网撤权：网络异常期间撤权，之后不再派发', async () => {
    const offline = buildSelfCheck([ORDER], { kind: 'ERROR' });

    const offlineResult = await offline.usecase.execute();

    expect(offlineResult.retryable).toBe(1);
    expect(offline.requeueUploadTask).toHaveBeenCalledTimes(1);

    const revoked = buildSelfCheck([{ ...ORDER, authorization: 'REVOKED' }], { kind: 'ACCEPT' });
    const revokedResult = await revoked.usecase.execute();

    expect(revokedResult.skipped).toBe(1);
    expect(revoked.startUploadAttempt).not.toHaveBeenCalled();
  });

  it('场景8｜原件不完整：云端只收到部分原件，不判成功', async () => {
    const { usecase, businessSyncReceiptService, failUploadTask } = buildSelfCheck([ORDER], {
      kind: 'DROP_ORIGINALS',
    });

    const result = await usecase.execute();

    expect(result.rejected).toBe(1);
    expect(businessSyncReceiptService.recordSuccess).not.toHaveBeenCalled();
    expect(failUploadTask).toHaveBeenCalledTimes(1);
  });

  it('场景9｜下架后重放：来源已下架的遗留任务不再派发', async () => {
    const { usecase, cancelUploadTask, startUploadAttempt } = buildSelfCheck(
      [{ ...ORDER, withdrawn: true }],
      { kind: 'ACCEPT' },
    );

    const result = await usecase.execute();

    expect(result.skipped).toBe(1);
    expect(startUploadAttempt).not.toHaveBeenCalled();
    expect(cancelUploadTask).toHaveBeenCalledTimes(1);
  });

  it('接收端缺失：任务留在待传，不伪造成功，也不算失败', async () => {
    const { usecase, businessSyncReceiptService, failUploadTask } = buildSelfCheck([ORDER], null);

    const result = await usecase.execute();

    expect(result.receiverMissing).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(businessSyncReceiptService.recordSuccess).not.toHaveBeenCalled();
    expect(failUploadTask).not.toHaveBeenCalled();
  });
});
