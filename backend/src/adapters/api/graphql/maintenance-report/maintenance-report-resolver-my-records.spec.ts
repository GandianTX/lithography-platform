// src/adapters/api/graphql/maintenance-report/maintenance-report-resolver-my-records.spec.ts
// 我的资料记录 resolver 契约（任务 07）：filter 三字段（sourceType/recordKind/titleKeyword）
// 必须完整透传到 ListMyMaintenanceReportsUsecase——2026-11-22 实测发现 resolver 只映射
// 两字段导致 titleKeyword 静默失效（页面搜索看似全量命中），本 spec 钉住回归。

/// <reference types="jest" />

import { MaintenanceReportResolver } from './maintenance-report.resolver';

const ENGINEER_JWT = {
  sub: 900001,
  accessGroup: ['ENGINEER'],
  activeRole: 'ENGINEER',
  adminLevel: null,
  adminOrganizationId: null,
  customerOrganizationId: null,
  // RequestTimeSessionFacts 其余字段由守卫填充，resolver 映射只读上述字段
} as never;

const makeResolver = () => {
  const listMy = {
    execute: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
  };
  const stub = {} as never;
  const resolver = new MaintenanceReportResolver(
    stub,
    stub,
    stub,
    listMy as never,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );
  return { resolver, listMy };
};

describe('MaintenanceReportResolver.myMaintenanceRecordList（我的资料记录 filter 契约）', () => {
  it('sourceType / recordKind / titleKeyword 三字段完整透传到 usecase', async () => {
    const { resolver, listMy } = makeResolver();

    await resolver.myMaintenanceRecordList(
      { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true } as never,
      ENGINEER_JWT,
      { sourceType: 'HISTORICAL_CASE', recordKind: 'DRAFT', titleKeyword: '光刻' },
    );

    expect(listMy.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { sourceType: 'HISTORICAL_CASE', recordKind: 'DRAFT', titleKeyword: '光刻' },
      }),
    );
  });

  it('filter 缺省时 filter 字段为全空对象，不携带 undefined 键', async () => {
    const { resolver, listMy } = makeResolver();

    await resolver.myMaintenanceRecordList(
      { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true } as never,
      ENGINEER_JWT,
      undefined,
    );

    expect(listMy.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { sourceType: undefined, recordKind: undefined, titleKeyword: undefined },
      }),
    );
  });
});
