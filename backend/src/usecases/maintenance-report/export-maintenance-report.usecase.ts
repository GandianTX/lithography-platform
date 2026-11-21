// src/usecases/maintenance-report/export-maintenance-report.usecase.ts
//
// R051 预览/导出：不写库、不登记机型、不改版本与附件引用。
//
// 两个导出目标：
// - CURRENT_FORM：工程师本人完整的当前表单（含未保存草稿）。服务端按正式提交
//   同一套归一化、完整性与工单前置校验内容事实，但只读：不创建报告、不写附件、
//   不注册机型；工单总结来源复核本人接单且已结单；管理员不可使用（R047/R048）；
// - SAVED_VERSION：当前用户有权读取的已保存报告冻结版本。归属（作者 + 公司）
//   由 usecase 裁决后再以 ReadScope 谓词二次约束；冻结快照按 schemaVersion
//   严格解析作为内容完整性校验；版本附件逐个复核存在/归属/完整性。
//
// 权限（R047/R048、页面 V6.5 §8.5）：
// - CURRENT_FORM：仅工程师本人（activeRole 精确为 ENGINEER）；
// - SAVED_VERSION：报告作者本人可导出本人版本；管理员（roles 含 SUPER_ADMIN 且
//   activeRole 精确为 SUPER_ADMIN，经 resolveAdminScope）可导出正式版本——
//   1 级全部公司、2 级本公司；DRAFT/RETURNED 等工作态草稿一律不读，
//   越权统一 NOT_FOUND，不泄露存在性；管理员不得借导出创建工程师报告。
// 附件：无附件正常导出；已选择但缺失、无权或完整性不符的附件失败关闭
// （ATTACHMENT_UNAVAILABLE），不伪称导出成功。
//
// AI 评价附录如实呈现：未使用 AI 显示「不适用」；真实来源未接通时保存链路
// 本就失败关闭，导出不伪造评价内容。

import { Inject, Injectable } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  MaintenanceReportExportFormat,
  MaintenanceReportSourceType,
  MaintenanceReportStatus,
  MAINTENANCE_REPORT_SNAPSHOT_SCHEMA_VERSION,
} from '@app-types/models/maintenance-report.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { resolveAdminScope, type AdminScope } from '@core/account/policy/admin-scope.policy';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type {
  MaintenanceReportAttachmentSnapshot,
  MaintenanceReportSnapshot,
} from '@src/modules/lithography/maintenance-report.types';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { RepairRequestMaintenanceQueryService } from '@src/modules/lithography/queries/repair-request-maintenance.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@src/usecases/common/ports/stored-file-storage.contract';
import { assertAttachmentsUsableAfterBinding } from './maintenance-report-attachment-freeze.helpers';
import type {
  ExportMaintenanceReportCommand,
  MaintenanceReportExportResult,
} from './maintenance-report-command.types';
import {
  assertFormalSubmitCompleteness,
  normalizeFormalRepairRequestId,
} from './maintenance-report-formal-submit.helpers';
import {
  normalizeMaintenanceReportDraft,
  normalizeSourceType,
  trimOptionalText,
} from './maintenance-report.input.normalize';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';
import { assertWorkOrderSummaryPreconditions } from './maintenance-report-work-order.constants';
import {
  assertNoWorkOrderSummaryClientContent,
  buildWorkOrderSummaryDraftInput,
  readWorkOrderSummarySourceFacts,
} from './maintenance-report-work-order-source.helpers';
import {
  MAINTENANCE_REPORT_EXPORT_RENDERER,
  type MaintenanceReportExportAttachmentLine,
  type MaintenanceReportExportDocument,
  type MaintenanceReportExportFaultLine,
  type MaintenanceReportExportRenderer,
} from './ports/maintenance-report-export-renderer.contract';

/** 负责人姓名快照缺失时的安全回落（与正式提交用例口径一致） */
const ENGINEER_NAME_FALLBACK = '工程师';

const EXPORT_FORMATS: readonly string[] = Object.values(MaintenanceReportExportFormat);

/** 文案映射与前端 i18n 同口径，避免导出文档与页面展示漂移 */
const HANDLING_RESULT_LABELS: Record<string, string> = {
  FIXED: '故障修复',
  PART_PURCHASED: '购买新部件',
  PROVIDE_PLAN_SELF_EXECUTE: '提供维修方案由厂方自行执行',
  INTERRUPTED: '因厂方或其他原因中断维修',
  UNREPAIRABLE: '无法修复',
};

const RESET_RESULT_LABELS: Record<string, string> = {
  NORMAL: '复位后正常',
  SAME_FAULT: '复位后与报修故障一致',
  NEW_FAULT: '复位后出现新故障',
};

const CORRECTNESS_LABELS: Record<string, string> = {
  CORRECT: '正确',
  PARTIAL: '部分正确',
  INCORRECT: '不正确',
};

