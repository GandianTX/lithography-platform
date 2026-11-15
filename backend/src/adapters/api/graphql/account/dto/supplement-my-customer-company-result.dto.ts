// src/adapters/api/graphql/account/dto/supplement-my-customer-company-result.dto.ts

import { Field, ObjectType } from '@nestjs/graphql';
import type { SupplementMyCustomerCompanyOutcome } from '@src/usecases/account/supplement-my-customer-company.types';
import { MyAccountSettingsDTO, toMyAccountSettingsDTO } from './my-account-settings.dto';

/**
 * 缺归属客户补录结果 DTO（任务 02.4）。
 *
 * - `isUpdated`：本次是否发生落库（已归属且选择同一候选时幂等返回 `false`）；
 * - `settings`：写入后（或未变更时）的权威账号设置视图，复用只读 Query 的同一 DTO；
 * - `sameNamedCompanyName`：手填名与既有受管公司精确同名时的提示，未命中为 `null`
 *   （同名不自动合并，本次仍按新公司独立建档）。
 */
@ObjectType({ description: '缺归属客户补录结果' })
export class SupplementMyCustomerCompanyResultDTO {
  @Field(() => Boolean, { description: '是否发生了任何写入' })
  isUpdated!: boolean;

  @Field(() => MyAccountSettingsDTO, { description: '补录后的账号设置' })
  settings!: MyAccountSettingsDTO;

  @Field(() => String, { description: '手填同名公司提示（未命中为 null）', nullable: true })
  sameNamedCompanyName!: string | null;
}

/** Usecase Outcome → DTO 薄映射（字段直通，不做任何业务判断）。 */
export function toSupplementMyCustomerCompanyResultDTO(
  result: SupplementMyCustomerCompanyOutcome,
): SupplementMyCustomerCompanyResultDTO {
  return {
    isUpdated: result.isUpdated,
    settings: toMyAccountSettingsDTO(result.settings),
    sameNamedCompanyName: result.sameNamedCompanyName,
  };
}
