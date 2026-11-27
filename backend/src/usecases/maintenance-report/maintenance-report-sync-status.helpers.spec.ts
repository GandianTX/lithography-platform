// src/usecases/maintenance-report/maintenance-report-sync-status.helpers.spec.ts
// 任务 07 同步状态预留的离线定向测试：查询键构造、批量装配与展示判定。
// 全部使用测试替身，不连数据库、不触发任何 I/O。

/// <reference types="jest" />

import type {
  MaintenanceReportSyncStatusEntry,
  MaintenanceReportSyncStatusReader,
} from './ports/maintenance-report-sync-status-reader.contract';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  attachMaintenanceReportSyncStatuses,
  buildMaintenanceReportSyncStatusQuery,
} from './maintenance-report-sync-status.helpers';

/** 服务端可信会话（记录级授权由提供方据此裁决，载荷不含身份） */
const SESSION: UsecaseSession = {
  accountId: 900001,
  activeRole: IdentityTypeEnum.ENGINEER,
  roles: ['ENGINEER'],
};

const ORG_ID = 101;
const UUID = '6fd663eb-6d92-47be-9fbf-c591f7eb8e67';
const OTHER_UUID = '613d90f1-d8b7-472f-9c42-f6021232ffa2';

const trustedFacts = {
  ownerOrganizationId: ORG_ID,
  recordUuid: UUID,
  currentVersionNo: 2,
};

const makeReader = (
  result?: unknown,
): MaintenanceReportSyncStatusReader & {
  fetchStatuses: jest.Mock;
} => ({
  fetchStatuses: jest.fn().mockResolvedValue(result ?? { connected: false, entries: [] }),
});

const makeEntry = (
  overrides: Partial<MaintenanceReportSyncStatusEntry> = {},
): MaintenanceReportSyncStatusEntry => ({
  organizationId: ORG_ID,
  resourceType: 'MAINTENANCE_REPORT',
  recordUuid: UUID,
  sourceVersion: 2,
  status: 'SYNCED',
  message: null,
  conflictId: null,
  canResolveConflict: false,
  ...overrides,
});

describe('buildMaintenanceReportSyncStatusQuery（查询键构造）', () => {
  it('跨端 UUID 缺失返回 null：不用本地 reportId/提交请求 ID 硬凑查询键', () => {
    expect(buildMaintenanceReportSyncStatusQuery({ ...trustedFacts, recordUuid: null })).toBeNull();
  });

  it('草稿 current_version_no=0 不是同步版本：返回 null', () => {
    expect(
      buildMaintenanceReportSyncStatusQuery({ ...trustedFacts, currentVersionNo: 0 }),
    ).toBeNull();
    expect(
      buildMaintenanceReportSyncStatusQuery({ ...trustedFacts, currentVersionNo: -1 }),
    ).toBeNull();
  });

  it('具备可信映射时构造完整四字段键（公司/资源类型/UUID/当前业务版本）', () => {
    expect(buildMaintenanceReportSyncStatusQuery(trustedFacts)).toEqual({
      organizationId: ORG_ID,
      resourceType: 'MAINTENANCE_REPORT',
      recordUuid: UUID,
      sourceVersion: 2,
    });
  });
});

