// src/usecases/admin-document-database/list-admin-ai-conversations.usecase.spec.ts

import type { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import {
  DomainError,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminAiConversationQueryService } from '@src/modules/lithography/queries/admin-ai-conversation.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { createAdminDocumentDatabaseAccessMocks } from '../../../test/support/account/admin-document-database-access.fixture';
import {
  captureThrownError,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { ListAdminAiConversationsUsecase } from './list-admin-ai-conversations.usecase';

/**
 * PR3 S4：管理员全局 AI 会话列表用例单测。
 *
 * 会话消息数/报告数来自真实聚合统计（不伪造）；engineerKeyword 与维修申请
 * customerKeyword 同口径：超限显式拒绝、无命中短路，排序由契约固定。
 */
describe('ListAdminAiConversationsUsecase', () => {
  const offsetPagination = (overrides: Partial<OffsetParams> = {}): PaginationParams => ({
    mode: 'OFFSET' as const,
    page: 1,
    pageSize: 10,
    withTotal: true,
    ...overrides,
  });

  const adminAiConversationQueryService = {
    listAll: jest.fn().mockResolvedValue({
      items: [
        {
          id: 660001,
          requestId: 880001,
          requestNo: 'RR-20260901-001',
          engineerAccountId: 900002,
          status: 'COMPLETED',
          aiFeedback: null,
          createdAt: new Date('2026-09-02T09:00:00.000Z'),
          completedAt: null,
          messageCount: 12,
          reportCount: 1,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    }),
  } as unknown as AdminAiConversationQueryService;

  const access = createAdminDocumentDatabaseAccessMocks();

  const accountQueryService = {
    findAdminLevelByAccountId: access.findAdminLevelByAccountId,
    findAccountIdsByDisplayKeyword: jest
      .fn()
      .mockResolvedValue({ accountIds: [], totalMatched: 0 }),
    findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[900002, '陈工程师']])),
  } as unknown as AccountQueryService;

  const organizationContextService = {
    resolveForAccount: access.resolveForAccount,
  } as unknown as TrustedOrganizationContextQueryService;

  const usecase = new ListAdminAiConversationsUsecase(
    adminAiConversationQueryService,
    accountQueryService,
    organizationContextService,
  );

  beforeEach(() => {
    access.setAdminLevel(1);
    access.setMembershipError(null);
    access.findAdminLevelByAccountId.mockClear();
    (adminAiConversationQueryService.listAll as jest.Mock).mockClear();
    (accountQueryService.findAccountIdsByDisplayKeyword as jest.Mock)
      .mockClear()
      .mockResolvedValue({ accountIds: [], totalMatched: 0 });
    (accountQueryService.findNicknamesByAccountIds as jest.Mock)
      .mockClear()
      .mockResolvedValue(new Map([[900002, '陈工程师']]));
  });

  it.each(createUnauthorizedSessions().map(([label, session]) => ({ label, session })))(
    '$label 时授权先行拒绝，不触发任何查询',
    async ({ session }) => {
      const error = (await captureThrownError(
        usecase.execute({ session, pagination: offsetPagination() }),
      )) as { code?: string };

      expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
      expect(adminAiConversationQueryService.listAll).not.toHaveBeenCalled();
      expect(access.findAdminLevelByAccountId).not.toHaveBeenCalled();
      expect(access.resolveForAccount).not.toHaveBeenCalled();
    },
  );

  it.each([2, null])('当前等级 %j 时失败关闭，本域与账户域零读取', async (level) => {
    access.setAdminLevel(level);

    const error = (await captureThrownError(
      usecase.execute({ session: createSuperAdminSession(), pagination: offsetPagination() }),
    )) as { code?: string; message?: string };

    expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    expect(error.message).toContain('仅一级管理员可以查看 AI 会话数据库');
    expect(adminAiConversationQueryService.listAll).not.toHaveBeenCalled();
    expect(accountQueryService.findAccountIdsByDisplayKeyword).not.toHaveBeenCalled();
    expect(accountQueryService.findNicknamesByAccountIds).not.toHaveBeenCalled();
    expect(access.resolveForAccount).not.toHaveBeenCalled();
  });

  it('可信成员事实缺失时失败关闭，不返回任何会话数据', async () => {
    access.setMembershipError(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'),
    );

    const error = (await captureThrownError(
      usecase.execute({ session: createSuperAdminSession(), pagination: offsetPagination() }),
    )) as { code?: string };

    expect(error.code).toBe(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP);
    expect(adminAiConversationQueryService.listAll).not.toHaveBeenCalled();
    expect(accountQueryService.findNicknamesByAccountIds).not.toHaveBeenCalled();
  });

  it('engineerKeyword 无命中短路返回空页；命中时进 SQL 筛选并批量富集', async () => {
    const empty = await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
      filter: { engineerKeyword: '不存在' },
    });
    expect(empty).toMatchObject({ items: [], total: 0 });
    expect(adminAiConversationQueryService.listAll).not.toHaveBeenCalled();

    (accountQueryService.findAccountIdsByDisplayKeyword as jest.Mock).mockResolvedValue({
      accountIds: [900002],
      totalMatched: 1,
    });
    const page = await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
      filter: { engineerKeyword: '陈' },
    });
    const call = (adminAiConversationQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(call.filter.engineerAccountIds).toEqual([900002]);
    expect(page.items[0].engineerNickname).toBe('陈工程师');
    expect(accountQueryService.findNicknamesByAccountIds).toHaveBeenCalledTimes(1);
    expect(page.items[0]).not.toHaveProperty('engineerAccountId');
  });

  it('时间范围非法（from 晚于 to）在查询前拒绝', async () => {
    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession(),
        pagination: offsetPagination(),
        filter: {
          createdAtFrom: new Date('2026-09-30'),
          createdAtTo: new Date('2026-09-01'),
        },
      }),
    )) as { code?: string };

    expect(error.code).toBe('ADMIN_DOCUMENT_DATABASE_INVALID_PARAMS');
    expect(adminAiConversationQueryService.listAll).not.toHaveBeenCalled();
  });
});
