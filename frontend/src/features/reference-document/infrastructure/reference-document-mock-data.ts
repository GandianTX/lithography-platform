// src/features/reference-document/infrastructure/reference-document-mock-data.ts

import type {
  ReferenceDocumentCaseHandlingStatus,
  ReferenceDocumentDetail,
  ReferenceDocumentEquipmentModelOption,
} from './reference-document.types';

/**
 * 阶段二 Mock 数据集，形状与语义对齐 backend seed-mock（970001~970004）：
 * - 970001 指定型号 + 有文件名但无存储引用（错误代码手册；hasFile=false，不承诺可下载）；
 * - 970002 指定型号 + 有存储引用（维护指南）；
 * - 970003 通用资料 + 有文件名但无存储引用（安全规范；hasFile=false）；
 * - 970004 已软删除（默认列表不可见，详情统一不可访问）；
 * - 970005+ 覆盖纯文本资料（无存储引用）与长列表分页；
 * - 970031 投稿审核发布的 FAULT_CASE 案例（含案例明细与处理状态，供案例展示与更正）。
 *
 * 阶段三接真实后端后本文件与 mock adapter 一并下线；
 * 公共类型（reference-document.types.ts）保留为长期契约。
 */

/** Mock 型号选项（与后端 equipmentModels 种子语义一致；仅启用型号） */
export const MOCK_REFERENCE_EQUIPMENT_MODELS: ReferenceDocumentEquipmentModelOption[] = [
  { id: 47, modelCode: 'ASML-TWINSCAN-XT-1900I', modelName: 'ASML TWINSCAN XT:1900i' },
  { id: 48, modelCode: 'ASML-TWINSCAN-NXT-1950I', modelName: 'ASML TWINSCAN NXT:1950i' },
  { id: 49, modelCode: 'ASML-TWINSCAN-NXT-1980DI', modelName: 'ASML TWINSCAN NXT:1980Di' },
  { id: 51, modelCode: 'ASML-TWINSCAN-NXE-3400C', modelName: 'ASML TWINSCAN NXE:3400C' },
];

/** Mock 组织展示名（与后端 seed 的甲方默认组织同语义；阶段三由后端按组织事实富集） */
export const MOCK_REFERENCE_ORGANIZATION_NAME = '甲方默认组织';

/**
 * Mock 仓库条目 = 详情形状 + 列表独有案例状态 + 数据源内部软删标志（与后端 DTO 分层同构：
 * 详情不返回 caseHandlingStatus，仅列表返回；案例状态经 caseDetail.handlingStatus 表达）
 */
export type MockReferenceDocumentRecord = ReferenceDocumentDetail & {
  caseHandlingStatus: ReferenceDocumentCaseHandlingStatus | null;
  deprecated: boolean;
};

