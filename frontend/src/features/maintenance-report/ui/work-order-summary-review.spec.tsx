// @vitest-environment jsdom
// src/features/maintenance-report/ui/work-order-summary-review.spec.tsx
//
// 2026-11-21 需求调整：工单维修总结只读核对页（一次正式提交完成）——
// - 只读展示服务端预览事实（sourcePreview）：预览与 sourceConfirmation 同一次读取，
//   页面不再注入第二份详情读侧（真实调用路径只有一次 myWorkOrderSummary）；
// - 不出现「保存草稿」，不调用建稿/改稿接口：无草稿时一次正式提交直接冻结；
//   已有总结草稿兼容读取，重新核对后可直接提交；
// - 预览后来源变化由提交侧指纹复核拒绝（后端用例覆盖）；仅确认来源冲突时
//   提供「刷新并重新核对」，已知业务错误展示可操作文案，未知错误通用兜底；
// - AI 评价：查询进行中/失败/存在适用会话未选择时禁止提交；确认无会话才放行；
//   不提供「未使用 AI」强制选项。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchMyWorkOrderSummaryMock,
  downloadSourceFileMock,
  createDraftMock,
  updateDraftMock,
  submitReportMock,
  exportMaintenanceReportMock,
  fetchAiConversationsMock,
} = vi.hoisted(() => ({
  fetchMyWorkOrderSummaryMock: vi.fn(),
  downloadSourceFileMock: vi.fn(),
  createDraftMock: vi.fn(),
  updateDraftMock: vi.fn(),
  submitReportMock: vi.fn(),
  exportMaintenanceReportMock: vi.fn(),
  fetchAiConversationsMock: vi.fn(),
}));

const navigateMock = vi.fn();

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../infrastructure/maintenance-report-adapter', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../infrastructure/maintenance-report-adapter')>();
  return {
    ...actual,
    fetchMyWorkOrderSummary: fetchMyWorkOrderSummaryMock,
    createMaintenanceReportDraft: createDraftMock,
    updateMaintenanceReportDraft: updateDraftMock,
    submitMaintenanceReport: submitReportMock,
    exportMaintenanceReport: exportMaintenanceReportMock,
    fetchWorkOrderSummaryAiConversations: fetchAiConversationsMock,
  };
});

import { GraphQLIngressError } from '@/shared/graphql';

import { WorkOrderSummaryReviewPage } from './work-order-summary-review';

const ATTACHMENT = {
  fileId: 'f-1',
  originalFilename: '维修原件.pdf',
  byteSize: 100,
};

const sourcePreviewFixture = {
  customerCompanyName: '某封测厂',
  handlingResult: 'FIXED',
  closureReason: '维修完成',
  maintenanceDate: '2026-10-02',
  engineerName: '李工',
  resetResult: 'NORMAL',
  supplementaryNote: '已现场培训',
  attachment: ATTACHMENT,
  intakeFaultDescription: '上片失败',
  intakeCustomerFile: null,
  steps: [
    {
      stepNo: 1,
      errorCode: null,
      partName: '激光器',
      actionText: '重新插拔线缆',
      resultCode: 'RESOLVED',
    },
  ],
  panels: [
    {
      panelType: 'INITIAL',
      stepNo: null,
      phaseCode: 'PHASE_02',
      mainError: 'E-01',
      unitError: null,
      source: 'ALARM_HISTORY',
      errorType: null,
      gpibStatus: null,
      faultStatus: 'PERSISTENT',
      description: '上电报警',
      action: '检查供电',
    },
  ],
};

const entryFixture = {
  repairRequestId: 955001,
  requestNo: 'RR-2026-1001',
  equipmentModelId: 300001,
  equipmentModelCode: 'ASML-XT',
  equipmentModelName: 'ASML XT',
  closedAt: '2026-10-02T00:00:00.000Z',
  sourceChangedSinceDraft: false,
  sourceConfirmation: 'a'.repeat(64),
  sourcePreview: sourcePreviewFixture,
  report: null,
};

const CANDIDATE = {
  conversationId: 700001,
  contentVersion: 3,
  lastMessageSeq: 5,
  effectiveReplyCount: 2,
  createdAt: '2026-09-30T00:00:00.000Z',
  completedAt: '2026-10-01T00:00:00.000Z',
};

