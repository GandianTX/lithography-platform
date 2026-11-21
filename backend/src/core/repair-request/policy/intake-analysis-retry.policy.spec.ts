// src/core/repair-request/policy/intake-analysis-retry.policy.spec.ts
// 首析展示状态与自助重试资格策略（纯函数）：失败关闭、唯一 0→1、不依赖账本前缀。

import {
  INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_IN_PROGRESS,
  INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_NOT_INITIATED,
  INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_SUCCEEDED,
  INTAKE_ANALYSIS_RETRY_REASON_FAILURE_NOT_CONFIRMED,
  INTAKE_ANALYSIS_RETRY_REASON_INTAKE_DELETED,
  INTAKE_ANALYSIS_RETRY_REASON_LEDGER_INTENT_MISSING,
  INTAKE_ANALYSIS_RETRY_REASON_NOT_CONVERTED,
  INTAKE_ANALYSIS_RETRY_REASON_NO_INTAKE,
  INTAKE_ANALYSIS_RETRY_REASON_OWNERSHIP_CONFLICT,
  INTAKE_ANALYSIS_RETRY_REASON_OWNER_RETRY_AVAILABLE,
  INTAKE_ANALYSIS_RETRY_REASON_RETRY_ALREADY_USED,
  INTAKE_ANALYSIS_RETRY_REASON_STATUS_UNKNOWN,
  resolveIntakeAnalysisRetryDecision,
  type IntakeAnalysisRetryFacts,
} from './intake-analysis-retry.policy';

/** 基准事实：第 0 代明确模型失败、尝试行 FAILED、账本行存在 */
const eligibleFacts: IntakeAnalysisRetryFacts = {
  requestId: 11,
  viewerCustomerAccountId: 7,
  requestCustomerAccountId: 7,
  intakeExists: true,
  intakeCustomerAccountId: 7,
  intakeDeleted: false,
  convertedRequestId: 11,
  generation: 0,
  status: 'FAILED',
  attemptGenerationNo: 0,
  attemptStatus: 'FAILED',
  attemptFailureReasonRecorded: true,
  ledgerIntentPresent: true,
};

const withFacts = (overrides: Partial<IntakeAnalysisRetryFacts>): IntakeAnalysisRetryFacts => ({
  ...eligibleFacts,
  ...overrides,
});

