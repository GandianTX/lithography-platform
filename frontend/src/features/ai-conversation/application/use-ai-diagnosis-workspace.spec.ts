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
    // F03 后 selectConversation 会恢复最后一轮；此处模拟新建的空会话
    vi.mocked(adapter.getMyAiConversation).mockResolvedValueOnce(buildDetail({ turns: [] }));
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
    // 两个会话都按「无历史轮次」处理，让迟到响应只可能来自被切走的旧会话
    vi.mocked(adapter.getMyAiConversation).mockImplementation(async (conversationId: number) =>
      buildDetail({ id: conversationId, turns: [] }),
    );
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

  it('F03：早轮失败、末轮成功时可以单独重试原失败轮（沿用原 UUID，不新增问题）', async () => {
    const retrySpy = vi.spyOn(adapter, 'retryAiQuestion').mockResolvedValue(
      buildSubmitResult({ status: 'PENDING' }),
    );
    vi.mocked(adapter.getMyAiConversation).mockResolvedValue(
      buildDetail({
        turns: [
          {
            questionUuid: QUESTION_UUID,
            turnNo: 1,
            question: null,
            answer: null,
            analysisStatus: 'FAILED',
            failureReason: 'reply_timeout',
            analysisContentVersion: 2,
            completedAt: null,
          },
          {
            questionUuid: '99999999-2222-4333-8444-555555555555',
            turnNo: 2,
            question: null,
            answer: {
              messageId: 41,
              messageSeq: 4,
              turnNo: 2,
              role: 'ASSISTANT',
              questionUuid: null,
              text: '已定位',
              contentVersion: 3,
              createdAt: '2026-11-19T00:00:00.000Z',
            },
            analysisStatus: 'SUCCEEDED',
            failureReason: null,
            analysisContentVersion: 3,
            completedAt: null,
          },
        ],
      }),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      await result.current.retryTurn(QUESTION_UUID);
    });

    expect(retrySpy.mock.calls[0][0].questionUuid).toBe(QUESTION_UUID);
    expect(retrySpy.mock.calls[0][0].conversationId).toBe(CONVERSATION_ID);
    expect(result.current.activeQuestionUuid).toBe(QUESTION_UUID);
  });

  it('F03：非失败轮次不发起重试', async () => {
    const retrySpy = vi.spyOn(adapter, 'retryAiQuestion');
    vi.mocked(adapter.getMyAiConversation).mockResolvedValue(
      buildDetail({
        turns: [
          {
            questionUuid: QUESTION_UUID,
            turnNo: 1,
            question: null,
            answer: {
              messageId: 41,
              messageSeq: 4,
              turnNo: 2,
              role: 'ASSISTANT',
              questionUuid: null,
              text: '已定位',
              contentVersion: 3,
              createdAt: '2026-11-19T00:00:00.000Z',
            },
            analysisStatus: 'SUCCEEDED',
            failureReason: null,
            analysisContentVersion: 2,
            completedAt: null,
          },
        ],
      }),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      await result.current.retryTurn(QUESTION_UUID);
    });

    expect(retrySpy).not.toHaveBeenCalled();
    expect(result.current.errorMessage).not.toBeNull();
  });
  it('U05：创建期间单独暴露 creating，成功后关闭并以服务端会话为准', async () => {
    let releaseCreate: ((value: unknown) => void) | null = null;
    const createSpy = vi.spyOn(adapter, 'createAiConversation').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate = resolve as (value: unknown) => void;
        }) as never,
    );
    vi.mocked(adapter.getMyAiConversation).mockImplementation(async (conversationId: number) =>
      buildDetail({ id: conversationId, requestId: 42, turns: [] }),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    let creating: Promise<unknown> | null = null;
    await act(async () => {
      creating = result.current.createConversation(42);
    });

    // 创建在飞：输入区应据此锁定工单选择，避免待选值与服务端事实不一致
    expect(result.current.creating).toBe(true);
    expect(createSpy).toHaveBeenCalledWith(42);

    await act(async () => {
      releaseCreate?.({
        id: CONVERSATION_ID,
        requestId: 42,
        requestNo: 'R-42',
        status: 'ACTIVE',
        contentVersion: 1,
        createdAt: '2026-11-19T00:00:00.000Z',
      });
      await creating;
    });

    expect(result.current.creating).toBe(false);
    // 选中会话的工单关联来自服务端事实（创建时请求的 42）
    expect(result.current.conversation?.requestId).toBe(42);
  });

  it('U05：创建失败后 creating 复位，保留同一工单选择可直接重试', async () => {
    let rejectCreate: ((error: unknown) => void) | null = null;
    const createSpy = vi
      .spyOn(adapter, 'createAiConversation')
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectCreate = reject as (error: unknown) => void;
          }) as never,
      )
      .mockResolvedValueOnce({
        id: CONVERSATION_ID,
        requestId: 42,
        requestNo: 'R-42',
        status: 'ACTIVE',
        contentVersion: 1,
        createdAt: '2026-11-19T00:00:00.000Z',
      });
    vi.mocked(adapter.getMyAiConversation).mockImplementation(async (conversationId: number) =>
      buildDetail({ id: conversationId, requestId: 42, turns: [] }),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    let creating: Promise<unknown> | null = null;
    await act(async () => {
      creating = result.current.createConversation(42);
    });
    await act(async () => {
      rejectCreate?.(new Error('create failed'));
      await creating;
    });

    expect(result.current.creating).toBe(false);
    expect(result.current.errorMessage).not.toBeNull();

    await act(async () => {
      await result.current.createConversation(42);
    });

    // 失败后仍可用同一待选工单重试，且创建态不残留
    expect(createSpy).toHaveBeenLastCalledWith(42);
    expect(result.current.creating).toBe(false);
    expect(result.current.conversation?.requestId).toBe(42);
  });

  it('U05：创建在飞时切换历史，迟到的 finally 不得把新页面置回创建态', async () => {
    let releaseCreate: ((value: unknown) => void) | null = null;
    vi.spyOn(adapter, 'createAiConversation').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate = resolve as (value: unknown) => void;
        }) as never,
    );
    vi.mocked(adapter.getMyAiConversation).mockImplementation(async (conversationId: number) =>
      buildDetail({ id: conversationId, turns: [] }),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    let creating: Promise<unknown> | null = null;
    await act(async () => {
      creating = result.current.createConversation(42);
    });
    expect(result.current.creating).toBe(true);

    await act(async () => {
      await result.current.selectConversation(9);
    });
    expect(result.current.creating).toBe(false);

    await act(async () => {
      releaseCreate?.({
        id: CONVERSATION_ID,
        requestId: 42,
        requestNo: 'R-42',
        status: 'ACTIVE',
        contentVersion: 1,
        createdAt: '2026-11-19T00:00:00.000Z',
      });
      await creating;
    });

    expect(result.current.selectedId).toBe(9);
    expect(result.current.creating).toBe(false);
    expect(result.current.errorMessage).toBeNull();
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
  it('F03：切回仍在生成的会话时恢复生成中并继续轮询到终态', async () => {
    vi.mocked(adapter.getMyAiConversation).mockResolvedValue(buildDetail());
    const statusSpy = vi
      .spyOn(adapter, 'getAiQuestionStatus')
      .mockResolvedValueOnce(buildStatus({ status: 'PENDING' }))
      .mockResolvedValue(
        buildStatus({ status: 'SUCCEEDED', visualization: buildVisualization('WARNING') as never }),
      );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });

    expect(result.current.generating).toBe(true);
    expect(result.current.activeQuestionUuid).toBe(QUESTION_UUID);

    await waitFor(() => expect(result.current.generating).toBe(false), { timeout: 4000 });
    expect(statusSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.visualization).not.toBeNull();
  });

  it('F03／F10：打开已成功的历史只恢复正文与状态，不回补旧图也不启动轮询', async () => {
    vi.mocked(adapter.getMyAiConversation).mockResolvedValue(
      buildDetail({
        turns: [
          {
            questionUuid: QUESTION_UUID,
            turnNo: 1,
            question: null,
            answer: null,
            analysisStatus: 'SUCCEEDED',
            failureReason: null,
            analysisContentVersion: 2,
            completedAt: null,
          },
        ],
      }),
    );
    const statusSpy = vi
      .spyOn(adapter, 'getAiQuestionStatus')
      .mockResolvedValue(buildStatus({ status: 'SUCCEEDED', visualization: buildVisualization('NORMAL') as never }));

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });

    // F10：成功历史画面回流程参考图，不再为「恢复旧图」发起一次迟到响应
    expect(result.current.generating).toBe(false);
    expect(result.current.conversation?.id).toBe(CONVERSATION_ID);
    expect(statusSpy).not.toHaveBeenCalled();
    expect(result.current.visualization).toBeNull();
  });

  it('F06：创建请求在飞时重复触发不会创建第二个会话', async () => {
    let releaseCreate: ((value: unknown) => void) | null = null;
    const createSpy = vi.spyOn(adapter, 'createAiConversation').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate = resolve as (value: unknown) => void;
        }) as never,
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    let first: Promise<unknown> | null = null;
    let second: Promise<unknown> | null = null;
    await act(async () => {
      first = result.current.createConversation(null);
      second = result.current.createConversation(null);
      releaseCreate?.({
        id: CONVERSATION_ID,
        requestId: null,
        requestNo: '',
        status: 'ACTIVE',
        contentVersion: 1,
        createdAt: '2026-11-19T00:00:00.000Z',
      });
      await Promise.all([first, second]);
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('F06：提交在飞时再次提交被忽略（连点/回车连发）', async () => {
    vi.mocked(adapter.getMyAiConversation).mockResolvedValue(buildDetail({ turns: [] }));
    let releaseSubmit: ((value: unknown) => void) | null = null;
    const submitSpy = vi.spyOn(adapter, 'submitAiQuestion').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSubmit = resolve as (value: unknown) => void;
        }) as never,
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      const first = result.current.submitQuestion('手臂 1 无动作');
      const second = result.current.submitQuestion('手臂 1 无动作');
      releaseSubmit?.(buildSubmitResult());
      await Promise.all([first, second]);
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('C1：创建等待中用户改选历史后，创建返回不得抢占该选择', async () => {
    let releaseCreate: ((value: unknown) => void) | null = null;
    vi.spyOn(adapter, 'createAiConversation').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate = resolve as (value: unknown) => void;
        }) as never,
    );
    vi.mocked(adapter.getMyAiConversation).mockImplementation(async (conversationId: number) =>
      buildDetail({ id: conversationId, turns: [] }),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    let creating: Promise<unknown> | null = null;
    await act(async () => {
      creating = result.current.createConversation(null);
    });
    // 创建在飞时用户改选历史会话 9
    await act(async () => {
      await result.current.selectConversation(9);
    });
    await act(async () => {
      releaseCreate?.({
        id: CONVERSATION_ID,
        requestId: null,
        requestNo: '',
        status: 'ACTIVE',
        contentVersion: 1,
        createdAt: '2026-11-19T00:00:00.000Z',
      });
      await creating;
    });

    expect(result.current.selectedId).toBe(9);
    expect(result.current.conversation?.id).toBe(9);
  });

  it('C1：创建返回的迟到失败不得清掉用户新输入与提示', async () => {
    let rejectCreate: ((error: unknown) => void) | null = null;
    vi.spyOn(adapter, 'createAiConversation').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreate = reject as (error: unknown) => void;
        }) as never,
    );
    vi.mocked(adapter.getMyAiConversation).mockImplementation(async (conversationId: number) =>
      buildDetail({ id: conversationId, turns: [] }),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    let creating: Promise<unknown> | null = null;
    await act(async () => {
      creating = result.current.createConversation(null);
    });
    await act(async () => {
      await result.current.selectConversation(9);
    });
    await act(async () => {
      rejectCreate?.(new Error('create failed late'));
      await creating;
    });

    expect(result.current.selectedId).toBe(9);
    expect(result.current.errorMessage).toBeNull();
  });

  it('C3：第二页后新建，首页 page/total 复位，下一次仍请求第 2 页', async () => {
    const listSpy = vi.spyOn(adapter, 'listMyAiConversations').mockImplementation(
      async ({ page }) => ({
        items: [{ id: page * 10, requestId: null, status: 'ACTIVE', contentVersion: 1, createdAt: '2026-11-19T00:00:00.000Z', title: `c${page}`, turnCount: 0, lastMessageAt: null } as never],
        total: 21,
        page,
        pageSize: 20,
      }),
    );
    vi.spyOn(adapter, 'createAiConversation').mockResolvedValue({
      id: CONVERSATION_ID,
      requestId: null,
      requestNo: '',
      status: 'ACTIVE',
      contentVersion: 1,
      createdAt: '2026-11-19T00:00:00.000Z',
    });
    vi.mocked(adapter.getMyAiConversation).mockImplementation(async (conversationId: number) =>
      buildDetail({ id: conversationId, turns: [] }),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.loadConversations();
    });
    await act(async () => {
      await result.current.loadMoreConversations();
    });
    expect(result.current.conversationsPage).toBe(2);

    await act(async () => {
      await result.current.createConversation(null);
    });
    // 新建后统一回首页：items／page／total 一起复位
    expect(result.current.conversationsPage).toBe(1);
    expect(result.current.conversationsTotal).toBe(21);
    expect(result.current.conversations).toHaveLength(1);

    await act(async () => {
      await result.current.loadMoreConversations();
    });
    // 下一次实际请求第 2 页（而不是第 3 页）
    expect(listSpy.mock.calls.at(-1)?.[0]).toMatchObject({ page: 2 });
    expect(result.current.conversationsPage).toBe(2);
  });

  it('F03：状态查询失败后可用显式重查动作恢复（不必重开页面）', async () => {
    const statusSpy = vi
      .spyOn(adapter, 'getAiQuestionStatus')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(
        buildStatus({ status: 'SUCCEEDED', visualization: buildVisualization('NORMAL') as never }),
      );
    vi.spyOn(adapter, 'submitAiQuestion').mockResolvedValue(buildSubmitResult());
    vi.mocked(adapter.getMyAiConversation).mockResolvedValue(buildDetail({ turns: [] }));

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      await result.current.submitQuestion('手臂 1 无动作');
    });
    await act(async () => {
      await result.current.refreshCurrentTurn();
    });

    expect(statusSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.visualization).not.toBeNull();
    expect(result.current.generating).toBe(false);
  });

  it('F10：新一轮提交立即清除上一轮图形定位', async () => {
    vi.mocked(adapter.getMyAiConversation).mockResolvedValue(buildDetail({ turns: [] }));
    vi.spyOn(adapter, 'getAiQuestionStatus')
      .mockResolvedValueOnce(buildStatus({ status: 'SUCCEEDED', visualization: buildVisualization('WARNING') as never }))
      .mockImplementation(() => new Promise<AiQuestionStatus>(() => undefined));
    vi.spyOn(adapter, 'submitAiQuestion').mockResolvedValue(buildSubmitResult());

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      await result.current.submitQuestion('第一轮问题');
    });
    await waitFor(() => expect(result.current.visualization).not.toBeNull(), { timeout: 4000 });

    await act(async () => {
      void result.current.submitQuestion('第二轮问题');
    });

    expect(result.current.visualization).toBeNull();
  });
});
