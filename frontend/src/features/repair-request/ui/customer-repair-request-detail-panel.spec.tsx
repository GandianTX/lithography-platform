// src/features/repair-request/ui/customer-repair-request-detail-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 客户工作台右栏维修申请详情面板单测（纯展示组件）。
 *
 * 面板只接收稳定 view state 与回调：本 spec 覆盖加载/失败/就绪三态渲染、
 * 删除入口条件与确认回调、回复模块开关、长文本换行与返回入口分支；
 * 删除命令的时序与导航意图由 widget spec（工作台编排）与
 * application hook spec（时序守卫）覆盖，不在本层重复。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CustomerRepairRequestDetailState,
  RepairRequestDetail,
} from '@/features/repair-request';

import { formatDateTimeMinuteText } from '@/shared/ui/format-date-time';

import type { IntakeAnalysisCustomerView } from '../infrastructure/repair-request-read.types';

import { CustomerRepairRequestDetailPanel } from './customer-repair-request-detail-panel';

const onBackToListMock = vi.fn();
const onDeleteMock = vi.fn();
const onRetryAnalysisMock = vi.fn();

function makeDetail(overrides?: Partial<RepairRequestDetail>): RepairRequestDetail {
  return {
    id: 920001,
    requestNo: 'MOCK-RR-2026-0001',
    errorCode: 'E-STAGE-201',
    faultDescription: '设备异常',
    contentMd: '## 故障现象\n报错。',
    createdAt: '2026-01-10T00:30:00.000Z',
    isAccepted: false,
    acceptedAt: null,
    latestResolutionStatus: null,
    equipmentModel: { id: 48, modelCode: 'M1', modelName: '型号一' },
    responses: [
      {
        id: 960001,
        engineerNickname: '李工',
        resolutionStatus: 'PENDING',
        responseText: '已接单，正在排查。',
        createdAt: '2026-01-11T01:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

/**
 * 以给定 view state 渲染详情面板（deleting / onBackToList 可选）。
 *
 * 面板无会话依赖，纯 props 驱动；反馈端口注入 no-op notify（原件下载反馈
 * 由 widget 编排层承担），返回入口与删除/重试命令均以回调断言，
 * 导航与时序由调用方（工作台）负责。
 */
function renderPanel(
  state: CustomerRepairRequestDetailState,
  options: { deleting?: boolean; onBackToList?: () => void } = {},
) {
  return render(
    <CustomerRepairRequestDetailPanel
      deleting={options.deleting ?? false}
      notify={() => undefined}
      onBackToList={options.onBackToList}
      onDelete={onDeleteMock}
      onRetryAnalysis={onRetryAnalysisMock}
      retryPending={false}
      state={state}
    />,
  );
}

/**
 * 当前可见 Popconfirm 内的确认按钮。
 *
 * AntD 弹层挂在 document.body 上，不随 RTL cleanup 移除（关闭后带 `.ant-popover-hidden`）。
 * 按文本查「确认删除」会命中跨用例残留的节点，故只认「可见容器内的确认按钮」。
 */
const visibleConfirmButtons = () =>
  Array.from(document.querySelectorAll('.ant-popover:not(.ant-popover-hidden)')).flatMap(
    (popover) => Array.from(popover.querySelectorAll('.ant-popconfirm-buttons .ant-btn-primary')),
  );

const deleteButton = () =>
  screen.getByRole('button', { name: /删\s*除\s*申\s*请/ }) as HTMLButtonElement;

beforeEach(() => {
  onBackToListMock.mockReset();
  onDeleteMock.mockReset();
  onRetryAnalysisMock.mockReset();
});

describe('CustomerRepairRequestDetailPanel', () => {
  it('渲染详情字段与回复时间线（只出现昵称，不出现账号 ID）', () => {
    renderPanel({ status: 'ready', detail: makeDetail() });

    expect(screen.getByText('MOCK-RR-2026-0001')).toBeTruthy();
    expect(screen.getByText('E-STAGE-201')).toBeTruthy();
    expect(screen.getByText('李工')).toBeTruthy();
    expect(screen.getByText('已接单，正在排查。')).toBeTruthy();
    expect(screen.queryByText(/engineerAccountId|accountId|920/)).toBeNull();
  });

  it('四摘要条展示设备型号 / 型号代码 / 错误码 / 创建时间', () => {
    renderPanel({ status: 'ready', detail: makeDetail() });

    expect(screen.getByText('设备型号')).toBeTruthy();
    expect(screen.getByText('型号一')).toBeTruthy();
    expect(screen.getByText('型号代码')).toBeTruthy();
    expect(screen.getByText('M1')).toBeTruthy();
    expect(screen.getByText('错误码')).toBeTruthy();
    expect(screen.getByText('创建时间')).toBeTruthy();
    expect(screen.getByText(formatDateTimeMinuteText('2026-01-10T00:30:00.000Z'))).toBeTruthy();
  });

  it('待接单详情展示删除入口，确认后上报 onDelete（不做时序判断）', async () => {
    renderPanel({ status: 'ready', detail: makeDetail() });

    fireEvent.click(deleteButton());
    await waitFor(() => expect(visibleConfirmButtons()).toHaveLength(1));
    fireEvent.click(visibleConfirmButtons()[0]);

    expect(onDeleteMock).toHaveBeenCalledTimes(1);
  });

  it('已接单详情不展示删除入口，也不预留空位', () => {
    renderPanel({
      status: 'ready',
      detail: makeDetail({ isAccepted: true, acceptedAt: '2026-01-11T00:50:00.000Z' }),
    });

    expect(screen.queryByRole('button', { name: /删\s*除\s*申\s*请/ })).toBeNull();
  });

  it('已接单详情在标题区展示接单时间与处理状态标签', () => {
    renderPanel({
      status: 'ready',
      detail: makeDetail({
        isAccepted: true,
        acceptedAt: '2026-01-11T00:50:00.000Z',
        latestResolutionStatus: 'RESOLVED',
      }),
    });

    expect(screen.getByText(formatDateTimeMinuteText('2026-01-11T00:50:00.000Z'))).toBeTruthy();
    expect(screen.getByText('已解决')).toBeTruthy();
  });

  it('删除进行中（deleting）删除入口进入 pending 态', () => {
    renderPanel({ status: 'ready', detail: makeDetail() }, { deleting: true });

    expect(deleteButton().disabled).toBe(true);
  });

  it('不存在 / 非本人 / 已删除统一呈现不可查看态（warning）与返回入口', () => {
    renderPanel(
      { status: 'failed', message: '维修申请不存在或不可查看。', notFound: true },
      { onBackToList: onBackToListMock },
    );

    expect(screen.getByText('维修申请不存在或不可查看。')).toBeTruthy();
    expect(document.querySelector('.ant-alert-warning')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '返回历史列表' }));
    expect(onBackToListMock).toHaveBeenCalledTimes(1);
  });

  it('加载失败（transport 等）展示错误态，区别于不存在', () => {
    renderPanel({
      status: 'failed',
      message: '维修申请详情加载失败，请稍后重试。',
      notFound: false,
    });

    expect(screen.getByText('维修申请详情加载失败，请稍后重试。')).toBeTruthy();
    expect(document.querySelector('.ant-alert-error')).not.toBeNull();
    // 列表态内联详情不传返回入口：失败态不出现返回按钮
    expect(screen.queryByRole('button', { name: '返回历史列表' })).toBeNull();
  });

  it('就绪态提供 onBackToList 时底部渲染返回入口并可回调', () => {
    renderPanel({ status: 'ready', detail: makeDetail() }, { onBackToList: onBackToListMock });

    fireEvent.click(screen.getByRole('button', { name: '返回历史列表' }));
    expect(onBackToListMock).toHaveBeenCalledTimes(1);
  });

  // S0 任务书：0 条回复时整个回复模块不渲染 —— 不得出现标题、计数或占位。
  it('0 条回复时整个回复模块不渲染：无标题、无计数、无空状态占位', () => {
    renderPanel({ status: 'ready', detail: makeDetail({ responses: [] }) });

    expect(screen.queryByText(/工程师回复/)).toBeNull();
    expect(screen.queryByText('暂无工程师回复。')).toBeNull();
    expect(screen.queryByText('李工')).toBeNull();
    expect(screen.queryByText('已接单，正在排查。')).toBeNull();
  });

  it('多条回复按后端给定顺序直接渲染不重排，状态标签与时间来自后端字段', () => {
    renderPanel({
      status: 'ready',
      detail: makeDetail({
        isAccepted: true,
        acceptedAt: '2026-01-11T00:50:00.000Z',
        responses: [
          {
            id: 960001,
            engineerNickname: '王工',
            resolutionStatus: 'PENDING',
            responseText: '排查中。',
            createdAt: '2026-01-11T01:00:00.000Z',
          },
          {
            id: 960002,
            engineerNickname: '李工',
            resolutionStatus: 'RESOLVED',
            responseText: '已解决。',
            createdAt: '2026-01-11T03:30:00.000Z',
          },
        ],
      }),
    });

    // 面板不重排：DOM 顺序与给定顺序一致（先到先显示，PENDING 在前）
    const pendingText = screen.getByText('排查中。');
    const resolvedText = screen.getByText('已解决。');
    expect(
      Boolean(pendingText.compareDocumentPosition(resolvedText) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(screen.getByText('已解决')).toBeTruthy();
    expect(screen.getByText('处理中')).toBeTruthy();
    // S2-7：时间与工程师昵称均来自后端字段，按客户侧统一格式展示
    expect(screen.getByText(formatDateTimeMinuteText('2026-01-11T03:30:00.000Z'))).toBeTruthy();
    expect(screen.getByText(formatDateTimeMinuteText('2026-01-11T01:00:00.000Z'))).toBeTruthy();
    expect(screen.getByText('王工')).toBeTruthy();
  });

  // S2-5：故障描述与回复正文对长连续文本安全换行（几何断言在 e2e 视觉 spec）
  it('故障描述与回复正文携带换行类，不撑破面板', () => {
    renderPanel({
      status: 'ready',
      detail: makeDetail({
        faultDescription: 'E-201'.repeat(120),
        responses: [
          {
            id: 960001,
            engineerNickname: '李工',
            resolutionStatus: 'PENDING',
            responseText: 'a'.repeat(300),
            createdAt: '2026-01-11T01:00:00.000Z',
          },
        ],
      }),
    });

    expect(screen.getByText('E-201'.repeat(120)).classList.contains('break-words')).toBe(true);
    expect(screen.getByText('a'.repeat(300)).classList.contains('break-words')).toBe(true);
  });

  // S2-8：加载态使用与失败/不存在一致的面板骨架，面板内为骨架屏而非空白
  it('加载中呈现面板骨架屏，不出现空白面板', () => {
    const { container } = renderPanel({ status: 'loading' });

    expect(screen.getByText('维修申请详情')).toBeTruthy();
    expect(container.querySelector('.ant-skeleton')).not.toBeNull();
    expect(screen.queryByText('删除申请')).toBeNull();
  });

  // 展示状态与重试入口完全由服务端判定（前端不再自行组合 FAILED + generation）
  describe('首析展示状态与重试资格（服务端判定）', () => {
    const makeAnalysis = (
      overrides?: Partial<IntakeAnalysisCustomerView>,
    ): IntakeAnalysisCustomerView => ({
      status: 'FAILED',
      generation: 0,
      outputText: null,
      finishedAt: null,
      displayState: 'FAILED_RETRYABLE',
      retryEligibility: { eligible: true, reason: 'OWNER_RETRY_AVAILABLE' },
      ...overrides,
    });

    it('服务端判定可重试时渲染「重新分析」并可回调', () => {
      renderPanel({
        status: 'ready',
        detail: makeDetail({ intakeAnalysis: makeAnalysis() }),
      });

      expect(screen.getByText('分析失败（可重新分析）')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '重新分析' }));
      expect(onRetryAnalysisMock).toHaveBeenCalledTimes(1);
    });

    it('FAILED + 代次 0 但服务端判定不可重试：不渲染入口（不再按前端规则推导）', () => {
      renderPanel({
        status: 'ready',
        detail: makeDetail({
          intakeAnalysis: makeAnalysis({
            displayState: 'FAILED_NOT_RETRYABLE',
            retryEligibility: { eligible: false, reason: 'RETRY_ALREADY_USED' },
          }),
        }),
      });

      expect(screen.queryByRole('button', { name: '重新分析' })).toBeNull();
      expect(screen.getByText('首次分析的重试机会已使用。')).toBeTruthy();
    });

    it('缺少可信账本：展示不可用状态与说明，不渲染重试入口', () => {
      renderPanel({
        status: 'ready',
        detail: makeDetail({
          intakeAnalysis: makeAnalysis({
            displayState: 'UNAVAILABLE',
            retryEligibility: { eligible: false, reason: 'LEDGER_INTENT_MISSING' },
          }),
        }),
      });

      expect(screen.getByText('分析状态暂不可用')).toBeTruthy();
      expect(screen.queryByRole('button', { name: '重新分析' })).toBeNull();
      expect(
        screen.getByText('该报修缺少可信的分析记录，暂不支持自助重新分析。'),
      ).toBeTruthy();
    });

    it('分析中：展示运行状态且不渲染重试入口', () => {
      renderPanel({
        status: 'ready',
        detail: makeDetail({
          intakeAnalysis: makeAnalysis({
            status: 'RUNNING',
            displayState: 'RUNNING',
            retryEligibility: { eligible: false, reason: 'ANALYSIS_IN_PROGRESS' },
          }),
        }),
      });

      expect(screen.getByText('分析中')).toBeTruthy();
      expect(screen.queryByRole('button', { name: '重新分析' })).toBeNull();
    });

    it('Seed 样例（WAITING 且无账本）：中性展示「未发起分析」，不当排队、不入队', () => {
      renderPanel({
        status: 'ready',
        detail: makeDetail({
          intakeAnalysis: makeAnalysis({
            status: 'WAITING',
            displayState: 'NOT_STARTED',
            retryEligibility: { eligible: false, reason: 'ANALYSIS_NOT_INITIATED' },
          }),
        }),
      });

      expect(screen.getByText('未发起分析')).toBeTruthy();
      expect(screen.getByText('暂无分析记录。')).toBeTruthy();
      expect(screen.queryByText('等待分析')).toBeNull();
      expect(screen.queryByRole('button', { name: '重新分析' })).toBeNull();
    });

    it('完成态：展示真实正文，不出现「暂无内容」占位与重试入口', () => {
      renderPanel({
        status: 'ready',
        detail: makeDetail({
          intakeAnalysis: makeAnalysis({
            status: 'SUCCEEDED',
            displayState: 'COMPLETED',
            outputText: '建议检查光源功率。',
            retryEligibility: { eligible: false, reason: 'ANALYSIS_SUCCEEDED' },
          }),
        }),
      });

      expect(screen.getByText('建议检查光源功率。')).toBeTruthy();
      expect(screen.queryByText('暂无可展示的分析内容。')).toBeNull();
      expect(screen.queryByRole('button', { name: '重新分析' })).toBeNull();
    });
  });
});
