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
import {
  recordOwnedResource,
  type OwnedOrganizationFacts,
  type OwnedResourceLedger,
} from './e2e-scoped-cleanup';

export interface TestOrganizationSpec {
  readonly organizationCode: string;
  readonly name: string;
  readonly kind: 'CLIENT' | 'PEER';
  /**
   * 是否受管公司；Web 自助注册要求 `ACTIVE + 受管`（V44）。
   * 需要走注册资格的规格显式传 `true`，其余规格保持默认 `false`。
   */
  readonly isManagedCompany?: boolean;
  /**
   * 是否具备维修服务资格（`is_service_provider`，任务 03）。
   * 报修提交要求所选厂家 `ACTIVE + 具备维修服务资格`；需要作为报修厂家的
   * 规格显式传 `true`，其余规格保持默认 `false`。
   */
  readonly isServiceProvider?: boolean;
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
 * 在当前台账中按编码定位「本轮已拥有」的组织。
 *
 * 只有台账里同时存在真实 ID 与登记事实，才算拥有；仅编码相同不构成所有权证据。
 */
const findOwnedOrganizationByCode = (
  ownership: OwnedResourceLedger,
  organizationCode: string,
): { readonly id: number; readonly facts: OwnedOrganizationFacts } | undefined => {
  for (const id of ownership.organizationIds) {
    const facts = ownership.facts.organization.get(id);
    if (facts?.organizationCode === organizationCode) {
      return { id, facts };
    }
  }
  return undefined;
};

/**
 * 批量建立（或复用）测试组织。
 *
 * 归属口径（F2）：
 * - **本调用新建**：保存成功后登记真实 ID 与创建时预期事实；
 * - **本轮台账已拥有**：直接复用同一 ID，但必须先核验编码/名称/类别/状态/受管标记
 *   与登记时预期一致（本轮受控写入改变事实时由调用方显式 `updateOwnedExpectation`）；
 * - **库内已存在但本轮无所有权**：申请所有权（传入 `ownership`）时一律拒绝认领，
 *   即使编码、名称、类别、状态、受管标记全部相同；不得从库内现值补写台账。
 *   不申请所有权时按只读引用返回 ID，既不登记也不清理。
 *
 * 固定编码只应在「本轮唯一」或「只读引用公共组织」时使用；需要回收的规格请按
 * run/case 派生唯一编码，避免上一轮残留被自动接管。
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
    const owned = ownership
      ? findOwnedOrganizationByCode(ownership, spec.organizationCode)
      : undefined;
    if (owned) {
      if (owned.facts.name !== spec.name || owned.facts.kind !== spec.kind) {
        throw new Error(
          `测试组织复用失败：编码 ${spec.organizationCode} 已在本轮台账中但预期不符` +
            `（name=${owned.facts.name}, kind=${owned.facts.kind}），拒绝混用不同组织`,
        );
      }
      if (
        spec.isManagedCompany !== undefined &&
        owned.facts.isManagedCompany !== spec.isManagedCompany
      ) {
        throw new Error(
          `测试组织复用失败：编码 ${spec.organizationCode} 已在本轮台账中但受管标记不符` +
            `（owned.isManagedCompany=${String(owned.facts.isManagedCompany)}, expected=${spec.isManagedCompany}），拒绝混用`,
        );
      }

      // 台账内复用前必须核对数据库实值：登记后若被外部改写，旧 ID 不能继续流入 setup。
      // 本次读取只校验 setup 时事实；正式清理仍会在自身事务中重新预检。
      const current = await repository.findOne({ where: { id: owned.id } });
      if (!current) {
        throw new Error(
          `测试组织复用失败：编码 ${spec.organizationCode} 在本轮台账中登记为 ID=${owned.id}，` +
            '但数据库中已不存在该行；拒绝返回旧 ID，也不会按编码降级、重建或认领替代行',
        );
      }
      const driftedFields: string[] = [];
      const compareField = (
        field: keyof OwnedOrganizationFacts,
        actual: string | boolean | undefined,
        expected: string | boolean | undefined,
      ): void => {
        if (actual !== expected) {
          driftedFields.push(`${field}=${String(actual)}（预期 ${String(expected)}）`);
        }
      };
      compareField('organizationCode', current.organizationCode, owned.facts.organizationCode);
      compareField('name', current.name, owned.facts.name);
      compareField('kind', current.kind, owned.facts.kind);
      compareField('status', current.status, owned.facts.status);
      if (owned.facts.isManagedCompany !== undefined) {
        compareField('isManagedCompany', current.isManagedCompany, owned.facts.isManagedCompany);
      }
      if (driftedFields.length > 0) {
        throw new Error(
          `测试组织复用失败：编码 ${spec.organizationCode} 已在本轮台账中登记（ID=${owned.id}），` +
            `但数据库实值与登记预期不符（${driftedFields.join('; ')}）；拒绝返回旧 ID，台账保持原样`,
        );
      }
      idByCode.set(spec.organizationCode, owned.id);
      continue;
    }

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
      if (
        spec.isManagedCompany !== undefined &&
        existing.isManagedCompany !== spec.isManagedCompany
      ) {
        throw new Error(
          `测试组织复用失败：编码 ${spec.organizationCode} 已存在但受管标记不符` +
            `（existing.isManagedCompany=${existing.isManagedCompany}, expected=${spec.isManagedCompany}），拒绝接管`,
        );
      }
      if (
        spec.isServiceProvider !== undefined &&
        existing.isServiceProvider !== spec.isServiceProvider
      ) {
        throw new Error(
          `测试组织复用失败：编码 ${spec.organizationCode} 已存在但维修服务资格不符` +
            `（existing.isServiceProvider=${existing.isServiceProvider}, expected=${spec.isServiceProvider}），拒绝接管`,
        );
      }
      if (ownership) {
        // 指纹完全一致也不行：库内现值不是本轮创建证据，不能据此取得删除授权。
        throw new Error(
          `测试组织归属冲突：编码 ${spec.organizationCode} 已存在（ID=${existing.id}）但本轮台账无所有权证据，` +
            '拒绝接管；请改用本轮唯一编码重新创建，或由拥有该组织的入口显式登记后再引用',
        );
      }
      // 只读引用（如团队公共组织）：不登记、不清理，仅返回真实 ID。
      idByCode.set(spec.organizationCode, existing.id);
      continue;
    }

    const saved = await repository.save(
      repository.create({
        organizationCode: spec.organizationCode,
        name: spec.name,
        kind: spec.kind,
        status: 'ACTIVE',
        isManagedCompany: spec.isManagedCompany ?? false,
        isServiceProvider: spec.isServiceProvider ?? false,
      }),
    );
    idByCode.set(spec.organizationCode, saved.id);
    if (ownership) {
      recordOwnedResource(ownership, 'organization', saved.id, {
        organizationCode: spec.organizationCode,
        name: spec.name,
        kind: spec.kind,
        status: 'ACTIVE',
        isManagedCompany: spec.isManagedCompany ?? false,
        isServiceProvider: spec.isServiceProvider ?? false,
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
