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

import { GraphQLIngressError } from '@/shared/graphql';

import type {
  AdminCompanyAdminAccountDetail,
  AdminCompanyAdminBinding,
  AdminCompanyListPage,
  AdminCompanyProvisionResult,
  AdminCompanyRow,
  AdminCompanySessionIdentity,
} from '../application/admin-company-management.types';
import * as adminCompanyAdapter from '../infrastructure/admin-company-adapter';

import { AdminCompanyManagementPanel } from './admin-company-management-panel';

vi.mock('../infrastructure/admin-company-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof adminCompanyAdapter>();

  return {
    ...actual,
    adminCreateCompany: vi.fn(),
    adminReissueLevelTwoCredential: vi.fn(),
    adminUpdateCompany: vi.fn(),
    checkAdminCompanyNameExists: vi.fn(),
    fetchAdminCompanies: vi.fn(),
    fetchAdminCompanyAdminAccountDetail: vi.fn(),
    fetchAdminCompanyAdminBinding: vi.fn(),
    fetchAdminCompanyDetail: vi.fn(),
    fetchAdminCompanyNames: vi.fn(),
  };
});

const fetchCompaniesMock = vi.mocked(adminCompanyAdapter.fetchAdminCompanies);
const fetchNamesMock = vi.mocked(adminCompanyAdapter.fetchAdminCompanyNames);
const fetchDetailMock = vi.mocked(adminCompanyAdapter.fetchAdminCompanyDetail);
const fetchAccountDetailMock = vi.mocked(adminCompanyAdapter.fetchAdminCompanyAdminAccountDetail);
const fetchBindingMock = vi.mocked(adminCompanyAdapter.fetchAdminCompanyAdminBinding);
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

const BINDING_A: AdminCompanyAdminBinding = {
  organizationId: 501,
  organizationCode: 'ADMIN_ORG_501',
  companyName: '甲公司',
  isManagedCompany: true,
  companyStatus: 'ACTIVE',
  status: 'BOUND',
  reason: null,
  boundAccountId: 9001,
  boundLoginNameMasked: 'adm***01',
  candidateCount: 1,
  accountDisabled: false,
};

const ACCOUNT_DETAIL_A: AdminCompanyAdminAccountDetail = {
  organizationId: 501,
  organizationCode: 'ADMIN_ORG_501',
  companyName: '甲公司',
  isManagedCompany: true,
  companyStatus: 'ACTIVE',
  status: 'BOUND',
  reason: null,
  accountId: 9001,
  loginName: 'admin_org_501',
  nickname: '甲公司管理员',
  mustChangePassword: true,
  accountDisabled: false,
  candidateCount: 1,
};

const PROVISION_SUCCESS: AdminCompanyProvisionResult = {
  ok: true,
  organization: ROW_A,
  provisionedAdmin: {
    accountId: 9001,
    loginName: 'admin_org_501',
    nickname: '甲公司管理员',
    mustChangePassword: true,
  },
  submission: { submissionId: 77, replayed: false },
  temporaryPassword: 'Temp-Stub-Only-1',
};

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

const ACCOUNT_ID = 77;
const OTHER_ACCOUNT_ID = 88;

function submissionStorageKey(accountId: number): string {
  return `lithography.admin-company.create-submission.v2:${accountId}`;
}

function readPersistedSubmissionKey(accountId: number = ACCOUNT_ID): string | null {
  const raw = window.sessionStorage.getItem(submissionStorageKey(accountId));

  return raw === null ? null : (JSON.parse(raw) as { key: string }).key;
}

/** 会话身份是提交标识归属的锚点：由页面注入，单测持有可变快照以便模拟换号 */
let sessionIdentity: AdminCompanySessionIdentity | null = null;

function renderPanel(adminLevel: number) {
  return render(
    <AdminCompanyManagementPanel
      adminLevel={adminLevel}
      sampleSessionIdentity={() => sessionIdentity}
    />,
  );
}

