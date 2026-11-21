/// <reference types="jest" />
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import {
  LOCAL_RESOLUTION_REASON,
  planLocalConflictResolution,
} from './sync-conflict-local-resolution.policy';

/**
 * 「保留本地」裁决的载荷映射纯规则（任务 09 R-03）。
 *
 * 覆盖口径：资源类型准入、并发版本取数、快照契约校验、字段映射与"不猜语义"。
 */
describe('planLocalConflictResolution（保留本地载荷映射纯规则）', () => {
  const baseInput = {
    resourceType: 'REPAIR_REQUEST',
    localVersion: 4,
    localSnapshot: JSON.stringify({ schema_version: 1, content_md: '# 本地正文' }),
  };

  it('快照满足契约时给出受控载荷：版本取冲突登记的本地版本', () => {
    const plan = planLocalConflictResolution(baseInput);

    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') {
      return;
    }
    expect(plan.payload).toMatchObject({
      resourceType: 'REPAIR_REQUEST',
      expectedVersion: 4,
      reason: LOCAL_RESOLUTION_REASON,
      contentMd: '# 本地正文',
    });
  });

  it('资源类型没有受控写入入口时显式拒绝', () => {
    const plan = planLocalConflictResolution({
      ...baseInput,
      resourceType: 'MAINTENANCE_REPORT',
    });

    expect(plan).toMatchObject({
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_RESOURCE_UNSUPPORTED,
    });
  });

  it('没有可用本地版本时显式拒绝（不猜版本）', () => {
    const plan = planLocalConflictResolution({ ...baseInput, localVersion: null });

    expect(plan).toMatchObject({
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_VERSION_UNAVAILABLE,
    });
  });

  it('本地版本为 0 或非整数时显式拒绝', () => {
    expect(planLocalConflictResolution({ ...baseInput, localVersion: 0 })).toMatchObject({
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_VERSION_UNAVAILABLE,
    });
    expect(planLocalConflictResolution({ ...baseInput, localVersion: 1.5 })).toMatchObject({
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_VERSION_UNAVAILABLE,
    });
  });

  it('快照不是合法 JSON 时显式拒绝', () => {
    const plan = planLocalConflictResolution({ ...baseInput, localSnapshot: '{oops' });

    expect(plan).toMatchObject({
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
    });
  });

  it('快照结构版本不符时显式拒绝（不猜字段含义）', () => {
    const plan = planLocalConflictResolution({
      ...baseInput,
      localSnapshot: JSON.stringify({ schema_version: 2, content_md: 'x' }),
    });

    expect(plan).toMatchObject({
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
    });
  });

  it('快照没有任何可写字段时拒绝空修订', () => {
    const plan = planLocalConflictResolution({
      ...baseInput,
      localSnapshot: JSON.stringify({ schema_version: 1 }),
    });

    expect(plan).toMatchObject({
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
    });
  });

  it('快照里的未知键被忽略，不被当成载荷', () => {
    const plan = planLocalConflictResolution({
      ...baseInput,
      localSnapshot: JSON.stringify({
        schema_version: 1,
        content_md: '# 本地正文',
        customer_original: '不可改写事实',
      }),
    });

    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') {
      return;
    }
    expect(plan.payload).not.toHaveProperty('customer_original');
    expect(Object.keys(plan.payload)).toEqual(
      expect.arrayContaining(['resourceType', 'expectedVersion', 'reason']),
    );
  });

  it('修订结构化维修记录时必须同时给出可用的维修记录版本条件', () => {
    const withoutVersion = planLocalConflictResolution({
      ...baseInput,
      localSnapshot: JSON.stringify({ schema_version: 1, maintenance: { steps: [] } }),
    });
    expect(withoutVersion).toMatchObject({
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
    });

    const withVersion = planLocalConflictResolution({
      ...baseInput,
      localSnapshot: JSON.stringify({
        schema_version: 1,
        maintenance: { steps: [] },
        expected_maintenance_version: 3,
      }),
    });
    expect(withVersion.kind).toBe('apply');
    if (withVersion.kind !== 'apply') {
      return;
    }
    expect(withVersion.payload.expectedMaintenanceVersion).toBe(3);
  });

  it('快照里缺失的可选字段按"没有该字段"处理（不补值、不清空）', () => {
    const plan = planLocalConflictResolution({
      ...baseInput,
      localSnapshot: JSON.stringify({ schema_version: 1, closure_reason: '结单原因' }),
    });

    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') {
      return;
    }
    expect(plan.payload.contentMd).toBeNull();
    expect(plan.payload.closureReason).toBe('结单原因');
    expect(plan.payload.maintenance).toBeNull();
  });
});
