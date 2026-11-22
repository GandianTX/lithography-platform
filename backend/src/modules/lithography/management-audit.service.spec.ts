// src/modules/lithography/management-audit.service.spec.ts

/**
 * 管理审计写入服务的单测（S3）。
 *
 * 口径：
 * - 只追加写入**成功事实**；插入失败直接抛错（审计失败不得被吞掉、不得返回成功）；
 * - `detail` 只允许脱敏摘要（重置原因、脱敏登录名），不得写入密码、哈希、Token；
 * - 日志只记录操作类型与主键，**不记录 detail**。
 */

import { PinoLogger } from 'nestjs-pino';

import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { ManagementAuditService } from './management-audit.service';

const build = () => {
  const insert = jest.fn();
  const manager = {
    getRepository: () => ({ insert }),
  };
  const transactionContext = createTypeOrmPersistenceTransactionContext(manager as never);
  const logger = { setContext: jest.fn(), info: jest.fn(), error: jest.fn() };
  const service = new ManagementAuditService(logger as unknown as PinoLogger);

  return { service, insert, logger, transactionContext };
};

describe('管理审计写入服务', () => {
  it('写入成功事实：结果固定 SUCCEEDED、目标为账号，detail 为空时写 null', async () => {
    const { service, insert, transactionContext } = build();

    await service.append({
      actorAccountId: 900101,
      actorAdminLevel: 1,
      organizationId: 4,
      targetAccountId: 900202,
      operation: 'RESET_LEVEL2_CREDENTIAL',
      transactionContext,
    });

    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0] as Record<string, unknown>;

    expect(row).toMatchObject({
      actorAccountId: 900101,
      actorAdminLevel: 1,
      organizationId: 4,
      targetType: 'ACCOUNT',
      targetId: '900202',
      result: 'SUCCEEDED',
      detail: null,
    });
    expect(typeof row.eventId).toBe('string');
    expect(String(row.eventId).length).toBeGreaterThan(0);
  });

  it('detail 只承载脱敏摘要字段，不写入其他内容', async () => {
    const { service, insert, transactionContext } = build();

    await service.append({
      actorAccountId: 900101,
      actorAdminLevel: 2,
      organizationId: 4,
      targetAccountId: 900202,
      operation: 'RESET_LEVEL2_CREDENTIAL',
      transactionContext,
      reason: '用户申请重置',
      loginNameMasked: 'zh***@example.com',
    });

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    const detail = JSON.parse(String(row.detail)) as Record<string, unknown>;

    expect(Object.keys(detail).sort()).toEqual(['loginNameMasked', 'reason']);
    expect(detail.reason).toBe('用户申请重置');
    expect(detail.loginNameMasked).toBe('zh***@example.com');
  });

  it('插入失败直接抛错：审计失败不得被吞掉', async () => {
    const { service, insert, transactionContext } = build();

    insert.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(
      service.append({
        actorAccountId: 900101,
        actorAdminLevel: 1,
        organizationId: 4,
        targetAccountId: 900202,
        operation: 'REISSUE_LEVEL2_CREDENTIAL',
        transactionContext,
      }),
    ).rejects.toThrow('audit insert failed');
  });

  it('日志只记操作类型与主键，不记 detail', async () => {
    const { service, logger, transactionContext } = build();

    await service.append({
      actorAccountId: 900101,
      actorAdminLevel: 1,
      organizationId: 4,
      targetAccountId: 900202,
      operation: 'RESET_LEVEL2_CREDENTIAL',
      transactionContext,
      reason: '用户申请重置',
      loginNameMasked: 'zh***@example.com',
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];

    expect(Object.keys(payload).sort()).toEqual(['operation', 'organizationId', 'targetAccountId']);
    expect(JSON.stringify(payload)).not.toContain('用户申请重置');
  });
});
