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

function buildGuard(options: {
  request?: Record<string, unknown> | null;
  intake?: Record<string, unknown> | null;
  conversation?: Record<string, unknown> | null;
  analysis?: Record<string, unknown> | null;
  document?: Record<string, unknown> | null;
}) {
  const assertBusinessWritable = jest.fn().mockResolvedValue(undefined);
  const service = new RestoreScopeWriteGuardService(
    { assertBusinessWritable } as never,
    repoStub(options.request ?? null) as never,
    repoStub(options.intake ?? null) as never,
    repoStub(options.conversation ?? null) as never,
    repoStub(options.analysis ?? null) as never,
    repoStub(options.document ?? null) as never,
  );
  return { service, assertBusinessWritable };
}

describe('恢复期写入冻结守卫（任务 09 新计划第 04 项）', () => {
  it('工单数据区：按工单自身归属公司判定', async () => {
    const { service, assertBusinessWritable } = buildGuard({
      request: { id: 7, ownerOrganizationId: 4 },
    });
    await service.assertRequestScopeWritable(7);
    expect(assertBusinessWritable).toHaveBeenCalledWith({ organizationId: 4 });
  });

  it('报修原稿数据区：按服务公司判定（与备份范围口径一致）', async () => {
    const { service, assertBusinessWritable } = buildGuard({
      intake: { id: 3, serviceOrganizationId: 5 },
    });
    await service.assertIntakeScopeWritable(3);
    expect(assertBusinessWritable).toHaveBeenCalledWith({ organizationId: 5 });
  });

  it('AI 会话：按**父表（工单）**归属判定，不只看会话自身归属列', async () => {
    const { service, assertBusinessWritable } = buildGuard({
      conversation: { id: 11, ownerOrganizationId: null, requestId: 9 },
      request: { id: 9, ownerOrganizationId: 4 },
    });
    await service.assertConversationScopeWritable(11);
    expect(assertBusinessWritable).toHaveBeenCalledWith({ organizationId: 4 });
  });

  it('AI 会话未挂接工单：回落到会话自身归属列', async () => {
    const { service, assertBusinessWritable } = buildGuard({
      conversation: { id: 11, ownerOrganizationId: 6, requestId: null },
    });
    await service.assertConversationScopeWritable(11);
    expect(assertBusinessWritable).toHaveBeenCalledWith({ organizationId: 6 });
  });

  it('AI 分析行：按问题 UUID 定位会话后再判定', async () => {
    const { service, assertBusinessWritable } = buildGuard({
      analysis: { questionUuid: 'q-1', conversationId: 11 },
      conversation: { id: 11, ownerOrganizationId: null, requestId: 9 },
      request: { id: 9, ownerOrganizationId: 4 },
    });
    await service.assertAnalysisScopeWritable('q-1');
    expect(assertBusinessWritable).toHaveBeenCalledWith({ organizationId: 4 });
  });

  it('资料数据区：按资料自身归属公司判定', async () => {
    const { service, assertBusinessWritable } = buildGuard({
      document: { id: 21, ownerOrganizationId: 5 },
    });
    await service.assertDocumentScopeWritable(21);
    expect(assertBusinessWritable).toHaveBeenCalledWith({ organizationId: 5 });
  });

  it('行不存在 ⇒ 不属于任何公司数据区 ⇒ 不受冻结影响（不误伤）', async () => {
    const { service, assertBusinessWritable } = buildGuard({});
    await service.assertRequestScopeWritable(404);
    await service.assertIntakeScopeWritable(404);
    await service.assertConversationScopeWritable(404);
    await service.assertAnalysisScopeWritable('missing');
    await service.assertDocumentScopeWritable(404);
    for (const call of assertBusinessWritable.mock.calls) {
      expect(call[0]).toEqual({ organizationId: null });
    }
  });

  it('归属为空的行不落到任何公司（与备份/恢复范围口径一致）', async () => {
    const { service, assertBusinessWritable } = buildGuard({
      request: { id: 7, ownerOrganizationId: null },
    });
    await service.assertRequestScopeWritable(7);
    expect(assertBusinessWritable).toHaveBeenCalledWith({ organizationId: null });
  });
});