/** 显式种子条目（对齐 seed-mock 语义；含纯文本与已软删样本） */
const MOCK_REFERENCE_DOCUMENT_SEEDS: MockReferenceDocumentRecord[] = [
  {
    id: 970001,
    title: 'NXT:1980Di 常见错误代码手册（Mock）',
    documentType: 'ERROR_CODE_MANUAL',
    equipmentModelId: 49,
    equipmentModelName: 'ASML TWINSCAN NXT:1980Di',
    description: '按错误码段整理的现场排查手册，含复位步骤与升级条件。',
    originalFilename: 'nxt-1980di-error-codes-mock.txt',
    mimeType: 'text/plain',
    hasFile: false,
    contentText:
      '# NXT:1980Di 常见错误代码手册\n\n## E-STAGE-201\n干涉仪信号异常：检查测量束位置后复位。\n\n## E-LENS-102\n透镜温度漂移：等待热稳定后重试。',
    creatorNickname: '系统管理员',
    organizationName: MOCK_REFERENCE_ORGANIZATION_NAME,
    ingestMethod: 'ADMIN_DIRECT',
    equipmentModelText: null,
    caseHandlingStatus: null,
    caseDetail: null,
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-01T08:00:00.000Z',
    deprecated: false,
  },
  {
    id: 970002,
    title: 'NXE:3400C 光源维护指南（Mock）',
    documentType: 'MAINTENANCE_GUIDE',
    equipmentModelId: 51,
    equipmentModelName: 'ASML TWINSCAN NXE:3400C',
    description: '光源模块周期性维护要点与耗材更换记录模板。',
    originalFilename: 'nxe-3400c-source-guide-mock.pdf',
    mimeType: 'application/pdf',
    hasFile: true,
    contentText:
      '# NXE:3400C 光源维护指南\n\n## 周期检查\n每周记录光源能量衰减曲线。\n\n## 耗材更换\n达到触发阈值后按标准流程更换。',
    creatorNickname: '陈工',
    organizationName: MOCK_REFERENCE_ORGANIZATION_NAME,
    ingestMethod: 'ADMIN_DIRECT',
    equipmentModelText: null,
    caseHandlingStatus: null,
    caseDetail: null,
    createdAt: '2026-08-02T09:30:00.000Z',
    updatedAt: '2026-08-05T14:00:00.000Z',
    deprecated: false,
  },
  {
    id: 970003,
    title: '光刻机故障诊断安全规范（Mock）',
    documentType: 'SAFETY_STANDARD',
    equipmentModelId: null,
    equipmentModelName: null,
    description: '通用资料：进入设备区诊断故障前的断电与上锁挂牌要求。',
    originalFilename: 'safety-standard-mock.md',
    mimeType: 'text/markdown',
    hasFile: false,
    contentText:
      '# 故障诊断安全规范\n\n1. 断电并上锁挂牌；\n2. 确认残余气压释放；\n3. 双人作业制度。',
    creatorNickname: '系统管理员',
    organizationName: MOCK_REFERENCE_ORGANIZATION_NAME,
    ingestMethod: 'ADMIN_DIRECT',
    equipmentModelText: null,
    caseHandlingStatus: null,
    caseDetail: null,
    createdAt: '2026-08-03T10:00:00.000Z',
    updatedAt: '2026-08-03T10:00:00.000Z',
    deprecated: false,
  },
  {
    id: 970004,
    title: '旧版 XT 系列检查表（已停用 Mock）',
    documentType: 'CHECKLIST',
    equipmentModelId: 47,
    equipmentModelName: 'ASML TWINSCAN XT:1900i',
    description: '已被新版检查表替代，仅留档。',
    originalFilename: 'xt-checklist-old-mock.txt',
    mimeType: 'text/plain',
    hasFile: false,
    contentText: '# XT 系列开机检查表（旧版）\n\n- 确认气源压力；\n- 确认 stage 归零。',
    creatorNickname: '陈工',
    organizationName: MOCK_REFERENCE_ORGANIZATION_NAME,
    ingestMethod: 'ADMIN_DIRECT',
    equipmentModelText: null,
    caseHandlingStatus: null,
    caseDetail: null,
    createdAt: '2026-08-04T11:00:00.000Z',
    updatedAt: '2026-08-04T11:00:00.000Z',
    // 已软删除：正常列表不可见，详情视为不可访问
    deprecated: true,
  },
  {
    id: 970005,
    title: '浸没式光刻 Weekly 点位记录模板（Mock）',
    documentType: 'CHECKLIST',
    equipmentModelId: null,
    equipmentModelName: null,
    description: '纯文本资料：现场直接粘贴使用的每周点位记录模板。',
    originalFilename: null,
    mimeType: null,
    hasFile: false,
    contentText:
      '# Weekly 点位记录\n\n- [ ] 浸没液体流量\n- [ ] 排液阀状态\n- [ ] 腔体湿度\n- 备注：____',
    creatorNickname: '陈工',
    organizationName: MOCK_REFERENCE_ORGANIZATION_NAME,
    ingestMethod: 'ADMIN_DIRECT',
    equipmentModelText: null,
    caseHandlingStatus: null,
    caseDetail: null,
    createdAt: '2026-08-06T09:00:00.000Z',
    updatedAt: '2026-08-06T09:00:00.000Z',
    deprecated: false,
  },
  {
    id: 970006,
    title: 'NXT:1950i 对准报警处置笔记（Mock）',
    documentType: 'ERROR_CODE_MANUAL',
    equipmentModelId: 48,
    equipmentModelName: 'ASML TWINSCAN NXT:1950i',
    description: '纯文本资料：对准子系统的报警现场处置顺序笔记。',
    originalFilename: null,
    mimeType: null,
    hasFile: false,
    contentText:
      '# 对准报警处置笔记\n\n1. 先看报警码段；\n2. 记录 wafer 序号；\n3. 按手册 A-3 流程复位。',
    creatorNickname: '系统管理员',
    organizationName: MOCK_REFERENCE_ORGANIZATION_NAME,
    ingestMethod: 'ADMIN_DIRECT',
    equipmentModelText: null,
    caseHandlingStatus: null,
    caseDetail: null,
    createdAt: '2026-08-07T15:20:00.000Z',
    updatedAt: '2026-08-07T15:20:00.000Z',
    deprecated: false,
  },
  {
    id: 970031,
    title: 'NXT:1980Di 干涉仪报警处置案例（Mock 审核发布）',
    documentType: 'FAULT_CASE',
    equipmentModelId: 49,
    equipmentModelName: 'ASML TWINSCAN NXT:1980Di',
    equipmentModelText: null,
    description: '由工程师投稿经审核发布的正式案例（Mock），用于案例明细展示与处理状态筛选。',
    originalFilename: null,
    mimeType: null,
    hasFile: false,
    contentText:
      '错误码：E-STAGE-301\n\n故障现象：\n曝光工位反复报干涉仪信号丢失，复位后短时恢复。\n\n触发条件：\n连续曝光超过 200 片后开始出现。\n\n复现步骤：\n1. 连续曝光至 200 片以上；\n2. 观察干涉仪信号曲线；\n3. 出现短时丢失报警。\n\n排查过程：\n干涉仪光学头污染导致信号衰减。\n\n处理措施：\n清洁光学头并重新标定干涉仪基线。\n\n处理状态：已解决\n\n处理结果：\n清洁与重标定后连续 500 片无复现。',
    creatorNickname: '陈工',
    organizationName: MOCK_REFERENCE_ORGANIZATION_NAME,
    ingestMethod: 'REVIEWED_SUBMISSION',
    caseHandlingStatus: 'RESOLVED',
    caseDetail: {
      errorCode: 'E-STAGE-301',
      handlingStatus: 'RESOLVED',
      phenomenon: '曝光工位反复报干涉仪信号丢失，复位后短时恢复。',
      conditionText: '连续曝光超过 200 片后开始出现。',
      reproductionSteps:
        '1. 连续曝光至 200 片以上；\n2. 观察干涉仪信号曲线；\n3. 出现短时丢失报警。',
      diagnosis: '干涉仪光学头污染导致信号衰减。',
      actionTaken: '清洁光学头并重新标定干涉仪基线。',
      resolution: '清洁与重标定后连续 500 片无复现。',
    },
    createdAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:00:00.000Z',
    deprecated: false,
  },
];

