// src/usecases/admin-document-database/list-admin-ai-conversations.usecase.spec.ts

import type { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import { PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminAiConversationQueryService } from '@src/modules/lithography/queries/admin-ai-conversation.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
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

  const accountQueryService = {
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(1),
    findAccountIdsByDisplayKeyword: jest
      .fn()
      .mockResolvedValue({ accountIds: [], totalMatched: 0 }),
    findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[900002, '陈工程师']])),
  } as unknown as AccountQueryService;

  const organizationContextService = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 12 }),
  } as unknown as TrustedOrganizationContextQueryService;

  const usecase = new ListAdminAiConversationsUsecase(
    adminAiConversationQueryService,
    accountQueryService,
    organizationContextService,
  );

  beforeEach(() => {
    (adminAiConversationQueryService.listAll as jest.Mock).mockClear();
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockClear().mockResolvedValue(1);
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
    },
  );

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

  it('一级管理员全范围，二级管理员按可信组织下推会话范围', async () => {
    await usecase.execute({ session: createSuperAdminSession(), pagination: offsetPagination() });
    const level1Call = (adminAiConversationQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(level1Call.filter.ownerOrganizationId).toBeUndefined();

    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockResolvedValue(2);
    await usecase.execute({ session: createSuperAdminSession(), pagination: offsetPagination() });
    const level2Call = (adminAiConversationQueryService.listAll as jest.Mock).mock.calls[1][0];
    expect(level2Call.filter.ownerOrganizationId).toBe(12);
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
