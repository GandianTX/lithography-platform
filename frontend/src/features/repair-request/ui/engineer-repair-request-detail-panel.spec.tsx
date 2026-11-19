// src/features/repair-request/ui/engineer-repair-request-detail-panel.spec.tsx
// @vitest-environment jsdom

// 编排/状态机逻辑由其自身实现覆盖；本测试只验证面板在各终态下的反馈取舍，
// 因此把编排 hook 桩成确定状态，不触碰真实 adapter 与 GraphQL。
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTranslator, I18nContext, translate } from '@/shared/i18n';
import { formatDateTimeText } from '@/shared/ui/format-date-time';

import type { EngineerRepairRequestDetailState } from '../application/use-engineer-repair-request-detail';
import type {
  AcceptRepairRequestResult,
  CreateEngineerResponseResult,
  EngineerRepairRequestDetail,
  EngineerRepairRequestResponseItem,
} from '../infrastructure/engineer-repair-request.types';

import { EngineerRepairRequestDetailPanel } from './engineer-repair-request-detail-panel';
import { ENGINEER_REPAIR_REQUEST_LIST_PATH } from './engineer-repair-request-paths';

const { flowMock, navigateMock } = vi.hoisted(() => ({
  flowMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../application/use-engineer-repair-request-detail-flow', () => ({
  useEngineerRepairRequestDetailFlow: () => flowMock(),
}));

// 版本历史有独立测试；面板测试只验证挂载位置与可见性，避免真实 GraphQL 读取。
vi.mock('./engineer-repair-version-history', () => ({
  EngineerRepairVersionHistory: () => <div data-testid="engineer-repair-version-history" />,
}));

const CONFLICT_MESSAGE = '该维修申请已被接单，请刷新后查看最新状态';
const NOT_ACCESSIBLE_MESSAGE = '维修申请不存在，或当前账号无权查看。';
/** 默认（中文）语言下按词条真源翻译，避免在测试里复制第二份文案 */
const ENGINEER_RESPONSE_TEXT_OVER_CAPACITY_MESSAGE = translate(
  'zh-CN',
  'engineerDetail.responseTooLong',
);

const READY_DETAIL: EngineerRepairRequestDetail = {
  id: 123,
  requestNo: 'RR-20260902-001',
  errorCode: 'E-0001',
  faultDescription: '光刻机对准模块异常。',
  contentMd: '',
  createdAt: '2026-09-02T08:00:00.000Z',
  isAccepted: false,
  acceptedAt: null,
  latestResolutionStatus: null,
  equipmentModel: { id: 1, modelCode: 'LITHO-100', modelName: '样例光刻机' },
  customerNickname: '林客户',
  customerCompanyName: '林氏精密制造',
  acceptanceViewStatus: 'AVAILABLE',
  acceptedEngineerNickname: null,
  closureStatus: 'OPEN',
  closedAt: null,
  closureReason: null,
  handlingResult: null,
  handlingStatus: null,
  processEntries: [],
  responses: [],
};

function setFlow(
  state: EngineerRepairRequestDetailState,
  lastAcceptResult: AcceptRepairRequestResult | null,
  overrides: {
    submitting?: boolean;
    reconciling?: boolean;
    lastCreateResponseResult?: CreateEngineerResponseResult | null;
  } = {},
) {
  flowMock.mockReturnValue({
    accept: vi.fn(),
    accepting: false,
    lastAcceptResult,
    reload: vi.fn(),
    confirmResponseResult: confirmResponseResultMock,
    submitting: false,
    reconciling: false,
    lastCreateResponseResult: null,
    createResponse: createResponseMock,
    state,
    ...overrides,
  });
}

