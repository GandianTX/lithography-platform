// src/features/ai-conversation/application/use-ai-diagnosis-workspace.spec.ts

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as download from '@/shared/download';
import { GraphQLIngressError } from '@/shared/graphql';

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

function buildSubmitResult(
  overrides: Partial<SubmitAiQuestionResult> = {},
): SubmitAiQuestionResult {
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

/** 可控 promise：用于在提交/确认在飞期间插入用户编辑与切换会话 */
function defer<T>() {
  let resolve: ((value: T) => void) | null = null;
  let reject: ((error: unknown) => void) | null = null;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: (value: T) => resolve?.(value),
    reject: (error: unknown) => reject?.(error),
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
    expect(
      result.current.visualization?.parts.find((part) => part.partId === 'reticle_arm')?.display,
    ).toBe('WARNING');
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

    // 与页面一致：输入框持有用户正文，提交的是同一份内容
    await act(async () => {
      result.current.setDraft('手臂 1 无动作');
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
    const retrySpy = vi
      .spyOn(adapter, 'retryAiQuestion')
      .mockResolvedValue(buildSubmitResult({ status: 'PENDING' }));
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

describe('P2-1：提交在飞期间的草稿编辑', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(adapter, 'listMyAiConversations').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    vi.spyOn(adapter, 'getMyAiConversation').mockImplementation(async (conversationId: number) =>
      buildDetail({ id: conversationId, turns: [] }),
    );
  });

  /** 提交 A 后、响应回写前编辑草稿 B；返回在飞的提交承诺（不在此处等待） */
  async function startSubmitThenEdit(
    result: { current: ReturnType<typeof useAiDiagnosisWorkspace> },
    nextDraft: string,
  ): Promise<{ pending: Promise<unknown> }> {
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      result.current.setDraft('问题 A');
    });
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = result.current.submitQuestion('问题 A');
      await Promise.resolve();
    });
    await act(async () => {
      result.current.setDraft(nextDraft);
    });
    return { pending };
  }

  it('直接成功：A 结果照常写入，编辑中的 B 不被清空', async () => {
    const submit = defer<SubmitAiQuestionResult>();
    vi.spyOn(adapter, 'submitAiQuestion').mockReturnValue(submit.promise);
    vi.spyOn(adapter, 'getAiQuestionStatus').mockImplementation(
      () => new Promise<AiQuestionStatus>(() => undefined),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    const { pending } = await startSubmitThenEdit(result, '问题 B');
    await act(async () => {
      submit.resolve(buildSubmitResult());
      await pending;
    });

    expect(result.current.draft).toBe('问题 B');
    expect(result.current.activeQuestionUuid).toBe(QUESTION_UUID);
    expect(result.current.submitting).toBe(false);
  });

  it('失败且未受理：保留编辑后的草稿，不再回填提交文本', async () => {
    const submit = defer<SubmitAiQuestionResult>();
    vi.spyOn(adapter, 'submitAiQuestion').mockReturnValue(submit.promise);
    vi.spyOn(adapter, 'getAiQuestionStatus').mockRejectedValue(new Error('not found'));

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    const { pending } = await startSubmitThenEdit(result, '问题 B');
    await act(async () => {
      submit.reject(new Error('network down'));
      await pending;
    });

    expect(result.current.draft).toBe('问题 B');
    expect(result.current.errorMessage).not.toBeNull();
    expect(result.current.activeQuestionUuid).toBeNull();
  });

  it('结果未知但已受理：保留编辑后的草稿并按已受理提示', async () => {
    const submit = defer<SubmitAiQuestionResult>();
    const confirm = defer<AiQuestionStatus>();
    vi.spyOn(adapter, 'submitAiQuestion').mockReturnValue(submit.promise);
    vi.spyOn(adapter, 'getAiQuestionStatus')
      .mockReturnValueOnce(confirm.promise)
      .mockImplementation(() => new Promise<AiQuestionStatus>(() => undefined));

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    const { pending } = await startSubmitThenEdit(result, '问题 B');
    await act(async () => {
      submit.reject(new Error('timeout'));
      await Promise.resolve();
    });
    await act(async () => {
      confirm.resolve(buildStatus({ status: 'RUNNING' }));
      await pending;
    });

    expect(result.current.draft).toBe('问题 B');
    expect(result.current.activeQuestionUuid).toBe(QUESTION_UUID);
    expect(result.current.noticeMessage).not.toBeNull();
  });

  it('无编辑时成功仍按原规则清空草稿', async () => {
    vi.spyOn(adapter, 'submitAiQuestion').mockResolvedValue(buildSubmitResult());
    vi.spyOn(adapter, 'getAiQuestionStatus').mockImplementation(
      () => new Promise<AiQuestionStatus>(() => undefined),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      result.current.setDraft('问题 A');
    });
    await act(async () => {
      await result.current.submitQuestion('问题 A');
    });

    expect(result.current.draft).toBe('');
  });

  it('在飞时删空输入，成功返回后保持空（不清空也不回填）', async () => {
    const submit = defer<SubmitAiQuestionResult>();
    vi.spyOn(adapter, 'submitAiQuestion').mockReturnValue(submit.promise);
    vi.spyOn(adapter, 'getAiQuestionStatus').mockImplementation(
      () => new Promise<AiQuestionStatus>(() => undefined),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    const { pending } = await startSubmitThenEdit(result, '');
    await act(async () => {
      submit.resolve(buildSubmitResult());
      await pending;
    });

    expect(result.current.draft).toBe('');
  });

  it('在飞时改回与提交文本相同的内容，仍按用户编辑保留', async () => {
    const submit = defer<SubmitAiQuestionResult>();
    vi.spyOn(adapter, 'submitAiQuestion').mockReturnValue(submit.promise);
    vi.spyOn(adapter, 'getAiQuestionStatus').mockImplementation(
      () => new Promise<AiQuestionStatus>(() => undefined),
    );

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    const { pending } = await startSubmitThenEdit(result, '问题 B');
    await act(async () => {
      result.current.setDraft('问题 A');
    });
    await act(async () => {
      submit.resolve(buildSubmitResult());
      await pending;
    });

    expect(result.current.draft).toBe('问题 A');
  });

  it('确认期间切会话：迟到的确认结果不写入新会话', async () => {
    const submit = defer<SubmitAiQuestionResult>();
    const confirm = defer<AiQuestionStatus>();
    vi.spyOn(adapter, 'submitAiQuestion').mockReturnValue(submit.promise);
    vi.spyOn(adapter, 'getAiQuestionStatus')
      .mockReturnValueOnce(confirm.promise)
      .mockImplementation(() => new Promise<AiQuestionStatus>(() => undefined));

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    const { pending } = await startSubmitThenEdit(result, '问题 B');
    await act(async () => {
      submit.reject(new Error('timeout'));
      await Promise.resolve();
    });
    // 确认在飞时切到另一个会话
    await act(async () => {
      await result.current.selectConversation(9);
    });
    await act(async () => {
      confirm.resolve(buildStatus({ status: 'SUCCEEDED' }));
      await pending;
    });

    expect(result.current.selectedId).toBe(9);
    expect(result.current.conversation?.id).toBe(9);
    expect(result.current.draft).toBe('');
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.noticeMessage).toBeNull();
    expect(result.current.activeQuestionUuid).toBeNull();
  });

  it('换文本重试使用新 UUID，不沿用上一条失败问题', async () => {
    const submitSpy = vi
      .spyOn(adapter, 'submitAiQuestion')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(buildSubmitResult());
    vi.spyOn(adapter, 'getAiQuestionStatus')
      .mockRejectedValueOnce(new Error('not found'))
      .mockImplementation(() => new Promise<AiQuestionStatus>(() => undefined));

    const { result } = renderHook(() => useAiDiagnosisWorkspace());
    await act(async () => {
      await result.current.selectConversation(CONVERSATION_ID);
    });
    await act(async () => {
      result.current.setDraft('问题 A');
    });
    await act(async () => {
      await result.current.submitQuestion('问题 A');
    });
    await act(async () => {
      result.current.setDraft('问题 B');
    });
    await act(async () => {
      await result.current.submitQuestion('问题 B');
    });

    expect(submitSpy.mock.calls[1][0].question).toBe('问题 B');
    expect(submitSpy.mock.calls[1][0].questionUuid).not.toBe(
      submitSpy.mock.calls[0][0].questionUuid,
    );
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
      .mockResolvedValue(
        buildStatus({ status: 'SUCCEEDED', visualization: buildVisualization('NORMAL') as never }),
      );

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
    const listSpy = vi
      .spyOn(adapter, 'listMyAiConversations')
      .mockImplementation(async ({ page }) => ({
        items: [
          {
            id: page * 10,
            requestId: null,
            status: 'ACTIVE',
            contentVersion: 1,
            createdAt: '2026-11-19T00:00:00.000Z',
            title: `c${page}`,
            turnCount: 0,
            lastMessageAt: null,
          } as never,
        ],
        total: 21,
        page,
        pageSize: 20,
      }));
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
      .mockResolvedValueOnce(
        buildStatus({ status: 'SUCCEEDED', visualization: buildVisualization('WARNING') as never }),
      )
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

  describe('S1：草稿优先', () => {
    it('首次发送才创建会话，并把所选工单写入创建请求', async () => {
      const createSpy = vi.spyOn(adapter, 'createAiConversation').mockResolvedValue({
        id: CONVERSATION_ID,
        requestId: 88,
        requestNo: 'MR-20261120-001',
        status: 'ACTIVE',
        contentVersion: 1,
        createdAt: '2026-11-19T00:00:00.000Z',
      });
      vi.spyOn(adapter, 'submitAiQuestion').mockResolvedValue(buildSubmitResult());
      const { result } = renderHook(() => useAiDiagnosisWorkspace());

      await act(async () => {
        result.current.setDraftRequestId(88);
        result.current.setDraft('手臂 1 无动作');
      });
      expect(createSpy).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.submitQuestion('手臂 1 无动作');
      });

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0][0]).toBe(88);
      expect(result.current.selectedId).toBe(CONVERSATION_ID);
      expect(result.current.draftRequestId).toBeNull();
    });

    it('新建只回空草稿，不产生会话写请求', async () => {
      const createSpy = vi.spyOn(adapter, 'createAiConversation');
      const { result } = renderHook(() => useAiDiagnosisWorkspace());
      await act(async () => {
        result.current.setDraft('未发送的草稿');
        result.current.setDraftRequestId(9);
      });

      await act(async () => {
        result.current.startNewDraft();
      });

      expect(createSpy).not.toHaveBeenCalled();
      expect(result.current.draft).toBe('');
      expect(result.current.draftRequestId).toBeNull();
      expect(result.current.selectedId).toBeNull();
    });

    it('创建结果未知时停止自动再建，保留草稿并要求显式新建', async () => {
      const createSpy = vi
        .spyOn(adapter, 'createAiConversation')
        .mockRejectedValueOnce(new Error('timeout'));
      const { result } = renderHook(() => useAiDiagnosisWorkspace());
      await act(async () => {
        result.current.setDraft('手臂 1 无动作');
        result.current.setDraftRequestId(7);
        await result.current.submitQuestion('手臂 1 无动作');
      });

      expect(result.current.createUnknown).toBe(true);
      expect(result.current.draft).toBe('手臂 1 无动作');
      expect(result.current.submitting).toBe(false);

      await act(async () => {
        await result.current.submitQuestion('手臂 1 无动作');
      });
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(result.current.errorMessage).toContain('无法确认');
    });

    /**
     * 明确拒绝（服务端已答复）与结果未知的恢复分支。
     *
     * 服务端明确拒绝时会话确定未创建，不得把用户挡在「新建对话」之外；
     * 结果未知仍要阻止重复创建，但恢复与放弃都必须保留草稿。
     */
    /**
     * 创建失败的性质区分与显式恢复。
     *
     * 只有能证明「写入前被拒绝」的响应才算明确拒绝（可改工单后重试）；其余一律按
     * 结果未知处理：阻断隐式重建，不自动接管、不自动发送，也不按工单／时间／空
     * 消息猜测本次会话是否已建出。
     */
    describe('创建失败的性质区分与显式恢复', () => {
      /** 写入前被拒绝（工单权限不足）：能证明会话未创建 */
      const rejectedError = () =>
        new GraphQLIngressError({
          type: 'graphql',
          message: 'FORBIDDEN',
          graphqlErrors: [
            {
              message: 'FORBIDDEN',
              extensions: {
                code: 'FORBIDDEN',
                errorCode: 'AI_CONVERSATION_FORBIDDEN',
                errorMessage: '无权访问所选工单',
              },
            },
          ],
        });
      /** COMMIT 阶段失败：后端映射成 INTERNAL_SERVER_ERROR，无法证明未写入 */
      const commitFailureError = () =>
        new GraphQLIngressError({
          type: 'graphql',
          message: 'Internal Server Error',
          graphqlErrors: [
            { message: 'Internal Server Error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
          ],
        });
      /** 混合错误：含认证错误时也可能有执行错误，不能只看第一条 */
      const mixedError = () =>
        new GraphQLIngressError({
          type: 'graphql',
          message: 'mixed',
          graphqlErrors: [
            { message: 'UNAUTHENTICATED', extensions: { code: 'UNAUTHENTICATED' } },
            { message: 'Internal Server Error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
          ],
        });
      /** 传输层中断：拿不到 GraphQL 错误体 */
      const networkError = () =>
        new GraphQLIngressError({ type: 'network', message: '网络连接异常' });
      /** 认证层拒绝：共享层把含 UNAUTHENTICATED 的错误体归一为 type='auth' */
      const authRejectedError = () =>
        new GraphQLIngressError({
          type: 'auth',
          message: 'JWT 认证失败',
          graphqlErrors: [{ message: 'UNAUTHENTICATED', extensions: { code: 'UNAUTHENTICATED' } }],
        });

      const createdConversation = (requestId: number) => ({
        id: CONVERSATION_ID,
        requestId,
        requestNo: `RR-${requestId}`,
        status: 'ACTIVE' as const,
        contentVersion: 1,
        createdAt: '2026-11-20T08:00:00.000Z',
      });

      const setupUnknown = async (createError: () => unknown) => {
        const createSpy = vi
          .spyOn(adapter, 'createAiConversation')
          .mockRejectedValueOnce(createError() as never);
        const { result } = renderHook(() => useAiDiagnosisWorkspace());
        await act(async () => {
          result.current.setDraft('需要保留的现场描述');
          result.current.setDraftRequestId(7);
        });
        await act(async () => {
          await result.current.submitQuestion('需要保留的现场描述');
        });
        return { result, createSpy };
      };

      it('明确拒绝（FORBIDDEN）：不置未知态，保留草稿与工单选择，可直接重试', async () => {
        const { result, createSpy } = await setupUnknown(rejectedError);

        expect(result.current.createUnknown).toBe(false);
        expect(result.current.draft).toBe('需要保留的现场描述');
        expect(result.current.draftRequestId).toBe(7);
        expect(result.current.errorMessage).toBe('无权访问所选工单');

        // 明确拒绝未创建会话：再次发送必须真正重试，而不是要求先「新建对话」
        vi.spyOn(adapter, 'createAiConversation').mockResolvedValueOnce(createdConversation(7));
        await act(async () => {
          await result.current.submitQuestion('需要保留的现场描述');
        });

        expect(createSpy).toHaveBeenCalledTimes(2);
        // 会话已创建，工单绑定以服务端事实为准：本地草稿工单清空
        expect(result.current.draftRequestId).toBeNull();
      });

      it('明确拒绝后更换工单：仍可重试且保留草稿', async () => {
        const { result, createSpy } = await setupUnknown(rejectedError);
        expect(result.current.createUnknown).toBe(false);

        vi.spyOn(adapter, 'createAiConversation').mockResolvedValueOnce(createdConversation(8));
        await act(async () => {
          result.current.setDraftRequestId(8);
        });
        await act(async () => {
          await result.current.submitQuestion('需要保留的现场描述');
        });

        expect(createSpy).toHaveBeenCalledTimes(2);
        expect(createSpy.mock.calls[1][0]).toBe(8);
        expect(result.current.draft).toBe('需要保留的现场描述');
      });

      it('COMMIT 阶段失败（INTERNAL_SERVER_ERROR）：按结果未知阻断，不宣称未创建', async () => {
        const { result } = await setupUnknown(commitFailureError);

        expect(result.current.createUnknown).toBe(true);
        expect(result.current.draft).toBe('需要保留的现场描述');
        expect(result.current.errorMessage).toContain('无法确认');
      });

      it('混合错误（含认证与执行错误）：按结果未知阻断', async () => {
        const { result } = await setupUnknown(mixedError);

        expect(result.current.createUnknown).toBe(true);
      });

      it('结果未知：再次发送被阻断，不产生新的创建调用', async () => {
        const { result, createSpy } = await setupUnknown(networkError);
        expect(result.current.createUnknown).toBe(true);

        await act(async () => {
          await result.current.submitQuestion('需要保留的现场描述');
        });

        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(result.current.createUnknown).toBe(true);
        expect(result.current.draft).toBe('需要保留的现场描述');
      });

      it('结果未知：改工单不产生创建调用，未知态保持，草稿保留', async () => {
        const { result, createSpy } = await setupUnknown(networkError);
        expect(result.current.createUnknown).toBe(true);

        await act(async () => {
          result.current.setDraftRequestId(8);
        });

        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(result.current.createUnknown).toBe(true);
        expect(result.current.draftRequestId).toBe(8);
        expect(result.current.draft).toBe('需要保留的现场描述');
      });

      it('结果未知：显式确认继续后解除阻断，保留草稿与工单，且不自动发送', async () => {
        const { result, createSpy } = await setupUnknown(networkError);
        const submitSpy = vi.spyOn(adapter, 'submitAiQuestion');
        expect(result.current.createUnknown).toBe(true);

        await act(async () => {
          result.current.continueAfterUnknownCreate();
        });

        expect(result.current.createUnknown).toBe(false);
        expect(result.current.draft).toBe('需要保留的现场描述');
        expect(result.current.draftRequestId).toBe(7);
        // 确认只解除阻断，不代替用户发送
        expect(submitSpy).not.toHaveBeenCalled();
        expect(createSpy).toHaveBeenCalledTimes(1);

        // 用户再次主动发送才会真正创建
        vi.spyOn(adapter, 'createAiConversation').mockResolvedValueOnce(createdConversation(7));
        await act(async () => {
          await result.current.submitQuestion('需要保留的现场描述');
        });
        expect(createSpy).toHaveBeenCalledTimes(2);
      });

      it('结果未知：显式放弃后解除阻断，保留草稿与工单选择', async () => {
        const { result } = await setupUnknown(networkError);
        expect(result.current.createUnknown).toBe(true);

        await act(async () => {
          result.current.abandonUnknownCreate();
        });

        expect(result.current.createUnknown).toBe(false);
        expect(result.current.draft).toBe('需要保留的现场描述');
        expect(result.current.draftRequestId).toBe(7);
      });

      it('结果未知：列表里有同工单空会话也不自动接管，不宣称找到本次会话', async () => {
        const { result } = await setupUnknown(networkError);
        const listSpy = vi.spyOn(adapter, 'listMyAiConversations').mockResolvedValue({
          items: [
            {
              id: 88,
              requestId: 7,
              requestNo: 'RR-1',
              status: 'ACTIVE',
              contentVersion: 1,
              messageCount: 0,
              turnCount: 0,
              lastMessageAt: null,
              createdAt: new Date(Date.now() + 1000).toISOString(),
              completedAt: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        });
        const detailSpy = vi.spyOn(adapter, 'getMyAiConversation');

        expect(result.current.createUnknown).toBe(true);
        // 不自动选中任何会话，也不自动发送
        expect(result.current.selectedId).toBeNull();
        expect(result.current.conversation).toBeNull();
        expect(detailSpy).not.toHaveBeenCalled();
        // 不做「按工单／时间／空消息」的恢复查询：只有页面初始化那一次列表加载
        expect(listSpy).toHaveBeenCalledTimes(1);
      });

      it('结果未知：列表为空也不解除阻断', async () => {
        const { result } = await setupUnknown(networkError);
        vi.spyOn(adapter, 'listMyAiConversations').mockResolvedValue({
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
        });

        expect(result.current.createUnknown).toBe(true);
        expect(result.current.draft).toBe('需要保留的现场描述');
      });

      it('结果未知：打开历史会话被阻断，草稿保留且未切换', async () => {
        const { result } = await setupUnknown(networkError);
        const detailSpy = vi.spyOn(adapter, 'getMyAiConversation');
        expect(result.current.createUnknown).toBe(true);

        await act(async () => {
          await result.current.selectConversation(88);
        });

        expect(result.current.selectedId).toBeNull();
        expect(result.current.draft).toBe('需要保留的现场描述');
        expect(result.current.createUnknown).toBe(true);
        expect(detailSpy).not.toHaveBeenCalled();
      });

      it('结果未知：新建对话不解除未知态（须先显式确认）', async () => {
        const { result } = await setupUnknown(networkError);
        expect(result.current.createUnknown).toBe(true);

        await act(async () => {
          result.current.startNewDraft();
        });

        // 无提示不得解除保护
        expect(result.current.createUnknown).toBe(true);
        expect(result.current.draft).toBe('需要保留的现场描述');
        expect(result.current.draftRequestId).toBe(7);
      });

      it('结果未知：显式建会话入口同样被阻断，不产生创建调用也不解除未知态', async () => {
        const { result, createSpy } = await setupUnknown(networkError);
        expect(result.current.createUnknown).toBe(true);

        await act(async () => {
          await result.current.createConversation(7);
        });

        // 不得绕过保护去建第二个会话，也不得顺带解除未知态
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(result.current.createUnknown).toBe(true);
        expect(result.current.draft).toBe('需要保留的现场描述');
        expect(result.current.draftRequestId).toBe(7);
        expect(result.current.errorMessage).toContain('无法确认');
      });

      it('认证层拒绝（UNAUTHENTICATED，生产形态 type=auth）：按明确拒绝处理，不置未知态', async () => {
        const { result } = await setupUnknown(authRejectedError);

        // 守卫阶段拒绝可证明未创建：不阻断重试，也不得宣称「结果无法确认」
        expect(result.current.createUnknown).toBe(false);
        expect(result.current.draft).toBe('需要保留的现场描述');
        expect(result.current.draftRequestId).toBe(7);
        expect(result.current.errorMessage).not.toBeNull();
        expect(result.current.errorMessage).not.toContain('无法确认');
      });
    });

    it('创建成功但提问失败：重试沿用同一会话与同一问题 UUID', async () => {
      const createSpy = vi.spyOn(adapter, 'createAiConversation').mockResolvedValue({
        id: CONVERSATION_ID,
        requestId: null,
        requestNo: '',
        status: 'ACTIVE',
        contentVersion: 1,
        createdAt: '2026-11-19T00:00:00.000Z',
      });
      const submitSpy = vi
        .spyOn(adapter, 'submitAiQuestion')
        .mockRejectedValueOnce(new Error('network down'));
      vi.spyOn(adapter, 'getAiQuestionStatus').mockRejectedValue(new Error('not found'));

      const { result } = renderHook(() => useAiDiagnosisWorkspace());
      await act(async () => {
        await result.current.submitQuestion('手臂 1 无动作');
      });
      const firstUuid = submitSpy.mock.calls[0][0].questionUuid;

      submitSpy.mockResolvedValueOnce(buildSubmitResult());
      await act(async () => {
        await result.current.submitQuestion('手臂 1 无动作');
      });

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(submitSpy.mock.calls[1][0].conversationId).toBe(CONVERSATION_ID);
      expect(submitSpy.mock.calls[1][0].questionUuid).toBe(firstUuid);
    });
  });
});