function editableReport(aiFields: Record<string, unknown> = {}) {
  return {
    canEdit: true,
    report: {
      id: 960001,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: 955001,
      status: 'DRAFT',
      title: null,
      customerFactoryName: '某封测厂',
      equipmentModelId: 300001,
      equipmentModelText: null,
      maintenanceDate: '2026-10-02',
      engineerName: '李工',
      handlingResult: 'FIXED',
      closureReason: null,
      resetResult: 'NORMAL',
      actualCause: null,
      repairActions: null,
      verificationResult: null,
      supplementaryNote: null,
      currentVersionNo: 0,
      updatedAt: '2026-10-03T00:00:00.000Z',
      aiUsage: 'NOT_USED',
      aiSourceType: null,
      aiSourceId: null,
      aiSourceVersion: null,
      aiScore: null,
      aiCorrectness: null,
      aiHelpfulness: null,
      aiNote: null,
      ...aiFields,
    },
    attachments: [],
    steps: [],
    faults: [],
    alarms: [],
  } as never;
}

function renderPage(entryOverrides: Record<string, unknown> = {}) {
  fetchMyWorkOrderSummaryMock.mockResolvedValue({ ...entryFixture, ...entryOverrides });
  render(
    <WorkOrderSummaryReviewPage
      downloadSourceFile={downloadSourceFileMock}
      repairRequestId={955001}
    />,
  );
}

