// src/features/repair-request/ui/repair-request-form.spec.tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import {
  createRepairRequest,
  fetchEquipmentModels,
  fetchRepairServiceOrganizations,
  fetchTrustedCompanyName,
  uploadRepairRequestFile,
} from '../infrastructure/repair-request-adapter';

import { RepairRequestForm, type RepairRequestFormProps } from './repair-request-form';

vi.mock('../infrastructure/repair-request-adapter', () => ({
  createRepairRequest: vi.fn(),
  fetchEquipmentModels: vi.fn(),
  fetchRepairServiceOrganizations: vi.fn(),
  fetchTrustedCompanyName: vi.fn(),
  uploadRepairRequestFile: vi.fn(),
}));

// 本文件部分用例需要多次填表与上传交互，在并行满负载下默认 5s 会误判超时
vi.setConfig({ testTimeout: 15000 });

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

const fetchEquipmentModelsMock = vi.mocked(fetchEquipmentModels);
const fetchServiceOrganizationsMock = vi.mocked(fetchRepairServiceOrganizations);
const fetchTrustedCompanyNameMock = vi.mocked(fetchTrustedCompanyName);
const uploadRepairRequestFileMock = vi.mocked(uploadRepairRequestFile);
const createRepairRequestMock = vi.mocked(createRepairRequest);

const MODEL_OPTIONS = [
  { id: 11, modelCode: 'LITHO-A', modelName: '型号A' },
  { id: 12, modelCode: 'LITHO-B', modelName: '型号B' },
];

const SERVICE_ORG_OPTIONS = [{ id: 88, name: '乙方维修公司', shortName: '乙方' }];

