// src/features/repair-request/ui/engineer-repair-workbench.spec.tsx
// @vitest-environment jsdom

/**
 * 工程师首页工作台 UI 单测。
 *
 * 走真实工作台 UI + 真实 query 编排 hook，只 mock 外部 GraphQL adapter 与路由跳转；
 * 数据全部来自真实列表读协议（AVAILABLE 最近条目 + MINE total），测试不复制统计规则。
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import type {
  EngineerRepairRequestListItem,
  EngineerRepairRequestPage,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';

import {
  EngineerRepairWorkbench,
  EngineerRepairWorkbenchProvider,
  EngineerWorkbenchHeaderStats,
} from './engineer-repair-workbench';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    fetchEngineerRepairRequests: vi.fn(),
  };
});

const navigateMock = vi.fn();

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

const fetchMock = vi.mocked(engineerRepairRequestAdapter.fetchEngineerRepairRequests);

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
): EngineerRepairRequestPage {
  return { items, total, page: 1, pageSize: 6 };
}

/** 按范围分流：AVAILABLE 返回最近条目，MINE 返回 total 统计 */
function mockScopes(recent: EngineerRepairRequestPage, mine: EngineerRepairRequestPage) {
  fetchMock.mockImplementation(async ({ scope }) => (scope === 'MINE' ? mine : recent));
}

/**
 * 申请编号同时出现在左侧条目与右侧摘要中，
 * 左侧条目唯一是可点按钮（摘要不是按钮），据此定位左侧条目按钮。
 */
function listButtonOf(requestNo: string): HTMLElement {
  const button = screen
    .getAllByText(requestNo)
    .map((el) => el.closest('button'))
    .find((el): el is HTMLButtonElement => el !== null);
  expect(button).toBeTruthy();
  return button as unknown as HTMLElement;
}

/**
 * 页头真实统计胶囊与工作台主体共用同一份读模型（Provider），
 * 因此按页面装配方式一并渲染，统计断言才落在真实实现上。
 */
function renderWorkbench() {
  return render(
    <EngineerRepairWorkbenchProvider>
      <EngineerWorkbenchHeaderStats />
      <EngineerRepairWorkbench />
    </EngineerRepairWorkbenchProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  navigateMock.mockReset();
});

describe('EngineerRepairWorkbench', () => {
  it('加载中展示加载态，就绪后并行取最近待接单与 MINE total', async () => {
    let resolveFirst: (value: EngineerRepairRequestPage) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<EngineerRepairRequestPage>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    // 第二个请求（MINE）直接返回
    fetchMock.mockResolvedValueOnce(buildPage([], 7));

    renderWorkbench();
    expect(document.querySelector('.loading-state')).toBeTruthy();

    await act(async () => {
      resolveFirst(buildPage([buildItem(21), buildItem(22)]));
    });

    await screen.findAllByText('RR20260902100000ABC21');
    // 编号同时出现在左侧条目与右侧摘要（默认选中首条）
    expect(screen.getAllByText('RR20260902100000ABC21').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RR20260902100000ABC22').length).toBeGreaterThan(0);
    // 我的已接单数量使用 MINE 查询 total，不在前端猜测
    expect(screen.getByText('7')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith({
      scope: 'AVAILABLE',
      filter: NO_FILTER,
      page: 1,
      pageSize: 6,
    });
    expect(fetchMock).toHaveBeenCalledWith({
      scope: 'MINE',
      filter: NO_FILTER,
      page: 1,
      pageSize: 1,
    });
  });

  it('默认选中第一条并展示摘要，点击左侧条目切换选中摘要', async () => {
    mockScopes(
      buildPage([
        buildItem(21, { customerNickname: '林客户', errorCode: 'E-100' }),
        buildItem(22, { customerNickname: '王客户', errorCode: 'E-200' }),
      ]),
      buildPage([], 7),
    );

    renderWorkbench();
    await screen.findAllByText('RR20260902100000ABC21');

    // 默认选中首条：aria-current 表达选中态，摘要展示首条字段
    expect(listButtonOf('RR20260902100000ABC21')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('林客户')).toBeTruthy();
    expect(screen.queryByText('王客户')).toBeNull();

    fireEvent.click(listButtonOf('RR20260902100000ABC22'));

    expect(listButtonOf('RR20260902100000ABC22')).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(screen.getByText('王客户')).toBeTruthy());
    expect(screen.queryByText('林客户')).toBeNull();
  });

  it('摘要提供前往详情入口，跳转到该申请的详情路由', async () => {
    mockScopes(buildPage([buildItem(21)]), buildPage([], 0));

    renderWorkbench();
    await screen.findAllByText('RR20260902100000ABC21');

    fireEvent.click(screen.getByRole('button', { name: '查看详情并处理' }));

    expect(navigateMock).toHaveBeenCalledWith('/engineer/repair-requests/21');
  });

  it('任一范围查询失败整体进入失败态，重试成功后恢复真实数据', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    fetchMock.mockImplementation(async ({ scope }) => {
      if (scope === 'MINE') {
        throw networkError;
      }

      return buildPage([buildItem(21)]);
    });

    renderWorkbench();

    await screen.findByText(networkError.userMessage);
    expect(screen.queryByText('RR20260902100000ABC21')).toBeNull();

    mockScopes(buildPage([buildItem(21)]), buildPage([], 5));
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    await screen.findAllByText('RR20260902100000ABC21');
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('无待接单时展示空态与摘要引导，MINE total 仍然展示', async () => {
    mockScopes(buildPage([], 0), buildPage([], 7));

    renderWorkbench();

    await screen.findByText('暂无待接单的维修申请。');
    expect(screen.getByText('从左侧选择待接单申请查看摘要')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('接单流程宣告列表失效后按当前口径重新取真实数据', async () => {
    mockScopes(buildPage([buildItem(21)]), buildPage([], 0));
    const { invalidateEngineerRepairLists } =
      await import('../application/engineer-repair-list-refresh');

    renderWorkbench();
    await screen.findAllByText('RR20260902100000ABC21');

    mockScopes(buildPage([buildItem(21), buildItem(22)]), buildPage([], 1));
    await act(async () => {
      invalidateEngineerRepairLists();
    });

    await screen.findAllByText('RR20260902100000ABC22');
    expect(screen.getByText('1')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
