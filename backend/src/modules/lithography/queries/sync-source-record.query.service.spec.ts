/// <reference types="jest" />
import { deriveRecordUuid } from '@core/local-runtime/policy/record-package-export.policy';

import {
  SYNC_SOURCE_SCAN_LIMIT,
  SyncSourceRecordQueryService,
} from './sync-source-record.query.service';

/**
 * 来源记录事实读取（任务 09 后续S1.4）。
 *
 * 覆盖口径：持久化稳定编号走**定向定位**（不再全表扫描）；历史行回退派生值扫描
 * 并标记“跨端身份未持久化”；扫描截断如实报告不完整。
 */
describe('SyncSourceRecordQueryService', () => {
  const organizationId = 4;
  const resourceType = 'MAINTENANCE_REPORT' as const;

  const reportRow = (overrides: Record<string, unknown> = {}) => ({
    id: 12,
    recordUuid: null as string | null,
    ownerOrganizationId: organizationId,
    currentVersionNo: 3,
    createdByAccountId: 900101,
    maintenanceEngineerAccountId: null,
    updatedByAccountId: null,
    ...overrides,
  });

  function buildService(rows: unknown[][]) {
    const reportRepository = { find: jest.fn() };
    const documentRepository = { find: jest.fn() };
    const repairRequestRepository = { find: jest.fn() };
    let call = 0;
    reportRepository.find.mockImplementation(() => {
      const next = rows[call] ?? [];
      call += 1;
      return Promise.resolve(next);
    });

    const service = new SyncSourceRecordQueryService(
      reportRepository as never,
      documentRepository as never,
      repairRequestRepository as never,
    );
    return { service, reportRepository };
  }

  it('持久化稳定编号命中时按列定向定位，不触发全表扫描', async () => {
    const { service, reportRepository } = buildService([
      [reportRow({ recordUuid: 'persisted-uuid-1' })],
    ]);

    const result = await service.listFacts({
      organizationId,
      resourceType,
      recordUuids: ['persisted-uuid-1'],
    });

    expect(reportRepository.find).toHaveBeenCalledTimes(1);
    const fact = result.facts.get('persisted-uuid-1');
    expect(fact).toBeDefined();
    expect(fact?.identityPersisted).toBe(true);
    expect(fact?.recordId).toBe(12);
    expect(fact?.currentVersion).toBe(3);
    expect(result.scanComplete).toBe(true);
  });

  it('历史行未持久化稳定编号时回退派生值扫描，并标记身份未持久化', async () => {
    const derived = deriveRecordUuid('MAINTENANCE_REPORT', 12);
    const { service, reportRepository } = buildService([[], [reportRow()]]);

    const result = await service.listFacts({
      organizationId,
      resourceType,
      recordUuids: [derived],
    });

    expect(reportRepository.find).toHaveBeenCalledTimes(2);
    const fact = result.facts.get(derived);
    expect(fact).toBeDefined();
    expect(fact?.identityPersisted).toBe(false);
    expect(result.scanComplete).toBe(true);
  });

  it('持久化命中后不再扫描（历史回退只针对未命中的键）', async () => {
    const derived = deriveRecordUuid('MAINTENANCE_REPORT', 12);
    const { service, reportRepository } = buildService([
      [reportRow({ recordUuid: 'persisted-uuid-1' })],
      [reportRow()],
    ]);

    const result = await service.listFacts({
      organizationId,
      resourceType,
      recordUuids: ['persisted-uuid-1', derived],
    });

    expect(reportRepository.find).toHaveBeenCalledTimes(2);
    expect(result.facts.get('persisted-uuid-1')?.identityPersisted).toBe(true);
    expect(result.facts.get(derived)?.identityPersisted).toBe(false);
  });

  it('定向定位只取判定所需列，不把正文全文拉进内存', async () => {
    const { service, reportRepository } = buildService([
      [reportRow({ recordUuid: 'persisted-uuid-1' })],
    ]);

    await service.listFacts({
      organizationId,
      resourceType,
      recordUuids: ['persisted-uuid-1'],
    });

    const options = reportRepository.find.mock.calls[0][0] as {
      select?: Record<string, boolean>;
    };
    expect(options.select).toBeDefined();
    expect(options.select?.recordUuid).toBe(true);
    expect(options.select?.ownerOrganizationId).toBe(true);
    expect(Object.keys(options.select ?? {})).not.toContain('contentText');
  });

  it('回退扫描按主键固定排序并限制候选上限（避免 LIMIT 取到不确定子集）', async () => {
    const { service, reportRepository } = buildService([[], []]);

    await service.listFacts({ organizationId, resourceType, recordUuids: ['missing-uuid'] });

    const options = reportRepository.find.mock.calls[1][0] as {
      order?: Record<string, string>;
      take?: number;
    };
    expect(options.order).toEqual({ id: 'ASC' });
    expect(options.take).toBe(SYNC_SOURCE_SCAN_LIMIT + 1);
  });

  it('回退扫描超过上限时如实报告扫描不完整', async () => {
    const rows = Array.from({ length: SYNC_SOURCE_SCAN_LIMIT + 1 }, (_unused, index) =>
      reportRow({ id: index + 1 }),
    );
    const { service } = buildService([[], rows]);

    const result = await service.listFacts({
      organizationId,
      resourceType,
      recordUuids: ['missing-uuid'],
    });

    expect(result.scanComplete).toBe(false);
    expect(result.facts.size).toBe(0);
  });
});
