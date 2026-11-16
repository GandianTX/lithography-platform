// src/features/admin-company-management/ui/admin-company-management-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 公司档案面板装配单测。
 *
 * 只替换最外层 GraphQL adapter，列表 / 命令 / 详情 hook 走真实实现，覆盖：
 * - 一级：完整档案列与新增 / 编辑 / 详情入口，写成功后关闭弹窗并刷新列表；
 * - 二级：只呈现最小名称名单，不出现任何写入口与精确筛选；
 * - 主搜索防抖到期后把关键字下发给后端查询。
 *
 * 弹窗是否关闭不能用「DOM 消失」判定：jsdom 不派发 transitionend，rc-motion 的离场停在
 * 中间态，`destroyOnHidden` 要等 afterClose 才生效。改用容器的 `-leave` 状态类判定。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { message } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminCompanyListPage,
  AdminCompanyRow,
} from '../application/admin-company-management.types';
import * as adminCompanyAdapter from '../infrastructure/admin-company-adapter';

import { AdminCompanyManagementPanel } from './admin-company-management-panel';

vi.mock('../infrastructure/admin-company-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof adminCompanyAdapter>();

  return {
    ...actual,
    adminCreateCompany: vi.fn(),
    adminUpdateCompany: vi.fn(),
    checkAdminCompanyNameExists: vi.fn(),
    fetchAdminCompanies: vi.fn(),
    fetchAdminCompanyDetail: vi.fn(),
    fetchAdminCompanyNames: vi.fn(),
  };
});

const fetchCompaniesMock = vi.mocked(adminCompanyAdapter.fetchAdminCompanies);
const fetchNamesMock = vi.mocked(adminCompanyAdapter.fetchAdminCompanyNames);
const fetchDetailMock = vi.mocked(adminCompanyAdapter.fetchAdminCompanyDetail);
const createMock = vi.mocked(adminCompanyAdapter.adminCreateCompany);
const updateMock = vi.mocked(adminCompanyAdapter.adminUpdateCompany);
const nameCheckMock = vi.mocked(adminCompanyAdapter.checkAdminCompanyNameExists);

const BUSINESS_FAILURE_MESSAGE = '后端返回的业务失败';

const ROW_A: AdminCompanyRow = {
  organizationId: 501,
  organizationCode: 'ADMIN_ORG_501',
  name: '甲公司',
  shortName: '甲',
  contactName: '张三',
  contactPhone: '13800000001',
  contactEmail: 'contact@example.com',
  address: '上海市浦东新区',
  remark: '备注',
  isServiceProvider: true,
  isManagedCompany: true,
  kind: 'CLIENT',
  status: 'ACTIVE',
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
};

function fullPage(): AdminCompanyListPage {
  return { kind: 'full', items: [ROW_A], page: 1, pageSize: 10, total: 1 };
}

function namePage(): AdminCompanyListPage {
  return { kind: 'name', items: [{ id: 7, name: '乙公司' }], page: 1, pageSize: 10, total: 1 };
}

/** 按标题文本反查弹窗容器（测试环境 aria-labelledby 会撞上工具条元素，不能按 name 取） */
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

function clickRowAction(companyName: string, actionName: RegExp) {
  const row = screen.getByText(companyName).closest('tr') as HTMLElement;

  fireEvent.click(within(row).getByRole('button', { name: actionName }));
}

beforeEach(() => {
  // message 是 antd 模块级单例，spyOn 跨用例复用同一 mock，需清空历史避免串扰
  vi.spyOn(message, 'success')
    .mockImplementation(() => undefined as never)
    .mockClear();
  fetchCompaniesMock.mockReset().mockResolvedValue(fullPage());
  fetchNamesMock.mockReset().mockResolvedValue(namePage());
  fetchDetailMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  nameCheckMock.mockReset().mockResolvedValue(false);
});

