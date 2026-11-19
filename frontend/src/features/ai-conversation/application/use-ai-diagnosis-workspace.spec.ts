// src/features/ai-conversation/application/use-ai-diagnosis-workspace.spec.ts

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as download from '@/shared/download';

import type {
  AiConversationDetail,
  AiQuestionStatus,
  SubmitAiQuestionResult,
} from '../infrastructure/ai-conversation.types';
import * as adapter from '../infrastructure/ai-conversation-adapter';

import { useAiDiagnosisWorkspace } from './use-ai-diagnosis-workspace';

const CONVERSATION_ID = 7;
const QUESTION_UUID = '11111111-2222-4333-8444-555555555555';

const PART_IDS = [
  'controller',
  'reticle_cassette',
  'reticle_arm',
  'reticle_table',
  'reticle_vacuum',
  'positioning_laser',
  'wafer_cassette',
  'wafer_arm',
  'alignment_table',
  'wafer_stage',
  'projection_lens',
];

function buildDetail(overrides: Partial<AiConversationDetail> = {}): AiConversationDetail {
  return {
    id: CONVERSATION_ID,
    requestId: null,
    requestNo: '',
    status: 'ACTIVE',
    contentVersion: 2,
    createdAt: '2026-11-19T00:00:00.000Z',
    completedAt: null,
    messages: [],
    turns: [
      {
        questionUuid: QUESTION_UUID,
        turnNo: 1,
        question: null,
        answer: null,
        analysisStatus: 'PENDING',
        failureReason: null,
        analysisContentVersion: 2,
        completedAt: null,
      },
    ],
    ...overrides,
  };
}

function buildStatus(overrides: Partial<AiQuestionStatus> = {}): AiQuestionStatus {
  return {
    conversationId: CONVERSATION_ID,
    questionUuid: QUESTION_UUID,
    status: 'PENDING',
    failureReason: null,
    contentVersion: 2,
    turnNo: 1,
    questionText: '手臂 1 无动作',
    answer: null,
    visualization: null,
    ...overrides,
  };
}

function buildSubmitResult(overrides: Partial<SubmitAiQuestionResult> = {}): SubmitAiQuestionResult {
  return {
    conversationId: CONVERSATION_ID,
    questionUuid: QUESTION_UUID,
    status: 'PENDING',
    turnNo: 1,
    messageSeq: 1,
    contentVersion: 2,
    replayed: false,
    dispatchStatus: 'QUEUED',
    ...overrides,
  };
}

function buildVisualization(display: string) {
  return {
    sceneId: 'LITHO_WORKFLOW_V1',
    stage: 2,
    parts: PART_IDS.map((partId) => ({ partId, display })),
  };
}

