// src/features/ai-conversation/application/use-ai-conversation-console.spec.ts
// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as adapter from '../infrastructure/ai-conversation-adapter';

import { useAiConversationConsole } from './use-ai-conversation-console';

/**
 * 任务05 S1：AI 对话控制台的稳定 UUID 语义（A05-02 前端半边）。
 *
 * 覆盖：
 * - 同一文本重试沿用同一 questionUuid（网络失败后重试不产生第二条用户问题）；
 * - 提交成功后释放 UUID，下一次同样文本获得新 UUID；
 * - 不同文本使用不同 UUID。
 */

const emptyDetail = {
  id: 1,
  requestId: null,
  requestNo: '',
  status: 'ACTIVE' as const,
  contentVersion: 2,
  createdAt: '2026-11-18T10:00:00.000Z',
  completedAt: null,
  messages: [],
  turns: [],
};

const baseStatus = {
  conversationId: 1,
  questionUuid: 'uuid',
  status: 'PENDING' as const,
  failureReason: null,
  contentVersion: 2,
  turnNo: 1,
  questionText: '问题',
  answer: null,
  visualization: null,
};

describe('useAiConversationConsole', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(adapter, 'listMyAiConversations').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    vi.spyOn(adapter, 'getMyAiConversation').mockResolvedValue(emptyDetail);
    vi.spyOn(adapter, 'getAiQuestionStatus').mockResolvedValue(baseStatus);
    vi.spyOn(adapter, 'createAiConversation').mockResolvedValue({
      id: 1,
      requestId: null,
      requestNo: '',
      status: 'ACTIVE',
      contentVersion: 1,
      createdAt: '2026-11-18T10:00:00.000Z',
    });
  });

  it('同一文本重试沿用同一 questionUuid', async () => {
    const submitSpy = vi
      .spyOn(adapter, 'submitAiQuestion')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        conversationId: 1,
        questionUuid: 'generated',
        status: 'PENDING',
        turnNo: 1,
        messageSeq: 1,
        contentVersion: 2,
        replayed: false,
        dispatchStatus: 'QUEUED',
      });

    const { result } = renderHook(() => useAiConversationConsole());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.createConversation(null);
    });
    await waitFor(() => expect(result.current.selectedId).toBe(1));

    await act(async () => {
      await result.current.submitQuestion('对准偏差如何排查');
    });
    await act(async () => {
      await result.current.submitQuestion('对准偏差如何排查');
    });

    expect(submitSpy).toHaveBeenCalledTimes(2);
    const firstUuid = submitSpy.mock.calls[0][0].questionUuid;
    const secondUuid = submitSpy.mock.calls[1][0].questionUuid;
    expect(firstUuid).toBe(secondUuid);
    expect(firstUuid).toMatch(/[0-9a-f-]{36}/);
  });

  it('提交成功后释放 UUID，同样文本再次提交得到新 UUID', async () => {
    const submitSpy = vi.spyOn(adapter, 'submitAiQuestion').mockResolvedValue({
      conversationId: 1,
      questionUuid: 'generated',
      status: 'PENDING',
      turnNo: 1,
      messageSeq: 1,
      contentVersion: 2,
      replayed: false,
      dispatchStatus: 'QUEUED',
    });

    const { result } = renderHook(() => useAiConversationConsole());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.createConversation(null);
    });
    await waitFor(() => expect(result.current.selectedId).toBe(1));

    await act(async () => {
      await result.current.submitQuestion('同一个问题');
    });
    await act(async () => {
      await result.current.submitQuestion('同一个问题');
    });

    const firstUuid = submitSpy.mock.calls[0][0].questionUuid;
    const secondUuid = submitSpy.mock.calls[1][0].questionUuid;
    expect(firstUuid).not.toBe(secondUuid);
  });

  it('空问题与未选会话不会发起提交', async () => {
    const submitSpy = vi.spyOn(adapter, 'submitAiQuestion');
    const { result } = renderHook(() => useAiConversationConsole());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.submitQuestion('   ');
    });
    expect(submitSpy).not.toHaveBeenCalled();
    expect(result.current.errorMessage).toBe('请先选择或新建一个会话');
  });
});
