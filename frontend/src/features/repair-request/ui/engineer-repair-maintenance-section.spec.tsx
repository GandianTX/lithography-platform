// src/features/repair-request/ui/engineer-repair-maintenance-section.spec.tsx
// @vitest-environment jsdom

// 结构化维修记录分区：聚焦本轮调整的入口、卡片、再次编辑与失败/只读取舍。
// 编排 hook、下载 hook 与共享编辑器均桩掉，避免触碰真实 GraphQL 与表单细节。
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { translate } from '@/shared/i18n';

import type { EngineerRepairRequestDetail } from '../infrastructure/engineer-repair-request.types';

import { EngineerRepairMaintenanceSection } from './engineer-repair-maintenance-section';

const { workbenchMock, saveMock, retryReadbackMock } = vi.hoisted(() => ({
  workbenchMock: vi.fn(),
  saveMock: vi.fn(),
  retryReadbackMock: vi.fn(),
}));

vi.mock('../application/use-repair-maintenance-workbench', () => ({
  useRepairMaintenanceWorkbench: () => workbenchMock(),
}));

vi.mock('../application/use-repair-original-download', () => ({
  useRepairOriginalDownload: () => ({
    downloadingFileId: null,
    error: null,
    download: vi.fn(),
    clearError: vi.fn(),
  }),
}));

vi.mock('@/shared/ui/maintenance-record-editor', () => ({
  MaintenanceRecordEditor: ({
    onChange,
    value,
    engineerNameReadOnly,
  }: {
    onChange: (next: Record<string, unknown>) => void;
    value: Record<string, unknown> & { engineerName: string };
    engineerNameReadOnly?: boolean;
  }) => (
    <div data-testid="maintenance-editor" data-readonly={String(engineerNameReadOnly)}>
      <input
        aria-label="维修工程师输入"
        onChange={(event) => onChange({ ...value, engineerName: event.target.value })}
        value={value.engineerName}
      />
    </div>
  ),
}));

type WorkbenchState = {
  stagedFile: File | null;
  uploading: boolean;
  uploadError: string | null;
  saving: boolean;
  lastResult: { ok: true; record: unknown } | { ok: false; reason: string; message: string } | null;
  readbackFailed: boolean;
  retryingReadback: boolean;
  uploadAttachment: ReturnType<typeof vi.fn>;
  clearStagedAttachment: ReturnType<typeof vi.fn>;
  saveMaintenance: typeof saveMock;
  retryReadback: typeof retryReadbackMock;
};

function baseWorkbench(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    stagedFile: null,
    uploading: false,
    uploadError: null,
    saving: false,
    lastResult: null,
    readbackFailed: false,
    retryingReadback: false,
    uploadAttachment: vi.fn(),
    clearStagedAttachment: vi.fn(),
    saveMaintenance: saveMock,
    retryReadback: retryReadbackMock,
    ...overrides,
  };
}

function makeDetail(
  overrides: Partial<EngineerRepairRequestDetail> = {},
): EngineerRepairRequestDetail {
  return {
    id: 123,
    requestNo: 'RR-20260902-001',
    errorCode: 'E-0001',
    faultDescription: '光刻机对准模块异常。',
    contentMd: '',
    createdAt: '2026-09-02T08:00:00.000Z',
    isAccepted: true,
    acceptedAt: '2026-09-02T09:00:00.000Z',
    latestResolutionStatus: null,
    equipmentModel: { id: 1, modelCode: 'LITHO-100', modelName: '样例光刻机' },
    customerNickname: '林客户',
    customerCompanyName: '林氏精密制造',
    acceptanceViewStatus: 'MINE',
    acceptedEngineerNickname: '陈工',
    closureStatus: 'OPEN',
    closedAt: null,
    closureReason: null,
    handlingResult: null,
    handlingStatus: null,
    processEntries: [],
    responses: [],
    maintenance: null,
    maintenanceSteps: [],
    maintenanceFaultPanels: [],
    ...overrides,
  };
}

function renderSection(
  options: {
    canWrite?: boolean;
    detail?: EngineerRepairRequestDetail;
    readOnly?: boolean;
  } = {},
) {
  const { canWrite = true, detail = makeDetail(), readOnly = false } = options;
  return render(
    <EngineerRepairMaintenanceSection
      canWrite={canWrite}
      detail={detail}
      readOnly={readOnly}
      reload={vi.fn().mockResolvedValue(undefined)}
      requestId={123}
    />,
  );
}

