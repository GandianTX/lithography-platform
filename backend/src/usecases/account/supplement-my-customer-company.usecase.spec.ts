// src/usecases/account/supplement-my-customer-company.usecase.spec.ts

import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import {
  ACCOUNT_ERROR,
  ADMIN_USER_ERROR,
  INPUT_NORMALIZE_ERROR,
  MY_ACCOUNT_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type {
  CustomerCompanyBindingFacts,
  MyAccountSettingsSnapshot,
} from '@src/modules/account/account.types';
import type { AccountService } from '@src/modules/account/base/services/account.service';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { OrganizationMembershipBindingFact } from '@src/modules/lithography/organization.types';
import type { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import type { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import type { OrganizationService } from '@src/modules/lithography/organization.service';
import type { PinoLogger } from 'nestjs-pino';
import {
  captureThrownError,
  createFakeTransactionHarness,
} from '../../../test/support/account/admin-user.fixture';
import { SupplementMyCustomerCompanyUsecase } from './supplement-my-customer-company.usecase';

/**
 * 任务 02.4 / D1：`SupplementMyCustomerCompanyUsecase` 的准入、二选一、事务写入与并发语义。
 *
 * 这里只覆盖用例层独有的裁决：公司归属真源、互斥输入、已归属幂等/冲突、候选资格、
 * 同名不合并、成员关系一致性与失败回滚。单字段格式收敛与 DTO 形态由适配层规格覆盖。
 */
describe('SupplementMyCustomerCompanyUsecase', () => {
  const ACCOUNT_ID = 7;
  const EXISTING_ORGANIZATION_ID = 31;
  const SELF_FILLED_ORGANIZATION_ID = 77;
  const UPDATED_AT = new Date('2026-01-01T00:00:00.000Z');

  /** 事务内下游调用顺序，用于证明「先锁、后复核、再写、最后回读」 */
  const order: string[] = [];

  /** 假资料行当前值：绑定事实、回读与写 FK 都由它派生 */
  let customerOrganizationId: number | null = null;
  let snapshotRole: IdentityTypeEnum = IdentityTypeEnum.CUSTOMER;
  let snapshotStatus: AccountStatus = AccountStatus.ACTIVE;

  const harness = createFakeTransactionHarness();

  const accountService = {
    lockCustomerCompanyBindingFacts: jest.fn(),
    bindCustomerOrganization: jest.fn(),
  } as unknown as AccountService;

  const accountQueryService = {
    findMyAccountSettingsSnapshot: jest.fn(),
    findCustomerOrganizationId: jest.fn(),
  } as unknown as AccountQueryService;

  const organizationService = {
    createSelfRegisteredCompany: jest.fn(),
  } as unknown as OrganizationService;

  const organizationQueryService = {
    findEligibleRegistrationOption: jest.fn(),
    existsEligibleRegistrationOptionByName: jest.fn(),
    findOrganizationNameById: jest.fn(),
  } as unknown as OrganizationQueryService;

  const organizationMembershipService = {
    insertMembership: jest.fn(),
  } as unknown as OrganizationMembershipService;

  const organizationMembershipQueryService = {
    listMembershipsForBinding: jest.fn(),
  } as unknown as OrganizationMembershipQueryService;

  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;

  const usecase = new SupplementMyCustomerCompanyUsecase(
    accountService,
    accountQueryService,
    organizationService,
    organizationQueryService,
    organizationMembershipService,
    organizationMembershipQueryService,
    logger,
    harness.transactionRunner,
  );

  const session = (overrides: Partial<UsecaseSession> = {}): UsecaseSession => ({
    accountId: ACCOUNT_ID,
    roles: [IdentityTypeEnum.CUSTOMER],
    activeRole: IdentityTypeEnum.CUSTOMER,
    ...overrides,
  });

  const execute = (input: {
    organizationId?: unknown;
    organizationName?: unknown;
    sessionOverrides?: Partial<UsecaseSession>;
    restriction?: SessionRestriction;
  }) =>
    usecase.execute({
      session: session(input.sessionOverrides),
      restriction: input.restriction ?? SessionRestriction.NONE,
      organizationId: input.organizationId,
      organizationName: input.organizationName,
    });

  const snapshotOf = (): MyAccountSettingsSnapshot => ({
    accountId: ACCOUNT_ID,
    loginName: 'legacy_customer',
    loginEmail: 'legacy@example.com',
    nickname: '旧客户',
    realName: null,
    companyName: null,
    phone: null,
    contactEmail: null,
    role: snapshotRole,
    status: snapshotStatus,
    adminLevel: null,
    updatedAt: UPDATED_AT,
  });

  const membershipOf = (
    organizationId: number,
    overrides: Partial<OrganizationMembershipBindingFact> = {},
  ): OrganizationMembershipBindingFact => ({
    membershipId: organizationId * 10,
    organizationId,
    memberRole: 'CUSTOMER',
    membershipStatus: 'ACTIVE',
    organizationStatus: 'ACTIVE',
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    harness.reset();
    order.length = 0;
    customerOrganizationId = null;
    snapshotRole = IdentityTypeEnum.CUSTOMER;
    snapshotStatus = AccountStatus.ACTIVE;

    (accountService.lockCustomerCompanyBindingFacts as jest.Mock)
      .mockReset()
      .mockImplementation((params: { accountId: number }) => {
        order.push('LOCK');
        return Promise.resolve({
          accountId: params.accountId,
          customerOrganizationId,
        } as CustomerCompanyBindingFacts);
      });
    (accountService.bindCustomerOrganization as jest.Mock)
      .mockReset()
      .mockImplementation((params: { organizationId: number }) => {
        order.push('WRITE_BINDING');
        customerOrganizationId = params.organizationId;
        return Promise.resolve(1);
      });
    (accountQueryService.findMyAccountSettingsSnapshot as jest.Mock)
      .mockReset()
      .mockImplementation(() => {
        order.push('READ_SNAPSHOT');
        return Promise.resolve(snapshotOf());
      });
    (accountQueryService.findCustomerOrganizationId as jest.Mock)
      .mockReset()
      .mockImplementation(() => Promise.resolve(customerOrganizationId));
    (organizationService.createSelfRegisteredCompany as jest.Mock)
      .mockReset()
      .mockImplementation(() => {
        order.push('CREATE_COMPANY');
        return Promise.resolve({ id: SELF_FILLED_ORGANIZATION_ID });
      });
    (organizationQueryService.findEligibleRegistrationOption as jest.Mock)
      .mockReset()
      .mockImplementation((params: { organizationId: number }) => {
        order.push('ELIGIBILITY');
        return Promise.resolve({ id: params.organizationId, name: '受管公司' });
      });
    (organizationQueryService.existsEligibleRegistrationOptionByName as jest.Mock)
      .mockReset()
      .mockResolvedValue(false);
    (organizationQueryService.findOrganizationNameById as jest.Mock)
      .mockReset()
      .mockResolvedValue('回读公司名');
    (organizationMembershipService.insertMembership as jest.Mock)
      .mockReset()
      .mockImplementation(() => {
        order.push('WRITE_MEMBERSHIP');
        return Promise.resolve({ membershipId: 1 });
      });
    (organizationMembershipQueryService.listMembershipsForBinding as jest.Mock)
      .mockReset()
      .mockResolvedValue([]);
  });

  describe('准入与输入二选一', () => {
    it('目标账号只来自 Session，且锁定与写入使用同一 accountId', async () => {
      await execute({
        organizationId: EXISTING_ORGANIZATION_ID,
        sessionOverrides: { accountId: 42 },
      });

      expect(accountService.lockCustomerCompanyBindingFacts).toHaveBeenCalledWith({
        accountId: 42,
        transactionContext: harness.txContext,
      });
      expect(accountService.bindCustomerOrganization).toHaveBeenCalledWith({
        accountId: 42,
        organizationId: EXISTING_ORGANIZATION_ID,
        transactionContext: harness.txContext,
      });
    });

    it('非法 Session accountId 在开启事务前失败关闭', async () => {
      const error = await captureThrownError(
        execute({ organizationId: 1, sessionOverrides: { accountId: 0 } }),
      );

      expect(error).toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });

    it.each([
      ['同时提供 ID 与名称', { organizationId: 1, organizationName: '自填公司' }],
      ['都不提供', {}],
      ['只提供纯空白名称', { organizationName: '   ' }],
      ['公司 ID 非正整数', { organizationId: 0 }],
      ['公司名称超长', { organizationName: '公'.repeat(101) }],
    ])('%s → BAD_USER_INPUT，零写入', async (_label, input) => {
      const error = await captureThrownError(execute(input));

      expect(error).toMatchObject({ code: MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_INPUT_INVALID });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
      expect(organizationService.createSelfRegisteredCompany).not.toHaveBeenCalled();
    });

    it('受限会话（强改密码）直接 FORBIDDEN，不开启事务', async () => {
      const error = await captureThrownError(
        execute({
          organizationId: EXISTING_ORGANIZATION_ID,
          restriction: SessionRestriction.MUST_CHANGE_PASSWORD,
        }),
      );

      expect(error).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });

    it('受限会话即使输入非法也优先 FORBIDDEN（授权先于输入校验）', async () => {
      const error = await captureThrownError(
        execute({
          organizationId: EXISTING_ORGANIZATION_ID,
          organizationName: '自填公司',
          restriction: SessionRestriction.ENGINEER_PENDING,
        }),
      );

      expect(error).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
      expect(organizationService.createSelfRegisteredCompany).not.toHaveBeenCalled();
    });

    it('账号行缺失按读失败关闭，不塌缩为未认证', async () => {
      (accountService.lockCustomerCompanyBindingFacts as jest.Mock).mockResolvedValue(null);

      const error = await captureThrownError(execute({ organizationId: EXISTING_ORGANIZATION_ID }));

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.READ_FAILED, details: undefined });
      expect(harness.isRolledBack()).toBe(true);
    });
  });

  describe('角色与状态复核', () => {
    it.each([
      ['工程师', IdentityTypeEnum.ENGINEER],
      ['超级管理员', IdentityTypeEnum.SUPER_ADMIN],
    ])('%s 会话 → FORBIDDEN，零写入', async (_label, role) => {
      snapshotRole = role;

      const error = await captureThrownError(execute({ organizationId: EXISTING_ORGANIZATION_ID }));

      expect(error).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
      expect(organizationService.createSelfRegisteredCompany).not.toHaveBeenCalled();
    });

    it('非 ACTIVE 账号 → FORBIDDEN，且先于任何公司创建', async () => {
      snapshotStatus = AccountStatus.INACTIVE;

      const error = await captureThrownError(execute({ organizationName: '自填公司' }));

      expect(error).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(organizationService.createSelfRegisteredCompany).not.toHaveBeenCalled();
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
    });
  });

  describe('已归属账号', () => {
    beforeEach(() => {
      customerOrganizationId = EXISTING_ORGANIZATION_ID;
    });

    it('重复提交同一候选 → 幂等 isUpdated:false，不写库、不建关系', async () => {
      const outcome = await execute({ organizationId: EXISTING_ORGANIZATION_ID });

      expect(outcome.isUpdated).toBe(false);
      expect(outcome.settings.trustedCompanyName).toBe('回读公司名');
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
      expect(organizationMembershipQueryService.listMembershipsForBinding).not.toHaveBeenCalled();
    });

    it.each([
      ['选择其它公司（换绑）', { organizationId: 999 }],
      ['手填公司名', { organizationName: '新公司' }],
    ])('%s → CONFLICT，归属与公司行均不变', async (_label, input) => {
      const error = await captureThrownError(execute(input));

      expect(error).toMatchObject({ code: MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_ALREADY_BOUND });
      expect(customerOrganizationId).toBe(EXISTING_ORGANIZATION_ID);
      expect(organizationService.createSelfRegisteredCompany).not.toHaveBeenCalled();
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
    });
  });

  describe('选择名单内受管公司', () => {
    it('资格复核通过 → 写 FK、补 CUSTOMER 关系、回读权威视图', async () => {
      const outcome = await execute({ organizationId: EXISTING_ORGANIZATION_ID });

      expect(order).toEqual([
        'LOCK',
        'READ_SNAPSHOT',
        'ELIGIBILITY',
        'WRITE_BINDING',
        'WRITE_MEMBERSHIP',
        'READ_SNAPSHOT',
      ]);
      expect(organizationQueryService.findEligibleRegistrationOption).toHaveBeenCalledWith({
        organizationId: EXISTING_ORGANIZATION_ID,
        transactionContext: harness.txContext,
      });
      expect(organizationMembershipService.insertMembership).toHaveBeenCalledWith(
        {
          organizationId: EXISTING_ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          memberRole: IdentityTypeEnum.CUSTOMER,
        },
        harness.txContext,
      );
      expect(organizationService.createSelfRegisteredCompany).not.toHaveBeenCalled();
      expect(outcome.isUpdated).toBe(true);
      expect(outcome.sameNamedCompanyName).toBeNull();
      expect(outcome.settings.trustedCompanyName).toBe('回读公司名');
      expect(outcome.settings).not.toHaveProperty('accountId');
      expect(harness.isCommitted()).toBe(true);
    });

    it('目标组织已有 ACTIVE 关系 → 跳过重复插入，仍只写一次 FK', async () => {
      (organizationMembershipQueryService.listMembershipsForBinding as jest.Mock).mockResolvedValue(
        [membershipOf(EXISTING_ORGANIZATION_ID)],
      );

      const outcome = await execute({ organizationId: EXISTING_ORGANIZATION_ID });

      expect(outcome.isUpdated).toBe(true);
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
      expect(accountService.bindCustomerOrganization).toHaveBeenCalledTimes(1);
    });

    it('停用 / 未受管 / 伪造组织 → ORGANIZATION_NOT_AVAILABLE，零写入', async () => {
      (organizationQueryService.findEligibleRegistrationOption as jest.Mock).mockResolvedValue(
        null,
      );

      const error = await captureThrownError(execute({ organizationId: EXISTING_ORGANIZATION_ID }));

      expect(error).toMatchObject({ code: ACCOUNT_ERROR.ORGANIZATION_NOT_AVAILABLE });
      expect(customerOrganizationId).toBeNull();
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
    });

    it('账号已有其它组织 ACTIVE 关系 → CONFLICT，不自动修复、零写入', async () => {
      (organizationMembershipQueryService.listMembershipsForBinding as jest.Mock).mockResolvedValue(
        [membershipOf(555)],
      );

      const error = await captureThrownError(execute({ organizationId: EXISTING_ORGANIZATION_ID }));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT,
      });
      expect(organizationQueryService.findEligibleRegistrationOption).not.toHaveBeenCalled();
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
    });

    it.each([
      ['ENGINEER', IdentityTypeEnum.ENGINEER],
      ['SUPER_ADMIN', IdentityTypeEnum.SUPER_ADMIN],
    ])('同组织已有活跃 %s 关系 → CONFLICT 角色不符，零写入', async (_label, role) => {
      (organizationMembershipQueryService.listMembershipsForBinding as jest.Mock).mockResolvedValue(
        [membershipOf(EXISTING_ORGANIZATION_ID, { memberRole: role })],
      );

      const error = await captureThrownError(execute({ organizationId: EXISTING_ORGANIZATION_ID }));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT,
      });
      // 角色不符在候选资格复核之前失败关闭，不进入任何写入
      expect(organizationQueryService.findEligibleRegistrationOption).not.toHaveBeenCalled();
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
      expect(customerOrganizationId).toBeNull();
      expect(harness.isRolledBack()).toBe(true);
    });

    it('目标组织只有历史 LEFT 关系 → CONFLICT，不重复 INSERT', async () => {
      (organizationMembershipQueryService.listMembershipsForBinding as jest.Mock).mockResolvedValue(
        [membershipOf(EXISTING_ORGANIZATION_ID, { membershipStatus: 'LEFT' })],
      );

      const error = await captureThrownError(execute({ organizationId: EXISTING_ORGANIZATION_ID }));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT,
      });
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
    });

    it('多条活跃关系歧义 → CONFLICT，零写入', async () => {
      (organizationMembershipQueryService.listMembershipsForBinding as jest.Mock).mockResolvedValue(
        [membershipOf(EXISTING_ORGANIZATION_ID), membershipOf(555)],
      );

      const error = await captureThrownError(execute({ organizationId: EXISTING_ORGANIZATION_ID }));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT,
      });
      expect(organizationQueryService.findEligibleRegistrationOption).not.toHaveBeenCalled();
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
    });

    it('停用组织上的活跃关系仍占用唯一键 → CONFLICT，不换绑', async () => {
      (organizationMembershipQueryService.listMembershipsForBinding as jest.Mock).mockResolvedValue(
        [membershipOf(555, { organizationStatus: 'DISABLED', memberRole: 'CUSTOMER' })],
      );

      const error = await captureThrownError(execute({ organizationId: EXISTING_ORGANIZATION_ID }));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT,
      });
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
    });
  });

  describe('手填公司名', () => {
    it('同名受管公司存在 → 仍新建独立公司并回带同名提示', async () => {
      (
        organizationQueryService.existsEligibleRegistrationOptionByName as jest.Mock
      ).mockResolvedValue(true);

      const outcome = await execute({ organizationName: '  示例  科技  ' });

      expect(organizationQueryService.existsEligibleRegistrationOptionByName).toHaveBeenCalledWith({
        normalizedName: '示例 科技',
      });
      // 比较名折叠连续空白，落库原值只去首尾空白
      expect(organizationService.createSelfRegisteredCompany).toHaveBeenCalledWith({
        name: '示例  科技',
        transactionContext: harness.txContext,
      });
      expect(organizationQueryService.findEligibleRegistrationOption).not.toHaveBeenCalled();
      expect(accountService.bindCustomerOrganization).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        organizationId: SELF_FILLED_ORGANIZATION_ID,
        transactionContext: harness.txContext,
      });
      expect(organizationMembershipService.insertMembership).toHaveBeenCalledTimes(1);
      expect(outcome.sameNamedCompanyName).toBe('示例  科技');
      expect(outcome.isUpdated).toBe(true);
    });

    it('无同名公司 → 建档成功且提示为 null', async () => {
      const outcome = await execute({ organizationName: '全新公司' });

      expect(outcome.sameNamedCompanyName).toBeNull();
      expect(outcome.isUpdated).toBe(true);
    });

    it('账号已有任何 ACTIVE 关系 → CONFLICT，不建档、不写 FK', async () => {
      (organizationMembershipQueryService.listMembershipsForBinding as jest.Mock).mockResolvedValue(
        [membershipOf(555)],
      );

      const error = await captureThrownError(execute({ organizationName: '新公司' }));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.CUSTOMER_COMPANY_MEMBERSHIP_INCONSISTENT,
      });
      expect(organizationService.createSelfRegisteredCompany).not.toHaveBeenCalled();
      expect(accountService.bindCustomerOrganization).not.toHaveBeenCalled();
    });

    it('仅有历史 LEFT 关系 → 允许新建未受管公司并写 CUSTOMER 关系', async () => {
      (organizationMembershipQueryService.listMembershipsForBinding as jest.Mock).mockResolvedValue(
        [membershipOf(555, { membershipStatus: 'LEFT' })],
      );

      const outcome = await execute({ organizationName: '全新公司' });

      expect(outcome.isUpdated).toBe(true);
      expect(organizationService.createSelfRegisteredCompany).toHaveBeenCalledTimes(1);
      expect(organizationMembershipService.insertMembership).toHaveBeenCalledTimes(1);
      expect(organizationMembershipService.insertMembership).toHaveBeenCalledWith(
        {
          organizationId: SELF_FILLED_ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          memberRole: IdentityTypeEnum.CUSTOMER,
        },
        harness.txContext,
      );
    });
  });

  describe('原子性与失败关闭', () => {
    it('写 FK 影响 0 行 → WRITE_FAILED，事务回滚且不建关系', async () => {
      (accountService.bindCustomerOrganization as jest.Mock).mockResolvedValue(0);

      const error = await captureThrownError(execute({ organizationName: '新公司' }));

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
    });

    it('成员关系写入失败 → 整体回滚，不留半成功归属', async () => {
      (organizationMembershipService.insertMembership as jest.Mock).mockRejectedValue(
        new Error('membership insert failed'),
      );

      const error = await captureThrownError(execute({ organizationId: EXISTING_ORGANIZATION_ID }));

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(harness.isRolledBack()).toBe(true);
    });

    it('写后回读归属不一致 → WRITE_FAILED 并回滚', async () => {
      (accountQueryService.findCustomerOrganizationId as jest.Mock).mockResolvedValue(654321);

      const error = await captureThrownError(execute({ organizationId: EXISTING_ORGANIZATION_ID }));

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
    });

    it('组织名称缺失时可信公司名为 null，不回退用户自填值', async () => {
      (organizationQueryService.findOrganizationNameById as jest.Mock).mockResolvedValue(null);

      const outcome = await execute({ organizationName: '自填公司' });

      expect(outcome.settings.trustedCompanyName).toBeNull();
      expect(outcome.settings.companyName).toBeNull();
    });
  });
});
