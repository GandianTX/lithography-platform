// src/features/my-records/ui/my-records-list.spec.tsx
// @vitest-environment jsdom

/**
 * 我的资料记录列表单测（任务 07）。
 *
 * 守住：本人记录按状态区分草稿/正式、两类草稿续填直达任务 06 真实路由（独立历史
 * 记录→编辑器、工单总结→只读核对页）、草稿与正式都有「查看记录」入口、管理员不可
 * 续填且无新建入口、服务端 total 原样展示、筛选与标题搜索下推（服务端全量口径）、
 * 顶部统计事实化（草稿/已入库为服务端全量 total；待同步/版本冲突未接入显示「—」）、
 * 同步状态列真实展示（任务 09 未接入为「未接入同步」，不从保存成功推断已同步，
 * 无路由不出现「处理冲突」）与失败重试。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MyRecordListPage, MyRecordSummary } from '../infrastructure/my-records.types';
import * as myRecordsAdapter from '../infrastructure/my-records-adapter';

import { MyRecordsList } from './my-records-list';

vi.mock('../infrastructure/my-records-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof myRecordsAdapter>();

  return { ...actual, fetchMyRecords: vi.fn() };
});

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

const navigateMock = vi.fn();
const fetchMyRecordsMock = vi.mocked(myRecordsAdapter.fetchMyRecords);

function buildItem(overrides: Partial<MyRecordSummary> = {}): MyRecordSummary {
  return {
    id: 960001,
    sourceType: 'HISTORICAL_CASE',
    repairRequestId: null,
    title: '光刻机 Z 轴异常处理',
    status: 'APPROVED',
    currentVersionNo: 2,
    maintenanceDate: '2026-09-30',
    updatedAt: '2026-10-02T08:00:00.000Z',
    publishedDocumentId: null,
    syncStatus: {
      status: 'NOT_CONNECTED',
      message: null,
      conflictId: null,
      canResolveConflict: false,
    },
    ...overrides,
  };
}

function buildPage(items: MyRecordSummary[], total = items.length): MyRecordListPage {
  return { items, total, page: 1, pageSize: 10 };
}

type StatsTotals = { draft: number; formal: number };

/**
 * 统一 mock：列表请求（无 recordKind）返回 list；统计请求（pageSize=1 + recordKind）
 * 返回 stats 里的全量 total。避免列表 hook 与统计 hook 共用替身时相互串扰。
 */
function mockPages(list: MyRecordListPage, stats?: StatsTotals): void {
  fetchMyRecordsMock.mockImplementation((query) => {
    if (query.filter?.recordKind === 'DRAFT') {
      return Promise.resolve(buildPage([], stats?.draft ?? 0));
    }
    if (query.filter?.recordKind === 'FORMAL') {
      return Promise.resolve(buildPage([], stats?.formal ?? 0));
    }
    return Promise.resolve(list);
  });
}

beforeEach(() => {
  fetchMyRecordsMock.mockReset();
  navigateMock.mockReset();
  mockPages(buildPage([buildItem()]));
});