@Injectable()
export class ExportMaintenanceReportUsecase {
  constructor(
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly maintenanceQueryService: RepairRequestMaintenanceQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    @Inject(STORED_FILE_STORAGE)
    private readonly storedFileStorage: StoredFileStorage,
    @Inject(MAINTENANCE_REPORT_EXPORT_RENDERER)
    private readonly renderer: MaintenanceReportExportRenderer,
  ) {}

  async execute(command: ExportMaintenanceReportCommand): Promise<MaintenanceReportExportResult> {
    const format = normalizeExportFormat(command.format);
    if (command.currentForm !== null && command.currentForm !== undefined) {
      if (command.savedVersion !== null && command.savedVersion !== undefined) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
          '导出目标必须且只能为当前表单或已保存版本之一',
        );
      }
      return this.exportCurrentForm(command.currentForm, command.session, format);
    }
    if (command.savedVersion !== null && command.savedVersion !== undefined) {
      return this.exportSavedVersion(command.savedVersion, command.session, format);
    }
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
      '导出目标必须且只能为当前表单或已保存版本之一',
    );
  }

  /**
   * 当前表单导出：只读。归一化与完整性按正式提交同一套规则，
   * 失效分支在归一化时被剔除，不会进入导出内容。
   */
  private async exportCurrentForm(
    target: NonNullable<ExportMaintenanceReportCommand['currentForm']>,
    session: UsecaseSession,
    format: MaintenanceReportExportFormat,
  ): Promise<MaintenanceReportExportResult> {
    // R047/R048：CURRENT_FORM 仅工程师本人导出本人正在填写的内容，管理员不适用
    assertMaintenanceReportAuthorRole(session);
    const sourceType = normalizeSourceType(target.sourceType);
    const repairRequestId = normalizeFormalRepairRequestId(sourceType, target.repairRequestId);
    const organizationId = await this.resolveOrganizationId(session.accountId);
    // 2026-11-20 需求调整：工单总结只读核对——导出内容同样由服务端以核验后的
    // 工单事实派生，客户端内容字段一律拒绝（与保存/提交同口径）
    const isWorkOrderSummary = sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY;
    if (isWorkOrderSummary) {
      assertNoWorkOrderSummaryClientContent(target.draft);
    }
    let workOrderContext = null;
    if (repairRequestId !== null) {
      workOrderContext =
        await this.maintenanceReportService.findRepairRequestWriteContext(repairRequestId);
      assertWorkOrderSummaryPreconditions({
        request: workOrderContext,
        repairRequestId,
        accountId: session.accountId,
        organizationId,
      });
    }
    let draft;
    let sourceOriginal: { filename: string; byteSize: number } | null = null;
    if (isWorkOrderSummary) {
      const facts = await readWorkOrderSummarySourceFacts({
        request: workOrderContext as NonNullable<typeof workOrderContext>,
        maintenanceQueryService: this.maintenanceQueryService,
        organizationQueryService: this.organizationQueryService,
      });
      draft = normalizeMaintenanceReportDraft(
        buildWorkOrderSummaryDraftInput(facts),
        session.accountId,
        {
          // 工单总结派生复用结单侧（任务 04）结单原因规则：非终结结果原因可选
          allowNonTerminalClosureReason: true,
        },
      );
      assertFormalSubmitCompleteness(draft);
      sourceOriginal =
        facts.attachment === null
          ? null
          : { filename: facts.attachment.originalFilename, byteSize: facts.attachment.byteSize };
    } else {
      draft = normalizeMaintenanceReportDraft(target.draft, session.accountId);
      assertFormalSubmitCompleteness(draft);
    }
    const nicknames = await this.accountQueryService.findNicknamesByAccountIds([session.accountId]);
    // 2026-11-21 修复：机型标签按机型库 ID 解析名称，与正式资料正文同一语义
    const equipmentModelLabel = await this.resolveExportEquipmentModelLabel({
      equipmentModelId: draft.equipmentModelId,
      equipmentModelText: draft.equipmentModelText,
    });

    const document = buildExportDocument({
      title: draft.title,
      sourceType,
      customerFactoryName: draft.customerFactoryName,
      equipmentModelId: draft.equipmentModelId,
      equipmentModelText: draft.equipmentModelText,
      equipmentModelLabel,
      maintenanceDate: draft.maintenanceDate,
      engineerName: nicknames.get(session.accountId) ?? ENGINEER_NAME_FALLBACK,
      handlingResult: draft.handlingResult,
      closureReason: draft.closureReason,
      resetResult: draft.resetResult,
      actualCause: draft.actualCause,
      repairActions: draft.repairActions,
      verificationResult: draft.verificationResult,
      supplementaryNote: draft.supplementaryNote,
      alarms: draft.alarms,
      steps: draft.steps,
      faults: draft.faults,
      ai: {
        usage: draft.aiUsage,
        sourceType: draft.aiSourceType,
        sourceId: draft.aiSourceId,
        sourceVersion: draft.aiSourceVersion,
        score: draft.aiScore,
        correctness: draft.aiCorrectness,
        helpfulness: draft.aiHelpfulness,
        note: draft.aiNote,
      },
      attachments: [],
      sourceWorkOrderOriginal: sourceOriginal,
    });
    return this.renderToResult(document, format);
  }

  /**
   * 已保存版本导出：归属裁决 + ReadScope 二次约束 + 冻结快照完整性解析。
   *
   * 工程师：仅本人版本（同组织）；管理员：经 resolveAdminScope 的正式版本，
   * 1 级全部公司、2 级本公司；DRAFT/RETURNED 工作态草稿一律不可读（统一
   * NOT_FOUND，不泄露存在性）。
   */
  private async exportSavedVersion(
    target: NonNullable<ExportMaintenanceReportCommand['savedVersion']>,
    session: UsecaseSession,
    format: MaintenanceReportExportFormat,
  ): Promise<MaintenanceReportExportResult> {
    assertMaintenanceReportId(target.reportId);
    const adminScope = resolveAdminScopeIfSuperAdmin(session);
    if (adminScope === null) {
      assertMaintenanceReportAuthorRole(session);
    }
    const organizationId =
      adminScope === null ? await this.resolveOrganizationId(session.accountId) : null;
    const ownership = await this.maintenanceReportQueryService.readReportOwnership(target.reportId);
    if (ownership === null) {
      throw notFound(target.reportId);
    }
    if (adminScope !== null) {
      // 管理员：2 级仅本公司；1 级全部公司。工作态草稿一律不读。
      if (adminScope.level === 2 && adminScope.organizationId !== ownership.ownerOrganizationId) {
        throw notFound(target.reportId);
      }
      const adminReport = await this.maintenanceReportQueryService.readReport(
        target.reportId,
        undefined,
        adminScope.level === 2 ? { ownerOrganizationId: adminScope.organizationId } : undefined,
      );
      if (
        adminReport === null ||
        adminReport.status === MaintenanceReportStatus.DRAFT ||
        adminReport.status === MaintenanceReportStatus.RETURNED
      ) {
        throw notFound(target.reportId);
      }
      return this.exportResolvedVersion(adminReport, target, format, true);
    }
    if (
      ownership.maintenanceEngineerAccountId !== session.accountId ||
      ownership.ownerOrganizationId !== organizationId
    ) {
      throw notFound(target.reportId);
    }
    // 归属裁决通过后仍以查询谓词二次约束，避免只依赖第一次检查
    const report = await this.maintenanceReportQueryService.readReport(target.reportId, undefined, {
      ownerOrganizationId: organizationId,
      maintenanceEngineerAccountId: session.accountId,
    });
    if (report === null) {
      throw notFound(target.reportId);
    }
    return this.exportResolvedVersion(report, target, format, false);
  }

  /** 版本定位 + 快照严格解析 + 附件复核（归属裁决完成后共用） */
  private async exportResolvedVersion(
    report: MaintenanceReportSnapshot,
    target: NonNullable<ExportMaintenanceReportCommand['savedVersion']>,
    format: MaintenanceReportExportFormat,
    /** 管理员导出：省略来源工单原件引用，不把工单原件信息带进无权上下文 */
    isAdminExport: boolean,
  ): Promise<MaintenanceReportExportResult> {
    const reportId = report.id;
    const versionNo =
      target.versionNo === null || target.versionNo === undefined
        ? report.currentVersionNo
        : target.versionNo;
    if (!Number.isInteger(versionNo) || versionNo < 1) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '导出版本号无效', {
        reportId,
        versionNo,
      });
    }
    const version = await this.maintenanceReportQueryService.readVersion(reportId, versionNo);
    if (version === null) {
      throw notFound(reportId);
    }

    const payload = readVersionSnapshotPayload(version.payloadSnapshot, reportId, version.id);
    const attachmentLines = await this.readVersionAttachmentLines(
      version.id,
      reportId,
      report.maintenanceEngineerAccountId,
    );
    // 机型冻结语义（2026-11-21 修复）：优先使用提交事务内冻结的机型显示名
    // （equipmentModelName），机型库改名不影响旧版本导出内容；仅旧快照缺键
    // （历史数据）时按 ID 回落解析机型库——无法还原提交当时的名称，如实回退。
    const frozenEquipmentModelName =
      payload.equipmentModelName !== null && payload.equipmentModelName.trim().length > 0
        ? payload.equipmentModelName
        : null;
    const equipmentModelLabel =
      frozenEquipmentModelName ??
      (await this.resolveExportEquipmentModelLabel({
        equipmentModelId: payload.equipmentModelId,
        equipmentModelText: payload.equipmentModelText,
      }));

    const document = buildExportDocument({
      title: payload.title,
      sourceType: payload.sourceType,
      customerFactoryName: payload.customerFactoryName,
      equipmentModelId: payload.equipmentModelId,
      equipmentModelText: payload.equipmentModelText,
      equipmentModelLabel,
      maintenanceDate: payload.maintenanceDate,
      engineerName: payload.maintenanceEngineerName,
      handlingResult: payload.handlingResult,
      closureReason: payload.closureReason,
      resetResult: payload.resetResult,
      actualCause: payload.actualCause,
      repairActions: payload.repairActions,
      verificationResult: payload.verificationResult,
      supplementaryNote: payload.supplementaryNote,
      alarms: payload.alarms,
      steps: payload.steps,
      faults: payload.faults,
      ai: payload.ai,
      attachments: attachmentLines,
      sourceWorkOrderOriginal:
        isAdminExport ||
        payload.sourceWorkOrderAttachment === null ||
        payload.sourceWorkOrderAttachment === undefined
          ? null
          : {
              filename: payload.sourceWorkOrderAttachment.originalFilename,
              byteSize: payload.sourceWorkOrderAttachment.byteSize,
            },
    });
    return this.renderToResult(document, format);
  }

  /**
   * 冻结版本附件装配：清单外或行缺失属数据不定式破坏；每个附件先复核
   * 存在/归属/完整性，再按 MIME 嵌入可展示图片（PNG/JPEG/GIF/BMP）。
   */
  private async readVersionAttachmentLines(
    versionId: number,
    reportId: number,
    authorAccountId: number,
  ): Promise<MaintenanceReportExportAttachmentLine[]> {
    const versionAttachments = await this.maintenanceReportQueryService.readVersionAttachments(
      versionId,
      reportId,
    );
    if (versionAttachments.length === 0) return [];
    const rows = await this.maintenanceReportQueryService.readAttachmentsByIds(
      reportId,
      versionAttachments.map((item) => item.attachmentId),
    );
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const lines: MaintenanceReportExportAttachmentLine[] = [];
    for (const versionAttachment of versionAttachments) {
      const row: MaintenanceReportAttachmentSnapshot | undefined = rowById.get(
        versionAttachment.attachmentId,
      );
      if (row === undefined) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
          '冻结版本附件清单中存在缺失的附件行',
          { reportId, versionId, attachmentId: versionAttachment.attachmentId },
        );
      }
      await assertAttachmentsUsableAfterBinding({
        attachments: [row],
        authorAccountId,
        storage: this.storedFileStorage,
      });
      lines.push({
        filename: row.originalFilename,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
        description: versionAttachment.descriptionSnapshot ?? row.description,
        embeddableImage: isEmbeddableImage(row.mimeType)
          ? await this.readAttachmentImage(row.storageReference)
          : null,
      });
    }
    return lines;
  }

  private async readAttachmentImage(storageReference: string): Promise<Buffer> {
    try {
      const stream = await this.storedFileStorage.open(storageReference);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.ATTACHMENT_UNAVAILABLE,
        '附件文件已不可读，无法完成导出',
        undefined,
        error,
      );
    }
  }

  private async renderToResult(
    document: MaintenanceReportExportDocument,
    format: MaintenanceReportExportFormat,
  ): Promise<MaintenanceReportExportResult> {
    const rendered = await this.renderer.render(document, format);
    return {
      format,
      fileName: buildExportFileName(document.title, rendered.fileExtension),
      mimeType: rendered.mimeType,
      byteSize: rendered.content.length,
      contentBase64: rendered.content.toString('base64'),
    };
  }

  /**
   * 导出机型展示名解析（2026-11-21 修复）：ID 优先机型库按名称取值（名称缺失
   * 回落编码）；机型库记录缺失返回 null（由文档组装回落 ID 占位/手填文本），
   * 不伪称机型名，也不阻断导出。
   */
  private async resolveExportEquipmentModelLabel(params: {
    equipmentModelId: number | null;
    equipmentModelText: string | null;
  }): Promise<string | null> {
    if (params.equipmentModelId === null) {
      return params.equipmentModelText;
    }
    const model = await this.equipmentModelQueryService.findModelById({
      id: params.equipmentModelId,
    });
    if (model === null) {
      return null;
    }
    return model.modelName || model.modelCode || null;
  }

  private async resolveOrganizationId(accountId: number): Promise<number> {
    const membership = await this.organizationContextService.resolveForAccount({ accountId });
    return membership.organizationId;
  }
}

