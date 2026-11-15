// src/features/repair-request/ui/repair-request-form.spec.tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import {
  createRepairRequest,
  fetchEquipmentModels,
} from '../infrastructure/repair-request-adapter';

import { RepairRequestForm, type RepairRequestFormProps } from './repair-request-form';

vi.mock('../infrastructure/repair-request-adapter', () => ({
  createRepairRequest: vi.fn(),
  fetchEquipmentModels: vi.fn(),
}));

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

const fetchEquipmentModelsMock = vi.mocked(fetchEquipmentModels);
const createRepairRequestMock = vi.mocked(createRepairRequest);

const MODEL_OPTIONS = [
  { id: 11, modelCode: 'LITHO-A', modelName: '型号A' },
  { id: 12, modelCode: 'LITHO-B', modelName: '型号B' },
];

const CREATED_RECORD = {
  id: 1,
  requestNo: 'RR20260826000000ABC123',
  equipmentModelId: 11,
  errorCode: 'E-2001',
  faultDescription: '双工件台干涉仪报错',
  createdAt: '2026-08-26T00:00:00.000Z',
  isAccepted: false,
};

function stubBrowserApis() {
  // matchMedia 与 ResizeObserver 桩均由全局测试 setup（src/test/setup.ts）提供，
  // 此处只补齐 jsdom 缺失且 antd 依赖的其余浏览器 API。
  Element.prototype.scrollIntoView = () => {};
}

