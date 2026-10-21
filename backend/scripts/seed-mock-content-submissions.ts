// scripts/seed-mock-content-submissions.ts
//
// 投稿状态 Mock 的声明式数据模块（G3/F04）。
//
// 存在意义：Seed 脚本本身在模块加载时即执行导入（`void seedMockData()`），
// 无法被测试安全导入；本模块只包含纯数据与无副作用构造器，
// 由 `seed-mock.ts` 与窄范围 Seed 契约测试共同消费，保证测试直接验证
// 「脚本实际声明的数据」，而不是另手造一份正确 fixture。
//
// F04 口径：冻结快照以真实 submit（`submit-content-submission.usecase`
// 的 buildMaterialSnapshot / buildFaultCaseSnapshot）生成的完整结构为标准——
// 普通资料恰好 6 个业务字段、故障案例恰好 11 个业务字段，显式包含可空字段，
// 不含 schemaVersion / submissionKind / attachment 等展示性字段；
// 当前稿明细、冻结快照、正式正文与正式案例明细全部由同一份构造器取值，
// 避免「明细有值但没有完整冻结」漂移。

import type { ContentSubmissionHandlingStatus } from '@src/modules/lithography/content-submission.types';
import {
  formatFaultCaseReferenceContent,
  type FaultCaseReferenceContentInput,
} from '@src/usecases/common/fault-case-fields.contract';

/**
 * 投稿状态 Mock 固定主键（R4 要求 5 / S1 缺项补齐）。
 *
 * 主表 984_001～984_004 覆盖两类投稿（MATERIAL / FAULT_CASE）× 四种状态
 * （DRAFT / RETURNED / PENDING_REVIEW / PUBLISHED）；985～990 子段分别承载
 * 明细、附件、冻结版本、审核记录与正式案例明细，与 970_006 正式资料构成
 * 「送审记录 → 告知确认 → 审核记录 → 发布来源」完整链路。
 * 全部归属 CLIENT_DEFAULT（投稿人 900_101/900_102，审核人 900_001）。
 */
export const CONTENT_SEED_IDS = {
  /** MATERIAL + DRAFT：仅明细，无版本/附件/审核 */
  draftSubmission: 984_001,
  /** MATERIAL + RETURNED：冻结版本 + 附件 + 退回审核 */
  returnedSubmission: 984_002,
  /** FAULT_CASE + PENDING_REVIEW：冻结版本 + 附件，无审核记录 */
  pendingSubmission: 984_003,
  /** FAULT_CASE + PUBLISHED：冻结版本 + 附件 + 通过审核 + 正式资料与案例明细 */
  publishedSubmission: 984_004,
  // 明细表（material_submission_detail / fault_case_submission_detail）为共享
  // 主键表：submission_id 即投稿外键，不设独立编号，插入时直接引用上述主键。
  attachmentReturned: 987_001,
  attachmentPending: 987_002,
  attachmentPublished: 987_003,
  revisionReturned: 988_001,
  revisionPending: 988_002,
  revisionPublished: 988_003,
  reviewReturned: 989_001,
  reviewApproved: 989_002,
  /** 正式资料：REVIEWED_SUBMISSION 来源回链 984_004/988_003 */
  publishedDocument: 970_006,
  /**
   * 正式案例明细（reference_document_case_detail）主键即正式资料外键：
   * document_id = publishedDocument（970_006），与投稿明细 986_002 字段一致。
   */
} as const;

/** 机型编码 → Seed 机型主键解析器（由脚本以数据库实际主键构造） */
export type SeedContentModelIdResolver = (modelCode: string) => number;

/**
 * 普通资料冻结快照（与真实 submit `buildMaterialSnapshot` 同构：
 * 恰好 6 个业务字段；title/documentType 为送审必填，其余可空显式列出）。
 */
export type MaterialFrozenSnapshot = {
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  description: string | null;
  contentText: string | null;
};

