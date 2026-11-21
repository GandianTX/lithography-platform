// src/core/ai/ai-conversation-request.policy.spec.ts
// S2.1 验证落点：历史顺序与截断、阶段/故障上下文归一、信封最小面。

import {
  AI_CONVERSATION_HISTORY_ITEM_MAX_UNITS,
  AI_CONVERSATION_HISTORY_LIMIT,
  buildAiConversationRequest,
  selectAiConversationHistory,
  truncateAiHistoryText,
} from './ai-conversation-request.policy';

const UUID = '11111111-1111-4111-8111-111111111111';

const historyItem = (role: string, text: string) => ({ role, text });

describe('selectAiConversationHistory', () => {
  it('仅保留 USER/ASSISTANT 且正文非空，message_seq 升序取最近 12 条', () => {
    const items = [
      historyItem('USER', '一'),
      historyItem('SYSTEM', '系统消息（不进历史）'),
      historyItem('ASSISTANT', '答'),
      historyItem('USER', '   '),
      historyItem('TOOL', '工具'),
    ];
    const result = selectAiConversationHistory(items);
    expect(result.map((item) => item.content)).toEqual(['一', '答']);
    expect(result[0].role).toBe('USER');
  });

  it('超过 12 条时取最近 12 条且保持原顺序', () => {
    const items = Array.from({ length: AI_CONVERSATION_HISTORY_LIMIT + 3 }, (_, i) =>
      historyItem('USER', `m${i}`),
    );
    const result = selectAiConversationHistory(items);
    expect(result).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
    expect(result[0].content).toBe('m3');
    expect(result[11].content).toBe('m14');
  });

  it('单条超 2000 码元被截断', () => {
    const result = selectAiConversationHistory([historyItem('USER', '好'.repeat(2001))]);
    expect(result[0].content).toHaveLength(AI_CONVERSATION_HISTORY_ITEM_MAX_UNITS);
  });
});

describe('truncateAiHistoryText', () => {
  it('不超限原样返回', () => {
    expect(truncateAiHistoryText('abc', 10)).toBe('abc');
  });

  it('截断不切断代理对（emoji 高代理项被截时退一格）', () => {
    // 'a' + 😀（D83D DE00）共 3 码元；限制 2 会切在高位代理上
    const result = truncateAiHistoryText('a😀', 2);
    expect(result).toBe('a');
    expect(Array.from(result)).toHaveLength(1);
  });

  it('截断点落在普通字符上则直接截断', () => {
    expect(truncateAiHistoryText('abcd', 3)).toBe('abc');
  });
});

describe('buildAiConversationRequest', () => {
  it('信封最小面：不投递账号、公司标识或文件 URL', () => {
    const envelope = buildAiConversationRequest({
      questionUuid: UUID,
      question: '  问题  ',
      history: [historyItem('USER', '上一问'), historyItem('ASSISTANT', '上一答')],
      mode: 'WORK_ORDER',
      equipmentModelCode: ' EXR-1020i ',
      stage: 2,
      fault: { description: '手臂中断', gpibStatus: '0' },
    });
    expect(Object.keys(envelope).sort()).toEqual([
      'context',
      'history',
      'question',
      'requestId',
      'sceneId',
      'schemaVersion',
    ]);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.sceneId).toBe('LITHO_WORKFLOW_V1');
    expect(envelope.requestId).toBe(UUID);
    expect(envelope.question).toBe('问题');
    expect(JSON.stringify(envelope)).not.toContain('accountId');
    expect(JSON.stringify(envelope)).not.toContain('organizationId');
    expect(JSON.stringify(envelope)).not.toContain('http');
  });

  it('fault 按协议八字段输出，未知值填 null，字符串 "0" 保留', () => {
    const envelope = buildAiConversationRequest({
      questionUuid: UUID,
      question: '问题',
      history: [],
      mode: 'WORK_ORDER',
      fault: { description: '只有故障现象', gpibStatus: '0' },
    });
    expect(envelope.context.fault).toEqual({
      mainError: null,
      unitError: null,
      source: null,
      errorType: null,
      gpibStatus: '0',
      description: '只有故障现象',
      action: null,
      status: null,
    });
  });

  it('fault 全部未知 → 整体 null；独立会话缺省 fault 为 null', () => {
    const allUnknown = buildAiConversationRequest({
      questionUuid: UUID,
      question: '问题',
      history: [],
      mode: 'INDEPENDENT',
      fault: { mainError: '  ' },
    });
    expect(allUnknown.context.fault).toBeNull();
    const none = buildAiConversationRequest({
      questionUuid: UUID,
      question: '问题',
      history: [],
      mode: 'INDEPENDENT',
    });
    expect(none.context.mode).toBe('INDEPENDENT');
    expect(none.context.equipmentModelCode).toBeNull();
    expect(none.context.fault).toBeNull();
  });

  it('stage 缺省为 null；超范围抛错', () => {
    const envelope = buildAiConversationRequest({
      questionUuid: UUID,
      question: '问题',
      history: [],
      mode: 'INDEPENDENT',
    });
    expect(envelope.context.stage).toBeNull();

    for (const stage of [0, 11, 2.5]) {
      expect(() =>
        buildAiConversationRequest({
          questionUuid: UUID,
          question: '问题',
          history: [],
          mode: 'INDEPENDENT',
          stage,
        }),
      ).toThrow('ai_conversation_stage_invalid');
    }
  });

  it('机型编码 trim；空串归一为 null', () => {
    const envelope = buildAiConversationRequest({
      questionUuid: UUID,
      question: '问题',
      history: [],
      mode: 'WORK_ORDER',
      equipmentModelCode: '   ',
    });
    expect(envelope.context.equipmentModelCode).toBeNull();
  });
});
