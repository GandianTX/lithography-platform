/// <reference types="jest" />
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import {
  LOCAL_RESOLUTION_REASON,
  planLocalConflictResolution,
  type LocalResolutionPlan,
  type LocalResolutionRepairRequestPayload,
} from './sync-conflict-local-resolution.policy';

/**
 * 「保留本地」裁决的载荷映射纯规则（任务 09 R-03／第 05 项资料扩展）。
 *
 * 覆盖口径：资源类型准入、并发版本取数、快照契约校验、字段映射与"不猜语义"；
 * 资料分支（第 05 项）：受控字段白名单（标题／说明）、正文不反写、类型非法拒绝。
 */

/** 工单分支载荷收窄（联合类型下按资源类型取字段） */
function asRepairRequestPayload(plan: LocalResolutionPlan): LocalResolutionRepairRequestPayload {
  if (plan.kind !== 'apply' || plan.payload.resourceType !== 'REPAIR_REQUEST') {
    throw new Error('预期工单保留本地载荷');
  }
  return plan.payload;
}

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

  // 回归：真实冲突由业务同步回执链登记，快照形态是「信封 ＋ body」。
  // 只认信封根会让真实数据取不到任何受控字段 ⇒ 保留本地必然被拒。
  it('真实登记形态（信封 ＋ body）同样能映射出受控载荷', () => {
    const plan = planLocalConflictResolution({
      ...baseInput,
      localSnapshot: JSON.stringify({
        schema_version: 1,
        resource_type: 'REPAIR_REQUEST',
        record_uuid: 'record-uuid-1',
        version_no: 4,
        manifest_checksum: 'checksum-local',
        body: {
          schema_version: 1,
          request_no: 'RQ-1',
          content_md: '# 本地正文',
          current_revision_no: 4,
          handling_result: null,
          handling_status: null,
        },
      }),
    });

    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') {
      return;
    }
    expect(asRepairRequestPayload(plan).contentMd).toBe('# 本地正文');
    expect(plan.payload.expectedVersion).toBe(4);
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

  it('已知字段类型非法时显式拒绝（不能按"没有该字段"处理，否则会丢正文）', () => {
    for (const snapshot of [
      { schema_version: 1, content_md: 123 },
      { schema_version: 1, handling_result: 7 },
      { schema_version: 1, closure_reason: { text: 'x' } },
    ]) {
      expect(
        planLocalConflictResolution({
          ...baseInput,
          localSnapshot: JSON.stringify(snapshot),
        }),
      ).toMatchObject({ kind: 'reject', code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID });
    }
  });

  it('快照不是 JSON 对象（数组）时显式拒绝', () => {
    expect(planLocalConflictResolution({ ...baseInput, localSnapshot: '[]' })).toMatchObject({
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
    expect(asRepairRequestPayload(withVersion).expectedMaintenanceVersion).toBe(3);
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
    const payload = asRepairRequestPayload(plan);
    expect(payload.contentMd).toBeNull();
    expect(payload.closureReason).toBe('结单原因');
    expect(payload.maintenance).toBeNull();
  });
});

/**
 * 资料分支（第 05 项 · P1-5／G10）：
 * 「保留本地」对资料只写标题与说明，正文不反写（本地正文即保留对象）。
 */
describe('planLocalConflictResolution（资料保留本地载荷映射）', () => {
  const documentInput = {
    resourceType: 'REFERENCE_DOCUMENT',
    localVersion: 3,
    localSnapshot: JSON.stringify({
      schema_version: 1,
      title: '本地资料标题',
      description: '本地说明',
      content_text: '本地正文',
      current_revision_no: 3,
    }),
  };

  it('资料快照（信封 ＋ body 形态）映射出标题与说明，版本取冲突登记的本地版本', () => {
    const plan = planLocalConflictResolution({
      ...documentInput,
      localSnapshot: JSON.stringify({
        schema_version: 1,
        resource_type: 'REFERENCE_DOCUMENT',
        record_uuid: 'record-uuid-doc-1',
        version_no: 3,
        body: {
          schema_version: 1,
          title: '本地资料标题',
          document_type: 'MANUAL',
          description: '本地说明',
          content_text: '本地正文',
          original_filename: 'manual.pdf',
          mime_type: 'application/pdf',
          extension: 'pdf',
          current_revision_no: 3,
        },
      }),
    });

    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') {
      return;
    }
    expect(plan.payload).toMatchObject({
      resourceType: 'REFERENCE_DOCUMENT',
      expectedVersion: 3,
      reason: LOCAL_RESOLUTION_REASON,
      title: '本地资料标题',
      description: '本地说明',
    });
  });

  it('资料载荷不含正文与原件身份字段（保留本地不改写正文）', () => {
    const plan = planLocalConflictResolution(documentInput);

    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') {
      return;
    }
    expect(plan.payload).not.toHaveProperty('contentText');
    expect(plan.payload).not.toHaveProperty('documentType');
    expect(plan.payload).not.toHaveProperty('originalFilename');
  });

  it('资料快照的标题或说明类型非法时显式拒绝', () => {
    for (const snapshot of [
      { schema_version: 1, title: 12 },
      { schema_version: 1, description: { text: 'x' } },
      { schema_version: 1, content_text: 5 },
    ]) {
      expect(
        planLocalConflictResolution({
          ...documentInput,
          localSnapshot: JSON.stringify(snapshot),
        }),
      ).toMatchObject({ kind: 'reject', code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID });
    }
  });

  it('资料快照的标题与说明都为空时拒绝空修订', () => {
    expect(
      planLocalConflictResolution({
        ...documentInput,
        localSnapshot: JSON.stringify({ schema_version: 1, title: '', description: '' }),
      }),
    ).toMatchObject({ kind: 'reject', code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID });
  });

  it('资料快照结构版本不符时显式拒绝', () => {
    expect(
      planLocalConflictResolution({
        ...documentInput,
        localSnapshot: JSON.stringify({ schema_version: 9, title: 'x' }),
      }),
    ).toMatchObject({ kind: 'reject', code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID });
  });
});
