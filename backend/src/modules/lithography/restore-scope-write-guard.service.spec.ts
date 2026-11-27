// src/modules/lithography/restore-scope-write-guard.service.spec.ts

/**
 * 恢复期写入冻结守卫的定向测试（任务 09 新计划第 04 项）。
 *
 * 守住三条：
 * 1. **口径一致**：被写行落在哪个公司的数据区，就用哪个公司去判定冻结；
 * 2. **不误伤**：行不存在／归属为空 ⇒ 不属于任何公司数据区 ⇒ 不受冻结影响；
 * 3. **父表归属**：AI 会话按工单归属（父表）判定，而不是只看会话自身归属列。
 */
import { RestoreScopeWriteGuardService } from './restore-scope-write-guard.service';

type RepoStub = { findOne: jest.Mock };

function repoStub(row: Record<string, unknown> | null): RepoStub {
  return { findOne: jest.fn().mockResolvedValue(row) };
}

/** 事务上下文替身：守卫只把它透传给冻结闸门（真实加锁在事务内完成） */
const TRANSACTION_CONTEXT = { __brand: 'test-transaction-context' } as never;

function buildGuard(options: {
  request?: Record<string, unknown> | null;
  intake?: Record<string, unknown> | null;
  conversation?: Record<string, unknown> | null;
  analysis?: Record<string, unknown> | null;
  document?: Record<string, unknown> | null;
}) {
  const assertBusinessWritableInTransaction = jest.fn().mockResolvedValue(undefined);
  const service = new RestoreScopeWriteGuardService(
    { assertBusinessWritableInTransaction } as never,
    repoStub(options.request ?? null) as never,
    repoStub(options.intake ?? null) as never,
    repoStub(options.conversation ?? null) as never,
    repoStub(options.analysis ?? null) as never,
    repoStub(options.document ?? null) as never,
  );
  return { service, assertBusinessWritableInTransaction };
}

describe('恢复期写入冻结守卫（任务 09 新计划第 04 项）', () => {
  it('工单数据区：按工单自身归属公司判定', async () => {
    const { service, assertBusinessWritableInTransaction } = buildGuard({
      request: { id: 7, ownerOrganizationId: 4 },
    });
    await service.assertRequestScopeWritable(7, TRANSACTION_CONTEXT);
    expect(assertBusinessWritableInTransaction).toHaveBeenCalledWith({
      organizationId: 4,
      transactionContext: TRANSACTION_CONTEXT,
    });
  });

  it('报修原稿数据区：按服务公司判定（与备份范围口径一致）', async () => {
    const { service, assertBusinessWritableInTransaction } = buildGuard({
      intake: { id: 3, serviceOrganizationId: 5 },
    });
    await service.assertIntakeScopeWritable(3, TRANSACTION_CONTEXT);
    expect(assertBusinessWritableInTransaction).toHaveBeenCalledWith({
      organizationId: 5,
      transactionContext: TRANSACTION_CONTEXT,
    });
  });

  it('AI 会话：按**父表（工单）**归属判定，不只看会话自身归属列', async () => {
    const { service, assertBusinessWritableInTransaction } = buildGuard({
      conversation: { id: 11, ownerOrganizationId: null, requestId: 9 },
      request: { id: 9, ownerOrganizationId: 4 },
    });
    await service.assertConversationScopeWritable(11, TRANSACTION_CONTEXT);
    expect(assertBusinessWritableInTransaction).toHaveBeenCalledWith({
      organizationId: 4,
      transactionContext: TRANSACTION_CONTEXT,
    });
  });

  it('AI 会话未挂接工单：回落到会话自身归属列', async () => {
    const { service, assertBusinessWritableInTransaction } = buildGuard({
      conversation: { id: 11, ownerOrganizationId: 6, requestId: null },
    });
    await service.assertConversationScopeWritable(11, TRANSACTION_CONTEXT);
    expect(assertBusinessWritableInTransaction).toHaveBeenCalledWith({
      organizationId: 6,
      transactionContext: TRANSACTION_CONTEXT,
    });
  });

  it('AI 分析行：按问题 UUID 定位会话后再判定', async () => {
    const { service, assertBusinessWritableInTransaction } = buildGuard({
      analysis: { questionUuid: 'q-1', conversationId: 11 },
      conversation: { id: 11, ownerOrganizationId: null, requestId: 9 },
      request: { id: 9, ownerOrganizationId: 4 },
    });
    await service.assertAnalysisScopeWritable('q-1', TRANSACTION_CONTEXT);
    expect(assertBusinessWritableInTransaction).toHaveBeenCalledWith({
      organizationId: 4,
      transactionContext: TRANSACTION_CONTEXT,
    });
  });

  it('资料数据区：按资料自身归属公司判定', async () => {
    const { service, assertBusinessWritableInTransaction } = buildGuard({
      document: { id: 21, ownerOrganizationId: 5 },
    });
    await service.assertDocumentScopeWritable(21, TRANSACTION_CONTEXT);
    expect(assertBusinessWritableInTransaction).toHaveBeenCalledWith({
      organizationId: 5,
      transactionContext: TRANSACTION_CONTEXT,
    });
  });

  it('行不存在 ⇒ 不属于任何公司数据区 ⇒ 不受冻结影响（不误伤）', async () => {
    const { service, assertBusinessWritableInTransaction } = buildGuard({});
    await service.assertRequestScopeWritable(404, TRANSACTION_CONTEXT);
    await service.assertIntakeScopeWritable(404, TRANSACTION_CONTEXT);
    await service.assertConversationScopeWritable(404, TRANSACTION_CONTEXT);
    await service.assertAnalysisScopeWritable('missing', TRANSACTION_CONTEXT);
    await service.assertDocumentScopeWritable(404, TRANSACTION_CONTEXT);
    for (const call of assertBusinessWritableInTransaction.mock.calls) {
      expect(call[0]).toEqual({ organizationId: null, transactionContext: TRANSACTION_CONTEXT });
    }
  });

  it('归属为空的行不落到任何公司（与备份/恢复范围口径一致）', async () => {
    const { service, assertBusinessWritableInTransaction } = buildGuard({
      request: { id: 7, ownerOrganizationId: null },
    });
    await service.assertRequestScopeWritable(7, TRANSACTION_CONTEXT);
    expect(assertBusinessWritableInTransaction).toHaveBeenCalledWith({
      organizationId: null,
      transactionContext: TRANSACTION_CONTEXT,
    });
  });
});
