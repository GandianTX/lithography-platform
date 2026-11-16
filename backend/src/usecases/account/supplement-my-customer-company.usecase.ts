// src/usecases/account/supplement-my-customer-company.usecase.ts

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  ACCOUNT_ERROR,
  ADMIN_USER_ERROR,
  DomainError,
  isDomainError,
  MY_ACCOUNT_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import type { MyAccountSettingsSnapshot } from '@src/modules/account/account.types';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import { OrganizationService } from '@src/modules/lithography/organization.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import { normalizeMyAccountSettingsAccountId } from './my-account-settings.input.normalize';
import {
  resolveTrustedOrganizationId,
  toMyAccountSettingsView,
} from './my-account-settings.support';
import type {
  CustomerCompanySupplementChoice,
  SupplementMyCustomerCompanyCommand,
  SupplementMyCustomerCompanyOutcome,
} from './supplement-my-customer-company.types';

/** 公司名称长度上限（与 `organization.name` / `base_user_info.company_name` 列长一致） */
const COMPANY_NAME_MAX_LENGTH = 100;

/** 事务内的写入阶段标记，只用于服务端日志定位，不出现在任何对外响应中 */
type SupplementPhase =
  | 'LOCK'
  | 'CHECK_ACCOUNT'
  | 'CHECK_BINDING'
  | 'RESOLVE_ORGANIZATION'
  | 'WRITE_BINDING'
  | 'WRITE_MEMBERSHIP'
  | 'READ_BACK_VIEW';

/**
 * 缺归属旧客户补录（任务 02.4 / 验收 D1）。
 *
 * 业务边界：
 * - 仅可信 CUSTOMER 会话、且锁内复核仍缺本人公司时允许；已归属客户**不能换绑**；
 * - 选择受管候选与手填公司名严格互斥，互斥在 DTO、本用例与 UI 三层各自成立；
 * - 选择式复用注册候选资格（`ACTIVE + is_managed_company`）并在写事务内复核；
 * - 手填式明确创建「启用、未受管、非维修服务商」的公司档，同名不合并，只回带提示；
 * - 组织创建、客户 FK 与 CUSTOMER 成员关系在同一事务内一致，不建立工程师关系；
 * - 成员复用仅限「目标组织 + 活跃 + CUSTOMER」；错角色、外组织、历史 LEFT 行均失败关闭。
 *
 * 并发与原子性（写顺序即锁顺序）：
 * 1. `base_user_account` 行锁 → `base_user_info` 行锁（`lockCustomerCompanyBindingFacts`）；
 * 2. 锁内复核归属为空，否则幂等返回或 CONFLICT —— 并发两个候选时后到者在锁内看到已写入
 *    的 FK，因此只有一次落库；
 * 3. 组织解析在归属复核之后，失败整体回滚，不留下孤立公司；
 * 4. FK 与成员关系同事务写入，0 行更新即失败关闭。
 *
 * 字段边界：只写 `customer_organization_id` 与 CUSTOMER 成员关系，不写旧展示字段
 * `company_name`，不触碰角色、状态、凭据与工程师关系。
 */
