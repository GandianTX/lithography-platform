// src/usecases/maintenance-report/testing/in-memory-analysis-output-reader.ts
// 仅测试装配使用的分析结果读取模拟实现。
//
// 不注册到生产模块、不提供公开模拟接口、不建模拟专用表；
// 由 spec 通过依赖注入替换 `ANALYSIS_OUTPUT_READER`，与正式实现严格分开。

import type { AnalysisOutputSnapshot } from '@app-types/models/maintenance-report.types';
import type {
  AnalysisOutputReadRequest,
  AnalysisOutputReader,
} from '../ports/analysis-output-reader.contract';

export class InMemoryAnalysisOutputReader implements AnalysisOutputReader {
  private readonly outputs = new Map<string, AnalysisOutputSnapshot>();

  add(output: AnalysisOutputSnapshot): void {
    this.outputs.set(keyOf(output), output);
  }

  clear(): void {
    this.outputs.clear();
  }

  read(request: AnalysisOutputReadRequest): Promise<AnalysisOutputSnapshot | null> {
    return Promise.resolve(this.outputs.get(keyOf(request)) ?? null);
  }
}

function keyOf(value: AnalysisOutputReadRequest): string {
  return `${value.sourceType}\u0000${value.sourceId}\u0000${value.sourceVersion}`;
}