describe('resolveIntakeAnalysisRetryDecision', () => {
  it('第 0 代明确模型失败且记录可信：开放唯一一次普通重试', () => {
    expect(resolveIntakeAnalysisRetryDecision(eligibleFacts)).toEqual({
      eligible: true,
      reason: INTAKE_ANALYSIS_RETRY_REASON_OWNER_RETRY_AVAILABLE,
      displayState: 'FAILED_RETRYABLE',
    });
  });

  it('原稿缺失 / 已删除 / 归属冲突 / 未关联工单：不可用，无资格', () => {
    const cases: Array<[Partial<IntakeAnalysisRetryFacts>, string]> = [
      [
        { intakeExists: false, intakeCustomerAccountId: null },
        INTAKE_ANALYSIS_RETRY_REASON_NO_INTAKE,
      ],
      [{ intakeDeleted: true }, INTAKE_ANALYSIS_RETRY_REASON_INTAKE_DELETED],
      [{ intakeCustomerAccountId: 8 }, INTAKE_ANALYSIS_RETRY_REASON_OWNERSHIP_CONFLICT],
      [{ requestCustomerAccountId: 8 }, INTAKE_ANALYSIS_RETRY_REASON_OWNERSHIP_CONFLICT],
      [{ viewerCustomerAccountId: 8 }, INTAKE_ANALYSIS_RETRY_REASON_OWNERSHIP_CONFLICT],
      [{ convertedRequestId: null }, INTAKE_ANALYSIS_RETRY_REASON_NOT_CONVERTED],
      [{ convertedRequestId: 99 }, INTAKE_ANALYSIS_RETRY_REASON_NOT_CONVERTED],
    ];

    for (const [overrides, expectedReason] of cases) {
      const decision = resolveIntakeAnalysisRetryDecision(withFacts(overrides));
      expect(decision.eligible).toBe(false);
      expect(decision.displayState).toBe('UNAVAILABLE');
      expect(decision.reason).toBe(expectedReason);
    }
  });

  it('原稿缺失单独判定为 NO_INTAKE（不外泄为可重试）', () => {
    const decision = resolveIntakeAnalysisRetryDecision(
      withFacts({ intakeExists: false, intakeCustomerAccountId: null }),
    );
    expect(decision).toEqual({
      eligible: false,
      reason: 'NO_INTAKE',
      displayState: 'UNAVAILABLE',
    });
  });

  it('排队中 / 运行中：后台仍会补投，不开放客户恢复', () => {
    expect(resolveIntakeAnalysisRetryDecision(withFacts({ status: 'WAITING' }))).toEqual({
      eligible: false,
      reason: INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_IN_PROGRESS,
      displayState: 'QUEUED',
    });
    expect(resolveIntakeAnalysisRetryDecision(withFacts({ status: 'RUNNING' }))).toEqual({
      eligible: false,
      reason: INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_IN_PROGRESS,
      displayState: 'RUNNING',
    });
  });

  it('无账本的 WAITING（Seed 样例）：判为未发起分析（中性文案），不误判排队、不入队', () => {
    const decision = resolveIntakeAnalysisRetryDecision(
      withFacts({ status: 'WAITING', ledgerIntentPresent: false }),
    );
    expect(decision).toEqual({
      eligible: false,
      reason: INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_NOT_INITIATED,
      displayState: 'NOT_STARTED',
    });
  });

  it('无账本的 RUNNING：状态矛盾，仍是不可用（失败关闭）', () => {
    const decision = resolveIntakeAnalysisRetryDecision(
      withFacts({ status: 'RUNNING', ledgerIntentPresent: false }),
    );
    expect(decision).toEqual({
      eligible: false,
      reason: INTAKE_ANALYSIS_RETRY_REASON_LEDGER_INTENT_MISSING,
      displayState: 'UNAVAILABLE',
    });
  });

  it('成功态：不提供重试', () => {
    expect(
      resolveIntakeAnalysisRetryDecision(
        withFacts({ status: 'SUCCEEDED', attemptStatus: 'SUCCEEDED' }),
      ),
    ).toEqual({
      eligible: false,
      reason: INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_SUCCEEDED,
      displayState: 'COMPLETED',
    });
  });

  it('第 1 代再次失败：唯一机会已用掉，不可进入第 2 代', () => {
    expect(
      resolveIntakeAnalysisRetryDecision(withFacts({ generation: 1, attemptGenerationNo: 1 })),
    ).toEqual({
      eligible: false,
      reason: INTAKE_ANALYSIS_RETRY_REASON_RETRY_ALREADY_USED,
      displayState: 'FAILED_NOT_RETRYABLE',
    });
  });

  it('代次越界（>1）：数据异常，失败关闭', () => {
    expect(
      resolveIntakeAnalysisRetryDecision(withFacts({ generation: 2, attemptGenerationNo: 2 })),
    ).toEqual({
      eligible: false,
      reason: INTAKE_ANALYSIS_RETRY_REASON_STATUS_UNKNOWN,
      displayState: 'UNAVAILABLE',
    });
  });

  it('失败必须由实际分析结果证明：尝试行缺失/状态矛盾/无受控失败原因一律不可重试', () => {
    const cases: Array<Partial<IntakeAnalysisRetryFacts>> = [
      { attemptGenerationNo: null, attemptStatus: null, attemptFailureReasonRecorded: false },
      { attemptGenerationNo: 1, attemptStatus: 'FAILED' },
      { attemptStatus: 'RUNNING' },
      { attemptStatus: 'SUCCEEDED' },
      { attemptFailureReasonRecorded: false },
    ];
    for (const overrides of cases) {
      const decision = resolveIntakeAnalysisRetryDecision(withFacts(overrides));
      expect(decision.eligible).toBe(false);
      expect(decision.reason).toBe(INTAKE_ANALYSIS_RETRY_REASON_FAILURE_NOT_CONFIRMED);
      expect(decision.displayState).toBe('UNAVAILABLE');
    }
  });

  it('失败已确认但缺少当前代次账本行：不开放自助重试', () => {
    expect(resolveIntakeAnalysisRetryDecision(withFacts({ ledgerIntentPresent: false }))).toEqual({
      eligible: false,
      reason: INTAKE_ANALYSIS_RETRY_REASON_LEDGER_INTENT_MISSING,
      displayState: 'FAILED_NOT_RETRYABLE',
    });
  });

  it('持久化状态落在受控值域之外：不可用', () => {
    expect(resolveIntakeAnalysisRetryDecision(withFacts({ status: 'BROKEN' }))).toEqual({
      eligible: false,
      reason: INTAKE_ANALYSIS_RETRY_REASON_STATUS_UNKNOWN,
      displayState: 'UNAVAILABLE',
    });
  });
});
