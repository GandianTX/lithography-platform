// src/usecases/account/update-my-account-settings.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import {
  ADMIN_USER_ERROR,
  INPUT_NORMALIZE_ERROR,
  MY_ACCOUNT_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type {
  MyAccountSettingsSnapshot,
  MyAccountSettingsUpdateFacts,
} from '@src/modules/account/account.types';
import type { AccountService } from '@src/modules/account/base/services/account.service';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { PinoLogger } from 'nestjs-pino';
import {
  captureThrownError,
  createFakeTransactionHarness,
} from '../../../test/support/account/admin-user.fixture';
import { UpdateMyAccountSettingsUsecase } from './update-my-account-settings.usecase';
import type { MyAccountTrustedOrganizationFacts } from './my-account-settings.types';

/**
 * P2：`UpdateMyAccountSettingsUsecase` 的目标来源、凭据组合裁决、三态写入与原子性。
 *
 * 单字段的 trim / NFKC / 长度 / 字符集收敛在 `my-account-settings.input.normalize.spec.ts`
 * 与 admin 场景另有定向单测，本文件只核实用例层独有的十件事：
 * 1. 目标账号**只能**来自 Session——下游收到的 `accountId` 恒等于 `session.accountId`；
 * 2. 「至少保留一个登录凭据」是**锁内合并后**的裁决，输入层无从判定；
 * 3. 凭据唯一性预检查只针对「发生变化且非空」的候选列，命中即拒绝且不写库；
 * 4. 预检查通过但唯一索引最终裁决冲突（并发竞争）时收敛为 `CREDENTIAL_CONFLICT`；
 * 5. 六个字段的三态语义（`undefined` 不改 / `null` 清空 / `string` 设置）；
 * 6. 昵称空值被拒、重名不被拒（昵称无唯一性，也不进凭据预检查）；
 * 7. 全字段同值或未提供时不落库，返回 `isUpdated: false` 与当前 View；
 * 8. 账号列与资料列在**同一个** `transactionContext` 内写入；
 * 9. 第二阶段写入或写后回读失败 ⇒ 整个事务回滚，不留半成功数据；
 * 10. 回读产出的公开 View 不含 `accountId` 与任何敏感 / 内部字段，且不触碰角色与状态。
 */
