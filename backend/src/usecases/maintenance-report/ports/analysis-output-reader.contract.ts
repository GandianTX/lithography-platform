// src/usecases/maintenance-report/ports/analysis-output-reader.contract.ts
// 对外部（负责人独立 AI 模块）分析结果的最小读取抽象。
//
// 约束：
// - 仅读取稳定 ID、版本、所属组织、关联工单、生成状态与正文；
// - 不暴露/复制负责人内部表结构，不建立外键；
// - 正式实现未接入时必须明确不可用，禁止自动降级为模拟成功；
// - 测试通过装配注入内存模拟实现，不存在公开模拟接口或生产开关。

import type { AnalysisOutputSnapshot } from '@app-types/models/maintenance-report.types';

export const ANALYSIS_OUTPUT_READER = Symbol('ANALYSIS_OUTPUT_READER');

export type AnalysisOutputReadRequest = {
  sourceType: string;
  sourceId: string;
  sourceVersion: string;
};

export interface AnalysisOutputReader {
  /**
   * 读取不可变分析结果版本。
   * @returns 未找到时返回 null；读取服务不可用时应抛出 DomainError。
   */
  read(request: AnalysisOutputReadRequest): Promise<AnalysisOutputSnapshot | null>;
}
