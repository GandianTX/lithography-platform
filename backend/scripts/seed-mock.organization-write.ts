// scripts/seed-mock.organization-write.ts

/**
 * Seed 组织/成员固定主键写入（R03）。
 *
 * 本模块只负责“组织 + 成员”两张表的固定主键归属核验与写入，供 `seed-mock.ts`
 * 在既有事务内调用。模块导入不加载环境变量、不创建 DataSource、不执行任何逻辑。
 *
 * 原则：固定主键冲突一律失败关闭（抛错，由调用方事务整体回滚），
 * 绝不通过 upsert 覆盖异主记录或其外键/角色。
 */

import type { EntityManager } from 'typeorm';

export interface SeedOrganization {
  id: number;
  organizationCode: string;
  name: string;
  kind: 'CLIENT' | 'PEER';
  status: 'ACTIVE' | 'DISABLED';
}

export interface SeedMembership {
  id: number;
  organizationCode: string;
  accountId: number;
  memberRole: 'SUPER_ADMIN' | 'ENGINEER';
  status: 'ACTIVE' | 'LEFT';
}

/** 成员写入需要已解析的真实组织主键（CLIENT_DEFAULT 由编码解析得到）。 */
export interface SeedMembershipWriteSpec extends SeedMembership {
  organizationId: number;
}

export type SeedOrganizationResolveMode = 'MIGRATION_BASE' | 'SEED_KNOWN' | 'CREATED';

export interface SeedOrganizationResolution {
  id: number;
  mode: SeedOrganizationResolveMode;
}

/** 由 Migration 幂等建立的基础组织编码；其真实主键不固定。 */
const MIGRATION_BASE_ORGANIZATION_CODE = 'CLIENT_DEFAULT';

/** 与 `seed-mock.ts` 保持一致的 Seed 固定创建时间。 */
const FIXED_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

interface OrganizationRow {
  id: number;
  organizationCode: string;
  name: string;
  kind: string;
  status: string;
}

interface MembershipRow {
  id: number;
  organizationId: number;
  accountId: number;
  memberRole: string;
  status: string;
  leftAt: number | null;
}

function asRecordArray(value: unknown, context: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'object' || item === null)) {
    throw new Error(`${context} 查询结果格式无效`);
  }
  return value as Record<string, unknown>[];
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new Error(`字段 ${key} 不是有效数字`);
  return value;
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`字段 ${key} 不是字符串`);
  return value;
}

function readNullableTimestamp(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value !== 'string') {
    throw new Error(`字段 ${key} 不是有效时间`);
  }
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`字段 ${key} 不是有效时间`);
  return parsed;
}

function conflict(message: string): Error {
  return new Error(`Seed 固定主键冲突：${message}`);
}

async function findOrganizationByCode(
  manager: EntityManager,
  organizationCode: string,
): Promise<OrganizationRow | null> {
  const result: unknown = await manager.query(
    `SELECT id, organization_code, name, kind, status
     FROM organization
     WHERE organization_code = ?
     LIMIT 1`,
    [organizationCode],
  );
  const row = asRecordArray(result, 'organization')[0];
  if (!row) return null;
  return {
    id: readNumber(row, 'id'),
    organizationCode: readString(row, 'organization_code'),
    name: readString(row, 'name'),
    kind: readString(row, 'kind'),
    status: readString(row, 'status'),
  };
}