function isDisabled(element: HTMLElement): boolean {
  return (
    (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true'
  );
}

function renderForm(props: RepairRequestFormProps = {}) {
  return render(
    <MemoryRouter>
      <RepairRequestForm {...props} />
    </MemoryRouter>,
  );
}

async function selectFirstModel() {
  fireEvent.mouseDown(screen.getByRole('combobox'));
  fireEvent.click(await screen.findByText('型号A（LITHO-A）'));
}

async function fillForm() {
  await selectFirstModel();
  fireEvent.change(screen.getByPlaceholderText('例如：E-2001'), {
    target: { value: 'E-2001' },
  });
  fireEvent.change(screen.getByPlaceholderText('请描述设备故障现象与发生场景'), {
    target: { value: '双工件台干涉仪报错' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

beforeEach(() => {
  stubBrowserApis();
  fetchEquipmentModelsMock.mockReset();
  createRepairRequestMock.mockReset();
  navigateMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('设备型号加载状态', () => {
  it('加载中时型号选择与提交不可用', () => {
    fetchEquipmentModelsMock.mockReturnValue(new Promise(() => {}));

    renderForm();

    expect(isDisabled(screen.getByRole('combobox'))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: '提交申请' }))).toBe(true);
  });

  it('加载失败时展示错误并支持重试', async () => {
    fetchEquipmentModelsMock
      .mockRejectedValueOnce(new GraphQLIngressError({ message: 'down', type: 'network' }))
      .mockResolvedValueOnce(MODEL_OPTIONS);

    renderForm();

    expect(await screen.findByText('网络连接异常，请稍后重试。')).toBeTruthy();
    // antd 会给两字按钮文本插入空格（“重 试”），用正则匹配可访问名
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    const combobox = await screen.findByRole('combobox');
    await expect.poll(() => isDisabled(combobox), { timeout: 3000 }).toBe(false);
    expect(fetchEquipmentModelsMock).toHaveBeenCalledTimes(2);
  });

  it('无可用型号时展示提示且提交不可用', async () => {
    fetchEquipmentModelsMock.mockResolvedValue([]);

    renderForm();

    expect(await screen.findByText('暂无可用的设备型号，请稍后再试。')).toBeTruthy();
    expect(isDisabled(screen.getByRole('button', { name: '提交申请' }))).toBe(true);
  });

  // S2-2：空态可恢复，不必刷新整页
  it('无可用型号时可重试拉取，型号就绪后即可提交', async () => {
    fetchEquipmentModelsMock.mockResolvedValueOnce([]).mockResolvedValueOnce(MODEL_OPTIONS);

    renderForm();
    expect(await screen.findByText('暂无可用的设备型号，请稍后再试。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    // 「重试」先同步置 loading，再在微任务回写就绪态。此处用 act 包裹的 `waitFor` 而非
    // `expect.poll`：poll 不进入 act 边界，回写 setState 会落在边界外并输出 act(...) 告警
    // （本用例为 S2 新增，故一并收口；同组另一条用例本就使用 act 包裹的 `findBy*` 等待）。
    await waitFor(() => expect(isDisabled(screen.getByRole('combobox'))).toBe(false));

    expect(screen.queryByText('暂无可用的设备型号，请稍后再试。')).toBeNull();
    expect(isDisabled(screen.getByRole('button', { name: '提交申请' }))).toBe(false);
  });
});

describe('提交校验与反馈', () => {
  beforeEach(() => {
    fetchEquipmentModelsMock.mockResolvedValue(MODEL_OPTIONS);
  });

  it('必填项缺失时拦截提交并提示', async () => {
    renderForm();
    await screen.findByRole('combobox');

    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('请选择设备型号')).toBeTruthy();
    expect(await screen.findByText('请输入设备错误码')).toBeTruthy();
    expect(await screen.findByText('请输入故障描述')).toBeTruthy();
    expect(createRepairRequestMock).not.toHaveBeenCalled();
  });

  it('创建成功展示后端生成的申请编号', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    expect(screen.getByText('申请编号：RR20260826000000ABC123')).toBeTruthy();
    expect(createRepairRequestMock).toHaveBeenCalledWith({
      equipmentModelId: 11,
      errorCode: 'E-2001',
      faultDescription: '双工件台干涉仪报错',
    });
  });

  it('成功后继续创建时表单已重置，不会残留旧值', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '继续创建' }));

    // 型号下拉回到占位文案，文本输入均为空，不会一键重复提交
    expect(await screen.findByText('请选择设备型号')).toBeTruthy();
    expect((screen.getByPlaceholderText('例如：E-2001') as HTMLInputElement).value).toBe('');
    expect(
      (screen.getByPlaceholderText('请描述设备故障现象与发生场景') as HTMLTextAreaElement).value,
    ).toBe('');
  });

  it('成功后跳转维修申请列表（T-05：列表能力已落地，替换客户首页临时落点）', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看维修申请' }));

    expect(navigateMock).toHaveBeenCalledWith('/customer/repair-requests');
  });

  // PR5 整合工作台协作端口：onCreated 在创建成功时上报真实记录（工作台据此刷新左栏）
  it('提供 onCreated 时创建成功上报真实记录，且不改默认导航边界', async () => {
    const onCreatedMock = vi.fn();
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm({ onCreated: onCreatedMock });
    await screen.findByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    expect(onCreatedMock).toHaveBeenCalledWith(CREATED_RECORD);
  });

  // PR5 整合工作台协作端口：onViewCreated 覆盖「查看维修申请」的默认跳转目标
  it('提供 onViewCreated 时点击「查看维修申请」交给回调处理，不再走默认列表跳转', async () => {
    const onViewCreatedMock = vi.fn();
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm({ onViewCreated: onViewCreatedMock });
    await screen.findByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看维修申请' }));

    expect(onViewCreatedMock).toHaveBeenCalledWith(CREATED_RECORD);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  // PR5 整合工作台：取消仅重置已填内容，不清除型号等页面级状态
  it('取消按钮清空已填字段，表单回到可重新填写状态', async () => {
    renderForm();
    await screen.findByRole('combobox');
    await fillForm();

    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }));

    expect((screen.getByPlaceholderText('例如：E-2001') as HTMLInputElement).value).toBe('');
    expect(
      (screen.getByPlaceholderText('请描述设备故障现象与发生场景') as HTMLTextAreaElement).value,
    ).toBe('');
    // 型号下拉回到占位文案，型号列表仍可用（页面级状态不被清除）
    expect(screen.getByText('请选择设备型号')).toBeTruthy();
    expect(isDisabled(screen.getByRole('button', { name: '提交申请' }))).toBe(false);
    expect(createRepairRequestMock).not.toHaveBeenCalled();
  });

  it('提交时对错误码与故障描述去首尾空格', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findByRole('combobox');
    await selectFirstModel();
    fireEvent.change(screen.getByPlaceholderText('例如：E-2001'), {
      target: { value: '  E-2001  ' },
    });
    fireEvent.change(screen.getByPlaceholderText('请描述设备故障现象与发生场景'), {
      target: { value: '  双工件台干涉仪报错  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    expect(createRepairRequestMock).toHaveBeenCalledWith({
      equipmentModelId: 11,
      errorCode: 'E-2001',
      faultDescription: '双工件台干涉仪报错',
    });
  });

  it('业务拒绝后重新提交成功时清除先前的错误提示', async () => {
    createRepairRequestMock
      .mockResolvedValueOnce({
        ok: false,
        message: '所选设备型号已停用。',
        reason: 'model-disabled',
      })
      .mockResolvedValueOnce({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findByRole('combobox');
    await fillForm();

    const submitButton = screen.getByRole('button', { name: '提交申请' });
    fireEvent.click(submitButton);
    expect(await screen.findByText('所选设备型号已停用。')).toBeTruthy();

    fireEvent.click(submitButton);
    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    expect(screen.queryByText('所选设备型号已停用。')).toBeNull();
    expect(createRepairRequestMock).toHaveBeenCalledTimes(2);
  });

  it('业务拒绝展示后端消息并保留表单内容', async () => {
    createRepairRequestMock.mockResolvedValue({
      ok: false,
      message: '所选设备型号已停用。',
      reason: 'model-disabled',
    });

    renderForm();
    await screen.findByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('所选设备型号已停用。')).toBeTruthy();
    expect((screen.getByPlaceholderText('例如：E-2001') as HTMLInputElement).value).toBe('E-2001');
  });

  it('transport 失败展示共享错误模型的用户文案', async () => {
    createRepairRequestMock.mockRejectedValue(
      new GraphQLIngressError({ message: 'down', type: 'network' }),
    );

    renderForm();
    await screen.findByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('网络连接异常，请稍后重试。')).toBeTruthy();
  });

  // S4 归属门禁：缺公司归属被服务端拒绝时，展示补录引导并可跳转账号设置
  it('缺公司归属（company-required）时展示补录引导与跳转入口', async () => {
    createRepairRequestMock.mockResolvedValue({
      ok: false,
      message: '请先在账号设置中补充公司信息后再提交维修申请',
      reason: 'company-required',
    });

    renderForm();
    await screen.findByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('请先在账号设置中补充公司信息后再提交维修申请')).toBeTruthy();
    expect(screen.getByText('补充公司信息后返回本页即可重新提交。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /前往账号设置/ }));

    expect(navigateMock).toHaveBeenCalledWith('/account/settings');
    // 引导不改变「保留表单内容」的既有口径
    expect((screen.getByPlaceholderText('例如：E-2001') as HTMLInputElement).value).toBe('E-2001');
  });

  it('其他业务拒绝不出现账号设置跳转入口', async () => {
    createRepairRequestMock.mockResolvedValue({
      ok: false,
      message: '所属公司当前不可用，请联系管理员处理后再提交维修申请',
      reason: 'company-unavailable',
    });

    renderForm();
    await screen.findByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(
      await screen.findByText('所属公司当前不可用，请联系管理员处理后再提交维修申请'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /前往账号设置/ })).toBeNull();
  });

  it('进行中的提交只发送一次 Mutation', async () => {
    const pending = deferred<{ ok: true; repairRequest: typeof CREATED_RECORD }>();
    createRepairRequestMock.mockReturnValue(pending.promise);

    renderForm();
    await screen.findByRole('combobox');
    await fillForm();

    const submitButton = screen.getByRole('button', { name: '提交申请' });
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    // antd Form 校验是异步的，等提交真正发出后再断言只发了一次
    await waitFor(() => {
      expect(createRepairRequestMock).toHaveBeenCalledTimes(1);
    });
    // S2-1：提交中主按钮进入 loading 态（防连点的可视反馈）
    expect(submitButton.classList.contains('ant-btn-loading')).toBe(true);

    pending.resolve({ ok: true, repairRequest: CREATED_RECORD });
    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
  });
});

