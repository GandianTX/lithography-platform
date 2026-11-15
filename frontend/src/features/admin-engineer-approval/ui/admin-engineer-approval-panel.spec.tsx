// src/features/admin-engineer-approval/ui/admin-engineer-approval-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 审批面板装配单测。
 *
 * 只替换最外层 GraphQL adapter，列表 / 详情 / 命令 hook 走真实实现，覆盖：
 * - 只有 PENDING 行出现批准 / 拒绝动作；
 * - 批准成功后提示、刷新队列并在详情打开时重查；
 * - 拒绝原因为空时前端拦截、不发起命令；
 * - 拒绝成功后关闭弹窗并刷新；并发冲突提示状态已变并重查。
 *
 * 弹窗是否关闭不能用「DOM 消失」判定：jsdom 不派发 transitionend，rc-motion 的离场停在
 * 中间态，`destroyOnHidden` 要等 afterClose 才生效。改用容器的 `-leave` 状态类判定。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { message } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminEngineerRegistrationListPage,
  AdminEngineerRegistrationRow,
} from '../application/admin-engineer-approval.types';
import * as adapter from '../infrastructure/admin-engineer-approval-adapter';

import { AdminEngineerApprovalPanel } from './admin-engineer-approval-panel';

vi.mock('../infrastructure/admin-engineer-approval-adapter', () => ({
  fetchAdminEngineerRegistrations: vi.fn(),
  fetchAdminEngineerRegistrationDetail: vi.fn(),
  reviewEngineerRegistration: vi.fn(),
}));

const fetchListMock = vi.mocked(adapter.fetchAdminEngineerRegistrations);
const fetchDetailMock = vi.mocked(adapter.fetchAdminEngineerRegistrationDetail);
const reviewMock = vi.mocked(adapter.reviewEngineerRegistration);

const PENDING_ROW: AdminEngineerRegistrationRow = {
  applicationId: 61,
  accountId: 501,
  organizationId: 9,
  organizationName: '甲公司',
  status: 'PENDING',
  applicationNote: '希望加入组织',
  submittedAt: '2026-11-01T08:00:00.000Z',
  reviewedAt: null,
  reviewComment: null,
  applicant: {
    nickname: '待审工程师',
    loginName: 'pending-engineer',
    loginEmail: 'pending@example.com',
    phone: '13800000001',
    contactEmail: 'pending@example.com',
    companyName: null,
  },
};

const APPROVED_ROW: AdminEngineerRegistrationRow = {
  ...PENDING_ROW,
  applicationId: 62,
  accountId: 502,
  status: 'APPROVED',
  reviewedAt: '2026-11-02T08:00:00.000Z',
  reviewComment: '资料齐全',
  applicant: { ...PENDING_ROW.applicant, nickname: '已通过工程师', loginName: 'approved-engineer' },
};

function listPage(): AdminEngineerRegistrationListPage {
  return { items: [PENDING_ROW, APPROVED_ROW], page: 1, pageSize: 10, total: 2 };
}

function queryDialog(title: string): HTMLElement | null {
  const titleNode = screen.queryByText(title, { selector: '.ant-modal-title' });

  return (titleNode?.closest('[role="dialog"]') as HTMLElement | null) ?? null;
}

function getDialog(title: string): HTMLElement {
  const dialog = queryDialog(title);

  if (dialog === null) {
    throw new Error(`未找到标题为「${title}」的弹窗`);
  }

  return dialog;
}

function isDialogOpen(title: string): boolean {
  const dialog = queryDialog(title);

  return dialog !== null && !dialog.className.includes('-leave');
}

function clickRowAction(applicantName: string, actionName: RegExp) {
  const row = screen.getByText(applicantName).closest('tr') as HTMLElement;

  fireEvent.click(within(row).getByRole('button', { name: actionName }));
}

beforeEach(() => {
  vi.spyOn(message, 'success')
    .mockImplementation(() => undefined as never)
    .mockClear();
  vi.spyOn(message, 'warning')
    .mockImplementation(() => undefined as never)
    .mockClear();
  fetchListMock.mockReset().mockResolvedValue(listPage());
  fetchDetailMock.mockReset();
  reviewMock.mockReset();
});

