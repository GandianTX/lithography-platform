// src/core/local-runtime/policy/sync-conflict-readonly-view.policy.spec.ts

/**
 * 已结单冲突「使用云端」的**来源页只读投影**定向测试（任务 09 P1-4）。
 *
 * 守住：
 * 1. 只读采用（业务行未被改写）⇒ 来源页读回**云端内容**；
 * 2. 业务对齐（业务行已被改写）⇒ **不投影**（来源页本就是云端内容，不重复覆盖）；
 * 3. 用户在裁决后又自行编辑 ⇒ **不投影**（不得用旧云端快照盖掉用户新编辑）；
 * 4. 未结单／未裁决为使用云端／跨公司／快照非法 ⇒ 一律**不投影**（失败关闭）。
 */

import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';

import { planReadOnlyCloudAdoptedView } from './sync-conflict-readonly-view.policy';

const LOCAL_BODY = {
  schema_version: 1,
  resource_type: 'REPAIR_REQUEST',
  body: {
    content_md: '本地正文 A',
    handling_result: RepairRequestHandlingResult.FIXED,
    handling_status: RepairRequestHandlingStatus.COMPLETED,
  },
};

const CLOUD_BODY = {
  schema_version: 1,
  resource_type: 'REPAIR_REQUEST',
  body: {
    content_md: '云端正文 B',
    handling_result: RepairRequestHandlingResult.UNREPAIRABLE,
    handling_status: RepairRequestHandlingStatus.UNRESOLVED,
  },
};

const localSnapshot = JSON.stringify(LOCAL_BODY);
const cloudSnapshot = JSON.stringify(CLOUD_BODY);

const sourceFields = {
  contentMd: '本地正文 A',
  handlingResult: RepairRequestHandlingResult.FIXED,
  handlingStatus: RepairRequestHandlingStatus.COMPLETED,
};

describe('已结单冲突采用云端的来源页只读投影（P1-4）', () => {
  it('只读采用（业务行未被改写）⇒ 投影云端内容', () => {
    const plan = planReadOnlyCloudAdoptedView({
      resourceType: 'REPAIR_REQUEST',
      decision: 'CLOUD',
      status: 'RESOLVED',
      localSnapshot,
      cloudSnapshot,
      sourceFields,
      sourceClosed: true,
    });

    expect(plan.kind).toBe('project');
    if (plan.kind !== 'project') {
      throw new Error('应投影');
    }
    expect(plan.fields.contentMd).toBe('云端正文 B');
    expect(plan.fields.handlingResult).toBe(RepairRequestHandlingResult.UNREPAIRABLE);
    expect(plan.fields.handlingStatus).toBe(RepairRequestHandlingStatus.UNRESOLVED);
  });

  it('云端没有的字段 ⇒ 保留本地原值（与业务对齐写入器口径一致）', () => {
    const plan = planReadOnlyCloudAdoptedView({
      resourceType: 'REPAIR_REQUEST',
      decision: 'CLOUD',
      status: 'RESOLVED',
      localSnapshot,
      cloudSnapshot: JSON.stringify({
        schema_version: 1,
        body: { content_md: '云端只有正文 B' },
      }),
      sourceFields,
      sourceClosed: true,
    });

    expect(plan.kind).toBe('project');
    if (plan.kind !== 'project') {
      throw new Error('应投影');
    }
    expect(plan.fields.contentMd).toBe('云端只有正文 B');
    expect(plan.fields.handlingResult).toBe(RepairRequestHandlingResult.FIXED);
    expect(plan.fields.handlingStatus).toBe(RepairRequestHandlingStatus.COMPLETED);
  });

  it('业务对齐（业务行已被改写为云端内容）⇒ 不投影', () => {
    const plan = planReadOnlyCloudAdoptedView({
      resourceType: 'REPAIR_REQUEST',
      decision: 'CLOUD',
      status: 'RESOLVED',
      localSnapshot,
      cloudSnapshot,
      sourceFields: {
        contentMd: '云端正文 B',
        handlingResult: RepairRequestHandlingResult.UNREPAIRABLE,
        handlingStatus: RepairRequestHandlingStatus.UNRESOLVED,
      },
      sourceClosed: true,
    });

    expect(plan.kind).toBe('none');
  });

  it('用户在裁决后又自行编辑 ⇒ 不投影（不得用旧云端快照盖掉新编辑）', () => {
    const plan = planReadOnlyCloudAdoptedView({
      resourceType: 'REPAIR_REQUEST',
      decision: 'CLOUD',
      status: 'RESOLVED',
      localSnapshot,
      cloudSnapshot,
      sourceFields: {
        contentMd: '用户自己改过的正文 C',
        handlingResult: RepairRequestHandlingResult.FIXED,
        handlingStatus: RepairRequestHandlingStatus.COMPLETED,
      },
      sourceClosed: true,
    });

    expect(plan.kind).toBe('none');
  });

  it('未裁决为使用云端 / 未 resolved / 未结单 ⇒ 一律不投影', () => {
    const base = {
      resourceType: 'REPAIR_REQUEST',
      localSnapshot,
      cloudSnapshot,
      sourceFields,
      sourceClosed: true,
    };
    expect(
      planReadOnlyCloudAdoptedView({ ...base, decision: 'PENDING', status: 'PENDING' }).kind,
    ).toBe('none');
    expect(
      planReadOnlyCloudAdoptedView({ ...base, decision: 'CLOUD', status: 'PENDING' }).kind,
    ).toBe('none');
    expect(
      planReadOnlyCloudAdoptedView({
        ...base,
        decision: 'CLOUD',
        status: 'RESOLVED',
        sourceClosed: false,
      }).kind,
    ).toBe('none');
  });

  it('云端快照非法（类型非法／不自洽）⇒ 不投影（失败关闭）', () => {
    const invalidType = planReadOnlyCloudAdoptedView({
      resourceType: 'REPAIR_REQUEST',
      decision: 'CLOUD',
      status: 'RESOLVED',
      localSnapshot,
      cloudSnapshot: JSON.stringify({
        schema_version: 1,
        body: { content_md: '云端正文 B', handling_result: 'NOT_A_REAL_ENUM' },
      }),
      sourceFields,
      sourceClosed: true,
    });
    expect(invalidType.kind).toBe('none');

    const inconsistent = planReadOnlyCloudAdoptedView({
      resourceType: 'REPAIR_REQUEST',
      decision: 'CLOUD',
      status: 'RESOLVED',
      localSnapshot,
      cloudSnapshot: JSON.stringify({
        schema_version: 1,
        body: {
          content_md: '云端正文 B',
          handling_result: RepairRequestHandlingResult.FIXED,
          handling_status: RepairRequestHandlingStatus.UNRESOLVED,
        },
      }),
      sourceFields,
      sourceClosed: true,
    });
    expect(inconsistent.kind).toBe('none');
  });
});