// —— 冻结快照严格解析（内容完整性校验） ————————————————————————————

type SnapshotAlarmPayload = {
  alarmIndex: number;
  alarmCode: string;
  alarmDescription: string | null;
  phaseCode: string;
  resetResult: string;
};

type SnapshotStepPayload = {
  stepNo: number;
  /** 步骤稳定编码（旧快照可能缺键 → null） */
  stepCode: string | null;
  phaseCode: string;
  partName: string | null;
  actionText: string;
  resultText: string | null;
  /** 2026-11-21 加法式补键；旧快照缺键按 null 兼容 */
  errorCode: string | null;
};

type SnapshotFaultPayload = {
  branchKind: string;
  /** 步骤新故障引用的步骤稳定编码（旧快照缺键 → null） */
  stepCode: string | null;
  phaseCode: string | null;
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  faultStatus: string | null;
  description: string;
  action: string | null;
};

type SnapshotAiPayload = {
  usage: string;
  sourceType: string | null;
  sourceId: string | null;
  sourceVersion: string | null;
  score: number | null;
  correctness: string | null;
  helpfulness: number | null;
  note: string | null;
};

type ParsedVersionSnapshotPayload = {
  sourceType: MaintenanceReportSourceType;
  title: string | null;
  customerFactoryName: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  /**
   * 机型冻结语义（加法式扩展键）：提交事务内冻结的机型显示名；
   * 旧快照缺键为 null，导出时按 ID 回落解析机型库（如实回退）。
   */
  equipmentModelName: string | null;
  maintenanceDate: string | null;
  maintenanceEngineerName: string;
  handlingResult: string | null;
  closureReason: string | null;
  resetResult: string | null;
  actualCause: string | null;
  repairActions: string | null;
  verificationResult: string | null;
  supplementaryNote: string | null;
  alarms: SnapshotAlarmPayload[];
  steps: SnapshotStepPayload[];
  faults: SnapshotFaultPayload[];
  ai: SnapshotAiPayload;
  /** 加法式扩展键：工单总结冻结时的来源工单引用；旧快照缺键为 null */
  sourceWorkOrderAttachment: {
    fileId: string;
    originalFilename: string;
    byteSize: number;
  } | null;
};