function makeEmptyMaintenanceDetail() {
  return makeDetail({
    maintenance: {
      versionNo: 0,
      maintenanceDate: null,
      engineerName: null,
      resetResult: null,
      supplementaryNote: null,
      attachment: null,
    },
  });
}

describe('工程师结构化维修记录：无记录入口', () => {
  beforeEach(() => {
    workbenchMock.mockReset();
    saveMock.mockReset();
    retryReadbackMock.mockReset();
    workbenchMock.mockReturnValue(baseWorkbench());
  });

  it('无记录且有权限：直接显示新版编辑器，取消后可重新打开', () => {
    renderSection({ detail: makeEmptyMaintenanceDetail() });

    expect(screen.getByLabelText('维修工程师输入')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: translate('zh-CN', 'engineerDetail.maintenanceCancelEdit'),
      }),
    );
    expect(screen.queryByLabelText('维修工程师输入')).toBeNull();
    expect(screen.getByText(translate('zh-CN', 'engineerDetail.maintenanceNoRecord'))).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: translate('zh-CN', 'engineerDetail.maintenanceFill') }),
    );

    expect(screen.getByLabelText('维修工程师输入')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: translate('zh-CN', 'maintenance.save') }),
    ).toBeTruthy();
  });

  it('v0 有可信姓名回填：首屏仍为可填写状态，姓名只读且非空', () => {
    renderSection({
      detail: makeDetail({
        maintenance: {
          versionNo: 0,
          maintenanceDate: null,
          engineerName: '李工',
          resetResult: null,
          supplementaryNote: null,
          attachment: null,
        },
      }),
    });

    expect(screen.getByTestId('maintenance-editor').dataset.readonly).toBe('true');
    expect((screen.getByLabelText('维修工程师输入') as HTMLInputElement).value).toBe('李工');
    expect(
      screen.getByRole('button', { name: translate('zh-CN', 'maintenance.save') }),
    ).toBeTruthy();
  });

  it('已结单：只显示无记录事实，不显示填写入口', () => {
    renderSection({ canWrite: false, readOnly: true });

    expect(screen.getByText(translate('zh-CN', 'engineerDetail.maintenanceNoRecord'))).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: translate('zh-CN', 'engineerDetail.maintenanceFill') }),
    ).toBeNull();
    expect(
      screen.getByText(translate('zh-CN', 'engineerDetail.maintenanceClosedReadOnly')),
    ).toBeTruthy();
  });

  it('首次保存后读回失败：保留重试读取入口，不显示保存按钮', () => {
    workbenchMock.mockReturnValue(
      baseWorkbench({ readbackFailed: true, lastResult: { ok: true, record: {} } }),
    );
    renderSection({ detail: makeEmptyMaintenanceDetail() });

    expect(
      screen.queryByRole('button', { name: translate('zh-CN', 'maintenance.save') }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: translate('zh-CN', 'maintenance.retryReadback') }),
    );
    expect(retryReadbackMock).toHaveBeenCalledOnce();
  });
});

