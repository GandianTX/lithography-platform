// src/usecases/ai-conversation/export-ai-conversation.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

import { AiConversationSnapshotService } from './ai-conversation-snapshot.service';
import { ExportAiConversationUsecase } from './export-ai-conversation.usecase';
import type { AiConversationExportRenderer } from './ai-conversation-export-renderer.contract';

/**
 * 导出用例单测（任务 05 · S4.2 · R039-01 / R040-01）。
 *
 * 覆盖：授权边界复用、版本固定（新消息不混入）、外公司直调拒绝、
 * 受控 JSON 需技术授权、渲染失败不返回空文件。
 */
describe('ExportAiConversationUsecase', () => {
  const ENGINEER_SESSION: UsecaseSession = {
    accountId: 10,
    roles: [IdentityTypeEnum.ENGINEER],
    activeRole: IdentityTypeEnum.ENGINEER,
  };
  const ADMIN_SESSION: UsecaseSession = {
    accountId: 900,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
  };

  const createdAt = new Date('2026-11-01T00:00:00.000Z');

  const message = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    messageSeq: 1,
    turnNo: 1,
    role: 'USER',
    questionUuid: 'uuid-1',
    contentText: '问题正文',
    contentVersion: 1,
    createdAt,
    ...overrides,
  });

  const detail = (overrides: Record<string, unknown> = {}) => ({
    id: 66,
    requestId: 88,
    requestNo: 'RR-20261101-001',
    status: 'ACTIVE',
    contentVersion: 3,
    createdAt,
    completedAt: null,
    ownerAccountId: 20,
    ownerOrganizationId: 100,
    messages: [
      message({ id: 1, messageSeq: 1, turnNo: 1, role: 'USER', contentVersion: 1 }),
      message({ id: 2, messageSeq: 2, turnNo: 1, role: 'ASSISTANT', contentVersion: 1 }),
      message({ id: 3, messageSeq: 3, turnNo: 2, role: 'USER', contentVersion: 2 }),
      message({ id: 4, messageSeq: 4, turnNo: 2, role: 'ASSISTANT', contentVersion: 2 }),
    ],
    analyses: [
      {
        questionUuid: 'uuid-1',
        questionMessageId: 1,
        answerMessageId: 2,
        status: 'SUCCEEDED',
        failureReason: null,
        contentVersion: 1,
      },
      {
        questionUuid: 'uuid-2',
        questionMessageId: 3,
        answerMessageId: 4,
        status: 'FAILED',
        failureReason: '模型调用超时',
        contentVersion: 2,
      },
    ],
    messageTurnNos: new Map<number, number | null>([
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
    ]),
    ...overrides,
  });

  const queryService = {
    findVisibleDetail: jest.fn(),
    findAdminDetail: jest.fn(),
  } as unknown as AiConversationQueryService;

  const organizationContextService = {
    tryResolveForAccount: jest.fn().mockResolvedValue({
      organizationId: 100,
      memberRole: 'SUPER_ADMIN',
    }),
  } as unknown as TrustedOrganizationContextQueryService;

  const accountQueryService = {
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(1),
    findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[20, '陈工程师']])),
  } as unknown as AccountQueryService;

  const renderer: AiConversationExportRenderer = {
    renderPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7 fake')),
  };

  const makeUsecase = (authorization = 'tech-secret') =>
    new ExportAiConversationUsecase(
      new AiConversationSnapshotService(
        queryService,
        organizationContextService,
        accountQueryService,
      ),
      renderer,
      authorization,
    );

  beforeEach(() => {
    (queryService.findVisibleDetail as jest.Mock).mockReset().mockResolvedValue(detail());
    (queryService.findAdminDetail as jest.Mock).mockReset().mockResolvedValue(detail());
    (renderer.renderPdf as jest.Mock).mockReset().mockResolvedValue(Buffer.from('%PDF-1.7 fake'));
  });

  it('工程师导出本人可见会话：返回固定版本与字节内容', async () => {
    const usecase = makeUsecase();
    const result = await usecase.execute({
      session: ENGINEER_SESSION,
      conversationId: 66,
      contentVersion: 2,
      format: 'PDF',
    });

    expect(result.contentVersion).toBe(2);
    expect(result.lastMessageSeq).toBe(4);
    expect(result.filename).toBe('ai-conversation-66-v2.pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('工程师路径与管理员路径的轮次状态一致（同一会话同一版本不因身份而异）', async () => {
    // 回归：轮次状态只由版本内的消息与轮次关联决定，读取身份不得改变判定
    const engineerResult = await makeUsecase().execute({
      session: ENGINEER_SESSION,
      conversationId: 66,
      contentVersion: 3,
      format: 'PDF',
    });
    const engineerSnapshot = (renderer.renderPdf as jest.Mock).mock.calls[0][0] as {
      messages: Array<{ messageSeq: number; turnState: string }>;
    };

    const adminSession = {
      accountId: 1,
      roles: [IdentityTypeEnum.SUPER_ADMIN],
      activeRole: IdentityTypeEnum.SUPER_ADMIN,
    };
    await makeUsecase().execute({
      session: adminSession,
      conversationId: 66,
      contentVersion: 3,
      format: 'PDF',
    });
    const adminSnapshot = (renderer.renderPdf as jest.Mock).mock.calls[1][0] as {
      messages: Array<{ messageSeq: number; turnState: string }>;
    };

    expect(engineerResult.contentVersion).toBe(3);
    expect(engineerSnapshot.messages.map((m) => m.messageSeq)).toEqual(
      adminSnapshot.messages.map((m) => m.messageSeq),
    );
    expect(engineerSnapshot.messages.map((m) => m.turnState)).toEqual(
      adminSnapshot.messages.map((m) => m.turnState),
    );
    // 该版本内两轮都有已保存回答，因此不得出现「本版未收录回答」
    expect(engineerSnapshot.messages.map((m) => m.turnState)).not.toContain('UNKNOWN');
  });

  it('导出期间新增的高版本消息不混入（固定版本语义）', async () => {
    const usecase = makeUsecase();
    const result = await usecase.execute({
      session: ADMIN_SESSION,
      conversationId: 66,
      contentVersion: 1,
      format: 'RAW_JSON',
      technicalAuthorization: 'tech-secret',
    });

    expect(result.lastMessageSeq).toBe(2);
    const payload = JSON.parse(result.content.toString('utf-8')) as {
      conversation: { contentVersion: number; lastMessageSeq: number };
      messages: Array<{ messageSeq: number; contentVersion: number }>;
    };
    expect(payload.conversation.contentVersion).toBe(1);
    expect(payload.conversation.lastMessageSeq).toBe(2);
    expect(payload.messages.map((item) => item.messageSeq)).toEqual([1, 2]);
  });

  it('本版本无回答的轮次标记为「本版未收录回答」（不跟随当前失败状态）', async () => {
    // 真实反例：W 侧失败后当前 analysis.status 为 FAILED，但该版本范围内没有任何回答。
    // 固定版本产物不得把会变化的执行状态写进本版标记。
    (queryService.findAdminDetail as jest.Mock).mockResolvedValue(
      detail({
        messages: [
          message({ id: 1, messageSeq: 1, turnNo: 1, role: 'USER', contentVersion: 1 }),
          message({ id: 2, messageSeq: 2, turnNo: 1, role: 'ASSISTANT', contentVersion: 1 }),
          message({ id: 3, messageSeq: 3, turnNo: 2, role: 'USER', contentVersion: 2 }),
        ],
      }),
    );
    const usecase = makeUsecase();
    const result = await usecase.execute({
      session: ADMIN_SESSION,
      conversationId: 66,
      contentVersion: 2,
      format: 'RAW_JSON',
      technicalAuthorization: 'tech-secret',
    });

    const payload = JSON.parse(result.content.toString('utf-8')) as {
      messages: Array<{ turnState: string }>;
    };
    expect(payload.messages.map((item) => item.turnState)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
      'UNKNOWN',
    ]);
  });

  it('历史无图会话：导出成功且产物只含正文与轮次状态（不依赖图形）', async () => {
    // 历史会话可能没有图形信息（部件 JSON 仅短时传递，不入库）；导出不得因此失败或产出空文件
    (queryService.findVisibleDetail as jest.Mock).mockResolvedValue(
      detail({ requestId: null, requestNo: '', status: 'COMPLETED' }),
    );
    const usecase = makeUsecase();
    const result = await usecase.execute({
      session: ENGINEER_SESSION,
      conversationId: 66,
      contentVersion: 3,
      format: 'PDF',
    });

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.contentVersion).toBe(3);
    expect(result.lastMessageSeq).toBe(4);

    // 渲染入参快照只含正文与轮次状态，不含任何部件 JSON
    const snapshot = (renderer.renderPdf as jest.Mock).mock.calls[0][0];
    expect(snapshot.messages).toHaveLength(4);
    expect(JSON.stringify(snapshot)).not.toMatch(/partId|reticle_arm|wafer_stage/);
  });

  it('会话不可见时按不存在拒绝，不返回空文件', async () => {
    (queryService.findVisibleDetail as jest.Mock).mockResolvedValue(null);
    const usecase = makeUsecase();

    await expect(
      usecase.execute({
        session: ENGINEER_SESSION,
        conversationId: 66,
        contentVersion: 1,
        format: 'PDF',
      }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.NOT_FOUND });
    expect(renderer.renderPdf).not.toHaveBeenCalled();
  });

  it('二级管理员直传外公司会话时拒绝（与不存在同口径）', async () => {
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockResolvedValue(2);
    (queryService.findAdminDetail as jest.Mock).mockResolvedValue(null);
    const usecase = makeUsecase();

    await expect(
      usecase.execute({
        session: ADMIN_SESSION,
        conversationId: 66,
        contentVersion: 1,
        format: 'PDF',
      }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.NOT_FOUND });
    expect(renderer.renderPdf).not.toHaveBeenCalled();
  });

  it('非工程师且非管理员的会话被拒绝', async () => {
    const usecase = makeUsecase();
    await expect(
      usecase.execute({
        session: {
          accountId: 30,
          roles: [IdentityTypeEnum.CUSTOMER],
          activeRole: IdentityTypeEnum.CUSTOMER,
        },
        conversationId: 66,
        contentVersion: 1,
        format: 'PDF',
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('受控原始 JSON 缺少技术授权时拒绝，且不产出内容', async () => {
    const usecase = makeUsecase();
    await expect(
      usecase.execute({
        session: ADMIN_SESSION,
        conversationId: 66,
        contentVersion: 1,
        format: 'RAW_JSON',
      }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.EXPORT_NOT_ALLOWED });
  });

  it('受控原始 JSON 的技术授权与配置不一致时拒绝', async () => {
    const usecase = makeUsecase();
    await expect(
      usecase.execute({
        session: ADMIN_SESSION,
        conversationId: 66,
        contentVersion: 1,
        format: 'RAW_JSON',
        technicalAuthorization: 'wrong-secret',
      }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.EXPORT_NOT_ALLOWED });
  });

  it('未配置技术授权时受控 JSON 一律拒绝', async () => {
    const usecase = makeUsecase('');
    await expect(
      usecase.execute({
        session: ADMIN_SESSION,
        conversationId: 66,
        contentVersion: 1,
        format: 'RAW_JSON',
        technicalAuthorization: 'tech-secret',
      }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.EXPORT_NOT_ALLOWED });
  });

  it('PDF 渲染失败时抛错，不返回空文件', async () => {
    (renderer.renderPdf as jest.Mock).mockResolvedValue(Buffer.alloc(0));
    const usecase = makeUsecase();

    await expect(
      usecase.execute({
        session: ENGINEER_SESSION,
        conversationId: 66,
        contentVersion: 1,
        format: 'PDF',
      }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.EXPORT_FAILED });
  });

  it('非法会话标识与内容版本在读取前拒绝', async () => {
    const usecase = makeUsecase();
    await expect(
      usecase.execute({
        session: ENGINEER_SESSION,
        conversationId: 0,
        contentVersion: 1,
        format: 'PDF',
      }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.INVALID_PARAMS });
    await expect(
      usecase.execute({
        session: ENGINEER_SESSION,
        conversationId: 66,
        contentVersion: 0,
        format: 'PDF',
      }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.INVALID_PARAMS });
    expect(queryService.findVisibleDetail).not.toHaveBeenCalled();
  });
});