function inconsistent(
  reportId: number,
  versionId: number,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new DomainError(MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT, message, {
    reportId,
    versionId,
    ...details,
  });
}

function readOptionalString(
  value: unknown,
  reportId: number,
  versionId: number,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    inconsistent(reportId, versionId, '冻结快照字段类型异常', { field });
  }
  return value;
}

function readRequiredString(
  item: Record<string, unknown>,
  field: string,
  reportId: number,
  versionId: number,
): string {
  const value = readOptionalString(item[field], reportId, versionId, field);
  if (value === null) {
    inconsistent(reportId, versionId, '冻结快照必填字段缺失', { field });
  }
  return value;
}

function readOptionalNumber(
  value: unknown,
  reportId: number,
  versionId: number,
  field: string,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    inconsistent(reportId, versionId, '冻结快照字段类型异常', { field });
  }
  return value;
}

function readObjectArrayField(
  payload: Record<string, unknown>,
  field: string,
  reportId: number,
  versionId: number,
): Record<string, unknown>[] | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    inconsistent(reportId, versionId, '冻结快照集合字段类型异常', { field });
  }
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      inconsistent(reportId, versionId, '冻结快照集合条目类型异常', { field });
    }
    return item as Record<string, unknown>;
  });
}

/**
 * 冻结快照严格解析：schemaVersion 必须是当前版本；结构异常失败关闭
 * （DATA_INCONSISTENT），不降级渲染半份内容。
 * `faults` 兼容任务 04 既有快照（缺键按空集合处理，加法式扩展）。
 */
