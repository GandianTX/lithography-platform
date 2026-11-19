// src/core/ai/ai-conversation-reply.policy.spec.ts
// S2.3 验证落点：错信封／空文本／非法图形（只降级）各形态，以及合法边界。

import {
  AI_VISUALIZATION_DISPLAYS,
  AI_VISUALIZATION_PART_IDS,
  parseAiConversationReply,
  AiConversationReplyError,
} from './ai-conversation-reply.policy';
import { AI_CONVERSATION_SCENE_ID } from './ai-conversation-request.policy';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

const VALID_VISUALIZATION = {
  sceneId: AI_CONVERSATION_SCENE_ID,
  stage: 2,
  parts: AI_VISUALIZATION_PART_IDS.map((partId) => ({ partId, display: 'NORMAL' })),
};

const envelope = (overrides: Record<string, unknown> = {}, text = '有效正文'): string =>
  JSON.stringify({
    schemaVersion: 1,
    requestId: REQUEST_ID,
    content: { text, visualization: VALID_VISUALIZATION },
    ...overrides,
  });

describe('parseAiConversationReply · 失败关闭（整轮失败）', () => {
  it('非 JSON 文本 → invalid_json', () => {
    expect(() => parseAiConversationReply('not-json{', REQUEST_ID)).toThrow(
      new AiConversationReplyError('invalid_json', '模型回复不是合法 JSON 对象'),
    );
  });

  it('空白文本 → invalid_json', () => {
    expect(() => parseAiConversationReply('   ', REQUEST_ID)).toThrow(AiConversationReplyError);
  });

  it('JSON 数组 → invalid_json（信封必须是对象）', () => {
    expect(() => parseAiConversationReply('[]', REQUEST_ID)).toThrow(AiConversationReplyError);
  });

  it('schemaVersion 缺失或不为 1 → unsupported_schema_version', () => {
    expect(() =>
      parseAiConversationReply(
        JSON.stringify({ requestId: REQUEST_ID, content: { text: 'x' } }),
        REQUEST_ID,
      ),
    ).toThrow(
      new AiConversationReplyError('unsupported_schema_version', '模型回复的协议版本不受支持'),
    );
    expect(() => parseAiConversationReply(envelope({ schemaVersion: 2 }), REQUEST_ID)).toThrow(
      AiConversationReplyError,
    );
  });

  it('requestId 缺失或不一致 → request_id_mismatch（防串轮）', () => {
    expect(() => parseAiConversationReply(envelope({ requestId: 'other' }), REQUEST_ID)).toThrow(
      new AiConversationReplyError('request_id_mismatch', '模型回复的问题标识与请求不一致'),
    );
    expect(() =>
      parseAiConversationReply(
        JSON.stringify({ schemaVersion: 1, content: { text: 'x' } }),
        REQUEST_ID,
      ),
    ).toThrow(AiConversationReplyError);
  });

  it('content 缺失或非对象 → invalid_envelope', () => {
    expect(() => parseAiConversationReply(envelope({ content: 'text' }), REQUEST_ID)).toThrow(
      new AiConversationReplyError('invalid_envelope', '模型回复缺少 content 对象'),
    );
    expect(() =>
      parseAiConversationReply(
        JSON.stringify({ schemaVersion: 1, requestId: REQUEST_ID }),
        REQUEST_ID,
      ),
    ).toThrow(AiConversationReplyError);
  });

  it('正文缺失/空白 → empty_text', () => {
    expect(() => parseAiConversationReply(envelope({}, '   '), REQUEST_ID)).toThrow(
      new AiConversationReplyError('empty_text', '模型回复正文为空'),
    );
    expect(() =>
      parseAiConversationReply(
        JSON.stringify({ schemaVersion: 1, requestId: REQUEST_ID, content: {} }),
        REQUEST_ID,
      ),
    ).toThrow(AiConversationReplyError);
  });

  it('正文超 12000 码元 → text_too_long', () => {
    expect(() => parseAiConversationReply(envelope({}, '好'.repeat(12001)), REQUEST_ID)).toThrow(
      new AiConversationReplyError('text_too_long', '模型回复正文超出长度上限'),
    );
  });
});