describe('AdminCompanyManagementPanel 一级管理员', () => {
  it('渲染完整档案列与行内详情 / 编辑入口', async () => {
    render(<AdminCompanyManagementPanel adminLevel={1} />);

    await screen.findByText('甲公司');

    for (const column of ['公司', '联系人', '电话', '邮箱', '启用', '维修服务', '操作']) {
      // 用列头角色定位：antd 的测量行会复制一份同样的表头文本
      expect(screen.getByRole('columnheader', { name: column })).toBeInTheDocument();
    }

    const row = screen.getByText('甲公司').closest('tr') as HTMLElement;
    expect(within(row).getByRole('button', { name: '详情' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '编辑' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新增公司/ })).toBeInTheDocument();
  }, 15_000); // 首例包含完整表格首屏渲染；并行全量跑时曾触及默认 5s

  it('新增成功后关闭弹窗、给出提示并刷新列表', async () => {
    createMock.mockResolvedValue({ ok: true, organization: ROW_A });

    render(<AdminCompanyManagementPanel adminLevel={1} />);
    await screen.findByText('甲公司');

    fireEvent.click(screen.getByRole('button', { name: /新增公司/ }));
    const dialog = getDialog('新增公司档案');

    fireEvent.change(within(dialog).getByLabelText('公司全称'), { target: { value: '乙公司' } });
    fireEvent.change(within(dialog).getByLabelText('联系电话'), {
      target: { value: '13900000002' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    // 弹窗只回传用户填写的草稿；编号 / 受管归类 / 类别由服务端决定，状态缺省启用
    expect(createMock).toHaveBeenCalledWith({
      name: '乙公司',
      shortName: '',
      contactName: '',
      contactPhone: '13900000002',
      contactEmail: '',
      address: '',
      remark: '',
      status: 'ACTIVE',
      isServiceProvider: false,
    });

    await waitFor(() => expect(isDialogOpen('新增公司档案')).toBe(false));
    expect(message.success).toHaveBeenCalledWith('公司档案已创建。');
    // 成功后续体统一 reload 当前游标：初次加载 + 成功刷新
    await waitFor(() => expect(fetchCompaniesMock).toHaveBeenCalledTimes(2));
  });

  it('新增时可选停用状态，并与维修资格相互独立地进入草稿', async () => {
    createMock.mockResolvedValue({ ok: true, organization: ROW_A });

    render(<AdminCompanyManagementPanel adminLevel={1} />);
    await screen.findByText('甲公司');

    fireEvent.click(screen.getByRole('button', { name: /新增公司/ }));
    const dialog = getDialog('新增公司档案');

    fireEvent.change(within(dialog).getByLabelText('公司全称'), { target: { value: '乙公司' } });
    fireEvent.change(within(dialog).getByLabelText('联系电话'), {
      target: { value: '13900000002' },
    });

    // 两个开关依次为「公司启用」「提供维修服务」：只关闭启用，维修资格保持开启
    const [enabledSwitch, serviceSwitch] = within(dialog).getAllByRole('switch');
    fireEvent.click(enabledSwitch);
    fireEvent.click(serviceSwitch);
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'DISABLED', isServiceProvider: true }),
      ),
    );
  });

  it('同名只提示不阻断：提示可见且仍按独立档案提交', async () => {
    nameCheckMock.mockResolvedValue(true);
    createMock.mockResolvedValue({ ok: true, organization: ROW_A });

    render(<AdminCompanyManagementPanel adminLevel={1} />);
    await screen.findByText('甲公司');

    fireEvent.click(screen.getByRole('button', { name: /新增公司/ }));
    const dialog = getDialog('新增公司档案');

    fireEvent.change(within(dialog).getByLabelText('公司全称'), { target: { value: '乙公司' } });
    fireEvent.change(within(dialog).getByLabelText('联系电话'), {
      target: { value: '13900000002' },
    });

    expect(await within(dialog).findByText(/已存在同名公司档案/)).toBeInTheDocument();
    expect(nameCheckMock).toHaveBeenCalledWith({ name: '乙公司', excludeOrganizationId: null });

    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    // 提示不是校验错误：提交照样通过，同名新增得到独立档案
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: '乙公司' }));
  });

  it('编辑同名检查按实际主键排除自身，命中时只提示不阻断保存', async () => {
    nameCheckMock.mockResolvedValue(true);
    updateMock.mockResolvedValue({ ok: true, organization: ROW_A });

    render(<AdminCompanyManagementPanel adminLevel={1} />);
    await screen.findByText('甲公司');

    clickRowAction('甲公司', /编\s*辑/);
    const dialog = getDialog('编辑公司档案：甲公司');

    expect(await within(dialog).findByText(/已存在同名公司档案/)).toBeInTheDocument();
    expect(nameCheckMock).toHaveBeenCalledWith({ name: '甲公司', excludeOrganizationId: 501 });

    fireEvent.change(within(dialog).getByLabelText('联系人姓名'), { target: { value: '李四' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  });

  it('编辑失败时保留弹窗并展示后端业务文案，只提交发生变化的字段', async () => {
    updateMock.mockResolvedValue({
      ok: false,
      reason: 'invalid-input',
      message: BUSINESS_FAILURE_MESSAGE,
    });

    render(<AdminCompanyManagementPanel adminLevel={1} />);
    await screen.findByText('甲公司');

    clickRowAction('甲公司', /编\s*辑/);
    const dialog = getDialog('编辑公司档案：甲公司');

    fireEvent.change(within(dialog).getByLabelText('联系人姓名'), { target: { value: '李四' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存/ }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({ organizationId: 501, contactName: '李四' }),
    );
    expect(await within(dialog).findByText(BUSINESS_FAILURE_MESSAGE)).toBeInTheDocument();
    expect(isDialogOpen('编辑公司档案：甲公司')).toBe(true);
    expect(message.success).not.toHaveBeenCalled();
  });

  it('详情按主键单独读取并展示当前落库事实', async () => {
    fetchDetailMock.mockResolvedValue({ ok: true, organization: ROW_A });

    render(<AdminCompanyManagementPanel adminLevel={1} />);
    await screen.findByText('甲公司');

    clickRowAction('甲公司', /详\s*情/);

    await screen.findByText('公司详情：甲公司', { selector: '.ant-modal-title' });
    const dialog = getDialog('公司详情：甲公司');

    expect(fetchDetailMock).toHaveBeenCalledWith(501);
    expect(within(dialog).getByText('ADMIN_ORG_501')).toBeInTheDocument();
    expect(within(dialog).getByText('上海市浦东新区')).toBeInTheDocument();
    expect(within(dialog).getByText('受管公司')).toBeInTheDocument();
  });

  it('主搜索在防抖到期后把关键字下发给后端查询', async () => {
    render(<AdminCompanyManagementPanel adminLevel={1} />);
    await screen.findByText('甲公司');

    fireEvent.change(screen.getByLabelText('搜索公司全称 / 编号 / 简称'), {
      target: { value: '甲' },
    });

    await waitFor(() =>
      expect(fetchCompaniesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ keyword: '甲' }),
      ),
    );
  });
});

describe('AdminCompanyManagementPanel 二级管理员', () => {
  it('只呈现名称名单与只读提示，不出现任何写入口或精确筛选', async () => {
    render(<AdminCompanyManagementPanel adminLevel={2} />);

    await screen.findByText('乙公司');

    expect(fetchNamesMock).toHaveBeenCalledTimes(1);
    expect(fetchCompaniesMock).not.toHaveBeenCalled();
    expect(screen.getByText('公司名称')).toBeInTheDocument();
    expect(screen.getByText('当前账号仅可查看公司名称名单。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新增公司/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /筛选/ })).toBeNull();
    expect(screen.queryByText('操作')).toBeNull();
  });
});