export function readVersionSnapshotPayload(
  payloadSnapshot: Record<string, unknown>,
  reportId: number,
  versionId: number,
): ParsedVersionSnapshotPayload {
  const schemaVersion = payloadSnapshot['schemaVersion'];
  if (schemaVersion !== MAINTENANCE_REPORT_SNAPSHOT_SCHEMA_VERSION) {
    inconsistent(reportId, versionId, '冻结快照 schema 版本不受支持', { schemaVersion });
  }
  const sourceType = readRequiredString(payloadSnapshot, 'sourceType', reportId, versionId);
  if (sourceType !== 'HISTORICAL_CASE' && sourceType !== 'WORK_ORDER_SUMMARY') {
    inconsistent(reportId, versionId, '冻结快照来源类型异常', { sourceType });
  }
  const aiValue = payloadSnapshot['ai'];
  if (
    aiValue === null ||
    aiValue === undefined ||
    typeof aiValue !== 'object' ||
    Array.isArray(aiValue)
  ) {
    inconsistent(reportId, versionId, '冻结快照 AI 评价块缺失', { field: 'ai' });
  }
  const aiRaw = aiValue as Record<string, unknown>;

  const alarms = (readObjectArrayField(payloadSnapshot, 'alarms', reportId, versionId) ?? []).map(
    (item) => {
      const alarmIndex = readOptionalNumber(
        item['alarmIndex'],
        reportId,
        versionId,
        'alarms.alarmIndex',
      );
      if (alarmIndex === null) {
        inconsistent(reportId, versionId, '冻结快照报警序号缺失', { field: 'alarms.alarmIndex' });
      }
      return {
        alarmIndex,
        alarmCode: readRequiredString(item, 'alarmCode', reportId, versionId),
        alarmDescription: readOptionalString(
          item['alarmDescription'],
          reportId,
          versionId,
          'alarms.alarmDescription',
        ),
        phaseCode: readRequiredString(item, 'phaseCode', reportId, versionId),
        resetResult: readRequiredString(item, 'resetResult', reportId, versionId),
      };
    },
  );
  const steps = (readObjectArrayField(payloadSnapshot, 'steps', reportId, versionId) ?? []).map(
    (item) => {
      const stepNo = readOptionalNumber(item['stepNo'], reportId, versionId, 'steps.stepNo');
      if (stepNo === null) {
        inconsistent(reportId, versionId, '冻结快照步骤序号缺失', { field: 'steps.stepNo' });
      }
      return {
        stepNo,
        // 加法式补键：旧快照（含任务 04 既有版本）缺 stepCode/errorCode → null，不视为损坏
        stepCode: readOptionalString(item['stepCode'], reportId, versionId, 'steps.stepCode'),
        phaseCode: readRequiredString(item, 'phaseCode', reportId, versionId),
        partName: readOptionalString(item['partName'], reportId, versionId, 'steps.partName'),
        actionText: readRequiredString(item, 'actionText', reportId, versionId),
        resultText: readOptionalString(item['resultText'], reportId, versionId, 'steps.resultText'),
        errorCode: readOptionalString(item['errorCode'], reportId, versionId, 'steps.errorCode'),
      };
    },
  );
  const faults = (readObjectArrayField(payloadSnapshot, 'faults', reportId, versionId) ?? []).map(
    (item) => ({
      branchKind: readRequiredString(item, 'branchKind', reportId, versionId),
      stepCode: readOptionalString(item['stepCode'], reportId, versionId, 'faults.stepCode'),
      phaseCode: readOptionalString(item['phaseCode'], reportId, versionId, 'faults.phaseCode'),
      mainError: readOptionalString(item['mainError'], reportId, versionId, 'faults.mainError'),
      unitError: readOptionalString(item['unitError'], reportId, versionId, 'faults.unitError'),
      source: readOptionalString(item['source'], reportId, versionId, 'faults.source'),
      errorType: readOptionalString(item['errorType'], reportId, versionId, 'faults.errorType'),
      gpibStatus: readOptionalString(item['gpibStatus'], reportId, versionId, 'faults.gpibStatus'),
      faultStatus: readOptionalString(
        item['faultStatus'],
        reportId,
        versionId,
        'faults.faultStatus',
      ),
      description: readRequiredString(item, 'description', reportId, versionId),
      action: readOptionalString(item['action'], reportId, versionId, 'faults.action'),
    }),
  );

  return {
    sourceType: sourceType as MaintenanceReportSourceType,
    title: readOptionalString(payloadSnapshot['title'], reportId, versionId, 'title'),
    customerFactoryName: readOptionalString(
      payloadSnapshot['customerFactoryName'],
      reportId,
      versionId,
      'customerFactoryName',
    ),
    equipmentModelId: readOptionalNumber(
      payloadSnapshot['equipmentModelId'],
      reportId,
      versionId,
      'equipmentModelId',
    ),
    equipmentModelText: readOptionalString(
      payloadSnapshot['equipmentModelText'],
      reportId,
      versionId,
      'equipmentModelText',
    ),
    // 加法式扩展键：旧快照缺键为 null（任务 04 快照与历史案例快照）
    equipmentModelName: readOptionalString(
      payloadSnapshot['equipmentModelName'],
      reportId,
      versionId,
      'equipmentModelName',
    ),
    maintenanceDate: readOptionalString(
      payloadSnapshot['maintenanceDate'],
      reportId,
      versionId,
      'maintenanceDate',
    ),
    maintenanceEngineerName: readRequiredString(
      payloadSnapshot,
      'maintenanceEngineerName',
      reportId,
      versionId,
    ),
    handlingResult: readOptionalString(
      payloadSnapshot['handlingResult'],
      reportId,
      versionId,
      'handlingResult',
    ),
    closureReason: readOptionalString(
      payloadSnapshot['closureReason'],
      reportId,
      versionId,
      'closureReason',
    ),
    resetResult: readOptionalString(
      payloadSnapshot['resetResult'],
      reportId,
      versionId,
      'resetResult',
    ),
    actualCause: readOptionalString(
      payloadSnapshot['actualCause'],
      reportId,
      versionId,
      'actualCause',
    ),
    repairActions: readOptionalString(
      payloadSnapshot['repairActions'],
      reportId,
      versionId,
      'repairActions',
    ),
    verificationResult: readOptionalString(
      payloadSnapshot['verificationResult'],
      reportId,
      versionId,
      'verificationResult',
    ),
    supplementaryNote: readOptionalString(
      payloadSnapshot['supplementaryNote'],
      reportId,
      versionId,
      'supplementaryNote',
    ),
    alarms,
    steps,
    faults,
    ai: {
      usage: readRequiredString(aiRaw, 'usage', reportId, versionId),
      sourceType: readOptionalString(aiRaw['sourceType'], reportId, versionId, 'ai.sourceType'),
      sourceId: readOptionalString(aiRaw['sourceId'], reportId, versionId, 'ai.sourceId'),
      sourceVersion: readOptionalString(
        aiRaw['sourceVersion'],
        reportId,
        versionId,
        'ai.sourceVersion',
      ),
      score: readOptionalNumber(aiRaw['score'], reportId, versionId, 'ai.score'),
      correctness: readOptionalString(aiRaw['correctness'], reportId, versionId, 'ai.correctness'),
      helpfulness: readOptionalNumber(aiRaw['helpfulness'], reportId, versionId, 'ai.helpfulness'),
      note: readOptionalString(aiRaw['note'], reportId, versionId, 'ai.note'),
    },
    // 加法式扩展键：缺键视为无来源引用（任务 04 快照与历史案例快照）
    sourceWorkOrderAttachment: readSourceWorkOrderAttachment(
      payloadSnapshot['sourceWorkOrderAttachment'],
      reportId,
      versionId,
    ),
  };
}