describe('工程师结构化维修记录：保存后卡片与再次编辑', () => {
  const savedDetail = makeDetail({
    maintenance: {
      versionNo: 1,
      maintenanceDate: '2026-09-02',
      engineerName: '陈工',
      resetResult: 'NORMAL',
      supplementaryNote: null,
      attachment: null,
    },
    maintenanceSteps: [
      {
        id: 'step-1',
        stepNo: 1,
        errorCode: 'E-0001',
        partName: '对准模块',
        actionText: '更换备件并复测',
        resultCode: 'RESOLVED',
      },
    ],
    maintenanceFaultPanels: [
      {
        id: 'panel-1',
        panelType: 'INITIAL',
        stepId: null,
        phaseCode: 'PHASE_01',
        mainError: 'E-0001',
        unitError: null,
        source: null,
        errorType: null,
        gpibStatus: null,
        faultStatus: null,
        description: '对准阶段报错',
        action: '检查光路',
      },
    ],
  });

  beforeEach(() => {
    workbenchMock.mockReset();
    saveMock.mockReset();
    retryReadbackMock.mockReset();
    workbenchMock.mockReturnValue(baseWorkbench());
  });

  it('首次保存读回后退出编辑态，以同一张卡片展示服务端记录', async () => {
    saveMock.mockResolvedValue({ ok: true, record: { versionNo: 1 } });
    const view = renderSection();

    fireEvent.change(screen.getByLabelText('维修工程师输入'), {
      target: { value: '陈工' },
    });
    fireEvent.click(screen.getByRole('button', { name: translate('zh-CN', 'maintenance.save') }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));

    // 读回成功：服务端记录版本推进，卡片出现且编辑器退出
    workbenchMock.mockReturnValue(baseWorkbench({ lastResult: { ok: true, record: {} } }));
    view.rerender(
      <EngineerRepairMaintenanceSection
        canWrite={true}
        detail={savedDetail}
        readOnly={false}
        reload={vi.fn().mockResolvedValue(undefined)}
        requestId={123}
      />,
    );

    await waitFor(() => expect(screen.queryByLabelText('维修工程师输入')).toBeNull());
    expect(screen.getByText('陈工')).toBeTruthy();
    expect(
      screen.getByText(
        translate('zh-CN', 'engineerDetail.maintenanceStepCountValue', { count: 1 }),
      ),
    ).toBeTruthy();
    // 摘要默认可见，展开后可见故障面板与排查步骤
    fireEvent.click(
      screen.getByRole('button', { name: translate('zh-CN', 'engineerDetail.maintenanceExpand') }),
    );
    expect(screen.getByText('更换备件并复测')).toBeTruthy();
    expect(screen.getByText('对准阶段报错')).toBeTruthy();
  });

  it('再次编辑以已保存内容初始化，保存失败保留输入与错误提示', async () => {
    saveMock.mockResolvedValue({ ok: false, reason: 'invalid-input', message: '保存失败示例' });
    const view = renderSection({ detail: savedDetail });

    fireEvent.click(
      screen.getByRole('button', { name: translate('zh-CN', 'engineerDetail.maintenanceEdit') }),
    );
    const input = screen.getByLabelText('维修工程师输入') as HTMLInputElement;
    expect(input.value).toBe('陈工');

    fireEvent.change(input, { target: { value: '陈工（改）' } });
    fireEvent.click(screen.getByRole('button', { name: translate('zh-CN', 'maintenance.save') }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));

    workbenchMock.mockReturnValue(
      baseWorkbench({
        lastResult: { ok: false, reason: 'invalid-input', message: '保存失败示例' },
      }),
    );
    view.rerender(
      <EngineerRepairMaintenanceSection
        canWrite={true}
        detail={savedDetail}
        readOnly={false}
        reload={vi.fn().mockResolvedValue(undefined)}
        requestId={123}
      />,
    );

    expect(screen.getByLabelText('维修工程师输入')).toHaveProperty('value', '陈工（改）');
    expect(screen.getByText('保存失败示例')).toBeTruthy();
  });

  it('写入成功但读回失败：退出编辑态，提示「已保存，刷新失败」并提供重试读取', () => {
    workbenchMock.mockReturnValue(
      baseWorkbench({ lastResult: { ok: true, record: {} }, readbackFailed: true }),
    );
    renderSection({ detail: savedDetail });

    expect(screen.getByText(translate('zh-CN', 'maintenance.readbackFailed'))).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: translate('zh-CN', 'maintenance.retryReadback') }),
    );
    expect(retryReadbackMock).toHaveBeenCalledTimes(1);
    // 读回未成功前不提供再次编辑入口，避免重复提交
    expect(
      screen.queryByRole('button', { name: translate('zh-CN', 'engineerDetail.maintenanceEdit') }),
    ).toBeNull();
  });

  it('版本冲突：保留编辑器、输入与刷新入口', () => {
    workbenchMock.mockReturnValue(
      baseWorkbench({
        lastResult: {
          ok: false,
          reason: 'conflict',
          message: translate('zh-CN', 'maintenance.conflict'),
        },
      }),
    );
    renderSection({ detail: savedDetail });

    fireEvent.click(
      screen.getByRole('button', { name: translate('zh-CN', 'engineerDetail.maintenanceEdit') }),
    );
    expect(screen.getByLabelText('维修工程师输入')).toBeTruthy();
    expect(screen.getByText(translate('zh-CN', 'maintenance.conflict'))).toBeTruthy();
    expect(
      screen.getByRole('button', { name: translate('zh-CN', 'maintenance.reloadDetail') }),
    ).toBeTruthy();
  });

  it('已结单：只展示记录，不显示编辑入口', () => {
    renderSection({ canWrite: false, detail: savedDetail, readOnly: true });

    expect(screen.getByText('陈工')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: translate('zh-CN', 'engineerDetail.maintenanceEdit') }),
    ).toBeNull();
    expect(
      screen.getByText(translate('zh-CN', 'engineerDetail.maintenanceClosedReadOnly')),
    ).toBeTruthy();
  });
});