describe('parseAiConversationReply · 图形只降级（正文保留）', () => {
  const parse = (raw: string) => parseAiConversationReply(raw, REQUEST_ID);

  it('visualization 缺失 → 正文保留、degraded=false（协议：兼容键遗漏）', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      requestId: REQUEST_ID,
      content: { text: '正文' },
    });
    const r = parse(raw);
    expect(r.text).toBe('正文');
    expect(r.visualization).toBeNull();
    expect(r.visualizationDegraded).toBe(false);
  });

  it('visualization 显式 null → 不降级（协议：证据不足显式 null）', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      requestId: REQUEST_ID,
      content: { text: '正文', visualization: null },
    });
    expect(parse(raw).visualizationDegraded).toBe(false);
  });

  it.each([
    ['非对象', 'garbage'],
    ['sceneId 不符', { ...VALID_VISUALIZATION, sceneId: 'OTHER' }],
    ['stage 非法（0）', { ...VALID_VISUALIZATION, stage: 0 }],
    ['stage 非法（11）', { ...VALID_VISUALIZATION, stage: 11 }],
    ['stage 非整数', { ...VALID_VISUALIZATION, stage: 1.5 }],
    ['parts 缺失', { ...VALID_VISUALIZATION, parts: undefined }],
    [
      'parts 数量不足（缺失部件即降级）',
      { ...VALID_VISUALIZATION, parts: VALID_VISUALIZATION.parts.slice(0, 10) },
    ],
    ['parts 空', { ...VALID_VISUALIZATION, parts: [] }],
    [
      '部件重复',
      {
        ...VALID_VISUALIZATION,
        parts: [...VALID_VISUALIZATION.parts.slice(0, 10), VALID_VISUALIZATION.parts[0]],
      },
    ],
    [
      '未知部件',
      {
        ...VALID_VISUALIZATION,
        parts: [...VALID_VISUALIZATION.parts.slice(1), { partId: 'nope', display: 'NORMAL' }],
      },
    ],
    [
      '未知展示态',
      {
        ...VALID_VISUALIZATION,
        parts: [...VALID_VISUALIZATION.parts.slice(1), { partId: 'controller', display: 'FLASHY' }],
      },
    ],
    [
      '部件项非对象',
      { ...VALID_VISUALIZATION, parts: [...VALID_VISUALIZATION.parts.slice(1), 'controller'] },
    ],
  ])('非法图形（%s）→ visualization=null 且 degraded=true、正文保留', (_name, visualization) => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      requestId: REQUEST_ID,
      content: { text: '正文保留', visualization },
    });
    const r = parse(raw);
    expect(r.visualization).toBeNull();
    expect(r.visualizationDegraded).toBe(true);
    expect(r.text).toBe('正文保留');
  });
});

describe('parseAiConversationReply · 合法边界（来自 03/04 样例）', () => {
  it('完整信封：正文 trim、11 部件图形原样返回', () => {
    const r = parseAiConversationReply(envelope(), REQUEST_ID);
    expect(r.text).toBe('有效正文');
    expect(r.visualizationDegraded).toBe(false);
    expect(r.visualization?.parts).toHaveLength(11);
  });

  it('reply stage 允许 null（协议：本轮推测阶段未知时显式 null）', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      requestId: REQUEST_ID,
      content: { text: '正文', visualization: { ...VALID_VISUALIZATION, stage: null } },
    });
    const r = parseAiConversationReply(raw, REQUEST_ID);
    expect(r.visualizationDegraded).toBe(false);
    expect(r.visualization?.stage).toBeNull();
  });

  it('display 允许 HIDDEN（API 约定四态）', () => {
    const parts = AI_VISUALIZATION_PART_IDS.map((partId) => ({
      partId,
      display: partId === 'controller' ? AI_VISUALIZATION_DISPLAYS[3] : 'NORMAL',
    }));
    const raw = JSON.stringify({
      schemaVersion: 1,
      requestId: REQUEST_ID,
      content: {
        text: '正文',
        visualization: { sceneId: AI_CONVERSATION_SCENE_ID, stage: 6, parts },
      },
    });
    const r = parseAiConversationReply(raw, REQUEST_ID);
    expect(r.visualizationDegraded).toBe(false);
    expect(r.visualization?.parts.find((p) => p.partId === 'controller')?.display).toBe('HIDDEN');
  });

  it('正文恰 12000 码元通过', () => {
    const r = parseAiConversationReply(envelope({}, '好'.repeat(12000)), REQUEST_ID);
    expect(r.text).toHaveLength(12000);
  });
});
