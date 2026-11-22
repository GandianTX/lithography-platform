// src/features/my-records/infrastructure/my-records-adapter.spec.ts

/**
 * 我的资料记录 adapter 单测（任务 07）。
 *
 * 守住：OFFSET + withTotal 恒为 true、筛选按值下推、详情 NOT_FOUND/FORBIDDEN 归并
 * not-found、transport 失败不吞（原样上抛由共享错误模型处理）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import { fetchMyRecord, fetchMyRecords } from './my-records-adapter';

const { executeGraphQLMock } = vi.hoisted(() => ({ executeGraphQLMock: vi.fn() }));

vi.mock('@/shared/graphql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/graphql')>();

  return { ...actual, executeGraphQL: executeGraphQLMock };
});

const PAGE = {
  items: [
    {
      id: 960001,
      sourceType: 'HISTORICAL_CASE',
      repairRequestId: null,
      title: '记录',
      status: 'DRAFT',
      currentVersionNo: 0,
      maintenanceDate: null,
      updatedAt: '2026-10-01T00:00:00.000Z',
      publishedDocumentId: null,
    },
  ],
  total: 1,
  page: 2,
  pageSize: 10,
};

beforeEach(() => {
  executeGraphQLMock.mockReset();
});

describe('fetchMyRecords', () => {
  it('恒为 OFFSET + withTotal，无筛选时不发送 filter 字段', async () => {
    executeGraphQLMock.mockResolvedValue({ myMaintenanceRecordList: PAGE });

    const result = await fetchMyRecords({ page: 2, pageSize: 10 });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('myMaintenanceRecordList'),
      { pagination: { mode: 'OFFSET', page: 2, pageSize: 10, withTotal: true } },
    );
    expect(result.total).toBe(1);
    expect(result.page).toBe(2);
  });

  it('筛选按值下推 sourceType 与 recordKind', async () => {
    executeGraphQLMock.mockResolvedValue({
      myMaintenanceRecordList: { ...PAGE, total: undefined },
    });

    const result = await fetchMyRecords({
      page: 1,
      pageSize: 10,
      filter: { sourceType: 'WORK_ORDER_SUMMARY', recordKind: 'FORMAL' },
    });

    expect(executeGraphQLMock).toHaveBeenCalledWith(expect.any(String), {
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
      filter: { sourceType: 'WORK_ORDER_SUMMARY', recordKind: 'FORMAL' },
    });
    // total 缺失时兜底 0（后端 withTotal 时必返回，前端仅类型兜底）
    expect(result.total).toBe(0);
  });

  it('标题关键词按值下推（服务端在归属谓词内全量搜索，非客户端当页过滤）', async () => {
    executeGraphQLMock.mockResolvedValue({ myMaintenanceRecordList: PAGE });

    await fetchMyRecords({ page: 1, pageSize: 10, filter: { titleKeyword: '光刻' } });

    expect(executeGraphQLMock).toHaveBeenCalledWith(expect.any(String), {
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
      filter: { titleKeyword: '光刻' },
    });
  });
});

describe('fetchMyRecord', () => {
  it('成功返回详情', async () => {
    executeGraphQLMock.mockResolvedValue({ myMaintenanceRecordDetail: { report: { id: 960001 } } });

    await expect(fetchMyRecord(960001)).resolves.toEqual({
      ok: true,
      detail: { report: { id: 960001 } },
    });
  });

  it('NOT_FOUND / FORBIDDEN 统一归并 not-found（防探测）', async () => {
    executeGraphQLMock.mockRejectedValue(
      new GraphQLIngressError({
        type: 'graphql',
        message: '访问被拒绝',
        graphqlErrors: [
          {
            message: '访问被拒绝',
            extensions: { code: 'FORBIDDEN', errorMessage: '当前账号无权查看维修报告' },
          },
        ],
      }),
    );

    await expect(fetchMyRecord(960001)).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: '当前账号无权查看维修报告',
    });
  });

  it('transport 失败原样上抛，不伪造 not-found', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: '网络错误' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchMyRecord(960001)).rejects.toBe(networkError);
  });
});