describe('MyRecordsList', () => {
  /**
   * 2026-11-22 由单个长用例拆分为三个关注点用例：原用例在一次渲染内串联
   * 分区断言与多组 role 查询/交互，jsdom 的可访问性查询开销使其在全量并发下
   * 稳定超过 20s（实测渲染与等待合计 <1s，耗时集中在多次 getAllByRole/
   * within().getByRole）。拆分后断言语义与原用例完全一致，仅按关注点分组。
   */
  function renderThreeRecordsPage(): void {
    mockPages(
      buildPage([
        buildItem({ id: 960001, status: 'DRAFT', currentVersionNo: 0, title: '草稿记录' }),
        buildItem({
          id: 960002,
          status: 'APPROVED',
          title: '正式记录',
          publishedDocumentId: 970001,
        }),
        buildItem({
          id: 960003,
          status: 'RETURNED',
          currentVersionNo: 0,
          title: '工单总结草稿',
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: 950001,
        }),
      ]),
    );
    render(<MyRecordsList activeRole="ENGINEER" />);
  }

  it('草稿与正式记录分区展示：状态标签与统计区各有草稿语义', async () => {
    renderThreeRecordsPage();

    expect(await screen.findByText('草稿记录')).toBeTruthy();
    expect(await screen.findByText('正式记录')).toBeTruthy();
    // 状态标签 + 筛选器 + 统计卡各有一处「草稿」
    expect(screen.getAllByText('草稿').length).toBeGreaterThan(1);
    expect(screen.getByText('已通过')).toBeTruthy();
  });

  it(
    // jsdom 对 antd 表格的可访问性查询开销使本用例（两次点击+跳转断言）约 5-7s，
    // 按本文件既有口径放宽超时（已完成拆分定位，耗时为查询固有开销而非挂起）
    '两类草稿续填直达任务 06 真实路由',
    { timeout: 20000 },
    async () => {
      renderThreeRecordsPage();
      expect(await screen.findByText('草稿记录')).toBeTruthy();

      // 独立历史记录草稿：继续填写 → 任务 06 报告编辑器（同一报告 id）
      fireEvent.click(screen.getByRole('button', { name: '继续填写' }));
      expect(navigateMock).toHaveBeenCalledWith('/engineer/maintenance-records/960001');

      // 工单总结草稿：继续核对 → 任务 06 只读核对页（参数为来源工单 id）
      fireEvent.click(screen.getByRole('button', { name: '继续核对' }));
      expect(navigateMock).toHaveBeenCalledWith('/engineer/work-order-summaries/950001');
    },
  );

  it(
    // 与上一用例同口径：三次行内 role 查询 + 两次点击在 jsdom 下约 7s
    '草稿与正式记录都有「查看记录」入口，正式行内直达只读详情与已发布成品',
    { timeout: 20000 },
    async () => {
      renderThreeRecordsPage();
      expect(await screen.findByText('正式记录')).toBeTruthy();

      // 草稿与正式记录都有「查看记录」只读入口（对齐 Demo V44）
      const viewButtons = screen.getAllByRole('button', { name: '查看记录' });
      expect(viewButtons.length).toBe(3);

      // 正式记录行内：查看记录 → 只读详情；已发布成品入口
      const formalRow = screen.getByText('正式记录').closest('tr') as HTMLElement;
      fireEvent.click(within(formalRow).getByRole('button', { name: '查看记录' }));
      expect(navigateMock).toHaveBeenCalledWith('/engineer/records/960002');
      fireEvent.click(within(formalRow).getByRole('button', { name: '查看正式资料' }));
      expect(navigateMock).toHaveBeenCalledWith('/reference-documents/970001');

      expect(fetchMyRecordsMock).toHaveBeenCalledWith({ page: 1, pageSize: 10, filter: undefined });
    },
  );

  it('顶部统计：草稿/已入库为服务端全量 total；待同步/版本冲突未接入显示「—」', async () => {
    mockPages(buildPage([buildItem()]), { draft: 3, formal: 12 });
    render(<MyRecordsList activeRole="ENGINEER" />);

    // 统计卡标题与全量数字
    expect(await screen.findByText('光刻机 Z 轴异常处理')).toBeTruthy();
    expect(screen.getByText('已入库')).toBeTruthy();
    expect(screen.getByText('待同步')).toBeTruthy();
    expect(screen.getByText('版本冲突')).toBeTruthy();
    const draftCard = screen
      .getByText('草稿', { selector: '.ant-card-head-title' })
      .closest('.ant-card') as HTMLElement;
    expect(draftCard.textContent).toContain('3');
    const formalCard = screen
      .getByText('已入库', { selector: '.ant-card-head-title' })
      .closest('.ant-card') as HTMLElement;
    expect(formalCard.textContent).toContain('12');
    // 任务 09 未接入：显示「—」与未接入提示，不伪造数字
    const pendingCard = screen
      .getByText('待同步', { selector: '.ant-card-head-title' })
      .closest('.ant-card') as HTMLElement;
    expect(pendingCard.textContent).toContain('—');
    expect(pendingCard.textContent).toContain('任务 09 未接入');
    const conflictCard = screen
      .getByText('版本冲突', { selector: '.ant-card-head-title' })
      .closest('.ant-card') as HTMLElement;
    expect(conflictCard.textContent).toContain('—');
    // 统计请求按 recordKind 全量下推（pageSize=1），不带来源筛选
    expect(fetchMyRecordsMock).toHaveBeenCalledWith({
      page: 1,
      pageSize: 1,
      filter: { recordKind: 'DRAFT' },
    });
    expect(fetchMyRecordsMock).toHaveBeenCalledWith({
      page: 1,
      pageSize: 1,
      filter: { recordKind: 'FORMAL' },
    });
  });

  it('统计请求失败降级「—」，不影响列表展示', async () => {
    fetchMyRecordsMock.mockImplementation((query) => {
      if (query.filter?.recordKind !== undefined) {
        return Promise.reject(new Error('stats failed'));
      }
      return Promise.resolve(buildPage([buildItem()]));
    });
    render(<MyRecordsList activeRole="ENGINEER" />);

    expect(await screen.findByText('光刻机 Z 轴异常处理')).toBeTruthy();
    const draftCard = screen
      .getByText('草稿', { selector: '.ant-card-head-title' })
      .closest('.ant-card') as HTMLElement;
    expect(draftCard.textContent).toContain('—');
  });

  it('标题搜索：提交后下推 titleKeyword 由服务端全量匹配，清空立即恢复', async () => {
    render(<MyRecordsList activeRole="ENGINEER" />);
    await screen.findByText('光刻机 Z 轴异常处理');

    const input = screen.getByPlaceholderText('搜索资料标题') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '光刻' } });
    // 回车提交（Input.Search 两种提交方式之一，jsdom 下比点击搜索按钮稳定）
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(fetchMyRecordsMock).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 10,
        filter: { titleKeyword: '光刻' },
      });
    });

    // 清空（allowClear / 删空）立即恢复全量，不残留旧关键词
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => {
      expect(fetchMyRecordsMock).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 10,
        filter: undefined,
      });
    });
  });

  it('管理员身份：草稿续填入口不可用且不跳转（后端写入口仅工程师，前端不伪造）', async () => {
    mockPages(buildPage([buildItem({ id: 960001, status: 'DRAFT', currentVersionNo: 0 })]));
    render(<MyRecordsList activeRole="SUPER_ADMIN" />);

    expect(await screen.findByText('光刻机 Z 轴异常处理')).toBeTruthy();
    const resume = screen.getByRole('button', { name: '继续填写' }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    fireEvent.click(resume);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('已正式提交记录只读查看：不显示任何草稿续填入口', async () => {
    mockPages(buildPage([buildItem({ id: 960004, status: 'SUBMITTED', title: '已提交记录' })]));
    render(<MyRecordsList activeRole="ENGINEER" />);

    expect(await screen.findByText('已提交记录')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '继续填写' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续核对' })).toBeNull();
  });

  it('total 来自服务端同一归属谓词（分页 total 原样展示）', async () => {
    mockPages(buildPage([buildItem()], 37));

    render(<MyRecordsList />);

    expect(await screen.findByText('共 37 条')).toBeTruthy();
  });

  it('筛选草稿下推 recordKind=DRAFT 并回到第 1 页', async () => {
    const { container } = render(<MyRecordsList />);
    await screen.findByText('光刻机 Z 轴异常处理');

    // 筛选器（AntD Segmented）的「草稿」选项，避免与表格状态标签/统计卡同名
    const draftOption = container.querySelector('.ant-segmented-item-label[title="草稿"]');
    expect(draftOption).not.toBeNull();
    fireEvent.click(draftOption as Element);

    await waitFor(() => {
      expect(fetchMyRecordsMock).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 10,
        filter: { recordKind: 'DRAFT' },
      });
    });
  });

  it('空列表给出空态，不渲染表格', async () => {
    mockPages(buildPage([], 0));

    const { container } = render(<MyRecordsList />);

    expect(await screen.findByText('暂无资料记录。')).toBeTruthy();
    expect(container.querySelector('.ant-table')).toBeNull();
  });

  it('加载失败展示错误与重试入口', async () => {
    let listCallCount = 0;
    fetchMyRecordsMock.mockImplementation((query) => {
      if (query.filter?.recordKind !== undefined) {
        return Promise.resolve(buildPage([], 0));
      }
      listCallCount += 1;
      if (listCallCount === 1) {
        return Promise.reject(new Error('network'));
      }
      return Promise.resolve(buildPage([buildItem()]));
    });

    render(<MyRecordsList />);

    expect(await screen.findByText('资料记录加载失败，请稍后重试。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重 试' }));

    expect(await screen.findByText('光刻机 Z 轴异常处理')).toBeTruthy();
    expect(listCallCount).toBe(2);
  });

  it('任务 09 未接入：同步状态列真实展示「未接入同步」，不渲染「处理冲突」占位入口', async () => {
    mockPages(
      buildPage([
        buildItem({ id: 960003, title: '未接入记录' }),
        buildItem({
          id: 960004,
          title: '冲突替身记录',
          // 替身数据：若任务 09 已装配且授权，后端才可能返回此类值；
          // 本轮无已接入路由，前端不得出现「处理冲突」按钮
          syncStatus: {
            status: 'CONFLICT',
            message: '本机与云端版本不一致',
            conflictId: 'b096c692-7556-4564-a4f8-2e2fb78b3880',
            canResolveConflict: true,
          },
        }),
        buildItem({
          id: 960005,
          title: '已同步替身记录',
          // 替身数据：仅任务 09 已装配时后端才可能返回 SYNCED；前端如实透传展示值，
          // 绝不从保存/提交成功自行推断「已同步」
          syncStatus: {
            status: 'SYNCED',
            message: null,
            conflictId: null,
            canResolveConflict: false,
          },
        }),
      ]),
    );

    render(<MyRecordsList />);

    expect(await screen.findByText('未接入记录')).toBeTruthy();
    // 同步状态列展示（2026-11-22 用户要求：列表要有同步状态列；antd 横向滚动会渲染测量副本）
    expect(screen.getAllByText('同步状态').length).toBeGreaterThan(0);
    // 后端适配层真实展示值：未装配为「未接入同步」，替身 SYNCED/CONFLICT 如实透传
    expect(screen.getByText('未接入同步')).toBeTruthy();
    expect(screen.getByText('已同步')).toBeTruthy();
    expect(screen.getByText('存在冲突')).toBeTruthy();
    // 「处理冲突」按钮需要真实冲突 + 有权处理 + 已接入路由三者齐备；本轮无路由不渲染
    expect(screen.queryByRole('button', { name: '处理冲突' })).toBeNull();
    expect(screen.queryByText('处理冲突')).toBeNull();
  });
});
