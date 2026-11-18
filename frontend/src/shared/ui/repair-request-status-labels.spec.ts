// src/shared/ui/repair-request-status-labels.spec.ts

import { describe, expect, it } from 'vitest';

import { resolveRepairClosureState } from './repair-request-status-labels';

/**
 * 结单状态共用判定：closureStatus 与 closedAt 必须联合判定，
 * 「字段缺失（undefined）」与「显式 null」不得合并。
 */
describe(resolveRepairClosureState.name, () => {
  const validClosedAt = '2026-09-02T09:00:00.000Z';

  it('CLOSED + 有效非空时间 → 已结单', () => {
    expect(resolveRepairClosureState('CLOSED', validClosedAt)).toBe('CLOSED');
  });

  it('OPEN + 明确 null 时间 → 未结单', () => {
    expect(resolveRepairClosureState('OPEN', null)).toBe('OPEN');
  });

  it('明确 null 状态 + 明确 null 时间（数据库合法合同）→ 未结单', () => {
    expect(resolveRepairClosureState(null, null)).toBe('OPEN');
  });

  it('缺少 closureStatus → 未知，即使 closedAt 明确为 null', () => {
    expect(resolveRepairClosureState(undefined, null)).toBe('UNKNOWN');
  });

  it('缺少 closedAt → 未知，即使 closureStatus 明确为 OPEN', () => {
    expect(resolveRepairClosureState('OPEN', undefined)).toBe('UNKNOWN');
  });

  it('明确 null 状态但缺少 closedAt → 未知', () => {
    expect(resolveRepairClosureState(null, undefined)).toBe('UNKNOWN');
  });

  it('CLOSED + null 时间 → 未知（矛盾）', () => {
    expect(resolveRepairClosureState('CLOSED', null)).toBe('UNKNOWN');
  });

  it('CLOSED + 空白或非法时间 → 未知', () => {
    expect(resolveRepairClosureState('CLOSED', '')).toBe('UNKNOWN');
    expect(resolveRepairClosureState('CLOSED', '   ')).toBe('UNKNOWN');
    expect(resolveRepairClosureState('CLOSED', 'not-a-date')).toBe('UNKNOWN');
  });

  it('OPEN + 非空时间 → 未知（矛盾）', () => {
    expect(resolveRepairClosureState('OPEN', validClosedAt)).toBe('UNKNOWN');
  });

  it('明确 null 状态 + 非空时间 → 未知（矛盾）', () => {
    expect(resolveRepairClosureState(null, validClosedAt)).toBe('UNKNOWN');
  });

  it('未知状态值 → 未知', () => {
    expect(resolveRepairClosureState('PENDING', null)).toBe('UNKNOWN');
    expect(resolveRepairClosureState('closed', validClosedAt)).toBe('UNKNOWN');
  });
});