function readSourceWorkOrderAttachment(
  value: unknown,
  reportId: number,
  versionId: number,
): { fileId: string; originalFilename: string; byteSize: number } | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    inconsistent(reportId, versionId, '冻结快照来源附件引用类型异常', {
      field: 'sourceWorkOrderAttachment',
    });
  }
  const raw = value as Record<string, unknown>;
  const fileId = readOptionalString(
    raw['fileId'],
    reportId,
    versionId,
    'sourceWorkOrderAttachment.fileId',
  );
  const filename = readOptionalString(
    raw['originalFilename'],
    reportId,
    versionId,
    'sourceWorkOrderAttachment.originalFilename',
  );
  const byteSize = readOptionalNumber(
    raw['byteSize'],
    reportId,
    versionId,
    'sourceWorkOrderAttachment.byteSize',
  );
  if (fileId === null || filename === null || byteSize === null) {
    inconsistent(reportId, versionId, '冻结快照来源附件引用字段缺失', {
      field: 'sourceWorkOrderAttachment',
    });
  }
  return { fileId, originalFilename: filename, byteSize };
}

// —— 文档模型组装（业务文案在此解析，渲染层只排版） ———————————————————

type ExportDocumentSource = {
  title: string | null;
  sourceType: MaintenanceReportSourceType;
  customerFactoryName: string | null;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  /** 机型展示名（2026-11-21 修复）：已按机型库解析；null 时回落 ID 占位/手填文本 */
  equipmentModelLabel: string | null;
  maintenanceDate: string | null;
  engineerName: string;
  handlingResult: string | null;
  closureReason: string | null;
  resetResult: string | null;
  actualCause: string | null;
  repairActions: string | null;
  verificationResult: string | null;
  supplementaryNote: string | null;
  alarms: SnapshotAlarmPayload[];
  steps: SnapshotStepPayload[];
  faults: SnapshotFaultPayload[];
  ai: SnapshotAiPayload;
  attachments: MaintenanceReportExportAttachmentLine[];
  sourceWorkOrderOriginal: {
    filename: string;
    byteSize: number;
  } | null;
};

