// src/usecases/repair-request/retry-intake-analysis.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';

export type RetryIntakeAnalysisCommand = {
  session: UsecaseSession;
  /** 工单 ID（本人报修） */
  requestId: number;
};

export type RetryIntakeAnalysisResult = {
  requestId: number;
  intakeId: number;
  /** 重试后的代次（恒为 1）与首析状态（恒为 WAITING） */
  analysisGeneration: number;
  analysisStatus: string;
  /** 提交后入队是否完成；false 表示由 housekeeping 补投 */
  delivered: boolean;
};
