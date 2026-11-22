// src/features/my-records/application/task-06-editor-entry.spec.ts

/**
 * 任务 06 对接点单测（任务 07）。
 *
 * 守住：任务 06 已合入后草稿续填指向真实路由（独立历史记录与工单总结分别接通、
 * 参数正确）、管理员不可续填、数据不完整明确不可用、不伪造跳转。
 */

import { describe, expect, it } from 'vitest';

import {
  buildTask06HistoricalEditorPath,
  buildTask06HistoricalNewPath,
  buildTask06WorkOrderSummaryPath,
  resolveTask06CreateEntry,
  resolveTask06DraftEditorEntry,
  TASK_06_EDITOR_INTEGRATION_STATUS,
} from './task-06-editor-entry';

describe('task 06 editor entry', () => {
  it('任务 06 已合入：对接点状态为 READY', () => {
    expect(TASK_06_EDITOR_INTEGRATION_STATUS).toBe('READY');
  });

  it('独立历史记录草稿：指向任务 06 报告编辑器真实路由（携带同一报告 id）', () => {
    expect(
      resolveTask06DraftEditorEntry({ reportId: 960001, sourceType: 'HISTORICAL_CASE' }),
    ).toEqual({ available: true, reasonKey: null, path: '/engineer/maintenance-records/960001' });
  });

  it('工单总结草稿：指向任务 06 只读核对页真实路由（参数为来源工单 id，非报告 id）', () => {
    expect(
      resolveTask06DraftEditorEntry({
        reportId: 960002,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: 950001,
      }),
    ).toEqual({ available: true, reasonKey: null, path: '/engineer/work-order-summaries/950001' });
  });

  it('工单总结草稿缺来源工单标识：不可用且不硬凑路由（不落到报告 id）', () => {
    for (const repairRequestId of [undefined, null, 0, -1, 1.5, Number.NaN]) {
      expect(
        resolveTask06DraftEditorEntry({
          reportId: 960002,
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId,
        }),
      ).toEqual({ available: false, reasonKey: 'workOrderMissing', path: null });
    }
  });

  it('非法报告 ID 不可用，不返回占位路径', () => {
    for (const reportId of [0, -1, 1.5, Number.NaN]) {
      expect(resolveTask06DraftEditorEntry({ reportId, sourceType: 'HISTORICAL_CASE' })).toEqual({
        available: false,
        reasonKey: null,
        path: null,
      });
    }
  });

  it('管理员/客户身份不可续填任何草稿（不返回路径，前端隐藏不替代后端写权限）', () => {
    for (const activeRole of ['SUPER_ADMIN', 'CUSTOMER']) {
      expect(
        resolveTask06DraftEditorEntry({
          reportId: 960001,
          sourceType: 'HISTORICAL_CASE',
          activeRole,
        }),
      ).toEqual({ available: false, reasonKey: null, path: null });
      expect(
        resolveTask06DraftEditorEntry({
          reportId: 960002,
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: 950001,
          activeRole,
        }),
      ).toEqual({ available: false, reasonKey: null, path: null });
    }
  });

  it('工程师新建入口：指向任务 06 新建页真实路由', () => {
    expect(resolveTask06CreateEntry('ENGINEER')).toEqual({
      available: true,
      reasonKey: null,
      path: '/engineer/maintenance-records/new',
    });
  });

  it('管理员/客户/角色未知快照：新建入口不可用（前端隐藏不替代后端写权限）', () => {
    for (const activeRole of ['SUPER_ADMIN', 'CUSTOMER', undefined]) {
      expect(resolveTask06CreateEntry(activeRole)).toEqual({
        available: false,
        reasonKey: null,
        path: null,
      });
    }
  });

  it('路径构造函数与解析结果一致（单一真源）', () => {
    expect(buildTask06HistoricalEditorPath(960001)).toBe('/engineer/maintenance-records/960001');
    expect(buildTask06HistoricalNewPath()).toBe('/engineer/maintenance-records/new');
    expect(buildTask06WorkOrderSummaryPath(950001)).toBe('/engineer/work-order-summaries/950001');
  });
});