describe('useAiDiagnosisWorkspace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(adapter, 'listMyAiConversations').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    vi.spyOn(adapter, 'getMyAiConversation').mockImplementation(async (conversationId: number) =>
      buildDetail({ id: conversationId }),
    );
    vi.spyOn(adapter, 'getAiQuestionStatus').mockResolvedValue(buildStatus());
    vi.spyOn(adapter, 'createAiConversation').mockResolvedValue({
      id: CONVERSATION_ID,
      requestId: null,
      requestNo: '',
      status: 'ACTIVE',
      contentVersion: 1,
      createdAt: '2026-11-19T00:00:00.000Z',
    });
  });

  it('提交成功后进入生成中，轮询到成功并应用本轮图形', async () => {
    const statusSpy = vi
      .spyOn(adapter, 'getAiQuestionStatus')
      .mockResolvedValueOnce(buildStatus())
      .mockResolvedValueOnce(
        buildStatus({
          status: 'SUCCEEDED',
          visualization: {
            ...buildVisualization('NORMAL'),
            parts: PART_IDS.map((partId) => ({
              partId,
              display: partId === 'reticle_arm' ? 'WARNING' : 'NORMAL',
            })),
          } as never,
        }),
      );
    vi.spyOn(adapter, 'submitAiQuestion').mockResolvedValue(buildSubmitResult());

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });

    await act(async () => {
      await result.current.submitQuestion('手臂 1 无动作');
    });

    expect(result.current.activeQuestionUuid).toBe(QUESTION_UUID);
    expect(result.current.generating).toBe(true);

    await waitFor(() => expect(result.current.generating).toBe(false), { timeout: 4000 });
    expect(statusSpy).toHaveBeenCalled();
    expect(result.current.visualization?.parts.find((part) => part.partId === 'reticle_arm')?.display).toBe(
      'WARNING',
    );
  });

  it('提交失败时保留输入，并沿用同一问题 UUID', async () => {
    const submitSpy = vi
      .spyOn(adapter, 'submitAiQuestion')
      .mockRejectedValueOnce(new Error('network down'));
    vi.spyOn(adapter, 'getAiQuestionStatus').mockRejectedValue(new Error('not found'));

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });

    await act(async () => {
      await result.current.submitQuestion('手臂 1 无动作');
    });

    expect(result.current.draft).toBe('手臂 1 无动作');
    expect(result.current.errorMessage).not.toBeNull();

    const firstUuid = submitSpy.mock.calls[0][0].questionUuid;
    await act(async () => {
      await result.current.submitQuestion('手臂 1 无动作');
    });
    expect(submitSpy.mock.calls[1][0].questionUuid).toBe(firstUuid);
  });

  it('受理结果不明时先查原问题，查到即按已受理处理', async () => {
    vi.spyOn(adapter, 'submitAiQuestion').mockRejectedValue(new Error('timeout'));
    vi.spyOn(adapter, 'getAiQuestionStatus').mockResolvedValue(buildStatus({ status: 'RUNNING' }));

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });

    await act(async () => {
      await result.current.submitQuestion('手臂 1 无动作');
    });

    expect(result.current.errorMessage).toBeNull();
    expect(result.current.noticeMessage).not.toBeNull();
    expect(result.current.activeQuestionUuid).toBe(QUESTION_UUID);
  });

  it('切换会话后旧会话的迟到响应被丢弃', async () => {
    let releaseStatus: ((value: AiQuestionStatus) => void) | null = null;
    vi.spyOn(adapter, 'getAiQuestionStatus').mockImplementation(
      () =>
        new Promise<AiQuestionStatus>((resolve) => {
          releaseStatus = resolve;
        }),
    );
    vi.spyOn(adapter, 'submitAiQuestion').mockResolvedValue(buildSubmitResult());

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      await result.current.submitQuestion('手臂 1 无动作');
    });

    // 轮询请求在途：此时切换到另一个会话
    await act(async () => {
      await result.current.selectConversation(9);
    });

    await act(async () => {
      releaseStatus?.(
        buildStatus({
          status: 'SUCCEEDED',
          visualization: buildVisualization('WARNING') as never,
        }),
      );
      await Promise.resolve();
    });

    expect(result.current.selectedId).toBe(9);
    expect(result.current.visualization).toBeNull();
    expect(result.current.conversation?.id).toBe(9);
  });

  it('成功但无有效图形时清除旧定位（回到流程参考图）', async () => {
    vi.spyOn(adapter, 'getAiQuestionStatus').mockResolvedValue(
      buildStatus({ status: 'SUCCEEDED', visualization: null }),
    );
    vi.spyOn(adapter, 'submitAiQuestion').mockResolvedValue(buildSubmitResult());

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      await result.current.submitQuestion('手臂 1 无动作');
    });

    await waitFor(() => expect(result.current.generating).toBe(false), { timeout: 4000 });
    expect(result.current.visualization).toBeNull();
    expect(result.current.visualizationDegraded).toBe(false);
  });

  it('图形结构非法时标记降级并保留正文', async () => {
    vi.spyOn(adapter, 'getAiQuestionStatus').mockResolvedValue(
      buildStatus({
        status: 'SUCCEEDED',
        visualization: { sceneId: 'LITHO_WORKFLOW_V1', stage: 2, parts: [] } as never,
      }),
    );
    vi.spyOn(adapter, 'submitAiQuestion').mockResolvedValue(buildSubmitResult());

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      await result.current.submitQuestion('手臂 1 无动作');
    });

    await waitFor(() => expect(result.current.generating).toBe(false), { timeout: 4000 });
    expect(result.current.visualization).toBeNull();
    expect(result.current.visualizationDegraded).toBe(true);
  });

  it('重试失败轮次沿用同一问题 UUID', async () => {
    const retrySpy = vi.spyOn(adapter, 'retryAiQuestion').mockResolvedValue(
      buildSubmitResult({ status: 'PENDING' }),
    );
    vi.spyOn(adapter, 'submitAiQuestion').mockResolvedValue(buildSubmitResult());

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      await result.current.submitQuestion('手臂 1 无动作');
    });
    await act(async () => {
      await result.current.retryCurrentTurn();
    });

    expect(retrySpy.mock.calls[0][0].questionUuid).toBe(QUESTION_UUID);
    expect(retrySpy.mock.calls[0][0].conversationId).toBe(CONVERSATION_ID);
  });
});

describe('会话 PDF 导出（任务 05 · S4.2 · R039-01）', () => {
  const PDF_BASE64 = btoa('%PDF-1.7 export');

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(adapter, 'listMyAiConversations').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    vi.spyOn(adapter, 'getMyAiConversation').mockResolvedValue(buildDetail());
  });

  it('按当前内容版本导出，并把 Base64 字节落地为文件', async () => {
    const exportSpy = vi.spyOn(adapter, 'exportAiConversation').mockResolvedValue({
      format: 'PDF',
      filename: 'ai-conversation-7-v2.pdf',
      mimeType: 'application/pdf',
      contentVersion: 2,
      lastMessageSeq: 4,
      byteSize: PDF_BASE64.length,
      contentBase64: PDF_BASE64,
    });
    const saveSpy = vi.spyOn(download, 'saveBlobAsFile').mockImplementation(() => undefined);

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      await result.current.exportConversationPdf();
    });

    expect(exportSpy).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      contentVersion: 2,
      format: 'PDF',
    });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const [blob, filename] = saveSpy.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/pdf');
    expect(filename).toBe('ai-conversation-7-v2.pdf');
    expect(result.current.exporting).toBe(false);
    expect(result.current.errorMessage).toBeNull();
  });

  it('导出失败时给出错误提示，不落地空文件', async () => {
    vi.spyOn(adapter, 'exportAiConversation').mockRejectedValue(new Error('导出失败'));
    const saveSpy = vi.spyOn(download, 'saveBlobAsFile').mockImplementation(() => undefined);

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      await result.current.exportConversationPdf();
    });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(result.current.errorMessage).toBe('导出失败');
    expect(result.current.exporting).toBe(false);
  });

  it('没有选中会话时不发起导出', async () => {
    const exportSpy = vi.spyOn(adapter, 'exportAiConversation');

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.exportConversationPdf();
    });

    expect(exportSpy).not.toHaveBeenCalled();
  });
});
