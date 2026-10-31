// src/usecases/account/admin-update-user-profile.usecase.spec.ts

import {
  ACCOUNT_ERROR,
  ADMIN_USER_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountService } from '@src/modules/account/base/services/account.service';
import type { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { PinoLogger } from 'nestjs-pino';
import {
  ADMIN_ACCOUNT_ID,
  TARGET_ACCOUNT_ID,
  captureThrownError,
  createAdminOrganizationFact,
  createAdminUserView,
  createFakeTransactionHarness,
  createOrganizationIsolationMocks,
  createSuperAdminSession,
  createSuperAdminTargetView,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { AdminUpdateUserProfileUsecase } from './admin-update-user-profile.usecase';

/**
 * P2-1A：`AdminUpdateUserProfileUsecase` 的授权、目标保护、三态 patch 构造与写后回读。
 *
 * 重点核实三件容易漂移的事：
 * 1. 精确 SUPER_ADMIN 授权与 SUPER_ADMIN 目标只读保护都在任何写入之前失败关闭；
 * 2. 四个资料字段的三态语义（`undefined` 不进 patch / `null` 明确清空 / `string` 新值），
 *    且 `contactEmail` 映射到实体列 `email`，绝不写进登录凭据邮箱；
 * 3. 空差异在**事务前**被拒（不取行锁、不 UPDATE、不返回假成功），写入后回读必须反映本次
 *    patch，否则整次事务回滚。
 */
describe('AdminUpdateUserProfileUsecase', () => {
  const harness = createFakeTransactionHarness();

  const accountService = {
    lockByIdForUpdate: jest.fn(),
    updateUserInfoFields: jest.fn(),
  } as unknown as AccountService;

  const adminUserQueryService = {
    findAdminUserViewById: jest.fn(),
  } as unknown as AdminUserQueryService;

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

  const usecase = new AdminUpdateUserProfileUsecase(
    accountService,
    adminUserQueryService,
    organizationIsolation.organizationContextQueryService,
    organizationIsolation.organizationMembershipQueryService,
    logger,
    harness.transactionRunner,
  );

  /** 锁内目标加载成功（缺省目标是可写的 CUSTOMER） */
  const givenLockedTarget = (view = createAdminUserView()): void => {
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockResolvedValue(view);
  };

  const executeAsSuperAdmin = (input: {
    readonly accountId?: unknown;
    readonly nickname?: unknown;
    readonly companyName?: unknown;
    readonly phone?: unknown;
    readonly contactEmail?: unknown;
  }) =>
    usecase.execute({
      session: createSuperAdminSession(),
      accountId: 'accountId' in input ? input.accountId : TARGET_ACCOUNT_ID,
      nickname: input.nickname,
      companyName: input.companyName,
      phone: input.phone,
      contactEmail: input.contactEmail,
    });

  /** 取本次传给 AccountService 的资料 patch */
  const capturedPatch = (): Record<string, unknown> =>
    (accountService.updateUserInfoFields as jest.Mock).mock.calls[0][0].patch as Record<
      string,
      unknown
    >;

  beforeEach(() => {
    jest.clearAllMocks();
    harness.reset();
    (adminUserQueryService.findAdminUserViewById as jest.Mock).mockReset();
    (accountService.lockByIdForUpdate as jest.Mock).mockReset().mockResolvedValue(undefined);
    (accountService.updateUserInfoFields as jest.Mock).mockReset().mockResolvedValue(undefined);
    givenLockedTarget();
    givenOrganizationIsolation();
  });

  describe('精确 SUPER_ADMIN 授权', () => {
    it.each(createUnauthorizedSessions())(
      '%s 被拒，且不开启事务、不触碰数据库',
      async (_label, session) => {
        await expect(
          usecase.execute({
            session,
            accountId: TARGET_ACCOUNT_ID,
            nickname: 'new_nickname',
          }),
        ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

        expect(harness.transactionRunner.run).not.toHaveBeenCalled();
        expect(accountService.lockByIdForUpdate).not.toHaveBeenCalled();
        expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
        expect(harness.isCommitted()).toBe(false);
        expect(harness.isRolledBack()).toBe(false);
      },
    );
  });

  describe('SUPER_ADMIN 目标只读保护', () => {
    it('编辑管理员资料被拒且事务回滚', async () => {
      givenLockedTarget(createSuperAdminTargetView());

      const error = await captureThrownError(
        usecase.execute({
          session: createSuperAdminSession(),
          accountId: ADMIN_ACCOUNT_ID,
          nickname: 'renamed_admin',
        }),
      );

      expect(error).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(accountService.lockByIdForUpdate).toHaveBeenCalledWith(
        ADMIN_ACCOUNT_ID,
        harness.txContext,
      );
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
    });

    it('目标账号不存在时收敛为 TARGET_NOT_FOUND，不塌缩为 UNAUTHENTICATED', async () => {
      (accountService.lockByIdForUpdate as jest.Mock).mockRejectedValue(
        new DomainError(ACCOUNT_ERROR.ACCOUNT_NOT_FOUND, '账号不存在'),
      );

      const error = await captureThrownError(executeAsSuperAdmin({ nickname: 'new_nickname' }));

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.TARGET_NOT_FOUND });
      expect(harness.isRolledBack()).toBe(true);
    });
  });

  describe('组织隔离（管理员只能管理本组织）', () => {
    it('目标不在管理员可信组织内时收敛为 TARGET_NOT_FOUND，零写入并回滚', async () => {
      organizationIsolation.findActiveMembership.mockReset().mockResolvedValue(null);

      const error = await captureThrownError(executeAsSuperAdmin({ nickname: 'new_nickname' }));

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.TARGET_NOT_FOUND });
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
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

      const error = await captureThrownError(executeAsSuperAdmin({ nickname: 'new_nickname' }));

      expect(error).toMatchObject({ code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP });
      // 组织解析已后移到行锁之后：先锁定目标，组织裁决失败后不再读取目标资料与写入
      expect(accountService.lockByIdForUpdate).toHaveBeenCalledWith(
        TARGET_ACCOUNT_ID,
        harness.txContext,
      );
      expect(organizationIsolation.findActiveMembership).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
    });
  });

  describe('空差异在事务前被拒', () => {
    it('只传 accountId 时拒绝，且不取行锁、不 UPDATE、不返回假成功', async () => {
      const error = await captureThrownError(executeAsSuperAdmin({}));

      expect(error).toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.lockByIdForUpdate).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(harness.isCommitted()).toBe(false);
      expect(harness.isRolledBack()).toBe(false);
    });

    it('可空字段的纯空白收敛为「明确清空」，不构成空差异', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(
          createAdminUserView({ companyName: 'old', phone: '123', contactEmail: 'a@b.com' }),
        )
        .mockResolvedValueOnce(createAdminUserView());

      await executeAsSuperAdmin({ companyName: '   ', phone: '  ', contactEmail: ' ' });

      // 三态口径：可空字段的空白 = null（写 NULL），与「未提供」不同义；
      // 因此这不是空差异，不得被事务前的空 patch 拦截
      expect(accountService.updateUserInfoFields).toHaveBeenCalledTimes(1);
      expect(capturedPatch()).toEqual({ companyName: null, phone: null, email: null });
      expect(harness.isCommitted()).toBe(true);
    });
  });

  describe('三态 patch 构造', () => {
    it('未提供的字段不进入 patch（undefined 不会被写进 SET 子句）', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(createAdminUserView())
        .mockResolvedValueOnce(createAdminUserView({ nickname: 'new_nickname' }));

      await executeAsSuperAdmin({ nickname: 'new_nickname' });

      const patch = capturedPatch();
      expect(patch).toEqual({ nickname: 'new_nickname' });
      expect(patch).not.toHaveProperty('companyName');
      expect(patch).not.toHaveProperty('phone');
      expect(patch).not.toHaveProperty('email');
      expect(patch).not.toHaveProperty('userState');
    });

    it('显式 null 表示清空该列，与「未提供」区分对待', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(
          createAdminUserView({
            companyName: 'old_company',
            phone: '123',
            contactEmail: 'a@b.com',
          }),
        )
        .mockResolvedValueOnce(createAdminUserView());

      await executeAsSuperAdmin({ companyName: null, phone: null, contactEmail: null });

      expect(capturedPatch()).toEqual({ companyName: null, phone: null, email: null });
    });

    it('contactEmail 映射实体列 email，不写入登录凭据邮箱', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(createAdminUserView())
        .mockResolvedValueOnce(createAdminUserView({ contactEmail: 'contact@example.com' }));

      await executeAsSuperAdmin({ contactEmail: '  Contact@Example.COM  ' });

      const patch = capturedPatch();
      // 邮箱复用 normalizeEmail：trim + 转小写
      expect(patch).toEqual({ email: 'contact@example.com' });
      expect(patch).not.toHaveProperty('contactEmail');
      expect(patch).not.toHaveProperty('loginEmail');
      expect(accountService.updateUserInfoFields).toHaveBeenCalledWith({
        accountId: TARGET_ACCOUNT_ID,
        patch: { email: 'contact@example.com' },
        transactionContext: harness.txContext,
      });
    });

    it('昵称做 trim + NFKC 归一后写入', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(createAdminUserView())
        // 回读必须是归一**后**的值：全角原值会让后置校验判为未反映
        .mockResolvedValueOnce(createAdminUserView({ nickname: 'ABC' }));

      await executeAsSuperAdmin({ nickname: '  ＡＢＣ  ' });

      expect(capturedPatch()).toEqual({ nickname: 'ABC' });
    });
  });

  describe('输入白名单失败关闭', () => {
    const illegalNicknames: ReadonlyArray<unknown> = ['', '   ', null, 1, [], 'a'.repeat(51)];

    it.each(illegalNicknames)('非法昵称 %p 被拒且不开启事务', async (nickname) => {
      await expect(executeAsSuperAdmin({ nickname })).rejects.toMatchObject({
        // 空/纯空白/null 是 REQUIRED_TEXT_EMPTY，超长是 INVALID_TEXT，同属 BAD_USER_INPUT 大类
        code: expect.stringMatching(/INVALID_TEXT|REQUIRED_TEXT_EMPTY/),
      });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });

    it.each([
      ['companyName', { companyName: 'a'.repeat(101) }],
      ['phone', { phone: 'a'.repeat(21) }],
      ['contactEmail', { contactEmail: 'a'.repeat(51) }],
    ])('超长 %s 被拒且不开启事务', async (_field, input) => {
      await expect(executeAsSuperAdmin(input)).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });

    const illegalAccountIds: ReadonlyArray<unknown> = [
      0,
      -1,
      1.5,
      Number.NaN,
      '2',
      null,
      undefined,
    ];

    it.each(illegalAccountIds)('非法目标账号 ID %p 被拒且不开启事务', async (accountId) => {
      await expect(
        executeAsSuperAdmin({ accountId, nickname: 'new_nickname' }),
      ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });
  });

  describe('写后回读校验与原子性', () => {
    it('写入成功且回读反映时提交，并在提交后记录最小信息日志', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(createAdminUserView())
        .mockResolvedValueOnce(
          createAdminUserView({ nickname: 'new_nickname', companyName: 'new_company' }),
        );

      await expect(
        executeAsSuperAdmin({ nickname: 'new_nickname', companyName: 'new_company' }),
      ).resolves.toMatchObject({ nickname: 'new_nickname', companyName: 'new_company' });

      expect(accountService.updateUserInfoFields).toHaveBeenCalledTimes(1);
      expect(harness.isCommitted()).toBe(true);
      expect(harness.isRolledBack()).toBe(false);

      // 日志只含账号主键与协议字段名清单，不含昵称等字段值
      expect(logger.info).toHaveBeenCalledWith(
        { accountId: TARGET_ACCOUNT_ID, updatedFields: ['nickname', 'companyName'] },
        expect.any(String),
      );
      const loggedPayload = (logger.info as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(JSON.stringify(loggedPayload)).not.toContain('new_nickname');
    });

    it('回读未反映本次 patch 时按写失败关闭并回滚', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(createAdminUserView())
        // 回读仍是旧昵称：静默 0 行更新不得伪装成成功
        .mockResolvedValueOnce(createAdminUserView({ nickname: 'target_nickname' }));

      const error = await captureThrownError(executeAsSuperAdmin({ nickname: 'new_nickname' }));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
        cause: { diagnostic: 'PROFILE_NOT_REFLECTED_AFTER_WRITE' },
      });
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('清空语义未被回读反映时同样失败关闭', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(createAdminUserView({ companyName: 'old_company' }))
        .mockResolvedValueOnce(createAdminUserView({ companyName: 'old_company' }));

      const error = await captureThrownError(executeAsSuperAdmin({ companyName: null }));

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(harness.isRolledBack()).toBe(true);
    });

    it('写后回读为空时按读失败关闭', async () => {
      (adminUserQueryService.findAdminUserViewById as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(createAdminUserView())
        .mockResolvedValueOnce(null);

      const error = await captureThrownError(executeAsSuperAdmin({ nickname: 'new_nickname' }));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        cause: { diagnostic: 'UPDATED_PROFILE_NOT_READABLE' },
      });
      expect(harness.isRolledBack()).toBe(true);
    });

    it('资料写入抛非领域异常时收敛为 WRITE_FAILED 并回滚', async () => {
      (accountService.updateUserInfoFields as jest.Mock).mockRejectedValue(
        Object.assign(new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded'), {
          name: 'QueryFailedError',
          driverError: { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' },
        }),
      );

      const error = await captureThrownError(executeAsSuperAdmin({ nickname: 'new_nickname' }));

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      // 非领域异常记录阶段、异常类型名与驱动错误码，便于区分死锁/超时/连接中断
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'UNEXPECTED',
          phase: 'WRITE_PROFILE',
          errorName: 'QueryFailedError',
          driverCode: 1205,
        }),
        expect.any(String),
      );
    });

    it('事务边界自身失败时收敛为 WRITE_FAILED', async () => {
      harness.runMock.mockRejectedValueOnce(new Error('simulated COMMIT failure'));

      await expect(executeAsSuperAdmin({ nickname: 'new_nickname' })).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
      });
      expect(harness.isCommitted()).toBe(false);
    });
  });

  it('资料编辑不改写角色与状态事实（identityHint / accessGroup / status / userState 不进 patch）', async () => {
    (adminUserQueryService.findAdminUserViewById as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce(createAdminUserView())
      .mockResolvedValueOnce(createAdminUserView({ nickname: 'new_nickname' }));

    await executeAsSuperAdmin({ nickname: 'new_nickname' });

    // 角色在创建后只读、启用停用属 adminSetUserStatus：
    // 本用例的 patch 不得携带任何访问语义或状态字段
    const patch = capturedPatch();
    expect(patch).not.toHaveProperty('accessGroup');
    expect(patch).not.toHaveProperty('metaDigest');
    expect(patch).not.toHaveProperty('identityHint');
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('userState');
  });
});
