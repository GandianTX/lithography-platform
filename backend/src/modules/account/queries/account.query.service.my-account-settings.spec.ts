// src/modules/account/queries/account.query.service.my-account-settings.spec.ts

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { ADMIN_USER_ERROR, DomainError } from '@core/common/errors/domain-error';
import type { Repository } from 'typeorm';
import { AccountEntity } from '../base/entities/account.entity';
import { UserInfoEntity } from '../base/entities/user-info.entity';
import { AccountQueryService } from './account.query.service';

/**
 * P1：`AccountQueryService.findMyAccountSettingsSnapshot()` 的读取路径、稳定映射与失败关闭。
 *
 * 本文件核实的是**自助设置只读链路的数据不变量**（授权与协议映射不在此）：
 * 1. 走 entity 水合路径（`findOne` + `relations.userInfo`），不走 `getRawMany` / `query`——
 *    `meta_digest` 是加密列，只有水合路径才会被订阅者解密回数组；
 * 2. 三源角色收敛出唯一只读角色；账号/资料双状态一致时 `status` 取账号真实状态；
 * 3. 资料行缺失 / 三源不收敛 / 双状态不一致都失败关闭，`details` 一律留空，定位信息只进 `cause`；
 * 4. 快照逐字段显式产出，不含密码哈希、`metaDigest`、`userState`、`identityHint` 或 ORM Entity 引用；
 * 5. 账号行缺失返回 `null`（错误口径归 Usecase）。
 */
