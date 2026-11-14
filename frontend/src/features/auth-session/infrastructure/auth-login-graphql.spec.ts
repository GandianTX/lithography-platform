// src/features/auth-session/infrastructure/auth-login-graphql.spec.ts

import { describe, expect, it } from 'vitest';

import { createGraphQLAuthLoginGateway } from './auth-login-graphql';

const LOGIN_RESPONSE = {
  login: {
    accessToken: 'access-token',
    accountId: 900101,
    role: 'ENGINEER',
    restriction: 'NONE',
    adminLevel: null,
    customerOrganizationId: null,
    userInfo: {
      accessGroup: ['ENGINEER'],
      avatarUrl: 'https://example.test/avatar/chen.png',
      nickname: '陈工',
    },
  },
};

describe('GraphQL auth login gateway', () => {
  it('uses the existing public GraphQL ingress and maps the minimal safe session', async () => {
    const calls: Array<{
      options: unknown;
      query: string;
      variables: unknown;
    }> = [];
    const gateway = createGraphQLAuthLoginGateway(async (query, variables, options) => {
      calls.push({ options, query, variables });

      return LOGIN_RESPONSE;
    });

    const result = await gateway.loginWithPassword({
      loginName: 'mock_engineer_chen',
      loginPassword: 'local-password',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({
      allowAuthRetry: false,
      authMode: 'none',
    });
    expect(calls[0]?.variables).toEqual({
      input: {
        // Web 端始终允许受限会话登录，由后端返回 restriction 决定落地页
        allowRestrictedSession: true,
        audience: 'SSTSWEB',
        loginName: 'mock_engineer_chen',
        loginPassword: 'local-password',
        type: 'PASSWORD',
      },
    });
    expect(calls[0]?.query).toContain('mutation LoginWithPassword');
    expect(calls[0]?.query).toContain('accessToken');
    expect(calls[0]?.query).toContain('accountId');
    expect(calls[0]?.query).toContain('restriction');
    expect(calls[0]?.query).toContain('adminLevel');
    expect(calls[0]?.query).toContain('customerOrganizationId');
    expect(calls[0]?.query).toContain('nickname');
    expect(calls[0]?.query).toContain('accessGroup');
    expect(calls[0]?.query).toContain('avatarUrl');
    expect(calls[0]?.query).not.toContain('refreshToken');
    expect(calls[0]?.query).not.toContain('metaDigest');
    expect(result).toEqual(LOGIN_RESPONSE.login);
  });

  it('rejects malformed or unknown-role responses through the existing ingress error model', async () => {
    const gateway = createGraphQLAuthLoginGateway(async () => ({
      login: {
        ...LOGIN_RESPONSE.login,
        role: 'UNKNOWN',
      },
    }));

    await expect(
      gateway.loginWithPassword({
        loginName: 'mock_engineer_chen',
        loginPassword: 'local-password',
      }),
    ).rejects.toMatchObject({
      name: 'GraphQLIngressError',
      operationName: 'LoginWithPassword',
      type: 'malformed',
    });
  });
});