const CREATED_RECORD = {
  id: 1,
  requestNo: 'RR20260826000000ABC123',
  equipmentModelId: 11,
  errorCode: 'E-2001',
  faultDescription: '双工件台干涉仪报错',
  createdAt: '2026-08-26T00:00:00.000Z',
  isAccepted: false,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

/** 按字段小标题定位下拉框（机型录入方式切换时 combobox 数量会变化，不能靠下标） */
function comboboxByLabel(label: string): HTMLInputElement {
  const items = Array.from(document.querySelectorAll('.ant-form-item'));
  const item = items.find((element) =>
    element.querySelector('label')?.textContent?.includes(label),
  );
  const input = item?.querySelector('[role="combobox"]');
  if (!input) {
    throw new Error(`未找到「${label}」的下拉框`);
  }

  return input as HTMLInputElement;
}

const modelCombobox = () => comboboxByLabel('设备型号');
const serviceOrgCombobox = () => comboboxByLabel('维修厂家');

async function selectServiceOrg() {
  fireEvent.mouseDown(serviceOrgCombobox());
  const options = await screen.findAllByText('乙方维修公司（乙方）');
  fireEvent.click(options[options.length - 1]);
}

async function selectFirstModel() {
  fireEvent.mouseDown(modelCombobox());
  const options = await screen.findAllByText('型号A（LITHO-A）');
  fireEvent.click(options[options.length - 1]);
}

async function fillForm() {
  await selectServiceOrg();
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

/** 默认让两个下拉都在就绪态，各用例按需覆盖 */
function stubReadyQueries() {
  fetchEquipmentModelsMock.mockResolvedValue(MODEL_OPTIONS);
  fetchServiceOrganizationsMock.mockResolvedValue(SERVICE_ORG_OPTIONS);
  fetchTrustedCompanyNameMock.mockResolvedValue('甲公司');
}

beforeEach(() => {
  stubBrowserApis();
  fetchEquipmentModelsMock.mockReset();
  fetchServiceOrganizationsMock.mockReset();
  fetchTrustedCompanyNameMock.mockReset();
  uploadRepairRequestFileMock.mockReset();
  createRepairRequestMock.mockReset();
  navigateMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('设备型号与维修厂家加载状态', () => {
  it('加载中时型号选择与提交不可用（直接触发提交也不发送请求）', () => {
    fetchEquipmentModelsMock.mockReturnValue(new Promise(() => {}));
    fetchServiceOrganizationsMock.mockReturnValue(new Promise(() => {}));

    renderForm();

    expect(isDisabled(modelCombobox())).toBe(true);
    expect(isDisabled(serviceOrgCombobox())).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: '提交申请' }))).toBe(true);

    // 不只检查按钮置灰：直接触发 form 提交同样不得发起创建请求
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(createRepairRequestMock).not.toHaveBeenCalled();
  });

  it('加载失败时展示错误并支持重试，不提供手填成功态', async () => {
    fetchEquipmentModelsMock
      .mockRejectedValueOnce(new GraphQLIngressError({ message: 'down', type: 'network' }))
      .mockResolvedValueOnce(MODEL_OPTIONS);
    fetchServiceOrganizationsMock.mockResolvedValue(SERVICE_ORG_OPTIONS);

    renderForm();

    expect(await screen.findByText('网络连接异常，请稍后重试。')).toBeTruthy();
    // 查询失败不得当作空目录：不出现手填切换入口，也不出现空目录提示
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('暂无已登记的设备型号，请手填本次报修的设备型号。')).toBeNull();
    // antd 会给两字按钮文本插入空格（“重 试”），用正则匹配可访问名
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    const combobox = modelCombobox();
    await expect.poll(() => isDisabled(combobox), { timeout: 3000 }).toBe(false);
    expect(fetchEquipmentModelsMock).toHaveBeenCalledTimes(2);
  });

  // 空目录（查询成功但无启用型号）：直接进入手填模式，仍可提交第一张报修
  it('机型目录为空时直接进入手填模式，提交只携带机型文本', async () => {
    fetchEquipmentModelsMock.mockResolvedValue([]);
    fetchServiceOrganizationsMock.mockResolvedValue(SERVICE_ORG_OPTIONS);
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();

    expect(
      await screen.findByText('暂无已登记的设备型号，请手填本次报修的设备型号。'),
    ).toBeTruthy();
    // 不渲染「切回没有选项的下拉框」的入口，也没有机型下拉
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(document.querySelectorAll('[role="combobox"]').length).toBe(1); // 仅维修厂家

    const manualInput = screen.getByPlaceholderText('例如：NSR-S622D') as HTMLInputElement;
    expect(manualInput.disabled).toBe(false);

    await selectServiceOrg();
    fireEvent.change(manualInput, { target: { value: '  NSR-S622D  ' } });
    fireEvent.change(screen.getByPlaceholderText('例如：E-2001'), {
      target: { value: 'E-2001' },
    });
    fireEvent.change(screen.getByPlaceholderText('请描述设备故障现象与发生场景'), {
      target: { value: '双工件台干涉仪报错' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    const payload = createRepairRequestMock.mock.calls[0][0];
    expect(payload.equipmentModelText).toBe('NSR-S622D');
    expect(payload.equipmentModelId).toBeUndefined();
    expect('equipmentModelId' in payload).toBe(false);
  });

  it('机型查询失败禁止提交（直接触发也不发送），重试返回空列表后允许手填', async () => {
    fetchEquipmentModelsMock
      .mockResolvedValueOnce([]) // 初始：空目录 → 手填填写
      .mockRejectedValueOnce(new GraphQLIngressError({ message: 'down', type: 'network' })) // 重试失败
      .mockResolvedValueOnce([]); // 再次重试：仍空 → 恢复手填
    fetchServiceOrganizationsMock.mockResolvedValue(SERVICE_ORG_OPTIONS);
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findByText('暂无已登记的设备型号，请手填本次报修的设备型号。');

    await selectServiceOrg();
    fireEvent.change(screen.getByPlaceholderText('例如：NSR-S622D'), {
      target: { value: 'NSR-S622D' },
    });
    fireEvent.change(screen.getByPlaceholderText('例如：E-2001'), { target: { value: 'E-2001' } });
    fireEvent.change(screen.getByPlaceholderText('请描述设备故障现象与发生场景'), {
      target: { value: '双工件台干涉仪报错' },
    });

    // 重试失败：错误与重试入口出现，查询失败不得当作空目录成功态
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    expect(await screen.findByText('网络连接异常，请稍后重试。')).toBeTruthy();

    // 直接触发 form 提交（不经按钮）：运行时守卫拦截，不发起创建请求
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(await screen.findByText('设备型号目录暂不可用，请稍后重试。')).toBeTruthy();
    expect(createRepairRequestMock).not.toHaveBeenCalled();

    // 重试成功返回空列表：仍是手填模式，已填内容保留，可正常提交
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('例如：NSR-S622D') as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
    expect((screen.getByPlaceholderText('例如：NSR-S622D') as HTMLInputElement).value).toBe(
      'NSR-S622D',
    );

    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    const payload = createRepairRequestMock.mock.calls[0][0];
    expect(payload.equipmentModelText).toBe('NSR-S622D');
    expect('equipmentModelId' in payload).toBe(false);
  });

  it('手填过程中重新加载机型列表：出现已有机型也不自动切换模式或清空已填内容', async () => {
    fetchEquipmentModelsMock.mockResolvedValueOnce([]).mockResolvedValueOnce(MODEL_OPTIONS);
    fetchServiceOrganizationsMock.mockResolvedValue(SERVICE_ORG_OPTIONS);
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findByText('暂无已登记的设备型号，请手填本次报修的设备型号。');

    fireEvent.change(screen.getByPlaceholderText('例如：NSR-S622D'), {
      target: { value: '手填机型X' },
    });
    fireEvent.change(screen.getByPlaceholderText('例如：E-2001'), { target: { value: 'E-2001' } });
    fireEvent.change(screen.getByPlaceholderText('请描述设备故障现象与发生场景'), {
      target: { value: '双工件台干涉仪报错' },
    });

    // 重新加载：列表恢复且出现已有机型
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    // 模式不自动切换：仍是手填输入框（非下拉），切换入口恢复出现，已填内容保留
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());
    expect((screen.getByPlaceholderText('例如：NSR-S622D') as HTMLInputElement).value).toBe(
      '手填机型X',
    );
    expect(document.querySelectorAll('[role="combobox"]').length).toBe(1); // 仅维修厂家

    await selectServiceOrg();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    const payload = createRepairRequestMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      equipmentModelText: '手填机型X',
      errorCode: 'E-2001',
      faultDescription: '双工件台干涉仪报错',
    });
    expect('equipmentModelId' in payload).toBe(false);
  });

  it('维修厂家加载失败时可重试，恢复后即可选择', async () => {
    fetchEquipmentModelsMock.mockResolvedValue(MODEL_OPTIONS);
    fetchServiceOrganizationsMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(SERVICE_ORG_OPTIONS);

    renderForm();

    expect(await screen.findByText('维修厂家列表加载失败，请重试。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    await waitFor(() => expect(isDisabled(serviceOrgCombobox())).toBe(false));
    await selectServiceOrg();
    expect(screen.getAllByText('乙方维修公司（乙方）').length).toBeGreaterThan(0);
  });

  it('无可选维修厂家时展示提示（不提供手工输入厂家）', async () => {
    fetchEquipmentModelsMock.mockResolvedValue(MODEL_OPTIONS);
    fetchServiceOrganizationsMock.mockResolvedValue([]);

    renderForm();

    expect(await screen.findByText('暂无可选的维修厂家，请稍后再试。')).toBeTruthy();
  });
});

describe('提交校验与反馈', () => {
  beforeEach(() => {
    stubReadyQueries();
  });

  it('必填项缺失时拦截提交并提示（含维修厂家）', async () => {
    renderForm();
    await screen.findAllByRole('combobox');

    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('请选择维修厂家')).toBeTruthy();
    // 「请选择设备型号」同时是 Select 占位文案与校验提示，按存在性断言
    expect((await screen.findAllByText('请选择设备型号')).length).toBeGreaterThan(0);
    expect(await screen.findByText('请输入设备错误码')).toBeTruthy();
    expect(await screen.findByText('请输入故障描述')).toBeTruthy();
    expect(createRepairRequestMock).not.toHaveBeenCalled();
  });

  it('创建成功展示后端生成的申请编号，并以稳定提交标识提交', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findAllByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    expect(screen.getByText('申请编号：RR20260826000000ABC123')).toBeTruthy();

    const payload = createRepairRequestMock.mock.calls[0][0];
    expect(payload.recordUuid).toMatch(UUID_PATTERN);
    expect(payload).toMatchObject({
      serviceOrganizationId: 88,
      equipmentModelId: 11,
      errorCode: 'E-2001',
      faultDescription: '双工件台干涉仪报错',
      attachment: null,
    });
    // 选择已有机型：只提交 equipmentModelId，不携带 equipmentModelText
    expect('equipmentModelText' in payload).toBe(false);
  });

  it('选择与手填来回切换后只提交当前模式对应的值', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findAllByRole('combobox');

    // 先切到手填，再切回下拉（另一侧字段被清空，保证二选一不串值）
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByPlaceholderText('例如：NSR-S622D'), {
      target: { value: 'NSR-X' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    // 切回后机型恢复为下拉选择（两个 combobox：机型 + 维修厂家）
    await waitFor(() => expect(document.querySelectorAll('[role="combobox"]').length).toBe(2));

    await selectServiceOrg();
    await selectFirstModel();
    fireEvent.change(screen.getByPlaceholderText('例如：E-2001'), {
      target: { value: 'E-2001' },
    });
    fireEvent.change(screen.getByPlaceholderText('请描述设备故障现象与发生场景'), {
      target: { value: '双工件台干涉仪报错' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    const payload = createRepairRequestMock.mock.calls[0][0];
    expect(payload.equipmentModelId).toBe(11);
    expect('equipmentModelText' in payload).toBe(false);
  });

  it('手填新机型时只发送去空白的 equipmentModelText，不携带 equipmentModelId', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findAllByRole('combobox');
    fireEvent.click(screen.getByRole('checkbox'));
    await selectServiceOrg();
    fireEvent.change(screen.getByPlaceholderText('例如：NSR-S622D'), {
      target: { value: '  NSR-S622D  ' },
    });
    fireEvent.change(screen.getByPlaceholderText('例如：E-2001'), {
      target: { value: 'E-2001' },
    });
    fireEvent.change(screen.getByPlaceholderText('请描述设备故障现象与发生场景'), {
      target: { value: '双工件台干涉仪报错' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    const payload = createRepairRequestMock.mock.calls[0][0];
    expect(payload.equipmentModelId).toBeUndefined();
    expect(payload.equipmentModelText).toBe('NSR-S622D');
    expect('equipmentModelId' in payload).toBe(false);
  });

  it('纯空白机型不得提交：表单校验与应用层守卫双拦截', async () => {
    fetchEquipmentModelsMock.mockResolvedValue([]); // 空目录手填
    fetchServiceOrganizationsMock.mockResolvedValue(SERVICE_ORG_OPTIONS);

    renderForm();
    await screen.findByText('暂无已登记的设备型号，请手填本次报修的设备型号。');

    await selectServiceOrg();
    fireEvent.change(screen.getByPlaceholderText('例如：NSR-S622D'), {
      target: { value: '   ' },
    });
    fireEvent.change(screen.getByPlaceholderText('例如：E-2001'), { target: { value: 'E-2001' } });
    fireEvent.change(screen.getByPlaceholderText('请描述设备故障现象与发生场景'), {
      target: { value: '双工件台干涉仪报错' },
    });

    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('请填写新机型')).toBeTruthy();
    expect(createRepairRequestMock).not.toHaveBeenCalled();
  });

  it('附件上传中不得提交：直接触发提交被运行时守卫拦截', async () => {
    uploadRepairRequestFileMock.mockReturnValue(new Promise(() => {})); // 上传一直在途

    renderForm();
    await screen.findAllByRole('combobox');
    await fillForm();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['pdf'], '报修原件.pdf', { type: 'application/pdf' })] },
    });
    expect(await screen.findByText('报修原件.pdf')).toBeTruthy();

    // 不只检查按钮置灰：直接触发 form 提交同样不得发起创建请求
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);

    // 「上传中…」同时出现在上传按钮与守卫错误提示里，用 findAllByText 断言
    expect((await screen.findAllByText('上传中…')).length).toBeGreaterThan(0);
    expect(createRepairRequestMock).not.toHaveBeenCalled();
  });

  it('成功后继续创建时表单已重置，不会残留旧值', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findAllByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '继续创建' }));

    expect(await screen.findByText('请选择设备型号')).toBeTruthy();
    expect((screen.getByPlaceholderText('例如：E-2001') as HTMLInputElement).value).toBe('');
    expect(
      (screen.getByPlaceholderText('请描述设备故障现象与发生场景') as HTMLTextAreaElement).value,
    ).toBe('');
  });

  it('成功后跳转维修申请列表（T-05：列表能力已落地，替换客户首页临时落点）', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findAllByRole('combobox');
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
    await screen.findAllByRole('combobox');
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
    await screen.findAllByRole('combobox');
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
    await screen.findAllByRole('combobox');
    await fillForm();

    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }));

    expect((screen.getByPlaceholderText('例如：E-2001') as HTMLInputElement).value).toBe('');
    expect(
      (screen.getByPlaceholderText('请描述设备故障现象与发生场景') as HTMLTextAreaElement).value,
    ).toBe('');
    expect(screen.getByText('请选择设备型号')).toBeTruthy();
    expect(isDisabled(screen.getByRole('button', { name: '提交申请' }))).toBe(false);
    expect(createRepairRequestMock).not.toHaveBeenCalled();
  });

  it('提交时对错误码、故障描述与手填机型去首尾空格', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findAllByRole('combobox');
    await selectServiceOrg();
    await selectFirstModel();
    fireEvent.change(screen.getByPlaceholderText('例如：E-2001'), {
      target: { value: '  E-2001  ' },
    });
    fireEvent.change(screen.getByPlaceholderText('请描述设备故障现象与发生场景'), {
      target: { value: '  双工件台干涉仪报错  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    expect(createRepairRequestMock.mock.calls[0][0]).toMatchObject({
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
    await screen.findAllByRole('combobox');
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
    await screen.findAllByRole('combobox');
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
    await screen.findAllByRole('combobox');
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
    await screen.findAllByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('请先在账号设置中补充公司信息后再提交维修申请')).toBeTruthy();
    expect(screen.getByText('补充公司信息后返回本页即可重新提交。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /前往账号设置/ }));

    expect(navigateMock).toHaveBeenCalledWith('/account/settings');
    expect((screen.getByPlaceholderText('例如：E-2001') as HTMLInputElement).value).toBe('E-2001');
  });

  it('其他业务拒绝不出现账号设置跳转入口', async () => {
    createRepairRequestMock.mockResolvedValue({
      ok: false,
      message: '所属公司当前不可用，请联系管理员处理后再提交维修申请',
      reason: 'company-unavailable',
    });

    renderForm();
    await screen.findAllByRole('combobox');
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
    await screen.findAllByRole('combobox');
    await fillForm();

    const submitButton = screen.getByRole('button', { name: '提交申请' });
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(createRepairRequestMock).toHaveBeenCalledTimes(1);
    });
    expect(submitButton.classList.contains('ant-btn-loading')).toBe(true);

    pending.resolve({ ok: true, repairRequest: CREATED_RECORD });
    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
  });
});

