// src/infrastructure/database/admin-binding-inventory.ts

import type { EntityManager } from 'typeorm';

import {
  evaluateAdminBinding,
  maskLoginName,
  type AdminBindingConflictReason,
  type AdminBindingStatus,
} from '@core/account/policy/admin-binding.policy';

import { type AdminDefaultManagedCompanyEntry, createAdminAccount } from './admin-bootstrap';
import {
  loadAdminBindingCandidateRows,
  loadBootstrapAccount,
  toAdminBindingCandidate,
} from './bootstrap-account';
import type { FieldCipher } from '../field-encryption/field-encryption.cipher';
import { lockOrganizationByCode, isTruthyFlag } from './organization-bootstrap';

/**
 * 存量二级管理员绑定盘点与受控应用。
 *
 * 盘点只读；应用只处理「缺失绑定」且已在审查清单中明确批准的待处理 ID。
 * 冲突、错绑、停用公司与已绑定项一律零写入，交由人工处理。
 *
 * 计划 ID 由「状态 + 公司主键」生成：状态一旦变化，旧 ID 不再匹配，
 * 避免把审查过的缺失项误应用到已经变化的目标。
 */
export const ADMIN_BINDING_INVENTORY_VERSION = 'ADMIN_BINDING_INVENTORY_V1';

export type AdminBindingInventoryAction = 'NONE' | 'PROVISION' | 'MANUAL';

export interface AdminBindingInventoryCandidateRef {
  readonly accountId: number;
  readonly loginNameMasked: string;
}

export interface AdminBindingInventoryItem {
  readonly planId: string;
  readonly organizationId: number;
  readonly organizationCode: string;
  readonly status: AdminBindingStatus;
  readonly reason: AdminBindingConflictReason | null;
  readonly action: AdminBindingInventoryAction;
  readonly boundAccountId: number | null;
  readonly boundLoginNameMasked: string | null;
  readonly candidateCount: number;
  readonly accountDisabled: boolean;
  readonly candidates: ReadonlyArray<AdminBindingInventoryCandidateRef>;
}

export interface AdminBindingInventoryReport {
  readonly version: typeof ADMIN_BINDING_INVENTORY_VERSION;
  readonly items: ReadonlyArray<AdminBindingInventoryItem>;
  readonly summary: {
    readonly total: number;
    readonly bound: number;
    readonly unconfigured: number;
    readonly conflict: number;
    readonly companyDisabled: number;
    readonly manual: number;
  };
}

interface ManagedCompanyRow {
  readonly id: number;
  readonly organizationCode: string;
  readonly status: string;
  readonly isManagedCompany: boolean;
}

export function buildAdminBindingPlanId(
  status: AdminBindingStatus,
  organizationId: number,
): string {
  return `L2-${status}-${String(organizationId)}`;
}

function actionForStatus(status: AdminBindingStatus): AdminBindingInventoryAction {
  if (status === 'BOUND') {
    return 'NONE';
  }
  if (status === 'UNCONFIGURED') {
    return 'PROVISION';
  }
  return 'MANUAL';
}

async function loadManagedCompanies(
  manager: Pick<EntityManager, 'query'>,
): Promise<ReadonlyArray<ManagedCompanyRow>> {
  const rows: unknown = await manager.query(
    `
      SELECT \`id\`, \`organization_code\`, \`status\`, \`is_managed_company\`
      FROM \`organization\`
      WHERE \`is_managed_company\` = 1
      ORDER BY \`id\` ASC
    `,
  );
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((value): ManagedCompanyRow => {
    const row = value as {
      readonly id: number;
      readonly organization_code: string;
      readonly status: string;
      readonly is_managed_company: unknown;
    };
    return {
      id: Number(row.id),
      organizationCode: row.organization_code,
      status: row.status,
      isManagedCompany: isTruthyFlag(row.is_managed_company),
    };
  });
}

/**
 * 只读盘点：扫描全部受管公司，输出绑定状态与可审查的待处理清单。
 *
 * 不创建、不更新、不删除任何数据；不锁行。
 */
export async function inspectAdminBindingInventory(
  manager: Pick<EntityManager, 'query'>,
  cipher: FieldCipher,
): Promise<AdminBindingInventoryReport> {
  const companies = await loadManagedCompanies(manager);
  const items: AdminBindingInventoryItem[] = [];

  for (const company of companies) {
    const candidateRows = await loadAdminBindingCandidateRows(manager, company.id);
    const evaluation = evaluateAdminBinding({
      organizationId: company.id,
      organizationCode: company.organizationCode,
      companyStatus: company.status,
      isManagedCompany: company.isManagedCompany,
      candidates: candidateRows.map((row) => toAdminBindingCandidate(row, cipher)),
    });

    items.push({
      planId: buildAdminBindingPlanId(evaluation.status, company.id),
      organizationId: company.id,
      organizationCode: company.organizationCode,
      status: evaluation.status,
      reason: evaluation.reason,
      action: actionForStatus(evaluation.status),
      boundAccountId: evaluation.boundAccountId,
      boundLoginNameMasked: evaluation.boundLoginNameMasked,
      candidateCount: evaluation.candidateCount,
      accountDisabled: evaluation.accountDisabled,
      candidates: evaluation.candidates,
    });
  }

  return {
    version: ADMIN_BINDING_INVENTORY_VERSION,
    items,
    summary: {
      total: items.length,
      bound: items.filter((item) => item.status === 'BOUND').length,
      unconfigured: items.filter((item) => item.status === 'UNCONFIGURED').length,
      conflict: items.filter((item) => item.status === 'CONFLICT').length,
      companyDisabled: items.filter((item) => item.status === 'COMPANY_DISABLED').length,
      manual: items.filter((item) => item.action === 'MANUAL').length,
    },
  };
}

