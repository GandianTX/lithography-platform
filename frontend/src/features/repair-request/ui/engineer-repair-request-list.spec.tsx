// src/features/repair-request/ui/engineer-repair-request-list.spec.tsx
// @vitest-environment jsdom

/**
 * 工程师列表面板 UI 单测。
 *
 * 走真实面板 + 真实列表 query 状态机，只 mock 外部 GraphQL adapter 与路由跳转；
 * scope 取值、空态文案与分页行为均由生产组件决定，测试不复制规则。
 *
 * 重点覆盖：
 * - 默认 ALL 与四段选项；切换范围回第 1 页；
 * - 设备型号（筛选展开区）/ 客户昵称主搜索（防抖自动应用）筛选，
 *   选项与值来自后端真实查询，筛选回第 1 页与清除；
 * - 9 个展示字段与状态标签；行点击跳详情；
 * - 加载 / 失败重试 / 四态全局空态 / 筛选无结果 / 当前页空态。
 */

import { useMemo, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';
import { type AppLanguage, createTranslator, I18nContext } from '@/shared/i18n';
import { formatDateTimeText } from '@/shared/ui/format-date-time';

import type {
  EngineerRepairListScope,
  EngineerRepairRequestListItem,
  EngineerRepairRequestPage,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';
import * as repairRequestAdapter from '../infrastructure/repair-request-adapter';

import { EngineerRepairRequestList, SEARCH_DEBOUNCE_MS } from './engineer-repair-request-list';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    fetchEngineerRepairRequests: vi.fn(),
  };
});

vi.mock('../infrastructure/repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof repairRequestAdapter>();

  return {
    ...actual,
    fetchEquipmentModels: vi.fn(),
  };
});

const navigateMock = vi.fn();

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

const fetchMock = vi.mocked(engineerRepairRequestAdapter.fetchEngineerRepairRequests);
const fetchModelsMock = vi.mocked(repairRequestAdapter.fetchEquipmentModels);

const NO_FILTER = { equipmentModelId: null, customerNickname: null };

function buildItem(
  id: number,
  overrides: Partial<EngineerRepairRequestListItem> = {},
): EngineerRepairRequestListItem {
  return {
    id,
    requestNo: `RR20260902100000ABC${id}`,
    equipmentModel: { id: 3, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
    errorCode: 'E-100',
    createdAt: '2026-09-02T08:00:00.000Z',
    isAccepted: false,
    acceptedAt: null,
    latestResolutionStatus: null,
    customerNickname: '林客户',
    customerCompanyName: null,
    acceptanceViewStatus: 'AVAILABLE',
    acceptedEngineerNickname: null,
    closureStatus: null,
    closedAt: null,
    handlingResult: null,
    handlingStatus: null,
    ...overrides,
  };
}

function buildPage(
  items: EngineerRepairRequestListItem[],
  total = items.length,
  page = 1,
  pageSize = 10,
): EngineerRepairRequestPage {
  return { items, total, page, pageSize };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchModelsMock.mockReset();
  navigateMock.mockReset();
  // 设备型号选项默认可用（具体测试按需覆盖）
  fetchModelsMock.mockResolvedValue([
    { id: 7, modelCode: 'LITHO-9000S', modelName: '光刻机 9000S' },
  ]);
});