describe('字段提示与整体规则（2026-09-30 复审：去掉集中式提示栏）', () => {
  beforeEach(() => {
    fetchEquipmentModelsMock.mockResolvedValue(MODEL_OPTIONS);
  });

  it('三个字段小标题旁各挂一条与字段一一对应的短提示，长度口径与 100 / 5000 契约一致', async () => {
    renderForm();
    await screen.findByRole('combobox');

    const pairs = [
      { hint: '仅可选择已启用型号', title: '设备型号' },
      { hint: '必填，最多 100 个字符', title: '设备错误码' },
      { hint: '必填，最多 5000 个字符', title: '故障描述' },
    ] as const;

    const items = pairs.map((pair) => {
      const title = screen.getByText(pair.title, { exact: true });
      const item = title.closest('.ant-form-item');

      expect(item, `${pair.title} 应有对应 Form.Item`).not.toBeNull();
      expect(item?.textContent, `${pair.title} 旁应展示短提示`).toContain(pair.hint);

      return item;
    });

    // 提示不得集中塞进某一个字段：三个提示分属三个不同 Form.Item
    expect(new Set(items).size).toBe(3);
  });

  it('整体业务规则位于提交按钮附近的操作行，且不再渲染「填写提示」', async () => {
    renderForm();
    await screen.findByRole('combobox');

    const rule = screen.getByText('提交后不可修改；未接单可删除');
    const actions = rule.closest('.repair-request-form-actions');

    expect(actions).not.toBeNull();
    expect(within(actions as HTMLElement).getByRole('button', { name: /取\s*消/ })).toBeTruthy();
    expect(within(actions as HTMLElement).getByRole('button', { name: '提交申请' })).toBeTruthy();
    expect(screen.queryByText('填写提示')).toBeNull();
  });
});
