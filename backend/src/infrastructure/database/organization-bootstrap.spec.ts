import type { EntityManager } from 'typeorm';

import {
  applyOrganizationBootstrap,
  parseOrganizationBootstrapConfig,
  type OrganizationBootstrapEntry,
} from './organization-bootstrap';

const validFile = JSON.stringify({
  schema_version: 1,
  organizations: [
    {
      organization_code: 'ORG-CLIENT-A',
      name: '示例客户公司',
      short_name: '客户A',
      kind: 'CLIENT',
      is_managed_company: false,
      is_service_provider: false,
      status: 'ACTIVE',
    },
    {
      organization_code: 'ORG-PEER-A',
      name: '示例受管公司',
      kind: 'PEER',
      is_managed_company: true,
      is_service_provider: true,
      status: 'ACTIVE',
    },
  ],
});

describe('组织映射文件（不连接实库）', () => {
  it('合法映射可解析并保留类别与标记', () => {
    const config = parseOrganizationBootstrapConfig(validFile);
    expect(config.schemaVersion).toBe(1);
    expect(config.organizations).toHaveLength(2);
    expect(config.organizations[1]).toMatchObject({
      organizationCode: 'ORG-PEER-A',
      kind: 'PEER',
      isManagedCompany: true,
      isServiceProvider: true,
    });
  });

  it('重复编码、非法类别、非 ACTIVE 与缺失布尔标记均失败关闭', () => {
    expect(() =>
      parseOrganizationBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          organizations: [
            {
              organization_code: 'ORG-A',
              name: 'A',
              kind: 'CLIENT',
              is_managed_company: false,
              is_service_provider: false,
              status: 'ACTIVE',
            },
            {
              organization_code: 'ORG-A',
              name: 'A2',
              kind: 'PEER',
              is_managed_company: true,
              is_service_provider: true,
              status: 'ACTIVE',
            },
          ],
        }),
      ),
    ).toThrow(/重复编码/);

    expect(() =>
      parseOrganizationBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          organizations: [
            {
              organization_code: 'ORG-A',
              name: 'A',
              kind: 'OTHER',
              is_managed_company: false,
              is_service_provider: false,
              status: 'ACTIVE',
            },
          ],
        }),
      ),
    ).toThrow(/kind/);

    expect(() =>
      parseOrganizationBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          organizations: [
            {
              organization_code: 'ORG-A',
              name: 'A',
              kind: 'CLIENT',
              is_managed_company: false,
              is_service_provider: false,
              status: 'DISABLED',
            },
          ],
        }),
      ),
    ).toThrow(/status/);

    expect(() =>
      parseOrganizationBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          organizations: [
            {
              organization_code: 'ORG-A',
              name: 'A',
              kind: 'CLIENT',
              is_service_provider: false,
              status: 'ACTIVE',
            },
          ],
        }),
      ),
    ).toThrow(/is_managed_company/);
  });

  it('schema_version、空数组与未知字段均失败关闭', () => {
    expect(() =>
      parseOrganizationBootstrapConfig(JSON.stringify({ schema_version: 2, organizations: [] })),
    ).toThrow(/schema_version/);
    expect(() =>
      parseOrganizationBootstrapConfig(JSON.stringify({ schema_version: 1, organizations: [] })),
    ).toThrow(/非空数组/);
    expect(() =>
      parseOrganizationBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          organizations: [],
          extra: true,
        }),
      ),
    ).toThrow(/不支持的字段/);
  });
});

describe('组织初始化写入契约（伪 EntityManager）', () => {
  const clientEntry: OrganizationBootstrapEntry = {
    organizationCode: 'ORG-CLIENT-A',
    name: '示例客户公司',
    shortName: null,
    kind: 'CLIENT',
    isManagedCompany: false,
    isServiceProvider: false,
  };

  it('公司已存在且标记一致时返回 UNCHANGED 且不写库', async () => {
    const queries: string[] = [];
    const manager = {
      query: jest.fn((sql: string): Promise<unknown> => {
        queries.push(sql);
        if (sql.includes('FROM `organization`')) {
          return Promise.resolve([
            {
              id: 7,
              name: '示例客户公司',
              short_name: null,
              kind: 'CLIENT',
              is_managed_company: 0,
              is_service_provider: 0,
              status: 'ACTIVE',
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    };

    const results = await applyOrganizationBootstrap(manager as unknown as EntityManager, {
      schemaVersion: 1,
      organizations: [clientEntry],
    });

    expect(results).toEqual([
      {
        organizationCode: 'ORG-CLIENT-A',
        kind: 'CLIENT',
        outcome: 'UNCHANGED',
        nameMismatch: false,
      },
    ]);
    expect(queries.some((sql) => sql.includes('INSERT INTO `organization`'))).toBe(false);
  });

  it('编码相同名称不同时只报告差异，不覆盖既有名称', async () => {
    const queries: string[] = [];
    const manager = {
      query: jest.fn((sql: string): Promise<unknown> => {
        queries.push(sql);
        if (sql.includes('FROM `organization`')) {
          return Promise.resolve([
            {
              id: 7,
              name: '已存在的旧名称',
              short_name: null,
              kind: 'CLIENT',
              is_managed_company: 0,
              is_service_provider: 0,
              status: 'ACTIVE',
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    };

    const results = await applyOrganizationBootstrap(manager as unknown as EntityManager, {
      schemaVersion: 1,
      organizations: [clientEntry],
    });

    expect(results).toEqual([
      {
        organizationCode: 'ORG-CLIENT-A',
        kind: 'CLIENT',
        outcome: 'UNCHANGED',
        nameMismatch: true,
      },
    ]);
    expect(queries.some((sql) => sql.includes('UPDATE `organization`'))).toBe(false);
  });

  it('公司不存在时创建并返回 CREATED', async () => {
    const manager = {
      query: jest.fn((sql: string): Promise<unknown> => {
        if (sql.includes('FROM `organization`')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }),
    };

    const results = await applyOrganizationBootstrap(manager as unknown as EntityManager, {
      schemaVersion: 1,
      organizations: [clientEntry],
    });

    expect(results).toEqual([
      {
        organizationCode: 'ORG-CLIENT-A',
        kind: 'CLIENT',
        outcome: 'CREATED',
        nameMismatch: false,
      },
    ]);
  });

  it('已存在公司类别冲突时失败关闭，不覆盖', async () => {
    const manager = {
      query: jest.fn((): Promise<unknown> =>
        Promise.resolve([
          {
            id: 7,
            name: '示例客户公司',
            short_name: null,
            kind: 'PEER',
            is_managed_company: 0,
            is_service_provider: 0,
            status: 'ACTIVE',
          },
        ]),
      ),
    };

    await expect(
      applyOrganizationBootstrap(manager as unknown as EntityManager, {
        schemaVersion: 1,
        organizations: [clientEntry],
      }),
    ).rejects.toThrow(/kind=PEER/);
  });
});
