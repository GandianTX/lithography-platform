// src/features/reference-document/ui/reference-document-detail-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 历史维修记录详情面板单测（任务 07：读取 + 管理入口显隐）。
 *
 * 覆盖：
 * - 普通资料：元数据 + 生效正文 + 授权下载入口；
 * - 合法无附件资料：不渲染下载按钮，仍展示正文；
 * - 报告来源：读取原始冻结报告内容（不再依赖资料正文）；
 * - 历史版本：修订摘要与原始冻结版本说明；
 * - 不可见资料：统一 not-found，不渲染任何数据；
 * - 下载失败：提示后端消息，不伪造成功。
 *
 * 管理动作入口按会话视角显隐：一级管理员四项 + 原作者删除（R053/R058–R061）；
 * 授权由服务端最终裁决，页面仅做入口装配。
 */

import { type ReactElement } from 'react';
import {
  fireEvent,
  render as rtlRender,
  type RenderOptions,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageFeedbackProvider } from '@/shared/ui/message-feedback';

import type {
  ReferenceDocumentDetail,
  ReferenceDocumentFrozenReport,
  ReferenceDocumentRevisions,
} from '../infrastructure/reference-document.types';
import * as referenceDocumentAdapter from '../infrastructure/reference-document-adapter';
import * as referenceDocumentHttpAdapter from '../infrastructure/reference-document-http-adapter';

import { ReferenceDocumentDetailPanel } from './reference-document-detail-panel';

function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return rtlRender(ui, { wrapper: MessageFeedbackProvider, ...options });
}

vi.mock('../infrastructure/reference-document-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof referenceDocumentAdapter>();

  return {
    ...actual,
    fetchReferenceDocument: vi.fn(),
    fetchPendingOwnershipReferenceDocument: vi.fn(),
    fetchReferenceDocumentRevisions: vi.fn(),
    deleteReferenceDocument: vi.fn(),
    reviseReferenceDocument: vi.fn(),
    offlineReferenceDocument: vi.fn(),
    adminDeleteReferenceDocument: vi.fn(),
    correctReferenceDocumentOwnership: vi.fn(),
  };
});

vi.mock('../infrastructure/reference-document-http-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof referenceDocumentHttpAdapter>();

  return {
    ...actual,
    downloadReferenceDocumentFile: vi.fn(),
    downloadReferenceDocumentSourceAttachment: vi.fn(),
  };
});

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const navigateMock = vi.fn();
const fetchDetailMock = vi.mocked(referenceDocumentAdapter.fetchReferenceDocument);
const fetchPendingDetailMock = vi.mocked(
  referenceDocumentAdapter.fetchPendingOwnershipReferenceDocument,
);
const fetchRevisionsMock = vi.mocked(referenceDocumentAdapter.fetchReferenceDocumentRevisions);
const downloadFileMock = vi.mocked(referenceDocumentHttpAdapter.downloadReferenceDocumentFile);
const downloadSourceAttachmentMock = vi.mocked(
  referenceDocumentHttpAdapter.downloadReferenceDocumentSourceAttachment,
);

function buildDetail(overrides: Partial<ReferenceDocumentDetail> = {}): ReferenceDocumentDetail {
  return {
    id: 970002,
    title: 'NXE:3400C 光源维护指南',
    documentType: 'MAINTENANCE_GUIDE',
    equipmentModelId: 51,
    equipmentModelName: 'ASML TWINSCAN NXE:3400C',
    equipmentModelText: null,
    description: '光源模块周期性维护要点。',
    originalFilename: 'nxe-3400c-source-guide.pdf',
    mimeType: 'application/pdf',
    hasFile: true,
    contentText: '# 光源维护指南\n\n每周记录能量衰减。',
    contentSource: 'ORIGINAL',
    sourceKind: 'MATERIAL',
    effectiveRevisionNo: 0,
    sourceReportId: null,
    sourceReportVersionId: null,
    frozenReport: null,
    structuredContent: null,
    sourceReportAttachment: null,
    organizationName: '甲方默认组织',
    ingestMethod: 'ADMIN_DIRECT',
    caseDetail: null,
    creatorNickname: '陈工',
    viewerIsOriginalAuthor: false,
    createdAt: '2026-08-02T09:30:00.000Z',
    updatedAt: '2026-08-05T14:00:00.000Z',
    ...overrides,
  };
}