function isControlDisabled(element: HTMLElement): boolean {
  return (
    (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true'
  );
}

/**
 * 编排桩跨 setFlow 保持同一实例：面板重渲染时才能累加断言调用次数
 * （每次 setFlow 新建桩会让重渲染后的提交落到另一个桩上）。
 */
const createResponseMock = vi.fn();
const confirmResponseResultMock = vi.fn();

describe('工程师详情面板的接单冲突反馈', () => {
  beforeEach(() => {
    flowMock.mockReset();
    navigateMock.mockReset();
  });

  it('接单冲突后重查变为不可访问：仍优先展示冲突提示，并保留返回列表引导', () => {
    setFlow(
      {
        message: NOT_ACCESSIBLE_MESSAGE,
        reason: 'not-accessible',
        requestSeq: 2,
        status: 'failed',
      },
      { message: CONFLICT_MESSAGE, ok: false, reason: 'already-accepted' },
    );

    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    // 冲突提示不被通用不可访问文案掩盖
    expect(screen.getByText(CONFLICT_MESSAGE)).toBeTruthy();
    // 统一不可访问反馈与返回引导仍然保留
    expect(screen.getByText(NOT_ACCESSIBLE_MESSAGE)).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回维修申请列表' })).toBeTruthy();
    // 旧详情不继续展示，自然不残留可点击的接单按钮
    // antd 对两个汉字的按钮插入间距，accessible name 为「接 单」，必须用正则匹配
    expect(screen.queryByRole('button', { name: /接\s*单/ })).toBeNull();
  });

  it('无接单反馈的不可访问态：仅展示统一不可访问反馈', () => {
    setFlow(
      {
        message: NOT_ACCESSIBLE_MESSAGE,
        reason: 'not-accessible',
        requestSeq: 1,
        status: 'failed',
      },
      null,
    );

    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    expect(screen.getByText(NOT_ACCESSIBLE_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(CONFLICT_MESSAGE)).toBeNull();
    expect(screen.getByRole('button', { name: '返回维修申请列表' })).toBeTruthy();
  });
});

/**
 * ready 状态下「返回维修申请列表」按钮与接单状态、查看者角色无关，
 * 以参数化覆盖典型组合，断言固定前往列表路径。
 */
describe('工程师详情面板的返回列表入口', () => {
  beforeEach(() => {
    flowMock.mockReset();
    navigateMock.mockReset();
  });

  const ACCEPTED_DETAIL: EngineerRepairRequestDetail = {
    ...READY_DETAIL,
    isAccepted: true,
    acceptedAt: '2026-09-02T09:00:00.000Z',
    acceptanceViewStatus: 'MINE',
    acceptedEngineerNickname: '陈工',
  };

  it.each([
    ['可接单工程师、未接单', true, READY_DETAIL],
    ['只读账号、未接单', false, READY_DETAIL],
    ['可接单工程师、已接单', true, ACCEPTED_DETAIL],
  ])(
    'ready 状态（%s）：展示返回列表入口且点击后前往列表路径',
    (_label, canHandleAsEngineer, detail) => {
      setFlow({ detail, requestSeq: 1, status: 'ready' }, null);

      render(
        <EngineerRepairRequestDetailPanel
          canHandleAsEngineer={canHandleAsEngineer}
          requestId={123}
        />,
      );

      // 路径断言复用切片路径唯一真源，不在测试里重写字面量
      fireEvent.click(screen.getByRole('button', { name: '返回维修申请列表' }));
      expect(navigateMock).toHaveBeenCalledWith(ENGINEER_REPAIR_REQUEST_LIST_PATH);
    },
  );
});

/**
 * 操作可见性三态矩阵（视角状态 × 会话单值业务角色）与富集字段展示。
 */
describe('工程师详情面板的三态可见性与字段展示', () => {
  beforeEach(() => {
    flowMock.mockReset();
    navigateMock.mockReset();
  });

  function readyFlow(detail: EngineerRepairRequestDetail) {
    setFlow({ detail, requestSeq: 1, status: 'ready' }, null);
  }

  it('ENGINEER + AVAILABLE：展示客户与设备富集字段及接单状态标签', () => {
    readyFlow(READY_DETAIL);
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    expect(screen.getByText('林客户')).toBeTruthy();
    expect(screen.getByText('林氏精密制造')).toBeTruthy();
    expect(screen.getByText('样例光刻机（LITHO-100）')).toBeTruthy();
    expect(screen.getByText('E-0001')).toBeTruthy();
    // 视角胶囊（待接单）与接单工程师/接单时间占位
    expect(document.querySelector('.status-pill')?.textContent).toBe('待接单');
    expect(screen.getByText('接单工程师')).toBeTruthy();
    expect(screen.getByText('接单时间')).toBeTruthy();
  });

  it('不渲染附件区域或任何附件占位能力（附件不属于维修申请功能）', () => {
    readyFlow(READY_DETAIL);
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    // 既无附件文案/占位，也无下载类按钮冒充已完成能力
    expect(screen.queryByText(/附件/)).toBeNull();
    expect(screen.queryByRole('button', { name: /下载/ })).toBeNull();
  });

  it('ENGINEER + TAKEN_BY_OTHER：只读查看，展示真实接单人与接单时间，无写入口', () => {
    readyFlow({
      ...READY_DETAIL,
      isAccepted: true,
      acceptedAt: '2026-09-02T09:30:00.000Z',
      acceptanceViewStatus: 'TAKEN_BY_OTHER',
      acceptedEngineerNickname: '赵工',
    });
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    // 只读提示为事实性状态说明，不出现接单/回复入口
    expect(screen.getByText('该申请已由其他工程师接单跟进，当前为只读查看。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /接\s*单/ })).toBeNull();
    expect(screen.queryByLabelText('回复正文')).toBeNull();
    expect(screen.queryByRole('button', { name: /提交回复/ })).toBeNull();
    // 重查后的真实接单人与时间原样展示，不做乐观伪造
    expect(screen.getByText('赵工')).toBeTruthy();
    expect(screen.getByText(formatDateTimeText('2026-09-02T09:30:00.000Z'))).toBeTruthy();
  });

  it('ENGINEER + 视角状态缺失：失败关闭只读，不出现任何写入口', () => {
    readyFlow({ ...READY_DETAIL, acceptanceViewStatus: null });
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    expect(screen.getByText('该申请的接单状态暂不可用，当前为只读查看。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /接\s*单/ })).toBeNull();
    expect(screen.queryByLabelText('回复正文')).toBeNull();
    expect(screen.queryByRole('button', { name: /提交回复/ })).toBeNull();
  });

  it('SUPER_ADMIN + AVAILABLE：只读查看，提示使用工程师账号，无接单入口', () => {
    readyFlow(READY_DETAIL);
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={false} requestId={123} />);

    expect(screen.getByText('当前账号仅可查看详情，接单与回复需使用工程师账号。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /接\s*单/ })).toBeNull();
    expect(screen.queryByLabelText('回复正文')).toBeNull();
    expect(screen.queryByRole('button', { name: /提交回复/ })).toBeNull();
    expect(screen.getByRole('button', { name: '返回维修申请列表' })).toBeTruthy();
  });

  it('SUPER_ADMIN + TAKEN_BY_OTHER：只读查看且提示账号口径', () => {
    readyFlow({
      ...READY_DETAIL,
      isAccepted: true,
      acceptedAt: '2026-09-02T09:30:00.000Z',
      acceptanceViewStatus: 'TAKEN_BY_OTHER',
      acceptedEngineerNickname: '赵工',
    });
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={false} requestId={123} />);

    expect(screen.getByText('当前账号仅可查看详情，接单与回复需使用工程师账号。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /接\s*单/ })).toBeNull();
    expect(screen.queryByLabelText('回复正文')).toBeNull();
  });
});

/**
 * 回复区域（精确 ENGINEER 且已接单时展示）。
 * 编排 hook 桩成确定状态，验证权限矩阵、草稿归属、禁用态与反馈取舍。
 */
describe('工程师详情面板的回复区域', () => {
  beforeEach(() => {
    flowMock.mockReset();
    navigateMock.mockReset();
    createResponseMock.mockReset();
    confirmResponseResultMock.mockReset();
  });

  const ACCEPTED: EngineerRepairRequestDetailState = {
    detail: {
      ...READY_DETAIL,
      isAccepted: true,
      acceptanceViewStatus: 'MINE',
      acceptedEngineerNickname: '陈工',
    },
    requestSeq: 1,
    status: 'ready',
  };
  const RESPONSE: EngineerRepairRequestResponseItem = {
    id: 61,
    engineerNickname: '陈工',
    resolutionStatus: 'PENDING',
    responseText: '已初步处理',
    createdAt: '2026-09-02T10:00:00.000Z',
  };
  const RESPONSE_FAILED_RESULT: CreateEngineerResponseResult = {
    ok: false,
    reason: 'response-failed',
    message: '处理回复失败，请稍后重试',
  };

  function renderPanel(canHandleAsEngineer: boolean) {
    const view = render(
      <EngineerRepairRequestDetailPanel
        canHandleAsEngineer={canHandleAsEngineer}
        requestId={123}
      />,
    );

    return {
      createMock: createResponseMock,
      confirmMock: confirmResponseResultMock,
      /** 重新 setFlow 后重渲染面板（模拟编排状态推进，表单不卸载） */
      rerenderPanel: () =>
        view.rerender(
          <EngineerRepairRequestDetailPanel
            canHandleAsEngineer={canHandleAsEngineer}
            requestId={123}
          />,
        ),
    };
  }

  function fillDraft(text = '已更换备件，待观察') {
    fireEvent.change(screen.getByLabelText('回复正文'), { target: { value: text } });
  }

  async function selectResolved() {
    fireEvent.mouseDown(screen.getByLabelText('处理状态'));
    fireEvent.click(await screen.findByText('已解决'));
  }

  it('ENGINEER + 未接单：显示接单入口与先接单提示，不显示回复表单', () => {
    setFlow({ detail: READY_DETAIL, requestSeq: 1, status: 'ready' }, null);
    renderPanel(true);

    // antd 对两个汉字的按钮插入间距，accessible name 为「接 单」，用正则匹配
    expect(screen.getByRole('button', { name: /接\s*单/ })).toBeTruthy();
    expect(screen.getByText('请先接单后才能回复该申请。')).toBeTruthy();
    expect(screen.queryByLabelText('回复正文')).toBeNull();
    expect(screen.queryByRole('button', { name: /提交回复/ })).toBeNull();
  });

  it('ENGINEER + 已接单：显示回复表单，不再有接单入口', () => {
    setFlow(ACCEPTED, null);
    renderPanel(true);

    expect(screen.getByLabelText('回复正文')).toBeTruthy();
    expect(screen.getByRole('button', { name: /提交回复/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /接\s*单/ })).toBeNull();
  });

  it('SUPER_ADMIN + 已接单：只读，不显示回复表单与提交入口', () => {
    setFlow(ACCEPTED, null);
    renderPanel(false);

    expect(screen.getByText('当前账号仅可查看详情，接单与回复需使用工程师账号。')).toBeTruthy();
    expect(screen.queryByLabelText('回复正文')).toBeNull();
    expect(screen.queryByRole('button', { name: /提交回复/ })).toBeNull();
  });

  it('正文与状态必填：空表单提交不触发 createResponse 且展示必填提示', async () => {
    setFlow(ACCEPTED, null);
    const { createMock } = renderPanel(true);

    fireEvent.click(screen.getByRole('button', { name: /提交回复/ }));

    expect(await screen.findByText('请输入回复正文。')).toBeTruthy();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('提交 payload 正确：requestId 来自详情，正文原样、状态为选择值', async () => {
    setFlow(ACCEPTED, null);
    const { createMock } = renderPanel(true);

    fillDraft();
    await selectResolved();
    fireEvent.click(screen.getByRole('button', { name: /提交回复/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      requestId: 123,
      responseText: '已更换备件，待观察',
      resolutionStatus: 'RESOLVED',
    });
  });

  it.each([
    ['提交中', { submitting: true }],
    ['自动收敛重查中', { reconciling: true, lastCreateResponseResult: RESPONSE_FAILED_RESULT }],
  ] as const)('%s：正文、状态与提交按钮禁用，防止输入与重复提交', (_label, overrides) => {
    setFlow(ACCEPTED, null, overrides);
    const { createMock } = renderPanel(true);

    expect(isControlDisabled(screen.getByLabelText('回复正文'))).toBe(true);
    expect(isControlDisabled(screen.getByLabelText('处理状态'))).toBe(true);
    // antd 的 loading 按钮不加 disabled 属性（仅 loading 样式 + 内部拦截点击），
    // 因此断言 loading 态并验证点击不会产生提交
    const submitButton = screen.getByRole('button', { name: /提交回复/ });
    expect(submitButton).toHaveClass('ant-btn-loading');
    fireEvent.click(submitButton);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('自动收敛期间「重新加载详情」按钮禁用，不叠加并行手动重查', () => {
    setFlow(ACCEPTED, null, {
      reconciling: true,
      lastCreateResponseResult: RESPONSE_FAILED_RESULT,
    });
    renderPanel(true);

    expect(
      screen.getByText('回复可能已提交成功，请刷新后检查回复时间线，避免重复提交。'),
    ).toBeTruthy();
    expect(isControlDisabled(screen.getByRole('button', { name: '重新加载详情' }))).toBe(true);
  });

  it('成功后正文清空，状态重置为 PENDING（再次提交 payload 可验证）', async () => {
    setFlow(ACCEPTED, null);
    const { createMock, rerenderPanel } = renderPanel(true);

    fillDraft();
    await selectResolved();
    fireEvent.click(screen.getByRole('button', { name: /提交回复/ }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

    // lastResult 收敛为成功 → 表单重置（重渲染模拟编排状态推进，表单不卸载）
    setFlow(ACCEPTED, null, { lastCreateResponseResult: { ok: true, response: RESPONSE } });
    rerenderPanel();

    expect((screen.getByLabelText('回复正文') as HTMLTextAreaElement).value).toBe('');

    // 状态选择重置为初始 PENDING：再次提交不改选择，payload 应为 PENDING
    fireEvent.change(screen.getByLabelText('回复正文'), { target: { value: '补充说明' } });
    fireEvent.click(screen.getByRole('button', { name: /提交回复/ }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(2));
    expect(createMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ resolutionStatus: 'PENDING' }),
    );
  });

  it('确定失败后正文与状态草稿保留，用户无需重新输入', async () => {
    setFlow(ACCEPTED, null);
    const { createMock, rerenderPanel } = renderPanel(true);

    fillDraft();
    await selectResolved();
    fireEvent.click(screen.getByRole('button', { name: /提交回复/ }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

    setFlow(ACCEPTED, null, {
      lastCreateResponseResult: {
        ok: false,
        reason: 'insufficient-permission',
        message: '仅工程师账号可以回复维修申请',
      },
    });
    rerenderPanel();

    expect((screen.getByLabelText('回复正文') as HTMLTextAreaElement).value).toBe(
      '已更换备件，待观察',
    );
    expect(screen.getByText('仅工程师账号可以回复维修申请')).toBeTruthy();
  });

  it('不确定且重查失败：草稿、当前详情与不确定提示都保留', async () => {
    const DETAIL_WITH_RESPONSE: EngineerRepairRequestDetailState = {
      detail: {
        ...READY_DETAIL,
        isAccepted: true,
        acceptanceViewStatus: 'MINE',
        acceptedEngineerNickname: '陈工',
        responses: [RESPONSE],
      },
      requestSeq: 1,
      status: 'ready',
    };
    setFlow(DETAIL_WITH_RESPONSE, null);
    const { rerenderPanel } = renderPanel(true);

    fillDraft();
    setFlow(DETAIL_WITH_RESPONSE, null, { lastCreateResponseResult: RESPONSE_FAILED_RESULT });
    rerenderPanel();

    // 草稿与详情时间线保留
    expect((screen.getByLabelText('回复正文') as HTMLTextAreaElement).value).toBe(
      '已更换备件，待观察',
    );
    expect(screen.getByText('已初步处理')).toBeTruthy();
    // 不确定提示保留，重查入口可用（未在收敛中）
    expect(
      screen.getByText('回复可能已提交成功，请刷新后检查回复时间线，避免重复提交。'),
    ).toBeTruthy();
    expect(isControlDisabled(screen.getByRole('button', { name: '重新加载详情' }))).toBe(false);
  });

  it('手动「重新加载详情」调用 confirmResponseResult，不调用 Mutation', async () => {
    setFlow(ACCEPTED, null, { lastCreateResponseResult: RESPONSE_FAILED_RESULT });
    const { createMock, confirmMock } = renderPanel(true);

    fireEvent.click(screen.getByRole('button', { name: '重新加载详情' }));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('手动重查期间（reconciling）正文、状态、提交与重新加载按钮均禁用', () => {
    setFlow(ACCEPTED, null, {
      reconciling: true,
      lastCreateResponseResult: RESPONSE_FAILED_RESULT,
    });
    renderPanel(true);

    expect(isControlDisabled(screen.getByLabelText('回复正文'))).toBe(true);
    expect(isControlDisabled(screen.getByLabelText('处理状态'))).toBe(true);
    expect(screen.getByRole('button', { name: /提交回复/ })).toHaveClass('ant-btn-loading');
    expect(isControlDisabled(screen.getByRole('button', { name: '重新加载详情' }))).toBe(true);
  });

  it('正文超过 UTF-8 容量：显示明确错误，不调用 Mutation，草稿保留', async () => {
    setFlow(ACCEPTED, null);
    const { createMock } = renderPanel(true);

    const overCapacity = 'a'.repeat(65536);
    fireEvent.change(screen.getByLabelText('回复正文'), { target: { value: overCapacity } });
    fireEvent.click(screen.getByRole('button', { name: /提交回复/ }));

    expect(await screen.findByText(ENGINEER_RESPONSE_TEXT_OVER_CAPACITY_MESSAGE)).toBeTruthy();
    expect(createMock).not.toHaveBeenCalled();
    // 草稿仍在输入框中
    expect((screen.getByLabelText('回复正文') as HTMLTextAreaElement).value).toBe(overCapacity);
  });

  it('正文恰为 65,535 UTF-8 字节：校验通过并调用 Mutation', async () => {
    setFlow(ACCEPTED, null);
    const { createMock } = renderPanel(true);

    const maxLegal = 'a'.repeat(65535);
    fireEvent.change(screen.getByLabelText('回复正文'), { target: { value: maxLegal } });
    fireEvent.click(screen.getByRole('button', { name: /提交回复/ }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ responseText: maxLegal }));
  });

  it('后端返回 BAD_USER_INPUT（invalid-input）：展示正文过长提示、保留草稿，不调用静默重查', () => {
    setFlow(ACCEPTED, null, {
      lastCreateResponseResult: {
        ok: false,
        reason: 'invalid-input',
        message: ENGINEER_RESPONSE_TEXT_OVER_CAPACITY_MESSAGE,
      },
    });
    const { confirmMock } = renderPanel(true);

    fillDraft();

    expect(screen.getByText(ENGINEER_RESPONSE_TEXT_OVER_CAPACITY_MESSAGE)).toBeTruthy();
    expect((screen.getByLabelText('回复正文') as HTMLTextAreaElement).value).toBe(
      '已更换备件，待观察',
    );
    // invalid-input 不出现「重新加载详情」入口，也不自动调用静默重查
    expect(screen.queryByRole('button', { name: '重新加载详情' })).toBeNull();
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

/**
 * 单卡片合并（负责人单卡片计划 P1/P2）：就绪态只渲染一张公共业务卡片
 * （DataCard → section.data-card），申请信息、故障描述、可选的补充说明、
 * 回复时间线与操作区都是这张卡片内部的分区，返回列表入口固定在卡片底部。
 * 断言用「内容必须落在同一张卡片内」而非仅数量，卡片被拆散时包含断言即失败。
 */
describe('工程师详情面板的单卡片结构', () => {
  beforeEach(() => {
    flowMock.mockReset();
    navigateMock.mockReset();
  });

  /** 页面内全部公共业务卡片容器 */
  function businessCards(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('section.data-card'));
  }

  const ACCEPTED_DETAIL: EngineerRepairRequestDetail = {
    ...READY_DETAIL,
    isAccepted: true,
    acceptedAt: '2026-09-02T09:00:00.000Z',
    acceptanceViewStatus: 'MINE',
    acceptedEngineerNickname: '陈工',
  };

  const HISTORY_RESPONSE: EngineerRepairRequestResponseItem = {
    id: 61,
    engineerNickname: '陈工',
    resolutionStatus: 'PENDING',
    responseText: '已初步处理，等待备件',
    createdAt: '2026-09-02T10:00:00.000Z',
  };

  it('精确 ENGINEER + 未接单：唯一卡片内含申请明细、分区标题与接单入口', () => {
    setFlow({ detail: READY_DETAIL, requestSeq: 1, status: 'ready' }, null);
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    const cards = businessCards();

    expect(cards).toHaveLength(1);
    const [card] = cards;

    expect(card.contains(screen.getByText('林客户'))).toBe(true);
    expect(card.contains(screen.getByText('光刻机对准模块异常。'))).toBe(true);
    // 卡片内小标题保留原分区语义（不新增第二张卡片承载它们）
    expect(card.contains(screen.getByText('故障描述'))).toBe(true);
    expect(card.contains(screen.getByText('客户可见回复'))).toBe(true);
    expect(card.contains(screen.getByText('接单'))).toBe(true);
    expect(card.contains(screen.getByText('结单状态'))).toBe(true);
    expect(card.contains(screen.getByText('未结单'))).toBe(true);
    expect(card.contains(screen.getByRole('button', { name: /接\s*单/ }))).toBe(true);
    // 返回列表入口固定在卡片底部（仍在卡片内）
    expect(card.contains(screen.getByRole('button', { name: '返回维修申请列表' }))).toBe(true);
    // 未接单不提供回复表单
    expect(screen.queryByLabelText('回复正文')).toBeNull();
  });

  it('结单字段缺失：详情按不可确认展示，不写成未结单', () => {
    setFlow(
      {
        detail: { ...READY_DETAIL, closureStatus: undefined, closedAt: undefined },
        requestSeq: 1,
        status: 'ready',
      },
      null,
    );
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    expect(screen.getByText('结单状态未知（数据缺失）')).toBeTruthy();
    expect(screen.queryByText('未结单')).toBeNull();
  });

  it('结单状态与时间矛盾：详情按不可确认展示，不推断为已结单', () => {
    setFlow(
      {
        detail: { ...READY_DETAIL, closureStatus: 'CLOSED', closedAt: null },
        requestSeq: 1,
        status: 'ready',
      },
      null,
    );
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    expect(screen.getByText('结单状态未知（数据缺失）')).toBeTruthy();
    expect(screen.queryByText('已结单')).toBeNull();
  });

  it('本人已接单：旧内部维修过程只读展示，写入口不再显示，客户可见回复与版本历史保留', () => {
    setFlow(
      {
        detail: {
          ...ACCEPTED_DETAIL,
          processEntries: [
            {
              createdAt: '2026-09-02T10:00:00.000Z',
              entryUuid: '11111111-1111-4111-8111-111111111111',
              file: null,
              fileId: null,
              id: '71',
              occurredAt: '2026-09-02T10:00:00.000Z',
              operationText: '检查对准模块并记录测试结果',
              requestId: 123,
              testResult: '测试通过',
              timeSource: 'MANUAL',
              versionNo: 1,
            },
          ],
          responses: [HISTORY_RESPONSE],
        },
        requestSeq: 1,
        status: 'ready',
      },
      null,
    );
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    // 旧「内部维修过程／新增维修过程／执行操作／事件时间」写入口全部移除
    expect(screen.queryByText('内部维修过程')).toBeNull();
    expect(screen.queryByText('新增维修过程')).toBeNull();
    expect(screen.queryByText('执行操作')).toBeNull();
    expect(screen.queryByText('事件时间')).toBeNull();
    // 旧过程改以只读历史展示（展示与授权下载复用，不挂载旧编辑组件）
    expect(screen.getByText(translate('zh-CN', 'engineerDetail.legacyProcessTitle'))).toBeTruthy();
    expect(screen.getByText('检查对准模块并记录测试结果')).toBeTruthy();
    expect(screen.getByText(/测试事实：测试通过/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();

    // 客户可见回复保持独立展示，不被旧模块移除影响
    expect(screen.getByText('客户可见回复')).toBeTruthy();
    expect(screen.getByText(HISTORY_RESPONSE.responseText)).toBeTruthy();
    // 页面底部仍挂载版本历史卡片（接单工程师本人视角）
    expect(screen.getByTestId('engineer-repair-version-history')).toBeTruthy();
  });

  it('非接单人视角不挂载版本历史（避免无权限查询）', () => {
    setFlow(
      {
        detail: {
          ...ACCEPTED_DETAIL,
          acceptanceViewStatus: 'TAKEN_BY_OTHER',
          acceptedEngineerNickname: '赵工',
        },
        requestSeq: 1,
        status: 'ready',
      },
      null,
    );
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    expect(screen.queryByTestId('engineer-repair-version-history')).toBeNull();
  });

  it('精确 ENGINEER + 本人已接单：唯一卡片内含回复表单与历史时间线', () => {
    setFlow(
      {
        detail: { ...ACCEPTED_DETAIL, responses: [HISTORY_RESPONSE] },
        requestSeq: 1,
        status: 'ready',
      },
      null,
    );
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    const cards = businessCards();

    expect(cards).toHaveLength(1);
    const [card] = cards;

    expect(card.contains(screen.getByLabelText('回复正文'))).toBe(true);
    expect(card.contains(screen.getByText(HISTORY_RESPONSE.responseText))).toBe(true);
    expect(card.contains(screen.getByRole('button', { name: /提交回复/ }))).toBe(true);
    expect(screen.queryByRole('button', { name: /接\s*单/ })).toBeNull();
  });

  it('精确 ENGINEER + 他人已接单：唯一卡片只读，无任何写入口', () => {
    setFlow(
      {
        detail: {
          ...ACCEPTED_DETAIL,
          acceptanceViewStatus: 'TAKEN_BY_OTHER',
          acceptedEngineerNickname: '赵工',
        },
        requestSeq: 1,
        status: 'ready',
      },
      null,
    );
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    const cards = businessCards();

    expect(cards).toHaveLength(1);
    const [card] = cards;

    expect(card.contains(screen.getByText('该申请已由其他工程师接单跟进，当前为只读查看。'))).toBe(
      true,
    );
    expect(card.contains(screen.getByText('赵工'))).toBe(true);
    expect(screen.queryByLabelText('回复正文')).toBeNull();
    expect(screen.queryByRole('button', { name: /接\s*单/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /提交回复/ })).toBeNull();
  });

  it('管理员视角 + 已接单：唯一卡片只读，提示使用工程师账号', () => {
    setFlow({ detail: ACCEPTED_DETAIL, requestSeq: 1, status: 'ready' }, null);
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={false} requestId={123} />);

    const cards = businessCards();

    expect(cards).toHaveLength(1);
    const [card] = cards;

    expect(
      card.contains(screen.getByText('当前账号仅可查看详情，接单与回复需使用工程师账号。')),
    ).toBe(true);
    expect(screen.queryByLabelText('回复正文')).toBeNull();
    expect(screen.queryByRole('button', { name: /接\s*单/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /提交回复/ })).toBeNull();
    expect(card.contains(screen.getByRole('button', { name: '返回维修申请列表' }))).toBe(true);
  });

  it.each([
    ['contentMd 有值', '客户补充：已重启设备。', true],
    ['contentMd 为空', '', false],
  ])('补充说明分区随 %s 出现或消失，仍是同一张卡片', (_label, contentMd, visible) => {
    setFlow({ detail: { ...READY_DETAIL, contentMd }, requestSeq: 1, status: 'ready' }, null);
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    expect(businessCards()).toHaveLength(1);
    expect(screen.queryByText('补充说明') === null).toBe(!visible);
  });

  it('接单成功后仍是唯一卡片：成功反馈、回复入口与返回入口都在卡片内', () => {
    setFlow(
      { detail: ACCEPTED_DETAIL, requestSeq: 1, status: 'ready' },
      {
        detail: ACCEPTED_DETAIL,
        ok: true,
      },
    );
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    const cards = businessCards();

    expect(cards).toHaveLength(1);
    const [card] = cards;

    expect(card.contains(screen.getByText('你已接单该维修申请，后续请跟进处理。'))).toBe(true);
    expect(card.contains(screen.getByLabelText('回复正文'))).toBe(true);
    expect(card.contains(screen.getByRole('button', { name: '返回维修申请列表' }))).toBe(true);
  });
});

describe('工程师详情英文展示', () => {
  beforeEach(() => {
    flowMock.mockReset();
    navigateMock.mockReset();
  });

  function renderEnglish(canHandleAsEngineer: boolean) {
    return render(
      <I18nContext.Provider
        value={{
          language: 'en',
          setLanguage: vi.fn(),
          t: createTranslator('en'),
        }}
      >
        <EngineerRepairRequestDetailPanel
          canHandleAsEngineer={canHandleAsEngineer}
          requestId={123}
        />
      </I18nContext.Provider>,
    );
  }

  it('已结单详情：7 处字段、状态值与客户回复空态按英文展示，不回落中文硬编码', () => {
    setFlow(
      {
        detail: {
          ...READY_DETAIL,
          closureStatus: 'CLOSED',
          closedAt: '2026-11-19T03:33:44.000Z',
          closureReason: '客户确认修复',
          handlingResult: 'FIXED',
          handlingStatus: 'COMPLETED',
        },
        requestSeq: 1,
        status: 'ready',
      },
      null,
    );
    renderEnglish(false);

    for (const text of [
      'Closure status',
      'Closed at',
      'Closure reason',
      'Handling result',
      'Handling status',
      'Customer-visible replies',
      'Handling notes',
      'Closed',
      'Fault fixed',
      'Completed',
      'No engineer replies yet.',
    ]) {
      expect(screen.getByText(text)).toBeTruthy();
    }

    for (const hardcoded of [
      '结单状态',
      '结单时间',
      '结单原因',
      '处理结果',
      '处理状态',
      '客户可见回复',
      '处理说明',
      '已结单',
      '故障修复',
      '已完成',
      '暂无工程师回复。',
    ]) {
      expect(screen.queryByText(hardcoded)).toBeNull();
    }
  });

  it('未结单空态：Open 与 Not recorded 随语言切换', () => {
    setFlow({ detail: READY_DETAIL, requestSeq: 1, status: 'ready' }, null);
    renderEnglish(false);

    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getAllByText('Not recorded')).toHaveLength(2);
    expect(screen.queryByText('未结单')).toBeNull();
    expect(screen.queryByText('未记录')).toBeNull();
  });
});
/**
 * P2-2：旧维修历史（只读）只在接单工程师本人视角、且详情确有 processEntries 时展示；
 * 结单前后都可见，非接单人视角即使收到数据也不渲染内部历史。
 */
describe('工程师详情面板的旧维修历史（只读）', () => {
  beforeEach(() => {
    flowMock.mockReset();
    navigateMock.mockReset();
  });

  const LEGACY_ENTRY = {
    id: '101',
    entryUuid: '4f0c5f6a-1111-4111-8111-111111111111',
    requestId: 123,
    operationText: '更换干涉仪镜片',
    testResult: '复测通过',
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
    versionNo: 1,
    createdAt: '2026-11-14T03:05:00.000Z',
  };

  const MINE_OPEN_DETAIL: EngineerRepairRequestDetail = {
    ...READY_DETAIL,
    isAccepted: true,
    acceptedAt: '2026-09-02T09:00:00.000Z',
    acceptanceViewStatus: 'MINE',
    acceptedEngineerNickname: '陈工',
    processEntries: [LEGACY_ENTRY],
  };

  const LEGACY_TITLE = translate('zh-CN', 'engineerDetail.legacyProcessTitle');

  it('处理中可见旧维修历史与已绑定原件', () => {
    setFlow({ detail: MINE_OPEN_DETAIL, requestSeq: 1, status: 'ready' }, null);
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    expect(screen.getByText(LEGACY_TITLE)).toBeTruthy();
    expect(screen.getByText('更换干涉仪镜片')).toBeTruthy();
    expect(screen.getByText('现场照片.jpg')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下载原件' })).toBeTruthy();
  });

  it('结单后旧维修历史仍可见（只读）', () => {
    setFlow(
      {
        detail: {
          ...MINE_OPEN_DETAIL,
          closureStatus: 'CLOSED',
          closedAt: '2026-11-19T03:33:44.000Z',
          handlingResult: 'FIXED',
          handlingStatus: 'COMPLETED',
        },
        requestSeq: 1,
        status: 'ready',
      },
      null,
    );
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    expect(screen.getByText(LEGACY_TITLE)).toBeTruthy();
    expect(screen.getByText('更换干涉仪镜片')).toBeTruthy();
    // 结单后不再提供结单入口，历史区本身也没有编辑入口
    expect(screen.queryByRole('button', { name: /^结\s*单$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });

  it('非接单人视角不展示内部历史，即使响应里带了旧过程数据', () => {
    setFlow(
      {
        detail: {
          ...MINE_OPEN_DETAIL,
          acceptanceViewStatus: 'TAKEN_BY_OTHER',
          acceptedEngineerNickname: '其他工程师',
        },
        requestSeq: 1,
        status: 'ready',
      },
      null,
    );
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={false} requestId={123} />);

    expect(screen.queryByText(LEGACY_TITLE)).toBeNull();
    expect(screen.queryByText('更换干涉仪镜片')).toBeNull();
    expect(screen.queryByRole('button', { name: '下载原件' })).toBeNull();
  });

  it('没有旧过程时整块不出现', () => {
    setFlow(
      {
        detail: { ...MINE_OPEN_DETAIL, processEntries: [] },
        requestSeq: 1,
        status: 'ready',
      },
      null,
    );
    render(<EngineerRepairRequestDetailPanel canHandleAsEngineer={true} requestId={123} />);

    expect(screen.queryByText(LEGACY_TITLE)).toBeNull();
  });
});
