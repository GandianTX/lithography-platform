// test/utils/test-accounts.ts
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { Gender, UserState } from '@app-types/models/user-info.types';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import { CreateAccountUsecase } from '@usecases/account/create-account.usecase';
import { DataSource } from 'typeorm';
import { recordOwnedResource, type OwnedResourceLedger } from './e2e-scoped-cleanup';

export interface TestAccountConfig {
  loginName: string;
  loginEmail: string;
  loginPassword: string;
  status: AccountStatus;
  accessGroup: IdentityTypeEnum[];
  identityType: IdentityTypeEnum;
}

export const testAccountsConfig = {
  staff: {
    loginName: 'teststaff',
    loginEmail: 'staff@example.com',
    loginPassword: 'testStaff@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.ENGINEER],
    identityType: IdentityTypeEnum.ENGINEER,
  },
  staffPrimary: {
    loginName: 'teststaffprimary',
    loginEmail: 'staff.primary@example.com',
    loginPassword: 'testStaffPrimary@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.ENGINEER],
    identityType: IdentityTypeEnum.ENGINEER,
  },
  staffSecondary: {
    loginName: 'teststaffsecondary',
    loginEmail: 'staff.secondary@example.com',
    loginPassword: 'testStaffSecondary@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.ENGINEER],
    identityType: IdentityTypeEnum.ENGINEER,
  },
  admin: {
    loginName: 'testadmin',
    loginEmail: 'admin@example.com',
    loginPassword: 'testAdmin@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.SUPER_ADMIN],
    identityType: IdentityTypeEnum.SUPER_ADMIN,
  },
  guestPrimary: {
    loginName: 'testguestprimary',
    loginEmail: 'guest.primary@example.com',
    loginPassword: 'testGuestPrimary@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.CUSTOMER,
  },
  guestSecondary: {
    loginName: 'testguestsecondary',
    loginEmail: 'guest.secondary@example.com',
    loginPassword: 'testGuestSecondary@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.CUSTOMER,
  },
  guest: {
    loginName: 'testguest',
    loginEmail: 'guest@example.com',
    loginPassword: 'testGuest@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.CUSTOMER,
  },
  emptyRoles: {
    loginName: 'testempty',
    loginEmail: 'empty@example.com',
    loginPassword: 'testEmpty@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [], // 空数组，符合测试期望
    identityType: IdentityTypeEnum.CUSTOMER,
  },
  staffGuest: {
    loginName: 'teststaffguest',
    loginEmail: 'staff.guest@example.com',
    loginPassword: 'testStaffGuest@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.ENGINEER, IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.ENGINEER,
  },
  /** 混合角色账号：接单 activeRole 精确准入 E2E 用（切换 identityHint 分别签发不同 Token） */
  hybridStaff: {
    loginName: 'testhybridstaff',
    loginEmail: 'hybrid.staff@example.com',
    loginPassword: 'testHybridStaff@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
    identityType: IdentityTypeEnum.ENGINEER,
  },
  /** 第二组织管理员：组织范围用例（参考资料组织隔离）构造对侧管理员身份 */
  peerAdmin: {
    loginName: 'testpeeradmin',
    loginEmail: 'peer.admin@example.com',
    loginPassword: 'testPeerAdmin@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.SUPER_ADMIN],
    identityType: IdentityTypeEnum.SUPER_ADMIN,
  },
  /** 无有效组织成员关系的工程师：组织解析拒绝用例（不建成员关系） */
  noOrgEngineer: {
    loginName: 'testnoorgengineer',
    loginEmail: 'no.org.engineer@example.com',
    loginPassword: 'testNoOrgEngineer@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.ENGINEER],
    identityType: IdentityTypeEnum.ENGINEER,
  },
  /** 多有效组织成员关系的工程师：组织歧义拒绝用例（两个组织都建 ACTIVE 成员） */
  ambiguousEngineer: {
    loginName: 'testambiguousengineer',
    loginEmail: 'ambiguous.engineer@example.com',
    loginPassword: 'testAmbiguousEngineer@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.ENGINEER],
    identityType: IdentityTypeEnum.ENGINEER,
  },
} satisfies Record<string, TestAccountConfig>;

export type TestAccountKey = keyof typeof testAccountsConfig;

/**
 * 清理所有与测试账号相关的数据（整表删除，历史遗留用法）。
 *
 * ⚠️ PR0 独立终审 R02：本函数不携带归属 WHERE，会删除全库成员/账号，
 * 只保留给尚未迁移的历史规格；04/09/10/11/12 等本 PR 消费者必须改用
 * `runGuardedSpecCleanup`（双门禁 + 指纹核验 + 引用闭包 + 精确 ID）。
 *
 * （按外键方向：先成员关系 → user_info → account；
 *   A-PR0 新增外键 fk_organization_membership_account RESTRICT 要求
 *   先删组织成员关系，否则账号删除被阻塞）
 */