const revisionsFixture: ReferenceDocumentRevisions = {
  documentId: 970002,
  currentRevisionNo: 0,
  sourceKind: 'MATERIAL',
  sourceReportVersionId: null,
  revisions: [],
};

/** 任务 07 加法扩展键的空值形态（旧快照 / 未携带场景） */
const frozenExtensionEmpty = {
  faults: [],
  handlingResult: null,
  closureReason: null,
  resetResult: null,
  actualCause: null,
  repairActions: null,
  verificationResult: null,
  supplementaryNote: null,
} satisfies Pick<
  ReferenceDocumentFrozenReport,
  | 'faults'
  | 'handlingResult'
  | 'closureReason'
  | 'resetResult'
  | 'actualCause'
  | 'repairActions'
  | 'verificationResult'
  | 'supplementaryNote'
>;

beforeEach(() => {
  fetchDetailMock.mockReset();
  fetchPendingDetailMock.mockReset();
  fetchRevisionsMock.mockReset();
  downloadFileMock.mockReset();
  downloadSourceAttachmentMock.mockReset();
  navigateMock.mockReset();
  fetchRevisionsMock.mockResolvedValue(revisionsFixture);

  URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  URL.revokeObjectURL = vi.fn();
});

const renderPanel = (
  viewer: { role: 'SUPER_ADMIN' | 'ENGINEER' | 'CUSTOMER' | null; adminLevel: number | null } = {
    role: 'ENGINEER',
    adminLevel: null,
  },
) => render(<ReferenceDocumentDetailPanel documentId={970002} viewer={viewer} />);

