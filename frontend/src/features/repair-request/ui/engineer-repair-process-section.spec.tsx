// src/features/repair-request/ui/engineer-repair-process-section.spec.tsx
// @vitest-environment jsdom

/**
 * 内部维修过程分区交互回归（任务 04 编辑补传原件）：
 * 只验证 UI 取舍与入参流向，真实上传/保存/回读时序由 workbench hook 单测覆盖。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { translate } from '@/shared/i18n';

import type {
  EngineerRepairProcessEntry,
  RepairProcessWriteResult,
  StagedRepairProcessFile,
} from '../infrastructure/engineer-repair-request.types';

import {
  EngineerRepairCloseSection,
  EngineerRepairProcessSection,
} from './engineer-repair-process-section';

const { hookMock } = vi.hoisted(() => ({
  hookMock: {
    stagedFile: null as StagedRepairProcessFile | null,
    uploading: false,
    saving: false,
    lastProcessResult: null as RepairProcessWriteResult | null,
    uploadFile: vi.fn(),
    clearStagedFile: vi.fn(),
    saveProcess: vi.fn(),
    downloadFile: vi.fn(),
    beginEditScope: vi.fn(),
    closing: false,
    lastCloseResult: null as null,
    lastInterruptResult: null as null,
    closeReadbackFailed: false,
    closeReadbackRetrying: false,
    closeRequest: vi.fn(),
    interruptRequest: vi.fn(),
    retryCloseReadback: vi.fn(),
  },
}));

vi.mock('../application/use-engineer-repair-process-workbench', () => ({
  useEngineerRepairProcessWorkbench: () => hookMock,
}));

const reload = vi.fn().mockResolvedValue(undefined);

const ENTRY_WITH_FILE: EngineerRepairProcessEntry = {
  id: '101',
  entryUuid: '4f0c5f6a-1111-4111-8111-111111111111',
  requestId: 21,
  operationText: '更换干涉仪镜片',
  testResult: null,
  occurredAt: null,
  timeSource: 'SERVER',
  fileId: 'file-1',
  file: {
    fileId: 'file-1',
    originalFilename: '现场照片.jpg',
    mimeType: 'image/jpeg',
    byteSize: 2048,
    checksumSha256: 'abcdef1234567890',
  },
  versionNo: 2,
  createdAt: '2026-11-14T03:00:00.000Z',
};

const ENTRY_WITHOUT_FILE: EngineerRepairProcessEntry = {
  ...ENTRY_WITH_FILE,
  id: '102',
  entryUuid: '5f0c5f6a-2222-4222-8222-222222222222',
  operationText: '补录历史过程',
  fileId: null,
  file: null,
  versionNo: 1,
};

const STAGED_FILE: StagedRepairProcessFile = {
  fileId: 'file-2',
  uploadContextId: 'context-2',
  originalFilename: 'new-photo.jpg',
  mimeType: 'image/jpeg',
  byteSize: 512,
  checksumSha256: 'fedcba',
};

function renderSection(processEntries: EngineerRepairProcessEntry[]) {
  return render(
    <EngineerRepairProcessSection
      canWrite
      processEntries={processEntries}
      readOnly={false}
      reload={reload}
      requestId={21}
    />,
  );
}

beforeEach(() => {
  hookMock.stagedFile = null;
  hookMock.uploading = false;
  hookMock.saving = false;
  hookMock.lastProcessResult = null;
  hookMock.uploadFile.mockReset();
  hookMock.clearStagedFile.mockReset();
  hookMock.saveProcess.mockReset();
  hookMock.downloadFile.mockReset();
  hookMock.downloadFile.mockResolvedValue({
    ok: true,
    blob: new Blob(['demo']),
    filename: '现场照片.jpg',
  });
  hookMock.beginEditScope.mockReset();
  hookMock.closing = false;
  hookMock.lastCloseResult = null;
  hookMock.lastInterruptResult = null;
  hookMock.closeReadbackFailed = false;
  hookMock.closeReadbackRetrying = false;
  hookMock.closeRequest.mockReset();
  hookMock.interruptRequest.mockReset();
  hookMock.retryCloseReadback.mockReset();
  reload.mockClear();
});

describe(EngineerRepairProcessSection.name, () => {
  it('无原件过程进入编辑可上传；已有原件过程编辑只读且不提供替换/移除', () => {
    const { container } = renderSection([ENTRY_WITH_FILE, ENTRY_WITHOUT_FILE]);

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    expect(screen.getByText('编辑维修过程')).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByText(/如需追加另一份原件请新建过程记录/)).toBeTruthy();
    expect(screen.queryByText('移除')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);

    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    expect(screen.getByText('补传原件（可选）')).toBeTruthy();

    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [new File(['demo'], 'new-photo.jpg')] },
    });
    expect(hookMock.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('已有原件的过程进入编辑前先拦截暂存原件，避免静默丢弃', () => {
    hookMock.stagedFile = STAGED_FILE;
    renderSection([ENTRY_WITH_FILE]);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    expect(screen.getByText(/已有暂存原件/)).toBeTruthy();
    expect(screen.queryByText('编辑维修过程')).toBeNull();
    expect(hookMock.beginEditScope).not.toHaveBeenCalled();
  });

  it('无原件过程携带暂存原件进入编辑：显式展示暂存并切换编辑作用域', () => {
    hookMock.stagedFile = STAGED_FILE;
    renderSection([ENTRY_WITHOUT_FILE]);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    expect(screen.getByText('编辑维修过程')).toBeTruthy();
    expect(screen.getByText('已上传暂存')).toBeTruthy();
    expect(screen.getByText('new-photo.jpg')).toBeTruthy();
    expect(hookMock.beginEditScope).toHaveBeenCalledWith('102');
  });

  it('上传区提示真实格式与大小限制，非法类型与超限文件在本地拦截', () => {
    renderSection([ENTRY_WITHOUT_FILE]);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    expect(screen.getByText(/支持 PDF \/ Word \/ Excel \/ PPT \/ 图片/)).toBeTruthy();
    expect(screen.getByText(/单个文件不超过\s*20 MB/)).toBeTruthy();
    const fileInput = screen.getByLabelText('选择过程原件') as HTMLInputElement;

    fireEvent.change(fileInput, {
      target: { files: [new File(['demo'], 'malware.exe')] },
    });
    expect(screen.getByText(/不支持该文件类型/)).toBeTruthy();
    expect(hookMock.uploadFile).not.toHaveBeenCalled();

    const oversized = new File(['demo'], 'big.pdf');
    Object.defineProperty(oversized, 'size', { value: 20_000_001 });
    fireEvent.change(fileInput, { target: { files: [oversized] } });
    expect(screen.getByText(/原件不能超过 20 MB/)).toBeTruthy();
    expect(hookMock.uploadFile).not.toHaveBeenCalled();
  });

  it('已绑定原件在过程列表只读展示且可下载', () => {
    renderSection([ENTRY_WITH_FILE]);

    expect(screen.getByText('已保存绑定')).toBeTruthy();
    expect(screen.getByText('现场照片.jpg')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下载原件' }));
    expect(hookMock.downloadFile).toHaveBeenCalledWith('file-1');
  });

  it('版本冲突时保留用户输入并展示刷新提示', async () => {
    const conflict: RepairProcessWriteResult = {
      ok: false,
      reason: 'conflict',
      message: '维修过程已被修改，请刷新后重试',
    };
    hookMock.saveProcess.mockImplementation(async () => {
      hookMock.lastProcessResult = conflict;
      return conflict;
    });
    const view = renderSection([ENTRY_WITHOUT_FILE]);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const textarea = screen.getByPlaceholderText('记录实际执行的操作…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '冲突后仍需保留的输入' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(hookMock.saveProcess).toHaveBeenCalledTimes(1));
    view.rerender(
      <EngineerRepairProcessSection
        canWrite
        processEntries={[ENTRY_WITHOUT_FILE]}
        readOnly={false}
        reload={reload}
        requestId={21}
      />,
    );

    expect(textarea.value).toBe('冲突后仍需保留的输入');
    expect(screen.getByText('维修过程已被修改，请刷新后重试')).toBeTruthy();
    expect(screen.getByRole('button', { name: '刷新详情' })).toBeTruthy();
  });
});

describe(EngineerRepairCloseSection.name, () => {
  const closeProps = {
    requestId: 21,
    scopeKey: '21',
    canWrite: true,
    reload,
    closedByMutation: false,
    maintenanceDraft: { hasUnsavedChanges: false, writePending: false },
    onCloseSucceeded: vi.fn(),
    onCloseReadbackSucceeded: vi.fn(),
  };

  async function selectHandlingResult() {
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('故障修复'));
  }

  it('维修版本缺失：确认后阻止提交并提示刷新，不假装是 0', async () => {
    render(<EngineerRepairCloseSection {...closeProps} maintenanceVersionNo={null} />);

    await selectHandlingResult();
    fireEvent.click(screen.getByRole('button', { name: /结\s*单/ }));
    fireEvent.click(await screen.findByRole('button', { name: '确认结单' }));

    expect(
      await screen.findByText('维修记录版本尚未就绪，请刷新详情后重新确认结单。'),
    ).toBeTruthy();
    expect(hookMock.closeRequest).not.toHaveBeenCalled();
  });

  it('确认打开后详情版本变化：仍提交打开时捕获的版本（0 合法）', async () => {
    const view = render(<EngineerRepairCloseSection {...closeProps} maintenanceVersionNo={0} />);

    await selectHandlingResult();
    fireEvent.click(screen.getByRole('button', { name: /结\s*单/ }));

    // 确认框已打开后，后台详情推进到新版本
    view.rerender(<EngineerRepairCloseSection {...closeProps} maintenanceVersionNo={5} />);
    fireEvent.click(await screen.findByRole('button', { name: '确认结单' }));

    await waitFor(() => expect(hookMock.closeRequest).toHaveBeenCalledWith('FIXED', null, 0));
  });

  it('有未保存维修内容：打开确认前即拦截，只提示且不发结单请求', async () => {
    render(
      <EngineerRepairCloseSection
        {...closeProps}
        maintenanceDraft={{ hasUnsavedChanges: true, writePending: false }}
        maintenanceVersionNo={1}
      />,
    );

    await selectHandlingResult();
    fireEvent.click(screen.getByRole('button', { name: /结\s*单/ }));

    expect(
      await screen.findByText(
        translate('zh-CN', 'engineerDetail.closeBlockedByUnsavedMaintenance'),
      ),
    ).toBeTruthy();
    // 确认框没有展开，也没有发出任何结单请求
    expect(screen.queryByRole('button', { name: '确认结单' })).toBeNull();
    expect(hookMock.closeRequest).not.toHaveBeenCalled();
  });

  it('确认框已打开后草稿变为未保存：最终确认时再拦截一次，不发结单请求', async () => {
    const view = render(<EngineerRepairCloseSection {...closeProps} maintenanceVersionNo={1} />);

    await selectHandlingResult();
    fireEvent.click(screen.getByRole('button', { name: /结\s*单/ }));
    await screen.findByRole('button', { name: '确认结单' });

    // 用户打开确认后草稿又被改动（例如编辑器仍可交互的场景）
    view.rerender(
      <EngineerRepairCloseSection
        {...closeProps}
        maintenanceDraft={{ hasUnsavedChanges: true, writePending: false }}
        maintenanceVersionNo={1}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '确认结单' }));

    expect(
      await screen.findByText(
        translate('zh-CN', 'engineerDetail.closeBlockedByUnsavedMaintenance'),
      ),
    ).toBeTruthy();
    // 只拦截提交：不记录维修版本、不发结单请求（弹层是否保留 DOM 由 antd 决定）
    expect(hookMock.closeRequest).not.toHaveBeenCalled();
  });

  it('维修记录写入未落定：提示稍后确认，不发结单请求', async () => {
    render(
      <EngineerRepairCloseSection
        {...closeProps}
        maintenanceDraft={{ hasUnsavedChanges: false, writePending: true }}
        maintenanceVersionNo={1}
      />,
    );

    await selectHandlingResult();
    fireEvent.click(screen.getByRole('button', { name: /结\s*单/ }));

    expect(
      await screen.findByText(
        translate('zh-CN', 'engineerDetail.closeBlockedByPendingMaintenance'),
      ),
    ).toBeTruthy();
    expect(hookMock.closeRequest).not.toHaveBeenCalled();
  });
});