describe('UpdateMyAccountSettingsUsecase', () => {
  const ACCOUNT_ID = 7;
  const UPDATED_AT = new Date('2026-01-01T00:00:00.000Z');

  /** 事务内下游调用的先后顺序，用于证明「先锁后写、最后回读」 */
  const order: string[] = [];

  /** 假数据库当前值：锁内事实、窄写入与回读快照都由它派生，写入即改变它 */
  type FakeAccountRow = {
    loginName: string | null;
    loginEmail: string | null;
    nickname: string;
    realName: string | null;
    companyName: string | null;
    phone: string | null;
    contactEmail: string | null;
  };

  const initialRow = (): FakeAccountRow => ({
    loginName: 'self_user',
    loginEmail: 'self@example.com',
    nickname: 'self_nickname',
    realName: '张三',
    companyName: '示例公司',
    phone: '13800000000',
    contactEmail: 'contact@example.com',
  });

  let row: FakeAccountRow = initialRow();

  const harness = createFakeTransactionHarness();

  const accountService = {
    lockMyAccountSettingsFacts: jest.fn(),
    updateMyAccountCredentials: jest.fn(),
    updateUserInfoFields: jest.fn(),
  } as unknown as AccountService;

  const accountQueryService = {
    findMyAccountCredentialConflictField: jest.fn(),
    findMyAccountSettingsSnapshot: jest.fn(),
  } as unknown as AccountQueryService;

  const organizationQueryService = {
    findOrganizationNameById: jest.fn(),
  } as unknown as OrganizationQueryService;

  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;

  const usecase = new UpdateMyAccountSettingsUsecase(
    accountService,
    accountQueryService,
    organizationQueryService,
    logger,
    harness.transactionRunner,
  );

  const session = (overrides: Partial<UsecaseSession> = {}): UsecaseSession => ({
    accountId: ACCOUNT_ID,
    roles: [IdentityTypeEnum.CUSTOMER],
    activeRole: IdentityTypeEnum.CUSTOMER,
    ...overrides,
  });

  /** 请求期会话解析出的可信组织事实：本文件快照角色固定为 CUSTOMER */
  const trustedOrganizations: MyAccountTrustedOrganizationFacts = {
    customerOrganizationId: 11,
    engineerOrganizationId: 22,
    adminOrganizationId: 33,
  };

  /** 执行入口：七个字段必须显式给出，`undefined` 才表达「未提供」 */
  const execute = (
    fields: Partial<
      Record<
        | 'loginName'
        | 'loginEmail'
        | 'nickname'
        | 'realName'
        | 'companyName'
        | 'phone'
        | 'contactEmail',
        unknown
      >
    > = {},
    overrides: Partial<UsecaseSession> = {},
    restriction: SessionRestriction = SessionRestriction.NONE,
  ) =>
    usecase.execute({
      session: session(overrides),
      restriction,
      trustedOrganizations,
      loginName: fields.loginName,
      loginEmail: fields.loginEmail,
      nickname: fields.nickname,
      realName: fields.realName,
      companyName: fields.companyName,
      phone: fields.phone,
      contactEmail: fields.contactEmail,
    });

  const snapshotOf = (source: FakeAccountRow): MyAccountSettingsSnapshot => ({
    accountId: ACCOUNT_ID,
    ...source,
    role: IdentityTypeEnum.CUSTOMER,
    status: AccountStatus.ACTIVE,
    adminLevel: null,
    updatedAt: UPDATED_AT,
  });

  const capturedPatch = (): Record<string, unknown> =>
    (accountService.updateUserInfoFields as jest.Mock).mock.calls[0][0].patch as Record<
      string,
      unknown
    >;

  const capturedCredentialWrite = (): Record<string, unknown> =>
    (accountService.updateMyAccountCredentials as jest.Mock).mock.calls[0][0] as Record<
      string,
      unknown
    >;

  const conflictParams = (): Record<string, unknown> =>
    (accountQueryService.findMyAccountCredentialConflictField as jest.Mock).mock
      .calls[0][0] as Record<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    harness.reset();
    row = initialRow();
    order.length = 0;

    (accountService.lockMyAccountSettingsFacts as jest.Mock).mockReset().mockImplementation(() => {
      order.push('LOCK');
      return Promise.resolve({ accountId: ACCOUNT_ID, ...row } as MyAccountSettingsUpdateFacts);
    });
    (accountService.updateMyAccountCredentials as jest.Mock)
      .mockReset()
      .mockImplementation((params: { loginName: string | null; loginEmail: string | null }) => {
        order.push('WRITE_CREDENTIALS');
        row.loginName = params.loginName;
        row.loginEmail = params.loginEmail;
        return Promise.resolve({ kind: 'UPDATED' });
      });
    (accountService.updateUserInfoFields as jest.Mock)
      .mockReset()
      .mockImplementation((params: { patch: Record<string, unknown> }) => {
        order.push('WRITE_PROFILE');
        const patch = params.patch;
        if ('nickname' in patch) row.nickname = patch.nickname as string;
        if ('realName' in patch) row.realName = patch.realName as string | null;
        if ('companyName' in patch) row.companyName = patch.companyName as string | null;
        if ('phone' in patch) row.phone = patch.phone as string | null;
        // 联系邮箱的实体列名是 email，协议名仍是 contactEmail
        if ('email' in patch) row.contactEmail = patch.email as string | null;
        return Promise.resolve(undefined);
      });
    (accountQueryService.findMyAccountCredentialConflictField as jest.Mock)
      .mockReset()
      .mockImplementation(() => {
        order.push('PRECHECK');
        return Promise.resolve(null);
      });
    (accountQueryService.findMyAccountSettingsSnapshot as jest.Mock)
      .mockReset()
      .mockImplementation(() => {
        order.push('READ_BACK');
        return Promise.resolve(snapshotOf(row));
      });
    (organizationQueryService.findOrganizationNameById as jest.Mock)
      .mockReset()
      .mockResolvedValue('可信公司');
  });

  describe('目标账号只来自 Session', () => {
    it.each([
      ['CUSTOMER 会话', IdentityTypeEnum.CUSTOMER],
      ['ENGINEER 会话', IdentityTypeEnum.ENGINEER],
      ['SUPER_ADMIN 会话', IdentityTypeEnum.SUPER_ADMIN],
    ])('%s 下锁定与写入的 accountId 恒等于 session.accountId', async (_label, role) => {
      await execute({ nickname: 'renamed' }, { accountId: 42, roles: [role], activeRole: role });

      expect(accountService.lockMyAccountSettingsFacts).toHaveBeenCalledWith({
        accountId: 42,
        transactionContext: harness.txContext,
      });
      expect(accountQueryService.findMyAccountSettingsSnapshot).toHaveBeenCalledWith({
        accountId: 42,
        transactionContext: harness.txContext,
      });
      expect(accountService.updateUserInfoFields).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 42 }),
      );
    });

    it('非法 Session accountId 先失败关闭，不开启事务、不触碰数据库', async () => {
      const error = await captureThrownError(execute({ nickname: 'renamed' }, { accountId: 0 }));

      expect(error).toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.lockMyAccountSettingsFacts).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
    });

    it('账号行缺失时按读失败关闭，不塌缩为 UNAUTHENTICATED', async () => {
      (accountService.lockMyAccountSettingsFacts as jest.Mock).mockResolvedValue(null);

      const error = await captureThrownError(execute({ nickname: 'renamed' }));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        details: undefined,
        cause: { diagnostic: 'ACCOUNT_ROW_MISSING', accountId: ACCOUNT_ID },
      });
      expect(harness.isRolledBack()).toBe(true);
    });
  });

  describe('受限会话的本人资料写入白名单', () => {
    it.each([
      ['ENGINEER_PENDING', SessionRestriction.ENGINEER_PENDING],
      ['ENGINEER_REJECTED', SessionRestriction.ENGINEER_REJECTED],
      ['ENGINEER_INACTIVE', SessionRestriction.ENGINEER_INACTIVE],
    ])('%s 下允许维护昵称、电话与联系邮箱', async (_label, restriction) => {
      const outcome = await execute(
        { nickname: 'renamed', phone: '13900000000', contactEmail: 'new@example.com' },
        {},
        restriction,
      );

      expect(outcome.isUpdated).toBe(true);
      expect(capturedPatch()).toEqual({
        nickname: 'renamed',
        phone: '13900000000',
        email: 'new@example.com',
      });
      expect(harness.isCommitted()).toBe(true);
    });

    it.each([
      ['公司名称（字符串）', { companyName: '伪造公司' }, ['companyName']],
      ['公司名称（显式 null）', { companyName: null }, ['companyName']],
      ['真实姓名', { realName: '伪造姓名' }, ['realName']],
      ['登录名（显式 null）', { loginName: null }, ['loginName']],
      ['登录邮箱', { loginEmail: 'other@example.com' }, ['loginEmail']],
      [
        '合法字段与越界字段混传',
        {
          nickname: 'renamed',
          realName: '伪造姓名',
          companyName: '伪造公司',
          loginName: 'other_login',
        },
        ['loginName', 'realName', 'companyName'],
      ],
    ])('受限会话提交 %s 整体拒绝且零写入', async (_label, fields, rejectedFields) => {
      const error = await captureThrownError(
        execute(fields, {}, SessionRestriction.ENGINEER_PENDING),
      );

      expect(error).toMatchObject({
        code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        cause: {
          diagnostic: 'RESTRICTED_PROFILE_FIELDS_REJECTED',
          restriction: SessionRestriction.ENGINEER_PENDING,
          fields: rejectedFields,
        },
      });
      // 拒绝发生在事务之前：不锁行、不写库、混传中的合法字段也不落地
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.lockMyAccountSettingsFacts).not.toHaveBeenCalled();
      expect(accountService.updateMyAccountCredentials).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
    });

    it('越界拒绝的错误信息不含任何字段值', async () => {
      const error = (await captureThrownError(
        execute({ companyName: '秘密公司' }, {}, SessionRestriction.ENGINEER_REJECTED),
      )) as { cause?: unknown };

      expect(JSON.stringify(error.cause)).not.toContain('秘密公司');
      expect(JSON.stringify(error.cause)).toContain('companyName');
    });

    it('MUST_CHANGE_PASSWORD 同样只按白名单放行', async () => {
      const error = await captureThrownError(
        execute({ companyName: '伪造公司' }, {}, SessionRestriction.MUST_CHANGE_PASSWORD),
      );

      expect(error).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
    });

    it('限制解除（NONE）后恢复完整字段写入', async () => {
      await execute({ companyName: '合法公司' }, {}, SessionRestriction.NONE);

      expect(capturedPatch()).toEqual({ companyName: '合法公司' });
      expect(harness.isCommitted()).toBe(true);
    });
  });

  describe('登录凭据「至少保留一个」由锁内合并结果裁决', () => {
    it('清空唯一保留的登录名被拒，且不写库', async () => {
      row.loginEmail = null;

      const error = await captureThrownError(execute({ loginName: null }));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.LOGIN_CREDENTIAL_BOTH_EMPTY,
        cause: { diagnostic: 'LOGIN_CREDENTIAL_BOTH_EMPTY', accountId: ACCOUNT_ID },
      });
      expect(accountService.updateMyAccountCredentials).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      // 预期业务拒绝记 warn，不当作系统故障
      expect(logger.warn).toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('同时清空两列被拒（即使另一列由本次提交显式给出 null）', async () => {
      await expect(execute({ loginName: null, loginEmail: null })).rejects.toMatchObject({
        code: MY_ACCOUNT_ERROR.LOGIN_CREDENTIAL_BOTH_EMPTY,
      });
      expect(accountService.updateMyAccountCredentials).not.toHaveBeenCalled();
    });

    it('历史遗留双空账号即使本次只改资料也失败关闭，不自动修复', async () => {
      row.loginName = null;
      row.loginEmail = null;

      await expect(execute({ companyName: '新公司' })).rejects.toMatchObject({
        code: MY_ACCOUNT_ERROR.LOGIN_CREDENTIAL_BOTH_EMPTY,
      });
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      // 不代填任何一列
      expect(accountService.updateMyAccountCredentials).not.toHaveBeenCalled();
    });

    it('清空登录名但保留登录邮箱时允许，合并结果写入两列', async () => {
      const outcome = await execute({ loginName: null });

      expect(outcome.isUpdated).toBe(true);
      expect(capturedCredentialWrite()).toEqual({
        accountId: ACCOUNT_ID,
        loginName: null,
        loginEmail: 'self@example.com',
        transactionContext: harness.txContext,
      });
      expect(harness.isCommitted()).toBe(true);
    });
  });

  describe('凭据唯一性预检查', () => {
    it('登录名被占用时拒绝，且不写库、事务回滚', async () => {
      (accountQueryService.findMyAccountCredentialConflictField as jest.Mock).mockResolvedValue(
        'loginName',
      );

      const error = await captureThrownError(execute({ loginName: 'taken_user' }));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.CREDENTIAL_CONFLICT,
        cause: {
          diagnostic: 'CREDENTIAL_PRECHECK_CONFLICT',
          field: 'loginName',
          accountId: ACCOUNT_ID,
        },
      });
      expect(accountService.updateMyAccountCredentials).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('登录邮箱被占用时给出邮箱口径的拒绝文案', async () => {
      (accountQueryService.findMyAccountCredentialConflictField as jest.Mock).mockResolvedValue(
        'loginEmail',
      );

      const error = await captureThrownError(execute({ loginEmail: 'taken@example.com' }));

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.CREDENTIAL_CONFLICT,
        cause: { diagnostic: 'CREDENTIAL_PRECHECK_CONFLICT', field: 'loginEmail' },
      });
      expect((error as { message: string }).message).toContain('登录邮箱');
    });

    it('预检查只针对发生变化且非空的候选列（未变化的列与清空为 null 的列都不查）', async () => {
      await execute({ loginName: 'brand_new_user', loginEmail: null });

      expect(conflictParams()).toEqual({
        accountId: ACCOUNT_ID,
        loginName: 'brand_new_user',
        loginEmail: undefined,
        transactionContext: harness.txContext,
      });
    });

    it('凭据未变化时完全跳过预检查与凭据写入', async () => {
      await execute({ nickname: 'renamed' });

      expect(accountQueryService.findMyAccountCredentialConflictField).not.toHaveBeenCalled();
      expect(accountService.updateMyAccountCredentials).not.toHaveBeenCalled();
    });

    it('预检查通过但唯一索引最终冲突（并发竞争）时收敛为 CREDENTIAL_CONFLICT', async () => {
      (accountService.updateMyAccountCredentials as jest.Mock).mockResolvedValue({
        kind: 'CREDENTIAL_CONFLICT',
      });

      const error = await captureThrownError(
        execute({ loginName: 'race_loser', companyName: '新公司' }),
      );

      expect(error).toMatchObject({
        code: MY_ACCOUNT_ERROR.CREDENTIAL_CONFLICT,
        details: undefined,
        cause: { diagnostic: 'CREDENTIAL_UNIQUE_INDEX_CONFLICT', accountId: ACCOUNT_ID },
      });
      // 冲突发生在资料写入之前 ⇒ 后续阶段不再执行，整次事务回滚
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
    });
  });

  describe('七字段三态语义', () => {
    it('undefined = 不修改：未提供的字段既不进资料 patch 也不改写凭据', async () => {
      await execute({ nickname: 'renamed' });

      expect(capturedPatch()).toEqual({ nickname: 'renamed' });
      expect(capturedPatch()).not.toHaveProperty('realName');
      expect(capturedPatch()).not.toHaveProperty('companyName');
      expect(capturedPatch()).not.toHaveProperty('phone');
      expect(capturedPatch()).not.toHaveProperty('email');
      expect(accountService.updateMyAccountCredentials).not.toHaveBeenCalled();
    });

    it('null = 清空：可空字段写 NULL，与「未提供」区分对待', async () => {
      await execute({ realName: null, companyName: null, phone: null, contactEmail: null });

      expect(capturedPatch()).toEqual({
        realName: null,
        companyName: null,
        phone: null,
        email: null,
      });
    });

    it('真实姓名 string = 设置：trim 后写入 realName 列', async () => {
      const outcome = await execute({ realName: '  李四  ' });

      expect(capturedPatch()).toEqual({ realName: '李四' });
      expect(outcome.settings.realName).toBe('李四');
    });

    it('真实姓名同值提交不写库', async () => {
      const outcome = await execute({ realName: '张三' });

      expect(outcome.isUpdated).toBe(false);
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
    });

    it('真实姓名空白字符串 = 清空', async () => {
      await execute({ realName: '   ' });

      expect(capturedPatch()).toEqual({ realName: null });
    });

    it('string = 设置：归一后的新值写入，contactEmail 落到实体列 email', async () => {
      await execute({
        companyName: '  新公司  ',
        phone: '13900000000',
        contactEmail: '  New-Contact@Example.COM ',
      });

      expect(capturedPatch()).toEqual({
        companyName: '新公司',
        phone: '13900000000',
        email: 'new-contact@example.com',
      });
      expect(capturedPatch()).not.toHaveProperty('contactEmail');
      // 联系邮箱绝不能被写进登录凭据列
      expect(accountService.updateMyAccountCredentials).not.toHaveBeenCalled();
    });

    it('凭据与资料在同一次提交中按各自三态写入', async () => {
      const outcome = await execute({
        loginName: 'brand_new_user',
        loginEmail: undefined,
        nickname: 'renamed',
        companyName: null,
        phone: undefined,
        contactEmail: undefined,
      });

      expect(capturedCredentialWrite()).toMatchObject({
        loginName: 'brand_new_user',
        loginEmail: 'self@example.com',
      });
      expect(capturedPatch()).toEqual({ nickname: 'renamed', companyName: null });
      expect(outcome.isUpdated).toBe(true);
      expect(outcome.settings).toMatchObject({
        loginName: 'brand_new_user',
        loginEmail: 'self@example.com',
        nickname: 'renamed',
        companyName: null,
        phone: '13800000000',
        contactEmail: 'contact@example.com',
      });
    });

    it('同值提交被抑制：与当前值相同的字段不进入 patch', async () => {
      const outcome = await execute({
        nickname: 'self_nickname',
        companyName: '示例公司',
        phone: '13800000000',
        contactEmail: 'contact@example.com',
      });

      expect(outcome.isUpdated).toBe(false);
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      expect(accountService.updateMyAccountCredentials).not.toHaveBeenCalled();
      expect(harness.isCommitted()).toBe(true);
    });
  });

  describe('昵称边界', () => {
    it.each([
      ['显式 null', null],
      ['空字符串', ''],
      ['纯空白', '   '],
    ])('昵称 %s 被拒且不开启事务', async (_label, nickname) => {
      await expect(execute({ nickname })).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
      });
      expect(harness.transactionRunner.run).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
    });

    it('昵称允许重复：重名不触发任何唯一性检查，也不被拒绝', async () => {
      const outcome = await execute({ nickname: 'self_nickname_of_another_user' });

      expect(outcome.isUpdated).toBe(true);
      expect(capturedPatch()).toEqual({ nickname: 'self_nickname_of_another_user' });
      expect(accountQueryService.findMyAccountCredentialConflictField).not.toHaveBeenCalled();
    });
  });

  describe('全字段同值或未提供', () => {
    it('完全不提交任何字段时不落库，返回 isUpdated false 与当前 View', async () => {
      const outcome = await execute({});

      expect(outcome.isUpdated).toBe(false);
      expect(accountService.updateMyAccountCredentials).not.toHaveBeenCalled();
      expect(accountService.updateUserInfoFields).not.toHaveBeenCalled();
      // 回读仍然发生：View 必须是数据库当前事实，而不是凭 isUpdated 伪造
      expect(accountQueryService.findMyAccountSettingsSnapshot).toHaveBeenCalledTimes(1);
      expect(outcome.settings).toEqual({
        loginName: 'self_user',
        loginEmail: 'self@example.com',
        nickname: 'self_nickname',
        realName: '张三',
        companyName: '示例公司',
        trustedCompanyName: '可信公司',
        phone: '13800000000',
        contactEmail: 'contact@example.com',
        role: IdentityTypeEnum.CUSTOMER,
        status: AccountStatus.ACTIVE,
        adminLevel: null,
        updatedAt: UPDATED_AT,
      });
      expect(logger.info).toHaveBeenCalledWith(
        { accountId: ACCOUNT_ID, isUpdated: false, updatedFields: [] },
        expect.any(String),
      );
    });
  });

  describe('同一事务与执行顺序', () => {
    it('锁定、预检查、凭据写入、资料写入与回读共用同一个 transactionContext', async () => {
      await execute({ loginName: 'brand_new_user', nickname: 'renamed' });

      expect(order).toEqual([
        'LOCK',
        'PRECHECK',
        'WRITE_CREDENTIALS',
        'WRITE_PROFILE',
        'READ_BACK',
      ]);
      expect(accountService.lockMyAccountSettingsFacts).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        transactionContext: harness.txContext,
      });
      expect(accountQueryService.findMyAccountCredentialConflictField).toHaveBeenCalledWith(
        expect.objectContaining({ transactionContext: harness.txContext }),
      );
      expect(accountService.updateMyAccountCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ transactionContext: harness.txContext }),
      );
      expect(accountService.updateUserInfoFields).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        patch: { nickname: 'renamed' },
        transactionContext: harness.txContext,
      });
      expect(accountQueryService.findMyAccountSettingsSnapshot).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        transactionContext: harness.txContext,
      });
      expect(organizationQueryService.findOrganizationNameById).toHaveBeenCalledWith({
        organizationId: 11,
        transactionContext: harness.txContext,
      });
      expect(harness.isCommitted()).toBe(true);
      expect(harness.isRolledBack()).toBe(false);
    });

    it('成功日志只含账号主键与协议字段名清单，不含任何字段值', async () => {
      await execute({ loginName: 'brand_new_user', nickname: 'renamed' });

      expect(logger.info).toHaveBeenCalledWith(
        { accountId: ACCOUNT_ID, isUpdated: true, updatedFields: ['loginName', 'nickname'] },
        expect.any(String),
      );
      const logged = JSON.stringify((logger.info as jest.Mock).mock.calls[0][0]);
      expect(logged).not.toContain('renamed');
      expect(logged).not.toContain('brand_new_user');
    });
  });

  describe('原子性与失败关闭', () => {
    it('第二阶段（资料写入）失败时整次事务回滚，凭据写入不残留', async () => {
      (accountService.updateUserInfoFields as jest.Mock).mockRejectedValue(
        Object.assign(new Error('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded'), {
          name: 'QueryFailedError',
          driverError: { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' },
        }),
      );

      const error = await captureThrownError(
        execute({ loginName: 'brand_new_user', nickname: 'renamed' }),
      );

      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.WRITE_FAILED });
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
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

    it('写后回读为空时按读失败关闭并回滚', async () => {
      (accountQueryService.findMyAccountSettingsSnapshot as jest.Mock).mockResolvedValue(null);

      const error = await captureThrownError(execute({ nickname: 'renamed' }));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        cause: { diagnostic: 'UPDATED_SETTINGS_NOT_READABLE', accountId: ACCOUNT_ID },
      });
      expect(harness.isRolledBack()).toBe(true);
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('写后回读未反映本次写入时按写失败关闭并回滚（静默 0 行更新不得伪装成功）', async () => {
      (accountQueryService.findMyAccountSettingsSnapshot as jest.Mock).mockResolvedValue(
        snapshotOf(initialRow()),
      );

      const error = await captureThrownError(execute({ nickname: 'renamed' }));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
        cause: { diagnostic: 'SETTINGS_NOT_REFLECTED_AFTER_WRITE', accountId: ACCOUNT_ID },
      });
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('写后回读未反映 realName 写入时按写失败关闭并回滚', async () => {
      (accountQueryService.findMyAccountSettingsSnapshot as jest.Mock).mockResolvedValue(
        snapshotOf(initialRow()),
      );

      const error = await captureThrownError(execute({ realName: '李四' }));

      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
        cause: { diagnostic: 'SETTINGS_NOT_REFLECTED_AFTER_WRITE', accountId: ACCOUNT_ID },
      });
      expect(harness.isRolledBack()).toBe(true);
      expect(harness.isCommitted()).toBe(false);
    });

    it('回读抛出领域异常（三源角色不收敛）时原样冒泡，不改写错误码', async () => {
      (accountQueryService.findMyAccountSettingsSnapshot as jest.Mock).mockRejectedValue(
        Object.assign(new Error('boom'), {
          name: 'DomainError',
          code: ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT,
          details: undefined,
          cause: { diagnostic: 'ROLE_CONVERGENCE_FAILED' },
        }),
      );

      await expect(execute({ nickname: 'renamed' })).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT,
      });
      expect(harness.isRolledBack()).toBe(true);
    });

    it('事务边界自身失败时收敛为 WRITE_FAILED', async () => {
      harness.runMock.mockRejectedValueOnce(new Error('simulated COMMIT failure'));

      await expect(execute({ nickname: 'renamed' })).rejects.toMatchObject({
        code: ADMIN_USER_ERROR.WRITE_FAILED,
      });
      expect(harness.isCommitted()).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'TRANSACTION_BOUNDARY', accountId: ACCOUNT_ID }),
        expect.any(String),
      );
    });
  });

  describe('公开 View 与只读字段边界', () => {
    it('返回的 View 只含十二个公开字段，不含 accountId 与任何敏感 / 内部字段', async () => {
      const { settings } = await execute({ nickname: 'renamed' });

      expect(Object.keys(settings).sort()).toEqual([
        'adminLevel',
        'companyName',
        'contactEmail',
        'loginEmail',
        'loginName',
        'nickname',
        'phone',
        'realName',
        'role',
        'status',
        'trustedCompanyName',
        'updatedAt',
      ]);
      for (const forbidden of [
        'accountId',
        'loginPassword',
        'password',
        'passwordHash',
        'token',
        'identityHint',
        'accessGroup',
        'metaDigest',
        'userState',
      ]) {
        expect(settings).not.toHaveProperty(forbidden);
      }
    });

    it('资料更新不改写角色、状态与三源角色字段', async () => {
      await execute({
        loginName: 'brand_new_user',
        nickname: 'renamed',
        companyName: null,
        phone: null,
        contactEmail: null,
      });

      const patch = capturedPatch();
      expect(patch).not.toHaveProperty('accessGroup');
      expect(patch).not.toHaveProperty('metaDigest');
      expect(patch).not.toHaveProperty('identityHint');
      expect(patch).not.toHaveProperty('userState');
      expect(patch).not.toHaveProperty('status');
      // 凭据窄写入只接受两列，不可能夹带角色或状态
      expect(Object.keys(capturedCredentialWrite()).sort()).toEqual([
        'accountId',
        'loginEmail',
        'loginName',
        'transactionContext',
      ]);
    });
  });
});
