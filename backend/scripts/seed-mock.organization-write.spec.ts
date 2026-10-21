// scripts/seed-mock.organization-write.spec.ts

/**
 * R03 Seed 组织/成员固定主键碰撞保护（S01–S06）。
 *
 * 无实库：用内存 fake manager 模拟 `manager.query`，只验证归属核验与写入 SQL 契约，
 * 不在测试中连接数据库、不执行 Seed 入口。
 */

/// <reference types="jest" />
import type { EntityManager } from 'typeorm';

import {
  assertSeedMembershipOwnership,
  resolveSeedOrganization,
  type SeedMembershipWriteSpec,
  type SeedOrganization,
  upsertSeedMembership,
  upsertSeedOrganization,
} from './seed-mock.organization-write';

interface FakeOrganizationRow {
  id: number;
  organizationCode: string;
  name: string;
  kind: string;
  status: string;
}

interface FakeMembershipRow {
  id: number;
  organizationId: number;
  accountId: number;
  memberRole: string;
  status: string;
  leftAt: Date | null;
}

interface FakeDatabase {
  organizations: Map<number, FakeOrganizationRow>;
  memberships: Map<number, FakeMembershipRow>;
  manager: EntityManager;
  statements: { sql: string; params: unknown[] }[];
}

const toOrganizationQueryRow = (row: FakeOrganizationRow): Record<string, unknown> => ({
  id: row.id,
  organization_code: row.organizationCode,
  name: row.name,
  kind: row.kind,
  status: row.status,
});

const toMembershipQueryRow = (row: FakeMembershipRow): Record<string, unknown> => ({
  id: row.id,
  organization_id: row.organizationId,
  account_id: row.accountId,
  member_role: row.memberRole,
  status: row.status,
  left_at: row.leftAt,
});

const normalizeSql = (sql: string): string => sql.replace(/\s+/gu, ' ').trim();

/** 统计某类 DML（INSERT/UPDATE）语句数量，用于断言“冲突时无写入” */
const countStatements = (db: FakeDatabase, prefix: string): number =>
  db.statements.filter(({ sql }) => normalizeSql(sql).startsWith(prefix)).length;

const createFakeDatabase = (
  seed: {
    organizations?: readonly FakeOrganizationRow[];
    memberships?: readonly FakeMembershipRow[];
  } = {},
): FakeDatabase => {
  const organizations = new Map<number, FakeOrganizationRow>(
    (seed.organizations ?? []).map((row) => [row.id, { ...row }]),
  );
  const memberships = new Map<number, FakeMembershipRow>(
    (seed.memberships ?? []).map((row) => [row.id, { ...row }]),
  );
  const statements: { sql: string; params: unknown[] }[] = [];

  const query = jest.fn((sql: string, params: unknown[] = []): unknown => {
    statements.push({ sql, params });
    const normalized = normalizeSql(sql);

    if (normalized.startsWith('SELECT') && normalized.includes('FROM organization_membership')) {
      if (normalized.includes('WHERE organization_id')) {
        const organizationId = Number(params[0]);
        const accountId = Number(params[1]);
        return [...memberships.values()]
          .filter((row) => row.organizationId === organizationId && row.accountId === accountId)
          .map(toMembershipQueryRow);
      }
      const row = memberships.get(Number(params[0]));
      return row ? [toMembershipQueryRow(row)] : [];
    }

    if (normalized.startsWith('SELECT') && normalized.includes('FROM organization')) {
      if (normalized.includes('WHERE organization_code')) {
        const organizationCode = String(params[0]);
        return [...organizations.values()]
          .filter((row) => row.organizationCode === organizationCode)
          .map(toOrganizationQueryRow);
      }
      const row = organizations.get(Number(params[0]));
      return row ? [toOrganizationQueryRow(row)] : [];
    }

    if (normalized.startsWith('INSERT INTO organization_membership ')) {
      const [id, organizationId, accountId, memberRole, status, , leftAt] = params;
      memberships.set(Number(id), {
        id: Number(id),
        organizationId: Number(organizationId),
        accountId: Number(accountId),
        memberRole: String(memberRole),
        status: String(status),
        leftAt: leftAt instanceof Date ? leftAt : null,
      });
      return { affectedRows: 1 };
    }

    if (normalized.startsWith('UPDATE organization_membership ')) {
      const [memberRole, status, , , id] = params;
      const row = memberships.get(Number(id));
      if (row) {
        row.memberRole = String(memberRole);
        row.status = String(status);
        row.leftAt = status === 'LEFT' ? (row.leftAt ?? new Date()) : null;
      }
      return { affectedRows: row ? 1 : 0 };
    }

    if (normalized.startsWith('INSERT INTO organization ')) {
      const [id, organizationCode, name, kind, status] = params;
      organizations.set(Number(id), {
        id: Number(id),
        organizationCode: String(organizationCode),
        name: String(name),
        kind: String(kind),
        status: String(status),
      });
      return { affectedRows: 1 };
    }

    if (normalized.startsWith('UPDATE organization ')) {
      const [name, id] = params;
      const row = organizations.get(Number(id));
      if (row) row.name = String(name);
      return { affectedRows: row ? 1 : 0 };
    }

    throw new Error(`未识别的 SQL：${normalized}`);
  });

  return { organizations, memberships, manager: { query } as unknown as EntityManager, statements };
};

