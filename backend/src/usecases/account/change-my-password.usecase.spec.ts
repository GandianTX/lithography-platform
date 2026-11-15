// src/usecases/account/change-my-password.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import {
  ADMIN_USER_ERROR,
  AUTH_ERROR,
  INPUT_NORMALIZE_ERROR,
  MY_ACCOUNT_ERROR,
} from '@core/common/errors/domain-error';
import type { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { AccountService } from '@src/modules/account/base/services/account.service';
import type { PinoLogger } from 'nestjs-pino';
import {
  captureThrownError,
  createFakeTransactionHarness,
} from '../../../test/support/account/admin-user.fixture';
import { ChangeMyPasswordUsecase } from './change-my-password.usecase';

/**
 * P3：`ChangeMyPasswordUsecase` 的目标来源、当前密码验证边界、时间盐口径与最小信息面。
 *
 * 密码强度规则本身由 `PasswordPolicyService` 的定向单测承担，本文件只核实自助改密链路
 * 独有且一旦漂移就会静默锁死账号的九件事：
 * 1. 目标账号只能来自 Session（Command 结构上不含账号 ID）；
 * 2. 当前密码不正确 ⇒ `CURRENT_PASSWORD_MISMATCH`（对外 `BAD_USER_INPUT`），不写库；
 * 3. 当前密码**不**套用新密码策略（存量密码可能先于现行策略设立）；
 * 4. 新密码复用全仓唯一的 `PasswordPolicyService`，且策略校验先于任何数据库访问；
 * 5. 新哈希的时间盐取**锁内数据库行的 `createdAt`**，不是应用时钟；
 * 6. 写哈希失败 ⇒ 整个事务回滚，且失败日志抑制 `message`（UPDATE 绑定参数含哈希）；
 * 7. 成功结果不含当前密码、新密码、哈希或 Token；
 * 8. 不新增 Token 黑名单 / tokenVersion / 服务端会话撤销；
 * 9. 全部日志（成功与失败）都不含当前密码、新密码或哈希；
 * 10. 无论是否强制改密，新密码与当前密码相同都拒绝且不写哈希；强制改密成功仍清除标记。
 */
describe('ChangeMyPasswordUsecase', () => {
  const ACCOUNT_ID = 7;
  /** 数据库权威 `created_at`：它同时是存量哈希与新哈希的时间盐 */
  const DB_CREATED_AT = new Date('2025-06-01T08:30:00.000Z');
  /** 另一个时间：用于证明盐不是取自应用时钟或其它列 */
  const OTHER_CREATED_AT = new Date('2026-02-02T09:00:00.000Z');

  const CURRENT_PASSWORD = 'Old#Pass2026';
  const NEW_PASSWORD = 'Str0ng#Pass2026';
  const NOTICE = '密码已更新，请使用新密码重新登录';

  const STORED_HASH = AccountService.hashPasswordWithTimestamp(CURRENT_PASSWORD, DB_CREATED_AT);

  const harness = createFakeTransactionHarness();

  const accountService = {
    lockMyAccountCredentialSnapshot: jest.fn(),
    updateAccountPasswordHash: jest.fn(),
  } as unknown as AccountService;

  const passwordPolicyService = {
    validatePassword: jest.fn(),
  } as unknown as PasswordPolicyService;

  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;

  const usecase = new ChangeMyPasswordUsecase(
    accountService,
    passwordPolicyService,
    logger,
    harness.transactionRunner,
  );

  const session = (overrides: Partial<UsecaseSession> = {}): UsecaseSession => ({
    accountId: ACCOUNT_ID,
    roles: [IdentityTypeEnum.CUSTOMER],
    activeRole: IdentityTypeEnum.CUSTOMER,
    ...overrides,
  });

  const execute = (
    currentPassword: unknown = CURRENT_PASSWORD,
    newPassword: unknown = NEW_PASSWORD,
    overrides: Partial<UsecaseSession> = {},
  ) => usecase.execute({ session: session(overrides), currentPassword, newPassword });

  const capturedWrite = (): Record<string, unknown> =>
    (accountService.updateAccountPasswordHash as jest.Mock).mock.calls[0][0] as Record<
      string,
      unknown
    >;

  /** 本次执行产生的全部日志文本（结构化负载 + 消息），用于「日志不含秘密」断言 */
  const loggedText = (): string =>
    JSON.stringify([
      (logger.info as jest.Mock).mock.calls,
      (logger.warn as jest.Mock).mock.calls,
      (logger.error as jest.Mock).mock.calls,
    ]);

  beforeEach(() => {
    jest.clearAllMocks();
    harness.reset();
    (accountService.lockMyAccountCredentialSnapshot as jest.Mock).mockReset().mockResolvedValue({
      id: ACCOUNT_ID,
      status: AccountStatus.ACTIVE,
      loginPassword: STORED_HASH,
      createdAt: DB_CREATED_AT,
      mustChangePassword: false,
    });
    (accountService.updateAccountPasswordHash as jest.Mock)
      .mockReset()
      .mockResolvedValue(undefined);
    (passwordPolicyService.validatePassword as jest.Mock)
      .mockReset()
      .mockReturnValue({ isValid: true, errors: [], strength: 90 });
  });

  describe('目标账号只来自 Session', () => {
    it('锁定与写哈希的 accountId 恒等于 session.accountId，且共用同一事务上下文', async () => {
      await execute(CURRENT_PASSWORD, NEW_PASSWORD, { accountId: 42 });

      expect(accountService.lockMyAccountCredentialSnapshot).toHaveBeenCalledWith({
        accountId: 42,
        transactionContext: harness.txContext,
      });
      expect(accountService.updateAccountPasswordHash).toHaveBeenCalledWith({
        accountId: 42,
        passwordHash: expect.any(String),
        transactionContext: harness.txContext,
        clearMustChangePassword: true,
      });
      expect(harness.isCommitted()).toBe(true);
    });

    it('非法 Session accountId 先失败关闭，不开启事务、不触碰数据库', async () => {
      await expect(execute(CURRENT_PASSWORD, NEW_PASSWORD, { accountId: 0 })).rejects.toMatchObject(
        { code: INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE },
      );

      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.lockMyAccountCredentialSnapshot).not.toHaveBeenCalled();
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
    });

    it('账号行缺失时按读失败关闭，不塌缩为 UNAUTHENTICATED', async () => {
      (accountService.lockMyAccountCredentialSnapshot as jest.Mock).mockResolvedValue(null);

      const error = await captureThrownError(execute());

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        details: undefined,
        cause: { diagnostic: 'ACCOUNT_ROW_MISSING', accountId: ACCOUNT_ID },
      });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
    });
  });

  describe('当前密码验证边界', () => {
    it('当前密码不正确时拒绝，不写哈希，事务回滚并记 warn', async () => {
      const error = await captureThrownError(execute('Wrong#Pass2026', NEW_PASSWORD));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.CURRENT_PASSWORD_MISMATCH,
        message: '当前密码不正确',
        details: undefined,
        cause: undefined,
      });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: ACCOUNT_ID,
          errorCode: MY_ACCOUNT_ERROR.CURRENT_PASSWORD_MISMATCH,
          phase: 'VERIFY_CURRENT_PASSWORD',
        }),
        expect.any(String),
      );
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('首尾含空白的当前密码同样收敛为「不匹配」，不外泄 AUTH_ERROR.INVALID_PASSWORD', async () => {
      // normalize 刻意不 trim 密码；preprocessPassword 会抛 AUTH_ERROR.INVALID_PASSWORD
      // （过滤器映射 UNAUTHENTICATED），用例必须把它转译为业务拒绝
      await expect(execute(` ${CURRENT_PASSWORD} `, NEW_PASSWORD)).rejects.toMatchObject({
        code: MY_ACCOUNT_ERROR.CURRENT_PASSWORD_MISMATCH,
      });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
    });

    it('不区分「密码错误」与「格式不可验证」，两者返回同一码与同一文案', async () => {
      const wrong = await captureThrownError(execute('Wrong#Pass2026', NEW_PASSWORD));
      const malformed = await captureThrownError(execute(' padded#Pass2026 ', NEW_PASSWORD));

      expect((wrong as Error).message).toBe((malformed as Error).message);
      expect((wrong as { code: string }).code).toBe((malformed as { code: string }).code);
    });
  });

  describe('强制改密必须实际更换密码', () => {
    /** 模拟管理员要求下次登录必须改密的账号（数据库锁内快照事实） */
    const mockMustChangePasswordSnapshot = (): void => {
      (accountService.lockMyAccountCredentialSnapshot as jest.Mock).mockResolvedValue({
        id: ACCOUNT_ID,
        status: AccountStatus.ACTIVE,
        loginPassword: STORED_HASH,
        createdAt: DB_CREATED_AT,
        mustChangePassword: true,
      });
    };

    it('新密码与当前密码相同时拒绝，不写哈希、不清标记，事务回滚并记 warn', async () => {
      mockMustChangePasswordSnapshot();

      const error = await captureThrownError(execute(CURRENT_PASSWORD, CURRENT_PASSWORD));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.NEW_PASSWORD_UNCHANGED,
        message: '新密码需与当前密码不同',
        details: undefined,
      });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: ACCOUNT_ID,
          errorCode: MY_ACCOUNT_ERROR.NEW_PASSWORD_UNCHANGED,
          phase: 'VERIFY_NEW_PASSWORD_DISTINCT',
        }),
        expect.any(String),
      );
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('新密码不同时正常覆盖哈希并在同一 UPDATE 清除强制改密标记', async () => {
      mockMustChangePasswordSnapshot();

      await expect(execute(CURRENT_PASSWORD, NEW_PASSWORD)).resolves.toMatchObject({
        isUpdated: true,
      });

      expect(accountService.updateAccountPasswordHash).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        passwordHash: AccountService.hashPasswordWithTimestamp(NEW_PASSWORD, DB_CREATED_AT),
        transactionContext: harness.txContext,
        clearMustChangePassword: true,
      });
      expect(harness.isCommitted()).toBe(true);
    });

    it('未要求强制改密时提交同值密码同样拒绝，且不写哈希', async () => {
      // beforeEach 默认快照 mustChangePassword: false
      const error = await captureThrownError(execute(CURRENT_PASSWORD, CURRENT_PASSWORD));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.NEW_PASSWORD_UNCHANGED,
        message: '新密码需与当前密码不同',
        details: undefined,
      });
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: ACCOUNT_ID,
          errorCode: MY_ACCOUNT_ERROR.NEW_PASSWORD_UNCHANGED,
          phase: 'VERIFY_NEW_PASSWORD_DISTINCT',
        }),
        expect.any(String),
      );
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe('密码策略只作用于新密码', () => {
    it('存量弱口令作为当前密码时仍可改密，策略只校验新密码一次', async () => {
      const legacyPassword = '123';
      (accountService.lockMyAccountCredentialSnapshot as jest.Mock).mockResolvedValue({
        id: ACCOUNT_ID,
        status: AccountStatus.ACTIVE,
        loginPassword: AccountService.hashPasswordWithTimestamp(legacyPassword, DB_CREATED_AT),
        createdAt: DB_CREATED_AT,
        mustChangePassword: false,
      });

      await expect(execute(legacyPassword, NEW_PASSWORD)).resolves.toMatchObject({
        isUpdated: true,
      });

      expect(passwordPolicyService.validatePassword).toHaveBeenCalledTimes(1);
      expect(passwordPolicyService.validatePassword).toHaveBeenCalledWith(NEW_PASSWORD);
      expect(passwordPolicyService.validatePassword).not.toHaveBeenCalledWith(legacyPassword);
    });

    it('新密码不合规时按输入错误拒绝，且不开启事务、不取行锁', async () => {
      (passwordPolicyService.validatePassword as jest.Mock).mockReturnValue({
        isValid: false,
        errors: ['长度至少 8 位', '必须包含数字'],
        strength: 10,
      });

      const error = await captureThrownError(execute(CURRENT_PASSWORD, 'weak'));

      expect(error).toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });
      expect((error as Error).message).toBe('新密码不符合安全要求: 长度至少 8 位, 必须包含数字');
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.lockMyAccountCredentialSnapshot).not.toHaveBeenCalled();
      expect(accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
    });

    it('当前密码为空 / 新密码为空时在策略校验之前失败关闭', async () => {
      await expect(execute('', NEW_PASSWORD)).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
      });
      await expect(execute(CURRENT_PASSWORD, '')).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
      });

      expect(passwordPolicyService.validatePassword).not.toHaveBeenCalled();
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });

    it('新密码原样传给策略校验，不被 trim 改写', async () => {
      // normalize 不 trim 密码：trim 会静默改写秘密并掩盖策略层的拒绝语义
      await execute(CURRENT_PASSWORD, NEW_PASSWORD);

      expect(passwordPolicyService.validatePassword).toHaveBeenCalledWith(NEW_PASSWORD);
    });
  });

  describe('哈希时间盐取锁内数据库行的 createdAt', () => {
    it('新哈希可用数据库 createdAt 验证，用其它时间则验证失败', async () => {
      await execute(CURRENT_PASSWORD, NEW_PASSWORD);

      const passwordHash = capturedWrite().passwordHash as string;
      expect(passwordHash).toBe(
        AccountService.hashPasswordWithTimestamp(NEW_PASSWORD, DB_CREATED_AT),
      );
      expect(passwordHash).not.toBe(
        AccountService.hashPasswordWithTimestamp(NEW_PASSWORD, OTHER_CREATED_AT),
      );
      expect(AccountService.verifyPassword(NEW_PASSWORD, passwordHash, DB_CREATED_AT)).toBe(true);
      // 旧密码立即失效：哈希已被覆盖
      expect(AccountService.verifyPassword(CURRENT_PASSWORD, passwordHash, DB_CREATED_AT)).toBe(
        false,
      );
    });

    it('盐随锁内快照的 createdAt 变化（不由应用侧另取时钟）', async () => {
      (accountService.lockMyAccountCredentialSnapshot as jest.Mock).mockResolvedValue({
        id: ACCOUNT_ID,
        status: AccountStatus.ACTIVE,
        loginPassword: AccountService.hashPasswordWithTimestamp(CURRENT_PASSWORD, OTHER_CREATED_AT),
        createdAt: OTHER_CREATED_AT,
        mustChangePassword: false,
      });

      await execute(CURRENT_PASSWORD, NEW_PASSWORD);

      expect(capturedWrite().passwordHash).toBe(
        AccountService.hashPasswordWithTimestamp(NEW_PASSWORD, OTHER_CREATED_AT),
      );
    });
  });

  describe('写失败回滚与日志抑制', () => {
    it('写哈希抛非领域异常时收敛为 WRITE_FAILED、事务回滚，且日志抑制 message', async () => {
      (accountService.updateAccountPasswordHash as jest.Mock).mockRejectedValue(
        Object.assign(
          new Error("ER_DUP_ENTRY: UPDATE base_user_account SET login_password = 'hash'"),
          {
            name: 'QueryFailedError',
            driverError: { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' },
          },
        ),
      );

      const error = await captureThrownError(execute());

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'UNEXPECTED',
          phase: 'WRITE_PASSWORD_HASH',
          errorName: 'QueryFailedError',
          driverCode: 1205,
          // 写哈希阶段的 UPDATE 绑定参数含哈希，message 必须被抑制
          message: undefined,
        }),
        expect.any(String),
      );
    });

    it('事务边界自身失败时收敛为 WRITE_FAILED', async () => {
      harness.runMock.mockRejectedValueOnce(new Error('simulated COMMIT failure'));

      await expect(execute()).rejects.toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(harness.isCommitted()).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'TRANSACTION_BOUNDARY', accountId: ACCOUNT_ID }),
        expect.any(String),
      );
    });

    it('预验证之外抛出的 AUTH_ERROR 领域异常原样冒泡，不被转译为业务拒绝', async () => {
      (accountService.updateAccountPasswordHash as jest.Mock).mockImplementation(() => {
        throw Object.assign(new Error('boom'), {
          name: 'DomainError',
          code: AUTH_ERROR.INVALID_PASSWORD,
        });
      });

      // 只在「当前密码验证」这一步拦截 AUTH_ERROR.INVALID_PASSWORD；写入阶段的同码异常
      // 属基础设施/契约故障，不得被伪装成「当前密码不正确」
      await expect(execute()).rejects.toMatchObject({ code: AUTH_ERROR.INVALID_PASSWORD });
    });
  });

  describe('最小信息面', () => {
    it('成功结果只含 isUpdated 与固定文案，不含密码 / 哈希 / Token', async () => {
      const outcome = await execute(CURRENT_PASSWORD, NEW_PASSWORD);

      expect(Object.keys(outcome).sort()).toEqual(['isUpdated', 'notice']);
      expect(outcome).toEqual({ isUpdated: true, notice: NOTICE });
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(CURRENT_PASSWORD);
      expect(serialized).not.toContain(NEW_PASSWORD);
      expect(serialized).not.toContain(STORED_HASH);
      expect(serialized).not.toContain('token');
    });

    it('不新增 Token 黑名单 / 服务端撤销：依赖面只有四个，成功日志只含账号主键', async () => {
      await execute(CURRENT_PASSWORD, NEW_PASSWORD);

      // 构造函数只接受 AccountService、PasswordPolicyService、PinoLogger、TransactionRunner：
      // 结构上不存在 Token / Session / 黑名单依赖，故不可能做服务端撤销
      expect(ChangeMyPasswordUsecase.length).toBe(4);
      expect(accountService.lockMyAccountCredentialSnapshot).toHaveBeenCalledTimes(1);
      expect(accountService.updateAccountPasswordHash).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith({ accountId: ACCOUNT_ID }, expect.any(String));
      // 文案不声称已撤销 Token（旧 Access Token 按 JWT_EXPIRES_IN 自然过期）
      expect(NOTICE).not.toMatch(/撤销|失效|Token|token/);
    });

    it('成功与失败日志都不含当前密码、新密码或哈希', async () => {
      await execute(CURRENT_PASSWORD, NEW_PASSWORD);
      const successLog = loggedText();
      expect(successLog).not.toContain(CURRENT_PASSWORD);
      expect(successLog).not.toContain(NEW_PASSWORD);
      expect(successLog).not.toContain(STORED_HASH);
      expect(successLog).not.toContain(capturedWrite().passwordHash as string);

      jest.clearAllMocks();
      harness.reset();
      await captureThrownError(execute('Wrong#Pass2026', NEW_PASSWORD));
      const failureLog = loggedText();
      expect(failureLog).not.toContain('Wrong#Pass2026');
      expect(failureLog).not.toContain(NEW_PASSWORD);
      expect(failureLog).not.toContain(STORED_HASH);
    });
  });
});
