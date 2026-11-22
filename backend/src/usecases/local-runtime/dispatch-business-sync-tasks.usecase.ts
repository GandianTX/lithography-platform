// src/usecases/local-runtime/dispatch-business-sync-tasks.usecase.ts

import { BUSINESS_SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { parseBusinessSyncEntityLocalId } from '@core/local-runtime/policy/business-sync-source.policy';
import {
  resolveBusinessSyncVerdict,
  type BusinessSyncDispatchRequest,
  type BusinessSyncReceiverResponse,
} from '@core/local-runtime/policy/business-sync-protocol.policy';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { BusinessSyncReceiptService } from '@src/modules/lithography/business-sync-receipt.service';
import { BusinessSyncSourceService } from '@src/modules/lithography/business-sync-source.service';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import {
  SYNC_SOURCE_RESOURCE_TYPES,
  SyncSourceRecordQueryService,
  type SyncSourceResourceType,
} from '@src/modules/lithography/queries/sync-source-record.query.service';
import { SyncStatusQueryService } from '@src/modules/lithography/queries/sync-status.query.service';
import {
  BUSINESS_SYNC_RECEIVER,
  type BusinessSyncReceiver,
} from '@src/usecases/common/ports/business-sync-receiver.contract';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import type {
  DispatchBusinessSyncTasksCommand,
  DispatchBusinessSyncTasksOutcome,
  DispatchBusinessSyncTasksResult,
} from './local-runtime.command.types';

/**
 * 业务同步派发链（任务 09 S2.2）。
 *
 * 逐条任务做四道复核，再决定发不发：
 * 1. **绑定复核**：公司、原账号、稳定键、版本、摘要必须齐全——历史任务绑定为空，
 *    不据空值放行（宁可不发，也不猜归属）。
 * 2. **授权复核**：只认任务绑定的**原账号**在本机本公司的有效授权。授权续期后
 *    同一行恢复有效 → 继续派发；授权撤销 → 取消任务；换账号／换公司不改变任务
 *    绑定，因而**无法接管原任务**（R090）。
 * 3. **来源复核**：来源已删除／下架 → 取消任务；来源版本已被更新取代 → 取消任务，
 *    由对账用例按新版本重新登记。
 * 4. **摘要复核**：重算的正文＋原件清单摘要必须与任务登记值一致，否则说明登记
 *    之后内容被动过 → 失败关闭，不发。
 *
 * 派发结果处理：
 * - 接受 → 落成功回执（幂等）+ 任务成功；
 * - 冲突 → 落冲突事实（幂等）+ 任务失败（等人工裁决）；
 * - 拒绝 → 任务失败（受控原因码），不落回执；
 * - 网络异常／响应丢失／接收端缺失 → 退回待传，下一轮可续传。
 */
@Injectable()
export class DispatchBusinessSyncTasksUsecase {
  private readonly receiver: BusinessSyncReceiver | null;

  constructor(
    private readonly localRuntimeService: LocalRuntimeService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly sourceRecordQueryService: SyncSourceRecordQueryService,
    private readonly syncStatusQueryService: SyncStatusQueryService,
    private readonly businessSyncSourceService: BusinessSyncSourceService,
    private readonly businessSyncReceiptService: BusinessSyncReceiptService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    @Optional()
    @Inject(BUSINESS_SYNC_RECEIVER)
    receiver?: BusinessSyncReceiver | null,
  ) {
    // "没有生产接收端"与"接收端存在但失败"必须是两种不同的事实。
    this.receiver = receiver ?? null;
  }

  async execute(
    command: DispatchBusinessSyncTasksCommand = {},
  ): Promise<DispatchBusinessSyncTasksResult> {
    const result: DispatchBusinessSyncTasksResult = {
      scanned: 0,
      succeeded: 0,
      conflicted: 0,
      rejected: 0,
      retryable: 0,
      skipped: 0,
      receiverMissing: 0,
    };

    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(BUSINESS_SYNC_ERROR.INVALID_PARAMS, '本地安装身份未初始化');
    }

    // 写入/同步冻结闸门（任务 09 S5-2）：恢复期冻结的目标公司**不派发**同步任务
    if (installation.organizationId !== null) {
      await this.localWriteHoldService.assertCompanyWritable({
        organizationId: installation.organizationId,
      });
    }

    const tasks = await this.localRuntimeQueryService.listBusinessSyncTasks(
      installation.installationId,
      ['PENDING'],
      command.limit ?? 50,
    );

    for (const task of tasks) {
      result.scanned += 1;
      const outcome = await this.dispatchOne(task, installation);
      countOutcome(result, outcome);
    }

    return result;
  }

  /** 单条任务派发；返回本条的归类计数键 */
  private async dispatchOne(
    task: Awaited<ReturnType<LocalRuntimeQueryService['listBusinessSyncTasks']>>[number],
    installation: { installationId: string; organizationId: number | null },
  ): Promise<DispatchBusinessSyncTasksOutcome> {
    const installationId = installation.installationId;
    // 1. 绑定复核：绑定缺失的历史任务不据空值放行
    if (
      task.organizationId === null ||
      task.accountId === null ||
      task.recordUuid === null ||
      task.sourceVersion === null ||
      task.manifestChecksum === null
    ) {
      await this.cancelTask(
        task.id,
        BUSINESS_SYNC_ERROR.INVALID_PARAMS,
        '任务缺少公司与原账号绑定事实',
      );
      return 'skipped';
    }

    // 1b. 公司一致性复核：任务绑定的公司必须是**本机公司**。
    // 换公司不得接管原任务——绑定到别的公司的任务在本机没有派发依据。
    if (
      installation.organizationId === null ||
      task.organizationId !== installation.organizationId
    ) {
      await this.cancelTask(
        task.id,
        BUSINESS_SYNC_ERROR.INVALID_PARAMS,
        '任务绑定的公司与本机公司不一致，不派发',
      );
      return 'skipped';
    }

    // 2. 授权复核：只认原账号在本机本公司的有效授权
    const authorizationStatus = await this.resolveAuthorizationStatus(
      installationId,
      installation.organizationId,
      task.accountId,
    );
    if (authorizationStatus !== 'ACTIVE') {
      await this.cancelTask(
        task.id,
        BUSINESS_SYNC_ERROR.AUTHORIZATION_INVALID,
        '原账号授权已失效，待传任务不再派发',
      );
      return 'skipped';
    }

    // 3. 来源复核：已删除／下架／版本被取代的任务不再派发
    const resourceType = this.resolveResourceType(task.entityLocalId);
    if (resourceType === null) {
      await this.cancelTask(task.id, BUSINESS_SYNC_ERROR.INVALID_PARAMS, '任务来源类型无法识别');
      return 'skipped';
    }
    const { facts } = await this.sourceRecordQueryService.listFacts({
      organizationId: task.organizationId,
      resourceType,
      recordUuids: [task.recordUuid],
    });
    const fact = facts.get(task.recordUuid);
    if (!fact || fact.withdrawn) {
      await this.cancelTask(
        task.id,
        BUSINESS_SYNC_ERROR.SOURCE_WITHDRAWN,
        '来源记录已删除或下架，待传任务不再派发',
      );
      return 'skipped';
    }
    if (fact.currentVersion !== task.sourceVersion) {
      await this.cancelTask(
        task.id,
        BUSINESS_SYNC_ERROR.SOURCE_VERSION_UNTRUSTED,
        '来源记录版本已被更新取代，待传任务不再派发',
      );
      return 'skipped';
    }

    // 4. 素材组装与摘要复核
    let payload;
    try {
      payload = await this.businessSyncSourceService.readPayload({
        resourceType,
        recordId: fact.recordId,
        recordUuid: task.recordUuid,
        versionNo: task.sourceVersion,
      });
    } catch {
      await this.failTask(
        task.id,
        BUSINESS_SYNC_ERROR.INVALID_PARAMS,
        '来源素材读取失败，待传任务不派发',
      );
      return 'rejected';
    }
    if (payload.manifestChecksum !== task.manifestChecksum) {
      await this.failTask(
        task.id,
        BUSINESS_SYNC_ERROR.DISPATCH_REJECTED,
        '正文与原件清单摘要与任务登记值不一致，不派发',
      );
      return 'rejected';
    }

    // 5. 生产接收端缺失：任务留在待传，等接收端就绪后续传
    if (this.receiver === null) {
      return 'receiverMissing';
    }

    const request: BusinessSyncDispatchRequest = {
      organizationId: task.organizationId,
      installationId,
      accountId: task.accountId,
      resourceType,
      recordUuid: task.recordUuid,
      versionNo: task.sourceVersion,
      manifestChecksum: task.manifestChecksum,
      body: payload.body,
      originals: payload.originals,
      idempotencyKey: task.idempotencyKey,
    };

    let response: BusinessSyncReceiverResponse;
    try {
      await this.startAttempt(task.id);
    } catch {
      // 任务已被另一个派发者领走（并发）或状态写入失败：既不发，也不回退状态。
      // 回退会把另一个派发者的在途状态覆盖成 PENDING，制造"两个派发者同时发同一
      // 版本"；任务保持现状——UPLOADING 由对方收尾，PENDING／FAILED 由下一轮重试。
      return 'skipped';
    }
    try {
      response = await this.receiver.send(request);
    } catch {
      // 网络中断／响应丢失：退回待传，下一轮凭同一幂等键续传
      await this.requeueTask(
        task.id,
        BUSINESS_SYNC_ERROR.RECEIVER_MISSING,
        '接收端调用失败，待传任务退回待传',
      );
      return 'retryable';
    }

    const verdict = resolveBusinessSyncVerdict(request, response);
    if (verdict.status === 'ACCEPTED') {
      await this.completeTask(task, installationId, verdict.remoteResourceId, verdict.receivedAt);
      return 'succeeded';
    }
    if (verdict.status === 'CONFLICT') {
      await this.recordConflict(task, request, payload.body, verdict.cloudSnapshot, verdict.reason);
      return 'conflicted';
    }
    await this.failTask(task.id, verdict.reason, '云端拒绝本次同步');
    return 'rejected';
  }

  /** 原账号授权状态：只认任务绑定账号在本机本公司的授权登记 */
  private async resolveAuthorizationStatus(
    installationId: string,
    organizationId: number,
    accountId: number,
  ): Promise<'ACTIVE' | 'REVOKED' | 'UNKNOWN'> {
    const authorizations = await this.syncStatusQueryService.readAuthorizations(
      installationId,
      organizationId,
      [accountId],
    );
    return authorizations.get(accountId) ?? 'UNKNOWN';
  }

  /** 从本地实体 ID 还原来源类型（历史任务无法还原时返回 null） */
  private resolveResourceType(entityLocalId: number): SyncSourceResourceType | null {
    const parsed = parseBusinessSyncEntityLocalId(entityLocalId);
    if (parsed === null) {
      return null;
    }
    return SYNC_SOURCE_RESOURCE_TYPES.includes(parsed.resourceType as SyncSourceResourceType)
      ? (parsed.resourceType as SyncSourceResourceType)
      : null;
  }

  /** 开始一次派发尝试：PENDING→UPLOADING（并发下由行锁保证只有一个派发者） */
  private async startAttempt(taskId: number): Promise<void> {
    await this.transactionRunner.run((transactionContext) =>
      this.localRuntimeService.startUploadAttempt(taskId, transactionContext),
    );
  }

  /** 派发成功：同一事务内落回执并完成任务（回执幂等，响应丢失重试不产生第二行） */
  private async completeTask(
    task: {
      id: number;
      organizationId: number | null;
      recordUuid: string | null;
      sourceVersion: number | null;
      manifestChecksum: string | null;
      entityLocalId: number;
    },
    installationId: string,
    remoteResourceId: string | null,
    receivedAt: string | null,
  ): Promise<void> {
    await this.transactionRunner.run(async (transactionContext) => {
      await this.businessSyncReceiptService.recordSuccess(
        {
          organizationId: task.organizationId as number,
          resourceType: this.resolveResourceType(task.entityLocalId) as SyncSourceResourceType,
          recordUuid: task.recordUuid as string,
          versionNo: task.sourceVersion as number,
          manifestChecksum: task.manifestChecksum as string,
          installationId,
          remoteResourceId,
          receivedAt: receivedAt === null ? null : new Date(receivedAt),
        },
        transactionContext,
      );
      await this.localRuntimeService.completeUploadTask(
        task.id,
        { remoteId: remoteResourceId, remoteReceipt: task.manifestChecksum },
        transactionContext,
      );
    });
  }

  /** 冲突落库：冲突事实与任务失败同一事务，避免"有冲突但任务还在跑" */
  private async recordConflict(
    task: {
      id: number;
      organizationId: number | null;
      recordUuid: string | null;
      sourceVersion: number | null;
      manifestChecksum: string | null;
      entityLocalId: number;
    },
    request: BusinessSyncDispatchRequest,
    localBody: Record<string, unknown>,
    cloudSnapshot: Record<string, unknown> | null,
    reason: string,
  ): Promise<void> {
    await this.transactionRunner.run(async (transactionContext) => {
      await this.businessSyncReceiptService.recordConflict(
        {
          organizationId: request.organizationId,
          resourceType: request.resourceType,
          recordUuid: request.recordUuid,
          versionNo: request.versionNo,
          localVersion: request.versionNo,
          cloudVersion: null,
          localSnapshot: {
            schema_version: 1,
            resource_type: request.resourceType,
            record_uuid: request.recordUuid,
            version_no: request.versionNo,
            manifest_checksum: request.manifestChecksum,
            body: localBody,
          },
          cloudSnapshot: {
            schema_version: 1,
            version_no: null,
            body: cloudSnapshot ?? {},
          },
          conflictReason: `云端版本与本机不一致（${reason}）`,
        },
        transactionContext,
      );
      await this.localRuntimeService.failUploadTask(
        task.id,
        {
          errorCode: BUSINESS_SYNC_ERROR.CONFLICT_PENDING,
          errorMessage: '云端存在更新版本，待人工裁决',
        },
        transactionContext,
      );
    });
  }

  /** 任务失败（终态）：受控错误码 + 不含凭据的说明 */
  private async failTask(taskId: number, errorCode: string, errorMessage: string): Promise<void> {
    await this.transactionRunner.run((transactionContext) =>
      this.localRuntimeService.failUploadTask(
        taskId,
        { errorCode, errorMessage },
        transactionContext,
      ),
    );
  }

  /** 任务取消（不再派发） */
  private async cancelTask(taskId: number, errorCode: string, errorMessage: string): Promise<void> {
    await this.transactionRunner.run((transactionContext) =>
      this.localRuntimeService.cancelUploadTask(
        taskId,
        { errorCode, errorMessage },
        transactionContext,
      ),
    );
  }

  /** 退回待传（可重试） */
  private async requeueTask(
    taskId: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.transactionRunner.run((transactionContext) =>
      this.localRuntimeService.requeueUploadTask(
        taskId,
        { errorCode, errorMessage },
        transactionContext,
      ),
    );
  }
}

/** 按派发归类累加计数 */
function countOutcome(
  result: DispatchBusinessSyncTasksResult,
  outcome: DispatchBusinessSyncTasksOutcome,
): void {
  switch (outcome) {
    case 'succeeded':
      result.succeeded += 1;
      return;
    case 'conflicted':
      result.conflicted += 1;
      return;
    case 'rejected':
      result.rejected += 1;
      return;
    case 'retryable':
      result.retryable += 1;
      return;
    case 'skipped':
      result.skipped += 1;
      return;
    case 'receiverMissing':
      result.receiverMissing += 1;
      return;
  }
}