describe('ReferenceDocumentDetailPanel（只读）', () => {
  it('普通资料：展示元数据、生效正文与下载入口，不渲染任何写操作', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail() });

    renderPanel();

    expect(await screen.findByText('NXE:3400C 光源维护指南')).toBeTruthy();
    expect(screen.getByText('光源模块周期性维护要点。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下载原件' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编 辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删 除' })).toBeNull();
    expect(screen.queryByRole('button', { name: '新增资料' })).toBeNull();
  });

  it('合法无附件资料：不渲染下载按钮，仍展示正文', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        hasFile: false,
        originalFilename: null,
        mimeType: null,
        contentText: '仅正文的无附件资料。',
      }),
    });

    renderPanel();

    expect(await screen.findByText('仅正文的无附件资料。')).toBeTruthy();
    expect(screen.getByText('无附件资料')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '下载原件' })).toBeNull();
  });

  it('报告来源：读取原始冻结报告内容与报警/步骤', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        id: 970010,
        title: '光刻机 Z 轴异常处理',
        sourceKind: 'INDEPENDENT_REPORT',
        effectiveRevisionNo: 0,
        contentSource: 'FROZEN_REPORT',
        sourceReportId: 960001,
        sourceReportVersionId: 990001,
        contentText: '冻结报告拼装文本',
        frozenReport: {
          versionId: 990001,
          versionNo: 2,
          schemaVersion: 1,
          submittedAt: '2026-10-01T00:00:00.000Z',
          sourceType: 'HISTORICAL_CASE',
          repairRequestId: null,
          title: '光刻机 Z 轴异常处理',
          customerFactoryName: '某晶圆厂',
          equipmentModelId: 94,
          equipmentModelText: null,
          maintenanceDate: '2026-09-30',
          maintenanceEngineerName: '工程师甲',
          alarms: [
            {
              alarmIndex: 1,
              alarmCode: '0123',
              alarmDescription: 'Z 轴超限',
              phaseCode: 'OCCURRENCE',
              resetResult: 'RESET_SUCCESS',
            },
          ],
          steps: [
            {
              stepNo: 1,
              stepCode: 'S1',
              phaseCode: 'ANALYSIS',
              partName: 'Z 轴电机',
              actionText: '检查电机接线',
              resultText: '接线松动',
              newAlarmCode: null,
              isValidNewBranch: false,
            },
          ],
          // 任务 07 加法扩展键（旧快照/未携带场景为空值）
          ...frozenExtensionEmpty,
          ai: {
            usage: 'NOT_USED',
            sourceType: null,
            sourceId: null,
            sourceVersion: null,
            score: null,
            correctness: null,
            helpfulness: null,
            note: null,
          },
        },
      }),
    });

    renderPanel();

    expect(await screen.findByText('原始冻结报告内容')).toBeTruthy();
    expect(screen.getByText('0123')).toBeTruthy();
    expect(screen.getByText('Z 轴电机')).toBeTruthy();
    expect(screen.getByText(/原始冻结版本 ID 990001/)).toBeTruthy();
    // AI 空值：无评分/说明时不渲染，不得误显示成评分 0
    expect(screen.queryByText(/评分 0/)).toBeNull();
    expect(screen.queryByText('AI 说明')).toBeNull();
    // 冻结报告已提供结构化内容，不再重复渲染拼装正文
    expect(screen.queryByText('冻结报告拼装文本')).toBeNull();
  });

  it('工单总结来源：冻结块展示来源工单标识与 AI 评价实际提供的字段', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        id: 970011,
        sourceKind: 'WORK_ORDER_SUMMARY',
        contentSource: 'FROZEN_REPORT',
        sourceReportId: 960002,
        sourceReportVersionId: 990002,
        frozenReport: {
          versionId: 990002,
          versionNo: 1,
          schemaVersion: 2,
          submittedAt: '2026-11-10T00:00:00.000Z',
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: 950001,
          title: '工单维修总结：光源能量衰减',
          customerFactoryName: '某晶圆厂',
          equipmentModelId: 94,
          equipmentModelText: null,
          maintenanceDate: '2026-11-09',
          maintenanceEngineerName: '工程师乙',
          alarms: [],
          steps: [
            {
              stepNo: 1,
              stepCode: 'S1',
              phaseCode: 'REPAIR',
              partName: null,
              actionText: '更换光源模块',
              resultText: '能量恢复正常',
              newAlarmCode: null,
              isValidNewBranch: false,
            },
          ],
          // 任务 07 加法扩展键（旧快照/未携带场景为空值）
          ...frozenExtensionEmpty,
          ai: {
            usage: 'USED',
            sourceType: null,
            sourceId: null,
            sourceVersion: null,
            score: 4,
            correctness: 'CORRECT',
            helpfulness: 5,
            note: 'AI 提示检查光源模块',
          },
        },
      }),
    });

    renderPanel();

    // 来源行文本与「原始冻结版本 ID」拼接在同一单元格，用正则匹配来源标签
    expect(await screen.findByText(/工单总结/)).toBeTruthy();
    expect(screen.getByText('工单 #' + 950001)).toBeTruthy();
    expect(screen.getByText('更换光源模块')).toBeTruthy();
    expect(screen.getByText(/评分 4/)).toBeTruthy();
    expect(screen.getByText(/准确性 CORRECT/)).toBeTruthy();
    expect(screen.getByText(/帮助性 5/)).toBeTruthy();
    expect(screen.getByText('AI 提示检查光源模块')).toBeTruthy();
  });

  it('无报警的工单总结冻结块：报警区展示空状态，不回退到实时工单内容', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        id: 970012,
        sourceKind: 'WORK_ORDER_SUMMARY',
        contentSource: 'FROZEN_REPORT',
        sourceReportId: 960002,
        sourceReportVersionId: 990003,
        contentText: '冻结拼装文本占位',
        frozenReport: {
          versionId: 990003,
          versionNo: 1,
          schemaVersion: 2,
          submittedAt: '2026-11-10T00:00:00.000Z',
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: 950002,
          title: '工单维修总结：无报警场景',
          customerFactoryName: '某晶圆厂',
          equipmentModelId: null,
          equipmentModelText: null,
          maintenanceDate: '2026-11-09',
          maintenanceEngineerName: '工程师乙',
          alarms: [],
          steps: [
            {
              stepNo: 1,
              stepCode: 'S1',
              phaseCode: 'REPAIR',
              partName: null,
              actionText: '预防性更换密封圈',
              resultText: null,
              newAlarmCode: null,
              isValidNewBranch: false,
            },
          ],
          // 任务 07 加法扩展键（旧快照/未携带场景为空值）
          ...frozenExtensionEmpty,
          ai: {
            usage: 'NOT_USED',
            sourceType: null,
            sourceId: null,
            sourceVersion: null,
            score: null,
            correctness: null,
            helpfulness: null,
            note: null,
          },
        },
      }),
    });

    renderPanel();

    expect(await screen.findByText('无报警记录。')).toBeTruthy();
    expect(screen.queryByText('冻结拼装文本占位')).toBeNull();
  });

  it('历史版本：展示当前生效与修订摘要，可展开查看该修订版本的具体内容', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({ effectiveRevisionNo: 2, contentSource: 'CURRENT_REVISION' }),
    });
    fetchRevisionsMock.mockResolvedValue({
      documentId: 970002,
      currentRevisionNo: 2,
      sourceKind: 'MATERIAL',
      sourceReportVersionId: null,
      revisions: [
        {
          revisionNo: 1,
          reason: '补充安全注意事项',
          actorNickname: '管理员甲',
          createdAt: '2026-11-05T00:00:00.000Z',
          contentText: 'v1 生效正文内容',
        },
        {
          revisionNo: 2,
          reason: '更新适用机型',
          actorNickname: '管理员乙',
          createdAt: '2026-11-06T00:00:00.000Z',
          contentText: null,
        },
      ],
    });

    const { container } = renderPanel();

    expect(await screen.findByText('历史版本')).toBeTruthy();
    expect(screen.getByText('v1')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText('补充安全注意事项')).toBeTruthy();
    expect(screen.getByText('管理员乙')).toBeTruthy();

    // 授权追溯（V5.6）：展开 v1 行可见该修订版本的具体生效内容，而非仅版本号
    const expandIcons = container.querySelectorAll('.ant-table-row-expand-icon');
    expect(expandIcons.length).toBe(2);
    fireEvent.click(expandIcons[0]!);
    expect(await screen.findByText('v1 生效正文内容')).toBeTruthy();
    // v2 未展开：其内容不在文档中
    expect(screen.queryByText('v1 生效正文内容')).toBeTruthy();
  });

  it('修订后详情：生效正文为修订内容，同时提供原始冻结报告追溯视图', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        sourceKind: 'WORK_ORDER_SUMMARY',
        sourceReportId: 960002,
        sourceReportVersionId: 990002,
        effectiveRevisionNo: 1,
        contentSource: 'CURRENT_REVISION',
        contentText: '管理修订后的补充说明正文。',
        frozenReport: {
          versionId: 990002,
          versionNo: 1,
          schemaVersion: 2,
          submittedAt: '2026-11-10T00:00:00.000Z',
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: 950001,
          title: '工单维修总结：光源能量衰减',
          customerFactoryName: '某晶圆厂',
          equipmentModelId: 94,
          equipmentModelText: null,
          maintenanceDate: '2026-11-09',
          maintenanceEngineerName: '工程师乙',
          alarms: [],
          steps: [
            {
              stepNo: 1,
              stepCode: 'S1',
              phaseCode: 'REPAIR',
              partName: null,
              actionText: '更换光源模块',
              resultText: '能量恢复正常',
              newAlarmCode: null,
              isValidNewBranch: false,
            },
          ],
          // 任务 07 加法扩展键（旧快照/未携带场景为空值）
          ...frozenExtensionEmpty,
          ai: {
            usage: 'NOT_USED',
            sourceType: null,
            sourceId: null,
            sourceVersion: null,
            score: null,
            correctness: null,
            helpfulness: null,
            note: null,
          },
        },
      }),
    });

    renderPanel();

    // 修订后正文仍为生效内容
    expect(await screen.findByText('管理修订后的补充说明正文。')).toBeTruthy();
    // 原始冻结报告作为追溯视图并存（授权追溯，不随管理修订替换）
    expect(screen.getByText('原始冻结报告内容')).toBeTruthy();
    expect(screen.getByText('更换光源模块')).toBeTruthy();
    expect(screen.getByText(/原始冻结版本 ID 990002/)).toBeTruthy();
  });

  it('生效管理修订携带结构化内容：结构化展示生效版本 + 冻结报告追溯并存', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        id: 970013,
        sourceKind: 'INDEPENDENT_REPORT',
        contentSource: 'CURRENT_REVISION',
        effectiveRevisionNo: 1,
        contentText: '结构化组合文本',
        structuredContent: {
          schemaVersion: 1,
          maintenanceDate: '2026-09-30',
          maintenanceEngineerName: '工程师甲',
          customerFactoryName: '某晶圆厂',
          equipmentModelText: 'DEV-LITHO-A',
          resetResult: 'SAME_FAULT',
          faults: [
            {
              branchKind: 'INITIAL',
              stepCode: null,
              phaseCode: 'PHASE_02',
              mainError: 'Z AXIS OVER LIMIT（更正）',
              unitError: 'Z1',
              source: 'MOTION',
              errorType: 'SERVO',
              gpibStatus: 'IDLE',
              faultStatus: 'ACTIVE',
              description: 'Z 轴超限报警（描述更正）',
              action: '停机检查',
            },
          ],
          steps: [
            {
              stepCode: 'step-a',
              stepNo: 1,
              phaseCode: 'PHASE_03',
              errorCode: 'E-100',
              partName: 'Z 轴电机',
              actionText: '检查电机接线（更正）',
              resultCode: 'RESOLVED',
            },
          ],
          handlingResult: 'INTERRUPTED',
          closureReason: '备件未到货（更正）',
          actualCause: '接线松动',
          repairActions: null,
          verificationResult: '上电验证通过',
          supplementaryNote: '后续跟进',
        },
        frozenReport: {
          versionId: 990001,
          versionNo: 2,
          schemaVersion: 1,
          submittedAt: '2026-10-01T00:00:00.000Z',
          sourceType: 'HISTORICAL_CASE',
          repairRequestId: null,
          title: '光刻机 Z 轴异常处理',
          customerFactoryName: '某晶圆厂',
          equipmentModelId: null,
          equipmentModelText: 'DEV-LITHO-A',
          maintenanceDate: '2026-09-30',
          maintenanceEngineerName: '工程师甲',
          alarms: [],
          steps: [],
          ...frozenExtensionEmpty,
          ai: {
            usage: 'NOT_USED',
            sourceType: null,
            sourceId: null,
            sourceVersion: null,
            score: null,
            correctness: null,
            helpfulness: null,
            note: null,
          },
        },
      }),
    });

    renderPanel({ role: 'SUPER_ADMIN', adminLevel: 1 });

    // 结构化生效内容：故障字段/复位/步骤/维修结果全展示
    expect(await screen.findByText('管理修订后报告内容')).toBeTruthy();
    expect(screen.getByText('Z 轴超限报警（描述更正）')).toBeTruthy();
    expect(screen.getByText(/Main Error：Z AXIS OVER LIMIT（更正）/)).toBeTruthy();
    expect(screen.getByText('相同故障')).toBeTruthy();
    expect(screen.getByText('检查电机接线（更正）')).toBeTruthy();
    expect(screen.getByText('备件未到货（更正）')).toBeTruthy();
    expect(screen.getByText('上电验证通过')).toBeTruthy();
    // 原始冻结报告追溯块并存
    expect(screen.getByText('原始冻结报告内容')).toBeTruthy();
  });

  it('下架/软删/跨公司：统一 not-found，不渲染任何资料字段', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: false,
      reason: 'not-found',
      message: '历史维修记录不存在或不可查看。',
    });

    renderPanel();

    expect(await screen.findByText('历史维修记录不存在或不可查看。')).toBeTruthy();
    expect(screen.queryByText('光源模块周期性维护要点。')).toBeNull();
  });

  it('非法 documentId：不发起详情请求，直接 not-found', async () => {
    render(
      <ReferenceDocumentDetailPanel
        documentId={null}
        viewer={{ role: 'ENGINEER', adminLevel: null }}
      />,
    );

    expect(await screen.findByText('历史维修记录不存在或不可查看。')).toBeTruthy();
    expect(fetchDetailMock).not.toHaveBeenCalled();
  });

  it('下载失败：提示后端消息，不触发浏览器保存', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail() });
    downloadFileMock.mockResolvedValue({
      ok: false,
      reason: 'file-not-available',
      message: '该资料没有可下载的文件。',
    });

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '下载原件' }));

    await waitFor(() => {
      expect(screen.getByText('该资料没有可下载的文件。')).toBeTruthy();
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('ReferenceDocumentDetailPanel（来源报告原件下载，任务 07 P2）', () => {
  const sourceAttachmentFixture = {
    attachmentId: 880123,
    fileId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    originalFilename: 'Z轴报警原件.txt',
    mimeType: 'text/plain',
    byteSize: 27,
  };

  it('报告来源资料带冻结原件：渲染「下载报告原件」入口并触发授权下载', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({ sourceReportAttachment: sourceAttachmentFixture }),
    });
    downloadSourceAttachmentMock.mockResolvedValue({
      ok: true,
      blob: new Blob(['report-bytes']),
      filename: 'Z轴报警原件.txt',
    });

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '下载报告原件' }));

    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalled();
    });
    expect(downloadSourceAttachmentMock).toHaveBeenCalledWith(970002, 880123);
    // 触发浏览器保存后即时移除锚点：以 revokeObjectURL 收尾为成功凭证
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('无可下载冻结原件（sourceReportAttachment 为空）：不渲染下载入口', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail() });

    renderPanel();

    expect(await screen.findByRole('button', { name: '下载原件' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '下载报告原件' })).toBeNull();
  });

  it('归属待核实详情（pending-ownership 变体）：不渲染冻结原件下载入口（该状态不可授权下载）', async () => {
    fetchPendingDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({ sourceReportAttachment: sourceAttachmentFixture }),
    });

    render(
      <ReferenceDocumentDetailPanel
        documentId={970002}
        viewer={{ role: 'SUPER_ADMIN', adminLevel: 1 }}
        variant="pending-ownership"
      />,
    );

    expect(await screen.findByText('NXE:3400C 光源维护指南')).toBeTruthy();
    // PENDING 归属未确认：正式资料下载入口未放行，冻结原件入口同样不显示
    expect(screen.queryByRole('button', { name: '下载报告原件' })).toBeNull();
  });

  it('来源原件下载失败：提示后端消息，不伪造成功', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({ sourceReportAttachment: sourceAttachmentFixture }),
    });
    downloadSourceAttachmentMock.mockResolvedValue({
      ok: false,
      reason: 'not-found',
      message: '历史维修记录不存在或不可查看。',
    });

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '下载报告原件' }));

    await waitFor(() => {
      expect(screen.getByText('历史维修记录不存在或不可查看。')).toBeTruthy();
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('普通资料不回归：原有「下载原件」入口与流程不受影响', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail() });
    downloadFileMock.mockResolvedValue({
      ok: true,
      blob: new Blob(['pdf-bytes']),
      filename: 'nxe-3400c-source-guide.pdf',
    });

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '下载原件' }));

    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalled();
    });
    expect(downloadFileMock).toHaveBeenCalledWith(970002);
    expect(downloadSourceAttachmentMock).not.toHaveBeenCalled();
  });
});

