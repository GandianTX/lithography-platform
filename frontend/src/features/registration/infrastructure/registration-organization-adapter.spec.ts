// src/features/registration/infrastructure/registration-organization-adapter.spec.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeGraphQLMock } = vi.hoisted(() => ({ executeGraphQLMock: vi.fn() }));

vi.mock('@/shared/graphql', () => ({ executeGraphQL: executeGraphQLMock }));

import { fetchRegistrationOrganizations } from './registration-organization-adapter';

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