beforeEach(() => {
  // 提交标识落在 sessionStorage：用例之间必须清零，避免上一个用例的标识被复用
  window.sessionStorage.clear();
  // 默认稳定的已登录账号；换号用例在用例内覆盖
  sessionIdentity = { accountId: ACCOUNT_ID, epoch: 1 };
  // message 是 antd 模块级单例，spyOn 跨用例复用同一 mock，需清空历史避免串扰
  vi.spyOn(message, 'success')
    .mockImplementation(() => undefined as never)
    .mockClear();
  fetchCompaniesMock.mockReset().mockResolvedValue(fullPage());
  fetchNamesMock.mockReset().mockResolvedValue(namePage());
  fetchDetailMock.mockReset();
  fetchAccountDetailMock.mockReset().mockResolvedValue({ ok: true, detail: ACCOUNT_DETAIL_A });
  fetchBindingMock.mockReset().mockResolvedValue({ ok: true, binding: BINDING_A });
  createMock.mockReset().mockResolvedValue(PROVISION_SUCCESS);
  updateMock.mockReset();
  nameCheckMock.mockReset().mockResolvedValue(false);
});

describe('AdminCompanyManagementPanel 一级管理员', () => {
  it('渲染完整档案列与行内详情 / 编辑入口', async () => {
    renderPanel(1);

    await screen.findByText('甲公司');

    for (const column of [
      '公司',
      '联系人',
      '电话',
      '邮箱',
      '启用',
      '维修服务',
      '二级管理员账号',
      '操作',
    ]) {
      // 用列头角色定位：antd 的测量行会复制一份同样的表头文本
      expect(screen.getByRole('columnheader', { name: column })).toBeInTheDocument();
    }

    const row = screen.getByText('甲公司').closest('tr') as HTMLElement;
    expect(within(row).getByRole('button', { name: '详情' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '编辑' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '二级管理员账号' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新增公司/ })).toBeInTheDocument();
  }, 15_000); // 首例包含完整表格首屏渲染；并行全量跑时曾触及默认 5s

  it('新增成功后关闭弹窗、给出提示并刷新列表', async () => {
    createMock.mockResolvedValue(PROVISION_SUCCESS);

    renderPanel(1);
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
    expect(createMock).toHaveBeenCalledWith(
      {
        name: '乙公司',
        shortName: '',
        contactName: '',
        contactPhone: '13900000002',
        contactEmail: '',
        address: '',
        remark: '',
        status: 'ACTIVE',
        isServiceProvider: false,
      },
      expect.any(String),
    );

    await waitFor(() => expect(isDialogOpen('新增公司档案')).toBe(false));
    expect(message.success).toHaveBeenCalledWith('公司档案已创建。');
    // 成功后续体统一 reload 当前游标：初次加载 + 成功刷新
    await waitFor(() => expect(fetchCompaniesMock).toHaveBeenCalledTimes(2));
  });

  it('新增成功后清除提交标识，避免下一次新增被服务端误判为回放', async () => {
    createMock.mockResolvedValue(PROVISION_SUCCESS);

    renderPanel(1);
    await screen.findByText('甲公司');

    fireEvent.click(screen.getByRole('button', { name: /新增公司/ }));
    const dialog = getDialog('新增公司档案');

    fireEvent.change(within(dialog).getByLabelText('公司全称'), { target: { value: '乙公司' } });
    fireEvent.change(within(dialog).getByLabelText('联系电话'), {
      target: { value: '13900000002' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    // 提交时一定携带了标识；成功后立即清除（成功续体先于断言执行，不再断言中间态）
    expect(createMock.mock.calls[0][1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await waitFor(() => expect(readPersistedSubmissionKey()).toBeNull());
  });

  it('save-failed（网络不确定）保留标识，重试复用同一提交标识', async () => {
    createMock.mockResolvedValue({ ok: false, reason: 'save-failed', message: '网络异常' });

    renderPanel(1);
    await screen.findByText('甲公司');

    fireEvent.click(screen.getByRole('button', { name: /新增公司/ }));
    const dialog = getDialog('新增公司档案');

    fireEvent.change(within(dialog).getByLabelText('公司全称'), { target: { value: '乙公司' } });
    fireEvent.change(within(dialog).getByLabelText('联系电话'), {
      target: { value: '13900000002' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const firstKey = createMock.mock.calls[0][1];
    // 服务端未明确零提交：标识必须保留，超时重试才能落在同一次提交上
    expect(readPersistedSubmissionKey()).toBe(firstKey);
    expect(isDialogOpen('新增公司档案')).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(2));
    expect(createMock.mock.calls[1][1]).toBe(firstKey);
  });

  it('新增时可选停用状态，并与维修资格相互独立地进入草稿', async () => {
    createMock.mockResolvedValue(PROVISION_SUCCESS);

    renderPanel(1);
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
        expect.any(String),
      ),
    );
  });

  it('同名只提示不阻断：提示可见且仍按独立档案提交', async () => {
    nameCheckMock.mockResolvedValue(true);
    createMock.mockResolvedValue(PROVISION_SUCCESS);

    renderPanel(1);
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
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: '乙公司' }),
      expect.any(String),
    );
  });

  it('编辑同名检查按实际主键排除自身，命中时只提示不阻断保存', async () => {
    nameCheckMock.mockResolvedValue(true);
    updateMock.mockResolvedValue({ ok: true, organization: ROW_A });

    renderPanel(1);
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

    renderPanel(1);
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

    renderPanel(1);
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
    renderPanel(1);
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

describe('AdminCompanyManagementPanel 二级管理员账号与一次性凭据', () => {
  function fillCreateForm(dialog: HTMLElement) {
    fireEvent.change(within(dialog).getByLabelText('公司全称'), { target: { value: '乙公司' } });
    fireEvent.change(within(dialog).getByLabelText('联系电话'), {
      target: { value: '13900000002' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));
  }

  it('列表按当前页公司逐行读取绑定状态并展示脱敏登录名', async () => {
    renderPanel(1);

    await screen.findByText('甲公司');

    // 只按当前页主键取数，不额外拉全量
    expect(fetchBindingMock).toHaveBeenCalledTimes(1);
    expect(fetchBindingMock).toHaveBeenCalledWith(501);
    expect(await screen.findByText('已绑定')).toBeInTheDocument();
    expect(screen.getByText('adm***01')).toBeInTheDocument();
  });

  it('单行绑定读取失败只降级该行，表格其余内容仍可用', async () => {
    fetchBindingMock.mockRejectedValue(
      new GraphQLIngressError({ type: 'network', message: 'off' }),
    );

    renderPanel(1);

    await screen.findByText('甲公司');
    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument();
    // 公司主列不受绑定失败影响
    expect(screen.getByText('ADMIN_ORG_501', { exact: false })).toBeInTheDocument();
  });

  it('新增成功自动打开凭据弹窗展示本次口令，关闭后 DOM 不再含口令', async () => {
    const view = renderPanel(1);
    await screen.findByText('甲公司');

    fireEvent.click(screen.getByRole('button', { name: /新增公司/ }));
    fillCreateForm(getDialog('新增公司档案'));

    await screen.findByText('二级管理员账号凭据', { selector: '.ant-modal-title' });
    const dialog = getDialog('二级管理员账号凭据');
    expect(within(dialog).getByDisplayValue('Temp-Stub-Only-1')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '我已记录并关闭' }));

    // jsdom 不派发 transitionend，`destroyOnHidden` 的节点移除停在离场态；
    // 用 `-leave` 类判定已关闭，再用卸载后的真实 DOM 断言口令已随组件销毁
    await waitFor(() => expect(isDialogOpen('二级管理员账号凭据')).toBe(false));
    view.unmount();
    expect(document.body.textContent).not.toContain('Temp-Stub-Only-1');

    // 持久化层不得出现口令（sessionStorage 只有提交标识，成功后已清除）
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('Temp-Stub-Only-1');
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('Temp-Stub-Only-1');
  });

  it('回放响应只展示安全信息，不渲染任何口令', async () => {
    createMock.mockResolvedValue({
      ...PROVISION_SUCCESS,
      submission: { submissionId: 77, replayed: true },
      temporaryPassword: null,
    });

    renderPanel(1);
    await screen.findByText('甲公司');

    fireEvent.click(screen.getByRole('button', { name: /新增公司/ }));
    fillCreateForm(getDialog('新增公司档案'));

    await screen.findByText('二级管理员账号凭据', { selector: '.ant-modal-title' });
    const dialog = getDialog('二级管理员账号凭据');

    expect(within(dialog).getByText('本次未返回新的临时密码')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });

  it('行内账号入口按需窄查询一次，并展示完整登录名与开通状态', async () => {
    renderPanel(1);
    await screen.findByText('甲公司');

    clickRowAction('甲公司', /二级管理员账号/);
    const dialog = await waitFor(() => getDialog('二级管理员账号：甲公司'));

    // 只在点击后查询一次，不随列表预取完整登录名
    expect(fetchAccountDetailMock).toHaveBeenCalledTimes(1);
    expect(fetchAccountDetailMock).toHaveBeenCalledWith(501);
    expect(within(dialog).getByText('admin_org_501')).toBeInTheDocument();
    expect(within(dialog).getByText('甲公司管理员')).toBeInTheDocument();
    expect(within(dialog).getByText('待首次改密')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '补发临时密码' })).toBeInTheDocument();
  });

  it('已首次改密的账号不展示补发入口', async () => {
    fetchAccountDetailMock.mockResolvedValue({
      ok: true,
      detail: { ...ACCOUNT_DETAIL_A, mustChangePassword: false },
    });

    renderPanel(1);
    await screen.findByText('甲公司');

    clickRowAction('甲公司', /二级管理员账号/);
    const dialog = await waitFor(() => getDialog('二级管理员账号：甲公司'));

    expect(within(dialog).getByText('已改密')).toBeInTheDocument();
    expect(await within(dialog).findByText('该账号已完成首次改密')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '补发临时密码' })).toBeNull();
  });

  it.each([
    {
      label: '未配置',
      expectedText: '尚未配置二级管理员账号',
      patch: {
        status: 'UNCONFIGURED',
        accountId: null,
        loginName: null,
        nickname: null,
        mustChangePassword: null,
        candidateCount: 0,
      } as const,
    },
    {
      label: '冲突',
      expectedText: '归属存在冲突（候选 2 个）',
      patch: {
        status: 'CONFLICT',
        reason: 'MULTIPLE_BINDINGS',
        accountId: null,
        loginName: null,
        nickname: null,
        mustChangePassword: null,
        candidateCount: 2,
      } as const,
    },
    {
      label: '公司停用',
      expectedText: '公司已停用，不可补发',
      patch: {
        status: 'COMPANY_DISABLED',
        companyStatus: 'DISABLED',
        accountId: null,
        loginName: null,
        nickname: null,
        mustChangePassword: null,
      } as const,
    },
    {
      label: '账号停用',
      expectedText: '绑定账号已停用',
      patch: { accountDisabled: true } as const,
    },
  ])('账号详情为 $label 时只给归属提示且不渲染补发入口', async ({ expectedText, patch }) => {
    fetchAccountDetailMock.mockResolvedValue({
      ok: true,
      detail: { ...ACCOUNT_DETAIL_A, ...patch },
    });

    renderPanel(1);
    await screen.findByText('甲公司');

    clickRowAction('甲公司', /二级管理员账号/);
    const dialog = await waitFor(() => getDialog('二级管理员账号：甲公司'));

    expect(await within(dialog).findByText(expectedText)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '补发临时密码' })).toBeNull();
  });

  it('账号详情允许补发时确认后展示本次新口令', async () => {
    const reissueMock = vi.mocked(adminCompanyAdapter.adminReissueLevelTwoCredential);
    reissueMock.mockReset().mockResolvedValue({
      ok: true,
      organizationId: 501,
      adminAccountId: 9001,
      loginName: 'orgadmin_abcdef0123456789abcd',
      nickname: '甲公司',
      mustChangePassword: true,
      temporaryPassword: 'Temp-Stub-Reissue-1',
    });

    renderPanel(1);
    await screen.findByText('甲公司');

    clickRowAction('甲公司', /二级管理员账号/);
    const accountDialog = await waitFor(() => getDialog('二级管理员账号：甲公司'));
    fireEvent.click(within(accountDialog).getByRole('button', { name: '补发临时密码' }));

    const confirmDialog = getDialog('补发二级管理员临时密码');
    expect(within(confirmDialog).getByText('admin_org_501')).toBeInTheDocument();
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /确认补发/ }));

    await waitFor(() => expect(reissueMock).toHaveBeenCalledWith(501));
    await screen.findByText('二级管理员账号凭据', { selector: '.ant-modal-title' });
    expect(
      within(getDialog('二级管理员账号凭据')).getByDisplayValue('Temp-Stub-Reissue-1'),
    ).toBeInTheDocument();
  });

  it('补发响应与确认目标不一致时丢弃口令并提示', async () => {
    const reissueMock = vi.mocked(adminCompanyAdapter.adminReissueLevelTwoCredential);
    reissueMock.mockReset().mockResolvedValue({
      ok: true,
      // 与目标公司 501 不一致：服务端事实不可信，口令一律不进展示态
      organizationId: 999,
      adminAccountId: 9002,
      loginName: 'orgadmin_other_0123456789ab',
      nickname: '其它公司',
      mustChangePassword: true,
      temporaryPassword: 'Temp-Stub-Mismatch-1',
    });

    renderPanel(1);
    await screen.findByText('甲公司');

    clickRowAction('甲公司', /二级管理员账号/);
    const accountDialog = await waitFor(() => getDialog('二级管理员账号：甲公司'));
    fireEvent.click(within(accountDialog).getByRole('button', { name: '补发临时密码' }));

    const confirmDialog = getDialog('补发二级管理员临时密码');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /确认补发/ }));

    await waitFor(() => expect(reissueMock).toHaveBeenCalledWith(501));
    expect(
      await within(confirmDialog).findByText(
        '补发结果与目标公司不一致，口令已丢弃，请刷新后重试。',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('二级管理员账号凭据', { selector: '.ant-modal-title' })).toBeNull();
    expect(document.body.textContent).not.toContain('Temp-Stub-Mismatch-1');
  });

  it('补发回包前会话代次已变化时丢弃口令', async () => {
    const reissueMock = vi.mocked(adminCompanyAdapter.adminReissueLevelTwoCredential);
    const pending: {
      resolve?: (value: Awaited<ReturnType<typeof reissueMock>>) => void;
    } = {};
    reissueMock.mockReset().mockReturnValue(
      new Promise((resolve) => {
        pending.resolve = resolve;
      }),
    );

    renderPanel(1);
    await screen.findByText('甲公司');

    clickRowAction('甲公司', /二级管理员账号/);
    const accountDialog = await waitFor(() => getDialog('二级管理员账号：甲公司'));
    fireEvent.click(within(accountDialog).getByRole('button', { name: '补发临时密码' }));

    const confirmDialog = getDialog('补发二级管理员临时密码');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /确认补发/ }));
    await waitFor(() => expect(reissueMock).toHaveBeenCalledTimes(1));

    // 同一账号重新登录：accountId 不变、epoch 变化，口令不得交给新会话
    sessionIdentity = { accountId: ACCOUNT_ID, epoch: 2 };
    pending.resolve?.({
      ok: true,
      organizationId: 501,
      adminAccountId: 9001,
      loginName: 'orgadmin_abcdef0123456789abcd',
      nickname: '甲公司',
      mustChangePassword: true,
      temporaryPassword: 'Temp-Stub-Stale-Epoch-1',
    });

    expect(
      await within(confirmDialog).findByText('登录身份已变化，口令已丢弃，请重新核对后重试。'),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Temp-Stub-Stale-Epoch-1');
  });
});

