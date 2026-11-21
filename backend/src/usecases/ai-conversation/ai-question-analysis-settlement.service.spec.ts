// src/usecases/ai-conversation/ai-question-analysis-settlement.service.spec.ts
// 任务05 S2.1-6 纠偏：执行终止后的 analysis 收敛由 Worker 扫描完成（不再由读路径触发）。
// 2026-11-20 复验 P2-1／P2-2：
// - 候选改按「PENDING 且无回答」键集分页，不设时间窗口；
// - 结算在会话行锁与同一事务内重新核对分析事实与执行身份，避免旧结算覆盖新重试。

import type { AiConversationExecutionLookupPort } from '@src/usecases/common/ports/ai-conversation-execution.contract';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';

import { AiQuestionAnalysisSettlementService } from './ai-question-analysis-settlement.service';

type LookupMock = jest.Mocked<
  Pick<
    AiConversationExecutionLookupPort,
    'findActiveExecutionByBizTarget' | 'findLatestExecutionByBizTarget'
  >
>;

type ConversationServiceMock = {
  listPendingAnalysisCandidates: jest.Mock;
  lockConversationForWrite: jest.Mock;
  findAnalysisByQuestion: jest.Mock;
  markAnalysisFailed: jest.Mock;
};

const TRANSACTION_CONTEXT = { marker: 'tx' } as never;

function analysisFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    questionUuid: 'q-1',
    conversationId: 10,
    questionMessageId: 100,
    answerMessageId: null,
    status: 'PENDING',
    ...overrides,
  };
}

