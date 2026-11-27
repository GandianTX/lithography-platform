// src/usecases/reference-document/resolve-reference-document-effective-detail.ts

import { MaintenanceAttachmentStatus } from '@app-types/models/maintenance-report.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import type {
  ReferenceDocumentDetailQueryResult,
  ReferenceDocumentSourceAttachmentView,
} from '@src/modules/lithography/lithography.types';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import {
  composeFrozenReportText,
  parseFrozenReportVersion,
  readRevisionContentText,
  resolveContentSource,
} from '@src/modules/lithography/reference-document-effective-content';
import {
  readRevisionStructuredContent,
  type ReferenceDocumentStructuredContent,
} from './reference-document-structured-content';

/**
 * 生效正文装配结果：正文文本、来源决议与可空冻结报告视图（任务 07 读侧契约）。
 * structuredContent：生效管理修订携带结构化内容键时返回（任务 07 管理修订），
 * 供详情页结构化展示；冻结报告本身的结构化展示经 frozenReport.faults 呈现。
 */
export type ResolvedReferenceDocumentEffectiveContent = {
  contentText: string | null;
  contentSource: 'ORIGINAL' | 'FROZEN_REPORT' | 'CURRENT_REVISION';
  frozenReport: ReturnType<typeof parseFrozenReportVersion> | null;
  structuredContent: ReferenceDocumentStructuredContent | null;
  /** 来源报告冻结版本的原件附件（任务 07 P2；无冻结原件或引用失效为 null） */
  sourceReportAttachment: ReferenceDocumentSourceAttachmentView | null;
};

/**
 * 生效正文装配的最小输入：普通详情与归属待核实详情的富集结果均可满足
 * （富集结果已剥离 createdByAccountId / storageReference 内部字段）。
 */
export type ReferenceDocumentEffectiveContentInput = Pick<
  ReferenceDocumentDetailQueryResult,
  | 'id'
  | 'contentText'
  | 'sourceKind'
  | 'sourceReportId'
  | 'sourceReportVersionId'
  | 'effectiveRevisionNo'
>;

/**
 * 冻结快照整体结构性破坏裁决（任务 06 快照缺字段风险收口）。
 *
 * `parseFrozenReportVersion` 对个别键缺失按空值降级（兼容历史 schema 差异），
 * 但正式提交校验（maintenance-report-snapshot.ts 送审校验）保证冻结快照
 * 必有标题且至少 1 条排查步骤。若整体解析结果连标题、报警、步骤全为空，
 * 说明版本行存在但 payload 结构性破坏或任务 06 快照 schema 漂移：
 * 失败关闭（NOT_FOUND），不静默输出空正文，更不回退到实时工单拼装内容。
 */
const isStructurallyEmptyFrozenReport = (
  report: ReturnType<typeof parseFrozenReportVersion>,
): boolean => report.title === '' && report.alarms.length === 0 && report.steps.length === 0;

/**
 * 参考资料生效正文装配（任务 07 读侧公共编排）。
 *
 * 普通资料库详情（GetReferenceDocumentDetailUsecase）与归属待核实详情
 * （GetPendingOwnershipReferenceDocumentDetailUsecase，R061-01）共用同一口径，
 * 避免两套「生效正文回退」实现漂移：
 * - 生效正文：管理修订 > 原始冻结报告版本 > 资料自身正文；
 * - 授权追溯（V5.6 R055-02/R056-02/R058-01）：报告来源资料恒附带原始冻结报告
 *   视图（`frozenReport`），不随管理修订替换或消失——修订后生效正文仍为
 *   CURRENT_REVISION，原始冻结版本仅作为追溯视图并存；
 * - 报告来源无冻结版本行、生效修订号指向缺失行属数据定式破坏：
 *   失败关闭（统一 NOT_FOUND），不输出半截正文、不静默回退旧值。
 */
