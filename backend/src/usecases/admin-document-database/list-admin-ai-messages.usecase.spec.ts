// src/usecases/admin-document-database/list-admin-ai-messages.usecase.spec.ts

import type { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import {
  AI_CONVERSATION_ERROR,
  DomainError,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminAiConversationQueryService } from '@src/modules/lithography/queries/admin-ai-conversation.query.service';
import type { AdminAiMessageQueryService } from '@src/modules/lithography/queries/admin-ai-message.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { createAdminDocumentDatabaseAccessMocks } from '../../../test/support/account/admin-document-database-access.fixture';
import {
  ADMIN_ORGANIZATION_ID,
  captureThrownError,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { ListAdminAiMessagesUsecase } from './list-admin-ai-messages.usecase';

/**
 * PR3 S4：管理员按会话读取 AI 消息列表用例单测。
 *
 * 计划表 S4.2：消息顺序契约（messageSeq ASC, id ASC）由 QueryService 冻结，
 * 用例层只透传分页；页大小钳制 100 与「100 轮会话一次读取」语义对齐。
 */
describe('ListAdminAiMessagesUsecase', () => {
  const offsetPagination = (overrides: Partial<OffsetParams> = {}): PaginationParams => ({
    mode: 'OFFSET' as const,
    page: 1,
    pageSize: 50,
    withTotal: true,
    ...overrides,
  });

  const adminAiMessageQueryService = {
    listByConversation: jest.fn().mockResolvedValue({
      items: [
        {
          id: 770001,
          conversationId: 660001,
          messageSeq: 1,
          turnNo: 1,
          role: 'USER',
          contentText: '正文',
          contentVersion: 1,
          analysisStatus: null,
          failureReason: null,
          createdAt: new Date('2026-09-02T09:00:00.000Z'),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    }),
  } as unknown as AdminAiMessageQueryService;

  const access = createAdminDocumentDatabaseAccessMocks();

  const accountQueryService = {
    findAdminLevelByAccountId: access.findAdminLevelByAccountId,
  } as unknown as AccountQueryService;

  const organizationContextService = {
    resolveForAccount: access.resolveForAccount,
    tryResolveForAccount: access.tryResolveForAccount,
  } as unknown as TrustedOrganizationContextQueryService;

  const adminAiConversationQueryService = {
    findOwnershipFacts: jest.fn().mockResolvedValue({
      ownerAccountId: 880001,
      ownerOrganizationId: ADMIN_ORGANIZATION_ID,
    }),
  } as unknown as AdminAiConversationQueryService;

  const usecase = new ListAdminAiMessagesUsecase(
    adminAiMessageQueryService,
    adminAiConversationQueryService,
    accountQueryService,
    organizationContextService,
  );

  beforeEach(() => {
    access.setAdminLevel(1);
    access.setMembershipError(null);
    access.setMemberRole('SUPER_ADMIN');
    access.findAdminLevelByAccountId.mockClear();
    access.tryResolveForAccount.mockClear();
    (adminAiMessageQueryService.listByConversation as jest.Mock).mockClear();
    (adminAiConversationQueryService.findOwnershipFacts as jest.Mock).mockClear();
    (adminAiConversationQueryService.findOwnershipFacts as jest.Mock).mockResolvedValue({
      ownerAccountId: 880001,
      ownerOrganizationId: ADMIN_ORGANIZATION_ID,
    });
  });

  it.each(createUnauthorizedSessions().map(([label, session]) => ({ label, session })))(
    '$label 时授权先行拒绝，不触发消息查询',
    async ({ session }) => {
      const error = (await captureThrownError(
        usecase.execute({
          session,
          conversationId: 660001,
          pagination: offsetPagination(),
        }),
      )) as { code?: string };

      expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
      expect(adminAiMessageQueryService.listByConversation).not.toHaveBeenCalled();
      expect(access.findAdminLevelByAccountId).not.toHaveBeenCalled();
      expect(access.tryResolveForAccount).not.toHaveBeenCalled();
    },
  );

  it('等级缺失或非法时失败关闭，不触发消息查询', async () => {
    access.setAdminLevel(null);

    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession(),
        conversationId: 660001,
        pagination: offsetPagination(),
      }),
    )) as { code?: string; message?: string };

    expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    expect(adminAiMessageQueryService.listByConversation).not.toHaveBeenCalled();
  });

  it('二级管理员按本公司范围放行（一级跨公司之外的受控扩展）', async () => {
    access.setAdminLevel(2);

    await usecase.execute({
      session: createSuperAdminSession(),
      conversationId: 660001,
      pagination: offsetPagination(),
    });

    expect(adminAiMessageQueryService.listByConversation).toHaveBeenCalled();
  });

  it('二级管理员直传外公司会话 ID 时拒绝，不返回外公司消息', async () => {
    access.setAdminLevel(2);
    (adminAiConversationQueryService.findOwnershipFacts as jest.Mock).mockResolvedValue({
      ownerAccountId: 880002,
      ownerOrganizationId: 990002,
    });

    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession(),
        conversationId: 660001,
        pagination: offsetPagination(),
      }),
    )) as { code?: string };

    expect(error.code).toBe(AI_CONVERSATION_ERROR.NOT_FOUND);
    expect(adminAiMessageQueryService.listByConversation).not.toHaveBeenCalled();
  });

  it('可信成员事实缺失时失败关闭，不触发消息查询', async () => {
    access.setMembershipError(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'),
    );

    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession(),
        conversationId: 660001,
        pagination: offsetPagination(),
      }),
    )) as { code?: string };

    expect(error.code).toBe(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP);
    expect(adminAiMessageQueryService.listByConversation).not.toHaveBeenCalled();
  });

  it('成员角色不是组织管理员时失败关闭（账号等级不能单独授予公司范围）', async () => {
    access.setMemberRole('ENGINEER');

    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession(),
        conversationId: 660001,
        pagination: offsetPagination(),
      }),
    )) as { code?: string };

    expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    expect(adminAiMessageQueryService.listByConversation).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN])('会话 ID %j 非法时在查询前拒绝', async (conversationId) => {
    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession(),
        conversationId,
        pagination: offsetPagination(),
      }),
    )) as { code?: string };

    expect(error.code).toBe('ADMIN_DOCUMENT_DATABASE_INVALID_PARAMS');
    expect(adminAiMessageQueryService.listByConversation).not.toHaveBeenCalled();
  });

  it('conversationId 与分页透传（排序由 QueryService 冻结，不采纳客户端排序）', async () => {
    await usecase.execute({
      session: createSuperAdminSession(),
      conversationId: 660001,
      pagination: offsetPagination({ page: 2 }),
    });

    expect(adminAiMessageQueryService.listByConversation).toHaveBeenCalledWith({
      conversationId: 660001,
      pagination: { page: 2, pageSize: 50, withTotal: true },
    });
  });

  it('页大小钳制 100：满 100 轮会话可一次顺序读取', async () => {
    await usecase.execute({
      session: createSuperAdminSession(),
      conversationId: 660001,
      pagination: offsetPagination({ pageSize: 500 }),
    });

    const call = (adminAiMessageQueryService.listByConversation as jest.Mock).mock.calls[0][0];
    expect(call.pagination.pageSize).toBe(100);
  });
});
