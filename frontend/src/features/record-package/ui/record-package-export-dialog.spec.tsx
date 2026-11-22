// src/features/record-package/ui/record-package-export-dialog.spec.tsx

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RecordPackageExportDialog } from './record-package-export-dialog';

const exportRecordPackage = vi.fn();

vi.mock('@/features/record-package/infrastructure/record-package-adapter', () => ({
  exportRecordPackage: (...args: unknown[]) => exportRecordPackage(...args),
  checkRecordPackage: vi.fn(),
  importRecordPackage: vi.fn(),
}));

describe('来源页记录包导出对话框', () => {
  it('导出时不带公司（由服务端按可信 session 范围取），并展示逐条结论', async () => {
    exportRecordPackage.mockResolvedValue({
      packageId: 'pkg-1',
      packagePath: '/mnt/usb/pkg',
      organizationId: 9,
      resourceType: 'MAINTENANCE_REPORT',
      manifestChecksum: 'a'.repeat(64),
      itemTotal: 2,
      itemExported: 1,
      itemFailed: 1,
      items: [
        {
          recordId: 12,
          recordUuid: 'uuid-1',
          resourceType: 'MAINTENANCE_REPORT',
          versionNo: 1,
          outcome: 'EXPORTED',
          rejection: null,
          message: null,
        },
        {
          recordId: 13,
          recordUuid: 'uuid-2',
          resourceType: 'MAINTENANCE_REPORT',
          versionNo: 0,
          outcome: 'REJECTED',
          rejection: 'NO_FROZEN_VERSION',
          message: '报告尚无冻结版本，不能导出',
        },
      ],
    });

    render(
      <RecordPackageExportDialog
        onClose={() => undefined}
        open
        recordIds={[12]}
        resourceType="MAINTENANCE_REPORT"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/pkg' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导出到目录' }));

    await waitFor(() => {
      expect(exportRecordPackage).toHaveBeenCalledWith({
        targetPath: '/mnt/usb/pkg',
        resourceType: 'MAINTENANCE_REPORT',
        recordIds: [12],
      });
    });
    expect(await screen.findByText(/报告尚无冻结版本/)).toBeTruthy();
  });

  it('未填目标目录时不给导出按钮', () => {
    render(
      <RecordPackageExportDialog
        onClose={() => undefined}
        open
        recordIds={[12]}
        resourceType="MAINTENANCE_REPORT"
      />,
    );

    expect(screen.getByRole('button', { name: '导出到目录' })).toHaveProperty('disabled', true);
  });
});
