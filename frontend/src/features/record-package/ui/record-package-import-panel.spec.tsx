// src/features/record-package/ui/record-package-import-panel.spec.tsx

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RecordPackageImportPanel } from './record-package-import-panel';

const checkRecordPackage = vi.fn();
const importRecordPackage = vi.fn();

vi.mock('@/features/record-package/infrastructure/record-package-adapter', () => ({
  checkRecordPackage: (...args: unknown[]) => checkRecordPackage(...args),
  importRecordPackage: (...args: unknown[]) => importRecordPackage(...args),
}));

const CHECK_RESULT = {
  outcome: 'checked',
  import: {
    packageId: 'pkg-1',
    organizationId: 9,
    importedByAccountId: 900101,
    manifestChecksum: 'a'.repeat(64),
    status: 'PENDING',
    checkStatus: 'PASSED',
    itemTotal: 1,
    itemSucceeded: 0,
    itemFailed: 0,
    createdAt: '2026-11-22T00:00:00.000Z',
    completedAt: null,
  },
  items: [
    {
      itemId: 'item-1',
      packageId: 'pkg-1',
      recordUuid: '11111111-2222-4333-8444-555555555555',
      resourceType: 'MAINTENANCE_REPORT',
      versionNo: 2,
      checkResult: 'PASSED',
      result: null,
      receiptId: null,
      errorMessage: null,
      createdAt: '2026-11-22T00:00:00.000Z',
    },
  ],
};

describe('记录包导入面板', () => {
  it('预检通过后才出现确认入口，确认后展示逐条结果', async () => {
    checkRecordPackage.mockResolvedValue(CHECK_RESULT);
    importRecordPackage.mockResolvedValue({
      import: { ...CHECK_RESULT.import, status: 'SUCCEEDED', itemSucceeded: 1 },
      items: [{ ...CHECK_RESULT.items[0], result: 'SUCCEEDED' }],
    });

    render(<RecordPackageImportPanel />);

    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/pkg' },
    });
    fireEvent.click(screen.getByRole('button', { name: '安全检查' }));

    await waitFor(() => {
      expect(checkRecordPackage).toHaveBeenCalledWith('/mnt/usb/pkg');
    });
    expect(await screen.findByRole('button', { name: '确认导入' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    // AntD 弹层挂在 document.body 上：只取可见 Popconfirm 内的确认按钮
    const confirmButton = await waitFor(() => {
      const buttons = Array.from(
        document.querySelectorAll('.ant-popover:not(.ant-popover-hidden)'),
      ).flatMap((popover) =>
        Array.from(popover.querySelectorAll('.ant-popconfirm-buttons .ant-btn-primary')),
      );
      expect(buttons.length).toBeGreaterThan(0);
      return buttons[0];
    });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(importRecordPackage).toHaveBeenCalledWith({
        packageId: 'pkg-1',
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: 'a'.repeat(64),
      });
    });
    expect(await screen.findByText(/导入完成/)).toBeTruthy();
  });

  it('预检未通过时不提供确认入口', async () => {
    checkRecordPackage.mockResolvedValue({
      ...CHECK_RESULT,
      import: { ...CHECK_RESULT.import, checkStatus: 'REJECTED' },
    });

    render(<RecordPackageImportPanel />);

    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/pkg' },
    });
    fireEvent.click(screen.getByRole('button', { name: '安全检查' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认导入' })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: '确认导入' })).toHaveProperty('disabled', true);
  });
});
