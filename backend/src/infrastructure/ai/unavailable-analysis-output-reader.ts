// src/infrastructure/ai/unavailable-analysis-output-reader.ts
// 正式环境未接入负责人 AI 模块时的明确不可用实现（boundary contract 的 infrastructure 实现）。
// 不得返回模拟结果、不得记为成功；调用方据此拒绝“已使用 AI”的报告写入。

import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import type {
  AnalysisOutputReadRequest,
  AnalysisOutputReader,
} from '@usecases/maintenance-report/ports/analysis-output-reader.contract';
import type { AnalysisOutputSnapshot } from '@app-types/models/maintenance-report.types';

@Injectable()
export class UnavailableAnalysisOutputReader implements AnalysisOutputReader {
  read(_request: AnalysisOutputReadRequest): Promise<AnalysisOutputSnapshot | null> {
    return Promise.reject(
      new DomainError(
        MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_UNAVAILABLE,
        '分析结果读取未接入，无法使用 AI 关联数据',
      ),
    );
  }
}