const GENERATED_COUNT = 24;

/**
 * 生成长列表数据（970007 起），保证分页、翻页与筛选组合有足够数据量。
 * 文档类型 / 型号 / 存储引用按序轮转，纯文本与有引用的样本交替出现。
 */
function buildGeneratedRecords(): MockReferenceDocumentRecord[] {
  const types = ['ERROR_CODE_MANUAL', 'MAINTENANCE_GUIDE', 'SAFETY_STANDARD', 'CHECKLIST'] as const;

  return Array.from({ length: GENERATED_COUNT }, (_, index) => {
    const id = 970007 + index;
    const type = types[index % types.length];
    const useModel = index % 3 !== 0;
    const model = useModel ? MOCK_REFERENCE_EQUIPMENT_MODELS[index % 4] : null;
    const day = String((index % 27) + 1).padStart(2, '0');

    return {
      id,
      title: `现场处置案例 ${String(index + 1).padStart(3, '0')}（Mock 批量）`,
      documentType: type,
      equipmentModelId: model?.id ?? null,
      equipmentModelName: model?.modelName ?? null,
      description: index % 2 === 0 ? '批量生成的说明文本，用于验证列表展示与筛选。' : null,
      originalFilename: index % 2 === 0 ? `case-${id}-mock.txt` : null,
      mimeType: index % 2 === 0 ? 'text/plain' : null,
      hasFile: index % 2 === 0,
      contentText: `# 案例 ${id}\n\n批量生成的文本内容，用于验证详情展示与分页。`,
      creatorNickname: index % 3 === 0 ? '陈工' : '系统管理员',
      organizationName: MOCK_REFERENCE_ORGANIZATION_NAME,
      ingestMethod: 'ADMIN_DIRECT',
      equipmentModelText: null,
      caseHandlingStatus: null,
      caseDetail: null,
      createdAt: `2026-08-${day}T08:30:00.000Z`,
      updatedAt: `2026-08-${day}T08:30:00.000Z`,
      deprecated: false,
    };
  });
}

/** Mock「落库」数据源工厂：每次调用返回全量种子的新副本，供 adapter 的 reset 隔离 */
export function buildMockReferenceDocumentRecords(): MockReferenceDocumentRecord[] {
  return [...MOCK_REFERENCE_DOCUMENT_SEEDS, ...buildGeneratedRecords()].map((record) => ({
    ...record,
  }));
}
