// src/adapters/api/graphql/repair-request/dto/engineer-repair-revision.dto.ts
// 工程师侧修订历史只读输出对象

import { Field, Int, ObjectType } from '@nestjs/graphql';
import { RepairMaintenanceFaultPanelDTO, RepairMaintenanceStepDTO } from './repair-maintenance.dto';

@ObjectType({ description: '工程师可见的修订维修快照（不含附件与管理员快照字段）' })
export class EngineerRepairRevisionSnapshotDTO {
  @Field(() => String, { nullable: true, description: '维修日期 YYYY-MM-DD' })
  maintenanceDate!: string | null;

  @Field(() => String, { nullable: true, description: '维修工程师' })
  engineerName!: string | null;

  @Field(() => String, { nullable: true, description: '复位结果' })
  resetResult!: string | null;

  @Field(() => String, { nullable: true, description: '补充说明' })
  supplementaryNote!: string | null;

  @Field(() => [RepairMaintenanceStepDTO], { description: '排查步骤' })
  steps!: RepairMaintenanceStepDTO[];

  @Field(() => [RepairMaintenanceFaultPanelDTO], { description: '故障面板' })
  panels!: RepairMaintenanceFaultPanelDTO[];
}

@ObjectType({ description: '工程师侧修订历史项' })
export class EngineerRepairRevisionHistoryItemDTO {
  @Field(() => Int, { description: '修订后版本号（管理员修订号，不是维修记录版本号）' })
  revisionNo!: number;

  @Field(() => Int, { description: '修订前版本号' })
  previousVersion!: number;

  @Field(() => String, { description: '修订原因' })
  reason!: string;

  @Field(() => String, { description: '修订人昵称' })
  actorNickname!: string;

  @Field(() => Date, { description: '修订时间' })
  createdAt!: Date;

  @Field(() => Boolean, { description: '前后快照是否都包含可对比的维修数据' })
  hasComparableSnapshot!: boolean;

  @Field(() => Boolean, { description: '是否存在可展示的维修记录差异' })
  hasVisibleMaintenanceChange!: boolean;

  @Field(() => String, {
    nullable: true,
    description: '对比不可用原因码：NO_COMPARABLE_SNAPSHOT / NO_VISIBLE_MAINTENANCE_CHANGE',
  })
  compareUnavailableReason!: string | null;
}

@ObjectType({ description: '工程师侧修订详情（只读）' })
export class EngineerRepairRevisionDetailDTO {
  @Field(() => Int, { description: '工单 ID' })
  requestId!: number;

  @Field(() => Int, { description: '修订后版本号' })
  revisionNo!: number;

  @Field(() => Int, { description: '修订前版本号' })
  previousVersion!: number;

  @Field(() => String, { description: '修订原因' })
  reason!: string;

  @Field(() => String, { description: '修订人昵称' })
  actorNickname!: string;

  @Field(() => Date, { description: '修订时间' })
  createdAt!: Date;

  @Field(() => Boolean, { description: '前后快照是否都可对比' })
  hasComparableSnapshot!: boolean;

  @Field(() => Boolean, { description: '是否存在可展示的维修记录差异' })
  hasVisibleMaintenanceChange!: boolean;

  @Field(() => String, {
    nullable: true,
    description: '对比不可用原因码：NO_COMPARABLE_SNAPSHOT / NO_VISIBLE_MAINTENANCE_CHANGE',
  })
  compareUnavailableReason!: string | null;

  @Field(() => EngineerRepairRevisionSnapshotDTO, { nullable: true, description: '修订前维修快照' })
  before!: EngineerRepairRevisionSnapshotDTO | null;

  @Field(() => EngineerRepairRevisionSnapshotDTO, { nullable: true, description: '修订后维修快照' })
  after!: EngineerRepairRevisionSnapshotDTO | null;
}
