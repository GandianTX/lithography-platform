// src/features/auth-session/infrastructure/auth-session-identity-graphql.spec.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeGraphQLMock } = vi.hoisted(() => ({ executeGraphQLMock: vi.fn() }));

vi.mock('@/shared/graphql', () => ({ executeGraphQL: executeGraphQLMock }));

import { fetchMySessionIdentity } from './auth-session-identity-graphql';

describe('fetchMySessionIdentity（启动期会话身份复核）', () => {
  beforeEach(() => {
    executeGraphQLMock.mockReset();
  });

  it('以受保护查询读取身份，并把合法响应映射为快照', async () => {
    executeGraphQLMock.mockResolvedValue({
      mySessionIdentity: {
        accountId: 900201,
        role: 'ENGINEER',
        adminLevel: 2,
        customerOrganizationId: 31,
        engineerOrganizationId: 7701,
        adminOrganizationId: 8801,
        registrationOrganizationId: 6601,
        restriction: 'ENGINEER_PENDING',
      },
    });

    await expect(fetchMySessionIdentity()).resolves.toEqual({
      accountId: 900201,
      adminLevel: 2,
      customerOrganizationId: 31,
      engineerOrganizationId: 7701,
      adminOrganizationId: 8801,
      registrationOrganizationId: 6601,
      restriction: 'ENGINEER_PENDING',
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('query MySessionIdentity'),
      {},
    );
  });

  it('未知或非法 restriction 回落 null，绝不提升为 NONE 放行', async () => {
    executeGraphQLMock.mockResolvedValue({
      mySessionIdentity: {
        accountId: 900201,
        adminLevel: null,
        customerOrganizationId: null,
        restriction: 'UNKNOWN_RESTRICTION',
      },
    });

    await expect(fetchMySessionIdentity()).resolves.toMatchObject({ restriction: null });
  });

  it('缺失 restriction 也回落 null，由调用方保持现状', async () => {
    executeGraphQLMock.mockResolvedValue({
      mySessionIdentity: { accountId: 900201 },
    });

    await expect(fetchMySessionIdentity()).resolves.toEqual({
      accountId: 900201,
      adminLevel: null,
      customerOrganizationId: null,
      engineerOrganizationId: null,
      adminOrganizationId: null,
      registrationOrganizationId: null,
      restriction: null,
    });
  });

  it('adminLevel / customerOrganizationId 非数字时归一为 null', async () => {
    executeGraphQLMock.mockResolvedValue({
      mySessionIdentity: {
        accountId: 900201,
        adminLevel: '2',
        customerOrganizationId: '31',
        restriction: 'NONE',
      },
    });

    await expect(fetchMySessionIdentity()).resolves.toEqual({
      accountId: 900201,
      adminLevel: null,
      customerOrganizationId: null,
      engineerOrganizationId: null,
      adminOrganizationId: null,
      registrationOrganizationId: null,
      restriction: 'NONE',
    });
  });

  it.each([
    ['响应不是对象', null],
    ['缺少 mySessionIdentity', { somethingElse: true }],
    ['accountId 缺失', { mySessionIdentity: { role: 'ENGINEER' } }],
    ['accountId 非数字', { mySessionIdentity: { accountId: '900201' } }],
  ])('%s 时返回 null，不做部分写入', async (_label, response) => {
    executeGraphQLMock.mockResolvedValue(response);

    await expect(fetchMySessionIdentity()).resolves.toBeNull();
  });

  it('传输失败原样上抛，由调用方决定是否静默', async () => {
    executeGraphQLMock.mockRejectedValue(new Error('network down'));

    await expect(fetchMySessionIdentity()).rejects.toThrow('network down');
  });
});
