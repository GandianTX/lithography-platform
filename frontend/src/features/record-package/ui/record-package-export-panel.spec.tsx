// src/features/record-package/ui/record-package-export-panel.spec.tsx

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordPackageExportPanel } from './record-package-export-panel';

const exportRecordPackage = vi.fn();

vi.mock('@/features/record-package/infrastructure/record-package-adapter', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/features/record-package/infrastructure/record-package-adapter')
  >()),
  exportRecordPackage: (...args: unknown[]) => exportRecordPackage(...args),
  checkRecordPackage: vi.fn(),
  importRecordPackage: vi.fn(),
}));

const EXPORT_RESULT = {
  packageId: 'pkg-1',
  packagePath: '/mnt/usb/pkg',
  organizationId: 9,
  resourceType: 'REPAIR_REQUEST',
  manifestChecksum: 'a'.repeat(64),
  itemTotal: 1,
  itemExported: 1,
  itemFailed: 0,
  items: [
    {
      recordId: 7,
      recordUuid: 'uuid-1',
      resourceType: 'REPAIR_REQUEST',
      versionNo: 1,
      outcome: 'EXPORTED',
      rejection: null,
      message: null,
    },
  ],
};

describe('记录包导出面板（混合导出入口）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('混合形态：逐条自带记录类型，按 entries 送出', async () => {
    exportRecordPackage.mockResolvedValue(EXPORT_RESULT);

    render(<RecordPackageExportPanel />);

    // 切到混合导出形态
    fireEvent.click(screen.getByRole('radio', { name: '混合导出（逐条带类型）' }));
    // 加一条导出条目
    fireEvent.click(screen.getByRole('button', { name: '添加一条' }));

    // 目标公司数据区与目标目录
    const spinbuttons = screen.getAllByRole('spinbutton');
    fireEvent.change(spinbuttons[0], { target: { value: '9' } });
    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/pkg' },
    });
    // 条目记录 ID（混合形态下逐条自带）
    fireEvent.change(screen.getAllByRole('spinbutton')[1], { target: { value: '7' } });

    fireEvent.click(screen.getByRole('button', { name: '导出到目录' }));

    await waitFor(() => {
      expect(exportRecordPackage).toHaveBeenCalledWith({
        targetPath: '/mnt/usb/pkg',
        organizationId: 9,
        // 混合形态下 resourceType 只是契约占位，服务端以 entries 为准
        resourceType: 'REPAIR_REQUEST',
        recordIds: [],
        entries: [{ resourceType: 'REPAIR_REQUEST', recordId: 7 }],
      });
    });
  });

  it('混合形态：没有条目时不给导出（失败关闭，不发空包请求）', () => {
    render(<RecordPackageExportPanel />);

    fireEvent.click(screen.getByRole('radio', { name: '混合导出（逐条带类型）' }));

    expect(screen.getByRole('button', { name: '导出到目录' })).toHaveProperty('disabled', true);
    expect(exportRecordPackage).not.toHaveBeenCalled();
  });

  it('单一形态：保持旧口径（不带 entries）', async () => {
    exportRecordPackage.mockResolvedValue(EXPORT_RESULT);

    render(<RecordPackageExportPanel />);

    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '9' } });
    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/pkg' },
    });
    // 记录 ID 列表（tags 输入）
    const tagsInput = screen.getAllByRole('combobox')[1];
    fireEvent.change(tagsInput, { target: { value: '12' } });
    fireEvent.keyDown(tagsInput, { key: 'Enter', keyCode: 13, which: 13 });

    fireEvent.click(screen.getByRole('button', { name: '导出到目录' }));

    await waitFor(() => {
      expect(exportRecordPackage).toHaveBeenCalledWith({
        targetPath: '/mnt/usb/pkg',
        organizationId: 9,
        resourceType: 'REPAIR_REQUEST',
        recordIds: [12],
      });
    });
  });
});