function buildExportDocument(source: ExportDocumentSource): MaintenanceReportExportDocument {
  const equipmentModelLabel =
    source.equipmentModelLabel ??
    (source.equipmentModelId !== null
      ? `型号 #${source.equipmentModelId}`
      : (source.equipmentModelText ?? ''));
  // 故障 → 步骤关联：以步骤稳定编码作为键，旧快照缺编码时关联为 null
  const stepNoByCode = new Map<string, number>(
    source.steps
      .filter((step) => step.stepCode !== null)
      .map((step) => [step.stepCode as string, step.stepNo]),
  );
  return {
    title: trimOptionalText(source.title) || buildFallbackTitle(source),
    sourceLabel: resolveSourceLabel(source.sourceType),
    customerFactoryName: source.customerFactoryName ?? '',
    equipmentModelLabel,
    maintenanceDate: source.maintenanceDate ?? '',
    engineerName: source.engineerName,
    handlingResultLabel: resolveHandlingResultLabel(source.handlingResult),
    closureReason: source.closureReason,
    resetResultLabel:
      (source.resetResult !== null ? RESET_RESULT_LABELS[source.resetResult] : undefined) ?? null,
    alarms: source.alarms.map((alarm) => ({
      index: alarm.alarmIndex,
      code: alarm.alarmCode,
      description: alarm.alarmDescription,
      phaseCode: alarm.phaseCode,
      resetResult: alarm.resetResult,
    })),
    steps: source.steps.map((step) => ({
      no: step.stepNo,
      phaseCode: step.phaseCode,
      partName: step.partName,
      actionText: step.actionText,
      resultText: step.resultText,
      errorCode: step.errorCode,
    })),
    faults: source.faults.map((fault) => toExportFaultLine(fault, stepNoByCode)),
    actualCause: source.actualCause,
    repairActions: source.repairActions,
    verificationResult: source.verificationResult,
    supplementaryNote: source.supplementaryNote,
    ai: buildExportAiEvaluation(source.ai),
    attachments: source.attachments,
    sourceWorkOrderOriginal: source.sourceWorkOrderOriginal,
  };
}

