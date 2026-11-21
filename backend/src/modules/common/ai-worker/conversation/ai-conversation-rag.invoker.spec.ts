// src/infrastructure/ai/conversation/ai-conversation-rag.invoker.spec.ts
/// <reference types="jest" />

import {
  RAG_DIAGNOSIS_ERROR_CODES,
  type RagDiagnosisInput,
  type RagDiagnosisResult,
} from '@usecases/common/ports/rag-diagnosis-client.contract';

import type { AiConversationRequestEnvelope } from '@src/core/ai/ai-conversation-request.policy';

import {
  AI_CONVERSATION_RAG_PROVIDER,
  RagAiConversationModelInvoker,
  toRagDiagnosisInput,
} from './ai-conversation-rag.invoker';
import { AiConversationModelFailureError } from './ai-conversation-model.types';

const QUESTION_UUID = '3f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const REQUEST: AiConversationRequestEnvelope = {
  schemaVersion: 1,
  requestId: QUESTION_UUID,
  sceneId: 'LITHO_WORKFLOW_V1',
  question: '对准偏差如何排查？',
  history: [
    { role: 'USER', content: '曝光台报警' },
    { role: 'ASSISTANT', content: '先核对取板台状态' },
  ],
  context: {
    mode: 'WORK_ORDER',
    equipmentModelCode: 'LITHO-9000',
    stage: 3,
    fault: { mainError: '0', unitError: null, source: 'PLC' },
  },
};

const INVOKE_INPUT = {
  request: REQUEST,
  provider: null,
  model: 'qwen-plus',
  metadata: { workflowId: 'wf-1', workflowType: 'ai_conversation_reply', traceId: 'trace-1' },
};

const SUCCESS: RagDiagnosisResult = {
  ok: true,
  requestId: QUESTION_UUID,
  text: '建议先核对取板台真空与定位激光。',
  visualization: {
    sceneId: 'LITHO_WORKFLOW_V1',
    stage: 3,
    parts: [
      { partId: 'reticle_arm', display: 'HIGHLIGHT' },
      { partId: 'projection_lens', display: 'NORMAL' },
    ],
  },
};

describe('RagAiConversationModelInvoker', () => {
  let client: { diagnose: jest.Mock };
  let invoker: RagAiConversationModelInvoker;

  beforeEach(() => {
    client = { diagnose: jest.fn().mockResolvedValue(SUCCESS) };
    invoker = new RagAiConversationModelInvoker(client);
  });

  it('请求映射：历史 content→text、上下文与 requestId 原样透传', async () => {
    await invoker.invoke(INVOKE_INPUT);

    expect(client.diagnose).toHaveBeenCalledTimes(1);
    const mapped: RagDiagnosisInput = client.diagnose.mock.calls[0][0];
    expect(mapped).toEqual({
      requestId: QUESTION_UUID,
      question: '对准偏差如何排查？',
      history: [
        { role: 'USER', text: '曝光台报警' },
        { role: 'ASSISTANT', text: '先核对取板台状态' },
      ],
      context: {
        mode: 'WORK_ORDER',
        equipmentModelCode: 'LITHO-9000',
        stage: 3,
        fault: { mainError: '0', unitError: null, source: 'PLC' },
      },
    });
  });

  it('成功：正文与图形按公共结果映射，不产生 provider 调用记录', async () => {
    const result = await invoker.invoke(INVOKE_INPUT);

    expect(result.text).toBe(SUCCESS.ok ? SUCCESS.text : '');
    expect(result.visualization).toEqual({
      sceneId: 'LITHO_WORKFLOW_V1',
      stage: 3,
      parts: [
        { partId: 'reticle_arm', display: 'HIGHLIGHT' },
        { partId: 'projection_lens', display: 'NORMAL' },
      ],
    });
    expect(result.visualizationDegraded).toBe(false);
    expect(result.provider).toBe(AI_CONVERSATION_RAG_PROVIDER);
    expect(result.model).toBe('qwen-plus');
    expect(result.providerJobId).toBeNull();
    expect(result.providerRequestId).toBe(QUESTION_UUID);
    expect(result.generateResult).toBeNull();
    expect(result.devFixture).toBe(false);
  });

  it('图形缺失：正文保留并标记降级', async () => {
    client.diagnose.mockResolvedValue({
      ok: true,
      requestId: QUESTION_UUID,
      text: '有效正文',
      visualization: null,
    } satisfies RagDiagnosisResult);

    const result = await invoker.invoke(INVOKE_INPUT);

    expect(result.text).toBe('有效正文');
    expect(result.visualization).toBeNull();
    expect(result.visualizationDegraded).toBe(true);
  });

  it('失败：抛出可辨识失败码，不重试、不夹带原始载荷', async () => {
    client.diagnose.mockResolvedValue({
      ok: false,
      requestId: QUESTION_UUID,
      code: RAG_DIAGNOSIS_ERROR_CODES.TIMEOUT,
    } satisfies RagDiagnosisResult);

    const failure = invoker.invoke(INVOKE_INPUT);
    await expect(failure).rejects.toBeInstanceOf(AiConversationModelFailureError);
    await expect(failure).rejects.toMatchObject({ failureCode: 'TIMEOUT' });
    expect(client.diagnose).toHaveBeenCalledTimes(1);
  });

  it('映射函数可单独复用（不依赖 Nest 容器）', () => {
    expect(toRagDiagnosisInput(INVOKE_INPUT).history[0]).toEqual({
      role: 'USER',
      text: '曝光台报警',
    });
  });
});