@Injectable()
export class SupplementMyCustomerCompanyUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationService: OrganizationService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly organizationMembershipService: OrganizationMembershipService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(SupplementMyCustomerCompanyUsecase.name);
  }

  async execute(
    command: SupplementMyCustomerCompanyCommand,
  ): Promise<SupplementMyCustomerCompanyOutcome> {
    const accountId = normalizeMyAccountSettingsAccountId(command.session);
    // 受限会话（待审 / 拒绝 / 资格未生效 / 强改）不得补录：公司归属由注册审核链路决定。
    // 授权判定先于输入校验，受限会话即使提交非法输入也只返回 FORBIDDEN。
    if (command.restriction !== SessionRestriction.NONE) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        '当前账号状态不允许补录公司信息',
        undefined,
        { diagnostic: 'RESTRICTED_SESSION_SUPPLEMENT_REJECTED', restriction: command.restriction },
      );
    }
    const choice = resolveCompanyChoice({
      organizationId: command.organizationId,
      organizationName: command.organizationName,
    });

    let outcome: SupplementMyCustomerCompanyOutcome;
    try {
      outcome = await this.transactionRunner.run((transactionContext) =>
        this.supplementInTransaction({ transactionContext, accountId, choice }),
      );
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      this.logger.error({ accountId, error }, '客户公司补录事务失败');
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '公司信息补录失败，请稍后重试',
        undefined,
        error,
      );
    }

    this.logger.info({ accountId, isUpdated: outcome.isUpdated }, '客户公司补录成功');
    return outcome;
  }

  private async supplementInTransaction(params: {
    transactionContext: PersistenceTransactionContext;
    accountId: number;
    choice: CustomerCompanySupplementChoice;
  }): Promise<SupplementMyCustomerCompanyOutcome> {
    const { transactionContext, accountId, choice } = params;
    let phase: SupplementPhase = 'LOCK';

    try {
      // 1. 锁：account 行优先、资料行随后，锁定后复核「仍缺公司」
      const facts = await this.accountService.lockCustomerCompanyBindingFacts({
        accountId,
        transactionContext,
      });
      if (!facts) {
        throw new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '账号信息读取失败，请稍后重试',
          undefined,
          { diagnostic: 'ACCOUNT_ROW_MISSING', accountId },
        );
      }

      phase = 'CHECK_ACCOUNT';
      const snapshot = await this.accountQueryService.findMyAccountSettingsSnapshot({
        accountId,
        transactionContext,
      });
      if (!snapshot) {
        throw new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '账号信息读取失败，请稍后重试',
          undefined,
          { diagnostic: 'ACCOUNT_ROW_MISSING', accountId },
        );
      }
      if (snapshot.role !== IdentityTypeEnum.CUSTOMER) {
        throw new DomainError(
          PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
          '仅客户账号可以补录公司信息',
          undefined,
          { diagnostic: 'ROLE_NOT_CUSTOMER', accountId, role: snapshot.role },
        );
      }
      if (snapshot.status !== AccountStatus.ACTIVE) {
        throw new DomainError(
          PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
          '当前账号状态不可用，无法补录公司信息',
          undefined,
          { diagnostic: 'ACCOUNT_NOT_ACTIVE', accountId, status: snapshot.status },
        );
      }

      phase = 'CHECK_BINDING';
      const currentOrganizationId = facts.customerOrganizationId;
      if (currentOrganizationId !== null) {
        // 已归属：同一候选幂等返回（不写库），其余一律视为换绑冲突
        if (choice.kind === 'EXISTING' && choice.organizationId === currentOrganizationId) {
          return await this.buildOutcome({
            snapshot,
            organizationId: currentOrganizationId,
            isUpdated: false,
            sameNamedCompanyName: null,
            transactionContext,
          });
        }
        throw new DomainError(
          MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_ALREADY_BOUND,
          '当前账号已有公司归属，不能重复补录或更换',
          undefined,
          { diagnostic: 'CUSTOMER_COMPANY_ALREADY_BOUND', accountId, currentOrganizationId },
        );
      }

      phase = 'RESOLVE_ORGANIZATION';
      const resolved = await this.resolveOrganization({
        choice,
        accountId,
        transactionContext,
      });

      phase = 'WRITE_BINDING';
      const affected = await this.accountService.bindCustomerOrganization({
        accountId,
        organizationId: resolved.organizationId,
        transactionContext,
      });
      if (affected !== 1) {
        throw new DomainError(
          ADMIN_USER_ERROR.WRITE_FAILED,
          '公司信息补录失败，请稍后重试',
          undefined,
          { diagnostic: 'CUSTOMER_COMPANY_BINDING_NOT_WRITTEN', accountId },
        );
      }

      phase = 'WRITE_MEMBERSHIP';
      if (resolved.needsMembership) {
        await this.organizationMembershipService.insertMembership(
          {
            organizationId: resolved.organizationId,
            accountId,
            memberRole: IdentityTypeEnum.CUSTOMER,
          },
          transactionContext,
        );
      }

      phase = 'READ_BACK_VIEW';
      const readBack = await this.accountQueryService.findMyAccountSettingsSnapshot({
        accountId,
        transactionContext,
      });
      const readBackOrganizationId = await this.accountQueryService.findCustomerOrganizationId({
        accountId,
        transactionContext,
      });
      if (!readBack || readBackOrganizationId !== resolved.organizationId) {
        throw new DomainError(
          ADMIN_USER_ERROR.WRITE_FAILED,
          '公司信息补录失败，请稍后重试',
          undefined,
          { diagnostic: 'CUSTOMER_COMPANY_NOT_REFLECTED_AFTER_WRITE', accountId },
        );
      }

      return await this.buildOutcome({
        snapshot: readBack,
        organizationId: resolved.organizationId,
        isUpdated: true,
        sameNamedCompanyName: resolved.sameNamedCompanyName,
        transactionContext,
      });
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      this.logger.error({ accountId, phase, error }, '客户公司补录写入失败');
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '公司信息补录失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 组织解析：选择式在事务内复核受管资格；手填式先判同名（只作提示），再新建未受管公司。
   *
   * 成员关系在此步裁决，且使用**未按有效口径过滤**的全集（含停用组织上的 ACTIVE 关系与
   * `LEFT` 历史关系），因为两个唯一键都可能让后续写入失败：
   * - `uk_organization_membership_active_account`：一个账号只能有一条 ACTIVE 关系；
   * - `uk_organization_membership_org_account`：`(organization_id, account_id)` 不能重复，
   *   历史 `LEFT` 行会阻止对同一公司的再次 INSERT。
   *
   * 只有「目标组织上的活跃 CUSTOMER 行」允许复用；同组织 ENGINEER / SUPER_ADMIN、
   * 其它组织的活跃关系、多条活跃关系歧义、目标公司的历史 LEFT 关系，一律在
   * `bindCustomerOrganization` 之前以 `CONFLICT` 失败关闭，不自动改角色、不恢复历史关系、
   * 也不重试 INSERT。
   */
  private async resolveOrganization(params: {
    choice: CustomerCompanySupplementChoice;
    accountId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<{
    organizationId: number;
    needsMembership: boolean;
    sameNamedCompanyName: string | null;
  }> {
    const { choice, accountId, transactionContext } = params;
    const memberships = await this.organizationMembershipQueryService.listMembershipsForBinding({
      accountId,
      transactionContext,
    });
    const activeMemberships = memberships.filter(
      (membership) => membership.membershipStatus === 'ACTIVE',
    );

    if (choice.kind === 'EXISTING') {
      if (activeMemberships.length > 1) {
        throw new DomainError(
          MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT,
          '账号存在多条有效成员关系，请联系管理员核实后再补录',
          undefined,
          {
            diagnostic: 'CUSTOMER_MEMBERSHIP_AMBIGUOUS',
            accountId,
            membershipIds: activeMemberships.map((membership) => membership.membershipId),
          },
        );
      }

      const activeMembership = activeMemberships[0] ?? null;
      if (activeMembership && activeMembership.organizationId !== choice.organizationId) {
        throw new DomainError(
          MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT,
          '账号已有其它公司的有效成员关系，请联系管理员处理',
          undefined,
          { diagnostic: 'CUSTOMER_MEMBERSHIP_ON_OTHER_ORGANIZATION', accountId },
        );
      }
      if (activeMembership && activeMembership.memberRole !== String(IdentityTypeEnum.CUSTOMER)) {
        throw new DomainError(
          MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT,
          '账号在该公司内的成员角色不是客户，请联系管理员调整后再补录',
          undefined,
          {
            diagnostic: 'CUSTOMER_MEMBERSHIP_ROLE_MISMATCH',
            accountId,
            memberRole: activeMembership.memberRole,
          },
        );
      }
      if (
        !activeMembership &&
        memberships.some((membership) => membership.organizationId === choice.organizationId)
      ) {
        // 只有历史 LEFT 行：唯一键不允许重复 INSERT，恢复关系需要 owner 明确允许，故失败关闭
        throw new DomainError(
          MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT,
          '账号在该公司存在已退出的历史成员关系，请联系管理员恢复后再补录',
          undefined,
          { diagnostic: 'CUSTOMER_MEMBERSHIP_HISTORICAL_INACTIVE', accountId },
        );
      }

      const organization = await this.organizationQueryService.findEligibleRegistrationOption({
        organizationId: choice.organizationId,
        transactionContext,
      });
      if (!organization) {
        throw new DomainError(
          ACCOUNT_ERROR.ORGANIZATION_NOT_AVAILABLE,
          '所选公司不存在、已停用或不具备选择资格',
        );
      }
      return {
        organizationId: organization.id,
        needsMembership: activeMembership === null,
        sameNamedCompanyName: null,
      };
    }

    if (activeMemberships.length > 0) {
      throw new DomainError(
        MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT,
        '账号已有有效成员关系，请联系管理员处理后再补录',
        undefined,
        {
          diagnostic: 'CUSTOMER_MEMBERSHIP_EXISTS_FOR_SELF_FILLED',
          accountId,
          membershipIds: activeMemberships.map((membership) => membership.membershipId),
        },
      );
    }

    // 同名只作提示：与既有受管公司同名时不自动合并，仍按新公司独立建档
    const comparisonName = normalizeCompanyNameForComparison(choice.organizationName);
    const hasSameNamedCompany =
      await this.organizationQueryService.existsEligibleRegistrationOptionByName({
        normalizedName: comparisonName,
      });
    const created = await this.organizationService.createSelfRegisteredCompany({
      name: choice.organizationName,
      transactionContext,
    });
    return {
      organizationId: created.id,
      needsMembership: true,
      sameNamedCompanyName: hasSameNamedCompany ? choice.organizationName : null,
    };
  }

  /**
   * 读回权威视图：复用账号设置 View 的单一映射实现，可信公司名按客户角色解析。
   * 名称读取为空（组织行缺失）时按 `null` 返回，不回退用户自填公司名。
   */
  private async buildOutcome(params: {
    snapshot: MyAccountSettingsSnapshot;
    organizationId: number;
    isUpdated: boolean;
    sameNamedCompanyName: string | null;
    transactionContext: PersistenceTransactionContext;
  }): Promise<SupplementMyCustomerCompanyOutcome> {
    const trustedCompanyName = await this.organizationQueryService.findOrganizationNameById({
      organizationId: params.organizationId,
      transactionContext: params.transactionContext,
    });
    const trustedOrganizationId = resolveTrustedOrganizationId(params.snapshot.role, {
      customerOrganizationId: params.organizationId,
      engineerOrganizationId: null,
      adminOrganizationId: null,
    });
    return {
      isUpdated: params.isUpdated,
      settings: toMyAccountSettingsView(
        params.snapshot,
        trustedOrganizationId === null ? null : trustedCompanyName,
      ),
      sameNamedCompanyName: params.sameNamedCompanyName,
    };
  }
}

/**
 * 二选一输入收敛：`organizationId` 与 `organizationName` 必须恰好提供一个。
 *
 * 显式 `null` 与缺省都表示未提供；同时提供（含手填纯空白后再提供 ID）与都不提供
 * 一律 `BAD_USER_INPUT`，不猜测用户意图。
 */
function resolveCompanyChoice(input: {
  organizationId: unknown;
  organizationName: unknown;
}): CustomerCompanySupplementChoice {
  const hasOrganizationId = input.organizationId !== undefined && input.organizationId !== null;
  const hasOrganizationName =
    input.organizationName !== undefined &&
    input.organizationName !== null &&
    !(typeof input.organizationName === 'string' && input.organizationName.trim().length === 0);

  if (hasOrganizationId && hasOrganizationName) {
    throw new DomainError(
      MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID,
      '只能选择名单内公司或手填公司名称，二者不能同时提交',
    );
  }
  if (hasOrganizationId) {
    if (
      typeof input.organizationId !== 'number' ||
      !Number.isInteger(input.organizationId) ||
      input.organizationId <= 0
    ) {
      throw new DomainError(MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID, '公司 ID 无效');
    }
    return { kind: 'EXISTING', organizationId: input.organizationId };
  }
  if (hasOrganizationName) {
    if (typeof input.organizationName !== 'string') {
      throw new DomainError(
        MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID,
        '公司名称必须是字符串',
      );
    }
    const normalized = input.organizationName.trim();
    if (normalized.length === 0) {
      throw new DomainError(MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID, '请输入公司名称');
    }
    if (normalized.length > COMPANY_NAME_MAX_LENGTH) {
      throw new DomainError(
        MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID,
        `公司名称不能超过 ${COMPANY_NAME_MAX_LENGTH} 个字符`,
      );
    }
    return { kind: 'SELF_FILLED', organizationName: normalized };
  }
  throw new DomainError(
    MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID,
    '请选择名单内公司或填写公司名称',
  );
}

/** 同名比较归一化：去首尾空白、连续空白合并、统一小写；不改变落库原值 */
function normalizeCompanyNameForComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