export interface ApplyAdminBindingInventoryOptions {
  readonly approvedPlanIds: ReadonlyArray<string>;
  readonly managedCompanyEntries: ReadonlyArray<AdminDefaultManagedCompanyEntry>;
  readonly cipher: FieldCipher;
}

export interface AppliedAdminBindingItem {
  readonly planId: string;
  readonly organizationCode: string;
  readonly loginName: string;
  readonly outcome: 'CREATED';
}

/**
 * 在调用方事务内受控应用审查清单。
 *
 * 前置规则（任意不满足即整批拒绝，零写入）：
 * - 批准清单非空且无重复；
 * - 每个 ID 都必须命中当前盘点中的 `UNCONFIGURED` 项；
 * - 每个待处理公司都必须有显式二级账号映射；
 * - 冲突、停用、已绑定项永远不在可应用范围。
 *
 * 逐项在锁内复核公司状态、受管标记与绑定状态；任何变化都整批回滚。
 */
export async function applyAdminBindingInventory(
  manager: EntityManager,
  options: ApplyAdminBindingInventoryOptions,
): Promise<ReadonlyArray<AppliedAdminBindingItem>> {
  if (options.approvedPlanIds.length === 0) {
    throw new Error('受控应用必须提供至少一个已审查的待处理 ID（--approve）');
  }
  const uniquePlanIds = new Set(options.approvedPlanIds);
  if (uniquePlanIds.size !== options.approvedPlanIds.length) {
    throw new Error('受控应用的待处理 ID 存在重复，拒绝执行');
  }

  const entriesByCode = new Map<string, AdminDefaultManagedCompanyEntry>();
  for (const entry of options.managedCompanyEntries) {
    entriesByCode.set(entry.organizationCode, entry);
  }

  const report = await inspectAdminBindingInventory(manager, options.cipher);
  const itemsByPlanId = new Map(report.items.map((item) => [item.planId, item]));
  const targets: Array<{
    item: AdminBindingInventoryItem;
    entry: AdminDefaultManagedCompanyEntry;
  }> = [];

  const rejected: string[] = [];
  for (const planId of options.approvedPlanIds) {
    const item = itemsByPlanId.get(planId);
    if (item === undefined) {
      rejected.push(`${planId}：当前盘点不存在该 ID`);
      continue;
    }
    if (item.status !== 'UNCONFIGURED') {
      rejected.push(`${planId}：当前状态为 ${item.status}，只允许应用缺失绑定项`);
      continue;
    }
    const entry = entriesByCode.get(item.organizationCode);
    if (entry === undefined) {
      rejected.push(`${planId}：缺少公司 ${item.organizationCode} 的二级账号映射`);
      continue;
    }
    targets.push({ item, entry });
  }

  if (rejected.length > 0) {
    throw new Error(`受控应用清单未通过预检，零写入：\n- ${rejected.join('\n- ')}`);
  }

  targets.sort((left, right) => left.item.organizationId - right.item.organizationId);

  const applied: AppliedAdminBindingItem[] = [];
  for (const target of targets) {
    const organization = await lockOrganizationByCode(manager, target.item.organizationCode);
    if (organization === null) {
      throw new Error(`锁内复核失败：公司 ${target.item.organizationCode} 已不存在，整批回滚`);
    }
    if (organization.status !== 'ACTIVE' || !organization.isManagedCompany) {
      throw new Error(
        `锁内复核失败：公司 ${target.item.organizationCode} 状态=${String(
          organization.status,
        )} is_managed_company=${String(organization.isManagedCompany)}，整批回滚`,
      );
    }

    const candidateRows = await loadAdminBindingCandidateRows(manager, organization.id, {
      forUpdate: true,
    });
    const evaluation = evaluateAdminBinding({
      organizationId: organization.id,
      organizationCode: target.item.organizationCode,
      companyStatus: organization.status,
      isManagedCompany: organization.isManagedCompany,
      candidates: candidateRows.map((row) => toAdminBindingCandidate(row, options.cipher)),
    });
    if (evaluation.status !== 'UNCONFIGURED') {
      throw new Error(
        `锁内复核失败：${target.item.planId} 当前状态已变为 ${evaluation.status}` +
          `（原因=${String(evaluation.reason)}），只允许写入缺失绑定项，整批回滚`,
      );
    }

    const existing = await loadBootstrapAccount(manager, target.entry.account.loginName);
    if (existing !== null) {
      throw new Error(
        `锁内复核失败：公司 ${target.item.organizationCode} 缺少绑定，但配置账号 ` +
          `${maskLoginName(target.entry.account.loginName)}（account_id=${String(existing.id)}）已存在；` +
          '拒绝复用、补级或改绑，整批回滚',
      );
    }

    await createAdminAccount(manager, target.entry.account, organization, options.cipher);
    applied.push({
      planId: target.item.planId,
      organizationCode: target.item.organizationCode,
      loginName: target.entry.account.loginName,
      outcome: 'CREATED',
    });
  }

  return applied;
}

export async function applyAdminBindingInventoryWithDataSource(
  dataSource: {
    transaction<T>(run: (manager: EntityManager) => Promise<T>): Promise<T>;
  },
  options: ApplyAdminBindingInventoryOptions,
): Promise<ReadonlyArray<AppliedAdminBindingItem>> {
  return dataSource.transaction((manager) => applyAdminBindingInventory(manager, options));
}
