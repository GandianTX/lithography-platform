// test/utils/test-organizations.ts
//
// E2E 测试组织与成员关系工具（PR0-S0-S5 修复计划 R4 / F4）
//
// 背景：A-PR0 落库后，参考资料读写、管理员创建工程师、聚合文档库统计等用例
// 统一经 `TrustedOrganizationContextQueryService` 解析账号所属组织；测试账号
// 必须拥有**自己的**测试组织成员关系——不借用开发库默认组织，也不直接调用
// 开发 Seed 来初始化 E2E。
//
// 职责：
// - seedTestOrganizations：按规格专属编码建立/复用测试组织，返回 code → id
// - seedTestMemberships：按登录名解析账号后插入成员关系（ACTIVE / LEFT）
//
// 清理不再由本文件按自然键级联删除；归属核验、引用闭包与精确 ID 删除统一由
// `runGuardedSpecCleanup` 在同一事务内完成。

import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { DataSource } from 'typeorm';
import { recordOwnedResource, type OwnedResourceLedger } from './e2e-scoped-cleanup';

export interface TestOrganizationSpec {
  readonly organizationCode: string;
  readonly name: string;
  readonly kind: 'CLIENT' | 'PEER';
}

export interface TestMembershipSpec {
  readonly accountLoginName: string;
  readonly organizationCode: string;
  // 值域与实体 `chk_organization_membership_role` 一致：管理员代建账号会绑定 CUSTOMER
  readonly memberRole: 'SUPER_ADMIN' | 'ENGINEER' | 'CUSTOMER';
  readonly status?: 'ACTIVE' | 'LEFT';
}

/** 生成规格专属组织编码（跨 spec 隔离；E2E 前缀仅服务测试库，不进入业务数据） */
export const buildSuiteOrganizationCodes = (suite: string): { primary: string; peer: string } => ({
  primary: `E2E_${suite}_PRIMARY`,
  peer: `E2E_${suite}_PEER`,
});

/** 从 seedTestOrganizations 返回值取组织 ID；缺失即初始化失败，直接抛错阻断状态不明的测试 */
export const requireOrganizationId = (
  organizationIdsByCode: ReadonlyMap<string, number>,
  organizationCode: string,
): number => {
  const id = organizationIdsByCode.get(organizationCode);
  if (id === undefined) {
    throw new Error(`测试组织初始化失败：未找到组织编码 ${organizationCode} 对应的组织 ID`);
  }
  return id;
};

/**
 * 批量建立（或复用）测试组织。
 *
 * - 幂等：上次运行中断可能残留同编码组织（唯一键），复用前必须核验名称/类别/状态指纹；
 *   指纹不符即失败关闭，不接管同名异主组织；
 * - 只建立规格传入的组织，不触碰其他组织；
 * - `ownership` 存在时登记数据库真实 ID，供本轮精确清理。
 *
 * @returns organizationCode → organizationId 映射
 */
export const seedTestOrganizations = async (params: {
  readonly dataSource: DataSource;
  readonly organizations: readonly TestOrganizationSpec[];
  readonly ownership?: OwnedResourceLedger;
}): Promise<Map<string, number>> => {
  const { dataSource, organizations, ownership } = params;
  const repository = dataSource.getRepository(OrganizationEntity);
  const idByCode = new Map<string, number>();

  for (const spec of organizations) {
    const existing = await repository.findOne({
      where: { organizationCode: spec.organizationCode },
    });
    if (existing) {
      if (
        existing.name !== spec.name ||
        existing.kind !== spec.kind ||
        existing.status !== 'ACTIVE'
      ) {
        throw new Error(
          `测试组织复用失败：编码 ${spec.organizationCode} 已存在但指纹不符` +
            `（name=${existing.name}, kind=${existing.kind}, status=${existing.status}），拒绝接管`,
        );
      }
      idByCode.set(spec.organizationCode, existing.id);
      if (ownership) {
        recordOwnedResource(ownership, 'organization', existing.id, {
          organizationCode: spec.organizationCode,
          name: spec.name,
          kind: spec.kind,
          status: 'ACTIVE',
        });
      }
      continue;
    }
    const saved = await repository.save(
      repository.create({
        organizationCode: spec.organizationCode,
        name: spec.name,
        kind: spec.kind,
        status: 'ACTIVE',
      }),
    );
    idByCode.set(spec.organizationCode, saved.id);
    if (ownership) {
      recordOwnedResource(ownership, 'organization', saved.id, {
        organizationCode: spec.organizationCode,
        name: spec.name,
        kind: spec.kind,
        status: 'ACTIVE',
      });
    }
  }
  return idByCode;
};

/**
 * 批量建立成员关系。
 *
 * - 账号按登录名解析（事实来自库内，不由调用方传 ID）；
 * - 同一 (组织, 账号) 幂等：唯一键已保证不重复插入，存在时仅校准角色与状态；
 * - status='LEFT' 时同时写 left_at（实体 chk_organization_membership_period 兜底）。
 */
export const seedTestMemberships = async (params: {
  readonly dataSource: DataSource;
  readonly memberships: readonly TestMembershipSpec[];
  /** seedTestOrganizations 的返回值（组织编码 → 组织 ID） */
  readonly organizationIdsByCode: ReadonlyMap<string, number>;
  /** 本轮资源台账；登记真实成员关系 ID，供精确清理。 */
  readonly ownership?: OwnedResourceLedger;
}): Promise<void> => {
  const { dataSource, memberships, organizationIdsByCode, ownership } = params;
  const accountRepository = dataSource.getRepository(AccountEntity);
  const membershipRepository = dataSource.getRepository(OrganizationMembershipEntity);

  for (const spec of memberships) {
    const organizationId = requireOrganizationId(organizationIdsByCode, spec.organizationCode);
    const account = await accountRepository.findOne({
      where: { loginName: spec.accountLoginName },
    });
    if (!account) {
      throw new Error(`测试成员初始化失败：未找到测试账号 ${spec.accountLoginName}`);
    }

    const status = spec.status ?? 'ACTIVE';
    const leftAt = status === 'LEFT' ? new Date() : null;

    const existing = await membershipRepository.findOne({
      where: { organizationId, accountId: account.id },
    });
    if (existing) {
      await membershipRepository.update(existing.id, {
        memberRole: spec.memberRole,
        status,
        leftAt,
      });
      if (ownership) {
        // 受控更新成功后才登记预期事实（角色/状态为本次写入后的最终值）。
        recordOwnedResource(ownership, 'membership', existing.id, {
          organizationId,
          accountId: account.id,
          memberRole: spec.memberRole,
          status,
        });
      }
      continue;
    }
    const saved = await membershipRepository.save(
      membershipRepository.create({
        organizationId,
        accountId: account.id,
        memberRole: spec.memberRole,
        status,
        leftAt,
      }),
    );
    if (ownership) {
      recordOwnedResource(ownership, 'membership', saved.id, {
        organizationId,
        accountId: account.id,
        memberRole: spec.memberRole,
        status,
      });
    }
  }
};
