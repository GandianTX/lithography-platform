/// <reference types="jest" />
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import {
  planCloudConflictAlignment,
  type SyncConflictCloudAlignmentInput,
} from './sync-conflict-cloud-alignment.policy';

/**
 * 「使用云端」本地视图对齐计划（任务 09 R068）。
 *
 * 守住：
 * - **只读采用**（已结单）⇒ view-only（不写业务历史）；
 * - **真实冲突快照形态**（信封＋`body`）能取到受控字段；
 * - 类型非法／自相矛盾／无字段 ⇒ 失败关闭并给出受控原因码；
 * - 版本条件缺失 ⇒ 失败关闭；
 * - 不支持的资源类型 ⇒ 失败关闭。
 */
describe('planCloudConflictAlignment（使用云端的本地视图对齐计划）', () => {
  const cloudEnvelope = (body: Record<string, unknown>): string =>
    JSON.stringify({ schema_version: 1, version_no: 5, body });

  const makeInput = (
    overrides: Partial<SyncConflictCloudAlignmentInput> = {},
  ): SyncConflictCloudAlignmentInput => ({
    resourceType: 'REPAIR_REQUEST',
    localVersion: 4,
    cloudSnapshot: cloudEnvelope({
      schema_version: 1,
      request_no: 'RQ-1',
      content_md: '# 云端正文',
      current_revision_no: 5,
      handling_result: null,
      handling_status: null,
    }),
    readOnlyAdoption: false,
    ...overrides,
  });

  it('可写来源：给出受控对齐载荷（正文取自云端快照）', () => {
    const plan = planCloudConflictAlignment(makeInput());

    expect(plan.kind).toBe('align');
    if (plan.kind !== 'align') {
      return;
    }
    expect(plan.payload).toEqual({
      resourceType: 'REPAIR_REQUEST',
      expectedVersion: 4,
      contentMd: '# 云端正文',
      handlingResult: null,
      handlingStatus: null,
    });
  });

  it('已结单只读采用：只呈现视图，不写业务历史', () => {
    const plan = planCloudConflictAlignment(makeInput({ readOnlyAdoption: true }));

    expect(plan.kind).toBe('view-only');
  });

  it('旧契约（受控字段挂在信封根上）同样可读', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        cloudSnapshot: JSON.stringify({ schema_version: 1, content_md: '# 云端正文' }),
      }),
    );

    expect(plan.kind).toBe('align');
    if (plan.kind !== 'align') {
      return;
    }
    expect(plan.payload).toMatchObject({ contentMd: '# 云端正文' });
  });

  it('处理结果与状态同时给出且自洽时按结果推导状态', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        cloudSnapshot: cloudEnvelope({
          schema_version: 1,
          content_md: '# 云端正文',
          handling_result: 'FIXED',
          handling_status: 'COMPLETED',
        }),
      }),
    );

    expect(plan.kind).toBe('align');
    if (plan.kind !== 'align') {
      return;
    }
    expect(plan.payload).toMatchObject({
      handlingResult: 'FIXED',
      handlingStatus: 'COMPLETED',
    });
  });

  it('处理结果与状态不自洽时失败关闭（不落自相矛盾的数据）', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        cloudSnapshot: cloudEnvelope({
          schema_version: 1,
          content_md: '# 云端正文',
          handling_result: 'FIXED',
          handling_status: 'UNRESOLVED',
        }),
      }),
    );

    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') {
      return;
    }
    expect(plan.code).toBe(SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID);
  });

  it('有处理状态却没有处理结果时失败关闭', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        cloudSnapshot: cloudEnvelope({
          schema_version: 1,
          content_md: '# 云端正文',
          handling_result: null,
          handling_status: 'COMPLETED',
        }),
      }),
    );

    expect(plan.kind).toBe('reject');
  });

  it('已知字段类型非法时失败关闭（不能当成"没有该字段"）', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        cloudSnapshot: cloudEnvelope({
          schema_version: 1,
          content_md: 123,
        }),
      }),
    );

    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') {
      return;
    }
    expect(plan.code).toBe(SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID);
  });

  it('处理结果不是受控取值时失败关闭（不猜语义）', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        cloudSnapshot: cloudEnvelope({
          schema_version: 1,
          content_md: '# 云端正文',
          handling_result: 'NOT_A_REAL_RESULT',
        }),
      }),
    );

    expect(plan.kind).toBe('reject');
  });

  it('云端快照没有任何可对齐字段时失败关闭（拒绝空对齐）', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        cloudSnapshot: cloudEnvelope({ schema_version: 1, request_no: 'RQ-1' }),
      }),
    );

    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') {
      return;
    }
    expect(plan.code).toBe(SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID);
  });

  it('没有可用本地版本时失败关闭（不猜版本）', () => {
    const plan = planCloudConflictAlignment(makeInput({ localVersion: null }));

    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') {
      return;
    }
    expect(plan.code).toBe(SYNC_ERROR.CLOUD_ALIGNMENT_VERSION_UNAVAILABLE);
  });

  it('资源类型没有受控对齐入口时失败关闭', () => {
    const plan = planCloudConflictAlignment(makeInput({ resourceType: 'MAINTENANCE_REPORT' }));

    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') {
      return;
    }
    expect(plan.code).toBe(SYNC_ERROR.CLOUD_ALIGNMENT_RESOURCE_UNSUPPORTED);
  });

  it('资料：给出受控对齐载荷（标题／说明／正文取自云端快照的 snake_case 字段）', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        resourceType: 'REFERENCE_DOCUMENT',
        cloudSnapshot: cloudEnvelope({
          schema_version: 1,
          title: '云端标题',
          description: '云端说明',
          content_text: '云端正文',
          original_filename: 'a.pdf',
          mime_type: 'application/pdf',
        }),
      }),
    );

    expect(plan.kind).toBe('align');
    if (plan.kind !== 'align') {
      return;
    }
    expect(plan.payload).toEqual({
      resourceType: 'REFERENCE_DOCUMENT',
      expectedVersion: 4,
      title: '云端标题',
      description: '云端说明',
      contentText: '云端正文',
    });
  });

  it('资料：云端缺字段时按"云端没有该字段"处理（本地保持原值）', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        resourceType: 'REFERENCE_DOCUMENT',
        cloudSnapshot: cloudEnvelope({
          schema_version: 1,
          title: '云端标题',
          description: null,
          content_text: null,
        }),
      }),
    );

    expect(plan.kind).toBe('align');
    if (plan.kind !== 'align') {
      return;
    }
    expect(plan.payload).toEqual({
      resourceType: 'REFERENCE_DOCUMENT',
      expectedVersion: 4,
      title: '云端标题',
      description: null,
      contentText: null,
    });
  });

  it('资料：空串按"云端没有该字段"处理（不写空、不清空）', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        resourceType: 'REFERENCE_DOCUMENT',
        cloudSnapshot: cloudEnvelope({
          schema_version: 1,
          title: '',
          description: '云端说明',
          content_text: '',
        }),
      }),
    );

    expect(plan.kind).toBe('align');
    if (plan.kind !== 'align') {
      return;
    }
    expect(plan.payload).toMatchObject({ title: null, contentText: null });
  });

  it('资料：没有任何可对齐字段时失败关闭（拒绝空对齐）', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        resourceType: 'REFERENCE_DOCUMENT',
        cloudSnapshot: cloudEnvelope({
          schema_version: 1,
          document_type: 'MANUAL',
          current_revision_no: 5,
        }),
      }),
    );

    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') {
      return;
    }
    expect(plan.code).toBe(SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID);
  });

  it('资料：已知字段类型非法时失败关闭', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        resourceType: 'REFERENCE_DOCUMENT',
        cloudSnapshot: cloudEnvelope({ schema_version: 1, title: 123 }),
      }),
    );

    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') {
      return;
    }
    expect(plan.code).toBe(SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID);
  });

  it('云端快照结构版本不符时失败关闭（不猜字段含义）', () => {
    const plan = planCloudConflictAlignment(
      makeInput({
        cloudSnapshot: JSON.stringify({ schema_version: 99, body: { content_md: 'x' } }),
      }),
    );

    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') {
      return;
    }
    expect(plan.code).toBe(SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID);
  });
});
