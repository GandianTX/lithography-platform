// 维修报告 GraphQL 草稿输入契约：steps/faults 不得携带 GraphQL 默认值。
//
// 背景（2026-11-21 实库验收发现）：`MaintenanceReportDraftInputDTO` 的
// `faults` / `steps` 曾带 `defaultValue: []`。工单总结只读核对守卫
// `assertNoWorkOrderSummaryClientContent` 按「字段 !== undefined」判定客户端
// 是否重复填写内容，导致合法的 `draft: {}` 到达用例时已含空数组并被拒绝。
// 修复方式：移除默认值（输入管道如实转发「未提供」），而不是放宽守卫语义。

/// <reference types="jest" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schemaPath = join(__dirname, '..', '..', '..', '..', 'schema.graphql');

const readDraftInputBlock = (): string => {
  const schema = readFileSync(schemaPath, 'utf8');
  const match = schema.match(/input MaintenanceReportDraftInputDTO \{[\s\S]*?\n\}/);
  if (match === null) {
    throw new Error('schema.graphql 中未找到 MaintenanceReportDraftInputDTO');
  }
  return match[0];
};

describe('MaintenanceReportDraftInputDTO 契约（schema.graphql 生成物）', () => {
  it('steps / faults 字段不得携带 GraphQL 默认值', () => {
    const block = readDraftInputBlock();
    const stepsLine = block.split('\n').find((line) => line.trim().startsWith('steps:'));
    const faultsLine = block.split('\n').find((line) => line.trim().startsWith('faults:'));
    expect(stepsLine).toBeDefined();
    expect(faultsLine).toBeDefined();
    expect(stepsLine).not.toMatch(/=\s*\[/);
    expect(faultsLine).not.toMatch(/=\s*\[/);
  });
});