describe('EngineerRepairRequestList', () => {
  it('加载中展示加载态，就绪后展示列表行的全部展示字段与状态胶囊', async () => {
    let resolveList: (value: EngineerRepairRequestPage) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise<EngineerRepairRequestPage>((resolve) => {
        resolveList = resolve;
      }),
    );

    render(<EngineerRepairRequestList />);

    expect(document.querySelector('.loading-state')).toBeTruthy();
    expect(screen.queryByText('RR20260902100000ABC21')).toBeNull();

    await act(async () => {
      resolveList(
        buildPage([
          buildItem(21, {
            isAccepted: true,
            acceptedAt: '2026-09-02T08:30:00.000Z',
            latestResolutionStatus: 'PENDING',
            customerNickname: '林客户',
            customerCompanyName: '林氏精密制造',
            acceptanceViewStatus: 'MINE',
            acceptedEngineerNickname: '陈工',
          }),
        ]),
      );
    });

    await screen.findByText('RR20260902100000ABC21');
    expect(document.querySelector('.loading-state')).toBeNull();
    // 9 个展示字段：申请编号 / 提交时间 / 客户昵称 / 客户公司 / 设备型号 / 错误码 / 状态 / 接单工程师 / 接单时间
    expect(screen.getByText(formatDateTimeText('2026-09-02T08:00:00.000Z'))).toBeTruthy();
    expect(screen.getByText('林客户')).toBeTruthy();
    expect(screen.getByText('林氏精密制造')).toBeTruthy();
    expect(screen.getByText('光刻机 9000（LITHO-9000）')).toBeTruthy();
    expect(screen.getByText('E-100')).toBeTruthy();
    expect(screen.getByText('陈工')).toBeTruthy();
    expect(screen.getByText(formatDateTimeText('2026-09-02T08:30:00.000Z'))).toBeTruthy();
    // 处理进度列：视角胶囊（我的接单）+ 处理状态胶囊（处理中）
    const pillTexts = Array.from(document.querySelectorAll('.status-pill')).map(
      (pill) => pill.textContent,
    );
    expect(pillTexts).toContain('我的接单');
    expect(pillTexts).toContain('处理中');
    expect(screen.getByText('共 1 条')).toBeTruthy();
  });

  it('工单主状态联合判定结单事实：明确未结单、已结单中断、合法空值与字段缺失可区分', async () => {
    fetchMock.mockResolvedValue(
      buildPage([
        buildItem(31, {
          isAccepted: true,
          closureStatus: 'OPEN',
          closedAt: null,
          handlingResult: 'FIXED',
          handlingStatus: 'COMPLETED',
          latestResolutionStatus: 'RESOLVED',
        }),
        buildItem(32, {
          isAccepted: true,
          closureStatus: 'CLOSED',
          closedAt: '2026-09-02T09:00:00.000Z',
          handlingResult: 'INTERRUPTED',
          handlingStatus: 'IN_PROGRESS',
          latestResolutionStatus: 'PENDING',
        }),
        buildItem(33, {
          isAccepted: true,
          closureStatus: null,
          closedAt: null,
          handlingResult: null,
          handlingStatus: null,
        }),
        buildItem(34, {
          isAccepted: true,
          closureStatus: undefined,
          closedAt: undefined,
          handlingResult: null,
          handlingStatus: null,
        }),
      ]),
    );

    render(<EngineerRepairRequestList />);

    await screen.findByText('RR20260902100000ABC31');
    // 明确 OPEN 与显式 null/null（数据库合法未结单）都显示「未结单」
    expect(screen.getAllByText('未结单')).toHaveLength(2);
    expect(screen.getByText('处理状态：已完成')).toBeTruthy();
    // 已结单但最后回复仍为「处理中」：列表主状态仍是已结单，回复状态单独展示
    expect(screen.getByText('已结单 · 维修中断')).toBeTruthy();
    expect(screen.getByText('处理中')).toBeTruthy();
    expect(screen.queryByText('处理状态：处理中')).toBeNull();
    // 字段缺失不得写成未结单
    expect(screen.getByText('结单状态未知')).toBeTruthy();
    expect(screen.getByText('结单状态未知 · 处理状态：未记录')).toBeTruthy();
  });

  it.each<EngineerRepairListScope>(['ALL', 'AVAILABLE', 'MINE', 'TAKEN_BY_OTHER'])(
    '按 initialScope=%s 加载，范围为空时展示该范围专属空态',
    async (scope) => {
      fetchMock.mockResolvedValue(buildPage([], 0));

      render(<EngineerRepairRequestList initialScope={scope} />);

      await screen.findByText(
        {
          ALL: '暂无维修申请。',
          AVAILABLE: '暂无待接单的维修申请。',
          MINE: '暂无你的接单记录。',
          TAKEN_BY_OTHER: '暂无他人已接单的维修申请。',
        }[scope],
      );
      expect(fetchMock).toHaveBeenCalledWith({ scope, filter: NO_FILTER, page: 1, pageSize: 10 });
      // 无筛选时空态互斥：不得同时展示其他范围或筛选维度的空文案
      expect(screen.queryByText('没有符合筛选条件的维修申请。')).toBeNull();
    },
  );

  it('四段范围选项可切换：切换到「我的接单」后回到第 1 页并按 MINE 请求', async () => {
    fetchMock.mockResolvedValue(buildPage([buildItem(21)], 12));

    render(<EngineerRepairRequestList />);
    await screen.findByText('RR20260902100000ABC21');

    // 先翻页，再切换范围：页码必须重置为 1
    fireEvent.click(screen.getByTitle('2'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'ALL',
        filter: NO_FILTER,
        page: 2,
        pageSize: 10,
      }),
    );

    fireEvent.click(screen.getByText('我的接单'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'MINE',
        filter: NO_FILTER,
        page: 1,
        pageSize: 10,
      }),
    );
  });

  it('设备型号筛选：选项来自后端真实查询，选择后按等值筛选回到第 1 页', async () => {
    fetchMock.mockResolvedValue(buildPage([buildItem(21)], 12));

    render(<EngineerRepairRequestList />);
    await screen.findByText('RR20260902100000ABC21');

    // 设备型号收在筛选展开区内：展开后 Select 才存在
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    // 模型选项加载完成后 Select 才可用
    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('光刻机 9000S（LITHO-9000S）'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'ALL',
        filter: { equipmentModelId: 7, customerNickname: null },
        page: 1,
        pageSize: 10,
      }),
    );
  });

  it('设备型号加载失败展示警告与重试入口，重试期间回到 loading 防连点', async () => {
    fetchMock.mockResolvedValue(buildPage([buildItem(21)]));
    fetchModelsMock.mockRejectedValueOnce(new Error('model options boom'));

    render(<EngineerRepairRequestList />);
    await screen.findByText('设备型号加载失败，请稍后重试。');
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    expect(screen.getByRole('combobox')).toBeDisabled();

    fetchModelsMock.mockResolvedValueOnce([
      { id: 7, modelCode: 'LITHO-9000S', modelName: '光刻机 9000S' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    // 重试点击后立即回到 loading：警告 Alert 与重试按钮随之卸载（防连点），Select 保持禁用
    expect(screen.queryByText('设备型号加载失败，请稍后重试。')).toBeNull();
    expect(screen.getByRole('combobox')).toBeDisabled();

    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
  });

  it('昵称主搜索：防抖到期后 trim 提交并回第 1 页；展开区清除筛选恢复无筛选', async () => {
    fetchMock.mockResolvedValue(buildPage([buildItem(21)], 12));

    render(<EngineerRepairRequestList />);
    await screen.findByText('RR20260902100000ABC21');

    // 先翻页，验证筛选变化把页码拉回第 1 页
    fireEvent.click(screen.getByTitle('2'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'ALL',
        filter: NO_FILTER,
        page: 2,
        pageSize: 10,
      }),
    );

    const input = screen.getByPlaceholderText('按客户昵称搜索');
    fireEvent.change(input, { target: { value: '  林客户  ' } });

    // 输入即时回显，但防抖窗口内不提交（最后一次请求仍是翻页请求）
    expect((input as HTMLInputElement).value).toBe('  林客户  ');
    expect(fetchMock).toHaveBeenLastCalledWith({
      scope: 'ALL',
      filter: NO_FILTER,
      page: 2,
      pageSize: 10,
    });

    // 防抖到期后自动应用：trim 后传值，页码回第 1 页
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'ALL',
        filter: { equipmentModelId: null, customerNickname: '林客户' },
        page: 1,
        pageSize: 10,
      }),
    );

    // 清除筛选入口位于筛选展开区内
    const callsBeforeClear = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'ALL',
        filter: NO_FILTER,
        page: 1,
        pageSize: 10,
      }),
    );
    expect((input as HTMLInputElement).value).toBe('');

    // 清除后等待超过一个防抖窗口：防抖值已同步复位，旧昵称不得被回填成额外请求
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 100));
    expect(fetchMock.mock.calls.slice(callsBeforeClear)).toHaveLength(1);
  });

  it('加载失败展示共享错误文案与重试入口，重试沿用当前范围', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    fetchMock.mockRejectedValueOnce(networkError);

    render(<EngineerRepairRequestList />);

    await screen.findByText(networkError.userMessage);
    expect(screen.queryByText('暂无维修申请。')).toBeNull();

    fetchMock.mockResolvedValueOnce(buildPage([buildItem(22)]));
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    await screen.findByText('RR20260902100000ABC22');
    expect(fetchMock).toHaveBeenLastCalledWith({
      scope: 'ALL',
      filter: NO_FILTER,
      page: 1,
      pageSize: 10,
    });
  });

  it('筛选无结果时展示筛选专属空态与清除筛选入口', async () => {
    fetchMock.mockResolvedValue(buildPage([buildItem(21)]));
    render(<EngineerRepairRequestList />);
    await screen.findByText('RR20260902100000ABC21');

    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    // 下一次筛选请求返回空结果
    fetchMock.mockResolvedValueOnce(buildPage([], 0));
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('光刻机 9000S（LITHO-9000S）'));

    await screen.findByText('没有符合筛选条件的维修申请。');
    // 筛选无结果与全局空态互斥
    expect(screen.queryByText('暂无维修申请。')).toBeNull();
    // 筛选条与空态内各有一个清除筛选入口
    expect(screen.getAllByRole('button', { name: '清除筛选' })).toHaveLength(2);
  });

  it('当前页为空但范围非空时保留分页器，不形成死路', async () => {
    fetchMock.mockResolvedValue(buildPage([buildItem(21)], 12));

    render(<EngineerRepairRequestList />);
    await screen.findByText('RR20260902100000ABC21');

    fetchMock.mockResolvedValueOnce(buildPage([], 12, 2));
    fireEvent.click(screen.getByTitle('2'));

    await screen.findByText('当前页暂无数据，请翻页返回。');
    expect(screen.getByText('共 12 条')).toBeTruthy();
    expect(screen.getByTitle('1')).toBeTruthy();
  });

  it('点击列表行进入该申请的工程师详情路由', async () => {
    fetchMock.mockResolvedValue(buildPage([buildItem(21), buildItem(22)]));

    render(<EngineerRepairRequestList />);
    await screen.findByText('RR20260902100000ABC22');

    fireEvent.click(screen.getByText('RR20260902100000ABC22'));

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/engineer/repair-requests/22');
  });
});