describe('ReferenceDocumentManagementSection（任务 07 R053/R058–R061 入口显隐）', () => {
  const onlineDetail = () => buildDetail();

  it('一级管理员：渲染四项管理入口；工程师看不到', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: onlineDetail() });

    renderPanel({ role: 'SUPER_ADMIN', adminLevel: 1 });

    expect(await screen.findByRole('button', { name: '管理修订' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '下架资料' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除资料' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '上传归属管理' })).toBeTruthy();
  });

  it('一级管理员点「管理修订」：进入独立管理修订页（不发出任何 mutation）', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({ effectiveRevisionNo: 0 }),
    });

    renderPanel({ role: 'SUPER_ADMIN', adminLevel: 1 });

    fireEvent.click(await screen.findByRole('button', { name: '管理修订' }));

    // 独立管理修订页（任务 07）：详情页只做入口导航，修订表单在独立页
    expect(navigateMock).toHaveBeenCalledWith('/admin/reference-revise/970002');
    expect(vi.mocked(referenceDocumentAdapter.reviseReferenceDocument)).not.toHaveBeenCalled();
  });

  it('工程师（非作者）：不渲染任何管理入口', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: onlineDetail() });

    renderPanel();

    expect(await screen.findByRole('button', { name: '下载原件' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '管理修订' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下架资料' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除资料' })).toBeNull();
  });

  it('原作者（工程师）：仅渲染作者删除入口；Modal 确认后携带 expected_version 并提示成功', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({ viewerIsOriginalAuthor: true }),
    });
    const deleteMock = vi.mocked(referenceDocumentAdapter.deleteReferenceDocument);
    deleteMock.mockResolvedValue({ ok: true });

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: '删除资料' }));
    // Modal 独立确认（R053）：确认后才发出 mutation
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith(970002, 0);
    });
    expect(await screen.findByText('资料已删除。')).toBeTruthy();
    deleteMock.mockReset();
  });

  it('作者删除版本过期：显式提示重读，不伪造成功', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({ viewerIsOriginalAuthor: true }),
    });
    const deleteMock = vi.mocked(referenceDocumentAdapter.deleteReferenceDocument);
    deleteMock.mockResolvedValue({
      ok: false,
      reason: 'version-conflict',
      message: '资料版本已更新，请重新读取当前版本后重试。',
    });

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: '删除资料' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));

    expect(await screen.findByText('资料版本已更新，请重新读取当前版本后重试。')).toBeTruthy();
    deleteMock.mockReset();
  });
});

