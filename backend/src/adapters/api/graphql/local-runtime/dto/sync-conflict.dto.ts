// src/adapters/api/graphql/local-runtime/dto/sync-conflict.dto.ts

import { Field, GraphQLISODateTime, Int, ObjectType } from '@nestjs/graphql';
import type {
  SyncConflictListPage,
  SyncConflictSnapshot,
} from '@src/modules/lithography/sync.types';
import type { SyncConflictResolveOutcomeView } from '@src/usecases/local-runtime/local-runtime.command.types';

/** 同步冲突（三方版本与本地/云端快照，R066） */
@ObjectType('SyncConflict')
export class SyncConflictDTO {
  @Field(() => String, { description: '冲突 ID' })
  conflictId!: string;

  @Field(() => String, { description: '业务稳定记录编号' })
  recordUuid!: string;

  @Field(() => Int, { description: '公司数据区' })
  organizationId!: number;

  @Field(() => String, { description: '冲突资源类型（工单/报告/资料等）' })
  resourceType!: string;

  @Field(() => Int, { description: '冲突版本号（不映射本地/云端）' })
  versionNo!: number;

  @Field(() => Int, { nullable: true, description: '本地数据版本；历史行为 null' })
  localVersion?: number | null;

  @Field(() => Int, { nullable: true, description: '云端数据版本；历史行为 null' })
  cloudVersion?: number | null;

  @Field(() => Int, { nullable: true, description: '已展示的云端版本；历史行为 null' })
  displayedCloudVersion?: number | null;

  @Field(() => String, {
    nullable: true,
    description: 'PENDING / LOCAL / CLOUD；null 表示历史未知行',
  })
  decision?: string | null;

  @Field(() => String, { description: 'PENDING / RESOLVED / IGNORED' })
  status!: string;

  @Field(() => String, { description: '本地快照 JSON 原文（含正文与原件引用）' })
  localSnapshot!: string;

  @Field(() => String, { description: '云端快照 JSON 原文' })
  cloudSnapshot!: string;

  @Field(() => String, { description: '可展示的冲突原因' })
  conflictReason!: string;

  @Field(() => Int, { nullable: true, description: '确认处理人账号；待处理时为 null' })
  confirmedByAccountId?: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '确认时间；待处理时为 null' })
  confirmedAt?: Date | null;

  @Field(() => GraphQLISODateTime, { description: '冲突创建时间' })
  createdAt!: Date;
}

/** 冲突清单分页 */
@ObjectType('SyncConflictPage')
export class SyncConflictPageDTO {
  @Field(() => [SyncConflictDTO], { description: '当前页冲突' })
  items!: SyncConflictDTO[];

  @Field(() => Int, { nullable: true, description: '总数（仅在请求 withTotal 时返回）' })
  total?: number | null;

  @Field(() => Int, { description: '当前页码' })
  page!: number;

  @Field(() => Int, { description: '页大小' })
  pageSize!: number;

  @Field(() => Boolean, {
    nullable: true,
    description: '候选超过扫描上限：可见集合是下界（不静默丢条目）',
  })
  truncated?: boolean | null;
}

/** 冲突裁决结果：existing 表示重复请求返回既有事实 */
@ObjectType('SyncConflictResolveResult')
export class SyncConflictResolveResultDTO {
  @Field(() => String, {
    description: 'resolved=本次写入；existing=重复请求返回既有事实；later=保持待处理',
  })
  outcome!: 'resolved' | 'existing' | 'later';

  @Field(() => SyncConflictDTO, { description: '裁决后的最新冲突事实' })
  conflict!: SyncConflictDTO;
}

/** View → DTO 薄映射 */
export function toSyncConflictDTO(view: SyncConflictSnapshot): SyncConflictDTO {
  return {
    conflictId: view.conflictId,
    recordUuid: view.recordUuid,
    organizationId: view.organizationId,
    resourceType: view.resourceType,
    versionNo: view.versionNo,
    localVersion: view.localVersion,
    cloudVersion: view.cloudVersion,
    displayedCloudVersion: view.displayedCloudVersion,
    decision: view.decision,
    status: view.status,
    localSnapshot: view.localSnapshot,
    cloudSnapshot: view.cloudSnapshot,
    conflictReason: view.conflictReason,
    confirmedByAccountId: view.confirmedByAccountId,
    confirmedAt: view.confirmedAt,
    createdAt: view.createdAt,
  };
}

export function toSyncConflictPageDTO(page: SyncConflictListPage): SyncConflictPageDTO {
  return {
    items: page.items.map(toSyncConflictDTO),
    total: page.total ?? null,
    page: page.page,
    pageSize: page.pageSize,
    truncated: page.truncated ?? null,
  };
}

export function toSyncConflictResolveResultDTO(
  view: SyncConflictResolveOutcomeView,
): SyncConflictResolveResultDTO {
  if (!view.conflict) {
    throw new Error('同步冲突裁决结果缺少冲突事实');
  }
  return {
    outcome: view.outcome,
    conflict: toSyncConflictDTO(view.conflict),
  };
}
