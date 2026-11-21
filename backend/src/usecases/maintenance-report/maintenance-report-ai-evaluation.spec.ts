// src/usecases/maintenance-report/maintenance-report-ai-evaluation.spec.ts
//
// 任务 06 AI 评价适配任务 05 真实读侧（真实用例入口 + core 策略）：
//   - 候选会话：只取本人工单、可见、且所选版本内有有效回复的会话；
//   - 空列表 vs 查询失败：失败必须上抛，不能伪装成「确认无会话」；
//   - 引用校验：跨工单/不可见/跨公司/版本不存在/无有效回复一律失败关闭；
//   - 版本冻结：评价绑定 contentVersion，之后追加消息不影响已选范围。

/// <reference types="jest" />
import {
  assertWorkOrderSummaryAiEvaluationReference,
  resolveWorkOrderSummaryAiEvaluationInput,
  WORK_ORDER_SUMMARY_AI_SOURCE_TYPE,
} from './maintenance-report-ai-evaluation.helpers';
import { ListWorkOrderSummaryAiConversationsUsecase } from './list-work-order-summary-ai-conversations.usecase';
import { MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';

const ACCOUNT_ID = 900001;
const OTHER_ACCOUNT_ID = 900002;
const ORGANIZATION_ID = 920001;
const REPAIR_REQUEST_ID = 955001;

const session = {
  accountId: ACCOUNT_ID,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as never;

const closedWorkOrder = (overrides: Record<string, unknown> = {}) => ({
  id: REPAIR_REQUEST_ID,
  requestNo: 'RR-2026-1001',
  customerAccountId: 880001,
  equipmentModelId: 300001,
  acceptedEngineerAccountId: ACCOUNT_ID,
  isAccepted: true,
  deprecated: false,
  ownerOrganizationId: ORGANIZATION_ID,
  closureStatus: 'CLOSED',
  closedAt: new Date('2026-10-02T00:00:00.000Z'),
  handlingResult: 'FIXED',
  handlingStatus: 'COMPLETED',
  closureReason: null,
  customerOrganizationId: 930001,
  currentRevisionNo: 1,
  ...overrides,
});

const message = (params: {
  id: number;
  messageSeq: number;
  turnNo: number;
  role: 'USER' | 'ASSISTANT';
  status: string;
  contentVersion: number;
  contentText?: string;
}) => ({
  id: params.id,
  conversationId: 700001,
  messageSeq: params.messageSeq,
  turnNo: params.turnNo,
  role: params.role,
  contentText: params.contentText ?? `m${params.messageSeq}`,
  contentVersion: params.contentVersion,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  status: params.status,
});

/** 会话 700001：v1 一轮成功回答，v2 追加一轮成功回答，v3 追加一轮失败回答 */
const conversationDetail = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 700001,
    requestId: REPAIR_REQUEST_ID,
    ownerOrganizationId: ORGANIZATION_ID,
    creatorAccountId: ACCOUNT_ID,
    status: 'COMPLETED',
    contentVersion: 3,
    createdAt: new Date('2026-09-30T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    completedAt: new Date('2026-10-01T00:00:00.000Z'),
    deletedAt: null,
    messages: [
      message({
        id: 1,
        messageSeq: 1,
        turnNo: 1,
        role: 'USER',
        status: 'SUCCEEDED',
        contentVersion: 1,
      }),
      message({
        id: 2,
        messageSeq: 2,
        turnNo: 1,
        role: 'ASSISTANT',
        status: 'SUCCEEDED',
        contentVersion: 1,
      }),
      message({
        id: 3,
        messageSeq: 3,
        turnNo: 2,
        role: 'USER',
        status: 'SUCCEEDED',
        contentVersion: 2,
      }),
      message({
        id: 4,
        messageSeq: 4,
        turnNo: 2,
        role: 'ASSISTANT',
        status: 'SUCCEEDED',
        contentVersion: 2,
      }),
      // 第 3 轮只保存了提问（生成失败不会留回答消息）→ 该轮不算有效回复
      message({
        id: 5,
        messageSeq: 5,
        turnNo: 3,
        role: 'USER',
        status: 'SUCCEEDED',
        contentVersion: 3,
      }),
    ],
    ...overrides,
  }) as never;

const listItem = (overrides: Record<string, unknown> = {}) => ({
  id: 700001,
  requestId: REPAIR_REQUEST_ID,
  requestNo: 'RR-2026-1001',
  customerOrganizationId: 930001,
  status: 'COMPLETED',
  contentVersion: 3,
  messageCount: 6,
  turnCount: 3,
  lastMessageAt: new Date('2026-10-01T00:00:00.000Z'),
  createdAt: new Date('2026-09-30T00:00:00.000Z'),
  ...overrides,
});

const makeListUsecase = (params: {
  workOrder?: Record<string, unknown>;
  listVisible?: jest.Mock;
  findVisibleDetail?: jest.Mock;
  organizationId?: number;
}) => {
  const maintenanceReportService = {
    findRepairRequestWriteContext: jest
      .fn()
      .mockResolvedValue(params.workOrder ?? closedWorkOrder()),
  };
  const organizationContextService = {
    resolveForAccount: jest
      .fn()
      .mockResolvedValue({ organizationId: params.organizationId ?? ORGANIZATION_ID }),
  };
  const aiConversationQueryService = {
    listVisible:
      params.listVisible ??
      jest.fn().mockResolvedValue({ items: [listItem()], total: 1, page: 1, pageSize: 50 }),
    findVisibleDetail:
      params.findVisibleDetail ?? jest.fn().mockResolvedValue(conversationDetail()),
  };
  const usecase = new ListWorkOrderSummaryAiConversationsUsecase(
    maintenanceReportService as never,
    organizationContextService as never,
    aiConversationQueryService as never,
  );
  return { usecase, maintenanceReportService, aiConversationQueryService };
};

describe('ListWorkOrderSummaryAiConversationsUsecase', () => {
  it('返回本人工单内所选版本有有效回复的会话，并给出冻结范围', async () => {
    const { usecase, aiConversationQueryService } = makeListUsecase({});

    const candidates = await usecase.execute({ session, repairRequestId: REPAIR_REQUEST_ID });

    expect(aiConversationQueryService.listVisible).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: REPAIR_REQUEST_ID }),
    );
    expect(candidates).toEqual([
      {
        conversationId: 700001,
        contentVersion: 3,
        lastMessageSeq: 5,
        // v1、v2 各一条已保存回答；v3 只有提问，不算有效回复
        effectiveReplyCount: 2,
        createdAt: new Date('2026-09-30T00:00:00.000Z'),
        completedAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ]);
  });

  it('会话在所选版本内没有成功回答时不出现在候选里（空列表 = 确认无可用会话）', async () => {
    const { usecase } = makeListUsecase({
      findVisibleDetail: jest.fn().mockResolvedValue(
        conversationDetail({
          contentVersion: 1,
          messages: [
            message({
              id: 1,
              messageSeq: 1,
              turnNo: 1,
              role: 'USER',
              status: 'SUCCEEDED',
              contentVersion: 1,
            }),
          ],
        }),
      ),
    });

    await expect(usecase.execute({ session, repairRequestId: REPAIR_REQUEST_ID })).resolves.toEqual(
      [],
    );
  });

  it('查询失败向上抛出，不能当成「确认无会话」', async () => {
    const { usecase } = makeListUsecase({
      listVisible: jest.fn().mockRejectedValue(new Error('database unavailable')),
    });

    await expect(usecase.execute({ session, repairRequestId: REPAIR_REQUEST_ID })).rejects.toThrow(
      'database unavailable',
    );
  });

  it('防御性收束：列表里混入其它工单的会话时不进入候选', async () => {
    const { usecase } = makeListUsecase({
      listVisible: jest.fn().mockResolvedValue({
        items: [listItem({ requestId: REPAIR_REQUEST_ID + 1 })],
        total: 1,
        page: 1,
        pageSize: 50,
      }),
    });

    await expect(usecase.execute({ session, repairRequestId: REPAIR_REQUEST_ID })).resolves.toEqual(
      [],
    );
  });

  it('会话超过一页：逐页读取，不能在第二页有可用会话时宣称无会话', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      listItem({ id: 710000 + index, contentVersion: 1 }),
    );
    const listVisible = jest.fn((input: { pagination: { page: number } }) =>
      input.pagination.page === 1
        ? { items: firstPage, total: null, page: 1, pageSize: 50 }
        : {
            items: [listItem({ id: 700001, contentVersion: 3 })],
            total: null,
            page: 2,
            pageSize: 50,
          },
    );
    const findVisibleDetail = jest.fn((input: { conversationId: number }) =>
      input.conversationId === 700001
        ? conversationDetail()
        : conversationDetail({
            id: input.conversationId,
            contentVersion: 1,
            messages: [
              message({
                id: input.conversationId,
                messageSeq: 1,
                turnNo: 1,
                role: 'USER',
                status: 'SUCCEEDED',
                contentVersion: 1,
              }),
            ],
          }),
    );
    const { usecase } = makeListUsecase({ listVisible, findVisibleDetail });

    const candidates = await usecase.execute({ session, repairRequestId: REPAIR_REQUEST_ID });

    expect(listVisible).toHaveBeenCalledTimes(2);
    expect(candidates.map((candidate) => candidate.conversationId)).toEqual([700001]);
  });

  it('整页结果达到翻页上限：显式失败，不静默只取前若干页', async () => {
    const fullPage = Array.from({ length: 50 }, (_, index) => listItem({ id: 720000 + index }));
    const listVisible = jest.fn(() => ({
      items: fullPage,
      total: null,
      page: 1,
      pageSize: 50,
    }));
    const findVisibleDetail = jest.fn(() => null);
    const { usecase } = makeListUsecase({ listVisible, findVisibleDetail });

    await expect(
      usecase.execute({ session, repairRequestId: REPAIR_REQUEST_ID }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT });
  });

  it('非本人接单的工单：按工单归属拒绝（不读取会话）', async () => {
    const { usecase, aiConversationQueryService } = makeListUsecase({
      workOrder: closedWorkOrder({ acceptedEngineerAccountId: OTHER_ACCOUNT_ID }),
    });

    await expect(
      usecase.execute({ session, repairRequestId: REPAIR_REQUEST_ID }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_OWNER_MISMATCH });
    expect(aiConversationQueryService.listVisible).not.toHaveBeenCalled();
  });
});

