// src/usecases/reference-document/get-reference-document-editable-content.usecase.ts
// 任务 07 管理修订编辑初值读侧（独立管理修订页专用，仅一级管理员）。
//
// - 结构化模式（STRUCTURED）：报告来源正式资料或已携带结构化修订的资料，
//   初值 = 当前生效结构化内容（冻结版本派生或修订快照）；
// - 扁平模式（FLAT）：普通资料与旧扁平修订，初值 = 当前生效正文文本，
//   不伪造缺失的故障数据，也不把普通资料强行转换成维修报告；
// - FAULT_CASE 正文受案例更正专属通道保护（A-PR0 §S6），本读侧仅提示，
//   最终拒绝由写侧守卫裁决。
//
// 读侧不锁定：expected_version 仅作为编辑提交时的乐观令牌初始值，
// 提交时由写侧在事务内 FOR UPDATE 复核。

import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import {
  assertDocumentIdValid,
  assertReferenceDocumentFirstLevelAdmin,
} from './reference-document-roles';
import {
  resolveEffectiveContentText,
  resolveEffectiveStructuredContent,
} from './reference-document-management.helpers';
import { isFaultCaseDocumentType } from './reference-document-fields.normalize';
import type { ReferenceDocumentEditableContentCommand } from './reference-document.types';
import type { ReferenceDocumentStructuredContent } from './reference-document-structured-content';

export type ReferenceDocumentEditableContentView = {
  documentId: number;
  title: string;
  description: string | null;
  documentType: string;
  /** 编辑提交时的乐观令牌初始值（current_revision_no） */
  expectedVersion: number;
  sourceKind: string;
  mode: 'STRUCTURED' | 'FLAT';
  /** 结构化模式初值；扁平模式为 null */
  structured: ReferenceDocumentStructuredContent | null;
  /** 扁平模式初值（当前生效正文）；结构化模式为组合文本兜底 */
  contentText: string | null;
  /** 资料自身机型关联初值（改选 Select 的当前值；null 表示通用资料） */
  equipmentModelId: number | null;
  /** 机型名称（按关联 ID 实时取字典名，用于当前值展示） */
  equipmentModelName: string | null;
  /** 案例资料正文保护提示（FAULT_CASE 正文须走案例更正接口） */
  faultCaseProtected: boolean;
};

@Injectable()
export class GetReferenceDocumentEditableContentUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly accountQueryService: AccountQueryService,
  ) {}

  async execute(
    command: ReferenceDocumentEditableContentCommand,
  ): Promise<ReferenceDocumentEditableContentView> {
    await assertReferenceDocumentFirstLevelAdmin({
      session: command.session,
      accountQueryService: this.accountQueryService,
    });
    assertDocumentIdValid(command.documentId);

    const current = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      scope: { kind: 'GLOBAL' },
    });

    const readers = {
      referenceDocumentQueryService: this.referenceDocumentQueryService,
      maintenanceReportQueryService: this.maintenanceReportQueryService,
    };
    const structured = await resolveEffectiveStructuredContent(current, readers);
    const contentText = await resolveEffectiveContentText(current, readers);

    return {
      documentId: current.id,
      title: current.title,
      description: current.description,
      documentType: current.documentType,
      expectedVersion: current.effectiveRevisionNo,
      sourceKind: current.sourceKind,
      mode: structured !== null ? 'STRUCTURED' : 'FLAT',
      structured,
      contentText,
      equipmentModelId: current.equipmentModelId,
      equipmentModelName: current.equipmentModelName,
      faultCaseProtected: isFaultCaseDocumentType(current.documentType),
    };
  }
}
