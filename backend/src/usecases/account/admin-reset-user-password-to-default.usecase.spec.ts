// src/usecases/account/admin-reset-user-password-to-default.usecase.spec.ts

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import {
  ACCOUNT_ERROR,
  ADMIN_USER_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { AccountService } from '@src/modules/account/base/services/account.service';
import type { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { PinoLogger } from 'nestjs-pino';
import {
  ADMIN_ACCOUNT_ID,
  TARGET_ACCOUNT_ID,
  captureThrownError,
  createActiveStatusFacts,
  createAdminOrganizationFact,
  createAdminUserView,
  createFakeTransactionHarness,
  createLevelTwoAdminSession,
  createOrganizationIsolationMocks,
  createStatusFacts,
  createSuperAdminSession,
  createSuperAdminTargetView,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { AdminResetUserPasswordToDefaultUsecase } from './admin-reset-user-password-to-default.usecase';

/**
 * 任务 08.4：`AdminResetUserPasswordToDefaultUsecase` 的默认密码来源、作用域、
 * 目标保护、状态边界与「写哈希 + 强制改密」原子性。
 *
 * 与旧「自填新密码」重置的差异是本组的核心断言：
 * 1. 密码只来自服务端配置，命令契约里没有密码字段；
 * 2. 配置缺失或不合策略都在任何数据库访问之前失败关闭（`INTERNAL_SERVER_ERROR` 大类），
 *    不回退硬编码弱口令，也不向调用方回显配置键名与策略原因；
 * 3. 写入必须同时置 `mustChangePassword = true`，且回包 / 日志 / 异常都不含默认密码。
 */
describe('AdminResetUserPasswordToDefaultUsecase', () => {
  /** 满足全仓默认密码策略的强口令；刻意不含连续/重复字符序列 */
  const DEFAULT_PASSWORD = 'Default#Reset2026';

  const harness = createFakeTransactionHarness();

  const accountService = {
    lockByIdForUpdate: jest.fn(),
    updateAccountPasswordHash: jest.fn(),
  } as unknown as AccountService;

  const adminUserQueryService = {
    findAdminUserViewById: jest.fn(),
    findAdminUserStatusFacts: jest.fn(),
    findAdminUserOwnershipFacts: jest.fn(),
  } as unknown as AdminUserQueryService;

  const passwordPolicyService = {
    validatePassword: jest.fn(),
  } as unknown as PasswordPolicyService;

  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;

  const organizationIsolation = createOrganizationIsolationMocks();

  const createUsecase = (defaultPassword?: string) =>
    new AdminResetUserPasswordToDefaultUsecase(
      accountService,
      adminUserQueryService,
      passwordPolicyService,
      organizationIsolation.organizationContextQueryService,
      organizationIsolation.organizationMembershipQueryService,
      { defaultPassword },
      logger,
      harness.transactionRunner,
    );

  let usecase = createUsecase(DEFAULT_PASSWORD);

  const givenLockedTarget = (view = createAdminUserView()): void => {
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockResolvedValue(view);
  };

  const givenStatusFacts = (facts: unknown): void => {
    (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockResolvedValue(facts);
  };

  const execute = (session = createSuperAdminSession(), accountId: unknown = TARGET_ACCOUNT_ID) =>
    usecase.execute({ session, accountId });

  const lastErrorPayload = (): Record<string, unknown> =>
    (logger.error as jest.Mock).mock.calls[
      (logger.error as jest.Mock).mock.calls.length - 1
    ][0] as Record<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    harness.reset();
    usecase = createUsecase(DEFAULT_PASSWORD);
    (accountService.lockByIdForUpdate as jest.Mock).mockReset().mockResolvedValue(undefined);
    (accountService.updateAccountPasswordHash as jest.Mock)
      .mockReset()
      .mockResolvedValue(undefined);
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockReset();
    (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockReset();
    (adminUserQueryService.findAdminUserOwnershipFacts as jest.Mock).mockReset().mockResolvedValue({
      role: IdentityTypeEnum.CUSTOMER,
      customerOrganizationId: createAdminOrganizationFact().organizationId,
    });
    (passwordPolicyService.validatePassword as jest.Mock)
      .mockReset()
      .mockReturnValue({ isValid: true, errors: [], strength: 90 });
    organizationIsolation.resolveForAccount
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact());
    organizationIsolation.findActiveMembership
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact());
    givenLockedTarget();
    givenStatusFacts(createActiveStatusFacts());
  });

  describe('作用域授权', () => {
    it.each(createUnauthorizedSessions())(
      '%s 被拒，且不读配置、不开事务、不触碰数据库',
      async (_label, session) => {
        await expect(execute(session)).rejects.toMatchObject({
          code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        });

        expect(passwordPolicyService.validatePassword).not.toHaveBeenCalled();
        expect(harness.transactionRunner.run).not.toHaveBeenCalled();
        expect(accountService.lockByIdForUpdate).not.toHaveBeenCalled();
        expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      },
    );

    it('一级管理员全范围：不解析成员公司、不校验目标归属', async () => {
      await expect(execute()).resolves.toMatchObject({ accountId: TARGET_ACCOUNT_ID });

      expect(organizationIsolation.resolveForAccount).not.toHaveBeenCalled();
      expect(organizationIsolation.findActiveMembership).not.toHaveBeenCalled();
    });

    it('二级管理员只操作可信公司：客户资料归属其它公司时收敛为 TARGET_NOT_FOUND', async () => {
      (adminUserQueryService.findAdminUserOwnershipFacts as jest.Mock).mockResolvedValue({
        role: IdentityTypeEnum.CUSTOMER,
        customerOrganizationId: createAdminOrganizationFact().organizationId + 1,
      });

      const error = await captureThrownError(execute(createLevelTwoAdminSession()));

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.TARGET_NOT_FOUND });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(adminUserQueryService.findAdminUserOwnershipFacts).toHaveBeenCalledWith({
        accountId: TARGET_ACCOUNT_ID,
        transactionContext: harness.txContext,
      });
    });

    it('二级管理员的成员角色不再是 SUPER_ADMIN 时失败关闭为 FORBIDDEN', async () => {
      organizationIsolation.resolveForAccount
        .mockReset()
        .mockResolvedValue(createAdminOrganizationFact({ memberRole: 'ENGINEER' }));

      await expect(execute(createLevelTwoAdminSession())).rejects.toMatchObject({
        code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });
  });

  describe('默认密码来源与失败关闭', () => {
    it.each([
      ['配置缺失', undefined],
      ['空字符串', ''],
      ['纯空白', '   '],
    ])('%s 时失败关闭，不开启事务', async (_label, defaultPassword) => {
      usecase = createUsecase(defaultPassword);

      const error = await captureThrownError(execute());

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.DEFAULT_PASSWORD_NOT_CONFIGURED });
      expect(passwordPolicyService.validatePassword).not.toHaveBeenCalled();
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
    });

    it('默认密码不合策略时同样失败关闭，且不回显策略原因或配置键名', async () => {
      (passwordPolicyService.validatePassword as jest.Mock).mockReturnValue({
        isValid: false,
        errors: ['密码长度至少为 8 位'],
        strength: 0,
      });

      const error = await captureThrownError(execute());

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.DEFAULT_PASSWORD_NOT_CONFIGURED });
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain('密码长度至少为 8 位');
      expect(serialized).not.toContain('ADMIN_DEFAULT_RESET_PASSWORD');
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });

    it('策略校验对象就是配置的默认密码（单一强度真源）', async () => {
      await execute();

      expect(passwordPolicyService.validatePassword).toHaveBeenCalledWith(DEFAULT_PASSWORD);
    });
  });

  describe('目标保护与状态边界', () => {
    it('SUPER_ADMIN 目标一律只读：不写哈希并回滚', async () => {
      givenLockedTarget(createSuperAdminTargetView());

      const error = await captureThrownError(execute(createSuperAdminSession(), ADMIN_ACCOUNT_ID));

      expect(error).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
    });

    it('目标账号不存在时收敛为 TARGET_NOT_FOUND，不塌缩为 UNAUTHENTICATED', async () => {
      (accountService.lockByIdForUpdate as jest.Mock).mockRejectedValue(
        new DomainError(ACCOUNT_ERROR.ACCOUNT_NOT_FOUND, '账号不存在'),
      );

      const error = await captureThrownError(execute());

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.TARGET_NOT_FOUND });
      expect(harness.isRolledBack()).toBe(true);
    });

    it.each([
      ['双字段一致 ACTIVE', AccountStatus.ACTIVE, UserState.ACTIVE],
      ['双字段一致 INACTIVE', AccountStatus.INACTIVE, UserState.INACTIVE],
    ])('%s 的目标允许重置为默认密码', async (_label, status, userState) => {
      givenStatusFacts(createStatusFacts(status, userState));

      await expect(execute()).resolves.toMatchObject({ accountId: TARGET_ACCOUNT_ID });
      expect(accountService.updateAccountPasswordHash).toHaveBeenCalledTimes(1);
      expect(harness.isCommitted()).toBe(true);
    });

    it.each([
      ['双字段不一致', AccountStatus.ACTIVE, UserState.INACTIVE],
      ['一致 SUSPENDED', AccountStatus.SUSPENDED, UserState.SUSPENDED],
      ['一致 PENDING', AccountStatus.PENDING, UserState.PENDING],
      ['BANNED', AccountStatus.BANNED, UserState.ACTIVE],
    ])('%s 的目标被拒：不写哈希并回滚', async (_label, status, userState) => {
      givenStatusFacts(createStatusFacts(status, userState));

      const error = await captureThrownError(execute());

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED,
      });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
    });

    it('状态事实读不到时按读失败关闭', async () => {
      givenStatusFacts(null);

      const error = await captureThrownError(execute());

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        cause: { diagnostic: 'PASSWORD_RESET_STATUS_FACTS_NOT_READABLE' },
      });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
    });
  });

  describe('写入口径', () => {
    it('以锁内 View 的 createdAt 为盐，并在同一 UPDATE 置 mustChangePassword', async () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      const updatedAt = new Date('2026-09-09T09:09:09.000Z');
      givenLockedTarget(createAdminUserView({ createdAt, updatedAt }));

      await execute();

      const writeArg = (accountService.updateAccountPasswordHash as jest.Mock).mock.calls[0][0] as {
        accountId: number;
        passwordHash: string;
        transactionContext: unknown;
        mustChangePassword?: boolean;
      };
      expect(writeArg.accountId).toBe(TARGET_ACCOUNT_ID);
      expect(writeArg.transactionContext).toBe(harness.txContext);
      expect(writeArg.mustChangePassword).toBe(true);
      expect(writeArg.passwordHash).toBe(
        AccountService.hashPasswordWithTimestamp(DEFAULT_PASSWORD, createdAt),
      );
      expect(
        AccountService.verifyPassword(DEFAULT_PASSWORD, writeArg.passwordHash, createdAt),
      ).toBe(true);
    });

    it('INACTIVE 目标重置后不写状态字段（无顺带启用）', async () => {
      givenStatusFacts(createStatusFacts(AccountStatus.INACTIVE, UserState.INACTIVE));

      await execute();

      const writeArg = (accountService.updateAccountPasswordHash as jest.Mock).mock
        .calls[0][0] as Record<string, unknown>;
      expect(Object.keys(writeArg).sort()).toEqual([
        'accountId',
        'mustChangePassword',
        'passwordHash',
        'transactionContext',
      ]);
    });
  });

  describe('结果与日志口径', () => {
    it('只返回 accountId / isUpdated / 固定 notice，不含默认密码', async () => {
      const result = await execute();

      expect(Object.keys(result).sort()).toEqual(['accountId', 'isUpdated', 'notice']);
      expect(result.notice).toContain('默认密码');
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(DEFAULT_PASSWORD);
      expect(serialized).not.toContain('passwordHash');
    });

    it('成功日志只含账号主键，且在事务提交之后记录', async () => {
      const order: string[] = [];
      (accountService.updateAccountPasswordHash as jest.Mock).mockImplementation(() => {
        order.push('writeHash');
        return Promise.resolve();
      });
      (logger.info as jest.Mock).mockImplementation(() => {
        order.push('successLog');
      });

      await execute();

      expect(logger.info).toHaveBeenCalledWith(
        { accountId: TARGET_ACCOUNT_ID },
        expect.any(String),
      );
      expect(order).toEqual(['writeHash', 'successLog']);
      expect(JSON.stringify((logger.info as jest.Mock).mock.calls[0][0])).not.toContain(
        DEFAULT_PASSWORD,
      );
    });

    it('写哈希失败时回滚，失败日志抑制 message（不得内嵌密码派生文本）', async () => {
      const leakedFragment = 'hash=7f3c9a1b2d4e5f60';
      (accountService.updateAccountPasswordHash as jest.Mock).mockRejectedValue(
        Object.assign(new Error(`ER_LOCK_DEADLOCK: Deadlock found; ${leakedFragment}`), {
          name: 'QueryFailedError',
          driverError: { errno: 1213, code: 'ER_LOCK_DEADLOCK' },
        }),
      );

      const error = await captureThrownError(execute());

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(harness.isRolledBack()).toBe(true);
      expect(logger.info).not.toHaveBeenCalled();
      const payload = lastErrorPayload();
      expect(payload).toMatchObject({ phase: 'WRITE_PASSWORD_HASH', driverCode: 1213 });
      expect(payload.message).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain(leakedFragment);
    });

    it('事务边界失败收敛为 WRITE_FAILED 并标记 TRANSACTION_BOUNDARY', async () => {
      harness.runMock.mockRejectedValueOnce(new Error('connection lost during COMMIT'));

      const error = await captureThrownError(execute());

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(lastErrorPayload()).toMatchObject({ phase: 'TRANSACTION_BOUNDARY' });
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe('输入白名单', () => {
    it.each([
      ['0', 0],
      ['负数', -1],
      ['小数', 1.5],
      ['字符串数字', '2'],
      ['null', null],
      ['undefined', undefined],
    ])('目标账号 ID 为 %s 时按无效值失败关闭', async (_label, accountId) => {
      // 直接透传而不经默认参数：否则 `undefined` 会被默认值静默改写成合法 ID
      await expect(
        usecase.execute({ session: createSuperAdminSession(), accountId }),
      ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });
  });
});
