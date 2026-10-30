// src/usecases/account/admin-reset-user-password.usecase.spec.ts

import { AccountStatus } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import {
  ACCOUNT_ERROR,
  ADMIN_USER_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  ORGANIZATION_ERROR,
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
  createOrganizationIsolationMocks,
  createStatusFacts,
  createSuperAdminSession,
  createSuperAdminTargetView,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { AdminResetUserPasswordUsecase } from './admin-reset-user-password.usecase';

/**
 * P2-1A：`AdminResetUserPasswordUsecase` 的授权、目标保护、状态矩阵、策略先行与哈希盐口径。
 *
 * 密码链路在本仓是**单一路径**（非空断言 → 策略校验 → `hashPasswordWithTimestamp()` →
 * `updateAccountPasswordHash()`），因此本文件不重测策略强度本身（`PasswordPolicyService`
 * 另有定向单测），只核实四件用例层独有的事：
 * 1. 授权与密码策略都**先于任何数据库访问**——输入错误不该在占用行锁之后才暴露；
 * 2. 只有「双字段一致且处于 ACTIVE / INACTIVE 两态」的目标可以覆盖登录凭据；
 * 3. 哈希的时间盐取**锁内 View 的 `createdAt`**（与登录验证侧同一列），不是 `updatedAt`
 *    也不是应用时钟；这一点一旦漂移，该账号新旧密码都将无法登录且全程静默；
 * 4. 结果、成功日志与失败日志都不含密码派生物；写哈希阶段的非领域异常 `message` 被抑制。
 */
describe('AdminResetUserPasswordUsecase', () => {
  /** 满足全仓默认密码策略的强口令；刻意不含连续/重复字符序列 */
  const VALID_PASSWORD = 'Str0ng#Pass2026';

  const harness = createFakeTransactionHarness();

  const accountService = {
    lockByIdForUpdate: jest.fn(),
    updateAccountPasswordHash: jest.fn(),
  } as unknown as AccountService;

  const adminUserQueryService = {
    findAdminUserViewById: jest.fn(),
    findAdminUserStatusFacts: jest.fn(),
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

  /** 组织隔离替身回到「成功」缺省：管理员有单一可信组织、目标同组织有效成员 */
  const givenOrganizationIsolation = (): void => {
    organizationIsolation.resolveForAccount
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact());
    organizationIsolation.findActiveMembership
      .mockReset()
      .mockResolvedValue(createAdminOrganizationFact());
  };

  const usecase = new AdminResetUserPasswordUsecase(
    accountService,
    adminUserQueryService,
    passwordPolicyService,
    organizationIsolation.organizationContextQueryService,
    organizationIsolation.organizationMembershipQueryService,
    logger,
    harness.transactionRunner,
  );

  /** 锁内目标加载结果（缺省是可写的 CUSTOMER 目标，createdAt 与 updatedAt 刻意不同值） */
  const givenLockedTarget = (view = createAdminUserView()): void => {
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockResolvedValue(view);
  };

  const givenStatusFacts = (facts: unknown): void => {
    (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockResolvedValue(facts);
  };

  const executeAsSuperAdmin = (
    newPassword: unknown = VALID_PASSWORD,
    accountId: unknown = TARGET_ACCOUNT_ID,
  ) => usecase.execute({ session: createSuperAdminSession(), accountId, newPassword });

  /**
   * 原样透传入参的执行入口：不给任何参数设默认值。
   * JS 默认参数只在实参为 `undefined` 时生效，用它会静默把「未传 accountId / newPassword」
   * 改写成合法值，使白名单用例测不到真实的 normalize 分支。
   */
  const executeWithRawInput = (accountId: unknown, newPassword: unknown) =>
    usecase.execute({ session: createSuperAdminSession(), accountId, newPassword });

  /** 取最近一次 `logger.error` 的结构化负载 */
  const lastErrorPayload = (): Record<string, unknown> =>
    (logger.error as jest.Mock).mock.calls[
      (logger.error as jest.Mock).mock.calls.length - 1
    ][0] as Record<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    harness.reset();
    (accountService.lockByIdForUpdate as jest.Mock).mockReset().mockResolvedValue(undefined);
    (accountService.updateAccountPasswordHash as jest.Mock)
      .mockReset()
      .mockResolvedValue(undefined);
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockReset();
    (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockReset();
    (passwordPolicyService.validatePassword as jest.Mock)
      .mockReset()
      .mockReturnValue({ isValid: true, errors: [], strength: 90 });
    givenLockedTarget();
    givenStatusFacts(createActiveStatusFacts());
    givenOrganizationIsolation();
  });

  describe('精确 SUPER_ADMIN 授权', () => {
    it.each(createUnauthorizedSessions())(
      '%s 被拒，且不开启事务、不校验密码策略、不触碰数据库',
      async (_label, session) => {
        await expect(
          usecase.execute({
            session,
            accountId: TARGET_ACCOUNT_ID,
            newPassword: VALID_PASSWORD,
          }),
        ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

        // 授权是第一步：策略校验、行锁与写哈希都不得被触达
        expect(passwordPolicyService.validatePassword).not.toHaveBeenCalled();
        expect(harness.transactionRunner.run).not.toHaveBeenCalled();
        expect(accountService.lockByIdForUpdate).not.toHaveBeenCalled();
        expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
        expect(harness.isCommitted()).toBe(false);
        expect(harness.isRolledBack()).toBe(false);
      },
    );
  });

  describe('密码策略先行', () => {
    it('弱密码在任何数据库访问之前被拒，不占用行锁', async () => {
      (passwordPolicyService.validatePassword as jest.Mock).mockReturnValue({
        isValid: false,
        errors: ['密码长度至少为 8 位'],
        strength: 0,
      });

      const error = await captureThrownError(executeAsSuperAdmin('abc'));

      expect(error).toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });
      // 文案必须告知该改什么；错误来自策略层的 errors，不含密码原文
      expect((error as DomainError).message).toContain('新密码不符合安全要求');
      expect((error as DomainError).message).toContain('密码长度至少为 8 位');
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.lockByIdForUpdate).not.toHaveBeenCalled();
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
    });

    it('策略失败刻意不用 AUTH_ERROR.INVALID_PASSWORD（会被映射为 UNAUTHENTICATED）', async () => {
      (passwordPolicyService.validatePassword as jest.Mock).mockReturnValue({
        isValid: false,
        errors: ['密码过于常见，请使用更复杂的密码'],
        strength: 30,
      });

      const error = await captureThrownError(executeAsSuperAdmin('password123'));

      expect((error as DomainError).code).toBe(INPUT_NORMALIZE_ERROR.INVALID_TEXT);
      expect((error as DomainError).code).not.toBe('INVALID_PASSWORD');
    });

    it('策略层收到原值：normalize 不 trim 密码（trim 会静默改写秘密）', async () => {
      const rawWithTrailingSpace = `${VALID_PASSWORD} `;
      (passwordPolicyService.validatePassword as jest.Mock).mockReturnValue({
        isValid: false,
        errors: ['密码首尾不能包含空格'],
        strength: 0,
      });

      await expect(executeAsSuperAdmin(rawWithTrailingSpace)).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      });

      // 若上游做过 trim，策略层就永远给不出「首尾不能包含空格」这一拒绝理由
      expect(passwordPolicyService.validatePassword).toHaveBeenCalledWith(rawWithTrailingSpace);
    });

    it.each([
      ['空字符串', ''],
      ['null', null],
      ['undefined', undefined],
      ['数字', 12345678],
      ['对象', { password: VALID_PASSWORD }],
      ['数组', [VALID_PASSWORD]],
    ])('新密码为 %s 时按必填缺失失败关闭', async (_label, newPassword) => {
      await expect(executeWithRawInput(TARGET_ACCOUNT_ID, newPassword)).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
      });

      expect(passwordPolicyService.validatePassword).not.toHaveBeenCalled();
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });

    it.each([
      ['0', 0],
      ['负数', -1],
      ['小数', 1.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['字符串数字', '2'],
      ['空字符串', ''],
      ['null', null],
      ['undefined', undefined],
      ['对象', {}],
      ['数组', [TARGET_ACCOUNT_ID]],
      ['布尔值', true],
    ])('目标账号 ID 为 %s 时按无效值失败关闭', async (_label, accountId) => {
      await expect(executeWithRawInput(accountId, VALID_PASSWORD)).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE,
      });

      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.lockByIdForUpdate).not.toHaveBeenCalled();
    });
  });

  describe('SUPER_ADMIN 目标只读保护', () => {
    it('重置管理员密码被拒、事务回滚且零写入（含管理员重置自己）', async () => {
      givenLockedTarget(createSuperAdminTargetView());

      const error = await captureThrownError(
        usecase.execute({
          session: createSuperAdminSession(),
          accountId: ADMIN_ACCOUNT_ID,
          newPassword: VALID_PASSWORD,
        }),
      );

      expect(error).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(accountService.lockByIdForUpdate).toHaveBeenCalledWith(
        ADMIN_ACCOUNT_ID,
        harness.txContext,
      );
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      // 预期业务结果记 warn，不记 error：目标保护不是系统故障
      expect(logger.warn).toHaveBeenCalledWith(
        { errorCode: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, phase: 'LOCK_TARGET' },
        expect.any(String),
      );
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('目标账号不存在时收敛为 TARGET_NOT_FOUND，不塌缩为 UNAUTHENTICATED', async () => {
      (accountService.lockByIdForUpdate as jest.Mock).mockRejectedValue(
        new DomainError(ACCOUNT_ERROR.ACCOUNT_NOT_FOUND, '账号不存在'),
      );

      const error = await captureThrownError(executeAsSuperAdmin());

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.TARGET_NOT_FOUND });
      expect((error as DomainError).code).not.toBe(ACCOUNT_ERROR.ACCOUNT_NOT_FOUND);
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
    });
  });

  describe('组织隔离（管理员只能管理本组织）', () => {
    it('目标不在管理员可信组织内时收敛为 TARGET_NOT_FOUND，零写入并回滚', async () => {
      organizationIsolation.findActiveMembership.mockReset().mockResolvedValue(null);

      const error = await captureThrownError(executeAsSuperAdmin());

      // 跨组织目标统一按不存在处理：不区分「不存在」与「属于别的组织」，不泄露存在性
      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.TARGET_NOT_FOUND });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      // 组织归属校验使用管理员可信组织 + 目标账号，并在同一事务上下文内
      expect(organizationIsolation.findActiveMembership).toHaveBeenCalledWith({
        accountId: TARGET_ACCOUNT_ID,
        organizationId: createAdminOrganizationFact().organizationId,
        transactionContext: harness.txContext,
      });
    });

    it('管理员自身没有有效组织时失败关闭为 FORBIDDEN，且零写入', async () => {
      organizationIsolation.resolveForAccount
        .mockReset()
        .mockRejectedValue(
          new DomainError(
            ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
            '当前账号没有有效组织成员关系，无法执行组织范围操作',
          ),
        );

      const error = await captureThrownError(executeAsSuperAdmin());

      expect(error).toMatchObject({ code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP });
      // 组织解析已后移到行锁之后：先锁定目标，组织裁决失败后不再读取目标资料与写入
      expect(accountService.lockByIdForUpdate).toHaveBeenCalledWith(
        TARGET_ACCOUNT_ID,
        harness.txContext,
      );
      expect(organizationIsolation.findActiveMembership).not.toHaveBeenCalled();
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      // 组织解析在事务回调内失败：事务已开启并回滚
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
    });
  });

  describe('目标状态矩阵', () => {
    const allowedStatusFacts: Array<[string, AccountStatus, UserState]> = [
      ['双字段一致 ACTIVE', AccountStatus.ACTIVE, UserState.ACTIVE],
      ['双字段一致 INACTIVE', AccountStatus.INACTIVE, UserState.INACTIVE],
    ];

    it.each(allowedStatusFacts)('%s 的目标允许重置密码', async (_label, status, userState) => {
      givenStatusFacts(createStatusFacts(status, userState));

      await expect(executeAsSuperAdmin()).resolves.toMatchObject({
        accountId: TARGET_ACCOUNT_ID,
        isUpdated: true,
      });

      expect(accountService.updateAccountPasswordHash).toHaveBeenCalledTimes(1);
      expect(harness.isCommitted()).toBe(true);
      expect(harness.isRolledBack()).toBe(false);
    });

    it('INACTIVE 目标重置后仍是 INACTIVE：本用例不写任何状态字段', async () => {
      givenStatusFacts(createStatusFacts(AccountStatus.INACTIVE, UserState.INACTIVE));

      await executeAsSuperAdmin();

      const writeArg = (accountService.updateAccountPasswordHash as jest.Mock).mock
        .calls[0][0] as Record<string, unknown>;
      // 只更新密码列：不存在「重置密码顺带启用账号」的隐藏副作用
      expect(Object.keys(writeArg).sort()).toEqual([
        'accountId',
        'passwordHash',
        'transactionContext',
      ]);
      expect(adminUserQueryService.findAdminUserStatusFacts).toHaveBeenCalledWith({
        accountId: TARGET_ACCOUNT_ID,
        transactionContext: harness.txContext,
      });
    });

    const rejectedStatusFacts: Array<[string, AccountStatus, UserState]> = [
      [
        '双字段不一致：status=ACTIVE 而 userState=INACTIVE',
        AccountStatus.ACTIVE,
        UserState.INACTIVE,
      ],
      [
        '双字段不一致：status=INACTIVE 而 userState=ACTIVE',
        AccountStatus.INACTIVE,
        UserState.ACTIVE,
      ],
      ['一致 SUSPENDED', AccountStatus.SUSPENDED, UserState.SUSPENDED],
      ['一致 PENDING', AccountStatus.PENDING, UserState.PENDING],
      ['BANNED（userState 停留在 ACTIVE）', AccountStatus.BANNED, UserState.ACTIVE],
      ['DELETED（userState 停留在 ACTIVE）', AccountStatus.DELETED, UserState.ACTIVE],
    ];

    it.each(rejectedStatusFacts)(
      '%s 的目标被拒：不生成哈希、不写库、事务回滚',
      async (_label, status, userState) => {
        givenStatusFacts(createStatusFacts(status, userState));

        const error = await captureThrownError(executeAsSuperAdmin());

        expect(error).toMatchObject({
          code: ADMIN_USER_ERROR.PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED,
          // details 刻意留空：当前状态事实只进服务端诊断，不进对外响应
          details: undefined,
          cause: {
            diagnostic: 'PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED',
            accountId: TARGET_ACCOUNT_ID,
            currentStatus: status,
            currentUserState: userState,
          },
        });
        // 不复用启停转换码：该码专指状态转换，不是密码重置
        expect((error as DomainError).code).not.toBe(
          ADMIN_USER_ERROR.STATUS_TRANSITION_NOT_ALLOWED,
        );
        expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
        expect(harness.isRolledBack()).toBe(true);
        expect(harness.isCommitted()).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(
          {
            errorCode: ADMIN_USER_ERROR.PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED,
            phase: 'CHECK_TARGET_STATUS',
          },
          expect.any(String),
        );
      },
    );

    it('状态事实读取失败（null）按读失败关闭，不按「允许」放行', async () => {
      givenStatusFacts(null);

      const error = await captureThrownError(executeAsSuperAdmin());

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        cause: {
          diagnostic: 'PASSWORD_RESET_STATUS_FACTS_NOT_READABLE',
          accountId: TARGET_ACCOUNT_ID,
        },
      });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ADMIN_USER_ERROR.READ_FAILED,
          phase: 'CHECK_TARGET_STATUS',
        }),
        expect.any(String),
      );
    });

    it('状态裁决发生在写哈希之前：先锁目标、再读事实、最后才写', async () => {
      const order: Array<string> = [];
      (accountService.lockByIdForUpdate as jest.Mock).mockImplementation(() => {
        order.push('lock');
        return Promise.resolve();
      });
      (adminUserQueryService.findAdminUserStatusFacts as jest.Mock).mockImplementation(() => {
        order.push('readFacts');
        return Promise.resolve(createActiveStatusFacts());
      });
      (accountService.updateAccountPasswordHash as jest.Mock).mockImplementation(() => {
        order.push('writeHash');
        return Promise.resolve();
      });

      await executeAsSuperAdmin();

      expect(order).toEqual(['lock', 'readFacts', 'writeHash']);
    });
  });

  describe('哈希盐口径', () => {
    it('以锁内 View 的 createdAt 为盐，不用 updatedAt、不用应用时钟', async () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      const updatedAt = new Date('2026-09-09T09:09:09.000Z');
      givenLockedTarget(createAdminUserView({ createdAt, updatedAt }));

      await executeAsSuperAdmin();

      const writeArg = (accountService.updateAccountPasswordHash as jest.Mock).mock.calls[0][0] as {
        passwordHash: string;
      };
      expect(writeArg.passwordHash).toBe(
        AccountService.hashPasswordWithTimestamp(VALID_PASSWORD, createdAt),
      );
      // 若误用 updatedAt，登录验证侧（以库中 created_at 为盐）将永远不匹配
      expect(writeArg.passwordHash).not.toBe(
        AccountService.hashPasswordWithTimestamp(VALID_PASSWORD, updatedAt),
      );
      // 真正的兜底不变式：写入的哈希能被登录验证侧以同一盐验通
      expect(AccountService.verifyPassword(VALID_PASSWORD, writeArg.passwordHash, createdAt)).toBe(
        true,
      );
      expect(
        AccountService.verifyPassword('Wrong#Pass2026', writeArg.passwordHash, createdAt),
      ).toBe(false);
    });
  });

  describe('结果与日志口径', () => {
    it('只返回 accountId / isUpdated / 固定 notice，不含任何密码派生物', async () => {
      const result = await executeAsSuperAdmin();

      expect(Object.keys(result).sort()).toEqual(['accountId', 'isUpdated', 'notice']);
      expect(result.accountId).toBe(TARGET_ACCOUNT_ID);
      expect(result.isUpdated).toBe(true);
      expect(result.notice).toContain('密码已重置');
      expect(result.notice).toContain('Access Token');
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(VALID_PASSWORD);
      expect(serialized).not.toContain('passwordHash');
    });

    it('成功日志只含账号主键，且在事务提交之后记录', async () => {
      const order: Array<string> = [];
      (accountService.updateAccountPasswordHash as jest.Mock).mockImplementation(() => {
        order.push('writeHash');
        return Promise.resolve();
      });
      (logger.info as jest.Mock).mockImplementation(() => {
        order.push('successLog');
      });

      await executeAsSuperAdmin();

      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        { accountId: TARGET_ACCOUNT_ID },
        expect.any(String),
      );
      // 提交前记日志会造成「日志已成功、调用方收到异常」的假成功
      expect(order).toEqual(['writeHash', 'successLog']);
      expect(harness.isCommitted()).toBe(true);
      const serialized = JSON.stringify((logger.info as jest.Mock).mock.calls[0][0]);
      expect(serialized).not.toContain(VALID_PASSWORD);
    });

    it('写哈希失败时事务回滚，失败日志抑制 message（不得内嵌密码派生文本）', async () => {
      const leakedFragment = 'hash=7f3c9a1b2d4e5f60';
      (accountService.updateAccountPasswordHash as jest.Mock).mockRejectedValue(
        Object.assign(
          new Error(`ER_LOCK_DEADLOCK: Deadlock found when trying to get lock; ${leakedFragment}`),
          {
            name: 'QueryFailedError',
            driverError: { errno: 1213, code: 'ER_LOCK_DEADLOCK' },
          },
        ),
      );

      const error = await captureThrownError(executeAsSuperAdmin());

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.info).not.toHaveBeenCalled();

      const payload = lastErrorPayload();
      expect(payload).toMatchObject({
        reason: 'UNEXPECTED',
        phase: 'WRITE_PASSWORD_HASH',
        errorName: 'QueryFailedError',
        driverCode: 1213,
      });
      // 抑制清单命中写哈希阶段：驱动文本可能内嵌绑定参数派生物，message 不入日志
      expect(payload.message).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain(leakedFragment);
    });

    it('message 抑制只作用于写哈希阶段：锁阶段的非领域异常仍保留 message', async () => {
      (accountService.lockByIdForUpdate as jest.Mock).mockRejectedValue(
        Object.assign(new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded'), {
          name: 'QueryFailedError',
          driverError: { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' },
        }),
      );

      await expect(executeAsSuperAdmin()).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
      });

      expect(lastErrorPayload()).toMatchObject({
        reason: 'UNEXPECTED',
        phase: 'LOCK_TARGET',
        driverCode: 1205,
        message: 'ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded',
      });
    });
  });

  describe('事务边界失败', () => {
    it('BEGIN / COMMIT 失败收敛为 WRITE_FAILED 并标记 TRANSACTION_BOUNDARY', async () => {
      harness.runMock.mockRejectedValueOnce(new Error('connection lost during COMMIT'));

      const error = await captureThrownError(executeAsSuperAdmin());

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(harness.isCommitted()).toBe(false);
      expect(logger.info).not.toHaveBeenCalled();
      expect(lastErrorPayload()).toMatchObject({
        reason: 'UNEXPECTED',
        phase: 'TRANSACTION_BOUNDARY',
      });
    });

    it('事务内领域异常原样冒泡，不被收敛为 WRITE_FAILED', async () => {
      const inconsistency = new DomainError(
        ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT,
        '用户账号数据异常，暂时无法加载用户信息',
      );
      (adminUserQueryService.findAdminUserViewById as jest.Mock).mockRejectedValue(inconsistency);

      // 三源收敛不出单一角色就无法确认目标不是 SUPER_ADMIN，必须拒绝而不是放行
      await expect(executeAsSuperAdmin()).rejects.toBe(inconsistency);

      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
    });
  });
});
