// @vitest-environment jsdom
// src/features/maintenance-report/ui/maintenance-report-editor-page.spec.tsx
//
// 任务 06 编辑器页导出交互：
// - 未保存（新建）表单：导出按钮走「当前表单」目标，服务端只读核验，页面不发任何保存/提交请求；
// - 冻结报告（canEdit=false）：导出按钮走「已保存版本」目标；
// - 服务端拒绝时展示 userMessage，不伪造导出成功。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import type { MaintenanceReportDetail } from '../infrastructure/maintenance-report.types';

const navigateMock = vi.fn();

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useBlocker: () => ({ state: 'idle' }),
  };
});

const {
  exportMaintenanceReportMock,
  fetchMyMaintenanceReportMock,
  fetchMyWorkOrderSummaryMock,
  createDraftMock,
  updateDraftMock,
  submitReportMock,
  updateDraftContentMock,
  submitDraftMock,
  submitFormalMock,
  uploadOriginalMock,
} = vi.hoisted(() => ({
  exportMaintenanceReportMock: vi.fn(),
  fetchMyMaintenanceReportMock: vi.fn(),
  fetchMyWorkOrderSummaryMock: vi.fn(),
  createDraftMock: vi.fn(),
  updateDraftMock: vi.fn(),
  submitReportMock: vi.fn(),
  updateDraftContentMock: vi.fn(),
  submitDraftMock: vi.fn(),
  submitFormalMock: vi.fn(),
  uploadOriginalMock: vi.fn(),
}));

vi.mock('../infrastructure/maintenance-report-adapter', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../infrastructure/maintenance-report-adapter')>();
  return {
    ...actual,
    exportMaintenanceReport: exportMaintenanceReportMock,
    fetchMyMaintenanceReport: fetchMyMaintenanceReportMock,
    fetchMyWorkOrderSummary: fetchMyWorkOrderSummaryMock,
    fetchMaintenanceEquipmentModels: vi.fn().mockResolvedValue([]),
    createMaintenanceReportDraft: createDraftMock,
    updateMaintenanceReportDraft: updateDraftMock,
    submitMaintenanceReport: submitReportMock,
    updateMaintenanceReportDraftContent: updateDraftContentMock,
    submitMaintenanceReportDraft: submitDraftMock,
    submitMaintenanceReportFormal: submitFormalMock,
    uploadMaintenanceReportOriginal: uploadOriginalMock,
  };
});

const { downloadMaintenanceReportExportMock } = vi.hoisted(() => ({
  downloadMaintenanceReportExportMock: vi.fn(),
}));

vi.mock('./maintenance-report-download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./maintenance-report-download')>();
  return {
    ...actual,
    downloadMaintenanceReportExport: downloadMaintenanceReportExportMock,
  };
});

import { MaintenanceReportEditorPage } from './maintenance-report-editor-page';

/** DOM 环境下的 UTF-8 base64（无 Node Buffer） */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

const detailFixture: MaintenanceReportDetail = {
  report: {
    id: 960001,
    sourceType: 'HISTORICAL_CASE',
    repairRequestId: null,
    status: 'DRAFT',
    title: null,
    customerFactoryName: '某封测厂',
    equipmentModelId: null,
    equipmentModelText: 'NSR-2205i11',
    maintenanceDate: '2026-10-01',
    engineerName: '李工',
    handlingResult: 'FIXED',
    closureReason: null,
    resetResult: 'NORMAL',
    actualCause: null,
    repairActions: null,
    verificationResult: null,
    supplementaryNote: null,
    currentVersionNo: 0,
    updatedAt: '2026-10-01T00:00:00.000Z',
    aiUsage: 'NOT_USED',
    aiSourceType: null,
    aiSourceId: null,
    aiSourceVersion: null,
    aiScore: null,
    aiCorrectness: null,
    aiHelpfulness: null,
    aiNote: null,
  },
  steps: [
    {
      id: 11,
      stepNo: 1,
      stepCode: 'STEP-A',
      partName: null,
      actionText: '更换光源模块并复位',
      resultCode: 'RESOLVED',
      errorCode: null,
      resultText: null,
    },
  ],
  faults: [
    {
      id: 'f1',
      branchKind: 'INITIAL',
      stepCode: null,
      phaseCode: 'PHASE_01',
      mainError: 'E001',
      unitError: null,
      source: null,
      errorType: null,
      gpibStatus: null,
      faultStatus: null,
      description: '上片失败',
      action: null,
    },
  ],
  attachments: [],
  frozenEquipmentModelName: null,
  canEdit: true,
};

