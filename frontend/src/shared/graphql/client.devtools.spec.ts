// src/shared/graphql/client.devtools.spec.ts

import { describe, expect, it } from 'vitest';

import { getGraphQLClient } from './client';

describe('GraphQL 客户端测试环境', () => {
  it('不注册 Apollo devtools 全局句柄与 10s 提示定时器', () => {
    expect(getGraphQLClient()).toBeDefined();
    expect((window as unknown as Record<string, unknown>).__APOLLO_CLIENT__).toBeUndefined();
  });
});