/**
 * 语言切换与请求解耦：`t` 只用于渲染，不进入数据拉取的依赖。
 * 用 `I18nContext` 直接装配最小状态容器（features 层禁止依赖 app 的 Provider）。
 */
describe('EngineerRepairRequestList 的语言切换', () => {
  function LanguageHarness() {
    const [language, setLanguage] = useState<AppLanguage>('zh-CN');
    const t = useMemo(() => createTranslator(language), [language]);
    const value = useMemo(() => ({ language, setLanguage, t }), [language, t]);

    return (
      <I18nContext.Provider value={value}>
        <button onClick={() => setLanguage('en')} type="button">
          switch-language
        </button>
        <EngineerRepairRequestList />
      </I18nContext.Provider>
    );
  }

  it('切换界面语言只重渲染，不重发设备型号与列表请求', async () => {
    fetchMock.mockResolvedValue(buildPage([buildItem(21)]));

    render(<LanguageHarness />);
    await screen.findByText('RR20260902100000ABC21');

    expect(fetchModelsMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'switch-language' }));

    // 面板标题随语言切换为英文
    await screen.findByText('Repair request list');
    // 语言变化不得连带重发任何数据请求
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('设备型号加载失败的兜底文案跟随当前语言，且不重发请求', async () => {
    fetchModelsMock.mockReset();
    fetchModelsMock.mockRejectedValueOnce(new Error('models unavailable'));
    fetchMock.mockResolvedValue(buildPage([buildItem(21)]));

    render(<LanguageHarness />);
    await screen.findByText('设备型号加载失败，请稍后重试。');

    fireEvent.click(screen.getByRole('button', { name: 'switch-language' }));

    await screen.findByText('Failed to load equipment models. Please try again later.');
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
