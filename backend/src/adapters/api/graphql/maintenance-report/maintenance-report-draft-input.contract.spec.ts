// 维修报告 GraphQL 草稿输入契约：steps/faults 不得携带 GraphQL 默认值。
//
// 背景（2026-11-21 实库验收发现）：`MaintenanceReportDraftInputDTO` 的
// `faults` / `steps` 曾带 `defaultValue: []`。工单总结只读核对守卫
// `assertNoWorkOrderSummaryClientContent` 按「字段 !== undefined」判定客户端
// 是否重复填写内容，导致合法的 `draft: {}` 到达用例时已含空数组并被拒绝。
// 修复方式：移除默认值（输入管道如实转发「未提供」），而不是放宽守卫语义。
//
// 2026-11-22 CI 修复：不再读取本地已启动服务生成的 schema.graphql（CI 干净
// 环境无该生成物），改为直接断言 `@Field` 装饰器写入 `@nestjs/graphql`
// TypeMetadataStorage 的真实字段元数据——`options.defaultValue` 正是 schema
// 生成器打印 `= 默认值` 的唯一来源，二者契约等价。

/// <reference types="jest" />
import { TypeMetadataStorage } from '@nestjs/graphql';
// 与包内 schema 生成器（graphql-schema.factory.js）完全一致的元数据装载步骤；
// LazyMetadataStorage 未随包公开导出，但该包 exports 允许深路径引用。
import { LazyMetadataStorage } from '@nestjs/graphql/dist/schema-builder/storages/lazy-metadata.storage.js';

import {
  MaintenanceReportDraftInputDTO,
  MaintenanceReportFaultInputDTO,
  MaintenanceReportStepInputDTO,
} from './dto/maintenance-report.input';

describe('MaintenanceReportDraftInputDTO 契约（GraphQL 字段元数据）', () => {
  it('steps / faults 字段不得携带 GraphQL 默认值', () => {
    // 装饰器元数据先经 LazyMetadataStorage 落入 TypeMetadataStorage（幂等），
    // 与运行时 schema 生成前的装载/编译步骤一致。
    LazyMetadataStorage.load([
      MaintenanceReportDraftInputDTO,
      MaintenanceReportStepInputDTO,
      MaintenanceReportFaultInputDTO,
    ]);
    TypeMetadataStorage.compile();

    const inputMetadata = TypeMetadataStorage.getInputTypeMetadataByTarget(
      MaintenanceReportDraftInputDTO,
    );
    if (inputMetadata === undefined) {
      throw new Error('未找到 MaintenanceReportDraftInputDTO 的 GraphQL 输入类型元数据');
    }

    const properties = inputMetadata.properties ?? [];
    const stepsField = properties.find((property) => property.name === 'steps');
    const faultsField = properties.find((property) => property.name === 'faults');
    expect(stepsField).toBeDefined();
    expect(faultsField).toBeDefined();
    expect(stepsField?.options.defaultValue).toBeUndefined();
    expect(faultsField?.options.defaultValue).toBeUndefined();
  });
});
