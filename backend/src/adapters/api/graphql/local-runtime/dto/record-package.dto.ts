// src/adapters/api/graphql/local-runtime/dto/record-package.dto.ts

import { Field, GraphQLISODateTime, Int, ObjectType } from '@nestjs/graphql';
import type {
  RecordPackageImportSnapshot,
  RecordPackageItemSnapshot,
} from '@src/modules/lithography/record-package-import.types';

/** 记录包检查/导入批次（R073：已受理不是成功，检查通过不冒充实际写入） */
@ObjectType('RecordPackageImport')
export class RecordPackageImportDTO {
  @Field(() => String, { description: '导入包 ID' })
  packageId!: string;

  @Field(() => Int, { description: '目标公司数据区' })
  organizationId!: number;

  @Field(() => Int, { description: '实际操作人账号' })
  importedByAccountId!: number;

  @Field(() => String, { description: '包清单 JSON 原文' })
  manifestJson!: string;

  @Field(() => String, { description: '包清单 SHA-256' })
  manifestChecksum!: string;

  @Field(() => String, { description: '导入阶段：PENDING/RUNNING/SUCCEEDED/PARTIAL/FAILED' })
  status!: string;

  @Field(() => String, { nullable: true, description: '检查状态：NULL/PENDING/PASSED/REJECTED' })
  checkStatus?: string | null;

  @Field(() => Int, { description: '清点总条数' })
  itemTotal!: number;

  @Field(() => Int, { description: '成功条数（导入阶段才有）' })
  itemSucceeded!: number;

  @Field(() => Int, { description: '失败条数' })
  itemFailed!: number;

  @Field(() => GraphQLISODateTime, { description: '批次创建时间' })
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '完成时间' })
  completedAt?: Date | null;
}

/** 记录包逐条事实（检查结论与导入结果分层） */
@ObjectType('RecordPackageItem')
export class RecordPackageItemDTO {
  @Field(() => String, { description: '条目 ID' })
  itemId!: string;

  @Field(() => String, { description: '所属导入包 ID' })
  packageId!: string;

  @Field(() => String, { description: '业务稳定编号' })
  recordUuid!: string;

  @Field(() => String, { description: '资源类型' })
  resourceType!: string;

  @Field(() => Int, { description: '业务版本号' })
  versionNo!: number;

  @Field(() => String, { nullable: true, description: '检查结果：NULL/PASSED/REJECTED' })
  checkResult?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '导入结果：NULL 未执行/SUCCEEDED/FAILED/SKIPPED/CONFLICT',
  })
  result?: string | null;

  @Field(() => String, { nullable: true, description: '同步回执 ID' })
  receiptId?: string | null;

  @Field(() => String, { nullable: true, description: '拒绝/失败原因' })
  errorMessage?: string | null;

  @Field(() => GraphQLISODateTime, { description: '条目创建时间' })
  createdAt!: Date;
}

/** 检查结果：existing 表示同包重复检查返回既有批次 */
@ObjectType('RecordPackageCheckResult')
export class RecordPackageCheckResultDTO {
  @Field(() => String, { description: 'checked=本次完成检查；existing=同包重复检查返回既有事实' })
  outcome!: 'checked' | 'existing';

  @Field(() => RecordPackageImportDTO, { description: '批次事实' })
  import!: RecordPackageImportDTO;

  @Field(() => [RecordPackageItemDTO], { description: '逐条检查结论' })
  items!: RecordPackageItemDTO[];
}

/** 处理结果查询（R073）：检查与导入两阶段分列展示 */
@ObjectType('RecordPackageProcessResult')
export class RecordPackageProcessResultDTO {
  @Field(() => RecordPackageImportDTO, { description: '批次事实' })
  import!: RecordPackageImportDTO;

  @Field(() => [RecordPackageItemDTO], { description: '逐条事实' })
  items!: RecordPackageItemDTO[];
}

export function toRecordPackageImportDTO(
  view: RecordPackageImportSnapshot,
): RecordPackageImportDTO {
  return {
    packageId: view.packageId,
    organizationId: view.organizationId,
    importedByAccountId: view.importedByAccountId,
    manifestJson: view.manifestJson,
    manifestChecksum: view.manifestChecksum,
    status: view.status,
    checkStatus: view.checkStatus,
    itemTotal: view.itemTotal,
    itemSucceeded: view.itemSucceeded,
    itemFailed: view.itemFailed,
    createdAt: view.createdAt,
    completedAt: view.completedAt,
  };
}

export function toRecordPackageItemDTO(view: RecordPackageItemSnapshot): RecordPackageItemDTO {
  return {
    itemId: view.itemId,
    packageId: view.packageId,
    recordUuid: view.recordUuid,
    resourceType: view.resourceType,
    versionNo: view.versionNo,
    checkResult: view.checkResult,
    result: view.result,
    receiptId: view.receiptId,
    errorMessage: view.errorMessage,
    createdAt: view.createdAt,
  };
}