function resolveSourceLabel(sourceType: MaintenanceReportSourceType): string {
  return sourceType === MaintenanceReportSourceType.HISTORICAL_CASE
    ? '独立历史维修记录'
    : '工单维修总结';
}

function resolveHandlingResultLabel(handlingResult: string | null): string {
  if (handlingResult === null) return '';
  return HANDLING_RESULT_LABELS[handlingResult] ?? handlingResult;
}

/** AI 评价附录：仅「已使用且有真实来源标识」呈现 EVALUATED，其余一律不适用 */
function buildExportAiEvaluation(ai: SnapshotAiPayload): MaintenanceReportExportDocument['ai'] {
  const evaluated = ai.usage === 'USED' && ai.sourceId !== null;
  return {
    status: evaluated ? 'EVALUATED' : 'NOT_USED',
    sourceType: ai.sourceType,
    sourceId: ai.sourceId,
    sourceVersion: ai.sourceVersion,
    score: ai.score,
    correctness:
      (ai.correctness !== null ? CORRECTNESS_LABELS[ai.correctness] : undefined) ?? ai.correctness,
    helpfulness: ai.helpfulness,
    note: ai.note,
  };
}

function toExportFaultLine(
  fault: SnapshotFaultPayload,
  stepNoByCode: ReadonlyMap<string, number>,
): MaintenanceReportExportFaultLine {
  return {
    branchLabel: resolveFaultBranchLabel(fault.branchKind),
    stepNo: fault.stepCode === null ? null : (stepNoByCode.get(fault.stepCode) ?? null),
    phaseCode: fault.phaseCode,
    mainError: fault.mainError,
    unitError: fault.unitError,
    source: fault.source,
    errorType: fault.errorType,
    gpibStatus: fault.gpibStatus,
    faultStatus: fault.faultStatus,
    description: fault.description,
    action: fault.action,
  };
}

function resolveFaultBranchLabel(branchKind: string): string {
  if (branchKind === 'INITIAL') return '初始故障';
  if (branchKind === 'RESET_NEW_FAULT') return '复位后新故障';
  if (branchKind === 'STEP_NEW_FAULT') return '排查步骤新故障';
  return branchKind;
}

function buildFallbackTitle(source: ExportDocumentSource): string {
  const factory = trimOptionalText(source.customerFactoryName) ?? '未知厂家';
  const date = trimOptionalText(source.maintenanceDate) ?? '未注明日期';
  const prefix = resolveSourceLabel(source.sourceType);
  return `${date} ${factory} ${prefix}`;
}

function notFound(reportId: number): DomainError {
  return new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
    reportId,
  });
}

/**
 * SUPER_ADMIN 精确身份 → 可信管理员作用域（等级缺失/非法或二级缺公司时失败关闭）。
 * 其余会话返回 null，由工程师作者口径裁决。
 */
function resolveAdminScopeIfSuperAdmin(session: UsecaseSession): AdminScope | null {
  const isSuperAdmin =
    session.roles.includes(IdentityTypeEnum.SUPER_ADMIN) &&
    session.activeRole === IdentityTypeEnum.SUPER_ADMIN;
  if (!isSuperAdmin) return null;
  return resolveAdminScope(session, '导出维修报告');
}

function normalizeExportFormat(value: string): MaintenanceReportExportFormat {
  if (!EXPORT_FORMATS.includes(value)) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
      '导出格式无效，仅支持 DOCX/PDF',
      {
        format: value,
      },
    );
  }
  return value as MaintenanceReportExportFormat;
}

function buildExportFileName(title: string, fileExtension: string): string {
  const safeTitle = title.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120);
  return `${safeTitle || '维修报告'}.${fileExtension}`;
}

function isEmbeddableImage(mimeType: string): boolean {
  return (
    mimeType === 'image/png' ||
    mimeType === 'image/jpeg' ||
    mimeType === 'image/gif' ||
    mimeType === 'image/bmp'
  );
}