describe('AdminEngineerApprovalPanel', () => {
  it('只对待审申请显示批准 / 拒绝，终态仅保留详情', async () => {
    render(<AdminEngineerApprovalPanel adminLevel={1} />);

    await screen.findByText('待审工程师');

    for (const column of ['申请人', '公司', '申请说明 · 联系方式', '状态', '操作']) {
      expect(screen.getByRole('columnheader', { name: column })).toBeInTheDocument();
    }

    const pendingRow = screen.getByText('待审工程师').closest('tr') as HTMLElement;
    expect(within(pendingRow).getByRole('button', { name: '详情' })).toBeInTheDocument();
    expect(within(pendingRow).getByRole('button', { name: '批准' })).toBeInTheDocument();
    expect(within(pendingRow).getByRole('button', { name: '拒绝' })).toBeInTheDocument();

    const approvedRow = screen.getByText('已通过工程师').closest('tr') as HTMLElement;
    expect(within(approvedRow).getByRole('button', { name: '详情' })).toBeInTheDocument();
    expect(within(approvedRow).queryByRole('button', { name: '批准' })).toBeNull();
    expect(within(approvedRow).queryByRole('button', { name: '拒绝' })).toBeNull();
  }, 15_000);

  it('范围提示随会话等级变化', async () => {
    const { unmount } = render(<AdminEngineerApprovalPanel adminLevel={2} />);
    await screen.findByText('待审工程师');
    expect(screen.getByText('当前账号仅可查看并审批本公司的工程师注册申请。')).toBeInTheDocument();
    unmount();

    render(<AdminEngineerApprovalPanel adminLevel={1} />);
    await screen.findByText('待审工程师');
    expect(screen.getByText('当前账号可查看并审批全部公司的工程师注册申请。')).toBeInTheDocument();
  }, 15_000);

  it('批准成功后提示并刷新队列', async () => {
    reviewMock.mockResolvedValue({
      ok: true,
      registration: { ...PENDING_ROW, status: 'APPROVED' },
    });

    render(<AdminEngineerApprovalPanel adminLevel={1} />);
    await screen.findByText('待审工程师');

    clickRowAction('待审工程师', /批\s*准/);

    await waitFor(() =>
      expect(reviewMock).toHaveBeenCalledWith({
        applicationId: 61,
        action: 'APPROVE',
        reviewComment: null,
      }),
    );
    await waitFor(() => expect(message.success).toHaveBeenCalledWith('该申请已通过审核。'));
    // 初次加载 + 成功刷新
    await waitFor(() => expect(fetchListMock).toHaveBeenCalledTimes(2));
  });

  it('拒绝原因为空时前端拦截，不发起命令', async () => {
    render(<AdminEngineerApprovalPanel adminLevel={1} />);
    await screen.findByText('待审工程师');

    clickRowAction('待审工程师', /拒\s*绝/);
    const dialog = getDialog('拒绝申请：待审工程师');

    fireEvent.click(within(dialog).getByRole('button', { name: /确认拒绝/ }));

    expect(await within(dialog).findByText('请填写拒绝原因')).toBeInTheDocument();
    expect(reviewMock).not.toHaveBeenCalled();
    expect(isDialogOpen('拒绝申请：待审工程师')).toBe(true);
  });

  it('填写原因后拒绝成功：关闭弹窗、提示并刷新', async () => {
    reviewMock.mockResolvedValue({
      ok: true,
      registration: { ...PENDING_ROW, status: 'REJECTED', reviewComment: '资料不足' },
    });

    render(<AdminEngineerApprovalPanel adminLevel={1} />);
    await screen.findByText('待审工程师');

    clickRowAction('待审工程师', /拒\s*绝/);
    const dialog = getDialog('拒绝申请：待审工程师');

    fireEvent.change(within(dialog).getByLabelText('拒绝原因'), {
      target: { value: '资料不足，请补充授权证明' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /确认拒绝/ }));

    await waitFor(() =>
      expect(reviewMock).toHaveBeenCalledWith({
        applicationId: 61,
        action: 'REJECT',
        reviewComment: '资料不足，请补充授权证明',
      }),
    );
    await waitFor(() => expect(isDialogOpen('拒绝申请：待审工程师')).toBe(false));
    expect(message.success).toHaveBeenCalledWith('该申请已拒绝。');
    await waitFor(() => expect(fetchListMock).toHaveBeenCalledTimes(2));
  });

  it('并发第二人决定提示状态已变并重查，不停留在旧快照', async () => {
    reviewMock.mockResolvedValue({
      ok: false,
      reason: 'state-conflict',
      message: '该申请已被处理，请刷新后查看最新状态。',
    });

    render(<AdminEngineerApprovalPanel adminLevel={1} />);
    await screen.findByText('待审工程师');

    clickRowAction('待审工程师', /批\s*准/);

    await waitFor(() =>
      expect(message.warning).toHaveBeenCalledWith('该申请已被处理，请刷新后查看最新状态。'),
    );
    await waitFor(() => expect(fetchListMock).toHaveBeenCalledTimes(2));
    expect(message.success).not.toHaveBeenCalled();
  });

  it('详情按主键单独读取并展示申请事实', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, registration: PENDING_ROW });

    render(<AdminEngineerApprovalPanel adminLevel={1} />);
    await screen.findByText('待审工程师');

    clickRowAction('待审工程师', /详\s*情/);

    await screen.findByText('注册申请详情：待审工程师', { selector: '.ant-modal-title' });
    const dialog = getDialog('注册申请详情：待审工程师');

    expect(fetchDetailMock).toHaveBeenCalledWith(61);
    expect(within(dialog).getByText('pending-engineer')).toBeInTheDocument();
    expect(within(dialog).getByText('希望加入组织')).toBeInTheDocument();
    expect(within(dialog).getByText('待审核')).toBeInTheDocument();
  });
});