describe('AdminCompanyManagementPanel 提交标识归属与冲突恢复', () => {
  const LEGACY_STORAGE_KEY = 'lithography.admin-company.create-submission';

  function seedRecord(accountId: number, key: string, draft: null | object = null) {
    window.sessionStorage.setItem(
      submissionStorageKey(accountId),
      JSON.stringify({ accountId, key, createdAt: 1, draft }),
    );
  }

  function openCreateAndFill(name = '乙公司') {
    fireEvent.click(screen.getByRole('button', { name: /新增公司/ }));
    const dialog = getDialog('新增公司档案');

    fireEvent.change(within(dialog).getByLabelText('公司全称'), { target: { value: name } });
    fireEvent.change(within(dialog).getByLabelText('联系电话'), {
      target: { value: '13900000002' },
    });

    return dialog;
  }

  it('会话身份缺失时直接拒绝，不发出任何提交请求', async () => {
    sessionIdentity = null;
    createMock.mockResolvedValue(PROVISION_SUCCESS);

    renderPanel(1);
    await screen.findByText('甲公司');

    const dialog = openCreateAndFill();
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    expect(
      await within(dialog).findByText('登录状态已失效，请重新登录后再提交。'),
    ).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
    expect(readPersistedSubmissionKey()).toBeNull();
  });

  it('提交冲突时保留标识，恢复首次内容并用同一标识重放', async () => {
    createMock.mockResolvedValue({
      ok: false,
      reason: 'submission-conflict',
      message: '提交标识已被其它内容占用',
    });

    renderPanel(1);
    await screen.findByText('甲公司');

    const dialog = openCreateAndFill();
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const firstKey = createMock.mock.calls[0][1];

    // 冲突不代表零提交：标识必须保留，否则下一次会另起一户
    expect(readPersistedSubmissionKey()).toBe(firstKey);
    expect(await within(dialog).findByText('本次提交内容与已提交记录不一致')).toBeInTheDocument();
    // 恢复首次内容：弹窗重新回填为首次提交的「乙公司」
    await waitFor(() => expect(within(dialog).getByLabelText('公司全称')).toHaveValue('乙公司'));

    fireEvent.change(within(dialog).getByLabelText('公司全称'), { target: { value: '丙公司' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(2));
    expect(createMock.mock.calls[1][1]).toBe(firstKey);
    expect(createMock.mock.calls[1][0]).toMatchObject({ name: '丙公司' });
  });

  it('冲突后另起新提交会换标识并清空表单', async () => {
    createMock.mockResolvedValue({
      ok: false,
      reason: 'submission-conflict',
      message: '提交标识已被其它内容占用',
    });

    renderPanel(1);
    await screen.findByText('甲公司');

    const dialog = openCreateAndFill();
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const firstKey = createMock.mock.calls[0][1];

    fireEvent.click(within(dialog).getByRole('button', { name: '另起新提交' }));

    await waitFor(() => expect(readPersistedSubmissionKey()).not.toBe(firstKey));
    expect(readPersistedSubmissionKey()).not.toBeNull();
    await waitFor(() => expect(within(dialog).getByLabelText('公司全称')).toHaveValue(''));

    fireEvent.change(within(dialog).getByLabelText('公司全称'), {
      target: { value: '丁公司' },
    });
    fireEvent.change(within(dialog).getByLabelText('联系电话'), {
      target: { value: '13900000003' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(2));
    expect(createMock.mock.calls[1][1]).toBe(readPersistedSubmissionKey());
    expect(createMock.mock.calls[1][1]).not.toBe(firstKey);
  });

  it('换号后的迟到成功只提示目标公司，不展示口令也不清别的账号记录', async () => {
    seedRecord(OTHER_ACCOUNT_ID, 'other-account-key');

    const pending: { resolve?: (value: AdminCompanyProvisionResult) => void } = {};
    createMock.mockReturnValue(
      new Promise<AdminCompanyProvisionResult>((resolve) => {
        pending.resolve = resolve;
      }),
    );

    renderPanel(1);
    await screen.findByText('甲公司');

    const dialog = openCreateAndFill();
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

    // 响应回来前会话已换成另一个账号：本次结果属于旧账号，凭据不得展示
    sessionIdentity = { accountId: OTHER_ACCOUNT_ID, epoch: 2 };
    pending.resolve?.(PROVISION_SUCCESS);

    await waitFor(() => expect(message.success).toHaveBeenCalledWith('「甲公司」已创建。'));
    expect(screen.queryByText('二级管理员账号凭据', { selector: '.ant-modal-title' })).toBeNull();
    expect(readPersistedSubmissionKey(OTHER_ACCOUNT_ID)).toBe('other-account-key');
  });

  it('来源未知的旧标识需显式沿用，提交沿用该标识', async () => {
    window.sessionStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ key: 'legacy-key-1', createdAt: 1 }),
    );
    createMock.mockResolvedValue(PROVISION_SUCCESS);

    renderPanel(1);
    await screen.findByText('甲公司');

    const dialog = openCreateAndFill();
    expect(await within(dialog).findByText('检测到来源账号未知的上次提交标识')).toBeInTheDocument();
    // 未选择前不能提交
    expect(within(dialog).getByRole('button', { name: /创\s*建/ })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '沿用上次标识' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][1]).toBe('legacy-key-1');
    expect(window.sessionStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('来源未知的旧标识被显式丢弃后另起新提交', async () => {
    window.sessionStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ key: 'legacy-key-2', createdAt: 1 }),
    );
    createMock.mockResolvedValue(PROVISION_SUCCESS);

    renderPanel(1);
    await screen.findByText('甲公司');

    const dialog = openCreateAndFill();
    fireEvent.click(await within(dialog).findByRole('button', { name: '另起新提交' }));

    expect(window.sessionStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][1]).not.toBe('legacy-key-2');
  });
});

describe('AdminCompanyManagementPanel 二级管理员', () => {
  it('只呈现名称名单与只读提示，不出现任何写入口或精确筛选', async () => {
    renderPanel(2);

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
