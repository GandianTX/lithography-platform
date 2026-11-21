// @vitest-environment jsdom
// src/pages/engineer-work-order-summaries/index.spec.tsx
//
// 2026-11-21 需求调整：页面层把「来源工单」路径构造注入列表组件——
// 必须使用任务 04 真源常量 ENGINEER_REPAIR_REQUEST_DETAIL_PATH 与
// repairRequestId（工单 ID）拼详情路由，不用报告 ID、不自造 URL。

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ENGINEER_REPAIR_REQUEST_DETAIL_PATH } from '@/features/repair-request';

const { WorkOrderSummaryListStub } = vi.hoisted(() => ({
  WorkOrderSummaryListStub: vi.fn(() => null),
}));

vi.mock('@/features/maintenance-report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/maintenance-report')>();
  return {
    ...actual,
    WorkOrderSummaryList: WorkOrderSummaryListStub,
  };
});

import { EngineerWorkOrderSummariesPage } from './index';

describe('EngineerWorkOrderSummariesPage（来源工单路径装配）', () => {
  it('以 repairRequestId（工单 ID）拼任务 04 详情路由，不用报告 ID', () => {
    render(<EngineerWorkOrderSummariesPage />);

    expect(WorkOrderSummaryListStub).toHaveBeenCalledTimes(1);
    const calls = WorkOrderSummaryListStub.mock.calls as unknown as Array<
      [{ resolveSourceWorkOrderPath: (id: number) => string }]
    >;
    const props = calls[0][0];
    expect(typeof props.resolveSourceWorkOrderPath).toBe('function');

    // 工单 ID 与报告 ID 故意不同：结果必须来自工单 ID 与真源常量拼接
    expect(props.resolveSourceWorkOrderPath(55)).toBe(`${ENGINEER_REPAIR_REQUEST_DETAIL_PATH}55`);
    expect(props.resolveSourceWorkOrderPath(55)).toBe('/engineer/repair-requests/55');
    // 传报告 ID 时也不应命中工单 55 的详情（证明未把报告 ID 当工单 ID 用）
    expect(props.resolveSourceWorkOrderPath(77)).toBe('/engineer/repair-requests/77');
  });
});