describe('WorkOrderSummaryReviewPage（只读核对，一次正式提交）', () => {
  beforeEach(() => {
    fetchMyWorkOrderSummaryMock.mockReset();
    downloadSourceFileMock.mockReset();
    createDraftMock.mockReset();
    updateDraftMock.mockReset();
    submitReportMock.mockReset();
    exportMaintenanceReportMock.mockReset();
    fetchAiConversationsMock.mockReset();
    navigateMock.mockReset();
    // 默认：服务端确认没有可用会话（空列表 = 确认无会话，不是查询失败）
    fetchAiConversationsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('只读展示服务端预览事实：维修内容/客户原始报修/处理结果/来源原件', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText('RR-2026-1001').length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(
        screen.getAllByText('服务端确认本工单没有可用的 AI 辅助排查会话。').length,
      ).toBeGreaterThan(0);
    });
    // 预览事实（sourcePreview）渲染的维修内容与两份原件/报修信息
    expect(screen.getAllByText('重新插拔线缆').length).toBeGreaterThan(0);
    expect(screen.getAllByText('维修原件.pdf').length).toBeGreaterThan(0);
    expect(screen.getAllByText('上片失败').length).toBeGreaterThan(0);
    expect(screen.getAllByText('某封测厂').length).toBeGreaterThan(0);
    expect(screen.getAllByText('维修完成').length).toBeGreaterThan(0);
    // 真实调用路径：只读取一次 myWorkOrderSummary（预览与校验同源，无第二份详情读取）
    expect(fetchMyWorkOrderSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('不出现「保存草稿」与建稿/改稿调用，也不出现新上传原件入口', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText('RR-2026-1001').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: '保存草稿' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加附件' })).toBeNull();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '正式提交' }).length).toBeGreaterThan(0);
    });
    expect(createDraftMock).not.toHaveBeenCalled();
    expect(updateDraftMock).not.toHaveBeenCalled();
  });

  it('无草稿一次正式提交：携带 sourceConfirmation 与提交标识，draft 不含内容字段', async () => {
    renderPage();

    // AI 候选查询就绪（确认无会话）后提交按钮才可用
    const submitButton = await screen.findByRole('button', { name: '正式提交' });
    await waitFor(() => {
      expect((submitButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(submitButton);
    await waitFor(() => {
      expect(submitReportMock).toHaveBeenCalledTimes(1);
    });
    const submitParams = submitReportMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(submitParams).toMatchObject({
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: 955001,
      reportId: null,
      expectedVersionNo: null,
      sourceConfirmation: 'a'.repeat(64),
      attachment: null,
    });
    expect(submitParams.draft).toEqual({});
    expect(typeof submitParams.submissionRequestId).toBe('string');
  });

  it('已有总结草稿兼容读取：重新核对后可直接提交（携带 reportId 与冻结版本）', async () => {
    renderPage({ report: editableReport() });

    const submitButton = await screen.findByRole('button', { name: '正式提交' });
    // 等待提交按钮可用（AI 查询 loading 态同样禁用，直接点击会被吞掉）
    await waitFor(() => {
      expect((submitButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(submitButton);
    await waitFor(() => {
      expect(submitReportMock).toHaveBeenCalledTimes(1);
    });
    expect(submitReportMock.mock.calls[0]?.[0]).toMatchObject({
      sourceType: 'WORK_ORDER_SUMMARY',
      reportId: 960001,
      expectedVersionNo: 0,
    });
    expect(createDraftMock).not.toHaveBeenCalled();
    expect(updateDraftMock).not.toHaveBeenCalled();
  });

  it('AI 查询失败：提交被禁止（不得按无会话提交），错误如实展示', async () => {
    fetchAiConversationsMock.mockRejectedValue(new Error('network down'));
    renderPage();

    expect(await screen.findByText('无法读取 AI 辅助排查会话。')).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '正式提交' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    expect(submitReportMock).not.toHaveBeenCalled();
  });

  it('存在适用会话未选择：提交禁止；选择会话后可提交并携带 USED 评价组', async () => {
    fetchAiConversationsMock.mockResolvedValue([CANDIDATE]);
    renderPage({ report: editableReport() });

    await waitFor(() => {
      expect((screen.getByRole('button', { name: '正式提交' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    expect(
      await screen.findByText('该工单存在可评价的 AI 辅助排查会话，请选择会话并填写评价后再提交。'),
    ).toBeTruthy();

    const select = screen.getByLabelText('选择评价的 AI 会话');
    fireEvent.mouseDown(select);
    // 会话编号用拼接构造：裸写「井号+编号」会被 lint-colors 误判为十六进制颜色
    fireEvent.click(await screen.findByText(new RegExp('会话 #' + 700001 + ' · 内容版本 v3')));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '正式提交' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: '正式提交' }));
    await waitFor(() => {
      expect(submitReportMock).toHaveBeenCalledTimes(1);
    });
    expect(submitReportMock.mock.calls[0]?.[0]).toMatchObject({
      draft: {
        aiUsage: 'USED',
        aiSourceType: 'AI_CONVERSATION',
        aiSourceId: '700001',
        aiSourceVersion: '3',
      },
    });
  });

  it('确认无会话（空列表）：不需要评分即可提交', async () => {
    renderPage();

    await waitFor(() => {
      expect((screen.getByRole('button', { name: '正式提交' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: '正式提交' }));
    await waitFor(() => {
      expect(submitReportMock).toHaveBeenCalledTimes(1);
    });
    expect(submitReportMock.mock.calls[0]?.[0]).toMatchObject({ draft: {} });
  });

  it('未知错误：通用文案兜底，不显示原始异常，也不显示「刷新并重新核对」，评价保留', async () => {
    submitReportMock.mockRejectedValueOnce(new Error('conflict'));
    renderPage();

    const submitButton = await screen.findByRole('button', { name: '正式提交' });
    // 等待提交按钮可用（AI 查询 loading 态同样禁用，直接点击会被吞掉）
    await waitFor(() => {
      expect((submitButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(submitButton);
    // 非 GraphQL 入口错误走通用失败文案；普通失败不提供重新核对入口
    expect(await screen.findByText('正式提交失败，请使用原提交重试或检查网络。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '刷新并重新核对' })).toBeNull();

    // 再次提交仍携带同一提交标识（幂等重试），且服务端事实未被重复读取
    fireEvent.click(screen.getByRole('button', { name: /正式提交/ }));
    await waitFor(() => {
      expect(submitReportMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMyWorkOrderSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('已知业务错误：展示后端可操作文案，不显示「刷新并重新核对」，已填评价保留', async () => {
    fetchAiConversationsMock.mockResolvedValue([CANDIDATE]);
    submitReportMock.mockRejectedValueOnce(
      new GraphQLIngressError({
        type: 'graphql',
        message: 'graphql error',
        graphqlErrors: [
          {
            message: 'graphql error',
            extensions: {
              code: 'BAD_USER_INPUT',
              errorCode: 'MAINTENANCE_REPORT_INVALID_PARAMS',
              errorMessage: '提交前必须填写维修日期',
            },
          },
        ],
      }),
    );
    renderPage();

    // 选择会话并填写评价说明，模拟用户已填评价内容
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '正式提交' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    // 锁定 AI 区已就绪（提交按钮在查询 loading 态同样禁用，仅凭 disabled 无法区分），
    // 与「存在适用会话未选择」用例同模式，避免全量并发下在 loading 态提前取 Select
    expect(
      await screen.findByText('该工单存在可评价的 AI 辅助排查会话，请选择会话并填写评价后再提交。'),
    ).toBeTruthy();
    const select = screen.getByLabelText('选择评价的 AI 会话');
    fireEvent.mouseDown(select);
    // 会话编号用拼接构造：裸写「井号+编号」会被 lint-colors 误判为十六进制颜色
    fireEvent.click(await screen.findByText(new RegExp('会话 #' + 700001 + ' · 内容版本 v3')));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '正式提交' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: '正式提交' }));

    // 已知业务错误如实展示可操作文案；普通业务失败不提供重新核对入口
    expect(await screen.findByText('提交前必须填写维修日期')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '刷新并重新核对' })).toBeNull();

    // 评价保留：再次提交仍携带 USED 评价组
    submitReportMock.mockResolvedValueOnce({
      reportId: 960001,
      versionId: 1,
      versionNo: 1,
      status: 'SUBMITTED',
      submissionRequestId: 'stub',
      referenceDocumentId: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: /正式提交/ }));
    await waitFor(() => {
      expect(submitReportMock).toHaveBeenCalledTimes(2);
    });
    expect(submitReportMock.mock.calls[1]?.[0]).toMatchObject({
      draft: { aiUsage: 'USED', aiSourceId: '700001' },
    });
  });

  it('来源冲突错误：展示可操作文案并提供「刷新并重新核对」，点击后重新读取服务端事实', async () => {
    submitReportMock.mockRejectedValueOnce(
      new GraphQLIngressError({
        type: 'graphql',
        message: 'graphql error',
        graphqlErrors: [
          {
            message: 'graphql error',
            extensions: {
              code: 'CONFLICT',
              errorCode: 'MAINTENANCE_REPORT_SUBMISSION_VERSION_CONFLICT',
              errorMessage: '展示版本已变化，请刷新后重新核对',
            },
          },
        ],
      }),
    );
    renderPage();

    const submitButton = await screen.findByRole('button', { name: '正式提交' });
    // 等待提交按钮可用（AI 查询 loading 态同样禁用，直接点击会被吞掉）
    await waitFor(() => {
      expect((submitButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(submitButton);
    expect(await screen.findByText('展示版本已变化，请刷新后重新核对')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '刷新并重新核对' }));
    await waitFor(() => {
      expect(fetchMyWorkOrderSummaryMock).toHaveBeenCalledTimes(2);
    });
  });

  it('导出已知业务错误：展示后端可操作文案', async () => {
    exportMaintenanceReportMock.mockRejectedValueOnce(
      new GraphQLIngressError({
        type: 'graphql',
        message: 'graphql error',
        graphqlErrors: [
          {
            message: 'graphql error',
            extensions: {
              code: 'BAD_USER_INPUT',
              errorCode: 'MAINTENANCE_REPORT_INVALID_PARAMS',
              errorMessage: '提交前必须填写维修日期',
            },
          },
        ],
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: '导出 Word' }));
    expect(await screen.findByText('提交前必须填写维修日期')).toBeTruthy();
  });

  it('提交标识失败重试沿用：同一次失败后再次提交不换新标识', async () => {
    submitReportMock.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({
      reportId: 960001,
      versionId: 1,
      versionNo: 1,
      status: 'SUBMITTED',
      submissionRequestId: 'stub',
      referenceDocumentId: 1,
    });
    renderPage();

    const submitButton = await screen.findByRole('button', { name: '正式提交' });
    // 等待提交按钮可用（AI 查询 loading 态同样禁用，直接点击会被吞掉）
    await waitFor(() => {
      expect((submitButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(submitButton);
    await waitFor(() => {
      expect(submitReportMock).toHaveBeenCalledTimes(1);
    });
    const firstId = (submitReportMock.mock.calls[0]?.[0] as Record<string, unknown>)
      .submissionRequestId;
    // 提交结束后按钮恢复可点（loading 态可访问名含 spinner 图标，用正则定位）
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /正式提交/ }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: /正式提交/ }));
    await waitFor(() => {
      expect(submitReportMock).toHaveBeenCalledTimes(2);
    });
    expect(submitReportMock.mock.calls[1]?.[0]).toMatchObject({ submissionRequestId: firstId });
  });

  it('来源工单修订（sourceChangedSinceDraft）：展示重新核对提示', async () => {
    renderPage({ sourceChangedSinceDraft: true });

    expect(
      await screen.findByText(
        '来源工单在保存草稿后已被修订，请重新核对内容并重新保存总结后再提交。',
      ),
    ).toBeTruthy();
  });

  it('来源工单原件授权下载失败时展示服务端文案', async () => {
    renderPage();
    downloadSourceFileMock.mockResolvedValue({
      ok: false,
      message: '当前账号无原件下载权限',
    });

    const downloadButtons = await screen.findAllByRole('button', { name: '下载原件' });
    fireEvent.click(downloadButtons[0] as HTMLElement);
    expect(await screen.findByText('当前账号无原件下载权限')).toBeTruthy();
  });

  it('AI 查询进行中（loading）：提交禁止', async () => {
    let resolveAi: ((items: unknown[]) => void) | undefined;
    fetchAiConversationsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveAi = resolve;
      }),
    );
    renderPage();

    await waitFor(() => {
      expect((screen.getByRole('button', { name: '正式提交' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    resolveAi?.([]);
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '正式提交' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });
});