const organizationSpec = (overrides: Partial<SeedOrganization> = {}): SeedOrganization => ({
  id: 910_002,
  organizationCode: 'PEER_ALT',
  name: '同行隔离测试组织',
  kind: 'PEER',
  status: 'ACTIVE',
  ...overrides,
});

const membershipSpec = (
  overrides: Partial<SeedMembershipWriteSpec> = {},
): SeedMembershipWriteSpec => ({
  id: 915_001,
  organizationCode: 'CLIENT_DEFAULT',
  organizationId: 910_001,
  accountId: 900_001,
  memberRole: 'SUPER_ADMIN',
  status: 'ACTIVE',
  ...overrides,
});

describe('Seed 组织/成员固定主键碰撞保护（R03）', () => {
  it('S01 成员固定主键已存在但组织/账号不符：抛错且无 UPDATE/INSERT', async () => {
    const db = createFakeDatabase({
      memberships: [
        {
          id: 915_001,
          organizationId: 910_001,
          accountId: 999_999,
          memberRole: 'ENGINEER',
          status: 'ACTIVE',
          leftAt: null,
        },
      ],
    });

    await expect(upsertSeedMembership(db.manager, membershipSpec())).rejects.toThrow(/915001/u);
    expect(countStatements(db, 'UPDATE organization_membership ')).toBe(0);
    expect(countStatements(db, 'INSERT INTO organization_membership ')).toBe(0);
    expect(db.memberships.get(915_001)).toMatchObject({
      organizationId: 910_001,
      accountId: 999_999,
      memberRole: 'ENGINEER',
    });
  });

  it('S02 组织编码已在另一主键且固定主键又被异主占用：抛错且无写入', async () => {
    const db = createFakeDatabase({
      organizations: [
        { id: 42, organizationCode: 'PEER_ALT', name: '既有同行', kind: 'PEER', status: 'ACTIVE' },
        {
          id: 910_002,
          organizationCode: 'OTHER_ORG',
          name: '异主组织',
          kind: 'CLIENT',
          status: 'ACTIVE',
        },
      ],
    });

    await expect(upsertSeedOrganization(db.manager, organizationSpec())).rejects.toThrow(
      /PEER_ALT.*910002|910002.*PEER_ALT/u,
    );
    expect(countStatements(db, 'UPDATE organization ')).toBe(0);
    expect(countStatements(db, 'INSERT INTO organization ')).toBe(0);
    expect(db.organizations.get(42)).toMatchObject({ organizationCode: 'PEER_ALT' });
    expect(db.organizations.get(910_002)).toMatchObject({ organizationCode: 'OTHER_ORG' });
  });

  it('S03 组织固定主键被异编码占用：抛错且无写入', async () => {
    const db = createFakeDatabase({
      organizations: [
        {
          id: 910_002,
          organizationCode: 'OTHER_ORG',
          name: '异编码组织',
          kind: 'CLIENT',
          status: 'ACTIVE',
        },
      ],
    });

    await expect(upsertSeedOrganization(db.manager, organizationSpec())).rejects.toThrow(
      /910002.*OTHER_ORG/u,
    );
    expect(countStatements(db, 'UPDATE organization ')).toBe(0);
    expect(countStatements(db, 'INSERT INTO organization ')).toBe(0);
  });

  it('S04 成员 (organization_id, account_id) 已存在于另一主键：抛错且无写入', async () => {
    const db = createFakeDatabase({
      memberships: [
        {
          id: 7,
          organizationId: 910_001,
          accountId: 900_001,
          memberRole: 'ENGINEER',
          status: 'ACTIVE',
          leftAt: null,
        },
      ],
    });

    await expect(upsertSeedMembership(db.manager, membershipSpec())).rejects.toThrow(
      /900001.*主键 7|主键 7.*900001/u,
    );
    expect(countStatements(db, 'UPDATE organization_membership ')).toBe(0);
    expect(countStatements(db, 'INSERT INTO organization_membership ')).toBe(0);
    expect(db.memberships.get(7)).toMatchObject({ memberRole: 'ENGINEER' });
  });

  it('S05 迁移基础组织按编码解析真实主键，且不改名称/状态', async () => {
    const db = createFakeDatabase({
      organizations: [
        {
          id: 7,
          organizationCode: 'CLIENT_DEFAULT',
          name: '迁移建立的名称',
          kind: 'CLIENT',
          status: 'ACTIVE',
        },
      ],
    });

    const spec = organizationSpec({
      id: 910_001,
      organizationCode: 'CLIENT_DEFAULT',
      name: '甲方默认组织',
      kind: 'CLIENT',
    });

    await expect(resolveSeedOrganization(db.manager, spec)).resolves.toEqual({
      id: 7,
      mode: 'MIGRATION_BASE',
    });
    await expect(upsertSeedOrganization(db.manager, spec)).resolves.toBe(7);

    expect(countStatements(db, 'UPDATE organization ')).toBe(0);
    expect(countStatements(db, 'INSERT INTO organization ')).toBe(0);
    expect(db.organizations.get(7)).toMatchObject({
      name: '迁移建立的名称',
      kind: 'CLIENT',
      status: 'ACTIVE',
    });
  });

  it('S05 迁移基础组织非 ACTIVE：明确拒绝且无写入', async () => {
    const db = createFakeDatabase({
      organizations: [
        {
          id: 7,
          organizationCode: 'CLIENT_DEFAULT',
          name: '甲方默认组织',
          kind: 'CLIENT',
          status: 'DISABLED',
        },
      ],
    });

    const spec = organizationSpec({
      id: 910_001,
      organizationCode: 'CLIENT_DEFAULT',
      kind: 'CLIENT',
    });

    await expect(upsertSeedOrganization(db.manager, spec)).rejects.toThrow(/DISABLED/u);
    expect(countStatements(db, 'UPDATE organization ')).toBe(0);
    expect(countStatements(db, 'INSERT INTO organization ')).toBe(0);
  });

  it('S06 组织均不存在：以固定主键 INSERT 并回读校验', async () => {
    const db = createFakeDatabase();

    await expect(upsertSeedOrganization(db.manager, organizationSpec())).resolves.toBe(910_002);

    const insert = db.statements.find(({ sql }) =>
      normalizeSql(sql).startsWith('INSERT INTO organization '),
    );
    expect(insert?.params[0]).toBe(910_002);
    expect(db.organizations.get(910_002)).toMatchObject({
      organizationCode: 'PEER_ALT',
      kind: 'PEER',
      status: 'ACTIVE',
    });
    expect(
      db.statements.some(
        ({ sql }) =>
          normalizeSql(sql).includes('FROM organization') &&
          normalizeSql(sql).includes('WHERE id = ?'),
      ),
    ).toBe(true);
  });

  it('S06 成员均不存在：以固定主键 INSERT 并回读校验', async () => {
    const db = createFakeDatabase({
      organizations: [
        {
          id: 910_001,
          organizationCode: 'CLIENT_DEFAULT',
          name: '甲方默认组织',
          kind: 'CLIENT',
          status: 'ACTIVE',
        },
      ],
    });

    await expect(assertSeedMembershipOwnership(db.manager, membershipSpec())).resolves.toBe(
      'ABSENT',
    );
    await expect(upsertSeedMembership(db.manager, membershipSpec())).resolves.toBe(915_001);

    const insert = db.statements.find(({ sql }) =>
      normalizeSql(sql).startsWith('INSERT INTO organization_membership '),
    );
    expect(insert?.params.slice(0, 3)).toEqual([915_001, 910_001, 900_001]);
    expect(db.memberships.get(915_001)).toMatchObject({
      organizationId: 910_001,
      accountId: 900_001,
      memberRole: 'SUPER_ADMIN',
      status: 'ACTIVE',
    });
    expect(
      db.statements.some(({ sql }) =>
        normalizeSql(sql).startsWith(
          'SELECT id, organization_id, account_id, member_role, status, left_at FROM organization_membership WHERE id = ?',
        ),
      ),
    ).toBe(true);
  });

  it('同主键同编码复用：组织仅更新 name/updated_at 白名单字段', async () => {
    const db = createFakeDatabase({
      organizations: [
        {
          id: 910_002,
          organizationCode: 'PEER_ALT',
          name: '旧名称',
          kind: 'PEER',
          status: 'ACTIVE',
        },
      ],
    });

    await expect(
      upsertSeedOrganization(db.manager, organizationSpec({ name: '新名称' })),
    ).resolves.toBe(910_002);

    const updates = db.statements.filter(({ sql }) =>
      normalizeSql(sql).startsWith('UPDATE organization '),
    );
    expect(updates).toHaveLength(1);
    const updateSql = normalizeSql(updates[0].sql);
    expect(updateSql).toContain('SET name = ?');
    expect(updateSql).not.toContain('organization_code');
    expect(updateSql).not.toContain('kind');
    expect(updateSql).not.toContain('status');
    expect(db.organizations.get(910_002)).toMatchObject({
      organizationCode: 'PEER_ALT',
      name: '新名称',
      kind: 'PEER',
      status: 'ACTIVE',
    });
  });

  it('同主键同 (org,account) 且角色/状态/left_at 一致：纯 no-op', async () => {
    const db = createFakeDatabase({
      memberships: [
        {
          id: 915_001,
          organizationId: 910_001,
          accountId: 900_001,
          memberRole: 'SUPER_ADMIN',
          status: 'ACTIVE',
          leftAt: null,
        },
      ],
    });

    await expect(assertSeedMembershipOwnership(db.manager, membershipSpec())).resolves.toBe('SAME');
    await expect(upsertSeedMembership(db.manager, membershipSpec())).resolves.toBe(915_001);

    expect(countStatements(db, 'UPDATE organization_membership ')).toBe(0);
    expect(countStatements(db, 'INSERT INTO organization_membership ')).toBe(0);
    expect(db.memberships.get(915_001)).toMatchObject({
      organizationId: 910_001,
      accountId: 900_001,
      memberRole: 'SUPER_ADMIN',
      status: 'ACTIVE',
      leftAt: null,
    });
  });

  it('成员角色被人工修改：拒绝且零写入，不还原 SUPER_ADMIN', async () => {
    const db = createFakeDatabase({
      memberships: [
        {
          id: 915_001,
          organizationId: 910_001,
          accountId: 900_001,
          memberRole: 'ENGINEER',
          status: 'ACTIVE',
          leftAt: null,
        },
      ],
    });

    await expect(assertSeedMembershipOwnership(db.manager, membershipSpec())).rejects.toThrow(
      /member_role=ENGINEER/u,
    );
    expect(countStatements(db, 'UPDATE organization_membership ')).toBe(0);
    expect(countStatements(db, 'INSERT INTO organization_membership ')).toBe(0);
    expect(db.memberships.get(915_001)).toMatchObject({
      memberRole: 'ENGINEER',
      status: 'ACTIVE',
      leftAt: null,
    });
  });

  it('成员已退出而 Seed 期望 ACTIVE：拒绝且不清空 left_at', async () => {
    const leftAt = new Date('2026-01-02T03:04:05.000Z');
    const db = createFakeDatabase({
      memberships: [
        {
          id: 915_001,
          organizationId: 910_001,
          accountId: 900_001,
          memberRole: 'SUPER_ADMIN',
          status: 'LEFT',
          leftAt,
        },
      ],
    });

    await expect(assertSeedMembershipOwnership(db.manager, membershipSpec())).rejects.toThrow(
      /status=LEFT/u,
    );
    expect(countStatements(db, 'UPDATE organization_membership ')).toBe(0);
    expect(countStatements(db, 'INSERT INTO organization_membership ')).toBe(0);
    expect(db.memberships.get(915_001)).toMatchObject({ status: 'LEFT', leftAt });
  });

  it('成员状态为 LEFT 但缺少 left_at：拒绝且零写入', async () => {
    const db = createFakeDatabase({
      memberships: [
        {
          id: 915_001,
          organizationId: 910_001,
          accountId: 900_001,
          memberRole: 'SUPER_ADMIN',
          status: 'LEFT',
          leftAt: null,
        },
      ],
    });

    await expect(
      assertSeedMembershipOwnership(db.manager, membershipSpec({ status: 'LEFT' })),
    ).rejects.toThrow(/left_at=NULL/u);
    expect(countStatements(db, 'UPDATE organization_membership ')).toBe(0);
    expect(countStatements(db, 'INSERT INTO organization_membership ')).toBe(0);
  });
});
