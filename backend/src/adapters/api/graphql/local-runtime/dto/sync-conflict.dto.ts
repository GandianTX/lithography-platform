// src/adapters/api/graphql/local-runtime/dto/sync-conflict.dto.ts

import type { SyncConflictDiffResult } from '@core/local-runtime/policy/sync-conflict-diff.policy';
import { Field, GraphQLISODateTime, Int, ObjectType } from '@nestjs/graphql';
import type {
  SyncConflictListPage,
  SyncConflictSnapshot,
  SyncConflictSummary,
} from '@src/modules/lithography/sync.types';

/** 冲突差异条目（字段路径与两侧展示值） */
@ObjectType('SyncConflictDiffEntry')
export class SyncConflictDiffEntryDTO {
  @Field(() => String, { description: '字段路径（点分隔；数组按下标）' })
  path!: string;

  @Field(() => String, { description: 'ONLY_LOCAL / ONLY_CLOUD / DIFFERENT' })
  kind!: string;

  @Field(() => String, { nullable: true, description: '本地值（展示文本）' })
  localValue?: string | null;

  @Field(() => String, { nullable: true, description: '云端值（展示文本）' })
  cloudValue?: string | null;
}

/** 冲突差异（字段级对比结果） */
@ObjectType('SyncConflictDiff')
export class SyncConflictDiffDTO {
  @Field(() => [SyncConflictDiffEntryDTO], { description: '差异条目' })
  entries!: SyncConflictDiffEntryDTO[];

  @Field(() => Boolean, { description: '是否因条目上限被截断' })
  truncated!: boolean;

  @Field(() => Boolean, { description: '快照无法解析时为 true（无法比较）' })
  invalid!: boolean;
}

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

  @Field(() => SyncConflictDiffDTO, {
    nullable: true,
    description: '字段级差异（本地快照与云端快照摊平比较）',
  })
  diff?: SyncConflictDiffDTO | null;

  @Field(() => Int, {
    nullable: true,
    description: '来源记录的本机 ID（来源页入口用；取不到时为 null）',
  })
  sourceRecordId?: number | null;

  @Field(() => Boolean, {
    description: '来源内容是否只读（已删除／下架／冻结／结单）：只读内容不得恢复或覆盖',
  })
  sourceReadOnly?: boolean;

  @Field(() => String, {
    nullable: true,
    description: '只读受控原因码（SOURCE_WITHDRAWN／SOURCE_FROZEN／SOURCE_CLOSED）',
  })
  sourceReadOnlyReason?: string | null;

  @Field(() => Int, { nullable: true, description: '确认处理人账号；待处理时为 null' })
  confirmedByAccountId?: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '确认时间；待处理时为 null' })
  confirmedAt?: Date | null;

  @Field(() => GraphQLISODateTime, { description: '冲突创建时间' })
  createdAt!: Date;
}

/**
 * 冲突摘要（**不含正文快照**）。
 *
 * 裁决结果的返回体用：裁决是一次写动作，返回体没有必要再带本地与云端两份正文快照
 * （两者都含正文与原件引用）。
 */
@ObjectType('SyncConflictSummary')
export class SyncConflictSummaryDTO {
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

  @Field(() => SyncConflictSummaryDTO, {
    description: '裁决后的冲突摘要（不含正文快照）',
  })
  conflict!: SyncConflictSummaryDTO;
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
    diff: view.diff === undefined || view.diff === null ? null : toSyncConflictDiffDTO(view.diff),
    sourceRecordId: view.sourceRecordId ?? null,
    sourceReadOnly: view.sourceReadOnly ?? false,
    sourceReadOnlyReason: view.sourceReadOnlyReason ?? null,
    confirmedByAccountId: view.confirmedByAccountId,
    confirmedAt: view.confirmedAt,
    createdAt: view.createdAt,
  };
}

/** 差异结果 → DTO */
export function toSyncConflictDiffDTO(diff: SyncConflictDiffResult): SyncConflictDiffDTO {
  return {
    entries: diff.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      localValue: entry.localValue,
      cloudValue: entry.cloudValue,
    })),
    truncated: diff.truncated,
    invalid: diff.invalid,
  };
}

export function toSyncConflictSummaryDTO(view: SyncConflictSummary): SyncConflictSummaryDTO {
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

export function toSyncConflictResolveResultDTO(view: {
  outcome: 'resolved' | 'existing' | 'later';
  conflict: SyncConflictSummary | null;
}): SyncConflictResolveResultDTO {
  if (!view.conflict) {
    throw new Error('同步冲突裁决结果缺少冲突事实');
  }
  return {
    outcome: view.outcome,
    conflict: toSyncConflictSummaryDTO(view.conflict),
  };
}