describe('MaintenanceReportEditorPage 导出', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    exportMaintenanceReportMock.mockReset();
    fetchMyMaintenanceReportMock.mockReset();
    fetchMyWorkOrderSummaryMock.mockReset();
    downloadMaintenanceReportExportMock.mockReset();
    fetchMyMaintenanceReportMock.mockResolvedValue(detailFixture);
    fetchMyWorkOrderSummaryMock.mockResolvedValue({
      repairRequestId: 1,
      requestNo: 'WO-1',
      equipmentModelId: null,
      equipmentModelCode: null,
      equipmentModelName: null,
      closedAt: null,
      report: null,
    });
    exportMaintenanceReportMock.mockResolvedValue({
      format: 'DOCX',
      fileName: '维修报告.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteSize: 12,
      contentBase64: toBase64('export-bytes-123'),
    });
    downloadMaintenanceReportExportMock.mockReturnValue('维修报告.docx');
  });

  afterEach(() => {
    cleanup();
  });

  it('新建（未保存）表单点击导出 Word：走当前表单目标，且不触发任何保存/提交请求', async () => {
    render(<MaintenanceReportEditorPage mode="HISTORICAL_CASE" engineerName="李工" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '导出 Word' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }));

    await waitFor(() => {
      expect(exportMaintenanceReportMock).toHaveBeenCalledTimes(1);
    });
    const params = exportMaintenanceReportMock.mock.calls[0][0];
    expect(params.format).toBe('DOCX');
    expect(params.currentForm.sourceType).toBe('HISTORICAL_CASE');
    expect(params.currentForm.repairRequestId).toBeNull();
    // 新建态即未保存表单：导出携带当前表单内容（初始为空表单），服务端只读核验
    expect(Array.isArray(params.currentForm.draft.steps)).toBe(true);
    expect(Array.isArray(params.currentForm.draft.faults)).toBe(true);
    expect(params.savedVersion).toBeUndefined();
    expect(downloadMaintenanceReportExportMock).toHaveBeenCalledTimes(1);
    // 导出不发写请求：草稿创建/更新与提交接口均未被调用
    expect(createDraftMock).not.toHaveBeenCalled();
    expect(updateDraftMock).not.toHaveBeenCalled();
    expect(updateDraftContentMock).not.toHaveBeenCalled();
    expect(submitReportMock).not.toHaveBeenCalled();
    expect(submitDraftMock).not.toHaveBeenCalled();
    expect(submitFormalMock).not.toHaveBeenCalled();
  });

  it('冻结报告（canEdit=false）：导出走已保存版本目标', async () => {
    fetchMyMaintenanceReportMock.mockResolvedValue({
      ...detailFixture,
      report: { ...detailFixture.report, status: 'SUBMITTED', currentVersionNo: 1 },
      canEdit: false,
    });
    render(
      <MaintenanceReportEditorPage mode="HISTORICAL_CASE" engineerName="李工" reportId={960001} />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '导出 PDF' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }));

    await waitFor(() => {
      expect(exportMaintenanceReportMock).toHaveBeenCalledTimes(1);
    });
    const params = exportMaintenanceReportMock.mock.calls[0][0];
    expect(params.format).toBe('PDF');
    expect(params.savedVersion).toEqual({ reportId: 960001 });
    expect(params.currentForm).toBeUndefined();
    expect(downloadMaintenanceReportExportMock).toHaveBeenCalledTimes(1);
  });

  it('服务端拒绝（如附件不可用）：展示错误信息，不触发下载', async () => {
    exportMaintenanceReportMock.mockRejectedValue(
      new GraphQLIngressError({
        type: 'graphql',
        message: 'MAINTENANCE_REPORT_ATTACHMENT_UNAVAILABLE',
        graphqlErrors: [
          {
            message: 'MAINTENANCE_REPORT_ATTACHMENT_UNAVAILABLE',
            extensions: {
              code: 'CONFLICT',
              errorMessage: '附件文件已缺失或内容发生变化，请移除该附件后重新上传',
            },
          },
        ],
      }),
    );
    render(<MaintenanceReportEditorPage mode="HISTORICAL_CASE" engineerName="李工" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '导出 Word' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }));

    await waitFor(() => {
      expect(screen.getByText(/附件文件已缺失或内容发生变化/)).toBeTruthy();
    });
    expect(downloadMaintenanceReportExportMock).not.toHaveBeenCalled();
  });
});

