// src/core/common/async-task/intake-analysis-job-id.policy.spec.ts
// 首析 jobId 策略单测：构造/解析收口 + BullMQ 5.x 自定义 jobId 校验兼容断言。
//
// BullMQ 5.x 实际校验（以安装版本 5.79.2 的 Queue.add / Job.validateOptions 为准）：
// 1. jobId 不得为 '0' 或以 '0:' 开头；
// 2. 纯数字字符串拒绝（"Custom Id cannot be integers"）；
// 3. 含 ':' 时必须恰好 3 段，否则抛 "Custom Id cannot contain :"。
// 本策略生成的 `intake-analysis:{intakeId}:g{generationNo}` 必须恒满足以上三条。

import {
  buildIntakeAnalysisJobId,
  INTAKE_ANALYSIS_QUEUE_NAME,
  parseIntakeAnalysisJobId,
} from './intake-analysis-job-id.policy';

/** 与 BullMQ Job.validateOptions 一致的兼容判定（复制其规则用于断言） */
function satisfiesBullMq5xCustomJobIdRules(jobId: string): boolean {
  if (jobId === '0' || jobId.startsWith('0:')) {
    return false;
  }
  if (`${Number.parseInt(jobId, 10)}` === jobId) {
    return false;
  }
  if (jobId.includes(':') && jobId.split(':').length !== 3) {
    return false;
  }
  return true;
}

describe('intake-analysis jobId policy', () => {
  it.each([0, 1])('构造与解析互逆：generationNo=%i', (generationNo) => {
    const jobId = buildIntakeAnalysisJobId({ intakeId: 21, generationNo });
    expect(jobId).toBe(`intake-analysis:21:g${generationNo}`);
    expect(parseIntakeAnalysisJobId(jobId)).toEqual({ intakeId: 21, generationNo });
  });

  it('生成的大 intakeId 同样满足 BullMQ 5.x 自定义 jobId 全部校验', () => {
    for (const intakeId of [1, 999, 2_147_483_647]) {
      for (const generationNo of [0, 1] as const) {
        const jobId = buildIntakeAnalysisJobId({ intakeId, generationNo });
        expect(satisfiesBullMq5xCustomJobIdRules(jobId)).toBe(true);
        expect(parseIntakeAnalysisJobId(jobId)).toEqual({ intakeId, generationNo });
      }
    }
  });

  it('异构 jobId 解析为 null（Worker 归属核对拒绝异构 job）', () => {
    expect(parseIntakeAnalysisJobId('ai-execution:1')).toBeNull();
    expect(parseIntakeAnalysisJobId('intake-analysis:21:g2')).toBeNull();
    expect(parseIntakeAnalysisJobId('intake-analysis:abc:g0')).toBeNull();
    expect(parseIntakeAnalysisJobId('intake-analysis:21')).toBeNull();
    expect(parseIntakeAnalysisJobId('')).toBeNull();
  });

  it('非法构造入参直接拒绝（不产出无法解析的 jobId）', () => {
    expect(() => buildIntakeAnalysisJobId({ intakeId: 0, generationNo: 0 })).toThrow(
      'intake_analysis_job_id_invalid_intake_id',
    );
    expect(() => buildIntakeAnalysisJobId({ intakeId: -1, generationNo: 0 })).toThrow(
      'intake_analysis_job_id_invalid_intake_id',
    );
    expect(() => buildIntakeAnalysisJobId({ intakeId: 1.5, generationNo: 0 })).toThrow(
      'intake_analysis_job_id_invalid_intake_id',
    );
    expect(() => buildIntakeAnalysisJobId({ intakeId: 21, generationNo: 2 })).toThrow(
      'intake_analysis_job_id_invalid_generation',
    );
  });

  it('队列名常量保持与策略前缀一致（账本与 BullMQ 共用同一标识）', () => {
    expect(INTAKE_ANALYSIS_QUEUE_NAME).toBe('intake-analysis');
  });
});
