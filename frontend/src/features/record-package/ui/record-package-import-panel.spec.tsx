// src/features/record-package/ui/record-package-import-panel.spec.tsx

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';
import { createTranslator, I18nContext } from '@/shared/i18n';

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

const renderPanel = (language: 'zh-CN' | 'en') =>
  render(
    <I18nContext.Provider
      value={{ language, setLanguage: () => undefined, t: createTranslator(language) }}
    >
      <RecordPackageImportPanel />
    </I18nContext.Provider>,
  );

const badUserInputError = () =>
  new GraphQLIngressError({
    type: 'graphql',
    message: 'GraphQL error',
    graphqlErrors: [
      {
        message: 'GraphQL error',
        extensions: { code: 'BAD_USER_INPUT', errorCode: 'RECORD_PACKAGE_INVALID_MANIFEST' },
      },
    ],
  });

describe('记录包导入面板', () => {
  beforeEach(() => {
    checkRecordPackage.mockReset();
    importRecordPackage.mockReset();
  });

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

  it('中文界面：清单级输入错误显示中文受控提示', async () => {
    checkRecordPackage.mockRejectedValueOnce(badUserInputError());
    renderPanel('zh-CN');
    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/pkg' },
    });
    fireEvent.click(screen.getByRole('button', { name: '安全检查' }));
    expect(
      await screen.findByText('记录包内容不符合要求，请检查清单和原件后重新导出。'),
    ).toBeTruthy();
  });

  it('英文界面：同一 BAD_USER_INPUT 显示英文受控提示', async () => {
    checkRecordPackage.mockRejectedValueOnce(badUserInputError());
    renderPanel('en');
    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/pkg' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Safety check' }));
    expect(
      await screen.findByText(
        'The record package is invalid. Check the manifest and original files, then export it again.',
      ),
    ).toBeTruthy();
  });

  it('中文界面：同摘要重检限制显示中文提示', async () => {
    checkRecordPackage.mockResolvedValue(CHECK_RESULT);
    renderPanel('zh-CN');
    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/pkg' },
    });
    fireEvent.click(screen.getByRole('button', { name: '安全检查' }));
    expect(await screen.findByText(/同一包重复检查不会刷新上次结论/)).toBeTruthy();
  });

  it('英文界面：同摘要重检限制显示英文提示', async () => {
    checkRecordPackage.mockResolvedValue(CHECK_RESULT);
    renderPanel('en');
    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/pkg' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Safety check' }));
    expect(await screen.findByText(/Rechecking the same package/)).toBeTruthy();
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

  it('混合检查范围：合格条目可确认，硬阻断条目明确标记未执行', async () => {
    checkRecordPackage.mockResolvedValue({
      ...CHECK_RESULT,
      import: { ...CHECK_RESULT.import, itemTotal: 2 },
      items: [
        CHECK_RESULT.items[0],
        {
          ...CHECK_RESULT.items[0],
          itemId: 'item-2',
          recordUuid: '22222222-3333-4444-8555-666666666666',
          checkResult: 'REJECTED',
          errorMessage: '缺少原件文件',
        },
      ],
    });

    render(<RecordPackageImportPanel />);

    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/pkg' },
    });
    fireEvent.click(screen.getByRole('button', { name: '安全检查' }));

    const confirmButton = await screen.findByRole('button', { name: '确认导入' });
    expect(confirmButton).toHaveProperty('disabled', false);
    expect(await screen.findByText('检查未通过，未执行')).toBeTruthy();
  });

  it('换包即失效：改了路径后上一轮的确认入口消失（不显示过期确认）', async () => {
    checkRecordPackage.mockResolvedValue(CHECK_RESULT);

    render(<RecordPackageImportPanel />);

    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/pkg' },
    });
    fireEvent.click(screen.getByRole('button', { name: '安全检查' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认导入' })).toBeTruthy();
    });

    // 换包：路径变化即清掉上一轮的预检结论与确认入口
    fireEvent.change(screen.getByPlaceholderText('/media/usb/package'), {
      target: { value: '/mnt/usb/other' },
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '确认导入' })).toBeNull();
    });
  });
});
