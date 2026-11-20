// src/core/common/async-task/intake-analysis-failure.policy.spec.ts
// 失败语义分类：临时故障必须保持可补投，永久错误必须落受控终结前缀，
// 且所有取值不超账本 reason 列长度。

import {
  INTAKE_ANALYSIS_FAILURE_REASON_MAX_LENGTH,
  INTAKE_ANALYSIS_PERMANENT_ATTEMPT_INCONSISTENT_REASON,
  INTAKE_ANALYSIS_PERMANENT_UNPARSABLE_JOB_ID_REASON,
  INTAKE_ANALYSIS_RECONCILE_CANCELLED_REASON,
  INTAKE_ANALYSIS_RECONCILE_FAILED_REASON,
  INTAKE_ANALYSIS_RECONCILE_SUCCEEDED_REASON,
  INTAKE_ANALYSIS_WORKER_FAILED_PREFIX,
  INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX,
  buildIntakeAnalysisFailureReason,
  isPermanentIntakeAnalysisFailureCode,
  isPermanentIntakeAnalysisFailureReason,
  isReconciledIntakeAnalysisReason,
} from './intake-analysis-failure.policy';

describe('intake analysis failure policy', () => {
  describe('isPermanentIntakeAnalysisFailureCode', () => {
    it('确定无法通过补投产生新结果的码归为永久错误', () => {
      expect(
        isPermanentIntakeAnalysisFailureCode('INTAKE_ANALYSIS_ATTEMPT_STATE_INCONSISTENT'),
      ).toBe(true);
      expect(isPermanentIntakeAnalysisFailureCode('INTAKE_ANALYSIS_ORIGINAL_NOT_FOUND')).toBe(true);
      expect(isPermanentIntakeAnalysisFailureCode('INTAKE_ANALYSIS_ALREADY_FAILED')).toBe(true);
    });

    it('可自愈/仍在执行/由就绪度转为取消的码必须保留为临时故障', () => {
      // 补投会用解析出的 jobId 重建 payload，可自愈
      expect(isPermanentIntakeAnalysisFailureCode('INTAKE_ANALYSIS_JOB_MISMATCH')).toBe(false);
      expect(isPermanentIntakeAnalysisFailureCode('INTAKE_ANALYSIS_JOB_NAME_UNKNOWN')).toBe(false);
      // 租约持有者可能仍在执行并写回结果
      expect(isPermanentIntakeAnalysisFailureCode('INTAKE_ANALYSIS_LEASE_ACTIVE')).toBe(false);
      // 删除/代次/未关联工单由就绪度判定转为取消
      expect(isPermanentIntakeAnalysisFailureCode('INTAKE_ANALYSIS_NOT_EXECUTABLE')).toBe(false);
      expect(isPermanentIntakeAnalysisFailureCode('INTAKE_ANALYSIS_CLIENT_UNEXPECTED_ERROR')).toBe(
        false,
      );
      expect(isPermanentIntakeAnalysisFailureCode(null)).toBe(false);
      expect(isPermanentIntakeAnalysisFailureCode('   ')).toBe(false);
    });
  });

  describe('buildIntakeAnalysisFailureReason', () => {
    it('永久错误落 worker_permanent:<code>', () => {
      expect(
        buildIntakeAnalysisFailureReason({
          nonRetryableCode: 'INTAKE_ANALYSIS_ORIGINAL_NOT_FOUND',
          summary: 'ignored',
        }),
      ).toBe(`${INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX}INTAKE_ANALYSIS_ORIGINAL_NOT_FOUND`);
    });

    it('未分类/临时错误保留 worker_failed:<summary>', () => {
      expect(
        buildIntakeAnalysisFailureReason({
          nonRetryableCode: 'INTAKE_ANALYSIS_JOB_MISMATCH',
          summary: 'intake_analysis_job_mismatch',
        }),
      ).toBe(`${INTAKE_ANALYSIS_WORKER_FAILED_PREFIX}intake_analysis_job_mismatch`);
      expect(buildIntakeAnalysisFailureReason({ summary: 'db_down' })).toBe(
        'worker_failed:db_down',
      );
      expect(buildIntakeAnalysisFailureReason({})).toBe(
        'worker_failed:intake_analysis_unknown_error',
      );
    });

    it('超长摘要被截断，且所有取值不超过账本 reason 列长度', () => {
      const reason = buildIntakeAnalysisFailureReason({ summary: 'x'.repeat(500) });
      expect(reason.length).toBeLessThanOrEqual(INTAKE_ANALYSIS_FAILURE_REASON_MAX_LENGTH);
      expect(reason.startsWith(INTAKE_ANALYSIS_WORKER_FAILED_PREFIX)).toBe(true);
    });
  });

  describe('reason 分类判定', () => {
    it('受控终结前缀可被识别（用于扫描排除）', () => {
      expect(
        isPermanentIntakeAnalysisFailureReason(INTAKE_ANALYSIS_PERMANENT_UNPARSABLE_JOB_ID_REASON),
      ).toBe(true);
      expect(
        isPermanentIntakeAnalysisFailureReason(
          INTAKE_ANALYSIS_PERMANENT_ATTEMPT_INCONSISTENT_REASON,
        ),
      ).toBe(true);
      expect(isPermanentIntakeAnalysisFailureReason('worker_failed:db_down')).toBe(false);
      expect(isPermanentIntakeAnalysisFailureReason(null)).toBe(false);
    });

    it('收敛原因可被识别（成功/失败/取消三种真实结果）', () => {
      expect(isReconciledIntakeAnalysisReason(INTAKE_ANALYSIS_RECONCILE_SUCCEEDED_REASON)).toBe(
        true,
      );
      expect(isReconciledIntakeAnalysisReason(INTAKE_ANALYSIS_RECONCILE_FAILED_REASON)).toBe(true);
      expect(isReconciledIntakeAnalysisReason(INTAKE_ANALYSIS_RECONCILE_CANCELLED_REASON)).toBe(
        true,
      );
      expect(isReconciledIntakeAnalysisReason('worker_completed')).toBe(false);
      // 收敛原因不能与永久终结混淆：失败收敛仍表示「业务已失败」，不是「需要人工」
      expect(isPermanentIntakeAnalysisFailureReason(INTAKE_ANALYSIS_RECONCILE_FAILED_REASON)).toBe(
        false,
      );
      expect(INTAKE_ANALYSIS_RECONCILE_SUCCEEDED_REASON.length).toBeLessThanOrEqual(
        INTAKE_ANALYSIS_FAILURE_REASON_MAX_LENGTH,
      );
    });
  });
});
