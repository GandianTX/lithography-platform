// src/modules/account/queries/account.query.service.admin-level.spec.ts

/// <reference types="jest" />
import { ACCOUNT_ERROR } from '@core/common/errors/domain-error';
import type { Repository } from 'typeorm';
import { AccountEntity } from '../base/entities/account.entity';
import { UserInfoEntity } from '../base/entities/user-info.entity';
import { AccountQueryService } from './account.query.service';

/**
 * `AccountQueryService.findAdminLevelByAccountId()` 的读取与失败关闭口径。
 *
 * 「账号行缺失」与「账号存在但 admin_level 为 null」必须可区分：
 * - 行缺失 → 抛 `ACCOUNT_NOT_FOUND`，不把不存在的账号当成未映射等级；
 * - 等级为 null → 原样返回 null，由调用方按
 *   `docs/database/v13-deployment/data-contracts.md` §5/§6.1 失败关闭，不按 1 级放行。
 */
describe('AccountQueryService.findAdminLevelByAccountId', () => {
  const accountRepository = {
    findOne: jest.fn(),
  } as unknown as Repository<AccountEntity>;
  const userInfoRepository = {
    findOne: jest.fn(),
  } as unknown as Repository<UserInfoEntity>;
  const service = new AccountQueryService(accountRepository, userInfoRepository);

  const givenAccountRow = (row: { id: number; adminLevel: number | null } | null): void => {
    (accountRepository.findOne as jest.Mock).mockResolvedValue(row);
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('按账号主键只读取 id 与 adminLevel 窄投影', async () => {
    givenAccountRow({ id: 7, adminLevel: 2 });

    await expect(service.findAdminLevelByAccountId(7)).resolves.toBe(2);
    expect(accountRepository.findOne).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { id: true, adminLevel: true },
    });
  });

  it('账号存在但等级为 null：返回 null，不伪造为一级', async () => {
    givenAccountRow({ id: 7, adminLevel: null });

    await expect(service.findAdminLevelByAccountId(7)).resolves.toBeNull();
  });

  it('账号行缺失：抛 ACCOUNT_NOT_FOUND，与「等级为 null」区分', async () => {
    givenAccountRow(null);

    await expect(service.findAdminLevelByAccountId(7)).rejects.toMatchObject({
      code: ACCOUNT_ERROR.ACCOUNT_NOT_FOUND,
    });
  });
});