describe('AccountQueryService.findMyAccountSettingsSnapshot', () => {
  const ACCOUNT_ID = 7;

  /** 加密列解密失败时 `decryptEntity()` 会保留密文字符串，用它构造 NOT_ARRAY 失败 */
  const CIPHER_TEXT = 'enc:v1:9f2c7a41b8e0d3c5';

  const buildUserInfo = (overrides: Record<string, unknown> = {}): UserInfoEntity =>
    ({
      accountId: ACCOUNT_ID,
      nickname: 'self_nickname',
      realName: '张三',
      companyName: '示例公司',
      phone: '13800000000',
      email: 'contact@example.com',
      accessGroup: [IdentityTypeEnum.CUSTOMER],
      metaDigest: [IdentityTypeEnum.CUSTOMER],
      userState: UserState.ACTIVE,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    }) as unknown as UserInfoEntity;

  const buildAccount = (overrides: Record<string, unknown> = {}): AccountEntity =>
    ({
      id: ACCOUNT_ID,
      loginName: 'self_user',
      loginEmail: 'self@example.com',
      // 刻意放一个明显的凭据派生物：任何快照出现它都属泄露
      loginPassword: 'pbkdf2$stored-hash$should-never-leak',
      identityHint: IdentityTypeEnum.CUSTOMER,
      status: AccountStatus.ACTIVE,
      adminLevel: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      userInfo: buildUserInfo(),
      ...overrides,
    }) as unknown as AccountEntity;

  const accountRepository = {
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
    query: jest.fn(),
  } as unknown as Repository<AccountEntity>;

  const userInfoRepository = {
    findOne: jest.fn(),
  } as unknown as Repository<UserInfoEntity>;

  const service = new AccountQueryService(accountRepository, userInfoRepository);

  const givenAccount = (account: AccountEntity | null): void => {
    (accountRepository.findOne as jest.Mock).mockResolvedValue(account);
  };

  const readSnapshot = () => service.findMyAccountSettingsSnapshot({ accountId: ACCOUNT_ID });

  const captureThrown = async (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('预期抛出 DomainError，但调用成功了');
      },
      (error: unknown) => error,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    (accountRepository.findOne as jest.Mock).mockReset();
    (accountRepository.createQueryBuilder as jest.Mock).mockReset();
    (accountRepository.query as jest.Mock).mockReset();
    givenAccount(buildAccount());
  });

  describe('读取路径', () => {
    it('以 findOne + relations.userInfo 走 entity 水合路径，不走 getRawMany/query', async () => {
      await readSnapshot();

      expect(accountRepository.findOne).toHaveBeenCalledWith({
        where: { id: ACCOUNT_ID },
        relations: { userInfo: true },
      });
      expect(accountRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(accountRepository.query).not.toHaveBeenCalled();
    });

    it('账号行缺失返回 null（错误口径归 Usecase）', async () => {
      givenAccount(null);
      await expect(readSnapshot()).resolves.toBeNull();
    });
  });

  describe('稳定映射', () => {
    it('三源收敛出唯一只读角色，字段按口径映射', async () => {
      givenAccount(
        buildAccount({
          identityHint: IdentityTypeEnum.ENGINEER,
          userInfo: buildUserInfo({
            accessGroup: [IdentityTypeEnum.ENGINEER],
            metaDigest: [IdentityTypeEnum.ENGINEER],
            userState: UserState.ACTIVE,
          }),
          status: AccountStatus.ACTIVE,
        }),
      );

      const snapshot = await readSnapshot();
      expect(snapshot).toEqual({
        accountId: ACCOUNT_ID,
        loginName: 'self_user',
        loginEmail: 'self@example.com',
        nickname: 'self_nickname',
        realName: '张三',
        companyName: '示例公司',
        phone: '13800000000',
        contactEmail: 'contact@example.com',
        role: IdentityTypeEnum.ENGINEER,
        status: AccountStatus.ACTIVE,
        adminLevel: null,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    });

    it('contactEmail 取资料侧 email，与登录凭据 loginEmail 严格区分', async () => {
      givenAccount(
        buildAccount({
          loginEmail: 'login.credential@example.com',
          userInfo: buildUserInfo({ email: 'contact.only@example.com' }),
        }),
      );

      const snapshot = await readSnapshot();
      expect(snapshot?.loginEmail).toBe('login.credential@example.com');
      expect(snapshot?.contactEmail).toBe('contact.only@example.com');
    });

    it('updatedAt 取账号侧与资料侧较新值', async () => {
      const accountUpdatedAt = new Date('2026-01-01T00:00:00.000Z');
      const userInfoUpdatedAt = new Date('2026-02-01T00:00:00.000Z');

      givenAccount(
        buildAccount({
          updatedAt: accountUpdatedAt,
          userInfo: buildUserInfo({ updatedAt: userInfoUpdatedAt }),
        }),
      );
      expect((await readSnapshot())?.updatedAt).toEqual(userInfoUpdatedAt);

      givenAccount(
        buildAccount({
          updatedAt: userInfoUpdatedAt,
          userInfo: buildUserInfo({ updatedAt: accountUpdatedAt }),
        }),
      );
      expect((await readSnapshot())?.updatedAt).toEqual(userInfoUpdatedAt);
    });

    it('快照不含密码哈希、metaDigest、userState、identityHint 或 ORM Entity 引用', async () => {
      const account = buildAccount();
      givenAccount(account);

      const snapshot = await readSnapshot();
      expect(Object.keys(snapshot as object).sort()).toEqual([
        'accountId',
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
        'updatedAt',
      ]);
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain('should-never-leak');
      expect(serialized).not.toContain('loginPassword');
      expect(serialized).not.toContain('metaDigest');
      expect(serialized).not.toContain('userState');
      expect(serialized).not.toContain('identityHint');
      expect(snapshot).not.toBe(account);
    });
  });

  describe('失败关闭', () => {
    it('资料行缺失失败关闭为 READ_FAILED，details 留空、accountId 只进 cause', async () => {
      givenAccount(buildAccount({ userInfo: undefined }));

      const error = await captureThrown(readSnapshot());
      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        details: undefined,
        cause: { diagnostic: 'USER_INFO_ROW_MISSING', accountId: ACCOUNT_ID },
      });
      expect(JSON.stringify((error as DomainError).toJSON())).not.toContain(String(ACCOUNT_ID));
    });

    it('三源不能收敛失败关闭为 ROLE_DATA_INCONSISTENT，三源原值只进 cause', async () => {
      givenAccount(
        buildAccount({
          identityHint: IdentityTypeEnum.ENGINEER,
          userInfo: buildUserInfo({
            accessGroup: [IdentityTypeEnum.ENGINEER, IdentityTypeEnum.CUSTOMER],
            metaDigest: [IdentityTypeEnum.ENGINEER],
          }),
        }),
      );

      const error = await captureThrown(readSnapshot());
      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT,
        details: undefined,
        cause: {
          diagnostic: 'ROLE_CONVERGENCE_FAILED',
          accountId: ACCOUNT_ID,
          reason: 'ACCESS_GROUP_MULTI_ROLE',
        },
      });
      const serializedForClient = JSON.stringify((error as DomainError).toJSON());
      expect(serializedForClient).not.toContain('ACCESS_GROUP_MULTI_ROLE');
      expect(serializedForClient).not.toContain(CIPHER_TEXT);
    });

    it('access_group 为密文字符串（解密失败）时失败关闭', async () => {
      givenAccount(
        buildAccount({
          userInfo: buildUserInfo({ accessGroup: CIPHER_TEXT, metaDigest: CIPHER_TEXT }),
        }),
      );

      const error = await captureThrown(readSnapshot());
      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT,
        cause: { diagnostic: 'ROLE_CONVERGENCE_FAILED', reason: 'ACCESS_GROUP_NOT_ARRAY' },
      });
    });

    it('账号与资料双状态不一致失败关闭为 READ_FAILED', async () => {
      givenAccount(
        buildAccount({
          status: AccountStatus.ACTIVE,
          userInfo: buildUserInfo({ userState: UserState.INACTIVE }),
        }),
      );

      const error = await captureThrown(readSnapshot());
      expect(error).toMatchObject({
        code: ADMIN_USER_ERROR.READ_FAILED,
        details: undefined,
        cause: { diagnostic: 'STATUS_DUAL_FIELDS_INCONSISTENT', accountId: ACCOUNT_ID },
      });
    });

    it('底层驱动异常收敛为 READ_FAILED，原始异常只以 cause 保留', async () => {
      const driverError = new Error('connect ECONNREFUSED');
      (accountRepository.findOne as jest.Mock).mockRejectedValue(driverError);

      const error = await captureThrown(readSnapshot());
      expect(error).toMatchObject({ code: ADMIN_USER_ERROR.READ_FAILED, details: undefined });
      expect((error as DomainError).cause).toBe(driverError);
    });
  });
});