describe('提交即出单的幂等与附件', () => {
  beforeEach(() => {
    stubReadyQueries();
  });

  it('失败重发复用同一提交标识（同一份报修只形成一套数据）', async () => {
    createRepairRequestMock
      .mockResolvedValueOnce({ ok: false, message: '网络抖动', reason: 'creation-failed' })
      .mockResolvedValueOnce({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findAllByRole('combobox');
    await fillForm();

    const submitButton = screen.getByRole('button', { name: '提交申请' });
    fireEvent.click(submitButton);
    expect(await screen.findByText('网络抖动')).toBeTruthy();
    fireEvent.click(submitButton);
    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();

    const first = createRepairRequestMock.mock.calls[0][0].recordUuid;
    const second = createRepairRequestMock.mock.calls[1][0].recordUuid;
    expect(first).toMatch(UUID_PATTERN);
    expect(second).toBe(first);
  });

  it('提交成功后换新提交标识，继续创建不会被当成重放', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findAllByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));
    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '继续创建' }));
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));
    await waitFor(() => expect(createRepairRequestMock).toHaveBeenCalledTimes(2));

    const first = createRepairRequestMock.mock.calls[0][0].recordUuid;
    const second = createRepairRequestMock.mock.calls[1][0].recordUuid;
    expect(second).toMatch(UUID_PATTERN);
    expect(second).not.toBe(first);
  });

  it('上传原件成功后提交携带 fileId 与 uploadContextId', async () => {
    uploadRepairRequestFileMock.mockResolvedValue({
      ok: true,
      file: {
        fileId: '9b1f4f9e-9a1e-4b6e-8a10-3f1a2b3c4d5e',
        uploadContextId: '0c9f6c2e-1f1a-4b0d-9a2f-d0e1c2b3a4f5',
        originalFilename: '报修原件.pdf',
        mimeType: 'application/pdf',
        byteSize: 1024,
        checksumSha256: 'a'.repeat(64),
      },
    });
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findAllByRole('combobox');
    await fillForm();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['pdf'], '报修原件.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('报修原件.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    expect(createRepairRequestMock.mock.calls[0][0].attachment).toEqual({
      fileId: '9b1f4f9e-9a1e-4b6e-8a10-3f1a2b3c4d5e',
      uploadContextId: '0c9f6c2e-1f1a-4b0d-9a2f-d0e1c2b3a4f5',
    });
  });

  it('原件上传失败只提示，不阻断提交（按无附件提交）', async () => {
    uploadRepairRequestFileMock.mockResolvedValue({
      ok: false,
      reason: 'file-too-large',
      message: '原件超过 20MB 限制。',
    });
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });

    renderForm();
    await screen.findAllByRole('combobox');
    await fillForm();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['pdf'], '大文件.pdf', { type: 'application/pdf' })] },
    });

    expect(await screen.findByText('原件超过 20MB 限制。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('维修申请创建成功')).toBeTruthy();
    expect(createRepairRequestMock.mock.calls[0][0].attachment).toBeNull();
  });

  it('提交标识冲突时展示重新提交引导，保留表单内容', async () => {
    createRepairRequestMock.mockResolvedValue({
      ok: false,
      message: '同一提交标识的内容与已提交记录不一致，请重新提交',
      reason: 'submission-conflict',
    });

    renderForm();
    await screen.findAllByRole('combobox');
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(
      await screen.findByText('同一提交标识的内容与已提交记录不一致，请重新提交'),
    ).toBeTruthy();
    expect((screen.getByPlaceholderText('例如：E-2001') as HTMLInputElement).value).toBe('E-2001');
    expect(screen.queryByRole('button', { name: /前往账号设置/ })).toBeNull();
  });

  // PR #27 复审：原申请已删除——明确提示并引导重新发起；只在用户点击「重新发起申请」
  // 时换新提交标识，不自动创建新工单
  it('原申请已删除时展示提示与「重新发起申请」入口，明确重新发起后换新提交标识', async () => {
    createRepairRequestMock.mockResolvedValue({
      ok: false,
      message: '原申请已删除，请重新发起维修申请',
      reason: 'submission-deleted',
    });

    renderForm();
    await screen.findAllByRole('combobox');
    await fillForm();

    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(await screen.findByText('原申请已删除，请重新发起维修申请')).toBeTruthy();
    expect(screen.getByText('原申请已删除，请确认后重新发起维修申请。')).toBeTruthy();
    const first = createRepairRequestMock.mock.calls[0][0].recordUuid;

    fireEvent.click(screen.getByRole('button', { name: /重新\s*发起\s*申请/ }));
    expect(screen.queryByText('原申请已删除，请重新发起维修申请')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));
    await waitFor(() => expect(createRepairRequestMock).toHaveBeenCalledTimes(2));

    const second = createRepairRequestMock.mock.calls[1][0].recordUuid;
    expect(second).toMatch(UUID_PATTERN);
    expect(second).not.toBe(first);
  });

  // PR #27 复审：提交中禁止移除附件，保证提交载荷与页面当前展示的有效附件一致
  it('提交进行中时附件移除按钮禁用', async () => {
    uploadRepairRequestFileMock.mockResolvedValue({
      ok: true,
      file: {
        fileId: '9b1f4f9e-9a1e-4b6e-8a10-3f1a2b3c4d5e',
        uploadContextId: '0c9f6c2e-1f1a-4b0d-9a2f-d0e1c2b3a4f5',
        originalFilename: '报修原件.pdf',
        mimeType: 'application/pdf',
        byteSize: 1024,
        checksumSha256: 'a'.repeat(64),
      },
    });
    createRepairRequestMock.mockReturnValue(new Promise(() => {}));

    renderForm();
    await screen.findAllByRole('combobox');
    await fillForm();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['pdf'], '报修原件.pdf', { type: 'application/pdf' })] },
    });
    expect(await screen.findByText('报修原件.pdf')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    await waitFor(() =>
      expect(isDisabled(screen.getByRole('button', { name: /移\s*除/ }))).toBe(true),
    );
  });
});