export const cleanupTestAccounts = async (dataSource: DataSource): Promise<void> => {
  await dataSource.createQueryBuilder().delete().from(OrganizationMembershipEntity).execute();
  await dataSource.createQueryBuilder().delete().from(UserInfoEntity).execute();
  await dataSource.createQueryBuilder().delete().from(AccountEntity).execute();
};

/**
 * 造数入口（优先用 Usecase；无 Usecase 时走 repo 回落）
 * - 不写 metaDigest，交由系统内部一致性逻辑生成
 * - 只创建通用账号与 user_info，不创建业务身份 profile
 * - `ownership` 存在时登记数据库真实账号 ID，供本轮精确清理
 */
export const seedTestAccounts = async (opts: {
  dataSource: DataSource;
  createAccountUsecase?: CreateAccountUsecase | null;
  // 可选：显式指定要创建哪些 key，不传则全量
  includeKeys?: TestAccountKey[];
  ownership?: OwnedResourceLedger;
}): Promise<void> => {
  const { dataSource, createAccountUsecase, includeKeys, ownership } = opts;
  const list = includeKeys ?? (Object.keys(testAccountsConfig) as TestAccountKey[]);

  // 全部造数必须先收敛再退出：一项失败时其他账号可能仍在途，
  // 若提前抛出，afterAll/closeApp 之后仍会有写库操作。
  const results = await Promise.allSettled(
    list.map((key) =>
      createTestAccount(
        dataSource,
        createAccountUsecase || null,
        testAccountsConfig[key],
        ownership,
      ),
    ),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failed) {
    throw failed.reason;
  }
};

/**
 * 创建单个账号的核心逻辑（可被复用）
 *
 * - 供 `seedTestAccounts` 与各 spec 专属夹具（如 PR3 R5 production fixture）共用；
 * - 只创建账号与 user_info，不创建业务身份 profile；
 * - 不做任何清理/删除动作（调用方负责精确回收自己创建的账号）。
 *
 * @returns 创建的账号ID
 */
export const createTestAccount = async (
  dataSource: DataSource,
  createAccountUsecase: CreateAccountUsecase | null,
  cfg: TestAccountConfig,
  ownership?: OwnedResourceLedger,
): Promise<{ accountId: number }> => {
  if (createAccountUsecase) {
    const created = await createAccountUsecase.execute({
      accountData: {
        loginName: cfg.loginName,
        loginEmail: cfg.loginEmail,
        loginPassword: cfg.loginPassword,
        status: cfg.status,
        identityHint: cfg.identityType,
      },
      userInfoData: {
        nickname: `${cfg.loginName}_nickname`,
        gender: Gender.SECRET,
        birthDate: null,
        avatarUrl: null,
        email: cfg.loginEmail,
        signature: null,
        accessGroup: cfg.accessGroup,
        address: null,
        phone: null,
        tags: null,
        geographic: null,
        metaDigest: cfg.accessGroup,
        notifyCount: 0,
        unreadCount: 0,
        userState: UserState.ACTIVE,
      },
    });
    const accountId = created.id;
    if (ownership) {
      recordOwnedResource(ownership, 'account', accountId);
    }
    return { accountId };
  }

  // 回落路径：不依赖 Usecase（直接 repo）。
  // 账号、密码回写、user_info 必须在同一事务内，任一阶段失败整体回滚，
  // 避免中途失败留下无法按完整指纹回收的半账号。
  const accountId = await dataSource.transaction(async (manager) => {
    const accountRepo = manager.getRepository(AccountEntity);
    const userInfoRepo = manager.getRepository(UserInfoEntity);

    // 1) 先插入占位账号，拿到 createdAt
    const temp = await accountRepo.save(
      accountRepo.create({
        loginName: cfg.loginName,
        loginEmail: cfg.loginEmail,
        loginPassword: 'temp', // 占位
        status: cfg.status,
        identityHint: cfg.identityType,
      }),
    );
    // 2) 根据 createdAt 计算散列并回写
    const hashed = AccountService.hashPasswordWithTimestamp(cfg.loginPassword, temp.createdAt);
    await accountRepo.update(temp.id, { loginPassword: hashed });

    // 3) 写 user_info（设置 metaDigest 与 accessGroup 保持一致）
    await userInfoRepo.save(
      userInfoRepo.create({
        accountId: temp.id,
        nickname: `${cfg.loginName}_nickname`,
        gender: Gender.SECRET,
        email: cfg.loginEmail,
        accessGroup: cfg.accessGroup,
        // ✅ 设置 metaDigest 与 accessGroup 保持一致，避免安全检查失败
        metaDigest: cfg.accessGroup,
        notifyCount: 0,
        unreadCount: 0,
        userState: UserState.ACTIVE,
      }),
    );

    return temp.id;
  });

  // 事务提交成功即登记，不把登记推迟到调用方完整返回之后。
  if (ownership) {
    recordOwnedResource(ownership, 'account', accountId);
  }
  return { accountId };
};
