// src/usecases/local-runtime/enqueue-source-record-sync.usecase.ts

import { BUSINESS_SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  buildBusinessSyncIdempotencyKey,
  composeBusinessSyncEntityLocalId,
  resolveBusinessSyncSourceEligibility,
  type BusinessSyncSourceRejection,
} from '@core/local-runtime/policy/business-sync-source.policy';
import { Inject, Injectable } from '@nestjs/common';

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
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import type {
  EnqueueSourceRecordSyncCommand,
  EnqueueSourceRecordSyncResult,
} from './local-runtime.command.types';

/**
 * 来源记录 → 业务同步待传任务（任务 09 S2.1）。
 *
 * 这一步是「读侧能给出真实同步状态」的前提：待传任务必须落库**身份事实**
 * （稳定键、当前版本、正文与原件清单摘要、公司、原账号），否则读侧只能判
 * `UNKNOWN`（身份/版本不可核验）。
 *
 * 准入裁决（全部来自服务端事实，失败关闭，不生成"注定失败"的任务）：
 * 1. 来源记录必须存在且归属本机映射公司；
 * 2. 已删除／下架／撤回 → 不生成任务；
 * 3. 当前版本不可核验（草稿版本 0） → 不生成任务；
 * 4. 稳定身份未持久化（历史行只有派生键） → 不生成任务，不回填派生值；
 * 5. 原账号（授权主体）授权必须有效 → 换账号／换公司不得接管原任务（R090）。
 *
 * 幂等：同一（稳定键, 版本）重复调用返回既有任务（`created=false`）。
 */
@Injectable()
export class EnqueueSourceRecordSyncUsecase {
  constructor(
    private readonly localRuntimeService: LocalRuntimeService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly sourceRecordQueryService: SyncSourceRecordQueryService,
    private readonly syncStatusQueryService: SyncStatusQueryService,
    private readonly businessSyncSourceService: BusinessSyncSourceService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: EnqueueSourceRecordSyncCommand): Promise<EnqueueSourceRecordSyncResult> {
    const resourceType = normalizeResourceType(command.resourceType);
    const recordUuid = normalizeRecordUuid(command.recordUuid);

    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(BUSINESS_SYNC_ERROR.INVALID_PARAMS, '本地安装身份未初始化');
    }
    const organizationId = installation.organizationId;
    if (organizationId === null) {
      throw new DomainError(
        BUSINESS_SYNC_ERROR.INVALID_PARAMS,
        '本机未映射云端组织，无法确定数据区归属',
      );
    }

    // 写入/同步冻结闸门（任务 09 S5-2）：恢复期冻结的目标公司**不派发**同步任务
    await this.localWriteHoldService.assertCompanyWritable({ organizationId });

    const { facts } = await this.sourceRecordQueryService.listFacts({
      organizationId,
      resourceType,
      recordUuids: [recordUuid],
    });
    const fact = facts.get(recordUuid);
    if (!fact) {
      throw new DomainError(
        BUSINESS_SYNC_ERROR.SOURCE_NOT_FOUND,
        '来源记录不存在或不在本机数据区',
        { resourceType },
      );
    }

    const authorizationStatus = await this.resolveAuthorizationStatus(
      installation.installationId,
      organizationId,
      fact.authorizationSubjectAccountId,
    );

    const eligibility = resolveBusinessSyncSourceEligibility({
      withdrawn: fact.withdrawn,
      versionTrusted: fact.versionTrusted,
      currentVersion: fact.currentVersion,
      identityPersisted: fact.identityPersisted,
      authorizationStatus,
    });
    if (!eligibility.eligible || eligibility.version === null) {
      throw new DomainError(
        rejectionErrorCode(eligibility.rejection),
        rejectionMessage(eligibility.rejection),
        { resourceType, recordUuid },
      );
    }
    const version = eligibility.version;
    const accountId = fact.authorizationSubjectAccountId;
    if (accountId === null) {
      throw new DomainError(
        BUSINESS_SYNC_ERROR.AUTHORIZATION_INVALID,
        '来源记录缺少授权主体账号，无法绑定原账号授权',
        { resourceType, recordUuid },
      );
    }