async function findOrganizationById(
  manager: EntityManager,
  id: number,
): Promise<OrganizationRow | null> {
  const result: unknown = await manager.query(
    `SELECT id, organization_code, name, kind, status
     FROM organization
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  const row = asRecordArray(result, 'organization')[0];
  if (!row) return null;
  return {
    id: readNumber(row, 'id'),
    organizationCode: readString(row, 'organization_code'),
    name: readString(row, 'name'),
    kind: readString(row, 'kind'),
    status: readString(row, 'status'),
  };
}

async function findMembershipById(
  manager: EntityManager,
  id: number,
): Promise<MembershipRow | null> {
  const result: unknown = await manager.query(
    `SELECT id, organization_id, account_id, member_role, status, left_at
     FROM organization_membership
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  const row = asRecordArray(result, 'organization_membership')[0];
  if (!row) return null;
  return {
    id: readNumber(row, 'id'),
    organizationId: readNumber(row, 'organization_id'),
    accountId: readNumber(row, 'account_id'),
    memberRole: readString(row, 'member_role'),
    status: readString(row, 'status'),
    leftAt: readNullableTimestamp(row, 'left_at'),
  };
}

async function findMembershipByOrganizationAndAccount(
  manager: EntityManager,
  organizationId: number,
  accountId: number,
): Promise<MembershipRow | null> {
  const result: unknown = await manager.query(
    `SELECT id, organization_id, account_id, member_role, status, left_at
     FROM organization_membership
     WHERE organization_id = ? AND account_id = ?
     LIMIT 1`,
    [organizationId, accountId],
  );
  const row = asRecordArray(result, 'organization_membership')[0];
  if (!row) return null;
  return {
    id: readNumber(row, 'id'),
    organizationId: readNumber(row, 'organization_id'),
    accountId: readNumber(row, 'account_id'),
    memberRole: readString(row, 'member_role'),
    status: readString(row, 'status'),
    leftAt: readNullableTimestamp(row, 'left_at'),
  };
}

/**
 * 同时按 organization_code 与固定 id 解析组织归属：
 * - CLIENT_DEFAULT 且编码行存在 → MIGRATION_BASE（真实 id 来自编码，绝不改写属性）；
 * - 编码行与固定 id 行为同一行 → SEED_KNOWN（可复用，仅更新白名单展示字段）；
 * - 编码已在另一 id、固定 id 被异主占用、类别/状态不匹配 → 抛错；
 * - 两者均不存在 → CREATED（约定使用固定 id 插入）。
 */
export async function resolveSeedOrganization(
  manager: EntityManager,
  spec: SeedOrganization,
): Promise<SeedOrganizationResolution> {
  const byCode = await findOrganizationByCode(manager, spec.organizationCode);
  const byId = await findOrganizationById(manager, spec.id);

  if (byCode) {
    if (byId && byId.id !== byCode.id) {
      throw conflict(
        `组织固定主键 ${spec.id} 已被编码 ${byId.organizationCode} 占用，期望编码 ${spec.organizationCode}（该编码实际主键 ${byCode.id}）`,
      );
    }

    if (spec.organizationCode === MIGRATION_BASE_ORGANIZATION_CODE) {
      if (byCode.kind !== spec.kind) {
        throw conflict(
          `迁移基础组织 ${spec.organizationCode} 类别不匹配：期望 ${spec.kind}，实际 ${byCode.kind}`,
        );
      }
      if (byCode.status !== 'ACTIVE') {
        throw conflict(
          `迁移基础组织 ${spec.organizationCode}（主键 ${byCode.id}）状态为 ${byCode.status}，不满足 Seed 试用前提 ACTIVE`,
        );
      }
      return { id: byCode.id, mode: 'MIGRATION_BASE' };
    }

    if (byCode.id !== spec.id) {
      throw conflict(
        `组织编码 ${spec.organizationCode} 已存在于主键 ${byCode.id}，与固定主键 ${spec.id} 不一致`,
      );
    }
    if (byCode.kind !== spec.kind) {
      throw conflict(
        `组织 ${spec.organizationCode}（主键 ${byCode.id}）类别不匹配：期望 ${spec.kind}，实际 ${byCode.kind}`,
      );
    }
    if (byCode.status !== spec.status) {
      throw conflict(
        `组织 ${spec.organizationCode}（主键 ${byCode.id}）状态不匹配：期望 ${spec.status}，实际 ${byCode.status}`,
      );
    }
    return { id: byCode.id, mode: 'SEED_KNOWN' };
  }

  if (byId) {
    throw conflict(
      `组织固定主键 ${spec.id} 已被编码 ${byId.organizationCode} 占用，期望编码 ${spec.organizationCode}`,
    );
  }

  return { id: spec.id, mode: 'CREATED' };
}

/**
 * 成员归属核验（必须在任何 INSERT/UPDATE 之前调用）：
 * - 固定 id 已存在且组织/账号/角色/状态/left_at 全部一致 → SAME（纯 no-op）；
 * - 固定 id 已存在但组织/账号不符，或角色/状态/退出时间被修改 → 冲突；
 * - (organization_id, account_id) 已存在于另一 id → 冲突；
 * - 均不存在 → ABSENT。
 *
 * 已退出或被人工调整角色的成员不得由 Seed 重新启用/还原（原计划 S06）。
 */
export async function assertSeedMembershipOwnership(
  manager: EntityManager,
  spec: SeedMembershipWriteSpec,
): Promise<'ABSENT' | 'SAME'> {
  const expectedLeftAt = spec.status === 'LEFT' ? FIXED_CREATED_AT.getTime() : null;
  const byId = await findMembershipById(manager, spec.id);
  if (byId) {
    if (byId.organizationId !== spec.organizationId || byId.accountId !== spec.accountId) {
      throw conflict(
        `成员固定主键 ${spec.id} 已存在但归属不符：期望组织 ${spec.organizationId}/账号 ${spec.accountId}，实际组织 ${byId.organizationId}/账号 ${byId.accountId}`,
      );
    }
    const mismatches: string[] = [];
    if (byId.memberRole !== spec.memberRole) {
      mismatches.push(`member_role=${byId.memberRole}（期望 ${spec.memberRole}）`);
    }
    if (byId.status !== spec.status) {
      mismatches.push(`status=${byId.status}（期望 ${spec.status}）`);
    }
    if (byId.leftAt !== expectedLeftAt) {
      const actual = byId.leftAt === null ? 'NULL' : new Date(byId.leftAt).toISOString();
      const expected = expectedLeftAt === null ? 'NULL' : FIXED_CREATED_AT.toISOString();
      mismatches.push(`left_at=${actual}（期望 ${expected}）`);
    }
    if (mismatches.length > 0) {
      throw conflict(
        `成员 ${spec.id} 的权限/状态事实已被修改，拒绝由 Seed 重置：${mismatches.join('；')}`,
      );
    }
    return 'SAME';
  }

  const byKey = await findMembershipByOrganizationAndAccount(
    manager,
    spec.organizationId,
    spec.accountId,
  );
  if (byKey) {
    throw conflict(
      `成员（组织 ${spec.organizationId}，账号 ${spec.accountId}）已存在于主键 ${byKey.id}，与固定主键 ${spec.id} 不一致`,
    );
  }

  return 'ABSENT';
}

export async function upsertSeedOrganization(
  manager: EntityManager,
  spec: SeedOrganization,
): Promise<number> {
  const resolution = await resolveSeedOrganization(manager, spec);

  if (resolution.mode === 'MIGRATION_BASE') {
    return resolution.id;
  }

  if (resolution.mode === 'SEED_KNOWN') {
    // 白名单：仅更新 Mock 展示字段；id/organization_code/kind/status 一律不动。
    await manager.query(
      `UPDATE organization
       SET name = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [spec.name, resolution.id],
    );
    return resolution.id;
  }

  await manager.query(
    `INSERT INTO organization (id, organization_code, name, kind, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      spec.id,
      spec.organizationCode,
      spec.name,
      spec.kind,
      spec.status,
      FIXED_CREATED_AT,
      FIXED_CREATED_AT,
    ],
  );

  const inserted = await findOrganizationById(manager, spec.id);
  if (!inserted || inserted.id !== spec.id || inserted.organizationCode !== spec.organizationCode) {
    throw conflict(
      `组织插入回读校验失败：期望主键 ${spec.id}/编码 ${spec.organizationCode}，实际 ${inserted ? `主键 ${inserted.id}/编码 ${inserted.organizationCode}` : '未找到行'}`,
    );
  }
  return inserted.id;
}

export async function upsertSeedMembership(
  manager: EntityManager,
  spec: SeedMembershipWriteSpec,
): Promise<number> {
  const ownership = await assertSeedMembershipOwnership(manager, spec);

  if (ownership === 'SAME') {
    // 指纹完全一致：纯 no-op。绝不改写角色/状态/left_at，也不触碰外键归属。
    return spec.id;
  }

  const leftAt = spec.status === 'LEFT' ? FIXED_CREATED_AT : null;
  await manager.query(
    `INSERT INTO organization_membership
       (id, organization_id, account_id, member_role, status, joined_at, left_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      spec.id,
      spec.organizationId,
      spec.accountId,
      spec.memberRole,
      spec.status,
      FIXED_CREATED_AT,
      leftAt,
      FIXED_CREATED_AT,
      FIXED_CREATED_AT,
    ],
  );

  const inserted = await findMembershipById(manager, spec.id);
  if (
    !inserted ||
    inserted.id !== spec.id ||
    inserted.organizationId !== spec.organizationId ||
    inserted.accountId !== spec.accountId
  ) {
    throw conflict(
      `成员插入回读校验失败：期望主键 ${spec.id}/组织 ${spec.organizationId}/账号 ${spec.accountId}，实际 ${inserted ? `主键 ${inserted.id}/组织 ${inserted.organizationId}/账号 ${inserted.accountId}` : '未找到行'}`,
    );
  }
  return inserted.id;
}
