// src/core/ai/ai-conversation-export.policy.spec.ts

import {
  buildAiExportFileName,
  buildAiExportRawJson,
  isAiExportContentVersionValid,
  resolveAiExportCutoffSeq,
  selectAiExportMessages,
  type AiExportSnapshot,
  type AiExportTurnState,
} from './ai-conversation-export.policy';

/**
 * 导出策略单测（任务 05 · S4.2 · R039-01 / R040-01）。
 *
 * 覆盖：固定版本范围（新消息不混入）、截止点声明、如实标记轮次状态、
 * 文件名与受控 JSON 脱敏结构。
 */
describe('AI 对话导出策略', () => {
  const message = (overrides: Record<string, unknown> = {}) => ({
    messageId: 1,
    messageSeq: 1,
    turnNo: 1,
    role: 'USER',
    text: '问题正文',
    contentVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  });

  describe('版本固定与消息范围', () => {
    it('只保留版本号不大于选定版本的消息（导出期间新消息不混入）', () => {
      const selected = selectAiExportMessages({
        messages: [
          message({ messageId: 1, messageSeq: 1, contentVersion: 1 }),
          message({ messageId: 2, messageSeq: 2, role: 'ASSISTANT', contentVersion: 1 }),
          message({ messageId: 3, messageSeq: 3, contentVersion: 2 }),
          message({ messageId: 4, messageSeq: 4, contentVersion: 3 }),
        ],
        contentVersion: 2,
        turnStates: new Map<number, AiExportTurnState>([[1, 'SUCCEEDED']]),
      });

      expect(selected.map((item) => item.messageId)).toEqual([1, 2, 3]);
      expect(selected.map((item) => item.messageSeq)).toEqual([1, 2, 3]);
    });

    it('按消息序号升序输出（与契约冻结顺序一致）', () => {
      const selected = selectAiExportMessages({
        messages: [
          message({ messageId: 2, messageSeq: 2 }),
          message({ messageId: 1, messageSeq: 1 }),
        ],
        contentVersion: 5,
        turnStates: new Map(),
      });
      expect(selected.map((item) => item.messageSeq)).toEqual([1, 2]);
    });

    it('轮次状态如实标记：失败与未完成不被美化', () => {
      const selected = selectAiExportMessages({
        messages: [
          message({ messageId: 1, messageSeq: 1, turnNo: 1 }),
          message({ messageId: 2, messageSeq: 2, turnNo: 2 }),
          message({ messageId: 3, messageSeq: 3, turnNo: 3 }),
          message({ messageId: 4, messageSeq: 4, turnNo: null }),
        ],
        contentVersion: 5,
        turnStates: new Map<number, AiExportTurnState>([
          [1, 'SUCCEEDED'],
          [2, 'FAILED'],
          [3, 'PENDING'],
        ]),
      });

      expect(selected.map((item) => item.turnState)).toEqual([
        'SUCCEEDED',
        'FAILED',
        'PENDING',
        'UNKNOWN',
      ]);
    });

    it('F05：回答写回版本晚于选定版本时，该轮按未完成标记（半轮不美化）', () => {
      const selected = selectAiExportMessages({
        messages: [
          message({ messageId: 1, messageSeq: 1, turnNo: 1, role: 'USER', contentVersion: 2 }),
          message({
            messageId: 2,
            messageSeq: 2,
            turnNo: 1,
            role: 'ASSISTANT',
            contentVersion: 3,
          }),
        ],
        contentVersion: 2,
        turnStates: new Map<number, AiExportTurnState>([[1, 'SUCCEEDED']]),
      });

      // 范围内只有问题：库里的 SUCCEEDED 属于 v3，不能拿来标记 v2 的这半轮
      expect(selected).toHaveLength(1);
      expect(selected[0].turnState).toBe('PENDING');
      expect(selected[0].contentVersion).toBe(2);
    });

    it('截止点取范围内最大消息序号；无消息时为 0', () => {
      expect(resolveAiExportCutoffSeq([])).toBe(0);
      expect(
        resolveAiExportCutoffSeq([
          { messageSeq: 3 } as never,
          { messageSeq: 7 } as never,
          { messageSeq: 5 } as never,
        ]),
      ).toBe(7);
    });
  });

  describe('入参与文件名', () => {
    it('内容版本必须是正整数', () => {
      expect(isAiExportContentVersionValid(1)).toBe(true);
      expect(isAiExportContentVersionValid(0)).toBe(false);
      expect(isAiExportContentVersionValid(-1)).toBe(false);
      expect(isAiExportContentVersionValid(1.5)).toBe(false);
      expect(isAiExportContentVersionValid(Number.NaN)).toBe(false);
    });

    it('文件名含会话、版本与格式，不含路径分隔符', () => {
      expect(buildAiExportFileName({ conversationId: 66, contentVersion: 3, format: 'PDF' })).toBe(
        'ai-conversation-66-v3.pdf',
      );
      expect(
        buildAiExportFileName({ conversationId: 66, contentVersion: 3, format: 'RAW_JSON' }),
      ).toBe('ai-conversation-66-v3.json');
    });
  });

  describe('受控原始 JSON 结构', () => {
    const snapshot: AiExportSnapshot = {
      conversationId: 66,
      contentVersion: 2,
      lastMessageSeq: 4,
      requestNo: 'RR-20261101-001',
      requestId: 88,
      engineerNickname: '陈工程师',
      messages: [
        {
          messageId: 1,
          messageSeq: 1,
          turnNo: 1,
          role: 'USER',
          text: '问题正文',
          contentVersion: 1,
          createdAt: '2026-11-01T00:00:00.000Z',
          turnState: 'SUCCEEDED',
        },
      ],
      createdAt: '2026-11-01T00:00:00.000Z',
    };

    it('输出固定范围声明与消息明细', () => {
      const raw = buildAiExportRawJson(snapshot);
      expect(raw.schemaVersion).toBe(1);
      expect(raw.conversation).toEqual({
        conversationId: 66,
        contentVersion: 2,
        lastMessageSeq: 4,
        requestId: 88,
        requestNo: 'RR-20261101-001',
        engineerNickname: '陈工程师',
        createdAt: '2026-11-01T00:00:00.000Z',
      });
      expect(raw.messages).toEqual([
        {
          messageId: 1,
          messageSeq: 1,
          turnNo: 1,
          role: 'USER',
          contentVersion: 1,
          createdAt: '2026-11-01T00:00:00.000Z',
          turnState: 'SUCCEEDED',
          text: '问题正文',
        },
      ]);
    });

    it('不输出账号标识、令牌或密码类字段（去敏）', () => {
      const serialized = JSON.stringify(buildAiExportRawJson(snapshot));
      expect(serialized).not.toMatch(/password|token|secret|authorization/i);
      expect(serialized).not.toMatch(/ownerAccountId|accountId/);
    });
  });
});