describe('attachMaintenanceReportSyncStatuses（批量装配）', () => {
  it('records 为空时不调用提供方', async () => {
    const reader = makeReader();

    await expect(
      attachMaintenanceReportSyncStatuses({ reader, session: SESSION, records: [] }),
    ).resolves.toEqual(new Map());
    expect(reader.fetchStatuses).not.toHaveBeenCalled();
  });

  it('未装配（connected=false）：全部 NOT_CONNECTED，不从保存成功推断已同步', async () => {
    const reader = makeReader({ connected: false, entries: [makeEntry()] });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [
        { id: 1, facts: trustedFacts },
        { id: 2, facts: { ...trustedFacts, recordUuid: null } },
      ],
    });

    expect(result.get(1)).toMatchObject({ status: 'NOT_CONNECTED', canResolveConflict: false });
    expect(result.get(2)).toMatchObject({ status: 'NOT_CONNECTED' });
  });

  it('已装配但映射缺失（无跨端 UUID）：UNKNOWN，不发真实查询键', async () => {
    const reader = makeReader({ connected: true, entries: [] });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: { ...trustedFacts, recordUuid: null } }],
    });

    expect(result.get(1)).toMatchObject({ status: 'UNKNOWN' });
    expect(reader.fetchStatuses).toHaveBeenCalledTimes(1);
    expect(reader.fetchStatuses).toHaveBeenCalledWith(SESSION, []);
  });

  it('已装配且草稿 0 版本：不发真实查询，映射缺失按 UNKNOWN 展示', async () => {
    const reader = makeReader({ connected: true, entries: [] });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: { ...trustedFacts, currentVersionNo: 0 } }],
    });

    expect(result.get(1)).toMatchObject({ status: 'UNKNOWN' });
    expect(reader.fetchStatuses).toHaveBeenCalledWith(SESSION, []);
  });

  it('当前版本待上传/上传中/失败：透传提供方聚合状态（仅 BUSINESS_SYNC 口径由提供方裁决）', async () => {
    for (const status of ['PENDING', 'UPLOADING', 'FAILED'] as const) {
      const reader = makeReader({ connected: true, entries: [makeEntry({ status })] });

      const result = await attachMaintenanceReportSyncStatuses({
        reader,
        session: SESSION,
        records: [{ id: 1, facts: trustedFacts }],
      });

      expect(result.get(1)).toMatchObject({ status, conflictId: null, canResolveConflict: false });
    }
  });

  it('当前版本有匹配 SUCCEEDED 回执：SYNCED（完整键一致才采信）', async () => {
    const reader = makeReader({ connected: true, entries: [makeEntry()] });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: trustedFacts }],
    });

    expect(result.get(1)).toMatchObject({ status: 'SYNCED' });
  });

  it('CONFLICT + 有效冲突标识 + 提供方授权：展示 CONFLICT 与处理入口标记', async () => {
    const reader = makeReader({
      connected: true,
      entries: [
        makeEntry({
          status: 'CONFLICT',
          message: '本机与云端版本不一致',
          conflictId: 'b096c692-7556-4564-a4f8-2e2fb78b3880',
          canResolveConflict: true,
        }),
      ],
    });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: trustedFacts }],
    });

    expect(result.get(1)).toMatchObject({
      status: 'CONFLICT',
      message: '本机与云端版本不一致',
      conflictId: 'b096c692-7556-4564-a4f8-2e2fb78b3880',
      canResolveConflict: true,
    });
  });

  it('CONFLICT 但缺冲突标识或未授权：不展示处理入口', async () => {
    for (const overrides of [
      { conflictId: null, canResolveConflict: true },
      { conflictId: 'b096c692-7556-4564-a4f8-2e2fb78b3880', canResolveConflict: false },
    ]) {
      const reader = makeReader({
        connected: true,
        entries: [makeEntry({ status: 'CONFLICT', ...overrides })],
      });

      const result = await attachMaintenanceReportSyncStatuses({
        reader,
        session: SESSION,
        records: [{ id: 1, facts: trustedFacts }],
      });

      expect(result.get(1)).toMatchObject({ status: 'CONFLICT', canResolveConflict: false });
    }
  });

  it('非冲突状态不得携带处理入口（canResolveConflict=true 被清洗）', async () => {
    const reader = makeReader({
      connected: true,
      entries: [makeEntry({ status: 'SYNCED', canResolveConflict: true })],
    });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: trustedFacts }],
    });

    expect(result.get(1)).toMatchObject({ status: 'SYNCED', canResolveConflict: false });
  });

  it('漏项（提供方未返回该键）：UNKNOWN，不判成功', async () => {
    const reader = makeReader({
      connected: true,
      entries: [makeEntry({ recordUuid: OTHER_UUID })],
    });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: trustedFacts }],
    });

    expect(result.get(1)).toMatchObject({ status: 'UNKNOWN' });
  });

  it('重复匹配（同键多条）：UNKNOWN，不判成功', async () => {
    const reader = makeReader({ connected: true, entries: [makeEntry(), makeEntry()] });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: trustedFacts }],
    });

    expect(result.get(1)).toMatchObject({ status: 'UNKNOWN' });
  });

  it('返回旧版本（sourceVersion 不一致）不采信：UNKNOWN，不显示已同步', async () => {
    const reader = makeReader({
      connected: true,
      entries: [makeEntry({ sourceVersion: 1, status: 'SYNCED' })],
    });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: trustedFacts }],
    });

    expect(result.get(1)).toMatchObject({ status: 'UNKNOWN' });
  });

  it('错误公司（organizationId 不一致）不采信：UNKNOWN', async () => {
    const reader = makeReader({
      connected: true,
      entries: [makeEntry({ organizationId: 999 })],
    });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: trustedFacts }],
    });

    expect(result.get(1)).toMatchObject({ status: 'UNKNOWN' });
  });

  it('资源类型不一致不采信：UNKNOWN', async () => {
    const reader = makeReader({
      connected: true,
      entries: [makeEntry({ resourceType: 'REPORT_VERSION' })],
    });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: trustedFacts }],
    });

    expect(result.get(1)).toMatchObject({ status: 'UNKNOWN' });
  });

  it('提供方回报越界状态或 NOT_CONNECTED/UNKNOWN：不透传，降级 UNKNOWN', async () => {
    for (const status of ['SUCCEEDED', 'NOT_CONNECTED', 'UNKNOWN']) {
      const reader = makeReader({
        connected: true,
        entries: [makeEntry({ status: status as never })],
      });

      const result = await attachMaintenanceReportSyncStatuses({
        reader,
        session: SESSION,
        records: [{ id: 1, facts: trustedFacts }],
      });

      expect(result.get(1)).toMatchObject({ status: 'UNKNOWN' });
    }
  });

  it('NOT_APPLICABLE（后端明确不走本地同步）可透传', async () => {
    const reader = makeReader({
      connected: true,
      entries: [makeEntry({ status: 'NOT_APPLICABLE' })],
    });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: trustedFacts }],
    });

    expect(result.get(1)).toMatchObject({ status: 'NOT_APPLICABLE' });
  });

  it('提供方查询失败：全部 UNKNOWN，不抛出、不影响原记录读取', async () => {
    const reader = {
      fetchStatuses: jest.fn().mockRejectedValue(new Error('sync provider unavailable')),
    } as never as MaintenanceReportSyncStatusReader & { fetchStatuses: jest.Mock };

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [
        { id: 1, facts: trustedFacts },
        { id: 2, facts: { ...trustedFacts, recordUuid: null } },
      ],
    });

    expect(result.get(1)).toMatchObject({ status: 'UNKNOWN' });
    expect(result.get(2)).toMatchObject({ status: 'UNKNOWN' });
  });

  it('提供方 message 硬性截断，不透传大段正文或路径', async () => {
    const longMessage = 'x'.repeat(500);
    const reader = makeReader({ connected: true, entries: [makeEntry({ message: longMessage })] });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [{ id: 1, facts: trustedFacts }],
    });

    expect(result.get(1)?.message).toBe('x'.repeat(200));
  });

  it('一页多条记录只批量调用一次，且只对具备可信映射的记录发键', async () => {
    const reader = makeReader({
      connected: true,
      entries: [makeEntry(), makeEntry({ recordUuid: OTHER_UUID, sourceVersion: 4 })],
    });

    const result = await attachMaintenanceReportSyncStatuses({
      reader,
      session: SESSION,
      records: [
        { id: 1, facts: trustedFacts },
        { id: 2, facts: { ...trustedFacts, recordUuid: OTHER_UUID, currentVersionNo: 4 } },
        { id: 3, facts: { ...trustedFacts, recordUuid: null } },
      ],
    });

    expect(reader.fetchStatuses).toHaveBeenCalledTimes(1);
    expect(reader.fetchStatuses).toHaveBeenCalledWith(SESSION, [
      {
        organizationId: ORG_ID,
        resourceType: 'MAINTENANCE_REPORT',
        recordUuid: UUID,
        sourceVersion: 2,
      },
      {
        organizationId: ORG_ID,
        resourceType: 'MAINTENANCE_REPORT',
        recordUuid: OTHER_UUID,
        sourceVersion: 4,
      },
    ]);
    expect(result.get(1)).toMatchObject({ status: 'SYNCED' });
    expect(result.get(2)).toMatchObject({ status: 'SYNCED' });
    expect(result.get(3)).toMatchObject({ status: 'UNKNOWN' });
  });
});
