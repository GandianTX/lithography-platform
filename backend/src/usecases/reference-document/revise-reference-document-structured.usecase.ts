// src/usecases/reference-document/revise-reference-document-structured.usecase.ts
// 任务 07 结构化管理修订用例（报告来源正式资料，仅一级管理员）。
//
// 业务流程（本轮确认需求 四.3）：
// 1. 角色决策：仅一级管理员（守卫 + 账号等级事实复核）；二级管理员与工程师
//    即使直调接口也被拒绝，不提供正式正文编辑权；原作者删除能力不受影响。
// 2. 输入决策：expected_version 非负整数；原因必填；结构化内容为全量值语义，
//    厂家文本在白名单（按报告字段规则校验）；机型仅支持改选已启用机型
//    （undefined=保持原值；显式 null=拒绝），名称由服务端从字典取得，不信任客户端。
// 3. 资源决策：事务内 GLOBAL + FOR UPDATE 锁定读；版本核对过期拒绝；
//    仅当前生效来源可结构化编辑的资料可修订（普通资料 / 旧扁平修订不得
//    转换为结构化内容，避免伪造或丢弃既有内容）。
// 4. 分支一致性：复位/步骤新故障启用条件与编辑器一致；步骤稳定编码关联，
//    调序不改关联；非法分支失败关闭。
// 5. 事务内原子提交：追加修订行（before 携带修订前结构化内容，after 携带新
//    结构化内容 + 派生正文）→ 条件推进 current_revision_no 并应用白名单字段；
//    未命中整体回滚，无半写。
// 6. 不改任务 06 原始数据：maintenance_report_version 冻结快照、来源工单、
//    客户回复均只读；原始冻结报告经 frozenReport 追溯视图并存。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { ReferenceDocumentRevisionService } from '@src/modules/lithography/reference-document-revision.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  assertDocumentIdValid,
  assertReferenceDocumentFirstLevelAdmin,
} from './reference-document-roles';
import {
  assertExpectedRevisionNo,
  buildRevisionSnapshots,
  resolveEffectiveContentText,
  resolveEffectiveStructuredContent,
} from './reference-document-management.helpers';
import {
  composeStructuredContentText,
  normalizeStructuredRevisionContent,
  toStructuredSnapshotValue,
} from './reference-document-structured-content';
import {
  assertExpectedVersionInput,
  type ReferenceDocumentManagedMutationResult,
  type ReviseReferenceDocumentStructuredCommand,
} from './reference-document.types';
import {
  assertManagementReason,
  isFaultCaseDocumentType,
  normalizeTitle,
} from './reference-document-fields.normalize';

