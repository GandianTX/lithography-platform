// src/adapters/api/graphql/local-runtime/dto/record-package-export.dto.ts

import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import { recordPackageResourceTypeEnum } from '@core/local-runtime/policy/record-package-export.policy';
import type { RecordPackageResourceType } from '@core/local-runtime/policy/record-package-manifest.policy';
import type { RecordPackageExportResult } from '@src/modules/lithography/record-package-export.types';

/** 逐条导出结论（单条失败不拖垮整包；全部失败则整包不产生） */
@ObjectType('RecordPackageExportItem')
export class RecordPackageExportItemDTO {
  @Field(() => Int, { description: '来源业务记录 ID' })
  recordId!: number;

  @Field(() => String, { nullable: true, description: '确定性派生的条目身份（record_uuid）' })
  recordUuid?: string | null;

  @Field(() => String, { description: '资源类型' })
  resourceType!: string;

  @Field(() => Int, { nullable: true, description: '导出的版本号（拒绝时为空）' })
  versionNo?: number | null;

  @Field(() => String, { description: 'EXPORTED / REJECTED' })
  outcome!: 'EXPORTED' | 'REJECTED';

  @Field(() => String, { nullable: true, description: '拒绝类别' })
  rejection?: string | null;

  @Field(() => String, { nullable: true, description: '拒绝原因' })
  message?: string | null;
}

/** 导出结果：包为目录形态（manifest.json + 清单相对路径原件） */
@ObjectType('RecordPackageExportResult')
export class RecordPackageExportResultDTO {
  @Field(() => String, { description: '导出包 ID（manifest.package_id）' })
  packageId!: string;

  @Field(() => String, { description: '导出目标目录（本机绝对路径）' })
  packagePath!: string;

  @Field(() => Int, { description: '导出的公司数据区' })
  organizationId!: number;

  @Field(() => String, { description: '资源类型' })
  resourceType!: string;

  @Field(() => String, { description: '清单 SHA-256' })
  manifestChecksum!: string;

  @Field(() => Int, { description: '清点总条数' })
  itemTotal!: number;

  @Field(() => Int, { description: '导出成功条数' })
  itemExported!: number;

  @Field(() => Int, { description: '拒绝条数' })
  itemFailed!: number;

  @Field(() => [RecordPackageExportItemDTO], { description: '逐条导出结论' })
  items!: RecordPackageExportItemDTO[];
}

export function toRecordPackageExportDTO(
  result: RecordPackageExportResult,
): RecordPackageExportResultDTO {
  return {
    packageId: result.packageId,
    packagePath: result.packagePath,
    organizationId: result.organizationId,
    resourceType: result.resourceType,
    manifestChecksum: result.manifestChecksum,
    itemTotal: result.itemTotal,
    itemExported: result.itemExported,
    itemFailed: result.itemFailed,
    items: result.items,
  };
}

/**
 * 导出条目请求（**混合导出**）。
 *
 * 逐条自带资源类型 ⇒ 一次导出可以同时包含工单、报告与资料；
 * 旧的"单一 resourceType ＋ recordIds"入参**保持不变**（旧客户端不受影响）。
 */
@InputType('RecordPackageExportEntryInput')
export class RecordPackageExportEntryInputDTO {
  @Field(() => recordPackageResourceTypeEnum, { description: '该条记录的资源类型' })
  resourceType!: RecordPackageResourceType;

  @Field(() => Int, { description: '来源业务记录 ID' })
  recordId!: number;
}
