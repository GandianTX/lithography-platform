// src/features/registration/infrastructure/registration-organization-adapter.spec.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeGraphQLMock } = vi.hoisted(() => ({ executeGraphQLMock: vi.fn() }));

vi.mock('@/shared/graphql', () => ({ executeGraphQL: executeGraphQLMock }));

import {
  checkRegistrationOrganizationNameExists,
  fetchRegistrationOrganizations,
} from './registration-organization-adapter';

describe('fetchRegistrationOrganizations（公开公司候选）', () => {
  beforeEach(() => {
    executeGraphQLMock.mockReset();
  });

  it('以公开请求加载，OFFSET 分页并携带 total', async () => {
    executeGraphQLMock.mockResolvedValue({
      registrationOrganizationSearch: {
        items: [{ id: 1, name: '公司A' }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });

    const page = await fetchRegistrationOrganizations({ page: 1, pageSize: 20 });

    expect(page).toEqual({
      items: [{ id: 1, name: '公司A' }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('registrationOrganizationSearch'),
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true },
      },
      { authMode: 'none', fetchPolicy: 'no-cache' },
    );
  });

  it('关键字去首尾空白后透传；空白关键字不携带', async () => {
    executeGraphQLMock.mockResolvedValue({
      registrationOrganizationSearch: { items: [], total: 0, page: 1, pageSize: 20 },
    });

    await fetchRegistrationOrganizations({ keyword: '  光刻  ', page: 1, pageSize: 20 });
    expect(executeGraphQLMock).toHaveBeenLastCalledWith(
      expect.any(String),
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true },
        keyword: '光刻',
      },
      expect.any(Object),
    );

    await fetchRegistrationOrganizations({ keyword: '   ', page: 1, pageSize: 20 });
    expect(executeGraphQLMock).toHaveBeenLastCalledWith(
      expect.any(String),
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true },
      },
      expect.any(Object),
    );
  });

  it('后端可空分页字段用请求值与 0 兜底', async () => {
    executeGraphQLMock.mockResolvedValue({
      registrationOrganizationSearch: { items: [], total: null, page: null, pageSize: null },
    });

    await expect(fetchRegistrationOrganizations({ page: 3, pageSize: 10 })).resolves.toEqual({
      items: [],
      total: 0,
      page: 3,
      pageSize: 10,
    });
  });
});

describe('checkRegistrationOrganizationNameExists（手填公司名精确同名查询）', () => {
  beforeEach(() => {
    executeGraphQLMock.mockReset();
  });

  it('以公开请求调用独立精确查询，只传名称且不使用缓存', async () => {
    executeGraphQLMock.mockResolvedValue({ registrationOrganizationNameExists: true });

    await expect(checkRegistrationOrganizationNameExists('同名公司')).resolves.toBe(true);

    expect(executeGraphQLMock).toHaveBeenCalledTimes(1);
    const [query, variables, options] = executeGraphQLMock.mock.calls[0];
    expect(query).toContain('query RegistrationOrganizationNameExists');
    expect(query).toContain('registrationOrganizationNameExists(name: $name)');
    expect(query).not.toContain('registrationOrganizationSearch');
    expect(variables).toEqual({ name: '同名公司' });
    expect(options).toEqual({ authMode: 'none', fetchPolicy: 'no-cache' });
  });

  it('未命中返回 false，非真值一律按未命中处理', async () => {
    executeGraphQLMock.mockResolvedValue({ registrationOrganizationNameExists: false });
    await expect(checkRegistrationOrganizationNameExists('不存在公司')).resolves.toBe(false);

    executeGraphQLMock.mockResolvedValue({ registrationOrganizationNameExists: null });
    await expect(checkRegistrationOrganizationNameExists('不存在公司')).resolves.toBe(false);
  });

  it('请求失败向上抛出，由调用方按未命中兜底', async () => {
    executeGraphQLMock.mockRejectedValue(new Error('network down'));
    await expect(checkRegistrationOrganizationNameExists('同名公司')).rejects.toThrow(
      'network down',
    );
  });
});
