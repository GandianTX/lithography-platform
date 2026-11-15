// src/features/admin-engineer-approval/infrastructure/admin-engineer-approval-adapter.spec.ts

/**
 * 审批 adapter 契约测试：
 * - GraphQL 变量只下发实际提供的状态筛选（null 表示不筛选）；
 * - 原始 DTO 经 mapper 归一后才进入 feature 模型，未知枚举失败关闭；
 * - 业务拒绝按稳定大类码映射为显式失败结果，transport / auth 类失败原样上抛。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import {
  fetchAdminEngineerRegistrationDetail,
  fetchAdminEngineerRegistrations,
  reviewEngineerRegistration,
} from './admin-engineer-approval-adapter';

const { executeGraphQLMock } = vi.hoisted(() => ({ executeGraphQLMock: vi.fn() }));

vi.mock('@/shared/graphql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/graphql')>();

  return { ...actual, executeGraphQL: executeGraphQLMock };
});

function buildItem(overrides: Record<string, unknown> = {}) {
  return {
    application: {
      id: 61,
      accountId: 501,
      organizationId: 9,
      status: 'PENDING',
      applicationNote: ' 希望加入组织 ',
      submittedAt: '2026-11-01T08:00:00.000Z',
      reviewedByAccountId: null,
      reviewedAt: null,
      reviewComment: null,
      ...(overrides.application as Record<string, unknown> | undefined),
    },
    organizationName: ' 甲公司 ',
    applicant: {
      id: 501,
      loginName: 'pending-engineer',
      loginEmail: 'pending@example.com',
      nickname: '待审工程师',
      companyName: null,
      phone: '13800000001',
      contactEmail: null,
      role: 'ENGINEER',
      status: 'PENDING',
      ...(overrides.applicant as Record<string, unknown> | undefined),
    },
    ...(overrides.organizationName === undefined
      ? {}
      : { organizationName: overrides.organizationName }),
  };
}

function graphqlError(code: string, errorMessage?: string) {
  return new GraphQLIngressError({
    type: 'graphql',
    message: 'graphql error',
    graphqlErrors: [
      {
        message: errorMessage ?? code,
        extensions: { code, ...(errorMessage ? { errorMessage } : {}) },
      },
    ],
  });
}

beforeEach(() => {
  executeGraphQLMock.mockReset();
});

describe('fetchAdminEngineerRegistrations', () => {
  it('下发分页与状态筛选，映射为队列页并归一可选文本', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminEngineerRegistrations: { items: [buildItem()], page: 2, pageSize: 10, total: 11 },
    });

    const page = await fetchAdminEngineerRegistrations({
      page: 2,
      pageSize: 10,
      status: 'PENDING',
    });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('adminEngineerRegistrations'),
      {
        pagination: { mode: 'OFFSET', page: 2, pageSize: 10, withTotal: true },
        status: 'PENDING',
      },
    );
    expect(page.total).toBe(11);
    expect(page.items[0]).toMatchObject({
      applicationId: 61,
      organizationId: 9,
      organizationName: '甲公司',
      applicationNote: '希望加入组织',
      status: 'PENDING',
      applicant: { nickname: '待审工程师', phone: '13800000001', contactEmail: null },
    });
  });

  it('不筛选状态时不发送 status 变量', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminEngineerRegistrations: { items: [], page: 1, pageSize: 10, total: 0 },
    });

    await fetchAdminEngineerRegistrations({ page: 1, pageSize: 10, status: null });

    expect(executeGraphQLMock.mock.calls[0][1]).toStrictEqual({
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
    });
  });

  it('无法识别的状态让整次映射失败，而不是降级展示', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminEngineerRegistrations: {
        items: [buildItem({ application: { status: 'UNKNOWN' } })],
        page: 1,
        pageSize: 10,
        total: 1,
      },
    });

    await expect(
      fetchAdminEngineerRegistrations({ page: 1, pageSize: 10, status: null }),
    ).rejects.toThrow('无法识别的状态');
  });
});

describe('fetchAdminEngineerRegistrationDetail', () => {
  it('读取详情并按主键映射', async () => {
    executeGraphQLMock.mockResolvedValue({ adminEngineerRegistrationDetail: buildItem() });

    const result = await fetchAdminEngineerRegistrationDetail(61);

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('adminEngineerRegistrationDetail'),
      { applicationId: 61 },
    );
    expect(result).toMatchObject({ ok: true, registration: { applicationId: 61 } });
  });

  it('跨公司或不存在统一映射为 not-found 业务失败', async () => {
    executeGraphQLMock.mockRejectedValue(graphqlError('NOT_FOUND'));

    await expect(fetchAdminEngineerRegistrationDetail(61)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });

  it('transport 类失败原样上抛，不伪装成业务拒绝', async () => {
    const transportError = new GraphQLIngressError({ type: 'network', message: 'offline' });
    executeGraphQLMock.mockRejectedValue(transportError);

    await expect(fetchAdminEngineerRegistrationDetail(61)).rejects.toBe(transportError);
  });
});

describe('reviewEngineerRegistration', () => {
  it('提交动作与原因，成功后返回落库行', async () => {
    executeGraphQLMock.mockResolvedValue({
      reviewEngineerRegistration: buildItem({
        application: { status: 'REJECTED', reviewComment: '资料不足' },
      }),
    });

    const result = await reviewEngineerRegistration({
      applicationId: 61,
      action: 'REJECT',
      reviewComment: '资料不足',
    });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('reviewEngineerRegistration'),
      { input: { applicationId: 61, action: 'REJECT', reviewComment: '资料不足' } },
    );
    expect(result).toMatchObject({
      ok: true,
      registration: { status: 'REJECTED', reviewComment: '资料不足' },
    });
  });

  it('并发第二人决定返回 CONFLICT 时映射为 state-conflict', async () => {
    executeGraphQLMock.mockRejectedValue(graphqlError('CONFLICT', '该申请已被处理'));

    await expect(
      reviewEngineerRegistration({ applicationId: 61, action: 'APPROVE', reviewComment: null }),
    ).resolves.toEqual({
      ok: false,
      reason: 'state-conflict',
      message: '该申请已被处理',
    });
  });

  it('越权与空原因分别映射为 forbidden / invalid-input', async () => {
    executeGraphQLMock.mockRejectedValueOnce(graphqlError('FORBIDDEN'));
    await expect(
      reviewEngineerRegistration({ applicationId: 61, action: 'APPROVE', reviewComment: null }),
    ).resolves.toMatchObject({ ok: false, reason: 'forbidden' });

    executeGraphQLMock.mockRejectedValueOnce(graphqlError('BAD_USER_INPUT'));
    await expect(
      reviewEngineerRegistration({ applicationId: 61, action: 'REJECT', reviewComment: '' }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' });
  });
});
