// test/utils/special-status-account.ts
//
// R03（特殊账号造数）的共享实现：
// - 占位账号 INSERT、密码 hash UPDATE、user_info INSERT 在同一事务内，任一失败整体回滚；
// - 事务提交后立即登记真实 ID 与最小预期事实，中间不插入其他异步操作；
// - 故障注入只存在于测试侧（可选参数），不向 src 增加生产开关。
//
// 实际规格（auth.e2e-spec）与永久反例（cleanup-faults 子规格）调用同一实现。

import { Gender, UserState } from '@app-types/models/user-info.types';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { AccountService } from '@src/modules/account/base/services/account.service';
import type { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import type { DataSource } from 'typeorm';

import { recordOwnedResource, type OwnedResourceLedger } from './e2e-scoped-cleanup';

export interface SpecialStatusAccountSpec {
  readonly loginName: string;
  readonly loginEmail: string;
  readonly loginPassword: string;
  readonly status: AccountStatus;
  readonly accessGroup: IdentityTypeEnum[];
  readonly identityType: IdentityTypeEnum;
}

/**
 * 测试侧故障注入点（仅反例规格使用）：
 * - beforeInsert / afterInsert：账号 INSERT 前/后；
 * - beforeHashUpdate / afterHashUpdate：密码 hash UPDATE 前/后；
 * - beforeUserInfo / afterUserInfo：user_info INSERT 前/后（提交前）。
 */
export type SpecialStatusAccountFaultPoint =
  | 'beforeInsert'
  | 'afterInsert'
  | 'beforeHashUpdate'
  | 'afterHashUpdate'
  | 'beforeUserInfo'
  | 'afterUserInfo';

export interface SeedSpecialStatusAccountParams {
  readonly dataSource: DataSource;
  readonly account: SpecialStatusAccountSpec;
  readonly ownership: OwnedResourceLedger;
  readonly injectFaultAt?: SpecialStatusAccountFaultPoint;
}

const maybeFault = (
  actual: SpecialStatusAccountFaultPoint | undefined,
  point: SpecialStatusAccountFaultPoint,
): void => {
  if (actual === point) {
    throw new Error(`注入故障：${point}`);
  }
};

export const seedSpecialStatusAccount = async (
  params: SeedSpecialStatusAccountParams,
): Promise<number> => {
  const { dataSource, account, ownership, injectFaultAt } = params;

  const accountId = await dataSource.transaction(async (manager) => {
    const accountRepo = manager.getRepository(AccountEntity);
    const userInfoRepo = manager.getRepository(UserInfoEntity);

    maybeFault(injectFaultAt, 'beforeInsert');
    // 1) 先插入占位账号拿到 createdAt
    const temp = await accountRepo.save(
      accountRepo.create({
        loginName: account.loginName,
        loginEmail: account.loginEmail,
        loginPassword: 'temp',
        status: account.status,
        identityHint: account.identityType,
      }),
    );
    maybeFault(injectFaultAt, 'afterInsert');

    // 2) 根据 createdAt 计算散列并回写
    maybeFault(injectFaultAt, 'beforeHashUpdate');
    const hashed = AccountService.hashPasswordWithTimestamp(account.loginPassword, temp.createdAt);
    await accountRepo.update(temp.id, { loginPassword: hashed });
    maybeFault(injectFaultAt, 'afterHashUpdate');

    // 3) 写 user_info（metaDigest 与 accessGroup 保持一致）
    maybeFault(injectFaultAt, 'beforeUserInfo');
    await userInfoRepo.save(
      userInfoRepo.create({
        accountId: temp.id,
        nickname: `${account.loginName}_nickname`,
        gender: Gender.SECRET,
        email: account.loginEmail,
        accessGroup: account.accessGroup,
        metaDigest: account.accessGroup,
        notifyCount: 0,
        unreadCount: 0,
        userState: UserState.ACTIVE,
      }),
    );
    maybeFault(injectFaultAt, 'afterUserInfo');
    return temp.id;
  });

  // 事务提交后立即登记真实 ID 与预期事实，中间不插入其他异步操作。
  recordOwnedResource(ownership, 'account', accountId, {
    loginName: account.loginName,
    loginEmail: account.loginEmail,
    status: account.status,
    identityHint: account.identityType,
    accessGroup: account.accessGroup,
    nickname: `${account.loginName}_nickname`,
    userInfoEmail: account.loginEmail,
    userState: 'ACTIVE',
  });
  return accountId;
};
