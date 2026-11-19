/// <reference types="jest" />
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { AiConversationStatus } from '@app-types/models/ai-conversation.types';
import { AI_CONVERSATION_ERROR, DomainError } from '@src/core/common/errors/domain-error';
import type { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import type { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { CreateAiConversationUsecase } from './create-ai-conversation.usecase';

type AiConversationServiceMock = { insertConversation: jest.Mock };
type RepairRequestQueryServiceMock = { findAssociationTarget: jest.Mock };
type OrganizationContextMock = { resolveForAccount: jest.Mock; tryResolveForAccount: jest.Mock };

const ENGINEER_SESSION: UsecaseSession = {
  accountId: 10,
  roles: [IdentityTypeEnum.ENGINEER],
  activeRole: IdentityTypeEnum.ENGINEER,
};

describe('CreateAiConversationUsecase', () => {
  const transactionContext = Symbol(
    'transactionContext',
  ) as unknown as PersistenceTransactionContext;
  const createdAt = new Date('2026-11-18T10:00:00.000Z');

  let aiConversationService: AiConversationServiceMock;
  let repairRequestQueryService: RepairRequestQueryServiceMock;
  let organizationContextService: OrganizationContextMock;
  let usecase: CreateAiConversationUsecase;

  beforeEach(() => {
    aiConversationService = {
      insertConversation: jest.fn().mockResolvedValue({
        id: 7,
        requestId: null,
        ownerOrganizationId: 2,
        contentVersion: 1,
        engineerAccountId: 10,
        status: AiConversationStatus.ACTIVE,
        createdAt,
      }),
    };
    repairRequestQueryService = { findAssociationTarget: jest.fn() };
    organizationContextService = {
      resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 2, memberRole: 'ENGINEER' }),
      tryResolveForAccount: jest.fn(),
    };

    const transactionRunner = {
      run: jest.fn(async (work: (context: PersistenceTransactionContext) => Promise<unknown>) =>
        work(transactionContext),
      ),
    } as unknown as TransactionRunner;

    usecase = new CreateAiConversationUsecase(
      aiConversationService as unknown as AiConversationService,
      repairRequestQueryService as unknown as RepairRequestQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    );
  });

  it('独立会话：公司取服务端事实、工程师取会话账号', async () => {
    const result = await usecase.execute({ session: ENGINEER_SESSION, requestId: null });

    expect(result).toMatchObject({ id: 7, requestId: null, requestNo: '', status: 'ACTIVE' });
    expect(aiConversationService.insertConversation).toHaveBeenCalledWith(
      { requestId: null, ownerOrganizationId: 2, engineerAccountId: 10 },
      transactionContext,
    );
    expect(repairRequestQueryService.findAssociationTarget).not.toHaveBeenCalled();
  });

  it('关联本公司可读工单：写入工单 ID 并回传申请编号', async () => {
    repairRequestQueryService.findAssociationTarget.mockResolvedValue({
      id: 5,
      requestNo: 'DEV-RR-A-102',
      trustedServiceOrganizationId: 2,
      deletedAt: null,
      isHistorical: false,
    });
    aiConversationService.insertConversation.mockResolvedValue({
      id: 8,
      requestId: 5,
      ownerOrganizationId: 2,
      contentVersion: 1,
      engineerAccountId: 10,
      status: AiConversationStatus.ACTIVE,
      createdAt,
    });

    const result = await usecase.execute({ session: ENGINEER_SESSION, requestId: 5 });

    expect(result).toMatchObject({ id: 8, requestId: 5, requestNo: 'DEV-RR-A-102' });
    expect(aiConversationService.insertConversation).toHaveBeenCalledWith(
      { requestId: 5, ownerOrganizationId: 2, engineerAccountId: 10 },
      transactionContext,
    );
  });

  it.each([
    ['外公司工单', { trustedServiceOrganizationId: 3, deletedAt: null, isHistorical: false }],
    ['已删除工单', { trustedServiceOrganizationId: 2, deletedAt: new Date(), isHistorical: false }],
    ['历史工单', { trustedServiceOrganizationId: 2, deletedAt: null, isHistorical: true }],
    [
      '无法确认服务公司',
      { trustedServiceOrganizationId: null, deletedAt: null, isHistorical: false },
    ],
  ])('%s：拒绝关联且不落库', async (_label, target) => {
    repairRequestQueryService.findAssociationTarget.mockResolvedValue({
      id: 5,
      requestNo: 'DEV-RR-B-101',
      ...target,
    });

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, requestId: 5 }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(aiConversationService.insertConversation).not.toHaveBeenCalled();
  });

  it('工单不存在：按不可关联拒绝', async () => {
    repairRequestQueryService.findAssociationTarget.mockResolvedValue(null);

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, requestId: 999 }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.WORK_ORDER_NOT_ASSOCIABLE });
  });

  it('无可信公司：返回 COMPANY_REQUIRED', async () => {
    organizationContextService.resolveForAccount.mockRejectedValue(
      new DomainError('ORGANIZATION_NO_ACTIVE_MEMBERSHIP', '无有效成员关系'),
    );

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, requestId: null }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.COMPANY_REQUIRED });
    expect(aiConversationService.insertConversation).not.toHaveBeenCalled();
  });

  it('公司内角色非工程师：返回 COMPANY_UNAVAILABLE', async () => {
    organizationContextService.resolveForAccount.mockResolvedValue({
      organizationId: 2,
      memberRole: 'CUSTOMER',
    });

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, requestId: null }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.COMPANY_UNAVAILABLE });
  });

  it('非法工单 ID：进入事务前拒绝', async () => {
    await expect(
      usecase.execute({ session: ENGINEER_SESSION, requestId: 0 }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.INVALID_PARAMS });
    expect(aiConversationService.insertConversation).not.toHaveBeenCalled();
  });
});