@Injectable()
export class ReviseReferenceDocumentStructuredUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly revisionService: ReferenceDocumentRevisionService,
    private readonly accountQueryService: AccountQueryService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: ReviseReferenceDocumentStructuredCommand,
  ): Promise<ReferenceDocumentManagedMutationResult> {
    await assertReferenceDocumentFirstLevelAdmin({
      session: command.session,
      accountQueryService: this.accountQueryService,
    });
    assertDocumentIdValid(command.documentId);
    assertExpectedVersionInput(command.expectedVersion);
    const reason = assertManagementReason(command.reason);
    assertRevisionPatchHasField(command.patch);

    return this.transactionRunner.run((transactionContext) =>
      this.doRevise(command, reason, transactionContext),
    );
  }

  private async doRevise(
    command: ReviseReferenceDocumentStructuredCommand,
    reason: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ReferenceDocumentManagedMutationResult> {
    const current = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      scope: { kind: 'GLOBAL' },
      transactionContext,
      forUpdate: true,
    });
    assertExpectedRevisionNo(current, command.expectedVersion);

    if (isFaultCaseDocumentType(current.documentType)) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '案例资料不得通过管理修订改造，请使用案例更正接口',
        { id: current.id },
      );
    }

    const readers = {
      referenceDocumentQueryService: this.referenceDocumentQueryService,
      maintenanceReportQueryService: this.maintenanceReportQueryService,
    };
    const base = await resolveEffectiveStructuredContent(current, readers);
    if (base === null) {
      // 普通资料 / 旧扁平修订：不把扁平正文强行转换成结构化报告，
      // 也不静默丢弃既有内容；扁平编辑走既有修订入口。
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '该资料不是报告来源结构化资料，不能按结构化报告修订',
        { id: current.id, sourceKind: current.sourceKind },
      );
    }

    const normalized = normalizeStructuredRevisionContent(command.patch.structured);
    // 机型改选：undefined=保持原关联与名称快照；null=显式清空拒绝；
    // 变更目标按 ID 事务内校验存在且启用，名称从字典取得（不信任客户端自报名称）
    const modelChange = await this.resolveEquipmentModelChange(
      current,
      command.patch.equipmentModelId,
      transactionContext,
    );
    const merged = {
      ...normalized,
      equipmentModelText:
        modelChange.changed === true ? modelChange.modelName : base.equipmentModelText,
    };
    const composedText = composeStructuredContentText(merged);

    const currentEffectiveText = await resolveEffectiveContentText(current, readers);
    const nextTitle =
      command.patch.title !== undefined ? normalizeTitle(command.patch.title) : undefined;

    const { beforeSnapshot, afterSnapshot } = buildRevisionSnapshots({
      detail: current,
      beforeContentText: currentEffectiveText,
      afterContentText: composedText,
      beforeStructuredReport: toStructuredSnapshotValue(base),
      afterStructuredReport: toStructuredSnapshotValue(merged),
      overrides: {
        ...(nextTitle !== undefined ? { title: nextTitle } : {}),
        ...(command.patch.description !== undefined
          ? { description: command.patch.description }
          : {}),
      },
    });

    const nextRevisionNo = command.expectedVersion + 1;
    await this.revisionService.insertRevision(
      {
        documentId: command.documentId,
        revisionNo: nextRevisionNo,
        beforeSnapshot,
        afterSnapshot,
        actorAccountId: command.session.accountId,
        reason,
      },
      transactionContext,
    );

    const outcome = await this.revisionService.advanceCurrentRevision(
      {
        documentId: command.documentId,
        expectedRevisionNo: command.expectedVersion,
        apply: {
          ...(nextTitle !== undefined ? { title: nextTitle } : {}),
          ...(command.patch.description !== undefined
            ? { description: command.patch.description }
            : {}),
          ...(modelChange.changed === true ? { equipmentModelId: modelChange.modelId } : {}),
          contentText: composedText,
          updatedByAccountId: command.session.accountId,
        },
      },
      transactionContext,
    );
    if (outcome !== 'ADVANCED') {
      // 未命中：行事实已被并发操作改变；修订行插入随事务整体回滚，无半写
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT,
        '参考资料版本已更新，请重新读取当前版本后重试',
        { id: command.documentId },
      );
    }

    return { id: command.documentId, revisionNo: nextRevisionNo };
  }

  /**
   * 机型改选解析（本轮确认需求 二.2/二.3）：
   * - undefined：未提交 → 保持原关联与名称快照（不做字典查询，历史机型停用不阻塞
   *   只改厂家或其他内容）；
   * - null：显式清空 → 拒绝（机型只改选、不清空、不手填、不新建）；
   * - 与现有关联相同：按未改处理（保留原名称快照，不重复查询）；
   * - 变更目标：事务内 findModelById FOR UPDATE 校验存在且启用（防止「校验启用 →
   *   提交」窗口内被并发停用），名称从字典取得写入快照。
   */
  private async resolveEquipmentModelChange(
    current: { id: number; equipmentModelId: number | null },
    requested: number | null | undefined,
    transactionContext: PersistenceTransactionContext,
  ): Promise<{ changed: false } | { changed: true; modelId: number; modelName: string }> {
    if (requested === undefined) {
      return { changed: false };
    }
    if (requested === null) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '机型不允许清空，只能改选已有机型',
        { id: current.id },
      );
    }
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '机型改选目标必须是有效机型 ID',
        { id: current.id, equipmentModelId: requested },
      );
    }
    if (requested === current.equipmentModelId) {
      return { changed: false };
    }
    const model = await this.equipmentModelQueryService.findModelById({
      id: requested,
      transactionContext,
    });
    if (model === null) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND,
        '改选的设备型号不存在',
        { id: current.id, equipmentModelId: requested },
      );
    }
    if (!model.enabled) {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_DISABLED,
        '改选的设备型号已停用，不能选用',
        { id: current.id, equipmentModelId: requested },
      );
    }
    return { changed: true, modelId: model.id, modelName: model.modelName };
  }
}

function assertRevisionPatchHasField(
  patch: ReviseReferenceDocumentStructuredCommand['patch'],
): void {
  if (
    patch.title === undefined &&
    patch.description === undefined &&
    patch.structured === undefined &&
    patch.equipmentModelId === undefined
  ) {
    throw new DomainError(
      REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      '管理修订至少需要一个可编辑字段',
    );
  }
}
