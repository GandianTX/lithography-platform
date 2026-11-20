// src/usecases/ai-conversation/ai-question-analysis-settlement.service.spec.ts
// 任务05 S2.1-6 纠偏：执行终止后的 analysis 收敛由 Worker 扫描完成（不再由读路径触发）。

import type { AiConversationExecutionLookupPort } from '@src/usecases/common/ports/ai-conversation-execution.contract';

import { AiQuestionAnalysisSettlementService } from './ai-question-analysis-settlement.service';

type LookupMock = jest.Mocked<
  Pick<
    AiConversationExecutionLookupPort,
    | 'listTerminalExecutionsSince'
    | 'findActiveExecutionByBizTarget'
    | 'findLatestExecutionByBizTarget'
  >
>;

describe('AiQuestionAnalysisSettlementService', () => {
  const since = new Date('2026-11-20T01:00:00.000Z');
  let lookup: LookupMock;
  let markAnalysisFailed: jest.Mock<Promise<boolean>, [{ questionUuid: string; reason: string }]>;
  let service: AiQuestionAnalysisSettlementService;

  beforeEach(() => {
    lookup = {
      listTerminalExecutionsSince: jest.fn(),
      findActiveExecutionByBizTarget: jest.fn().mockResolvedValue(null),
      findLatestExecutionByBizTarget: jest.fn(),
    };
    markAnalysisFailed = jest.fn().mockResolvedValue(true);
    service = new AiQuestionAnalysisSettlementService(lookup, { markAnalysisFailed } as never);
  });

  it('最新执行为 FAILED／CANCELLED 且无活动执行时补写为可重试失败', async () => {
    lookup.listTerminalExecutionsSince.mockResolvedValue([
      { bizSubKey: 'q-failed', status: 'FAILED', updatedAt: since, workflowId: 'w1' },
      { bizSubKey: 'q-cancelled', status: 'CANCELLED', updatedAt: since, workflowId: 'w2' },
    ]);
    lookup.findLatestExecutionByBizTarget
      .mockResolvedValueOnce({ status: 'FAILED', workflowId: 'w1' } as never)
      .mockResolvedValueOnce({ status: 'CANCELLED', workflowId: 'w2' } as never);

    const result = await service.sweep({ since, limit: 20 });

    expect(result).toEqual({ scanned: 2, settled: 2, skipped: 0 });
    expect(markAnalysisFailed).toHaveBeenNthCalledWith(1, {
      questionUuid: 'q-failed',
      reason: 'workflow_failed',
    });
    expect(markAnalysisFailed).toHaveBeenNthCalledWith(2, {
      questionUuid: 'q-cancelled',
      reason: 'workflow_cancelled',
    });
  });

  it('重试后的新执行仍在进行中时不写失败（避免挡掉在途回答写入）', async () => {
    lookup.listTerminalExecutionsSince.mockResolvedValue([
      { bizSubKey: 'q-retried', status: 'FAILED', updatedAt: since, workflowId: 'w-old' },
    ]);
    lookup.findActiveExecutionByBizTarget.mockResolvedValue({
      status: 'PROCESSING',
      workflowId: 'w-new',
    } as never);

    const result = await service.sweep({ since });

    expect(result).toEqual({ scanned: 1, settled: 0, skipped: 1 });
    expect(markAnalysisFailed).not.toHaveBeenCalled();
    expect(lookup.findLatestExecutionByBizTarget).not.toHaveBeenCalled();
  });

  it('最新执行已成功时不回写（不覆盖已完成轮次）', async () => {
    lookup.listTerminalExecutionsSince.mockResolvedValue([
      { bizSubKey: 'q-healed', status: 'FAILED', updatedAt: since, workflowId: 'w-old' },
    ]);
    lookup.findLatestExecutionByBizTarget.mockResolvedValue({
      status: 'SUCCEEDED',
      workflowId: 'w-new',
    } as never);

    const result = await service.sweep({ since });

    expect(result).toEqual({ scanned: 1, settled: 0, skipped: 1 });
    expect(markAnalysisFailed).not.toHaveBeenCalled();
  });

  it('同一问题的多条历史失败执行只回读一次最新执行', async () => {
    lookup.listTerminalExecutionsSince.mockResolvedValue([
      { bizSubKey: 'q-dup', status: 'FAILED', updatedAt: since, workflowId: 'w1' },
      { bizSubKey: 'q-dup', status: 'FAILED', updatedAt: since, workflowId: 'w2' },
    ]);
    lookup.findLatestExecutionByBizTarget.mockResolvedValue({
      status: 'FAILED',
      workflowId: 'w2',
    } as never);

    const result = await service.sweep({ since });

    expect(result).toEqual({ scanned: 2, settled: 1, skipped: 0 });
    expect(lookup.findLatestExecutionByBizTarget).toHaveBeenCalledTimes(1);
    expect(markAnalysisFailed).toHaveBeenCalledTimes(1);
  });

  it('单条写入失败不影响其余候选，并且下一轮可重试', async () => {
    lookup.listTerminalExecutionsSince.mockResolvedValue([
      { bizSubKey: 'q-1', status: 'FAILED', updatedAt: since, workflowId: 'w1' },
      { bizSubKey: 'q-2', status: 'FAILED', updatedAt: since, workflowId: 'w2' },
    ]);
    lookup.findLatestExecutionByBizTarget
      .mockResolvedValueOnce({ status: 'FAILED', workflowId: 'w1' } as never)
      .mockResolvedValueOnce({ status: 'FAILED', workflowId: 'w2' } as never);
    markAnalysisFailed.mockRejectedValueOnce(new Error('db busy')).mockResolvedValueOnce(true);

    const result = await service.sweep({ since });

    expect(result).toEqual({ scanned: 2, settled: 1, skipped: 0 });
    expect(markAnalysisFailed).toHaveBeenCalledTimes(2);
  });

  it('按窗口与批量上限查询终态执行', async () => {
    lookup.listTerminalExecutionsSince.mockResolvedValue([]);

    await service.sweep({ since, limit: 7 });

    expect(lookup.listTerminalExecutionsSince).toHaveBeenCalledWith({
      workflowType: 'ai_conversation_reply',
      updatedSince: since,
      limit: 7,
    });
  });
});
