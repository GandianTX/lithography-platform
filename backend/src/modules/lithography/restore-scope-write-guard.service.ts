// src/modules/lithography/restore-scope-write-guard.service.ts

/**
 * 恢复期写入冻结守卫（任务 09 新计划第 04 项）。
 *
 * ## 为什么需要它
 *
 * 恢复采用"**先按公司数据区清空、再按清单写回**"的整体替换策略，
 * 因此恢复期间**任何落到该公司数据区的写入**都会污染恢复结果
 * （恢复出来的库与业务看到的事实不一致）。
 *
 * 既有守卫（`LocalWriteHoldService.assertBusinessWritable`）已挂在 40 余个业务写入口，
 * 但**本轮把备份/恢复范围扩到 26 张表**之后，有几类写入路径落在新纳入的表上、
 * 且此前**没有**守卫：
 *
 * | 表 | 写入方 | 风险 |
 * | --- | --- | --- |
 * | `repair_request_intake`／`intake_analysis_attempt` | 首析后台 Worker、用户主动重试 | 后台回写推进首析状态，恢复后与备份不一致 |
 * | `ai_conversation`／`ai_message`／`ai_message_analysis` | AI 会话前台入口、AI Worker 回调、分析结算 | 同上 |
 * | `engineer_response` | 工程师回复 | 同上 |
 * | `local_upload_task` | 上传尝试／完成／失败回执 | 队列状态与备份不一致 |
 * | `reference_document_case_detail` | 资料案例明细（当前无生产调用方） | 同上（接线即成缺口） |
 *
 * ## 口径
 *
 * 判定口径＝**"被写行所属公司数据区"**，与备份/恢复范围**同列**
 * （`BACKUP_TABLE_DESCRIPTORS` 的公司归属定义）：
 * 根表按自带公司列，子表按**父表**归属递归解析。
 * 这样"守卫放行的写入"与"恢复会替换的写入"是同一批行，不会出现
 * "恢复覆盖了它、但守卫放过了它"的缝隙。
 *
 * ## 既有语义保留
 *
 * 本守卫最终调用 `assertBusinessWritable`：
 * 本机**未初始化本地运行身份**时按"无冻结"放行
 * ——业务未启用本地部署的既有语义不变（见 `LocalWriteHoldService` 注释）。
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';

import { AiConversationEntity } from './entities/ai-conversation.entity';
import { AiMessageAnalysisEntity } from './entities/ai-message-analysis.entity';
import { ReferenceDocumentEntity } from './entities/reference-document.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { RepairRequestIntakeEntity } from './entities/repair-request-intake.entity';

import { LocalWriteHoldService } from './local-write-hold.service';

@Injectable()
export class RestoreScopeWriteGuardService {
  constructor(
    private readonly localWriteHoldService: LocalWriteHoldService,
    @InjectRepository(RepairRequestEntity)
    private readonly repairRequestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(RepairRequestIntakeEntity)
    private readonly repairRequestIntakeRepository: Repository<RepairRequestIntakeEntity>,
    @InjectRepository(AiConversationEntity)
    private readonly aiConversationRepository: Repository<AiConversationEntity>,
    @InjectRepository(AiMessageAnalysisEntity)
    private readonly aiMessageAnalysisRepository: Repository<AiMessageAnalysisEntity>,
    @InjectRepository(ReferenceDocumentEntity)
    private readonly referenceDocumentRepository: Repository<ReferenceDocumentEntity>,
  ) {}

  /**
   * 工单数据区守卫。
   *
   * 覆盖以工单为父的全部表：`repair_request` 本身、`repair_request_revision`、
   * `repair_process_entry`、`repair_request_diagnostic_step`、`repair_request_fault_panel`、
   * `ai_conversation`（按工单归属）、`ai_report`、`engineer_response`。
   */
  async assertRequestScopeWritable(
    requestId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const request = await this.repairRequestRepository.findOne({
      where: { id: requestId },
      select: { ownerOrganizationId: true },
    });
    await this.assertOrganizationScopeWritable(
      request?.ownerOrganizationId ?? null,
      transactionContext,
    );
  }

  /**
   * 报修原稿数据区守卫。
   *
   * 覆盖 `repair_request_intake`（服务公司口径）与 `intake_analysis_attempt`（按父表归属）。
   */
  async assertIntakeScopeWritable(
    intakeId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const intake = await this.repairRequestIntakeRepository.findOne({
      where: { id: intakeId },
      select: { serviceOrganizationId: true },
    });
    await this.assertOrganizationScopeWritable(
      intake?.serviceOrganizationId ?? null,
      transactionContext,
    );
  }

  /**
   * AI 会话数据区守卫。
   *
   * 覆盖 `ai_conversation`、`ai_message`、`ai_message_analysis`。
   * 会话归属＝会话自带归属列；会话未挂接工单时回落到工单归属
   * （与 `BACKUP_TABLE_DESCRIPTORS.ai_conversation` 的口径一致：
   * 父键为空时回落到自身 `owner_organization_id`）。
   */
  async assertConversationScopeWritable(
    conversationId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const conversation = await this.aiConversationRepository.findOne({
      where: { id: conversationId },
      select: { ownerOrganizationId: true, requestId: true },
    });
    if (conversation === null) {
      // 行已不存在 ⇒ 不属于任何公司数据区（与备份/恢复范围口径一致），不受冻结影响
      return;
    }
    if (conversation.requestId !== null && conversation.requestId !== undefined) {
      await this.assertRequestScopeWritable(conversation.requestId, transactionContext);
      return;
    }
    await this.assertOrganizationScopeWritable(
      conversation.ownerOrganizationId ?? null,
      transactionContext,
    );
  }

  /**
   * AI 分析行数据区守卫（按问题 UUID 定位会话）。
   *
   * 覆盖 `ai_message_analysis` 的终态写入（完成／失败／重试重置）。
   */
  async assertAnalysisScopeWritable(
    questionUuid: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const analysis = await this.aiMessageAnalysisRepository.findOne({
      where: { questionUuid },
      select: { conversationId: true },
    });
    if (analysis === null) {
      return;
    }
    await this.assertConversationScopeWritable(analysis.conversationId, transactionContext);
  }

  /**
   * 资料数据区守卫。
   *
   * 覆盖 `reference_document`、`reference_document_revision`、
   * `reference_document_case_detail`。
   */
  async assertDocumentScopeWritable(
    documentId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const document = await this.referenceDocumentRepository.findOne({
      where: { id: documentId },
      select: { ownerOrganizationId: true },
    });
    await this.assertOrganizationScopeWritable(
      document?.ownerOrganizationId ?? null,
      transactionContext,
    );
  }

  /**
   * 直接按公司数据区守卫（本机运行数据等自带公司列的表）。
   *
   * 归属为空 ⇒ 该行不属于任何公司数据区 ⇒ 不受冻结影响（与备份/恢复范围口径一致）。
   */
  async assertOrganizationScopeWritable(
    organizationId: number | null | undefined,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    await this.localWriteHoldService.assertBusinessWritableInTransaction({
      organizationId,
      transactionContext,
    });
  }
}
