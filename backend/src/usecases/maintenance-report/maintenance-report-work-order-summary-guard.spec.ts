// 工单维修总结只读守卫 `assertNoWorkOrderSummaryClientContent` 行为回归。
//
// 契约：仅当内容字段「未提供」（undefined）时放行；客户端真正携带内容
// ——包括显式空数组——一律拒绝，不得把非法内容当空值忽略绕过服务端派生。

/// <reference types="jest" />
import { MAINTENANCE_REPORT_ERROR, DomainError } from '@core/common/errors/domain-error';
import { assertNoWorkOrderSummaryClientContent } from './maintenance-report-work-order-source.helpers';

const emptyDraft = {} as Parameters<typeof assertNoWorkOrderSummaryClientContent>[0];

describe('工单维修总结只读守卫', () => {
  it('draft 为空对象（所有内容字段未提供）时放行', () => {
    expect(() => assertNoWorkOrderSummaryClientContent(emptyDraft)).not.toThrow();
  });

  it('显式空数组仍视为已提供，拒绝（不当作空值忽略）', () => {
    expect(() =>
      assertNoWorkOrderSummaryClientContent({
        ...emptyDraft,
        faults: [],
        steps: [],
      }),
    ).toThrow(DomainError);
  });

  it('携带真实内容字段时拒绝并指出字段', () => {
    try {
      assertNoWorkOrderSummaryClientContent({
        ...emptyDraft,
        handlingResult: 'FIXED',
        steps: [{ stepCode: 'STEP-01', actionText: '检查光路。' }],
      });
      throw new Error('应当拒绝');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS);
      expect((error as DomainError).message).toContain('只读核对');
    }
  });
});