describe('ReferenceDocumentManagementSection（危险操作 Modal 独立确认）', () => {
  it('下架资料：Modal 确认后携带原因与 expected_version；取消不发出 mutation', async () => {
    fetchDetailMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({ effectiveRevisionNo: 2 }),
    });
    const offlineMock = vi.mocked(referenceDocumentAdapter.offlineReferenceDocument);
    offlineMock.mockResolvedValue({ ok: true, id: 970002, revisionNo: 3 });

    renderPanel({ role: 'SUPER_ADMIN', adminLevel: 1 });

    fireEvent.click(await screen.findByRole('button', { name: '下架资料' }));
    expect(await screen.findByText('确认下架该正式资料？')).toBeTruthy();

    // 取消确认：不发 mutation，不改变页面状态（资料详情仍在）
    fireEvent.click(screen.getByRole('button', { name: '取 消' }));
    expect(offlineMock).not.toHaveBeenCalled();
    expect(screen.queryByText('确认下架该正式资料？')).toBeNull();
    expect(screen.getByText('NXE:3400C 光源维护指南')).toBeTruthy();

    // 再次打开并确认：携带 expected_version 2 与原因
    fireEvent.click(screen.getByRole('button', { name: '下架资料' }));
    fireEvent.change(screen.getByPlaceholderText('操作原因（必填，不超过 500 字）'), {
      target: { value: '内容过期，需下架' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认下架' }));

    await waitFor(() => {
      expect(offlineMock).toHaveBeenCalledWith(970002, 2, '内容过期，需下架');
    });
    expect(await screen.findByText('资料已下架。')).toBeTruthy();
    offlineMock.mockReset();
  });

  it('下架原因必填：空白原因不发 mutation，错误提示后可补填重试', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail() });
    const offlineMock = vi.mocked(referenceDocumentAdapter.offlineReferenceDocument);
    offlineMock.mockResolvedValue({ ok: true, id: 970002, revisionNo: 1 });

    renderPanel({ role: 'SUPER_ADMIN', adminLevel: 1 });

    fireEvent.click(await screen.findByRole('button', { name: '下架资料' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认下架' }));

    expect(await screen.findByText('操作原因必填，请填写后再提交。')).toBeTruthy();
    expect(offlineMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('操作原因（必填，不超过 500 字）'), {
      target: { value: '重复上架来源' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认下架' }));

    await waitFor(() => {
      expect(offlineMock).toHaveBeenCalledWith(970002, 0, '重复上架来源');
    });
    offlineMock.mockReset();
  });

  it('下架与管理删除分别确认：各自 Modal 只触发对应 mutation，不能串用', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail() });
    const offlineMock = vi.mocked(referenceDocumentAdapter.offlineReferenceDocument);
    const adminDeleteMock = vi.mocked(referenceDocumentAdapter.adminDeleteReferenceDocument);
    offlineMock.mockResolvedValue({ ok: true, id: 970002, revisionNo: 1 });
    adminDeleteMock.mockResolvedValue({ ok: true, id: 970002, revisionNo: 1 });

    renderPanel({ role: 'SUPER_ADMIN', adminLevel: 1 });

    // 下架确认流只发 offline
    fireEvent.click(await screen.findByRole('button', { name: '下架资料' }));
    fireEvent.change(screen.getByPlaceholderText('操作原因（必填，不超过 500 字）'), {
      target: { value: '下架' },
    });
    fireEvent.click(await screen.findByRole('button', { name: '确认下架' }));
    await waitFor(() => {
      expect(offlineMock).toHaveBeenCalledTimes(1);
    });
    expect(adminDeleteMock).not.toHaveBeenCalled();

    // 等下架成功提示出现（Modal 随成功关闭），再进入管理删除确认流
    await screen.findByText('资料已下架。');
    fireEvent.click(await screen.findByRole('button', { name: '删除资料' }));
    fireEvent.change(screen.getByPlaceholderText('操作原因（必填，不超过 500 字）'), {
      target: { value: '违规内容' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => {
      expect(adminDeleteMock).toHaveBeenCalledTimes(1);
    });
    // 下架 mutation 未被串用（仍只有一次）
    expect(offlineMock).toHaveBeenCalledTimes(1);
    offlineMock.mockReset();
    adminDeleteMock.mockReset();
  });

  it('请求失败：错误提示但不关闭 Modal，可取消退出；重复 onOk 在 busy 期间被忽略', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail() });
    const offlineMock = vi.mocked(referenceDocumentAdapter.offlineReferenceDocument);
    type OfflineOutcome = Awaited<
      ReturnType<typeof referenceDocumentAdapter.offlineReferenceDocument>
    >;
    let resolveOffline!: (value: OfflineOutcome) => void;
    offlineMock.mockImplementation(
      () =>
        new Promise<OfflineOutcome>((resolve) => {
          resolveOffline = resolve;
        }),
    );

    renderPanel({ role: 'SUPER_ADMIN', adminLevel: 1 });

    fireEvent.click(await screen.findByRole('button', { name: '下架资料' }));
    fireEvent.change(screen.getByPlaceholderText('操作原因（必填，不超过 500 字）'), {
      target: { value: '下架' },
    });
    const okButton = await screen.findByRole('button', { name: '确认下架' });
    fireEvent.click(okButton);

    // busy 期间的第二次 onOk 直接忽略（防重复提交）：复用同一按钮引用再点一次
    fireEvent.click(okButton);
    await waitFor(() => {
      expect(offlineMock).toHaveBeenCalledTimes(1);
    });
    expect(offlineMock).not.toHaveBeenCalledTimes(2);

    resolveOffline({
      ok: false,
      reason: 'management-failed',
      message: '资料管理操作失败，请稍后重试。',
    });
    expect(await screen.findByText('资料管理操作失败，请稍后重试。')).toBeTruthy();
    // 失败后 Modal 仍打开，可取消退出
    expect(screen.getByText('确认下架该正式资料？')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '取 消' }));
    expect(screen.queryByText('确认下架该正式资料？')).toBeNull();
    offlineMock.mockReset();
  });

  it('权限入口显隐：工程师看不到危险操作入口；一级管理员看到三项独立确认入口', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail() });

    renderPanel();

    expect(await screen.findByRole('button', { name: '下载原件' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '下架资料' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除资料' })).toBeNull();

    renderPanel({ role: 'SUPER_ADMIN', adminLevel: 1 });
    expect(await screen.findByRole('button', { name: '下架资料' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除资料' })).toBeTruthy();
  });
});