    const payload = await this.businessSyncSourceService.readPayload({
      resourceType,
      recordId: fact.recordId,
      recordUuid,
      versionNo: version,
    });

    return this.transactionRunner.run(async (transactionContext) => {
      const { task, created } = await this.localRuntimeService.enqueueUploadTask(
        {
          installationId: installation.installationId,
          entityType: 'REPORT_VERSION',
          entityLocalId: composeBusinessSyncEntityLocalId(resourceType, fact.recordId),
          entityVersion: String(version),
          idempotencyKey: buildBusinessSyncIdempotencyKey(recordUuid, version),
          recordUuid,
          sourceVersion: version,
          manifestChecksum: payload.manifestChecksum,
          taskKind: 'BUSINESS_SYNC',
          organizationId,
          accountId,
        },
        transactionContext,
      );
      return {
        taskId: task.id,
        status: task.status,
        created,
        recordUuid,
        resourceType,
        sourceVersion: version,
        manifestChecksum: payload.manifestChecksum,
      };
    });
  }

  /**
   * 原账号授权状态：只认授权主体账号在本机本公司的授权登记。
   * 没有登记行 → `UNKNOWN`（未取得该事实），由准入裁决失败关闭处理。
   */
  private async resolveAuthorizationStatus(
    installationId: string,
    organizationId: number,
    subjectAccountId: number | null,
  ): Promise<'ACTIVE' | 'REVOKED' | 'UNKNOWN'> {
    if (subjectAccountId === null) {
      return 'UNKNOWN';
    }
    const authorizations = await this.syncStatusQueryService.readAuthorizations(
      installationId,
      organizationId,
      [subjectAccountId],
    );
    return authorizations.get(subjectAccountId) ?? 'UNKNOWN';
  }
}

/** 来源资源类型归一（与同步状态查询口径一致） */
function normalizeResourceType(value: string): SyncSourceResourceType {
  if (!SYNC_SOURCE_RESOURCE_TYPES.includes(value as SyncSourceResourceType)) {
    throw new DomainError(BUSINESS_SYNC_ERROR.INVALID_PARAMS, '来源资源类型不在支持清单内', {
      resourceType: value,
    });
  }
  return value as SyncSourceResourceType;
}

/** 稳定业务编号归一（36 位 UUID 文本） */
function normalizeRecordUuid(value: string): string {
  const normalized = (value ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new DomainError(BUSINESS_SYNC_ERROR.INVALID_PARAMS, '稳定业务编号必须为 36 位 UUID 文本');
  }
  return normalized;
}

/** 准入拒绝原因 → 错误码 */
function rejectionErrorCode(rejection: BusinessSyncSourceRejection | null): string {
  switch (rejection) {
    case 'WITHDRAWN':
      return BUSINESS_SYNC_ERROR.SOURCE_WITHDRAWN;
    case 'VERSION_UNTRUSTED':
      return BUSINESS_SYNC_ERROR.SOURCE_VERSION_UNTRUSTED;
    case 'IDENTITY_UNTRUSTED':
      return BUSINESS_SYNC_ERROR.SOURCE_IDENTITY_UNTRUSTED;
    case 'AUTHORIZATION_INVALID':
    case 'AUTHORIZATION_UNKNOWN':
      return BUSINESS_SYNC_ERROR.AUTHORIZATION_INVALID;
    default:
      return BUSINESS_SYNC_ERROR.INVALID_PARAMS;
  }
}

/** 准入拒绝原因 → 面向操作者的说明 */
function rejectionMessage(rejection: BusinessSyncSourceRejection | null): string {
  switch (rejection) {
    case 'WITHDRAWN':
      return '来源记录已删除或下架，不再生成待传任务';
    case 'VERSION_UNTRUSTED':
      return '来源记录当前版本不可核验，不生成待传任务';
    case 'IDENTITY_UNTRUSTED':
      return '来源记录缺少已持久化的跨端稳定身份，不生成待传任务';
    case 'AUTHORIZATION_INVALID':
      return '原账号授权已失效，不得生成待传任务';
    case 'AUTHORIZATION_UNKNOWN':
      return '本机没有该原账号的授权登记，不生成待传任务';
    default:
      return '来源记录不满足业务同步准入条件';
  }
}