describe('assertWorkOrderSummaryAiEvaluationReference', () => {
  const baseAi = {
    aiUsage: 'USED' as string,
    aiSourceType: WORK_ORDER_SUMMARY_AI_SOURCE_TYPE,
    aiSourceId: '700001',
    aiSourceVersion: '2',
    aiScore: 4,
    aiCorrectness: 'CORRECT',
    aiHelpfulness: 3,
    aiNote: null as string | null,
  };

  const check = (params: {
    ai?: Partial<typeof baseAi>;
    detail?: unknown;
    repairRequestId?: number;
    organizationId?: number;
  }) =>
    assertWorkOrderSummaryAiEvaluationReference({
      ai: { ...baseAi, ...params.ai },
      viewerAccountId: ACCOUNT_ID,
      viewerOrganizationId: params.organizationId ?? ORGANIZATION_ID,
      repairRequestId: params.repairRequestId ?? REPAIR_REQUEST_ID,
      aiConversationQueryService: {
        findVisibleDetail: jest
          .fn()
          .mockResolvedValue(params.detail === undefined ? conversationDetail() : params.detail),
      } as never,
    });

  it('有效引用：返回所选版本内的冻结范围（含之后追加的消息也不进入）', async () => {
    await expect(check({})).resolves.toEqual({
      conversationId: 700001,
      contentVersion: 2,
      // v2 范围内只到第 4 条消息；v3 的追加消息不影响
      lastMessageSeq: 4,
      // v1、v2 各有一条已保存回答，v3 的追问不进入
      effectiveReplyCount: 2,
    });
  });

  it('NOT_USED 时不校验会话（允许报告不评价）', async () => {
    await expect(check({ ai: { aiUsage: 'NOT_USED' } })).resolves.toBeNull();
  });

  it('来源类型不是工单辅助排查会话：拒绝', async () => {
    await expect(check({ ai: { aiSourceType: 'MANUAL' } })).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID,
    });
  });

  it('会话不可见或不存在：拒绝（不泄露存在性）', async () => {
    await expect(check({ detail: null })).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID,
    });
  });

  it('会话属于其它工单：拒绝', async () => {
    await expect(
      check({ detail: conversationDetail({ requestId: REPAIR_REQUEST_ID + 1 }) }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID });
  });

  it('会话属于其它公司：拒绝', async () => {
    await expect(
      check({ detail: conversationDetail({ ownerOrganizationId: ORGANIZATION_ID + 1 }) }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID });
  });

  it('绑定的内容版本不存在（大于会话当前版本）：拒绝', async () => {
    await expect(check({ ai: { aiSourceVersion: '9' } })).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID,
    });
  });

  it('所选版本内没有有效回复：按不可评价拒绝', async () => {
    await expect(
      check({
        ai: { aiSourceVersion: '2' },
        detail: conversationDetail({
          contentVersion: 2,
          // 版本内只有提问、没有已保存回答 → 该轮 turnState 为 UNKNOWN，不算有效回复
          messages: [
            message({
              id: 1,
              messageSeq: 1,
              turnNo: 1,
              role: 'USER',
              status: 'SUCCEEDED',
              contentVersion: 1,
            }),
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.AI_EVALUATION_NOT_APPLICABLE });
  });

  it('标识/版本非正整数：拒绝', async () => {
    await expect(check({ ai: { aiSourceId: 'abc' } })).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.AI_EVALUATION_INVALID,
    });
  });
});

