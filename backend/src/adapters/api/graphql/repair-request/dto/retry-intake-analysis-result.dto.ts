// src/adapters/api/graphql/repair-request/dto/retry-intake-analysis-result.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * 客户重新分析（首析主动重试）结果输出对象。
 * 重试成功即完成：代次原子切换到 1 并登记投递，客户端据此刷新详情；
 * delivered 仅作观测（false 表示入队暂缓、由后台恢复补投），不改变重试成功语义。
 */
@ObjectType({ description: '客户重新分析维修申请结果' })
export class RetryIntakeAnalysisResultDTO {
  @Field(() => Int, { description: '维修申请 ID' })
  id!: number;

  @Field(() => Int, { description: '报修原稿 ID' })
  intakeId!: number;

  @Field(() => Int, { description: '重试后的首析代次（恒为 1）' })
  analysisGeneration!: number;

  @Field(() => String, { description: '重试后的首析状态（WAITING）' })
  analysisStatus!: string;

  @Field(() => Boolean, { description: '入队是否已完成（false 表示由后台恢复补投）' })
  delivered!: boolean;
}
