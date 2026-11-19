// src/features/repair-request/ui/engineer-repair-legacy-process-section.spec.tsx
// @vitest-environment jsdom

/**
 * 旧维修历史（只读）回归：
 * - 展示旧操作、测试事实、时间与已绑定原件；
 * - 只走既有授权下载入口，不提供新增/编辑/改绑/删除；
 * - 无旧过程时不渲染任何区块；
 * - 下载失败按既有错误文案展示，不静默吞掉。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { translate } from '@/shared/i18n';

import type { EngineerRepairProcessEntry } from '../infrastructure/engineer-repair-request.types';

import { EngineerRepairLegacyProcessSection } from './engineer-repair-legacy-process-section';

const { downloadMock, clearErrorMock } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  clearErrorMock: vi.fn(),
}));

const downloadState = {
  downloadingFileId: null as string | null,
  error: null as string | null,
};

vi.mock('../application/use-repair-original-download', () => ({
  useRepairOriginalDownload: () => ({
    downloadingFileId: downloadState.downloadingFileId,
    error: downloadState.error,
    download: downloadMock,
    clearError: clearErrorMock,
  }),
}));

const ENTRY: EngineerRepairProcessEntry = {
  id: '101',
  entryUuid: '4f0c5f6a-1111-4111-8111-111111111111',
  requestId: 21,
  operationText: '更换干涉仪镜片',
  testResult: '复测通过，误差 0.02mm',
  occurredAt: '2026-11-14T03:00:00.000Z',
  timeSource: 'MANUAL',
  fileId: 'file-1',
  file: {
    fileId: 'file-1',
    originalFilename: '现场照片.jpg',
    mimeType: 'image/jpeg',
    byteSize: 2048,
    checksumSha256: 'abcdef1234567890',
  },
  versionNo: 2,
  createdAt: '2026-11-14T03:05:00.000Z',
};

beforeEach(() => {
  downloadMock.mockReset();
  clearErrorMock.mockReset();
  downloadState.downloadingFileId = null;
  downloadState.error = null;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:legacy-demo'),
    revokeObjectURL: vi.fn(),
  });
});

describe(EngineerRepairLegacyProcessSection.name, () => {
  it('展示旧操作、测试事实、时间与已绑定原件，不提供任何写入口', () => {
    render(<EngineerRepairLegacyProcessSection processEntries={[ENTRY]} />);

    expect(screen.getByText('更换干涉仪镜片')).toBeTruthy();
    expect(screen.getByText(/复测通过，误差 0\.02mm/)).toBeTruthy();
    expect(screen.getByText('人工时间')).toBeTruthy();
    expect(screen.getByText('已保存绑定')).toBeTruthy();
    expect(screen.getByText('现场照片.jpg')).toBeTruthy();
    expect(screen.getByText(translate('zh-CN', 'engineerDetail.legacyProcessHint'))).toBeTruthy();

    // 只读历史：没有编辑、新增、删除、改绑入口
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: /新增维修过程|保存/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /移除暂存/ })).toBeNull();
  });

  it('走既有授权下载入口下载已绑定原件', async () => {
    downloadMock.mockResolvedValue({
      ok: true,
      blob: new Blob(['legacy']),
      filename: '现场照片.jpg',
    });

    render(<EngineerRepairLegacyProcessSection processEntries={[ENTRY]} />);
    fireEvent.click(screen.getByRole('button', { name: '下载原件' }));

    expect(downloadMock).toHaveBeenCalledWith('file-1');
    expect(clearErrorMock).toHaveBeenCalled();
  });

  it('授权下载被服务端拒绝时展示失败文案', async () => {
    // 真实 hook 会把失败结果落到 error；桩保持同一契约（结果 + error 一并给出）
    downloadState.error = '当前账号无原件下载权限';
    downloadMock.mockResolvedValue({
      ok: false,
      reason: 'insufficient-permission',
      message: '当前账号无原件下载权限',
    });

    render(<EngineerRepairLegacyProcessSection processEntries={[ENTRY]} />);
    fireEvent.click(screen.getByRole('button', { name: '下载原件' }));

    expect(downloadMock).toHaveBeenCalledWith('file-1');
    expect(screen.getByText('当前账号无原件下载权限')).toBeTruthy();
  });

  it('没有旧过程时整块不渲染', () => {
    const { container } = render(<EngineerRepairLegacyProcessSection processEntries={[]} />);

    expect(container.firstChild).toBeNull();
  });
});