describe('MaintenanceReportEditorPage 返回入口（2026-11-21）', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    fetchMyMaintenanceReportMock.mockReset();
    fetchMyWorkOrderSummaryMock.mockReset();
    fetchMyMaintenanceReportMock.mockResolvedValue(detailFixture);
    fetchMyWorkOrderSummaryMock.mockResolvedValue({
      repairRequestId: 1,
      requestNo: 'WO-1',
      equipmentModelId: null,
      equipmentModelCode: null,
      equipmentModelName: null,
      closedAt: null,
      report: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('新建历史记录页头部入口为「我的历史记录」，点击进入既有列表路由', async () => {
    render(<MaintenanceReportEditorPage mode="HISTORICAL_CASE" engineerName="李工" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '我的历史记录' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '我的历史记录' }));

    expect(navigateMock).toHaveBeenCalledWith('/engineer/maintenance-records');
    expect(navigateMock).not.toHaveBeenCalledWith('/engineer/maintenance-records/new');
  });

  it('已有报告详情页头部入口仍为「返回列表」，进入列表路由', async () => {
    render(
      <MaintenanceReportEditorPage mode="HISTORICAL_CASE" engineerName="李工" reportId={960001} />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '返回列表' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '返回列表' }));

    expect(navigateMock).toHaveBeenCalledWith('/engineer/maintenance-records');
  });
});

describe('MaintenanceReportEditorPage 附件更换（R062-01）', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    exportMaintenanceReportMock.mockReset();
    fetchMyMaintenanceReportMock.mockReset();
    fetchMyWorkOrderSummaryMock.mockReset();
    downloadMaintenanceReportExportMock.mockReset();
    createDraftMock.mockReset();
    updateDraftMock.mockReset();
    submitReportMock.mockReset();
    uploadOriginalMock.mockReset();
    updateDraftMock.mockResolvedValue({
      reportId: 960001,
      status: 'DRAFT',
      currentVersionNo: 1,
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('已持有效原件再上传：走更换暂存，保存草稿随更新请求携带新原件', async () => {
    fetchMyMaintenanceReportMock.mockImplementation(() =>
      Promise.resolve({
        ...detailFixture,
        attachments: [
          {
            id: 5,
            fileId: 'old-file-id',
            originalFilename: 'old.png',
            mimeType: 'image/png',
            byteSize: 10,
            sortOrder: 1,
          },
        ],
      }),
    );
    uploadOriginalMock.mockResolvedValue({
      ok: true,
      file: {
        fileId: 'new-file-id',
        uploadContextId: 'new-ctx-id',
        originalFilename: 'new.png',
        mimeType: 'image/png',
        byteSize: 20,
        checksumSha256: 'a'.repeat(64),
      },
    });
    const { container } = render(
      <MaintenanceReportEditorPage mode="HISTORICAL_CASE" engineerName="李工" reportId={960001} />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '添加附件' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    fireEvent.change(fileInput as Element, {
      target: { files: [new File(['bytes'], 'new.png', { type: 'image/png' })] },
    });

    // 上传成功后进入「更换原件」暂存态，而非立即挂接（挂接会因单附件上限失败）
    await waitFor(() => {
      expect(screen.getByText('更换原件')).toBeTruthy();
    });
    expect(updateDraftMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: '保存草稿' })[0] as HTMLElement);
    await waitFor(() => {
      expect(updateDraftMock).toHaveBeenCalledTimes(1);
    });
    expect(updateDraftMock.mock.calls[0][0]).toMatchObject({
      reportId: 960001,
      attachment: { fileId: 'new-file-id', uploadContextId: 'new-ctx-id' },
    });
  });
});