describe('AiQuestionAnalysisSettlementService', () => {
  let lookup: LookupMock;
  let conversations: ConversationServiceMock;
  let transactionRunner: jest.Mocked<TransactionRunner>;
  let service: AiQuestionAnalysisSettlementService;

  beforeEach(() => {
    lookup = {
      findActiveExecutionByBizTarget: jest.fn().mockResolvedValue(null),
      findLatestExecutionByBizTarget: jest.fn(),
    };
    conversations = {
      listPendingAnalysisCandidates: jest.fn().mockResolvedValue([]),
      lockConversationForWrite: jest.fn().mockResolvedValue({ id: 10 }),
      findAnalysisByQuestion: jest.fn().mockResolvedValue(analysisFixture()),
      markAnalysisFailed: jest.fn().mockResolvedValue(true),
    };
    transactionRunner = {
      run: jest.fn(async (callback: (context: never) => Promise<unknown>) =>
        callback(TRANSACTION_CONTEXT),
      ),
    } as unknown as jest.Mocked<TransactionRunner>;
    service = new AiQuestionAnalysisSettlementService(
      lookup as never,
      conversations as never,
      transactionRunner,
    );
  });

  it('最新执行为 FAILED／CANCELLED 且无活动执行时补写为可重试失败', async () => {
    conversations.listPendingAnalysisCandidates.mockResolvedValue([
      { questionUuid: 'q-1', conversationId: 10, questionMessageId: 100 },
      { questionUuid: 'q-2', conversationId: 11, questionMessageId: 101 },
    ]);
    conversations.findAnalysisByQuestion
      .mockResolvedValueOnce(analysisFixture({ questionUuid: 'q-1', conversationId: 10 }))
      .mockResolvedValueOnce(analysisFixture({ questionUuid: 'q-2', conversationId: 11 }));
    lookup.findLatestExecutionByBizTarget
      .mockResolvedValueOnce({ status: 'FAILED', workflowId: 'w1' } as never)
      .mockResolvedValueOnce({ status: 'CANCELLED', workflowId: 'w2' } as never);

    const result = await service.sweep({ afterQuestionUuid: null, limit: 20 });

    expect(result).toEqual({
      scanned: 2,
      settled: 2,
      skipped: 0,
      failed: 0,
      nextCursor: null,
      reachedEnd: true,
    });
    expect(conversations.markAnalysisFailed).toHaveBeenNthCalledWith(
      1,
      { questionUuid: 'q-1', reason: 'workflow_failed' },
      TRANSACTION_CONTEXT,
    );
    expect(conversations.markAnalysisFailed).toHaveBeenNthCalledWith(
      2,
      { questionUuid: 'q-2', reason: 'workflow_cancelled' },
      TRANSACTION_CONTEXT,
    );
  });

  it('重试后的新执行仍在进行中时不写失败（避免挡掉在途回答写入）', async () => {
    conversations.listPendingAnalysisCandidates.mockResolvedValue([
      { questionUuid: 'q-retried', conversationId: 10, questionMessageId: 100 },
    ]);
    conversations.findAnalysisByQuestion.mockResolvedValue(
      analysisFixture({ questionUuid: 'q-retried' }),
    );
    lookup.findActiveExecutionByBizTarget.mockResolvedValue({
      status: 'PROCESSING',
      workflowId: 'w-new',
      jobId: 'job-new',
    } as never);

    const result = await service.sweep({ afterQuestionUuid: null });

    expect(result.settled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(conversations.markAnalysisFailed).not.toHaveBeenCalled();
    expect(lookup.findLatestExecutionByBizTarget).not.toHaveBeenCalled();
    expect(lookup.findActiveExecutionByBizTarget).toHaveBeenCalledWith(
      expect.objectContaining({ transactionContext: TRANSACTION_CONTEXT, forUpdate: true }),
    );
  });

  it('新执行已进入活动态时旧候选在锁内被跳过（旧结算不覆盖新重试）', async () => {
    // 第一次扫描拿到同一旧候选；放行前用户已重试成功，分析回到 PENDING 且有新活动执行
    conversations.listPendingAnalysisCandidates.mockResolvedValue([
      { questionUuid: 'q-race', conversationId: 10, questionMessageId: 100 },
    ]);
    conversations.findAnalysisByQuestion.mockResolvedValue(
      analysisFixture({ questionUuid: 'q-race' }),
    );
    lookup.findActiveExecutionByBizTarget.mockResolvedValue({
      status: 'QUEUED',
      workflowId: 'w-retry',
      jobId: 'job-retry',
    } as never);

    const result = await service.sweep({ afterQuestionUuid: null });

    expect(result).toMatchObject({ scanned: 1, settled: 0, skipped: 1 });
    expect(conversations.markAnalysisFailed).not.toHaveBeenCalled();
  });

  it('最新执行已成功时不回写（不覆盖已完成轮次）', async () => {
    conversations.listPendingAnalysisCandidates.mockResolvedValue([
      { questionUuid: 'q-healed', conversationId: 10, questionMessageId: 100 },
    ]);
    conversations.findAnalysisByQuestion.mockResolvedValue(
      analysisFixture({ questionUuid: 'q-healed' }),
    );
    lookup.findLatestExecutionByBizTarget.mockResolvedValue({
      status: 'SUCCEEDED',
      workflowId: 'w-new',
    } as never);

    const result = await service.sweep({ afterQuestionUuid: null });

    expect(result).toMatchObject({ settled: 0, skipped: 1 });
    expect(conversations.markAnalysisFailed).not.toHaveBeenCalled();
  });

  it('锁内发现分析已有回答或已非 PENDING 时跳过（候选不授权写入）', async () => {
    conversations.listPendingAnalysisCandidates.mockResolvedValue([
      { questionUuid: 'q-answered', conversationId: 10, questionMessageId: 100 },
    ]);
    conversations.findAnalysisByQuestion.mockResolvedValue(
      analysisFixture({ questionUuid: 'q-answered', answerMessageId: 900, status: 'SUCCEEDED' }),
    );

    const result = await service.sweep({ afterQuestionUuid: null });

    expect(result).toMatchObject({ settled: 0, skipped: 1 });
    expect(conversations.markAnalysisFailed).not.toHaveBeenCalled();
    expect(lookup.findActiveExecutionByBizTarget).not.toHaveBeenCalled();
  });

  it('会话不存在时跳过', async () => {
    conversations.listPendingAnalysisCandidates.mockResolvedValue([
      { questionUuid: 'q-orphan', conversationId: 10, questionMessageId: 100 },
    ]);
    conversations.lockConversationForWrite.mockResolvedValue(null);

    const result = await service.sweep({ afterQuestionUuid: null });

    expect(result).toMatchObject({ settled: 0, skipped: 1 });
    expect(conversations.findAnalysisByQuestion).not.toHaveBeenCalled();
  });

  it('单条写入失败不影响其余候选，且计入 failed 后继续推进', async () => {
    conversations.listPendingAnalysisCandidates.mockResolvedValue([
      { questionUuid: 'q-1', conversationId: 10, questionMessageId: 100 },
      { questionUuid: 'q-2', conversationId: 11, questionMessageId: 101 },
    ]);
    conversations.findAnalysisByQuestion
      .mockResolvedValueOnce(analysisFixture({ questionUuid: 'q-1', conversationId: 10 }))
      .mockResolvedValueOnce(analysisFixture({ questionUuid: 'q-2', conversationId: 11 }));
    lookup.findLatestExecutionByBizTarget
      .mockResolvedValueOnce({ status: 'FAILED', workflowId: 'w1' } as never)
      .mockResolvedValueOnce({ status: 'FAILED', workflowId: 'w2' } as never);
    conversations.markAnalysisFailed
      .mockRejectedValueOnce(new Error('db busy'))
      .mockResolvedValueOnce(true);

    const result = await service.sweep({ afterQuestionUuid: null });

    expect(result).toMatchObject({ scanned: 2, settled: 1, failed: 1 });
    expect(conversations.markAnalysisFailed).toHaveBeenCalledTimes(2);
  });

  it('条件更新未命中（已被其他执行处理）按跳过计数，保持幂等', async () => {
    conversations.listPendingAnalysisCandidates.mockResolvedValue([
      { questionUuid: 'q-idem', conversationId: 10, questionMessageId: 100 },
    ]);
    conversations.findAnalysisByQuestion.mockResolvedValue(
      analysisFixture({ questionUuid: 'q-idem' }),
    );
    lookup.findLatestExecutionByBizTarget.mockResolvedValue({
      status: 'FAILED',
      workflowId: 'w1',
    } as never);
    conversations.markAnalysisFailed.mockResolvedValue(false);

    const result = await service.sweep({ afterQuestionUuid: null });

    expect(result).toMatchObject({ settled: 0, skipped: 1 });
  });

  it('满批时保留末键作为下一批起点，到末尾时游标置空', async () => {
    const full = Array.from({ length: 3 }, (_, index) => ({
      questionUuid: `q-${index}`,
      conversationId: 10 + index,
      questionMessageId: 100 + index,
    }));
    conversations.listPendingAnalysisCandidates.mockResolvedValueOnce(full);

    const fullResult = await service.sweep({ afterQuestionUuid: null, limit: 3 });

    expect(fullResult).toMatchObject({ scanned: 3, nextCursor: 'q-2', reachedEnd: false });
    expect(conversations.listPendingAnalysisCandidates).toHaveBeenCalledWith({
      afterQuestionUuid: null,
      limit: 3,
    });

    conversations.listPendingAnalysisCandidates.mockResolvedValueOnce([full[0]]);
    const lastResult = await service.sweep({ afterQuestionUuid: 'q-2', limit: 3 });

    expect(lastResult).toMatchObject({ scanned: 1, nextCursor: null, reachedEnd: true });
    expect(conversations.listPendingAnalysisCandidates).toHaveBeenLastCalledWith({
      afterQuestionUuid: 'q-2',
      limit: 3,
    });
  });

  it('候选为空时不产生任何事务与写入', async () => {
    conversations.listPendingAnalysisCandidates.mockResolvedValue([]);

    const result = await service.sweep({ afterQuestionUuid: null });

    expect(result).toMatchObject({ scanned: 0, settled: 0, skipped: 0, failed: 0 });
    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(conversations.markAnalysisFailed).not.toHaveBeenCalled();
  });
});