/**
 * 故障案例冻结快照（与真实 submit `buildFaultCaseSnapshot` 同构：
 * 恰好 11 个业务字段；title/phenomenon/reproductionSteps/handlingStatus
 * 为送审必填，其余可空显式列出，键顺序与真实 submit 一致）。
 */
export type FaultCaseFrozenSnapshot = {
  title: string;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  errorCode: string | null;
  phenomenon: string;
  conditionText: string | null;
  reproductionSteps: string;
  diagnosis: string | null;
  actionTaken: string | null;
  handlingStatus: ContentSubmissionHandlingStatus;
  resolution: string | null;
};

/** 普通资料退回稿冻结快照（MATERIAL + RETURNED；与当前稿明细 984_002 同源同值） */
export function buildReturnedMaterialSnapshot(): MaterialFrozenSnapshot {
  return {
    title: '安全操作补充说明（Mock 已退回）',
    documentType: 'SAFETY_STANDARD',
    equipmentModelId: null,
    equipmentModelText: null,
    description: '被审核退回的普通资料样本，用于验证退回后编辑重提链路。',
    contentText: '## 安全要求\n进入现场前完成停机确认与权限核验。',
  };
}

/** 待审故障案例冻结快照（FAULT_CASE + PENDING_REVIEW；与当前稿明细 984_003 同源同值） */
export function buildPendingFaultCaseSnapshot(
  resolveModelId: SeedContentModelIdResolver,
): FaultCaseFrozenSnapshot {
  return {
    title: 'NXT:1980Di 晶圆台吸附异常案例（Mock）',
    equipmentModelId: resolveModelId('ASML-TWINSCAN-NXT-1980DI'),
    equipmentModelText: null,
    errorCode: 'E-CHUCK-101',
    phenomenon: '晶圆台吸附压力波动，批次开始约 20 分钟后对准失败。',
    conditionText: '连续生产模式下真空压力周期性波动。',
    reproductionSteps: '1. 复现吸附压力波动；2. 记录真空回路读值趋势。',
    diagnosis: null,
    actionTaken: null,
    handlingStatus: 'UNRESOLVED',
    resolution: null,
  };
}

/**
 * 已发布故障案例冻结快照（FAULT_CASE + PUBLISHED；与当前稿明细 984_004、
 * 正式资料 970_006 及其案例明细同源同值）。
 */
export function buildPublishedFaultCaseSnapshot(
  resolveModelId: SeedContentModelIdResolver,
): FaultCaseFrozenSnapshot {
  return {
    title: 'NXE:3400C 光源能量漂移故障案例（Mock）',
    equipmentModelId: resolveModelId('ASML-TWINSCAN-NXE-3400C'),
    equipmentModelText: null,
    errorCode: 'E-LASER-307',
    phenomenon: '光源能量稳定性超限，曝光剂量重复性由 0.18% 上升至 0.42%。',
    conditionText: '连续曝光任务超过 30 分钟后出现能量漂移。',
    reproductionSteps: '1. 记录能量趋势；2. 核对传感器窗口污染；3. 复测三个批次。',
    diagnosis: '能量传感器窗口轻微污染导致读数漂移。',
    actionTaken: '清洁窗口并重新标定能量传感器。',
    handlingStatus: 'RESOLVED',
    resolution: '清洁标定后三个验证批次剂量重复性恢复至 0.16%。',
  };
}

/**
 * 已发布案例正式正文（Seed 落库的 content_text）：由同一份冻结字段、经发布
 * 链路同一格式化真源（`formatFaultCaseReferenceContent`）确定性生成——
 * 已发布正式资料完全可由冻结快照解释（G3/F04 对应关系）。
 */
export function buildPublishedCaseDocumentContent(
  resolveModelId: SeedContentModelIdResolver,
): string {
  const snapshot = buildPublishedFaultCaseSnapshot(resolveModelId);
  const contentInput: FaultCaseReferenceContentInput = snapshot;
  return formatFaultCaseReferenceContent(contentInput);
}
