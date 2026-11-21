// src/core/repair-request/policy/intake-analysis-transport.policy.spec.ts
// 传输截断策略：Unicode 安全、显式标记、不改原稿。

import {
  buildIntakeDiagnosisFaultDescription,
  buildIntakeDiagnosisQuestion,
  INTAKE_ANALYSIS_TRUNCATION_MARKER,
  truncateTransportText,
} from './intake-analysis-transport.policy';

describe('intake-analysis-transport.policy', () => {
  describe('truncateTransportText', () => {
    it('未超限返回原样副本（不加标记）', () => {
      const input = '错误码 E-100，设备无法启动';
      expect(truncateTransportText(input, 100)).toBe(input);
    });

    it('超限截断并追加显式标记，总长不超过预算（UTF-16 码元）', () => {
      const input = '现'.repeat(3000);
      const result = truncateTransportText(input, 2000);
      expect(result.length).toBe(2000);
      expect(result.endsWith(INTAKE_ANALYSIS_TRUNCATION_MARKER)).toBe(true);
      // 未截断部分保持原文前缀
      expect(result.startsWith('现'.repeat(1988))).toBe(true);
    });

    it('按 Unicode 码点截断，不拆散代理对（增补平面字符计 2 码元）', () => {
      const emoji = '😀'; // U+1F600，UTF-16 长度 2
      const input = 'a'.repeat(1999) + emoji + 'b'.repeat(10);
      const result = truncateTransportText(input, 2000);
      expect(result.length).toBe(2000);
      // 预算 2000 - 标记 6 = 1994 码元正文；第 1995 码元位置起是代理对开头，
      // 放不下完整的 😀（需 2 码元）时整体舍弃，不得出现孤立高代理
      expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(result.endsWith(INTAKE_ANALYSIS_TRUNCATION_MARKER)).toBe(true);
    });

    it('截断边界恰好在代理对前：代理对完整保留或整体舍弃', () => {
      const emoji = '😀';
      const input = 'a'.repeat(1998) + emoji; // UTF-16 长度 2000
      const result = truncateTransportText(input, 1999);
      // 预算正文 1993：前 1993 个 'a' + 标记；😀（2 码元）放不下整体舍弃
      expect(result).toBe('a'.repeat(1993) + INTAKE_ANALYSIS_TRUNCATION_MARKER);
    });

    it('预算不足以容纳标记时抛出策略错误', () => {
      expect(() => truncateTransportText('abcdef', 3)).toThrow(
        'intake_analysis_transport_marker_exceeds_budget',
      );
    });

    it('非法预算（0/负数/非整数）抛出策略错误', () => {
      expect(() => truncateTransportText('abc', 0)).toThrow();
      expect(() => truncateTransportText('abc', -1)).toThrow();
      expect(() => truncateTransportText('abc', 1.5)).toThrow();
    });
  });

  describe('buildIntakeDiagnosisQuestion', () => {
    it('未超限时保留完整故障现象', () => {
      const question = buildIntakeDiagnosisQuestion({
        modelCode: 'LITHO-9000',
        errorCode: 'E-100',
        faultDescription: '设备无法启动',
        questionMaxUnits: 2000,
      });
      expect(question).toBe('设备型号：LITHO-9000\n错误码：E-100\n故障现象：设备无法启动');
      expect(question.length).toBeLessThanOrEqual(2000);
    });

    it('长现象截断后总长不超过 questionMaxUnits 且带标记', () => {
      const faultDescription = '现'.repeat(5000); // 数据库原稿上限 5000
      const question = buildIntakeDiagnosisQuestion({
        modelCode: 'LITHO-9000',
        errorCode: 'E-100',
        faultDescription,
        questionMaxUnits: 2000,
      });
      expect(question.length).toBe(2000);
      expect(question.startsWith('设备型号：LITHO-9000\n错误码：E-100\n故障现象：')).toBe(true);
      expect(question.endsWith(INTAKE_ANALYSIS_TRUNCATION_MARKER)).toBe(true);
    });
  });

  describe('buildIntakeDiagnosisFaultDescription', () => {
    it('fault.description 传输副本不超过 4000 码元，原稿本身不变', () => {
      const original = '现'.repeat(5000);
      const copy = buildIntakeDiagnosisFaultDescription({
        faultDescription: original,
        faultFieldMaxUnits: 4000,
      });
      expect(copy.length).toBe(4000);
      expect(copy.endsWith(INTAKE_ANALYSIS_TRUNCATION_MARKER)).toBe(true);
      // 数据库原稿保持原样
      expect(original).toBe('现'.repeat(5000));
    });
  });
});