describe('resolveWorkOrderSummaryAiEvaluationInput', () => {
  const stored = {
    aiUsage: 'USED',
    aiSourceType: WORK_ORDER_SUMMARY_AI_SOURCE_TYPE,
    aiSourceId: '700001',
    aiSourceVersion: '2',
    aiScore: 4,
    aiCorrectness: 'CORRECT',
    aiHelpfulness: 5,
    aiNote: '历史说明',
  };

  it('客户端未提供的字段沿用库内值', () => {
    expect(resolveWorkOrderSummaryAiEvaluationInput({}, stored)).toEqual({
      aiUsage: 'USED',
      aiSourceType: WORK_ORDER_SUMMARY_AI_SOURCE_TYPE,
      aiSourceId: '700001',
      aiSourceVersion: '2',
      aiScore: 4,
      aiCorrectness: 'CORRECT',
      aiHelpfulness: 5,
      aiNote: '历史说明',
    });
  });

  it('显式切换到未使用：整组清空，不残留旧评分与引用', () => {
    expect(resolveWorkOrderSummaryAiEvaluationInput({ aiUsage: 'NOT_USED' }, stored)).toEqual({
      aiUsage: 'NOT_USED',
      aiSourceType: null,
      aiSourceId: null,
      aiSourceVersion: null,
      aiScore: null,
      aiCorrectness: null,
      aiHelpfulness: null,
      aiNote: null,
    });
  });

  it('客户端只改评分：引用保持库内版本', () => {
    expect(
      resolveWorkOrderSummaryAiEvaluationInput({ aiScore: 5, aiHelpfulness: 4 }, stored),
    ).toMatchObject({ aiScore: 5, aiHelpfulness: 4, aiSourceVersion: '2' });
  });
});