describe('字段提示与整体规则（2026-09-30 复审：去掉集中式提示栏）', () => {
  beforeEach(() => {
    stubReadyQueries();
  });

  // PR #27 复审：客户公司只读展示实际可信公司名称，不展示虚构公司
  it('客户公司只读展示实际可信公司名称，不提供编辑入口', async () => {
    renderForm();
    await screen.findAllByRole('combobox');

    const companyInput = screen.getByDisplayValue('甲公司') as HTMLInputElement;
    expect(companyInput.disabled).toBe(true);
    expect(screen.getByText('取自账号设置的可信公司信息，不能在此修改')).toBeTruthy();
  });

  it('可信公司名称加载中展示明确状态，不预填任何公司', async () => {
    fetchTrustedCompanyNameMock.mockReturnValue(new Promise(() => {}));

    renderForm();

    const companyInput = screen.getByDisplayValue('正在加载公司信息…') as HTMLInputElement;
    expect(companyInput.disabled).toBe(true);
  });

  it('账号未绑定公司时展示未绑定提示，不当作已绑定', async () => {
    fetchTrustedCompanyNameMock.mockResolvedValue(null);

    renderForm();

    const companyInput = (await screen.findByDisplayValue(
      '账号尚未绑定公司，请先在账号设置中补录',
    )) as HTMLInputElement;
    expect(companyInput.disabled).toBe(true);
    expect(screen.queryByDisplayValue('甲公司')).toBeNull();
  });

  it('可信公司名称加载失败时展示失败状态并可重试', async () => {
    fetchTrustedCompanyNameMock
      .mockRejectedValueOnce(new GraphQLIngressError({ type: 'network', message: 'down' }))
      .mockResolvedValueOnce('甲公司');

    renderForm();

    expect(await screen.findByDisplayValue('网络连接异常，请稍后重试。')).toBeTruthy();
    expect(screen.queryByDisplayValue('甲公司')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    expect(await screen.findByDisplayValue('甲公司')).toBeTruthy();
  });

  it('两个不同公司账号分别展示各自的可信名称', async () => {
    fetchTrustedCompanyNameMock.mockResolvedValueOnce('甲公司');
    const first = renderForm();
    expect(await screen.findByDisplayValue('甲公司')).toBeTruthy();
    first.unmount();

    // 第二个账号（服务端按会话身份返回另一家可信公司）
    fetchTrustedCompanyNameMock.mockResolvedValueOnce('乙公司');
    renderForm();
    expect(await screen.findByDisplayValue('乙公司')).toBeTruthy();
  });

  it('字段小标题旁各挂一条与字段一一对应的短提示，长度口径与 100 / 5000 契约一致', async () => {
    renderForm();
    await screen.findAllByRole('combobox');

    const pairs = [
      { hint: '仅可选择启用且具备维修服务资格的厂家', title: '维修厂家' },
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

    // 提示不得集中塞进某一个字段：每条提示分属不同 Form.Item
    expect(new Set(items).size).toBe(pairs.length);
  });

  it('整体业务规则位于提交按钮附近的操作行，且不再渲染「填写提示」', async () => {
    renderForm();
    await screen.findAllByRole('combobox');

    const rule = screen.getByText('提交后不可修改；未接单可删除');
    const actions = rule.closest('.repair-request-form-actions');

    expect(actions).not.toBeNull();
    expect(within(actions as HTMLElement).getByRole('button', { name: /取\s*消/ })).toBeTruthy();
    expect(within(actions as HTMLElement).getByRole('button', { name: '提交申请' })).toBeTruthy();
    expect(screen.queryByText('填写提示')).toBeNull();
  });
});