export async function resolveReferenceDocumentEffectiveContent(params: {
  referenceDocumentQueryService: Pick<ReferenceDocumentQueryService, 'findRevision'>;
  maintenanceReportQueryService: Pick<
    MaintenanceReportQueryService,
    'readVersionById' | 'readVersionAttachments' | 'readAttachmentsByIds'
  >;
  detail: ReferenceDocumentEffectiveContentInput;
}): Promise<ResolvedReferenceDocumentEffectiveContent> {
  const { detail } = params;

  const contentSource = resolveContentSource({
    effectiveRevisionNo: detail.effectiveRevisionNo,
    sourceKind: detail.sourceKind,
    sourceReportVersionId: detail.sourceReportVersionId,
  });

  let contentText = detail.contentText;
  let frozenReport: ResolvedReferenceDocumentEffectiveContent['frozenReport'] = null;
  let structuredContent: ResolvedReferenceDocumentEffectiveContent['structuredContent'] = null;
  let sourceReportAttachment: ResolvedReferenceDocumentEffectiveContent['sourceReportAttachment'] =
    null;

  if (contentSource === 'CURRENT_REVISION') {
    const revision = await params.referenceDocumentQueryService.findRevision(
      detail.id,
      detail.effectiveRevisionNo,
    );
    if (revision === null) {
      // 生效修订号指向缺失行属数据定式破坏：失败关闭，不让正文静默回退旧版
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        id: detail.id,
      });
    }
    const revisionText = readRevisionContentText(revision.afterSnapshot);
    contentText = revisionText ?? contentText;
    // 任务 07 管理修订：生效修订携带结构化内容键时随详情返回（宽松解析，
    // 旧扁平修订缺键返回 null，前端回落扁平正文展示）
    structuredContent = readRevisionStructuredContent(revision.afterSnapshot);
  }

  if (
    (contentSource === 'FROZEN_REPORT' || contentSource === 'CURRENT_REVISION') &&
    detail.sourceReportId !== null &&
    detail.sourceReportVersionId !== null
  ) {
    const version = await params.maintenanceReportQueryService.readVersionById(
      detail.sourceReportId,
      detail.sourceReportVersionId,
    );
    if (version === null) {
      // 冻结版本行缺失：与不可访问统一口径失败关闭，不返回残缺内容
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        id: detail.id,
      });
    }
    const parsed = parseFrozenReportVersion(version);
    if (isStructurallyEmptyFrozenReport(parsed)) {
      // 冻结快照整体为空：与版本行缺失同口径失败关闭，不输出空正文、不回退实时工单内容
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        id: detail.id,
      });
    }
    frozenReport = parsed;
    if (contentSource === 'FROZEN_REPORT') {
      contentText = composeFrozenReportText(frozenReport);
    }
    // 任务 07 P2：按冻结版本的附件绑定装配原件元数据（不回退当前报告附件列表），
    // 供详情页展示与 REST 授权下载；绑定失效或文件引用无效时如实为 null
    sourceReportAttachment = await resolveFrozenReportSourceAttachment(
      params.maintenanceReportQueryService,
      detail.sourceReportId,
      detail.sourceReportVersionId,
    );
  }

  return { contentText, contentSource, frozenReport, structuredContent, sourceReportAttachment };
}

/**
 * 来源报告冻结版本原件装配（任务 07 P2）。
 *
 * - 仅信任 `maintenance_report_version_attachment`（版本-附件绑定表）里
 *   属于该冻结版本（versionId + reportId 双键）的条目，绝不回退报告当前
 *   附件列表，也不接受单一文件 ID 直取；
 * - 附件行必须存在且 fileId 非空。RETIRED 不在此拒绝：报告被审核驳回
 *   （RETURNED）后作者更换/移除原件会把旧附件行合法退役，而该行的
 *   版本-附件复合外键绑定仍在——退役正是为了「冻结版本可回溯历史附件」
 *   （remove-maintenance-report-attachment.usecase 设计注释），历史读取权
 *   保留；文件失效（stored_file 非 VALID / 已清理）由下载链路如实拒绝；
 * - 多条绑定时优先 CURRENT，否则取第一条可绑定行（历史单附件上限 R062-01
 *   下每版本通常只绑定一份）。
 */
async function resolveFrozenReportSourceAttachment(
  maintenanceReportQueryService: Pick<
    MaintenanceReportQueryService,
    'readVersionAttachments' | 'readAttachmentsByIds'
  >,
  sourceReportId: number,
  sourceReportVersionId: number,
): Promise<ReferenceDocumentSourceAttachmentView | null> {
  const bindings = await maintenanceReportQueryService.readVersionAttachments(
    sourceReportVersionId,
    sourceReportId,
  );
  if (bindings.length === 0) {
    return null;
  }

  const snapshots = await maintenanceReportQueryService.readAttachmentsByIds(
    sourceReportId,
    bindings.map((binding) => binding.attachmentId),
  );
  const withFile = snapshots.filter((snapshot) => snapshot.fileId !== null);
  const usable =
    withFile.find((snapshot) => snapshot.status === MaintenanceAttachmentStatus.CURRENT) ??
    withFile[0];
  if (!usable || usable.fileId === null) {
    return null;
  }

  return {
    attachmentId: usable.id,
    fileId: usable.fileId,
    originalFilename: usable.originalFilename,
    mimeType: usable.mimeType,
    byteSize: usable.byteSize,
  };
}
