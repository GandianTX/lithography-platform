// src/usecases/account/admin-create-user.usecase.spec.ts

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import {
  ADMIN_USER_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { AccountService } from '@src/modules/account/base/services/account.service';
import type { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import type { OrganizationMembershipFact } from '@src/modules/lithography/organization.types';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { PinoLogger } from 'nestjs-pino';
import {
  ADMIN_ACCOUNT_ID,
  captureThrownError,
  createAdminUserView,
  createFakeTransactionHarness,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { AdminCreateUserUsecase } from './admin-create-user.usecase';
import type { AdminCreateUserCommand } from './admin-user-management.types';

/**
 * P2-1A：`AdminCreateUserUsecase` 的授权、冲突口径、策略先行与落库契约。
 *
 * 本文件核实四件创建路径独有的事：
 * 1. **密码策略先于唯一性预检查**：顺序反了，一个连合法密码都没提交的调用者就能借
 *    `BAD_USER_INPUT` 与 `CONFLICT` 的响应差异探测登录名 / 登录邮箱是否已存在；
 * 2. 冲突有两处、文案不同——事务前预检查区分维度（只为友好提示），事务内命中唯一索引
 *    不区分维度（并发窗口内区分等于向调用方确认另一个账号的存在）；
 * 3. 落库契约：账号行以常量占位口令 + `identityHint` 落库，随后用 `insertAccount()` 返回的
 *    **数据库权威 `createdAt`** 作盐回写真实哈希，资料行 `accessGroup` / `metaDigest` 是同一个
 *    单元素数组、`status` 与 `userState` 同为 `ACTIVE`——新建账号必然能通过
 *    `convergeAccountRole()`，不会立刻成为让管理员列表整次失败关闭的异常行；
 * 4. 三处写入任一失败即整体回滚，不会留下「可用占位口令登录」或「无资料行」的半成品账号。
 *
 * `AdminUserView` 不含密码派生物，因此「新密码可登录」的真实落库由 E2E 直连核验。
 */
describe('AdminCreateUserUsecase', () => {
  /** 满足全仓默认密码策略的强口令；刻意不含连续/重复字符序列 */
  const VALID_PASSWORD = 'Str0ng#Pass2026';

  /** 新建账号的主键与数据库权威创建时间（`insertAccount()` 返回的事实） */
  const NEW_ACCOUNT_ID = 42;
  const DB_CREATED_AT = new Date('2026-03-15T08:30:00.000Z');

  /** 管理员当前有效组织（可信解析事实）与新工程师成员关系主键（A-PR0 §4.3 绑定断言用） */
  const ADMIN_MEMBERSHIP_ID = 915_001;
  const ADMIN_ORGANIZATION_ID = 910_001;
  const NEW_ENGINEER_MEMBERSHIP_ID = 915_101;

  const harness = createFakeTransactionHarness();

  const accountService = {
    insertAccount: jest.fn(),
    updateAccountPasswordHash: jest.fn(),
    insertUserInfo: jest.fn(),
  } as unknown as AccountService;

  const adminUserQueryService = {
    findAdminUserViewById: jest.fn(),
    findAdminUserCredentialConflict: jest.fn(),
  } as unknown as AdminUserQueryService;

  const passwordPolicyService = {
    validatePassword: jest.fn(),
  } as unknown as PasswordPolicyService;

  const organizationContextQueryService = {
    resolveForAccount: jest.fn(),
  } as unknown as TrustedOrganizationContextQueryService;

  const organizationMembershipService = {
    insertMembership: jest.fn(),
  } as unknown as OrganizationMembershipService;

  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;

  const usecase = new AdminCreateUserUsecase(
    accountService,
    adminUserQueryService,
    passwordPolicyService,
    organizationContextQueryService,
    organizationMembershipService,
    logger,
    harness.transactionRunner,
  );

  /** 一份各字段都合法的创建入参（刻意带上待收敛的空白与大小写） */
  const validCommand = (
    overrides: Partial<AdminCreateUserCommand> = {},
  ): AdminCreateUserCommand => ({
    session: createSuperAdminSession(),
    loginName: 'new_engineer',
    loginEmail: '  New.Engineer@Example.com ',
    loginPassword: VALID_PASSWORD,
    role: IdentityTypeEnum.ENGINEER,
    nickname: '  新工程师  ',
    companyName: '  示例公司  ',
    phone: ' 13800000000 ',
    contactEmail: ' Contact@Example.com ',
    ...overrides,
  });

  /** 创建成功后的稳定 View（`id` 与角色取自落库事实） */
  const createdView = (role: IdentityTypeEnum = IdentityTypeEnum.ENGINEER) =>
    createAdminUserView({
      id: NEW_ACCOUNT_ID,
      loginName: 'new_engineer',
      loginEmail: 'new.engineer@example.com',
      nickname: '新工程师',
      role,
    });

  const givenCreatedView = (view = createdView()): void => {
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockResolvedValue(view);
  };

  /** 管理员当前有效组织的可信解析事实（绑定断言必须与本值逐字一致） */
  const adminOrganizationFact = (): OrganizationMembershipFact => ({
    membershipId: ADMIN_MEMBERSHIP_ID,
    organizationId: ADMIN_ORGANIZATION_ID,
    organizationCode: 'CLIENT_DEFAULT',
    organizationName: '甲方默认组织',
    organizationKind: 'CLIENT',
    memberRole: 'SUPER_ADMIN',
  });

  /** 取本次传给某个 mock 的第一个实参 */
  const firstArgOf = (fn: jest.Mock): Record<string, unknown> =>
    fn.mock.calls[0][0] as Record<string, unknown>;

  /** 取最近一次 `logger.error` 的结构化负载 */
  const lastErrorPayload = (): Record<string, unknown> => {
    const calls = (logger.error as jest.Mock).mock.calls;
    return calls[calls.length - 1][0] as Record<string, unknown>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    harness.reset();
    (accountService.insertAccount as jest.Mock)
      .mockReset()
      .mockResolvedValue({ kind: 'CREATED', accountId: NEW_ACCOUNT_ID, createdAt: DB_CREATED_AT });
    (accountService.updateAccountPasswordHash as jest.Mock)
      .mockReset()
      .mockResolvedValue(undefined);
    (accountService.insertUserInfo as jest.Mock).mockReset().mockResolvedValue(undefined);
    (adminUserQueryService.findAdminUserCredentialConflict as jest.Mock)
      .mockReset()
      .mockResolvedValue(null);
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockReset();
    (passwordPolicyService.validatePassword as jest.Mock)
      .mockReset()
      .mockReturnValue({ isValid: true, errors: [], strength: 90 });
    (organizationContextQueryService.resolveForAccount as jest.Mock)
      .mockReset()
      .mockResolvedValue(adminOrganizationFact());
    (organizationMembershipService.insertMembership as jest.Mock)
      .mockReset()
      .mockResolvedValue({ membershipId: NEW_ENGINEER_MEMBERSHIP_ID });
    givenCreatedView();
  });

  describe('精确 SUPER_ADMIN 授权', () => {
    it.each(createUnauthorizedSessions())(
      '%s 被拒，且不开启事务、不预检查冲突、不触碰数据库',
      async (_label, session) => {
        await expect(usecase.execute({ ...validCommand(), session })).rejects.toMatchObject({
          code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        });

        // 授权是第一步：策略校验、冲突预检查、组织解析与全部写入都不得被触达
        expect(passwordPolicyService.validatePassword).not.toHaveBeenCalled();
        expect(adminUserQueryService.findAdminUserCredentialConflict).not.toHaveBeenCalled();
        expect(harness.transactionRunner.run).not.toHaveBeenCalled();
        expect(accountService.insertAccount).not.toHaveBeenCalled();
        expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
        expect(accountService.insertUserInfo).not.toHaveBeenCalled();
        expect(organizationContextQueryService.resolveForAccount).not.toHaveBeenCalled();
        expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
        expect(harness.isCommitted()).toBe(false);
        expect(harness.isRolledBack()).toBe(false);
      },
    );
  });

  describe('密码策略先于冲突预检查', () => {
    it('弱密码被拒时不查询凭据占用情况（防止借响应差异探测账号是否存在）', async () => {
      (passwordPolicyService.validatePassword as jest.Mock).mockReturnValue({
        isValid: false,
        errors: ['密码长度至少为 8 位'],
        strength: 0,
      });

      const error = await captureThrownError(
        usecase.execute(validCommand({ loginPassword: 'abc' })),
      );

      expect(error).toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });
      expect((error as DomainError).message).toContain('初始密码不符合安全要求');
      expect(adminUserQueryService.findAdminUserCredentialConflict).not.toHaveBeenCalled();
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.insertAccount).not.toHaveBeenCalled();
    });

    it('策略失败刻意不用 AUTH_ERROR.INVALID_PASSWORD（会被映射为 UNAUTHENTICATED）', async () => {
      (passwordPolicyService.validatePassword as jest.Mock).mockReturnValue({
        isValid: false,
        errors: ['密码过于常见，请使用更复杂的密码'],
        strength: 30,
      });

      const error = await captureThrownError(
        usecase.execute(validCommand({ loginPassword: 'password123' })),
      );

      expect((error as DomainError).code).toBe(INPUT_NORMALIZE_ERROR.INVALID_TEXT);
      expect((error as DomainError).code).not.toBe('INVALID_PASSWORD');
    });

    it('策略层收到原值：normalize 不 trim 初始密码（trim 会静默改写秘密）', async () => {
      const rawWithTrailingSpace = `${VALID_PASSWORD} `;
      (passwordPolicyService.validatePassword as jest.Mock).mockReturnValue({
        isValid: false,
        errors: ['密码首尾不能包含空格'],
        strength: 0,
      });

      await expect(
        usecase.execute(validCommand({ loginPassword: rawWithTrailingSpace })),
      ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });

      expect(passwordPolicyService.validatePassword).toHaveBeenCalledWith(rawWithTrailingSpace);
    });

    it.each([
      ['空字符串', ''],
      ['null', null],
      ['undefined', undefined],
      ['数字', 12345678],
      ['对象', { password: VALID_PASSWORD }],
    ])('初始密码为 %s 时按必填缺失失败关闭，绝不产出可登录账号', async (_label, loginPassword) => {
      await expect(usecase.execute(validCommand({ loginPassword }))).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
      });

      // 这是安全前置条件：跳过它就会走到 hashPasswordWithTimestamp(String(undefined))
      expect(passwordPolicyService.validatePassword).not.toHaveBeenCalled();
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.insertAccount).not.toHaveBeenCalled();
    });
  });

  describe('登录凭据唯一性预检查', () => {
    it('预检查收到收敛后的凭据（登录邮箱已 trim + 小写）', async () => {
      await usecase.execute(validCommand());

      expect(adminUserQueryService.findAdminUserCredentialConflict).toHaveBeenCalledWith({
        loginName: 'new_engineer',
        loginEmail: 'new.engineer@example.com',
      });
    });

    it.each([
      ['loginName', '该登录名已被占用，请更换后重试'],
      ['loginEmail', '该登录邮箱已被占用，请更换后重试'],
    ])('%s 已被占用时返回既有冲突错误，且不开启事务', async (conflictField, message) => {
      (adminUserQueryService.findAdminUserCredentialConflict as jest.Mock).mockResolvedValue(
        conflictField,
      );

      const error = await captureThrownError(usecase.execute(validCommand()));

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.CREDENTIAL_CONFLICT, message });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.insertAccount).not.toHaveBeenCalled();
      // 预检查在事务之外，失败不是「事务回滚」
      expect(harness.isRolledBack()).toBe(false);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('只填登录名（登录邮箱为 null）时也能创建，预检查同样只带已填维度', async () => {
      await expect(usecase.execute(validCommand({ loginEmail: null }))).resolves.toMatchObject({
        id: NEW_ACCOUNT_ID,
      });

      expect(adminUserQueryService.findAdminUserCredentialConflict).toHaveBeenCalledWith({
        loginName: 'new_engineer',
        loginEmail: null,
      });
      expect(firstArgOf(accountService.insertAccount as jest.Mock).accountData).toMatchObject({
        loginEmail: null,
      });
    });

    it.each([
      ['两个都未提供', { loginName: null, loginEmail: null }],
      ['两个都是空白字符串', { loginName: '   ', loginEmail: '  ' }],
    ])('%s 时按凭据必填失败关闭', async (_label, credential) => {
      await expect(usecase.execute(validCommand(credential))).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
      });
      expect(adminUserQueryService.findAdminUserCredentialConflict).not.toHaveBeenCalled();
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });

    it.each([
      ['短于 4 个字符', { loginName: 'abc' }],
      ['长于 30 个字符', { loginName: 'a'.repeat(31) }],
      ['含非法字符', { loginName: 'new engineer!' }],
      ['含中文', { loginName: '新工程师' }],
    ])('登录名 %s 被拒且不开启事务', async (_label, credential) => {
      await expect(usecase.execute(validCommand(credential))).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });

    it('登录名不做大小写改写（uk_login_name 建在 _ci 列上，改写属静默改写凭据形态）', async () => {
      await usecase.execute(validCommand({ loginName: 'New_Engineer' }));

      expect(adminUserQueryService.findAdminUserCredentialConflict).toHaveBeenCalledWith(
        expect.objectContaining({ loginName: 'New_Engineer' }),
      );
      expect(firstArgOf(accountService.insertAccount as jest.Mock).accountData).toMatchObject({
        loginName: 'New_Engineer',
      });
    });
  });

  describe('事务内命中唯一索引（并发竞争）', () => {
    it('收敛为 CREDENTIAL_CONFLICT，文案不区分维度，且后续写入全部不执行', async () => {
      (accountService.insertAccount as jest.Mock).mockResolvedValue({
        kind: 'CREDENTIAL_CONFLICT',
      });

      const error = await captureThrownError(usecase.execute(validCommand()));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.CREDENTIAL_CONFLICT,
        message: '该登录名或登录邮箱已被占用，请更换后重试',
      });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(accountService.insertUserInfo).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      // 唯一索引冲突属预期业务结果：记 warn 而非 error
      expect(logger.warn).toHaveBeenCalledWith(
        { phase: 'INSERT_ACCOUNT' },
        expect.stringContaining('登录凭据已被占用'),
      );
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe('落库契约', () => {
    it('账号行以常量占位口令落库，不把初始密码明文写进 accountData.loginPassword', async () => {
      await usecase.execute(validCommand());

      expect(accountService.insertAccount).toHaveBeenCalledTimes(1);
      const arg = firstArgOf(accountService.insertAccount as jest.Mock);
      expect(arg.transactionContext).toBe(harness.txContext);
      expect(arg.accountData).toEqual({
        loginName: 'new_engineer',
        loginEmail: 'new.engineer@example.com',
        // 占位值只在同一事务内存在，事务提交前必被真实哈希覆盖
        loginPassword: 'temp',
        status: AccountStatus.ACTIVE,
        identityHint: IdentityTypeEnum.ENGINEER,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
      expect(JSON.stringify(arg.accountData)).not.toContain(VALID_PASSWORD);
    });

    it('密码哈希以 insertAccount 返回的数据库权威 createdAt 为盐，不在用例侧另取时钟', async () => {
      await usecase.execute(validCommand());

      const writeArg = firstArgOf(accountService.updateAccountPasswordHash as jest.Mock) as {
        accountId: number;
        passwordHash: string;
        transactionContext: unknown;
      };
      expect(writeArg.accountId).toBe(NEW_ACCOUNT_ID);
      expect(writeArg.transactionContext).toBe(harness.txContext);
      expect(writeArg.passwordHash).toBe(
        AccountService.hashPasswordWithTimestamp(VALID_PASSWORD, DB_CREATED_AT),
      );
      // 真正的兜底不变式：写入的哈希能被登录验证侧以同一盐验通
      expect(
        AccountService.verifyPassword(VALID_PASSWORD, writeArg.passwordHash, DB_CREATED_AT),
      ).toBe(true);
      expect(
        AccountService.verifyPassword('Wrong#Pass2026', writeArg.passwordHash, DB_CREATED_AT),
      ).toBe(false);
    });

    it('资料行三源同时可收敛：identityHint / accessGroup / metaDigest 表达同一个单值角色', async () => {
      await usecase.execute(validCommand({ role: IdentityTypeEnum.CUSTOMER }));

      const accountData = firstArgOf(accountService.insertAccount as jest.Mock).accountData as {
        identityHint: string;
      };
      const userInfoData = firstArgOf(accountService.insertUserInfo as jest.Mock)
        .userInfoData as Record<string, unknown>;

      expect(accountData.identityHint).toBe(IdentityTypeEnum.CUSTOMER);
      expect(userInfoData.accessGroup).toEqual([IdentityTypeEnum.CUSTOMER]);
      expect(userInfoData.metaDigest).toEqual([IdentityTypeEnum.CUSTOMER]);
      // 多元素数组会让该行成为令管理员列表整次失败关闭的异常行
      expect(userInfoData.accessGroup).toHaveLength(1);
      expect(userInfoData.metaDigest).toHaveLength(1);
    });

    it('资料行收敛后的字段落库，且 status 与 userState 同为 ACTIVE', async () => {
      await usecase.execute(validCommand());

      const arg = firstArgOf(accountService.insertUserInfo as jest.Mock);
      expect(arg.transactionContext).toBe(harness.txContext);
      expect(arg.userInfoData).toMatchObject({
        accountId: NEW_ACCOUNT_ID,
        // 昵称 trim + NFKC
        nickname: '新工程师',
        companyName: '示例公司',
        // 电话只 trim，刻意不剥离 + / - / 空格
        phone: '13800000000',
        // 联系邮箱写入 base_user_info.email，不得写进 base_user_account.login_email
        email: 'contact@example.com',
        userState: UserState.ACTIVE,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
      const userInfoData = arg.userInfoData as Record<string, unknown>;
      expect(userInfoData).not.toHaveProperty('contactEmail');
      expect(userInfoData).not.toHaveProperty('loginEmail');
      expect(userInfoData).not.toHaveProperty('loginPassword');
      expect(firstArgOf(accountService.insertAccount as jest.Mock).accountData).toMatchObject({
        status: AccountStatus.ACTIVE,
      });
    });

    it('未提供的可空资料字段落为 null，与目标列 nullable 的数据库事实一致', async () => {
      await usecase.execute(
        validCommand({ companyName: undefined, phone: undefined, contactEmail: undefined }),
      );

      expect(firstArgOf(accountService.insertUserInfo as jest.Mock).userInfoData).toMatchObject({
        companyName: null,
        phone: null,
        email: null,
      });
    });

    it('六处调用同事务且顺序固定：解析组织 → 插入账号 → 回写哈希 → 插入资料 → 绑定组织 → 回读 View', async () => {
      await usecase.execute(validCommand());

      const orders = [
        (organizationContextQueryService.resolveForAccount as jest.Mock).mock
          .invocationCallOrder[0],
        (accountService.insertAccount as jest.Mock).mock.invocationCallOrder[0],
        (accountService.updateAccountPasswordHash as jest.Mock).mock.invocationCallOrder[0],
        (accountService.insertUserInfo as jest.Mock).mock.invocationCallOrder[0],
        (organizationMembershipService.insertMembership as jest.Mock).mock.invocationCallOrder[0],
        (adminUserQueryService.findAdminUserViewById as jest.Mock).mock.invocationCallOrder[0],
      ];
      expect(orders).toEqual([...orders].sort((a, b) => a - b));

      // 组织解析与绑定写入都收到同一事务上下文：绑定读的是尚未提交的本次事实
      expect(organizationContextQueryService.resolveForAccount).toHaveBeenCalledWith({
        accountId: ADMIN_ACCOUNT_ID,
        transactionContext: harness.txContext,
      });
      expect(organizationMembershipService.insertMembership).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: NEW_ACCOUNT_ID }),
        harness.txContext,
      );

      // 回读使用同一个 transactionContext，读到的是尚未提交的本次写入
      expect(adminUserQueryService.findAdminUserViewById).toHaveBeenCalledWith({
        accountId: NEW_ACCOUNT_ID,
        transactionContext: harness.txContext,
      });
      expect(harness.isCommitted()).toBe(true);
      expect(harness.isRolledBack()).toBe(false);
    });

    it('返回事务内回读的稳定 View', async () => {
      await expect(usecase.execute(validCommand())).resolves.toEqual(createdView());
    });
  });

  describe('组织绑定（A-PR0 §4.3）', () => {
    it('创建 ENGINEER：在同一事务内绑定管理员当前有效组织', async () => {
      await usecase.execute(validCommand());

      expect(organizationContextQueryService.resolveForAccount).toHaveBeenCalledWith({
        accountId: ADMIN_ACCOUNT_ID,
        transactionContext: harness.txContext,
      });
      expect(organizationMembershipService.insertMembership).toHaveBeenCalledTimes(1);
      expect(organizationMembershipService.insertMembership).toHaveBeenCalledWith(
        {
          organizationId: ADMIN_ORGANIZATION_ID,
          accountId: NEW_ACCOUNT_ID,
          memberRole: IdentityTypeEnum.ENGINEER,
        },
        harness.txContext,
      );
      expect(harness.isCommitted()).toBe(true);
      expect(harness.isRolledBack()).toBe(false);
    });

    it('创建 CUSTOMER：不解析组织、不写成员关系（客户不自动加入）', async () => {
      await expect(
        usecase.execute(validCommand({ role: IdentityTypeEnum.CUSTOMER })),
      ).resolves.toBeDefined();

      expect(organizationContextQueryService.resolveForAccount).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
      expect(harness.isCommitted()).toBe(true);
      expect(logger.info).toHaveBeenCalledTimes(1);
    });

    it('管理员无有效组织时失败关闭：解析先于任何写入，账号零落库且无半成品', async () => {
      (organizationContextQueryService.resolveForAccount as jest.Mock).mockRejectedValue(
        new DomainError(
          ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
          '当前账号没有有效组织成员关系，无法执行组织范围操作',
        ),
      );

      const error = await captureThrownError(usecase.execute(validCommand()));

      expect(error).toMatchObject({ code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP });
      expect(accountService.insertAccount).not.toHaveBeenCalled();
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(accountService.insertUserInfo).not.toHaveBeenCalled();
      expect(organizationMembershipService.insertMembership).not.toHaveBeenCalled();
      expect(adminUserQueryService.findAdminUserViewById).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.info).not.toHaveBeenCalled();
      // 领域异常以错误码记录，阶段定位到组织解析
      expect(lastErrorPayload()).toMatchObject({
        errorCode: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
        phase: 'RESOLVE_ORGANIZATION',
      });
    });

    it('绑定写入失败：整体回滚收敛为 WRITE_FAILED，回读不执行', async () => {
      (organizationMembershipService.insertMembership as jest.Mock).mockRejectedValue(
        Object.assign(new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded'), {
          name: 'QueryFailedError',
          driverError: { errno: 1205 },
        }),
      );

      await expect(usecase.execute(validCommand())).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
      });

      expect(accountService.insertUserInfo).toHaveBeenCalledTimes(1);
      expect(adminUserQueryService.findAdminUserViewById).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.info).not.toHaveBeenCalled();
      expect(lastErrorPayload()).toMatchObject({
        reason: 'UNEXPECTED',
        phase: 'BIND_ORGANIZATION',
        errorName: 'QueryFailedError',
        driverCode: 1205,
      });
    });
  });

  describe('角色写入白名单', () => {
    const illegalRoles: ReadonlyArray<unknown> = [
      // 管理员不得创建 SUPER_ADMIN：目标保护与写入白名单是两道独立裁决
      IdentityTypeEnum.SUPER_ADMIN,
      'admin',
      '',
      '   ',
      null,
      undefined,
      1,
      [IdentityTypeEnum.ENGINEER],
      [IdentityTypeEnum.ENGINEER, IdentityTypeEnum.CUSTOMER],
    ];

    it.each(illegalRoles)('非法角色 %p 被拒，且不预检查冲突、不开启事务', async (role) => {
      await expect(usecase.execute(validCommand({ role }))).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE,
      });
      expect(adminUserQueryService.findAdminUserCredentialConflict).not.toHaveBeenCalled();
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.insertAccount).not.toHaveBeenCalled();
    });
  });

  describe('资料输入白名单', () => {
    const illegalNicknames: ReadonlyArray<unknown> = [
      '',
      '   ',
      null,
      undefined,
      1,
      [],
      'a'.repeat(51),
    ];

    it.each(illegalNicknames)('非法昵称 %p 被拒且不开启事务', async (nickname) => {
      await expect(usecase.execute(validCommand({ nickname }))).rejects.toMatchObject({
        // 空/纯空白/null 是 REQUIRED_TEXT_EMPTY，超长是 INVALID_TEXT，同属 BAD_USER_INPUT 大类
        code: expect.stringMatching(/INVALID_TEXT|REQUIRED_TEXT_EMPTY/),
      });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.insertAccount).not.toHaveBeenCalled();
    });

    it.each([
      ['companyName', { companyName: 'a'.repeat(101) }],
      ['phone', { phone: 'a'.repeat(21) }],
      ['contactEmail', { contactEmail: 'a'.repeat(51) }],
      ['loginEmail', { loginEmail: 'a'.repeat(101) }],
    ])('超长 %s 被拒且不开启事务', async (_field, input) => {
      await expect(usecase.execute(validCommand(input))).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });

    it('昵称允许重复：管理员路径不引入任何昵称查重', async () => {
      await expect(usecase.execute(validCommand())).resolves.toMatchObject({ id: NEW_ACCOUNT_ID });

      const conflictArg = firstArgOf(
        adminUserQueryService.findAdminUserCredentialConflict as jest.Mock,
      );
      expect(conflictArg).not.toHaveProperty('nickname');
      // 唯一一次预检查只覆盖登录凭据两维
      expect(adminUserQueryService.findAdminUserCredentialConflict).toHaveBeenCalledTimes(1);
    });
  });

  describe('回读与原子性', () => {
    it('创建后回读不到账号时按读失败关闭并回滚', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock).mockResolvedValue(null);

      const error = await captureThrownError(usecase.execute(validCommand()));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        cause: { diagnostic: 'CREATED_ACCOUNT_NOT_READABLE', accountId: NEW_ACCOUNT_ID },
      });
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.info).not.toHaveBeenCalled();
      expect(lastErrorPayload()).toMatchObject({
        errorCode: ADMIN_USER_ERROR.READ_FAILED,
        phase: 'READ_BACK_VIEW',
        diagnostic: { diagnostic: 'CREATED_ACCOUNT_NOT_READABLE', accountId: NEW_ACCOUNT_ID },
      });
    });

    it('资料行写入失败时事务回滚，账号行与哈希一并撤销', async () => {
      (accountService.insertUserInfo as jest.Mock).mockRejectedValue(
        Object.assign(new Error('ER_LOCK_DEADLOCK: Deadlock found when trying to get lock'), {
          name: 'QueryFailedError',
          driverError: { errno: 1213, code: 'ER_LOCK_DEADLOCK' },
        }),
      );

      await expect(usecase.execute(validCommand())).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
      });

      expect(accountService.insertAccount).toHaveBeenCalledTimes(1);
      expect(accountService.updateAccountPasswordHash).toHaveBeenCalledTimes(1);
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.info).not.toHaveBeenCalled();
      expect(lastErrorPayload()).toMatchObject({
        reason: 'UNEXPECTED',
        phase: 'SAVE_USER_INFO',
        errorName: 'QueryFailedError',
        driverCode: 1213,
      });
    });

    it('回写哈希失败时不写资料行，且失败日志抑制 message（不得内嵌密码派生文本）', async () => {
      const leakedFragment = 'hash=7f3c9a1b2d4e5f60';
      (accountService.updateAccountPasswordHash as jest.Mock).mockRejectedValue(
        Object.assign(
          new Error(`ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded; ${leakedFragment}`),
          { name: 'QueryFailedError', driverError: { errno: 1205 } },
        ),
      );

      await expect(usecase.execute(validCommand())).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
      });

      expect(accountService.insertUserInfo).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      const payload = lastErrorPayload();
      expect(payload).toMatchObject({
        reason: 'UNEXPECTED',
        phase: 'UPDATE_PASSWORD_HASH',
        errorName: 'QueryFailedError',
        driverCode: 1205,
      });
      expect(payload.message).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain(leakedFragment);
    });

    it('message 抑制只作用于回写哈希阶段：资料阶段的非领域异常仍保留 message', async () => {
      (accountService.insertUserInfo as jest.Mock).mockRejectedValue(
        Object.assign(new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded'), {
          name: 'QueryFailedError',
          driverError: { errno: 1205 },
        }),
      );

      await expect(usecase.execute(validCommand())).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
      });

      expect(lastErrorPayload()).toMatchObject({
        phase: 'SAVE_USER_INFO',
        message: 'ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded',
      });
    });

    it('下游已收敛的领域异常原样冒泡，不被再次包装', async () => {
      const writeFailed = new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '用户账号创建失败，请稍后重试',
        undefined,
        new Error('ER_DUP_ENTRY: Duplicate entry'),
      );
      (accountService.insertAccount as jest.Mock).mockRejectedValue(writeFailed);

      await expect(usecase.execute(validCommand())).rejects.toBe(writeFailed);

      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(accountService.insertUserInfo).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(lastErrorPayload()).toMatchObject({
        errorCode: ADMIN_USER_ERROR.WRITE_FAILED,
        phase: 'INSERT_ACCOUNT',
        causeErrorName: 'Error',
      });
    });

    it('BEGIN / COMMIT 失败收敛为 WRITE_FAILED 并标记 TRANSACTION_BOUNDARY', async () => {
      harness.runMock.mockRejectedValueOnce(new Error('connection pool exhausted'));

      await expect(usecase.execute(validCommand())).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
      });

      expect(harness.isCommitted()).toBe(false);
      expect(logger.info).not.toHaveBeenCalled();
      expect(lastErrorPayload()).toMatchObject({
        reason: 'UNEXPECTED',
        phase: 'TRANSACTION_BOUNDARY',
        message: 'connection pool exhausted',
      });
    });
  });

  describe('成功日志口径', () => {
    it('只含账号主键与角色，且在事务提交之后记录', async () => {
      const order: Array<string> = [];
      (accountService.insertUserInfo as jest.Mock).mockImplementation(() => {
        order.push('saveUserInfo');
        return Promise.resolve();
      });
      (logger.info as jest.Mock).mockImplementation(() => {
        order.push('successLog');
      });

      await usecase.execute(validCommand());

      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        { accountId: NEW_ACCOUNT_ID, role: IdentityTypeEnum.ENGINEER },
        expect.any(String),
      );
      // 事务内记录会产生「日志已成功、调用方收到异常」的假成功
      expect(order).toEqual(['saveUserInfo', 'successLog']);
      const payload = JSON.stringify((logger.info as jest.Mock).mock.calls[0][0]);
      expect(payload).not.toContain(VALID_PASSWORD);
      expect(payload).not.toContain('new_engineer');
      expect(payload).not.toContain('new.engineer@example.com');
    });

    it('返回的稳定 View 不含任何密码派生物', async () => {
      const view = await usecase.execute(validCommand());

      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain(VALID_PASSWORD);
      expect(serialized).not.toContain('loginPassword');
      expect(serialized).not.toContain('passwordHash');
      expect(view).not.toHaveProperty('metaDigest');
      expect(view).not.toHaveProperty('userState');
    });
  });
});
