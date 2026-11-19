// src/features/repair-request/ui/engineer-repair-version-history.spec.tsx
// @vitest-environment jsdom

// 工程师详情底部版本历史：只读、四列、最新在前、查看/对比、空态与失败隔离。
// 数据 hook 桩成确定状态，不触碰真实 GraphQL；后端权限由后端测试覆盖。
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { translate } from '@/shared/i18n';

import type { EngineerRepairRevisionHistoryItem } from '../infrastructure/engineer-repair-request.types';

import { EngineerRepairVersionHistory } from './engineer-repair-version-history';

const { historyMock, detailMock, retryHistoryMock, retryDetailMock } = vi.hoisted(() => ({
  historyMock: vi.fn(),
  detailMock: vi.fn(),
  retryHistoryMock: vi.fn(),
  retryDetailMock: vi.fn(),
}));

vi.mock('../application/use-engineer-repair-revision-history', () => ({
  useEngineerRepairRevisionHistory: () => historyMock(),
  useEngineerRepairRevisionDetail: () => detailMock(),
}));

const ITEM_2: EngineerRepairRevisionHistoryItem = {
  revisionNo: 2,
  previousVersion: 1,
  reason: '修正维修步骤',
  actorNickname: '管理员甲',
  createdAt: '2026-09-03T10:00:00.000Z',
  hasComparableSnapshot: true,
  hasVisibleMaintenanceChange: true,
  compareUnavailableReason: null,
};

const ITEM_1: EngineerRepairRevisionHistoryItem = {
  revisionNo: 1,
  previousVersion: 0,
  reason: '旧快照修订',
  actorNickname: '管理员乙',
  createdAt: '2026-09-02T10:00:00.000Z',
  hasComparableSnapshot: false,
  hasVisibleMaintenanceChange: false,
  compareUnavailableReason: 'NO_COMPARABLE_SNAPSHOT',
};

const DETAIL_2 = {
  requestId: 123,
  revisionNo: 2,
  previousVersion: 1,
  reason: '修正维修步骤',
  actorNickname: '管理员甲',
  createdAt: '2026-09-03T10:00:00.000Z',
  hasComparableSnapshot: true,
  hasVisibleMaintenanceChange: true,
  compareUnavailableReason: null,
  before: {
    maintenanceDate: '2026-09-02',
    engineerName: '陈工',
    resetResult: 'NORMAL',
    supplementaryNote: null,
    steps: [],
    panels: [],
  },
  after: {
    maintenanceDate: '2026-09-02',
    engineerName: '陈工（修订）',
    resetResult: 'NORMAL',
    supplementaryNote: null,
    steps: [],
    panels: [],
  },
};

function setReady(items: EngineerRepairRevisionHistoryItem[]) {
  historyMock.mockReturnValue({
    state: { status: 'ready', items },
    retry: retryHistoryMock,
  });
}

beforeEach(() => {
  historyMock.mockReset();
  detailMock.mockReset();
  retryHistoryMock.mockReset();
  retryDetailMock.mockReset();
  detailMock.mockReturnValue({
    state: { status: 'ready', detail: DETAIL_2 },
    retry: retryDetailMock,
  });
});

describe('工程师版本与修订历史', () => {
  it('四列表头齐全，最新版本在前；缺可比快照的版本禁用对比', () => {
    setReady([ITEM_1, ITEM_2]);
    render(<EngineerRepairVersionHistory requestId={123} />);

    expect(screen.getByText(translate('zh-CN', 'engineerRepairHistory.title'))).toBeTruthy();
    expect(
      screen.getAllByText(translate('zh-CN', 'engineerRepairHistory.col.version')).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(translate('zh-CN', 'engineerRepairHistory.col.actor')).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(translate('zh-CN', 'engineerRepairHistory.col.reason')).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(translate('zh-CN', 'engineerRepairHistory.col.actions')).length,
    ).toBeGreaterThan(0);

    const compareButtons = screen.getAllByRole('button', {
      name: translate('zh-CN', 'engineerRepairHistory.compare'),
    });
    expect(compareButtons).toHaveLength(2);
    // 行顺序：v2 在前且可对比；v1 在后且禁用
    expect(compareButtons[0]).toHaveProperty('disabled', false);
    expect(compareButtons[1]).toHaveProperty('disabled', true);

    const versionTags = screen.getAllByText(/^v\d+$/);
    expect(versionTags.map((node) => node.textContent)).toEqual(['v2', 'v1']);
    // 明确不提供回滚
    expect(screen.getByText(translate('zh-CN', 'engineerRepairHistory.noRollback'))).toBeTruthy();
  });

  it('查看版本展示服务端工程师可见快照', () => {
    setReady([ITEM_2]);
    render(<EngineerRepairVersionHistory requestId={123} />);

    fireEvent.click(
      screen.getByRole('button', { name: translate('zh-CN', 'engineerRepairHistory.view') }),
    );

    expect(
      screen.getByText(translate('zh-CN', 'engineerRepairHistory.detailTitle', { version: 2 })),
    ).toBeTruthy();
    expect(screen.getByText('陈工（修订）')).toBeTruthy();
  });

  it('对比上一版展示维修字段变化', () => {
    setReady([ITEM_2]);
    render(<EngineerRepairVersionHistory requestId={123} />);

    fireEvent.click(
      screen.getByRole('button', { name: translate('zh-CN', 'engineerRepairHistory.compare') }),
    );

    expect(screen.getByText(translate('zh-CN', 'engineerRepairHistory.fieldChanges'))).toBeTruthy();
    expect(screen.getByText('陈工')).toBeTruthy();
    expect(screen.getByText('陈工（修订）')).toBeTruthy();
    expect(
      screen.queryByText(translate('zh-CN', 'engineerRepairHistory.noDifferences')),
    ).toBeNull();
  });

  it('没有历史时展示空态', () => {
    setReady([]);
    render(<EngineerRepairVersionHistory requestId={123} />);

    expect(screen.getByText(translate('zh-CN', 'engineerRepairHistory.empty'))).toBeTruthy();
  });

  it('历史加载失败：区块内单独提示并可重试，不抛出', () => {
    historyMock.mockReturnValue({
      state: { status: 'failed', message: '版本历史加载失败' },
      retry: retryHistoryMock,
    });
    render(<EngineerRepairVersionHistory requestId={123} />);

    expect(screen.getByText('版本历史加载失败')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    expect(retryHistoryMock).toHaveBeenCalledTimes(1);
  });
});
