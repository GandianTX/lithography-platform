/// <reference types="jest" />
import {
  canStartNextTurn,
  isAiQuestionTextLengthValid,
  isAiQuestionUuid,
  normalizeAiQuestionText,
  normalizeAiQuestionUuid,
} from './ai-question.policy';

describe('ai-question.policy', () => {
  describe('normalizeAiQuestionText', () => {
    it('去除首尾空白并统一换行符', () => {
      expect(normalizeAiQuestionText('  第一行\r\n第二行\r第三行  ')).toBe(
        '第一行\n第二行\n第三行',
      );
    });

    it('不折叠行内空格（避免把不同内容判为同一问题）', () => {
      expect(normalizeAiQuestionText('对 准 偏 差')).toBe('对 准 偏 差');
      expect(normalizeAiQuestionText('对  准')).not.toBe(normalizeAiQuestionText('对 准'));
    });

    it('不改变大小写与全半角', () => {
      expect(normalizeAiQuestionText('ABC １２３')).toBe('ABC １２３');
    });
  });

  describe('normalizeAiQuestionUuid / isAiQuestionUuid', () => {
    const uuid = '3f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';

    it('接受 UUID v4 并统一小写', () => {
      expect(normalizeAiQuestionUuid(` ${uuid.toUpperCase()} `)).toBe(uuid);
      expect(isAiQuestionUuid(uuid)).toBe(true);
    });

    it('拒绝非 v4、缺段与非法字符', () => {
      expect(isAiQuestionUuid('3f1a2b3c-4d5e-1f60-8a7b-9c0d1e2f3a4b')).toBe(false);
      expect(isAiQuestionUuid('3f1a2b3c-4d5e-4f60-ca7b-9c0d1e2f3a4b')).toBe(false);
      expect(isAiQuestionUuid('not-a-uuid')).toBe(false);
      expect(isAiQuestionUuid('')).toBe(false);
    });
  });

  describe('isAiQuestionTextLengthValid', () => {
    it('1–2000 通过，0 与 2001 拒绝', () => {
      expect(isAiQuestionTextLengthValid('问')).toBe(true);
      expect(isAiQuestionTextLengthValid('问'.repeat(2000))).toBe(true);
      expect(isAiQuestionTextLengthValid('')).toBe(false);
      expect(isAiQuestionTextLengthValid('问'.repeat(2001))).toBe(false);
    });
  });

  describe('canStartNextTurn', () => {
    it('第 100 轮仍可提问，第 101 轮拒绝', () => {
      expect(canStartNextTurn(100)).toBe(true);
      expect(canStartNextTurn(101)).toBe(false);
    });
  });
});
